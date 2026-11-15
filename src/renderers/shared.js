// What more than one ruleset's renderer needs: the osu! coordinate space, the
// combo colours and how objects are numbered into them, timing that every
// ruleset reads the same way, and a handful of drawing and easing helpers.
//
// Each ruleset lives in its own module next to this one (standard.js, taiko.js,
// catch.js, mania.js); renderer.js only picks which of them draws a frame.

import { clamp } from '../core/math.js';

const OSU_WIDTH = 512;
const OSU_HEIGHT = 384;
// The legacy 640x480 view the 512x384 field sits in. osu!lazer lays every
// ruleset out in a 1024x768 view, which is this one at 1.6x.
const OSU_VIEW_WIDTH = 640;
const OSU_VIEW_HEIGHT = 480;

const LONG_OBJECT_POST_HIT_FADE_MS = 140;
// osu!lazer's TimingControlPoint floor for beat length.
const MIN_BEAT_LENGTH_MS = 6;
// The most bar lines one frame will draw. A visible window holds a few dozen.
const MAX_MEASURE_LINES = 4096;

const WHITE = Object.freeze({ r: 255, g: 255, b: 255 });
const BLACK = Object.freeze({ r: 0, g: 0, b: 0 });

/**
 * osu!lazer's approach preempt: IBeatmapDifficultyInfo.DifficultyRange(AR,
 * 1800, 1200, 450). osu!standard's approach circles and osu!catch's fall time
 * (CatchHitObject.PREEMPT_RANGE, DrawableCatchRuleset.GetTimeRange) are both
 * this one curve.
 */
const getApproachPreemptMs = (ar) => {
  const value = clamp(Number.isFinite(ar) ? ar : 5, 0, 11);
  if (value < 5) {
    return 1800 - (120 * value);
  }
  return 1200 - (150 * (value - 5));
};

const formatTime = (ms) => {
  const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const withAlpha = (rgb, alpha) => `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamp(alpha, 0, 1)})`;

// Objects are sorted by start time but may overlap, so the visible-window
// search has to look back by the longest object in the map to avoid skipping a
// long slider or spinner that started before the window.
const getMaxObjectDurationMs = (objects) => {
  let longest = 0;
  for (const object of (objects || [])) {
    const duration = (Number(object?.endTime) || 0) - (Number(object?.time) || 0);
    if (duration > longest) {
      longest = duration;
    }
  }
  return longest;
};

/**
 * A linear gradient through `stops` ([offset, css colour] pairs), or the most
 * opaque of those colours where the context cannot make one. The fallback is
 * for the recording contexts the tests draw into, which answer every call with
 * nothing.
 */
const linearGradient = (ctx, x0, y0, x1, y1, stops) => {
  const gradient = typeof ctx.createLinearGradient === 'function'
    ? ctx.createLinearGradient(x0, y0, x1, y1)
    : null;
  if (!gradient || typeof gradient.addColorStop !== 'function') {
    return stops[Math.floor(stops.length / 2)]?.[1] ?? 'transparent';
  }
  for (const [offset, colour] of stops) {
    gradient.addColorStop(clamp(offset, 0, 1), colour);
  }
  return gradient;
};

// --- the preview's look -----------------------------------------------------
//
// Every ruleset draws its objects the same way, the way osu!standard's circles
// have always been drawn here: a white base, the object's colour washed over
// it, a white rim and a soft shadow, all a little see-through. A hit object
// that is hit swells a fifth and fades over 120ms.
const PIECE_MAX_ALPHA = 0.84;
const PIECE_SHADOW_ALPHA = 0.26;
const PIECE_SHADOW_SCALE = 1.12;
const HIT_BURST_MS = 120;
const HIT_BURST_GROWTH = 0.2;
// A vivid piece's share of the white base, and its colour's strength.
const VIVID_BASE_SHARE = 0.15;
const VIVID_TINT_SCALE = 1.1;

const pieceBaseAlpha = (alpha) => clamp((alpha * 0.8) + 0.012, 0, 0.78);
const pieceTintAlpha = (alpha) => clamp(alpha * 0.56, 0, 1);
const pieceOutlineAlpha = (alpha) => clamp((alpha * 1.12) + 0.03, 0, 1);

/**
 * A round piece: shadow, white base, colour, then the rim. A `vivid` piece
 * keeps its colour at full strength over only a trace of the white, for
 * colours that carry meaning (taiko's red and blue) and wash out to pastels
 * otherwise.
 */
const drawPieceCircle = (ctx, x, y, radius, colour, alpha, { vivid = false } = {}) => {
  const outlineWidth = Math.max(1.3, radius * 0.1);

  ctx.fillStyle = withAlpha(BLACK, alpha * PIECE_SHADOW_ALPHA);
  ctx.beginPath();
  ctx.arc(x, y, radius * PIECE_SHADOW_SCALE, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = withAlpha(WHITE, pieceBaseAlpha(alpha) * (vivid ? VIVID_BASE_SHARE : 1));
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = withAlpha(colour, vivid ? clamp(alpha * VIVID_TINT_SCALE, 0, 1) : pieceTintAlpha(alpha));
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = withAlpha(WHITE, pieceOutlineAlpha(alpha));
  ctx.lineWidth = outlineWidth;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.5, radius - (outlineWidth * 0.5)), 0, Math.PI * 2);
  ctx.stroke();
};

