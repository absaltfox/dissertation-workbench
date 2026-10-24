# Plan: Scale BERTopic pipeline to the full ~14k-document corpus

**Spec:** GitHub issue #57 (`gh issue view 57`). Issue text is the binding authority.
**Branch:** `feat/57-bertopic-scale`

## Global Constraints

- Primary file: `scripts/build-topics.py`. It runs as a Fly worker (`src/services/adminWorker.js`) against remote **Turso** via `libsql_client.create_client_sync` (HTTP), or locally via `SqliteClientWrapper` (stdlib `sqlite3`). Every change must work on **both** clients.
- **Never** point tests at `data/metrics.sqlite` (an iCloud-synced dev DB; fileproviderd locks it and tests hang). Tests use temp-dir databases only (see `scripts/isolate-test-data-dir.mjs` and existing tests).
- Python tests follow the existing pattern in `test/topicLabelQuality.test.js`: a Node `node:test` file that runs `python3 -c` and loads `scripts/build-topics.py` with `importlib.util.spec_from_file_location`. Tests must not require `bertopic`/`hdbscan`/`umap`/`torch`, so they can run in CI without ML deps. Exercise pure helpers with stubs or monkeypatching. `numpy` may be assumed available; if it is missing, skip that test cleanly (`{ skip }`).
- Run tests with `node --test test/<file>.test.js`. The full suite is `npm test`.
- Keep the `document_embeddings.embedding` column as **JSON text**. `src/db.js` `loadStoredEmbeddings`/`saveStoredEmbeddings` parse JSON. The BLOB migration in the issue is explicitly optional/deferred and is **out of scope**.
- No new Python dependencies. No new npm dependencies.
- SQL identifiers (table names) are never built from external input. Staging table names are hard-coded constants.
- Match the surrounding code style (print-based logging, `reporter.report(...)` progress calls).
- Commit per task with a conventional-commit message referencing `#57`.

## Task 1: Batched writes with retry

In `scripts/build-topics.py`:
- Add `write_rows(client, sql, rows, chunk=500, retries=3)`. It writes a list of parameter lists for one INSERT statement in chunks.
  - libsql_client sync client: use `client.batch([libsql_client.Statement(sql, params), ...])`. A batch runs as one transaction on Turso. Check the real installed API in `.venv` (or `requirements.txt` version) and use what exists.
  - `SqliteClientWrapper`: add a `batch(statements)` method that runs all statements in one transaction (`executemany` or a loop plus a single commit), with rollback on error. `write_rows` should go through one `client.batch` interface on both clients.
  - Retry each chunk up to `retries` times with exponential backoff (e.g. 0.5s, 1s, 2s) on exception, then re-raise. Log each retry.
- Replace the per-row loops for: embedding cache inserts (flush every encoded batch of 32, or every N rows, so progress survives a crash), `document_topics` inserts, `document_topic_coords` inserts, and `topics` inserts.
- Tests (`test/buildTopicsBatching.test.js`): `write_rows` chunks correctly (e.g. 1,201 rows / chunk 500 → 3 batches), retries then succeeds on a transient failure, re-raises after exhausting retries, and `SqliteClientWrapper.batch` is atomic (a failing statement rolls back the whole chunk). Use a temp sqlite file.

## Task 2: Paged embedding load into a float32 matrix

