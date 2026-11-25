// The collapsed miniplayer's progress line: Material 3 Expressive's wavy
// progress, drawn on the timeline canvas in place of the map. Collapsed, the
// preview is out of sight, so the map's density bars have nothing to point at;
// a line that moves with the music says "playing" instead.
//
// After Jetpack Compose's LinearWavyProgressIndicator (androidx material3) and
// material-web's wavy track: the played part is a wave of 4px stroke that
// travels along at a steady speed, a gap, then a flat track to the edge. As in
// Android's own media controls, the playhead is an upright handle
// with a gap either side, and the wave lies down flat while paused and rises
// again when playback resumes.
//
// Each end of the wave tapers into the centre line over half a wavelength, so
// it leaves the start and arrives at the handle level with the track. A short
// stretch of progress is nearly flat for the same reason; Compose flattens its
// wave near 0% to the same end.

import { cubicBezier } from './panelMotion.js';

const STROKE_PX = 4;
const AMPLITUDE_PX = 3;
const WAVELENGTH_PX = 30;
// Compose moves its wave one wavelength a second; a song plays for minutes, so
// this one goes a little slower.
const WAVE_SPEED_PX_PER_MS = WAVELENGTH_PX / 1250;
const HANDLE_WIDTH_PX = 4;
const HANDLE_GAP_PX = 4;
const LOADING_DASHES = Object.freeze([2, 5]);
const SAMPLE_STEP_PX = 1;
// Below this the wave is drawn as the straight line it nearly is.
const FLAT_AMPLITUDE_PX = 0.05;

// M3's standard easing at its long duration rising, quicker lying down, so a
// pause is seen to land.
const RISE_MS = 500;
const SETTLE_MS = 350;
const AMPLITUDE_EASE = cubicBezier(0.2, 0, 0, 1);
// A frame that took longer than this (a background tab, a debugger) moves the
// wave no further than this one would.
const MAX_STEP_MS = 50;

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

const smoothstep = (edge0, edge1, value) => {
  if (edge1 <= edge0) {
    return value >= edge1 ? 1 : 0;
  }
  const t = clampNumber((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - (2 * t));
};

/**
 * Where everything sits on a canvas `width` x `height` with the playhead at
 * `headX`. The handle is kept whole on the canvas; the wave and the track stop
 * short of it by the gap plus their round caps, and each is null when there is
 * no room left for it.
 */
const computeWaveLayout = ({ width, height, headX }) => {
  const cap = STROKE_PX / 2;
  const middle = height / 2;
  const handleHalf = HANDLE_WIDTH_PX / 2;
  const safeHead = Number.isFinite(headX) ? headX : 0;
  const handleX = clampNumber(safeHead, handleHalf, Math.max(handleHalf, width - handleHalf));
  const clearance = handleHalf + HANDLE_GAP_PX + cap;

  const waveStart = cap;
  const waveEnd = handleX - clearance;
  const trackStart = handleX + clearance;
  const trackEnd = width - cap;

  return {
    middle,
    handle: { x: handleX, width: HANDLE_WIDTH_PX, top: 0, height },
    wave: waveEnd > waveStart ? { start: waveStart, end: waveEnd } : null,
    track: trackEnd > trackStart ? { start: trackStart, end: trackEnd } : null,
  };
};

/**
 * The wave's centre line at `x`: a sine of `amplitudePx` that has moved
 * `shiftPx` to the right, faded to the middle at either end of start..end.
 */
const waveYAt = (x, { start, end, middle, amplitudePx, shiftPx = 0, wavelength = WAVELENGTH_PX }) => {
  const taper = wavelength / 2;
  const envelope = smoothstep(0, taper, x - start) * smoothstep(0, taper, end - x);
  return middle + (amplitudePx * envelope * Math.sin((2 * Math.PI * (x - shiftPx)) / wavelength));
};

const traceWave = (ctx, segment, middle, amplitudePx, shiftPx) => {
  const { start, end } = segment;
  ctx.moveTo(start, middle);
  if (amplitudePx < FLAT_AMPLITUDE_PX) {
    ctx.lineTo(end, middle);
    return;
  }
  const options = { start, end, middle, amplitudePx, shiftPx };
  for (let x = start + SAMPLE_STEP_PX; x < end; x += SAMPLE_STEP_PX) {
    ctx.lineTo(x, waveYAt(x, options));
  }
  ctx.lineTo(end, middle);
};

/**
 * Draws the whole line. `amplitude` is 0 (flat) to 1 (full wave), `shiftPx`
 * how far the wave has travelled; `colours` takes `wave`, `waveTrack` and
 * `playhead`, the timeline's own keys. `loadingMix` overlays moving dashes
 * while the short preview clip is the active audio source.
 */
const drawWavyProgress = (ctx, {
  width,
  height,
  headX,
  amplitude = 1,
  shiftPx = 0,
  loadingMix = 0,
  loadingShiftPx = 0,
  colours,
}) => {
  const layout = computeWaveLayout({ width, height, headX });
  const { middle } = layout;
  const loadingAlpha = clampNumber(loadingMix, 0, 1);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = STROKE_PX;
  const originalAlpha = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
  ctx.globalAlpha = originalAlpha * (1 - loadingAlpha);

  if (layout.track) {
    ctx.strokeStyle = colours.waveTrack;
    ctx.beginPath();
    ctx.moveTo(layout.track.start, middle);
    ctx.lineTo(layout.track.end, middle);
    ctx.stroke();
  }

  if (layout.wave) {
    ctx.strokeStyle = colours.wave;
    ctx.beginPath();
    traceWave(ctx, layout.wave, middle, AMPLITUDE_PX * clampNumber(amplitude, 0, 1), shiftPx);
    ctx.stroke();
  }

  if (loadingAlpha > 0) {
    // In preview-audio mode the dashes are the line itself; the gaps stay
    // clear. Their alpha is half strength so the loading treatment stays quiet.
    ctx.globalAlpha = originalAlpha * loadingAlpha * 0.5;
    ctx.lineWidth = STROKE_PX * 0.7;
    ctx.setLineDash(LOADING_DASHES);
    ctx.lineDashOffset = -loadingShiftPx;
    if (layout.track) {
      ctx.strokeStyle = colours.waveTrack;
      ctx.beginPath();
      ctx.moveTo(layout.track.start, middle);
      ctx.lineTo(layout.track.end, middle);
      ctx.stroke();
    }
    if (layout.wave) {
      ctx.strokeStyle = colours.wave;
      ctx.beginPath();
      traceWave(ctx, layout.wave, middle, AMPLITUDE_PX * clampNumber(amplitude, 0, 1), shiftPx);
      ctx.stroke();
    }
  }

  ctx.globalAlpha = originalAlpha;
  const { handle } = layout;
  const left = handle.x - (handle.width / 2);
  ctx.fillStyle = colours.playhead;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(left, handle.top, handle.width, handle.height, handle.width / 2);
  } else {
    ctx.rect(left, handle.top, handle.width, handle.height);
  }
  ctx.fill();
  ctx.restore();

  return layout;
};

