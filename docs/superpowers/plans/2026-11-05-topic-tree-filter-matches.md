# Topic Hierarchy Under Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Degree, Program or Affiliation filter is active, the Topic Hierarchy tree keeps its full shape but shows how many manuscripts in each topic match the filter. Topics with no matching manuscripts are muted and can't be clicked.

**Architecture:** `/api/workbench/visualizations` gains `topicData.matchCounts`: a count per topic for the active filters, from one grouped SQL query. It is present only when a filter is active. `renderTopicDendrogram` sizes leaves by that count, mutes topics with no matches and branches whose topics all have none, and shows a "Topics with matching manuscripts" caption. Unfiltered rendering is unchanged.

**Tech Stack:** Node ≥22.5 ESM/Express, `@libsql/client`, vanilla JS + d3 frontend, `node:test` + supertest, Playwright.

**Spec:** None. The design was agreed with the owner in conversation on 2026-11-05 and is recorded in the Design section below, which is the binding authority for this plan.

## Design (agreed 2026-11-05)

- The tree's shape never changes with filters: all topics, same order, same branch heights.
- With a filter active:
  - Each topic with at least one matching manuscript is sized by its matching count.
  - Each topic with no matches is drawn as a hollow grey circle with a dimmed label.
  - A branch is dimmed when every topic under it has no matches.
  - A caption reads `Topics with matching manuscripts: X of N`.
- Tooltips:
  - Topic with matches: `42 of 807 manuscripts match the current filters`.
  - Topic with no matches: `No manuscripts match the current filters`.
  - Unfiltered: as today, `807 manuscript(s)`.
