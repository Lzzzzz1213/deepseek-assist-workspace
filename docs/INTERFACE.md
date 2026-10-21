# 本机事件接口

默认数据目录由 workroom_storage.resolve_event_directory 选择：优先有合法事件文件名的 Codex MSIX LocalCache 专用记录目录，再选有记录的常规 LocalAppData 专用目录；首条记录尚未创建时保留已安装 Codex 的缓存目标，无 Codex 包目录则用常规路径。只检查公开记录专用位置，不访问其他会话或凭据。--data-dir 显式目录绕过自动定位；原始记录不迁移。启动元数据包含实际 dataDirectory，readStatus 为 missing/error 时前端不显示绿色同步状态。

每次委派写入一份 32 位十六进制 runId 命名的 JSONL。事件基础字段：`v:1`、`eventId`、`runId`、`roomId`、`time`（UTC ISO8601）、`type`、`actor`、`text`、`payload`。

读取层按 task.created.workingDirectory 生成稳定工作区 ID：词法规范化 Windows 绝对路径、忽略大小写与末尾分隔符，将项目下 Agent 的 work 子目录归回父项目，再对 workspace|规范路径作 SHA256 并取前32位。任务名、RoomName 和来源聊天不再拆群；不同工作区分别保留。输入原始事件和缓存不变，API 返回的 room.id 为归并后的工作区 ID。无有效工作目录的旧记录维持原分组，不读取项目目录或其他会话数据库来猜测工作区。

工作群含 sourceThreadIds 列表；sourceThreadId 只在唯一来源时填充。每个 run 保留自己的 workingDirectory 与 sourceThreadId。任务筛选、导出和客户端删除均使用归并后的群 ID。删除仅隐藏该群已有任务；原始记录始终只读，确认时的群版本不同或含运行中任务均拒绝。后续新 run 会重新显示该工作区群。

类型为 task.created / task.running / message / tool / task.completed / review。actor 为 codex / deepseek / system / reviewer。task.created 的 text 是实际发给 DeepSeek 的显式任务；message 是 Codex exec 的公开 agent_message。不会存入 reasoning、系统提示或原始工具参数/返回。

前端每 2 秒拉取数据；所有 API fetch 使用 `credentials:'same-origin'` 与 `X-Workroom-Client:1`，服务从首页发 HttpOnly SameSite Strict cookie。所有消息按不可信纯文本渲染，复制时保留原文本。工作观察不提供发送任务的输入框；独立私聊提供普通消息输入，不触发工作Agent。

总览仍每2秒同步；当前群的 `clearRevision` 与已加载详情相同时跳过重复详情请求，其他群的更新不重拉当前历史。详情中的消息仍完整返回，客户端仅虚拟化屏幕DOM，不截断搜索或导出数据。`/message-list.js`、`/message-list.css` 为固定本地静态资源，不从网络加载组件。

- GET /health：服务探测。
- GET /api/state：`{revision,rooms:[{id,title,project,sourceThreadId,updatedAt,status,runCount,messageCount,preview,grouping,clearRevision}],stats:{rooms,runs,running,messages},privacy:{dataDirectory,localOnly:true,sourceReadOnly:true,deletionScope:"client-only",readStatus}}`。`clearRevision` 是本群当前可见任务签名与状态的20位十六进制摘要，供删除确认使用。
- GET /api/rooms/<id>：`{revision,room,runs:[{id,title,status,mode,model,engine,startedAt,completedAt,usage,durationSeconds,editableFiles,fileChanges}],messages:[{id,runId,type,actor,text,time,payload}]}`。
- GET /api/rooms/<id>/export：脱敏 JSON 附件，前端 fetch 后创建 Blob 下载。
- DELETE /api/rooms/<id>：请求头需 Content-Type: application/json，body 必须为 `{"revision":"确认时的 clearRevision"}`；原生 dialog 明确确认后，仅在客户端目录隐藏本群已有任务。成功返回 `{deleted:隐藏任务数,scope:"client-only",sourcePreserved:true}`；缺版本400、群不存在404、运行中/版本变化/原文件签名变化/标记损坏或写入失败409。`{}` 不会执行删除，绝不回退到物理删除。

隐藏标记由 `client_history.ClientHistory` 保存到客户端独立数据目录的 `client-history/hidden-runs-<来源目录摘要>.json`，只含版本和 run ID，不复制消息正文或凭据。`--view-state-dir` 指定客户端目录；Windows 外壳显式传自己的 stateDirectory。来源树与 Codex 目录不能作为标记目录，路径先规范化并拒绝 Win32 别名、链接及文件硬链接。多个客户端以文件锁串行合并，整群标记通过一次原子替换写入；失败不覆盖损坏标记。读取、计数、搜索与导出均应用隐藏范围，先过滤隐藏任务再计算来源文件读取上限。

状态 success 表示辅助调用结束，UI 应显示“调用完成 · 待主审”，不能伪造审核通过。review 类型另行标明主智能体的实际验证。无终态且父进程结束时为 interrupted。未知状态原样解释，不默认成功。

初始页面没有假数据。没有群组时显示如何开始一次真实委派的说明。界面单列切换群组列表与对话区，不再提供任务信息侧栏。消息接口、计数、搜索和导出只包含 task.created / message / review；任务生命周期仅用于推导状态，不作为对话行。旧记录里的 tool 也会过滤。支持搜索、按任务筛选与自动跟随，通知顶部居中。Android 派生风格应用于 Windows 客户端，不生成 APK。

## 独立私聊

固定用户与DeepSeek会话、SQLite记忆、异步消息、清空代次和表情白名单接口详见 [PRIVATE-CHAT.md](PRIVATE-CHAT.md)。私聊清空只清消息，不清记忆；公开JSONL与工作Agent仍只读且隔离。
