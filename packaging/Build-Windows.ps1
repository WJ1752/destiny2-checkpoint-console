[CmdletBinding()]
param(
    [string]$Configuration = 'Release',
    [string]$RuntimeIdentifier = 'win-x64',
    [string]$NodeVersion = '22.18.0',
    [string]$OutputDirectory = 'release'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$release = if ([IO.Path]::IsPathRooted($OutputDirectory)) { [IO.Path]::GetFullPath($OutputDirectory) } else { [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory)) }
$launcherProject = Join-Path $repo 'launcher\D2Checkpoint.Launcher.csproj'
$appStage = Join-Path $release 'app'
$runtimeStage = Join-Path $release 'runtime'
$nodeZip = Join-Path ([IO.Path]::GetTempPath()) "node-v$NodeVersion-win-x64.zip"
$nodeRoot = Join-Path ([IO.Path]::GetTempPath()) "d2-node-v$NodeVersion-win-x64"

if ($RuntimeIdentifier -ne 'win-x64') { throw 'Only the Windows x64 release target is supported.' }
$expectedRoot = [IO.Path]::GetFullPath($repo + [IO.Path]::DirectorySeparatorChar)
if ($release.Equals($repo, [StringComparison]::OrdinalIgnoreCase) -or -not $release.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "OutputDirectory must name a project subdirectory, not a path outside the project: $release" }
$dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
$cachedSdkExe = Join-Path ([IO.Path]::GetTempPath()) 'd2-dotnet-sdk10\dotnet.exe'
$dotnetCandidates = @()
if ($env:D2_DOTNET_EXE -and (Test-Path -LiteralPath $env:D2_DOTNET_EXE)) { $dotnetCandidates += (Resolve-Path -LiteralPath $env:D2_DOTNET_EXE).Path }
if ($dotnetCommand) { $dotnetCandidates += $dotnetCommand.Source }
if (Test-Path -LiteralPath $cachedSdkExe) { $dotnetCandidates += (Resolve-Path -LiteralPath $cachedSdkExe).Path }
$dotnetExe = ''
$sdks = @()
foreach ($candidate in ($dotnetCandidates | Select-Object -Unique)) {
    try {
        $candidateSdks = @(& $candidate --list-sdks 2>$null | Where-Object { $_ -match '^10\.' })
        if ($candidateSdks.Count -gt 0) { $dotnetExe = $candidate; $sdks = $candidateSdks; break }
    } catch { }
}
if (-not $dotnetExe) { throw '.NET 10 SDK is required to build the Windows launcher. Install it or set D2_DOTNET_EXE to a dotnet executable with the .NET 10 SDK.' }

$desktopSource = Join-Path $repo 'desktop'
if (-not (Test-Path -LiteralPath $desktopSource)) { throw 'The integrated desktop service folder is missing. Run this after the desktop service implementation is ready.' }
$requiredDesktopFiles = @('main.js','vision.js','vision-ocr.ps1','vision-data.json','ui/index.html','ui/app.js','ui/styles.css')
$missingDesktopFiles = @($requiredDesktopFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $desktopSource $_)) })
if ($missingDesktopFiles.Count -gt 0) { throw "Desktop integration is incomplete. Missing: $($missingDesktopFiles -join ', ')" }

# Build into a staging folder, not the checked-in source tree. Only remove a verified child.
if (Test-Path -LiteralPath $release) { Remove-Item -LiteralPath $release -Recurse -Force }
New-Item -ItemType Directory -Path $appStage,$runtimeStage -Force | Out-Null
# Copy executable/static source only. Personal data, credentials, caches, logs, and dependencies
# are intentionally excluded even if someone leaves them below desktop/ while developing.
$excludedName = @('.env', '.env.*', 'credentials.json', 'tokens.json', '*.db', '*.sqlite', '*.sqlite3', '*.log', 'node_modules')
$allowedDesktopFiles = @('main.js','vision.js','vision-ocr.ps1','vision-data.json','ui/index.html','ui/app.js','ui/styles.css')
foreach ($relative in $requiredDesktopFiles) {
    $file = Get-Item -LiteralPath (Join-Path $desktopSource $relative)
    $target = Join-Path $appStage (Join-Path 'desktop' $relative)
    $targetDir = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
}
foreach ($name in @('package.json','package-lock.json')) {
    $path = Join-Path $repo $name
    if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $appStage -Force }
}

