Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"

if (Test-Path -LiteralPath $dist) {
  Remove-Item -LiteralPath $dist -Recurse -Force
}

Get-ChildItem -LiteralPath $root -Filter "*.vsix" -File | Remove-Item -Force
Get-ChildItem -LiteralPath $root -Filter "*.log" -File | Remove-Item -Force
