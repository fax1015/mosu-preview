import { clamp, findFirstIndexAtOrAfter } from './core/math.js';
import { getCanvasContext } from './core/canvas.js';
import {
  MAX_MEASURE_LINES,
  buildPrefixMaxEndTimes,
  findFirstIndexWithEndAtOrAfter,
  findLastIndexAtOrBefore,
} from './renderers/shared.js';

// The preview's timeline: the map itself (density bars from afar, single
// objects up close) in the small strip between the speed and time controls,
// with time ticks along its top edge and, while zoomed, a rail along its bottom
// showing where in the map the view is. It owns which stretch of the map is on
// screen and draws itself; seeking stays with the playback controller, which is
// only ever handed a time.

// Shortest stretch of the map the view zooms in to: a few beats of a stream.
const MIN_VIEW_MS = 500;
// The strip has no room for written times (the hover readout has them), so
// the ticks only mark out the scale, kept at least this far apart.
const MIN_TICK_SPACING_PX = 22;
const TICK_STEPS_MS = Object.freeze([
  50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1200000,
]);
const TICK_HEIGHT_PX = 3;

const OVERVIEW_HEIGHT_PX = 4;
const OVERVIEW_GAP_PX = 1;
// The rail is thin, so the band that grabs it reaches a little above it.
const OVERVIEW_HIT_SLOP_PX = 3;
const MIN_BRACKET_WIDTH_PX = 6;

const DENSITY_BAR_PX = 2;
// Density bars give way to single objects between these zoom levels: by the
// first, a 1/4 stream at 180 BPM is about 5px apart.
const OBJECTS_SHOWN_MS_PER_PX = 15;
const DENSITY_SHOWN_MS_PER_PX = 40;
// How near the pointer has to be to an object's head for it to count as being
// on it: a little past the mark's own radius, so the aim does not have to be
// exact. Used both for snapping the playhead and for picking one to select.
const OBJECT_GRAB_PX = 7;
// Objects only pull on the pointer once they are properly on screen. Snapping
// to marks that are still ghosting in reads as the timeline sticking.
const OBJECTS_GRABBABLE_MIX = 0.5;
const MIN_BEAT_SPACING_PX = 6;
const MIN_BAR_SPACING_PX = 10;

// Where the playhead is held while a zoomed view follows playback: past the
// middle, so more of what is coming is on screen than of what has gone.
const FOLLOW_RATIO = 0.6;
// Where it lands when the view has to come back for it.
const FOLLOW_RETURN_RATIO = 0.35;
const VIEW_EASE_MS = 70;
const REVEAL_EASE_MS = 90;
const FOLLOW_CATCH_UP_MS = 140;
const DURATION_GROW_MS = 340;
// How long the density bars take to grow and shrink into another difficulty's.
const DENSITY_MORPH_MS = 320;
// A frame gap longer than this is a stall, not motion to catch up on.
const MAX_STEP_MS = 34;

// No background colours: the canvas is transparent, so the capsule behind it is
// the background, the exact same colour in every browser.
const COLOURS = Object.freeze({
  tick: 'rgba(255, 255, 255, 0.28)',
  gridLine: 'rgb(255, 255, 255)',
  upcoming: 'rgb(63, 155, 106)',
  played: 'rgb(102, 206, 147)',
  kiaiFill: 'rgba(255, 204, 34, 0.1)',
  kiaiEdge: 'rgba(255, 204, 34, 0.75)',
  breakHatch: 'rgba(255, 255, 255, 0.07)',
  preview: 'rgba(171, 144, 255, 0.95)',
  playhead: 'rgb(255, 255, 255)',
  playheadHalo: 'rgba(0, 0, 0, 0.4)',
  hover: 'rgba(255, 255, 255, 0.32)',
  selected: 'rgb(255, 222, 123)',
  selectedHalo: 'rgba(255, 222, 123, 0.28)',
  rail: 'rgba(255, 255, 255, 0.08)',
  bracket: 'rgba(255, 255, 255, 0.42)',
  // Deliberately faint: there to find, not to look at.
  endLine: 'rgba(255, 255, 255, 0.07)',
  pastEnd: 'rgba(0, 0, 0, 0.05)',
});

const easeOutCubic = (t) => 1 - ((1 - clamp(t, 0, 1)) ** 3);
const smoothstep = (edge0, edge1, value) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - (2 * t));
};

/** A view of at least MIN_VIEW_MS (or the whole map, if shorter) kept inside it. */
const clampView = (startMs, durationMs, totalMs) => {
  const total = Math.max(1, totalMs);
  const duration = clamp(Number.isFinite(durationMs) ? durationMs : total, Math.min(MIN_VIEW_MS, total), total);
  return {
    startMs: clamp(Number.isFinite(startMs) ? startMs : 0, 0, total - duration),
    durationMs: duration,
  };
};

/**
 * Scales a view by `factor`, keeping `anchorMs` at `anchorRatio` of the way
 * across, which is where the pointer is when the wheel turns.
 */
const zoomView = (view, totalMs, anchorMs, factor, anchorRatio) => {
  const { durationMs } = clampView(0, view.durationMs * factor, totalMs);
  return clampView(anchorMs - (clamp(anchorRatio, 0, 1) * durationMs), durationMs, totalMs);
};

/** The tick step for a zoom level: the finest round step that keeps ticks apart. */
const pickTickStep = (msPerPx, minSpacingPx = MIN_TICK_SPACING_PX) => {
  const minStepMs = msPerPx * minSpacingPx;
  const stepMs = TICK_STEPS_MS.find((step) => step >= minStepMs);
  if (stepMs !== undefined) {
    return stepMs;
  }
  const lastStepMs = TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
  return Math.ceil(minStepMs / lastStepMs) * lastStepMs;
};

/** `m:ss`, with as many decimals of a second as asked for. */
const formatTimelineTime = (ms, decimals = 0) => {
  const scale = 10 ** decimals;
  const units = Math.floor(((Math.max(0, Number.isFinite(ms) ? ms : 0) * scale) / 1000) + 1e-6);
  const minutes = Math.floor(units / (60 * scale));
  const rest = units - (minutes * 60 * scale);
  const seconds = Math.floor(rest / scale);
  const fraction = rest - (seconds * scale);
  return `${minutes}:${String(seconds).padStart(2, '0')}${decimals > 0 ? `.${String(fraction).padStart(decimals, '0')}` : ''}`;
};

// The hover readout: whole seconds from afar, milliseconds once single
// objects are on screen.
const getReadoutDecimals = (msPerPx) => {
  if (msPerPx <= OBJECTS_SHOWN_MS_PER_PX * 2) return 3;
  return msPerPx <= 200 ? 1 : 0;
};

/** Objects per bin across [startMs, startMs + durationMs], into `counts`. */
const countObjectsIntoBins = (objects, startMs, durationMs, counts) => {
  counts.fill(0);
  const binCount = counts.length;
  if (!Array.isArray(objects) || objects.length === 0 || !(durationMs > 0) || binCount === 0) {
    return counts;
  }

  const endMs = startMs + durationMs;
  const scale = binCount / durationMs;
  for (let index = findFirstIndexAtOrAfter(objects, startMs); index < objects.length; index += 1) {
    const time = objects[index]?.time;
    if (!Number.isFinite(time)) {
      continue;
    }
    if (time > endMs) {
      break;
    }
    counts[Math.min(binCount - 1, Math.floor((time - startMs) * scale))] += 1;
  }
  return counts;
};

