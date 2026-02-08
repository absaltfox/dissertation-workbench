import crypto from 'node:crypto';
import { findUserByUsername, createUser, countUsers } from './db.js';
import { logger } from './logger.js';

const ITERATIONS = 100_000;
const KEY_LEN = 64;
const DIGEST = 'sha512';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory session store with TTL
const sessions = new Map();

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

export function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, createdAt: Date.now() });
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
}, 60 * 60 * 1000); // every hour

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
  return session ? { username: session.username, token } : null;
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

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

export function ensureDefaultAdmin() {
  if (countUsers() > 0) return;
  const password = crypto.randomBytes(16).toString('hex');
  const { hash, salt } = createPasswordHash(password);
  createUser('admin', hash, salt);
  console.log('');
  console.log('============================================');
  console.log('  DEFAULT ADMIN ACCOUNT CREATED');
  console.log(`  Username: admin`);
  console.log(`  Password: ${password}`);
  console.log('  Change this password after first login.');
  console.log('============================================');
  console.log('');
}

export function login(username, password) {
  const user = findUserByUsername(username);
  if (!user) {
    logger.warn('Login failed: user not found', { username });
    return null;
  }
  if (!verifyPassword(password, user.password_hash, user.salt)) {
    logger.warn('Login failed: invalid password', { username });
    return null;
  }
  logger.info('Login successful', { username });
  return createSession(username);
}