/**
 * How high the wave stands and how far it has travelled, stepped by the
 * caller's frame clock. It rises while `active` (playing) and lies flat
 * otherwise, and travels at a speed in step with its height, so it eases off
 * as it settles rather than stopping dead. Under reduced motion it stands
 * still and switches between flat and full at once.
 */
const createWaveMotion = ({ isReducedMotion = () => false } = {}) => {
  let amplitude = 0;
  let target = 0;
  let tween = null;
  let shiftPx = 0;
  let lastAt = null;

  const update = (now, active) => {
    const dt = lastAt === null ? 0 : clampNumber(now - lastAt, 0, MAX_STEP_MS);
    lastAt = now;
    const nextTarget = active ? 1 : 0;
    const reduced = isReducedMotion();

    if (reduced) {
      tween = null;
      target = nextTarget;
      amplitude = nextTarget;
      return;
    }

    if (nextTarget !== target) {
      target = nextTarget;
      tween = {
        from: amplitude,
        to: nextTarget,
        startAt: now,
        duration: nextTarget > amplitude ? RISE_MS : SETTLE_MS,
      };
    }

    if (tween) {
      const progress = (now - tween.startAt) / tween.duration;
      if (progress >= 1) {
        amplitude = tween.to;
        tween = null;
      } else {
        amplitude = tween.from + ((tween.to - tween.from) * AMPLITUDE_EASE(progress));
      }
    }

    if (amplitude > 0 && dt > 0) {
      shiftPx = (shiftPx + (dt * WAVE_SPEED_PX_PER_MS * amplitude)) % WAVELENGTH_PX;
    }
  };

  /** Back to flat and still, as when the line first appears. */
  const reset = () => {
    amplitude = 0;
    target = 0;
    tween = null;
    shiftPx = 0;
    lastAt = null;
  };

  return {
    update,
    reset,
    isSettling: () => tween !== null,
    // Also true before the frame that hears about a change has run: pausing
    // draws no frame of its own, so this is what asks for one.
    isMoving: (active) => tween !== null || (active ? 1 : 0) !== target,
    getAmplitude: () => amplitude,
    getShift: () => shiftPx,
  };
};

export {
  AMPLITUDE_PX,
  HANDLE_GAP_PX,
  HANDLE_WIDTH_PX,
  RISE_MS,
  SETTLE_MS,
  STROKE_PX,
  WAVELENGTH_PX,
  computeWaveLayout,
  createWaveMotion,
  drawWavyProgress,
  waveYAt,
};
