import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CATCHUP_MS,
  SCHEDULE_LOOKAHEAD_SEC,
  SAMPLE_BANKS,
  buildHitsoundEvents,
  collectScheduledEvents,
  findFirstIndexAtOrAfter,
} from '../src/audio/hitsounds.js';
import {
  SAMPLE_SET_NORMAL,
  SAMPLE_SET_SOFT,
  SAMPLE_SET_DRUM,
} from '../src/parser.js';

// What an object with no sample fields of its own resolves to when the map has
// no timing points either.
const plainSamples = { normalSet: SAMPLE_SET_NORMAL, additionSet: SAMPLE_SET_NORMAL, volume: 100 };

const objects = [0, 100, 200, 300, 400].map((time) => ({ time, hitSound: 0 }));
const timesOf = (hits) => hits.map((hit) => hit.time);

test('a frame places every event inside the lookahead window', () => {
  const { due, nextCursor } = collectScheduledEvents(objects, 0, 90, 210);
  assert.deepEqual(timesOf(due), [0, 100, 200]);
  assert.equal(nextCursor, 3);
});

test('an event is placed once, not once per frame', () => {
  const first = collectScheduledEvents(objects, 0, 0, 100);
  assert.deepEqual(timesOf(first.due), [0, 100]);

  // Next frame resumes from the returned cursor and must not repeat 100.
  const second = collectScheduledEvents(objects, first.nextCursor, 50, 150);
  assert.deepEqual(timesOf(second.due), []);
});

test('a long stall does not fire everything it skipped at once', () => {
  // The machine-gun case: the tab was backgrounded, then one huge frame lands.
  const { due } = collectScheduledEvents(objects, 0, 400, 400);
  assert.deepEqual(timesOf(due), [300, 400], 'only the catch-up window should sound');
  assert.ok(400 - 300 <= MAX_CATCHUP_MS);
});

test('a cursor left far behind is dragged forward, not replayed', () => {
  // A backgrounded tab comes back a second later. Everything it missed is gone,
  // and the cursor lands past it so none of it can sound at all.
  const { due, nextCursor } = collectScheduledEvents(objects, 0, 1000, 1350);
  assert.deepEqual(timesOf(due), []);
  assert.equal(nextCursor, 5);
});

test('the lookahead window is long enough to hide real output latency', () => {
  // A note closer than the device's latency cannot be pulled early enough to
  // land on time, so the window has to clear the worst plausible latency.
  assert.ok(SCHEDULE_LOOKAHEAD_SEC >= 0.2);
});

test('an empty or exhausted map is handled without throwing', () => {
  assert.deepEqual(collectScheduledEvents([], 0, 0, 100), { due: [], nextCursor: 0 });
  assert.deepEqual(collectScheduledEvents(undefined, 0, 0, 100), { due: [], nextCursor: 0 });
  assert.deepEqual(collectScheduledEvents(objects, 99, 0, 100).due, []);
  // A horizon behind the playhead is nonsense; place nothing rather than guess.
  assert.deepEqual(collectScheduledEvents(objects, 0, 300, 100).due, []);
});

test('the cursor lands on the first object at or after a seek target', () => {
  assert.equal(findFirstIndexAtOrAfter(objects, -50), 0);
  assert.equal(findFirstIndexAtOrAfter(objects, 200), 2);
  assert.equal(findFirstIndexAtOrAfter(objects, 201), 3);
  assert.equal(findFirstIndexAtOrAfter(objects, 9999), 5);
  assert.equal(findFirstIndexAtOrAfter([], 0), 0);
});

test('a plain slider sounds at its head and its tail', () => {
  const events = buildHitsoundEvents([
    { kind: 'slider', time: 1000, endTime: 1400, slides: 1, hitSound: 0, sliderEdgeSounds: [0, 8] },
  ]);

  assert.deepEqual(events, [
    { time: 1000, hitSound: 0, ...plainSamples },
    { time: 1400, hitSound: 8, ...plainSamples },
  ]);
});

test('a repeat slider sounds at every reverse as well as both ends', () => {
  // slides = 3 means head, two reverses and a tail, evenly spaced.
  const events = buildHitsoundEvents([
    { kind: 'slider', time: 0, endTime: 900, slides: 3, hitSound: 0, sliderEdgeSounds: [2, 4, 8, 2] },
  ]);

  assert.deepEqual(events.map((e) => e.time), [0, 300, 600, 900]);
  assert.deepEqual(events.map((e) => e.hitSound), [2, 4, 8, 2]);
});

