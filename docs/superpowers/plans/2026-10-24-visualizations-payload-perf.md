# Visualizations Payload Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GET /api/workbench/visualizations` fast and non-blocking at full-corpus scale (13,655 topic-assigned documents): build only what the response carries, from slim SQL projections, serve every topic-assigned document, and persist the unfiltered payload so a cold process serves it immediately.

**Architecture:** Replace the call to the full analytics pipeline (`buildMetricsPayloadFromRecords` over 5,000 parsed `metadata_json` blobs) with one slim SQL query (`queryVisualizationDocuments`) that reads document fields, topic, UMAP coords, and concept/methodology/people terms from the existing `documents`, `document_topics`, `document_topic_coords`, `document_terms`, and `document_people` tables. A focused builder (`buildTopicVisualizations`) computes only the four aggregates the slice returns. The unfiltered payload is stored gzip-compressed in a new `serving_snapshots` table keyed by `topics_generation` and used to seed the in-memory slice cache on a cold process.

**Tech Stack:** Node 18+ ESM, Express, `@libsql/client` (Turso in prod, local SQLite in tests), `node:zlib`, `node:test` + supertest.

**Spec:** GitHub issue #59 (`gh issue view 59`). Root-cause evidence is in that issue.

## Global Constraints

- No new npm dependencies.
- Every query must work on both Turso (HTTP) and local SQLite; tests use temp-dir databases only, never `data/metrics.sqlite`.
- No synchronous stretch in the request path may approach Turso's ~5s idle-socket window; target ≤ 1s of synchronous JS for the full-corpus build on the prod shared CPU.
- Restricted/embargoed documents keep today's behaviour: they appear only if `ACTIVE_ANALYTICS_ACCESS_SQL` admits them, and contribute no concept/methodology terms (`document_terms` already projects nothing for them).
- Topic counts (`topics[].docCount`, `topicData.byYear`) stay full-corpus SQL, as pinned by `test/publicTopicCounts.test.js`.
- The response shape `visualizationSlice()` returns (`generatedAt`, `source`, `topicData`, `supervisorNetwork`, `citationCooccurrence`, `methodologyTopicMatrix`, `documents[]` with `id,title,author,year,topicId,topicProbability,umapX,umapY,conceptTerms,methodologies`) does not change, so `public/app/data.js` and `public/app/topic-visuals.js` need no edits.
- Commit per task, conventional-commit message referencing the issue number.

## Review Focus

- A document with several `document_topics` rows must appear once, with its highest-probability topic (ties: lowest `topic_id`). Test owned by Task 1.
- Filters (`degree`, `program`, `affiliation`) must narrow documents *and* every aggregate, never only the document list. Test owned by Task 2.
- A person who is both metadata Supervisor and committee-sourced Supervisor for one document counts once for that document in the network (dedupe by `person_key`). Test owned by Task 1.
- After a topic swap (`topics_generation` changes), a stored snapshot from the old generation must never be served. Test owned by Task 4.
- Corrupt or undecodable snapshot rows must fall through to a normal build, never 500. Test owned by Task 4.

---

### Task 1: Slim visualization document query

**Files:**
- Modify: `src/db.js` (add next to `queryTopicDocumentPage`, ~L1709)
- Test: `test/visualizationDocuments.test.js` (create; temp-dir DB setup copied from `test/publicTopicCounts.test.js`)

**Interfaces:**
- Produces: `queryVisualizationDocuments({ syncKey = null, filters = {} } = {}) -> Promise<{ total: number, documents: VisualizationDoc[] }>` where `VisualizationDoc = { id, title, author, year, topicId, topicProbability, umapX, umapY, conceptTerms: string[], methodologies: string[], supervisors: string[] }`. `supervisors` holds the network people for the doc (roles `Supervisor`, `Co-Supervisor`, `Committee Member` from `document_people`, distinct `person_key`, value = `name`), so `buildSupervisorNetwork` can consume the doc unchanged. Ordered `COALESCE(d.year,0) DESC, lower(COALESCE(d.title,'')) ASC, d.doc_id ASC`. No LIMIT.

