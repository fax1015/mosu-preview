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
  new ResizeObserver(schedule).observe(scroller);
  new MutationObserver(schedule).observe(scroller, { childList: true });

  let drag = null;
  thumb.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    thumb.setPointerCapture(event.pointerId);
    drag = { startY: event.clientY, startScrollTop: scroller.scrollTop };
    track.classList.add('is-dragging');
  });
  thumb.addEventListener('pointermove', (event) => {
    if (!drag) {
      return;
    }
    const travel = track.clientHeight - thumb.offsetHeight;
    if (travel > 0) {
      const overflow = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = drag.startScrollTop + ((event.clientY - drag.startY) * overflow) / travel;
    }
  });
  const endDrag = () => {
    drag = null;
    track.classList.remove('is-dragging');
  };
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);
  thumb.addEventListener('lostpointercapture', endDrag);

  schedule();
};

export { attachOverlayScrollbar };
