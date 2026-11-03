/* global window */ // used inside page.evaluate() callbacks
import { spawn } from 'node:child_process';
import { test, expect } from './fixtures.js';

const GATED_PORT = 4174;
const GATED_URL = `http://127.0.0.1:${GATED_PORT}`;
let server;

async function isUp(url) {
  try {
    return (await fetch(`${url}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('gated server did not start');
}

test.describe('admin network gate: default server (unset)', () => {
  test.describe('login form', () => {
    // Opening the login form probes /api/auth/session, which answers 401 when logged out.
    test.use({ allowedConsoleErrors: [{ text: /status of 401/, urlPattern: /\/api\/auth\/session$/ }] });

  test('admin tab and login form are available', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.tab-btn[data-tab="admin"]')).toBeVisible();
    await page.locator('.tab-btn[data-tab="admin"]').click();
    await expect(page.locator('#loginForm')).toBeVisible();
    await expect(page.locator('#loginUsername')).toBeVisible();
  });
  });

  test('auth API is reachable (not 404)', async ({ request }) => {
    const res = await request.get('/api/auth/available');
    expect(res.status()).not.toBe(404);
  });
});

test.describe('admin network gate: ADMIN_ALLOWED_NETWORKS set to a non-matching address', () => {
  test.use({ baseURL: GATED_URL });
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    // A stale server on this port would answer the health probe and make every
    // gate assertion test the wrong process.
    if (await isUp(GATED_URL)) throw new Error(`port ${GATED_PORT} already serves /api/health; refusing to reuse it`);
    server = spawn(process.execPath, ['e2e/start-server.mjs'], {
      env: { ...process.env, E2E_PORT: String(GATED_PORT), E2E_ADMIN_ALLOWED_NETWORKS: '203.0.113.9' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    server.stderr.on('data', (d) => { stderr += d; });
    try {
      await waitForHealth(GATED_URL, 60);
    } catch (err) {
      throw new Error(`${err.message}\n--- gated server stderr ---\n${stderr}`, { cause: err });
    }
  });

  test.afterAll(async () => {
    if (!server) return;
    const exited = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    const t = setTimeout(() => server.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(t);
  });

  test('API: auth and admin are 404, health is 200', async ({ request }) => {
    for (const path of ['/api/auth/available', '/api/auth/session', '/api/admin/jobs', '/api/admin/users']) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
    expect((await request.post('/api/auth/login', { data: { username: 'a', password: 'b' } })).status()).toBe(404);
    expect((await request.get('/api/health')).status()).toBe(200);
  });

  test.describe('UI', () => {
    // The browser itself logs the intentional 404 from the page-load probe of
    // /api/auth/available; nothing else is tolerated.
    test.use({ allowedConsoleErrors: [{ text: /status of 404/, urlPattern: /\/api\/auth\/available$/ }] });

    test('admin tab is absent from the UI', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('.tab-btn[data-tab="records"]')).toBeVisible();
      await expect(page.locator('.tab-btn[data-tab="admin"]')).toHaveCount(0);
    });

    test('#/admin on load redirects to the default tab', async ({ page }) => {
      await page.goto('/#/admin');
      await expect(page.locator('#tab-records')).toBeVisible();
      await expect(page.locator('#tab-admin')).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/documents');
    });

    test('#/admin via later hash change redirects to the default tab', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#documentsTable tr.doc-row').first()).toBeVisible();
      await page.locator('.tab-btn[data-tab="about"]').click();
      await expect(page.locator('#tab-about')).toBeVisible();
      await page.evaluate(() => { window.location.hash = '#/admin'; });
      await expect(page.locator('#tab-records')).toBeVisible();
      await expect(page.locator('#tab-admin')).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/documents');
    });
  });
});
