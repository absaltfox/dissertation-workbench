import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCitationCountsToDocuments,
  applyCommitteeMembersToDocuments,
  applyStoredFileMetricsToDocuments,
  closeDb,
  deleteCommitteeMembersByRoles,
  ensureStorage,
  getDb,
  listCachedDocuments,
  loadDocumentMetadata,
  recomputeStoredDocumentThemes,
  saveCitations,
  saveCommitteeMembers,
  saveDocumentMetadata,
  saveFileMetric,
} from '../src/db.js';
import { enrichDocumentSignals } from '../src/metrics.js';

test.after(async () => {
  await closeDb();
});

test('cached documents overlay persisted file metrics without enrichment work', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const syncKey = `test-file-metric-overlay-${suffix}`;
  const docId = `test-doc-${suffix}`;

  await saveDocumentMetadata({
    id: docId,
    title: 'Cached metric overlay fixture',
    author: 'Example Author',
    year: 2026,
    degree: 'Doctor of Education - EdD',
    program: 'Education',
    pages: 1,
    pagesSource: 'estimated_from_metadata_words',
    wordCount: 120,
    wordCountSource: 'metadata_text',
    bodyWordCount: null,
    downloadUrl: null,
    downloadStatus: 'not_attempted',
    downloadError: null,
  }, { syncKey });

  await saveFileMetric(docId, {
    status: 'downloaded',
    error: null,
    pdfPath: '/tmp/cached-metric-overlay.pdf',
    downloadUrl: 'https://circle.library.ubc.ca/rest/bitstreams/123/retrieve',
    fileBytes: 123456,
    wordCount: 60000,
    bodyWordCount: 52000,
    pageCount: 210,
    wordSource: 'downloaded_pdf_text',
    pageSource: 'downloaded_pdf',
  });

  const docs = await listCachedDocuments({ syncKey, limit: 10 });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].id, docId);
  assert.equal(docs[0].pages, 210);
  assert.equal(docs[0].pagesSource, 'downloaded_pdf');
  assert.equal(docs[0].wordCount, 60000);
  assert.equal(docs[0].wordCountSource, 'downloaded_pdf_text');
  assert.equal(docs[0].bodyWordCount, 52000);
  assert.equal(docs[0].fileBytes, 123456);
  assert.equal(docs[0].downloadStatus, 'downloaded');
  assert.equal(docs[0].downloadError, null);
});

test('document metadata saves durable themes for later cached reads', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const docId = `test-theme-storage-${suffix}`;
  await saveDocumentMetadata({
    id: docId,
    title: 'Digital Equity and Rural Learning',
    author: 'Theme Tester',
    year: 2026,
    abstract: 'Digital access and rural learning shaped online teaching.',
    subjects: ['Educational technology', 'Rural education'],
  });

  const stored = await loadDocumentMetadata(docId);
  assert.ok(Array.isArray(stored.themes));
  assert.ok(stored.themes.includes('digital'));

  const docs = await listCachedDocuments({ limit: 1000 });
  const cached = docs.find((doc) => doc.id === docId);
  assert.ok(cached);
  assert.deepEqual(cached.themes, stored.themes);
});

test('metrics enrichment preserves stored themes instead of recomputing per request', () => {
  const docs = enrichDocumentSignals([
    {
      id: 'stored-theme-doc',
      title: 'Completely Different Vocabulary',
      abstract: 'Completely different vocabulary appears repeatedly.',
      subjects: ['Vocabulary'],
      themes: ['persisted-theme'],
      methodologies: [],
      conceptTerms: [],
    },
    {
      id: 'comparison-doc',
      title: 'Vocabulary Comparison',
      abstract: 'Vocabulary comparison text.',
      subjects: ['Comparison'],
      themes: ['comparison-theme'],
      methodologies: [],
      conceptTerms: [],
    },
  ]);

  assert.deepEqual(docs[0].themes, ['persisted-theme']);
  assert.deepEqual(docs[1].themes, ['comparison-theme']);
});

test('stored themes can be manually recomputed across documents', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const docId = `test-theme-recompute-${suffix}`;
  await saveDocumentMetadata({
    id: docId,
    title: 'Community Literacy Practice',
    author: 'Theme Tester',
    year: 2026,
    abstract: 'Community literacy practice and adult learning.',
    subjects: ['Adult education'],
    themes: ['stale'],
  });

  const result = await recomputeStoredDocumentThemes({ docIds: [docId] });
  assert.ok(result.updated >= 1);
  const stored = await loadDocumentMetadata(docId);
  assert.ok(!stored.themes.includes('stale'));
  assert.ok(stored.themes.includes('community') || stored.themes.includes('literacy'));
});

