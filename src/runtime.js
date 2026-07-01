const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const {
  ACCOUNT_PROFILES_KEY,
  ACTIVE_ACCOUNT_KEY,
  ACTIVE_ACCOUNT_SINCE_KEY,
  ACTIVE_SESSION_MS,
  AUTH_CHECK_TIMEOUT_MS,
  AUTH_MISSING_GRACE_MS,
  AUTH_PATH,
  AUTH_STATUS_MAX_AGE_MS,
  AUTH_WATCH_DEBOUNCE_MS,
  CODEX_REOPEN_DELAY_MS,
  GLOBAL_SCAN_LIMIT,
  LEGACY_ACTIVE_ACCOUNT_ID_KEY,
  LOGIN_WATCH_TIMEOUT_MS,
  MAX_ACCOUNT_PROFILES,
  POST_SWITCH_REFRESH_DELAYS_MS,
  PROJECT_CONTEXT_DIR,
  PROJECT_CONTEXT_END,
  PROJECT_CONTEXT_FILE,
  PROJECT_CONTEXT_START,
  SESSION_ROOT,
  SWITCH_ACCOUNT_GUARD_MS,
} = require('./constants');
const {
  availablePercent,
  clampPercent,
  escapeHtml,
  escapeMarkdown,
  finiteNumber,
  formatNumber,
  formatPercent,
  formatResetFull,
  formatResetMoment,
  getContextPercent,
  getUsageAdvice,
  windowLabel
} = require('./utils/format');
const {
  accountFromAuthPayload,
  accountProfileId,
  accountSecretKey,
  summarizeAuthFailure
} = require('./auth/accounts');
const {
  getSessionFiles,
  parseLatestStats,
  rateLimitFingerprint,
  readSessionMeta
} = require('./sessions/reader');
const { buildCodexLoginCommand, findCodexExecutable } = require('./codex/cli');
let latestStats = null;
let refreshTimer = null;
let authWatchTimer = null;
let sessionWatcher = null;
let sessionWatchTimer = null;
let pendingLoginWatcher = null;
let refreshPromise = null;
let pendingRefreshNotification = false;
let accountProfileWrite = Promise.resolve();
let statusItem = null;
let extensionContext = null;
let outputChannel = null;
let latestError = null;
let dashboardPanel = null;
let lastDashboardSignature = '';
const AUTO_SWITCH_RELOAD_DELAY_MS = 2500;
let lastRefreshDurationMs = 0;
let lastRefreshAt = 0;
let lastKnownAccount = null;
let authUnavailableSince = 0;
let activeSwitchGuard = null;
const credentialHashes = new Map();

let latestAuthStatus = {
  state: 'unknown',
  checkedAt: 0,
  message: 'Sesion no comprobada todavia.'
};
let postSwitchRefreshTimers = [];

function normalizeFsPath(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readCurrentAccount() {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
    const account = accountFromAuthPayload(auth);
    if (account.hasCredentials) {
      lastKnownAccount = account;
      authUnavailableSince = 0;
      return account;
    }

    if (lastKnownAccount) {
      if (!authUnavailableSince) authUnavailableSince = Date.now();
      if (Date.now() - authUnavailableSince < AUTH_MISSING_GRACE_MS) {
        return { ...lastKnownAccount, transient: true };
      }
    }

    lastKnownAccount = null;
    authUnavailableSince = 0;
    return account;
  } catch {
    if (lastKnownAccount) {
      if (!authUnavailableSince) authUnavailableSince = Date.now();
      if (Date.now() - authUnavailableSince < AUTH_MISSING_GRACE_MS) {
        return { ...lastKnownAccount, transient: true };
      }
    }
    lastKnownAccount = null;
    return { id: '', mode: 'unknown', hasCredentials: false };
  }
}

function readCurrentAuthPayload() {
  const raw = fs.readFileSync(AUTH_PATH, 'utf8');
  const payload = JSON.parse(raw);
  const account = accountFromAuthPayload(payload);
  if (!account.hasCredentials) {
    throw new Error('El archivo de sesion de Codex no contiene credenciales validas.');
  }
  return { payload, account };
}

function clearAccountSwitchGuard(profileId = '') {
  if (!activeSwitchGuard) return;
  if (profileId && activeSwitchGuard.profileId !== profileId) return;
  activeSwitchGuard = null;
}

function armAccountSwitchGuard(profileId, payload, label = '') {
  activeSwitchGuard = {
    profileId,
    payload,
    label,
    expiresAt: Date.now() + SWITCH_ACCOUNT_GUARD_MS,
    rewrites: 0,
    notified: false
  };
}

function enforceAccountSwitchGuard(authPath = AUTH_PATH, notify = true) {
  if (!activeSwitchGuard || pendingLoginWatcher) return false;
  if (Date.now() > activeSwitchGuard.expiresAt) {
    activeSwitchGuard = null;
    return false;
  }

  let currentAccount = null;
  try {
    const currentPayload = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    currentAccount = accountFromAuthPayload(currentPayload);
  } catch {
    currentAccount = null;
  }

  if (currentAccount?.hasCredentials && accountProfileId(currentAccount) === activeSwitchGuard.profileId) {
    return false;
  }

  writeAuthPayloadAtomic(activeSwitchGuard.payload, authPath);
  activeSwitchGuard.rewrites += 1;
  lastKnownAccount = null;
  authUnavailableSince = 0;
  latestAuthStatus = {
    state: 'skipped',
    checkedAt: Date.now(),
    message: 'He protegido la cuenta activa porque Codex intento restaurar otra sesion local.'
  };

  if (notify && !activeSwitchGuard.notified) {
    activeSwitchGuard.notified = true;
    vscode.window?.showWarningMessage?.(
      activeSwitchGuard.label
        ? `Codex intento volver a otra cuenta. Mantengo activa: ${activeSwitchGuard.label}.`
        : 'Codex intento volver a otra cuenta. Mantengo activa la cuenta seleccionada.'
    );
  }

  return true;
}

function writeAuthPayloadAtomic(payload, authPath = AUTH_PATH) {
  const directory = path.dirname(authPath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `auth.json.tmp.${process.pid}.${Date.now()}`);
  const backupPath = path.join(directory, `auth.json.backup.${process.pid}.${Date.now()}`);
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });

  try {
    if (fs.existsSync(authPath)) fs.copyFileSync(authPath, backupPath);
    try {
      fs.renameSync(tempPath, authPath);
    } catch {
      fs.copyFileSync(tempPath, authPath);
    }
  } catch (error) {
    if (fs.existsSync(backupPath)) fs.copyFileSync(backupPath, authPath);
    throw error;
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    } catch {
      // Best effort cleanup after replacing auth.json.
    }
  }
}

