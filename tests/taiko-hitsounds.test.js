import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHitsoundEvents, createHitsoundPlayer, HITSOUND_STYLE_DRUM_GAIN } from '../src/audio/hitsounds.js';
import { parseMapPreviewData } from '../src/parser.js';
import { convertMapForMode } from '../src/core/beatmapConversion.js';
import {
  TAIKO_DRUM,
  TAIKO_FLOURISH_SPACING_MS,
  getTaikoDrumTier,
  getTaikoDrumVoices,
  markTaikoFlourishes,
} from '../src/audio/taikoDrum.js';
import { HITSOUND_STYLES } from '../src/settings.js';

const WHISTLE = 2;
const FINISH = 4;
const CLAP = 8;

const circle = (time, hitSound = 0, extra = {}) => ({
  kind: 'circle', time, endTime: time, hitSound, sampleSet: 0, additionSet: 0, ...extra,
});
const drumEvents = (objects, options = {}) => buildHitsoundEvents(objects, { mode: 1, ...options });
const strikes = (events) => events.map(({ time, drum, strong }) => ({ time, drum, strong }));

test('a hit strikes the rim if it whistles or claps, the centre otherwise, big with a finish', () => {
  const events = drumEvents([
    circle(0, 0),
    circle(100, WHISTLE),
    circle(200, CLAP),
    circle(300, WHISTLE | CLAP),
    circle(400, FINISH),
    circle(500, FINISH | WHISTLE),
    circle(600, FINISH | CLAP),
  ]);
  assert.deepEqual(strikes(events), [
    { time: 0, drum: 'centre', strong: false },
    { time: 100, drum: 'rim', strong: false },
    { time: 200, drum: 'rim', strong: false },
    { time: 300, drum: 'rim', strong: false },
    { time: 400, drum: 'centre', strong: true },
    { time: 500, drum: 'rim', strong: true },
    { time: 600, drum: 'rim', strong: true },
  ]);
});

test('a converted big note is big even when its own bitmask has no finish', () => {
  const [event] = drumEvents([circle(0, 0, { taikoType: 'hit', taikoStrong: true })]);
  assert.equal(event.drum, 'centre');
  assert.equal(event.strong, true);
});

