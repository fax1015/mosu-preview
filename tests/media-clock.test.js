import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaClockSmoother } from '../src/audio/mediaClock.js';
import { createTimingController } from '../src/core/timing.js';

const FRAME_MS = 1000 / 165;

// A fake clock and element: `trueMs` is where playback really is; `report`
// turns that into what currentTime says.
const createRig = ({ report = (ms) => ms, src = 'blob:track' } = {}) => {
  const rig = {
    nowMs: 1000,
    trueMs: 0,
    rate: 1,
    audio: { src, paused: false, currentTime: 0 },
    frame(ms = FRAME_MS) {
      rig.nowMs += ms;
      rig.trueMs += ms * rig.rate;
      rig.audio.currentTime = report(rig.trueMs) / 1000;
    },
  };
  rig.smoother = createMediaClockSmoother({ now: () => rig.nowMs });
  rig.read = () => rig.smoother.read(rig.audio, rig.rate);
  return rig;
};

// What Firefox does: the reading only moves every 40ms.
const fortyMsSteps = (ms) => Math.floor(ms / 40) * 40;

test('a clock that moves on every read passes straight through', () => {
  const rig = createRig();
  for (let i = 0; i < 300; i += 1) {
    rig.frame();
    assert.equal(rig.read(), rig.audio.currentTime * 1000);
  }
});

test('reading twice in one task is not taken for a clock that steps', () => {
  const rig = createRig();
  for (let i = 0; i < 100; i += 1) {
    rig.frame();
    rig.read();
    assert.equal(rig.read(), rig.audio.currentTime * 1000);
  }
});

test('a clock that moves in 40ms steps comes out moving every frame, centred on its readings', () => {
  const rig = createRig({ report: fortyMsSteps });
  const samples = [];
  for (let i = 0; i < 165 * 3; i += 1) {
    rig.frame();
    samples.push({ out: rig.read(), raw: rig.audio.currentTime * 1000, trueMs: rig.trueMs });
  }
  const settled = samples.slice(30);

  const moved = settled.filter((sample, i) => i > 0 && sample.out > settled[i - 1].out).length;
  assert.ok(moved / (settled.length - 1) > 0.95, `moved on ${moved} of ${settled.length - 1} frames`);
  assert.ok(settled.every((sample, i) => i === 0 || sample.out >= settled[i - 1].out), 'never steps back');

  // The raw readings average 20ms behind real time; the smoothed clock keeps
  // that average, so sync is untouched, and stays close to it frame by frame.
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(Math.abs(mean(settled.map((s) => s.out - s.raw))) < 1.5, 'same average as the raw readings');
  const worst = Math.max(...settled.map((s) => Math.abs(s.out - (s.trueMs - 20))));
  assert.ok(worst <= FRAME_MS + 0.5, `within a frame of a steady clock (worst ${worst.toFixed(2)}ms)`);
});

test('the estimate runs at the playback speed', () => {
  const rig = createRig({ report: (ms) => Math.floor(ms / 60) * 60 });
  rig.rate = 1.5;
  rig.read();
  const outs = [];
  for (let i = 0; i < 165 * 2; i += 1) {
    rig.frame();
    outs.push({ out: rig.read(), trueMs: rig.trueMs });
  }
  const worst = Math.max(...outs.slice(40).map((s) => Math.abs(s.out - (s.trueMs - 30))));
  assert.ok(worst <= (FRAME_MS * 1.5) + 0.5, `worst ${worst.toFixed(2)}ms`);
});

test('a seek, a new source, a pause or a new speed goes straight to the new reading', () => {
  const rig = createRig({ report: fortyMsSteps });
  for (let i = 0; i < 100; i += 1) { rig.frame(); rig.read(); }

  rig.trueMs = 5000;
  rig.frame();
  assert.equal(rig.read(), rig.audio.currentTime * 1000, 'backward seek');

  for (let i = 0; i < 50; i += 1) { rig.frame(); rig.read(); }
  rig.trueMs += 30_000;
  rig.frame();
  assert.equal(rig.read(), rig.audio.currentTime * 1000, 'forward seek');

  for (let i = 0; i < 50; i += 1) { rig.frame(); rig.read(); }
  rig.audio.src = 'blob:slice';
  rig.frame();
  assert.equal(rig.read(), rig.audio.currentTime * 1000, 'new source');

  for (let i = 0; i < 50; i += 1) { rig.frame(); rig.read(); }
  rig.audio.paused = true;
  rig.frame(0);
  assert.equal(rig.read(), rig.audio.currentTime * 1000, 'paused');

  rig.audio.paused = false;
  for (let i = 0; i < 50; i += 1) { rig.frame(); rig.read(); }
  rig.rate = 0.75;
  rig.frame();
  assert.equal(rig.read(), rig.audio.currentTime * 1000, 'new speed');
});

test('a reading that lands early holds the clock rather than pulling it back', () => {
  const readings = [0, 40, 80, 100, 160, 200];
  let index = 0;
  const audio = { src: 'blob:track', paused: false, currentTime: 0 };
  let nowMs = 0;
  const smoother = createMediaClockSmoother({ now: () => nowMs });
  let last = smoother.read(audio);
  for (let frame = 1; frame < 200; frame += 1) {
    nowMs = frame * FRAME_MS;
    if (index < readings.length - 1 && nowMs >= (index + 1) * 40) {
      index += 1;
      audio.currentTime = readings[index] / 1000;
    }
    const out = smoother.read(audio);
    assert.ok(out >= last, `frame ${frame}: ${out} after ${last}`);
    last = out;
  }
});

test('the map clock reads the element through the smoother', () => {
  let nowMs = 0;
  const audio = { src: 'blob:track', paused: false, currentTime: 0 };
  const state = { audio, audioAnchorMapMs: 10_000, playbackSpeed: 1, durationMs: 600_000 };
  const timing = createTimingController({ state, clamp: (v, min, max) => Math.min(max, Math.max(min, v)), now: () => nowMs });

  const outs = [];
  for (let frame = 0; frame < 165; frame += 1) {
    nowMs = frame * FRAME_MS;
    audio.currentTime = fortyMsSteps(nowMs) / 1000;
    outs.push(timing.getAudioMappedTimeMs());
  }
  const distinct = new Set(outs.slice(20)).size;
  assert.ok(distinct > outs.length - 30, `${distinct} distinct positions in ${outs.length - 20} frames`);
  assert.ok(outs.every((ms) => ms >= 10_000 - 20 && ms <= 11_100));
});
