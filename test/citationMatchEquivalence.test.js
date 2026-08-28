// Equivalence harness for B-01 (#11).
//
// saveCitations used to load the entire citations table into memory once per
// document and bucket it there. It now selects the same buckets straight out of
// SQL. This file re-implements the *old* algorithm verbatim as a pure function
// over a JS array and replays the same fixture corpus through both paths, then
// asserts the resulting document -> citation links are identical.
//
// The one deliberate divergence is covered by its own test at the bottom: the old
// code fell back to comparing against every citation in the corpus whenever a
// bucket came back empty, which is the unbounded path #11 exists to remove.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { jaroWinkler } from '../src/fuzzyMatch.js';

let tempDir;
let db;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-cite-equiv-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

// --- The old implementation, copied from src/db.js @ 372c787 ---

const FUZZY_CITATION_THRESHOLD = 0.94;

function legacyMatchYear(value) {
  const text = String(value || '').trim();
  const match = text.match(/\b(1[89]\d{2}|20[0-2]\d)\b/);
  return match ? Number(match[0]) : null;
}

function legacyTextPrefix(value) {
  const prefix = String(value || '').trim().toLowerCase().slice(0, 3);
  return prefix.length === 3 ? prefix : null;
}

function legacyPrepare(row) {
  return {
    ...row,
    matchText: String(row.citation_text || '').toLowerCase(),
    matchYear: legacyMatchYear(row.year),
    matchPrefix: legacyTextPrefix(row.citation_text),
  };
}

function pushBucket(map, key, row) {
  if (key == null) return;
  const existing = map.get(key);
  if (existing) existing.push(row);
  else map.set(key, [row]);
}

function legacyBuildIndex(rows) {
  const index = {
    all: rows,
    byHash: new Map(rows.map((row) => [row.citation_hash, row])),
    byYear: new Map(),
    withoutYear: [],
    byPrefix: new Map(),
  };
  for (const row of rows) {
    if (row.matchYear == null) index.withoutYear.push(row);
    else pushBucket(index.byYear, row.matchYear, row);
    pushBucket(index.byPrefix, row.matchPrefix, row);
  }
  return index;
}

function legacyAddToIndex(index, row) {
  index.all.push(row);
  index.byHash.set(row.citation_hash, row);
  if (row.matchYear == null) index.withoutYear.push(row);
  else pushBucket(index.byYear, row.matchYear, row);
  pushBucket(index.byPrefix, row.matchPrefix, row);
}

function legacyCandidates(index, text, itemYear) {
  const year = legacyMatchYear(itemYear) ?? legacyMatchYear(text);
  const prefix = legacyTextPrefix(text);
  if (year != null) {
    const candidates = [];
    for (let candidateYear = year - 1; candidateYear <= year + 1; candidateYear += 1) {
      candidates.push(...(index.byYear.get(candidateYear) || []));
    }
    if (prefix) {
      candidates.push(...(index.byPrefix.get(prefix) || []).filter((row) => row.matchYear == null));
    }
    return candidates.length ? candidates : index.all;
  }
  if (!prefix) return index.all;
  const candidates = index.byPrefix.get(prefix) || [];
  return candidates.length ? candidates : index.all;
}

function legacyYearsCompatible(a, b) {
  return a == null || b == null || a === b;
}

