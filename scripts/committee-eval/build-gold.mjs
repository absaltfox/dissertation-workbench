// Emit worksheet (default) or finalize into gold.json (--finalize).
// Usage:
//   node scripts/committee-eval/build-gold.mjs                 # emit gold-worksheet.{json,csv}
//   node scripts/committee-eval/build-gold.mjs --finalize      # gold-worksheet.json (reviewed) -> gold.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseCommittee, parseAcknowledgementsDetailed } from '../../src/pdf.js';
import { buildWorksheetRows, finalizeGold } from './lib/worksheet.mjs';

const EVAL_DIR = 'data/committee-eval';
const TEXT_DIR = path.join(EVAL_DIR, 'fulltext');
const WORKSHEET_JSON = path.join(EVAL_DIR, 'gold-worksheet.json');
const WORKSHEET_CSV = path.join(EVAL_DIR, 'gold-worksheet.csv');
const GOLD = 'test/fixtures/committee-eval/gold.json';

const argv = process.argv.slice(2);

if (argv.includes('--finalize')) {
  const reviewed = JSON.parse(readFileSync(WORKSHEET_JSON, 'utf8'));
  const gold = finalizeGold(reviewed);
  writeFileSync(GOLD, JSON.stringify(gold, null, 2) + '\n');
  console.log(`Wrote ${gold.length} docs to ${GOLD}.`);
  process.exit(0);
}

// --manifest <path> selects input docs; --out <basename> writes to a separate worksheet
// (e.g. gold-worksheet-widen) so a widening batch never overwrites an already-labeled sheet.
const arg = (flag, def) => { const i = argv.indexOf(flag); return i === -1 ? def : argv[i + 1]; };
const MANIFEST = arg('--manifest', 'test/fixtures/committee-eval/manifest.json');
const OUT_BASE = arg('--out', path.join(EVAL_DIR, 'gold-worksheet'));
const OUT_JSON = `${OUT_BASE}.json`;
const OUT_CSV = `${OUT_BASE}.csv`;

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const coverage = existsSync(path.join(EVAL_DIR, 'coverage.json'))
  ? JSON.parse(readFileSync(path.join(EVAL_DIR, 'coverage.json'), 'utf8'))
  : [];
const coverageByDoc = new Map(coverage.map((c) => [c.docId, c]));

// Human-facing Open Collections item/viewer page (same pattern as src/api.js);
// derivable from docId alone, lets the reviewer open and verify the PDF directly.
const ocUrl = (id) => `https://open.library.ubc.ca/collections/ubctheses/items/${encodeURIComponent(id)}`;

const rows = [];
for (const entry of manifest) {
  const textPath = path.join(TEXT_DIR, `${entry.docId}.txt`);
  if (!existsSync(textPath)) continue;
  const fullText = readFileSync(textPath, 'utf8');
  const committee = parseCommittee(fullText);
  const acknowledgement = parseAcknowledgementsDetailed(fullText).members;
  // buildWorksheetRows gates the ack path on committee having no supervisor (mirrors
  // production), so it derives the certificate signal from the parsed committee itself.
  const docRows = buildWorksheetRows(entry.docId, { committee, acknowledgement });
  // Attach the acknowledgements text slice for hand-labeling certificate-absent docs.
  const ackIdx = fullText.search(/acknowledg/i);
  const ackSlice = ackIdx === -1 ? '' : fullText.slice(ackIdx, ackIdx + 1500).replace(/\s+/g, ' ');
  for (const r of docRows) rows.push({ ...r, oc_url: ocUrl(entry.docId), era: entry.era, degraded: coverageByDoc.get(entry.docId)?.degraded ?? '', ack_slice: r.source === 'certificate' ? '' : ackSlice });
}

writeFileSync(OUT_JSON, JSON.stringify(rows, null, 2) + '\n');
const header = ['docId', 'oc_url', 'name', 'proposed_role', 'on_certificate', 'source', 'era', 'degraded', 'keep', 'true_role', 'is_negative', 'ack_slice'];
const csv = [header.join(',')].concat(
  rows.map((r) => header.map((h) => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')),
).join('\n');
writeFileSync(OUT_CSV, csv + '\n');
console.log(`Wrote ${rows.length} worksheet rows (${new Set(rows.map((r) => r.docId)).size} docs) -> ${OUT_CSV}`);
console.log(`Wrote ${rows.length} worksheet rows for ${manifest.length} docs.`);
