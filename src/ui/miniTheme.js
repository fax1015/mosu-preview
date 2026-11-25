// Paints the collapsed miniplayer in its beatmap's cover-art colours.
//
// The cover shown in the bar comes from assets.ppy.sh, which sends no CORS
// headers, so its pixels cannot be read. b.ppy.sh serves the same set's
// thumbnail and is already one of the extension's hosts, which lets an
// extension page fetch it without CORS. The thumbnail is drawn down to a few
// hundred pixels and handed to src/core/coverPalette.js for the seed and the
// palette, and the palette lands as CSS custom properties on the document, so
// every colour change is one CSS transition (the properties are registered as
// colours in popup.css). The timeline is a canvas and takes its colours here.

import {
  DEFAULT_MINI_PALETTE,
  PALETTE_KEYS,
  buildMiniPalette,
  extractCoverSeed,
  formatRgb,
  formatRgba,
} from '../core/coverPalette.js';
import { normalizeNumericId } from '../core/beatmapUrl.js';

const SAMPLE_WIDTH = 32;
const SAMPLE_HEIGHT = 24;
// Following a playlist of maps comes back to the same sets; a palette is a
// dozen small arrays, so keeping a few dozen costs nothing.
const MAX_CACHED_PALETTES = 32;
// A thumbnail is a few kilobytes; one that has not come in by now is not
// coming, and the bar keeps the colours it has.
const COVER_FETCH_TIMEOUT_MS = 10_000;

const toCssVariable = (key) => `--mini-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

const getThumbnailUrl = (setId) => `https://b.ppy.sh/thumb/${setId}l.jpg`;

/** What the timeline canvas is drawn in while the bar is collapsed. */
const buildTimelineColours = (palette) => Object.freeze({
  played: formatRgb(palette.onSurface),
  upcoming: formatRgba(palette.onSurfaceVariant, 0.3),
  playhead: formatRgb(palette.onSurface),
  playheadStyle: 'bar',
  preview: formatRgba(palette.accent, 0.95),
  kiaiFill: formatRgba(palette.accent, 0.08),
  kiaiEdge: formatRgba(palette.accent, 0.7),
  breakHatch: 'rgba(255, 255, 255, 0.08)',
  hover: formatRgba(palette.onSurface, 0.32),
  // No ruler: at this size it only reads as noise along the top edge.
  tick: 'rgba(0, 0, 0, 0)',
  // The wavy progress line takes the cover's accent; the track after it is
  // the same faint line the map's upcoming bars are drawn in.
  wave: formatRgb(palette.accent),
  waveTrack: formatRgba(palette.onSurfaceVariant, 0.3),
});

const samplePixels = async (blob) => {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT)
      : Object.assign(document.createElement('canvas'), { width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('no 2d context');
    }
    ctx.drawImage(bitmap, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    return ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
  } finally {
    bitmap.close?.();
  }
};

/**
 * @param {object} options
 * @param {HTMLElement} options.root where the CSS custom properties are set.
 * @param {() => ({ setColours: Function } | null)} options.getTimeline
 * @param {(palette: object) => void} [options.onPalette] told every time the
 *   palette changes, to pass it on to the shell around the iframe.
 */
const createMiniTheme = ({
  root,
  getTimeline,
  onPalette,
  addDebugLog,
  fetchImpl = globalThis.fetch?.bind(globalThis),
}) => {
  const cache = new Map();
  let activeSetId = null;
  let generation = 0;
  let palette = null;
  let timelineThemed = false;
  // The cover being fetched: let go of as soon as another is asked for.
  let inFlight = null;

  const syncTimeline = () => {
    getTimeline?.()?.setColours?.(timelineThemed && palette ? buildTimelineColours(palette) : null);
  };

  const paint = (next) => {
    if (next === palette) {
      return;
    }
    palette = next;
    for (const key of PALETTE_KEYS) {
      root?.style?.setProperty(toCssVariable(key), formatRgb(next[key]));
    }
    syncTimeline();
    onPalette?.(next);
  };

  const remember = (setId, value) => {
    cache.delete(setId);
    cache.set(setId, value);
    while (cache.size > MAX_CACHED_PALETTES) {
      cache.delete(cache.keys().next().value);
    }
  };

  const abortInFlight = () => {
    inFlight?.abort();
    inFlight = null;
  };

  const loadPalette = async (setId, signal) => {
    if (typeof fetchImpl !== 'function' || typeof createImageBitmap !== 'function') {
      return DEFAULT_MINI_PALETTE;
    }
    const response = await fetchImpl(getThumbnailUrl(setId), { credentials: 'omit', cache: 'force-cache', signal });
    if (!response?.ok) {
      throw new Error(`cover thumbnail returned ${response?.status ?? 'nothing'}`);
    }
    const blob = await response.blob();
    // A map switched to meanwhile wants its own cover: no use decoding this one.
    signal?.throwIfAborted?.();
    const pixels = await samplePixels(blob);
    return buildMiniPalette(extractCoverSeed(pixels));
  };

  /**
   * Themes the bar by a beatmap set's cover. The old colours stay up while the
   * new cover loads, so following from one map to the next fades straight from
   * one palette into the other.
   */
  const setCover = (rawSetId) => {
    const setId = normalizeNumericId(rawSetId);
    if (setId === activeSetId) {
      return;
    }
    activeSetId = setId;
    generation += 1;
    const requestGeneration = generation;
    abortInFlight();

    if (!setId) {
      paint(DEFAULT_MINI_PALETTE);
      return;
    }
    const cached = cache.get(setId);
    if (cached) {
      remember(setId, cached);
      paint(cached);
      return;
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    inFlight = controller;
    const timeout = controller ? setTimeout(() => controller.abort(), COVER_FETCH_TIMEOUT_MS) : null;
    void loadPalette(setId, controller?.signal)
      .then((next) => {
        remember(setId, next);
        if (requestGeneration === generation) {
          paint(next);
        }
      })
      .catch((error) => {
        // Let go of for another cover: that one is in hand, and this is no failure.
        if (requestGeneration !== generation) {
          return;
        }
        addDebugLog?.(`mini theme: no cover colours for set ${setId} (${error?.message || error})`);
        paint(DEFAULT_MINI_PALETTE);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (inFlight === controller) {
          inFlight = null;
        }
      });
  };

  /** Whether the timeline is drawn in the palette (collapsed) or as usual. */
  const setTimelineThemed = (themed) => {
    timelineThemed = Boolean(themed);
    syncTimeline();
  };

  paint(DEFAULT_MINI_PALETTE);

  /** Stops any cover still being fetched; the page is going. */
  const dispose = () => {
    generation += 1;
    abortInFlight();
  };

  return {
    setCover,
    setTimelineThemed,
    getPalette: () => palette,
    dispose,
  };
};

export { buildTimelineColours, createMiniTheme, toCssVariable };
