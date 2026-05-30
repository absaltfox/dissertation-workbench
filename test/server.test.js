import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/server.js';
import { createSession, destroySession, getSessionCsrfToken } from '../src/auth.js';

test('GET /api/health returns an ok payload', async () => {
  const res = await request(app)
    .get('/api/health')
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(res.body.ok, true);
  assert.match(res.body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('GET / serves the static dashboard shell', async () => {
  const res = await request(app)
    .get('/')
    .expect('content-type', /text\/html/)
    .expect(200);

  assert.match(res.text, /<html/i);
});

test('GET /app.js serves the frontend bundle', async () => {
  const res = await request(app)
    .get('/app.js')
    .expect(200);

  assert.match(res.headers['content-type'], /(application|text)\/javascript/);
  assert.match(res.text, /fetch\(/);
});

test('unknown paths return the JSON 404 contract', async () => {
  const res = await request(app)
    .get('/does-not-exist')
    .expect('content-type', /application\/json/)
    .expect(404);

  assert.deepEqual(res.body, { error: 'Not found' });
});

test('unauthenticated session check returns 401', async () => {
  const res = await request(app)
    .get('/api/auth/session')
    .expect('content-type', /application\/json/)
    .expect(401);

  assert.deepEqual(res.body, { error: 'Not authenticated' });
});

test('admin routes reject unauthenticated requests', async () => {
  const res = await request(app)
    .get('/api/admin/users')
    .expect('content-type', /application\/json/)
    .expect(401);

  assert.deepEqual(res.body, { error: 'Authentication required' });
});

test('authenticated mutations require a valid CSRF token', async () => {
  const token = createSession('admin');
  try {
    await request(app)
      .post('/api/admin/cache/refresh')
      .set('Cookie', `session=${token}`)
      .expect('content-type', /application\/json/)
      .expect(403);

    const csrfToken = getSessionCsrfToken(token);
    const res = await request(app)
      .post('/api/admin/cache/refresh')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', csrfToken)
      .expect('content-type', /application\/json/)
      .expect(200);

    assert.deepEqual(res.body, { ok: true, message: 'In-memory cache cleared. Next query will re-fetch.' });
  } finally {
    destroySession(token);
  }
});

test('metrics validates query parameters before collecting data', async () => {
  const res = await request(app)
    .get('/api/metrics?maxRecords=10000')
    .expect('content-type', /application\/json/)
    .expect(400);

  assert.equal(res.body.error, 'Validation failed');
  assert.deepEqual(res.body.errors, ['maxRecords must be between 1 and 9999.']);
});
