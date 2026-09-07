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

const manifest = JSON.parse(readFileSync('test/fixtures/committee-eval/manifest.json', 'utf8'));
const coverage = existsSync(path.join(EVAL_DIR, 'coverage.json'))
  ? JSON.parse(readFileSync(path.join(EVAL_DIR, 'coverage.json'), 'utf8'))
  : [];
const coverageByDoc = new Map(coverage.map((c) => [c.docId, c]));

const rows = [];
for (const entry of manifest) {
  const textPath = path.join(TEXT_DIR, `${entry.docId}.txt`);
  if (!existsSync(textPath)) continue;
  const fullText = readFileSync(textPath, 'utf8');
  const certificatePresent = /the following individuals certify/i.test(fullText);
  const committee = parseCommittee(fullText);
  const acknowledgement = parseAcknowledgementsDetailed(fullText).members;
  const docRows = buildWorksheetRows(entry.docId, { committee, acknowledgement, certificatePresent });
  // Attach the acknowledgements text slice for hand-labeling certificate-absent docs.
  const ackIdx = fullText.search(/acknowledg/i);
  const ackSlice = ackIdx === -1 ? '' : fullText.slice(ackIdx, ackIdx + 1500).replace(/\s+/g, ' ');
  for (const r of docRows) rows.push({ ...r, era: entry.era, degraded: coverageByDoc.get(entry.docId)?.degraded ?? '', ack_slice: r.source === 'certificate' ? '' : ackSlice });
}

writeFileSync(WORKSHEET_JSON, JSON.stringify(rows, null, 2) + '\n');
const header = ['docId', 'name', 'proposed_role', 'on_certificate', 'source', 'era', 'degraded', 'keep', 'true_role', 'is_negative', 'ack_slice'];
const csv = [header.join(',')].concat(
  rows.map((r) => header.map((h) => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')),
).join('\n');
writeFileSync(WORKSHEET_CSV, csv + '\n');
console.log(`Wrote ${rows.length} worksheet rows for ${manifest.length} docs.`);
