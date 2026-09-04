import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  deriveAccessState, isEmbargoDeferred, isEmbargoPlaceholder, parseAvailabilityDate,
} from '../src/accessStatus.js';
import { buildMetricsPayloadFromRecords, normalizeRecord } from '../src/metrics.js';
import { analyzeDocumentFile } from '../src/pdf.js';

let tempDir;
let db;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-embargo-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.NODE_ENV = 'test';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('normalization separates repository availability from bibliographic date and suppresses embargo text', () => {
  const record = normalizeRecord({
    id: 'embargo-normalized',
    title: 'A thesis under embargo',
    creator: 'Researcher',
    ubc_date_sort: '2024',
    date_available: '2099-09-30',
    description: 'The full text will become available when the embargo expires.',
    subject: ['History'],
  });

  assert.equal(record.year, 2024);
  assert.equal(record.date, '2024');
  assert.equal(record.accessStatus, 'embargoed');
  assert.equal(record.availableAt, '2099-09-30T00:00:00.000Z');
  assert.equal(record.abstract, '');
  assert.match(record.rawAbstract, /embargo expires/);
  assert.deepEqual(record.conceptTerms, []);
  assert.deepEqual(record.methodologies, []);
  assert.equal(record.pages, null);
  assert.equal(record.wordCount, null);
});

test('embargo detection is conservative and elapsed dates reopen only for verification', () => {
  assert.equal(isEmbargoPlaceholder('This study analyzes newspaper embargo policy and public access.'), false);
  assert.equal(
    isEmbargoPlaceholder('This thesis examines when full-text archives become available after governments lift embargo restrictions.'),
    false,
    'scholarly discussion of embargoes is not a repository access notice'
  );
  assert.equal(
    isEmbargoPlaceholder('The full abstract for this thesis is available in the body of the thesis, and will be available when the embargo expires.'),
    true,
    'the exact UBC embargo placeholder is recognized'
  );
  assert.equal(deriveAccessState({ description: 'PDF missing from repository' }).accessStatus, 'unknown');

  const elapsed = deriveAccessState({
    date_available: '2020-01-01',
    description: 'The full text will become available when the embargo expires.',
  }, { now: new Date('2026-01-01T00:00:00.000Z') });
  assert.equal(elapsed.accessStatus, 'verification_due');
  assert.equal(elapsed.accessStatusReason, 'availability_date_reached_pending_verification');
  assert.equal(isEmbargoDeferred(elapsed, new Date('2026-01-01T00:00:00.000Z')), false);
});

test('availability parsing rejects calendar rollover and preserves timestamp instants', () => {
  assert.equal(parseAvailabilityDate('2026-02-30'), null);
  assert.equal(parseAvailabilityDate('2025-02-29'), null);
  assert.equal(parseAvailabilityDate('2026-02-28T24:00:00Z'), null);
  assert.equal(parseAvailabilityDate('2026-09-30T07:60:00Z'), null);
  assert.equal(parseAvailabilityDate('2026-09-30T07:00:00+24:00'), null);
  assert.equal(parseAvailabilityDate('2024-02-29'), '2024-02-29T00:00:00.000Z');
  assert.equal(
    parseAvailabilityDate('2026-09-30T07:00:00-07:00'),
    '2026-09-30T14:00:00.000Z'
  );
  assert.equal(
    deriveAccessState({ date_available: '2026-09-30T07:00:00Z' }, {
      now: new Date('2026-09-30T06:59:59.999Z'),
    }).accessStatus,
    'embargoed'
  );
});

test('the file processor defers an active embargo without making repository requests', async () => {
  const doc = {
    id: 'processor-embargo', accessStatus: 'embargoed',
    availableAt: '2099-01-01T00:00:00.000Z',
  };
  let requests = 0;
  await analyzeDocumentFile(doc, {
    contentMode: 'pdf_stream', downloadFiles: true,
    onContentRequest: () => { requests += 1; },
  });
  assert.equal(requests, 0);
  assert.equal(doc.downloadStatus, 'deferred_embargo');
  assert.equal(doc.downloadError, null);
});

