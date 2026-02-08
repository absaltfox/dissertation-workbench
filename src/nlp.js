import { STOP_WORDS } from './config.js';

export function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((v) => toArray(v));
  if (typeof value === 'string') return [value.trim()].filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

export function flattenText(value) {
  return toArray(value).join(' ').replace(/\s+/g, ' ').trim();
}

export function extractYear(rawDate) {
  if (!rawDate) return null;
  const match = String(rawDate).match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

export function parsePageCount(extentValues) {
  for (const value of extentValues) {
    const txt = String(value).toLowerCase();
    const match = txt.match(/(\d{1,5})\s*(pages?|p\.|leaves?)/);
    if (match) return Number(match[1]);
  }
  return null;
}

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
}

export function topTermsFromText(text, limit = 10) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

export function buildWordCloud(records, maxTerms = 70) {
  const counts = new Map();
  for (const rec of records) {
    const text = [rec.title, rec.abstract, rec.subjects.join(' '), rec.program, rec.degree].join(' ');
    for (const token of tokenize(text)) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term, count]) => ({ term, count }));
}

export function extractNgrams(text, n) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const ngrams = [];
  for (let i = 0; i <= words.length - n; i++) {
    const window = words.slice(i, i + n);
    if (window.some((w) => w.length < 4 || STOP_WORDS.has(w))) continue;
    ngrams.push(window.join(' '));
  }
  return ngrams;
}

export function buildNgramCloud(records, maxTerms = 60) {
  const counts = new Map();
  for (const rec of records) {
    const text = [rec.title, rec.abstract, rec.subjects.join(' ')].join(' ');
    for (const n of [2, 3]) {
      for (const ngram of extractNgrams(text, n)) {
        counts.set(ngram, (counts.get(ngram) || 0) + 1);
      }
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term, count]) => ({ term, count }));
}

export const METHODOLOGY_KEYWORDS = new Map([
  ['Qualitative', /\bqualitative\b/i],
  ['Quantitative', /\bquantitative\b/i],
  ['Mixed Methods', /\bmixed[- ]methods?\b/i],
  ['Case Study', /\bcase\s+stud(?:y|ies)\b/i],
  ['Ethnography', /\bethnograph(?:y|ic)\b/i],
  ['Grounded Theory', /\bgrounded\s+theory\b/i],
  ['Phenomenology', /\bphenomenolog(?:y|ical)\b/i],
  ['Action Research', /\baction\s+research\b/i],
  ['Narrative Inquiry', /\bnarrative\s+(?:inquiry|research|analysis)\b/i],
  ['Survey', /\bsurveys?\b/i],
  ['Experimental', /\bexperimental\b/i],
  ['Longitudinal', /\blongitudinal\b/i],
  ['Content Analysis', /\bcontent\s+analysis\b/i],
  ['Discourse Analysis', /\bdiscourse\s+analysis\b/i],
  ['Interviews', /\binterview(?:s|ing)?\b/i],
  ['Autoethnography', /\bautoethnograph(?:y|ic)\b/i],
  ['Participatory', /\bparticipatory\b/i],
]);

export function detectMethodologies(text) {
  const str = String(text || '');
  const matched = [];
  for (const [label, regex] of METHODOLOGY_KEYWORDS) {
    if (regex.test(str)) matched.push(label);
  }
  return matched;
}

export function buildMethodologyStats(records) {
  const counts = new Map();
  for (const rec of records) {
    const text = [rec.title, rec.abstract, rec.subjects.join(' ')].join(' ');
    for (const label of detectMethodologies(text)) {
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([methodology, count]) => ({ methodology, count }));
}
