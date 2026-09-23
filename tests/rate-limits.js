const assert = require('assert');
const { EventEmitter } = require('events');
const { createRateLimitReader, normalizeCredits, normalizeRateLimits, readingMatchesAccount } = require('../src/codex/rate-limits');

const bucket = { planType: 'plus', primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 1788797302 }, secondary: { usedPercent: 39, windowDurationMins: 10080, resetsAt: 1789154401 }, credits: { hasCredits: true, unlimited: false, balance: '25.5' }, rateLimitReachedType: 'weekly' };
const expected = { account_id: null, limit_id: 'codex', plan_type: 'plus', primary: { used_percent: 60, window_minutes: 300, resets_at: 1788797302 }, secondary: { used_percent: 39, window_minutes: 10080, resets_at: 1789154401 }, credits: { has_credits: true, unlimited: false, balance: '25.5' }, ordinary_usage_allowed: null, rate_limit_reached_type: 'weekly', rate_limit_upsell: null };
assert.deepStrictEqual(normalizeRateLimits({ rateLimits: bucket }), expected);
assert.deepStrictEqual(normalizeRateLimits({ rateLimits: { primary: { usedPercent: 1 } }, rateLimitsByLimitId: { codex: bucket } }), expected);
assert.deepStrictEqual(normalizeCredits({ hasCredits: true, unlimited: true, balance: null }), { has_credits: true, unlimited: true, balance: null });
assert.strictEqual(normalizeCredits(null), null);
assert.strictEqual(normalizeRateLimits({ rateLimits: { primary: { usedPercent: null } } }), null);
assert.strictEqual(normalizeRateLimits({}), null);
const accountScoped = normalizeRateLimits({ accountId: 'account-a', ordinaryUsageAllowed: false, rateLimitUpsell: { title: 'Add credits' }, rateLimits: { primary: { usedPercent: 0 }, credits: { hasCredits: false, unlimited: false, balance: null } } });
assert.strictEqual(accountScoped.account_id, 'account-a');
assert.strictEqual(accountScoped.ordinary_usage_allowed, false);
assert.deepStrictEqual(accountScoped.rate_limit_upsell, { title: 'Add credits' });
assert.deepStrictEqual(accountScoped.credits, { has_credits: false, unlimited: false, balance: null });
assert.strictEqual(normalizeRateLimits({ rateLimits: { primary: { usedPercent: 0 } } }).primary.used_percent, 0);
assert.strictEqual(normalizeRateLimits({ rateLimits: { secondary: { usedPercent: 100 } } }).secondary.used_percent, 100);

const account = { hasCredentials: true, id: 'account-a', email: 'a@example.com' };
const reading = { account: { email: 'A@example.com' }, rateLimits: { account_id: 'account-a' } };
assert.strictEqual(readingMatchesAccount(reading, account, account), true);
assert.strictEqual(readingMatchesAccount(reading, account, { ...account, id: 'account-b' }), false);
assert.strictEqual(readingMatchesAccount({ account: { email: 'b@example.com' }, rateLimits: { account_id: 'account-a' } }, account, account), false);
assert.strictEqual(readingMatchesAccount({ account: { email: 'a@example.com' }, rateLimits: { account_id: 'account-b' } }, account, account), false);
assert.strictEqual(readingMatchesAccount(reading, account, { hasCredentials: false }), false);

function harness(mode = 'ok') {
  const sent = [];
  let killed = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.destroy = () => {};
  child.kill = () => { killed = true; };
  child.stdin.write = line => {
    const msg = JSON.parse(line);
    sent.push(msg);
    if (msg.id === undefined || mode === 'timeout') return;
    queueMicrotask(() => {
      if (mode === 'exit') return child.emit('exit', 1);
      if (mode === 'pipe') return child.stdin.emit('error', new Error('closed'));
      const result = msg.id === 0 ? {} : msg.id === 1 ? { account: { type: mode === 'apikey' ? 'apiKey' : 'chatgpt', email: 'a@example.com' } } : { accountId: 'account-a', ordinaryUsageAllowed: true, rateLimits: bucket };
      const response = mode === 'error' ? { id: msg.id, error: { message: 'private detail' } } : { id: msg.id, result };
      const wire = JSON.stringify({ method: 'account/updated', params: {} }) + '\n' + JSON.stringify(response) + '\n';
      child.stdout.emit('data', wire.slice(0, 17));
      child.stdout.emit('data', wire.slice(17));
    });
  };
  const reader = createRateLimitReader({
    findExecutable: () => '/codex.exe', timeoutMs: 20,
    spawnProcess: (executable, args, options) => {
      assert.deepStrictEqual(args, ['app-server']);
      assert.strictEqual(options.windowsHide, true);
      assert.strictEqual(options.shell, false);
      return child;
    }
  });
  return { reader, sent, killed: () => killed };
}

(async () => {
  const good = harness();
  const result = await good.reader.read(require('../package.json').version);
  assert.deepStrictEqual(result.rateLimits, { ...expected, account_id: 'account-a', ordinary_usage_allowed: true });
  assert.ok(result.checkedAt > 0);
  assert.deepStrictEqual(good.sent.map(m => m.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.strictEqual(good.sent[2].params.refreshToken, false);
  assert.strictEqual(good.killed(), true);
  for (const mode of ['error', 'exit', 'pipe', 'timeout', 'apikey']) {
    const h = harness(mode);
    assert.strictEqual(await h.reader.read(), null, mode);
    assert.strictEqual(h.killed(), true, mode);
  }
  const cancelled = harness('timeout');
  const pending = cancelled.reader.read();
  cancelled.reader.dispose();
  assert.strictEqual(await pending, null);
  assert.strictEqual(cancelled.killed(), true);
  assert.strictEqual(await createRateLimitReader({ findExecutable: () => null }).read(), null);
  assert.strictEqual(await createRateLimitReader({ findExecutable: () => '/codex.exe', spawnProcess: () => { throw new Error('denied'); } }).read(), null);
  console.log('Codex live quota tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
