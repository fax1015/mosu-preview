// osu!catch. The timing and movement follow osu!lazer's catch ruleset, and so
// does the life around the catcher -- fruit piling up on its plate and thrown
// off when a combo ends, droplets bouncing off, trails behind a dash -- but
// the fruit themselves are the preview's own plain circles, to sit with the
// other rulesets here. (lazer's Argon skin also lights up a tall flash on
// every catch; the preview leaves it out.)
//
// Everything on screen is a function of the clock: the catcher follows lazer's
// own autoplay (CatchAutoGenerator), so scrubbing back and forth lands it in
// the same place every time, and what sits on its plate and what flies off
// it are worked out once per map rather than carried from one frame to the
// next.
//
// Positions are in osu! pixels on lazer's catch playfield (CatchPlayfield, 512
// wide), with y = 0 at its top. Fruit fall from y = -100 to the catcher at
// y = 340, as in stable (CatchPlayfieldAdjustmentContainer.ScalingContainer).

import { createLegacyRandom } from '../core/beatmapConversion.js';
import { clamp, findFirstIndexAtOrAfter } from '../core/math.js';
import {
  OSU_VIEW_HEIGHT,
  PIECE_MAX_ALPHA,
  OSU_VIEW_WIDTH,
  OSU_WIDTH,
  WHITE,
  easeInQuad,
  easeInSine,
  easeOutQuint,
  easeOutSine,
  drawPieceCircle,
  drawSelectionRings,
  getApproachPreemptMs,
  getBarCornerRadius,
  mixColours,
  pickHitTarget,
  statelessInt,
  statelessSingle,
  withAlpha,
} from './shared.js';

// --- layout -----------------------------------------------------------------

// CatchPlayfieldAdjustmentContainer puts the playfield, 0.8 of a 1024x768 view,
// three quarters of the way down the space that leaves above it: 115.2px of
// 768, which is 72 osu! pixels of the 640x480 view the preview fits.
const FIELD_TOP_IN_VIEW = 72;
const FIELD_LEFT_IN_VIEW = (OSU_VIEW_WIDTH - OSU_WIDTH) / 2;
// stable_fruit_start_position and stable_catcher_y_position.
const FRUIT_START_Y = -100;
const CATCHER_Y = 340;
const FALL_DISTANCE = CATCHER_Y - FRUIT_START_Y;
const CENTRE_X = OSU_WIDTH / 2;

// --- objects ------------------------------------------------------------------

// CatchHitObject.OBJECT_RADIUS: every object is a 128px square, scaled by the
// circle size.
const OBJECT_SIZE = 128;
// How much of that square a fruit is drawn across. lazer's skins fill most of
// it with art; a plain circle that big crowds a preview this size.
const FRUIT_DRAWN_SIZE = 0.6;
// lazer's display size of each kind, relative to a fruit (DrawableTinyDroplet
// halves its scale; DrawableBanana settles at 0.6), and how much of that the
// preview draws: a droplet is a smaller circle than its square suggests.
const PIECE_SCALE = Object.freeze({
  fruit: 1, droplet: 1, tinyDroplet: 0.5, banana: 0.6,
});
const PIECE_DRAWN = Object.freeze({
  fruit: 1, droplet: 0.5, tinyDroplet: 0.5, banana: 1,
});
// DrawableBanana: bananas fall from a random size, between 0.6 and 2.2 times,
// down to 0.6 by the time they are caught.
const BANANA_END_SCALE = 0.6;
const BANANA_SCALE_RANGE = 1.6;
// Banana.getBananaColour: one of three yellows, picked by the start time.
const BANANA_COLOURS = Object.freeze([
  Object.freeze({ r: 255, g: 240, b: 0 }),
  Object.freeze({ r: 255, g: 192, b: 0 }),
  Object.freeze({ r: 214, g: 221, b: 28 }),
]);

// --- the catcher --------------------------------------------------------------

