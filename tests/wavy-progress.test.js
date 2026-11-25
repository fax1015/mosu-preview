import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
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
} from '../src/ui/wavyProgress.js';
import { TimelineRenderer } from '../src/timeline.js';
import { PreviewRenderer } from '../src/renderer.js';
import { DEFAULT_MINI_PALETTE } from '../src/core/coverPalette.js';
import { buildTimelineColours } from '../src/ui/miniTheme.js';
import {
  DEFAULT_MINI_WAVY_PROGRESS,
  MINI_WAVY_PROGRESS_KEY,
  PREVIEW_SETTING_KEYS,
  applyPreviewSettingChanges,
  normalizeMiniWavyProgress,
  normalizePreviewSettings,
  toPreviewSettingsStorage,
} from '../src/settings.js';

const WIDTH = 200;
const HEIGHT = 20;
const CLEARANCE = (HANDLE_WIDTH_PX / 2) + HANDLE_GAP_PX + (STROKE_PX / 2);

// A 2D context that writes down what it was asked to draw.
const createRecordingContext = () => {
  const calls = [];
  const state = {};
  const ctx = new Proxy(state, {
    get: (target, property) => {
      if (property === 'calls') return calls;
      if (Object.hasOwn(target, property)) return target[property];
      return (...args) => {
        calls.push({ op: property, args, strokeStyle: target.strokeStyle, fillStyle: target.fillStyle });
      };
    },
    set: (target, property, value) => {
      target[property] = value;
      return true;
    },
  });
  return ctx;
};

const COLOURS = Object.freeze({ wave: 'wave-colour', waveTrack: 'track-colour', playhead: 'handle-colour' });

test('the wave and the track stop short of the handle by the gap and their caps', () => {
  const layout = computeWaveLayout({ width: WIDTH, height: HEIGHT, headX: 100 });

  assert.equal(layout.middle, HEIGHT / 2);
  assert.equal(layout.handle.x, 100);
  assert.equal(layout.wave.start, STROKE_PX / 2);
  assert.equal(layout.wave.end, 100 - CLEARANCE);
  assert.equal(layout.track.start, 100 + CLEARANCE);
  assert.equal(layout.track.end, WIDTH - (STROKE_PX / 2), 'the track runs to the edge');
  assert.equal(Object.hasOwn(layout, 'stopDot'), false, 'no stop dot at the end');
});

test('at the very start there is no wave, and at the very end no track', () => {
  const start = computeWaveLayout({ width: WIDTH, height: HEIGHT, headX: 0 });
  assert.equal(start.wave, null);
  assert.ok(start.track);
  assert.equal(start.handle.x, HANDLE_WIDTH_PX / 2, 'the handle stays whole on the canvas');

  const end = computeWaveLayout({ width: WIDTH, height: HEIGHT, headX: WIDTH });
  assert.equal(end.track, null);
  assert.ok(end.wave);
  assert.equal(end.handle.x, WIDTH - (HANDLE_WIDTH_PX / 2));

  const nearEnd = computeWaveLayout({ width: WIDTH, height: HEIGHT, headX: WIDTH - CLEARANCE - 3 });
  assert.ok(nearEnd.track, 'a short track is still drawn');

  const unknown = computeWaveLayout({ width: WIDTH, height: HEIGHT, headX: Number.NaN });
  assert.equal(unknown.handle.x, HANDLE_WIDTH_PX / 2);
});

test('the wave leaves the start and meets the handle on the centre line', () => {
  const options = { start: 2, end: 150, middle: 10, amplitudePx: AMPLITUDE_PX, shiftPx: 7 };
  assert.equal(waveYAt(options.start, options), 10);
  assert.equal(waveYAt(options.end, options), 10);

  let highest = 0;
  for (let x = options.start; x <= options.end; x += 0.25) {
    highest = Math.max(highest, Math.abs(waveYAt(x, options) - 10));
  }
  assert.ok(highest <= AMPLITUDE_PX + 1e-9, 'never past its amplitude');
  assert.ok(highest > AMPLITUDE_PX * 0.95, 'reaches its full height away from the ends');

  const flat = { ...options, amplitudePx: 0 };
  assert.equal(waveYAt(75, flat), 10);
});

test('a short stretch of progress is nearly flat', () => {
  const options = { start: 2, end: 2 + (WAVELENGTH_PX / 3), middle: 10, amplitudePx: AMPLITUDE_PX };
  let highest = 0;
  for (let x = options.start; x <= options.end; x += 0.25) {
    highest = Math.max(highest, Math.abs(waveYAt(x, options) - 10));
  }
  assert.ok(highest < AMPLITUDE_PX * 0.4, `peaked at ${highest}`);
});

