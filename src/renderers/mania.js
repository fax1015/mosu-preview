// osu!mania. The timing follows osu!lazer's mania ruleset -- its scroll speed,
// its bar lines, notes meeting the line with their bottom edge, hold notes
// pinned to the line while held, and the key presses of its autoplay -- while
// the look is the preview's own: plain lanes, notes drawn like every other
// ruleset's pieces here (see drawPieceRect), and keys under the line that
// light up as autoplay presses them.
//
// Everything is drawn for downward scroll. Upward scroll is the same picture
// turned upside down, as it is in lazer, so it is drawn through a mirror
// rather than twice.

import { calculateManiaScrollTimeMs, DEFAULT_MANIA_SCROLL_SCALE_WITH_BPM, DEFAULT_MANIA_SCROLL_SPEED } from '../settings.js';
import { getElapsedBeatsAt, getTimingSections, getTimingStateAt } from '../core/controlPoints.js';
import { clamp, findFirstIndexAtOrAfter } from '../core/math.js';
import {
  MAX_MEASURE_LINES,
  MIN_BEAT_LENGTH_MS,
  OSU_WIDTH,
  PIECE_MAX_ALPHA,
  WHITE,
  drawPieceRect,
  drawSelectionRings,
  easeOutQuint,
  getBarCornerRadius,
  linearGradient,
  mixColours,
  pickHitTarget,
  withAlpha,
} from './shared.js';

// osu!framework's Color4.Lighten and Darken: every channel scaled by (1 + amount).
const lighten = (colour, amount) => ({
  r: Math.min(255, colour.r * (1 + amount)),
  g: Math.min(255, colour.g * (1 + amount)),
  b: Math.min(255, colour.b * (1 + amount)),
});
const darken = (colour, amount) => ({
  r: colour.r / (1 + amount),
  g: colour.g / (1 + amount),
  b: colour.b / (1 + amount),
});

const traceRoundedRect = (ctx, x, y, width, height, radius) => {
  ctx.beginPath();
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r > 0 && typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, r);
  } else {
    ctx.rect(x, y, width, height);
  }
};

/**
 * The end of a hold note, after ArgonHoldNoteTailPiece: a solid cap in the
 * lane's colour, deeper than the body, with a glow across its top half and a
 * rim, so the end stands out from the see-through body leading up to it.
 */
// The tail's glow, made once per canvas, size and colour rather than per tail
// per frame: it runs from the tail's top edge (y = 0) halfway down.
const tailGlowCaches = new WeakMap();
const getTailGlow = (ctx, height, colour) => {
  let cache = tailGlowCaches.get(ctx);
  if (!cache) {
    cache = new Map();
    tailGlowCaches.set(ctx, cache);
  }
  const key = `${height}|${colour.r},${colour.g},${colour.b}`;
  let glow = cache.get(key);
  if (glow === undefined) {
    if (cache.size > 64) cache.clear();
    glow = linearGradient(ctx, 0, 0, 0, height / 2, [
      [0, withAlpha(lighten(colour, 0.2), 0.55)],
      [1, withAlpha(colour, 0)],
    ]);
    cache.set(key, glow);
  }
  return glow;
};

const drawHoldTail = (ctx, x, y, width, height, colour) => {
  const radius = getBarCornerRadius(height);
  ctx.fillStyle = withAlpha(darken(colour, 0.35), 0.92);
  traceRoundedRect(ctx, x, y, width, height, radius);
  ctx.fill();
  ctx.save();
  ctx.translate(x, y);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = getTailGlow(ctx, height, colour);
  traceRoundedRect(ctx, 0, 0, width, height / 2, radius);
  ctx.fill();
  ctx.restore();
  const outline = Math.max(1, Math.min(width, height) * 0.1);
  ctx.strokeStyle = withAlpha(WHITE, 0.6);
  ctx.lineWidth = outline;
  traceRoundedRect(ctx, x + (outline / 2), y + (outline / 2), width - outline, height - outline, radius - (outline / 2));
  ctx.stroke();
};

// --- layout -------------------------------------------------------------------