// Catcher.BASE_SIZE, ALLOWED_CATCH_RANGE, BASE_WALK_SPEED, BASE_DASH_SPEED.
const CATCHER_BASE_SIZE = 106.75;
const ALLOWED_CATCH_RANGE = 0.8;
const BASE_WALK_SPEED = 0.5;
const BASE_DASH_SPEED = 1;
// The plate is a flat bar as wide as the part of the catcher that catches.
// Its top sits a fruit's radius above the catch line: a fruit meets the
// catcher with its middle on that line, so it sinks into the plate from the
// top and is gone behind it by the time it is caught, rather than showing
// half of itself through a thin plate and then vanishing. It is a little
// thinner than that radius, so its underside sits just above the line.
const PLATE_THICKNESS = 0.8;
// Caught fruit sit this far down into the plate's top, as a share of their size.
const STACK_SINK = 0.4;
// Catcher.DEFAULT_HYPER_DASH_COLOUR is pure red; this is the preview's softer
// one, for the catcher, its trail and the ring on a fruit that starts one.
const HYPER_DASH_COLOUR = Object.freeze({ r: 255, g: 64, b: 64 });
// Catcher.runHyperDashStateTransition: to red and back over 180ms (OutQuint).
const HYPER_DASH_TRANSITION_MS = 180;
// Catcher: caught_fruit_scale_adjust.
const CAUGHT_OBJECT_SCALE = 0.5;
// Catcher.computePositionInStack: "lenience should be 10 * 10 at standard scale".
const STACK_LENIENCE = 10 / (OBJECT_SIZE / 2);
// Bounds on the stacking simulation. lazer keeps every caught fruit until the
// combo ends; a marathon's thousand-fruit combo would make that quadratic, and
// nothing below the top couple of hundred is visible under the rest anyway.
const STACK_CHECK_LIMIT = 200;
const STACK_MAX_NUDGES = 64;
const PLATE_DRAW_LIMIT = 200;

// Catcher.applyDropAnimation(Explode): up 50px over 250ms, down to 50px below
// where it started over the next 500ms, out sideways six times its distance
// from the catcher's middle over a second, fading out over 750ms.
const DROP_RISE_MS = 250;
const DROP_FALL_MS = 500;
const DROP_RISE = 50;
const DROP_SPREAD = 6;
const DROP_SPREAD_MS = 1000;
const DROP_FADE_MS = 750;
// DrawableCatchHitObject.UpdateHitStateTransforms: a missed object fades out
// over 250ms as it falls on.
const MISS_FADE_MS = 250;

// CatcherArea and CatcherTrail: a dash or hyperdash leaves a copy of the
// catcher every 16ms, each fading out over 800ms (OutQuint) -- from 0.4 in
// lazer, from less here, as the preview's thick plate makes a heavy trail. The
// after-image left as a hyperdash begins rises 10px, grows from 0.95 to 1.2
// times (Easing.In) and fades out over 1.2s.
const TRAIL_INTERVAL_MS = 16;
const TRAIL_FADE_MS = 800;
const TRAIL_ALPHA = 0.25;
const AFTER_IMAGE_MS = 1200;

/**
 * LegacyRulesetExtensions.CalculateScaleFromCircleSize: a fruit's scale. The
 * catcher is twice it (Catcher.calculateScale).
 */
const getCatchObjectScale = (circleSize) => {
  const cs = Number.isFinite(Number(circleSize)) ? Number(circleSize) : 5;
  return (1 - ((0.7 * (cs - 5)) / 5)) / 2;
};

const getCatcherScale = (circleSize) => getCatchObjectScale(circleSize) * 2;

// Catcher.CalculateCatchWidth.
const getCatchWidth = (circleSize) => CATCHER_BASE_SIZE * Math.abs(getCatcherScale(circleSize)) * ALLOWED_CATCH_RANGE;

/**
 * Where a falling object is: osu!lazer's ConstantScrollAlgorithm over the
 * catch time range (DrawableCatchRuleset.GetTimeRange, the approach preempt),
 * from y = -100 a whole time range out to the catcher at y = 340.
 */
const getCatchObjectY = (objectTime, currentTime, timeRangeMs) => (
  CATCHER_Y - (((objectTime - currentTime) / Math.max(1, timeRangeMs)) * FALL_DISTANCE)
);

/**
 * osu!lazer's CatchAutoGenerator: where the catcher is, as replay frames.
 * Every object is caught exactly on time, walking where walking reaches,
 * dashing just as long as it has to otherwise, and moving straight there over
 * the whole gap when even a dash cannot. Objects come in creation order, as
 * lazer walks the beatmap's objects and then what each one made.
 *
 * Unlike lazer's, it lets bananas fall: lazer's autoplay darts under every
 * one, which no player does and which reads as the bot it is. The catcher
 * waits out a banana shower where it is, catching whatever lands on it.
 */
