# Code Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 16 issues from the 2026-07-10 code review: make public analytics cover the entire stored corpus (or as filtered), stop public reads from writing to the DB, bound the caches, wire in the dormant download-safety code, fix worker/job lifecycle bugs, and tighten citation/person data quality.

**Architecture:** All changes stay inside the existing Express + libSQL architecture. Analytics slices switch from `LIMIT maxRecords` reads to full-corpus reads (the corpus is local and small — hundreds of rows). Safety and lifecycle fixes reuse modules that already exist (`urlSafety.js`, `detectDownloadBlockPage`, `reapStaleAdminJobs`) rather than adding new subsystems.

**Tech Stack:** Node 22.5+, ESM, Express 5, `@libsql/client`, `node:test` + `supertest` for tests. **Zero new npm dependencies.**

## Global Constraints

- Node `>=22.5`, ESM only (`import`, never `require`).
- No new npm dependencies.
- Every task ends with `npm test` fully green (102+ tests).
- Tests follow the repo convention: set `APP_DATA_DIR`/`SQLITE_PATH` env vars to a temp dir in `test.before()` **before** dynamically importing any `src/` module (see `test/workbenchRoutes.test.js:20-25`).
- Match existing code style: no semicolon-free style, single quotes, 2-space indent.
- `url.searchParams.get()` returns `null` for missing params — use `!= null` checks.

---

### Task 1: Public analytics over the entire corpus

The dashboard currently truncates every read to `maxRecords` (capped at `PUBLIC_MAX_RECORDS` = 300 in prod, ordered `year DESC`), so anonymous analytics silently cover only the newest slice. Reads are local DB reads now, so the cap serves no purpose. Remove the truncation from all cached-document reads and shrink the cache key to the fields that still affect results.

**Files:**
- Modify: `src/db.js` (`listCachedDocuments`, ~line 562)
- Modify: `src/routes/metricsRoutes.js` (`sourceCacheKey` ~line 84, `cachedDocumentsForParams` ~line 585, `documentPageForParams` ~line 609, `/metrics` route ~line 1028)
- Modify: `src/metrics.js` (`collectMetricRecords`, ~line 978)
- Test: `test/fullCorpusAnalytics.test.js` (create)

**Interfaces:**
- Consumes: existing `saveDocumentMetadata(doc, { syncKey })`, `createMetricsRouter({ metricsCache, metricsInflight, loadSyncModule })`.
- Produces: `listCachedDocuments({ syncKey, limit = null, offset = 0 })` — `limit: null` now means "no limit". All later tasks assume analytics payloads contain the full corpus.

- [ ] **Step 1: Write the failing test**

Create `test/fullCorpusAnalytics.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

let tempDir;
let app;
let saveDocumentMetadata;
let closeDb;

const SYNC_KEY = 'full-corpus-test-key';
const loadSyncModule = async () => ({ getSyncKeyForOptions: () => SYNC_KEY });

function makeDoc(i) {
  return {
    id: `1.000000${i}`,
    title: `Dissertation ${i}`,
    author: `Author ${i}`,
    authors: [`Author ${i}`],
    supervisors: [],
    affiliation: ['UBC'],
    year: 2000 + i,
    degree: 'EdD',
    program: 'Education',
    abstract: `Abstract text for dissertation number ${i} about adult education.`,
    subjects: ['education'],
    themes: [],
    methodologies: [],
    conceptTerms: [],
  };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-full-corpus-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;

  const db = await import('../src/db.js');
  saveDocumentMetadata = db.saveDocumentMetadata;
  closeDb = db.closeDb;
  await db.ensureStorage();

  for (let i = 1; i <= 5; i++) {
    await saveDocumentMetadata(makeDoc(i), { syncKey: SYNC_KEY });
  }

  const { createMetricsRouter } = await import('../src/routes/metricsRoutes.js');
  app = express();
  app.use(express.json());
  app.use('/api', createMetricsRouter({
    metricsCache: new Map(),
    metricsInflight: new Map(),
    loadSyncModule,
  }));
});

test.after(async () => {
  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('analytics covers the entire corpus even when maxRecords is small', async () => {
  const res = await request(app).get('/api/workbench/analytics?maxRecords=2');
  assert.equal(res.status, 200);
  assert.equal(res.body.metrics.recordCount, 5);
  assert.equal(res.body.documents.length, 5);
});

test('document page total reflects the full corpus', async () => {
  const res = await request(app).get('/api/workbench/documents?maxRecords=2&limit=2&offset=0');
  assert.equal(res.status, 200);
  assert.equal(res.body.source.total, 5);
  assert.equal(res.body.documents.length, 2);
  assert.equal(res.body.source.hasMore, true);
});

test('bootstrap summary counts the full corpus', async () => {
  const res = await request(app).get('/api/workbench/bootstrap?maxRecords=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.documents, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fullCorpusAnalytics.test.js`
Expected: FAIL — `recordCount` is 2 (truncated by maxRecords), total is 2.

- [ ] **Step 3: Make `listCachedDocuments` limit optional**

In `src/db.js`, replace the tail of `listCachedDocuments`:

```js
export async function listCachedDocuments({ syncKey, limit = null, offset = 0 } = {}) {
  const args = [];
  let sql = `
    SELECT d.doc_id, d.metadata_json,
           fm.download_url, fm.file_bytes, fm.word_count, fm.body_word_count,
           fm.page_count, fm.word_source, fm.page_source, fm.status, fm.error
    FROM documents d
    LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
  `;
  if (syncKey) {
    sql += ' WHERE d.sync_key = ?';
    args.push(syncKey);
  }
  sql += ' ORDER BY d.year DESC, d.title';
  if (limit != null) {
    sql += ' LIMIT ? OFFSET ?';
    args.push(limit, offset);
  }
  const rows = await all(sql, args);
  return rows.map((row) => {
    try {
      const doc = JSON.parse(row.metadata_json);
      return applyStoredFileMetricToDocument(doc, row);
    } catch {
      return null;
    }
  }).filter(Boolean);
}
```

- [ ] **Step 4: Remove truncation from the workbench slices**

In `src/routes/metricsRoutes.js`:

Replace `sourceCacheKey` — only fields that still change the payload stay in the key (this also collapses admin/public cache entries and raises the warm-cache hit rate):

```js
export function sourceCacheKey(params) {
  return JSON.stringify({
    subjectLimit: params.subjectLimit,
    index: params.index,
    query: params.query,
    term: params.term,
    source: params.source,
  });
}
```

Replace `cachedDocumentsForParams`:

```js
async function cachedDocumentsForParams(params, loadSyncModule) {
  const documentCache = await documentCacheForParams(params, loadSyncModule);
  const documents = await listCachedDocuments({ syncKey: documentCache.syncKey });
  return { documents, documentCache };
}
```

In `documentPageForParams`, replace the `listCachedDocuments` call and the `total` computation:

```js
  const documents = await listCachedDocuments({
    syncKey: documentCache.syncKey,
    limit: needsFullPass ? null : pageRequest.limit,
    offset: needsFullPass ? 0 : pageRequest.offset,
  });

  let rows = documents;
  if (needsFullPass) {
    rows = filterDocuments(rows, filters);
    rows = searchDocuments(rows, pageRequest.q);
    rows = sortDocumentRows(rows, pageRequest.sortKey, pageRequest.sortDir);
  }

  const total = needsFullPass
    ? rows.length
    : (documentCache.recordsAvailable || rows.length);
```

In the `/metrics` route's `computePayload`, replace the `listCachedDocuments` call:

```js
      const cachedDocuments = await listCachedDocuments({
        syncKey: hasExactSyncCache ? syncKey : null,
      });
```

- [ ] **Step 5: Stop `collectMetricRecords` slicing cached documents**

In `src/metrics.js`, replace the line `const normalizedRecords = records.slice(0, maxRecords).map(normalizeStoredRecordShape);` with:

