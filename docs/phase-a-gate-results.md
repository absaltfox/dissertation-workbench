# Phase A Completion Gate — Measured Results

**Gate (issue #10):** *Per-document cost flat across a 5,000-document run.*
**Plan:** `docs/phase-a-completion-plan.md`, Phase 3 — Full-scale completion-gate measurement.
**Harness:** `scripts/phase-a-scale-gate.mjs`
**Run date:** 2026-08-28 (original run), hardened and re-verified 2026-08-28
**Verdict: PASS.** Both write-path segments show flat per-document SQL-statement count under a tightened, near-deterministic gate — checked against both windowed mean/p95 *and* the full-run running max/p99 — flat wall-clock within a looser secondary bound, and non-accelerating heap growth over the full 5,000-document run.

Reproduce with:

```
node --expose-gc scripts/phase-a-scale-gate.mjs
```

(`--expose-gc` lowers heap-measurement noise; the script runs without it too, with a warning.) Full JSON report goes to stdout; progress goes to stderr. Exit code is non-zero if any metric fails its flatness verdict.

---

## 0. Hardening pass (2026-08-28): two weaknesses closed, re-verified

An independent review of this harness confirmed it genuinely exercises the real write path and that the #10 gate **is met** for the current code, but flagged two weaknesses in the harness itself, as a standing regression gate (not a Phase A code defect). Both are now closed in `scripts/phase-a-scale-gate.mjs`; §2/§3 below report the numbers under the fixed harness, and §7 documents the failure-detector proof.

**Fix 1 — the statement counter no longer counts a multi-statement batch as 1.** `installStatementCounter` (`scripts/phase-a-scale-gate.mjs:120-155`) previously incremented its counter by exactly 1 for both `client.execute(...)` and `client.batch(array)`, regardless of `array.length` — the same "blind to intra-call cost" gap Phase 2 already had to fix once. A `client.batch([...500 statements])` call would have counted as "1" no differently than a single `execute`. The counter now reads `array.length` off the batch's first argument and adds that many statements; `client.execute` still adds 1. A separate `roundTrips` count (informational only, not gated on) is kept alongside for anyone who wants actual call-count visibility. **This changed the reported enrichment statement count from 12/batch to 14/batch** (real extra statements bundled inside a `client.batch()` call were always being issued and executed — the code was never wrong, only the counter was blind to 2 of the 14 actual statements). Citation counts were unaffected (that path's batches already ran with the same statement shape throughout).

**Fix 2 — the pass criterion is now tight on statement count and gates on the running max/p99, not just windowed mean/p95.** `flatVerdict` previously compared only early-vs-late window mean/p95 against a loose `2×+slack` bound, for both statement count and wall-clock, and `runningMax` was computed but never fed into `pass`. Per the review, this bound would pass a 30-90% per-document regression outright (2× is a *doubling*, not a small-constant-factor check), and a regression confined to the untested middle of the run (neither early nor late window) would never be seen at all. Fixed as follows (`scripts/phase-a-scale-gate.mjs:50-81`, `:181-210`):

