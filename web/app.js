'use strict';
/* DeepSeek协助工作区 · 本机观察前端
   规则：
   - 只用原生 DOM API，动态内容一律 createElement + textContent，不用 innerHTML / insertAdjacentHTML / eval / new Function。
   - 不生成任何示例（mock）数据；后端返回什么就显示什么，缺失字段显示占位说明。
   - 所有 fetch 使用 credentials:'same-origin' 与 X-Workroom-Client:1。
*/
(function () {
  var POLL_MS = 2000;
  var TIMEOUT_MS = 8000;
  var ROOM_ID = /^[0-9a-f]{32}$/;
  var TEXT_LIMIT = 400;
  var THEME_KEY = 'workroom.theme';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var messageList = null;

  var API = {
    state: '/api/state',
    room: function (id) { return '/api/rooms/' + id; },
    exportRoom: function (id) { return '/api/rooms/' + id + '/export'; }
  };

  var STATUS = {
    running: { st: 'run', text: '运行中' },
    success: { st: 'info', text: '调用完成' },
    failed: { st: 'err', text: '调用失败' },
    timeout: { st: 'warn', text: '调用超时' },
    interrupted: { st: 'warn', text: '任务中断' },
    passed: { st: 'ok', text: '主审通过' },
    changes_requested: { st: 'warn', text: '主审要求修改' },
    information: { st: 'info', text: '主审补充说明' }
  };

  var S = {
    rooms: [], stats: null, privacy: null, revision: '', loaded: false,
    roomId: null, detail: null, detailRevision: '', detailLoaded: false,
    selectedRunId: '', taskFilterSig: '',
    roomQuery: '', roomFilter: 'all', msgQuery: '',
    expandedTools: new Set(), expandedTexts: new Set(),
    renderedKey: '', renderedCount: 0, renderedRoom: null,
    pendingNew: 0, lastRoomRender: 0,
    roomSeq: 0, polling: false, exportBusy: false, deleteBusy: false, deleteTarget: null,
    theme: 'light', themeStored: null,
    isMobile: false, isOverlay: false, layoutInit: false,
    taskPanelOpen: false, view: 'rooms',
    dialogRoomRev: null, onboardDir: null,
    conn: { ok: false, fails: 0, lastOk: 0, lastError: '', kind: 'init' }
  };

  /* ---------------- 基础工具 ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(name, extraCls) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'lv-ic' + (extraCls ? ' ' + extraCls : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function ts(value) {
    var t = Date.parse(value);
    return isFinite(t) ? t : 0;
  }
  function str(value, fallback) {
    return (typeof value === 'string' && value.length) ? value : (fallback || '');
  }
  function num(value) {
    return (typeof value === 'number' && isFinite(value)) ? value : null;
  }
  function fmtNum(value) {
    if (value === null || value === undefined) return '未记录';
    try { return new Intl.NumberFormat('zh-CN').format(value); } catch (e) { return String(value); }
  }
  function fmtClock(value) {
    var t = ts(value);
    if (!t) return '时间未知';
    return new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
  }
  function fmtDateTime(value) {
    var t = ts(value);
    if (!t) return '时间未知';
    return new Date(t).toLocaleString('zh-CN', { hour12: false });
  }
  function fmtRelative(value) {
    var t = ts(value);
    if (!t) return '时间未知';
    var diff = Date.now() - t;
    if (diff < 0) return '时间在未来';
    if (diff < 60000) return '刚刚';
    var m = Math.floor(diff / 60000);
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    var d = Math.floor(h / 24);
    if (d < 30) return d + ' 天前';
    return fmtDateTime(value);
  }
  function fmtDuration(seconds) {
    if (!(typeof seconds === 'number' && isFinite(seconds) && seconds >= 0)) return '未记录';
    if (seconds < 60) return (Math.round(seconds * 10) / 10) + ' 秒';
    var m = Math.floor(seconds / 60);
    var s = Math.round(seconds % 60);
    if (m < 60) return m + ' 分 ' + (s < 10 ? '0' + s : s) + ' 秒';
    var h = Math.floor(m / 60);
    var mm = m % 60;
    return h + ' 小时 ' + (mm < 10 ? '0' + mm : mm) + ' 分';
  }
  function fmtBytes(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '未知大小';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function shortId(value) {
    var v = str(value, '');
    return v ? v.slice(0, 8) : '未记录';
  }
  function debounce(fn, ms) {
    var timer = 0;
    return function () {
      var self = this, args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }
  function reduceMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function statusInfo(raw) {
    var key = str(raw, '');
    if (!key) return { st: 'off', text: '状态未记录' };
    if (STATUS[key]) return STATUS[key];
    return { st: 'off', text: '未知状态：' + key };
  }
  function isRoom(room) {
    return !!room && typeof room === 'object' && ROOM_ID.test(String(room.id || ''));
  }
  function isRun(run) {
    return !!run && typeof run === 'object' && typeof run.id === 'string' && run.id.length > 0;
  }
  function byStartedDesc(a, b) { return ts(b.startedAt) - ts(a.startedAt); }
  function dirText() {
    var dir = S.privacy ? str(S.privacy.dataDirectory, '') : '';
    return dir || '未获取（后端未返回 privacy.dataDirectory）';
  }
  function currentRuns() {
    if (!S.detail || !Array.isArray(S.detail.runs)) return [];
    return S.detail.runs.filter(isRun);
  }
  function roomModel() {
    if (S.detail && S.detail.room && isRoom(S.detail.room)) return S.detail.room;
    var hit = (S.rooms || []).filter(function (r) { return r.id === S.roomId; })[0];
    return hit || null;
  }

  function roomSources(room) {
    var ids = Array.isArray(room.sourceThreadIds) ? room.sourceThreadIds : [];
    return ids.length > 1 ? ids.length + ' 个来源聊天' : str(ids[0] || room.sourceThreadId, '未记录');
  }

  function pill(st, text, extraCls) {
    var node = el('span', 'lv-pill' + (extraCls ? ' ' + extraCls : ''));
    node.setAttribute('data-st', st);
    node.appendChild(el('span', 'lv-dot'));
    node.appendChild(el('span', '', text));
    return node;
  }
  function setPill(pillEl, textEl, st, text) {
    if (pillEl) pillEl.setAttribute('data-st', st);
    if (textEl) textEl.textContent = text;
  }
  function loadingBlock(text) {
    var box = el('div', 'wr-loading');
    box.appendChild(el('span', 'lv-spin wr-spin'));
    box.appendChild(el('span', '', text));
    return box;
  }
  function emptyBlock(title, desc) {
    var box = el('div', 'wr-empty-block');
    box.appendChild(icon('info', 'lv-lg'));
    box.appendChild(el('b', '', title));
    if (desc) box.appendChild(el('p', '', desc));
    return box;
  }
  function kvText(key, text, mono) {
    var row = el('div', 'wr-kv');
    row.appendChild(el('span', 'wr-k', key));
    row.appendChild(el('span', 'wr-v' + (mono ? ' lv-mono' : ''), text));
    return row;
  }
  function kvNode(key, node) {
    var row = el('div', 'wr-kv');
    row.appendChild(el('span', 'wr-k', key));
    var v = el('span', 'wr-v');
    v.appendChild(node);
    row.appendChild(v);
    return row;
  }
  function section(title, iconName, build) {
    var sec = el('section', 'wr-sect');
    var hd = el('h3', 'wr-sect-hd');
    hd.appendChild(icon(iconName, 'lv-sm'));
    hd.appendChild(el('span', '', title));
    sec.appendChild(hd);
    var bd = el('div', 'wr-sect-bd');
    build(bd);
    sec.appendChild(bd);
    return sec;
  }
  function iconBtn(label, name, cls, handler) {
    var b = el('button', cls || 'lv-ibtn');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(icon(name, 'lv-sm'));
    if (handler) b.addEventListener('click', handler);
    return b;
  }

  /* ---------------- 轻提示 ---------------- */
  function toast(kind, title, desc) {
    var wrap = $('#toastWrap');
    if (!wrap) return;
    var box = el('div', 'wr-toast wr-' + kind);
    box.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    var ic = el('span', 'wr-toast-ic');
    ic.appendChild(icon(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'info', 'lv-sm'));
    box.appendChild(ic);
    var body = el('div', 'wr-toast-bd');
    body.appendChild(el('b', '', title));
    if (desc) body.appendChild(el('p', '', desc));
    box.appendChild(body);
    wrap.appendChild(box);
    while (wrap.children.length > 4) wrap.removeChild(wrap.firstChild);
    setTimeout(function () {
      if (box.parentNode) box.parentNode.removeChild(box);
    }, kind === 'err' ? 9000 : 5000);
  }

  /* ---------------- 网络层 ---------------- */
  function httpError(status, bodyText) {
    var msg = '';
    try {
      var parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed.error === 'string') msg = parsed.error;
    } catch (e) { /* 非 JSON 错误体：保留状态码 */ }
    var err = new Error(msg ? msg + '（HTTP ' + status + '）' : 'HTTP ' + status);
    err.status = status;
    return err;
  }

  function request(path, opts) {
    opts = opts || {};
    var controller = ('AbortController' in window) ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : 0;
    var headers = Object.assign({ 'X-Workroom-Client': '1' }, opts.headers || {});
    if (!headers.Accept) headers.Accept = 'application/json';
    var init = { method: opts.method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: headers };
    if (opts.body !== undefined) init.body = opts.body;
    if (controller) init.signal = controller.signal;

    return fetch(path, init).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (txt) {
          throw httpError(res.status, txt);
        }, function () {
          throw httpError(res.status, '');
        });
      }
      if (opts.raw) return res;
      return res.json();
    }).then(function (value) {
      if (timer) clearTimeout(timer);
      return value;
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        var e = new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒内无响应）');
        e.timeout = true;
        throw e;
      }
      throw err;
    });
  }

  function describeError(err) {
    if (!err) return '未知错误';
    if (err.status === 403) return '服务拒绝该请求（HTTP 403）：需要本机首页下发的会话凭据与 X-Workroom-Client 头，请通过本机 127.0.0.1 服务地址打开本页。';
    if (err.timeout) return err.message;
    if (err.status) return '请求失败：' + err.message;
    return '无法连接本机服务：' + (err.message || String(err));
  }

  /* ---------------- 主题 ---------------- */
  function storedTheme() {
    try {
      var v = window.localStorage.getItem(THEME_KEY);
      return (v === 'light' || v === 'dark') ? v : null;
    } catch (e) { return null; }
  }
  function systemTheme() {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
  }
  function applyTheme(theme) {
    S.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-lv-theme', S.theme);
    updateThemeToggle();
  }
  function updateThemeToggle() {
    var b = $('#themeToggle');
    if (!b) return;
    var dark = S.theme === 'dark';
    b.setAttribute('aria-checked', dark ? 'true' : 'false');
    var label = dark ? '切换为浅色主题' : '切换为深色主题';
    b.setAttribute('aria-label', label);
    b.title = label;
    var themeLabel = $('#themeLabel');
    if (themeLabel) themeLabel.textContent = dark ? '浅色模式' : '深色模式';
  }
  function toggleTheme() {
    var next = S.theme === 'dark' ? 'light' : 'dark';
    S.themeStored = next;
    try { window.localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
    applyTheme(next);
    toast('info', '已切换主题', next === 'dark' ? '深色' : '浅色');
  }

  /* ---------------- 状态与渲染 ---------------- */
  function markConn(ok, err) {
    var c = S.conn;
    if (ok) {
      c.ok = true; c.fails = 0; c.lastOk = Date.now(); c.lastError = ''; c.kind = 'ok';
    } else {
      c.ok = false; c.fails += 1;
      c.lastError = describeError(err);
      c.kind = (err && err.status === 403) ? 'auth' : 'err';
    }
  }

  function renderConn() {
    var c = S.conn;
    var pillEl = $('#connPill'), txt = $('#connText'), tm = $('#connTime');
    if (!pillEl) return;
    var st = 'off', text = '正在连接本机服务…';
    if (c.kind === 'ok') { st = 'ok'; text = '实时同步中'; }
    else if (c.kind === 'auth') { st = 'err'; text = '需要客户端授权'; }
    else if (c.kind === 'err') { st = 'err'; text = '连接异常 · 已失败 ' + c.fails + ' 次'; }
    var readState = S.privacy && S.privacy.readStatus ? S.privacy.readStatus.state : '';
    if (c.kind === 'ok' && readState === 'missing') { st = 'warn'; text = '等待协作记录'; }
    if (c.kind === 'ok' && readState === 'error') { st = 'err'; text = '记录读取异常'; }
    pillEl.setAttribute('data-st', st);
    txt.textContent = text;
    tm.textContent = c.lastOk ? fmtClock(new Date(c.lastOk).toISOString()) : '';
    pillEl.title = (c.lastOk ? '最近同步：' + fmtDateTime(new Date(c.lastOk).toISOString()) : '尚未成功同步')
      + (c.lastError ? '；最近错误：' + c.lastError : '');
  }

  function renderSync() {
    renderConn();
    var sync = $('#roomSync');
    if (!sync) return;
    if (!S.roomId) { sync.textContent = '未选择群组'; sync.title = ''; return; }
    if (!S.conn.ok) {
      sync.textContent = S.conn.lastOk
        ? '同步失败（最近成功 ' + fmtClock(new Date(S.conn.lastOk).toISOString()) + '）'
        : '同步失败';
      sync.title = S.conn.lastError || '';
      return;
    }
    sync.textContent = '正在同步协作消息';
    sync.title = '每 2 秒从本机服务读取一次';
  }

  function showError(text) {
    var banner = $('#errorBanner');
    if (!banner) return;
    $('#errorText').textContent = text;
    banner.hidden = false;
  }
  function hideError() {
    var banner = $('#errorBanner');
    if (banner) banner.hidden = true;
  }

  function renderStats() {
    var rooms = S.rooms || [];
    var stats = S.stats || {};
    var running = num(stats.running);
    if (running === null) {
      running = rooms.filter(function (r) { return r.status === 'running'; }).length;
    }
    var runs = num(stats.runs);
    if (runs === null) {
      runs = rooms.reduce(function (acc, r) { return acc + (num(r.runCount) || 0); }, 0);
    }
    var messages = num(stats.messages);
    if (messages === null) {
      messages = rooms.reduce(function (acc, r) { return acc + (num(r.messageCount) || 0); }, 0);
    }
    var roomsCount = num(stats.rooms);
    if (roomsCount === null) roomsCount = rooms.length;
    $('#statRooms').textContent = fmtNum(roomsCount);
    $('#statRuns').textContent = fmtNum(runs);
    $('#statRunning').textContent = fmtNum(running);
    $('#statMessages').textContent = fmtNum(messages);
    $('#roomCount').textContent = fmtNum(roomsCount) + ' 个';
    $('#runningCount').textContent = String(running);
  }

  function renderPrivacy() {
    var dir = dirText();
    var foot = $('#footDataDir');
    if (foot) foot.textContent = dir;
    var dlg = $('#privacyDataDir');
    if (dlg) dlg.textContent = dir;
  }

  function roomsSignature(list) {
    return (list || []).map(function (r) {
      return [r.id, r.status, r.updatedAt, r.runCount, r.messageCount, r.title].join('|');
    }).join('~');
  }

  function applyState(state) {
    if (!state || typeof state !== 'object') throw new Error('总览数据格式不可识别');
    if (!Array.isArray(state.rooms)) throw new Error('总览数据缺少 rooms 列表');
    var rooms = state.rooms.filter(isRoom);
    var prevSig = roomsSignature(S.rooms);
    var rev = str(state.revision, '');
    var revChanged = rev !== S.revision;
    var previousReadState = S.privacy && S.privacy.readStatus ? S.privacy.readStatus.state : '';
    S.loaded = true;
    S.stats = (state.stats && typeof state.stats === 'object') ? state.stats : null;
    S.privacy = (state.privacy && typeof state.privacy === 'object') ? state.privacy : null;
    S.rooms = rooms;
    S.revision = rev;

    var stale = (Date.now() - S.lastRoomRender) > 30000;
    var readState = S.privacy && S.privacy.readStatus ? S.privacy.readStatus.state : '';
    if (revChanged || stale || prevSig !== roomsSignature(rooms) || readState !== previousReadState) renderRooms();
    renderStats();
    renderPrivacy();

    // 新记录到达时保持用户所在页面，首次打开也先展示群聊列表。
    if (S.roomId && !rooms.some(function (r) { return r.id === S.roomId; })) {
      clearRoomSelection();
      setView('rooms');
    }
    renderOnboarding();
    renderChromeState();
  }

  function applyRoomDetail(detail) {
    if (!detail || typeof detail !== 'object') return false;
    if (!isRoom(detail.room) || detail.room.id !== S.roomId) return false;
    var rev = str(detail.revision, '');
    var changed = !S.detailLoaded || rev !== S.detailRevision;
    S.detail = detail;
    S.detailRevision = rev;
    S.detailLoaded = true;
    var runs = currentRuns();
    if (S.selectedRunId && !runs.some(function (r) { return r.id === S.selectedRunId; })) {
      S.selectedRunId = '';
      S.taskFilterSig = '';
    }
    renderHeader();
    renderTaskFilter(runs);
    if (changed) {
      renderMessages({});
      renderTaskPanel();
    }
    renderRoomDetailDialog(runs);
    return true;
  }

  function renderHeader() {
    var info = roomModel();
    var title = $('#roomTitle');
    if (!info) {
      title.textContent = (S.loaded && !S.rooms.length) ? '还没有群组' : '未选择群组';
      setPill($('#roomStatusPill'), $('#roomStatusText'), 'off', '—');
      $('#roomMetaMono').textContent = '—';
      renderFilterInfo();
      return;
    }
    title.textContent = str(info.title, '未命名群组');
    var si = statusInfo(info.status);
    setPill($('#roomStatusPill'), $('#roomStatusText'), si.st, si.text);
    $('#roomMetaMono').textContent = (num(info.runCount) || 0) + ' 任务 · '
      + (num(info.messageCount) || 0) + ' 消息 · 更新 ' + fmtRelative(info.updatedAt);
    renderFilterInfo();
  }

  function renderFilterInfo() {
    var runs = currentRuns();
    if (S.selectedRunId && !runs.some(function (r) { return r.id === S.selectedRunId; })) S.selectedRunId = '';
    var parts = [];
    if (S.selectedRunId) {
      var run = runs.filter(function (r) { return r.id === S.selectedRunId; })[0];
      parts.push('任务：' + (run ? str(run.title, '未命名任务') : '已失效选择'));
    }
    var q = S.msgQuery.trim();
    if (q) parts.push('关键词：' + q);
    $('#filterInfo').textContent = parts.length ? parts.join(' · ') : '全部任务 · 无关键词';
    var clear = $('#btnClearFilters');
    if (clear) clear.hidden = !(S.selectedRunId || q);
  }

  function renderRooms() {
    var list = $('#roomList');
    var empty = $('#roomListEmpty');
    if (!list) return;
    var q = S.roomQuery.trim().toLowerCase();
    var onlyRunning = S.roomFilter === 'running';
    var shown = S.rooms.filter(function (r) {
      if (onlyRunning && r.status !== 'running') return false;
      if (!q) return true;
      return [r.title, r.project, r.preview, r.id, r.grouping].some(function (v) {
        return typeof v === 'string' && v.toLowerCase().indexOf(q) >= 0;
      });
    });
    var frag = document.createDocumentFragment();
    shown.forEach(function (r) { frag.appendChild(roomItem(r)); });
    list.replaceChildren(frag);
    if (!S.loaded) {
      empty.hidden = false;
      empty.textContent = '正在读取本机记录…';
    } else if (!S.rooms.length && S.privacy && S.privacy.readStatus && S.privacy.readStatus.state === 'error') {
      empty.hidden = false;
      empty.textContent = '本机记录读取失败：' + (S.privacy.readStatus.errors || []).join('；') + '。请尝试刷新或重启客户端。';
    } else if (!S.rooms.length) {
      empty.hidden = false;
      empty.textContent = '还没有协作群。开始一次鲸鲸委派后，对话会自动出现在这里。';
    } else if (!shown.length) {
      empty.hidden = false;
      empty.textContent = '没有匹配的群组，请调整搜索词或筛选条件。';
    } else {
      empty.hidden = true;
      empty.textContent = '';
    }
    S.lastRoomRender = Date.now();
  }

  function roomTime(value) {
    var time = ts(value);
    if (!time) return '';
    var date = new Date(time);
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }

  function roomItem(room) {
    var li = el('li', 'wr-room-item');
    var btn = el('button', 'wr-room');
    btn.type = 'button';
    var info = statusInfo(room.status);
    var selected = room.id === S.roomId;
    if (selected) {
      btn.classList.add('is-sel');
      btn.setAttribute('aria-current', 'true');
    }
    btn.setAttribute('aria-label', str(room.title, '未命名群组') + '，状态 ' + info.text
      + '，' + (num(room.runCount) || 0) + ' 个任务，' + (num(room.messageCount) || 0) + ' 条消息，更新于 ' + fmtRelative(room.updatedAt));

    var content = el('span', 'wr-room-content');
    var top = el('span', 'wr-room-top');
    top.appendChild(el('span', 'wr-room-title', str(room.title, '未命名群组')));
    top.appendChild(el('time', 'wr-room-time', roomTime(room.updatedAt)));
    content.appendChild(top);
    var bottom = el('span', 'wr-room-bottom');
    var preview = str(room.preview, '暂无消息').replace(/[`*~#]+/g, '').replace(/\s+/g, ' ').trim();
    bottom.appendChild(el('span', 'wr-room-prev', preview));
    if (room.status === 'running') bottom.appendChild(el('span', 'wr-room-activity', '进行中'));
    content.appendChild(bottom);
    btn.appendChild(content);
    btn.addEventListener('click', function () { selectRoom(room.id); });
    li.appendChild(btn);
    return li;
  }

  function renderOnboarding() {
    var on = $('#onboard');
    if (!on) return;
    var show = S.loaded && !S.rooms.length && !S.roomId;
    on.hidden = !show;
    if (!show) { S.onboardDir = null; return; }
    var dir = dirText();
    if (on.getAttribute('data-dir') === dir) return;
    on.setAttribute('data-dir', dir);
    on.replaceChildren(onboardContent(dir));
  }

  function onboardContent(dir) {
    var frag = document.createDocumentFragment();
    var hd = el('div', 'wr-onboard-hd');
    var ei = el('span', 'wr-ei');
    ei.appendChild(icon('eye', 'lv-lg'));
    hd.appendChild(ei);
    var txt = el('span');
    txt.appendChild(el('b', '', '还没有真实协作记录'));
    txt.appendChild(el('span', '', '本页只展示专用委派入口写出的真实事件，不生成任何示例数据。'));
    hd.appendChild(txt);
    frag.appendChild(hd);

    var listItems = [
      '事件文件按 runId 写入本机专用数据目录，本页每 2 秒读取一次 state 与当前群组。',
      '只展示显式任务、鲸鲸的公开回复和主审说明，工具操作不进入群聊。',
      '任务运行中显示“运行中”；结束时显示“调用完成 · 待主审”；只有真实 review 事件 passed 才显示“主审通过”。',
      '记录里出现文本后，左侧会出现对应群组，搜索、按任务筛选、导出与删除都基于这些真实事件。'
    ];
    var ul = el('ul');
    listItems.forEach(function (t) { ul.appendChild(el('li', '', t)); });
    frag.appendChild(ul);

    frag.appendChild(kvText('数据目录', dir, true));
    frag.appendChild(kvText('本页权限', '仅观察：没有发送任务或修改代码的入口。'));

    var row = el('div', 'wr-row');
    var b1 = el('button', 'lv-btn lv-btn-primary lv-btn-sm', '立即刷新');
    b1.type = 'button';
    b1.setAttribute('aria-label', '立即刷新一次数据');
    b1.addEventListener('click', function () { poll(); });
    var b2 = el('button', 'lv-btn lv-btn-secondary lv-btn-sm', '隐私说明');
    b2.type = 'button';
    b2.addEventListener('click', openPrivacy);
    row.appendChild(b1);
    row.appendChild(b2);
    frag.appendChild(row);
    return frag;
  }

  /* ---------------- 消息渲染 ---------------- */
  function visibleMessages() {
    if (!S.detail || !Array.isArray(S.detail.messages)) return [];
    var q = S.msgQuery.trim().toLowerCase();
    return S.detail.messages.filter(function (m) {
      if (!m || typeof m !== 'object') return false;
      if (['task.created', 'message', 'review'].indexOf(m.type) < 0) return false;
      if (S.selectedRunId && m.runId !== S.selectedRunId) return false;
      if (!q) return true;
      var payload = (m.payload && typeof m.payload === 'object') ? m.payload : {};
      var hay = [
        str(m.text, ''), str(m.actor, ''), str(m.runId, '')
      ].join('\n').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function getMessageList() {
    if (messageList) return messageList;
    if (!window.WorkroomMessageList) return null;
    messageList = window.WorkroomMessageList.create({
      scroller: $('#msgScroll'), list: $('#msgList'), overscan: 400, maxMounted: 48, cacheSize: 64,
      renderItem: function (entry) {
        var wrap = el('div', 'wr-msgs');
        if (entry.day) {
          wrap.appendChild(el('div', 'wr-day', new Date(ts(entry.message.time)).toLocaleDateString('zh-CN',
            { year: 'numeric', month: 'long', day: 'numeric' })));
        }
        var node = buildMessage(entry.message);
        if (entry.message.runId) node.setAttribute('data-run', entry.message.runId);
        wrap.appendChild(node);
        return wrap;
      }
    });
    return messageList;
  }

  function messageEntries(items) {
    var previousDay = '', occurrences = new Map();
    return items.map(function (m, index) {
      var stamp = ts(m.time), dayKey = '';
      if (stamp) {
        var date = new Date(stamp);
        dayKey = date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate();
      }
      var day = dayKey && dayKey !== previousDay ? dayKey : '';
      previousDay = dayKey;
      var base = str(m.runId, '') + '|' + str(m.id, str(m.type, '') + '|' + str(m.time, '') + '|' + index);
      var occurrence = occurrences.get(base) || 0;
      occurrences.set(base, occurrence + 1);
      var text = str(m.text, '');
      return { key: base + '|' + occurrence, version: text,
        revision: [m.type, m.actor, m.time, m.payload && m.payload.status, day].join('|'),
        estimatedHeight: (text.length > TEXT_LIMIT ? 260 : Math.max(104, 88 + Math.ceil(text.length / 25) * 22)) + (day ? 44 : 0),
        message: m, day: day };
    });
  }

  function renderMessages(opts) {
    opts = opts || {};
    var sc = $('#msgScroll'), list = $('#msgList'), empty = $('#msgEmpty');
    if (!sc || !list) return;
    var noRoom = !S.roomId;
    var noDetail = !S.detail;
    var items = (noRoom || noDetail) ? [] : visibleMessages();
    var last = items.length ? items[items.length - 1] : null;
    var scope = [S.roomId || '-', S.selectedRunId || '-', S.msgQuery.trim()].join('~');
    var roomRevision = S.detail && S.detail.room ? str(S.detail.room.clearRevision, S.detailRevision) : '';
    var key = [scope, roomRevision, items.length,
      last ? (str(last.id, '') + '|' + str(last.type, '')) : '-'].join('~');
    if (!opts.force && key === S.renderedKey && !opts.resetScroll) return;

    var wasAtBottom = (sc.scrollHeight - sc.scrollTop - sc.clientHeight) < 96;
    var grew = (S.renderedRoom === S.roomId) && items.length > S.renderedCount;
    if (grew && !wasAtBottom) S.pendingNew += items.length - S.renderedCount;
    if (wasAtBottom || opts.resetScroll) S.pendingNew = 0;

    var virtual = getMessageList();
    if (virtual) {
      virtual.setItems(messageEntries(items), { scope: scope, reset: !!opts.resetScroll,
        stickToBottom: !!opts.resetScroll || wasAtBottom });
    } else {
      list.replaceChildren(el('p', 'wr-note', '消息组件未加载，请刷新客户端。'));
    }

    S.renderedKey = key;
    S.renderedCount = items.length;
    S.renderedRoom = S.roomId;

    var emptyText = '';
    if (noRoom && !S.loaded) emptyText = '正在读取本机记录…';
    else if (noRoom && S.rooms.length) emptyText = '正在读取该群记录…';
    else if (noRoom) emptyText = '';
    else if (noDetail) emptyText = '正在读取该群记录…';
    else if (!items.length) {
      var hasFilter = !!(S.selectedRunId || S.msgQuery.trim());
      emptyText = hasFilter ? '没有匹配的消息，可清除筛选后查看全部记录。' : '该群还没有可展示的消息。';
    }
    if (empty) {
      empty.textContent = emptyText;
      empty.hidden = !emptyText;
    }

    updateNewMsgBtn();
    renderFilterInfo();
    renderChromeState();
  }

  function buildMessage(m) {
    return bubbleRow(m);
  }

  function actorMeta(m) {
    var type = str(m.type, '');
    var actor = str(m.actor, '');
    if (type === 'task.created') {
      return { name: '龙龙', initials: 'CX', avatarCls: 'wr-av-codex', label: '任务指令', chipCls: 'wr-chip-task', bubbleCls: ' wr-task' };
    }
    if (type === 'review') {
      return { name: '龙龙', initials: 'RV', avatarCls: 'wr-av-rev', label: '主审记录', chipCls: 'wr-chip-rev', bubbleCls: ' wr-review' };
    }
    if (actor === 'deepseek') {
      return { name: '鲸鲸', initials: 'DS', avatarCls: 'lv-ai', label: '公开回复', chipCls: 'wr-chip-ds', bubbleCls: ' wr-ds' };
    }
    if (actor === 'system') {
      return { name: '系统', initials: 'SY', avatarCls: 'wr-av-sys', label: '系统记录', chipCls: '', bubbleCls: '' };
    }
    if (actor === 'reviewer') {
      return { name: '龙龙', initials: 'RV', avatarCls: 'wr-av-rev', label: '公开回复', chipCls: 'wr-chip-rev', bubbleCls: ' wr-review' };
    }
    return { name: '龙龙', initials: 'CX', avatarCls: 'wr-av-codex', label: '公开回复', chipCls: 'wr-chip-task', bubbleCls: '' };
  }

  function bubbleRow(m) {
    var meta = actorMeta(m);
    var outgoing = m.type === 'task.created' || m.type === 'review' || m.actor === 'codex' || m.actor === 'reviewer';
    var row = el('article', 'wr-msg ' + (outgoing ? 'wr-msg-out' : 'wr-msg-in'));
    var side = el('div', 'wr-msg-side');
    var avatarRole = meta.avatarCls === 'lv-ai' ? 'deepseek'
      : (meta.avatarCls === 'wr-av-codex' || meta.avatarCls === 'wr-av-rev' ? 'chatgpt' : 'system');
    var hasProfile = avatarRole === 'chatgpt' || avatarRole === 'deepseek';
    var av = el(hasProfile ? 'button' : 'span', 'lv-avatar ' + meta.avatarCls, meta.initials);
    if (hasProfile) av.type = 'button';
    else av.setAttribute('aria-hidden', 'true');
    // 固定身份映射到本地头像，消息文本不能指定图片路径。
    if (window.WorkroomAvatars) {
      window.WorkroomAvatars.decorate(av, avatarRole);
    }
    side.appendChild(av);
    row.appendChild(side);

    var body = el('div', 'wr-msg-body');
    var bubble = el('div', 'wr-bubble' + meta.bubbleCls);
    var hd = el('div', 'wr-bubble-hd');
    hd.appendChild(el('span', 'wr-who-b', meta.name));
    if (meta.label) hd.appendChild(el('span', 'wr-chip ' + meta.chipCls, meta.label));
    if (str(m.type, '') === 'review') {
      var ri = statusInfo(m.payload ? m.payload.status : '');
      hd.appendChild(pill(ri.st, ri.text, 'lv-sm'));
    }
    var messageTime = ts(m.time);
    var time = el('time', 'wr-time', messageTime
      ? new Date(messageTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '时间未知');
    time.setAttribute('datetime', str(m.time, ''));
    time.title = fmtDateTime(m.time);
    var text = str(m.text, '');
    bubble.appendChild(hd);

    var bd = el('div', 'wr-bubble-bd');
    if (text) {
      renderText(bd, text, 'msg|' + str(m.id, str(m.runId, '') + '|' + str(m.time, '')));
    } else {
      bd.appendChild(el('p', 'wr-note', '（该事件没有文本内容，仅保留时间与元数据）'));
    }
    bubble.appendChild(bd);
    var foot = el('div', 'wr-bubble-ft');
    foot.appendChild(time);
    if (text) {
      foot.appendChild(iconBtn('复制该条原文', 'copy', 'lv-ibtn wr-copy', function () {
        copyMessage(text, meta.label || '公开回复');
      }));
    }
    bubble.appendChild(foot);
    body.appendChild(bubble);
    row.appendChild(body);
    return row;
  }

  function systemStrip(m) {
    var wrap = el('div', 'wr-sys');
    wrap.appendChild(el('span', 'wr-sys-line'));
    var label;
    if (str(m.type, '') === 'task.running') {
      label = '任务开始运行 · ' + fmtClock(m.time);
    } else {
      var si = statusInfo(m.payload ? m.payload.status : '');
      var dur = m.payload ? num(m.payload.durationSeconds) : null;
      label = si.text + (dur !== null ? ' · 耗时 ' + fmtDuration(dur) : '') + ' · ' + fmtClock(m.time);
    }
    var box = el('span', 'wr-sys-txt');
    box.appendChild(icon('bolt', 'lv-xs'));
    box.appendChild(el('span', '', label));
    box.title = '任务 ' + shortId(m.runId) + ' · ' + fmtDateTime(m.time);
    wrap.appendChild(box);
    wrap.appendChild(el('span', 'wr-sys-line'));
    return wrap;
  }

  function toolRow(m) {
    var payload = (m.payload && typeof m.payload === 'object') ? m.payload : {};
    var key = 'tool|' + str(m.id, str(m.runId, '') + '|' + str(m.time, '') + '|' + str(payload.path, ''));
    var open = S.expandedTools.has(key);
    var card = el('article', 'wr-tool');

    var head = el('button', 'wr-tool-hd');
    head.type = 'button';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    head.appendChild(icon(open ? 'chev-down' : 'chev-right', 'lv-sm'));
    head.appendChild(el('span', 'lv-mono', str(payload.operation, '未标注操作')));
    head.appendChild(el('span', 'wr-tool-path', str(payload.path, '未记录路径')));
    head.appendChild(el('span', 'wr-chip', '工具元数据'));
    head.appendChild(el('span', 'wr-time lv-mono', fmtClock(m.time)));

    var body = el('div', 'wr-tool-body');
    body.hidden = !open;
    body.appendChild(toolRowLine('操作', str(payload.operation, '未记录')));
    body.appendChild(toolRowLine('路径', str(payload.path, '未记录')));
    body.appendChild(toolRowLine('结果', str(payload.result, '未记录')));
    body.appendChild(toolRowLine('任务', str(m.runId, '未记录')));
    body.appendChild(toolRowLine('事件', str(m.id, '未记录') + ' · ' + fmtDateTime(m.time)));

    head.addEventListener('click', function () {
      var nowOpen = !S.expandedTools.has(key);
      if (nowOpen) S.expandedTools.add(key); else S.expandedTools.delete(key);
      head.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      head.replaceChild(icon(nowOpen ? 'chev-down' : 'chev-right', 'lv-sm'), head.firstChild);
      body.hidden = !nowOpen;
    });

    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  function toolRowLine(key, value) {
    var row = el('div', 'wr-tool-row');
    row.appendChild(el('span', 'wr-tool-k', key));
    row.appendChild(el('pre', 'wr-tool-v', value));
    return row;
  }

  function renderText(container, raw, key) {
    var text = typeof raw === 'string' ? raw : '';
    var expanded = S.expandedTexts.has(key);
    // 折叠时只创建有界预览 DOM；展开时复用完整解析结果，原文始终保留。
    var content = el('div', 'wr-markdown' + ((!expanded && text.length > TEXT_LIMIT) ? ' is-collapsed' : ''));
    function drawText() {
      var preview = !expanded && text.length > TEXT_LIMIT;
      try {
        if (!window.WorkroomMarkdown) throw new Error('Markdown renderer unavailable');
        var renderer = preview && window.WorkroomMarkdown.renderPreview
          ? window.WorkroomMarkdown.renderPreview : window.WorkroomMarkdown.render;
        renderer(content, text, { onCopyLink: function (url) { copyMessage(url, '链接地址'); } });
      } catch (_) {
        content.replaceChildren(el('p', 'wr-md-plain', preview ? text.slice(0, 1200) : text));
      }
    }
    drawText();
    container.appendChild(content);

    if (text.length > TEXT_LIMIT) {
      var expandLabel = '展开全文（共 ' + text.length + ' 字）';
      var more = el('button', 'lv-btn lv-btn-ghost lv-btn-xs wr-more', expanded ? '收起' : expandLabel);
      more.type = 'button';
      more.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      more.addEventListener('click', function () {
        var sc = container.closest ? container.closest('#msgScroll') : null;
        var msg = container.closest ? container.closest('.wr-msg') : null;
        var prevTop = sc ? sc.scrollTop : 0;
        var msgTop = prevTop;
        var wasAbove = false;
        if (sc && msg) {
          var scRect = sc.getBoundingClientRect();
          var msgRect = msg.getBoundingClientRect();
          msgTop = prevTop + (msgRect.top - scRect.top);
          wasAbove = msgRect.top < scRect.top;
        }
        expanded = !expanded;
        if (expanded) S.expandedTexts.add(key); else S.expandedTexts.delete(key);
        drawText();
        content.classList.toggle('is-collapsed', !expanded);
        more.textContent = expanded ? '收起' : expandLabel;
        more.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (sc) {
          var maxTop = Math.max(0, sc.scrollHeight - sc.clientHeight);
          var targetTop = (!expanded && wasAbove) ? msgTop : prevTop;
          sc.scrollTop = Math.max(0, Math.min(targetTop, maxTop));
        }
      });
      container.appendChild(more);
    }
  }

  function updateNewMsgBtn() {
    var btn = $('#newMsgBtn');
    if (!btn) return;
    if (S.pendingNew > 0) {
      btn.hidden = false;
      $('#newMsgText').textContent = S.pendingNew + ' 条新记录 · 回到最新';
    } else {
      btn.hidden = true;
    }
  }

  /* ---------------- 任务信息栏 ---------------- */
  function renderTaskFilter(runs) {
    var sel = $('#taskFilter');
    if (!sel) return;
    var sig = runs.map(function (r) { return r.id + ':' + str(r.status, '') + ':' + str(r.title, ''); }).join('|');
    if (sig === S.taskFilterSig) {
      if (sel.value !== (S.selectedRunId || '')) sel.value = S.selectedRunId || '';
      return;
    }
    S.taskFilterSig = sig;
    var frag = document.createDocumentFragment();
    var all = el('option', '', '全部任务（' + runs.length + '）');
    all.value = '';
    frag.appendChild(all);
    runs.slice().sort(byStartedDesc).forEach(function (r) {
      var o = el('option', '', str(r.title, '未命名任务') + ' · ' + statusInfo(r.status).text + ' · ' + fmtClock(r.startedAt));
      o.value = r.id;
      frag.appendChild(o);
    });
    sel.replaceChildren(frag);
    sel.value = S.selectedRunId || '';
  }

  function runTaskText(runId) {
    if (!S.detail || !Array.isArray(S.detail.messages)) return '';
    var texts = S.detail.messages.filter(function (m) {
      return m && m.type === 'task.created' && m.runId === runId && str(m.text, '');
    }).map(function (m) { return m.text; });
    return texts.join('\n\n');
  }

  function runReviews(runId) {
    if (!S.detail || !Array.isArray(S.detail.messages)) return [];
    return S.detail.messages.filter(function (m) {
      return m && m.type === 'review' && m.runId === runId && str(m.actor, '') !== 'system';
    });
  }

  function runDuration(run) {
    var dur = num(run.durationSeconds);
    if (dur !== null) return fmtDuration(dur);
    var a = ts(run.startedAt), b = ts(run.completedAt);
    if (a && b && b > a) return fmtDuration((b - a) / 1000) + '（按事件时间估算）';
    return '未记录';
  }

  function usageBlock(run) {
    var usage = (run.usage && typeof run.usage === 'object') ? run.usage : null;
    var input = usage ? num(usage.input_tokens) : null;
    var output = usage ? num(usage.output_tokens) : null;
    var cached = usage ? num(usage.cached_input_tokens) : null;
    var total = usage ? num(usage.total_tokens) : null;
    if (total === null && (input !== null || output !== null)) total = (input || 0) + (output || 0);
    var box = el('div');
    var grid = el('div', 'wr-metrics');
    [['合计 Token', total], ['输入', input], ['输出', output], ['缓存命中', cached]].forEach(function (pair) {
      var cell = el('div', 'wr-metric');
      cell.appendChild(el('span', 'wr-metric-k', pair[0]));
      cell.appendChild(el('span', 'wr-metric-v lv-mono', pair[1] === null ? '未记录' : fmtNum(pair[1])));
      grid.appendChild(cell);
    });
    box.appendChild(grid);
    if (total === null) box.appendChild(el('p', 'wr-note', '后端未返回 usage 字段，或该任务未报告 Token 用量。'));
    return box;
  }

  function fileList(paths, changed) {
    var list = el('ul', 'wr-filelist');
    if (!paths.length) {
      var li = el('li', 'wr-file', '未记录');
      list.appendChild(li);
      return list;
    }
    paths.forEach(function (p) {
      var item = el('li', 'wr-file' + (changed ? ' is-changed' : ''));
      item.appendChild(icon(changed ? 'check' : 'file', 'lv-xs'));
      item.appendChild(el('span', '', p));
      list.appendChild(item);
    });
    return list;
  }

  function renderTaskPanel() {
    var body = $('#taskBody');
    if (!body) return;
    var runs = currentRuns().slice().sort(byStartedDesc);
    $('#taskRunCount').textContent = runs.length ? runs.length + ' 个任务' : '暂无任务';

    if (!S.roomId) {
      body.replaceChildren(S.loaded
        ? emptyBlock('未选择群组', '左侧选择一个群组后，这里显示最新或选中任务的目标、来源聊天、文件范围、状态、耗时、Token 与主审结论。')
        : loadingBlock('正在读取本机记录…'));
      return;
    }
    if (!S.detail) {
      body.replaceChildren(loadingBlock('正在读取任务信息…'));
      return;
    }
    var room = roomModel() || {};
    var run = runs.filter(function (r) { return r.id === S.selectedRunId; })[0] || runs[0] || null;
    var frag = document.createDocumentFragment();

    if (!run) {
      frag.appendChild(section('本轮目标', 'bolt', function (bd) {
        bd.appendChild(emptyBlock('该群暂无任务记录', '当专用委派入口写入 task.created 事件后，这里会显示任务目标与文件范围。'));
      }));
    } else {
      var isSelected = run.id === S.selectedRunId;
      frag.appendChild(section('本轮目标', 'bolt', function (bd) {
        bd.appendChild(el('p', 'wr-run-title', str(run.title, '未命名任务')));
        var tag = el('div', 'wr-row');
        tag.appendChild(pill(statusInfo(run.status).st, statusInfo(run.status).text, 'lv-sm'));
        tag.appendChild(el('span', 'wr-chip', isSelected ? '已选中任务' : '最新任务'));
        bd.appendChild(tag);
        bd.appendChild(kvText('任务标识', str(run.id, '未记录'), true));
        bd.appendChild(kvText('模式 / 模型 / 引擎', [str(run.mode, ''), str(run.model, ''), str(run.engine, '')].filter(Boolean).join(' · ') || '未记录'));
        var goal = runTaskText(run.id);
        if (goal) {
          var wrap = el('div', 'wr-goal');
          renderText(wrap, goal, 'task|' + run.id);
          bd.appendChild(el('span', 'wr-vl', '显式任务原文'));
          bd.appendChild(wrap);
        } else {
          bd.appendChild(el('p', 'wr-note', '该任务没有 task.created 文本（可能事件已清理或未记录）。'));
        }
      }));

      frag.appendChild(section('来源聊天与文件范围', 'folder', function (bd) {
        bd.appendChild(kvText('群组', str(room.title, '未记录')));
        bd.appendChild(kvText('来源会话', roomSources(room), true));
        bd.appendChild(kvText('项目目录', str(room.project, '未记录'), true));
        bd.appendChild(kvText('分组方式', room.grouping === 'workspace' ? '工作区（跨任务、跨聊天）' : str(room.grouping, '未记录')));
        var files = Array.isArray(run.editableFiles) ? run.editableFiles.filter(function (x) { return typeof x === 'string'; }) : [];
        bd.appendChild(kvText('可编辑文件', files.length ? files.length + ' 个（本机路径，未读取内容）' : '未记录'));
        bd.appendChild(fileList(files, false));
        var changes = Array.isArray(run.fileChanges) ? run.fileChanges.filter(function (x) {
          return x && typeof x === 'object' && typeof x.path === 'string';
        }) : [];
        bd.appendChild(kvText('文件变更', changes.length ? changes.length + ' 条记录' : '未记录'));
        if (changes.length) {
          var list = el('ul', 'wr-filelist');
          changes.forEach(function (c) {
            var item = el('li', 'wr-file' + (c.changed === true ? ' is-changed' : ''));
            item.appendChild(icon(c.changed === true ? 'check' : 'file', 'lv-xs'));
            item.appendChild(el('span', '', c.path));
            list.appendChild(item);
          });
          bd.appendChild(list);
        }
      }));

      frag.appendChild(section('状态与用量', 'tokens', function (bd) {
        bd.appendChild(kvNode('状态', pill(statusInfo(run.status).st, statusInfo(run.status).text)));
        bd.appendChild(kvText('开始时间', fmtDateTime(run.startedAt), true));
        bd.appendChild(kvText('完成时间', run.completedAt ? fmtDateTime(run.completedAt) : '未记录（仍在进行或事件缺失）', true));
        bd.appendChild(kvText('耗时', runDuration(run), true));
        bd.appendChild(usageBlock(run));
      }));

      frag.appendChild(section('主审结论', 'shield', function (bd) {
        var reviews = runReviews(run.id);
        if (!reviews.length) {
          bd.appendChild(el('p', 'wr-note', '尚无主审记录：只有真实 review 事件 passed 才显示“主审通过”；调用 success 仅表示辅助调用结束。'));
          return;
        }
        var last = reviews[reviews.length - 1];
        var ri = statusInfo(last.payload ? last.payload.status : '');
        bd.appendChild(kvNode('结论', pill(ri.st, ri.text)));
        bd.appendChild(kvText('主审时间', fmtDateTime(last.time), true));
        var text = str(last.text, '');
        if (text) {
          var wrap = el('div', 'wr-goal');
          renderText(wrap, text, 'review|' + str(last.id, last.runId + '|' + last.time));
          bd.appendChild(wrap);
        } else {
          bd.appendChild(el('p', 'wr-note', '该 review 事件没有附加文本。'));
        }
      }));
    }

    if (runs.length) {
      var shownId = S.selectedRunId || (run ? run.id : '');
      frag.appendChild(section('任务列表', 'list', function (bd) {
        var list = el('div', 'wr-runlist');
        runs.forEach(function (r) {
          var b = el('button', 'wr-run-item' + (r.id === shownId ? ' is-sel' : ''));
          b.type = 'button';
          if (r.id === shownId) b.setAttribute('aria-current', 'true');
          b.setAttribute('aria-label', str(r.title, '未命名任务') + '，状态 ' + statusInfo(r.status).text + '，开始于 ' + fmtDateTime(r.startedAt));
          b.appendChild(el('span', 'wr-run-t', str(r.title, '未命名任务')));
          b.appendChild(pill(statusInfo(r.status).st, statusInfo(r.status).text, 'lv-sm'));
          b.appendChild(el('span', 'wr-run-m lv-mono', shortId(r.id) + ' · ' + fmtClock(r.startedAt)));
          b.addEventListener('click', function () { selectRun(r.id); });
          list.appendChild(b);
        });
        bd.appendChild(list);
      }));
    }
    body.replaceChildren(frag);
  }

  /* ---------------- 对话框 ---------------- */
  function openPrivacy() {
    var dlg = $('#dlgPrivacy');
    if (!dlg) return;
    renderPrivacy();
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', 'open');
  }

  function openDeleteDialog() {
    var dlg = $('#dlgDelete');
    if (!dlg) return;
    if (!ROOM_ID.test(S.roomId || '')) {
      toast('warn', '未选择群组', '请先在左侧选择一个群组。');
      return;
    }
    var room = roomModel() || {};
    if (!S.detailLoaded || !S.detail || !S.detail.room || S.detail.room.id !== S.roomId
        || !/^[0-9a-f]{20}$/.test(str(room.clearRevision, ''))) {
      toast('warn', '请等待对话加载', '对话加载完成后再确认客户端删除范围。');
      return;
    }
    // 固定确认时的群与版本，后台轮询更新不能扩大本次删除范围。
    S.deleteTarget = { id: S.roomId, revision: room.clearRevision };
    var runs = currentRuns();
    var running = runs.filter(function (r) { return r.status === 'running'; });
    $('#dlgDeleteTarget').textContent = str(room.title, '未命名群组') + ' · ' + shortId(S.roomId) + '…';

    var details = document.createDocumentFragment();
    details.appendChild(kvText('群组 ID', S.roomId, true));
    details.appendChild(kvText('任务', runs.length + ' 个（运行中 ' + running.length + '）'));
    details.appendChild(kvText('消息', String(num(room.messageCount) || 0)));
    details.appendChild(kvText('处理方式', '仅隐藏已有任务对话，原始记录只读保留'));
    $('#dlgDeleteDetail').replaceChildren(details);

    var alert = $('#dlgDeleteError');
    var confirm = $('#btnDeleteConfirm');
    confirm.disabled = running.length > 0;
    if (running.length) {
      alert.className = 'lv-banner lv-warn wr-dlg-alert';
      alert.hidden = false;
      alert.textContent = '该群仍有 ' + running.length + ' 个运行中任务，后端会拒绝删除；请等任务结束后再试。';
    } else {
      alert.className = 'lv-banner lv-danger wr-dlg-alert';
      alert.hidden = true;
      alert.textContent = '';
    }
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', 'open');
  }

  function setDeleteError(text) {
    var alert = $('#dlgDeleteError');
    if (!alert) return;
    alert.className = 'lv-banner lv-danger wr-dlg-alert';
    alert.textContent = text;
    alert.hidden = false;
  }

  async function confirmDelete() {
    var target = S.deleteTarget;
    var id = target ? target.id : '';
    if (!ROOM_ID.test(id) || !/^[0-9a-f]{20}$/.test(target.revision || '')) {
      setDeleteError('当前没有可删除的群组。');
      return;
    }
    if (S.deleteBusy) return;
    S.deleteBusy = true;
    var btn = $('#btnDeleteConfirm');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      var result = await request(API.room(id), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: target.revision })
      });
      if (!result || result.scope !== 'client-only' || result.sourcePreserved !== true) {
        throw new Error('未收到仅客户端删除的确认，请刷新后核对。');
      }
      var removed = (result && typeof result.deleted === 'number') ? result.deleted : null;
      var dlg = $('#dlgDelete');
      if (dlg.open) dlg.close();
      S.deleteTarget = null;
      toast('ok', '已从客户端删除', (removed === null ? '' : '已隐藏 ' + removed + ' 个任务的对话。') + 'Codex 文件和原始记录保持不变。');
      if (S.roomId === id) {
        clearRoomSelection();
        setView('rooms');
      }
      await poll();
    } catch (err) {
      setDeleteError('客户端删除未确认：' + describeError(err) + '原始记录始终保留，请刷新后核对。');
      toast('err', '删除失败', describeError(err));
    } finally {
      S.deleteBusy = false;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      renderChromeState();
    }
  }

  function openRoomDetail() {
    var dlg = $('#dlgRoom');
    if (!dlg) return;
    if (!ROOM_ID.test(S.roomId || '')) {
      toast('warn', '未选择群组', '请先在左侧选择一个群组。');
      return;
    }
    S.dialogRoomRev = null;
    renderRoomDetailDialog(currentRuns());
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', 'open');
  }

  function renderRoomDetailDialog(runs) {
    var dlg = $('#dlgRoom');
    if (!dlg || !dlg.open) return;
    var rev = (S.detail ? str(S.detail.revision, '') : '') + '|' + runs.length;
    if (S.dialogRoomRev === rev) return;
    S.dialogRoomRev = rev;
    var body = $('#roomDetailBody');
    var room = roomModel();
    if (!room) {
      body.replaceChildren(el('p', 'wr-note', '群组数据尚未读取完成，请稍后重试。'));
      return;
    }
    var si = statusInfo(room.status);
    var frag = document.createDocumentFragment();
    frag.appendChild(kvText('群组标题', str(room.title, '未命名群组')));
    frag.appendChild(kvText('群组 ID', str(room.id, '未记录'), true));
    frag.appendChild(kvNode('状态', pill(si.st, si.text)));
    frag.appendChild(kvText('项目目录', str(room.project, '未记录'), true));
    frag.appendChild(kvText('来源会话', roomSources(room), true));
    frag.appendChild(kvText('分组方式', room.grouping === 'workspace' ? '工作区（跨任务、跨聊天）' : str(room.grouping, '未记录')));
    frag.appendChild(kvText('任务数', (num(room.runCount) || 0) + ' 个（结束 '
      + runs.filter(function (r) { return r.status !== 'running'; }).length + ' · 运行中 '
      + runs.filter(function (r) { return r.status === 'running'; }).length + '）'));
    frag.appendChild(kvText('消息数', String(num(room.messageCount) || 0)));
    frag.appendChild(kvText('最近更新', fmtDateTime(room.updatedAt)));
    frag.appendChild(kvText('数据目录', dirText(), true));
    frag.appendChild(el('h4', 'wr-dlg-sub', '任务摘要'));
    if (!runs.length) frag.appendChild(el('p', 'wr-note', '暂无任务记录。'));
    runs.slice().sort(byStartedDesc).forEach(function (r) {
      var row = el('div', 'wr-kv');
      row.appendChild(el('span', 'wr-k', '任务'));
      var v = el('span', 'wr-v');
      v.appendChild(el('span', 'wr-run-t', str(r.title, '未命名任务')));
      v.appendChild(pill(statusInfo(r.status).st, statusInfo(r.status).text, 'lv-sm'));
      v.appendChild(el('span', 'wr-run-m lv-mono', shortId(r.id) + ' · ' + fmtClock(r.startedAt)));
      row.appendChild(v);
      frag.appendChild(row);
    });
    frag.appendChild(el('p', 'wr-note', '删除只在客户端隐藏本群已有任务，Codex 文件与原始记录始终只读保留；存在运行中任务时暂不能删除。后续新任务会继续显示，导出仅包含当前可见对话。'));
    body.replaceChildren(frag);
  }

  /* ---------------- 导出与复制 ---------------- */
  function filenameFrom(disposition) {
    if (typeof disposition !== 'string') return '';
    var m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (!m) return '';
    var name = m[1].trim();
    try { name = decodeURIComponent(name); } catch (e) { /* 原样使用 */ }
    return name.replace(/[\\/:*?"<>|]/g, '_');
  }

  function triggerDownload(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  async function exportRoom(id) {
    if (!ROOM_ID.test(id || '')) {
      toast('warn', '未选择群组', '请先选择一个群组再导出。');
      return;
    }
    if (S.exportBusy) return;
    S.exportBusy = true;
    renderChromeState();
    try {
      var res = await request(API.exportRoom(id), { raw: true });
      var blob = await res.blob();
      var name = filenameFrom(res.headers.get('Content-Disposition')) || ('workroom-' + id + '.json');
      triggerDownload(blob, name);
      toast('ok', '已导出脱敏 JSON', name + ' · ' + fmtBytes(blob.size));
    } catch (err) {
      toast('err', '导出失败', describeError(err));
    } finally {
      S.exportBusy = false;
      renderChromeState();
    }
  }

  function copyMessage(text, label) {
    var done = function () {
      toast('ok', '已复制原文', label + ' · ' + text.length + ' 字符（纯文本）');
    };
    var fallback = function (reason) {
      var dlg = $('#dlgCopy');
      $('#dlgCopyHint').textContent = (reason ? reason + '。' : '') + '可在下方选中文本后手动复制。';
      var area = $('#copyText');
      area.value = text;
      if (dlg && typeof dlg.showModal === 'function') {
        dlg.showModal();
        area.focus();
        area.select();
      } else if (area) {
        area.focus();
        area.select();
      }
      toast('warn', '无法自动复制', '已打开手动复制对话框。');
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function (err) {
        fallback(err && err.message ? err.message : '剪贴板写入被拒绝');
      });
    } else {
      fallback('当前环境不提供剪贴板 API');
    }
  }

  /* ---------------- 选择与切换 ---------------- */
  function clearRoomSelection() {
    S.roomSeq += 1;
    S.roomId = null;
    S.detail = null;
    S.detailRevision = '';
    S.detailLoaded = false;
    S.selectedRunId = '';
    S.taskFilterSig = '';
    S.renderedKey = '';
    S.renderedCount = 0;
    S.renderedRoom = null;
    S.pendingNew = 0;
    var inp = $('#msgSearch');
    if (inp) inp.value = '';
    S.msgQuery = '';
    renderHeader();
    renderMessages({ force: true, resetScroll: true });
    renderTaskPanel();
    renderOnboarding();
    renderChromeState();
  }

  function selectRoom(id) {
    if (!ROOM_ID.test(id || '')) return;
    if (S.roomId === id) {
      if (S.isMobile) setView('chat');
      return;
    }
    S.roomSeq += 1;
    S.roomId = id;
    S.detail = null;
    S.detailRevision = '';
    S.detailLoaded = false;
    S.selectedRunId = '';
    S.taskFilterSig = '';
    S.renderedKey = '';
    S.renderedCount = 0;
    S.renderedRoom = null;
    S.pendingNew = 0;
    S.dialogRoomRev = null;
    var inp = $('#msgSearch');
    if (inp) inp.value = '';
    S.msgQuery = '';
    S.view = 'chat';
    $('#chatSearchPanel').hidden = true;
    $('#btnMessageSearch').setAttribute('aria-expanded', 'false');
    renderChromeState();
    renderRooms();
    renderHeader();
    renderMessages({ force: true, resetScroll: true });
    renderTaskPanel();
    renderOnboarding();
    renderChromeState();
    fetchRoom(id).catch(function (err) {
      showError('读取该群记录失败：' + describeError(err) + '（已保留已有数据）');
      markConn(false, err);
      renderSync();
    });
  }

  function selectRun(id) {
    S.selectedRunId = id || '';
    var sel = $('#taskFilter');
    if (sel) sel.value = S.selectedRunId;
    renderMessages({ force: true, resetScroll: true });
    renderTaskPanel();
    renderFilterInfo();
  }

  function setView(view) {
    S.view = (view === 'rooms') ? 'rooms' : 'chat';
    renderChromeState();
    var target = S.view === 'rooms' ? ($('#roomList button[aria-current="true"]') || $('#btnRoomSearch')) : $('#msgScroll');
    if (target) target.focus({ preventScroll: true });
  }

  function toggleSearch(kind, open) {
    var rooms = kind === 'rooms';
    var panel = $(rooms ? '#roomSearchBar' : '#chatSearchPanel');
    var button = $(rooms ? '#btnRoomSearch' : '#btnMessageSearch');
    var input = $(rooms ? '#roomSearch' : '#msgSearch');
    var show = typeof open === 'boolean' ? open : panel.hidden;
    panel.hidden = !show;
    button.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) { input.focus(); return; }
    input.value = '';
    if (rooms) { S.roomQuery = ''; renderRooms(); }
    else {
      S.msgQuery = ''; S.selectedRunId = '';
      $('#taskFilter').value = '';
      renderMessages({ force: true, resetScroll: true });
    }
    button.focus();
  }

  function setTaskPanel(open) {
    S.taskPanelOpen = !!open;
    renderChromeState();
    if (S.isOverlay) {
      var node = S.taskPanelOpen ? $('#btnCloseTask') : $('#btnToggleTask');
      if (node) node.focus();
    }
  }

  function renderChromeState() {
    var app = $('#app');
    if (!app) return;
    app.classList.toggle('is-task-collapsed', !S.taskPanelOpen);
    app.classList.toggle('is-view-rooms', S.view === 'rooms');
    app.classList.toggle('is-view-chat', S.view !== 'rooms');
    var toggle = $('#btnToggleTask');
    if (toggle) {
      toggle.setAttribute('aria-expanded', S.taskPanelOpen ? 'true' : 'false');
      var label = (S.taskPanelOpen ? '收起' : '展开') + '任务信息';
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
    }
    var scrim = $('#taskScrim');
    if (scrim) scrim.hidden = !(S.taskPanelOpen && S.isOverlay);

    $$('[data-room-filter]').forEach(function (b) {
      var on = b.getAttribute('data-room-filter') === S.roomFilter;
      b.classList.toggle('lv-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    $$('#mViewSwitch button').forEach(function (b) {
      var on = b.getAttribute('data-view') === S.view;
      b.classList.toggle('lv-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    var hasRoom = ROOM_ID.test(S.roomId || '');
    var exportBtn = $('#btnExport');
    if (exportBtn) exportBtn.disabled = !hasRoom || S.exportBusy;
    var detailBtn = $('#btnRoomDetail');
    if (detailBtn) detailBtn.disabled = !hasRoom;
    var deleteBtn = $('#btnDeleteRoom');
    if (deleteBtn) deleteBtn.disabled = !hasRoom || S.deleteBusy || !S.detailLoaded
      || !/^[0-9a-f]{20}$/.test(str(roomModel() && roomModel().clearRevision, ''));
    var refreshBtn = $('#btnRefresh');
    if (refreshBtn) refreshBtn.disabled = S.polling;
    var retryBtn = $('#btnRetry');
    if (retryBtn) retryBtn.disabled = S.polling;
  }

  function scrollToBottomNow() {
    var sc = $('#msgScroll');
    if (!sc) return;
    S.pendingNew = 0;
    if (messageList) {
      messageList.scrollToEnd();
      updateNewMsgBtn();
      return;
    }
    try {
      sc.scrollTo({ top: sc.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' });
    } catch (e) {
      sc.scrollTop = sc.scrollHeight;
    }
    updateNewMsgBtn();
  }

  /* ---------------- 轮询 ---------------- */
  async function fetchRoom(id) {
    var seq = ++S.roomSeq;
    var data = await request(API.room(id));
    if (seq !== S.roomSeq || S.roomId !== id) return false;
    return applyRoomDetail(data);
  }

  async function poll() {
    if (document.visibilityState === 'hidden' || S.polling) return;
    S.polling = true;
    renderChromeState();
    var stateErr = null, roomErr = null;
    try {
      try {
        applyState(await request(API.state));
      } catch (e) { stateErr = e; }
      if (S.roomId) {
        var id = S.roomId;
        var summary = S.rooms.filter(function (room) { return room.id === id; })[0];
        var detailRoom = S.detail && S.detail.room;
        // 本群未变化时不重复传输、解析整份历史；其他工作群更新不打扰当前列表。
        if (!S.detailLoaded || !detailRoom || !summary || !summary.clearRevision
            || detailRoom.id !== id || detailRoom.clearRevision !== summary.clearRevision) {
          try { await fetchRoom(id); } catch (e2) { roomErr = e2; }
        }
      }
      var err = stateErr || roomErr;
      if (err) {
        markConn(false, err);
        showError((stateErr ? '读取总览失败：' : '读取该群记录失败：') + describeError(err) + '（已保留已有数据）');
      } else {
        markConn(true);
        hideError();
      }
    } catch (unexpected) {
      markConn(false, unexpected);
      showError('前端渲染异常：' + describeError(unexpected));
    } finally {
      S.polling = false;
      renderSync();
      renderChromeState();
    }
  }

  /* ---------------- 布局 ---------------- */
  function applyLayout(force) {
    // Windows 客户端采用手机通讯软件的页面切换，窗口拉宽也不恢复双栏。
    S.isOverlay = false;
    S.isMobile = true;
    S.taskPanelOpen = false;
    if (force === true || !S.layoutInit) S.view = 'rooms';
    S.layoutInit = true;
    renderChromeState();
  }

  function addMediaListener(mq, handler) {
    if (!mq) return;
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handler);
    else if (typeof mq.addListener === 'function') mq.addListener(handler);
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    $('#btnRoomSearch').addEventListener('click', function () { toggleSearch('rooms'); });
    $('#btnMessageSearch').addEventListener('click', function () { toggleSearch('chat'); });
    var roomSearch = $('#roomSearch');
    if (roomSearch) {
      roomSearch.addEventListener('input', debounce(function (ev) {
        S.roomQuery = ev.target.value || '';
        renderRooms();
      }, 200));
      roomSearch.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { ev.stopPropagation(); toggleSearch('rooms', false); }
      });
    }

    $$('[data-room-filter]').forEach(function (b) {
      b.addEventListener('click', function () {
        S.roomFilter = b.getAttribute('data-room-filter') === 'running' ? 'running' : 'all';
        renderRooms();
        renderChromeState();
      });
    });

    var msgSearch = $('#msgSearch');
    if (msgSearch) {
      msgSearch.addEventListener('input', debounce(function (ev) {
        S.msgQuery = ev.target.value || '';
        renderMessages({ force: true, resetScroll: true });
        renderFilterInfo();
      }, 200));
      msgSearch.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
          ev.stopPropagation();
          toggleSearch('chat', false);
        }
      });
    }

    var taskFilter = $('#taskFilter');
    if (taskFilter) {
      taskFilter.addEventListener('change', function () {
        selectRun(this.value || '');
      });
    }
    var clearBtn = $('#btnClearFilters');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        S.selectedRunId = '';
        S.msgQuery = '';
        if (msgSearch) msgSearch.value = '';
        if (taskFilter) taskFilter.value = '';
        renderMessages({ force: true, resetScroll: true });
        renderTaskPanel();
        renderFilterInfo();
      });
    }

    var exportBtn = $('#btnExport');
    if (exportBtn) exportBtn.addEventListener('click', function () { exportRoom(S.roomId); });
    var exportBtn2 = $('#btnRoomDetailExport');
    if (exportBtn2) exportBtn2.addEventListener('click', function () { exportRoom(S.roomId); });

    var detailBtn = $('#btnRoomDetail');
    if (detailBtn) detailBtn.addEventListener('click', openRoomDetail);
    var deleteBtn = $('#btnDeleteRoom');
    if (deleteBtn) deleteBtn.addEventListener('click', openDeleteDialog);
    var confirmBtn = $('#btnDeleteConfirm');
    if (confirmBtn) confirmBtn.addEventListener('click', function () { confirmDelete(); });

    var refreshBtn = $('#btnRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { poll(); });
    var retryBtn = $('#btnRetry');
    if (retryBtn) retryBtn.addEventListener('click', function () { poll(); });

    var privacyBtn = $('#btnPrivacy');
    if (privacyBtn) privacyBtn.addEventListener('click', openPrivacy);
    $$('[data-open-privacy]').forEach(function (b) { b.addEventListener('click', openPrivacy); });

    var themeBtn = $('#themeToggle');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
    $$('[data-toggle-theme]').forEach(function (b) { b.addEventListener('click', toggleTheme); });
    $$('.wr-menu button').forEach(function (b) {
      b.addEventListener('click', function () {
        var menu = b.closest('[popover]');
        if (menu && menu.matches(':popover-open')) menu.hidePopover();
      });
    });

    var toggleBtn = $('#btnToggleTask');
    if (toggleBtn) toggleBtn.addEventListener('click', function () { setTaskPanel(!S.taskPanelOpen); });
    var closeBtn = $('#btnCloseTask');
    if (closeBtn) closeBtn.addEventListener('click', function () { setTaskPanel(false); });
    var scrim = $('#taskScrim');
    if (scrim) scrim.addEventListener('click', function () { setTaskPanel(false); });

    var newMsgBtn = $('#newMsgBtn');
    if (newMsgBtn) newMsgBtn.addEventListener('click', scrollToBottomNow);

    var backBtn = $('#btnBackRooms');
    if (backBtn) backBtn.addEventListener('click', function () { setView('rooms'); });
    $$('#mViewSwitch button').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
    });

    var scroller = $('#msgScroll');
    if (scroller) {
      scroller.addEventListener('scroll', function () {
        var atBottom = (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) < 96;
        if (atBottom && S.pendingNew) { S.pendingNew = 0; updateNewMsgBtn(); }
      }, { passive: true });
    }

    var copySelect = $('#btnCopySelect');
    if (copySelect) {
      copySelect.addEventListener('click', function () {
        var area = $('#copyText');
        if (!area) return;
        area.focus();
        area.select();
      });
    }

    $$('dialog').forEach(function (dlg) {
      dlg.addEventListener('click', function (ev) {
        if (ev.target === dlg) dlg.close();
      });
      $$('[data-close]', dlg).forEach(function (b) {
        b.addEventListener('click', function () { dlg.close(); });
      });
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if ($('dialog[open], [popover]:popover-open')) return;
      if (!$('#chatSearchPanel').hidden && S.view === 'chat') { toggleSearch('chat', false); return; }
      if (!$('#roomSearchBar').hidden && S.view === 'rooms') { toggleSearch('rooms', false); return; }
      if (S.taskPanelOpen && S.isOverlay) { setTaskPanel(false); return; }
      var active = document.activeElement;
      if (active && (active.id === 'roomSearch' || active.id === 'msgSearch')) return;
      if (S.view === 'chat') setView('rooms');
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') poll();
    });
    window.addEventListener('online', function () { poll(); });
    window.addEventListener('offline', function () {
      markConn(false, new Error('浏览器报告当前处于离线状态'));
      renderSync();
    });

    try {
      addMediaListener(window.matchMedia('(prefers-color-scheme: dark)'), function () {
        if (!S.themeStored) applyTheme(systemTheme());
      });
    } catch (e) { /* 不支持 matchMedia 时保持默认 */ }
    window.addEventListener('resize', debounce(function () { applyLayout(false); }, 150));
  }

  /* ---------------- 启动 ---------------- */
  var REQUIRED_IDS = [
    'app', 'connPill', 'connText', 'connTime', 'btnRefresh', 'btnPrivacy', 'themeToggle',
    'btnRoomSearch', 'roomSearchBar', 'btnMessageSearch', 'chatSearchPanel', 'appMenu', 'chatMenu',
    'roomCount', 'roomSearch', 'runningCount', 'roomList', 'roomListEmpty', 'statRooms', 'statRuns',
    'statRunning', 'statMessages', 'footDataDir', 'btnBackRooms', 'roomTitle', 'roomStatusPill',
    'roomStatusText', 'roomMetaMono', 'roomSync', 'taskFilter', 'msgSearch',
    'btnClearFilters', 'filterInfo', 'btnExport', 'btnRoomDetail', 'btnDeleteRoom', 'errorBanner',
    'errorText', 'btnRetry', 'msgWrap', 'msgScroll', 'msgList', 'msgEmpty', 'onboard', 'newMsgBtn',
    'newMsgText', 'dlgDelete', 'dlgDeleteTarget', 'dlgDeleteDetail', 'dlgDeleteError',
    'btnDeleteConfirm', 'dlgRoom', 'roomDetailBody', 'btnRoomDetailExport', 'dlgPrivacy', 'privacyDataDir',
    'dlgCopy', 'copyText', 'btnCopySelect', 'toastWrap'
  ];

  function checkDom() {
    var missing = REQUIRED_IDS.filter(function (id) { return !document.getElementById(id); });
    if (missing.length) {
      var msg = '页面缺少必要元素：' + missing.join('、');
      if (window.console && console.error) console.error(msg);
      showError(msg);
    }
    return missing;
  }

  function init() {
    checkDom();
    S.themeStored = storedTheme();
    applyTheme(S.themeStored || systemTheme());
    bindEvents();
    applyLayout(true);
    renderRooms();
    renderStats();
    renderPrivacy();
    renderHeader();
    renderMessages({ force: true, resetScroll: true });
    renderTaskPanel();
    renderConn();
    renderSync();
    renderChromeState();
    poll();
    setInterval(function () { poll(); }, POLL_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
