const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
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
  formatReset,
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
const {
  effectiveRefreshIntervalSeconds,
  planPolicyFrom
} = require('./plans/policy');
const i18n = require('./i18n');
const { t, languageTag, currentLanguageSetting, plural } = i18n;
let latestStats = null;
let currentPlanPolicy = planPolicyFrom(null, null);
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
let scheduledRefreshSeconds = 0;
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
  const quotaWindows = quotaWindowsFromRateLimits(stats.rateLimits);
  const primaryWindow = quotaWindows[0] || null;
  const secondaryWindow = quotaWindows[1] || null;
  return {
    quotaWindows: quotaWindows.length ? quotaWindows : existing.quotaWindows || [],
    primaryUsed: primaryWindow?.used_percent ?? stats.rateLimits?.primary?.used_percent ?? existing.primaryUsed ?? null,
    secondaryUsed: secondaryWindow?.used_percent ?? stats.rateLimits?.secondary?.used_percent ?? existing.secondaryUsed ?? null,
    primaryResetsAt: primaryWindow?.resets_at ?? stats.rateLimits?.primary?.resets_at ?? existing.primaryResetsAt ?? null,
    secondaryResetsAt: secondaryWindow?.resets_at ?? stats.rateLimits?.secondary?.resets_at ?? existing.secondaryResetsAt ?? null,
    primaryWindowMinutes: primaryWindow?.window_minutes ?? stats.rateLimits?.primary?.window_minutes ?? existing.primaryWindowMinutes ?? null,
    secondaryWindowMinutes: secondaryWindow?.window_minutes ?? stats.rateLimits?.secondary?.window_minutes ?? existing.secondaryWindowMinutes ?? null,
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
  const storedWindows = Array.isArray(snapshot.quotaWindows) ? snapshot.quotaWindows : [];
  const hasContext = finiteNumber(snapshot.contextUsed) !== null;
  if (!hasPrimary && !hasSecondary && !storedWindows.length && !hasContext && !snapshot.plan) return null;

  const primary = storedWindows[0] || (hasPrimary ? {
    used_percent: snapshot.primaryUsed,
    resets_at: snapshot.primaryResetsAt ?? null,
    window_minutes: snapshot.primaryWindowMinutes ?? 300
  } : null);
  const secondary = storedWindows[1] || (hasSecondary ? {
    used_percent: snapshot.secondaryUsed,
    resets_at: snapshot.secondaryResetsAt ?? null,
    window_minutes: snapshot.secondaryWindowMinutes ?? 10080
  } : null);

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
      secondary,
      windows: storedWindows
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

function planPolicyText(policy = currentPlanPolicy) {
  const es = languageTag() === 'es';
  if (!policy || policy.isPending) {
    return {
      title: es ? 'Detectando plan' : 'Detecting plan',
      detail: es
        ? 'Abre Codex o inicia un chat para que Codex Gestion lea primero el plan local y active la estrategia correcta.'
        : 'Open Codex or start a chat so Codex Gestion can read the local plan first and enable the right strategy.',
      action: es ? 'Buscar plan primero' : 'Find plan first'
    };
  }
  if (policy.shouldSuggestUpgrade) {
    return {
      title: es ? 'Plan de entrada' : 'Starter plan',
      detail: es
        ? 'Gestiono la extension con ritmo conservador y, al llegar al limite, priorizo esperar la renovacion o mejorar el plan.'
        : 'The extension uses a conservative rhythm and, at the limit, prioritizes waiting for reset or upgrading the plan.',
      action: es ? 'Esperar renovacion o mejorar plan' : 'Wait for reset or upgrade'
    };
  }
  if (policy.canBuyCredits) {
    return {
      title: es ? 'Plan con creditos flexibles' : 'Flexible credits plan',
      detail: es
        ? 'Si las cuotas se agotan, el panel orienta a usar creditos disponibles en Codex Settings > Usage.'
        : 'If quotas run out, the panel points to credits available from Codex Settings > Usage.',
      action: es ? 'Usar creditos cuando aplique' : 'Use credits when available'
    };
  }
  if (policy.adminManaged) {
    return {
      title: es ? 'Plan de workspace' : 'Workspace plan',
      detail: es
        ? 'La extension muestra cuotas locales y asume que limites, creditos y permisos pueden depender del administrador.'
        : 'The extension shows local quotas and assumes limits, credits, and permissions can depend on an admin.',
      action: es ? 'Revisar con admin si hay limite' : 'Check with admin at limit'
    };
  }
  return {
    title: es ? 'Plan observado' : 'Observed plan',
    detail: es
      ? 'La extension se adapta a las ventanas de cuota que Codex registra para esta cuenta.'
      : 'The extension adapts to the quota windows Codex records for this account.',
    action: es ? 'Seguir cuotas locales' : 'Follow local quotas'
  };
}
function planDisplay(stats) {
  const plan = stats?.rateLimits?.plan_type
    ? String(stats.rateLimits.plan_type).toUpperCase()
    : t('pending');
  if (!stats) return { label: plan, detail: t('localNoData') };
  if (stats.isSnapshotFallback) return { label: plan, detail: t('localSavedSummary') };
  return { label: plan, detail: t('localObservedData') };
}

const ACCOUNT_VISUAL_COLORS = [
  '#4ec9b0', '#60a5fa', '#c586c0', '#d7ba7d', '#89d185', '#f48771', '#b5cea8', '#9cdcfe'
];

function hashString(value) {
  let hash = 0;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function hexToRgb(hex) {
  const normalized = String(hex || '').replace('#', '');
  const value = Number.parseInt(normalized, 16);
  if (!Number.isFinite(value)) return { r: 78, g: 201, b: 176 };
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255
  };
}

function accountIdentityDetail(profile) {
  const pieces = [];
  if (profile?.email && profile.email !== profile.label) pieces.push(profile.email);
  if (profile?.name && profile.name !== profile.label && profile.name !== profile.email) pieces.push(profile.name);
  if (!pieces.length && profile?.accountSuffix) pieces.push(String(profile.mode || 'codex').toUpperCase() + ' ...' + profile.accountSuffix);
  return pieces.join(' - ') || t('accountDefault');
}

function accountVisual(profile) {
  const seed = profile?.id || profile?.email || profile?.label || 'codex';
  const color = ACCOUNT_VISUAL_COLORS[hashString(seed) % ACCOUNT_VISUAL_COLORS.length];
  const { r, g, b } = hexToRgb(color);
  const label = String(profile?.label || profile?.email || profile?.name || t('accountDefault')).trim();
  const source = label || accountIdentityDetail(profile);
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  const initials = (words.length >= 2 ? `${words[0][0]}${words[1][0]}` : source.slice(0, 2)).toUpperCase();
  return {
    color,
    background: `rgba(${r}, ${g}, ${b}, 0.16)`,
    border: `rgba(${r}, ${g}, ${b}, 0.55)`,
    initials: initials || 'C',
    detail: accountIdentityDetail(profile)
  };
}

function accountQuickPickItem(profile, activeId = '') {
  const snapshot = profile?.snapshot || {};
  const visual = accountVisual(profile);
  const status = profile.id === activeId
    ? t('currentAccount')
    : profile.credentialsStored
      ? t('savedAccountReadyLong')
      : t('historyOnlyNoCredential');
  const quotas = snapshotQuotaSummaries(snapshot);
  return {
    label: `${profile.id === activeId ? '$(check) ' : '$(circle-filled) '}${profile.label}`,
    description: status,
    detail: [visual.detail, ...quotas].filter(Boolean).join(' - '),
    action: 'profile',
    profileId: profile.id,
    credentialsStored: Boolean(profile.credentialsStored)
  };
}

function statsBelongsToAnotherProfile(profileId, profiles, stats) {
  if (!stats || stats.isSnapshotFallback || !stats.rateLimitFingerprint) return false;
  return profiles.some(profile =>
    profile.id !== profileId &&
    profile.snapshot?.rateLimitFingerprint === stats.rateLimitFingerprint
  );
}

function quotaWindowsFromRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return [];
  const reserved = new Set(['limit_id', 'plan_type', 'tier', 'account_id', 'organization_id']);
  const windows = [];
  const pushLimit = (key, value, fallbackIndex) => {
    if (!value || typeof value !== 'object') return;
    if (finiteNumber(value.used_percent) === null && finiteNumber(value.resets_at) === null) return;
    const windowMinutes = finiteNumber(value.window_minutes);
    windows.push({
      id: String(value.limit_id || value.id || key || 'quota-' + fallbackIndex),
      key: String(key || 'quota-' + fallbackIndex),
      used_percent: value.used_percent,
      resets_at: value.resets_at ?? null,
      window_minutes: windowMinutes,
      label: value.label || value.name || '',
      order: value === rateLimits.primary ? 0 : value === rateLimits.secondary ? 1 : fallbackIndex + 2
    });
  };

  if (Array.isArray(rateLimits.windows)) {
    rateLimits.windows.forEach((limit, index) => pushLimit(limit?.name || limit?.key, limit, index));
  }
  if (Array.isArray(rateLimits.quotas)) {
    rateLimits.quotas.forEach((limit, index) => pushLimit(limit?.name || limit?.key, limit, index + windows.length));
  }
  for (const [key, value] of Object.entries(rateLimits)) {
    if (reserved.has(key)) continue;
    if (Array.isArray(value)) {
      value.forEach((limit, index) => pushLimit(limit?.name || key + '-' + (index + 1), limit, index + windows.length));
      continue;
    }
    pushLimit(key, value, windows.length);
  }

  const seen = new Set();
  return windows
    .filter(limit => {
      const fingerprint = [limit.key, limit.window_minutes ?? '', limit.resets_at ?? ''].join(':');
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    })
    .sort((left, right) => {
      const leftMinutes = finiteNumber(left.window_minutes);
      const rightMinutes = finiteNumber(right.window_minutes);
      if (leftMinutes !== null && rightMinutes !== null && leftMinutes !== rightMinutes) {
        return leftMinutes - rightMinutes;
      }
      return left.order - right.order;
    });
}

