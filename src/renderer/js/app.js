/**
 * AI-SSH 渲染进程主模块
 * 管理UI交互、终端、AI对话、SFTP等所有前端逻辑
 */

// ========== 全局状态 ==========
const state = {
  sshConnections: [],
  activeSessionId: null,
  sessions: new Map(), // sessionId -> { terminal, fitAddon, tabElement, sshConfigId }
  aiModels: [],
  selectedModelId: null,
  aiMessages: new Map(), // sessionId -> [{ role, content }]
  isStreaming: false,
  pendingCommand: null,
  // Agent 相关状态
  agentMode: 'ask', // ask | auto | plan
  agentSteps: [],
  currentStep: 0,
  // 视图模式
  viewMode: 'split', // terminal | ai | split
};

// ========== 工具函数 ==========

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  // 错误和警告停留更久
  const duration = (type === 'error' || type === 'warning') ? 8000 : 3000;
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    toast.style.transition = '0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ========== SSH面板 ==========

async function loadSSHConnections() {
  try {
    state.sshConnections = await window.api.config.getSSHList();
    renderSSHList();
  } catch (err) {
    showToast('加载SSH配置失败: ' + err.message, 'error');
  }
}

function renderSSHList() {
  const container = document.getElementById('ssh-list');
  if (state.sshConnections.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        <p>暂无SSH连接</p>
        <p class="hint">点击"新建连接"添加服务器</p>
      </div>`;
    return;
  }

  container.innerHTML = state.sshConnections.map(conn => {
    // 检查是否有活跃会话使用此配置
    let sessionStatus = '';
    for (const [sid, sess] of state.sessions) {
      if (sess.sshConfigId === conn.id) {
        sessionStatus = sess.status || '';
        break;
      }
    }

    return `
      <div class="ssh-item ${sessionStatus}" data-id="${conn.id}" data-status="${sessionStatus}">
        <div class="ssh-item-icon">
          ${sessionStatus === 'connected' ? '🟢' : sessionStatus === 'connecting' ? '🟡' : '⚫'}
        </div>
        <div class="ssh-item-info">
          <div class="ssh-item-name">${escapeHtml(conn.name || conn.host)}</div>
          <div class="ssh-item-host">${escapeHtml(conn.username)}@${escapeHtml(conn.host)}:${conn.port || 22}</div>
        </div>
        <div class="ssh-item-actions">
          <button class="icon-btn" data-action="edit" data-id="${conn.id}" title="编辑">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn" data-action="delete" data-id="${conn.id}" title="删除">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
          <button class="icon-btn" data-action="sftp" data-id="${conn.id}" title="SFTP">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');

  // 绑定事件
  container.querySelectorAll('.ssh-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.icon-btn')) return;
      const id = item.dataset.id;
      connectSSH(id);
    });
  });

  container.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSSHEditModal(btn.dataset.id);
    });
  });

  container.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('确定删除此连接配置？')) {
        await window.api.config.deleteSSH(btn.dataset.id);
        await loadSSHConnections();
        showToast('连接已删除', 'success');
      }
    });
  });

  container.querySelectorAll('[data-action="sftp"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSFTPForConnection(btn.dataset.id);
    });
  });
}

// ========== SSH连接 ==========

async function connectSSH(sshConfigId) {
  const sessionId = generateId();
  const conn = state.sshConnections.find(c => c.id === sshConfigId);
  if (!conn) return;

  // 创建标签和终端
  createSessionTab(sessionId, conn.name || conn.host, sshConfigId);

  try {
    const result = await window.api.session.connect(sessionId, sshConfigId);
    if (result.status === 'error') {
      showToast(`连接失败: ${result.error}`, 'error');
      updateTabStatus(sessionId, 'error');
    } else {
      updateTabStatus(sessionId, 'connected');
      showToast(`已连接到 ${conn.host}`, 'success');
    }
  } catch (err) {
    showToast(`连接异常: ${err.message}`, 'error');
    updateTabStatus(sessionId, 'error');
  }
}

// ========== 标签管理 ==========

function createSessionTab(sessionId, name, sshConfigId) {
  const tabList = document.getElementById('tab-list');
  const tab = document.createElement('div');
  tab.className = 'tab-item connecting';
  tab.dataset.sessionId = sessionId;
  tab.innerHTML = `
    <span class="tab-status"></span>
    <span class="tab-name">${escapeHtml(name)}</span>
    <span class="tab-close" title="关闭标签">&times;</span>
  `;

  tab.addEventListener('click', (e) => {
    if (e.target.closest('.tab-close')) return;
    switchToSession(sessionId);
  });

  tab.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeSession(sessionId);
  });

  tabList.appendChild(tab);

  // 创建终端
  createTerminal(sessionId, sshConfigId);

  // 切换到新标签
  switchToSession(sessionId);
}

function createTerminal(sessionId, sshConfigId) {
  const container = document.getElementById('terminal-container');

  // 隐藏欢迎页
  document.getElementById('welcome-screen').classList.add('hidden');

  // 创建终端容器
  const termWrapper = document.createElement('div');
  termWrapper.className = 'terminal-instance';
  termWrapper.id = `terminal-${sessionId}`;
  termWrapper.style.display = 'none';
  container.appendChild(termWrapper);

  // 创建xterm终端
  const terminal = new Terminal({
    fontSize: 14,
    fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
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
    cursorBlink: true,
    scrollback: 10000,
    allowTransparency: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);
  terminal.open(termWrapper);

  // 保存会话信息
  const session = {
    terminal,
    fitAddon,
    tabElement: document.querySelector(`[data-session-id="${sessionId}"]`),
    wrapper: termWrapper,
    sshConfigId,
    status: 'connecting',
  };
  state.sessions.set(sessionId, session);

  // 监听用户输入
  terminal.onData((data) => {
    if (state.activeSessionId === sessionId) {
      window.api.session.sendInput(sessionId, data);
    }
  });

  // 自适应大小
  setTimeout(() => {
    fitAddon.fit();
    const dims = fitAddon.proposeDimensions();
    if (dims) {
      window.api.session.resize(sessionId, dims.cols, dims.rows);
    }
  }, 100);

  // 窗口大小变化时重新适配
  const resizeObserver = new ResizeObserver(() => {
    if (state.activeSessionId === sessionId) {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        window.api.session.resize(sessionId, dims.cols, dims.rows);
      }
    }
  });
  resizeObserver.observe(termWrapper);
}

