#Requires -Version 7.0
$ErrorActionPreference='Stop'
$runtimeFile = Join-Path $env:LOCALAPPDATA 'DeepSeekAssistWorkspace\server.json'
if (!(Test-Path -LiteralPath $runtimeFile)) { '工作群服务未启动。'; return }
$identity = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
try { $child=[Diagnostics.Process]::GetProcessById([int]$identity.pid) } catch [ArgumentException] { '工作群服务已停止。'; return }
try {
    # 仅停止本工具上次启动的同一进程，PID 复用时不触碰其他进程。
    if (!$identity.processStartFileTime -or $child.StartTime.ToUniversalTime().ToFileTimeUtc() -ne [long]$identity.processStartFileTime) { throw '服务进程身份已变化，未停止任何其他进程。' }
    $child.Kill()
    $child.WaitForExit()
    '工作群服务已停止，记录仍保存在本机。'
} finally { $child.Dispose() }
