import {
  appendAdminJobLog,
  finishAdminJob,
  recomputeStoredDocumentThemes,
  updateAdminJobProgress,
} from '../db.js';

function buildThemeProgress(event = {}, status = 'running') {
  const counts = {
    processed: event.processed || 0,
    total: event.total || 0,
    updated: event.updated || 0,
    failed: event.failed || 0,
  };
  return {
    phase: status === 'completed' ? 'complete' : 'recompute_themes',
    currentTask: status === 'completed'
      ? 'Stored theme recompute complete'
      : `Recomputing stored themes (${counts.processed} of ${counts.total})`,
    tasks: [
      {
        key: 'recompute_themes',
        label: 'Recomputing stored themes',
        status,
        detail: `${counts.processed} of ${counts.total} documents processed`,
        counts,
        updatedAt: new Date().toISOString(),
      },
    ],
    counts,
  };
}

export async function runThemeRecomputeAdminJob(job) {
  await appendAdminJobLog(job.id, 'Starting stored theme recompute.\n');
  await updateAdminJobProgress(job.id, {
    phase: 'load_documents',
    currentTask: 'Loading stored dissertation metadata',
    tasks: [
      {
        key: 'load_documents',
        label: 'Loading documents',
        status: 'running',
        updatedAt: new Date().toISOString(),
      },
    ],
  });

  const result = await recomputeStoredDocumentThemes({
    onProgress: async (event) => {
      await updateAdminJobProgress(job.id, buildThemeProgress(event));
    },
  });

  const finalProgress = buildThemeProgress(result, 'completed');
  await updateAdminJobProgress(job.id, finalProgress);
  await finishAdminJob(job.id, {
    status: 'completed',
    runnerState: 'completed',
    result: {
      ok: true,
      ...result,
    },
    error: null,
    finishedAt: new Date().toISOString(),
  });
  await appendAdminJobLog(
    job.id,
    `Stored theme recompute finished: ${result.updated || 0} updated, ${result.failed || 0} failed.\n`,
  );
  return { ok: true, ...result };
}
