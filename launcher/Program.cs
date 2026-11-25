using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace D2Checkpoint.Launcher;

internal static class StartupDiagnostics
{
    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "D2Checkpoint", "startup.log");

    public static void Write(string stage, Exception? error = null)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            var detail = error is null ? string.Empty : $" type={error.GetType().FullName} hresult=0x{error.HResult:X8} message={error.Message.Replace('\r', ' ').Replace('\n', ' ')}";
            File.AppendAllText(LogPath, $"{DateTimeOffset.UtcNow:O} {stage}{detail}{Environment.NewLine}", new UTF8Encoding(false));
        }
        catch { }
    }
}

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        try
        {
            StartupDiagnostics.Write("launcher-main-entered");
            ApplicationConfiguration.Initialize();
            StartupDiagnostics.Write("winforms-initialized");
            using var instance = new Mutex(true, "Local\\D2Checkpoint.PortableShell", out bool createdNew);
            if (!createdNew)
            {
                MessageBox.Show("检查点指挥台已在系统托盘中运行。", NativeTheme.WorkbenchTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            StartupDiagnostics.Write("application-loop-entered");
            Application.Run(new D2AppContext());
            StartupDiagnostics.Write("application-loop-exited");
        }
        catch (Exception error)
        {
            StartupDiagnostics.Write("launcher-main-failed", error);
            try { MessageBox.Show("程序启动失败。请查看 %LOCALAPPDATA%\\D2Checkpoint\\startup.log。", NativeTheme.WorkbenchTitle, MessageBoxButtons.OK, MessageBoxIcon.Error); } catch { }
            Environment.ExitCode = 1;
        }
    }
}

internal sealed class D2AppContext : ApplicationContext
{
    private readonly Form _dispatcher;
    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _showItem;
    private Process? _node;
    private Uri? _serviceUri;
    private string _launchKey = string.Empty;
    private DesktopWindow? _desktopWindow;
    private TwitchBrowserWindow? _twitchWindow;
    private TwitchBrowserWindow? _backgroundTwitchWindow;
    private BrowserFallback? _browser;
    private bool _browserBootstrapped;
    private bool _bootstrapPending;
    private bool _stopping;
    private DateTime _lastShowUtc = DateTime.MinValue;

    public D2AppContext()
    {
        _showItem = new ToolStripMenuItem("打开指挥台", null, (_, _) => ShowConsole());
        var menu = new ContextMenuStrip();
        NativeTheme.StyleTrayMenu(menu);
        menu.Items.Add(_showItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("退出", null, (_, _) => ExitThread()));
        _tray = new NotifyIcon
        {
            Icon = NativeTheme.WorkbenchIcon,
            Text = NativeTheme.WorkbenchTitle,
            ContextMenuStrip = menu,
            Visible = true
        };
        _tray.DoubleClick += (_, _) => ShowConsole();

        _dispatcher = new Form
        {
            Text = "D2Checkpoint",
            ShowInTaskbar = false,
            ShowIcon = false,
            FormBorderStyle = FormBorderStyle.FixedToolWindow,
            StartPosition = FormStartPosition.Manual,
            Location = new Point(-32000, -32000),
            Size = new Size(1, 1),
            Opacity = 0
        };
        MainForm = _dispatcher;
        _ = _dispatcher.Handle;
        Application.Idle += StartOnIdle;
    }

    private void StartOnIdle(object? sender, EventArgs e)
    {
        Application.Idle -= StartOnIdle;
        _ = StartAsync();
    }

    private async Task StartAsync()
    {
        try
        {
            StartupDiagnostics.Write("startup-init-entered");
            var launchKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            _launchKey = launchKey;
            StartupDiagnostics.Write("starting-node-service");
            _serviceUri = await StartServiceAsync(launchKey);
            StartupDiagnostics.Write("node-service-ready");
            if (_stopping) return;
            DesktopWindow? window = null;
            try
            {
                var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "D2Checkpoint", "WebView2Profile");
                window = new DesktopWindow(_serviceUri, profile);
                await window.InitializeAsync(launchKey);
                if (_stopping)
                {
                    window.Dispose();
                    return;
                }
                _desktopWindow = window;
                window.FormClosing += NativeWindowClosing;
                window.OpenTwitchRequested += login => _ = OpenTwitchWindowAsync(login);
                window.OpenTwitchChatRequested += login => _ = OpenTwitchWindowAsync(login, chat: true);
                window.SendTwitchWebRequested += (login, command, requestId) => _ = SendTwitchWebAsync(login, command, requestId);
                window.ReadTwitchChannelRequested += (login, requestId, background) => _ = ReadTwitchChannelAsync(login, requestId, background);
                window.CancelTwitchChannelReadRequested += requestId =>
                {
                    _twitchWindow?.CancelChannelRead(requestId);
                    _backgroundTwitchWindow?.CancelChannelRead(requestId);
                };
                window.Show();
                _launchKey = string.Empty;
                launchKey = string.Empty;
                return;
            }
            catch (Exception)
            {
                window?.Dispose();
                if (_stopping) return;
                // WebView2 is optional; never expose the launch key in a URL, log, or error dialog.
            }
            _browser = BrowserFallback.Find();
            if (_browser is null)
                throw new InvalidOperationException("未找到可用的 WebView2 运行时，也未找到 Microsoft Edge 或 Google Chrome。请安装其中一项后重试。 ");
            await OpenFallbackAsync(launchKey);
            _launchKey = string.Empty;
            launchKey = string.Empty;
        }
        catch (Exception ex)
        {
            StartupDiagnostics.Write("startup-failed", ex);
            if (!_stopping)
            {
                MessageBox.Show(ex.Message, NativeTheme.WorkbenchTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                ExitThread();
            }
        }
    }