function clearAuthPayload(authPath = AUTH_PATH) {
  const directory = path.dirname(authPath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `auth.json.clear.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tempPath, '{}\n', { encoding: 'utf8', mode: 0o600 });
  try {
    try {
      fs.renameSync(tempPath, authPath);
    } catch {
      fs.copyFileSync(tempPath, authPath);
    }
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Best effort cleanup.
    }
  }
}

async function storeCurrentCredentials() {
  if (!extensionContext?.secrets) return null;

  let current;
  try {
    current = readCurrentAuthPayload();
  } catch {
    return null;
  }

  const profileId = accountProfileId(current.account);
  const serialized = JSON.stringify(current.payload);
  const hash = crypto.createHash('sha256').update(serialized).digest('hex');
  if (credentialHashes.get(profileId) !== hash) {
    await extensionContext.secrets.store(accountSecretKey(profileId), serialized);
    credentialHashes.set(profileId, hash);
  }
  return profileId;
}

async function importCurrentCredentialsIfChanged(previousProfileId = '') {
  const storedProfileId = await storeCurrentCredentials();
  if (!storedProfileId || storedProfileId === previousProfileId) return null;
  await refresh(false);
  const profile = getAccountProfiles().find(candidate => candidate.id === storedProfileId);
  vscode.window.showInformationMessage(
    `Cuenta agregada: ${profile?.label || 'nueva cuenta de Codex'}. Ya puedes cambiar entre cuentas.`
  );
  return storedProfileId;
}

function startLoginWatcher(previousProfileId) {
  if (pendingLoginWatcher) {
    clearInterval(pendingLoginWatcher.interval);
    clearTimeout(pendingLoginWatcher.timeout);
  }

  const check = async () => {
    const imported = await importCurrentCredentialsIfChanged(previousProfileId);
    if (imported) stopLoginWatcher();
  };
  pendingLoginWatcher = {
    previousProfileId,
    interval: setInterval(() => void check(), 2000),
    timeout: setTimeout(() => {
      stopLoginWatcher();
      vscode.window.showWarningMessage(
        'No he detectado una cuenta nueva todavia. Completa el login y pulsa Actualizar.'
      );
    }, LOGIN_WATCH_TIMEOUT_MS)
  };
}

function stopLoginWatcher() {
  if (!pendingLoginWatcher) return;
  clearInterval(pendingLoginWatcher.interval);
  clearTimeout(pendingLoginWatcher.timeout);
  pendingLoginWatcher = null;
}

function runCodexLoginStatus(timeoutMs = AUTH_CHECK_TIMEOUT_MS) {
  return new Promise(resolve => {
    const executable = findCodexExecutable() || 'codex';
    try {
      execFile(executable, ['login', 'status'], {
        timeout: timeoutMs,
        windowsHide: true
      }, (error, stdout, stderr) => {
        const output = `${stdout || ''}\n${stderr || ''}`;
        if (!error) {
          resolve({ ok: true, output });
          return;
        }

        if (error.code === 'ENOENT') {
          resolve({
            ok: true,
            skipped: true,
            output: 'codex command not found; skipped validation',
            reason: 'No encuentro el ejecutable de Codex para comprobar la sesion.'
          });
          return;
        }

        resolve({
          ok: false,
          output,
          reason: summarizeAuthFailure(output, error)
        });
      });
    } catch (error) {
      resolve({
        ok: true,
        skipped: true,
        output: error.message || String(error),
        reason: `No pude comprobar la sesion de Codex: ${error.message || String(error)}`
      });
    }
  });
}

async function validateAuthStatus(force = false) {
  const account = readCurrentAccount();
  if (!account.hasCredentials) {
    latestAuthStatus = {
      state: 'missing',
      checkedAt: Date.now(),
      message: 'No hay credenciales activas en auth.json.'
    };
    return latestAuthStatus;
  }

  if (
    !force &&
    latestAuthStatus.checkedAt &&
    Date.now() - latestAuthStatus.checkedAt < AUTH_STATUS_MAX_AGE_MS
  ) {
    return latestAuthStatus;
  }

  const validation = await runCodexLoginStatus();
  latestAuthStatus = {
    state: validation.skipped ? 'skipped' : validation.ok ? 'ok' : 'invalid',
    checkedAt: Date.now(),
    message: validation.skipped
      ? validation.reason
      : validation.ok
        ? 'Sesion validada por Codex CLI.'
        : validation.reason
  };
  return latestAuthStatus;
}

async function markProfileCredentialsStored(profileId, stored) {
  await updateAccountProfiles(current => current.map(profile =>
    profile.id === profileId ? { ...profile, credentialsStored: stored } : profile
  ));
  if (!stored) credentialHashes.delete(profileId);
}

function resolveAccountTracking(accountKey, savedKey, since, initialized, now = Date.now()) {
  if (!initialized) {
    return { accountKey, since, changed: false };
  }
  if (accountKey === savedKey) {
    return { accountKey, since, changed: false };
  }
  return { accountKey, since: now, changed: true };
}

function statsCutoffForAccount(accountSince, expectedRateLimitFingerprint) {
  return expectedRateLimitFingerprint ? 0 : accountSince;
}

async function getAccountState() {
  const account = readCurrentAccount();
  const accountKey = account.hasCredentials ? accountProfileId(account) : '';
  const storedKey = extensionContext.globalState.get(ACTIVE_ACCOUNT_KEY);
  const legacyId = extensionContext.globalState.get(LEGACY_ACTIVE_ACCOUNT_ID_KEY);
  const initialized = storedKey !== undefined || legacyId !== undefined;
  const savedKey = storedKey !== undefined
    ? storedKey
    : legacyId && account.id === legacyId
      ? accountKey
      : '';
  const tracking = resolveAccountTracking(
    accountKey,
    savedKey,
    extensionContext.globalState.get(ACTIVE_ACCOUNT_SINCE_KEY, 0),
    initialized
  );

  if (storedKey !== tracking.accountKey) {
    await extensionContext.globalState.update(ACTIVE_ACCOUNT_KEY, tracking.accountKey);
  }
  if (tracking.changed) {
    await extensionContext.globalState.update(ACTIVE_ACCOUNT_SINCE_KEY, tracking.since);
  }

  return { ...account, since: tracking.since };
}

function getAccountProfiles() {
  return extensionContext.globalState.get(ACCOUNT_PROFILES_KEY, []);
}

function updateAccountProfiles(mutator) {
  accountProfileWrite = accountProfileWrite.catch(() => undefined).then(async () => {
    const current = getAccountProfiles();
    const next = mutator(current);
    await extensionContext.globalState.update(ACCOUNT_PROFILES_KEY, next);
    return next;
  });
  return accountProfileWrite;
}

function mergeAccountSnapshot(existingSnapshot, stats) {
  const existing = existingSnapshot || {};
  if (!stats) return existing;
  return {
    primaryUsed: stats.rateLimits?.primary?.used_percent ?? existing.primaryUsed ?? null,
    secondaryUsed: stats.rateLimits?.secondary?.used_percent ?? existing.secondaryUsed ?? null,
    primaryResetsAt: stats.rateLimits?.primary?.resets_at ?? existing.primaryResetsAt ?? null,
    secondaryResetsAt: stats.rateLimits?.secondary?.resets_at ?? existing.secondaryResetsAt ?? null,
    primaryWindowMinutes: stats.rateLimits?.primary?.window_minutes ?? existing.primaryWindowMinutes ?? null,
    secondaryWindowMinutes: stats.rateLimits?.secondary?.window_minutes ?? existing.secondaryWindowMinutes ?? null,
    plan: stats.rateLimits?.plan_type || existing.plan || null,
    contextUsed: getContextPercent(stats) ?? existing.contextUsed ?? null,
    rateLimitFingerprint: stats.rateLimitFingerprint || existing.rateLimitFingerprint || '',
    timestamp: stats.isSnapshotFallback
      ? existing.timestamp || stats.timestamp || null
      : stats.timestamp || existing.timestamp || null
  };
}

function statsFromProfileSnapshot(profile) {
  const snapshot = profile?.snapshot || {};
  const hasPrimary = finiteNumber(snapshot.primaryUsed) !== null;
  const hasSecondary = finiteNumber(snapshot.secondaryUsed) !== null;
  const hasContext = finiteNumber(snapshot.contextUsed) !== null;
  if (!hasPrimary && !hasSecondary && !hasContext && !snapshot.plan) return null;

  const primary = hasPrimary ? {
    used_percent: snapshot.primaryUsed,
    resets_at: snapshot.primaryResetsAt ?? null,
    window_minutes: snapshot.primaryWindowMinutes ?? 300
  } : null;
  const secondary = hasSecondary ? {
    used_percent: snapshot.secondaryUsed,
    resets_at: snapshot.secondaryResetsAt ?? null,
    window_minutes: snapshot.secondaryWindowMinutes ?? 10080
  } : null;

  return {
    timestamp: snapshot.timestamp || profile.lastSeen || Date.now(),
    sessionFile: null,
    contextSessionFile: null,
    totalTokenUsage: null,
    lastTokenUsage: null,
    modelContextWindow: null,
    contextPercent: hasContext ? snapshot.contextUsed : null,
    contextSource: 'snapshot',
    contextUpdatedAt: snapshot.timestamp || profile.lastSeen || Date.now(),
    contextSessionId: '',
    rateLimits: {
      plan_type: snapshot.plan || null,
      primary,
      secondary
    },
    rateLimitFingerprint: snapshot.rateLimitFingerprint || '',
    activeSessions: 0,
    isSnapshotFallback: true,
    accountLabel: profile.label
  };
}

function accountDisplayLabel(account) {
  if (account?.label) return account.label;
  if (account?.email) return account.email;
  if (account?.name) return account.name;
  if (account?.id) return `${account.mode} (...${account.id.slice(-6)})`;
  return account?.mode || 'Cuenta de Codex';
}

function planDisplay(stats) {
  const plan = stats?.rateLimits?.plan_type
    ? String(stats.rateLimits.plan_type).toUpperCase()
    : 'Pendiente';
  if (!stats) return { label: plan, detail: 'sin datos locales' };
  if (stats.isSnapshotFallback) return { label: plan, detail: 'resumen guardado' };
  return { label: plan, detail: 'dato local observado' };
}

function statsBelongsToAnotherProfile(profileId, profiles, stats) {
  if (!stats || stats.isSnapshotFallback || !stats.rateLimitFingerprint) return false;
  return profiles.some(profile =>
    profile.id !== profileId &&
    profile.snapshot?.rateLimitFingerprint === stats.rateLimitFingerprint
  );
}

async function rememberAccount(account, stats) {
  if (!account.hasCredentials) return;

  const profileId = accountProfileId(account);
  const storedProfileId = await storeCurrentCredentials();
  await updateAccountProfiles(profiles => {
    const existing = profiles.find(profile => profile.id === profileId);
    const defaultLabel = accountDisplayLabel(account);
    const snapshot = mergeAccountSnapshot(existing?.snapshot, stats);
    const updated = {
      id: profileId,
      label: existing?.label || defaultLabel,
      mode: account.mode,
      email: account.email || existing?.email || '',
      name: account.name || existing?.name || '',
      accountSuffix: account.id ? account.id.slice(-6) : '',
      lastSeen: Date.now(),
      credentialsStored: existing?.credentialsStored || storedProfileId === profileId,
      snapshot
    };
    const fingerprint = snapshot.rateLimitFingerprint || '';
    const rest = profiles
      .filter(profile => profile.id !== profileId)
      .map(profile =>
        fingerprint && profile.snapshot?.rateLimitFingerprint === fingerprint
          ? { ...profile, snapshot: {} }
          : profile
      );
    return [
      updated,
      ...rest
    ].slice(0, MAX_ACCOUNT_PROFILES);
  });
}

function collectStats(cutoffMs, expectedRateLimitFingerprint = '') {
  const files = getSessionFiles(SESSION_ROOT, cutoffMs) || [];
  const workspaceRoots = (vscode.workspace.workspaceFolders || [])
    .map(folder => normalizeFsPath(folder.uri.fsPath));
  const now = Date.now();
  let newestGlobal = null;
  let newestWorkspace = null;
  const parsedStats = new Map();

  // Rate limits are account-wide, so only inspect a small set of recent files.
  for (const file of files.slice(0, GLOBAL_SCAN_LIMIT)) {
    const stats = parseLatestStats(file.path, expectedRateLimitFingerprint);
    if (!stats) continue;

    const eventTime = Date.parse(stats.timestamp) || file.mtimeMs;
    if (eventTime < cutoffMs) continue;
    parsedStats.set(file.path, stats);
    if (!newestGlobal || eventTime > newestGlobal.eventTime) {
      newestGlobal = { ...stats, eventTime };
    }
  }

  if (!newestGlobal) {
    for (const file of files.slice(GLOBAL_SCAN_LIMIT)) {
      const stats = parseLatestStats(file.path, expectedRateLimitFingerprint);
      if (!stats) continue;
      const eventTime = Date.parse(stats.timestamp) || file.mtimeMs;
      if (eventTime < cutoffMs) continue;
      parsedStats.set(file.path, stats);
      newestGlobal = {
        ...stats,
        eventTime
      };
      break;
    }
  }

  // Context is workspace-specific. Read cheap session headers first and only
  // parse the tail when the session belongs to the current workspace.
  for (const file of files) {
    const meta = readSessionMeta(file.path);
    const sessionCwd = normalizeFsPath(meta?.cwd);
    if (!sessionCwd || !workspaceRoots.some(root => isPathInside(sessionCwd, root))) continue;

    const stats = parsedStats.get(file.path) || parseLatestStats(file.path, expectedRateLimitFingerprint);
    if (!stats) continue;
    const eventTime = Date.parse(stats.timestamp) || file.mtimeMs;
    if (eventTime < cutoffMs) continue;
    newestWorkspace = { ...stats, eventTime, workspaceMatched: true };
    break;
  }

  if (!newestGlobal) return null;

  const contextStats = newestWorkspace || newestGlobal;
  return {
    ...newestGlobal,
    lastTokenUsage: contextStats.lastTokenUsage,
    modelContextWindow: contextStats.modelContextWindow,
    contextSource: newestWorkspace ? 'workspace' : 'global',
    contextUpdatedAt: contextStats.timestamp || contextStats.eventTime || newestGlobal.timestamp,
    contextSessionId: contextStats.sessionId || '',
    contextSessionFile: contextStats.sessionFile,
    activeSessions: files.filter(file => now - file.mtimeMs <= ACTIVE_SESSION_MS).length
  };
}

function buildTooltip(stats) {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = {
    enabledCommands: [
      'codexGestion.showDashboard',
      'codexGestion.refresh'
    ]
  };
  tooltip.supportHtml = true;
  const rateLimits = stats.rateLimits;
  const primary = rateLimits?.primary;
  const secondary = rateLimits?.secondary;
  const accountLabel = stats.accountLabel || 'Cuenta de Codex';
  const planInfo = planDisplay(stats);
  const updatedAt = new Date(lastRefreshAt || Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

  tooltip.appendMarkdown(
    `### $(account) ${escapeMarkdown(accountLabel)}\n\n` +
    `<sub>Plan local ${escapeHtml(planInfo.label)}</sub>\n\n` +
    `[$(dashboard) Abrir panel](command:codexGestion.showDashboard) &nbsp;&nbsp; ` +
    `[$(refresh) Actualizar](command:codexGestion.refresh)\n\n` +
    '---\n\n'
  );

  if (latestAuthStatus.state !== 'ok') {
    tooltip.appendMarkdown(
      `$(warning) **Sesion:** ${escapeMarkdown(latestAuthStatus.message || latestAuthStatus.state)}\n\n`
    );
  }

  tooltip.appendMarkdown(formatTooltipQuota('Cuota 5 h', primary));
  tooltip.appendMarkdown('---\n\n');
  tooltip.appendMarkdown(formatTooltipQuota('Cuota 7 dias', secondary));
  tooltip.appendMarkdown('---\n\n');
  tooltip.appendMarkdown(
    `<sub>Actualizado ${escapeHtml(updatedAt)} ` +
    `${stats.isSnapshotFallback ? '&nbsp;|&nbsp; resumen guardado ' : ''}` +
    `&nbsp;|&nbsp; Codex Gestion v${escapeHtml(extensionContext.extension.packageJSON.version)}</sub>`
  );
  return tooltip;
}