// How rounded a bar's corners are, as a share of its thickness: mania's notes
// and catch's catcher both round off this much.
const BAR_CORNER_SHARE = 0.22;
const getBarCornerRadius = (thickness) => Math.min(thickness / 2, Math.max(1, thickness * BAR_CORNER_SHARE));

/** The same piece as a rounded bar, for mania's notes. */
const drawPieceRect = (ctx, x, y, width, height, colour, alpha) => {
  if (!(width > 0) || !(height > 0)) return;
  const radius = getBarCornerRadius(height);
  const outlineWidth = Math.max(1, Math.min(height, width) * 0.1);
  const grow = (Math.min(width, height) * (PIECE_SHADOW_SCALE - 1)) / 2;
  // The bar grown (or, negative, shrunk) by `by` on every side.
  const trace = (by) => {
    const r = Math.max(0, radius + by);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function' && r > 0) {
      ctx.roundRect(x - by, y - by, width + (by * 2), height + (by * 2), r);
    } else {
      ctx.rect(x - by, y - by, width + (by * 2), height + (by * 2));
    }
  };

  ctx.fillStyle = withAlpha(BLACK, alpha * PIECE_SHADOW_ALPHA);
  trace(grow);
  ctx.fill();
  ctx.fillStyle = withAlpha(WHITE, pieceBaseAlpha(alpha));
  trace(0);
  ctx.fill();
  ctx.fillStyle = withAlpha(colour, pieceTintAlpha(alpha));
  ctx.fill();
  ctx.strokeStyle = withAlpha(WHITE, pieceOutlineAlpha(alpha));
  ctx.lineWidth = outlineWidth;
  trace(-outlineWidth / 2);
  ctx.stroke();
};

/**
 * A piece `elapsedMs` after it was hit: how see-through, and how much bigger.
 * Gone once the burst is over.
 */
const getHitBurst = (elapsedMs) => {
  const progress = clamp(elapsedMs / HIT_BURST_MS, 0, 1);
  const easeOut = 1 - ((1 - progress) * (1 - progress));
  return {
    alpha: PIECE_MAX_ALPHA * Math.pow(1 - easeOut, 1.25),
    scale: 1 + (HIT_BURST_GROWTH * easeOut),
  };
};

// --- picking objects out ------------------------------------------------------
//
// A click on the playfield picks out the object under it, and the picked ones
// are ringed in the same amber the timeline rings them in. The rulesets that
// scroll their notes have no fixed place for an object to be, so each frame
// records where it drew everything that can be picked -- a hit target -- and a
// click is tested against those: it can only ever name something on screen.
//
// A hit target is { index, x, y } plus either `radius` (a circle) or `width`
// and `height` (a bar, rounded off by `corner`), in canvas pixels. `index` is
// the object's index in the map's objects, which is what the timeline's
// selection holds. `ring: false` leaves it clickable but never ringed.

// The same amber the timeline rings a picked object in.
const SELECTION_RING_COLOUR = 'rgb(255, 222, 123)';
// How far out from a picked object its ring sits, and how thick it is.
const SELECTION_RING_GAP = 2.5;
const SELECTION_RING_WIDTH = 2;
// Small things -- a tiny droplet, a far-off note -- are still this easy to hit.
const MIN_HIT_RADIUS_PX = 6;