function quotaWindowLabel(limit, index = 0) {
  if (limit?.label) return limit.label;
  const window = windowLabel(limit?.window_minutes);
  if (window !== 'limite') return window;
  if (limit?.key && !/^quota-\d+$/.test(limit.key)) return limit.key.replace(/_/g, ' ');
  return t('quotaNumber', { number: index + 1 });
}

function quotaWindowTitle(limit, index = 0) {
  return t('quotaOf', { window: quotaWindowLabel(limit, index) });
}

function quotaTone(limit) {
  const used = Number(limit?.used_percent);
  return Number(used) >= 90 ? 'danger' : Number(used) >= 75 ? 'warning' : 'accent';
}

function snapshotQuotaWindows(snapshot) {
  const stored = Array.isArray(snapshot?.quotaWindows) ? snapshot.quotaWindows : [];
  if (stored.length) return stored;
  const windows = [];
  if (snapshot?.primaryUsed != null) {
    windows.push({
      key: 'primary',
      used_percent: snapshot.primaryUsed,
      resets_at: snapshot.primaryResetsAt ?? null,
      window_minutes: snapshot.primaryWindowMinutes ?? 300
    });
  }
  if (snapshot?.secondaryUsed != null) {
    windows.push({
      key: 'secondary',
      used_percent: snapshot.secondaryUsed,
      resets_at: snapshot.secondaryResetsAt ?? null,
      window_minutes: snapshot.secondaryWindowMinutes ?? 10080
    });
  }
  return windows;
}

