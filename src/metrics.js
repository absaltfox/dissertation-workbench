import {
  DEFAULT_BASE_URL, DEFAULT_INDEX, DEFAULT_API_KEY, DEFAULT_QUERY,
  DEFAULT_TERM, DEFAULT_SOURCE, DEFAULT_DOWNLOAD_FILES, PDF_CACHE_DIR, SQLITE_PATH
} from './config.js';
import { ensureStorage, getDb, saveRunMetrics } from './db.js';
import { toArray, flattenText, extractYear, parsePageCount, topTermsFromText, buildWordCloud, buildNgramCloud, buildMethodologyStats, extractNgrams } from './nlp.js';
import { fetchPage, extractHits, resolveIndexName, collectCandidateUrls } from './api.js';
import { enrichDocumentsWithFileAnalysis } from './pdf.js';

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

function normalizeRecord(doc) {
  const id = flattenText(firstPresent(doc, ['_id', 'id', 'identifier', 'Identifier'])) || '';
  const title = flattenText(firstPresent(doc, ['title', 'Title', 'name', 'Name']));
  const creators = toArray(firstPresent(doc, ['creator', 'Creator', 'author', 'Author']));
  const supervisors = toArray(firstPresent(doc, ['supervisor', 'Supervisor']));
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

  const textForLength = fullText || description;
  const cleaned = String(textForLength).replace(/\s+/g, ' ').trim();
  const metadataWords = cleaned ? cleaned.split(' ').length : 0;
  const extentPages = parsePageCount(extentValues);
  const metadataPages = extentPages || Math.max(1, Math.round((metadataWords || 1) / 300));

  const themeText = [title, description, subjects.join(' '), program.join(' '), degree.join(' ')].join(' ');
  const themes = topTermsFromText(themeText, 12);

  return {
    id: id || `${title}:${creators[0] || ''}`,
    title,
    authors: creators,
    author: creators[0] || 'Unknown',
    supervisors,
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
    themes,
    uri,
    downloadCandidates: collectCandidateUrls(doc, id, doi),
    downloadUrl: null,
    downloadStatus: 'not_attempted',
    downloadError: null,
    fileBytes: null
  };
}

function buildMetrics(records, subjectLimit) {
  const subjectWords = new Map();
  const yearWords = new Map();
  const yearPages = new Map();

  for (const rec of records) {
    for (const subject of rec.subjects) {
      if (!subjectWords.has(subject)) subjectWords.set(subject, []);
      subjectWords.get(subject).push(rec.wordCount);
    }

    if (rec.year) {
      if (!yearWords.has(rec.year)) yearWords.set(rec.year, []);
      if (!yearPages.has(rec.year)) yearPages.set(rec.year, []);
      yearWords.get(rec.year).push(rec.wordCount);
      yearPages.get(rec.year).push(rec.pages);
    }
  }

  const bySubject = Array.from(subjectWords.entries())
    .map(([subject, values]) => ({ subject, ...stats(values) }))
    .sort((a, b) => b.count - a.count)
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
    overallWordCount: stats(records.map((r) => r.wordCount)),
    overallPageCount: stats(records.map((r) => r.pages)),
    overallCharCount: stats(records.map((r) => r.charCount)),
    bySubject,
    byYear,
    avgPagesByYear,
    pageTrend
  };
}

