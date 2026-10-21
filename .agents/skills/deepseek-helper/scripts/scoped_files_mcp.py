"""供辅助 Agent 使用的限定文件 MCP；不提供进程、网络或删除能力。"""
import argparse
import fnmatch
import hashlib
import json
import ntpath
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time

MAX_BYTES = 1024 * 1024
MAX_CHARS = 32000
BLOCKED = {'.git', '.codex', '.claude', 'node_modules', 'target', 'dist', '.runtime', '.local', '__pycache__', 'secrets', '.secrets'}
SECRET = re.compile(r'sk-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----')
WRITE_TOOLS = {'write_file', 'replace_text'}


class Denied(Exception):
    pass


def text_format(text):
    """只识别真实换行，不把源码字符串中的反斜杠当作转义指令。"""
    crlf = text.count('\r\n')
    lf = text.count('\n') - crlf
    cr = text.count('\r') - crlf
    kinds = [name for name, count in [('CRLF', crlf), ('LF', lf), ('CR', cr)] if count]
    return kinds[0] if len(kinds) == 1 else 'mixed' if kinds else 'none'


def preserve_newlines(content, style):
    """统一原有行尾时只转换实际控制字符，绝不进行 unicode_escape 二次解码。"""
    if style in {'CRLF', 'LF', 'CR'}:
        content = content.replace('\r\n', '\n').replace('\r', '\n')
        return content.replace('\n', {'CRLF': '\r\n', 'LF': '\n', 'CR': '\r'}[style])
    return content


def page_count(lines):
    """与 read_file 的完整行/字符上限同口径估算完整读取次数。"""
    pages, size, count = 0, 0, 0
    for line in lines:
        if len(line) > MAX_CHARS:
            raise Denied('line_exceeds_character_limit')
        if count and (count >= 1000 or size + len(line) > MAX_CHARS):
            pages += 1
            size, count = 0, 0
        size += len(line)
        count += 1
    return max(1, pages + bool(count))


def validate_raw_path(value):
    """归一化前拒绝 Win32 别名，避免屏蔽规则及文件锁按不同字符串识别同一实体。"""
    raw = str(value)
    if '\x00' in raw or raw.startswith(('\\\\?\\', '\\\\.\\')):
        raise Denied('invalid_path')
    drive, tail = ntpath.splitdrive(raw)
    if drive and not re.fullmatch(r'[A-Za-z]:', drive):
        raise Denied('invalid_path')
    if drive and not tail.startswith(('\\', '/')):
        raise Denied('invalid_path')
    for part in re.split(r'[\\/]', tail):
        if not part or part in {'.', '..'}:
            continue
        if part.endswith(('.', ' ')) or ':' in part:
            raise Denied('invalid_path')
        base = part.split('.', 1)[0].rstrip(' ').upper()
        if base in {'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'} or re.fullmatch(r'(?:COM|LPT)[0-9¹²³]', base):
            raise Denied('invalid_path')


def reject_short_alias(path):
    """Win32 8.3 别名会绕过保护目录和锁键；仅拒绝实体别名，允许普通含 ~ 文件名。"""
    if os.name != 'nt':
        return
    import ctypes
    from ctypes import wintypes
    target = path if path.exists() else path.parent
    api = ctypes.WinDLL('kernel32', use_last_error=True).GetLongPathNameW
    api.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    api.restype = wintypes.DWORD
    length = api(str(target), None, 0)
    if not length:
        raise Denied('path_identity_failed')
    buffer = ctypes.create_unicode_buffer(length)
    written = api(str(target), buffer, length)
    if not written or written >= length:
        raise Denied('path_identity_failed')
    if os.path.normcase(os.path.abspath(buffer.value)) != os.path.normcase(str(target)):
        raise Denied('short_path_alias_rejected')


def process_identity():
    """以 PID 和进程创建 FILETIME 防止父入口误认复用后的 PID。"""
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    created, exited, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
    if not kernel.GetProcessTimes(kernel.GetCurrentProcess(), ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel_time), ctypes.byref(user_time)):
        raise Denied('process_identity_failed')
    return {'pid': os.getpid(), 'startTimeFileTime': (created.dwHighDateTime << 32) | created.dwLowDateTime}


