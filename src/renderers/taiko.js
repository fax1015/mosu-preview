// osu!taiko: notes scrolling right to left along one lane into a judgement
// circle, the lane running across the whole preview.
// Notes are the preview's own round pieces (see drawPieceCircle), in their
// full red and blue rather than washed over white, and each one swells and
// fades on the circle as it is hit, lighting the circle in its colour.

import { getTimingSections, getTimingStateAt } from '../core/controlPoints.js';
import { clamp, findFirstIndexAtOrAfter } from '../core/math.js';
import {
  HIT_BURST_MS,
  LONG_OBJECT_POST_HIT_FADE_MS,
  MAX_MEASURE_LINES,
  MIN_BEAT_LENGTH_MS,
  OSU_HEIGHT,
  OSU_WIDTH,
  PIECE_MAX_ALPHA,
  PLAYFIELD_BACKGROUND,
  WHITE,
  buildPrefixMaxEndTimes,
  drawPieceCircle,
  drawSelectionRings,
  findFirstIndexWithEndAtOrAfter,
  findLastIndexAtOrBefore,
  getHitBurst,
  linearGradient,
  pickHitTarget,
  withAlpha,
} from './shared.js';

// How long the judgement circle stays lit in a note's colour after a hit.
const RECEPTOR_FLASH_MS = 160;
const MIN_VISIBLE_AHEAD_MS = 8000;
const MAX_VISIBLE_AHEAD_MS = 60000;
const DON_COLOR = Object.freeze({ r: 242, g: 86, b: 86 });
const KAT_COLOR = Object.freeze({ r: 92, g: 166, b: 255 });
const ROLL_COLOR = Object.freeze({ r: 255, g: 196, b: 84 });

/**
 * Canvas pixels per osu! pixel: the scale at which a 512x384 field fits the
 * canvas. Everything in the lane -- its height, the notes, the judgement
 * circle and how fast notes travel -- is sized by this one number, so no shape
 * of canvas stretches the lane one way more than the other.
 */
const getTaikoUnit = (canvasWidth, canvasHeight) => Math.max(
  0.01,
  Math.min((Number(canvasWidth) || 1) / OSU_WIDTH, (Number(canvasHeight) || 1) / OSU_HEIGHT),
);

const isKatNote = (object) => {
  const hitSound = Number.isFinite(object.hitSound) ? object.hitSound : 0;
  return object.taikoType === 'kat' || object.taikoType === 'rim'
    || ((object.taikoType !== 'don') && (hitSound & (2 | 8)) !== 0);
};

const isFinishNote = (object) => {
  const hitSound = Number.isFinite(object.hitSound) ? object.hitSound : 0;
  return Boolean(object.taikoStrong) || ((hitSound & 4) !== 0);
};

const isRoll = (object) => object.kind === 'slider' || object.kind === 'hold' || object.taikoType === 'drumroll';

export class TaikoRenderer {
  constructor(host) {
    this.host = host;
    // What the last frame drew that a click can pick out.
    this.hitTargets = [];
    this.prefixMaxEnd = null;
    this.prefixMaxEndObjects = null;
  }

  get mapData() { return this.host.mapData; }

  get currentTimeMs() { return this.host.currentTimeMs; }

  get maxObjectDurationMs() { return this.host.maxObjectDurationMs; }

  setBeatmap(mapData) {
    this.hitTargets = [];
    if ((mapData?.mode ?? 0) === 1 && Array.isArray(mapData?.objects)) {
      this.prefixMaxEndObjects = mapData.objects;
      this.prefixMaxEnd = buildPrefixMaxEndTimes(mapData.objects);
    } else {
      this.prefixMaxEndObjects = null;
      this.prefixMaxEnd = null;
    }
  }

  dispose() {
    this.hitTargets = [];
    this.prefixMaxEndObjects = null;
    this.prefixMaxEnd = null;
  }

  getPrefixMaxEnd(objects) {
    if (this.prefixMaxEndObjects !== objects || !this.prefixMaxEnd || this.prefixMaxEnd.length !== objects.length) {
      this.prefixMaxEndObjects = objects;
      this.prefixMaxEnd = buildPrefixMaxEndTimes(objects);
    }
    return this.prefixMaxEnd;
  }