    private TwitchBrowserWindow GetTwitchWindow(DesktopWindow dashboard, bool background = false)
    {
        var active = background ? _backgroundTwitchWindow : _twitchWindow;
        if (active is { IsDisposed: false }) return active;
        var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "D2Checkpoint", "TwitchProfile");
        var window = new TwitchBrowserWindow(profile, dashboard, background);
        if (background) _backgroundTwitchWindow = window;
        else _twitchWindow = window;
        return window;
    }

    private async Task OpenTwitchWindowAsync(string login, bool chat = false)
    {
        if (!DesktopWindow.TryNormalizeTwitchLogin(login, out var validLogin) || _stopping || _desktopWindow is not { } dashboard) return;
        TwitchBrowserWindow? active = null;
        try
        {
            active = GetTwitchWindow(dashboard);
            if (chat) await active.ShowChatAsync(validLogin);
            else await active.ShowChannelAsync(validLogin);
            if (!chat && !_stopping && ReferenceEquals(_desktopWindow, dashboard))
                dashboard.PostTwitchWindowOpened(validLogin);
        }
        catch (Exception error)
        {
            StartupDiagnostics.Write($"twitch-window-open-failed type={error.GetType().Name} hresult=0x{error.HResult:X8}");
            if (active is not null && ReferenceEquals(active, _twitchWindow))
            {
                _twitchWindow = null;
                active.AllowCloseAndDispose();
            }
            if (_stopping) return;
            _desktopWindow?.PostTwitchWindowError("无法打开 Twitch 频道窗口，请重试。");
        }
    }

    private async Task SendTwitchWebAsync(string login, string command, string requestId)
    {
        if (_stopping || _desktopWindow is not { } dashboard) return;
        try
        {
            var result = await GetTwitchWindow(dashboard).SubmitChatAsync(login, command);
            dashboard.PostTwitchWebResult(requestId, result.Submitted, result.Message);
        }
        catch
        {
            dashboard.PostTwitchWebResult(requestId, false, "无法读取网页提交结果。请先检查 Twitch 聊天记录，再决定是否重试。");
        }
    }

    private async Task ReadTwitchChannelAsync(string login, string requestId, bool background)
    {
        if (_stopping || _desktopWindow is not { } dashboard) return;
        try
        {
            var result = await GetTwitchWindow(dashboard, background).ReadChannelAsync(login, requestId);
            dashboard.PostTwitchChannelRead(login, requestId, result);
        }
        catch
        {
            dashboard.PostTwitchChannelRead(login, requestId, new([], "无法读取这个 Twitch 频道，请检查直播窗口或网络。"));
        }
    }

    private async Task<Uri> StartServiceAsync(string launchKey)
    {
        // In a single-file self-extracting publish, AppContext.BaseDirectory may point
        // at .NET's temporary extraction directory. Resolve bundled assets beside the EXE.
        var executable = Environment.ProcessPath;
        var root = !string.IsNullOrWhiteSpace(executable)
            ? Path.GetDirectoryName(executable) ?? AppContext.BaseDirectory
            : AppContext.BaseDirectory;
        var appDir = Path.Combine(root, "app");
        var mainJs = Path.Combine(appDir, "desktop", "main.js");
        var nodeExe = Path.Combine(root, "runtime", "node.exe");
        StartupDiagnostics.Write($"service-files bundledRoot={root} node={File.Exists(nodeExe)} main={File.Exists(mainJs)}");
        if (!File.Exists(nodeExe) || !File.Exists(mainJs))
            throw new FileNotFoundException("便携程序文件不完整：缺少内置 Node.js 运行时或桌面服务。请重新解压完整软件包。");

        var start = new ProcessStartInfo
        {
            FileName = nodeExe,
            WorkingDirectory = appDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false)
        };
        start.ArgumentList.Add(mainJs);
        start.Environment["D2_PORT"] = "0";
        start.Environment["D2_HOST"] = "127.0.0.1";
        start.Environment["D2_LAUNCH_KEY"] = launchKey;
        start.Environment["NODE_USE_ENV_PROXY"] = "1";
        start.Environment["NODE_USE_SYSTEM_CA"] = "1";
        start.Environment.TryGetValue("NO_PROXY", out var bypass);
        start.Environment["NO_PROXY"] = string.IsNullOrWhiteSpace(bypass) ? "localhost,127.0.0.1" : $"{bypass},localhost,127.0.0.1";
        start.Environment.TryGetValue("HTTPS_PROXY", out var configuredProxy);
        if (string.IsNullOrWhiteSpace(configuredProxy))
        {
            // Honor the current Windows user's proxy without delaying the local service indefinitely.
            try
            {
                var destination = new Uri("https://api.twitch.tv/");
                var proxy = await Task.Run(() => HttpClient.DefaultProxy.GetProxy(destination)).WaitAsync(TimeSpan.FromSeconds(2));
                if (proxy != destination && proxy is { Scheme: "http" or "https" }) start.Environment["HTTPS_PROXY"] = proxy.AbsoluteUri;
            }
            catch (Exception) { /* The local workbench can still start without the proxy lookup. */ }
        }

        var process = new Process { StartInfo = start, EnableRaisingEvents = true };
        process.Exited += (_, _) => OnServiceExited();
        if (!process.Start()) throw new InvalidOperationException("无法启动本地服务。");
        _node = process;
        // Drain stderr, but deliberately do not persist or display service output.
        _ = Task.Run(async () => { try { while (await process.StandardError.ReadLineAsync() is not null) { } } catch { } });
        start.Environment.Remove("D2_LAUNCH_KEY");

        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            var lineTask = process.StandardOutput.ReadLineAsync();
            var remaining = deadline - DateTime.UtcNow;
            if (remaining <= TimeSpan.Zero) break;
            var winner = await Task.WhenAny(lineTask, Task.Delay(remaining));
            if (winner != lineTask) break;
            var line = await lineTask;
            if (line is null) break;
            if (line.StartsWith("D2_READY ", StringComparison.Ordinal) && TryParseReadyUri(line.AsSpan(9), out var uri))
            {
                _ = Task.Run(async () => { try { while (await process.StandardOutput.ReadLineAsync() is not null) { } } catch { } });
                return uri;
            }
        }
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
        throw new InvalidOperationException("本地服务未能在 30 秒内启动。请重新启动软件；服务输出不会写入日志。");
    }

    private static bool TryParseReadyUri(ReadOnlySpan<char> value, out Uri uri)
    {
        uri = null!;
        if (!Uri.TryCreate(value.ToString(), UriKind.Absolute, out var candidate)) return false;
        if (candidate.Scheme != Uri.UriSchemeHttp || candidate.Host != "127.0.0.1" || candidate.Port is < 1 or > 65535 ||
            candidate.AbsolutePath != "/" || candidate.Query.Length != 0 || candidate.Fragment.Length != 0 ||
            candidate.UserInfo.Length != 0)
            return false;
        uri = candidate;
        return true;
    }

    private async Task OpenFallbackAsync(string launchKey)
    {
        if (_serviceUri is null || _browser is null || _bootstrapPending) return;
        _bootstrapPending = true;
        var proxy = new BrowserBootstrap(_serviceUri, launchKey);
        try
        {
            await proxy.StartAsync();
            if (_stopping) return;
            _browser.Open(proxy.BootstrapUri);
            _browserBootstrapped = await proxy.Completion;
            if (!_browserBootstrapped && !_stopping)
                throw new InvalidOperationException("无法安全建立本地浏览器会话，请从系统托盘再次打开控制台。");
        }
        finally
        {
            _bootstrapPending = false;
            await proxy.DisposeAsync();
        }
    }

    private void NativeWindowClosing(object? sender, FormClosingEventArgs e)
    {
        if (_stopping) return;
        e.Cancel = true;
        _desktopWindow?.Hide();
    }

    private async void ShowConsole()
    {
        if (_stopping || _serviceUri is null) return;
        if (DateTime.UtcNow - _lastShowUtc < TimeSpan.FromMilliseconds(750)) return;
        _lastShowUtc = DateTime.UtcNow;
        if (_desktopWindow is not null && !_desktopWindow.IsDisposed)
        {
            _desktopWindow.Show();
            _desktopWindow.WindowState = FormWindowState.Normal;
            _desktopWindow.Activate();
            return;
        }
        if (_browser is null) return;
        try
        {
            if (_browserBootstrapped)
                _browser.Open(_serviceUri);
            else if (!_bootstrapPending)
                await OpenFallbackAsync(_launchKey);
        }
        catch (Exception)
        {
            if (!_stopping)
                MessageBox.Show("无法打开指挥台窗口。服务仍在系统托盘中运行，请再次选择“打开指挥台”重试。", NativeTheme.WorkbenchTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void OnServiceExited()
    {
        if (_stopping) return;
        try
        {
            if (_dispatcher.IsHandleCreated && !_dispatcher.IsDisposed)
                _dispatcher.BeginInvoke(new Action(() =>
                {
                    if (!_stopping)
                    {
                        MessageBox.Show("本地服务已停止，指挥台即将退出。", NativeTheme.WorkbenchTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        ExitThread();
                    }
                }));
        }
        catch { }
    }

    protected override void ExitThreadCore()
    {
        if (_stopping) return;
        _stopping = true;
        Application.Idle -= StartOnIdle;
        _launchKey = string.Empty;
        try { _desktopWindow?.AllowCloseAndDispose(); } catch { }
        try { _twitchWindow?.AllowCloseAndDispose(); } catch { }
        try { _backgroundTwitchWindow?.AllowCloseAndDispose(); } catch { }
        try { _browser?.Dispose(); } catch { }
        try
        {
            if (_node is { HasExited: false })
            {
                _node.Kill(entireProcessTree: true);
                _node.WaitForExit(2500);
            }
        }
        catch { }
        try { _node?.Dispose(); } catch { }
        _tray.Visible = false;
        _tray.Dispose();
        base.ExitThreadCore();
    }
}

internal sealed class DesktopWindow : Form
{
    private readonly Uri _serviceUri;
    private readonly string _profilePath;
    private readonly WebView2 _webView = new();
    private readonly System.Windows.Forms.Timer _progressPollTimer = new();
    private bool _allowClose;

    public event Action<string>? OpenTwitchRequested;
    public event Action<string>? OpenTwitchChatRequested;
    public event Action<string, string, string>? SendTwitchWebRequested;
    public event Action<string, string, bool>? ReadTwitchChannelRequested;
    public event Action<string>? CancelTwitchChannelReadRequested;

    public DesktopWindow(Uri serviceUri, string profilePath)
    {
        _serviceUri = serviceUri;
        _profilePath = profilePath;
        Text = NativeTheme.WorkbenchTitle;
        NativeTheme.StyleWindow(this);
        MinimumSize = new Size(820, 560);
        Size = new Size(1200, 800);
        StartPosition = FormStartPosition.CenterScreen;
        _webView.DefaultBackgroundColor = NativeTheme.Background;
        _webView.Dock = DockStyle.Fill;
        Controls.Add(_webView);
        _progressPollTimer.Tick += (_, _) =>
        {
            _progressPollTimer.Stop();
            if (_allowClose || _webView.CoreWebView2 is not { } core || !IsDashboardDocument(core.Source)) return;
            try { core.PostWebMessageAsJson("""{"type":"progress-poll-due"}"""); }
            catch (Exception) { }
        };
    }

    public async Task InitializeAsync(string launchKey)
    {
        Directory.CreateDirectory(_profilePath);
        var environment = await CoreWebView2Environment.CreateAsync(browserExecutableFolder: null, userDataFolder: _profilePath);
        await _webView.EnsureCoreWebView2Async(environment);
        _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
        _webView.CoreWebView2.Settings.AreDefaultScriptDialogsEnabled = true;
        _webView.CoreWebView2.WebMessageReceived += (_, e) => HandleDashboardMessage(e);
        _webView.CoreWebView2.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };
        _webView.CoreWebView2.NavigationStarting += (_, e) =>
        {
            if (IsServiceOrigin(e.Uri))
            {
                _progressPollTimer.Stop();
                return;
            }
            e.Cancel = true;
            OpenExternal(e.Uri);
        };

        var request = environment.CreateWebResourceRequest(
            _serviceUri.AbsoluteUri,
            "GET",
            null,
            $"X-D2-Launch-Key: {launchKey}\r\n");
        _webView.CoreWebView2.NavigateWithWebResourceRequest(request);
    }

    private void HandleDashboardMessage(CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            if (!IsDashboardDocument(e.Source)) return;
            using var message = JsonDocument.Parse(e.WebMessageAsJson, new JsonDocumentOptions { MaxDepth = 8 });
            if (message.RootElement.ValueKind != JsonValueKind.Object ||
                !message.RootElement.TryGetProperty("type", out var typeElement) ||
                typeElement.ValueKind != JsonValueKind.String) return;
            var root = message.RootElement;
            var type = typeElement.GetString();
            var hasLogin = TryNormalizeTwitchLogin(ReadString(root, "login"), out var login);
            if (type == "open-twitch" && hasLogin) OpenTwitchRequested?.Invoke(login);
            else if (type == "open-twitch-chat" && hasLogin) OpenTwitchChatRequested?.Invoke(login);
            else if (type == "read-twitch-channel" && hasLogin && ReadString(root, "requestId") is { } readId && TwitchChatPage.IsRequestId(readId))
                ReadTwitchChannelRequested?.Invoke(login, readId, root.TryGetProperty("background", out var background) && background.ValueKind == JsonValueKind.True);
            else if (type == "cancel-twitch-channel-read" && ReadString(root, "requestId") is { } cancelId && TwitchChatPage.IsRequestId(cancelId))
                CancelTwitchChannelReadRequested?.Invoke(cancelId);
            else if (type == "schedule-progress-poll" && root.TryGetProperty("delayMs", out var delay) && delay.ValueKind == JsonValueKind.Number &&
                delay.TryGetInt32(out var delayMs) && delayMs >= 0)
            {
                _progressPollTimer.Stop();
                if (delayMs > 0)
                {
                    _progressPollTimer.Interval = Math.Min(delayMs, 5 * 60_000);
                    _progressPollTimer.Start();
                }
            }
            else if (type == "send-twitch-web" && ReadString(root, "requestId") is { } requestId && TwitchChatPage.IsRequestId(requestId))
            {
                var command = ReadString(root, "command");
                if (!hasLogin || command is null || !TwitchChatPage.IsQueueCommand(login, command))
                {
                    PostTwitchWebResult(requestId, false, "频道或申请指令无效，请重新预览。");
                    return;
                }
                SendTwitchWebRequested?.Invoke(login, command, requestId);
            }
        }
        catch (JsonException) { }
        catch (Exception) { }
    }

    private static string? ReadString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;

    internal bool PostScreenCapture(string login, string requestId, string imageBase64)
    {
        if (_allowClose || IsDisposed || _webView.IsDisposed || _webView.CoreWebView2 is null) return false;
        try
        {
            var payload = JsonSerializer.Serialize(new { type = "screen-capture", login, requestId, imageBase64 });
            _webView.CoreWebView2.PostWebMessageAsJson(payload);
            return true;
        }
        catch (Exception) { return false; }
    }

    internal void PostTwitchWindowOpened(string login)
    {
        if (_allowClose || IsDisposed || _webView.IsDisposed || _webView.CoreWebView2 is null) return;
        try { _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "twitch-window-opened", login })); }
        catch (Exception) { }
    }

    internal void PostTwitchWindowError(string message)
    {
        if (_allowClose || IsDisposed || _webView.IsDisposed || _webView.CoreWebView2 is null) return;
        try { _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "twitch-window-error", message })); }
        catch (Exception) { }
    }

    internal void PostTwitchWebResult(string requestId, bool submitted, string message)
    {
        if (_allowClose || IsDisposed || _webView.IsDisposed || _webView.CoreWebView2 is not { } core || !IsDashboardDocument(core.Source)) return;
        try { core.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "twitch-web-result", requestId, submitted, message })); }
        catch (Exception) { }
    }

    internal void PostTwitchChannelRead(string login, string requestId, TwitchPreviewCapture.Result result)
    {
        if (_allowClose || IsDisposed || _webView.IsDisposed || _webView.CoreWebView2 is not { } core || !IsDashboardDocument(core.Source)) return;
        try
        {
            core.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "twitch-channel-read", login, requestId, frames = result.Frames, message = result.Message,
                interrupted = result.Interrupted, frameInfo = result.FrameInfo
            }));
        }
        catch (Exception) { }
    }

    internal static bool TryNormalizeTwitchLogin(string? value, out string login)
    {
        login = string.Empty;
        if (string.IsNullOrWhiteSpace(value)) return false;
        var candidate = value.Trim().ToLowerInvariant();
        if (candidate.Length is < 1 or > 25 || candidate.Any(ch => !(ch is >= 'a' and <= 'z' or >= '0' and <= '9' or '_'))) return false;
        login = candidate;
        return true;
    }

    private bool IsServiceOrigin(string text)
    {
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri)) return false;
        return uri.Scheme == Uri.UriSchemeHttp && uri.Host == _serviceUri.Host && uri.Port == _serviceUri.Port;
    }

    private bool IsDashboardDocument(string text)
    {
        if (!IsServiceOrigin(text) || !Uri.TryCreate(text, UriKind.Absolute, out var uri)) return false;
        return uri.AbsolutePath is "/" or "/index.html";
    }

    internal static bool OpenExternal(string text)
    {
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)) return false;
        try
        {
            using var process = Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            return true;
        }
        catch { return false; }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_allowClose && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnFormClosing(e);
    }

    public void AllowCloseAndDispose()
    {
        _allowClose = true;
        Close();
        Dispose();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _progressPollTimer.Dispose();
        base.Dispose(disposing);
    }
}