def blocked(name):
    low = name.lower()
    return low in BLOCKED or low.startswith('.env') or Path(low).suffix in {'.pem', '.key', '.clixml', '.pfx', '.p12'}


class Service:
    def __init__(self, config):
        validate_raw_path(config['root'])
        for path in config.get('editableFiles', []):
            validate_raw_path(path)
        self.root = Path(os.path.abspath(config['root']))
        self.editable = {os.path.normcase(os.path.abspath(p)) for p in config.get('editableFiles', [])}
        self.limit = int(config.get('maxCalls', 100))
        self.calls = 0
        self.read_hashes = {}
        self.read_coverage = {}
        self.written = set()
        self.descriptions = {}
        self.audit = Path(config['auditPath'])
        self.check(self.root)
        if not self.root.is_dir() or not 1 <= self.limit <= 10000:
            raise Denied('invalid_configuration')
        for p in self.editable:
            self.check(p, missing=True)
            target = Path(p)
            if target.exists():
                data, text = self.read_bytes(target)
                self.descriptions[p] = {'path': str(target.relative_to(self.root)), 'exists': True,
                    'bytes': len(data), 'total_lines': len(text.splitlines(keepends=True)),
                    'read_calls': page_count(text.splitlines(keepends=True)),
                    'line_ending': text_format(text), 'utf8_bom': data.startswith(b'\xef\xbb\xbf')}
            else:
                self.descriptions[p] = {'path': str(target.relative_to(self.root)), 'exists': False,
                    'bytes': 0, 'total_lines': 0, 'read_calls': 1, 'line_ending': 'none', 'utf8_bom': False}
        if config.get('pidPath'):
            # pidPath 来自父入口的私有运行目录，不接受模型工具参数覆盖。
            validate_raw_path(config['pidPath'])
            with Path(config['pidPath']).open('x', encoding='utf-8') as stream:
                json.dump(process_identity(), stream)

    def preflight(self):
        minimum = sum(2 * d['read_calls'] + 1 if d['exists'] else 2 for d in self.descriptions.values())
        return {'minimum_calls': minimum, 'max_calls': self.limit, 'affordable': minimum <= self.limit,
                'files': list(self.descriptions.values())}

    def budget(self):
        """交付预留是保守估计；内容变长和错误请求仍可能消耗更多额度。"""
        reserve = 0
        for key, info in self.descriptions.items():
            complete = key in self.read_hashes and len(self.read_coverage.get(key, set())) == info['total_lines']
            if key in self.written:
                reserve += 0 if complete else info['read_calls']
            else:
                reserve += (0 if complete or not info['exists'] else info['read_calls']) + 1 + info['read_calls']
        return {'used': self.calls, 'remaining': max(0, self.limit - self.calls), 'delivery_reserve': reserve}

    def check(self, value, missing=False):
        if not isinstance(value, (str, Path)):
            raise Denied('invalid_path')
        raw = str(value)
        validate_raw_path(raw)
        p = Path(os.path.abspath(self.root / raw))
        try:
            rel = p.relative_to(self.root)
        except ValueError:
            raise Denied('outside_root')
        if any(blocked(part) for part in rel.parts) or SECRET.search(str(rel)):
            raise Denied('protected_path')
        # 检查全部祖先，拒绝符号链接、junction、其他重解析点及硬链接。
        for item in [*reversed(p.parents), p]:
            try:
                info = item.lstat()
            except FileNotFoundError:
                if item == p and missing and p.parent.is_dir():
                    continue
                raise Denied('missing_path')
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise Denied('link_rejected')
            if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                raise Denied('hardlink_rejected')
        reject_short_alias(p)
        return p

    def read_bytes(self, p):
        p = self.check(p)
        if not p.is_file() or p.stat().st_size > MAX_BYTES:
            raise Denied('not_small_text_file')
        data = p.read_bytes()
        if len(data) > MAX_BYTES or b'\x00' in data:
            raise Denied('not_small_text_file')
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise Denied('not_utf8')
        if SECRET.search(text):
            raise Denied('sensitive_content')
        return data, text

    def files(self, path, pattern):
        base = self.check(path)
        if base.is_file():
            yield base
            return
        seen = 0
        for directory, dirs, names in os.walk(base, followlinks=False):
            dirs[:] = [d for d in dirs if not blocked(d) and self.safe(Path(directory) / d)]
            for name in names:
                seen += 1
                if seen > 10000:
                    return
                p = Path(directory) / name
                if not blocked(name) and fnmatch.fnmatch(name, pattern) and self.safe(p):
                    yield p

    def safe(self, p):
        try:
            self.check(p)
            return True
        except Denied:
            return False

    def operate(self, name, args):
        before = self.budget()
        self.calls += 1
        if self.calls > self.limit:
            raise Denied('call_limit')
        schemas = {t['name']: t['inputSchema'] for t in self.tools()}
        if name not in schemas:
            raise Denied('tool_not_allowed')
        schema = schemas[name]
        if not isinstance(args, dict) or set(args) - set(schema['properties']) or any(k not in args for k in schema.get('required', [])):
            raise Denied('invalid_arguments')
        for key, value in args.items():
            kind = schema['properties'][key]['type']
            valid = (kind == 'string' and isinstance(value, str)) or (kind == 'integer' and type(value) is int) or (kind == ['string', 'null'] and (value is None or isinstance(value, str)))
            if not valid:
                raise Denied('invalid_arguments')
        path = args.get('path', '.')
        if self.editable and (name in {'list_files', 'search_text'} or
                name == 'read_file' and os.path.normcase(os.path.abspath(self.root / path)) not in self.editable):
            if before['remaining'] <= before['delivery_reserve'] + 1:
                raise Denied('delivery_budget_reserved')
        if name == 'read_file':
            p = self.check(path)
            data, text = self.read_bytes(p)
            start, count = args.get('start_line', 1), args.get('max_lines', 1000)
            if not 1 <= start or not 1 <= count <= 1000:
                raise Denied('invalid_line_range')
            lines = text.splitlines(keepends=True)
            key = os.path.normcase(str(p))
            digest = hashlib.sha256(data).hexdigest()
            if self.read_hashes.get(key) != digest:
                self.read_coverage[key] = set()
            self.read_hashes[key] = digest
            # 字符预算只收纳完整行；分页累计覆盖，避免仅看到前半文件便覆盖全文。
            chosen = []
            length = 0
            truncated = False
            for line in lines[start - 1:start - 1 + count]:
                if length + len(line) > MAX_CHARS:
                    truncated = True
                    break
                chosen.append(line)
                length += len(line)
            end = start - 1 + len(chosen)
            self.read_coverage[key].update(range(start, end + 1))
            complete = len(self.read_coverage[key]) == len(lines)
            if key in self.descriptions:
                self.descriptions[key].update(total_lines=len(lines), read_calls=page_count(lines))
            return {'path': str(p.relative_to(self.root)), 'sha256': digest, 'total_lines': len(lines), 'start_line': start, 'end_line': end, 'content': ''.join(chosen), 'truncated': truncated, 'has_more': end < len(lines), 'next_start_line': end + 1 if end < len(lines) else None, 'full_file_read': complete,
                    'line_ending': text_format(text), 'utf8_bom': data.startswith(b'\xef\xbb\xbf')}
        if name in {'list_files', 'search_text'}:
            results = []
            query = args.get('query', '')
            if name == 'search_text' and (not query or len(query) > 500 or SECRET.search(query)):
                raise Denied('invalid_query')
            for p in self.files(path, args.get('pattern', '*')):
                relative = str(p.relative_to(self.root))
                if name == 'list_files':
                    results.append(relative)
                else:
                    try:
                        _, text = self.read_bytes(p)
                    except Denied:
                        continue
                    for line_no, line in enumerate(text.splitlines(), 1):
                        if query in line:
                            results.append({'path': relative, 'line': line_no, 'text': line[:300]})
                            if len(results) >= 100:
                                break
                if len(results) >= 100:
                    break
            return {'results': results, 'limit_reached': len(results) >= 100}
        p = self.check(path, missing=True)
        if os.path.normcase(str(p)) not in self.editable:
            raise Denied('write_outside_allowlist')
        expected = args['expected_sha256']
        old = b''
        old_text = ''
        if p.exists():
            old, old_text = self.read_bytes(p)
            if expected != hashlib.sha256(old).hexdigest() or self.read_hashes.get(os.path.normcase(str(p))) != expected:
                raise Denied('hash_conflict')
            if len(self.read_coverage.get(os.path.normcase(str(p)), set())) != len(old.decode('utf-8-sig').splitlines(keepends=True)):
                raise Denied('full_read_required')
        elif expected is not None:
            raise Denied('new_file_requires_null_hash')
        style = text_format(old_text)
        if name == 'replace_text':
            if not p.exists():
                raise Denied('replace_requires_existing_file')
            needle = preserve_newlines(args['old_text'], style)
            replacement = preserve_newlines(args['new_text'], style)
            if not needle or old_text.count(needle) != 1:
                raise Denied('replacement_not_unique')
            content = old_text.replace(needle, replacement, 1)
        else:
            content = args['content']
            if style == 'mixed' and text_format(content) != 'mixed':
                raise Denied('mixed_newline_requires_replace_text')
            content = preserve_newlines(content, style)
        # 两个写工具共用防护；整份替换也不能绕过多行文件的双重转义检查。
        if len(old_text.splitlines()) > 1 and not re.search(r'[\r\n]', content) and re.search(r'\\[rn]', content):
            raise Denied('escaped_newline_content')
        if SECRET.search(content) or '\x00' in content:
            raise Denied('sensitive_or_binary_content')
        # 既有文件的 BOM 逐字保留，不能随模型回传内容增删。
        if name == 'write_file' and p.exists() and not old_text.startswith('\ufeff'):
            content = content.removeprefix('\ufeff')
        data = content.encode('utf-8')
        if old.startswith(b'\xef\xbb\xbf'):
            data = b'\xef\xbb\xbf' + data
        if len(data) > MAX_BYTES:
            raise Denied('file_too_large')
        new_lines = content.splitlines(keepends=True)
        new_pages = page_count(new_lines)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=p.parent, prefix='.deepseek-write-', delete=False) as stream:
                temporary = stream.name
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            self.check(p, missing=True)
            if p.exists():
                current, _ = self.read_bytes(p)
                if expected != hashlib.sha256(current).hexdigest():
                    raise Denied('hash_conflict')
            elif expected is not None:
                raise Denied('hash_conflict')
            os.replace(temporary, p)
            temporary = None
        finally:
            if temporary is not None:
                os.unlink(temporary)
        key = os.path.normcase(str(p))
        self.written.add(key)
        self.read_hashes.pop(key, None)
        self.read_coverage[key] = set()
        self.descriptions[key].update(exists=True, total_lines=len(new_lines), read_calls=new_pages)
        return {'path': str(p.relative_to(self.root)), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
                'line_ending': text_format(content), 'utf8_bom': data.startswith(b'\xef\xbb\xbf'), 'readback_required': True}

    def tools(self):
        string = {'type': 'string'}
        def tool(name, description, props, required):
            return {'name': name, 'description': description, 'inputSchema': {'type': 'object', 'properties': props, 'required': required, 'additionalProperties': False}}
        result = [
            tool('read_file', '分页读取项目 UTF8 文件并返回 SHA256；写入前须读完所有行，直到 full_file_read=true。', {'path': string, 'start_line': {'type': 'integer', 'minimum': 1}, 'max_lines': {'type': 'integer', 'minimum': 1, 'maximum': 1000}}, ['path']),
            tool('list_files', '在指定项目路径内列出安全文件，最多100条。', {'path': string, 'pattern': string}, []),
            tool('search_text', '在安全UTF8文件内搜索字面文本，最多100条。', {'query': string, 'path': string, 'pattern': string}, ['query'])]
        if self.editable:
            result.append(tool('replace_text', '优先用于小改动：完整读完并提供最新SHA256，唯一字面old_text替换为new_text；只解析一次JSON，不二次反转义；写后回读。', {'path': string, 'old_text': string, 'new_text': string, 'expected_sha256': {'type': ['string', 'null']}}, ['path', 'old_text', 'new_text', 'expected_sha256']))
            result.append(tool('write_file', '新文件或必要整份重写；既有文件须完整读完并提交最新SHA256；保持原行尾/BOM，不传双重转义内容，写后回读。', {'path': string, 'content': string, 'expected_sha256': {'type': ['string', 'null']}}, ['path', 'content', 'expected_sha256']))
        return result

    def call(self, name, args):
        reason = 'ok'
        try:
            value = self.operate(name, args)
            value['budget'] = self.budget()
            result = {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}], 'isError': False}
        except Denied as exc:
            reason = str(exc)
            result = {'content': [{'type': 'text', 'text': json.dumps({'error': reason, 'budget': self.budget()}, ensure_ascii=False)}], 'isError': True}
        except Exception:
            reason = 'operation_failed'
            result = {'content': [{'type': 'text', 'text': reason}], 'isError': True}
        # 审计不含参数、查询或文件内容；路径也过滤可疑密钥。
        raw_path = args.get('path', '.') if isinstance(args, dict) else ''
        safe_path = raw_path if isinstance(raw_path, str) and len(raw_path) <= 1000 and not SECRET.search(raw_path) else '[redacted]'
        event = {'time': time.time(), 'operation': name if name in {'read_file', 'list_files', 'search_text', *WRITE_TOOLS} else 'unknown', 'path': safe_path, 'result': reason}
        if reason == 'ok':
            # 仅记录格式/摘要与完整回读证据，不能把文件内容或替换片段写进审计。
            for field in ('sha256', 'full_file_read', 'line_ending', 'utf8_bom'):
                if field in value:
                    event[field] = value[field]
        try:
            with self.audit.open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(event, ensure_ascii=False) + '\n')
        except Exception:
            return {'content': [{'type': 'text', 'text': 'audit_failed'}], 'isError': True}
        return result


