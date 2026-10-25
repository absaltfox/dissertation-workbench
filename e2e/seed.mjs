// Fixture corpus for browser smoke tests. Small but shaped like the real
// data: multiple degrees/years/programs so filters and per-year charts have
// something to draw, shared supervisors so Person Explorer groups, and a
// shared citation so Citation Explorer lists it.
import { ensureStorage, getDb, saveDocumentMetadata, saveFileMetric, saveCitations, saveCommitteeMembers } from '../src/db.js';
import { persistConceptArtifact } from '../src/conceptsPipeline.js';
import { FIXTURE_DOCS, FIXTURE_TOPICS } from './fixture-docs.mjs';

const SHARED_CITATION = 'Vygotsky, L. S. (1978). Mind in society. Harvard University Press.';

export async function seedFixtureCorpus() {
  await ensureStorage();

  // Writing a successful concept artifact also writes status.json with
  // lastSuccessAt, which stops start() from spawning a startup concept
  // rebuild worker (see startConceptRebuildJob in src/server.js).
  const canonicals = [...new Set(FIXTURE_DOCS.flatMap((d) => d.conceptTerms))];
  await persistConceptArtifact({
    version: 1,
    source: { documents: FIXTURE_DOCS.length },
    stats: { concepts: canonicals.length, aliases: 0 },
    concepts: canonicals.map((canonical) => ({ canonical, variants: [], docFreq: 1, idf: 1 })),
    variantToCanonical: {},
  }, { trigger: 'e2e-seed' });

  for (const doc of FIXTURE_DOCS) {
    await saveDocumentMetadata({
      id: doc.id,
      title: doc.title,
      author: doc.author,
      year: doc.year,
      date: String(doc.year),
      degree: doc.degree,
      program: doc.program,
      affiliation: ['University of British Columbia'],
      supervisors: doc.supervisors,
      abstract: `Fixture abstract for ${doc.title}.`,
      subjects: [doc.program],
      conceptTerms: doc.conceptTerms,
      methodologies: doc.methodologies,
    }, { syncKey: null });
    await saveFileMetric(doc.id, {
      status: 'cached',
      pdfPath: null,
      downloadUrl: '',
      fileBytes: 1000,
      wordCount: doc.words,
      pageCount: doc.pages,
      wordSource: 'e2e',
      pageSource: 'e2e',
    });
  }

  await saveCitations('e2e-doc-1', [{ text: SHARED_CITATION }], (t) => String(t).toLowerCase());
  await saveCitations('e2e-doc-2', [{ text: SHARED_CITATION }], (t) => String(t).toLowerCase());
  await saveCommitteeMembers('e2e-doc-3', [
    { name: 'Jane Supervisor', role: 'University Examiner', affiliation: 'UBC' },
  ], 'e2e');

  await seedTopics();
}

// BERTopic output is written by scripts/build-topics.py, so the fixture inserts
// the published tables directly: two topics, an assignment and UMAP coords per doc.
async function seedTopics() {
  const client = await getDb();
  const now = new Date().toISOString();
  for (const topic of FIXTURE_TOPICS) {
    const docCount = FIXTURE_DOCS.filter((d) => d.topicId === topic.topicId).length;
    await client.execute({
      sql: `INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at)
            VALUES (?, ?, '[]', ?, 'e2e', ?)`,
      args: [topic.topicId, topic.label, docCount, now],
    });
  }
  for (const [i, doc] of FIXTURE_DOCS.entries()) {
    await client.execute({
      sql: 'INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, 0.9)',
      args: [doc.id, doc.topicId],
    });
    await client.execute({
      sql: 'INSERT INTO document_topic_coords (doc_id, umap_x, umap_y) VALUES (?, ?, ?)',
      args: [doc.id, i, doc.topicId * 5],
    });
  }
}