function switchToSession(sessionId) {
  // 保存当前会话的对话历史
  if (state.activeSessionId && state.aiMessages.has(state.activeSessionId)) {
    saveCurrentChatHistory();
  }

  state.activeSessionId = sessionId;

  // 更新标签样式
  document.querySelectorAll('.tab-item').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.sessionId === sessionId);
  });

  // 显示对应终端
  document.querySelectorAll('.terminal-instance').forEach(el => {
    el.style.display = 'none';
  });

  const session = state.sessions.get(sessionId);
  if (session) {
    session.wrapper.style.display = 'block';
    session.fitAddon.fit();
    session.terminal.focus();
    const dims = session.fitAddon.proposeDimensions();
    if (dims) {
      window.api.session.resize(sessionId, dims.cols, dims.rows);
    }
    updateStatusBar(session.status);
  }

  // 加载新会话的对话历史（异步，不阻塞UI）
  loadChatHistory(sessionId).then(loaded => {
    if (!loaded) {
      // 没有历史，显示欢迎页
      renderChatMessages(sessionId);
    }
  });
}

function closeSession(sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session) return;

  // 活跃会话需要确认
  if (session.status === 'connected' || session.status === 'connecting') {
    if (!confirm('确定关闭此连接？')) return;
  }

  // 保存对话历史
  saveCurrentChatHistory();

  // 先从状态中移除，防止 onOutput/onStatus 写入已销毁的终端
  state.sessions.delete(sessionId);

  // 断开连接（fire-and-forget，不阻塞UI）
  window.api.session.disconnect(sessionId).catch(() => {});

  // 销毁终端
  try { session.terminal.dispose(); } catch (e) { /* 已销毁 */ }
  session.wrapper.remove();
  session.tabElement.remove();

  // 清空AI面板
  state.aiMessages.delete(sessionId);
  const aiChat = document.getElementById('ai-chat-messages');
  aiChat.innerHTML = `
    <div class="ai-welcome">
      <div class="ai-avatar">🤖</div>
      <div class="ai-welcome-text">
        <p>我是AI运维Agent。</p>
        <p class="hint">连接SSH后开始对话</p>
      </div>
    </div>`;

  // 切换到其他标签或显示欢迎页
  if (state.sessions.size > 0) {
    const firstId = state.sessions.keys().next().value;
    switchToSession(firstId);
  } else {
    state.activeSessionId = null;
    document.getElementById('welcome-screen').classList.remove('hidden');
    updateStatusBar('disconnected');
  }
}

function updateTabStatus(sessionId, status) {
  const session = state.sessions.get(sessionId);
  if (session) {
    session.status = status;
    session.tabElement.className = `tab-item ${status}${state.activeSessionId === sessionId ? ' active' : ''}`;
  }
  if (state.activeSessionId === sessionId) {
    updateStatusBar(status);
  }
}

function updateStatusBar(status) {
  const el = document.getElementById('status-connection');
  const labels = { connected: '已连接', connecting: '连接中...', disconnected: '未连接', error: '连接错误' };
  el.innerHTML = `<span class="status-dot ${status}"></span> ${labels[status] || status}`;
}

// ========== 监听SSH输出和状态 ==========

function setupSessionListeners() {
  window.api.session.onOutput((data) => {
    const session = state.sessions.get(data.sessionId);
    if (session) {
      try { session.terminal.write(data.data); } catch (e) { /* 终端已销毁 */ }
    }
  });

  window.api.session.onStatus((data) => {
    updateTabStatus(data.sessionId, data.status);
    if (data.status === 'disconnected') {
      const session = state.sessions.get(data.sessionId);
      if (session) {
        try { session.terminal.writeln('\r\n\x1b[33m[连接已断开]\x1b[0m'); } catch (e) { /* 终端已销毁 */ }
      }
    }
    if (data.status === 'error' && data.error) {
      showToast(`SSH错误: ${data.error}`, 'error');
    }
  });
}

// ========== SSH配置编辑模态框 ==========

function openSSHEditModal(editId) {
  const modal = document.getElementById('ssh-edit-modal');
  const title = document.getElementById('ssh-modal-title');
  const form = document.getElementById('ssh-edit-form');

  form.reset();
  document.getElementById('ssh-form-id').value = '';
  document.getElementById('ssh-form-port').value = '22';

  if (editId) {
    title.textContent = '编辑SSH连接';
    const conn = state.sshConnections.find(c => c.id === editId);
    if (conn) {
      document.getElementById('ssh-form-id').value = conn.id;
      document.getElementById('ssh-form-name').value = conn.name || '';
      document.getElementById('ssh-form-host').value = conn.host || '';
      document.getElementById('ssh-form-port').value = conn.port || 22;
      document.getElementById('ssh-form-username').value = conn.username || '';
      document.getElementById('ssh-form-timeout').value = conn.timeout || 10000;
      document.getElementById('ssh-form-group').value = conn.group || '';

      if (conn.authType === 'privateKey') {
        document.querySelector('input[name="authType"][value="privateKey"]').checked = true;
        toggleAuthFields('privateKey');
      } else {
        document.querySelector('input[name="authType"][value="password"]').checked = true;
        toggleAuthFields('password');
      }

      // 敏感字段用 placeholder 提示已保存，留空不修改
      document.getElementById('ssh-form-password').placeholder = '已保存，留空则不修改';
      document.getElementById('ssh-form-privatekey').placeholder = '已保存，留空则不修改';
      document.getElementById('ssh-form-passphrase').placeholder = '已保存，留空则不修改';
    }
  } else {
    title.textContent = '新建SSH连接';
    toggleAuthFields('password');
    document.getElementById('ssh-form-password').placeholder = '输入密码';
    document.getElementById('ssh-form-privatekey').placeholder = '-----BEGIN RSA PRIVATE KEY-----';
    document.getElementById('ssh-form-passphrase').placeholder = '私钥密码';
  }

  modal.classList.remove('hidden');
}

