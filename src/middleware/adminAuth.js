import crypto from 'node:crypto';
import { authenticate } from '../auth.js';

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function hasValidCsrf(req, user) {
  return Boolean(user?.csrfToken) && safeEqual(req.get('x-csrf-token'), user.csrfToken);
}

export function requireAdmin(req, res, next) {
  const user = authenticate(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  req.user = user;
  next();
}

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
