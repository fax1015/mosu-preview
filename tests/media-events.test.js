import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForAudioElementReady, waitForAudioElementSeek } from '../src/audio/mediaEvents.js';
import { registry } from '../src/core/cleanup.js';

class FakeMediaElement extends EventTarget {
  constructor({ readyState = 0, src = 'blob:audio', seeking = false, currentTime = 0 } = {}) {
    super();
    this.readyState = readyState;
    this.src = src;
    this.seeking = seeking;
    this.currentTime = currentTime;
  }

  fire(type) {
    this.dispatchEvent(new Event(type));
  }
}

test('an element that already has data is ready at once', async () => {
  assert.equal(await waitForAudioElementReady(new FakeMediaElement({ readyState: 4 })), true);
});

test('a freshly swapped source waits for its own event, whatever readyState says', async () => {
  const element = new FakeMediaElement({ readyState: 4 });
  let settled = false;
  const waiting = waitForAudioElementReady(element, { requireFreshEvent: true }).then((value) => {
    settled = true;
    return value;
  });

  await Promise.resolve();
  assert.equal(settled, false, 'the stale readyState belongs to the previous source');
  element.fire('canplay');
  assert.equal(await waiting, true);
});

test('an error or a timeout reports not ready, and leaves no timer behind', async () => {
  const timersBefore = registry.timers.size;

  const failing = new FakeMediaElement();
  const failed = waitForAudioElementReady(failing);
  failing.fire('error');
  assert.equal(await failed, false);

  assert.equal(await waitForAudioElementReady(new FakeMediaElement(), { timeoutMs: 10 }), false);
  assert.equal(registry.timers.size, timersBefore);
});

test('a seek only counts once the element is idle at the target', async () => {
  const element = new FakeMediaElement({ seeking: true, currentTime: 0 });
  const waiting = waitForAudioElementSeek(element, { expectedTimeSec: 30 });

  // A `seeked` for some earlier position must not satisfy this wait.
  element.seeking = false;
  element.currentTime = 12;
  element.fire('seeked');
  element.seeking = true;

  element.seeking = false;
  element.currentTime = 30.05;
  element.fire('seeked');
  assert.equal(await waiting, true);
});

test('a moving target is read again on every seeked event', async () => {
  const element = new FakeMediaElement({ seeking: true });
  let target = 10;
  const waiting = waitForAudioElementSeek(element, { expectedTimeSec: () => target });

  target = 20;
  element.seeking = false;
  element.currentTime = 20;
  element.fire('seeked');
  assert.equal(await waiting, true);
});

test('a seek that never lands times out as a failure', async () => {
  const element = new FakeMediaElement({ seeking: true });
  assert.equal(await waitForAudioElementSeek(element, { expectedTimeSec: 5, timeoutMs: 10 }), false);
});

test('an element with no source has nothing to wait for', async () => {
  assert.equal(await waitForAudioElementSeek(new FakeMediaElement({ src: '', seeking: true })), true);
});
