import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// citation_doc_counts (citation -> number of linking documents) and
// document_citation_counts (document -> number of citations) are maintained by
// triggers on document_citations, so every writer keeps them correct: the app,
// the maintenance scripts, and an older app version still running during a
// deploy. Each write path is compared with a fresh GROUP BY recount.

let tempDir;
let db;
let client;

const hash = (t) => crypto.createHash('sha256').update(t.toLowerCase().trim()).digest('hex');

async function rows(sql, args = []) {
  return (await client.execute({ sql, args })).rows.map((r) => Object.values(r).map((v) => (typeof v === 'bigint' ? Number(v) : v)));
}

async function expectInSync(label) {
  assert.deepEqual(
    await rows('SELECT citation_id, doc_count FROM citation_doc_counts ORDER BY citation_id'),
    await rows('SELECT citation_id, COUNT(*) FROM document_citations GROUP BY citation_id ORDER BY citation_id'),
    `${label}: citation_doc_counts drifted`,
  );
  assert.deepEqual(
    await rows('SELECT doc_id, citation_count FROM document_citation_counts ORDER BY doc_id'),
    await rows('SELECT doc_id, COUNT(*) FROM document_citations GROUP BY doc_id ORDER BY doc_id'),
    `${label}: document_citation_counts drifted`,
  );
  assert.deepEqual(await db.reconcileCitationCounts(), { citationDrift: 0, docDrift: 0 }, `${label}: reconcile`);
}