internal sealed class TwitchBrowserWindow : Form
{
    private const int MaxCaptureBytes = 6 * 1024 * 1024;
    private const int ChannelLoadTimeoutMilliseconds = 20_000;
    private const int ChatLoadTimeoutMilliseconds = 12_000;
    private const int ReadChannelTimeoutMilliseconds = 18_000;
    private const int PreferredVideoWaitMilliseconds = 5_000;
    private const string CaptureHint = "仅识别当前可见直播画面；登录、验证、密码页面请勿启用。";
    private readonly string _profilePath;
    private readonly DesktopWindow _dashboard;
    private readonly bool _background;
    private readonly WebView2 _webView = new();
    private readonly TextBox _address = new();
    private readonly Button _back = new();
    private readonly Button _forward = new();
    private readonly Button _reload = new();
    private readonly Button _capture = new();
    private readonly Button _external = new();
    private readonly CheckBox _auto = new();
    private readonly Label _status = new();
    private readonly System.Windows.Forms.Timer _autoTimer = new() { Interval = 15_000 };
    private readonly System.Windows.Forms.Timer _channelTimer = new() { Interval = 1000 };
    private readonly SemaphoreSlim _captureGate = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();
    private readonly object _captureSync = new();
    private CancellationTokenSource? _activeCapture;
    private CancellationTokenSource? _channelRead;
    private string? _channelReadRequestId;
    private Task? _pendingPreview;
    private Task? _initialization;
    private bool _allowClose;
    private bool _windowActive;
    private bool _navigationPending;
    private bool _pageReady;
    private bool _checkingChannel;
    private bool _loadTimeoutReported;
    private bool _submittingChat;
    private string? _lastChannelState;
    private string _desiredLogin = string.Empty;
    private static long _requestCounter;
    private long _navigationGeneration;
    private ulong _activeNavigationId;
    private long _channelCheckGeneration;
    private long _channelLoadDeadline;
    private int _showVersion;

    private static readonly HashSet<string> ReservedPaths = new(StringComparer.OrdinalIgnoreCase)
    {
        "login", "signup", "activate", "settings", "directory", "downloads", "search",
        "subscriptions", "inventory", "following", "videos", "clip", "jobs", "p", "turbo"
    };

