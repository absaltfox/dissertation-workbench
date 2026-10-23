# Committee / Supervisor Extraction Eval — Design

**Status:** Approved design (2026-09-06). Ready for implementation planning.
**Scope of this document:** Phase 1 (deterministic baseline eval) in full detail; Phase 2
(GLiNER shadow proposer) specified as a separable follow-on that reuses Phase 1 artifacts.
**Non-goal:** This work does **not** modify anything in `src/`. It builds a measurement
harness that imports existing exports and never mutates the production pipeline.

---

## 1. Problem & context

Committee/supervisor extraction underperforms for theses that carry the information neither
in structured metadata nor on a standardized approval page — most visibly **MA (Plan)** and
**History MA** theses. For those, the only signal is prose in the acknowledgements, handled
today by a brittle regex battery (`parseAcknowledgementsDetailed` in `src/pdf.js`).

Prior sessions (in a separate Codex workspace; artifacts not in this repo) benchmarked three
off-the-shelf models — Qwen2.5-1.5B, GLiNER2.5, NuExtract-2.0-2B — on 25 ad-hoc cases. None
was safe as a *deciding* extractor: recall was serviceable but **precision / role-attribution
was the failure mode** (workplace supervisors, government committees, and people merely
"thanked for guidance" were misclassified as thesis roles). The recommendation was a
**deterministic-first hybrid**: rule-based role-cue detection owns role attribution; a small
span-grounded model (GLiNER) only *proposes* names in shadow mode, gated by exact-evidence
validation.

What is missing — and what this project delivers — is a **standardized, reproducible test set
drawn from prod** plus a harness that (a) measures the *existing deterministic baseline* and,
later, (b) quantifies the delta a GLiNER shadow-proposer would add, before committing to any
model integration.

### What this session decided (the four forks)

1. **Scope — sequenced.** Phase 1 baseline (offline-scorable, zero model dependencies) is a
   self-contained deliverable that ships first. Phase 2 GLiNER shadow is specified but
   separable, reusing the same gold set and match library, so a Python/model environment
   cannot block the baseline metric.
2. **Sampling — oversample the failure population.** Deliberately unbalanced toward
   certificate-*absent* MA (Plan)/History docs (the hand-labeled core, target ~40–50), plus a
   modest auto-labelable certificate-*present* reference set to validate the harness. A
   representative/balanced sample would leave the target cell too small to measure.
3. **Run environment — live-connected.** The local `data/metrics.sqlite` (106 docs, mostly
   untargeted degrees) is unusable. The harness samples from **prod Turso** (read-only token
   preferred), pulls full text from **OC / cIRcle**, and **streams the source document from OC**
   where the text derivative is missing. There is no offline shortcut for the online steps.
4. **Degraded/missing text — include, with PDF fallback.** OCR-degraded OC full text stays
   **in-scope** (tagged), because those scanned theses *are* the failure population and *are*
   the real production input. Where the OC text derivative is absent, stream the PDF from OC
   and run the existing extraction. Nothing is excluded from the accuracy population.

---

## 2. Ground-truth strategy (and its one honest limitation)

Ground truth is a **human-verified gold set**. Two label sources feed it:

- **Silver truth (certificate-present docs).** Run `parseCommittee(fullText)` on the
  standardized "the following individuals certify" approval page to produce `{name, role}` per
  member. This is high-precision page-derived data, but it is **not trusted raw** — every
  silver member appears on the human worksheet for confirm/override.
- **Hand labels (certificate-absent docs).** The failure population has no approval page, so
  silver truth does not reach it. These docs are labeled **entirely by hand** from the
  acknowledgements prose. This is the critical path, not a cleanup step.

### The circularity, stated plainly

For certificate-*present* docs, the baseline scorer also runs `parseCommittee`. Scoring
`parseCommittee` output against a gold set *derived from* `parseCommittee` is near-tautological
— those docs will score ~100% by construction. Therefore:

- The certificate-present set exists to **validate the harness** (does it wire up, normalize
  names, and score correctly?), **not** to prove the extractor is good.
- The report **never blends results into one headline number.** The metric that matters is
  **recall (and role precision) on the certificate-absent failure cell.**
