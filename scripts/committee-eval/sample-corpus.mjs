// scripts/committee-eval/sample-corpus.mjs
// Usage:
//   node scripts/committee-eval/sample-corpus.mjs --discover
//   node scripts/committee-eval/sample-corpus.mjs \
//     --targets "Master of Arts in Planning - MA (Plan)" "Master of Arts - MA::History" \
//     --per-era 25
// A --targets value is a degree, optionally narrowed to a program with "::Program".
// Use "Degree::Program" when the degree string is shared across programs (e.g.
// History is "Master of Arts - MA::History"). --per-era caps docs per (target × era),
// so both the pre-2018 and 2018+ regimes are deliberately sampled.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '../../src/db.js';
import { TURSO_DATABASE_URL } from '../../src/config.js';
import { buildManifestEntry, selectSample } from './lib/strata.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function str(flag, def) { const i = argv.indexOf(flag); return i === -1 ? def : argv[i + 1]; }
function multi(flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
}
function num(flag, def) {
  const i = argv.indexOf(flag);
  if (i === -1) return def;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`${flag} requires a positive number (got: ${argv[i + 1] ?? 'nothing'}).`);
    process.exit(1);
  }
  return v;
}

if (!TURSO_DATABASE_URL && !has('--allow-local')) {
  console.error('REFUSING to sample the local file DB. Set TURSO_DATABASE_URL (read-only) or pass --allow-local for smoke tests only.');
  process.exit(1);
}

const db = await getDb();

if (has('--discover')) {
  const rs = await db.execute({
    sql: `SELECT json_extract(metadata_json,'$.degree') AS degree,
                 json_extract(metadata_json,'$.program') AS program,
                 count(*) AS n
          FROM documents GROUP BY degree, program ORDER BY n DESC`,
    args: [],
  });
  for (const row of rs.rows) console.log(`${row.n}\t${row.degree ?? '∅'}\t${row.program ?? '∅'}`);
  process.exit(0);
}

// Each --targets value is "Degree" or "Degree::Program".
const targets = multi('--targets').map((s) => {
  const idx = s.indexOf('::');
  return idx === -1
    ? { degree: s.trim(), program: null }
    : { degree: s.slice(0, idx).trim(), program: s.slice(idx + 2).trim() || null };
});
if (!targets.length) {
  console.error('Provide --targets "Degree" "Degree::Program" ... (confirm exact strings with --discover first).');
  process.exit(1);
}
const perEra = num('--per-era', 25);

// --exclude <manifest.json>: docIds already sampled in a prior batch, so a widening
// batch stays DISJOINT (never re-samples/re-labels a doc). --out overrides the manifest path.
const excludePath = str('--exclude', null);
const exclude = excludePath
  ? new Set(JSON.parse(readFileSync(excludePath, 'utf8')).map((e) => String(e.docId)))
  : new Set();
const outPath = str('--out', 'test/fixtures/committee-eval/manifest.json');

const rs = await db.execute({ sql: 'SELECT doc_id, metadata_json FROM documents', args: [] });
const entries = rs.rows.map((row) => {
  let meta = {};
  try { meta = JSON.parse(row.metadata_json); } catch { meta = {}; }
  return buildManifestEntry(String(row.doc_id), meta);
});

const { manifest, counts } = selectSample(entries, { targets, perEra, exclude });
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote manifest: ${counts.total} docs${excludePath ? ` (excluding ${exclude.size} prior)` : ''} -> ${outPath}`);
for (const [cell, n] of Object.entries(counts.byCell)) console.log(`  ${cell}: ${n}`);
process.exit(0);