// The lanes share this much of the canvas's width between them, four keys'
// worth at the least: fewer keys keep 4K's lane width and leave the stage
// narrower, so a 1K stage is not one wall of a note. lazer's own columns are
// far narrower than this (60px of a 1024px screen); in a preview this size
// those read as slivers.
const STAGE_WIDTH_SHARE = 0.6;
// However many keys, the stage leaves a little room either side, and a lane is
// never wider than this much of the height.
const MAX_STAGE_WIDTH_SHARE = 0.94;
const MAX_LANE_HEIGHT_SHARE = 0.2;
// Where the judgement line sits, down the canvas: lazer's (Argon's hit
// position, 140px up a 768px screen), leaving room for the keys under it.
const HIT_LINE_POSITION = 0.82;
// A note's height, of the canvas's, and of its lane's width at the most.
const NOTE_HEIGHT_SHARE = 0.04;
const MAX_NOTE_HEIGHT_OF_LANE = 0.45;
// The gap between the stages of a co-op map, in lanes.
const STAGE_GAP_LANES = 0.4;
// How far in from a lane's edges its notes and key sit, as a share of its width.
const LANE_PADDING_SHARE = 0.08;

// The keys under the line are drawn after ArgonKeyArea, whose 60px column has
// a target line along its top this many of its own pixels thick.
const KEY_REFERENCE_WIDTH = 60;
const KEY_REFERENCE_HEIGHT = 80;
const KEY_LINE_THICKNESS = 6.8;
const KEY_LINE_COLOUR = Object.freeze({ r: 196, g: 196, b: 196 });

// ManiaAutoGenerator.RELEASE_DELAY.
const RELEASE_DELAY_MS = 20;
// DrawableBarLine fades out once it passes the line.
const BAR_LINE_FADE_MS = 150;
// ArgonHitExplosion, on every hit note, hold head and hold tail: the band just
// above the line, as tall as a note's coloured part (ArgonNotePiece's 0.82 of
// it), lit up with the lane's colour 80% of the way to white, fading over
// PoolableHitExplosion's 200ms (Easing.Out). Argon also throws a wide glow
// around it, out over the neighbouring lanes; the preview keeps the light to
// the lane it belongs to.
const HIT_EXPLOSION_MS = 200;
const HIT_EXPLOSION_BAND = 0.82;

// The preview's lane colours, mirrored about the middle: a yellow middle lane
// on an odd key count, then pink and pale pink alternating outwards.
const LANE_PALE = Object.freeze({ r: 232, g: 210, b: 223 });
const LANE_PINK = Object.freeze({ r: 205, g: 113, b: 160 });
const LANE_MIDDLE = Object.freeze({ r: 231, g: 211, b: 58 });

const getLaneColour = (columnInStage, columnsPerStage) => {
  if (columnsPerStage % 2 === 1) {
    const middle = Math.floor(columnsPerStage / 2);
    if (columnInStage === middle) return LANE_MIDDLE;
    return Math.abs(columnInStage - middle) % 2 === 1 ? LANE_PINK : LANE_PALE;
  }
  const half = columnsPerStage / 2;
  const fromSplit = columnInStage < half ? (half - 1) - columnInStage : columnInStage - half;
  return fromSplit % 2 === 0 ? LANE_PINK : LANE_PALE;
};

// Timing-based note colouring: BindableBeatDivisor.GetColourFor, from
// OsuColour, for the divisor ControlPointInfo.GetClosestBeatDivisor picks out
// of BindableBeatDivisor.PREDEFINED_DIVISORS.
const SNAP_DIVISORS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 16]);
const SNAP_COLOURS = Object.freeze({
  1: WHITE,
  2: Object.freeze({ r: 0xed, g: 0x11, b: 0x21 }),
  4: Object.freeze({ r: 0x66, g: 0xcc, b: 0xff }),
  8: Object.freeze({ r: 0xff, g: 0xcc, b: 0x22 }),
  16: Object.freeze({ r: 0x66, g: 0x44, b: 0xcc }),
  3: Object.freeze({ r: 0x88, g: 0x66, b: 0xee }),
  6: Object.freeze({ r: 0xee, g: 0xaa, b: 0x00 }),
  12: Object.freeze({ r: 0xcc, g: 0x66, b: 0x00 }),
  5: Object.freeze({ r: 0xb3, g: 0xd9, b: 0x44 }),
  7: Object.freeze({ r: 0xb3, g: 0xd9, b: 0x44 }),
  9: Object.freeze({ r: 0xb3, g: 0xd9, b: 0x44 }),
});
const UNSNAPPED_COLOUR = Object.freeze({ r: 255, g: 0, b: 0 });

/**
 * ControlPointInfo.GetClosestBeatDivisor against one timing section: the
 * coarsest divisor whose nearest snap is the closest, ties going to the
 * coarser one.
 */
