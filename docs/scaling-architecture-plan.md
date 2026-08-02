# Corpus Scaling and Content Processing Plan

Status: Proposed
Scope: Scale PatternRank and document analytics from the current Education corpus to all UBC dissertation and thesis degree types.

## Implementation Status

Step 1 establishes the content-policy contract and safety boundary:

- Implemented: the four `content_mode` values are normalized, validated, persisted, returned by the API, and editable in Admin.
- Implemented: existing rules migrate conservatively to `metadata_only`.
- Implemented: selected rules are snapshotted into durable jobs at launch.
- Implemented: `metadata_only` bypasses content enrichment.
- Implemented: `full_text_only` selects the extracted text derivative without creating a new persistent full-text artifact.
- Implemented: `pdf_cache` is gated by `ALLOW_ORIGINAL_PDF_RETRIEVAL`.
- Implemented: the PDF retrieval boundary blocks original bitstreams before making a network request when the deployment guard is disabled.
- Implemented: policies fail closed at the API, worker, and parser boundaries; invalid modes and worker-side guard denial cannot fall through to another retrieval mode.
- Implemented: cache satisfaction is mode-specific, so full-text metrics do not prevent a later `pdf_cache` request.
- Implemented: extracted-text selection requires the DSpace `TEXT` bundle or a verified non-`ORIGINAL` `*.pdf.txt` derivative.
- Implemented: continuations retain the capped enrichment rule and unprocessed rules while removing every completed rule.
- Implemented: the `content_mode` migration detects the legacy schema explicitly and fails on unexpected migration errors.
- Implemented in Step 2: `pdf_stream` retrieves into bounded worker-local ephemeral storage, parses from a seekable path, removes the owned temporary directory after success or failure, and reaps directories orphaned by a prior worker process before the first streamed retrieval.
- Implemented in Step 2: SHA-256 content checksums, retrieval/parser provenance, per-document request accounting, and import-job request totals distinguish metadata, extracted-text, and original-PDF access.
- Implemented in Step 2: existing global byte and original-PDF rate limits apply to the streaming path; streamed results retain derived metrics but create no PDF artifact or persistent temporary path. An independently existing cached PDF remains unchanged.
- Pending later steps: per-rule fallback, extraction toggles, per-rule byte/concurrency/rate controls, cache retention, object storage, aggregate analytics, and incremental PatternRank.

## Goals

- Support approximately 56,000 metadata records without loading the entire corpus into the web process.
- Make document-content retrieval an explicit property of each import rule.
- Permit full-text analysis without retaining PDFs.
- Provide a mode that never requests an original PDF bitstream.
- Make imports, parsing, citation enrichment, and concept generation resumable and independently scalable.
- Preserve provenance so exact PDF-derived measurements are distinguishable from estimates based on extracted text.

## Scale Assumptions

The current production corpus contains approximately 757 documents and 752 cached PDFs. At the current average PDF size, expanding to approximately 56,000 records would require roughly 530 GiB of additional PDF storage. The existing Fly volume is therefore not an appropriate long-term corpus store.

Metadata ingestion is expected to be manageable at this scale. Content parsing, citation resolution, aggregate analytics, and PatternRank require architectural changes before the complete corpus is enriched.

## Import Rule Content Policy

Every import rule will have one required `content_mode` value:

| Mode | Behaviour | Persistent content | Expected measurements |
| --- | --- | --- | --- |
| `metadata_only` | Import metadata and perform no content retrieval. | None | Metadata-derived themes and concepts only. |
| `full_text_only` | Retrieve the repository's extracted `TEXT`/`*-full-text.txt` derivative. Never request an `ORIGINAL` PDF. | None by default | Word count, estimated page count, themes, concepts, and best-effort people/citations. |
| `pdf_stream` | Retrieve the original PDF into ephemeral worker storage, parse it, and delete it immediately. | None | Exact page count, PDF-derived word count, themes, concepts, people, and citations. |
| `pdf_cache` | Retrieve, parse, and retain the original PDF in configured durable object storage. | PDF | Same measurements as `pdf_stream`, with later reprocessing available without another source retrieval. |