const buildCatchAutoplayFrames = (objectsInCreationOrder, circleSize) => {
  const halfCatchWidth = getCatchWidth(circleSize) * 0.5;
  const times = [];
  const xs = [];
  const dashing = [];
  const addFrame = (time, x, dash = false) => {
    times.push(time);
    xs.push(x);
    dashing.push(dash ? 1 : 0);
  };

  let lastPosition = CENTRE_X;
  let lastTime = 0;
  for (const object of objectsInCreationOrder) {
    if (object.type === 'banana') continue;
    const positionChange = Math.abs(lastPosition - object.x);
    const timeAvailable = object.time - lastTime;
    if (timeAvailable < 0) continue;

    const speedRequired = positionChange === 0 ? 0 : positionChange / timeAvailable;
    const dashRequired = speedRequired > BASE_WALK_SPEED;
    const impossibleJump = speedRequired > BASE_DASH_SPEED;

    if (lastPosition - halfCatchWidth < object.x && lastPosition + halfCatchWidth > object.x) {
      // Already under it.
      lastTime = object.time;
      addFrame(object.time, lastPosition);
      continue;
    }

    if (impossibleJump) {
      addFrame(object.time, object.x);
    } else if (object.hyperDash) {
      addFrame(object.time - timeAvailable, lastPosition);
      addFrame(object.time, object.x);
    } else if (dashRequired) {
      // Dash first, then walk the rest of the way.
      const timeAtNormalSpeed = positionChange / BASE_WALK_SPEED;
      const timeWeNeedToSave = timeAtNormalSpeed - timeAvailable;
      const timeAtDashSpeed = timeWeNeedToSave / 2;
      const midPosition = lastPosition + ((object.x - lastPosition) * (timeAtDashSpeed / timeAvailable));
      addFrame(object.time - timeAvailable + 1, lastPosition, true);
      addFrame(object.time - timeAvailable + timeAtDashSpeed, midPosition);
      addFrame(object.time, object.x);
    } else {
      const timeBefore = positionChange / BASE_WALK_SPEED;
      addFrame(object.time - timeBefore, lastPosition);
      addFrame(object.time, object.x);
    }

    lastTime = object.time;
    lastPosition = object.x;
  }

  return {
    times: Float64Array.from(times),
    xs: Float64Array.from(xs),
    dashing: Uint8Array.from(dashing),
  };
};

/**
 * The catcher's x at a time: CatchFramedReplayInputHandler interpolates
 * straight between the frames either side. It stands in the middle of the
 * field until the first one.
 */
const getCatcherXAt = (frames, time) => {
  const { times, xs } = frames;
  if (times.length === 0 || !(time >= times[0])) return CENTRE_X;
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] <= time) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  if (index >= times.length - 1) return xs[times.length - 1];
  const span = times[index + 1] - times[index];
  if (!(span > 0)) return xs[index + 1];
  return xs[index] + ((xs[index + 1] - xs[index]) * ((time - times[index]) / span));
};

/**
 * Catcher.OnNewResult's hyperdash state over the map: from catching a fruit or
 * droplet that leads a hyperdash until the next one is caught. Back-to-back
 * hyperdashes are one stretch: the catcher only turns red, and leaves its
 * after-image, as one begins. Tiny droplets do not touch it; a banana ends it.
 */
const buildHyperDashSpans = (objects, frames) => {
  const spans = [];
  let start = null;
  for (const object of objects) {
    if (object.type === 'tinyDroplet') continue;
    let hyper = false;
    if (object.hyperDash && Number.isFinite(object.hyperDashTargetTime)) {
      const catcherX = getCatcherXAt(frames, object.time);
      const timeDifference = object.hyperDashTargetTime - object.time;
      const velocity = (object.hyperDashTargetX - catcherX) / Math.max(1, timeDifference - (1000 / 60));
      hyper = Math.abs(velocity) / BASE_DASH_SPEED > 1 && catcherX !== object.hyperDashTargetX;
    }
    if (hyper && start === null) {
      start = object.time;
    } else if (!hyper && start !== null) {
      spans.push({ start, end: object.time });
      start = null;
    }
  }
  if (start !== null) spans.push({ start, end: Infinity });
  return spans;
};

// Autoplay's dash flag holds from the frame that sets it to the next frame.
const buildDashSpans = (frames) => {
  const spans = [];
  for (let i = 0; i < frames.times.length - 1; i += 1) {
    if (frames.dashing[i]) spans.push({ start: frames.times[i], end: frames.times[i + 1] });
  }
  return spans;
};

/**
 * Everything about a catch map that does not change from frame to frame.
 * `palette` is the combo colours to draw with.
 */
