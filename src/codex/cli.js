const fs = require('fs');
const os = require('os');
const path = require('path');
const { CODEX_EXECUTABLE_NAMES } = require('../constants');

function fileExists(candidate) {
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findExecutableInDirectory(directory) {
  if (!directory) return null;
  for (const name of CODEX_EXECUTABLE_NAMES) {
    const candidate = path.join(directory, name);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function findCodexExecutable() {
  const pathEntries = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const entry of pathEntries) {
    const found = findExecutableInDirectory(entry);
    if (found) return found;
  }

  const extensionRoots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions')
  ];
  const platformFolders = process.platform === 'win32'
    ? ['windows-x86_64', 'windows-arm64']
    : process.platform === 'darwin'
      ? ['macos-aarch64', 'macos-x86_64']
      : ['linux-x86_64', 'linux-arm64'];

  for (const root of extensionRoots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((left, right) => {
      try {
        const leftTime = fs.statSync(path.join(root, left.name)).mtimeMs;
        const rightTime = fs.statSync(path.join(root, right.name)).mtimeMs;
        return rightTime - leftTime;
      } catch {
        return right.name.localeCompare(left.name);
      }
    })) {
      if (!entry.isDirectory() || !/^openai\.chatgpt-/i.test(entry.name)) continue;
      const extensionPath = path.join(root, entry.name);
      for (const platformFolder of platformFolders) {
        const found = findExecutableInDirectory(path.join(extensionPath, 'bin', platformFolder));
        if (found) return found;
      }
    }
  }

  return null;
}

function quoteForPowerShell(value) {
  return String(value).replace(/'/g, "''");
}

function quoteForPosixShell(value) {
  return String(value).replace(/'/g, "'\\''");
}

function buildCodexLoginCommand(executablePath) {
  if (!executablePath) return 'codex login';
  if (path.basename(executablePath).toLowerCase() === 'codex') return 'codex login';
  if (process.platform === 'win32') return `& '${quoteForPowerShell(executablePath)}' login`;
  return `'${quoteForPosixShell(executablePath)}' login`;
}

module.exports = {
  buildCodexLoginCommand,
  findCodexExecutable
};