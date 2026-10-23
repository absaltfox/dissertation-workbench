import test from 'node:test';
import assert from 'node:assert/strict';
import { msUntilNextDailyHour, scheduleDaily } from '../src/dailyScheduler.js';

test('daily scheduler boundary math counts milliseconds to the next local hour', () => {
  const beforeHour = new Date(2026, 0, 1, 1, 0, 0);
  assert.equal(msUntilNextDailyHour(3, beforeHour), 2 * 60 * 60 * 1000);
  const afterHour = new Date(2026, 0, 1, 4, 0, 0);
  assert.equal(msUntilNextDailyHour(3, afterHour), 23 * 60 * 60 * 1000);
  const atHour = new Date(2026, 0, 1, 3, 0, 0);
  assert.equal(msUntilNextDailyHour(3, atHour), 24 * 60 * 60 * 1000);
});

test('stopping while a callback is running prevents rescheduling', async () => {
  const scheduled = [];
  let release;
  const callbackDone = new Promise((resolve) => { release = resolve; });
  const stop = scheduleDaily(3, () => callbackDone, {
    setTimer: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    clearTimer: () => {},
    nextDelay: () => 0,
  });

  assert.equal(scheduled.length, 1);
  scheduled[0]();
  stop();
  release();
  await callbackDone;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
});
