# Manuscripts UI Cleanup, Network-Gated Admin, and Research-Area Bands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the owner's UI/copy changes (Manuscripts wording, heatmap removal, "unspecified" word-cloud fix, Person Explorer notice, new hero text, Admin restricted to allowed networks) and the meaning-based research-area bands for Topic Evolution.

**Architecture:** Part A (Tasks 1–4) is independent web-side work: copy changes in `public/`, a theme-extraction fix in `src/nlp.js`, removal of the Supervisor–Concept heatmap end to end, and an IP allow-list middleware in front of `/api/auth` and `/api/admin`. Part B (Tasks 5–11) implements the bands spec: Python computes a centroid-based Ward hierarchy, cuts it at the largest natural gap, names bands with the existing labeller, and persists `topic_bands` through the existing `*_next` swap (full rebuild) or a new bands-only job (current generation). Node reads persisted bands for `topicData.byYear` on both the JS and SQL paths, and the admin can rename or reset bands.

**Tech Stack:** Node ≥22.5 ESM, Express, `node:test`, `node:net` `BlockList`; Python (`scripts/build-topics.py`, numpy/scipy from `.venv`), libsql_client / `SqliteClientWrapper`; vanilla JS + d3 frontend.

**Spec:** `docs/superpowers/specs/2026-10-26-research-area-bands-design.md` (Part B). Part A requirements were given by the owner in-session on 2026-11-02 and are copied verbatim into Global Constraints.

## Global Constraints

