# Committee / Supervisor Extraction Eval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible, live-connected eval harness that measures today's deterministic committee/supervisor extraction against a human-verified gold set drawn from prod, weighted toward the MA (Plan)/History MA failure population.

**Architecture:** A pipeline of single-purpose ESM CLI stages under `scripts/committee-eval/` that communicate through committed JSON (`manifest.json`, `gold.json`) and a gitignored text cache. Stage 1 (sample from prod Turso) and Stage 2 (fetch OC full text + PDF fallback) need network + creds; Stages 3–5 (build gold, score baseline, report) run fully offline. Nothing in `src/` is modified — the harness only imports existing exports. GLiNER shadow is Phase 2, deferred until Phase 1 numbers are reviewed.

**Tech Stack:** Node 18+ ESM (built-ins only), `@libsql/client` (already a dependency, via `getDb()`), `node:test` + `node:assert/strict` for tests. Reuses `src/db.js`, `src/pdf.js`, `src/supervisors.js`.

**Spec:** `docs/superpowers/specs/2026-09-06-committee-extraction-eval-design.md`

## Global Constraints

- **Node 18+, ESM only, zero new npm dependencies.** Use `import`, not `require`. Only `@libsql/client` (already present, reached through `getDb()`) and Node built-ins.
- **Never mutate `src/`.** Harness scripts import existing exports; they must not edit pipeline files or write to prod tables. (Read-only Turso token preferred.)
- **Refuse the local file DB by default.** `getDb()` falls back to `file:${SQLITE_PATH}` when `TURSO_DATABASE_URL` is unset. Stage 1 must detect this and abort with a clear error unless `--allow-local` is passed (smoke testing only). The local DB is 106 docs of mostly untargeted degrees — it is not prod.
- **Committed data:** `test/fixtures/committee-eval/manifest.json`, `test/fixtures/committee-eval/gold.json`, and `test/committeeEvalMatch.test.js`. **Gitignored (under `data/`):** full text, streamed PDFs, extracted text, model outputs, raw score dumps.
- **Degraded/missing text is never excluded.** OCR-degraded text stays in-scope, tagged. Missing derivative → stream PDF from OC via `fetchPdfForDocument`.
- **Never blend certificate-present and certificate-absent into one headline number.** Reporting leads with the certificate-absent failure cell; certificate-present is a harness-validation figure.
- **Query API:** `const db = await getDb(); const rs = await db.execute({ sql, args: [...] }); rs.rows` (array of column-keyed objects). Build a doc for pdf functions with `const doc = await loadDocumentMetadata(docId); doc.id = docId;` (see `scripts/reparse-committee.js`).
- **Import paths from `scripts/committee-eval/`:** `../../src/db.js`, `../../src/pdf.js`, `../../src/supervisors.js`. From `test/`: `../scripts/committee-eval/...`.
- **Cache dirs:** write harness caches under `data/committee-eval/` (already gitignored via `data/`). Constants: `EVAL_DIR = 'data/committee-eval'`.

---

## File Structure

```
scripts/committee-eval/
  lib/
    match.mjs         # Task 1 — pure name-normalization + set-matching (scoreDoc)
    strata.mjs        # Task 2 — pure: classifyEra, buildManifestEntry, selectSample
    quality.mjs       # Task 3 — pure: assessTextQuality (degradation heuristic)
    worksheet.mjs     # Task 4 — pure: buildWorksheetRows, finalizeGold
    baseline.mjs      # Task 5 — pure: extractBaseline (mirrors analyzeDocumentFullText), aggregate
    reporting.mjs     # Task 6 — pure: buildReport (stratified, no blended headline)
  sample-corpus.mjs   # Task 2 — CLI: --discover | sample → manifest.json
  fetch-fulltext.mjs  # Task 3 — CLI: manifest → cache + coverage.json
  build-gold.mjs      # Task 4 — CLI: worksheet emit | --finalize → gold.json
  score-baseline.mjs  # Task 5 — CLI: gold + cache → results-baseline.json
  report.mjs          # Task 6 — CLI: results → console table + report.json
  README.md           # Task 7 — how to run the pipeline end-to-end

test/
  committeeEvalMatch.test.js      # Task 1
  committeeEvalStrata.test.js     # Task 2
  committeeEvalQuality.test.js    # Task 3
  committeeEvalWorksheet.test.js  # Task 4
  committeeEvalBaseline.test.js   # Task 5
  committeeEvalReporting.test.js  # Task 6
  fixtures/committee-eval/
    manifest.json   # committed once real sample exists
    gold.json       # committed after human finalize
```

Pure logic lives in `lib/*.mjs` (unit-tested); each CLI is a thin I/O wrapper around its lib. This keeps the network stages' testable core separable from their side effects.

---

## Task 1: Shared match library (`lib/match.mjs`)

The scoring core reused by every scorer. Pure, no I/O, fully unit-tested. Build first.

**Files:**
- Create: `scripts/committee-eval/lib/match.mjs`
- Test: `test/committeeEvalMatch.test.js`

**Interfaces:**
- Consumes: `normalizePersonName`, `supervisorNameKey`, `namesCompatible` from `src/supervisors.js`.
- Produces:
  - `scoreDoc(predicted, gold)` where `predicted` = `[{name, role}]`, `gold` = `{members: [{name, role}], negatives: [string]}`. Returns `{ nameTP, nameFP, nameFN, roleTP, roleFP, roleFN, exactCase (bool), negativeViolations (number) }`.
  - `namesMatch(a, b)` → bool (wraps `supervisorNameKey` + `namesCompatible`).

- [ ] **Step 1: Write the failing test**

