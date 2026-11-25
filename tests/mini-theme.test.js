import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MINI_PALETTE, PALETTE_KEYS } from '../src/core/coverPalette.js';
import { buildTimelineColours, createMiniTheme, toCssVariable } from '../src/ui/miniTheme.js';
import { FADE_IN_MS, FADE_OUT_MS, createMiniMorph } from '../src/ui/miniMorph.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const makeRoot = () => {
  const properties = new Map();
  const classes = new Set();
  return {
    properties,
    classes,
    style: {
      setProperty: (name, value) => properties.set(name, value),
    },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
  };
};

// Stands in for createImageBitmap and a 2D canvas: every "cover" decodes to
// the colour its blob was made from.
const withFakeImagePipeline = async (run) => {
  const previous = {
    createImageBitmap: globalThis.createImageBitmap,
    OffscreenCanvas: globalThis.OffscreenCanvas,
  };
  let lastColour = [0, 0, 0];
  globalThis.createImageBitmap = async (blob) => {
    lastColour = blob.colour;
    return { close() {} };
  };
  globalThis.OffscreenCanvas = class {
    getContext() {
      return {
        drawImage() {},
        getImageData: (x, y, width, height) => {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let index = 0; index < data.length; index += 4) {
            data.set([...lastColour, 255], index);
          }
          return { data };
        },
      };
    }
  };
  try {
    await run();
  } finally {
    globalThis.createImageBitmap = previous.createImageBitmap;
    globalThis.OffscreenCanvas = previous.OffscreenCanvas;
  }
};

const coverFetch = (coloursBySet, calls) => async (url) => {
  calls.push(url);
  const setId = url.match(/thumb\/(\d+)l\.jpg$/)?.[1];
  const colour = coloursBySet[setId];
  if (!colour) {
    return { ok: false, status: 404 };
  }
  return { ok: true, status: 200, blob: async () => ({ colour }) };
};

test('toCssVariable names the custom properties popup.css registers', () => {
  assert.equal(toCssVariable('surface'), '--mini-surface');
  assert.equal(toCssVariable('onSecondaryContainer'), '--mini-on-secondary-container');
});

test('the theme starts on the default palette and hands it on', () => {
  const root = makeRoot();
  const published = [];
  const theme = createMiniTheme({ root, getTimeline: () => null, onPalette: (palette) => published.push(palette) });
  assert.equal(theme.getPalette(), DEFAULT_MINI_PALETTE);
  assert.equal(published.length, 1);
  for (const key of PALETTE_KEYS) {
    assert.ok(root.properties.has(toCssVariable(key)), `${key} is set`);
  }
  assert.equal(root.properties.get('--mini-surface'), 'rgb(36, 34, 42)');
});

test('a cover is fetched once, themed by, and reused from the cache', async () => {
  await withFakeImagePipeline(async () => {
    const root = makeRoot();
    const calls = [];
    const theme = createMiniTheme({
      root,
      getTimeline: () => null,
      fetchImpl: coverFetch({ 11: [230, 120, 60], 22: [60, 120, 230] }, calls),
    });

    theme.setCover('11');
    await flush();
    const orange = theme.getPalette();
    assert.notEqual(orange, DEFAULT_MINI_PALETTE);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^https:\/\/b\.ppy\.sh\/thumb\/11l\.jpg$/);

    theme.setCover('11');
    assert.equal(calls.length, 1, 'the same set is not fetched twice in a row');

    theme.setCover('22');
    await flush();
    assert.notEqual(theme.getPalette(), orange);

    theme.setCover('11');
    assert.equal(theme.getPalette(), orange, 'coming back to a set reuses its palette');
    assert.equal(calls.length, 2);
  });
});

test('a cover that answers late does not repaint over the map after it', async () => {
  await withFakeImagePipeline(async () => {
    const root = makeRoot();
    let releaseFirst;
    const theme = createMiniTheme({
      root,
      getTimeline: () => null,
      fetchImpl: async (url) => {
        if (url.includes('/11l')) {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
          return { ok: true, blob: async () => ({ colour: [230, 120, 60] }) };
        }
        return { ok: true, blob: async () => ({ colour: [60, 120, 230] }) };
      },
    });
    theme.setCover('11');
    theme.setCover('22');
    await flush();
    const blue = theme.getPalette();
    releaseFirst();
    await flush();
    assert.equal(theme.getPalette(), blue);
  });
});

test('a cover no longer wanted is let go of, and disposing stops the one in flight', async () => {
  await withFakeImagePipeline(async () => {
    const root = makeRoot();
    const signals = new Map();
    const logs = [];
    const theme = createMiniTheme({
      root,
      getTimeline: () => null,
      addDebugLog: (line) => logs.push(line),
      fetchImpl: (url, { signal }) => {
        const setId = url.match(/thumb\/(\d+)l\.jpg$/)[1];
        signals.set(setId, signal);
        // Never answers on its own: only its signal ends it.
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      },
    });

    theme.setCover('11');
    theme.setCover('22');
    assert.equal(signals.get('11').aborted, true, 'switching maps lets the old cover go');
    assert.equal(signals.get('22').aborted, false);

    theme.dispose();
    assert.equal(signals.get('22').aborted, true);
    await flush();
    assert.equal(theme.getPalette(), DEFAULT_MINI_PALETTE);
    assert.deepEqual(logs, [], 'a cover let go of is not a failure');
  });
});

