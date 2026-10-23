# Phase C Gate Results

**Parent:** #10 (corpus scaling audit rev 2) · **Phase C issues:** #20, #21, #22, #31, #34, #35
**Gate (#10):** *First-generation global dictionary reachable in a countable number of runs; unchanged rerun is a no-op; fan-in holds through the merge.*
**Branch:** `claude/phase-c-completion-plan` (based on `v2`) · **Integration target:** `v2`

Phase C's gate is about correctness and convergence of the concept pipeline, not throughput, so it is proven by mechanism-level tests that spawn the real `python3 scripts/build-concepts.py` (harness pattern already used by `test/adminWorker.test.js`) — not by an at-scale run. Each gate test was independently confirmed to **fail against pre-Phase-C code** (checkout of `v2`=`f7c1fe4` with the current tests) and to pass post-fix, so the gates are not self-fulfilling.

## Confirmed decisions

- **#21 partition granularity:** the automatic family is coarsened to **degree × decade** (`CONCEPT_PARTITION_GRANULARITY=year` restores exact-year). This brings the first complete generation within tens of runs instead of ~1000+, and reduces #20 and #31 cost.
- **#34 JS pipeline:** the divergent JavaScript clustering path was **deleted** (`rebuildConceptDictionary`, `scheduleDailyConceptRebuild`, `scripts/rebuild-concepts.js`, the `rebuild-concepts` npm script, `test/conceptsPipeline.test.js`). `src/conceptsPipeline.js` retains only its production persistence/status helpers.

## The three gate clauses

### Gate A — first-generation dictionary reachable in a countable number of runs (#20, #21)
- **#20 statement cost is flat:** `discover_partition` steady state issues a small constant number of statements (one `GROUP BY` summary, one bulk fingerprint projection, one bulk `concept_partitions` fetch) — identical for K=5 and K=50 cohorts, where pre-fix it scaled with K (3 statements/cohort). Retirement is an in-memory set-difference over already-fetched data.
- **Countable cold start:** with **phrase-disjoint** cohorts the first global dictionary publishes in exactly K runs, and in fewer runs under decade coarsening than under exact-year.
- **Ripple is bounded and converges:** with **vocabulary-sharing** cohorts (the realistic case), a `save_partition_candidates` DF-crossing ripple can add a small bounded number of re-pending runs; the test asserts runs stay within `K + R` and that a subsequent unchanged rerun re-pends nothing (convergence).

### Gate B — an unchanged rerun is a genuine no-op (#22)
- Partition change-detection now compares a **content fingerprint** of concept-relevant fields (title/abstract/subjects), stored in the new `concept_partitions.content_fingerprint` column, instead of `MAX(updated_at)`.
- An enrichment pass reproducing `sync.js`'s exact double-`saveDocumentMetadata` shape leaves the partition's `status`/`content_fingerprint`/`updated_at` byte-identical (`noChanges: true`) — a true no-op, not merely "no re-embedding." A genuine content change is still detected (`documentsChanged: 1`, new fingerprint). The `ALTER TABLE` migration is idempotent.

### Gate C — fan-in holds through the merge (#31, #35)
- `merge_partition_artifacts` re-enforces the variant-extension fan-in cap over the **global** component graph, mirroring `cluster_phrases`'s distinct-component counting. Three shards each legally keeping 2 extensions of one hub merge to a component that keeps **only the hub itself** (not a 7-member component); the 6 withheld extensions are re-attested as **independent concepts** (lossless — `variantDocFreq` supplies their doc frequency without inventing or double-counting).
- **Telemetry is truthful:** `clusterExtensionHubsSkipped/EdgesSkipped` report only edges that stay withheld through the merge, with `mergeExtensionHubsSkipped/EdgesSkipped` isolating the merge-level withholding.
- **#35 double-count fixed:** a co-stemming surface pair (e.g. "student outcome"/"student outcomes") sharing 4 extensions reports `Hubs=1 / Edges=4` (pre-fix: `2 / 8`). The absorbed-extension set is deduplicated per component root — concatenation alone was verified to reintroduce the double-count.

## Schema

Concept artifact `version` bumped **3 → 4**, additively: `variants` stays a bare string list; `variantRules` (R1/R2/R3 tags) and `variantDocFreq` are new fields. Downstream consumers (`src/metrics.js`, topic labeling) read only `.canonical`/`.docFreq`/`.idf`/`variantToCanonical` — never `.variants` — so the bump requires zero downstream JS changes. `merge_partition_artifacts` recomputes rule classification structurally, so v3 (untagged) and v4 shards merge correctly side by side during the transition.

## Test state

`npm test` → **255 tests, 250 pass / 5 fail**, stable across repeated runs. The 5 failures are the pre-existing `test/pdfParser.test.js` poppler-utils gaps (`pdftotext`/`pdfinfo` absent from the sandbox), unrelated to Phase C and present on `v2`.

## Noted follow-ups (non-blocking, outside Phase C's gate)

- Chunk the `blocked_writes` loop in `discover_partition` so it is O(1) even when many oversized cohorts change blocked-state simultaneously (steady state is already zero-write).
- Add one merge test with an untagged (v3-shaped) shard contributing an **R3 extension** edge, to exercise `classify_variant_rule`'s fallback on the fan-in path directly (the fallback is verified correct by inspection; only R1/R2 legacy shapes are currently exercised by a test).