function formatTooltipQuota(label, limit) {
  const used = finiteNumber(limit?.used_percent);
  const usedPercent = used === null ? null : clampPercent(used);
  const available = usedPercent === null ? null : 100 - usedPercent;
  const resetLabel = limit ? formatResetMoment(limit.resets_at) : 'Sin datos';

  if (usedPercent === null || available === null) {
    return (
      `**${escapeMarkdown(label)}** &nbsp; <sub>Renueva ${escapeMarkdown(resetLabel)}</sub>\n\n` +
      '<sub>Sin lectura visual todavia</sub>\n\n'
    );
  }

  return (
    tooltipQuotaCard(label, usedPercent, available, resetLabel) +
    `\n\n<sub>${escapeHtml(Math.round(usedPercent))}% usado &nbsp;|&nbsp; ${escapeHtml(Math.round(available))}% libre</sub>\n\n`
  );
}

function tooltipQuotaCard(label, usedPercent, availablePercentValue, resetLabel) {
  const used = Math.round(clampPercent(usedPercent));
  const available = Math.max(0, 100 - used);
  const tone = used >= 90 ? '#f48771' : used >= 75 ? '#cca700' : '#4ec9b0';
  const width = 244;
  const height = 86;
  const trackWidth = 212;
  const fillWidth = Math.max(4, Math.round((available / 100) * trackWidth));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" fill="#252526" stroke="#3c3c3c"/>
      <text x="14" y="23" fill="#f3f3f3" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700">${escapeHtml(label)}</text>
      <text x="230" y="23" fill="#a6a6a6" font-family="Segoe UI, Arial, sans-serif" font-size="10" text-anchor="end">${escapeHtml(resetLabel)}</text>
      <rect x="14" y="38" width="${trackWidth}" height="13" rx="6.5" fill="#3a3a3a"/>
      <rect x="14" y="38" width="${fillWidth}" height="13" rx="6.5" fill="${tone}"/>
      <text x="14" y="70" fill="#a6a6a6" font-family="Segoe UI, Arial, sans-serif" font-size="11">${escapeHtml(used)}% usado</text>
      <text x="230" y="70" fill="#f3f3f3" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="700" text-anchor="end">${escapeHtml(available)}% libre</text>
    </svg>`;
  const encoded = Buffer.from(svg, 'utf8').toString('base64');
  return `<img src="data:image/svg+xml;base64,${encoded}" alt="${escapeHtml(label)}: ${escapeHtml(available)}% libre" width="${width}" height="${height}">`;
}

function tooltipQuotaBar(usedPercent, availablePercentValue) {
  if (usedPercent === null || availablePercentValue === null) {
    return '<sub>Sin lectura visual todavia</sub>';
  }

  const used = Math.round(clampPercent(usedPercent));
  const available = Math.max(0, 100 - used);
  const totalSegments = 16;
  const availableSegments = Math.max(0, Math.min(totalSegments, Math.round((available / 100) * totalSegments)));
  const usedSegments = totalSegments - availableSegments;
  const bar = '#'.repeat(availableSegments) + '-'.repeat(usedSegments);

  return (
    `<code>[${bar}]</code> &nbsp; **${escapeHtml(available)}% libre**\n\n` +
    `<sub>${escapeHtml(used)}% usado</sub>`
  );
}

function buildEmptyTooltip() {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = {
    enabledCommands: [
      'codexGestion.showDashboard',
      'codexGestion.refresh',
      'codexGestion.openCodex',
      'codexGestion.showDiagnostics'
    ]
  };
  tooltip.supportHtml = true;
  tooltip.appendMarkdown('### $(account) Codex Gestion\n\n');
  tooltip.appendMarkdown(
    latestError
      ? `$(error) **No se pudo leer el uso**  \n${escapeMarkdown(latestError.message)}\n\n`
      : '$(info) **Todavia no hay datos de uso**  \nAbre Codex o inicia una conversacion para comenzar.\n\n'
  );
  tooltip.appendMarkdown(
    '[$(sign-in) Abrir Codex](command:codexGestion.openCodex) &nbsp; ' +
    '[$(refresh) Actualizar](command:codexGestion.refresh) &nbsp; ' +
    '[$(dashboard) Abrir panel](command:codexGestion.showDashboard)'
  );
  if (latestError) {
    tooltip.appendMarkdown(
      '\n\n[$(output) Diagnostico](command:codexGestion.showDiagnostics)'
    );
  }
  return tooltip;
}

function updateStatusBar(stats) {
  const authProblem = latestAuthStatus.state === 'invalid' || latestAuthStatus.state === 'missing';
  if (!stats) {
    statusItem.text = latestError
      ? '$(warning) Error de Codex Stats'
      : authProblem
        ? '$(warning) Codex sin sesion'
        : '$(pulse) Codex sin datos';
    statusItem.tooltip = buildEmptyTooltip();
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusItem.show();
    return;
  }

  const primary = stats.rateLimits?.primary;
  const pieces = [];

  const primaryAvailable = availablePercent(primary?.used_percent);
  if (primaryAvailable !== null) {
    pieces.push(`$(dashboard) 5h ${formatPercent(primaryAvailable)} libre`);
  }
  else pieces.push('$(pulse) Codex');

  statusItem.text = pieces.join(' | ');
  statusItem.tooltip = buildTooltip(stats);
  statusItem.accessibilityInformation = {
    label: `Uso de Codex: ${pieces.join(', ')}. Pulsa para abrir el panel completo.`
  };
  statusItem.backgroundColor =
    authProblem
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : Number(primary?.used_percent) >= 90
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : Number(primary?.used_percent) >= 75
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
  statusItem.show();
}

async function performRefresh(showNotification) {
  const startedAt = Date.now();
  try {
    await enforceAccountSwitchGuard();
    const account = await getAccountState();
    await validateAuthStatus(showNotification);
    const profileId = account.hasCredentials ? accountProfileId(account) : '';
    const profiles = getAccountProfiles();
    const activeProfile = account.hasCredentials
      ? profiles.find(candidate => candidate.id === profileId)
      : null;
    const expectedFingerprint = activeProfile?.snapshot?.rateLimitFingerprint || '';
    latestStats = collectStats(statsCutoffForAccount(account.since, expectedFingerprint), expectedFingerprint);
    if (latestStats && statsBelongsToAnotherProfile(profileId, profiles, latestStats)) {
      latestStats = null;
    }
    if (!latestStats && !expectedFingerprint) {
      latestStats = collectStats(account.since);
      if (latestStats && statsBelongsToAnotherProfile(profileId, profiles, latestStats)) {
        latestStats = null;
      }
    }
    if (!latestStats && !expectedFingerprint) {
      latestStats = collectStats(0);
      if (latestStats && statsBelongsToAnotherProfile(profileId, profiles, latestStats)) {
        latestStats = null;
      }
    }
    if (!latestStats && activeProfile) {
      latestStats = statsFromProfileSnapshot(activeProfile);
    }
    latestError = null;
    await rememberAccount(account, latestStats);
    if (latestStats) {
      const profile = account.hasCredentials
        ? getAccountProfiles().find(candidate => candidate.id === accountProfileId(account))
        : null;
      latestStats.accountLabel = profile?.label || accountDisplayLabel(account);
    }
  } catch (error) {
    latestStats = null;
    latestError = error instanceof Error ? error : new Error(String(error));
  } finally {
    lastRefreshDurationMs = Date.now() - startedAt;
    lastRefreshAt = Date.now();
    updateStatusBar(latestStats);
    updateDashboard();
    void refreshProjectContextIfPresent('refresh');
  }

  if (showNotification) {
    if (!latestStats) {
      await showRecovery();
    } else {
      const message = latestStats.isSnapshotFallback
        ? 'Mostrando el ultimo resumen guardado hasta que Codex genere datos nuevos.'
        : latestAuthStatus.state === 'invalid'
        ? latestAuthStatus.message
        : latestStats.rateLimits?.primary
        ? `Datos actualizados: ${formatPercent(availablePercent(latestStats.rateLimits.primary.used_percent))} disponible en la cuota de 5 h.`
        : 'Datos actualizados, pero las cuotas no estan disponibles.';
      vscode.window.showInformationMessage(message);
    }
  }
}

function refresh(showNotification = false) {
  if (refreshPromise) {
    pendingRefreshNotification = pendingRefreshNotification || showNotification;
    return refreshPromise;
  }

  refreshPromise = performRefresh(showNotification).finally(() => {
    refreshPromise = null;
    if (pendingRefreshNotification) {
      pendingRefreshNotification = false;
      void refresh(true);
    }
  });
  return refreshPromise;
}

async function openCodex() {
  const commands = await vscode.commands.getCommands(true);
  if (commands.includes('chatgpt.openSidebar')) {
    await vscode.commands.executeCommand('chatgpt.openSidebar');
    return;
  }

  const action = await vscode.window.showWarningMessage(
    'La extension oficial de Codex no esta disponible. Instala o activa la extension para iniciar sesion.',
    'Buscar extension de Codex'
  );
  if (action === 'Buscar extension de Codex') {
    await vscode.commands.executeCommand('workbench.extensions.search', '@id:openai.chatgpt');
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function closeCodexSurface() {
  const commands = await vscode.commands.getCommands(true);
  const closeCandidates = [
    'chatgpt.closeSidebar',
    'workbench.action.closeSidebar',
    'workbench.action.closeAuxiliaryBar'
  ];
  for (const command of closeCandidates) {
    if (!commands.includes(command)) continue;
    try {
      await vscode.commands.executeCommand(command);
    } catch {
      // Closing the old Codex surface is best effort before reopening it.
    }
  }
}

async function startFreshCodexChat() {
  const commands = await vscode.commands.getCommands(true);
  const candidates = [
    'chatgpt.newChat',
    'chatgpt.newCodexPanel'
  ];
  for (const command of candidates) {
    if (!commands.includes(command)) continue;
    try {
      await vscode.commands.executeCommand(command);
      return true;
    } catch {
      // Some Codex commands only work when their view is fully ready.
    }
  }
  return false;
}

function clearPostSwitchRefreshTimers() {
  for (const timer of postSwitchRefreshTimers) clearTimeout(timer);
  postSwitchRefreshTimers = [];
}

function schedulePostSwitchStatsRefresh(profileId) {
  clearPostSwitchRefreshTimers();
  for (const refreshDelay of POST_SWITCH_REFRESH_DELAYS_MS) {
    const timer = setTimeout(async () => {
      postSwitchRefreshTimers = postSwitchRefreshTimers.filter(candidate => candidate !== timer);
      const account = readCurrentAccount();
      if (!account.hasCredentials || accountProfileId(account) !== profileId) return;
      await refresh(false);
    }, refreshDelay);
    postSwitchRefreshTimers.push(timer);
  }
}

async function reopenCodexForActiveAccount(contextFilePath = '') {
  await closeCodexSurface();
  await delay(CODEX_REOPEN_DELAY_MS);
  if (contextFilePath) {
    const document = await vscode.workspace.openTextDocument(contextFilePath);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
  }
  await openCodex();
  await delay(CODEX_REOPEN_DELAY_MS);
  return startFreshCodexChat();
}

async function switchAccount() {
  const account = readCurrentAccount();
  const activeId = account.hasCredentials ? accountProfileId(account) : '';
  const profiles = getAccountProfiles();
  const items = profiles
    .filter(profile => profile.id !== activeId)
    .map(profile => ({
      label: `$(account) ${profile.label}`,
      description: profile.credentialsStored
        ? 'Lista para activar'
        : 'Solo historial',
      detail: profile.credentialsStored
        ? `Ultimo uso: ${new Date(profile.lastSeen).toLocaleString()}`
        : 'Necesita iniciar sesion de nuevo para guardar su credencial.',
      profileId: profile.id,
      credentialsStored: Boolean(profile.credentialsStored)
    }));

  if (!items.length) {
    const action = await vscode.window.showInformationMessage(
      'No hay otra cuenta guardada. Agrega una cuenta primero.',
      'Agregar cuenta'
    );
    if (action === 'Agregar cuenta') return addAccount();
    return;
  }

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Cambiar cuenta de Codex',
    placeHolder: 'Selecciona la cuenta que quieres activar'
  });
  if (!selected) return;
  if (selected.credentialsStored) return switchStoredAccount(selected.profileId);
  return handleMissingCredentials(selected.profileId);
}

async function addAccount() {
  clearAccountSwitchGuard();
  let previousProfileId = '';
  const currentAccount = readCurrentAccount();
  if (currentAccount.hasCredentials) previousProfileId = accountProfileId(currentAccount);

  const choice = await vscode.window.showInformationMessage(
    previousProfileId
      ? 'Guardare la cuenta actual cifrada y abrire un login limpio para agregar otra cuenta.'
      : 'Abrire un login limpio para agregar una cuenta de Codex.',
    { modal: true },
    'Agregar cuenta'
  );
  if (choice !== 'Agregar cuenta') return;

  const storedProfileId = await storeCurrentCredentials();
  if (previousProfileId && storedProfileId !== previousProfileId) {
    vscode.window.showErrorMessage(
      'No pude guardar la cuenta actual cifrada, asi que no voy a limpiar la sesion activa. Revisa SecretStorage de VS Code e intenta de nuevo.'
    );
    return;
  }
  if (currentAccount.hasCredentials) {
    await rememberAccount(currentAccount, latestStats);
  }

  const codexExecutable = findCodexExecutable();
  clearAuthPayload();
  lastKnownAccount = null;
  authUnavailableSince = 0;
  latestAuthStatus = {
    state: 'missing',
    checkedAt: Date.now(),
    message: 'Esperando el nuevo inicio de sesion de Codex.'
  };
  startLoginWatcher(previousProfileId);
  await refresh(false);

  const terminal = vscode.window.createTerminal({
    name: 'Codex - Agregar cuenta',
    isTransient: true
  });
  terminal.show(true);
  terminal.sendText(buildCodexLoginCommand(codexExecutable), true);
  if (!codexExecutable) {
    vscode.window.showWarningMessage(
      'No encuentro el ejecutable de Codex. Instala o activa la extension oficial de ChatGPT/OpenAI, o agrega codex al PATH.'
    );
  }
  vscode.window.showInformationMessage(
    'Completa el inicio de sesion en el navegador. Guardare esa cuenta automaticamente cuando Codex actualice auth.json.'
  );
}

async function switchStoredAccount(profileId) {
  const profile = getAccountProfiles().find(candidate => candidate.id === profileId);
  if (!profile) return;

  const serialized = await extensionContext.secrets.get(accountSecretKey(profileId));
  if (!serialized) {
    return handleMissingCredentials(profileId);
  }

  let payload;
  try {
    payload = JSON.parse(serialized);
    const storedAccount = accountFromAuthPayload(payload);
    if (!storedAccount.hasCredentials || accountProfileId(storedAccount) !== profileId) {
      throw new Error('La credencial guardada no coincide con esta cuenta.');
    }
  } catch (error) {
    vscode.window.showErrorMessage(`No se pudo recuperar la cuenta: ${error.message}`);
    return;
  }

  let previousPayload = null;
  try {
    previousPayload = readCurrentAuthPayload().payload;
  } catch {
    previousPayload = null;
  }

  await storeCurrentCredentials();
  try {
    armAccountSwitchGuard(profileId, payload, profile.label);
    writeAuthPayloadAtomic(payload);
    const validation = await runCodexLoginStatus();
    if (!validation.ok) {
      clearAccountSwitchGuard(profileId);
      if (previousPayload) writeAuthPayloadAtomic(previousPayload);
      await extensionContext.secrets.delete(accountSecretKey(profileId));
      await markProfileCredentialsStored(profileId, false);
      lastKnownAccount = null;
      authUnavailableSince = 0;
      latestAuthStatus = {
        state: 'invalid',
        checkedAt: Date.now(),
        message: validation.reason
      };
      await refresh(false);

      const action = await vscode.window.showWarningMessage(
        `${validation.reason} He restaurado la cuenta anterior para que Codex no quede roto.`,
        'Iniciar sesion otra vez',
        'Cerrar'
      );
      if (action === 'Iniciar sesion otra vez') await addAccount();
      return;
    }
    await storeCurrentCredentials();
    lastKnownAccount = null;
    authUnavailableSince = 0;
    latestAuthStatus = {
      state: validation.skipped ? 'skipped' : 'ok',
      checkedAt: Date.now(),
      message: validation.skipped
        ? validation.reason
        : 'Sesion validada por Codex CLI.'
    };
    await refresh(false);
    await updateProjectContextFile('account-switch');
    await new Promise(resolve => setTimeout(resolve, AUTO_SWITCH_RELOAD_DELAY_MS));
    enforceAccountSwitchGuard(AUTH_PATH, false);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  } catch (error) {
    clearAccountSwitchGuard(profileId);
    vscode.window.showErrorMessage(`No se pudo cambiar de cuenta: ${error.message}`);
  }
}

async function handleMissingCredentials(profileId) {
  const profile = getAccountProfiles().find(candidate => candidate.id === profileId);
  if (!profile) return;

  const action = await vscode.window.showWarningMessage(
    `"${profile.label}" todavia no tiene credencial cifrada guardada. Para activarla hay que iniciar sesion una vez con esa cuenta.`,
    'Iniciar sesion',
    'Renombrar',
    'Cancelar'
  );
  if (action === 'Iniciar sesion') return addAccount();
  if (action === 'Renombrar') return renameAccount(profileId);
}

async function handleAccountCard(profileId) {
  const account = readCurrentAccount();
  const activeId = account.hasCredentials ? accountProfileId(account) : '';
  const profile = getAccountProfiles().find(candidate => candidate.id === profileId);
  if (!profile) return;

  const actions = [
    ...(profile.id !== activeId && profile.credentialsStored ? [{
      label: '$(arrow-swap) Activar cuenta',
      action: 'switch'
    }] : []),
    ...(profile.id !== activeId && !profile.credentialsStored ? [{
      label: '$(sign-in) Iniciar sesion con esta cuenta',
      description: 'Guarda la credencial despues del login',
      action: 'login'
    }] : []),
    {
      label: '$(edit) Cambiar nombre',
      action: 'rename'
    },
    ...(profile.id !== activeId ? [{
      label: '$(trash) Eliminar',
      action: 'delete'
    }] : [])
  ];

  const selected = await vscode.window.showQuickPick(actions, {
    title: profile.label,
    placeHolder: 'Que quieres hacer con esta cuenta?'
  });
  if (!selected) return;
  if (selected.action === 'switch') return switchStoredAccount(profileId);
  if (selected.action === 'login') return addAccount();
  if (selected.action === 'rename') return renameAccount(profileId);
  if (selected.action === 'delete') return forgetAccount(profileId);
}

async function renameAccount(profileId) {
  const profiles = getAccountProfiles();
  const profile = profiles.find(candidate => candidate.id === profileId);
  if (!profile) return;

  const label = await vscode.window.showInputBox({
    title: 'Cambiar alias de la cuenta',
    prompt: 'Este alias solo se guarda localmente en Codex Gestion.',
    value: profile.label,
    validateInput: value => value.trim() ? undefined : 'Escribe un nombre para la cuenta.'
  });
  if (label === undefined) return;

  await updateAccountProfiles(current => current.map(candidate =>
    candidate.id === profileId ? { ...candidate, label: label.trim() } : candidate
  ));

  const account = readCurrentAccount();
  if (latestStats && account.hasCredentials && accountProfileId(account) === profileId) {
    latestStats.accountLabel = label.trim();
    updateStatusBar(latestStats);
  }
  updateDashboard();
}

async function forgetAccount(profileId) {
  const account = readCurrentAccount();
  const activeId = account.hasCredentials ? accountProfileId(account) : '';
  if (!profileId || profileId === activeId) {
    vscode.window.showWarningMessage(
      'La cuenta activa no se puede borrar del historial mientras siga iniciada.'
    );
    return;
  }

  const profile = getAccountProfiles().find(candidate => candidate.id === profileId);
  if (!profile) return;
  const confirmation = await vscode.window.showWarningMessage(
    `Eliminar "${profile.label}"? Se borraran su historial y su credencial cifrada de este equipo.`,
    { modal: true },
    'Borrar'
  );
  if (confirmation !== 'Borrar') return;

  await extensionContext.secrets.delete(accountSecretKey(profileId));
  credentialHashes.delete(profileId);
  await updateAccountProfiles(current =>
    current.filter(candidate => candidate.id !== profileId)
  );
  updateDashboard();
}

async function clearInactiveAccounts() {
  const account = readCurrentAccount();
  const activeId = account.hasCredentials ? accountProfileId(account) : '';
  const profiles = getAccountProfiles();
  const inactiveCount = profiles.filter(profile => profile.id !== activeId).length;
  if (!inactiveCount) {
    vscode.window.showInformationMessage('No hay cuentas inactivas para borrar.');
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Borrar ${inactiveCount} cuenta${inactiveCount === 1 ? '' : 's'} inactiva${inactiveCount === 1 ? '' : 's'} del historial local?`,
    { modal: true },
    'Borrar inactivas'
  );
  if (confirmation !== 'Borrar inactivas') return;

  for (const profile of profiles) {
    if (profile.id === activeId) continue;
    await extensionContext.secrets.delete(accountSecretKey(profile.id));
    credentialHashes.delete(profile.id);
  }
  await updateAccountProfiles(current =>
    current.filter(profile => profile.id === activeId)
  );
  updateDashboard();
}

