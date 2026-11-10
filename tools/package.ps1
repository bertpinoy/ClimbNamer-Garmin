# Builds the upload zip for the Chrome Web Store:
#   dist/ClimbNamer-Garmin-<version>.zip   (manifest.json at the root of the zip)
# Run from anywhere:  powershell -File tools/package.ps1
# Entry names are written with forward slashes (the stores reject backslash paths).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root 'extension'
$manifest = Get-Content (Join-Path $ext 'manifest.json') -Raw | ConvertFrom-Json
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$zipPath = Join-Path $dist ("ClimbNamer-Garmin-{0}.zip" -f $manifest.version)
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  Get-ChildItem $ext -Recurse -File | ForEach-Object {
    $name = $_.FullName.Substring($ext.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name, 'Optimal') | Out-Null
  }
} finally {
  $zip.Dispose()
}
Write-Output "Created $zipPath"