const hitTargetContains = (target, x, y) => {
  if (Number.isFinite(target.radius)) {
    const radius = Math.max(MIN_HIT_RADIUS_PX, target.radius);
    return ((x - target.x) ** 2) + ((y - target.y) ** 2) <= radius * radius;
  }
  const growX = Math.max(0, (MIN_HIT_RADIUS_PX * 2 - target.width) / 2);
  const growY = Math.max(0, (MIN_HIT_RADIUS_PX * 2 - target.height) / 2);
  return x >= target.x - growX && x <= target.x + target.width + growX
    && y >= target.y - growY && y <= target.y + target.height + growY;
};

/**
 * The index of the object under a point, or -1. Targets are in the order they
 * were drawn, so the last one that contains the point is the one on top.
 */
const pickHitTarget = (targets, x, y) => {
  for (let i = (targets?.length ?? 0) - 1; i >= 0; i -= 1) {
    if (hitTargetContains(targets[i], x, y)) return targets[i].index;
  }
  return -1;
};

/** Rings every hit target whose object is in `selection` (a Set of indices). */
const drawSelectionRings = (ctx, targets, selection) => {
  if (!selection || selection.size === 0 || !targets?.length) return;
  let traced = 0;
  ctx.save();
  ctx.beginPath();
  for (const target of targets) {
    if (target.ring === false || !selection.has(target.index)) continue;
    if (Number.isFinite(target.radius)) {
      const radius = target.radius + SELECTION_RING_GAP;
      ctx.moveTo(target.x + radius, target.y);
      ctx.arc(target.x, target.y, radius, 0, Math.PI * 2);
    } else {
      const x = target.x - SELECTION_RING_GAP;
      const y = target.y - SELECTION_RING_GAP;
      const width = target.width + (SELECTION_RING_GAP * 2);
      const height = target.height + (SELECTION_RING_GAP * 2);
      const corner = Math.min((target.corner ?? 0) + SELECTION_RING_GAP, width / 2, height / 2);
      if (typeof ctx.roundRect === 'function') {
        ctx.moveTo(x + corner, y);
        ctx.roundRect(x, y, width, height, corner);
      } else {
        ctx.rect(x, y, width, height);
      }
    }
    traced += 1;
  }
  if (traced > 0) {
    ctx.strokeStyle = SELECTION_RING_COLOUR;
    ctx.lineWidth = SELECTION_RING_WIDTH;
    ctx.stroke();
  }
  ctx.restore();
};

// Interpolation.ValueAt between two colours, as lazer uses for "this much of
// the way to white".
const mixColours = (from, to, amount) => ({
  r: from.r + ((to.r - from.r) * amount),
  g: from.g + ((to.g - from.g) * amount),
  b: from.b + ((to.b - from.b) * amount),
});

// osu!framework's Easing curves, on progress from 0 to 1.
const easeOutQuint = (t) => 1 - ((1 - t) ** 5);
const easeOutSine = (t) => Math.sin((t * Math.PI) / 2);
const easeInSine = (t) => 1 - Math.cos((t * Math.PI) / 2);
const easeInQuad = (t) => t * t;

// Matches osu!lazer's default legacy combo colours.
const DEFAULT_COLOURS = [
  { r: 255, g: 192, b: 0 },
  { r: 0, g: 202, b: 0 },
  { r: 18, g: 124, b: 255 },
  { r: 242, g: 24, b: 57 },
];

const getComboColourIndex = (object) => {
  const oneBasedIndex = Number.isFinite(object?.comboIndexWithOffsets)
    ? object.comboIndexWithOffsets
    : (Number.isFinite(object?.comboIndex) ? object.comboIndex : 1);
  return Math.max(0, oneBasedIndex - 1);
};

const getComboColour = (colours, object) => {
  const palette = (Array.isArray(colours) && colours.length > 0) ? colours : DEFAULT_COLOURS;
  const colourIndex = ((getComboColourIndex(object) % palette.length) + palette.length) % palette.length;
  return palette[colourIndex] || DEFAULT_COLOURS[0];
};

// White is the preview's own ink: a slider's border, the ball, a circle's rim
// and its combo number are all drawn in it over the combo colour. A combo
// colour near enough to white leaves nothing for them to read against, so a
// slider becomes one flat white slab with the ball lost somewhere inside it.
//
// How much a colour has in common with white is the smallest of its three
// channels, and scaling all three by one factor takes that down while leaving
// the hue and the saturation exactly where the mapper put them. Anything whose
// smallest channel is already under the cap goes through untouched, which is
// every ordinary combo colour -- the four defaults among them.
const MAX_COMBO_WHITENESS = 180;

