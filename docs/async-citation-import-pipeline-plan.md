# Async Citation Import Pipeline Plan

Goal: keep imports lightweight and citation-free, and move all citation work to
a scheduled job that re-streams each document's PDF when it needs one.

- **Import is unchanged.** It keeps `extractCitations: false` and continues to
  capture page count, word counts, supervisor and committee analysis, and
  full-text-derived metadata. No citation scanning happens at import.
- **A new scheduled job does citation extraction and analysis** for documents
  that do not yet have citations *and* have no previously recorded extraction
  failure. Because we do not cache PDFs or full text, this job **re-streams** the
  PDF from the repository to scan it. That extra download is an accepted cost.

## Why this shape

We rejected caching (streaming is intentional) and rejected inline extraction at
import (keeps imports light). The remaining consistent option is: scan later, and
since nothing is cached, re-stream the bytes at scan time. The download cost is
real but bounded and rate-limited, and it only touches documents that still need
citations — a shrinking set, not the whole corpus every night.

## Current state we build on

- **Import already excludes citations** (`src/sync.js:277`,
  `extractCitations: false`), and committee/word-count/pages extraction is
  independent of citation extraction (`src/pdf.js:2041`–`2140`). No change needed
  there — the "no citation extraction" path stays exactly as is.
- **Streaming + inline extraction already exists.** `analyzeDocumentFile` in
  `contentMode: 'pdf_stream'` streams the PDF to a temp file under the
  streamed-content contract (rate-limited `acquireDownloadSlot`, temp dir removed
  after parse, nothing cached — `src/pdf.js:2250`+), and runs GROBID/AnyStyle
  citation extraction when `extractCitations: true` (`src/pdf.js:2104`). The new
  job drives this per document; it does not need new parsing or streaming code.
- **`citation_extraction_state`** already records per-document status, content
  checksum, parser version, count, and error (`src/db.js:3664`). It is the
  natural home for "has citations" / "previously failed" bookkeeping.
- **Reconciliation is already a separate deferred job** (`catalogue_lookup`) that
  reads citation tables, not document bytes. It stays as-is downstream (see
  below).
- **A daily-scheduler pattern already exists** (`scheduleDailyConceptRebuildJob`,
  `src/server.js:74`, firing at `DAILY_HOUR_LOCAL = 2`) to mirror.

## The new job: `citation_scan` (re-streaming extraction)

A worker-backed admin job, bounded and restartable per
`docs/admin-worker-job-standards.md`.

### Selection

Pick a bounded page of documents that:

1. have a streamable source (a resolvable repository PDF/full-text URL — the same
   `documents` + `file_metrics` rows that recorded a successful content download
   during import); **and**
2. have **no terminal citation record** — no `document_citations` rows and no
   `citation_extraction_state` row with `status = 'completed'` (a successful scan,
   even one that found zero citations, is done); **and**
3. have **no previously recorded failure** — no `citation_extraction_state` row
   with `status = 'failed'`.

Selection is **parser-version-independent**: the gates test only the presence of
a terminal state, not which parser version produced it, so a parser/GROBID
upgrade never re-selects a scanned document on its own.

This is a **new** selection query — deliberately *not*
`listPendingCitationExtractions`, which requires cached `pdf_path`/`full_text_path`
(none exist here) and *re-includes* failed rows. The new query requires no cached
bytes and *excludes* failures so the nightly run does not retry known-bad
documents forever.

**Scan once by default.** A document that has been scanned — it has
`document_citations` rows, or a `completed` state row — is done and is **never**
reselected automatically, *including* after a citation-parser/GROBID version
upgrade. Reprocessing a scanned document happens only through an explicit forced
run (the `reprocess` control below), which drops every gate and re-scans all
streamable in-scope documents, replacing their existing citations. This keeps a
parser upgrade from silently re-downloading the whole corpus; a deliberate
`reprocess` is the one path that does.

### Per-document work

For each selected document:

1. Load metadata (`loadDocumentMetadata`).
2. `analyzeDocumentFile(doc, { contentMode: 'pdf_stream', downloadFiles: true,
   forceDownload: true, recomputeFromCache: false, extractCommittee: false,
   extractCitations: true, strictCitationErrors: true, artifactClient })` — this
   streams, parses, extracts, dedups, writes `document_citations`, and deletes the
   temp PDF. Nothing is cached.
3. Record outcome in `citation_extraction_state`:
   - success → `status: 'completed'`, `citationCount`, current parser version;
   - failure → `status: 'failed'` with the error, so it is excluded next run.
4. A per-document failure is counted and logged, never fatal to the batch
   (job-standard failure semantics).

Dedup cost is already bounded per document (the Phase-1/#11 bucketed fuzzy
matcher, hard-capped, `src/db.js:3024`+), so per-document cost is dominated by the
stream + parse, not by corpus size.

### Bounding, draining, and rate

- Bounded page size and a `maxDocuments` cap per run (reuse the existing
  reparse-citations caps).
- When pending documents remain, schedule a continuation of the job using the
  durable-cursor pattern (`startContinuationJob`,
  `src/services/importPdfJobRunner.js:71`) so `params_json` stays O(1) per batch
  and the backlog drains across successive nights.
- All downloads go through the existing `PDF_DOWNLOAD_RATE_PER_MIN` slot limiter
  and the streamed-content contract (temp dir per doc, removed in `finally`,
  orphan cleanup on process start).

## Scheduling

- **Nightly:** a second daily scheduler beside the concept one in
  `src/server.js`, gated by new config in `src/config.js`:
  - `CITATION_SCAN_NIGHTLY_ENABLED` (default off).
  - `CITATION_SCAN_NIGHTLY_HOUR_LOCAL` (default e.g. 3, staggered from the 2:00
    concept rebuild so the two never contend for the single worker).
  - `CITATION_SCAN_PAGE_SIZE` / `CITATION_SCAN_MAX_DOCUMENTS` per-run bounds.
  - Factor the concept scheduler's `msUntilNext…`/timer math into a shared
    `scheduleDaily(hourLocal, fn)` helper.
  - Guard with `hasRunningAdminJob('citation_scan')` so a long night never
    overlaps itself.
- **On demand:** `POST /api/admin/jobs/citation-scan` (202 + `jobId`) plus an
  Admin Jobs button, with three operator opt-ins the nightly run never sets:
  `retryFailures` (also re-attempt previously failed documents), `reprocess`
  (force re-scan of already-scanned documents; implies `retryFailures`), and
  `autoContinue` (chain batches so one run drains the whole backlog instead of a
  single page).

## UI controls

Two controls, each following an existing admin-panel precedent.

- **Manual run** — a new fieldset in the Operational Jobs grid
  (`public/index.html` `#admin-jobs` → `.job-controls-grid`), modeled on the
  existing "Bibliographic Lookups" block (`index.html:722`): a batch-size /
  max-documents input, a "Run Citation Scan" button posting to
  `POST /api/admin/jobs/citation-scan`, a "Retry previous failures" checkbox
  (the explicit `retryFailures` opt-in), and a "Preview Pending" line showing how
  many documents currently qualify. Handlers go in `public/app/admin.js` beside
  the existing `runCatalogueLookupsBtn` wiring. Progress, logs, and result counts
  appear in the existing Admin Jobs list automatically — the job is just another
  `admin_jobs` row, so no separate progress UI is needed.
- **Schedule** — configured by env only, matching the daily concept rebuild
  (which uses `DAILY_HOUR_LOCAL` and is never toggled from the UI). The knobs are
  `CITATION_SCAN_NIGHTLY_ENABLED` and `CITATION_SCAN_NIGHTLY_HOUR_LOCAL`
  (documented in `.env.*.example`). The UI surfaces the schedule **read-only** as
  a new status card in the settings status grid
  (`public/index.html:705`, beside `documentSyncStatus` /
  `conceptPipelineStatus`), showing: enabled?, scheduled hour, last run, next run,
  and pending-backlog count. There is no in-UI enable/hour switch; changing the
  schedule is a config change, as with concept rebuild.

