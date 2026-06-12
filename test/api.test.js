import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCandidateUrls } from '../src/api.js';

test('collectCandidateUrls preserves source URLs without guessing PDF download URLs', () => {
  const candidates = collectCandidateUrls(
    {
      __oc_index: 'dsp.24-2026-01-01',
      digitalResourceOriginalRecord: 'http://circle.library.ubc.ca/rest/handle/2429/93916?expand=metadata',
      uri: 'https://open.library.ubc.ca/collections/ubctheses/items/1.0451810',
    },
    '1.0451810',
    '10.14288/1.0451810'
  );

  assert.ok(candidates.includes('http://circle.library.ubc.ca/rest/handle/2429/93916?expand=metadata'));
  assert.ok(candidates.includes('https://open.library.ubc.ca/collections/ubctheses/items/1.0451810'));
  assert.equal(candidates.some((url) => url.includes('/media/download/pdf/')), false);
});