- [ ] **Step 1: Write the failing tests** in `test/visualizationDocuments.test.js`, seeding documents, `document_topics`, `document_topic_coords`, `document_terms`, `document_people` directly:
  - `returns one slim row per topic-assigned eligible document` — asserts `total` and `documents.length` equal the count of seeded docs with a topic; a doc with no `document_topics` row is absent; each row has exactly the `VisualizationDoc` keys.
  - `picks the highest-probability topic when a document has several` — doc with topics (3, 0.4) and (7, 0.9) yields `topicId === 7`, `topicProbability === 0.9`.
  - `reads concept and methodology terms from document_terms` — `conceptTerms` and `methodologies` deep-equal the seeded terms (sort both sides; projection has no order); a doc with no term rows gets `[]`.
  - `network people are distinct by person_key across sources` — same `person_key` seeded with `source='metadata'` and `source='pdf'` → appears once in `supervisors`; a `role='Chair'` row is excluded.
  - `applies degree/program/affiliation filters and access rules` — filtered call returns only matching docs; a doc failing `ACTIVE_ANALYTICS_ACCESS_SQL` is absent.
  - `missing coords yield null umapX/umapY` — doc with a topic but no `document_topic_coords` row has `umapX === null`.
- [ ] **Step 2: Run** `node --test test/visualizationDocuments.test.js` — Expected: FAIL, `queryVisualizationDocuments is not a function`.
- [ ] **Step 3: Implement `queryVisualizationDocuments`** using `analyticalDocumentFilters({ syncKey, ...filters })` and `all()`. One statement: `documents d` joined to a per-doc best topic (`ROW_NUMBER() OVER (PARTITION BY doc_id ORDER BY probability DESC, topic_id ASC) = 1`), `LEFT JOIN document_topic_coords`, and three correlated `json_group_array` subqueries over `document_terms` (kind `concept`, kind `methodology`) and `document_people` (`SELECT DISTINCT person_key, name … WHERE role IN (…)`). Parse the three JSON arrays in JS. `total` = `documents.length` (no separate COUNT).
- [ ] **Step 4: Run** `node --test test/visualizationDocuments.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(viz): slim SQL projection for visualization documents (#59)`

### Task 2: Build only the slice's aggregates

**Files:**
- Modify: `src/metrics.js` (export `buildCitationCooccurrenceNetwork` ~L790; add `buildTopicVisualizations` after `buildMethodologyTopicMatrix` ~L847)
- Modify: `src/routes/metricsRoutes.js` (`buildWorkbenchVisualizationsPayload` ~L548)
- Test: `test/visualizationPayload.test.js` (create), `test/publicTopicCounts.test.js` (keep passing)

**Interfaces:**
- Consumes: `queryVisualizationDocuments` (Task 1); existing `loadTopics()`, `loadTopicHierarchy()`, `getTopicByYearCounts({ syncKey, filters })`, `buildSupervisorNetwork(records)`, `buildParentClusters`, `buildTopicsByYear`.
- Produces: `buildTopicVisualizations(documents, { topics, hierarchy, byYear }) -> { topicData: { topics, byYear, hierarchy }, supervisorNetwork, methodologyTopicMatrix }` (pure, sync). `byYear` argument wins when non-null; otherwise computed with `buildParentClusters`/`buildTopicsByYear` exactly as `buildMetricsPayloadFromRecords` does today. `buildWorkbenchVisualizationsPayload(params, filters, loadSyncModule, { documentLimit = VISUALIZATION_DOCUMENT_LIMIT } = {})` keeps its signature and return shape; `documentLimit` now slices the `queryVisualizationDocuments` result (Task 3 removes the default cap).

