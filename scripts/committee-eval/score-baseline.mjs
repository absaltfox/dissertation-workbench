// Scores baseline extraction against gold.json using cached full text.
// Usage: node scripts/committee-eval/score-baseline.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseCommittee, parseAcknowledgementsDetailed } from '../../src/pdf.js';
import { scoreDoc } from './lib/match.mjs';
import { extractBaseline, aggregate } from './lib/baseline.mjs';

const EVAL_DIR = 'data/committee-eval';
const TEXT_DIR = path.join(EVAL_DIR, 'fulltext');

const manifest = JSON.parse(readFileSync('test/fixtures/committee-eval/manifest.json', 'utf8'));
const gold = JSON.parse(readFileSync('test/fixtures/committee-eval/gold.json', 'utf8'));
const coverage = existsSync(path.join(EVAL_DIR, 'coverage.json'))
  ? JSON.parse(readFileSync(path.join(EVAL_DIR, 'coverage.json'), 'utf8')) : [];
const goldByDoc = new Map(gold.map((g) => [g.docId, g]));
const manifestByDoc = new Map(manifest.map((m) => [m.docId, m]));
const coverageByDoc = new Map(coverage.map((c) => [c.docId, c]));

const perDoc = [];
const details = [];
for (const g of gold) {
  const entry = manifestByDoc.get(g.docId);
  const textPath = path.join(TEXT_DIR, `${g.docId}.txt`);
  if (!entry || !existsSync(textPath)) continue;
  const fullText = readFileSync(textPath, 'utf8');
  const certificatePresent = /the following individuals certify/i.test(fullText);
  const predicted = extractBaseline(fullText, { parseCommittee, parseAcknowledgementsDetailed });
  const score = scoreDoc(predicted, g);
  const degraded = coverageByDoc.get(g.docId)?.degraded ? 'degraded' : 'clean';
  const stratumKey = `${certificatePresent ? 'cert' : 'nocert'}:${entry.era}:${degraded}`;
  perDoc.push({ stratumKey, score });
  details.push({ docId: g.docId, stratumKey, predicted, score });
}

const byStratum = aggregate(perDoc);
writeFileSync(path.join(EVAL_DIR, 'results-baseline.json'), JSON.stringify({ byStratum, details }, null, 2) + '\n');
console.log(`Scored ${perDoc.length} docs across ${Object.keys(byStratum).length} strata.`);