const getClosestBeatDivisor = (time, sectionStart, beatLength) => {
  let adjusted = time;
  if (adjusted < 0) {
    adjusted += Math.ceil(-adjusted / beatLength) * beatLength;
  }
  let closestDivisor = 0;
  let closestDistance = Number.MAX_VALUE;
  for (const divisor of SNAP_DIVISORS) {
    const snapLength = beatLength / divisor;
    const beats = (Math.max(adjusted, 0) - sectionStart) / snapLength;
    // Math.Round(.., MidpointRounding.AwayFromZero), then (int).
    const rounded = Math.sign(beats) * Math.round(Math.abs(beats));
    let snapped = sectionStart + (rounded * snapLength);
    if (snapped < 0) snapped += snapLength;
    const distance = Math.abs(adjusted - snapped);
    // Precision.DefinitelyBigger.
    if (closestDistance - 1e-7 > distance) {
      closestDivisor = divisor;
      closestDistance = distance;
    }
  }
  return closestDivisor;
};

/**
 * The stage in a canvas, in canvas pixels: lanes stage by stage, left to
 * right, the whole lot centred, from the top of the canvas to the bottom.
 * `pixelRatio` is how many device pixels a canvas pixel covers; edges are
 * snapped to whole device pixels.
 */
const getManiaLayout = (canvasWidth, canvasHeight, totalColumns, stageCount = 1, pixelRatio = 1) => {
  const width = Math.max(1, Number(canvasWidth) || 1);
  const height = Math.max(1, Number(canvasHeight) || 1);
  const columns = clamp(Math.round(Number(totalColumns) || 4), 1, 20);
  const stages = Number.isInteger(stageCount) && stageCount > 0 && columns % stageCount === 0 ? stageCount : 1;
  const columnsPerStage = columns / stages;
  const gapLanes = STAGE_GAP_LANES * (stages - 1);

  const laneWidth = Math.min(
    (width * STAGE_WIDTH_SHARE) / Math.max(columns, 4),
    (width * MAX_STAGE_WIDTH_SHARE) / (columns + gapLanes),
    height * MAX_LANE_HEIGHT_SHARE,
  );
  const stageWidth = laneWidth * columnsPerStage;
  const totalWidth = (laneWidth * columns) + (laneWidth * gapLanes);
  const left = (width - totalWidth) / 2;

  const stageRects = Array.from({ length: stages }, (_, stage) => ({
    x: left + (stage * (stageWidth + (laneWidth * STAGE_GAP_LANES))),
    width: stageWidth,
  }));
  // Every lane's edges, and the inset edges everything drawn in it shares --
  // notes, hold bodies, the lane's light, its key's flash and target line --
  // fall on whole device pixels. Whole canvas pixels are not enough: at 1.5x
  // they land between device pixels, and a rounded shape and a square one
  // blur a half-pixel edge differently, so they look a pixel apart.
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const snap = (value) => Math.round(value * ratio) / ratio;
  const padding = Math.max(1, laneWidth * LANE_PADDING_SHARE);
  const columnRects = Array.from({ length: columns }, (_, index) => {
    const stage = Math.floor(index / columnsPerStage);
    const columnInStage = index % columnsPerStage;
    const left = snap(stageRects[stage].x + (columnInStage * laneWidth));
    const right = snap(stageRects[stage].x + ((columnInStage + 1) * laneWidth));
    const innerLeft = snap(left + padding);
    const innerRight = snap(right - padding);
    return {
      index,
      stage,
      x: left,
      width: right - left,
      innerX: innerLeft,
      innerWidth: Math.max(1 / ratio, innerRight - innerLeft),
      colour: getLaneColour(columnInStage, columnsPerStage),
    };
  });

  const hitY = snap(height * HIT_LINE_POSITION);
  return {
    laneWidth,
    pixelRatio: ratio,
    columns: columnRects,
    stages: stageRects,
    stageTop: 0,
    stageBottom: height,
    hitY,
    noteHeight: Math.max(6, Math.min(height * NOTE_HEIGHT_SHARE, laneWidth * MAX_NOTE_HEIGHT_OF_LANE)),
    // How far a note travels in one time range: from the top of the stage to
    // the line, as lazer's ScrollingHitObjectContainer measures it.
    scrollLength: Math.max(1, hitY),
  };
};

/**
 * osu!lazer's BarLineGenerator: a line every bar of each timing section, from
 * the section (or t = 0, whichever is later) to the next section, or a bar
 * past the last object. Every `meter`th bar of a section is a major one.
 */