test('embargoed documents stay catalogued but leave enrichment, processing, citation, and analytics corpora', async () => {
  const syncKey = `embargo-${Date.now()}`;
  const available = {
    id: `${syncKey}-available`, title: 'Available thesis', author: 'A', year: 2024,
    degree: 'MA', program: 'History', abstract: 'An ordinary historical study with archival research.',
    subjects: ['History'], conceptTerms: ['archival research'], methodologies: ['Archival Research'],
    themes: ['history'], charCount: 55, accessStatus: 'unknown', supervisors: ['Available Supervisor'],
  };
  const embargoed = {
    id: `${syncKey}-embargoed`, title: 'Embargoed thesis', author: 'B', year: 2024,
    degree: 'MA', program: 'History', abstract: 'The full text will become available when the embargo expires.',
    rawAbstract: 'The full text will become available when the embargo expires.',
    subjects: ['History'], conceptTerms: ['embargo ends'], methodologies: ['Interview'],
    themes: ['embargo'], charCount: 70, accessStatus: 'embargoed',
    availableAt: '2099-09-30T00:00:00.000Z', accessStatusReason: 'future_repository_availability_date',
    supervisors: ['Embargo Supervisor'],
  };
  await db.saveDocumentMetadata(available, { syncKey });
  await db.saveDocumentMetadata(embargoed, { syncKey });

  const catalogued = await db.queryCachedDocumentPage({ syncKey, limit: 10 });
  assert.equal(catalogued.total, 2);
  assert.equal(catalogued.documents.find((doc) => doc.id === embargoed.id).abstract, '');

  const pending = await db.listDocumentsPendingEnrichment({
    syncKey, contentMode: 'pdf_stream', contentFallback: 'full_text', limit: 10,
  });
  assert.deepEqual(pending.map((row) => row.docId), [available.id]);
  assert.equal(await db.countDeferredEmbargoedDocuments({ syncKey }), 1);

  const rule = await db.saveImportRule({
    id: `${syncKey}-rule`, name: 'Embargo test rule', extractCitations: true, runConcepts: true,
  });
  const token = await db.beginImportRuleEligibilityProjection(rule.id);
  await db.projectImportRuleEligibilityBatch(rule.id, token, [available.id, embargoed.id]);
  await db.finalizeImportRuleEligibilityProjection(rule.id, token);
  const conceptQueue = await db.listEligibleDocumentsForProcessing({
    processor: 'patternrank', status: 'pending', limit: 100,
  });
  assert.equal(conceptQueue.some((row) => row.doc_id === available.id), true);
  assert.equal(conceptQueue.some((row) => row.doc_id === embargoed.id), false);

  const citationQueue = await db.listPendingCitationScans({
    syncKey, eligibilityRuleIds: [rule.id], limit: 100,
  });
  assert.equal(citationQueue.some((row) => row.doc_id === available.id), true);
  assert.equal(citationQueue.some((row) => row.doc_id === embargoed.id), false);

  const sqlAnalytics = await db.getDocumentServingAnalytics({ syncKey });
  assert.equal(sqlAnalytics.metrics.recordCount, 1);
  assert.equal(sqlAnalytics.ngramCloud.some((row) => row.term === 'embargo ends'), false);

  const people = await db.queryPeoplePage({ syncKey, limit: 10 });
  assert.equal(people.total, 1);
  assert.equal(people.people[0].name, 'Available Supervisor');
  const citations = await db.queryCitationDocumentPage({ syncKey, limit: 10 });
  assert.equal(citations.total, 1, 'citation denominators exclude embargoed records');

  const cached = await db.listCachedDocuments({ syncKey });
  const jsAnalytics = await buildMetricsPayloadFromRecords(cached, { test: true });
  assert.equal(jsAnalytics.metrics.recordCount, 1);
  assert.equal(jsAnalytics.documents.length, 1);
  assert.equal(jsAnalytics.ngramCloud.some((row) => row.term === 'embargo ends'), false);
});

test('an elapsed embargo becomes eligible for verification without asserting availability', async () => {
  const syncKey = `expired-${Date.now()}`;
  const doc = {
    id: `${syncKey}-doc`, title: 'Expired embargo', accessStatus: 'embargoed',
    availableAt: '2020-01-01T00:00:00.000Z', accessStatusReason: 'repository_embargo_placeholder',
    abstract: '', subjects: ['History'], conceptTerms: [], methodologies: [], themes: [],
  };
  await db.saveDocumentMetadata(doc, { syncKey });
  const pending = await db.listDocumentsPendingEnrichment({
    syncKey, contentMode: 'pdf_stream', contentFallback: 'full_text', limit: 10,
  });
  assert.deepEqual(pending.map((row) => row.docId), [doc.id]);
  assert.equal(await db.countDeferredEmbargoedDocuments({ syncKey }), 0);
  const analytics = await db.getDocumentServingAnalytics({ syncKey });
  assert.equal(analytics.metrics.recordCount, 0, 'verification-due content is not analytically available');
});

