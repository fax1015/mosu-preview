// Moves the difficulty panels between layouts. Each panel is taken out of the
// grid for the length of the move and given, frame by frame, a real position
// and size between where it was and where the grid puts it; then the grid has
// it back.
//
// Real sizes rather than a transform: the preview keeps its size, so a panel
// can go from the whole area to half of it, and a scaled canvas stretched its
// map into the new shape while it moved. A panel resized for real is drawn
// again at each size (the caller's onFrame), so its playfield keeps its
// proportions all the way.
//
// Within the panels' own box: the preview no longer resizes the window, so
// nothing moves underneath it.

const PANEL_MOTION_MS = 380;
// The popovers' ease-out, so everything that opens here moves alike.
const PANEL_EASING = [0.32, 0.72, 0, 1];
// For a panel tucking itself away: under way at once, so the click is seen to
// do something, and still in sight until it has nearly arrived. (A steeper
// ease-in kept it still for the first 140ms.)
const PANEL_TUCK_EASING = [0.45, 0, 0.55, 1];

const MOVED_PROPERTIES = Object.freeze(['position', 'left', 'top', 'width', 'height', 'opacity', 'z-index']);

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of progress. */
const cubicBezier = (x1, y1, x2, y2) => {
  const sampleX = (t) => (((1 - (3 * x2) + (3 * x1)) * t + ((3 * x2) - (6 * x1))) * t + (3 * x1)) * t;
  const sampleY = (t) => (((1 - (3 * y2) + (3 * y1)) * t + ((3 * y2) - (6 * y1))) * t + (3 * y1)) * t;
  const slopeX = (t) => ((3 * (1 - (3 * x2) + (3 * x1)) * t) + (2 * ((3 * x2) - (6 * x1)))) * t + (3 * x1);
  return (progress) => {
    const x = Math.min(1, Math.max(0, progress));
    if (x === 0 || x === 1) {
      return x;
    }
    // Newton's method, then bisection where the slope is too flat for it.
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-6) {
        return sampleY(t);
      }
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) {
        break;
      }
      t -= error / slope;
    }
    let low = 0;
    let high = 1;
    t = x;
    for (let i = 0; i < 30; i += 1) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-6) {
        break;
      }
      if (value < x) {
        low = t;
      } else {
        high = t;
      }
      t = (low + high) / 2;
    }
    return sampleY(t);
  };
};

const panelEase = cubicBezier(...PANEL_EASING);

/** `rect` scaled by `factor` about its centre. */
const scaleRect = (rect, factor) => ({
  x: rect.x + ((rect.w * (1 - factor)) / 2),
  y: rect.y + ((rect.h * (1 - factor)) / 2),
  w: rect.w * factor,
  h: rect.h * factor,
});

const lerp = (a, b, t) => a + ((b - a) * t);

const lerpRect = (from, to, t) => ({
  x: lerp(from.x, to.x, t),
  y: lerp(from.y, to.y, t),
  w: lerp(from.w, to.w, t),
  h: lerp(from.h, to.h, t),
});

const createPanelMotion = ({
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (id) => globalThis.cancelAnimationFrame(id),
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer = (id) => globalThis.clearTimeout(id),
  isHidden = () => globalThis.document?.visibilityState === 'hidden',
} = {}) => {
  let running = null;

  const clearStyles = (items) => {
    items.forEach(({ element }) => {
      MOVED_PROPERTIES.forEach((property) => element.style.removeProperty(property));
    });
  };

  // Where each element is drawn now, within `container`, so a move that
  // interrupts another starts from wherever that one had got to.
  const capture = (container, elements) => {
    const base = container.getBoundingClientRect();
    return new Map(elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return [element, { x: rect.left - base.left, y: rect.top - base.top, w: rect.width, h: rect.height }];
    }));
  };

  const stop = (finished) => {
    if (!running) {
      return;
    }
    const { frameId, safetyTimer, items, resolve } = running;
    running = null;
    cancelFrame(frameId);
    clearTimer(safetyTimer);
    clearStyles(items);
    resolve(finished);
  };

  const cancel = () => stop(false);

  /**
   * Each item: `element`, `from` and `to` (rects within the container, from
   * capture), optional `opacity` [from, to] with `fade` 'early' (done by half
   * way, the default) or 'full', and `zIndex`. Every child of the container
   * should be an item: the rest would fall back into the grid around them.
   * `onFrame` runs after each step, to draw at the new sizes. Resolves true
   * when it finishes, false when cancelled.
   */
  const play = (items, {
    duration = PANEL_MOTION_MS,
    easing = null,
    onFrame = null,
  } = {}) => {
    cancel();
    // A hidden page draws no frames, so nothing would move and a panel on its
    // way out would never go: it goes straight to where it ends, drawn there
    // once so it is right when the page is shown again.
    if (items.length === 0 || isHidden()) {
      clearStyles(items);
      if (items.length > 0) {
        onFrame?.();
      }
      return Promise.resolve(true);
    }
    const ease = easing ? cubicBezier(...easing) : panelEase;
    const startedAt = now();
    return new Promise((resolve) => {
      const state = { items, resolve, frameId: null, safetyTimer: null };
      running = state;
      // And if the frames stop coming part way (the window hidden, the popup
      // put behind), it ends on time all the same.
      state.safetyTimer = setTimer(() => {
        if (running === state) {
          stop(true);
          onFrame?.();
        }
      }, duration + 250);

      const draw = () => {
        const progress = Math.min(1, (now() - startedAt) / duration);
        if (progress >= 1) {
          stop(true);
          onFrame?.();
          return;
        }
        const eased = ease(progress);
        for (const item of items) {
          const current = lerpRect(item.from, item.to, eased);
          const { style } = item.element;
          style.position = 'absolute';
          style.left = `${current.x.toFixed(2)}px`;
          style.top = `${current.y.toFixed(2)}px`;
          style.width = `${Math.max(0, current.w).toFixed(2)}px`;
          style.height = `${Math.max(0, current.h).toFixed(2)}px`;
          if (item.opacity) {
            // An arrival is solid by half way, well before it lands; a
            // departure fades the whole way.
            const fade = item.fade === 'full' ? eased : Math.min(1, progress * 2);
            style.opacity = String(lerp(item.opacity[0], item.opacity[1], fade));
          }
          if (item.zIndex !== undefined) {
            style.zIndex = String(item.zIndex);
          }
        }
        onFrame?.();
        state.frameId = requestFrame(draw);
      };

      draw();
    });
  };

  return {
    capture,
    play,
    cancel,
    isRunning: () => Boolean(running),
  };
};

export {
  PANEL_MOTION_MS,
  PANEL_TUCK_EASING,
  createPanelMotion,
  cubicBezier,
  lerpRect,
  scaleRect,
};
