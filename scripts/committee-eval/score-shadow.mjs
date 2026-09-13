// GLiNER shadow-eval scorer.
//
// Compares three predictions per gold doc against the committed gold:
//   1. deterministic-only  = extractBaseline (the baseline to beat)
//   2. GLiNER-only         = raw GLiNER span texts as names (upper-bound FP check)
//   3. hybrid              = deterministic ∪ (GLiNER spans validated by a
//                            deterministic role-cue evidence window; role from
//                            the cue, NEVER from GLiNER)
//
// Core principle (design §1/§3): GLiNER proposes person spans (recall); the
// deterministic cue owns the role and validates each span by an evidence window
// (precision). GLiNER's own labels are ignored.
//
// Usage (after gliner-propose.py has written results-gliner-raw.json):
//   node scripts/committee-eval/score-shadow.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseCommittee, parseAcknowledgementsDetailed } from '../../src/pdf.js';
import { scoreDoc, namesMatch } from './lib/match.mjs';
import { extractBaseline, aggregate } from './lib/baseline.mjs';
import { supervisorNameKey } from '../../src/supervisors.js';

const EVAL_DIR = 'data/committee-eval';
const TEXT_DIR = path.join(EVAL_DIR, 'fulltext');
const RAW_PATH = path.join(EVAL_DIR, 'results-gliner-raw.json');

const manifest = JSON.parse(readFileSync('test/fixtures/committee-eval/manifest.json', 'utf8'));
const gold = JSON.parse(readFileSync('test/fixtures/committee-eval/gold.json', 'utf8'));
const coverage = existsSync(path.join(EVAL_DIR, 'coverage.json'))
  ? JSON.parse(readFileSync(path.join(EVAL_DIR, 'coverage.json'), 'utf8')) : [];
if (!existsSync(RAW_PATH)) {
  console.error(`Missing ${RAW_PATH} — run scripts/committee-eval/gliner-propose.py first.`);
  process.exit(1);
}
const rawGliner = JSON.parse(readFileSync(RAW_PATH, 'utf8'));

const manifestByDoc = new Map(manifest.map((m) => [m.docId, m]));
const coverageByDoc = new Map(coverage.map((c) => [c.docId, c]));
const spansByDoc = new Map(rawGliner.map((r) => [r.docId, r.spans || []]));

// --- Deterministic role-cue vocabulary (mirrors what the parser keys on) ---
// Each cue occurrence defines an EVIDENCE WINDOW; a GLiNER span is kept only if it
// overlaps a window, and takes that cue's ROLE. Windows are ±~50-70 chars for
// supervisor/advisor cues (name is adjacent), forward-biased for committee lists,
// backward-biased for "who supervised" (name precedes the cue).
const SUP = 'Supervisor';
const COSUP = 'Co-Supervisor';
const COMMITTEE = 'Supervisory Committee Member';

// role rank for resolving a span that overlaps multiple cue windows
const ROLE_RANK = { [SUP]: 3, [COSUP]: 2, [COMMITTEE]: 1 };

// First-person supervisory cues, shared by both hybrid configs.
const SUP_CUES = [
  // "my [thesis|doctoral|dissertation|research] [co-]supervisor/advisor/adviser[s]"
  {
    re: /my\s+(?:(?:thesis|doctoral|dissertation|research)\s+)?(co-?\s*)?(supervisors?|advisors?|advisers?)/gi,
    role: (m) => {
      const co = !!m[1];
      const plural = /s$/i.test(m[2]);
      return co || plural ? COSUP : SUP;
    },
    back: 50, fwd: 50,
  },
  // "advisor," / "advisors," (bare, comma-anchored)
  {
    re: /\badvisors?,/gi,
    role: (m) => (/advisors,/i.test(m[0]) ? COSUP : SUP),
    back: 50, fwd: 50,
  },
  // "... who supervised" — the name PRECEDES the cue
  {
    re: /who\s+supervised/gi,
    role: () => SUP,
    back: 60, fwd: 8,
  },
  // certificate anchor (cert docs; validation-only stratum)
  {
    re: /the following individuals certify/gi,
    role: () => COMMITTEE,
    back: 0, fwd: 280,
  },
];

// NAIVE hybrid: supervisory cues + a BARE "committee" cue (fires on any committee
// mention in prose — Senate/House committees, book-editor footnotes, etc.).
const CUE_DEFS_NAIVE = [
  ...SUP_CUES,
  {
    re: /committee/gi,
    role: () => COMMITTEE,
    back: 5, fwd: 120,
  },
];

// TIGHTENED hybrid: supervisory cues + a NARROW committee cue restricted to
// thesis-supervisory phrasing. Bare "committee" is dropped entirely.
const CUE_DEFS_TIGHT = [
  ...SUP_CUES,
  {
    re: /supervisory\s+committee|committee\s+members?|member\s+of\s+my\s+(?:thesis|supervisory)\s+committee|my\s+committee[:,]/gi,
    role: () => COMMITTEE,
    back: 5, fwd: 120,
  },
];

