# Async Citation Import Pipeline Plan

Goal: an import captures word counts and other metadata immediately, while
citation **scanning** (extraction) and **reconciliation** (external catalogue
resolution) are deferred to a job that runs nightly, or on demand.

## Current state (what already exists)

Most of the deferral is already in place. This plan is mostly about *automation
and chaining*, not new extraction machinery.

- **Import already excludes citations.** The enrichment path passes
  `extractCitations: false` (`src/sync.js:277`), and the general cache-reanalyze
  path does the same (`src/services/importPdfJobRunner.js:560`,
  `:516`, `:709`, `:878`). Word count, page count, committee, and full-text
  caching all still happen inline. This matches the documented standard
  (`docs/admin-worker-job-standards.md` — "Import and general cache reanalysis
  paths set `extractCitations: false`").
- **Scanning is a bounded, restartable job.** `reparse_citations`
  (`POST /api/admin/reparse-citations`) reads only already-cached PDFs / cached
  full-text, skips documents whose `citation_extraction_state` checksum and
  parser version are unchanged, and never issues a repository content request or
  starts resolution (`resolutionQueued: false`). Progress cursor, page size, and
  scope filters are all supported (`src/services/importPdfJobRunner.js:733`).
- **Reconciliation is a separate bounded job.** `catalogue_lookup`
  (`POST /api/admin/jobs/catalogue-lookup`) resolves globally deduplicated
  citations against Z39.50, prioritizes citations linked by the most documents,
  and honors the same corpus scope, batch size, and rate limits
  (`src/routes/adminJobsRoutes.js:53`, `src/services/adminJobs.js:29`,
  `src/catalogue.js`).
- **A daily-scheduler pattern already exists** for concept rebuilds
  (`scheduleDailyConceptRebuildJob` in `src/server.js:74`, firing at
  `DAILY_HOUR_LOCAL = 2` from `src/conceptsPipeline.js:13`). The nightly citation
  runner should mirror this exactly.

## The gap

1. **No nightly trigger.** `reparse_citations` and `catalogue_lookup` only start
   from an admin clicking a button. Nothing runs them unattended.
2. **No scan → reconcile chaining.** Even run back to back, extraction
   deliberately sets `resolutionQueued: false`; an operator must start
   resolution by hand. A nightly job needs to sequence the two.
3. **No corpus-drain semantics for a scheduled run.** The on-demand job stops at
   `maxDocuments` (cap 5,000). A nightly run should drain the pending backlog
   across the whole corpus over successive batches, the way PDF enrichment
   continues itself (`startContinuationJob` in
   `src/services/importPdfJobRunner.js:71`), rather than clearing only one page
   per night.

## Proposed change

### 1. A nightly "citation maintenance" scheduler

Add a scheduler beside the concept one in `src/server.js`, gated by new config
in `src/config.js`:

- `CITATION_NIGHTLY_ENABLED` (default off, so the change is inert until opted in).
- `CITATION_NIGHTLY_HOUR_LOCAL` (default e.g. 3, offset from the concept rebuild
  at 2 so the two nightly jobs do not contend for the worker).
- `CITATION_NIGHTLY_MAX_DOCUMENTS` / `CITATION_NIGHTLY_PAGE_SIZE` — per-run
  bounds reusing the existing caps.

Factor the concept scheduler's timer/`msUntilNext…` logic into a small shared
helper (`scheduleDaily(hourLocal, fn)`) so both schedulers share one tested
implementation instead of copy-paste.

On fire, the scheduler enqueues a single new orchestration job (below), guarded
by `hasRunningAdminJob` so a long-running previous night never overlaps itself.

### 2. A `citation_maintenance` orchestration job

A new admin-worker job type that owns the nightly sequence, keeping the two
existing jobs unchanged and independently usable:

1. Run a `reparse_citations` batch (reuse the existing runner in
   `importPdfJobRunner.js`, unchanged).
2. If pending extractions remain (`batchLimitReached: true`), schedule a
   continuation of itself — the same durable-cursor pattern as
   `startContinuationJob`, so `params_json` stays O(1) per batch.
3. When extraction is drained, start one `catalogue_lookup` batch over the same
   scope, and continue it the same way until pending lookups are drained.

This makes the nightly run *drain the backlog*, not just clear one page, while
each underlying job stays bounded and restartable per the job standards. The
orchestrator writes standard progress phases (`extract`, `resolve`, `complete`)
and per-record counts, and treats per-document extraction / per-citation lookup
failures as counts, not whole-job failure (`docs/admin-worker-job-standards.md`).

### 3. On-demand parity

Expose the same orchestration on demand: `POST /api/admin/jobs/citation-maintenance`
(202 + `jobId`), plus a button on the Admin Jobs page. The existing
`reparse-citations` and `catalogue-lookup` endpoints stay as-is for operators who
want to run one stage in isolation and inspect quality between stages.

### 4. Guardrails (unchanged invariants to preserve)

- Public dashboard reads must still never start extraction or resolution.
- The nightly job must not issue new repository downloads — extraction reads only
  cached artifacts; this invariant is already enforced and must be kept.
- Resolution stays rate-limited and Z39.50-bounded; nightly runs inherit those
  limits, no new external-traffic path.
- Two nightly jobs (concepts, citations) must not run at the same hour or block
  each other on the single worker — stagger the hours and rely on
  `hasRunningAdminJob`.

## Files touched

- `src/config.js` — new nightly citation knobs.
- `src/server.js` — second daily scheduler + shared `scheduleDaily` helper;
  start/stop wiring alongside `stopDailyConceptScheduler`.
- `src/services/importPdfJobRunner.js` — new `citation_maintenance` job type and
  its continuation logic (reusing `reparse_citations` internals).
- `src/services/adminJobs.js` — sequence the `catalogue_lookup` stage from the
  orchestrator.
- `src/routes/adminJobsRoutes.js` (or `adminOperationsRoutes.js`) — on-demand
  endpoint.
- `public/app/admin.js`, `public/index.html` — admin trigger + status surfacing.
- `docs/admin-worker-job-standards.md` — document the new job type and nightly
  scheduling rule.

## Tests

Following the job-standard test checklist:

- Scheduler: `msUntilNext` boundary math; enabled/disabled gate; no overlap when a
  previous run is still active.
- Orchestrator: extract-then-resolve ordering; continuation drains a
  multi-batch backlog with O(1) `params_json`; per-record failures counted, not
  fatal; scope carried through both stages.
- Invariants: nightly run issues zero repository content requests; public reads
  start nothing; resolution stays within batch/rate bounds.
- Route: `202 Accepted` with `jobId`; `alreadyRunning` short-circuit.

## Out of scope

- Changing the citation parser or the Z39.50 client.
- Changing what import captures inline (word counts / metadata already correct).
- Cross-machine cron (Fly scheduled machines) — the in-process daily scheduler
  mirrors the existing concept-rebuild approach; a machine-level cron can replace
  it later without changing the job contract.