def main():
    # MCP stdio 固定使用 UTF-8，不能依赖 Windows 控制台的默认代码页。
    sys.stdout.reconfigure(encoding='utf-8', newline='\n')
    sys.stderr.reconfigure(encoding='utf-8', newline='\n')
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--preflight', action='store_true')
    options = parser.parse_args()
    try:
        config = json.loads(Path(options.config).read_text(encoding='utf-8-sig'))
        if options.preflight:
            config.pop('pidPath', None)
        service = Service(config)
    except Exception:
        print('MCP configuration rejected', file=sys.stderr)
        return 1
    if options.preflight:
        plan = service.preflight()
        print(json.dumps(plan, ensure_ascii=False))
        return 0 if plan['affordable'] else 2
    for raw in sys.stdin.buffer:
        request = None
        try:
            if len(raw) > 7 * MAX_BYTES:
                raise ValueError()
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise ValueError()
            if 'id' not in request:
                continue
            method = request.get('method')
            params = request.get('params') or {}
            if method == 'initialize':
                result = {'protocolVersion': params.get('protocolVersion', '2024-11-05'), 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'deepseek-scoped-files', 'version': '1.0.0'}}
            elif method == 'ping':
                result = {}
            elif method == 'tools/list':
                result = {'tools': service.tools()}
            elif method == 'tools/call':
                result = service.call(params.get('name'), params.get('arguments', {}))
            else:
                raise Denied('method_not_found')
            response = {'jsonrpc': '2.0', 'id': request['id'], 'result': result}
        except Exception:
            response = {'jsonrpc': '2.0', 'id': request.get('id') if isinstance(request, dict) else None, 'error': {'code': -32600, 'message': 'Invalid request'}}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + '\n')
        sys.stdout.flush()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
