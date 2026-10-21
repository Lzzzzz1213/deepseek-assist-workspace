/* ============================================================
   DeepSeek协助工作区 · 鲸鲸固定私聊页
   作用域：只操作 index.html 中的 #btnPrivateChat 与 #privateChat。
   消息正文只经 textContent / WorkroomMarkdown 安全 DOM；不注入 HTML。
   状态：GET 最近 80 条；历史按 oldest id 前翻；POST 使用幂等 32 位 hex；
   私聊页每1200ms读取状态，收件箱每10秒只读轮询，不自动重发模型请求。
   ============================================================ */
(function () {
  'use strict';

  var API = '/api/private-chat';
  var STICKERS_API = '/api/private-chat/stickers';
  var HISTORY_API = '/api/private-chat/history/';
  var POLL_MS = 1200;
  var INBOX_MS = 10000;
  var TIMEOUT_MS = 8000;
  var LONG_TEXT = 400;
  var MAX_TEXT = 6000;
  var STICKER_URL = /^\/stickers\/[A-Za-z0-9_-]+\.(?:gif|png|webp|jpg)$/i;

  var S = {
    open: false,
    app: null,
    section: null,
    entry: null,
    messageList: null,
    messages: [],
    revision: '',
    generation: '',
    lastRequest: null,
    clearRevision: null,
    hasMore: false,
    pending: null,
    configured: true,
    memory: null,
    catalog: new Map(),
    catalogLoaded: false,
    expanded: new Set(),
    localEchoes: new Map(),
    requestOverrides: new Map(),
    deliveryByRequest: new Map(),
    postQueue: [],
    posting: false,
    echoSequence: 0,
    deliveryFrame: 0,
    deliveryObserver: null,
    snapshotError: '',
    refreshError: '',
    revealIds: new Set(),
    revealTimer: 0,
    lastRevealAt: 0,
    revealGap: 0,
    epoch: 0,
    listSignature: '',
    loadingInitial: false,
    loadingOlder: false,
    sending: false,
    clearing: false,
    refreshInFlight: null,
    pollTimer: 0,
    pollInFlight: false,
    inboxTimer: 0,
    inboxInFlight: false,
    disposed: false,
    proactiveEnabled: true,
    proactiveChanging: false,
    preferenceBarrier: 0,
    inboxSerial: 0,
    inboxApplied: 0,
    unread: 0,
    readThrough: 0,
    notifiedId: 0,
    latestInboxId: 0,
    lastActiveAt: 0,
    activityInFlight: false,
    activityQueued: false,
    desiredRead: 0,
    ackAttemptAt: 0,
    toastTimer: 0,
    toast: null,
    errorText: '',
    dom: null
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, label) {
    var node = el('button', className, text);
    node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    return node;
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function errorText(err) {
    if (!err) return '请求失败，请稍后再试。';
    if (err.timeout) return '请求超时（8 秒），请检查连接后重试。';
    if (err.status === 409) return '鲸鲸正忙，或聊天状态已变化，请刷新后再试。';
    if (err.status === 401 || err.status === 403) return '当前窗口没有私聊权限。';
    if (err.status) return '请求失败（' + err.status + '）：' + text(err.message);
    return '网络连接中断，请检查本地服务是否仍在运行。';
  }

  async function requestJson(path, options) {
    var opts = options || {};
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    var headers = { 'X-Workroom-Client': '1' };
    var init = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: headers,
      signal: controller.signal,
      cache: 'no-store'
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    try {
      var response = await fetch(path, init);
      var data = null;
      try {
        data = await response.json();
      } catch (parseError) {
        data = null;
      }
      if (!response.ok) {
        var error = new Error(data && data.error ? String(data.error) : 'HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }
      if (!data || typeof data !== 'object') {
        throw new Error('服务返回了无法识别的数据');
      }
      return data;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        var timeout = new Error('请求超时');
        timeout.timeout = true;
        throw timeout;
      }
      throw err;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function visibleReading() {
    return S.open && document.visibilityState !== 'hidden' &&
      (typeof document.hasFocus !== 'function' || document.hasFocus());
  }

  function dismissNotice() {
    if (S.toastTimer) window.clearTimeout(S.toastTimer);
    S.toastTimer = 0;
    if (S.toast) S.toast.remove();
    S.toast = null;
  }

  function notifyInbox(latest) {
    var wrap = document.getElementById('toastWrap');
    if (!wrap) return;
    dismissNotice();
    var notice = button('wr-private-notice', '', '鲸鲸发来了新消息，点击查看');
    notice.appendChild(el('b', '', '鲸鲸来找你啦'));
    notice.appendChild(el('span', '', text(latest.text).slice(0, 72)));
    notice.addEventListener('click', function () {
      dismissNotice();
      if (!S.open) openChat();
      else {
        if (S.messageList) S.messageList.scrollToEnd();
        S.dom.input.focus();
        queueReadAck();
      }
    });
    wrap.appendChild(notice);
    S.toast = notice;
    S.toastTimer = window.setTimeout(dismissNotice, 8000);
  }

  async function notifyNativeInbox(latest) {
    var bridge = window.chrome && window.chrome.webview;
    var id = latest && Number(latest.id);
    if (!bridge || typeof bridge.postMessage !== 'function' || !latest || latest.kind !== 'proactive' ||
        !Number.isSafeInteger(id) || id <= 0 || S.disposed || !S.proactiveEnabled || S.proactiveChanging ||
        !S.unread || id <= S.readThrough || (visibleReading() && nearBottom())) return;
    var epoch = S.epoch;
    var generation = S.generation;
    try {
      // 本地事务先认领；普通浏览器不认领，重启或多个窗口不会重复系统提醒。
      var result = await requestJson(API + '/notifications', { method: 'POST', body: { id: id } });
      if (result.claimed !== true || S.disposed || epoch !== S.epoch || generation !== S.generation ||
          S.latestInboxId !== id || !S.proactiveEnabled || S.proactiveChanging || !S.unread ||
          id <= S.readThrough || (visibleReading() && nearBottom())) return;
      var preview = text(latest.text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
      // 避免在UTF-16代理对中间截断表情；宿主仍会独立校验长度和控制字符。
      preview = preview.replace(/[\uD800-\uDBFF]$/, '');
      bridge.postMessage({ type: 'workroom.privateChatNotification', id: id,
        text: preview || '鲸鲸发来一条新消息。' });
    } catch (err) {
      // 系统通知为尽力提醒；失败不重发聊天、不中断既有居中消息与未读计数。
    }
  }

  function syncInboxUI() {
    if (!S.dom) return;
    if (S.dom.unread) {
      S.dom.unread.hidden = S.unread === 0;
      S.dom.unread.textContent = S.unread > 99 ? '99+' : String(S.unread);
    }
    if (S.entry) S.entry.setAttribute('aria-label', '和鲸鲸单独聊聊' + (S.unread ? '，' + S.unread + '条未读消息' : ''));
    if (S.dom.proactive) {
      S.dom.proactive.setAttribute('aria-checked', S.proactiveEnabled ? 'true' : 'false');
      S.dom.proactive.disabled = S.proactiveChanging;
      S.dom.proactiveState.textContent = S.proactiveEnabled ? '已开启' : '已关闭';
    }
  }

  function applyInbox(raw, serial) {
    if (!raw || typeof raw !== 'object' || serial < S.inboxApplied) return;
    S.inboxApplied = serial;
    if (!S.proactiveChanging && serial > S.preferenceBarrier && typeof raw.enabled === 'boolean') S.proactiveEnabled = raw.enabled;
    var read = Number(raw.readThrough);
    if (Number.isSafeInteger(read) && read >= S.readThrough) {
      S.readThrough = read;
      var unread = Number(raw.unread);
      S.unread = Number.isSafeInteger(unread) ? Math.max(0, unread) : 0;
    }
    syncInboxUI();
    var latest = raw.latest;
    S.latestInboxId = latest && Number.isSafeInteger(Number(latest.id)) ? Number(latest.id) : 0;
    if (S.unread && latest && Number.isSafeInteger(Number(latest.id)) &&
        Number(latest.id) > Math.max(S.readThrough, S.notifiedId)) {
      S.notifiedId = Number(latest.id);
      if (!(visibleReading() && nearBottom())) {
        notifyInbox(latest);
        notifyNativeInbox(latest);
      }
    }
    if (!S.unread) dismissNotice();
    queueReadAck();
  }

  function scheduleInbox() {
    if (S.inboxTimer) window.clearTimeout(S.inboxTimer);
    if (!S.disposed) S.inboxTimer = window.setTimeout(pollInbox, INBOX_MS);
  }

  async function pollInbox() {
    S.inboxTimer = 0;
    if (S.disposed || S.inboxInFlight) return;
    S.inboxInFlight = true;
    var serial = ++S.inboxSerial;
    try {
      var data = await requestJson(API + '/inbox');
      if (!S.disposed) applyInbox(data, serial);
    } catch (err) {
      // 收件箱只读失败保持上次状态；不产生模型调用或自动重发。
    } finally {
      S.inboxInFlight = false;
      scheduleInbox();
    }
  }

  function markActivity(force) {
    if (!S.open || S.disposed) return;
    if (!force && Date.now() - S.lastActiveAt < 30000) return;
    S.lastActiveAt = Date.now();
    if (S.activityInFlight) S.activityQueued = true;
    else postActivity(true);
  }

  function queueReadAck() {
    if (!visibleReading() || !nearBottom() || !S.messages.length || S.clearing) return;
    var epoch = S.epoch;
    window.requestAnimationFrame(function () {
      if (!isCurrent(epoch) || !visibleReading() || !nearBottom() || !S.messages.length || S.clearing) return;
      var latest = readableMessageId();
      if (latest <= S.readThrough) return;
      S.desiredRead = Math.max(S.desiredRead, latest);
      if (!S.activityInFlight && Date.now() - S.ackAttemptAt >= 5000) postActivity(false);
    });
  }

  async function postActivity(active) {
    if (S.disposed) return;
    S.activityInFlight = true;
    S.ackAttemptAt = Date.now();
    var target = Math.min(S.desiredRead, readableMessageId());
    var serial = ++S.inboxSerial;
    try {
      var data = await requestJson(API + '/activity', {
        method: 'POST', body: { active: !!active, readThrough: target }
      });
      if (!S.disposed) applyInbox(data, serial);
    } catch (err) {
      // 活跃/已读信号失败不会重发聊天，后续用户活动或只读轮询再同步。
    } finally {
      S.activityInFlight = false;
      var queued = S.activityQueued;
      S.activityQueued = false;
      if (!S.disposed && queued) postActivity(true);
      else if (!S.disposed && S.desiredRead > Math.max(target, S.readThrough)) queueReadAck();
    }
  }

  async function toggleProactive() {
    if (S.proactiveChanging) return;
    var desired = !S.proactiveEnabled;
    S.proactiveChanging = true;
    syncInboxUI();
    var serial = ++S.inboxSerial;
    try {
      var data = await requestJson(API + '/proactive', { method: 'POST', body: { enabled: desired } });
      // 忽略切换完成前已在途的旧偏好响应；后续新读取再同步真实状态。
      S.preferenceBarrier = S.inboxSerial;
      if (typeof data.enabled === 'boolean') S.proactiveEnabled = data.enabled;
      S.proactiveChanging = false;
      applyInbox(data, serial);
    } catch (err) {
      setError(errorText(err));
    } finally {
      S.proactiveChanging = false;
      syncInboxUI();
    }
  }

  function makeRequestId() {
    var cryptoApi = window.crypto || window.msCrypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
      throw new Error('当前窗口无法生成安全请求编号');
    }
    var bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return out;
  }

  function normalizeMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var id = Number(raw.id);
    if (!Number.isFinite(id)) return null;
    var role = raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : '';
    if (!role) return null;
    return {
      id: id,
      role: role,
      text: text(raw.text),
      time: text(raw.time),
      sticker: raw.sticker === null || raw.sticker === undefined ? null : String(raw.sticker),
      requestId: /^[0-9a-f]{32}$/.test(text(raw.requestId)) ? String(raw.requestId) : '',
      requestStatus: ['queued', 'running', 'delivering', 'done', 'error', 'cancelled'].includes(raw.requestStatus) ? raw.requestStatus : '',
      error: text(raw.error),
      errorCode: text(raw.errorCode)
    };
  }

  function normalizeMessages(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var message = normalizeMessage(raw[i]);
      if (message) out.push(message);
    }
    return out;
  }

  function normalizePending(raw) {
    if (!raw || typeof raw !== 'object' || !raw.id) return null;
    return {
      id: String(raw.id),
      status: 'running',
      kind: raw.kind === 'proactive' ? 'proactive' : 'user'
    };
  }

  function normalizeMemory(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var count = Number(raw.count);
    return {
      count: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
      workCount: Number.isFinite(Number(raw.workCount)) ? Math.max(0, Math.floor(Number(raw.workCount))) : 0,
      chatCount: Number.isFinite(Number(raw.chatCount)) ? Math.max(0, Math.floor(Number(raw.chatCount))) : 0
    };
  }

  function mergeMessages(incoming, preserveExisting) {
    var byId = new Map();
    var i;
    for (i = 0; i < S.messages.length; i++) byId.set(String(S.messages[i].id), S.messages[i]);
    for (i = 0; i < incoming.length; i++) {
      if (!preserveExisting || !byId.has(String(incoming[i].id))) byId.set(String(incoming[i].id), incoming[i]);
    }
    S.messages = Array.from(byId.values()).sort(function (a, b) { return a.id - b.id; });
    reconcileEchoes(incoming);
  }

  // 展示节奏与磁盘消息分离；只延后新助手气泡，不阻塞发送或改写服务端状态。
  function resetReveals() {
    if (S.revealTimer) window.clearTimeout(S.revealTimer);
    S.revealTimer = 0;
    S.revealIds.clear();
    S.lastRevealAt = 0;
    S.revealGap = 0;
    S.listSignature = '';
  }

  function markRevealed(message) {
    S.lastRevealAt = Date.now();
    S.revealGap = Math.min(3200, 1600 + message.text.length * 20);
  }

  function stageReveals(incoming, immediate) {
    if (immediate || !S.open || document.visibilityState === 'hidden') {
      resetReveals();
      return;
    }
    var latest = S.messages.length ? S.messages[S.messages.length - 1].id : 0;
    incoming.filter(function (message) { return message.role === 'assistant' && message.id > latest; })
      .sort(function (a, b) { return a.id - b.id; })
      .forEach(function (message) {
        if (!S.revealIds.size && Date.now() - S.lastRevealAt >= S.revealGap) markRevealed(message);
        else S.revealIds.add(message.id);
      });
  }

  function readableMessageId() {
    var latest = 0;
    for (var i = 0; i < S.messages.length; i++) {
      if (S.revealIds.has(S.messages[i].id)) break;
      latest = S.messages[i].id;
    }
    return latest;
  }

  function scheduleReveal() {
    if (S.revealTimer || !S.revealIds.size || !S.open || S.clearing || S.disposed) return;
    var epoch = S.epoch, generation = S.generation;
    var timer = window.setTimeout(function () {
      if (S.revealTimer !== timer) return;
      S.revealTimer = 0;
      if (!isCurrent(epoch) || S.generation !== generation || !S.open || S.clearing || S.disposed) return;
      if (document.visibilityState === 'hidden') {
        resetReveals();
        return;
      }
      var message = S.messages.find(function (item) { return S.revealIds.has(item.id); });
      if (!message) { resetReveals(); return; }
      S.revealIds.delete(message.id);
      markRevealed(message);
      // 每次只放出一条，再从实际展示时刻计时；后台定时器延迟也不能集中追赶。
      renderMessages({ force: true, reset: false, notifyNew: true });
      queueReadAck();
      scheduleReveal();
    }, Math.max(0, S.lastRevealAt + S.revealGap - Date.now()));
    S.revealTimer = timer;
  }

  function messageKey(message) {
    return message.role === 'user' && message.requestId ? 'request:' + message.requestId : 'message:' + String(message.id);
  }

  function findServerMessage(requestId) {
    return S.messages.find(function (message) { return message.role === 'user' && message.requestId === requestId; });
  }

  function reconcileEchoes(incoming) {
    incoming.forEach(function (message) {
      if (message.role !== 'user' || !message.requestId) return;
      S.localEchoes.delete(message.requestId);
      // 旧的error快照不能覆盖正在重试；一旦服务确认接受或完成，以磁盘状态为准。
      if (message.requestStatus && message.requestStatus !== 'error') S.requestOverrides.delete(message.requestId);
    });
  }

  function displayedMessages() {
    var rows = S.messages.filter(function (message) { return !S.revealIds.has(message.id); });
    S.localEchoes.forEach(function (message) { rows.push(message); });
    rows.sort(function (a, b) {
      if (!a.local && !b.local) return a.id - b.id;
      var byTime = Date.parse(a.time) - Date.parse(b.time);
      return Number.isFinite(byTime) && byTime !== 0 ? byTime : (a.echoSequence || 0) - (b.echoSequence || 0);
    });
    S.deliveryByRequest.clear();
    rows.forEach(function (message) {
      if (message.role === 'user' && message.requestId) S.deliveryByRequest.set(message.requestId, message);
    });
    return rows;
  }

  function hasUnconfirmedSends() {
    return S.localEchoes.size > 0 || S.postQueue.length > 0 || S.posting || S.requestOverrides.size > 0;
  }

  function deliveryPresentation(message) {
    var pending = S.requestOverrides.get(message.requestId);
    var state = pending ? pending.clientState : message.local ? message.clientState : message.requestStatus;
    if (state === 'queued-local' || state === 'sending') return null;
    if (state === 'accepted' || state === 'queued') return null;
    if (state === 'running' || state === 'delivering') return null;
    if (state === 'failed') return { label: '发送失败', error: true, retry: true };
    if (state === 'unknown') return { label: '结果待确认', error: true, retry: true };
    if (state === 'error') return { label: '这条没回上', error: true, retry: true };
    if (state === 'cancelled') return { label: '已停止', error: true, retry: false };
    return null;
  }

  function syncMessageDelivery(article, message) {
    var delivery = article._wrDelivery;
    if (!delivery) return;
    var state = deliveryPresentation(message);
    delivery.row.hidden = !state;
    delivery.row.className = 'wr-private-delivery' + (state && state.error ? ' is-error' : ' is-pending');
    var label = state ? state.label : '';
    if (delivery.label.textContent !== label) delivery.label.textContent = label;
    delivery.retry.hidden = !(state && state.retry);
    delivery.retry.disabled = S.clearing || !S.configured;
    if (article._wrTime) article._wrTime.textContent = displayTime(message.time);
    article.setAttribute('data-message-id', String(message.id));
  }

  function syncDeliveryNodes() {
    S.deliveryFrame = 0;
    if (S.disposed || !S.dom || !S.dom.list || typeof S.dom.list.querySelectorAll !== 'function') return;
    S.dom.list.querySelectorAll('.wr-private-msg[data-request-id]').forEach(function (article) {
      var message = S.deliveryByRequest.get(article.getAttribute('data-request-id'));
      if (message) syncMessageDelivery(article, message);
    });
  }

  function scheduleDeliverySync() {
    if (!S.deliveryFrame && !S.disposed) S.deliveryFrame = window.requestAnimationFrame(syncDeliveryNodes);
  }

  function discardLocalGeneration() {
    resetReveals();
    S.localEchoes.clear();
    S.requestOverrides.clear();
    S.postQueue.splice(0).forEach(function (operation) { operation.finish(false); });
  }

  function syncError() {
    if (!S.dom) return;
    var box = S.dom.error;
    if (S.errorText) {
      box.textContent = S.errorText;
      box.hidden = false;
    } else {
      box.textContent = '';
      box.hidden = true;
    }
  }

  function setError(value) {
    S.refreshError = '';
    S.errorText = value ? String(value) : '';
    syncError();
  }

  function pendingActive() {
    return !!(S.pending && S.pending.status === 'running');
  }

  function userPending() {
    return pendingActive() && S.pending.kind !== 'proactive';
  }

  function canSend() {
    if (!S.open || !S.configured || !S.generation || S.loadingInitial || S.clearing || S.localEchoes.size >= 20) {
      return false;
    }
    var value = S.dom ? S.dom.input.value.trim() : '';
    return value.length > 0 && value.length <= MAX_TEXT;
  }

  function updateComposer() {
    if (!S.dom) return;
    var pending = pendingActive() || S.revealIds.size > 0;
    var blocking = userPending();
    S.dom.send.disabled = !canSend();
    S.dom.send.textContent = '发送';
    S.dom.send.setAttribute('aria-busy', S.sending || pending ? 'true' : 'false');
    S.dom.clear.disabled = !S.open || !S.messages.length || !S.revision || S.loadingInitial ||
      S.loadingOlder || hasUnconfirmedSends() || S.clearing || blocking;
    if (S.dom.dialogConfirm) {
      S.dom.dialogConfirm.disabled = blocking || S.loadingInitial || S.loadingOlder || hasUnconfirmedSends() || S.clearing;
    }
    S.dom.typing.textContent = pending ? '对方正在输入中…' : '鲸鲸';
    S.dom.input.disabled = !S.configured;
    S.dom.status.textContent = S.configured ? '' : '私聊模型尚未配置';
    S.dom.spinner.hidden = true;
    S.dom.statusRow.hidden = !S.dom.status.textContent && S.dom.jump.hidden;
    S.dom.empty.hidden = S.messages.length > 0 || S.localEchoes.size > 0;
    syncError();
    syncDeliveryNodes();
  }

  function displayTime(value) {
    var date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return text(value).slice(0, 5);
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  function renderMarkdown(container, source, messageId, expanded) {
    container.textContent = '';
    var md = window.WorkroomMarkdown;
    if (!md || typeof md.render !== 'function') {
      var fallback = el('p', '', source);
      fallback.style.whiteSpace = 'pre-wrap';
      container.appendChild(fallback);
      return;
    }
    if (source.length > LONG_TEXT && !expanded) {
      if (typeof md.renderPreview === 'function') {
        md.renderPreview(container, source);
      } else {
        md.render(container, source);
      }
    } else {
      md.render(container, source);
    }
  }

  function safeSticker(stickerId) {
    if (stickerId === null || stickerId === undefined) return null;
    var item = S.catalog.get(String(stickerId));
    if (!item) return null;
    var url = text(item.url);
    if (!STICKER_URL.test(url)) return null;
    return { url: url, title: text(item.title) || '鲸鲸表情' };
  }

  function buildAvatar(message) {
    if (message.role === 'assistant') {
      var avatar = button('wr-private-avatar', '', '查看鲸鲸角色资料');
      if (window.WorkroomAvatars && typeof window.WorkroomAvatars.decorate === 'function') {
        window.WorkroomAvatars.decorate(avatar, 'deepseek');
      }
      return avatar;
    }
    var user = el('div', 'wr-private-avatar wr-private-user-avatar', '你');
    user.setAttribute('aria-label', '你');
    return user;
  }

  function renderMessage(entry) {
    var message = entry && entry.data ? entry.data : entry && entry.message;
    var article = el('article', 'wr-private-msg ' + (message.role === 'assistant' ? 'is-assistant' : 'is-user'));
    article.setAttribute('data-message-id', String(message.id));
    if (message.role === 'user' && message.requestId) article.setAttribute('data-request-id', message.requestId);
    article.appendChild(buildAvatar(message));

    var main = el('div', 'wr-private-main');
    var head = el('div', 'wr-private-meta');
    head.appendChild(el('b', '', message.role === 'assistant' ? '鲸鲸' : '你'));
    if (message.time) {
      article._wrTime = el('time', '', displayTime(message.time));
      head.appendChild(article._wrTime);
    }
    main.appendChild(head);

    var expanded = S.expanded.has(messageKey(message));
    var bubble = el('div', 'wr-private-bubble' + (message.text.length > LONG_TEXT && !expanded ? ' is-collapsed' : ''));
    var body = el('div', 'wr-private-md wr-markdown');
    renderMarkdown(body, message.text, String(message.id), expanded);
    bubble.appendChild(body);

    if (message.text.length > LONG_TEXT) {
      var toggle = button('wr-private-toggle', expanded ? '收起' : '展开全文');
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.addEventListener('click', function () {
        var key = messageKey(message);
        var nextExpanded = !S.expanded.has(key);
        if (nextExpanded) S.expanded.add(key); else S.expanded.delete(key);
        bubble.classList.toggle('is-collapsed', !nextExpanded);
        toggle.textContent = nextExpanded ? '收起' : '展开全文';
        toggle.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
        renderMarkdown(body, message.text, key, nextExpanded);
      });
      bubble.appendChild(toggle);
    }

    var sticker = safeSticker(message.sticker);
    if (sticker) {
      var image = document.createElement('img');
      image.className = 'wr-private-sticker';
      image.src = sticker.url;
      image.alt = sticker.title;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.draggable = false;
      image.addEventListener('error', function () { image.remove(); }, { once: true });
      bubble.appendChild(image);
    }

    main.appendChild(bubble);
    if (message.role === 'user' && message.requestId) {
      var delivery = el('div', 'wr-private-delivery');
      var deliveryLabel = el('span', 'wr-private-delivery-label');
      var retry = button('wr-private-retry', '重试', '重试这条消息');
      delivery.appendChild(deliveryLabel);
      delivery.appendChild(retry);
      main.appendChild(delivery);
      article._wrDelivery = { row: delivery, label: deliveryLabel, retry: retry };
      retry.addEventListener('click', function () { retryMessage(message.requestId); });
      syncMessageDelivery(article, message);
    }
    article.appendChild(main);
    return article;
  }

  function listSignature() {
    var parts = [S.revision];
    var messages = displayedMessages();
    for (var i = 0; i < messages.length; i++) {
      var item = messages[i];
      var state = deliveryPresentation(item);
      parts.push(messageKey(item) + ':' + item.text.length + ':' + (item.sticker || '') + ':' + (state ? state.label : ''));
    }
    return parts.join('|');
  }

  function nearBottom() {
    if (!S.dom) return true;
    var scroller = S.dom.scroller;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
  }

  function showNewMessage() {
    if (!S.dom) return;
    S.dom.jump.hidden = false;
    S.dom.statusRow.hidden = false;
    S.dom.jump.textContent = '有新消息 ↓';
  }

  function renderMessages(options) {
    var opts = options || {};
    if (!S.messageList) return false;
    var signature = listSignature();
    if (!opts.force && signature === S.listSignature && (S.messages.length || S.localEchoes.size)) {
      updateComposer();
      return false;
    }
    var wasNear = nearBottom();
    var entries = displayedMessages().map(function (message) {
      return {
        key: messageKey(message),
        version: text(message.text) + (message.sticker === null ? '' : text(message.sticker)),
        data: message
      };
    });
    S.messageList.setItems(entries, {
      scope: 'private',
      reset: !!opts.reset,
      stickToBottom: !!opts.stickToBottom || (!opts.reset && wasNear)
    });
    S.listSignature = signature;
    scheduleDeliverySync();
    if (opts.notifyNew && !wasNear) showNewMessage();
    updateComposer();
    return true;
  }

  function isCurrent(epoch) {
    return epoch === S.epoch;
  }

  function schedulePoll() {
    if (S.pollTimer) {
      window.clearTimeout(S.pollTimer);
      S.pollTimer = 0;
    }
    if (!S.open || S.clearing) return;
    S.pollTimer = window.setTimeout(pollOnce, POLL_MS);
  }

  function stopPolling() {
    if (S.pollTimer) {
      window.clearTimeout(S.pollTimer);
      S.pollTimer = 0;
    }
  }

  async function pollOnce() {
    S.pollTimer = 0;
    if (!S.open || S.pollInFlight) return;
    if (S.loadingOlder || S.clearing) {
      schedulePoll();
      return;
    }
    S.pollInFlight = true;
    try {
      await refreshSnapshot({ source: 'poll' });
    } catch (err) {
      // 后台 GET 刷新失败不冒充发送失败；后续轮询继续只读重试。
    } finally {
      S.pollInFlight = false;
      if (S.open) schedulePoll();
      else stopPolling();
    }
  }

  function applySnapshot(data, options) {
    var opts = options || {};
    if (!isCurrent(opts.epoch)) return false;

    var incoming = normalizeMessages(data.messages);
    var nextRevision = text(data.revision);
    var nextPending = normalizePending(data.pending);
    var nextMemory = normalizeMemory(data.memory);
    var nextGeneration = text(data.generation);
    var revisionNumber = Number(nextRevision), currentRevision = Number(S.revision);
    var generationNumber = Number(nextGeneration), currentGeneration = Number(S.generation);
    if (S.generation && nextGeneration && Number.isSafeInteger(generationNumber) && Number.isSafeInteger(currentGeneration) && generationNumber < currentGeneration) return false;
    if (nextGeneration === S.generation && S.revision && nextRevision && Number.isSafeInteger(revisionNumber) && Number.isSafeInteger(currentRevision) && revisionNumber < currentRevision) return false;
    var generationChanged = S.generation !== '' && nextGeneration !== '' && nextGeneration !== S.generation;
    S.lastRequest = data.lastRequest || null;
    var changed = opts.force || nextRevision !== S.revision || !S.listSignature;
    var reset = opts.initial && !S.messages.length;
    var externalClear = generationChanged || (S.messages.length > 0 && incoming.length === 0 && nextRevision !== S.revision);

    if (changed) {
      if (externalClear) {
        S.messages = [];
        S.expanded.clear();
        discardLocalGeneration();
        reset = true;
      }
      stageReveals(incoming, opts.initial || externalClear);
      mergeMessages(incoming);
      S.generation = nextGeneration;
      S.revision = nextRevision;
      S.hasMore = data.hasMore === true;
      S.memory = nextMemory;
      S.configured = data.configured === true;
      S.listSignature = '';
      S.pending = nextPending;
      syncSnapshotError(data, incoming);
      renderMessages({
        force: true,
        reset: reset,
        stickToBottom: opts.initial && !S.messages.length ? true : nearBottom(),
        notifyNew: !opts.initial && !reset
      });
    } else {
      S.memory = nextMemory;
      S.configured = data.configured === true;
      var wasPending = pendingActive();
      S.pending = nextPending;
      syncSnapshotError(data, incoming);
      updateComposer();
      if (!wasPending && nextPending) schedulePoll();
    }

    if (data.proactive && typeof data.proactive === 'object') {
      var latestAssistant = incoming.slice().reverse().find(function (message) { return message.role === 'assistant'; });
      applyInbox(Object.assign({}, data.proactive, { latest: data.proactive.latest || latestAssistant || null }), opts.inboxSerial || ++S.inboxSerial);
    }
    applyRequestStates(data.requests || (S.lastRequest ? [S.lastRequest] : []));
    scheduleReveal();
    queueReadAck();
    if (S.open) schedulePoll();
    else stopPolling();
    return true;
  }

  function applyRequestStates(states) {
    if (!Array.isArray(states)) return;
    var changed = false;
    states.forEach(function (row) {
      if (!row || !/^[0-9a-f]{32}$/.test(text(row.id)) || !['queued', 'running', 'delivering', 'done', 'error', 'cancelled'].includes(row.status)) return;
      var message = findServerMessage(String(row.id));
      if (!message) return;
      if (message.requestStatus !== row.status || (row.error !== undefined && message.error !== text(row.error))) {
        message.requestStatus = row.status;
        if (row.error !== undefined) message.error = text(row.error);
        if (row.errorCode !== undefined) message.errorCode = text(row.errorCode);
        changed = true;
      }
      if (row.status !== 'error' && S.requestOverrides.delete(String(row.id))) changed = true;
    });
    if (changed) {
      S.listSignature = '';
      renderMessages({ force: true });
    }
  }

  function syncSnapshotError(data, incoming) {
    var represented = S.messages.some(function (message) { return message.role === 'user' && message.requestStatus === 'error'; });
    if (data.error && !represented) {
      S.snapshotError = text(data.error);
      setError(S.snapshotError);
    } else {
      if (S.snapshotError && S.errorText === S.snapshotError) setError('');
      S.snapshotError = '';
    }
  }

  function refreshSnapshot(options) {
    var opts = options || {};
    if (S.refreshInFlight) return S.refreshInFlight;
    var epoch = opts.epoch === undefined ? S.epoch : opts.epoch;
    if (opts.initial) {
      S.loadingInitial = true;
      updateComposer();
    }
    var task = (async function () {
      var inboxSerial = ++S.inboxSerial;
      try {
        var data = await requestJson(API, { method: 'GET' });
        if (!isCurrent(epoch)) return false;
        var applied = applySnapshot(data, { force: !!opts.force, initial: !!opts.initial, epoch: epoch, inboxSerial: inboxSerial });
        if (applied && S.refreshError && S.errorText === S.refreshError) setError('');
        return applied;
      } catch (err) {
        // 初始加载与鉴权失败需要全局提示；普通后台轮询、POST 后刷新静默重试。
        if (isCurrent(epoch) && (opts.initial || err.status === 401 || err.status === 403)) {
          setError(errorText(err));
          S.refreshError = S.errorText;
        }
        throw err;
      } finally {
        if (isCurrent(epoch) && opts.initial) {
          S.loadingInitial = false;
          updateComposer();
          // 初始加载失败也继续只读轮询，成功返回后清除本次加载错误。
          if (S.open) schedulePoll();
        }
      }
    })();
    S.refreshInFlight = task;
    task.then(function () {
      if (S.refreshInFlight === task) S.refreshInFlight = null;
    }, function () {
      if (S.refreshInFlight === task) S.refreshInFlight = null;
    });
    return task;
  }

  async function loadOlder() {
    if (!S.open || !S.hasMore || S.loadingOlder || S.loadingInitial || S.clearing ||
        !S.messages.length || S.dom.scroller.scrollTop > 80 || S.refreshInFlight) {
      return;
    }
    var oldest = S.messages[0];
    var epoch = S.epoch;
    var generation = S.generation;
    S.loadingOlder = true;
    updateComposer();
    try {
      var data = await requestJson(HISTORY_API + encodeURIComponent(String(oldest.id)), { method: 'GET' });
      if (!isCurrent(epoch)) return;
      if (generation !== S.generation || (data.generation !== undefined && text(data.generation) !== generation)) {
        // 清空前发出的旧分页不能把已清空的消息重新放回界面。
        await refreshSnapshot({ force: true });
        return;
      }
      var older = normalizeMessages(data.messages);
      mergeMessages(older, true);
      S.hasMore = data.hasMore === true;
      S.listSignature = '';
      renderMessages({ force: true, reset: false, stickToBottom: false });
    } catch (err) {
      if (isCurrent(epoch)) setError(errorText(err));
    } finally {
      if (isCurrent(epoch)) {
        S.loadingOlder = false;
        updateComposer();
      }
    }
  }

  function autoSizeInput() {
    if (!S.dom) return;
    var input = S.dom.input;
    input.style.height = 'auto';
    var lineHeight = 21;
    var minHeight = lineHeight * 2 + 20;
    var maxHeight = lineHeight * 5 + 20;
    var next = Math.max(minHeight, Math.min(maxHeight, input.scrollHeight));
    input.style.height = next + 'px';
  }

  async function sendMessage() {
    if (!canSend()) return;
    var content = S.dom.input.value.trim();
    if (!content) return;
    if (content.length > MAX_TEXT) {
      setError('消息不能超过 ' + MAX_TEXT + ' 个字符。');
      return;
    }

    var requestId;
    try {
      requestId = makeRequestId();
    } catch (err) {
      setError(err.message || '无法生成请求编号。');
      return;
    }

    setError('');
    // 点击即回显，网络确认只更新这一条；后续新草稿不再依赖旧请求结果。
    var echo = { id: 'local:' + requestId, requestId: requestId, role: 'user', text: content,
      time: new Date().toISOString(), sticker: null, local: true, clientState: 'queued-local',
      echoSequence: ++S.echoSequence, generation: S.generation };
    S.localEchoes.set(requestId, echo);
    S.dom.input.value = '';
    autoSizeInput();
    S.listSignature = '';
    renderMessages({ force: true, stickToBottom: true });
    return enqueuePost({ type: 'message', id: requestId, text: content, generation: S.generation, epoch: S.epoch });
  }

  function enqueuePost(operation) {
    return new Promise(function (resolve) {
      operation.finish = resolve;
      S.postQueue.push(operation);
      drainPosts();
    });
  }

  function operationCurrent(operation) {
    return !S.disposed && operation.epoch === S.epoch && operation.generation === S.generation;
  }

  function setOperationState(operation, state) {
    var echo = S.localEchoes.get(operation.id);
    if (echo) echo.clientState = state;
    else if (operation.type === 'retry') S.requestOverrides.set(operation.id, { clientState: state });
    S.listSignature = '';
    renderMessages({ force: true });
  }

  async function drainPosts() {
    if (S.posting || S.disposed) return;
    S.posting = true;
    S.sending = true;
    try {
      while (S.postQueue.length && !S.disposed) {
        var operation = S.postQueue.shift();
        if (!operationCurrent(operation)) { operation.finish(false); continue; }
        setOperationState(operation, 'sending');
        try {
          var body = { id: operation.id, generation: operation.generation };
          if (operation.type === 'message') body.text = operation.text;
          var response = await requestJson(API + (operation.type === 'retry' ? '/retry' : '/messages'), { method: 'POST', body: body });
          if (!operationCurrent(operation)) { operation.finish(false); continue; }
          if (!response || response.requestId !== operation.id) throw new Error('消息确认标识不匹配');
          // GET可能先于POST回包确认完成，迟到的202不能把它降回排队状态。
          var confirmed = findServerMessage(operation.id);
          if (!confirmed || (operation.type === 'retry' && confirmed.requestStatus === 'error')) setOperationState(operation, 'accepted');
          if (!S.pending && (!confirmed || ['queued', 'running', 'delivering'].includes(confirmed.requestStatus))) S.pending = { id: operation.id, status: 'running', kind: 'user' };
          updateComposer();
          refreshSnapshot({ force: false }).catch(function () { /* 不自动重发，消息状态留在原位。 */ });
          operation.finish(true);
        } catch (err) {
          if (operationCurrent(operation)) {
            // 已被GET确认的消息以服务端为准；否则保留本地原文和原幂等ID供手动重试。
            var known = findServerMessage(operation.id);
            if (!known || operation.type === 'retry' && known.requestStatus === 'error') {
              setOperationState(operation, err.status ? 'failed' : 'unknown');
            }
            refreshSnapshot({ force: false }).catch(function () { /* 服务暂不可用仍保留气泡。 */ });
          }
          operation.finish(false);
        }
      }
    } finally {
      S.posting = false;
      S.sending = false;
      updateComposer();
      if (S.open) schedulePoll();
    }
  }

  function retryMessage(requestId) {
    if (!S.open || !S.configured || S.clearing || !S.generation) return Promise.resolve(false);
    var echo = S.localEchoes.get(requestId);
    if (echo) {
      if (echo.clientState !== 'failed' && echo.clientState !== 'unknown') return Promise.resolve(false);
      echo.clientState = 'queued-local';
      S.listSignature = '';
      renderMessages({ force: true });
      return enqueuePost({ type: 'message', id: requestId, text: echo.text, generation: S.generation, epoch: S.epoch });
    }
    var message = findServerMessage(requestId);
    var state = message && deliveryPresentation(message);
    if (!message || !state || !state.retry || S.requestOverrides.get(requestId) && !['failed', 'unknown'].includes(S.requestOverrides.get(requestId).clientState)) return Promise.resolve(false);
    S.requestOverrides.set(requestId, { clientState: 'queued-local' });
    S.listSignature = '';
    renderMessages({ force: true });
    return enqueuePost({ type: 'retry', id: requestId, generation: S.generation, epoch: S.epoch });
  }

  function menuIsOpen() {
    return !!(S.dom && S.dom.menu && !S.dom.menu.hidden);
  }

  function setMenuOpen(open, options) {
    if (!S.dom || !S.dom.menu || !S.dom.menuToggle) return;
    S.dom.menu.hidden = !open;
    S.dom.menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open && options && options.restoreFocus) S.dom.menuToggle.focus();
  }

  function openMenu() {
    if (!S.dom || !S.open) return;
    setMenuOpen(true);
    if (S.dom.proactive && !S.dom.proactive.disabled) S.dom.proactive.focus();
    else if (S.dom.clear && !S.dom.clear.disabled) S.dom.clear.focus();
  }

  function closeMenu(options) {
    if (!S.dom || !S.dom.menu || S.dom.menu.hidden) return;
    setMenuOpen(false, options);
  }

  function showClearDialog() {
    if (!S.dom || S.dom.clear.disabled || S.dom.dialog.open) return;
    closeMenu();
    S.clearRevision = S.revision;
    if (typeof S.dom.dialog.showModal === 'function') S.dom.dialog.showModal();
    else S.dom.dialog.setAttribute('open', '');
    S.dom.dialogCancel.focus();
  }

  function closeClearDialog() {
    if (S.dom && S.dom.dialog.open && typeof S.dom.dialog.close === 'function') {
      S.dom.dialog.close();
    }
  }

  async function confirmClear() {
    if (!S.open || S.clearing || hasUnconfirmedSends() || userPending() || !S.revision) return;
    var clearRevision = S.clearRevision;
    closeClearDialog();
    var epoch = ++S.epoch;
    resetReveals();
    S.clearing = true;
    stopPolling();
    setError('');
    updateComposer();

    try {
      if (S.refreshInFlight) {
        try { await S.refreshInFlight; } catch (oldError) { /* 旧请求结果已按 epoch 丢弃。 */ }
      }
      if (!isCurrent(epoch)) return;
      await requestJson(API, { method: 'DELETE', body: { revision: clearRevision } });
      if (!isCurrent(epoch)) return;
      S.messages = [];
      discardLocalGeneration();
      S.expanded.clear();
      S.revision = '';
      S.hasMore = false;
      S.pending = null;
      S.listSignature = '';
      S.messageList.setItems([], { scope: 'private', reset: true });
      setError('聊天记录已清空，鲸鲸的本地记忆仍保留。');
      updateComposer();
      try {
        await refreshSnapshot({ force: true, epoch: epoch });
      } catch (refreshError) {
        setError('聊天记录已清空，但刷新状态失败，请关闭后重新打开。');
      }
    } catch (err) {
      if (!isCurrent(epoch)) return;
      setError(err.status === 409
        ? '聊天状态已更新，请刷新后重新确认清空。'
        : errorText(err) + ' 聊天记录未清空。');
      try {
        await refreshSnapshot({ force: true, epoch: epoch });
      } catch (refreshError) {
        // 保留原始错误提示。
      }
    } finally {
      if (isCurrent(epoch)) {
        S.clearing = false;
        updateComposer();
        if (S.open && pendingActive()) schedulePoll();
      }
    }
  }

  function openChat() {
    if (!S.section || S.open) return;
    S.open = true;
    markActivity(true);
    dismissNotice();
    S.section.hidden = false;
    if (S.app) S.app.classList.add('private-chat-open');
    if (S.entry) S.entry.setAttribute('aria-expanded', 'true');
    updateComposer();
    if (S.dom) {
      S.dom.input.focus();
      S.dom.scroller.scrollTop = S.dom.scroller.scrollHeight;
    }
    refreshSnapshot({ initial: true }).then(function () {
      if (S.open) {
        if (S.messageList) S.messageList.scrollToEnd();
        queueReadAck();
        schedulePoll();
      }
    }).catch(function () {
      // 初始加载错误已提示；后台 GET 失败静默，由后续轮询继续恢复。
    });
  }

  function closeChat() {
    if (!S.section || !S.open) return;
    closeMenu();
    closeClearDialog();
    stopPolling();
    S.open = false;
    resetReveals();
    S.section.hidden = true;
    if (S.app) S.app.classList.remove('private-chat-open');
    if (S.entry) {
      S.entry.setAttribute('aria-expanded', 'false');
      S.entry.focus();
    }
  }

  function onEscape(ev) {
    if (ev.key !== 'Escape' || !S.open) return;
    if (document.querySelector('dialog[open]') && !S.dom.dialog.open) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
    if (S.dom && S.dom.dialog.open) {
      closeClearDialog();
      if (S.dom.menuToggle) S.dom.menuToggle.focus();
      return;
    }
    if (menuIsOpen()) {
      closeMenu({ restoreFocus: true });
      return;
    }
    closeChat();
  }

  function buildDom() {
    var section = S.section;
    var dom = {};

    var header = el('header', 'wr-private-header');
    dom.back = button('wr-private-icon-btn', '←', '关闭私聊');
    var heading = el('div', 'wr-private-heading');
    var titleRow = el('div', 'wr-private-title-row');
    dom.typing = el('p', 'wr-private-typing', '鲸鲸');
    dom.typing.setAttribute('aria-live', 'polite');
    titleRow.appendChild(dom.typing);
    heading.appendChild(titleRow);
    dom.menuToggle = button('wr-private-icon-btn wr-private-menu-toggle', '⋮', '更多操作');
    dom.menuToggle.setAttribute('aria-haspopup', 'menu');
    dom.menuToggle.setAttribute('aria-expanded', 'false');
    dom.menuToggle.setAttribute('aria-controls', 'privateChatMenu');
    dom.menu = el('div', 'wr-private-menu');
    dom.menu.id = 'privateChatMenu';
    dom.menu.setAttribute('role', 'menu');
    dom.menu.setAttribute('aria-label', '私聊操作');
    dom.menu.hidden = true;
    dom.proactive = button('wr-private-menu-item wr-private-proactive', '', '主动找我');
    dom.proactive.setAttribute('role', 'menuitemcheckbox');
    dom.proactive.setAttribute('aria-checked', 'true');
    dom.proactive.appendChild(el('span', '', '主动找我'));
    dom.proactiveState = el('span', 'wr-private-menu-state', '已开启');
    dom.proactive.appendChild(dom.proactiveState);
    dom.menu.appendChild(dom.proactive);
    dom.menu.appendChild(el('p', 'wr-private-menu-note', '闲时来聊，遵循系统勿扰'));
    dom.clear = button('wr-private-menu-item is-danger', '清空聊天记录', '清空聊天记录');
    dom.clear.setAttribute('role', 'menuitem');
    dom.menu.appendChild(dom.clear);
    header.appendChild(dom.back);
    header.appendChild(heading);
    header.appendChild(dom.menuToggle);
    header.appendChild(dom.menu);

    var stage = el('div', 'wr-private-stage');
    dom.scroller = el('div', 'wr-private-scroller');
    dom.scroller.setAttribute('role', 'log');
    dom.scroller.setAttribute('aria-label', '你与鲸鲸的私聊消息');
    dom.list = el('div', 'wr-private-list');
    dom.scroller.appendChild(dom.list);

    dom.empty = el('div', 'wr-private-empty');
    dom.empty.appendChild(el('p', 'wr-private-hello', '嗨，我是鲸鲸。今天也在认真搬砖，偶尔摸鱼。想聊点什么？'));
    var quick = el('div', 'wr-private-quick');
    [
      '今天龙龙给你安排了什么？',
      '午饭吃了大白饭吗？',
      '现在在忙什么？'
    ].forEach(function (prompt) {
      var quickButton = button('wr-private-quick-btn', prompt);
      quickButton.addEventListener('click', function () {
        if (!S.dom) return;
        markActivity(false);
        S.dom.input.value = prompt;
        autoSizeInput();
        S.dom.input.focus();
        updateComposer();
      });
      quick.appendChild(quickButton);
    });
    dom.empty.appendChild(quick);
    stage.appendChild(dom.scroller);
    stage.appendChild(dom.empty);

    var composer = el('div', 'wr-private-composer');
    var statusRow = el('div', 'wr-private-status-row');
    dom.spinner = el('span', 'wr-private-spinner');
    dom.spinner.setAttribute('aria-hidden', 'true');
    dom.spinner.hidden = true;
    dom.status = el('span', 'wr-private-status');
    dom.status.setAttribute('aria-live', 'polite');
    dom.jump = button('wr-private-jump', '有新消息 ↓');
    dom.jump.hidden = true;
    statusRow.appendChild(dom.spinner);
    statusRow.appendChild(dom.status);
    statusRow.appendChild(dom.jump);
    dom.statusRow = statusRow;
    composer.appendChild(statusRow);

    dom.error = el('p', 'wr-private-error');
    dom.error.setAttribute('role', 'alert');
    dom.error.hidden = true;
    composer.appendChild(dom.error);

    var row = el('div', 'wr-private-input-row');
    dom.input = document.createElement('textarea');
    dom.input.className = 'wr-private-input';
    dom.input.rows = 2;
    dom.input.maxLength = MAX_TEXT;
    dom.input.placeholder = '和鲸鲸说点什么…';
    dom.input.setAttribute('aria-label', '私聊消息');
    dom.input.autocomplete = 'off';
    dom.send = button('wr-private-send', '发送');
    dom.send.disabled = true;
    row.appendChild(dom.input);
    row.appendChild(dom.send);
    composer.appendChild(row);

    var dialog = document.createElement('dialog');
    dialog.className = 'wr-private-dialog';
    dialog.setAttribute('aria-labelledby', 'privateChatClearTitle');
    var dialogTitle = el('h3', '', '清空聊天记录？');
    dialogTitle.id = 'privateChatClearTitle';
    dialog.appendChild(dialogTitle);
    dialog.appendChild(el('p', '', '鲸鲸的本地记忆会保留。'));
    var dialogActions = el('div', 'wr-private-dialog-actions');
    dom.dialogCancel = button('wr-private-dialog-btn', '取消');
    var dialogConfirm = button('wr-private-dialog-btn is-danger', '确认清空');
    dialogActions.appendChild(dom.dialogCancel);
    dialogActions.appendChild(dialogConfirm);
    dialog.appendChild(dialogActions);
    dom.dialog = dialog;
    dom.dialogConfirm = dialogConfirm;

    section.appendChild(header);
    section.appendChild(stage);
    section.appendChild(composer);
    section.appendChild(dialog);
    S.dom = dom;
    dom.unread = el('span', 'wr-private-unread', '');
    dom.unread.hidden = true;
    dom.unread.setAttribute('aria-hidden', 'true');
    if (S.entry) S.entry.insertBefore(dom.unread, S.entry.lastElementChild);
    syncInboxUI();

    if (window.WorkroomMessageList && typeof window.WorkroomMessageList.create === 'function') {
      S.messageList = window.WorkroomMessageList.create({
        scroller: dom.scroller,
        list: dom.list,
        overscan: 400,
        maxMounted: 48,
        cacheSize: 64,
        renderItem: renderMessage
      });
      if (typeof window.MutationObserver === 'function') {
        S.deliveryObserver = new window.MutationObserver(scheduleDeliverySync);
        S.deliveryObserver.observe(dom.list, { childList: true });
      }
    } else {
      setError('消息列表组件未加载，暂时无法显示私聊。');
    }

    dom.back.addEventListener('click', closeChat);
    dom.send.addEventListener('click', sendMessage);
    dom.menuToggle.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (menuIsOpen()) closeMenu({ restoreFocus: true });
      else openMenu();
    });
    dom.proactive.addEventListener('click', toggleProactive);
    dom.menu.addEventListener('keydown', function (ev) {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) return;
      var items = [dom.proactive, dom.clear].filter(function (item) { return !item.disabled; });
      if (!items.length) return;
      ev.preventDefault();
      var index = items.indexOf(document.activeElement);
      if (ev.key === 'Home') index = 0;
      else if (ev.key === 'End') index = items.length - 1;
      else index = (index + (ev.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[index].focus();
    });
    dom.clear.addEventListener('click', function () {
      closeMenu();
      showClearDialog();
    });
    document.addEventListener('click', function (ev) {
      if (!menuIsOpen()) return;
      if (dom.menu.contains(ev.target) || dom.menuToggle.contains(ev.target)) return;
      closeMenu();
    });
    dom.dialogCancel.addEventListener('click', closeClearDialog);
    dom.dialogConfirm.addEventListener('click', confirmClear);
    dom.jump.addEventListener('click', function () {
      if (S.messageList) S.messageList.scrollToEnd();
      else dom.scroller.scrollTop = dom.scroller.scrollHeight;
      dom.jump.hidden = true;
      queueReadAck();
    });
    dom.input.addEventListener('input', function () {
      markActivity(false);
      autoSizeInput();
      updateComposer();
    });
    dom.input.addEventListener('compositionstart', function () { dom.input.dataset.composing = '1'; });
    dom.input.addEventListener('compositionend', function () {
      delete dom.input.dataset.composing;
      autoSizeInput();
      updateComposer();
    });
    dom.input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing || dom.input.dataset.composing === '1') return;
      ev.preventDefault();
      sendMessage();
    });
    dom.scroller.addEventListener('scroll', function () {
      if (nearBottom()) dom.jump.hidden = true;
      queueReadAck();
      if (dom.scroller.scrollTop < 80) loadOlder();
    });
    dom.scroller.addEventListener('wheel', function () { markActivity(false); }, { passive: true });
    dom.scroller.addEventListener('pointerdown', function () { markActivity(false); }, { passive: true });
    dialog.addEventListener('cancel', function (ev) {
      if (S.clearing) ev.preventDefault();
    });
    dialog.addEventListener('click', function (ev) {
      if (ev.target === dialog && !S.clearing) closeClearDialog();
    });

    autoSizeInput();
    updateComposer();
  }

  function loadStickers() {
    requestJson(STICKERS_API, { method: 'GET' }).then(function (data) {
      var list = data && Array.isArray(data.stickers) ? data.stickers : [];
      list.forEach(function (sticker) {
        if (!sticker || sticker.id === null || sticker.id === undefined) return;
        var id = String(sticker.id);
        var url = text(sticker.url);
        if (!STICKER_URL.test(url)) return;
        S.catalog.set(id, { id: id, title: text(sticker.title), url: url });
      });
      S.catalogLoaded = true;
      var hasSticker = S.messages.some(function (message) { return message.sticker !== null; });
      if (hasSticker && S.messages.length) {
        S.listSignature = '';
        renderMessages({ force: true, reset: false, stickToBottom: nearBottom() });
      }
    }).catch(function () {
      // 表情目录失败不影响文字聊天。
    });
  }

  function init() {
    var section = document.getElementById('privateChat');
    var entry = document.getElementById('btnPrivateChat');
    if (!section || !entry) return;
    S.section = section;
    S.entry = entry;
    S.app = document.getElementById('app') || section.closest('#app');
    entry.setAttribute('aria-expanded', 'false');
    entry.setAttribute('aria-controls', 'privateChat');
    buildDom();
    entry.addEventListener('click', openChat);
    window.addEventListener('workroom-open-private-chat', function () {
      if (S.disposed) return;
      dismissNotice();
      if (!S.open) openChat();
      else {
        if (S.messageList) S.messageList.scrollToEnd();
        S.dom.input.focus();
        queueReadAck();
      }
    });
    window.addEventListener('keydown', onEscape, true);
    window.addEventListener('focus', function () { if (S.open) { markActivity(false); queueReadAck(); } });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') resetReveals();
      else if (S.open) {
        renderMessages({ force: true, reset: false });
        if (visibleReading()) queueReadAck();
      }
    });
    window.addEventListener('pagehide', function () {
      S.disposed = true;
      resetReveals();
      if (S.deliveryObserver) S.deliveryObserver.disconnect();
      S.postQueue.splice(0).forEach(function (operation) { operation.finish(false); });
      stopPolling();
      if (S.inboxTimer) window.clearTimeout(S.inboxTimer);
      dismissNotice();
    });
    loadStickers();
    pollInbox();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
