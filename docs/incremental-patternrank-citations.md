# Incremental PatternRank and Citation Jobs

Step 4 separates corpus enrichment into bounded, restartable jobs. Metadata imports no longer extract citations inline, and a concept rebuild processes one partition instead of loading and embedding the complete corpus.

## PatternRank partitions

`POST /api/admin/concepts/rebuild` starts the next changed partition by default. Automatic partitions are stable, disjoint degree-and-exact-year cohorts, including a separate missing-year cohort. A cohort above `CONCEPT_PARTITION_MAX_DOCUMENTS` fails closed and must be replaced by non-overlapping program scopes or approved for a higher tested limit. Operators may request an explicit `syncKey`, `degree`, `program`, `affiliation`, `yearFrom`, or `yearTo` scope and set `priority` from -1000 through 1000. `force: true` rebuilds a clean requested scope.

The canonical automatic partition family is the only source of the global merged dictionary. Automatic and explicit scopes use separate key namespaces, so even an identical degree/year request cannot mutate the canonical row. Explicit artifacts are retained but do not replace or join the global dictionary. Replacing a canonical shard requires a future validated partition-management operation; the rebuild endpoint cannot create an overlapping global shard.

Each run:

1. compares partition document count and newest source update with its last completed run;
2. loads at most `CONCEPT_PARTITION_MAX_DOCUMENTS` records;
3. reuses candidates and document embeddings whose model-and-content checksum is unchanged;
4. persists partition candidate-frequency contributions, applies the corpus-wide document-frequency gate before embedding phrases, and marks older shards pending when a phrase crosses that gate;
5. persists changed document states in `CONCEPT_CHECKPOINT_BATCH_SIZE` batches and reuses global phrase embeddings;
6. writes a versioned partition artifact and publishes a merged artifact only after every enabled automatic partition has a ready version.

The durable tables are `concept_partitions`, `concept_document_state`, `concept_partition_candidates`, `concept_phrase_embeddings`, `concept_partition_artifacts`, and `concept_publication_state`. The current global artifact remains live while a new generation has pending shards, so the first shard can never replace it with a partial dictionary. A generation signature is recorded only after an atomic artifact write succeeds; worker interruption or publication-only failure is therefore discovered as pending publication on the next run. Removed or newly oversized cohorts disable their old contribution and force surviving shards through the corpus-wide frequency gate before republishing. A failed processing or upload job never deletes its last completed artifact; keyed failed work and keyless publication work both remain retryable.

Relevant controls:

- `CONCEPT_PARTITION_MAX_DOCUMENTS`: hard in-memory partition boundary; default 5,000.
- `CONCEPT_CHECKPOINT_BATCH_SIZE`: document checkpoint batch; default 50, minimum 10.
- `CONCEPT_MIN_DOCUMENT_FREQUENCY`: phrase gate before phrase embedding; default and minimum 2.
- `CONCEPT_MAX_CANDIDATES_PER_DOC`: maximum generated candidates per document; default 160.
- `CONCEPT_TOP_CANDIDATES_PER_DOC`: maximum ranked phrases retained per document; default 12.
- `CONCEPT_PARTITION_MAX_CONCEPTS`: maximum concepts retained in one shard artifact; default 5,000.
- `CONCEPT_GLOBAL_MAX_CONCEPTS`: maximum concepts retained after the global shard merge; default 50,000.
- `CONCEPT_PATTERNRANK_MODEL` and `CONCEPT_PATTERNRANK_MIN_SCORE`: model and acceptance threshold.

The `deterministic_test` embedding backend is test-only and refuses to run unless `NODE_ENV=test`; production always uses the configured sentence-transformer model.

## Citation extraction

`POST /api/admin/reparse-citations` is now a bounded extraction job. It accepts `pageSize` (maximum 250), `maxDocuments` (maximum 5,000), plus optional `syncKey`, `degree`, `program`, and `affiliation` scope fields. It reads only an already-cached PDF or already-cached full-text artifact. It does not call an Open Collections retrieval path, so running this job causes no new repository PDF or full-text download.

`citation_extraction_state` records the content checksum, citation parser version, status, count, and error for each document. Completed unchanged documents are skipped. Changed content, a parser-version change, and failed documents enter a later extraction run again. Extraction jobs use strict error propagation so parser or citation-persistence failures cannot be checkpointed as completed. Each result reports the last document cursor, whether the job limit was reached, and `resolutionQueued: false`.

Citation extraction updates the shared deduplicated citation tables but never starts an external catalogue lookup. Resolution is a separate `POST /api/admin/jobs/catalogue-lookup` job. It accepts the same corpus scope, prioritizes citations used by the most documents, and applies the existing bounded, rate-limited Z39.50 processing. This separation allows extraction from a large corpus without automatically generating external catalogue traffic.

## Scheduling rules

- Metadata import, content retrieval, citation extraction, citation resolution, and PatternRank are distinct jobs.
- Public reads never start any of these jobs.
- Run citation extraction for a selected corpus, inspect its failure and quality counts, then start scoped resolution explicitly.
- Schedule one PatternRank partition at a time. Repeated scheduled runs drain changed never-run partitions first, then changed completed partitions by priority and oldest completion.
- Do not treat streamed PDF parsing as “not a download.” Only this cached-artifact citation reparse is guaranteed to issue no new content retrieval.

## Verification contract

The integration suite proves that a completed citation checkpoint is skipped until its content checksum changes, strict citation failures propagate, and scoped lookup queues exclude other corpora. PatternRank tests cover unchanged no-op runs, changed-document reuse, withheld partial generations, upload retry, corpus-wide frequency gating across shards, and removal of retired shard contributions.
