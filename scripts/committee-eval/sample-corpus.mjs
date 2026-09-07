// scripts/committee-eval/sample-corpus.mjs
// Usage:
//   node scripts/committee-eval/sample-corpus.mjs --discover
//   node scripts/committee-eval/sample-corpus.mjs --degrees "MA (Plan)" "History MA" --target-core 45 --per-reference 15
import { writeFileSync, mkdirSync } from 'node:fs';
import { getDb } from '../../src/db.js';
import { TURSO_DATABASE_URL } from '../../src/config.js';
import { buildManifestEntry, selectSample } from './lib/strata.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
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

const degrees = multi('--degrees');
if (!degrees.length) {
  console.error('Provide --degrees "MA (Plan)" "History MA" (confirm exact strings with --discover first).');
  process.exit(1);
}
const targetCore = num('--target-core', 45);
const perReference = num('--per-reference', 15);

const rs = await db.execute({ sql: 'SELECT doc_id, metadata_json FROM documents', args: [] });
const entries = rs.rows.map((row) => {
  let meta = {};
  try { meta = JSON.parse(row.metadata_json); } catch { meta = {}; }
  return buildManifestEntry(String(row.doc_id), meta);
});

const { manifest, counts } = selectSample(entries, { degrees, targetCore, perReference });
mkdirSync('test/fixtures/committee-eval', { recursive: true });
writeFileSync('test/fixtures/committee-eval/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote manifest: ${counts.total} docs (core=${counts.core}, reference=${counts.reference}).`);
process.exit(0);
