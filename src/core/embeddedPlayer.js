// Pure helpers for the in-page osu.ppy.sh embedded miniplayer.
//
// The floating player mounts an extension iframe (`popup.html?embedded=1&...`)
// inside a Shadow DOM shell attached to `document.documentElement` (outside
// `<body>`), so Hotwire Turbo Drive body swaps on osu.ppy.sh never disconnect
// or reload the iframe.
//
// This module stays free of DOM and extension APIs so it can be unit tested.

import { MODE_URL_NAMES, normalizeNumericId, parseModeToken } from './beatmapUrl.js';
import { DETACHED_PAGE, normalizeResumeTimeMs } from './detachedWindow.js';
import { clamp } from './math.js';

const EMBEDDED_FLAG_PARAM = 'embedded';
const EMBEDDED_COLLAPSED_PARAM = 'collapsed';
const EMBEDDED_FOLLOW_PARAM = 'follow';
const BEATMAP_ID_PARAM = 'beatmapId';
const SET_ID_PARAM = 'setId';
const MODE_PARAM = 'mode';
const TIME_PARAM = 't';
const PAUSED_PARAM = 'paused';

const EMBEDDED_BOUNDS_KEY = 'mosuEmbeddedPlayerBoundsV1';
const EMBEDDED_RESUME_STORAGE_KEY = 'mosuEmbeddedResumeV1';
const EMBEDDED_RESUME_MAX_AGE_MS = 60 * 1000;
const EMBEDDED_RESUME_FUTURE_SKEW_MS = 5 * 1000;
const MAX_RESUME_TIME_MS = 24 * 60 * 60 * 1000;

const EMBEDDED_MESSAGE_CHANNEL = 'mosu-preview-embedded-v1';
const OSU_ORIGIN = 'https://osu.ppy.sh';

// Sized to mirror the toolbar popup's 4:3 proportions while leaving room for
// the slim outer drag bar, positioned just above osu!'s own #main-player bar.
const DEFAULT_EMBEDDED_BOUNDS = Object.freeze({
  width: 456,
  height: 432,
  right: 20,
  bottom: 72,
  collapsed: false,
});

const MIN_EMBEDDED_WIDTH = 340;
const MIN_EMBEDDED_HEIGHT = 280;
const MAX_EMBEDDED_WIDTH = 1400;
const MAX_EMBEDDED_HEIGHT = 1100;
const COLLAPSED_EMBEDDED_HEIGHT = 112;
const VIEWPORT_MARGIN = 8;

const isOsuWebsiteUrl = (rawUrl) => {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'https:' && parsed.hostname === 'osu.ppy.sh';
  } catch {
    return false;
  }
};

const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return Number.NaN;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
};

/**
 * Reads the embedded-mode payload out of a page query string.
 * Accepts a raw search string, a URLSearchParams, or a full URL.
 */
const readEmbeddedParams = (search = '') => {
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
  const flag = params.get(EMBEDDED_FLAG_PARAM);
  const pausedFlag = params.get(PAUSED_PARAM);
  const collapsedFlag = params.get(EMBEDDED_COLLAPSED_PARAM);
  const followFlag = params.get(EMBEDDED_FOLLOW_PARAM);

  return {
    isEmbedded: (flag === '1' || flag === 'true') && beatmapId !== '',
    beatmapId,
    setId: normalizeNumericId(params.get(SET_ID_PARAM)),
    mode: parseModeToken(params.get(MODE_PARAM)),
    resumeTimeMs: normalizeResumeTimeMs(params.get(TIME_PARAM)),
    resumePaused: pausedFlag === '1' || pausedFlag === 'true',
    collapsed: collapsedFlag === '1' || collapsedFlag === 'true',
    // Default to following the hosting osu! tab unless explicitly pinned (`follow=0`).
    followEnabled: followFlag !== '0' && followFlag !== 'false',
  };
};

/**
 * Builds the extension-relative URL for the embedded iframe. Returns '' when
 * there is no valid beatmap id to hand over.
 */