  getControlPoints() {
    return Array.isArray(this.mapData?.timingControlPoints) ? this.mapData.timingControlPoints : [];
  }

  // The field is the whole preview, as it is for the other rulesets, with the
  // lane running across it from edge to edge. Its size and its speed both come
  // from one scale -- a 512x384 field fitted in the canvas -- so a canvas of
  // another shape (a difficulty beside another, half the width) draws the
  // lane smaller rather than stretching it: notes cross the same share of the
  // lane in the same time, instead of crawling across a narrow one or racing
  // across a wide one at the size of the full preview.
  render(ctx, width, height) {
    ctx.fillStyle = PLAYFIELD_BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    const unit = getTaikoUnit(width, height);
    this.renderLane(ctx, width, height, unit);
  }

  getPixelsPerMs(time, playfieldWidth) {
    const timing = getTimingStateAt(this.getControlPoints(), time);
    const baseSliderVelocity = Number.isFinite(this.mapData?.sliderMultiplier) && this.mapData.sliderMultiplier > 0
      ? this.mapData.sliderMultiplier
      : 1.4;
    const scale = playfieldWidth / OSU_WIDTH;
    const pixelsPerBeat = 100 * baseSliderVelocity * timing.svMultiplier * scale;
    return pixelsPerBeat / Math.max(1, timing.beatLength);
  }

  getMeasureLines(visibleStart, visibleEnd) {
    const sections = getTimingSections(this.getControlPoints());
    if (sections.length === 0 || visibleEnd < visibleStart) {
      return [];
    }

    const lines = [];
    const firstSection = Math.max(0, findLastIndexAtOrBefore(sections, visibleStart, (section) => section.time));
    for (let i = firstSection; i < sections.length && lines.length < MAX_MEASURE_LINES; i += 1) {
      const point = sections[i];
      const sectionStart = point.time;
      if (sectionStart > visibleEnd) {
        break;
      }
      const meter = Number.isFinite(point.meter) && point.meter > 0 ? point.meter : 4;
      // Held to the shortest beat osu! accepts, so a corrupt beat length cannot
      // turn one frame into millions of bar lines.
      const measureLength = Math.max(MIN_BEAT_LENGTH_MS, point.beatLength) * meter;
      if (!Number.isFinite(measureLength) || measureLength <= 0) {
        continue;
      }
      const hasNextSection = i + 1 < sections.length;
      const sectionEnd = hasNextSection ? sections[i + 1].time : visibleEnd;
      const sectionVisibleStart = Math.max(visibleStart, sectionStart);
      const sectionVisibleEnd = Math.min(visibleEnd, sectionEnd);
      if (sectionVisibleEnd < sectionVisibleStart) {
        continue;
      }

      let measureIndex = Math.floor((sectionVisibleStart - sectionStart) / measureLength);
      if ((sectionStart + (measureIndex * measureLength)) < sectionVisibleStart) {
        measureIndex += 1;
      }

      for (; lines.length < MAX_MEASURE_LINES; measureIndex += 1) {
        const measureTime = sectionStart + (measureIndex * measureLength);
        // Not "> end": a time too large to tell one bar from the next compares
        // false both ways, and the loop has to end on that as well.
        if (hasNextSection ? !(measureTime < sectionEnd - 1e-6) : !(measureTime <= sectionVisibleEnd)) {
          break;
        }
        if (!(measureTime <= visibleEnd)) {
          break;
        }
        if (measureIndex === 0 && point.omitFirstBarLine) {
          if (!(sectionStart + ((measureIndex + 1) * measureLength) > measureTime)) {
            break;
          }
          continue;
        }
        lines.push(measureTime);
        if (!(sectionStart + ((measureIndex + 1) * measureLength) > measureTime)) {
          break;
        }
      }
    }

    return lines;
  }

