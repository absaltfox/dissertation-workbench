# UBC Dissertation Intelligence Workbench (Node.js)

Web app for exploring UBC Open Collections dissertation records with three tabs:

- `Document Explorer`: record table, detailed metadata, related docs by overlapping themes
- `Analytics Dashboard`: KPI cards, average page length by year, subject chart, abstract/theme word cloud
- `Query Lab`: edit API parameters and rerun retrieval
- `Admin → Query Configuration → Sync Documents`: cache Open Collections document attributes locally/Turso for faster dashboard reads

## Run

For local development, copy the example env file and fill in only the values you need:

```bash
cp .env.development.example .env
```

The app loads `.env` automatically when run directly with Node. Existing shell
environment variables win over `.env` values, so Docker/Fly secrets remain
authoritative in deployed environments.

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Run the background document sync worker locally:

```bash
npm run worker
```

## API endpoint used by frontend

`GET /api/metrics?index=24&term=degree.raw,Doctor%20of%20Education%20-%20EdD&source=title,author,ubc_date_sort,uri,creator,supervisor,description,genre,date_available,rights,doi,affiliation,degree_theses,program_theses,scholarly_level,campus,degree,program&maxRecords=200&pageSize=20&scanLimit=1000&subjectLimit=20`

Supported query params:

- `index` (default `24`)
- `query` (`q`, optional)
- `term` (default `degree.raw,Doctor of Education - EdD`)
- `source` (default `title,author,ubc_date_sort,uri,creator,supervisor,description,genre,date_available,rights,doi,affiliation,degree_theses,program_theses,scholarly_level,campus,degree,program`)
- `maxRecords` (default `200`)
- `pageSize` (default `20`)
- `scanLimit` (default `max(1000, maxRecords*10)`)
- `subjectLimit` (default `25`)
- `downloadFiles` (`1`/`0`, default `1`)
- `recomputeFromCache` (`1`/`0`, default `0`; recompute metrics from local PDFs without redownload)
- `refresh=1` to bypass cache

## Environment variables

- `PORT` (default `3000`)
- `UBC_API_BASE_URL` (default `https://oc-index.library.ubc.ca`)
- `UBC_INDEX` (default `24`)
- `UBC_QUERY` (default empty)
- `UBC_TERM` (default `degree.raw,Doctor of Education - EdD`)
- `UBC_SOURCE` (comma-separated source field list)
- `UBC_API_KEY` (optional; when set, this env value is authoritative and the admin UI cannot replace it)
- `DOWNLOAD_FILES` (`1` by default; set `0` to disable downloads)
- `FILE_CONCURRENCY` (default `2`)
- `PDF_ALLOWED_HOSTS` (comma-separated download host allowlist; defaults to `open.library.ubc.ca,oc-index.library.ubc.ca`)
- `PDF_ALLOW_HTTP_DOWNLOADS` (`1`/`0`; defaults to `0` in production, `1` in local dev)
- `APP_DATA_DIR` (default `./data` from the current working directory)
- `PDF_CACHE_DIR` (default `./data/pdf-cache`)
- `SQLITE_PATH` (default `./data/metrics.sqlite`)
- `TURSO_DATABASE_URL` (optional; when set, database reads/writes use Turso/libSQL instead of local `SQLITE_PATH`)
- `TURSO_AUTH_TOKEN` (optional locally; required in production when `TURSO_DATABASE_URL` points to Turso/libSQL)
- `CACHE_TTL_MS` (default `600000`)
- `TRUST_PROXY` (`1`/`0`, default `0`; enable when behind reverse proxy to trust `x-forwarded-*` headers)
- `SESSION_COOKIE_SECURE` (`1`/`0`; defaults to `1` in production, `0` otherwise)
- `REQUIRE_ADMIN_MFA` (`1`/`0`; defaults to `1` in production, `0` otherwise)
- `API_KEY_ENCRYPTION_KEY` (required in production for stored API keys; used for AES-GCM encryption)
- `MFA_SECRET_ENCRYPTION_KEY` (required in production for stored TOTP secrets; use a different value than `API_KEY_ENCRYPTION_KEY`)
- `ADMIN_BOOTSTRAP_PASSWORD` (required in production when creating the initial `admin` account)
- `ENV_FILE` (optional; load a local env file other than `.env`)
- `SKIP_LOCAL_ENV` (`1`/`0`; set `1` to prevent automatic `.env` loading)
- `LOGIN_WINDOW_MS` (default `900000`)
- `LOGIN_BLOCK_MS` (default `900000`)
- `LOGIN_MAX_ATTEMPTS_IP` (default `25`)
- `LOGIN_MAX_ATTEMPTS_USER` (default `10`)
- `LOGIN_FAILURE_DELAY_MS` (default `350`)
- `PUBLIC_MAX_RECORDS` (default `300` in production, `2000` in local dev)
- `PUBLIC_SCAN_LIMIT` (default `5000` in production, `50000` in local dev)
- `ALLOW_PUBLIC_DOWNLOADS` (`1`/`0`; defaults to `0` in production, `1` in local dev)
- `ALLOW_PUBLIC_REFRESH` (`1`/`0`; defaults to `0` in production, `1` in local dev)
- `ALLOW_PUBLIC_RECOMPUTE` (`1`/`0`; defaults to `0` in production, `1` in local dev)
- `EXPOSE_ERROR_DETAILS` (`1`/`0`; defaults to `0` in production, `1` in local dev)
- `BERTOPIC_PYTHON_COMMAND` (Python executable used by the admin BERTopic job; default `python3`)
- `BERTOPIC_TIMEOUT_MS` (admin BERTopic job timeout; default one hour)
- `DOCUMENT_SYNC_INTERVAL_MS` (default daily)
- `DOCUMENT_SYNC_ENABLED` (`1`/`0`; defaults to `1`)
- `DOCUMENT_SYNC_ON_START` (`1`/`0`; defaults to `1`)
- `DOCUMENT_SYNC_ONCE` (`1`/`0`; run one worker cycle and exit)
- `DOCUMENT_SYNC_SCAN_LIMIT` (default `50000`)
- `DOCUMENT_SYNC_MAX_RECORDS` (`0` means use scan limit)
- `DOCUMENT_SYNC_PAGE_SIZE` (default `100`)
- `CATALOGUE_LOOKUP_ENABLED` (`1`/`0`; defaults to `1`)
- `CATALOGUE_LOOKUP_ON_START` (`1`/`0`; defaults to `1`)
- `CATALOGUE_LOOKUP_PAGE_SIZE` (default `200`)