const buildEmbeddedPageUrl = ({
  beatmapId,
  setId,
  mode,
  resumeTimeMs,
  resumePaused,
  collapsed = false,
  followEnabled = true,
} = {}) => {
  const normalizedBeatmapId = normalizeNumericId(beatmapId);
  if (!normalizedBeatmapId) {
    return '';
  }

  const params = new URLSearchParams({
    [EMBEDDED_FLAG_PARAM]: '1',
    [BEATMAP_ID_PARAM]: normalizedBeatmapId,
  });

  const normalizedSetId = normalizeNumericId(setId);
  if (normalizedSetId) {
    params.set(SET_ID_PARAM, normalizedSetId);
  }

  const normalizedMode = parseModeToken(mode);
  if (normalizedMode !== null) {
    params.set(MODE_PARAM, MODE_URL_NAMES[normalizedMode]);
  }

  const normalizedResumeTimeMs = normalizeResumeTimeMs(resumeTimeMs);
  if (normalizedResumeTimeMs >= 0) {
    params.set(TIME_PARAM, String(normalizedResumeTimeMs));
    if (resumePaused) {
      params.set(PAUSED_PARAM, '1');
    }
  }

  if (collapsed) {
    params.set(EMBEDDED_COLLAPSED_PARAM, '1');
  }

  if (followEnabled === false) {
    params.set(EMBEDDED_FOLLOW_PARAM, '0');
  }

  return `${DETACHED_PAGE}?${params.toString()}`;
};

