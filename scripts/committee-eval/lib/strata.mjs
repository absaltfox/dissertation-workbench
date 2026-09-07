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