function snapshotQuotaSummaries(snapshot, maxItems = 2) {
  const windows = snapshotQuotaWindows(snapshot).slice(0, maxItems);
  if (!windows.length) return [t('quotaDataPending')];
  return windows.map((limit, index) => {
    const available = availablePercent(limit.used_percent);
    const value = available === null ? '--' : Math.round(available) + '% ' + t('free');
    return quotaWindowLabel(limit, index) + ': ' + value;
  });
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
  const quotaWindows = quotaWindowsFromRateLimits(rateLimits);
  const accountLabel = stats.accountLabel || t('accountDefault');
  const planInfo = planDisplay(stats);
  const updatedAt = new Date(lastRefreshAt || Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

  tooltip.appendMarkdown(
    `### $(account) ${escapeMarkdown(accountLabel)}\n\n` +
    `<sub>${escapeHtml(t('localPlan', { label: planInfo.label }))}</sub>\n\n` +
    `[$(dashboard) ${escapeMarkdown(t('openPanel'))}](command:codexGestion.showDashboard) &nbsp;&nbsp; ` +
    `[$(refresh) ${escapeMarkdown(t('refresh'))}](command:codexGestion.refresh)\n\n` +
    '---\n\n'
  );

  if (latestAuthStatus.state !== 'ok') {
    tooltip.appendMarkdown(
      `$(warning) **${escapeMarkdown(t('session'))}:** ${escapeMarkdown(latestAuthStatus.message || latestAuthStatus.state)}\n\n`
    );
  }

  const tooltipQuotas = quotaWindows.length ? quotaWindows : [rateLimits?.primary, rateLimits?.secondary].filter(Boolean);
  if (tooltipQuotas.length) {
    tooltipQuotas.forEach((limit, index) => {
      if (index > 0) tooltip.appendMarkdown('---\n\n');
      tooltip.appendMarkdown(formatTooltipQuota(quotaWindowTitle(limit, index), limit));
    });
    tooltip.appendMarkdown('---\n\n');
  } else {
    tooltip.appendMarkdown(escapeMarkdown(t('quotaDataPending')) + '\n\n---\n\n');
  }
  tooltip.appendMarkdown(
    `<sub>${escapeHtml(t('updated', { time: updatedAt }))} ` +
    `${stats.isSnapshotFallback ? `&nbsp;|&nbsp; ${escapeHtml(t('savedSummary'))} ` : ''}` +
    `&nbsp;|&nbsp; Codex Gestion v${escapeHtml(extensionContext.extension.packageJSON.version)}</sub>`
  );
  return tooltip;
}

function formatTooltipQuota(label, limit) {
  const used = finiteNumber(limit?.used_percent);
  const usedPercent = used === null ? null : clampPercent(used);
  const available = usedPercent === null ? null : 100 - usedPercent;
  const resetMoment = limit ? formatResetMoment(limit.resets_at) : t('noData');
  const resetFull = limit ? formatResetFull(limit.resets_at) : t('noData');

  if (usedPercent === null || available === null) {
    return (
      `**${escapeMarkdown(label)}**

` +
      `<sub>${escapeHtml(t('renewsFull', { time: resetFull }))} &nbsp;|&nbsp; ${escapeHtml(t('noVisualReading'))}</sub>

`
    );
  }

  const availableLabel = `${Math.round(available)}% ${t('free')}`;
  const usedLabel = `${Math.round(usedPercent)}% ${t('used')}`;
  return (
    `**${escapeMarkdown(label)}:** ${escapeMarkdown(availableLabel)}

` +
    `<sub>${escapeHtml(t('renewsFull', { time: resetFull }))} &nbsp;|&nbsp; ${escapeHtml(usedLabel)}</sub>

` +
    tooltipQuotaCard(label, usedPercent, available, resetMoment) +
    `

`
  );
}
function tooltipQuotaCard(label, usedPercent, availablePercentValue, resetLabel) {
  const used = Math.round(clampPercent(usedPercent));
  const available = Math.max(0, 100 - used);
  const tone = used >= 90 ? '#f48771' : used >= 75 ? '#cca700' : '#4ec9b0';
  const width = 304;
  const height = 86;
  const trackWidth = 272;
  const fillWidth = Math.max(4, Math.round((available / 100) * trackWidth));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" fill="#252526" stroke="#3c3c3c"/>
      <text x="14" y="23" fill="#f3f3f3" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700">${escapeHtml(label)}</text>
      <text x="290" y="23" fill="#a6a6a6" font-family="Segoe UI, Arial, sans-serif" font-size="10" text-anchor="end">${escapeHtml(resetLabel)}</text>
      <rect x="14" y="38" width="${trackWidth}" height="13" rx="6.5" fill="#3a3a3a"/>
      <rect x="14" y="38" width="${fillWidth}" height="13" rx="6.5" fill="${tone}"/>
      <text x="14" y="70" fill="#a6a6a6" font-family="Segoe UI, Arial, sans-serif" font-size="11">${escapeHtml(used)}% ${escapeHtml(t('used'))}</text>
      <text x="290" y="70" fill="#f3f3f3" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="700" text-anchor="end">${escapeHtml(available)}% ${escapeHtml(t('free'))}</text>
    </svg>`;
  const encoded = Buffer.from(svg, 'utf8').toString('base64');
  return `<img src="data:image/svg+xml;base64,${encoded}" alt="${escapeHtml(label)}: ${escapeHtml(available)}% ${escapeHtml(t('free'))}" width="${width}" height="${height}">`;
}

function tooltipQuotaBar(usedPercent, availablePercentValue) {
  if (usedPercent === null || availablePercentValue === null) {
    return `<sub>${escapeHtml(t('noVisualReading'))}</sub>`;
  }

  const used = Math.round(clampPercent(usedPercent));
  const available = Math.max(0, 100 - used);
  const totalSegments = 16;
  const availableSegments = Math.max(0, Math.min(totalSegments, Math.round((available / 100) * totalSegments)));
  const usedSegments = totalSegments - availableSegments;
  const bar = '#'.repeat(availableSegments) + '-'.repeat(usedSegments);

  return (
    `<code>[${bar}]</code> &nbsp; **${escapeHtml(available)}% ${escapeHtml(t('free'))}**\n\n` +
    `<sub>${escapeHtml(used)}% ${escapeHtml(t('used'))}</sub>`
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
      ? `$(error) **${escapeMarkdown(t('readUsageError'))}**  \n${escapeMarkdown(latestError.message)}\n\n`
      : `$(info) **${escapeMarkdown(t('noUsageYet'))}**  \n${escapeMarkdown(t('openCodexOrStart'))}\n\n`
  );
  tooltip.appendMarkdown(
    `[$(sign-in) ${escapeMarkdown(t('openCodex'))}](command:codexGestion.openCodex) &nbsp; ` +
    `[$(refresh) ${escapeMarkdown(t('refresh'))}](command:codexGestion.refresh) &nbsp; ` +
    `[$(dashboard) ${escapeMarkdown(t('openPanel'))}](command:codexGestion.showDashboard)`
  );
  if (latestError) {
    tooltip.appendMarkdown(
      `\n\n[$(output) ${escapeMarkdown(t('diagnostics'))}](command:codexGestion.showDiagnostics)`
    );
  }
  return tooltip;
}

function updateStatusBar(stats) {
  const authProblem = latestAuthStatus.state === 'invalid' || latestAuthStatus.state === 'missing';
  if (!stats) {
    statusItem.text = latestError
      ? `$(warning) ${t('codexStatsError')}`
      : authProblem
        ? `$(warning) ${t('codexNoSession')}`
        : `$(pulse) ${t('codexNoData')}`;
    statusItem.tooltip = buildEmptyTooltip();
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusItem.show();
    return;
  }

  const primary = quotaWindowsFromRateLimits(stats.rateLimits)[0] || stats.rateLimits?.primary;
  const pieces = [];

  const primaryAvailable = availablePercent(primary?.used_percent);
  if (primaryAvailable !== null) {
    const resetCountdown = finiteNumber(primary?.resets_at) && Number(primary.resets_at) * 1000 > Date.now()
      ? ` | ${formatReset(primary.resets_at)}`
      : '';
    pieces.push(`$(dashboard) ${formatPercent(primaryAvailable)} ${t('free')}${resetCountdown}`);
  }
  else pieces.push('$(pulse) Codex');

  statusItem.text = pieces.join(' | ');
  statusItem.tooltip = buildTooltip(stats);
  statusItem.accessibilityInformation = {
    label: t('accessibilityUsage', { summary: pieces.join(', ') })
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
    const refreshedProfile = account.hasCredentials
      ? getAccountProfiles().find(candidate => candidate.id === accountProfileId(account))
      : null;
    currentPlanPolicy = planPolicyFrom(latestStats, refreshedProfile);
    if (latestStats) {
      latestStats.accountLabel = refreshedProfile?.label || accountDisplayLabel(account);
    }
  } catch (error) {
    latestStats = null;
    latestError = error instanceof Error ? error : new Error(String(error));
    currentPlanPolicy = planPolicyFrom(null, null);
  } finally {
    lastRefreshDurationMs = Date.now() - startedAt;
    lastRefreshAt = Date.now();
    scheduleRefresh();
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
        : quotaWindowsFromRateLimits(latestStats.rateLimits)[0]
        ? (() => {
          const limit = quotaWindowsFromRateLimits(latestStats.rateLimits)[0];
          return `Datos actualizados: ${formatPercent(availablePercent(limit.used_percent))} disponible en ${quotaWindowTitle(limit, 0).toLowerCase()}.`;
        })()
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
    .map(profile => {
      const item = accountQuickPickItem(profile, activeId);
      return {
        ...item,
        description: profile.credentialsStored
          ? t('savedAccountReady')
          : t('historyOnly'),
        detail: `${accountVisual(profile).detail} - ${profile.credentialsStored ? `${t('lastUsed')}: ${new Date(profile.lastSeen).toLocaleString()}` : t('needsLoginAgain')}`
      };
    });

  if (!items.length) {
    const action = await vscode.window.showInformationMessage(
      t('noOtherAccount'),
      t('addAccount')
    );
    if (action === t('addAccount')) return addAccount();
    return;
  }

  const selected = await vscode.window.showQuickPick(items, {
    title: t('switchAccountTitle'),
    placeHolder: t('switchAccountPlaceholder')
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
      ? t('addAccountWithSave')
      : t('addAccountClean'),
    { modal: true },
    t('addAccount')
  );
  if (choice !== t('addAccount')) return;

  const storedProfileId = await storeCurrentCredentials();
  if (previousProfileId && storedProfileId !== previousProfileId) {
    vscode.window.showErrorMessage(
      t('cannotSaveCurrentAccount')
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
    message: t('waitingNewLogin')
  };
  startLoginWatcher(previousProfileId);
  await refresh(false);

  const terminal = vscode.window.createTerminal({
    name: t('addAccountTerminal'),
    isTransient: true
  });
  terminal.show(true);
  terminal.sendText(buildCodexLoginCommand(codexExecutable), true);
  if (!codexExecutable) {
    vscode.window.showWarningMessage(
      t('codexExecutableMissing')
    );
  }
  vscode.window.showInformationMessage(
    t('finishBrowserLogin')
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
      throw new Error(t('storedCredentialMismatch'));
    }
  } catch (error) {
    vscode.window.showErrorMessage(t('cannotRecoverAccount', { message: error.message }));
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
        t('restoredPreviousAccount', { reason: validation.reason }),
        t('loginAgain'),
        t('close')
      );
      if (action === t('loginAgain')) await addAccount();
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
        : t('sessionValidated')
    };
    await refresh(false);
    await updateProjectContextFile('account-switch');
    await new Promise(resolve => setTimeout(resolve, AUTO_SWITCH_RELOAD_DELAY_MS));
    enforceAccountSwitchGuard(AUTH_PATH, false);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  } catch (error) {
    clearAccountSwitchGuard(profileId);
    vscode.window.showErrorMessage(t('cannotSwitchAccount', { message: error.message }));
  }
}

async function handleMissingCredentials(profileId) {
  const profile = getAccountProfiles().find(candidate => candidate.id === profileId);
  if (!profile) return;

  const action = await vscode.window.showWarningMessage(
    t('missingEncryptedCredential', { label: profile.label }),
    t('signIn'),
    t('rename'),
    t('cancel')
  );
  if (action === t('signIn')) return addAccount();
  if (action === t('rename')) return renameAccount(profileId);
}

async function handleAccountCard(profileId) {
  const account = readCurrentAccount();
  const activeId = account.hasCredentials ? accountProfileId(account) : '';
  const profile = getAccountProfiles().find(candidate => candidate.id === profileId);
  if (!profile) return;

  const actions = [
    ...(profile.id !== activeId && profile.credentialsStored ? [{
      label: `$(arrow-swap) ${t('activateAccount')}`,
      action: 'switch'
    }] : []),
    ...(profile.id !== activeId && !profile.credentialsStored ? [{
      label: `$(sign-in) ${t('signInWithAccount')}`,
      description: t('saveCredentialAfterLogin'),
      action: 'login'
    }] : []),
    {
      label: `$(edit) ${t('changeName')}`,
      action: 'rename'
    },
    ...(profile.id !== activeId ? [{
      label: `$(trash) ${t('delete')}`,
      action: 'delete'
    }] : [])
  ];

  const selected = await vscode.window.showQuickPick(actions, {
    title: profile.label,
    placeHolder: t('accountActionPlaceholder')
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
    title: t('renameAccountTitle'),
    prompt: t('renameAccountPrompt'),
    value: profile.label,
    validateInput: value => value.trim() ? undefined : t('accountNameRequired')
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
      t('activeAccountCannotDelete')
    );
    return;
  }

  const profile = getAccountProfiles().find(candidate => candidate.id === profileId);
  if (!profile) return;
  const confirmation = await vscode.window.showWarningMessage(
    t('deleteAccountConfirm', { label: profile.label }),
    { modal: true },
    t('deleteAction')
  );
  if (confirmation !== t('deleteAction')) return;

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
    vscode.window.showInformationMessage(t('noInactiveAccounts'));
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    t('deleteInactiveConfirm', { count: inactiveCount, plural: plural(inactiveCount) }),
    { modal: true },
    t('deleteInactiveAction')
  );
  if (confirmation !== t('deleteInactiveAction')) return;

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
    `Plan policy: ${currentPlanPolicy.label} / ${currentPlanPolicy.family} / ${currentPlanPolicy.source}`,
    `Plan can buy credits: ${currentPlanPolicy.canBuyCredits}`,
    `Plan admin managed: ${currentPlanPolicy.adminManaged}`,
    `Effective refresh interval: ${scheduledRefreshSeconds || 'not scheduled'} s`,
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

function runGit(root, args, fallback = '') {
  if (!root) return fallback;
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true
    }).trim();
  } catch {
    return fallback;
  }
}

function getGitContextSummary(root) {
  const status = runGit(root, ['status', '--short', '--branch']);
  const statusLines = status ? status.split(/\r?\n/).filter(Boolean) : [];
  const branch = statusLines[0] || 'sin datos';
  const changes = statusLines.slice(1);
  const lastCommit = runGit(root, ['log', '-1', '--oneline'], 'sin datos');
  const recentCommitsRaw = runGit(root, ['log', '-3', '--oneline'], '');
  return {
    branch,
    lastCommit,
    recentCommits: recentCommitsRaw ? recentCommitsRaw.split(/\r?\n/).filter(Boolean).slice(0, 3) : [],
    dirtyCount: changes.length,
    dirtyPreview: changes.slice(0, 8)
  };
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function cleanContextLine(value, maxLength = 180) {
  return sanitizeContextExcerpt(value, maxLength)
    .replace(/^[\s\-*[\]xX.]+/, '')
    .replace(new RegExp(String.fromCharCode(96), 'g'), "'")
    .trim();
}

function getProjectIdentitySummary(root) {
  const packageJson = root ? readJsonFileSafe(path.join(root, 'package.json')) : null;
  return {
    name: packageJson?.displayName || packageJson?.name || 'Proyecto sin nombre detectado',
    description: packageJson?.description || 'Sin descripcion detectada',
    version: packageJson?.version || 'sin version detectada'
  };
}

function getRoadmapContextSummary(root, limit = 6) {
  if (!root) return { exists: false, items: [] };
  const roadmapPath = path.join(root, 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) return { exists: false, items: [] };
  try {
    const content = fs.readFileSync(roadmapPath, 'utf8');
    const items = [];
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*-\s+\[ \]\s+(.+)$/);
      if (!match) continue;
      const item = cleanContextLine(match[1]);
      if (item) items.push(item);
      if (items.length >= limit) break;
    }
    return { exists: true, items };
  } catch {
    return { exists: true, items: [] };
  }
}

function formatContextQuota(label, limit) {
  if (!limit) return `- ${label}: pendiente de recoger datos; abre Codex con esta cuenta o inicia un chat nuevo`;
  const available = availablePercent(limit.used_percent);
  const reset = finiteNumber(limit.resets_at)
    ? formatResetFull(limit.resets_at)
    : 'sin renovacion registrada';
  const freshness = finiteNumber(limit.resets_at) && Number(limit.resets_at) * 1000 <= Date.now()
    ? '; ojo: el dato puede estar antiguo'
    : '';
  return `- ${label}: ${formatPercent(available)} disponible; se renueva ${reset}${freshness}`;
}

function formatContextQuotas(rateLimits) {
  const windows = quotaWindowsFromRateLimits(rateLimits);
  if (!windows.length) {
    return ['- Cuotas locales: pendiente de recoger datos; abre Codex con esta cuenta o inicia un chat nuevo'];
  }
  return windows.map((limit, index) => formatContextQuota(quotaWindowTitle(limit, index), limit));
}

function formatContextPercent(stats) {
  const percent = getContextPercent(stats);
  if (percent === null) return '- Contexto usado del chat actual: sin datos locales';
  return `- Contexto usado del chat actual: ${formatPercent(percent)}`;
}
function projectContextIncludesSessionExcerpts() {
  return Boolean(vscode.workspace.getConfiguration('codexGestion').get('projectContext.includeSessionExcerpts', true));
}

function sanitizeContextExcerpt(value, maxLength = 520) {
  const text = String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return '';
  const redacted = text
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[redacted-token]')
    .replace(/(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/g, '[redacted-jwt]')
    .replace(/(access_token|refresh_token|id_token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1).trim()}...` : redacted;
}

function collectTextValues(value, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => collectTextValues(item, depth + 1));
  if (typeof value !== 'object') return [];

  const directKeys = ['text', 'content', 'message', 'summary', 'command', 'cmd', 'stderr', 'stdout', 'error'];
  const direct = [];
  for (const key of directKeys) {
    if (typeof value[key] === 'string') direct.push(value[key]);
  }
  if (direct.length) return direct;

  return Object.values(value).flatMap(item => collectTextValues(item, depth + 1));
}

