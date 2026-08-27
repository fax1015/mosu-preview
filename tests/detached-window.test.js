import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DETACHED_BOUNDS,
  MIN_DETACHED_HEIGHT,
  MIN_DETACHED_WIDTH,
  buildBeatmapSourceUrl,
  buildDetachedPageUrl,
  hasDetachedPosition,
  isBoundsRejection,
  normalizeDetachedBounds,
  normalizeResumeTimeMs,
  readDetachedParams,
  withoutDetachedPosition,
} from '../src/core/detachedWindow.js';
import { extractBeatmapInfoFromUrl } from '../src/core/beatmapUrl.js';

test('detached params round-trip through the page url', () => {
  const pageUrl = buildDetachedPageUrl({ beatmapId: '123', setId: '456', mode: 3 });
  const params = readDetachedParams(pageUrl.slice(pageUrl.indexOf('?')));

  assert.equal(params.isDetached, true);
  assert.equal(params.beatmapId, '123');
  assert.equal(params.setId, '456');
  assert.equal(params.mode, 3);
});

test('the rebuilt source url parses back to the same beatmap info', () => {
  // The detached window relies on this: it reconstructs a beatmap URL from ids
  // and feeds it to the same validator the active-tab path uses.
  for (const context of [
    { beatmapId: '123', setId: '456', mode: 0 },
    { beatmapId: '123', setId: '456', mode: 2 },
    { beatmapId: '123', setId: '456', mode: null },
    { beatmapId: '123', setId: '', mode: 1 },
    { beatmapId: '123', setId: '', mode: null },
  ]) {
    const info = extractBeatmapInfoFromUrl(buildBeatmapSourceUrl(context));
    assert.equal(info.valid, true, `expected a valid url for ${JSON.stringify(context)}`);
    assert.equal(info.beatmapId, context.beatmapId);
    assert.equal(info.setId, context.setId || null);
    assert.equal(info.mode, context.mode);
  }
});

test('the detached flag alone is not enough without a beatmap id', () => {
  assert.equal(readDetachedParams('?detached=1').isDetached, false);
  assert.equal(readDetachedParams('?detached=1&beatmapId=abc').isDetached, false);
  assert.equal(readDetachedParams('?beatmapId=123').isDetached, false);
});

test('non-numeric ids are dropped rather than forwarded', () => {
  const params = readDetachedParams('?detached=1&beatmapId=123&setId=../evil');
  assert.equal(params.setId, '');
  assert.equal(buildDetachedPageUrl({ beatmapId: 'not-a-number' }), '');
  assert.equal(buildBeatmapSourceUrl({ beatmapId: 'not-a-number' }), '');
});

test('stored bounds are clamped into a reachable range', () => {
  assert.deepEqual(normalizeDetachedBounds({}), DEFAULT_DETACHED_BOUNDS);

  const tiny = normalizeDetachedBounds({ width: 10, height: 10 });
  assert.equal(tiny.width, MIN_DETACHED_WIDTH);
  assert.equal(tiny.height, MIN_DETACHED_HEIGHT);

  // left/top are a pair: a half-specified position is ignored entirely.
  assert.equal(Object.hasOwn(normalizeDetachedBounds({ left: 40 }), 'left'), false);
  assert.deepEqual(
    normalizeDetachedBounds({ width: 700, height: 800, left: 40.6, top: 12.2 }),
    { width: 700, height: 800, left: 41, top: 12 },
  );
});

test('the playhead is carried across the detach and read back', () => {
  const pageUrl = buildDetachedPageUrl({ beatmapId: '123', setId: '456', mode: 0, resumeTimeMs: 91_432 });
  const params = readDetachedParams(pageUrl.slice(pageUrl.indexOf('?')));

  assert.equal(params.resumeTimeMs, 91_432);
  assert.equal(params.resumePaused, false);
});

test('a paused preview stays paused across the detach', () => {
  const pageUrl = buildDetachedPageUrl({ beatmapId: '123', resumeTimeMs: 5000, resumePaused: true });
  assert.equal(readDetachedParams(pageUrl.slice(pageUrl.indexOf('?'))).resumePaused, true);
});

test('a resume point of zero is carried, not treated as absent', () => {
  // Detaching from the very start of a map must not be confused with "no
  // timestamp given", which would send the window to the preview point instead.
  const pageUrl = buildDetachedPageUrl({ beatmapId: '123', resumeTimeMs: 0 });
  assert.match(pageUrl, /(^|&)t=0(&|$)/);
  assert.equal(readDetachedParams(pageUrl.slice(pageUrl.indexOf('?'))).resumeTimeMs, 0);
});

test('no resume point means the map opens at its own preview point', () => {
  const pageUrl = buildDetachedPageUrl({ beatmapId: '123' });
  assert.equal(pageUrl.includes('t='), false);
  assert.equal(readDetachedParams(pageUrl.slice(pageUrl.indexOf('?'))).resumeTimeMs, -1);
});

test('junk and out-of-range timestamps are rejected', () => {
  for (const value of ['abc', '-1', 'NaN', 'Infinity', String(25 * 60 * 60 * 1000)]) {
    assert.equal(normalizeResumeTimeMs(value), -1, `expected ${value} to be rejected`);
  }
  assert.equal(readDetachedParams('?detached=1&beatmapId=123&t=abc').resumeTimeMs, -1);
  assert.equal(normalizeResumeTimeMs('1234.6'), 1235);
});

test('the paused flag is not emitted without a timestamp to pair it with', () => {
  const pageUrl = buildDetachedPageUrl({ beatmapId: '123', resumePaused: true });
  assert.equal(pageUrl.includes('paused'), false);
});

test('the position the browser refuses is recognised, whatever else fails', () => {
  // Chrome's wording, which is all the extension gets back.
  assert.equal(
    isBoundsRejection(new Error('Invalid value for bounds. Bounds must be at least '
      + '50% within visible screen space.')),
    true,
  );
  assert.equal(isBoundsRejection({ message: 'Invalid bounds' }), true);
  // Anything else has to keep propagating rather than being retried blindly.
  assert.equal(isBoundsRejection(new Error('Windows API is unavailable.')), false);
  assert.equal(isBoundsRejection(new Error('No tab')), false);
  assert.equal(isBoundsRejection(undefined), false);
});

test('falling back keeps the size and drops only the position', () => {
  const stored = {
    width: 640, height: 720, left: 3200, top: -1800,
  };
  assert.equal(hasDetachedPosition(stored), true);
  assert.deepEqual(withoutDetachedPosition(stored), { width: 640, height: 720 });

  // Size-only geometry is already the fallback shape, so retrying is pointless.
  const sizeOnly = { width: 640, height: 720 };
  assert.equal(hasDetachedPosition(sizeOnly), false);
  assert.deepEqual(withoutDetachedPosition(sizeOnly), sizeOnly);
});

test('a position on an unplugged monitor survives normalisation, which is why the retry exists', () => {
  // The normaliser clamps to +/-4096, which is not a screen. A remembered
  // position from a monitor that is no longer attached passes straight through
  // and is only caught when the browser refuses it.
  const farRight = normalizeDetachedBounds({
    width: 640, height: 720, left: 3840, top: 0,
  });
  assert.equal(farRight.left, 3840, 'normalisation cannot know this is off-screen');
  assert.equal(hasDetachedPosition(farRight), true);
});
