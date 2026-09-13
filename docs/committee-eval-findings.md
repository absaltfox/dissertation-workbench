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

## F-2b — "academic/graduate advisor, <Name>" (punctuated, untitled) misfiled as Supervisor

**Status:** open (deferred) · **Component:** `src/pdf.js` `PAT_BARE_ADVISOR_PREFIX` (its infix still
includes `academic`) · **Severity:** important (precision) · **Pre-existing; NOT introduced or
amplified by Levers A/B.**

**Evidence:** `"my academic advisor, Jane Smith, for help with course registration"` currently
extracts `Jane Smith / Supervisor`. "Academic advisor" (and "graduate advisor") are typically
*administrative* staff, not the thesis supervisor. (`"my graduate advisor, Bob Jones"` correctly
returns nothing — `graduate` isn't in that pattern's infix; only `academic` is.)

**Why it wasn't fixed with Lever A/B:** the naive fix — drop `academic` from
`PAT_BARE_ADVISOR_PREFIX` — breaks a legitimate existing positive:
`"my academic co-adviser — J. R. Smith"` → `Co-Supervisor` (test `pdfParser.test.js` "accepts
conservative advisor variants"). The real differentiator is the **`co-` prefix**: `co-adviser`
is supervisory; a bare `academic/graduate advisor` (no `co-`) is administrative. A correct fix must
distinguish on the full role phrase (reject `{academic|graduate} advisor` only when there is no
`co-`), not on the infix word alone. Deferred because it needs that role-phrase disambiguation and
is outside the Lever A/B scope, and the no-`co-` admin form is only reached via the older punctuated
pattern (Lever B's untitled pattern uses infix `thesis|doctoral|dissertation`, so it does not widen
this).

**Related mitigation already shipped:** `isPlausibleBareAdvisorName` now rejects institution/
geography names (e.g. "National Science Foundation", "Statistics Canada") so orgs following
"my advisor" are no longer misfiled as supervisors (Lever B precision guard).

## F-2c — acknowledgements section detection / OCR limits recall on some clean-phrasing docs

**Status:** open (Lever C, deferred) · **Component:** `src/pdf.js` `parseAcknowledgementsDetailed`
section slicing + OCR-spacing repair · **Severity:** important (recall on the failure population).

**Evidence (live gold, rows 1-50):** after Levers A+B, name-level recall on the labeled failure
docs rose from **16% → 37%**. Several remaining misses have the supervisor **cleanly phrased and in
text, with an ACKNOWLEDGEMENTS heading present, yet nothing is extracted** — the mention falls
outside the sliced section window:
- `1.0090378` "my thesis advisor Joy Dixon for reading" — extracts in isolation, misses in-doc.
- `1.0100786` "my advisor, Joy Dixon, for her patience" — same.
- `1.0091408` — OCR-spaced name "Professor Wi l l iam Wray" defeats name capture (OCR repair gap).

**Recommendation:** improve heading detection for OCR-spaced/variant headings and widen/repair the
section window; strengthen `normalizeAcknowledgementOcrSpacing` for partial-glyph runs. This is the
"Lever C" work deliberately scoped out of the Levers A/B pass.

## F-2d — greedy name-capture can merge two adjacent names (amplified by Lever C1)

**Status:** open (tracked; deterministic fix not safe) · **Component:** `src/pdf.js`
`extractNameFromCapture` + `PAT_BARE_ADVISOR_PREFIX`/`PAT_BARE_ADVISOR_UNTITLED` · **Severity:**
important (precision) · **Pre-existing; blast radius widened by Lever C1's whitespace collapse.**

**Evidence:** `"my advisor, Joy \nDixon Peter Parker was also present"` → extracts
`"Joy Dixon Peter Parker" / Supervisor` (two people merged into one bogus name). Reproduces
identically on a single line (`"my advisor, Joy Dixon Peter Parker was..."`), so the root defect is
pre-existing: `extractNameFromCapture` greedily accepts up to 4 capitalized tokens, stopping only at
a lowercase word or sentence terminator. Lever C1 (collapsing intra-section line-wraps) removed a
`\n` that previously fire-walled this whenever the unrelated capitalized run began on the next line.

**Why it is NOT fixed deterministically:** the naive guard (cap the capture at 2 tokens) would
regress legitimate multi-token names this project just added support for — `R. A. J. McDonald`,
`Francis L. F. Lee` (4 tokens each). Capitalization alone cannot distinguish one 3–4-token name
(`Mary Jane Watson`) from two adjacent names (`Joy Dixon Peter Parker`). This is the deterministic
parser's genuine ceiling — and the **clearest concrete case for a span-grounded model** (GLiNER
shadow proposer, design §5), which resolves name boundaries from learned span structure rather than
capitalization runs.

**Mitigating facts:** on the real eval gold this never triggered (recall rose 37%→42% with zero
false positives / zero negative-set violations); the failing shape (a wrapped name immediately
followed by an unrelated capitalized name with no comma/period/lowercase between them) is rare in
natural acknowledgement prose, where a supervisor name is almost always followed by `,`/`for`/`who`/
a period. Shipped on that basis; revisit if a model layer is introduced.

## F-2e — the failure population's ceiling: ~45% of docs name no supervisor at all

**Status:** characterized (not a defect — a hard ceiling) · **Source:** manual + Claude-vision review
of the 20 pre-2018 History "failure" docs (rows added in the gold-widening batch), under the
explicit-role standard ([[gold-labeling-explicit-role-standard]]).

Breakdown of the 20 certificate-absent pre-2018 History docs:
- **~35% (7/20) — explicit supervisor recoverable in the OC text** ("my supervisor Coll Thrush",
  "advisors, Professors Conway and Hill", "my advisor, Dr. Harvey Mitchell", etc.). These are the
  legitimately addressable extraction targets.
- **~45% (9/20) — no supervisor in the document at all.** Confirmed by reading the PDFs (vision) across
  eras (1970, 2002, 2007): these theses have **no acknowledgements section and no typed committee/
  approval page** (the "We accept this thesis…" page carries signatures, not typed names). The
  supervisor exists only in UBC's metadata/committee records, never in the PDF. **No extractor — regex,
  GLiNER, or vision — can recover what is not in the document.** This is a metadata-join problem.
- **~20% (4/20) — inference-only** (emphasis / "mentorship" / "guidance"): rejected under the strict
  standard, correctly excluded from gold.

**Implication for the recall metric and the model decision:** the denominator that any extractor can
move is the ~35% explicit-in-text slice, not the whole failure population. On the widened gold
(93 docs), deterministic baseline is **37.9% name recall at 100% precision** on the failure cell
(clean 43%, degraded 17%). So the realistic headroom is: OCR repair (F-2c/C3, lifts the 17% degraded)
+ the clean-text boundary/list/no-heading cases (GLiNER shadow). The ~45% not-in-document ceiling is
immovable by extraction and should frame expectations for a supervisor-coverage target.

## Related non-`src` limitations (already handled in the harness, noted for context)
- **Sampling by degree alone** missed program-scoped targets (History = degree
  `Master of Arts - MA` + program `History`). Fixed: program-level `--targets` + per-era
  quotas (`f0ea212`).
- **Worksheet dropped zero-candidate docs**, hiding the failure population from labeling.
  Fixed: placeholder rows (`5764869`).
- **`ratio() 0/0 → 1`** reports a vacuous 100% for strata with no gold members; the report
  should print `n/a`. Parked minor in the eval; low priority.
