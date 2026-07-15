import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

let tempDir;
let app;
let getAllSettings;
let closeDb;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-admin-settings-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;

  const db = await import('../src/db.js');
  getAllSettings = db.getAllSettings;
  closeDb = db.closeDb;
  await db.ensureStorage();

  const { createAdminUsersRouter } = await import('../src/routes/adminUsersRoutes.js');
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'admin' }; next(); });
  app.use('/api/admin', createAdminUsersRouter());
});

test.after(async () => {
  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('unknown settings keys are rejected, known keys persist', async () => {
  const res = await request(app)
    .put('/api/admin/settings')
    .send({ maxRecords: '500', rogueKey: 'evil' });
  assert.equal(res.status, 200);
  const settings = await getAllSettings();
  assert.equal(settings.maxRecords, '500');
  assert.equal(settings.rogueKey, undefined);
});
