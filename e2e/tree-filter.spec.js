// Topic Hierarchy under filters: the tree keeps its shape, topics with no
// matching manuscripts are muted and unclickable, and a caption counts the
// topics that match. Served from its own seeded DB with a chain hierarchy.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { bandsServerEnv } from './bands-env.mjs';

const PORT = 4177;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const N = 9;
const EDD = 'Doctor of Education - EdD';
const PHD = 'Doctor of Philosophy - PhD';
// e2e-doc-5 keeps its MA degree but loses its topic rows: an MA filter then
// matches manuscripts without any topic.
const NO_TOPIC_DOC = 'e2e-doc-5';
// The only manuscript in this program; it sits in topic 2.
const ONE_TOPIC_PROGRAM = 'Educational Leadership';

let dataDir;
let server;

function sql(dbPath, statements) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    for (const [text, args = []] of statements) db.prepare(text).run(...args);
  } finally { db.close(); }
}

async function waitForHealth(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(`${URL_BASE}/api/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('tree-filter server did not start');
}

async function openTree(page) {
  await page.goto('/#/analytics');
  await page.locator('.sub-tab-btn[data-analytics-tab="visualizations"]').click();
  await expect(page.locator('#topicDendrogramPanel')).toBeVisible();
  await expect(page.locator('#topicDendrogramChart g.tree-leaf')).toHaveCount(N);
}

const leaf = (page, id) => page.locator(`#topicDendrogramChart g.tree-leaf[data-topic-id="${id}"]`);
const summary = (page) => page.locator('#topicDendrogramMatchSummary');
const radii = (page) => page.locator('#topicDendrogramChart g.tree-leaf circle')
  .evaluateAll((els) => els.map((e) => Number(e.getAttribute('r'))));

test.describe.configure({ mode: 'serial' });

test.describe('topic hierarchy under filters', () => {
  test.use({ baseURL: URL_BASE });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    try { if ((await fetch(`${URL_BASE}/api/health`)).ok) throw new Error('occupied'); } catch (e) {
      if (e.message === 'occupied') throw new Error(`port ${PORT} already serves /api/health; refusing to reuse it`);
    }
    dataDir = mkdtempSync(path.join(tmpdir(), 'oc-tree-filter-'));
    execFileSync(process.execPath, ['e2e/bands-prepare.mjs', dataDir, String(N)], { stdio: 'pipe' });
    // Chain linkage over leaves 0..N-1: row 0 joins leaves 0 and 1, row i joins
    // the previous cluster with leaf i+1.
    const linkage = Array.from({ length: N - 1 }, (_, i) => (i === 0 ? [0, 1, 1.0] : [N + i - 1, i + 1, 1.0 + i]));
    sql(path.join(dataDir, 'metrics.sqlite'), [
      ["INSERT INTO topic_hierarchy_meta (id, leaf_topic_ids, linkage_json, created_at) VALUES (1, ?, ?, '2026-11-05T00:00:00.000Z')",
        [JSON.stringify(Array.from({ length: N }, (_, i) => i)), JSON.stringify(linkage)]],
      [`UPDATE documents SET degree = CASE
          WHEN doc_id IN (SELECT doc_id FROM document_topics WHERE topic_id IN (0, 1)) THEN ?
          ELSE ? END
        WHERE doc_id <> ?`, [EDD, PHD, NO_TOPIC_DOC]],
      ['DELETE FROM document_topics WHERE doc_id = ?', [NO_TOPIC_DOC]],
    ]);
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

  test('unfiltered tree has no muted topics and no caption', async ({ page }) => {
    await openTree(page);
    await expect(page.locator('#topicDendrogramChart .tree-leaf--empty')).toHaveCount(0);
    await expect(page.locator('#topicDendrogramChart .tree-link--empty')).toHaveCount(0);
    await expect(summary(page)).toBeHidden();
    await expect(page.locator('#topicDendrogramPanel')).toContainText('Topics grouped by what their manuscripts are about');
  });

  test('EdD filter mutes topics with no matches', async ({ page }) => {
    await openTree(page);
    await page.locator('#filterDegree').selectOption(EDD);
    await expect(summary(page)).toHaveText(`Topics with matching manuscripts: 2 of ${N}`);
    await expect(page.locator('#topicDendrogramChart .tree-leaf--empty')).toHaveCount(N - 2);
    await expect(leaf(page, 0)).not.toHaveClass(/tree-leaf--empty/);
    await expect(leaf(page, 1)).not.toHaveClass(/tree-leaf--empty/);
    expect(await page.locator('#topicDendrogramChart .tree-link--empty').count()).toBeGreaterThan(0);
    for (const r of await radii(page)) expect(Number.isFinite(r)).toBe(true);
  });

  test('tooltip text for topics with and without matches', async ({ page }) => {
    await openTree(page);
    await page.locator('#filterDegree').selectOption(EDD);
    await expect(summary(page)).toBeVisible();
    const tooltip = page.locator('#topicDendrogramTooltip');
    await leaf(page, 0).locator('circle').hover();
    await expect(tooltip).toContainText(/\d+ of \d+ manuscripts match the current filters/);
    await leaf(page, 5).locator('circle').hover();
    await expect(tooltip).toContainText('No manuscripts match the current filters');
  });

  test('clicking a topic with no matches opens nothing', async ({ page }) => {
    await openTree(page);
    await page.locator('#filterDegree').selectOption(EDD);
    await expect(summary(page)).toBeVisible();
    const modal = page.locator('#docModalOverlay');
    await leaf(page, 5).locator('circle').click();
    await expect(modal).toBeHidden();
    // The clicked list has exactly the tooltip's match count.
    await leaf(page, 0).locator('circle').hover();
    const tip = await page.locator('#topicDendrogramTooltip').textContent();
    const matched = Number(/(\d+) of \d+ manuscripts match/.exec(tip)[1]);
    expect(matched).toBeGreaterThan(0);
    await leaf(page, 0).locator('circle').click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('.related-item')).toHaveCount(matched);
  });

  test('one matching topic renders finite radii', async ({ page }) => {
    await openTree(page);
    await page.locator('#filterProgram').selectOption(ONE_TOPIC_PROGRAM);
    await expect(summary(page)).toHaveText(`Topics with matching manuscripts: 1 of ${N}`);
    await expect(leaf(page, 2)).not.toHaveClass(/tree-leaf--empty/);
    for (const r of await radii(page)) expect(Number.isFinite(r)).toBe(true);
  });

  test('filter with no topic matches', async ({ page }) => {
    await openTree(page);
    await page.locator('#filterDegree').selectOption('Master of Arts - MA');
    await expect(summary(page)).toHaveText(`Topics with matching manuscripts: 0 of ${N}`);
    await expect(page.locator('#topicDendrogramChart .tree-leaf--empty')).toHaveCount(N);
    for (const r of await radii(page)) expect(Number.isFinite(r)).toBe(true);
  });

  test('clearing the filter restores the tree', async ({ page }) => {
    await openTree(page);
    await page.locator('#filterDegree').selectOption(EDD);
    await expect(summary(page)).toBeVisible();
    await page.locator('#clearFacets').click();
    await expect(summary(page)).toBeHidden();
    await expect(page.locator('#topicDendrogramChart .tree-leaf--empty')).toHaveCount(0);
    await expect(page.locator('#topicDendrogramChart .tree-link--empty')).toHaveCount(0);
    await leaf(page, 0).locator('circle').hover();
    await expect(page.locator('#topicDendrogramTooltip')).toContainText('manuscript(s)');
  });
});