function buildDiagnostics() {
  const account = readCurrentAccount();
  const sessionFiles = getSessionFiles(SESSION_ROOT, 0) || [];
  const newestSession = sessionFiles[0];
  const workspaceCount = (vscode.workspace.workspaceFolders || []).length;

  return [
    'Codex Gestion diagnostics',
    `Extension version: ${extensionContext.extension.packageJSON.version}`,
    `VS Code version: ${vscode.version}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Authentication cache exists: ${fs.existsSync(AUTH_PATH)}`,
    `Authentication mode: ${account.mode}`,
    `Account ID present: ${Boolean(account.id)}`,
    `Credentials detected: ${account.hasCredentials}`,
    `Codex login status: ${latestAuthStatus.state}`,
    `Codex login checked: ${latestAuthStatus.checkedAt ? new Date(latestAuthStatus.checkedAt).toISOString() : 'never'}`,
    `Codex login message: ${latestAuthStatus.message}`,
    `Session directory exists: ${fs.existsSync(SESSION_ROOT)}`,
    `Session files found: ${sessionFiles.length}`,
    `Newest session modified: ${newestSession ? new Date(newestSession.mtimeMs).toISOString() : 'none'}`,
    `Open workspace folders: ${workspaceCount}`,
    `Latest stats available: ${Boolean(latestStats)}`,
    `Last refresh duration: ${lastRefreshDurationMs} ms`,
    `Latest error: ${latestError ? latestError.stack || latestError.message : 'none'}`,
    '',
    'No tokens, account identifiers, session contents, or file paths are included.'
  ].join('\n');
}

