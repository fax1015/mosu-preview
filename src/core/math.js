// Small helpers the parser, the converters, the renderer and the popup all need.
// Each used to keep its own copy.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Index of the first item whose `time` is at or after `timeMs`, in a list sorted
 * by time. An item with no usable time sorts as if it came later, so a stray one
 * cannot drag the search below where it belongs.
 */
const findFirstIndexAtOrAfter = (items, timeMs) => {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const value = items[mid]?.time;
    if (Number.isFinite(value) && value < timeMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};

export { clamp, findFirstIndexAtOrAfter };
