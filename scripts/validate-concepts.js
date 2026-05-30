import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { DOMAIN_DICTIONARY } from '../src/domainDictionary.js';

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const conceptPath = process.env.CONCEPTS_PATH || path.join(DATA_DIR, 'concepts', 'latest.json');
const parsed = JSON.parse(fs.readFileSync(conceptPath, 'utf-8'));
const dynamicMap = parsed.variantToCanonical || {};

const staticMap = new Map();
for (const entry of DOMAIN_DICTIONARY) {
  const canonical = normalizeText(entry.canonical);
  for (const variant of [entry.canonical, ...(entry.variants || [])]) {
    const normalizedVariant = normalizeText(variant);
    if (normalizedVariant) staticMap.set(normalizedVariant, canonical);
  }
}

const conflicts = [];
for (const [variant, canonical] of Object.entries(dynamicMap)) {
  const normalizedVariant = normalizeText(variant);
  const normalizedCanonical = normalizeText(canonical);
  const staticCanonical = staticMap.get(normalizedVariant);
  if (staticCanonical && staticCanonical !== normalizedCanonical) {
    conflicts.push({ variant: normalizedVariant, staticCanonical, dynamicCanonical: normalizedCanonical });
  }
}

if (conflicts.length) {
  console.error(`Found ${conflicts.length} static/dynamic concept dictionary conflict(s):`);
  for (const conflict of conflicts.slice(0, 25)) {
    console.error(`- ${conflict.variant}: static=${conflict.staticCanonical}; dynamic=${conflict.dynamicCanonical}`);
  }
  if (conflicts.length > 25) console.error(`...and ${conflicts.length - 25} more.`);
  process.exit(1);
}

console.log(`Concept dictionary validation passed (${Object.keys(dynamicMap).length} dynamic aliases, 0 conflicts).`);
