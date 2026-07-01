const { t } = require('../i18n');
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value) {
  const number = finiteNumber(value);
  return number === null ? '--' : new Intl.NumberFormat().format(number);
}

function formatPercent(value) {
  const number = finiteNumber(value);
  return number === null ? 'N/A' : `${Math.round(number)}%`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeMarkdown(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}[\]()#+.!|<>])/g, '\\$1');
}

function clampPercent(value) {
  const number = finiteNumber(value);
  return number === null ? 0 : Math.min(100, Math.max(0, number));
}

function availablePercent(usedPercent) {
  const number = finiteNumber(usedPercent);
  return number === null ? null : 100 - clampPercent(number);
}

function formatReset(epochSeconds) {
  const epoch = finiteNumber(epochSeconds);
  if (epoch === null) return t('resetNoData');

  const remainingMs = Math.max(0, epoch * 1000 - Date.now());
  const totalMinutes = Math.ceil(remainingMs / 60000);
  if (totalMinutes < 1) return t('resetNow');
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours} h ${minutes} min`;

  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

function formatResetMoment(epochSeconds) {
  const epoch = finiteNumber(epochSeconds);
  if (epoch === null) return t('resetUnknown');

  const reset = new Date(epoch * 1000);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const sameDay = reset.toDateString() === now.toDateString();
  const nextDay = reset.toDateString() === tomorrow.toDateString();
  const time = reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (sameDay) return t('todayAt', { time });
  if (nextDay) return t('tomorrowAt', { time });
  return reset.toLocaleString([], {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatResetFull(epochSeconds) {
  return `${formatResetMoment(epochSeconds)} (dentro de ${formatReset(epochSeconds)})`;
}

function windowLabel(minutes) {
  const value = finiteNumber(minutes);
  if (value === null) return 'limite';
  if (value === 300) return '5h';
  if (value === 10080) return '7d';
  if (value % 1440 === 0) return `${value / 1440}d`;
  if (value % 60 === 0) return `${value / 60}h`;
  return `${value}m`;
}

function getContextPercent(stats) {
  const explicitPercent = finiteNumber(stats?.contextPercent);
  if (explicitPercent !== null) return clampPercent(explicitPercent);
  const used = finiteNumber(stats?.lastTokenUsage?.total_tokens);
  const window = finiteNumber(stats?.modelContextWindow);
  if (used === null || window === null || window <= 0) return null;
  return Math.min(100, Math.max(0, used / window * 100));
}

function getUsageAdvice(stats, authStatus) {
  if (authStatus?.state === 'invalid') {
    return {
      tone: 'danger',
      title: t('adviceInvalidTitle'),
      detail: authStatus.message || t('adviceInvalidDetail')
    };
  }
  if (authStatus?.state === 'missing') {
    return {
      tone: 'danger',
      title: t('adviceMissingTitle'),
      detail: t('adviceMissingDetail')
    };
  }
  if (authStatus?.state === 'unknown' || authStatus?.state === 'skipped') {
    return {
      tone: 'warning',
      title: t('adviceUncheckedTitle'),
      detail: authStatus.message || t('adviceUncheckedDetail')
    };
  }

  const primary = Number(stats?.rateLimits?.primary?.used_percent);
  const secondary = Number(stats?.rateLimits?.secondary?.used_percent);

  if (Number.isFinite(primary) && primary >= 95) {
    return {
      tone: 'danger',
      title: t('advicePrimaryLowTitle'),
      detail: t('advicePrimaryLowDetail')
    };
  }
  if (Number.isFinite(secondary) && secondary >= 90) {
    return {
      tone: 'danger',
      title: t('adviceWeeklyLowTitle'),
      detail: t('adviceWeeklyLowDetail')
    };
  }
  if (
    (Number.isFinite(primary) && primary >= 70) ||
    (Number.isFinite(secondary) && secondary >= 70)
  ) {
    return {
      tone: 'warning',
      title: t('adviceHighTitle'),
      detail: t('adviceHighDetail')
    };
  }
  return {
    tone: 'good',
    title: t('adviceGoodTitle'),
    detail: t('adviceGoodDetail')
  };
}

module.exports = {
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
};