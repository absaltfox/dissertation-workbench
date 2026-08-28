import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, STOP_WORDS } from './config.js';
import { listAllDocumentMetadata } from './db.js';
import { canonicalizeDomainText } from './domainDictionary.js';
import { isLowSignalConceptPhrase } from './nlp.js';
import { logger } from './logger.js';

const CONCEPTS_DIR = path.join(DATA_DIR, 'concepts');
const LATEST_PATH = path.join(CONCEPTS_DIR, 'latest.json');
const STATUS_PATH = path.join(CONCEPTS_DIR, 'status.json');
const LOCK_PATH = path.join(CONCEPTS_DIR, '.rebuild.lock');
const DAILY_HOUR_LOCAL = 2;
// Minimum document frequency for the full quality pipeline (C-value scoring,
// nested-phrase analysis, similarity clustering). Keeping this at 2 ensures the
// O(n²) steps operate on a manageable candidate set.
// Single-document phrases are handled by a separate lightweight pass below.
const MIN_PHRASE_DOC_FREQ = 2;
const QUALITY_SCORE_THRESHOLD = 1.0;

const WEAK_HEAD_TOKENS = new Set([
  'understanding', 'perspectives', 'perspective', 'experiences', 'experience',
  'making', 'sense', 'develop', 'development', 'future', 'current', 'analysis',
  'approach', 'framework', 'frameworks', 'models', 'model', 'stories', 'story',
  'including', 'based', 'used',
  'explores', 'examined', 'governed', 'ensures', 'requires', 'played',
  'included', 'completed', 'witnessed', 'takes', 'suggests', 'indicates',
  'ensuring', 'involving',
  // Verb-headed phrases that are process descriptions, not concepts
  'reveal', 'reveals', 'revealed', 'supported', 'draws', 'drawn', 'reflect', 'reflects',
  'responsible', 'highlights', 'describe', 'describes', 'described', 'suggest',
  'identified', 'reported', 'found', 'showed', 'presented', 'addressed',
  'formed', 'held', 'discuss', 'discussed', 'demonstrates', 'demonstrated',
  'achieved', 'selected', 'chosen', 'conducted', 'designed', 'established',
  // Additional verb forms and participials that appear as phrase heads
  'using', 'provided', 'providing', 'relied', 'operationalized', 'similarly',
  'explored', 'explores', 'argue', 'argued', 'argues',
]);

const WEAK_ANYWHERE_TOKENS = new Set([
  'purpose', 'deeper', 'better', 'increase', 'making', 'including', 'people',
  'participants', 'interviewees', 'transcribed', 'audio', 'taped', 'shared',
  'current', 'future', 'used', 'based', 'broad', 'complex', 'important',
  'necessary', 'well', 'british', 'columbia', 'unspecified', 'rather', 'even',
  'although', 'already', 'often', 'particularly',
  // Methodological / results-language that produces non-topical phrases
  'significant', 'include', 'resulting', 'related', 'general', 'various',
]);

const DISALLOWED_LOW_SIGNAL_TOKENS = new Set([
  'audio', 'taped', 'transcribed', 'shared', 'interviewees', 'participants'
]);

const STRONG_HEAD_TOKENS = new Set([
  'education', 'learning', 'policy', 'leadership', 'students', 'student',
  'research', 'health', 'curriculum', 'assessment', 'justice', 'knowledge'
]);

const LABEL_CONNECTOR_TOKENS = new Set([
  'aboard', 'about', 'above', 'across', 'after', 'against', 'along', 'among',
  'around', 'before', 'behind', 'below', 'beneath', 'beside', 'between',
  'beyond', 'during', 'except', 'following', 'inside', 'into', 'near',
  'outside', 'through', 'toward', 'towards', 'under', 'until', 'within',
  'without', 'because', 'whether', 'while', 'whereas'
]);

const LABEL_FRAGMENT_HEAD_TOKENS = new Set([
  'aim', 'aims', 'area', 'areas', 'case', 'cases', 'chapter', 'chapters',
  'component', 'components', 'context', 'contexts', 'example', 'examples',
  'factor', 'factors', 'finding', 'findings', 'issue', 'issues', 'lens',
  'level', 'levels', 'matter', 'matters', 'need', 'needs', 'pattern',
  'patterns', 'problem', 'problems', 'reflection', 'reflections', 'result',
  'results', 'role', 'roles', 'section', 'sections', 'theme', 'themes',
  'topic', 'topics', 'view', 'views', 'way', 'ways'
]);

