import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatEditorTime,
  formatEditorTimestamp,
  formatObjectReference,
} from '../src/core/timestamp.js';

test('the time half is the editor\'s own mm:ss:mmm', () => {
  assert.equal(formatEditorTime(0), '00:00:000');
  assert.equal(formatEditorTime(1234), '00:01:234');
  assert.equal(formatEditorTime(83456), '01:23:456');
  // Milliseconds are floored, as the editor floors them: a playhead a fraction
  // past a note must not round forward onto the next millisecond.
  assert.equal(formatEditorTime(83456.9), '01:23:456');
  // A marathon past an hour keeps counting in minutes rather than wrapping.
  assert.equal(formatEditorTime((100 * 60 * 1000) + 500), '100:00:500');
});

test('a negative or unreadable time reads as the start', () => {
  assert.equal(formatEditorTime(-5), '00:00:000');
  assert.equal(formatEditorTime(NaN), '00:00:000');
  assert.equal(formatEditorTime(undefined), '00:00:000');
});

test('with nothing selected, the timestamp is the bare time', () => {
  // No object list means no claim about what the timestamp is about, so there
  // is nothing for a trailing dash to introduce either.
  assert.equal(formatEditorTimestamp(83456), '01:23:456');
  assert.equal(formatEditorTimestamp(83456, { objects: [] }), '01:23:456');
  assert.equal(formatEditorTimestamp(83456, { objects: [], mode: 3 }), '01:23:456');
});

test('with objects selected, they are named the way the editor names them', () => {
  const objects = [
    { time: 1000, comboNumber: 1 },
    { time: 1200, comboNumber: 2 },
    { time: 1400, comboNumber: 3 },
  ];

  assert.equal(formatEditorTimestamp(1000, { objects, mode: 0 }), '00:01:000 (1,2,3) - ');
});

test('the selection is taken as given, not filtered by the time passed in', () => {
  // The caller decides what the timestamp is about; it is whatever was ringed
  // on the timeline, which is rarely all at one instant.
  const objects = [
    { time: 1000, comboNumber: 1 },
    { time: 9000, comboNumber: 4 },
  ];

  assert.equal(formatEditorTimestamp(1000, { objects, mode: 0 }), '00:01:000 (1,4) - ');
});

test('taiko and catch number their combos like standard', () => {
  const objects = [{ time: 1000, comboNumber: 7 }];

  assert.equal(formatEditorTimestamp(1000, { objects, mode: 1 }), '00:01:000 (7) - ');
  assert.equal(formatEditorTimestamp(1000, { objects, mode: 2 }), '00:01:000 (7) - ');
});

test('mania uses the editor\'s time|column pairs instead of combo numbers', () => {
  const objects = [
    { time: 1000, column: 3, comboNumber: 1 },
    { time: 1000, column: 0, comboNumber: 2 },
  ];

  // A chord reaches here in whichever order the converter built it; the editor
  // lists it left to right.
  assert.equal(formatEditorTimestamp(1000, { objects, mode: 3 }), '00:01:000 (1000|0,1000|3) - ');
});

test('a mania hold is referenced by its own start, wherever the playhead is', () => {
  const objects = [{ time: 1000, endTime: 4000, column: 2 }];

  assert.equal(formatEditorTimestamp(3000, { objects, mode: 3 }), '00:03:000 (1000|2) - ');
});

test('objects with no combo number yet fall back to the bare time', () => {
  // A map the preview truncated, or one read before the renderer numbered its
  // combos: better a bare timestamp than "()" or a list of NaN.
  assert.equal(formatObjectReference([{ time: 1000 }], 0), '');
  assert.equal(formatEditorTimestamp(1000, { objects: [{ time: 1000 }], mode: 0 }), '00:01:000');
});

test('an empty reference is empty whatever the ruleset', () => {
  assert.equal(formatObjectReference([], 0), '');
  assert.equal(formatObjectReference([], 3), '');
  assert.equal(formatObjectReference(null, 0), '');
});
