[CmdletBinding()]
param(
    [string]$ReleaseRoot = ''
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ($ReleaseRoot) {
    $serviceRoot = (Resolve-Path $ReleaseRoot).Path
    $nodePath = Join-Path $serviceRoot 'runtime\node.exe'
    $workingDirectory = Join-Path $serviceRoot 'app'
    if (-not (Test-Path -LiteralPath $nodePath) -or -not (Test-Path -LiteralPath (Join-Path $workingDirectory 'desktop\main.js'))) {
        throw "ReleaseRoot is missing runtime\node.exe or app\desktop\main.js: $serviceRoot"
    }
} else {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $workingDirectory = $repo
}
$outFile = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N') + '.out.txt')
$errFile = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N') + '.err.txt')
$data = Join-Path ([IO.Path]::GetTempPath()) ('d2-checkpoint-smoke-' + [guid]::NewGuid().ToString('N'))
$key = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$oldPort = $env:D2_PORT; $oldHost = $env:D2_HOST; $oldKey = $env:D2_LAUNCH_KEY; $oldData = $env:D2_DATA_DIR
$process = $null
try {
    $env:D2_PORT = '0'; $env:D2_HOST = '127.0.0.1'; $env:D2_LAUNCH_KEY = $key; $env:D2_DATA_DIR = $data
    $process = Start-Process -FilePath $nodePath -ArgumentList @('desktop\main.js') -WorkingDirectory $workingDirectory -PassThru -NoNewWindow -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $deadline = [datetime]::UtcNow.AddSeconds(15)
    $ready = $null
    while ([datetime]::UtcNow -lt $deadline -and -not $ready) {
        if ($process.HasExited) { throw 'Desktop service exited before it printed its readiness line.' }
        if (Test-Path -LiteralPath $outFile) {
            $line = Get-Content -LiteralPath $outFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^D2_READY http://127\.0\.0\.1:\d+/$' } | Select-Object -First 1
            if ($line) { $ready = $line.Substring(9) }
        }
        if (-not $ready) { Start-Sleep -Milliseconds 150 }
    }
    if (-not $ready) { throw 'Desktop service did not print a valid loopback D2_READY line within 15 seconds.' }
    $launchResponse = Invoke-WebRequest -Uri $ready -Headers @{ 'X-D2-Launch-Key' = $key } -UseBasicParsing -TimeoutSec 5
    if ($launchResponse.StatusCode -ne 200) { throw "Bootstrap returned unexpected status $($launchResponse.StatusCode)." }
    if ($launchResponse.Headers['Set-Cookie'] -notmatch 'HttpOnly' -or $launchResponse.Headers['Set-Cookie'] -notmatch 'SameSite=Strict' -or $launchResponse.Headers['Set-Cookie'] -notmatch 'Path=/') {
        throw 'Bootstrap response lacks its expected HttpOnly/SameSite=Strict/Path=/ session cookie.'
    }
    $cookie = $launchResponse.Headers['Set-Cookie'].Split(';')[0]
    $appResponse = Invoke-WebRequest -Uri ($ready + 'api/state') -Headers @{ Cookie = $cookie } -UseBasicParsing -TimeoutSec 5
    if ($appResponse.StatusCode -ne 200) { throw "Authenticated API returned unexpected status $($appResponse.StatusCode)." }
    # Wrong key and direct URL access must never bootstrap or set another session cookie.
    try {
        $wrong = Invoke-WebRequest -Uri $ready -Headers @{ 'X-D2-Launch-Key' = ($key + 'x') } -UseBasicParsing -TimeoutSec 5 -SkipHttpErrorCheck
        if ($wrong.Headers['Set-Cookie']) { throw 'An invalid bootstrap key got a session cookie.' }
    } catch { if ($_.Exception.Message -like '*got a session cookie*') { throw } }
    try {
        $direct = Invoke-WebRequest -Uri $ready -UseBasicParsing -TimeoutSec 5 -SkipHttpErrorCheck
        if ($direct.Headers['Set-Cookie']) { throw 'A direct URL request without the launcher header got a session cookie.' }
    } catch { if ($_.Exception.Message -like '*without the launcher header*') { throw } }
    $scanUri = $ready + 'api/screen-scan?login=d2checkpoints'
    $missingOrigin = Invoke-WebRequest -Uri $scanUri -Method Post -Headers @{ Cookie = $cookie } -ContentType 'image/png' -Body ([byte[]](1,2,3)) -UseBasicParsing -TimeoutSec 5 -SkipHttpErrorCheck
    if ($missingOrigin.StatusCode -ne 403) { throw 'A screen-scan POST without an Origin header was not rejected.' }
    $badImage = Invoke-WebRequest -Uri $scanUri -Method Post -Headers @{ Cookie = $cookie; Origin = $ready.TrimEnd('/') } -ContentType 'image/png' -Body ([byte[]](1,2,3)) -UseBasicParsing -TimeoutSec 5 -SkipHttpErrorCheck
    if ($badImage.StatusCode -ne 415) { throw "Malformed image returned HTTP $($badImage.StatusCode), expected 415." }
    foreach ($route in @('api/auth/begin','api/auth/status','api/auth/logout','api/send-preview','api/send','api/refresh')) {
        $legacy = Invoke-WebRequest -Uri ($ready + $route) -Method Post -Headers @{ Cookie = $cookie; Origin = $ready.TrimEnd('/') } -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 5 -SkipHttpErrorCheck
        if ($legacy.StatusCode -ne 405) { throw "Legacy API route $route returned HTTP $($legacy.StatusCode), expected 405." }
    }
    $state = $appResponse.Content | ConvertFrom-Json
    if ($state.capabilities.chatSending -ne $false -or $state.capabilities.twitchDeveloperAppRequired -ne $false) { throw 'State must report that chat sending and a Twitch developer app are not required or available.' }
    if ($ReleaseRoot) { "PASS: bundled Node at $nodePath runs from $workingDirectory." }
    'PASS: dynamic loopback D2_READY, one-time header bootstrap, secure cookie, authenticated API, invalid-key/direct-bootstrap rejection, screen-scan Origin enforcement, malformed image rejection, and legacy auth/send route removal.'
} finally {
    if ($process -and -not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
    $env:D2_PORT = $oldPort; $env:D2_HOST = $oldHost; $env:D2_LAUNCH_KEY = $oldKey; $env:D2_DATA_DIR = $oldData
    Remove-Item -LiteralPath $outFile,$errFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue
}