/** Objects per map-anchored bin, beginning at `firstBinIndex`. */
const countObjectsIntoAlignedBins = (objects, firstBinIndex, binDurationMs, counts) => {
  counts.fill(0);
  if (!Array.isArray(objects) || objects.length === 0 || !(binDurationMs > 0) || counts.length === 0) {
    return counts;
  }

  const startMs = firstBinIndex * binDurationMs;
  const endMs = (firstBinIndex + counts.length) * binDurationMs;
  const boundaryToleranceMs = binDurationMs * 1e-9;
  for (let index = findFirstIndexAtOrAfter(objects, startMs - boundaryToleranceMs); index < objects.length; index += 1) {
    const time = objects[index]?.time;
    if (!Number.isFinite(time)) {
      continue;
    }
    if (time >= endMs) {
      break;
    }
    // Divide from map time zero so an object's bin never depends on the view's
    // left edge. The tiny tolerance keeps exact boundaries stable in floats.
    const binIndex = Math.floor((time / binDurationMs) + 1e-9) - firstBinIndex;
    if (binIndex >= 0 && binIndex < counts.length) {
      counts[binIndex] += 1;
    }
  }
  return counts;
};

const buildKiaiSections = (controlPoints) => {
  const points = Array.isArray(controlPoints)
    ? [...controlPoints].filter((point) => Number.isFinite(point?.time)).sort((a, b) => a.time - b.time)
    : [];
  const sections = [];
  let startMs = null;
  for (const point of points) {
    if (point.kiai && startMs === null) {
      startMs = point.time;
    } else if (!point.kiai && startMs !== null) {
      if (point.time > startMs) {
        sections.push({ startMs, endMs: point.time });
      }
      startMs = null;
    }
  }
  if (startMs !== null) {
    sections.push({ startMs, endMs: Infinity });
  }
  return sections;
};

const MAX_TIMING_METER = 1024;
const getSectionTime = (section) => section.time;

const buildTimingSections = (controlPoints) => (
  Array.isArray(controlPoints)
    ? controlPoints
      .filter((point) => point?.uninherited && Number.isFinite(point.time) && Number.isFinite(point.beatLength) && point.beatLength > 0)
      .map((point) => ({
        time: point.time,
        beatLength: point.beatLength,
        meter: Number.isInteger(point.meter) && point.meter > 0 ? clamp(point.meter, 1, MAX_TIMING_METER) : 4,
      }))
      .sort((a, b) => a.time - b.time)
    : []
);

const normaliseBreaks = (breaks) => (
  Array.isArray(breaks)
    ? breaks
      .filter((period) => Number.isFinite(period?.start) && Number.isFinite(period?.end) && period.end > period.start)
      .map((period) => ({ startMs: period.start, endMs: period.end }))
    : []
);

const computeLayout = (width, height, overviewReveal) => {
  // The rail slides up from below the bottom edge rather than fading in place,
  // and the track gives up the room as it comes.
  const overviewTop = height - (OVERVIEW_HEIGHT_PX * overviewReveal);
  return {
    width,
    height,
    trackTop: 0,
    trackBottom: overviewTop - (OVERVIEW_GAP_PX * overviewReveal),
    overviewTop,
  };
};

// A slider or hold body. Too short for rounded ends, it is just a box.
const traceCapsule = (ctx, x0, x1, middle, halfHeight) => {
  const width = Math.max(0, x1 - x0);
  if (width <= halfHeight * 2 || typeof ctx.roundRect !== 'function') {
    ctx.rect(x0, middle - halfHeight, Math.max(width, 1), halfHeight * 2);
    return;
  }
  ctx.roundRect(x0, middle - halfHeight, width, halfHeight * 2, halfHeight);
};

class TimelineRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.objects = [];
    this.durationMs = 1;
    this.visualDurationMs = 1;
    this.durationAnimation = null;
    this.currentTimeMs = 0;
    this.previewTimeMs = -1;
    this.kiaiSections = [];
    this.breaks = [];
    this.timingSections = [];
    this.maxObjectDurationMs = 0;
    this.prefixMaxEnd = null;
    // Where the map stops: the song's end once the full track says how long it
    // is, the last object's end until then.
    this.lastObjectEndMs = 0;
    this.songEndMs = null;
    // What is on screen, and where it is easing towards. While `fitsMap` the
    // view is the whole map, however long that turns out to be.
    this.fitsMap = true;
    this.view = { startMs: 0, durationMs: 1 };
    this.target = { startMs: 0, durationMs: 1 };
    this.isViewEasing = false;
    this.overviewReveal = 0;
    this.lastStepAt = null;
    this.isPlaying = false;
    this.isInteracting = false;
    // Set when the user looks elsewhere on a zoomed timeline; cleared by the
    // next seek or by playback starting.
    this.isFollowSuspended = false;
    this.lastFollowTimeMs = 0;
    this.hoverX = null;
    this.width = 1;
    this.height = 1;
    this.layout = computeLayout(1, 1, 0);
    this.fullDensity = null;
    this.viewDensityCache = null;
    // While the bars move to another difficulty's: the map they come from,
    // with density caches of its own, and how far along they are (0 to 1).
    this.densityMorph = null;
    // Indices into `objects`, as a set for drawing and sorted for reading.
    // Objects are in time order, so index order is time order.
    this.selection = new Set();
  }

  setBeatmap(mapData, durationMs, { previewTimeMs = -1 } = {}) {
    this.durationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 1) : 1;
    this.visualDurationMs = this.durationMs;
    this.durationAnimation = null;
    this.currentTimeMs = clamp(this.currentTimeMs, 0, this.durationMs);
    this.lastFollowTimeMs = this.currentTimeMs;
    this.previewTimeMs = Number.isFinite(previewTimeMs) && previewTimeMs > 0 ? previewTimeMs : -1;
    this.kiaiSections = buildKiaiSections(mapData?.timingControlPoints);
    this.breaks = normaliseBreaks(mapData?.breaks);
    this.timingSections = buildTimingSections(mapData?.timingControlPoints);
    this.setObjects(mapData?.objects);
    this.densityMorph = null;
    this.songEndMs = null;
    this.isFollowSuspended = false;
    this.resetZoom({ animate: false });
    this.overviewReveal = 0;
  }

  /**
   * The objects alone, for the same map converted again (a mania key count
   * change): the view, the zoom and the song's end all stay where they are.
   */
  setObjects(objects) {
    this.objects = Array.isArray(objects) ? objects : [];
    // The indices pointed into the old array; a mania key count change can
    // even give a different number of notes.
    this.selection.clear();
    this.prefixMaxEnd = buildPrefixMaxEndTimes(this.objects);
    this.maxObjectDurationMs = 0;
    this.lastObjectEndMs = 0;
    for (const object of this.objects) {
      const time = Number.isFinite(object?.time) ? object.time : 0;
      const endTime = Number.isFinite(object?.endTime) ? Math.max(time, object.endTime) : time;
      this.maxObjectDurationMs = Math.max(this.maxObjectDurationMs, endTime - time);
      this.lastObjectEndMs = Math.max(this.lastObjectEndMs, endTime);
    }
    this.fullDensity = null;
    this.viewDensityCache = null;
  }

  /**
   * Another difficulty of the same song in place of the one shown, for the
   * difficulty in focus while several are compared: its objects, breaks, kiai
   * and timing. The view, the zoom, the playhead and the song's length all stay
   * where they are, since the song has not changed. The selection goes, as its
   * indices pointed into the other map.
   *
   * With `animate` the density bars grow and shrink from the old map's heights
   * to the new one's instead of jumping; nothing else moves.
   */
  showMap(mapData, { animate = false, now = performance.now() } = {}) {
    const objects = Array.isArray(mapData?.objects) ? mapData.objects : [];
    if (objects === this.objects) {
      return;
    }
    // If another morph is still mid-flight, advance its progress to `now` and
    // carry it as the re-based starting point so rapid switches ease smoothly
    // instead of snapping.
    let priorMorph = null;
    if (animate && this.densityMorph) {
      const elapsed = clamp((now - this.densityMorph.startTime) / DENSITY_MORPH_MS, 0, 1);
      if (elapsed < 1) {
        priorMorph = {
          from: this.densityMorph.from,
          progress: easeOutCubic(elapsed),
        };
      }
    }
    // The old map's bars, cached as they were, are where the morph starts.
    const from = {
      objects: this.objects,
      fullDensity: this.fullDensity,
      viewDensityCache: this.viewDensityCache,
      priorMorph: priorMorph ? { from: { ...priorMorph.from, priorMorph: null }, progress: priorMorph.progress } : null,
    };
    this.kiaiSections = buildKiaiSections(mapData?.timingControlPoints);
    this.breaks = normaliseBreaks(mapData?.breaks);
    this.timingSections = buildTimingSections(mapData?.timingControlPoints);
    this.setObjects(objects);
    this.densityMorph = animate && from.objects.length > 0
      ? { from, startTime: now, progress: 0 }
      : null;
  }

  dispose() {
    this.objects = [];
    this.prefixMaxEnd = null;
    this.kiaiSections = [];
    this.breaks = [];
    this.timingSections = [];
    this.fullDensity = null;
    this.viewDensityCache = null;
    this.densityMorph = null;
    this.durationAnimation = null;
    this.selection.clear();
  }

  isDensityMorphing() {
    return Boolean(this.densityMorph);
  }

  getVisualDuration(now = performance.now()) {
    if (!this.durationAnimation) {
      return this.visualDurationMs || this.durationMs || 1;
    }

    const progress = clamp(
      (now - this.durationAnimation.startTime) / this.durationAnimation.durationMs,
      0,
      1,
    );
    if (progress >= 1) {
      this.visualDurationMs = this.durationAnimation.to;
      this.durationAnimation = null;
      return this.visualDurationMs;
    }

    this.visualDurationMs = this.durationAnimation.from
      + ((this.durationAnimation.to - this.durationAnimation.from) * easeOutCubic(progress));
    return this.visualDurationMs;
  }

  /**
   * The full track arriving makes the map longer; the unzoomed timeline grows
   * into the new length rather than jumping. Returns whether it is animating.
   */
  setDuration(durationMs, { animate = false } = {}) {
    const nextDurationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 1) : 1;
    const currentVisualDurationMs = this.getVisualDuration();
    const previousDurationMs = this.durationMs;
    this.durationMs = nextDurationMs;
    this.currentTimeMs = clamp(this.currentTimeMs, 0, nextDurationMs);
    this.lastFollowTimeMs = this.currentTimeMs;
    if (nextDurationMs !== previousDurationMs) {
      this.fullDensity = null;
      this.viewDensityCache = null;
      if (this.densityMorph) {
        this.densityMorph.from.fullDensity = null;
        this.densityMorph.from.viewDensityCache = null;
        if (this.densityMorph.from.priorMorph?.from) {
          this.densityMorph.from.priorMorph.from.fullDensity = null;
          this.densityMorph.from.priorMorph.from.viewDensityCache = null;
        }
      }
      if (!this.fitsMap) {
        if (this.target.durationMs >= nextDurationMs) {
          this.resetZoom({ animate: false });
        } else {
          this.target = clampView(this.target.startMs, this.target.durationMs, nextDurationMs);
          this.view = clampView(this.view.startMs, this.view.durationMs, nextDurationMs);
        }
      }
    }

    if (animate && nextDurationMs > currentVisualDurationMs) {
      this.visualDurationMs = currentVisualDurationMs;
      this.durationAnimation = {
        startTime: performance.now(),
        durationMs: DURATION_GROW_MS,
        from: currentVisualDurationMs,
        to: nextDurationMs,
      };
      return true;
    }

    if (
      this.durationAnimation
      && nextDurationMs === previousDurationMs
      && this.durationAnimation.to === nextDurationMs
    ) {
      return true;
    }

    this.visualDurationMs = nextDurationMs;
    this.durationAnimation = null;
    return false;
  }

  isDurationAnimating() {
    return Boolean(this.durationAnimation);
  }

  /** True while anything on the timeline is still moving on its own. */
  needsAnimationFrame() {
    return Boolean(this.durationAnimation)
      || Boolean(this.densityMorph)
      || this.isViewEasing
      || this.overviewReveal !== (this.fitsMap ? 0 : 1);
  }

  setTime(ms) {
    const previousMs = this.currentTimeMs;
    this.currentTimeMs = clamp(Number.isFinite(ms) ? ms : 0, 0, this.durationMs || 1);
    const deltaMs = this.currentTimeMs - previousMs;
    // Anything but playback moving the clock is a seek, and a seek brings a
    // zoomed view back to the playhead.
    const isJump = this.isPlaying ? (deltaMs < -40 || deltaMs > 500) : deltaMs !== 0;
    if (isJump && !this.isInteracting) {
      this.isFollowSuspended = false;
    }
  }

  setPlaying(isPlaying) {
    if (isPlaying && !this.isPlaying) {
      this.isFollowSuspended = false;
    }
    this.isPlaying = Boolean(isPlaying);
  }

  /** While a drag is in progress the view is the user's, not the playhead's. */
  setInteracting(isInteracting) {
    this.isInteracting = Boolean(isInteracting);
  }

  setHoverX(x) {
    this.hoverX = Number.isFinite(x) ? x : null;
  }

  /** The song's length in map time, once known; null falls back to the last object. */
  setSongEnd(ms) {
    this.songEndMs = Number.isFinite(ms) && ms > 0 ? ms : null;
  }

  /** Where the end line goes, or null on a map with nothing in it. */
  getEndMs() {
    const endMs = this.songEndMs ?? this.lastObjectEndMs;
    return endMs > 0 ? Math.min(endMs, this.durationMs) : null;
  }

  isZoomed() {
    return !this.fitsMap;
  }

  isViewAnimating() {
    return this.isViewEasing;
  }

  /** The stretch of the map on screen right now. */
  getView() {
    const { startMs, durationMs } = this.view;
    return { startMs, durationMs, endMs: startMs + durationMs };
  }

  /** Where the view is heading; the base every wheel step builds on. */
  getTargetView() {
    if (this.fitsMap) {
      return { startMs: 0, durationMs: this.durationMs, endMs: this.durationMs };
    }
    const { startMs, durationMs } = this.target;
    return { startMs, durationMs, endMs: startMs + durationMs };
  }

  getMsPerPx() {
    return this.view.durationMs / Math.max(1, this.width);
  }

  setView(startMs, durationMs, { animate = true } = {}) {
    if (!(durationMs < this.durationMs)) {
      this.fitsMap = true;
      this.target = { startMs: 0, durationMs: this.durationMs };
    } else {
      this.fitsMap = false;
      this.target = clampView(startMs, durationMs, this.durationMs);
    }

    if (animate) {
      this.isViewEasing = true;
    } else {
      this.view = this.fitsMap
        ? { startMs: 0, durationMs: this.getVisualDuration() }
        : { ...this.target };
      this.isViewEasing = false;
    }
  }

  resetZoom({ animate = true } = {}) {
    this.setView(0, Infinity, { animate });
  }

  zoomAt(anchorMs, factor, anchorRatio, { animate = true } = {}) {
    const next = zoomView(this.getTargetView(), this.durationMs, anchorMs, factor, anchorRatio);
    this.setView(next.startMs, next.durationMs, { animate });
    this.noteManualMove();
  }

  /** Zooms keeping the playhead where it is on screen, or centred if it is off it. */
  zoomAroundPlayhead(factor) {
    const { startMs, durationMs } = this.getTargetView();
    const ratio = (this.currentTimeMs - startMs) / durationMs;
    this.zoomAt(this.currentTimeMs, factor, ratio >= 0 && ratio <= 1 ? ratio : 0.5);
    this.resumeFollow();
  }

  panBy(deltaMs, { animate = true } = {}) {
    if (this.fitsMap || !Number.isFinite(deltaMs)) {
      return;
    }
    this.setView(this.target.startMs + deltaMs, this.target.durationMs, { animate });
    this.noteManualMove();
  }

  setViewStart(startMs, { animate = true } = {}) {
    if (this.fitsMap) {
      return;
    }
    this.setView(startMs, this.target.durationMs, { animate });
    this.noteManualMove();
  }

  resumeFollow() {
    this.isFollowSuspended = false;
  }

  // Following stops once the user moves the playhead off screen themselves;
  // keeping it in view lets the view carry on following it.
  noteManualMove() {
    const { startMs, endMs } = this.getTargetView();
    this.isFollowSuspended = !this.fitsMap
      && (this.currentTimeMs < startMs || this.currentTimeMs > endMs);
  }

  timeAtX(x) {
    const { startMs, durationMs } = this.view;
    return clamp(startMs + (clamp(x / Math.max(1, this.width), 0, 1) * durationMs), 0, this.durationMs);
  }

  /** How solidly the objects are drawn at this zoom, 0 to 1. */
  getObjectMix() {
    return 1 - smoothstep(OBJECTS_SHOWN_MS_PER_PX, DENSITY_SHOWN_MS_PER_PX, this.getMsPerPx());
  }

  /** Whether the objects are on screen enough to be aimed at. */
  areObjectsGrabbable() {
    return this.objects.length > 0 && this.getObjectMix() >= OBJECTS_GRABBABLE_MIX;
  }

  /**
   * The object under `x`, or -1.
   *
   * The head is what is being aimed at, so the nearest one within the grab
   * radius wins. `includeBodies` also accepts a hit anywhere along a slider,
   * hold or spinner, which is right for picking one out but not for snapping:
   * dragging the middle of a ten-second spinner should not fling the playhead
   * back to its start.
   */
  objectIndexAtX(x, { includeBodies = false } = {}) {
    if (!this.areObjectsGrabbable()) {
      return -1;
    }

    const objects = this.objects;
    const timeMs = this.timeAtX(x);
    const toleranceMs = OBJECT_GRAB_PX * this.getMsPerPx();
    let nearest = -1;
    let nearestDistanceMs = Infinity;
    let covering = -1;

    // When checking heads only, no object starting before timeMs - toleranceMs
    // can match. When checking bodies too, prefixMaxEnd bounds the earliest
    // object whose endTime can still reach timeMs - toleranceMs in O(log N).
    const from = includeBodies && this.prefixMaxEnd
      ? findFirstIndexWithEndAtOrAfter(this.prefixMaxEnd, timeMs - toleranceMs)
      : findFirstIndexAtOrAfter(objects, timeMs - toleranceMs);
    for (let index = from; index < objects.length; index += 1) {
      const time = Number(objects[index]?.time);
      if (!Number.isFinite(time)) {
        continue;
      }
      if (time > timeMs + toleranceMs) {
        break;
      }
      const distanceMs = Math.abs(time - timeMs);
      if (distanceMs <= toleranceMs && distanceMs < nearestDistanceMs) {
        nearest = index;
        nearestDistanceMs = distanceMs;
      }
      if (includeBodies && time <= timeMs) {
        const endTime = Number(objects[index].endTime);
        // The latest one that is still running wins, which is the one drawn
        // on top of any it overlaps.
        if (Number.isFinite(endTime) && endTime >= timeMs) {
          covering = index;
        }
      }
    }

    return nearest >= 0 ? nearest : covering;
  }

  /**
   * The time at `x`, pulled onto a nearby object once they are drawn: at that
   * zoom the marks are what the pointer is aiming at, and landing a frame off
   * one is never what was meant.
   */
  snapTimeAtX(x) {
    const index = this.objectIndexAtX(x);
    const timeMs = this.timeAtX(x);
    if (index < 0) {
      return timeMs;
    }
    return clamp(Number(this.objects[index].time), 0, this.durationMs);
  }

  /** @param indices anything iterable of indices into `objects`. */
  setSelection(indices) {
    const next = new Set();
    for (const index of indices || []) {
      if (Number.isInteger(index) && index >= 0 && index < this.objects.length) {
        next.add(index);
      }
    }
    this.selection = next;
  }

  clearSelection() {
    this.selection.clear();
  }

  hasSelection() {
    return this.selection.size > 0;
  }

  getSelectedIndices() {
    return [...this.selection].sort((a, b) => a - b);
  }

  /** The selected objects in time order, which is the order a timestamp lists them. */
  getSelectedObjects() {
    return this.getSelectedIndices().map((index) => this.objects[index]).filter(Boolean);
  }

  overviewTimeAtX(x) {
    return clamp(x / Math.max(1, this.width), 0, 1) * this.getVisualDuration();
  }

  /** 'overview' for the rail a zoomed timeline shows along its bottom, else 'track'. */
  regionAt(y) {
    return this.overviewReveal > 0.5 && y >= this.layout.overviewTop - OVERVIEW_HIT_SLOP_PX ? 'overview' : 'track';
  }

  /** The visible window's span on the overview strip, in CSS pixels. */
  getOverviewBracket() {
    const totalMs = this.getVisualDuration();
    const { startMs, durationMs } = this.view;
    let x0 = (startMs / totalMs) * this.width;
    let x1 = ((startMs + durationMs) / totalMs) * this.width;
    if (x1 - x0 < MIN_BRACKET_WIDTH_PX) {
      const half = MIN_BRACKET_WIDTH_PX / 2;
      const middle = clamp((x0 + x1) / 2, half, Math.max(half, this.width - half));
      x0 = Math.max(0, middle - half);
      x1 = Math.min(this.width, x0 + MIN_BRACKET_WIDTH_PX);
    } else {
      x0 = clamp(x0, 0, this.width);
      x1 = clamp(x1, x0, this.width);
    }
    return { x0, x1 };
  }

  formatTimeAtX(x) {
    return this.formatTimeAtMs(this.timeAtX(x));
  }

  /** The same readout, for a time worked out some other way (a snapped one). */
  formatTimeAtMs(timeMs) {
    return formatTimelineTime(timeMs, getReadoutDecimals(this.getMsPerPx()));
  }

  step(now) {
    const dt = this.lastStepAt === null ? 0 : clamp(now - this.lastStepAt, 0, MAX_STEP_MS);
    this.lastStepAt = now;
    const visualDurationMs = this.getVisualDuration(now);

    this.applyFollow(dt);

    const goal = this.fitsMap ? { startMs: 0, durationMs: visualDurationMs } : this.target;
    if (!this.isViewEasing) {
      this.view = { startMs: goal.startMs, durationMs: goal.durationMs };
    } else if (dt > 0) {
      // Start and end ease separately: the moment under the pointer stays put
      // through a zoom, because both edges close in on it in proportion.
      const ease = 1 - Math.exp(-dt / VIEW_EASE_MS);
      const goalEndMs = goal.startMs + goal.durationMs;
      const viewEndMs = this.view.startMs + this.view.durationMs;
      const startMs = this.view.startMs + ((goal.startMs - this.view.startMs) * ease);
      const endMs = viewEndMs + ((goalEndMs - viewEndMs) * ease);
      const toleranceMs = (goal.durationMs / Math.max(1, this.width)) * 0.25;
      if (Math.abs(goal.startMs - startMs) < toleranceMs && Math.abs(goalEndMs - endMs) < toleranceMs) {
        this.view = { startMs: goal.startMs, durationMs: goal.durationMs };
        this.isViewEasing = false;
      } else {
        this.view = { startMs, durationMs: endMs - startMs };
      }
    }

    if (this.densityMorph) {
      const progress = (now - this.densityMorph.startTime) / DENSITY_MORPH_MS;
      if (progress >= 1) {
        this.densityMorph = null;
      } else {
        this.densityMorph.progress = easeOutCubic(progress);
      }
    }

    const revealGoal = this.fitsMap ? 0 : 1;
    if (this.overviewReveal !== revealGoal && dt > 0) {
      this.overviewReveal += (revealGoal - this.overviewReveal) * (1 - Math.exp(-dt / REVEAL_EASE_MS));
      if (Math.abs(revealGoal - this.overviewReveal) < 0.01) {
        this.overviewReveal = revealGoal;
      }
    }
  }

  applyFollow(dt) {
    const timeMs = this.currentTimeMs;
    const advanceMs = timeMs - this.lastFollowTimeMs;
    this.lastFollowTimeMs = timeMs;
    if (this.fitsMap || this.isInteracting || this.isFollowSuspended) {
      return;
    }

    const { startMs, durationMs } = this.view;
    const ratio = (timeMs - startMs) / durationMs;
    // Only while the playhead is actually moving: a stalled or paused clock
    // must not drag the view to it.
    if (this.isPlaying && advanceMs > 0 && ratio > FOLLOW_RATIO && ratio <= 1) {
      // Moves with the playhead, plus a share of any lead it built up, so a
      // view that was just zoomed glides into place instead of jumping.
      const surplusMs = timeMs - (startMs + (FOLLOW_RATIO * durationMs));
      const stepMs = Math.max(0, advanceMs);
      const catchUp = 1 - Math.exp(-dt / FOLLOW_CATCH_UP_MS);
      this.shiftView(Math.min(surplusMs, stepMs + (Math.max(0, surplusMs - stepMs) * catchUp)));
      return;
    }

    if (ratio < 0 || ratio > 1) {
      const returnRatio = this.isPlaying ? FOLLOW_RETURN_RATIO : 0.5;
      this.target = clampView(
        timeMs - (returnRatio * this.target.durationMs),
        this.target.durationMs,
        this.durationMs,
      );
      this.isViewEasing = true;
    }
  }

  shiftView(deltaMs) {
    if (!(deltaMs > 0)) {
      return;
    }
    this.target.startMs = clamp(this.target.startMs + deltaMs, 0, this.durationMs - this.target.durationMs);
    this.view.startMs = clamp(this.view.startMs + deltaMs, 0, Math.max(0, this.durationMs - this.view.durationMs));
  }

  /**
   * `source` is whatever holds the objects and their caches: the timeline for
   * the map shown, or the map a morph is leaving.
   */
  getFullDensity(binCount, source = this) {
    if (source.fullDensity?.binCount === binCount) {
      return source.fullDensity;
    }
    const bins = countObjectsIntoBins(source.objects, 0, this.durationMs, new Float32Array(binCount));
    let maxCount = 0;
    for (let i = 0; i < bins.length; i += 1) {
      if (bins[i] > maxCount) maxCount = bins[i];
    }
    if (maxCount > 0) {
      const invMax = 1 / maxCount;
      for (let i = 0; i < bins.length; i += 1) {
        bins[i] *= invMax;
      }
    }
    source.fullDensity = {
      binCount,
      bins,
      // Objects per ms in the busiest bar of the whole map. Zoomed-in bars are
      // measured against it, so they keep their height as the view pans.
      maxRate: maxCount / (this.durationMs / binCount),
    };
    return source.fullDensity;
  }

  getViewDensity(startMs, durationMs, binCount, source = this) {
    const full = this.getFullDensity(binCount, source);
    const binDurationMs = durationMs / binCount;
    if (startMs <= 0 && Math.abs(durationMs - this.durationMs) < 0.5) {
      return { bins: full.bins, firstBinIndex: 0, binDurationMs };
    }
    // Keep bin boundaries attached to map time while the viewport moves.
    // Snapping around integer boundaries avoids adding a zero-width edge bin
    // when floating point easing lands a few ulps either side of a boundary.
    const firstBinIndex = Math.floor((startMs / binDurationMs) + 1e-9);
    const endBinIndex = Math.ceil(((startMs + durationMs) / binDurationMs) - 1e-9);
    const visibleBinCount = Math.max(1, endBinIndex - firstBinIndex);

    const cached = source.viewDensityCache;
    if (
      cached
      && cached.firstBinIndex === firstBinIndex
      && cached.binDurationMs === binDurationMs
      && cached.bins.length === visibleBinCount
    ) {
      return cached;
    }
    const bins = countObjectsIntoAlignedBins(
      source.objects,
      firstBinIndex,
      binDurationMs,
      cached?.bins.length === visibleBinCount ? cached.bins : new Float32Array(visibleBinCount),
    );
    const scale = full.maxRate > 0 ? 1 / (binDurationMs * full.maxRate) : 0;
    for (let index = 0; index < visibleBinCount; index += 1) {
      bins[index] = Math.min(1, bins[index] * scale);
    }
    source.viewDensityCache = { firstBinIndex, binDurationMs, bins };
    return source.viewDensityCache;
  }

  render(now = performance.now()) {
    const { ctx, width, height } = getCanvasContext(this.canvas, { transparent: true });
    this.width = width;
    this.height = height;
    this.step(now);
    const layout = computeLayout(width, height, this.overviewReveal);
    this.layout = layout;

    const { startMs, durationMs } = this.view;
    const endMs = startMs + durationMs;
    const msPerPx = durationMs / width;
    const toX = (timeMs) => (timeMs - startMs) / msPerPx;
    const playheadX = toX(this.currentTimeMs);

    ctx.clearRect(0, 0, width, height);

    this.drawBreaks(ctx, layout, toX, startMs, endMs);
    this.drawKiai(ctx, layout, toX, startMs, endMs, false);
    const visibleSections = this.getVisibleTimingSections(startMs, endMs);
    const beatGridStrength = this.drawBeatGrid(ctx, layout, toX, startMs, endMs, msPerPx, visibleSections);
    const ruler = this.buildRuler(startMs, endMs, msPerPx, toX, visibleSections);
    this.drawTimeGrid(ctx, layout, ruler.xs, 1 - beatGridStrength);

    const objectMix = 1 - smoothstep(OBJECTS_SHOWN_MS_PER_PX, DENSITY_SHOWN_MS_PER_PX, msPerPx);
    if (objectMix < 1) {
      this.drawDensity(ctx, layout, startMs, durationMs, playheadX, 1 - objectMix);
    }
    if (objectMix > 0) {
      this.drawObjects(ctx, layout, toX, startMs, endMs, objectMix);
    }

    this.drawKiai(ctx, layout, toX, startMs, endMs, true);
    this.drawPreviewMarker(ctx, layout, toX);
    this.drawTicks(ctx, layout, ruler.xs);
    this.drawEndMarker(ctx, layout, toX, startMs, endMs);

    if (this.hoverX !== null && !this.isInteracting && this.hoverX >= 0 && this.hoverX <= width) {
      ctx.fillStyle = COLOURS.hover;
      ctx.fillRect(Math.round(this.hoverX), 0, 1, layout.trackBottom);
    }

    this.drawPlayhead(ctx, layout, playheadX);

    if (this.overviewReveal > 0.01) {
      this.drawOverview(ctx, layout);
    }
  }

  drawBreaks(ctx, layout, toX, startMs, endMs) {
    let hasVisible = false;
    for (const period of this.breaks) {
      if (period.endMs > startMs && period.startMs < endMs) {
        hasVisible = true;
        break;
      }
    }
    if (!hasVisible) {
      return;
    }
    const top = layout.trackTop;
    const bottom = layout.trackBottom;
    ctx.save();
    ctx.beginPath();
    for (const period of this.breaks) {
      if (period.endMs <= startMs || period.startMs >= endMs) {
        continue;
      }
      const x0 = Math.max(0, toX(period.startMs));
      const x1 = Math.min(layout.width, toX(period.endMs));
      ctx.rect(x0, top, x1 - x0, bottom - top);
    }
    ctx.clip();
    // Diagonal hatching, anchored to the map rather than the screen so it
    // slides along with a pan instead of shimmering.
    const spacing = 5;
    const height = bottom - top;
    const offset = ((toX(0) % spacing) + spacing) % spacing;
    ctx.beginPath();
    for (let x = offset - height; x < layout.width; x += spacing) {
      ctx.moveTo(x, bottom);
      ctx.lineTo(x + height, top);
    }
    ctx.strokeStyle = COLOURS.breakHatch;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  drawKiai(ctx, layout, toX, startMs, endMs, edgesOnly) {
    for (const section of this.kiaiSections) {
      if (section.endMs <= startMs || section.startMs >= endMs) {
        continue;
      }
      const x0 = Math.max(0, toX(section.startMs));
      const x1 = Math.min(layout.width, toX(section.endMs));
      if (edgesOnly) {
        ctx.fillStyle = COLOURS.kiaiEdge;
        ctx.fillRect(x0, layout.trackTop, x1 - x0, 1.5);
      } else {
        ctx.fillStyle = COLOURS.kiaiFill;
        ctx.fillRect(x0, layout.trackTop, x1 - x0, layout.trackBottom - layout.trackTop);
      }
    }
  }

  // Bar and beat lines from the map's own timing, once they are far enough
  // apart to read. Returns how strongly the grid showed, 0 to 1.
  /**
   * The map's own grid: a line per bar, and per beat once they are far enough
   * apart to read.
   *
   * @returns how far the grid has faded in, which is also how far the fainter
   *   full-height ruler lines fade out behind it.
   */
  /**
   * Each uninherited timing section that overlaps the view, clipped to it.
   * Shared by the beat grid and the ruler so the two can never disagree about
   * where a tempo starts.
   */
  getVisibleTimingSections(startMs, endMs) {
    const sections = this.timingSections;
    const visible = [];
    if (sections.length === 0) {
      return visible;
    }
    let index = Math.max(0, findLastIndexAtOrBefore(sections, startMs, getSectionTime));
    for (; index < sections.length; index += 1) {
      const section = sections[index];
      const sectionEndMs = index + 1 < sections.length ? sections[index + 1].time : Infinity;
      // The first timing point's grid also runs back to the start of the map.
      const fromMs = Math.max(startMs, index === 0 ? -Infinity : section.time);
      const toMs = Math.min(endMs, sectionEndMs);
      if (fromMs > endMs) {
        break;
      }
      if (toMs <= fromMs) {
        continue;
      }
      visible.push({ section, fromMs, toMs });
    }
    return visible;
  }

  drawBeatGrid(ctx, layout, toX, startMs, endMs, msPerPx, visibleSections = null) {
    // Pairs of x and opacity, drawn after the walk so each kind is one batch.
    const barLines = [];
    const beatLines = [];
    let strength = 0;
    let totalLines = 0;
    const sections = visibleSections ?? this.getVisibleTimingSections(startMs, endMs);
    for (const { section, fromMs, toMs } of sections) {
      const barMs = section.beatLength * section.meter;
      if (!Number.isFinite(barMs) || !(barMs > 0)) {
        continue;
      }
      const beatPx = section.beatLength / msPerPx;
      const barPx = barMs / msPerPx;
      const barStrength = clamp((barPx - MIN_BAR_SPACING_PX) / 20, 0, 1);
      if (barStrength <= 0) {
        continue;
      }
      strength = Math.max(strength, barStrength);
      const showBeats = beatPx >= MIN_BEAT_SPACING_PX;
      const beatStepCount = showBeats ? 1 : section.meter;
      let beat = Math.ceil(((fromMs - section.time) / section.beatLength) - 1e-6);
      if (!showBeats) {
        beat = Math.ceil(beat / section.meter) * section.meter;
      }
      for (; totalLines < MAX_MEASURE_LINES; beat += beatStepCount) {
        const timeMs = section.time + (beat * section.beatLength);
        if (!Number.isFinite(timeMs) || timeMs >= toMs) {
          break;
        }
        if (((beat % section.meter) + section.meter) % section.meter === 0) {
          barLines.push(Math.round(toX(timeMs)), barStrength);
        } else {
          beatLines.push(Math.round(toX(timeMs)), clamp((beatPx - MIN_BEAT_SPACING_PX) / 8, 0, 1));
        }
        totalLines += 1;
        if (!(beat + beatStepCount > beat)) {
          break;
        }
      }
    }

    const top = layout.trackTop;
    const bottom = layout.trackBottom;
    const inset = (bottom - top) * 0.28;
    ctx.fillStyle = COLOURS.gridLine;
    for (let index = 0; index < barLines.length; index += 2) {
      ctx.globalAlpha = 0.2 * barLines[index + 1];
      ctx.fillRect(barLines[index], top, 1, bottom - top);
    }
    for (let index = 0; index < beatLines.length; index += 2) {
      ctx.globalAlpha = 0.11 * beatLines[index + 1];
      ctx.fillRect(beatLines[index], top + inset, 1, bottom - top - (inset * 2));
    }
    ctx.globalAlpha = 1;
    return strength;
  }

  /**
   * Where the marks along the timeline go at this zoom -- the ticks on the top
   * edge and the faint full-height lines behind them, which are one ruler
   * drawn twice.
   *
   * Always the map's own bars, grouped in whatever power of two keeps them far
   * enough apart to read: every bar zoomed right in, then every two, four,
   * eight as the view widens. Phrases are written in those groupings, so a
   * coarse ruler still lands where the music does -- which round seconds,
   * sharing no factor with the tempo or the offset, never do.
   *
   * Only a map with no timing at all falls back to the clock, there being no
   * beat to count from.
   */
  buildRuler(startMs, endMs, msPerPx, toX, visibleSections = null) {
    const xs = [];
    const sections = visibleSections ?? this.getVisibleTimingSections(startMs, endMs);

    if (sections.length > 0) {
      for (const { section, fromMs, toMs } of sections) {
        const barMs = section.beatLength * section.meter;
        if (!Number.isFinite(barMs) || !(barMs > 0)) {
          continue;
        }
        let stepMs = barMs;
        while (Number.isFinite(stepMs) && stepMs / msPerPx < MIN_TICK_SPACING_PX) {
          stepMs *= 2;
        }
        if (!Number.isFinite(stepMs) || !(stepMs > 0)) {
          continue;
        }
        // Counted from the section's own start, so every mark is a downbeat
        // of the tempo in force rather than of the one before it.
        let index = Math.ceil(((fromMs - section.time) / stepMs) - 1e-6);
        for (; xs.length < MAX_MEASURE_LINES; index += 1) {
          const timeMs = section.time + (index * stepMs);
          if (!Number.isFinite(timeMs) || timeMs >= toMs) {
            break;
          }
          xs.push(Math.round(toX(timeMs)));
          if (!(index + 1 > index)) {
            break;
          }
        }
      }
      return { xs, onBars: true };
    }

    const stepMs = pickTickStep(msPerPx);
    for (let index = Math.ceil(startMs / stepMs); index * stepMs <= endMs && xs.length < MAX_MEASURE_LINES; index += 1) {
      xs.push(Math.round(toX(index * stepMs)));
    }
    return { xs, onBars: false };
  }

  drawTimeGrid(ctx, layout, rulerXs, strength) {
    if (strength <= 0.01) {
      return;
    }
    ctx.fillStyle = COLOURS.gridLine;
    ctx.globalAlpha = 0.045 * strength;
    for (const x of rulerXs) {
      ctx.fillRect(x, layout.trackTop, 1, layout.trackBottom - layout.trackTop);
    }
    ctx.globalAlpha = 1;
  }

  drawDensity(ctx, layout, startMs, durationMs, playheadX, alpha) {
    const binCount = Math.max(24, Math.round(layout.width / DENSITY_BAR_PX));
    const density = this.getViewDensity(startMs, durationMs, binCount);
    const { bins, firstBinIndex, binDurationMs } = density;
    const barWidth = layout.width / binCount;
    const barWidthDrawn = Math.max(1, barWidth - 0.75);
    const middle = (layout.trackTop + layout.trackBottom) / 2;
    const maxHeight = Math.max(2, layout.trackBottom - layout.trackTop - 5);
    const msPerPx = durationMs / layout.width;
    const heightOf = (bin) => (bin > 0 ? Math.max(1, bin * maxHeight) : 0);
    // Mid-morph each bar is part way from the old map's height to the new
    // one's. Both maps are binned over the same view, so their bars line up.
    const morph = this.densityMorph;
    const fromBins = morph ? this.getViewDensity(startMs, durationMs, binCount, morph.from).bins : null;
    const priorMorph = morph?.from?.priorMorph ?? null;
    const priorFromBins = priorMorph
      ? this.getViewDensity(startMs, durationMs, binCount, priorMorph.from).bins
      : null;

    const traceBars = () => {
      ctx.beginPath();
      for (let index = 0; index < bins.length; index += 1) {
        let barHeight = heightOf(bins[index]);
        if (fromBins) {
          let fromHeight = heightOf(fromBins[index]);
          if (priorFromBins) {
            const priorHeight = heightOf(priorFromBins[index]);
            fromHeight = priorHeight + ((fromHeight - priorHeight) * priorMorph.progress);
          }
          barHeight = fromHeight + ((barHeight - fromHeight) * morph.progress);
        }
        if (barHeight <= 0) {
          continue;
        }
        const binStartMs = (firstBinIndex + index) * binDurationMs;
        const x = (binStartMs - startMs) / msPerPx;
        ctx.rect(x, middle - (barHeight / 2), barWidthDrawn, barHeight);
      }
    };

    ctx.globalAlpha = alpha;
    // Skip tracing/filling twice when the entire visible strip is already
    // played (playhead past right edge) or upcoming (playhead at/before left).
    if (playheadX >= layout.width) {
      traceBars();
      ctx.fillStyle = COLOURS.played;
      ctx.fill();
    } else {
      traceBars();
      ctx.fillStyle = COLOURS.upcoming;
      ctx.fill();
      if (playheadX > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, layout.trackTop, playheadX, layout.trackBottom - layout.trackTop);
        ctx.clip();
        traceBars();
        ctx.fillStyle = COLOURS.played;
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  drawObjects(ctx, layout, toX, startMs, endMs, alpha) {
    const objects = this.objects;
    if (objects.length === 0) {
      return;
    }
    const middle = (layout.trackTop + layout.trackBottom) / 2;
    const radius = clamp((layout.trackBottom - layout.trackTop - 5) * 0.24, 1.5, 3.5);
    const bodyHalf = radius * 0.72;
    const firstIndex = this.prefixMaxEnd
      ? findFirstIndexWithEndAtOrAfter(this.prefixMaxEnd, startMs)
      : findFirstIndexAtOrAfter(objects, startMs - this.maxObjectDurationMs);
    const playheadMs = this.currentTimeMs;

    ctx.globalAlpha = alpha;
    for (const played of [true, false]) {
      ctx.fillStyle = played ? COLOURS.played : COLOURS.upcoming;
      ctx.strokeStyle = ctx.fillStyle;
      const bodies = [];
      const heads = [];
      const spinners = [];
      for (let index = firstIndex; index < objects.length; index += 1) {
        const object = objects[index];
        const time = object?.time;
        if (!Number.isFinite(time)) {
          continue;
        }
        if (time > endMs) {
          break;
        }
        if ((time <= playheadMs) !== played) {
          continue;
        }
        const endTime = Number.isFinite(object.endTime) ? object.endTime : time;
        if (endTime < startMs) {
          continue;
        }
        const x0 = toX(time);
        if (object.kind === 'spinner') {
          spinners.push(x0, toX(endTime));
          continue;
        }
        if (endTime - time > 1) {
          bodies.push(x0, toX(endTime));
        }
        heads.push(x0);
      }

      // Draw translucent slider/hold bodies under filled heads so heads stay crisp.
      if (bodies.length > 0) {
        ctx.globalAlpha = alpha * 0.55;
        ctx.beginPath();
        for (let index = 0; index < bodies.length; index += 2) {
          traceCapsule(ctx, bodies[index], bodies[index + 1], middle, bodyHalf);
        }
        ctx.fill();
        ctx.globalAlpha = alpha;
      }
      if (heads.length > 0) {
        ctx.beginPath();
        for (let index = 0; index < heads.length; index += 1) {
          const x0 = heads[index];
          ctx.moveTo(x0 + radius, middle);
          ctx.arc(x0, middle, radius, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      if (spinners.length > 0) {
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        for (let index = 0; index < spinners.length; index += 2) {
          traceCapsule(ctx, spinners[index], spinners[index + 1], middle, radius - 0.6);
        }
        ctx.stroke();
      }
    }

    this.drawSelection(ctx, toX, startMs, endMs, middle, radius, bodyHalf, alpha);
    ctx.globalAlpha = 1;
  }

  /**
   * A ring around each picked object, drawn over the pass that laid them out
   * so it reads whether the object is played or still to come. What is ringed
   * here is what a copied timestamp will name.
   */
  drawSelection(ctx, toX, startMs, endMs, middle, radius, bodyHalf, alpha) {
    if (this.selection.size === 0) {
      return;
    }

    const bodies = [];
    const heads = [];
    const spinners = [];
    for (const index of this.selection) {
      const object = this.objects[index];
      const time = Number(object?.time);
      if (!Number.isFinite(time) || time > endMs) {
        continue;
      }
      const endTime = Number.isFinite(object.endTime) ? Math.max(time, object.endTime) : time;
      if (endTime < startMs) {
        continue;
      }
      const x0 = toX(time);
      if (object.kind === 'spinner') {
        spinners.push(x0, toX(endTime));
        continue;
      }
      heads.push(x0);
      if (endTime - time > 1) {
        bodies.push(x0, toX(endTime));
      }
    }
    if (heads.length === 0 && spinners.length === 0) {
      return;
    }

    if (bodies.length > 0) {
      ctx.globalAlpha = alpha * 0.5;
      ctx.fillStyle = COLOURS.selectedHalo;
      ctx.beginPath();
      for (let index = 0; index < bodies.length; index += 2) {
        traceCapsule(ctx, bodies[index], bodies[index + 1], middle, bodyHalf + 1);
      }
      ctx.fill();
    }

    ctx.globalAlpha = alpha;
    ctx.strokeStyle = COLOURS.selected;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const x of heads) {
      ctx.moveTo(x + radius + 1.5, middle);
      ctx.arc(x, middle, radius + 1.5, 0, Math.PI * 2);
    }
    for (let index = 0; index < spinners.length; index += 2) {
      traceCapsule(ctx, spinners[index], spinners[index + 1], middle, radius + 1.5);
    }
    ctx.stroke();
  }

  // The beatmap's preview point: a line with a small flag at its top.
  drawPreviewMarker(ctx, layout, toX) {
    const x = Math.round(toX(this.previewTimeMs));
    if (this.previewTimeMs < 0 || x < -6 || x > layout.width + 1) {
      return;
    }
    ctx.fillStyle = COLOURS.preview;
    ctx.fillRect(x - 0.5, layout.trackTop, 1.5, layout.trackBottom - layout.trackTop);
    ctx.beginPath();
    ctx.moveTo(x, layout.trackTop);
    ctx.lineTo(x + 4, layout.trackTop + 2.5);
    ctx.lineTo(x, layout.trackTop + 5);
    ctx.closePath();
    ctx.fill();
  }

  // Short marks hanging from the top edge, on the ruler buildRuler laid out.
  drawTicks(ctx, layout, rulerXs) {
    ctx.fillStyle = COLOURS.tick;
    for (const x of rulerXs) {
      ctx.fillRect(x, layout.trackTop, 1, TICK_HEIGHT_PX);
    }
  }

  // A faint line where the song (or, without the full track, the last object)
  // ends, with what is left of the timeline past it shaded a touch, so the end
  // can be found even zoomed in.
  drawEndMarker(ctx, layout, toX, startMs, endMs) {
    const songEndMs = this.getEndMs();
    if (songEndMs === null || songEndMs > endMs) {
      return;
    }
    const height = layout.trackBottom - layout.trackTop;
    if (songEndMs < startMs) {
      // The entire visible stretch is past the song end: keep the shading.
      ctx.fillStyle = COLOURS.pastEnd;
      ctx.fillRect(0, layout.trackTop, layout.width, height);
      return;
    }
    // A song that runs to the timeline's end would land just off the canvas.
    const x = Math.min(Math.round(toX(songEndMs)), layout.width - 1);
    if (x + 1 < layout.width) {
      ctx.fillStyle = COLOURS.pastEnd;
      ctx.fillRect(x + 1, layout.trackTop, layout.width - x - 1, height);
    }
    ctx.fillStyle = COLOURS.endLine;
    ctx.fillRect(x, layout.trackTop, 1, height);
  }

  drawPlayhead(ctx, layout, x) {
    if (x < -5 || x > layout.width + 5) {
      return;
    }
    const left = Math.round(x) - 1;
    ctx.fillStyle = COLOURS.playheadHalo;
    ctx.fillRect(left - 1, 0, 4, layout.trackBottom);
    ctx.fillStyle = COLOURS.playhead;
    ctx.fillRect(left, 0, 2, layout.trackBottom);
    ctx.beginPath();
    ctx.moveTo(left - 2.5, 0);
    ctx.lineTo(left + 4.5, 0);
    ctx.lineTo(left + 1, 3.5);
    ctx.closePath();
    ctx.fill();
  }

  // The whole map as a rail, with the visible stretch picked out on it.
  drawOverview(ctx, layout) {
    const { width } = layout;
    const top = layout.overviewTop;
    const height = OVERVIEW_HEIGHT_PX;
    const totalMs = this.getVisualDuration();
    const toOverviewX = (timeMs) => (timeMs / totalMs) * width;

    // Four pixels hold the rail, the visible stretch and the playhead, and
    // nothing else: markers on it only read as noise at this size.
    ctx.globalAlpha = this.overviewReveal;
    ctx.fillStyle = COLOURS.rail;
    ctx.fillRect(0, top, width, height);

    const { x0, x1 } = this.getOverviewBracket();
    ctx.fillStyle = COLOURS.bracket;
    ctx.beginPath();
    traceCapsule(ctx, x0, x1, top + (height / 2), height / 2);
    ctx.fill();

    ctx.fillStyle = COLOURS.playhead;
    ctx.fillRect(Math.round(toOverviewX(this.currentTimeMs)) - 0.5, top, 1.5, height);
    ctx.globalAlpha = 1;
  }
}

export {
  MIN_VIEW_MS,
  TimelineRenderer,
  clampView,
  countObjectsIntoBins,
  formatTimelineTime,
  getReadoutDecimals,
  pickTickStep,
  zoomView,
};
