# Uv Link — downloads everything needed to build the Android TV .apk into
# %USERPROFILE%\.uvlink-build (nothing is installed system-wide):
#   - Eclipse Temurin JDK 17            (Adoptium)
#   - Android SDK command-line tools,   (Google) + platform android-35 + build-tools 35.0.0
#   - Gradle 8.11.1                     (gradle.org)
# Running it ACCEPTS THE ANDROID SDK LICENSE on your behalf.
# Safe to re-run: finished steps are skipped.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Join-Path $env:USERPROFILE '.uvlink-build'
$downloads = Join-Path $root 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

function Get-File([string]$url, [string]$out) {
  if (Test-Path $out) { Write-Host "  cached: $out"; return }
  Write-Host "  downloading $url"
  & curl.exe -L --fail --retry 3 --silent --show-error -o "$out.part" $url
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $url" }
  Move-Item "$out.part" $out
}

# 1. JDK 17 -------------------------------------------------------------
$jdk = Join-Path $root 'jdk-17'
if (-not (Test-Path "$jdk\bin\java.exe")) {
  Write-Host '[1/4] JDK 17'
  $zip = Join-Path $downloads 'temurin-jdk17-windows-x64.zip'
  Get-File 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse' $zip
  $extract = Join-Path $root 'jdk-extract'
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  tar -xf $zip -C $extract
  $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
  Move-Item $inner.FullName $jdk
  Remove-Item $extract -Recurse -Force
} else { Write-Host '[1/4] JDK 17 already present' }
$env:JAVA_HOME = $jdk

# 2. Android command-line tools ----------------------------------------
$sdk = Join-Path $root 'android-sdk'
$cmdline = Join-Path $sdk 'cmdline-tools\latest'
if (-not (Test-Path "$cmdline\bin\sdkmanager.bat")) {
  Write-Host '[2/4] Android command-line tools'
  $xml = (& curl.exe -sL --fail 'https://dl.google.com/android/repository/repository2-3.xml') -join "`n"
  $builds = [regex]::Matches($xml, 'commandlinetools-win-(\d+)_latest\.zip') |
    ForEach-Object { [int64]$_.Groups[1].Value } | Sort-Object -Descending -Unique
  if (-not $builds) { throw 'Could not find the command-line tools in Google''s repository index.' }
  $zip = Join-Path $downloads "commandlinetools-win-$($builds[0])_latest.zip"
  Get-File "https://dl.google.com/android/repository/commandlinetools-win-$($builds[0])_latest.zip" $zip
  $extract = Join-Path $sdk 'cmdline-extract'
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  tar -xf $zip -C $extract
  New-Item -ItemType Directory -Force -Path (Split-Path $cmdline) | Out-Null
  Move-Item (Join-Path $extract 'cmdline-tools') $cmdline
  Remove-Item $extract -Recurse -Force
} else { Write-Host '[2/4] Android command-line tools already present' }

# 3. SDK license + platform + build-tools --------------------------------
Write-Host '[3/4] Android SDK license, platform 35, build-tools 35.0.0'
$androidCli = "$cmdline\bin\android.exe"
if (Test-Path $androidCli) {
  # Command-line tools 23+: `android sdk` replaces sdkmanager. Package ids use '/'.
  # --no-metrics turns off Google's usage reporting for this tool.
  & $androidCli --no-metrics "--sdk=$sdk" sdk install 'platforms/android-35' 'build-tools/35.0.0'
  if ($LASTEXITCODE -ne 0) { throw 'android sdk install failed.' }
} else {
  # Older command-line tools. Package ids must be quoted: cmd splits arguments on ';'.
  $sdkmanager = "$cmdline\bin\sdkmanager.bat"
  cmd /c "(for /l %i in (1,1,40) do @echo y) | $sdkmanager --sdk_root=$sdk --licenses" | Select-Object -Last 2
  cmd /c "$sdkmanager --sdk_root=$sdk `"platforms;android-35`" `"build-tools;35.0.0`"" | Select-Object -Last 3
}
if (-not (Test-Path "$sdk\platforms\android-35\android.jar")) { throw 'Android platform 35 did not install.' }
if (-not (Test-Path "$sdk\build-tools\35.0.0")) { throw 'Android build-tools 35.0.0 did not install.' }

# 4. Gradle ---------------------------------------------------------------
$gradleVersion = '8.11.1'
$gradle = Join-Path $root "gradle-$gradleVersion"
if (-not (Test-Path "$gradle\bin\gradle.bat")) {
  Write-Host "[4/4] Gradle $gradleVersion"
  $zip = Join-Path $downloads "gradle-$gradleVersion-bin.zip"
  Get-File "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip" $zip
  tar -xf $zip -C $root
} else { Write-Host "[4/4] Gradle $gradleVersion already present" }

Write-Host ''
Write-Host "TOOLCHAIN READY in $root"
