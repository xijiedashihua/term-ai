/**
 * 配置层 - 加密配置存储
 * 负责SSH连接配置、AI模型配置的加密存储与读取
 * AI模块无任何访问权限
 */

const Store = require('electron-store');
const crypto = require('crypto');
const path = require('path');
const { app } = require('electron');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

class ConfigStore {
  constructor() {
    // 生成或读取设备唯一密钥
    this._encryptionKey = null;
    this._store = null;
  }

  /**
   * 初始化存储（需在app ready后调用）
   */
  init() {
    const userDataPath = app.getPath('userData');
    this._encryptionKey = this._deriveKey(this._getDeviceId());

    this._store = new Store({
      name: 'ai-ssh-config',
      cwd: userDataPath,
      encryptionKey: undefined, // 我们自行加密
      defaults: {
        sshConnections: [],
        aiModels: [],
        aiConfig: {
          defaultModelId: null,
          systemPrompt: '你是一个专业的Linux运维助手。用户会描述运维需求，你需要生成对应的Linux命令。请将命令用```bash代码块包裹，这样用户可以直接点击执行。可以简要说明命令的作用，但命令必须放在代码块中。如果需要多条命令，放在同一个代码块中，每行一条。',
        },
        appSettings: {
          terminalFontSize: 14,
          terminalFontFamily: 'Menlo, Monaco, "Courier New", monospace',
          terminalTheme: 'default',
        },
      },
    });
  }

  /**
   * 获取设备唯一标识（用于派生加密密钥）
   */
  _getDeviceId() {
    const os = require('os');
    const hostname = os.hostname();
    const username = os.userInfo().username;
    const platform = os.platform();
    return `ai-ssh-${platform}-${hostname}-${username}-salt-2024`;
  }

  /**
   * 派生AES-256加密密钥
   */
  _deriveKey(seed) {
    return crypto.scryptSync(seed, 'ai-ssh-salt-v1', 32);
  }

  /**
   * AES-256-GCM 加密
   */
  encrypt(text) {
    if (!text) return '';
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this._encryptionKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
  }