    public TwitchBrowserWindow(string profilePath, DesktopWindow dashboard, bool background)
    {
        _profilePath = profilePath;
        _dashboard = dashboard;
        _background = background;
        Text = $"Twitch · {NativeTheme.WorkbenchTitle}";
        NativeTheme.StyleWindow(this);
        MinimumSize = new Size(920, 640);
        Size = new Size(1280, 820);
        StartPosition = FormStartPosition.CenterScreen;
        if (_background)
        {
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ClientSize = new Size(1600, 900);
        }

        ConfigureButton(_back, "←", 36, (_, _) => { if (_webView.CoreWebView2?.CanGoBack == true) _webView.CoreWebView2.GoBack(); });
        _back.AccessibleName = "上一页";
        ConfigureButton(_forward, "→", 36, (_, _) => { if (_webView.CoreWebView2?.CanGoForward == true) _webView.CoreWebView2.GoForward(); });
        _forward.AccessibleName = "下一页";
        ConfigureButton(_reload, "刷新", 56, (_, _) => _webView.CoreWebView2?.Reload());
        _address.AccessibleName = "Twitch 网页地址";
        _address.Anchor = AnchorStyles.Left | AnchorStyles.Right;
        _address.Margin = new Padding(4, 0, 10, 0);
        _address.BackColor = NativeTheme.Background;
        _address.ForeColor = NativeTheme.Text;
        _address.BorderStyle = BorderStyle.FixedSingle;
        _address.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { NavigateAddress(); e.SuppressKeyPress = true; } };
        ConfigureButton(_capture, "识别当前画面", 112, async (_, _) => await CapturePreviewAsync(_desiredLogin, NextRequestId()), primary: true);
        _capture.Enabled = false;
        ConfigureButton(_external, "用浏览器打开", 112, (_, _) =>
        {
            if (!DesktopWindow.OpenExternal($"https://www.twitch.tv/{_desiredLogin}")) SetStatus("无法打开默认浏览器。");
        });
        _external.Margin = Padding.Empty;
        _auto.Text = "每 15 秒自动识别";
        _auto.AutoSize = true;
        _auto.Anchor = AnchorStyles.Left;
        _auto.ForeColor = NativeTheme.Text;
        _auto.Margin = new Padding(8, 0, 0, 0);
        _auto.Enabled = false;
        _auto.CheckedChanged += (_, _) => { _autoTimer.Enabled = _auto.Checked && IsCaptureEligible(out _); };
        _autoTimer.Tick += async (_, _) =>
        {
            if (_auto.Checked && Visible && _windowActive && IsCaptureEligible(out var login))
                await CapturePreviewAsync(login, NextRequestId());
        };
        _channelTimer.Tick += async (_, _) => await CheckChannelAsync();
        Activated += (_, _) => { _windowActive = true; UpdateCaptureState(); };
        Deactivate += (_, _) =>
        {
            _windowActive = false;
            CancelChannelRead();
            PauseAutomaticCapture(cancelCapture: true);
            UpdateCaptureState();
        };
        _status.Dock = DockStyle.Fill;
        _status.AutoEllipsis = true;
        _status.TextAlign = ContentAlignment.MiddleLeft;
        _status.ForeColor = NativeTheme.Muted;
        _status.LiveSetting = System.Windows.Forms.Automation.AutomationLiveSetting.Polite;
        _status.Text = CaptureHint;
        _status.Margin = new Padding(14, 0, 0, 0);

