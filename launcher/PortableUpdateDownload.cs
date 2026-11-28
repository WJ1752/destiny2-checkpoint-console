using System.Buffers;
using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace D2Checkpoint.Launcher;

internal static class PortableUpdateDownload
{
    private const string Repository = "WJ1752/destiny2-checkpoint-console";
    private const string TagPrefix = "desktop-v";
    private const string ArchiveName = "D2Checkpoint-Windows-x64.zip";
    private const string ChecksumName = ArchiveName + ".sha256";
    private const int MaxMetadataBytes = 1024 * 1024;
    private const int MaxChecksumBytes = 4096;
    private const long MaxArchiveBytes = 256L * 1024 * 1024;
    private const long MaxExtractedBytes = 1024L * 1024 * 1024;
    private const int MaxEntries = 4096;
    private const int MaxCentralDirectoryBytes = 8 * 1024 * 1024;
    private const int MaxRedirects = 3;
    private static readonly char[] InvalidFileNameChars = Path.GetInvalidFileNameChars();

    internal static async Task<string?> StageLatestAsync(
        string installRoot, Version installedVersion, CancellationToken cancellationToken)
    {
        using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("D2Checkpoint-Launcher");

        var release = await DiscoverAsync(client, installedVersion, cancellationToken).ConfigureAwait(false);
        if (release is not { } update)
            return null;

        // Build the asset URLs from the fixed repository and the validated tag.
        var downloadBase = $"https://github.com/{Repository}/releases/download/{update.Tag}/";
        using var checksum = new MemoryStream();
        if (!await DownloadAsync(client, new Uri(downloadBase + ChecksumName), checksum, MaxChecksumBytes,
                releaseAsset: true, cancellationToken).ConfigureAwait(false))
            return null;
        var expectedHash = ReadChecksum(checksum);

        cancellationToken.ThrowIfCancellationRequested();
        var root = Path.GetFullPath(installRoot);
        EnsurePlainDirectoryTree(root);
        var stage = Path.Combine(root, $".d2-update-{Guid.NewGuid():N}");
        CreateDirectoryExclusive(stage);

        var handedOff = false;
        try
        {
            var downloadPath = Path.Combine(stage, $".download-{Guid.NewGuid():N}.tmp");
            using (var archive = new FileStream(downloadPath, FileMode.CreateNew, FileAccess.ReadWrite,
                FileShare.None, bufferSize: 1, FileOptions.Asynchronous | FileOptions.DeleteOnClose))
            {
                if (!await DownloadAsync(client, new Uri(downloadBase + ArchiveName), archive, MaxArchiveBytes,
                        releaseAsset: true, cancellationToken).ConfigureAwait(false))
                    return null;

                archive.Position = 0;
                var actualHash = await SHA256.HashDataAsync(archive, cancellationToken).ConfigureAwait(false);
                if (!CryptographicOperations.FixedTimeEquals(actualHash, expectedHash))
                    throw new InvalidDataException("The portable update ZIP does not match its SHA-256 checksum.");

                await ExtractAsync(archive, stage, cancellationToken).ConfigureAwait(false);
            }

            ValidatePayload(stage, update.Version);
            cancellationToken.ThrowIfCancellationRequested();
            handedOff = true;
            return stage;
        }
        finally
        {
            if (!handedOff)
                TryDeleteStage(stage);
        }
    }

    private static async Task<(string Tag, Version Version)?> DiscoverAsync(
        HttpClient client, Version installedVersion, CancellationToken cancellationToken)
    {
        using var discovery = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        discovery.CancelAfter(TimeSpan.FromSeconds(5));
        using var metadata = new MemoryStream();
        var uri = new Uri($"https://api.github.com/repos/{Repository}/releases/latest");
        try
        {
            if (!await DownloadAsync(client, uri, metadata, MaxMetadataBytes, releaseAsset: false, discovery.Token)
                    .ConfigureAwait(false))
                return null;

            metadata.Position = 0;
            using var document = await JsonDocument.ParseAsync(metadata, cancellationToken: discovery.Token)
                .ConfigureAwait(false);
            var release = document.RootElement;
            var tag = release.GetProperty("tag_name").GetString();
            if (release.GetProperty("draft").GetBoolean() || release.GetProperty("prerelease").GetBoolean()
                || tag is null || !tag.StartsWith(TagPrefix + "1.0.", StringComparison.Ordinal)
                || !Version.TryParse(tag.AsSpan(TagPrefix.Length), out var version) || version.Revision < 0
                || !tag.AsSpan(TagPrefix.Length).SequenceEqual(version.ToString().AsSpan())
                || version <= installedVersion)
                return null;

            var hasArchive = false;
            var hasChecksum = false;
            foreach (var asset in release.GetProperty("assets").EnumerateArray())
            {
                var name = asset.GetProperty("name").GetString();
                hasArchive |= name == ArchiveName;
                hasChecksum |= name == ChecksumName;
            }

            discovery.Token.ThrowIfCancellationRequested();
            return hasArchive && hasChecksum ? (tag, version) : null;
        }
        catch (OperationCanceledException error) when (discovery.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("GitHub release discovery timed out.", error);
        }
    }

