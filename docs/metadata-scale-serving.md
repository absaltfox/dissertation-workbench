# Metadata-Scale Serving Standard

This document defines the Step 3 serving contract for corpora up to approximately 56,000 metadata records.

## Bounded Web Reads

Public workbench handlers must not materialize the complete `documents.metadata_json` corpus in Node.js. Filtering, searching, sorting, aggregation, citation counting, and pagination run in SQLite/libSQL before rows reach the web process.

- Bootstrap responses contain counts and facet values, not documents.
- Document and citation endpoints return at most 100 rows per request.
- People lists use `document_people`, a normalized durable projection keyed by the canonical person key.
- Person detail responses combine corpus-complete database aggregates with a document page capped at 100 rows; `source.hasMore` exposes additional pages.
- Related-document lookup scores overlap in the database and returns at most six rows by default.
- For corpora above 5,000 records, analytics use complete database aggregates and return at most 100 projected document samples.
- Topic visualizations use only documents with persisted topic assignments and explicitly cap the working set at 5,000 documents. Responses report `documentsAvailable`, `documentsReturned`, and `documentsTruncated`; Phase 4 will replace this bounded sample with incremental topic projections.
- The compatibility `/api/metrics` endpoint is bounded by `maxRecords`.

Persisted themes, concepts, methodologies, word/page metrics, and their source fields are the authoritative inputs to large-corpus analytics. Request-time NLP over an entire corpus is prohibited. Detailed cross-term analytics remain available for corpora of at most 5,000 records; Phase 4 owns scalable incremental concept/topic matrices for larger corpora.

## People Projection

`document_people` is updated in the same database batch as document metadata. Committee mutations update the authoritative `committee_members` row and rebuild its projected relationship in one write transaction. Projection selection resolves all canonical spelling variants for a normalized person key together, prefers API rows over lower-priority extraction rows, and restores the next surviving canonical row after deletion. Person keys retain Unicode letters and numbers so non-Latin names are not discarded. `documents.serving_projection_version` makes legacy metadata backfill resumable in 500-document batches. Each 500-row committee backfill batch reads canonical candidates, rebuilds projections, and persists its last processed committee ID inside one serialized write transaction, then records completion separately.

Future projection changes must increment the projection version and remain bounded and resumable. Startup migration must never read all metadata rows into one JavaScript collection.

## Aggregate Strategy

Step 3 uses live indexed database aggregates rather than materialized summary tables. At the target corpus size this is simpler, avoids invalidation races, and substantially exceeds the latency budget. Materialized partitions may be added later behind the same endpoint contracts if production telemetry shows they are necessary.

The database implementation depends on SQLite/libSQL JSON functions for affiliation and persisted-signal aggregation. Any future database backend must provide equivalent JSON table expansion or introduce normalized facet/term projections before migration.

## Performance Contract

Run:

```bash
npm run test:metadata-scale
```

The harness cumulatively seeds 1,000, 5,000, 10,000, and 56,000 synthetic records, assigns topics, then measures bootstrap summary, filtered/searchable document pagination, database analytics, people pagination, and the bounded topic-document page.

Default budgets:

- Bootstrap summary: 1.5 seconds.
- Filtered document page: 1.5 seconds.
- People page: 1.5 seconds.
- Analytics: 3 seconds.
- Topic-document page: 3 seconds.
- Retained heap growth per measurement: 64 MB.

Environment variables can tighten budgets or select sizes: `METADATA_SCALE_SIZES`, `METADATA_SCALE_SUMMARY_TARGET_MS`, `METADATA_SCALE_PAGE_TARGET_MS`, `METADATA_SCALE_ANALYTICS_TARGET_MS`, `METADATA_SCALE_PEOPLE_TARGET_MS`, `METADATA_SCALE_TOPIC_PAGE_TARGET_MS`, and `METADATA_SCALE_MAX_HEAP_MB`.

The final Step 3 local 56,000-record baseline was 210 ms for summary, 99 ms for a filtered page, 40 ms for analytics, 231 ms for people, and 165 ms for the 5,000-document topic page. The topic page retained 3.7 MB after forced garbage collection; the other measurements retained no heap. These are local SQLite results; deployment acceptance also requires Fly/Turso production telemetry.
