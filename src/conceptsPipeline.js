import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// This module is the persistence/status layer for the PatternRank concept
// dictionary that scripts/build-concepts.py (the Python worker, run as an admin
// job) produces: getConceptPipelineStatus is read by the admin dashboard and job
// routes, and persistConceptArtifact is the receiving side of the PUT the worker
// posts to (see src/routes/internalWorkerRoutes.js, which build-concepts.py's
// upload_concept_artifact() calls). It deliberately has no clustering logic of its
// own -- an earlier JS clustering pipeline (rebuildConceptDictionary,
// scheduleDailyConceptRebuild) lived here and diverged from the Python worker's
// algorithm (an O(P^2) all-pairs similarity threshold with no fan-in cap, versus
// the worker's blocking rules R1/R2/R3 with an enforced extension fan-in cap --
// see stem_for_similarity's docstring in scripts/build-concepts.py). It had zero
// production callers (only its own scheduler and the manual `npm run
// rebuild-concepts` CLI script invoked it) and was removed for #34 rather than
// kept in sync with a clustering algorithm it no longer matched.

const CONCEPTS_DIR = path.join(DATA_DIR, 'concepts');
const LATEST_PATH = path.join(CONCEPTS_DIR, 'latest.json');
const STATUS_PATH = path.join(CONCEPTS_DIR, 'status.json');

async function ensureConceptPaths() {
  await fs.mkdir(CONCEPTS_DIR, { recursive: true });
}

async function writeJsonAtomically(targetPath, value) {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2));
    await fs.rename(tempPath, targetPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function writeStatus(status) {
  await ensureConceptPaths();
  await writeJsonAtomically(STATUS_PATH, status);
}

export async function getConceptPipelineStatus() {
  try {
    const raw = await fs.readFile(STATUS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {
      status: 'idle',
      lastRunAt: null,
      lastSuccessAt: null,
      trigger: null,
      message: 'No concept rebuild has run yet.'
    };
  }
}

export async function persistConceptArtifact(artifact, { trigger = 'worker', message = null } = {}) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('Concept artifact must be an object.');
  }
  const generatedAt = artifact.generatedAt || new Date().toISOString();
  artifact.generatedAt = generatedAt;
  await ensureConceptPaths();
  await writeJsonAtomically(LATEST_PATH, artifact);
  await writeStatus({
    status: 'idle',
    trigger,
    lastRunAt: generatedAt,
    lastSuccessAt: generatedAt,
    message: message || `Concept rebuild completed (${artifact.stats?.aliases ?? 0} aliases).`,
    stats: artifact.stats || null
  });
  return { ok: true, artifact };
}