  // The lane across a `width` x `height` canvas, everything in it sized by
  // `unit` (see getTaikoUnit). The judgement circle sits the same distance in
  // from the left whatever the canvas's shape, and notes come in from its
  // right edge: a wider canvas shows further ahead, not faster notes.
  renderLane(ctx, width, height, unit) {
    this.hitTargets = [];
    const playfieldX = 0;
    const playfieldY = 0;
    // The field the lane is scaled to: as wide as the canvas when the canvas
    // has the preview's own shape.
    const fieldWidth = OSU_WIDTH * unit;
    const objects = this.mapData.objects;
    const currentTime = this.currentTimeMs;
    const laneY = height * 0.5;
    const laneHeight = OSU_HEIGHT * unit * 0.22;
    const judgeX = fieldWidth * 0.12;
    const laneRightOverflow = Math.max(18, fieldWidth * 0.055);
    const laneRightEdge = width + laneRightOverflow;
    // Notes fade in over the far end of the lane, a little short of the
    // canvas's right edge.
    const noteTravelWidth = (width - judgeX - (fieldWidth * 0.06)) + laneRightOverflow;
    const rightFadeEndX = judgeX + noteTravelWidth;
    const rightFadeWidth = Math.max(12, noteTravelWidth * 0.07);
    const rightFadeStartX = rightFadeEndX - rightFadeWidth;
    const leftMeasureFadeWidth = Math.max(24, judgeX - playfieldX);
    const currentTaikoSpeed = Math.max(this.getPixelsPerMs(currentTime, fieldWidth), 0.001);
    const maxVisibleAheadMs = clamp(
      Math.max(MIN_VISIBLE_AHEAD_MS, (noteTravelWidth + 64) / currentTaikoSpeed),
      MIN_VISIBLE_AHEAD_MS,
      MAX_VISIBLE_AHEAD_MS,
    );
    // Long enough behind the line for hit bursts, drumrolls and swells to finish fading.
    const maxVisibleBehindMs = Math.max(HIT_BURST_MS, LONG_OBJECT_POST_HIT_FADE_MS);
    const spinnerFadeInMs = 1400;
    const visibleEnd = currentTime + maxVisibleAheadMs;
    const visibleStart = currentTime - maxVisibleBehindMs;
    const measureLookBehindMs = Math.max(1000, (leftMeasureFadeWidth + 24) / currentTaikoSpeed);
    const measureVisibleStart = currentTime - measureLookBehindMs;
    const taikoFadeAlphaAtX = (x) => {
      if (x <= rightFadeStartX) {
        return 1;
      }
      return clamp((rightFadeEndX - x) / Math.max(rightFadeWidth, 1), 0, 1);
    };
    const taikoPositionAt = (targetTime, speedReferenceTime = targetTime) => (
      judgeX + ((targetTime - currentTime) * this.getPixelsPerMs(speedReferenceTime, fieldWidth))
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(playfieldX, playfieldY, width, height);
    ctx.clip();

    ctx.fillStyle = 'rgba(28, 30, 36, 0.9)';
    ctx.fillRect(playfieldX, laneY - (laneHeight / 2), laneRightEdge - playfieldX, laneHeight);
    // The lane runs off both sides, so it is edged only along the top and bottom.
    const laneTop = Math.round(laneY - (laneHeight / 2));
    const laneBottom = Math.round(laneY + (laneHeight / 2)) - 1;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(playfieldX, laneTop, laneRightEdge - playfieldX, 1);
    ctx.fillRect(playfieldX, laneBottom, laneRightEdge - playfieldX, 1);

    const receptorRadius = Math.max(8, laneHeight * 0.38);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.beginPath();
    ctx.arc(judgeX, laneY, receptorRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.lineWidth = Math.max(1.2, laneHeight * 0.09);
    ctx.beginPath();
    ctx.arc(judgeX, laneY, receptorRadius, 0, Math.PI * 2);
    ctx.stroke();

    // The circle lit in the colour of the note just hit.
    for (
      let i = findFirstIndexAtOrAfter(objects, currentTime + 1e-9) - 1;
      i >= 0 && objects[i].time > currentTime - RECEPTOR_FLASH_MS;
      i -= 1
    ) {
      const hit = objects[i];
      if (hit.kind === 'spinner' || isRoll(hit)) continue;
      const flash = 1 - ((currentTime - hit.time) / RECEPTOR_FLASH_MS);
      ctx.fillStyle = withAlpha(isKatNote(hit) ? KAT_COLOR : DON_COLOR, 0.45 * flash * flash);
      ctx.beginPath();
      ctx.arc(judgeX, laneY, receptorRadius, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    const measureLineTop = laneY - (laneHeight * 0.72);
    const measureLineBottom = laneY + (laneHeight * 0.72);
    for (const measureTime of this.getMeasureLines(measureVisibleStart, visibleEnd)) {
      const x = taikoPositionAt(measureTime, measureTime);
      if (x < (playfieldX - 12) || x > (laneRightEdge + 12)) {
        continue;
      }

      const futureDistance = Math.max(0, x - judgeX);
      const pastDistance = Math.max(0, judgeX - x);
      const alpha = measureTime >= currentTime
        ? (0.08 + (0.18 * clamp(1 - (futureDistance / Math.max(noteTravelWidth, 1)), 0, 1)))
        : (0.22 * clamp(1 - (pastDistance / Math.max(leftMeasureFadeWidth, 1)), 0, 1));
      const fadedAlpha = alpha * taikoFadeAlphaAtX(x);
      if (fadedAlpha <= 0.02) {
        continue;
      }

      ctx.strokeStyle = `rgba(255,255,255,${fadedAlpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, measureLineTop);
      ctx.lineTo(x + 0.5, measureLineBottom);
      ctx.stroke();
    }

    const firstIndex = findFirstIndexWithEndAtOrAfter(this.getPrefixMaxEnd(objects), visibleStart);
    const lastIndex = findLastIndexAtOrBefore(objects, visibleEnd, (object) => object.time);

    // Latest first, so earlier notes are drawn on top and picked first.
    for (let i = lastIndex; i >= firstIndex; i -= 1) {
      const object = objects[i];
      const objectEndTime = Number.isFinite(object.endTime) ? object.endTime : object.time;
      if (objectEndTime < visibleStart) {
        continue;
      }

      if (object.kind === 'spinner') {
        const duration = Math.max(1, objectEndTime - object.time);
        const progress = clamp((currentTime - object.time) / duration, 0, 1);
        const radiusStart = laneHeight * 0.85;
        const radiusEnd = laneHeight * 0.28;
        const radius = radiusStart - ((radiusStart - radiusEnd) * progress);
        const alpha = currentTime < object.time
          ? clamp(1 - ((object.time - currentTime) / spinnerFadeInMs), 0, 1) * 0.6
          : clamp(1 - ((currentTime - objectEndTime) / LONG_OBJECT_POST_HIT_FADE_MS), 0, 1) * 0.8;
        const fadedAlpha = alpha * taikoFadeAlphaAtX(judgeX);
        if (fadedAlpha <= 0.02) {
          continue;
        }
        ctx.strokeStyle = `rgba(255,255,255,${fadedAlpha})`;
        ctx.lineWidth = Math.max(2, laneHeight * 0.14);
        ctx.beginPath();
        ctx.arc(judgeX, laneY, radius, 0, Math.PI * 2);
        ctx.stroke();
        this.hitTargets.push({ index: i, x: judgeX, y: laneY, radius });
        continue;
      }

      if (isRoll(object)) {
        const rollThickness = Math.max(6, laneHeight * 0.48);
        const rollRadius = rollThickness / 2;

        if (currentTime > objectEndTime) {
          const alpha = 0.86 * clamp(1 - ((currentTime - objectEndTime) / LONG_OBJECT_POST_HIT_FADE_MS), 0, 1);
          if (alpha <= 0.02) {
            continue;
          }
          ctx.fillStyle = withAlpha(ROLL_COLOR, alpha * 0.9);
          ctx.beginPath();
          ctx.arc(judgeX, laneY, rollRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = withAlpha(WHITE, alpha * 0.28);
          ctx.beginPath();
          ctx.arc(judgeX, laneY, Math.max(0.6, rollThickness * 0.11), 0, Math.PI * 2);
          ctx.fill();
          this.hitTargets.push({ index: i, x: judgeX, y: laneY, radius: rollRadius });
          continue;
        }

        const headX = taikoPositionAt(object.time, object.time);
        const tailX = taikoPositionAt(objectEndTime, object.time);
        const leftX = Math.max(judgeX, Math.min(headX, tailX));
        const rightX = Math.max(headX, tailX);
        if (rightX < judgeX || leftX > (laneRightEdge + 24) || leftX >= rightFadeEndX) {
          continue;
        }

        let alpha = 0.86;
        if (object.time > currentTime) {
          const futureDistance = Math.max(0, headX - judgeX);
          alpha = 0.18 + (0.68 * clamp(1 - (futureDistance / Math.max(noteTravelWidth, 1)), 0, 1));
        }
        if (alpha <= 0.02) {
          continue;
        }

        if (rightX <= leftX + 0.01) {
          const capAlpha = alpha * taikoFadeAlphaAtX(leftX);
          if (capAlpha <= 0.02) {
            continue;
          }
          ctx.fillStyle = withAlpha(ROLL_COLOR, capAlpha * 0.9);
          ctx.beginPath();
          ctx.arc(leftX, laneY, rollRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = withAlpha(WHITE, capAlpha * 0.28);
          ctx.beginPath();
          ctx.arc(leftX, laneY, Math.max(0.6, rollThickness * 0.11), 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = rightX > rightFadeStartX
            ? linearGradient(ctx, rightFadeStartX, laneY, rightFadeEndX, laneY, [
              [0, withAlpha(ROLL_COLOR, alpha * 0.9)],
              [1, withAlpha(ROLL_COLOR, 0)],
            ])
            : withAlpha(ROLL_COLOR, alpha * 0.9);
          ctx.lineWidth = rollThickness;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(leftX, laneY);
          ctx.lineTo(rightX, laneY);
          ctx.stroke();

          ctx.strokeStyle = rightX > rightFadeStartX
            ? linearGradient(ctx, rightFadeStartX, laneY, rightFadeEndX, laneY, [
              [0, withAlpha(WHITE, alpha * 0.28)],
              [1, withAlpha(WHITE, 0)],
            ])
            : withAlpha(WHITE, alpha * 0.28);
          ctx.lineWidth = Math.max(1.2, rollThickness * 0.22);
          ctx.beginPath();
          ctx.moveTo(leftX, laneY);
          ctx.lineTo(rightX, laneY);
          ctx.stroke();
        }

        // The roll as drawn, round ends and all, clipped to the canvas's edge.
        const targetWidth = Math.min(rightX, width) - leftX + rollThickness;
        if (leftX < width + rollRadius && targetWidth > 0) {
          this.hitTargets.push({
            index: i,
            x: leftX - rollRadius,
            y: laneY - rollRadius,
            width: targetWidth,
            height: rollThickness,
            corner: rollRadius,
          });
        }
        continue;
      }

      const noteColor = isKatNote(object) ? KAT_COLOR : DON_COLOR;
      const radius = Math.max(6, laneHeight * 0.28) * (isFinishNote(object) ? 1.38 : 1);

      // Hit: it swells and fades on the circle.
      if (object.time <= currentTime) {
        const burst = getHitBurst(currentTime - object.time);
        if (burst.alpha > 0.002) {
          const burstRadius = radius * burst.scale;
          drawPieceCircle(ctx, judgeX, laneY, burstRadius, noteColor, burst.alpha, { vivid: true });
          this.hitTargets.push({ index: i, x: judgeX, y: laneY, radius: burstRadius });
        }
        continue;
      }

      const x = taikoPositionAt(object.time, object.time);
      if (x <= judgeX || x > (laneRightEdge + 20)) {
        continue;
      }
      // Clearer the nearer it is to the circle, fading out at the far edge.
      const futureDistance = Math.max(0, x - judgeX);
      let alpha = PIECE_MAX_ALPHA * (0.25 + (0.75 * clamp(1 - (futureDistance / Math.max(noteTravelWidth, 1)), 0, 1)));
      alpha *= taikoFadeAlphaAtX(x);
      if (alpha <= 0.02) {
        continue;
      }
      drawPieceCircle(ctx, x, laneY, radius, noteColor, alpha, { vivid: true });
      this.hitTargets.push({ index: i, x, y: laneY, radius });
    }

    drawSelectionRings(ctx, this.hitTargets, this.host.getSelectionToRing?.());
    ctx.restore();
  }

  // The object under a point, from what the last frame drew; see pickHitTarget.
  objectIndexAtPoint(canvasX, canvasY) {
    return pickHitTarget(this.hitTargets, canvasX, canvasY);
  }
}

export { getTaikoUnit };