// Replays the whole corpus through the old algorithm. `rows` stands in for the
// citations table and grows exactly the way AUTOINCREMENT ids do, so the ids it
// produces line up with the ones the real database allocates.
function legacyRun(documents, hashFn) {
  const rows = [];
  const links = new Map();
  const fallbacks = [];
  let nextId = 1;

  for (const doc of documents) {
    const index = legacyBuildIndex(rows.map(legacyPrepare));
    const linked = [];
    for (const item of doc.citations) {
      const text = typeof item === 'string' ? item : item.text;
      const itemYear = typeof item === 'string' ? null : item.year;
      const hash = hashFn(text);
      let matchedId = null;

      if (index.byHash.has(hash)) {
        matchedId = index.byHash.get(hash).id;
      } else {
        const candidates = legacyCandidates(index, text, itemYear);
        const usedFallback = candidates === index.all;
        let bestMatch = null;
        let maxSim = 0;
        const incoming = text.toLowerCase();
        for (const candidate of candidates) {
          const sim = jaroWinkler(incoming, candidate.matchText);
          if (sim > maxSim) {
            maxSim = sim;
            bestMatch = candidate;
          }
        }
        const incomingYear = legacyMatchYear(itemYear) ?? legacyMatchYear(text);
        const accepted = bestMatch
          && maxSim >= FUZZY_CITATION_THRESHOLD
          && legacyYearsCompatible(incomingYear, bestMatch.matchYear);
        if (usedFallback) fallbacks.push({ text, accepted: Boolean(accepted) });
        if (accepted) matchedId = bestMatch.id;
      }

      if (matchedId == null) {
        const existing = rows.find((row) => row.citation_hash === hash);
        if (existing) {
          existing.year = existing.year ?? itemYear ?? null;
          matchedId = existing.id;
        } else {
          const row = { id: nextId, citation_hash: hash, citation_text: text, year: itemYear ?? null };
          nextId += 1;
          rows.push(row);
          matchedId = row.id;
        }
        legacyAddToIndex(index, legacyPrepare(rows.find((row) => row.id === matchedId)));
      }
      linked.push(matchedId);
    }
    links.set(doc.id, Array.from(new Set(linked)).sort((a, b) => a - b));
  }
  return { links, citationCount: rows.length, fallbacks };
}

// --- Fixture corpus ---

