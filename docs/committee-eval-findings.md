# Committee/Supervisor Extraction — Eval Findings

Empirical findings surfaced by the Phase-1 eval harness (`scripts/committee-eval/`).
Each is a defect or limitation in the **production extractor** (`src/`), tracked here
rather than fixed inline, since fixing them touches `src/` and warrants its own review.

Related design/spec: `docs/superpowers/specs/2026-09-06-committee-extraction-eval-design.md`.

---

## F-2a — `parseAcknowledgements` produces low-quality / mangled person names

**Status:** open · **Component:** `src/pdf.js` (`parseAcknowledgementsDetailed`,
`extractNameFromCapture`, the `PAT_*` regexes) · **Severity:** important (caps recall
*and* precision on the certificate-absent failure population, where the acknowledgements
section is the only signal).

**Evidence (live sample, 2026-09):**
- **`1.0445084`** (MA History, 2018+, certificate present). The certificate page parses
  cleanly: Timothy Cheek & Jeremy Brown (Co-Supervisors), Leo Shin & Francis L. F. Lee
  (Committee Members). But `parseAcknowledgements` on the same text emitted **mangled
  fragments of those same people**: `"Brown"`, `"Shin's"` (possessive attached),
  `"Francis L.F"` (truncated), `"Lee"`. These are right-people / wrong-strings — they fail
  name matching against the true names.
- **`1.0099420`** (MA History, pilot). Text contains *"I would also like to thank my thesis
  supervisor, Professor Peter Boothroyd"* — a cleanly named supervisor that the parser
  **missed entirely**. Root cause: the `my (co-)?supervisor, X` patterns don't allow an
  adjective infix (`my **thesis** supervisor`, `my **graduate** advisor`), so the match
  never fires.

**Two failure modes, same component:**
1. **Recall miss** — real, cleanly-named supervisors not matched because the surrounding
   phrasing falls outside the regex patterns (the "thesis/graduate supervisor" infix; likely
   others).
2. **Name-quality / precision** — when a pattern does fire, `extractNameFromCapture` can
   yield partial or punctuation-polluted names (bare surnames, `"Shin's"`, `"Francis L.F"`).

**Impact:** On certificate-*absent* docs (the failure population this project targets) the
acknowledgements path is the only extraction signal, so both failure modes directly degrade
the metric. On certificate-*present* docs the ack path is not used by production (see the
gating in `analyzeDocumentFullText` / `extractBaseline`), so `1.0445084`'s mangled names do
**not** reach production output — but they are the clearest reproduction of the quality issue.
(The eval worksheet no longer surfaces ack candidates on cert-present-with-supervisor docs —
fixed in `7cbf662` — so this finding is now tracked here rather than polluting the worksheet.)

**Recommended options (each its own change + review):**
- Broaden the acknowledgement patterns to allow the adjective infix (`thesis`/`graduate`/
  `research`/`doctoral` between `my` and `supervisor`/`advisor`) and tighten
  `extractNameFromCapture` to strip possessives (`'s`) and reject bare single-token surnames.
- Or introduce the **GLiNER shadow proposer** (design §5) specifically on the ack path, with
  exact-evidence validation, and measure the recall delta against the baseline this harness
  produces.
- Gate any change behind the harness: re-run `score-baseline` before/after and compare the
  `nocert` strata.

**Ceiling context (do not over-invest before reading this):** the same live sample showed
that most certificate-absent docs **do not contain a recoverable supervisor in the OC full
text at all** (≈10/12 in the pilot; a 2002 thesis's acknowledgements literally say "I will
not mention names now"). So the *addressable* universe for any ack-path improvement — regex
or model — is a minority of the failure population; the dominant gap is metadata-only and no
text extractor can close it. Size the investment to that ceiling.

---

## Related non-`src` limitations (already handled in the harness, noted for context)
- **Sampling by degree alone** missed program-scoped targets (History = degree
  `Master of Arts - MA` + program `History`). Fixed: program-level `--targets` + per-era
  quotas (`f0ea212`).
- **Worksheet dropped zero-candidate docs**, hiding the failure population from labeling.
  Fixed: placeholder rows (`5764869`).
- **`ratio() 0/0 → 1`** reports a vacuous 100% for strata with no gold members; the report
  should print `n/a`. Parked minor in the eval; low priority.
