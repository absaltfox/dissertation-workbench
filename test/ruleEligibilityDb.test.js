import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-rule-eligibility-'));
process.env.APP_DATA_DIR = tempDir;
process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'text-cache');
process.env.TURSO_DATABASE_URL = '';

const db = await import('../src/db.js');

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('completed rule projections union live policy without exposing partial generations', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ids = [`elig-a-${suffix}`, `elig-b-${suffix}`, `elig-c-${suffix}`];
  for (const id of ids) await db.saveDocumentMetadata({ id, title: id });
  const legacyDegree = `Pre-activation legacy ${suffix}`;
  const legacyDocId = `pre-activation-legacy-${suffix}`;
  await db.saveDocumentMetadata({ id: legacyDocId, title: legacyDocId, degree: legacyDegree });
  await db.saveFileMetric(legacyDocId, {
    status: 'streamed', contentSource: 'streamed_pdf', contentChecksum: 'legacy-v1',
  });
  const citationRule = await db.saveImportRule({
    id: `citation-${suffix}`, name: 'Citation membership',
    extractCitations: true, runConcepts: false,
  });
  const patternRule = await db.saveImportRule({
    id: `pattern-${suffix}`, name: 'PatternRank membership',
    extractCitations: false, runConcepts: true,
  });

  // A superseded generation cannot cross the one-way activation boundary.
  const staleInitialToken = await db.beginImportRuleEligibilityProjection(citationRule.id);
  await db.projectImportRuleEligibilityBatch(citationRule.id, staleInitialToken, [ids[0]]);
  const replacementInitialToken = await db.beginImportRuleEligibilityProjection(citationRule.id);
  await assert.rejects(
    db.finalizeImportRuleEligibilityProjection(citationRule.id, staleInitialToken),
    /not current/
  );
  const initialClient = await db.getDb();
  const inactive = await initialClient.execute('SELECT activated_at FROM processing_eligibility_activation WHERE id = 1');
  assert.equal(inactive.rows.length, 0);
  await db.abortImportRuleEligibilityProjection(citationRule.id, replacementInitialToken);

  const citationToken = await db.beginImportRuleEligibilityProjection(citationRule.id);
  await db.projectImportRuleEligibilityBatch(citationRule.id, citationToken, [ids[0]]);
  await db.projectImportRuleEligibilityBatch(citationRule.id, citationToken, [ids[1]]);
  await db.finalizeImportRuleEligibilityProjection(citationRule.id, citationToken);
  const activationAfterFirst = await initialClient.execute(
    'SELECT activated_at FROM processing_eligibility_activation WHERE id = 1'
  );
  assert.equal(activationAfterFirst.rows.length, 0);
  assert.deepEqual(
    (await db.listPendingCitationScans({ filters: { degree: legacyDegree } })).map((row) => row.doc_id),
    [legacyDocId]
  );

  const patternToken = await db.beginImportRuleEligibilityProjection(patternRule.id);
  await db.projectImportRuleEligibilityBatch(patternRule.id, patternToken, [ids[1], ids[2]]);
  await db.finalizeImportRuleEligibilityProjection(patternRule.id, patternToken);
  const activationAfterSecond = await initialClient.execute(
    'SELECT activated_at FROM processing_eligibility_activation WHERE id = 1'
  );
  assert.equal(activationAfterSecond.rows.length, 1);
  assert.deepEqual(await db.listPendingCitationScans({ filters: { degree: legacyDegree } }), []);

  assert.deepEqual(await db.listEffectiveDocumentEligibility({ docIds: ids }), [
    { docId: ids[0], citationEligible: true, patternRankEligible: false, matchingRuleCount: 1 },
    { docId: ids[1], citationEligible: true, patternRankEligible: true, matchingRuleCount: 2 },
    { docId: ids[2], citationEligible: false, patternRankEligible: true, matchingRuleCount: 1 },
  ]);

  // Saved policy is authoritative: a toggle applies to every published
  // membership immediately, without re-projecting or overriding another rule.
  await db.saveImportRule({ ...citationRule, extractCitations: false });
  const afterToggle = await db.listEffectiveDocumentEligibility({ docIds: ids });
  assert.equal(afterToggle[0].citationEligible, false);
  assert.equal(afterToggle[1].patternRankEligible, true);

  // A new, incomplete generation remains invisible and abort restores the
  // previously completed generation without reconstructing its document IDs.
  const partialToken = await db.beginImportRuleEligibilityProjection(patternRule.id);
  await db.projectImportRuleEligibilityBatch(patternRule.id, partialToken, [ids[0]]);
  assert.deepEqual(
    (await db.listEffectiveDocumentEligibility({ docIds: ids })).map((row) => row.docId),
    ids
  );
  assert.equal(await db.abortImportRuleEligibilityProjection(patternRule.id, partialToken), true);
  assert.equal((await db.listEffectiveDocumentEligibility({ docIds: ids }))[2].patternRankEligible, true);

  const supersededToken = await db.beginImportRuleEligibilityProjection(patternRule.id);
  await db.projectImportRuleEligibilityBatch(patternRule.id, supersededToken, [ids[0]]);
  const winningToken = await db.beginImportRuleEligibilityProjection(patternRule.id);
  const client = await db.getDb();
  const activationBefore = await client.execute('SELECT activated_at FROM processing_eligibility_activation WHERE id = 1');
  await assert.rejects(
    db.finalizeImportRuleEligibilityProjection(patternRule.id, supersededToken),
    /not current/
  );
  const activationAfter = await client.execute('SELECT activated_at FROM processing_eligibility_activation WHERE id = 1');
  assert.equal(activationAfter.rows[0].activated_at, activationBefore.rows[0].activated_at);
  await db.abortImportRuleEligibilityProjection(patternRule.id, winningToken);
  assert.equal((await db.listEffectiveDocumentEligibility({ docIds: ids }))[2].patternRankEligible, true);

  // A successfully completed replacement authoritatively removes documents not
  // seen in the new token, while another rule's membership remains independent.
  const replacementToken = await db.beginImportRuleEligibilityProjection(patternRule.id);
  await db.projectImportRuleEligibilityBatch(patternRule.id, replacementToken, [ids[0]]);
  await db.finalizeImportRuleEligibilityProjection(patternRule.id, replacementToken);
  assert.deepEqual(await db.listEffectiveDocumentEligibility({ docIds: ids }), [
    { docId: ids[0], citationEligible: false, patternRankEligible: true, matchingRuleCount: 2 },
    { docId: ids[1], citationEligible: false, patternRankEligible: false, matchingRuleCount: 1 },
  ]);
});

