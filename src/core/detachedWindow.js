// Helpers for the detached preview window.
//
// The action popup reads the beatmap from the active tab, but a detached window
// cannot: `tabs.query({ currentWindow: true })` resolves to the detached window
// itself, and the `activeTab` grant is scoped to the toolbar click that opened
// the popup, so it never reaches a separate window. Instead the popup hands the
// already-resolved ids over in the page URL, and the detached window rebuilds a
// canonical beatmap URL from them so both entry points share one init path.
//
// This module stays free of extension and DOM APIs so it can be unit tested.

// Same document as the toolbar popup: the `detached` flag switches the layout,
// which keeps one copy of the preview markup rather than two that drift apart.
const DETACHED_PAGE = 'popup.html';
const DETACHED_FLAG_PARAM = 'detached';
const BEATMAP_ID_PARAM = 'beatmapId';
const SET_ID_PARAM = 'setId';
const MODE_PARAM = 'mode';
const TIME_PARAM = 't';
const PAUSED_PARAM = 'paused';

// A preview can run for well over an hour; this only needs to reject junk.
const MAX_RESUME_TIME_MS = 24 * 60 * 60 * 1000;

const MODE_NAMES = ['osu', 'taiko', 'fruits', 'mania'];

const DETACHED_WINDOW_ID_KEY = 'mosuDetachedWindowIdV1';
const DETACHED_WINDOW_BOUNDS_KEY = 'mosuDetachedWindowBoundsV1';

// Sized so the 1.29:1 playfield lands close to the action popup's proportions
// while leaving room for the header and transport controls.
const DEFAULT_DETACHED_BOUNDS = Object.freeze({ width: 640, height: 720 });
const MIN_DETACHED_WIDTH = 380;
const MIN_DETACHED_HEIGHT = 420;
const MAX_DETACHED_DIMENSION = 4096;
// Off-screen coordinates would open a window the user cannot reach, so restored
// positions are bounded rather than trusted.
const MIN_DETACHED_COORDINATE = -MAX_DETACHED_DIMENSION;

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeNumericId = (value) => {
  const candidate = String(value ?? '').trim();
  return /^\d+$/.test(candidate) ? candidate : '';
};

/** Returns -1 for "not carried", so 0 stays a real, distinct resume point. */
const normalizeResumeTimeMs = (value) => {
  // Guarded explicitly because Number(null) and Number('') are both 0: an absent
  // param would otherwise read as a resume point at the very start of the map.
  if (value === null || value === undefined || value === '') {
    return -1;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_RESUME_TIME_MS) {
    return -1;
  }
  return Math.round(numeric);
};

const normalizeMode = (value) => {
  const candidate = String(value ?? '').trim().toLowerCase();
  if (!candidate) {
    return null;
  }
  if (candidate === 'catch') {
    return 2;
  }
  if (MODE_NAMES.includes(candidate)) {
    return MODE_NAMES.indexOf(candidate);
  }
  if (/^\d+$/.test(candidate)) {
    const numeric = Number.parseInt(candidate, 10);
    return numeric >= 0 && numeric <= 3 ? numeric : null;
  }
  return null;
};

/**
 * Reads the detached-mode payload out of a page query string.
 * Accepts a raw search string, a URLSearchParams, or a full URL.
 */
const readDetachedParams = (search = '') => {
  let params;
  if (search instanceof URLSearchParams) {
    params = search;
  } else {
    const raw = String(search ?? '');
    try {
      params = new URL(raw).searchParams;
    } catch {
      params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
    }
  }

  const beatmapId = normalizeNumericId(params.get(BEATMAP_ID_PARAM));
  const flag = params.get(DETACHED_FLAG_PARAM);

  const pausedFlag = params.get(PAUSED_PARAM);

  return {
    // A detached page without a usable beatmap id has nothing to render, so it
    // falls back to the normal active-tab path rather than showing an error.
    isDetached: (flag === '1' || flag === 'true') && beatmapId !== '',
    beatmapId,
    setId: normalizeNumericId(params.get(SET_ID_PARAM)),
    mode: normalizeMode(params.get(MODE_PARAM)),
    // Where the popup left off, so the window picks the preview up rather than
    // restarting it at the beatmap's preview point.
    resumeTimeMs: normalizeResumeTimeMs(params.get(TIME_PARAM)),
    resumePaused: pausedFlag === '1' || pausedFlag === 'true',
  };
};

/**
 * Rebuilds a canonical osu.ppy.sh beatmap URL from resolved ids, so the detached
 * window can reuse `extractBeatmapInfoFromUrl` instead of a parallel code path.
 */