```javascript
// test/committeeEvalMatch.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreDoc, namesMatch } from '../scripts/committee-eval/lib/match.mjs';

test('namesMatch treats middle-initial and diacritic variants as equal', () => {
  assert.equal(namesMatch('Deirdre M. Kelly', 'Deirdre Kelly'), true);
  assert.equal(namesMatch('José García', 'Jose Garcia'), true);
  assert.equal(namesMatch('Jane Smith', 'John Smith'), false);
});

test('scoreDoc counts name and role hits with name-gated roles', () => {
  const predicted = [
    { name: 'Deirdre M. Kelly', role: 'Supervisor' },
    { name: 'Wrong Person', role: 'Supervisor' },
  ];
  const gold = {
    members: [
      { name: 'Deirdre Kelly', role: 'Supervisor' },
      { name: 'Alice Wong', role: 'Supervisory Committee Member' },
    ],
    negatives: [],
  };
  const s = scoreDoc(predicted, gold);
  assert.equal(s.nameTP, 1);   // Kelly matches
  assert.equal(s.nameFP, 1);   // Wrong Person
  assert.equal(s.nameFN, 1);   // Alice Wong missed
  assert.equal(s.roleTP, 1);   // Kelly role matches
  assert.equal(s.exactCase, false);
});

test('scoreDoc flags negative violations and exactCase', () => {
  const gold = {
    members: [{ name: 'Deirdre Kelly', role: 'Supervisor' }],
    negatives: ['My Boss At Work'],
  };
  const clean = scoreDoc([{ name: 'Deirdre Kelly', role: 'Supervisor' }], gold);
  assert.equal(clean.exactCase, true);
  assert.equal(clean.negativeViolations, 0);

  const dirty = scoreDoc(
    [{ name: 'Deirdre Kelly', role: 'Supervisor' }, { name: 'My Boss At Work', role: 'Supervisor' }],
    gold,
  );
  assert.equal(dirty.negativeViolations, 1);
  assert.equal(dirty.exactCase, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/committeeEvalMatch.test.js`
Expected: FAIL — `Cannot find module '.../lib/match.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/committee-eval/lib/match.mjs
import { normalizePersonName, supervisorNameKey, namesCompatible } from '../../../src/supervisors.js';

export function namesMatch(a, b) {
  const ka = supervisorNameKey(a);
  const kb = supervisorNameKey(b);
  if (!ka || !kb) return false;
  return namesCompatible(ka, kb);
}

// Greedy one-to-one matching of predicted names against gold member names.
function matchSets(predictedNames, goldNames) {
  const goldRemaining = goldNames.map((n) => ({ name: n, used: false }));
  const pairs = []; // { pIndex, gIndex }
  predictedNames.forEach((p, pIndex) => {
    const gIndex = goldRemaining.findIndex((g) => !g.used && namesMatch(p, g.name));
    if (gIndex !== -1) {
      goldRemaining[gIndex].used = true;
      pairs.push({ pIndex, gIndex });
    }
  });
  return pairs;
}

export function scoreDoc(predicted, gold) {
  const goldMembers = gold.members || [];
  const negatives = gold.negatives || [];
  const predNames = predicted.map((m) => m.name);
  const goldNames = goldMembers.map((m) => m.name);

  const pairs = matchSets(predNames, goldNames);
  const nameTP = pairs.length;
  const nameFP = predNames.length - nameTP;
  const nameFN = goldNames.length - nameTP;

  let roleTP = 0;
  for (const { pIndex, gIndex } of pairs) {
    if (predicted[pIndex].role === goldMembers[gIndex].role) roleTP += 1;
  }
  const roleFP = predicted.length - roleTP;
  const roleFN = goldMembers.length - roleTP;

  const exactCase = nameFP === 0 && nameFN === 0;

  let negativeViolations = 0;
  for (const p of predNames) {
    if (negatives.some((neg) => namesMatch(p, neg))) negativeViolations += 1;
  }

  return { nameTP, nameFP, nameFN, roleTP, roleFP, roleFN, exactCase, negativeViolations };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/committeeEvalMatch.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/committee-eval/lib/match.mjs test/committeeEvalMatch.test.js
git commit -m "feat(committee-eval): shared name-match + scoring library"
```

---

## Task 2: Sampling — `strata.mjs` + `sample-corpus.mjs`

Pure stratification logic (tested) plus the prod-Turso CLI with a mandatory `--discover` mode.

**Files:**
- Create: `scripts/committee-eval/lib/strata.mjs`, `scripts/committee-eval/sample-corpus.mjs`
- Test: `test/committeeEvalStrata.test.js`

**Interfaces:**
- Consumes: `getDb` from `src/db.js`.
- Produces (from `strata.mjs`):
  - `classifyEra(year)` → `'pre2018' | '2018plus'` (2018+ ⇒ `'2018plus'`; missing/NaN ⇒ `'pre2018'`).
  - `buildManifestEntry(docId, metadata)` → `{ docId, degree, program, year, title, author, originalRecordUrl, era, certificateSignalGuess, stratum }` where `certificateSignalGuess = classifyEra(year) === '2018plus'` and `stratum` is `` `${targetOrReference}:${era}` ``.
  - `selectSample(entries, { degrees, targetCore, perReference })` → `{ manifest: [...], counts: {...} }`. Target entries: `degrees.includes(degree)`. Splits target entries into `core` (certificateSignalGuess false) and `reference` (true); samples up to `targetCore` from core (prefer even era split) and up to `perReference` from reference.

- [ ] **Step 1: Write the failing test**