test('stored file metrics can overlay freshly fetched metadata records', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const docId = `test-fresh-doc-${suffix}`;

  await saveFileMetric(docId, {
    status: 'recomputed_from_cache',
    error: null,
    pdfPath: '/tmp/fresh-doc-overlay.pdf',
    downloadUrl: 'https://circle.library.ubc.ca/rest/bitstreams/456/retrieve',
    fileBytes: 654321,
    wordCount: 71500,
    bodyWordCount: 69000,
    pageCount: 240,
    wordSource: 'cached_pdf_text',
    pageSource: 'cached_pdf',
  });

  const docs = [{
    id: docId,
    title: 'Fresh metadata fixture',
    pages: 1,
    pagesSource: 'estimated_from_metadata_words',
    wordCount: 300,
    wordCountSource: 'metadata_text',
    bodyWordCount: null,
    downloadStatus: 'not_attempted',
  }];

  await applyStoredFileMetricsToDocuments(docs);

  assert.equal(docs[0].pages, 240);
  assert.equal(docs[0].pagesSource, 'cached_pdf');
  assert.equal(docs[0].wordCount, 71500);
  assert.equal(docs[0].wordCountSource, 'cached_pdf_text');
  assert.equal(docs[0].bodyWordCount, 69000);
  assert.equal(docs[0].fileBytes, 654321);
  assert.equal(docs[0].downloadStatus, 'recomputed_from_cache');
});

test('stored citation links can overlay freshly fetched metadata records', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const docId = `test-citation-count-${suffix}`;

  await saveCitations(docId, [
    'Example, A. (2020). First reference.',
    'Example, B. (2021). Second reference.',
  ], (text) => `test-${suffix}-${text}`);

  const docs = [{
    id: docId,
    title: 'Citation count fixture',
    citationCount: 0,
  }];

  await applyCitationCountsToDocuments(docs);

  assert.equal(docs[0].citationCount, 2);
});

test('stored committee and examiner roles can overlay freshly fetched metadata records', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const docId = `test-committee-roles-${suffix}`;

  await saveCommitteeMembers(docId, [
    { name: 'Alex Supervisor', role: 'Supervisor', affiliation: 'UBC' },
    { name: 'Uma Examiner', role: 'University Examiner', affiliation: 'Faculty of Education' },
    { name: 'Evan External', role: 'External Examiner', affiliation: 'Example University' },
    { name: 'Casey Committee', role: 'Committee Member', affiliation: 'Educational Studies' },
  ], 'pdf');

  const docs = [{
    id: docId,
    title: 'Committee role fixture',
    committee: [],
    supervisors: [],
  }];

  await applyCommitteeMembersToDocuments(docs);

  assert.deepEqual(
    docs[0].committee.map((member) => member.role),
    ['Supervisor', 'University Examiner', 'External Examiner', 'Committee Member']
  );
  assert.equal(docs[0].committee.find((member) => member.role === 'External Examiner')?.name, 'Evan External');
  assert.equal(docs[0].committee.find((member) => member.role === 'University Examiner')?.affiliation, 'Faculty of Education');
  assert.deepEqual(docs[0].supervisors, ['Alex Supervisor']);
  assert.equal(docs[0].supervisorsSource, 'pdf_fallback');
});

test('committee serving projection preserves authoritative API source precedence', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const docId = `test-committee-precedence-${suffix}`;
  await saveCommitteeMembers(docId, [
    { name: 'Priority Person', role: 'External Examiner', affiliation: 'API University' },
  ], 'api');
  await saveCommitteeMembers(docId, [
    { name: 'Priority M. Person', role: 'External Examiner', affiliation: 'PDF University' },
  ], 'pdf');

  const client = await getDb();
  const result = await client.execute({
    sql: `SELECT affiliation, source FROM document_people
          WHERE doc_id = ? AND person_key = ? AND role = ?`,
    args: [docId, 'priority person', 'External Examiner'],
  });
  assert.deepEqual(result.rows.map((row) => [row.affiliation, row.source]), [
    ['API University', 'api'],
  ]);

  assert.equal(await deleteCommitteeMembersByRoles(docId, ['External Examiner'], 'pdf'), 1);
  const survivingProjection = await client.execute({
    sql: 'SELECT affiliation, source FROM document_people WHERE doc_id = ? AND person_key = ?',
    args: [docId, 'priority person'],
  });
  assert.deepEqual(survivingProjection.rows.map((row) => [row.affiliation, row.source]), [
    ['API University', 'api'],
  ]);

  await saveCommitteeMembers(docId, [
    { name: '王小明', role: 'Committee Member', affiliation: '清华大学' },
  ], 'api');
  const unicodeCanonical = await client.execute({
    sql: 'SELECT name FROM committee_members WHERE doc_id = ? AND name = ?',
    args: [docId, '王小明'],
  });
  const unicodeProjection = await client.execute({
    sql: 'SELECT person_key FROM document_people WHERE doc_id = ? AND name = ?',
    args: [docId, '王小明'],
  });
  assert.equal(unicodeCanonical.rows.length, 1);
  assert.equal(unicodeProjection.rows[0]?.person_key, '王小明');
});
