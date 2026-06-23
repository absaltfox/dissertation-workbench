# Dissertation Intelligence Workbench (Node.js)

The Dissertation Workbench attempts to do a number of different things at the same time. On a technical level, it demonstrates how a node.js app can integrate with the UBC Open Collections API, extracting metadata relating to dissertations and theses -- such as abstracts, authors, departments, etc. In addition, the workbench uses the metadata and the documents themselves to create new metadata. It does this by employing a variety of different strategies, including:

- N-gram analysis to extract unigrams, bigrams and trigrams to describe "topics" and "concepts" in combination with TF-IDF
- Citations are extracted using a GROBID -> Anystyle -> Regex pipeline, and are then located in UBC's collections using Z39.50
- Basic people networks are developed, linking authors to supervisors to research topics and methodologies
- Latent topics are derived from document abstracts using BERTopic with embeddings derived from the allenai/specter2 model 

On the one hand, the additional metadata and metrics serve as a discovery aid; new avenues appear for researchers and students looking for papers linked by supervisor, topic, methods, etc. On the other hand, the metadata tells the story of research at UBC, indicating the favour (and disfavour) of different topics and methodologies among students and researchers over time. Even basic metrics such as page length or dissertations submitted by department by year become avenues for further analysis and interpretation. 

The Dissertation Workbench was developed with AI assistance, using a combination of Claude Code, ChatGPT Codex, and Google Antigravity with Gemini Flash. 

## Application Structure

The browser UI is organized into these main tabs:
- `Document Explorer`: retrieved dissertations and theses, with document detail modals, exports, concepts, topics, citations, and related documents.
- `Citation Explorer`: works cited by document, UBC catalogue lookup status, and foundational works cited across the corpus.
- `Person Explorer`: supervisors, committee members, and examiners with associated documents, roles, concepts, and topics.
- `Analytics Dashboard`: KPI cards, page and word-count trends, concept clouds, methodology signals, heatmaps, networks, and topic visualizations.
- `About this Tool`: project context and caveats.
- `Admin`: query/import configuration, import-rule jobs, catalogue lookup jobs, BERTopic rebuilds, users, cache tools, and run history.

## Prerequisites

- Node.js `22.5` or newer.
- npm.
- `poppler-utils` for PDF text/page extraction. On macOS, install with `brew install poppler`.
- Optional: `yaz-client` for Z39.50 catalogue lookups. On macOS, install with `brew install yaz`.
- Optional: AnyStyle for better text-based citation parsing. If it is not installed, the app falls back to regex parsing.
- Optional: Python dependencies for BERTopic jobs: `pip install -r requirements.txt`.

The Docker image installs `poppler-utils` and `yaz` for deployed/Fly runs.

## Local Development

Install dependencies:

```bash
npm install
```

Copy the development env template:

```bash
cp .env.development.example .env
```

The app automatically loads `.env` when run directly with Node. Existing shell environment variables win over `.env` values. To use another local env file, set `ENV_FILE`; to disable local env loading, set `SKIP_LOCAL_ENV=1`.

Start the web app:

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

On first local boot, the app creates an `admin` user with a random password and prints it to the terminal. Sign in with that password and change it in the admin UI. In production, the first admin password comes from `ADMIN_BOOTSTRAP_PASSWORD`.

Admin-triggered import/PDF jobs run through on-demand local child workers by default. You can still run the legacy scheduled worker in a second terminal when you specifically want scheduled document sync or pending Z39.50 catalogue lookup processing:

```bash
npm run worker
```

Run the test suite:

```bash
npm test
```

## Local Data Flow

By default, local data lives under `./data`:

- `./data/metrics.sqlite`: local libSQL/SQLite database.
- `./data/pdf-cache`: downloaded PDFs and PDF-derived cache files.

The public `/api/metrics` endpoint is read-only and builds the dashboard from the app's local database tables. Open Collections is refreshed only through Admin-triggered import/sync jobs:

1. Start `npm start`.
2. Sign in to `Admin`.
3. Configure/import Open Collections rules in `Admin -> Import`.
4. Run an import job, usually `Import all` for a new database or `Sync differences` afterward.
5. Run import/PDF jobs from the Admin UI; on-demand workers process the heavy work outside the web server. Use `npm run worker` only for legacy scheduled sync/catalogue lookup cycles.

