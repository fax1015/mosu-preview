import test from 'node:test';
import assert from 'node:assert/strict';
import { CleanupRegistry } from '../src/core/cleanup.js';

test('CleanupRegistry clears timeouts, intervals, and aborts all controllers even if one listener throws', () => {
  const reg = new CleanupRegistry();
  let firedTimeout = false;
  let firedInterval = false;
  const t = reg.addTimeout(setTimeout(() => { firedTimeout = true; }, 50));
  const i = reg.addInterval(setInterval(() => { firedInterval = true; }, 50));
  assert.equal(reg.timers.has(t), true);
  assert.equal(reg.intervals.has(i), true);

  let c1Attempted = false;
  reg.addAbortController({
    abort() {
      c1Attempted = true;
      throw new Error('controller boom');
    },
  });
  const c2 = reg.createAbortController();
  let c2Aborted = false;
  c2.signal.addEventListener('abort', () => {
    c2Aborted = true;
  });

  assert.doesNotThrow(() => reg.cleanup());
  assert.equal(c1Attempted, true);
  assert.equal(c2.signal.aborted, true);
  assert.equal(c2Aborted, true);
  assert.equal(reg.timers.size, 0);
  assert.equal(reg.intervals.size, 0);
  assert.equal(reg.controllers.size, 0);
  assert.equal(firedTimeout, false);
  assert.equal(firedInterval, false);
});

test('clearTimeout and clearInterval return null and remove ids from sets', () => {
  const reg = new CleanupRegistry();
  const t = reg.addTimeout(setTimeout(() => {}, 1000));
  assert.equal(reg.clearTimeout(t), null);
  assert.equal(reg.timers.size, 0);
  assert.equal(reg.clearTimeout(null), null);
});