test('moving the wave moves its crests to the right', () => {
  const options = { start: 0, end: 400, middle: 10, amplitudePx: AMPLITUDE_PX };
  const crestAt = (shiftPx) => {
    let best = 100;
    for (let x = 100; x < 100 + WAVELENGTH_PX; x += 0.25) {
      if (waveYAt(x, { ...options, shiftPx }) > waveYAt(best, { ...options, shiftPx })) best = x;
    }
    return best;
  };
  const before = crestAt(0);
  const after = crestAt(5);
  // Within one wavelength's window, so a crest pushed past its end comes back
  // in at the start.
  const moved = (after - before + WAVELENGTH_PX) % WAVELENGTH_PX;
  assert.ok(Math.abs(moved - 5) < 0.5, `crest went from ${before} to ${after}`);
});

test('the line is drawn as track, wave and handle in their own colours', () => {
  const ctx = createRecordingContext();
  drawWavyProgress(ctx, { width: WIDTH, height: HEIGHT, headX: 100, amplitude: 1, shiftPx: 0, colours: COLOURS });

  const strokes = ctx.calls.filter((call) => call.op === 'stroke').map((call) => call.strokeStyle);
  assert.deepEqual(strokes, ['track-colour', 'wave-colour']);
  const fills = ctx.calls.filter((call) => call.op === 'fill').map((call) => call.fillStyle);
  assert.deepEqual(fills, ['handle-colour'], 'only the handle is filled: the track runs to the edge, with no stop dot');
  assert.equal(ctx.calls.some((call) => call.op === 'arc'), false);
  assert.equal(ctx.lineCap, 'round');
  assert.equal(ctx.lineWidth, STROKE_PX);

  const wavePoints = ctx.calls.filter((call) => call.op === 'lineTo').length;
  assert.ok(wavePoints > 50, 'the wave is traced, not a straight line');

  const flatCtx = createRecordingContext();
  drawWavyProgress(flatCtx, { width: WIDTH, height: HEIGHT, headX: 100, amplitude: 0, colours: COLOURS });
  const flatPoints = flatCtx.calls.filter((call) => call.op === 'lineTo');
  assert.equal(flatPoints.length, 2, 'flat, the wave is one straight line like the track');
  assert.ok(flatPoints.every((call) => call.args[1] === HEIGHT / 2));
});

test('the wave rises while playing and lies down when paused', () => {
  const motion = createWaveMotion();
  motion.update(0, false);
  assert.equal(motion.getAmplitude(), 0, 'starts flat');
  assert.equal(motion.isSettling(), false);

  motion.update(16, true);
  assert.equal(motion.isSettling(), true);
  motion.update(16 + (RISE_MS / 2), true);
  const halfway = motion.getAmplitude();
  assert.ok(halfway > 0.5 && halfway < 1, `eased up to ${halfway} halfway`);

  let now = 16 + (RISE_MS / 2);
  while (now < 16 + RISE_MS + 32) {
    now += 16;
    motion.update(now, true);
  }
  assert.equal(motion.getAmplitude(), 1);
  assert.equal(motion.isSettling(), false);

  const shiftBefore = motion.getShift();
  now += 16;
  motion.update(now, true);
  assert.ok(motion.getShift() !== shiftBefore, 'travels while playing');

  motion.update(now += 16, false);
  assert.equal(motion.isSettling(), true);
  const pausedAt = now;
  while (now < pausedAt + SETTLE_MS + 32) {
    now += 16;
    motion.update(now, false);
  }
  assert.equal(motion.getAmplitude(), 0);
  assert.equal(motion.isSettling(), false);

  const shiftAtRest = motion.getShift();
  motion.update(now + 500, false);
  assert.equal(motion.getShift(), shiftAtRest, 'still once flat');
});

test('a long gap between frames moves the wave no further than one short frame', () => {
  const motion = createWaveMotion();
  let now = 0;
  motion.update(now, true);
  while (now < RISE_MS + 32) {
    now += 16;
    motion.update(now, true);
  }
  const before = motion.getShift();
  motion.update(now + 10000, true);
  const moved = (motion.getShift() - before + WAVELENGTH_PX) % WAVELENGTH_PX;
  assert.ok(moved > 0 && moved < 3, `moved ${moved}px after a 10s gap`);
});

