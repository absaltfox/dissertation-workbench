// A small corpus shaped like the production skew that the covering-index and
// affiliation-projection work targets: one dominant degree, a few small ones,
// NULL years/titles, ties on year and title, restricted documents, and every
// awkward `$.affiliation` shape. Shared by the equivalence, trigger and
// migration tests. Synthetic only.

const DEGREES = ['Master of Arts - MA', 'Master of Arts - MA', 'Master of Arts - MA', 'Master of Arts - MA', 'Doctor of Philosophy - PhD', 'Master of Science - MSc', null];
const PROGRAMS = ['Education', 'Education', 'Physics', 'Nursing', 'Education', null, 'Physics'];

// The affiliation values the filter must treat identically with and without the
// projection: array, scalar string, missing, JSON null, empty strings, duplicates,
// case/whitespace variants, nested arrays, non-string members.
const AFFILIATIONS = [
  ['UBC'],
  ['University of British Columbia'],
  ['  Ubc  '],
  ['The University of British Columbia', 'SFU'],
  'UBC',
  undefined,
  null,
  [''],
  ['UBC', 'UBC'],
  ['UBC', 'ubc', ' UBC', 'Ubc'],
  [['UBC']],
  ['Simon Fraser University'],
  [123],
  [null, 'University of Victoria'],
  ['   '],
  [],
  ['uvic'],
];

export const AFFILIATION_FILTER_INPUTS = ['UBC', 'ubc', 'sfu', 'University of Victoria', 'uvic', 'Simon Fraser University', 'nobody', '123', '["UBC"]'];

export const FILTER_CASES = [
  { name: 'none', filters: {} },
  { name: 'degree MA', filters: { degree: 'Master of Arts - MA' } },
  { name: 'degree PhD', filters: { degree: 'Doctor of Philosophy - PhD' } },
  { name: 'program', filters: { program: 'Education' } },
  { name: 'degree+program', filters: { degree: 'Master of Arts - MA', program: 'Education' } },
  ...AFFILIATION_FILTER_INPUTS.map((affiliation) => ({ name: `affiliation ${affiliation}`, filters: { affiliation } })),
  { name: 'affiliation+degree', filters: { affiliation: 'UBC', degree: 'Master of Arts - MA' } },
  { name: 'affiliation+program', filters: { affiliation: 'sfu', program: 'Education' } },
];

export const CORPUS_SYNC_KEY = 'corpus-scope-a';

export function corpusDocument(index) {
  const id = `corp-${String(index).padStart(4, '0')}`;
  const doc = {
    id,
    // Every sixth title is shared (ties on year and title), every thirteenth is missing.
    title: index % 13 === 0 ? undefined : (index % 6 === 0 ? 'Tied title' : `Thesis ${index % 40} about topic ${index % 7}`),
    author: index % 17 === 0 ? undefined : `Author ${index % 25}`,
    year: index % 11 === 0 ? undefined : 2005 + (index % 12),
    degree: DEGREES[index % DEGREES.length] || undefined,
    program: PROGRAMS[(index * 3) % PROGRAMS.length] || undefined,
    abstract: `abstract ${index}`,
    themes: [`theme ${index % 5}`],
    conceptTerms: [`concept ${index % 6}`, `concept ${(index + 2) % 6}`, 'shared concept'],
    methodologies: [index % 2 ? 'Qualitative' : 'Quantitative'],
    supervisors: [`Supervisor ${index % 9}`],
    charCount: 1000 + index,
  };
  const affiliation = AFFILIATIONS[index % AFFILIATIONS.length];
  if (affiliation !== undefined) doc.affiliation = affiliation;
  if (index % 23 === 5) {
    doc.accessStatus = 'embargoed';
    doc.availableAt = '2999-01-01T00:00:00.000Z';
  } else if (index % 29 === 7) {
    doc.accessStatus = 'verification_due';
  }
  return doc;
}

export function corpusItems(count = 140) {
  return Array.from({ length: count }, (_, index) => ({
    doc: corpusDocument(index),
    syncKey: index % 4 === 0 ? CORPUS_SYNC_KEY : null,
  }));
}

// Saves the corpus plus the rows the serving queries join to: topics (with one
// competing topic for some documents so the best-topic window matters), coords
// and file metrics (so the pages/wordCount sorts have values and NULLs).
export async function seedServingCorpus(db, count = 140) {
  const items = corpusItems(count);
  for (let start = 0; start < items.length; start += 50) {
    await db.saveDocumentMetadataBatch(items.slice(start, start + 50));
  }
  const client = await db.getDb();
  const now = new Date().toISOString();
  const statements = [0, 1, 2, 3, 4].map((topicId) => ({
    sql: `INSERT OR REPLACE INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at)
          VALUES (?, ?, '[]', 0, 'fixture', ?)`,
    args: [topicId, `Topic ${topicId}`, now],
  }));
  items.forEach(({ doc }, index) => {
    if (index % 9 !== 8) {
      statements.push({
        sql: 'INSERT OR REPLACE INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, ?)',
        args: [doc.id, index % 5, 0.9 - (index % 4) * 0.1],
      });
      if (index % 3 === 0) {
        statements.push({
          sql: 'INSERT OR REPLACE INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, ?)',
          args: [doc.id, (index + 1) % 5, 0.5],
        });
      }
      statements.push({
        sql: 'INSERT OR REPLACE INTO document_topic_coords (doc_id, umap_x, umap_y) VALUES (?, ?, ?)',
        args: [doc.id, index / 10, index / 20],
      });
    }
    if (index % 4 !== 3) {
      statements.push({
        sql: `INSERT OR REPLACE INTO file_metrics (doc_id, page_count, word_count, body_word_count, status, updated_at)
              VALUES (?, ?, ?, ?, 'ok', ?)`,
        args: [doc.id, index % 7 === 0 ? null : 50 + (index % 30), 5000 + index * 37, 4000 + index * 31, now],
      });
    }
  });
  await client.batch(statements, 'write');
  return items;
}