function toggleAuthFields(type) {
  document.getElementById('password-group').classList.toggle('hidden', type !== 'password');
  document.getElementById('privatekey-group').classList.toggle('hidden', type !== 'privateKey');
  document.getElementById('passphrase-group').classList.toggle('hidden', type !== 'privateKey');
}

async function saveSSHConfig() {
  const id = document.getElementById('ssh-form-id').value || generateId();
  const name = document.getElementById('ssh-form-name').value.trim();
  const host = document.getElementById('ssh-form-host').value.trim();
  const port = parseInt(document.getElementById('ssh-form-port').value) || 22;
  const username = document.getElementById('ssh-form-username').value.trim();
  const authType = document.querySelector('input[name="authType"]:checked').value;
  const timeout = parseInt(document.getElementById('ssh-form-timeout').value) || 10000;
  const group = document.getElementById('ssh-form-group').value.trim() || '默认';

  if (!name || !host || !username) {
    showToast('请填写必填字段', 'warning');
    return;
  }

  const config = { id, name, host, port, username, authType, timeout, group };

  // 编辑模式下，敏感字段留空表示不修改
  if (authType === 'password') {
    const password = document.getElementById('ssh-form-password').value;
    if (password) config.password = password;
  } else {
    const privateKey = document.getElementById('ssh-form-privatekey').value;
    const passphrase = document.getElementById('ssh-form-passphrase').value;
    if (privateKey) config.privateKey = privateKey;
    if (passphrase) config.passphrase = passphrase;
  }

  // 新建模式必须填写认证信息
  if (!document.getElementById('ssh-form-id').value) {
    if (authType === 'password' && !config.password) {
      showToast('请输入密码', 'warning');
      return;
    }
    if (authType === 'privateKey' && !config.privateKey) {
      showToast('请输入私钥', 'warning');
      return;
    }
  }

  try {
    await window.api.config.saveSSH(config);
    document.getElementById('ssh-edit-modal').classList.add('hidden');
    await loadSSHConnections();
    showToast('SSH配置已保存', 'success');
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

// ========== AI对话 ==========

async function loadAIModels() {
  try {
    state.aiModels = await window.api.config.getAIModels();
    const select = document.getElementById('ai-model-select');
    select.innerHTML = '<option value="">选择模型...</option>' +
      state.aiModels.map(m => `<option value="${m.id}">${escapeHtml(m.alias || m.modelName)}</option>`).join('');

    const aiConfig = await window.api.config.getAIConfig();
    if (aiConfig.defaultModelId) {
      select.value = aiConfig.defaultModelId;
      state.selectedModelId = aiConfig.defaultModelId;
    }
  } catch (err) {
    console.error('加载AI模型失败:', err);
  }
}

function setupAIChat() {
  const input = document.getElementById('ai-input');
  const sendBtn = document.getElementById('ai-send-btn');
  const stopBtn = document.getElementById('ai-stop-btn');
  const modelSelect = document.getElementById('ai-model-select');

  // 输入法组字状态追踪（解决中文输入法回车触发发送的问题）
  let isComposing = false;
  input.addEventListener('compositionstart', () => { isComposing = true; });
  input.addEventListener('compositionend', () => { isComposing = false; });

  // 发送消息
  sendBtn.addEventListener('click', sendAIMessage);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
      e.preventDefault();
      sendAIMessage();
    }
  });

  // 自动调整输入框高度
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // 停止生成
  stopBtn.addEventListener('click', () => {
    window.api.ai.stop();
  });

  // 模型切换
  modelSelect.addEventListener('change', () => {
    state.selectedModelId = modelSelect.value;
  });

  // Agent 模式切换
  document.querySelectorAll('.ai-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      state.agentMode = mode;
      document.querySelectorAll('.ai-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // 更新模式提示
      const hints = { ask: 'Ask: 命令需确认', auto: 'Auto: 命令自动执行', plan: 'Plan: 只生成计划' };
      document.getElementById('ai-mode-hint').textContent = hints[mode];
      // 更新欢迎页模式显示
      const welcomeHint = document.querySelector('.ai-welcome-text .hint strong');
      if (welcomeHint) welcomeHint.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
    });
  });

  // 对话历史按钮
  document.getElementById('ai-history-btn').addEventListener('click', openChatHistoryModal);

  // 监听流式数据
  window.api.ai.onStreamChunk((data) => {
    appendAIStreamContent(data.content);
  });

  window.api.ai.onStreamDone(() => {
    finishAIStream();
  });

  window.api.ai.onStreamError((data) => {
    finishAIStream();
    showToast(`AI错误: ${data.error}`, 'error');
  });
}

// ========== Agent 对话核心 ==========

async function sendAIMessage() {
  const input = document.getElementById('ai-input');
  const message = input.value.trim();
  if (!message) return;

  if (!state.selectedModelId) {
    showToast('请先选择AI模型', 'warning');
    return;
  }

  input.value = '';
  input.style.height = 'auto';

  // 添加用户消息到UI
  addChatMessage('user', message);

  // 获取终端上下文
  let terminalContext = '';
  const syncEnabled = document.getElementById('ai-context-sync').checked;
  if (syncEnabled && state.activeSessionId) {
    try {
      terminalContext = await window.api.session.getTerminalContext(state.activeSessionId, 50);
    } catch (e) {
      // ignore
    }
  }

  // 更新UI状态
  state.isStreaming = true;
  document.getElementById('ai-send-btn').classList.add('hidden');
  document.getElementById('ai-stop-btn').classList.remove('hidden');

  // 准备消息历史
  const sessionId = state.activeSessionId || 'default';
  if (!state.aiMessages.has(sessionId)) {
    state.aiMessages.set(sessionId, []);
  }
  const messages = state.aiMessages.get(sessionId);
  messages.push({ role: 'user', content: message });

  // 对话压缩：超过20条消息时压缩
  if (messages.length > 20) {
    const { compressed } = await window.api.chat.compressMessages
      ? { compressed: messages } // fallback if not available
      : { compressed: messages };
    // 简单压缩：保留最近10条
    const recent = messages.slice(-10);
    const summary = `[历史摘要] 之前共${messages.length - 10}条消息`;
    state.aiMessages.set(sessionId, [
      { role: 'system', content: summary },
      ...recent,
    ]);
  }

  // 创建AI消息容器用于流式输出
  state._streamBubble = addChatMessage('ai', '', true);

  try {
    const currentMessages = state.aiMessages.get(sessionId);
    await window.api.ai.stream({
      modelId: state.selectedModelId,
      messages: currentMessages.slice(-15), // 最近15条消息
      terminalContext,
      mode: state.agentMode, // 传递 Agent 模式
    });
  } catch (err) {
    showToast('AI请求失败: ' + err.message, 'error');
  }
}

