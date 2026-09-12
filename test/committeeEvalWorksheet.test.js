import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorksheetRows, finalizeGold } from '../scripts/committee-eval/lib/worksheet.mjs';

test('buildWorksheetRows marks off-certificate ack names as negative candidates', () => {
  const rows = buildWorksheetRows('1.0001', {
    committee: [{ name: 'Deirdre Kelly', role: 'Supervisor' }],
    acknowledgement: [{ name: 'Deirdre Kelly', role: 'Supervisor' }, { name: 'My Boss', role: 'Supervisor' }],
    certificatePresent: true,
  });
  const boss = rows.find((r) => r.name === 'My Boss');
  assert.equal(boss.on_certificate, false);
  assert.equal(boss.is_negative, 'Y');
  const kelly = rows.find((r) => r.name === 'Deirdre Kelly' && r.source === 'certificate');
  assert.ok(kelly);
});

test('buildWorksheetRows emits a placeholder row when a doc has no candidates (keeps failure docs visible)', () => {
  const rows = buildWorksheetRows('1.0999', { committee: [], acknowledgement: [], certificatePresent: false });
  assert.equal(rows.length, 1, 'exactly one placeholder row');
  assert.equal(rows[0].docId, '1.0999');
  assert.equal(rows[0].name, '');
  assert.equal(rows[0].source, 'none');
  assert.equal(rows[0].on_certificate, false);
  assert.equal(rows[0].is_negative, '');
});

test('buildWorksheetRows does NOT add a placeholder when candidates exist', () => {
  const rows = buildWorksheetRows('1.0001', {
    committee: [{ name: 'A Person', role: 'Supervisor' }], acknowledgement: [], certificatePresent: true,
  });
  assert.equal(rows.length, 1);
  assert.ok(rows.every((r) => r.source !== 'none'), 'no placeholder alongside real candidates');
});

test('finalizeGold leaves a placeholder-only doc present with empty members/negatives', () => {
  const gold = finalizeGold([
    { docId: '1.0999', name: '', proposed_role: '', keep: '', true_role: '', is_negative: '' },
  ]);
  const d = gold.find((g) => g.docId === '1.0999');
  assert.ok(d, 'doc still represented in gold');
  assert.deepEqual(d.members, []);
  assert.deepEqual(d.negatives, []);
});

test('finalizeGold groups reviewed rows into members and negatives', () => {
  const reviewed = [
    { docId: '1.0001', name: 'Deirdre Kelly', proposed_role: 'Supervisor', keep: 'Y', true_role: '', is_negative: '' },
    { docId: '1.0001', name: 'My Boss', proposed_role: 'Supervisor', keep: 'N', true_role: '', is_negative: 'Y' },
    { docId: '1.0002', name: 'Alice Wong', proposed_role: 'Supervisor', keep: 'Y', true_role: 'Co-Supervisor', is_negative: '' },
  ];
  const gold = finalizeGold(reviewed);
  const d1 = gold.find((g) => g.docId === '1.0001');
  assert.deepEqual(d1.members, [{ name: 'Deirdre Kelly', role: 'Supervisor' }]);
  assert.deepEqual(d1.negatives, ['My Boss']);
  const d2 = gold.find((g) => g.docId === '1.0002');
  assert.deepEqual(d2.members, [{ name: 'Alice Wong', role: 'Co-Supervisor' }]);
});
