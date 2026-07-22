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
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  if (-not (Test-Path -LiteralPath $dist)) {
    New-Item -ItemType Directory -Path $dist | Out-Null
  }

  & $vsceBin package --allow-missing-repository --no-rewrite-relative-links --no-dependencies --out $dist
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
  Pop-Location
}
