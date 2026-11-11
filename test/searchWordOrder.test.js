import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDb,
  ensureStorage,
  queryCachedDocumentPage,
  queryPeoplePage,
  saveDocumentMetadata,
  searchTerms,
} from '../src/db.js';

// Search matches each word on its own, in any order: authors are stored
// surname-first ("LeBlanc, Michael"), so "Michael LeBlanc" must still find them.

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const SYNC_KEY = `test-search-word-order-${suffix}`;

test.before(async () => {
  await ensureStorage();
  const base = {
    affiliation: ['Curriculum and Pedagogy, Department of'], degree: 'Doctor of Education - EdD',
    program: 'Curriculum Studies', subjects: ['Education'], themes: [], methodologies: [], conceptTerms: [],
  };
  await saveDocumentMetadata({
    ...base, id: `search-a-${suffix}`, title: 'By the bootstraps', author: 'LeBlanc, Michael',
    authors: ['LeBlanc, Michael'], year: 2025, abstract: 'Grassroots computing.', supervisors: ['Jane Quill'],
  }, { syncKey: SYNC_KEY });
  await saveDocumentMetadata({
    ...base, id: `search-b-${suffix}`, title: 'Habermas sans culottes', author: 'LeBlanc, Richard',
    authors: ['LeBlanc, Richard'], year: 2014, abstract: 'Political theory.', supervisors: ['Omar Reyes'],
  }, { syncKey: SYNC_KEY });
});

test.after(async () => {
  await closeDb();
});

const authorsFor = async (q) => (await queryCachedDocumentPage({ syncKey: SYNC_KEY, q, limit: 50 }))
  .documents.map((d) => d.author).sort();

test('a name typed first-name-first finds a surname-first author', async () => {
  assert.deepEqual(await authorsFor('Michael LeBlanc'), ['LeBlanc, Michael']);
  assert.deepEqual(await authorsFor('michael   leblanc'), ['LeBlanc, Michael']);
});

test('surname-first, with or without the comma, still finds the author', async () => {
  assert.deepEqual(await authorsFor('LeBlanc, Michael'), ['LeBlanc, Michael']);
  assert.deepEqual(await authorsFor('LeBlanc Michael'), ['LeBlanc, Michael']);
});

test('every word must match: a single shared word keeps both, an extra word narrows', async () => {
  assert.deepEqual(await authorsFor('LeBlanc'), ['LeBlanc, Michael', 'LeBlanc, Richard']);
  assert.deepEqual(await authorsFor('LeBlanc 2014'), ['LeBlanc, Richard']);
  assert.deepEqual(await authorsFor('Michael Habermas'), []);
});

test('words can match different fields (author and supervisor)', async () => {
  assert.deepEqual(await authorsFor('Quill LeBlanc'), ['LeBlanc, Michael']);
});

test('the People search matches each word too', async () => {
  const names = async (q) => (await queryPeoplePage({ syncKey: SYNC_KEY, q, limit: 50 })).people.map((p) => p.name);
  assert.deepEqual(await names('Quill, Jane'), ['Jane Quill']);
  assert.deepEqual(await names('Jane Quill'), ['Jane Quill']);
});

test('quoted text is one phrase; other words still match on their own', () => {
  assert.deepEqual(searchTerms('"By the bootstraps" LeBlanc'), ['by the bootstraps', 'leblanc']);
  assert.deepEqual(searchTerms('\u201cBy  the bootstraps\u201d'), ['by the bootstraps']);
  assert.deepEqual(searchTerms('"teacher identity'), ['teacher', 'identity']);
  assert.deepEqual(searchTerms('""  , ;'), []);
  assert.deepEqual(searchTerms('a "b c" a'), ['a', 'b c']);
});

test('a quoted phrase keeps its word order', async () => {
  assert.deepEqual(await authorsFor('"by the bootstraps"'), ['LeBlanc, Michael']);
  assert.deepEqual(await authorsFor('"bootstraps the by"'), []);
  assert.deepEqual(await authorsFor('"LeBlanc, Michael"'), ['LeBlanc, Michael']);
  assert.deepEqual(await authorsFor('"Michael LeBlanc"'), []);
  assert.deepEqual(await authorsFor('"habermas sans" 2014'), ['LeBlanc, Richard']);
});