Dashboard reads never page Open Collections. If `/api/metrics` receives query parameters that match a stored sync key, it uses that stored subset; otherwise it falls back to the locally stored corpus. `refresh=1` only bypasses the web process's in-memory metrics payload cache. It does not call Open Collections, download PDFs, recompute file metrics, or extract citations/committee data.

## API

The main frontend endpoint is:

```http
GET /api/metrics
```

`/api/metrics` is the dashboard composition endpoint. Its contract is to read local application tables and return the complete dashboard payload:

- `documents`: stored document metadata from `documents`, enriched with persisted `file_metrics` page/word counts, `document_citations` counts, and `committee_members` roles such as supervisors, committee members, university examiners, and external examiners.
- `metrics`, `wordCloud`, `ngramCloud`, `methodologies`, supervisor/person networks, topic data, and citation co-occurrence values derived from those local rows.
- `source.documentCache`: metadata about which stored document set was used, including whether the requested sync key matched exactly.

Open Collections API calls belong to Admin import/sync flows such as import-rule preview, import-rule sync, and document sync. Do not add Open Collections fetching to `/api/metrics`; use an Admin route/job to refresh local tables first.

Supported query params:

- `index`, `query`, `term`, `source`: identify the preferred stored sync key. They do not trigger live Open Collections reads from this endpoint.
- `maxRecords`: default `200`; anonymous public requests are capped by `PUBLIC_MAX_RECORDS`.
- `pageSize`: default `20`, maximum `100`.
- `scanLimit`: default `max(1000, maxRecords * 10)`; anonymous public requests are capped by `PUBLIC_SCAN_LIMIT`.
- `subjectLimit`: default `25`.
- `downloadFiles` and `recomputeFromCache` are ignored by this read-only dashboard endpoint. PDF downloads, cIRcle full-text fetches, and file recomputation only run through Admin-triggered sync/cache actions.
- `refresh=1`: bypasses the in-memory metrics cache. It does not fetch upstream metadata or force PDF/full-text enrichment.

Open Collections API keys are applied server-side for Admin import/sync work. Browser dashboard requests do not need keys.

### Public Endpoints

These endpoints are available to the browser without an admin session. Expensive metrics options are still capped or blocked by the public guardrail settings listed below.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health check with `{ ok, timestamp }`. |
| `GET` | `/api/metrics` | Builds dashboard metrics from local app tables; does not fetch Open Collections. |
| `GET` | `/api/documents/:docId/citations` | Returns citations for one cached document, including sharing counts. |
| `GET` | `/api/citations/top?limit=50` | Returns the most-cited works, capped at 200. |
| `GET` | `/api/citations/:citationId/documents` | Returns documents that cite a stored citation. |
| `GET` | `/api/citations/:citationId/summon-check` | Checks UBC Summon holdings for a stored citation. Returns `502` if Summon lookup fails. |

### Auth Endpoints

Authentication uses an HTTP-only session cookie plus an `x-csrf-token` header for state-changing authenticated requests. Login and MFA setup confirmation are exempt from CSRF because they happen before a trusted session exists.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Starts or completes admin login. May return `mfaRequired` or `mfaSetupRequired`. |
| `POST` | `/api/auth/mfa/setup/confirm` | Confirms first-time MFA setup and creates a session. |
| `POST` | `/api/auth/password-reset/confirm` | Consumes a password-reset token and stores a new password. |
| `POST` | `/api/auth/logout` | Destroys the active session and clears the cookie. Requires CSRF when authenticated. |
| `GET` | `/api/auth/session` | Returns the current admin username and CSRF token, or `401`. |

### Admin Endpoints

