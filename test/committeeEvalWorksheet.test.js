import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorksheetRows, finalizeGold } from '../scripts/committee-eval/lib/worksheet.mjs';

test('buildWorksheetRows: when the certificate already names a supervisor, the ack path is NOT surfaced (mirrors production gating)', () => {
  const rows = buildWorksheetRows('1.0001', {
    committee: [{ name: 'Deirdre Kelly', role: 'Supervisor' }],
    acknowledgement: [{ name: 'Deirdre Kelly', role: 'Supervisor' }, { name: 'My Boss', role: 'Supervisor' }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'certificate');
  assert.equal(rows[0].name, 'Deirdre Kelly');
  assert.ok(!rows.some((r) => r.source === 'acknowledgement'), 'no ack rows when the cert page has a supervisor');
});

test('buildWorksheetRows: ack IS surfaced when the committee has no supervisor, and is not auto-flagged negative', () => {
  // certificate-absent doc (empty committee) — the failure population
  const rows = buildWorksheetRows('1.0002', {
    committee: [],
    acknowledgement: [{ name: 'Jane Advisor', role: 'Supervisor' }],
  });
  const ack = rows.find((r) => r.source === 'acknowledgement');
  assert.ok(ack, 'ack candidate surfaced');
  assert.equal(ack.name, 'Jane Advisor');
  assert.equal(ack.is_negative, '', 'surfaced ack candidates are not pre-flagged as negatives (human decides)');
});

test('buildWorksheetRows: examiners-only certificate (no supervisor) still consults ack for the missing supervisor', () => {
  const rows = buildWorksheetRows('1.0003', {
    committee: [{ name: 'Ex Aminer', role: 'University Examiner' }],
    acknowledgement: [{ name: 'Real Super', role: 'Supervisor' }],
  });
  assert.ok(rows.some((r) => r.source === 'certificate' && r.name === 'Ex Aminer'));
  assert.ok(rows.some((r) => r.source === 'acknowledgement' && r.name === 'Real Super'));
});

test('buildWorksheetRows: ack name matching a certificate member is de-duped (not repeated)', () => {
  const rows = buildWorksheetRows('1.0004', {
    committee: [{ name: 'Al Examiner', role: 'University Examiner' }], // no supervisor → ack consulted
    acknowledgement: [{ name: 'Al Examiner', role: 'University Examiner' }, { name: 'New Name', role: 'Supervisor' }],
  });
  assert.equal(rows.filter((r) => r.name === 'Al Examiner').length, 1, 'Al Examiner appears once (certificate row)');
  assert.ok(rows.some((r) => r.source === 'acknowledgement' && r.name === 'New Name'));
});

test('buildWorksheetRows emits a placeholder row when a doc has no candidates (keeps failure docs visible)', () => {
  const rows = buildWorksheetRows('1.0999', { committee: [], acknowledgement: [] });
  assert.equal(rows.length, 1, 'exactly one placeholder row');
  assert.equal(rows[0].docId, '1.0999');
  assert.equal(rows[0].name, '');
  assert.equal(rows[0].source, 'none');
  assert.equal(rows[0].on_certificate, false);
  assert.equal(rows[0].is_negative, '');
});

test('buildWorksheetRows does NOT add a placeholder when candidates exist', () => {
  const rows = buildWorksheetRows('1.0001', {
    committee: [{ name: 'A Person', role: 'Supervisor' }], acknowledgement: [],
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
