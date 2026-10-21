# Fix Failing Unit Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm test` passes 411/411, reliably, so that CI (plan `2026-10-20-ci-lint-e2e.md`) can start from a green suite.

**Architecture:** These are debugging tasks, not features. Each task owns one failure cluster. It finds the root cause with superpowers:systematic-debugging, fixes the **production code** if the code regressed, or fixes the **test** only if the test's expectation is provably stale. It ends with the cluster's tests passing.

**Tech Stack:** Node `node:test`, `@libsql/client` over a local SQLite file, Express + supertest.

**Spec:** No separate spec doc. The requirement comes from the 2026-10-20 conversation ("fix the failing tests first") and the baseline below.

## Baseline (2026-10-20, branch `v2` at `5030021`, Node 25.9, macOS)

Full `npm test`: 403/411 pass, 8 fail, 3m30s. Running each file alone via `node scripts/run-tests.mjs test/<file>`:

| File | Alone | Failing test (line) | Failure |
|---|---|---|---|
| `test/catalogueFailures.test.js` | 3 fail | `:66` permanent lookup failures are persisted and drain the pending queue | "fixture should have pending citations to drain" |
| | | `:151` getCatalogueLookupStats().pending matches countPendingLookups()… | "citation with no catalogue_lookups row should be pending" |
| | | `:486` collectOrphanedCitations only removes ids it is given | `LibsqlError SQLITE_BUSY: cannot commit transaction - SQL statements in progress` |
| `test/cachedDocuments.test.js` | 1 fail | `:124` stored themes can be manually recomputed across documents | falsy assertion |
| `test/adminWorker.test.js` | 1 fail | `:1887` theme recompute job refreshes durable document themes with progress | `actual: true, expected: false` |
| `test/syncBatch.test.js` | 1 fail | `:482` explicit PDF full-text fallback counts as successful enrichment | `actual: 0, expected: 1` |
| `test/analyticsScaleMemory.test.js` | 1 fail | `:261` #27 buildSupervisorNetwork peak heap scales with top-N | heap ratio 8.26 vs record-count ratio 11.2 |
| `test/server.test.js` | **0 fail** | `:185` citation scan preview counts pending documents… | `actual: 0, expected: 1`, only in the full run |

## Global Constraints

- Never point tests at `./data/metrics.sqlite` (iCloud lock hang). Always run through `node scripts/run-tests.mjs`, which sets a temp `APP_DATA_DIR`.
- Do not delete, `skip`, or `todo` a failing test, and do not loosen an assertion to make it pass, unless the task's root-cause note proves the expectation itself is wrong. A threshold change must be justified by measured data in the report.
- Runtime `dependencies` in `package.json` must not change.
- Fix production behaviour in `src/`, not by special-casing tests in `src/`.
- Before committing, run each task's own files, plus the full `npm test` once at the end of the task. Report the full-suite pass/fail counts.
- Commit style: `fix(<area>): <what>` / `test(<area>): <what>`, ending with the attribution trailer the controller gives you.
- Recent history is the first suspect. Inspect `git log --oneline -30 -- <files involved>` and the last ~10 commits on `v2` (document_terms projection, ANALYZE after backfill, cache warming) before theorising.

## Review Focus

1. **Masking instead of fixing.** A test made to pass by changing its fixture or expectation, when production code actually regressed. The report must state the root cause and the commit that introduced it, where identifiable.
2. **The SQLITE_BUSY fix leaves an open cursor elsewhere.** If the cause is an un-finalized statement or a read inside a write transaction, other callers of the same helper may have the same bug. Grep for siblings.
3. **Shared temp data dir across test files** (the `server.test.js` case). Concurrently running test files that don't create their own temp dir share `run-tests.mjs`'s single `APP_DATA_DIR`. Fixing only `server.test.js` leaves the next file to hit the same trap.
4. **Heap test still flaky after the fix.** Pass it 5 consecutive times in the full suite before accepting it.
5. **The theme fix changes what users see.** If theme recompute logic changed, check that `/api/workbench/*` theme facets still come out the same for unaffected docs.

---

### Task 1: Catalogue pending-lookup cluster (catalogueFailures ×3)

**Files:**
- Test: `test/catalogueFailures.test.js` (failures at `:66`, `:151`, `:486`)
- Likely modify: `src/catalogue.js`, `src/catalogueQuery.js`, and/or `src/db.js` (pending-lookup queries, `collectOrphanedCitations`)

**Interfaces:**
- Produces: `getCatalogueLookupStats().pending`, `countPendingLookups()` and `listPendingLookups()` agree, and count citations that have no `catalogue_lookups` row as pending. `collectOrphanedCitations(ids)` commits without SQLITE_BUSY.