function docNgrams(rec, limit = 8) {
  const text = [rec.title, rec.abstract, rec.subjects.join(' ')].join(' ');
  const counts = new Map();
  for (const n of [2, 3]) {
    for (const ng of extractNgrams(text, n)) {
      counts.set(ng, (counts.get(ng) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

function buildSupervisorNgramMatrix(records, topN = 12, topM = 10) {
  const supervisorCounts = new Map();
  const docNgramCache = new Map();
  // Only count ngrams from records that have supervisors for better signal
  const supNgramCounts = new Map();

  for (const rec of records) {
    const ngrams = docNgrams(rec, 10);
    docNgramCache.set(rec.id, ngrams);
    const hasSup = rec.supervisors.length > 0;
    for (const sup of rec.supervisors) {
      supervisorCounts.set(sup, (supervisorCounts.get(sup) || 0) + 1);
    }
    if (hasSup) {
      for (const ng of ngrams) {
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
    .map(([name]) => name);

  const supSet = new Set(topSupervisors);
  const ngSet = new Set(topNgrams);

  const matrix = topSupervisors.map(() => topNgrams.map(() => 0));
  for (const rec of records) {
    const recSups = rec.supervisors.filter((s) => supSet.has(s));
    if (!recSups.length) continue;
    const recNgrams = (docNgramCache.get(rec.id) || []).filter((ng) => ngSet.has(ng));
    for (const sup of recSups) {
      const si = topSupervisors.indexOf(sup);
      for (const ng of recNgrams) {
        const nj = topNgrams.indexOf(ng);
        matrix[si][nj] += 1;
      }
    }
  }

  return { supervisors: topSupervisors, ngrams: topNgrams, matrix };
}

function buildTermCooccurrence(records, topN = 20) {
  const pairCounts = new Map();
  for (const rec of records) {
    const ngrams = docNgrams(rec, 8);
    if (ngrams.length < 2) continue;
    const sorted = [...ngrams].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|||${sorted[j]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  return Array.from(pairCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, count]) => {
      const [termA, termB] = key.split('|||');
      return { termA, termB, count };
    });
}

export async function collectMetrics(options = {}) {
  await ensureStorage();
  getDb();

  const maxRecords = Number(options.maxRecords || 200);
  const pageSize = Number(options.pageSize || 20);
  const scanLimit = Number(options.scanLimit || Math.max(maxRecords * 10, 1000));
  const subjectLimit = Number(options.subjectLimit || 25);
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const requestedIndex = options.index || DEFAULT_INDEX;
  const apiKey = options.apiKey || DEFAULT_API_KEY;
  const query = options.query === undefined ? DEFAULT_QUERY : options.query;
  const term = options.term === undefined ? DEFAULT_TERM : options.term;
  const source = options.source === undefined ? DEFAULT_SOURCE : options.source;
  const downloadFiles = options.downloadFiles === undefined ? DEFAULT_DOWNLOAD_FILES : Boolean(options.downloadFiles);
  const forceDownload = Boolean(options.forceDownload);
  const recomputeFromCache = Boolean(options.recomputeFromCache);

  const index = await resolveIndexName(baseUrl, requestedIndex, apiKey);
  const records = [];

  for (let from = 0; from < scanLimit; from += pageSize) {
    const payload = await fetchPage({ baseUrl, index, apiKey, from, pageSize, query, term, source });
    const docs = extractHits(payload);
    if (!docs.length) break;

    records.push(...docs.map(normalizeRecord));

    if (docs.length < pageSize) break;
    if (records.length >= maxRecords) break;
  }

  const normalizedRecords = records.slice(0, maxRecords);

  await enrichDocumentsWithFileAnalysis(normalizedRecords, {
    downloadFiles,
    forceDownload,
    recomputeFromCache
  });

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
    pdfCacheDir: PDF_CACHE_DIR,
    sqlitePath: SQLITE_PATH
  };

  const metrics = buildMetrics(normalizedRecords, subjectLimit);
  saveRunMetrics(sourceMeta, metrics);

  return {
    generatedAt: new Date().toISOString(),
    source: sourceMeta,
    notes: [
      'Records are requested with an explicit source field list via the Open Collections API source parameter.',
      'PDF files are cached locally and per-document metrics are persisted in SQLite.',
      'Redownload occurs only when force refresh is used; recompute-from-cache updates metrics without redownloading.'
    ],
    metrics,
    documents: normalizedRecords,
    wordCloud: buildWordCloud(normalizedRecords),
    ngramCloud: buildNgramCloud(normalizedRecords),
    methodologies: buildMethodologyStats(normalizedRecords),
    supervisorNgramMatrix: buildSupervisorNgramMatrix(normalizedRecords),
    termCooccurrence: buildTermCooccurrence(normalizedRecords)
  };
}
