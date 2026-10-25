# Topic Label Generations and Stop Words Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop old topic labels from attaching to unrelated topics after a BERTopic rebuild, and stop stop words from dominating published topic terms.

**Architecture:** BERTopic numbers topics afresh on every fit, but label overrides, labelling runs/candidates, and the "previous label" fallback are keyed only by `topic_id`. Tie overrides and labelling runs to the `topics_generation` setting (already bumped atomically at publish by `publish_staged_topics`), use only current-generation rows, and ignore ID-keyed labels from earlier models on a full rebuild. Separately, pass the stop-word `CountVectorizer` to `update_topics()`, which otherwise replaces it with a default vectorizer.

**Tech Stack:** Python (`scripts/build-topics.py`, libsql_client / stdlib sqlite3 wrapper), Node 18 ESM (`src/db.js`), `node:test`.

**Spec:** Evidence gathered in-session on prod (2026-10-25): 46 rows in `topic_label_overrides` saved 2026-06-29..07-09 for the old 47-topic model, all 46 matching current `topics.label` by `topic_id`; the current model (topics `created_at` 2026-10-25T02:09) has unrelated content (e.g. topic 0 = reading tests, labelled "Indigenous and Decolonial Educational Practices"). Published `top_terms` lead with "the, of, and, to, in". BERTopic 0.17.4 `update_topics` sets `self.vectorizer_model = vectorizer_model or CountVectorizer(ngram_range=n_gram_range)`; `build-topics.py:1684` calls it without `vectorizer_model`.

## Global Constraints

- Python tests follow `test/topicLabelQuality.test.js`: a `node:test` file running `python3 -c` that loads `scripts/build-topics.py` via `importlib.util.spec_from_file_location`; no `bertopic`/`hdbscan`/`umap`/`torch` required; temp-dir SQLite only, never `data/metrics.sqlite`.
- Every Python change works on both libsql_client (Turso) and `SqliteClientWrapper`.
- Schema changes are additive and idempotent (`ALTER TABLE ... ADD COLUMN` wrapped so an existing column is not an error) on both the Node side (`src/db.js` migrations via `tryExec`) and the Python side (`ensure_topic_label_tables`).
- Rows with a NULL or different `generation` are stale: never applied, never shown as current. They are not deleted.
- No new dependencies. Commit per task referencing the plan; Co-Authored-By trailer naming the model.

## Review Focus

- A labels-only run (`run_label_only`) on the *same* model must still apply current-generation overrides and keep current labels as fallback.
- A full rebuild must not use previous `topics.label` values as fallback or as candidate evidence (`build_candidate_rows(..., existing_labels)`), and must not apply any override.
- Selecting a candidate / saving a manual label in the admin UI records the current generation, so it survives a later labels-only run but not a rebuild.
- `publishPassingTopicLabels` must not let a stale override block, or a stale candidate win, for the current model.
- `topics_generation` null (no model yet): nothing crashes; overrides saved then carry NULL and are treated as stale after the first real publish.

---

### Task 1: Keep stop words when refreshing topic representations

**Files:**
- Modify: `scripts/build-topics.py` (~L1680-1686)
- Test: `test/buildTopicsParams.test.js` (extend) or new `test/buildTopicsVectorizer.test.js`

**Interfaces:**
- Produces: `refresh_topic_representation(topic_model, docs, topics, vectorizer_model) -> None` — calls `topic_model.update_topics(docs, topics=topics, vectorizer_model=vectorizer_model)`. The outlier-reduction block calls it instead of `topic_model.update_topics(abstracts, topics=topics)`.

