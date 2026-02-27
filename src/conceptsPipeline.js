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
const MIN_PHRASE_DOC_FREQ = 2;
const QUALITY_SCORE_THRESHOLD = 1.0;

const WEAK_HEAD_TOKENS = new Set([
  'understanding', 'perspectives', 'perspective', 'experiences', 'experience',
  'making', 'sense', 'develop', 'development', 'future', 'current', 'analysis',
  'approach', 'framework', 'frameworks', 'models', 'model', 'stories', 'story',
  'including', 'based', 'used',
  'explores', 'examined', 'governed', 'ensures', 'requires', 'played',
  'included', 'completed', 'witnessed', 'takes', 'suggests', 'indicates',
  'ensuring', 'involving'
]);

const WEAK_ANYWHERE_TOKENS = new Set([
  'purpose', 'deeper', 'better', 'increase', 'making', 'including', 'people',
  'participants', 'interviewees', 'transcribed', 'audio', 'taped', 'shared',
  'current', 'future', 'used', 'based', 'broad', 'complex', 'important',
  'necessary', 'well', 'british', 'columbia', 'unspecified', 'rather', 'even',
  'although', 'already', 'often', 'particularly'
]);

const DISALLOWED_LOW_SIGNAL_TOKENS = new Set([
  'audio', 'taped', 'transcribed', 'shared', 'interviewees', 'participants'
]);

const STRONG_HEAD_TOKENS = new Set([
  'education', 'learning', 'policy', 'leadership', 'students', 'student',
  'research', 'health', 'curriculum', 'assessment', 'justice', 'knowledge'
]);

function splitWords(text) {
  return canonicalizeDomainText(text)
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function isSkippableToken(w) {
  return w.length < 4 || STOP_WORDS.has(w) || /^\d{4}$/.test(w) || /^\d+$/.test(w);
}

function extractDocPhrases(doc, maxPerDoc = 140) {
  const text = [doc.title, doc.abstract, (doc.subjects || []).join(' '), doc.program, doc.degree].join(' ');
  const words = splitWords(text);
  const phrases = new Set();
  for (const n of [2, 3]) {
    for (let i = 0; i <= words.length - n; i++) {
      const window = words.slice(i, i + n);
      if (window.some(isSkippableToken)) continue;
      const phrase = window.join(' ');
      if (isLowSignalConceptPhrase(phrase)) continue;
      phrases.add(phrase);
      if (phrases.size >= maxPerDoc) break;
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
  const entries = Array.from(phraseStats.values());
  const nested = new Map();
  for (const entry of entries) {
    nested.set(entry.phrase, { containers: 0, containerFreqSum: 0 });
  }
  for (const small of entries) {
    for (const large of entries) {
      if (small.phrase === large.phrase) continue;
      if (!isSubsequence(small.tokens, large.tokens)) continue;
      const stat = nested.get(small.phrase);
      stat.containers += 1;
      stat.containerFreqSum += large.docFreq;
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

  return cValue + strongHeadBoost - weakHeadPenalty - weakTokenPenalty - shortPenalty;
}

function shouldKeepPhrase(entry, qualityScore) {
  const head = entry.tokens[entry.tokens.length - 1];
  const hasWeakAnywhere = entry.tokens.some((t) => WEAK_ANYWHERE_TOKENS.has(t));
  const hasDisallowedLowSignal = entry.tokens.some((t) => DISALLOWED_LOW_SIGNAL_TOKENS.has(t));

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
      docFreq: concept.docFreq
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
    byCanonical.delete(source.canonical);
  }

  return Array.from(byCanonical.values());
}

async function ensureConceptPaths() {
  await fs.mkdir(CONCEPTS_DIR, { recursive: true });
}

async function writeStatus(status) {
  await ensureConceptPaths();
  await fs.writeFile(STATUS_PATH, JSON.stringify(status, null, 2));
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
    const docs = listAllDocumentMetadata().map((row) => row.metadata || {});
    const phraseDocs = new Map(); // phrase -> set(docIndex)

    docs.forEach((doc, index) => {
      const phrases = extractDocPhrases(doc);
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
        tokens: phrase.split(' ')
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
        docFreq
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
        aliases: Object.keys(variantToCanonical).length
      },
      concepts,
      variantToCanonical
    };

    await ensureConceptPaths();
    await fs.writeFile(LATEST_PATH, JSON.stringify(artifact, null, 2));
    await writeStatus({
      status: 'idle',
      trigger,
      lastRunAt: generatedAt,
      lastSuccessAt: generatedAt,
      message: `Concept rebuild completed (${artifact.stats.aliases} aliases).`,
      stats: artifact.stats
    });

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