const buildCatchModel = (mapData, palette) => {
  const catchObjects = Array.isArray(mapData?.catchObjects) ? mapData.catchObjects : [];
  const sourceObjects = Array.isArray(mapData?.objects) ? mapData.objects : [];
  const colours = Array.isArray(palette) && palette.length > 0 ? palette : [WHITE];
  const circleSize = mapData?.circleSize;
  const objectScale = getCatchObjectScale(circleSize);
  // CatchHitObject.TimePreempt is DifficultyRangeInt: whole milliseconds. The
  // scroll itself runs on the unrounded range.
  const timeRangeMs = getApproachPreemptMs(mapData?.approachRate);
  const preemptMs = Math.trunc(timeRangeMs);

  // CatchHitObject.UpdateComboInformation: a top-level object is the last of
  // its combo when the next one starts a new combo, and a banana shower always
  // is. The flag then passes to the last thing it made.
  const isShower = (object) => object?.kind === 'spinner' || object?.kind === 'hold';
  const lastNestedRenderId = new Map();
  for (const object of catchObjects) {
    const previous = lastNestedRenderId.get(object.sourceObjectIndex);
    if (previous === undefined || object.renderId > previous) {
      lastNestedRenderId.set(object.sourceObjectIndex, object.renderId);
    }
  }
  const topLevelEndsCombo = (index) => {
    const object = sourceObjects[index];
    if (isShower(object)) return true;
    const next = sourceObjects[index + 1];
    return Boolean(object && next && !isShower(next) && next.comboIndex !== object.comboIndex);
  };

  const objects = catchObjects
    .map((source, index) => {
      const renderId = Number.isInteger(source.renderId) ? source.renderId : index;
      const seed = Math.trunc(source.time) | 0;
      // PalpableCatchHitObject.GetComboColour: a catch object takes the
      // colour after its top-level object's index in the map, not its
      // combo's -- every fruit a new colour, a juice stream one colour.
      const colourIndex = ((source.sourceObjectIndex ?? 0) + 1) % colours.length;
      return {
        time: source.time,
        x: clamp(Number(source.x) || 0, 0, OSU_WIDTH),
        type: source.type,
        renderId,
        seed,
        sourceObjectIndex: source.sourceObjectIndex,
        hyperDash: Boolean(source.hyperDash),
        hyperDashTargetTime: source.hyperDashTargetTime,
        hyperDashTargetX: source.hyperDashTargetX,
        colour: source.type === 'banana'
          ? BANANA_COLOURS[statelessInt(3, seed)]
          : colours[colourIndex] || WHITE,
        appearTime: source.time - preemptMs,
        lastInCombo: lastNestedRenderId.get(source.sourceObjectIndex) === renderId
          && topLevelEndsCombo(source.sourceObjectIndex),
      };
    })
    .sort((a, b) => a.time - b.time || a.renderId - b.renderId);

  const frames = buildCatchAutoplayFrames([...objects].sort((a, b) => a.renderId - b.renderId), circleSize);

  // What lands on the plate, and when it leaves. Catcher.placeCaughtObject
  // keeps fruit and bananas until the last object of a combo is caught, then
  // throws them all off (Explode: a banana shower's end explodes whether its
  // last banana was caught or not); a droplet bounces off as soon as it lands.
  // computePositionInStack nudges each new arrival until it is clear of what
  // is already there; lazer does that with an unseeded generator, the preview
  // with one seeded by the combo. Everything but a banana is caught; a banana
  // is caught only if it comes down within the catcher's reach
  // (Catcher.CanCatch), since the catcher no longer goes after them.
  const halfCatchWidth = getCatchWidth(circleSize) * 0.5;
  const segments = [];
  let plate = [];
  let segmentStart = 0;
  let random = createLegacyRandom(1);
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    if (index === segmentStart) {
      random = createLegacyRandom(object.seed);
    }
    const catcherX = getCatcherXAt(frames, object.time);
    object.leaveCatcherX = catcherX;
    object.missed = object.type === 'banana'
      && !(object.x >= catcherX - halfCatchWidth && object.x <= catcherX + halfCatchWidth);
    if (object.missed) {
      // Never reaches the plate: it falls on past the catcher (drawFalling).
      object.plateX = object.x - catcherX;
      object.plateY = 0;
      object.staysOnPlate = false;
      object.leaveTime = Infinity;
    } else {
      const displaySize = OBJECT_SIZE * objectScale * PIECE_SCALE[object.type];
      const adjustedRadius = displaySize * STACK_LENIENCE;
      const checkDistance = adjustedRadius * adjustedRadius;
      let plateX = object.x - catcherX;
      let plateY = 0;
      const overlaps = () => {
        for (let i = Math.max(0, plate.length - STACK_CHECK_LIMIT); i < plate.length; i += 1) {
          const dx = plate[i].plateX - plateX;
          const dy = plate[i].plateY - plateY;
          if ((dx * dx) + (dy * dy) < checkDistance) return true;
        }
        return false;
      };
      for (let nudge = 0; nudge < STACK_MAX_NUDGES && overlaps(); nudge += 1) {
        plateX += (random.nextDouble() * 2 * adjustedRadius) - adjustedRadius;
        plateY -= random.nextDouble() * 5;
      }
      object.plateX = plateX;
      object.plateY = plateY;
      object.staysOnPlate = object.type === 'fruit' || object.type === 'banana';
      object.leaveTime = object.staysOnPlate ? Infinity : object.time;
      if (object.staysOnPlate) plate.push(object);
    }
    if (object.lastInCombo) {
      for (const item of plate) {
        item.leaveTime = object.time;
        item.leaveCatcherX = catcherX;
      }
      segments.push({ start: segmentStart, end: index, explodeTime: object.time });
      plate = [];
      segmentStart = index + 1;
    }
  }
  if (segmentStart < objects.length) {
    segments.push({ start: segmentStart, end: objects.length - 1, explodeTime: Infinity });
  }
  const segmentOf = new Int32Array(objects.length);
  segments.forEach((segment, segmentIndex) => {
    for (let i = segment.start; i <= segment.end; i += 1) segmentOf[i] = segmentIndex;
  });

  return {
    objects,
    frames,
    segments,
    segmentOf,
    hyperDashSpans: buildHyperDashSpans(objects, frames),
    dashSpans: buildDashSpans(frames),
    objectScale,
    catcherScale: getCatcherScale(circleSize),
    timeRangeMs,
  };
};

