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

// Deterministic, reproducible ordering key decorrelated from ingestion/doc_id order.
// FNV-1a over the docId string → stable across runs, no external deps, no randomness.
function orderKey(docId) {
  let h = 0x811c9dc5;
  const s = String(docId);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function take(list, n) {
  return list.slice(0, Math.max(0, n));
}

function byOrderKey(a, b) {
  return orderKey(a.docId) - orderKey(b.docId);
}

// A target is a {degree, program} pair. `program: null` matches the degree
// regardless of program (fine when the degree string is already unique, e.g.
// "Master of Arts in Planning - MA (Plan)"). A non-null program narrows to that
// program, which is required to isolate targets sharing a generic degree — e.g.
// History is degree "Master of Arts - MA" + program "History", shared with other
// MA programs, so it MUST be matched on program too.
function matchesTarget(entry, target) {
  if (entry.degree !== target.degree) return false;
  return target.program == null || entry.program === target.program;
}

// Sample up to `perEra` docs for EACH (target × era) cell, so both the pre-2018
// failure population and the 2018+ certificate-bearing regime are deliberately
// represented (the report's cert/nocert strata are only as populated as the
// sample). Ordering within a cell is a stable docId hash: reproducible, and
// decorrelated from ingestion/id order. A doc matching multiple targets is
// counted once (first target wins).
export function selectSample(entries, { targets, perEra, exclude }) {
  // `exclude` (a Set/array of docIds already sampled in a prior batch) makes a new
  // batch DISJOINT from earlier ones, so widening the gold never re-samples — and
  // therefore never asks a human to re-label — a doc already in an earlier batch.
  const excludeSet = exclude instanceof Set ? exclude : new Set(exclude || []);
  const seen = new Set();
  const manifest = [];
  const counts = { total: 0, byCell: {} };
  for (const target of targets) {
    const label = target.program ? `${target.degree} / ${target.program}` : target.degree;
    const matches = entries.filter((e) => matchesTarget(e, target) && !excludeSet.has(e.docId));
    for (const era of ['pre2018', '2018plus']) {
      const inEra = matches.filter((e) => e.era === era && !seen.has(e.docId));
      const picked = take([...inEra].sort(byOrderKey), perEra);
      for (const e of picked) {
        seen.add(e.docId);
        manifest.push({ ...e, stratum: era, matchedTarget: label });
        const cell = `${label} · ${era}`;
        counts.byCell[cell] = (counts.byCell[cell] || 0) + 1;
        counts.total += 1;
      }
    }
  }
  return { manifest, counts };
}
