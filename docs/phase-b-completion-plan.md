# Phase B Completion Plan

**Parent:** #10 (corpus scaling audit rev 2) · **Phase B issues:** #18, #23, #17, #30
**Completion gate (#10):** *Multi-hour run survives an induced DB disconnect and a limiter contention spike.*
**Work branch (this plan):** `claude/phase-b-completion-plan` (based on `v2` = `main` @ `0abbc5f`, which already merged Phase A — PR #36)
**Integration target:** `v2`

**Why this plan re-derives everything from scratch:** the four issues were filed against `v2@58f2c90`. Phase A landed on top of that and rewrote the sync write path — `runSync` now drains a local enrichment queue (`drainLocalEnrichmentQueue`) before ever touching Open Collections, cursor-tracked per rule, instead of rescanning OC every batch. Every file:line in the issues is stale, and the rewrite changes the shape of the problem for at least two of the four issues (see §1). All line numbers below are re-verified against the current tree.

---

## 0. Baseline

- `npm install` was already satisfied (`node_modules` present).
- `npm test` → **226 tests, 221 pass / 5 fail**, ~8.7s. All 5 failures are `test/pdfParser.test.js` cases that shell out to `pdftotext`/`pdfinfo` (poppler-utils not installed in this sandbox) — confirmed by the log lines (`"reason":"pdftotext_unavailable"`) on tests 156/157/160/167/168. Pre-existing environment gap, not a regression; matches the briefing exactly.
- No source or test files were modified for this task. This document and read-only experiments (greps, one blocked `curl`) are the only artifacts produced.

---

## 1. Verified current state, issue by issue

### #18 (N-07) — transient DB error cancels the whole page

**Where it lives now:** `src/sync.js`, inside `runEnrichmentBatch` (lines 237–352), called from both `drainLocalEnrichmentQueue` (357–390, the new Phase-A queue-drain path) and the OC-scan loop (452–543, the pre-existing path). The per-document body inside `mapWithConcurrency`'s callback is lines 252–338:

```js
await saveDocumentMetadata(item.doc, { syncKey, source: item.source });   // :264 — unguarded
pdfAttemptedIds.push(item.doc.id);
totalEnrichmentAttempted += 1;
try {
  await analyzeDocumentFile(item.doc, { ... });                          // :268 — guarded
} catch (error) {
  ...
  const storedFailure = await loadStoredFileMetric(item.doc.id);         // :296 — unguarded, inside the catch
  if (!storedFailure) await saveFileMetric(item.doc.id, { ... });        // :298 — unguarded, inside the catch
  return;
}
await saveDocumentMetadata(item.doc, { syncKey, source: item.source });  // :305 — unguarded
const storedAfterAnalysis = await loadStoredFileMetric(item.doc.id);     // :306 — unguarded
```

`mapWithConcurrency` (144–163) already catches per-worker, but `runEnrichmentBatch` immediately re-throws the first captured error across the whole page:

```js
const processingError = processingResults.find((result) => result?.error)?.error;
if (processingError) throw processingError;   // :339-340
```

That exception propagates out of `runEnrichmentBatch`, out of whichever caller invoked it (`drainLocalEnrichmentQueue`'s `while (true)` loop, or the OC-scan `for` loop), into `runSync`'s outer `try` (438), landing in the outer `catch` (546–573) — which marks the **whole run** `status: 'failed'` via `updateSyncRun` and returns `{ ok: false, ... }`. **This is structurally identical to the issue as filed** — Phase A relocated the code into a shared `runEnrichmentBatch` helper but did not change the try/catch boundary. It is reachable from *both* call sites Phase A created, so the bug did not shrink; it is exercised on every batch, local-queue-sourced or OC-scan-sourced.

**What Phase A changed that matters here:** the *blast radius* of one failure grew in one dimension and shrank in another.
- Shrank: batches are now typically page-sized subsets of `pdfBatchLimit`/`source.pageSize` rather than an entire 50-document rescan-triggering unit, so less redone work per incident than the pre-Phase-A design would have implied.
- Unchanged/still bad: the *run* is still what fails. `drainLocalEnrichmentQueue`'s `while (true)` loop (357) has no per-iteration recovery — one exception exits the loop entirely, discarding whatever batches were still queued locally for this run, not just the one page mid-flight.
- New interaction: `markEnrichmentAttempts` (251) is called durably *before* processing starts, so a document whose batch was aborted is not stuck forever — the next sync attempt (a fresh `attemptedBefore` cutoff) will pick it up again. But it *is* fully redone (including any already-succeeded documents in the same aborted batch), which is wasted work, not correctness risk.

**What actually happens today when the worker process runs this:** `src/worker.js`'s `runOnce` (52–77) calls `runDocumentSync`, which calls `runSync`. `runSync`'s own outer `catch` (546) does **not** rethrow — it returns `{ ok: false, error }`. So a transient DB hiccup does not crash the Node process or the scheduled loop (`main`'s `while (!stopping)` at 123 keeps going on its 60s cadence regardless). The concrete damage is: (a) that one sync run is marked `failed` in `sync_runs`, (b) every document in the batch that was mid-flight when the hiccup hit is discarded and must be fully reprocessed next cycle, and (c) for a `document_sync` admin job (`importPdfJobRunner.js:272-296`) this directly flips the admin job to `status: 'failed'` (line 283); for a multi-rule `import_rules_sync` job, *other rules* in the same job still run (the `for (const rule of rules)` loop at 357 does not break on one rule's `result.ok === false`), but the overall job status is still `perRule.every(item => item.ok)` (439) — one rule's DB hiccup fails the whole job even though the other rules succeeded.

**Cosmetic sub-issue (`docCounts.processed`, line 253):** confirmed still present and unchanged. `processed: attemptedBeforePage + index + 1` uses the `missing` array's pre-assigned position (`nextIndex` at the point `mapWithConcurrency` dispatched that item), not actual completion order — under `contentConcurrency > 1` a later-indexed, faster document can report a higher "processed" count before an earlier-indexed, slower one finishes, so the progress UI's numbers visibly jump backward and forward.

### #23 (N-06) — rate limiter retries CAS 20× with no backoff, then throws

**Where it lives now:** `src/db.js:2662-2701` (`reserveImportRuleRequestSlot`), called from `src/sync.js:206-214` (`countContentRequest`) via the `reserveSlot` hook wired into `createRequestRateLimiter` at `sync.js:201-205`. Confirmed byte-for-byte unchanged in structure from the issue's description — Phase A did not touch this function or its call site at all (it's outside the enrichment-queue rewrite). The loop:

```js
for (let attempt = 0; attempt < 20; attempt += 1) {
  const row = await get('SELECT timestamps_json FROM import_rule_request_limits WHERE rule_id = ?', [ruleId]);
  ...
  const result = row
    ? await run(`UPDATE ... WHERE rule_id = ? AND timestamps_json = ?`, [...])   // CAS
    : await run(`INSERT OR IGNORE INTO ...`, [...]);
  if (result.changes === 1) return 0;
}
throw new Error(`Could not reserve content-request quota for import rule ${ruleId}.`);  // :2700
```

No `wait()` call anywhere in the loop — 20 attempts is 20 back-to-back round trips with zero delay, guaranteeing every contending worker collides on the exact same row read/write cycle. On exhaustion, it throws.

**How the throw becomes a document failure:** `countContentRequest` calls `acquireRuleRequestSlot()` (sync.js:207) unconditionally on any `event.request`. `acquireRuleRequestSlot` is `createRequestRateLimiter`'s returned `acquire` function; its `reserveSlot` branch (117-124) does `const waitMs = await reserveSlot(now()); if (!waitMs) return; await wait(waitMs);` — it expects `reserveSlot` (i.e., `reserveImportRuleRequestSlot`) to *return* a number, never throw. When it throws anyway, the exception is not caught anywhere between `acquireRuleRequestSlot` and `analyzeDocumentFile`'s internals (`pdf.js`'s `fetchJsonWithTimeout`/`fetchTextWithTimeout`/`fetchBytesWithTimeout`, all of which call `onContentRequest` unguarded), so it surfaces as `analyzeDocumentFile`'s rejection, caught by sync.js's per-document `catch` (288-303), which records it exactly like a parse failure: pushed into `enrichmentOutcomes` with `error: error?.message`, counted in `totalEnrichmentFailed`.

**Confirmed consequence for the rollout gate:** `src/services/enrichmentRollout.js:26-59` (`evaluateEnrichmentRun`) computes `completed = outcomes.filter(item => wordCount>0 && pageCount>0 && !item.error)` and `successRate = completed.length / attempted` (38-42), gated against `thresholds.minimumSuccessRate` (default 0.95, `ENRICHMENT_ROLLOUT_DEFAULTS:6`). A limiter-exhaustion error has no distinguishing field today — it is indistinguishable from a genuine bad-PDF failure in this computation, exactly as the issue describes. Confirmed unchanged by Phase A (this file was untouched).

### #17 (H-02) — OC paging is unsorted, no deep-pagination strategy

**Where it lives now:** `src/api.js:72-133` (`fetchPage`). Confirmed: no `sort` parameter, no `search_after`, no PIT/scroll — `grep -c sort src/api.js` still returns 0. `extractHits` (178-201) also confirms the ES-backend shape (`payload.data.hits.total`, `_source`, `_index`) is unchanged.

**What Phase A changed that matters here — and it cuts the opposite way from what you'd hope:** H-03's fix (the local enrichment queue, `drainLocalEnrichmentQueue`) means the OC scan is no longer re-run every batch, but it is **not removed from the hot path** — it is now the *sole discovery mechanism*. Read `runSync`'s dispatch (438-450):

```js
if (enrichmentRequested && !requiredEnrichmentIds.size && await drainLocalEnrichmentQueue(runId)) {
  return await finishSync();
}
// falls through to the OC-scan `for` loop below
```

`drainLocalEnrichmentQueue` returns `false` (falls through to the scan) whenever the *local* queue (`listDocumentsPendingEnrichment`, a query over the `documents`/`file_metrics` tables already in the DB) runs dry — i.e., there is nothing more to enrich among documents the DB already knows about. That happens in exactly two situations: (a) this is the very first sync for a `syncKey` and nothing has been imported yet, or (b) every previously-known document has been enriched and the scan needs to check OC for records added since. In both cases the OC-scan loop (452-543) is what actually pages through Open Collections and is subject to the unsorted-paging skip/duplicate risk — and for `mode: 'import_all'` (the plain metadata sync), the OC scan is the *only* path; `enrichmentRequested` is false so the queue-drain branch is never even entered (line 448's condition short-circuits on `enrichmentRequested`).

Net effect: Phase A made the *symptom* rarer per unit of enrichment work (no rescan every 50 docs) but made the *consequence* of a skip more serious — a document Open Collections' unstable ordering skips during metadata discovery is never written to the `documents` table at all, so the local enrichment queue never sees it either. There is no second chance downstream. #17 is squarely still on the hot path; it is arguably now the single most consequential unfixed issue in this phase, because it gates whether a document enters the corpus in the first place.

**Second problem — the ceiling — has an additional wrinkle beyond the issue's text.** `DOCUMENT_SYNC_SCAN_LIMIT` (`worker.js:21`, default `50_000`) is the scheduled-worker default and is *not* independently clamped for the `/api/admin/documents/sync` or `/api/admin/import-rules/sync` job-creation routes (`adminOperationsRoutes.js:46-70`, `adminImportRoutes.js:237-263`) — those pass `scanLimit`/`syncMaxRecords` straight through with **no clamp attempt at all** (`adminOperationsRoutes.js:56` does `scanLimit: body.scanLimit ?? getQueryValue(...)`, `adminImportRoutes.js:261` does `scanLimit: body.scanLimit` — pure passthrough). Separately, there *is* a dead-letter `parseNumberParam(value, fallback, min, max)` call whose extra `min`/`max` args silently do nothing (`parseNumberParam`'s real signature, `validate.js:1-4`, takes only `(value, fallback)`) — but it lives at `adminImportRoutes.js:205`, inside the unrelated `GET /import-rules/preview` dry-run route, which never starts a sync job. So it is not the mechanism by which the sync job's `scanLimit` goes unclamped; the sync-start routes simply never try to clamp it. Raising the number for `sync_missing_pdfs`/`import_all` job runs themselves needs only `worker.js:21-22`'s default touched (or the caller's request body). **But** `validateMetricsParams` (`validate.js:24-27`) *does* hard-cap `scanLimit` at 50,000 for the metrics/analytics *read* endpoints (`metricsRoutes.js:39,718`), and the admin UI's scan-limit input has `max="50000"` (`public/index.html:651`). Neither of those gates the sync job itself, but both will surface confusing "must be ≤50000" errors or a UI ceiling if an operator later tries to point the *analytics* scan at the same 56k figure. Worth fixing in the same pass for consistency even though it is not strictly on `runSync`'s critical path.

**Unverifiable from this environment, twice over — not once:**
1. **The issue's own flagged unknown** — Elasticsearch's `index.max_result_window` at UBC's actual index. Confirmed still blocked: `curl -sS --max-time 10 https://oc-index.library.ubc.ca` through this session's proxy returns `CONNECT tunnel failed, response 403`. Per this environment's own operating rules, a 403 from the egress proxy is an organization policy denial, not a transient failure — it is not to be retried, and no other network path is available in this sandbox. This is the same block the original audit hit; it does not resolve from here either.
2. **A second, related unknown the issue's text does not separately call out**: whether the UBC wrapper endpoint (`/search/8.5`, a bespoke query-param API — `size`, `from`, `q`, `term`, `source`, `api_key`, no raw Elasticsearch query DSL observed anywhere in `api.js`) accepts a `sort` parameter or `search_after` cursoring *at all*. It may silently ignore unrecognized parameters, may not proxy them to the underlying ES query, or may reject the request. This cannot be checked without a live request against the real endpoint (same 403 block applies), and it is a precondition for the issue's proposed fix, not just a magnitude question. The plan below is designed not to assume the answer either way.

### #30 (M-09) — pending-lookup count is arithmetic on table totals

**This is the one finding in this phase where the issue's own Location/Evidence is simply wrong against the current tree — and appears to have been wrong even at the `v2@58f2c90` filing point, not just stale.** The issue names `countPendingLookups` and quotes this SQL as its body:

```sql
(SELECT COUNT(*) FROM citations)
- (SELECT COUNT(*) FROM catalogue_lookups)
+ (SELECT COUNT(*) FROM catalogue_lookups WHERE hits IS NULL AND query_title IS NOT NULL) AS total
```

That SQL exists verbatim in the current tree — but it is the `pending` field inside **`getCatalogueLookupStats()`** (`src/db.js:3719-3746`, arithmetic at 3727-3736), a *different* function. The actual `countPendingLookups()` (`db.js:3814-3829`) already does exactly what the issue's Proposed Fix asks for:

```sql
SELECT COUNT(*) AS total
FROM citations c
WHERE (
  NOT EXISTS (SELECT 1 FROM catalogue_lookups cl WHERE cl.citation_id = c.id)
  OR EXISTS (
    SELECT 1 FROM catalogue_lookups cl
    WHERE cl.citation_id = c.id AND cl.hits IS NULL AND cl.query_title IS NOT NULL
  )
)
${scope.sql}
```

`git show 58f2c90:src/db.js` confirms this exact `countPendingLookups` body was already present at the audit's own baseline commit, and `git log -S countPendingLookups` traces it to `456a6678` ("Clarify catalogue and import job status"), a commit that predates the entire v2 scaling-audit branch. It also already supports a scoped variant (`syncKey`/`degree`/`program`/`affiliation` via `pendingLookupScope`, `db.js:3773-3786`) — the issue's "consider adding a scoped variant" ask is also already done. `countPendingLookups` is logically equivalent to `listPendingLookups`'s `UNION ALL` (`db.js:3788-3812`) because `catalogue_lookups.citation_id` is declared `INTEGER PRIMARY KEY` (`db.js:346`, one row per citation at most), so "no row exists" and "a row exists satisfying the pending predicate" are mutually exclusive and jointly exhaustive over the two `UNION ALL` arms — the `OR` of `NOT EXISTS`/`EXISTS` produces the same row set the union would produce, just without materializing it.

**The real, live bug is `getCatalogueLookupStats().pending`,** and it matters exactly as much as the issue claims: `adminJobsRoutes.js:1-45` (`GET /api/admin/jobs`) returns `catalogueStats: await getCatalogueLookupStats()`, and `public/app/admin.js:1291,1299` renders `catalogue.pending` directly on the admin dashboard as "**N pending**" — this is the number an operator watches to decide whether/how much scoped resolution to queue. Meanwhile the *actual* scoped-resolution dry-run flow (`adminJobsRoutes.js:56-72`, `POST /api/admin/jobs/catalogue-lookup?dryRun`) already calls the correct `countPendingLookups(scope)` — so the operator-facing dashboard number and the number the resolution job itself trusts can already disagree today, which is the issue's exact concern, just misattributed to the wrong function name.

**#29 interaction, confirmed:** `idx_catalogue_lookups_hits_query_title` (`db.js:580`, added in Phase A / #29) is a composite index on `(hits, query_title)`. `test/citationMatchEquivalence.test.js:457-473` already has an `EXPLAIN QUERY PLAN` test proving `listPendingLookups`'s first `UNION ALL` arm (`WHERE cl.hits IS NULL AND cl.query_title IS NOT NULL`) uses it. That test does **not** cover the second `UNION ALL` arm (`NOT EXISTS`), nor `countPendingLookups`'s combined `OR` predicate, nor (once fixed) `getCatalogueLookupStats`'s reuse of the same predicate. The `citation_id` side of every `EXISTS`/`NOT EXISTS` check is always covered by the table's own `INTEGER PRIMARY KEY`, so no new index is needed — #29's existing index is sufficient; the gap is purely in EXPLAIN-plan test coverage, not schema.

### Per-issue status table

| Issue | Code state (post-Phase-A, this tree) | What Phase A changed | What's still owed |
|---|---|---|---|
| **#18** N-07 | Bug present, verbatim, in the new shared `runEnrichmentBatch` (`sync.js:237-352`), reachable from both the queue-drain and OC-scan call sites | Relocated the code into a helper shared by two callers; reduced per-incident redone work (page-sized, not 50-doc-rescan-sized); did not change the try/catch boundary | Wrap the whole per-document body; classify transient vs. permanent; retry-with-backoff; stop the page-level rethrow from becoming a whole-run failure; fix the cosmetic progress counter |
| **#23** N-06 | Bug present, verbatim, untouched by Phase A (`db.js:2662-2701`) | None — outside the rewrite's scope | Jittered backoff between CAS attempts; return `waitMs` instead of throwing on exhaustion; tag any last-resort throw so `evaluateEnrichmentRun` can exclude it |
| **#17** H-02 | Bug present, verbatim, untouched by Phase A (`api.js:72-133`) | Made the OC scan run less often, but it is now the *only* discovery path for new documents — a skip there is now unrecoverable rather than just rare | Stable sort / `search_after` (contingent on vendor-endpoint support, unverifiable here); raise the ceiling (and its two unrelated but confusable ceilings in `validate.js` / `public/index.html`); `incomplete` vs `completed` reporting |
| **#30** M-09 | `countPendingLookups` (`db.js:3814-3829`) is **already correct** and predates the v2 audit; the arithmetic bug lives in a **different function**, `getCatalogueLookupStats().pending` (`db.js:3719-3746`) | Not touched by Phase A; also not touched by whatever fixed `countPendingLookups` (that predates v2 entirely) | Rewrite `getCatalogueLookupStats().pending` to reuse `countPendingLookups`'s query instead of arithmetic; add EXPLAIN coverage for the arm/predicate #29's existing test doesn't reach |

---

## 2. Plan

### 2.1 — #18: document-scoped vs. run-scoped error handling

**Design decision: two layers, not one.** Rather than hand-rolling retry logic once (inline in `sync.js`) or hoping a single generic wrapper is safe everywhere, split the fix:

**Layer A — retry-with-backoff at the specific `db.js` functions the per-document and per-page bodies call**, not a blanket wrap of the raw libsql client. The functions to wrap are enumerated, not guessed, and each was checked for retry-safety (idempotency under an ambiguous "did the write land before the connection dropped" retry):

| Function | Call shape | Idempotent under retry? |
|---|---|---|
| `saveDocumentMetadata` (813-821) | `client.batch([...])`, `INSERT ... ON CONFLICT DO UPDATE` + a DELETE-then-upsert of `document_people` rows (`metadataPeopleStatements`, `db.js:665-686`) | Yes — the batch is one atomic unit and a full retry always re-runs the same leading DELETE, so a partially-applied prior attempt re-converges; safe to retry as a whole, but note it is *not* a pure single-statement upsert |
| `saveFileMetric` (2114+) | `run()` → `client.execute`, `INSERT ... ON CONFLICT DO UPDATE` | Yes — upsert |
| `loadStoredFileMetric`/`loadStoredFileMetrics` (2077+, 2090+) | `get`/`all` → `client.execute`, pure `SELECT` | Yes — read |
| `markEnrichmentAttempts` (2258-2276) | `client.batch([...])`, `INSERT ... ON CONFLICT DO UPDATE` | Yes — upsert |
| `loadEnrichmentAttempts` (2277+) | `all` → `client.execute`, pure `SELECT` | Yes — read |
| `updateSyncRun` (1787+) | `run()` → `client.execute`, `UPDATE ... WHERE id = ?` | Yes — idempotent by id |
| `reserveImportRuleRequestSlot` (2662-2701) | CAS loop, `UPDATE ... WHERE timestamps_json = ?` | Yes — CAS is retry-safe by construction (see 2.2) |

**Explicitly not wrapped this way:** a blanket wrap of `getDb()`'s returned client (i.e., monkey-patching `.execute`/`.batch` once at construction) was considered and rejected — `db.js` has other `client.batch`/`execute` call sites (711, 860, 2035, 2653, 3104) that were not individually audited for idempotency here (e.g., plain `INSERT INTO citations` statements elsewhere in the citation-matcher path, which is explicitly *not* invoked inline from `runSync` — `analyzeDocumentFile` is always called with `extractCitations: false` at `sync.js:277`). Wrapping only the seven named functions above keeps the retry surface exactly as large as what's been proven safe, and leaves future non-idempotent call sites un-retried by default rather than silently retryable. Note also that most of these seven route through `db.js`'s private `execute()` primitive (`db.js:68-83`); wrapping at the named-function level rather than at that shared primitive is the deliberate, more conservative choice — it keeps the retry boundary at call sites whose idempotency has been individually audited, instead of blanket-retrying every statement that happens to flow through `execute()`.

**One compounding caveat to bound:** `reserveImportRuleRequestSlot` gets *both* Layer A's `withDbRetry` wrap *and* its own internal 20-attempt CAS loop *and* §2.2's new jittered backoff. Under a real network blip during high contention these could multiply (retries × CAS attempts × backoff waits) into a large worst-case latency. `withDbRetry` around this function must therefore treat only true connection/transient errors as retryable (never ordinary CAS exhaustion, which §2.2 converts to a returned `waitMs` rather than a throw), and cap total combined attempts/latency explicitly.

Each wrapped function gets a small shared helper (new, e.g. `withDbRetry(fn, { label })` in `db.js`) that:
- Classifies the caught error via a new, directly unit-testable `classifyDbError(error)` export. Concrete classification, grounded in `@libsql/client`'s actual error shape (`LibsqlError` with a `.code` string — traced in `node_modules/@libsql/core/lib-esm/api.js` and the code-mapping table in `node_modules/@libsql/client/lib-esm/hrana.js:314-338`):
  - **Transient (retry):** `code` in `{HRANA_WEBSOCKET_ERROR, HRANA_CLOSED_ERROR, HRANA_PROTO_ERROR, SERVER_ERROR, INTERNAL_ERROR, UNKNOWN}`, or `code` starting with `SQLITE_BUSY`/`SQLITE_LOCKED`, or no `.code` at all but a message/cause matching `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `fetch failed`, `socket hang up`, `network` (case-insensitive substring match — deliberately generous, since "no code" is exactly what an unclassified network drop looks like from the JS side).
  - **Permanent (fail fast, no retry):** `code` in `{PROTOCOL_VERSION_ERROR, TRANSACTION_CLOSED}`, or starting with `SQLITE_CONSTRAINT`/`SQLITE_MISUSE`/`SQLITE_ERROR` (schema/syntax problems a retry cannot fix), or a `MisuseError`-shaped client error.
  - Anything else defaults to **permanent** (retrying an error you can't positively identify as transient risks masking a real bug as a flaky one).
- Retries only transient errors, jittered exponential backoff (e.g. base 25ms, ×2 per attempt, ±30% jitter, capped attempts — small default like 4, tunable via an env var following the `CITATION_FUZZY_CANDIDATE_LIMIT` precedent from Phase A, e.g. `DB_RETRY_MAX_ATTEMPTS`), then re-throws the last error un-wrapped so the caller's own classification (below) still sees the original shape.

**Layer B — widen the per-document try in `runEnrichmentBatch` to cover the whole body**, and change what happens on catch:

```js
// sketch, not final code
try {
  await saveDocumentMetadata(...);            // now retried internally by Layer A
  pdfAttemptedIds.push(item.doc.id);
  totalEnrichmentAttempted += 1;
  await analyzeDocumentFile(...);             // unchanged; parse failures land here too
  await saveDocumentMetadata(...);
  const storedAfterAnalysis = await loadStoredFileMetric(...);
  ...
} catch (error) {
  // Every error that reaches here — parse failure or DB failure that survived
  // Layer A's retries — is document-scoped. Best-effort durable record, itself
  // retried, but its own failure must not escape this catch.
  totalEnrichmentFailed += 1;
  let recorded = false;
  try {
    const storedFailure = await loadStoredFileMetric(item.doc.id);
    if (!storedFailure) {
      await saveFileMetric(item.doc.id, { status: 'not_found', error: error?.message || String(error) });
    }
    recorded = true;
  } catch (recordError) {
    logger.error('Could not durably record enrichment failure', { docId: item.doc.id, error: recordError.message });
  }
  enrichmentOutcomes.push({ docId: item.doc.id, contentMode, error: error?.message || String(error), recorded });
  // deliberately does not rethrow — this worker resolves normally
}
```

The `if (processingError) throw processingError;` line (339-340) is **kept**, not deleted, as a defense-in-depth safety net — after this fix it should never fire for a document-processing error, since the per-document body no longer lets one escape. If it ever does fire, that is evidence of a genuine unclassified bug, not routine DB flakiness, and *should* still fail the run loudly rather than be silently swallowed.

What legitimately still aborts the run: **page/batch-level** calls outside the per-document loop — `markEnrichmentAttempts` (251) and `updateSyncRun` (387, 534) — after Layer A's retries are exhausted on those too. This is correct, not a bug: if the DB is down long enough that even a handful of backed-off retries on a page-level call fail, the run genuinely cannot make further durable progress, and stopping (with everything committed so far intact, since `updateSyncRun` succeeded after every prior batch) is the right behavior. This preserves the existing outer-catch semantics (`sync.js:546-573`) exactly — the fix only changes what counts as "the run cannot proceed" from "any DB call anywhere" to "a page-level DB call, after retries."

**Cosmetic fix, same pass:** replace the index-derived `docCounts.processed` with a shared, closure-scoped counter incremented at actual completion (success or failure) of each document, not at dispatch. Since `mapWithConcurrency`'s workers are cooperatively scheduled (no true parallelism between `await` points), a plain `let completedInPage = attemptedBeforePage; ... completedInPage += 1;` immediately before emitting the `pdf_document` `completed`/`failed` progress event is race-free and reflects real completion order.

**Tests:**
1. `classifyDbError` unit tests — feed synthetic `{code: '...'}`/plain `Error(...)`/message-only objects covering every bucket in the table above; assert transient/permanent classification per case (this needs no real flaky DB — it's a pure function).
2. `withDbRetry` unit tests — inject a fake operation that fails N times with a transient-shaped error then succeeds; assert it retries exactly enough times, backs off (assert delays are non-zero, non-constant, bounded), and returns the eventual success. A parallel case with a permanent-shaped error asserts zero retries.
3. Extend `test/syncBatch.test.js` (or a new `test/syncReliability.test.js`) with the **DB-disconnect gate harness** (below) exercised against both `drainLocalEnrichmentQueue` and the OC-scan path, since Phase A made both reachable.
4. A dedicated `docCounts.processed` monotonicity test: run `mapWithConcurrency`-driven enrichment over a small batch with artificial per-item delay skew (fast doc at a later index, slow doc at an earlier index) and assert emitted `processed` counts are non-decreasing across the whole page's progress events.

**Gate harness — induced DB disconnect mid-page (design):**

Reuse the established interception pattern already in this codebase (`test/enrichmentQueue.test.js:200-220,261-288`, `test/citationMatchEquivalence.test.js`'s `EXPLAIN QUERY PLAN` tests): `const client = await db.getDb();` returns the *same* singleton `execute()`/`get()`/`run()`/`all()` route through, so monkey-patching `client.execute` intercepts everything except the `client.batch` call sites (`saveDocumentMetadata`, `markEnrichmentAttempts` use `client.batch` directly, per §2.1's table) — the harness must patch **both** `client.execute` and `client.batch`.

```js
// sketch
const client = await db.getDb();
const originalExecute = client.execute.bind(client);
const originalBatch = client.batch.bind(client);
let failuresRemaining = 1;               // exactly one induced failure
const targetDocId = 'doc-under-test-3';  // pick a specific document, not "the Nth call"
client.execute = async (statement, ...rest) => {
  const sql = typeof statement === 'string' ? statement : statement.sql;
  const args = typeof statement === 'string' ? [] : statement.args || [];
  if (failuresRemaining > 0 && /* statement targets targetDocId, e.g. args includes it */) {
    failuresRemaining -= 1;
    const err = new Error('server closed the connection');
    err.code = 'HRANA_CLOSED_ERROR';       // transient shape
    throw err;
  }
  return originalExecute(statement, ...rest);
};
// same wrapper shape for client.batch, matching on the batch array's first statement's args
```

Drive a page of 5–10 documents through `runDocumentSync({ mode: 'sync_missing_pdfs', contentMode: 'full_text_only', contentConcurrency: 4, ... })` with mocked `fetch` (same pattern as `test/syncBatch.test.js`/`test/enrichmentQueue.test.js`) so no real network/PDF parsing is needed for the *other* documents — only the DB layer is under test. Assert, post-fix:
- `result.ok === true` (the run does not fail).
- Every document *other than* `targetDocId` shows up as a normal success in `result.enrichmentOutcomes` (no `error` field) — proving other in-flight documents completed despite the induced failure.
- `targetDocId` has a `file_metrics` row (via `db.loadStoredFileMetric`) with a non-null `error`, OR (if the induced failure was on the *retry-succeeding* path — i.e., `failuresRemaining: 1` and the retry naturally lands on the second, unpatched call) `targetDocId` succeeds normally, proving the retry-then-continue path works. Run both variants: (a) `failuresRemaining: 1` → retry absorbs it, document succeeds; (b) `failuresRemaining` pinned to always-fail-for-this-doc → all retries exhaust, document is durably recorded as **failed**, but the run still completes `ok: true` and every other document still succeeds.
- Before the fix (i.e., run this same harness against a `git stash` of the fix, or keep it as a regression check that currently fails) the harness should reproduce `result.ok === false` with the whole page lost — this is the "prove the test would have caught the bug" step Phase A's methodology insists on (see `docs/phase-a-completion-plan.md`'s repeated "assert the path was reached, not just that the result matched").
- Repeat with `mode: 'import_all'` and the OC-scan path (no queue-drain involved) to prove the fix holds on both of Phase A's call sites, per the interaction question in §3.

### 2.2 — #23: limiter backoff and non-throwing exhaustion

**Primary fix — `reserveImportRuleRequestSlot` (`db.js:2662-2701`) never throws for ordinary contention:**
1. Add jittered backoff between the 20 CAS attempts (same style as Layer A above — a small shared backoff helper, reused rather than reinvented). Make the sleep function injectable (default a real `setTimeout`-based wait) purely for test speed, mirroring `createRequestRateLimiter`'s existing `wait` parameter (`sync.js:102`) — this function currently has no such seam and needs one to be fast to test.
2. On exhausting the attempt budget, **return a wait duration instead of throwing** — reuse the same "next window boundary" computation the function already does on the `timestamps.length >= boundedLimit` branch (line 2681-2682: `Math.max(1, timestamps[0] + windowMs - nowMs)`), since exhaustion after 20 straight collisions is operationally the same situation as "the window is full" from the caller's point of view. `createRequestRateLimiter`'s existing `reserveSlot` loop (`sync.js:118-123`) already handles a returned `waitMs` correctly — no change needed on the calling side once this returns instead of throwing.
3. Keep a **last-resort throw** only for a case backoff+return-waitMs cannot paper over — e.g., the persisted `timestamps_json` is unparseable *and* stays unparseable across every retry (a real data-corruption case, not contention). Tag it: `error.code = 'RATE_LIMIT_STATE_CORRUPT'` (a plain property on the thrown `Error`, not a new class — consistent with how the rest of this codebase throws plain `Error`s with descriptive messages rather than custom error classes).

**Rollout-evaluator side (`src/services/enrichmentRollout.js`):** teach `evaluateEnrichmentRun` to recognize the tagged last-resort error and exclude it from the quality `successRate`, while still surfacing it operationally. Concretely: sync.js's per-document catch (now already widened per §2.1) should record `outcomeKind: error?.code === 'RATE_LIMIT_STATE_CORRUPT' ? 'infra_error' : 'document_error'` (or similar) on the pushed `enrichmentOutcomes` entry, and `evaluateEnrichmentRun`'s `completed`/`attempted` computation (lines 38-42) should be based on `outcomes.filter(o => o.outcomeKind !== 'infra_error')` for the *denominator*, while a new `infraErrors: outcomes.filter(o => o.outcomeKind === 'infra_error').length` field is returned alongside the existing fields so operators can see contention happened without it silently zeroing out the corpus's apparent quality. Given the primary fix (never throw for ordinary contention) should make this path essentially unreachable in practice, this is explicitly a defense-in-depth measure, not the load-bearing fix — call this out in review so it isn't mistaken for "the fix."

**Tests:**
1. Unit test `reserveImportRuleRequestSlot` directly (extending the existing `test/syncBatch.test.js:75-86` "durable per-rule request reservations are atomic across workers" test): run `Promise.all([...8 concurrent calls...])` against one `ruleId`, a low `limit` (e.g. 2), a fixed `nowMs`, and assert (a) **no call throws**, (b) exactly `limit` calls return `0` (acquired) and the rest return a positive `waitMs`, (c) with an injected fast/no-op test `wait`, count actual `client.execute` round trips via the statement-counting pattern (`test/enrichmentQueue.test.js:200-220`) before vs. after adding backoff — backoff should reduce the *worst-case* attempts any single caller needs by spreading collisions in time, which should be visible as fewer total statements for the same contention level once jitter avoids repeated lockstep collisions. This directly answers the issue's "backoff actually reduces CAS round-trips" ask with a concrete, countable metric rather than a wall-clock proxy.
2. A "state corruption never resolves" test forcing the last-resort throw path, asserting the thrown error carries `code: 'RATE_LIMIT_STATE_CORRUPT'`.
3. `evaluateEnrichmentRun` unit test: an outcomes array where every entry has `error` but is tagged `infra_error` should still pass `checks.successRate` (i.e., not divide by a denominator that counts infra noise as quality failures) while a mixed array of real parse failures still fails the check as before.

**Gate harness — limiter contention spike at `contentConcurrency: 8` (design):**

The issue's literal ask ("cohort at `contentConcurrency: 8` with a low `contentRateLimit`") is tested at two levels because the two behaviors it exercises resolve on different real-time scales:

- **CAS-contention backoff** (new behavior from the primary fix): 8 workers racing to update *the same rule's* `timestamps_json` row. This resolves in milliseconds even with real timers (a handful of workers, a handful of retries, tens-of-ms backoff) — no new plumbing needed, run it for real.
- **Legitimate rate-limit waiting** (existing, correct behavior — `sync.js:118-123`'s `while(true) { waitMs = await reserveSlot(...); await wait(waitMs); }`): under the default `windowMs = 60_000` (hardcoded in `reserveImportRuleRequestSlot`'s signature and not currently threaded through from `runDocumentSync`'s public options), a "low `contentRateLimit`" scenario with 8 concurrent workers would force some workers to wait up to a real 60 seconds — unacceptable for a fast test suite (current full suite is ~8.7s).

  **Required small option-surface addition, not just a test change:** thread an optional `contentRateWindowMs` (default `60_000`, preserving current behavior) from `runDocumentSync`'s public options → `runSync` → `createRequestRateLimiter`'s `reserveSlot` closure → `reserveImportRuleRequestSlot`'s `windowMs` parameter (which already exists and already defaults to `60_000` — it is simply never overridden today). This is a minimal, additive, backward-compatible change in the same spirit as the `pdfBatchSize`/`enrichmentCursor` options Phase A already added for testability. With e.g. `contentRateWindowMs: 200`, a "low `contentRateLimit: 2`" scenario with 8 concurrent workers resolves in well under a second of real wall-clock time while still genuinely exercising the wait-and-retry path.

```js
// sketch
const result = await runDocumentSync({
  mode: 'sync_missing_pdfs',
  contentMode: 'full_text_only',
  contentConcurrency: 8,
  contentRateLimit: 2,
  contentRateWindowMs: 200,     // new option; keeps the test fast
  importRuleId: rule.id,        // required: reserveImportRuleRequestSlot needs a durable ruleId
  ...
});
assert.equal(result.ok, true);
assert.equal(result.totalEnrichmentFailed, 0, 'no document should fail purely from limiter contention');
assert.ok(!result.enrichmentOutcomes.some((o) => /reserve content-request quota/.test(o.error || '')));
```

Seed enough documents (e.g. 20-30) that with `contentConcurrency: 8` and `contentRateLimit: 2` per 200ms window, genuine queuing is unavoidable — the test is only meaningful if contention actually happens, not just is theoretically possible; assert on `requestCounts`/timing that the run took measurably longer than an unthrottled run of the same size, as a sanity check that the rate limit was actually engaged rather than trivially satisfied.

### 2.3 — #17: stable ordering and a real deep-pagination story

**Because whether the vendor endpoint supports `sort`/`search_after` at all is unverifiable from this environment (§1), the plan specifies two tracks rather than committing to one:**

**Track 1 (do first, unconditionally — no dependency on the unverifiable fact):**
- Raise the OC-scan ceiling above 56,000: change `worker.js:21-22`'s default from `50_000` and confirm nothing else silently reclamps a `document_sync`/`import_rules_sync` job's `scanLimit` (confirmed today: nothing does — `adminOperationsRoutes.js`/`adminImportRoutes.js`'s sync-start routes pass it through unclamped; only `validateMetricsParams`, `validate.js:24-27`, and the unrelated read-side `metricsRoutes.js` endpoints cap at 50,000). Fix `validate.js`'s hard cap and `public/index.html:651`'s UI `max="50000"` in the same change so an operator raising the number doesn't hit a confusing, unrelated ceiling on the *analytics* side while trying to raise the *sync* side.
- Replace the binary `completed`/nothing status with an explicit `incomplete` status: `runSync`'s `finishSync()` (392-436) already tracks `upstreamExhausted` and reconciles `totalSeen` against `apiTotal` (536: `if (apiTotal !== null && totalSeen >= apiTotal) { upstreamExhausted = true; break; }`) — extend `updateSyncRun`'s final `status` write (currently a hardcoded `'completed'` at line 394) to `totalSeen === apiTotal ? 'completed' : (upstreamExhausted ? 'incomplete' : 'completed')`, i.e., a scan that broke out of the loop without ever confirming `totalSeen >= apiTotal` (hit `scanLimit`, hit `maxRecords`, or the API stopped returning docs before `apiTotal` was reached) reports `incomplete`, not `completed`. This directly satisfies the issue's second verification bullet without depending on the sort/search_after question at all.
- Add a lightweight **overlap/gap detector as a standing safety net regardless of what the sort investigation concludes**: track a running `Set` (or, at 56k scale, a bounded probabilistic structure / a `seen_doc_ids` table keyed by `syncKey` — see cost note below) of doc IDs seen so far *within a single scan pass* and log (not fail) when a page returns an ID already seen this pass, or when `totalSeen` reaches `apiTotal` but the actually-distinct ID count is lower. This makes silent skip/duplicate — the failure mode #17 is fundamentally about — observable in production even before the ordering fix lands, and remains valuable afterward as a regression detector. Cost note: 56k IDs as strings is a few MB in memory, trivial for a single scan's lifetime; do not persist this set beyond one run.

**Track 2 (contingent on confirming the vendor endpoint's capability — flag as a spike, not assumed):**
- **If `/search/8.5` supports a `sort` query param that reaches the underlying ES query:** add an explicit stable sort on a unique field (the OC handle-shaped `id`, already used pervasively as the corpus's natural key — `normalizeRecord`/`buildDocumentSyncKey` already treat it as authoritative). Prefer switching `from` to `search_after` if the endpoint round-trips a `sort`/cursor value on each hit (would need `extractHits`, `api.js:178-201`, to stop discarding `hit.sort` when it maps `hit._source` — currently only `hit._index` survives the mapping via `__oc_index`); `fetchPage` would then need to accept and forward a `searchAfter` cursor parameter, and `runSync`'s scan loop (452-543) would track it in place of (or alongside) the `from` counter.
- **If the endpoint does not support `search_after`/raw ES query DSL (plausible, given the observed API surface is a curated subset):** fall back to stable `from`-based paging *bounded to whatever the real `max_result_window` turns out to be* (not a guessed number — see below), combined with the Track-1 overlap detector as the actual correctness backstop rather than a nice-to-have. A `from`-only fallback cannot fully eliminate tie-break drift on its own if the endpoint gives no sort control at all — this needs to be surfaced to whoever confirms the endpoint's capability as an open risk, not silently accepted.
- **Either way, do not hardcode a guessed `max_result_window`.** Make the effective scan ceiling for one page-advance loop configurable and probe-based: on a page request that comes back with an explicit deep-pagination rejection (a specific HTTP status/error body shape — to be identified once the endpoint can actually be reached, e.g. by whoever has non-sandboxed access to `oc-index.library.ubc.ca`, or from UBC's own API documentation if published), treat it as "scan truncated at N" and report `incomplete` with the truncation point recorded, rather than crashing or silently stopping. This makes the design correct whether the real ceiling turns out to be 10,000 (ES default), higher (a raised UBC-side setting), or effectively absent (a proxy/wrapper that itself paginates around the ES limit).

**Tests:**
1. `fetchPage` unit tests (extending `test/apiKeyTransport.test.js`'s mocked-`fetch` pattern): once Track 2 lands, assert the request includes whatever sort/cursor parameter was determined to be supported; until then, assert `fetchPage` at minimum still works unchanged (regression safety) and add a test asserting the *absence* of `sort` is a known, tracked gap (a `TODO`-linked failing-by-design test is not appropriate here — instead, gate the “sort added” tests behind the Track-2 spike’s outcome).
2. `incomplete` vs `completed` status test: drive `runDocumentSync` with a `scanLimit`/`maxRecords` set below a mocked `apiTotal` (this pattern already exists for `pdfBatchLimitReached` in `test/syncBatch.test.js:219-231`, "scanLimited... `enrichmentExhausted === false`" — extend it to also assert the persisted `sync_runs.status` is `'incomplete'`, via `db.getLatestSyncRun`), and a companion test where the mocked upstream is fully exhausted (`totalSeen >= apiTotal`) asserting `status === 'completed'`.
3. Overlap-detector test: mock `fetch` to return an overlapping ID across two sequential pages (simulating an ES tie-break shift) and assert the detector logs/flags it — this proves the detector actually catches the exact failure mode #17 describes, independent of whether Track 2's real fix has landed.
4. **The issue's literal verification ("two full scans return an identical set of document IDs")** is only meaningfully testable end-to-end once Track 2's outcome is known; document this dependency explicitly in the definition-of-done (§3) rather than papering over it with a test against a mock that can't reproduce real ES tie-break behavior. In the interim, a mock-`fetch` test that *simulates* unstable relevance-score ordering (returns hits in a different order across two calls for the same unsorted `from` window, drawn from a fixed pool with deliberately duplicated/skipped boundary IDs) can prove the code changes handle instability *if* it is fed to them — a meaningful regression test even before the real endpoint's behavior is confirmed.

### 2.4 — #30: fix the actual arithmetic, not the already-correct function

**Fix:** rewrite `getCatalogueLookupStats()`'s `pending` field (`db.js:3719-3746`) to stop computing arithmetic on table totals and instead reuse `countPendingLookups()`'s query — either by having `getCatalogueLookupStats` call `countPendingLookups()` directly (simplest; one extra query but this endpoint is not on any hot per-document path — it's an admin-dashboard summary hit once per page load) or by folding the same `NOT EXISTS OR EXISTS(...)` subquery into `getCatalogueLookupStats`'s single combined `SELECT` (marginally fewer round trips, more duplication). Given this function is not called per-document anywhere (only from `adminOperationsRoutes.js:136` and `adminJobsRoutes.js:38`, both admin-page-load paths), prefer the simpler "call `countPendingLookups()`" version — it makes the two numbers structurally unable to disagree, which is the actual point of the issue, rather than merely computing the same thing twice in parallel.

Leave `countPendingLookups()` itself untouched — it is already correct.

**Tests:**
1. Direct equivalence test: seed a `citations`/`catalogue_lookups` fixture including the partial-delete scenario the issue calls out by name ("including after a partial citation delete" — delete a citation row that a `catalogue_lookups` row still references, or vice versa, so the two tables are no longer a strict subset relationship), then assert `(await getCatalogueLookupStats()).pending === await countPendingLookups()` and both equal `(await listPendingLookups({ limit: 100000 })).length` for a corpus small enough to enumerate exhaustively. This is the issue's literal verification criterion, run against the *actual* broken function once fixed.
2. A regression test pinning the pre-fix failure mode concretely: construct a fixture where the old arithmetic (`COUNT(citations) - COUNT(catalogue_lookups) + COUNT(pending-shaped rows)`) would go negative or over/under-count relative to `listPendingLookups`'s real predicate (e.g., delete a `citations` row whose `catalogue_lookups` row survives, orphaning it), and assert the fixed `getCatalogueLookupStats().pending` still matches `listPendingLookups`'s count under that fixture, unlike the arithmetic version would have.
3. Extend `test/citationMatchEquivalence.test.js`'s existing `EXPLAIN QUERY PLAN` coverage (457-473, currently only the first `UNION ALL` arm) with two more assertions: the second arm's `NOT EXISTS` shape, and `countPendingLookups`'s combined `OR` predicate (which, once `getCatalogueLookupStats` is rewritten to call it, is the query actually running on every admin dashboard load) — confirm neither regresses to a full table scan given `idx_catalogue_lookups_hits_query_title` and `catalogue_lookups`'s `citation_id INTEGER PRIMARY KEY`.

This issue has no dependency on the two gate scenarios (#18/#23) and can land independently and first — see §3.

---

## 3. Cross-cutting design questions

**What counts as "transient" vs. "run-scoped," concretely?** Answered in §2.1's table: transient is a specific, named set of `LibsqlError` `.code` values plus a small set of Node-level network-error message substrings, checked by one exported, directly unit-testable `classifyDbError`. Run-scoped is not a *kind* of error at all under this design — it's a *location*: any error (of any classification) surviving Layer A's retries at the **page/batch level** (`markEnrichmentAttempts`, `updateSyncRun`) is run-scoped by virtue of where it occurred, not what it is; the same error occurring inside the **per-document** body is document-scoped by the same logic. This avoids needing a third "sometimes run-scoped" bucket.

**Does #18's whole-body-wrap interact with Phase-A's queue-drain structure?** Yes, in one specific way worth calling out for review: `drainLocalEnrichmentQueue`'s `while (true)` loop (357-390) has no page-level try/catch of its own today — a page-level failure (post-Layer-A-retries) still propagates out of the whole loop, aborting the run at the `drainLocalEnrichmentQueue` call site rather than continuing to try the *next* local-queue page. This is the correct behavior per the design above (page-level failures are legitimately run-scoped), but it means #18's fix does *not* make the local-queue-drain loop itself resilient to a sustained (not transient) DB outage mid-drain — nor should it try to be; a sustained outage there means the run truly cannot make progress. Document this explicitly so nobody mistakes "documents within a page are now isolated from each other" for "pages within a queue-drain are now isolated from each other" — they are deliberately not.

**Does #17's `search_after` question interact with the queue-drain design?** Yes — established in §1's `runSync` dispatch reading: the OC scan is not obsoleted by the local queue, it is the queue's sole feed mechanism, reached whenever the local queue reports nothing outstanding. Any #17 fix therefore benefits every mode, not just `import_all` — a stable, correctly-bounded OC scan is a precondition for the local-queue design to ever see the full 56k corpus in the first place, not an independent, lower-priority concern.

**Can #30's fix reuse #29's index?** Yes, confirmed directly (§1): `idx_catalogue_lookups_hits_query_title (hits, query_title)` already covers the filter half of every query in play, and `catalogue_lookups.citation_id INTEGER PRIMARY KEY` covers the join/exists half natively. No new index needed; the gap is EXPLAIN-plan test coverage, not schema, and is folded into §2.4's test list.

**Idempotency of Layer A's blind retries (§2.1) is load-bearing, not incidental.** All seven wrapped functions were individually confirmed to be either pure reads, primary-key-scoped `UPDATE`s, or `ON CONFLICT DO UPDATE` upserts — retrying any of them after an ambiguous "did it commit" failure is safe because reapplying produces the same end state. This is deliberately *not* generalized to "retry every DB write in the app" (§2.1's rejected-alternative note) — a future contributor adding a plain, non-upserting `INSERT` to one of these seven functions would silently break this guarantee, so a one-line comment at each wrap site should say so.

---

## 4. Sequencing, risks, definition of done

**Sequencing.** #30 has zero dependency on the other three and is the smallest, safest change — land it first as a quick, low-risk win and to free up review bandwidth for the harder items. #18 and #23 are independent of each other (different files, different call sites) and can proceed in parallel once the shared `classifyDbError`/backoff-helper groundwork from #18's Layer A exists (§2.2's limiter backoff should reuse that helper rather than reimplementing jittered backoff a second time — sequence #18's Layer A helper slightly ahead of, or alongside, #23's use of it). #17 is the least certain in scope (Track 2 depends on an external, currently-unconfirmable fact) — land Track 1 (ceiling raise, `incomplete` status, overlap detector) on its own schedule regardless of the Track 2 spike's outcome, since Track 1 delivers real value and has zero external dependency.

**Top risks.**
- **The #17 vendor-capability question is the single largest unresolved risk in this phase** and is explicitly out of this plan's power to close from this sandbox. The plan is structured so Track 1 ships value independent of the answer, and Track 2's two branches (`sort` supported / not supported) are both specified so neither answer blocks indefinitely — but until someone with real network access to `oc-index.library.ubc.ca` (or UBC-side documentation) confirms the endpoint's actual parameter surface, the issue's literal end-to-end verification ("two full scans return an identical set of IDs" against the *real* API) cannot be executed, only approximated with a mock that encodes an assumption about ES tie-break behavior.
- **Retry-on-write safety is scoped, not proven exhaustively.** §2.1/§3's idempotency table covers exactly the seven functions in this phase's hot path. If a future change adds a new call site to one of the wrapped functions, or wraps an eighth function without re-checking idempotency, the safety argument silently stops holding. Worth a lint-adjacent convention (a comment marker, checked in review) rather than automated enforcement, since there's no idempotency-detection tooling in this stack.
- **The `contentRateWindowMs` option addition (§2.2) is a real, if small, public-API surface change** to `runDocumentSync`. It defaults to preserving current behavior (`60_000`), but it should be reviewed as a genuine (if minor) production code change motivated by testability, not waved through as "just test infrastructure."
- **#18's fix changes what "the job failed" means for `document_sync`/`import_rules_sync` admin jobs** (§1: a `document_sync` job that previously failed outright on one transient hiccup will now more often report `ok: true` with some documents durably recorded as failed instead). This is the intended, correct behavior per the Step 6 contract, but it changes operator-visible job outcomes and should be called out in review/changelog, not just in test diffs — an operator watching for job failures as their alerting signal needs to instead watch `totalEnrichmentFailed`/`enrichmentOutcomes` counts.
- **Mutation-testing-style acceptance (Phase A's 1c) is not proposed here** because, unlike #11's citation matcher, these fixes are primarily about control flow (what happens on error) rather than a scoring/matching algorithm with subtle branches — the gate harnesses in §2.1/§2.2 (assert the *unfixed* code fails the harness, then assert the fix passes it) serve the same "prove the test would have caught the bug" purpose Phase A's mutation testing served for #11.

**Definition of done.**

| Issue | Verification evidence required to close | Maps to gate scenario |
|---|---|---|
| #18 | `classifyDbError`/`withDbRetry` unit tests; DB-disconnect gate harness passes on both queue-drain and OC-scan call sites, in both "retry absorbs it" and "retries exhaust, document recorded failed" variants, proven to fail on pre-fix code; `docCounts.processed` monotonicity test | **Gate 1** (induced DB disconnect) |
| #23 | `reserveImportRuleRequestSlot` never throws under concurrent contention (unit test); backoff measurably reduces CAS round trips; last-resort throw is tagged and excluded by `evaluateEnrichmentRun`; end-to-end `contentConcurrency: 8` / low-`contentRateLimit` run reports zero limiter-caused document failures | **Gate 2** (limiter contention spike) |
| #17 | Track 1 shipped and tested (ceiling raise + consistency across the three ceilings found; `incomplete`/`completed` distinction tested both ways; overlap detector tested against a simulated unstable-order mock); Track 2's vendor-capability spike result recorded (whichever branch it resolves to) with its corresponding fix tested; the issue's literal real-API verification explicitly flagged as blocked pending external access, not silently marked done | Neither gate directly (#17 is a correctness issue, not a resilience-under-fault issue) — supports the gate's *spirit* ("multi-hour run") by ensuring a long scan doesn't quietly corrupt its own dataset |
| #30 | `getCatalogueLookupStats().pending === countPendingLookups() === listPendingLookups(...).length` including after a partial delete; EXPLAIN coverage extended to the previously-untested arm/predicate | Neither gate — independent correctness fix |
| **Gate (#10)** | A harness (new, e.g. `scripts/phase-b-reliability-gate.mjs`, mirroring `scripts/phase-a-scale-gate.mjs`'s structure) that runs a multi-hour-scale (or accelerated-clock-equivalent) synthetic sync with both an injected mid-run DB disconnect (§2.1's harness, at production-realistic scale rather than a 5-10 doc unit test) and a genuine limiter contention spike (§2.2's harness, at `contentConcurrency: 8`) in the same run, asserting the run completes with `ok: true`, zero run-level failures attributable to either induced condition, and every affected document either succeeded via retry or is durably recorded as failed | **Both gates, combined, at scale** — this is the literal #10 completion artifact, analogous to `docs/phase-a-gate-results.md` |

---

## 5. Path from this plan to `v2`

1. Land #30 first (§2.4) — smallest, no dependency, immediate correctness win for the live admin dashboard number.
2. Land #18's Layer A (`classifyDbError`, `withDbRetry`, the seven wrapped functions) and Layer B (widened per-document try/catch, cosmetic counter fix) together, since Layer B's tests depend on Layer A existing.
3. Land #23, reusing #18's backoff helper rather than reimplementing it; land the `evaluateEnrichmentRun` tagging change in the same PR since it's small and directly tied to the same throw path.
4. Run the #18 and #23 gate harnesses individually first (§2.1/§2.2), confirm both pass, *then* combine them into the single multi-hour-scale `scripts/phase-b-reliability-gate.mjs` harness for the literal #10 sign-off, following `scripts/phase-a-scale-gate.mjs` / `docs/phase-a-gate-results.md`'s precedent for how that evidence gets captured and reported.
5. Land #17 Track 1 on its own schedule (no dependency on 2-4). Flag Track 2 as blocked pending external vendor-capability confirmation; do not merge a `search_after` implementation whose correctness rests on an unverified assumption about the endpoint — ship Track 1's overlap detector and `incomplete` reporting as the interim safety net, and revisit Track 2 once someone can reach the real endpoint.
6. Open a PR from this work into `v2`, linking #18/#23/#17/#30, the two gate harnesses, and the combined #10 gate measurement (a `docs/phase-b-gate-results.md` companion to this plan, produced once the harnesses are built and run — out of scope for this planning pass itself).
7. `v2` review should specifically re-run the "prove the test fails on pre-fix code" step for #18 and #23's gate harnesses (the same "green but unverified" risk Phase A's own retrospective flagged for itself), and should explicitly sign off on the #17 Track 2 decision (which branch was taken, and why) given it rests on an assumption this plan could not verify.

---

## Critical files

- `src/sync.js` — `runSync` (165-577), `runEnrichmentBatch` (237-352, the #18 fix site), `drainLocalEnrichmentQueue` (357-390), `mapWithConcurrency` (144-163), `createRequestRateLimiter` (99-142), `countContentRequest` (206-214, the #23 call site), OC-scan loop (452-543, the #17 hot-path confirmation)
- `src/db.js` — `reserveImportRuleRequestSlot` (2662-2701, the #23 fix site), `execute`/`run`/`get`/`all` (68-86), `saveDocumentMetadata` (813-821), `saveFileMetric` (2114+), `loadStoredFileMetric`/`loadStoredFileMetrics` (2077+, 2090+), `markEnrichmentAttempts`/`loadEnrichmentAttempts` (2258-2276, 2277+), `updateSyncRun` (1787+) — all seven are the #18 Layer-A retry-wrap targets; `getCatalogueLookupStats` (3719-3746, the #30 fix site), `countPendingLookups` (3814-3829, already correct, do not touch), `listPendingLookups` (3788-3812), `idx_catalogue_lookups_hits_query_title` (580)
- `src/api.js` — `fetchPage` (72-133, the #17 fix site), `extractHits` (178-201)
- `src/services/enrichmentRollout.js` — `evaluateEnrichmentRun` (26-, the #23 rollout-gate interaction)
- `src/services/importPdfJobRunner.js` — `runImportPdfAdminJob` (268-500, shows how a `runSync` failure surfaces at the admin-job level for both `document_sync` and multi-rule `import_rules_sync`)
- `src/worker.js` — `syncOptions`/`runOnce` (14-77, the #17 scan-limit default and the confirmation that a failed `runDocumentSync` does not crash the scheduled loop)
- `src/validate.js`, `public/index.html:651`, `src/routes/adminImportRoutes.js:205` — the three separate, easily-confused scan-limit ceilings found while investigating #17
- `test/enrichmentQueue.test.js`, `test/syncBatch.test.js`, `test/citationMatchEquivalence.test.js`, `test/apiKeyTransport.test.js` — existing test patterns this plan's new tests extend (client interception, fetch mocking, EXPLAIN QUERY PLAN, rate-limiter DI)
- `docs/scaling-architecture-plan.md:229` — the Step 6 contract text #18 is verified against
- `docs/phase-a-completion-plan.md`, `docs/phase-a-gate-results.md` — house style and rigor bar this plan follows
