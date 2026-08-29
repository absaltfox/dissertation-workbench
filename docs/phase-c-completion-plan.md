# Phase C Completion Plan

**Parent:** #10 (corpus scaling audit rev 2) · **Phase C issues:** #20, #21, #22, #31, #34, #35
**Completion gate (#10):** *First-generation global dictionary reachable in a countable number of runs; unchanged rerun is a no-op; fan-in holds through the merge.*
**Work branch (this plan):** `claude/phase-c-completion-plan` (based on `v2` = `f7c1fe4`, which already merged Phase A — PR #36 — and Phase B — PR #39)
**Integration target:** `v2`

**Why this plan re-derives everything from scratch:** the six issues were filed against `v2@58f2c90`. The pre-Phase-A hardening commit `98bd3a8` (which capped extension fan-in, added the `(prefix, year)` bucket narrowing elsewhere, and generally hardened `scripts/build-concepts.py`) landed before Phase A/B and shifted most of this file's line numbers by 250-350 lines. Every citation below is re-verified against the current tree; drift is called out per issue. Two issues (#20/#21's `discover_partition`, #22's `content_checksum`) drifted substantially; #31's `merge_partition_artifacts` and #34's `conceptsPipeline.js:572` citation drifted only slightly or not at all.

---

## 0. Baseline

- `npm install` was already satisfied (`node_modules` present).
- `node scripts/run-tests.mjs` → **256 tests, 251 pass / 5 fail**, ~13s. All 5 failures are `test/pdfParser.test.js` cases (166, 167, 170, 177, 178) that shell out to `pdftotext`/`pdfinfo` (poppler-utils not installed in this sandbox) — confirmed by the log lines (`"reason":"pdftotext_unavailable"`). Pre-existing environment gap, not a regression; matches the briefing's expected count exactly.
- `python3 --version` → `3.11.15`, with its bundled `sqlite3` module reporting SQLite `3.45.1` (supports ordered `GROUP_CONCAT`, added in 3.44 — noted below as a capability this plan deliberately does *not* depend on, since production may run against Turso/libsql instead of stock SQLite).
- `scripts/build-concepts.py`'s imports are pure standard library (`json`, `hashlib`, `math`, `os`, `re`, `sqlite3`, `sys`, `time`, `urllib.error`, `urllib.request`, `datetime`, `pathlib`) — no numpy/scipy/scikit-learn. The one heavy dependency, `sentence_transformers.SentenceTransformer`, is imported lazily inside `load_embedding_model()` (1200-1209) and only reached when `CONCEPT_EMBEDDING_BACKEND` is not `deterministic_test`; the existing test suite runs the real script end-to-end via `execFileAsync('python3', ['scripts/build-concepts.py'], {...env})` (`test/adminWorker.test.js`, many call sites) with `CONCEPT_EMBEDDING_BACKEND=deterministic_test`, confirming python3 is present, working, and this is the harness Phase C's new tests should extend rather than build from scratch.
- No source or test files were modified for this task. This document and read-only investigation (greps, `Read`, one disposable Python one-liner to check the `sqlite3` version) are the only artifacts produced.

### Per-issue status table

| Issue | Code state (this tree) | Line drift from filed issue |
|---|---|---|
| **#20** N-03 | Bug present in current form, worse than filed text by one statement/cohort | `discover_partition` now at `build-concepts.py:822-961` (filed ~508-545); **+~300 lines**, from `98bd3a8`'s hardening landing earlier in the file |
| **#21** N-04 | Confirmed exactly; cadence is worse than "1000+ runs" suggests (see §1) | Same function, same drift |
| **#22** N-05 | Confirmed exactly; Phase B relocated but did not fix the double-call | `content_checksum` now at `build-concepts.py:985-988` (filed ~665); **+~320 lines**. `saveDocumentMetadata` call sites now at `sync.js:317,340` inside `runEnrichmentBatch` (269-352), per Phase B's #18 rework |
| **#31** R3 fan-in at merge | Confirmed; mechanism is more precise (and more subtle) than the filed text — see §1 | `merge_partition_artifacts` now at `build-concepts.py:1263-1369` (filed ~1310); **~-47 lines**, negligible drift |
| **#34** JS pipeline divergence | Confirmed exactly, and more thoroughly reachable than "may be dead" — it is fully dead | `conceptsPipeline.js:572` citation is **exact, zero drift**; `build-concepts.py:368` comment citation is **exact, zero drift** — but its actual scope is narrower than the issue implies (see §1) |
| **#35** fan-in telemetry double-count | Confirmed exactly; existing test does not reproduce it | `cluster_phrases` at `build-concepts.py:418-548`, `extensions` dict at 508-513, telemetry increments at 531-539 |

---

## 1. Verified current state, issue by issue

### #20 (N-03) — `discover_partition` issues per-cohort scheduling queries

**Where it lives now:** `build-concepts.py:822-961`. The automatic (non-explicit-scope) path first runs one cheap query that already has everything needed for scheduling:

```python
rows = client.execute(
    """SELECT COALESCE(degree, '') AS degree, COALESCE(year, 0) AS partition_year,
              COUNT(*) AS document_count, MAX(updated_at) AS source_updated_at
       FROM documents GROUP BY COALESCE(degree, ''), COALESCE(year, 0)
       ORDER BY degree, partition_year"""
).rows  # :828-835
```

Then, for **every** candidate cohort produced from those rows, the loop (852-917) issues, unconditionally:

1. `SELECT * FROM concept_partitions WHERE partition_key = ?` (854-856) — one round trip per cohort.
2. `SELECT COUNT(*) AS document_count, MAX(updated_at) AS source_updated_at FROM documents d{where}` (859-862), rebuilt from `scope_where(scope)` (798-819) — a **second** round trip per cohort that recomputes exactly what the initial `GROUP BY` already returned for that cohort.
3. An `INSERT ... ON CONFLICT DO UPDATE` upsert (897-915) that runs for every surviving (non-blocked, `count > 0`) cohort **regardless of whether `dirty` is true** — this both persists the scheduling decision and (via `updated_at = now`) marks the row "seen this pass" so the later retirement check (919-922, `WHERE enabled = 1 AND updated_at <> ?`) can find rows that were *not* seen.

So the real per-cohort cost is **3 statements**, not the 2 the filed issue names — the write is a third, previously uncounted cost. At an estimated 1,000-3,000 automatic cohorts (see §2's note on getting the real number), that is 3,000-9,000 round trips *every single run*, even when nothing changed anywhere in the corpus.

**Why query (2) is provably redundant on the automatic path:** an automatic candidate's `scope` (836-846) is built directly from the *same* `GROUP BY` row that produced it — `degree = row["degree"]` and either `yearFrom = yearTo = row["partition_year"]` or `yearMissing = True` when the year is 0. `scope_where` (798-819) turns that into `d.degree = ? AND d.year >= ? AND d.year <= ?` (or the `yearMissing` clause) — which is exactly the `GROUP BY`'s own grouping predicate. The `COUNT(*)`/`MAX(updated_at)` computed by query (2) is therefore identical, cohort-for-cohort, to what query (1) already returned. Only the **explicit-scope** path (a single caller-provided scope, evaluated once per job, not per cohort) legitimately needs a fresh per-scope `COUNT`.

**Fix:** (a) use the `GROUP BY` rows directly for `document_count`/`source_updated_at` on the automatic path — never issue query (2) there; (b) replace the per-cohort `existing_rows` lookup (query 1) with **one** bulk `SELECT * FROM concept_partitions` (or `WHERE enabled = 1`), indexed by `partition_key` in a dict, before the loop; (c) for the write (query 3) and the retirement bookkeeping, stop touching every surviving row's `updated_at` just to mark it "seen" — compute the candidate-key set and the currently-enabled-key set from data already in memory (the bulk fetch from (b) plus the candidate list), take the set difference for retirement, and write only (i) cohorts whose persisted state actually changed this pass and (ii) the retired set, via one chunked `UPDATE ... WHERE partition_key IN (...)` (chunked to stay well under SQLite's/libsql's parameter-count ceiling, e.g. 500 keys per statement).

After the fix, `discover_partition`'s statement count is **O(1)**: one `GROUP BY` summary, one bulk `concept_partitions` fetch, plus writes bounded by the number of cohorts whose state actually changed — not by total cohort count.

**M-06/#29 interaction:** `idx_documents_degree_year` is confirmed present (`src/db.js:673`, added in Phase A), so the `GROUP BY COALESCE(degree,''), COALESCE(year,0)` query itself is already index-served.

**Interaction with #21/#22:** this restructuring is also the natural place to add #22's content-fingerprint computation (same function, same per-cohort pass, avoids a fourth separate scan) and is a precondition for #21's decade-coarsening option (which changes only the `GROUP BY`'s grouping key, not the surrounding query-count discipline this fix establishes).

### #21 (N-04, design decision) — cold-start needs ~1000+ runs, worse in wall-clock terms than that number suggests

**Confirmed mechanism:** `main()` (1372-1699) calls `discover_partition` once per invocation and gets back **at most one** selected partition (or a `publishOnly` signal). It fully processes that one partition, then checks `global_partition_readiness(client)` (1110-1118: `total == ready` across every `enabled = 1` row) — the merged global artifact is only published (1632-1656) when readiness is complete **and** this run's partition belongs to the automatic family (`selected["publishGlobally"]`). So the number of runs needed for the first global dictionary is bounded below by the number of distinct automatic `(degree, year)` cohorts with at least one document.

**Correction (verified by reproduction): runs ≥ K, but not necessarily == K.** The existing regression test `test/adminWorker.test.js:627-696` ("automatic PatternRank publishes only a complete generation...") seeds 2 cohorts but needs **3** `run()` invocations before `concepts/latest.json` first appears (two consecutive `assert.rejects(fs.access(latestPath))` after the first two runs, at lines 653-656), because its two documents share near-identical title/abstract/subjects. The extra run comes from a mechanism the filed issue never mentions: `save_partition_candidates` (build-concepts.py:1089-1106) re-marks an **already-complete** partition back to `'pending'` when a later shard's completion pushes a shared phrase across the global `MIN_DOCUMENT_FREQUENCY` gate — a cross-shard DF-crossing ripple. A control with phrase-disjoint cohorts publishes in exactly 2 runs, so the clean "K cohorts → K runs" bound holds only when cohorts don't share borderline vocabulary; realistic corpora do, so the true bound is **K plus a bounded number of re-pending ripples**. This matters directly to the gate clause "reachable in a *countable* number of runs" — the fix and Gate A must bound (and prove convergence of) that ripple, not assume exact equality with K.

**What makes this worse than "1000+ runs" implies — confirmed cadence:** `src/server.js` schedules **exactly one** `concept_rebuild` job per **calendar day** (`DAILY_CONCEPT_REBUILD_HOUR_LOCAL = 2`, `msUntilNextDailyConceptRebuild`/`scheduleDailyConceptRebuildJob`, server.js:42,51-57,74-87), plus one at process startup, but only before any generation has ever succeeded (`startConceptRebuildJob('startup')` is gated on `!conceptStatus?.lastSuccessAt`, server.js:229) — so a restart does not add a run once the first dictionary exists. There is no chaining anywhere in `server.js`/`src/services/adminWorker.js`/`src/jobWorker.js` that keeps invoking the worker until the partition queue drains — each scheduled fire is one subprocess, one partition, done. So absent manual intervention, **at most one or two partition-runs happen per day**. If the true cohort count turns out to be, say, 1,500 (an *estimate* — see below for how to get the real number), the daily-only cadence means the **first** complete global dictionary is ~1,500 *days* (over 4 years) away, not "1,500 runs" in some abstract unit — this is a materially more severe finding than the issue's own framing suggests.

An admin *can* manually trigger extra partition runs (`adminOperationsRoutes.js:105-118`, guarded by `hasRunningAdminJob('concept_rebuild')` so calls serialize), but each spawns a fresh Python subprocess that reloads the sentence-transformer model from scratch (`load_embedding_model`, 1200-1209) — a real per-invocation fixed cost. Manually looping that call 1,500 times is a theoretically-available but operationally poor workaround, not a fix.

**Get the real cohort count before finalizing anything:** run `SELECT COUNT(*) FROM (SELECT DISTINCT COALESCE(degree,''), COALESCE(year,0) FROM documents)` against the production database. This sandbox has no seeded production-scale DB, so the figure cannot be obtained here — every number in this section above is explicitly an estimate pending that query.

**Design decision — three levers, not two:**

1. **Coarsen the automatic family from degree×year to degree×decade** (the issue's option 2). Changes only the `GROUP BY`'s grouping key (`(year // 10) * 10` instead of `year`) and the derived `scope`'s `yearFrom`/`yearTo` (decade bounds instead of a single year) — `scope_where` needs no change, since it already supports a year range. Reduces cohort count by roughly the average number of distinct years per degree (get the real ratio from the same query above, grouped both ways).
2. **Publish with stated partial coverage for the first generation only** (the issue's option 1), keeping never-replace-with-partial for every later generation.
3. **Increase run cadence** (not named in the issue's two options, but directly addresses the literal complaint): chain runs back-to-back (loop until the partition queue drains, or move from daily to hourly/every-N-minutes) instead of one-per-calendar-day. This is orthogonal to (1) and (2) — it doesn't reduce how many runs are needed, only how much wall-clock time each run costs to reach, and it is the more reversible, purely-operational change of the three.

**Recommendation: (1) decade coarsening as the primary fix, combined with (3) as a low-risk complementary change; (2) not recommended as the primary fix.**

- Decade coarsening directly and structurally reduces the run count the cold-start bound depends on — the actual root cause (mismatch between "one partition per run" and "thousands of cohorts") rather than tolerating it once.
- It has favorable side effects on the other three issues in this phase: fewer, larger shards ease #20's *consequence* of a falsely-dirty cohort (a wasted scheduling slot is a smaller fraction of a smaller total), and give each shard a more representative slice of the corpus, making #31's cross-shard fan-in accumulation failure mode rarer in practice (a mitigating effect, not a substitute for #31's own fix, which must hold regardless of granularity).
- Migration is self-draining: partition keys are content-hashed from `{namespace, scope}` (`partition_key`, 787-795), so decade-scoped candidates hash to entirely new keys. Existing per-year `enabled=1` rows simply stop appearing among next-pass's candidates and are picked up by the *existing* retirement logic (918-949) with no special-case code needed. This is a one-time re-cohorting that pays a "first generation again" cost once, not a design that needs migration-specific code.
- Partial-coverage publishing (option 2) is not recommended as the *primary* fix because it only tolerates the one-partition-per-run architecture rather than addressing it, requires two different completeness rules to reason about (generation 1 partial-OK vs. generation N+1 strictly complete), and doesn't reduce the actual number of runs needed — it just makes the wait less silent. It remains a reasonable **stopgap**, usable alongside decade migration if more validation time is needed before committing to the coarser grain (e.g., ship option 3 immediately, validate decade cohort sizes against production, then ship option 1).

**Decision for the user — do not treat this as settled by this plan:** coarsening the automatic partition family's time granularity from exact-year to decade is a product-visible choice — it changes how finely concept vocabulary drift can be tracked over time (a "1990s" bucket instead of year-by-year), and it forces a one-time rebuild-from-scratch of every existing per-year partition. This needs explicit confirmation before implementation. Separately, whether to *also* change the run cadence (lever 3) is a smaller, more reversible operational decision the user may want to make independently of the granularity question.

**A concrete risk of decade coarsening to flag now:** `MAX_PARTITION_DOCUMENTS` (867-889, default 5,000, `CONCEPT_PARTITION_MAX_DOCUMENTS`-overridable) already exists as a release valve for oversized cohorts — a decade-scoped cohort for a large degree/program could now exceed it where the same degree's individual years did not, flipping that cohort to `'blocked'` and requiring an operator to further split it via an explicit degree+narrower-year scope. This is not a new failure mode (the mechanism already exists and is already tested via the "blocked" path), but it will likely trigger more often immediately after a decade-granularity rollout. Get real per-degree-decade document-count distributions from production before rollout to size expectations.

### #22 (N-05) — partition dirty-detection keys on a timestamp that any enrichment pass bumps

**Confirmed root cause, exactly:** `src/db.js:897-939`'s `saveDocumentMetadata` always writes `updated_at = excluded.updated_at` (931) using a fresh `now()` (900, threaded to `saveDocumentStatement`'s args at 936-937) on **every** call, regardless of whether any column value actually changed relative to the stored row. Phase B's #18 rework (`sync.js:269-352`, `runEnrichmentBatch`) calls it **twice** per document in every enrichment pass — once before `analyzeDocumentFile` (317) and once after (340) — and `analyzeDocumentFile` writes to `file_metrics`, not `documents.metadata_json`, so the concept-relevant fields (`title`/`abstract`/`description`/`subjects`, all sourced from Open Collections metadata) are almost always byte-identical between the two calls. Phase B relocated this code (it now lives inside the shared `runEnrichmentBatch` rather than the pre-Phase-A per-document body) but did not change this behavior — the double call and the unconditional timestamp bump are both still present, verbatim in effect.

`discover_partition`'s dirty check (890-896) compares `str(summary["source_updated_at"]) > str(last_completed)` — so *any* enrichment pass over *any* document in a cohort re-marks that cohort `'pending'` (913), even when title/abstract/subjects never changed. Because `main()` processes exactly one partition per run (§#21), a falsely-dirty cohort winning the priority sort (956) is a real, direct opportunity cost against #21's cold-start count — this is why the task groups these two issues under the same gate clause pairing.

**Where the waste actually lands (and where it doesn't):** once a falsely-dirty partition *is* selected, `content_checksum(doc)` (985-988) plus the per-document reuse check in `main()` (1451-1477, comparing against `load_document_states`, 991-996) already correctly detects "nothing to redo" at the **document** level — `changed_docs` ends up empty, so no wasted re-embedding happens. The waste is entirely in the **scheduling decision**: `load_partition_documents` (964-982) loads every document's text, and the per-doc checksum comparison loop runs, only to discover afterward that nothing needed regeneration. The fix target is the scheduling layer, not the per-document reuse mechanism (which is already correct).

**Fix:** compute a content fingerprint at the `discover_partition`/scheduling layer using only the fields `document_text()`/`doc_segments()` actually read (314-336: `title`, `abstract` or `description`, `subjects`/`subject`). Concretely, add one bulk projection query per `discover_partition` call — issued alongside (not instead of) #20's restructured bulk queries:

```sql
SELECT doc_id, degree, year, updated_at,
       json_extract(metadata_json, '$.title') AS title,
       COALESCE(json_extract(metadata_json, '$.abstract'),
                json_extract(metadata_json, '$.description')) AS abstract,
       json_extract(metadata_json, '$.subjects') AS subjects
FROM documents
```

Group the rows by (degree, year-or-decade — matching whatever #21 lands on) in Python, and compute a per-cohort `content_fingerprint = sha256(sorted-by-doc_id concatenation of each doc's (title|abstract|subjects))`. Persist it as a new `concept_partitions.content_fingerprint` column and compare it (not `source_updated_at`/`last_completed_at`) to decide `dirty`.

**Schema note — a new migration primitive is needed:** `ensure_incremental_schema` (723-757) only ever does `CREATE TABLE IF NOT EXISTS`; there is no existing "add a column to an existing table" idiom in this file (unlike `src/db.js`'s `tryExec` pattern for indexes/columns). Adding `content_fingerprint` needs a small, new, idempotent `ALTER TABLE concept_partitions ADD COLUMN content_fingerprint TEXT` guarded by a try/except (SQLite/libsql raise on a duplicate column) — flag this as new machinery this fix introduces, not a reuse of an existing pattern.

**Cost trade-off, stated honestly:** the new projection query returns one row per **document**, not one row per cohort — larger in row count than today's `GROUP BY` summary, though each row is far lighter (three short text fields via `json_extract`) than a full `metadata_json` blob or the actual partition-rebuild's text assembly. On a remote Turso connection this trades "many small round trips" for "one round trip, more total bytes," which is very likely a net win given round-trip latency typically dominates a chatty remote API — but this should be confirmed with a real timing comparison once a production-scale Turso-backed DB is available; it cannot be verified from this sandbox (which uses local SQLite in every test, not the remote path).

**Portability caveat, and why ordered `GROUP_CONCAT` was considered and rejected:** the local `sqlite3` module here supports `GROUP_CONCAT(x ORDER BY y)` (SQLite 3.44+), which would let the fingerprint be computed inside the `GROUP BY` query itself rather than as a second flat query. This is deliberately **not** the recommended design, because whether Turso's libsql engine (the actual production path when `TURSO_DATABASE_URL` is set — `get_db_client`, 174-184) supports the same ordered-aggregate feature cannot be verified from this sandbox (no live Turso connection is reachable here). `json_extract` itself is a much older, more universally-supported SQLite feature and is the safer bet; the flat per-document projection avoids depending on the unconfirmed capability entirely.

**Deliberately out of scope:** fixing `saveDocumentMetadata`'s unconditional `updated_at` bump at its source (`src/db.js`) is *not* proposed here. That function is shared by every consumer of `documents.updated_at` (sync reporting, admin dashboards, not just concepts), was Phase A/B territory, and changing its semantics would have a blast radius well beyond this phase's six issues. The content-fingerprint fix fully absorbs the symptom at the concepts layer without touching that shared write path.

### #31 (R3 fan-in at merge) — global merge never re-checks fan-in

**Confirmed mechanism, more precisely than the filed text:** `cluster_phrases` (418-548) enforces `MAX_VARIANT_EXTENSION_FAN_IN` **per partition**, at the extension-application loop (529-539), using `roots_before` — a snapshot of each phrase's component root taken *before* any R3 unions are applied (524-527), so an earlier union within the same shard cannot lower a later hub's counted fan-in. `merge_partition_artifacts` (1263-1369) then builds a **fresh** global `DisjointSet` (`relations`, 1280) and, for every shard's every concept's recorded `variants`, calls `relations.union(variant, canonical)` unconditionally (1308-1310) — there is no re-check against `MAX_VARIANT_EXTENSION_FAN_IN`, or any global fan-in accounting at all, anywhere in the merge.

One nuance worth stating precisely, since the filed issue's "a hub withheld in one shard is reinstated globally" phrasing is slightly imprecise about the mechanism: a withheld extension is **never recorded** in its shard's own `variants` output (the `continue` at cluster_phrases:537 skips the `forest.union` call entirely), so the merge has no edge data for that specific withheld relationship and cannot literally "reinstate" it by itself. The actual hole is **cross-shard accumulation**: shard A can independently keep 2 extensions for hub X (within A's own per-shard cap), and shard B can independently keep a *different* 2 extensions for the same hub X (within B's own cap) — neither shard individually violates anything, but the merge's unconditional union combines both legal per-shard subsets into one component of 4+ extensions, with nothing in the merge to catch that the combined fan-in now exceeds the global limit. Over N shards this bounds the merged component at up to `N * MAX_VARIANT_EXTENSION_FAN_IN + 1` members — matching the issue's "2N+1" figure at the default cap of 2 — via this accumulation path (and, less directly, via an R1/R2 edge in one shard incidentally reconnecting phrases that R3 kept separate in another shard specifically because of the cap).

**Telemetry compounds the problem:** `merge_partition_artifacts` sums every shard's `clusterExtensionHubsSkipped`/`clusterExtensionEdgesSkipped` into the merged artifact's `stats` (1290-1291, 1361-1362) — a count of what was withheld **per shard**, reported as if it described the **merged** dictionary, even though the merge may have reassembled a hub past the global cap using exactly the union of what each shard separately, legally, kept.

**Fix options, in preference order:**

1. **(Preferred) Re-enforce fan-in at merge time over the global component graph**, reusing the same distinct-component-counting logic `cluster_phrases` already uses (528-539: `distinct = {roots_before[phrase] for phrase in absorbed} - {roots_before[shorter]}`, `len(distinct) > MAX_VARIANT_EXTENSION_FAN_IN`), applied post-hoc to the merged `relations` DisjointSet's components. This requires distinguishing which merge-time edges came from R3 (extension, fan-in-limited) versus R1/R2 (equivalence/head-form, no fan-in concept applies) — information the current artifact schema does **not** carry (`concept["variants"]` is a bare list of phrase strings, `build_variant_map`). This needs a small, deliberate artifact-shape change: tag each variant with the rule that produced it (e.g., `{"phrase": ..., "rule": "R1"|"R2"|"R3"}`), touching `cluster_phrases`, `pick_canonical`, `build_variant_map`, and `save_partition_artifact`, and bumping `artifact["version"]` (currently `3`) since this is a schema change downstream consumers (`src/metrics.js`, topic labeling) must not silently misread.
2. **(At minimum, per the issue's own fallback language) Stop reporting withheld-edge counts that the merge goes on to reinstate.** Keep merge's current union-everything behavior, but after building `relations` and its components, re-run the same distinct-component check over the *merged* components to compute a truthful merged-level "would this component have exceeded fan-in built in one pass" diagnostic, replacing the naive per-shard-summed counters. This is a reporting-only fix — it makes `clusterExtensionEdgesSkipped` truthful about the merged artifact, but does not prevent the over-fan-in component from existing in the merged dictionary.

**Recommendation:** land option 1 as the real fix — a truthful count of an incorrect merge improves visibility, not correctness, and correctness is what the gate clause ("fan-in holds through the merge") actually asks for. If the artifact-versioning work needs to be sequenced separately for schedule reasons, land option 2 first as an honest interim state (never claim a withholding the merge itself undid) and land option 1 as a fast-follow — but do not treat option 2 alone as closing this issue.

### #35 (fan-in telemetry double-count) — solved together with #31 per the task's framing

**Confirmed mechanism, precisely:** `extensions` (508-513) is keyed by `shorter` — the **surface** bigram phrase, not its stem tuple or a component root:

```python
extensions = {}
for phrase, stems in trigrams:
    for shorter in bigram_stems.get(stems[:2], []):
        ...
        extensions.setdefault(shorter, []).append(phrase)
```

`bigram_stems` (461) is keyed by the stems *tuple*, so when two distinct surface bigrams stem to the identical tuple (the common case: the stemmer strips a trailing plural "s" — e.g. "student outcome" / "student outcomes"), `bigram_stems[stems]` holds *both* surface forms, and the inner loop appends the *same* matching trigram set to `extensions[shorter1]` and `extensions[shorter2]` independently — two dict entries for what is logically one hub. Because R1 (465-468) already merges phrases sharing an identical stemmed-token frozenset — which two co-stemming bigrams trivially have — `shorter1` and `shorter2` are already in the same forest component by the time R3 runs, so `roots_before[shorter1] == roots_before[shorter2]` (524-527) and the fan-in check at 531-539 computes an *identical* `distinct` set size under both keys, independently deciding "skip" (or "keep") twice for one hub. The `continue` at line 537 harmlessly avoids double-applying the union (`forest.union` is idempotent, so clustering **output** is unaffected), but does **not** avoid incrementing `extension_hubs_skipped`/`extension_edges_skipped` twice (535-536) — hence the roughly 2x inflation the issue describes.

**The existing test does not catch this.** `test/adminWorker.test.js:1659-1706` ("variant clustering leaves hub extensions distinct and reports withholding them") uses a hub with a *single* surface form ("student engagement", no plural counterpart in the fixture), so `bigram_stems` never holds more than one entry for that stem pair and `extensions` never gets a duplicate key. This is a genuine coverage gap — confirmed by inspection, not merely inferred — and the plan's new test must add a fixture with two co-stemming surface bigrams to reproduce the bug at all.

**Fix:** group `extensions` by the component root at R3-start time — `forest.find(shorter)`, reusing the `roots_before` snapshot already computed — rather than by raw surface phrase, so every surface form mapping to one component contributes to exactly one fan-in decision and one counter increment. **The absorbed-extension set for each root must be merged as a set, not a concatenated list** — verified by reproduction, keying by root while concatenating each surface form's absorbed phrases still yields `extensionEdgesSkipped == 8` (the double-count reappears in a different guise); only deduplicating the absorbed phrases per root gives the truthful `Hubs=1 / Edges=4`. Keep a representative surface form (e.g. the lexicographically smallest, matching `DisjointSet.components()`'s existing sort convention at 411-415) for the log line so operators still see a concrete, readable phrase rather than an opaque root key.

**Why this is solved together with #31:** both are about the withheld/skip counters being truthful — #35 fixes *within-partition* over-counting (one hub, one shard, double-counted via two surface-form keys); #31 fixes *cross-partition* under-detection (one hub, multiple shards, no global re-check at all). They touch adjacent code (`cluster_phrases` and `merge_partition_artifacts` respectively) and the task explicitly asks for one combined test so a future change to either does not silently regress the other's guarantee.

---

## 2. Plan: fixes, tests, and the three gate clauses as runnable checks

The existing harness pattern — spawn the real worker, `execFileAsync('python3', ['scripts/build-concepts.py'], { cwd, env })`, against a disposable temp SQLite DB (`test/adminWorker.test.js`, throughout) — is the vehicle for every test below; no new test infrastructure is needed, only new fixtures and assertions. For lower-level unit checks of `discover_partition`/`cluster_phrases`/`merge_partition_artifacts` directly, the existing pattern of writing a small standalone Python harness script that `importlib`-loads `build-concepts.py` and calls the function directly (`test/adminWorker.test.js:662-683`'s `fanin_harness.py`, `:777-803`'s `merge_harness.py`) is the right tool — it avoids a full subprocess round-trip through `main()` when only one function's behavior is under test.

### 2.1 — #20: bound `discover_partition` to O(1) statements

**Tests:**
1. A statement-counting test: monkey-patch `SqliteClientWrapper.execute` (or wrap the `client` object passed into `discover_partition` from a standalone harness script) to count invocations; seed K synthetic cohorts (K=5, then K=50 for a stress check) with no changes since the last completed pass; assert the call count does not grow with K (a small constant, e.g. ≤ 4-5 regardless of K) both for a "fresh corpus" pass and an "unchanged rerun" pass. Run this **before** the fix as a documented baseline (asserting the current linear growth, per Phase A/B's "prove the test would have caught the bug" convention), then after the fix, asserting the constant bound.
2. A correctness-preservation test: seed a mixed corpus (some cohorts dirty, some complete, one blocked via `MAX_PARTITION_DOCUMENTS`, one retired between passes) and assert `discover_partition`'s selection (`ranked.sort` at 956, which cohort wins) is byte-identical before and after the restructuring — the fix must not change *which* partition gets selected or *when* retirement fires, only how many statements it costs to get there.

### 2.2 — #22: content-fingerprint dirty detection

**Tests:**
1. The literal gate-B reproduction: seed a partition, run the worker to `'complete'`, then call `saveDocumentMetadata` twice per document with byte-identical `title`/`abstract`/`subjects` (reproducing `sync.js:317,340`'s exact double-call shape) so `documents.updated_at` visibly advances with no concept-relevant content change. Run the worker again. **Pre-fix**, assert the partition is reselected/reprocessed (the current, wrong behavior — a documented baseline). **Post-fix**, assert `result.noChanges === true` (or the selected partition, if any, is a genuinely different, legitimately-dirty one) and that the previously-complete partition's status/`content_fingerprint` is unchanged — verified via a direct SQL read of `concept_partitions`, not just "the artifact looks the same."
2. A true-positive companion: same setup, but the second `saveDocumentMetadata` call carries a genuinely different `title`/`abstract` — assert the partition **is** correctly marked dirty and reprocessed. This guards against a fix that is simply "never mark dirty."
3. A migration test for the new `ALTER TABLE ... ADD COLUMN` path: run `ensure_incremental_schema` twice in a row against the same DB (once fresh, once already migrated) and assert no exception and the column exists exactly once — mirroring how `src/db.js`'s `tryExec` idiom is exercised elsewhere.

### 2.3 — #31 + #35 combined: truthful telemetry and merge-time fan-in

One new test, per the task's explicit direction, built on the existing `merge_harness.py`/`fanin_harness.py` patterns:

1. **#35 half:** construct a hub with a co-stemming surface-form pair (e.g. "student outcome" / "student outcomes", both attested at `VARIANT_EXTENSION_MIN_DOCUMENT_FREQUENCY` or above) and 4 distinct trigram extensions shared identically by both surface forms via `bigram_stems`'s shared-stem-tuple mechanism (matching the task's stated "Hubs=1/Edges=4" target shape). Run `cluster_phrases` directly. **Pre-fix**, assert the double-counted baseline (`extensionHubsSkipped == 2`, `extensionEdgesSkipped == 8`) as a documented regression baseline. **Post-fix**, assert the truthful count (`extensionHubsSkipped == 1`, `extensionEdgesSkipped == 4`).
2. **#31 half:** build 3+ synthetic shard artifacts (via `merge_harness.py`'s pattern), each independently keeping its own small extension set for the *same* hub bigram within its own per-shard cap (e.g. cap=2, each shard contributes 2 different extensions), such that the union across shards is 6 distinct extensions — well past the global cap. Run `merge_partition_artifacts`. Assert the merged hub's component does not exceed `MAX_VARIANT_EXTENSION_FAN_IN + 1` members (i.e., the fix actually re-splits at merge time, not just reports honestly) — or, if option 2 (§1's "at minimum" fallback) ships first as an interim step, assert instead that the reported `clusterExtensionHubsSkipped`/`clusterExtensionEdgesSkipped` accurately reflect the *merged*-level withheld count, not the sum of the (zero, in this fixture) pre-merge per-shard withheld counts.
3. **Regression guard:** re-run the existing `test/adminWorker.test.js:1659-1706` fan-in test unchanged and confirm it still passes — the #31/#35 fix must not alter correct per-shard clustering output, only the merge-time enforcement and the telemetry.

### 2.4 — Mapping the three gate clauses to concrete, runnable checks

| #10 gate clause | Maps to | Gate design |
|---|---|---|
| "First-generation global dictionary reachable in a countable number of runs" | #21 | **Gate A.** Seed a synthetic DB with K distinct automatic cohorts (K parameterized — small, e.g. 5-10, for a fast unit test; a larger K matching the real production figure once obtained, for a scale-level script). Repeatedly invoke the worker as a fresh subprocess (mirroring the real one-run-per-invocation cadence) until `concepts/latest.json` first appears. **Do NOT assert `runs == K`** — the `save_partition_candidates` DF-crossing ripple (see §1 #21) can add bounded re-pending runs when cohorts share borderline vocabulary. Instead: (a) with **phrase-disjoint** cohort fixtures, assert the clean `runs == K` bound and the reduced count under decade coarsening; (b) with **vocabulary-sharing** fixtures, assert `runs` stays within `K + R` for a small documented ripple bound `R`, and — separately — assert the ripple **converges** (a subsequent unchanged rerun adds no further re-pending: it is a no-op, tying into Gate B). Assert in all cases that the count does **not** grow when more *documents* are added to existing cohorts (only cohort count and ripple should matter). This generalizes the existing `test/adminWorker.test.js:627-696` test (which needs 3 runs for its 2 vocabulary-sharing cohorts — see §1 #21) to a parameterized K, a granularity toggle, and an explicit ripple-convergence check. |
| "Unchanged rerun is a no-op" | #22 (supported by #20) | **Gate B.** §2.2's test 1 — a genuine enrichment pass with no concept-relevant content change, then a rerun, asserting no reprocessing — combined with §2.1's statement-count assertion so "no-op" is measured both by outcome (`noChanges: true`) and by cost (near-zero statements on the unchanged rerun path). |
| "Fan-in holds through the merge" | #31 (+ #35's truthful counters) | **Gate C.** §2.3's combined test: the merged hub's component size never exceeds `MAX_VARIANT_EXTENSION_FAN_IN + 1` regardless of how many shards independently contribute to it, and the reported skip counters are truthful about the merged state, not a naive per-shard sum. |

All three gates are directly runnable via the existing `execFileAsync('python3', [...])` harness pattern already proven in `test/adminWorker.test.js` — no new test-runner infrastructure is required, only new fixtures per §2.1-2.3, following `node scripts/run-tests.mjs`'s existing discovery (any `test/*.test.js` file).

---

## 3. Design decisions — recommendations and what needs user confirmation

### #21 — partition granularity (or cadence)

**Recommendation:** coarsen the automatic family to degree×decade (§1's option 1), combined with increasing run cadence as a low-risk, independently-reversible complementary change. Do not adopt publish-with-partial-coverage (option 2) as the primary fix; keep it available as a stopgap if decade-migration validation needs more time.

**Decision for the user:** this changes (a) how finely concept vocabulary drift is tracked over time (decade buckets instead of per-year), and (b) forces a one-time rebuild-from-scratch of every existing per-year partition under new keys. Please confirm before implementation. Independently, confirm whether increasing run cadence (daily → hourly, or chaining runs until the queue drains) is also wanted — it is a smaller, purely operational change that can ship on its own regardless of the granularity decision.

### #34 — delete the dead JS clustering path, or port the fan-in cap to it

**Confirmed wiring table** (grepped across `src/`, `scripts/`, `public/`, `test/`):

| Export (`src/conceptsPipeline.js`) | Called from | Status |
|---|---|---|
| `getConceptPipelineStatus` (458) | `server.js:227`, `adminJobsRoutes.js:41`, `adminOperationsRoutes.js:76` | **Live** — production status reads |
| `persistConceptArtifact` (473) | `internalWorkerRoutes.js:120`, which handles the `PUT /api/internal/jobs/:id/artifacts/concepts/latest` route that `build-concepts.py`'s `upload_concept_artifact` (668-706) actually POSTs to (confirmed: 695, `f"{artifact_base_url()}/api/internal/jobs/{job_id}/artifacts/concepts/latest"`) | **Live** — this is the receiving side of every real Python worker run |
| `rebuildConceptDictionary` (508) | `scripts/rebuild-concepts.js:2,7` only (→ `npm run rebuild-concepts`, `package.json:13`) | **CLI-only.** Confirmed *not* called from any route, admin job dispatcher, or scheduler — both `src/services/adminWorker.js:83-98` (Fly worker payload) and `src/jobWorker.js:50-64` (local dispatch) hard-code `['python3', 'scripts/build-concepts.py']` for `type: 'concept_rebuild'` jobs, never touching this JS path |
| `scheduleDailyConceptRebuild` (715) | *(none)* | **Fully dead.** Zero call sites anywhere in `src/` or `public/`. `server.js`'s real daily scheduler is a distinctly-named local function, `scheduleDailyConceptRebuildJob` (server.js:74), that spawns the Python job — this exported function is not it and is never invoked |

**Recommendation: option 1 — delete `rebuildConceptDictionary`, `scheduleDailyConceptRebuild`, and `scripts/rebuild-concepts.js`**, retiring the corresponding unit tests in `test/conceptsPipeline.test.js` that only exercise `rebuildConceptDictionary`'s internal helpers (`phraseSimilarity`, `extractDocPhrases`, `consolidateConcepts`, `pickCanonical`, etc. — confirmed, via `_testing` export inspection, to be private to `rebuildConceptDictionary`'s pipeline and *not* shared with `getConceptPipelineStatus`/`persistConceptArtifact`, which are simple, self-contained filesystem read/write functions). Deletion has zero blast radius into the live persistence/status path.

Reasons against option 2 (port the fan-in cap into the JS clustering instead):
- The JS path has zero production callers today — hardening it invests effort in a path nothing exercises outside a manual `npm run rebuild-concepts` invocation.
- It has its own, separate, already-known cost problem (B-03's O(P²) all-pairs loop, `conceptsPipeline.js:561-578`) that porting the fan-in cap alone does not fix.
- The orchestration function itself (`rebuildConceptDictionary`) has zero test coverage today — only its private helpers are unit-tested via `_testing`. Porting the cap without also fixing B-03 and adding orchestration-level tests would leave a "capped but still slow and still untested end-to-end" tool, not a meaningfully safer one.

**Fix regardless of which option is chosen:** the `build-concepts.py:366-368` docstring —

```python
def stem_for_similarity(token):
    """... Mirrors ``stemForSim`` in src/conceptsPipeline.js so the Python worker and the
    JavaScript pipeline cluster the same phrases the same way."""
```

is **narrowly, literally accurate** — direct comparison confirms `stem_for_similarity` (Python, 364-374) and `stemForSim` (JS, `conceptsPipeline.js:246-250`) are byte-for-byte identical rules (strip "ies"→"y" when length>5; strip trailing "s" when length>4 and not "ss"). This is the *only* "same way"-style claim in either file — there is no broader comment elsewhere asserting the two clustering algorithms as a whole are equivalent. But read in context, "cluster the same phrases the same way" invites the false inference that the *entire* clustering pipeline matches, when in fact the algorithms have diverged substantially: Python uses blocking rules R1/R2/R3 with an enforced fan-in cap; JS uses an O(P²) all-pairs threshold rule (`sim >= 0.95 || (prefix && sim >= 0.8 && max(docFreq) >= 3)`, `conceptsPipeline.js:572`) with no fan-in cap at all. Reword the docstring to scope the claim precisely to the stemming primitive, and note the broader divergence, regardless of whether the JS path is deleted or kept — if deleted, the comment simply needs the dangling cross-reference removed.

**Decision for the user:** confirm `npm run rebuild-concepts` is not relied on as a documented manual-recovery procedure or referenced in a runbook outside this repo before removing it. If genuinely unused (which the evidence above strongly supports), deletion is safe; this plan defers the final call to explicit sign-off rather than deleting unilaterally.

---

## 4. Cross-cutting: how #21's decision reshapes #20/#22/#31's costs

| | #20 (scheduling query count) | #22 (false-dirty rate) | #31 (merge fan-in risk) |
|---|---|---|---|
| **Effect of decade coarsening** | Once #20's O(1) fix lands, cohort count no longer affects statement count directly — but fewer cohorts means a falsely-dirty cohort (from #22, before *its* fix lands) wastes a larger *fraction* of the smaller total, so #22's fix matters somewhat less urgently in a decade-grained world, though it should still land (the fix is cheap and correct regardless) | No direct interaction — #22's content-fingerprint fix is granularity-agnostic; it just fingerprints a coarser cohort's aggregate content instead of a finer one | Fewer, larger shards each see more of the corpus, making independent per-shard extension sets for the same hub *less* likely to diverge enough to jointly exceed the global cap — a mitigating side effect, not a substitute for #31's own merge-time re-check, which must hold at any granularity |
| **Effect of #20's own fix landing first** | N/A (this is the fix) | #22's fingerprint computation is added to the *same* restructured pass, so sequencing #20 before #22 avoids doing the discovery-query rework twice | No interaction |
| **Effect of #22's own fix landing** | N/A | N/A | No interaction — #22 only changes when a partition is scheduled, not how merge behaves |

The practical sequencing implication: land #20 first (it is foundational — both #22's fingerprint query and any future decade-migration change to the `GROUP BY` key touch the same function), then #22 (builds on #20's restructured query shape), then execute #21's decision (once confirmed) as a change to the same function's grouping key. #31/#35 are independent of all three and can land in parallel. #34 is fully orthogonal (a different pipeline entirely) and can land whenever the deletion decision is confirmed.

---

## 5. Sequencing, risks, definition of done

**Sequencing.**
1. #20 first — foundational, touches the function every other Phase C fix also touches.
2. #22 next — builds directly on #20's restructured bulk-query shape.
3. #31 + #35 together (as one combined fix/test, per §2.3) — independent of #20/#22, can proceed in parallel with them.
4. #21's design decision — get the real cohort-count figure from production, get user confirmation on granularity (and optionally cadence), then execute as a follow-on change to the (by-then-restructured) `discover_partition` grouping key.
5. #34 — independent of everything else; land once the deletion decision is confirmed by the user.
6. Gates A/B/C (§2.4) exercised individually per-issue first, then combined into one scale-level harness for the literal #10 sign-off, following Phase A's `docs/phase-a-gate-results.md` precedent for how that evidence gets captured.

**Top risks.**
- **The cohort-count estimate (~1,000-3,000) is unverified from this sandbox** and is load-bearing for how urgent/large #21's fix needs to be, and for how large Gate A's scale-level harness should be sized. Run `SELECT COUNT(*) FROM (SELECT DISTINCT COALESCE(degree,''), COALESCE(year,0) FROM documents)` against production before finalizing scope; do not ship a decade-migration sized for a guessed number.
- **Turso/libsql SQL-surface portability is unverified from this sandbox.** #22's design deliberately avoids depending on ordered `GROUP_CONCAT` (uncertain support) in favor of `json_extract` (near-universal), but even that should be smoke-tested against a real Turso connection before shipping — every test in this repo's suite runs against local SQLite only.
- **#31's preferred fix (option 1) requires an artifact schema change** (tagging each variant edge with its producing rule, bumping `artifact["version"]`) that touches four functions and needs care that downstream consumers (`src/metrics.js`, topic labeling) don't assume a bare-string `variants` list. This is real migration risk, larger than the "at minimum" telemetry-only fallback (option 2) — if schedule pressure is high, ship option 2 first and option 1 as a fast-follow, but do not consider option 2 alone as closing #31 (the gate clause is about correctness holding through the merge, not just truthful reporting of an incorrect merge).
- **Decade coarsening's interaction with `MAX_PARTITION_DOCUMENTS`** is a real, currently-unquantified risk — some existing degree×year cohorts could jointly exceed the 5,000-document cap once merged into a decade, flipping to `'blocked'` and needing operator-driven scope-splitting immediately post-rollout. Get real per-degree-decade distribution data before rollout, not after.
- **Any restructuring of `discover_partition` (per #20/#22) must reproduce `main()`'s exact tie-break semantics** (`ranked.sort(key=lambda item: (-item[0], item[1], item[2]))`, 956 — priority descending, then `last_completed_at` ascending, then key ascending) from in-memory data. A subtle reordering bug here would silently change which partition gets processed each run without failing any obvious test unless the correctness-preservation test in §2.1 specifically checks selection order under a mixed-state corpus.
- **Mutation-testing-style acceptance is not proposed for #20/#22/#31/#35** the way Phase A used it for #11's citation matcher — these are primarily control-flow and cost-accounting fixes (what gets queried, when a component is split, what gets counted) rather than a scoring algorithm with subtle branches. The "assert the pre-fix behavior first, then the post-fix behavior" pattern used throughout §2 serves the same "prove the test would have caught the bug" purpose Phase A's mutation testing served for #11.

**Definition of done.**

| Issue | Verification evidence required to close | Maps to gate clause |
|---|---|---|
| #20 | Statement-count test showing O(1) (not O(cohort-count)) `discover_partition` calls, proven to fail (linear growth) on pre-fix code; selection/retirement semantics unchanged under a mixed-state corpus | Gate B (supports; not directly graded) |
| #21 | Real cohort-count figure obtained from production; granularity (and optionally cadence) decision confirmed by the user; Gate A passes with the chosen design, proven countable and not growing with document count within a fixed cohort count | **Gate A** |
| #22 | Gate B's enrichment-then-rebuild no-op test passes, proven to fail (false-dirty) on pre-fix code; true-positive companion still detects genuine content changes; `ALTER TABLE` migration is idempotent | **Gate B** |
| #31 | Gate C's combined merge-fan-in test passes (merged component capped, or at minimum telemetry-only fallback truthfully reports the exceedance); existing per-shard fan-in test (`adminWorker.test.js:1659-1706`) still passes unchanged | **Gate C** |
| #34 | Wiring table confirmed (above); deletion (once user-confirmed) leaves `getConceptPipelineStatus`/`persistConceptArtifact` and their tests green; the `build-concepts.py:366-368` docstring reworded regardless of which option is taken | None directly — hygiene/documentation-accuracy fix |
| #35 | Gate C's #35 half passes: double-counted baseline confirmed pre-fix, truthful 1-hub/4-edge count confirmed post-fix, using the task's stated reproduction shape | **Gate C** |
| **Gate (#10)** | Gates A, B, and C passing together — ideally combined into one scale-level harness (e.g. `scripts/phase-c-scale-gate.mjs` or an equivalent Python driver script, mirroring `scripts/phase-a-scale-gate.mjs`'s role for Phase A) run against a cohort count and document volume matching the real production figures obtained per #21's risk item above | **All three** |

---

## 6. Path from this plan to `v2`

1. Confirm with the user: (a) #21's granularity/cadence recommendation, (b) #34's deletion recommendation. Get the real cohort-count figure from production in the same pass — it affects both decisions' sizing.
2. Land #20 (§2.1) — foundational, no external dependency.
3. Land #22 (§2.2) on top of #20's restructured queries, including the new `ALTER TABLE` migration primitive.
4. Land the combined #31/#35 fix and test (§2.3) — independent of #20/#22, can be done in parallel by a different reviewer.
5. Execute #21's confirmed decision (decade migration and/or cadence change) as a follow-on change to `discover_partition`'s grouping key, once (1)'s figures and confirmation are in hand.
6. Execute #34's confirmed decision (deletion, or the cap-porting alternative if the user prefers option 2 despite the recommendation above) and reword the `build-concepts.py:366-368` docstring either way.
7. Run Gates A/B/C individually, confirm each passes and each was proven to fail on the corresponding pre-fix code, then combine into one scale-level #10 gate measurement (a `docs/phase-c-gate-results.md` companion to this plan, produced once the harnesses exist and are run — out of scope for this planning pass itself, matching Phase A/B's own precedent of a separate results document).
8. Open a PR from this work into `v2`, linking #20/#21/#22/#31/#34/#35 and the combined #10 gate measurement as closing evidence.
9. `v2` review should specifically re-check: (a) that #20/#22's statement-count tests were actually shown to fail on pre-fix code, not just pass on the fix (the same "green but unverified" risk Phase A's retrospective flagged for itself); (b) #31's chosen option (re-enforce vs. telemetry-only) and why; (c) that #21/#34's user-confirmed decisions match what was actually implemented.

---

## Critical files

- `scripts/build-concepts.py` — `discover_partition` (822-961, #20/#21 fix site), `content_checksum` (985-988), `main()`'s dirty/reuse loop (1441-1477, #22 fix site), `ensure_incremental_schema` (723-757, needs a new `ALTER TABLE` primitive), `cluster_phrases` (418-548, `extensions` at 508-513 and fan-in application at 529-539, #35 fix site), `merge_partition_artifacts` (1263-1369, #31 fix site), `global_partition_readiness`/`global_generation_signature`/`global_publication_pending`/`mark_global_published` (1110-1153), `load_embedding_model` (1200-1209, per-invocation fixed cost relevant to #21's cadence discussion), `partition_key`/`scope_where`/`normalized_scope` (772-819, #21's decade-grouping change site)
- `src/db.js` — `saveDocumentMetadata`/`saveDocumentStatement` (897-939, #22's confirmed root cause; deliberately not modified by this phase), `idx_documents_degree_year` (673, confirmed present from Phase A)
- `src/sync.js` — `runEnrichmentBatch` (269-352), the two `saveDocumentMetadata` call sites (317, 340) that trigger #22
- `src/conceptsPipeline.js` — `rebuildConceptDictionary` (508-707, #34 deletion candidate), `scheduleDailyConceptRebuild` (715-731, confirmed dead), `getConceptPipelineStatus`/`persistConceptArtifact` (458-490, confirmed live, unaffected by deletion), the O(P²) clustering loop (561-578, the uncapped extension rule at 572)
- `scripts/rebuild-concepts.js` — the only caller of `rebuildConceptDictionary`, #34 deletion candidate
- `src/server.js` — `scheduleDailyConceptRebuildJob`/`msUntilNextDailyConceptRebuild`/`startConceptRebuildJob` (42-87, 229, the real daily cadence #21 must account for)
- `src/services/adminWorker.js` (83-101), `src/jobWorker.js` (50-79) — confirm every `concept_rebuild` job dispatch path spawns `python3 scripts/build-concepts.py`, never the JS path (#34's wiring evidence)
- `test/adminWorker.test.js` — existing harness patterns this plan's new tests extend: `fanin_harness.py` (1659-1706), `merge_harness.py` (774-854), the incremental-reuse test (559-625), the automatic-publish/retirement test (627-696, the direct precedent for Gate A)
- `test/conceptsPipeline.test.js` — unit tests of `rebuildConceptDictionary`'s private helpers via `_testing`; to be retired if #34's deletion is confirmed
- `docs/phase-a-completion-plan.md`, `docs/phase-b-completion-plan.md` — house style and rigor bar this plan follows