    private static async Task<bool> DownloadAsync(HttpClient client, Uri uri, Stream destination, long limit,
        bool releaseAsset, CancellationToken cancellationToken)
    {
        for (var redirects = 0; ; redirects++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            if (!releaseAsset)
                request.Headers.Accept.ParseAdd("application/vnd.github+json");

            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                .ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.NotFound)
                return false;
            if (response.StatusCode is HttpStatusCode.MovedPermanently or HttpStatusCode.Found or HttpStatusCode.SeeOther
                or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect)
            {
                if (!releaseAsset || redirects >= MaxRedirects || response.Headers.Location is not { } location
                    || !Uri.TryCreate(uri, location, out var next) || !IsReleaseAssetRedirect(next))
                    throw new HttpRequestException("GitHub returned an unexpected release download redirect.");
                uri = next;
                continue;
            }

            response.EnsureSuccessStatusCode();
            if (response.StatusCode != HttpStatusCode.OK)
                throw new HttpRequestException("GitHub did not return a complete release response.", null, response.StatusCode);
            if (response.Content.Headers.ContentLength > limit)
                throw new InvalidDataException("A GitHub release response exceeds its size limit.");

            using var source = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            await CopyBoundedAsync(source, destination, limit, cancellationToken).ConfigureAwait(false);
            return true;
        }
    }

    private static bool IsReleaseAssetRedirect(Uri uri)
    {
        if (uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0)
            return false;

        return uri.Host switch
        {
            "release-assets.githubusercontent.com" => uri.AbsolutePath.StartsWith(
                "/github-production-release-asset/", StringComparison.Ordinal),
            "objects.githubusercontent.com" => uri.AbsolutePath.StartsWith(
                "/github-production-release-asset-2e65be/", StringComparison.Ordinal),
            _ => false,
        };
    }

    private static byte[] ReadChecksum(MemoryStream checksum)
    {
        var text = Encoding.UTF8.GetString(checksum.GetBuffer(), 0, (int)checksum.Length).TrimStart('\uFEFF').Trim();
        var fields = text.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);
        var hash = new byte[32];
        if (fields.Length is < 1 or > 2 || fields[0].Length != 64
            || Convert.FromHexString(fields[0].AsSpan(), hash, out _, out _) != OperationStatus.Done
            || (fields.Length == 2 && fields[1] != ArchiveName && fields[1] != "*" + ArchiveName))
            throw new InvalidDataException("The portable update checksum has an invalid format.");

        return hash;
    }

    private static async Task ExtractAsync(Stream source, string stage, CancellationToken cancellationToken)
    {
        await ValidateArchiveDirectoryAsync(source, cancellationToken).ConfigureAwait(false);
        using var archive = new ZipArchive(source, ZipArchiveMode.Read, leaveOpen: true);
        if (archive.Entries.Count > MaxEntries)
            throw new InvalidDataException("The portable update ZIP contains too many entries.");

        var entries = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { stage };
        long remaining = MaxExtractedBytes;
        foreach (var entry in archive.Entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var name = entry.FullName.Replace('\\', '/');
            var isDirectory = name.EndsWith('/');
            var relative = isDirectory ? name[..^1] : name;
            var segments = relative.Split('/');
            var attributes = entry.ExternalAttributes;
            var unixType = (attributes >> 16) & 0xF000;
            if (segments.Length > 32 || segments.Any(segment => !IsSafeFileName(segment)) || !entries.Add(relative)
                || (attributes & (int)(FileAttributes.ReparsePoint | FileAttributes.Device)) != 0
                || (unixType != 0 && unixType != (isDirectory ? 0x4000 : 0x8000))
                || (!isDirectory && (attributes & (int)FileAttributes.Directory) != 0)
                || (isDirectory && entry.Length != 0))
                throw new InvalidDataException("The portable update ZIP contains an unsafe or duplicate entry.");
            if (entry.Length > remaining || entry.Length > MaxArchiveBytes)
                throw new InvalidDataException("The portable update ZIP exceeds its extraction size limit.");

            EnsurePlainDirectoryTree(stage);
            var parent = stage;
            var directoryCount = isDirectory ? segments.Length : segments.Length - 1;
            for (var index = 0; index < directoryCount; index++)
            {
                parent = Path.Combine(parent, segments[index]);
                if (directories.Add(parent))
                {
                    if (directories.Count > MaxEntries)
                        throw new InvalidDataException("The portable update ZIP contains too many directories.");
                    CreateDirectoryExclusive(parent);
                }
                EnsurePlainDirectory(parent);
            }
            if (isDirectory)
                continue;

            var path = Path.Combine(parent, segments[^1]);
            using var contents = entry.Open();
            using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                bufferSize: 1, FileOptions.Asynchronous);
            var written = await CopyBoundedAsync(contents, file, entry.Length, cancellationToken).ConfigureAwait(false);
            if (written != entry.Length)
                throw new InvalidDataException("The portable update ZIP contains a truncated entry.");
            remaining -= written;
        }
    }

    private static async Task ValidateArchiveDirectoryAsync(Stream source, CancellationToken cancellationToken)
    {
        // Bound the central directory before ZipArchive materializes the entry objects.
        const int recordSize = 22;
        const uint signature = 0x06054B50;
        var tail = new byte[(int)Math.Min(source.Length, recordSize + ushort.MaxValue)];
        var tailOffset = source.Length - tail.Length;
        source.Position = tailOffset;
        await source.ReadExactlyAsync(tail, cancellationToken).ConfigureAwait(false);

        for (var offset = tail.Length - recordSize; offset >= 0; offset--)
        {
            var record = tail.AsSpan(offset);
            if (BinaryPrimitives.ReadUInt32LittleEndian(record) != signature)
                continue;

            var size = BinaryPrimitives.ReadUInt32LittleEndian(record[12..]);
            var start = BinaryPrimitives.ReadUInt32LittleEndian(record[16..]);
            if (BinaryPrimitives.ReadUInt16LittleEndian(record[20..]) != record.Length - recordSize
                || BinaryPrimitives.ReadUInt32LittleEndian(record[4..]) != 0
                || BinaryPrimitives.ReadUInt16LittleEndian(record[8..]) != BinaryPrimitives.ReadUInt16LittleEndian(record[10..])
                || BinaryPrimitives.ReadUInt16LittleEndian(record[10..]) > MaxEntries
                || size > MaxCentralDirectoryBytes || (long)start + size != tailOffset + offset)
                break;

            source.Position = 0;
            return;
        }

        throw new InvalidDataException("The portable update ZIP has an invalid or oversized central directory.");
    }

    private static bool IsSafeFileName(string name)
    {
        // Reject Windows path aliases, including device names with an extension.
        if (name.Length is 0 or > 255 || name.StartsWith(' ') || name.EndsWith('.') || name.EndsWith(' ')
            || name.IndexOfAny(InvalidFileNameChars) >= 0)
            return false;

        var dot = name.IndexOf('.');
        var stem = (dot < 0 ? name : name[..dot]).TrimEnd(' ').ToUpperInvariant();
        return stem is not ("CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$")
            && !(stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal)
                || stem.StartsWith("LPT", StringComparison.Ordinal)) && "0123456789¹²³".Contains(stem[3]));
    }

    private static void ValidatePayload(string stage, Version version)
    {
        var launcher = Path.Combine(stage, "D2Checkpoint.exe");
        foreach (var file in new[] { launcher, Path.Combine(stage, "app", "desktop", "main.js"),
            Path.Combine(stage, "runtime", "node.exe") })
        {
            if (!File.Exists(file))
                throw new InvalidDataException("The portable update ZIP is missing a required payload file.");
            EnsurePlainDirectoryTree(Path.GetDirectoryName(file)!);
            if ((File.GetAttributes(file) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                throw new InvalidDataException("A required update payload is not a regular file.");
        }

        var info = FileVersionInfo.GetVersionInfo(launcher);
        var fileVersion = new Version(info.FileMajorPart, info.FileMinorPart, info.FileBuildPart, info.FilePrivatePart);
        if (fileVersion != version)
            throw new InvalidDataException($"The staged launcher file version {fileVersion} does not match release {version}.");
    }

    private static async Task<long> CopyBoundedAsync(Stream source, Stream destination, long limit,
        CancellationToken cancellationToken)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        try
        {
            long total = 0;
            int read;
            while ((read = await source.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false)) != 0)
            {
                if (read > limit - total)
                    throw new InvalidDataException("A portable update stream exceeds its size limit.");
                await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                total += read;
            }
            return total;
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static void EnsurePlainDirectoryTree(string path)
    {
        for (DirectoryInfo? directory = new(path); directory is not null; directory = directory.Parent)
            EnsurePlainDirectory(directory.FullName);
    }

    private static void EnsurePlainDirectory(string path)
    {
        if ((File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
            throw new IOException("Portable update staging requires ordinary directories.");
    }

    private static void CreateDirectoryExclusive(string path)
    {
        // Directory.CreateDirectory also succeeds for an existing directory. Ownership here must be exclusive.
        if (!CreateDirectoryWindows(path, IntPtr.Zero))
            throw new IOException("Could not create a new portable update directory.", new Win32Exception(Marshal.GetLastPInvokeError()));
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectoryWindows(string path, IntPtr securityAttributes);

    private static void TryDeleteStage(string stage)
    {
        try
        {
            EnsurePlainDirectoryTree(stage);
            Directory.Delete(stage, recursive: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