const generateManiaBarLines = (controlPoints, firstObjectTime, lastObjectEndTime) => {
  const sections = getTimingSections(controlPoints);
  const lines = [];
  if (sections.length === 0) return lines;
  const generationStart = Math.min(0, firstObjectTime);
  const lastHitTime = 1 + lastObjectEndTime;

  for (let i = 0; i < sections.length && lines.length < 200000; i += 1) {
    const point = sections[i];
    const meter = Number.isFinite(point.meter) && point.meter > 0 ? point.meter : 4;
    const beatLength = Math.max(MIN_BEAT_LENGTH_MS, point.beatLength);
    const barLength = beatLength * meter;
    const endTime = i < sections.length - 1 ? sections[i + 1].time : lastHitTime + barLength;
    let startTime = point.time;
    if (!(point.time > generationStart)) {
      startTime = point.time + (Math.ceil((generationStart - point.time) / barLength) * barLength);
    }
    if (point.omitFirstBarLine) startTime += barLength;

    let beat = 0;
    for (let t = startTime; endTime - t > -1e-3 && lines.length < 200000; t += barLength, beat += 1) {
      const rounded = Math.round(t);
      const time = Math.abs(t - rounded) < 1e-3 ? rounded : t;
      lines.push({ time, major: beat % meter === 0 });
      if (!(t + barLength > t)) break;
    }
  }
  return lines;
};

/**
 * ManiaAutoGenerator: each note pressed on time and let go 20ms later -- or
 * nine tenths of the way to the next note in its column if that comes sooner
 * -- and a hold let go exactly at its end. Per column, in time order, with
 * every hit too: a note is one, a hold note's head and tail are one each.
 */
const buildManiaKeyPresses = (objects, columnOf, columnCount) => {
  const presses = Array.from({ length: columnCount }, () => ({ press: [], release: [], hits: [] }));
  const nextInColumn = new Array(objects.length).fill(null);
  const lastSeen = new Array(columnCount).fill(-1);
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const column = columnOf(objects[i]);
    nextInColumn[i] = lastSeen[column] >= 0 ? objects[lastSeen[column]] : null;
    lastSeen[column] = i;
  }

  for (let i = 0; i < objects.length; i += 1) {
    const object = objects[i];
    const column = columnOf(object);
    const isHold = object.kind === 'hold' || object.endTime > object.time;
    const endTime = isHold ? object.endTime : object.time;
    let releaseDelay = RELEASE_DELAY_MS;
    let release;
    if (isHold && endTime > object.time) {
      release = endTime;
    } else {
      if (isHold) releaseDelay = 1;
      const next = nextInColumn[i];
      const canDelayFully = !next || next.time > endTime + releaseDelay;
      release = endTime + (canDelayFully ? releaseDelay : (next.time - endTime) * 0.9);
    }
    const entry = presses[column];
    entry.press.push(object.time);
    entry.release.push(release);
    entry.hits.push(object.time);
    if (isHold) entry.hits.push(endTime);
  }
  for (const entry of presses) {
    entry.hits.sort((a, b) => a - b);
  }
  return presses;
};

// The index of the last value at or before `time` in a sorted list, or -1.
const lastAtOrBefore = (values, time) => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] <= time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
};

/**
 * How lit a lane is from its key: up to full in 50ms while held, settling to
 * half over 250ms, and from wherever it was down to nothing over 250ms once
 * let go, all OutQuint -- the timing of lazer's column lighting.
 */
const getLaneLight = (presses, time) => {
  const index = lastAtOrBefore(presses.press, time);
  if (index < 0) return 0;
  const press = presses.press[index];
  const release = presses.release[index];
  const lightWhileHeld = (heldFor) => (heldFor < 50
    ? easeOutQuint(heldFor / 50)
    : 1 - (0.5 * easeOutQuint(Math.min(1, (heldFor - 50) / 250))));
  if (time < release) return lightWhileHeld(time - press);
  return lightWhileHeld(release - press) * (1 - easeOutQuint(Math.min(1, (time - release) / 250)));
};

/**
 * ArgonKeyArea over a press. `lit` is how far the line has gone to white (in
 * 70ms, back out over 800ms); `background` is the key's own opacity (to full
 * in 70ms then 0.8 over 500ms; once let go 0.3 in 50ms, then out over 800ms);
 * `flash` is its colour, starting at the lane's colour lightened and going
 * back over 200ms. All OutQuint but the 500ms.
 */
