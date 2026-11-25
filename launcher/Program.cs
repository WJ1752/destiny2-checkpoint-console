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
                MessageBox.Show("控制台已在系统托盘中运行。", "命运 2 检查点控制台", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            StartupDiagnostics.Write("application-loop-entered");
            Application.Run(new D2AppContext());
            StartupDiagnostics.Write("application-loop-exited");
        }
        catch (Exception error)
        {
            StartupDiagnostics.Write("launcher-main-failed", error);
            try { MessageBox.Show("程序启动失败。请查看 %LOCALAPPDATA%\\D2Checkpoint\\startup.log。", "命运 2 检查点控制台", MessageBoxButtons.OK, MessageBoxIcon.Error); } catch { }
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
    private BrowserFallback? _browser;
    private bool _browserBootstrapped;
    private bool _bootstrapPending;
    private bool _stopping;
    private DateTime _lastShowUtc = DateTime.MinValue;

    public D2AppContext()
    {
        _showItem = new ToolStripMenuItem("显示控制台", null, (_, _) => ShowConsole());
        var menu = new ContextMenuStrip();
        menu.Items.Add(_showItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("退出", null, (_, _) => ExitThread()));
        _tray = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "命运 2 检查点控制台",
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
                MessageBox.Show(ex.Message, "命运 2 检查点控制台", MessageBoxButtons.OK, MessageBoxIcon.Error);
                ExitThread();
            }
        }
    }

    private async Task OpenTwitchWindowAsync(string login)
    {
        if (!DesktopWindow.TryNormalizeTwitchLogin(login, out var validLogin) || _stopping || _desktopWindow is null) return;
        try
        {
            if (_twitchWindow is null || _twitchWindow.IsDisposed)
            {
                var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "D2Checkpoint", "TwitchProfile");
                var window = new TwitchBrowserWindow(profile, _desktopWindow);
                window.FormClosed += (_, _) => { if (ReferenceEquals(_twitchWindow, window)) _twitchWindow = null; };
                _twitchWindow = window;
            }
            var active = _twitchWindow;
            var dashboard = _desktopWindow;
            await active.ShowChannelAsync(validLogin);
            if (!_stopping && ReferenceEquals(_desktopWindow, dashboard))
                dashboard?.PostTwitchWindowOpened(validLogin);
        }
        catch (Exception)
        {
            _desktopWindow?.PostTwitchWindowError("无法打开 Twitch 频道窗口，请重试。");
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
                MessageBox.Show("无法打开控制台窗口。服务仍在系统托盘中运行；请再次选择“显示控制台”重试。", "命运 2 检查点控制台", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
                        MessageBox.Show("本地服务已停止。为确保控制台状态一致，软件即将退出。", "命运 2 检查点控制台", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
    private bool _allowClose;

    public event Action<string>? OpenTwitchRequested;

    public DesktopWindow(Uri serviceUri, string profilePath)
    {
        _serviceUri = serviceUri;
        _profilePath = profilePath;
        Text = "命运 2 检查点控制台";
        Icon = SystemIcons.Application;
        MinimumSize = new Size(820, 560);
        Size = new Size(1200, 800);
        StartPosition = FormStartPosition.CenterScreen;
        _webView.Dock = DockStyle.Fill;
        Controls.Add(_webView);
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
            if (IsServiceOrigin(e.Uri)) return;
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
            var type = typeElement.GetString();
            if (type == "open-twitch" && message.RootElement.TryGetProperty("login", out var loginElement) &&
                loginElement.ValueKind == JsonValueKind.String && TryNormalizeTwitchLogin(loginElement.GetString(), out var login))
            {
                OpenTwitchRequested?.Invoke(login);
                return;
            }
        }
        catch (JsonException) { }
        catch (Exception) { }
    }

    internal void PostScreenCapture(string login, string requestId, string imageBase64)
    {
        if (_allowClose || IsDisposed || _webView.IsDisposed || _webView.CoreWebView2 is null) return;
        try
        {
            var payload = JsonSerializer.Serialize(new { type = "screen-capture", login, requestId, imageBase64 });
            _webView.CoreWebView2.PostWebMessageAsJson(payload);
        }
        catch (Exception) { }
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

    private static void OpenExternal(string text)
    {
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); } catch { }
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
}

internal sealed class TwitchBrowserWindow : Form
{
    private const int MaxCaptureBytes = 6 * 1024 * 1024;
    private readonly string _profilePath;
    private readonly DesktopWindow _dashboard;
    private readonly WebView2 _webView = new();
    private readonly TextBox _address = new();
    private readonly Button _back = new();
    private readonly Button _forward = new();
    private readonly Button _reload = new();
    private readonly Button _capture = new();
    private readonly CheckBox _auto = new();
    private readonly Label _status = new();
    private readonly System.Windows.Forms.Timer _autoTimer = new() { Interval = 15_000 };
    private readonly SemaphoreSlim _captureGate = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();
    private readonly object _captureSync = new();
    private CancellationTokenSource? _activeCapture;
    private Task? _initialization;
    private bool _allowClose;
    private bool _windowActive;
    private bool _navigationPending;
    private bool _pageReady;
    private string _desiredLogin = string.Empty;
    private static long _requestCounter;
    private long _navigationGeneration;

    private static readonly HashSet<string> ReservedPaths = new(StringComparer.OrdinalIgnoreCase)
    {
        "login", "signup", "activate", "settings", "directory", "downloads", "search",
        "subscriptions", "inventory", "following", "videos", "clip", "jobs", "p", "turbo"
    };

    public TwitchBrowserWindow(string profilePath, DesktopWindow dashboard)
    {
        _profilePath = profilePath;
        _dashboard = dashboard;
        Text = "Twitch 直播画面 — 命运 2 检查点控制台";
        Icon = SystemIcons.Application;
        MinimumSize = new Size(920, 640);
        Size = new Size(1280, 820);
        StartPosition = FormStartPosition.CenterScreen;

        var toolbar = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 72,
            Padding = new Padding(8, 6, 8, 6),
            WrapContents = true,
            BackColor = Color.FromArgb(30, 35, 40)
        };
        ConfigureButton(_back, "←", 38, (_, _) => { if (_webView.CoreWebView2?.CanGoBack == true) _webView.CoreWebView2.GoBack(); });
        ConfigureButton(_forward, "→", 38, (_, _) => { if (_webView.CoreWebView2?.CanGoForward == true) _webView.CoreWebView2.GoForward(); });
        ConfigureButton(_reload, "刷新", 52, (_, _) => _webView.CoreWebView2?.Reload());
        _address.Width = 430;
        _address.Height = 28;
        _address.Margin = new Padding(4, 2, 4, 2);
        _address.BackColor = Color.FromArgb(20, 24, 28);
        _address.ForeColor = Color.White;
        _address.BorderStyle = BorderStyle.FixedSingle;
        _address.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { NavigateAddress(); e.SuppressKeyPress = true; } };
        ConfigureButton(_capture, "识别当前画面", 112, async (_, _) => await CapturePreviewAsync(_desiredLogin, NextRequestId()));
        _auto.Text = "每 15 秒自动识别";
        _auto.AutoSize = true;
        _auto.ForeColor = Color.White;
        _auto.Margin = new Padding(8, 7, 4, 2);
        _auto.CheckedChanged += (_, _) => { _autoTimer.Enabled = _auto.Checked && IsCaptureEligible(out _); };
        _autoTimer.Tick += async (_, _) =>
        {
            if (_auto.Checked && Visible && _windowActive && IsCaptureEligible(out var login))
                await CapturePreviewAsync(login, NextRequestId());
        };
        Activated += (_, _) => { _windowActive = true; UpdateCaptureState(); };
        Deactivate += (_, _) => { _windowActive = false; PauseAutomaticCapture(cancelCapture: true); UpdateCaptureState(); };
        _status.AutoSize = false;
        _status.Width = 780;
        _status.Height = 23;
        _status.ForeColor = Color.FromArgb(240, 200, 120);
        _status.Text = "仅识别当前可见直播画面；登录、验证、密码页面请勿启用。";
        _status.Margin = new Padding(8, 3, 4, 0);
        toolbar.Controls.AddRange(new Control[] { _back, _forward, _reload, _address, _capture, _auto, _status });

        _webView.Dock = DockStyle.Fill;
        Controls.Add(_webView);
        Controls.Add(toolbar);
    }

    private static void ConfigureButton(Button button, string text, int width, EventHandler handler)
    {
        button.Text = text;
        button.Width = width;
        button.Height = 28;
        button.Margin = new Padding(3, 2, 3, 2);
        button.FlatStyle = FlatStyle.Flat;
        button.ForeColor = Color.White;
        button.BackColor = Color.FromArgb(55, 65, 72);
        button.Click += handler;
    }

    public async Task ShowChannelAsync(string login)
    {
        if (!DesktopWindow.TryNormalizeTwitchLogin(login, out var normalized)) throw new ArgumentException("Invalid Twitch channel login.", nameof(login));
        _desiredLogin = normalized;
        await EnsureInitializedAsync();
        if (_allowClose) return;
        if (!Visible) Show();
        Activate();
        var target = $"https://www.twitch.tv/{normalized}";
        if (_webView.CoreWebView2 is null || !string.Equals(_webView.CoreWebView2.Source, target, StringComparison.OrdinalIgnoreCase))
            _webView.CoreWebView2?.Navigate(target);
        UpdateCaptureState();
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
        core.Settings.AreDefaultScriptDialogsEnabled = true;
        core.NavigationStarting += (_, e) =>
        {
            _navigationPending = true;
            _pageReady = false;
            PauseAutomaticCapture(cancelCapture: true);
            UpdateCaptureState();
            if (!IsAllowedTwitchUri(e.Uri))
            {
                e.Cancel = true;
                _navigationPending = false;
                _pageReady = TryGetCaptureLogin(core.Source, out var existingLogin) && string.Equals(existingLogin, _desiredLogin, StringComparison.OrdinalIgnoreCase);
                SetStatus("仅允许在此窗口浏览 Twitch 官方 HTTPS 页面。");
                UpdateCaptureState();
                return;
            }
            _address.Text = e.Uri;
            UpdateCaptureState();
        };
        core.NavigationCompleted += (_, e) =>
        {
            _navigationPending = false;
            _pageReady = e.IsSuccess && TryGetCaptureLogin(core.Source, out var readyLogin) && string.Equals(readyLogin, _desiredLogin, StringComparison.OrdinalIgnoreCase);
            if (!e.IsSuccess) SetStatus("Twitch 页面加载失败，请检查网络后重试。");
            else SetStatus("仅识别当前可见直播画面；登录、验证、密码页面请勿启用。");
            UpdateCaptureState();
        };
        core.SourceChanged += (_, _) =>
        {
            PauseAutomaticCapture(cancelCapture: true);
            if (core.Source is { } source)
            {
                if (IsAllowedTwitchUri(source)) _address.Text = source;
                // SourceChanged also fires for SPA history updates that may not produce
                // NavigationCompleted; keep capture disabled unless the intended channel
                // URL is still current, while preserving an in-flight top-level navigation.
                _pageReady = !_navigationPending && TryGetCaptureLogin(source, out var currentLogin) &&
                    string.Equals(currentLogin, _desiredLogin, StringComparison.OrdinalIgnoreCase);
            }
            else _pageReady = false;
            UpdateCaptureState();
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (IsAllowedTwitchUri(e.Uri))
            {
                PauseAutomaticCapture(cancelCapture: true);
                core.Navigate(e.Uri);
            }
            else SetStatus("已阻止非 Twitch 官方弹窗。");
        };
        _back.Enabled = false;
        _forward.Enabled = false;
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
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return false;
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

    public async Task CapturePreviewAsync(string login, string requestId)
    {
        if (!DesktopWindow.TryNormalizeTwitchLogin(login, out var normalized) || string.IsNullOrWhiteSpace(requestId)) return;
        if (!await _captureGate.WaitAsync(0)) { SetStatus("已有识别进行中，请稍候。"); return; }
        BoundedMemoryStream? image = null;
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
            var captureImage = new BoundedMemoryStream(MaxCaptureBytes);
            image = captureImage;
            SetStatus("正在捕获当前可见画面…");
            var captureTask = _webView.CoreWebView2!.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Jpeg, captureImage);
            try
            {
                await captureTask.WaitAsync(timeout.Token);
            }
            catch
            {
                if (captureTask is { IsCompleted: false })
                {
                    image = null;
                    _ = captureTask.ContinueWith(completed =>
                    {
                        _ = completed.Exception;
                        captureImage.Dispose();
                    }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                }
                throw;
            }
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
            _dashboard.PostScreenCapture(normalized, requestId, base64);
            SetStatus("画面已交给本机识别。");
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
            image?.Dispose();
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
        var eligible = IsCaptureEligible(out _);
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
        if (!Visible) PauseAutomaticCapture(cancelCapture: true);
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
