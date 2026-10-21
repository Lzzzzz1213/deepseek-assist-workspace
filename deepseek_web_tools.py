"""Validation and normalization for DeepSeek's fixed Search and Fetch tools.

This module is deliberately side-effect free: it does not read files, access
the network, inspect credentials, or log tool arguments or results.
"""

import ipaddress
import json
import re
import unicodedata
from urllib.parse import urlsplit, urlunsplit


SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search"
FETCH_ENDPOINT = "https://api.deepseek.com/v1/tools/fetch"

_PAGE_TEXT_BUDGET = 8000
_TOTAL_TEXT_BUDGET = 24000
_MAX_URL_LENGTH = 8192
_MAX_QUERY_LENGTH = 128

_ERR_UNKNOWN_TOOL = "unknown web tool"
_ERR_TOOL_USED = "web tool already prepared"
_ERR_BAD_ARGUMENTS = "invalid tool arguments"
_ERR_BAD_URL = "invalid or disallowed URL"
_ERR_BAD_RESULT = "invalid tool result"

_SEARCH_DESCRIPTION = (
    "只读检索公开网络资料，只用于当前问题所需的公开信息。"
    "不得把工作区内容、私有记忆、凭据或密钥作为查询。"
    "本工具不执行命令，也不修改项目文件或调用其他工具。"
)
_FETCH_DESCRIPTION = (
    "只读抓取当前问题或本次搜索结果中明确允许的公开网页。"
    "不得把工作区内容、私有记忆、凭据或密钥作为抓取目标。"
    "本工具不执行命令，也不修改项目文件或调用其他工具。"
)

WEB_FUNCTIONS = (
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": _SEARCH_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": _MAX_QUERY_LENGTH,
                    }
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": _FETCH_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": _MAX_URL_LENGTH,
                    }
                },
                "required": ["url"],
                "additionalProperties": False,
            },
        },
    },
)

_FUNCTION_NAMES = frozenset(("web_search", "web_fetch"))
_FIELD_NAMES = ("title", "url", "snippet", "summary", "content")
_TEXT_FIELD_LIMITS = {
    "title": 300,
    "snippet": 1000,
    "summary": 2000,
    "content": 6000,
}
_URL_CANDIDATE_RE = re.compile(
    r"https?://[^\s<>\"'`，。；：！？、（）【】《》「」『』“”‘’]+",
    re.IGNORECASE,
)
_TRAILING_PUNCTUATION = ".,;:!?>，。；：！？、…）》】」』”’"
_DECIMAL_OR_HEX_LABEL_RE = re.compile(r"(?:[0-9]+|0[xX][0-9a-fA-F]+)\Z")
_DNS_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


class WebToolError(Exception):
    """A rejected web-tool request, with a non-sensitive error message."""


class _DuplicateKeyError(ValueError):
    pass


class _InvalidConstantError(ValueError):
    pass


def _valid_netloc_port_syntax(netloc):
    if netloc.startswith("["):
        close = netloc.find("]")
        if close < 0:
            return False
        tail = netloc[close + 1:]
        if not tail:
            return True
        if not tail.startswith(":") or len(tail) == 1:
            return False
        port_text = tail[1:]
    else:
        if netloc.count(":") > 1:
            return False
        if ":" not in netloc:
            return True
        _host, port_text = netloc.rsplit(":", 1)
        if not port_text:
            return False
    return port_text.isascii() and port_text.isdigit()


def _public_ip(ip):
    if isinstance(ip, ipaddress.IPv6Address):
        if getattr(ip, "zone_id", None):
            return False
        mapped = ip.ipv4_mapped
        if mapped is not None:
            ip = mapped
    if not ip.is_global:
        return False
    for attribute in (
        "is_multicast",
        "is_reserved",
        "is_loopback",
        "is_link_local",
        "is_unspecified",
    ):
        if getattr(ip, attribute):
            return False
    return True