const buildBeatmapSourceUrl = ({ beatmapId, setId, mode } = {}) => {
  const normalizedBeatmapId = normalizeNumericId(beatmapId);
  if (!normalizedBeatmapId) {
    return '';
  }

  const normalizedSetId = normalizeNumericId(setId);
  const normalizedMode = normalizeMode(mode);

  if (normalizedSetId) {
    return normalizedMode === null
      ? `https://osu.ppy.sh/beatmapsets/${normalizedSetId}?b=${normalizedBeatmapId}`
      : `https://osu.ppy.sh/beatmapsets/${normalizedSetId}#${MODE_NAMES[normalizedMode]}/${normalizedBeatmapId}`;
  }

  return normalizedMode === null
    ? `https://osu.ppy.sh/beatmaps/${normalizedBeatmapId}`
    : `https://osu.ppy.sh/beatmaps/${normalizedBeatmapId}?mode=${MODE_NAMES[normalizedMode]}`;
};

/**
 * Builds the extension-relative URL for the detached page. Returns '' when there
 * is no beatmap to carry over, which callers treat as "detaching unavailable".
 */
const buildDetachedPageUrl = ({ beatmapId, setId, mode, resumeTimeMs, resumePaused } = {}) => {
  const normalizedBeatmapId = normalizeNumericId(beatmapId);
  if (!normalizedBeatmapId) {
    return '';
  }

  const params = new URLSearchParams({
    [DETACHED_FLAG_PARAM]: '1',
    [BEATMAP_ID_PARAM]: normalizedBeatmapId,
  });

  const normalizedSetId = normalizeNumericId(setId);
  if (normalizedSetId) {
    params.set(SET_ID_PARAM, normalizedSetId);
  }

  const normalizedMode = normalizeMode(mode);
  if (normalizedMode !== null) {
    params.set(MODE_PARAM, MODE_NAMES[normalizedMode]);
  }

  const normalizedResumeTimeMs = normalizeResumeTimeMs(resumeTimeMs);
  if (normalizedResumeTimeMs >= 0) {
    params.set(TIME_PARAM, String(normalizedResumeTimeMs));
    if (resumePaused) {
      params.set(PAUSED_PARAM, '1');
    }
  }

  return `${DETACHED_PAGE}?${params.toString()}`;
};

/**
 * Clamps stored window geometry back into a usable range. `left`/`top` are only
 * emitted when both are present, since the window APIs treat them as a pair.
 */
const normalizeDetachedBounds = (bounds = {}) => {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  const normalized = {
    width: Number.isFinite(width)
      ? Math.round(clampNumber(width, MIN_DETACHED_WIDTH, MAX_DETACHED_DIMENSION))
      : DEFAULT_DETACHED_BOUNDS.width,
    height: Number.isFinite(height)
      ? Math.round(clampNumber(height, MIN_DETACHED_HEIGHT, MAX_DETACHED_DIMENSION))
      : DEFAULT_DETACHED_BOUNDS.height,
  };

  const left = Number(bounds?.left);
  const top = Number(bounds?.top);
  if (Number.isFinite(left) && Number.isFinite(top)) {
    normalized.left = Math.round(clampNumber(left, MIN_DETACHED_COORDINATE, MAX_DETACHED_DIMENSION));
    normalized.top = Math.round(clampNumber(top, MIN_DETACHED_COORDINATE, MAX_DETACHED_DIMENSION));
  }

  return normalized;
};

/**
 * Whether the window API refused the geometry we asked for.
 *
 * Stored coordinates cannot be validated ahead of time: the extension has no
 * display permission, so it cannot know how many screens there are or where they
 * sit, and `window.screen` only describes the one the popup is on. A position
 * that looks impossible may be perfectly valid on a second monitor. So the
 * browser is left to be the authority, and this recognises it saying no.
 */
const isBoundsRejection = (error) => /bounds/i.test(String(error?.message || error || ''));

/** The same geometry with the position dropped, leaving the browser to place it. */
const withoutDetachedPosition = (bounds = {}) => {
  const { left, top, ...size } = bounds;
  return size;
};

const hasDetachedPosition = (bounds = {}) => (
  Number.isFinite(Number(bounds?.left)) && Number.isFinite(Number(bounds?.top))
);

export {
  DETACHED_PAGE,
  DETACHED_WINDOW_ID_KEY,
  DETACHED_WINDOW_BOUNDS_KEY,
  DEFAULT_DETACHED_BOUNDS,
  MIN_DETACHED_WIDTH,
  MIN_DETACHED_HEIGHT,
  readDetachedParams,
  normalizeResumeTimeMs,
  buildBeatmapSourceUrl,
  buildDetachedPageUrl,
  normalizeDetachedBounds,
  isBoundsRejection,
  withoutDetachedPosition,
  hasDetachedPosition,
};