This should be a single enum rather than a collection of overlapping booleans such as `downloadFiles`, `forceDownload`, and `useFullText`. A single policy prevents invalid or ambiguous combinations.

Each rule will also define:

- `content_fallback`: `metadata_only`, `full_text`, or `fail_document`.
- `extract_citations`: boolean.
- `extract_committee`: boolean.
- `run_concepts`: boolean.
- `max_content_bytes`: safety limit per document.
- `content_concurrency`: bounded per-rule concurrency.
- `content_rate_limit`: maximum repository retrieval rate.
- `cache_retention_days`: valid only for `pdf_cache`; omitted means retain until explicitly removed.

Defaults:

- Existing rules migrate to `metadata_only` unless their prior configuration unambiguously requested PDF analysis.
- New rules default to `metadata_only`.
- `full_text_only` never falls through to a PDF, regardless of fallback settings.
- `pdf_stream` and `pdf_cache` may fall back to full text only when an explicit snapshotted fallback policy is configured. Until that field is implemented, `pdf_stream` fails the document rather than silently changing the measurement source.
- A rule cannot override the deployment-wide prohibition on original PDF retrieval.

The admin interface will display the selected mode on every saved rule and replace the generic **Import + Analyze PDFs** action with **Import + Enrich Using Rule Policy**. Before running selected or all rules, the confirmation screen will summarize how many rules use each mode and explicitly warn when any rule will retrieve original PDFs.

The job record will snapshot the resolved rule policy at launch. Editing a rule while a job is running must not change that job's behaviour.

## Download-Counting Constraint

Streaming a PDF prevents persistent caching but still transfers the PDF bytes from the repository. It must therefore be treated as a download for policy and reporting purposes. Range requests, temporary files, and deletion after parsing do not change this classification.

`full_text_only` is the only content-processing mode that guarantees PatternRank will not request an original PDF. UBC exposes extracted full-text derivatives separately from item media, but whether accessing that derivative increments UBC's public download statistics must be confirmed with the Open Collections/cIRcle team before bulk processing.

Until that confirmation is obtained:

- The application must describe derivative retrieval as “original PDF not requested; download-counter status unverified.”
- A deployment-level `ALLOW_ORIGINAL_PDF_RETRIEVAL` guard must default to false for protected imports.
- Logs and job results must separately count metadata requests, full-text derivative requests, and original PDF requests.

## Target Architecture

### 1. Metadata ingestion

- Make all-degree scope explicit; a blank degree filter must not fall back to EdD.
- Use cursor/checkpoint-based incremental synchronization.
- Track source modification time, sync key, import-rule ID, and last-seen timestamp.
- Make document upserts idempotent and deduplicate records shared by multiple rules.
- Keep metadata import independent of all enrichment jobs.

### 2. Content enrichment

- Dispatch one idempotent enrichment job per document and processing version.
- In `full_text_only`, stream the text derivative through the parser and retain only derived results.
- In `pdf_stream`, use bounded ephemeral disk when the parser requires seekable input, then remove the file in a `finally` block.
- In `pdf_cache`, write PDFs to durable object storage rather than the Fly application volume.
- Apply timeouts, retry with backoff, content-size limits, host-level rate limits, and bounded concurrency.
- Record a checksum so unchanged content is not reprocessed.

### 3. Derived data and provenance

Store the following with every parsing result:

- Source type: metadata, extracted full text, streamed PDF, or cached PDF.
- Source identifier, source URL, content checksum, and retrieval timestamp.
- Parser, OCR, extraction, and concept-model versions.
- Word-count and page-count source.
- Whether page count is exact or estimated.
- Text-quality indicators and extraction warnings.
- Import rule and resolved content policy responsible for the result.

Full-text word counts are only as accurate as the repository's extracted text. Page counts derived from word counts remain estimates and must not be presented as exact PDF page counts.

### 4. Analytics serving

- Replace request-time loading of the full document corpus with database-side aggregates.
- Precompute summaries by corpus, degree, faculty, program, campus, and year.
- Paginate document and citation APIs.
- Incrementally refresh affected aggregate partitions after imports.
- Cache small summary responses rather than document collections in the web process.

