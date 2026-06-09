/**
 * Preload脚本 - 安全桥接主进程与渲染进程
 * 通过contextBridge暴露安全的API接口
 */

const { contextBridge, ipcRenderer } = require('electron');
const { IPC_CONFIG, IPC_SESSION, IPC_AI, IPC_CHAT } = require('../shared/constants');

contextBridge.exposeInMainWorld('api', {
  // ========== 配置层 API（脱敏数据）==========

  config: {
    // SSH连接配置
    getSSHList: () => ipcRenderer.invoke(IPC_CONFIG.GET_SSH_LIST),
    getSSHItem: (id) => ipcRenderer.invoke(IPC_CONFIG.GET_SSH_ITEM, id),
    saveSSH: (config) => ipcRenderer.invoke(IPC_CONFIG.SAVE_SSH, config),
    deleteSSH: (id) => ipcRenderer.invoke(IPC_CONFIG.DELETE_SSH, id),

    // AI模型配置
    getAIModels: () => ipcRenderer.invoke(IPC_CONFIG.GET_AI_MODELS),
    saveAIModel: (config) => ipcRenderer.invoke(IPC_CONFIG.SAVE_AI_MODEL, config),
    deleteAIModel: (id) => ipcRenderer.invoke(IPC_CONFIG.DELETE_AI_MODEL, id),
    testAIModel: (modelId) => ipcRenderer.invoke(IPC_CONFIG.TEST_AI_MODEL, modelId),

    // AI全局配置
    getAIConfig: () => ipcRenderer.invoke(IPC_CONFIG.GET_AI_CONFIG),
    saveAIConfig: (config) => ipcRenderer.invoke(IPC_CONFIG.SAVE_AI_CONFIG, config),
  },

  // ========== 会话层 API ==========

  session: {
    // SSH连接
    connect: (sessionId, sshConfigId) => ipcRenderer.invoke(IPC_SESSION.SSH_CONNECT, sessionId, sshConfigId),
    disconnect: (sessionId) => ipcRenderer.invoke(IPC_SESSION.SSH_DISCONNECT, sessionId),
    sendInput: (sessionId, data) => ipcRenderer.invoke(IPC_SESSION.SSH_DATA_INPUT, sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.invoke(IPC_SESSION.SSH_RESIZE, sessionId, cols, rows),
    listConnections: () => ipcRenderer.invoke(IPC_SESSION.SSH_LIST_CONNECTIONS),

    // SSH输出监听
    onOutput: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_SESSION.SSH_OUTPUT, handler);
      return () => ipcRenderer.removeListener(IPC_SESSION.SSH_OUTPUT, handler);
    },
    onStatus: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_SESSION.SSH_STATUS, handler);
      return () => ipcRenderer.removeListener(IPC_SESSION.SSH_STATUS, handler);
    },

    // SFTP操作
    sftpList: (sessionId, remotePath) => ipcRenderer.invoke(IPC_SESSION.SFTP_LIST, sessionId, remotePath),
    sftpUpload: (sessionId, localPath, remotePath) => ipcRenderer.invoke(IPC_SESSION.SFTP_UPLOAD, sessionId, localPath, remotePath),
    sftpDownload: (sessionId, remotePath, localPath) => ipcRenderer.invoke(IPC_SESSION.SFTP_DOWNLOAD, sessionId, remotePath, localPath),
    sftpDelete: (sessionId, remotePath, isDirectory) => ipcRenderer.invoke(IPC_SESSION.SFTP_DELETE, sessionId, remotePath, isDirectory),
    sftpRename: (sessionId, oldPath, newPath) => ipcRenderer.invoke(IPC_SESSION.SFTP_RENAME, sessionId, oldPath, newPath),
    sftpMkdir: (sessionId, remotePath) => ipcRenderer.invoke(IPC_SESSION.SFTP_MKDIR, sessionId, remotePath),

    // 获取终端上下文
    getTerminalContext: (sessionId, lines) => ipcRenderer.invoke('session:get-terminal-context', sessionId, lines),
  },

  // ========== AI层 API ==========

  ai: {
    send: (data) => ipcRenderer.invoke(IPC_AI.CHAT_SEND, data),
    stream: (data) => ipcRenderer.invoke(IPC_AI.CHAT_STREAM, data),
    stop: () => ipcRenderer.invoke(IPC_AI.CHAT_STOP),

    // 流式数据监听
    onStreamChunk: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_AI.CHAT_STREAM + ':chunk', handler);
      return () => ipcRenderer.removeListener(IPC_AI.CHAT_STREAM + ':chunk', handler);
    },
    onStreamDone: (callback) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_AI.CHAT_STREAM + ':done', handler);
      return () => ipcRenderer.removeListener(IPC_AI.CHAT_STREAM + ':done', handler);
    },
    onStreamError: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on(IPC_AI.CHAT_STREAM + ':error', handler);
      return () => ipcRenderer.removeListener(IPC_AI.CHAT_STREAM + ':error', handler);
    },
  },

  // ========== 安全 API ==========

  security: {
    checkCommand: (cmd) => ipcRenderer.invoke('security:check-command', cmd),
    checkMultiple: (cmd) => ipcRenderer.invoke('security:check-multiple', cmd),
    sanitize: (text) => ipcRenderer.invoke('security:sanitize', text),
  },

  // ========== 对话历史 API ==========

  chat: {
    saveHistory: (sessionId, data) => ipcRenderer.invoke(IPC_CHAT.SAVE_HISTORY, sessionId, data),
    getHistory: (sessionId) => ipcRenderer.invoke(IPC_CHAT.GET_HISTORY, sessionId),
    deleteHistory: (sessionId) => ipcRenderer.invoke(IPC_CHAT.DELETE_HISTORY, sessionId),
    listHistories: () => ipcRenderer.invoke(IPC_CHAT.LIST_HISTORIES),
  },

  // ========== 对话框 API ==========

  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:open-file', options),
    saveFile: (options) => ipcRenderer.invoke('dialog:save-file', options),
  },
});
