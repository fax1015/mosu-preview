// What a click does to the set of picked objects.
//
// Objects can be picked out in two places -- on the timeline and, for
// osu!standard, on the playfield itself -- and the two have to agree about
// what a plain click, a ctrl-click and a shift-click mean, or the same
// modifier would do different things a few pixels apart. This is that
// agreement, kept away from either one's pointer handling.
//
// Pure: a selection in, a selection out, so the rules are testable without a
// canvas or a pointer.

/**
 * @param {object} click
 * @param {Iterable<number>} click.selection what is picked out now.
 * @param {number} click.index the object clicked, or -1 for a miss.
 * @param {number} click.anchor the last object clicked, for a shift range.
 * @param {boolean} click.additive ctrl or cmd: add this one, or drop it.
 * @param {boolean} click.ranged shift: take everything back to the anchor.
 * @returns {{ selection: number[], anchor: number }} sorted, and the anchor to
 *   remember for the next click.
 */
const applySelectionClick = ({
  selection = [],
  index = -1,
  anchor = -1,
  additive = false,
  ranged = false,
} = {}) => {
  const current = new Set(
    [...selection].filter((value) => Number.isInteger(value) && value >= 0),
  );
  const sorted = (set) => [...set].sort((a, b) => a - b);

  if (!Number.isInteger(index) || index < 0) {
    // A miss means "none of them" -- unless it was meant to add to what is
    // already picked out and simply missed, in which case nothing changes.
    return additive || ranged
      ? { selection: sorted(current), anchor }
      : { selection: [], anchor: -1 };
  }

  if (ranged && Number.isInteger(anchor) && anchor >= 0) {
    const from = Math.min(anchor, index);
    const to = Math.max(anchor, index);
    for (let candidate = from; candidate <= to; candidate += 1) {
      current.add(candidate);
    }
    // The anchor stays put, so dragging the shift-click about keeps growing
    // the same run rather than walking it along.
    return { selection: sorted(current), anchor };
  }

  if (additive) {
    if (current.has(index)) {
      current.delete(index);
    } else {
      current.add(index);
    }
    return { selection: sorted(current), anchor: index };
  }

  return { selection: [index], anchor: index };
};

/**
 * Whether a click somewhere in the popup should let the picked objects go.
 *
 * Objects are chosen on the playfield and on the timeline, so those two are
 * the preview as far as a selection is concerned and a click in either is a
 * click at it. Everywhere else -- the header, the controls, the menus, the
 * gaps between them -- is a click away from it.
 *
 * The one exception is the control that reads the selection: a click on the
 * copy button must not be the thing that empties what it is about to copy.
 *
 * @param target the clicked node.
 * @param parts the preview's own elements; any of them may be absent.
 */
const isClickAwayFromSelection = (target, { previewArea, timelineCanvas, copyButton } = {}) => {
  if (!target) {
    return false;
  }
  const isWithin = (element) => Boolean(
    element && (element === target || element.contains?.(target)),
  );
  return !isWithin(previewArea) && !isWithin(timelineCanvas) && !isWithin(copyButton);
};

export { applySelectionClick, isClickAwayFromSelection };
