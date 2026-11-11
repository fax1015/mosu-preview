// The places in a map worth jumping to, as one sorted list.
//
// Seeking a five-minute marathon in five-second steps is no way to reach the
// chorus. These are the moments a map names for itself: the mapper's own
// editor bookmarks, where each kiai section starts, and where each break
// begins. The timeline already draws the last two; this is the same data as
// something to land on.
//
// Pure: it reads a parsed map and returns marks, so the key handling and the
// toast stay in the UI.

const BOOKMARK = 'bookmark';
const KIAI = 'kiai';
const BREAK = 'break';

const KIND_LABELS = Object.freeze({
  [BOOKMARK]: 'Bookmark',
  [KIAI]: 'Kiai',
  [BREAK]: 'Break',
});

// Which kind wins when a bookmark, a kiai start and a break all land on the
// same millisecond: the mapper's own mark is the most specific thing to say.
const KIND_PRIORITY = Object.freeze({ [BOOKMARK]: 0, [KIAI]: 1, [BREAK]: 2 });

// Two marks this close together are one moment as far as seeking goes, so
// `n` never stops twice in a row without appearing to move.
const MERGE_TOLERANCE_MS = 1;

// A mark exactly on the playhead is not somewhere to go next, and a playhead a
// hair past a mark is still inside that section rather than before it -- so
// `p` from just after a kiai start goes back to that start, and `p` from
// exactly on it goes to the mark before.
const EDGE_GUARD_MS = 1;

// `Number(null)` and `Number('')` are both 0, so a null in a bookmark list
// would otherwise become a mark at the start of the map.
const toFiniteMs = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const collectBookmarks = (mapData) => (
  (Array.isArray(mapData?.bookmarks) ? mapData.bookmarks : [])
    .map(toFiniteMs)
    .filter((time) => time !== null && time >= 0)
    .map((timeMs) => ({ timeMs, kind: BOOKMARK }))
);

/**
 * Where kiai turns on. Control points are walked in time order and only a
 * point that switches kiai on counts, so the several points inside one kiai
 * section do not each become a mark.
 */
const collectKiaiStarts = (mapData) => {
  const points = (Array.isArray(mapData?.timingControlPoints) ? mapData.timingControlPoints : [])
    .filter((point) => toFiniteMs(point?.time) !== null)
    .sort((a, b) => a.time - b.time);

  const marks = [];
  let active = false;
  for (const point of points) {
    const kiai = Boolean(point.kiai);
    if (kiai && !active) {
      marks.push({ timeMs: Number(point.time), kind: KIAI });
    }
    active = kiai;
  }
  return marks;
};

const collectBreakStarts = (mapData) => (
  (Array.isArray(mapData?.breaks) ? mapData.breaks : [])
    .filter((period) => toFiniteMs(period?.start) !== null && toFiniteMs(period?.end) !== null)
    .filter((period) => period.end > period.start)
    .map((period) => ({ timeMs: Number(period.start), kind: BREAK }))
);

/**
 * Every mark in a map, earliest first, each numbered within its own kind so a
 * toast can say which kiai or which bookmark the preview landed on.
 *
 * @returns {Array<{ timeMs: number, kind: string, ordinal: number, label: string }>}
 */
const buildSectionMarks = (mapData) => {
  const collected = [
    ...collectBookmarks(mapData),
    ...collectKiaiStarts(mapData),
    ...collectBreakStarts(mapData),
  ].sort((a, b) => (
    (a.timeMs - b.timeMs) || (KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind])
  ));

  const marks = [];
  const counts = new Map();
  for (const mark of collected) {
    const previous = marks[marks.length - 1];
    if (previous && Math.abs(mark.timeMs - previous.timeMs) <= MERGE_TOLERANCE_MS) {
      continue;
    }
    const ordinal = (counts.get(mark.kind) ?? 0) + 1;
    counts.set(mark.kind, ordinal);
    marks.push({
      timeMs: mark.timeMs,
      kind: mark.kind,
      ordinal,
      label: `${KIND_LABELS[mark.kind] || mark.kind} ${ordinal}`,
    });
  }
  return marks;
};

/** The first mark after `timeMs`, or null at the last one. */
const findNextSectionMark = (marks, timeMs) => {
  const time = Number(timeMs);
  if (!Array.isArray(marks) || !Number.isFinite(time)) {
    return null;
  }
  return marks.find((mark) => mark.timeMs > time + EDGE_GUARD_MS) || null;
};

/** The last mark before `timeMs`, or null before the first one. */
const findPreviousSectionMark = (marks, timeMs) => {
  const time = Number(timeMs);
  if (!Array.isArray(marks) || !Number.isFinite(time)) {
    return null;
  }
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    if (marks[index].timeMs < time - EDGE_GUARD_MS) {
      return marks[index];
    }
  }
  return null;
};

export {
  BOOKMARK,
  BREAK,
  KIAI,
  buildSectionMarks,
  findNextSectionMark,
  findPreviousSectionMark,
};