// Clamp a window to the nearest sentence boundaries (spec: "±~50 chars, or to the
// next sentence boundary"). Only newline / ! ? ; terminate a sentence here — '.'
// is excluded because "Dr." would prematurely cut a titled name.
const SENT_END = /[\n!?;]/;
function clampToSentence(text, cueStart, cueEnd, ws, we) {
  let s = ws;
  for (let i = cueStart - 1; i >= ws; i--) {
    if (SENT_END.test(text[i])) { s = i + 1; break; }
  }
  let e = we;
  for (let i = cueEnd; i < we; i++) {
    if (SENT_END.test(text[i])) { e = i; break; }
  }
  return [s, e];
}

function buildCueWindows(text, cueDefs) {
  const windows = [];
  for (const def of cueDefs) {
    def.re.lastIndex = 0;
    let m;
    while ((m = def.re.exec(text)) !== null) {
      const cueStart = m.index;
      const cueEnd = m.index + m[0].length;
      const rawWs = Math.max(0, cueStart - def.back);
      const rawWe = Math.min(text.length, cueEnd + def.fwd);
      const [ws, we] = clampToSentence(text, cueStart, cueEnd, rawWs, rawWe);
      windows.push({ ws, we, role: def.role(m) });
      if (m.index === def.re.lastIndex) def.re.lastIndex += 1; // guard zero-width
    }
  }
  return windows;
}

// Keep a GLiNER span iff it overlaps a cue window; assign the highest-ranked
// role among all windows it overlaps.
function validateSpans(spans, windows) {
  const kept = [];
  for (const s of spans) {
    let best = null;
    for (const w of windows) {
      const overlaps = s.start < w.we && s.end > w.ws;
      if (!overlaps) continue;
      if (!best || ROLE_RANK[w.role] > ROLE_RANK[best]) best = w.role;
    }
    if (best) kept.push({ name: s.text, role: best });
  }
  return kept;
}

// Dedupe a member list by normalized name key (namesMatch), keeping first seen.
function dedupeByName(members) {
  const out = [];
  for (const m of members) {
    if (!supervisorNameKey(m.name)) {
      // unnormalizable name (noise) — keep as-is for FP accounting but it will
      // never match gold; dedupe such entries by raw lowercased text.
      if (out.some((o) => String(o.name).toLowerCase() === String(m.name).toLowerCase())) continue;
      out.push(m);
      continue;
    }
    if (out.some((o) => namesMatch(o.name, m.name))) continue;
    out.push(m);
  }
  return out;
}

const perDocDet = [];
const perDocGli = [];
const perDocHyb = [];
const perDocHybT = [];
const details = [];
let missingSpans = 0;

for (const g of gold) {
  const entry = manifestByDoc.get(g.docId);
  const textPath = path.join(TEXT_DIR, `${g.docId}.txt`);
  if (!entry || !existsSync(textPath)) continue;
  const fullText = readFileSync(textPath, 'utf8');
  const certificatePresent = /the following individuals certify/i.test(fullText);
  const degraded = coverageByDoc.get(g.docId)?.degraded ? 'degraded' : 'clean';
  const stratumKey = `${certificatePresent ? 'cert' : 'nocert'}:${entry.era}:${degraded}`;

  const spans = spansByDoc.get(g.docId);
  if (spans === undefined) missingSpans += 1;
  const glinerSpans = spans || [];

  // (1) deterministic-only
  const det = extractBaseline(fullText, { parseCommittee, parseAcknowledgementsDetailed });

  // (2) GLiNER-only: raw span texts as names (role irrelevant → name metrics only)
  const gliOnly = dedupeByName(glinerSpans.map((s) => ({ name: s.text, role: SUP })));

  // (3) hybrid-naive: deterministic ∪ cue-validated GLiNER spans (bare "committee")
  const windowsNaive = buildCueWindows(fullText, CUE_DEFS_NAIVE);
  const validatedNaive = validateSpans(glinerSpans, windowsNaive);
  // union: deterministic keeps what it found; add validated GLiNER names not
  // already present (dedupe det first so det roles win).
  const hybrid = dedupeByName([...det, ...validatedNaive]);

  // (4) hybrid-tightened: same, but with the NARROW committee cue (no bare "committee")
  const windowsTight = buildCueWindows(fullText, CUE_DEFS_TIGHT);
  const validatedTight = validateSpans(glinerSpans, windowsTight);
  const hybridT = dedupeByName([...det, ...validatedTight]);

  const sDet = scoreDoc(det, g);
  const sGli = scoreDoc(gliOnly, g);
  const sHyb = scoreDoc(hybrid, g);
  const sHybT = scoreDoc(hybridT, g);
  perDocDet.push({ stratumKey, score: sDet });
  perDocGli.push({ stratumKey, score: sGli });
  perDocHyb.push({ stratumKey, score: sHyb });
  perDocHybT.push({ stratumKey, score: sHybT });

  // which gold names each hybrid recovered that deterministic missed
  const detNames = det.map((m) => m.name);
  const hybNames = hybrid.map((m) => m.name);
  const hybTNames = hybridT.map((m) => m.name);
  const recoveredBy = (names) => (g.members || [])
    .map((gm) => gm.name)
    .filter((gn) => names.some((hn) => namesMatch(hn, gn)) && !detNames.some((dn) => namesMatch(dn, gn)));
  const newlyRecovered = recoveredBy(hybNames);
  const newlyRecoveredTight = recoveredBy(hybTNames);

  details.push({
    docId: g.docId, stratumKey,
    gold: (g.members || []).map((m) => m.name),
    det: detNames, hybrid: hybNames, hybridTightened: hybTNames, glinerOnly: gliOnly.map((m) => m.name),
    newlyRecovered, newlyRecoveredTight,
    score: { det: sDet, glinerOnly: sGli, hybrid: sHyb, hybridTightened: sHybT },
  });
}

