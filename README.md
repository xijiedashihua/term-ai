# AI-SSH 智能终端管理软件

AI赋能、安全隔离、轻量化跨平台SSH运维终端工具。

## 功能特性

- **多SSH会话管理** - 支持多组SSH连接配置，多标签页自由切换
- **原生终端体验** - 基于xterm.js的完整终端模拟
- **SFTP文件传输** - 内置SFTP文件管理，支持上传/下载/删除/重命名
- **AI智能运维** - 自然语言描述需求，AI生成Linux命令
- **安全隔离架构** - 三层隔离，AI无法获取服务器敏感信息
- **高危命令拦截** - 内置危险命令库，强制拦截+二次确认
- **数据加密存储** - AES-256-GCM加密所有敏感配置
- **跨平台支持** - Windows、macOS、Linux

## 技术栈

- **Electron** - 跨平台桌面框架
- **xterm.js** - 终端模拟器
- **ssh2** - SSH/SFTP协议实现
- **原生HTML/CSS/JS** - 无前端框架依赖

## 开发

```bash
# 安装依赖
npm install

# 启动开发模式
npm run dev

# 构建打包
npm run build
```

## 项目结构

```
src/
├── main/           # 主进程
│   ├── main.js           # Electron入口
│   ├── preload.js        # 安全桥接
│   ├── config-store.js   # 加密配置存储
│   ├── ssh-manager.js    # SSH会话管理
│   ├── sftp-manager.js   # SFTP文件操作
│   ├── ai-service.js     # AI服务模块
│   └── security.js       # 安全模块
├── renderer/       # 渲染进程
│   ├── index.html        # 主页面
│   ├── css/styles.css    # 样式
│   └── js/app.js         # 前端逻辑
└── shared/         # 共享模块
    └── constants.js      # 常量定义
```

## 安全架构

```
配置层（私密层） ← 加密存储，AI无权访问
    ↓ 单向
会话层（交互层） ← SSH连接、终端交互
    ↓ 脱敏日志
AI层（智能层）  ← 仅接收脱敏输出，仅返回命令文本
```

## 版本规划

- **V1.0 MVP** - 核心SSH终端 + SFTP + AI对话 + 安全防护
- **V1.1** - AI中断、模型测试、上下文管理、终端主题
- **V1.2** - 审计日志、跳板机、配置导入导出
- **V1.3** - 分屏终端、批量管理、快捷键自定义