- Clicking a topic with matches opens its filtered manuscripts, as today. Clicking a topic with no matches does nothing, and the cursor is the default arrow.
- Counts come from the server, from SQL over the whole filtered set. They are never computed from the documents the page holds (issue #57's rule).
- Out of scope: a "Hide topics with no matches" toggle. That comes later, if wanted.

## Global Constraints

- User-visible text says "manuscripts", never "dissertations". The tool name stays "Dissertation Workbench".
- The unfiltered landing payload must stay byte-identical in shape. `topicData.matchCounts` is absent when no filter is active, so the unfiltered snapshot (`VISUALIZATIONS_SNAPSHOT_KEY`) is unaffected.
- A topic's count uses the same rule the clicked list uses: each manuscript counts only toward its best topic (highest `probability`, ties broken by lower `topic_id`), as in `queryVisualizationDocuments` (`src/db.js:1847`).
- No new npm dependencies.
- Status is never shown by colour alone: a topic with no matches is hollow, its label is dimmed, and its tooltip says so.
- The repo is public. Never put prod data or IPs in fixtures or docs.

## Review Focus

1. **A filter whose manuscripts have no topics:** every leaf is empty. The caption reads `Topics with matching manuscripts: 0 of N`, and nothing throws (`d3.max` over an empty array). Test is in Task 2.
2. **Exactly one topic matches:** the radius scale's domain min equals its max. Radii must be finite numbers, not `NaN`. Test is in Task 2.
3. **Clearing the filter restores the unfiltered tree:** no muted classes, no caption, and tooltips back to `N manuscript(s)`. Test is in Task 3.
4. **Two different filters give different counts, not one cached result.** Test is in Task 1.
5. **A cached or snapshot payload with no `matchCounts`** renders as unfiltered and doesn't treat every topic as empty. Test is in Task 2.

---

### Task 1: Server per-topic match counts

**Files:**
- Modify: `src/db.js`: add `getTopicMatchCounts` next to `getTopicByYearCounts` (`src/db.js:2320`).
- Modify: `src/routes/metricsRoutes.js`: `buildWorkbenchVisualizationsPayload` (`:615`).
- Test: `test/topicMatchCounts.test.js`. Create it on the pattern of `test/publicTopicCounts.test.js`: a temp SQLite DB, `saveDocumentMetadata`, and rows in `document_topics`.

**Interfaces:**
- Produces:
  - `getTopicMatchCounts({ syncKey = null, filters = {} } = {}) → Promise<Record<string, number> | null>`. Keys are topic ids as strings, and only topics with a count > 0 appear. It returns `null` when `!await hasTopics()`.
  - The payload field `topicData.matchCounts`, of the same shape, present only when `!isUnfiltered(filters)`.

- [ ] **Step 1: Write failing tests** in `test/topicMatchCounts.test.js`. Seed 6 documents:
  - docs 1–3: degree `Doctor of Education - EdD`;
  - docs 4–6: degree `Doctor of Philosophy - PhD`;
  - topics 0, 1 and 2;
  - doc 1 has two `document_topics` rows: topic 0 at 0.9 and topic 1 at 0.4.

  The tests:
  - `counts each manuscript once, toward its best topic`: with `filters: { degree: 'Doctor of Education - EdD' }`, it returns only topics that have matches, with topic 0's count including doc 1 and topic 1's count not including it.
  - `different filters give different counts`: PhD and EdD return different objects.
  - `visualizations payload carries matchCounts only when filtered`: through `buildWorkbenchVisualizationsPayload` (as `publicTopicCounts.test.js` does), `topicData.matchCounts` is `undefined` with no filters and deep-equals the `getTopicMatchCounts` result with the degree filter.
- [ ] **Step 2: Run them** with `node --test test/topicMatchCounts.test.js`. Expected: FAIL (`getTopicMatchCounts` is not exported).
- [ ] **Step 3: Implement.**
  - Use `analyticalDocumentFilters({ syncKey, ...filters })` and the same best-topic `ROW_NUMBER()` subquery as `queryVisualizationDocuments`, with `GROUP BY bt.topic_id`.
  - In `buildWorkbenchVisualizationsPayload`, add the call to the existing `Promise.all` only when `!isUnfiltered(filters)`, then set `aggregates.topicData.matchCounts`.
  - `isUnfiltered` is already defined at `metricsRoutes.js:467`.
- [ ] **Step 4: Run** `node --test test/topicMatchCounts.test.js test/publicTopicCounts.test.js`. Expected: PASS. Then run `npm test` and `npx eslint .`. Expected: all green.
- [ ] **Step 5: Commit** with the message `feat(topics): per-topic match counts for filtered visualizations`.

### Task 2: Tree rendering for filtered counts

**Files:**
- Modify: `public/app/topic-visuals.js`: `renderTopicDendrogram` (`:367`).
- Modify: `public/index.html`: the `#topicDendrogramPanel` block (`:244`). Add the caption element and fix the stale description.
- Modify: the stylesheet that holds the other chart classes. Find it with `grep -rn "scatter-tooltip" public/*.css`.
- Test: `e2e/tree-filter.spec.js`. It is created in Task 3, but this task's Review Focus tests live there too. Write them in Task 3, and check items 1, 2 and 5 here by hand in the browser.

**Interfaces:**
- Consumes: `topicData.matchCounts` from Task 1. Absent or `undefined` means unfiltered.
- Produces, for Task 3:
  - The leaf `<g>` gets class `tree-leaf`, and also `tree-leaf--empty` when the topic has no matches.
  - The branch `<path>` gets class `tree-link`, and also `tree-link--empty` when every topic under it has no matches.
  - The caption is `<p id="topicDendrogramMatchSummary" class="meta" hidden>`.
  - Each leaf has `data-topic-id="<id>"`.

- [ ] **Step 1: Replace the panel description** in `public/index.html` with this exact copy. The old text describes the pre-PR-#66 keyword-based tree.
  `Topics grouped by what their manuscripts are about. Closer branches indicate more similar topics. Node size reflects manuscript count.`
  Add `<p id="topicDendrogramMatchSummary" class="meta" hidden></p>` directly after it.
- [ ] **Step 2: Implement filtered rendering** in `renderTopicDendrogram`:
  - Set `const filtered = td.matchCounts != null` and `const matchOf = (topicId) => td.matchCounts?.[String(topicId)] ?? 0`.
  - When `filtered`:
    - Base the radius scale on the matching counts of topics with matches only.
    - When there are none, or min equals max, use a constant radius of `(rMin + rMax) / 2`.
    - Topics with no matches get radius `rMin`, `fill: none`, a stroke of `#7c8a97`, a label at opacity 0.45, and class `tree-leaf--empty`.
  - Compute each node's subtree total with `root.sum`, or a post-order `root.eachAfter` over `matchOf`. A link whose child subtree total is 0 gets class `tree-link--empty` with stroke opacity 0.25.
  - Tooltip copy, exact:
    - topic with matches: `${matchOf(id)} of ${t.docCount} manuscripts match the current filters`;
    - topic with no matches: `No manuscripts match the current filters`;
    - unfiltered: unchanged.
  - Click and cursor: for empty leaves, return early in the click handler and set `cursor: default`.
  - Caption: when `filtered`, set the text to `Topics with matching manuscripts: ${matched} of ${N}` and unhide it. Otherwise hide it and clear its text.
  - Keep the hue-per-leaf fill for topics with matches, and for all topics when unfiltered.
- [ ] **Step 3: Manual check.** Run `npm start` against the dev DB. Choose a degree filter and confirm:
  - topics with no matches are hollow;
  - the caption counts are right;
  - clicking a topic with no matches does nothing;
  - clearing the filter restores the original tree.
- [ ] **Step 4: Run** `npx eslint .` and `npm test`. Expected: green.
- [ ] **Step 5: Commit** with the message `feat(topics): show filter matches on the topic hierarchy tree`.

### Task 3: Browser tests

**Files:**
- Modify: `e2e/bands-prepare.mjs`. Add an `--edd-topics <id,id>` option. With it, the fixture docs whose topic is in that list are saved with degree `Doctor of Education - EdD`; everything else stays PhD. The default output is unchanged.
- Create: `e2e/tree-filter.spec.js`. Model it on `e2e/bands-ui.spec.js`: its own data dir and server on an unused port, `bands-prepare.mjs` run with `--edd-topics 0,1`, and then a `topic_hierarchy_meta` row inserted through its `sql()` helper.
  - For `N` leaves, the hierarchy is a chain linkage: row 0 is `[0, 1, 1.0]` and row i is `[N + i - 1, i + 1, 1.0 + i]`.
  - Facets are driven the way `e2e/regression.spec.js:34` does.

**Interfaces:**
- Consumes: Task 2's classes, `data-topic-id` and `#topicDendrogramMatchSummary`.

- [ ] **Step 1: Write the tests.**
  - `unfiltered tree has no muted topics and no caption`: zero `.tree-leaf--empty` and `.tree-link--empty`, and `#topicDendrogramMatchSummary` is hidden. This covers Review Focus item 5 for a payload without `matchCounts`.
  - `EdD filter mutes topics with no matches`:
    - `.tree-leaf--empty` count is `N - 2`;
    - topics 0 and 1 don't have the class;
    - the caption is `Topics with matching manuscripts: 2 of N`;
    - some `.tree-link--empty` exist;
    - every `circle` `r` attribute is a finite number.
  - `tooltip text for topics with and without matches`: hovering topic 0 shows `of … manuscripts match the current filters`, and hovering topic 5 shows `No manuscripts match the current filters`.
  - `clicking a topic with no matches opens nothing`: click topic 5, and the matches modal stays closed. Clicking topic 0 opens it, listing only EdD manuscripts.
  - `one matching topic renders finite radii`: re-seed with `--edd-topics 0` in a `test.describe` with its own server, or update degrees through `sql()` and reload. The caption reads `1 of N`, and all radii are finite (Review Focus item 2).
  - `filter with no topic matches`: a filter value whose manuscripts have no `document_topics` rows. Seed one extra document with degree `Master of Arts - MA` and no topic. The caption reads `0 of N`, every leaf is empty, and there are no page errors (Review Focus item 1).
  - `clearing the filter restores the tree`: after EdD, click Clear. There are no muted classes, the caption is hidden, and the topic 0 tooltip reads `manuscript(s)` (Review Focus item 3).
- [ ] **Step 2: Run** `npx playwright test e2e/tree-filter.spec.js`. Expected: PASS. Then run the full `npx playwright test`. Expected: green, with #67's `test.fail()` unchanged.
- [ ] **Step 3: Commit** with the message `test(e2e): topic hierarchy under filters`.

## Rollout

Web-only change: no worker image, and no rebuild job. After owner review and approval: `fly deploy`. Then, on the live site, choose a degree filter and confirm the tree mutes topics with no matches and the caption appears. The unfiltered landing chart should be unchanged.