function classifySessionEvent(event) {
  const blob = JSON.stringify(event).toLowerCase();
  if (/tool|command|exec|terminal|apply_patch|patch/.test(blob)) return 'tool';
  if (/assistant|agent|codex/.test(blob)) return 'assistant';
  if (/user|prompt|input/.test(blob)) return 'user';
  return 'event';
}

function extractSessionConversationItems(filePath, limit = 8) {
  let raw = '';
  try {
    const stat = fs.statSync(filePath);
    const bytes = Math.min(stat.size, 768 * 1024);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
      raw = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }

  const items = [];
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0 && items.length < limit; index -= 1) {
    const line = lines[index].trim();
    if (!line || line.length < 3) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.payload?.type === 'token_count' || event?.type === 'session_meta') continue;
    const texts = collectTextValues(event.payload ?? event)
      .map(text => sanitizeContextExcerpt(text))
      .filter(text => text && !/^\{.*\}$/.test(text))
      .filter(text => !/^\d{4}-\d{2}-\d{2}T/.test(text))
      .filter(text => !/^[a-z_]+$/.test(text));
    if (!texts.length) continue;
    const unique = [...new Set(texts)].slice(0, 2).join('\n');
    const excerpt = sanitizeContextExcerpt(unique);
    if (!excerpt || excerpt.length < 12) continue;
    items.push({
      role: classifySessionEvent(event),
      timestamp: event.timestamp || event.time || '',
      excerpt
    });
  }
  return items.reverse();
}

