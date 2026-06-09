/**
 * AI层 - AI服务模块
 * 仅负责用户意图识别、命令生成、流式对话
 * 无权读取SSH配置、服务器账号、私钥、密码等所有敏感信息
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const configStore = require('./config-store');

class AIService {
  constructor() {
    /** @type {AbortController|null} */
    this._activeController = null;
  }

  /**
   * 获取模型配置（从配置层解密获取）
   */
  _getModelConfig(modelId) {
    const model = configStore.getAIModel(modelId);
    if (!model) throw new Error(`AI模型配置不存在: ${modelId}`);
    return model;
  }

  /**
   * 构建请求体（兼容OpenAI和Anthropic格式）
   */
  _buildRequestBody(model, messages, stream = true) {
    if (model.apiFormat === 'anthropic') {
      // 合并所有 system 消息为一个
      const systemParts = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .filter(Boolean);
      const chatMessages = messages.filter((m) => m.role !== 'system');
      // Anthropic 要求 messages 必须以 user 开头
      if (chatMessages.length > 0 && chatMessages[0].role !== 'user') {
        chatMessages.unshift({ role: 'user', content: '(请继续)' });
      }
      return {
        model: model.modelName,
        max_tokens: 4096,
        stream,
        messages: chatMessages,
        system: systemParts.join('\n\n') || undefined,
      };
    }
    // OpenAI格式（默认）
    return {
      model: model.modelName,
      messages,
      stream,
      max_tokens: 4096,
      temperature: 0.3,
    };
  }

  /**
   * 构建请求头
   */
  _buildHeaders(model) {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (model.apiFormat === 'anthropic') {
      headers['x-api-key'] = model.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${model.apiKey}`;
    }
    return headers;
  }

  /**
   * 获取API端点路径
   */
  _getEndpoint(model) {
    if (model.apiFormat === 'anthropic') {
      return '/v1/messages';
    }
    return '/v1/chat/completions';
  }

  /**
   * 发送流式请求
   * @param {string} modelId 模型ID
   * @param {Array} messages 消息历史
   * @param {function} onChunk 收到数据块的回调
   * @param {function} onDone 流结束回调
   * @param {function} onError 错误回调
   */
  async streamChat(modelId, messages, { onChunk, onDone, onError }) {
    const model = this._getModelConfig(modelId);
    const body = this._buildRequestBody(model, messages, true);
    const headers = this._buildHeaders(model);
    const endpoint = this._getEndpoint(model);

    // 解析baseUrl
    let baseUrl = model.baseUrl || '';
    if (!baseUrl) {
      baseUrl = model.apiFormat === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com';
    }
    // 移除末尾斜杠
    baseUrl = baseUrl.replace(/\/+$/, '');

    const url = new URL(endpoint, baseUrl);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    this._activeController = new AbortController();

    return new Promise((resolve, reject) => {
      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers,
          signal: this._activeController.signal,
        },
        (res) => {
          if (res.statusCode !== 200) {
            let errorBody = '';
            res.on('data', (chunk) => (errorBody += chunk));
            res.on('end', () => {
              const errMsg = this._parseError(res.statusCode, errorBody);
              if (onError) onError(new Error(errMsg));
              reject(new Error(errMsg));
            });
            return;
          }

          let buffer = '';

          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed === 'data: [DONE]') continue;
              if (!trimmed.startsWith('data: ')) continue;

              try {
                const json = JSON.parse(trimmed.slice(6));
                const content = this._extractStreamContent(json, model.apiFormat);
                if (content && onChunk) {
                  onChunk(content);
                }
              } catch (e) {
                // 忽略解析错误的行
              }
            }
          });

          res.on('end', () => {
            // 处理缓冲区剩余数据
            if (buffer.trim()) {
              const trimmed = buffer.trim();
              if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                try {
                  const json = JSON.parse(trimmed.slice(6));
                  const content = this._extractStreamContent(json, model.apiFormat);
                  if (content && onChunk) onChunk(content);
                } catch (e) {
                  // ignore
                }
              }
            }
            if (onDone) onDone();
            resolve();
          });
        }
      );

      req.on('error', (err) => {
        if (err.name === 'AbortError') {
          if (onDone) onDone();
          return resolve();
        }
        if (onError) onError(err);
        reject(err);
      });

      req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * 从流式响应中提取内容
   */
  _extractStreamContent(json, apiFormat) {
    if (apiFormat === 'anthropic') {
      if (json.type === 'content_block_delta' && json.delta) {
        return json.delta.text || '';
      }
      return '';
    }
    // OpenAI格式
    if (json.choices && json.choices[0]) {
      const delta = json.choices[0].delta;
      if (delta && delta.content) {
        return delta.content;
      }
    }
    return '';
  }

  /**
   * 非流式请求（用于模型连通性测试）
   */
  async testConnection(modelId) {
    const model = this._getModelConfig(modelId);
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Reply with exactly: OK' },
    ];
    const body = this._buildRequestBody(model, messages, false);
    const headers = this._buildHeaders(model);
    const endpoint = this._getEndpoint(model);

    let baseUrl = model.baseUrl || '';
    if (!baseUrl) {
      baseUrl = model.apiFormat === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com';
    }
    baseUrl = baseUrl.replace(/\/+$/, '');

    const url = new URL(endpoint, baseUrl);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers,
          timeout: 15000,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve({ success: true, message: '连接成功' });
            } else {
              const errMsg = this._parseError(res.statusCode, body);
              resolve({ success: false, message: errMsg });
            }
          });
        }
      );

      req.on('error', (err) => {
        resolve({ success: false, message: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, message: '连接超时' });
      });

      req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * 停止当前流式请求
   */
  stopStream() {
    if (this._activeController) {
      this._activeController.abort();
      this._activeController = null;
    }
  }

  /**
   * 解析错误信息
   */
  _parseError(statusCode, body) {
    try {
      const json = JSON.parse(body);
      const msg = json.error?.message || json.error?.param || json.message || body;
      switch (statusCode) {
        case 401:
          return `API Key无效或已过期: ${msg}`;
        case 403:
          return `访问被拒绝: ${msg}`;
        case 429:
          return `请求频率超限: ${msg}`;
        case 400:
          return `参数错误: ${msg}`;
        case 500:
        case 502:
        case 503:
          return `AI服务端异常(${statusCode}): ${msg}`;
        default:
          return `请求失败(${statusCode}): ${msg}`;
      }
    } catch {
      return `请求失败(${statusCode}): ${body.slice(0, 200)}`;
    }
  }
}

module.exports = new AIService();
