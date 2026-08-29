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

// --- #30 (M-09): getCatalogueLookupStats().pending must agree with countPendingLookups() ---

test('getCatalogueLookupStats().pending matches countPendingLookups() and listPendingLookups().length, including after a partial citation delete', async () => {
  const db = await import('../src/db.js');
  const client = await db.getDb();
  const hashFn = (text) => `m09-${text}`;
  const now = new Date().toISOString();

  // A citation with no catalogue_lookups row at all (the NOT EXISTS arm).
  const [noLookupId] = await db.saveCitations('1.0800001', [
    'Habermas, J. (1984). The theory of communicative action. Boston: Beacon.',
  ], hashFn);

  // A citation with a catalogue_lookups row that is itself still pending
  // (hits IS NULL AND query_title IS NOT NULL — the EXISTS arm).
  const [pendingLookupId] = await db.saveCitations('1.0800002', [
    'Foucault, M. (1975). Discipline and punish. Paris: Gallimard.',
  ], hashFn);
  await db.saveCatalogueLookup(pendingLookupId, { hits: null, queryAuthor: 'Foucault', queryTitle: 'Discipline and punish' });

  // A citation that is resolved (not pending) — must not be counted.
  const [resolvedId] = await db.saveCitations('1.0800003', [
    'Bourdieu, P. (1990). The logic of practice. Stanford: SUP.',
  ], hashFn);
  await db.saveCatalogueLookup(resolvedId, { hits: 2, queryAuthor: 'Bourdieu', queryTitle: 'The logic of practice', bibId: 'b-1' });

  // Partial-delete scenario: a catalogue_lookups row survives after its citations
  // row is deleted, orphaning it outside the normal GC path (collectOrphanedCitations
  // always deletes catalogue_lookups before citations) — citations and
  // catalogue_lookups are no longer a strict subset relationship. This is exactly
  // the referential-integrity gap the old arithmetic silently assumed away; this
  // local sqlite backend enforces FK by default (unlike some remote libsql/Turso
  // connections), so the pragma is toggled off only around this one delete to
  // reproduce the dangling reference the fix must be robust to. This orphan must
  // not appear as pending for either function, since countPendingLookups (and
  // listPendingLookups) both drive from `citations c`.
  const [strayId] = await db.saveCitations('1.0800004', [
    'Arendt, H. (1963). On revolution. New York: Viking.',
  ], hashFn);
  await db.saveCatalogueLookup(strayId, { hits: null, queryAuthor: 'Arendt', queryTitle: 'On revolution' });
  await client.execute('PRAGMA foreign_keys=OFF');
  await client.execute({ sql: 'DELETE FROM citations WHERE id = ?', args: [strayId] });
  await client.execute('PRAGMA foreign_keys=ON');

  const [statsPending, countPending, listPending] = await Promise.all([
    db.getCatalogueLookupStats().then((s) => s.pending),
    db.countPendingLookups(),
    db.listPendingLookups(100000),
  ]);

  assert.equal(statsPending, countPending,
    `getCatalogueLookupStats().pending (${statsPending}) disagreed with countPendingLookups() (${countPending})`);
  assert.equal(statsPending, listPending.length,
    `getCatalogueLookupStats().pending (${statsPending}) disagreed with listPendingLookups().length (${listPending.length})`);

  const pendingIds = new Set(listPending.map((row) => Number(row.id)));
  assert.ok(pendingIds.has(noLookupId), 'citation with no catalogue_lookups row should be pending');
  assert.ok(pendingIds.has(pendingLookupId), 'citation with a still-pending catalogue_lookups row should be pending');
  assert.ok(!pendingIds.has(resolvedId), 'resolved citation must not be counted as pending');
  assert.ok(!pendingIds.has(strayId), 'a deleted citation must not be counted as pending even if its catalogue_lookups row survives');
});

