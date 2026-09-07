import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../scripts/committee-eval/lib/reporting.mjs';

test('buildReport separates failure (nocert) from validation (cert) cells', () => {
  const byStratum = {
    'cert:2018plus:clean': { namePrecision: 1, nameRecall: 1, nameF1: 1, rolePrecision: 1, roleRecall: 1, roleF1: 1, exactCaseRate: 1, negativeViolations: 0, docs: 10 },
    'nocert:pre2018:clean': { namePrecision: 0.8, nameRecall: 0.5, nameF1: 0.62, rolePrecision: 0.7, roleRecall: 0.4, roleF1: 0.5, exactCaseRate: 0.3, negativeViolations: 2, docs: 20 },
    'nocert:pre2018:degraded': { namePrecision: 0.6, nameRecall: 0.3, nameF1: 0.4, rolePrecision: 0.5, roleRecall: 0.2, roleF1: 0.3, exactCaseRate: 0.1, negativeViolations: 4, docs: 8 },
  };
  const report = buildReport(byStratum);
  assert.equal(report.validationCells.length, 1);
  assert.equal(report.failureCells.length, 2);
  // worst recall first
  assert.equal(report.failureCells[0].stratumKey, 'nocert:pre2018:degraded');
  assert.match(report.warning, /not be averaged|do not blend|never blend/i);
});
