# Committee / Supervisor Extraction Eval

Measures the deterministic committee/supervisor extractor against a human-verified gold set,
weighted toward the MA (Plan)/History MA failure population. Nothing here modifies `src/`.

## Prerequisites
- A **read-only** prod Turso token exported as `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`
  (Stages 1–2 only). Without them the sampler refuses to run (pass `--allow-local` for smoke tests).

## Pipeline
1. **Discover real degree strings (do this first):**
   `node scripts/committee-eval/sample-corpus.mjs --discover`
2. **Sample** (confirm exact strings from step 1):
   `node scripts/committee-eval/sample-corpus.mjs --degrees "MA (Plan)" "History MA" --target-core 45 --per-reference 15`
3. **Fetch full text** (+ PDF fallback): `node scripts/committee-eval/fetch-fulltext.mjs`
4. **Build worksheet:** `node scripts/committee-eval/build-gold.mjs`
   → hand-review `data/committee-eval/gold-worksheet.csv` (fill `keep`, `true_role`, `is_negative`;
   add member rows for certificate-absent docs using the `ack_slice` column), save back to
   `data/committee-eval/gold-worksheet.json`.
5. **Finalize gold:** `node scripts/committee-eval/build-gold.mjs --finalize`
6. **Score baseline:** `node scripts/committee-eval/score-baseline.mjs`
7. **Report:** `node scripts/committee-eval/report.mjs`

## Reading the report
Lead with the **FAILURE POPULATION (nocert)** table. The **cert** table is harness validation only
(parseCommittee scored against parseCommittee-derived gold) — never average the two. Record the
nocert recall as the bar Phase 2 (GLiNER shadow) must beat.
