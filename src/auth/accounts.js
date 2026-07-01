const crypto = require('crypto');
const { ACCOUNT_SECRET_PREFIX } = require('../constants');

function decodeBase64UrlJson(value) {
  if (!value) return null;
  const encoded = String(value).split('.')[1];
  if (!encoded) return null;

  let payload = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padding = payload.length % 4;
  if (padding === 2) payload += '==';
  if (padding === 3) payload += '=';

  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function profileFromAuthPayload(payload) {
  const idClaims = decodeBase64UrlJson(payload?.tokens?.id_token);
  const apiProfile = idClaims?.['https://api.openai.com/profile'] || {};
  const email = firstString(
    idClaims?.email,
    apiProfile.email,
    payload?.email,
    payload?.profile?.email
  );
  const name = firstString(
    idClaims?.name,
    apiProfile.name,
    payload?.name,
    payload?.profile?.name
  );
  return {
    email,
    name,
    label: email || name
  };
}

function accountFromAuthPayload(payload) {
  const hasApiKey = Boolean(payload?.OPENAI_API_KEY);
  const hasValidToken = Boolean(
    payload?.tokens?.account_id &&
    (payload?.tokens?.access_token || payload?.tokens?.refresh_token)
  );
  const profile = profileFromAuthPayload(payload);
  return {
    id: String(payload?.tokens?.account_id || ''),
    identity: payload?.tokens?.account_id
      ? `account:${payload.tokens.account_id}`
      : hasApiKey
        ? `apikey:${crypto.createHash('sha256').update(String(payload.OPENAI_API_KEY)).digest('hex')}`
        : '',
    email: profile.email,
    name: profile.name,
    label: profile.label,
    mode: String(payload?.auth_mode || (hasApiKey ? 'apikey' : 'unknown')),
    hasCredentials: hasValidToken || hasApiKey
  };
}

function accountProfileId(account) {
  const value = account.identity || account.id || `${account.mode}:${account.hasCredentials}`;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function accountSecretKey(profileId) {
  return `${ACCOUNT_SECRET_PREFIX}${profileId}`;
}

function summarizeAuthFailure(output, error) {
  const text = String(output || error?.message || '').toLowerCase();
  if (text.includes('revoked') || text.includes('refresh token')) {
    return 'La sesion guardada fue revocada por OpenAI y necesita iniciar sesion otra vez.';
  }
  if (text.includes('expired')) {
    return 'La sesion guardada ha caducado y necesita iniciar sesion otra vez.';
  }
  if (text.includes('not logged in') || text.includes('not authenticated')) {
    return 'Codex no reconoce esta sesion guardada.';
  }
  if (error?.killed || error?.signal === 'SIGTERM') {
    return 'No se pudo comprobar la sesion a tiempo.';
  }
  return 'Codex no pudo validar esta sesion guardada.';
}

module.exports = {
  accountFromAuthPayload,
  accountProfileId,
  accountSecretKey,
  profileFromAuthPayload,
  summarizeAuthFailure
};
