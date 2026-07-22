param(
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version,

  [string[]]$Notes = @(),

  [switch]$SkipPackage
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"

function Invoke-Checked($FilePath, [string[]]$Arguments) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $FilePath $($Arguments -join ' ')"
  }
}

function Replace-InFile($Path, [scriptblock]$Edit) {
  $text = Get-Content -Raw -LiteralPath $Path
  $updated = & $Edit $text
  if ($null -eq $updated) { throw "Edit returned null for $Path" }
  Set-Content -LiteralPath $Path -Value $updated -NoNewline
}

function Update-ReadmeLikeFile($Path, $OldVersion, $NewVersion) {
  Replace-InFile $Path {
    param($text)
    $text = $text.Replace("codex-gestion-$OldVersion.vsix", "codex-gestion-$NewVersion.vsix")
    $text = $text.Replace("version-$OldVersion-", "version-$NewVersion-")
    $text = $text.Replace("New in $OldVersion", "New in $NewVersion")
    $text = $text.Replace("Nuevo en $OldVersion", "Nuevo en $NewVersion")
    return $text
  }
}

function Update-Changelog($Path, $NewVersion, [string[]]$ReleaseNotes) {
  Replace-InFile $Path {
    param($text)
    $date = Get-Date -Format 'yyyy-MM-dd'
    $heading = "## $NewVersion - $date"
    if ($text -match [regex]::Escape("## $NewVersion -")) { return $text }

    $notesToUse = @($ReleaseNotes | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (-not $notesToUse.Count) {
      $notesToUse = @("Prepared release $NewVersion.")
    }
    $body = ($notesToUse | ForEach-Object { "- $_" }) -join [Environment]::NewLine
    $entry = "$heading" + [Environment]::NewLine + [Environment]::NewLine + $body + [Environment]::NewLine + [Environment]::NewLine

    if ($text.StartsWith("# Changelog")) {
      $firstBreak = $text.IndexOf([Environment]::NewLine + [Environment]::NewLine)
      if ($firstBreak -ge 0) {
        return $text.Substring(0, $firstBreak + 2 * [Environment]::NewLine.Length) + $entry + $text.Substring($firstBreak + 2 * [Environment]::NewLine.Length)
      }
    }
    return "# Changelog" + [Environment]::NewLine + [Environment]::NewLine + $entry + $text
  }
}

function Update-PackageVersions($NewVersion) {
  $nodeScript = @(
    "const fs = require('fs');",
    "const version = process.argv[1];",
    "function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }",
    "const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));",
    "pkg.version = version;",
    "writeJson('package.json', pkg);",
    "const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));",
    "lock.version = version;",
    "if (lock.packages && lock.packages['']) lock.packages[''].version = version;",
    "writeJson('package-lock.json', lock);"
  ) -join [Environment]::NewLine
  Invoke-Checked "node" @("-e", $nodeScript, $NewVersion)
}

Push-Location $root
try {
  $oldVersion = (& node -e "process.stdout.write(require('./package.json').version)").Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($oldVersion)) {
    throw "Could not read current package version."
  }

  if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = $oldVersion
  }

  if ($oldVersion -eq $Version) {
    Write-Host "Version is already $Version. Keeping version files as-is."
  } else {
    Update-PackageVersions $Version
    Update-ReadmeLikeFile (Join-Path $root "README.md") $oldVersion $Version
    Update-ReadmeLikeFile (Join-Path $root "INSTALL.md") $oldVersion $Version
    Update-ReadmeLikeFile (Join-Path $root "PUBLISHING.md") $oldVersion $Version
    Update-Changelog (Join-Path $root "CHANGELOG.md") $Version $Notes
  }

  Invoke-Checked "npm" @("test")

  if (-not $SkipPackage) {
    $vsceBin = Join-Path $root "node_modules\.bin\vsce.cmd"
    if (-not (Test-Path -LiteralPath $vsceBin)) {
      throw "Missing dependencies. Run npm install before preparing a release."
    }
    if (-not (Test-Path -LiteralPath $dist)) {
      New-Item -ItemType Directory -Path $dist | Out-Null
    } else {
      Get-ChildItem -LiteralPath $dist -Filter '*.vsix' -File | Remove-Item -Force
    }
    Invoke-Checked $vsceBin @('package', '--allow-missing-repository', '--no-rewrite-relative-links', '--out', $dist)
    $vsix = Join-Path $dist "codex-gestion-$Version.vsix"
    if (-not (Test-Path -LiteralPath $vsix)) {
      throw "Expected VSIX was not created: $vsix"
    }
    $item = Get-Item -LiteralPath $vsix
    Write-Host "Release package ready: $($item.FullName) ($($item.Length) bytes)"
  }

  Write-Host "Release $Version prepared successfully."
}
finally {
  Pop-Location
}