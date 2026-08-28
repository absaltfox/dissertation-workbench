# Progressive Content Enrichment

Content enrichment expands one saved import rule at a time through three durable phases. The workflow is intentionally manual between phases: completing a worker job does not authorize the next cohort.

## Phases

1. `sample` processes 100 documents with `full_text_only`, regardless of the rule's eventual content mode. It must make zero original-PDF requests.
2. `control` streams original PDFs for an explicit 10-document allowlist taken from the passed sample evidence. The administrator must explicitly approve this bounded retrieval, and `ALLOW_ORIGINAL_PDF_RETRIEVAL` must also be enabled.
3. `cohort` processes one configured worker batch using the rule's saved content mode. A passing cohort returns the rule to `ready_for_cohort`; it does not automatically schedule another batch. When a terminal page or the upstream total proves that no eligible documents remain, the final cohort may be smaller than the batch target and the rollout becomes `completed`. Reaching a local scan or record ceiling is never treated as exhaustion.

The Admin import action derives the next allowed phase from the rule's rollout state. A failed phase may be retried, but later phases fail closed until the failed gate passes. Enrichment runs containing more than one content-processing rule are rejected so evidence and authorization cannot be mixed across cohorts. Metadata-only imports remain independent.

Every rollout stores a SHA-256 revision of the rule's cohort filters, query/index/source fields, and saved content mode. Editing any of those fields invalidates prior authorization and requires a new sample; renaming alone does not. Deleting a rule removes its rollout state and evidence. The legacy single-rule sync endpoint rejects content enrichment so it cannot bypass this workflow.

## Evidence and gates

`enrichment_rollout_evidence` is append-only by job and document. It preserves content source, parser/checksum provenance, word and page counts, and errors even when a later control run replaces the document's current `file_metrics` row. `enrichment_rollouts` stores the current state and most recent evaluation.

The default gates require:

- the complete target count and at least 95% successful word/page results;
- at least one processed document per minute;
- no more than 256 MiB observed heap growth;
- no more than 100 MiB retrieved per attempted document;
- no more than 1,000 repository requests per minute;
- for the sample, derivative provenance and zero original-PDF requests;
- for the control, matching derivative evidence for at least 80% of documents, median word-count relative error at or below 15%, and p90 error at or below 35%.

Page-count differences are recorded but are not an equality gate because repository text derivatives do not preserve physical PDF pagination. These defaults are code-versioned in `src/services/enrichmentRollout.js`; changing them is an operational policy change and requires tests and documentation.

Job results retain request counts, bytes, elapsed time, throughput, observed heap growth, check results, and the applied thresholds. Any original-PDF request in a protected sample writes an `ALERT` entry to the job log and blocks the rollout.

## Emergency stop and recovery

Set `DISABLE_CONTENT_RETRIEVAL=1` and restart web and worker processes to disable all content-enrichment paths while leaving metadata imports available. The admin route rejects new enrichment jobs, and the parser boundary rejects already queued or legacy enrichment work. `ALLOW_ORIGINAL_PDF_RETRIEVAL` remains a separate, default-off capability guard for streamed and cached original PDFs.

After investigating a failed gate, rerun the same phase from Admin. A worker timeout, stale heartbeat, signal, or uncaught failure also moves a running rollout to a retryable blocked state. Evidence from the earlier job remains available for audit; the current rollout points to the newest evaluated job. Do not edit rollout rows manually to bypass a gate.
