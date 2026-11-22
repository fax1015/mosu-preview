import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLAPSED_EMBEDDED_HEIGHT,
  DEFAULT_EMBEDDED_BOUNDS,
  DEFAULT_EMBEDDED_CHROME_HEIGHT,
  EMBEDDED_ASPECT_RATIO,
  EMBEDDED_CHROME_WIDTH,
  EMBEDDED_RESUME_MAX_AGE_MS,
  MIN_EMBEDDED_HEIGHT,
  MIN_EMBEDDED_WIDTH,
  VIEWPORT_MARGIN,
  buildEmbeddedPageUrl,
  computeDraggedBounds,
  computeResizedBounds,
  embeddedHeightForWidth,
  embeddedWidthForHeight,
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

test('normalizeEmbeddedBounds clamps dimensions and snaps height to the 4:3 playfield', () => {
  const viewport = { width: 1280, height: 720 };
  assert.deepEqual(normalizeEmbeddedBounds({}, viewport), DEFAULT_EMBEDDED_BOUNDS);
  assert.equal(
    DEFAULT_EMBEDDED_BOUNDS.height,
    embeddedHeightForWidth(DEFAULT_EMBEDDED_BOUNDS.width, DEFAULT_EMBEDDED_CHROME_HEIGHT),
  );

  // Any stale/arbitrary stored height is snapped back to exact 4:3 for its width.
  const snapped = normalizeEmbeddedBounds({ width: 506, height: 900, right: 20, bottom: 72 }, viewport);
  assert.equal(snapped.width, 506);
  assert.equal(snapped.height, embeddedHeightForWidth(506));
  const canvasRatio = (snapped.width - EMBEDDED_CHROME_WIDTH) / (snapped.height - DEFAULT_EMBEDDED_CHROME_HEIGHT);
  assert.ok(Math.abs(canvasRatio - EMBEDDED_ASPECT_RATIO) < 0.01);

  const tiny = normalizeEmbeddedBounds({ width: 50, height: 50, right: -40, bottom: 9999 }, viewport);
  assert.equal(tiny.width, MIN_EMBEDDED_WIDTH);
  assert.equal(tiny.height, MIN_EMBEDDED_HEIGHT);
  assert.equal(tiny.right, VIEWPORT_MARGIN);
  assert.equal(tiny.bottom, viewport.height - MIN_EMBEDDED_HEIGHT - VIEWPORT_MARGIN);

  // Collapsed mode clamps vertical bottom against COLLAPSED_EMBEDDED_HEIGHT.
  const collapsedTop = normalizeEmbeddedBounds({ width: 440, height: 443, bottom: 9999, collapsed: true }, viewport);
  assert.equal(collapsedTop.bottom, viewport.height - COLLAPSED_EMBEDDED_HEIGHT - VIEWPORT_MARGIN);
});

test('computeDraggedBounds moves smoothly and stays within viewport margins', () => {
  const viewport = { width: 1200, height: 800 };
  const start = normalizeEmbeddedBounds({ width: 440, right: 20, bottom: 70, collapsed: false }, viewport);

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

test('computeResizedBounds snaps every edge and corner to 4:3 while keeping opposite edges pinned', () => {
  const viewport = { width: 1400, height: 900 };
  const start = normalizeEmbeddedBounds({ width: 440, right: 100, bottom: 100, collapsed: false }, viewport);

  // West edge grows width left and snaps height to 4:3 without shifting right or bottom.
  const west = computeResizedBounds(start, 'w', -80, 0, viewport);
  assert.equal(west.width, 520);
  assert.equal(west.height, embeddedHeightForWidth(520));
  assert.equal(west.right, 100);
  assert.equal(west.bottom, 100);

  // East edge grows width right, shifts right so left edge stays pinned, and snaps height to 4:3.
  const east = computeResizedBounds(start, 'e', 40, 0, viewport);
  assert.equal(east.width, 480);
  assert.equal(east.height, embeddedHeightForWidth(480));
  assert.equal(east.right, 60);
  assert.equal(viewport.width - east.right - east.width, viewport.width - start.right - start.width);

  // North edge grows height up and snaps width to 4:3 without shifting right or bottom.
  const north = computeResizedBounds(start, 'n', 0, -60, viewport);
  assert.equal(north.width, embeddedWidthForHeight(start.height + 60));
  assert.equal(north.height, embeddedHeightForWidth(north.width));
  assert.equal(north.right, 100);
  assert.equal(north.bottom, 100);

  // South edge grows height down, shifts bottom so top edge stays pinned, and snaps width to 4:3.
  const south = computeResizedBounds(start, 's', 0, 60, viewport);
  assert.equal(south.width, embeddedWidthForHeight(start.height + 60));
  assert.equal(south.height, embeddedHeightForWidth(south.width));
  assert.equal(viewport.height - south.bottom - south.height, viewport.height - start.bottom - start.height);

  // Corner drag snaps both dimensions to exact 4:3 and keeps opposite corner pinned.
  const se = computeResizedBounds(start, 'se', 80, 10, viewport);
  assert.equal(se.width, 520);
  assert.equal(se.height, embeddedHeightForWidth(520));
  assert.equal(viewport.width - se.right - se.width, viewport.width - start.right - start.width);
  assert.equal(viewport.height - se.bottom - se.height, viewport.height - start.bottom - start.height);

  // Collapsed mode allows horizontal resize and keeps expanded height snapped for when expanded later.
  const collapsed = computeResizedBounds({ ...start, collapsed: true }, 'w', -40, -100, viewport);
  assert.equal(collapsed.width, 480);
  assert.equal(collapsed.height, embeddedHeightForWidth(480));
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
