// Research-area bands end to end, no bertopic: a throwaway DB (bands-prepare.mjs)
// is run through the real `scripts/build-topics.py --bands-only` subprocess, then
// served by the real app on its own port. Fully offline: the Python labeller is
// pointed at a non-existent model with HF offline flags, so generate_local_labels
// returns {} and generate_band_labels uses its deterministic fallback names.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { bandsServerEnv, ADMIN_PASSWORD, BAND_TOPICS } from './bands-env.mjs';

const PORT = 4175;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const PYTHON = existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3';

let dataDir;
let dbPath;
let server;
let before;
let after;
let pythonOutput = '';

const SNAPSHOT_PY = `
import sqlite3, json, sys
c = sqlite3.connect(sys.argv[1], timeout=30)
def q(s):
    try:
        return [list(r) for r in c.execute(s)]
    except sqlite3.OperationalError:  # topic_bands is created by the Python job, not Node's schema
        return []
print(json.dumps({
  'topics': q('select * from topics order by topic_id'),
  'document_topics': q('select * from document_topics order by doc_id, topic_id'),
  'overrides': q('select * from topic_label_overrides order by topic_id'),
  'generation': q("select value from settings where key = 'topics_generation'"),
  'bandsVersion': q("select value from settings where key = 'topic_bands_version'"),
  'bands': q('select band_id, label, child_topic_ids, doc_count from topic_bands order by band_id'),
  'hierarchy': q('select id, leaf_topic_ids from topic_hierarchy_meta'),
}))
`;
const snapshot = () => JSON.parse(execFileSync(PYTHON, ['-I', '-c', SNAPSHOT_PY, dbPath], { encoding: 'utf8' }));

const EXEC_PY = `
import sqlite3, sys, json
c = sqlite3.connect(sys.argv[1], timeout=30)
for sql, args in json.loads(sys.argv[2]):
    c.execute(sql, args)
c.commit()
`;
const sqlExec = (statements) => execFileSync(PYTHON, ['-I', '-c', EXEC_PY, dbPath, JSON.stringify(statements)]);

function setJob(type, status) {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  sqlExec([
    ['DELETE FROM admin_jobs WHERE type = ?', [type]],
    ...(status === 'running'
      ? [["INSERT INTO admin_jobs (type, label, status, runner_state, heartbeat_at, timeout_at, started_at) VALUES (?, ?, 'running', 'running', ?, ?, ?)", [type, `fake ${type}`, now, later, now]]]
      : []),
  ]);
}