### 5. PatternRank

- Partition processing by corpus, degree/faculty, and optionally year.
- Process only new or changed documents.
- Persist document candidates and embeddings between runs.
- Apply minimum document-frequency gates before embedding and bound candidates per document.
- Store concept dictionaries as versioned, scoped artifacts.
- Merge shard results into an optional global dictionary without erasing the Education-specific dictionary.
- Checkpoint batches so a worker restart does not restart the complete run.

### 6. Citation enrichment

- Run citation extraction and external resolution as separate job stages.
- Deduplicate citations globally before external lookups.
- Batch and rate-limit lookups.
- Allow citation processing to be disabled per import rule.
- Prioritize active corpora instead of automatically resolving every citation in the complete collection.

## Delivery Phases

### Phase 0: Policy validation

- Confirm UBC's treatment of extracted full-text requests in download statistics.
- Define the operational meaning of “download” for application reporting.
- Add the deployment-wide original-PDF retrieval guard.

Exit criterion: protected imports cannot issue an original PDF request, and full-text counter semantics are documented.

### Phase 1: Rule and job model

- Add the content-policy fields to import-rule storage and APIs.
- Migrate existing rules conservatively.
- Snapshot resolved policies into jobs.
- Update the admin rule editor and run summary.
- Replace legacy download booleans at import-rule boundaries.

Exit criterion: automated tests prove that `full_text_only` cannot call the original-PDF retrieval path.

### Phase 2: Zero-retention processing

- Add streaming full-text processing.
- Add ephemeral PDF processing and guaranteed cleanup.
- Move retained PDFs to object storage for `pdf_cache`.
- Add checksums, provenance, rate limits, and request counters.

Exit criterion: a worker restart or parse failure leaves no streamed PDF behind, and the Fly volume does not grow during zero-retention jobs.

Implementation note: Step 2 completes the zero-retention `pdf_stream` boundary and provenance/accounting foundation. Moving `pdf_cache` to object storage remains intentionally separate because the current Fly-volume artifact API is a persistent-cache contract; disguising another local path as object storage would preserve the scaling failure. Production-scale `pdf_cache` must not be enabled for the expanded corpus until a real object-store backend and migration procedure are implemented.

### Phase 3: Metadata-scale serving

- Import the complete metadata corpus with content retrieval disabled.
- Add database aggregates and pagination.
- Load-test at 1,000, 5,000, 10,000, and approximately 56,000 records.

Exit criterion: web memory remains bounded and key analytics endpoints meet their agreed latency target at full metadata scale.

### Phase 4: Incremental PatternRank and citations

- Implement partitioned, checkpointed PatternRank.
- Persist candidates and embeddings.
- Separate citation extraction from citation resolution.
- Add corpus-level scheduling and prioritization.

Exit criterion: adding or changing one cohort does not require rebuilding the complete corpus.

### Phase 5: Progressive enrichment

- Process a 100-document `full_text_only` quality sample.
- Compare derivative results against PDF-derived results for a small approved control set.
- Expand by degree/faculty cohorts while monitoring error rate, memory, throughput, repository request rate, and data quality.

Exit criterion: each expanded cohort meets quality and operational thresholds before the next cohort is scheduled.

## Required Tests and Operational Controls

- Contract tests for every `content_mode` and fallback combination.
- A network-spy test proving `full_text_only` never requests an `ORIGINAL` bitstream.
- Cleanup tests for success, timeout, parser failure, cancellation, and worker termination.
- Migration tests for existing import rules.
- Job-resume and idempotency tests.
- Metrics for request counts by derivative/original source, bytes transferred, cache growth, parse failures, and queue age.
- Alerts for any original-PDF request made by a protected rule.
- A kill switch that disables all content retrieval without disabling metadata imports.

## Decision Summary

Import rules are the correct place to declare content-processing intent. The rule selects metadata-only, full-text-only, streamed-PDF, or cached-PDF behaviour; the job snapshots and enforces that policy; and the parser records exactly what source produced each metric. A global safety guard remains authoritative so a rule cannot accidentally violate the no-original-download requirement.