function buildDecisionSignalsSection(workspaceRoot, identity) {
  const lines = [
    '### Objetivo y decisiones inferidas',
    '',
    `- Objetivo probable: mantener y evolucionar ${identity.name} (${identity.description}).`
  ];

  if (!projectContextIncludesSessionExcerpts()) {
    lines.push('- Senales conversacionales desactivadas por configuracion.');
    return lines;
  }

  const files = getSessionFiles(SESSION_ROOT, 0) || [];
  const workspaceNormalized = workspaceRoot ? normalizeFsPath(workspaceRoot) : '';
  const selected = files.slice(0, 30).map(file => {
    const meta = readSessionMeta(file.path) || {};
    const cwd = meta.cwd || meta.workspace || '';
    const sameWorkspace = workspaceNormalized && cwd && normalizeFsPath(cwd) === workspaceNormalized;
    return { ...file, sameWorkspace };
  }).sort((left, right) => Number(right.sameWorkspace) - Number(left.sameWorkspace) || right.mtimeMs - left.mtimeMs).slice(0, 3);

  const signalPattern = /quiero|vamos|perfecto|decid|licencia|release|marketplace|idioma|contexto|cuenta|build|vsix|readme|roadmap/i;
  const signals = [];
  for (const file of selected) {
    for (const item of extractSessionConversationItems(file.path, 10)) {
      if (!signalPattern.test(item.excerpt)) continue;
      const excerpt = sanitizeContextExcerpt(item.excerpt.replace(/\n/g, ' '), 220);
      if (excerpt && !signals.includes(excerpt)) signals.push(excerpt);
      if (signals.length >= 5) break;
    }
    if (signals.length >= 5) break;
  }

  if (!signals.length) {
    lines.push('- No se detectaron decisiones recientes claras en las sesiones locales.');
    return lines;
  }

  lines.push('- Senales recientes detectadas en sesiones locales:');
  for (const signal of signals) lines.push(`  - ${signal}`);
  return lines;
}