All `/api/admin/*` endpoints require an authenticated admin session. `POST`, `PUT`, and `DELETE` requests also require the `x-csrf-token` header returned by login/session endpoints.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/users` | Lists admin users. |
| `POST` | `/api/admin/users` | Creates an admin user and returns a password-reset URL. |
| `DELETE` | `/api/admin/users/:username` | Deletes an admin user; the current and last remaining admin cannot be deleted. |
| `PUT` | `/api/admin/users/:username/password` | Sets an admin user's password. |
| `POST` | `/api/admin/users/:username/password-reset` | Creates a password-reset URL for an admin user. |
| `POST` | `/api/admin/me/mfa/setup` | Starts MFA setup for the current admin. |
| `DELETE` | `/api/admin/users/:username/mfa` | Clears MFA for an admin user. |
| `GET` | `/api/admin/settings` | Returns non-secret admin settings plus API-key status. |
| `PUT` | `/api/admin/settings` | Updates admin settings; `apiKey` is ignored when env-managed. |
| `GET` | `/api/admin/import-rules` | Lists saved Open Collections import rules. |
| `POST` | `/api/admin/import-rules` | Validates and saves an import rule. |
| `PUT` | `/api/admin/import-rules/:id` | Updates an import rule. |
| `DELETE` | `/api/admin/import-rules/:id` | Deletes an import rule. |
| `GET` | `/api/admin/open-collections/facets` | Returns live Open Collections facet counts, falling back to local cached metadata. |
| `GET` | `/api/admin/import-rules/preview` | Previews an import rule with sample records and scan-limit warnings. |
| `POST` | `/api/admin/import-rules/sync` | Runs one import rule immediately and clears the metrics cache. |
| `POST` | `/api/admin/import-rules/run` | Starts a background import-rules job for selected or all rules; returns `202`. |
| `GET` | `/api/admin/jobs` | Returns recent admin jobs, sync runs, catalogue stats, topic status, and concept status. |
| `POST` | `/api/admin/jobs/catalogue-lookup` | Starts a background Z39.50 lookup job, or returns a dry-run preview. |
| `POST` | `/api/admin/jobs/bertopic` | Starts a background BERTopic rebuild job. |
| `GET` | `/api/admin/documents/sync/status` | Returns global or query-specific document sync status. |
| `POST` | `/api/admin/documents/sync` | Starts document sync for request body/query options and clears metrics cache. |
| `GET` | `/api/admin/concepts/status` | Returns concept pipeline status. |
| `POST` | `/api/admin/concepts/rebuild` | Rebuilds the concept dictionary; returns `409` if a rebuild cannot start. |
| `GET` | `/api/admin/catalogue-lookup/stats` | Returns stored catalogue lookup statistics. |
| `POST` | `/api/admin/catalogue-lookup` | Runs pending catalogue lookups synchronously, or previews with `dryRun=1`. |
| `GET` | `/api/admin/cache` | Lists cached file-metric entries. |
| `GET` | `/api/admin/cache/stats` | Returns file-metric cache statistics. |
| `POST` | `/api/admin/cache/refresh` | Clears only the in-memory metrics cache. |
| `POST` | `/api/admin/cache/:docId/refresh` | Redownloads/reanalyzes one document and clears metrics cache. |
| `DELETE` | `/api/admin/cache/:docId` | Deletes cached PDF and file metrics for one document. |
| `POST` | `/api/admin/reparse-all` | Re-extracts committee/citation data from cached PDFs and reruns catalogue lookups. |
| `POST` | `/api/admin/reparse-committee` | Re-extracts committee data for cached PDFs missing committee records. |
| `GET` | `/api/admin/runs` | Returns recent import/sync runs. |

## Core Environment Variables

Use `.env.development.example` and `.env.production.example` as the canonical templates. Important settings:

- `PORT`: HTTP port, default `3000`.
- `NODE_ENV`: use `development` locally and `production` in deployed environments.
- `UBC_API_BASE_URL`: default `https://oc-index.library.ubc.ca`.
- `UBC_INDEX`: Open Collections index. Code default is empty; the example env files set `24`.
- `UBC_QUERY`, `UBC_TERM`, `UBC_SOURCE`: default Open Collections query scope.
- `UBC_API_KEY`: optional Open Collections API key. When set in env, it is authoritative and the admin UI cannot replace it.
- `APP_DATA_DIR`: data directory, default `./data`.
- `PDF_CACHE_DIR`: PDF cache directory, default `${APP_DATA_DIR}/pdf-cache`.
- `FULL_TEXT_CACHE_DIR`: extracted cIRcle full-text cache directory, default `${APP_DATA_DIR}/full-text-cache`.
- `SQLITE_PATH`: local SQLite/libSQL file path, default `${APP_DATA_DIR}/metrics.sqlite`.
- `TURSO_DATABASE_URL`: optional remote libSQL/Turso URL. If omitted, local SQLite is used.
- `TURSO_AUTH_TOKEN`: required in production when `TURSO_DATABASE_URL` points to Turso/libSQL.
- `DOWNLOAD_FILES`: default `1`; set `0` to avoid automatic PDF downloads by default. PDF enrichment uses cIRcle REST `ORIGINAL` bitstreams exposed through `digitalResourceOriginalRecord`; full-text fallback uses cIRcle `TEXT` bitstreams.
- `PDF_DOWNLOAD_RATE_PER_MIN`: optional cIRcle REST PDF download throttle; `0` means unlimited.
- `CACHE_TTL_MS`: in-memory metrics cache TTL, default `600000`.
- `TRUST_PROXY`: set `1` behind Fly/reverse proxies.
- `SESSION_COOKIE_SECURE`: defaults to `1` in production and `0` otherwise.
- `REQUIRE_ADMIN_MFA`: defaults to `1` in production and `0` otherwise.
- `ADMIN_BOOTSTRAP_PASSWORD`: required in production to create the first `admin` user.
- `API_KEY_ENCRYPTION_KEY`: required in production for stored API keys.
- `MFA_SECRET_ENCRYPTION_KEY`: required in production for stored TOTP secrets; use a different value from `API_KEY_ENCRYPTION_KEY`.
- `PUBLIC_MAX_RECORDS`, `PUBLIC_SCAN_LIMIT`: public endpoint guardrails.
- `ALLOW_PUBLIC_DOWNLOADS`, `ALLOW_PUBLIC_REFRESH`, `ALLOW_PUBLIC_RECOMPUTE`: public endpoint permissions; default to disabled in production.
- `EXPOSE_ERROR_DETAILS`: defaults to disabled in production.

