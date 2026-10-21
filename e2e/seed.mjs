// Fixture corpus for browser smoke tests. Small but shaped like the real
// data: multiple degrees/years/programs so filters and per-year charts have
// something to draw, shared supervisors so Person Explorer groups, and a
// shared citation so Citation Explorer lists it.
import { ensureStorage, saveDocumentMetadata, saveFileMetric, saveCitations, saveCommitteeMembers } from '../src/db.js';
import { persistConceptArtifact } from '../src/conceptsPipeline.js';

export const FIXTURE_DOCS = [
  { id: 'e2e-doc-1', title: 'Teaching Mathematics Through Play', author: 'Avery Author', year: 2016, degree: 'Doctor of Philosophy - PhD', program: 'Curriculum Studies', supervisors: ['Jane Supervisor'], conceptTerms: ['mathematics education', 'play-based learning'], methodologies: ['Case Study'], pages: 210, words: 62000 },
  { id: 'e2e-doc-2', title: 'Indigenous Land-Based Pedagogy', author: 'Blake Author', year: 2018, degree: 'Doctor of Philosophy - PhD', program: 'Educational Studies', supervisors: ['Jane Supervisor'], conceptTerms: ['land-based pedagogy', 'indigenous education'], methodologies: ['Narrative Inquiry'], pages: 245, words: 71000 },
  { id: 'e2e-doc-3', title: 'Assessment Practices in Secondary Science', author: 'Casey Author', year: 2019, degree: 'Doctor of Education - EdD', program: 'Educational Leadership', supervisors: ['Alex Supervisor'], conceptTerms: ['classroom assessment', 'science education'], methodologies: ['Survey'], pages: 180, words: 54000 },
  { id: 'e2e-doc-4', title: 'Teacher Identity and Early Career Attrition', author: 'Dana Author', year: 2021, degree: 'Doctor of Philosophy - PhD', program: 'Curriculum Studies', supervisors: ['Alex Supervisor'], conceptTerms: ['teacher identity', 'mathematics education'], methodologies: ['Interview'], pages: 230, words: 66000 },
  { id: 'e2e-doc-5', title: 'Digital Literacies in Rural Schools', author: 'Emery Author', year: 2023, degree: 'Master of Arts - MA', program: 'Language and Literacy Education', supervisors: ['Morgan Supervisor'], conceptTerms: ['digital literacy'], methodologies: ['Ethnography'], pages: 120, words: 38000 },
];

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
