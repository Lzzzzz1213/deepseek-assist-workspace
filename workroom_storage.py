"""定位当前用户的公开协作记录，兼容 Codex 打包环境的 AppData 重定向。

只检查专用目录与记录文件名，不读取正文、会话数据库或凭据，也不创建或迁移文件。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

__all__ = ["resolve_event_directory"]

_RECORD_NAME = re.compile(r"^[0-9a-f]{32}\.jsonl$")
_PACKAGE_PREFIX = "openai.codex_"
_MAX_PACKAGE_DIRS = 32
_MAX_RECORD_ENTRIES = 1000


def _local_app_data_root(local_app_data):
    if local_app_data is not None:
        value = local_app_data
    else:
        value = os.environ.get("LOCALAPPDATA")
    return Path(value) if value else Path.home()


def _conventional_events_path(root):
    return root / "CodexDeepSeekHelper" / "workroom" / "events"


def _package_events_path(package_dir):
    return (
        package_dir
        / "LocalCache"
        / "Local"
        / "CodexDeepSeekHelper"
        / "workroom"
        / "events"
    )


def _has_record_file(directory):
    """有界检查合法事件文件名，目录不可枚举时保守回退。"""
    try:
        with os.scandir(directory) as entries:
            for index, entry in enumerate(entries):
                if index >= _MAX_RECORD_ENTRIES:
                    break
                if not _RECORD_NAME.fullmatch(entry.name):
                    continue
                try:
                    if entry.is_file(follow_symlinks=False):
                        return True
                except OSError:
                    continue
    except OSError:
        return False
    return False


def _package_event_paths(root):
    """按包名稳定选择最多 32 个 Codex 专用缓存路径。"""
    packages_dir = root / "Packages"
    names = []
    try:
        with os.scandir(packages_dir) as entries:
            for entry in entries:
                if not entry.name.lower().startswith(_PACKAGE_PREFIX):
                    continue
                try:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                names.append(entry.name)
    except OSError:
        return []

    names.sort(key=lambda name: (name.lower(), name))
    return [
        _package_events_path(packages_dir / name)
        for name in names[:_MAX_PACKAGE_DIRS]
    ]


def resolve_event_directory(local_app_data=None) -> Path:
    """优先有记录的包缓存，其次常规记录；尚无记录时选未来写入目标。

    保留原始路径供 EventStore 再次进行链接和重解析点检查，不调用 resolve。
    """
    root = _local_app_data_root(local_app_data)
    conventional = _conventional_events_path(root)
    package_paths = _package_event_paths(root)

    for candidate in package_paths:
        if _has_record_file(candidate):
            return candidate

    if _has_record_file(conventional):
        return conventional

    if package_paths:
        return package_paths[0]

    return conventional
