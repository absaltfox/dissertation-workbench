# GLiNER Shadow-Proposer — Integration Design (edge-case exploration)

**Status:** design exploration / spike output (2026-09). Not yet a build decision.
**Context:** After Levers A+B+C1, deterministic `parseAcknowledgements` recall on the gold rose
16% → 42% with clean precision. The residual misses cluster into cases regex structurally cannot
solve. This memo evaluates whether a GLiNER span-NER model, used as a **shadow proposer**, addresses
them — and how it would integrate without regressing precision.
**Prior art:** design §5 (`2026-09-06-committee-extraction-eval-design.md`); the prior benchmark that
found off-the-shelf models unsafe as *deciding* extractors (recall serviceable; **role attribution
was the failure mode**). Findings this memo targets: F-2d (name-boundary merges), F-2c (section/OCR),
and the deliberately-skipped weak-role / untitled-list cases.

---

## 1. The core principle (unchanged from the prior benchmark's lesson)

GLiNER is a **span proposer, never a decider.** The deterministic layer keeps ownership of **role
attribution** (who is a Supervisor vs merely thanked) because that is precisely where the models
failed the benchmark. GLiNER contributes only what regex is bad at: **finding and bounding person
name spans.** Every accepted name must still be tied to a role by a deterministic cue and validated
against the source text (exact-evidence). This keeps the precision guarantees Levers A/B established.

## 2. Edge case → GLiNER fit

| Case (finding) | Why regex fails | GLiNER fit | How it helps |
|---|---|---|---|
| **F-2d** name-boundary merge ("Joy Dixon Peter Parker") | capitalization can't split one 4-token name from two names | **Strong** | GLiNER emits "Joy Dixon" and "Peter Parker" as separate person spans; deterministic cue keeps only the one inside the advisor evidence window |
| **Untitled plural / committee lists** ("my two supervisors, X and Y"; "My committee A, B, and C") | untitled name lists blow up regex FP risk | **Strong** | GLiNER proposes each person span; the deterministic role cue ("supervisors"/"committee") assigns the role to spans within the cue window |
| **C2 no-heading** (section never located) | extraction is gated on finding an ACK heading | **Moderate** | GLiNER needs no heading; run it on a cue-anchored window ("my … advisor/supervisor …") wherever that cue appears, not only inside a detected section |
| **Weak role signals** ("grateful to Dr. Cross of …") | no deterministic supervisory cue at all | **Low** | GLiNER proposes the name, but there is no cue to license "Supervisor" — correctly stays unclaimed. A model *deciding* here is exactly the benchmark's precision trap. Leave unrecovered. |
| **C3 OCR glyph-split** ("Wi l l iam Wray") | corrupted tokens defeat name capture | **Low** | NER degrades on corrupted input; better addressed by OCR-repair, not the model |

**Takeaway:** GLiNER's unique, defensible wins are **F-2d and untitled name-lists/plurals** (span
boundaries), plus **candidate proposal where section detection fails** (C2). It should *not* be
trusted to assign roles on weak-signal docs, and it does not fix OCR.

## 3. Architecture — deterministic-first hybrid with exact-evidence validation

```
full text
  │
  ├─ parseCommittee (certificate page)             ── authoritative when present
  │
  └─ (no cert supervisor) → acknowledgements path:
        1. Deterministic role-cue detection (existing ROLE_PATTERNS + advisor/supervisor cues)
           → for each cue, an EVIDENCE WINDOW (the char span around the cue)
        2. GLiNER proposes person spans over the section (or a cue-anchored window when no section)
        3. VALIDATE: keep a GLiNER span only if it falls inside a deterministic cue's evidence
           window. ROLE comes from the deterministic cue, never from GLiNER's label.
        4. Dedupe/normalize via src/supervisors.js (same as today)
```

- **Shadow mode first (no prod behavior change):** run GLiNER offline in the eval harness only,
  scoring `deterministic ∪ validated-GLiNER` against the gold, to measure the recall delta and
  confirm zero new negative-set violations *before* any production wiring.
- **Promotion criterion:** wire GLiNER into the prod acknowledgements path only if shadow mode shows
  a real recall gain on the failure cell **and** holds the precision gates (below).

## 4. Measurement & acceptance gates (against the committed gold)

- Baseline to beat: **deterministic-only = 42% name recall (8/17)**, 0 negative-set violations.
- Gates for accepting the hybrid:
  1. name-level recall on the `nocert` failure cell **strictly > 42%**;
  2. **zero** new false positives on the gold `negatives` set;
  3. role-level precision **not below** deterministic-only (role still assigned by cue, so this
     should hold by construction);
  4. every accepted GLiNER name carries a source span inside a deterministic evidence window
     (exact-evidence — auditable).
