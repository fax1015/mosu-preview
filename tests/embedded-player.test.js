import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLAPSED_EMBEDDED_HEIGHT,
  DEFAULT_EMBEDDED_BOUNDS,
  EMBEDDED_RESUME_MAX_AGE_MS,
  MIN_EMBEDDED_HEIGHT,
  MIN_EMBEDDED_WIDTH,
  VIEWPORT_MARGIN,
  buildEmbeddedPageUrl,
  computeDraggedBounds,
  computeResizedBounds,
  isOsuWebsiteUrl,
  normalizeEmbeddedBounds,
  readEmbeddedParams,
  resolveResumeSnapshot,
  serializeResumeSnapshot,
} from '../src/core/embeddedPlayer.js';

test('isOsuWebsiteUrl accepts only https://osu.ppy.sh URLs', () => {
  assert.equal(isOsuWebsiteUrl('https://osu.ppy.sh/beatmapsets/5337582#osu/5337582'), true);
  assert.equal(isOsuWebsiteUrl('https://osu.ppy.sh/home'), true);
  assert.equal(isOsuWebsiteUrl('http://osu.ppy.sh/beatmaps/123'), false);
  assert.equal(isOsuWebsiteUrl('https://old.osu.ppy.sh/beatmaps/123'), false);
  assert.equal(isOsuWebsiteUrl('https://osu.ppy.sh.evil.com/beatmaps/123'), false);
  assert.equal(isOsuWebsiteUrl('chrome://extensions'), false);
  assert.equal(isOsuWebsiteUrl(''), false);
  assert.equal(isOsuWebsiteUrl(null), false);
});

test('embedded params round-trip cleanly through the iframe URL', () => {
  const url = buildEmbeddedPageUrl({
    beatmapId: '5337582',
    setId: '2400000',
    mode: 3,
    resumeTimeMs: 42_500,
    resumePaused: true,
    collapsed: true,
    followEnabled: false,
  });
  const params = readEmbeddedParams(url.slice(url.indexOf('?')));

  assert.equal(params.isEmbedded, true);
  assert.equal(params.beatmapId, '5337582');
  assert.equal(params.setId, '2400000');
  assert.equal(params.mode, 3);
  assert.equal(params.resumeTimeMs, 42_500);
  assert.equal(params.resumePaused, true);
  assert.equal(params.collapsed, true);
  assert.equal(params.followEnabled, false);
});

test('embedded params default followEnabled to true and require a valid beatmapId', () => {
  const url = buildEmbeddedPageUrl({ beatmapId: '123', resumeTimeMs: 0 });
  const params = readEmbeddedParams(url.slice(url.indexOf('?')));

  assert.equal(params.isEmbedded, true);
  assert.equal(params.resumeTimeMs, 0);
  assert.equal(params.resumePaused, false);
  assert.equal(params.collapsed, false);
  assert.equal(params.followEnabled, true);

  assert.equal(readEmbeddedParams('?embedded=1').isEmbedded, false);
  assert.equal(readEmbeddedParams('?embedded=1&beatmapId=bad').isEmbedded, false);
  assert.equal(buildEmbeddedPageUrl({ beatmapId: 'not-a-number' }), '');
});

test('normalizeEmbeddedBounds clamps dimensions and position inside the viewport', () => {
  const viewport = { width: 1280, height: 720 };
  assert.deepEqual(normalizeEmbeddedBounds({}, viewport), DEFAULT_EMBEDDED_BOUNDS);

  const tiny = normalizeEmbeddedBounds({ width: 50, height: 50, right: -40, bottom: 9999 }, viewport);
  assert.equal(tiny.width, MIN_EMBEDDED_WIDTH);
  assert.equal(tiny.height, MIN_EMBEDDED_HEIGHT);
  assert.equal(tiny.right, VIEWPORT_MARGIN);
  assert.equal(tiny.bottom, viewport.height - MIN_EMBEDDED_HEIGHT - VIEWPORT_MARGIN);

  // Collapsed mode clamps vertical bottom against COLLAPSED_EMBEDDED_HEIGHT.
  const collapsedTop = normalizeEmbeddedBounds({ width: 456, height: 432, bottom: 9999, collapsed: true }, viewport);
  assert.equal(collapsedTop.bottom, viewport.height - COLLAPSED_EMBEDDED_HEIGHT - VIEWPORT_MARGIN);
});

