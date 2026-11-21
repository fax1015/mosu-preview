// A scrollbar drawn over a list instead of beside it. A native one takes its
// width out of the list as soon as the list overflows, so every item shifts by
// it -- by a different amount in each browser -- and no CSS floats one over the
// content in both. The native one is hidden (see popup.css) and scrolling stays
// native; this only shows where the view is and lets the thumb be dragged.

const MIN_THUMB_PX = 24;

const attachOverlayScrollbar = ({ scroller, track, thumb }) => {
  if (!scroller || !track || !thumb) {
    return;
  }

  let frame = null;
  const update = () => {
    frame = null;
    const overflow = scroller.scrollHeight - scroller.clientHeight;
    track.hidden = overflow < 1;
    if (track.hidden) {
      return;
    }
    const travel = track.clientHeight;
    const thumbHeight = Math.max(MIN_THUMB_PX, Math.round(travel * (scroller.clientHeight / scroller.scrollHeight)));
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${Math.round((scroller.scrollTop / overflow) * (travel - thumbHeight))}px)`;
  };
  const schedule = () => {
    if (frame === null) {
      frame = requestAnimationFrame(update);
    }
  };

  scroller.addEventListener('scroll', schedule, { passive: true });
  // The list changes size as the panel opens and closes, and its content
  // whenever it is rendered again.
  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(scroller);
  }
  let mutationObserver = null;
  if (typeof MutationObserver === 'function') {
    mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(scroller, { childList: true });
  }

  let drag = null;
  const onPointerDown = (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    thumb.setPointerCapture?.(event.pointerId);
    drag = { startY: event.clientY, startScrollTop: scroller.scrollTop };
    track.classList.add('is-dragging');
  };
  const onPointerMove = (event) => {
    if (!drag) {
      return;
    }
    const travel = track.clientHeight - thumb.offsetHeight;
    if (travel > 0) {
      const overflow = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = drag.startScrollTop + ((event.clientY - drag.startY) * overflow) / travel;
    }
  };
  const endDrag = () => {
    drag = null;
    track.classList.remove('is-dragging');
  };
  thumb.addEventListener('pointerdown', onPointerDown);
  thumb.addEventListener('pointermove', onPointerMove);
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);
  thumb.addEventListener('lostpointercapture', endDrag);

  const dispose = () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    scroller.removeEventListener('scroll', schedule);
    thumb.removeEventListener('pointerdown', onPointerDown);
    thumb.removeEventListener('pointermove', onPointerMove);
    thumb.removeEventListener('pointerup', endDrag);
    thumb.removeEventListener('pointercancel', endDrag);
    thumb.removeEventListener('lostpointercapture', endDrag);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    resizeObserver = null;
    mutationObserver = null;
  };
  globalThis.window?.addEventListener?.('pagehide', dispose, { once: true });

  schedule();
  return { schedule, dispose };
};

export { attachOverlayScrollbar };
