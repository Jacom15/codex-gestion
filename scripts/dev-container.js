'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const lockPath = path.join(root, 'package-lock.json');
const markerPath = path.join(root, 'node_modules', '.codex-gestion-lock-sha');
let preview = null;
let currentLockHash = null;
let dependencyRefreshRunning = false;

function fileHash(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function readMarker() {
  try {
    return fs.readFileSync(markerPath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeMarker(hash) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${hash}\n`, 'utf8');
}

function installDependenciesIfNeeded(force = false) {
  const hash = fileHash(lockPath);
  const nodeModulesExists = fs.existsSync(path.join(root, 'node_modules'));
  const marker = readMarker();
  if (!force && nodeModulesExists && hash && marker === hash) {
    currentLockHash = hash;
    return true;
  }

  console.log('[dev] Dependencies changed (or first run). Running npm ci...');
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, ['ci'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('[dev] npm ci failed. Preview was not restarted.');
    return false;
  }

  if (hash) writeMarker(hash);
  currentLockHash = hash;
  console.log('[dev] Dependencies are up to date.');
  return true;
}

function startPreview() {
  if (preview) return;
  console.log('[dev] Starting Codex Gestion preview...');
  preview = spawn(process.execPath, [path.join(root, 'scripts', 'preview.js')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PORT: process.env.PORT || '5177' }
  });
  preview.on('exit', (code, signal) => {
    const expectedStop = preview && preview.__stopping;
    preview = null;
    if (!expectedStop && !dependencyRefreshRunning) {
      console.error(`[dev] Preview stopped (${signal || code}). Restarting in 1 s...`);
      setTimeout(startPreview, 1000);
    }
  });
}

function stopPreview() {
  return new Promise(resolve => {
    if (!preview) return resolve();
    const child = preview;
    child.__stopping = true;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch { resolve(); }
  });
}

async function refreshDependencies() {
  if (dependencyRefreshRunning) return;
  dependencyRefreshRunning = true;
  try {
    await stopPreview();
    if (installDependenciesIfNeeded(true)) startPreview();
  } finally {
    dependencyRefreshRunning = false;
  }
}

if (!installDependenciesIfNeeded()) process.exit(1);
startPreview();

setInterval(() => {
  const nextHash = fileHash(lockPath);
  if (nextHash && currentLockHash && nextHash !== currentLockHash) {
    console.log('[dev] package-lock.json changed after git pull. Refreshing dependencies...');
    currentLockHash = nextHash;
    refreshDependencies().catch(error => console.error('[dev] Dependency refresh failed:', error));
  }
}, 1500).unref();

async function shutdown() {
  await stopPreview();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