- Widen the gold beyond rows 1–50 before trusting the delta (current n=17 gold-positive docs).

## 5. Operational / cost considerations

- **Batch, not per-request.** Extraction runs in the enrichment pipeline (already batch), so model
  latency (CPU, ~100s of ms/doc) is acceptable; no online-serving requirement.
- **Deployment reality:** GLiNER is a Python/torch dependency. The repo already ships a Python ML
  path (BERTopic/transformers via the admin worker), so an isolated Python step is not new
  infrastructure — but note the local `.venv` is Python 3.14, which the pinned model stack may not
  support; a dedicated pinned env (3.11/3.12) is required. (See probe results §6.)
- **Added surface:** one more model to pin/cache/version; a Node↔Python boundary (spawn or a small
  local service), consistent with how build-topics/build-concepts run.

## 6. Empirical probe — NOT RUN THIS SESSION

The timeboxed probe (run GLiNER on the 8 real edge-case windows in
`scratchpad/gliner-probe-inputs.json`) **did not complete** — the worker hit an account
session limit before standing up the model, so **there are no observed GLiNER outputs here.**
Nothing below is measured; it is the *expected* behavior from GLiNER's span-NER design and the
prior benchmark, and must be confirmed by actually running the probe (the inputs are staged and
ready; re-run after the limit resets, or in a session with model access).

**Expected (analytical, unverified):**
- **Would likely resolve:** the boundary/list cases — F-2d ("Joy Dixon" vs "Peter Parker" as two
  spans), the untitled plural (`1.0097749` Wiesman + Seelig), the committee list (`1.0089112`
  Boothroyd/Allison/Hutton). These are span-segmentation tasks GLiNER is built for.
- **Might resolve with windowing:** `1.0090378` (no heading) — GLiNER needs no heading, but it must
  be run on a cue-anchored window and validated, or it will also surface body names.
- **Would likely NOT resolve:** `1.0091408` OCR ("Wi l l iam") — NER degrades on corrupted tokens;
  the weak-role cases (`1.0104776` Cross, `1.0102242` "who supervised") — GLiNER may *find* the name
  but there is no deterministic cue to license "Supervisor", and letting the model's own role label
  decide is the benchmark's documented precision trap.
- **Role-typed mode risk:** the prior benchmark found role labels over-attribute (thanking a person
  ⇒ labeled supervisor). Expect the role-typed run to over-claim; this is why role stays with the
  deterministic cue, not the model.

**Realistic addressable gain (unverified):** of the 9 residual gold misses, GLiNER-in-shadow could
plausibly recover ~2–4 (the boundary/list/no-heading cases), i.e. roughly 42% → mid-50s/low-60s%
name recall — *if* shadow validation holds precision. The weak-role, OCR, and ceiling cases stay
unrecovered.

**Environment blocker (observed):** the local `.venv` is Python 3.14; the GLiNER/torch stack has
poor 3.14 wheel support and the import stalled. A dedicated pinned Python 3.11/3.12 env is required
to run GLiNER at all — a real setup cost to budget.

## 7. Recommendation — measured, shadow-first (do NOT wire into prod yet)

1. **Confirm before committing:** run the staged probe (§6) to replace the analytical expectation
   with real numbers. Cheap, and it's the honest gate for everything below.
2. **If the probe confirms the boundary/list wins:** build the **shadow eval only** (design §5
   `gliner-propose.py` + `score-shadow.mjs`) in a pinned 3.11/3.12 env, score
   `deterministic ∪ validated-GLiNER` against a **widened** gold (label past row 50 first — n=17 is
   too small to trust a mid-single-digit doc delta), and check the §4 gates.
3. **Promote to prod only if** shadow recall beats 42% meaningfully AND the precision gates hold.
   Given the modest addressable gain (~2–4 docs) versus a new Python/torch dependency, a Node↔Python
   boundary, model pinning/versioning, and the precision-risk of a decider, the bar for prod wiring
   should be real — this is infra worth adding only if the widened-gold delta is clearly worth it.
4. **Cheaper alternatives to weigh first for the same residual:** the untitled-plural / committee-list
   cases (`1.0097749`, `1.0089112`) are *also* addressable by targeted deterministic patterns (the
   high-FP-risk group we deliberately skipped) with the same eval as a guard — no model, no infra.
   GLiNER's genuinely unique contribution is narrower than it first appears: mainly **F-2d boundary
   disambiguation**, which is rare in real prose. Weigh the model's infra cost against just extending
   the regex to the list/plural forms under the eval's precision guard.

**Bottom line:** GLiNER is the *right tool* for the one thing regex fundamentally can't do (name-span
boundaries), but on this corpus that need is narrow. Recommend: run the probe → shadow-eval on a
widened gold → decide, rather than committing to the model integration now.
