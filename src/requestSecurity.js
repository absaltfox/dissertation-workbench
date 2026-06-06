// Express already applies the configured `trust proxy` policy to `req.ip`.
// Keeping that policy in one place avoids trusting spoofed X-Forwarded-For
// headers when the app is not actually behind a trusted proxy.
export function getTrustedClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