def _canonicalize_public_url(value):
    if not isinstance(value, str) or not 1 <= len(value) <= _MAX_URL_LENGTH:
        return None
    if "\\" in value:
        return None
    for character in value:
        if (
            character.isspace()
            or unicodedata.category(character) in ("Cc", "Cs")
        ):
            return None

    try:
        parts = urlsplit(value)
        host = parts.hostname
        port = parts.port
    except (UnicodeError, ValueError):
        return None

    scheme = parts.scheme.lower()
    if scheme not in ("http", "https") or not parts.netloc or not host:
        return None
    if "@" in parts.netloc or "%" in parts.netloc:
        return None
    if not _valid_netloc_port_syntax(parts.netloc):
        return None
    if port is not None and port not in (80, 443):
        return None

    bracketed = parts.netloc.startswith("[")
    host = host.lower()
    if host.endswith("."):
        host = host[:-1]
    if not host:
        return None

    try:
        literal_ip = ipaddress.ip_address(host)
    except ValueError:
        literal_ip = None

    if literal_ip is not None:
        if not _public_ip(literal_ip):
            return None
        if bracketed != isinstance(literal_ip, ipaddress.IPv6Address):
            return None
        if isinstance(literal_ip, ipaddress.IPv6Address):
            canonical_host = "[" + literal_ip.compressed + "]"
        else:
            canonical_host = literal_ip.compressed
    else:
        if ":" in host or bracketed:
            return None
        try:
            ascii_host = host.encode("idna").decode("ascii").lower()
        except (UnicodeError, ValueError):
            return None
        if ascii_host.endswith("."):
            ascii_host = ascii_host[:-1]
        labels = ascii_host.split(".")
        if (
            not ascii_host
            or len(ascii_host) > 253
            or len(labels) < 2
            or any(not label or len(label) > 63 for label in labels)
            or any(not _DNS_LABEL_RE.fullmatch(label) for label in labels)
        ):
            return None
        if (
            ascii_host == "localhost"
            or ascii_host == "home.arpa"
            or ascii_host.endswith((
                ".localhost", ".local", ".internal", ".lan", ".home",
                ".home.arpa", ".localdomain",
            ))
        ):
            return None
        if all(
            _DECIMAL_OR_HEX_LABEL_RE.fullmatch(label) for label in labels
        ):
            return None
        canonical_host = ascii_host

    default_port = (scheme == "http" and port == 80) or (
        scheme == "https" and port == 443
    )
    if port is None or default_port:
        canonical_netloc = canonical_host
    else:
        canonical_netloc = canonical_host + ":" + str(port)

    return urlunsplit(
        (scheme, canonical_netloc, parts.path, parts.query, "")
    )


def collect_urls(question: str) -> set[str]:
    """Return canonical HTTP(S) links explicitly present in the question."""
    if not isinstance(question, str):
        raise WebToolError(_ERR_BAD_ARGUMENTS)
    urls = set()
    for match in _URL_CANDIDATE_RE.finditer(question):
        candidate = match.group(0).rstrip(_TRAILING_PUNCTUATION)
        # 仅去掉外层 Markdown 括号；保留合法页面路径括号和 IPv6 host 的闭括号。
        opening = {")": "(", "]": "[", "}": "{"}
        while candidate and candidate[-1] in opening:
            closing = candidate[-1]
            if candidate.count(closing) <= candidate.count(opening[closing]):
                break
            candidate = candidate[:-1].rstrip(_TRAILING_PUNCTUATION)
        canonical = _canonicalize_public_url(candidate)
        if canonical is not None:
            urls.add(canonical)
    return urls


def _no_duplicate_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKeyError()
        result[key] = value
    return result


def _reject_constant(_constant):
    raise _InvalidConstantError()


def _parse_arguments(arguments):
    if not isinstance(arguments, str):
        raise WebToolError(_ERR_BAD_ARGUMENTS)
    try:
        value = json.loads(
            arguments,
            object_pairs_hook=_no_duplicate_object,
            parse_constant=_reject_constant,
        )
    except (RecursionError, TypeError, ValueError):
        raise WebToolError(_ERR_BAD_ARGUMENTS) from None
    if not isinstance(value, dict):
        raise WebToolError(_ERR_BAD_ARGUMENTS)
    return value


def prepare_tool(
    name: str,
    arguments: str,
    allowed_urls: set[str],
    used: set[str],
) -> tuple[str, dict]:
    """Validate a function call and return its fixed endpoint and body."""
    if not isinstance(name, str) or name not in _FUNCTION_NAMES:
        raise WebToolError(_ERR_UNKNOWN_TOOL)
    if name in used:
        raise WebToolError(_ERR_TOOL_USED)

    values = _parse_arguments(arguments)
    if name == "web_search":
        if set(values) != {"query"}:
            raise WebToolError(_ERR_BAD_ARGUMENTS)
        query = values["query"]
        if not isinstance(query, str):
            raise WebToolError(_ERR_BAD_ARGUMENTS)
        query = query.strip()
        if (not 1 <= len(query) <= _MAX_QUERY_LENGTH or
                any(unicodedata.category(character) == "Cs" for character in query)):
            raise WebToolError(_ERR_BAD_ARGUMENTS)
        used.add(name)
        return (
            SEARCH_ENDPOINT,
            {"query": query, "count": 5, "need_content": True},
        )

    if set(values) != {"url"}:
        raise WebToolError(_ERR_BAD_ARGUMENTS)
    raw_url = values["url"]
    if not isinstance(raw_url, str):
        raise WebToolError(_ERR_BAD_ARGUMENTS)
    canonical_url = _canonicalize_public_url(raw_url)
    if canonical_url is None or canonical_url not in allowed_urls:
        raise WebToolError(_ERR_BAD_URL)
    used.add(name)
    return FETCH_ENDPOINT, {"url": canonical_url}