- [ ] **Step 1: Reproduce.** Run `node scripts/run-tests.mjs test/catalogueFailures.test.js`. Expected: 8 pass, 3 fail, as in the baseline.
- [ ] **Step 2: Root-cause** with superpowers:systematic-debugging. Start by reading the fixture setup for `:66` and the pending-lookup SQL. Determine whether citations created by the fixture are excluded by a newer filter or join, such as document_terms or an access/eligibility rule. For SQLITE_BUSY, find the statement still in progress when the transaction commits (an unconsumed result set or `execute` inside `transaction()` on another connection). Write the root cause and the introducing commit (if found) in the report.
- [ ] **Step 3: Fix** the root cause. If the pending definition changed intentionally in a recent commit, show the commit message or doc that says so before changing the test instead.
- [ ] **Step 4: Verify.** Run `node scripts/run-tests.mjs test/catalogueFailures.test.js test/adminWorker.test.js test/server.test.js`. Expected: catalogueFailures 11/11, and no new failures in the other two files beyond their baseline ones.
- [ ] **Step 5: Full suite** (`npm test`), then record the counts and commit.

### Task 2: Theme recompute cluster (cachedDocuments, adminWorker)

**Files:**
- Test: `test/cachedDocuments.test.js:124`, `test/adminWorker.test.js:1887`
- Likely modify: theme recompute code (`grep -rn "recompute.*[Tt]heme\|themes" src/db.js src/services src/metrics.js`)

**Interfaces:**
- Produces: manual theme recompute updates stored themes across documents, and the theme recompute admin job reports progress and refreshes durable themes, as both tests describe.

- [ ] **Step 1: Reproduce** each file alone. Expected: 1 failure each, matching the baseline.
- [ ] **Step 2: Root-cause.** Both tests exercise theme recompute, so expect one shared cause. Identify the exact assertion in each test that fails and why. Note the cause and the introducing commit in the report.
- [ ] **Step 3: Fix** the root cause.
- [ ] **Step 4: Verify.** Run `node scripts/run-tests.mjs test/cachedDocuments.test.js test/adminWorker.test.js test/workbenchRoutes.test.js`. Expected: all pass, except a remaining non-theme baseline failure if Task 1 hasn't fixed it (it will have, since tasks run in order).
- [ ] **Step 5: Full suite**, record counts, commit.

### Task 3: PDF full-text fallback enrichment (syncBatch)

**Files:**
- Test: `test/syncBatch.test.js:482`
- Likely modify: `src/sync.js` and/or `src/pdf.js` (enrichment success accounting)

**Interfaces:**
- Produces: an explicit PDF full-text fallback counts as one successful enrichment in the sync batch stats.

- [ ] **Step 1: Reproduce** with `node scripts/run-tests.mjs test/syncBatch.test.js`. Expected: 1 failure.
- [ ] **Step 2: Root-cause.** Find which counter is 0 and the code path that should increment it. Check recent changes to enrichment accounting and to `ALLOW_ORIGINAL_PDF_RETRIEVAL` / content-policy gating (`run-tests.mjs` sets `ALLOW_ORIGINAL_PDF_RETRIEVAL=1`).
- [ ] **Step 3: Fix.**
- [ ] **Step 4: Verify.** Run `node scripts/run-tests.mjs test/syncBatch.test.js test/enrichmentContinuation.test.js test/enrichmentQueue.test.js test/importContentPolicy.test.js`. Expected: all pass.
- [ ] **Step 5: Full suite**, record counts, commit.

### Task 4: Test isolation (server.test.js) and heap-scaling stability (analyticsScaleMemory)

**Files:**
- Modify: `scripts/run-tests.mjs` and/or `test/server.test.js`
- Test: `test/analyticsScaleMemory.test.js:261`; possibly modify `src/analytics*` / wherever `buildSupervisorNetwork` lives

**Interfaces:**
- Consumes: `scripts/run-tests.mjs` sets one `APP_DATA_DIR`/`SQLITE_PATH` for every concurrently running test file.
- Produces: no two test files can share a SQLite file unless they opt in. `#27` passes reliably.

- [ ] **Step 1: Prove the isolation hypothesis.** Run `npm test` and confirm that `server.test.js:185` fails in the full run but passes alone (it passes alone at baseline). Identify which other file writes pending citations into the shared DB at the same time.
- [ ] **Step 2: Fix isolation structurally,** not just for `server.test.js`. Preferred approach: have every test file that relies on `run-tests.mjs`'s env get its own data dir. Two options: run files with `--test-concurrency=1` (measure the time cost), or switch to a per-file temp dir created in each such file's setup. Pick by measured wall-clock and justify in the report. List which files depended on the shared dir.
- [ ] **Step 3: Heap test.** Run `node scripts/run-tests.mjs test/analyticsScaleMemory.test.js` 5 times and record the ratio each time. If `buildSupervisorNetwork` genuinely holds per-record data (ratio near the record-count ratio of 11.2 every run), fix the code so it really is top-N bounded. If the ratio varies widely between runs, the measurement is noisy: make it robust (e.g. median of several samples, or gc before each sample) without weakening the sub-linear claim. Include the 5 measured ratios in the report.
- [ ] **Step 4: Verify.** Run full `npm test` 3 times. Expected: 411/411 each time. Record the timings.
- [ ] **Step 5: Commit.**
