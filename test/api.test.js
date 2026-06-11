import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCandidateUrls } from '../src/api.js';

test('collectCandidateUrls tries a wider range of Open Collections PDF file numbers', () => {
  const candidates = collectCandidateUrls(
    { __oc_index: 'dsp.24-2026-01-01' },
    '1.0451810',
    '10.14288/1.0451810'
  );

  assert.ok(candidates.includes('https://open.library.ubc.ca/media/download/pdf/24/1.0451810/1'));
  assert.ok(candidates.includes('https://open.library.ubc.ca/media/download/pdf/24/1.0451810/4'));
  assert.ok(candidates.includes('https://open.library.ubc.ca/media/download/pdf/24/1.0451810/10'));
});
