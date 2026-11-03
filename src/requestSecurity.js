// Express already applies the configured `trust proxy` policy to `req.ip`.
// Keeping that policy in one place avoids trusting spoofed X-Forwarded-For
// headers when the app is not actually behind a trusted proxy.
export function getTrustedClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Parses TRUST_PROXY into an Express `trust proxy` hop count.
 * "1"/"true"/"yes" -> 1; a positive integer N -> N; anything else -> false.
 * A hop count (never `true`) makes req.ip the entry appended by our own
 * proxy rather than the client-controlled left-most X-Forwarded-For value.
 */
export function parseTrustProxy(value) {
  const text = String(value ?? '').trim();
  if (/^(true|yes)$/i.test(text)) return 1;
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    return hops > 0 ? hops : false;
  }
  return false;
}
