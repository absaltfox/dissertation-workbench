import crypto from 'node:crypto';
import { findUserByUsername, createUser, countUsers, setUserMfa } from './db.js';
import { logger } from './logger.js';
import {
  ADMIN_BOOTSTRAP_PASSWORD, IS_PRODUCTION, REQUIRE_ADMIN_MFA,
  SESSION_COOKIE_SECURE, TRUST_PROXY
} from './config.js';

const ITERATIONS = 100_000;
const KEY_LEN = 64;
const DIGEST = 'sha512';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MFA_SETUP_TTL_MS = 10 * 60 * 1000;
const MFA_SETUP_MAX_ATTEMPTS = 5;

// In-memory session store with TTL
const sessions = new Map();
const pendingMfaSetups = new Map();

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST).toString('hex');
}

export function createPasswordHash(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = hashPassword(password, salt);
  return { hash, salt };
}

export function verifyPassword(password, storedHash, salt) {
  const hash = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(secret) {
  const cleaned = String(secret || '').replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid MFA secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function createTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function totpCode(secret, counter) {
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

export function verifyTotp(secret, code, now = Date.now()) {
  const cleaned = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const counter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
    const expected = totpCode(secret, counter + offset);
    if (crypto.timingSafeEqual(Buffer.from(cleaned), Buffer.from(expected))) return true;
  }
  return false;
}

function mfaOtpauthUrl(username, secret) {
  const label = encodeURIComponent(`UBC Dissertation Workbench:${username}`);
  const issuer = encodeURIComponent('UBC Dissertation Workbench');
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

function createPendingMfaSetup(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const secret = createTotpSecret();
  pendingMfaSetups.set(token, { username, secret, createdAt: Date.now(), attempts: 0 });
  return { token, secret, otpauthUrl: mfaOtpauthUrl(username, secret) };
}

export function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, csrfToken, createdAt: Date.now() });
  logger.info('Session created', { username });
  return token;
}

export function destroySession(token) {
  sessions.delete(token);
}

function getSession(token) {
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return session;
}

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
}, 60 * 60 * 1000).unref(); // every hour

setInterval(() => {
  const now = Date.now();
  for (const [token, setup] of pendingMfaSetups) {
    if (now - setup.createdAt > MFA_SETUP_TTL_MS) pendingMfaSetups.delete(token);
  }
}, 60 * 1000).unref();

function parseCookie(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  }
  return cookies;
}

export function authenticate(req) {
  const cookies = parseCookie(req);
  const token = cookies.session;
  if (!token) return null;
  const session = getSession(token);
  return session ? { username: session.username, token, csrfToken: session.csrfToken } : null;
}

export function getSessionCsrfToken(token) {
  return getSession(token)?.csrfToken || null;
}

export function requireAdmin(req, res) {
  const user = authenticate(req);
  if (!user) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return null;
  }
  return user;
}

function isSecureRequest(req) {
  if (req?.socket?.encrypted) return true;
  if (!TRUST_PROXY) return false;
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

export function setSessionCookie(res, token, req) {
  const secure = SESSION_COOKIE_SECURE || isSecureRequest(req);
  const attrs = ['HttpOnly', 'SameSite=Strict', 'Path=/'];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', `session=${token}; ${attrs.join('; ')}`);
}

export function clearSessionCookie(res, req) {
  const secure = SESSION_COOKIE_SECURE || isSecureRequest(req);
  const attrs = ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', `session=; ${attrs.join('; ')}`);
}

export async function ensureDefaultAdmin() {
  if ((await countUsers()) > 0) return;
  if (IS_PRODUCTION && !ADMIN_BOOTSTRAP_PASSWORD) {
    throw new Error('ADMIN_BOOTSTRAP_PASSWORD is required to create the initial production admin account.');
  }
  const password = IS_PRODUCTION ? ADMIN_BOOTSTRAP_PASSWORD : crypto.randomBytes(16).toString('hex');
  const { hash, salt } = createPasswordHash(password);
  await createUser('admin', hash, salt);
  if (IS_PRODUCTION) {
    logger.info('Default admin account created from ADMIN_BOOTSTRAP_PASSWORD');
    return;
  }
  console.log('');
  console.log('============================================');
  console.log('  DEFAULT ADMIN ACCOUNT CREATED');
  console.log(`  Username: admin`);
  console.log(`  Password: ${password}`);
  console.log('  Change this password after first login.');
  console.log('============================================');
  console.log('');
}

export async function confirmMfaSetup(token, code) {
  const setup = pendingMfaSetups.get(token);
  if (!setup || Date.now() - setup.createdAt > MFA_SETUP_TTL_MS) {
    pendingMfaSetups.delete(token);
    return null;
  }
  if (!verifyTotp(setup.secret, code)) {
    setup.attempts += 1;
    if (setup.attempts >= MFA_SETUP_MAX_ATTEMPTS) pendingMfaSetups.delete(token);
    return null;
  }
  await setUserMfa(setup.username, setup.secret);
  pendingMfaSetups.delete(token);
  return createSession(setup.username);
}

export async function login(username, password, { mfaCode } = {}) {
  const user = await findUserByUsername(username);
  if (!user) {
    logger.warn('Login failed: user not found', { username });
    return { ok: false };
  }
  if (!verifyPassword(password, user.password_hash, user.salt)) {
    logger.warn('Login failed: invalid password', { username });
    return { ok: false };
  }
  if (user.mfa_enabled) {
    if (!verifyTotp(user.mfa_secret, mfaCode)) {
      logger.warn('Login requires valid MFA code', { username });
      return { ok: false, mfaRequired: true };
    }
  } else if (REQUIRE_ADMIN_MFA) {
    const setup = createPendingMfaSetup(user.username);
    logger.info('Login requires MFA setup', { username });
    return { ok: false, mfaSetupRequired: true, ...setup };
  }
  logger.info('Login successful', { username });
  return { ok: true, username: user.username, token: createSession(user.username), mfaEnabled: Boolean(user.mfa_enabled) };
}