const normalizeComboColour = (colour) => {
  const r = clamp(Math.round(Number(colour?.r) || 0), 0, 255);
  const g = clamp(Math.round(Number(colour?.g) || 0), 0, 255);
  const b = clamp(Math.round(Number(colour?.b) || 0), 0, 255);

  const whiteness = Math.min(r, g, b);
  if (whiteness <= MAX_COMBO_WHITENESS) {
    return { r, g, b };
  }

  const scale = MAX_COMBO_WHITENESS / whiteness;
  return {
    r: Math.round(r * scale),
    g: Math.round(g * scale),
    b: Math.round(b * scale),
  };
};

const assignComboIndices = (objects, mode = 0) => {
  let comboIndex = 0;
  let comboIndexWithOffsets = 0;
  let comboNumber = 1;
  let previousObject = null;

  for (let i = 0; i < objects.length; i += 1) {
    const object = objects[i];
    const isComboBarrier = (mode === 0 || mode === 2) && object.kind === 'spinner';
    const startsCombo = !isComboBarrier && (
      i === 0
      || Boolean(object.newCombo)
      || previousObject?.kind === 'spinner'
    );

    if (startsCombo) {
      comboIndex += 1;
      // Combo offsets are only meaningful when the beatmap explicitly marks
      // the object as a new combo. The forced combo after a spinner/banana
      // shower has no offset, matching osu!lazer's legacy decoder.
      const comboOffset = object.newCombo && !isComboBarrier
        ? Math.max(0, Number(object.comboSkip) || 0)
        : 0;
      if (comboIndexWithOffsets === 0) {
        comboIndexWithOffsets = object.newCombo && !isComboBarrier
          ? 2 + comboOffset
          : 1;
      } else {
        comboIndexWithOffsets += 1 + comboOffset;
      }
      comboNumber = 1;
    } else if (i > 0) {
      comboNumber += 1;
    }

    object.comboIndex = comboIndex;
    object.comboIndexWithOffsets = comboIndexWithOffsets;
    object.comboNumber = comboNumber;
    previousObject = object;
  }
};

/**
 * osu!lazer's StatelessRNG: a value fixed by a seed and a series number, the
 * same on every run. Catch objects draw their rotations, sizes and banana
 * colours from it, seeded by their own start time, so the preview can show
 * the exact ones lazer would.
 */
const MASK_64 = (1n << 64n) - 1n;
const mixStateless = (value) => {
  let x = value;
  x ^= x >> 33n;
  x = (x * 0xff51afd7ed558ccdn) & MASK_64;
  x ^= x >> 33n;
  x = (x * 0xc4ceb9fe1a85ec53n) & MASK_64;
  x ^= x >> 33n;
  return x;
};
const statelessULong = (seed, series = 0) => {
  const combined = (BigInt(series >>> 0) << 32n) | BigInt(seed >>> 0);
  return mixStateless(combined ^ 0x12345678n);
};
const statelessInt = (maxValue, seed, series = 0) => Number(statelessULong(seed, series) % BigInt(maxValue));
const statelessSingle = (seed, series = 0) => (
  Number(statelessULong(seed, series) & 0xffffffn) / 0x1000000
);

export {
  DEFAULT_COLOURS,
  HIT_BURST_MS,
  PIECE_MAX_ALPHA,
  PIECE_SHADOW_SCALE,
  SELECTION_RING_COLOUR,
  LONG_OBJECT_POST_HIT_FADE_MS,
  MAX_COMBO_WHITENESS,
  MAX_MEASURE_LINES,
  MIN_BEAT_LENGTH_MS,
  OSU_HEIGHT,
  OSU_VIEW_HEIGHT,
  OSU_VIEW_WIDTH,
  OSU_WIDTH,
  WHITE,
  assignComboIndices,
  drawPieceCircle,
  drawPieceRect,
  drawSelectionRings,
  easeInQuad,
  easeInSine,
  easeOutQuint,
  easeOutSine,
  formatTime,
  getApproachPreemptMs,
  getBarCornerRadius,
  getComboColour,
  getHitBurst,
  getMaxObjectDurationMs,
  linearGradient,
  mixColours,
  normalizeComboColour,
  pickHitTarget,
  statelessInt,
  statelessSingle,
  withAlpha,
};