Worker-specific settings:

- `DOCUMENT_SYNC_ENABLED`: defaults to `0` in production and `1` otherwise.
- `DOCUMENT_SYNC_ON_START`: defaults to `0` in production and `1` otherwise.
- `DOCUMENT_SYNC_ONCE`: run one worker cycle and exit.
- `DOCUMENT_SYNC_INTERVAL_MS`: default daily.
- `DOCUMENT_SYNC_INDEX`, `DOCUMENT_SYNC_QUERY`, `DOCUMENT_SYNC_TERM`, `DOCUMENT_SYNC_SOURCE`, `DOCUMENT_SYNC_API_KEY`: optional worker-specific Open Collections overrides.
- `DOCUMENT_SYNC_SCAN_LIMIT`: default `50000`.
- `DOCUMENT_SYNC_MAX_RECORDS`: `0` means use scan limit.
- `DOCUMENT_SYNC_PAGE_SIZE`: default `100`.
- `ADMIN_WORKER_MODE`: `auto`, `fly`, or `local`; `auto` uses temporary Fly Machines in production when Fly credentials are available and local child processes otherwise.
- `ADMIN_WORKER_TIMEOUT_MS`: default `21600000` (6 hours).
- `ADMIN_WORKER_GRACE_MS`: default `30000`.
- `WORKER_IMAGE`: optional image override for temporary Fly workers; if omitted, the app tries to reuse the current Fly machine image.
- `WORKER_ARTIFACT_BASE_URL`: optional base URL workers use for web-owned artifact streaming.
- `WORKER_FORCE_ARTIFACT_API`: set `1` to test artifact streaming locally instead of direct shared filesystem access.
- `FLY_WORKER_MEMORY_MB`, `FLY_WORKER_CPUS`, `FLY_WORKER_CPU_KIND`, `FLY_WORKER_REGION`: temporary Fly worker sizing and placement.
- `CATALOGUE_LOOKUP_ENABLED`: default `1`.
- `CATALOGUE_LOOKUP_ON_START`: default `1`.
- `CATALOGUE_LOOKUP_PAGE_SIZE`: default `200`.
- `CATALOGUE_LOOKUP_BATCH_SIZE`: default `1`; each `yaz-client` session handles one citation so slow OCR-derived queries fail independently instead of timing out a whole batch.
- `YAZ_CLIENT_TIMEOUT_MS`: single-lookup timeout, default `15000`.
- `YAZ_CLIENT_BATCH_BASE_TIMEOUT_MS`: batch lookup base timeout, default `30000`.
- `YAZ_CLIENT_BATCH_ITEM_TIMEOUT_MS`: additional timeout per item in a batch, default `2000`.

