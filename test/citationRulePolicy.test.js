import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-citation-rule-policy-'));
process.env.APP_DATA_DIR = tempDir;
process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'text-cache');
process.env.TURSO_DATABASE_URL = '';

const db = await import('../src/db.js');
const {
  citationContentPolicy,
  reserveCitationPolicyRequest,
} = await import('../src/services/importPdfJobRunner.js');

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('overlapping citation policies use the tightest byte ceiling and reserve every positive rate', () => {
  assert.deepEqual(citationContentPolicy([
    { ruleId: 'roomy', maxContentBytes: 80_000_000, contentRateLimit: 30 },
    { ruleId: 'tight', maxContentBytes: 12_000_000, contentRateLimit: 5 },
    { ruleId: 'unlimited', maxContentBytes: 25_000_000, contentRateLimit: 0 },
  ]), {
    maxContentBytes: 12_000_000,
    rateLimits: [
      { ruleId: 'tight', contentRateLimit: 5 },
      { ruleId: 'roomy', contentRateLimit: 30 },
    ],
  });
  assert.deepEqual(citationContentPolicy([]), {
    maxContentBytes: 200 * 1024 * 1024,
    rateLimits: [],
  });
});

test('citation request gate waits and retries each applicable durable rule limiter', async () => {
  const calls = [];
  const waits = [];
  let tightAttempts = 0;
  await reserveCitationPolicyRequest([
    { ruleId: 'tight', contentRateLimit: 5 },
    { ruleId: 'roomy', contentRateLimit: 30 },
  ], {
    now: () => 12_345,
    windowMs: 777,
    reserveSlot: async (ruleId, limit, options) => {
      calls.push({ ruleId, limit, options });
      if (ruleId === 'tight' && tightAttempts++ === 0) return 25;
      return 0;
    },
    wait: async (delayMs) => { waits.push(delayMs); },
  });

  assert.deepEqual(waits, [25]);
  assert.deepEqual(calls.map(({ ruleId, limit }) => [ruleId, limit]), [
    ['tight', 5], ['tight', 5], ['roomy', 30],
  ]);
  assert.ok(calls.every(({ options }) => options.nowMs === 12_345 && options.windowMs === 777));
});

test('effective citation policies follow completed overlapping memberships and live toggles', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const docId = `citation-policy-doc-${suffix}`;
  await db.saveDocumentMetadata({ id: docId, title: docId });
  const roomy = await db.saveImportRule({
    id: `roomy-${suffix}`,
    name: 'Roomy citation policy',
    extractCitations: true,
    runConcepts: false,
    maxContentBytes: 80_000_000,
    contentRateLimit: 30,
  });
  const tight = await db.saveImportRule({
    id: `tight-${suffix}`,
    name: 'Tight citation policy',
    extractCitations: true,
    runConcepts: false,
    maxContentBytes: 12_000_000,
    contentRateLimit: 5,
  });
  for (const rule of [roomy, tight]) {
    const token = await db.beginImportRuleEligibilityProjection(rule.id);
    await db.projectImportRuleEligibilityBatch(rule.id, token, [docId]);
    await db.finalizeImportRuleEligibilityProjection(rule.id, token);
  }

  assert.deepEqual(await db.listEffectiveCitationPoliciesForDocument(docId), [
    { ruleId: roomy.id, maxContentBytes: 80_000_000, contentRateLimit: 30 },
    { ruleId: tight.id, maxContentBytes: 12_000_000, contentRateLimit: 5 },
  ].sort((left, right) => left.ruleId.localeCompare(right.ruleId)));

  await db.saveImportRule({ ...tight, extractCitations: false });
  assert.deepEqual(await db.listEffectiveCitationPoliciesForDocument(docId), [
    { ruleId: roomy.id, maxContentBytes: 80_000_000, contentRateLimit: 30 },
  ]);
});