        var toolbar = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 94,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = NativeTheme.Border,
            Padding = new Padding(0, 0, 0, 1),
            TabIndex = 0
        };
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        toolbar.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        toolbar.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        toolbar.Controls.Add(CreateToolbarRow(NativeTheme.Surface, 3, _back, _forward, _reload, _address, _external), 0, 0);
        toolbar.Controls.Add(CreateToolbarRow(NativeTheme.Background, 2, _capture, _auto, _status), 0, 1);

        _webView.Dock = DockStyle.Fill;
        _webView.TabIndex = 1;
        Controls.Add(_webView);
        Controls.Add(toolbar);
        if (_background) toolbar.Hide();
    }

    protected override bool ShowWithoutActivation => _background;

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            const int noActivate = 0x08000000;
            const int toolWindow = 0x00000080;
            if (_background) parameters.ExStyle |= noActivate | toolWindow;
            return parameters;
        }
    }

    private static TableLayoutPanel CreateToolbarRow(Color color, int flexibleColumn, params Control[] controls)
    {
        var row = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = controls.Length,
            RowCount = 1,
            BackColor = color,
            Padding = new Padding(14, 0, 14, 0),
            Margin = Padding.Empty
        };
        row.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        for (var index = 0; index < controls.Length; index++)
        {
            row.ColumnStyles.Add(index == flexibleColumn ? new ColumnStyle(SizeType.Percent, 100) : new ColumnStyle(SizeType.AutoSize));
            controls[index].TabIndex = index;
            row.Controls.Add(controls[index], index, 0);
        }
        return row;
    }

    private static void ConfigureButton(Button button, string text, int width, EventHandler handler, bool primary = false)
    {
        button.Text = text;
        button.Width = width;
        button.Height = 32;
        button.Anchor = AnchorStyles.Left;
        button.Margin = new Padding(0, 0, 6, 0);
        button.Click += handler;
        if (SystemInformation.HighContrast) return;

        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.MouseOverBackColor = primary ? NativeTheme.AccentHover : NativeTheme.Hover;
        button.FlatAppearance.MouseDownBackColor = primary ? NativeTheme.Accent : NativeTheme.Border;
        void UpdateColors()
        {
            var highlighted = primary && button.Enabled;
            button.ForeColor = highlighted ? NativeTheme.Background : NativeTheme.Text;
            button.BackColor = highlighted ? NativeTheme.Accent : NativeTheme.Surface;
            button.FlatAppearance.BorderColor = highlighted ? NativeTheme.Accent : NativeTheme.Border;
        }
        if (primary) button.EnabledChanged += (_, _) => UpdateColors();
        UpdateColors();
    }

    public async Task ShowChannelAsync(string login)
    {
        CancelChannelRead();
        var version = ++_showVersion;
        var core = await ShowBrowserAsync(login, version);
        if (core is null) return;
        if (!IsCurrentChannel(core.Source)) core.Navigate($"https://www.twitch.tv/{_desiredLogin}");
        else if (_loadTimeoutReported) core.Reload();
        UpdateCaptureState();
    }

    public async Task ShowChatAsync(string login)
    {
        CancelChannelRead();
        var version = ++_showVersion;
        var core = await ShowBrowserAsync(login, version);
        if (core is null) return;
        if (!TwitchChatPage.IsChannel(core.Source, login)) core.Navigate(TwitchChatPage.ChannelUrl(login));
        SetStatus("请在 Twitch 网页中手动登录，使用工作台发送申请指令。");
    }

    private async Task<CoreWebView2?> ShowBrowserAsync(string login, int version, CancellationToken cancellationToken = default)
    {
        if (!DesktopWindow.TryNormalizeTwitchLogin(login, out var normalized)) throw new ArgumentException("Invalid Twitch channel login.", nameof(login));
        _desiredLogin = normalized;
        await EnsureInitializedAsync().WaitAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (_allowClose || version != _showVersion) return null;
        if (_background)
        {
            // WebView2 needs a visible controller to capture video. Keep its host outside the monitor area.
            var desktop = SystemInformation.VirtualScreen;
            Location = new Point(desktop.Left, desktop.Bottom + 32);
            if (!Visible) Show();
        }
        else
        {
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }
        return _webView.CoreWebView2;
    }

    internal async Task<(bool Submitted, string Message)> SubmitChatAsync(string login, string command)
    {
        if (_submittingChat) return (false, "已有一条申请指令正在提交，请稍候。");
        CancelChannelRead();
        _submittingChat = true;
        var version = ++_showVersion;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        timeout.CancelAfter(ChatLoadTimeoutMilliseconds);
        var deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + ChatLoadTimeoutMilliseconds;
        var stageDeadline = deadline;
        var phase = TwitchChatPage.Phase.Prepare;
        var inputStarted = false;
        var sendStarted = false;
        const string unknown = "无法确认网页是否提交，请先检查 Twitch 聊天记录，避免重复发送。";
        try
        {
            var core = await ShowBrowserAsync(login, version, timeout.Token);
            if (core is null) return (false, "聊天已关闭或切换，请回到工作台重新点击发送。");
            var leftTarget = false;
            var targetReady = !_navigationPending && TwitchChatPage.IsChannel(core.Source, login);
            bool IsChatCurrent() => Visible && _windowActive && version == _showVersion && !leftTarget &&
                TwitchChatPage.IsChannel(core.Source, login) && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < stageDeadline;

            void CheckNavigation(object? sender, CoreWebView2NavigationStartingEventArgs e)
            {
                targetReady = false;
                if (inputStarted || !TwitchChatPage.IsChannel(e.Uri, login)) leftTarget = true;
            }
            void CheckDocument(object? sender, CoreWebView2DOMContentLoadedEventArgs e)
            {
                if (e.NavigationId == _activeNavigationId && TwitchChatPage.IsChannel(core.Source, login)) targetReady = true;
            }
            void CheckSource(object? sender, CoreWebView2SourceChangedEventArgs e)
            {
                if (inputStarted && !TwitchChatPage.IsChannel(core.Source, login)) leftTarget = true;
            }

            core.NavigationStarting += CheckNavigation;
            core.DOMContentLoaded += CheckDocument;
            core.SourceChanged += CheckSource;
            try
            {
                if (!TwitchChatPage.IsChannel(core.Source, login)) core.Navigate(TwitchChatPage.ChannelUrl(login));
                if (!_windowActive) await Task.Delay(100, timeout.Token);
                _webView.Focus();
                while (Visible && _windowActive && version == _showVersion && !leftTarget && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < stageDeadline)
                {
                    if (TwitchChatPage.IsChannel(core.Source, login) && (targetReady || !_navigationPending))
                    {
                        var script = TwitchChatPage.ProbeScript(login, command, stageDeadline, phase);
                        var result = await core.ExecuteScriptAsync(script).WaitAsync(timeout.Token);
                        if (!IsChatCurrent()) break;
                        switch (JsonSerializer.Deserialize<string>(result))
                        {
                            case "editor-focused":
                                inputStarted = true;
                                stageDeadline = Math.Min(deadline, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 2500);
                                await TwitchChatPage.InsertTextAsync(core, command, timeout.Token);
                                phase = TwitchChatPage.Phase.Ready;
                                break;
                            case "send-focused":
                                sendStarted = true;
                                await TwitchChatPage.DispatchEnterAsync(core, down: true, timeout.Token);
                                if (!IsChatCurrent()) return (false, unknown);
                                await TwitchChatPage.DispatchEnterAsync(core, down: false, timeout.Token);
                                phase = TwitchChatPage.Phase.Confirm;
                                stageDeadline = Math.Min(deadline, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 3000);
                                break;
                            case "cleared":
                                return (true, "已在 Twitch 聊天页提交。请查看聊天和机器人回复确认是否入队。");
                            case "waiting":
                                break;
                            case "draft":
                                return (false, "聊天输入框有未发送的草稿，已保留。请先处理草稿，再重新点击发送。");
                            case "draft-changed":
                                return (false, "聊天输入框内容已变化，请检查草稿后再试。");
                            case "blocked":
                                return (false, sendStarted ? unknown : "请在 Twitch 聊天窗口手动完成登录、验证或页面提示，再回工作台重新点击发送。");
                            case "left":
                                return (false, sendStarted ? unknown : "Twitch 页面已离开目标聊天室，请检查页面后重新点击发送。");
                            default:
                                return (false, sendStarted ? unknown : "当前聊天输入框不可用，请检查频道聊天设置和输入框后重试。");
                        }
                    }
                    await Task.Delay(125, timeout.Token);
                }
                if (sendStarted) return (false, unknown);
                if (inputStarted) return (false, "未提交申请。请检查 Twitch 页面中的草稿，手动处理后再试。");
                if (leftTarget || !Visible || version != _showVersion)
                    return (false, "Twitch 页面已变化。请手动完成登录或验证，再回工作台重新点击发送。");
                return (false, "Twitch 聊天室加载超时，未提交指令。请检查聊天窗口后重试。");
            }
            finally
            {
                core.SourceChanged -= CheckSource;
                core.DOMContentLoaded -= CheckDocument;
                core.NavigationStarting -= CheckNavigation;
            }
        }
        catch (OperationCanceledException)
        {
            if (sendStarted) return (false, unknown);
            if (inputStarted) return (false, "未提交申请。请检查 Twitch 页面中的草稿，手动处理后再试。");
            return (false, "Twitch 聊天室加载超时，未提交指令。请检查聊天窗口后重试。");
        }
        catch
        {
            if (sendStarted) return (false, unknown);
            if (inputStarted) return (false, "未提交申请。请检查 Twitch 页面中的草稿，手动处理后再试。");
            return (false, "无法操作 Twitch 聊天窗口，请检查页面后重试。");
        }
        finally { _submittingChat = false; }
    }

    internal void CancelChannelRead(string? requestId = null)
    {
        if (requestId is null || requestId == _channelReadRequestId) _channelRead?.Cancel();
    }

    internal async Task<TwitchPreviewCapture.Result> ReadChannelAsync(string login, string requestId)
    {
        if (_submittingChat) return new([], "Twitch 聊天正在提交指令，已跳过此频道。");
        if (!DesktopWindow.TryNormalizeTwitchLogin(login, out var normalized) || ReservedPaths.Contains(normalized))
            return new([], "Twitch 频道名称无效。");
        if (!await _captureGate.WaitAsync(0)) return new([], "另一个频道正在采集，已跳过此频道。");

        using var stopped = new CancellationTokenSource();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stopped.Token, _lifetime.Token);
        timeout.CancelAfter(ReadChannelTimeoutMilliseconds);
        var deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + ReadChannelTimeoutMilliseconds;
        _channelRead = stopped;
        _channelReadRequestId = requestId;
        PauseAutomaticCapture(cancelCapture: false);
        UpdateCaptureState();
        var version = ++_showVersion;
        var frames = new List<(string Image, TwitchPreviewCapture.FrameInfo Info)>(2);
        TwitchPreviewCapture.Result Captured(string message) => new(frames.Select(frame => frame.Image).ToArray(), message,
            FrameInfo: frames.Select(frame => frame.Info).ToArray());
        bool IsReadWindowCurrent() => Visible && (_background || _windowActive) && version == _showVersion;
        try
        {
            var core = await ShowBrowserAsync(normalized, version, timeout.Token);
            if (core is null) return new([], "采集窗口已关闭或切换。", true);
            var needsNavigation = !TwitchPreviewCapture.IsChannel(core.Source, normalized);
            var leftTarget = false;
            var seenTarget = !needsNavigation;
            ulong? expectedNavigation = null;
            void CheckNavigation(object? sender, CoreWebView2NavigationStartingEventArgs e)
            {
                if (needsNavigation && TwitchPreviewCapture.IsChannel(e.Uri, normalized) &&
                    (expectedNavigation is null || expectedNavigation == e.NavigationId))
                {
                    expectedNavigation = e.NavigationId;
                    return;
                }
                leftTarget = true;
                if (e.IsUserInitiated) stopped.Cancel();
            }
            void CheckSource(object? sender, CoreWebView2SourceChangedEventArgs e)
            {
                if (TwitchPreviewCapture.IsChannel(core.Source, normalized)) seenTarget = true;
                else if (seenTarget) leftTarget = true;
            }

            var muted = core.IsMuted;
            core.IsMuted = true;
            core.NavigationStarting += CheckNavigation;
            core.SourceChanged += CheckSource;
            string? lastState = null;
            double? previousPlaybackTime = null;
            long? firstVideoAt = null;
            long sameSourceSince = 0;
            TwitchPreviewCapture.VideoSource? previousSource = null;
            try
            {
                if (needsNavigation) core.Navigate($"https://www.twitch.tv/{normalized}");
                SetStatus($"正在读取 {normalized} 的实时直播画面…");
                var script = TwitchPreviewCapture.InspectPlayer(normalized, requestId, deadline, background: _background);
                var sourceScript = TwitchPreviewCapture.InspectPlayer(normalized, requestId, deadline, captureSource: true, background: _background);
                if (!_background && !_windowActive) await Task.Delay(250, timeout.Token);
                while (IsReadWindowCurrent() && !leftTarget && frames.Count < 2)
                {
                    timeout.Token.ThrowIfCancellationRequested();
                    if (TwitchPreviewCapture.IsChannel(core.Source, normalized))
                    {
                        var probe = TwitchPreviewCapture.ReadProbe(await core.ExecuteScriptAsync(script).WaitAsync(timeout.Token));
                        lastState = probe?.State;
                        if (lastState is "blocked" or "offline" or "left") break;
                        var advances = probe?.PlaybackTime is { } current && previousPlaybackTime is { } previous && current > previous;
                        previousPlaybackTime = probe?.PlaybackTime;
                        var now = Environment.TickCount64;
                        var source = probe?.Source;
                        if (source is not null)
                        {
                            firstVideoAt ??= now;
                            if (!source.Matches(previousSource)) sameSourceSince = now;
                        }
                        previousSource = source;
                        var fallbackWindow = deadline - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() <= 3500;
                        var canUseLowerQuality = fallbackWindow || now - firstVideoAt >= PreferredVideoWaitMilliseconds;
                        var stable = now - sameSourceSince >= (fallbackWindow ? 350 : 800);
                        if (!leftTarget && advances && stable && source is { Width: > 0, Height: > 0 } &&
                            (source.HasPreferredQuality || canUseLowerQuality) && probe?.Region is { } before &&
                            !frames.Any(frame => (long)frame.Info.SourceWidth * frame.Info.SourceHeight > (long)source.Width * source.Height))
                        {
                            var sample = TwitchPreviewCapture.ReadProbe(await core.ExecuteScriptAsync(sourceScript).WaitAsync(timeout.Token));
                            lastState = sample?.State;
                            if (lastState is "blocked" or "offline" or "left") break;
                            if (leftTarget || sample?.Region is not { } initial || !before.Matches(initial) || !source.Matches(sample.Source) ||
                                sample.PlaybackTime < probe.PlaybackTime || !TwitchPreviewCapture.IsChannel(core.Source, normalized))
                            {
                                await Task.Delay(350, timeout.Token);
                                continue;
                            }

                            var frame = sample.SourceImage;
                            var method = "video-source";
                            if (string.IsNullOrEmpty(frame) || frame.Length > (MaxCaptureBytes + 2) / 3 * 4)
                            {
                                try
                                {
                                    method = "composited-player";
                                    frame = await TwitchPreviewCapture.CaptureVideoAsync(core, before, MaxCaptureBytes, timeout.Token);
                                }
                                catch (Exception error) when (error is not OperationCanceledException && !timeout.IsCancellationRequested)
                                {
                                    if (!TwitchPreviewCapture.IsChannel(core.Source, normalized) || leftTarget) break;
                                    method = "webview-preview";
                                    using var screenshot = await CaptureRawPreviewAsync(core, timeout.Token);
                                    frame = Convert.ToBase64String(TwitchPreviewCapture.Crop(screenshot, before, MaxCaptureBytes));
                                }
                            }
                            var after = TwitchPreviewCapture.ReadProbe(await core.ExecuteScriptAsync(script).WaitAsync(timeout.Token));
                            lastState = after?.State;
                            if (lastState is "blocked" or "offline" or "left") break;
                            if (!leftTarget && after?.Region is { } verified && before.Matches(verified) &&
                                source.Matches(after.Source) && after.PlaybackTime >= sample.PlaybackTime &&
                                TwitchPreviewCapture.IsChannel(core.Source, normalized))
                            {
                                timeout.Token.ThrowIfCancellationRequested();
                                if (!frames.Any(item => item.Image == frame)) frames.Add((frame, new(source.Width, source.Height, method)));
                                if (frames.Count < 2) await Task.Delay(1200, timeout.Token);
                                continue;
                            }
                        }
                    }
                    await Task.Delay(350, timeout.Token);
                }
            }
            catch (OperationCanceledException) when (!stopped.IsCancellationRequested && !_lifetime.IsCancellationRequested) { }
            finally
            {
                core.SourceChanged -= CheckSource;
                core.NavigationStarting -= CheckNavigation;
                if (TwitchPreviewCapture.IsChannel(core.Source, normalized))
                {
                    try
                    {
                        await core.ExecuteScriptAsync(TwitchPreviewCapture.RestorePlayback(normalized, requestId, _background || (needsNavigation && version == _showVersion)))
                            .WaitAsync(TimeSpan.FromMilliseconds(600));
                    }
                    catch { }
                }
                core.IsMuted = muted;
            }

            if (stopped.IsCancellationRequested || !IsReadWindowCurrent())
                return new([], "采集已取消或 Twitch 窗口已切换。", true);
            if (frames.Count > 0)
                return Captured(frames.Count == 2 ? "已取得两张实时直播画面。" : "本次只取得一张不同的实时画面。");
            return new([], lastState switch
            {
                "blocked" => "直播页面需要登录、验证或关闭弹窗，本频道已跳过。",
                "offline" => "该频道当前未直播。",
                "interstitial" => "播放器正在显示广告或转播提示，本频道已跳过。",
                "outside" => "直播画面不完整，请调整窗口后重试。",
                _ => "未读到可识别的实时直播画面，本频道已跳过。"
            });
        }
        catch (OperationCanceledException)
        {
            return stopped.IsCancellationRequested || _lifetime.IsCancellationRequested
                ? new([], "采集已取消或 Twitch 窗口已关闭。", true)
                : Captured(frames.Count > 0 ? "本次只取得一张不同的实时画面。" : "直播页面读取超时，本频道已跳过。");
        }
        catch (Exception)
        {
            if (stopped.IsCancellationRequested || _lifetime.IsCancellationRequested || version != _showVersion)
                return new([], "采集已取消或 Twitch 窗口已切换。", true);
            return Captured(frames.Count > 0 ? "本次只取得一张不同的实时画面。" : "无法获取实时直播画面，本频道已跳过。");
        }
        finally
        {
            _channelReadRequestId = null;
            _channelRead = null;
            if (_background && !IsDisposed)
            {
                Hide();
                if (_webView.CoreWebView2 is { } core)
                {
                    try { await core.TrySuspendAsync().WaitAsync(TimeSpan.FromMilliseconds(500)); }
                    catch (Exception) { }
                }
            }
            _captureGate.Release();
            if (!IsDisposed) UpdateCaptureState();
        }
    }

    private Task EnsureInitializedAsync()
    {
        return _initialization ??= InitializeCoreAsync();
    }

    private async Task InitializeCoreAsync()
    {
        Directory.CreateDirectory(_profilePath);
        var environment = await CoreWebView2Environment.CreateAsync(browserExecutableFolder: null, userDataFolder: _profilePath);
        await _webView.EnsureCoreWebView2Async(environment);
        var core = _webView.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultScriptDialogsEnabled = !_background;
        if (_background)
        {
            core.IsMuted = true;
            core.Settings.IsWebMessageEnabled = false;
            core.PermissionRequested += (_, e) =>
            {
                e.State = CoreWebView2PermissionState.Deny;
                e.SavesInProfile = false;
            };
            core.DownloadStarting += (_, e) => e.Cancel = true;
            core.LaunchingExternalUriScheme += (_, e) => e.Cancel = true;
        }
        core.NavigationStarting += (_, e) =>
        {
            if (!IsAllowedTwitchUri(e.Uri))
            {
                e.Cancel = true;
                SetStatus("仅允许在此窗口浏览 Twitch 官方 HTTPS 页面。");
                return;
            }
            _activeNavigationId = e.NavigationId;
            _navigationPending = true;
            PauseAutomaticCapture(cancelCapture: true);
            _address.Text = e.Uri;
            ResetChannelCheck(IsCurrentChannel(e.Uri));
        };
        core.NavigationCompleted += (_, e) =>
        {
            if (e.NavigationId != _activeNavigationId) return;
            _navigationPending = false;
            if (!e.IsSuccess)
            {
                ResetChannelCheck(false);
                ReportChannelLoadError("Twitch 页面加载失败，请刷新重试，或用浏览器打开。");
            }
            UpdateCaptureState();
        };
        core.SourceChanged += (_, e) =>
        {
            PauseAutomaticCapture(cancelCapture: true);
            if (IsAllowedTwitchUri(core.Source)) _address.Text = core.Source;
            if (!e.IsNewDocument && !_navigationPending) ResetChannelCheck(IsCurrentChannel(core.Source));
        };
        core.HistoryChanged += (_, _) => UpdateHistoryButtons();
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (_background) return;
            if (IsAllowedTwitchUri(e.Uri))
            {
                PauseAutomaticCapture(cancelCapture: true);
                core.Navigate(e.Uri);
            }
            else SetStatus("已阻止非 Twitch 官方弹窗。");
        };
        UpdateHistoryButtons();
    }

    private void UpdateHistoryButtons()
    {
        _back.Enabled = _webView.CoreWebView2?.CanGoBack == true;
        _forward.Enabled = _webView.CoreWebView2?.CanGoForward == true;
    }

    private bool IsCurrentChannel(string? source) =>
        TryGetCaptureLogin(source, out var login) && string.Equals(login, _desiredLogin, StringComparison.OrdinalIgnoreCase);

    private void ResetChannelCheck(bool isChannel)
    {
        _channelCheckGeneration++;
        _pageReady = false;
        _loadTimeoutReported = false;
        _lastChannelState = null;
        _channelLoadDeadline = Environment.TickCount64 + ChannelLoadTimeoutMilliseconds;
        _channelTimer.Enabled = !_background && isChannel;
        SetStatus(isChannel ? "正在加载 Twitch 频道…" : CaptureHint);
        UpdateCaptureState();
    }

    private void ReportChannelLoadError(string message)
    {
        _loadTimeoutReported = true;
        SetStatus(message);
        if (!_background) _dashboard.PostTwitchWindowError(message);
    }

    private async Task CheckChannelAsync()
    {
        if (_allowClose || _channelRead is not null || _webView.CoreWebView2 is not { } core) return;
        if (_lastChannelState is null && !_loadTimeoutReported && Environment.TickCount64 >= _channelLoadDeadline)
            ReportChannelLoadError("Twitch 频道加载超时，请检查网络，或刷新、用浏览器打开。");
        if (_checkingChannel || !IsCurrentChannel(core.Source)) return;

        var generation = _channelCheckGeneration;
        _checkingChannel = true;
        try
        {
            var result = await core.ExecuteScriptAsync(TwitchPreviewCapture.InspectPlayer(_desiredLogin));
            if (generation != _channelCheckGeneration || _allowClose || _channelRead is not null || !IsCurrentChannel(core.Source)) return;
            var state = TwitchPreviewCapture.ReadProbe(result)?.State switch { "video" => "video", "page" => "page", _ => null };
            if (_lastChannelState == state) return;
            _lastChannelState = state;
            _pageReady = state == "video";
            if (state is not null)
            {
                _loadTimeoutReported = false;
                SetStatus(_pageReady ? CaptureHint : "频道已加载。请播放直播，画面可见后即可识别。");
            }
            else
            {
                _channelLoadDeadline = Environment.TickCount64 + ChannelLoadTimeoutMilliseconds;
                SetStatus("等待 Twitch 频道画面…");
            }
            UpdateCaptureState();
        }
        catch (Exception) { /* The next probe can run after the WebView finishes navigating. */ }
        finally { _checkingChannel = false; }
    }

    private void NavigateAddress()
    {
        var text = _address.Text.Trim();
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || !IsAllowedTwitchUri(uri.AbsoluteUri))
        {
            SetStatus("地址必须是 Twitch 官方 HTTPS 页面。登录流程会在 Twitch 子域内继续。");
            return;
        }
        _webView.CoreWebView2?.Navigate(uri.AbsoluteUri);
    }

    private bool IsCaptureEligible(out string login)
    {
        login = string.Empty;
        var source = _webView.CoreWebView2?.Source;
        if (_navigationPending || !_pageReady || !TryGetCaptureLogin(source, out login)) return false;
        return string.Equals(login, _desiredLogin, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsAllowedTwitchUri(string? text)
    {
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || uri.UserInfo.Length != 0) return false;
        var host = uri.Host.TrimEnd('.').ToLowerInvariant();
        return host == "twitch.tv" || host.EndsWith(".twitch.tv", StringComparison.Ordinal);
    }

    private static bool TryGetCaptureLogin(string? text, out string login)
    {
        login = string.Empty;
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(uri.Host.TrimEnd('.'), "www.twitch.tv", StringComparison.OrdinalIgnoreCase)) return false;
        var segments = uri.AbsolutePath.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length != 1 || ReservedPaths.Contains(segments[0]) || !DesktopWindow.TryNormalizeTwitchLogin(segments[0], out login)) return false;
        return true;
    }

    private static string NextSafeRequestId(long n) => n.ToString(System.Globalization.CultureInfo.InvariantCulture);
    private string NextRequestId() => NextSafeRequestId(Interlocked.Increment(ref _requestCounter));

    private void CancelActiveCapture()
    {
        lock (_captureSync)
        {
            try { _activeCapture?.Cancel(); } catch (ObjectDisposedException) { }
            _activeCapture = null;
            Interlocked.Increment(ref _navigationGeneration);
        }
    }

    private CancellationTokenSource SetActiveCapture(CancellationTokenSource timeout)
    {
        lock (_captureSync)
        {
            _activeCapture = timeout;
            return timeout;
        }
    }

    private void ClearActiveCapture(CancellationTokenSource timeout)
    {
        lock (_captureSync)
        {
            if (ReferenceEquals(_activeCapture, timeout)) _activeCapture = null;
        }
    }

    private async Task<BoundedMemoryStream> CaptureRawPreviewAsync(CoreWebView2 core, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (_pendingPreview is { IsCompleted: false }) throw new InvalidOperationException("The previous capture is still running.");
        var image = new BoundedMemoryStream(MaxCaptureBytes);
        Task? capture = null;
        try
        {
            capture = core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Jpeg, image);
            _pendingPreview = capture;
            await capture.WaitAsync(cancellationToken);
            return image;
        }
        catch
        {
            if (capture is { IsCompleted: false })
                _ = capture.ContinueWith(completed =>
                {
                    _ = completed.Exception;
                    image.Dispose();
                }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            else image.Dispose();
            throw;
        }
    }

    public async Task CapturePreviewAsync(string login, string requestId)
    {
        if (!DesktopWindow.TryNormalizeTwitchLogin(login, out var normalized) || string.IsNullOrWhiteSpace(requestId)) return;
        if (!await _captureGate.WaitAsync(0)) { SetStatus("已有识别进行中，请稍候。"); return; }
        try
        {
            if (!IsCaptureEligible(out var current) || !string.Equals(current, normalized, StringComparison.OrdinalIgnoreCase))
            {
                SetStatus("当前不是可识别的单频道直播页面；请不要在登录、验证或密码页面捕获。");
                return;
            }
            var generation = Interlocked.Read(ref _navigationGeneration);
            using var timeout = SetActiveCapture(CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token));
            timeout.CancelAfter(TimeSpan.FromSeconds(20));
            SetStatus("正在捕获当前可见画面…");
            using var image = await CaptureRawPreviewAsync(_webView.CoreWebView2!, timeout.Token);
            if (generation != Interlocked.Read(ref _navigationGeneration) || !IsCaptureEligible(out var stillCurrent) || !string.Equals(stillCurrent, normalized, StringComparison.OrdinalIgnoreCase))
            {
                SetStatus("页面已变化，已丢弃这次画面。");
                return;
            }
            if (image.Length <= 0 || image.Length > MaxCaptureBytes)
            {
                SetStatus("画面过大，未发送识别请求；请缩小窗口或降低系统显示缩放后重试。");
                return;
            }
            var base64 = Convert.ToBase64String(image.ToArray());
            SetStatus(_dashboard.PostScreenCapture(normalized, requestId, base64)
                ? "画面已交给本机识别。"
                : "无法将画面交给工作台，请重新打开程序后重试。");
        }
        catch (OperationCanceledException)
        {
            if (!_lifetime.IsCancellationRequested) SetStatus("捕获超时，未发送识别请求。");
        }
        catch (Exception)
        {
            SetStatus("无法捕获当前画面，请重试。");
        }
        finally
        {
            lock (_captureSync) _activeCapture = null;
            _captureGate.Release();
        }
    }

    private void PauseAutomaticCapture(bool cancelCapture)
    {
        _autoTimer.Stop();
        if (_auto.Checked) _auto.Checked = false;
        if (cancelCapture) CancelActiveCapture();
    }

    private void UpdateCaptureState()
    {
        var eligible = _channelRead is null && IsCaptureEligible(out _);
        _capture.Enabled = eligible && Visible && _windowActive;
        _auto.Enabled = eligible && Visible && _windowActive;
        if (!eligible || !Visible || !_windowActive)
        {
            _auto.Checked = false;
            _autoTimer.Stop();
        }
    }

    private void SetStatus(string text)
    {
        if (IsDisposed) return;
        if (InvokeRequired) { try { BeginInvoke(new Action(() => SetStatus(text))); } catch { } return; }
        _status.Text = text;
    }

    protected override void OnVisibleChanged(EventArgs e)
    {
        base.OnVisibleChanged(e);
        if (!Visible)
        {
            CancelChannelRead();
            PauseAutomaticCapture(cancelCapture: true);
        }
        UpdateCaptureState();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_allowClose && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            PauseAutomaticCapture(cancelCapture: true);
            Hide();
            return;
        }
        PauseAutomaticCapture(cancelCapture: true);
        _autoTimer.Stop();
        _channelTimer.Stop();
        _lifetime.Cancel();
        base.OnFormClosing(e);
    }

    public void AllowCloseAndDispose()
    {
        _allowClose = true;
        PauseAutomaticCapture(cancelCapture: true);
        _lifetime.Cancel();
        try { Close(); } catch { }
        try { _autoTimer.Dispose(); } catch { }
        _channelTimer.Dispose();
        Dispose();
    }
}