test('nodes without their own edge sound inherit the object hitsound', () => {
  const events = buildHitsoundEvents([
    { kind: 'slider', time: 0, endTime: 200, slides: 1, hitSound: 4, sliderEdgeSounds: [] },
  ]);

  assert.deepEqual(events, [
    { time: 0, hitSound: 4, ...plainSamples },
    { time: 200, hitSound: 4, ...plainSamples },
  ]);
});

test('circles contribute one sound and spinners sound at the end', () => {
  const events = buildHitsoundEvents([
    { kind: 'circle', time: 100, endTime: 100, hitSound: 2 },
    { kind: 'spinner', time: 200, endTime: 900, hitSound: 4 },
  ]);

  assert.deepEqual(events, [
    { time: 100, hitSound: 2, ...plainSamples },
    { time: 900, hitSound: 4, ...plainSamples },
  ]);
});

test('slider nodes are interleaved into overall time order', () => {
  // A long slider overlaps the circles that follow it, so the flattened list is
  // not in source order and the crossing cursor depends on it being sorted.
  const events = buildHitsoundEvents([
    { kind: 'slider', time: 0, endTime: 1000, slides: 1, hitSound: 0, sliderEdgeSounds: [0, 0] },
    { kind: 'circle', time: 400, endTime: 400, hitSound: 0 },
    { kind: 'circle', time: 800, endTime: 800, hitSound: 0 },
  ]);

  assert.deepEqual(events.map((e) => e.time), [0, 400, 800, 1000]);
});

test('already-converted objects are not expanded a second time', () => {
  // Taiko/catch/mania conversions emit one circle per slider node upstream, so
  // those arrive here as plain circles and must pass straight through.
  const converted = [
    { kind: 'circle', time: 0, endTime: 0, hitSound: 0 },
    { kind: 'circle', time: 250, endTime: 250, hitSound: 8 },
    { kind: 'circle', time: 500, endTime: 500, hitSound: 0 },
  ];

  assert.equal(buildHitsoundEvents(converted).length, 3);
});

test('degenerate sliders and junk objects do not produce junk events', () => {
  const events = buildHitsoundEvents([
    { kind: 'slider', time: 500, endTime: 500, slides: 1, hitSound: 2 },  // zero length
    { kind: 'hold', time: 700, endTime: 1200, hitSound: 4 },              // mania hold: head only
    { kind: 'circle', time: Number.NaN, hitSound: 0 },
    null,
  ]);

  assert.deepEqual(events, [
    { time: 500, hitSound: 2, ...plainSamples },
    { time: 700, hitSound: 4, ...plainSamples },
  ]);
  assert.deepEqual(buildHitsoundEvents(undefined), []);
});

// osu! resolves a hit's volume and banks through a chain of fallbacks, and real
// maps lean on every link of it.
const samplePoint = (time, { sampleSet = 0, volume = 100 } = {}) => ({ time, sampleSet, volume });

test('greenline volume is what a hit plays at', () => {
  const events = buildHitsoundEvents(
    [800, 1800, 2800].map((time) => ({ kind: 'circle', time, hitSound: 0 })),
    {
      samplePoints: [
        samplePoint(0, { volume: 100 }),
        samplePoint(1000, { volume: 30 }),
        samplePoint(2000, { volume: 75 }),
      ],
    },
  );

  assert.deepEqual(events.map((event) => event.volume), [100, 30, 75]);
});

test('an object with its own volume overrides the timing point', () => {
  const events = buildHitsoundEvents(
    [
      { kind: 'circle', time: 1500, hitSound: 0, sampleVolume: 5 },
      { kind: 'circle', time: 1600, hitSound: 0, sampleVolume: 0 },
    ],
    { samplePoints: [samplePoint(0, { volume: 60 })] },
  );

  // 0 in the object means "inherit", which is why it cannot express silence.
  assert.deepEqual(events.map((event) => event.volume), [5, 60]);
});

test('a slider crossing a greenline resolves each node separately', () => {
  const events = buildHitsoundEvents(
    [{
      kind: 'slider', time: 1000, endTime: 3000, slides: 1, hitSound: 0,
    }],
    { samplePoints: [samplePoint(0, { volume: 90 }), samplePoint(2000, { volume: 15 })] },
  );

  assert.deepEqual(events.map((event) => [event.time, event.volume]), [[1000, 90], [3000, 15]]);
});