function showDiagnostics() {
  outputChannel.clear();
  outputChannel.appendLine(buildDiagnostics());
  outputChannel.show(true);
}

function getWorkspaceRootPath() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri?.fsPath || '';
}

function getProjectContextPath() {
  const root = getWorkspaceRootPath();
  if (!root) return '';
  return path.join(root, PROJECT_CONTEXT_DIR, PROJECT_CONTEXT_FILE);
}

function formatContextQuota(label, limit) {
  if (!limit) return `- ${label}: pendiente de recoger datos; abre Codex con esta cuenta o inicia un chat nuevo`;
  const available = availablePercent(limit.used_percent);
  const reset = finiteNumber(limit.resets_at) ? formatResetFull(limit.resets_at) : 'sin renovacion';
  return `- ${label}: ${formatPercent(available)} disponible; se renueva ${reset}`;
}

function buildProjectContextAutoBlock(reason = 'manual') {
  const account = readCurrentAccount();
  const activeProfile = account.hasCredentials
    ? getAccountProfiles().find(profile => profile.id === accountProfileId(account))
    : null;
  const accountLabel = activeProfile?.label || latestStats?.accountLabel || (
    account.hasCredentials ? accountDisplayLabel(account) : 'Sin sesion'
  );
  const limits = latestStats?.rateLimits || {};
  const workspaceRoot = getWorkspaceRootPath();
  const workspaceName = workspaceRoot ? path.basename(workspaceRoot) : 'Sin workspace';
  const reasonLabel = reason === 'account-switch'
    ? 'Cambio de cuenta'
    : reason === 'refresh'
      ? 'Actualizacion manual'
      : 'Apertura/creacion';

  return [
    PROJECT_CONTEXT_START,
    '## Resumen automatico',
    '',
    `- Proyecto/carpeta: ${workspaceName}`,
    `- Actualizado: ${new Date().toLocaleString()}`,
    `- Motivo: ${reasonLabel}`,
    `- Extension: Codex Gestion v${extensionContext.extension.packageJSON.version}`,
    `- Cuenta activa: ${accountLabel}`,
    `- Estado de sesion: ${latestAuthStatus.state} - ${latestAuthStatus.message}`,
    formatContextQuota('Cuota 5 h', limits.primary),
    formatContextQuota('Cuota 7 dias', limits.secondary),
    latestStats ? `- Plan local observado: ${planDisplay(latestStats).label} (${planDisplay(latestStats).detail})` : '- Plan local observado: pendiente de recoger datos',
    `- Ultimo dato local: ${latestStats ? new Date(latestStats.timestamp).toLocaleString() : 'sin datos'}`,
    `- Sesiones locales activas detectadas: ${latestStats?.activeSessions || 0}`,
    '',
    '> Este bloque lo regenera Codex Gestion. No incluye credenciales, tokens, mensajes privados ni contenido completo de chats.',
    PROJECT_CONTEXT_END
  ].join('\n');
}

function buildInitialProjectContext(reason) {
  return [
    '# Contexto del proyecto para Codex',
    '',
    buildProjectContextAutoBlock(reason),
    '',
    '## Objetivo',
    '',
    '- Describe aqui que se esta construyendo y para que.',
    '',
    '## Estado actual',
    '',
    '- Que funciona ahora mismo.',
    '- Que se acaba de cambiar.',
    '- Que falta validar.',
    '',
    '## Decisiones tomadas',
    '',
    '- Decision: motivo.',
    '',
    '## Archivos importantes',
    '',
    '- `extension.js`: logica principal de la extension.',
    '- `package.json`: comandos, version y configuracion de VS Code.',
    '- `tests/`: pruebas automaticas.',
    '',
    '## Bugs o riesgos conocidos',
    '',
    '- Anota aqui fallos pendientes, limitaciones o cosas delicadas.',
    '',
    '## Proximos pasos',
    '',
    '- Siguiente accion concreta.',
    '',
    '## Prompt para continuar en otro chat o cuenta',
    '',
    'Copia desde aqui cuando quieras continuar con otra cuenta o pasarlo a un companero:',
    '',
    '```text',
    'Continua este proyecto usando el contexto de este documento. Respeta las decisiones tomadas, revisa los archivos indicados y antes de cambiar algo comprueba el estado actual del repo.',
    '```',
    ''
  ].join('\n');
}