internal sealed class BoundedMemoryStream : MemoryStream
{
    private readonly int _limit;
    public BoundedMemoryStream(int limit) => _limit = limit;
    public override void Write(byte[] buffer, int offset, int count)
    {
        if (count < 0 || Length > _limit - count) throw new InvalidOperationException("Capture exceeds the local size limit.");
        base.Write(buffer, offset, count);
    }
    public override void Write(ReadOnlySpan<byte> buffer)
    {
        if (Length > _limit - buffer.Length) throw new InvalidOperationException("Capture exceeds the local size limit.");
        base.Write(buffer);
    }
    public override void WriteByte(byte value)
    {
        if (Length >= _limit) throw new InvalidOperationException("Capture exceeds the local size limit.");
        base.WriteByte(value);
    }
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
    {
        if (count < 0 || Length > _limit - count) throw new InvalidOperationException("Capture exceeds the local size limit.");
        return base.WriteAsync(buffer, offset, count, cancellationToken);
    }
    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (Length > _limit - buffer.Length) throw new InvalidOperationException("Capture exceeds the local size limit.");
        return base.WriteAsync(buffer, cancellationToken);
    }
}

internal sealed class BrowserFallback : IDisposable
{
    private readonly string _browserExe;
    private readonly string _profilePath;
    private readonly object _processLock = new();
    private readonly HashSet<Process> _processes = new();
    private bool _disposed;