```js
  // Cached-document reads serve the full stored corpus; maxRecords only
  // bounds live Open Collections paging above.
  const limitedRecords = usesCachedDocuments ? records : records.slice(0, maxRecords);
  const normalizedRecords = limitedRecords.map(normalizeStoredRecordShape);
```

- [ ] **Step 6: Run the new test, then the full suite**

Run: `node --test test/fullCorpusAnalytics.test.js` — Expected: PASS (3 tests).
Run: `npm test` — Expected: all pass. If any existing test asserts on `sourceCacheKey` fields or truncated totals, update its expectation to the full-corpus behavior (the contract change is intentional).

- [ ] **Step 7: Commit**

```bash
git add src/db.js src/routes/metricsRoutes.js src/metrics.js test/fullCorpusAnalytics.test.js
git commit -m "Serve public analytics from the entire stored corpus"
```

---

### Task 2: Exclude estimated page counts from page statistics

Full-text-only documents get `pages = words/300` with `pagesSource: 'estimated_from_full_text_words'` (`src/pdf.js:865`), but `UNRELIABLE_PAGE_SOURCES` only lists `estimated_from_metadata_words`, so estimates pollute the page-trend charts.

**Files:**
- Modify: `src/metrics.js:60`
- Test: `test/metricsReliability.test.js` (append)

**Interfaces:**
- Consumes: `hasReliablePageCount(rec)` (exported from `src/metrics.js`).
- Produces: no signature changes.

- [ ] **Step 1: Write the failing test**

