// Waiting on a media element to reach a state, with a timeout so a load or seek
// that never reports back cannot hang whoever is waiting.

import { registry } from '../core/cleanup.js';

// HTMLMediaElement.HAVE_CURRENT_DATA, spelled out so this runs outside a browser.
const HAVE_CURRENT_DATA = 2;
const AUDIO_SEEK_SETTLE_TOLERANCE_SEC = 0.15;
// Tighter tolerance for settling synchronously before any `seeked` event fires,
// so a tiny (<= 0.15s) seek whose `seeking` flag has not flipped yet does not
// immediately adopt the pre-seek position.
const AUDIO_SEEK_IMMEDIATE_TOLERANCE_SEC = 0.005;

/**
 * Resolves true once the element has data to play, false on an error or a
 * timeout. `requireFreshEvent` is for a source that was just swapped: the
 * element can still report the previous source's readyState for a tick, so the
 * caller has to wait for an actual event rather than trust it.
 */
const waitForAudioElementReady = (
  audioElement,
  { timeoutMs = 10000, requireFreshEvent = false, signal = null } = {},
) => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve(false);
    return;
  }

  if (!requireFreshEvent && audioElement.readyState >= HAVE_CURRENT_DATA) {
    resolve(true);
    return;
  }

  let timer = null;
  let settled = false;
  const cleanup = () => {
    registry.clearTimeout(timer);
    audioElement.removeEventListener('canplay', onReady);
    audioElement.removeEventListener('loadeddata', onReady);
    audioElement.removeEventListener('error', onError);
    signal?.removeEventListener('abort', onAbort);
  };
  const settle = (result) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    resolve(result);
  };
  const onReady = () => settle(true);
  const onError = () => settle(false);
  const onAbort = () => settle(false);

  timer = registry.addTimeout(setTimeout(() => settle(false), timeoutMs));
  audioElement.addEventListener('canplay', onReady);
  audioElement.addEventListener('loadeddata', onReady);
  audioElement.addEventListener('error', onError);
  signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * Resolves true once the element has finished seeking -- to `expectedTimeSec`
 * when one is given, which may be a function so a drag can keep moving the
 * target while the wait is in flight -- and false on an error or a timeout.
 */
const waitForAudioElementSeek = (
  audioElement,
  { expectedTimeSec = null, timeoutMs = 2500, signal = null } = {},
) => (
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }

    const getExpectedTimeSec = () => {
      try {
        return typeof expectedTimeSec === 'function' ? expectedTimeSec() : expectedTimeSec;
      } catch {
        return Number.NaN;
      }
    };
    const hasSettledAtExpectedTime = (toleranceSec = AUDIO_SEEK_SETTLE_TOLERANCE_SEC) => {
      if (audioElement?.seeking !== false) {
        return false;
      }
      const expected = getExpectedTimeSec();
      return !Number.isFinite(expected)
        || Math.abs(Number(audioElement?.currentTime) - expected) <= toleranceSec;
    };

    // `currentTime = ...` can queue the media seek before the element flips its
    // `seeking` flag. Treating that brief gap as completion let a one-shot click
    // adopt the old audio position; a drag usually issued another seek in time to
    // hide the race. With a target, only settle immediately when already right
    // on it, and otherwise wait for `seeked` (using the full frame tolerance).
    if (!audioElement?.src || hasSettledAtExpectedTime(AUDIO_SEEK_IMMEDIATE_TOLERANCE_SEC)) {
      resolve(true);
      return;
    }

    let timer = null;
    let settled = false;
    const cleanup = () => {
      registry.clearTimeout(timer);
      audioElement.removeEventListener('seeked', onSeeked);
      audioElement.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const onSeeked = () => {
      if (hasSettledAtExpectedTime(AUDIO_SEEK_SETTLE_TOLERANCE_SEC)) {
        settle(true);
      }
    };
    const onError = () => settle(false);
    const onAbort = () => settle(false);

    timer = registry.addTimeout(setTimeout(() => settle(false), timeoutMs));
    audioElement.addEventListener('seeked', onSeeked);
    audioElement.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  })
);

export {
  AUDIO_SEEK_IMMEDIATE_TOLERANCE_SEC,
  AUDIO_SEEK_SETTLE_TOLERANCE_SEC,
  waitForAudioElementReady,
  waitForAudioElementSeek,
};