- Human verification of the certificate-present silver truth still matters: it catches cases
  where `parseCommittee` itself misreads the page (so the "tautology" is only approximate, and
  we want the residual disagreements surfaced).

---

## 3. Architecture

New directory `scripts/committee-eval/`. Each script is a single-purpose CLI stage; stages
communicate through committed/cached JSON files so any stage can be re-run independently.

```
scripts/committee-eval/
  sample-corpus.mjs     # Stage 1: select the standardized sample from prod Turso
  fetch-fulltext.mjs    # Stage 2: pull OC full text (+ PDF fallback) into the cache
  build-gold.mjs        # Stage 3: auto-label + emit worksheet + --finalize into gold.json
  lib/match.mjs         # Shared name-normalization + set-matching (reused by every scorer)
  score-baseline.mjs    # Stage 4: score existing parseCommittee/parseAcknowledgements
  report.mjs            # Stage 5: comparison table by stratum vs. recorded targets
  # --- Phase 2 (separable) ---
  gliner-propose.py     # Phase 2: GLiNER shadow proposer (spans + roles + confidence)
  score-shadow.mjs      # Phase 2: score GLiNER-only and deterministic-cue+GLiNER hybrid
```

**Committed data** (small, reviewable):
`test/fixtures/committee-eval/manifest.json`, `test/fixtures/committee-eval/gold.json`.

**Cached/derived data** (large, gitignored — lives under `data/`, already gitignored):
OC full text, streamed PDFs, extracted text from PDF fallback, model outputs, raw score dumps.

Only **Stage 1 and Stage 2 require prod connectivity + network.** Stages 3–5 run fully offline
against the committed manifest and the local cache.

### 3.1 Data flow

```
prod Turso ─┐
            ├─ Stage 1 sample-corpus ─► manifest.json (committed)
OC / cIRcle ┘                              │
                                           ▼
                Stage 2 fetch-fulltext ─► cache/*.txt  + coverage.json
                (fetchFullTextForDocument; on null → fetchPdfForDocument + extract)
                                           │
                                           ▼
                Stage 3 build-gold ──────► gold-worksheet.csv ─(human)─► gold.json (committed)
                                           │
                                           ▼
                Stage 4 score-baseline ─► results-baseline.json
                                           │
                                           ▼
                Stage 5 report ─────────► console table + report.json
```

---

## 4. Stage detail — Phase 1

### Stage 1 — `sample-corpus.mjs`

- Connects via `getDb()` (`src/db.js`), which reads `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`
  from `src/config.js`. A **read-only replica token** is preferred. When those env vars are
  unset, `getDb()` falls back to `file:${SQLITE_PATH}` — the harness must **refuse to sample
  from the local file DB** (it is not prod) and error with a clear message unless
  `--allow-local` is explicitly passed for smoke testing.
- **`--discover` mode runs first and is mandatory before fixing filters.** It prints
  `SELECT DISTINCT degree, program, count(*) FROM documents GROUP BY degree, program ORDER BY 3 DESC`
  so the exact stored strings for "MA (Plan)" and "History MA" are confirmed against reality,
  not guessed. (The local DB shows values like bare `MA` and `Scan Route …` noise — prod
  strings must be verified.)
- Reads `documents.metadata_json` for `originalRecordUrl`, `year`, `title`, `author`, `degree`,
  `program`.
- **Stratification (deliberately unbalanced):**
  - Primary target cell — `degree/program ∈ {MA (Plan), History MA}` **and** certificate signal
    absent: sample to a configurable floor (`--target-core`, default ~45).
  - Reference cell — certificate signal present (any targeted degree): sample a modest count
    (`--per-reference`, default ~15) purely to validate the harness.
  - Secondary strata within the target cell: split by **era (pre-2018 vs 2018+)** because era
    selects the `parseAcknowledgements` vs `parseCommittee` code path.
  - `certificateSignal` is a cheap pre-flight heuristic on stored metadata / a light text probe
    (presence of "the following individuals certify"); it is refined for real in Stage 2/3.
- **Emits** `test/fixtures/committee-eval/manifest.json`: one entry per doc —
  `{docId, degree, program, year, title, author, originalRecordUrl, era, certificateSignal,
  stratum}`. The manifest is committed and is the stable spine for every later stage.