test('computeDraggedBounds moves smoothly and stays within viewport margins', () => {
  const viewport = { width: 1200, height: 800 };
  const start = { width: 450, height: 400, right: 20, bottom: 70, collapsed: false };

  // Dragging left (-100) increases right; dragging up (-50) increases bottom.
  const moved = computeDraggedBounds(start, -100, -50, viewport);
  assert.equal(moved.right, 120);
  assert.equal(moved.bottom, 120);

  // Dragging far off-screen clamps cleanly to margins.
  const clampedRight = computeDraggedBounds(start, 500, 500, viewport);
  assert.equal(clampedRight.right, VIEWPORT_MARGIN);
  assert.equal(clampedRight.bottom, VIEWPORT_MARGIN);

  const clampedLeft = computeDraggedBounds(start, -5000, -5000, viewport);
  assert.equal(clampedLeft.right, viewport.width - start.width - VIEWPORT_MARGIN);
  assert.equal(clampedLeft.bottom, viewport.height - start.height - VIEWPORT_MARGIN);
});

test('computeResizedBounds handles all 8 edges and keeps opposite edges pinned', () => {
  const viewport = { width: 1400, height: 900 };
  const start = { width: 450, height: 400, right: 100, bottom: 100, collapsed: false };

  // West edge grows width left without shifting right.
  const west = computeResizedBounds(start, 'w', -60, 0, viewport);
  assert.equal(west.width, 510);
  assert.equal(west.right, 100);

  // East edge grows width right and decreases right equally so left edge stays fixed.
  const east = computeResizedBounds(start, 'e', 40, 0, viewport);
  assert.equal(east.width, 490);
  assert.equal(east.right, 60);
  assert.equal(viewport.width - east.right - east.width, viewport.width - start.right - start.width);

  // North edge grows height up without shifting bottom.
  const north = computeResizedBounds(start, 'n', 0, -50, viewport);
  assert.equal(north.height, 450);
  assert.equal(north.bottom, 100);

  // South edge grows height down and decreases bottom equally so top edge stays fixed.
  const south = computeResizedBounds(start, 's', 0, 50, viewport);
  assert.equal(south.height, 450);
  assert.equal(south.bottom, 50);
  assert.equal(viewport.height - south.bottom - south.height, viewport.height - start.bottom - start.height);

  // Corner combines both axes independently.
  const nw = computeResizedBounds(start, 'nw', -30, -40, viewport);
  assert.equal(nw.width, 480);
  assert.equal(nw.height, 440);
  assert.equal(nw.right, 100);
  assert.equal(nw.bottom, 100);

  // Collapsed mode ignores vertical resize while still allowing horizontal resize.
  const collapsed = computeResizedBounds({ ...start, collapsed: true }, 'nw', -40, -100, viewport);
  assert.equal(collapsed.width, 490);
  assert.equal(collapsed.height, 400);
});

test('reload-resume snapshots advance playhead when playing and reject stale entries', () => {
  const now = 1_700_000_000_000;
  const playingSnap = serializeResumeSnapshot({
    beatmapId: '5337582',
    setId: '2400000',
    mode: 0,
    currentTimeMs: 30_000,
    isPlaying: true,
    playbackSpeed: 1.5,
    followEnabled: true,
    collapsed: false,
  }, now);

  // 2 seconds later at 1.5x speed -> +3000ms projected playhead.
  const resumedPlaying = resolveResumeSnapshot(playingSnap, now + 2000);
  assert.equal(resumedPlaying.beatmapId, '5337582');
  assert.equal(resumedPlaying.resumeTimeMs, 33_000);
  assert.equal(resumedPlaying.resumePaused, false);

  // Paused snapshots do not advance time across the reload.
  const pausedSnap = serializeResumeSnapshot({
    beatmapId: '5337582',
    currentTimeMs: 30_000,
    isPlaying: false,
    followEnabled: false,
    collapsed: true,
  }, now);
  const resumedPaused = resolveResumeSnapshot(pausedSnap, now + 5000);
  assert.equal(resumedPaused.resumeTimeMs, 30_000);
  assert.equal(resumedPaused.resumePaused, true);
  assert.equal(resumedPaused.followEnabled, false);
  assert.equal(resumedPaused.collapsed, true);

  // Expired or far-future snapshots are ignored.
  assert.equal(resolveResumeSnapshot(playingSnap, now + EMBEDDED_RESUME_MAX_AGE_MS + 1), null);
  assert.equal(resolveResumeSnapshot(playingSnap, now - 10_000), null);
  assert.equal(resolveResumeSnapshot({ version: 2, beatmapId: '1', savedAt: now }, now), null);
  assert.equal(serializeResumeSnapshot({ beatmapId: 'invalid' }, now), null);
});
