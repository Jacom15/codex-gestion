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

  $version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $vsixPath = Join-Path $dist "codex-gestion-$version.vsix"

  if (-not (Test-Path -LiteralPath $vsixPath)) {
    throw "No se encontro ningun .vsix en $dist. Ejecuta npm run package primero."
  }

  & $Editor --install-extension $vsixPath --force
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
  Pop-Location
}
