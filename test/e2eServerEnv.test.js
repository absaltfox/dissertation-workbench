import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedServerEnv } from '../e2e/server-env.mjs';

test('the e2e server env keeps only allowlisted host variables plus the test settings', () => {
  const env = isolatedServerEnv({
    PATH: '/usr/bin',
    HOME: '/home/tester',
    TMPDIR: '/tmp/x',
    FLY_API_TOKEN: 'fly-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    ADMIN_WORKER_MODE: 'fly',
    TURSO_AUTH_TOKEN: 'turso-secret',
    SOME_FUTURE_SECRET: 'unknown',
    NODE_OPTIONS: '--require ./evil.js',
  }, { PORT: '4173', NODE_ENV: 'development' });

  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/tester',
    TMPDIR: '/tmp/x',
    PORT: '4173',
    NODE_ENV: 'development',
  });
});

test('test settings override an allowlisted host variable of the same name', () => {
  assert.equal(isolatedServerEnv({ TZ: 'Europe/Paris' }, { TZ: 'UTC' }).TZ, 'UTC');
});
