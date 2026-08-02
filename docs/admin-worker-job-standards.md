# Admin Worker Job Standards

This document defines the standard for long-running, expensive, or extraction-oriented jobs in Dissertation Intelligence Workbench.

The guiding rule: if a task enriches the corpus, rebuilds derived data, calls heavyweight NLP/PDF/catalogue tooling, or may take more than a few seconds, it must be treated as an admin job with an observable worker lifecycle.

## Core Requirements

- Every long-running job must have an `admin_jobs` row before work begins.
- The job must appear on the Admin Jobs page with a clear label, type, status, runner, heartbeat, progress, log, result, and error state.
- The web app should start or schedule the job, but the heavy work should run in a worker process or worker machine unless it is intentionally small and already designed as an in-process job.
- Public dashboard reads must not trigger expensive extraction, model inference, PDF processing, catalogue lookup, or concept/topic rebuild work.
- Job output must be durable: write derived data to the database or to a known artifact path before marking the job completed.
- A job should be safe to retry. Partial per-record failures should be reported in result counts, not treated as whole-job failure unless the worker itself cannot complete.

## Worker Handoff

The web app is responsible for:

- validating the admin request;
- checking `hasRunningAdminJob(type)` for mutually exclusive jobs;
- creating the `admin_jobs` row with type, label, params, timeout, runner type, and artifact token when needed;
- starting the local worker or Fly Machine through the shared admin-worker launcher;
- returning `202 Accepted` for asynchronous jobs with `jobId` and `runnerType`.

The worker is responsible for:

- claiming the job with `claimAdminJob(jobId, runnerId)`;
- heartbeating while work is active;
- writing progress updates at meaningful intervals;
- appending human-readable logs;
- writing durable output;
- finishing the job with `completed`, `failed`, `timed_out`, or `cancelled`.

New worker-backed job types should be routed through `src/jobWorker.js` or a Python worker entrypoint that follows the same database contract. Do not hide heavyweight work inside a synchronous HTTP handler.

## Progress Contract

Every worker job should update `progress_json` with this shape:

```json
{
  "phase": "candidate_generation",
  "currentTask": "Generating PatternRank candidates",
  "tasks": [
    {
      "key": "candidate_generation",
      "label": "Generating candidates",
      "status": "running",
      "detail": "Processed 120 of 740 documents",
      "counts": {
        "processed": 120,
        "total": 740,
        "accepted": 480,
        "rejected": 210,
        "failed": 0
      },
      "updatedAt": "2026-07-09T00:00:00.000Z"
    }
  ],
  "counts": {
    "processed": 120,
    "total": 740,
    "accepted": 480,
    "rejected": 210,
    "failed": 0
  }
}
```

Progress standards:

- Use stable task keys such as `load_documents`, `candidate_generation`, `embedding`, `ranking`, `write_results`, and `complete`.
- Include `processed` and `total` whenever the total is knowable.
- Include success, skipped, rejected, and failed counts when records can fail independently.
- Update at least every 15 seconds during active work, and immediately at phase boundaries.
- Keep `runner_state` short and current, such as `loading_documents`, `embedding`, `ranking`, `writing_results`, `completed`, or `failed`.
- Keep `heartbeat_at` fresh even when no count changes.

## Failure Semantics

- Whole-job `failed` means the worker could not complete the job.
- Per-record failures should be counted and logged, then included in `result_json`.
- Expected skips, low-confidence rejects, missing data, or failed lookups should not mark the whole job failed.
- Cancellation should set `status = cancelled`, `runner_state = cancelled`, `cancelled_at`, and `finished_at`.
- Timeout should set `status = timed_out`, `runner_state = timed_out`, `error`, and `finished_at`.
- Logs should summarize final counts so the job remains understandable even if progress JSON changes later.

## UI Expectations

The Admin Jobs page should show:

- job label and type;
- status;
- runner type, runner id, runner state, and latest heartbeat;
- phase/task progress;
- counts;
- final summary;
- error text when failed;
- cancellation affordance for cancellable running worker jobs.