const getEffectiveViewport = (viewport) => {
  const width = toFiniteNumber(viewport?.width);
  const height = toFiniteNumber(viewport?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
};

/**
 * Clamps persisted overlay geometry into a usable range and, when a viewport is
 * supplied, guarantees the shell stays reachable inside the visible window.
 */
const normalizeEmbeddedBounds = (bounds = {}, viewport = null) => {
  const vp = getEffectiveViewport(viewport);
  const collapsed = Boolean(bounds?.collapsed);

  const maxAllowedWidth = vp
    ? Math.max(200, Math.min(MAX_EMBEDDED_WIDTH, Math.floor(vp.width - (VIEWPORT_MARGIN * 2))))
    : MAX_EMBEDDED_WIDTH;
  const minAllowedWidth = Math.min(MIN_EMBEDDED_WIDTH, maxAllowedWidth);

  const maxAllowedHeight = vp
    ? Math.max(COLLAPSED_EMBEDDED_HEIGHT, Math.min(MAX_EMBEDDED_HEIGHT, Math.floor(vp.height - (VIEWPORT_MARGIN * 2))))
    : MAX_EMBEDDED_HEIGHT;
  const minAllowedHeight = Math.min(MIN_EMBEDDED_HEIGHT, maxAllowedHeight);

  const rawWidth = toFiniteNumber(bounds?.width);
  const rawHeight = toFiniteNumber(bounds?.height);
  const width = Math.round(clamp(
    Number.isFinite(rawWidth) ? rawWidth : DEFAULT_EMBEDDED_BOUNDS.width,
    minAllowedWidth,
    maxAllowedWidth,
  ));
  const height = Math.round(clamp(
    Number.isFinite(rawHeight) ? rawHeight : DEFAULT_EMBEDDED_BOUNDS.height,
    minAllowedHeight,
    maxAllowedHeight,
  ));

  const effectiveHeight = collapsed ? Math.min(COLLAPSED_EMBEDDED_HEIGHT, maxAllowedHeight) : height;

  const rawRight = toFiniteNumber(bounds?.right);
  const rawBottom = toFiniteNumber(bounds?.bottom);
  const maxRight = vp ? Math.max(VIEWPORT_MARGIN, Math.floor(vp.width - width - VIEWPORT_MARGIN)) : MAX_EMBEDDED_WIDTH * 4;
  const maxBottom = vp
    ? Math.max(VIEWPORT_MARGIN, Math.floor(vp.height - effectiveHeight - VIEWPORT_MARGIN))
    : MAX_EMBEDDED_HEIGHT * 4;

  const right = Math.round(clamp(
    Number.isFinite(rawRight) ? rawRight : DEFAULT_EMBEDDED_BOUNDS.right,
    VIEWPORT_MARGIN,
    maxRight,
  ));
  const bottom = Math.round(clamp(
    Number.isFinite(rawBottom) ? rawBottom : DEFAULT_EMBEDDED_BOUNDS.bottom,
    VIEWPORT_MARGIN,
    maxBottom,
  ));

  return { width, height, right, bottom, collapsed };
};

/**
 * Moves the bottom-right anchored shell by `(deltaX, deltaY)` pointer movement,
 * clamped to keep the entire shell inside the viewport.
 */
const computeDraggedBounds = (startBounds, deltaX, deltaY, viewport) => {
  const base = normalizeEmbeddedBounds(startBounds, viewport);
  const dx = Number.isFinite(Number(deltaX)) ? Number(deltaX) : 0;
  const dy = Number.isFinite(Number(deltaY)) ? Number(deltaY) : 0;
  return normalizeEmbeddedBounds({
    ...base,
    right: base.right - dx,
    bottom: base.bottom - dy,
  }, viewport);
};

/**
 * Resizes the bottom-right anchored shell from any edge or corner (`n`, `s`,
 * `e`, `w`, `nw`, `ne`, `sw`, `se`) while keeping the opposite edge pinned.
 */
const computeResizedBounds = (startBounds, edge, deltaX, deltaY, viewport) => {
  const base = normalizeEmbeddedBounds(startBounds, viewport);
  const vp = getEffectiveViewport(viewport);
  const dir = String(edge || '').toLowerCase();
  const dx = Number.isFinite(Number(deltaX)) ? Number(deltaX) : 0;
  const dy = Number.isFinite(Number(deltaY)) ? Number(deltaY) : 0;

  let { width, height, right, bottom } = base;

  const maxViewportW = vp ? Math.max(200, Math.floor(vp.width - (VIEWPORT_MARGIN * 2))) : MAX_EMBEDDED_WIDTH;
  const minW = Math.min(MIN_EMBEDDED_WIDTH, maxViewportW);

  if (dir.includes('w')) {
    const maxW = vp
      ? Math.min(MAX_EMBEDDED_WIDTH, Math.max(minW, Math.floor(vp.width - base.right - VIEWPORT_MARGIN)))
      : MAX_EMBEDDED_WIDTH;
    width = Math.round(clamp(base.width - dx, minW, maxW));
  } else if (dir.includes('e')) {
    const maxW = Math.min(
      MAX_EMBEDDED_WIDTH,
      Math.max(minW, Math.floor(base.width + base.right - VIEWPORT_MARGIN)),
    );
    width = Math.round(clamp(base.width + dx, minW, maxW));
    right = Math.round(base.right - (width - base.width));
  }

  if (!base.collapsed) {
    const maxViewportH = vp ? Math.max(COLLAPSED_EMBEDDED_HEIGHT, Math.floor(vp.height - (VIEWPORT_MARGIN * 2))) : MAX_EMBEDDED_HEIGHT;
    const minH = Math.min(MIN_EMBEDDED_HEIGHT, maxViewportH);

    if (dir.includes('n')) {
      const maxH = vp
        ? Math.min(MAX_EMBEDDED_HEIGHT, Math.max(minH, Math.floor(vp.height - base.bottom - VIEWPORT_MARGIN)))
        : MAX_EMBEDDED_HEIGHT;
      height = Math.round(clamp(base.height - dy, minH, maxH));
    } else if (dir.includes('s')) {
      const maxH = Math.min(
        MAX_EMBEDDED_HEIGHT,
        Math.max(minH, Math.floor(base.height + base.bottom - VIEWPORT_MARGIN)),
      );
      height = Math.round(clamp(base.height + dy, minH, maxH));
      bottom = Math.round(base.bottom - (height - base.height));
    }
  }

  return normalizeEmbeddedBounds({
    width,
    height,
    right,
    bottom,
    collapsed: base.collapsed,
  }, viewport);
};

/**
 * Serializes the live embedded playback snapshot for per-tab `sessionStorage`
 * so a hard browser reload can reopen the miniplayer close to where it left off.
 */
const serializeResumeSnapshot = (snapshot, nowMs = Date.now()) => {
  const beatmapId = normalizeNumericId(snapshot?.beatmapId);
  if (!beatmapId) {
    return null;
  }
  const timeMs = normalizeResumeTimeMs(snapshot?.currentTimeMs);
  const rawSpeed = toFiniteNumber(snapshot?.playbackSpeed);
  const playbackSpeed = Number.isFinite(rawSpeed) && rawSpeed > 0 && rawSpeed <= 4 ? rawSpeed : 1;

  return {
    version: 1,
    beatmapId,
    setId: normalizeNumericId(snapshot?.setId),
    mode: parseModeToken(snapshot?.mode),
    currentTimeMs: timeMs >= 0 ? timeMs : 0,
    isPlaying: Boolean(snapshot?.isPlaying),
    playbackSpeed,
    followEnabled: snapshot?.followEnabled !== false,
    collapsed: Boolean(snapshot?.collapsed),
    sourceUrl: typeof snapshot?.sourceUrl === 'string' ? snapshot.sourceUrl : '',
    savedAt: Number.isFinite(nowMs) ? Math.round(nowMs) : Date.now(),
  };
};

/**
 * Validates a stored reload-resume snapshot and projects the playhead forward
 * by the reload duration when it was actively playing.
 */
const resolveResumeSnapshot = (raw, nowMs = Date.now()) => {
  if (!raw || typeof raw !== 'object' || raw.version !== 1) {
    return null;
  }

  const beatmapId = normalizeNumericId(raw.beatmapId);
  if (!beatmapId) {
    return null;
  }

  const savedAt = toFiniteNumber(raw.savedAt);
  if (!Number.isFinite(savedAt)) {
    return null;
  }

  const ageMs = nowMs - savedAt;
  if (ageMs < -EMBEDDED_RESUME_FUTURE_SKEW_MS || ageMs > EMBEDDED_RESUME_MAX_AGE_MS) {
    return null;
  }

  const baseTimeMs = normalizeResumeTimeMs(raw.currentTimeMs);
  const safeBaseTimeMs = baseTimeMs >= 0 ? baseTimeMs : 0;
  const isPlaying = Boolean(raw.isPlaying);
  const rawSpeed = toFiniteNumber(raw.playbackSpeed);
  const playbackSpeed = Number.isFinite(rawSpeed) && rawSpeed > 0 && rawSpeed <= 4 ? rawSpeed : 1;
  const elapsedMs = isPlaying ? Math.max(0, ageMs) * playbackSpeed : 0;
  const resumeTimeMs = Math.round(clamp(safeBaseTimeMs + elapsedMs, 0, MAX_RESUME_TIME_MS));

  return {
    beatmapId,
    setId: normalizeNumericId(raw.setId),
    mode: parseModeToken(raw.mode),
    resumeTimeMs,
    resumePaused: !isPlaying,
    followEnabled: raw.followEnabled !== false,
    collapsed: Boolean(raw.collapsed),
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : '',
  };
};

export {
  EMBEDDED_FLAG_PARAM,
  EMBEDDED_COLLAPSED_PARAM,
  EMBEDDED_FOLLOW_PARAM,
  EMBEDDED_BOUNDS_KEY,
  EMBEDDED_RESUME_STORAGE_KEY,
  EMBEDDED_RESUME_MAX_AGE_MS,
  EMBEDDED_MESSAGE_CHANNEL,
  OSU_ORIGIN,
  DEFAULT_EMBEDDED_BOUNDS,
  MIN_EMBEDDED_WIDTH,
  MIN_EMBEDDED_HEIGHT,
  MAX_EMBEDDED_WIDTH,
  MAX_EMBEDDED_HEIGHT,
  COLLAPSED_EMBEDDED_HEIGHT,
  VIEWPORT_MARGIN,
  isOsuWebsiteUrl,
  readEmbeddedParams,
  buildEmbeddedPageUrl,
  normalizeEmbeddedBounds,
  computeDraggedBounds,
  computeResizedBounds,
  serializeResumeSnapshot,
  resolveResumeSnapshot,
};