- Tool name stays **"Dissertation Workbench"** (`<title>`, `<h1>`, TOTP issuer, server log line).
- Rename: user-visible "dissertation(s)" in charts, menus, tooltips, counts, placeholders and admin job text becomes "manuscript(s)", keeping case and number ("Dissertations by Year" → "Manuscripts by Year", "12 dissertation(s)" → "12 manuscript(s)"). Code identifiers, element ids, CSS classes, export filenames (`dissertations.bib`, `dissertations.ris`), BibTeX `@phdthesis`, and PDF-parsing regexes are NOT renamed. Prose that says "theses and dissertations" (owner's copy) is kept as written.
- Hero subtitle, exact: `View research, explore related themes, and discover patterns across UBC's theses and dissertations from 1919 onward. Note that theses and dissertations continue to be indexed, and the catalogue here is not a complete representation of those held by cIRcle, made available through Open Collections.`
- Person Explorer notice, exact: `Connections between people and theses and dissertations have been reconstructed from statements in the documents themselves. Where authoritative metadata exists indicating the dissertation or thesis supervisor, that metadata takes precedence here. However, supervisor metadata is only available from 2018 onward in UBCV manuscripts, based on sampling.`
- Admin network gate: env var `ADMIN_ALLOWED_NETWORKS`, comma-separated IPv4/IPv6 addresses or CIDR ranges. **Unset or empty = allow from anywhere** (today's behaviour). Outside the list, `/api/auth/*` and `/api/admin/*` return `404 {"error":"Not found"}` and the Admin tab is not shown. `/api/internal/*` (worker callbacks) is never gated. The prod value is set as a Fly **secret**, never committed.
- Bands: range env vars `TOPIC_BANDS_MIN` (default 6) and `TOPIC_BANDS_MAX` (default 15). Gap formula, 0-based ascending merge heights `h` for `n` leaves: `gap(k) = (h[n−k] − h[n−k−1]) / h[n−k−1]`; pick the k in range with the largest gap, ties → smaller k.
- Centroids: per topic, the mean of its assigned papers' cached embeddings after subtracting the mean over all assigned papers, then L2-normalised; `scipy.cluster.hierarchy.linkage(centroids, method="ward", metric="euclidean", optimal_ordering=True)`. Never feed cosine distances to Ward.
- Band ids are 0..k−1 ordered by paper count descending (ties → smallest child topic id). Paper count = non-outlier `document_topics` rows of the child topics.
- Never use titles in place of missing abstracts (standing rule). Titles may appear as *additional* evidence in band-label prompts, as the spec allows.
- Zero new npm dependencies; no new Python dependencies. Python tests follow `test/buildTopicsParams.test.js`: `const PYTHON = existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'`, module loaded with `importlib.util.spec_from_file_location`, temp-dir SQLite only, never `data/metrics.sqlite`, no bertopic/umap/hdbscan/torch.
- Schema changes are additive and idempotent on both Node (`src/db.js` migrations) and Python (`ensure_*` helpers).
- No prod deploy, Fly secret change, worker image push, or prod job run without the owner's explicit approval (`.agents/rules/deployment.md`). Task 12 is the only task that touches prod.
- Commit per task, conventional-commit subject, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Client IP forms:** behind Fly, `req.ip` may arrive as `::ffff:203.0.113.5` (IPv4-mapped IPv6) when the allow-list holds `203.0.113.5`. Expected: allowed. Pinned in Task 4.
- **A worker callback from outside the allow-list:** `/api/internal/*` must keep working, or every Fly job hangs. Pinned in Task 4.
- **Bands-only job re-cuts within one generation:** a manual band name saved for band 2 must not attach to a different set of topics after the job re-cuts. Expected: an override applies only when its generation AND its `child_topic_ids` match the band. Pinned in Task 9.
- **Degenerate trees:** fewer leaf topics than `TOPIC_BANDS_MIN`, or a zero merge height. Expected: no crash, no division by zero. Each topic is its own band when n ≤ min; a zero denominator scores `inf` when the numerator is > 0, and is skipped when both are 0. Pinned in Task 5.
- **Stale caches after a bands-only job or band rename:** `topics_generation` does not change, so slices and the persisted snapshot would keep the old bands. Expected: a `topic_bands_version` setting is folded into the cache version, and the next request after the memo window shows the new bands. Pinned in Task 9.

---

## Part A — UI, copy and access

### Task 1: Stop "unspecified" from becoming a theme

**Files:**
- Modify: `src/nlp.js` (`THEME_LOW_SIGNAL_TOKENS` ~L324, `documentThemeTerms` ~L331)
- Modify: `src/metrics.js` (L171, L873: use the exported constant)
- Test: `test/themeTerms.test.js` (create)

**Interfaces:**
- Produces: `export const UNSPECIFIED_SUBJECT = '(Unspecified)'` in `src/nlp.js`. `documentThemeTerms(doc, limit)` ignores subject entries equal to `UNSPECIFIED_SUBJECT` (for both the text and the subject bonus), and `THEME_LOW_SIGNAL_TOKENS` gains `'unspecified'` as a backstop.

- [ ] **Step 1: Write the failing tests.**
  - `documentThemeTerms never returns "unspecified" for a placeholder subject`: `documentThemeTerms({ title: 'Salmon migration', abstract: 'Salmon migration in coastal rivers', subjects: ['(Unspecified)'] })` does not include `'unspecified'` and does include `'salmon'`.
  - `documentThemeTerms keeps real subject words`: `subjects: ['Forestry']` → includes `'forestry'`.
- [ ] **Step 2: Run** `node --test test/themeTerms.test.js`. Expected: the first test FAILS.
- [ ] **Step 3: Implement** the constant, the placeholder filter and the stop-list entry, and replace both `'(Unspecified)'` literals in `src/metrics.js` with the import.
- [ ] **Step 4: Run** `node --test test/themeTerms.test.js test/documentTermsProjection.test.js test/fullCorpusAnalytics.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(themes): stop the (Unspecified) subject placeholder becoming a theme term`

Note for Task 12: stored themes are only refreshed by Admin → Operations → **Recompute Stored Themes** (`theme_recompute` job, which also rewrites `document_terms`).

### Task 2: Remove the Supervisor–Concept heatmap end to end

**Files:**
- Modify: `public/index.html` (L200–203 panel), `public/app/core.js` (L23, L780), `public/app/analytics-dashboard.js` (L38, L121, `renderSupervisorHeatmap` L593–~650 and its export), `public/app/data.js` (client `supervisorNgramMatrix` builder and its key in the L404 return)
- Modify: `src/db.js` (`computeSupervisorNgramMatrixSql` and its `Promise.all` slot ~L2555), `src/metrics.js` (`supervisorNgramMatrix` builder and payload key), `src/routes/metricsRoutes.js` (payload key)
- Modify tests that assert on it: `test/metadataScaleServing.test.js`, `test/analyticsSqlPortScale.test.js`, `test/analyticsSqlPortEquivalence.test.js`

**Interfaces:**
- Produces: analytics payloads no longer carry `supervisorNgramMatrix`. The Supervisor–Topic and Methodology–Concept heatmaps and the shared `.heatmap-*` CSS are unchanged.

- [ ] **Step 1: Write the failing test.** In `test/analyticsSqlPortEquivalence.test.js`, add `analytics payload has no supervisorNgramMatrix`: `assert.equal('supervisorNgramMatrix' in payload, false)` on the SQL-path payload already built there. Delete the existing equivalence and scale assertions on that key.
- [ ] **Step 2: Run** `node --test test/analyticsSqlPortEquivalence.test.js`. Expected: FAIL.
- [ ] **Step 3: Remove** the panel, element refs, renderer, client builder, server builders and payload keys. `grep -rn "supervisorNgramMatrix\|supervisorHeatmap\b" src public` must return nothing.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(analytics): remove the Supervisor–Concept heatmap`

### Task 3: Manuscripts wording, hero text, Person Explorer notice, stale About copy

**Files:**
- Modify: `public/index.html`, `public/app/documents.js`, `public/app/citations.js`, `public/app/data.js`, `public/app/core.js`, `public/app/analytics-dashboard.js`, `public/app/topic-visuals.js`, `public/app/people.js`, `public/app/admin.js` (only if it shows "dissertation"), `src/services/themeJobRunner.js` (L46 job text), `public/styles.css` (notice style)
- Test: `test/uiCopy.test.js` (create)

**Interfaces:**
- Produces: a `<p id="peopleProvenanceNotice" class="meta people-provenance-notice">` directly after `.people-filter-row` inside the People panel, with the exact notice text from Global Constraints.

Copy changes beyond the mechanical rename (exact text):
- Hero subtitle `p.subtitle`: the exact Global Constraints text.
- Hero context, 2nd paragraph: "topics are generated from dissertation abstracts" → "topics are generated from manuscript abstracts".
- About › Discovery & Connections: "Dissertation Intelligence Workbench" → "Dissertation Workbench"; "enriches and links dissertation metadata" → "enriches and links thesis and dissertation metadata".
- About › Current Scope, replace the whole paragraph with: `The workbench covers UBC theses and dissertations from 1919 onward, drawn from cIRcle through Open Collections. Indexing is ongoing, so the catalogue here is not yet a complete representation of the collection.`
- `topicModelMeta` (index.html and analytics-dashboard.js L753): "BERTopic clustering of manuscript abstracts".

- [ ] **Step 1: Write the failing tests** in `test/uiCopy.test.js`, reading the files as text:
  - `hero subtitle is the owner's text` — `index.html` contains the exact subtitle string.
  - `people notice sits under the filter row` — `index.html` matches `/people-filter-row[\s\S]*?<\/div>\s*<p id="peopleProvenanceNotice"[^>]*>EXACT_NOTICE<\/p>/`.
  - `no user-visible "dissertation" outside the allow-list` — for `public/index.html`, every `public/app/*.js` and `src/services/themeJobRunner.js`, every `/\bdissertations?\b/i` match fails the test unless its line also matches `/Dissertation Workbench|theses and dissertations|thesis and dissertation|dissertation or thesis|\.dissertations\b|\bdissertations:|dissertations\.(bib|ris)|^\s*(\/\/|\*)/`.
  - `tool name is kept` — `index.html` still has `<title>Dissertation Workbench</title>` and `<h1>Dissertation Workbench</h1>`.
- [ ] **Step 2: Run** `node --test test/uiCopy.test.js`. Expected: FAIL.
- [ ] **Step 3: Apply** the rename and the copy changes, and add the notice with a small style (top margin, `--ink-soft` colour, the same font size as `.meta`).
- [ ] **Step 4: Run** `node --test test/uiCopy.test.js && npm test`. Also run `npx playwright test e2e/smoke.spec.js` (it keys on element ids, which don't change). Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): call documents manuscripts, add provenance notice and new hero text`

### Task 4: Restrict Admin to allowed networks

**Files:**
- Modify: `src/config.js` (add `ADMIN_ALLOWED_NETWORKS`)
- Create: `src/middleware/adminNetwork.js`
- Modify: `src/server.js` (mount before `app.use('/api/auth', …)` ~L146, and on `/api/admin` before `requireAdmin`)
- Modify: `public/app/main.js` (boot probe, hide tab, redirect `#/admin`), `public/app/core.js` if tab routing needs a guard
- Modify: `fly.toml.example` (commented example, no real IP), `README.md` env table
- Test: `test/adminNetwork.test.js` (create)

**Interfaces:**
- Produces: `parseAllowedNetworks(value: string | undefined) -> net.BlockList | null` (null when empty; throws `Error('Invalid ADMIN_ALLOWED_NETWORKS entry: <entry>')` on a bad entry, so a typo fails at startup rather than silently allowing everyone); `isAllowedAdminIp(blockList, ip: string) -> boolean` (true when `blockList` is null; unwraps `::ffff:a.b.c.d` to IPv4); `createAdminNetworkGate({ blockList, getClientIp }) -> express middleware` that responds `404 {"error":"Not found"}` when not allowed.
- Frontend contract: on boot `main.js` calls `GET /api/auth/session`. A **404** means unavailable: remove the Admin tab button and, if the hash is `#/admin…`, navigate to the default tab. 401 and 200 leave the tab as it is today.

- [ ] **Step 1: Write the failing tests:**
  - `unset or blank allows everyone` — `parseAllowedNetworks(undefined)` and `('  ')` → `null`; `isAllowedAdminIp(null, '8.8.8.8') === true`.
  - `single IP and CIDR` — list `'203.0.113.5, 10.0.0.0/8'`: allows `203.0.113.5`, `10.2.3.4`; rejects `203.0.113.6`.
  - `IPv4-mapped IPv6 client` — the same list allows `'::ffff:203.0.113.5'`.
  - `IPv6 entry` — `'2001:db8::/32'` allows `2001:db8::1`.
  - `bad entry throws` — `'not-an-ip'` throws with the entry in the message.
  - Server integration, following the existing server test helpers in `test/server.test.js` with `ADMIN_ALLOWED_NETWORKS='203.0.113.9'` and the test client on loopback: `GET /api/auth/session` → 404; `GET /api/admin/topics/labels` → 404; `POST /api/internal/...` (an existing internal route used in `test/adminWorker.test.js`) is not 404 from the gate; `GET /api/health` → 200. With the variable unset, `GET /api/auth/session` → 401.
- [ ] **Step 2: Run** `node --test test/adminNetwork.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** with `node:net` `BlockList` (`addAddress` for bare IPs, `addSubnet` for CIDR, family from `net.isIP`). Mount the gate on `/api/auth` and `/api/admin` only, using the existing `getClientIp`.
- [ ] **Step 4: Implement** the frontend probe and tab removal.
- [ ] **Step 5: Run** `node --test test/adminNetwork.test.js && npm test`. Expected: PASS. Manual check: start locally with `ADMIN_ALLOWED_NETWORKS=203.0.113.9 npm start`. The Admin tab is absent and `#/admin` falls back to the default tab. Unset, the tab is present.
- [ ] **Step 6: Commit** `feat(admin): only serve admin and login from ADMIN_ALLOWED_NETWORKS`

---

## Part B — Research-area bands

### Task 5: Centroid hierarchy and dynamic cut (pure Python)

**Files:**
- Modify: `scripts/build-topics.py` (new helpers near `cluster_model_params`)
- Test: `test/buildTopicsBands.test.js` (create)

**Interfaces:**
- Produces:
  - `resolve_band_range() -> tuple[int, int]` from `TOPIC_BANDS_MIN`/`TOPIC_BANDS_MAX` via `_positive_int_env`; defaults `(6, 15)`; if min > max, use the defaults.
  - `topic_centroids(embeddings: np.ndarray, assignments: list[int], topic_ids: list[int]) -> np.ndarray` — rows aligned to `topic_ids`. Mean-centres over all rows whose assignment ≠ −1, takes per-topic means, L2-normalises. Raises `ValueError` naming the topic when a topic has no rows.
  - `centroid_linkage(centroids) -> np.ndarray` — Ward, Euclidean, `optimal_ordering=True`.
  - `choose_band_count(heights: list[float], n: int, k_min: int, k_max: int) -> int` — the spec's gap rule. Returns `n` when `n <= k_min`. Searches `k in [k_min, min(k_max, n-1)]`. A zero denominator scores `inf` if the numerator is > 0 and is skipped if both are 0. If every candidate is skipped, returns `k_min`.
  - `cut_bands(linkage_matrix, topic_ids: list[int], doc_counts: dict[int, int], k: int) -> list[dict]` — via `fcluster(Z, k, "maxclust")`. Returns `[{"band_id", "child_topic_ids" (sorted asc), "doc_count"}]` with ids 0..k−1 by `doc_count` desc, ties → smallest child id.

- [ ] **Step 1: Write the failing tests** (Python via `PYTHON`):
  - `choose_band_count picks the largest relative gap in range` — `n=12`, heights `[1,1.1,1.2,1.3,1.4,1.5,2.5,2.6,2.7,2.8,4.0]`, range 3..8. gap(6) = (h[6]−h[5])/h[5] = (2.5−1.5)/1.5 ≈ 0.67 is the largest in range (gap(2) ≈ 0.43 is out of range), so the expected value is `6`.
  - `ties go to the smaller k`: construct equal gaps at k=6 and k=8 and expect 6.
  - `n at or below min returns n`: `choose_band_count([1,2,3], 4, 6, 15) == 4`.
  - `zero heights do not divide by zero`: heights `[0,0,0,1,2,3,4,5,6]`, `n=10`, range 6..9 → returns an int without raising.
  - `topic_centroids are unit length and mean-centred` — 3 topics × 4 docs of 5-d vectors: each row's norm ≈ 1; a topic with no docs raises `ValueError`.
  - `cut_bands on two obvious blobs` — 6 topics whose centroids form two tight blobs, `k=2`. Expect two bands with the blob memberships, the bigger `doc_count` first, ids 0 and 1.
  - `resolve_band_range` defaults `(6, 15)`, env `TOPIC_BANDS_MIN=4 TOPIC_BANDS_MAX=9` → `(4, 9)`, min>max → defaults.
- [ ] **Step 2: Run** `node --test test/buildTopicsBands.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(topics): centroid Ward hierarchy and gap-based band cut`

### Task 6: Band labels and atomic publish in the full rebuild

**Files:**
- Modify: `scripts/build-topics.py` (`TOPIC_TABLE_SCHEMAS`/`TOPIC_TABLE_COLUMNS` ~L254; hierarchy block ~L1793–1825 → use Task 5; staging inserts ~L1908; new band-label helpers near `generate_labels`)
- Test: extend `test/buildTopicsBands.test.js` and `test/buildTopicsAtomicPublish.test.js`

**Interfaces:**
- Consumes: Task 5 helpers.
- Produces:
  - Table `topic_bands (band_id INTEGER PRIMARY KEY, label TEXT NOT NULL, child_topic_ids TEXT NOT NULL, doc_count INTEGER NOT NULL, created_at TEXT NOT NULL)`, added to both dicts so `prepare_staging_topic_tables`/`publish_staged_topics` stage and swap it with the topics. `child_topic_ids` is a JSON array.
  - `generate_band_labels(bands, topic_labels: dict[int,str], topic_terms: dict[int,list[str]], titles_by_topic: dict[int,list[str]], reporter=None) -> dict[int, str]`. It builds an `ExistingTopicModel`/`ExistingTopicInfo` whose "topics" are bands:
    - terms: the child topics' top terms, merged and weighted by child `doc_count`;
    - one evidence sample per band: `"Subtopics: <child labels joined '; '>\nExample titles: <up to 2 titles from each of up to 5 largest children>"`.

    It then calls `generate_labels`, so Claude, transformers and llama.cpp all apply unchanged. Missing or unusable labels (`label_is_usable`) fall back to `"<largest child label> and related topics"`, and that string must not equal any single child's label.
  - Full rebuild: the hierarchy comes from `topic_centroids(embeddings_matrix-rows of the fitted docs, topics, all_topic_ids)` → `centroid_linkage`. `topic_hierarchy_meta_next` gets that linkage. `topic_bands_next` gets the cut with labels. With < 2 topics, both are left empty, which is the existing behaviour for the hierarchy.

- [ ] **Step 1: Write the failing tests:**
  - `topic_bands is staged and swapped with topics`, in `buildTopicsAtomicPublish.test.js`: stage one `topic_bands_next` row, publish, and expect `topic_bands` to hold it and `topic_bands_next` to be gone. Then a failed swap leaves the old `topic_bands` rows (mirror the existing failure test there).
  - `generate_band_labels falls back to a whole-band name`: monkeypatch `bt.generate_labels` to return `{}` and expect `"Fish Physiology and related topics"` for a band whose largest child is "Fish Physiology".
  - `generate_band_labels passes band evidence to the labeller`: monkeypatch `bt.generate_labels` to capture its args. The sample for band 0 contains every child label. It contains no abstract text in place of a missing abstract (the sample comes only from labels and titles).
  - `the full-rebuild hierarchy no longer uses topic_embeddings_`: the source text of `main` contains no `topic_embeddings_` and no `cosine_similarity(` inside the hierarchy block (text grep, as in `buildTopicsVectorizer.test.js`).
- [ ] **Step 2: Run** `node --test test/buildTopicsBands.test.js test/buildTopicsAtomicPublish.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the table, the label helper and the rebuild wiring. Print the chosen k and the gap.
- [ ] **Step 4: Run** the same files plus `test/topicsGeneration.test.js test/topicLabelGenerations.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(topics): build, name and atomically publish research-area bands`

### Task 7: Bands-only job and band names on label regeneration (Python)

**Files:**
- Modify: `scripts/build-topics.py` (`main` argparse ~L1520; new `run_bands_only`; `run_label_only` ~L1399)
- Test: extend `test/buildTopicsBands.test.js`

**Interfaces:**
- Consumes: Tasks 5–6.
- Produces:
  - `--bands-only` flag → `run_bands_only(client, reporter=None) -> dict` (`{"bands": k, "leaves": n}`). It loads `document_topics` (topic_id ≠ −1) and `load_cached_embeddings` for those doc ids, and drops docs with no cached vector. It then computes centroids, linkage, k and bands, and names the bands. One `client.batch` replaces the live `topic_hierarchy_meta` (id 1) and `topic_bands` rows and upserts setting `topic_bands_version = <now ISO>`. It **never** touches `topics`, `document_topics`, `topic_label_overrides` or `topics_generation`. Reporter task key `"build_bands"`.
  - `full rebuild`: `publish_staged_topics` also upserts `topic_bands_version = now` in its batch.
  - `run_label_only` (no `--topic-id`): after topic labels, if `topic_bands` has rows, regenerate band labels with `generate_band_labels` using the refreshed topic labels, `UPDATE topic_bands SET label = ?`, and bump `topic_bands_version`. With `--topic-id`, bands are left alone.

- [ ] **Step 1: Write the failing tests** (temp SQLite, embeddings inserted into `document_embeddings` in the format `load_cached_embeddings` reads, `generate_labels` monkeypatched):
  - `bands-only writes bands and hierarchy for the current generation` — seed 8 topics in two blobs, `topics_generation='g1'`, an override row in `topic_label_overrides`. After `run_bands_only`: `topic_bands` has k rows whose children partition the 8 topics; `topic_hierarchy_meta.leaf_topic_ids` equals the sorted topic ids; `topics_generation` is still `'g1'`; `topics`, `document_topics` and the override are byte-identical; `topic_bands_version` is set.
  - `bands-only leaves live tables intact on failure` — make one topic have zero cached embeddings. `run_bands_only` raises, and the old `topic_bands` and `topic_hierarchy_meta` rows are unchanged.
  - `labels-only refreshes band names but not membership` — after the run, `topic_bands.label` has changed and `child_topic_ids` is unchanged.
- [ ] **Step 2: Run** `node --test test/buildTopicsBands.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file plus `test/buildTopicsAtomicPublish.test.js test/topicLabelGenerations.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(topics): bands-only job for the current generation`

### Task 8: `topic_bands` admin job type (Node dispatch)

**Files:**
- Modify: `src/jobWorker.js` (~L81–95), `src/services/adminWorker.js` (`buildFlyWorkerMachinePayload` ~L98–130), `src/routes/adminTopicLabelsRoutes.js`
- Test: `test/adminWorker.test.js` (extend), `test/workbenchRoutes.test.js` or the existing route test that covers `/topics/labels/regenerate`

**Interfaces:**
- Produces: job type `'topic_bands'`. It runs `build-topics.py --bands-only` locally and on Fly, using the **labeler** image (`LABELER_WORKER_IMAGE || BERTOPIC_WORKER_IMAGE`) and the same memory as `topic_labels`. Route `POST /api/admin/topics/bands/rebuild` behaves like `/topics/labels/regenerate`: 202 `{alreadyRunning, jobId}` if a `topic_bands` job is running, 409 if `bertopic` or `topic_labels` is running, otherwise 202 `{started: true, ...}`. The job label is "Rebuild Research Areas".

- [ ] **Step 1: Write the failing tests:**
  - `buildFlyWorkerMachinePayload runs --bands-only on the labeler image for topic_bands`: assert `config.init.exec` (or the field the existing tests assert for `topic_labels`) equals `['python3','scripts/build-topics.py','--bands-only']` and the image is the labeler image.
  - Route: running bertopic → 409; idle → 202 with `started: true`.
- [ ] **Step 2: Run** the test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): add the topic_bands worker job`

### Task 9: Serve persisted bands in Topic Evolution (Node)

**Files:**
- Modify: `src/db.js` (schema near `topic_hierarchy_meta` ~L618; new loaders and override functions near `loadTopicHierarchy` ~L6511; `computeTopicDataByYearSql` ~L2268; `getTopicByYearCounts` ~L2290; the analytics call ~L2566)
- Modify: `src/topicHierarchy.js`, `src/metrics.js` (~L857, ~L1020), `src/routes/metricsRoutes.js` (`syncTopicsGeneration` default `read`, `seedSliceFromSnapshot`, `buildAndSaveSnapshot`)
- Test: `test/topicBands.test.js` (create); extend `test/visualizationSnapshot.test.js`

**Interfaces:**
- Consumes: the `topic_bands` table from Task 6. Node also creates it idempotently, plus `topic_band_label_overrides (band_id INTEGER PRIMARY KEY, label TEXT NOT NULL, child_topic_ids TEXT NOT NULL, generation TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`.
- Produces:
  - `loadTopicBands() -> Promise<Array<{bandId, label, autoLabel, docCount, children: number[], hasOverride: boolean}> | null>`. Null when the table is empty or missing. `label` is the override label when the override's `generation` equals the current `topics_generation` AND its `child_topic_ids` equals the band's; otherwise it is `autoLabel`.
  - `updateTopicBandManualLabel(bandId, label) -> Promise<{bandId, label} | null>`: null if there is no such band. It stores the current generation and the band's `child_topic_ids`, and bumps `topic_bands_version`.
  - `deleteTopicBandLabelOverride(bandId) -> Promise<boolean>`: bumps `topic_bands_version`.
  - `getTopicsCacheVersion() -> Promise<string | null>`: `null` when `topics_generation` is null, otherwise `` `${topics_generation}|${topic_bands_version ?? ''}` ``. It replaces `getSetting('topics_generation')` in `syncTopicsGeneration`'s default `read`, `seedSliceFromSnapshot` and `buildAndSaveSnapshot`.
  - `resolveTopicGrouping(hierarchy, topics, bands) -> { parentClusters, leafToParent } | null` in `src/topicHierarchy.js`. When `bands?.length`, it maps each band to `{ parentId: bandId, topicId: bandId, label, docCount, children }`. Otherwise it falls back to `buildParentClusters(hierarchy, topics)` when there is a hierarchy, and to `null` when there isn't. All three current `buildParentClusters` call sites (db.js ×1, metrics.js ×2) switch to it, with bands loaded next to the hierarchy.
  - `buildTopicsByYearFromCounts(topics, rows, leafToParent, limit = 10)`: the band path passes `bands.length`, and the other paths keep 10.

- [ ] **Step 1: Write the failing tests** in `test/topicBands.test.js` (temp DB, following `test/topicLabelGenerations.test.js` setup):
  - `byYear uses band names and every band`: seed 12 topics, 12 bands (all ≤15), and rows across years. `getTopicByYearCounts()` returns 12 series whose labels equal the band labels.
  - `JS and SQL by-year paths agree with bands`: `buildTopicVisualizations(docs, { topics, hierarchy, bands })` and `getTopicByYearCounts()` produce the same series for the same data.
  - `override applies only for the current generation and same children`: save an override for band 0 under `topics_generation='g1'`. `loadTopicBands()[0].label` is the override. With `topics_generation='g2'` it shows `autoLabel`. With `'g1'` but band 0's `child_topic_ids` rewritten, it shows `autoLabel`.
  - `no bands falls back to today's clusters`: an empty `topic_bands` gives the same output as `buildParentClusters` (10 series).
  - `cache version changes when bands change`: `getTopicsCacheVersion()` differs before and after `updateTopicBandManualLabel`.
  - In `visualizationSnapshot.test.js`: `a snapshot saved before a bands change is not seeded after it`.
- [ ] **Step 2: Run** `node --test test/topicBands.test.js test/visualizationSnapshot.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, the loaders, `resolveTopicGrouping`, the call-site switch, the `limit` parameter and the cache version.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(topics): serve persisted research-area bands in Topic Evolution`

### Task 10: Admin review of research areas

**Files:**
- Modify: `src/routes/adminTopicLabelsRoutes.js`, `public/index.html` (the `#admin-labels` section ~L807), `public/app/admin.js` (next to `loadTopicLabels`/`renderTopicLabels` ~L1409–1620), `public/styles.css`
- Test: the existing admin route test file used for topic-label routes (extend)

**Interfaces:**
- Consumes: Task 9 db functions, Task 8 rebuild route.
- Produces routes, all behind `requireAdmin` and CSRF like the topic-label routes, each calling `clearMetricsCache()` after a write:
  - `GET /api/admin/topics/bands` → `{ generation, bands: [{bandId, label, autoLabel, hasOverride, docCount, children: [{topicId, label, docCount}]}] }`;
  - `PATCH /api/admin/topics/bands/:bandId/label` (`{label}`, non-empty, ≤120 chars, else 400; unknown band 404);
  - `DELETE /api/admin/topics/bands/:bandId/label/override`.
- UI: a "Research Areas" panel above the topic-label review in the Topic Labels admin sub-tab. It has one row per band (name, paper count, child topic labels), an inline edit and a "Reset to automatic" button (shown when `hasOverride`), and a "Rebuild Research Areas" button that posts to `/topics/bands/rebuild` and points to Admin › Jobs. Follow the existing label UI's markup and its escaping (`escapeHtml`).

- [ ] **Step 1: Write the failing route tests:** GET lists the bands with their children; PATCH with `''` → 400 and with 121 chars → 400; PATCH on an unknown band → 404; PATCH then GET shows `hasOverride: true` and the new label; DELETE then GET shows `autoLabel`; PATCH without a CSRF token → 403.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the routes and the UI.
- [ ] **Step 4: Run** `npm test`. Manual check: rename a band locally; after reload Topic Evolution shows the new name, and Reset restores it.
- [ ] **Step 5: Commit** `feat(admin): review and rename research-area bands`

### Task 11: Topic Evolution colours for up to 15 bands

**Files:**
- Modify: `public/app/topic-visuals.js` (`colorForIdx` in `renderTopicSankey` ~L906)
- Test: `test/uiCopy.test.js` or a new `test/bandPalette.test.js` importing the palette

**Interfaces:**
- Produces: `export const BAND_PALETTE` (15 hex colours) in a small new module `public/app/palette.js`, imported by `topic-visuals.js`; `colorForIdx = i => BAND_PALETTE[i % BAND_PALETTE.length]`. Before choosing values, read the `dataviz` skill and run its palette validator against both themes. The chosen set must pass for both.

- [ ] **Step 1: Write the failing test** `band palette has 15 distinct colours`: 15 entries, all `/^#[0-9a-f]{6}$/i`, no duplicates.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement** the palette and wire it into the chart and the legend.
- [ ] **Step 4: Run** `npm test` and `npx playwright test e2e/smoke.spec.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(topics): distinct colours for up to 15 research areas`

---

### Task 12: Rollout (owner approval required at each prod step)

No code. Each step starts only after the owner says go.

- [ ] **Step 1: Whole-branch verification.** `npm test`, `npx eslint .` and `npx playwright test` all pass. Open a PR to `main`.
- [ ] **Step 2: Push the worker image** (bands code runs on worker/labeler machines). Follow memory `fly-worker-image-deploy`: push `worker-latest`, retag `labeler-latest`, and confirm both tag digests moved.
- [ ] **Step 3: Set the admin allow-list secret:** `fly secrets set ADMIN_ALLOWED_NETWORKS=<owner-home-ip> --stage`, so it applies with the deploy in Step 4.
- [ ] **Step 4: `fly deploy`.** Verify from the owner's network: the Admin tab is present. Then verify from elsewhere, e.g. `curl -s -o /dev/null -w '%{http_code}' https://dissertation-workbench.fly.dev/api/auth/session` from a non-home host, which should print `404`. `/api/health` is 200. Also:
  - Check that the `ip` in the request log lines is the real client address, not a Fly proxy address.
  - From outside the allowed network, try to spoof the header: `curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-For: <owner-home-ip>' https://dissertation-workbench.fly.dev/api/auth/available`. Expect `404`.
  - Watch for 429s on public routes right after the deploy. Too few trusted hops would collapse every visitor into one rate-limit bucket. If that happens, set `TRUST_PROXY=2` or revert the deploy.
  - Possible follow-up: read the client address from Fly's `Fly-Client-IP` header instead of counting proxy hops.
- [ ] **Step 5: Admin › Operations › Recompute Stored Themes.** When it finishes, `curl -s https://dissertation-workbench.fly.dev/api/metrics | python3 -c "import json,sys;print([w for w in json.load(sys.stdin)['wordCloud'] if 'unspec' in w['term']])"` prints `[]`.
- [ ] **Step 6 (optional): Admin › Topic Labels › Rebuild Research Areas (API-only).** Without Tasks 9–11 this job only writes the `topic_bands` table and the hierarchy. Topic Evolution still shows the top-10 clusters named after their largest child, and there is no Rebuild button in the UI, so the band names are not user-visible until Task 9 ships. Recommendation: defer this step to the Task 9 rollout. If it is run now, trigger it through the API and check:
  - the log reports k = 9 on today's topics (or the k the gap rule picks; record it);
  - `topics_generation` is unchanged;
  - the topic-label override count is still 104.
- [ ] **Step 7:** Once the bands are user-visible (Task 9 shipped and Step 6 run), owner spot-checks band names and renames any that need it.