def _clip(value, limit):
    # 网页资料不可信，去除会破坏后续 UTF-8 请求的 surrogate 和非排版控制符。
    value = "".join(character for character in value if
                    character in "\r\n\t" or unicodedata.category(character) not in ("Cc", "Cs"))
    return value[:max(0, limit)]


def _text_size(value):
    return sum(len(value[field]) for field in _FIELD_NAMES)


def _trim_to_budget(value, budget):
    if _text_size(value) <= budget:
        return value
    available = budget - len(value["url"])
    if available < 0:
        return None
    result = dict(value)
    overage = _text_size(result) - budget
    for field in ("content", "summary", "snippet", "title"):
        if overage <= 0:
            break
        remove = min(overage, len(result[field]))
        if remove:
            result[field] = result[field][:-remove]
            overage -= remove
    if _text_size(result) > budget:
        return None
    return result


def _normalize_search_row(row):
    if not isinstance(row, dict):
        return None
    canonical_url = _canonicalize_public_url(row.get("url"))
    if canonical_url is None:
        return None

    texts = {}
    for field in ("title", "snippet", "summary", "content"):
        if field in row:
            value = row[field]
            if not isinstance(value, str):
                return None
        else:
            value = ""
        texts[field] = _clip(value, _TEXT_FIELD_LIMITS[field])

    result = {
        "title": texts["title"],
        "url": canonical_url,
        "snippet": texts["snippet"],
        "summary": texts["summary"],
        "content": texts["content"],
    }
    return _trim_to_budget(result, _PAGE_TEXT_BUDGET)


def _normalize_search(payload, allowed_urls):
    results = payload.get("results")
    if not isinstance(results, list):
        raise WebToolError(_ERR_BAD_RESULT)

    normalized = []
    total_size = 0
    for row in results[:5]:
        value = _normalize_search_row(row)
        if value is None:
            continue
        remaining = _TOTAL_TEXT_BUDGET - total_size
        value = _trim_to_budget(value, min(_PAGE_TEXT_BUDGET, remaining))
        if value is None:
            continue
        normalized.append(value)
        allowed_urls.add(value["url"])
        total_size += _text_size(value)
    return {"results": normalized}


def _normalize_fetch(payload, requested_url):
    canonical_url = _canonicalize_public_url(requested_url)
    if canonical_url is None:
        raise WebToolError(_ERR_BAD_URL)

    content = payload.get("content")
    title = payload.get("title", "")
    if not isinstance(content, str) or not content.strip():
        raise WebToolError(_ERR_BAD_RESULT)
    if not isinstance(title, str):
        raise WebToolError(_ERR_BAD_RESULT)

    remaining = _PAGE_TEXT_BUDGET - len(canonical_url)
    content_limit = min(_TEXT_FIELD_LIMITS["content"], remaining)
    if content_limit < 1:
        raise WebToolError(_ERR_BAD_RESULT)
    content = _clip(content, content_limit)
    if not content.strip():
        raise WebToolError(_ERR_BAD_RESULT)
    title_room = remaining - len(content)
    title = _clip(title, min(_TEXT_FIELD_LIMITS["title"], title_room))

    return {
        "title": title,
        "content": content,
        "url": canonical_url,
    }


def normalize_tool_result(
    name: str,
    payload: dict,
    allowed_urls: set[str],
    requested_url=None,
) -> dict:
    """Normalize a fixed-tool response and enforce its text budgets."""
    if not isinstance(name, str) or name not in _FUNCTION_NAMES:
        raise WebToolError(_ERR_UNKNOWN_TOOL)
    if not isinstance(payload, dict):
        raise WebToolError(_ERR_BAD_RESULT)
    if name == "web_search":
        return _normalize_search(payload, allowed_urls)
    return _normalize_fetch(payload, requested_url)
