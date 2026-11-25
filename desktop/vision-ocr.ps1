$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$memory = $null
$stream = $null
$bitmap = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

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
    $bitmap = Wait-WinRT ($decoder.GetSoftwareBitmapAsync()) $softwareBitmapResultType

    $engine = $ocrEngineType::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) {
        $languageType = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
        $language = New-Object $languageType('en-US')
        $engine = $ocrEngineType::TryCreateFromLanguage($language)
    }
    if ($null -eq $engine) { throw 'Windows OCR has no available recognizer language.' }

    $ocr = Wait-WinRT ($engine.RecognizeAsync($bitmap)) $ocrResultType
    $pixelWidth = [double]$bitmap.PixelWidth
    $pixelHeight = [double]$bitmap.PixelHeight
    $lines = New-Object System.Collections.Generic.List[object]
    foreach ($line in $ocr.Lines) {
        $words = @($line.Words)
        if ($words.Count -eq 0) { continue }
        $texts = New-Object System.Collections.Generic.List[string]
        $left = [double]::PositiveInfinity
        $top = [double]::PositiveInfinity
        $right = [double]::NegativeInfinity
        $bottom = [double]::NegativeInfinity
        foreach ($word in $words) {
            $texts.Add([string]$word.Text)
            $rect = $word.BoundingRect
            $left = [Math]::Min($left, [double]$rect.X)
            $top = [Math]::Min($top, [double]$rect.Y)
            $right = [Math]::Max($right, [double]($rect.X + $rect.Width))
            $bottom = [Math]::Max($bottom, [double]($rect.Y + $rect.Height))
        }
        $lines.Add([ordered]@{
            text = [string]::Join(' ', $texts.ToArray())
            x = $left / $pixelWidth
            y = $top / $pixelHeight
            width = ($right - $left) / $pixelWidth
            height = ($bottom - $top) / $pixelHeight
        })
    }
    [ordered]@{ width = $pixelWidth; height = $pixelHeight; words = @($lines.ToArray()) } | ConvertTo-Json -Depth 5 -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 2
} finally {
    if ($null -ne $bitmap) { try { $bitmap.Dispose() } catch {} }
    if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
    if ($null -ne $memory) { try { $memory.Dispose() } catch {} }
}
