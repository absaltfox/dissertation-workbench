import { deflateSync, gzipSync } from 'node:zlib';

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

const COMPRESSIBLE_TYPE_RE = /^(application\/json|application\/javascript|application\/x-javascript|text\/|image\/svg\+xml)\b/i;
const MIN_COMPRESS_BYTES = 1024;

function appendVaryAcceptEncoding(res) {
  const existing = res.getHeader('vary');
  if (!existing) {
    res.setHeader('vary', 'Accept-Encoding');
    return;
  }
  const value = String(existing);
  if (!/\baccept-encoding\b/i.test(value)) {
    res.setHeader('vary', `${value}, Accept-Encoding`);
  }
}

/**
 * Lightweight response compression for static assets and JSON API payloads.
 *
 * This intentionally uses Node's built-in zlib instead of adding a runtime
 * dependency. It buffers normal app responses, skips small/non-text bodies, and
 * leaves already-encoded or status-only responses alone.
 */
export function applyCompression(req, res, next) {
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  const encoding = /\bgzip\b/i.test(acceptEncoding)
    ? 'gzip'
    : (/\bdeflate\b/i.test(acceptEncoding) ? 'deflate' : '');
  if (!encoding || req.method === 'HEAD') {
    next();
    return;
  }

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const chunks = [];

  res.write = (chunk, chunkEncoding, callback) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, chunkEncoding));
    }
    if (typeof callback === 'function') callback();
    return true;
  };

  res.end = (chunk, chunkEncoding, callback) => {
    let encodingArg = chunkEncoding;
    let callbackArg = callback;
    if (typeof encodingArg === 'function') {
      callbackArg = encodingArg;
      encodingArg = undefined;
    }
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encodingArg));
    }

    const body = Buffer.concat(chunks);
    const type = String(res.getHeader('content-type') || '');
    const skip = res.statusCode === 204
      || res.statusCode === 304
      || res.getHeader('content-encoding')
      || body.length < MIN_COMPRESS_BYTES
      || !COMPRESSIBLE_TYPE_RE.test(type);
    if (skip) {
      if (body.length) originalWrite(body);
      originalEnd(null, undefined, callbackArg);
      return;
    }

    try {
      const compressed = encoding === 'gzip' ? gzipSync(body) : deflateSync(body);
      res.setHeader('content-encoding', encoding);
      res.removeHeader('content-length');
      appendVaryAcceptEncoding(res);
      originalEnd(compressed, undefined, callbackArg);
    } catch {
      if (body.length) originalWrite(body);
      originalEnd(null, undefined, callbackArg);
    }
  };

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