const byStratum = {
  deterministic: aggregate(perDocDet),
  glinerOnly: aggregate(perDocGli),
  hybrid: aggregate(perDocHyb),
  hybridTightened: aggregate(perDocHybT),
};

writeFileSync(
  path.join(EVAL_DIR, 'results-shadow.json'),
  JSON.stringify({ byStratum, details }, null, 2) + '\n',
);

// --- Reporting ---
function rollup(perDoc, filterFn) {
  const g = { nameTP: 0, nameFP: 0, nameFN: 0, neg: 0, docs: 0 };
  for (const { stratumKey, score } of perDoc) {
    if (!filterFn(stratumKey)) continue;
    g.nameTP += score.nameTP; g.nameFP += score.nameFP; g.nameFN += score.nameFN;
    g.neg += score.negativeViolations; g.docs += 1;
  }
  const recall = g.nameTP + g.nameFN === 0 ? 1 : g.nameTP / (g.nameTP + g.nameFN);
  const precision = g.nameTP + g.nameFP === 0 ? 1 : g.nameTP / (g.nameTP + g.nameFP);
  return { ...g, recall, precision };
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const isNocert = (k) => k.startsWith('nocert:');
const isCert = (k) => k.startsWith('cert:');

const MODELS = [
  ['deterministic', perDocDet],
  ['GLiNER-only', perDocGli],
  ['hybrid-naive', perDocHyb],
  ['hybrid-tight', perDocHybT],
];

console.log('\n=== FAILURE POPULATION (nocert) — the headline ===');
console.log('model            recall   precision   nameTP/FP/FN   neg-viol   docs');
for (const [label, perDoc] of MODELS) {
  const r = rollup(perDoc, isNocert);
  console.log(
    `${label.padEnd(15)}  ${pct(r.recall).padStart(6)}   ${pct(r.precision).padStart(8)}   `
    + `${r.nameTP}/${r.nameFP}/${r.nameFN}`.padEnd(13) + `   ${String(r.neg).padStart(4)}      ${r.docs}`,
  );
}

console.log('\n--- nocert by stratum ---');
const nocertKeys = [...new Set(perDocDet.filter((d) => isNocert(d.stratumKey)).map((d) => d.stratumKey))].sort();
for (const key of nocertKeys) {
  console.log(`\n[${key}]`);
  for (const [label, perDoc] of MODELS) {
    const r = rollup(perDoc, (k) => k === key);
    console.log(`  ${label.padEnd(15)} recall ${pct(r.recall).padStart(6)}  prec ${pct(r.precision).padStart(6)}  TP/FP/FN ${r.nameTP}/${r.nameFP}/${r.nameFN}  neg ${r.neg}  docs ${r.docs}`);
  }
}

console.log('\n=== cert (validation-only) ===');
for (const [label, perDoc] of MODELS) {
  const r = rollup(perDoc, isCert);
  console.log(`  ${label.padEnd(15)} recall ${pct(r.recall).padStart(6)}  prec ${pct(r.precision).padStart(6)}  TP/FP/FN ${r.nameTP}/${r.nameFP}/${r.nameFN}  neg ${r.neg}  docs ${r.docs}`);
}

const newly = details.filter((d) => isNocert(d.stratumKey) && d.newlyRecovered.length);
console.log('\n=== nocert docs HYBRID-NAIVE newly recovered (vs deterministic) ===');
if (!newly.length) console.log('  (none)');
for (const d of newly) console.log(`  ${d.docId} [${d.stratumKey}] +${d.newlyRecovered.join(', ')}`);

const newlyT = details.filter((d) => isNocert(d.stratumKey) && d.newlyRecoveredTight.length);
console.log('\n=== nocert docs HYBRID-TIGHTENED newly recovered (vs deterministic) ===');
if (!newlyT.length) console.log('  (none)');
for (const d of newlyT) console.log(`  ${d.docId} [${d.stratumKey}] +${d.newlyRecoveredTight.join(', ')}`);

const goldNegTotal = gold.reduce((a, g) => a + (g.negatives?.length || 0), 0);
console.log(`\nNote: gold has ${goldNegTotal} negative-set names total; negative-violation gate is trivially 0 across all models when 0.`);
if (missingSpans) console.log(`WARN: ${missingSpans} scored docs had no GLiNER span entry.`);
console.log(`\nWrote ${path.join(EVAL_DIR, 'results-shadow.json')} (${details.length} docs).`);