- **SQL statement count is now the PRIMARY gate**, at a tight `1.15×early-mean + 1` bound (`FLAT_FACTOR_STATEMENTS = 1.15`, `FLAT_SLACK_STATEMENTS = 1`). Statement count is measured against an in-process libsql/SQLite connection with no network hop, so it is near-deterministic — repeated runs at both 300 and 5,000 documents showed at most a 1-statement single-sample wobble. A tight factor is therefore both safe (doesn't flake on real noise) and necessary (able to actually catch a regression well under 2×). The verdict is now checked against **both** the windowed early/late mean/p95 **and** the full-run running max and p99 (`statements.full`, `statements.verdict.runningMaxFlat`/`p99Flat` in the JSON) — so a spike anywhere in the run, not just in the sampled late window, fails the gate.
- **Wall-clock stays a SECONDARY signal at the original loose `2×+slack` bound**, windowed mean/p95 only (no running-max/p99 gating). This sandbox has real run-to-run CPU/scheduler jitter unrelated to the code under test — observed directly while building this harness and independently by the reviewer — so gating wall-clock at statement-count tightness would make the gate flake on sandbox noise rather than signal a real regression. Wall-clock running max is still reported in the JSON for visibility; it just isn't a pass/fail input.
- Heap (bounded/decelerating) and the EXPLAIN-plan check remain pass conditions, unchanged in intent.

**Re-verification (§7):** confirms (a) the real code still passes under the tightened gate at the full 5,000-document scale, and (b) an artificially injected ~30% per-document statement/wall-clock growth — injected only in the measurement loop, never in `src/` — now flips `overallPass` to `false` with a non-zero exit code, where the **old, loose gate would have rated the same injected regression a PASS**.

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
| Sampling | **Dense — every document/batch**, not 4 discrete points | Directly satisfies the plan's "sample densely, not at 4 points" requirement; running max and p99 are now computed over the full 5,000-point series and gated on (§0), not just reported. |
| Heap sampling | Every 100 docs, with `global.gc()` forced immediately before each sample (when `--expose-gc` is available) | Reduces V8 generational-GC noise so a real memory trend is distinguishable from allocation churn. |

---

## 2. Citation segment — `saveCitations` / `reextractDocumentCitations`

Real production path: `db.reextractDocumentCitations(docId, citations, normalizeCitation)`, using the actual `normalizeCitation` hash from `src/pdf.js` (the same function the real PDF-import path calls at `src/pdf.js:2134`) — not a test stub hash, per the Phase 1 plan's warning about hash functions that silently short-circuiting the fuzzy matcher.

Windows: **early** = docs 100–1000 (n=900), **late** = docs 4000–5000 (n=1000), **full** = all 5,000 docs. Statement-count bound = early mean × 1.15 + 1 (tight, primary); wall-clock bound = early mean × 2 + 5 (loose, secondary).

| Metric | Early mean | Late mean | Early p95 | Late p95 | Running max (full run) | Full-run p99 | Bound | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|:---:|
| SQL statements/doc | 53.63 | 53.00 | 56 | 56 | 62 | 56 | 62.67 | **PASS** |
| Wall-clock ms/doc | 53.53 | 50.53 | 89.49 | 60.92 | 189.97 | — (secondary, not gated) | 112.06 | **PASS** |

- Statement count is essentially flat: late mean is actually *lower* than early mean (53.00 vs 53.63), p95 identical (56 vs 56), and the full-run running max (62) sits just inside the tight 62.67 bound. This is the tightest passing margin in the whole report (≈1%), and it is **not** noise — the corpus generator is fully deterministic (no `Math.random`), so this 62-statement peak reproduces exactly run to run (confirmed identical at both the 300-doc smoke scale and the 5,000-doc full scale). It comes from a rare hash-bucket-widening case in the synthetic corpus, not from any accumulating cost. The full-run p99 (56) is comfortably inside the bound, confirming the 62-peak is a true one-off, not a plateau.
- Wall-clock (secondary signal) actually *fell* slightly from early to late (53.53ms → 50.53ms mean), comfortably inside its loose bound. The 189.97ms running-max wall-clock outlier is consistent with a one-off GC/scheduler pause (this sandbox's known jitter, §0) and is exactly why wall-clock is not used for the tight running-max/p99 gate.

**Heap:** start 8.1MB → end 8.8MB (0.8MB total growth over 5,000 docs). First-half growth (0.6MB) exceeds second-half growth (0.2MB) — heap use is *decelerating*, not accelerating. No blow-up.

---

## 3. Enrichment segment — `runDocumentSync` / `drainLocalEnrichmentQueue` / `listDocumentsPendingEnrichment`

Sparse-pending-tail corpus (§1): 30,000 total document rows, 5,000 of them the "our sync key, pending" documents actually drained, one per batch.

Windows: same as above (batch index 100–1000 vs 4000–5000).

| Metric | Early mean | Late mean | Early p95 | Late p95 | Running max (full run) | Full-run p99 | Bound | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|:---:|
| SQL statements/batch | 14.00 | 14.00 | 14 | 14 | 15 | 14 | 17.10 | **PASS** |
| Wall-clock ms/batch | 22.24 | 25.34 | 26.73 | 28.77 | 212.66 | — (secondary, not gated) | 49.48 | **PASS** |

- Statement count is effectively flat at **14 statements/batch** for both the early and late windows, with a full-run running max of just 15 (a single-sample +1 wobble) against a 17.10 bound — a comfortable margin unlike the citations segment's razor-thin one. (Note: this is 14, not the 12 reported prior to this hardening pass — see §0 Fix 1. The underlying code did not change; the counter was simply blind to real statements bundled inside a `client.batch()` call.)
- Wall-clock (secondary) rose ~14% mean, well inside its loose bound; the 212.66ms running-max outlier is consistent with sandbox scheduler jitter and, again, is why wall-clock does not gate on running max/p99.

**Heap:** start 9.4MB → end 10.1MB (0.7MB total growth over 5,000 batches). First-half growth (0.5MB) exceeds second-half growth (0.3MB) — decelerating, not accelerating. No blow-up.

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

| Segment | Statements flat (windowed) | Statements flat (running max/p99) | Wall-clock flat (secondary) | Heap non-accelerating | EXPLAIN plan clean | Segment pass |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Citations (`saveCitations`/`reextractDocumentCitations`) | yes | yes | yes | yes | n/a | **PASS** |
| Enrichment (`runDocumentSync`/`drainLocalEnrichmentQueue`/`listDocumentsPendingEnrichment`, sparse-pending-tail) | yes | yes | yes | yes | yes (doc_id PK scan both ends, no `idx_documents_sync_key` fallback, no temp b-tree) | **PASS** |

**The #10 completion gate — "per-document cost flat across a 5,000-document run" — is met**, with dense per-document/per-batch evidence (not 4 point samples), against an adversarial sparse-pending-tail corpus, under a tightened statement-count gate that also checks the full-run running max and p99 (not just windowed samples), with heap growth tracked and found non-accelerating.

---

## 7. Failure-detector proof: the tightened gate catches a regression the old gate missed

To confirm the tightened gate (§0) actually closes the gap the review flagged — and doesn't just look stricter on paper — a temporary, harness-only injection was added to the measurement loop (never to `src/`): after each real measurement, the recorded statement-count and wall-clock samples were scaled by a factor growing linearly from 1.0× at document/batch 0 to 1.3× at the last document/batch, simulating a genuine ~30% per-document cost regression appearing gradually across the run (the realistic shape of a regression, not a single spike). This was run at `PHASE_A_GATE_DOCS=300` for iteration speed (the injection is a simple linear scaling independent of corpus size, so the 300-doc scale is representative of the effect at 5,000), confirmed to flip the gate, and then **fully removed** — `scripts/phase-a-scale-gate.mjs` in this repository contains no injection code; `git diff` against this hardening pass shows only the two real fixes described in §0.

**Result: `overallPass` flipped to `false`, exit code 1.**

| Segment | Early mean | Late mean | Full-run running max | Full-run p99 | Tight bound | Old (pre-fix) 2×+slack bound |
|---|---:|---:|---:|---:|---:|---:|
| Citations statements/doc | 59.34 | 69.87 (+17.7%) | 72.80 | 72.41 | 69.24 | 121.68 |
| Enrichment statements/batch | 14.84 | 17.59 (+18.5%) | 19.50 | 18.16 | 18.07 | 32.68 |

- **Citations**: caught by the windowed mean/p95 comparison alone — `meanFlat: false`, `p95Flat: false` (late mean 69.87 > bound 69.24) — *and* by the running-max/p99 check.
- **Enrichment — the case that specifically proves the running-max/p99 wiring matters**: the windowed mean/p95 comparison **passed** (`meanFlat: true, p95Flat: true` — late mean 17.59 and p95 18.14 both still fit under the loose-looking-but-actually-fine 18.07/18.49 window bounds, because the early window itself had already started drifting upward under the gradual injected ramp). It was **only** the full-run running-max/p99 check that caught it: `runningMaxFlat: false, p99Flat: false` (running max 19.50 and p99 18.16, both over the 18.07 bound). This is exactly the failure mode the review named — a regression that a windowed-only check can miss — and it is exactly what wiring `runningMax`/p99 into `pass` (§0 Fix 2) was for.
- **Under the OLD, pre-hardening 2×+slack bound, both segments would have been rated PASS** despite the 30% injected regression (citations: late mean 69.87 ≤ old bound 121.68; enrichment: late mean 17.59 ≤ old bound 32.68) — concretely demonstrating the gap the independent review flagged, and that this hardening pass closes it.

Reproduce this proof yourself (temporarily) by re-adding an injection identical in spirit to the one described above; it is deliberately not left in the shipped harness since a "self-test" flag on a production gate script is itself a footgun (an accidental env var left set in CI would silently corrupt every real run).

---

## 8. Full raw report (current, hardened harness, 5,000 docs, real code — no injection)

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
    "flatFactorStatements": 1.15,
    "flatFactorWall": 2,
    "exposedGc": true
  },
  "segments": {
    "citations": {
      "totalDocsOrBatches": 5000,
      "totalSegmentSeconds": 249.3,
      "statements": {
        "early": { "mean": 53.63, "p50": 56, "p95": 56, "p99": 56, "max": 56, "n": 900 },
        "late": { "mean": 53, "p50": 53, "p95": 56, "p99": 56, "max": 56, "n": 1000 },
        "full": { "mean": 53.18, "p50": 53, "p95": 56, "p99": 56, "max": 62, "n": 5000 },
        "verdict": {
          "pass": true, "meanFlat": true, "p95Flat": true,
          "bound": 62.67, "p95Bound": 65.4,
          "runningMax": 62, "p99": 56, "runningMaxFlat": true, "p99Flat": true
        }
      },
      "wallMs": {
        "early": { "mean": 53.53, "p50": 47.69, "p95": 89.49, "p99": 113.17, "max": 154.996, "n": 900 },
        "late": { "mean": 50.53, "p50": 49.6, "p95": 60.92, "p99": 82.57, "max": 189.97, "n": 1000 },
        "runningMax": 189.97,
        "verdict": { "pass": true, "meanFlat": true, "p95Flat": true, "bound": 112.06, "p95Bound": 183.98 }
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
      "totalSegmentSeconds": 120.8,
      "statements": {
        "early": { "mean": 14, "p50": 14, "p95": 14, "p99": 14, "max": 14, "n": 900 },
        "late": { "mean": 14, "p50": 14, "p95": 14, "p99": 14, "max": 15, "n": 1000 },
        "full": { "mean": 14, "p50": 14, "p95": 14, "p99": 14, "max": 15, "n": 5000 },
        "verdict": {
          "pass": true, "meanFlat": true, "p95Flat": true,
          "bound": 17.1, "p95Bound": 17.1,
          "runningMax": 15, "p99": 14, "runningMaxFlat": true, "p99Flat": true
        }
      },
      "wallMs": {
        "early": { "mean": 22.24, "p50": 21.66, "p95": 26.73, "p99": 32.12, "max": 69.78, "n": 900 },
        "late": { "mean": 25.34, "p50": 24.88, "p95": 28.77, "p99": 35.1, "max": 67.59, "n": 1000 },
        "runningMax": 212.66,
        "verdict": { "pass": true, "meanFlat": true, "p95Flat": true, "bound": 49.48, "p95Bound": 58.46 }
      },
      "heap": {
        "startMB": 9.4, "endMB": 10.1, "peakMB": 10.1,
        "totalGrowthMB": 0.7, "firstHalfGrowthMB": 0.5, "secondHalfGrowthMB": 0.3,
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
