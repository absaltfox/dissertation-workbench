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
  // Only swap if "given" part looks like a first name: 1–3 words, starts uppercase, no digits
  const givenWords = given.trim().split(/\s+/);
  if (givenWords.length > 3 || /\d/.test(given) || !/^[A-Z\u00C0-\u024F]/.test(given)) {
    return String(value || '').trim();
  }
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

export function stripMiddleInitials(key) {
  if (!key) return '';
  const parts = key.split(' ');
  if (parts.length >= 3) {
    return parts.filter((p, i) =>
      i === 0 || i === parts.length - 1 || p.length > 1
    ).join(' ');
  }
  return key;
}

export function namesCompatible(key1, key2) {
  if (key1 === key2) return true;
  
  const parts1 = key1.split(' ');
  const parts2 = key2.split(' ');
  
  // If both have middle initials and they are different, they are incompatible
  const hasInit1 = parts1.length >= 3 && parts1.some((p, i) => i > 0 && i < parts1.length - 1 && p.length === 1);
  const hasInit2 = parts2.length >= 3 && parts2.some((p, i) => i > 0 && i < parts2.length - 1 && p.length === 1);
  
  if (hasInit1 && hasInit2) {
    return false;
  }
  
  return stripMiddleInitials(key1) === stripMiddleInitials(key2);
}

export function dedupeSupervisorNames(values = []) {
  const out = [];
  for (const value of values) {
    const normalized = normalizePersonName(value);
    if (!normalized) continue;
    const baseKey = supervisorNameKey(normalized);
    if (!baseKey) continue;
    
    const strippedKey = stripMiddleInitials(baseKey);
    const canonical = SUPERVISOR_CANONICAL_OVERRIDES.get(baseKey) || 
                      SUPERVISOR_CANONICAL_OVERRIDES.get(strippedKey) || 
                      normalized;
                      
    const canonicalKey = supervisorNameKey(canonical);
    if (!canonicalKey) continue;

    let matchedIdx = -1;
    for (let i = 0; i < out.length; i++) {
      const existingKey = supervisorNameKey(out[i]);
      if (existingKey && namesCompatible(canonicalKey, existingKey)) {
        matchedIdx = i;
        break;
      }
    }

    if (matchedIdx !== -1) {
      // If incoming name contains a middle initial/name and existing doesn't, keep the more complete one
      const existing = out[matchedIdx];
      const existingKey = supervisorNameKey(existing);
      const partsExisting = existingKey.split(' ');
      const partsIncoming = canonicalKey.split(' ');
      if (partsIncoming.length > partsExisting.length) {
        out[matchedIdx] = canonical;
      }
    } else {
      out.push(canonical);
    }
  }
  return out;
}
