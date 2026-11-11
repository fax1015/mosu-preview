import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPopupUiEvents } from '../src/ui/popupUI.js';
import { assignKeybinding, normalizeKeybindings } from '../src/core/keybindings.js';

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

const setup = ({
  infoMenuOpen = false, shortcutsMenuOpen = false, renderer = {}, keybindings = normalizeKeybindings(),
  selectedObjects = 0,
} = {}) => {
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
  const timeLabel = { ...createListenerHost(), tagName: 'BUTTON' };

  const state = {
    infoMenuOpen,
    shortcutsMenuOpen,
    isPlaying: false,
    durationMs: 60000,
    currentTimeMs: 1000,
    playbackSpeed: 1,
    volume: 0.5,
    mapData: {},
    selectedObjects,
    keybindings,
    capturingShortcutAction: null,
  };

  bindPopupUiEvents({
    elements: {
      playfieldCanvas: canvas, timelineCanvas: canvas, recentPanel, timeLabel,
    },
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
      seekToSectionMark: record('seekToSectionMark'),
      copyEditorTimestamp: record('copyEditorTimestamp'),
      // Stands in for the shortcuts panel: it takes the keyboard whenever a
      // chip is armed, exactly as the real one does.
      consumeShortcutCapture: (event) => {
        if (!state.capturingShortcutAction) {
          return false;
        }
        calls.push(['captured', event.key]);
        return true;
      },
      restartPreview: record('restartPreview'),
      cyclePlaybackSpeed: record('cyclePlaybackSpeed'),
      cycleManiaKeyCount: record('cycleManiaKeyCount'),
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
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      // A captured key must not reach the Escape handler registered after
      // this one, which is what stopping it immediately is for.
      stopImmediatePropagation() { this.propagationStopped = true; },
      getModifierState: (name) => name === 'AltGraph' && altGraph,
    };
    // Honoured the way the DOM honours it, so a test can prove that a
    // captured Escape never reaches the handler that closes the window.
    for (const listener of documentHost.listeners.keydown || []) {
      if (event.propagationStopped) {
        break;
      }
      await listener(event);
    }
    return event;
  };

  const restore = () => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
  };

  return {
    calls, press, restore, recentRow, timeLabel, state,
  };
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