test('projection finalization atomically aborts when rule scope changes after begin', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const originalDocId = `scope-original-${suffix}`;
  const replacementDocId = `scope-replacement-${suffix}`;
  await db.saveDocumentMetadata({ id: originalDocId, title: originalDocId });
  await db.saveDocumentMetadata({ id: replacementDocId, title: replacementDocId });
  const rule = await db.saveImportRule({
    id: `scope-rule-${suffix}`,
    name: 'Scope revision guard',
    degree: `Original degree ${suffix}`,
    extractCitations: true,
    runConcepts: false,
  });

  const publishedToken = await db.beginImportRuleEligibilityProjection(rule.id);
  await db.projectImportRuleEligibilityBatch(rule.id, publishedToken, [originalDocId]);
  await db.finalizeImportRuleEligibilityProjection(rule.id, publishedToken);

  const staleToken = await db.beginImportRuleEligibilityProjection(rule.id);
  await db.projectImportRuleEligibilityBatch(rule.id, staleToken, [replacementDocId]);
  const changedRule = await db.saveImportRule({
    ...rule,
    degree: `Changed degree ${suffix}`,
  });
  await assert.rejects(
    db.finalizeImportRuleEligibilityProjection(rule.id, staleToken),
    /rule scope changed/
  );

  const client = await db.getDb();
  const projection = await client.execute({
    sql: `SELECT current_token, completed_token, status
          FROM import_rule_eligibility_projections WHERE rule_id = ?`,
    args: [rule.id],
  });
  assert.equal(projection.rows[0].current_token, null);
  assert.equal(projection.rows[0].completed_token, publishedToken);
  assert.equal(projection.rows[0].status, 'aborted');
  const staged = await client.execute({
    sql: `SELECT doc_id FROM rule_document_processing_eligibility
          WHERE rule_id = ? AND projection_token = ?`,
    args: [rule.id, staleToken],
  });
  assert.equal(staged.rows.length, 0);
  assert.deepEqual(await db.listEffectiveDocumentEligibility({
    docIds: [originalDocId, replacementDocId],
  }), [
    {
      docId: originalDocId,
      citationEligible: true,
      patternRankEligible: false,
      matchingRuleCount: 1,
    },
  ]);

  // Citation and PatternRank are live processing policy, not matching scope.
  // Changing only those flags must not invalidate a scan already in progress.
  const policyToken = await db.beginImportRuleEligibilityProjection(rule.id);
  await db.projectImportRuleEligibilityBatch(rule.id, policyToken, [replacementDocId]);
  await db.saveImportRule({
    ...changedRule,
    extractCitations: false,
    runConcepts: true,
  });
  assert.equal(
    await db.finalizeImportRuleEligibilityProjection(rule.id, policyToken),
    true
  );
  assert.deepEqual(await db.listEffectiveDocumentEligibility({
    docIds: [originalDocId, replacementDocId],
  }), [
    {
      docId: replacementDocId,
      citationEligible: false,
      patternRankEligible: true,
      matchingRuleCount: 1,
    },
  ]);
});

