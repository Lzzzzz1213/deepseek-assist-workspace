"""仅保存客户端的对话隐藏标记，原始协作记录始终只读。"""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time


RUN_ID = re.compile(r'^[0-9a-f]{32}$')
MAX_MARKS = 50000
MAX_BYTES = 2 * 1024 * 1024


class HistoryError(Exception):
    """客户端标记无法安全读取或保存；不以覆盖文件作为回退。"""


def _codex_component(path):
    return any(part.lower() in {'.codex', 'codexdeepseekhelper'}
               or part.lower().startswith('openai.codex_') for part in path.parts)


def default_view_state_dir():
    local = Path(os.environ.get('LOCALAPPDATA') or Path.home() / '.local' / 'share')
    if _codex_component(local):
        local = Path(os.environ.get('USERPROFILE') or Path.home()) / 'AppData' / 'Local'
    return local / 'DeepSeekAssistWorkspace'


def _normalized_directory(value):
    """先拒绝 Win32 路径别名，再折叠点段，分离检查与实际写入使用同一路径。"""
    path = Path(value)
    if os.name == 'nt':
        if str(path).startswith(('\\\\?\\', '\\\\.\\')):
            raise HistoryError('客户端记录路径不能使用设备或扩展路径别名')
        for part in path.parts:
            if part == path.anchor or part in {'.', '..'}:
                continue
            if (part.endswith(('.', ' ')) or ':' in part
                    or re.fullmatch(r'(?i:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\..*)?', part)):
                raise HistoryError('客户端记录路径不能使用 Windows 文件别名')
    return Path(os.path.abspath(path))


def _ordinary(path, directory=False):
    """允许尚未创建的路径，拒绝链接、重解析点及文件硬链接。"""
    for item in [*reversed(path.parents), path]:
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise HistoryError('客户端删除标记路径未通过安全检查')
        is_directory = item != path or directory
        if is_directory and not stat.S_ISDIR(info.st_mode):
            raise HistoryError('客户端删除标记目录不可用')
        if not is_directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
            raise HistoryError('客户端删除标记文件未通过安全检查')


class ClientHistory:
    def __init__(self, event_directory, view_state_dir=None):
        source = _normalized_directory(event_directory)
        root = _normalized_directory(view_state_dir if view_state_dir is not None else default_view_state_dir())
        self.directory = root / 'client-history'
        # 标记必须位于独立的客户端目录，不能指向原始记录树或 Codex 目录。
        if (_codex_component(self.directory) or self.directory.is_relative_to(source)
                or source.is_relative_to(self.directory)):
            raise HistoryError('客户端删除标记目录必须与原始记录及 Codex 目录分离')
        scope = hashlib.sha256(os.path.normcase(str(source)).encode('utf-8')).hexdigest()[:32]
        self.path = self.directory / ('hidden-runs-' + scope + '.json')
        self.lock_path = self.path.with_suffix('.lock')

    def load(self):
        """缺少标记表示未删除；损坏和权限错误必须报告，不自动重置。"""
        try:
            _ordinary(self.path)
            try:
                size = self.path.stat().st_size
            except FileNotFoundError:
                return set()
            if size > MAX_BYTES:
                raise HistoryError('客户端删除标记超过大小限制')
            data = self.path.read_bytes()
            if len(data) > MAX_BYTES:
                raise HistoryError('客户端删除标记超过大小限制')
            document = json.loads(data)
            values = document.get('hiddenRuns') if isinstance(document, dict) else None
            if (not isinstance(document, dict) or type(document.get('v')) is not int
                    or document['v'] != 1 or not isinstance(values, list) or len(values) > MAX_MARKS
                    or any(not isinstance(value, str) or not RUN_ID.fullmatch(value) for value in values)):
                raise HistoryError('客户端删除标记格式不正确')
            return set(values)
        except (OSError, ValueError, RecursionError) as error:
            raise HistoryError('无法读取客户端删除标记，原始记录未改动') from error

    @contextmanager
    def _write_lock(self):
        """跨客户端串行合并标记，防止两个窗口的清空操作互相覆盖。"""
        _ordinary(self.directory, directory=True)
        self.directory.mkdir(parents=True, exist_ok=True)
        _ordinary(self.lock_path)
        descriptor = os.open(self.lock_path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        acquired = False
        try:
            _ordinary(self.lock_path)
            info, entry = os.fstat(descriptor), self.lock_path.stat()
            if info.st_nlink != 1 or (info.st_dev, info.st_ino) != (entry.st_dev, entry.st_ino):
                raise HistoryError('客户端删除标记锁未通过安全检查')
            if os.name == 'nt':
                import msvcrt
                take = lambda: msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                release = lambda: msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                take = lambda: fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                release = lambda: fcntl.flock(descriptor, fcntl.LOCK_UN)
            deadline = time.monotonic() + 2
            while True:
                try:
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    take()
                    acquired = True
                    break
                except OSError as error:
                    if time.monotonic() >= deadline:
                        raise HistoryError('其他客户端正在更新删除标记，请稍后重试') from error
                    time.sleep(0.05)
            yield
        finally:
            try:
                if acquired:
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    release()
            finally:
                os.close(descriptor)

    def hide(self, run_ids):
        """一次原子提交整个选择，只写本应用标记，不接触来源文件。"""
        selected = set(run_ids)
        if any(not isinstance(value, str) or not RUN_ID.fullmatch(value) for value in selected):
            raise HistoryError('客户端删除目标无效')
        temporary = None
        try:
            with self._write_lock():
                values = self.load() | selected
                if len(values) > MAX_MARKS:
                    raise HistoryError('客户端删除标记数量超过限制')
                content = json.dumps({'v': 1, 'hiddenRuns': sorted(values)}, separators=(',', ':')).encode('utf-8')
                with tempfile.NamedTemporaryFile(prefix=self.path.stem + '-', suffix='.tmp',
                                                 dir=self.directory, delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                _ordinary(self.path)
                os.replace(temporary, self.path)
                temporary = None
        except OSError as error:
            raise HistoryError('无法保存客户端删除标记，原始记录未改动') from error
        finally:
            if temporary is not None:
                # 只回收本次在客户端目录创建的临时标记文件。
                try:
                    _ordinary(temporary)
                    temporary.unlink(missing_ok=True)
                except (OSError, HistoryError):
                    pass
        return len(selected)