function buildSessionContinuitySection(workspaceRoot) {
  if (!projectContextIncludesSessionExcerpts()) {
    return [
      '### Continuidad conversacional local',
      '',
      '- Extractos de sesiones locales desactivados por configuracion (`codexGestion.projectContext.includeSessionExcerpts`).'
    ];
  }

  const files = getSessionFiles(SESSION_ROOT, 0) || [];
  const workspaceNormalized = workspaceRoot ? normalizeFsPath(workspaceRoot) : '';
  const scored = files.slice(0, 30).map(file => {
    const meta = readSessionMeta(file.path) || {};
    const cwd = meta.cwd || meta.workspace || '';
    const sameWorkspace = workspaceNormalized && cwd && normalizeFsPath(cwd) === workspaceNormalized;
    return { ...file, meta, sameWorkspace };
  }).sort((left, right) => Number(right.sameWorkspace) - Number(left.sameWorkspace) || right.mtimeMs - left.mtimeMs);

  const selected = scored.slice(0, 3);
  const lines = [
    '### Continuidad conversacional local',
    '',
    '- Fuente: extractos recientes de sesiones locales de Codex. Todo queda en este equipo y se recorta/sanea antes de escribirse.',
    '- No es un resumen inteligente completo; es una ayuda para que el siguiente chat vea los ultimos temas tratados.'
  ];

  if (!selected.length) {
    lines.push('- No se encontraron sesiones locales de Codex.');
    return lines;
  }

  for (const file of selected) {
    const label = file.sameWorkspace ? 'workspace actual' : 'sesion reciente';
    lines.push('', `#### ${label} - ${new Date(file.mtimeMs).toLocaleString()}`);
    const items = extractSessionConversationItems(file.path, 6);
    if (!items.length) {
      lines.push('- Sin mensajes reutilizables detectados en la cola de la sesion.');
      continue;
    }
    for (const item of items) {
      const stamp = item.timestamp ? ` (${new Date(item.timestamp).toLocaleString()})` : '';
      lines.push(`- ${item.role}${stamp}: ${item.excerpt.replace(/\n/g, '\n  ')}`);
    }
  }

  return lines;
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
  const git = getGitContextSummary(workspaceRoot);
  const roadmap = getRoadmapContextSummary(workspaceRoot);
  const identity = getProjectIdentitySummary(workspaceRoot);
  const plan = latestStats ? planDisplay(latestStats) : null;
  const planStrategy = planPolicyText(currentPlanPolicy);
  const localDataAge = latestStats?.timestamp
    ? `${new Date(latestStats.timestamp).toLocaleString()}`
    : 'sin datos';
  const dirtySummary = git.dirtyCount
    ? `${git.dirtyCount} cambio${git.dirtyCount === 1 ? '' : 's'} sin commit`
    : 'limpio';
  const dirtyPreview = git.dirtyPreview.length
    ? git.dirtyPreview.map(line => `  - ${line}`)
    : ['  - sin cambios locales detectados'];
  const recentCommits = git.recentCommits.length
    ? git.recentCommits.map(line => `  - ${line}`)
    : ['  - sin commits recientes detectados'];
  const roadmapItems = roadmap.items.length
    ? roadmap.items.map(item => `  - ${item}`)
    : [roadmap.exists ? '  - ROADMAP.md existe, pero no hay tareas pendientes marcadas.' : '  - No se encontro ROADMAP.md; revisar README/CHANGELOG y estado Git.'];

  return [
    PROJECT_CONTEXT_START,
    '## Resumen automatico para continuar',
    '',
    '### Proyecto',
    '',
    `- Carpeta/workspace: ${workspaceName}`,
    `- Nombre detectado: ${identity.name}`,
    `- Descripcion detectada: ${identity.description}`,
    `- Version del proyecto: ${identity.version}`,
    `- Actualizado por Codex Gestion: ${new Date().toLocaleString()}`,
    `- Motivo: ${reasonLabel}`,
    `- Extension: Codex Gestion v${extensionContext.extension.packageJSON.version}`,
    '',
    '### Cuenta y cuotas locales',
    '',
    `- Cuenta activa al generar este contexto: ${accountLabel}`,
    `- Estado de sesion: ${latestAuthStatus.state} - ${latestAuthStatus.message}`,
    ...formatContextQuotas(limits),
    plan ? `- Plan local observado: ${plan.label} (${plan.detail})` : '- Plan local observado: pendiente de recoger datos',
    `- Estrategia segun plan: ${planStrategy.title} - ${planStrategy.action}`,
    `- Ultimo dato local de Codex: ${localDataAge}`,
    `- Sesiones locales activas detectadas: ${latestStats?.activeSessions || 0}`,
    formatContextPercent(latestStats),
    '',
    '### Estado Git al generar contexto',
    '',
    `- Rama/estado: ${git.branch}`,
    `- Ultimo commit: ${git.lastCommit}`,
    `- Working tree: ${dirtySummary}`,
    ...dirtyPreview,
    '',
    '### Cambios recientes del repo',
    '',
    ...recentCommits,
    '',
    '### Proximos pasos probables',
    '',
    '- Detectados desde ROADMAP.md y el estado actual del repositorio:',
    ...roadmapItems,
    '',
    ...buildDecisionSignalsSection(workspaceRoot, identity),
    '',
    '### Lectura automatica por Codex',
    '',
    '- Codex lee automaticamente AGENTS.md al iniciar una sesion, pero no se puede asumir que lea PROJECT_CONTEXT.md si nadie se lo abre, pega o referencia.',
    '- Para continuidad automatica, crea un AGENTS.md pequeno en la raiz que pida leer .codex-gestion/PROJECT_CONTEXT.md antes de trabajar.',
    '- Este archivo sigue siendo util como handoff manual: abrelo desde el panel o copia el prompt final en otro chat/cuenta.',
    '',
    ...buildSessionContinuitySection(workspaceRoot),
    '',
    '### Para el siguiente chat/cuenta',
    '',
    '- Lee primero este bloque automatico: proyecto, Git, proximos pasos y continuidad conversacional local.',
    '- Antes de cambiar archivos, ejecuta `git status --short --branch` y revisa si hay cambios sin commit.',
    '- Si vienes de otra cuenta, no asumas que las cuotas o contexto de chat se suman; continua desde este documento y desde el repo.',
    '- Si el dato de cuota aparece vencido o antiguo, abre Codex con la cuenta activa e inicia/continua un chat para refrescar estadisticas.',
    '',
    '> Este bloque lo regenera Codex Gestion. No incluye credenciales, tokens, mensajes privados ni contenido completo de chats.',
    PROJECT_CONTEXT_END
  ].join('\n');
}
function buildInitialProjectContext(reason) {
  return [
    '# Contexto de continuidad para Codex',
    '',
    buildProjectContextAutoBlock(reason),
    '',
    '## Como usar este archivo',
    '',
    '- Este documento lo mantiene Codex Gestion para continuar trabajo entre chats o cuentas.',
    '- El bloque automatico recoge estado local, Git, cuotas, roadmap y extractos recientes de sesiones locales.',
    '- No hace falta rellenarlo manualmente: el objetivo es que el siguiente chat tenga una lectura rapida del estado real del repo.',
    '- Codex no lee este archivo por si solo salvo que se lo abras, lo pegues o lo referencies desde una instruccion automatica como AGENTS.md.',
    '',
    '## Archivos importantes detectados para este proyecto',
    '',
    '- `src/runtime.js`: panel, cuentas, contexto y flujo principal.',
    '- `src/i18n.js`: textos traducidos de la interfaz.',
    '- `package.json`: comandos, version, publisher y configuracion de VS Code.',
    '- `README.md` / `CHANGELOG.md` / `LICENSE`: documentacion publica y Marketplace.',
    '- `tests/`: pruebas automaticas y smoke test.',
    '',
    '## Notas manuales opcionales',
    '',
    '- Anota aqui solo lo que no aparezca en el resumen automatico.',
    '',
    '## Prompt para continuar en otro chat o cuenta',
    '',
    'Copia desde aqui cuando quieras continuar con otra cuenta o chat:',
    '',
    '```text',
    'Continua este proyecto usando .codex-gestion/PROJECT_CONTEXT.md como contexto principal. Lee el resumen automatico, revisa Git, proximos pasos y extractos de sesiones locales, y antes de editar ejecuta git status --short --branch. No asumas que las cuotas o el contexto del chat anterior se suman al cambiar de cuenta.',
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
  const displayValue = value ?? t('unavailable');
  return `
    <section class="metric-card ${tone}" data-chart-card data-available="${escapeHtml(normalized)}" data-used="${escapeHtml(used)}" data-tone="${escapeHtml(tone)}">
      <div class="metric-chart-wrap" role="img" aria-label="${escapeHtml(label)}: ${escapeHtml(t('availableValue', { value: Math.round(normalized) + '%' }))}">
        <canvas class="metric-chart" width="144" height="144"></canvas>
        <div class="metric-center">
          <strong>${Number.isFinite(Number(percent)) ? `${Math.round(Number(percent))}%` : '--'}</strong>
          <span>${escapeHtml(t('free'))}</span>
        </div>
      </div>
      <div class="metric-copy">
        <div class="metric-top">
          <span class="metric-label">${escapeHtml(label)}</span>
        </div>
        <strong class="metric-value">${escapeHtml(displayValue)}</strong>
        <div class="quota-legend">
          <span><i class="legend-dot free"></i>${escapeHtml(Math.round(normalized))}% ${escapeHtml(t('free'))}</span>
          <span><i class="legend-dot used"></i>${escapeHtml(Math.round(used))}% ${escapeHtml(t('used'))}</span>
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
    return `<p class="empty">${escapeHtml(t('noAccountsDetected'))}</p>`;
  }

  return profiles.map(profile => {
    const snapshot = visibleAccountSnapshot(profile, profiles, activeProfileId);
    const quotaSummaries = snapshotQuotaWindows(snapshot).slice(0, 2);
    const isActive = profile.id === activeProfileId;
    const plan = snapshot?.plan
      ? `Plan local ${String(snapshot.plan).toUpperCase()}`
      : t('localPlanPending');
    const visual = accountVisual(profile);
    const statusBadge = isActive
      ? `<span class="badge">${escapeHtml(t('activeNow'))}</span>`
      : profile.credentialsStored
        ? `<span class="badge muted">${escapeHtml(t('readyToUse'))}</span>`
        : `<span class="badge muted">${escapeHtml(t('historyOnly'))}</span>`;
    const cardTitle = isActive
      ? t('manageActiveAccount')
      : profile.credentialsStored
        ? t('activateOrManageAccount')
        : t('manageAccountHistory');
    const style = ` style="--account-color: ${escapeHtml(visual.color)}; --account-bg: ${escapeHtml(visual.background)}; --account-border: ${escapeHtml(visual.border)};"`;
    const cardAction = ` data-action="accountCard" data-profile="${escapeHtml(profile.id)}" role="button" tabindex="0" title="${escapeHtml(cardTitle)}"`;
    return `
      <article class="account-card ${isActive ? 'active' : 'selectable'}"${style}${cardAction}>
        <div class="account-main">
          <div class="account-avatar" aria-hidden="true">${escapeHtml(visual.initials)}</div>
          <div class="account-copy">
            <div class="account-title">
              <strong>${escapeHtml(profile.label)}</strong>
              ${statusBadge}
            </div>
            <span class="account-detail">${escapeHtml(visual.detail)}</span>
            <span class="account-plan">${escapeHtml(String(profile.mode).toUpperCase())} - ${escapeHtml(plan)}</span>
          </div>
        </div>
        <div class="account-usage">
          ${quotaSummaries.length ? quotaSummaries.map((limit, index) => {
            const available = availablePercent(limit.used_percent);
            return `<div><small>${escapeHtml(quotaWindowLabel(limit, index))}</small><strong>${available == null ? escapeHtml(t('pending')) : `${Math.round(available)}% ${escapeHtml(t('free'))}`}</strong></div>`;
          }).join('') : `<div><small>${escapeHtml(t('quotas'))}</small><strong>${escapeHtml(t('pending'))}</strong></div>`}
        </div>
        <small class="account-seen">${escapeHtml(t('lastUsed'))}: ${escapeHtml(new Date(profile.lastSeen).toLocaleString())}</small>
        <div class="account-actions">
          <button class="small secondary" data-action="renameAccount" data-profile="${escapeHtml(profile.id)}">${escapeHtml(t('rename'))}</button>
          ${isActive
            ? `<span class="active-note">${escapeHtml(t('accountInUse'))}</span>`
            : `<button class="small danger-button" data-action="forgetAccount" data-profile="${escapeHtml(profile.id)}">${escapeHtml(t('delete'))}</button>`}
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

function languageSelectorHtml() {
  const selected = currentLanguageSetting();
  const options = [
    ['auto', t('languageAuto')],
    ['es', t('languageSpanish')],
    ['en', t('languageEnglish')]
  ];
  const buttons = options.map(([value, label]) => {
    const active = selected === value;
    return `<button class="${active ? 'active' : ''}" data-action="setLanguage" data-language="${escapeHtml(value)}" aria-pressed="${active ? 'true' : 'false'}">${escapeHtml(label)}</button>`;
  }).join('');
  return `<div class="language-selector" role="group" aria-label="${escapeHtml(t('languageSelector'))}" title="${escapeHtml(t('languageSelector'))}">${buttons}</div>`;
}

async function setDashboardLanguage(value) {
  if (!['auto', 'es', 'en'].includes(value)) return;
  await vscode.workspace.getConfiguration('codexGestion').update('language', value, vscode.ConfigurationTarget.Global);
  updateStatusBar(latestStats);
  updateDashboard(true);
}

function dashboardHtml(webview) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const extensionRoot = extensionContext.extensionPath || path.resolve(__dirname, '..');
  const chartScriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionRoot, 'media', 'chart.umd.min.js')));
  const account = readCurrentAccount();
  const activeProfileId = account.hasCredentials ? accountProfileId(account) : '';
  const limits = latestStats?.rateLimits || {};
  const quotaWindows = quotaWindowsFromRateLimits(limits);
  const displayedQuotaWindows = quotaWindows.length ? quotaWindows : [limits.primary, limits.secondary].filter(Boolean);
  const advice = getUsageAdvice(latestStats, latestAuthStatus);
  const profiles = getAccountProfiles();
  const activeProfile = profiles.find(profile => profile.id === activeProfileId);
  const resetCandidates = displayedQuotaWindows
    .map(limit => Number(limit?.resets_at))
    .filter(value => Number.isFinite(value) && value * 1000 > Date.now());
  const nextReset = resetCandidates.length ? Math.min(...resetCandidates) : null;
  const stateTitle = latestError
    ? t('cannotReadCodexUsage')
    : latestAuthStatus.state === 'invalid'
      ? t('codexSessionInvalid')
      : latestAuthStatus.state === 'missing'
        ? t('signInCodex')
        : latestStats
          ? latestStats.isSnapshotFallback
            ? t('lastSavedSummary')
            : t('usageExplained')
          : account.hasCredentials
            ? t('collectingAccountData')
            : t('signInCodex');
  const stateDetail = latestError
    ? latestError.message
    : latestAuthStatus.state === 'invalid' || latestAuthStatus.state === 'missing'
      ? latestAuthStatus.message
      : latestStats
        ? latestStats.isSnapshotFallback
          ? t('savedAt', { time: new Date(latestStats.timestamp).toLocaleString() })
          : t('updatedAt', { time: new Date(latestStats.timestamp).toLocaleString() })
        : account.hasCredentials
          ? t('openCodexForAccountData')
          : t('openOfficialCodexLogin');
  const accountLabel = activeProfile?.label ||
    latestStats?.accountLabel ||
    (account.hasCredentials ? accountDisplayLabel(account) : t('noSession'));
  const activeVisual = accountVisual(activeProfile || {
    id: activeProfileId || account.id || accountLabel,
    label: accountLabel,
    email: account.email || '',
    name: account.name || '',
    mode: account.mode || 'codex',
    accountSuffix: account.id ? account.id.slice(-6) : ''
  });
  const planInfo = planDisplay(latestStats);
  const planStrategy = planPolicyText(currentPlanPolicy);
  const panelSessionNotice = account.hasCredentials
    ? `<div class="notice warning-notice"><strong>${escapeHtml(t('activeLocalAccount'))}</strong>${escapeHtml(t('activeLocalAccountDetail'))}</div>`
    : '';
  const authNotice = latestAuthStatus.state === 'invalid' || latestAuthStatus.state === 'missing'
    ? `<div class="notice danger-notice"><strong>${escapeHtml(t('codexSession'))}</strong>${escapeHtml(latestAuthStatus.message)} ${escapeHtml(t('recoverSession'))}</div>`
    : latestAuthStatus.state === 'skipped' || latestAuthStatus.state === 'unknown'
      ? `<div class="notice warning-notice"><strong>${escapeHtml(t('pendingCheck'))}</strong>${escapeHtml(latestAuthStatus.message)}</div>`
      : '';

  return `<!DOCTYPE html>
  <html lang="${languageTag()}">
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
      .header-controls {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
      }
      .header-language {
        display: flex;
        justify-content: flex-end;
      }
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
      .language-selector {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        margin-left: 2px;
        padding: 2px;
        border: 1px solid var(--vscode-widget-border);
        border-radius: 8px;
        background: transparent;
      }
      .language-selector button {
        min-width: 34px;
        padding: 5px 7px;
        border-color: transparent;
        border-radius: 6px;
        color: var(--vscode-descriptionForeground);
        background: transparent;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0;
      }
      .language-selector button:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
      .language-selector button.active {
        color: var(--vscode-foreground);
        background: var(--vscode-toolbar-hoverBackground);
        box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 14px;
      }
      .metric-card, .account-card, .notice, .identity, .plan-strategy {
        border: 1px solid var(--vscode-widget-border);
        border-radius: 14px;
        background: var(--vscode-editorWidget-background);
        box-shadow: 0 8px 28px var(--vscode-widget-shadow);
      }
      .onboarding {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 18px;
        align-items: center;
        padding: 18px;
        margin-bottom: 16px;
        border: 1px solid var(--vscode-focusBorder);
        border-radius: 14px;
        background: var(--vscode-editorWidget-background);
        box-shadow: 0 8px 28px var(--vscode-widget-shadow);
      }
      .onboarding h2 { margin: 0 0 6px; }
      .onboarding p { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.45; }
      .onboarding-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
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
        border: 1px solid var(--account-border, var(--vscode-focusBorder));
        color: var(--account-color, var(--vscode-button-foreground));
        background: var(--account-bg, var(--vscode-button-background));
        font-size: 17px;
        font-weight: 800;
        letter-spacing: 0;
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
      .plan-strategy {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        align-items: center;
        padding: 14px 18px;
        margin-bottom: 16px;
      }
      .plan-strategy strong, .plan-strategy span { display: block; }
      .plan-strategy small { justify-self: end; font-weight: 700; }
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
      .account-card.active { border-color: var(--account-color, var(--vscode-focusBorder)); }
      .account-card.selectable { cursor: pointer; }
      .account-card.selectable:hover {
        border-color: var(--vscode-focusBorder);
        background: var(--vscode-list-hoverBackground);
      }
      .account-card.selectable:focus-visible {
        outline: 2px solid var(--vscode-focusBorder);
        outline-offset: 2px;
      }
      .account-main { display: flex; align-items: center; gap: 12px; min-width: 0; }
      .account-avatar {
        flex: 0 0 auto;
        width: 42px;
        height: 42px;
        display: grid;
        place-items: center;
        border-radius: 12px;
        border: 1px solid var(--account-border);
        color: var(--account-color);
        background: var(--account-bg);
        font-size: 15px;
        font-weight: 800;
        letter-spacing: 0;
      }
      .account-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .account-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
      .account-title strong { font-size: 14px; }
      .account-detail, .account-plan { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .account-detail { color: var(--vscode-foreground) !important; opacity: .88; }
      .account-plan { font-size: 12px; }
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
        .header-controls, .header-language { align-items: flex-start; justify-content: flex-start; }
        .header-controls { width: 100%; }
        .account-card { grid-template-columns: 1fr; }
        .account-usage, .account-seen, .account-actions { grid-column: 1; }
        .account-actions { justify-content: flex-start; flex-wrap: wrap; }
        .metric-card { grid-template-columns: 1fr; }
        .metric-chart-wrap { margin: 0 auto; }
        .accounts-heading { align-items: flex-start; flex-direction: column; }
        .recommendation { grid-template-columns: auto 1fr; }
        .onboarding { grid-template-columns: 1fr; }
        .onboarding-actions { justify-content: flex-start; }
        .next-reset { grid-column: 1 / -1; text-align: left; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <span class="version">Codex Gestion v${escapeHtml(extensionContext.extension.packageJSON.version)}</span>
          <h1>${escapeHtml(t('dashboardTitle'))}</h1>
          <p class="subtitle">${escapeHtml(stateTitle)}. ${escapeHtml(stateDetail)}</p>
        </div>
        <div class="header-controls">
          <div class="header-language">${languageSelectorHtml()}</div>
          <div class="actions">
            <button data-action="refresh">${escapeHtml(t('refresh'))}</button>
            <button class="secondary" data-action="projectContext">${escapeHtml(t('projectContext'))}</button>
            <button class="secondary" data-action="accounts">${escapeHtml(t('manageAccounts'))}</button>
            <button class="secondary" data-action="openCodex">${escapeHtml(t('openCodex'))}</button>
          </div>
        </div>
      </header>

      ${latestError ? `<div class="notice"><strong>${escapeHtml(t('readError'))}</strong>${escapeHtml(latestError.message)}</div>` : ''}
      ${authNotice}
      ${panelSessionNotice}

      ${!latestStats ? `
      <section class="onboarding">
        <div>
          <h2>${escapeHtml(t('onboardingTitle'))}</h2>
          <p>${escapeHtml(t('onboardingDetail'))}</p>
        </div>
        <div class="onboarding-actions">
          <button data-action="openCodex">${escapeHtml(t('onboardingOpenCodex'))}</button>
          <button class="secondary" data-action="accounts">${escapeHtml(t('onboardingAccounts'))}</button>
          <button class="secondary" data-action="projectContext">${escapeHtml(t('onboardingContext'))}</button>
        </div>
      </section>` : ''}

      <section class="recommendation ${escapeHtml(advice.tone)}">
        <div class="recommendation-icon">${advice.tone === 'good' ? '&#10003;' : '!'}</div>
        <div class="recommendation-copy">
          <strong>${escapeHtml(advice.title)}</strong>
          <span>${escapeHtml(advice.detail)}</span>
        </div>
        <div class="next-reset">
          <span>${escapeHtml(t('nextReset'))}</span>
          <strong>${nextReset ? escapeHtml(formatResetMoment(nextReset)) : escapeHtml(t('noData'))}</strong>
        </div>
      </section>

      <section class="identity">
        <div class="identity-main">
          <div class="avatar" style="--account-color: ${escapeHtml(activeVisual.color)}; --account-bg: ${escapeHtml(activeVisual.background)}; --account-border: ${escapeHtml(activeVisual.border)};" aria-hidden="true">${escapeHtml(activeVisual.initials)}</div>
          <div class="identity-copy">
            <strong>${escapeHtml(accountLabel)}</strong>
            <span>${escapeHtml(t('accountUsedByNewChats'))}</span>
          </div>
        </div>
        <span class="plan-pill">${escapeHtml(t('localPlan', { label: planInfo.label }))} - ${escapeHtml(planInfo.detail)}</span>
      </section>

      <section class="plan-strategy">
        <div>
          <strong>${escapeHtml(planStrategy.title)}</strong>
          <span>${escapeHtml(planStrategy.detail)}</span>
        </div>
        <small>${escapeHtml(planStrategy.action)}</small>
      </section>

      <div class="metrics">
        ${displayedQuotaWindows.length ? displayedQuotaWindows.map((limit, index) => {
          const available = availablePercent(limit?.used_percent);
          return metricCard(
            quotaWindowTitle(limit, index),
            available == null ? t('pending') : t('availableValue', { value: formatPercent(available) }),
            available,
            limit ? t('renewsFull', { time: formatResetFull(limit.resets_at) }) : t('pendingAccountData'),
            index === 0 ? t('shortQuotaHint') : t('longQuotaHint'),
            quotaTone(limit)
          );
        }).join('') : metricCard(
          t('quotaDataPending'),
          t('pending'),
          null,
          t('pendingAccountData'),
          t('openCodexForAccountData'),
          'accent'
        )}
      </div>

      <h2>${escapeHtml(t('whatDataMeans'))}</h2>
      <div class="explain-grid">
        <div class="explain-card">
          <strong>${escapeHtml(t('shortQuotaAvailable'))}</strong>
          ${escapeHtml(t('shortQuotaExplanation'))}
        </div>
        <div class="explain-card">
          <strong>${escapeHtml(t('longQuotaAvailable'))}</strong>
          ${escapeHtml(t('longQuotaExplanation'))}
        </div>
      </div>

      <div class="accounts-heading">
        <div>
          <h2>${escapeHtml(t('accountManagement'))}</h2>
          <p class="subtitle">${escapeHtml(t('accountsDetected', { count: profiles.length, plural: plural(profiles.length) }))}</p>
        </div>
        <div class="actions">
          <button class="secondary" data-action="switchAccount">${escapeHtml(t('switchAccount'))}</button>
          <button class="secondary" data-action="addAccount">${escapeHtml(t('addAccount'))}</button>
          ${profiles.some(profile => profile.id !== activeProfileId)
            ? `<button class="danger-button" data-action="clearInactiveAccounts">${escapeHtml(t('clearInactive'))}</button>`
            : ''}
        </div>
      </div>
      <div class="accounts">${accountCards(activeProfileId)}</div>

      <p class="footnote">
        ${escapeHtml(t('credentialsFootnote'))}
      </p>
      <div class="meta-row">
        <span>${latestStats?.isSnapshotFallback ? escapeHtml(t('savedSummary')) : escapeHtml(t('latestCodexData'))}: ${latestStats ? escapeHtml(new Date(latestStats.timestamp).toLocaleString()) : escapeHtml(t('noData'))}</span>
        <span>${escapeHtml(t('checkedByExtension'))}: ${lastRefreshAt ? escapeHtml(new Date(lastRefreshAt).toLocaleTimeString()) : escapeHtml(t('noData'))}</span>
        <span>${escapeHtml(t('activeLocalSessions'))}: ${latestStats?.activeSessions || 0}</span>
        <span>${escapeHtml(t('readCompletedIn'))}: ${lastRefreshDurationMs} ms</span>
      </div>
      <div class="actions">
        <button class="secondary" data-action="diagnostics">${escapeHtml(t('technicalDiagnostics'))}</button>
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
            labels: [${JSON.stringify(t('free'))}, ${JSON.stringify(t('used'))}],
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
          profileId: target.dataset.profile || null,
          language: target.dataset.language || null
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
    quotaWindows: quotaWindowsFromRateLimits(latestStats?.rateLimits),
    primary: latestStats?.rateLimits?.primary || null,
    secondary: latestStats?.rateLimits?.secondary || null,
    plan: latestStats?.rateLimits?.plan_type || null,
    planPolicy: currentPlanPolicy,
    authState: latestAuthStatus.state,
    authMessage: latestAuthStatus.message,
    language: languageTag(),
    languageSetting: currentLanguageSetting(),
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
    if (message.action === 'setLanguage') await setDashboardLanguage(message.language);
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
  const accountItems = profiles.map(profile => accountQuickPickItem(profile, activeId));
  const selected = await vscode.window.showQuickPick([
    {
      label: `$(add) ${t('addAccount')}`,
      description: t('saveCurrentAndOpenLogin'),
      action: 'add'
    },
    ...accountItems,
    ...(profiles.some(profile => profile.id !== activeId) ? [{
      label: `$(trash) ${t('deleteAllInactive')}`,
      description: t('keepActiveDeleteRest'),
      action: 'clearInactive'
    }] : [])
  ], {
    title: t('accountsTitle'),
    placeHolder: t('chooseAccountPlaceholder')
  });
  if (!selected) return;

  if (selected.action === 'add') return addAccount();
  if (selected.action === 'clearInactive') return clearInactiveAccounts();
  if (selected.action === 'profile') {
    const isActive = selected.profileId === activeId;
    const profile = profiles.find(candidate => candidate.id === selected.profileId);
    const action = await vscode.window.showQuickPick([
      ...(!isActive && profile?.credentialsStored ? [{
        label: `$(arrow-swap) ${t('activateThisAccount')}`,
        action: 'switchTo'
      }] : []),
      ...(!isActive && !profile?.credentialsStored ? [{
        label: `$(sign-in) ${t('signInWithAccount')}`,
        description: t('credentialMissingOrInvalid'),
        action: 'login'
      }] : []),
      {
        label: `$(edit) ${t('changeName')}`,
        action: 'rename'
      },
      ...(!isActive ? [{
        label: `$(trash) ${t('delete')}`,
        action: 'forget'
      }] : [])
    ], {
      title: selected.label.replace(/^\$\([^)]+\)\s*/, ''),
      placeHolder: t('accountActionPlaceholder')
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
    ? t('recoveryFailed', { message: latestError.message })
    : account.hasCredentials
      ? t('sessionNoData')
      : t('noCodexSessionDetected');

  const action = await vscode.window.showWarningMessage(
    message,
    t('openCodex'),
    t('refresh'),
    t('viewDiagnostics')
  );

  if (action === t('openCodex')) await openCodex();
  if (action === t('refresh')) setTimeout(() => void refresh(true), 0);
  if (action === t('viewDiagnostics')) showDiagnostics();
}

async function showDetails() {
  await showDashboard();
  if (!latestStats) await showRecovery();
}

function scheduleRefresh() {
  const configuredSeconds = Number(vscode.workspace.getConfiguration('codexGestion').get('refreshIntervalSeconds', 30));
  const seconds = effectiveRefreshIntervalSeconds(configuredSeconds, currentPlanPolicy);
  if (refreshTimer && scheduledRefreshSeconds === seconds) return;
  if (refreshTimer) clearInterval(refreshTimer);
  scheduledRefreshSeconds = seconds;
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
  i18n.init(vscode);
  if (latestAuthStatus.state === 'unknown') latestAuthStatus.message = t('sessionUnchecked');
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
      t('releaseMessage', { version: currentVersion }),
      t('openPanel')
    ).then(action => {
      if (action === t('openPanel')) showDashboard();
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
    effectiveRefreshIntervalSeconds,
    findCodexExecutable,
    buildInitialProjectContext,
    extractSessionConversationItems,
    formatContextQuota,
    getContextPercent,
    getProjectIdentitySummary,
    getRoadmapContextSummary,
    buildDecisionSignalsSection,
    sanitizeContextExcerpt,
    isPathInside,
    mergeAccountSnapshot,
    parseLatestStats,
    planDisplay,
    planPolicyFrom,
    planPolicyText,
    quotaWindowLabel,
    quotaWindowsFromRateLimits,
    rateLimitFingerprint,
    resolveAccountTracking,
    schedulePostSwitchStatsRefresh,
    statsCutoffForAccount,
    statsBelongsToAnotherProfile,
    summarizeAuthFailure,
    statsFromProfileSnapshot,
    accountDisplayLabel,
    accountIdentityDetail,
    accountQuickPickItem,
    accountVisual,
    visibleAccountSnapshot,
    writeAuthPayloadAtomic
  }
};