const getKeyState = (presses, time) => {
  const index = lastAtOrBefore(presses.press, time);
  if (index < 0) return { lit: 0, background: 0, flash: 0 };
  const press = presses.press[index];
  const release = presses.release[index];
  const heldFor = Math.min(time, release) - press;
  const litWhileHeld = easeOutQuint(Math.min(1, heldFor / 70));
  const backgroundWhileHeld = heldFor < 70
    ? easeOutQuint(heldFor / 70)
    : 1 - (0.2 * Math.min(1, (heldFor - 70) / 500));
  const flash = 1 - easeOutQuint(Math.min(1, (time - press) / 200));
  if (time < release) {
    return { lit: litWhileHeld, background: backgroundWhileHeld, flash };
  }
  const sinceRelease = time - release;
  const background = sinceRelease < 50
    ? backgroundWhileHeld + ((0.3 - backgroundWhileHeld) * easeOutQuint(sinceRelease / 50))
    : 0.3 * (1 - easeOutQuint(Math.min(1, (sinceRelease - 50) / 800)));
  return {
    lit: litWhileHeld * (1 - easeOutQuint(Math.min(1, sinceRelease / 800))),
    background,
    flash,
  };
};

export class ManiaRenderer {
  constructor(host) {
    this.host = host;
    this.scrollSpeed = DEFAULT_MANIA_SCROLL_SPEED;
    this.scaleScrollSpeedWithBpm = DEFAULT_MANIA_SCROLL_SCALE_WITH_BPM;
    this.scrollDirection = 'down';
    this.timingNoteColours = false;
    this.cache = null;
    // What the last frame drew that a click can pick out, in canvas pixels.
    this.hitTargets = [];
  }

  get mapData() { return this.host.mapData; }

  get currentTimeMs() { return this.host.currentTimeMs; }

  setSettings(settings = {}) {
    if (Object.hasOwn(settings, 'maniaScrollSpeed')) {
      this.scrollSpeed = settings.maniaScrollSpeed;
    }
    if (Object.hasOwn(settings, 'maniaScaleScrollSpeedWithBpm')) {
      this.scaleScrollSpeedWithBpm = Boolean(settings.maniaScaleScrollSpeedWithBpm);
    }
    if (Object.hasOwn(settings, 'maniaScrollDirection')) {
      this.scrollDirection = settings.maniaScrollDirection === 'up' ? 'up' : 'down';
    }
    if (Object.hasOwn(settings, 'maniaTimingNoteColours')) {
      this.timingNoteColours = Boolean(settings.maniaTimingNoteColours);
    }
  }

  setBeatmap() {
    this.cache = null;
  }

  getControlPoints() {
    return Array.isArray(this.mapData?.timingControlPoints) ? this.mapData.timingControlPoints : [];
  }

  getReferenceBpm() {
    const primaryBpm = Number(this.mapData?.primaryBpm);
    if (Number.isFinite(primaryBpm) && primaryBpm > 0) {
      return primaryBpm;
    }
    const fallbackBpm = Number(this.mapData?.bpmMin);
    return Number.isFinite(fallbackBpm) && fallbackBpm > 0 ? fallbackBpm : 120;
  }

  // A standard map converted to mania keeps its greenlines for the sliders it
  // was converted from, but they never meant anything for scroll speed.
  appliesInheritedSv() {
    return !(this.mapData?.conversion?.sourceMode === 0
      && this.mapData?.conversion?.targetMode === 3);
  }

  getTimingState(time) {
    const timing = getTimingStateAt(this.getControlPoints(), time);
    return this.appliesInheritedSv() ? timing : { ...timing, svMultiplier: 1 };
  }

  /**
   * How long a note takes to come down the whole scroll at unit velocity:
   * DrawableManiaRuleset.ComputeScrollTime, 11485ms over the scroll speed.
   */
  getTimeRangeMs() {
    return calculateManiaScrollTimeMs(this.scrollSpeed, 120, false);
  }

  // Pixels per beat at unit velocity, over a scroll `scrollLength` long. The
  // scroll speed is this times the velocity in force, over the beat length:
  // lazer's sequential scroll, with beat lengths taken relative to the map's
  // main one (RelativeScaleBeatLengths) -- or to 120 BPM, if scroll speed is
  // set to follow the BPM.
  getPixelsPerBeat(scrollLength) {
    const basePixelsPerMs = scrollLength / Math.max(1, this.getTimeRangeMs());
    const referenceBpm = this.scaleScrollSpeedWithBpm ? 120 : this.getReferenceBpm();
    return basePixelsPerMs * (60000 / Math.max(1, referenceBpm));
  }

  getPixelsPerMs(time, scrollLength) {
    const state = this.getTimingState(time);
    return (this.getPixelsPerBeat(scrollLength) * state.svMultiplier) / Math.max(1, state.beatLength);
  }