    private BrowserFallback(string browserExe, string profilePath)
    {
        _browserExe = browserExe;
        _profilePath = profilePath;
        Directory.CreateDirectory(_profilePath);
    }

    public static BrowserFallback? Find()
    {
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var candidates = new[]
        {
            Path.Combine(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(local, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(pf, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(pf86, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(local, "Google", "Chrome", "Application", "chrome.exe")
        };
        var exe = candidates.FirstOrDefault(File.Exists);
        if (exe is null) return null;
        var profile = Path.Combine(local, "D2Checkpoint", "BrowserProfile");
        return new BrowserFallback(exe, profile);
    }

    public void Open(Uri uri)
    {
        var info = new ProcessStartInfo
        {
            FileName = _browserExe,
            UseShellExecute = false,
            WindowStyle = ProcessWindowStyle.Hidden,
            CreateNoWindow = true
        };
        info.ArgumentList.Add($"--app={uri.AbsoluteUri}");
        info.ArgumentList.Add($"--user-data-dir={_profilePath}");
        info.ArgumentList.Add("--no-first-run");
        info.ArgumentList.Add("--no-default-browser-check");
        var process = Process.Start(info) ?? throw new InvalidOperationException("无法启动系统浏览器。");
        lock (_processLock)
        {
            if (_disposed)
            {
                try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
                process.Dispose();
                throw new ObjectDisposedException(nameof(BrowserFallback));
            }
            _processes.Add(process);
        }
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) =>
        {
            lock (_processLock)
            {
                _processes.Remove(process);
                process.Dispose();
            }
        };
    }

    public void Dispose()
    {
        Process[] processes;
        lock (_processLock)
        {
            if (_disposed) return;
            _disposed = true;
            processes = _processes.ToArray();
            _processes.Clear();
        }
        foreach (var process in processes)
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
            process.Dispose();
        }
    }
}

internal sealed class BrowserBootstrap : IAsyncDisposable
{
    private readonly Uri _serviceUri;
    private string _launchKey;
    private TcpListener? _listener;
    private readonly HttpClient _client = new(new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false });
    private Task<bool>? _worker;
    private int _port;
    private string _bootstrapPath = string.Empty;

    public Uri BootstrapUri => new($"http://127.0.0.1:{_port}/{_bootstrapPath}");
    public Task<bool> Completion => _worker ?? Task.FromResult(false);

    public BrowserBootstrap(Uri serviceUri, string launchKey)
    {
        _serviceUri = serviceUri;
        _launchKey = launchKey;
    }

    public Task StartAsync()
    {
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start(1);
        _port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _bootstrapPath = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        _worker = CompleteBrowserBootstrapAsync();
        return Task.CompletedTask;
    }

    private async Task<bool> CompleteBrowserBootstrapAsync()
    {
        try
        {
            var listener = _listener ?? throw new InvalidOperationException("Bootstrap listener was not started.");
            using var client = await listener.AcceptTcpClientAsync().WaitAsync(TimeSpan.FromSeconds(45));
            var peer = (IPEndPoint?)client.Client.RemoteEndPoint;
            if (peer?.Address is not { } remote || !IPAddress.IsLoopback(remote)) return false;
            using var stream = client.GetStream();
            using var reader = new StreamReader(stream, Encoding.ASCII, detectEncodingFromByteOrderMarks: false, bufferSize: 4096, leaveOpen: true);
            var requestLine = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
            if (!string.Equals(requestLine, $"GET /{_bootstrapPath} HTTP/1.1", StringComparison.Ordinal))
            {
                await SendFailureAsync(stream, 400, "Bad Request", "请求无效，请从系统托盘重新打开控制台。");
                return false;
            }
            var headerCount = 0;
            var validHost = false;
            while (true)
            {
                var header = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                if (header is null) return false;
                if (header.Length == 0) break;
                if (++headerCount > 64 || header.Length > 4096) return false;
                if (header.StartsWith("Host:", StringComparison.OrdinalIgnoreCase))
                    validHost = string.Equals(header.AsSpan(5).Trim().ToString(), $"127.0.0.1:{_port}", StringComparison.OrdinalIgnoreCase);
            }
            if (!validHost) return false;
            using var request = new HttpRequestMessage(HttpMethod.Get, _serviceUri);
            request.Headers.TryAddWithoutValidation("X-D2-Launch-Key", _launchKey);
            using var response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead).WaitAsync(TimeSpan.FromSeconds(20));
            if ((int)response.StatusCode is < 200 or >= 300 || !response.Headers.TryGetValues("Set-Cookie", out var setCookies))
            {
                await SendFailureAsync(stream, 502, "Bad Gateway", "本地会话验证失败，请从系统托盘重新打开控制台。");
                return false;
            }
            var cookies = setCookies.ToArray();
            if (cookies.Length != 1 || !cookies[0].Contains("HttpOnly", StringComparison.OrdinalIgnoreCase) ||
                !cookies[0].Contains("SameSite=Strict", StringComparison.OrdinalIgnoreCase) ||
                !cookies[0].Contains("Path=/", StringComparison.OrdinalIgnoreCase))
            {
                await SendFailureAsync(stream, 502, "Bad Gateway", "本地服务未提供安全会话，请从系统托盘重新打开控制台。");
                return false;
            }
            var cookieValue = cookies[0].Split(';', 2)[0];
            await SendRedirectAsync(stream, _serviceUri.AbsoluteUri, cookieValue);
            _launchKey = string.Empty;
            return true;
        }
        catch (TimeoutException)
        {
            // A user may leave the app idle before opening the window; tray retry creates a fresh endpoint.
        }
        catch (Exception)
        {
            // Never put the key, cookie, response body, or raw service error into a log or UI.
        }
        finally
        {
            _launchKey = string.Empty;
            _bootstrapPath = string.Empty;
            try { _listener?.Stop(); } catch { }
        }
        return false;
    }

    private static async Task SendFailureAsync(NetworkStream stream, int status, string reason, string message)
    {
        try
        {
            var body = Encoding.UTF8.GetBytes($"<!doctype html><meta charset=\"utf-8\"><title>控制台无法打开</title><p>{WebUtility.HtmlEncode(message)}</p>");
            var headers = Encoding.ASCII.GetBytes($"HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
            await stream.WriteAsync(headers);
            await stream.WriteAsync(body);
            await stream.FlushAsync();
        }
        catch { }
    }

    private static async Task SendRedirectAsync(NetworkStream stream, string target, string cookieValue)
    {
        var location = Encoding.ASCII.GetBytes($"HTTP/1.1 302 Found\r\nLocation: {target}\r\nSet-Cookie: {cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(location);
        await stream.FlushAsync();
    }

    public async ValueTask DisposeAsync()
    {
        try { _listener?.Stop(); } catch { }
        if (_worker is not null)
        {
            try { await _worker.WaitAsync(TimeSpan.FromSeconds(1)); } catch { }
        }
        _client.Dispose();
    }
}
