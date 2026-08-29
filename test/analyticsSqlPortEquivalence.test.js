import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// #15: JS-vs-SQL cross-check for the two corrected ports (topicData.byYear,
// supervisorNgramMatrix) on an identical fixture, proving behavioral
// equivalence rather than assuming it. Both ports are exercised through
// their real production entry points: the JS side via
// buildMetricsPayloadFromRecords (the same function the below-threshold
// route calls), the SQL side via getDocumentServingAnalytics (the
// above-threshold route's DB-aggregate path).

let closeDb;
let ensureStorage;
let getDb;
let saveDocumentMetadataBatch;
let saveCommitteeMembers;
let listCachedDocuments;
let applyCommitteeMembersToDocuments;
let getDocumentServingAnalytics;
let buildMetricsPayloadFromRecords;
let tempDir;

const SYNC_KEY = 'sql-port-equivalence';
const TOTAL_DOCUMENTS = 220;

function fixtureDoc(index) {
  // Docs 0-109: metadata-sourced supervisors only, drawn from a pool of 8 so
  // several supervisors clear a meaningful doc-count threshold.
  // Docs 110-219: NO metadata supervisor at all — their only supervisor
  // comes from a committee-sourced document_people row added below,
  // specifically exercising the corrected filter (role IN (...) regardless
  // of source) against the superseded (source='metadata'-only) design.
  const hasMetadataSupervisor = index < 110;
  return {
    id: `sqlport-${String(index).padStart(4, '0')}`,
    title: `SQL port fixture ${index}`,
    author: `Author ${index}`,
    year: 2000 + (index % 20),
    degree: 'PhD',
    program: 'Education',
    affiliation: ['UBC'],
    supervisors: hasMetadataSupervisor ? [`Metadata Supervisor ${index % 8}`] : [],
    abstract: `abstract ${index}`,
    subjects: ['education'],
    conceptTerms: ['concept alpha', 'concept beta', `concept gamma ${index % 6}`],
    methodologies: [index % 2 === 0 ? 'Qualitative' : 'Quantitative'],
    charCount: 500 + index,
  };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-sql-port-equiv-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.NODE_ENV = 'test';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');

  const db = await import('../src/db.js');
  ({
    closeDb, ensureStorage, getDb, saveDocumentMetadataBatch, saveCommitteeMembers,
    listCachedDocuments, applyCommitteeMembersToDocuments, getDocumentServingAnalytics,
  } = db);
  ({ buildMetricsPayloadFromRecords } = await import('../src/metrics.js'));
  await ensureStorage();

  const items = Array.from({ length: TOTAL_DOCUMENTS }, (_, i) => ({ doc: fixtureDoc(i), syncKey: SYNC_KEY }));
  for (let start = 0; start < items.length; start += 50) {
    await saveDocumentMetadataBatch(items.slice(start, start + 50));
  }

  // Committee-only supervisors for docs 110-219 (no metadata supervisor at
  // all) — a source='committee' document_people row, distinct from
  // 'metadata'. Each committee-only doc gets exactly one supervisor from a
  // small pool of 4 names, so this pool clears the "top 12 supervisors" cut
  // alongside the metadata-sourced pool above.
  for (let i = 110; i < TOTAL_DOCUMENTS; i++) {
    const docId = `sqlport-${String(i).padStart(4, '0')}`;
    await saveCommitteeMembers(docId, [
      { name: `Committee Supervisor ${i % 4}`, role: 'Supervisor' },
    ], 'committee');
  }

  // A real topic hierarchy: 14 leaf topics merged down to 10 parent
  // clusters (4 merges), so topicData.byYear's parent-cluster resolution is
  // genuinely exercised (not the "N <= targetK, no merges" trivial case).
  const client = await getDb();
  const now = new Date().toISOString();
  const topicRows = Array.from({ length: 14 }, (_, i) => ({
    topicId: i, label: `Topic ${i}`, docCount: TOTAL_DOCUMENTS - i, // distinct doc counts: no ranking ties
  }));
  await client.batch(topicRows.map((t) => ({
    sql: `INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, '[]', ?, 'test', ?)`,
    args: [t.topicId, t.label, t.docCount, now],
  })), 'write');
  // Assign each document to a leaf topic (round-robin over the 14 leaves).
  await client.batch(Array.from({ length: TOTAL_DOCUMENTS }, (_, i) => ({
    sql: 'INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, 0.9)',
    args: [`sqlport-${String(i).padStart(4, '0')}`, i % 14],
  })), 'write');
  // Merge leaves [0,1]->14, [2,3]->15, [4,5]->16, [6,7]->17 (4 merges,
  // 14 leaves - 4 merges = 10 components = targetK exactly).
  const leafTopicIds = topicRows.map((t) => t.topicId);
  const linkage = [[0, 1], [2, 3], [4, 5], [6, 7]];
  await client.execute({
    sql: `INSERT INTO topic_hierarchy_meta (id, leaf_topic_ids, linkage_json, created_at) VALUES (1, ?, ?, ?)`,
    args: [JSON.stringify(leafTopicIds), JSON.stringify(linkage), now],
  });
});