async function resetAll() {
  await db.clearAllCitations();
  await expectInSync('reset');
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-cite-summary-'));
  Object.assign(process.env, {
    SKIP_LOCAL_ENV: '1', NODE_ENV: 'test', APP_DATA_DIR: tempDir,
    SQLITE_PATH: path.join(tempDir, 'metrics.sqlite'),
    PDF_CACHE_DIR: path.join(tempDir, 'pdf'), FULL_TEXT_CACHE_DIR: path.join(tempDir, 'ft'),
  });
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
  client = await db.getDb();
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('summary counts equal live aggregates after save / re-link / re-extract / replace-to-empty', async () => {
  assert.equal(db.isCitationCountsReady(), true);
  await db.saveCitations('d1', ['Smith, J. (2001). Alpha theory of things.', 'Jones, K. (1999). Beta.', 'Unique one d1 (2005).'], hash);
  await db.saveCitations('d2', ['Smith, J. (2001). Alpha theory of things.', 'Jones, K. (1999). Beta.'], hash);
  await expectInSync('after saveCitations');
  // Re-linking takes the upsert DO UPDATE branch and must not double count.
  await db.saveCitations('d2', ['Smith, J. (2001). Alpha theory of things.'], hash);
  await expectInSync('after re-link');
  const [shared] = await rows("SELECT doc_count FROM citation_doc_counts k JOIN citations c ON c.id = k.citation_id WHERE c.citation_text LIKE 'Smith%'");
  assert.deepEqual(shared, [2]);

  // Drops two links and orphan-collects the unlinked citations.
  await db.reextractDocumentCitations('d1', ['Smith, J. (2001). Alpha theory of things.', 'Brand new (2010).'], hash);
  await expectInSync('after reextractDocumentCitations');
  await db.replaceDocumentCitationLinks('d2', []);
  await expectInSync('after replace-to-empty');
  assert.deepEqual(await rows("SELECT * FROM document_citation_counts WHERE doc_id = 'd2'"), [], 'zero-count rows are removed');
});

test('summary counts equal live aggregates after collectOrphanedCitations', async () => {
  await resetAll();
  await db.saveCitations('o1', ['Orphan A (2001).', 'Keeper B (2002).'], hash);
  await db.saveCitations('o2', ['Keeper B (2002).'], hash);
  const ids = (await rows('SELECT id FROM citations')).flat();
  await db.replaceDocumentCitationLinks('o1', []);
  await db.collectOrphanedCitations(ids);
  await expectInSync('after collectOrphanedCitations');
  assert.equal((await rows('SELECT COUNT(*) FROM citation_doc_counts'))[0][0], 1);
});

test('summary counts equal live aggregates after the embargo cleanup of a document', async () => {
  await resetAll();
  await db.saveDocumentMetadata({ id: 'e1', title: 'Embargo candidate', degree: 'PhD' }, { syncKey: 'k' });
  await db.saveCitations('e1', ['Embargo cite one (2001).', 'Embargo cite two (2002).'], hash);
  await db.saveCitations('e2', ['Embargo cite one (2001).'], hash);
  await expectInSync('before embargo');
  await db.saveDocumentMetadata({ id: 'e1', title: 'Embargo candidate', degree: 'PhD', accessStatus: 'embargoed' }, { syncKey: 'k' });
  assert.deepEqual(await rows("SELECT COUNT(*) FROM document_citations WHERE doc_id = 'e1'"), [[0]], 'embargo cleanup removed the links');
  await expectInSync('after embargo cleanup');
});

test('summary counts equal live aggregates after citation merges (maintenance scripts)', async () => {
  await resetAll();
  await db.saveCitations('m1', ['Dup source (2001). One.'], hash);
  await db.saveCitations('m2', ['Dup source (2001). One.', 'Other (2003).'], hash);
  await db.saveCitations('m3', ['Dup target (2001). One.'], hash);
  const [[dupId]] = await rows("SELECT id FROM citations WHERE citation_text LIKE 'Dup source%'");
  const [[keepId]] = await rows("SELECT id FROM citations WHERE citation_text LIKE 'Dup target%'");
  // The exact statements scripts/merge-duplicate-citations.mjs and
  // reindex-fuzzy-citations.mjs run: re-point links with INSERT OR IGNORE, then delete.
  await client.execute({
    sql: `INSERT OR IGNORE INTO document_citations (doc_id, citation_id, updated_at)
          SELECT doc_id, ?, updated_at FROM document_citations WHERE citation_id = ?`,
    args: [keepId, dupId],
  });
  await client.execute({
    sql: `INSERT OR IGNORE INTO document_citations (doc_id, citation_id, updated_at)
          SELECT doc_id, ?, updated_at FROM document_citations WHERE citation_id = ?`,
    args: [keepId, dupId],
  }); // ignored rows fire nothing
  await expectInSync('after INSERT OR IGNORE x2');
  await client.execute({ sql: 'DELETE FROM document_citations WHERE citation_id = ?', args: [dupId] });
  await client.execute({ sql: 'DELETE FROM catalogue_lookups WHERE citation_id = ?', args: [dupId] });
  await client.execute({ sql: 'DELETE FROM citations WHERE id = ?', args: [dupId] });
  await expectInSync('after merge delete');
  assert.deepEqual(await rows('SELECT doc_count FROM citation_doc_counts WHERE citation_id = ?', [keepId]), [[3]]);
});

test('summary counts are empty after clearAllCitations', async () => {
  await db.saveCitations('c1', ['Clear me (2001).'], hash);
  await db.clearAllCitations();
  await expectInSync('after clearAllCitations');
  assert.deepEqual(await rows('SELECT COUNT(*) FROM citation_doc_counts'), [[0]]);
  assert.deepEqual(await rows('SELECT COUNT(*) FROM document_citation_counts'), [[0]]);
});

test('migration is idempotent and backfills atomically from links that predate the triggers', async () => {
  await resetAll();
  // Simulate a database from before this release: links exist, summary objects do not.
  await client.executeMultiple(`
    DROP TRIGGER IF EXISTS trg_document_citations_count_ins;
    DROP TRIGGER IF EXISTS trg_document_citations_count_del;
    DROP TABLE IF EXISTS citation_doc_counts;
    DROP TABLE IF EXISTS document_citation_counts;
  `);
  db.__setCitationCountsReadyForTesting(true);
  await db.initCitationCountsReadiness();
  assert.equal(db.isCitationCountsReady(), false, 'not ready without the summary objects');
  await db.saveCitations('p1', ['Pre one (2001).', 'Pre two (2002).'], hash);
  await db.saveCitations('p2', ['Pre one (2001).'], hash);

  await db.ensureSchemaWithRetry(client);
  await db.initCitationCountsReadiness();
  assert.equal(db.isCitationCountsReady(), true);
  await expectInSync('after first migration');
  const snapshot = await rows('SELECT * FROM citation_doc_counts ORDER BY citation_id');

  await db.ensureSchemaWithRetry(client);
  await db.ensureSchemaWithRetry(client);
  await expectInSync('after re-running the migration');
  assert.deepEqual(await rows('SELECT * FROM citation_doc_counts ORDER BY citation_id'), snapshot);
  const objects = await rows("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('trg_document_citations_count_ins','trg_document_citations_count_del','citation_doc_counts','document_citation_counts','idx_citation_doc_counts_shared')");
  assert.deepEqual(objects, [[5]]);

  // The triggers are live after the migration.
  await db.saveCitations('p3', ['Pre one (2001).'], hash);
  await expectInSync('after a post-migration write');
});

test('reconcileCitationCounts reports drift and repairs it', async () => {
  await resetAll();
  await db.saveCitations('r1', ['Recon A (2001).', 'Recon B (2002).'], hash);
  await db.saveCitations('r2', ['Recon A (2001).'], hash);
  await expectInSync('baseline');
  await client.execute('UPDATE citation_doc_counts SET doc_count = doc_count + 5 WHERE citation_id = (SELECT MIN(citation_id) FROM citation_doc_counts)');
  await client.execute("DELETE FROM document_citation_counts WHERE doc_id = 'r2'");
  await client.execute("INSERT INTO document_citation_counts (doc_id, citation_count) VALUES ('ghost', 4)");
  assert.deepEqual(await db.reconcileCitationCounts(), { citationDrift: 1, docDrift: 2 });
  assert.deepEqual(await db.reconcileCitationCounts({ repair: true }), { citationDrift: 1, docDrift: 2, repaired: true });
  await expectInSync('after repair');
});

test('the shared-citation partial index covers doc_count >= 2 only', async () => {
  await resetAll();
  await db.saveCitations('i1', ['Idx shared (2001).', 'Idx single (2002).'], hash);
  await db.saveCitations('i2', ['Idx shared (2001).'], hash);
  const plan = (await client.execute('EXPLAIN QUERY PLAN SELECT citation_id FROM citation_doc_counts WHERE doc_count >= 2 ORDER BY doc_count DESC, citation_id')).rows.map((r) => String(r.detail));
  assert.ok(plan.some((d) => /idx_citation_doc_counts_shared/.test(d)), plan.join(' | '));
});
