import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { buildPqfQuery, sanitizePqfValue } from '../src/catalogueQuery.js';
import { getTrustedClientIp } from '../src/requestSecurity.js';
import {
  assertSafeDownloadUrl,
  isBlockedAddress,
  safeFetchDownloadUrl,
} from '../src/urlSafety.js';

function resolver(addresses) {
  return async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

test('trusted client IP uses Express resolved IP rather than raw forwarded headers', () => {
  const req = {
    ip: '203.0.113.10',
    headers: { 'x-forwarded-for': '10.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  };

  assert.equal(getTrustedClientIp(req), '203.0.113.10');
});

test('download URL safety allows Open Collections HTTPS URLs', async () => {
  const url = await assertSafeDownloadUrl('https://open.library.ubc.ca/media/download/pdf/24/test/1', {
    resolveHost: resolver(['142.103.59.187']),
  });

  assert.equal(url.hostname, 'open.library.ubc.ca');
});

test('download URL safety rejects unsupported schemes and blocked networks', async () => {
  await assert.rejects(() => assertSafeDownloadUrl('javascript:alert(1)'), /scheme/i);
  await assert.rejects(() => assertSafeDownloadUrl('https://example.com/file.pdf'), /host/i);
  await assert.rejects(
    () => assertSafeDownloadUrl('https://open.library.ubc.ca/file.pdf', {
      resolveHost: resolver(['127.0.0.1']),
    }),
    /blocked address/i
  );

  assert.equal(isBlockedAddress('10.0.0.2'), true);
  assert.equal(isBlockedAddress('169.254.169.254'), true);
  assert.equal(isBlockedAddress('::1'), true);
});

test('safe download fetch rejects unsafe redirects', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {
    status: 302,
    headers: { location: 'http://169.254.169.254/latest/meta-data' },
  });

  try {
    await assert.rejects(
      () => safeFetchDownloadUrl('https://open.library.ubc.ca/item', {}, {
        resolveHost: resolver(['142.103.59.187']),
      }),
      /scheme|host|blocked/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Z39.50 query values strip command-control characters', () => {
  assert.equal(sanitizePqfValue('Title"\nquit\nshow 1'), 'Title quit show 1');
  assert.equal(
    buildPqfQuery('Smith\r\nquit', 'Learning\nshow 1'),
    '@and @attr 1=4 "Learning show 1" @attr 1=1003 "Smith quit"'
  );
});

test('frontend external URL sanitizer rejects executable schemes', async () => {
  const appSource = await fs.readFile(new URL('../public/app/core.js', import.meta.url), 'utf8');
  const match = appSource.match(/function safeExternalHref[\s\S]*?\n}\n\nfunction normalizeAffiliation/);
  assert.ok(match, 'safeExternalHref function should be present');

  const context = {
    window: { location: { origin: 'http://localhost:4000' } },
    URL,
    results: null,
  };
  const source = match[0].replace(/\n\nfunction normalizeAffiliation$/, '');
  vm.runInNewContext(`${source}
results = [
  safeExternalHref('https://open.library.ubc.ca/item'),
  safeExternalHref('javascript:alert(1)'),
  safeExternalHref('data:text/html,hi'),
  safeExternalHref('http://evil.example/item'),
  safeExternalHref('http://'),
];`, context);

  assert.equal(JSON.stringify(context.results), JSON.stringify(['https://open.library.ubc.ca/item', '', '', '', '']));
});