test('eligible processing queries distinguish pending, failed, completed, and stale records', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const docId = `queue-${suffix}`;
  await db.saveDocumentMetadata({ id: docId, title: 'Processing queue fixture' });
  await db.saveFileMetric(docId, { contentChecksum: 'content-v1', status: 'downloaded' });
  const rule = await db.saveImportRule({
    id: `queue-rule-${suffix}`, name: 'Queue membership', runConcepts: true,
  });
  const token = await db.beginImportRuleEligibilityProjection(rule.id);
  await db.projectImportRuleEligibilityBatch(rule.id, token, [docId]);
  await db.finalizeImportRuleEligibilityProjection(rule.id, token);

  let rows = await db.listEligibleDocumentsForProcessing({ processor: 'patternrank', status: 'pending' });
  assert.equal(rows.some((row) => row.doc_id === docId && row.queue_status === 'pending'), true);

  await db.saveDocumentProcessingState(docId, 'patternrank', {
    status: 'failed', contentChecksum: 'content-v1', processorVersion: 'patternrank-v1', error: 'boom',
  });
  rows = await db.listEligibleDocumentsForProcessing({ processor: 'patternrank', status: 'failed' });
  assert.equal(rows.some((row) => row.doc_id === docId && row.error === 'boom'), true);

  await db.saveDocumentProcessingState(docId, 'patternrank', {
    status: 'completed', contentChecksum: 'content-v1', processorVersion: 'patternrank-v1',
  });
  rows = await db.listEligibleDocumentsForProcessing({
    processor: 'patternrank', status: 'completed', processorVersion: 'patternrank-v1',
  });
  assert.equal(rows.some((row) => row.doc_id === docId), true);

  await db.saveFileMetric(docId, { contentChecksum: 'content-v2', status: 'downloaded' });
  rows = await db.listEligibleDocumentsForProcessing({
    processor: 'patternrank', status: 'stale', processorVersion: 'patternrank-v1',
  });
  assert.equal(rows.some((row) => row.doc_id === docId && row.queue_status === 'stale'), true);
});

