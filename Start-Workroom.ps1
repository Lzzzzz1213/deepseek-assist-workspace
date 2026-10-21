#Requires -Version 7.0
[CmdletBinding()]
param([ValidateRange(0,65535)][int]$Port=18765,[switch]$NoBrowser)
$ErrorActionPreference='Stop'
$runtimeDirectory = Join-Path $env:LOCALAPPDATA 'DeepSeekAssistWorkspace'
[void][IO.Directory]::CreateDirectory($runtimeDirectory)
$runtimeFile = Join-Path $runtimeDirectory 'server.json'
if (Test-Path -LiteralPath $runtimeFile) {
    try {
        $existing = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        if ($existing.baseUrl -match '^http://127\.0\.0\.1:\d{1,5}$') {
            $health = Invoke-RestMethod -Uri ($existing.baseUrl + '/health') -TimeoutSec 2
            if ($health.application -eq 'Codex DeepSeek Workroom') {
                if (!$NoBrowser) { Start-Process $existing.baseUrl }
                [pscustomobject]@{url=$existing.baseUrl;pid=$existing.pid;alreadyRunning=$true}
                return
            }
        }
    } catch { }
}
$python = (Get-Command python.exe -ErrorAction Stop).Source
$arguments = @('-X','utf8','-u',('"' + (Join-Path $PSScriptRoot 'workroom_server.py') + '"'),'--port',$Port.ToString(),'--runtime-file',('"' + $runtimeFile + '"'))
$child = Start-Process -FilePath $python -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDirectory 'server.stdout.log') -RedirectStandardError (Join-Path $runtimeDirectory 'server.stderr.log')
try {
    $ready=$null
    for ($i=0;$i -lt 80;$i++) {
        if ($child.HasExited) { throw '本机服务启动失败，请检查应用日志；未改变已有服务。' }
        if (Test-Path -LiteralPath $runtimeFile) {
            try {
                $candidate = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
                if ($candidate.pid -eq $child.Id -and $candidate.baseUrl -match '^http://127\.0\.0\.1:\d{1,5}$') {
                    $health = Invoke-RestMethod -Uri ($candidate.baseUrl + '/health') -TimeoutSec 1
                    if ($health.application -eq 'Codex DeepSeek Workroom') { $ready=$candidate; break }
                }
            } catch { }
        }
        Start-Sleep -Milliseconds 100
    }
    if (!$ready) { throw '本机工作群服务未在限定时间内就绪。' }
    $ready | Add-Member -NotePropertyName processStartFileTime -NotePropertyValue $child.StartTime.ToUniversalTime().ToFileTimeUtc() -Force
    $ready | ConvertTo-Json | Set-Content -LiteralPath $runtimeFile -Encoding utf8
    if (!$NoBrowser) { Start-Process $ready.baseUrl }
    [pscustomobject]@{url=$ready.baseUrl;pid=$ready.pid;alreadyRunning=$false}
} catch {
    if (!$child.HasExited) { $child.Kill($true); $child.WaitForExit() }
    throw
} finally { $child.Dispose() }