- [ ] **Step 1: Write the failing tests** in `test/visualizationPayload.test.js` (temp DB seeded with ~20 docs across 3 topics, 2 degrees, terms, people, citations):
  - `payload is built from the visualization projection` — call `buildWorkbenchVisualizationsPayload` directly; assert `payload.source.aggregateSource === 'visualization-projection'`.
  - `aggregates match the legacy builder on the same documents` — for the seeded corpus, `supervisorNetwork`, `methodologyTopicMatrix`, `topicData.topics` deep-equal what `buildMetricsPayloadFromRecords` produces from the fixture objects (whose `supervisors`, `conceptTerms`, `methodologies` arrays are the same values seeded into `document_people` / `document_terms`, so the legacy path does not re-derive them).
  - `filters narrow documents and every aggregate` — with `{ degree: 'MA' }`, every `documents[].id` is an MA doc, `methodologyTopicMatrix` counts and `supervisorNetwork` nodes are computed only from MA docs, and `topicData.byYear` totals equal the MA doc count.
  - `restricted documents contribute no terms` — a restricted-but-eligible doc has `conceptTerms: []`, `methodologies: []`.
- [ ] **Step 2: Run** `node --test test/visualizationPayload.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** `buildTopicVisualizations` in `src/metrics.js`. Rewrite `buildWorkbenchVisualizationsPayload`: keep the `hasTopics()` early return; `queryVisualizationDocuments` → apply `documentLimit` → `buildTopicVisualizations(docs, { topics, hierarchy, byYear })` → `buildCitationCooccurrenceNetwork(docIds)`; `source` keeps `documentsAvailable`, `documentsReturned`, `documentsTruncated`, `visualizationDocumentLimit`, `filters`, `documentCache`, and sets `aggregateSource: 'visualization-projection'`. Return via existing `visualizationSlice`. `queryTopicDocumentPage` stays (other callers/tests) but is no longer used here.
- [ ] **Step 4: Run** `node --test test/visualizationPayload.test.js test/publicTopicCounts.test.js test/citationCooccurrenceBound.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** — `perf(viz): build only the visualization slice's aggregates from SQL projections (#59)`

### Task 3: Serve every topic-assigned document

**Files:**
- Modify: `src/routes/metricsRoutes.js:24` (`VISUALIZATION_DOCUMENT_LIMIT`)
- Modify: `test/metadataScaleServing.test.js:252` (`topic visualizations expose an explicit bounded document sample`), `test/publicTopicCounts.test.js:72`
- Test: same files

**Interfaces:**
- Produces: `VISUALIZATION_DOCUMENT_LIMIT = Infinity` (option still honoured when passed, so tests can bound it). With the default, `source.documentsTruncated === false` and `documentsReturned === documentsAvailable`.

- [ ] **Step 1: Update the tests first.** Rename the metadataScaleServing test to `topic visualizations return every topic-assigned document` and assert `documentsReturned === TOTAL_DOCUMENTS` (5100), `documentsTruncated === false`, `documents.length === 5100`; add `assert.ok(JSON.stringify(response.body).length < 400 * 5100)` as a per-doc size guard (slim rows, ~400 bytes each). `publicTopicCounts` keeps its explicit `{ documentLimit: 2 }` call unchanged (proves the option still bounds).
- [ ] **Step 2: Run** `node --test test/metadataScaleServing.test.js` — Expected: FAIL (`5000 !== 5100`).
- [ ] **Step 3: Set** `VISUALIZATION_DOCUMENT_LIMIT = Infinity` and make the slice `Number.isFinite(limit) ? docs.slice(0, limit) : docs`.
- [ ] **Step 4: Run** `node --test test/metadataScaleServing.test.js test/publicTopicCounts.test.js` — Expected: PASS. No Playwright spec currently touches the topic scatter; check the scatter manually in the prod verification below.
- [ ] **Step 5: Commit** — `feat(viz): send all topic-assigned documents to the scatter (#59)`

### Task 4: Persist the unfiltered payload per topics generation

**Files:**
- Modify: `src/db.js` (schema near `serving_projection_state` ~L314; helpers near `getSetting` ~L4044)
- Modify: `src/routes/metricsRoutes.js` (visualizations route ~L712 and `warmWorkbenchLandingCache` ~L589)
- Test: `test/visualizationSnapshot.test.js` (create)