```javascript
// test/committeeEvalStrata.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEra, buildManifestEntry, selectSample } from '../scripts/committee-eval/lib/strata.mjs';

test('classifyEra splits on 2018', () => {
  assert.equal(classifyEra(2010), 'pre2018');
  assert.equal(classifyEra(2018), '2018plus');
  assert.equal(classifyEra(undefined), 'pre2018');
});

test('buildManifestEntry derives era and certificate guess', () => {
  const e = buildManifestEntry('1.0001', {
    degree: 'MA (Plan)', program: 'Planning', year: 2012,
    title: 'T', author: 'A', originalRecordUrl: 'https://circle.library.ubc.ca/rest/handle/1/2',
  });
  assert.equal(e.era, 'pre2018');
  assert.equal(e.certificateSignalGuess, false);
  assert.equal(e.degree, 'MA (Plan)');
});

test('selectSample oversamples the target degrees and caps reference', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) {
    entries.push(buildManifestEntry(`c${i}`, { degree: 'MA (Plan)', program: 'P', year: 2010, title: 't', author: 'a', originalRecordUrl: 'u' }));
  }
  for (let i = 0; i < 30; i++) {
    entries.push(buildManifestEntry(`r${i}`, { degree: 'MA (Plan)', program: 'P', year: 2020, title: 't', author: 'a', originalRecordUrl: 'u' }));
  }
  entries.push(buildManifestEntry('x', { degree: 'PhD Chemistry', program: 'Chem', year: 2019, title: 't', author: 'a', originalRecordUrl: 'u' }));
  const { manifest, counts } = selectSample(entries, { degrees: ['MA (Plan)'], targetCore: 10, perReference: 5 });
  assert.equal(counts.core, 10);
  assert.equal(counts.reference, 5);
  assert.equal(manifest.length, 15);
  assert.ok(manifest.every((m) => m.degree === 'MA (Plan)'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/committeeEvalStrata.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/committee-eval/lib/strata.mjs
export function classifyEra(year) {
  const y = Number(year);
  return Number.isFinite(y) && y >= 2018 ? '2018plus' : 'pre2018';
}

export function buildManifestEntry(docId, metadata = {}) {
  const era = classifyEra(metadata.year);
  return {
    docId,
    degree: metadata.degree ?? null,
    program: metadata.program ?? null,
    year: metadata.year ?? null,
    title: metadata.title ?? null,
    author: metadata.author ?? null,
    originalRecordUrl: metadata.originalRecordUrl ?? null,
    era,
    certificateSignalGuess: era === '2018plus',
    stratum: null, // set in selectSample once core/reference is known
  };
}

function take(list, n) {
  return list.slice(0, Math.max(0, n));
}

export function selectSample(entries, { degrees, targetCore, perReference }) {
  const targetSet = new Set(degrees);
  const target = entries.filter((e) => targetSet.has(e.degree));
  const core = target.filter((e) => !e.certificateSignalGuess);
  const reference = target.filter((e) => e.certificateSignalGuess);

  // Prefer an even era split within core (all core is pre2018 by construction of the guess,
  // but a doc can be pre-2018 yet 2018+ metadata-less; keep the split logic explicit and stable).
  const corePicked = take(core, targetCore).map((e) => ({ ...e, stratum: `core:${e.era}` }));
  const refPicked = take(reference, perReference).map((e) => ({ ...e, stratum: `reference:${e.era}` }));

  const manifest = [...corePicked, ...refPicked];
  return { manifest, counts: { core: corePicked.length, reference: refPicked.length, total: manifest.length } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/committeeEvalStrata.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/committee-eval/lib/strata.mjs test/committeeEvalStrata.test.js
git commit -m "feat(committee-eval): stratification + sample-selection library"
```

- [ ] **Step 6: Write the CLI (`sample-corpus.mjs`)**

```javascript
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
  return i === -1 ? def : Number(argv[i + 1]);
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
```

- [ ] **Step 7: Smoke-verify the CLI against the local DB**

Run: `node scripts/committee-eval/sample-corpus.mjs --discover --allow-local`
Expected: prints `count<TAB>degree<TAB>program` rows (local DB values like `MA`, `Scan Route …`). This only proves the query + JSON extraction wire up; the real degree strings come from a prod `--discover` run in Task 7.

- [ ] **Step 8: Commit**

```bash
git add scripts/committee-eval/sample-corpus.mjs
git commit -m "feat(committee-eval): sample-corpus CLI with mandatory --discover and local-DB guard"
```

---

## Task 3: Full-text fetch — `quality.mjs` + `fetch-fulltext.mjs`

Pure degradation heuristic (tested) plus the fetch loop with PDF fallback.

**Files:**
- Create: `scripts/committee-eval/lib/quality.mjs`, `scripts/committee-eval/fetch-fulltext.mjs`
- Test: `test/committeeEvalQuality.test.js`

**Interfaces:**
- Consumes: `loadDocumentMetadata` from `src/db.js`; `fetchFullTextForDocument`, `fetchPdfForDocument` from `src/pdf.js`.
- Produces (from `quality.mjs`): `assessTextQuality(text)` → `{ degraded (bool), byteLength (number), reason (string|null) }`. Degraded when `byteLength < 1200`, OR the ratio of single-character whitespace-separated tokens to total tokens exceeds `0.25`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/committeeEvalQuality.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessTextQuality } from '../scripts/committee-eval/lib/quality.mjs';

test('clean prose is not degraded', () => {
  const text = 'I thank my supervisor, Dr. Deirdre Kelly, for her guidance. '.repeat(60);
  const q = assessTextQuality(text);
  assert.equal(q.degraded, false);
});

test('very short text is degraded', () => {
  const q = assessTextQuality('too short');
  assert.equal(q.degraded, true);
  assert.equal(q.reason, 'short');
});

