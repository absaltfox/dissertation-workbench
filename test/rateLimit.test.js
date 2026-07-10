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