test('a failed or missing cover falls back to the default palette', async () => {
  await withFakeImagePipeline(async () => {
    const root = makeRoot();
    const logs = [];
    const theme = createMiniTheme({
      root,
      getTimeline: () => null,
      addDebugLog: (line) => logs.push(line),
      fetchImpl: coverFetch({ 11: [230, 120, 60] }, []),
    });
    theme.setCover('11');
    await flush();
    theme.setCover('99');
    await flush();
    assert.equal(theme.getPalette(), DEFAULT_MINI_PALETTE);
    assert.equal(logs.length, 1);

    theme.setCover('11');
    await flush();
    theme.setCover('');
    assert.equal(theme.getPalette(), DEFAULT_MINI_PALETTE);
  });
});

test('the timeline is drawn in the palette only while the bar is collapsed', () => {
  const calls = [];
  const timeline = { setColours: (colours) => calls.push(colours) };
  const theme = createMiniTheme({ root: makeRoot(), getTimeline: () => timeline });
  calls.length = 0;
  theme.setTimelineThemed(true);
  assert.deepEqual(calls.at(-1), buildTimelineColours(DEFAULT_MINI_PALETTE));
  assert.equal(calls.at(-1).playheadStyle, 'bar');
  theme.setTimelineThemed(false);
  assert.equal(calls.at(-1), null);
});

const makePopup = () => {
  const animations = [];
  return {
    animations,
    offsetWidth: 440,
    animate(keyframes, options) {
      const animation = {
        keyframes,
        options,
        cancelled: false,
        cancel() {
          this.cancelled = true;
        },
        addEventListener() {},
      };
      animations.push(animation);
      return animation;
    },
  };
};

const makeTimers = () => {
  const pending = [];
  return {
    pending,
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      pending.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
    runNext() {
      const timer = pending.shift();
      timer?.callback();
      return timer;
    },
  };
};

test('switching without motion swaps the layout outright', () => {
  const root = makeRoot();
  const switched = [];
  const timers = makeTimers();
  const morph = createMiniMorph({
    root,
    popup: makePopup(),
    allowsMotion: () => false,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  morph.setCollapsed(true, { onSwitch: (collapsed) => switched.push(collapsed) });
  assert.ok(root.classes.has('is-embedded-collapsed'));
  assert.ok(!root.classes.has('is-mini-switching'), 'transitions are back on once it has switched');
  assert.deepEqual(switched, [true]);
  assert.equal(timers.pending.length, 0);
  morph.setCollapsed(false);
  assert.ok(!root.classes.has('is-embedded-collapsed'));
});

test('switching with motion fades out, swaps the layout unseen, and fades in', () => {
  const root = makeRoot();
  const popup = makePopup();
  const switched = [];
  const timers = makeTimers();
  const morph = createMiniMorph({
    root,
    popup,
    allowsMotion: () => true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  morph.setCollapsed(true, { onSwitch: (collapsed) => switched.push(collapsed) });
  assert.ok(!root.classes.has('is-embedded-collapsed'), 'the old layout stays while it fades out');
  assert.equal(popup.animations.length, 1);
  const [fadeOut] = popup.animations;
  assert.deepEqual(fadeOut.keyframes.at(-1), { opacity: 0 });
  assert.equal(fadeOut.options.fill, 'forwards');
  assert.equal(timers.pending[0].delay, FADE_OUT_MS);

  timers.runNext();
  assert.ok(root.classes.has('is-embedded-collapsed'));
  assert.deepEqual(switched, [true]);
  assert.ok(fadeOut.cancelled);
  const fadeIn = popup.animations.at(-1);
  assert.equal(fadeIn.options.duration, FADE_IN_MS);
  assert.equal(fadeIn.keyframes[0].opacity, 0);
  assert.match(fadeIn.keyframes[0].transform, /^scale\(0\.\d+\)$/);
  assert.deepEqual(fadeIn.keyframes.at(-1), { opacity: 1, transform: 'none' });
});

test('turning back before the switch goes wherever it was last asked to', () => {
  const root = makeRoot();
  const popup = makePopup();
  const switched = [];
  const timers = makeTimers();
  const morph = createMiniMorph({
    root,
    popup,
    allowsMotion: () => true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  morph.setCollapsed(true, { onSwitch: (collapsed) => switched.push(['first', collapsed]) });
  morph.setCollapsed(false, { onSwitch: (collapsed) => switched.push(['second', collapsed]) });
  assert.equal(popup.animations.length, 1, 'it is already fading out; it does not start again');
  assert.equal(timers.pending.length, 1);
  timers.runNext();
  assert.ok(!root.classes.has('is-embedded-collapsed'));
  assert.deepEqual(switched, [['second', false]]);
});

test('what has to go before the switch goes unseen, before the layout changes', () => {
  const root = makeRoot();
  const timers = makeTimers();
  const seen = [];
  const morph = createMiniMorph({
    root,
    popup: makePopup(),
    allowsMotion: () => true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  morph.setCollapsed(true, {
    onBeforeSwitch: (collapsed) => seen.push([
      'before',
      collapsed,
      root.classes.has('is-embedded-collapsed'),
      root.classes.has('is-mini-switching'),
    ]),
    onSwitch: (collapsed) => seen.push(['after', collapsed, root.classes.has('is-embedded-collapsed')]),
  });
  assert.deepEqual(seen, [], 'nothing closes while the old view is still fading out');
  timers.runNext();
  assert.deepEqual(seen, [['before', true, false, true], ['after', true, true]]);
});
