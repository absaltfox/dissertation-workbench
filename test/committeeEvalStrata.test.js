// test/committeeEvalStrata.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEra, buildManifestEntry, selectSample } from '../scripts/committee-eval/lib/strata.mjs';

test('classifyEra splits on 2018', () => {
  assert.equal(classifyEra(2010), 'pre2018');
  assert.equal(classifyEra(2018), '2018plus');
  assert.equal(classifyEra(undefined), 'pre2018');
});

test('buildManifestEntry derives era and certificate guess', () => {
  const e = buildManifestEntry('1.0001', {
    degree: 'MA (Plan)', program: 'Planning', year: 2012,
    title: 'T', author: 'A', originalRecordUrl: 'https://circle.library.ubc.ca/rest/handle/1/2',
  });
  assert.equal(e.era, 'pre2018');
  assert.equal(e.certificateSignalGuess, false);
  assert.equal(e.degree, 'MA (Plan)');
});

test('selectSample oversamples the target degrees and caps reference', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) {
    entries.push(buildManifestEntry(`c${i}`, { degree: 'MA (Plan)', program: 'P', year: 2010, title: 't', author: 'a', originalRecordUrl: 'u' }));
  }
  for (let i = 0; i < 30; i++) {
    entries.push(buildManifestEntry(`r${i}`, { degree: 'MA (Plan)', program: 'P', year: 2020, title: 't', author: 'a', originalRecordUrl: 'u' }));
  }
  entries.push(buildManifestEntry('x', { degree: 'PhD Chemistry', program: 'Chem', year: 2019, title: 't', author: 'a', originalRecordUrl: 'u' }));
  const { manifest, counts } = selectSample(entries, { degrees: ['MA (Plan)'], targetCore: 10, perReference: 5 });
  assert.equal(counts.core, 10);
  assert.equal(counts.reference, 5);
  assert.equal(manifest.length, 15);
  assert.ok(manifest.every((m) => m.degree === 'MA (Plan)'));
});
