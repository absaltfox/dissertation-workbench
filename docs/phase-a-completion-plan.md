# Phase A Completion Plan

**Parent:** #10 (corpus scaling audit rev 2) · **Phase A issues:** #11, #12, #16, #19, #29
**Completion gate (#10):** *Per-document cost flat across a 5,000-document run.*
**Work branch (Phase A code):** `claude/ubc-dissertations-parser-review-krgyee` (9 commits ahead of `v2` @ `58f2c90`, tip `ad332dd`)
**Integration target:** `v2`

---

## 1. Verified current state

Assessed against the actual code on `claude/ubc-dissertations-parser-review-krgyee` in a disposable worktree; test suite run there.

- **Branch topology confirmed.** Exactly 9 commits ahead of `v2` (merge-base `58f2c90`), tip `ad332dd`.
- **Test suite: 210 tests, 205 pass / 5 fail.** All 5 failures are `test/pdfParser.test.js` cases requiring `pdftotext`/`pdfinfo` (poppler-utils) which is not installed in the sandbox — an environment gap, not a Phase A regression. Full run ~8.5–8.9s.
- **Test-runtime anomaly resolved.** The fd7e6de "~141s" report does not reproduce; current runtime is ~8.5s, consistent with 65b93b5's "~7s". No root-causing needed.
- **`enrichmentPolicySatisfiedSql` vs `hasCachedEnrichmentMetric` parity is already tested** — `test/enrichmentQueue.test.js:70-120` cross-checks both over 5 content modes × 3 fallbacks × 16 row shapes (240 comparisons), including the full_text fallback ordering-quirk rows (lines 44-48). This was flagged as an open unknown but is in fact already resolved.

### Per-issue status

| Issue | Code state | What is still owed |
|---|---|---|
| **#11** B-01 citation matcher | Round 1 (SQL exact+fuzzy, no full-scan fallback) + `ad332dd` cap→2000 + `(prefix, year)` bucket narrowing + refuse-on-saturation — **defect-2 fixtures unwired** | Wire fixtures; test saturation path; mutation-testing acceptance; record design decision |
| **#12** B-02 orphan sweeps | Removed from per-doc path; correctness well tested (`test/catalogueFailures.test.js:151-229`) | Flat-cost (not just correctness) measurement; note operational gap below |
| **#16** H-03 enrichment restart | Structurally done: `drainLocalEnrichmentQueue` returns before OC scan; `enrichmentCursors` = one cursor/rule; `skipPdfDocIds` deleted on migration | Measurements never run: batch-20 vs batch-1, constant `params_json`; `startContinuationJob` has **zero test coverage** |
| **#19** H-05 serial round-trips | `documentsExist`/`loadStoredFileMetrics` batch helpers; unit-tested individually | Statement-count assertion on the full `sync_missing_pdfs` path (not just `filterSyncItemsForMode`) |
| **#29** M-06 indexes | Index set added; harmful `idx_documents_sync_key_doc_id` dropped | `EXPLAIN QUERY PLAN` coverage — only the citation fuzzy query has it today |

### Confirmed defect (the smoking gun for #11)

`test/citationMatchEquivalence.test.js:188-221` defines five fixture groups (`OKONKWO_*`, `RAVINDRAN_*`, `NAKAMURA_*`, `SANDOVAL_*`, `PEMBERTON_*`) explicitly built to force the matcher past the phase-1 short circuit into the ±1 veto / tie-break logic — but **none of these constants are referenced anywhere else in the file.** They are dead code, exactly matching `ad332dd`'s "stopped partway through writing the extended test fixtures." No test exercises the saturation/refuse path at all (`counts.truncatedBuckets`, `counts.truncationBlockedMerges`, the `refuse()` branches). `FUZZY_CANDIDATE_LIMIT` (db.js:3029) is a hardcoded `2000`, not injectable, so saturation cannot be cheaply forced in a test today.

### Gate status

No issue has an executed measurement at 5,000-document scale. The gate is **unverified end-to-end**, though the mechanisms (SQL-pushed matching, scoped orphan collection, local enrichment queue, batched existence checks, new indexes) are architecturally consistent with flat per-document cost. This plan closes the gap between "should be flat" and "measured flat."

---

## 2. Plan

### Phase 1 — Finish #11 (blocking; lands before anything else)

**1a. Wire the dead fixtures into a real test (defect 2).**
In `test/citationMatchEquivalence.test.js`, add a test that runs `db.saveCitations` over documents built from the `OKONKWO_*`/`RAVINDRAN_*`/`NAKAMURA_*`/`SANDOVAL_*`/`PEMBERTON_*` fixtures — seed the "established" rows first, then the probe — and assert the exact outcome each comment documents (e.g. `OKONKWO_PROBE` lands as a *new* citation because the ±1 veto fires; `PEMBERTON_PROBE` merges into 2001 and is not vetoed by a 1999 row two years away; the `SANDOVAL` tie-break picks the lower id). Add branch-hit counting (module counter or the `findFuzzyMatch(text, year, telemetry)` hook) and assert the ±1 veto branches fire ≥1 time — otherwise the test can silently regress to "green but decided by phase 1," which is exactly how this gap escaped before.

**1b. Make the cap testable (defect 1, saturation path).**
`FUZZY_CANDIDATE_LIMIT` is hardcoded. Add a test-only override following the existing `CONCEPT_MAX_BUCKET_COMPARISONS` env-var precedent (`test/adminWorker.test.js:990-1029`): `Number(process.env.CITATION_FUZZY_CANDIDATE_LIMIT) || 2000` at module load, so a test can force saturation cheaply (seed 6 rows against a limit of 5, not 2000 real rows). Then assert: (i) a saturated bucket increments `counts.truncatedBuckets`, triggers `refuse()`, increments `counts.truncationBlockedMerges`, and produces no merge and no *wrong* merge; (ii) a non-saturated corpus leaves both counters at 0.

**1c. Mutation-testing acceptance procedure.**
Apply each mutation to `findFuzzyMatch` (db.js:3237-3293), run the Phase-1 suite, confirm it now FAILS, then revert. Record pass/fail per mutation as the evidence artifact for #11:
1. **Delete the ±1 veto** — remove the `adjacent` bucket load and the `before.maxSim === overall` / `after.maxSim === overall` returns (~3279-3291).
2. **Flip the tie-break** — `sim > maxSim` → `sim >= maxSim` (line 3177), or reorder the before/sameYear/after decision (~3289-3292) so the last-checked bucket wins ties.
3. **Widen the window to ±2** — extend `loadCandidateBuckets` (~3279) to fold in `year ± 2`.
4. **Remove the saturation-refuse guards** — delete `if (acceptable.saturated.size) return refuse();` (3277) and `if (adjacent.saturated.size) return refuse();` (3284).

**1d. Design decision: keep cap+saturation-counter; do NOT eliminate the cap.**
Rationale:
- The `(prefix, year)` bucket narrowing (db.js:3203-3230) is the real fix — it shrinks the bucket space so hitting 2000 rows in one cell requires a pathological concentration unlikely in real bibliographic data well beyond 5,000 docs.
- Refuse-on-saturation is a safety property, not just telemetry: by construction it can only turn a would-be merge into a *new* citation (lost merge), never invent a merge or drop a veto the old algorithm wouldn't also drop from the same complete candidate set.
- A "provably never truncates" alternative (no cap / exhaustive pagination) reintroduces unbounded per-document cost for the pathological corpus — the exact regression Phase A removes.
- **Action item (non-blocking):** wire `truncatedBuckets` / `truncationBlockedMerges` (surfaced in `public/app/admin.js:1258-1259`) into operational alerting so a non-zero production count prompts widening buckets, not silent data-quality loss.
- **Residual design note to pin with a test:** prefix-narrowing the *dated* arms is a genuine behavior change from the pre-Phase-A matcher (which compared dated citations against the whole same/adjacent-year bucket regardless of prefix), even when the cap never binds. The code comment (db.js:3213-3218) argues Winkler's prefix bonus makes a same-prefix candidate favored anyway. Add one test pinning this trade-off — two citations differing only in their first 3 characters (e.g. an OCR-misread initial letter), same year, otherwise identical — so the accepted change is pinned, not implicit.

### Phase 2 — Verification harnesses for #12, #16, #19, #29 (parallelizable after Phase 1 lands)

- **#12** — Extend `test/catalogueFailures.test.js` (or add a perf test): create N documents (a few hundred suffices for a unit test), re-extract document `k` for increasing `k`, assert per-re-extraction cost (row-touch/statement count preferred over raw wall-clock) does not grow with `k`. Correctness is already covered; the *cost-is-flat* half is what's missing.
- **#16** — New file, e.g. `test/enrichmentContinuation.test.js`:
  - Drive `startContinuationJob` (importPdfJobRunner.js:67-95) through several continuations of a `sync_missing_pdfs` job; assert `JSON.stringify(nextParams).length` is equal at continuation 1 and 20 (constant `params_json` — currently zero coverage).
  - Seed 500–1000 pending documents, run `runSync` in batches; assert batch 20's **SQL statement count** (via a stubbed `client.execute` counter, as in `test/enrichmentQueue.test.js:200-220`) is within a small constant factor of batch 1's. Use statement count as the primary metric; wall-clock only as a secondary sanity check.
  - **Include a "sparse pending tail" corpus shape** (attempted/satisfied documents densely packed between the cursor and the next pending id), not just all-pending or evenly-alternating. The `+d.sync_key` index-avoidance trick (db.js:2212-2216, 2228) forces the scan onto the doc_id PK, which can cost more than O(pageLimit)/page under that shape — the realistic partially-completed-corpus case.
- **#19** — Add a test on the full `sync_missing_pdfs` path (not just `filterSyncItemsForMode` in isolation) instrumenting `client.execute` across one 100-record page; assert single-digit statement count, matching the issue's literal criterion.
- **#29** — Add `EXPLAIN QUERY PLAN` assertions (pattern at `test/citationMatchEquivalence.test.js:361-392`) for each hot query the indexes serve:
  - `d.degree = ?` + year (db.js:1004-1032) → `idx_documents_degree_year`.
  - catalogue-lookup ordering/filtering on `hits`/`query_title` (db.js:3675, 3794) → `idx_catalogue_lookups_hits_query_title`.
  - `file_metrics` pdf_path lookups (db.js:2849, 3618) → `idx_file_metrics_pdf_path`.
  - Confirm no plan regressed to a table scan after `idx_documents_sync_key_doc_id` was dropped (db.js:563) — especially `listDocumentsPendingEnrichment` and other `sync_key` consumers not using the `+d.sync_key` de-opt on purpose.

### Phase 3 — Full-scale completion-gate measurement

Once Phases 1–2 are green, run (or write a `scripts/`-level harness for — none found beyond `scripts/load-test-metadata-serving.mjs`, which is metadata-serving) a 5,000-synthetic-document pass through `saveCitations` / `reextractDocumentCitations` / `runSync`, sampling per-document wall-clock at documents 100 / 1000 / 2500 / 5000, and confirm no upward trend. This is the literal #10 gate and is the final sign-off artifact — not something inferred from unit tests alone.

---

## 3. Sequencing, risks, definition of done

**Sequencing.** Phase 1 first (only phase touching the matcher logic; later verification is meaningless if the matcher is unverified). Phase 2's four tracks are independent of each other and of Phase 1 internals — parallelize across commits/PRs to avoid conflicts in shared test infra. Phase 3 depends on all of Phase 1–2 being green.

**Top risks.**
- **Re-introducing "green but unverified."** History shows this already happened (0 branch hits on supposedly-tested branches). Every new test must assert the relevant path was *reached*, not just that the result matched — hence the counter/telemetry reach-assertions throughout.
- **`listDocumentsPendingEnrichment` under a sparse pending tail** is plausibly non-flat in a realistic partially-completed corpus — the shape a production corpus has after the first sync passes. Test it explicitly before declaring #16 done.
- **`sweepOrphanedCitations` is exported but never called from any production path** (db.js:3569-3586) — no cron/admin route. Orphans from interrupted jobs or direct deletions accumulate indefinitely even though the tested mechanism exists. Wire a cron/admin-triggered call before Phase A is operationally complete (outside the five issues' literal text, but a real gap).
- **Mutation testing is manual** (no framework in `package.json`). Phase 1c is a one-time apply/run/revert acceptance gate for #11, not infrastructure to build out.

**Definition of done.**

| Issue | Verification evidence required to close |
|---|---|
| #11 | Wired fixtures (1a) green; saturation path tested (1b); all 4 mutations caught (1c); design decision (1d) recorded |
| #12 | Flat-cost measurement across increasing document count |
| #16 | `startContinuationJob` constant-`params_json` test + per-batch statement-count test (incl. sparse-tail shape) |
| #19 | Full-path statement-count test on `sync_missing_pdfs` |
| #29 | `EXPLAIN QUERY PLAN` test per listed hot query; no regression after the dropped index |
| Gate (#10) | 5,000-document synthetic run, flat per-document cost |

---

## 4. Path from the work branch to `v2`

The plan is tracked on `claude/phase-a-completion-plan-lana70`; the code work stays on (or branches from) `claude/ubc-dissertations-parser-review-krgyee`, where the Phase A commits already live. Flow:
1. Land Phase 1 as a real commit superseding `ad332dd`'s WIP marker.
2. Land Phase 2's four verification tracks as separate small commits/PRs for reviewability.
3. Capture Phase 3's 5,000-doc measurement as evidence.
4. Open a PR from the parser-review branch into `v2`, linking #11/#12/#16/#19/#29 and the #10 gate measurement as closing evidence.
5. `v2` review should specifically re-check the 1c mutation results and the #29 EXPLAIN outputs — the two areas where "tests pass" was previously shown not to imply "defect fixed."

---

## Critical files

- `src/db.js` — citation matcher (`FUZZY_CANDIDATE_LIMIT` ~3029, `findFuzzyMatch` ~3237-3293, `saveCitations` ~3369, `collectOrphanedCitations`/`sweepOrphanedCitations` ~3536-3586, `enrichmentPolicySatisfiedSql`/`listDocumentsPendingEnrichment` ~2189-2256, index creation ~563-594)
- `src/sync.js` — `runSync`/`drainLocalEnrichmentQueue` ~165-450, `hasCachedEnrichmentMetric` ~72-93
- `src/services/importPdfJobRunner.js` — `startContinuationJob` ~67-95
- `test/citationMatchEquivalence.test.js` — dead fixtures at 188-221 to wire
- `test/enrichmentQueue.test.js` — policy-equivalence and batching tests to extend