test('under reduced motion the wave stands still and switches at once', () => {
  const motion = createWaveMotion({ isReducedMotion: () => true });
  motion.update(0, true);
  assert.equal(motion.getAmplitude(), 1);
  assert.equal(motion.isSettling(), false);
  motion.update(500, true);
  assert.equal(motion.getShift(), 0);
  motion.update(516, false);
  assert.equal(motion.getAmplitude(), 0);
});

const createCanvas = (ctx = createRecordingContext()) => ({
  clientWidth: WIDTH,
  clientHeight: HEIGHT,
  width: WIDTH,
  height: HEIGHT,
  getContext: () => ctx,
});

const withWindow = (run) => {
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    return run();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
};

const createTimeline = (ctx) => {
  const timeline = new TimelineRenderer(createCanvas(ctx));
  const objects = [];
  for (let time = 0; time < 60000; time += 250) {
    objects.push({ kind: 'circle', time, endTime: time });
  }
  timeline.setBeatmap({ objects, breaks: [], timingControlPoints: [] }, 60000);
  return timeline;
};

test('the timeline draws only the wavy line in wave style, from the playhead', () => withWindow(() => {
  const ctx = createRecordingContext();
  const timeline = createTimeline(ctx);
  timeline.setColours({ wave: 'wave-colour', waveTrack: 'track-colour', playhead: 'handle-colour' });
  timeline.setProgressStyle('wave');
  assert.equal(timeline.getProgressStyle(), 'wave');
  timeline.setTime(30000);
  timeline.render(1000);

  const strokes = ctx.calls.filter((call) => call.op === 'stroke').map((call) => call.strokeStyle);
  assert.deepEqual(strokes, ['track-colour', 'wave-colour']);
  const fills = ctx.calls.filter((call) => call.op === 'fill' || call.op === 'fillRect');
  assert.deepEqual(fills.map((call) => call.fillStyle), ['handle-colour'], 'no density bars or markers');
  const handle = ctx.calls.find((call) => call.op === 'roundRect' || call.op === 'rect');
  assert.equal(handle.args[0] + (HANDLE_WIDTH_PX / 2), WIDTH / 2, 'the handle sits at the playhead');
}));

test('wave style shows the whole map and will not zoom or pick out objects', () => withWindow(() => {
  const timeline = createTimeline();
  timeline.zoomAt(15000, 0.1, 0.5, { animate: false });
  assert.equal(timeline.isZoomed(), true);

  timeline.setProgressStyle('wave');
  assert.equal(timeline.isZoomed(), false, 'a zoomed view resets');
  timeline.zoomAt(15000, 0.1, 0.5, { animate: false });
  timeline.zoomAroundPlayhead(0.5);
  assert.equal(timeline.isZoomed(), false);
  assert.equal(timeline.areObjectsGrabbable(), false);
  assert.equal(timeline.objectIndexAtX(10), -1);

  timeline.setProgressStyle('map');
  timeline.zoomAt(15000, 0.1, 0.5, { animate: false });
  assert.equal(timeline.isZoomed(), true, 'the map zooms as before');
  timeline.setProgressStyle('sideways');
  assert.equal(timeline.getProgressStyle(), 'map', 'an unknown style is the map');
}));

test('a paused timeline asks for frames while its wave lies down', () => withWindow(() => {
  const timeline = createTimeline();
  timeline.setProgressStyle('wave');
  timeline.setPlaying(true);
  let now = 1000;
  timeline.render(now);
  assert.equal(timeline.isWaveSettling(), true, 'rising');
  assert.equal(timeline.needsAnimationFrame(), true);
  while (now < 1000 + RISE_MS + 32) {
    now += 16;
    timeline.render(now);
  }
  assert.equal(timeline.needsAnimationFrame(), false, 'playback draws a standing wave itself');

  // Pausing draws no frame: the timeline must ask for one before it has drawn.
  timeline.setPlaying(false);
  assert.equal(timeline.needsAnimationFrame(), true, 'asks for a frame as soon as it hears');
  timeline.render(now += 16);
  assert.equal(timeline.needsAnimationFrame(), true);
  while (now < 1000 + RISE_MS + SETTLE_MS + 96) {
    now += 16;
    timeline.render(now);
  }
  assert.equal(timeline.needsAnimationFrame(), false);

  timeline.setProgressStyle('map');
  assert.equal(timeline.isWaveSettling(), false);
}));

