#!/usr/bin/env node
// Converts the human-labeled worksheet CSV (data/committee-eval/gold-worksheet.csv)
// into a committed gold fixture (test/fixtures/committee-eval/gold.json).
//
// The reviewer filled in `name` (and `proposed_role`) directly on rows to record
// ground truth -- including on `source=none` placeholder rows. They did not use
// the `keep`/`true_role` columns. Rule: a row contributes a gold member iff its
// `name` field is non-empty. Rows with all-blank `name` mean "no recoverable
// supervisor" for that doc, and the doc still appears in gold with members: [].
//
// The `docId` column itself is corrupted (spreadsheet stripped trailing zeros
// from numeric-looking ids, e.g. "1.0100150" -> "1.010015"). The true docId is
// recovered from the `oc_url` column instead, which ends with /items/<trueDocId>.
//
// Zero dependencies, Node built-ins only (ESM).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CSV_PATH = join(REPO_ROOT, 'data/committee-eval/gold-worksheet.csv');
const OUT_PATH = join(REPO_ROOT, 'test/fixtures/committee-eval/gold.json');

// ---- CLI args ----
function parseArgs(argv) {
  let maxRows = 50;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max-rows') {
      const v = Number(argv[i + 1]);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error(`Invalid --max-rows value: ${argv[i + 1]}`);
      }
      maxRows = v;
      i++;
    }
  }
  return { maxRows };
}

// ---- RFC-4180 CSV parser ----
// Handles quoted fields, doubled "" escapes, commas and newlines inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  function endField() {
    row.push(field);
    field = '';
  }
  function endRow() {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      endField();
      i++;
      continue;
    }
    if (c === '\r') {
      // Skip; \r\n handled via the \n branch, bare \r treated as row end too.
      if (text[i + 1] === '\n') {
        i++;
        continue;
      }
      endRow();
      i++;
      continue;
    }
    if (c === '\n') {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Final field/row if the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    endRow();
  }
  return rows;
}

// ---- Role normalization ----
const CANONICAL_ROLES = [
  'Supervisor',
  'Co-Supervisor',
  'Supervisory Committee Member',
  'University Examiner',
  'External Examiner',
];

function normalizeRole(raw, docId, warnings) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return trimmed;

  // Exact match (case-insensitive) against the canonical set first.
  const exact = CANONICAL_ROLES.find(
    (r) => r.toLowerCase() === trimmed.toLowerCase()
  );
  if (exact) return exact;

  const lower = trimmed.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

  // Common typo/casing fixes.
  if (/^co ?supervisor$/.test(lower) || lower === 'co-supervisor') {
    return 'Co-Supervisor';
  }
  if (
    lower === 'supervisor' ||
    lower === 'supervisr' ||
    lower === 'suprvisor' ||
    lower === 'supervisior'
  ) {
    return 'Supervisor';
  }
  if (
    lower === 'supervisory committee member' ||
    lower === 'committee member' ||
    lower === 'supervisory committe member'
  ) {
    return 'Supervisory Committee Member';
  }
  if (lower === 'university examiner' || lower === 'univ examiner') {
    return 'University Examiner';
  }
  if (lower === 'external examiner' || lower === 'ext examiner') {
    return 'External Examiner';
  }

  warnings.push(`WARNING: unmapped role "${raw}" on ${docId}`);
  return trimmed;
}

// ---- docId recovery ----
function recoverDocId(ocUrl, fallback) {
  const m = /items\/(\S+)$/.exec((ocUrl || '').trim());
  if (m) return m[1];
  return fallback;
}

function main() {
  const { maxRows } = parseArgs(process.argv.slice(2));

  const csvText = readFileSync(CSV_PATH, 'utf8');
  const allRows = parseCsv(csvText).filter((r) => r.length > 1 || r[0] !== '');
  const header = allRows[0];
  const dataRows = allRows.slice(1, 1 + maxRows);

  const idx = {
    docId: header.indexOf('docId'),
    ocUrl: header.indexOf('oc_url'),
    name: header.indexOf('name'),
    proposedRole: header.indexOf('proposed_role'),
    isNegative: header.indexOf('is_negative'),
  };
  for (const [key, i] of Object.entries(idx)) {
    if (i === -1) throw new Error(`CSV missing expected column: ${key}`);
  }

  const warnings = [];
  const docsByTrueId = new Map(); // trueDocId -> { members: [], negatives: [] }
  const order = []; // preserve first-seen order (not strictly needed since we sort)

  for (const row of dataRows) {
    const rawDocId = row[idx.docId] || '';
    const ocUrl = row[idx.ocUrl] || '';
    const trueDocId = recoverDocId(ocUrl, rawDocId);

    const name = (row[idx.name] || '').trim();
    const proposedRole = row[idx.proposedRole] || '';
    const isNegative = /^y$/i.test((row[idx.isNegative] || '').trim());

    if (!docsByTrueId.has(trueDocId)) {
      docsByTrueId.set(trueDocId, { members: [], negatives: [] });
      order.push(trueDocId);
    }
    const doc = docsByTrueId.get(trueDocId);

    if (name) {
      const role = normalizeRole(proposedRole, trueDocId, warnings);
      if (isNegative) {
        doc.negatives.push(name);
      } else {
        doc.members.push({ name, role });
      }
    }
  }

  const gold = Array.from(docsByTrueId.entries())
    .map(([docId, { members, negatives }]) => ({ docId, members, negatives }))
    .sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(gold, null, 2) + '\n', 'utf8');

  // ---- Summary ----
  const docsWithMembers = gold.filter((d) => d.members.length > 0).length;
  const totalMembers = gold.reduce((sum, d) => sum + d.members.length, 0);
  const rolesUsed = new Set();
  for (const d of gold) for (const m of d.members) rolesUsed.add(m.role);

  console.log(`Rows read from CSV (data rows, capped at --max-rows=${maxRows}): ${dataRows.length}`);
  console.log(`Docs: ${gold.length}`);
  console.log(`Docs with >=1 member: ${docsWithMembers}`);
  console.log(`Total members: ${totalMembers}`);
  console.log(`Distinct roles used: ${[...rolesUsed].sort().join(', ') || '(none)'}`);
  console.log('');
  console.log('docId -> [member names]');
  for (const d of gold) {
    console.log(`  ${d.docId} -> [${d.members.map((m) => m.name).join(', ')}]`);
  }
  if (warnings.length) {
    console.log('');
    for (const w of warnings) console.log(w);
  }
  console.log('');
  console.log(`Wrote ${OUT_PATH}`);
}

main();