async function updateProjectContextFile(reason = 'manual', options = {}) {
  const { refreshFirst = true, silent = false, createIfMissing = true } = options;
  const filePath = getProjectContextPath();
  if (!filePath) {
    if (!silent) {
      vscode.window.showWarningMessage('Abre una carpeta o workspace para guardar el contexto del proyecto.');
    }
    return null;
  }
  if (!createIfMissing && !fs.existsSync(filePath)) return null;

  if (refreshFirst) await refresh(false);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const autoBlock = buildProjectContextAutoBlock(reason);
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf8');
    const start = content.indexOf(PROJECT_CONTEXT_START);
    const end = content.indexOf(PROJECT_CONTEXT_END);
    if (start >= 0 && end > start) {
      content = `${content.slice(0, start)}${autoBlock}${content.slice(end + PROJECT_CONTEXT_END.length)}`;
    } else {
      content = `${autoBlock}\n\n${content}`;
    }
  } else {
    content = buildInitialProjectContext(reason);
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

async function refreshProjectContextIfPresent(reason = 'refresh') {
  try {
    await updateProjectContextFile(reason, {
      refreshFirst: false,
      silent: true,
      createIfMissing: false
    });
  } catch {
    // Context refresh is best effort; it should never break quota updates.
  }
}

async function openProjectContext(reason = 'manual') {
  const filePath = await updateProjectContextFile(reason);
  if (!filePath) return;
  const document = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
}

function metricCard(label, value, percent, detail, hint, tone = 'accent') {
  const normalized = clampPercent(percent);
  const used = 100 - normalized;
  const displayValue = value ?? 'Unavailable';
  return `
    <section class="metric-card ${tone}" data-chart-card data-available="${escapeHtml(normalized)}" data-used="${escapeHtml(used)}" data-tone="${escapeHtml(tone)}">
      <div class="metric-chart-wrap" role="img" aria-label="${escapeHtml(label)}: ${escapeHtml(String(Math.round(normalized)))}% disponible">
        <canvas class="metric-chart" width="144" height="144"></canvas>
        <div class="metric-center">
          <strong>${Number.isFinite(Number(percent)) ? `${Math.round(Number(percent))}%` : '--'}</strong>
          <span>libre</span>
        </div>
      </div>
      <div class="metric-copy">
        <div class="metric-top">
          <span class="metric-label">${escapeHtml(label)}</span>
        </div>
        <strong class="metric-value">${escapeHtml(displayValue)}</strong>
        <div class="quota-legend">
          <span><i class="legend-dot free"></i>${escapeHtml(Math.round(normalized))}% libre</span>
          <span><i class="legend-dot used"></i>${escapeHtml(Math.round(used))}% usado</span>
        </div>
        <span class="metric-detail">${escapeHtml(detail || '')}</span>
        <small class="metric-hint">${escapeHtml(hint || '')}</small>
      </div>
    </section>
  `;
}

function accountCards(activeProfileId) {
  const profiles = getAccountProfiles();
  if (!profiles.length) {
    return '<p class="empty">Todavia no se ha detectado ninguna cuenta.</p>';
  }

  return profiles.map(profile => {
    const snapshot = visibleAccountSnapshot(profile, profiles, activeProfileId);
    const primary = snapshot?.primaryUsed;
    const secondary = snapshot?.secondaryUsed;
    const isActive = profile.id === activeProfileId;
    const plan = snapshot?.plan
      ? `Plan local ${String(snapshot.plan).toUpperCase()}`
      : 'Plan local pendiente';
    const cardTitle = isActive
      ? 'Gestionar cuenta activa'
      : profile.credentialsStored
        ? 'Activar o gestionar esta cuenta'
        : 'Gestionar historial de esta cuenta';
    const cardAction = ` data-action="accountCard" data-profile="${escapeHtml(profile.id)}" role="button" tabindex="0" title="${escapeHtml(cardTitle)}"`;
    return `
      <article class="account-card ${isActive ? 'active' : 'selectable'}"${cardAction}>
        <div class="account-main">
          <div class="account-title">
            <strong>${escapeHtml(profile.label)}</strong>
            ${isActive
              ? '<span class="badge">Activa ahora</span>'
              : profile.credentialsStored
                ? '<span class="badge muted">Lista para usar</span>'
                : '<span class="badge muted">Solo historial</span>'}
          </div>
          <span>${escapeHtml(String(profile.mode).toUpperCase())} - ${escapeHtml(plan)}</span>
        </div>
        <div class="account-usage">
          <div><small>Cuota 5 h</small><strong>${primary == null ? 'Pendiente' : `${Math.round(100 - primary)}% libre`}</strong></div>
          <div><small>Cuota 7 dias</small><strong>${secondary == null ? 'Pendiente' : `${Math.round(100 - secondary)}% libre`}</strong></div>
        </div>
        <small class="account-seen">Ultimo uso: ${escapeHtml(new Date(profile.lastSeen).toLocaleString())}</small>
        <div class="account-actions">
          <button class="small secondary" data-action="renameAccount" data-profile="${escapeHtml(profile.id)}">Renombrar</button>
          ${isActive
            ? '<span class="active-note">Cuenta en uso</span>'
            : `<button class="small danger-button" data-action="forgetAccount" data-profile="${escapeHtml(profile.id)}">Eliminar</button>`}
        </div>
      </article>
    `;
  }).join('');
}

function visibleAccountSnapshot(profile, profiles, activeProfileId) {
  const snapshot = profile?.snapshot || {};
  const fingerprint = snapshot.rateLimitFingerprint || '';
  if (!fingerprint || profile.id === activeProfileId) return snapshot;

  const activeProfile = profiles.find(candidate => candidate.id === activeProfileId);
  if (activeProfile?.snapshot?.rateLimitFingerprint === fingerprint) {
    return {};
  }

  return snapshot;
}

function dashboardHtml(webview) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const extensionRoot = extensionContext.extensionPath || path.resolve(__dirname, '..');
  const chartScriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionRoot, 'media', 'chart.umd.min.js')));
  const account = readCurrentAccount();
  const activeProfileId = account.hasCredentials ? accountProfileId(account) : '';
  const limits = latestStats?.rateLimits || {};
  const primaryPercent = limits.primary?.used_percent;
  const secondaryPercent = limits.secondary?.used_percent;
  const primaryAvailable = availablePercent(primaryPercent);
  const secondaryAvailable = availablePercent(secondaryPercent);
  const advice = getUsageAdvice(latestStats, latestAuthStatus);
  const profiles = getAccountProfiles();
  const activeProfile = profiles.find(profile => profile.id === activeProfileId);
  const resetCandidates = [limits.primary?.resets_at, limits.secondary?.resets_at]
    .map(Number)
    .filter(value => Number.isFinite(value) && value * 1000 > Date.now());
  const nextReset = resetCandidates.length ? Math.min(...resetCandidates) : null;
  const stateTitle = latestError
    ? 'No se pudo leer el uso de Codex'
    : latestAuthStatus.state === 'invalid'
      ? 'Sesion de Codex no validada'
      : latestAuthStatus.state === 'missing'
        ? 'Inicia sesion en Codex'
        : latestStats
          ? latestStats.isSnapshotFallback
            ? 'Ultimo resumen guardado'
            : 'Tu uso, explicado de forma sencilla'
          : account.hasCredentials
            ? 'Recogiendo datos de la cuenta'
            : 'Inicia sesion en Codex';
  const stateDetail = latestError
    ? latestError.message
    : latestAuthStatus.state === 'invalid' || latestAuthStatus.state === 'missing'
      ? latestAuthStatus.message
      : latestStats
        ? latestStats.isSnapshotFallback
          ? `Guardado ${new Date(latestStats.timestamp).toLocaleString()}. Se actualizara cuando Codex escriba datos nuevos.`
          : `Actualizado ${new Date(latestStats.timestamp).toLocaleString()}`
        : account.hasCredentials
          ? 'Abre Codex con esta cuenta o inicia un chat nuevo para que aparezcan plan y cuotas.'
          : 'Abre el panel oficial de Codex para iniciar sesion.';
  const accountLabel = activeProfile?.label ||
    latestStats?.accountLabel ||
    (account.hasCredentials ? accountDisplayLabel(account) : 'Sin sesion');
  const planInfo = planDisplay(latestStats);
  const panelSessionNotice = account.hasCredentials
    ? `<div class="notice warning-notice"><strong>Cuenta local activa</strong>Codex Gestion lee el auth local. Si el panel oficial de Codex muestra otra cuenta, otra cuota o un boton de upgrade, recarga VS Code antes de escribir.</div>`
    : '';
  const authNotice = latestAuthStatus.state === 'invalid' || latestAuthStatus.state === 'missing'
    ? `<div class="notice danger-notice"><strong>Sesion de Codex</strong>${escapeHtml(latestAuthStatus.message)} Usa "Abrir Codex" o "Agregar cuenta" para recuperarla.</div>`
    : latestAuthStatus.state === 'skipped' || latestAuthStatus.state === 'unknown'
      ? `<div class="notice warning-notice"><strong>Comprobacion pendiente</strong>${escapeHtml(latestAuthStatus.message)}</div>`
      : '';

  return `<!DOCTYPE html>
  <html lang="es">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' ${webview.cspSource};">
    <style nonce="${nonce}">
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 32px;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
      }
      main { max-width: 1040px; margin: 0 auto; }
      header {
        display: flex;
        justify-content: space-between;
        gap: 20px;
        align-items: flex-start;
        margin-bottom: 24px;
      }
      h1, h2, p { margin-top: 0; }
      h1 { font-size: 30px; letter-spacing: -.5px; margin-bottom: 7px; }
      h2 { font-size: 18px; margin: 32px 0 12px; }
      .subtitle, .metric-detail, .metric-hint, .account-card span, small { color: var(--vscode-descriptionForeground); }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .version {
        display: inline-block;
        margin-bottom: 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        font-weight: 600;
      }
      button {
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 8px;
        padding: 9px 14px;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        cursor: pointer;
        font: inherit;
      }
      button:hover { background: var(--vscode-button-hoverBackground); }
      button.secondary {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
      }
      button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
      .metrics {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 14px;
      }
      .metric-card, .account-card, .notice, .identity {
        border: 1px solid var(--vscode-widget-border);
        border-radius: 14px;
        background: var(--vscode-editorWidget-background);
        box-shadow: 0 8px 28px var(--vscode-widget-shadow);
      }
      .recommendation {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 14px;
        padding: 16px 18px;
        margin-bottom: 16px;
        border: 1px solid var(--vscode-widget-border);
        border-radius: 14px;
        background: var(--vscode-editorWidget-background);
      }
      .recommendation-icon {
        width: 38px;
        height: 38px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        color: var(--vscode-button-foreground);
        background: var(--vscode-charts-green);
        font-size: 19px;
        font-weight: 800;
      }
      .recommendation.warning .recommendation-icon { background: var(--vscode-charts-orange); }
      .recommendation.danger .recommendation-icon { background: var(--vscode-charts-red); }
      .recommendation-copy { display: flex; flex-direction: column; gap: 4px; }
      .next-reset { text-align: right; white-space: nowrap; }
      .next-reset strong, .next-reset span { display: block; }
      .identity {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        padding: 16px 18px;
        margin-bottom: 16px;
      }
      .identity-main { display: flex; align-items: center; gap: 12px; }
      .avatar {
        width: 42px;
        height: 42px;
        border-radius: 12px;
        display: grid;
        place-items: center;
        font-size: 20px;
        font-weight: 700;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
      }
      .identity-copy { display: flex; flex-direction: column; gap: 3px; }
      .plan-pill {
        padding: 5px 10px;
        border-radius: 999px;
        color: var(--vscode-badge-foreground);
        background: var(--vscode-badge-background);
        font-size: 12px;
        font-weight: 700;
      }
      .metric-card {
        min-height: 208px;
        padding: 18px;
        display: grid;
        grid-template-columns: 136px 1fr;
        gap: 18px;
        align-items: center;
      }
      .metric-chart-wrap {
        position: relative;
        width: 136px;
        height: 136px;
      }
      .metric-chart { width: 136px !important; height: 136px !important; }
      .metric-center {
        position: absolute;
        inset: 30px;
        display: grid;
        place-items: center;
        align-content: center;
        border-radius: 50%;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-widget-border);
      }
      .metric-center strong { font-size: 28px; letter-spacing: 0; line-height: 1; }
      .metric-center span { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; text-transform: uppercase; }
      .metric-copy { min-width: 0; display: flex; flex-direction: column; gap: 9px; }
      .metric-value { font-size: 24px; letter-spacing: 0; }
      .metric-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
      .metric-label { font-weight: 700; color: var(--vscode-descriptionForeground); }
      .quota-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 14px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
      .quota-legend span { display: inline-flex; align-items: center; gap: 6px; }
      .legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
      .legend-dot.free { background: var(--vscode-charts-green); }
      .warning .legend-dot.free { background: var(--vscode-charts-orange); }
      .danger .legend-dot.free { background: var(--vscode-charts-red); }
      .legend-dot.used { background: var(--vscode-descriptionForeground); opacity: .38; }
      .metric-detail, .metric-hint { line-height: 1.4; }
      .metric-hint { margin-top: auto; }
      .notice { padding: 16px 18px; margin-bottom: 14px; }
      .notice strong { display: block; margin-bottom: 5px; }
      .danger-notice { border-color: var(--vscode-inputValidation-errorBorder); }
      .warning-notice { border-color: var(--vscode-inputValidation-warningBorder); }
      .accounts { display: grid; gap: 9px; }
      .account-card {
        padding: 16px 18px;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px 22px;
        align-items: center;
      }
      .account-card.active { border-color: var(--vscode-focusBorder); }
      .account-card.selectable { cursor: pointer; }
      .account-card.selectable:hover {
        border-color: var(--vscode-focusBorder);
        background: var(--vscode-list-hoverBackground);
      }
      .account-card.selectable:focus-visible {
        outline: 2px solid var(--vscode-focusBorder);
        outline-offset: 2px;
      }
      .account-title { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
      .account-usage { display: flex; gap: 22px; font-variant-numeric: tabular-nums; }
      .account-usage div { min-width: 88px; }
      .account-usage small, .account-usage strong { display: block; }
      .account-usage strong { margin-top: 3px; }
      .account-seen { grid-column: 1 / 2; }
      .account-actions {
        grid-column: 2 / 3;
        display: flex;
        justify-content: flex-end;
        gap: 7px;
      }
      .active-note { font-size: 12px; }
      button.small { padding: 6px 10px; font-size: 12px; }
      button.danger-button {
        color: var(--vscode-errorForeground);
        background: transparent;
        border-color: var(--vscode-inputValidation-errorBorder);
      }
      button.danger-button:hover { background: var(--vscode-inputValidation-errorBackground); }
      .badge {
        padding: 2px 7px;
        border-radius: 999px;
        color: var(--vscode-badge-foreground) !important;
        background: var(--vscode-badge-background);
        font-size: 11px;
      }
      .badge.muted {
        color: var(--vscode-descriptionForeground) !important;
        background: var(--vscode-toolbar-hoverBackground);
      }
      .accounts-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        margin-top: 32px;
      }
      .accounts-heading h2 { margin: 0; }
      .empty { padding: 18px; border: 1px dashed var(--vscode-widget-border); border-radius: 8px; }
      .explain-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }
      .explain-card {
        padding: 15px 16px;
        border-left: 3px solid var(--vscode-textLink-foreground);
        background: var(--vscode-textBlockQuote-background);
      }
      .explain-card strong { display: block; margin-bottom: 5px; }
      .meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 18px;
        margin-top: 18px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }
      .footnote { margin-top: 24px; font-size: 12px; color: var(--vscode-descriptionForeground); }
      @media (max-width: 640px) {
        body { padding: 18px; }
        header { flex-direction: column; }
        .account-card { grid-template-columns: 1fr; }
        .account-usage, .account-seen, .account-actions { grid-column: 1; }
        .account-actions { justify-content: flex-start; flex-wrap: wrap; }
        .metric-card { grid-template-columns: 1fr; }
        .metric-chart-wrap { margin: 0 auto; }
        .accounts-heading { align-items: flex-start; flex-direction: column; }
        .recommendation { grid-template-columns: auto 1fr; }
        .next-reset { grid-column: 1 / -1; text-align: left; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <span class="version">Codex Gestion v${escapeHtml(extensionContext.extension.packageJSON.version)}</span>
          <h1>Panel de uso de Codex</h1>
          <p class="subtitle">${escapeHtml(stateTitle)}. ${escapeHtml(stateDetail)}</p>
        </div>
        <div class="actions">
          <button data-action="refresh">Actualizar</button>
          <button class="secondary" data-action="projectContext">Contexto proyecto</button>
          <button class="secondary" data-action="accounts">Gestionar cuentas</button>
          <button class="secondary" data-action="openCodex">Abrir Codex</button>
        </div>
      </header>

      ${latestError ? `<div class="notice"><strong>Error de lectura</strong>${escapeHtml(latestError.message)}</div>` : ''}
      ${authNotice}
      ${panelSessionNotice}

      <section class="recommendation ${escapeHtml(advice.tone)}">
        <div class="recommendation-icon">${advice.tone === 'good' ? '&#10003;' : '!'}</div>
        <div class="recommendation-copy">
          <strong>${escapeHtml(advice.title)}</strong>
          <span>${escapeHtml(advice.detail)}</span>
        </div>
        <div class="next-reset">
          <span>Proxima renovacion</span>
          <strong>${nextReset ? escapeHtml(formatResetMoment(nextReset)) : 'Sin datos'}</strong>
        </div>
      </section>

      <section class="identity">
        <div class="identity-main">
          <div class="avatar">C</div>
          <div class="identity-copy">
            <strong>${escapeHtml(accountLabel)}</strong>
            <span>Cuenta usada por los chats nuevos de Codex</span>
          </div>
        </div>
        <span class="plan-pill">Plan local ${escapeHtml(planInfo.label)} - ${escapeHtml(planInfo.detail)}</span>
      </section>

      <div class="metrics">
        ${metricCard(
          `Cuota de ${windowLabel(limits.primary?.window_minutes)}`,
          primaryAvailable == null ? 'Pendiente' : `${formatPercent(primaryAvailable)} disponible`,
          primaryAvailable,
          limits.primary ? `Se renueva ${formatResetFull(limits.primary.resets_at)}` : 'Pendiente de recoger datos de esta cuenta',
          'Es la cuota corta de uso intensivo. Se recupera varias veces durante el dia.',
          Number(primaryPercent) >= 90 ? 'danger' : Number(primaryPercent) >= 75 ? 'warning' : 'accent'
        )}
        ${metricCard(
          `Cuota de ${windowLabel(limits.secondary?.window_minutes)}`,
          secondaryAvailable == null ? 'Pendiente' : `${formatPercent(secondaryAvailable)} disponible`,
          secondaryAvailable,
          limits.secondary ? `Se renueva ${formatResetFull(limits.secondary.resets_at)}` : 'Pendiente de recoger datos de esta cuenta',
          'Es la cuota de largo plazo de la cuenta activa.',
          Number(secondaryPercent) >= 90 ? 'danger' : Number(secondaryPercent) >= 75 ? 'warning' : 'accent'
        )}
      </div>

      <h2>Que significa cada dato</h2>
      <div class="explain-grid">
        <div class="explain-card">
          <strong>5 h disponible</strong>
          Es la cuota que limita el uso intenso a corto plazo. Si llega a 0%, espera a la hora de renovacion indicada.
        </div>
        <div class="explain-card">
          <strong>7 dias disponible</strong>
          Es la cuota de largo plazo de tu cuenta. Se consume gradualmente aunque la cuota de 5 h se renueve.
        </div>
      </div>

      <div class="accounts-heading">
        <div>
          <h2>Gestion de cuentas</h2>
          <p class="subtitle">${profiles.length} cuenta${profiles.length === 1 ? '' : 's'} detectada${profiles.length === 1 ? '' : 's'} en este equipo</p>
        </div>
        <div class="actions">
          <button class="secondary" data-action="switchAccount">Cambiar cuenta</button>
          <button class="secondary" data-action="addAccount">Agregar cuenta</button>
          ${profiles.some(profile => profile.id !== activeProfileId)
            ? '<button class="danger-button" data-action="clearInactiveAccounts">Borrar inactivas</button>'
            : ''}
        </div>
      </div>
      <div class="accounts">${accountCards(activeProfileId)}</div>

      <p class="footnote">
        Las credenciales se guardan cifradas mediante VS Code SecretStorage y nunca aparecen en el panel, los logs o el historial.
        Eliminar una tarjeta inactiva borra tambien su credencial guardada. Pulsa una tarjeta disponible para cambiar de cuenta.
        Las cuotas de varias cuentas no se pueden sumar:
        al cambiar de cuenta hay que iniciar un chat nuevo.
      </p>
      <div class="meta-row">
        <span>${latestStats?.isSnapshotFallback ? 'Resumen guardado' : 'Ultimo dato de Codex'}: ${latestStats ? escapeHtml(new Date(latestStats.timestamp).toLocaleString()) : 'sin datos'}</span>
        <span>Comprobado por la extension: ${lastRefreshAt ? escapeHtml(new Date(lastRefreshAt).toLocaleTimeString()) : 'sin datos'}</span>
        <span>Sesiones locales activas: ${latestStats?.activeSessions || 0}</span>
        <span>Lectura completada en: ${lastRefreshDurationMs} ms</span>
      </div>
      <div class="actions">
        <button class="secondary" data-action="diagnostics">Ver diagnostico tecnico</button>
      </div>
    </main>
    <script nonce="${nonce}" src="${chartScriptUri}"></script>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const css = getComputedStyle(document.documentElement);
      const colorFor = name => css.getPropertyValue(name).trim();
      const toneColor = tone => tone === 'danger' ? colorFor('--vscode-charts-red') : tone === 'warning' ? colorFor('--vscode-charts-orange') : colorFor('--vscode-charts-green');
      document.querySelectorAll('[data-chart-card]').forEach(card => {
        const canvas = card.querySelector('canvas');
        if (!canvas || !window.Chart) return;
        const available = Number(card.dataset.available) || 0;
        const used = Number(card.dataset.used) || 0;
        new Chart(canvas, {
          type: 'doughnut',
          data: {
            labels: ['Libre', 'Usado'],
            datasets: [{
              data: [available, used],
              backgroundColor: [toneColor(card.dataset.tone), colorFor('--vscode-descriptionForeground')],
              borderColor: colorFor('--vscode-editorWidget-background'),
              borderWidth: 4,
              hoverOffset: 3
            }]
          },
          options: {
            responsive: false,
            cutout: '72%',
            events: [],
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            animation: { duration: 500, easing: 'easeOutQuart' }
          }
        });
      });
      document.addEventListener('click', event => {
        const target = event.target.closest('[data-action]');
        if (!target) return;
        if (target.tagName === 'BUTTON') event.stopPropagation();
        vscode.postMessage({
          action: target.dataset.action,
          profileId: target.dataset.profile || null
        });
      });
      document.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const target = event.target.closest('.account-card[data-action]');
        if (!target) return;
        event.preventDefault();
        target.click();
      });
    </script>
  </body>
  </html>`;
}