### Stage 2 — `fetch-fulltext.mjs`

- For each manifest doc: `loadDocumentMetadata(docId)` (`src/db.js`) →
  `fetchFullTextForDocument(doc, stored, { persistFullText: true })` (`src/pdf.js`). This pulls
  the cIRcle extracted-text derivative and caches it (SHA-based filename under
  `FULL_TEXT_CACHE_DIR`).
- **PDF fallback (fork 4).** `fetchFullTextForDocument` returns `null` when the derivative is
  absent or ≤1000 chars. On `null`, stream the source PDF via `fetchPdfForDocument(doc, …)`
  (`src/pdf.js`) and run the existing text extraction so the doc still enters the accuracy
  population. Record `textSource: 'dspace_text' | 'pdf_fallback'`.
- **Degradation heuristic (tag, never exclude).** Flag `degraded: true` when text is very short
  or shows a high ratio of single-character / space-broken tokens (the same signal
  `normalizeAcknowledgementOcrSpacing` repairs). Degraded docs remain in the accuracy
  population; the flag only drives a separate reporting column.
- **Emits** `coverage.json`: per-doc `{docId, textSource, degraded, byteLength}` plus rollups —
  derivative hit rate, PDF-fallback count, degraded count. Missing-*and*-un-fetchable docs
  (both text and PDF unavailable) are recorded as `unavailable` and reported as a coverage gap.

### Stage 3 — `build-gold.mjs`

- **Auto-label (silver).** For certificate-present docs, run `parseCommittee(fullText)` →
  reference `{name, role}` members.
- **Worksheet.** Emit `gold-worksheet.csv` (+ `.json`) with **one row per (doc, candidate
  name)** covering:
  - every silver-truth member (human `keep=Y/N`, `true_role` override), and
  - every name `parseAcknowledgementsDetailed(fullText)` finds that is **not** on the
    certificate — the false-positive traps (workplace/government/"thanked" names) — pre-marked
    as `negatives` candidates for human confirmation.
  - Columns: `docId, name, proposed_role, on_certificate, source (certificate|acknowledgement),
    keep(Y/N), true_role, is_negative(Y/N)`.
  - **Certificate-absent docs** have no silver rows; the human adds member rows by hand from the
    acknowledgements prose (the worksheet includes the acknowledgements text slice to label from).
- **`--finalize`** merges the human-reviewed worksheet into committed
  `test/fixtures/committee-eval/gold.json`:
  `{docId, members: [{name, role}], negatives: [names that must NOT be extracted]}`.
- Idempotent: re-running `--finalize` on an updated worksheet regenerates `gold.json` cleanly.

### `lib/match.mjs` (shared)

- **Reuses** `normalizePersonName`, `supervisorNameKey`, `stripMiddleInitials`, `namesCompatible`,
  `dedupeSupervisorNames` from `src/supervisors.js`, so name equivalence (middle initials,
  diacritics, "Last, First", honorifics) is scored **identically to production** and cosmetic
  differences are never counted as errors.
- Provides `scoreDoc(predicted, gold)` → per-doc:
  - **name-level** TP/FP/FN (set match under `namesCompatible`),
  - **role-level** TP/FP/FN (role counts only when the name also matches),
  - `exactCase` (predicted name set === gold member name set),
  - `negativeViolations` (predicted names that appear in `gold.negatives`).
- Pure, dependency-free, unit-testable in isolation.

### Stage 4 — `score-baseline.mjs`

- For each in-population doc, **replicate the real full-text merge** exactly as
  `analyzeDocumentFullText` (`src/pdf.js`) does it:
  1. `parseCommittee(fullText)`;
  2. if that yields **no supervisor** (`supervisorsFromCommittee(...).length === 0`), consult
     `parseAcknowledgementsDetailed(fullText)` for the missing supervisor role and any
     committee members the certificate lacked;
  3. dedupe via `dedupeSupervisorNames`.
- Score each doc through `lib/match.mjs`.
- **Emits** `results-baseline.json`: per-doc scores + aggregates, **stratified**, never blended.

### Stage 5 — `report.mjs`

