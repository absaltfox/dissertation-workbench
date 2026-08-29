# Async Citation Import Pipeline Plan

Goal: an import captures word counts and other metadata immediately. Citation
**scanning** happens inline while the streamed document bytes are already in
hand, and only citation **reconciliation** (external Z39.50 catalogue
resolution) is deferred to a job that runs nightly, or on demand.

**We do not cache PDFs or full text — streaming is the intended behavior.** That
constraint is the whole reason for the split below: deferring the *scan* would
force a re-fetch (the bytes are gone after parse), so the scan must run inline;
reconciliation needs no document bytes at all, so it defers cleanly.

## Why the split falls this way (the physics)

For a streamed import (`pdf_stream`, `full_text_only`) the full text exists only
transiently during parsing and is then discarded — nothing is written to
`file_metrics.pdf_path` or `full_text_path` (`persistFullText:false`,
`src/pdf.js:2224`, `:2331`). So:

- **Scanning must be inline.** It is the one moment the bytes exist. Deferring it
  would require re-downloading from the repository — exactly what streaming
  exists to avoid.
- **Reconciliation must be deferred.** Z39.50 resolution is slow, external, and
  rate-limited, and it operates on globally deduplicated citation rows
  (`document_citations` / `catalogue_lookups`), needing no PDF or full text. It
  is the expensive half and the only half worth deferring.

These two are already cleanly decoupled in the code: inline extraction
(`src/pdf.js:2104`) writes citations via `reextractDocumentCitations` and never
calls a catalogue lookup; resolution is the wholly separate `catalogue_lookup`
job (`src/services/adminJobs.js`, `src/catalogue.js`).

## Current state

- **Import captures metadata but currently extracts no citations.** The
  enrichment path hardcodes `extractCitations: false` (`src/sync.js:277`), so
  streamed imports get word counts, pages, and committee — but no citations at
  all, and (because nothing is cached) nothing can back-fill them later. This is
  the gap the hybrid closes.
- **A rule-level `extractCitations` flag already exists** in the schema, the
  validator, and the admin UI (`src/importRules.js:63,92,141`;
  `src/routes/adminImportRoutes.js:36`) but is currently inert — the runner
  ignores it. The hybrid gives it teeth.
- **Inline extraction already picks the best available parser.** With a temp
  streamed PDF in hand it runs GROBID; `full_text_only` falls back to AnyStyle on
  the in-memory text (`src/pdf.js:2108-2127`). No cache required either way.
- **Reconciliation already exists as a bounded, deduplicated job**
  (`catalogue_lookup`, `POST /api/admin/jobs/catalogue-lookup`), rate-limited and
  prioritized by citation link count. It is only ever started by hand today.
- **A daily-scheduler pattern already exists** for concept rebuilds
  (`scheduleDailyConceptRebuildJob`, `src/server.js:74`, firing at
  `DAILY_HOUR_LOCAL = 2`). The nightly reconciliation runner mirrors it.

## Proposed change

### 1. Scan inline at import (governed by the existing rule flag)

In the enrichment path, replace the hardcoded `extractCitations: false` with the
rule's own `extractCitations` flag (defaulting off, so behavior is unchanged
until an operator opts a rule in):

- `src/sync.js` `runEnrichmentBatch`: pass `extractCitations: rule.extractCitations`
  (thread the flag through `importRuleToSyncOptions` /
  `contentModeEnrichesDocuments`).
- Keep `strictCitationErrors: false` here: a citation-parse failure logs a
  warning and must not fail the whole document import (`src/pdf.js:2136`). The
  document still lands with its metadata and word count.
- Optionally write `citation_extraction_state` on inline runs too, purely for
  observability (how many docs scanned / failed). Note that under streaming a
  failed inline scan cannot be retried without a re-fetch, so this state is a
  report, not a retry queue.

This adds citation-parse cost to the import batch. That is the accepted trade of
choosing streaming over caching, and it is bounded by the existing PDF batch
size, so import batches stay bounded.

### 2. Defer only reconciliation to a nightly (and on-demand) job

Reconciliation stays exactly the `catalogue_lookup` job it is today, but gains an
unattended driver:

- **Nightly scheduler** beside the concept one in `src/server.js`, gated by new
  config in `src/config.js`:
  - `CATALOGUE_NIGHTLY_ENABLED` (default off).
  - `CATALOGUE_NIGHTLY_HOUR_LOCAL` (default e.g. 3, staggered from the 2:00
    concept rebuild so the two nightly jobs never contend for the worker).
  - `CATALOGUE_NIGHTLY_BATCH_SIZE` — reuse the existing lookup batch cap.
  - Factor the concept scheduler's timer/`msUntilNext…` math into a shared
    `scheduleDaily(hourLocal, fn)` helper so both share one tested path.
- **Backlog drain, not one page.** On fire, run one `catalogue_lookup` batch and,
  while pending lookups remain, schedule a continuation of itself using the same
  durable-cursor pattern as PDF-batch continuation (`startContinuationJob`,
  `src/services/importPdfJobRunner.js:71`) so `params_json` stays O(1) per batch.
  Guard with `hasRunningAdminJob('catalogue_lookup')` so a long night never
  overlaps itself.
- **On-demand parity.** The existing `POST /api/admin/jobs/catalogue-lookup`
  already covers manual runs; keep it. The nightly path is the same job type with
  a `trigger: 'scheduled'` label, mirroring the concept-rebuild convention.

### 3. What the old extraction job becomes

`reparse_citations` stays as an on-demand **backfill/repair** tool — useful after
a parser-version bump or to scan documents that predate the rule flag — but it is
no longer on the critical path and is not part of the nightly run. Under a
pure-streaming corpus it can only touch documents that happen to have cached
bytes, so for streamed rules it is effectively vestigial; that is expected and
fine. Leave it in place, do not wire it into the nightly job.

## Guardrails (invariants to preserve)

- **No caching, no re-fetch.** Inline scan reads the transient streamed bytes
  only; nothing new is written to `pdf_path` / `full_text_path`, and the nightly
  reconciliation job issues zero repository content requests.
- Public dashboard reads still start no extraction or resolution work.
- Resolution stays Z39.50 rate- and batch-bounded; the nightly driver inherits
  those limits and adds no new external-traffic path.
- Two nightly jobs (concepts, citations) run at different hours and rely on
  `hasRunningAdminJob` so they never block each other on the single worker.

## Files touched

- `src/sync.js` — thread `rule.extractCitations` into the enrichment analyze call
  (the one-line policy change that closes the gap).
- `src/importRules.js` — surface the flag through `importRuleToSyncOptions` if it
  is not already carried there.
- `src/config.js` — nightly catalogue-reconciliation knobs.
- `src/server.js` — second daily scheduler + shared `scheduleDaily` helper;
  start/stop wiring beside `stopDailyConceptScheduler`.
- `src/services/adminJobs.js` — continuation/backlog-drain wrapper around
  `catalogue_lookup`.
- `src/routes/adminJobsRoutes.js` — scheduled-label plumbing (endpoint already
  exists).
- `public/app/admin.js`, `public/index.html` — surface the rule flag's effect and
  nightly reconciliation status (the flag UI already exists).
- `docs/admin-worker-job-standards.md` — update the citation standard: extraction
  is inline-at-import under the rule flag; only resolution is deferred/scheduled.

## Tests

- **Inline scan:** an enrichment run with `extractCitations` on writes
  `document_citations` for a streamed doc and issues no catalogue lookup; with the
  flag off, no citations are written (unchanged behavior); a citation-parse
  failure logs and does not fail the document import.
- **No re-fetch / no cache:** the inline path writes no `pdf_path` /
  `full_text_path`; the nightly reconciliation run issues zero repository content
  requests.
- **Nightly reconciliation:** scheduler `msUntilNext` boundary math;
  enabled/disabled gate; no overlap while a previous run is active; continuation
  drains a multi-batch backlog with O(1) `params_json`; per-citation lookup
  failures counted, not fatal.
- **Route:** scheduled label carried; `alreadyRunning` short-circuit; public reads
  start nothing.

## Out of scope

- Changing the citation parser (GROBID/AnyStyle) or the Z39.50 client.
- Any form of PDF/full-text caching — explicitly rejected; streaming stands.
- Cross-machine cron (Fly scheduled machines) — the in-process daily scheduler
  mirrors the concept-rebuild approach and can be swapped for a machine cron later
  without changing the job contract.
