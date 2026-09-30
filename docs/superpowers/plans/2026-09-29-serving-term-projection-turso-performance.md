# Serving Term Projection & Turso Read-Path Performance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate cold-path `json_each` full-table JSON scans on the two hot serving paths (analytics ~10s, related-docs ~3s at 14k docs on remote Turso) by projecting the in-blob term arrays into an indexed `document_terms` table and reading from it.

**Architecture:** Add a normalized `document_terms(doc_id, kind, term)` projection, built in the same write batch as document metadata (mirroring the existing `document_people` projection) and backfilled once via the resumable `serving_projection_version` mechanism. Rewrite related-docs, analytics term aggregations, and co-occurrence to read the projection instead of expanding `metadata_json` at query time. A runtime readiness flag routes each query to the projection when the backfill is complete and to the legacy `json_each` path otherwise, giving a safe, reversible rollout. `metadata_json` remains the source of truth.

**Tech Stack:** Node 18+ ESM, `@libsql/client` (embedded file locally, remote Turso in prod), `node:test`, custom runner `scripts/run-tests.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-29-serving-term-projection-turso-performance-design.md` (read it alongside this plan).

## Global Constraints

- Zero new npm dependencies; Node built-ins + `@libsql/client` only.
- Never read all metadata rows into one JavaScript collection (Metadata-Scale Serving Standard). All backfill is batched at 500 docs/iteration and resumable via `serving_projection_version`.
- `metadata_json` stays the source of truth; `document_terms` is a derived read accelerator.
- Every rewritten read query keeps a legacy `json_each` path behind the readiness flag; outputs must be byte-identical to the pre-rewrite query (verified by golden equivalence tests), except the co-occurrence disclosure fields (Task 8).
- Term projection covers exactly three kinds: `theme`, `concept`, `methodology`. Affiliation and supervisor arrays are out of scope.
- Term values are stored as `trim(CAST(value AS TEXT))` (display form), matching the current `GROUP BY trim(...)` output.
- Run the full suite with `npm test` after each task; it must stay green.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/db.js` | schema, projection statements, backfill, readiness flag, rewritten read queries, citation counts | 1,2,3,4,5,6,7,9 |
| `src/routes/metricsRoutes.js` | full-corpus co-occurrence wiring | 8 |
| `src/server.js` | non-blocking backfill kick + readiness init, cache-warm extension | 3,10 |
| `test/documentTermsProjection.test.js` (new) | projection write + backfill + readiness unit tests | 2,3 |
| `test/documentTermsEquivalence.test.js` (new) | golden equivalence: related-docs + simple aggregates | 4,5 |
| `test/analyticsSqlPortEquivalence.test.js` (existing) | extend for helper-fn rewrites | 6 |
| `test/termCooccurrenceProjection.test.js` (new) | full-corpus co-occurrence reference test | 8 |
| `test/dbMigration.test.js` (existing) | assert new table/indexes exist | 1 |
| `test/cachedDocuments.test.js` (existing) | bounded citation-count parity | 7 |

---

### Task 1: `document_terms` schema + indexes

**Files:**
- Modify: `src/db.js` (schema block near the `documents` / `document_people` CREATE TABLE statements, ~line 284; index block ~line 743–794)
- Test: `test/dbMigration.test.js`

**Interfaces:**
- Produces: table `document_terms(doc_id TEXT, kind TEXT, term TEXT, PRIMARY KEY(doc_id, kind, term))` and indexes `idx_document_terms_kind_term`, `idx_document_terms_kind_termlower`, `idx_document_terms_doc`.

- [ ] **Step 1: Write the failing test** — append to `test/dbMigration.test.js` a case asserting the table and indexes exist after `ensureSchema`.

```js
test('document_terms table and indexes are created', async () => {
  const { getDb, ensureStorage } = await import('../src/db.js');
  await ensureStorage();
  const db = await getDb();
  const tbl = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='document_terms'"
  );
  assert.equal(tbl.rows.length, 1);
  const idx = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='document_terms' ORDER BY name"
  );
  const names = idx.rows.map((r) => r.name);
  assert.ok(names.includes('idx_document_terms_kind_term'));
  assert.ok(names.includes('idx_document_terms_kind_termlower'));
  assert.ok(names.includes('idx_document_terms_doc'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/run-tests.mjs test/dbMigration.test.js`
Expected: FAIL — `document_terms` not found (0 rows).

- [ ] **Step 3: Add the table** to the schema `exec` block, immediately after the `document_people` CREATE TABLE (~line 284):

```sql
    CREATE TABLE IF NOT EXISTS document_terms (
      doc_id TEXT NOT NULL,
      kind   TEXT NOT NULL,
      term   TEXT NOT NULL,
      PRIMARY KEY (doc_id, kind, term)
    );
```

- [ ] **Step 4: Add the indexes** alongside the other `tryExec` CREATE INDEX calls (~line 794):

```js
  await tryExec(client, "CREATE INDEX IF NOT EXISTS idx_document_terms_kind_term ON document_terms(kind, term)");
  await tryExec(client, "CREATE INDEX IF NOT EXISTS idx_document_terms_kind_termlower ON document_terms(kind, lower(term))");
  await tryExec(client, "CREATE INDEX IF NOT EXISTS idx_document_terms_doc ON document_terms(doc_id, kind)");
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/run-tests.mjs test/dbMigration.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db.js test/dbMigration.test.js
git commit -m "feat(db): add document_terms projection table and indexes"
```

---

### Task 2: Term projection on metadata write

**Files:**
- Modify: `src/db.js` — add `metadataTermsStatements`, wire into `saveDocumentMetadata` (~line 1234) and `saveDocumentMetadataBatch` (~line 1338); bump written `serving_projection_version` from `1` to `2` in `saveDocumentStatement` (~line 1252 VALUES and ~1321 ON CONFLICT).
- Test: `test/documentTermsProjection.test.js` (new)

**Interfaces:**
- Consumes: `doc.themes`, `doc.conceptTerms`, `doc.methodologies` (arrays on the normalized doc), `isAccessRestricted(doc)`.
- Produces: `metadataTermsStatements(doc, now) → Array<{sql, args}>` (exported for tests via the module). Written docs carry `serving_projection_version = 2`.

- [ ] **Step 1: Write the failing test** (new file `test/documentTermsProjection.test.js`). Seed one doc, assert projected rows.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

let getDb, ensureStorage, closeDb, saveDocumentMetadataBatch, tempDir;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-terms-'));
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  ({ getDb, ensureStorage, closeDb, saveDocumentMetadataBatch } = await import('../src/db.js'));
  await ensureStorage();
  await getDb();
});
test.after(async () => { await closeDb(); await fs.rm(tempDir, { recursive: true, force: true }); });

test('metadata write projects theme/concept/methodology rows and sets version 2', async () => {
  await saveDocumentMetadataBatch([{ doc: {
    id: 'dt-1', title: 'T', author: 'A', year: 2020, degree: 'PhD', program: 'Education',
    themes: ['Indigenous Education', 'Language Policy'],
    conceptTerms: ['concept alpha', 'concept beta'],
    methodologies: ['Qualitative'],
  } }]);
  const db = await getDb();
  const rows = await db.execute("SELECT kind, term FROM document_terms WHERE doc_id='dt-1' ORDER BY kind, term");
  assert.deepEqual(rows.rows.map((r) => [r.kind, r.term]), [
    ['concept', 'concept alpha'], ['concept', 'concept beta'],
    ['methodology', 'Qualitative'],
    ['theme', 'Indigenous Education'], ['theme', 'Language Policy'],
  ]);
  const v = await db.execute("SELECT serving_projection_version v FROM documents WHERE doc_id='dt-1'");
  assert.equal(Number(v.rows[0].v), 2);
});

test('re-writing the same doc is idempotent (no duplicate rows)', async () => {
  const doc = { id: 'dt-2', title: 'T', themes: ['Alpha'], conceptTerms: [], methodologies: [] };
  await saveDocumentMetadataBatch([{ doc }]);
  await saveDocumentMetadataBatch([{ doc }]);
  const db = await getDb();
  const rows = await db.execute("SELECT COUNT(*) c FROM document_terms WHERE doc_id='dt-2'");
  assert.equal(Number(rows.rows[0].c), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/run-tests.mjs test/documentTermsProjection.test.js`
Expected: FAIL — no rows / `metadataTermsStatements` not applied.

- [ ] **Step 3: Add `metadataTermsStatements`** near `metadataPeopleStatements` (~line 1067):

```js
const DOCUMENT_TERM_KINDS = [
  ['theme', 'themes'],
  ['concept', 'conceptTerms'],
  ['methodology', 'methodologies'],
];

function metadataTermsStatements(doc, now = new Date().toISOString()) {
  const statements = [{
    sql: 'DELETE FROM document_terms WHERE doc_id = ?',
    args: [doc.id],
  }];
  // Restricted docs have their term arrays wiped from the stored metadata_json
  // (see saveDocumentStatement embargo branch); project nothing so the table
  // matches the stored blob.
  if (isAccessRestricted(doc)) return statements;
  for (const [kind, field] of DOCUMENT_TERM_KINDS) {
    const seen = new Set();
    const values = Array.isArray(doc?.[field]) ? doc[field] : [];
    for (const raw of values) {
      const term = String(raw ?? '').trim();
      if (!term || seen.has(term)) continue;
      seen.add(term);
      statements.push({
        sql: `INSERT INTO document_terms (doc_id, kind, term) VALUES (?, ?, ?)
              ON CONFLICT(doc_id, kind, term) DO NOTHING`,
        args: [doc.id, kind, term],
      });
    }
  }
  return statements;
}
```

- [ ] **Step 4: Wire it into both write paths.** In `saveDocumentMetadata` (~line 1236) and `saveDocumentMetadataBatch` (~line 1346), add `...metadataTermsStatements(doc, now),` immediately after the `...metadataPeopleStatements(doc, now),` spread.

- [ ] **Step 5: Bump the write version to 2.** In `saveDocumentStatement`, change the `VALUES (..., 1, ?)` literal (~line 1252) to `2`, so newly written docs are marked people+terms projected. The `ON CONFLICT ... serving_projection_version = excluded.serving_projection_version` line already propagates it.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node scripts/run-tests.mjs test/documentTermsProjection.test.js`
Expected: PASS (both cases).

- [ ] **Step 7: Commit**

```bash
git add src/db.js test/documentTermsProjection.test.js
git commit -m "feat(db): project document terms on metadata write; bump projection version to 2"
```

---

### Task 3: Resumable backfill + readiness flag + non-blocking startup

**Files:**
- Modify: `src/db.js` — add `backfillDocumentTermsProjection(client)`, an in-memory readiness flag with `isDocumentTermsReady()` / `initDocumentTermsReadiness()` / `__setDocumentTermsReadyForTesting(bool)`, and `runDocumentTermsBackfillOnce()`.
- Modify: `src/server.js` — after `server.listen(...)`, call readiness init then kick the backfill non-blocking.
- Test: `test/documentTermsProjection.test.js` (extend)

**Interfaces:**
- Consumes: `metadataTermsStatements`, `serving_projection_version`.
- Produces:
  - `isDocumentTermsReady(): boolean`
  - `initDocumentTermsReadiness(): Promise<void>` — sets the flag true iff no rows have `serving_projection_version < 2`.
  - `runDocumentTermsBackfillOnce(): Promise<void>` — batched backfill to version 2, then sets flag true.
  - `__setDocumentTermsReadyForTesting(value: boolean): void` — test hook.

- [ ] **Step 1: Write the failing test** (extend `test/documentTermsProjection.test.js`).

```js
test('backfill projects legacy rows (version<2) and flips readiness', async () => {
  const db = await getDb();
  const { runDocumentTermsBackfillOnce, initDocumentTermsReadiness, isDocumentTermsReady } = await import('../src/db.js');
  // Simulate a legacy row: metadata present, terms not yet projected, version 1.
  await db.execute({
    sql: "INSERT INTO documents (doc_id, metadata_json, serving_projection_version, updated_at) VALUES (?, ?, 1, ?)",
    args: ['legacy-1', JSON.stringify({ id: 'legacy-1', themes: ['Legacy Theme'], conceptTerms: [], methodologies: [] }), new Date().toISOString()],
  });
  await initDocumentTermsReadiness();
  assert.equal(isDocumentTermsReady(), false); // legacy row pending
  await runDocumentTermsBackfillOnce();
  const rows = await db.execute("SELECT kind, term FROM document_terms WHERE doc_id='legacy-1'");
  assert.deepEqual(rows.rows.map((r) => [r.kind, r.term]), [['theme', 'Legacy Theme']]);
  const v = await db.execute("SELECT serving_projection_version v FROM documents WHERE doc_id='legacy-1'");
  assert.equal(Number(v.rows[0].v), 2);
  assert.equal(isDocumentTermsReady(), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/run-tests.mjs test/documentTermsProjection.test.js`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Implement the flag + backfill** in `src/db.js` (near `backfillDocumentPeopleProjection`, ~line 1099):

```js
let documentTermsReady = false;
export function isDocumentTermsReady() { return documentTermsReady; }
export function __setDocumentTermsReadyForTesting(value) { documentTermsReady = Boolean(value); }

export async function initDocumentTermsReadiness() {
  const pending = await get('SELECT COUNT(*) AS c FROM documents WHERE serving_projection_version < 2');
  documentTermsReady = Number(pending?.c || 0) === 0;
}

export async function runDocumentTermsBackfillOnce() {
  const client = await getDb();
  while (true) {
    const result = await client.execute(`
      SELECT doc_id, metadata_json FROM documents
      WHERE serving_projection_version < 2
      ORDER BY doc_id LIMIT 500
    `);
    if (!result.rows.length) break;
    const statements = [];
    const now = new Date().toISOString();
    for (const row of result.rows) {
      let doc = null;
      try { doc = JSON.parse(row.metadata_json); } catch { doc = { id: row.doc_id }; }
      doc.id ||= row.doc_id;
      statements.push(...metadataTermsStatements(doc, now));
      statements.push({ sql: 'UPDATE documents SET serving_projection_version = 2 WHERE doc_id = ?', args: [row.doc_id] });
    }
    await client.batch(statements, 'write');
  }
  documentTermsReady = true;
}
```

Note: the legacy `backfillDocumentPeopleProjection` (version<1) still runs inside `ensureSchema`; a row it advances to 1 is then advanced to 2 by this pass. Do **not** move this pass into `ensureSchema` — it must not block startup.

- [ ] **Step 4: Wire non-blocking into `src/server.js`** — inside `start()`, after `const server = app.listen(...)`, add:

```js
  initDocumentTermsReadiness()
    .then(() => (isDocumentTermsReady() ? null : runDocumentTermsBackfillOnce()))
    .then(() => logger.info('document_terms projection ready'))
    .catch((e) => logger.warn('document_terms backfill failed; using json_each fallback', { error: e.message }));
```

Add `initDocumentTermsReadiness, isDocumentTermsReady, runDocumentTermsBackfillOnce` to the existing `./db.js` import in `src/server.js`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node scripts/run-tests.mjs test/documentTermsProjection.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db.js src/server.js test/documentTermsProjection.test.js
git commit -m "feat(db): resumable document_terms backfill with non-blocking startup + readiness flag"
```

---

### Task 4: Rewrite `queryRelatedDocuments` behind the readiness flag

**Files:**
- Modify: `src/db.js` — `queryRelatedDocuments` (~line 2391)
- Test: `test/documentTermsEquivalence.test.js` (new)

**Interfaces:**
- Consumes: `isDocumentTermsReady()`, `__setDocumentTermsReadyForTesting`.
- Produces: identical return shape `[{ id, title, author, year, degree, overlap }]`.

- [ ] **Step 1: Write the failing golden test** (new `test/documentTermsEquivalence.test.js`). Seed a fixture, capture the legacy (`json_each`) result and the projection result, assert deep-equal.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs/promises';

let db, ensureStorage, getDb, closeDb, saveDocumentMetadataBatch,
    queryRelatedDocuments, __setDocumentTermsReadyForTesting, tempDir;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-equiv-'));
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  ({ ensureStorage, getDb, closeDb, saveDocumentMetadataBatch,
     queryRelatedDocuments, __setDocumentTermsReadyForTesting } = await import('../src/db.js'));
  await ensureStorage(); db = await getDb();
  const docs = Array.from({ length: 40 }, (_, i) => ({ doc: {
    id: `rel-${i}`, title: `Doc ${i}`, author: `A${i}`, year: 2000 + (i % 10), degree: 'PhD',
    themes: [`theme ${i % 5}`, `theme ${(i + 1) % 5}`],
    conceptTerms: [`concept ${i % 4}`], methodologies: [],
  } }));
  await saveDocumentMetadataBatch(docs);
});
test.after(async () => { await closeDb(); await fs.rm(tempDir, { recursive: true, force: true }); });

test('related-docs: projection path equals json_each path', async () => {
  const target = { id: 'rel-0', themes: ['theme 0', 'theme 1'], conceptTerms: ['concept 0'] };
  __setDocumentTermsReadyForTesting(false);
  const legacy = await queryRelatedDocuments(target, { limit: 6 });
  __setDocumentTermsReadyForTesting(true);
  const projected = await queryRelatedDocuments(target, { limit: 6 });
  assert.deepEqual(projected, legacy);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/run-tests.mjs test/documentTermsEquivalence.test.js`
Expected: FAIL — projection branch not implemented (results differ or error).

- [ ] **Step 3: Add the projection branch** at the top of `queryRelatedDocuments`, after `terms` is computed and the empty-guard (`if (!doc?.id || !terms.length) return [];`). Keep the existing `json_each` query as the `else` branch unchanged.

```js
  if (isDocumentTermsReady()) {
    const values = terms.map(() => '(?)').join(', ');
    const syncClause = syncKey ? 'AND d.sync_key = ?' : '';
    const rows = await all(`
      WITH target_terms(term) AS (VALUES ${values})
      SELECT d.doc_id, d.title, d.author, d.year, d.degree,
             COUNT(DISTINCT target_terms.term) AS overlap
      FROM documents d
      JOIN document_terms dt
        ON dt.doc_id = d.doc_id AND dt.kind IN ('theme','concept')
      JOIN target_terms ON lower(dt.term) = target_terms.term
      WHERE d.doc_id <> ? ${syncClause}
        AND ${ACTIVE_ANALYTICS_ACCESS_SQL}
      GROUP BY d.doc_id, d.title, d.author, d.year, d.degree
      ORDER BY overlap DESC, d.year DESC, d.title ASC
      LIMIT ?
    `, [...terms, doc.id, ...(syncKey ? [syncKey] : []), Math.max(1, Math.min(25, Number(limit) || 6))]);
    return rows.map((row) => ({
      id: row.doc_id, title: row.title || '', author: row.author || '',
      year: row.year == null ? null : Number(row.year),
      degree: row.degree || '', overlap: Number(row.overlap || 0),
    }));
  }
```

Note: `terms` are already lowercased (existing code lowercases them); matching `lower(dt.term)` reproduces the current case-insensitive comparison. `kind IN ('theme','concept')` reproduces the current themes-or-conceptTerms union.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/run-tests.mjs test/documentTermsEquivalence.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/documentTermsEquivalence.test.js
git commit -m "perf(db): serve related documents from document_terms when projection is ready"
```

---

### Task 5: Rewrite the three simple analytics term aggregations

**Files:**
- Modify: `src/db.js` — inside `getDocumentServingAnalytics` (~line 2016): the themes aggregate (~2052), conceptTerms aggregate (~2061), methodologies aggregate (~2070).
- Test: `test/documentTermsEquivalence.test.js` (extend)

**Interfaces:**
- Consumes: `isDocumentTermsReady()`, `filters.where`, `filters.args`.
- Produces: unchanged row shape `{ term|methodology, count }`.

**Mechanical transformation (applies to all three):** replace
`FROM documents d, json_each(d.metadata_json, '$.<field>') term` +
`${qualifier} trim(CAST(term.value AS TEXT)) <> ''`
with a JOIN to `document_terms` filtered by `kind`, grouping on the stored (already-trimmed) `term`:

- [ ] **Step 1: Write the failing test** (extend equivalence file): compare the analytics themes/concepts/methodologies arrays between the two readiness modes via `getDocumentServingAnalytics`.

```js
test('analytics simple aggregates: projection equals json_each', async () => {
  const { getDocumentServingAnalytics } = await import('../src/db.js');
  __setDocumentTermsReadyForTesting(false);
  const legacy = await getDocumentServingAnalytics({});
  __setDocumentTermsReadyForTesting(true);
  const projected = await getDocumentServingAnalytics({});
  assert.deepEqual(projected.conceptFrequency ?? projected.concepts, legacy.conceptFrequency ?? legacy.concepts);
  assert.deepEqual(projected.themeFrequency ?? projected.themes, legacy.themeFrequency ?? legacy.themes);
  assert.deepEqual(projected.methodologyFrequency ?? projected.methodologies, legacy.methodologyFrequency ?? legacy.methodologies);
});
```

(If the exact payload keys differ, read the tail of `getDocumentServingAnalytics` where `themes`/`concepts`/`methodologies` are assembled and assert on those keys.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/run-tests.mjs test/documentTermsEquivalence.test.js`
Expected: FAIL.

- [ ] **Step 3: Extract a helper** in `src/db.js` above `getDocumentServingAnalytics` and use it for the three aggregate queries. Because these run inside a `Promise.all` array, replace each inline query with a branch that picks projection vs legacy SQL:

```js
function termAggregateSql(kind, filters, qualifier, limitSql) {
  if (isDocumentTermsReady()) {
    return {
      sql: `
        SELECT dt.term AS term, COUNT(DISTINCT d.doc_id) AS count
        FROM documents d
        JOIN document_terms dt ON dt.doc_id = d.doc_id AND dt.kind = ?
        ${filters.where}
        GROUP BY dt.term
        ORDER BY count DESC, term ASC
        ${limitSql}`,
      args: [kind, ...filters.args],
    };
  }
  const field = { theme: 'themes', concept: 'conceptTerms', methodology: 'methodologies' }[kind];
  return {
    sql: `
      SELECT trim(CAST(term.value AS TEXT)) AS term, COUNT(DISTINCT d.doc_id) AS count
      FROM documents d, json_each(d.metadata_json, '$.${field}') term
      ${filters.where}
      ${qualifier} trim(CAST(term.value AS TEXT)) <> ''
      GROUP BY term
      ORDER BY count DESC, term ASC
      ${limitSql}`,
    args: filters.args,
  };
}
```

Then in the `Promise.all`, replace the three inline `all(...)` calls with (themes example; concepts uses `LIMIT ?` + subjectLimit arg, methodologies uses `LIMIT 100`):

```js
    (() => { const q = termAggregateSql('theme', filters, qualifier, 'LIMIT 70'); return all(q.sql, q.args); })(),
```

For the concepts query preserve its `LIMIT ?` bound by appending the clamp arg:

```js
    (() => {
      const q = termAggregateSql('concept', filters, qualifier, 'LIMIT ?');
      return all(q.sql, [...q.args, Math.max(1, Math.min(100, Number(subjectLimit) || 25))]);
    })(),
```

Note: the projection stores only non-empty trimmed terms (Task 2), so the `<> ''` guard is inherently satisfied on the projection path; grouping on `dt.term` reproduces the legacy `GROUP BY trim(...)` output.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/run-tests.mjs test/documentTermsEquivalence.test.js`
Expected: PASS.

- [ ] **Step 5: Run the broader analytics suite** to catch payload-shape regressions:

Run: `node scripts/run-tests.mjs test/fullCorpusAnalytics.test.js test/analyticsSqlPortEquivalence.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db.js test/documentTermsEquivalence.test.js
git commit -m "perf(db): serve analytics theme/concept/methodology aggregates from document_terms"
```

---

### Task 6: Rewrite the analytics matrix/timeline helper queries

**Files:**
- Modify: `src/db.js` — `computeConceptTimelineSql` (~1755), `computeSupervisorNgramMatrixSql` (~1944), `computeMethodologyConceptMatrixSql` (~1791), `computeMethodologyTopicMatrixSql` (~1861). Convert each `json_each(d.metadata_json, '$.conceptTerms'|'$.methodologies') X` occurrence to a `document_terms` join, behind `isDocumentTermsReady()`.
- Test: `test/analyticsSqlPortEquivalence.test.js` (extend)

**Interfaces:**
- Consumes: `isDocumentTermsReady()`, `filters`, `qualifier`.
- Produces: unchanged return shapes for each helper.

**Mechanical transformation rule (identical for every occurrence):**
- `FROM documents d, json_each(d.metadata_json, '$.conceptTerms') term` → `FROM documents d JOIN document_terms term ON term.doc_id = d.doc_id AND term.kind = 'concept'`, and read `term.term` instead of `trim(CAST(term.value AS TEXT))`.
- `'$.methodologies') m` → `JOIN document_terms m ON m.doc_id = d.doc_id AND m.kind = 'methodology'`, reading `m.term`.
- Correlated existence probes like `EXISTS (SELECT 1 FROM json_each(d.metadata_json, '$.methodologies'))` → `EXISTS (SELECT 1 FROM document_terms WHERE doc_id = d.doc_id AND kind = 'methodology')`.
- Correlated counts like `(SELECT COUNT(*) FROM json_each(d.metadata_json, '$.methodologies'))` → `(SELECT COUNT(*) FROM document_terms WHERE doc_id = d.doc_id AND kind = 'methodology')`.

Because each helper already returns from one function, wrap the two SQL variants with `if (isDocumentTermsReady()) { <projected> } else { <existing> }` and keep the existing SQL verbatim in the `else`.

- [ ] **Step 1: Write the failing test** (extend `test/analyticsSqlPortEquivalence.test.js`): call `getDocumentServingAnalytics` twice (readiness false vs true) on the existing 220-doc fixture and deep-equal the four affected panels.

```js
test('helper matrices/timeline: projection equals json_each', async () => {
  const { getDocumentServingAnalytics, __setDocumentTermsReadyForTesting } = await import('../src/db.js');
  __setDocumentTermsReadyForTesting(false);
  const legacy = await getDocumentServingAnalytics({ syncKey: SYNC_KEY });
  __setDocumentTermsReadyForTesting(true);
  const projected = await getDocumentServingAnalytics({ syncKey: SYNC_KEY });
  assert.deepEqual(projected.conceptTimeline, legacy.conceptTimeline);
  assert.deepEqual(projected.methodologyConceptMatrix, legacy.methodologyConceptMatrix);
  assert.deepEqual(projected.supervisorNgramMatrix, legacy.supervisorNgramMatrix);
  assert.deepEqual(projected.methodologyTopicMatrix, legacy.methodologyTopicMatrix);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/run-tests.mjs test/analyticsSqlPortEquivalence.test.js`
Expected: FAIL — projected branches not yet implemented (helpers still json_each in both modes → the test's `true` run equals the `false` run only if unchanged; make the assertion meaningful by first confirming the fixture actually seeds terms via Task 2, so the projected branch, once added, is exercised). If both runs already match because helpers are unconverted, the test still guards the conversion in Step 3 (it must stay green after conversion).

- [ ] **Step 3: Convert each helper** by adding the `isDocumentTermsReady()` branch and applying the transformation rule above to every enumerated `json_each` occurrence:
  - `computeConceptTimelineSql`: lines ~1759, ~1772 (`$.conceptTerms`).
  - `computeSupervisorNgramMatrixSql`: lines ~1961, ~1986 (`$.conceptTerms`).
  - `computeMethodologyConceptMatrixSql`: lines ~1794 (`$.methodologies`), ~1813 (`COUNT(*)` subquery), ~1814 (`$.conceptTerms`), ~1818 (`EXISTS`), ~1834–1835 (`$.methodologies` + `$.conceptTerms`).
  - `computeMethodologyTopicMatrixSql`: lines ~1864, ~1882 (`$.methodologies`).

  Representative conversion (concept timeline, first occurrence):

```sql
-- before
FROM documents d, json_each(d.metadata_json, '$.conceptTerms') term
-- after
FROM documents d JOIN document_terms term ON term.doc_id = d.doc_id AND term.kind = 'concept'
-- and replace  trim(CAST(term.value AS TEXT))  with  term.term  throughout that query
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/run-tests.mjs test/analyticsSqlPortEquivalence.test.js test/analyticsSqlPortScale.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/analyticsSqlPortEquivalence.test.js
git commit -m "perf(db): serve analytics timeline/matrix helpers from document_terms"
```

---

### Task 7: Bounded live citation counts (no whole-table GROUP BY)

**Files:**
- Modify: `src/db.js` — `queryCachedDocumentPage` (~line 1555): replace the `LEFT JOIN (SELECT doc_id, COUNT(*) … GROUP BY doc_id)` with a per-page count restricted to the page's doc_ids.
- Test: `test/cachedDocuments.test.js` (extend)

**Interfaces:**
- Consumes: existing `idx_document_citations_doc_id`.
- Produces: unchanged `documents[].citationCount`.

- [ ] **Step 1: Write the failing test** (extend `test/cachedDocuments.test.js`): seed docs + citations, assert a page's `citationCount` values match a direct count.

```js
test('citation counts on a page match a direct per-doc count', async () => {
  // (reuse the file's existing seed helpers; add citations for one doc,
  //  fetch a page, assert that doc's citationCount equals the direct count)
});
```

(Model the seeding on the existing cases in this file; the assertion compares `page.documents.find(d => d.id === X).citationCount` to `SELECT COUNT(*) FROM document_citations WHERE doc_id = X`.)

- [ ] **Step 2: Run test to verify it fails** (only if you change behavior; if counts already match, this test is a regression guard and should pass before and after — that is acceptable for this task since the change is a performance rewrite with identical output).

Run: `node scripts/run-tests.mjs test/cachedDocuments.test.js`

- [ ] **Step 3: Rewrite the citation join.** Compute counts only for the page rows. Replace the subquery-join with a two-step: run the page query without the citation subquery, collect `doc_id`s, then one `SELECT doc_id, COUNT(*) … WHERE doc_id IN (…) GROUP BY doc_id` (chunked at 999 like `applyCitationCountsToDocuments`), and attach. Reuse the existing `applyCitationCountsToDocuments(documents)` helper (`src/db.js:2456`) which already does exactly this over a bounded id set.

```js
  // after building `documents` from rows (drop dc subquery from the main SELECT):
  await applyCitationCountsToDocuments(documents);
```

Remove `COALESCE(dc.citation_count, 0) AS citation_count` from the SELECT and the `LEFT JOIN (SELECT … GROUP BY doc_id) dc …` clause; drop the `doc.citationCount = Number(row.citation_count || 0)` line (now set by the helper).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/run-tests.mjs test/cachedDocuments.test.js test/documentTermsEquivalence.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/cachedDocuments.test.js
git commit -m "perf(db): bound document-page citation counts to the page's doc ids"
```

---

### Task 8: Full-corpus co-occurrence from `document_terms`

**Files:**
- Modify: `src/db.js` — add `queryConceptTermsByDoc({ syncKey, filters })` returning `Map<doc_id, string[]>` from `document_terms` (kind `concept`) across the whole corpus.
- Modify: `src/routes/metricsRoutes.js` — the analytics aggregate branch (~line 568): when the projection is ready, build co-occurrence over full-corpus concept lists instead of the 5,000-doc `metadata_json` sample; set disclosure fields to full-corpus.
- Test: `test/termCooccurrenceProjection.test.js` (new)

**Interfaces:**
- Consumes: `isDocumentTermsReady()`, `buildTermCooccurrence` (`src/metrics.js:568`), `document_terms`.
- Produces: `queryConceptTermsByDoc(...) → Promise<Array<{ conceptTerms: string[] }>>` (record shape `buildTermCooccurrence` accepts — it reads `rec.conceptTerms`); analytics `source.termCooccurrenceSampled = false`.

**Correctness note (from spec §3.6):** `buildTermCooccurrence` consumes `docConceptTerms(rec)`, which returns `rec.conceptTerms` when present. For docs whose stored metadata lacks `conceptTerms`, the current sample path derives concepts from title/abstract on the fly; the projection stores only stored `conceptTerms`. Task 2 must therefore also project derived concepts for such docs **or** this task must restrict scope to docs with stored `conceptTerms`. Decision for this plan: project the same list `docConceptTerms` produces (see Step 0) so full-corpus co-occurrence matches a reference computed the same way.

- [ ] **Step 0: Align the projected concept list with `docConceptTerms`.** In `metadataTermsStatements` (Task 2), for `kind='concept'`, source terms from `docConceptTerms(doc, 20, loadConceptDictionary())` (imported from `src/metrics.js`) rather than the raw `doc.conceptTerms`, so the analytics concepts panel and co-occurrence read the same tokens. Update the Task 2 test expectation accordingly if raw vs derived differ for the fixture. (If `doc.conceptTerms` is always populated in production writes, derived === raw and this is a no-op; confirm against `withStoredThemes`.)

- [ ] **Step 1: Write the failing test** (new `test/termCooccurrenceProjection.test.js`): seed docs with concept terms; compute co-occurrence via the projection helper and via `buildTermCooccurrence` over the same in-memory records; assert equal.

```js
test('full-corpus co-occurrence from projection equals direct build', async () => {
  // seed N docs with overlapping conceptTerms
  // reference = buildTermCooccurrence(records)  // records = the same concept lists
  // actual    = buildTermCooccurrence(await queryConceptTermsByDoc({}))
  // assert.deepEqual(actual, reference)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/run-tests.mjs test/termCooccurrenceProjection.test.js`
Expected: FAIL — `queryConceptTermsByDoc` not defined.

- [ ] **Step 3: Implement `queryConceptTermsByDoc`** in `src/db.js`:

```js
export async function queryConceptTermsByDoc({ syncKey = null, filters = {} } = {}) {
  const f = analyticalDocumentFilters({ syncKey, ...filters });
  const rows = await all(`
    SELECT dt.doc_id AS doc_id, dt.term AS term
    FROM documents d
    JOIN document_terms dt ON dt.doc_id = d.doc_id AND dt.kind = 'concept'
    ${f.where}
    ORDER BY dt.doc_id
  `, f.args);
  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.doc_id)) byDoc.set(r.doc_id, []);
    byDoc.get(r.doc_id).push(r.term);
  }
  return Array.from(byDoc.values()).map((conceptTerms) => ({ conceptTerms }));
}
```

- [ ] **Step 4: Wire the route** (`src/routes/metricsRoutes.js`, ~line 568). Replace the `termSample`/`buildTermCooccurrence` block with a readiness branch:

```js
      let termCooccurrence, termMeta;
      if (isDocumentTermsReady()) {
        const records = await queryConceptTermsByDoc({ syncKey: documentCache.syncKey, filters });
        termCooccurrence = buildTermCooccurrence(records);
        termMeta = { termCooccurrenceSampled: false, termCooccurrenceSampleSize: records.length, termCooccurrenceSampleOf: records.length };
      } else {
        const termSample = await queryCachedDocumentPage({ syncKey: documentCache.syncKey, filters, limit: VISUALIZATION_DOCUMENT_LIMIT, offset: 0 });
        termCooccurrence = buildTermCooccurrence(enrichDocumentSignals(termSample.documents));
        termMeta = { termCooccurrenceSampled: true, termCooccurrenceSampleSize: termSample.documents.length, termCooccurrenceSampleOf: termSample.total };
      }
```

Then use `...termMeta` where the `source` object currently sets `termCooccurrenceSampled/SampleSize/SampleOf`, and `termCooccurrence` where it is spread into the payload. Import `isDocumentTermsReady, queryConceptTermsByDoc` from `../db.js`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node scripts/run-tests.mjs test/termCooccurrenceProjection.test.js test/fullCorpusAnalytics.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db.js src/routes/metricsRoutes.js test/termCooccurrenceProjection.test.js
git commit -m "perf(analytics): compute full-corpus co-occurrence from document_terms projection"
```

---

### Task 9: Warm analytics + visualizations after projection

**Files:**
- Modify: `src/server.js` — `warmWorkbenchCache` (grep for the function; it currently warms the workbench document cache).
- Test: manual smoke (documented) — no unit test; warming is a cache-population side effect.

**Interfaces:**
- Consumes: the existing warm helper's request-params builder.
- Produces: analytics + visualizations cache entries populated after backfill completes.

- [ ] **Step 1: Chain warm after backfill.** In the `runDocumentTermsBackfillOnce().then(...)` chain added in Task 3, add `.then(() => warmWorkbenchCache('post-projection'))`. Ensure `warmWorkbenchCache` issues internal warm reads for `/workbench/analytics` and `/workbench/visualizations` with the same default params it already uses for documents (extend its param set / add the two cache keys).

- [ ] **Step 2: Verify manually** (documented in the commit body): start the server against a seeded local DB, watch logs for `document_terms projection ready`, then confirm the first `/api/workbench/analytics` request is served warm (fast) via the harness in Step 3 of Task 10.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "perf(server): warm analytics and visualizations caches after projection completes"
```

---

### Task 10: Scale-test coverage + Turso telemetry

**Files:**
- Modify: `scripts/load-test-metadata-serving.mjs` — ensure the seed path exercises `document_terms` (it will automatically, since seeding uses `saveDocumentMetadataBatch`); set `isDocumentTermsReady()` true after seeding (call `runDocumentTermsBackfillOnce()` once) so the harness measures the projection path.
- Add: `scripts/perf/prod-read-path.mjs` — committed version of the ad-hoc `perftest.mjs` used during profiling, targeting `$BASE`.
- Test: `npm run test:metadata-scale`

- [ ] **Step 1: Make the scale harness exercise the projection.** After the harness finishes seeding each size, call `runDocumentTermsBackfillOnce()` before the analytics measurement so `isDocumentTermsReady()` is true.

- [ ] **Step 2: Tighten the analytics budget** once local numbers land. Run `npm run test:metadata-scale` and record the new analytics timing; set `METADATA_SCALE_ANALYTICS_TARGET_MS` default in the spec's Performance Contract if it improves materially.

Run: `npm run test:metadata-scale`
Expected: PASS within budgets.

- [ ] **Step 3: Commit the prod telemetry harness** (read-only; the deployment-acceptance step the standard requires):

```bash
git add scripts/load-test-metadata-serving.mjs scripts/perf/prod-read-path.mjs
git commit -m "test(perf): exercise document_terms in scale harness; add prod read-path telemetry script"
```

- [ ] **Step 4: Post-deploy telemetry (manual, documented).** After deploying, run `BASE=https://dissertation-workbench.fly.dev node scripts/perf/prod-read-path.mjs` and confirm cold analytics and related-docs meet the agreed threshold (target: analytics < 1s cold, related-docs < 300ms cold — down from 10s / 3s). Record results in the spec's telemetry note.

---

## Self-Review

**Spec coverage:**
- §3.1 schema → Task 1. §3.2 projection write → Task 2. §3.3 backfill/readiness/non-blocking → Task 3. §3.4 related-docs + analytics rewrites → Tasks 4,5,6. §3.5 bounded citation counts → Task 7. §3.6 full-corpus co-occurrence → Task 8. §3.7 cache-warm → Task 9. §5 verification (golden equivalence + scale + telemetry) → Tasks 4–8 tests + Task 10. §6 fallback flag → readiness gate in Tasks 3–8. §7.1 full-corpus decided → Task 8. §7.2 keep-one-release fallback → readiness branches retained. No gaps.

**Placeholder scan:** Task 7 Step 1 and Task 8 Step 1 reference reusing existing file helpers rather than inlining full seed code; each names the exact assertion and helper (`applyCitationCountsToDocuments`, `buildTermCooccurrence`, `queryConceptTermsByDoc`). Task 9 has no unit test by design (cache side-effect) with a documented manual verification. These are acceptable; no "TBD"/"add error handling"/"similar to Task N" placeholders remain.

**Type consistency:** `isDocumentTermsReady`/`initDocumentTermsReadiness`/`runDocumentTermsBackfillOnce`/`__setDocumentTermsReadyForTesting` (Task 3) are consumed unchanged in Tasks 4–8. `metadataTermsStatements(doc, now)` (Task 2) is reused in Task 3 backfill and refined in Task 8 Step 0. `queryConceptTermsByDoc` return shape `{ conceptTerms: string[] }` matches what `buildTermCooccurrence` reads via `docConceptTerms`. Kind literals (`theme`/`concept`/`methodology`) are consistent across Tasks 2,4,5,6,8.

**Open risk flagged for execution:** Task 8 Step 0 (projecting `docConceptTerms` output vs raw `conceptTerms`) is the one place where the analytics concepts panel (wants raw) and co-occurrence (wants derived) can diverge for docs lacking stored `conceptTerms`. Resolve during execution by confirming, against `withStoredThemes`, whether production writes always populate `conceptTerms` (making derived === raw). If they diverge, split into two kinds (`concept` for the panel, `cooccurrence_concept` for co-occurrence); the golden tests (Tasks 5, 8) will surface the divergence.
