param(
  [string]$Editor = "code",
  [switch]$Build
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"

Push-Location $root
try {
  if ($Build -or -not (Test-Path -LiteralPath $dist)) {
    & (Join-Path $PSScriptRoot "package.ps1")
  }

  $vsix = Get-ChildItem -LiteralPath $dist -Filter "*.vsix" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $vsix) {
    throw "No se encontro ningun .vsix en $dist. Ejecuta npm run package primero."
  }

  & $Editor --install-extension $vsix.FullName --force
}
finally {
  Pop-Location
}
