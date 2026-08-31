function childHasExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(exited);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    timer.unref();
    child.once('close', onClose);
  });
}

export async function terminateChild(child, {
  graceMs = 30_000,
  forceWaitMs = Math.min(Math.max(1, graceMs), 5_000),
} = {}) {
  if (!child || childHasExited(child)) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, graceMs)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, forceWaitMs);
}

// The terminal CAS deliberately happens before secondary publication/cleanup.
// A rollout or log failure is reported independently and cannot leave the job
// looking active after its worker has already failed.
export async function publishTerminalFailure({
  finish,
  failRollout,
  appendLog,
  onCleanupError = async () => {},
}, { error, status = 'failed' }) {
  const message = error?.message || String(error);
  const published = await finish({
    status,
    runnerState: status,
    error: message,
    finishedAt: new Date().toISOString(),
  });
  const cleanupErrors = [];
  if (!published) return { published, cleanupErrors };
  for (const [context, action] of [
    ['Failed to update enrichment rollout after worker failure', () => failRollout(error)],
    ['Failed to append terminal worker log', () => appendLog(`Worker ${status}: ${message}\n`)],
  ]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await action();
    } catch (cleanupError) {
      cleanupErrors.push({ context, error: cleanupError });
      try {
        // eslint-disable-next-line no-await-in-loop
        await onCleanupError(context, cleanupError);
      } catch {
        // Reporting a cleanup failure is itself best effort.
      }
    }
  }
  return { published, cleanupErrors };
}
