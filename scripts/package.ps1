Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"

Push-Location $root
try {
  $vsceBin = Join-Path $root "node_modules\.bin\vsce.cmd"
  if (-not (Test-Path -LiteralPath $vsceBin)) {
    throw "Faltan dependencias. Ejecuta npm install antes de empaquetar."
  }

  npm test

  if (-not (Test-Path -LiteralPath $dist)) {
    New-Item -ItemType Directory -Path $dist | Out-Null
  }

  npx vsce package --allow-missing-repository --no-rewrite-relative-links --out $dist
}
finally {
  Pop-Location
}