test('citation selectors enforce published eligibility and stream newly eligible metadata-only records', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const degree = `Eligibility Citation ${suffix}`;
  const ids = {
    metadata: `citation-metadata-${suffix}`,
    overlap: `citation-overlap-${suffix}`,
    disabled: `citation-disabled-${suffix}`,
    completed: `citation-completed-${suffix}`,
    failed: `citation-failed-${suffix}`,
    cached: `citation-cached-${suffix}`,
    cachedDisabled: `citation-cached-disabled-${suffix}`,
  };
  for (const id of Object.values(ids)) {
    await db.saveDocumentMetadata({ id, title: id, degree, supervisors: [] });
  }
  await db.saveFileMetric(ids.cached, {
    fullTextPath: `/cached/${ids.cached}.txt`, contentChecksum: 'cached-v1', status: 'full_text',
  });
  await db.saveFileMetric(ids.cachedDisabled, {
    fullTextPath: `/cached/${ids.cachedDisabled}.txt`, contentChecksum: 'cached-disabled-v1', status: 'full_text',
  });

  const enabledRule = await db.saveImportRule({
    id: `citation-enabled-${suffix}`, name: 'Citation enabled', extractCitations: true,
  });
  const disabledRule = await db.saveImportRule({
    id: `citation-disabled-rule-${suffix}`, name: 'Citation disabled', extractCitations: false,
  });
  const enabledToken = await db.beginImportRuleEligibilityProjection(enabledRule.id);
  await db.projectImportRuleEligibilityBatch(enabledRule.id, enabledToken, [
    ids.metadata, ids.overlap, ids.completed, ids.failed, ids.cached,
  ]);
  await db.finalizeImportRuleEligibilityProjection(enabledRule.id, enabledToken);
  const disabledToken = await db.beginImportRuleEligibilityProjection(disabledRule.id);
  await db.projectImportRuleEligibilityBatch(disabledRule.id, disabledToken, [
    ids.overlap, ids.disabled, ids.cachedDisabled,
  ]);
  await db.finalizeImportRuleEligibilityProjection(disabledRule.id, disabledToken);

  await db.saveCitationExtractionState(ids.completed, { status: 'completed', parserVersion: 'citation-v2' });
  await db.saveCitationExtractionState(ids.failed, {
    status: 'failed', parserVersion: 'citation-v2', error: 'expected failure',
  });

  const scanIds = async (options = {}) => (await db.listPendingCitationScans({
    limit: 50, filters: { degree }, ...options,
  })).map((row) => row.doc_id).sort();
  assert.deepEqual(await scanIds(), [ids.cached, ids.metadata, ids.overlap].sort());
  assert.equal(await db.countPendingCitationScans({ filters: { degree } }), 3);
  assert.deepEqual(
    await scanIds({ retryFailures: true }),
    [ids.cached, ids.failed, ids.metadata, ids.overlap].sort()
  );
  assert.deepEqual(
    await scanIds({ reprocess: true }),
    [ids.cached, ids.completed, ids.failed, ids.metadata, ids.overlap].sort()
  );

  // Scoping to the disabled rule limits membership provenance, while effective
  // eligibility remains a union: only its overlap with the enabled rule runs.
  assert.deepEqual(await scanIds({ eligibilityRuleIds: [disabledRule.id] }), [ids.overlap]);

  const cached = await db.listPendingCitationExtractions({
    limit: 50, filters: { degree }, parserVersion: 'citation-v2',
  });
  assert.deepEqual(cached.map((row) => row.doc_id), [ids.cached]);
});

test('deleting the last projected rule never restores legacy corpus-wide citation selection', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const degree = `Post-activation legacy ${suffix}`;
  const docId = `post-activation-legacy-${suffix}`;
  await db.saveDocumentMetadata({ id: docId, title: docId, degree, supervisors: [] });
  await db.saveFileMetric(docId, {
    status: 'streamed', contentSource: 'streamed_pdf', contentChecksum: 'legacy-stream-v1',
  });

  for (const rule of await db.listImportRules()) await db.deleteImportRule(rule.id);
  const client = await db.getDb();
  const activation = await client.execute('SELECT activated_at FROM processing_eligibility_activation WHERE id = 1');
  assert.equal(activation.rows.length, 1);
  assert.deepEqual(await db.listEffectiveDocumentEligibility(), []);
  assert.deepEqual(await db.listPendingCitationScans({ limit: 10, filters: { degree } }), []);
  assert.equal(await db.countPendingCitationScans({ filters: { degree } }), 0);
});