Optional enrichment services:

- `GROBID_URL`: GROBID endpoint. Defaults to `http://localhost:8070`, or `http://${FLY_APP_NAME}-grobid.internal:8070` on Fly.
- `GROBID_APP_NAME`: Fly companion app name for GROBID auto-start checks; defaults to `${FLY_APP_NAME}-grobid`.
- `GROBID_STARTUP_WAIT_MS`: max wait for a cold-starting GROBID companion service, default `420000` (7 minutes).
- `GROBID_FLY_API_TOKEN`: optional token used on Fly to start/check a stopped companion GROBID machine. Falls back to `FLY_API_TOKEN` when unset.
- `BERTOPIC_PYTHON_COMMAND`: Python executable for BERTopic jobs, default `python3`.
- `BERTOPIC_TIMEOUT_MS`: BERTopic job timeout, default one hour.
- `ANTHROPIC_API_KEY`: optional; `scripts/build-topics.py` uses it to generate human-readable topic labels.

## Fly.io and Turso Deployment

The repo includes a Docker/Fly setup with an Express web/API process and on-demand admin workers:

- `app`: Express web/API process.
- temporary admin workers: created for import/PDF jobs, then stopped or auto-destroyed when complete.

Use Turso for the shared production database. The Fly volume mounted at `/data` is owned by the web machine for PDF/full-text cache storage; temporary workers stream cached artifacts from the web process and upload new artifacts back before saving durable paths.

1. Create a Turso database and token, then keep the database URL and auth token for Fly secrets.

2. Copy the Fly config examples and edit app names/regions/volume names as needed:

```bash
cp fly.toml.example fly.toml
cp fly.grobid.toml.example fly.grobid.toml
```

3. Create the Fly app and volume for the Node app:

```bash
fly apps create dissertation-workbench
fly volumes create dissertation_wb_data --region sjc --size 10
```

4. Set production secrets on the Node app:

```bash
fly secrets set \
  TURSO_DATABASE_URL=... \
  TURSO_AUTH_TOKEN=... \
  UBC_API_KEY=... \
  ADMIN_BOOTSTRAP_PASSWORD=... \
  API_KEY_ENCRYPTION_KEY=... \
  MFA_SECRET_ENCRYPTION_KEY=...
```

If you deploy the optional GROBID companion app and want the Node app to wake/check it through Fly's internal Machines API, also set:

```bash
fly secrets set GROBID_FLY_API_TOKEN=...
```

Use a token that can manage the GROBID companion app. The main app's `FLY_API_TOKEN` is still used for temporary admin worker machines and may be scoped only to the main app.

5. Deploy the Node app:

```bash
fly deploy
```

6. Optional: deploy GROBID as a companion app for higher-quality citation extraction:

```bash
fly deploy -c fly.grobid.toml
```

Make sure the GROBID app name matches the `GROBID_URL` convention or set `GROBID_URL`/`GROBID_APP_NAME` explicitly. The companion app should run with at least 4 GB of memory; the provided `fly.grobid.toml` uses 2 shared CPUs so Fly accepts the 4 GB allocation.

In production, startup validates secret configuration. The API-key encryption key and MFA-secret encryption key must both be present and different, and Turso deployments require `TURSO_AUTH_TOKEN`. Startup also checks common deployment files for committed secret-looking values and fails production boot if it finds them.

## Operational Notes

- UBC API rate limits can apply per IP. Use smaller page sizes/record counts and an API key when needed.
- Without an API key, upstream Open Collections calls are throttled in-app to reduce 429s.
- Security response headers are enabled by default.
- Public `downloadFiles`, `refresh`, and `recomputeFromCache` are restricted by default in production but allowed in local development.
- PDFs are cached locally and are only redownloaded when force refresh is used.
- Citation extraction uses GROBID first, then AnyStyle, then regex fallback.
- Pending citation catalogue lookups use Z39.50 through `yaz-client`.
- BERTopic reads cached document abstracts from the database, uses `allenai/specter2_base`, and writes topic assignments back to the database.
- Per-document attributes, PDF metrics, sync runs, citations, catalogue lookups, admin jobs, users, and run-level metric snapshots are persisted through libSQL: local SQLite by default, or Turso when `TURSO_DATABASE_URL` is set.
