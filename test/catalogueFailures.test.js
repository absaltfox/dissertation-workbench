import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tempDir;
let runPendingCatalogueLookups;
let saveCitations;
let listPendingLookups;
let getCatalogueLookupStats;
let getCitationStats;
let closeDb;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-cat-failures-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;

  ({ runPendingCatalogueLookups } = await import('../src/catalogue.js'));
  const db = await import('../src/db.js');
  saveCitations = db.saveCitations;
  listPendingLookups = db.listPendingLookups;
  getCatalogueLookupStats = db.getCatalogueLookupStats;
  getCitationStats = db.getCitationStats;
  closeDb = db.closeDb;
  await db.ensureStorage();

  const hashFn = (text) => `hash-${text}`;
  await saveCitations('1.0100001', [
    'Smith, J. (1990). Unparseable output test one. City: Press.',
    'Jones, K. (1991). Unparseable output test two. City: Press.',
  ], hashFn);
});

test.after(async () => {
  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('saveCitations does not merge different works by the same author', async () => {
  const hashFn = (text) => `h-${text}`;
  await saveCitations('1.0200001', [
    { text: 'Fullan, M. (1991). The new meaning of educational change. New York: Teachers College Press.', year: '1991' },
  ], hashFn);
  await saveCitations('1.0200002', [
    { text: 'Fullan, M. (1992). The new meaning of successful school improvement. New York: Teachers College Press.', year: '1992' },
  ], hashFn);
  const stats = await getCitationStats();
  // The 1991 and 1992 works are different — they must NOT be merged.
  // getCitationStats counts all citations; the before() setup added 2 (Smith 1990, Jones 1991),
  // so we now expect 4 total (2 pre-existing + 2 Fullan).
  const fullanTotal = Number(stats.total_citations) - 2; // subtract pre-existing
  assert.equal(fullanTotal, 2, `Expected 2 distinct Fullan citations, got ${fullanTotal} (total=${stats.total_citations})`);

  // Same work, minimal OCR punctuation variant (trailing period dropped), same year: still merges.
  await saveCitations('1.0200003', [
    { text: 'Fullan, M. (1991). The new meaning of educational change. New York: Teachers College Press', year: '1991' },
  ], hashFn);
  const stats2 = await getCitationStats();
  const fullanTotal2 = Number(stats2.total_citations) - 2;
  assert.equal(fullanTotal2, 2, `OCR variant of same 1991 work should still merge; got ${fullanTotal2} (total=${stats2.total_citations})`);
});

test('permanent lookup failures are persisted and drain the pending queue', async () => {
  const failingBatch = async (texts) => texts.map(() => ({
    found: null,
    hits: null,
    author: 'Smith',
    title: 'Unparseable output test',
    error: 'Missing hits in batch output block',
  }));

  const pendingBefore = (await listPendingLookups(100)).length;
  assert.ok(pendingBefore >= 2, 'fixture should have pending citations to drain');

  const stats = await runPendingCatalogueLookups({
    pageSize: 2,
    isYazAvailable: async () => true,
    lookupBatch: failingBatch,
  });
  // Assert failed count matches the pending citations we had before draining
  assert.equal(stats.failed, pendingBefore);

  const stillPending = await listPendingLookups(10);
  assert.equal(stillPending.length, 0);

  const summary = await getCatalogueLookupStats();
  assert.equal(summary.failed, pendingBefore);
  assert.equal(summary.pending, 0);
});

test('re-extracting the same citations keeps catalogue lookups', async () => {
  const db = await import('../src/db.js');
  const hashFn = (text) => `keep-${text}`;
  const docId = '1.0300001';
  const citeA = 'Dewey, J. (1938). Experience and education. New York: Macmillan.';
  const citeB = 'Freire, P. (1970). Pedagogy of the oppressed. New York: Continuum.';

  const firstIds = await db.saveCitations(docId, [citeA, citeB], hashFn);
  assert.equal(firstIds.length, 2);
  await db.saveCatalogueLookup(firstIds[0], {
    hits: 3, queryAuthor: 'Dewey', queryTitle: 'Experience and education', bibId: '12345',
  });

  // Simulate reparse: same citations extracted again, then stale-link pruning.
  const secondIds = await db.saveCitations(docId, [citeA, citeB], hashFn);
  await db.replaceDocumentCitationLinks(docId, secondIds);
  assert.deepEqual([...secondIds].sort(), [...firstIds].sort());
  const lookup = await db.loadCatalogueLookup(firstIds[0]);
  assert.equal(Number(lookup.hits), 3);

  // Reparse that drops citeB: its link, citation, and lookup are GC'd.
  const thirdIds = await db.saveCitations(docId, [citeA], hashFn);
  await db.replaceDocumentCitationLinks(docId, thirdIds);
  const remaining = await db.loadDocumentCitations(docId);
  assert.equal(remaining.length, 1);
});

test('reextractDocumentCitations preserves lookups and prunes stale links', async () => {
  const db = await import('../src/db.js');
  const hashFn = (text) => `rex-${text}`;
  const docId = '1.0400001';
  const citeA = 'Vygotsky, L. (1978). Mind in society. Cambridge: Harvard University Press.';
  const citeB = 'Bruner, J. (1960). The process of education. Cambridge: Harvard University Press.';

  const firstIds = await db.reextractDocumentCitations(docId, [citeA, citeB], hashFn);
  assert.equal(firstIds.length, 2);
  await db.saveCatalogueLookup(firstIds[0], {
    hits: 1, queryAuthor: 'Vygotsky', queryTitle: 'Mind in society', bibId: '99',
  });

  // Same citations again: IDs are stable and the lookup survives.
  const secondIds = await db.reextractDocumentCitations(docId, [citeA, citeB], hashFn);
  assert.deepEqual([...secondIds].sort(), [...firstIds].sort());
  const lookup = await db.loadCatalogueLookup(firstIds[0]);
  assert.equal(Number(lookup.hits), 1);

  // Dropping citeB prunes only its link.
  await db.reextractDocumentCitations(docId, [citeA], hashFn);
  assert.equal((await db.loadDocumentCitations(docId)).length, 1);

  // An empty extraction clears the document's citations.
  await db.reextractDocumentCitations(docId, [], hashFn);
  assert.equal((await db.loadDocumentCitations(docId)).length, 0);
});
