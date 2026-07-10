import { authenticate } from '../auth.js';
import { getTrustedClientIp } from '../requestSecurity.js';

/**
 * Per-IP sliding-window rate limit for anonymous API traffic. Authenticated
 * admin sessions bypass it so admin workflows are never throttled.
 */
export function createPublicRateLimit({ windowMs = 60_000, limit = 120, maxIps = 5000 } = {}) {
  const attemptsByIp = new Map();
  return function publicRateLimit(req, res, next) {
    if (authenticate(req)) {
      next();
      return;
    }
    const ip = getTrustedClientIp(req);
    const now = Date.now();
    const recent = (attemptsByIp.get(ip) || []).filter((ts) => now - ts <= windowMs);
    if (recent.length >= limit) {
      attemptsByIp.set(ip, recent);
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
      return;
    }
    recent.push(now);
    attemptsByIp.set(ip, recent);
    while (attemptsByIp.size > maxIps) {
      attemptsByIp.delete(attemptsByIp.keys().next().value);
    }
    next();
  };
}