function dashboardSignature() {
  const profiles = getAccountProfiles().map(profile => ({
    id: profile.id,
    label: profile.label,
    credentialsStored: profile.credentialsStored,
    lastSeen: profile.lastSeen,
    snapshot: profile.snapshot || {}
  }));
  return JSON.stringify({
    statsTimestamp: latestStats?.timestamp || null,
    statsFallback: Boolean(latestStats?.isSnapshotFallback),
    accountLabel: latestStats?.accountLabel || '',
    primary: latestStats?.rateLimits?.primary || null,
    secondary: latestStats?.rateLimits?.secondary || null,
    plan: latestStats?.rateLimits?.plan_type || null,
    authState: latestAuthStatus.state,
    authMessage: latestAuthStatus.message,
    error: latestError?.message || '',
    profiles
  });
}

function updateDashboard(force = false) {
  if (!dashboardPanel) return;
  const signature = dashboardSignature();
  if (!force && signature === lastDashboardSignature) return;
  dashboardPanel.webview.html = dashboardHtml(dashboardPanel.webview);
  lastDashboardSignature = signature;
}

async function showDashboard() {
  await refresh(false);

  if (dashboardPanel) {
    dashboardPanel.reveal(vscode.ViewColumn.Beside);
    updateDashboard(true);
    return;
  }

  dashboardPanel = vscode.window.createWebviewPanel(
    'codexGestion.dashboard',
    'Codex Gestion',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(extensionContext.extensionPath || path.resolve(__dirname, '..'), 'media'))
      ]
    }
  );
  dashboardPanel.webview.html = dashboardHtml(dashboardPanel.webview);
  lastDashboardSignature = dashboardSignature();
  dashboardPanel.webview.onDidReceiveMessage(async message => {
    if (message.action === 'refresh') await refresh(true);
    if (message.action === 'accounts') await manageAccounts();
    if (message.action === 'openCodex') await openCodex();
    if (message.action === 'projectContext') await openProjectContext('manual');
    if (message.action === 'addAccount') await addAccount();
    if (message.action === 'diagnostics') showDiagnostics();
    if (message.action === 'switchAccount') await switchAccount();
    if (message.action === 'accountCard') await handleAccountCard(message.profileId);
    if (message.action === 'switchStoredAccount') await switchStoredAccount(message.profileId);
    if (message.action === 'renameAccount') await renameAccount(message.profileId);
    if (message.action === 'forgetAccount') await forgetAccount(message.profileId);
    if (message.action === 'clearInactiveAccounts') await clearInactiveAccounts();
  }, undefined, extensionContext.subscriptions);
  dashboardPanel.onDidDispose(() => {
    dashboardPanel = null;
    lastDashboardSignature = '';
  }, undefined, extensionContext.subscriptions);
}