  /**
   * AES-256-GCM 解密
   */
  decrypt(encryptedText) {
    if (!encryptedText) return '';
    try {
      const parts = encryptedText.split(':');
      if (parts.length !== 3) return encryptedText; // 兼容未加密旧数据
      const iv = Buffer.from(parts[0], 'hex');
      const tag = Buffer.from(parts[1], 'hex');
      const encrypted = parts[2];
      const decipher = crypto.createDecipheriv(ALGORITHM, this._encryptionKey, iv);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (e) {
      console.error('解密失败:', e.message);
      return '';
    }
  }

  // ========== SSH连接配置管理 ==========

  /**
   * 获取所有SSH连接配置（解密后返回，但仅在主进程内部使用）
   * 返回给渲染进程时需脱敏
   */
  getAllSSHConnections() {
    return this._store.get('sshConnections', []);
  }

  /**
   * 获取单个SSH连接配置（含解密的敏感字段）
   */
  getSSHConnection(id) {
    const connections = this.getAllSSHConnections();
    const conn = connections.find(c => c.id === id);
    if (!conn) return null;
    return this._decryptSSHConfig(conn);
  }

  /**
   * 保存SSH连接配置（加密敏感字段后存储）
   */
  saveSSHConnection(config) {
    const connections = this.getAllSSHConnections();
    const index = connections.findIndex(c => c.id === config.id);

    // 编辑模式：敏感字段留空则保留原有的（直接保留加密值，避免解密失败导致数据丢失）
    if (index >= 0) {
      const existing = connections[index];
      if (!config.password && existing.password) {
        config._encryptedPassword = existing.password;
      }
      if (!config.privateKey && existing.privateKey) {
        config._encryptedPrivateKey = existing.privateKey;
      }
      if (!config.passphrase && existing.passphrase) {
        config._encryptedPassphrase = existing.passphrase;
      }
    }

    const encryptedConfig = this._encryptSSHConfig(config);

    // 编辑模式下，如果新值为空，直接使用原有的加密值
    if (index >= 0) {
      if (config._encryptedPassword) encryptedConfig.password = config._encryptedPassword;
      if (config._encryptedPrivateKey) encryptedConfig.privateKey = config._encryptedPrivateKey;
      if (config._encryptedPassphrase) encryptedConfig.passphrase = config._encryptedPassphrase;
      delete encryptedConfig._encryptedPassword;
      delete encryptedConfig._encryptedPrivateKey;
      delete encryptedConfig._encryptedPassphrase;
      connections[index] = encryptedConfig;
    } else {
      connections.push(encryptedConfig);
    }

    this._store.set('sshConnections', connections);
    return this._sanitizeSSHConfig(encryptedConfig);
  }

  /**
   * 删除SSH连接配置
   */
  deleteSSHConnection(id) {
    const connections = this.getAllSSHConnections();
    const filtered = connections.filter(c => c.id !== id);
    this._store.set('sshConnections', filtered);
  }

  /**
   * 加密SSH配置中的敏感字段
   */
  _encryptSSHConfig(config) {
    return {
      ...config,
      password: config.password ? this.encrypt(config.password) : '',
      privateKey: config.privateKey ? this.encrypt(config.privateKey) : '',
      passphrase: config.passphrase ? this.encrypt(config.passphrase) : '',
    };
  }

  /**
   * 解密SSH配置中的敏感字段
   */
  _decryptSSHConfig(config) {
    return {
      ...config,
      password: config.password ? this.decrypt(config.password) : '',
      privateKey: config.privateKey ? this.decrypt(config.privateKey) : '',
      passphrase: config.passphrase ? this.decrypt(config.passphrase) : '',
    };
  }

  /**
   * 脱敏SSH配置（返回给渲染进程，隐藏密码和私钥）
   */
  _sanitizeSSHConfig(config) {
    return {
      ...config,
      password: config.password ? '********' : '',
      privateKey: config.privateKey ? '[已保存私钥]' : '',
      passphrase: config.passphrase ? '********' : '',
    };
  }

  /**
   * 获取脱敏后的SSH连接列表（供渲染进程展示）
   */
  getSanitizedSSHList() {
    const connections = this.getAllSSHConnections();
    return connections.map(c => this._sanitizeSSHConfig(c));
  }

  // ========== AI模型配置管理 ==========

  /**
   * 获取所有AI模型配置
   */
  getAllAIModels() {
    return this._store.get('aiModels', []);
  }

  /**
   * 获取单个AI模型配置（含解密的API Key）
   */
  getAIModel(id) {
    const models = this.getAllAIModels();
    const model = models.find(m => m.id === id);
    if (!model) return null;
    return this._decryptAIModel(model);
  }

  /**
   * 保存AI模型配置
   */
  saveAIModel(config) {
    const models = this.getAllAIModels();
    const index = models.findIndex(m => m.id === config.id);

    // 编辑模式：如果未提供 apiKey，直接保留原有的加密值
    let preservedApiKey = null;
    if (index >= 0 && !config.apiKey) {
      preservedApiKey = models[index].apiKey;
    }

    const encryptedConfig = this._encryptAIModel(config);

    // 如果保留原有加密值，直接使用
    if (preservedApiKey) {
      encryptedConfig.apiKey = preservedApiKey;
    }

    if (index >= 0) {
      models[index] = encryptedConfig;
    } else {
      models.push(encryptedConfig);
    }

    this._store.set('aiModels', models);
    return this._sanitizeAIModel(encryptedConfig);
  }

  /**
   * 删除AI模型配置
   */
  deleteAIModel(id) {
    const models = this.getAllAIModels();
    const filtered = models.filter(m => m.id !== id);
    this._store.set('aiModels', filtered);
  }

  _encryptAIModel(config) {
    return {
      ...config,
      apiKey: config.apiKey ? this.encrypt(config.apiKey) : '',
    };
  }

  _decryptAIModel(config) {
    return {
      ...config,
      apiKey: config.apiKey ? this.decrypt(config.apiKey) : '',
    };
  }

  _sanitizeAIModel(config) {
    return {
      ...config,
      apiKey: config.apiKey ? 'sk-***' : '',
    };
  }

  getSanitizedAIModels() {
    const models = this.getAllAIModels();
    return models.map(m => this._sanitizeAIModel(m));
  }

  // ========== AI全局配置 ==========

  getAIConfig() {
    const config = this._store.get('aiConfig', {});
    // 迁移旧版系统提示词（不含代码块指令的版本）
    const oldPrompt = '你是一个专业的Linux运维助手。用户会描述运维需求，你需要生成对应的Linux命令。只输出可执行的命令，不要多余的解释。如果需要多条命令，用换行分隔。';
    if (config.systemPrompt === oldPrompt) {
      config.systemPrompt = '你是一个专业的Linux运维助手。用户会描述运维需求，你需要生成对应的Linux命令。请将命令用```bash代码块包裹，这样用户可以直接点击执行。可以简要说明命令的作用，但命令必须放在代码块中。如果需要多条命令，放在同一个代码块中，每行一条。';
      this._store.set('aiConfig', config);
    }
    return config;
  }

  saveAIConfig(config) {
    this._store.set('aiConfig', config);
  }

  // ========== 应用设置 ==========

  getAppSettings() {
    return this._store.get('appSettings', {});
  }

  saveAppSettings(settings) {
    this._store.set('appSettings', settings);
  }
}

module.exports = new ConfigStore();