// ========== 会话历史持久化 ==========

async function saveCurrentChatHistory() {
  const sessionId = state.activeSessionId || 'default';
  const messages = state.aiMessages.get(sessionId) || [];
  if (messages.length === 0) return;

  const conn = state.sshConnections.find(c => {
    const session = state.sessions.get(sessionId);
    return session && session.sshConfigId === c.id;
  });

  await window.api.chat.saveHistory(sessionId, {
    messages,
    mode: state.agentMode,
    sshConfigId: conn?.id || null,
    serverName: conn?.name || conn?.host || '未连接',
    createdAt: Date.now(),
  });
}

async function loadChatHistory(sessionId) {
  const history = await window.api.chat.getHistory(sessionId);
  if (history && history.messages) {
    state.aiMessages.set(sessionId, history.messages);
    if (history.mode) {
      state.agentMode = history.mode;
      // 更新模式按钮状态
      document.querySelectorAll('.ai-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === history.mode);
      });
      const hints = { ask: 'Ask: 命令需确认', auto: 'Auto: 命令自动执行', plan: 'Plan: 只生成计划' };
      document.getElementById('ai-mode-hint').textContent = hints[history.mode] || '';
    }
    // 重新渲染对话
    renderChatMessages(sessionId);
    return true;
  }
  return false;
}

function renderChatMessages(sessionId) {
  const container = document.getElementById('ai-chat-messages');
  container.innerHTML = '';
  const messages = state.aiMessages.get(sessionId) || [];
  if (messages.length === 0) {
    container.innerHTML = `
      <div class="ai-welcome">
        <div class="ai-avatar">🤖</div>
        <div class="ai-welcome-text">
          <p>你好！我是AI运维Agent。</p>
          <p>描述你的运维需求，我会分析、规划并执行。</p>
          <p class="hint">当前模式: <strong>${state.agentMode}</strong></p>
        </div>
      </div>`;
    return;
  }
  for (const msg of messages) {
    if (msg.role === 'system') continue; // 不显示系统消息
    if (msg.role === 'user') {
      addChatMessage('user', msg.content);
    } else if (msg.role === 'assistant') {
      const bubble = addChatMessage('ai', '', false);
      bubble.innerHTML = renderMarkdown(msg.content);
      bindCommandButtons(bubble);
    }
  }
}

function renderMarkdown(text) {
  let html = escapeHtml(text);
  // 代码块 → 可执行命令块
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<div class="ai-command-block"><div class="ai-command-header"><span>命令</span></div><div class="ai-command-content">$2</div><div class="ai-command-actions"><button class="btn btn-xs btn-primary execute-cmd-btn">执行</button><button class="btn btn-xs btn-secondary copy-cmd-btn">复制</button></div></div>');
  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code style="background:var(--bg-surface);padding:1px 4px;border-radius:3px;font-family:var(--font-mono);font-size:12px;">$1</code>');
  // 粗体
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  return html;
}

function bindCommandButtons(container) {
  container.querySelectorAll('.execute-cmd-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmdBlock = btn.closest('.ai-command-block');
      const cmd = cmdBlock.querySelector('.ai-command-content').textContent.trim();
      executeCommandFromAI(cmd);
    });
  });
  container.querySelectorAll('.copy-cmd-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmdBlock = btn.closest('.ai-command-block');
      const cmd = cmdBlock.querySelector('.ai-command-content').textContent.trim();
      navigator.clipboard.writeText(cmd);
      showToast('已复制到剪贴板', 'success');
    });
  });
}

// ========== 对话历史列表 ==========

async function openChatHistoryModal() {
  const modal = document.getElementById('chat-history-modal');
  const list = document.getElementById('chat-history-list');
  const histories = await window.api.chat.listHistories();

  if (histories.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>暂无对话历史</p></div>';
  } else {
    list.innerHTML = histories.map(h => `
      <div class="chat-history-item" data-session-id="${h.sessionId}">
        <div class="chat-history-info">
          <div class="chat-history-server">${escapeHtml(h.serverName || '未知')}</div>
          <div class="chat-history-meta">
            <span class="chat-history-mode">${h.mode || 'ask'}</span>
            <span class="chat-history-time">${new Date(h.updatedAt).toLocaleString()}</span>
            <span class="chat-history-count">${(h.messages || []).length}条消息</span>
          </div>
        </div>
        <div class="chat-history-actions">
          <button class="icon-btn btn-continue" title="继续对话"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
          <button class="icon-btn btn-delete" title="删除"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
        </div>
      </div>`).join('');

    // 绑定事件
    list.querySelectorAll('.btn-continue').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = btn.closest('.chat-history-item');
        const sessionId = item.dataset.sessionId;
        await loadChatHistory(sessionId);
        modal.classList.add('hidden');
      });
    });

    list.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = btn.closest('.chat-history-item');
        const sessionId = item.dataset.sessionId;
        if (confirm('确定删除此对话历史？')) {
          await window.api.chat.deleteHistory(sessionId);
          state.aiMessages.delete(sessionId);
          openChatHistoryModal(); // 刷新列表
          showToast('对话历史已删除', 'success');
        }
      });
    });
  }

  modal.classList.remove('hidden');
}

