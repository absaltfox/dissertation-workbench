/* global getComputedStyle, window */ // used inside page.evaluate() callbacks
// Research-area bands in the browser: Topic Evolution chart, palette, and the
// Admin > Topic Labels > Research Areas panel. Twelve bands are seeded straight
// into topic_bands (no Python, no network), served by their own app instance.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { bandsServerEnv, ADMIN_PASSWORD } from './bands-env.mjs';
import { BAND_PALETTE } from '../public/app/palette.js';

const PORT = 4176;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const BAND_COUNT = 12;
const autoName = (i) => `Area ${i + 1} Alpha`;
const AUTO_NAMES = Array.from({ length: BAND_COUNT }, (_, i) => autoName(i));
const SESSION_401 = [{ text: /status of 401/, urlPattern: /\/api\/auth\/session$/ }];

let dataDir;
let dbPath;
let server;

function sql(statements) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    for (const [text, args = []] of statements) db.prepare(text).run(...args);
  } finally { db.close(); }
}

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

async function waitForHealth(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(`${URL_BASE}/api/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('bands-ui server did not start');
}

// page.goto() to a URL that differs only by hash can stall on the app's own hash
// routing; change the hash in-page once a document is loaded.
async function gotoHash(page, hash) {
  if (page.url() === 'about:blank') await page.goto(`/${hash}`);
  else await page.evaluate((h) => { window.location.hash = h; }, hash);
}

async function openEvolution(page) {
  await gotoHash(page, '#/analytics');
  await page.locator('.sub-tab-btn[data-analytics-tab="visualizations"]').click();
  await expect(page.locator('#topicSankeyPanel')).toBeVisible();
}

const legendLabels = (page) => page.locator('#topicSankeyLegend .scatter-legend-item')
  .evaluateAll((els) => els.map((e) => e.textContent.trim()));

async function adminLogin(page) {
  // The login gate is briefly visible for a signed-in admin until /api/auth/session
  // answers, so decide from that response rather than from what is on screen.
  const sessionResponse = page.waitForResponse((r) => r.url().endsWith('/api/auth/session'));
  await gotoHash(page, '#/admin');
  const loggedIn = (await sessionResponse).status() === 200;
  if (!loggedIn) {
    await page.locator('#loginUsername').fill('admin');
    await page.locator('#loginPassword').fill(ADMIN_PASSWORD);
    await page.locator('#loginForm button[type="submit"]').click();
  }
  await page.locator('.admin-tab-btn[data-admin-tab="labels"]').click();
  await expect(page.locator('#researchAreasList [data-band-input]')).toHaveCount(BAND_COUNT);
}

async function rename(page, i, label) {
  await page.locator(`[data-band-input="${i}"]`).fill(label);
  await page.locator(`[data-save-band="${i}"]`).click();
  await expect(page.locator(`[data-reset-band="${i}"]`)).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.describe('research-area bands: chart and admin panel', () => {
  test.use({ baseURL: URL_BASE });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    try { if ((await fetch(`${URL_BASE}/api/health`)).ok) throw new Error('occupied'); } catch (e) {
      if (e.message === 'occupied') throw new Error(`port ${PORT} already serves /api/health; refusing to reuse it`);
    }
    dataDir = mkdtempSync(path.join(tmpdir(), 'oc-bands-ui-'));
    dbPath = path.join(dataDir, 'metrics.sqlite');
    execFileSync(process.execPath, ['e2e/bands-prepare.mjs', dataDir, String(BAND_COUNT), '--seed-bands'], { stdio: 'pipe' });
    server = spawn(process.execPath, ['e2e/bands-serve.mjs'], {
      env: { ...bandsServerEnv(dataDir, PORT), E2E_BANDS_DIR: dataDir, E2E_PORT: String(PORT) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    server.stderr.on('data', (d) => { stderr += d; });
    try { await waitForHealth(); } catch (err) {
      throw new Error(`${err.message}\n--- server stderr ---\n${stderr}`, { cause: err });
    }
  });

  test.afterAll(async () => {
    if (server) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const t = setTimeout(() => server.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(t);
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('Topic Evolution shows one series per band with the band names and caption', async ({ page }) => {
    await openEvolution(page);
    const labels = await legendLabels(page);
    expect(labels).toHaveLength(BAND_COUNT);
    expect([...labels].sort()).toEqual([...AUTO_NAMES].sort());
    await expect(page.locator('#topicSankeyPanel')).toContainText('research area');
    await expect(page.locator('#topicSankeyPanel')).toContainText(
      'Related topics are grouped into research areas by the meaning of their papers',
    );
    await expect(page.locator('#topicSankeyPanel')).toContainText('admins can rename areas');
    // Flows exist and use only palette colours.
    const fills = await page.locator('#topicSankeyChart path[fill]').evaluateAll((ps) => [...new Set(ps.map((p) => p.getAttribute('fill')))]);
    expect(fills.length).toBeGreaterThan(1);
    for (const f of fills) expect(BAND_PALETTE.slice(0, BAND_COUNT)).toContain(f);
  });

  test('legend swatches equal BAND_PALETTE[i] in order and match the flows', async ({ page }) => {
    await openEvolution(page);
    const swatches = await page.locator('#topicSankeyLegend .scatter-legend-swatch')
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
    expect(swatches).toEqual(BAND_PALETTE.slice(0, BAND_COUNT).map(hexToRgb));
    const opacity = await page.locator('#topicSankeyLegend .scatter-legend-swatch').first()
      .evaluate((e) => getComputedStyle(e).opacity);
    expect(opacity).toBe('0.85');
    const flowOpacity = await page.locator('#topicSankeyChart path[fill]').first().getAttribute('fill-opacity');
    expect(flowOpacity).toBe('0.85');
  });

  test.describe('admin Research Areas panel', () => {
    test.use({ allowedConsoleErrors: SESSION_401 });

    test('lists every band with name, paper count and child topics', async ({ page }) => {
      await adminLogin(page);
      await expect(page.locator('#researchAreasPanel h2')).toHaveText('Research Areas');
      const list = page.locator('#researchAreasList');
      await expect(list).toContainText(autoName(0));
      await expect(list).toContainText('papers');
      await expect(list).toContainText('Mathematics Teaching (');
      await expect(page.locator('[data-reset-band]')).toHaveCount(0);
      await expect(page.locator('#rebuildResearchAreasBtn')).toBeVisible();
    });

    test('rename shows Manual badge and Topic Evolution shows the new name after reload', async ({ page }) => {
      await adminLogin(page);
      await rename(page, 0, 'Renamed Research Area');
      await expect(page.locator('#researchAreasList')).toContainText('Manual (auto: Area 1 Alpha)');
      await expect(page.locator('[data-band-input="0"]')).toHaveValue('Renamed Research Area');

      await page.reload();
      await openEvolution(page);
      const labels = await legendLabels(page);
      expect(labels).toContain('Renamed Research Area');
      expect(labels).not.toContain(autoName(0));
      expect(labels).toHaveLength(BAND_COUNT);
    });

    test('Reset to automatic restores the auto name in the panel and the chart', async ({ page }) => {
      await adminLogin(page);
      await expect(page.locator('[data-band-input="0"]')).toHaveValue('Renamed Research Area');
      await page.locator('[data-reset-band="0"]').click();
      await expect(page.locator('[data-reset-band="0"]')).toHaveCount(0);
      await expect(page.locator('[data-band-input="0"]')).toHaveValue(autoName(0));
      await expect(page.locator('#researchAreasList')).not.toContainText('Manual (auto');

      await page.reload();
      await openEvolution(page);
      const labels = await legendLabels(page);
      expect(labels).toContain(autoName(0));
      expect(labels).not.toContain('Renamed Research Area');
    });

    test('an HTML-ish name renders escaped in the panel and the chart legend', async ({ page }) => {
      await adminLogin(page);
      await rename(page, 1, '<b>x</b>');
      await expect(page.locator('#researchAreasList strong', { hasText: '<b>x</b>' })).toBeVisible();
      await expect(page.locator('#researchAreasList b')).toHaveCount(0);

      await page.reload();
      await openEvolution(page);
      expect(await legendLabels(page)).toContain('<b>x</b>');
      await expect(page.locator('#topicSankeyLegend b')).toHaveCount(0);

      await adminLogin(page);
      await page.locator('[data-reset-band="1"]').click();
      await expect(page.locator('[data-reset-band="1"]')).toHaveCount(0);
    });

    test('Rebuild Research Areas shows its status message (POST stubbed)', async ({ page }) => {
      const posts = [];
      await page.route('**/api/admin/topics/bands/rebuild', (route) => {
        posts.push(route.request().method());
        const body = posts.length === 1
          ? { ok: true, started: true, jobId: 99 }
          : { ok: true, alreadyRunning: true, jobId: 99 };
        return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await adminLogin(page);
      await page.locator('#rebuildResearchAreasBtn').click();
      await expect(page.locator('#statusText')).toHaveText('Research-area rebuild started. Follow it in Admin > Jobs.');
      await expect(page.locator('#rebuildResearchAreasBtn')).toBeEnabled();
      await page.locator('#rebuildResearchAreasBtn').click();
      await expect(page.locator('#statusText')).toHaveText('A research-area rebuild is already running. Follow it in Admin > Jobs.');
      expect(posts).toEqual(['POST', 'POST']);
    });

    test('route validation: empty, oversized and unknown-band names are rejected', async ({ page }) => {
      await adminLogin(page);
      // page.request shares the browser's session cookie and logs no console errors.
      const csrf = (await (await page.request.get('/api/auth/session')).json()).csrfToken;
      const patch = async (id, label) => (await page.request.patch(`/api/admin/topics/bands/${id}/label`, {
        headers: { 'x-csrf-token': csrf }, data: { label },
      })).status();
      expect(await patch(0, '')).toBe(400);
      expect(await patch(0, 'x'.repeat(121))).toBe(400);
      expect(await patch(0, 42)).toBe(400);
      expect(await patch('abc', 'ok')).toBe(400);
      expect(await patch(999, 'ok')).toBe(404);
    });
  });

  test('with no bands the chart falls back to topic clusters without console errors', async ({ page }) => {
    sql([
      ['DELETE FROM topic_bands'],
      ['DELETE FROM topic_band_label_overrides'],
      ["INSERT INTO settings (key, value, updated_at) VALUES ('topic_bands_version', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [new Date().toISOString(), new Date().toISOString()]],
    ]);
    await openEvolution(page);
    const labels = await legendLabels(page);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some((l) => l.includes('Mathematics Teaching'))).toBe(true);
    for (const l of labels) expect(l).not.toMatch(/^Area \d+ Alpha/);
  });
});