Admin actions that start long-running jobs should not block the browser until the work is done. They should return the job id and let the Jobs page display progress.

## Streamed Content Contract

`pdf_stream` source bytes are not worker artifacts. The worker retrieves the original PDF into a uniquely owned operating-system temporary directory, parses the seekable file, and removes the directory in a `finally` block. Before its first streamed retrieval, a process also removes orphaned stream directories whose owner process is no longer running. The temporary streamed PDF must never be uploaded through the artifact API or saved as `file_metrics.pdf_path`; an independently existing cached PDF path or artifact remains unchanged.

Content-enrichment job results include `requestCounts` with separate `metadata`, `fullText`, and `originalPdf` request totals plus `retrievedBytes`. These counters are operational records, not billing semantics: `pdf_stream` increments `originalPdf` even though its source bytes are deleted after parsing.

Enrichment results must also distinguish `totalEnrichmentAttempted`, `totalEnriched`, and `totalEnrichmentFailed`. Batch limits and continuation checkpoints use attempts; success totals include only results that satisfy the snapshotted content policy. A streamed-PDF failure must not be counted as enriched or silently converted to extracted-full-text estimates.

## PatternRank Concept Rebuild Standard

PatternRank concept extraction must be implemented as a worker-backed job.

Expected flow:

1. Admin requests concept rebuild.
2. Web app checks whether a concept rebuild job is already running.
3. Web app creates an `admin_jobs` row with type such as `concept_rebuild`.
4. Web app starts a worker using the Python NLP worker image.
5. Worker claims the job and loads stored dissertation metadata.
6. Worker applies cheap candidate gates first.
7. Worker runs PatternRank-style candidate selection, embedding, and ranking.
8. Worker writes the generated concept artifact/status.
9. Worker finishes the job with final counts and cache-clearing metadata.

PatternRank progress should include these phases:

- `load_documents`: documents loaded from the stored corpus.
- `candidate_generation`: candidate phrases generated and cheap-gated.
- `embedding`: document and candidate embeddings computed or reused.
- `ranking`: PatternRank relevance scores computed.
- `filtering`: accepted/rejected concepts finalized.
- `write_results`: concept dictionary artifact written.
- `complete`: final counts recorded.

PatternRank result counts should include:

- documents processed;
- candidates generated;
- candidates accepted;
- candidates rejected by gate;
- candidates rejected by rank threshold;
- concepts written;
- aliases written;
- per-document failures.

The Node web app may continue to read the concept artifact exactly as it does today. The worker implementation should preserve the existing artifact fields (`concepts`, `variantToCanonical`, `docFreq`, `idf`) and may add scoring metadata such as `patternRankScore`, `contextScore`, `qualityScore`, or `source`.

## Stored Theme Recompute Standard

Theme terms should be assigned when each document is processed and stored durably on the document metadata record. Public analytics reads should consume stored themes, not recompute theme terms on every request.

When the corpus changes enough to warrant a full rebuild, the Admin UI should start a worker-backed job with a type such as `theme_recompute`. The worker should:

- claim the job through the standard worker entrypoint;
- load stored dissertation metadata from the database;
- recompute and persist each document's `themes` field;
- report `processed`, `total`, `updated`, and `failed` counts;
- keep per-document failures in the counts instead of failing the whole job;
- finish with a durable result summary and clear logs.

Theme recompute progress should include these phases:

- `load_documents`: stored dissertation metadata loaded.
- `recompute_themes`: document theme fields recomputed and saved.
- `complete`: final counts recorded.

## Test Expectations

Every new job type should have tests for:

- worker payload or local worker command selection;
- job claiming and heartbeat;
- progress updates;
- successful completion with result counts;
- per-record failures that do not fail the whole job;
- whole-worker failure that marks the job failed;
- cancellation or timeout behavior when supported;
- public/admin route behavior, including `202 Accepted` for asynchronous starts.

For extraction jobs, add regression fixtures for representative bad outputs. For PatternRank concepts, include examples where sliding-window n-grams should be rejected and well-formed noun phrases should survive.
