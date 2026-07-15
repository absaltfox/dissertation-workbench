import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createPublicRateLimit } from '../src/middleware/rateLimit.js';

test('anonymous requests over the limit get 429', async () => {
  const app = express();
  app.use(createPublicRateLimit({ windowMs: 60_000, limit: 2 }));
  app.get('/thing', (_req, res) => res.status(200).json({ ok: true }));

  assert.equal((await request(app).get('/thing')).status, 200);
  assert.equal((await request(app).get('/thing')).status, 200);
  assert.equal((await request(app).get('/thing')).status, 429);
});

test('authenticated admin sessions bypass the limit', async () => {
  const { createSession } = await import('../src/auth.js');
  const token = createSession('admin-rate-limit-test');
  const app = express();
  app.use(createPublicRateLimit({ windowMs: 60_000, limit: 1 }));
  app.get('/thing', (_req, res) => res.status(200).json({ ok: true }));

  for (let i = 0; i < 3; i++) {
    const res = await request(app).get('/thing').set('Cookie', `session=${token}`);
    assert.equal(res.status, 200);
  }
});

test('requests are allowed again after the window expires', async () => {
  const app = express();
  app.use(createPublicRateLimit({ windowMs: 60_000, limit: 1 }));
  app.get('/thing', (_req, res) => res.status(200).json({ ok: true }));

  const realNow = Date.now;
  try {
    let now = 1_000_000;
    Date.now = () => now;
    assert.equal((await request(app).get('/thing')).status, 200);
    assert.equal((await request(app).get('/thing')).status, 429);
    now += 61_000;
    assert.equal((await request(app).get('/thing')).status, 200);
  } finally {
    Date.now = realNow;
  }
});

test('the IP map is bounded by maxIps', async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(createPublicRateLimit({ windowMs: 60_000, limit: 1, maxIps: 2 }));
  app.get('/thing', (_req, res) => res.status(200).json({ ok: true }));

  // Three distinct IPs: the first is evicted when the third arrives,
  // so a repeat request from IP 1 is treated as fresh (200, not 429).
  assert.equal((await request(app).get('/thing').set('X-Forwarded-For', '203.0.113.1')).status, 200);
  assert.equal((await request(app).get('/thing').set('X-Forwarded-For', '203.0.113.2')).status, 200);
  assert.equal((await request(app).get('/thing').set('X-Forwarded-For', '203.0.113.3')).status, 200);
  assert.equal((await request(app).get('/thing').set('X-Forwarded-For', '203.0.113.1')).status, 200);
});