test.after(async () => {
  await closeDb?.();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

async function computeJsPath() {
  const records = await listCachedDocuments({ syncKey: SYNC_KEY });
  await applyCommitteeMembersToDocuments(records);
  const payload = await buildMetricsPayloadFromRecords(records, { generatedAt: 'test' }, 25);
  return payload;
}

test('#15 cross-check: supervisorNgramMatrix — SQL port matches the JS path on an identical fixture, including committee-only (non-metadata-source) supervisors', async () => {
  const jsPayload = await computeJsPath();
  const sqlPayload = await getDocumentServingAnalytics({ syncKey: SYNC_KEY });

  const jsMatrix = jsPayload.supervisorNgramMatrix;
  const sqlMatrix = sqlPayload.supervisorNgramMatrix;

  assert.deepEqual([...jsMatrix.supervisors].sort(), [...sqlMatrix.supervisors].sort());
  // The committee-only supervisor pool must actually be present in both —
  // proving the fix isn't accidentally passing by omission (e.g. a
  // source='metadata'-only filter would silently drop this entire pool).
  const committeeSupervisorsInSql = sqlMatrix.supervisors.filter((name) => name.startsWith('Committee Supervisor'));
  assert.ok(committeeSupervisorsInSql.length > 0, 'committee-sourced supervisors must appear in the SQL port');
  assert.deepEqual([...jsMatrix.ngrams].sort(), [...sqlMatrix.ngrams].sort());

  // Compare the matrix cell-by-cell after aligning both sides' row/column
  // order (ranking ties are avoided by fixture design, so alignment via
  // sorted labels is sufficient — no ordering ambiguity to paper over).
  const jsSupIndex = new Map(jsMatrix.supervisors.map((name, i) => [name, i]));
  const sqlSupIndex = new Map(sqlMatrix.supervisors.map((name, i) => [name, i]));
  const jsNgIndex = new Map(jsMatrix.ngrams.map((name, i) => [name, i]));
  const sqlNgIndex = new Map(sqlMatrix.ngrams.map((name, i) => [name, i]));
  for (const name of jsMatrix.supervisors) {
    for (const ngram of jsMatrix.ngrams) {
      const jsValue = jsMatrix.matrix[jsSupIndex.get(name)][jsNgIndex.get(ngram)];
      const sqlValue = sqlMatrix.matrix[sqlSupIndex.get(name)][sqlNgIndex.get(ngram)];
      assert.equal(sqlValue, jsValue, `mismatch at supervisor="${name}" ngram="${ngram}": js=${jsValue} sql=${sqlValue}`);
    }
  }
});

test('#15 cross-check: topicData.byYear — SQL port resolves to parent-cluster id via the same buildParentClusters algorithm as the JS path', async () => {
  const jsPayload = await computeJsPath();
  const sqlPayload = await getDocumentServingAnalytics({ syncKey: SYNC_KEY });

  const jsByYear = jsPayload.topicData.byYear;
  const sqlByYear = sqlPayload.topicData.byYear;

  assert.equal(jsByYear.length, sqlByYear.length);
  assert.ok(jsByYear.length > 0, 'fixture must actually produce byYear rows');

  const sortByTopicId = (rows) => [...rows].sort((a, b) => a.topicId - b.topicId);
  const jsSorted = sortByTopicId(jsByYear);
  const sqlSorted = sortByTopicId(sqlByYear);
  for (let i = 0; i < jsSorted.length; i++) {
    assert.equal(sqlSorted[i].topicId, jsSorted[i].topicId);
    assert.equal(sqlSorted[i].label, jsSorted[i].label);
    const sortData = (data) => [...data].sort((a, b) => a.year - b.year);
    assert.deepEqual(sortData(sqlSorted[i].data), sortData(jsSorted[i].data));
  }

  // Sanity: this must be a genuine parent-cluster resolution, not a
  // pass-through of raw leaf topic ids — confirm at least one returned
  // topicId is one of the merge-produced parent ids (>= 14, since leaves
  // are 0-13 and merges start at index 14) OR, if parent ids were
  // re-indexed to 0-9 after sorting by docCount (buildParentClusters does
  // this), confirm the byYear rows total more documents per topic than any
  // single leaf could contribute alone (14 leaves round-robin over 220 docs
  // is ~15-16 docs/leaf; a merged cluster combining two leaves should show
  // a noticeably higher total for at least one entry).
  const totalsByTopic = sqlByYear.map((t) => t.data.reduce((sum, d) => sum + d.count, 0));
  const maxTotal = Math.max(...totalsByTopic);
  const singleLeafApprox = Math.ceil(TOTAL_DOCUMENTS / 14) + 2;
  assert.ok(
    maxTotal > singleLeafApprox,
    `expected at least one parent cluster to combine multiple leaves' documents ` +
    `(max total ${maxTotal}, single-leaf approx ${singleLeafApprox}) — otherwise this fixture ` +
    `doesn't actually exercise the merge path`
  );
});