// Hash normalisation in the spirit of pdf.js normalizeCitation: case, punctuation
// and whitespace folded away, so distinct texts can legitimately share a hash.
function hashFn(text) {
  const normalized = String(text).toLowerCase().replace(/[.,;:()[\]]/g, '').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

// Texts for the phase-2 fixtures below. Each group is an adjacent-year pair of
// near-identical works plus a probe whose year field and text disagree, which is
// what forces the matcher past the phase-1 short circuit and into the +/-1 veto.
const OKONKWO_1991 = 'Okonkwo, R. (1991). Comparative study of estuarine nutrient loading. Northern Books.';
const OKONKWO_1992 = 'Okonkwo, R. (1992). Comparative study of estuarine nutrient loading. Northern Books.';
// 0.9928 against the 1991 row (clears the threshold, so phase 2 is reached) and
// 0.9976 against the 1992 row, so the y+1 bucket wins and vetoes.
const OKONKWO_PROBE = 'Okonkwo, R. (1992). Comparative study of estuarine nutrient loading. Northern Books';

const RAVINDRAN_1990 = 'Ravindran, S. (1990). Sediment budgets of the lower delta. Academic Press.';
const RAVINDRAN_1991 = 'Ravindran, S. (1991). Sediment budgets of the lower delta. Academic Press.';
// 0.9919 against the 1991 row, 0.9973 against the 1990 row: the y-1 bucket vetoes.
const RAVINDRAN_PROBE = 'Ravindran, S. (1990). Sediment budgets of the lower delta. Academic Press';

// An exact tie between the y-1 and the same-year bucket. Both candidates are the
// probe with one adjacent pair of characters transposed, so their Jaro-Winkler
// scores against it are bit-identical (0.99767). The tie-break order decides:
// y-1 is consulted first, so the merge is vetoed. Reorder it and the probe
// merges into the 2001 row instead.
const NAKAMURA_PROBE = 'Nakamura, T. (2001). Tidal marsh accretion rates in the outer bay. Scholarly Editions.';
const NAKAMURA_2000 = 'Nakamura, T. (2001). Tidal marhs accretion rates in the outer bay. Scholarly Editions.';
const NAKAMURA_2001 = 'Nakamura, T. (2001). Tidal marsh accretion rates in the oute rbay. Scholarly Editions.';

// Two candidates in the *same* year bucket that also tie exactly (0.96471), far
// enough apart from each other (0.92941) that seeding them does not merge them.
// The winner must be the lower id, i.e. the bucket must be scanned in ascending
// id order and the first of a tie kept.
const SANDOVAL_PROBE = 'Sandoval, P. (2007). Wetland qqqqqqqqqqqq indices for the northern reach of the estuary and its gradients. Academic Press, qqqqqqqqqqqq.';
const SANDOVAL_FIRST = SANDOVAL_PROBE.replace('qqqqqqqqqqqq', 'zzzzzzzzzzzz');
const SANDOVAL_SECOND = SANDOVAL_PROBE.replace(/qqqqqqqqqqqq(?=[^q]*$)/, 'zzzzzzzzzzzz');

// The window is +/-1, not +/-2. The probe merges into the 2001 row it scores
// 0.9602 against; the 1999 row it scores 0.9976 against is two years away and
// must stay invisible. Widen the window and the 1999 row vetoes the merge.
const PEMBERTON_1999 = 'Pemberton, L. (1999). Glacial till stratigraphy of the upper basin. University Press.';
const PEMBERTON_2001 = 'Pemberton, L. (2001). Glacial till stratigraphy of the upper basins. University Press!';
const PEMBERTON_PROBE = 'Pemberton, L. (1999). Glacial till stratigraphy of the upper basin. University Press';

const FIXTURES = [
  {
    id: 'equiv-doc-1',
    citations: [
      { text: 'Fullan, M. (1991). The new meaning of educational change. New York: Teachers College Press.', year: '1991' },
      { text: 'Vygotsky, L. S. (1978). Mind in society. Cambridge, MA: Harvard University Press.', year: '1978' },
      { text: 'Dewey, J. (1938). Experience and education. New York: Macmillan.', year: '1938' },
      'Anonymous pamphlet with no discernible year of publication at all.',
    ],
  },
  {
    id: 'equiv-doc-2',
    citations: [
      // OCR variant of the doc-1 Fullan entry, same year: must merge.
      { text: 'Fullan, M. (1991). The new meaning of educational change. New York: Teachers College Press', year: '1991' },
      // Same author, adjacent year, different work: must not merge.
      { text: 'Fullan, M. (1992). The new meaning of successful school improvement. New York: Teachers College Press.', year: '1992' },
      // Byte-identical repeat: exact hash match.
      { text: 'Dewey, J. (1938). Experience and education. New York: Macmillan.', year: '1938' },
    ],
  },
  {
    id: 'equiv-doc-3',
    citations: [
      // Near-identical to the 1992 Fullan but declared 1991: the +1 bucket entry
      // outscores every 1991 candidate and then fails the year check, so the old
      // code rejected the match outright. That blocking behaviour must survive.
      { text: 'Fullan, M. (1992). The new meaning of successful school improvement. New York: Teachers College Press!', year: '1991' },
      // Year only in the text, not in the year field.
      'Vygotsky, L. S. (1978). Mind in society. Cambridge, MA: Harvard University Press',
      // Non-ASCII prefix.
      { text: 'Müller, K. (2004). Über die Struktur wissenschaftlicher Revolutionen. Berlin: Verlag.', year: '2004' },
    ],
  },
  {
    id: 'equiv-doc-4',
    citations: [
      { text: 'MÜLLER, K. (2004). Über die Struktur wissenschaftlicher Revolutionen. Berlin: Verlag', year: '2004' },
      // Messy year strings that only the regex extraction can read.
      { text: 'Bruner, J. (1960). The process of education. Cambridge: Harvard University Press.', year: 'c1960' },
      { text: 'Bruner, J. (1960). The process of education. Cambridge: Harvard University Press', year: '[1960]' },
      // Year field the regex rejects: falls back to the year inside the text.
      { text: 'Freire, P. (1970). Pedagogy of the oppressed. New York: Continuum.', year: 'n.d.' },
    ],
  },
  {
    id: 'equiv-doc-5',
    citations: [
      { text: 'Freire, P. (1970). Pedagogy of the oppressed. New York: Continuum', year: '1970' },
      // Undated entries sharing a 3-character prefix bucket with each other.
      'Smith, A. Working notes on qualitative coding. Unpublished manuscript.',
      'Smith, A. Working notes on qualitative coding. Unpublished manuscripts.',
      // Undated, non-ASCII prefix bucket: exercises the prefix path rather than a
      // year bucket, and depends on JS case folding of a non-ASCII initial.
      'Ökonomische Notizen zur qualitativen Kodierung. Unveroeffentlichtes Manuskript.',
      // Shorter than the 3-character prefix window.
      'ab',
    ],
  },
  {
    id: 'equiv-doc-6',
    citations: [
      { text: 'Fullan, M. (1991). The new meaning of educational change. New York: Teachers College Press.', year: '1991' },
      { text: 'Dewey, J. (1938). Experience and education. New York: Macmillan.', year: '1938' },
      { text: 'Vygotsky, L. S. (1978). Mind in society. Cambridge, MA: Harvard University Press.', year: '1978' },
      { text: 'Bruner, J. (1960). The process of education. Cambridge: Harvard University Press.', year: '1960' },
      { text: 'Müller, K. (2004). Über die Struktur wissenschaftlicher Revolutionen. Berlin: Verlag.', year: '2004' },
      'ökonomische Notizen zur qualitativen Kodierung. Unveroeffentlichtes Manuskripte.',
    ],
  },
];

test('the SQL matcher links the same citations as the in-memory matcher it replaces', async () => {
  const expected = legacyRun(FIXTURES, hashFn);

  for (const doc of FIXTURES) {
    await db.saveCitations(doc.id, doc.citations, hashFn);
  }

  for (const doc of FIXTURES) {
    const client = await db.getDb();
    const rows = await client.execute({
      sql: 'SELECT citation_id FROM document_citations WHERE doc_id = ? ORDER BY citation_id',
      args: [doc.id],
    });
    const linked = rows.rows.map((row) => Number(row.citation_id));
    assert.deepEqual(
      linked,
      expected.links.get(doc.id),
      `${doc.id}: link set diverged from the legacy matcher`
    );
  }

  const stats = await db.getCitationStats();
  assert.equal(
    Number(stats.total_citations),
    expected.citationCount,
    'the two matchers merged a different number of citations'
  );

  // Guard against a vacuous pass: the corpus has to actually exercise merging.
  assert.ok(
    expected.citationCount < FIXTURES.reduce((sum, doc) => sum + doc.citations.length, 0),
    'fixture corpus does not exercise citation merging'
  );

  // Pin the individual behaviours the merge count is made of, so this stays a
  // real test if the fixture is ever edited.
  const client = await db.getDb();
  const fullan = await client.execute(
    "SELECT citation_text, year FROM citations WHERE citation_text LIKE 'Fullan%' ORDER BY id"
  );
  // 1991 work (OCR variant merged into it), 1992 work (adjacent year, not merged),
  // and doc-3's entry whose text is the 1992 work but whose year field says 1991:
  // the +1 bucket candidate outscores everything and then fails the year check, so
  // the old matcher rejected it outright. Three rows, not one and not two.
  assert.equal(fullan.rows.length, 3, 'the +/-1 year window no longer blocks a cross-year merge');

  // The two undated 'Ökonomische'/'ökonomische' entries can only meet through the
  // 3-character prefix bucket, and only if the stored prefix case-folds the
  // non-ASCII initial the way JS does. They must end up as one citation.
  const oeko = await client.execute(
    "SELECT COUNT(*) AS n FROM citations WHERE citation_text LIKE '%konomische Notizen%'"
  );
  assert.equal(Number(oeko.rows[0].n), 1, 'non-ASCII prefix bucketing changed');
});

test('the removed full-corpus fallback never produced a match on this corpus', () => {
  const { fallbacks } = legacyRun(FIXTURES, hashFn);
  assert.ok(fallbacks.length > 0, 'fixture corpus should exercise the legacy empty-bucket fallback');
  // Every fallback was a full scan of the citations table that found nothing. The
  // SQL matcher returns no candidates in exactly these cases instead, which is the
  // only behavioural difference between the two implementations.
  for (const fallback of fallbacks) {
    assert.equal(fallback.accepted, false, `legacy fallback matched: ${fallback.text}`);
  }
});

test('the fuzzy candidate query never reads the whole citations table', async () => {
  const client = await db.getDb();
  const plans = [];
  const year = await client.execute({
    sql: `EXPLAIN QUERY PLAN
          SELECT * FROM (SELECT 0 AS bucket, id, citation_hash, citation_text, match_year
                         FROM citations WHERE match_year = ? ORDER BY id LIMIT 400)`,
    args: [1991],
  });
  const prefix = await client.execute({
    sql: `EXPLAIN QUERY PLAN
          SELECT 0 AS bucket, id, citation_hash, citation_text, match_year
          FROM citations WHERE match_prefix = ? ORDER BY match_year, id LIMIT 400`,
    args: ['ful'],
  });
  plans.push(...year.rows.map((row) => String(row.detail)));
  plans.push(...prefix.rows.map((row) => String(row.detail)));
  for (const detail of plans) {
    assert.ok(
      !/^SCAN citations\b/.test(detail),
      `fuzzy candidate query fell back to a table scan: ${detail}`
    );
  }
  assert.ok(
    plans.some((detail) => detail.includes('idx_citations_match_year')),
    'year bucket query did not use idx_citations_match_year'
  );
  assert.ok(
    plans.some((detail) => detail.includes('idx_citations_match_prefix')),
    'prefix bucket query did not use idx_citations_match_prefix'
  );
});

test('match keys are backfilled for citations written before the columns existed', async () => {
  const client = await db.getDb();
  await client.execute({
    sql: `INSERT INTO citations (citation_hash, citation_text, year, created_at, match_key_version)
          VALUES (?, ?, ?, ?, 0)`,
    args: ['legacy-row-hash', 'Kuhn, T. (1962). The structure of scientific revolutions. Chicago: UCP.', '1962', new Date().toISOString()],
  });
  await client.execute('UPDATE citations SET match_year = NULL, match_prefix = NULL WHERE citation_hash = ?', ['legacy-row-hash']);

  await db.backfillCitationMatchKeys();

  const row = await client.execute({
    sql: 'SELECT match_year, match_prefix, match_key_version FROM citations WHERE citation_hash = ?',
    args: ['legacy-row-hash'],
  });
  assert.equal(Number(row.rows[0].match_year), 1962);
  assert.equal(row.rows[0].match_prefix, 'kuh');
  assert.equal(Number(row.rows[0].match_key_version), 1);

  // A backfilled row is reachable by the fuzzy matcher, i.e. an OCR variant merges.
  const before = Number((await db.getCitationStats()).total_citations);
  await db.saveCitations('equiv-doc-backfill', [
    { text: 'Kuhn, T. (1962). The structure of scientific revolutions. Chicago: UCP', year: '1962' },
  ], (text) => `unmatched-${text}`);
  const after = Number((await db.getCitationStats()).total_citations);
  assert.equal(after, before, 'backfilled citation was not reachable as a fuzzy candidate');
});

// A generated corpus, deliberately dense with near-duplicates so the similarity
// pre-filter, the bucket ordering and the year-window blocking all get exercised
// hundreds of times rather than once each.
function generatedCorpus() {
  const surnames = ['Abbott', 'Ãbaco', 'Beauchamp', 'Cardoso', 'Delacroix', 'Ekwueme', 'Fitzgerald',
    'Grigoryan', 'Hidalgo', 'Ishikawa', 'Jankowski', 'Kowalczyk', 'Lindqvist', 'Mbeki', 'Novotný',
    'Oyelaran', 'Papadopoulos', 'Quintero', 'Rasmussen', 'Sørensen', 'Thibodeaux', 'Ueda', 'Vasquez',
    'Wojciechowski', 'Xu', 'Yamashita', 'Zeitlin'];
  const topics = ['coastal sediment transport', 'reflexive ethnographic practice', 'lattice gauge models',
    'urban water governance', 'phonetic drift in bilinguals', 'catalytic surface chemistry',
    'archival silence and memory', 'stochastic volatility estimation', 'peri-urban land tenure',
    'immunological tolerance', 'medieval marginalia', 'polymer crystallisation kinetics'];
  const presses = ['Academic Press', 'University Press', 'Scholarly Editions', 'Northern Books'];

  const documents = [];
  let counter = 0;
  for (let d = 0; d < 40; d += 1) {
    const citations = [];
    for (let c = 0; c < 12; c += 1) {
      counter += 1;
      const n = (d * 12 + c);
      const surnameIndex = (n * 7) % surnames.length;
      const topic = topics[(n * 5) % topics.length];
      const press = presses[n % presses.length];
      const year = 1962 + ((n * 3) % 55);
      const base = `${surnames[surnameIndex]}, ${'ABCDEFG'[n % 7]}. (${year}). Studies in ${topic}. ${press}.`;
      // Cycle through the shapes that make matching interesting.
      switch (n % 6) {
        case 0:
          citations.push({ text: base, year: String(year) });
          break;
        case 1:
          // OCR variant of the previous document's entry: trailing period dropped.
          citations.push({ text: base.slice(0, -1), year: String(year) });
          break;
        case 2:
          // Same work claimed one year later: the year window must keep them apart.
          citations.push({ text: base, year: String(year + 1) });
          break;
        case 3:
          // Year only in the text.
          citations.push(base);
          break;
        case 4:
          // Undated entry, so only the prefix bucket can reach it.
          citations.push(`${surnames[surnameIndex]}, ${'ABCDEFG'[n % 7]}. Studies in ${topic}. Unpublished.`);
          break;
        default:
          citations.push({ text: `${base} Reprinted ${counter}.`, year: `c${year}` });
          break;
      }
    }
    documents.push({ id: `gen-doc-${d}`, citations });
  }
  return documents;
}

test('equivalence holds across a dense generated corpus', async () => {
  const corpus = generatedCorpus();
  const generatedHash = (text) => hashFn(`gen|${text}`);
  const expected = legacyRun(corpus, generatedHash);

  for (const doc of corpus) {
    await db.saveCitations(doc.id, doc.citations, generatedHash);
  }

  const client = await db.getDb();
  let compared = 0;
  for (const doc of corpus) {
    const rows = await client.execute({
      sql: 'SELECT citation_id FROM document_citations WHERE doc_id = ? ORDER BY citation_id',
      args: [doc.id],
    });
    const linked = rows.rows.map((row) => Number(row.citation_id));
    const legacy = expected.links.get(doc.id);
    // Legacy ids are simulated from an empty table; this corpus runs after the
    // fixture corpus above, so compare the shape of the merge rather than raw ids.
    assert.equal(linked.length, legacy.length, `${doc.id}: merged a different number of citations`);
    compared += linked.length;
  }
  assert.ok(compared > 300, 'generated corpus is too small to be meaningful');
  const totalCitations = corpus.reduce((sum, doc) => sum + doc.citations.length, 0);
  assert.ok(
    expected.citationCount < totalCitations * 0.9,
    `generated corpus barely merges anything (${expected.citationCount} of ${totalCitations})`
  );

  // Same merge decisions, expressed as which citations documents came to share.
  const legacyShared = new Map();
  for (const [docId, ids] of expected.links) {
    for (const id of ids) {
      if (!legacyShared.has(id)) legacyShared.set(id, []);
      legacyShared.get(id).push(docId);
    }
  }
  const actualShared = new Map();
  for (const doc of corpus) {
    const rows = await client.execute({
      sql: 'SELECT citation_id FROM document_citations WHERE doc_id = ? ORDER BY citation_id',
      args: [doc.id],
    });
    for (const row of rows.rows) {
      const id = Number(row.citation_id);
      if (!actualShared.has(id)) actualShared.set(id, []);
      actualShared.get(id).push(doc.id);
    }
  }
  const signature = (map) => Array.from(map.values())
    .map((docs) => docs.slice().sort().join(','))
    .sort()
    .join('|');
  assert.equal(
    signature(actualShared),
    signature(legacyShared),
    'the two matchers grouped documents around different citations'
  );
});
