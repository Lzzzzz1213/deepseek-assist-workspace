using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WorkroomClient;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
        var identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid)))[..20];
        if (args.Length == 1 && args[0] == "--exit")
        {
            try { using var signal = EventWaitHandle.OpenExisting(@"Local\WorkroomExit-" + identity); signal.Set(); }
            catch (WaitHandleCannotBeOpenedException) { }
            return;
        }
        string? diagnostics = null;
        if (args.Length > 0)
        {
            if (args.Length != 2 || args[0] != "--diagnostics")
            {
                MessageBox.Show("启动参数不正确。可选参数：--diagnostics <JSON文件路径>", "DeepSeek协助工作区");
                return;
            }
            diagnostics = Path.GetFullPath(args[1]);
        }
        using var mutex = new Mutex(true, @"Local\WorkroomClient-" + identity, out var first);
        if (!first)
        {
            try { using var signal = EventWaitHandle.OpenExisting(@"Local\WorkroomShow-" + identity); signal.Set(); }
            catch (WaitHandleCannotBeOpenedException) { MessageBox.Show("DeepSeek协助工作区正在启动，请稍候。", "DeepSeek协助工作区"); }
            return;
        }
        using var activate = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\WorkroomShow-" + identity);
        using var exit = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\WorkroomExit-" + identity);
        using var form = new WorkroomForm(diagnostics);
        var registration = ThreadPool.RegisterWaitForSingleObject(activate, (_, _) =>
        {
            if (form.IsHandleCreated && !form.IsDisposed)
                try { form.BeginInvoke(form.ShowWindow); } catch (InvalidOperationException) { }
        }, null, Timeout.Infinite, false);
        var exitRegistration = ThreadPool.RegisterWaitForSingleObject(exit, (_, _) =>
        {
            if (form.IsHandleCreated && !form.IsDisposed)
                try { form.BeginInvoke(form.ExitWindow); } catch (InvalidOperationException) { }
        }, null, Timeout.Infinite, false);
        try { Application.Run(form); }
        finally { registration.Unregister(null); exitRegistration.Unregister(null); mutex.ReleaseMutex(); }
    }
}