## Fly.io Deployment

This repo includes a Docker/Fly setup with two process groups:

- `app`: Express web/API process
- `worker`: long-running document sync and Z39.50 catalogue lookup process

Use Turso in production by setting `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` as Fly secrets. The Fly volume mounted at `/data` is intended for local PDF/cache files; it should not be the shared production database for multiple machines.

Required production secrets include. Set these as Fly secrets or container
environment variables, not in the image:

```bash
fly secrets set \
  TURSO_DATABASE_URL=... \
  TURSO_AUTH_TOKEN=... \
  UBC_API_KEY=... \
  ADMIN_BOOTSTRAP_PASSWORD=... \
  API_KEY_ENCRYPTION_KEY=... \
  MFA_SECRET_ENCRYPTION_KEY=...
```

In production the app validates secret configuration at startup: the API-key
encryption key and MFA-secret encryption key must both be present and must be
different, and Turso deployments require `TURSO_AUTH_TOKEN`. Startup also
checks common deployment files for committed secret-looking values and fails
production boot if it finds them. In local development those values are optional
so `npm start` and `npm run worker` still work outside Docker with a simple
`.env` file.

Create the volume before the first deploy if you want persistent PDF cache:

```bash
fly volumes create oc_papers_data --region sea --size 10
fly deploy
```

The Docker image installs `yaz`, so the worker can run Z39.50 catalogue checks through `yaz-client`. The web app still exposes the manual admin catalogue endpoint, but automatic pending lookup processing belongs to the worker process.

## Notes

- UBC API rate limits can apply per IP. Use smaller page sizes/record counts and an API key when needed.
- Open Collections API keys are applied server-side only. Browser requests do not include keys in query strings.
- Authentication uses in-memory login rate limiting to reduce brute-force risk.
- Security response headers are enabled by default.
- Public `downloadFiles`, `refresh`, and `recomputeFromCache` are restricted by default in production but allowed in local development.
- App downloads each source PDF once and caches it locally.
- Per-document attributes, PDF metrics, sync runs, and run-level metric snapshots are persisted through libSQL: local SQLite by default, or Turso when `TURSO_DATABASE_URL` is set.
- For larger deployments, run `Sync Documents` from the admin panel first. Matching `/api/metrics` requests then read document attributes from the local/Turso cache instead of paging Open Collections during the dashboard request. `Force Refresh` still bypasses the in-memory metrics cache and can fall back to live Open Collections retrieval.
- PDFs are only redownloaded when `refresh=1` (or \"Force Refresh\" in Query Lab) is used.
- \"Update From Local PDF Cache\" in Query Lab recomputes counts from cached PDFs without redownloading.
