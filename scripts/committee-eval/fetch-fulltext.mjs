// Reads manifest.json, fetches OC full text (PDF fallback on miss) into the cache,
// writes coverage.json. Requires prod connectivity.
// Usage: node scripts/committee-eval/fetch-fulltext.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadDocumentMetadata } from '../../src/db.js';
import { fetchFullTextForDocument, fetchPdfForDocument, analyzePdfAtPath } from '../../src/pdf.js';
import { assessTextQuality } from './lib/quality.mjs';
import { PDF_DOWNLOAD_RATE_PER_MIN } from '../../src/config.js';

const EVAL_DIR = 'data/committee-eval';
const TEXT_DIR = path.join(EVAL_DIR, 'fulltext');
mkdirSync(TEXT_DIR, { recursive: true });

// Politeness throttle for streaming PDFs from OC (spec §7): honor the same
// PDF_DOWNLOAD_RATE_PER_MIN budget the production pipeline uses. 0 = unlimited.
const _pdfFetchTimes = [];
async function throttlePdfFetch() {
  if (!PDF_DOWNLOAD_RATE_PER_MIN) return;
  const windowMs = 60_000;
  const now = Date.now();
  while (_pdfFetchTimes.length && _pdfFetchTimes[0] < now - windowMs) _pdfFetchTimes.shift();
  if (_pdfFetchTimes.length >= PDF_DOWNLOAD_RATE_PER_MIN) {
    const waitMs = _pdfFetchTimes[0] + windowMs - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    const t = Date.now();
    while (_pdfFetchTimes.length && _pdfFetchTimes[0] < t - windowMs) _pdfFetchTimes.shift();
  }
  _pdfFetchTimes.push(Date.now());
}

// `fetchPdfForDocument` returns raw PDF bytes (`.bytes`), not extracted text —
// there is no `.fullText` on its result. Text extraction from a downloaded PDF
// is a separate, existing pipeline step (`analyzePdfAtPath`, used by
// `analyzeDocumentFile`), which shells out to `pdftotext` against a file path.
// So the fallback here stages the bytes to a scratch temp file and reuses that
// existing extractor rather than inventing a new one.
async function extractTextFromPdfBytes(bytes) {
  const tmpPath = path.join(os.tmpdir(), `committee-eval-pdf-${Date.now()}-${crypto.randomUUID()}.pdf`);
  try {
    await writeFile(tmpPath, bytes);
    const analysis = await analyzePdfAtPath(tmpPath, bytes);
    return analysis?.fullText || null;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

// --manifest <path> selects the input manifest (default the main one); the text cache and
// coverage.json are shared across batches so widening accumulates rather than overwrites.
const argv = process.argv.slice(2);
const manifestArg = (() => { const i = argv.indexOf('--manifest'); return i === -1 ? 'test/fixtures/committee-eval/manifest.json' : argv[i + 1]; })();
const manifest = JSON.parse(readFileSync(manifestArg, 'utf8'));
const coveragePath = path.join(EVAL_DIR, 'coverage.json');
const coverage = [];

for (const entry of manifest) {
  const meta = await loadDocumentMetadata(entry.docId);
  if (!meta) { coverage.push({ docId: entry.docId, textSource: 'unavailable', degraded: false, byteLength: 0, reason: 'no-metadata' }); continue; }
  const doc = { ...meta, id: entry.docId };

  let text = null;
  let textSource = null;
  const ft = await fetchFullTextForDocument(doc, null, { persistFullText: false });
  if (ft && ft.fullText) { text = ft.fullText; textSource = 'dspace_text'; }
  else {
    // Derivative missing/too-short — download the PDF and extract text via the
    // existing pdftotext-backed pipeline (see extractTextFromPdfBytes above).
    await throttlePdfFetch();
    const pdf = await fetchPdfForDocument(doc, {});
    if (pdf && pdf.bytes) {
      const pdfText = await extractTextFromPdfBytes(pdf.bytes);
      if (pdfText) { text = pdfText; textSource = 'pdf_fallback'; }
    }
  }

  if (!text) { coverage.push({ docId: entry.docId, textSource: 'unavailable', degraded: false, byteLength: 0, reason: 'no-text-no-pdf' }); continue; }

  const q = assessTextQuality(text);
  writeFileSync(path.join(TEXT_DIR, `${entry.docId}.txt`), text);
  coverage.push({ docId: entry.docId, textSource, degraded: q.degraded, byteLength: q.byteLength, reason: q.reason });
}

// Merge into any existing coverage (upsert by docId) so a widening batch preserves
// earlier batches' coverage entries rather than clobbering them.
let merged = coverage;
if (existsSync(coveragePath)) {
  const prior = JSON.parse(readFileSync(coveragePath, 'utf8'));
  const now = new Map(coverage.map((c) => [c.docId, c]));
  merged = [...prior.filter((c) => !now.has(c.docId)), ...coverage];
}
writeFileSync(coveragePath, JSON.stringify(merged, null, 2) + '\n');
const roll = coverage.reduce((a, c) => {
  a[c.textSource] = (a[c.textSource] || 0) + 1;
  if (c.degraded) a.degraded += 1;
  return a;
}, { degraded: 0 });
console.log('Coverage:', JSON.stringify(roll));
