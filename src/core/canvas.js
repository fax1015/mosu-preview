// Shared by the playfield and the timeline, which each draw into their own
// canvas but size it the same way.

const MAX_CANVAS_DPR = 2;
// The playfield paints every pixel, so it can be opaque and low-latency.
const OPAQUE_CONTEXT_OPTIONS = { alpha: false, desynchronized: true };
// Something drawn over the page instead lets it show through where it draws
// nothing.
const TRANSPARENT_CONTEXT_OPTIONS = { alpha: true };
const canvasContextCache = new WeakMap();

/**
 * The canvas's 2D context, with its backing store matched to the element's CSS
 * size and the transform set so drawing happens in CSS pixels. `transparent`
 * only counts the first time a canvas is asked for: a context is made once.
 */
const getCanvasContext = (canvas, { transparent = false } = {}) => {
  let cached = canvasContextCache.get(canvas);
  if (!cached) {
    const options = transparent ? TRANSPARENT_CONTEXT_OPTIONS : OPAQUE_CONTEXT_OPTIONS;
    cached = {
      ctx: canvas.getContext('2d', options) || canvas.getContext('2d'),
    };
    canvasContextCache.set(canvas, cached);
  }

  const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR);
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);

  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }

  const { ctx } = cached;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
};

export { getCanvasContext };
