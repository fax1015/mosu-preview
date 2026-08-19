import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CATCHUP_MS,
  buildHitsoundEvents,
  collectCrossedObjects,
  findFirstIndexAtOrAfter,
} from '../src/audio/hitsounds.js';

const objects = [0, 100, 200, 300, 400].map((time) => ({ time, hitSound: 0 }));
const timesOf = (hits) => hits.map((hit) => hit.time);

test('a normal frame sounds only the objects it just passed', () => {
  const { hits, nextCursor } = collectCrossedObjects(objects, 0, 90, 210);
  assert.deepEqual(timesOf(hits), [100, 200]);
  assert.equal(nextCursor, 3);
});

test('an object exactly on the playhead sounds once, not twice', () => {
  const first = collectCrossedObjects(objects, 0, 0, 100);
  assert.deepEqual(timesOf(first.hits), [0, 100]);

  // Next frame resumes from the returned cursor and must not repeat 100.
  const second = collectCrossedObjects(objects, first.nextCursor, 100, 150);
  assert.deepEqual(timesOf(second.hits), []);
});

test('a long stall does not fire everything it skipped at once', () => {
  // The machine-gun case: the tab was backgrounded, then one huge frame lands.
  const { hits } = collectCrossedObjects(objects, 0, 0, 400);
  assert.deepEqual(timesOf(hits), [300, 400], 'only the catch-up window should sound');
  assert.ok(400 - 300 <= MAX_CATCHUP_MS);
});

test('a cursor left behind by a seek is dragged forward, not replayed', () => {
  const { hits, nextCursor } = collectCrossedObjects(objects, 0, 380, 400);
  assert.deepEqual(timesOf(hits), [400]);
  assert.equal(nextCursor, 5);
});

test('an empty or exhausted map is handled without throwing', () => {
  assert.deepEqual(collectCrossedObjects([], 0, 0, 100), { hits: [], nextCursor: 0 });
  assert.deepEqual(collectCrossedObjects(undefined, 0, 0, 100), { hits: [], nextCursor: 0 });
  assert.deepEqual(collectCrossedObjects(objects, 99, 0, 100).hits, []);
  // Time running backwards is a seek; the caller resyncs rather than sounding.
  assert.deepEqual(collectCrossedObjects(objects, 0, 300, 100).hits, []);
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
    { time: 1000, hitSound: 0 },
    { time: 1400, hitSound: 8 },
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
    { time: 0, hitSound: 4 },
    { time: 200, hitSound: 4 },
  ]);
});

test('circles contribute one sound and spinners sound at the end', () => {
  const events = buildHitsoundEvents([
    { kind: 'circle', time: 100, endTime: 100, hitSound: 2 },
    { kind: 'spinner', time: 200, endTime: 900, hitSound: 4 },
  ]);

  assert.deepEqual(events, [
    { time: 100, hitSound: 2 },
    { time: 900, hitSound: 4 },
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
    { time: 500, hitSound: 2 },
    { time: 700, hitSound: 4 },
  ]);
  assert.deepEqual(buildHitsoundEvents(undefined), []);
});
