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

// --- B-02 (#12): orphan collection is scoped to the document being re-extracted ---

test('re-extraction never touches another document\'s citations or lookups', async () => {
  const db = await import('../src/db.js');
  const hashFn = (text) => `scope-${text}`;
  const keeperDoc = '1.0500001';
  const reparsedDoc = '1.0500002';
  const shared = 'Bourdieu, P. (1984). Distinction. Cambridge: Harvard University Press.';
  const keeperOnly = 'Latour, B. (1987). Science in action. Cambridge: Harvard University Press.';
  const dropped = 'Goffman, E. (1959). The presentation of self in everyday life. New York: Anchor.';

  const keeperIds = await db.reextractDocumentCitations(keeperDoc, [shared, keeperOnly], hashFn);
  await db.saveCatalogueLookup(keeperIds[0], {
    hits: 2, queryAuthor: 'Bourdieu', queryTitle: 'Distinction', bibId: 'shared-1',
  });
  await db.saveCatalogueLookup(keeperIds[1], {
    hits: 5, queryAuthor: 'Latour', queryTitle: 'Science in action', bibId: 'keeper-1',
  });

  const reparsedIds = await db.reextractDocumentCitations(reparsedDoc, [shared, dropped], hashFn);
  const droppedId = reparsedIds.find((id) => !keeperIds.includes(id));
  await db.saveCatalogueLookup(droppedId, {
    hits: 1, queryAuthor: 'Goffman', queryTitle: 'Presentation of self', bibId: 'dropped-1',
  });

  // Reparse of the second document drops one citation and keeps the shared one.
  await db.reextractDocumentCitations(reparsedDoc, [shared], hashFn);

  // The other document is untouched: both links, and both catalogue lookups.
  assert.equal((await db.loadDocumentCitations(keeperDoc)).length, 2);
  assert.equal(Number((await db.loadCatalogueLookup(keeperIds[0])).hits), 2);
  assert.equal(Number((await db.loadCatalogueLookup(keeperIds[1])).hits), 5);

  // The citation only the reparsed document held is collected, lookup included.
  assert.equal(await db.loadCatalogueLookup(droppedId), null);
});

test('a citation orphaned outside this document survives a re-extraction', async () => {
  const db = await import('../src/db.js');
  const client = await db.getDb();
  const hashFn = (text) => `stray-${text}`;
  const now = new Date().toISOString();

  // Stands in for a citation another worker inserted but has not linked yet, and
  // for one left behind by an interrupted job. The old global anti-join swept both
  // away — with their catalogue lookups — on the next document processed.
  await client.execute({
    sql: `INSERT INTO citations (citation_hash, citation_text, year, created_at, match_key_version)
          VALUES (?, ?, ?, ?, 0)`,
    args: ['stray-hash', 'Arendt, H. (1958). The human condition. Chicago: UCP.', '1958', now],
  });
  const strayRow = await client.execute({
    sql: 'SELECT id FROM citations WHERE citation_hash = ?', args: ['stray-hash'],
  });
  const strayId = Number(strayRow.rows[0].id);
  await db.saveCatalogueLookup(strayId, {
    hits: 7, queryAuthor: 'Arendt', queryTitle: 'The human condition', bibId: 'stray-1',
  });

  const otherDoc = '1.0600001';
  const ids = await db.reextractDocumentCitations(otherDoc, [
    'Sennett, R. (1977). The fall of public man. New York: Knopf.',
    'Illich, I. (1971). Deschooling society. New York: Harper.',
  ], hashFn);
  await db.reextractDocumentCitations(otherDoc, [
    'Sennett, R. (1977). The fall of public man. New York: Knopf.',
  ], hashFn);
  assert.equal(ids.length, 2);

  // Unrelated orphan and its Z39.50 result are still there.
  assert.equal(Number((await db.loadCatalogueLookup(strayId)).hits), 7);

  // Periodic maintenance — and only periodic maintenance — collects it.
  const removed = await db.sweepOrphanedCitations({ batchSize: 10 });
  assert.ok(removed >= 1);
  assert.equal(await db.loadCatalogueLookup(strayId), null);
  const gone = await client.execute({
    sql: 'SELECT COUNT(*) AS n FROM citations WHERE citation_hash = ?', args: ['stray-hash'],
  });
  assert.equal(Number(gone.rows[0].n), 0);
});

test('collectOrphanedCitations only removes ids it is given, and only if unlinked', async () => {
  const db = await import('../src/db.js');
  const hashFn = (text) => `collect-${text}`;
  const docId = '1.0700001';
  const ids = await db.reextractDocumentCitations(docId, [
    'Polanyi, K. (1944). The great transformation. New York: Farrar.',
    'Scott, J. (1998). Seeing like a state. New Haven: Yale University Press.',
  ], hashFn);

  // Still linked: naming them explicitly must not delete them.
  assert.equal(await db.collectOrphanedCitations(ids), 0);
  assert.equal((await db.loadDocumentCitations(docId)).length, 2);

  // Unlinked but not named: left alone, because collection is scoped to the ids
  // the caller passes rather than to whatever the corpus happens to have orphaned.
  const client = await db.getDb();
  await client.execute({
    sql: `INSERT INTO citations (citation_hash, citation_text, year, created_at, match_key_version)
          VALUES (?, ?, ?, ?, 1)`,
    args: ['unnamed-orphan', 'Mills, C. W. (1959). The sociological imagination. New York: OUP.', '1959', new Date().toISOString()],
  });
  assert.equal(await db.collectOrphanedCitations(ids), 0);
  const survived = await client.execute({
    sql: 'SELECT COUNT(*) AS n FROM citations WHERE citation_hash = ?', args: ['unnamed-orphan'],
  });
  assert.equal(Number(survived.rows[0].n), 1);
});
