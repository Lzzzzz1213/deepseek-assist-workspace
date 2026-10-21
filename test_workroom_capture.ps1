#Requires -Version 7.0
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'integration\Workroom-Events.ps1')
$fixture = Join-Path $PSScriptRoot ('work\capture-fixture-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixture)
$session = [pscustomobject]@{Path=(Join-Path $fixture 'events.jsonl');RunId=('a'*32);RoomId=('b'*32);Failed=$false;Ended=$false;AuditLines=0;EventCount=0}
$privateMarker = 'fixture-private-value-123'
$secretText = 'password="' + $privateMarker + '"; token=' + $privateMarker
Write-WorkroomEvent $session 'task.created' 'codex' $secretText @{editableFiles=@('a.js','b.js');title='测试任务'}
Publish-WorkroomCodexEvent $session '{"type":"item.completed","item":{"type":"reasoning","text":"PRIVATE-REASONING-FIXTURE"}}'
Publish-WorkroomCodexEvent $session '{"type":"item.completed","item":{"type":"agent_message","text":"公开回复 <script>test</script>"}}'
Write-WorkroomEvent $session 'task.completed' 'system' '' @{status='success';usage=@{input_tokens=100;output_tokens=20}}
$raw = Get-Content -LiteralPath $session.Path -Raw
$records = @(Get-Content -LiteralPath $session.Path | ForEach-Object {$_ | ConvertFrom-Json})
if ($raw.Contains($privateMarker) -or $raw.Contains('PRIVATE-REASONING-FIXTURE')) {throw '敏感内容过滤失败。'}
if ($records.Count -ne 3 -or $records[1].text -ne '公开回复 <script>test</script>') {throw '公开消息记录失败。'}
if ($records[0].payload.editableFiles.Count -ne 2 -or $records[2].payload.usage.input_tokens -ne 100) {throw '结构化字段受损。'}
if (!$session.Ended -or $session.Failed) {throw '记录状态不正确。'}
'Capture redaction, reasoning exclusion, public message and structured JSON checks passed.'