test('metadata refresh cannot clear a durable embargo hold before content verification', async () => {
  const syncKey = `persistent-${Date.now()}`;
  const expiredId = `${syncKey}-expired`;
  await db.saveDocumentMetadata({
    id: expiredId, title: 'Previously embargoed thesis', accessStatus: 'embargoed',
    availableAt: '2020-01-01T00:00:00.000Z',
    accessStatusReason: 'future_repository_availability_date', abstract: '',
    themes: [], conceptTerms: [], methodologies: [],
  }, { syncKey });
  await db.saveDocumentMetadata({
    id: expiredId, title: 'Previously embargoed thesis', accessStatus: 'unknown',
    availableAt: '2020-01-01T00:00:00.000Z', abstract: 'A legitimate abstract now exposed.',
    themes: ['history'], conceptTerms: ['legitimate concept'], methodologies: ['Archival Research'],
  }, { syncKey });

  const expired = await db.loadDocumentMetadata(expiredId);
  assert.equal(expired.accessStatus, 'verification_due');
  assert.equal(expired.abstract, '');
  assert.deepEqual(expired.conceptTerms, []);
  assert.equal((await db.getDocumentServingAnalytics({ syncKey })).metrics.recordCount, 0);
  assert.deepEqual((await db.listDocumentsPendingEnrichment({
    syncKey, contentMode: 'pdf_stream', contentFallback: 'full_text', limit: 10,
  })).map((row) => row.docId), [expiredId]);

  const futureId = `${syncKey}-future`;
  await db.saveDocumentMetadata({
    id: futureId, title: 'Actively embargoed thesis', accessStatus: 'embargoed',
    availableAt: '2099-01-01T07:00:00.000Z',
    accessStatusReason: 'future_repository_availability_date', abstract: '',
    themes: [], conceptTerms: [], methodologies: [],
  }, { syncKey });
  await db.saveDocumentMetadata({
    id: futureId, title: 'Actively embargoed thesis', accessStatus: 'unknown',
    abstract: 'Repository metadata changed.', themes: ['leak'], conceptTerms: ['embargo ends'],
    methodologies: ['Interview'],
  }, { syncKey });
  const future = await db.loadDocumentMetadata(futureId);
  assert.equal(future.accessStatus, 'embargoed');
  assert.equal(future.availableAt, '2099-01-01T07:00:00.000Z');
  assert.deepEqual(future.conceptTerms, []);
  const accessRows = await db.loadStoredFileMetrics([futureId], { includeRestrictedAccess: true });
  const durableHold = accessRows.get(futureId);
  assert.equal(durableHold.access_status, 'embargoed');
  assert.equal(durableHold.available_at, '2099-01-01T07:00:00.000Z');
  assert.equal(isEmbargoDeferred({ accessStatus: durableHold.access_status, availableAt: durableHold.available_at }), true);
});

test('manual theme rebuild cannot restore derived terms to a restricted record', async () => {
  const syncKey = `theme-rebuild-${Date.now()}`;
  const docId = `${syncKey}-doc`;
  await db.saveDocumentMetadata({
    id: docId, title: 'Embargoed thesis', accessStatus: 'embargoed',
    availableAt: '2099-01-01T00:00:00.000Z', abstract: '',
    themes: [], conceptTerms: [], methodologies: [],
  }, { syncKey });
  const client = await db.getDb();
  const row = await client.execute({ sql: 'SELECT metadata_json FROM documents WHERE doc_id = ?', args: [docId] });
  const contaminated = JSON.parse(row.rows[0].metadata_json);
  contaminated.themes = ['embargo ends'];
  await client.execute({
    sql: 'UPDATE documents SET metadata_json = ? WHERE doc_id = ?',
    args: [JSON.stringify(contaminated), docId],
  });

  await db.recomputeStoredDocumentThemes({ docIds: [docId] });
  const rebuilt = await db.loadDocumentMetadata(docId);
  assert.deepEqual(rebuilt.themes, []);
});
