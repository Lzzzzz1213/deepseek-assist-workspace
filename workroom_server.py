"""本机协作观察台：只读取显式公开事件，不读取模型私有会话或推理。"""
import argparse
import ctypes
from datetime import datetime, timezone
import hashlib
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import itertools
import math
import os
from pathlib import Path
import re
import secrets
import stat
import threading
from urllib.parse import urlsplit
from workspace_groups import group_workspace_events
from workroom_storage import resolve_event_directory
from client_history import ClientHistory, HistoryError
from private_chat import PrivateChat, ChatError

APP = 'Codex DeepSeek Workroom'
VERSION = '1.4.4'
HEX = re.compile(r'^[0-9a-f]{32}$')
FILE = re.compile(r'^([0-9a-f]{32})\.jsonl$')
TYPES = {'task.created', 'task.running', 'message', 'tool', 'task.completed', 'review'}
DIALOGUE_TYPES = {'task.created', 'message', 'review'}
ACTORS = {'codex', 'deepseek', 'system', 'reviewer'}
MAX_FILE = 4 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
MAX_EVENTS = 50000
STATIC = {
    '/': ('web/index.html', 'text/html; charset=utf-8'),
    '/app.js': ('web/app.js', 'text/javascript; charset=utf-8'),
    '/app.css': ('web/app.css', 'text/css; charset=utf-8'),
    '/android.css': ('web/android.css', 'text/css; charset=utf-8'),
    '/markdown.js': ('web/markdown.js', 'text/javascript; charset=utf-8'),
    '/markdown.css': ('web/markdown.css', 'text/css; charset=utf-8'),
    '/portrait.css': ('web/portrait.css', 'text/css; charset=utf-8'),
    '/avatars.js': ('web/avatars.js', 'text/javascript; charset=utf-8'),
    '/avatars.css': ('web/avatars.css', 'text/css; charset=utf-8'),
    '/message-list.js': ('web/message-list.js', 'text/javascript; charset=utf-8'),
    '/message-list.css': ('web/message-list.css', 'text/css; charset=utf-8'),
    '/direct-chat.js': ('web/direct-chat.js', 'text/javascript; charset=utf-8'),
    '/direct-chat.css': ('web/direct-chat.css', 'text/css; charset=utf-8'),
    '/avatars/deepseek.png': ('web/assets/avatars/deepseek.png', 'image/png'),
    '/avatars/chatgpt.png': ('web/assets/avatars/chatgpt.png', 'image/png'),
    '/app-icon.png': ('web/assets/app/workroom.png', 'image/png'),
    '/vendor/markdown-it.min.js': ('web/vendor/markdown-it.min.js', 'text/javascript; charset=utf-8'),
    '/vendor/lanven-ui.tokens.css': ('web/vendor/lanven-ui.tokens.css', 'text/css; charset=utf-8'),
    '/vendor/lanven-ui.css': ('web/vendor/lanven-ui.css', 'text/css; charset=utf-8'),
}
CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def redact(value):
    """最终输出再次脱敏；这不能替代事件生产者只发送必要材料。"""
    if isinstance(value, str):
        value = re.sub(r'-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)', '[REDACTED PRIVATE KEY]', value, flags=re.S)
        value = re.sub(r'\bsk-[A-Za-z0-9_-]{8,}', '[REDACTED]', value)
        value = re.sub(r'(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [REDACTED]', value)
        return re.sub(r'''(?i)(\b(?:password|passwd|pwd|token|api[_-]?key|secret)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)''', r'\1[REDACTED]', value)
    if isinstance(value, list):
        return [redact(x) for x in value]
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    return value


def safe_path(path):
    """拒绝重解析点和硬链接，专用目录必须是普通本地目录。"""
    try:
        for item in [*reversed(path.parents), path]:
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                return False
            if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                return False
        return True
    except OSError:
        return False


