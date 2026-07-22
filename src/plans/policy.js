function normalizePlan(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!normalized) return 'unknown';
  if (normalized.includes('enterprise')) return 'enterprise';
  if (normalized.includes('business') || normalized === 'team') return 'business';
  if (normalized.includes('edu') || normalized.includes('education')) return 'edu';
  if (normalized.includes('pro')) return 'pro';
  if (normalized.includes('plus')) return 'plus';
  if (normalized === 'go' || normalized.includes('chatgptgo')) return 'go';
  if (normalized.includes('free')) return 'free';
  return normalized;
}

function planFamily(plan) {
  if (plan === 'free' || plan === 'go') return 'starter';
  if (plan === 'plus' || plan === 'pro') return 'selfServe';
  if (plan === 'business' || plan === 'enterprise' || plan === 'edu') return 'workspace';
  return 'unknown';
}

function observedPlanFrom(stats, profile) {
  return stats?.rateLimits?.plan_type || profile?.snapshot?.plan || '';
}

function lowestAvailablePercent(stats) {
  const limits = [];
  const rateLimits = stats?.rateLimits || {};
  const addLimit = limit => {
    if (!limit || typeof limit !== 'object') return;
    const used = Number(limit.used_percent);
    if (Number.isFinite(used)) limits.push(Math.max(0, 100 - Math.min(100, Math.max(0, used))));
  };
  if (Array.isArray(rateLimits.windows)) rateLimits.windows.forEach(addLimit);
  if (Array.isArray(rateLimits.quotas)) rateLimits.quotas.forEach(addLimit);
  addLimit(rateLimits.primary);
  addLimit(rateLimits.secondary);
  return limits.length ? Math.min(...limits) : null;
}

function planPolicyFrom(stats, profile) {
  const rawPlan = observedPlanFrom(stats, profile);
  const plan = normalizePlan(rawPlan);
  const family = planFamily(plan);
  const source = stats?.rateLimits?.plan_type
    ? (stats.isSnapshotFallback ? 'saved' : 'observed')
    : profile?.snapshot?.plan
      ? 'saved'
      : 'pending';
  const lowAvailable = lowestAvailablePercent(stats);
  const isLow = lowAvailable !== null && lowAvailable <= 10;

  return {
    plan,
    family,
    source,
    label: rawPlan ? String(rawPlan).toUpperCase() : 'PENDING',
    canBuyCredits: family === 'selfServe',
    shouldSuggestUpgrade: family === 'starter',
    adminManaged: family === 'workspace',
    isPending: source === 'pending',
    isLow,
    lowAvailable
  };
}

function effectiveRefreshIntervalSeconds(configuredSeconds, policy) {
  const configured = Math.max(5, Number(configuredSeconds) || 30);
  if (policy?.isPending) return Math.min(configured, 15);
  if (policy?.isLow) return Math.max(configured, 60);
  if (policy?.family === 'starter') return Math.max(configured, 45);
  return configured;
}

module.exports = {
  effectiveRefreshIntervalSeconds,
  normalizePlan,
  planFamily,
  planPolicyFrom
};
