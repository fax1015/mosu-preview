import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSectionMarks,
  findNextSectionMark,
  findPreviousSectionMark,
} from '../src/core/sectionMarks.js';

const kiaiOn = (time) => ({ time, kiai: true, uninherited: false, beatLength: 500 });
const kiaiOff = (time) => ({ time, kiai: false, uninherited: false, beatLength: 500 });

test('marks come from bookmarks, kiai starts and break starts, in time order', () => {
  const marks = buildSectionMarks({
    bookmarks: [12000],
    timingControlPoints: [kiaiOn(4000), kiaiOff(8000)],
    breaks: [{ start: 20000, end: 25000 }],
  });

  assert.deepEqual(
    marks.map((mark) => [mark.timeMs, mark.kind, mark.label]),
    [
      [4000, 'kiai', 'Kiai 1'],
      [12000, 'bookmark', 'Bookmark 1'],
      [20000, 'break', 'Break 1'],
    ],
  );
});

test('only the point that switches kiai on is a mark', () => {
  // A kiai section usually holds several greenlines; each one is not a place
  // to jump to.
  const marks = buildSectionMarks({
    timingControlPoints: [kiaiOn(1000), kiaiOn(1500), kiaiOn(2000), kiaiOff(3000), kiaiOn(5000)],
  });

  assert.deepEqual(marks.map((mark) => mark.timeMs), [1000, 5000]);
  assert.deepEqual(marks.map((mark) => mark.label), ['Kiai 1', 'Kiai 2']);
});

test('control points out of order still read as sections', () => {
  const marks = buildSectionMarks({
    timingControlPoints: [kiaiOff(3000), kiaiOn(1000)],
  });

  assert.deepEqual(marks.map((mark) => mark.timeMs), [1000]);
});

test('each kind is numbered within itself', () => {
  const marks = buildSectionMarks({
    bookmarks: [1000, 9000],
    timingControlPoints: [kiaiOn(3000), kiaiOff(4000), kiaiOn(6000), kiaiOff(7000)],
  });

  assert.deepEqual(
    marks.map((mark) => mark.label),
    ['Bookmark 1', 'Kiai 1', 'Kiai 2', 'Bookmark 2'],
  );
});

test('a bookmark on a kiai start is one mark, named for the bookmark', () => {
  // Mappers bookmark their kiai. Two marks on the same millisecond would make
  // `n` appear not to move.
  const marks = buildSectionMarks({
    bookmarks: [5000],
    timingControlPoints: [kiaiOn(5000)],
  });

  assert.equal(marks.length, 1);
  assert.equal(marks[0].kind, 'bookmark');
});

test('a zero-length break is not a section', () => {
  const marks = buildSectionMarks({
    breaks: [{ start: 1000, end: 1000 }, { start: 2000, end: 5000 }],
  });

  assert.deepEqual(marks.map((mark) => mark.timeMs), [2000]);
});

test('bad data makes no marks rather than throwing', () => {
  assert.deepEqual(buildSectionMarks(null), []);
  assert.deepEqual(buildSectionMarks({}), []);
  assert.deepEqual(buildSectionMarks({ bookmarks: ['x', -5, null] }), []);
  assert.deepEqual(buildSectionMarks({ timingControlPoints: [{ kiai: true }] }), []);
  assert.deepEqual(buildSectionMarks({ breaks: [{ start: 'a', end: 'b' }] }), []);
});

test('next stops at each mark once and runs out at the last', () => {
  const marks = buildSectionMarks({ bookmarks: [1000, 2000, 3000] });

  assert.equal(findNextSectionMark(marks, 0).timeMs, 1000);
  assert.equal(findNextSectionMark(marks, 1000).timeMs, 2000);
  assert.equal(findNextSectionMark(marks, 2500).timeMs, 3000);
  assert.equal(findNextSectionMark(marks, 3000), null);
});

test('previous from inside a section goes to its start, from its start to the one before', () => {
  const marks = buildSectionMarks({ bookmarks: [1000, 2000, 3000] });

  // Playing a moment past a mark: back to the section you are in.
  assert.equal(findPreviousSectionMark(marks, 2400).timeMs, 2000);
  // Standing exactly on one: back to the previous section.
  assert.equal(findPreviousSectionMark(marks, 2000).timeMs, 1000);
  assert.equal(findPreviousSectionMark(marks, 1000), null);
  assert.equal(findPreviousSectionMark(marks, 0), null);
});

test('seeking an empty map finds nothing rather than throwing', () => {
  assert.equal(findNextSectionMark([], 0), null);
  assert.equal(findPreviousSectionMark([], 5000), null);
  assert.equal(findNextSectionMark(null, 0), null);
  assert.equal(findNextSectionMark([{ timeMs: 1000 }], NaN), null);
});
