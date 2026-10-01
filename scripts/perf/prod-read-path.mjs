#!/usr/bin/env node
// Read-only prod read-path telemetry probe for the Dissertation Workbench.
//
// Usage:
//   BASE=https://dissertation-workbench.fly.dev node scripts/perf/prod-read-path.mjs
//
// Zero npm dependencies (Node 18+ built-ins only, incl. global fetch). Makes a
// small, fixed number of GET requests against each read endpoint to measure
// cold (first-hit) and warm (subsequent) latency. This is a telemetry probe,
// not a load-generation tool -- keep REPS modest and never point it at
// anything but a deployment you intend to observe.
//
// Endpoints probed:
//   GET /api/health
//   GET /api/workbench/documents?limit=50
//   GET /api/workbench/documents?q=<term>&limit=50          (search)
//   GET /api/workbench/documents/:docId                      (related-docs path)
//   GET /api/workbench/analytics
//   GET /api/workbench/visualizations
//
// The :docId above is picked from the first /api/workbench/documents response
// so the related-docs read path is exercised against a real document.

const BASE = (process.env.BASE || 'https://dissertation-workbench.fly.dev').replace(/\/+$/, '');
const REPS = Number(process.env.PERF_REPS || 5);
const SEARCH_TERM = process.env.PERF_SEARCH_TERM || 'education';

function percentile(sortedMs, p) {
  if (!sortedMs.length) return null;
  const index = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, index)];
}

async function timedFetch(url) {
  const startedAt = performance.now();
  let status = null;
  let body = null;
  try {
    const res = await fetch(url);
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (err) {
    status = `ERR:${err.message}`;
  }
  const elapsedMs = performance.now() - startedAt;
  return { status, elapsedMs, body };
}

async function probe(name, url, reps = REPS) {
  const first = await timedFetch(url);
  const warmSamples = [];
  for (let i = 0; i < reps - 1; i += 1) {
    const sample = await timedFetch(url);
    warmSamples.push(sample.elapsedMs);
  }
  warmSamples.sort((a, b) => a - b);
  return {
    name,
    url,
    status: first.status,
    firstHitMs: Math.round(first.elapsedMs),
    warmP50Ms: warmSamples.length ? Math.round(percentile(warmSamples, 50)) : null,
    warmP95Ms: warmSamples.length ? Math.round(percentile(warmSamples, 95)) : null,
    body: first.body,
  };
}

function printTable(rows) {
  const headers = ['endpoint', 'status', 'first-hit (ms)', 'warm p50 (ms)', 'warm p95 (ms)'];
  const cells = rows.map((row) => [
    row.name,
    String(row.status),
    String(row.firstHitMs),
    row.warmP50Ms == null ? '-' : String(row.warmP50Ms),
    row.warmP95Ms == null ? '-' : String(row.warmP95Ms),
  ]);
  const widths = headers.map((header, col) => (
    Math.max(header.length, ...cells.map((cellRow) => cellRow[col].length))
  ));
  const formatRow = (cols) => cols.map((cell, col) => cell.padEnd(widths[col])).join('  ');
  console.log(formatRow(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const cellRow of cells) console.log(formatRow(cellRow));
}

async function main() {
  console.log(`Probing ${BASE} (${REPS} reps/endpoint, read-only)\n`);

  const results = [];

  results.push(await probe('GET /api/health', `${BASE}/api/health`));
  results.push(await probe('GET /api/workbench/documents?limit=50', `${BASE}/api/workbench/documents?limit=50`));
  results.push(await probe(
    `GET /api/workbench/documents?q=${SEARCH_TERM}&limit=50`,
    `${BASE}/api/workbench/documents?q=${encodeURIComponent(SEARCH_TERM)}&limit=50`
  ));

  const docsPayload = results[1].body;
  const docs = docsPayload?.documents || docsPayload?.page?.documents || [];
  const sampleDoc = docs[0];
  const docId = sampleDoc?.id || sampleDoc?.docId || null;

  if (docId) {
    results.push(await probe(
      `GET /api/workbench/documents/:docId (related-docs)`,
      `${BASE}/api/workbench/documents/${encodeURIComponent(docId)}`
    ));
  } else {
    console.warn('No document id found in /api/workbench/documents response; skipping related-docs probe.\n');
  }

  results.push(await probe('GET /api/workbench/analytics', `${BASE}/api/workbench/analytics`));
  results.push(await probe('GET /api/workbench/visualizations', `${BASE}/api/workbench/visualizations`));

  printTable(results);
}

main().catch((err) => {
  console.error('Telemetry probe failed:', err);
  process.exitCode = 1;
});
