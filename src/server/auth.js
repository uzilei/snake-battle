// Admin authentication: password check, in-memory sessions, login rate limiting.

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'sb_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // one expo day

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key && !Object.hasOwn(out, key)) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

// Constant-time comparison (hashing first makes the lengths equal).
export function passwordMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createSessionStore({ ttlMs = SESSION_TTL_MS, now = Date.now } = {}) {
  const sessions = new Map(); // token -> expiresAt

  return {
    create() {
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, now() + ttlMs);
      return token;
    },
    isValid(token) {
      if (typeof token !== 'string') return false;
      const expiresAt = sessions.get(token);
      if (expiresAt === undefined) return false;
      if (expiresAt <= now()) {
        sessions.delete(token);
        return false;
      }
      return true;
    },
    destroy(token) {
      sessions.delete(token);
    },
    fromRequest(req) {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      return this.isValid(token) ? token : null;
    },
  };
}

// Fixed-window limiter on failed login attempts, per client address.
export function createLoginLimiter({ maxFailures = 5, windowMs = 60_000, now = Date.now } = {}) {
  const entries = new Map(); // ip -> { count, resetAt }

  function entry(ip) {
    let e = entries.get(ip);
    if (!e || e.resetAt <= now()) {
      e = { count: 0, resetAt: now() + windowMs };
      entries.set(ip, e);
    }
    return e;
  }

  return {
    // Seconds until the client may try again, or 0 if it may try now.
    retryAfter(ip) {
      const e = entry(ip);
      return e.count >= maxFailures ? Math.ceil((e.resetAt - now()) / 1000) : 0;
    },
    fail(ip) {
      entry(ip).count++;
      if (entries.size > 10_000) {
        for (const [k, v] of entries) if (v.resetAt <= now()) entries.delete(k);
      }
    },
    succeed(ip) {
      entries.delete(ip);
    },
  };
}
