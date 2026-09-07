import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreDoc, namesMatch } from '../scripts/committee-eval/lib/match.mjs';

test('namesMatch treats middle-initial and diacritic variants as equal', () => {
  assert.equal(namesMatch('Deirdre M. Kelly', 'Deirdre Kelly'), true);
  assert.equal(namesMatch('José García', 'Jose Garcia'), true);
  assert.equal(namesMatch('Jane Smith', 'John Smith'), false);
});

test('scoreDoc counts name and role hits with name-gated roles', () => {
  const predicted = [
    { name: 'Deirdre M. Kelly', role: 'Supervisor' },
    { name: 'Wrong Person', role: 'Supervisor' },
  ];
  const gold = {
    members: [
      { name: 'Deirdre Kelly', role: 'Supervisor' },
      { name: 'Alice Wong', role: 'Supervisory Committee Member' },
    ],
    negatives: [],
  };
  const s = scoreDoc(predicted, gold);
  assert.equal(s.nameTP, 1);   // Kelly matches
  assert.equal(s.nameFP, 1);   // Wrong Person
  assert.equal(s.nameFN, 1);   // Alice Wong missed
  assert.equal(s.roleTP, 1);   // Kelly role matches
  assert.equal(s.exactCase, false);
});

test('scoreDoc flags negative violations and exactCase', () => {
  const gold = {
    members: [{ name: 'Deirdre Kelly', role: 'Supervisor' }],
    negatives: ['My Boss At Work'],
  };
  const clean = scoreDoc([{ name: 'Deirdre Kelly', role: 'Supervisor' }], gold);
  assert.equal(clean.exactCase, true);
  assert.equal(clean.negativeViolations, 0);

  const dirty = scoreDoc(
    [{ name: 'Deirdre Kelly', role: 'Supervisor' }, { name: 'My Boss At Work', role: 'Supervisor' }],
    gold,
  );
  assert.equal(dirty.negativeViolations, 1);
  assert.equal(dirty.exactCase, false);
});

test('scoreDoc: role-level FP/FN are joint-tuple (over full sets, name-gated TP)', () => {
  const predicted = [
    { name: 'Deirdre M. Kelly', role: 'Supervisor' },       // name+role match
    { name: 'Bob Stranger', role: 'Co-Supervisor' },         // name FP
    { name: 'Ghost Person', role: 'Supervisor' },            // name FP
  ];
  const gold = {
    members: [
      { name: 'Deirdre Kelly', role: 'Supervisor' },         // matched by first predicted, role agrees
      { name: 'Alice Wong', role: 'Supervisory Committee Member' }, // unrecovered
    ],
    negatives: [],
  };
  const s = scoreDoc(predicted, gold);
  assert.equal(s.roleTP, 1);                       // only Kelly/Supervisor is a full tuple match
  assert.equal(s.roleFP, predicted.length - s.roleTP); // = 2
  assert.equal(s.roleFN, gold.members.length - s.roleTP); // = 1
});
