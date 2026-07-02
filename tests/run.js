const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return { workspace: { workspaceFolders: [] } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { __test } = require('../extension');
Module._load = originalLoad;

assert.strictEqual(__test.availablePercent(23), 77);
assert.strictEqual(__test.availablePercent(150), 0);
assert.strictEqual(__test.availablePercent(null), null);
assert.strictEqual(__test.availablePercent(undefined), null);
assert.match(__test.formatContextQuota('Cuota 5 h', null), /pendiente de recoger datos/i);
assert.match(__test.formatContextQuota('Cuota 5 h', { used_percent: 40, resets_at: Math.floor(Date.now() / 1000) - 60 }), /dato puede estar antiguo|vencida|stale/i);
assert.doesNotMatch(__test.sanitizeContextExcerpt('token sk-1234567890abcdef and access_token=secret-value'), /sk-1234567890abcdef|secret-value/);
assert.strictEqual(__test.getContextPercent({
  lastTokenUsage: { total_tokens: 50 },
  modelContextWindow: 200
}), 25);

const unchanged = __test.resolveAccountTracking('account-a', 'account-a', 100, true, 500);
assert.deepStrictEqual(unchanged, { accountKey: 'account-a', since: 100, changed: false });
const changed = __test.resolveAccountTracking('account-b', 'account-a', 100, true, 500);
assert.deepStrictEqual(changed, { accountKey: 'account-b', since: 500, changed: true });
const firstRun = __test.resolveAccountTracking('account-a', '', 0, false, 500);
assert.deepStrictEqual(firstRun, { accountKey: 'account-a', since: 0, changed: false });
assert.strictEqual(__test.statsCutoffForAccount(500, ''), 500);
assert.strictEqual(__test.statsCutoffForAccount(500, 'known-fingerprint'), 0);

assert.strictEqual(__test.isPathInside(
  path.join('C:', 'repo', 'src'),
  path.join('C:', 'repo')
), true);
assert.strictEqual(__test.isPathInside(
  path.join('C:', 'other'),
  path.join('C:', 'repo')
), false);
const fakeCodexPath = path.join('C:', 'Users', 'User Name', '.vscode', 'extensions', 'openai.chatgpt-test', 'bin', 'windows-x86_64', 'codex.exe');

function fakeJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.`;
}

const jwtAuthPayload = {
  auth_mode: 'chatgpt',
  tokens: {
    account_id: 'account-jwt',
    access_token: 'secret-access',
    refresh_token: 'secret-refresh',
    id_token: fakeJwt({ email: 'user@example.com', name: 'Codex User' })
  }
};
const jwtAccount = __test.accountFromAuthPayload(jwtAuthPayload);
assert.strictEqual(jwtAccount.email, 'user@example.com');
assert.strictEqual(jwtAccount.name, 'Codex User');
assert.strictEqual(jwtAccount.label, 'user@example.com');
assert.strictEqual(__test.accountDisplayLabel(jwtAccount), 'user@example.com');
const loginCommand = __test.buildCodexLoginCommand(fakeCodexPath);
if (process.platform === 'win32') {
  assert.strictEqual(loginCommand, `& '${fakeCodexPath}' login`);
} else {
  assert.ok(loginCommand.endsWith(' login'));
}

const oldSnapshot = {
  primaryUsed: 40,
  secondaryUsed: 20,
  plan: 'plus',
  contextUsed: 10,
  rateLimitFingerprint: 'old'
};
assert.deepStrictEqual(__test.mergeAccountSnapshot(oldSnapshot, null), oldSnapshot);
const merged = __test.mergeAccountSnapshot(oldSnapshot, {
  rateLimits: { primary: { used_percent: 55 }, limit_id: 'new-limit' },
  lastTokenUsage: { total_tokens: 30 },
  modelContextWindow: 100,
  rateLimitFingerprint: 'new'
});
assert.strictEqual(merged.primaryUsed, 55);
assert.strictEqual(merged.secondaryUsed, 20);
assert.strictEqual(merged.plan, 'plus');
assert.strictEqual(merged.contextUsed, 30);
assert.strictEqual(merged.rateLimitFingerprint, 'new');

const fallbackStats = __test.statsFromProfileSnapshot({
  label: 'Cuenta guardada',
  lastSeen: 1234,
  snapshot: {
    primaryUsed: 55,
    secondaryUsed: 25,
    plan: 'plus',
    contextUsed: 40,
    rateLimitFingerprint: 'fingerprint'
  }
});
assert.strictEqual(fallbackStats.isSnapshotFallback, true);
assert.strictEqual(fallbackStats.accountLabel, 'Cuenta guardada');
assert.strictEqual(fallbackStats.rateLimits.primary.used_percent, 55);
assert.strictEqual(fallbackStats.rateLimits.secondary.used_percent, 25);
assert.strictEqual(fallbackStats.rateLimits.plan_type, 'plus');
assert.strictEqual(__test.getContextPercent(fallbackStats), 40);
assert.strictEqual(fallbackStats.lastTokenUsage, null);
assert.strictEqual(fallbackStats.modelContextWindow, null);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gestion-'));
const sessionPath = path.join(tempDir, 'session.jsonl');
const firstLimits = { limit_id: 'account-a', primary: { used_percent: 10 } };
const secondLimits = { limit_id: 'account-b', primary: { used_percent: 80 } };
fs.writeFileSync(sessionPath, [
  JSON.stringify({
    timestamp: '2026-06-15T10:00:00.000Z',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { total_tokens: 10 }, model_context_window: 100 },
      rate_limits: firstLimits
    }
  }),
  JSON.stringify({
    timestamp: '2026-06-15T11:00:00.000Z',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { total_tokens: 20 }, model_context_window: 100 },
      rate_limits: secondLimits
    }
  })
].join('\n'));

const latest = __test.parseLatestStats(sessionPath);
assert.strictEqual(latest.rateLimits.primary.used_percent, 80);
assert.strictEqual(latest.sessionId, '');
const firstFingerprint = __test.rateLimitFingerprint(firstLimits);
const matching = __test.parseLatestStats(sessionPath, firstFingerprint);
assert.strictEqual(matching.rateLimits.primary.used_percent, 10);
assert.strictEqual(matching.rateLimitFingerprint, firstFingerprint);
assert.strictEqual(__test.statsBelongsToAnotherProfile('profile-b', [{
  id: 'profile-a',
  snapshot: { rateLimitFingerprint: matching.rateLimitFingerprint }
}], matching), true);
const conversationPath = path.join(tempDir, 'conversation.jsonl');
fs.writeFileSync(conversationPath, [
  JSON.stringify({ timestamp: '2026-06-15T12:00:00.000Z', type: 'user_message', payload: { content: 'Tenemos que mejorar el contexto entre cuentas.' } }),
  JSON.stringify({ timestamp: '2026-06-15T12:01:00.000Z', type: 'assistant_message', payload: { content: 'Voy a generar un contexto automatico con estado Git y sesiones locales.' } }),
  JSON.stringify({ timestamp: '2026-06-15T12:02:00.000Z', type: 'tool_result', payload: { stdout: 'npm test passed with sk-1234567890abcdef redacted' } })
].join('\n'));
const conversationItems = __test.extractSessionConversationItems(conversationPath, 5);
assert.ok(conversationItems.length >= 2);
assert.match(conversationItems.map(item => item.excerpt).join('\n'), /contexto automatico|mejorar el contexto/i);
assert.doesNotMatch(conversationItems.map(item => item.excerpt).join('\n'), /sk-1234567890abcdef/);
assert.strictEqual(__test.statsBelongsToAnotherProfile('profile-a', [{
  id: 'profile-a',
  snapshot: { rateLimitFingerprint: matching.rateLimitFingerprint }
}], matching), false);
assert.deepStrictEqual(__test.visibleAccountSnapshot(
  { id: 'profile-b', snapshot: { primaryUsed: 90, plan: 'plus', rateLimitFingerprint: 'shared' } },
  [
    { id: 'profile-a', snapshot: { primaryUsed: 20, plan: 'pro', rateLimitFingerprint: 'shared' } },
    { id: 'profile-b', snapshot: { primaryUsed: 90, plan: 'plus', rateLimitFingerprint: 'shared' } }
  ],
  'profile-a'
), {});
assert.strictEqual(__test.visibleAccountSnapshot(
  { id: 'profile-a', snapshot: { primaryUsed: 20, plan: 'pro', rateLimitFingerprint: 'shared' } },
  [
    { id: 'profile-a', snapshot: { primaryUsed: 20, plan: 'pro', rateLimitFingerprint: 'shared' } },
    { id: 'profile-b', snapshot: { primaryUsed: 90, plan: 'plus', rateLimitFingerprint: 'shared' } }
  ],
  'profile-a'
).primaryUsed, 20);

const authPath = path.join(tempDir, 'auth.json');
const authPayload = {
  auth_mode: 'chatgpt',
  tokens: {
    account_id: 'account-test',
    access_token: 'secret-access',
    refresh_token: 'secret-refresh'
  }
};
__test.writeAuthPayloadAtomic(authPayload, authPath);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), authPayload);
__test.clearAuthPayload(authPath);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), {});
__test.writeAuthPayloadAtomic(authPayload, authPath);
const account = __test.accountFromAuthPayload(authPayload);
assert.strictEqual(account.hasCredentials, true);
assert.strictEqual(account.id, 'account-test');
assert.match(
  __test.summarizeAuthFailure('Your access token could not be refreshed because your refresh token was revoked.'),
  /revocada|revoked/i
);

const selectedPayload = {
  auth_mode: 'chatgpt',
  tokens: {
    account_id: 'yeray-vicom',
    access_token: 'selected-access',
    refresh_token: 'selected-refresh'
  }
};
const revertedPayload = {
  auth_mode: 'chatgpt',
  tokens: {
    account_id: 'yeray-personal',
    access_token: 'old-access',
    refresh_token: 'old-refresh'
  }
};
const selectedProfileId = __test.accountProfileId(__test.accountFromAuthPayload(selectedPayload));
__test.armAccountSwitchGuard(selectedProfileId, selectedPayload, 'yeray-vicom');
__test.writeAuthPayloadAtomic(revertedPayload, authPath);
assert.strictEqual(__test.enforceAccountSwitchGuard(authPath), true);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), selectedPayload);
assert.strictEqual(__test.enforceAccountSwitchGuard(authPath), false);
__test.clearAccountSwitchGuard();
assert.doesNotThrow(() => __test.schedulePostSwitchStatsRefresh(selectedProfileId));
__test.clearPostSwitchRefreshTimers();

fs.rmSync(tempDir, { recursive: true, force: true });
console.log('All Codex Gestion tests passed.');

