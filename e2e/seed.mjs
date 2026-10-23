// Fixture corpus for browser smoke tests. Small but shaped like the real
// data: multiple degrees/years/programs so filters and per-year charts have
// something to draw, shared supervisors so Person Explorer groups, and a
// shared citation so Citation Explorer lists it.
import { ensureStorage, saveDocumentMetadata, saveFileMetric, saveCitations, saveCommitteeMembers } from '../src/db.js';
import { persistConceptArtifact } from '../src/conceptsPipeline.js';
import { FIXTURE_DOCS } from './fixture-docs.mjs';

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
}