def parent_alive(pid, creation):
    # 无身份信息时不能凭猜测结束任务；明确进程不存在/创建时间变化才显示中断。
    if not isinstance(pid, int) or isinstance(pid, bool) or not 0 < pid <= 0xffffffff:
        return True
    if os.name != 'nt':
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return ctypes.get_last_error() != 87
    try:
        code = wintypes.DWORD()
        if kernel.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value != 259:
            return False
        times = [wintypes.FILETIME() for _ in range(4)]
        if creation is not None and kernel.GetProcessTimes(handle, *(ctypes.byref(x) for x in times)):
            return ((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime) == int(creation)
        return True
    except (ValueError, TypeError):
        return True
    finally:
        kernel.CloseHandle(handle)


def public_event(raw, run_id):
    if not isinstance(raw, dict) or raw.get('v') != 1 or raw.get('runId') != run_id or not HEX.fullmatch(str(raw.get('roomId', ''))):
        return None
    kind, actor = raw.get('type'), raw.get('actor')
    if kind not in TYPES or actor not in ACTORS:
        return None
    payload = raw.get('payload')
    if not isinstance(payload, dict):
        payload = {}
    allowed = {
        'task.created': {'title', 'roomTitle', 'sourceThreadId', 'workingDirectory', 'mode', 'editableFiles', 'model', 'engine', 'parentPid', 'parentStartFileTime', 'grouping'},
        'task.running': set(), 'message': {'phase'}, 'tool': {'operation', 'path', 'result'},
        'task.completed': {'status', 'usage', 'durationSeconds', 'fileChanges'}, 'review': {'status'}
    }[kind]
    clean = {}
    for key in allowed:
        value = payload.get(key)
        if key == 'editableFiles' and isinstance(value, list):
            clean[key] = [x[:2000] for x in value[:200] if isinstance(x, str)]
        elif key == 'fileChanges' and isinstance(value, list):
            clean[key] = [{'path': x['path'][:2000], 'changed': x.get('changed') is True} for x in value[:200] if isinstance(x, dict) and isinstance(x.get('path'), str)]
        elif key == 'usage' and isinstance(value, dict):
            clean[key] = {k: v for k, v in value.items() if k in {'input_tokens', 'output_tokens', 'cached_input_tokens', 'total_tokens'} and type(v) in {int, float} and math.isfinite(v)}
        elif key in {'parentPid', 'parentStartFileTime', 'durationSeconds'} and type(value) in {int, float} and math.isfinite(value):
            clean[key] = value
        elif isinstance(value, str):
            clean[key] = value[:4000]
    if kind == 'message' and clean.get('phase', 'public') not in {'commentary', 'final', 'public'}:
        return None
    if kind == 'task.completed' and clean.get('status') not in {'success', 'failed', 'timeout', 'interrupted'}:
        return None
    if kind == 'review' and clean.get('status') not in {'passed', 'changes_requested', 'information'}:
        return None
    # 工具事件只展示元数据，拒绝复制任何原始工具输出、prompt 或 reasoning 字段。
    text = raw.get('text', '') if kind in {'task.created', 'message', 'review'} else ''
    return {'id': str(raw.get('eventId', ''))[:100], 'runId': run_id, 'roomId': raw['roomId'], 'type': kind, 'actor': actor, 'time': str(raw.get('time', ''))[:40], 'text': text[:120000] if isinstance(text, str) else '', 'payload': clean}


class EventStore:
    def __init__(self, data_dir, view_state_dir=None):
        self.path = Path(os.path.abspath(data_dir))
        self.history = ClientHistory(self.path, view_state_dir)
        self.lock = threading.RLock()
        self.cache = {}
        self.read_status = {'state': 'ok', 'files': 0, 'events': 0, 'skipped': 0, 'errors': []}

    def _load(self, hidden_runs=()):
        self.read_status = {'state': 'ok', 'files': 0, 'events': 0, 'skipped': 0, 'errors': []}
        def issue(message):
            self.read_status['state'] = 'error'
            if len(self.read_status['errors']) < 5:
                self.read_status['errors'].append(message)
        try:
            self.path.lstat()
        except FileNotFoundError:
            self.read_status['state'] = 'missing'
            return [], {}
        except OSError as error:
            issue('无法访问事件目录：' + type(error).__name__)
            return [], {}
        if not safe_path(self.path) or not self.path.is_dir():
            issue('事件目录不可读取或未通过安全检查')
            return [], {}
        events, snapshots, total = [], {}, 0
        try:
            # 先跳过客户端已隐藏任务，再计算读取上限，避免旧任务挤掉新任务。
            paths = sorted(itertools.islice((p for p in self.path.iterdir()
                           if FILE.fullmatch(p.name) and p.stem not in hidden_runs), 1000), key=lambda p: p.name)
        except OSError as error:
            issue('列出事件目录失败：' + type(error).__name__)
            return [], {}
        present = set()
        for path in paths:
            if not safe_path(path) or not path.is_file():
                self.read_status['skipped'] += 1
                continue
            try:
                info = path.stat()
                if info.st_size > MAX_FILE or total + info.st_size > MAX_TOTAL:
                    continue
                total += info.st_size
                self.read_status['files'] += 1
                signature = (info.st_mtime_ns, info.st_size, info.st_ino)
                run = FILE.fullmatch(path.name).group(1)
                present.add(run)
                old = self.cache.get(run)
                # 空解析结果不作为稳定缓存，避免首次不完整读取后一直显示空群组。
                if old and old[0] == signature and old[1]:
                    parsed = old[1]
                else:
                    data = path.read_bytes()
                    if len(data) > MAX_FILE:
                        continue
                    parsed = []
                    # 写入中的最后半行不算损坏；仅处理有换行结束的完整事件。
                    for line in data.splitlines(keepends=True):
                        if not line.endswith((b'\n', b'\r')) or len(line) > 1024 * 1024:
                            continue
                        try:
                            item = public_event(json.loads(line), run)
                            if item:
                                parsed.append(item)
                        except (ValueError, TypeError, RecursionError):
                            continue
                        if len(parsed) >= MAX_EVENTS:
                            break
                    self.cache[run] = (signature, parsed)
                # 同一 run 混入多个群会破坏删除边界，整份忽略。
                if len({x['roomId'] for x in parsed}) > 1:
                    continue
                snapshots[run] = signature
                events.extend(parsed[:MAX_EVENTS - len(events)])
                if len(events) >= MAX_EVENTS:
                    break
            except OSError as error:
                issue('读取事件文件失败：' + type(error).__name__ + ' / ' + str(getattr(error, 'winerror', error.errno)))
                continue
        self.cache = {k: v for k, v in self.cache.items() if k in present}
        self.read_status['events'] = len(events)
        if self.read_status['files'] and not events:
            issue('发现事件文件，但没有解析出公开记录')
        elif self.read_status['skipped'] and not events:
            issue('事件文件未通过安全检查')
        return events, snapshots

    def snapshot(self, include_hidden=False):
        with self.lock:
            try:
                hidden_runs = set() if include_hidden else self.history.load()
                events, signatures = self._load(hidden_runs)
            except HistoryError as error:
                events, signatures, hidden_runs = [], {}, set()
                self.read_status = {'state': 'error', 'files': 0, 'events': 0, 'skipped': 0, 'errors': [str(error)]}
            # 只重组展示副本，原始任务文件与缓存保持不变。
            events = group_workspace_events(events)
            # 相同时刻保留同文件追加顺序，UUID 不代表事件先后。
            events.sort(key=lambda e: e['time'])
            runs = {}
            room_meta = {}
            for event in events:
                rid = event['runId']
                if rid not in runs:
                    runs[rid] = {'id': rid, 'title': '协作任务', 'status': 'running', 'mode': '', 'model': '', 'engine': '', 'startedAt': event['time'], 'completedAt': None, 'usage': {}, 'durationSeconds': None, 'editableFiles': [], 'fileChanges': [], '_room': event['roomId'], '_parent': None, '_creation': None}
                run = runs[rid]
                p = event['payload']
                if event['type'] == 'task.created':
                    for key in ('title', 'mode', 'model', 'engine', 'editableFiles', 'sourceThreadId', 'workingDirectory'):
                        if key in p:
                            run[key] = p[key]
                    run['_parent'], run['_creation'] = p.get('parentPid'), p.get('parentStartFileTime')
                    room_meta[event['roomId']] = p
                elif event['type'] == 'task.completed':
                    run.update(status=p['status'], completedAt=event['time'], usage=p.get('usage', {}), durationSeconds=p.get('durationSeconds'), fileChanges=p.get('fileChanges', []))
            for run in runs.values():
                if run['completedAt'] is None and not parent_alive(run['_parent'], run['_creation']):
                    run['status'] = 'interrupted'
            rooms = []
            for room_id in {x['_room'] for x in runs.values()}:
                related = [r for r in runs.values() if r['_room'] == room_id]
                messages = [e for e in events if e['roomId'] == room_id and e['type'] in DIALOGUE_TYPES]
                meta = room_meta.get(room_id, {})
                latest = max(related, key=lambda r: r['startedAt'])
                updated = max([m['time'] for m in messages] + [r['completedAt'] or r['startedAt'] for r in related])
                sources = sorted({r.get('sourceThreadId', '') for r in related} - {''})
                rooms.append({
                    'id': room_id,
                    'title': meta.get('workspaceTitle') or meta.get('roomTitle', '项目协作群'),
                    'project': meta.get('workspaceDirectory') or meta.get('workingDirectory', ''),
                    'sourceThreadId': sources[0] if len(sources) == 1 else '',
                    'sourceThreadIds': sources,
                    'updatedAt': updated,
                    'status': 'running' if any(r['status'] == 'running' for r in related) else latest['status'],
                    'runCount': len(related), 'messageCount': len(messages),
                    'preview': next((m['text'][:160] for m in reversed(messages) if m['text']), ''),
                    'grouping': meta.get('grouping', 'project'),
                    'clearRevision': hashlib.sha256(json.dumps(
                        sorted((r['id'], signatures.get(r['id']), r['status']) for r in related)
                    ).encode()).hexdigest()[:20],
                })
            rooms.sort(key=lambda r: r['updatedAt'], reverse=True)
            revision = hashlib.sha256(json.dumps([signatures, sorted(hidden_runs),
                [(r['id'], r['status']) for r in runs.values()], self.read_status['state']], sort_keys=True).encode()).hexdigest()[:20]
            return {'revision': revision, 'rooms': rooms, 'runs': runs, 'messages': events, '_signatures': signatures}

    def state(self):
        snap = self.snapshot()
        return redact({'revision': snap['revision'], 'rooms': snap['rooms'], 'stats': {'rooms': len(snap['rooms']), 'runs': len(snap['runs']), 'running': sum(r['status'] == 'running' for r in snap['runs'].values()), 'messages': sum(e['type'] in DIALOGUE_TYPES for e in snap['messages'])}, 'privacy': {'dataDirectory': str(self.path), 'localOnly': True, 'readStatus': self.read_status, 'sourceReadOnly': True, 'deletionScope': 'client-only'}})

    def detail(self, room_id, snap=None):
        snap = snap or self.snapshot()
        room = next((r for r in snap['rooms'] if r['id'] == room_id), None)
        if room is None:
            return None
        return redact({'revision': snap['revision'], 'room': room, 'runs': [{k: v for k, v in r.items() if not k.startswith('_')} for r in snap['runs'].values() if r['_room'] == room_id], 'messages': [{k: v for k, v in e.items() if k != 'roomId'} for e in snap['messages'] if e['roomId'] == room_id and e['type'] in DIALOGUE_TYPES]})

    def delete(self, room_id, expected_revision=None):
        with self.lock:
            snap = self.snapshot()
            if self.read_status['state'] != 'ok':
                return 409, {'error': '记录或客户端删除标记读取不完整，暂不能删除'}
            runs = [r for r in snap['runs'].values() if r['_room'] == room_id]
            if not runs:
                return 404, {'error': '群不存在'}
            if any(r['status'] == 'running' for r in runs):
                return 409, {'error': '正在进行的任务不能删除'}
            if not isinstance(expected_revision, str) or not re.fullmatch(r'[0-9a-f]{20}', expected_revision):
                return 400, {'error': '请先刷新并确认客户端删除范围'}
            room = next(r for r in snap['rooms'] if r['id'] == room_id)
            if not secrets.compare_digest(expected_revision, room['clearRevision']):
                return 409, {'error': '本群对话已更新，请关闭对话框后重新确认'}
            # 全部校验后才原子保存隐藏标记；原始事件文件没有任何写入路径。
            for run in runs:
                path = self.path / (run['id'] + '.jsonl')
                if not safe_path(self.path) or not safe_path(path) or not FILE.fullmatch(path.name):
                    return 409, {'error': '记录状态已变化，请刷新后重试'}
                try:
                    info = path.stat()
                    if (info.st_mtime_ns, info.st_size, info.st_ino) != snap['_signatures'].get(run['id']):
                        return 409, {'error': '本群对话已更新，请重新确认'}
                except OSError:
                    return 409, {'error': '无法核对原始记录，客户端删除未执行'}
            try:
                removed = self.history.hide(r['id'] for r in runs)
            except HistoryError as error:
                return 409, {'error': str(error)}
            return 200, {'deleted': removed, 'scope': 'client-only', 'sourcePreserved': True}


class WorkroomServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, data_dir, static_root=None, view_state_dir=None, chat_provider=None):
        self.store = EventStore(data_dir, view_state_dir=view_state_dir)
        super().__init__(('127.0.0.1', port), Handler)
        self.static_root = Path(static_root or Path(__file__).parent)
        self.token = secrets.token_urlsafe(32)
        self._private_chat = None
        self._private_lock = threading.Lock()
        self._chat_provider = chat_provider
        # 表情只能来自打包时固定的本地目录，聊天内容不能指定任意图片地址。
        from private_chat import sticker_catalog
        self.sticker_catalog = sticker_catalog(self.static_root)
        self.static_routes = dict(STATIC)
        for item in self.sticker_catalog.values():
            suffix = Path(item['file']).suffix
            mime = {'.webp': 'image/webp', '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg'}[suffix]
            self.static_routes[item['url']] = ('web/assets/stickers/' + item['file'], mime)

    def private_chat(self):
        with self._private_lock:
            if self._private_chat is None:
                def work_snapshot():
                    snap = self.store.snapshot(include_hidden=True)
                    snap['_readStatus'] = self.store.read_status['state']
                    return snap
                self._private_chat = PrivateChat(self.store.history.directory.parent, self.store.path,
                    work_snapshot, self.static_root, provider=self._chat_provider)
                self._private_chat.start()
            return self._private_chat

    def serve_forever(self, poll_interval=0.5):
        # 调度与网页打开状态无关；私聊存储故障不能阻断原有工作群服务。
        try:
            self.private_chat()
        except Exception:
            pass
        super().serve_forever(poll_interval)

    def server_close(self):
        if self._private_chat is not None:
            self._private_chat.close()
        super().server_close()

    def handle_error(self, request, client_address):
        # 不把请求、路径、事件内容或 traceback 送入控制台日志。
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = 'Workroom/1'

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_):
        pass

    def send(self, code, body, content_type='application/json; charset=utf-8', extra=None):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8') if isinstance(body, (dict, list)) else body
        self.send_response(code)
        for name, value in {'Content-Type': content_type, 'Content-Length': str(len(data)), 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', **(extra or {})}.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def guard(self):
        port = self.server.server_address[1]
        host = self.headers.get('Host', '')
        if len(self.headers.get_all('Host', [])) != 1 or host not in {f'127.0.0.1:{port}', f'localhost:{port}'}:
            self.send(403, {'error': 'Host rejected'})
            return False
        origin = self.headers.get('Origin')
        if (origin and origin != 'http://' + host) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self.send(403, {'error': 'Origin rejected'})
            return False
        return True

    def authorized(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
            supplied = cookie.get('workroom_session')
            okay = supplied is not None and secrets.compare_digest(supplied.value, self.server.token)
        except Exception:
            okay = False
        return okay and self.headers.get('X-Workroom-Client') == '1'

    def route(self):
        if not self.guard():
            return
        url = urlsplit(self.path)
        path = url.path
        if url.scheme or url.netloc or '%' in path or '\\' in path or '..' in path or url.query:
            return self.send(404, {'error': 'Not found'})
        if path == '/health' and self.command == 'GET':
            return self.send(200, {'application': APP, 'version': VERSION})
        if path == '/favicon.ico' and self.command == 'GET':
            return self.send(204, b'', 'image/x-icon')
        if path.startswith('/api/'):
            if not self.authorized():
                return self.send(403, {'error': 'Client authorization required'})
            if self.command not in {'GET', 'DELETE', 'POST'}:
                return self.send(405, {'error': 'Method not allowed'})
            if self.command == 'POST' and path not in {'/api/private-chat/messages', '/api/private-chat/retry',
                    '/api/private-chat/proactive', '/api/private-chat/activity', '/api/private-chat/notifications'}:
                return self.send(405, {'error': 'Method not allowed'})
            if self.command in {'DELETE', 'POST'}:
                if self.headers.get_content_type() != 'application/json':
                    return self.send(415, {'error': 'JSON required'})
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    maximum = 32768 if path.startswith('/api/private-chat') else 1024
                    if not 0 < size <= maximum or self.headers.get('Transfer-Encoding'):
                        raise ValueError()
                    raw = self.rfile.read(size)
                    if len(raw) != size:
                        raise ValueError()
                    body = json.loads(raw)
                    if not isinstance(body, dict):
                        raise ValueError()
                except (ValueError, json.JSONDecodeError):
                    return self.send(400, {'error': 'Invalid JSON'})
            if path.startswith('/api/private-chat'):
                try:
                    if path == '/api/private-chat/stickers' and self.command == 'GET':
                        return self.send(200, {'stickers': [{k: v for k, v in x.items() if k != 'file'}
                                                          for x in self.server.sticker_catalog.values()]})
                    chat = self.server.private_chat()
                    if path == '/api/private-chat' and self.command == 'GET':
                        return self.send(200, chat.state())
                    if path == '/api/private-chat' and self.command == 'DELETE':
                        return self.send(200, chat.memory.clear(body.get('revision')))
                    if path == '/api/private-chat/messages' and self.command == 'POST':
                        if not isinstance(body.get('generation'), str):
                            return self.send(400, {'error': '缺少聊天代次，请刷新后再发'})
                        return self.send(202, chat.send(body.get('id'), body.get('text'), body['generation']))
                    if path == '/api/private-chat/retry' and self.command == 'POST':
                        if not isinstance(body.get('generation'), str):
                            return self.send(400, {'error': '缺少聊天代次，请刷新后再试'})
                        return self.send(202, chat.retry(body.get('id'), body['generation']))
                    if path == '/api/private-chat/inbox' and self.command == 'GET':
                        return self.send(200, chat.proactive.inbox())
                    if path == '/api/private-chat/proactive' and self.command == 'POST':
                        return self.send(200, chat.configure_proactive(body.get('enabled')))
                    if path == '/api/private-chat/activity' and self.command == 'POST':
                        return self.send(200, chat.activity(body))
                    if path == '/api/private-chat/notifications' and self.command == 'POST':
                        return self.send(200, chat.claim_notification(body.get('id')))
                    history = re.fullmatch(r'/api/private-chat/history/([1-9][0-9]{0,15})', path)
                    if history and self.command == 'GET':
                        return self.send(200, chat.state(int(history.group(1))))
                    return self.send(404, {'error': 'Not found'})
                except ChatError as error:
                    return self.send(error.status, {'error': str(error)})
                except Exception:
                    return self.send(503, {'error': '私聊记忆暂不可用，请稍后再试；工作任务不受影响'})
            if path == '/api/state' and self.command == 'GET':
                return self.send(200, self.server.store.state())
            match = re.fullmatch(r'/api/rooms/([0-9a-f]{32})(/export)?', path)
            if match:
                room_id, export = match.groups()
                if self.command == 'DELETE' and not export:
                    status, result = self.server.store.delete(room_id, body.get('revision'))
                    return self.send(status, result)
                if self.command == 'GET':
                    result = self.server.store.detail(room_id)
                    if result is None:
                        return self.send(404, {'error': '群不存在'})
                    return self.send(200, result, extra={'Content-Disposition': f'attachment; filename="workroom-{room_id}.json"'} if export else None)
            return self.send(404, {'error': 'Not found'})
        if self.command != 'GET':
            return self.send(405, {'error': 'Method not allowed'})
        if path not in self.server.static_routes:
            return self.send(404, {'error': 'Not found'})
        if path == '/' and self.headers.get('Sec-Fetch-Dest', 'document') not in {'document', ''}:
            return self.send(403, {'error': 'Top-level navigation required'})
        relative, mime = self.server.static_routes[path]
        file = self.server.static_root / relative
        try:
            if not safe_path(file) or not file.is_file():
                raise OSError()
            content = file.read_bytes()
        except OSError:
            return self.send(404, {'error': 'Static file unavailable'})
        return self.send(200, content, mime, {'Set-Cookie': f'workroom_session={self.server.token}; HttpOnly; SameSite=Strict; Path=/'} if path == '/' else None)

    def do_GET(self):
        self.route()

    do_DELETE = do_GET
    do_POST = do_GET
    do_OPTIONS = do_GET
    do_PUT = do_GET
    do_PATCH = do_GET
    do_HEAD = do_GET


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18765)
    parser.add_argument('--data-dir', default=None)
    parser.add_argument('--view-state-dir', default=None)
    parser.add_argument('--runtime-file')
    args = parser.parse_args()
    # 显式目录始终优先；普通启动自动定位 Codex 打包环境重定向后的公开记录。
    server = WorkroomServer(args.port, args.data_dir if args.data_dir is not None else resolve_event_directory(),
                            view_state_dir=args.view_state_dir)
    base_url = f'http://127.0.0.1:{server.server_address[1]}'
    if args.runtime_file:
        startup = server.store.state()
        Path(args.runtime_file).write_text(json.dumps({'pid': os.getpid(), 'port': server.server_address[1], 'startedAt': utc_now(), 'baseUrl': base_url, 'dataDirectory': startup['privacy']['dataDirectory'], 'dataStats': startup['stats'], 'readStatus': startup['privacy']['readStatus']}), encoding='utf-8')
    print(base_url, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
