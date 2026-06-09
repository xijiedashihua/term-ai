/**
 * AI-SSH 共享常量定义
 * 定义三层架构接口规范、IPC通道、安全规则等
 */

// IPC 通道名称 - 配置层（私密层）
const IPC_CONFIG = {
  GET_SSH_LIST: 'config:ssh:list',
  GET_SSH_ITEM: 'config:ssh:get',
  SAVE_SSH: 'config:ssh:save',
  DELETE_SSH: 'config:ssh:delete',
  GET_AI_MODELS: 'config:ai:models',
  SAVE_AI_MODEL: 'config:ai:save-model',
  DELETE_AI_MODEL: 'config:ai:delete-model',
  TEST_AI_MODEL: 'config:ai:test-model',
  GET_AI_CONFIG: 'config:ai:get-config',
  SAVE_AI_CONFIG: 'config:ai:save-config',
};

// IPC 通道名称 - 会话层（交互层）
const IPC_SESSION = {
  SSH_CONNECT: 'session:ssh:connect',
  SSH_DISCONNECT: 'session:ssh:disconnect',
  SSH_EXEC_COMMAND: 'session:ssh:exec',
  SSH_DATA_INPUT: 'session:ssh:input',
  SSH_RESIZE: 'session:ssh:resize',
  SSH_OUTPUT: 'session:ssh:output',
  SSH_STATUS: 'session:ssh:status',
  SSH_LIST_CONNECTIONS: 'session:ssh:list-connections',
  SFTP_LIST: 'session:sftp:list',
  SFTP_UPLOAD: 'session:sftp:upload',
  SFTP_DOWNLOAD: 'session:sftp:download',
  SFTP_DELETE: 'session:sftp:delete',
  SFTP_RENAME: 'session:sftp:rename',
  SFTP_MKDIR: 'session:sftp:mkdir',
};

// IPC 通道名称 - AI层（智能层）
const IPC_AI = {
  CHAT_SEND: 'ai:chat:send',
  CHAT_STREAM: 'ai:chat:stream',
  CHAT_STOP: 'ai:chat:stop',
  CHAT_CLEAR: 'ai:chat:clear',
};

// IPC 通道名称 - 对话历史
const IPC_CHAT = {
  SAVE_HISTORY: 'chat:save-history',
  GET_HISTORY: 'chat:get-history',
  DELETE_HISTORY: 'chat:delete-history',
  LIST_HISTORIES: 'chat:list-histories',
};

// 高危命令列表（内置拦截库）
const DANGEROUS_COMMANDS = [
  { pattern: /rm\s+(-[rf]+\s+)?\/(\s|$)/, level: 'critical', desc: '删除根目录' },
  { pattern: /rm\s+-[rf]*\s+\/\*/, level: 'critical', desc: '删除根目录所有文件' },
  { pattern: /mkfs\./, level: 'critical', desc: '格式化磁盘' },
  { pattern: /dd\s+.*of=\/dev\//, level: 'critical', desc: '直接写入磁盘设备' },
  { pattern: /:\(\)\s*\{.*\|.*&\s*\};/, level: 'critical', desc: 'Fork炸弹' },
  { pattern: />\s*\/dev\/sd[a-z]/, level: 'critical', desc: '覆写磁盘设备' },
  { pattern: /chmod\s+-[R]*\s+777\s+\//, level: 'high', desc: '递归修改根目录权限' },
  { pattern: /chown\s+-[R]*\s+.*\s+\//, level: 'high', desc: '递归修改根目录所有者' },
  { pattern: /killall\s+(-9\s+)?/, level: 'high', desc: '批量杀进程' },
  { pattern: /pkill\s+(-9\s+)?/, level: 'high', desc: '批量杀进程' },
  { pattern: /shutdown\s+(-h|-r)\s+now/, level: 'high', desc: '立即关机/重启' },
  { pattern: /reboot/, level: 'medium', desc: '系统重启' },
  { pattern: /init\s+[06]/, level: 'high', desc: '切换运行级别（关机/重启）' },
  { pattern: /iptables\s+-F/, level: 'high', desc: '清空防火墙规则' },
  { pattern: /rm\s+-[rf]+\s+~\/\.\*/, level: 'high', desc: '删除用户所有配置文件' },
  { pattern: />\s*\/etc\//, level: 'high', desc: '覆写系统配置文件' },
  { pattern: /mv\s+.*\s+\/dev\/null/, level: 'medium', desc: '移动到空设备' },
  { pattern: /wget.*\|\s*(ba)?sh/, level: 'high', desc: '远程脚本直接执行' },
  { pattern: /curl.*\|\s*(ba)?sh/, level: 'high', desc: '远程脚本直接执行' },
];

// 敏感信息脱敏模式
const SENSITIVE_PATTERNS = [
  { pattern: /-----BEGIN[A-Z\s]*PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]*PRIVATE KEY-----/g, replacement: '[PRIVATE_KEY_REDACTED]' },
  { pattern: /(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)/g, replacement: (match) => {
    const parts = match.split('.');
    return `${parts[0]}.${parts[1]}.*.*`;
  }},
  { pattern: /password[\s:=]+[\S]+/gi, replacement: 'password=***' },
  { pattern: /passwd[\s:=]+[\S]+/gi, replacement: 'passwd=***' },
  { pattern: /token[\s:=]+[\S]+/gi, replacement: 'token=***' },
  { pattern: /secret[\s:=]+[\S]+/gi, replacement: 'secret=***' },
  { pattern: /api[_-]?key[\s:=]+[\S]+/gi, replacement: 'api_key=***' },
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, replacement: 'Bearer [TOKEN_REDACTED]' },
  { pattern: /[A-Za-z0-9+/]{40,}={0,2}/g, replacement: (match) => {
    if (match.length > 60) return '[LONG_TOKEN_REDACTED]';
    return match;
  }},
];

// 默认终端配置
const DEFAULT_TERMINAL = {
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  theme: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#585b7066',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
};

// 默认SSH配置
const DEFAULT_SSH_CONFIG = {
  port: 22,
  username: 'root',
  authType: 'password', // 'password' | 'privateKey'
  password: '',
  privateKey: '',
  passphrase: '',
  timeout: 10000,
  keepAliveInterval: 30000,
};

module.exports = {
  IPC_CONFIG,
  IPC_SESSION,
  IPC_AI,
  IPC_CHAT,
  DANGEROUS_COMMANDS,
  SENSITIVE_PATTERNS,
  DEFAULT_TERMINAL,
  DEFAULT_SSH_CONFIG,
};
