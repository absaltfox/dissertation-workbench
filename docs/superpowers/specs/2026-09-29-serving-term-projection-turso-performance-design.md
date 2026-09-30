# Serving Term Projection & Turso Read-Path Performance — Design

- **Status:** Approved — §7 decisions locked (full-corpus co-occurrence; keep-one-release fallback)
- **Date:** 2026-09-29
- **Scope:** Cold-path latency of `/api/workbench/analytics`, `/api/workbench/documents/:docId` (related docs), and supporting read queries, measured against **remote Turso** production.
- **Governing standard:** `docs/metadata-scale-serving.md` (Metadata-Scale Serving Standard). This design is an in-convention extension of it, not a departure.

## 1. Problem

Production (`dissertation-workbench` on Fly) serves reads from a **pure remote Turso HTTP client** (`createClient({ url, authToken })`, no embedded replica — `src/db.js:48`). Every cache-miss query is a network round-trip to Turso, and every returned row is paid as network transfer. The in-process `metricsCache` masks this on warm hits (~55–90 ms) but not on cold hits.

Measured against prod (14,408 documents, 2026-09-29):

| Path | Cold latency | Root cause |
|---|---|---|
| `/workbench/analytics` | ~10.4 s | ~13 queries, most `FROM documents d, json_each(d.metadata_json, …)` full-table JSON re-parses; **plus a 5,000-row `metadata_json` sample transferred to Fly** for JS term co-occurrence (`queryCachedDocumentPage` limit 5000). |
| `/workbench/documents/:docId` | ~2.6–3.8 s | `queryRelatedDocuments` (`src/db.js:2391`): correlated `json_each` EXISTS scan over all 14k docs × up to 24 terms, unindexed. Docs with no terms early-return (~0.7 s). |

The derived array fields the hot paths depend on — `themes`, `conceptTerms`, `methodologies` — exist **only inside the `metadata_json` blob**. There is no index for them and no normalized projection. The `metadata-scale-serving` standard anticipates exactly this: it permits "normalized facet/term projections" as the sanctioned scaling move, and its own 56k-record **local** baseline (analytics 40 ms) confirms the production gap is Turso network + transfer, not compute.

## 2. Goals / Non-goals

**Goals**
- Cold `/workbench/analytics` and related-docs within the standard's budgets **on Turso**, verified by production telemetry.
- Remove per-query whole-blob JSON re-parsing on the two hot paths.
- Eliminate the 5,000-row `metadata_json` transfer from the analytics cold path.
- Byte-identical outputs for related-docs and analytics term aggregations (no user-visible regression), except one explicitly flagged co-occurrence decision (§7).

**Non-goals (deferred, with rationale)**
- **FTS5** — neither JSON-expansion nor a normalized projection; unverified on the production Turso tier; cold search (~0.6–1.1 s) is already near the 1.5 s page budget. Out of scope; revisit only if telemetry demands it, gated on a Turso FTS5 verification spike.
- **Materialized summary/rollup tables** — the standard deliberately uses live indexed aggregates to avoid invalidation races. This design keeps that stance; citation counts stay live (§3.5).
- **libSQL embedded replicas** — considered and declined for this pass (keeps the remote-client model and current freshness semantics). Recorded as the next available lever if indexing proves insufficient.

## 3. Design

### 3.1 `document_terms` normalized projection

```sql
CREATE TABLE IF NOT EXISTS document_terms (
  doc_id TEXT NOT NULL,
  kind   TEXT NOT NULL,   -- 'theme' | 'concept' | 'methodology'
  term   TEXT NOT NULL,   -- trim(CAST(value AS TEXT)): display form, preserves current GROUP BY output
  PRIMARY KEY (doc_id, kind, term)
);
CREATE INDEX IF NOT EXISTS idx_document_terms_kind_term      ON document_terms(kind, term);         -- analytics GROUP BY / ORDER
CREATE INDEX IF NOT EXISTS idx_document_terms_kind_termlower ON document_terms(kind, lower(term));  -- related-docs case-insensitive match
CREATE INDEX IF NOT EXISTS idx_document_terms_doc            ON document_terms(doc_id, kind);       -- per-doc term fetch + self-join
```

