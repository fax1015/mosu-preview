import test from 'node:test';
import assert from 'node:assert/strict';
import { getCanvasContext } from '../src/core/canvas.js';

const createFakeCanvas = ({ clientWidth = 0, clientHeight = 0, width = 0, height = 0 } = {}) => {
  const calls = [];
  const ctx = {
    setTransform(...args) {
      calls.push({ op: 'setTransform', args });
    },
  };
  return {
    clientWidth,
    clientHeight,
    width,
    height,
    calls,
    getContext(_type, options) {
      calls.push({ op: 'getContext', options });
      return ctx;
    },
  };
};

test('getCanvasContext guarantees a non-zero backing store even when dpr < 1 and client size is 0 (C2)', () => {
  const originalWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 0.75 };
  try {
    const canvas = createFakeCanvas({ clientWidth: 0, clientHeight: 0 });
    const result = getCanvasContext(canvas);
    assert.ok(canvas.width >= 1, `expected width >= 1, got ${canvas.width}`);
    assert.ok(canvas.height >= 1, `expected height >= 1, got ${canvas.height}`);
    assert.equal(result.width, 1);
    assert.equal(result.height, 1);
    assert.deepEqual(canvas.calls[1].args, [0.75, 0, 0, 0.75, 0, 0]);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('getCanvasContext sets alpha option and scales backing store by devicePixelRatio', () => {
  const originalWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 2 };
  try {
    const opaqueCanvas = createFakeCanvas({ clientWidth: 320, clientHeight: 240 });
    getCanvasContext(opaqueCanvas, { transparent: false, lowLatency: true });
    assert.equal(opaqueCanvas.width, 640);
    assert.equal(opaqueCanvas.height, 480);
    assert.deepEqual(opaqueCanvas.calls[0].options, { alpha: false, desynchronized: true });

    const transparentCanvas = createFakeCanvas({ clientWidth: 200, clientHeight: 24 });
    getCanvasContext(transparentCanvas, { transparent: true });
    assert.deepEqual(transparentCanvas.calls[0].options, { alpha: true });
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
