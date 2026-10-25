import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPopupUiEvents } from '../src/ui/popupUI.js';

// Captures listeners instead of dispatching real events, so a test can hand the
// keydown handler exactly the modifiers and target it wants to check.
const createListenerHost = () => {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    },
    removeEventListener() {},
  };
};

const setup = ({ infoMenuOpen = false, shortcutsMenuOpen = false, renderer = {} } = {}) => {
  const documentHost = createListenerHost();
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.document = { ...documentHost, activeElement: null };
  globalThis.window = {
    ...createListenerHost(),
    close() {
      calls.push(['window.close']);
    },
  };
  globalThis.requestAnimationFrame = () => 1;

  const calls = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
  };
  const recentRow = { tagName: 'BUTTON' };
  const recentPanel = { hidden: false, contains: (target) => target === recentRow };
  const canvas = { ...createListenerHost(), getBoundingClientRect: () => ({ left: 0, width: 100 }) };

  const state = {
    infoMenuOpen,
    shortcutsMenuOpen,
    isPlaying: false,
    durationMs: 60000,
    currentTimeMs: 1000,
    playbackSpeed: 1,
    volume: 0.5,
    mapData: {},
  };

  bindPopupUiEvents({
    elements: { playfieldCanvas: canvas, timelineCanvas: canvas, recentPanel },
    state,
    renderer,
    registry: { addTimeout: (id) => id, clearTimeout: () => null },
    supportLinks: {},
    actions: {
      togglePlayback: async () => {
        calls.push(['togglePlayback']);
        return true;
      },
      showCanvasToggleFeedback: record('showCanvasToggleFeedback'),
      seekRelative: record('seekRelative'),
      seekTo: record('seekTo'),
      restartPreview: record('restartPreview'),
      cyclePlaybackSpeed: record('cyclePlaybackSpeed'),
      applyPlaybackSpeed: record('applyPlaybackSpeed'),
      applyAudioVolume: record('applyAudioVolume'),
      toggleMute: record('toggleMute'),
      setShortcutsMenuOpen: record('setShortcutsMenuOpen'),
      setInfoMenuOpen: record('setInfoMenuOpen'),
    },
  });

  const press = async (key, {
    ctrlKey = false, metaKey = false, altKey = false, shiftKey = false, altGraph = false,
    target = { tagName: 'BODY' },
  } = {}) => {
    const event = {
      key,
      ctrlKey,
      metaKey,
      altKey,
      shiftKey,
      target,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      getModifierState: (name) => name === 'AltGraph' && altGraph,
    };
    for (const listener of documentHost.listeners.keydown || []) {
      await listener(event);
    }
    return event;
  };

  const restore = () => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
  };

  return { calls, press, restore, recentRow, state };
};

const names = (calls) => calls.map(([name]) => name);

test('a plain shortcut still drives the preview', async () => {
  const { calls, press, restore } = setup();
  try {
    await press(' ');
    await press('r');
    assert.deepEqual(names(calls).filter((name) => name !== 'showCanvasToggleFeedback'), ['togglePlayback', 'restartPreview']);
  } finally {
    restore();
  }
});

test('browser shortcuts are left to the browser', async () => {
  // Ctrl+R in the detached window used to reload it and restart the preview.
  const { calls, press, restore } = setup();
  try {
    await press('r', { ctrlKey: true });
    await press('s', { metaKey: true });
    await press('ArrowLeft', { altKey: true });
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('AltGr still types the speed keys on layouts that need it', async () => {
  // Windows reports AltGr as Ctrl+Alt; German and Nordic layouts type [ and ] with it.
  const { calls, press, restore } = setup();
  try {
    await press(']', { ctrlKey: true, altKey: true, altGraph: true });
    assert.deepEqual(names(calls), ['applyPlaybackSpeed']);
  } finally {
    restore();
  }
});

test('an open dialog keeps Space for its own buttons', async () => {
  const { calls, press, restore } = setup({ infoMenuOpen: true });
  try {
    const event = await press(' ', { target: { tagName: 'BUTTON' } });
    await press('ArrowRight');
    assert.deepEqual(calls, [], 'the preview behind a modal dialog must not react');
    assert.equal(event.defaultPrevented, false, 'preventing it would stop the button activating');
  } finally {
    restore();
  }
});

test('the shortcuts key still works while a dialog is open', async () => {
  const { calls, press, restore } = setup({ infoMenuOpen: true });
  try {
    await press('?', { shiftKey: true });
    assert.deepEqual(calls, [['setShortcutsMenuOpen', true]]);
  } finally {
    restore();
  }
});

test('Space on a cached mapset row opens the row rather than playing', async () => {
  const { calls, press, restore, recentRow } = setup();
  try {
    const event = await press(' ', { target: recentRow });
    assert.deepEqual(calls, []);
    assert.equal(event.defaultPrevented, false);
  } finally {
    restore();
  }
});

// Stands in for the renderer's timeline, recording what the keys ask of it.
const createZoomableRenderer = (calls, { zoomed = false } = {}) => ({
  timeline: {
    isZoomed: () => zoomed,
    zoomAroundPlayhead: (factor) => calls.push(['zoomAroundPlayhead', factor]),
    resetZoom: () => {
      zoomed = false;
      calls.push(['resetZoom']);
    },
  },
});

test('plus and minus zoom the timeline around the playhead', async () => {
  const calls = [];
  const { press, restore } = setup({ renderer: createZoomableRenderer(calls) });
  try {
    await press('=');
    await press('+', { shiftKey: true });
    await press('-');
    assert.deepEqual(calls, [
      ['zoomAroundPlayhead', 0.5],
      ['zoomAroundPlayhead', 0.5],
      ['zoomAroundPlayhead', 2],
    ]);
  } finally {
    restore();
  }
});

test('Ctrl with plus or minus is left to the browser zoom', async () => {
  const calls = [];
  const { press, restore } = setup({ renderer: createZoomableRenderer(calls) });
  try {
    await press('=', { ctrlKey: true });
    await press('-', { ctrlKey: true });
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('Escape zooms the timeline back out before it closes the popup', async () => {
  const zoomCalls = [];
  const { calls, press, restore } = setup({ renderer: createZoomableRenderer(zoomCalls, { zoomed: true }) });
  try {
    await press('Escape');
    assert.deepEqual(zoomCalls, [['resetZoom']]);
    assert.deepEqual(names(calls), []);
    await press('Escape');
    assert.deepEqual(names(calls), ['window.close']);
  } finally {
    restore();
  }
});
