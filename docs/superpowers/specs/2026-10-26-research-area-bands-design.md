# Research-area bands for Topic Evolution: design

Status: draft for approval · 2026-10-26

## Why

The Topic Evolution chart (`public/app/topic-visuals.js`, "Topic Evolution
Sankey") is meant to answer one question: **how research in topic areas at UBC
has grown and shrunk over time.** It merges the ~104 BERTopic topics into 10
bands and names each band after its largest child topic
(`src/topicHierarchy.js` `buildParentClusters`).

That misrepresents the data in two ways:

1. **Names.** A band called "Fish Physiology & Salmon Biology" also contains
   physics, pure maths, biochemistry and exercise physiology. The name
   describes one child, not the band.
2. **Grouping.** Some bands aren't coherent. "Social Work & Social Welfare
   Services" (2,327 papers) also holds regional planning, reading tests,
   marital coping, forestry and career development. The cause is in
   `scripts/build-topics.py` (~line 1793). The hierarchy is built from
   `topic_model.topic_embeddings_`, but the outlier step just before it calls
   `update_topics()`, and BERTopic then rebuilds topic embeddings from
   **c-TF-IDF-weighted words**, not from the papers. Topics end up grouped by
   shared vocabulary ("subjects", "variables", "significant"), which tracks
   era and method more than subject.

The owner's intent: bands are **themes that can cross departments**, grouped
**automatically from the BERTopic topic hierarchy based on what the papers
mean**, with names that describe the whole band, and **people can rename bands
by hand the same way they rename topics.**

## Evidence (offline test, 2026-10-26)

The test regrouped the current prod topics by the mean SPECTER embedding of
each topic's papers, using the exported corpus. Nothing in prod changed.

- Script: scratchpad `sim/hier_spike.py`.
- Method: mean-centred, L2-normalised centroids, then Ward linkage.
- Result: clearly more coherent bands, for example literature, languages &
  art history; psychology; politics & political history; urban planning;
  language & teacher education.
- Two bands remain mixed:
  - social work + forestry/land use (+ the sciences, at ≤13 bands);
  - law & policy + museums/archaeology/migration.
- These are accepted. We follow what the tree says rather than forcing
  splits.
- Natural cut points: the biggest relative merge-height gaps are at 3 bands,
  then 9, 6 and 10.

## Goals

1. **Meaning-based hierarchy.** The topic hierarchy is computed from each
   topic's **paper centroid**: the mean of its assigned papers' SPECTER
   embeddings, mean-centred across the corpus and L2-normalised, with Ward
   linkage. This replaces the word-based topic embeddings. The existing
   Topic Hierarchy tree view uses the same linkage, so it improves too.
2. **Dynamic band count.** Bands come from cutting the tree at its largest
   natural gap within a readable range of **6–15 bands** (default). There is
   no fixed k.
   - *Convention (Claude's call):* let `h` be the n−1 merge heights in
     ascending order (0-based), for n leaf topics.
   - Exactly k clusters exist after merge `n−k−1` and before merge `n−k`.
   - `gap(k) = (h[n−k] − h[n−k−1]) / h[n−k−1]`. Pick the k in range with the
     largest `gap(k)`; break ties by the smaller k.
   - On the 2026-10-26 prod topics this gives:
     - gap(3) ≈ 0.30, gap(9) ≈ 0.17, gap(6) ≈ 0.14, gap(10) ≈ 0.12;
     - within 6–15 it selects **9**.
3. **Automatic band names.** At build time each band gets a name from the
   **same automatic labeller the topics use**:
   - Claude when `ANTHROPIC_API_KEY` is set;
   - otherwise the configured local backend (today Qwen2.5-0.5B via
     transformers, or llama.cpp).

   The labeller is prompted with the band's child topics (their labels and top
   terms) and some representative paper titles. It is asked for a short name
   covering the **whole** band.
4. **Manual band names.** An admin can view each band with its child topics
   and paper count, edit its name, and reset to the automatic name. This
   mirrors topic labels.
5. **Generation-scoped, like topic labels.** Bands and their manual names
   belong to one `topics_generation`. A full rebuild produces new bands with
   fresh automatic names. Manual band names from the previous generation are
   archived, not carried over, just as topic labels are today.
6. **Chart shows every band** (up to 15) with its band name. The chart and
   legend need enough distinct colours for 15.

## Non-goals

- Hand-curating which topics belong to which band.
- Grouping by department/program.
- Changing how topics themselves are found (UMAP/HDBSCAN settings, seed,
  stop words).
- Carrying manual band names across rebuilds by matching similar bands.
- Showing band boundaries or names inside the Topic Hierarchy tree view.
  It only picks up the new linkage.

## Anti-goals (failure even if it "works")

- A band name that describes only its largest child.
- Bands that change between page loads, or differ between the chart and the
  admin, within one generation.
- A rebuild that publishes topics but leaves bands missing or stale. Bands
  must be published atomically with the topics, through the same `*_next`
  swap.
- Using titles in place of missing abstracts anywhere in this work (standing
  rule).

## Constraints

- Prod is a Fly app using remote Turso. BERTopic runs on Fly worker machines
  (`worker-latest` image, `labeler-latest` retagged to the same digest).
  Python changes ship by pushing the worker image (see the deploy runbook in
  memory). Web changes ship with `fly deploy`. **Every prod deploy needs the
  owner's explicit approval first** (`.agents/rules/deployment.md`).
- Document embeddings are already cached in Turso (`document_embeddings`), so
  centroids need no re-encoding.
- Zero npm dependencies on the Node side. Tests use `node --test` and run
  the Python helpers through `.venv`.
- Ward linkage expects Euclidean geometry. Use Euclidean distance on the
  normalised centroids. Don't feed cosine distances to Ward, as the current
  code does.

## Decided by the owner

- Bands are automatic, from the topic hierarchy, based on paper meaning.
- The band count is dynamic, from how topics roll up in the hierarchy.
- Band names come from the automatic labeller and can be edited by hand,
  like topic labels.
- Building this is worth it even with the two mixed bands.
- **Rollout without a refit (owner chose option B).** Add a bands-only job
  that recomputes the meaning-based hierarchy and bands for the **current**
  generation. It replaces the stored linkage, writes the bands and generates
  automatic band names. It does not refit topics or change
  `topics_generation`.
  - Inputs: cached `document_embeddings` plus the existing `document_topics`.
  - Today's topics and their 104 manual labels stay as they are.
  - It runs on the worker like the other jobs and is started from the admin,
    like "Regenerate labels".
  - It stays available afterwards, for example if band settings change
    without a full rebuild.
  - Full rebuilds also produce bands, through the same shared code.

## Claude's calls (owner can override)

- **Readable range of 6–15 bands.** Keep it configurable by env var (e.g.
  `TOPIC_BANDS_MIN`/`TOPIC_BANDS_MAX`), in the same style as
  `BERTOPIC_MIN_TOPIC_SIZE`.
- **Bands are computed in the Python build and persisted**, not cut in JS at
  request time:
  - store a band table (band id, auto name, ordered child topic ids, paper
    count) in the generation-scoped publish;
  - store manual band names in a generation-scoped override table modelled on
    `topic_label_overrides`.

  Rationale: the labeller runs in the worker, and bands must be identical
  everywhere within a generation.
- **Band ids** are deterministic within a generation: 0..n−1, ordered by paper
  count descending.
  - This keeps the shape `byYear` and the Sankey already use (`topicId` = band
    index).
  - `topicData.topics` stays leaf topics, unchanged, because documents,
    people, data and the methodology matrix key on leaf topic ids.
  - Only `byYear` (both the JS path and the SQL path) and the admin switch to
    persisted bands.
- **A band's paper count** is the number of non-outlier papers assigned to its
  child topics in `document_topics`. That matches the count `topics.doc_count`
  already uses for topics.
- **Regenerating labels in the admin also regenerates automatic band names**
  ("Regenerate labels" / labeler job). Manual band names are left untouched.
- **Fallback:** if the current generation has no bands, the chart keeps
  today's behaviour.

## Left to the builder

- Table and column names, API routes and their shape. Follow the existing
  admin topic-label routes and the CSRF pattern.
- Admin UI layout for the band list. Follow the existing topic-label review
  UI in `public/app/admin.js`.
- The exact labeller prompt for bands, and how many child topics and titles
  to include.
- How `buildParentClusters` / `buildTopicsByYearFromCounts` and the SQL
  by-year path (`src/db.js` `computeTopicDataByYearSql`) switch to persisted
  bands. Both paths must still agree.
- The colour palette for up to 15 bands.

## Success looks like

- After the bands-only job runs on the current generation:
  - the chart shows the bands the cut picks (9 on today's topics);
  - each automatic name plausibly covers the band's child topics;
  - the bands match the meaning-based grouping from the offline test;
  - the 104 manual topic labels are unchanged.
- After a later full rebuild, bands are produced automatically as well.
- An admin can rename a band. The chart shows the new name, and resetting
  restores the automatic name.
- Tests cover:
  - centroid hierarchy construction;
  - the dynamic cut on a known linkage;
  - generation scoping of band overrides;
  - chart data using band names.