test('glyph-per-token OCR spray is degraded', () => {
  const text = ('a b c d e f g h i j k l m n o p q r s t u v w x y z ').repeat(30);
  const q = assessTextQuality(text);
  assert.equal(q.degraded, true);
  assert.equal(q.reason, 'fragmented');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/committeeEvalQuality.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/committee-eval/lib/quality.mjs
export function assessTextQuality(text) {
  const str = String(text || '');
  const byteLength = Buffer.byteLength(str, 'utf8');
  if (byteLength < 1200) return { degraded: true, byteLength, reason: 'short' };

  const tokens = str.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { degraded: true, byteLength, reason: 'short' };
  const singles = tokens.filter((t) => t.replace(/[^\p{L}\p{N}]/gu, '').length === 1).length;
  const ratio = singles / tokens.length;
  if (ratio > 0.25) return { degraded: true, byteLength, reason: 'fragmented' };

  return { degraded: false, byteLength, reason: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/committeeEvalQuality.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/committee-eval/lib/quality.mjs test/committeeEvalQuality.test.js
git commit -m "feat(committee-eval): text-quality degradation heuristic"
```

- [ ] **Step 6: Write the fetch CLI (`fetch-fulltext.mjs`)**

```javascript
// scripts/committee-eval/fetch-fulltext.mjs
// Reads manifest.json, fetches OC full text (PDF fallback on miss) into the cache,
// writes coverage.json. Requires prod connectivity.
// Usage: node scripts/committee-eval/fetch-fulltext.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadDocumentMetadata } from '../../src/db.js';
import { fetchFullTextForDocument, fetchPdfForDocument } from '../../src/pdf.js';
import { assessTextQuality } from './lib/quality.mjs';

const EVAL_DIR = 'data/committee-eval';
const TEXT_DIR = path.join(EVAL_DIR, 'fulltext');
mkdirSync(TEXT_DIR, { recursive: true });

const manifest = JSON.parse(readFileSync('test/fixtures/committee-eval/manifest.json', 'utf8'));
const coverage = [];

for (const entry of manifest) {
  const meta = await loadDocumentMetadata(entry.docId);
  if (!meta) { coverage.push({ docId: entry.docId, textSource: 'unavailable', degraded: false, byteLength: 0, reason: 'no-metadata' }); continue; }
  const doc = { ...meta, id: entry.docId };

  let text = null;
  let textSource = null;
  const ft = await fetchFullTextForDocument(doc, null, { persistFullText: false });
  if (ft && ft.fullText) { text = ft.fullText; textSource = 'dspace_text'; }
  else {
    // Derivative missing/too-short — stream the PDF and extract text via the existing pipeline.
    const pdf = await fetchPdfForDocument(doc, {});
    if (pdf && pdf.fullText) { text = pdf.fullText; textSource = 'pdf_fallback'; }
  }

  if (!text) { coverage.push({ docId: entry.docId, textSource: 'unavailable', degraded: false, byteLength: 0, reason: 'no-text-no-pdf' }); continue; }

  const q = assessTextQuality(text);
  writeFileSync(path.join(TEXT_DIR, `${entry.docId}.txt`), text);
  coverage.push({ docId: entry.docId, textSource, degraded: q.degraded, byteLength: q.byteLength, reason: q.reason });
}

writeFileSync(path.join(EVAL_DIR, 'coverage.json'), JSON.stringify(coverage, null, 2) + '\n');
const roll = coverage.reduce((a, c) => {
  a[c.textSource] = (a[c.textSource] || 0) + 1;
  if (c.degraded) a.degraded += 1;
  return a;
}, { degraded: 0 });
console.log('Coverage:', JSON.stringify(roll));
```

> **Executor note:** confirm `fetchPdfForDocument` returns extracted text on `.fullText`. Read `src/pdf.js:1116+`. If it returns raw bytes plus a separate extraction step, adapt this step to call that extraction (do not invent an API). This is the one interface to verify against source before running.

- [ ] **Step 7: Smoke-verify on a 2-doc manifest against prod**

In a creds-connected session, hand-write `test/fixtures/committee-eval/manifest.json` with 2 known docIds (e.g. from `scripts/reparse-committee.js`), then:
Run: `node scripts/committee-eval/fetch-fulltext.mjs`
Expected: `data/committee-eval/fulltext/<docId>.txt` files exist and `coverage.json` prints a rollup with `dspace_text` and/or `pdf_fallback` counts.

- [ ] **Step 8: Commit**

```bash
git add scripts/committee-eval/fetch-fulltext.mjs
git commit -m "feat(committee-eval): full-text fetch with PDF fallback and coverage report"
```

---

## Task 4: Gold worksheet — `worksheet.mjs` + `build-gold.mjs`

Pure worksheet generation + finalize (tested), plus the CLI that runs the parsers over cached text.

**Files:**
- Create: `scripts/committee-eval/lib/worksheet.mjs`, `scripts/committee-eval/build-gold.mjs`
- Test: `test/committeeEvalWorksheet.test.js`

**Interfaces:**
- Consumes: `namesMatch` from `./lib/match.mjs`.
- Produces (from `worksheet.mjs`):
  - `buildWorksheetRows(docId, { committee, acknowledgement, certificatePresent })` → array of `{ docId, name, proposed_role, on_certificate, source, keep, true_role, is_negative }`. `committee`/`acknowledgement` are `[{name, role}]`. Certificate members → `source:'certificate', on_certificate:true, keep:'', is_negative:''`. Acknowledgement names NOT matching any certificate member → `source:'acknowledgement', on_certificate:false, is_negative:'Y'` (FP-trap candidate). Rows carry empty human-fill fields.
  - `finalizeGold(rows)` → `{docId, members, negatives}[]` grouping reviewed rows: `keep === 'Y'` → member `{name, role: true_role || proposed_role}`; `is_negative === 'Y'` → `negatives.push(name)`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/committeeEvalWorksheet.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorksheetRows, finalizeGold } from '../scripts/committee-eval/lib/worksheet.mjs';

test('buildWorksheetRows marks off-certificate ack names as negative candidates', () => {
  const rows = buildWorksheetRows('1.0001', {
    committee: [{ name: 'Deirdre Kelly', role: 'Supervisor' }],
    acknowledgement: [{ name: 'Deirdre Kelly', role: 'Supervisor' }, { name: 'My Boss', role: 'Supervisor' }],
    certificatePresent: true,
  });
  const boss = rows.find((r) => r.name === 'My Boss');
  assert.equal(boss.on_certificate, false);
  assert.equal(boss.is_negative, 'Y');
  const kelly = rows.find((r) => r.name === 'Deirdre Kelly' && r.source === 'certificate');
  assert.ok(kelly);
});

test('finalizeGold groups reviewed rows into members and negatives', () => {
  const reviewed = [
    { docId: '1.0001', name: 'Deirdre Kelly', proposed_role: 'Supervisor', keep: 'Y', true_role: '', is_negative: '' },
    { docId: '1.0001', name: 'My Boss', proposed_role: 'Supervisor', keep: 'N', true_role: '', is_negative: 'Y' },
    { docId: '1.0002', name: 'Alice Wong', proposed_role: 'Supervisor', keep: 'Y', true_role: 'Co-Supervisor', is_negative: '' },
  ];
  const gold = finalizeGold(reviewed);
  const d1 = gold.find((g) => g.docId === '1.0001');
  assert.deepEqual(d1.members, [{ name: 'Deirdre Kelly', role: 'Supervisor' }]);
  assert.deepEqual(d1.negatives, ['My Boss']);
  const d2 = gold.find((g) => g.docId === '1.0002');
  assert.deepEqual(d2.members, [{ name: 'Alice Wong', role: 'Co-Supervisor' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/committeeEvalWorksheet.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/committee-eval/lib/worksheet.mjs
import { namesMatch } from './match.mjs';

export function buildWorksheetRows(docId, { committee = [], acknowledgement = [], certificatePresent = false }) {
  const rows = [];
  for (const m of committee) {
    rows.push({ docId, name: m.name, proposed_role: m.role, on_certificate: true, source: 'certificate', keep: '', true_role: '', is_negative: '' });
  }
  for (const a of acknowledgement) {
    const onCert = committee.some((c) => namesMatch(c.name, a.name));
    if (onCert) continue; // already represented by its certificate row
    rows.push({ docId, name: a.name, proposed_role: a.role, on_certificate: false, source: 'acknowledgement', keep: '', true_role: '', is_negative: certificatePresent ? 'Y' : '' });
  }
  return rows;
}

export function finalizeGold(rows) {
  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.docId)) byDoc.set(r.docId, { docId: r.docId, members: [], negatives: [] });
    const g = byDoc.get(r.docId);
    if (String(r.keep).toUpperCase() === 'Y') g.members.push({ name: r.name, role: (r.true_role && r.true_role.trim()) || r.proposed_role });
    if (String(r.is_negative).toUpperCase() === 'Y') g.negatives.push(r.name);
  }
  return [...byDoc.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/committeeEvalWorksheet.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/committee-eval/lib/worksheet.mjs test/committeeEvalWorksheet.test.js
git commit -m "feat(committee-eval): gold worksheet builder + finalize"
```

- [ ] **Step 6: Write the CLI (`build-gold.mjs`)**

```javascript
// scripts/committee-eval/build-gold.mjs
// Emit worksheet (default) or finalize into gold.json (--finalize).
// Usage:
//   node scripts/committee-eval/build-gold.mjs                 # emit gold-worksheet.{json,csv}
//   node scripts/committee-eval/build-gold.mjs --finalize      # gold-worksheet.json (reviewed) -> gold.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseCommittee, parseAcknowledgementsDetailed } from '../../src/pdf.js';
import { buildWorksheetRows, finalizeGold } from './lib/worksheet.mjs';

const EVAL_DIR = 'data/committee-eval';
const TEXT_DIR = path.join(EVAL_DIR, 'fulltext');
const WORKSHEET_JSON = path.join(EVAL_DIR, 'gold-worksheet.json');
const WORKSHEET_CSV = path.join(EVAL_DIR, 'gold-worksheet.csv');
const GOLD = 'test/fixtures/committee-eval/gold.json';

const argv = process.argv.slice(2);

if (argv.includes('--finalize')) {
  const reviewed = JSON.parse(readFileSync(WORKSHEET_JSON, 'utf8'));
  const gold = finalizeGold(reviewed);
  writeFileSync(GOLD, JSON.stringify(gold, null, 2) + '\n');
  console.log(`Wrote ${gold.length} docs to ${GOLD}.`);
  process.exit(0);
}

const manifest = JSON.parse(readFileSync('test/fixtures/committee-eval/manifest.json', 'utf8'));
const coverage = existsSync(path.join(EVAL_DIR, 'coverage.json'))
  ? JSON.parse(readFileSync(path.join(EVAL_DIR, 'coverage.json'), 'utf8'))
  : [];
const coverageByDoc = new Map(coverage.map((c) => [c.docId, c]));

const rows = [];
for (const entry of manifest) {
  const textPath = path.join(TEXT_DIR, `${entry.docId}.txt`);
  if (!existsSync(textPath)) continue;
  const fullText = readFileSync(textPath, 'utf8');
  const certificatePresent = /the following individuals certify/i.test(fullText);
  const committee = parseCommittee(fullText);
  const acknowledgement = parseAcknowledgementsDetailed(fullText).members;
  const docRows = buildWorksheetRows(entry.docId, { committee, acknowledgement, certificatePresent });
  // Attach the acknowledgements text slice for hand-labeling certificate-absent docs.
  const ackIdx = fullText.search(/acknowledg/i);
  const ackSlice = ackIdx === -1 ? '' : fullText.slice(ackIdx, ackIdx + 1500).replace(/\s+/g, ' ');
  for (const r of docRows) rows.push({ ...r, era: entry.era, degraded: coverageByDoc.get(entry.docId)?.degraded ?? '', ack_slice: r.source === 'certificate' ? '' : ackSlice });
}

writeFileSync(WORKSHEET_JSON, JSON.stringify(rows, null, 2) + '\n');
const header = ['docId', 'name', 'proposed_role', 'on_certificate', 'source', 'era', 'degraded', 'keep', 'true_role', 'is_negative', 'ack_slice'];
const csv = [header.join(',')].concat(
  rows.map((r) => header.map((h) => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')),
).join('\n');
writeFileSync(WORKSHEET_CSV, csv + '\n');
console.log(`Wrote ${rows.length} worksheet rows for ${manifest.length} docs.`);
```

- [ ] **Step 7: Smoke-verify worksheet generation from cached text**

With the 2-doc cache from Task 3 present:
Run: `node scripts/committee-eval/build-gold.mjs`
Expected: `data/committee-eval/gold-worksheet.{json,csv}` created; rows include `certificate` and/or `acknowledgement` sources.

- [ ] **Step 8: Commit**

```bash
git add scripts/committee-eval/build-gold.mjs
git commit -m "feat(committee-eval): build-gold worksheet + finalize CLI"
```

---

## Task 5: Baseline scorer — `baseline.mjs` + `score-baseline.mjs`

The heart of the eval: replicate the production merge and score it. Pure `extractBaseline` + `aggregate` (tested), plus the CLI.

**Files:**
- Create: `scripts/committee-eval/lib/baseline.mjs`, `scripts/committee-eval/score-baseline.mjs`
- Test: `test/committeeEvalBaseline.test.js`

**Interfaces:**
- Consumes: `parseCommittee`, `parseAcknowledgementsDetailed` from `src/pdf.js`; `scoreDoc` from `./lib/match.mjs`.
- Produces (from `baseline.mjs`):
  - `extractBaseline(fullText, { parseCommittee, parseAcknowledgementsDetailed })` → `[{name, role}]`. Mirrors `analyzeDocumentFullText`: run `parseCommittee`; if it yields **no supervisor role** (`Supervisor`/`Co-Supervisor`), append `parseAcknowledgementsDetailed(fullText).members`; dedupe by name. (Parsers injected for testability.)
  - `aggregate(perDoc)` where `perDoc` = `[{ stratumKey, score }]` (score from `scoreDoc`) → `{ [stratumKey]: { namePrecision, nameRecall, nameF1, rolePrecision, roleRecall, roleF1, exactCaseRate, negativeViolations, docs } }`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/committeeEvalBaseline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBaseline, aggregate } from '../scripts/committee-eval/lib/baseline.mjs';

test('extractBaseline falls back to acknowledgements only when no supervisor in committee', () => {
  const fakeCommittee = () => [{ name: 'Al Examiner', role: 'University Examiner' }];
  const fakeAck = () => ({ members: [{ name: 'Deirdre Kelly', role: 'Supervisor' }] });
  const out = extractBaseline('irrelevant', { parseCommittee: fakeCommittee, parseAcknowledgementsDetailed: fakeAck });
  assert.deepEqual(out, [
    { name: 'Al Examiner', role: 'University Examiner' },
    { name: 'Deirdre Kelly', role: 'Supervisor' },
  ]);
});

test('extractBaseline skips acknowledgements when committee already has a supervisor', () => {
  const fakeCommittee = () => [{ name: 'Deirdre Kelly', role: 'Supervisor' }];
  const fakeAck = () => { throw new Error('should not be called'); };
  const out = extractBaseline('x', { parseCommittee: fakeCommittee, parseAcknowledgementsDetailed: fakeAck });
  assert.equal(out.length, 1);
});

test('aggregate computes precision/recall per stratum', () => {
  const perDoc = [
    { stratumKey: 'core:pre2018', score: { nameTP: 1, nameFP: 1, nameFN: 0, roleTP: 1, roleFP: 1, roleFN: 0, exactCase: false, negativeViolations: 1 } },
    { stratumKey: 'core:pre2018', score: { nameTP: 1, nameFP: 0, nameFN: 1, roleTP: 1, roleFP: 0, roleFN: 1, exactCase: false, negativeViolations: 0 } },
  ];
  const agg = aggregate(perDoc)['core:pre2018'];
  assert.equal(agg.docs, 2);
  assert.equal(agg.namePrecision, 2 / 3); // TP=2, FP=1
  assert.equal(agg.nameRecall, 2 / 3);    // TP=2, FN=1
  assert.equal(agg.negativeViolations, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/committeeEvalBaseline.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/committee-eval/lib/baseline.mjs
const SUPERVISOR_ROLES = new Set(['Supervisor', 'Co-Supervisor']);

export function extractBaseline(fullText, { parseCommittee, parseAcknowledgementsDetailed }) {
  const committee = parseCommittee(fullText) || [];
  const hasSupervisor = committee.some((m) => SUPERVISOR_ROLES.has(m.role));
  const members = [...committee];
  if (!hasSupervisor) {
    const ack = parseAcknowledgementsDetailed(fullText)?.members || [];
    for (const a of ack) members.push(a);
  }
  // Dedupe by lowercased name, keeping first occurrence.
  const seen = new Set();
  return members.filter((m) => {
    const key = String(m.name || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ratio(tp, other) {
  const denom = tp + other;
  return denom === 0 ? 1 : tp / denom;
}
function f1(p, r) { return p + r === 0 ? 0 : (2 * p * r) / (p + r); }

export function aggregate(perDoc) {
  const groups = {};
  for (const { stratumKey, score } of perDoc) {
    if (!groups[stratumKey]) groups[stratumKey] = { nameTP: 0, nameFP: 0, nameFN: 0, roleTP: 0, roleFP: 0, roleFN: 0, exact: 0, neg: 0, docs: 0 };
    const g = groups[stratumKey];
    g.nameTP += score.nameTP; g.nameFP += score.nameFP; g.nameFN += score.nameFN;
    g.roleTP += score.roleTP; g.roleFP += score.roleFP; g.roleFN += score.roleFN;
    g.exact += score.exactCase ? 1 : 0; g.neg += score.negativeViolations; g.docs += 1;
  }
  const out = {};
  for (const [k, g] of Object.entries(groups)) {
    const nameP = ratio(g.nameTP, g.nameFP), nameR = ratio(g.nameTP, g.nameFN);
    const roleP = ratio(g.roleTP, g.roleFP), roleR = ratio(g.roleTP, g.roleFN);
    out[k] = {
      namePrecision: nameP, nameRecall: nameR, nameF1: f1(nameP, nameR),
      rolePrecision: roleP, roleRecall: roleR, roleF1: f1(roleP, roleR),
      exactCaseRate: g.docs ? g.exact / g.docs : 0,
      negativeViolations: g.neg, docs: g.docs,
    };
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/committeeEvalBaseline.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/committee-eval/lib/baseline.mjs test/committeeEvalBaseline.test.js
git commit -m "feat(committee-eval): baseline extraction merge + aggregation"
```

- [ ] **Step 6: Write the CLI (`score-baseline.mjs`)**

```javascript
// scripts/committee-eval/score-baseline.mjs
// Scores baseline extraction against gold.json using cached full text.
// Usage: node scripts/committee-eval/score-baseline.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseCommittee, parseAcknowledgementsDetailed } from '../../src/pdf.js';
import { scoreDoc } from './lib/match.mjs';
import { extractBaseline, aggregate } from './lib/baseline.mjs';

const EVAL_DIR = 'data/committee-eval';
const TEXT_DIR = path.join(EVAL_DIR, 'fulltext');

const manifest = JSON.parse(readFileSync('test/fixtures/committee-eval/manifest.json', 'utf8'));
const gold = JSON.parse(readFileSync('test/fixtures/committee-eval/gold.json', 'utf8'));
const coverage = existsSync(path.join(EVAL_DIR, 'coverage.json'))
  ? JSON.parse(readFileSync(path.join(EVAL_DIR, 'coverage.json'), 'utf8')) : [];
const goldByDoc = new Map(gold.map((g) => [g.docId, g]));
const manifestByDoc = new Map(manifest.map((m) => [m.docId, m]));
const coverageByDoc = new Map(coverage.map((c) => [c.docId, c]));

const perDoc = [];
const details = [];
for (const g of gold) {
  const entry = manifestByDoc.get(g.docId);
  const textPath = path.join(TEXT_DIR, `${g.docId}.txt`);
  if (!entry || !existsSync(textPath)) continue;
  const fullText = readFileSync(textPath, 'utf8');
  const certificatePresent = /the following individuals certify/i.test(fullText);
  const predicted = extractBaseline(fullText, { parseCommittee, parseAcknowledgementsDetailed });
  const score = scoreDoc(predicted, g);
  const degraded = coverageByDoc.get(g.docId)?.degraded ? 'degraded' : 'clean';
  const stratumKey = `${certificatePresent ? 'cert' : 'nocert'}:${entry.era}:${degraded}`;
  perDoc.push({ stratumKey, score });
  details.push({ docId: g.docId, stratumKey, predicted, score });
}

const byStratum = aggregate(perDoc);
writeFileSync(path.join(EVAL_DIR, 'results-baseline.json'), JSON.stringify({ byStratum, details }, null, 2) + '\n');
console.log(`Scored ${perDoc.length} docs across ${Object.keys(byStratum).length} strata.`);
```

- [ ] **Step 7: Smoke-verify scoring with a tiny hand-made gold**

Create a 1-doc `test/fixtures/committee-eval/gold.json` matching a cached doc, then:
Run: `node scripts/committee-eval/score-baseline.mjs`
Expected: `data/committee-eval/results-baseline.json` written; console reports scored-doc count.

- [ ] **Step 8: Commit**

```bash
git add scripts/committee-eval/score-baseline.mjs
git commit -m "feat(committee-eval): baseline scorer CLI (stratified, cert vs nocert)"
```

---

## Task 6: Report — `reporting.mjs` + `report.mjs`

Turn stratified results into an honest table. Pure `buildReport` (tested) + thin CLI.

**Files:**
- Create: `scripts/committee-eval/lib/reporting.mjs`, `scripts/committee-eval/report.mjs`
- Test: `test/committeeEvalReporting.test.js`

**Interfaces:**
- Consumes: `byStratum` object from `results-baseline.json`.
- Produces (from `reporting.mjs`): `buildReport(byStratum)` → `{ failureCells: [...], validationCells: [...], warning: string }`. Cells whose key starts with `nocert:` are failure cells (the metric that matters); `cert:` cells are validation cells. `warning` is a fixed string stating the two must not be averaged. Each cell is `{ stratumKey, ...metrics }`, failure cells sorted by `nameRecall` ascending (worst first).

- [ ] **Step 1: Write the failing test**

```javascript
// test/committeeEvalReporting.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../scripts/committee-eval/lib/reporting.mjs';

test('buildReport separates failure (nocert) from validation (cert) cells', () => {
  const byStratum = {
    'cert:2018plus:clean': { namePrecision: 1, nameRecall: 1, nameF1: 1, rolePrecision: 1, roleRecall: 1, roleF1: 1, exactCaseRate: 1, negativeViolations: 0, docs: 10 },
    'nocert:pre2018:clean': { namePrecision: 0.8, nameRecall: 0.5, nameF1: 0.62, rolePrecision: 0.7, roleRecall: 0.4, roleF1: 0.5, exactCaseRate: 0.3, negativeViolations: 2, docs: 20 },
    'nocert:pre2018:degraded': { namePrecision: 0.6, nameRecall: 0.3, nameF1: 0.4, rolePrecision: 0.5, roleRecall: 0.2, roleF1: 0.3, exactCaseRate: 0.1, negativeViolations: 4, docs: 8 },
  };
  const report = buildReport(byStratum);
  assert.equal(report.validationCells.length, 1);
  assert.equal(report.failureCells.length, 2);
  // worst recall first
  assert.equal(report.failureCells[0].stratumKey, 'nocert:pre2018:degraded');
  assert.match(report.warning, /not be averaged|do not blend|never blend/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/committeeEvalReporting.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/committee-eval/lib/reporting.mjs
export function buildReport(byStratum) {
  const cells = Object.entries(byStratum).map(([stratumKey, m]) => ({ stratumKey, ...m }));
  const failureCells = cells.filter((c) => c.stratumKey.startsWith('nocert:'))
    .sort((a, b) => a.nameRecall - b.nameRecall);
  const validationCells = cells.filter((c) => c.stratumKey.startsWith('cert:'));
  return {
    failureCells,
    validationCells,
    warning: 'Certificate-absent (nocert) and certificate-present (cert) cells must NOT be averaged. '
      + 'cert cells are a harness-validation figure (parseCommittee scored against parseCommittee-derived gold); '
      + 'the metric that matters is nocert recall.',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/committeeEvalReporting.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add scripts/committee-eval/lib/reporting.mjs test/committeeEvalReporting.test.js
git commit -m "feat(committee-eval): report builder with cert/nocert separation"
```

- [ ] **Step 6: Write the CLI (`report.mjs`)**

```javascript
// scripts/committee-eval/report.mjs
// Renders results-baseline.json into a console table + report.json.
// Usage: node scripts/committee-eval/report.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildReport } from './lib/reporting.mjs';

const EVAL_DIR = 'data/committee-eval';
const { byStratum } = JSON.parse(readFileSync(path.join(EVAL_DIR, 'results-baseline.json'), 'utf8'));
const report = buildReport(byStratum);

function pct(x) { return `${(x * 100).toFixed(1)}%`; }
function printCells(title, cells) {
  console.log(`\n=== ${title} ===`);
  console.log('stratum'.padEnd(28), 'docs', 'nameP', 'nameR', 'roleR', 'exact', 'negViol');
  for (const c of cells) {
    console.log(
      c.stratumKey.padEnd(28), String(c.docs).padStart(4),
      pct(c.namePrecision), pct(c.nameRecall), pct(c.roleRecall), pct(c.exactCaseRate), String(c.negativeViolations).padStart(4),
    );
  }
}

printCells('FAILURE POPULATION (nocert) — the metric that matters', report.failureCells);
printCells('HARNESS VALIDATION (cert) — do not treat as accuracy', report.validationCells);
console.log(`\n⚠ ${report.warning}`);
writeFileSync(path.join(EVAL_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');
```

- [ ] **Step 7: Smoke-verify the report renders**

With `results-baseline.json` from Task 5:
Run: `node scripts/committee-eval/report.mjs`
Expected: prints FAILURE and VALIDATION tables + the warning; writes `report.json`.

- [ ] **Step 8: Commit**

```bash
git add scripts/committee-eval/report.mjs
git commit -m "feat(committee-eval): report CLI (failure-cell-first console table)"
```

---

## Task 7: End-to-end run docs + full-suite check

Glue, documentation, and the real prod run instructions. No new logic.

**Files:**
- Create: `scripts/committee-eval/README.md`

- [ ] **Step 1: Write the README**

```markdown
# Committee / Supervisor Extraction Eval

Measures the deterministic committee/supervisor extractor against a human-verified gold set,
weighted toward the MA (Plan)/History MA failure population. Nothing here modifies `src/`.

## Prerequisites
- A **read-only** prod Turso token exported as `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`
  (Stages 1–2 only). Without them the sampler refuses to run (pass `--allow-local` for smoke tests).

## Pipeline
1. **Discover real degree strings (do this first):**
   `node scripts/committee-eval/sample-corpus.mjs --discover`
2. **Sample** (confirm exact strings from step 1):
   `node scripts/committee-eval/sample-corpus.mjs --degrees "MA (Plan)" "History MA" --target-core 45 --per-reference 15`
3. **Fetch full text** (+ PDF fallback): `node scripts/committee-eval/fetch-fulltext.mjs`
4. **Build worksheet:** `node scripts/committee-eval/build-gold.mjs`
   → hand-review `data/committee-eval/gold-worksheet.csv` (fill `keep`, `true_role`, `is_negative`;
   add member rows for certificate-absent docs using the `ack_slice` column), save back to
   `data/committee-eval/gold-worksheet.json`.
5. **Finalize gold:** `node scripts/committee-eval/build-gold.mjs --finalize`
6. **Score baseline:** `node scripts/committee-eval/score-baseline.mjs`
7. **Report:** `node scripts/committee-eval/report.mjs`

## Reading the report
Lead with the **FAILURE POPULATION (nocert)** table. The **cert** table is harness validation only
(parseCommittee scored against parseCommittee-derived gold) — never average the two. Record the
nocert recall as the bar Phase 2 (GLiNER shadow) must beat.
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS, including the six new `committeeEval*` test files, with no changes to existing results.

- [ ] **Step 3: Commit**

```bash
git add scripts/committee-eval/README.md
git commit -m "docs(committee-eval): pipeline README + suite green"
```

- [ ] **Step 4: Real prod dry run (creds session — human-gated)**

In a creds-connected session, run the pipeline at tiny scale end-to-end:
```bash
node scripts/committee-eval/sample-corpus.mjs --discover
node scripts/committee-eval/sample-corpus.mjs --degrees "<confirmed strings>" --target-core 3 --per-reference 2
node scripts/committee-eval/fetch-fulltext.mjs
node scripts/committee-eval/build-gold.mjs
# hand-label the ~5 docs, save gold-worksheet.json
node scripts/committee-eval/build-gold.mjs --finalize
node scripts/committee-eval/score-baseline.mjs
node scripts/committee-eval/report.mjs
```
Expected: per-stratum counts add up; `report.json` shows nocert vs cert cells. Commit the resulting
`manifest.json` + `gold.json` once the human is satisfied they are representative.

---

## Phase 2 (DEFERRED — do not build until Phase 1 baseline numbers are reviewed)

Specified in the design doc §5. Reuses `manifest.json`, `gold.json`, the cached text, and
`lib/match.mjs` unchanged. Two deliverables:
- `gliner-propose.py` — pinned `transformers==4.52.4` + `protobuf` + `sentencepiece`, model
  `fastino/gliner2.5-base-v1` on CPU; emits candidate spans (char offsets + role + confidence).
  **Proposals only.**
- `score-shadow.mjs` — scores GLiNER-only and the deterministic-cue+GLiNER hybrid (exact-evidence
  validation: keep only model spans inside a deterministic role-cue window; role from the cue) via
  the same `scoreDoc`; `report.mjs` gains a baseline-vs-shadow column read against the recorded bar.

**Do not start Phase 2 as part of this plan.** It is a separate execution cycle gated on the Phase 1
failure-cell numbers.

---

## Self-Review Notes

- **Spec coverage:** Stages 1–5 → Tasks 2–6; match lib → Task 1; gold worksheet/finalize + circularity
  handling → Task 4 + Task 6 (cert/nocert split); degraded-tag + PDF fallback → Task 3; verification
  (`--discover`, dry run, unit tests, `npm test`) → Task 7; Phase 2 → deferred section. Local-DB guard,
  no-`src`-mutation, committed-vs-cached data → Global Constraints.
- **One interface to verify against source at execution time:** `fetchPdfForDocument`'s return shape
  (Task 3, Step 6 executor note) — the plan does not invent its API.
- **Type consistency:** `scoreDoc` shape (Task 1) is consumed identically by `aggregate` (Task 5) and
  `buildReport` (Task 6); `{name, role}` member shape is uniform across worksheet, baseline, and gold.
```
