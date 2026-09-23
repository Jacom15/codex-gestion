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
  $text = Get-Content -Raw -LiteralPath $Path -Encoding UTF8
  $updated = & $Edit $text
  if ($null -eq $updated) { throw "Edit returned null for $Path" }
  [System.IO.File]::WriteAllText($Path, $updated, (New-Object System.Text.UTF8Encoding($false)))
}

function Update-ReadmeLikeFile($Path, $OldVersion, $NewVersion) {
  Replace-InFile $Path {
    param($text)
    $text = $text.Replace("codex-gestion-$OldVersion.vsix", "codex-gestion-$NewVersion.vsix")
    $text = $text.Replace("version-$OldVersion-", "version-$NewVersion-")
    $text = $text.Replace("New in $OldVersion", "New in $NewVersion")
    $text = $text.Replace("Novedades de la $OldVersion", "Novedades de la $NewVersion")
    $text = $text.Replace("media/$OldVersion/", "media/$NewVersion/")
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

    if ($text -match '^# Changelog\r?\n\r?\n') {
      return "# Changelog`n`n" + $entry + ($text -replace '^# Changelog\r?\n\r?\n', '')
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
    Update-ReadmeLikeFile (Join-Path $root "RELEASES.md") $oldVersion $Version
    Update-Changelog (Join-Path $root "CHANGELOG.md") $Version $Notes
  }

  if ($SkipPackage) { Invoke-Checked "npm" @("test") }
  else { Invoke-Checked "npm" @("run", "package") }

  Write-Host "Release $Version prepared successfully."
}
finally {
  Pop-Location
}
