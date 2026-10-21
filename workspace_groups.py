"""按工作区归并工作群事件；路径只做词法处理，不访问文件系统。"""

import hashlib
import ntpath
import re
import unicodedata

# 驱动器的规范化结果只应是 C:\ 这类形式，不能是相对驱动器路径。
_DRIVE_ROOT = re.compile(r"[A-Za-z]:\\\Z")
_DRIVE_ONLY = re.compile(r"[A-Za-z]:\Z")
_MISSING = object()


def _has_control_char(text):
    """控制字符包括 C0、DEL 和 C1，直接拒绝而不是尝试改写。"""
    return any(unicodedata.category(ch) == "Cc" for ch in text)


def _workspace_title(display_path):
    """取目录最后一段；驱动器或 UNC 共享根本身也要有可读名称。"""
    trimmed = display_path.rstrip("\\")
    if _DRIVE_ONLY.fullmatch(trimmed):
        return trimmed
    title = ntpath.basename(trimmed)
    if title:
        return title
    parts = [part for part in display_path.split("\\") if part]
    return parts[-1] if parts else display_path


def _workspace_identity(display_path):
    """标识忽略大小写和根目录末尾分隔符，显示路径仍保留用户大小写。"""
    identity = display_path.casefold()
    if identity.endswith("\\") and not _DRIVE_ROOT.fullmatch(identity):
        identity = identity.rstrip("\\")
    return identity


def _workspace_for_path(value):
    """返回稳定工作区信息；路径无效时返回 None。"""
    if not isinstance(value, str) or not value or _has_control_char(value):
        return None

    # ntpath 保证 Windows 路径在任意平台使用同一套词法规则。
    path = value.replace("/", "\\")
    if path.startswith(("\\\\?\\", "\\\\.\\")):
        return None
    # UNC 只允许恰好两个前导反斜杠；三根及以上不是合法网络路径。
    if path.startswith("\\\\\\"):
        return None

    normalized = ntpath.normpath(path)
    drive, tail = ntpath.splitdrive(normalized)

    if drive.startswith("\\\\"):
        share_parts = drive[2:].split("\\")
        if len(share_parts) != 2 or not share_parts[0] or not share_parts[1]:
            return None
        if tail and not tail.startswith("\\"):
            return None
        base = drive
    elif _DRIVE_ONLY.fullmatch(drive):
        # C:foo 是驱动器相对路径，必须拒绝；C:\foo 才是绝对路径。
        if not tail.startswith("\\"):
            return None
        base = drive
    else:
        # 相对路径、单反斜杠根路径以及无法识别的驱动器都不可用于归组。
        return None

    rest = tail[1:] if tail.startswith("\\") else tail
    segments = [part for part in rest.split("\\") if part]
    work_at = next(
        (index for index, part in enumerate(segments) if index > 0 and part.casefold() == "work"),
        None,
    )
    if work_at is None:
        display_path = normalized
    else:
        # work 是任务临时目录；根取 work 之前的项目目录，同名前缀不参与判断。
        display_path = base + "\\" + "\\".join(segments[:work_at])

    identity = _workspace_identity(display_path)
    return {
        "roomId": hashlib.sha256(("workspace|" + identity).encode("utf-8")).hexdigest()[:32],
        "directory": display_path,
        "title": _workspace_title(display_path),
    }


def _workspaces_by_run(events):
    """汇总每个 run 的工作区；任一 task.created 无效或互相冲突时视为未知。"""
    workspaces = {}
    for event in events:
        if event.get("type") != "task.created":
            continue
        run_id = event.get("runId")
        payload = event.get("payload")
        raw_path = payload.get("workingDirectory") if isinstance(payload, dict) else None
        workspace = _workspace_for_path(raw_path)
        current = workspaces.get(run_id, _MISSING)

        if workspace is None:
            workspaces[run_id] = None
        elif current is _MISSING:
            workspaces[run_id] = workspace
        elif current is not None and current["roomId"] == workspace["roomId"]:
            # 同一工作区可重复出现；保留最先看到的显示大小写。
            continue
        else:
            workspaces[run_id] = None
    return workspaces


def group_workspace_events(events) -> list:
    """复制所有事件，并把可确定工作区的 run 归入稳定工作区群。"""
    workspaces = _workspaces_by_run(events)
    result = []

    for event in events:
        copied = dict(event)
        payload = event.get("payload")
        if isinstance(payload, dict):
            # 顶层 payload 也复制，确保增加展示字段不会改动缓存对象。
            copied_payload = dict(payload)
            copied["payload"] = copied_payload
        else:
            copied_payload = payload

        workspace = workspaces.get(event.get("runId"))
        if workspace is not None:
            copied["roomId"] = workspace["roomId"]
            if event.get("type") == "task.created" and isinstance(copied_payload, dict):
                copied_payload["workspaceDirectory"] = workspace["directory"]
                copied_payload["workspaceTitle"] = workspace["title"]
                copied_payload["grouping"] = "workspace"

        result.append(copied)

    return result
