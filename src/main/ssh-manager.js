/**
 * 会话层 - SSH连接管理
 * 管理多个SSH会话的生命周期，提供命令执行和终端交互能力
 * 仅暴露：命令提交接口、终端日志获取接口
 */

const { Client } = require('ssh2');
const { EventEmitter } = require('events');
const configStore = require('./config-store');
const security = require('./security');

// 输出缓冲区最大字节数（100KB）
const MAX_OUTPUT_BUFFER_SIZE = 100 * 1024;

class SSHSession {
  constructor(sessionId, config) {
    this.id = sessionId;
    this.config = config;
    this.client = new Client();
    this.stream = null;
    this.shell = null;
    this.status = 'disconnected'; // disconnected | connecting | connected | error
    this.emitter = new EventEmitter();
    this._outputBuffer = '';
    this._setupHandlers();
  }

  _setupHandlers() {
    this.client.on('ready', () => {
      this.status = 'connected';
      this.emitter.emit('status', { sessionId: this.id, status: 'connected' });

      // 请求交互式终端
      this.client.shell(
        {
          term: 'xterm-256color',
          cols: 120,
          rows: 30,
        },
        (err, stream) => {
          if (err) {
            this.status = 'error';
            this.emitter.emit('status', {
              sessionId: this.id,
              status: 'error',
              error: err.message,
            });
            return;
          }

          this.stream = stream;

          stream.on('data', (data) => {
            const text = data.toString('utf8');
            this._outputBuffer += text;
            // 限制缓冲区大小，防止内存泄漏
            if (this._outputBuffer.length > MAX_OUTPUT_BUFFER_SIZE) {
              this._outputBuffer = this._outputBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
            }
            this.emitter.emit('output', { sessionId: this.id, data: text });
          });

          stream.stderr.on('data', (data) => {
            const text = data.toString('utf8');
            this.emitter.emit('output', { sessionId: this.id, data: text, type: 'stderr' });
          });

          stream.on('close', () => {
            this.status = 'disconnected';
            this.stream = null;
            this.emitter.emit('status', { sessionId: this.id, status: 'disconnected' });
          });
        }
      );
    });

    this.client.on('error', (err) => {
      this.status = 'error';
      this.emitter.emit('status', {
        sessionId: this.id,
        status: 'error',
        error: err.message,
      });
    });

    this.client.on('close', () => {
      if (this.status !== 'error') {
        this.status = 'disconnected';
        this.emitter.emit('status', { sessionId: this.id, status: 'disconnected' });
      }
    });

    this.client.on('end', () => {
      this.status = 'disconnected';
      this.emitter.emit('status', { sessionId: this.id, status: 'disconnected' });
    });
  }

  /**
   * 建立SSH连接
   */
  connect() {
    return new Promise((resolve, reject) => {
      this.status = 'connecting';
      this.emitter.emit('status', { sessionId: this.id, status: 'connecting' });

      const connectConfig = {
        host: this.config.host,
        port: this.config.port || 22,
        username: this.config.username,
        readyTimeout: this.config.timeout || 10000,
        keepaliveInterval: this.config.keepAliveInterval || 30000,
        keepaliveCountMax: 3,
      };

      // 认证方式
      if (this.config.authType === 'privateKey' && this.config.privateKey) {
        connectConfig.privateKey = this.config.privateKey;
        if (this.config.passphrase) {
          connectConfig.passphrase = this.config.passphrase;
        }
      } else {
        connectConfig.password = this.config.password;
      }

      // 允许不严格的主机密钥（开发/运维常用）
      connectConfig.algorithms = {
        serverHostKey: [
          'ssh-ed25519',
          'ecdsa-sha2-nistp256',
          'ecdsa-sha2-nistp384',
          'ecdsa-sha2-nistp521',
          'rsa-sha2-512',
          'rsa-sha2-256',
          'ssh-rsa',
        ],
      };

      const onReady = () => {
        this.status = 'connected';
        resolve({ sessionId: this.id, status: 'connected' });
        this.client.removeListener('error', onError);
      };

      const onError = (err) => {
        this.status = 'error';
        reject(err);
        this.client.removeListener('ready', onReady);
      };

      this.client.once('ready', onReady);
      this.client.once('error', onError);

      try {
        this.client.connect(connectConfig);
      } catch (err) {
        this.status = 'error';
        reject(err);
      }
    });
  }

  /**
   * 向终端写入数据（用户手动输入或AI命令）
   */
  write(data) {
    if (this.stream) {
      this.stream.write(data);
    }
  }

  /**
   * 调整终端大小
   */
  resize(cols, rows) {
    if (this.stream) {
      this.stream.setWindow(rows, cols, 0, 0);
    }
  }

  /**
   * 获取最近的终端输出（用于AI上下文）
   * 返回脱敏后的文本
   */
  getRecentOutput(lines = 50) {
    const output = this._outputBuffer;
    const sanitized = security.sanitizeOutput(output);
    const allLines = sanitized.split('\n');
    return allLines.slice(-lines).join('\n');
  }

  /**
   * 清空输出缓冲区
   */
  clearOutputBuffer() {
    this._outputBuffer = '';
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.stream) {
      this.stream.close();
    }
    if (this.client) {
      this.client.end();
    }
    this.status = 'disconnected';
  }

  /**
   * 获取SFTP客户端
   */
  getSFTP() {
    return new Promise((resolve, reject) => {
      if (this.status !== 'connected') {
        return reject(new Error('SSH未连接'));
      }
      this.client.sftp((err, sftp) => {
        if (err) reject(err);
        else resolve(sftp);
      });
    });
  }
}

class SSHManager {
  constructor() {
    /** @type {Map<string, SSHSession>} */
    this.sessions = new Map();
  }

  /**
   * 创建并连接SSH会话
   */
  async connect(sessionId, sshConfigId) {
    // 断开已有同ID会话
    if (this.sessions.has(sessionId)) {
      this.sessions.get(sessionId).disconnect();
    }

    // 从配置层获取完整SSH配置（含解密）
    const config = configStore.getSSHConnection(sshConfigId);
    if (!config) {
      throw new Error(`SSH配置不存在: ${sshConfigId}`);
    }

    const session = new SSHSession(sessionId, config);
    this.sessions.set(sessionId, session);

    await session.connect();
    return { sessionId, status: 'connected' };
  }

  /**
   * 获取会话
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * 获取所有活跃会话ID
   */
  getActiveSessionIds() {
    const ids = [];
    for (const [id, session] of this.sessions) {
      ids.push({ id, status: session.status });
    }
    return ids;
  }

  /**
   * 断开并移除会话
   */
  disconnect(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.disconnect();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * 断开所有会话
   */
  disconnectAll() {
    for (const [id, session] of this.sessions) {
      session.disconnect();
    }
    this.sessions.clear();
  }
}

module.exports = new SSHManager();