$docs = Join-Path $repo 'packaging\README-Windows.md'
if (Test-Path -LiteralPath $docs) { Copy-Item -LiteralPath $docs -Destination (Join-Path $release 'README-Windows.md') -Force }
foreach ($license in @('LICENSE','THIRD-PARTY-NOTICES.md')) {
    $path = Join-Path $repo $license
    if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $release -Force }
}

if (-not (Test-Path -LiteralPath $nodeZip)) {
    $archiveUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
    Write-Host "Downloading official Node.js $NodeVersion Windows x64 archive..."
    Invoke-WebRequest -Uri $archiveUrl -OutFile $nodeZip
}
if (Test-Path -LiteralPath $nodeRoot) { Remove-Item -LiteralPath $nodeRoot -Recurse -Force }
New-Item -ItemType Directory -Path $nodeRoot | Out-Null
Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeRoot -Force
$officialNodeDir = Join-Path $nodeRoot "node-v$NodeVersion-win-x64"
$nodeExe = Join-Path $officialNodeDir 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) { throw "Official Node.js executable not found in archive: $nodeExe" }
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $runtimeStage 'node.exe') -Force
foreach ($file in @('LICENSE','LICENSE.txt','README.md')) {
    $path = Join-Path $officialNodeDir $file
    if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $runtimeStage -Force }
}
$SHASUMS = Join-Path $nodeRoot 'SHASUMS256.txt'
try {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile $SHASUMS
    $entry = Get-Content -LiteralPath $SHASUMS | Where-Object { $_ -match "\s+node-v$([regex]::Escape($NodeVersion))-win-x64\.zip$" } | Select-Object -First 1
    if (-not $entry) { throw 'The official Node.js checksum list omitted the requested archive.' }
    $expectedHash = ($entry -split '\s+')[0]
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeZip).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash.ToLowerInvariant()) { throw 'The downloaded Node.js archive SHA-256 does not match the official checksum.' }
} catch {
    throw "Could not verify the official Node.js archive: $($_.Exception.Message)"
}

# Preserve WebView2 SDK attribution/licenses as redistributable build materials.
$webViewPackage = Join-Path $env:USERPROFILE '.nuget\packages\microsoft.web.webview2\1.0.2903.40'
$webViewLicenseTarget = Join-Path $release 'third-party\WebView2'
if (Test-Path -LiteralPath $webViewPackage) {
    New-Item -ItemType Directory -Path $webViewLicenseTarget -Force | Out-Null
    foreach ($file in @('LICENSE.txt','NOTICE.txt')) {
        $path = Join-Path $webViewPackage $file
        if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $webViewLicenseTarget -Force }
    }
}
& $dotnetExe publish $launcherProject -c $Configuration -r $RuntimeIdentifier --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:IncludeAllContentForSelfExtract=true -p:EnableCompressionInSingleFile=true -p:IncludeSymbols=false -p:DebugType=None -o $release
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }
$exe = Join-Path $release 'D2Checkpoint.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Launcher binary was not produced: $exe" }
Get-ChildItem -LiteralPath $release -File -Filter '*.pdb' -Recurse | Remove-Item -Force
foreach ($relative in $requiredDesktopFiles) { if (-not (Test-Path -LiteralPath (Join-Path $appStage (Join-Path 'desktop' $relative)))) { throw "Staged desktop file is missing: $relative" } }
Write-Host "Windows x64 portable package staged at: $release"
Write-Host 'Contents include a self-contained .NET launcher, app/desktop service, and Node.js runtime.'
Write-Host 'WebView2 Runtime is required for the embedded Twitch viewing and screenshot capture workflow.'