- Merges `results-baseline.json` into a console table + `report.json`, broken out by
  **`certificateSignal × era × degraded × degree`**. Reported measures per cell: name-level
  precision/recall/F1, role-level precision/recall/F1, exact-case rate, negative-violation
  count, and coverage (derivative hit rate, PDF-fallback %, degraded %, unavailable count).
- **Headline discipline:** the report leads with the **certificate-absent failure cell**, labels
  the certificate-present cell as a *harness-validation* figure, and prints a one-line warning
  that the two must not be averaged.
- **Targets, not gates.** Because Phase 1 is measurement, the report *records* the failure-cell
  recall/precision as the **bar Phase 2 must beat**. It does not pass/fail. (Illustrative
  reference points from prior work: ≥95% precision & ≥90% recall on clean passages, zero FP on
  the `negatives` set — used as orientation, not as a Phase 1 gate.)

---

## 5. Phase 2 — GLiNER shadow (separable follow-on)

Specified for continuity; **not** built until Phase 1 baseline numbers justify it. Reuses
`manifest.json`, `gold.json`, the cached text, and `lib/match.mjs` unchanged.

- **`gliner-propose.py`** — Python venv, pinned `transformers==4.52.4` + `protobuf` +
  `sentencepiece` (the working config from the prior GLiNER run). Loads `fastino/gliner2.5-base-v1`
  on CPU. Input: cached full text per doc. Output `results-gliner-raw.json`: candidate person
  spans with char offsets, proposed role label, confidence. **Proposals only — no decisions.**
- **`score-shadow.mjs`** scores two configurations against the same gold:
  - **GLiNER-only** — model spans → names/roles directly (upper-bound false-positive check).
  - **Hybrid (recommended arch)** — deterministic cue detection (reuse `ROLE_PATTERNS` + the
    certificate anchor from `src/pdf.js`) supplies a verified role cue; keep only GLiNER names
    whose offsets fall within the cue's evidence window (**exact-evidence validation**); role
    comes from the deterministic cue, not the model.
- **`report.mjs`** gains a baseline-vs-shadow comparison column per stratum, so the delta on the
  failure cell is read directly against the recorded Phase 1 bar.

---

## 6. Verification

- **Discovery:** `node scripts/committee-eval/sample-corpus.mjs --discover` (creds session)
  prints real degree/program strings; confirm "MA (Plan)" / "History MA" before sampling.
- **Dry run:** `--target-core 3 --per-reference 2` → fetch → build-gold on a few → `score-baseline`
  → `report`; confirm per-stratum counts add up and metrics reproduce across re-runs.
- **Unit tests:** `test/committeeEvalMatch.test.js` (node:test, matching existing `test/` style)
  covers `lib/match.mjs` — name-key equivalence (middle initials, diacritics, "Last, First"),
  role-level matching, exact-case, negative violations.
- **PDF fallback path:** validate on 2–3 docs whose derivative is absent — confirm the PDF
  streams from OC and extracted text enters the population tagged `pdf_fallback`.
- **No regressions:** `npm test` stays green — the harness imports pipeline exports but never
  mutates them.
- **Phase 2 (when built):** validate the GLiNER env on 2–3 docs (pins resolve, spans carry
  offsets) before the full run.

---

## 7. Risks & notes

- **Creds.** Stages 1–2 need a prod (read-only) Turso token + network. Everything else runs
  offline on the cached text + committed manifest/gold. The harness must fail loudly rather than
  silently sampling the local file DB.
- **Hand-labeling is the critical path.** The failure population is hand-labeled by definition;
  the eval's signal on the docs you care about is exactly as good as that labeling. Budget for
  it and keep the worksheet ergonomic (include the acknowledgements text slice inline).
- **OCR-derived OC text.** Scanned theses may yield degraded derivatives; per fork 4 they are
  tagged and reported separately but never dropped, because they are the real production input.
- **Rate/politeness to OC.** Reuse the existing content-request throttling in `src/pdf.js`
  (`PDF_DOWNLOAD_RATE_PER_MIN`) for PDF fallback streaming; do not add a second uncoordinated
  fetch path.
- **`src/` is untouched this session.** The harness only imports existing exports.