- Replace the single `SELECT doc_id, embedding FROM document_embeddings` with keyset pagination: `SELECT doc_id, embedding FROM document_embeddings WHERE doc_id > ? ORDER BY doc_id LIMIT ?` (page size 1000, constant `EMBEDDING_PAGE_SIZE`).
- Only keep embeddings for the doc_ids being clustered. Build a `doc_id → index` map first, preallocate `np.empty((n_docs, dim), dtype=np.float32)` once the first row reveals `dim`, and fill rows in place. Track which indices are filled. Unfilled indices are the docs to encode.
- Handle a dimension mismatch (e.g. model changed) by treating the row as missing and logging it.
- Free page data as you go. Never build a dict of all Python lists.
- Newly encoded embeddings are written into the same matrix (and persisted via Task 1's `write_rows`).
- Extract the loader into a function (e.g. `load_cached_embeddings(client, doc_ids)` → `(matrix, filled_mask, dim)`) so it can be tested.
- Tests (`test/buildTopicsEmbeddingLoad.test.js`): pagination across more than one page (use a small page size via a parameter), ignores rows not in doc_ids, handles a dim mismatch, and returns a float32 dtype. Skip if numpy is missing.

## Task 3: Atomic publish via staging tables

- Write `topics`, `document_topics`, `topic_hierarchy_meta`, and `document_topic_coords` results into staging tables `topics_next`, `document_topics_next`, `topic_hierarchy_meta_next`, `document_topic_coords_next` (hard-coded names, created `CREATE TABLE IF NOT EXISTS` with the same schema as live, and emptied at job start).
- At the end, swap in **one** `client.batch` (one transaction): for each table, `DELETE FROM live; INSERT INTO live SELECT * FROM live_next;`, then `DROP TABLE live_next`. Use explicit column lists, not `SELECT *`.
- The live tables must remain untouched until the swap. Remove the early `DELETE FROM document_topics/topics/topic_hierarchy_meta/document_topic_coords`.
- On any exception before the swap, drop the staging tables (best effort) and leave live data intact.
- `topic_label_candidates`/`topic_label_runs` writes are unchanged.
- Cache invalidation: find how the Node server learns that topics changed (search `src/` for how analytics caches are invalidated after a bertopic job completes, e.g. in `src/services/adminJobs.js`, `src/services/adminWorker.js`, `src/routes/metricsRoutes.js`, `src/db.js`). Make sure invalidation happens after the job completes (after the swap), not at job start. If it already does, document that in the report and add or confirm a test. Do not invent a new mechanism if one exists.
- `--labels-only` mode (`run_label_only`) is unchanged unless it writes the same live tables. If it does, keep its behaviour working.
- Tests (`test/buildTopicsAtomicPublish.test.js`): on a temp sqlite DB, extract the swap into a function (`publish_staged_topics(client)`). Live tables keep their old rows until the swap. After the swap they hold the staged rows and the staging tables are gone. A swap failure (e.g. a missing staging table) leaves live rows intact. Cleanup drops the staging tables.

## Task 4: Corpus-scaled clustering parameters and memory headroom

- Replace the fixed `MIN_TOPIC_SIZE = 5` usage in clustering with `resolve_min_topic_size(n_docs)` = env `BERTOPIC_MIN_TOPIC_SIZE` if set (a positive int; invalid → fall back to the default with a warning), else `max(5, round(n_docs / 500))`. Keep the `MIN_TOPIC_SIZE` constant as the floor and use it in the "Not enough abstracts" check.
- Optional cap: env `BERTOPIC_MAX_TOPICS` (positive int). If set, pass `nr_topics=<value>` to BERTopic. If unset, behaviour is unchanged.
- Report the chosen `min_topic_size`, `nr_topics`, and the discovered topic count through `reporter.report` detail and print.
- Memory: after the embedding matrix is built, `del` the cached-embedding intermediates. Before the second UMAP (2-D coords) fit, release objects that aren't needed (e.g. `probs` once written, label candidate structures once saved), then `gc.collect()`. Don't drop anything that later code still needs; check.
- Fly worker memory: in `src/services/adminWorker.js`, BERTopic jobs already use `Math.max(2048, FLY_WORKER_MEMORY_MB)`. Add an optional env `BERTOPIC_WORKER_MEMORY_MB` that, when set, overrides the memory for BERTopic jobs only (validated positive integer, else ignored). Add it to `src/config.js` following the existing env-var pattern and document it in `.env.production.example`. Do **not** change `fly.toml` values.
- Tests: `test/buildTopicsParams.test.js` for `resolve_min_topic_size` (100 → 5, 14,000 → 28, env override, invalid env), and extend `test/adminWorker.test.js` for the BERTopic memory override.

## Task 5: Frontend scatter on canvas; public topic counts

- `public/app/topic-visuals.js`: the topic cluster scatter (the function that builds `plotDocs` around line 126) renders d3 SVG circles per document. Render the points on a `<canvas>` (device-pixel-ratio aware), keeping the existing look (colours per topic, sizes, legend). Keep any hover/selection/tooltip behaviour. Use a d3 `quadtree`, or a nearest-point search on mousemove, for hit testing, and keep SVG only for overlays (axes, labels, highlight ring) if they exist. Match the existing light/dark theming (read the CSS custom properties the current code uses).
- Public topic counts: determine whether public (non-admin) analytics `topicData` counts come from the full-corpus SQL path (`computeTopicDataByYearSql` / topic distribution in `src/db.js` ~L2400) or from the `PUBLIC_MAX_RECORDS`-capped record sample (`src/routes/metricsRoutes.js` ~L81, ~L824). If topic counts already come from full-corpus SQL, add a test pinning that and note it in the report. If they come from the capped sample, switch topic distribution and by-year counts to the full-corpus SQL path for public requests, consistent with how other full-corpus analytics work (see `test/fullCorpusAnalytics.test.js`). Note that the client `public/app/data.js` ~L318 recomputes topic counts from the loaded docs when filters apply. Report the finding; don't redesign filtering.
- Tests: a server-side test for the topic-count source. For the canvas change, the existing e2e/Playwright tests (if any touch the topic scatter) must still pass. Run `npm run lint`.

## Task 6: Synthetic 14k verification harness

- Add `scripts/bench-topics-scale.py` (or `.mjs` if that's simpler) that creates a **temp** sqlite DB (never `data/`), seeds N (default 14,000) fake documents with abstracts and random 768-dimension embeddings in `document_embeddings` (JSON), and runs `build-topics.py` against it. The script must have a mode that runs the DB-I/O paths without ML deps (e.g. a `--io-only` flag that exercises Tasks 1–3 helpers end to end: paged load → batched writes into staging → publish), reporting wall time, batch count, and peak RSS (`resource.getrusage`).
- While publishing, a concurrent reader process polls `SELECT COUNT(*) FROM topics` and asserts it is never 0 when the DB was pre-seeded with old topics (verifies there's no empty window).
- Failure injection: an option to raise mid-write (before the swap) and assert live topics are unchanged afterwards.
- Add a Node test (`test/buildTopicsScaleHarness.test.js`) that runs the harness in `--io-only` mode with a small N (e.g. 2,000) and asserts success. Keep it under ~30s.
- Document how to run the full benchmark (including against a Turso staging DB via `TURSO_DATABASE_URL`) in a short section of `README.md` near the existing BERTopic docs.
