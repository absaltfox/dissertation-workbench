const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(), camera=(), microphone=()',
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "connect-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:"
  ].join('; ')
};

/**
 * Applies the baseline browser security headers for the Express app.
 */
export function applySecurityHeaders(_req, res, next) {
  for (const [name, value] of Object.entries(securityHeaders)) {
    res.setHeader(name, value);
  }
  next();
}

/**
 * Wraps async route handlers so rejected promises flow to Express error
 * middleware instead of requiring each handler to repeat try/catch plumbing.
 */
export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Reads the first value for a query key.
 *
 * Express can expose repeated query params as arrays; route validation treats
 * the first value as authoritative to keep parameter handling deterministic.
 */
export function getQueryValue(req, key) {
  const value = req.query[key];
  return Array.isArray(value) ? value[0] : value;
}
