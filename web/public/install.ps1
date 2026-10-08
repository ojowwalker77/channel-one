# Installs kiwi, the Kiwi Init command line, for Windows.
#
# What it does, in order:
#   1. downloads the Windows build from this project's GitHub release, built from the public source
#   2. checks its SHA-256 against the release's SHA256SUMS before installing
#   3. puts it at ~\.kiwi\bin\kiwi.exe and adds that folder to your user PATH (no admin rights)
# Read the source: https://github.com/ojowwalker77/channels
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'ojowwalker77/channels'
$version = if ($env:KIWI_VERSION) { $env:KIWI_VERSION } else { 'latest' }
$asset = 'kiwi-windows-x64.exe'
$base = if ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" } else { "https://github.com/$repo/releases/download/$version" }
$dir = if ($env:KIWI_INSTALL) { $env:KIWI_INSTALL } else { Join-Path $HOME '.kiwi\bin' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("kiwi-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $asset ($version) from github.com/$repo"
  Invoke-WebRequest "$base/$asset" -OutFile "$tmp\kiwi.exe" -UseBasicParsing
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS" -UseBasicParsing
  $line = Get-Content "$tmp\SHA256SUMS" | Where-Object { $_ -match " $([regex]::Escape($asset))$" } | Select-Object -First 1
  $want = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
  $got = (Get-FileHash "$tmp\kiwi.exe" -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $want -ne $got) { throw "kiwi: checksum doesn't match the release; not installing" }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Move-Item -Force "$tmp\kiwi.exe" "$dir\kiwi.exe"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $dir)) {
  [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $dir), 'User')
  $env:Path = "$env:Path;$dir"
  Write-Host "Added $dir to your PATH (open a new terminal to use plain kiwi)."
}
Write-Host "Installed kiwi $(& "$dir\kiwi.exe" --version) at $dir\kiwi.exe (checksum verified)"
Write-Host "Check where it came from: gh attestation verify $dir\kiwi.exe --repo $repo"
