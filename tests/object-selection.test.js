import test from 'node:test';
import assert from 'node:assert/strict';
import { applySelectionClick, isClickAwayFromSelection } from '../src/core/objectSelection.js';

test('a plain click takes that object and nothing else', () => {
  assert.deepEqual(
    applySelectionClick({ selection: [4, 5], index: 2 }),
    { selection: [2], anchor: 2 },
  );
});

test('a plain click on empty space lets everything go', () => {
  assert.deepEqual(
    applySelectionClick({ selection: [1, 2], index: -1, anchor: 2 }),
    { selection: [], anchor: -1 },
  );
});

test('a modified click that misses changes nothing', () => {
  // Reaching for one more and missing should not throw away the run already
  // picked out.
  assert.deepEqual(
    applySelectionClick({
      selection: [1, 2], index: -1, anchor: 2, additive: true,
    }),
    { selection: [1, 2], anchor: 2 },
  );
  assert.deepEqual(
    applySelectionClick({
      selection: [1, 2], index: -1, anchor: 2, ranged: true,
    }),
    { selection: [1, 2], anchor: 2 },
  );
});

test('ctrl-click adds one, and takes it back off', () => {
  const added = applySelectionClick({ selection: [1], index: 3, additive: true });
  assert.deepEqual(added, { selection: [1, 3], anchor: 3 });

  const removed = applySelectionClick({
    selection: added.selection, index: 3, anchor: added.anchor, additive: true,
  });
  assert.deepEqual(removed.selection, [1]);
});

test('shift-click takes everything back to the anchor, either way round', () => {
  assert.deepEqual(
    applySelectionClick({
      selection: [2], index: 5, anchor: 2, ranged: true,
    }).selection,
    [2, 3, 4, 5],
  );
  assert.deepEqual(
    applySelectionClick({
      selection: [5], index: 2, anchor: 5, ranged: true,
    }).selection,
    [2, 3, 4, 5],
  );
});

test('the anchor stays put across a shift-click, so the run can be redrawn', () => {
  const first = applySelectionClick({
    selection: [2], index: 6, anchor: 2, ranged: true,
  });
  assert.equal(first.anchor, 2);
  // Shifting onto a nearer object grows from the same anchor rather than
  // walking the run along.
  const second = applySelectionClick({
    selection: first.selection, index: 4, anchor: first.anchor, ranged: true,
  });
  assert.equal(second.anchor, 2);
  assert.deepEqual(second.selection, [2, 3, 4, 5, 6]);
});

test('shift with no anchor yet behaves like a plain click', () => {
  assert.deepEqual(
    applySelectionClick({ selection: [], index: 3, anchor: -1, ranged: true }),
    { selection: [3], anchor: 3 },
  );
});

test('the result is sorted and free of nonsense', () => {
  const { selection } = applySelectionClick({
    selection: [9, 1, -4, null, undefined, 3], index: 5, additive: true,
  });
  assert.deepEqual(selection, [1, 3, 5, 9]);
});

// --- clicking away from the preview ----------------------------------------

// A node that knows what it holds, which is all the predicate asks of one.
const node = (...children) => ({
  children,
  contains(target) {
    return target === this || children.some((child) => child.contains?.(target) || child === target);
  },
});

const createPopup = () => {
  const circle = node();
  const previewArea = node(circle);
  const timelineCanvas = node();
  const copyButton = node();
  const volumeButton = node();
  const header = node(node());
  return {
    circle, previewArea, timelineCanvas, copyButton, volumeButton, header,
    parts: { previewArea, timelineCanvas, copyButton },
  };
};

test('a click inside the preview keeps the picked objects', () => {
  const popup = createPopup();

  assert.equal(isClickAwayFromSelection(popup.previewArea, popup.parts), false);
  assert.equal(isClickAwayFromSelection(popup.circle, popup.parts), false, 'and anything within it');
  assert.equal(isClickAwayFromSelection(popup.timelineCanvas, popup.parts), false, 'the timeline is the preview too');
});

test('the copy button never clears what it is about to copy', () => {
  // It is outside the preview, but it reads the selection: clearing on the
  // way to it would leave it copying a bare time every single time.
  const popup = createPopup();

  assert.equal(isClickAwayFromSelection(popup.copyButton, popup.parts), false);
});

test('a click anywhere else lets them go', () => {
  const popup = createPopup();

  assert.equal(isClickAwayFromSelection(popup.header, popup.parts), true);
  assert.equal(isClickAwayFromSelection(popup.header.children[0], popup.parts), true);
  assert.equal(isClickAwayFromSelection(popup.volumeButton, popup.parts), true);
});

test('missing elements are treated as absent, not as everything', () => {
  // Before a map is in, or in a build where one of them is not on the page.
  const popup = createPopup();

  assert.equal(isClickAwayFromSelection(popup.circle, { timelineCanvas: popup.timelineCanvas }), true);
  assert.equal(isClickAwayFromSelection(popup.circle, {}), true);
  assert.equal(isClickAwayFromSelection(popup.circle), true);
  // Nothing clicked is not a click away from anything.
  assert.equal(isClickAwayFromSelection(null, popup.parts), false);
  assert.equal(isClickAwayFromSelection(undefined, popup.parts), false);
});
