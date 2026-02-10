import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

function stripDiacritics(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeText(value) {
  return stripDiacritics(String(value || ''))
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const DOMAIN_DICTIONARY = [
  {
    canonical: 'higher education',
    variants: ['post-secondary education', 'postsecondary education', 'tertiary education', 'university education']
  },
  {
    canonical: 'doctoral education',
    variants: ['doctor of education', 'edd', 'doctoral studies']
  },
  {
    canonical: 'teacher education',
    variants: ['preservice teacher education', 'pre-service teacher education', 'initial teacher education']
  },
  {
    canonical: 'educational leadership',
    variants: ['school leadership', 'leadership in education', 'education leadership']
  },
  {
    canonical: 'educational policy',
    variants: ['education policy', 'policy in education', 'educational policymaking']
  },
  {
    canonical: 'indigenous education',
    variants: ['first nations education', 'aboriginal education', 'indigenous pedagogy']
  },
  {
    canonical: 'decolonization',
    variants: ['decolonisation', 'decolonizing', 'decolonising']
  },
  {
    canonical: 'equity diversity inclusion',
    variants: ['edi', 'equity, diversity, and inclusion', 'diversity equity inclusion']
  },
  {
    canonical: 'inclusive education',
    variants: ['inclusion in education', 'inclusive pedagogy', 'inclusive schooling']
  },
  {
    canonical: 'curriculum',
    variants: ['curriculum development', 'curricular design', 'curricular']
  },
  {
    canonical: 'assessment',
    variants: ['student assessment', 'learning assessment', 'evaluation']
  },
  {
    canonical: 'professional learning',
    variants: ['professional development', 'teacher professional development', 'continuing professional learning']
  },
  {
    canonical: 'online learning',
    variants: ['e-learning', 'elearning', 'digital learning', 'remote learning']
  },
  {
    canonical: 'international students',
    variants: ['foreign students', 'overseas students']
  },
  {
    canonical: 'mental health',
    variants: ['mental illness', 'psychological wellbeing', 'psychological well-being']
  },
  {
    canonical: 'british columbia',
    variants: ['bc', 'b.c.', 'province of british columbia']
  },
  {
    canonical: 'university of british columbia',
    variants: ['ubc', 'the university of british columbia']
  },
  {
    canonical: 'doctor of education',
    variants: ['edd', 'ed.d.']
  }
];

const phraseRows = [];

for (const entry of DOMAIN_DICTIONARY) {
  const canonical = normalizeText(entry.canonical);
  if (!canonical) continue;
  const variants = [entry.canonical, ...(entry.variants || [])];
  for (const variant of variants) {
    const normalizedVariant = normalizeText(variant);
    if (!normalizedVariant) continue;
    phraseRows.push({
      variantTokens: normalizedVariant.split(' '),
      canonicalTokens: canonical.split(' ')
    });
  }
}

phraseRows.sort((a, b) => b.variantTokens.length - a.variantTokens.length);

const byFirstToken = new Map();
for (const row of phraseRows) {
  const first = row.variantTokens[0];
  if (!byFirstToken.has(first)) byFirstToken.set(first, []);
  byFirstToken.get(first).push(row);
}

const dynamicByFirstToken = new Map();
const DYNAMIC_PATH = path.join(DATA_DIR, 'concepts', 'latest.json');
let dynamicLoadedAt = 0;
const DYNAMIC_RELOAD_MS = 60_000;

function loadDynamicDictionaryIfNeeded() {
  const now = Date.now();
  if (now - dynamicLoadedAt < DYNAMIC_RELOAD_MS) return;
  dynamicLoadedAt = now;

  dynamicByFirstToken.clear();
  try {
    const raw = fs.readFileSync(DYNAMIC_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const map = parsed?.variantToCanonical || {};
    for (const [variantRaw, canonicalRaw] of Object.entries(map)) {
      const normalizedVariant = normalizeText(variantRaw);
      const normalizedCanonical = normalizeText(canonicalRaw);
      if (!normalizedVariant || !normalizedCanonical) continue;
      const row = {
        variantTokens: normalizedVariant.split(' '),
        canonicalTokens: normalizedCanonical.split(' ')
      };
      const first = row.variantTokens[0];
      if (!dynamicByFirstToken.has(first)) dynamicByFirstToken.set(first, []);
      dynamicByFirstToken.get(first).push(row);
    }
    for (const rows of dynamicByFirstToken.values()) {
      rows.sort((a, b) => b.variantTokens.length - a.variantTokens.length);
    }
  } catch {
    // Missing or invalid dynamic dictionary: keep static-only behavior.
  }
}

export function canonicalizeDomainText(text) {
  loadDynamicDictionaryIfNeeded();
  const normalized = normalizeText(text);
  if (!normalized) return '';
  const words = normalized.split(' ').filter(Boolean);
  if (!words.length) return '';

  const out = [];
  for (let i = 0; i < words.length;) {
    const candidates = [
      ...(dynamicByFirstToken.get(words[i]) || []),
      ...(byFirstToken.get(words[i]) || []),
    ];
    let matched = null;
    for (const candidate of candidates) {
      const { variantTokens } = candidate;
      if (i + variantTokens.length > words.length) continue;
      let ok = true;
      for (let j = 0; j < variantTokens.length; j++) {
        if (words[i + j] !== variantTokens[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matched = candidate;
        break;
      }
    }
    if (matched) {
      out.push(...matched.canonicalTokens);
      i += matched.variantTokens.length;
    } else {
      out.push(words[i]);
      i += 1;
    }
  }

  return out.join(' ');
}