test('the collapsed palette gives the wave the cover accent', () => {
  const colours = buildTimelineColours(DEFAULT_MINI_PALETTE);
  const [r, g, b] = DEFAULT_MINI_PALETTE.accent;
  assert.equal(colours.wave, `rgb(${r}, ${g}, ${b})`);
  assert.match(colours.waveTrack, /^rgba\(/);
});

test('the wavy progress setting is on by default, experimental in options, and syncs through storage', () => {
  assert.equal(DEFAULT_MINI_WAVY_PROGRESS, true);
  assert.equal(normalizePreviewSettings().miniWavyProgress, true);
  assert.ok(PREVIEW_SETTING_KEYS.includes(MINI_WAVY_PROGRESS_KEY));
  assert.equal(normalizeMiniWavyProgress('false'), false);
  assert.equal(normalizeMiniWavyProgress(undefined), true);

  const stored = toPreviewSettingsStorage({ miniWavyProgress: false });
  assert.equal(stored[MINI_WAVY_PROGRESS_KEY], false);
  assert.equal(normalizePreviewSettings(stored).miniWavyProgress, false);

  const changed = applyPreviewSettingChanges(
    normalizePreviewSettings(),
    { [MINI_WAVY_PROGRESS_KEY]: { oldValue: true, newValue: false } },
  );
  assert.equal(changed.miniWavyProgress, false);

  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  const expIdx = html.indexOf('>experimental<');
  const embeddedIdx = html.indexOf('id="embeddedPlayer"');
  const waveIdx = html.indexOf('id="miniWavyProgress"');
  const cacheIdx = html.indexOf('>cache<');
  assert.ok(waveIdx > embeddedIdx && embeddedIdx > expIdx, 'sits with the miniplayer in experimental');
  assert.ok(cacheIdx > waveIdx);

  const optionsSource = readFileSync(new URL('../src/options.js', import.meta.url), 'utf8');
  assert.match(optionsSource, /miniWavyProgress: miniWavyProgressToggle\?\.checked/);
});

test('collapsing into wave style while preview audio is active draws the dashed wavy line until full audio arrives', () => withWindow(() => {
  const ctx = createRecordingContext();
  const timeline = createTimeline(ctx);
  timeline.setColours({ wave: 'wave-colour', waveTrack: 'track-colour', playhead: 'handle-colour' });
  timeline.setTime(30000);

  // Preview audio becomes active while expanded ('map' style).
  assert.equal(timeline.setPreviewAudioPending(true, 1000), true);
  // Collapsing switches to 'wave' style; the line should be dashed.
  timeline.setProgressStyle('wave');
  timeline.render(1500);
  const dashCalls = ctx.calls.filter((call) => call.op === 'setLineDash');
  assert.ok(dashCalls.length > 0, 'dashed loading line is drawn when preview audio is active');
  assert.equal(timeline.needsAnimationFrame(), true, 'dashes keep animating while paused');

  // Once full audio arrives, the line transitions back to solid.
  ctx.calls.length = 0;
  assert.equal(timeline.setPreviewAudioPending(false, 2000), true);
  timeline.render(2500);
  const solidDashCalls = ctx.calls.filter((call) => call.op === 'setLineDash');
  assert.equal(solidDashCalls.length, 0, 'solid line once full audio replaces preview audio');
}));

// The paused frame loop in popup.js runs on PreviewRenderer.isTimelineAnimating,
// not on the timeline's own needsAnimationFrame: both have to agree.
test('a paused renderer keeps drawing the wave while its preview-clip dashes move or fade out', () => withWindow(() => {
  const renderer = new PreviewRenderer(createCanvas(), createCanvas());
  const objects = [];
  for (let time = 0; time < 60000; time += 250) {
    objects.push({ kind: 'circle', time, endTime: time });
  }
  renderer.setBeatmap({ mode: 0, objects, breaks: [], timingControlPoints: [] }, 60000);
  const { timeline } = renderer;
  timeline.setPlaying(false);
  timeline.setProgressStyle('wave');
  assert.equal(renderer.isTimelineAnimating(), false, 'a flat, solid, paused wave is still');

  timeline.setPreviewAudioPending(true, 1000);
  assert.equal(renderer.isTimelineAnimating(), true, 'the dashes travel while paused');
  assert.equal(renderer.isTimelineAnimating(), timeline.needsAnimationFrame());

  // Full audio arrives while paused: the dashes fade out over frames rather
  // than stopping on the first one, still dashed.
  timeline.setPreviewAudioPending(false, 2000);
  timeline.render(2016);
  assert.equal(renderer.isTimelineAnimating(), true, 'fading back to solid');
  timeline.render(5000);
  assert.equal(renderer.isTimelineAnimating(), false, 'solid again, and still');

  // The map style has no dashes to move.
  timeline.setPreviewAudioPending(true, 6000);
  timeline.setProgressStyle('map');
  timeline.render(7000);
  assert.equal(renderer.isTimelineAnimating(), false);
}));