test('a hit before the first timing point still takes that point settings', () => {
  const events = buildHitsoundEvents(
    [{ kind: 'circle', time: 100, hitSound: 0 }],
    { samplePoints: [samplePoint(500, { volume: 40, sampleSet: SAMPLE_SET_DRUM })] },
  );

  assert.equal(events[0].volume, 40);
  assert.equal(events[0].normalSet, SAMPLE_SET_DRUM);
});

test('banks fall back from the object to the timing point to the beatmap', () => {
  const objects = [
    { kind: 'circle', time: 0, hitSound: 0, sampleSet: SAMPLE_SET_DRUM },
    { kind: 'circle', time: 100, hitSound: 0 },
    { kind: 'circle', time: 2000, hitSound: 0 },
  ];
  const events = buildHitsoundEvents(objects, {
    samplePoints: [samplePoint(0, { sampleSet: SAMPLE_SET_SOFT }), samplePoint(1000, { sampleSet: 0 })],
    defaultSampleSet: SAMPLE_SET_NORMAL,
  });

  // The object names its own bank, so nothing else gets a say.
  assert.equal(events[0].normalSet, SAMPLE_SET_DRUM);
  // No bank of its own: the timing point in force decides.
  assert.equal(events[1].normalSet, SAMPLE_SET_SOFT);
  // A timing point that names none falls through to the beatmap default.
  assert.equal(events[2].normalSet, SAMPLE_SET_NORMAL);
});

test('with nothing naming a bank anywhere, hits land on normal', () => {
  const events = buildHitsoundEvents([{ kind: 'circle', time: 0, hitSound: 0 }], {
    samplePoints: [samplePoint(0, { sampleSet: 0 })],
    defaultSampleSet: 0,
  });

  assert.equal(events[0].normalSet, SAMPLE_SET_NORMAL);
  assert.equal(events[0].additionSet, SAMPLE_SET_NORMAL);
});

test('additions inherit the bank the object resolved to, not the timing point', () => {
  const events = buildHitsoundEvents(
    [
      { kind: 'circle', time: 0, hitSound: 2, sampleSet: SAMPLE_SET_DRUM },
      { kind: 'circle', time: 100, hitSound: 2, sampleSet: SAMPLE_SET_DRUM, additionSet: SAMPLE_SET_SOFT },
    ],
    { samplePoints: [samplePoint(0, { sampleSet: SAMPLE_SET_NORMAL })] },
  );

  assert.equal(events[0].additionSet, SAMPLE_SET_DRUM, 'an unset addition follows the normal bank');
  assert.equal(events[1].additionSet, SAMPLE_SET_SOFT, 'a named addition bank wins');
});

test('slider nodes keep the banks their edge sets named', () => {
  const events = buildHitsoundEvents(
    [{
      kind: 'slider',
      time: 0,
      endTime: 600,
      slides: 2,
      hitSound: 0,
      sampleSet: SAMPLE_SET_NORMAL,
      nodeSamples: [
        { normalSet: SAMPLE_SET_DRUM, additionSet: SAMPLE_SET_DRUM },
        { normalSet: SAMPLE_SET_SOFT, additionSet: 0 },
      ],
    }],
    {},
  );

  assert.deepEqual(events.map((event) => event.normalSet), [
    SAMPLE_SET_DRUM,
    SAMPLE_SET_SOFT,
    // No entry for the tail: it falls back to the slider's own bank.
    SAMPLE_SET_NORMAL,
  ]);
});

test('every bank can voice every sound a hitsound bitmask can ask for', () => {
  for (const set of [SAMPLE_SET_NORMAL, SAMPLE_SET_SOFT, SAMPLE_SET_DRUM]) {
    const bank = SAMPLE_BANKS[set];
    assert.ok(bank, `bank ${set} exists`);
    for (const sound of ['normal', 'whistle', 'clap', 'finish']) {
      assert.ok(Array.isArray(bank[sound]) && bank[sound].length > 0, `bank ${set} has ${sound}`);
      for (const layer of bank[sound]) {
        assert.ok(layer.gain > 0, `bank ${set} ${sound} layer has gain`);
        assert.ok(layer.durationSec > 0, `bank ${set} ${sound} layer has length`);
        assert.ok(layer.frequency > 0, `bank ${set} ${sound} layer has a frequency`);
      }
    }
  }
});
