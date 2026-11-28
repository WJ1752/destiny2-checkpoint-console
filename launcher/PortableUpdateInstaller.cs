using System.Diagnostics;

namespace D2Checkpoint.Launcher;

internal static class PortableUpdateInstaller
{
    internal const string MutexName = "Local\\D2Checkpoint.PortableShell";
    internal const string ApplyArgument = "--apply-portable-update";
    internal const string CompleteArgument = "--complete-portable-update";
    private const string LauncherName = "D2Checkpoint.exe";
    private const string StagingPrefix = ".d2-update-";
    private const string VersionsDirectory = ".d2-versions";
    private const string PreviousLauncher = "previous-launcher.exe";

    internal static Version CurrentVersion => typeof(PortableUpdateInstaller).Assembly.GetName().Version!;

    internal static string InstallRoot => Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;

    internal static string BundleRoot
    {
        get
        {
            var versions = Path.Combine(InstallRoot, VersionsDirectory);
            var installed = Path.Combine(versions, CurrentVersion.ToString());
            return IsRegularDirectory(versions) && IsRegularDirectory(installed) ? installed : InstallRoot;
        }
    }

    internal static bool AcquireMutex(Mutex instance, int milliseconds)
    {
        try { return instance.WaitOne(milliseconds); }
        catch (AbandonedMutexException) { return true; }
    }

    internal static bool IsStageName(string name) =>
        name.StartsWith(StagingPrefix, StringComparison.Ordinal) && Guid.TryParseExact(name[StagingPrefix.Length..], "N", out _);

    internal static async Task<bool> TryStartUpdateAsync(CancellationToken cancellationToken)
    {
        string? stage = null;
        try
        {
            stage = await PortableUpdateDownload.StageLatestAsync(InstallRoot, CurrentVersion, cancellationToken).ConfigureAwait(false);
            if (stage is null) return false;
            cancellationToken.ThrowIfCancellationRequested();
            StartLauncher(Path.Combine(stage, LauncherName), ApplyArgument);
            return true;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            if (stage is not null) TryCleanDirectory(stage);
            return false;
        }
        catch (Exception error)
        {
            if (stage is not null) TryCleanDirectory(stage);
            StartupDiagnostics.Write("portable-update-check-failed", error);
            return false;
        }
    }

    internal static void ApplyStagedUpdate()
    {
        var stage = InstallRoot;
        var stageName = Path.GetFileName(stage);
        if (!IsStageName(stageName) || !IsRegularDirectory(stage)) return;
        var root = Path.GetDirectoryName(stage)!;
        var launcher = Path.Combine(root, LauncherName);
        using var instance = new Mutex(false, MutexName);
        if (!AcquireMutex(instance, 12_000)) return;
        try
        {
            void Reopen(string file) => StartLauncher(file, CompleteArgument, stageName, Environment.ProcessId.ToString());
            try
            {
                InstallStaged(root, stage, CurrentVersion, Reopen);
                StartupDiagnostics.Write("portable-update-applied");
            }
            catch (Exception error)
            {
                StartupDiagnostics.Write("portable-update-apply-failed", error);
                Reopen(launcher);
            }
        }
        finally { instance.ReleaseMutex(); }
    }

    internal static void InstallStaged(string root, string stage, Version version, Action<string> reopen)
    {
        var launcher = Path.Combine(root, LauncherName);
        if (version <= ReadVersion(launcher)) throw new InvalidOperationException("The staged version is not newer than the installed launcher.");

        var versions = Directory.CreateDirectory(Path.Combine(root, VersionsDirectory)).FullName;
        if (!IsRegularDirectory(versions)) throw new IOException("The update directory is redirected.");
        var installed = Path.Combine(versions, version.ToString());
        if (IsRegularDirectory(installed)) Directory.Move(installed, Path.Combine(stage, "previous-attempt"));

        var bundle = Directory.CreateDirectory(Path.Combine(stage, "bundle")).FullName;
        foreach (var directory in new[] { "app", "runtime" })
            Directory.Move(Path.Combine(stage, directory), Path.Combine(bundle, directory));
        var notices = Path.Combine(stage, "third-party");
        if (Directory.Exists(notices)) Directory.Move(notices, Path.Combine(bundle, "third-party"));
        var readme = Path.Combine(stage, "README-Windows.md");
        if (File.Exists(readme)) File.Move(readme, Path.Combine(bundle, "README-Windows.md"));

        var replacement = Path.Combine(stage, "replacement.exe");
        var backup = Path.Combine(stage, PreviousLauncher);
        File.Copy(Path.Combine(stage, LauncherName), replacement);
        Directory.Move(bundle, installed);
        // The old launcher still selects its original bundle until its executable is atomically replaced.
        File.Replace(replacement, launcher, backup);
        try { reopen(launcher); }
        catch
        {
            File.Replace(backup, launcher, null);
            throw;
        }
    }

    internal static void Complete(string stageName, int helperId)
    {
        try
        {
            using var helper = Process.GetProcessById(helperId);
            if (!helper.WaitForExit(5_000)) return;
        }
        catch (ArgumentException) { /* The helper has already exited. */ }
        catch (Exception error) { StartupDiagnostics.Write("portable-update-cleanup-wait-failed", error); return; }

        var stage = Path.Combine(InstallRoot, stageName);
        if (!IsRegularDirectory(stage)) return;
        var backup = Path.Combine(stage, PreviousLauncher);
        if (File.Exists(backup))
        {
            try
            {
                var previous = ReadVersion(backup);
                var versions = Path.Combine(InstallRoot, VersionsDirectory);
                if (previous < CurrentVersion && IsRegularDirectory(versions))
                    TryCleanDirectory(Path.Combine(versions, previous.ToString()));
            }
            catch (Exception error) { StartupDiagnostics.Write("portable-update-previous-version-cleanup-failed", error); }
        }
        TryCleanDirectory(stage);
    }

    private static bool IsRegularDirectory(string path) => Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0;

    private static Version ReadVersion(string file)
    {
        var info = FileVersionInfo.GetVersionInfo(file);
        return new Version(info.FileMajorPart, info.FileMinorPart, info.FileBuildPart, info.FilePrivatePart);
    }

    private static void StartLauncher(string file, params string[] args)
    {
        var options = new ProcessStartInfo(file) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(file)! };
        foreach (var arg in args) options.ArgumentList.Add(arg);
        using var process = Process.Start(options) ?? throw new InvalidOperationException("Unable to start the update launcher.");
    }

    private static void TryCleanDirectory(string directory)
    {
        try
        {
            if (IsRegularDirectory(directory)) Directory.Delete(directory, recursive: true);
        }
        catch (Exception error) { StartupDiagnostics.Write("portable-update-cleanup-failed", error); }
    }
}
