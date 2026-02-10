import { SUPERVISOR_BLOCKED_VALUES, SUPERVISOR_CANONICAL_OVERRIDES } from './supervisorDictionary.js';

function stripDiacritics(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function stripParens(value) {
  return String(value || '').replace(/\s*\([^)]*\)\s*$/g, ' ').trim();
}

function stripHonorifics(value) {
  return String(value || '')
    .replace(/^(dr|prof|professor|mr|mrs|ms|miss)\.?\s+/i, '')
    .trim();
}

function stripTrailingYearChunks(value) {
  const chunks = String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const kept = chunks.filter((part) => !/^\d{4}(\s*-\s*\d{0,4})?$/.test(part));
  return kept.join(', ');
}

function stripOuterPunctuation(value) {
  return String(value || '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasLetters(value) {
  return /\p{L}/u.test(String(value || ''));
}

function normalizeCommaName(value) {
  const parts = String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return String(value || '').trim();
  const family = parts[0];
  const given = parts[1];
  if (!family || !given) return String(value || '').trim();
  return `${given} ${family}`.replace(/\s+/g, ' ').trim();
}

export function normalizePersonName(raw) {
  if (raw === undefined || raw === null) return null;
  let name = String(raw).trim();
  if (!name) return null;
  if (SUPERVISOR_BLOCKED_VALUES.has(name.toLowerCase())) return null;

  name = stripParens(name);
  name = stripHonorifics(name);
  name = stripTrailingYearChunks(name);
  name = normalizeCommaName(name);
  name = stripOuterPunctuation(name);
  name = name.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (!name || !hasLetters(name)) return null;
  return name;
}

export function supervisorNameKey(raw) {
  const normalized = normalizePersonName(raw);
  if (!normalized) return null;
  return stripDiacritics(normalized)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dedupeSupervisorNames(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = normalizePersonName(value);
    if (!normalized) continue;
    const key = supervisorNameKey(normalized);
    if (!key) continue;
    const canonical = SUPERVISOR_CANONICAL_OVERRIDES.get(key) || normalized;
    const canonicalKey = supervisorNameKey(canonical);
    if (!canonicalKey || seen.has(canonicalKey)) continue;
    seen.add(canonicalKey);
    out.push(canonical);
  }
  return out;
}
