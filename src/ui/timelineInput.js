import { clamp } from '../core/math.js';
import { formatTimelineTime } from '../timeline.js';

// Pointer, wheel and keyboard handling for the timeline (src/timeline.js).
// Every seek goes through the playback controller's `seekTo` and never touches
// the audio element, so a scrub lands exactly where any other seek would.

const WHEEL_LINE_PX = 33;
const WHEEL_PAGE_PX = 400;
// Zoom per pixel of wheel travel. A trackpad pinch arrives as Ctrl+wheel in
// much smaller steps, so it gets more per pixel.
const WHEEL_ZOOM_PER_PX = 0.004;
const PINCH_ZOOM_PER_PX = 0.01;
const KEY_ZOOM_FACTOR = 2;
// Dragging the playhead into this margin of a zoomed view scrolls the view,
// faster the further past it the pointer goes.
const EDGE_SCROLL_ZONE_PX = 14;
const EDGE_SCROLL_RATE = 0.02;
const MAX_EDGE_OVERSHOOT_PX = 60;
const BRACKET_GRAB_SLOP_PX = 4;

const bindTimelineInput = ({ canvas, tooltip, state, renderer, seekTo }) => {
  // Read on use rather than at bind time: the renderer sets it up itself.
  const getTimeline = () => renderer?.timeline ?? null;
  const hasMap = () => Boolean(getTimeline() && state.mapData && state.durationMs > 0);

  let renderRafId = null;
  // { kind: 'scrub' | 'overview', pointerId, x, grabOffsetMs, lastFrameAt }
  let drag = null;
  let isSeekPending = false;
  // Where the pointer last was over the timeline (or dragging from it), in the
  // canvas's own coordinates.
  let pointer = null;

  const localPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const seekToX = (x) => {
    seekTo(getTimeline().timeAtX(x));
  };

  const scrollAtEdge = (now) => {
    const timeline = getTimeline();
    const elapsedMs = drag.lastFrameAt === null ? 0 : Math.min(34, now - drag.lastFrameAt);
    drag.lastFrameAt = now;
    if (!timeline.isZoomed() || elapsedMs <= 0) {
      return;
    }

    const width = canvas.clientWidth;
    let overshootPx = 0;
    if (drag.x < EDGE_SCROLL_ZONE_PX) {
      overshootPx = drag.x - EDGE_SCROLL_ZONE_PX;
    } else if (drag.x > width - EDGE_SCROLL_ZONE_PX) {
      overshootPx = drag.x - (width - EDGE_SCROLL_ZONE_PX);
    }
    if (overshootPx === 0) {
      return;
    }

    const before = timeline.getTargetView().startMs;
    const panPx = clamp(overshootPx, -MAX_EDGE_OVERSHOOT_PX, MAX_EDGE_OVERSHOOT_PX) * EDGE_SCROLL_RATE * elapsedMs;
    timeline.panBy(panPx * timeline.getMsPerPx(), { animate: false });
    if (timeline.getTargetView().startMs !== before) {
      isSeekPending = true;
    }
  };

  // A drag is one seek per frame, to wherever the pointer is when that frame
  // runs. Seeking on every pointer sample only made the media element start
  // work it was about to be told to abandon.
  const tick = (now) => {
    renderRafId = null;
    const timeline = getTimeline();
    if (!timeline) {
      return;
    }
    // Pausing does not draw a frame, so the timeline may not have heard yet.
    timeline.setPlaying(state.isPlaying);
    if (drag?.kind === 'scrub') {
      scrollAtEdge(now);
      if (isSeekPending) {
        isSeekPending = false;
        seekToX(drag.x);
      }
    }
    renderer.renderTimeline();
    // The view can move under a still pointer (easing, edge scrolling, following
    // playback), so the readout is refreshed from where the pointer last was.
    if (pointer) {
      updateTooltip(pointer.x, pointer.y);
    }
    const isFollowingUnderPointer = Boolean(pointer) && state.isPlaying && timeline.isZoomed();
    if (drag || timeline.needsAnimationFrame() || isFollowingUnderPointer) {
      requestFrame();
    }
  };

  const requestFrame = () => {
    if (renderRafId === null) {
      renderRafId = requestAnimationFrame(tick);
    }
  };

  const hideTooltip = () => {
    if (tooltip && !tooltip.hidden) {
      tooltip.hidden = true;
    }
  };

  const updateTooltip = (x, y) => {
    if (!tooltip) {
      return;
    }
    const timeline = getTimeline();
    const rect = canvas.getBoundingClientRect();
    if (!hasMap() || rect.width <= 0) {
      hideTooltip();
      return;
    }

    let text;
    if (drag?.kind === 'overview') {
      const { startMs, endMs } = timeline.getView();
      text = `${formatTimelineTime(startMs)} – ${formatTimelineTime(endMs)}`;
    } else if (!drag && timeline.regionAt(y) === 'overview') {
      text = formatTimelineTime(timeline.overviewTimeAtX(x));
    } else {
      text = timeline.formatTimeAtX(x);
    }
    tooltip.textContent = text;
    tooltip.hidden = false;

    // Positioned against the timeline row, then held inside it so the label
    // stays readable at both ends instead of hanging off the edge.
    const parentRect = tooltip.offsetParent?.getBoundingClientRect() || rect;
    const half = tooltip.offsetWidth / 2;
    const rawLeft = (rect.left - parentRect.left) + clamp(x, 0, rect.width);
    const minLeft = (rect.left - parentRect.left) + half;
    const maxLeft = (rect.right - parentRect.left) - half;
    tooltip.style.left = `${Math.min(Math.max(rawLeft, minLeft), maxLeft)}px`;
  };

  const updateHover = (x, y) => {
    const timeline = getTimeline();
    let cursor = '';
    if (timeline.regionAt(y) === 'overview') {
      const { x0, x1 } = timeline.getOverviewBracket();
      cursor = x >= x0 - BRACKET_GRAB_SLOP_PX && x <= x1 + BRACKET_GRAB_SLOP_PX ? 'grab' : '';
      timeline.setHoverX(null);
    } else {
      timeline.setHoverX(x);
    }
    canvas.style.cursor = cursor;
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !hasMap()) {
      return;
    }
    const timeline = getTimeline();
    const { x, y } = localPoint(event);
    pointer = { x, y };
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    timeline.setInteracting(true);

    if (timeline.regionAt(y) === 'overview') {
      const timeMs = timeline.overviewTimeAtX(x);
      const { x0, x1 } = timeline.getOverviewBracket();
      const view = timeline.getView();
      let grabOffsetMs = view.durationMs / 2;
      if (x >= x0 - BRACKET_GRAB_SLOP_PX && x <= x1 + BRACKET_GRAB_SLOP_PX) {
        grabOffsetMs = clamp(timeMs - view.startMs, 0, view.durationMs);
      } else {
        // Clicking beside the bracket brings the view there, centred.
        timeline.setViewStart(timeMs - grabOffsetMs, { animate: true });
      }
      drag = { kind: 'overview', pointerId: event.pointerId, grabOffsetMs };
      canvas.style.cursor = 'grabbing';
    } else {
      drag = { kind: 'scrub', pointerId: event.pointerId, x, lastFrameAt: null };
      timeline.resumeFollow();
      isSeekPending = false;
      seekToX(x);
    }
    updateTooltip(x, y);
    requestFrame();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!hasMap()) {
      return;
    }
    const timeline = getTimeline();
    const { x, y } = localPoint(event);
    pointer = { x, y };
    if (drag && event.pointerId === drag.pointerId) {
      if (drag.kind === 'scrub') {
        drag.x = x;
        isSeekPending = true;
      } else {
        timeline.setViewStart(timeline.overviewTimeAtX(x) - drag.grabOffsetMs, {
          animate: timeline.isViewAnimating(),
        });
      }
    } else if (!drag) {
      updateHover(x, y);
    }
    updateTooltip(x, y);
    requestFrame();
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const ended = drag;
    drag = null;
    const timeline = getTimeline();
    if (ended.kind === 'scrub') {
      // Release lands on the last position the pointer was at, not on
      // whichever sample the last frame happened to catch.
      isSeekPending = false;
      if (event.type === 'pointerup') {
        seekToX(ended.x);
      }
    }
    timeline?.setInteracting(false);
    timeline?.noteManualMove();
    const { x, y } = localPoint(event);
    if (x < 0 || y < 0 || x > canvas.clientWidth || y > canvas.clientHeight) {
      // Let go outside: nothing is being hovered any more.
      clearHover();
    } else if (timeline) {
      updateHover(x, y);
    }
    requestFrame();
  };

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  const clearHover = () => {
    pointer = null;
    hideTooltip();
    getTimeline()?.setHoverX(null);
    canvas.style.cursor = '';
  };

  canvas.addEventListener('pointerleave', () => {
    if (drag) {
      return;
    }
    clearHover();
    requestFrame();
  });

  // Wheel zooms around the pointer; Shift+wheel and sideways swipes pan.
  canvas.addEventListener('wheel', (event) => {
    if (!hasMap()) {
      return;
    }
    event.preventDefault();
    const timeline = getTimeline();
    const unitPx = event.deltaMode === 1 ? WHEEL_LINE_PX : (event.deltaMode === 2 ? WHEEL_PAGE_PX : 1);
    const deltaXPx = event.deltaX * unitPx;
    const deltaYPx = event.deltaY * unitPx;
    const { x, y } = localPoint(event);
    pointer = { x, y };

    if (event.shiftKey || Math.abs(deltaXPx) > Math.abs(deltaYPx)) {
      // Some browsers turn Shift+wheel into a sideways scroll before it gets here.
      const panPx = event.shiftKey && deltaYPx !== 0 ? deltaYPx : deltaXPx;
      timeline.panBy(panPx * timeline.getMsPerPx());
    } else if (deltaYPx !== 0) {
      const factor = clamp(Math.exp(deltaYPx * (event.ctrlKey ? PINCH_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX)), 0.5, 2);
      if (timeline.regionAt(y) === 'overview') {
        const { startMs, durationMs } = timeline.getView();
        timeline.zoomAt(startMs + (durationMs / 2), factor, 0.5);
      } else {
        timeline.zoomAt(timeline.timeAtX(x), factor, clamp(x / Math.max(1, canvas.clientWidth), 0, 1));
      }
    }
    if (!drag) {
      updateHover(x, y);
    }
    updateTooltip(x, y);
    requestFrame();
  }, { passive: false });

  // A tooltip stranded over a map that is no longer loaded would be lying.
  window.addEventListener('blur', clearHover);

  const zoomAroundPlayhead = (factor) => {
    if (!hasMap()) {
      return;
    }
    getTimeline().zoomAroundPlayhead(factor);
    requestFrame();
  };

  return {
    zoomIn: () => zoomAroundPlayhead(1 / KEY_ZOOM_FACTOR),
    zoomOut: () => zoomAroundPlayhead(KEY_ZOOM_FACTOR),
    isZoomed: () => Boolean(getTimeline()?.isZoomed()),
    resetZoom: () => {
      getTimeline()?.resetZoom();
      requestFrame();
    },
  };
};

export { bindTimelineInput };
