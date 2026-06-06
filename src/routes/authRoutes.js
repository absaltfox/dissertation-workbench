import { Router } from 'express';
import {
  LOGIN_BLOCK_MS, LOGIN_FAILURE_DELAY_MS, LOGIN_MAX_ATTEMPTS_IP,
  LOGIN_MAX_ATTEMPTS_USER, LOGIN_WINDOW_MS
} from '../config.js';
import {
  authenticate, clearSessionCookie, confirmMfaSetup, createPasswordHash, destroySession,
  getSessionCsrfToken, login, setSessionCookie
} from '../auth.js';
import { consumePasswordResetToken, findPasswordResetToken, updateUserPassword } from '../db.js';
import { asyncHandler } from '../middleware/http.js';
import { validateAdminUser } from '../validate.js';

const failedLoginsByIp = new Map();
const failedLoginsByUser = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pruneAttempts(entry, now) {
  entry.attempts = entry.attempts.filter((ts) => now - ts <= LOGIN_WINDOW_MS);
}

function getOrInitLimiter(map, key) {
  const existing = map.get(key);
  if (existing) return existing;
  const created = { attempts: [], blockedUntil: 0 };
  map.set(key, created);
  return created;
}

function isBlocked(map, key, now) {
  const entry = map.get(key);
  if (!entry) return false;
  if (entry.blockedUntil <= now) return false;
  return true;
}

function recordFailedLogin(map, key, limit, now) {
  const entry = getOrInitLimiter(map, key);
  pruneAttempts(entry, now);
  entry.attempts.push(now);
  if (entry.attempts.length >= limit) {
    entry.blockedUntil = now + LOGIN_BLOCK_MS;
    entry.attempts = [];
  }
}

function clearFailedLogins(map, key) {
  map.delete(key);
}

function cleanupLimiterMap(map, now) {
  for (const [key, entry] of map.entries()) {
    pruneAttempts(entry, now);
    if (!entry.attempts.length && entry.blockedUntil <= now) {
      map.delete(key);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  cleanupLimiterMap(failedLoginsByIp, now);
  cleanupLimiterMap(failedLoginsByUser, now);
}, Math.max(60_000, Math.floor(LOGIN_WINDOW_MS / 2))).unref();

export function createAuthRouter({ getClientIp }) {
  const router = Router();

  router.post('/login', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const { username, password, mfaCode } = body;
    const ip = getClientIp(req);
    const userKey = String(username || '').trim().toLowerCase();
    const now = Date.now();
    const blockedByIp = isBlocked(failedLoginsByIp, ip, now);
    const blockedByUser = userKey ? isBlocked(failedLoginsByUser, userKey, now) : false;
    if (blockedByIp || blockedByUser) {
      await sleep(LOGIN_FAILURE_DELAY_MS);
      res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
      return;
    }
    if (!username || !password) {
      recordFailedLogin(failedLoginsByIp, ip, LOGIN_MAX_ATTEMPTS_IP, now);
      if (userKey) recordFailedLogin(failedLoginsByUser, userKey, LOGIN_MAX_ATTEMPTS_USER, now);
      await sleep(LOGIN_FAILURE_DELAY_MS);
      res.status(400).json({ error: 'Username and password required' });
      return;
    }
    const result = await login(username, password, { mfaCode });
    if (!result.ok) {
      if (result.mfaRequired && !mfaCode) {
        res.status(200).json({ ok: false, mfaRequired: true });
        return;
      }
      if (result.mfaRequired) {
        recordFailedLogin(failedLoginsByIp, ip, LOGIN_MAX_ATTEMPTS_IP, now);
        if (userKey) recordFailedLogin(failedLoginsByUser, userKey, LOGIN_MAX_ATTEMPTS_USER, now);
        await sleep(LOGIN_FAILURE_DELAY_MS);
        res.status(401).json({ error: 'Invalid MFA code', mfaRequired: true });
        return;
      }
      if (result.mfaSetupRequired) {
        res.status(200).json({
          ok: false,
          mfaSetupRequired: true,
          setupToken: result.token,
          secret: result.secret,
          otpauthUrl: result.otpauthUrl,
        });
        return;
      }
      recordFailedLogin(failedLoginsByIp, ip, LOGIN_MAX_ATTEMPTS_IP, now);
      if (userKey) recordFailedLogin(failedLoginsByUser, userKey, LOGIN_MAX_ATTEMPTS_USER, now);
      await sleep(LOGIN_FAILURE_DELAY_MS);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    clearFailedLogins(failedLoginsByIp, ip);
    if (userKey) clearFailedLogins(failedLoginsByUser, userKey);
    setSessionCookie(res, result.token, req);
    res.status(200).json({
      ok: true,
      username: result.username,
      mfaEnabled: result.mfaEnabled,
      csrfToken: getSessionCsrfToken(result.token)
    });
  }));

  router.post('/mfa/setup/confirm', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const token = String(body.setupToken || '');
    const code = String(body.code || '');
    const ip = getClientIp(req);
    const now = Date.now();
    if (isBlocked(failedLoginsByIp, ip, now)) {
      await sleep(LOGIN_FAILURE_DELAY_MS);
      res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
      return;
    }
    const sessionToken = await confirmMfaSetup(token, code);
    if (!sessionToken) {
      recordFailedLogin(failedLoginsByIp, ip, LOGIN_MAX_ATTEMPTS_IP, now);
      await sleep(LOGIN_FAILURE_DELAY_MS);
      res.status(400).json({ error: 'Invalid or expired MFA setup code' });
      return;
    }
    clearFailedLogins(failedLoginsByIp, ip);
    setSessionCookie(res, sessionToken, req);
    res.status(200).json({ ok: true, csrfToken: getSessionCsrfToken(sessionToken) });
  }));

  router.post('/password-reset/confirm', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const token = String(body.token || '').trim();
    const password = String(body.password || '');
    const reset = await findPasswordResetToken(token);
    if (!reset) {
      await sleep(LOGIN_FAILURE_DELAY_MS);
      res.status(400).json({ error: 'Invalid or expired password reset link' });
      return;
    }
    const validation = validateAdminUser(reset.username, password);
    if (!validation.valid) {
      res.status(400).json({ error: 'Validation failed', errors: validation.errors });
      return;
    }
    const { hash, salt } = createPasswordHash(password);
    if (!(await consumePasswordResetToken(token))) {
      res.status(400).json({ error: 'Password reset link could not be used' });
      return;
    }
    const updated = await updateUserPassword(reset.username, hash, salt);
    if (!updated) {
      res.status(400).json({ error: 'Password reset link could not be used' });
      return;
    }
    res.status(200).json({ ok: true });
  }));

  router.post('/logout', (req, res) => {
    const user = authenticate(req);
    if (user) destroySession(user.token);
    clearSessionCookie(res, req);
    res.status(200).json({ ok: true });
  });

  router.get('/session', (req, res) => {
    const user = authenticate(req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.status(200).json({ ok: true, username: user.username, csrfToken: user.csrfToken });
  });

  return router;
}
