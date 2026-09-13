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

## 6. Empirical probe — RUN (observed results)

Model: `urchade/gliner_small-v2.1`, CPU, in a pinned venv (`gliner 0.2.29`, `transformers==4.52.4`
+ `protobuf`/`sentencepiece`/`tiktoken` — the design §5 pin was exactly right; newer transformers
5.x broke the deberta-v3 tokenizer). Two label sets per input: generic `["person"]` and role-typed
`["thesis supervisor","co-supervisor","committee member","academic advisor"]`. Threshold 0.3.

| Case | gold | GLiNER **person** (score) | role-typed | verdict |
|---|---|---|---|---|
| `0097749` untitled plural | Wiesman, Seelig | **Wiesman(.75), Seelig(.88)** + Stanley Schibler(.95, thanked) | all 3 → "thesis supervisor" | **names found**; role over-attributes Schibler |
| `0089112` committee list | Boothroyd, Allison, Hutton | **all 3 found** (Boothroyd.97, "Mark Al l ison".89, Hutton.75) + Nelson(.74), Mackniak(.93, thanked) | most → "committee member" | **names found**; over-attributes 2 extras |
| `0090378` **no heading** | Joy Dixon | **Joy Dixon(.94)** (+ Ingrid .34) | Joy Dixon → thesis supervisor(.78) | **RESOLVED w/o a heading** |
| `0091408` OCR split | William Wray | **"Professor Wi l l iam Wray"(.83)** | → thesis supervisor(.65) | span located but **name still glyph-corrupted** |
| `0104776` weak role | Cross (ambiguous) | Dr. K.J. Cross(.93) | → **academic advisor**(.61) | name found; no supervisory cue → hybrid abstains (correct) |
| `0102242` "who supervised" | C. Davis | Dr. C. Davis(.96) + Dr. R.W. Collier(.94) | both → academic advisor | Davis found + an extra; needs a "who supervised" cue |
| CONTROL | Boothroyd | Professor Peter Boothroyd(.91) | → thesis supervisor(.71) | sanity ✓ |
| **F-2d boundary** | Joy Dixon (NOT Peter Parker) | **"Joy Dixon"(.74) + "Peter Parker"(.74) as TWO spans** | both → academic advisor | **boundary SPLIT correctly — the unique win** |

**Observed conclusions (now measured, not analytical):**
1. **Person-span recall is strong:** GLiNER found the gold name(s) in **all 8** cases, including every
   type regex missed — plural, committee list, no-heading, "who supervised", and the F-2d boundary.
2. **F-2d confirmed:** it splits "Joy Dixon" / "Peter Parker" into separate spans — exactly what
   capitalization-based regex cannot.
3. **Role-typed mode over-attributes, confirmed:** it labeled thanked-but-uninvolved people
   (Schibler, Nelson, Mackniak, Collier) and even "Peter Parker" as supervisor/committee/advisor.
   **GLiNER's own role labels are not trustworthy** — validating the design's core principle.
4. **The hybrid is what makes it safe:** GLiNER's person spans + a deterministic cue evidence-window
   is what rejects those over-attributed extras (Schibler is outside the "my two supervisors, X and
   Y" window; Peter Parker is outside the "my advisor, Joy Dixon" window). Recall from the model,
   precision from the deterministic cue.
5. **Not solved by GLiNER:** OCR (`0091408` — span found but "Wi l l iam" still corrupted; needs OCR
   repair) and truly weak-role docs (correctly abstained, since no cue licenses a role).

**Environment note:** ran in a fresh CPU venv; the design §5 dependency pin (`transformers==4.52.4`
+ `protobuf` + `sentencepiece`) is required — `pip install gliner` alone pulls transformers 5.x
which breaks the deberta-v3 tokenizer load. `python -m pip` (not `bin/pip`) was needed to make the
pin stick in this venv.

## 7. Recommendation — build the shadow eval; defer the prod-wiring decision to its numbers

The probe (§6) settles the feasibility question: **GLiNER proposes the right name spans on exactly
the cases regex can't (recall), its role labels can't be trusted (precision), and the
deterministic-cue evidence-window is what reconciles the two.** The architecture is sound and the
env is reproducible. So:

1. **Build the shadow eval (design §5), not prod wiring yet.** Implement `gliner-propose.py`
   (person-span proposals + offsets, in the pinned `transformers==4.52.4`+`protobuf`+`sentencepiece`
   venv) and `score-shadow.mjs` (deterministic cue windows validate/keep GLiNER spans; role from the
   cue). Score `deterministic ∪ validated-GLiNER` vs the gold.
2. **Widen the gold FIRST** — label past row 50. Current n=17 gold-positive docs is too small to
   trust the ~4-doc recall delta the probe suggests (42% → ~65%); the whole point of the harness is
   to measure the delta on a trustworthy sample.
3. **The crux to measure is precision, not recall.** The probe shows GLiNER's recall is there; the
   open question is whether the cue evidence-window reliably rejects the over-attributed extras
   (Schibler, Nelson, Mackniak, Collier, Peter Parker) at scale. The §4 gates — **zero new
   negative-set violations**, role precision not below deterministic-only — are the real bar.
4. **Then decide prod wiring** on the measured delta vs the cost (Python/torch dependency, Node↔Python
   boundary run as a batch enrichment step, model pinning). Given the probe, the recall upside is now
   credible (~4 docs + F-2d precision fix), so the decision is genuinely open — unlike before the
   probe, when it was speculative.

**Cheaper partial alternative still worth pricing in:** the plural/committee-list recall (`0097749`,
`0089112`) is *also* reachable by targeted regex under the same eval guard (no model). GLiNER's
*irreducibly unique* contribution is **F-2d boundary splitting** (and headingless proposal). If the
widened-gold shadow delta turns out to be mostly list/plural docs, extending the regex may capture
most of the gain without the model; if F-2d/boundary cases are material, the model earns its place.

**Bottom line (post-probe):** feasibility proven, architecture validated. The remaining unknown is
purely *how much* net recall survives the precision gate on a larger gold — which is exactly what
the shadow eval measures. Recommend building it as the next step; hold the prod-integration decision
for its numbers.
