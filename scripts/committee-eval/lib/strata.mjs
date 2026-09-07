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

export function selectSample(entries, { degrees, targetCore, perReference }) {
  const targetSet = new Set(degrees);
  const target = entries.filter((e) => targetSet.has(e.degree));
  const core = target.filter((e) => !e.certificateSignalGuess);
  const reference = target.filter((e) => e.certificateSignalGuess);

  // core = target-degree docs with no certificate-page signal (the failure population).
  // Ordered by a stable docId hash so the capped sample is reproducible but not
  // biased by ingestion/id order. reference = certificate-signal docs, capped small.
  const corePicked = take([...core].sort(byOrderKey), targetCore).map((e) => ({ ...e, stratum: `core:${e.era}` }));
  const refPicked = take([...reference].sort(byOrderKey), perReference).map((e) => ({ ...e, stratum: `reference:${e.era}` }));

  const manifest = [...corePicked, ...refPicked];
  return { manifest, counts: { core: corePicked.length, reference: refPicked.length, total: manifest.length } };
}
