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

Run the background worker in a second terminal when you want scheduled document sync and pending Z39.50 catalogue lookup processing:

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

The public `/api/metrics` endpoint can fetch directly from Open Collections, but for larger runs the preferred workflow is:

1. Start `npm start`.
2. Sign in to `Admin`.
3. Configure/import Open Collections rules in `Admin -> Import`.
4. Run an import job, usually `Import all` for a new database or `Sync differences` afterward.
5. Let `npm run worker` process scheduled syncs and pending catalogue lookups, or run jobs manually from `Admin -> Jobs`.

When matching documents already exist in the local/Turso cache, `/api/metrics` reads cached document attributes instead of paging Open Collections during dashboard requests. `refresh=1` bypasses the in-memory metrics cache and can force live retrieval/redownloads depending on request options.

## API

The main frontend endpoint is:

```http
GET /api/metrics
```

Supported query params:

- `index`: Open Collections index name/id. If omitted, code defaults to `UBC_INDEX`; the development env template sets `UBC_INDEX=24`.
- `query`: optional Open Collections `q` query string.
- `term`: Open Collections term filter. Default is `UBC_TERM`, usually `degree.raw,Doctor of Education - EdD`.
- `source`: comma-separated source field list. The app ensures `id`, `identifier`, and `uri` are included.
- `maxRecords`: default `200`; anonymous public requests are capped by `PUBLIC_MAX_RECORDS`.
- `pageSize`: default `20`, maximum `100`.
- `scanLimit`: default `max(1000, maxRecords * 10)`; anonymous public requests are capped by `PUBLIC_SCAN_LIMIT`.
- `subjectLimit`: default `25`.
- `downloadFiles`: `1`/`0`, default `1`. Restricted in production unless allowed or requested by an authenticated admin session.
- `recomputeFromCache`: `1`/`0`, default `0`. Recomputes metrics from cached PDFs without redownloading.
- `refresh=1`: bypasses the in-memory metrics cache and enables force-refresh behavior.

Open Collections API keys are applied server-side. Browser requests do not need to include keys.

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
- `SQLITE_PATH`: local SQLite/libSQL file path, default `${APP_DATA_DIR}/metrics.sqlite`.
- `TURSO_DATABASE_URL`: optional remote libSQL/Turso URL. If omitted, local SQLite is used.
- `TURSO_AUTH_TOKEN`: required in production when `TURSO_DATABASE_URL` points to Turso/libSQL.
- `DOWNLOAD_FILES`: default `1`; set `0` to avoid automatic PDF downloads by default.
- `PDF_ALLOWED_HOSTS`: download host allowlist, default `open.library.ubc.ca,oc-index.library.ubc.ca`.
- `PDF_ALLOW_HTTP_DOWNLOADS`: defaults to `1` in development and `0` in production.
- `PDF_DOWNLOAD_RATE_PER_MIN`: optional PDF download throttle; `0` means unlimited.
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

- `DOCUMENT_SYNC_ENABLED`: default `1`.
- `DOCUMENT_SYNC_ON_START`: default `1`.
- `DOCUMENT_SYNC_ONCE`: run one worker cycle and exit.
- `DOCUMENT_SYNC_INTERVAL_MS`: default daily.
- `DOCUMENT_SYNC_INDEX`, `DOCUMENT_SYNC_QUERY`, `DOCUMENT_SYNC_TERM`, `DOCUMENT_SYNC_SOURCE`, `DOCUMENT_SYNC_API_KEY`: optional worker-specific Open Collections overrides.
- `DOCUMENT_SYNC_SCAN_LIMIT`: default `50000`.
- `DOCUMENT_SYNC_MAX_RECORDS`: `0` means use scan limit.
- `DOCUMENT_SYNC_PAGE_SIZE`: default `100`.
- `CATALOGUE_LOOKUP_ENABLED`: default `1`.
- `CATALOGUE_LOOKUP_ON_START`: default `1`.
- `CATALOGUE_LOOKUP_PAGE_SIZE`: default `200`.

Optional enrichment services:

- `GROBID_URL`: GROBID endpoint. Defaults to `http://localhost:8070`, or `http://${FLY_APP_NAME}-grobid.internal:8070` on Fly.
- `GROBID_APP_NAME`: Fly companion app name for GROBID auto-start checks; defaults to `${FLY_APP_NAME}-grobid`.
- `FLY_API_TOKEN`: optional token used on Fly to start/check a stopped companion GROBID machine.
- `BERTOPIC_PYTHON_COMMAND`: Python executable for BERTopic jobs, default `python3`.
- `BERTOPIC_TIMEOUT_MS`: BERTopic job timeout, default one hour.
- `ANTHROPIC_API_KEY`: optional; `scripts/build-topics.py` uses it to generate human-readable topic labels.

## Fly.io and Turso Deployment

The repo includes a Docker/Fly setup with two process groups:

- `app`: Express web/API process.
- `worker`: long-running document sync and Z39.50 catalogue lookup process.

Use Turso for the shared production database. The Fly volume mounted at `/data` is best treated as PDF/cache storage, not as a multi-machine shared database.

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
fly secrets set FLY_API_TOKEN=...
```

5. Deploy the Node app:

```bash
fly deploy
```

6. Optional: deploy GROBID as a companion app for higher-quality citation extraction:

```bash
fly deploy -c fly.grobid.toml
```

Make sure the GROBID app name matches the `GROBID_URL` convention or set `GROBID_URL`/`GROBID_APP_NAME` explicitly.

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