// A banana's size while it falls, relative to where it settles. Worked out
// from lazer's StatelessRNG on first sight, not with the model: a 64-bit hash
// per banana is cheap once, not for a long shower's worth before the first
// frame.
const bananaScaleAt = (object, time) => {
  if (object.bananaStartScale === undefined) {
    object.bananaStartScale = BANANA_END_SCALE + (BANANA_SCALE_RANGE * statelessSingle(object.seed, 3));
  }
  const progress = clamp((time - object.appearTime) / Math.max(1, object.time - object.appearTime), 0, 1);
  return (object.bananaStartScale + ((BANANA_END_SCALE - object.bananaStartScale) * progress)) / BANANA_END_SCALE;
};

// The index of the last span to have started by `time`, or -1.
const lastSpanStartedBy = (spans, time) => {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (spans[middle].start <= time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
};

/** The catcher's colour: red while it hyperdashes, faded to and from. */
const getCatcherColourAt = (spans, time) => {
  const index = lastSpanStartedBy(spans, time);
  if (index >= 0) {
    const span = spans[index];
    if (time < span.end) {
      const progress = clamp((time - span.start) / HYPER_DASH_TRANSITION_MS, 0, 1);
      return { colour: mixColours(WHITE, HYPER_DASH_COLOUR, easeOutQuint(progress)), hyper: true };
    }
    const sinceEnd = time - span.end;
    if (sinceEnd < HYPER_DASH_TRANSITION_MS) {
      return {
        colour: mixColours(HYPER_DASH_COLOUR, WHITE, easeOutQuint(sinceEnd / HYPER_DASH_TRANSITION_MS)),
        hyper: false,
      };
    }
  }
  return { colour: WHITE, hyper: false };
};

/**
 * The catch playfield in a canvas: lazer's 1024x768 layout, which is the
 * legacy 640x480 view at 1.6x, fitted the way osu!standard's is.
 */
const getCatchPlayfieldLayout = (canvasWidth, canvasHeight) => {
  const width = Math.max(1, Number(canvasWidth) || 1);
  const height = Math.max(1, Number(canvasHeight) || 1);
  const scale = Math.min(width / OSU_VIEW_WIDTH, height / OSU_VIEW_HEIGHT);
  const viewX = (width - (OSU_VIEW_WIDTH * scale)) / 2;
  const viewY = (height - (OSU_VIEW_HEIGHT * scale)) / 2;
  return {
    scale,
    fieldX: viewX + (FIELD_LEFT_IN_VIEW * scale),
    fieldY: viewY + (FIELD_TOP_IN_VIEW * scale),
    fieldWidth: OSU_WIDTH * scale,
  };
};

const CATCH_BACKGROUND = 'rgba(19, 21, 26, 0.95)';

// A fruit is the preview's own round piece (see drawPieceCircle), with a red
// ring outside it on one that starts a hyperdash. Tiny droplets are specks of
// their colour. `ringAlpha` fades the ring on its own: it is wider than the
// fruit, so it would still show over the plate once the fruit has gone in.
const drawPiece = (ctx, object, x, y, radius, alpha = 1, ringAlpha = 1) => {
  if (!(alpha > 0.002)) return;
  if (object.type === 'tinyDroplet') {
    ctx.fillStyle = withAlpha(mixColours(object.colour, WHITE, 0.35), PIECE_MAX_ALPHA * alpha);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.2, radius), 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const r = Math.max(2, radius);
  drawPieceCircle(ctx, x, y, r, object.colour, PIECE_MAX_ALPHA * alpha);
  if (object.hyperDash && ringAlpha > 0.002) {
    ctx.strokeStyle = withAlpha(HYPER_DASH_COLOUR, PIECE_MAX_ALPHA * alpha * ringAlpha);
    ctx.lineWidth = Math.max(1.2, r * 0.18);
    ctx.beginPath();
    ctx.arc(x, y, r + Math.max(2, r * 0.3), 0, Math.PI * 2);
    ctx.stroke();
  }
};

const drawPlate = (ctx, x, y, width, height, colour, alpha) => {
  if (!(alpha > 0.002)) return;
  ctx.fillStyle = withAlpha(colour, alpha);
  const left = x - (width / 2);
  const top = y - (height / 2);
  // Rounded off as much as a mania note is.
  const radius = getBarCornerRadius(height);
  if (typeof ctx.roundRect === 'function' && radius > 0) {
    ctx.beginPath();
    ctx.roundRect(left, top, width, height, radius);
    ctx.fill();
  } else {
    ctx.fillRect(left, top, width, height);
  }
};

/**
 * A banana's streak: a level line of light through it, fading out between 30%
 * and 80% of the way down (after ArgonBananaPiece's lens flare, without the
 * rest of it).
 */
const drawBananaStreak = (ctx, object, x, y, radius, time) => {
  const length = object.time - object.appearTime;
  const progress = clamp((time - (object.appearTime + (length * 0.3))) / Math.max(1, length * 0.5), 0, 1);
  const alpha = 1 - easeOutQuint(progress);
  if (!(alpha > 0.002)) return;
  const reach = radius * 4;
  const gradient = typeof ctx.createLinearGradient === 'function'
    ? ctx.createLinearGradient(x - reach, 0, x + reach, 0)
    : null;
  if (!gradient || typeof gradient.addColorStop !== 'function') return;
  gradient.addColorStop(0, withAlpha(WHITE, 0));
  gradient.addColorStop(0.5, withAlpha(WHITE, 0.5 * alpha));
  gradient.addColorStop(1, withAlpha(WHITE, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(x - reach, y - Math.max(0.5, radius * 0.06), reach * 2, Math.max(1, radius * 0.12));
};

export class CatchRenderer {
  constructor(host) {
    this.host = host;
    this.model = null;
    this.modelKey = null;
    // What the last frame drew that a click can pick out.
    this.hitTargets = [];
  }

  get mapData() { return this.host.mapData; }

  setBeatmap(mapData) {
    this.model = null;
    this.modelKey = null;
    // The timeline colours catch objects by their source object's combo.
    if ((mapData?.mode ?? 0) === 2 && Array.isArray(mapData?.catchObjects) && Array.isArray(mapData?.objects)) {
      for (const catchObject of mapData.catchObjects) {
        const sourceObject = mapData.objects[catchObject.sourceObjectIndex];
        if (sourceObject) {
          catchObject.comboIndex = sourceObject.comboIndex;
          catchObject.comboIndexWithOffsets = sourceObject.comboIndexWithOffsets;
        }
      }
    }
  }

  // Worked out the first time a map is drawn, and again only if its objects,
  // circle size, approach rate or colours change under it.
  getModel() {
    const mapData = this.mapData;
    const palette = this.host.comboColours;
    const key = this.modelKey;
    if (
      this.model
      && key
      && key.catchObjects === mapData?.catchObjects
      && key.circleSize === mapData?.circleSize
      && key.approachRate === mapData?.approachRate
      && key.palette === palette
    ) {
      return this.model;
    }
    this.model = this.buildModel(mapData, palette);
    this.modelKey = {
      catchObjects: mapData?.catchObjects,
      circleSize: mapData?.circleSize,
      approachRate: mapData?.approachRate,
      palette,
    };
    return this.model;
  }

  // Separate so a test can count how often it runs.
  buildModel(mapData, palette) {
    return buildCatchModel(mapData, palette);
  }

  render(ctx, width, height) {
    ctx.fillStyle = CATCH_BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    this.hitTargets = [];

    const model = this.getModel();
    const time = this.host.currentTimeMs;
    const layout = getCatchPlayfieldLayout(width, height);
    const { scale } = layout;
    // A fruit's drawn radius in osu! pixels; other kinds scale from it.
    const fruitRadius = (OBJECT_SIZE / 2) * model.objectScale * FRUIT_DRAWN_SIZE;
    const plateTop = CATCHER_Y - fruitRadius;
    const plateThickness = fruitRadius * PLATE_THICKNESS;
    const view = {
      time,
      scale,
      toX: (x) => layout.fieldX + (x * scale),
      toY: (y) => layout.fieldY + (y * scale),
      fruitRadius: fruitRadius * scale,
      catcherX: getCatcherXAt(model.frames, time),
      plateTop,
      // Where caught fruit sit: on the plate, a little way into it.
      plateY: plateTop - (fruitRadius * CAUGHT_OBJECT_SCALE * (1 - STACK_SINK)),
      plateWidth: getCatchWidth(this.mapData?.circleSize) * scale,
      plateHeight: Math.max(3, plateThickness * scale),
      // The last object already caught.
      lastCaught: findFirstIndexAtOrAfter(model.objects, time + 1e-9) - 1,
    };
    const catcherY = view.toY(plateTop + (plateThickness / 2));

    // The floor the catcher runs along, across the field.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fillRect(layout.fieldX, Math.round(catcherY), layout.fieldWidth, 1);

    // Thrown-off fruit first, then the plate's, then what is still falling,
    // in the order CatchPlayfield stacks them; the catcher and its trails
    // over them all.
    this.drawDropped(ctx, model, view);
    this.drawPlateStack(ctx, model, view);
    this.drawFalling(ctx, model, view);
    const catcherColour = getCatcherColourAt(model.hyperDashSpans, time);
    drawPlate(ctx, view.toX(view.catcherX), catcherY, view.plateWidth, view.plateHeight, catcherColour.colour, 0.85);
    this.drawTrails(ctx, model, view);
    drawSelectionRings(ctx, this.hitTargets, this.host.getSelectionToRing?.());
  }

  // The object under a point, from what the last frame drew; see pickHitTarget.
  // A piece of a juice stream or a banana shower picks out the whole of it.
  objectIndexAtPoint(canvasX, canvasY) {
    return pickHitTarget(this.hitTargets, canvasX, canvasY);
  }

  // Everything still in the air: what will be caught falls into the plate,
  // and a banana the catcher let go falls on past it, fading out as lazer's
  // missed objects do (DrawableCatchHitObject: out over 250ms).
  drawFalling(ctx, model, view) {
    const { objects } = model;
    const { time } = view;
    // DrawableCatchHitObject lives from a preempt before its time, when it is
    // at y = -100, just above the top of the view.
    const lastAlive = findFirstIndexAtOrAfter(objects, time + model.timeRangeMs + 1e-9) - 1;
    const plateTopY = view.toY(view.plateTop);
    const draw = (object, alpha) => {
      const x = view.toX(object.x);
      const y = view.toY(getCatchObjectY(object.time, time, model.timeRangeMs));
      let radius = view.fruitRadius * PIECE_SCALE[object.type] * PIECE_DRAWN[object.type];
      if (object.type === 'banana') {
        radius *= bananaScaleAt(object, time);
        drawBananaStreak(ctx, object, x, y, radius, time);
      }
      // Gone by the time the fruit's middle reaches the plate's top.
      const ringAlpha = object.missed ? 1 : clamp((plateTopY - y) / Math.max(1, radius), 0, 1);
      drawPiece(ctx, object, x, y, radius, alpha, ringAlpha);
      // Tiny droplets can be clicked, but a picked stream is ringed by its
      // fruit and droplets alone: a ring on every speck would bury it.
      this.hitTargets.push({
        index: object.sourceObjectIndex,
        x,
        y,
        radius,
        ring: object.type !== 'tinyDroplet',
      });
    };

    // Missed bananas, still falling or just past the catcher.
    for (let i = Math.min(objects.length - 1, lastAlive); i >= 0; i -= 1) {
      const object = objects[i];
      const age = time - object.time;
      if (age >= MISS_FADE_MS) break;
      if (object.missed) draw(object, age > 0 ? 1 - (age / MISS_FADE_MS) : 1);
    }

    // Nothing that will be caught shows below the plate's top: it goes into it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(-1e5, -1e5, 2e5, plateTopY + 1e5);
    ctx.clip();
    // Latest first, so the nearest object is drawn on top.
    for (let i = Math.min(objects.length - 1, lastAlive); i > view.lastCaught; i -= 1) {
      if (!objects[i].missed) draw(objects[i], 1);
    }
    ctx.restore();
  }

  // Caught fruit and bananas, at half their size, until their combo ends.
  drawPlateStack(ctx, model, view) {
    if (view.lastCaught < 0) return;
    const segment = model.segments[model.segmentOf[view.lastCaught]];
    if (!segment || segment.explodeTime <= view.time) return;
    let drawn = 0;
    for (let i = view.lastCaught; i >= segment.start && drawn < PLATE_DRAW_LIMIT; i -= 1) {
      const object = model.objects[i];
      if (!object.staysOnPlate) continue;
      drawn += 1;
      const radius = view.fruitRadius * PIECE_SCALE[object.type] * PIECE_DRAWN[object.type] * CAUGHT_OBJECT_SCALE;
      drawPiece(ctx, object, view.toX(view.catcherX + object.plateX), view.toY(view.plateY + object.plateY), radius);
    }
  }

  // Droplets bouncing off the plate, and a finished combo's fruit thrown off.
  drawDropped(ctx, model, view) {
    if (view.lastCaught < 0) return;
    const { objects, segments } = model;
    const { time } = view;
    const drawDrop = (object) => {
      const age = time - object.leaveTime;
      if (!(age >= 0) || age >= DROP_FADE_MS) return;
      const startY = view.plateY + object.plateY;
      const y = age < DROP_RISE_MS
        ? startY - (DROP_RISE * easeOutSine(age / DROP_RISE_MS))
        : (startY - DROP_RISE) + (2 * DROP_RISE * easeInSine(Math.min(1, (age - DROP_RISE_MS) / DROP_FALL_MS)));
      const spread = (object.plateX / model.catcherScale) * DROP_SPREAD * Math.min(1, age / DROP_SPREAD_MS);
      const x = object.leaveCatcherX + object.plateX + spread;
      const radius = view.fruitRadius * PIECE_SCALE[object.type] * PIECE_DRAWN[object.type] * CAUGHT_OBJECT_SCALE;
      drawPiece(ctx, object, view.toX(x), view.toY(y), radius, 1 - (age / DROP_FADE_MS));
    };

    // Whole combos thrown off in the last 750ms.
    for (let s = model.segmentOf[view.lastCaught]; s >= 0; s -= 1) {
      const segment = segments[s];
      if (segment.explodeTime > time) continue;
      if (segment.explodeTime <= time - DROP_FADE_MS) break;
      let drawn = 0;
      for (let i = segment.end; i >= segment.start && drawn < PLATE_DRAW_LIMIT; i -= 1) {
        if (objects[i].staysOnPlate) {
          drawn += 1;
          drawDrop(objects[i]);
        }
      }
    }
    // Droplets, each gone as soon as it landed.
    for (let i = view.lastCaught; i >= 0 && objects[i].time > time - DROP_FADE_MS; i -= 1) {
      if (!objects[i].staysOnPlate) drawDrop(objects[i]);
    }
  }

  /**
   * CatcherTrailDisplay: copies of the plate left behind while the catcher
   * dashes (white) or hyperdashes (red), and the larger after-image a
   * hyperdash starts with.
   */
  drawTrails(ctx, model, view) {
    const { time } = view;
    const y = view.toY(view.plateTop) + (view.plateHeight / 2);
    const drawSpanTrails = (spans, colour) => {
      for (let s = lastSpanStartedBy(spans, time); s >= 0; s -= 1) {
        const span = spans[s];
        if (span.end <= time - TRAIL_FADE_MS) break;
        const first = Math.max(0, Math.ceil((time - TRAIL_FADE_MS - span.start) / TRAIL_INTERVAL_MS));
        for (let k = first; ; k += 1) {
          const trailTime = span.start + (k * TRAIL_INTERVAL_MS);
          if (trailTime > time || trailTime >= span.end) break;
          const alpha = TRAIL_ALPHA * (1 - easeOutQuint((time - trailTime) / TRAIL_FADE_MS));
          drawPlate(ctx, view.toX(getCatcherXAt(model.frames, trailTime)), y, view.plateWidth, view.plateHeight, colour, alpha);
        }
      }
    };
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    drawSpanTrails(model.dashSpans, WHITE);
    drawSpanTrails(model.hyperDashSpans, HYPER_DASH_COLOUR);
    for (let s = lastSpanStartedBy(model.hyperDashSpans, time); s >= 0; s -= 1) {
      const span = model.hyperDashSpans[s];
      const age = time - span.start;
      if (age >= AFTER_IMAGE_MS) break;
      const progress = easeInQuad(age / AFTER_IMAGE_MS);
      const grow = 0.95 + (0.25 * progress);
      drawPlate(
        ctx,
        view.toX(getCatcherXAt(model.frames, span.start)),
        y - (10 * progress * model.catcherScale * view.scale),
        view.plateWidth * grow,
        view.plateHeight * grow,
        HYPER_DASH_COLOUR,
        0.6 * (1 - (age / AFTER_IMAGE_MS)),
      );
    }
    ctx.restore();
  }
}

export {
  BANANA_COLOURS,
  CATCHER_Y,
  FRUIT_START_Y,
  buildCatchAutoplayFrames,
  buildCatchModel,
  getCatchObjectScale,
  getCatchObjectY,
  getCatchPlayfieldLayout,
  getCatchWidth,
  getCatcherColourAt,
  getCatcherScale,
  getCatcherXAt,
};