const LABEL_FRAGMENT_START_TOKENS = new Set([
  'aim', 'aims', 'case', 'cases', 'cross', 'finding', 'findings', 'lens',
  'reflection', 'reflections', 'result', 'results', 'role', 'roles',
  'theme', 'themes', 'view', 'views'
]);

const KNOWN_LABEL_PHRASES = new Set([
  'case study',
  'cross cultural communication',
  'cross cultural education',
  'cross cultural learning',
  'professional learning'
]);

function splitWords(text) {
  return canonicalizeDomainText(text)
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function normalizedPhrase(phrase) {
  return String(phrase || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function containsContiguousTokens(words, tokens) {
  if (!tokens.length || tokens.length > words.length) return false;
  for (let i = 0; i <= words.length - tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < tokens.length; j++) {
      if (words[i + j] !== tokens[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function isAcceptableConceptLabelExpression(phrase) {
  const normalized = normalizedPhrase(phrase);
  if (!normalized) return false;
  if (KNOWN_LABEL_PHRASES.has(normalized)) return true;

  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length < 2 || tokens.length > 3) return false;
  if (new Set(tokens).size < tokens.length) return false;
  if (tokens.some((token) => LABEL_CONNECTOR_TOKENS.has(token))) return false;

  const head = tokens[tokens.length - 1];
  if (LABEL_FRAGMENT_HEAD_TOKENS.has(head)) return false;
  if (LABEL_FRAGMENT_START_TOKENS.has(tokens[0]) && !KNOWN_LABEL_PHRASES.has(normalized)) return false;

  // Avoid subtitle/rhetorical expressions such as "cross cultural lens" and
  // "cultural lens reflection"; they read as prose framing, not concept labels.
  if (tokens.some((token) => token === 'lens' || token === 'reflection' || token === 'reflections')) return false;

  return true;
}

function conceptSegmentsForDoc(doc) {
  const titleSegments = (doc.title || '').split(/[:;,]/).map((s) => s.trim()).filter(Boolean);
  const abstractSegments = (doc.abstract || '').split(/[/,]/).map((s) => s.trim()).filter(Boolean);
  const subjectSegments = (doc.subjects || []).join('/').split('/').map((s) => s.trim()).filter(Boolean);
  return [
    ...titleSegments.map((text) => ({ type: 'title', text })),
    ...abstractSegments.map((text) => ({ type: 'abstract', text })),
    ...subjectSegments.map((text) => ({ type: 'subject', text })),
  ];
}

function phraseContextSupportScore(phrase, doc) {
  const tokens = normalizedPhrase(phrase).split(' ').filter(Boolean);
  if (!tokens.length) return 0;
  let best = 0;
  let titleHasPhrase = false;
  let nonTitleTokenSupport = 0;
  const nonTitleTokens = new Set();

  for (const segment of conceptSegmentsForDoc(doc)) {
    const words = splitWords(segment.text);
    if (segment.type !== 'title') {
      for (const word of words) nonTitleTokens.add(word);
    }
    if (!containsContiguousTokens(words, tokens)) continue;
    if (segment.type === 'title') titleHasPhrase = true;
    const sourceWeight = segment.type === 'subject' ? 1.1 : segment.type === 'abstract' ? 0.9 : 0.85;
    const compactness = tokens.length / Math.max(tokens.length, words.length);
    best = Math.max(best, sourceWeight + (compactness * 0.35));
  }

  for (const token of tokens) {
    if (nonTitleTokens.has(token)) nonTitleTokenSupport += 1;
  }

  const head = tokens[tokens.length - 1];
  if (STRONG_HEAD_TOKENS.has(head)) best += 0.2;
  if (LABEL_FRAGMENT_HEAD_TOKENS.has(head)) best -= 0.75;
  if (titleHasPhrase && nonTitleTokenSupport > 0) {
    best += Math.min(0.35, (nonTitleTokenSupport / tokens.length) * 0.35);
  }

  return Math.max(0, Math.round(best * 1000) / 1000);
}

function phraseContextScore(phrase, docIndexes, docs) {
  const ids = Array.from(docIndexes || []);
  if (!ids.length) return 0;
  const sum = ids.reduce((total, docIndex) => total + phraseContextSupportScore(phrase, docs[docIndex] || {}), 0);
  return Math.round((sum / ids.length) * 1000) / 1000;
}

// Cardinal number words produce meaningless methodology phrases like "three schools",
// "eight coordinators", "four elders" from participant-count sentences.
const CARDINAL_WORDS = new Set([
  'four', 'five', 'nine', 'three', 'seven', 'eight',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'twenty', 'thirty', 'forty', 'fifty', 'hundred',
]);

function isSkippableToken(w) {
  return w.length < 4 || STOP_WORDS.has(w) || CARDINAL_WORDS.has(w)
    // APA citation year tokens: "2012a", "1976b" produce concept fragments
    || /^\d{4}[a-z]?$/.test(w) || /^\d+$/.test(w);
}

function extractDocPhrases(doc, maxPerDoc = 140) {
  // Deliberately excludes doc.program and doc.degree: structured metadata fields
  // containing comma-separated program names produce artefact bigrams such as
  // "administrative adult" (from "Administrative, Adult and Higher Education").
  // Genuine program-related concepts (e.g. "counselling psychology") appear
  // naturally in titles and abstracts and are captured from those fields.
  //
  // Title is split at common delimiters (:, ;, ,) before n-gram extraction so
  // that cross-boundary bigrams like "teachers grassroots computing" (from
  // "…bootstraps : teachers, grassroots computing…") are never generated.
  // This allows distinctive short phrases from subtitle segments (e.g.
  // "grassroots computing") to survive the nesting filter.
  const titleSegments = (doc.title || '').split(/[:;,]/).map((s) => s.trim()).filter(Boolean);
  // Abstract and subjects are also split on "/" (slash notation like
  // "coordinators/directors" produces spurious bigrams after "/" → space).
  // Abstract is split on "/" and "," to prevent cross-boundary bigrams from
  // slash notation ("coordinators/directors") and enumeration lists
  // ("teachers, parents, and students" → strip commas → "teachers parents").
  const abstractSegments = (doc.abstract || '').split(/[/,]/).map((s) => s.trim()).filter(Boolean);
  // Subjects are joined with "/" so each subject string becomes a separate segment
  // and cannot form cross-subject bigrams (e.g. "teachers" + "students" subjects).
  const subjectSegments = (doc.subjects || []).join('/').split('/').map((s) => s.trim()).filter(Boolean);
  const parts = [...titleSegments, ...abstractSegments, ...subjectSegments];
  const phrases = new Set();
  for (const part of parts) {
    const words = splitWords(part);
    for (const n of [2, 3]) {
      for (let i = 0; i <= words.length - n; i++) {
        const window = words.slice(i, i + n);
        if (window.some(isSkippableToken)) continue;
        const phrase = window.join(' ');
        if (isLowSignalConceptPhrase(phrase)) continue;
        if (!isAcceptableConceptLabelExpression(phrase)) continue;
        phrases.add(phrase);
        if (phrases.size >= maxPerDoc) return phrases;
      }
    }
  }
  return phrases;
}

// Strip common English plural suffixes for comparison only — keeps canonical as-is
function stemForSim(token) {
  if (token.length > 5 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

function phraseSimilarity(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const aStemmed = aTokens.map(stemForSim);
  const bStemmed = bTokens.map(stemForSim);
  const jac = jaccard(aStemmed, bStemmed);
  const prefix = aStemmed.join(' ').startsWith(bStemmed.join(' ')) || bStemmed.join(' ').startsWith(aStemmed.join(' '));
  let bonus = prefix ? 0.2 : 0;

  // Same-length phrases with identical modifiers and morphologically related heads
  // e.g. "educational leaders" / "educational leadership" — "leadership".startsWith("leader") ✓
  // but NOT "educational practices" / "educational practitioners" — neither starts the other ✓
  if (aTokens.length === bTokens.length && aTokens.length >= 2) {
    const aHead = aStemmed[aStemmed.length - 1];
    const bHead = bStemmed[bStemmed.length - 1];
    if (
      aHead !== bHead &&
      Math.min(aHead.length, bHead.length) >= 5 &&
      (aHead.startsWith(bHead) || bHead.startsWith(aHead)) &&
      aStemmed.slice(0, -1).join(' ') === bStemmed.slice(0, -1).join(' ')
    ) {
      bonus = Math.max(bonus, 0.7);
    }
  }

  return jac + bonus;
}

function pickCanonical(cluster, phraseStats) {
  const preferredHeads = new Set([
    'education', 'learning', 'policy', 'leadership', 'students', 'student',
    'research', 'health', 'curriculum', 'assessment'
  ]);
  const scored = cluster.map((phrase) => {
    const stat = phraseStats.get(phrase);
    const tokens = phrase.split(' ');
    const head = tokens[tokens.length - 1];
    const lenScore = tokens.length === 2 ? 1 : 0;
    const freqScore = stat?.docFreq || 0;
    const headBonus = preferredHeads.has(head) ? 2 : 0;
    return { phrase, score: (freqScore * 100) + (headBonus * 10) + lenScore };
  });
  scored.sort((a, b) => b.score - a.score || a.phrase.length - b.phrase.length);
  return scored[0]?.phrase || cluster[0];
}

function isSubsequence(tokens, largerTokens) {
  if (tokens.length >= largerTokens.length) return false;
  const max = largerTokens.length - tokens.length;
  for (let i = 0; i <= max; i++) {
    let ok = true;
    for (let j = 0; j < tokens.length; j++) {
      if (largerTokens[i + j] !== tokens[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function isPrefix(tokens, largerTokens) {
  if (tokens.length >= largerTokens.length) return false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== largerTokens[i]) return false;
  }
  return true;
}

function buildNestedStats(phraseStats) {
  const nested = new Map();
  for (const entry of phraseStats.values()) {
    nested.set(entry.phrase, { containers: 0, containerFreqSum: 0 });
  }

  // For each phrase, generate all contiguous sub-phrases directly and look them
  // up by key — O(n × L²) instead of O(n²). For 2- and 3-gram phrases this
  // means at most 3 lookups per phrase regardless of dictionary size.
  for (const large of phraseStats.values()) {
    const { tokens, docFreq } = large;
    for (let len = 1; len < tokens.length; len++) {
      for (let start = 0; start <= tokens.length - len; start++) {
        const subPhrase = tokens.slice(start, start + len).join(' ');
        const stat = nested.get(subPhrase);
        if (!stat) continue;
        stat.containers += 1;
        stat.containerFreqSum += docFreq;
      }
    }
  }
  return nested;
}

function computePhraseQuality(entry, nestedStats) {
  const tokens = entry.tokens;
  const lengthWeight = Math.log2(Math.max(tokens.length, 2));
  const nested = nestedStats.get(entry.phrase) || { containers: 0, containerFreqSum: 0 };
  const nestedMean = nested.containers ? (nested.containerFreqSum / nested.containers) : 0;
  const cValue = lengthWeight * Math.max(0, entry.docFreq - nestedMean);

  const head = tokens[tokens.length - 1];
  const weakHeadPenalty = WEAK_HEAD_TOKENS.has(head) ? 1.25 : 0;
  const strongHeadBoost = STRONG_HEAD_TOKENS.has(head) ? 0.5 : 0;
  const weakTokenPenalty = tokens.filter((t) => WEAK_ANYWHERE_TOKENS.has(t)).length * 0.35;
  const shortPenalty = tokens.length < 2 ? 0.5 : 0;
  const labelPenalty = isAcceptableConceptLabelExpression(entry.phrase) ? 0 : 2.5;
  const contextBoost = Math.min(0.75, Math.max(0, entry.contextScore || 0) * 0.25);

  return cValue + strongHeadBoost + contextBoost - weakHeadPenalty - weakTokenPenalty - shortPenalty - labelPenalty;
}

function shouldKeepPhrase(entry, qualityScore) {
  const head = entry.tokens[entry.tokens.length - 1];
  const hasWeakAnywhere = entry.tokens.some((t) => WEAK_ANYWHERE_TOKENS.has(t));
  const hasDisallowedLowSignal = entry.tokens.some((t) => DISALLOWED_LOW_SIGNAL_TOKENS.has(t));

  if (!isAcceptableConceptLabelExpression(entry.phrase)) return false;
  if ((entry.contextScore || 0) < 0.65 && entry.docFreq < 6 && !STRONG_HEAD_TOKENS.has(head)) return false;
  if (hasDisallowedLowSignal && entry.docFreq < 6) return false;
  if (WEAK_HEAD_TOKENS.has(head) && entry.docFreq < 3) return false;
  if (WEAK_HEAD_TOKENS.has(head)) {
    const tightenedThreshold = QUALITY_SCORE_THRESHOLD + (entry.docFreq < 6 ? 0.75 : 0.35);
    return qualityScore >= tightenedThreshold;
  }
  if (entry.docFreq <= 2 && hasWeakAnywhere) return false;
  if (entry.docFreq >= 10) return true;
  if (entry.docFreq >= 6 && !WEAK_HEAD_TOKENS.has(head)) return qualityScore >= 0.5;
  return qualityScore >= QUALITY_SCORE_THRESHOLD;
}

function consolidateConcepts(concepts) {
  const byCanonical = new Map();
  for (const concept of concepts) {
    byCanonical.set(concept.canonical, {
      canonical: concept.canonical,
      variants: [...concept.variants],
      docFreq: concept.docFreq,
      contextScore: concept.contextScore || 0,
      qualityScore: concept.qualityScore || null
    });
  }

  const items = Array.from(byCanonical.values());
  items.sort((a, b) => a.canonical.split(' ').length - b.canonical.split(' ').length || b.docFreq - a.docFreq);

  for (const small of items) {
    if (!byCanonical.has(small.canonical)) continue;
    const smallTokens = small.canonical.split(' ');
    let mergeTarget = null;

    for (const large of items) {
      if (small.canonical === large.canonical || !byCanonical.has(large.canonical)) continue;
      const largeTokens = large.canonical.split(' ');
      if (!isPrefix(smallTokens, largeTokens) && !isSubsequence(smallTokens, largeTokens)) continue;
      const enoughSupport = large.docFreq >= Math.max(3, Math.floor(small.docFreq * 0.5));
      if (!enoughSupport) continue;
      if (!mergeTarget || large.docFreq > mergeTarget.docFreq || largeTokens.length > mergeTarget.canonical.split(' ').length) {
        mergeTarget = large;
      }
    }

    if (!mergeTarget) continue;
    const target = byCanonical.get(mergeTarget.canonical);
    const source = byCanonical.get(small.canonical);
    if (!target || !source) continue;

    target.variants.push(source.canonical, ...source.variants);
    target.variants = Array.from(new Set(target.variants.filter((v) => v !== target.canonical)));
    target.contextScore = Math.max(target.contextScore || 0, source.contextScore || 0);
    if (source.qualityScore != null) {
      target.qualityScore = Math.max(target.qualityScore || 0, source.qualityScore);
    }
    byCanonical.delete(source.canonical);
  }

  return Array.from(byCanonical.values());
}

async function ensureConceptPaths() {
  await fs.mkdir(CONCEPTS_DIR, { recursive: true });
}

async function writeJsonAtomically(targetPath, value) {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2));
    await fs.rename(tempPath, targetPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function writeStatus(status) {
  await ensureConceptPaths();
  await writeJsonAtomically(STATUS_PATH, status);
}

export async function getConceptPipelineStatus() {
  try {
    const raw = await fs.readFile(STATUS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {
      status: 'idle',
      lastRunAt: null,
      lastSuccessAt: null,
      trigger: null,
      message: 'No concept rebuild has run yet.'
    };
  }
}

export async function persistConceptArtifact(artifact, { trigger = 'worker', message = null } = {}) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('Concept artifact must be an object.');
  }
  const generatedAt = artifact.generatedAt || new Date().toISOString();
  artifact.generatedAt = generatedAt;
  await ensureConceptPaths();
  await writeJsonAtomically(LATEST_PATH, artifact);
  await writeStatus({
    status: 'idle',
    trigger,
    lastRunAt: generatedAt,
    lastSuccessAt: generatedAt,
    message: message || `Concept rebuild completed (${artifact.stats?.aliases ?? 0} aliases).`,
    stats: artifact.stats || null
  });
  return { ok: true, artifact };
}

async function acquireLock() {
  await ensureConceptPaths();
  try {
    const handle = await fs.open(LOCK_PATH, 'wx');
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

async function releaseLock() {
  try { await fs.unlink(LOCK_PATH); } catch { /* ignore */ }
}

export async function rebuildConceptDictionary({ trigger = 'manual' } = {}) {
  if (!(await acquireLock())) {
    return { ok: false, error: 'Concept rebuild already running.' };
  }

  const startedAt = new Date().toISOString();
  await writeStatus({
    status: 'running',
    trigger,
    startedAt,
    lastRunAt: startedAt,
    message: 'Concept rebuild in progress.'
  });

  try {
    const docs = (await listAllDocumentMetadata()).map((row) => row.metadata || {});
    const phraseDocs = new Map(); // phrase -> set(docIndex)
    const docPhrases = [];        // docIndex -> Set<phrase> (for single-doc nesting checks)

    docs.forEach((doc, index) => {
      const phrases = extractDocPhrases(doc);
      docPhrases.push(phrases);
      for (const phrase of phrases) {
        if (!phraseDocs.has(phrase)) phraseDocs.set(phrase, new Set());
        phraseDocs.get(phrase).add(index);
      }
    });

    const phraseStats = new Map();
    for (const [phrase, ids] of phraseDocs.entries()) {
      if (ids.size < MIN_PHRASE_DOC_FREQ) continue;
      phraseStats.set(phrase, {
        phrase,
        docFreq: ids.size,
        tokens: phrase.split(' '),
        contextScore: phraseContextScore(phrase, ids, docs)
      });
    }

    const nestedStats = buildNestedStats(phraseStats);
    const qualityStats = new Map();
    const filteredPhraseStats = new Map();
    for (const entry of phraseStats.values()) {
      const qualityScore = computePhraseQuality(entry, nestedStats);
      qualityStats.set(entry.phrase, qualityScore);
      if (!shouldKeepPhrase(entry, qualityScore)) continue;
      filteredPhraseStats.set(entry.phrase, entry);
    }

    const phrases = Array.from(filteredPhraseStats.keys()).sort((a, b) => (filteredPhraseStats.get(b).docFreq - filteredPhraseStats.get(a).docFreq));
    const clusters = [];
    const assigned = new Set();

    for (const phrase of phrases) {
      if (assigned.has(phrase)) continue;
      const base = filteredPhraseStats.get(phrase);
      const cluster = [phrase];
      assigned.add(phrase);
      for (const candidate of phrases) {
        if (assigned.has(candidate)) continue;
        const cand = filteredPhraseStats.get(candidate);
        if (!cand) continue;
        const sim = phraseSimilarity(base.tokens, cand.tokens);
        const prefix = base.tokens.join(' ').startsWith(cand.tokens.join(' ')) || cand.tokens.join(' ').startsWith(base.tokens.join(' '));
        if (sim >= 0.95 || (prefix && sim >= 0.8 && Math.max(base.docFreq, cand.docFreq) >= 3)) {
          cluster.push(candidate);
          assigned.add(candidate);
        }
      }
      clusters.push(cluster);
    }

    const variantToCanonical = {};
    let concepts = [];
    for (const cluster of clusters) {
      const canonical = pickCanonical(cluster, filteredPhraseStats);
      const variants = cluster.filter((p) => p !== canonical);
      const docFreq = filteredPhraseStats.get(canonical)?.docFreq || 0;
      if (!variants.length && docFreq < 3) continue;
      concepts.push({
        canonical,
        variants,
        docFreq,
        contextScore: filteredPhraseStats.get(canonical)?.contextScore || 0,
        qualityScore: Math.round((qualityStats.get(canonical) || 0) * 1000) / 1000
      });
      for (const variant of variants) {
        variantToCanonical[variant] = canonical;
      }
    }

    concepts = consolidateConcepts(concepts);
    Object.keys(variantToCanonical).forEach((key) => delete variantToCanonical[key]);
    for (const concept of concepts) {
      for (const variant of concept.variants) {
        variantToCanonical[variant] = concept.canonical;
      }
    }

    // Compute smoothed IDF for each concept: log((N+1) / (docFreq+1))
    const N = docs.length;
    for (const concept of concepts) {
      concept.idf = Math.log((N + 1) / (concept.docFreq + 1));
    }

    // Single-document phrase pass: concepts unique to one dissertation.
    // These get high IDF (≈ log(N/2)) and make niche-topic dissertations
    // discoverable even when their subject matter appears nowhere else.
    // We skip the O(n²) C-value and clustering steps (not meaningful for
    // singletons) and apply three lightweight filters instead:
    //   1. Weak-token filters (same as the multi-doc pipeline).
    //   2. For 2-grams: suppress if any 3-gram in the same document is a
    //      containing phrase — avoids sliding-window bigram fragments.
    //   3. Skip phrases already covered by the multi-doc concepts.
    const multiDocCanonicals = new Set(concepts.map((c) => c.canonical));
    const singleDocCount = { added: 0 };
    for (const [phrase, ids] of phraseDocs.entries()) {
      if (ids.size !== 1) continue;
      const tokens = phrase.split(' ');
      const head = tokens[tokens.length - 1];
      if (WEAK_HEAD_TOKENS.has(head)) continue;
      if (tokens.some((t) => WEAK_ANYWHERE_TOKENS.has(t))) continue;
      if (tokens.some((t) => DISALLOWED_LOW_SIGNAL_TOKENS.has(t))) continue;
      if (multiDocCanonicals.has(phrase)) continue;
      if (variantToCanonical[phrase]) continue;
      if (!isAcceptableConceptLabelExpression(phrase)) continue;
      const contextScore = phraseContextScore(phrase, ids, docs);
      if (contextScore < 0.8 && !STRONG_HEAD_TOKENS.has(head)) continue;

      // 2-gram nesting check: suppress if a containing 3-gram exists in
      // the same document's phrase set (prevents "undergoing significant"
      // when "undergoing significant changes" is also present).
      if (tokens.length === 2) {
        const [tok0, tok1] = tokens;
        const docIndex = ids.values().next().value;
        const docPhraseSet = docPhrases[docIndex] || new Set();
        let isNested = false;
        for (const dp of docPhraseSet) {
          if (dp === phrase) continue;
          const dpts = dp.split(' ');
          if (dpts.length < 3) continue;
          for (let i = 0; i <= dpts.length - 2; i++) {
            if (dpts[i] === tok0 && dpts[i + 1] === tok1) { isNested = true; break; }
          }
          if (isNested) break;
        }
        if (isNested) continue;
      }

      concepts.push({
        canonical: phrase,
        variants: [],
        docFreq: 1,
        idf: Math.log((N + 1) / 2),
        contextScore
      });
      multiDocCanonicals.add(phrase);
      singleDocCount.added += 1;
    }

    const generatedAt = new Date().toISOString();
    const artifact = {
      version: 1,
      generatedAt,
      source: {
        documents: docs.length,
        dailyHourLocal: DAILY_HOUR_LOCAL
      },
      stats: {
        candidatePhrases: phraseStats.size,
        qualityFilteredPhrases: filteredPhraseStats.size,
        concepts: concepts.length,
        singleDocConcepts: singleDocCount.added,
        aliases: Object.keys(variantToCanonical).length
      },
      concepts,
      variantToCanonical
    };

    await persistConceptArtifact(artifact, { trigger });

    logger.info('Concept dictionary rebuilt', artifact.stats);
    return { ok: true, artifact };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    await writeStatus({
      status: 'error',
      trigger,
      lastRunAt: failedAt,
      message
    });
    logger.error('Concept rebuild failed', { error: message });
    return { ok: false, error: message };
  } finally {
    await releaseLock();
  }
}

function msUntilNextDailyRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(DAILY_HOUR_LOCAL, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function scheduleDailyConceptRebuild() {
  let timer = null;

  const scheduleNext = () => {
    const delay = msUntilNextDailyRun();
    timer = setTimeout(async () => {
      await rebuildConceptDictionary({ trigger: 'scheduled' });
      scheduleNext();
    }, delay);
  };

  scheduleNext();
  return () => {
    if (timer) clearTimeout(timer);
  };
}

export const _testing = {
  stemForSim,
  phraseSimilarity,
  extractDocPhrases,
  isAcceptableConceptLabelExpression,
  phraseContextSupportScore,
  computePhraseQuality,
  shouldKeepPhrase,
};
