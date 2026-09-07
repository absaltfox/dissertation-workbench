// Renders results-baseline.json into a console table + report.json.
// Usage: node scripts/committee-eval/report.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildReport } from './lib/reporting.mjs';

const EVAL_DIR = 'data/committee-eval';
const { byStratum } = JSON.parse(readFileSync(path.join(EVAL_DIR, 'results-baseline.json'), 'utf8'));
const report = buildReport(byStratum);

function pct(x) { return `${(x * 100).toFixed(1)}%`; }
function printCells(title, cells) {
  console.log(`\n=== ${title} ===`);
  console.log('stratum'.padEnd(28), 'docs', 'nameP', 'nameR', 'roleR', 'exact', 'negViol');
  for (const c of cells) {
    console.log(
      c.stratumKey.padEnd(28), String(c.docs).padStart(4),
      pct(c.namePrecision), pct(c.nameRecall), pct(c.roleRecall), pct(c.exactCaseRate), String(c.negativeViolations).padStart(4),
    );
  }
}

printCells('FAILURE POPULATION (nocert) — the metric that matters', report.failureCells);
printCells('HARNESS VALIDATION (cert) — do not treat as accuracy', report.validationCells);
console.log(`\n⚠ ${report.warning}`);
writeFileSync(path.join(EVAL_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');