test('K steps the mania key count, and Ctrl+K is left to the browser', async () => {
  const { calls, press, restore } = setup();
  try {
    await press('k');
    await press('K', { shiftKey: true });
    await press('k', { ctrlKey: true });
    assert.deepEqual(names(calls), ['cycleManiaKeyCount', 'cycleManiaKeyCount']);
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

test('N and P walk the map\'s own sections', async () => {
  const { calls, press, restore } = setup();
  try {
    await press('n');
    await press('p');
    await press('N', { shiftKey: true });
    assert.deepEqual(calls, [
      ['seekToSectionMark', 1],
      ['seekToSectionMark', -1],
      ['seekToSectionMark', 1],
    ]);
  } finally {
    restore();
  }
});

test('C copies the timestamp, and Ctrl+C is left to the browser', async () => {
  const { calls, press, restore } = setup();
  try {
    await press('c');
    // Copying a selection out of the popup belongs to the browser.
    await press('c', { ctrlKey: true });
    await press('c', { metaKey: true });
    assert.deepEqual(names(calls), ['copyEditorTimestamp']);
  } finally {
    restore();
  }
});

test('Space on the time label presses that button instead of toggling playback', async () => {
  // It copies the timestamp, so it is a real button now; Space on it has to
  // reach it rather than starting the preview behind it.
  const { calls, press, restore, timeLabel } = setup();
  try {
    await press(' ', { target: timeLabel });
    await press('Enter', { target: timeLabel });
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('a remapped key drives the action, and the key it moved off does not', () => {
  const { bindings } = assignKeybinding(normalizeKeybindings(), 'restart', 'z');

  return (async () => {
    const { calls, press, restore } = setup({ keybindings: bindings });
    try {
      await press('z');
      await press('r');
      assert.deepEqual(names(calls), ['restartPreview']);
    } finally {
      restore();
    }
  })();
});

test('a key taken from one action stops driving it', async () => {
  // Binding mute to R leaves restart with nothing, so R must mute and only mute.
  const { bindings } = assignKeybinding(normalizeKeybindings(), 'mute', 'r');
  const { calls, press, restore } = setup({ keybindings: bindings });
  try {
    await press('r');
    assert.deepEqual(names(calls), ['toggleMute']);
  } finally {
    restore();
  }
});

test('shift still lengthens a seek that has been remapped', async () => {
  const { bindings } = assignKeybinding(normalizeKeybindings(), 'seekForward', 'd');
  const { calls, press, restore } = setup({ keybindings: bindings });
  try {
    await press('d');
    await press('D', { shiftKey: true });
    assert.deepEqual(calls, [['seekRelative', 5000], ['seekRelative', 15000]]);
  } finally {
    restore();
  }
});

test('an armed chip takes the keypress before the preview sees it', async () => {
  const { calls, press, restore, state } = setup();
  try {
    state.capturingShortcutAction = 'mute';
    // Keys the preview would otherwise act on, and one a dialog would.
    await press(' ');
    await press('r');
    await press('Escape');
    assert.deepEqual(calls, [['captured', ' '], ['captured', 'r'], ['captured', 'Escape']]);
  } finally {
    restore();
  }
});

test('the preview answers again once nothing is armed', async () => {
  const { calls, press, restore, state } = setup();
  try {
    state.capturingShortcutAction = 'mute';
    await press('r');
    state.capturingShortcutAction = null;
    await press('r');
    assert.deepEqual(calls, [['captured', 'r'], ['restartPreview']]);
  } finally {
    restore();
  }
});

test('the shortcuts panel still answers its own key while it is up', async () => {
  const { calls, press, restore } = setup({ shortcutsMenuOpen: true });
  try {
    await press('?');
    // On a layout where shift+/ does not report '?' by itself.
    await press('/', { shiftKey: true });
    // Everything else is swallowed by the dialog.
    await press('r');
    assert.deepEqual(names(calls), ['setShortcutsMenuOpen', 'setShortcutsMenuOpen']);
  } finally {
    restore();
  }
});

test('an action left unbound answers to nothing', async () => {
  const keybindings = normalizeKeybindings({ restart: [] });
  const { calls, press, restore } = setup({ keybindings });
  try {
    await press('r');
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('Escape is left alone: it still only zooms out, then closes', async () => {
  // It already closes the popup, so it is not given anything else to do --
  // the selection has a key of its own.
  const zoomCalls = [];
  const { calls, press, restore } = setup({
    renderer: createZoomableRenderer(zoomCalls, { zoomed: true }),
    selectedObjects: 3,
  });
  try {
    await press('Escape');
    assert.deepEqual(names(calls), [], 'the selection is not touched');
    assert.deepEqual(zoomCalls, [['resetZoom']]);

    await press('Escape');
    assert.deepEqual(names(calls), ['window.close']);
  } finally {
    restore();
  }
});

test('a focused slider keeps the keys that move it and gives up the rest', async () => {
  // The volume and speed sliders are inputs, and were treated as text fields:
  // after dragging one, Space and every other shortcut did nothing until
  // something else was clicked.
  const slider = { tagName: 'INPUT', type: 'range' };
  const { calls, press, restore } = setup();
  try {
    await press(' ', { target: slider });
    await press('m', { target: slider });
    assert.deepEqual(
      names(calls).filter((name) => name !== 'showCanvasToggleFeedback'),
      ['togglePlayback', 'toggleMute'],
    );

    calls.length = 0;
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
      const event = await press(key, { target: slider });
      assert.equal(event.defaultPrevented, false, `${key} still moves the slider`);
    }
    assert.deepEqual(calls, [], 'and seeks nothing');
  } finally {
    restore();
  }
});

test('a text field still swallows every key', async () => {
  const { calls, press, restore } = setup();
  try {
    await press(' ', { target: { tagName: 'INPUT', type: 'text' } });
    await press('r', { target: { tagName: 'TEXTAREA' } });
    await press('m', { target: { tagName: 'SELECT' } });
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});