- `term` stores the **trimmed display form** (not lowercased), so analytics `GROUP BY term` reproduces today's `trim(CAST(term.value AS TEXT))` output exactly. Related-docs matches case-insensitively through the `lower(term)` index, matching today's `lower(...)` comparison.
- Only the three array kinds that drive the hot paths are projected. `affiliation` and `supervisor` stay as-is: affiliation faceting already meets budget via `json_each`, and supervisor search is out of scope (FTS deferred). Kept narrow on purpose.
- `metadata_json` remains the source of truth; `document_terms` is a derived read accelerator, exactly like `document_people`.

### 3.2 Projection write (metadata upsert)

Mirror the `document_people` pattern (`src/db.js:1082`): in the same write batch that upserts document metadata, delete this doc's `document_terms` rows and reinsert from `doc.themes` / `doc.conceptTerms` / `doc.methodologies` (trimmed, de-duplicated, empties dropped). One transaction, no partial states.

### 3.3 Backfill — `serving_projection_version = 2`

Extend the existing versioned, resumable backfill (`src/db.js:1099`):
- Add `backfillDocumentTermsProjection`, gated by `serving_projection_version < 2`, batched at 500 docs/iteration, bumping the row to `2` per batch.
- Honors the standard's hard rule: **never read all metadata rows into one JavaScript collection** — each batch parses ≤500 blobs, writes term rows, advances the watermark.
- **Runs non-blocking after `server.listen()`** with a `projectionWarming` state, so a deploy serves immediately; term-backed queries fall back to the legacy `json_each` path (§6) until the watermark completes. One-time cost over 14k rows.

### 3.4 Read-path rewrites (identical outputs)

- **`queryRelatedDocuments`** — replace the 24-term correlated `json_each` EXISTS scan with a JOIN/GROUP BY on `document_terms` filtered to the target doc's terms, matched via `lower(term)`. Same overlap semantics, same `ORDER BY overlap DESC, year DESC, title ASC`, same `LIMIT`.
- **Analytics term aggregations** (`getDocumentServingAnalytics`, `src/db.js:2016`): themes, concepts, methodologies, concept-timeline, methodology×concept, supervisor-ngram term joins swap `json_each(metadata_json, '$.<kind>')` for `document_terms WHERE kind = ?`. Same GROUP/ORDER/LIMIT and filter args (`filters.where` still applies via a JOIN back to `documents d`).

### 3.5 Bounded live citation counts (no materialization)

Replace the per-page `LEFT JOIN (SELECT doc_id, COUNT(*) … GROUP BY doc_id)` over the whole `document_citations` table (`src/db.js:1570`) with a count restricted to the page's returned `doc_id`s, served by the existing `idx_document_citations_doc_id`. Live, indexed, bounded — consistent with the standard's "no materialized summaries" stance and its invalidation-race avoidance.

### 3.6 Compact-input co-occurrence (kills the 5,000-blob transfer)

The co-occurrence math in `buildTermCooccurrence` (`src/metrics.js:568`) is **not** a simple pair count: it keeps only multi-doc concepts (dictionary `multiDocSet`), drops a methodology blocklist, applies a fragment filter, and ranks pairs by **lift**. That scoring stays in JavaScript unchanged — moving it into a SQL self-join would risk different output and is explicitly rejected.

What changes is only the **data source** for the per-document concept lists the builder consumes. Today it receives a 5,000-row sample of full `metadata_json` (`VISUALIZATION_DOCUMENT_LIMIT`) and extracts concepts per doc via `docConceptTerms`. Instead, fetch the concept lists directly from `document_terms` (compact `(doc_id, term)` rows — kilobytes, not megabytes) and run the identical pairing/scoring code. Same inputs → same outputs, without shipping blobs.

**Correctness requirement / open plan detail.** `document_terms` must reproduce the exact list each consumer reads:
- Analytics concepts panel (§3.4) aggregates the raw `conceptTerms` array (uncapped).
- Co-occurrence consumes `docConceptTerms` output, which equals `conceptTerms` for docs that have it, but is **derived from title/abstract/subjects** for the minority of docs with no stored `conceptTerms`.

So the projection must persist the derived concepts for those docs (computed once at projection time, via the same `docConceptTerms` path), not merely the raw array. The implementation plan pins this projection contract — whether that is one `kind` serving both readers or a distinct co-occurrence kind — and the golden equivalence test (§5, item 1) guards that the pairing/scoring output is unchanged.

