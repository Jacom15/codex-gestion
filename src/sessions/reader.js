const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { HEAD_BYTES, TAIL_BYTES } = require('../constants');

function getSessionFiles(directory, cutoffMs) {
  if (!fs.existsSync(directory)) return null;

  const files = [];
  const pending = [directory];

  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= cutoffMs) files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // A session can rotate while it is being scanned.
      }
    }
  }

  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function readChunk(filePath, position, length) {
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, 'r');

  try {
    fs.readSync(descriptor, buffer, 0, length, position);
  } finally {
    fs.closeSync(descriptor);
  }

  return buffer.toString('utf8');
}

function readTail(filePath) {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, TAIL_BYTES);
  return readChunk(filePath, stat.size - length, length);
}

function readSessionMeta(filePath) {
  const stat = fs.statSync(filePath);
  const text = readChunk(filePath, 0, Math.min(stat.size, HEAD_BYTES));

  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"session_meta"')) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'session_meta') return event.payload || null;
    } catch {
      return null;
    }
  }

  return null;
}

function stableRateLimitShape(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return '';
  const normalize = value => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
      if (key === 'resets_at' || key === 'used_percent') return result;
      result[key] = normalize(value[key]);
      return result;
    }, {});
  };
  return JSON.stringify(normalize(rateLimits));
}

function rateLimitFingerprint(rateLimits) {
  const limitId = rateLimits?.limit_id;
  const source = limitId ? String(limitId) : stableRateLimitShape(rateLimits);
  if (!source) return '';
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function parseLatestStats(filePath, expectedRateLimitFingerprint = '') {
  const meta = readSessionMeta(filePath);
  const lines = readTail(filePath).split(/\r?\n/);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.includes('"token_count"')) continue;

    try {
      const event = JSON.parse(line);
      if (event?.payload?.type !== 'token_count') continue;
      const rateLimits = event.payload.rate_limits || null;
      const fingerprint = rateLimitFingerprint(rateLimits);
      if (expectedRateLimitFingerprint && fingerprint !== expectedRateLimitFingerprint) continue;

      return {
        timestamp: event.timestamp,
        sessionFile: filePath,
        totalTokenUsage: event.payload.info?.total_token_usage || null,
        lastTokenUsage: event.payload.info?.last_token_usage || null,
        modelContextWindow: event.payload.info?.model_context_window || null,
        rateLimits,
        rateLimitFingerprint: fingerprint,
        sessionId: meta?.id || meta?.session_id || meta?.conversation_id || '',
        sessionCwd: meta?.cwd || ''
      };
    } catch {
      // Ignore incomplete lines while Codex is writing the session.
    }
  }

  return null;
}

module.exports = {
  getSessionFiles,
  parseLatestStats,
  rateLimitFingerprint,
  readSessionMeta
};