async function waitForHealth(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(`${URL_BASE}/api/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('bands server did not start');
}

test.describe.configure({ mode: 'serial' });

test.describe('research-area bands end to end', () => {
  test.use({ baseURL: URL_BASE });

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    try { if ((await fetch(`${URL_BASE}/api/health`)).ok) throw new Error('occupied'); } catch (e) {
      if (e.message === 'occupied') throw new Error(`port ${PORT} already serves /api/health; refusing to reuse it`);
    }
    dataDir = mkdtempSync(path.join(tmpdir(), 'oc-bands-'));
    dbPath = path.join(dataDir, 'metrics.sqlite');
    execFileSync(process.execPath, ['e2e/bands-prepare.mjs', dataDir], { stdio: 'pipe' });
    before = snapshot();

    pythonOutput = execFileSync(PYTHON, ['scripts/build-topics.py', '--bands-only'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        SQLITE_PATH: dbPath, TOPIC_BANDS_MIN: '2', TOPIC_BANDS_MAX: '4',
        // Offline labeller: no API key, no model download.
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LOCAL_LLM_MODEL: '/nonexistent/offline-model',
      },
    });
    after = snapshot();

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

  test('--bands-only ran offline and reported a band cut', () => {
    expect(pythonOutput).toContain('Band cut: k=3');
    expect(pythonOutput).toContain('Saved 3 research-area bands over 9 topics.');
  });

  test('bands partition the topics into the three meaning clusters', () => {
    expect(before.bands, 'no bands before the run').toEqual([]);
    expect(after.bands).toHaveLength(3);
    const memberships = after.bands.map((b) => JSON.parse(b[2]).sort((x, y) => x - y));
    const all = memberships.flat().sort((x, y) => x - y);
    expect(all).toEqual(BAND_TOPICS.map((t) => t.id)); // every topic exactly once
    expect(memberships).toEqual(expect.arrayContaining([[0, 3, 6], [1, 4, 7], [2, 5, 8]]));
    // doc_count sums to every assigned document
    expect(after.bands.reduce((n, b) => n + b[3], 0)).toBe(after.document_topics.length);
    // band ids ordered by paper count descending
    const counts = after.bands.map((b) => b[3]);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  test('band names were produced offline by the fallback labeller', () => {
    const labels = after.bands.map((b) => b[1]);
    expect(new Set(labels).size).toBe(3);
    for (const l of labels) expect(l).toMatch(/\S+ and related topics$/);
    expect(labels).toEqual(expect.arrayContaining(['Mathematics Teaching and related topics']));
    expect(pythonOutput).toContain('Failed to load local transformers model');
  });

  test('topics, document_topics, override and topics_generation are untouched; version is set', () => {
    expect(after.topics).toEqual(before.topics);
    expect(after.document_topics).toEqual(before.document_topics);
    expect(after.overrides).toEqual(before.overrides);
    expect(after.overrides).toHaveLength(1);
    expect(after.generation).toEqual(before.generation);
    expect(before.bandsVersion).toEqual([]);
    expect(after.bandsVersion).toHaveLength(1);
    expect(after.bandsVersion[0][0]).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(JSON.parse(after.hierarchy[0][1])).toEqual(BAND_TOPICS.map((t) => t.id));
  });

  test('analytics topic visuals render against the rebuilt DB with no console errors', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#documentsTable tr.doc-row').first()).toBeVisible();
    await page.locator('.tab-btn[data-tab="analytics"]').click();
    await page.locator('.sub-tab-btn[data-analytics-tab="visualizations"]').click();
    const legend = page.locator('#topicClusterLegend');
    await expect(legend).toContainText('Mathematics Teaching');
    await expect(legend).toContainText('Literacy Practices');
    // Topic Hierarchy (dendrogram) and Topic Evolution (timeline/sankey) draw content.
    await expect(page.locator('#topicDendrogramChart *').first()).toBeAttached();
    await expect.poll(() => page.locator('#topicDendrogramChart path, #topicDendrogramChart line').count()).toBeGreaterThan(3);
    await expect.poll(() => page.locator('#topicSankeyChart path, #topicSankeyChart rect').count()).toBeGreaterThan(0);
    await expect(page.getByRole('heading', { name: /Topic Evolution/ })).toBeVisible();
    // Dashboard sub-tab: the topic timeline chart still draws.
    await page.locator('.sub-tab-btn[data-analytics-tab="dashboard"]').click();
    const timeline = page.locator('#topicTimelineChart canvas');
    await expect(timeline).toBeVisible();
    await expect.poll(() => timeline.evaluate((c) => c.width > 0 && c.height > 0 && c.height !== 150)).toBe(true);
    await expect(page.locator('#topicBars')).toContainText('Mathematics Teaching');
  });

  test.describe('POST /api/admin/topics/bands/rebuild', () => {
    let csrf;
    const post = (request, p) => request.post(p, { headers: { 'x-csrf-token': csrf }, data: {} });

    test.beforeAll(async ({ playwright }) => {
      const ctx = await playwright.request.newContext({ baseURL: URL_BASE });
      const res = await ctx.post('/api/auth/login', { data: { username: 'admin', password: ADMIN_PASSWORD } });
      expect(res.status()).toBe(200);
      csrf = (await res.json()).csrfToken;
      test.info().annotations.push({ type: 'login', description: 'ok' });
      globalThis.__bandsAdminCtx = ctx;
    });
    test.afterAll(async () => { await globalThis.__bandsAdminCtx?.dispose(); delete globalThis.__bandsAdminCtx; });

    test('rejects anonymous callers', async ({ request }) => {
      expect((await request.post('/api/admin/topics/bands/rebuild', { data: {} })).status()).toBe(401);
    });

    test('409 while a bertopic job is running', async () => {
      setJob('bertopic', 'running');
      try {
        const res = await post(globalThis.__bandsAdminCtx, '/api/admin/topics/bands/rebuild');
        expect(res.status()).toBe(409);
        expect(await res.json()).toMatchObject({ runningType: 'bertopic' });
      } finally { setJob('bertopic', 'none'); }
    });

    test('409 while a topic_labels job is running', async () => {
      setJob('topic_labels', 'running');
      try {
        const res = await post(globalThis.__bandsAdminCtx, '/api/admin/topics/bands/rebuild');
        expect(res.status()).toBe(409);
        expect(await res.json()).toMatchObject({ runningType: 'topic_labels' });
      } finally { setJob('topic_labels', 'none'); }
    });

    test('202 alreadyRunning when a topic_bands job is running; labels/regenerate then 409', async () => {
      setJob('topic_bands', 'running');
      try {
        const res = await post(globalThis.__bandsAdminCtx, '/api/admin/topics/bands/rebuild');
        expect(res.status()).toBe(202);
        const body = await res.json();
        expect(body).toMatchObject({ ok: true, alreadyRunning: true });
        expect(body.jobId).toBeGreaterThan(0);

        const labels = await post(globalThis.__bandsAdminCtx, '/api/admin/topics/labels/regenerate');
        expect(labels.status()).toBe(409);
        expect(await labels.json()).toMatchObject({ bandsRunning: true, jobId: body.jobId });
      } finally { setJob('topic_bands', 'none'); }
    });

    // Not covered: the idle-start path (no job running) would call
    // createAndStartAdminWorkerJob and launch the real Python/Fly worker.
  });
});
