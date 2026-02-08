# UBC Dissertation Intelligence Workbench (Node.js)

Web app for exploring UBC Open Collections dissertation records with three tabs:

- `Document Explorer`: record table, detailed metadata, related docs by overlapping themes
- `Analytics Dashboard`: KPI cards, average page length by year, subject chart, abstract/theme word cloud
- `Query Lab`: edit API parameters and rerun retrieval

## Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

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
- `apiKey` (optional, per-request override)
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
- `UBC_API_KEY` (optional)
- `DOWNLOAD_FILES` (`1` by default; set `0` to disable downloads)
- `FILE_CONCURRENCY` (default `2`)
- `APP_DATA_DIR` (default `/Users/mleblanc/Documents/code/oc-papers/data`)
- `PDF_CACHE_DIR` (default `/Users/mleblanc/Documents/code/oc-papers/data/pdf-cache`)
- `SQLITE_PATH` (default `/Users/mleblanc/Documents/code/oc-papers/data/metrics.sqlite`)
- `CACHE_TTL_MS` (default `600000`)

## Notes

- UBC API rate limits can apply per IP. Use smaller page sizes/record counts and an API key when needed.
- App downloads each source PDF once and caches it locally.
- Per-document metrics and run-level metric snapshots are persisted in SQLite.
- PDFs are only redownloaded when `refresh=1` (or \"Force Refresh\" in Query Lab) is used.
- \"Update From Local PDF Cache\" in Query Lab recomputes counts from cached PDFs without redownloading.
