// Builds a throwaway DB for the research-area bands e2e: the standard fixture
// corpus plus nine topics in three meaning clusters, cached embeddings, a
// topics_generation, one topic_label_overrides row and a known admin login.
// Usage: node e2e/bands-prepare.mjs <dataDir> [topicCount=9] [--seed-bands]
// With --seed-bands, one research-area band per topic is inserted directly into
// topic_bands (no Python needed) and topic_bands_version is set.
import { mkdirSync } from 'node:fs';
import { bandsServerEnv, BAND_TOPICS, ADMIN_PASSWORD } from './bands-env.mjs';

const dataDir = process.argv[2];
const TOPIC_COUNT = Number(process.argv[3] || 9);
const SEED_BANDS = process.argv.includes('--seed-bands');
if (!dataDir) throw new Error('usage: bands-prepare.mjs <dataDir>');
mkdirSync(dataDir, { recursive: true });
const env = bandsServerEnv(dataDir, 0);
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, env);

const { seedFixtureCorpus } = await import('./seed.mjs');
const { FIXTURE_DOCS } = await import('./fixture-docs.mjs');
const { getDb, saveDocumentMetadata, saveFileMetric, saveStoredEmbeddings, setSetting, createUser } = await import('../src/db.js');
const { createPasswordHash } = await import('../src/auth.js');

await seedFixtureCorpus();
const client = await getDb();

// Replace the fixture's two topics with the nine-topic layout.
for (const table of ['topics', 'document_topics', 'document_topic_coords']) {
  await client.execute(`DELETE FROM ${table}`);
}

const TOPICS = [...BAND_TOPICS];
for (let id = BAND_TOPICS.length; id < TOPIC_COUNT; id += 1) {
  TOPICS.push({ id, label: `Extra Topic ${id}`, terms: [`extra${id}`, 'research', 'schools'] });
}
TOPICS.length = Math.min(TOPICS.length, TOPIC_COUNT);

const docs = FIXTURE_DOCS.map((d, i) => ({ id: d.id, topic: i % TOPIC_COUNT }));
for (let n = 0; n < 27; n += 1) {
  const id = `band-doc-${n}`;
  const topic = n % TOPIC_COUNT;
  await saveDocumentMetadata({
    id, title: `Band fixture manuscript ${n}`, author: `Band Author ${n}`, year: 2012 + (n % 10),
    date: String(2012 + (n % 10)), degree: 'Doctor of Philosophy - PhD', program: 'Curriculum Studies',
    affiliation: ['University of British Columbia'], supervisors: ['Jane Supervisor'],
    abstract: `Fixture abstract about ${TOPICS[topic].terms.join(' ')} number ${n}.`,
    subjects: ['Curriculum Studies'], conceptTerms: [], methodologies: [],
  }, { syncKey: null });
  await saveFileMetric(id, { status: 'cached', pdfPath: null, downloadUrl: '', fileBytes: 1000, wordCount: 50000, pageCount: 200, wordSource: 'e2e', pageSource: 'e2e' });
  docs.push({ id, topic });
}

const now = new Date().toISOString();
for (const t of TOPICS) {
  const count = docs.filter((d) => d.topic === t.id).length;
  await client.execute({
    sql: "INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, ?, ?, 'e2e', ?)",
    args: [t.id, t.label, JSON.stringify(t.terms.map((term, i) => [term, 0.5 - i * 0.1])), count, now],
  });
}

// Deterministic embeddings: cluster c points along axis c of an 8-d space, with a
// small per-topic and per-document offset so centroids differ but clusters are obvious.
const embeddings = [];
for (const [i, d] of docs.entries()) {
  const cluster = d.topic % 3;
  const vec = new Array(8).fill(0);
  vec[cluster] = 1;
  vec[3 + (d.topic % 5)] += 0.04 * (1 + Math.floor(d.topic / 3));
  vec[7] += 0.01 * ((i % 4) - 1.5);
  embeddings.push({ docId: d.id, embedding: vec });
  await client.execute({ sql: 'INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, 0.9)', args: [d.id, d.topic] });
  await client.execute({ sql: 'INSERT INTO document_topic_coords (doc_id, umap_x, umap_y) VALUES (?, ?, ?)', args: [d.id, cluster * 10 + (i % 3), d.topic] });
}
await saveStoredEmbeddings(embeddings);

await setSetting('topics_generation', '2026-11-03T00:00:00.000Z');
await client.execute({
  sql: "INSERT INTO topic_label_overrides (topic_id, label, source, candidate_id, created_at, updated_at, generation) VALUES (1, 'Curated Literacy Label', 'manual', NULL, ?, ?, '2026-11-03T00:00:00.000Z')",
  args: [now, now],
});

if (SEED_BANDS) {
  for (const t of TOPICS) {
    const count = docs.filter((d) => d.topic === t.id).length;
    await client.execute({
      sql: 'INSERT INTO topic_bands (band_id, label, child_topic_ids, doc_count, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [t.id, `Area ${t.id + 1} Alpha`, JSON.stringify([t.id]), count, now],
    });
  }
  await setSetting('topic_bands_version', now);
}

const { hash, salt } = createPasswordHash(ADMIN_PASSWORD);
await createUser('admin', hash, salt);
console.log(`prepared ${docs.length} docs, ${TOPICS.length} topics in ${dataDir}`);
process.exit(0);