**Interfaces:**
- Produces (db.js):
  - schema `CREATE TABLE IF NOT EXISTS serving_snapshots (snapshot_key TEXT PRIMARY KEY, generation TEXT NOT NULL, payload_gz BLOB NOT NULL, updated_at TEXT NOT NULL)`
  - `saveServingSnapshot(key: string, generation: string, payload: object) -> Promise<void>` — `gzipSync(JSON.stringify(payload))`, upsert.
  - `loadServingSnapshot(key: string) -> Promise<{ generation: string, payload: object, updatedAt: string } | null>` — returns `null` on missing row or any decode/parse error (log a warning).
- Produces (metricsRoutes.js): constant `VISUALIZATIONS_SNAPSHOT_KEY = 'workbench:visualizations:unfiltered'`; helper `seedSliceFromSnapshot(cache, key) -> Promise<boolean>` which, only when `cache.get(key)` is empty, loads the snapshot, compares `generation` to `getSetting('topics_generation')`, and on match sets `cache.set(key, { timestamp: Date.parse(updatedAt), payload })` so `cachedSlice` serves it and background-refreshes it if older than `WORKBENCH_SLICE_TTL_MS`.
- Behaviour: for unfiltered requests (all of `degree/program/affiliation` empty), the route calls `seedSliceFromSnapshot` before `cachedSlice`, and the compute function saves a snapshot after a successful build (best effort: a save failure is logged, never fails the request). Filtered requests are untouched. Snapshots are skipped when `topics_generation` is null.

- [ ] **Step 1: Write the failing tests** in `test/visualizationSnapshot.test.js`:
  - `save then load round-trips the payload` — deep-equal; `payload_gz` column is a BLOB smaller than the JSON.
  - `a cold cache is seeded from a matching-generation snapshot without rebuilding` — save a snapshot whose payload has sentinel `generatedAt: '2000-01-01T00:00:00.000Z'` with generation `g1`, set `topics_generation = g1`, fresh cache; `GET /api/workbench/visualizations` returns that sentinel `generatedAt`.
  - `a snapshot from an older generation is ignored` — snapshot `g1`, setting `g2` → normal build runs and a new `g2` snapshot is saved.
  - `an undecodable snapshot falls through to a build` — write `payload_gz = X'00'` directly → request returns 200 with a built payload.
  - `filtered requests neither read nor write snapshots` — `?degree=MA` leaves `serving_snapshots` row untouched.
- [ ] **Step 2: Run** `node --test test/visualizationSnapshot.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the schema, `saveServingSnapshot`/`loadServingSnapshot` (BLOB args as `Uint8Array`; on read accept `ArrayBuffer`/`Uint8Array`), `seedSliceFromSnapshot`, and the route wiring. In `warmWorkbenchLandingCache`, call `seedSliceFromSnapshot` for the visualizations key before computing so a startup warmup serves the snapshot first.
- [ ] **Step 4: Run** `node --test test/visualizationSnapshot.test.js` then `npm test` and `npm run lint` — Expected: all PASS, lint clean.
- [ ] **Step 5: Commit** — `feat(viz): persist the unfiltered visualizations payload per topics generation (#59)`

## Verification on prod (after merge, with approval to deploy)

1. Deploy the web app only (`fly deploy`); worker images are unaffected.
2. Cold timing: `curl -s -o /dev/null -w '%{http_code} %{time_total}s %{size_download}\n' 'https://dissertation-workbench.fly.dev/api/workbench/visualizations?degree=Master%20of%20Arts%20-%20MA'` three times with a new filter value each time (forces a cold build). Expected: 200, well under 5s (baseline: 500 after ~15s).
3. Unfiltered after a restart (`fly machine restart`): first request 200 in < 1s (served from snapshot).
4. Logs show no `fetch failed` / `other side closed` and no `Retrying transient DB error` lines for the read path during these calls.
5. Analytics tab in the browser: scatter renders all ~13,655 points; methodology/topic bubble chart and supervisor network render.
