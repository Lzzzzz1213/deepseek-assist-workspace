#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ResultFile,
    [Parameter(Mandatory)][ValidateSet('passed','changes_requested','information')][string]$Status,
    [Parameter(Mandatory)][string]$SummaryFile
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Workroom-Events.ps1')
$result = Get-Content -LiteralPath $ResultFile -Raw | ConvertFrom-Json
if ($result.engine -ne 'codex-cli' -or !$result.workroom.recorded -or $result.workroom.runId -notmatch '^[0-9a-f]{32}$' -or $result.workroom.roomId -notmatch '^[0-9a-f]{32}$') { throw '不是已记录的 Codex 辅助任务结果。' }
if ($Status -eq 'passed' -and !$result.success) { throw '辅助调用未完成，请先处理失败，不能直接记为通过。' }
$path = Join-Path $env:LOCALAPPDATA ('CodexDeepSeekHelper\workroom\events\' + $result.workroom.runId + '.jsonl')
$item = Get-Item -LiteralPath $path -Force
if ($item.LinkType -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '拒绝链接形式的记录文件。' }
$events = @(Get-Content -LiteralPath $path | ForEach-Object {$_ | ConvertFrom-Json})
if (@($events | Where-Object roomId -NE $result.workroom.roomId).Count -or !@($events | Where-Object type -EQ 'task.completed').Count) { throw '记录不匹配或任务尚未结束。' }
$text = Get-Content -LiteralPath $SummaryFile -Raw
if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 16000) { throw '审核说明必须为1至16000字符。' }
$session = [pscustomobject]@{Path=$path;RunId=$result.workroom.runId;RoomId=$result.workroom.roomId;Failed=$false;Ended=$true;AuditLines=0;EventCount=0}
Write-WorkroomEvent $session 'review' 'reviewer' $text @{status=$Status}
if ($session.Failed) { throw '审核说明未能写入。' }
'主智能体审核说明已记录。'