## Reconciliation (unchanged, still separate)

The new job produces/updates deduplicated citation rows but starts **no** external
catalogue traffic — same rule as the existing extraction path. Z39.50
reconciliation stays the separate `catalogue_lookup` job, run on demand today and
optionally on its own nightly schedule later. Extraction and resolution remain
decoupled per `docs/admin-worker-job-standards.md`; this plan does not chain them.

## Guardrails

- Import stays citation-free and unchanged; word count / pages / committee /
  supervisor extraction is untouched.
- No caching: the scan job streams to a temp file and deletes it; it never writes
  `pdf_path` / `full_text_path`.
- Re-streaming is the one deliberate new download path. It is rate-limited,
  bounded per run, and scoped to documents still missing citations — so nightly
  download volume shrinks as the backlog drains.
- Public dashboard reads start no extraction, streaming, or resolution work.
- Failures are durable and excluded from automatic retry; only an explicit
  `retryFailures` run reconsiders them.

## Files touched

- `src/db.js` — new selection query (docs missing citations, no recorded failure,
  streamable source).
- `src/services/importPdfJobRunner.js` — new `citation_scan` job type (stream +
  extract per doc, record state, continuation to drain).
- `src/config.js` — nightly scan knobs and per-run bounds.
- `src/server.js` — second daily scheduler + shared `scheduleDaily` helper; wiring
  beside `stopDailyConceptScheduler`.
- `src/routes/adminJobsRoutes.js` (or `adminOperationsRoutes.js`) — on-demand
  endpoint with optional `retryFailures`; extend the jobs status payload with
  citation-scan schedule state (enabled, hour, last/next run, pending count) so
  the status card has a data source, mirroring `conceptPipelineStatus`.
- `public/index.html` — new "Citation Scan" run fieldset in the Operational Jobs
  grid, and a read-only schedule status card in the settings status grid.
- `public/app/admin.js` — run-button + preview handlers and status-card render.
- `.env.development.example`, `.env.production.example` — document the new nightly
  scan env knobs.
- `docs/admin-worker-job-standards.md` — document the re-streaming citation scan
  job and its selection/failure/rate rules.

## Tests

- **Selection:** includes a streamable doc with no citations and no failure;
  excludes a scanned doc (both a citation-bearing one and a `completed` scan that
  found zero citations, on the completed-state gate alone — scan-once is
  version-independent); excludes a previously failed doc unless `retryFailures`;
  `reprocess` re-includes every already-scanned doc.
- **Per-document:** a successful scan writes `document_citations` and a
  `completed` state and issues no catalogue lookup; a parse failure writes a
  `failed` state, is counted, and does not fail the batch.
- **Streaming contract:** the job streams via the rate limiter, writes no
  `pdf_path`/`full_text_path`, and removes its temp files.
- **Draining:** continuation drains a multi-batch backlog with O(1) `params_json`;
  `maxDocuments`/page-size caps honored; backlog shrinks run over run.
- **Scheduler:** `msUntilNext` boundary math; enabled/disabled gate; no overlap
  while a previous run is active.
- **Route:** `202 Accepted` with `jobId`; `alreadyRunning` short-circuit;
  `retryFailures` respected; public reads start nothing.

## Out of scope

- Any PDF/full-text caching — explicitly rejected; streaming (and re-streaming)
  stands.
- Changing the citation parser (GROBID/AnyStyle), the dedup matcher, or the Z39.50
  client.
- Chaining reconciliation into this job — it remains a separate deferred job.
- Cross-machine cron (Fly scheduled machines) — the in-process daily scheduler
  mirrors the concept-rebuild approach and can be swapped later without changing
  the job contract.