async function manageAccounts() {
  const account = readCurrentAccount();
  const activeId = account.hasCredentials ? accountProfileId(account) : '';
  const profiles = getAccountProfiles();
  const accountItems = profiles.map(profile => ({
    label: `${profile.id === activeId ? '$(check) ' : '$(account) '}${profile.label}`,
    description: profile.id === activeId
      ? 'Cuenta activa'
      : profile.credentialsStored
        ? 'Cuenta guardada y lista para usar'
        : 'Solo historial, sin credencial guardada',
    detail: `5 h: ${profile.snapshot?.primaryUsed == null ? '--' : `${Math.round(100 - profile.snapshot.primaryUsed)}% libre`} - 7 dias: ${profile.snapshot?.secondaryUsed == null ? '--' : `${Math.round(100 - profile.snapshot.secondaryUsed)}% libre`}`,
    action: 'profile',
    profileId: profile.id
  }));
  const selected = await vscode.window.showQuickPick([
    {
      label: '$(add) Agregar cuenta',
      description: 'Guarda la actual y abre el inicio de sesion oficial',
      action: 'add'
    },
    ...accountItems,
    ...(profiles.some(profile => profile.id !== activeId) ? [{
      label: '$(trash) Borrar todas las cuentas inactivas',
      description: 'Conserva la cuenta activa y elimina el resto del historial',
      action: 'clearInactive'
    }] : [])
  ], {
    title: 'Cuentas de Codex',
    placeHolder: 'Elige una cuenta para activarla o eliminarla'
  });
  if (!selected) return;

  if (selected.action === 'add') return addAccount();
  if (selected.action === 'clearInactive') return clearInactiveAccounts();
  if (selected.action === 'profile') {
    const isActive = selected.profileId === activeId;
    const profile = profiles.find(candidate => candidate.id === selected.profileId);
    const action = await vscode.window.showQuickPick([
      ...(!isActive && profile?.credentialsStored ? [{
        label: '$(arrow-swap) Activar esta cuenta',
        action: 'switchTo'
      }] : []),
      ...(!isActive && !profile?.credentialsStored ? [{
        label: '$(sign-in) Iniciar sesion con esta cuenta',
        description: 'La credencial no esta guardada o ya no es valida',
        action: 'login'
      }] : []),
      {
        label: '$(edit) Cambiar nombre',
        action: 'rename'
      },
      ...(!isActive ? [{
        label: '$(trash) Eliminar',
        action: 'forget'
      }] : [])
    ], {
      title: selected.label.replace(/^\$\([^)]+\)\s*/, ''),
      placeHolder: 'Que quieres hacer con esta cuenta?'
    });
    if (action?.action === 'switchTo') return switchStoredAccount(selected.profileId);
    if (action?.action === 'login') return addAccount();
    if (action?.action === 'rename') return renameAccount(selected.profileId);
    if (action?.action === 'forget') return forgetAccount(selected.profileId);
  }
}

async function showRecovery() {
  const account = readCurrentAccount();
  const message = latestError
    ? `Codex Gestion ha fallado: ${latestError.message}`
    : account.hasCredentials
      ? 'La sesion esta iniciada, pero todavia no hay datos. Usa un chat de Codex y vuelve a actualizar.'
      : 'No se ha detectado una sesion de Codex. Abre Codex para iniciar sesion.';

  const action = await vscode.window.showWarningMessage(
    message,
    'Abrir Codex',
    'Actualizar',
    'Ver diagnostico'
  );

  if (action === 'Abrir Codex') await openCodex();
  if (action === 'Actualizar') setTimeout(() => void refresh(true), 0);
  if (action === 'Ver diagnostico') showDiagnostics();
}

async function showDetails() {
  await showDashboard();
  if (!latestStats) await showRecovery();
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const seconds = Math.max(
    5,
    Number(vscode.workspace.getConfiguration('codexGestion').get('refreshIntervalSeconds', 30))
  );
  refreshTimer = setInterval(() => refresh(false), seconds * 1000);
}

function scheduleAuthRefresh() {
  if (authWatchTimer) clearTimeout(authWatchTimer);
  authWatchTimer = setTimeout(async () => {
    authWatchTimer = null;
    await enforceAccountSwitchGuard();
    if (pendingLoginWatcher) {
      void importCurrentCredentialsIfChanged(pendingLoginWatcher.previousProfileId).then(imported => {
        if (imported) stopLoginWatcher();
      });
    }
    void refresh(false);
  }, AUTH_WATCH_DEBOUNCE_MS);
}

function scheduleSessionRefresh() {
  if (sessionWatchTimer) clearTimeout(sessionWatchTimer);
  sessionWatchTimer = setTimeout(() => {
    sessionWatchTimer = null;
    void refresh(false);
  }, AUTH_WATCH_DEBOUNCE_MS);
}

function startSessionWatcher() {
  if (sessionWatcher || !fs.existsSync(SESSION_ROOT)) return;
  try {
    sessionWatcher = fs.watch(SESSION_ROOT, { recursive: true }, (_eventType, filename) => {
      if (filename && !String(filename).endsWith('.jsonl')) return;
      scheduleSessionRefresh();
    });
  } catch {
    sessionWatcher = null;
  }
}

function activate(context) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel('Codex Gestion');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.name = 'Codex Gestion';
  statusItem.command = 'codexGestion.showDashboard';

  context.subscriptions.push(
    statusItem,
    outputChannel,
    vscode.commands.registerCommand('codexGestion.refresh', () => refresh(true)),
    vscode.commands.registerCommand('codexGestion.showDetails', showDetails),
    vscode.commands.registerCommand('codexGestion.showDashboard', showDashboard),
    vscode.commands.registerCommand('codexGestion.manageAccounts', manageAccounts),
    vscode.commands.registerCommand('codexGestion.switchAccount', switchAccount),
    vscode.commands.registerCommand('codexGestion.addAccount', addAccount),
    vscode.commands.registerCommand('codexGestion.openProjectContext', () => openProjectContext('manual')),
    vscode.commands.registerCommand('codexGestion.openCodex', openCodex),
    vscode.commands.registerCommand('codexGestion.showDiagnostics', showDiagnostics),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('codexGestion')) return;
      scheduleRefresh();
      updateStatusBar(latestStats);
    }),
    {
      dispose() {
        if (authWatchTimer) clearTimeout(authWatchTimer);
        if (sessionWatchTimer) clearTimeout(sessionWatchTimer);
        if (sessionWatcher) sessionWatcher.close();
        clearPostSwitchRefreshTimers();
        fs.unwatchFile(AUTH_PATH);
      }
    }
  );

  fs.watchFile(AUTH_PATH, { interval: 2000 }, scheduleAuthRefresh);
  startSessionWatcher();
  scheduleRefresh();
  refresh(false);

  const currentVersion = context.extension.packageJSON.version;
  const previousVersion = context.globalState.get('lastActivatedVersion', '');
  if (previousVersion !== currentVersion) {
    context.globalState.update('lastActivatedVersion', currentVersion);
    vscode.window.showInformationMessage(
      `Codex Gestion ${currentVersion}: nuevo panel visual disponible.`,
      'Abrir panel'
    ).then(action => {
      if (action === 'Abrir panel') showDashboard();
    });
  }
}

function deactivate() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (authWatchTimer) clearTimeout(authWatchTimer);
  if (sessionWatchTimer) clearTimeout(sessionWatchTimer);
  if (sessionWatcher) {
    sessionWatcher.close();
    sessionWatcher = null;
  }
  stopLoginWatcher();
  clearPostSwitchRefreshTimers();
  fs.unwatchFile(AUTH_PATH);
}

module.exports = {
  activate,
  deactivate,
  __test: {
    accountFromAuthPayload,
    accountProfileId,
    armAccountSwitchGuard,
    availablePercent,
    buildCodexLoginCommand,
    clearAuthPayload,
    clearAccountSwitchGuard,
    clearPostSwitchRefreshTimers,
    enforceAccountSwitchGuard,
    findCodexExecutable,
    formatContextQuota,
    getContextPercent,
    isPathInside,
    mergeAccountSnapshot,
    parseLatestStats,
    planDisplay,
    rateLimitFingerprint,
    resolveAccountTracking,
    schedulePostSwitchStatsRefresh,
    statsCutoffForAccount,
    statsBelongsToAnotherProfile,
    summarizeAuthFailure,
    statsFromProfileSnapshot,
    accountDisplayLabel,
    visibleAccountSnapshot,
    writeAuthPayloadAtomic
  }
};



