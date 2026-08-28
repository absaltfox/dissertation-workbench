# Phase A Completion Gate — Measured Results

**Gate (issue #10):** *Per-document cost flat across a 5,000-document run.*
**Plan:** `docs/phase-a-completion-plan.md`, Phase 3 — Full-scale completion-gate measurement.
**Harness:** `scripts/phase-a-scale-gate.mjs`
**Run date:** 2026-08-28
**Verdict: PASS.** Both write-path segments show flat per-document statement count, flat wall-clock within the plan's "small constant factor" bound, and non-accelerating heap growth over the full 5,000-document run.

Reproduce with:

```
node --expose-gc scripts/phase-a-scale-gate.mjs
```

(`--expose-gc` lowers heap-measurement noise; the script runs without it too, with a warning.) Full JSON report goes to stdout; progress goes to stderr. Exit code is non-zero if any metric fails its flatness verdict.

---

## 1. Corpus parameters used, and why

| Parameter | Value | Rationale |
|---|---|---|
| Documents per segment | **5,000** | Literal gate scale from issue #10 / the plan. Citations and enrichment are measured as two separate 5,000-document passes (see §4) because they stress different mechanisms — the citation fuzzy-match bucket cache vs. the enrichment doc_id-ordered scan — and conflating them would make it harder to attribute a regression to the right code path. |
| Citations per document | **15** (scaled down from the ~40/doc order-of-magnitude the plan suggests) | A timing probe at 40 refs/doc measured ~146ms/doc (≈12 min for 5,000 docs); at 15 refs/doc it measured ~30–60ms/doc (≈4.5 min for 5,000 docs), keeping the whole harness runnable in a single sandbox session while still exercising the same fuzzy-match SQL path per reference. The plan explicitly allows scaling down refs/doc "if 5,000×40 is too slow in-sandbox." |
| Citation prefix diversity | ~17,576 distinct 3-letter surname prefixes (26³) | See the pathological-corpus note in §5 — this was **not** an arbitrary choice, it's load-bearing for the gate meaning what it claims to mean. |
| Citation mix | ~20% drawn from a 300-item shared pool (exact-hash match), ~80% brand-new unique text (misses the hash, exercises the real fuzzy-match SQL query) | Mirrors a real corpus where some works are cited by many dissertations and most references are not. |
| Enrichment corpus shape | Sparse pending tail: **3 other-sync-key "noise" rows + 2 already-satisfied own-sync-key rows before every single pending document**, for all 5,000 pending documents (30,000 total rows) | This is the adversarial shape the plan calls out by name: `listDocumentsPendingEnrichment`'s `+d.sync_key` hint (db.js ~2212–2228) forces the scan onto the doc_id primary key instead of an index lookup, so a corpus where a rule's own pending work is a sparse minority behind dense already-handled rows is exactly the case that could make per-page cost scale with total corpus size instead of staying O(pageLimit). |
| Enrichment batch size | **1** (one pending document drained per `runDocumentSync` call) | Maximizes sample density — every one of the 5,000 pending documents gets its own statement-count/wall-clock/heap sample, not just 4 discrete batch checkpoints. |
| Sampling | **Dense — every document/batch**, not 4 discrete points | Directly satisfies the plan's "sample densely, not at 4 points" requirement; running max and p95 are computed over the full 5,000-point series. |
| Heap sampling | Every 100 docs, with `global.gc()` forced immediately before each sample (when `--expose-gc` is available) | Reduces V8 generational-GC noise so a real memory trend is distinguishable from allocation churn. |

---

## 2. Citation segment — `saveCitations` / `reextractDocumentCitations`

Real production path: `db.reextractDocumentCitations(docId, citations, normalizeCitation)`, using the actual `normalizeCitation` hash from `src/pdf.js` (the same function the real PDF-import path calls at `src/pdf.js:2134`) — not a test stub hash, per the Phase 1 plan's warning about hash functions that silently short-circuit the fuzzy matcher.

Windows: **early** = docs 100–1000 (n=900), **late** = docs 4000–5000 (n=1000). Flatness bound = early mean/p95 × 2 + slack.

| Metric | Early mean | Late mean | Early p95 | Late p95 | Running max | Bound (mean) | Verdict |
|---|---:|---:|---:|---:|---:|---:|:---:|
| SQL statements/doc | 53.63 | 53.00 | 56 | 56 | 62 | 110.3 | **PASS** |
| Wall-clock ms/doc | 46.64 | 56.48 | 58.32 | 80.04 | 244.81 | 98.3 | **PASS** |

- Statement count is essentially flat — late mean is actually *lower* than early mean (53.0 vs 53.6), with p95 identical (56 vs 56).
- Wall-clock rose ~21% (mean) / ~37% (p95) from early to late, comfortably inside the 2×+slack bound (98.3 / 121.6). This modest rise is consistent with the citations table itself growing (more total rows to touch in the exact-hash `IN` lookup even though each fuzzy-match bucket stays capped), not with unbounded scan cost.
- The single 244.81ms wall-clock outlier (running max) is a one-off spike (likely a GC pause), not a plateau — it does not appear in the p95, and is a single occurrence across 5,000 samples.

**Heap:** start 8.1MB → end 8.8MB (0.8MB total growth over 5,000 docs, i.e. ~0.16KB/doc). First-half growth (0.6MB) exceeds second-half growth (0.2MB) — heap use is *decelerating*, not accelerating. No blow-up.

---

## 3. Enrichment segment — `runDocumentSync` / `drainLocalEnrichmentQueue` / `listDocumentsPendingEnrichment`

Sparse-pending-tail corpus (§1): 30,000 total document rows, 5,000 of them the "our sync key, pending" documents actually drained, one per batch.

Windows: same as above (batch index 100–1000 vs 4000–5000).

| Metric | Early mean | Late mean | Early p95 | Late p95 | Running max | Bound (mean) | Verdict |
|---|---:|---:|---:|---:|---:|---:|:---:|
| SQL statements/batch | 12.00 | 12.00 | 12 | 12 | 13 | 27 | **PASS** |
| Wall-clock ms/batch | 23.06 | 26.76 | 29.52 | 31.37 | 73.87 | 51.1 | **PASS** |

- Statement count is **exactly flat**: 12 statements per batch at both the start and the end of the run, under a 3:1 filler-to-pending ratio corpus, with a running max of just 13 across all 5,000 batches.
- Wall-clock rose ~16% (mean), well inside bound.

**Heap:** start 9.4MB → end 10.1MB (0.8MB total growth over 5,000 batches). First-half growth (0.5MB) exceeds second-half growth (0.3MB) — decelerating, not accelerating. No blow-up.

**EXPLAIN QUERY PLAN, captured at batch 1 and batch 5000** (directly answering the plan's "statement count alone is blind to scan cost" concern):

```
Batch 1 (no cursor yet):
  SCAN d USING INDEX sqlite_autoindex_documents_1
  SEARCH fm USING INDEX sqlite_autoindex_file_metrics_1 (doc_id=?) LEFT-JOIN
  SEARCH ea USING INDEX sqlite_autoindex_enrichment_attempts_1 (doc_id=?) LEFT-JOIN

Batch 5000 (cursor present):
  SEARCH d USING INDEX sqlite_autoindex_documents_1 (doc_id>?)
  SEARCH fm USING INDEX sqlite_autoindex_file_metrics_1 (doc_id=?) LEFT-JOIN
  SEARCH ea USING INDEX sqlite_autoindex_enrichment_attempts_1 (doc_id=?) LEFT-JOIN
```

Both plans stay on the doc_id primary key (`sqlite_autoindex_documents_1`) — batch 1 correctly bounded-scans from the start, batch 5000 correctly seeks via the cursor. **Neither plan falls back to `idx_documents_sync_key`, and neither needs a temp b-tree sort** — confirming the `+d.sync_key` de-index trick (db.js ~2212–2228) still holds at 5,000-document, sparse-pending-tail scale, exactly as Phase 2's smaller-scale unit test (`test/enrichmentContinuation.test.js`) already established, now reproduced at the literal gate scale.

---

## 4. Design note: citations and enrichment are measured as two separate 5,000-document passes, not one shared corpus

The plan's requirement 1 asks for both the citation write path and the enrichment/sync write path to be exercised "end-to-end over ~5,000 synthetic documents." This harness runs each as its own full 5,000-document pass (using distinct doc-id namespaces, `gate-cite-*` and `gate-enrich-*`) rather than threading one shared 5,000-document corpus through both, because:

- `document_citations` has no foreign key to `documents` (checked directly in `src/db.js`'s schema), so citations can be saved for a `docId` that was never seeded into `documents` at all — the existing test suite (`test/catalogueFailures.test.js`) already relies on this.
- The two mechanisms are governed by unrelated cost drivers: citation cost is bounded by `(match_prefix, match_year)` bucket size in the `citations` table; enrichment-scan cost is bounded by intervening-row count in the `documents` table under `+d.sync_key`. Keeping them as separate passes makes a regression in either one unambiguous to attribute, rather than needing to disentangle which mechanism a shared corpus's cost growth came from.

Both passes still cover exactly "~5,000 documents," matching the gate's literal scale.

---

## 5. A pathological-corpus pitfall found and corrected while building this harness (not a Phase A defect)

An early draft of the citation-corpus generator gave every synthetic citation the literal text prefix `"Author..."`, so **every citation collapsed onto the same `match_prefix` value**, leaving only `match_year` (60 distinct values) to spread the corpus across buckets. Measured on that draft generator, per-document cost grew from ~30ms/doc to ~64ms/doc over just 1,500 documents — a real upward trend.

This is **not a Phase A code defect** — it is precisely the "pathological concentration" scenario Phase 1 / #11's design notes (`docs/phase-a-completion-plan.md` §1d) already identify as the one case where `(prefix, year)` bucket narrowing can't help, and where the cap + refuse-on-saturation safety net exists specifically to keep it *safe* (no wrong merges) rather than *fast*. It says nothing about whether the gate holds for a realistic corpus.

The fix (used in the harness as shipped) spreads citations across ~17,576 distinct 3-letter prefixes, matching realistic bibliographic diversity. Re-measured on the corrected generator, cost was flat from the first 100 docs through 1,500 docs (30ms/doc → 30ms/doc), which is the number reported in the timing-probe work that led to this harness's final design. This is called out here for transparency, since it directly demonstrates the harness *would* have caught a real flatness violation had one existed, rather than being structurally incapable of detecting one.

**Action item (non-blocking, not part of this gate):** the existing plan already recommends (§1d) alerting on the production `truncatedBuckets` telemetry counter for exactly this scenario in real data; nothing new to add here.

---

## 6. Overall verdict

```json
"overallPass": true
```

| Segment | Statements flat | Wall-clock flat | Heap non-accelerating | EXPLAIN plan clean | Segment pass |
|---|:---:|:---:|:---:|:---:|:---:|
| Citations (`saveCitations`/`reextractDocumentCitations`) | yes | yes | yes | n/a | **PASS** |
| Enrichment (`runDocumentSync`/`drainLocalEnrichmentQueue`/`listDocumentsPendingEnrichment`, sparse-pending-tail) | yes | yes | yes | yes (doc_id PK scan both ends, no `idx_documents_sync_key` fallback, no temp b-tree) | **PASS** |

**The #10 completion gate — "per-document cost flat across a 5,000-document run" — is met, with dense per-document/per-batch evidence (not 4 point samples), against an adversarial sparse-pending-tail corpus, with heap growth tracked and found non-accelerating.**

---

## 7. Full raw report

<details>
<summary>Click to expand the exact JSON emitted by the run behind this report</summary>

```json
{
  "config": {
    "docCount": 5000,
    "refsPerDoc": 15,
    "noisePerPending": 3,
    "satisfiedPerPending": 2,
    "earlyWindow": [100, 1000],
    "lateWindow": [4000, 5000],
    "flatFactor": 2,
    "exposedGc": true
  },
  "segments": {
    "citations": {
      "totalDocsOrBatches": 5000,
      "totalSegmentSeconds": 259,
      "statements": {
        "early": { "mean": 53.63, "p50": 56, "p95": 56, "max": 56, "n": 900 },
        "late": { "mean": 53, "p50": 53, "p95": 56, "max": 56, "n": 1000 },
        "runningMax": 62,
        "verdict": { "pass": true, "meanFlat": true, "p95Flat": true, "bound": 110.26, "p95Bound": 115 }
      },
      "wallMs": {
        "early": { "mean": 46.64, "p50": 45.78, "p95": 58.32, "max": 122.97, "n": 900 },
        "late": { "mean": 56.48, "p50": 54.19, "p95": 80.04, "max": 244.81, "n": 1000 },
        "runningMax": 244.81,
        "verdict": { "pass": true, "meanFlat": true, "p95Flat": true, "bound": 98.28, "p95Bound": 121.64 }
      },
      "heap": {
        "startMB": 8.1, "endMB": 8.8, "peakMB": 8.8,
        "totalGrowthMB": 0.8, "firstHalfGrowthMB": 0.6, "secondHalfGrowthMB": 0.2,
        "accelerating": false, "samples": 51
      },
      "pass": true
    },
    "enrichment": {
      "totalDocsOrBatches": 5000,
      "totalSegmentSeconds": 125.5,
      "statements": {
        "early": { "mean": 12, "p50": 12, "p95": 12, "max": 12, "n": 900 },
        "late": { "mean": 12, "p50": 12, "p95": 12, "max": 13, "n": 1000 },
        "runningMax": 13,
        "verdict": { "pass": true, "meanFlat": true, "p95Flat": true, "bound": 27, "p95Bound": 27 }
      },
      "wallMs": {
        "early": { "mean": 23.06, "p50": 22.23, "p95": 29.52, "max": 73.87, "n": 900 },
        "late": { "mean": 26.76, "p50": 26.25, "p95": 31.37, "max": 70.66, "n": 1000 },
        "runningMax": 73.87,
        "verdict": { "pass": true, "meanFlat": true, "p95Flat": true, "bound": 51.12, "p95Bound": 64.03 }
      },
      "heap": {
        "startMB": 9.4, "endMB": 10.1, "peakMB": 10.2,
        "totalGrowthMB": 0.8, "firstHalfGrowthMB": 0.5, "secondHalfGrowthMB": 0.3,
        "accelerating": false, "samples": 51
      },
      "pass": true,
      "totalRows": 30000,
      "pendingCount": 5000,
      "explainPlans": [
        {
          "i": 0,
          "details": [
            "SCAN d USING INDEX sqlite_autoindex_documents_1",
            "SEARCH fm USING INDEX sqlite_autoindex_file_metrics_1 (doc_id=?) LEFT-JOIN",
            "SEARCH ea USING INDEX sqlite_autoindex_enrichment_attempts_1 (doc_id=?) LEFT-JOIN"
          ]
        },
        {
          "i": 4999,
          "details": [
            "SEARCH d USING INDEX sqlite_autoindex_documents_1 (doc_id>?)",
            "SEARCH fm USING INDEX sqlite_autoindex_file_metrics_1 (doc_id=?) LEFT-JOIN",
            "SEARCH ea USING INDEX sqlite_autoindex_enrichment_attempts_1 (doc_id=?) LEFT-JOIN"
          ]
        }
      ],
      "badPlanFallbacks": 0
    }
  },
  "overallPass": true
}
```

</details>
