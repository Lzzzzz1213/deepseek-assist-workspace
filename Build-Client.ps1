#Requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$appIcon = Join-Path $root 'web\assets\app\workroom.ico'
if (!(Test-Path -LiteralPath $appIcon -PathType Leaf)) { throw '缺少项目应用图标 web\assets\app\workroom.ico。' }
$build = [IO.Path]::GetFullPath((Join-Path $root ('work\client-build-' + $stamp)))
$publish = [IO.Path]::GetFullPath((Join-Path $root ('dist\Workroom-Windows-x64-' + $stamp)))
foreach ($path in @($build,$publish)) {
    if (!$path.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '构建输出超出当前项目。' }
    [void][IO.Directory]::CreateDirectory($path)
}
Push-Location $root
try {
    foreach ($script in @('web/app.js','web/avatars.js','web/message-list.js','web/direct-chat.js','web/markdown.js','web/vendor/markdown-it.min.js')) {
        node --check $script
        if ($LASTEXITCODE -ne 0) { throw ('前端语法检查失败：' + $script) }
    }
    python -X utf8 -m py_compile workroom_server.py private_chat.py proactive_chat.py role_identity.py deepseek_chat_provider.py deepseek_web_tools.py
    if ($LASTEXITCODE -ne 0) { throw '后端编译检查失败。' }
    # onedir 保持服务 PID 与宿主启动的进程一致，不依赖用户本机 Python。
    python -X utf8 -m PyInstaller --onedir --windowed --name WorkroomHost --icon $appIcon --distpath (Join-Path $build 'host-dist') --workpath (Join-Path $build 'host-work') --specpath $build --add-data ((Join-Path $root 'web') + ';web') (Join-Path $root 'workroom_server.py')
    if ($LASTEXITCODE -ne 0) { throw '本机服务打包失败。' }
    dotnet publish desktop/WorkroomClient.csproj -c Release -r win-x64 --self-contained true -o $publish --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Windows 客户端打包失败。' }
    Copy-Item -LiteralPath (Join-Path $build 'host-dist\WorkroomHost') -Destination (Join-Path $publish 'host') -Recurse
    @'
DeepSeek协助工作区 · Windows x64 客户端

双击 Workroom.exe 打开。关闭窗口会收起到托盘，双击托盘图标再次打开；右键托盘可以置顶或退出。

客户端内置本机服务和 .NET 运行时，不需要单独运行 Python 或浏览器。需要 Windows WebView2 Runtime，本次目标电脑已核对存在。

记录来自本机已配置的 Codex Agent → DeepSeek 委派入口，显示显式任务、公开回复和主审说明。工具操作和右侧任务栏已移除，通知顶部居中。
本版采用 Lanven UI Android / Prism 竖屏界面：青蓝紫渐变、圆角卡片及冷白/靛蓝双主题。先打开群聊列表，点群组进入聊天页，返回按钮或 Esc 返回列表；搜索、导出和其他操作在顶部按钮与菜单内。直接在 Windows 运行，无需 Android 或模拟器。
对话支持 Markdown 标题、列表、表格、引用、加粗和代码排版。长消息可展开全文；复制和导出保留原文。链接点击复制地址，图片以文字显示。
记录保存在用户本机 AppData，不随客户端目录复制。解压包不含任何模型凭据或对话数据。

这是个人本机观察工具，不代表 OpenAI 官方产品或认证。
'@ | Set-Content -LiteralPath (Join-Path $publish '使用说明.txt') -Encoding utf8
    [pscustomobject]@{directory=$publish;executable=(Join-Path $publish 'Workroom.exe');host=(Join-Path $publish 'host\WorkroomHost.exe')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'work\latest-client-build.json') -Encoding utf8
    [pscustomobject]@{directory=$publish;executable=(Join-Path $publish 'Workroom.exe')}
} finally { Pop-Location }