Append to `test/metricsReliability.test.js` (match its existing import of `hasReliablePageCount`; if it doesn't import it yet, add it to the existing `import ... from '../src/metrics.js'` line):

```js
test('page counts estimated from full-text words are not treated as reliable', () => {
  assert.equal(hasReliablePageCount({ pages: 250, pagesSource: 'estimated_from_full_text_words' }), false);
  assert.equal(hasReliablePageCount({ pages: 250, pagesSource: 'downloaded_pdf' }), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/metricsReliability.test.js`
Expected: FAIL — first assertion returns `true`.

- [ ] **Step 3: Implement**

In `src/metrics.js` line 60:

```js
const UNRELIABLE_PAGE_SOURCES = new Set(['estimated_from_metadata_words', 'estimated_from_full_text_words']);
```

- [ ] **Step 4: Run tests**

Run: `node --test test/metricsReliability.test.js` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metrics.js test/metricsReliability.test.js
git commit -m "Treat full-text page estimates as unreliable in page stats"
```

---

### Task 3: Normalize person keys in the Person Explorer

`buildPersonRows` keys people by raw `name.toLowerCase()`, so "Deirdre M. Kelly" and "Deirdre Kelly" become two people. Use the existing normalization from `src/supervisors.js`.

**Files:**
- Modify: `src/routes/metricsRoutes.js` (`buildPersonRows`, ~line 340)
- Test: `test/fullCorpusAnalytics.test.js` (append)

**Interfaces:**
- Consumes: `supervisorNameKey(raw)`, `stripMiddleInitials(key)` from `src/supervisors.js` (both already exported).
- Produces: person `key` values are now normalized (lowercase, diacritics stripped, middle initials removed). The `/workbench/people/:personKey` route keeps working because keys come from the same function on both list and detail paths.

- [ ] **Step 1: Write the failing test**

Append to `test/fullCorpusAnalytics.test.js`:

```js
test('person explorer merges middle-initial name variants', async () => {
  await saveDocumentMetadata({
    ...makeDoc(6),
    id: '1.0000006',
    supervisors: ['Deirdre M. Kelly'],
  }, { syncKey: SYNC_KEY });
  await saveDocumentMetadata({
    ...makeDoc(7),
    id: '1.0000007',
    supervisors: ['Deirdre Kelly'],
  }, { syncKey: SYNC_KEY });

  const res = await request(app).get('/api/workbench/people?q=kelly');
  assert.equal(res.status, 200);
  const kellys = res.body.people.filter((p) => /kelly/i.test(p.name));
  assert.equal(kellys.length, 1);
  assert.equal(kellys[0].docCount, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fullCorpusAnalytics.test.js`
Expected: FAIL — two Kelly rows.

- [ ] **Step 3: Implement**

In `src/routes/metricsRoutes.js`, add to the imports from `../supervisors.js` (add the import line near the top with the other imports):

```js
import { stripMiddleInitials, supervisorNameKey } from '../supervisors.js';
```

Add above `buildPersonRows`:

```js
function personKeyFor(name) {
  const key = supervisorNameKey(name);
  if (key) return stripMiddleInitials(key);
  return String(name || '').toLowerCase().trim();
}
```

In `buildPersonRows`, replace both occurrences of `const key = String(name || '').toLowerCase().trim();` with `const key = personKeyFor(name);`, and in the supervisor loop replace `const otherKey = String(other || '').toLowerCase().trim();` with `const otherKey = personKeyFor(other);`. Then, where an existing person is found, keep the most complete display name — replace both `let person = people.get(key); if (!person) { ... }` blocks with:

```js
      let person = people.get(key);
      if (!person) {
        person = createPersonRowSeed(key, name);
        people.set(key, person);
      } else if (String(name || '').length > String(person.name || '').length) {
        person.name = name;
      }
```

- [ ] **Step 4: Run tests**

Run: `node --test test/fullCorpusAnalytics.test.js` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/metricsRoutes.js test/fullCorpusAnalytics.test.js
git commit -m "Merge person name variants with supervisor key normalization"
```

---

### Task 4: Stop public reads writing metric_runs; prune the table

`buildMetricsPayloadFromRecords` inserts a `metric_runs` row on every analytics recompute, including anonymous ones, and nothing prunes the table. Make run persistence opt-in (admin refresh only) and cap the table at 100 rows.

**Files:**
- Modify: `src/metrics.js` (`buildMetricsPayloadFromRecords` ~line 1019, `collectMetrics` ~line 1085)
- Modify: `src/routes/metricsRoutes.js` (analytics ~line 841, visualizations ~line 855, `/metrics` computePayload ~line 1032)
- Modify: `src/db.js` (`saveRunMetrics` ~line 1099)
- Test: `test/fullCorpusAnalytics.test.js` (append)

**Interfaces:**
- Produces: `buildMetricsPayloadFromRecords(records, sourceMeta, subjectLimit = 25, { persistRun = false } = {})` and `collectMetrics(options)` honoring `options.persistRun`.

- [ ] **Step 1: Write the failing test**

Append to `test/fullCorpusAnalytics.test.js` (add `getDb` to the db import in `test.before`: `const db = await import('../src/db.js'); ... getDbFn = db.getDb;` with a top-level `let getDbFn;`):

```js
test('anonymous analytics reads do not write metric_runs rows', async () => {
  const client = await getDbFn();
  const before = Number((await client.execute('SELECT COUNT(*) AS c FROM metric_runs')).rows[0].c);
  const res = await request(app).get('/api/workbench/analytics?refresh=0&subjectLimit=10');
  assert.equal(res.status, 200);
  const after = Number((await client.execute('SELECT COUNT(*) AS c FROM metric_runs')).rows[0].c);
  assert.equal(after, before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fullCorpusAnalytics.test.js`
Expected: FAIL — count increases by 1. (If the slice is served from cache, the earlier analytics test already wrote a row; use `subjectLimit=10` as above to force a distinct cache key.)

- [ ] **Step 3: Implement**

In `src/metrics.js`:

```js
export async function buildMetricsPayloadFromRecords(records, sourceMeta, subjectLimit = 25, { persistRun = false } = {}) {
  const normalizedRecords = enrichDocumentSignals(records);

  const metrics = buildMetrics(normalizedRecords, subjectLimit);
  if (persistRun) await saveRunMetrics(sourceMeta, metrics);
```

```js
export async function collectMetrics(options = {}) {
  const { records, sourceMeta, subjectLimit } = await collectMetricRecords(options);
  return buildMetricsPayloadFromRecords(records, sourceMeta, subjectLimit, {
    persistRun: Boolean(options.persistRun),
  });
}
```

In `src/routes/metricsRoutes.js`, pass the flag from admin refreshes only. Analytics slice:

```js
      const full = await buildMetricsPayloadFromRecords(filtered, { ...sourceMeta, filters }, subjectLimit, {
        persistRun: params.isAdminRequest && params.refresh,
      });
```

Apply the identical change in the visualizations slice. In the `/metrics` route's `computePayload`, pass through `collectMetrics`:

```js
      const payload = await collectMetrics({
        ...sourceOptions,
        cachedDocuments,
        skipFileEnrichment: true,
        applyStoredFileMetrics: true,
        applyCitationCounts: true,
        applyCommitteeMembers: true,
        persistRun: isAdminRequest && refresh,
      });
```

In `src/db.js`, append pruning to `saveRunMetrics`:

```js
export async function saveRunMetrics(source, metrics) {
  const now = new Date().toISOString();
  const runKey = crypto.createHash('sha1').update(JSON.stringify(source)).digest('hex');
  await run(`
    INSERT INTO metric_runs (run_key, source_json, metrics_json, created_at)
    VALUES (?, ?, ?, ?)
  `, [runKey, JSON.stringify(source), JSON.stringify(metrics), now]);
  await run(`
    DELETE FROM metric_runs
    WHERE id NOT IN (SELECT id FROM metric_runs ORDER BY created_at DESC, id DESC LIMIT 100)
  `);
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/fullCorpusAnalytics.test.js` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metrics.js src/routes/metricsRoutes.js src/db.js test/fullCorpusAnalytics.test.js
git commit -m "Persist metric runs only on admin refresh and prune the table"
```

---

### Task 5: Bound the in-memory metrics cache

`metricsCache` is an unbounded `Map` keyed by user-controlled strings; expired entries are never evicted. Add a small LRU wrapper.

**Files:**
- Create: `src/boundedCache.js`
- Modify: `src/server.js:36`
- Test: `test/boundedCache.test.js` (create)

**Interfaces:**
- Produces: `createBoundedCache(maxEntries)` returning `{ get, set, has, delete, clear, size }` — a drop-in for the `Map` usage in `metricsRoutes.js` (`get`/`set`/`clear` are the only methods used there).

- [ ] **Step 1: Write the failing test**

Create `test/boundedCache.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedCache } from '../src/boundedCache.js';

test('evicts the least recently used entry beyond maxEntries', () => {
  const cache = createBoundedCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // bump recency of a
  cache.set('c', 3); // evicts b
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});

test('clear empties the cache', () => {
  const cache = createBoundedCache(2);
  cache.set('a', 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('a'), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/boundedCache.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/boundedCache.js`:

```js
/**
 * Small LRU cache with the subset of the Map interface the metrics routes use.
 * Bounds memory when cache keys derive from user-controlled request params.
 */
export function createBoundedCache(maxEntries = 300) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > maxEntries) {
        map.delete(map.keys().next().value);
      }
    },
    has(key) {
      return map.has(key);
    },
    delete(key) {
      return map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}
```

In `src/server.js`, add the import and replace line 36:

```js
import { createBoundedCache } from './boundedCache.js';

const metricsCache = createBoundedCache(300);
```

- [ ] **Step 4: Run tests**

Run: `node --test test/boundedCache.test.js` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/boundedCache.js src/server.js test/boundedCache.test.js
git commit -m "Bound the metrics cache with LRU eviction"
```

---

### Task 6: Rate-limit anonymous API requests

The expensive workbench endpoints have no rate limiting (only login and Summon do). Add a per-IP sliding-window limiter for unauthenticated `/api` requests.

**Files:**
- Create: `src/middleware/rateLimit.js`
- Modify: `src/server.js` (mount between admin and public routers, ~line 122)
- Test: `test/rateLimit.test.js` (create)

**Interfaces:**
- Consumes: `authenticate(req)` from `src/auth.js`, `getTrustedClientIp(req)` from `src/requestSecurity.js`.
- Produces: `createPublicRateLimit({ windowMs = 60000, limit = 120, maxIps = 5000 })` returning Express middleware; authenticated admins bypass it.

- [ ] **Step 1: Write the failing test**

Create `test/rateLimit.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rateLimit.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/middleware/rateLimit.js`:

```js
import { authenticate } from '../auth.js';
import { getTrustedClientIp } from '../requestSecurity.js';

/**
 * Per-IP sliding-window rate limit for anonymous API traffic. Authenticated
 * admin sessions bypass it so admin workflows are never throttled.
 */
export function createPublicRateLimit({ windowMs = 60_000, limit = 120, maxIps = 5000 } = {}) {
  const attemptsByIp = new Map();
  return function publicRateLimit(req, res, next) {
    if (authenticate(req)) {
      next();
      return;
    }
    const ip = getTrustedClientIp(req);
    const now = Date.now();
    const recent = (attemptsByIp.get(ip) || []).filter((ts) => now - ts <= windowMs);
    if (recent.length >= limit) {
      attemptsByIp.set(ip, recent);
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
      return;
    }
    recent.push(now);
    attemptsByIp.set(ip, recent);
    while (attemptsByIp.size > maxIps) {
      attemptsByIp.delete(attemptsByIp.keys().next().value);
    }
    next();
  };
}
```

In `src/server.js`, add the import, then mount it after the admin/internal routers and before the public routers so `/api/auth` and `/api/admin` keep their own controls:

```js
import { createPublicRateLimit } from './middleware/rateLimit.js';
```

```js
app.use('/api/internal', createInternalWorkerRouter());
app.use('/api', createPublicRateLimit());
app.use('/api', createPublicRouter());
app.use('/api', createMetricsRouter({ metricsCache, metricsInflight, loadSyncModule }));
```

- [ ] **Step 4: Run tests**

Run: `node --test test/rateLimit.test.js` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/rateLimit.js src/server.js test/rateLimit.test.js
git commit -m "Rate-limit anonymous API requests"
```

---

### Task 7: Wire URL safety and block-page detection into the download path

`src/urlSafety.js` and `detectDownloadBlockPage` are only referenced by tests. Route all cIRcle fetches through `safeFetchDownloadUrl`, allowlist `circle.library.ubc.ca`, verify PDF magic bytes, and record `blocked` status when a security block page comes back.

**Files:**
- Modify: `src/config.js:39` (allowlist default)
- Modify: `src/pdf.js` (`fetchJsonWithTimeout`/`fetchTextWithTimeout`/`fetchBytesWithTimeout` ~lines 706-754, `fetchPdfForDocument` ~line 822, `analyzeDocumentFile` ~line 1806)
- Modify: `test/adminWorker.test.js` (test.before — inject a fake DNS resolver)
- Test: `test/pdfDownloadSafety.test.js` (create)

**Interfaces:**
- Consumes: `safeFetchDownloadUrl(rawUrl, fetchOptions, safetyOptions)` from `src/urlSafety.js`; `detectDownloadBlockPage(html)` already in `src/pdf.js`.
- Produces: `_setDownloadSafetyOptionsForTests(options)` exported from `src/pdf.js` (tests inject `resolveHost`); `fetchPdfForDocument` may now return `{ blocked: true, downloadUrl }`; blocked docs persist `status: 'blocked'` in `file_metrics` (already counted as failed by `getFileMetricsStats`).

- [ ] **Step 1: Write the failing test**

Create `test/pdfDownloadSafety.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tempDir;
let fetchPdfForDocument;
let _setDownloadSafetyOptionsForTests;
let closeDb;
const originalFetch = globalThis.fetch;

const RECORD_URL = 'https://circle.library.ubc.ca/rest/handle/2429/12345';
const doc = { id: '1.0099999', originalRecordUrl: RECORD_URL };

function fakeResponse({ status = 200, body = '', contentType = 'application/json', url = '' }) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (name) => {
        const lower = String(name).toLowerCase();
        if (lower === 'content-type') return contentType;
        if (lower === 'content-length') return String(bytes.length);
        return null;
      },
    },
    json: async () => JSON.parse(bytes.toString('utf8')),
    text: async () => bytes.toString('utf8'),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-download-safety-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;

  const pdf = await import('../src/pdf.js');
  fetchPdfForDocument = pdf.fetchPdfForDocument;
  _setDownloadSafetyOptionsForTests = pdf._setDownloadSafetyOptionsForTests;
  _setDownloadSafetyOptionsForTests({
    resolveHost: async () => [{ address: '142.103.96.1' }],
  });
  ({ closeDb } = await import('../src/db.js'));
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  _setDownloadSafetyOptionsForTests(null);
  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

function mockBitstreamFetch(retrieveResponse) {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/rest/handle/')) {
      return fakeResponse({
        body: JSON.stringify({
          id: 77,
          bitstreams: [{ id: 9, mimeType: 'application/pdf', bundleName: 'ORIGINAL', name: 'thesis.pdf' }],
        }),
      });
    }
    if (url.includes('/rest/bitstreams/9/retrieve')) return retrieveResponse(url);
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

test('block pages served as PDFs are detected and reported as blocked', async () => {
  mockBitstreamFetch((url) => fakeResponse({
    body: '<html>Your request was blocked because our system detected unusual activity. Reference ID: abc. Sorry for the inconvenience.</html>',
    contentType: 'text/html',
    url,
  }));
  const result = await fetchPdfForDocument(doc);
  assert.equal(result.blocked, true);
});

test('non-PDF bodies without block markers are rejected', async () => {
  mockBitstreamFetch((url) => fakeResponse({ body: 'not a pdf', contentType: 'text/plain', url }));
  const result = await fetchPdfForDocument(doc);
  assert.equal(result, null);
});

test('real PDF bytes are accepted', async () => {
  mockBitstreamFetch((url) => fakeResponse({
    body: Buffer.from('%PDF-1.4 fake body'),
    contentType: 'application/pdf',
    url,
  }));
  const result = await fetchPdfForDocument(doc);
  assert.equal(Boolean(result?.bytes?.length), true);
  assert.equal(result.blocked, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pdfDownloadSafety.test.js`
Expected: FAIL — `_setDownloadSafetyOptionsForTests` is not exported; block-page case returns a truthy PDF result (name ends in `.pdf`).

- [ ] **Step 3: Allowlist circle host**

In `src/config.js` line 39:

```js
export const PDF_ALLOWED_HOSTS = (process.env.PDF_ALLOWED_HOSTS || 'open.library.ubc.ca,oc-index.library.ubc.ca,circle.library.ubc.ca')
```

- [ ] **Step 4: Route pdf.js fetches through safeFetchDownloadUrl**

In `src/pdf.js`, add the import and test hook near the top:

```js
import { safeFetchDownloadUrl } from './urlSafety.js';

let downloadSafetyOptions = {};
export function _setDownloadSafetyOptionsForTests(options) {
  downloadSafetyOptions = options || {};
}
```

Replace the three fetch helpers' `fetch(url, { signal: controller.signal })` calls:

```js
async function fetchJsonWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await safeFetchDownloadUrl(String(url), { signal: controller.signal }, downloadSafetyOptions);
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}
```

Apply the same one-line substitution (`fetch(url, ...)` → `safeFetchDownloadUrl(String(url), ..., downloadSafetyOptions)`) in `fetchTextWithTimeout` and `fetchBytesWithTimeout`; their remaining bodies are unchanged.

- [ ] **Step 5: Detect block pages and enforce PDF magic bytes**

In `fetchPdfForDocument`, replace the acceptance check after `fetchBytesWithTimeout`:

```js
    const retrieveUrl = dspaceRestUrl(`/rest/bitstreams/${id}/retrieve`);
    const result = await fetchBytesWithTimeout(retrieveUrl);
    if (!result?.bytes?.length) return null;

    const looksLikePdf = result.bytes.subarray(0, 5).toString('latin1') === '%PDF-';
    if (!looksLikePdf) {
      const preview = result.bytes.subarray(0, 4096).toString('utf8');
      if (result.contentType.includes('html') && detectDownloadBlockPage(preview)) {
        logger.warn('PDF download blocked by security page', { docId: doc?.id });
        return { blocked: true, downloadUrl: result.finalUrl || retrieveUrl.toString() };
      }
      return null;
    }

    return {
      downloadUrl: result.finalUrl || retrieveUrl.toString(),
      bytes: result.bytes,
      bitstreamId: id,
      bitstreamName: pdfBitstream.name || null,
    };
```

In `analyzeDocumentFile`, handle the blocked result. Replace `const resolved = await fetchPdfForDocument(doc); if (resolved) {` with:

```js
  const resolved = await fetchPdfForDocument(doc);
  if (resolved?.blocked) {
    doc.downloadError = 'Download blocked by UBC security page; reduce PDF_DOWNLOAD_RATE_PER_MIN and retry later.';
  }
  if (resolved && !resolved.blocked) {
```

And in the final `not_found` fallthrough at the end of the function, record the blocked status distinctly — replace `doc.downloadStatus = 'not_found';` with:

```js
  doc.downloadStatus = resolved?.blocked ? 'blocked' : 'not_found';
```

and in the closing `saveFileMetric` call replace `status: 'not_found',` with `status: doc.downloadStatus,`.

- [ ] **Step 6: Inject the fake resolver into existing download-exercising tests**

`test/adminWorker.test.js` mocks `fetch` for circle URLs; the new DNS check would hit real DNS. In its `test.before` (after the dynamic imports complete, ~line 90+), add:

```js
  const { _setDownloadSafetyOptionsForTests } = await import('../src/pdf.js');
  _setDownloadSafetyOptionsForTests({ resolveHost: async () => [{ address: '142.103.96.1' }] });
```

Run `npm test`; if `syncBatch.test.js` or others fail on DNS resolution of mocked hosts, add the same two lines to their `test.before`.

- [ ] **Step 7: Run tests**

Run: `node --test test/pdfDownloadSafety.test.js` then `npm test` — Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/pdf.js test/pdfDownloadSafety.test.js test/adminWorker.test.js
git commit -m "Enforce URL safety and block-page detection on PDF downloads"
```

---

### Task 8: Forward runtime credentials to Fly worker machines

`buildFlyWorkerMachinePayload` omits `UBC_API_KEY`, `API_KEY_ENCRYPTION_KEY`, `PDF_DOWNLOAD_RATE_PER_MIN`, GROBID settings, and `NODE_ENV`, so Fly import workers either fail to decrypt the stored API key or sync anonymously and download unthrottled.

**Files:**
- Modify: `src/services/adminWorker.js` (env object, ~line 103)
- Test: `test/adminWorker.test.js` (append)

**Interfaces:**
- Consumes: `buildFlyWorkerMachinePayload({ image, jobId, token, timeoutMs, jobType })` (already exported and tested).
- Produces: no signature change; `payload.config.env` gains the keys below.

- [ ] **Step 1: Write the failing test**

Append to `test/adminWorker.test.js`:

```js
test('fly worker payload forwards runtime credentials and throttles', () => {
  const prev = {
    UBC_API_KEY: process.env.UBC_API_KEY,
    API_KEY_ENCRYPTION_KEY: process.env.API_KEY_ENCRYPTION_KEY,
    PDF_DOWNLOAD_RATE_PER_MIN: process.env.PDF_DOWNLOAD_RATE_PER_MIN,
    NODE_ENV: process.env.NODE_ENV,
  };
  process.env.UBC_API_KEY = 'test-oc-key';
  process.env.API_KEY_ENCRYPTION_KEY = 'test-enc-key';
  process.env.PDF_DOWNLOAD_RATE_PER_MIN = '4';
  process.env.NODE_ENV = 'production';
  try {
    const payload = buildFlyWorkerMachinePayload({ image: 'img', jobId: 42, token: 'tok' });
    assert.equal(payload.config.env.UBC_API_KEY, 'test-oc-key');
    assert.equal(payload.config.env.API_KEY_ENCRYPTION_KEY, 'test-enc-key');
    assert.equal(payload.config.env.PDF_DOWNLOAD_RATE_PER_MIN, '4');
    assert.equal(payload.config.env.NODE_ENV, 'production');
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/adminWorker.test.js`
Expected: FAIL — env keys undefined.

- [ ] **Step 3: Implement**

In `src/services/adminWorker.js`, extend the `env` object inside `buildFlyWorkerMachinePayload` (after the `SQLITE_PATH` line):

```js
    NODE_ENV: process.env.NODE_ENV || '',
    UBC_API_BASE_URL: process.env.UBC_API_BASE_URL || '',
    UBC_API_KEY: process.env.UBC_API_KEY || '',
    API_KEY_ENCRYPTION_KEY: process.env.API_KEY_ENCRYPTION_KEY || '',
    PDF_DOWNLOAD_RATE_PER_MIN: process.env.PDF_DOWNLOAD_RATE_PER_MIN || '',
    GROBID_URL: process.env.GROBID_URL || '',
    GROBID_APP_NAME: process.env.GROBID_APP_NAME || '',
    GROBID_FLY_API_TOKEN: process.env.GROBID_FLY_API_TOKEN || process.env.FLY_API_TOKEN || '',
```

- [ ] **Step 4: Run tests**

Run: `node --test test/adminWorker.test.js` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/adminWorker.js test/adminWorker.test.js
git commit -m "Forward API key, encryption, throttle, and GROBID env to Fly workers"
```

---

### Task 9: Reap heartbeat-stale jobs and give catalogue jobs a timeout

In-process `catalogue_lookup` jobs are created with no `timeout_at`, and `reapStaleAdminJobs` only reaps rows with a non-null `timeout_at` — a web restart mid-job leaves the row `running` forever and permanently blocks new lookup jobs.

**Files:**
- Modify: `src/db.js` (`reapStaleAdminJobs`, ~line 964)
- Modify: `src/routes/adminJobsRoutes.js` (catalogue-lookup job creation ~line 66-73; also fixes the redundant identical ternary)
- Test: `test/adminWorker.test.js` (append)

**Interfaces:**
- Produces: `reapStaleAdminJobs(type = null)` additionally times out running jobs whose `timeout_at IS NULL` and whose `COALESCE(heartbeat_at, claimed_at, started_at)` is older than 30 minutes.

- [ ] **Step 1: Write the failing test**

Append to `test/adminWorker.test.js` (it already imports `createAdminJob`, `hasRunningAdminJob`, `getAdminJob`, `updateAdminJob`):

```js
test('running jobs with no timeout and stale heartbeats get reaped', async () => {
  const jobId = await createAdminJob({
    type: 'catalogue_lookup_reap_test',
    label: 'Stale lookup',
    params: null,
  });
  const stale = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  await updateAdminJob(jobId, { heartbeatAt: stale });

  const runningId = await hasRunningAdminJob('catalogue_lookup_reap_test');
  assert.equal(runningId, null);
  const job = await getAdminJob(jobId);
  assert.equal(job.status, 'timed_out');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/adminWorker.test.js`
Expected: FAIL — `runningId` equals the job id; status still `running`.

- [ ] **Step 3: Implement reaping**

In `src/db.js`, replace `reapStaleAdminJobs`:

```js
const STALE_HEARTBEAT_MS = 30 * 60 * 1000;

export async function reapStaleAdminJobs(type = null) {
  const now = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - STALE_HEARTBEAT_MS).toISOString();
  const args = [now, now, staleCutoff];
  let sql = `
    UPDATE admin_jobs
    SET status = 'timed_out',
        runner_state = 'timed_out',
        error = COALESCE(error, 'Admin worker timed out or stopped heartbeating.'),
        finished_at = ?,
        artifact_token_hash = NULL
    WHERE status = 'running'
      AND (
        (timeout_at IS NOT NULL AND timeout_at <= ?)
        OR (timeout_at IS NULL AND COALESCE(heartbeat_at, claimed_at, started_at) <= ?)
      )
  `;
  if (type) {
    sql += ' AND type = ?';
    args.push(type);
  }
  const result = await run(sql, args);
  return result.changes || 0;
}
```

- [ ] **Step 4: Give catalogue jobs an explicit timeout and drop the dead ternary**

In `src/routes/adminJobsRoutes.js`, add `ADMIN_WORKER_TIMEOUT_MS` to the config import:

```js
import { ADMIN_WORKER_TIMEOUT_MS } from '../config.js';
```

Replace the running-check and job creation in the catalogue-lookup handler:

```js
    const runningId = await hasRunningAdminJob('catalogue_lookup');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }
    const jobId = await createAdminJob({
      type: 'catalogue_lookup',
      label: 'Z39.50 Catalogue Lookups',
      params: { limit, pendingOnly: true },
      timeoutAt: new Date(Date.now() + ADMIN_WORKER_TIMEOUT_MS).toISOString(),
    });
```

(The `isAdminJobRunning('catalogue_lookup') ? ... : ...` ternary had identical branches; if `isAdminJobRunning` becomes unused after this change, remove it from the `../services/adminJobs.js` import.)

- [ ] **Step 5: Run tests**

Run: `node --test test/adminWorker.test.js` then `npm test` — Expected: PASS. If any existing test creates a `running` job with an old `started_at` and no heartbeat and asserts it stays running, set a fresh `heartbeatAt` in that test's setup.

- [ ] **Step 6: Commit**

```bash
git add src/db.js src/routes/adminJobsRoutes.js test/adminWorker.test.js
git commit -m "Reap heartbeat-stale admin jobs and time-limit catalogue lookups"
```

---

### Task 10: Persist permanent catalogue-lookup failures

Non-transient lookup errors are saved as `hits NULL` + non-null `query_title`, which is exactly the "pending" predicate — the same citations are refetched every run and a full page of them makes `runPendingCatalogueLookups` loop forever. Persist them as `hits = -1` (failed) so they drain.

**Files:**
- Modify: `src/catalogue.js` (`runPendingCatalogueLookups` result loop, ~line 601-619)
- Modify: `src/db.js` (`getCatalogueLookupStats`, ~line 1718)
- Test: `test/catalogueFailures.test.js` (create)

**Interfaces:**
- Produces: `catalogue_lookups.hits = -1` means "permanent failure — do not retry automatically". `getCatalogueLookupStats()` gains a `failed` count; `found`/`not_found` predicates unchanged (`hits > 0` / `hits = 0`); pending predicates (`hits IS NULL AND query_title IS NOT NULL`) automatically exclude `-1`.

- [ ] **Step 1: Write the failing test**

Create `test/catalogueFailures.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tempDir;
let runPendingCatalogueLookups;
let saveCitations;
let listPendingLookups;
let getCatalogueLookupStats;
let closeDb;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-cat-failures-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;

  ({ runPendingCatalogueLookups } = await import('../src/catalogue.js'));
  const db = await import('../src/db.js');
  saveCitations = db.saveCitations;
  listPendingLookups = db.listPendingLookups;
  getCatalogueLookupStats = db.getCatalogueLookupStats;
  closeDb = db.closeDb;
  await db.ensureStorage();

  const hashFn = (text) => `hash-${text}`;
  await saveCitations('1.0100001', [
    'Smith, J. (1990). Unparseable output test one. City: Press.',
    'Jones, K. (1991). Unparseable output test two. City: Press.',
  ], hashFn);
});

test.after(async () => {
  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('permanent lookup failures are persisted and drain the pending queue', async () => {
  const failingBatch = async (texts) => texts.map(() => ({
    found: null,
    hits: null,
    author: 'Smith',
    title: 'Unparseable output test',
    error: 'Missing hits in batch output block',
  }));

  const stats = await runPendingCatalogueLookups({
    pageSize: 2,
    isYazAvailable: async () => true,
    lookupBatch: failingBatch,
  });
  assert.equal(stats.failed, 2);

  const stillPending = await listPendingLookups(10);
  assert.equal(stillPending.length, 0);

  const summary = await getCatalogueLookupStats();
  assert.equal(summary.failed, 2);
  assert.equal(summary.pending, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/catalogueFailures.test.js`
Expected: FAIL — the run loops (guard: the `pending.length < pageSize` exit never triggers with pageSize=2 and 2 permanently-failing rows). If it hangs, kill it — that IS the bug. Add `--test-timeout=15000` if desired.

- [ ] **Step 3: Implement**

In `src/catalogue.js`, inside `runPendingCatalogueLookups`, replace the result loop body:

```js
    let pageFailed = 0;
    for (let i = 0; i < pending.length; i++) {
      throwIfAborted(signal);
      const result = results[i];
      if (!result || result.transient) {
        totalFailed++;
        pageFailed++;
        continue;
      }
      if (result.error) {
        // Permanent failure (unparseable output, bad query): record hits = -1 so
        // this citation leaves the pending queue instead of being retried forever.
        await saveCatalogueLookup(pending[i].id, {
          hits: -1,
          queryAuthor: result.author,
          queryTitle: result.title,
          bibId: null,
        });
        totalFailed++;
        continue;
      }
      await saveCatalogueLookup(pending[i].id, {
        hits: result.hits,
        queryAuthor: result.author,
        queryTitle: result.title,
        bibId: result.bibId,
      });
      if (result.found === true) totalFound++;
      else if (result.found === false) totalNotFound++;
      else totalSkipped++;
    }
```

In `src/db.js`, extend `getCatalogueLookupStats` — replace its SELECT with:

```js
    SELECT
      (SELECT COUNT(*) FROM catalogue_lookups) AS total,
      (SELECT COUNT(*) FROM catalogue_lookups WHERE hits > 0) AS found,
      (SELECT COUNT(*) FROM catalogue_lookups WHERE hits = 0) AS not_found,
      (SELECT COUNT(*) FROM catalogue_lookups WHERE hits = -1) AS failed,
      (SELECT COUNT(*) FROM catalogue_lookups WHERE hits IS NULL) AS skipped,
      (
        (SELECT COUNT(*) FROM citations)
        - (SELECT COUNT(*) FROM catalogue_lookups)
        + (
          SELECT COUNT(*)
          FROM catalogue_lookups
          WHERE hits IS NULL
            AND query_title IS NOT NULL
        )
      ) AS pending
```

and add `failed: Number(row?.failed || 0),` to the returned object.

- [ ] **Step 4: Run tests**

Run: `node --test test/catalogueFailures.test.js` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalogue.js src/db.js test/catalogueFailures.test.js
git commit -m "Persist permanent catalogue-lookup failures so the queue drains"
```

---

### Task 11: Tighten fuzzy citation merging

Jaro-Winkler ≥ 0.90 over whole citation strings merges different works by the same author (shared prefix, adjacent years — candidates come from year ±1 buckets). Raise the threshold to 0.94 and require year agreement when both years are known.

**Files:**
- Modify: `src/db.js` (`saveCitations`, ~line 1504-1568)
- Test: `test/fuzzyMatch.test.js` (append)

**Interfaces:**
- Produces: fuzzy merge acceptance rule = `similarity >= 0.94 AND (incomingYear == null OR candidateYear == null OR incomingYear === candidateYear)`. Candidate bucketing (year ±1) is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/fuzzyMatch.test.js`. This test needs the DB; follow the env-then-import pattern. If the file currently has no DB setup, add a scoped block at the end:

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('saveCitations does not merge different works by the same author', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-fuzzy-merge-'));
  const prevData = process.env.APP_DATA_DIR;
  const prevSqlite = process.env.SQLITE_PATH;
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  const db = await import('../src/db.js');
  await db.ensureStorage();
  try {
    const hashFn = (text) => `h-${text}`;
    await db.saveCitations('1.0200001', [
      { text: 'Fullan, M. (1991). The new meaning of educational change. New York: Teachers College Press.', year: '1991' },
    ], hashFn);
    await db.saveCitations('1.0200002', [
      { text: 'Fullan, M. (1992). The new meaning of successful school improvement. New York: Teachers College Press.', year: '1992' },
    ], hashFn);
    const stats = await db.getCitationStats();
    assert.equal(Number(stats.total_citations), 2);

    // Same work, OCR punctuation variant, same year: still merges.
    await db.saveCitations('1.0200003', [
      { text: 'Fullan, M . (1991). The new meaning of educational change New York: Teachers College Press', year: '1991' },
    ], hashFn);
    const stats2 = await db.getCitationStats();
    assert.equal(Number(stats2.total_citations), 2);
  } finally {
    await db.closeDb();
    if (prevData === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = prevData;
    if (prevSqlite === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = prevSqlite;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
```

Note: if `test/fuzzyMatch.test.js` is a pure unit-test file where an env/import dance conflicts with other DB tests running in the same process, put this test in `test/catalogueFailures.test.js` instead (it already owns a temp DB); adjust citation doc IDs to avoid collisions.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fuzzyMatch.test.js`
Expected: FAIL — first `total_citations` is 1 (the 1992 work merged into the 1991 one). If it happens to pass because similarity lands below 0.90, verify by logging `maxSim`; regardless, proceed — the gate is the point.

- [ ] **Step 3: Implement**

In `src/db.js`, above `saveCitations` add:

```js
const FUZZY_CITATION_THRESHOLD = 0.94;

function fuzzyYearsCompatible(a, b) {
  return a == null || b == null || a === b;
}
```

Inside `saveCitations`, in the fuzzy branch, compute the incoming year once and gate the acceptance. Replace:

```js
      if (maxSim >= 0.90 && bestMatch) {
```

with:

```js
      const incomingYear = citationMatchYear(typeof item === 'string' ? null : item.year)
        ?? citationMatchYear(text);
      if (
        bestMatch
        && maxSim >= FUZZY_CITATION_THRESHOLD
        && fuzzyYearsCompatible(incomingYear, bestMatch.matchYear)
      ) {
```

- [ ] **Step 4: Run tests**

Run: `node --test test/fuzzyMatch.test.js` then `npm test` — Expected: PASS. (`test/adminWorker.test.js` exercises `saveCitations` with distinct citations; if one of its fixtures relied on a 0.90–0.94 merge, adjust that fixture's expectation.)

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/fuzzyMatch.test.js
git commit -m "Require year agreement and higher similarity for fuzzy citation merges"
```

---

### Task 12: Preserve catalogue lookups across citation re-extraction

`extractAndSaveParsedData` clears all of a document's citations before saving new ones; the orphan GC deletes the citations *and their catalogue_lookups*, so every reparse throws away completed Z39.50 work. Match/save first, then prune stale links, then GC — matched citations keep their IDs and lookups.

**Files:**
- Modify: `src/db.js` (`saveCitations` returns linked IDs, ~line 1504; new `replaceDocumentCitationLinks`)
- Modify: `src/pdf.js` (`extractAndSaveParsedData` citation block, ~line 1616-1620)
- Test: `test/catalogueFailures.test.js` (append)

**Interfaces:**
- Produces: `saveCitations(docId, citations, hashFn, opts)` now returns `number[]` of linked citation IDs. New `replaceDocumentCitationLinks(docId, keepCitationIds)` removes stale links for the doc and garbage-collects orphaned citations + lookups. `extractAndSaveParsedData` no longer calls `clearDocumentCitations` (which stays exported for scripts).

- [ ] **Step 1: Write the failing test**

Append to `test/catalogueFailures.test.js`:

```js
test('re-extracting the same citations keeps catalogue lookups', async () => {
  const db = await import('../src/db.js');
  const hashFn = (text) => `keep-${text}`;
  const docId = '1.0300001';
  const citeA = 'Dewey, J. (1938). Experience and education. New York: Macmillan.';
  const citeB = 'Freire, P. (1970). Pedagogy of the oppressed. New York: Continuum.';

  const firstIds = await db.saveCitations(docId, [citeA, citeB], hashFn);
  assert.equal(firstIds.length, 2);
  await db.saveCatalogueLookup(firstIds[0], {
    hits: 3, queryAuthor: 'Dewey', queryTitle: 'Experience and education', bibId: '12345',
  });

  // Simulate reparse: same citations extracted again, then stale-link pruning.
  const secondIds = await db.saveCitations(docId, [citeA, citeB], hashFn);
  await db.replaceDocumentCitationLinks(docId, secondIds);
  assert.deepEqual([...secondIds].sort(), [...firstIds].sort());
  const lookup = await db.loadCatalogueLookup(firstIds[0]);
  assert.equal(Number(lookup.hits), 3);

  // Reparse that drops citeB: its link, citation, and lookup are GC'd.
  const thirdIds = await db.saveCitations(docId, [citeA], hashFn);
  await db.replaceDocumentCitationLinks(docId, thirdIds);
  const remaining = await db.loadDocumentCitations(docId);
  assert.equal(remaining.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/catalogueFailures.test.js`
Expected: FAIL — `saveCitations` returns `undefined`; `replaceDocumentCitationLinks` is not a function.

- [ ] **Step 3: Implement in db.js**

In `saveCitations`: declare `const linkedIds = [];` after `counts`; in the matched branch push `linkedIds.push(matchedId);` right after the `document_citations` upsert; in the new-citation branch push `linkedIds.push(row.id);` inside `if (row) { ... }` after its `document_citations` upsert; add `return linkedIds;` at the end of the function.

Add after `clearDocumentCitations`:

```js
export async function replaceDocumentCitationLinks(docId, keepCitationIds = []) {
  const keep = new Set(
    (keepCitationIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
  );
  const existing = await all('SELECT citation_id FROM document_citations WHERE doc_id = ?', [docId]);
  const stale = existing
    .map((row) => Number(row.citation_id))
    .filter((id) => !keep.has(id));
  const chunkSize = 900;
  for (let i = 0; i < stale.length; i += chunkSize) {
    const chunk = stale.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    await run(`DELETE FROM document_citations WHERE doc_id = ? AND citation_id IN (${placeholders})`, [docId, ...chunk]);
  }
  await exec('DELETE FROM catalogue_lookups WHERE citation_id NOT IN (SELECT DISTINCT citation_id FROM document_citations)');
  await exec('DELETE FROM citations WHERE id NOT IN (SELECT DISTINCT citation_id FROM document_citations)');
}
```

- [ ] **Step 4: Implement in pdf.js**

In `src/pdf.js`, update the import from `./db.js`: remove `clearDocumentCitations`, add `replaceDocumentCitationLinks`. In `extractAndSaveParsedData`, replace:

```js
      await clearDocumentCitations(doc.id);
      if (citations.length) {
        await saveCitations(doc.id, citations, normalizeCitation, { onProgress });
      }
      doc.citationCount = citations.length || (await loadDocumentCitations(doc.id)).length;
```

with:

```js
      let linkedIds = [];
      if (citations.length) {
        linkedIds = await saveCitations(doc.id, citations, normalizeCitation, { onProgress });
      }
      await replaceDocumentCitationLinks(doc.id, linkedIds);
      doc.citationCount = (await loadDocumentCitations(doc.id)).length;
```

(This also fixes the previous inaccuracy where `citationCount` was the raw extracted count rather than the stored, deduplicated count.)

- [ ] **Step 5: Run tests**

Run: `node --test test/catalogueFailures.test.js` then `npm test` — Expected: PASS. `test/adminWorker.test.js` re-extraction tests should still pass since matched citations keep IDs; if one asserts citation IDs change across reparse, update it to assert they are stable (that is the new, intended behavior).

- [ ] **Step 6: Commit**

```bash
git add src/db.js src/pdf.js test/catalogueFailures.test.js
git commit -m "Preserve citation IDs and catalogue lookups across re-extraction"
```

---

### Task 13: Allowlist admin settings keys

`PUT /api/admin/settings` writes arbitrary keys into the settings table. The frontend only saves a fixed set (`public/app/core.js:660`): `index, query, term, source, maxRecords, pageSize, scanLimit, subjectLimit, downloadFiles, recomputeFromCache` plus `apiKey`.

**Files:**
- Modify: `src/routes/adminUsersRoutes.js` (PUT `/settings`, ~line 136)
- Test: `test/adminSettings.test.js` (create)

**Interfaces:**
- Produces: unknown keys are silently dropped; `apiKey` keeps its dedicated encrypted path.

- [ ] **Step 1: Write the failing test**

Create `test/adminSettings.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/adminSettings.test.js`
Expected: FAIL — `settings.rogueKey` is `'evil'`.

- [ ] **Step 3: Implement**

In `src/routes/adminUsersRoutes.js`, above `createAdminUsersRouter`:

```js
// Keys the admin UI saves (public/app/core.js getCurrentParams). apiKey has
// its own encrypted path below; everything else is dropped.
const ALLOWED_SETTING_KEYS = new Set([
  'index', 'query', 'term', 'source', 'maxRecords', 'pageSize',
  'scanLimit', 'subjectLimit', 'downloadFiles', 'recomputeFromCache',
]);
```

In the PUT `/settings` handler, replace the loop:

```js
    for (const [key, value] of Object.entries(body)) {
      if (key === 'apiKey') continue;
      if (!ALLOWED_SETTING_KEYS.has(key)) continue;
      await setSetting(key, String(value));
    }
```

- [ ] **Step 4: Run tests**

Run: `node --test test/adminSettings.test.js` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/adminUsersRoutes.js test/adminSettings.test.js
git commit -m "Allowlist admin settings keys"
```

---

### Task 14: Hardening batch — atomic job logs, no api_key in URLs, cached concept dictionary, compression buffer cap

Four small independent fixes; each gets its own verification but they ship as one reviewable commit.

**Files:**
- Modify: `src/db.js` (`appendAdminJobLog`, ~line 900)
- Modify: `src/api.js` (`fetchPage` ~line 102, `fetchSearchAggregations` ~line 151, `resolveIndexName` ~line 214)
- Modify: `src/metrics.js` (`loadConceptDictionary`, ~line 314)
- Modify: `src/middleware/http.js` (`applyCompression`, ~line 54)
- Test: `test/adminWorker.test.js` (append log test)

**Interfaces:**
- Produces: no signature changes. `appendAdminJobLog` becomes a single atomic UPDATE (no read-modify-write race between web and worker). The UBC API key travels only in `x-api-key`/`authorization` headers.

- [ ] **Step 1: Write the failing log-append test**

Append to `test/adminWorker.test.js`:

```js
test('appendAdminJobLog trims to the tail limit atomically', async () => {
  const jobId = await createAdminJob({ type: 'log_test', label: 'Log test', params: null });
  await appendAdminJobLog(jobId, 'first line\n');
  await appendAdminJobLog(jobId, 'x'.repeat(50), 40);
  const job = await getAdminJob(jobId);
  assert.equal(job.log.length, 40);
  assert.equal(job.log, 'x'.repeat(40));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/adminWorker.test.js`
Expected: current implementation also tails, so this may PASS — the change is for atomicity, which a unit test can't easily prove. If it passes, keep it as a regression guard and continue.

- [ ] **Step 3: Atomic log append**

In `src/db.js`:

```js
export async function appendAdminJobLog(id, line, limit = 12000) {
  if (!id) return;
  const text = String(line || '');
  if (!text) return;
  await run(`
    UPDATE admin_jobs
    SET log = CASE
      WHEN length(COALESCE(log, '') || ?) > ?
        THEN substr(COALESCE(log, '') || ?, length(COALESCE(log, '') || ?) - ? + 1)
      ELSE COALESCE(log, '') || ?
    END
    WHERE id = ?
  `, [text, limit, text, text, limit, text, id]);
}
```

(Behavior note: the old version inserted a `\n` between appends when the previous log didn't end with one; callers already terminate their lines with `\n`, so this is dropped.)

- [ ] **Step 4: Remove api_key from URLs**

In `src/api.js`:
- `fetchPage`: delete the line `if (apiKey) params.push(\`api_key=${encodeURIComponent(apiKey)}\`);` and the now-unneeded log redaction can stay harmlessly.
- `fetchSearchAggregations`: delete its identical `api_key` push.
- `resolveIndexName`: delete `if (apiKey) url.searchParams.set('api_key', apiKey);`.

The `x-api-key` and `authorization: Bearer` headers already carry the key on all three paths. **Manual verification required after deploy:** run an Admin → Import preview against the live OC API with a configured key and confirm keyed rate limits still apply (watch for 429s in logs).

- [ ] **Step 5: Cache the concept dictionary by mtime**

In `src/metrics.js`, replace `loadConceptDictionary`:

```js
const EMPTY_CONCEPT_DICT = {
  canonicalSet: new Set(), variantMap: {}, idfMap: new Map(),
  conceptMeta: new Map(), multiDocSet: new Set(), sourceDocuments: 0,
};
let conceptDictCache = { mtimeMs: -1, value: null };

function loadConceptDictionary() {
  const dictPath = path.join(DATA_DIR, 'concepts', 'latest.json');
  try {
    const stat = fs.statSync(dictPath);
    if (conceptDictCache.value && conceptDictCache.mtimeMs === stat.mtimeMs) {
      return conceptDictCache.value;
    }
    const raw = fs.readFileSync(dictPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const conceptMeta = new Map();
    for (const concept of (parsed.concepts || [])) {
      if (!concept?.canonical) continue;
      conceptMeta.set(concept.canonical, {
        docFreq: Number(concept.docFreq) || 0,
        idf: Number(concept.idf) || 1,
      });
    }
    const canonicalSet = new Set((parsed.concepts || [])
      .map((c) => c.canonical)
      .filter((term) => !isLowSignalConceptTerm(term)));
    const variantMap = parsed.variantToCanonical || {};
    const idfMap = new Map((parsed.concepts || []).map((c) => [c.canonical, c.idf ?? 1]));
    const sourceDocuments = Number(parsed?.source?.documents) || 0;
    // Multi-doc concepts appear in 2+ documents and are the only ones that can
    // co-occur across the corpus. Single-doc concepts (docFreq=1) dominate the
    // IDF-based ranking but are useless for co-occurrence analysis.
    const multiDocSet = new Set((parsed.concepts || []).filter((c) => (c.docFreq ?? 1) >= 2).map((c) => c.canonical));
    const value = { canonicalSet, variantMap, idfMap, conceptMeta, multiDocSet, sourceDocuments };
    conceptDictCache = { mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    return EMPTY_CONCEPT_DICT;
  }
}
```

- [ ] **Step 6: Cap the compression buffer**

In `src/middleware/http.js`, inside `applyCompression`, add a passthrough bypass. After `const chunks = [];` add:

```js
  const MAX_COMPRESS_BUFFER_BYTES = 8 * 1024 * 1024;
  let buffered = 0;
  let bypassed = false;

  const bypass = () => {
    if (bypassed) return;
    bypassed = true;
    res.write = originalWrite;
    res.end = originalEnd;
    for (const chunk of chunks) originalWrite(chunk);
    chunks.length = 0;
  };
```

Replace `res.write` with:

```js
  res.write = (chunk, chunkEncoding, callback) => {
    if (bypassed) return originalWrite(chunk, chunkEncoding, callback);
    if (chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, chunkEncoding);
      chunks.push(buf);
      buffered += buf.length;
      if (buffered > MAX_COMPRESS_BUFFER_BYTES) bypass();
    }
    if (typeof callback === 'function') callback();
    return true;
  };
```

And at the top of the `res.end` override add:

```js
    if (bypassed) {
      originalEnd(chunk, chunkEncoding, callback);
      return;
    }
```

- [ ] **Step 7: Run the full suite**

Run: `npm test` — Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db.js src/api.js src/metrics.js src/middleware/http.js test/adminWorker.test.js
git commit -m "Harden job logs, API key transport, concept dict loading, compression buffering"
```

---

### Task 15: Documentation updates

Bring the README in line with the new behavior and document the accepted tradeoffs.

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Update the API section**

In `README.md`:

1. Under `## API`, replace the `maxRecords` bullet with:
   - `maxRecords`: bounds live Open Collections paging during admin sync only. Dashboard reads always serve the entire stored corpus (optionally narrowed by `degree`/`program`/`affiliation` filters).
2. Remove the `PUBLIC_MAX_RECORDS`/`PUBLIC_SCAN_LIMIT` "anonymous requests are capped" phrasing from the `maxRecords`/`scanLimit` bullets; note instead: "Public guardrails cap anonymous request *rates* (120 requests/minute per IP), not corpus coverage."
3. In `### Public Endpoints`, add a sentence: "Anonymous `/api` requests are rate-limited per IP; authenticated admin sessions are exempt."
4. In `## Operational Notes`, add:
   - "Metric run snapshots (`metric_runs`) are recorded only when an admin forces `refresh=1`; the table keeps the latest 100 runs."
   - "Blocked PDF downloads (UBC security page) are stored with status `blocked`; lower `PDF_DOWNLOAD_RATE_PER_MIN` before retrying."
   - "Catalogue lookups that permanently fail to parse are stored with `hits = -1` and reported as `failed` in lookup stats; they are not retried automatically."
   - "Admin settings accept a fixed key set; unknown keys in `PUT /api/admin/settings` are ignored."
   - "First-login MFA enrollment happens after password verification; anyone holding the bootstrap password before first login can enroll their own authenticator. Complete first login promptly after deploying."
5. In `## Core Environment Variables`, note on `UBC_API_KEY`: "Sent via request headers only." and add `circle.library.ubc.ca` to any mention of `PDF_ALLOWED_HOSTS`.

- [ ] **Step 2: Verify and commit**

Run: `npm test` — Expected: PASS (docs only).

```bash
git add README.md
git commit -m "Document full-corpus analytics, rate limits, and job semantics"
```

---

## Deferred (explicitly out of scope, with reasons)

- **In-memory sessions across restarts/machines** — single web machine by design; a restart logging admins out is acceptable. Revisit only if the app scales to multiple web machines.
- **`buildSupervisorNgramMatrix`/`buildTermCooccurrence` per-request CPU** — bounded now by the rate limiter (Task 6) and LRU cache (Task 5); precomputation is not warranted at this corpus size.
- **MFA enrollment-after-password design** — inherent to self-serve bootstrap without email delivery; documented in Task 15 instead of redesigned.

## Verification checklist after all tasks

1. `npm test` — full suite green.
2. `npm start` locally; anonymous browser session: Analytics Dashboard shows `recordCount` equal to the full corpus (418+), filters still narrow it.
3. Admin session: run an import-rule preview (confirms header-only API key works against live OC).
4. Confirm `metric_runs` row count stays flat while browsing anonymously.
