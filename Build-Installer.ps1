#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version = '1.4.4',
    [string]$NsisCompiler
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$client = Join-Path $root 'client'
$release = Join-Path $root 'release'
$build = Join-Path $root ('work\installer-build-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$latestFile = Join-Path $root 'work\latest-client-build.json'
if (!(Test-Path -LiteralPath $latestFile)) { throw '请先运行 Build-Client.ps1 生成客户端。' }
$latest = Get-Content -LiteralPath $latestFile -Raw | ConvertFrom-Json
$source = [IO.Path]::GetFullPath($latest.directory)
if (!$source.StartsWith((Join-Path $root 'dist') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '客户端来源超出本项目 dist 目录。' }
foreach ($entry in @('Workroom.exe','host\WorkroomHost.exe','host\_internal\web\portrait.css',
    'host\_internal\web\avatars.js','host\_internal\web\avatars.css',
    'host\_internal\web\message-list.js','host\_internal\web\message-list.css',
    'host\_internal\web\direct-chat.js','host\_internal\web\direct-chat.css',
    'host\_internal\web\assets\stickers\sources.json',
    'host\_internal\web\assets\avatars\deepseek.png','host\_internal\web\assets\avatars\chatgpt.png',
    'host\_internal\web\assets\app\workroom.ico','host\_internal\web\assets\app\workroom.png')) {
    if (!(Test-Path -LiteralPath (Join-Path $source $entry) -PathType Leaf)) { throw ('客户端不完整：' + $entry) }
}
if (!$NsisCompiler) { $NsisCompiler = Join-Path $root 'work\installer-tools\nsis-3.13\makensis.exe' }
if (!(Test-Path -LiteralPath $NsisCompiler -PathType Leaf)) { throw '未找到 NSIS 编译器；可用 -NsisCompiler 指定 makensis.exe。参见 installer/README.md。' }
$installer = Join-Path $release ('DeepSeek协助工作区-Setup-' + $Version + '-x64.exe')
if (Test-Path -LiteralPath $installer) { throw ('安装包已存在，请保留旧包并使用新版本号：' + $installer) }

# 仅接受正常文件与目录，不让链接把打包范围扩展到项目外。
$items = @(Get-ChildItem -LiteralPath $source -Recurse -Force)
if ($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw '发布目录包含链接，未进行打包。' }
$files = @($items | Where-Object { !$_.PSIsContainer } | Sort-Object FullName)
foreach ($directory in @($client,$release,$build)) { [void][IO.Directory]::CreateDirectory($directory) }
if ((Get-Item -LiteralPath $client).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'client 目录不能是链接。' }
if (Get-ChildItem -LiteralPath $client -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'client 目录包含链接。' }

function Assert-NsisLiteral([string]$Value) {
    if ($Value -match '["$\r\n]') { throw ('路径包含 NSIS 特殊字符，未写入脚本：' + $Value) }
}
Assert-NsisLiteral $client
Assert-NsisLiteral $build
Assert-NsisLiteral $installer
$installLines = [Collections.Generic.List[string]]::new()
$uninstallLines = [Collections.Generic.List[string]]::new()
$manifest = [Collections.Generic.List[object]]::new()
$directories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($source, $file.FullName)
    Assert-NsisLiteral $relative
    if ($relative -match '(?i)(api-key|\.jsonl$|\.env$|\.clixml$|client-profile\\|desktop-server-|workroom\\events\\|\.log$)') { throw ('拒绝把运行数据打进客户端：' + $relative) }
    $destination = Join-Path $client $relative
    $parent = Split-Path -Parent $destination
    [void][IO.Directory]::CreateDirectory($parent)
    $sourceHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    if (!(Test-Path -LiteralPath $destination) -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $sourceHash) {
        Copy-Item -LiteralPath $file.FullName -Destination $destination
    }
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $sourceHash) { throw ('client 文件复制校验失败：' + $relative) }
    $relativeDir = Split-Path -Parent $relative
    $outputDir = if ($relativeDir) { '$INSTDIR\' + $relativeDir } else { '$INSTDIR' }
    $installLines.Add('SetOutPath "' + $outputDir + '"')
    $installLines.Add('File "' + $destination + '"')
    $uninstallLines.Add('Delete "$INSTDIR\' + $relative + '"')
    $manifest.Add([pscustomobject]@{path=$relative;sha256=$sourceHash;bytes=$file.Length})
    while ($relativeDir) {
        [void]$directories.Add($relativeDir)
        $relativeDir = Split-Path -Parent $relativeDir
    }
}
# 卸载只删除清单内文件；目录按深度倒序逐个非递归移除，保留用户额外文件。
foreach ($directory in ($directories | Sort-Object { $_.Split([IO.Path]::DirectorySeparatorChar).Count },Length -Descending)) {
    $uninstallLines.Add('RMDir "$INSTDIR\' + $directory + '"')
}
$installManifest = Join-Path $build 'install-files.nsh'
$uninstallManifest = Join-Path $build 'uninstall-files.nsh'
$installLines | Set-Content -LiteralPath $installManifest -Encoding utf8BOM
$uninstallLines | Set-Content -LiteralPath $uninstallManifest -Encoding utf8BOM
$manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $build 'payload.json') -Encoding utf8

$compiled = Join-Path $build 'Workroom-Setup.exe'
$arguments = @('/NOCONFIG','/INPUTCHARSET','UTF8','/OUTPUTCHARSET','UTF8','/V3','/WX',
    ('/DPRODUCT_VERSION=' + $Version),('/DINSTALLER_OUT=' + $compiled),
    ('/DINSTALL_FILES=' + $installManifest),('/DUNINSTALL_FILES=' + $uninstallManifest),
    (Join-Path $root 'installer\Workroom.nsi'))
$log = Join-Path $build 'compiler.log'
& $NsisCompiler @arguments *> $log
if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $log -Tail 45; throw ('安装包编译失败，日志：' + $log) }
if (!(Test-Path -LiteralPath $compiled)) { throw 'NSIS 未生成安装包。' }
Copy-Item -LiteralPath $compiled -Destination $installer
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
($hash + '  ' + (Split-Path -Leaf $installer)) | Set-Content -LiteralPath (Join-Path $release 'SHA256SUMS.txt') -Encoding utf8
$result = [pscustomobject]@{version=$Version;installer=$installer;client=$client;bytes=(Get-Item -LiteralPath $installer).Length;sha256=$hash;payloadFiles=$manifest.Count;build=$build;source=$source}
$result | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $root 'work\latest-installer-build.json') -Encoding utf8
$result
