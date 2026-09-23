const { spawn } = require('child_process');
const path = require('path');
const { findCodexExecutable } = require('./cli');
const { AUTH_PATH } = require('../constants');
const { finiteNumber } = require('../utils/format');

function readingMatchesAccount(reading, expected, current) {
  if (!reading || !expected?.hasCredentials || !current?.hasCredentials || !expected.id || expected.id !== current.id) return false;
  const backendAccountId = String(reading.rateLimits?.account_id || '').trim();
  if (backendAccountId && backendAccountId !== String(expected.id)) return false;
  return !expected.email || !reading.account?.email || expected.email.toLowerCase() === reading.account.email.toLowerCase();
}

function normalizeCredits(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    has_credits: value.hasCredits === true,
    unlimited: value.unlimited === true,
    balance: value.balance == null ? null : String(value.balance)
  };
}

function normalizeRateLimits(result) {
  const bucket = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
  if (!bucket) return null;

  const window = value => {
    const used = finiteNumber(value?.usedPercent);
    if (used === null) return null;
    return {
      used_percent: Math.min(100, Math.max(0, used)),
      window_minutes: finiteNumber(value.windowDurationMins),
      resets_at: finiteNumber(value.resetsAt)
    };
  };

  const primary = window(bucket.primary);
  const secondary = window(bucket.secondary);
  const credits = normalizeCredits(bucket.credits);
  if (!primary && !secondary && !credits) return null;

  return {
    account_id: result?.accountId ? String(result.accountId) : null,
    limit_id: bucket.limitId || 'codex',
    plan_type: bucket.planType || null,
    primary,
    secondary,
    credits,
    ordinary_usage_allowed: typeof result?.ordinaryUsageAllowed === 'boolean' ? result.ordinaryUsageAllowed : null,
    rate_limit_reached_type: bucket.rateLimitReachedType || null,
    rate_limit_upsell: result?.rateLimitUpsell || null
  };
}

// Read-only JSONL connection. No thread, turn, login or account-switch requests.
function createRateLimitReader({ spawnProcess = spawn, findExecutable = findCodexExecutable, timeoutMs = 8000 } = {}) {
  const pending = new Set();
  const read = (version = '1.0.0') => new Promise(resolve => {
    const executable = findExecutable({ nativeOnly: true });
    // Batch wrappers need a shell. Keep this protocol on native executables only.
    if (!executable || /\.(cmd|bat)$/i.test(executable)) return resolve(null);
    let child;
    let timer;
    let finished = false;
    let buffer = '';
    let account = null;
    let expectedId = 0;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pending.delete(cancel);
      if (child) {
        try { child.stdin.destroy(); } catch {}
        try { child.kill(); } catch {}
      }
      resolve(value);
    };
    const cancel = () => finish(null);
    try {
      child = spawnProcess(executable, ['app-server'], {
        windowsHide: true,
        shell: false,
        cwd: path.dirname(AUTH_PATH),
        env: { ...process.env, CODEX_HOME: path.dirname(AUTH_PATH) },
        stdio: ['pipe', 'pipe', 'ignore']
      });
      pending.add(cancel);
      timer = setTimeout(cancel, timeoutMs);
      child.on('error', cancel);
      child.on('exit', cancel);
      child.stdin.on('error', cancel);
      child.stdout.on('error', cancel);
      child.stdout.setEncoding('utf8');
      const send = message => child.stdin.write(JSON.stringify(message) + '\n');
      child.stdout.on('data', chunk => {
        if (finished) return;
        buffer += chunk;
        if (buffer.length > 1024 * 1024) return cancel();
        let end;
        while (!finished && (end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id !== expectedId || message.method) continue;
          if (message.error) return cancel();
          if (expectedId === 0) {
            expectedId = 1;
            send({ method: 'initialized', params: {} });
            send({ method: 'account/read', id: 1, params: { refreshToken: false } });
          } else if (expectedId === 1) {
            account = message.result?.account;
            if (account?.type !== 'chatgpt') return cancel();
            expectedId = 2;
            send({ method: 'account/rateLimits/read', id: 2 });
          } else {
            const rateLimits = normalizeRateLimits(message.result);
            finish(rateLimits ? { account, rateLimits, checkedAt: Date.now() } : null);
          }
        }
      });
      send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'codex_gestion', title: 'Codex Gestion', version } } });
    } catch { cancel(); }
  });
  return { read, dispose() { for (const cancel of pending) cancel(); } };
}

module.exports = { createRateLimitReader, normalizeCredits, normalizeRateLimits, readingMatchesAccount };
