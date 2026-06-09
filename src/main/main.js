/**
 * AI-SSH 主进程入口
 * 负责窗口管理、IPC通信桥接、应用生命周期
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const configStore = require('./config-store');
const sshManager = require('./ssh-manager');
const sftpManager = require('./sftp-manager');
const aiService = require('./ai-service');
const security = require('./security');
const { IPC_CONFIG, IPC_SESSION, IPC_AI, IPC_CHAT } = require('../shared/constants');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'AI-SSH 智能终端管理',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // 需要ssh2原生模块
    },
    // 无原生菜单栏（自定义菜单）
    autoHideMenuBar: true,
    backgroundColor: '#1e1e2e',
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 开发模式打开DevTools
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ========== 应用生命周期 ==========

app.whenReady().then(() => {
  configStore.init();
  createWindow();
  registerIPC();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  sshManager.disconnectAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  sshManager.disconnectAll();
});

// ========== IPC 注册 ==========

function registerIPC() {
  // ========== 配置层 IPC ==========

  // SSH连接配置
  ipcMain.handle(IPC_CONFIG.GET_SSH_LIST, () => {
    return configStore.getSanitizedSSHList();
  });

  ipcMain.handle(IPC_CONFIG.GET_SSH_ITEM, (event, id) => {
    // 返回脱敏配置
    const connections = configStore.getSanitizedSSHList();
    return connections.find(c => c.id === id) || null;
  });

  ipcMain.handle(IPC_CONFIG.SAVE_SSH, (event, config) => {
    return configStore.saveSSHConnection(config);
  });

  ipcMain.handle(IPC_CONFIG.DELETE_SSH, (event, id) => {
    configStore.deleteSSHConnection(id);
    return { success: true };
  });

  // AI模型配置
  ipcMain.handle(IPC_CONFIG.GET_AI_MODELS, () => {
    return configStore.getSanitizedAIModels();
  });

  ipcMain.handle(IPC_CONFIG.SAVE_AI_MODEL, (event, config) => {
    return configStore.saveAIModel(config);
  });

  ipcMain.handle(IPC_CONFIG.DELETE_AI_MODEL, (event, id) => {
    configStore.deleteAIModel(id);
    return { success: true };
  });

  ipcMain.handle(IPC_CONFIG.TEST_AI_MODEL, async (event, modelId) => {
    return await aiService.testConnection(modelId);
  });

  ipcMain.handle(IPC_CONFIG.GET_AI_CONFIG, () => {
    return configStore.getAIConfig();
  });

  ipcMain.handle(IPC_CONFIG.SAVE_AI_CONFIG, (event, config) => {
    configStore.saveAIConfig(config);
    return { success: true };
  });

  // ========== 会话层 IPC ==========

  ipcMain.handle(IPC_SESSION.SSH_CONNECT, async (event, sessionId, sshConfigId) => {
    try {
      const result = await sshManager.connect(sessionId, sshConfigId);
      const session = sshManager.getSession(sessionId);

      // 监听会话输出，推送到渲染进程
      session.emitter.on('output', (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_SESSION.SSH_OUTPUT, data);
        }
      });

      session.emitter.on('status', (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_SESSION.SSH_STATUS, data);
        }
      });

      return result;
    } catch (err) {
      return { sessionId, status: 'error', error: err.message };
    }
  });

  ipcMain.handle(IPC_SESSION.SSH_DISCONNECT, (event, sessionId) => {
    sshManager.disconnect(sessionId);
    return { success: true };
  });

  ipcMain.handle(IPC_SESSION.SSH_DATA_INPUT, (event, sessionId, data) => {
    const session = sshManager.getSession(sessionId);
    if (session) {
      session.write(data);
    }
  });

  ipcMain.handle(IPC_SESSION.SSH_RESIZE, (event, sessionId, cols, rows) => {
    const session = sshManager.getSession(sessionId);
    if (session) {
      session.resize(cols, rows);
    }
  });

  ipcMain.handle(IPC_SESSION.SSH_LIST_CONNECTIONS, () => {
    return sshManager.getActiveSessionIds();
  });

  // SFTP操作
  ipcMain.handle(IPC_SESSION.SFTP_LIST, async (event, sessionId, remotePath) => {
    const session = sshManager.getSession(sessionId);
    if (!session) throw new Error('会话不存在');
    return await sftpManager.list(session, remotePath);
  });

  ipcMain.handle(IPC_SESSION.SFTP_UPLOAD, async (event, sessionId, localPath, remotePath) => {
    const session = sshManager.getSession(sessionId);
    if (!session) throw new Error('会话不存在');
    return await sftpManager.upload(session, localPath, remotePath);
  });

  ipcMain.handle(IPC_SESSION.SFTP_DOWNLOAD, async (event, sessionId, remotePath, localPath) => {
    const session = sshManager.getSession(sessionId);
    if (!session) throw new Error('会话不存在');
    return await sftpManager.download(session, remotePath, localPath);
  });

  ipcMain.handle(IPC_SESSION.SFTP_DELETE, async (event, sessionId, remotePath, isDirectory) => {
    const session = sshManager.getSession(sessionId);
    if (!session) throw new Error('会话不存在');
    return await sftpManager.delete(session, remotePath, isDirectory);
  });

  ipcMain.handle(IPC_SESSION.SFTP_RENAME, async (event, sessionId, oldPath, newPath) => {
    const session = sshManager.getSession(sessionId);
    if (!session) throw new Error('会话不存在');
    return await sftpManager.rename(session, oldPath, newPath);
  });

  ipcMain.handle(IPC_SESSION.SFTP_MKDIR, async (event, sessionId, remotePath) => {
    const session = sshManager.getSession(sessionId);
    if (!session) throw new Error('会话不存在');
    return await sftpManager.mkdir(session, remotePath);
  });

  // ========== AI层 IPC ==========

  ipcMain.handle(IPC_AI.CHAT_SEND, async (event, { modelId, messages, terminalContext }) => {
    // 构建上下文：系统提示词 + 终端上下文 + 用户消息
    const aiConfig = configStore.getAIConfig();
    const systemPrompt = aiConfig.systemPrompt || '';

    // 合并为单条 system 消息（兼容所有 API）
    let systemContent = systemPrompt;
    if (terminalContext) {
      systemContent += `\n\n以下是当前SSH终端最近的执行输出（已脱敏），请作为上下文参考：\n\`\`\`\n${terminalContext}\n\`\`\``;
    }

    const fullMessages = [];
    if (systemContent) {
      fullMessages.push({ role: 'system', content: systemContent });
    }
    fullMessages.push(...messages);

    // 非流式请求
    return new Promise((resolve) => {
      let fullContent = '';
      aiService.streamChat(modelId, fullMessages, {
        onChunk: (content) => { fullContent += content; },
        onDone: () => resolve({ success: true, content: fullContent }),
        onError: (err) => resolve({ success: false, error: err.message }),
      });
    });
  });

  ipcMain.handle(IPC_AI.CHAT_STREAM, async (event, { modelId, messages, terminalContext, mode }) => {
    const aiConfig = configStore.getAIConfig();
    const basePrompt = aiConfig.systemPrompt || '';

    // 使用 Agent 模式构建系统提示词
    const systemPrompt = aiService.buildAgentSystemPrompt(mode || 'ask', basePrompt);

    // 合并为单条 system 消息（兼容所有 API）
    let systemContent = systemPrompt;
    if (terminalContext) {
      systemContent += `\n\n以下是当前SSH终端最近的执行输出（已脱敏），请作为上下文参考：\n\`\`\`\n${terminalContext}\n\`\`\``;
    }

    const fullMessages = [];
    if (systemContent) {
      fullMessages.push({ role: 'system', content: systemContent });
    }
    fullMessages.push(...messages);

    const webContents = event.sender;

    await aiService.streamChat(modelId, fullMessages, {
      onChunk: (content) => {
        if (!webContents.isDestroyed()) {
          webContents.send(IPC_AI.CHAT_STREAM + ':chunk', { content });
        }
      },
      onDone: () => {
        if (!webContents.isDestroyed()) {
          webContents.send(IPC_AI.CHAT_STREAM + ':done');
        }
      },
      onError: (err) => {
        if (!webContents.isDestroyed()) {
          webContents.send(IPC_AI.CHAT_STREAM + ':error', { error: err.message });
        }
      },
    });

    return { success: true };
  });

  ipcMain.handle(IPC_AI.CHAT_STOP, () => {
    aiService.stopStream();
    return { success: true };
  });

  // ========== 对话历史 IPC ==========

  ipcMain.handle(IPC_CHAT.SAVE_HISTORY, (event, sessionId, data) => {
    configStore.saveChatHistory(sessionId, data);
    return { success: true };
  });

  ipcMain.handle(IPC_CHAT.GET_HISTORY, (event, sessionId) => {
    return configStore.getChatHistory(sessionId);
  });

  ipcMain.handle(IPC_CHAT.DELETE_HISTORY, (event, sessionId) => {
    configStore.deleteChatHistory(sessionId);
    return { success: true };
  });

  ipcMain.handle(IPC_CHAT.LIST_HISTORIES, () => {
    return configStore.getAllChatHistories();
  });

  // 安全相关
  ipcMain.handle('security:check-command', (event, command) => {
    return security.checkDangerousCommand(command);
  });

  ipcMain.handle('security:check-multiple', (event, command) => {
    return security.checkMultipleCommands(command);
  });

  ipcMain.handle('security:sanitize', (event, text) => {
    return security.sanitizeOutput(text);
  });

  // 文件对话框
  ipcMain.handle('dialog:open-file', async (event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, options);
    return result;
  });

  ipcMain.handle('dialog:save-file', async (event, options) => {
    const result = await dialog.showSaveDialog(mainWindow, options);
    return result;
  });

  // 获取终端上下文（脱敏后）
  ipcMain.handle('session:get-terminal-context', (event, sessionId, lines) => {
    const session = sshManager.getSession(sessionId);
    if (!session) return '';
    return session.getRecentOutput(lines || 50);
  });
}
