import test from 'node:test';
import assert from 'node:assert/strict';
import { BAND_PALETTE } from '../public/app/palette.js';

test('band palette has 15 distinct colours', () => {
  assert.equal(BAND_PALETTE.length, 15);
  for (const c of BAND_PALETTE) assert.match(c, /^#[0-9a-f]{6}$/i);
  assert.equal(new Set(BAND_PALETTE.map((c) => c.toLowerCase())).size, 15);
});