internal sealed class WorkroomForm : Form
{
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly Label status = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Text = "正在启动DeepSeek协助工作区…", Font = new Font("Microsoft YaHei UI", 12) };
    private readonly NotifyIcon tray;
    private readonly Icon appIcon;
    private readonly CancellationTokenSource lifetime = new();
    private readonly string stateDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeepSeekAssistWorkspace");
    private readonly string? diagnostics;
    private Process? backend;
    private Uri? origin;
    private bool exitRequested;
    private bool cleanupDone;
    private bool cleanupStarted;
    private bool diagnosticWritten;
    private long lastPrivateNotificationId;

    internal WorkroomForm(string? diagnosticsPath)
    {
        diagnostics = diagnosticsPath;
        appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        Text = "DeepSeek协助工作区";
        AutoScaleMode = AutoScaleMode.None;
        // 窄长窗口承载单列聊天页面；按DPI换算，并限制在当前屏幕可用区域内。
        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        var scale = DeviceDpi / 96f;
        ClientSize = new Size((int)(420 * scale), (int)(780 * scale));
        Width = Math.Min(Width, area.Width - 32);
        Height = Math.Min(Height, area.Height - 32);
        MinimumSize = new Size(Math.Min((int)(340 * scale), Width), Math.Min((int)(560 * scale), Height));
        MaximumSize = new Size(Math.Min((int)(520 * scale), area.Width - 32), area.Height - 16);
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Icon = appIcon;
        Controls.Add(browser);
        Controls.Add(status);
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开", null, (_, _) => ShowWindow());
        var top = new ToolStripMenuItem("窗口置顶") { CheckOnClick = true };
        top.CheckedChanged += (_, _) => TopMost = top.Checked;
        menu.Items.Add(top);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => RequestExit());
        tray = new NotifyIcon { Icon = appIcon, Text = "DeepSeek协助工作区", Visible = true, ContextMenuStrip = menu };
        tray.DoubleClick += (_, _) => ShowWindow();
        tray.BalloonTipClicked += OnPrivateChatNotificationClicked;
        Shown += async (_, _) => await InitializeAsync();
        FormClosing += OnClosing;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && !ReferenceEquals(appIcon, SystemIcons.Application)) appIcon.Dispose();
    }

    internal void ShowWindow()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        BringToFront();
    }

    private void RequestExit() { exitRequested = true; Close(); }
    internal void ExitWindow() => RequestExit();

    private async Task InitializeAsync()
    {
        try
        {
            // 只使用打包目录中的专用后端，不读取其他服务状态、不连接默认18765服务。
            var executable = Path.Combine(AppContext.BaseDirectory, "host", "WorkroomHost.exe");
            if (!File.Exists(executable)) throw new InvalidOperationException("缺少 host\\WorkroomHost.exe。请解压完整客户端目录后启动。");
            try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (WebView2RuntimeNotFoundException) { throw new InvalidOperationException("未检测到 Microsoft Edge WebView2 Runtime，请先安装运行环境后再启动。客户端不会自动安装。"); }
            Directory.CreateDirectory(stateDirectory);
            var runtimePath = Path.Combine(stateDirectory, $"desktop-server-{Environment.ProcessId}.json");
            // 文件名属于本次客户端PID；移除旧metadata只为防止PID复用误读，不据此终止进程。
            if (File.Exists(runtimePath)) File.Delete(runtimePath);
            var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = AppContext.BaseDirectory };
            foreach (var arg in new[] { "--port", "0", "--runtime-file", runtimePath, "--view-state-dir", stateDirectory }) start.ArgumentList.Add(arg);
            backend = Process.Start(start) ?? throw new InvalidOperationException("无法启动本机观察服务。");
            using var http = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(2) };
            var deadline = DateTime.UtcNow.AddSeconds(45);
            while (DateTime.UtcNow < deadline)
            {
                lifetime.Token.ThrowIfCancellationRequested();
                if (backend.HasExited) throw new InvalidOperationException("本机观察服务已提前退出，请检查客户端文件是否完整。");
                try
                {
                    if (File.Exists(runtimePath))
                    {
                        using var metadata = JsonDocument.Parse(await File.ReadAllTextAsync(runtimePath, lifetime.Token));
                        var root = metadata.RootElement;
                        var pid = root.GetProperty("pid").GetInt32();
                        var port = root.GetProperty("port").GetInt32();
                        var address = root.GetProperty("baseUrl").GetString();
                        if (!DateTimeOffset.TryParse(root.GetProperty("startedAt").GetString(), out var serverStarted) || serverStarted < new DateTimeOffset(backend.StartTime).AddSeconds(-2) || serverStarted > DateTimeOffset.UtcNow.AddSeconds(5))
                            throw new InvalidOperationException("本机服务启动时间校验失败，已停止连接。");
                        if (pid != backend.Id || port is < 1 or > 65535 || !Uri.TryCreate(address, UriKind.Absolute, out var candidate) || candidate.Scheme != "http" || candidate.Host != "127.0.0.1" || candidate.Port != port || candidate.AbsolutePath != "/" || candidate.Query.Length != 0 || candidate.Fragment.Length != 0 || candidate.UserInfo.Length != 0)
                            throw new InvalidOperationException("本机服务身份或地址校验失败，已停止连接。");
                        using var response = await http.GetAsync(new Uri(candidate, "/health"), lifetime.Token);
                        if (response.IsSuccessStatusCode)
                        {
                            using var health = JsonDocument.Parse(await response.Content.ReadAsStringAsync(lifetime.Token));
                            if (health.RootElement.GetProperty("application").GetString() != "Codex DeepSeek Workroom") throw new InvalidOperationException("本机服务类型校验失败。");
                            origin = candidate;
                            break;
                        }
                    }
                }
                catch (JsonException) { }
                catch (IOException) { }
                catch (HttpRequestException) { }
                catch (TaskCanceledException) when (!lifetime.IsCancellationRequested) { }
                await Task.Delay(150, lifetime.Token);
            }
            if (origin is null) throw new InvalidOperationException("本机观察服务启动超时，请退出后重试。");
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(stateDirectory, "client-profile"));
            lifetime.Token.ThrowIfCancellationRequested();
            await browser.EnsureCoreWebView2Async(environment);
            var core = browser.CoreWebView2;
            // Windows 竖屏客户端整体缩小一档，字体、控件与间距保持同比例。
            browser.ZoomFactor = 0.85;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsWebMessageEnabled = true;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.NavigationStarting += (_, e) => { if (!AllowedAddress(e.Uri)) e.Cancel = true; };
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.LaunchingExternalUriScheme += (_, e) => e.Cancel = true;
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.WebMessageReceived += OnPrivateChatWebMessage;
            core.DownloadStarting += OnDownload;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, e) =>
            {
                if (!AllowedAddress(e.Request.Uri)) e.Response = environment.CreateWebResourceResponse(null, 403, "Blocked", "Content-Type: text/plain");
            };
            core.NavigationCompleted += async (_, e) =>
            {
                if (!e.IsSuccess) { status.Text = "页面加载失败，请退出客户端后重试。"; status.Visible = true; return; }
                status.Visible = false;
                if (diagnostics is not null && !diagnosticWritten)
                {
                    diagnosticWritten = true;
                    await WriteDiagnosticsAsync();
                }
            };
            core.Navigate(origin.AbsoluteUri);
        }
        catch (OperationCanceledException) when (exitRequested) { }
        catch (Exception ex)
        {
            if (!exitRequested)
            {
                var safeMessage = ex is InvalidOperationException ? ex.Message : "客户端初始化失败。请确认完整文件已解压且 WebView2 Runtime 可用。";
                MessageBox.Show(this, safeMessage, "DeepSeek协助工作区", MessageBoxButtons.OK, MessageBoxIcon.Error);
                RequestExit();
            }
        }
    }

    private bool AllowedAddress(string value)
    {
        if (origin is null) return false;
        if (value.StartsWith("blob:" + origin.GetLeftPart(UriPartial.Authority) + "/", StringComparison.Ordinal)) return true;
        return Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == origin.Scheme && uri.Host == origin.Host && uri.Port == origin.Port && uri.UserInfo.Length == 0;
    }

    private static bool IsPrivateChatMessageSource(Uri? expectedOrigin, string value)
    {
        // 通知桥接只接受本次服务的首页，不沿用可接受blob下载地址的宽导航检查。
        return expectedOrigin is not null &&
            Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.Port == expectedOrigin.Port &&
            expectedOrigin.Scheme == "http" && expectedOrigin.Host == "127.0.0.1" &&
            expectedOrigin.AbsolutePath == "/" && expectedOrigin.UserInfo.Length == 0 &&
            expectedOrigin.Query.Length == 0 && expectedOrigin.Fragment.Length == 0 &&
            uri.AbsolutePath == "/" && uri.UserInfo.Length == 0 && uri.Query.Length == 0 && uri.Fragment.Length == 0 &&
            string.Equals(value, expectedOrigin.AbsoluteUri, StringComparison.Ordinal);
    }

    private static bool TryReadPrivateChatNotification(string json, out long messageId, out string preview)
    {
        messageId = 0;
        preview = "";
        if (json.Length > 2048 || Encoding.UTF8.GetByteCount(json) > 2048) return false;
        try
        {
            using var payload = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 4 });
            var root = payload.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in root.EnumerateObject())
                if (!names.Add(property.Name) || property.Name is not ("type" or "id" or "text")) return false;
            if (names.Count != 3 || root.GetProperty("type").ValueKind != JsonValueKind.String ||
                root.GetProperty("type").GetString() != "workroom.privateChatNotification" ||
                !root.GetProperty("id").TryGetInt64(out messageId) || messageId is <= 0 or > 9007199254740991 ||
                root.GetProperty("text").ValueKind != JsonValueKind.String) return false;
            var supplied = root.GetProperty("text").GetString()!;
            if (supplied.Length > 140) return false;
            var plain = new StringBuilder(supplied.Length);
            foreach (var character in supplied)
                if (!char.IsControl(character) && char.GetUnicodeCategory(character) != UnicodeCategory.Format)
                    plain.Append(character);
            preview = plain.ToString().Trim();
            if (preview.Length == 0) preview = "鲸鲸发来一条新消息。";
            return true;
        }
        catch (JsonException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    private void OnPrivateChatWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (exitRequested || cleanupStarted || !IsPrivateChatMessageSource(origin, e.Source) ||
            !TryReadPrivateChatNotification(e.WebMessageAsJson, out var messageId, out var preview) ||
            messageId <= lastPrivateNotificationId) return;
        lastPrivateNotificationId = messageId;
        // 唯一宿主动作是系统通知；消息内容从不进入脚本、命令、文件或工作Agent接口。
        try { tray.ShowBalloonTip(10000, "鲸鲸来找你啦", preview, ToolTipIcon.Info); }
        catch (InvalidOperationException) { }
        catch (ArgumentException) { }
    }

    private async void OnPrivateChatNotificationClicked(object? sender, EventArgs e)
    {
        if (exitRequested || cleanupStarted) return;
        ShowWindow();
        var core = browser.CoreWebView2;
        if (core is null || !IsPrivateChatMessageSource(origin, core.Source)) return;
        try
        {
            // 固定事件只打开既有唯一私聊，不拼接通知正文或允许任意宿主调用。
            await core.ExecuteScriptAsync("window.dispatchEvent(new Event('workroom-open-private-chat'));");
        }
        catch (InvalidOperationException) { }
    }

    private async void OnDownload(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        e.Handled = true;
        e.Cancel = true;
        if (!AllowedAddress(e.DownloadOperation.Uri)) return;
        using var deferral = e.GetDeferral();
        // 先退出 WebView2 回调再打开模态保存框，避免嵌套消息循环重入。
        await Task.Yield();
        using var dialog = new SaveFileDialog { Title = "导出协作记录", Filter = "JSON 文件 (*.json)|*.json", DefaultExt = "json", AddExtension = true, FileName = "DeepSeek协助工作区.json", OverwritePrompt = true };
        if (!IsDisposed && dialog.ShowDialog(this) == DialogResult.OK) { e.ResultFilePath = dialog.FileName; e.Cancel = false; }
        deferral.Complete();
    }

    private async Task WriteDiagnosticsAsync()
    {
        try
        {
            // 只记录界面结构计数与连接标签，不读取消息正文、cookie或接口原始响应。
            await Task.Delay(1800, lifetime.Token);
            const string script = "JSON.stringify({title:document.title,viewportWidth:innerWidth,viewportHeight:innerHeight,pixelRatio:devicePixelRatio,view:document.querySelector('#app')?.classList.contains('is-view-rooms')?'rooms':'chat',visiblePanes:Array.from(document.querySelectorAll('.wr-body>.wr-col')).filter(x=>getComputedStyle(x).display!=='none').length,taskPanel:!!document.querySelector('#taskPanel'),toolCount:document.querySelectorAll('.wr-tool').length,bodyChildCount:document.querySelector('.wr-body')?.children.length??0,roomButtonCount:document.querySelectorAll('#roomList button').length,ready:document.readyState,connected:document.querySelector('#connPill')?.dataset.st??'',connectionText:document.querySelector('#connPill')?.textContent.trim().slice(0,64)??''})";
            var quoted = await browser.CoreWebView2.ExecuteScriptAsync(script);
            var json = JsonSerializer.Deserialize<string>(quoted) ?? "{}";
            Directory.CreateDirectory(Path.GetDirectoryName(diagnostics!)!);
            await File.WriteAllTextAsync(diagnostics!, json, new UTF8Encoding(false), lifetime.Token);
            await using var image = File.Create(Path.ChangeExtension(diagnostics!, ".png"));
            await browser.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);
        }
        catch (OperationCanceledException) { }
        catch (Exception) { MessageBox.Show(this, "客户端已启动，但诊断文件未能保存。", "DeepSeek协助工作区"); }
    }

    private async void OnClosing(object? sender, FormClosingEventArgs e)
    {
        if (e.CloseReason is CloseReason.WindowsShutDown or CloseReason.TaskManagerClosing) exitRequested = true;
        if (!exitRequested) { e.Cancel = true; Hide(); return; }
        if (cleanupDone) return;
        e.Cancel = true;
        if (cleanupStarted) return;
        cleanupStarted = true;
        lifetime.Cancel();
        tray.Visible = false;
        browser.Dispose();
        try
        {
            // 只终止自己持有的Process对象；从不按metadata或固定端口查杀外部服务。
            if (backend is not null && !backend.HasExited)
            {
                backend.Kill(entireProcessTree: true);
                await backend.WaitForExitAsync();
            }
        }
        catch (InvalidOperationException) { }
        catch (Exception) { MessageBox.Show(this, "窗口已退出，但本次观察服务未能确认停止。请检查本次 WorkroomHost 进程。", "DeepSeek协助工作区"); }
        finally
        {
            backend?.Dispose();
            tray.Dispose();
            cleanupDone = true;
            Close();
        }
    }
}
