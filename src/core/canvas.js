// Shared by the playfield and the timeline, which each draw into their own
// canvas but size it the same way.

const MAX_CANVAS_DPR = 2;
// The playfield paints every pixel, so it can be opaque and low-latency.
const OPAQUE_CONTEXT_OPTIONS = { alpha: false, desynchronized: true };
// The playfields of difficulties shown beside it are opaque but not
// low-latency. Chrome composites a page with several low-latency canvases made
// after its first frame at half the frame rate for as long as it stays open
// (measured in the toolbar popup at 165Hz: 12ms a frame with three added,
// 6ms without the flag), and the lag the flag saves is not worth that.
const OPAQUE_SYNCHRONIZED_CONTEXT_OPTIONS = { alpha: false };
// Something drawn over the page instead lets it show through where it draws
// nothing.
const TRANSPARENT_CONTEXT_OPTIONS = { alpha: true };
const canvasContextCache = new WeakMap();

/**
 * The canvas's 2D context, with its backing store matched to the element's CSS
 * size and the transform set so drawing happens in CSS pixels. `transparent`
 * and `lowLatency` only count the first time a canvas is asked for: a context
 * is made once.
 */
const getCanvasContext = (canvas, { transparent = false, lowLatency = true } = {}) => {
  let cached = canvasContextCache.get(canvas);
  if (!cached) {
    let options = OPAQUE_CONTEXT_OPTIONS;
    if (transparent) {
      options = TRANSPARENT_CONTEXT_OPTIONS;
    } else if (!lowLatency) {
      options = OPAQUE_SYNCHRONIZED_CONTEXT_OPTIONS;
    }
    cached = {
      ctx: canvas.getContext('2d', options) || canvas.getContext('2d'),
    };
    canvasContextCache.set(canvas, cached);
  }

  const rawDpr = Number(window.devicePixelRatio);
  const dpr = Number.isFinite(rawDpr) && rawDpr > 0 ? Math.min(rawDpr, MAX_CANVAS_DPR) : 1;
  const width = Math.max(1, Number(canvas.clientWidth) || 0);
  const height = Math.max(1, Number(canvas.clientHeight) || 0);
  const backingWidth = Math.max(1, Math.floor(width * dpr));
  const backingHeight = Math.max(1, Math.floor(height * dpr));

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }

  const { ctx } = cached;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
};

export { getCanvasContext };