test('the pre-fix table-total arithmetic would have disagreed with the real predicate (regression pin)', async () => {
  const db = await import('../src/db.js');
  const client = await db.getDb();
  const hashFn = (text) => `m09-arith-${text}`;

  async function tableTotals() {
    const [citationsRow, lookupsRow, pendingShapedRow] = await Promise.all([
      client.execute('SELECT COUNT(*) AS n FROM citations'),
      client.execute('SELECT COUNT(*) AS n FROM catalogue_lookups'),
      client.execute('SELECT COUNT(*) AS n FROM catalogue_lookups WHERE hits IS NULL AND query_title IS NOT NULL'),
    ]);
    const citations = Number(citationsRow.rows[0].n);
    const lookups = Number(lookupsRow.rows[0].n);
    const pendingShaped = Number(pendingShapedRow.rows[0].n);
    // Exact shape of the pre-fix getCatalogueLookupStats().pending arithmetic.
    return citations - lookups + pendingShaped;
  }

  const realPendingBefore = await db.countPendingLookups();
  const oldArithmeticBefore = await tableTotals();

  // Orphan a *resolved* (not pending) catalogue_lookups row by deleting its
  // citations row underneath it (FK toggled off around this one delete only,
  // reproducing the dangling-reference condition a remote/production
  // connection without FK enforcement can leave behind). The citation is now
  // gone entirely, so the real predicate (driven off `citations c`) is
  // unaffected. But the old arithmetic's COUNT(citations) term drops by one
  // while COUNT(catalogue_lookups) stays the same (the orphaned row still
  // physically exists) and the pending-shaped count is unaffected (hits=4,
  // not NULL) -- so the old formula's result drops by one for a change that
  // should have zero effect on the pending count.
  const [resolvedStrayId] = await db.saveCitations('1.0900002', [
    'Freire, P. (1968). Pedagogy of the oppressed. Rio de Janeiro: Paz e Terra.',
  ], hashFn);
  await db.saveCatalogueLookup(resolvedStrayId, { hits: 4, queryAuthor: 'Freire', queryTitle: 'Pedagogy of the oppressed', bibId: 'fr-1' });
  await client.execute('PRAGMA foreign_keys=OFF');
  await client.execute({ sql: 'DELETE FROM citations WHERE id = ?', args: [resolvedStrayId] });
  await client.execute('PRAGMA foreign_keys=ON');

  const realPendingAfter = await db.countPendingLookups();
  const oldArithmeticAfter = await tableTotals();
  const fixedStatsAfter = (await db.getCatalogueLookupStats()).pending;

  assert.equal(realPendingAfter, realPendingBefore,
    'deleting a citation whose lookup was already resolved must not change the real pending count');
  assert.equal(oldArithmeticAfter, oldArithmeticBefore - 1,
    'sanity: the pre-fix arithmetic is expected to drop by exactly one under this fixture');
  assert.notEqual(oldArithmeticAfter, realPendingAfter,
    'expected the pre-fix arithmetic to diverge from the real, unaffected pending predicate');

  // The fixed function must track the real predicate, not the old arithmetic.
  assert.equal(fixedStatsAfter, realPendingAfter,
    'fixed getCatalogueLookupStats().pending must still track the real predicate, not the old arithmetic');
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

// --- B-02 (#12): re-extraction cost is flat as the corpus grows ---

test('re-extraction cost does not grow with corpus size or document position', async () => {
  const db = await import('../src/db.js');
  const client = await db.getDb();
  const hashFn = (text) => `flat-${text}`;
  const TOTAL_DOCS = 300;

  // citationTextPrefix() keys the fuzzy-matching bucket on the first 3 characters
  // of the citation text and its year. Each document below gets its own 3-letter
  // prefix (base-26 over its index) and a year spaced 10 apart from its
  // neighbours, so no citation-matching bucket — including the +/-1 year window —
  // ever holds more than one document's own rows. That isolates the B-02
  // orphan-scoping cost this test measures from #11's bucket-size behaviour
  // (covered by its own equivalence suite); without this spacing, adjacent doc
  // indices with near-identical text would fuzzy-merge across documents.
  function prefixLetters(n) {
    const a = Math.floor(n / 676) % 26;
    const b = Math.floor(n / 26) % 26;
    const c = n % 26;
    return String.fromCharCode(65 + a, 65 + b, 65 + c);
  }
  function citationsFor(i) {
    const prefix = prefixLetters(i);
    const year = 1700 + i * 10;
    return [{ text: `${prefix}vellingcourt, A. (${year}). Unique flat-cost fixture ${i}.`, year: String(year) }];
  }
  const docId = (i) => `1.9${String(i).padStart(6, '0')}`;

  for (let i = 0; i < TOTAL_DOCS; i += 1) {
    await db.reextractDocumentCitations(docId(i), citationsFor(i), hashFn);
  }

  const originalExecute = client.execute.bind(client);
  const originalBatch = client.batch ? client.batch.bind(client) : null;
  let calls = 0;
  client.execute = async (...args) => {
    calls += 1;
    return originalExecute(...args);
  };
  if (originalBatch) {
    client.batch = async (...args) => {
      calls += 1;
      return originalBatch(...args);
    };
  }

  async function costOfReextracting(i) {
    calls = 0;
    // A brand-new citation forces both an insert (no exact-hash match) and the
    // old one to become orphaned (no other document references it), so every
    // re-extraction pays the full save + prune + collect path. The +5000 offset
    // keeps the replacement's (prefix, year) bucket disjoint from every
    // document's original citation, for the same reason as citationsFor() above.
    const replacementPrefix = prefixLetters(i + 5000);
    const replacementYear = 1700 + (i + 5000) * 10;
    const replacement = [
      { text: `${replacementPrefix}thistlewood, C. (${replacementYear}). Replacement fixture ${i}.`, year: String(replacementYear) },
    ];
    await db.reextractDocumentCitations(docId(i), replacement, hashFn);
    return calls;
  }

  try {
    const early = await costOfReextracting(5);
    const middle = await costOfReextracting(150);
    const late = await costOfReextracting(TOTAL_DOCS - 1);

    assert.ok(early > 0, 're-extraction should issue at least one statement');
    assert.equal(middle, early, `re-extracting doc 150 cost ${middle} statements vs doc 5's ${early} — cost grew with position`);
    assert.equal(late, early, `re-extracting doc 299 cost ${late} statements vs doc 5's ${early} — cost grew with corpus size`);
  } finally {
    client.execute = originalExecute;
    if (originalBatch) client.batch = originalBatch;
  }
});

// The statement-count test above proves the DELETEs stay a fixed number of
// statements regardless of corpus size or position -- but a count is blind to
// what each statement scans. The historical bug this replaced (57a3b98) was two
// *global* `NOT IN (SELECT DISTINCT citation_id FROM document_citations)`
// anti-joins: also a fixed number of statements (one per table), yet each one
// a full SCAN of citations/catalogue_lookups that grows linearly with corpus
// size. Statement count cannot tell these apart; EXPLAIN QUERY PLAN can.
test('collectOrphanedCitations deletes via SEARCH on the primary key, not a full table SCAN', async () => {
  const db = await import('../src/db.js');
  const client = await db.getDb();
  const hashFn = (text) => `explain-${text}`;
  const docId = '1.9900001';

  await db.reextractDocumentCitations(docId, [
    { text: 'Explainton, A. (2001). Original explain fixture.', year: '2001' },
  ], hashFn);

  // Capture the exact DELETE statements collectOrphanedCitations issues (src/db.js
  // ~3565) by intercepting client.execute while re-extracting with a brand-new
  // citation, which orphans the original and forces both DELETEs down the same
  // path costOfReextracting() exercises above. This asserts against the SQL the
  // code actually runs, not a hand-copied lookalike that could drift from it.
  const originalExecute = client.execute.bind(client);
  const captured = [];
  client.execute = async (arg) => {
    const sql = typeof arg === 'string' ? arg : arg.sql;
    if (/^\s*DELETE FROM (catalogue_lookups|citations)\b/.test(sql)) {
      captured.push({ sql, args: typeof arg === 'string' ? [] : (arg.args || []) });
    }
    return originalExecute(arg);
  };
  try {
    await db.reextractDocumentCitations(docId, [
      { text: 'Explainton, B. (2002). Replacement explain fixture.', year: '2002' },
    ], hashFn);
  } finally {
    client.execute = originalExecute;
  }

  assert.equal(
    captured.length, 2,
    `expected exactly the catalogue_lookups and citations orphan DELETEs, captured: ${captured.map((c) => c.sql).join(' || ')}`
  );

  for (const { sql, args } of captured) {
    // eslint-disable-next-line no-await-in-loop
    const plan = await client.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args });
    const details = plan.rows.map((row) => String(row.detail));
    for (const detail of details) {
      assert.ok(
        !/^SCAN (citations|catalogue_lookups)\b/.test(detail),
        `orphan-collection DELETE fell back to a full table scan (the pre-B-02 global NOT IN anti-join shape): ${detail}\nSQL: ${sql}`
      );
    }
    assert.ok(
      details.some((detail) => /^SEARCH (citations|catalogue_lookups) USING INTEGER PRIMARY KEY/.test(detail)),
      `orphan-collection DELETE did not SEARCH on the integer primary key: ${details.join(' | ')}\nSQL: ${sql}`
    );
  }
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