test('a drumroll is struck on the centre at every tick, to half a tick past its end', () => {
  const times = (endTime) => drumEvents([{
    kind: 'hold', taikoType: 'drumroll', time: 0, endTime, hitSound: FINISH | CLAP, taikoDrumrollTickMs: 100,
  }]);
  const ticks = times(1040);
  assert.deepEqual(ticks.map((event) => event.time), [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  // A big drumroll's ticks are struck one hand at a time, so none is big.
  assert.ok(ticks.every((event) => event.drum === 'centre' && !event.strong && !event.flourish));
  assert.equal(times(1060).length, 12, 'a tick within half a spacing of the end still counts');
});

test('a swell is struck centre and rim in turn, as often as it needs and at most every 50ms', () => {
  const swell = (durationMs, required) => drumEvents([{
    kind: 'spinner', taikoType: 'swell', time: 1000, endTime: 1000 + durationMs, hitSound: FINISH,
    taikoRequiredHits: required,
  }]);
  const quick = swell(3000, 10);
  assert.deepEqual(quick.map((event) => event.time), [1000, 1050, 1100, 1150, 1200, 1250, 1300, 1350, 1400, 1450]);
  assert.deepEqual(quick.slice(0, 4).map((event) => event.drum), ['centre', 'rim', 'centre', 'rim']);
  assert.ok(quick.every((event) => !event.strong));

  // More hits than 50ms apart allows: spread over the swell instead.
  const dense = swell(2000, 100);
  assert.equal(dense.length, 100);
  assert.equal(dense[1].time - dense[0].time, 20);
  assert.ok(dense.at(-1).time < 3000);
});

test('without tick spacing or a hit count, a drumroll or swell is struck once at its start', () => {
  const events = drumEvents([
    // A native drumroll is a slider; its tail and repeats never strike.
    {
      kind: 'slider', time: 0, endTime: 900, slides: 2, hitSound: FINISH | CLAP, sliderEdgeSounds: [8, 8, 8],
    },
    { kind: 'hold', taikoType: 'drumroll', time: 1000, endTime: 1600, hitSound: WHISTLE },
    // A swell used to sound at its end, the way an osu! spinner does.
    { kind: 'spinner', taikoType: 'swell', time: 2000, endTime: 3500, hitSound: FINISH },
  ]);
  assert.deepEqual(strikes(events), [
    { time: 0, drum: 'centre', strong: false },
    { time: 1000, drum: 'centre', strong: false },
    { time: 2000, drum: 'centre', strong: false },
  ]);
});

const taikoMap = (mode, { tickRate = 1, overallDifficulty = 5 } = {}) => parseMapPreviewData(`
osu file format v14

[General]
Mode:${mode}

[Difficulty]
OverallDifficulty:${overallDifficulty}
SliderMultiplier:1.4
SliderTickRate:${tickRate}

[TimingPoints]
0,400,4,1,0,100,1,0

[HitObjects]
256,192,1000,1,0,0:0:0:0:
100,192,2000,2,0,L|400:192,1,700
256,192,6000,12,0,9000,0:0:0:0:
`);

test('the conversion gives drumrolls lazer\'s tick spacing and swells their hit count', () => {
  for (const mode of [0, 1]) {
    const map = convertMapForMode(taikoMap(mode), 1);
    const roll = map.objects.find((object) => object.kind === 'slider' || object.taikoType === 'drumroll');
    const swell = map.objects.find((object) => object.kind === 'spinner');
    assert.equal(roll.taikoDrumrollTickMs, 100, `${mode}: a quarter of a 400ms beat`);
    // DifficultyRange(OD 5) = 5 hits a second, times 1.65, over 3s.
    assert.equal(swell.taikoRequiredHits, 24, `${mode}: swell hits`);
  }
  const triplets = convertMapForMode(taikoMap(1, { tickRate: 3 }), 1);
  assert.equal(triplets.objects.find((object) => object.kind === 'slider').taikoDrumrollTickMs, 400 / 3);
  const hard = convertMapForMode(taikoMap(1, { overallDifficulty: 10 }), 1);
  assert.equal(hard.objects.find((object) => object.kind === 'spinner').taikoRequiredHits, Math.floor(3 * 7.5 * 1.65));
});

test('a whole taiko map drums its rolls and swells through to the end', () => {
  const map = convertMapForMode(taikoMap(1), 1);
  const events = buildHitsoundEvents(map.objects, { mode: 1, samplePoints: map.timingControlPoints });
  const roll = map.objects.find((object) => object.kind === 'slider');
  const rollStrikes = events.filter((event) => event.time >= roll.time && event.time < roll.endTime + 50);
  assert.equal(rollStrikes.length, Math.floor((roll.endTime + 50 - roll.time) / 100) + 1);
  assert.equal(events.filter((event) => event.time >= 6000).length, 24);
  assert.equal(events[0].time, 1000);
});

test('the other rulesets still sound every node and play no drum', () => {
  const slider = { kind: 'slider', time: 0, endTime: 900, slides: 2, hitSound: 0 };
  const events = buildHitsoundEvents([slider, circle(1000, CLAP)]);
  assert.deepEqual(events.map((event) => event.time), [0, 450, 900, 1000]);
  assert.ok(events.every((event) => event.drum === undefined));
});

test('a strike takes its volume from the timing point like any hit', () => {
  const events = drumEvents([circle(0), circle(1000), circle(2000, 0, { sampleVolume: 40 })], {
    samplePoints: [{ time: 0, volume: 100 }, { time: 500, volume: 70 }],
  });
  assert.deepEqual(events.map((event) => event.volume), [100, 70, 40]);
  assert.deepEqual(events.map((event) => getTaikoDrumTier(event.volume)), ['drum', 'normal', 'soft']);
});

test('the drum picks its tier by volume and ignores the bank, as Argon does', () => {
  assert.equal(getTaikoDrumTier(100), 'drum');
  assert.equal(getTaikoDrumTier(90), 'drum');
  assert.equal(getTaikoDrumTier(89), 'normal');
  assert.equal(getTaikoDrumTier(60), 'normal');
  assert.equal(getTaikoDrumTier(59), 'soft');
  assert.equal(getTaikoDrumTier(5), 'soft');

  const centre = (volume) => getTaikoDrumVoices({ drum: 'centre', volume });
  assert.deepEqual(centre(95), [TAIKO_DRUM.centre.drum]);
  assert.deepEqual(centre(75), [TAIKO_DRUM.centre.normal]);
  assert.deepEqual(centre(30), [TAIKO_DRUM.centre.soft]);
  assert.deepEqual(getTaikoDrumVoices({ drum: 'rim', volume: 75 }), [TAIKO_DRUM.rim.normal]);
});

test('a big note plays the strong voice at any volume, and a flourish rides on top', () => {
  for (const volume of [5, 70, 100]) {
    assert.deepEqual(getTaikoDrumVoices({ drum: 'centre', strong: true, volume }), [TAIKO_DRUM.centre.strong]);
    assert.deepEqual(getTaikoDrumVoices({ drum: 'rim', strong: true, volume }), [TAIKO_DRUM.rim.strong]);
  }
  assert.deepEqual(
    getTaikoDrumVoices({ drum: 'rim', strong: true, flourish: true, volume: 100 }),
    [TAIKO_DRUM.rim.strong, TAIKO_DRUM.flourish],
  );
});

test('strong rims flourish at most every two seconds, counted back from the end of a run', () => {
  assert.equal(TAIKO_FLOURISH_SPACING_MS, 2000);
  const events = drumEvents([
    circle(0, FINISH | CLAP),
    circle(500, FINISH | CLAP),
    circle(1000, FINISH | CLAP),
    circle(1500, FINISH), // a big don: never flourishes, and does not count
    circle(2000, CLAP), // a small kat: likewise
    circle(4000, FINISH | WHISTLE),
    circle(8000, FINISH | CLAP),
  ]);
  const flourished = events.filter((event) => event.flourish).map((event) => event.time);
  // Walking back: 8000 flourishes, 4000 is 4s before it, 1000 is 3s before
  // that, and 500 and 0 are within 2s of 1000.
  assert.deepEqual(flourished, [1000, 4000, 8000]);
  assert.ok(events.filter((event) => !(event.drum === 'rim' && event.strong)).every((event) => !event.flourish));

  const exactly = markTaikoFlourishes([
    { time: 0, drum: 'rim', strong: true },
    { time: 2000, drum: 'rim', strong: true },
  ]);
  assert.deepEqual(exactly.map((event) => event.flourish), [true, true], 'two seconds apart is far enough');
});

test('every drum voice is a playable stack', () => {
  const voices = {
    ...Object.fromEntries(Object.entries(TAIKO_DRUM.centre).map(([tier, v]) => [`centre ${tier}`, v])),
    ...Object.fromEntries(Object.entries(TAIKO_DRUM.rim).map(([tier, v]) => [`rim ${tier}`, v])),
    flourish: TAIKO_DRUM.flourish,
  };
  for (const [where, layers] of Object.entries(voices)) {
    // lazer's big notes ring on for well over a second (and are choked by the
    // next big note on their half); everything else is gone within the 1.2s the
    // hitsound styles are held to.
    const longest = where.endsWith('strong') ? 2 : 1.2;
    assert.ok(Array.isArray(layers) && layers.length >= 3, `${where}: a stack, not a blip`);
    assert.ok(layers.some((layer) => layer.kind === 'tone'), `${where}: has a pitched layer`);
    assert.ok(layers.some((layer) => layer.kind === 'noise'), `${where}: has a noise layer`);
    for (const layer of layers) {
      assert.ok(['tone', 'noise'].includes(layer.kind), `${where}: kind ${layer.kind}`);
      assert.ok(layer.gain > 0 && Number.isFinite(layer.gain), `${where}: gain ${layer.gain}`);
      assert.ok(layer.durationSec > 0 && layer.durationSec <= longest, `${where}: duration ${layer.durationSec}`);
      assert.ok(layer.frequency >= 20 && layer.frequency <= 20000, `${where}: frequency ${layer.frequency}`);
      if (layer.endFrequency) {
        assert.ok(layer.endFrequency >= 20 && layer.endFrequency <= 20000, `${where}: end ${layer.endFrequency}`);
      }
      if (layer.attackSec !== undefined) {
        assert.ok(layer.attackSec > 0 && layer.attackSec < layer.durationSec, `${where}: attack ${layer.attackSec}`);
      }
      if (layer.delaySec !== undefined) {
        assert.ok(layer.delaySec >= 0 && layer.delaySec < 0.5, `${where}: delay ${layer.delaySec}`);
      }
    }
  }
});

// Enough of Web Audio to see what gets built and where it is connected.
const createMockContext = () => {
  const nodes = [];
  const param = (value = 0) => {
    const p = {
      value,
      history: [],
      setValueAtTime(v) { p.value = v; p.history.push(v); return p; },
      exponentialRampToValueAtTime(v) { p.value = v; p.history.push(v); return p; },
      linearRampToValueAtTime(v) { p.value = v; p.history.push(v); return p; },
      cancelScheduledValues() { return p; },
    };
    return p;
  };
  const node = (kind, extra = {}) => {
    const n = {
      kind,
      outputs: [],
      connect(target) { n.outputs.push(target); return target; },
      disconnect() { n.outputs = []; },
      ...extra,
    };
    nodes.push(n);
    return n;
  };
  const context = {
    sampleRate: 8000,
    currentTime: 10,
    state: 'running',
    destination: { kind: 'destination' },
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
    createGain: () => node('gain', { gain: param(1) }),
    createBiquadFilter: () => node('filter', { type: 'bandpass', frequency: param(350), Q: param(1) }),
    createWaveShaper: () => node('shaper'),
    createConvolver: () => node('convolver'),
    createBuffer: (channels, frames, rate) => ({
      numberOfChannels: channels, length: frames, sampleRate: rate, duration: frames / rate,
      getChannelData: () => new Float32Array(frames),
    }),
    createBufferSource: () => node('noise', { start() {}, stop() {} }),
    createOscillator: () => node('tone', { type: 'sine', frequency: param(440), start() {}, stop() {} }),
  };
  function MockAudioContext() { return context; }
  return { MockAudioContext, nodes };
};

// The bus a voice lands on: source -> (filter, for noise) -> envelope -> bus.
const busOf = (source) => {
  let envelope = source.outputs[0];
  if (envelope.kind === 'filter') {
    envelope = envelope.outputs[0];
  }
  return envelope.outputs[0];
};

const play = (events, style) => {
  const mock = createMockContext();
  const player = createHitsoundPlayer({ getAudioContext: mock.MockAudioContext });
  player.setEnabled(true);
  if (style) player.setStyle(style);
  player.syncTo(events, 0);
  player.update(events, 0, { rate: 1 });
  return { ...mock, player };
};

const sourcesOf = (nodes) => nodes.filter((n) => n.kind === 'tone' || n.kind === 'noise');

test('a strike plays its drum voice whatever the style, and only that', () => {
  const event = { time: 0, drum: 'rim', strong: true, flourish: true, volume: 100, hitSound: FINISH | CLAP };
  const expected = TAIKO_DRUM.rim.strong.length + TAIKO_DRUM.flourish.length;
  for (const style of HITSOUND_STYLES) {
    const { nodes } = play([event], style);
    assert.equal(sourcesOf(nodes).length, expected, style);
  }
  const { nodes } = play([{ ...event, drum: 'centre', strong: false, flourish: false, volume: 30 }]);
  assert.equal(sourcesOf(nodes).length, TAIKO_DRUM.centre.soft.length);
});

test('the drum plays dry, past the room, and a seek silences it with the rest', () => {
  const { nodes, player } = play([
    { time: 0, drum: 'centre', strong: false, volume: 100, hitSound: 0 },
    { time: 50, hitSound: 0, normalSet: 1, additionSet: 1, volume: 100 },
  ], 'argon');
  const roomSend = nodes.find((n) => n.kind === 'filter' && n.type === 'highpass' && n.outputs.some((o) => o.kind === 'convolver'));
  assert.ok(roomSend, 'the room send is built');

  const sources = sourcesOf(nodes);
  const drumBus = busOf(sources[0]);
  const hitBus = busOf(sources.at(-1));
  assert.notEqual(drumBus, hitBus);
  assert.ok(!drumBus.outputs.includes(roomSend), 'the drum skips the room');
  assert.equal(drumBus.outputs.length, 1);
  assert.ok(hitBus.outputs.includes(roomSend), 'an ordinary hit still goes to the room');

  player.syncTo([], 0);
  assert.equal(drumBus.gain.value, 0, 'a seek fades the drum bus out');
  assert.equal(hitBus.gain.value, 0);
});

test('a big note stops what its half of the drum is still sounding, as lazer\'s drum does', () => {
  const { nodes } = play([
    { time: 0, drum: 'centre', strong: false, volume: 100, hitSound: 0 },
    { time: 50, drum: 'rim', strong: false, volume: 100, hitSound: CLAP },
    { time: 200, drum: 'centre', strong: true, volume: 100, hitSound: FINISH },
  ]);
  const sources = sourcesOf(nodes);
  const centreBus = busOf(sources[0]);
  const rimBus = busOf(sources[TAIKO_DRUM.centre.drum.length]);
  const strongBus = busOf(sources.at(-1));

  assert.equal(centreBus.gain.value, 0, 'the earlier don is cut where the big don lands');
  assert.equal(rimBus.gain.value, 1, 'the rim rings on');
  assert.notEqual(strongBus, centreBus);
  assert.equal(strongBus.gain.value, 1, 'the big don itself plays');
});

test('a flourish plays apart, so the next big kat does not cut it short', () => {
  const { nodes } = play([
    { time: 0, drum: 'rim', strong: true, flourish: true, volume: 100, hitSound: FINISH | CLAP },
    // Inside the player's look-ahead, so both are placed in one frame.
    { time: 300, drum: 'rim', strong: true, flourish: false, volume: 100, hitSound: FINISH | CLAP },
  ]);
  const sources = sourcesOf(nodes);
  const firstBus = busOf(sources[0]);
  const flourishBus = busOf(sources[TAIKO_DRUM.rim.strong.length]);
  assert.notEqual(flourishBus, firstBus);
  assert.equal(firstBus.gain.value, 0, 'the first big kat is cut by the second');
  assert.equal(flourishBus.gain.value, 1, 'its flourish is not');
});

test('every style sets a level for each kind of hit, to match the same note in osu! mode', () => {
  for (const style of HITSOUND_STYLES) {
    const gains = HITSOUND_STYLE_DRUM_GAIN[style];
    assert.deepEqual(Object.keys(gains).sort(), ['centre', 'rim', 'strongCentre', 'strongRim'], style);
    for (const [kind, gain] of Object.entries(gains)) {
      assert.ok(Number.isFinite(gain) && gain > 0 && gain < 8, `${style} ${kind}: ${gain}`);
    }
    // A kat stacks a clap on the hitnormal in osu! mode, a big note a finish.
    assert.ok(gains.rim > gains.centre && gains.strongRim > gains.centre, style);
  }
});

test('a strike plays at its style\'s level for its kind of hit', () => {
  const layerGain = (event, style) => {
    const { nodes } = play([event], style);
    // The first layer's envelope peak is its table gain times the level.
    const envelope = sourcesOf(nodes)[0].outputs[0];
    const gainNode = envelope.kind === 'filter' ? envelope.outputs[0] : envelope;
    return Math.max(...gainNode.gain.history);
  };
  const kat = { time: 0, drum: 'rim', strong: false, volume: 100, hitSound: CLAP };
  const atArgon = layerGain(kat, 'argon');
  const atLazer = layerGain(kat, 'lazer');
  assert.ok(Math.abs((atLazer / atArgon) - (HITSOUND_STYLE_DRUM_GAIN.lazer.rim / HITSOUND_STYLE_DRUM_GAIN.argon.rim)) < 1e-9);
});
