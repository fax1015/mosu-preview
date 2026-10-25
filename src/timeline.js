import { clamp, findFirstIndexAtOrAfter } from './core/math.js';
import { getCanvasContext } from './core/canvas.js';

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

const buildTimingSections = (controlPoints) => (
  Array.isArray(controlPoints)
    ? controlPoints
      .filter((point) => point?.uninherited && Number.isFinite(point.time) && point.beatLength > 0)
      .map((point) => ({
        time: point.time,
        beatLength: point.beatLength,
        meter: Number.isInteger(point.meter) && point.meter > 0 ? point.meter : 4,
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
  }

  setBeatmap(mapData, durationMs, { previewTimeMs = -1 } = {}) {
    this.objects = Array.isArray(mapData?.objects) ? mapData.objects : [];
    this.durationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 1) : 1;
    this.visualDurationMs = this.durationMs;
    this.durationAnimation = null;
    this.previewTimeMs = Number.isFinite(previewTimeMs) && previewTimeMs > 0 ? previewTimeMs : -1;
    this.kiaiSections = buildKiaiSections(mapData?.timingControlPoints);
    this.breaks = normaliseBreaks(mapData?.breaks);
    this.timingSections = buildTimingSections(mapData?.timingControlPoints);
    // Objects are sorted by start time but may overlap, so finding the ones on
    // screen has to look back by the longest of them.
    this.maxObjectDurationMs = 0;
    this.lastObjectEndMs = 0;
    for (const object of this.objects) {
      const time = Number(object?.time) || 0;
      const endTime = Number(object?.endTime) || time;
      this.maxObjectDurationMs = Math.max(this.maxObjectDurationMs, endTime - time);
      this.lastObjectEndMs = Math.max(this.lastObjectEndMs, endTime);
    }
    this.songEndMs = null;
    this.fullDensity = null;
    this.viewDensityCache = null;
    this.isFollowSuspended = false;
    this.resetZoom({ animate: false });
    this.overviewReveal = 0;
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
    if (nextDurationMs !== previousDurationMs) {
      this.fullDensity = null;
      this.viewDensityCache = null;
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
    const { startMs, durationMs } = this.view;
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
      const middle = (x0 + x1) / 2;
      x0 = middle - (MIN_BRACKET_WIDTH_PX / 2);
      x1 = middle + (MIN_BRACKET_WIDTH_PX / 2);
    }
    return { x0, x1 };
  }

  formatTimeAtX(x) {
    return formatTimelineTime(this.timeAtX(x), getReadoutDecimals(this.getMsPerPx()));
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

  getFullDensity(binCount) {
    if (this.fullDensity?.binCount === binCount) {
      return this.fullDensity;
    }
    const counts = countObjectsIntoBins(this.objects, 0, this.durationMs, new Float32Array(binCount));
    let maxCount = 0;
    for (const count of counts) {
      maxCount = Math.max(maxCount, count);
    }
    const bins = counts.map((count) => (maxCount > 0 ? count / maxCount : 0));
    this.fullDensity = {
      binCount,
      bins,
      // Objects per ms in the busiest bar of the whole map. Zoomed-in bars are
      // measured against it, so they keep their height as the view pans.
      maxRate: maxCount / (this.durationMs / binCount),
    };
    return this.fullDensity;
  }

  getViewDensity(startMs, durationMs, binCount) {
    const full = this.getFullDensity(binCount);
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

    const cached = this.viewDensityCache;
    if (
      cached
      && cached.firstBinIndex === firstBinIndex
      && cached.binDurationMs === binDurationMs
      && cached.bins.length === visibleBinCount
    ) {
      return cached;
    }
    const bins = countObjectsIntoAlignedBins(
      this.objects,
      firstBinIndex,
      binDurationMs,
      cached?.bins.length === visibleBinCount ? cached.bins : new Float32Array(visibleBinCount),
    );
    const scale = full.maxRate > 0 ? 1 / (binDurationMs * full.maxRate) : 0;
    for (let index = 0; index < visibleBinCount; index += 1) {
      bins[index] = Math.min(1, bins[index] * scale);
    }
    this.viewDensityCache = { firstBinIndex, binDurationMs, bins };
    return this.viewDensityCache;
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
    const beatGridStrength = this.drawBeatGrid(ctx, layout, toX, startMs, endMs, msPerPx);
    const tickStepMs = pickTickStep(msPerPx);
    this.drawTimeGrid(ctx, layout, toX, startMs, endMs, tickStepMs, 1 - beatGridStrength);

    const objectMix = 1 - smoothstep(OBJECTS_SHOWN_MS_PER_PX, DENSITY_SHOWN_MS_PER_PX, msPerPx);
    if (objectMix < 1) {
      this.drawDensity(ctx, layout, startMs, durationMs, playheadX, 1 - objectMix);
    }
    if (objectMix > 0) {
      this.drawObjects(ctx, layout, toX, startMs, endMs, objectMix);
    }

    this.drawKiai(ctx, layout, toX, startMs, endMs, true);
    this.drawPreviewMarker(ctx, layout, toX);
    this.drawTicks(ctx, layout, toX, startMs, endMs, tickStepMs);
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
    const visible = this.breaks.filter((period) => period.endMs > startMs && period.startMs < endMs);
    if (visible.length === 0) {
      return;
    }
    const top = layout.trackTop;
    const bottom = layout.trackBottom;
    ctx.save();
    ctx.beginPath();
    for (const period of visible) {
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
  drawBeatGrid(ctx, layout, toX, startMs, endMs, msPerPx) {
    const sections = this.timingSections;
    if (sections.length === 0) {
      return 0;
    }

    let sectionIndex = 0;
    while (sectionIndex + 1 < sections.length && sections[sectionIndex + 1].time <= startMs) {
      sectionIndex += 1;
    }

    // Pairs of x and opacity, drawn after the walk so each kind is one batch.
    const barLines = [];
    const beatLines = [];
    let strength = 0;
    for (; sectionIndex < sections.length; sectionIndex += 1) {
      const section = sections[sectionIndex];
      const sectionEndMs = sectionIndex + 1 < sections.length ? sections[sectionIndex + 1].time : Infinity;
      // The first timing point's grid also runs back to the start of the map.
      const fromMs = Math.max(startMs, sectionIndex === 0 ? -Infinity : section.time);
      const toMs = Math.min(endMs, sectionEndMs);
      if (fromMs > endMs) {
        break;
      }
      if (toMs <= fromMs) {
        continue;
      }

      const beatPx = section.beatLength / msPerPx;
      const barPx = beatPx * section.meter;
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
      for (; ; beat += beatStepCount) {
        const timeMs = section.time + (beat * section.beatLength);
        if (timeMs >= toMs) {
          break;
        }
        if (((beat % section.meter) + section.meter) % section.meter === 0) {
          barLines.push(Math.round(toX(timeMs)), barStrength);
        } else {
          beatLines.push(Math.round(toX(timeMs)), clamp((beatPx - MIN_BEAT_SPACING_PX) / 8, 0, 1));
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

  drawTimeGrid(ctx, layout, toX, startMs, endMs, stepMs, strength) {
    if (strength <= 0.01) {
      return;
    }
    ctx.fillStyle = COLOURS.gridLine;
    ctx.globalAlpha = 0.045 * strength;
    for (let index = Math.ceil(startMs / stepMs); index * stepMs <= endMs; index += 1) {
      ctx.fillRect(Math.round(toX(index * stepMs)), layout.trackTop, 1, layout.trackBottom - layout.trackTop);
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

    const traceBars = () => {
      ctx.beginPath();
      for (let index = 0; index < bins.length; index += 1) {
        if (bins[index] <= 0) {
          continue;
        }
        const barHeight = Math.max(1, bins[index] * maxHeight);
        const binStartMs = (firstBinIndex + index) * binDurationMs;
        const x = (binStartMs - startMs) / msPerPx;
        ctx.rect(x, middle - (barHeight / 2), barWidthDrawn, barHeight);
      }
    };

    ctx.globalAlpha = alpha;
    // One path per colour: everything in the upcoming green, then the played
    // stretch again in the brighter one, clipped at the playhead.
    traceBars();
    ctx.fillStyle = COLOURS.upcoming;
    ctx.fill();
    if (playheadX > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, layout.trackTop, Math.min(layout.width, playheadX), layout.trackBottom - layout.trackTop);
      ctx.clip();
      traceBars();
      ctx.fillStyle = COLOURS.played;
      ctx.fill();
      ctx.restore();
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
    const firstIndex = findFirstIndexAtOrAfter(objects, startMs - this.maxObjectDurationMs);
    const playheadMs = this.currentTimeMs;

    ctx.globalAlpha = alpha;
    for (const played of [true, false]) {
      ctx.fillStyle = played ? COLOURS.played : COLOURS.upcoming;
      ctx.strokeStyle = ctx.fillStyle;
      const bodies = [];
      const spinners = [];
      ctx.beginPath();
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
        ctx.moveTo(x0 + radius, middle);
        ctx.arc(x0, middle, radius, 0, Math.PI * 2);
      }
      ctx.fill();

      if (bodies.length > 0) {
        ctx.globalAlpha = alpha * 0.55;
        ctx.beginPath();
        for (let index = 0; index < bodies.length; index += 2) {
          traceCapsule(ctx, bodies[index], bodies[index + 1], middle, bodyHalf);
        }
        ctx.fill();
        ctx.globalAlpha = alpha;
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
    ctx.globalAlpha = 1;
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

  // Short marks hanging from the top edge, spreading out as the view zooms in.
  drawTicks(ctx, layout, toX, startMs, endMs, stepMs) {
    ctx.fillStyle = COLOURS.tick;
    for (let index = Math.ceil(startMs / stepMs); index * stepMs <= endMs; index += 1) {
      ctx.fillRect(Math.round(toX(index * stepMs)), layout.trackTop, 1, TICK_HEIGHT_PX);
    }
  }

  // A faint line where the song (or, without the full track, the last object)
  // ends, with what is left of the timeline past it shaded a touch, so the end
  // can be found even zoomed in.
  drawEndMarker(ctx, layout, toX, startMs, endMs) {
    const songEndMs = this.getEndMs();
    if (songEndMs === null || songEndMs < startMs || songEndMs > endMs) {
      return;
    }
    // A song that runs to the timeline's end would land just off the canvas.
    const x = Math.min(Math.round(toX(songEndMs)), layout.width - 1);
    const height = layout.trackBottom - layout.trackTop;
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
