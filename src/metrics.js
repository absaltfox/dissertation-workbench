import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_BASE_URL, DEFAULT_INDEX, DEFAULT_API_KEY, DEFAULT_QUERY,
  DEFAULT_TERM, DEFAULT_SOURCE, DEFAULT_DOWNLOAD_FILES, PDF_CACHE_DIR, SQLITE_PATH, DATA_DIR
} from './config.js';
import { ensureStorage, getDb, saveRunMetrics, hasTopics, loadTopics, loadDocumentTopics, loadDocumentTopicCoords, loadTopicHierarchy, getCitationCooccurrence } from './db.js';
import {
  toArray, flattenText, extractYear, parsePageCount, buildWordCloud,
  buildMethodologyStats, extractNgrams, detectMethodologies, isLowSignalConceptPhrase,
  isLowSignalConceptTerm, buildDocumentFrequency, topTfidfTermsFromText
} from './nlp.js';
import { fetchPage, extractHits, resolveIndexName, collectCandidateUrls } from './api.js';
import { enrichDocumentsWithFileAnalysis } from './pdf.js';
import { dedupeSupervisorNames } from './supervisors.js';
import { canonicalizeDomainText } from './domainDictionary.js';

function average(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stats(numbers) {
  if (!numbers.length) return { count: 0, min: null, max: null, mean: null };
  return {
    count: numbers.length,
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    mean: average(numbers)
  };
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function firstPresent(obj, keys) {
  for (const key of keys) {
    const val = obj?.[key];
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return null;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractOcId(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const directId = text.match(/^\d+\.\d+$/);
  if (directId) return directId[0];

  const itemMatch = text.match(/\/items\/(\d+\.\d+)(?:[/?#]|$)/i);
  if (itemMatch) return itemMatch[1];

  const pdfMatch = text.match(/\/pdf\/\d+\/(\d+\.\d+)(?:[/?#]|$)/i);
  if (pdfMatch) return pdfMatch[1];

  return null;
}

export function ensureSourceFields(sourceValue) {
  const parts = String(sourceValue || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const seen = new Set(parts.map((part) => part.toLowerCase()));
  for (const field of ['id', 'identifier', 'uri']) {
    if (!seen.has(field)) {
      parts.push(field);
      seen.add(field);
    }
  }
  return parts.join(',');
}

export function normalizeRecord(doc, dict = null) {
  const rawId = flattenText(firstPresent(doc, ['_id', 'id', 'identifier', 'Identifier'])) || '';
  const title = flattenText(firstPresent(doc, ['title', 'Title', 'name', 'Name']));
  const creators = toArray(firstPresent(doc, ['creator', 'Creator', 'author', 'Author']));
  const supervisors = dedupeSupervisorNames(toArray(firstPresent(doc, ['supervisor', 'Supervisor'])));
  const affiliation = toArray(firstPresent(doc, ['affiliation', 'Affiliation']));
  const dateRaw = firstPresent(doc, [
    'date_available', 'DateAvailable', 'dateAvailable',
    'dateIssued', 'DateIssued',
    'graduationDate', 'GraduationDate',
    'ubc_date_sort',
    'date', 'Date',
    'year', 'Year',
    'issued', 'Issued'
  ]);

  const description = flattenText(firstPresent(doc, ['description', 'Description', 'abstract', 'Abstract']));
  const fullText = flattenText(firstPresent(doc, ['full_text', 'FullText', 'transcript', 'text', 'ocr', 'body']));
  const subjects = toArray(firstPresent(doc, ['subject', 'Subject', 'subjects', 'keywords', 'keyword']));
  const program = toArray(firstPresent(doc, ['program_theses', 'program', 'Program']));
  const degree = toArray(firstPresent(doc, ['degree_theses', 'degree', 'Degree']));
  const genre = toArray(firstPresent(doc, ['genre', 'Genre']));
  const extentValues = toArray(firstPresent(doc, ['extent', 'Extent']));
  const uri = flattenText(firstPresent(doc, ['uri', 'URI', 'isShownAt', 'identifier', 'Identifier']));
  const rights = flattenText(firstPresent(doc, ['rights', 'Rights']));
  const doi = flattenText(firstPresent(doc, ['doi', 'DOI']));
  const campus = flattenText(firstPresent(doc, ['campus', 'Campus']));
  const scholarlyLevel = flattenText(firstPresent(doc, ['scholarly_level', 'scholarlyLevel', 'ScholarlyLevel']));
  const downloadCandidates = collectCandidateUrls(doc, rawId, doi);
  const derivedId = extractOcId(rawId) || extractOcId(uri) || downloadCandidates.map(extractOcId).find(Boolean);
  const stableId = derivedId || `${title}:${creators[0] || ''}`;

  const textForLength = fullText || description;
  const cleaned = String(textForLength).replace(/\s+/g, ' ').trim();
  const metadataWords = cleaned ? cleaned.split(' ').length : 0;
  const extentPages = parsePageCount(extentValues);
  const metadataPages = extentPages || Math.max(1, Math.round((metadataWords || 1) / 300));

  const methodologies = detectMethodologies([title, description, subjects.join(' ')].join(' '));
  const conceptTerms = docConceptTerms({ title, abstract: description, subjects }, 12, dict);

  return {
    id: stableId,
    title,
    authors: creators,
    author: creators[0] || 'Unknown',
    supervisors,
    supervisorsSource: supervisors.length ? 'api' : null,
    affiliation,
    date: dateRaw ? String(dateRaw) : '',
    year: extractYear(dateRaw),
    degree: degree.join('; '),
    program: program.join('; '),
    type: genre.join('; '),
    rights,
    doi,
    campus,
    scholarlyLevel,
    extent: extentValues.join('; '),
    pages: metadataPages,
    pagesSource: extentPages ? 'metadata_extent' : 'estimated_from_metadata_words',
    abstract: description,
    subjects: subjects.length ? subjects : ['(Unspecified)'],
    wordCount: metadataWords,
    wordCountSource: 'metadata_text',
    charCount: cleaned.length,
    themes: [],
    methodologies,
    conceptTerms,
    uri,
    downloadCandidates,
    downloadUrl: null,
    downloadStatus: 'not_attempted',
    downloadError: null,
    fileBytes: null,
    bodyWordCount: null
  };
}

// Word count is unreliable when the PDF exists but text extraction failed (scan-only):
// the stored count is just the abstract length, not the dissertation length.
function hasReliableWordCount(rec) {
  return rec.wordCountSource !== 'metadata_text' || !rec.fileBytes;
}

function buildMetrics(records, subjectLimit) {
  const conceptWords = new Map();
  const yearWords = new Map();
  const yearPages = new Map();

  for (const rec of records) {
    const reliableWords = hasReliableWordCount(rec);
    const activeWordCount = (rec.bodyWordCount != null) ? rec.bodyWordCount : rec.wordCount;
    const concepts = Array.from(new Set((rec.conceptTerms || []).filter(Boolean)));
    if (concepts.length) {
      const weight = 1 / concepts.length;
      for (const concept of concepts) {
        if (!conceptWords.has(concept)) {
          conceptWords.set(concept, { weightedWordSum: 0, weightSum: 0, docCount: 0 });
        }
        const entry = conceptWords.get(concept);
        if (reliableWords) entry.weightedWordSum += activeWordCount * weight;
        entry.weightSum += weight;
        entry.docCount += 1;
      }
    }

    if (rec.year) {
      if (!yearWords.has(rec.year)) yearWords.set(rec.year, []);
      if (!yearPages.has(rec.year)) yearPages.set(rec.year, []);
      if (reliableWords) yearWords.get(rec.year).push(activeWordCount);
      yearPages.get(rec.year).push(rec.pages);
    }
  }

  const byConcept = Array.from(conceptWords.entries())
    .map(([concept, values]) => ({
      concept,
      docCount: values.docCount,
      weightedDocEquivalent: values.weightSum,
      weightedMean: values.weightSum ? (values.weightedWordSum / values.weightSum) : null
    }))
    .sort((a, b) => b.docCount - a.docCount || (b.weightedMean || 0) - (a.weightedMean || 0))
    .slice(0, subjectLimit);

  const byYear = Array.from(yearWords.entries())
    .map(([year, values]) => ({ year: Number(year), ...stats(values) }))
    .sort((a, b) => a.year - b.year);

  const avgPagesByYear = Array.from(yearPages.entries())
    .map(([year, values]) => ({ year: Number(year), ...stats(values) }))
    .sort((a, b) => a.year - b.year);

  const pageTrend = Array.from(yearPages.entries())
    .map(([year, values]) => ({
      year: Number(year),
      median: median(values),
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length
    }))
    .sort((a, b) => a.year - b.year);

  return {
    recordCount: records.length,
    overallWordCount: stats(records.filter(hasReliableWordCount).map((r) => r.wordCount)),
    overallPageCount: stats(records.map((r) => r.pages)),
    overallCharCount: stats(records.map((r) => r.charCount)),
    byConcept,
    byYear,
    avgPagesByYear,
    pageTrend
  };
}

function docNgrams(rec, limit = 8) {
  const text = [rec.title, rec.abstract, rec.subjects.join(' ')].join(' ');
  const counts = new Map();
  for (const n of [2, 3, 4]) {
    for (const ng of extractNgrams(text, n)) {
      const normalized = canonicalizeDomainText(ng);
      if (!normalized || isLowSignalConceptPhrase(normalized)) continue;
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }
  const entries = Array.from(counts.entries())
    .map(([term, count]) => ({ term, count, tokens: term.split(' ') }))
    .sort((a, b) => b.tokens.length - a.tokens.length || b.count - a.count);
  const kept = [];
  for (const entry of entries) {
    const isSubphrase = kept.some((longer) => {
      if (longer.tokens.length <= entry.tokens.length) return false;
      const maxStart = longer.tokens.length - entry.tokens.length;
      for (let start = 0; start <= maxStart; start++) {
        let ok = true;
        for (let i = 0; i < entry.tokens.length; i++) {
          if (longer.tokens[start + i] !== entry.tokens[i]) {
            ok = false;
            break;
          }
        }
        if (ok) return true;
      }
      return false;
    });
    if (!isSubphrase) kept.push(entry);
  }

  return kept
    .filter((entry) => entry.tokens.length <= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((entry) => entry.term);
}

function loadConceptDictionary() {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'concepts', 'latest.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    const conceptMeta = new Map();
    for (const concept of (parsed.concepts || [])) {
      if (!concept?.canonical) continue;
      conceptMeta.set(concept.canonical, {
        docFreq: Number(concept.docFreq) || 0,
        idf: Number(concept.idf) || 1,
      });
    }
    const canonicalSet = new Set((parsed.concepts || [])
      .map((c) => c.canonical)
      .filter((term) => !isLowSignalConceptTerm(term)));
    const variantMap = parsed.variantToCanonical || {};
    const idfMap = new Map((parsed.concepts || []).map((c) => [c.canonical, c.idf ?? 1]));
    const sourceDocuments = Number(parsed?.source?.documents) || 0;
    // Multi-doc concepts appear in 2+ documents and are the only ones that can
    // co-occur across the corpus. Single-doc concepts (docFreq=1) dominate the
    // IDF-based ranking but are useless for co-occurrence analysis.
    const multiDocSet = new Set((parsed.concepts || []).filter((c) => (c.docFreq ?? 1) >= 2).map((c) => c.canonical));
    return { canonicalSet, variantMap, idfMap, conceptMeta, multiDocSet, sourceDocuments };
  } catch {
    return { canonicalSet: new Set(), variantMap: {}, idfMap: new Map(), conceptMeta: new Map(), multiDocSet: new Set(), sourceDocuments: 0 };
  }
}

export function buildMetricsSourceOptions(options = {}) {
  const maxRecords = Number(options.maxRecords || 200);
  const pageSize = Number(options.pageSize || 20);
  const scanLimit = Number(options.scanLimit || Math.max(maxRecords * 10, 1000));
  const subjectLimit = Number(options.subjectLimit || 25);
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const requestedIndex = options.index !== undefined ? options.index : DEFAULT_INDEX;
  const apiKey = options.apiKey || DEFAULT_API_KEY;
  const query = options.query === undefined ? DEFAULT_QUERY : options.query;
  const term = options.term === undefined ? DEFAULT_TERM : options.term;
  const source = ensureSourceFields(options.source === undefined ? DEFAULT_SOURCE : options.source);
  const downloadFiles = options.downloadFiles === undefined ? DEFAULT_DOWNLOAD_FILES : Boolean(options.downloadFiles);
  const forceDownload = Boolean(options.forceDownload);
  const recomputeFromCache = Boolean(options.recomputeFromCache);
  return {
    maxRecords, pageSize, scanLimit, subjectLimit, baseUrl, requestedIndex,
    apiKey, query, term, source, downloadFiles, forceDownload, recomputeFromCache
  };
}

export function buildDocumentSyncKey({ baseUrl, requestedIndex, query, term, source }) {
  return JSON.stringify({
    baseUrl,
    requestedIndex: requestedIndex || '',
    query: query || '',
    term: term || '',
    source: ensureSourceFields(source || ''),
  });
}

function docConceptTerms(rec, limit = 12, dict = null) {
  const { canonicalSet, variantMap, idfMap, conceptMeta, sourceDocuments } = dict || loadConceptDictionary();
  const tf = new Map();

  // Title concepts are counted with 3× weight: title language is denser and
  // more intentionally chosen than abstract prose, so title bigrams should
  // outrank abstract-only bigrams even when all have the same IDF.
  // Split on delimiters to prevent cross-boundary n-grams (e.g. "teachers grassroots
  // computing" spanning subtitle boundary in "bootstraps : teachers, grassroots computing").
  const TITLE_WEIGHT = 3;
  const titleSegments = (rec.title || '').split(/[:;,]/).map((s) => s.trim()).filter(Boolean);
  for (const seg of titleSegments) {
    for (const n of [2, 3]) {
      for (const ng of extractNgrams(seg, n)) {
        const term = canonicalizeDomainText(ng);
        if (!term) continue;
        const canonical = variantMap[term] || (canonicalSet.has(term) ? term : null);
        if (!canonical || isLowSignalConceptTerm(canonical)) continue;
        tf.set(canonical, (tf.get(canonical) || 0) + TITLE_WEIGHT);
      }
    }
  }

  // Split abstract and subjects on "/" to prevent slash-notation artifacts
  // (e.g. "coordinators/directors" → "coordinators directors" bigram).
  const bodySegments = [
    ...(rec.abstract || '').split(/[/,]/),  // "/" and "," both act as phrase boundaries
    ...(rec.subjects || []).join('/')        // "/" join keeps each subject as its own segment
      .split('/')
  ].map((s) => s.trim()).filter(Boolean);
  for (const seg of bodySegments) {
    for (const n of [2, 3]) {
      for (const ng of extractNgrams(seg, n)) {
        const term = canonicalizeDomainText(ng);
        if (!term) continue;
        const canonical = variantMap[term] || (canonicalSet.has(term) ? term : null);
        if (!canonical || isLowSignalConceptTerm(canonical)) continue;
        tf.set(canonical, (tf.get(canonical) || 0) + 1);
      }
    }
  }

  return Array.from(tf.entries())
    .map(([canonical, count]) => {
      const meta = conceptMeta?.get(canonical) || {};
      const docFreq = Number(meta.docFreq) || 0;
      const idf = Number(meta.idf) || Number(idfMap.get(canonical)) || Math.log(((sourceDocuments || 1) + 1) / (docFreq + 1)) + 1;
      const lengthBonus = canonical.split(/\s+/).length >= 3 ? 0.35 : 0;
      return { canonical, count, score: count * idf + lengthBonus };
    })
    .filter((entry) => entry.score >= 1.2)
    .sort((a, b) => b.score - a.score || b.count - a.count || a.canonical.localeCompare(b.canonical))
    .slice(0, limit)
    .map(({ canonical }) => canonical);
}

function themeTextForRecord(rec) {
  return [rec.title, rec.abstract, rec.subjects.join(' '), rec.program, rec.degree].join(' ');
}

function assignTfidfThemes(records, limit = 12) {
  const documentFrequency = buildDocumentFrequency(records, themeTextForRecord);
  for (const rec of records) {
    rec.themes = topTfidfTermsFromText(themeTextForRecord(rec), documentFrequency, records.length, limit);
  }
}

function buildConceptCloud(records, maxTerms = 60) {
  const counts = new Map();
  for (const rec of records) {
    for (const term of (rec.conceptTerms || [])) {
      // Exclude statistical boilerplate and generic academic filler so the cloud
      // reflects research topics rather than methodology vocabulary.
      if (!COOCCURRENCE_BLOCKLIST.has(term) && !isLowSignalConceptTerm(term)) {
        counts.set(term, (counts.get(term) || 0) + 1);
      }
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term, count]) => ({ term, count }));
}

function buildSupervisorNgramMatrix(records, topN = 12, topM = 10) {
  const dict = loadConceptDictionary();
  const supervisorCounts = new Map();
  const docConceptCache = new Map();
  // Only count concepts from records that have supervisors for better signal
  const supNgramCounts = new Map();

  for (const rec of records) {
    const terms = docConceptTerms(rec, 10, dict);
    const concepts = terms.map((label) => `c:${label.replace(/\s+/g, '_')}`);
    docConceptCache.set(rec.id, { concepts, labels: terms });
    const hasSup = rec.supervisors.length > 0;
    for (const sup of rec.supervisors) {
      supervisorCounts.set(sup, (supervisorCounts.get(sup) || 0) + 1);
    }
    if (hasSup) {
      for (const ng of concepts) {
        supNgramCounts.set(ng, (supNgramCounts.get(ng) || 0) + 1);
      }
    }
  }

  const topSupervisors = Array.from(supervisorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name]) => name);
  const topNgrams = Array.from(supNgramCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topM)
    .map(([conceptId]) => conceptId);

  const supSet = new Set(topSupervisors);
  const ngSet = new Set(topNgrams);

  const matrix = topSupervisors.map(() => topNgrams.map(() => 0));
  for (const rec of records) {
    const recSups = rec.supervisors.filter((s) => supSet.has(s));
    if (!recSups.length) continue;
    const recNgrams = (docConceptCache.get(rec.id)?.concepts || []).filter((ng) => ngSet.has(ng));
    for (const sup of recSups) {
      const si = topSupervisors.indexOf(sup);
      for (const ng of recNgrams) {
        const nj = topNgrams.indexOf(ng);
        matrix[si][nj] += 1;
      }
    }
  }

  const conceptIdToLabel = new Map();
  for (const { concepts, labels } of docConceptCache.values()) {
    for (let k = 0; k < concepts.length; k++) {
      conceptIdToLabel.set(concepts[k], labels[k]);
    }
  }

  return {
    supervisors: topSupervisors,
    ngrams: topNgrams.map((id) => conceptIdToLabel.get(id) || id),
    conceptIds: topNgrams,
    matrix
  };
}

// Non-topical phrases excluded from the concept cloud and co-occurrence panel.
// Covers three categories:
//   • Statistical / experimental-design vocabulary (quantitative boilerplate)
//   • Results-reporting boilerplate (findings indicate, results showed, …)
//   • Generic academic-writing filler (based upon, further investigation, …)
// Keep in sync with COOCCURRENCE_BLOCKLIST in public/app.js.
const COOCCURRENCE_BLOCKLIST = new Set([
  // Statistical and experimental design
  'significant differences', 'statistically significant', 'significant difference',
  'significant relationships', 'significant relationship', 'significantly related',
  'control group', 'treatment groups', 'treatment group',
  'experimental groups', 'experimental group', 'experimental design',
  'randomly assigned', 'randomly selected', 'random sample',
  'dependent variables', 'independent variables', 'dependent variable', 'independent variable',
  'predictor variables', 'criterion variables',
  'regression analysis', 'regression analyses', 'multiple regression', 'stepwise regression',
  'factor analysis', 'path analysis', 'discriminant analysis', 'canonical analysis',
  'analysis variance', 'multivariate analysis', 'repeated measures',
  'three groups', 'two groups',
  // Results / findings boilerplate
  'results indicated', 'results showed', 'results suggest', 'results revealed',
  'analysis revealed', 'analysis indicated', 'analyses indicated',
  'findings indicate', 'findings indicated', 'findings suggest',
  // Generic academic-writing filler
  'data analysis', 'data collected', 'data collection', 'data gathering', 'data sources',
  'analyzed using', 'semi structured', 'interview data',
  'attitudes toward', 'determine whether', 'based upon', 'directed towards',
  'further investigation', 'important factor', 'wide range',
  'higher levels', 'high levels', 'second part', 'first part',
  // Older psychometric / measurement instruments
  'main effects', 'significant main', 'interaction effects', 'post test',
  'discriminant function', 'tennessee self', 'concept scale',
  'native indian', // archaic, from older dissertations — not a useful discovery concept
]);

function buildTermCooccurrence(records, topN = 20) {
  const dict = loadConceptDictionary();
  const pairCounts = new Map();
  const termCounts = new Map(); // per-document frequency within this corpus view
  const N = records.length;

  for (const rec of records) {
    // Use a generous budget (20) so multi-doc concepts aren't crowded out by
    // high-IDF single-doc concepts occupying all the top slots.  Then keep only
    // multi-doc concepts: single-doc concepts (docFreq=1) can never co-occur
    // across documents so they would only reduce signal here.
    const concepts = docConceptTerms(rec, 20, dict);
    if (concepts.length < 2) continue;
    const unique = Array.from(new Set(concepts))
      .filter((c) => dict.multiDocSet.has(c))
      // Strip out statistical/experimental methodology boilerplate that clusters
      // trivially in quantitative studies regardless of topic. These belong in
      // the Methodology panel; including them here hides meaningful topic pairs.
      .filter((c) => !COOCCURRENCE_BLOCKLIST.has(c));
    for (const c of unique) termCounts.set(c, (termCounts.get(c) || 0) + 1);
    const sorted = [...unique].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|||${sorted[j]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  return Array.from(pairCounts.entries())
    .filter(([, count]) => count >= 2) // minimum co-occurrence (corpus is ~400 docs)
    .map(([key, count]) => {
      const [termA, termB] = key.split('|||');
      const freqA = termCounts.get(termA) || 1;
      const freqB = termCounts.get(termB) || 1;

      // Fragment filter: if one term almost never appears without the other,
      // they are likely sliding-window bigrams of the same longer phrase
      // (e.g. "pearson product" + "product moment" from "pearson product moment").
      if (count / Math.min(freqA, freqB) >= 0.7) return null;

      // NOTE: shared-token filter removed. In education research, many distinct
      // concepts share domain words (e.g. "public school" + "school district" share
      // "school") — filtering them out eliminates the most meaningful pairs in the
      // corpus. The fragment filter above is sufficient to catch sliding-window
      // bigrams, and the blocklist handles methodology boilerplate.

      // Lift: observed co-occurrence relative to what chance predicts.
      // Promotes genuinely surprising topic associations over common-term pairings.
      const lift = (count * N) / (freqA * freqB);
      return { key, count, termA, termB, freqA, freqB, lift };
    })
    .filter(Boolean)
    // Rank by lift (statistical surprise) then raw count as tiebreaker.
    .sort((a, b) => b.lift - a.lift || b.count - a.count)
    .slice(0, topN)
    .map(({ termA, termB, count, lift, freqA, freqB }) => ({
      conceptIdA: `c:${termA.replace(/\s+/g, '_')}`,
      conceptIdB: `c:${termB.replace(/\s+/g, '_')}`,
      termA,
      termB,
      count,
      lift: Math.round(lift * 10) / 10,
      freqA,
      freqB
    }));
}

function buildConceptTimeline(records, topN = 8) {
  const dict = loadConceptDictionary();
  const conceptDocCounts = new Map();
  const conceptYearCounts = new Map();

  for (const rec of records) {
    const concepts = docConceptTerms(rec, 12, dict);
    for (const concept of concepts) {
      conceptDocCounts.set(concept, (conceptDocCounts.get(concept) || 0) + 1);
      if (rec.year) {
        if (!conceptYearCounts.has(concept)) conceptYearCounts.set(concept, new Map());
        const yearMap = conceptYearCounts.get(concept);
        yearMap.set(rec.year, (yearMap.get(rec.year) || 0) + 1);
      }
    }
  }

  const topConcepts = Array.from(conceptDocCounts.entries())
    .filter(([concept]) => !COOCCURRENCE_BLOCKLIST.has(concept))
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([concept]) => concept);

  return topConcepts.map((concept) => {
    const yearMap = conceptYearCounts.get(concept) || new Map();
    const data = Array.from(yearMap.entries())
      .map(([year, count]) => ({ year: Number(year), count }))
      .sort((a, b) => a.year - b.year);
    return {
      concept,
      totalDocs: conceptDocCounts.get(concept) || 0,
      data
    };
  });
}

function buildMethodologyConceptMatrix(records, topM = 10, topC = 10) {
  const dict = loadConceptDictionary();
  const methodCounts = new Map();
  const conceptCounts = new Map();
  const docConceptCache = new Map();

  for (const rec of records) {
    const terms = docConceptTerms(rec, 10, dict);
    const concepts = terms.map((label) => `c:${label.replace(/\s+/g, '_')}`);
    docConceptCache.set(rec.id, { concepts, labels: terms });

    for (const m of (rec.methodologies || [])) {
      methodCounts.set(m, (methodCounts.get(m) || 0) + 1);
      for (const c of concepts) {
        conceptCounts.set(c, (conceptCounts.get(c) || 0) + 1);
      }
    }
  }

  const topMethodologies = Array.from(methodCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topM)
    .map(([name]) => name);
  const topConcepts = Array.from(conceptCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topC)
    .map(([conceptId]) => conceptId);

  const methSet = new Set(topMethodologies);
  const conSet = new Set(topConcepts);

  const matrix = topMethodologies.map(() => topConcepts.map(() => 0));
  for (const rec of records) {
    const recMeths = (rec.methodologies || []).filter((m) => methSet.has(m));
    if (!recMeths.length) continue;
    const recConcepts = (docConceptCache.get(rec.id)?.concepts || []).filter((c) => conSet.has(c));
    for (const m of recMeths) {
      const mi = topMethodologies.indexOf(m);
      for (const c of recConcepts) {
        const ci = topConcepts.indexOf(c);
        matrix[mi][ci] += 1;
      }
    }
  }

  const conceptIdToLabel = new Map();
  for (const { concepts, labels } of docConceptCache.values()) {
    for (let k = 0; k < concepts.length; k++) {
      conceptIdToLabel.set(concepts[k], labels[k]);
    }
  }

  return {
    methodologies: topMethodologies,
    concepts: topConcepts.map((id) => conceptIdToLabel.get(id) || id),
    conceptIds: topConcepts,
    matrix
  };
}

function buildParentClusters(hierarchy, topics, targetK = 10) {
  const { leafTopicIds, linkage } = hierarchy;
  const N = leafTopicIds.length;
  if (N <= targetK) {
    // Fewer leaves than target — each leaf is its own parent
    const parentClusters = topics.filter((t) => t.topicId !== -1).map((t, i) => ({
      parentId: i, topicId: i, label: t.label, docCount: t.docCount, children: [t.topicId],
    }));
    const leafToParent = new Map(parentClusters.map((p) => [p.children[0], p.parentId]));
    return { parentClusters, leafToParent };
  }

  // Union-find over N leaves + up to N-1 merge nodes
  const parent = new Array(N + linkage.length).fill(-1);
  const find = (x) => { while (parent[x] !== -1) x = parent[x]; return x; };
  const union = (a, b, into) => { parent[find(a)] = into; parent[find(b)] = into; };

  // Apply first N - targetK merges (linkage is sorted by distance)
  const mergesToApply = N - targetK;
  for (let m = 0; m < mergesToApply; m++) {
    const [i, j] = linkage[m];
    union(i, j, N + m);
  }

  // Collect connected components — each root is a parent cluster
  const rootToChildren = new Map();
  const leafIdxToTopicId = new Map();
  const topicDocCount = new Map(topics.map((t) => [t.topicId, t.docCount || 0]));
  for (let i = 0; i < N; i++) {
    leafIdxToTopicId.set(i, leafTopicIds[i]);
    const root = find(i);
    if (!rootToChildren.has(root)) rootToChildren.set(root, []);
    rootToChildren.get(root).push(leafTopicIds[i]);
  }

  const topicLabelMap = new Map(topics.map((t) => [t.topicId, t.label]));
  const parentClusters = [];
  const leafToParent = new Map();
  let parentIdx = 0;

  for (const [, children] of rootToChildren) {
    // Label = label of the child topic with the most docs
    const bestChild = children.reduce((best, tid) =>
      (topicDocCount.get(tid) || 0) > (topicDocCount.get(best) || 0) ? tid : best
    , children[0]);
    const totalDocs = children.reduce((sum, tid) => sum + (topicDocCount.get(tid) || 0), 0);
    parentClusters.push({
      parentId: parentIdx, topicId: parentIdx,
      label: topicLabelMap.get(bestChild) || `Cluster ${parentIdx}`,
      docCount: totalDocs, children,
    });
    for (const tid of children) leafToParent.set(tid, parentIdx);
    parentIdx++;
  }

  parentClusters.sort((a, b) => b.docCount - a.docCount);
  // Re-index after sort
  const oldToNew = new Map(parentClusters.map((p, i) => [p.parentId, i]));
  for (const p of parentClusters) p.parentId = p.topicId = oldToNew.get(p.parentId);
  for (const [tid, oldPid] of leafToParent) leafToParent.set(tid, oldToNew.get(oldPid));

  return { parentClusters, leafToParent };
}

function buildTopicsByYear(topics, documents, leafToParent) {
  const yearCounts = new Map(); // topicId -> Map<year, count>

  for (const doc of documents) {
    if (doc.topicId == null || !doc.year) continue;
    const resolvedId = leafToParent ? (leafToParent.get(doc.topicId) ?? doc.topicId) : doc.topicId;
    if (!yearCounts.has(resolvedId)) yearCounts.set(resolvedId, new Map());
    const ym = yearCounts.get(resolvedId);
    ym.set(doc.year, (ym.get(doc.year) || 0) + 1);
  }

  return topics
    .filter((t) => t.topicId !== -1)
    .slice(0, 10)
    .map((topic) => {
      const ym = yearCounts.get(topic.topicId) || new Map();
      const data = Array.from(ym.entries())
        .map(([year, count]) => ({ year: Number(year), count }))
        .sort((a, b) => a.year - b.year);
      return { topicId: topic.topicId, label: topic.label, data };
    });
}

function buildSupervisorNetwork(records, minEdge = 1) {
  const nodeMap = new Map(); // name -> docCount
  const edgeMap = new Map(); // "A|||B" -> { weight, docs }

  for (const rec of records) {
    const people = [];
    for (const s of (rec.supervisors || [])) people.push(s);
    if (rec.committee) {
      for (const m of rec.committee) {
        if (m.role === 'Supervisor' || m.role === 'Co-Supervisor' || m.role === 'Committee Member') {
          if (!people.includes(m.name)) people.push(m.name);
        }
      }
    }
    if (people.length === 0) continue;

    for (const p of people) {
      nodeMap.set(p, (nodeMap.get(p) || 0) + 1);
    }

    const sorted = [...people].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|||${sorted[j]}`;
        if (!edgeMap.has(key)) edgeMap.set(key, { weight: 0, docs: [] });
        const e = edgeMap.get(key);
        e.weight += 1;
        e.docs.push(rec.id);
      }
    }
  }

  // Top 30 nodes by docCount
  const topNodes = Array.from(nodeMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);
  const topSet = new Set(topNodes.map(([name]) => name));

  const nodes = topNodes.map(([id, docCount]) => ({ id, docCount }));
  const edges = Array.from(edgeMap.entries())
    .filter(([key, e]) => {
      const [a, b] = key.split('|||');
      return topSet.has(a) && topSet.has(b) && e.weight >= minEdge;
    })
    .map(([key, e]) => {
      const [source, target] = key.split('|||');
      return { source, target, weight: e.weight, docs: e.docs };
    });

  return { nodes, edges };
}

async function buildCitationCooccurrenceNetwork() {
  const rows = await getCitationCooccurrence(100);
  const nodeMap = new Map();

  for (const row of rows) {
    if (!nodeMap.has(row.id1)) nodeMap.set(row.id1, { id: row.id1, label: row.text1, freq: row.freq1 });
    if (!nodeMap.has(row.id2)) nodeMap.set(row.id2, { id: row.id2, label: row.text2, freq: row.freq2 });
  }

  const nodes = Array.from(nodeMap.values());
  const edges = rows.map(row => ({
    source: row.id1,
    target: row.id2,
    weight: row.shared
  }));

  return { nodes, edges };
}

function buildMethodologyTopicMatrix(records, topics) {
  const methCounts = new Map();
  const topicMap = new Map(topics.map(t => [t.topicId, t.label]));

  for (const rec of records) {
    for (const m of (rec.methodologies || [])) {
      methCounts.set(m, (methCounts.get(m) || 0) + 1);
    }
  }

  const topMethodologies = Array.from(methCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name]) => name);

  const validTopics = topics
    .filter(t => t.topicId !== -1)
    .slice(0, 8);

  const methSet = new Set(topMethodologies);
  const topicIdList = validTopics.map(t => t.topicId);
  const topicIdSet = new Set(topicIdList);

  const matrix = topMethodologies.map(() => topicIdList.map(() => 0));

  for (const rec of records) {
    if (rec.topicId == null || !topicIdSet.has(rec.topicId)) continue;
    const recMeths = (rec.methodologies || []).filter(m => methSet.has(m));
    const ti = topicIdList.indexOf(rec.topicId);
    for (const m of recMeths) {
      const mi = topMethodologies.indexOf(m);
      matrix[mi][ti] += 1;
    }
  }

  return {
    methodologies: topMethodologies,
    topics: validTopics.map(t => ({ topicId: t.topicId, label: t.label })),
    matrix
  };
}

export async function collectMetrics(options = {}) {
  await ensureStorage();
  await getDb();

  const {
    maxRecords, pageSize, scanLimit, subjectLimit, baseUrl, requestedIndex,
    apiKey, query, term, source, downloadFiles, forceDownload, recomputeFromCache
  } = buildMetricsSourceOptions(options);

  const index = requestedIndex ? await resolveIndexName(baseUrl, requestedIndex, apiKey) : null;
  const conceptDict = loadConceptDictionary();
  const records = [];
  let apiTotal = null; // populated from first response

  if (Array.isArray(options.cachedDocuments)) {
    records.push(...options.cachedDocuments);
  } else {
    for (let from = 0; from < scanLimit; from += pageSize) {
      const payload = await fetchPage({ baseUrl, index, apiKey, from, pageSize, query, term, source });
      const docs = extractHits(payload);

      // Capture the API-reported total on the first page
      if (apiTotal === null) {
        apiTotal = payload?.data?.hits?.total ?? null;
      }

      if (!docs.length) break;
      records.push(...docs.map((doc) => normalizeRecord(doc, conceptDict)));
      if (records.length >= maxRecords) break;

      // Stop when we've fetched everything the API has
      if (apiTotal !== null && records.length >= Math.min(apiTotal, maxRecords)) break;
      // Fallback: stop on a genuinely empty next page (don't stop on partial pages)
    }
  }

  const normalizedRecords = records.slice(0, maxRecords);

  if (!options.skipFileEnrichment) {
    await enrichDocumentsWithFileAnalysis(normalizedRecords, {
      downloadFiles,
      forceDownload,
      recomputeFromCache
    });
  }

  const sourceMeta = {
    baseUrl,
    index,
    requestedIndex,
    query,
    term,
    source,
    pageSize,
    maxRecords,
    scanLimit,
    usedApiKey: Boolean(apiKey),
    downloadFiles,
    forceDownload,
    recomputeFromCache,
    servedFromCache: Array.isArray(options.cachedDocuments),
    pdfCacheDir: PDF_CACHE_DIR,
    sqlitePath: SQLITE_PATH
  };

  assignTfidfThemes(normalizedRecords);

  const metrics = buildMetrics(normalizedRecords, subjectLimit);
  await saveRunMetrics(sourceMeta, metrics);

  // Load BERTopic results if available
  let topicData = null;
  if (await hasTopics()) {
    const topics = await loadTopics();
    const docTopics = await loadDocumentTopics();
    // Attach topic_id and UMAP coords to each document
    const topicCoords = await loadDocumentTopicCoords();
    for (const doc of normalizedRecords) {
      const dt = docTopics.get(doc.id);
      if (dt) {
        doc.topicId = dt.topicId;
        doc.topicProbability = dt.probability;
      }
      const coord = topicCoords.get(doc.id);
      if (coord) {
        doc.umapX = coord.x;
        doc.umapY = coord.y;
      }
    }
    const hierarchy = await loadTopicHierarchy();
    const parentInfo = hierarchy ? buildParentClusters(hierarchy, topics) : null;
    topicData = {
      topics,
      byYear: parentInfo
        ? buildTopicsByYear(parentInfo.parentClusters, normalizedRecords, parentInfo.leafToParent)
        : buildTopicsByYear(topics, normalizedRecords),
      hierarchy,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    source: sourceMeta,
    notes: [
      'Records are requested with an explicit source field list via the Open Collections API source parameter.',
      'PDF files are cached locally and per-document metrics are persisted in SQLite.',
      'Redownload occurs only when force refresh is used; recompute-from-cache updates metrics without redownloading.'
    ],
    metrics,
    documents: normalizedRecords.map(({
      charCount, extent, campus, scholarlyLevel, rights,
      downloadCandidates, supervisorsSource, subjects,
      pagesSource, wordCountSource, fileBytes,
      ...rest
    }) => rest),
    wordCloud: buildWordCloud(normalizedRecords),
    ngramCloud: buildConceptCloud(normalizedRecords),
    methodologies: buildMethodologyStats(normalizedRecords),
    supervisorNgramMatrix: buildSupervisorNgramMatrix(normalizedRecords),
    termCooccurrence: buildTermCooccurrence(normalizedRecords),
    conceptTimeline: buildConceptTimeline(normalizedRecords),
    methodologyConceptMatrix: buildMethodologyConceptMatrix(normalizedRecords),
    supervisorNetwork: buildSupervisorNetwork(normalizedRecords),
    citationCooccurrence: await buildCitationCooccurrenceNetwork(),
    methodologyTopicMatrix: topicData ? buildMethodologyTopicMatrix(normalizedRecords, topicData.topics) : null,
    topicData
  };
}
