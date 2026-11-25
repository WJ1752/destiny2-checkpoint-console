param([switch]$PreferEnglish)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$memory = $null
$stream = $null
$bitmap = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $processingTime = [System.Diagnostics.Stopwatch]::StartNew()

    # Read the image bytes from stdin; no image path or channel name is passed to PowerShell.
    $inputStream = [Console]::OpenStandardInput()
    $memory = New-Object System.IO.MemoryStream
    $chunk = New-Object byte[] 65536
    while (($count = $inputStream.Read($chunk, 0, $chunk.Length)) -gt 0) {
        $memory.Write($chunk, 0, $count)
    }
    if ($memory.Length -eq 0) { throw 'No image bytes supplied.' }

    $memory.Position = 0
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)

    function Wait-WinRT($operation, [Type]$resultType) {
        # WinRT's projected async objects report as System.__ComObject in Windows PowerShell;
        # determine the generic TResult from the known API call rather than introspection.
        $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            if ($_.Name -ne 'AsTask' -or -not $_.IsGenericMethod) { return $false }
            try {
                $parameters = $_.GetParameters()
                return $parameters.Count -eq 1 -and $parameters[0].ParameterType.Name -eq 'IAsyncOperation`1'
            } catch { return $false }
        } | Select-Object -First 1
        if ($null -eq $method) { throw 'WinRT operation await helper is unavailable.' }
        $method = $method.MakeGenericMethod(@($resultType))
        $task = $method.Invoke($null, @($operation))
        return $task.GetAwaiter().GetResult()
    }

    $decoderType = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $ocrEngineType = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
    $bitmapDecoderResultType = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $softwareBitmapResultType = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $ocrResultType = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType = WindowsRuntime]
    $decoder = Wait-WinRT ($decoderType::CreateAsync($stream)) $bitmapDecoderResultType

    # Small live-player crops can put checkpoint letters below the OCR engine's useful size.
    if ($PreferEnglish -and $decoder.PixelWidth -gt 0 -and $decoder.PixelHeight -gt 0 -and $decoder.PixelWidth -lt 1440) {
        $maximum = [double]$ocrEngineType::MaxImageDimension
        $scale = [Math]::Min(2, [Math]::Min(1440 / [double]$decoder.PixelWidth, $maximum / [Math]::Max($decoder.PixelWidth, $decoder.PixelHeight)))
        if ($scale -ge 1.15) {
            try {
                $transformType = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
                $transform = New-Object $transformType
                $transform.ScaledWidth = [uint32][Math]::Floor($decoder.PixelWidth * $scale)
                $transform.ScaledHeight = [uint32][Math]::Floor($decoder.PixelHeight * $scale)
                $format = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime]::Bgra8
                $alpha = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]::Ignore
                $orientation = [Windows.Graphics.Imaging.ExifOrientationMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]::IgnoreExifOrientation
                $color = [Windows.Graphics.Imaging.ColorManagementMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]::DoNotColorManage
                $bitmap = Wait-WinRT ($decoder.GetSoftwareBitmapAsync($format, $alpha, $transform, $orientation, $color)) $softwareBitmapResultType
            } catch { }
        }
    }
    if ($null -eq $bitmap) { $bitmap = Wait-WinRT ($decoder.GetSoftwareBitmapAsync()) $softwareBitmapResultType }

    $languageType = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    $english = New-Object $languageType('en-US')
    $profileEngine = $ocrEngineType::TryCreateFromUserProfileLanguages()
    $engine = $profileEngine
    if ($PreferEnglish) { $engine = $ocrEngineType::TryCreateFromLanguage($english) }
    if ($null -eq $engine) {
        $engine = if ($PreferEnglish) { $profileEngine } else { $ocrEngineType::TryCreateFromLanguage($english) }
    }
    if ($null -eq $engine) { throw 'Windows OCR has no available recognizer language.' }

    $pixelWidth = [double]$bitmap.PixelWidth
    $pixelHeight = [double]$bitmap.PixelHeight
    function Read-Words($recognizer) {
        $ocr = Wait-WinRT ($recognizer.RecognizeAsync($bitmap)) $ocrResultType
        foreach ($line in $ocr.Lines) {
            foreach ($word in $line.Words) {
                $rect = $word.BoundingRect
                [ordered]@{
                    text = [string]$word.Text
                    x = $rect.X / $pixelWidth
                    y = $rect.Y / $pixelHeight
                    width = $rect.Width / $pixelWidth
                    height = $rect.Height / $pixelHeight
                }
            }
        }
    }
    $output = [ordered]@{ width = $pixelWidth; height = $pixelHeight; words = @(Read-Words $engine) }
    if ($PreferEnglish -and $null -ne $profileEngine -and $processingTime.ElapsedMilliseconds -lt 9000 -and
        $profileEngine.RecognizerLanguage.LanguageTag -ne $engine.RecognizerLanguage.LanguageTag) {
        try { $output['alternateWords'] = @(Read-Words $profileEngine) } catch { }
    }
    $output | ConvertTo-Json -Depth 5 -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 2
} finally {
    if ($null -ne $bitmap) { try { $bitmap.Dispose() } catch {} }
    if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
    if ($null -ne $memory) { try { $memory.Dispose() } catch {} }
}