**Decided (§7.1): full-corpus.** Because the input is now compact, co-occurrence runs over **all** documents' concept lists, not the current 5,000-doc sample (`VISUALIZATION_DOCUMENT_LIMIT`). The pairing cost stays bounded by the existing `TERM_COOCCURRENCE_MAX_TERMS = 400` vocabulary cap and the ~20-term per-doc budget, so full-corpus is cheap in JS once the blobs are no longer transferred. This is a deliberate accuracy improvement over the sampled result.

**Disclosure contract change.** The analytics `source` fields that currently advertise sampling change accordingly: `termCooccurrenceSampled` becomes `false`, and `termCooccurrenceSampleSize` / `termCooccurrenceSampleOf` report the full corpus count (or are dropped — pinned in the plan). This is the one intentional, disclosed output change in the design; the golden equivalence test asserts the *pair/lift results* match a full-corpus reference run, not the old sampled run.

### 3.7 Post-sync cache-warm

Extend the existing `warmWorkbenchCache` to also warm `/workbench/analytics` and `/workbench/visualizations` after projection completes, so the first post-sync visitor never pays a cold fan-out to Turso. Complements the projection; does not replace it.

## 4. Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `document_terms` schema + indexes (`src/db.js` schema block) | Durable normalized term store | migrations |
| term projection statements (`src/db.js`, beside `metadataPeopleStatements`) | Derive term rows on every metadata write | doc metadata |
| `backfillDocumentTermsProjection` (`src/db.js`) | One-time resumable backfill at version 2 | `serving_projection_version` |
| rewritten `queryRelatedDocuments` / analytics term queries / co-occurrence | Read from projection, not blobs | `document_terms` |
| cache-warm extension (`src/server.js` `warmWorkbenchCache`) | Pre-populate cold analytics/visualizations | metricsCache |

Each is independently testable: projection correctness (blob → rows), backfill resumability, and per-query output equivalence.

## 5. No-regression verification (the "without regressions" bar)

1. **Golden equivalence tests** — for a representative fixture set, assert the rewritten related-docs / analytics term-list / citation-count / co-occurrence outputs are **equal to the current `json_each` outputs on the same data**, before any query is flipped.
2. **Extend `npm run test:metadata-scale`** — the existing 1k→56k synthetic harness with its budgets (analytics 3 s, page 1.5 s). Add projection build to the seed path so scaled runs exercise `document_terms`; tighten the analytics budget once local numbers land.
3. **Turso production telemetry** — re-run the `scratchpad/perftest.mjs` harness (or a committed version) against prod after deploy; cold analytics and related-docs must meet an agreed threshold. The standard already mandates Fly/Turso acceptance beyond local numbers.
4. **Existing `test/` suite green**, plus new unit tests: projection idempotency (re-write produces identical rows), backfill resumability (interrupt/resume reaches the same state), and empty-terms early-return parity.

## 6. Rollout & reversibility

- Additive schema; backfill idempotent and version-gated.
- Each rewritten query keeps its **legacy `json_each` path behind a fallback** used while `projectionWarming` is true (watermark incomplete). This makes the projection switch reversible per-query without a schema rollback and lets a bad deploy degrade to the old behavior rather than fail.
- Non-blocking backfill means boot time is unchanged; the projection warms in the background on first deploy.

## 7. Decisions

1. **Co-occurrence exactness — DECIDED: full-corpus.** Compute co-occurrence over all documents' concept lists (not the 5,000-doc sample), fed from `document_terms`. The disclosed sampling fields change per §3.6. This is an intentional accuracy improvement; the golden test validates against a full-corpus reference.
2. **Fallback flag lifetime — DECIDED: keep one release, then remove.** The per-query `json_each` fallback (§6) ships enabled, guards the projection rollout, and is removed in a follow-up cleanup PR once production telemetry confirms the projection path.

## 8. Risks

- **Projection drift** — a write path that updates `metadata_json` term arrays without rebuilding `document_terms` would desync. Mitigation: projection lives in the same batch as the metadata upsert (single writer for that field), matching the `document_people` guarantee; golden tests assert parity.
- **Turso write amplification** — term rows add inserts per doc on sync. Bounded (a handful of arrays per doc), confined to sync/worker writes, not the serving path.
- **Co-occurrence vocabulary cap** must match the current builder's cap exactly to preserve output; covered by the golden test.