function addChatMessage(role, content, isStreaming = false) {
  const container = document.getElementById('ai-chat-messages');
  const welcome = container.querySelector('.ai-welcome');
  if (welcome) welcome.remove();

  const msg = document.createElement('div');
  msg.className = `chat-message ${role}`;

  if (role === 'user') {
    msg.innerHTML = `
      <div class="chat-avatar">U</div>
      <div class="chat-bubble">${escapeHtml(content)}</div>`;
  } else {
    msg.innerHTML = `
      <div class="chat-avatar">AI</div>
      <div class="chat-bubble">${isStreaming ? '<span class="typing-indicator"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></span>' : escapeHtml(content)}</div>`;
  }

  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;

  if (role === 'ai') {
    return msg.querySelector('.chat-bubble');
  }
  return msg;
}

function addThinkingIndicator() {
  const container = document.getElementById('ai-chat-messages');
  const el = document.createElement('div');
  el.className = 'chat-message ai';
  el.innerHTML = `
    <div class="chat-avatar">AI</div>
    <div class="chat-bubble">
      <div class="typing-indicator">
        <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
      </div>
    </div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function appendAIStreamContent(content) {
  if (!state._streamBubble) return;
  // 移除打字指示器
  const typing = state._streamBubble.querySelector('.typing-indicator');
  if (typing) typing.remove();

  state._streamContent = (state._streamContent || '') + content;

  // 简单markdown渲染
  let html = escapeHtml(state._streamContent);
  // 代码块 → 可执行命令块
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<div class="ai-command-block"><div class="ai-command-header"><span>命令</span></div><div class="ai-command-content">$2</div><div class="ai-command-actions"><button class="btn btn-xs btn-primary execute-cmd-btn">执行</button><button class="btn btn-xs btn-secondary copy-cmd-btn">复制</button></div></div>');
  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code style="background:var(--bg-surface);padding:1px 4px;border-radius:3px;font-family:var(--font-mono);font-size:12px;">$1</code>');
  // 粗体
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  state._streamBubble.innerHTML = html;

  const container = document.getElementById('ai-chat-messages');
  container.scrollTop = container.scrollHeight;
}

function finishAIStream() {
  state.isStreaming = false;
  document.getElementById('ai-send-btn').classList.remove('hidden');
  document.getElementById('ai-stop-btn').classList.add('hidden');

  // 移除打字指示器
  document.querySelectorAll('.typing-indicator').forEach(el => el.remove());

  // 保存AI回复到消息历史
  if (state._streamContent) {
    const sessionId = state.activeSessionId || 'default';
    const messages = state.aiMessages.get(sessionId) || [];
    messages.push({ role: 'assistant', content: state._streamContent });

    // 绑定命令执行按钮
    if (state._streamBubble) {
      bindCommandButtons(state._streamBubble);

      // Auto 模式：自动执行代码块中的命令
      if (state.agentMode === 'auto' && state.activeSessionId) {
        const cmdBlocks = state._streamBubble.querySelectorAll('.ai-command-block');
        if (cmdBlocks.length > 0) {
          const firstCmd = cmdBlocks[0].querySelector('.ai-command-content').textContent.trim();
          if (firstCmd) {
            // 延迟执行，让用户看到命令内容
            setTimeout(() => executeCommandFromAI(firstCmd), 500);
          }
        }
      }
    }

    // 持久化保存对话
    saveCurrentChatHistory();
  }

  state._streamBubble = null;
  state._streamContent = '';
}

async function executeCommandFromAI(command) {
  if (!state.activeSessionId) {
    showToast('请先连接SSH会话', 'warning');
    return;
  }

  // 安全检查
  const check = await window.api.security.checkCommand(command);
  if (check.blocked) {
    showDangerConfirm(command, check);
    return;
  }

  // 直接执行
  window.api.session.sendInput(state.activeSessionId, command + '\n');
  showToast('命令已发送', 'info');
}

function showDangerConfirm(command, check) {
  const modal = document.getElementById('danger-confirm-modal');
  document.getElementById('danger-desc').textContent = check.desc;
  document.getElementById('danger-command').textContent = command;
  document.getElementById('danger-level').textContent = `风险等级: ${check.level.toUpperCase()}`;
  modal.classList.remove('hidden');

  state.pendingCommand = command;
}

// ========== SFTP ==========

let sftpCurrentPath = '/';
let sftpSessionId = null;

async function openSFTPForConnection(sshConfigId) {
  // 查找已有的会话
  let targetSessionId = null;
  for (const [sid, sess] of state.sessions) {
    if (sess.sshConfigId === sshConfigId && sess.status === 'connected') {
      targetSessionId = sid;
      break;
    }
  }

  if (!targetSessionId) {
    showToast('请先连接SSH会话', 'warning');
    return;
  }

  sftpSessionId = targetSessionId;
  sftpCurrentPath = '/';
  document.getElementById('sftp-panel').classList.remove('hidden');
  document.getElementById('sftp-current-path').textContent = sftpCurrentPath;
  loadSFTPFiles();
}

async function loadSFTPFiles() {
  if (!sftpSessionId) return;

  const fileList = document.getElementById('sftp-file-list');
  fileList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">加载中...</div>';

  try {
    const files = await window.api.session.sftpList(sftpSessionId, sftpCurrentPath);
    renderSFTPFiles(files);
  } catch (err) {
    fileList.innerHTML = `<div style="padding:20px;text-align:center;color:var(--accent-red);">加载失败: ${escapeHtml(err.message)}</div>`;
  }
}

function renderSFTPFiles(files) {
  const fileList = document.getElementById('sftp-file-list');

  if (files.length === 0) {
    fileList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">空目录</div>';
    return;
  }

  fileList.innerHTML = files.map(file => {
    const icon = file.type === 'directory' ? '📁' : (file.name.endsWith('.sh') ? '📜' : '📄');
    return `
      <div class="sftp-file-item" data-name="${escapeHtml(file.name)}" data-type="${file.type}">
        <span class="sftp-file-icon">${icon}</span>
        <span class="sftp-file-name">${escapeHtml(file.name)}</span>
        <span class="sftp-file-size">${file.type === 'file' ? formatBytes(file.size) : '-'}</span>
        <span class="sftp-file-perms">${file.permissions}</span>
        <span class="sftp-file-actions">
          ${file.type === 'file' ? `<button class="icon-btn btn-download" title="下载"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg></button>` : ''}
          <button class="icon-btn btn-rename" title="重命名"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="icon-btn btn-delete" title="删除"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
        </span>
      </div>`;
  }).join('');

  // 绑定事件
  fileList.querySelectorAll('.sftp-file-item').forEach(item => {
    item.addEventListener('dblclick', () => {
      if (item.dataset.type === 'directory') {
        sftpCurrentPath = sftpCurrentPath === '/'
          ? '/' + item.dataset.name
          : sftpCurrentPath + '/' + item.dataset.name;
        document.getElementById('sftp-current-path').textContent = sftpCurrentPath;
        loadSFTPFiles();
      }
    });
  });

  fileList.querySelectorAll('.btn-download').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = btn.closest('.sftp-file-item');
      const fileName = item.dataset.name;
      const remotePath = sftpCurrentPath === '/' ? '/' + fileName : sftpCurrentPath + '/' + fileName;

      const result = await window.api.dialog.saveFile({ defaultPath: fileName });
      if (!result.canceled && result.filePath) {
        try {
          await window.api.session.sftpDownload(sftpSessionId, remotePath, result.filePath);
          showToast('下载完成', 'success');
        } catch (err) {
          showToast('下载失败: ' + err.message, 'error');
        }
      }
    });
  });

  fileList.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = btn.closest('.sftp-file-item');
      const fileName = item.dataset.name;
      const isDir = item.dataset.type === 'directory';
      const remotePath = sftpCurrentPath === '/' ? '/' + fileName : sftpCurrentPath + '/' + fileName;

      if (confirm(`确定删除 ${isDir ? '目录' : '文件'} "${fileName}"？`)) {
        try {
          await window.api.session.sftpDelete(sftpSessionId, remotePath, isDir);
          showToast('删除成功', 'success');
          loadSFTPFiles();
        } catch (err) {
          showToast('删除失败: ' + err.message, 'error');
        }
      }
    });
  });

  fileList.querySelectorAll('.btn-rename').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = btn.closest('.sftp-file-item');
      const oldName = item.dataset.name;
      const remotePath = sftpCurrentPath === '/' ? '/' + oldName : sftpCurrentPath + '/' + oldName;

      const newName = prompt('输入新名称:', oldName);
      if (newName && newName !== oldName) {
        const parentDir = sftpCurrentPath;
        const newPath = parentDir === '/' ? '/' + newName : parentDir + '/' + newName;
        try {
          await window.api.session.sftpRename(sftpSessionId, remotePath, newPath);
          showToast('重命名成功', 'success');
          loadSFTPFiles();
        } catch (err) {
          showToast('重命名失败: ' + err.message, 'error');
        }
      }
    });
  });
}

// ========== 全局配置模态框 ==========

async function openSettingsModal() {
  const modal = document.getElementById('settings-modal');

  // 加载AI模型列表
  const models = await window.api.config.getAIModels();
  const modelsList = document.getElementById('ai-models-list');
  modelsList.innerHTML = models.map(m => `
    <div class="model-item">
      <div class="model-item-info">
        <div class="model-item-name">${escapeHtml(m.alias || m.modelName)}</div>
        <div class="model-item-detail">${escapeHtml(m.apiFormat)} · ${escapeHtml(m.modelName)}</div>
      </div>
      <div class="model-item-actions">
        <button class="icon-btn" data-action="test-model" data-id="${m.id}" title="测试">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="icon-btn" data-action="edit-model" data-id="${m.id}" title="编辑">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="icon-btn" data-action="delete-model" data-id="${m.id}" title="删除">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    </div>`).join('');

  // 绑定模型操作
  modelsList.querySelectorAll('[data-action="test-model"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      showToast('正在测试连接...', 'info');
      const result = await window.api.config.testAIModel(btn.dataset.id);
      showToast(result.message, result.success ? 'success' : 'error');
    });
  });

  modelsList.querySelectorAll('[data-action="edit-model"]').forEach(btn => {
    btn.addEventListener('click', () => {
      openAIModelModal(btn.dataset.id);
    });
  });

  modelsList.querySelectorAll('[data-action="delete-model"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('确定删除此模型？')) {
        await window.api.config.deleteAIModel(btn.dataset.id);
        await loadAIModels();
        await openSettingsModal(); // 刷新
        showToast('模型已删除', 'success');
      }
    });
  });

  // 加载系统提示词
  const aiConfig = await window.api.config.getAIConfig();
  document.getElementById('settings-system-prompt').value = aiConfig.systemPrompt || '';

  // 加载终端设置
  const settings = await window.api.config.getAIConfig();
  document.getElementById('settings-font-size').value = 14;

  modal.classList.remove('hidden');
}

async function saveSettings() {
  const systemPrompt = document.getElementById('settings-system-prompt').value;
  await window.api.config.saveAIConfig({ systemPrompt });
  document.getElementById('settings-modal').classList.add('hidden');
  showToast('配置已保存', 'success');
}

// ========== AI模型编辑模态框 ==========

function openAIModelModal(editId) {
  const modal = document.getElementById('ai-model-modal');
  const title = document.getElementById('ai-modal-title');
  const apiKeyInput = document.getElementById('ai-form-api-key');

  document.getElementById('ai-model-form').reset();
  document.getElementById('ai-form-id').value = '';

  if (editId) {
    title.textContent = '编辑AI模型';
    const model = state.aiModels.find(m => m.id === editId);
    if (model) {
      document.getElementById('ai-form-id').value = model.id;
      document.getElementById('ai-form-alias').value = model.alias || '';
      document.getElementById('ai-form-format').value = model.apiFormat || 'openai';
      document.getElementById('ai-form-model-name').value = model.modelName || '';
      document.getElementById('ai-form-base-url').value = model.baseUrl || '';
      // API Key 不回显，用 placeholder 提示
      apiKeyInput.value = '';
      apiKeyInput.placeholder = '已保存，留空则不修改';
    }
  } else {
    title.textContent = '添加AI模型';
    apiKeyInput.placeholder = 'sk-...';
  }

  // 提升层级，确保显示在其他模态框之上
  const openModals = document.querySelectorAll('.modal:not(.hidden)');
  const maxZ = Math.max(...Array.from(openModals).map(el => parseInt(getComputedStyle(el).zIndex) || 2000), 2000);
  modal.style.zIndex = maxZ + 1;
  modal.classList.remove('hidden');
}

async function saveAIModel() {
  const id = document.getElementById('ai-form-id').value || generateId();
  const alias = document.getElementById('ai-form-alias').value.trim();
  const apiFormat = document.getElementById('ai-form-format').value;
  const modelName = document.getElementById('ai-form-model-name').value.trim();
  const baseUrl = document.getElementById('ai-form-base-url').value.trim();
  const apiKey = document.getElementById('ai-form-api-key').value;

  if (!alias || !modelName) {
    showToast('请填写必填字段', 'warning');
    return;
  }

  // 编辑模式下，API Key 留空表示不修改
  const config = { id, alias, apiFormat, modelName, baseUrl };
  if (apiKey) {
    config.apiKey = apiKey;
  } else if (!id || !document.getElementById('ai-form-id').value) {
    // 新建模式必须填写 API Key
    if (!apiKey) {
      showToast('请填写 API Key', 'warning');
      return;
    }
  }

  try {
    await window.api.config.saveAIModel(config);
    const aiModal = document.getElementById('ai-model-modal');
    aiModal.classList.add('hidden');
    aiModal.style.zIndex = '';
    await loadAIModels();
    // 刷新全局配置弹窗中的模型列表
    await openSettingsModal();
    showToast('模型已保存', 'success');
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

// ========== 全局菜单 ==========

function setupGlobalMenu() {
  const btn = document.getElementById('global-menu-btn');
  const menu = document.getElementById('global-menu');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });

  document.addEventListener('click', () => {
    menu.classList.add('hidden');
  });

  menu.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      menu.classList.add('hidden');

      switch (action) {
        case 'settings':
          openSettingsModal();
          break;
        case 'about':
          document.getElementById('about-modal').classList.remove('hidden');
          break;
        case 'export-config':
          showToast('导出配置功能开发中...', 'info');
          break;
        case 'import-config':
          showToast('导入配置功能开发中...', 'info');
          break;
      }
    });
  });
}

// ========== 面板收展 ==========

function setupPanelToggles() {
  // SSH面板
  document.getElementById('toggle-ssh-panel').addEventListener('click', () => {
    document.getElementById('ssh-panel').classList.add('collapsed');
    document.getElementById('ssh-panel-toggle').classList.remove('hidden');
  });

  document.getElementById('ssh-panel-toggle').addEventListener('click', () => {
    document.getElementById('ssh-panel').classList.remove('collapsed');
    document.getElementById('ssh-panel-toggle').classList.add('hidden');
    // 重新适配终端
    if (state.activeSessionId) {
      const session = state.sessions.get(state.activeSessionId);
      if (session) {
        setTimeout(() => session.fitAddon.fit(), 100);
      }
    }
  });

  // AI面板
  document.getElementById('toggle-ai-panel').addEventListener('click', () => {
    document.getElementById('ai-panel').classList.add('collapsed');
    document.getElementById('ai-panel-toggle').classList.remove('hidden');
  });

  document.getElementById('ai-panel-toggle').addEventListener('click', () => {
    document.getElementById('ai-panel').classList.remove('collapsed');
    document.getElementById('ai-panel-toggle').classList.add('hidden');
    if (state.activeSessionId) {
      const session = state.sessions.get(state.activeSessionId);
      if (session) {
        setTimeout(() => session.fitAddon.fit(), 100);
      }
    }
  });
}

// ========== SFTP面板 ==========

function setupSFTPPanel() {
  document.getElementById('sftp-close-btn').addEventListener('click', () => {
    document.getElementById('sftp-panel').classList.add('hidden');
    sftpSessionId = null;
  });

  document.getElementById('sftp-refresh-btn').addEventListener('click', () => {
    loadSFTPFiles();
  });

  document.getElementById('sftp-upload-btn').addEventListener('click', async () => {
    if (!sftpSessionId) return;
    const result = await window.api.dialog.openFile({ properties: ['openFile', 'multiSelections'] });
    if (!result.canceled && result.filePaths.length > 0) {
      for (const localPath of result.filePaths) {
        const fileName = localPath.split('/').pop().split('\\').pop();
        const remotePath = sftpCurrentPath === '/' ? '/' + fileName : sftpCurrentPath + '/' + fileName;
        try {
          await window.api.session.sftpUpload(sftpSessionId, localPath, remotePath);
          showToast(`上传成功: ${fileName}`, 'success');
        } catch (err) {
          showToast(`上传失败: ${err.message}`, 'error');
        }
      }
      loadSFTPFiles();
    }
  });

  document.getElementById('sftp-mkdir-btn').addEventListener('click', async () => {
    if (!sftpSessionId) return;
    const dirName = prompt('请输入目录名称:');
    if (dirName) {
      const remotePath = sftpCurrentPath === '/' ? '/' + dirName : sftpCurrentPath + '/' + dirName;
      try {
        await window.api.session.sftpMkdir(sftpSessionId, remotePath);
        showToast('目录创建成功', 'success');
        loadSFTPFiles();
      } catch (err) {
        showToast('创建失败: ' + err.message, 'error');
      }
    }
  });

  // 返回上级目录
  document.getElementById('sftp-current-path').addEventListener('click', () => {
    if (sftpCurrentPath !== '/') {
      const parts = sftpCurrentPath.split('/').filter(Boolean);
      parts.pop();
      sftpCurrentPath = parts.length === 0 ? '/' : '/' + parts.join('/');
      document.getElementById('sftp-current-path').textContent = sftpCurrentPath;
      loadSFTPFiles();
    }
  });
}

// ========== 模态框通用关闭 ==========

function setupModals() {
  // 关闭按钮
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.modal');
      modal.classList.add('hidden');
      modal.style.zIndex = '';
    });
  });

  // 点击遮罩关闭
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', () => {
      const modal = overlay.closest('.modal');
      modal.classList.add('hidden');
      modal.style.zIndex = '';
    });
  });

  // SSH表单
  document.getElementById('ssh-form-save').addEventListener('click', saveSSHConfig);
  document.getElementById('ssh-form-cancel').addEventListener('click', () => {
    document.getElementById('ssh-edit-modal').classList.add('hidden');
  });

  // 认证方式切换
  document.querySelectorAll('input[name="authType"]').forEach(radio => {
    radio.addEventListener('change', () => toggleAuthFields(radio.value));
  });

  // AI模型表单
  document.getElementById('ai-form-save').addEventListener('click', saveAIModel);
  document.getElementById('ai-form-cancel').addEventListener('click', () => {
    const aiModal = document.getElementById('ai-model-modal');
    aiModal.classList.add('hidden');
    aiModal.style.zIndex = '';
  });

  document.getElementById('ai-form-test').addEventListener('click', async () => {
    // 先保存再测试
    await saveAIModel();
    const modelId = document.getElementById('ai-form-id').value;
    if (modelId) {
      showToast('正在测试连接...', 'info');
      const result = await window.api.config.testAIModel(modelId);
      showToast(result.message, result.success ? 'success' : 'error');
    }
  });

  // 高危命令确认
  document.getElementById('danger-confirm').addEventListener('click', () => {
    if (state.pendingCommand && state.activeSessionId) {
      window.api.session.sendInput(state.activeSessionId, state.pendingCommand + '\n');
      showToast('命令已执行', 'warning');
    }
    state.pendingCommand = null;
    document.getElementById('danger-confirm-modal').classList.add('hidden');
  });

  document.getElementById('danger-cancel').addEventListener('click', () => {
    state.pendingCommand = null;
    document.getElementById('danger-confirm-modal').classList.add('hidden');
  });

  // 全局配置
  document.getElementById('settings-save').addEventListener('click', saveSettings);
  document.getElementById('settings-cancel').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.add('hidden');
  });

  document.getElementById('add-ai-model-btn').addEventListener('click', () => {
    openAIModelModal();
  });

  // 关于
  document.getElementById('about-close').addEventListener('click', () => {
    document.getElementById('about-modal').classList.add('hidden');
  });
}

// ========== 键盘快捷键 ==========

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+T: 新建终端
    if (e.ctrlKey && e.key === 't') {
      e.preventDefault();
      if (state.sshConnections.length > 0) {
        connectSSH(state.sshConnections[0].id);
      }
    }

    // Ctrl+W: 关闭当前标签
    if (e.ctrlKey && e.key === 'w') {
      e.preventDefault();
      if (state.activeSessionId) {
        closeSession(state.activeSessionId);
      }
    }

    // Ctrl+1: 终端模式
    if (e.ctrlKey && e.key === '1') {
      e.preventDefault();
      setViewMode('terminal');
    }

    // Ctrl+2: AI模式
    if (e.ctrlKey && e.key === '2') {
      e.preventDefault();
      setViewMode('ai');
    }

    // Ctrl+3: 分屏模式
    if (e.ctrlKey && e.key === '3') {
      e.preventDefault();
      setViewMode('split');
    }

    // Ctrl+Shift+C: 复制（终端内）
    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
      if (state.activeSessionId) {
        const session = state.sessions.get(state.activeSessionId);
        if (session) {
          const selection = session.terminal.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection);
          }
        }
      }
    }

    // Ctrl+Shift+V: 粘贴
    if (e.ctrlKey && e.shiftKey && e.key === 'V') {
      navigator.clipboard.readText().then(text => {
        if (state.activeSessionId && text) {
          window.api.session.sendInput(state.activeSessionId, text);
        }
      });
    }

    // Escape: 关闭模态框
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal').forEach(m => {
        m.classList.add('hidden');
        m.style.zIndex = '';
      });
    }
  });
}

// ========== 视图模式切换 ==========

function setViewMode(mode) {
  state.viewMode = mode;
  const contentArea = document.getElementById('content-area');
  contentArea.setAttribute('data-view', mode);

  // 更新按钮状态
  document.querySelectorAll('.view-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });

  // 切换到AI模式时聚焦输入框
  if (mode === 'ai') {
    setTimeout(() => {
      const input = document.getElementById('ai-input');
      if (input) input.focus();
    }, 100);
  }

  // 切换到终端模式时聚焦终端
  if (mode === 'terminal' && state.activeSessionId) {
    const session = state.sessions.get(state.activeSessionId);
    if (session) {
      setTimeout(() => session.terminal.focus(), 100);
    }
  }

  // 分屏模式下重新适配终端大小
  if (state.activeSessionId) {
    const session = state.sessions.get(state.activeSessionId);
    if (session) {
      setTimeout(() => {
        session.fitAddon.fit();
        const dims = session.fitAddon.proposeDimensions();
        if (dims) {
          window.api.session.resize(state.activeSessionId, dims.cols, dims.rows);
        }
      }, 150);
    }
  }
}

function setupViewModeSwitcher() {
  document.querySelectorAll('.view-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setViewMode(btn.dataset.view);
    });
  });

  // 初始化默认模式
  const contentArea = document.getElementById('content-area');
  contentArea.setAttribute('data-view', state.viewMode);
}

// ========== 应用初始化 ==========

async function initApp() {
  // 加载数据
  await loadSSHConnections();
  await loadAIModels();

  // 设置各模块
  setupSessionListeners();
  setupAIChat();
  setupGlobalMenu();
  setupPanelToggles();
  setupSFTPPanel();
  setupModals();
  setupKeyboardShortcuts();
  setupViewModeSwitcher();

  // 新建连接按钮
  document.getElementById('add-ssh-btn').addEventListener('click', () => openSSHEditModal());

  // 新建对话按钮
  document.getElementById('ai-new-chat-btn').addEventListener('click', () => {
    const sessionId = state.activeSessionId || 'default';
    // 保存当前对话
    saveCurrentChatHistory();
    // 清空当前对话
    state.aiMessages.set(sessionId, []);
    renderChatMessages(sessionId);
    showToast('已创建新对话', 'success');
  });

  console.log('AI-SSH 初始化完成');
}

// DOM加载完成后初始化
document.addEventListener('DOMContentLoaded', initApp);
