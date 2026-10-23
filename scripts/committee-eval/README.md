# Committee / Supervisor Extraction Eval

Measures the deterministic committee/supervisor extractor against a human-verified gold set,
weighted toward the MA (Plan)/History MA failure population. Nothing here modifies `src/`.

## Prerequisites
- A **read-only** prod Turso token exported as `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`
  (Stages 1–2 only). Without them the sampler refuses to run (pass `--allow-local` for smoke tests).

## Pipeline
1. **Discover real degree strings (do this first):**
   `node scripts/committee-eval/sample-corpus.mjs --discover`
2. **Sample** (confirm exact strings from step 1). Each `--targets` value is a degree,
   optionally narrowed to a program with `::Program` — required when a degree string is
   shared across programs (History is `Master of Arts - MA::History`). `--per-era` caps docs
   per (target × era), so both the pre-2018 failure population and the 2018+ certificate-bearing
   regime are deliberately sampled:
   `node scripts/committee-eval/sample-corpus.mjs --targets "Master of Arts in Planning - MA (Plan)" "Master of Arts - MA::History" --per-era 25`
3. **Fetch full text** (+ PDF fallback): `node scripts/committee-eval/fetch-fulltext.mjs`
4. **Build worksheet:** `node scripts/committee-eval/build-gold.mjs`
   → hand-review `data/committee-eval/gold-worksheet.csv` (fill `keep`, `true_role`, `is_negative`;
   add member rows for certificate-absent docs using the `ack_slice` column), save back to
   `data/committee-eval/gold-worksheet.json`. The `oc_url` column links each row to its Open
   Collections item page (`open.library.ubc.ca/collections/ubctheses/items/<docId>`) so you can
   open and verify the PDF directly. Docs with no auto-detected committee/supervisor appear as a
   single placeholder row (`source=none`) so the failure population stays visible for labeling.
5. **Finalize gold:** `node scripts/committee-eval/build-gold.mjs --finalize`
6. **Score baseline:** `node scripts/committee-eval/score-baseline.mjs`
7. **Report:** `node scripts/committee-eval/report.mjs`

## Reading the report
Lead with the **FAILURE POPULATION (nocert)** table. The **cert** table is harness validation only
(parseCommittee scored against parseCommittee-derived gold) — never average the two. Record the
nocert recall as the bar Phase 2 (GLiNER shadow) must beat.

## Known limitations
- The pre-fetch certificate signal used for sampling is a proxy:
  `certificateSignalGuess = (year >= 2018)`, because the standardized approval page is a ~2018+
  artifact. Consequently the hand-labeled **core** sample is always pre-2018; a genuine **2018+
  thesis with no approval page** is placed in the (small, capped) `reference` bucket rather than
  the core. Scoring remains honest — such a doc is still scored and lands in the
  `nocert:2018plus:*` stratum — but the core sample under-represents it. **When reviewing the
  generated `manifest.json` during the live run, manually add any 2018+ certificate-absent
  MA(Plan)/History docs you care about to the core sample.** A fully general fix would require
  two-pass sampling (fetch text, then stratify on the real certificate signal), which is
  intentionally out of scope for this phase.
