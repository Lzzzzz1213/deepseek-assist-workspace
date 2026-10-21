#Requires -Version 7.0
# 只记录显式委派及公开事件，观察台故障不改变辅助任务的执行权限和结果。
function Protect-WorkroomText([string]$Text) {
    if (!$Text) { return '' }
    $value = [regex]::Replace($Text, '(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)', '[已隐藏私钥]')
    $value = [regex]::Replace($value, 'sk-[A-Za-z0-9_-]{12,}', '[已隐藏密钥]')
    $value = [regex]::Replace($value, '(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*', 'Bearer [已隐藏]')
    $value = [regex]::Replace($value, '(?i)(\b["'']?(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["'']?\s*[:=]\s*)(?:"[^"\r\n]*"|''[^''\r\n]*''|[^\s,;\r\n]+)', '$1[已隐藏]')
    return $value
}

function ConvertTo-WorkroomSafeValue($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) { return Protect-WorkroomText $Value }
    if ($Value -is [Collections.IDictionary]) {
        $safe = @{}
        foreach ($key in $Value.Keys) { $safe[$key] = ConvertTo-WorkroomSafeValue $Value[$key] }
        return $safe
    }
    if ($Value -is [pscustomobject]) {
        $safe = @{}
        foreach ($property in $Value.PSObject.Properties) { $safe[$property.Name] = ConvertTo-WorkroomSafeValue $property.Value }
        return $safe
    }
    if ($Value -is [Collections.IEnumerable]) {
        $safe = @(foreach ($item in $Value) { ConvertTo-WorkroomSafeValue $item })
        return ,$safe
    }
    return $Value
}

function New-WorkroomSession {
    param([string]$RunDirectory, [string]$WorkingDirectory, [string]$RoomName, [string]$TaskTitle, [string]$TaskText, [string]$Mode, [string[]]$EditableFiles)
    try {
        $store = Join-Path $env:LOCALAPPDATA 'CodexDeepSeekHelper\workroom\events'
        [void][IO.Directory]::CreateDirectory($store)
        $acl = Get-Acl -LiteralPath $store
        if (!$acl.AreAccessRulesProtected) {
            $acl.SetAccessRuleProtection($true, $false)
            foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
            }
            Set-Acl -LiteralPath $store -AclObject $acl
        }
        $sourceId = if ($env:CODEX_THREAD_ID -match '^[0-9a-fA-F-]{36}$') { $env:CODEX_THREAD_ID } else { '' }
        $grouping = if ($RoomName) { 'named' } elseif ($sourceId) { 'chat' } else { 'project' }
        $seed = if ($sourceId) { $sourceId } else { $WorkingDirectory.ToUpperInvariant() }
        if ($RoomName) { $seed += '|named|' + $RoomName }
        $roomId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($seed))).Substring(0,32).ToLowerInvariant()
        $runId = [IO.Path]::GetFileName($RunDirectory).ToLowerInvariant()
        $title = if ($TaskTitle) { $TaskTitle } else { @($TaskText -split "`n" | Where-Object { $_.Trim() })[0].Trim() }
        if ($title.Length -gt 100) { $title = $title.Substring(0,100) + '…' }
        $roomTitle = if ($RoomName) { $RoomName } else { (Split-Path $WorkingDirectory -Leaf) + $(if ($sourceId) { ' · ' + $sourceId.Substring(0,8) }) }
        $session = [pscustomobject]@{ Path=(Join-Path $store ($runId + '.jsonl')); RunId=$runId; RoomId=$roomId; Failed=$false; Ended=$false; AuditLines=0; EventCount=0 }
        Write-WorkroomEvent $session 'task.created' 'codex' $TaskText @{
            title=$title; roomTitle=$roomTitle; sourceThreadId=$sourceId; workingDirectory=$WorkingDirectory; grouping=$grouping
            mode=$Mode; editableFiles=@($EditableFiles); model='deepseek-flash'; engine='codex-cli'
            parentPid=$PID; parentStartFileTime=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc())
        }
        return $session
    } catch {
        Write-Warning '工作群记录暂不可用，辅助任务继续执行。'
        return $null
    }
}

function Write-WorkroomEvent {
    param($Session, [string]$Type, [string]$Actor, [string]$Text, [hashtable]$Payload=@{})
    if (!$Session -or $Session.Failed) { return }
    try {
        if ($Type -notin @('task.created','task.running','message','task.completed','review')) { return }
        $record = @{ v=1; eventId=[guid]::NewGuid().ToString(); runId=$Session.RunId; roomId=$Session.RoomId; time=[DateTimeOffset]::UtcNow.ToString('o'); type=$Type; actor=$Actor; text=$Text; payload=$Payload }
        $line = (ConvertTo-WorkroomSafeValue $record) | ConvertTo-Json -Depth 10 -Compress
        # 每次只持有一行的追加句柄，允许观察台读取；各任务各写各的文件。
        $stream = [IO.File]::Open($Session.Path, 'Append', 'Write', 'ReadWrite')
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
        try { $writer.WriteLine($line) } finally { $writer.Dispose() }
        $Session.EventCount++
        if ($Type -eq 'task.completed') { $Session.Ended=$true }
    } catch {
        $Session.Failed=$true
        Write-Warning '工作群记录暂不可用，辅助任务继续执行。'
    }
}

function Publish-WorkroomCodexEvent {
    param($Session, [string]$Line)
    if (!$Session) { return }
    try { $event = $Line | ConvertFrom-Json } catch { return }
    # 严格白名单：reasoning、系统提示、原始工具内容一律不进入观察记录。
    if ($event.type -eq 'item.completed' -and $event.item.type -eq 'agent_message' -and $event.item.text) {
        $phase = if ($event.item.phase -in @('commentary','final')) { $event.item.phase } else { 'public' }
        Write-WorkroomEvent $Session 'message' 'deepseek' $event.item.text @{phase=$phase}
    }
}

function Sync-WorkroomToolAudit {
    param($Session, [string]$AuditPath)
    # 用户选择工作群只看对话；原 helper 的 toolAudit 仍独立供主智能体审查。
    return
}
