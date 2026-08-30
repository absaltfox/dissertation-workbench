// Milliseconds until the next local occurrence of `hourLocal`:00.
export function msUntilNextDailyHour(hourLocal, from = new Date()) {
  const now = new Date(from);
  const next = new Date(now);
  next.setHours(hourLocal, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// Self-rescheduling daily timer. The stopped flag is deliberately separate from
// the timer handle: clearing a timer that has already fired does nothing, and an
// in-flight callback must not schedule another day after graceful shutdown.
export function scheduleDaily(hourLocal, fn, {
  label = 'daily job',
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  nextDelay = msUntilNextDailyHour,
  onError = () => {},
} = {}) {
  let timer = null;
  let stopped = false;
  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimer(() => {
      Promise.resolve()
        .then(fn)
        .catch((error) => onError(error, label))
        .finally(scheduleNext);
    }, nextDelay(hourLocal));
  };
  scheduleNext();
  return () => {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  };
}