- [ ] **Step 1: Write the failing test** `refresh_topic_representation passes the stop-word vectorizer to update_topics` — a fake topic model records `update_topics` kwargs; assert `kwargs["vectorizer_model"] is vec` and `kwargs["topics"] == topics`. Second assertion: the source of the outlier block no longer contains a bare `update_topics(abstracts, topics=topics)` call (grep the file text) so the helper is actually used.
- [ ] **Step 2: Run** `node --test <test file>` — Expected: FAIL (`refresh_topic_representation` missing).
- [ ] **Step 3: Implement** the helper and use it at the outlier-reduction call site.
- [ ] **Step 4: Run** the test file and `node --test test/topicLabelQuality.test.js test/buildTopicsParams.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** — `fix(topics): keep stop-word vectorizer when refreshing topics after outlier reduction`

### Task 2: Scope label overrides and labelling runs to the topics generation

**Files:**
- Modify: `src/db.js` (topic label schema ~L586-600 + migrations; `listTopicLabelReviews` ~L6245; `selectTopicLabelCandidate` ~L6340; `updateTopicManualLabel` ~L6362; `publishPassingTopicLabels` ~L6387)
- Modify: `scripts/build-topics.py` (`ensure_topic_label_tables` ~L1046; `load_topic_label_overrides` ~L1095; `save_topic_label_candidates` ~L1174; `run_label_only` ~L1284; full-rebuild labelling block ~L1724-1752)
- Test: `test/topicLabelGenerations.test.js` (create; Node side against a temp DB) and a Python section in the same file or `test/buildTopicsLabelGenerations.test.js`

**Interfaces:**
- Schema: `topic_label_overrides.generation TEXT` and `topic_label_runs.generation TEXT` (nullable).
- Node: `selectTopicLabelCandidate` and `updateTopicManualLabel` write `generation = getSetting('topics_generation')`. `listTopicLabelReviews` returns only overrides with `generation = current` and only candidates whose run has `generation = current`. `publishPassingTopicLabels` considers only current-generation candidates and treats only current-generation overrides as blocking.
- Python: `load_topic_label_overrides(client, generation) -> dict[int, str]` returns rows with `generation = ?` only (empty dict when `generation` is None). `save_topic_label_candidates(client, candidates_by_topic, backend, model_name, config=None, generation=None)` stores `generation` on the run row. Full rebuild: `generation = now` (the same string later passed to `publish_staged_topics(client, now)`); `choose_topic_labels(..., overrides=None, existing_labels=None)` and `build_candidate_rows(..., existing_labels=None)`. `run_label_only`: `generation = current topics_generation setting`; overrides loaded for that generation; existing labels from live `topics` still used; run saved with that generation.

- [ ] **Step 1: Write failing tests.** Node (temp DB, seed topics + settings):
  - `stale overrides are hidden from the label review and do not block publishing` — override with `generation` NULL and one with `'g-old'`, setting `topics_generation='g-new'`: `listTopicLabelReviews()` topics have `override === null`; `publishPassingTopicLabels()` publishes a passing current-generation candidate for that topic.
  - `stale candidates are hidden` — candidate whose run has `generation='g-old'` is absent from the review; one with `'g-new'` is present.
  - `selecting a candidate or saving a manual label records the current generation` — read back `topic_label_overrides.generation === 'g-new'`.
  Python (temp sqlite via `SqliteClientWrapper`):
  - `load_topic_label_overrides returns only the requested generation` (NULL and other generations excluded; None → `{}`).
  - `save_topic_label_candidates stores the generation on the run`.
  - `choose_topic_labels with no overrides or existing labels never reuses a previous label` — candidates failing the bar → `bertopic_default_label` result (stub `topic_model`), not the old label.
- [ ] **Step 2: Run** the new test file(s) — Expected: FAIL.
- [ ] **Step 3: Implement** schema (both sides), Node functions, Python loaders/savers, and the two call sites (full rebuild, labels-only) per Interfaces.
- [ ] **Step 4: Run** new tests, `node --test test/topicLabelQuality.test.js test/adminWorker.test.js`, then `npm test` and `npm run lint` — Expected: PASS, lint clean.
- [ ] **Step 5: Commit** — `fix(topics): scope label overrides and runs to the topics generation`

## After merge (needs approval)

Push `worker-latest` and `labeler-latest` (both carry `build-topics.py`), deploy the web app, then run one full BERTopic rebuild: it publishes stop-word-free terms and labels chosen only from the new model's candidates (or BERTopic defaults). The 46 legacy overrides stay in the table, inert. Review labels in Admin → Topic Labels afterwards.
