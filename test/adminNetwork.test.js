import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAllowedNetworks, isAllowedAdminIp } from '../src/middleware/adminNetwork.js';

test('unset or blank allows everyone', () => {
  assert.equal(parseAllowedNetworks(undefined), null);
  assert.equal(parseAllowedNetworks('  '), null);
  assert.equal(isAllowedAdminIp(null, '8.8.8.8'), true);
});

test('single IP and CIDR', () => {
  const list = parseAllowedNetworks('203.0.113.5, 10.0.0.0/8');
  assert.equal(isAllowedAdminIp(list, '203.0.113.5'), true);
  assert.equal(isAllowedAdminIp(list, '10.2.3.4'), true);
  assert.equal(isAllowedAdminIp(list, '203.0.113.6'), false);
  assert.equal(isAllowedAdminIp(list, ''), false);
});

test('IPv4-mapped IPv6 client', () => {
  const list = parseAllowedNetworks('203.0.113.5, 10.0.0.0/8');
  assert.equal(isAllowedAdminIp(list, '::ffff:203.0.113.5'), true);
  assert.equal(isAllowedAdminIp(list, '::ffff:203.0.113.6'), false);
});

test('IPv6 entry', () => {
  const list = parseAllowedNetworks('2001:db8::/32');
  assert.equal(isAllowedAdminIp(list, '2001:db8::1'), true);
  assert.equal(isAllowedAdminIp(list, '2001:db9::1'), false);
});

test('bad entry throws', () => {
  for (const bad of ['not-an-ip', '10.0.0.0/33', '10.0.0.0/x', '1.2.3.4/8/9']) {
    assert.throws(() => parseAllowedNetworks(`203.0.113.9, ${bad}`), (e) => e.message.includes(`Invalid ADMIN_ALLOWED_NETWORKS entry: ${bad}`));
  }
});

const SCRIPT = `
import request from 'supertest';
import { app } from './src/server.js';
import { closeDb } from './src/db.js';
const paths = JSON.parse(process.env.PROBE_PATHS);
const out = {};
for (const [method, p] of paths) {
  const res = await request(app)[method](p);
  out[method + ' ' + p] = res.status;
}
console.log('RESULT' + JSON.stringify(out));
await closeDb();
process.exit(0);
`;

function probe(env, paths) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-net-'));
  try {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'development',
        SQLITE_PATH: path.join(dir, 'm.sqlite'),
        APP_DATA_DIR: dir,
        PROBE_PATHS: JSON.stringify(paths),
        ...env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const line = res.stdout.split('\n').find((l) => l.startsWith('RESULT'));
    assert.ok(line, `no result: ${res.stderr}`);
    return JSON.parse(line.slice('RESULT'.length));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('gate hides auth and admin (all path variants) but not health or internal', () => {
  const paths = [
    ['get', '/api/auth/session'], ['get', '/api/auth/available'], ['get', '/API/auth/session'], ['get', '/api/auth/session/'],
    ['post', '/api/auth/login'], ['get', '/api/admin/topics/labels'], ['get', '/api/admin/'],
    ['get', '/API/ADMIN/topics/labels'], ['get', '/api/health'],
    ['get', '/api/internal/jobs/1/artifacts/pdf/x'],
  ];
  const r = probe({ ADMIN_ALLOWED_NETWORKS: '203.0.113.9' }, paths);
  for (const key of Object.keys(r)) {
    if (key.includes('/health')) assert.equal(r[key], 200, key);
    else if (key.includes('/internal')) assert.notEqual(r[key], 404, key);
    else assert.equal(r[key], 404, key);
  }
});

test('gate allows a matching client and leaves everything open when unset', () => {
  const allowed = probe({ ADMIN_ALLOWED_NETWORKS: '203.0.113.9, 127.0.0.0/8' }, [['get', '/api/auth/session'], ['get', '/api/auth/available']]);
  assert.equal(allowed['get /api/auth/session'], 401);
  assert.equal(allowed['get /api/auth/available'], 200);
  const unset = probe({}, [['get', '/api/auth/session']]);
  assert.equal(unset['get /api/auth/session'], 401);
});

test('invalid ADMIN_ALLOWED_NETWORKS fails startup', () => {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/config.js'"], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { PATH: process.env.PATH, ADMIN_ALLOWED_NETWORKS: 'oops' },
    encoding: 'utf8',
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Invalid ADMIN_ALLOWED_NETWORKS entry: oops/);
});

test('TRUST_PROXY parses to a hop count, never a bare true', async () => {
  const { parseTrustProxy } = await import('../src/requestSecurity.js');
  for (const v of ['1', 'true', 'TRUE', 'Yes']) assert.equal(parseTrustProxy(v), 1, v);
  assert.equal(parseTrustProxy('2'), 2);
  for (const v of [undefined, '', '0', 'false', 'nope', '-1']) assert.equal(parseTrustProxy(v), false, String(v));
});

const XFF_SCRIPT = SCRIPT.replace('request(app)[method](p)', 'request(app)[method](p).set("X-Forwarded-For", process.env.PROBE_XFF)');

test('X-Forwarded-For cannot spoof the allow-list with TRUST_PROXY=1', () => {
  const run = (xff) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-net-'));
    try {
      const res = spawnSync(process.execPath, ['--input-type=module', '-e', XFF_SCRIPT], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: {
          PATH: process.env.PATH, NODE_ENV: 'development', SQLITE_PATH: path.join(dir, 'm.sqlite'),
          APP_DATA_DIR: dir, TRUST_PROXY: '1', ADMIN_ALLOWED_NETWORKS: '203.0.113.9',
          PROBE_XFF: xff, PROBE_PATHS: JSON.stringify([['get', '/api/auth/session']]),
        },
        encoding: 'utf8', timeout: 60_000,
      });
      const line = res.stdout.split('\n').find((l) => l.startsWith('RESULT'));
      assert.ok(line, res.stderr);
      return JSON.parse(line.slice(6))['get /api/auth/session'];
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  assert.equal(run('203.0.113.9, 198.51.100.77'), 404);
  assert.equal(run('198.51.100.77, 203.0.113.9'), 401);
});