  /**
   * Distance a note travels between two timestamps. Scroll speed is piecewise
   * constant between control points, so this is the difference of two running
   * beat totals -- it used to re-walk the control points for every segment of
   * every note, every frame.
   */
  getScrollOffset(startTime, endTime, scrollLength) {
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime === endTime) {
      return 0;
    }

    const controlPoints = this.getControlPoints();
    const withSv = this.appliesInheritedSv();
    const elapsedBeats = getElapsedBeatsAt(controlPoints, endTime, { withSv })
      - getElapsedBeatsAt(controlPoints, startTime, { withSv });
    return elapsedBeats * this.getPixelsPerBeat(scrollLength);
  }

  getSnapColour(time) {
    const timing = getTimingStateAt(this.getControlPoints(), time);
    const beatLength = Math.max(MIN_BEAT_LENGTH_MS, timing.beatLength);
    const sectionStart = Number.isFinite(timing.sectionStart) ? timing.sectionStart : 0;
    return SNAP_COLOURS[getClosestBeatDivisor(time, sectionStart, beatLength)] || UNSNAPPED_COLOUR;
  }

  getColumnCount() {
    return clamp(
      Math.round(this.mapData?.mania?.totalColumns || this.mapData?.circleSize || 4),
      1,
      20,
    );
  }

  // Bar lines and key presses depend only on the objects and the timing.
  getCache() {
    const objects = this.mapData?.objects;
    const controlPoints = this.getControlPoints();
    const columnCount = this.getColumnCount();
    if (
      this.cache
      && this.cache.objects === objects
      && this.cache.controlPoints === controlPoints
      && this.cache.columnCount === columnCount
    ) {
      return this.cache;
    }
    const list = Array.isArray(objects) ? objects : [];
    const columnOf = (object) => clamp(
      Number.isInteger(object.column)
        ? object.column
        : Math.floor((clamp(object.x, 0, OSU_WIDTH - 0.001) / OSU_WIDTH) * columnCount),
      0,
      columnCount - 1,
    );
    let lastEnd = 0;
    for (const object of list) {
      lastEnd = Math.max(lastEnd, Number(object.endTime) || Number(object.time) || 0);
    }
    this.cache = {
      objects,
      controlPoints,
      columnCount,
      columnOf,
      barLines: generateManiaBarLines(controlPoints, list[0]?.time ?? 0, lastEnd),
      presses: buildManiaKeyPresses(list, columnOf, columnCount),
    };
    return this.cache;
  }

  render(ctx, width, height) {
    ctx.fillStyle = 'rgba(19, 21, 26, 0.95)';
    ctx.fillRect(0, 0, width, height);

    const cache = this.getCache();
    const stageCount = Number(this.mapData?.mania?.stageCount);
    // The canvas's own scale (its device pixel ratio), to snap the lanes to.
    const transform = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    const pixelRatio = transform && Number.isFinite(transform.a) ? Math.abs(transform.a) : 1;
    const layout = getManiaLayout(
      width,
      height,
      cache.columnCount,
      Number.isInteger(stageCount) ? stageCount : 1,
      pixelRatio,
    );
    const time = this.currentTimeMs;
    this.hitTargets = [];

    ctx.save();
    if (this.scrollDirection === 'up') {
      ctx.translate(0, height);
      ctx.scale(1, -1);
    }
    this.drawLanes(ctx, layout, cache, time);
    this.drawBarLines(ctx, layout, cache, time);
    this.drawNotes(ctx, layout, cache, time);
    this.drawHitExplosions(ctx, layout, cache, time);
    this.drawKeys(ctx, layout, cache, time);
    ctx.restore();

    // The notes were drawn through the mirror for upward scroll; their targets
    // are turned the right way up for the pointer and the rings.
    if (this.scrollDirection === 'up') {
      for (const target of this.hitTargets) {
        target.y = height - (target.y + target.height);
      }
    }
    drawSelectionRings(ctx, this.hitTargets, this.host.getSelectionToRing?.());
  }

  // The object under a point, from what the last frame drew; see pickHitTarget.
  objectIndexAtPoint(canvasX, canvasY) {
    return pickHitTarget(this.hitTargets, canvasX, canvasY);
  }

  // See HIT_EXPLOSION_MS. Drawn between the notes and the keys, as in lazer.
  drawHitExplosions(ctx, layout, cache, time) {
    const { hitY, noteHeight } = layout;
    const band = noteHeight * HIT_EXPLOSION_BAND;
    const corner = getBarCornerRadius(noteHeight);
    for (const column of layout.columns) {
      const { hits } = cache.presses[column.index];
      for (let i = lastAtOrBefore(hits, time); i >= 0; i -= 1) {
        const age = time - hits[i];
        if (age >= HIT_EXPLOSION_MS) break;
        // FadeOutFromOne with Easing.Out (OutQuad).
        const alpha = (1 - (age / HIT_EXPLOSION_MS)) ** 2;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = withAlpha(mixColours(column.colour, WHITE, 0.8), 0.85 * alpha);
        traceRoundedRect(ctx, column.innerX, hitY - band, column.innerWidth, band, corner);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // Each lane faintly in its colour, a hairline between lanes, and a glow up
  // from the line while its key is down.
  drawLanes(ctx, layout, cache, time) {
    const { stageTop, stageBottom, hitY } = layout;
    for (const column of layout.columns) {
      ctx.fillStyle = withAlpha(column.colour, column.index % 2 === 0 ? 0.11 : 0.07);
      ctx.fillRect(column.x, stageTop, column.width, stageBottom - stageTop);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.fillRect(Math.round(column.x), stageTop, 1, stageBottom - stageTop);

      const light = getLaneLight(cache.presses[column.index], time);
      if (light > 0.002) {
        const top = hitY - ((hitY - stageTop) * 0.3);
        ctx.fillStyle = linearGradient(ctx, 0, top, 0, hitY, [
          [0, withAlpha(column.colour, 0)],
          [1, withAlpha(column.colour, 0.28 * light)],
        ]);
        ctx.fillRect(column.innerX, top, column.innerWidth, hitY - top);
      }
    }
    for (const stage of layout.stages) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.fillRect(Math.round(stage.x + stage.width), stageTop, 1, stageBottom - stageTop);
    }
  }

  // A hairline across the stage every bar, a little brighter every fourth,
  // fading once it passes the line.
  drawBarLines(ctx, layout, cache, time) {
    const { barLines } = cache;
    const { hitY, scrollLength } = layout;
    let drawn = 0;
    for (
      let i = findFirstIndexAtOrAfter(barLines, time - BAR_LINE_FADE_MS);
      i < barLines.length && drawn < MAX_MEASURE_LINES;
      i += 1
    ) {
      const line = barLines[i];
      const y = hitY - this.getScrollOffset(time, line.time, scrollLength);
      if (y < -2) break;
      const alpha = line.time >= time ? 1 : 1 - ((time - line.time) / BAR_LINE_FADE_MS);
      if (alpha <= 0.002) continue;
      drawn += 1;
      ctx.fillStyle = withAlpha(WHITE, (line.major ? 0.2 : 0.09) * alpha);
      for (const stage of layout.stages) {
        ctx.fillRect(stage.x, Math.round(y) - 1, stage.width, 1);
      }
    }
  }

  drawNotes(ctx, layout, cache, time) {
    const objects = this.mapData?.objects;
    if (!Array.isArray(objects) || objects.length === 0) return;
    const { hitY, scrollLength, noteHeight } = layout;

    // Notes leave the moment they are hit; holds stay until let go. Positions
    // only grow with time, so the first note above the top ends the search.
    const visible = [];
    for (
      let i = findFirstIndexAtOrAfter(objects, time - (this.host.maxObjectDurationMs || 0));
      i < objects.length && visible.length < 4000;
      i += 1
    ) {
      const object = objects[i];
      const isHold = object.kind === 'hold' || object.endTime > object.time;
      if (isHold ? object.endTime <= time : object.time <= time) continue;
      const headBottom = hitY - this.getScrollOffset(time, object.time, scrollLength);
      if (headBottom < -noteHeight) {
        if (object.time > time) break;
        continue;
      }
      visible.push({ object, index: i, isHold, headBottom });
    }

    // Latest first, so an earlier note is drawn over a later one.
    for (let v = visible.length - 1; v >= 0; v -= 1) {
      const {
        object, index, isHold, headBottom,
      } = visible[v];
      const column = layout.columns[cache.columnOf(object)];
      if (!column) continue;
      const noteX = column.innerX;
      const noteWidth = column.innerWidth;
      const colour = this.timingNoteColours ? this.getSnapColour(object.time) : column.colour;

      if (isHold) {
        // DrawableHoldNote: once its head is hit the head stays on the line,
        // and the body and tail are cut off half-way under it. The body runs
        // from there to half-way under the tail.
        const held = time >= object.time;
        const headBottomDrawn = held ? hitY : headBottom;
        const tailBottom = hitY - this.getScrollOffset(time, object.endTime, scrollLength);
        const cutY = headBottomDrawn - (noteHeight / 2);
        const bodyTop = tailBottom - (noteHeight / 2);
        if (cutY > bodyTop) {
          ctx.fillStyle = withAlpha(column.colour, held ? 0.42 : 0.3);
          traceRoundedRect(ctx, noteX, bodyTop, noteWidth, cutY - bodyTop, getBarCornerRadius(noteHeight));
          ctx.fill();
        }
        // Only a tail that has reached the cut needs cutting: a clip per hold
        // note was most of the cost of drawing a long-note map.
        const tailReachesCut = tailBottom > cutY;
        if (tailReachesCut) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(column.x - 1, -1e5, column.width + 2, cutY + 1e5);
          ctx.clip();
        }
        const tailColour = this.timingNoteColours ? this.getSnapColour(object.endTime) : column.colour;
        drawHoldTail(ctx, noteX, tailBottom - noteHeight, noteWidth, noteHeight, tailColour);
        if (tailReachesCut) ctx.restore();
        drawPieceRect(ctx, noteX, headBottomDrawn - noteHeight, noteWidth, noteHeight, colour, PIECE_MAX_ALPHA);
        // The whole hold note, from its tail to its head, as one target.
        const holdTop = Math.min(tailBottom, headBottomDrawn) - noteHeight;
        this.hitTargets.push({
          index,
          x: noteX,
          y: holdTop,
          width: noteWidth,
          height: headBottomDrawn - holdTop,
          corner: getBarCornerRadius(noteHeight),
        });
        continue;
      }

      drawPieceRect(ctx, noteX, headBottom - noteHeight, noteWidth, noteHeight, colour, PIECE_MAX_ALPHA);
      this.hitTargets.push({
        index,
        x: noteX,
        y: headBottom - noteHeight,
        width: noteWidth,
        height: noteHeight,
        corner: getBarCornerRadius(noteHeight),
      });
    }
  }

  /**
   * The keys under the line, after ArgonKeyArea: per lane, a grey target line
   * along the top of a plain key. (Argon also draws a ring and three dots on
   * each key; the preview leaves them out.) A key press flashes the key with
   * the lane's colour and lights the line up white; letting go fades them
   * back. Argon's line glows out past the lane as it lights; the preview's
   * keeps to its lane.
   */
  drawKeys(ctx, layout, cache, time) {
    const { hitY, stageBottom, laneWidth } = layout;
    const areaHeight = stageBottom - hitY;
    if (!(areaHeight > 0)) return;
    const unit = Math.min(laneWidth / KEY_REFERENCE_WIDTH, areaHeight / KEY_REFERENCE_HEIGHT);
    const ratio = layout.pixelRatio;
    const snap = (value) => Math.round(value * ratio) / ratio;
    // The key's flash is rounded off as the notes are. The target line is only
    // a few pixels thick, so the same radius would round its ends right off
    // and leave them looking short of the flash and the notes; it gets a
    // radius in proportion to its own thickness instead.
    const corner = getBarCornerRadius(layout.noteHeight);
    const lineHeight = Math.max(3, snap(KEY_LINE_THICKNESS * unit));
    const lineTop = snap(hitY - (lineHeight / 2));
    const lineCorner = Math.min(corner, lineHeight * 0.25);
    for (const column of layout.columns) {
      const state = getKeyState(cache.presses[column.index], time);
      const keyBottom = snap(stageBottom - (column.innerX - column.x));

      // The key's own well, a shade darker than the lane, and its flash.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fillRect(column.x, hitY, column.width, areaHeight);
      if (state.background > 0.002) {
        const flash = mixColours(darken(column.colour, 0.2), lighten(column.colour, 0.8), state.flash);
        ctx.fillStyle = withAlpha(flash, 0.55 * state.background);
        traceRoundedRect(ctx, column.innerX, hitY, column.innerWidth, keyBottom - hitY, corner);
        ctx.fill();
      }

      // The target line.
      ctx.fillStyle = withAlpha(mixColours(KEY_LINE_COLOUR, WHITE, state.lit), 0.95);
      traceRoundedRect(ctx, column.innerX, lineTop, column.innerWidth, lineHeight, lineCorner);
      ctx.fill();
    }
  }
}

export {
  buildManiaKeyPresses,
  generateManiaBarLines,
  getClosestBeatDivisor,
  getKeyState,
  getLaneColour,
  getLaneLight,
  getManiaLayout,
};
