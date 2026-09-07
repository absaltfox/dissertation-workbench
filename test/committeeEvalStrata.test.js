// test/committeeEvalStrata.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEra, buildManifestEntry, selectSample } from '../scripts/committee-eval/lib/strata.mjs';

const mk = (id, degree, program, year) => buildManifestEntry(id, {
  degree, program, year, title: 't', author: 'a', originalRecordUrl: 'u',
});

test('classifyEra splits on 2018', () => {
  assert.equal(classifyEra(2010), 'pre2018');
  assert.equal(classifyEra(2018), '2018plus');
  assert.equal(classifyEra(undefined), 'pre2018');
});

test('buildManifestEntry derives era', () => {
  const e = buildManifestEntry('1.0001', {
    degree: 'MA (Plan)', program: 'Planning', year: 2012,
    title: 'T', author: 'A', originalRecordUrl: 'https://circle.library.ubc.ca/rest/handle/1/2',
  });
  assert.equal(e.era, 'pre2018');
  assert.equal(e.degree, 'MA (Plan)');
  assert.equal(e.program, 'Planning');
});

test('selectSample matches degree+program targets and excludes other programs of the same degree', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) entries.push(mk(`hist-${i}`, 'Master of Arts - MA', 'History', 2010));
  for (let i = 0; i < 10; i++) entries.push(mk(`eng-${i}`, 'Master of Arts - MA', 'English', 2010)); // same degree, different program
  for (let i = 0; i < 10; i++) entries.push(mk(`plan-${i}`, 'Master of Arts in Planning - MA (Plan)', 'Planning', 2010));
  const { manifest } = selectSample(entries, {
    targets: [
      { degree: 'Master of Arts - MA', program: 'History' },
      { degree: 'Master of Arts in Planning - MA (Plan)', program: null }, // degree-only match
    ],
    perEra: 5,
  });
  assert.ok(manifest.some((m) => m.program === 'History'), 'History docs selected');
  assert.ok(!manifest.some((m) => m.program === 'English'), 'English (same degree) excluded');
  assert.ok(manifest.some((m) => m.degree.includes('MA (Plan)')), 'MA (Plan) matched by degree-only target');
  assert.equal(manifest.filter((m) => m.program === 'History').length, 5, 'History capped at perEra');
});

test('selectSample fills per-era quotas per target (both eras represented)', () => {
  const entries = [];
  for (let i = 0; i < 20; i++) entries.push(mk(`old-${i}`, 'D', 'P', 2005));
  for (let i = 0; i < 20; i++) entries.push(mk(`new-${i}`, 'D', 'P', 2020));
  const { manifest, counts } = selectSample(entries, { targets: [{ degree: 'D', program: null }], perEra: 8 });
  assert.equal(manifest.filter((m) => m.era === 'pre2018').length, 8);
  assert.equal(manifest.filter((m) => m.era === '2018plus').length, 8);
  assert.equal(counts.total, 16);
});

test('selectSample yields fewer than the quota when a cell is underpopulated', () => {
  const entries = [];
  for (let i = 0; i < 3; i++) entries.push(mk(`old-${i}`, 'D', 'P', 2005)); // only 3 pre-2018, none 2018+
  const { manifest, counts } = selectSample(entries, { targets: [{ degree: 'D', program: null }], perEra: 10 });
  assert.equal(manifest.filter((m) => m.era === 'pre2018').length, 3);
  assert.equal(manifest.filter((m) => m.era === '2018plus').length, 0);
  assert.equal(counts.total, 3);
});

test('selectSample is deterministic and decorrelated from input order', () => {
  const base = [];
  for (let i = 0; i < 30; i++) base.push(mk(`core-${i}`, 'D', 'P', 2010));
  const opts = { targets: [{ degree: 'D', program: null }], perEra: 10 };
  const a = selectSample(base, opts).manifest.map((m) => m.docId).sort();
  const b = selectSample([...base].reverse(), opts).manifest.map((m) => m.docId).sort();
  assert.deepEqual(a, b, 'same docIds selected regardless of input order (deterministic)');
  const firstTen = base.slice(0, 10).map((m) => m.docId).sort();
  assert.notDeepEqual(a, firstTen, 'selection is not just the first-N in input order');
});

test('selectSample dedupes a doc that matches two overlapping targets', () => {
  const entries = [mk('d1', 'Master of Arts - MA', 'History', 2010)];
  const { manifest } = selectSample(entries, {
    targets: [
      { degree: 'Master of Arts - MA', program: null },      // matches by degree
      { degree: 'Master of Arts - MA', program: 'History' }, // also matches
    ],
    perEra: 5,
  });
  assert.equal(manifest.length, 1, 'doc counted once despite matching two targets');
});
