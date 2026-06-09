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

  /**
   * 构建 Agent 模式的系统提示词
   * @param {string} mode - ask | auto | plan
   * @param {string} basePrompt - 用户配置的基础提示词
   */
  buildAgentSystemPrompt(mode, basePrompt) {
    const modeInstructions = {
      ask: `你是一个专业的Linux运维Agent助手。用户会描述运维需求，你需要：
1. 先分析用户需求，用简短文字说明你的理解
2. 生成对应的Linux命令，用\`\`\`bash代码块包裹
3. 等待用户点击"执行"按钮后命令才会被发送到终端
4. 命令执行后，分析终端输出，给出下一步建议

重要：每次只生成一个命令块，等用户确认执行后再继续下一步。
如果任务需要多步骤，每次只输出当前步骤的命令。`,

      auto: `你是一个专业的Linux运维Agent助手，处于自动执行模式。用户会描述运维需求，你需要：
1. 先用简短文字说明你的理解和执行计划
2. 生成对应的Linux命令，用\`\`\`bash代码块包裹
3. 命令会自动发送到终端执行，你不需要等待确认
4. 命令执行后，分析终端输出，自动决定下一步操作

重要：你可以连续输出多个命令，系统会依次自动执行。
每个命令块代表一个独立步骤。执行完一个步骤后，根据输出决定是否继续。`,

      plan: `你是一个专业的Linux运维规划助手。用户会描述运维需求，你需要：
1. 详细分析需求，制定完整的执行计划
2. 列出所有需要执行的步骤，每步用\`\`\`bash代码块包裹
3. 说明每步的作用和预期结果
4. 标注可能的风险点

重要：你只生成计划，不会执行任何命令。
用户会根据你的计划决定是否执行。`,
    };

    return modeInstructions[mode] + '\n\n' + basePrompt;
  }

  /**
   * 对话压缩 - 将旧消息压缩为摘要
   * @param {Array} messages - 原始消息数组
   * @param {number} keepRecent - 保留最近N条消息
   * @returns {{ compressed: Array, summary: string }}
   */
  compressMessages(messages, keepRecent = 10) {
    if (messages.length <= keepRecent + 2) {
      return { compressed: messages, summary: '' };
    }

    const oldMessages = messages.slice(0, -keepRecent);
    const recentMessages = messages.slice(-keepRecent);

    // 提取关键信息生成摘要
    const userMessages = oldMessages.filter(m => m.role === 'user').map(m => m.content);
    const assistantMessages = oldMessages.filter(m => m.role === 'assistant').map(m => m.content);

    let summary = '[历史摘要]\n';
    if (userMessages.length > 0) {
      summary += '用户需求：' + userMessages.slice(0, 3).join('；');
      if (userMessages.length > 3) summary += `等${userMessages.length}条`;
      summary += '\n';
    }
    if (assistantMessages.length > 0) {
      // 提取命令
      const commands = [];
      for (const msg of assistantMessages) {
        const matches = msg.match(/```(?:bash)?\n?([\s\S]*?)```/g);
        if (matches) {
          for (const m of matches) {
            const cmd = m.replace(/```(?:bash)?\n?/, '').replace(/```/, '').trim();
            if (cmd) commands.push(cmd.split('\n')[0]); // 只取第一行
          }
        }
      }
      if (commands.length > 0) {
        summary += '已执行命令：' + commands.slice(0, 5).join('；');
        if (commands.length > 5) summary += `等${commands.length}条`;
        summary += '\n';
      }
    }

    const compressed = [
      { role: 'system', content: summary },
      ...recentMessages,
    ];

    return { compressed, summary };
  }
}

module.exports = new AIService();
