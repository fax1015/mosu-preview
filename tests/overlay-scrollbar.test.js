import test from 'node:test';
import assert from 'node:assert/strict';
import { attachOverlayScrollbar } from '../src/ui/overlayScrollbar.js';

const createEmitterTarget = (props = {}) => {
  const listeners = new Map();
  return {
    ...props,
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
  };
};

test('attachOverlayScrollbar runs without ResizeObserver/MutationObserver and cleans up on dispose', () => {
  const origRaf = globalThis.requestAnimationFrame;
  const origCancelRaf = globalThis.cancelAnimationFrame;
  const origRO = globalThis.ResizeObserver;
  const origMO = globalThis.MutationObserver;
  let pendingCb = null;
  let cancelledId = null;
  globalThis.requestAnimationFrame = (cb) => { pendingCb = cb; return 42; };
  globalThis.cancelAnimationFrame = (id) => { cancelledId = id; pendingCb = null; };
  delete globalThis.ResizeObserver;
  delete globalThis.MutationObserver;

  try {
    const scroller = createEmitterTarget({ scrollHeight: 400, clientHeight: 100, scrollTop: 50 });
    const track = { hidden: true, clientHeight: 100, classList: { add() {}, remove() {} } };
    const thumb = createEmitterTarget({ style: {}, offsetHeight: 25 });

    const handle = attachOverlayScrollbar({ scroller, track, thumb });
    assert.ok(handle);
    assert.equal(typeof pendingCb, 'function');
    pendingCb();
    assert.equal(track.hidden, false);
    assert.equal(thumb.style.height, '25px');

    handle.schedule();
    handle.dispose();
    assert.equal(cancelledId, 42);
    assert.equal(scroller.listeners.get('scroll').size, 0);
    assert.equal(thumb.listeners.get('pointerdown').size, 0);
  } finally {
    if (origRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = origRaf;
    if (origCancelRaf === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = origCancelRaf;
    if (origRO !== undefined) globalThis.ResizeObserver = origRO;
    if (origMO !== undefined) globalThis.MutationObserver = origMO;
  }
});
