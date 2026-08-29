# Import Rule Content Controls

Step 6 makes content-processing policy part of each saved import rule and its immutable job snapshot. Editing a rule invalidates an existing progressive-rollout approval because the canonical revision includes every field below.

## Policy fields

| Field | Default | Enforcement |
| --- | --- | --- |
| `contentMode` | `metadata_only` | Selects metadata, extracted full text, streamed PDF, or cached PDF. |
| `contentFallback` | `fail_document` | On content failure, retain metadata, explicitly try extracted full text, or record a failed document. |
| `extractCommittee` | `true` | Enables committee parsing during document analysis. |
| `extractCitations` | `false` | Records eligibility intent for the separate content-versioned citation job; never extracts citations inline. |
| `runConcepts` | `true` | Records eligibility intent for the separate incremental PatternRank pipeline. |
| `maxContentBytes` | `209715200` | Caps each full-text or PDF response and cannot exceed the deployment maximum. |
| `contentConcurrency` | `1` | Bounds concurrently processed documents from 1 through 8. |
| `contentRateLimit` | `0` | Caps repository content requests per minute from 1 through 600; 0 relies on deployment-wide limits. |

The downstream citation/concept eligibility projection is deliberately separate. Step 4 made those pipelines asynchronous and content-versioned; running them inline during import would reintroduce unbounded job duration and memory use. Until that projection exists, the two intent flags are durable configuration but do not automatically include or exclude documents from scheduled corpus jobs.

Rate-window timestamps are reserved with compare-and-swap updates in libSQL. The window therefore survives automatic continuations and remains atomic if two workers contend for the same rule; it is not reset by process or Fly Machine boundaries.

## Fallback rules

- `full_text_only` never requests an original PDF. A `full_text` fallback therefore does not change its source, and the document fails if no valid derivative exists.
- `pdf_stream` and `pdf_cache` use full text only when `contentFallback` is exactly `full_text`.
- A successful full-text fallback is recorded without a terminal error and satisfies the rule policy using full-text word/page metrics; the original-PDF miss is represented by the `full_text_fallback` status.
- `metadata_only` fallback retains the metadata record and records `metadata_fallback` in file metrics.
- `fail_document` records the content failure. Other documents in the bounded batch continue, and progressive-rollout error gates decide whether expansion is allowed.
- The 10-document streamed-PDF control always uses `fail_document`, even when the saved rule permits full-text fallback.

## Safety hierarchy

Rule settings can only narrow deployment policy:

1. `DISABLE_CONTENT_RETRIEVAL=1` disables every content mode while leaving metadata imports available.
2. `ALLOW_ORIGINAL_PDF_RETRIEVAL` remains required for `pdf_stream` and `pdf_cache`.
3. The deployment-wide PDF rate limiter and 200 MiB maximum remain upper bounds.
4. The rule then applies its lower byte ceiling, content-request rate, and document concurrency.

The per-rule limiter covers cIRcle record/bitstream resolution and derivative/original content requests. The Open Collections search scan retains its existing API limiter.

## Operational guidance

- Keep concurrency at 1 until a representative sample passes the progressive-enrichment memory and throughput gates.
- Prefer `full_text_only` when original-PDF download counting must be avoided.
- Use `pdf_stream` when exact PDF measurements are required without retention. Streaming still counts as a repository download.
- Do not use production-scale `pdf_cache` until the object-storage phase replaces Fly-volume retention.
- Treat changes to fallback, extraction intent, bytes, concurrency, or rate as a new rollout revision requiring fresh evidence.
