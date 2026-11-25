using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace D2Checkpoint.Launcher;

internal static class TwitchPreviewCapture
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly ImageCodecInfo JpegCodec = ImageCodecInfo.GetImageEncoders().First(encoder => encoder.FormatID == ImageFormat.Jpeg.Guid);

    internal sealed record Region(double Left, double Top, double Width, double Height, double ViewportWidth, double ViewportHeight)
    {
        internal bool Matches(Region other) => Math.Abs(Left - other.Left) <= 1 && Math.Abs(Top - other.Top) <= 1 &&
            Math.Abs(Width - other.Width) <= 1 && Math.Abs(Height - other.Height) <= 1 &&
            ViewportWidth == other.ViewportWidth && ViewportHeight == other.ViewportHeight;
    }

    internal sealed record VideoSource(int Width, int Height, int ReadyState)
    {
        internal bool Matches(VideoSource? other) => other is not null && Width == other.Width && Height == other.Height;
        internal bool HasPreferredQuality => Width >= 1280 && Height >= 720 && ReadyState >= 3;
    }

    internal sealed record Probe(string State, Region? Region, double? PlaybackTime, VideoSource? Source, string? SourceImage);
    internal sealed record FrameInfo(int SourceWidth, int SourceHeight, string Method);
    internal sealed record Result(string[] Frames, string Message, bool Interrupted = false, FrameInfo[]? FrameInfo = null);

    internal static bool IsChannel(string? text, string login) => Uri.TryCreate(text, UriKind.Absolute, out var uri) &&
        uri.Scheme == Uri.UriSchemeHttps && uri.IsDefaultPort && uri.UserInfo.Length == 0 &&
        uri.Host.Equals("www.twitch.tv", StringComparison.OrdinalIgnoreCase) &&
        uri.AbsolutePath.Equals($"/{login}", StringComparison.OrdinalIgnoreCase) && uri.Query.Length == 0 && uri.Fragment.Length == 0;

    internal static string InspectPlayer(string login, string? playbackId = null, long playbackDeadline = 0, bool captureSource = false) =>
        $"({InspectScript})({JsonSerializer.Serialize(login)}, {JsonSerializer.Serialize(playbackId)}, {playbackDeadline.ToString(CultureInfo.InvariantCulture)}, {(captureSource ? "true" : "false")})";

    internal static string RestorePlayback(string login, string requestId, bool pauseNewPage) =>
        $"({RestoreScript})({JsonSerializer.Serialize(login)}, {JsonSerializer.Serialize(requestId)}, {(pauseNewPage ? "true" : "false")})";

    internal static Probe? ReadProbe(string result) => JsonSerializer.Deserialize<Probe>(result, JsonOptions);

    internal static async Task<string> CaptureVideoAsync(CoreWebView2 core, Region bounds, int maxBytes, CancellationToken cancellationToken)
    {
        // Capture the clipped video at up to twice the display scale for small overlay text.
        cancellationToken.ThrowIfCancellationRequested();
        using var metrics = JsonDocument.Parse(await core.CallDevToolsProtocolMethodAsync("Page.getLayoutMetrics", "{}").WaitAsync(cancellationToken));
        var viewport = metrics.RootElement.GetProperty("cssVisualViewport");
        var width = Math.Floor(bounds.Width);
        var height = Math.Floor(bounds.Height);
        if (width < 160 || height < 90) throw new InvalidOperationException("The video is too small to read.");
        var clip = new
        {
            x = Math.Ceiling(bounds.Left + viewport.GetProperty("pageX").GetDouble()),
            y = Math.Ceiling(bounds.Top + viewport.GetProperty("pageY").GetDouble()),
            width,
            height,
            scale = Math.Min(2, Math.Min(1920 / width, 1080 / height))
        };
        var options = JsonSerializer.Serialize(new { format = "jpeg", quality = 95, clip, captureBeyondViewport = false });
        cancellationToken.ThrowIfCancellationRequested();
        using var screenshot = JsonDocument.Parse(await core.CallDevToolsProtocolMethodAsync("Page.captureScreenshot", options).WaitAsync(cancellationToken));
        var image = screenshot.RootElement.GetProperty("data").GetString();
        if (string.IsNullOrEmpty(image) || image.Length > (maxBytes + 2) / 3 * 4)
            throw new InvalidOperationException("The clipped video image exceeds the local capture limit.");
        return image;
    }

    internal static byte[] Crop(Stream image, Region bounds, int maxBytes)
    {
        image.Position = 0;
        using var source = new Bitmap(image);
        var scaleX = source.Width / bounds.ViewportWidth;
        var scaleY = source.Height / bounds.ViewportHeight;
        if (!double.IsFinite(scaleX) || !double.IsFinite(scaleY) || scaleX <= 0 || scaleY <= 0 || Math.Abs(scaleX / scaleY - 1) > 0.05)
            throw new InvalidOperationException("The preview size no longer matches the video viewport.");
        var crop = Rectangle.FromLTRB((int)Math.Ceiling(bounds.Left * scaleX), (int)Math.Ceiling(bounds.Top * scaleY),
            (int)Math.Floor((bounds.Left + bounds.Width) * scaleX), (int)Math.Floor((bounds.Top + bounds.Height) * scaleY));
        if (crop.Width < 160 || crop.Height < 90 || !new Rectangle(0, 0, source.Width, source.Height).Contains(crop))
            throw new InvalidOperationException("The video rectangle is outside the preview.");

        var outputScale = Math.Min(2, Math.Min(1920d / crop.Width, 1080d / crop.Height));
        using var cropped = new Bitmap((int)Math.Floor(crop.Width * outputScale), (int)Math.Floor(crop.Height * outputScale), PixelFormat.Format24bppRgb);
        using (var drawing = Graphics.FromImage(cropped))
        {
            drawing.InterpolationMode = InterpolationMode.HighQualityBicubic;
            drawing.DrawImage(source, new Rectangle(0, 0, cropped.Width, cropped.Height), crop, GraphicsUnit.Pixel);
        }
        using var jpeg = new BoundedMemoryStream(maxBytes);
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(Encoder.Quality, 95L);
        cropped.Save(jpeg, JpegCodec, parameters);
        return jpeg.ToArray();
    }

    private const string InspectScript = """
        (login, playbackId, playbackDeadline, captureSource) => {
          const requireLive = playbackId !== null;
          if (location.origin !== 'https://www.twitch.tv' || location.pathname.toLowerCase() !== `/${login}` || document.hidden ||
              (requireLive && (location.search || location.hash || Date.now() >= playbackDeadline)))
            return { state: 'left' };
          const visible = node => {
            if (!node?.getClientRects().length) return false;
            const bounds = node.getBoundingClientRect();
            if (bounds.width < 2 || bounds.height < 2 || bounds.bottom <= 0 || bounds.right <= 0 ||
                bounds.top >= innerHeight || bounds.left >= innerWidth) return false;
            const style = getComputedStyle(node);
            return style.visibility === 'visible' && style.opacity !== '0';
          };
          const anyVisible = (scope, selector) => Array.from(scope.querySelectorAll(selector)).some(visible);
          if (anyVisible(document, '[role="dialog"], [aria-modal="true"], input[type="password"], input[autocomplete="one-time-code"], [data-a-target="player-overlay-content-gate"]'))
            return { state: 'blocked' };

          const playerSelector = '[data-a-target="video-player"], [data-test-selector="video-player"], .video-player, .channel-root__player';
          const videos = Array.from(document.querySelectorAll('main video, .persistent-player video, .channel-root__player video'))
            .filter(node => {
              if (!visible(node)) return false;
              const bounds = node.getBoundingClientRect();
              return bounds.width >= 160 && bounds.height >= 90 && bounds.bottom > 0 && bounds.right > 0 &&
                bounds.top < innerHeight && bounds.left < innerWidth;
            });
          if (videos.length !== 1) return { state: document.querySelector('main h1, main h2, [data-a-target="stream-title"]') ? 'page' : 'loading' };
          const [video] = videos;
          const player = video.closest(playerSelector) || video.closest('.persistent-player');
          if (requireLive) {
            const adSelector = '[data-a-target^="video-ad-"], [data-test-selector^="video-ad-"], ' +
              '[data-a-target="raid-player-overlay"], [data-test-selector="raid-player-overlay"]';
            if (anyVisible(document, adSelector)) return { state: 'interstitial' };
            if (video.closest('.channel-root__player--offline') || anyVisible(document, '.channel-root__player--offline')) return { state: 'offline' };
            if (!player) return { state: 'live-unknown' };
            const indicators = '[data-test-selector="live-badge"], [data-test-selector="is-live-indicator"], ' +
              '.tw-channel-status-text-indicator--live, .channel-status-info--live';
            const playerLive = anyVisible(player, indicators);
            const liveChannel = document.querySelector('.channel-root.channel-root--watch.channel-root--live');
            const liveStatus = Array.from((player.closest('.channel-root') || liveChannel || player)
                .querySelectorAll('[data-a-target="stream-status-text"], .tw-channel-status-text-indicator'))
              .some(node => visible(node) && /^(live(?: now)?|直播(?:中)?|實況(?:中)?|正在直播)$/iu.test(node.textContent.trim()));
            const declaredLive = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).some(node => {
              try {
                const graph = JSON.parse(node.textContent)['@graph'];
                return Array.isArray(graph) && graph.some(entry => {
                  if (entry?.['@type'] !== 'VideoObject' || entry.publication?.['@type'] !== 'BroadcastEvent' ||
                      entry.publication.isLiveBroadcast !== true || typeof entry.embedUrl !== 'string') return false;
                  const url = new URL(entry.embedUrl);
                  return url.origin === 'https://player.twitch.tv' && url.pathname === '/' &&
                    url.searchParams.get('channel')?.toLowerCase() === login && !url.searchParams.has('video') && !url.searchParams.has('collection');
                });
              } catch { return false; }
            });
            if (!playerLive && !liveStatus && !visible(liveChannel) && !declaredLive) return { state: 'live-unknown' };
          }
          if (requireLive && video.paused && !video.ended) {
            const key = Symbol.for('D2Checkpoint.previewPlayback');
            if (video[key]?.requestId !== playbackId) {
              video[key] = { requestId: playbackId, muted: video[key]?.muted ?? video.muted };
              video.muted = true;
              video.play().catch(() => {});
            }
          }
          if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0 || video.ended ||
              (requireLive && (video.paused || video.seeking || !Number.isFinite(video.currentTime)))) return { state: 'loading' };
          if (!requireLive) return { state: 'video' };

          const rectangle = video.getBoundingClientRect();
          let { left, top, width, height } = rectangle;
          const style = getComputedStyle(video);
          const ratio = video.videoWidth / video.videoHeight;
          if (style.objectFit === 'cover' && Math.abs(width / height / ratio - 1) > 0.05) return { state: 'outside' };
          if (['contain', 'scale-down'].includes(style.objectFit)) {
            if (!['50% 50%', 'center', 'center center'].includes(style.objectPosition)) return { state: 'outside' };
            const contentWidth = Math.min(width, height * ratio, style.objectFit === 'scale-down' ? video.videoWidth : Infinity);
            const contentHeight = contentWidth / ratio;
            left += (width - contentWidth) / 2;
            top += (height - contentHeight) / 2;
            width = contentWidth;
            height = contentHeight;
          }
          if (left < -1 || top < -1 || left + width > innerWidth + 1 || top + height > innerHeight + 1)
            return { state: 'outside' };
          left = Math.max(left, 0);
          top = Math.max(top, 0);
          width = Math.min(width, innerWidth - left);
          height = Math.min(height, innerHeight - top);
          const result = { state: 'video', playbackTime: video.currentTime,
            region: { left, top, width, height, viewportWidth: innerWidth, viewportHeight: innerHeight },
            source: { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState } };
          if (!captureSource || Date.now() >= playbackDeadline) return result;

          // Canvas can retain source detail lost when the page shrinks the player. If the browser
          // will not expose the media pixels, the caller still has the normal visible-page capture.
          try {
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, 1920 / video.videoWidth, 1080 / video.videoHeight);
            canvas.width = Math.floor(video.videoWidth * scale);
            canvas.height = Math.floor(video.videoHeight * scale);
            const context = canvas.getContext('2d');
            if (!context) return result;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);

            const check = document.createElement('canvas');
            check.width = 16;
            check.height = 9;
            const sample = check.getContext('2d', { willReadFrequently: true });
            if (!sample) return result;
            sample.drawImage(canvas, 0, 0, check.width, check.height);
            const pixels = sample.getImageData(0, 0, check.width, check.height).data;
            let min = 765, max = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              const light = pixels[i] + pixels[i + 1] + pixels[i + 2];
              min = Math.min(min, light);
              max = Math.max(max, light);
            }
            if (max - min < 24) return result;
            const prefix = 'data:image/jpeg;base64,';
            const image = canvas.toDataURL('image/jpeg', 0.95);
            if (image.startsWith(prefix)) result.sourceImage = image.slice(prefix.length);
          } catch { /* The standard canvas security policy stays in force. */ }
          return result;
        }
        """;

    private const string RestoreScript = """
        (login, requestId, pauseNewPage) => {
          if (location.origin !== 'https://www.twitch.tv' || location.pathname.toLowerCase() !== `/${login}` ||
              location.search || location.hash) return;
          const key = Symbol.for('D2Checkpoint.previewPlayback');
          for (const video of document.querySelectorAll('main video, .persistent-player video, .channel-root__player video')) {
            if (video[key]?.requestId === requestId) {
              video.pause();
              video.muted = video[key].muted;
              delete video[key];
            } else if (pauseNewPage) video.pause();
          }
        }
        """;
}
