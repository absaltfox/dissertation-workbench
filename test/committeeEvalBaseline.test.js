import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBaseline, aggregate } from '../scripts/committee-eval/lib/baseline.mjs';

test('extractBaseline falls back to acknowledgements only when no supervisor in committee', () => {
  const fakeCommittee = () => [{ name: 'Al Examiner', role: 'University Examiner' }];
  const fakeAck = () => ({ members: [{ name: 'Deirdre Kelly', role: 'Supervisor' }] });
  const out = extractBaseline('irrelevant', { parseCommittee: fakeCommittee, parseAcknowledgementsDetailed: fakeAck });
  assert.deepEqual(out, [
    { name: 'Al Examiner', role: 'University Examiner' },
    { name: 'Deirdre Kelly', role: 'Supervisor' },
  ]);
});

test('extractBaseline skips acknowledgements when committee already has a supervisor', () => {
  const fakeCommittee = () => [{ name: 'Deirdre Kelly', role: 'Supervisor' }];
  const fakeAck = () => { throw new Error('should not be called'); };
  const out = extractBaseline('x', { parseCommittee: fakeCommittee, parseAcknowledgementsDetailed: fakeAck });
  assert.equal(out.length, 1);
});

test('extractBaseline gates ack non-supervisors on empty committee', () => {
  const ack = () => ({ members: [
    { name: 'Ack Super', role: 'Supervisor' },
    { name: 'Ack Other', role: 'Supervisory Committee Member' },
  ]});
  // Committee has examiners but NO supervisor -> ack supervisors merged, ack others DROPPED
  const withExaminers = extractBaseline('x', {
    parseCommittee: () => [{ name: 'Cert Examiner', role: 'University Examiner' }],
    parseAcknowledgementsDetailed: ack,
  });
  assert.deepEqual(withExaminers.map((m) => m.name), ['Cert Examiner', 'Ack Super']);
  // Empty committee -> ack supervisors AND ack others merged
  const emptyCommittee = extractBaseline('x', {
    parseCommittee: () => [],
    parseAcknowledgementsDetailed: ack,
  });
  assert.deepEqual(emptyCommittee.map((m) => m.name), ['Ack Super', 'Ack Other']);
});

test('aggregate computes precision/recall per stratum', () => {
  const perDoc = [
    { stratumKey: 'core:pre2018', score: { nameTP: 1, nameFP: 1, nameFN: 0, roleTP: 1, roleFP: 1, roleFN: 0, exactCase: false, negativeViolations: 1 } },
    { stratumKey: 'core:pre2018', score: { nameTP: 1, nameFP: 0, nameFN: 1, roleTP: 1, roleFP: 0, roleFN: 1, exactCase: false, negativeViolations: 0 } },
  ];
  const agg = aggregate(perDoc)['core:pre2018'];
  assert.equal(agg.docs, 2);
  assert.equal(agg.namePrecision, 2 / 3); // TP=2, FP=1
  assert.equal(agg.nameRecall, 2 / 3);    // TP=2, FN=1
  assert.equal(agg.negativeViolations, 1);
});
