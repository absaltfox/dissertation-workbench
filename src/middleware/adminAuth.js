import crypto from 'node:crypto';
import { authenticate } from '../auth.js';

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Checks whether a request carries the CSRF token bound to an admin session.
 */
export function hasValidCsrf(req, user) {
  return Boolean(user?.csrfToken) && safeEqual(req.get('x-csrf-token'), user.csrfToken);
}

/**
 * Requires an authenticated admin session.
 *
 * On success, attaches the authenticated user to `req.user`. On failure,
 * responds with 401 and does not call `next()`.
 */
export function requireAdmin(req, res, next) {
  const user = authenticate(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  req.user = user;
  next();
}

/**
 * Requires CSRF protection for authenticated state-changing requests.
 *
 * Unauthenticated writes continue to their route handlers so login/reset flows
 * can return their own validation errors. Login and MFA setup confirmation are
 * exempt because they happen before a trusted CSRF-bearing session exists.
 */
export function requireCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    next();
    return;
  }
  if (req.path === '/api/auth/login' || req.path === '/api/auth/mfa/setup/confirm') {
    next();
    return;
  }
  const user = authenticate(req);
  if (!user) {
    next();
    return;
  }
  if (!hasValidCsrf(req, user)) {
    res.status(403).json({ error: 'Invalid CSRF token' });
    return;
  }
  next();
}
