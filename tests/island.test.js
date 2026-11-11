// The island: one small capsule in the preview's corner for the audio status
// and every message, there only while something is going on, with a colour
// for each kind of thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INSTRUCTION_MESSAGE_MS,
  ISLAND_COLOURS,
  ISLAND_COMPACT_PX,
  ISLAND_MAX_MESSAGE_PX,
  createIslandModel,
  createIslandRenderer,
  islandColour,
  resolveIslandView,
} from '../src/ui/island.js';
import {
  AUDIO_READY_SHOWN_MS,
  buildArchiveProviderProgressParts,
  createAudioBadgeController,
  resolveAudioActivity,
} from '../src/ui/audioBadge.js';

// Timers run by hand: `schedule` hands back an id, `run` fires them.
const createClock = () => {
  const pending = new Map();
  let nextId = 1;
  return {
    schedule: (callback, delayMs) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, delayMs });
      return id;
    },
    registry: {
      addTimeout: (id) => id,
      clearTimeout: (id) => {
        pending.delete(id);
        return null;
      },
    },
    delays: () => [...pending.values()].map((timer) => timer.delayMs),
    run: () => {
      const timers = [...pending.values()];
      pending.clear();
      timers.forEach((timer) => timer.callback());
    },
  };
};

// --- what it shows ------------------------------------------------------------

test('with nothing going on there is no island at all', () => {
  assert.deepEqual(resolveIslandView({}), { mode: 'hidden' });
  assert.deepEqual(resolveIslandView({ activity: null, message: null }), { mode: 'hidden' });
});

test('a message wins over an activity for as long as it is up', () => {
  const activity = { kind: 'progress', progress: 0.4, text: '40%' };
  assert.equal(resolveIslandView({ activity }).mode, 'compact');
  assert.deepEqual(resolveIslandView({ activity, message: { text: 'Copied', tone: 'copy' } }), {
    mode: 'message', tone: 'copy', text: 'Copied',
  });
});

test('each kind of thing has a colour of its own', () => {
  // The full track arriving and a timestamp copied are both good news, and
  // were once the same green; they are told apart at a glance now.
  assert.equal(islandColour({ mode: 'compact', kind: 'ready' }), 'ready');
  assert.equal(islandColour({ mode: 'compact', kind: 'progress' }), 'progress');
  for (const tone of ['info', 'done', 'copy', 'error']) {
    assert.equal(islandColour({ mode: 'message', tone }), tone);
  }
  assert.equal(new Set(ISLAND_COLOURS).size, 6);
});

const createModel = () => {
  const clock = createClock();
  const views = [];
  const state = { toastHideTimer: null };
  const model = createIslandModel({
    render: (view) => views.push(view), state, registry: clock.registry, schedule: clock.schedule,
  });
  return {
    model, clock, views, state, last: () => views[views.length - 1],
  };
};

test('a message comes and goes, back to what was there before it', () => {
  const { model, clock, last, state } = createModel();
  model.setActivity({ kind: 'progress', progress: null, text: '' });
  model.showMessage('Cache cleared', { tone: 'done' });
  assert.equal(last().mode, 'message');
  assert.deepEqual(clock.delays(), [3500]);

  clock.run();
  assert.equal(last().mode, 'compact', 'back to the download it covered');
  assert.equal(state.toastHideTimer, null);

  model.setActivity(null);
  assert.equal(last().mode, 'hidden');
});

test('a new message replaces the last and restarts the clock', () => {
  const { model, clock, last } = createModel();
  model.showMessage('At the first section');
  model.showMessage('mapset page opened, exit this view to see it', { durationMs: INSTRUCTION_MESSAGE_MS });
  assert.equal(last().text, 'mapset page opened, exit this view to see it');
  assert.deepEqual(clock.delays(), [INSTRUCTION_MESSAGE_MS], 'the first one\'s timer is gone');
  assert.ok(INSTRUCTION_MESSAGE_MS > 3500, 'an instruction stays up longer than a confirmation');
});

test('a message has a tone, info unless it says otherwise', () => {
  const { model, last } = createModel();
  model.showMessage('Following the browser');
  assert.equal(last().tone, 'info');
  model.showMessage('Could not reach the clipboard', { tone: 'error' });
  assert.equal(last().tone, 'error');
  model.showMessage('Copied', { tone: 'copy' });
  assert.equal(last().tone, 'copy');
  model.showMessage('Copied', { tone: 'copied' });
  assert.equal(last().tone, 'info', 'a tone it does not know is info, not unstyled');
});

test('a message can be put away early, and only a message', () => {
  const { model, clock, last } = createModel();
  assert.equal(model.dismissMessage(), false, 'nothing to put away');
  model.showMessage('Pinned to this map');
  assert.equal(model.dismissMessage(), true);
  assert.equal(last().mode, 'hidden');
  assert.deepEqual(clock.delays(), []);
});

// --- what the audio has to say ------------------------------------------------

test('only audio that is doing something shows', () => {
  assert.equal(resolveAudioActivity(null, false), null);
  assert.equal(resolveAudioActivity({ stateName: 'preview', label: 'Preview audio - osu!' }, false), null, 'the preview playing is not news');
  assert.equal(resolveAudioActivity({ stateName: 'settled', label: 'Full audio ready' }, false), null, 'nor is the full track');
  assert.equal(resolveAudioActivity({ stateName: 'failed', label: 'Full audio failed' }, true), null, 'a failure is a message, then nothing');

  assert.deepEqual(
    resolveAudioActivity({ stateName: 'loading', label: 'Loading full audio - mirror', progress: 0.42 }, true),
    { kind: 'progress', progress: 0.42, text: '42%', title: 'Loading full audio - mirror' },
  );
  assert.equal(resolveAudioActivity({ stateName: 'loading', label: 'Loading audio' }, false).text, '', 'no size, no figure');
  assert.equal(resolveAudioActivity({ stateName: 'preview', label: 'Preview audio' }, true).kind, 'progress', 'the full track on its way');
  assert.equal(resolveAudioActivity({ stateName: 'ready', label: 'Full audio ready' }, false).kind, 'ready');
});

const createAudio = () => {
  const clock = createClock();
  const activities = [];
  const messages = [];
  const island = {
    setActivity: (activity) => activities.push(activity),
    showMessage: (text, options = {}) => messages.push({ text, tone: options.tone ?? 'info' }),
  };
  const previousSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = clock.schedule;
  const controller = createAudioBadgeController({
    island,
    state: { audioBadgeHideTimer: null },
    registry: clock.registry,
    renderDebugPanel: () => {},
    getProviderDisplayName: () => 'mirror',
    setProviderState: () => {},
  });
  return {
    controller,
    clock,
    messages,
    activity: () => activities[activities.length - 1],
    restore: () => { globalThis.setTimeout = previousSetTimeout; },
  };
};

test('a download shows as a ring, the tick when it lands, then nothing', () => {
  const { controller, clock, activity, messages, restore } = createAudio();
  try {
    controller.setAudioBadgeWithProvider('preview', 'Preview audio', 'osu!');
    assert.equal(activity(), null);

    controller.setFullAudioLoading(true);
    controller.showTryingArchiveProviderBadge('mirror', { loaded: 42, total: 100 });
    assert.equal(activity().kind, 'progress');
    assert.equal(activity().text, '42%');
    assert.match(activity().title, /Fetching beatmap archive from mirror/, 'the detail is in its tooltip');

    controller.setAudioBadgeWithProvider('ready', 'Full audio ready', 'cache');
    assert.equal(activity().kind, 'ready');
    assert.deepEqual(clock.delays(), [AUDIO_READY_SHOWN_MS]);
    controller.setFullAudioLoading(false);
    clock.run();
    assert.equal(activity(), null, 'and then it is gone');
    assert.deepEqual(messages, [], 'none of that is a message');
  } finally {
    restore();
  }
});

test('a failure is said once, as a message, and leaves nothing behind', () => {
  const { controller, activity, messages, restore } = createAudio();
  try {
    controller.setFullAudioLoading(true);
    controller.setAudioBadgeWithProvider('failed', 'Full audio failed', 'mirror', 'HTTP 503');
    controller.setFullAudioLoading(false);
    assert.deepEqual(messages, [{ text: 'Full audio failed - mirror', tone: 'error' }]);
    assert.equal(activity(), null);
  } finally {
    restore();
  }
});

test('only the preview ever playing is said once, and why, in a line or two', () => {
  const { controller, messages, restore } = createAudio();
  try {
    controller.setAudioBadgeWithProvider('preview', 'Preview audio', 'osu!', 'Full audio not available for this beatmap');
    controller.setAudioBadge(
      'preview',
      'No audio available',
      'This beatmap has no preview point and no downloadable audio, so the preview runs silently.',
    );
    assert.deepEqual(messages.map((message) => message.text), [
      'Full audio not available for this beatmap',
      'No audio available',
    ], 'an explanation too long for the island is told by its label');
  } finally {
    restore();
  }
});

test('a download\'s progress comes as a fraction when its size is known', () => {
  assert.equal(buildArchiveProviderProgressParts({ loaded: 1, total: 4 }).fraction, 0.25);
  assert.equal(buildArchiveProviderProgressParts({ loaded: 9, total: 4 }).fraction, 1);
  assert.equal(buildArchiveProviderProgressParts({ loaded: 1 }).fraction, null);
  assert.equal(buildArchiveProviderProgressParts(null).fraction, null);
});

// --- the renderer, against a stand-in DOM --------------------------------------
//
// Laid out by rule of thumb: a layer is 24px plus 6px a character of text.

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.classes = new Set();
    this.attributes = new Map();
    this.style = {};
    this.hidden = false;
    this.title = '';
    this.ownText = '';
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, force) => {
        const on = force === undefined ? !this.classes.has(name) : Boolean(force);
        if (on) this.classes.add(name); else this.classes.delete(name);
        return on;
      },
      contains: (name) => this.classes.has(name),
    };
  }

  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }

  set textContent(value) { this.ownText = String(value); }

  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = value;
  }

  append(...nodes) {
    nodes.forEach((node) => {
      node.parent = this;
      this.children.push(node);
    });
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  querySelector(selector) {
    const name = selector.replace(/^\./, '');
    const stack = [...this.children];
    while (stack.length) {
      const node = stack.shift();
      if (node.classes.has(name)) return node;
      stack.push(...node.children);
    }
    return null;
  }

  get offsetWidth() { return 24 + (6 * this.textContent.length); }

  get offsetHeight() { return 24; }
}

const createRenderer = ({ motion = true, previewWidth = 412 } = {}) => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (namespace, tag) => new FakeNode(tag),
  };
  const element = new FakeNode('div');
  element.parentElement = { offsetWidth: previewWidth };
  const clock = createClock();
  const renderer = createIslandRenderer({ element, allowMotion: () => motion, schedule: clock.schedule });
  const layers = () => element.children.filter((child) => !child.classes.has('is-leaving'));
  return {
    renderer, element, clock, layers, restore: () => { globalThis.document = previousDocument; },
  };
};

const px = (value) => Number.parseFloat(value);

test('it grows out of a dot in the corner, fits what it shows, and shrinks back to one', () => {
  const { renderer, element, layers, clock, restore } = createRenderer();
  try {
    renderer.render({ mode: 'compact', kind: 'progress', progress: 0.4, text: '40%', title: 'Loading full audio' });
    assert.equal(element.classes.has('is-hidden'), false);
    assert.equal(px(element.style.width), 24 + (6 * 4), 'as wide as the ring and the widest figure, "100%"');
    assert.equal(element.title, 'Loading full audio');

    renderer.render({ mode: 'message', tone: 'copy', text: 'Copied' });
    assert.equal(px(element.style.width), 24 + (6 * 6), 'as wide as its message: a badge, not a banner');
    assert.ok(element.classes.has('is-copy'));
    assert.equal(layers().length, 1, 'the old layer is on its way out');
    assert.equal(element.children.length, 2, 'and still there to fade');
    clock.run();
    assert.equal(element.children.length, 1, 'then gone');

    renderer.render({ mode: 'hidden' });
    assert.ok(element.classes.has('is-hidden'));
    assert.ok(element.classes.has('is-copy'), 'it fades out in the colour it had');
    assert.equal(px(element.style.width), ISLAND_COMPACT_PX, 'a dot, to shrink into');
    assert.equal(element.title, '');
  } finally {
    restore();
  }
});

test('its colour says what it is about, one at a time', () => {
  const { renderer, element, restore } = createRenderer();
  const colours = () => ISLAND_COLOURS.map((name) => `is-${name}`).filter((name) => element.classes.has(name));
  try {
    renderer.render({ mode: 'compact', kind: 'progress', progress: null, text: '' });
    assert.deepEqual(colours(), ['is-progress'], 'amber while the track downloads');
    renderer.render({ mode: 'compact', kind: 'ready' });
    assert.deepEqual(colours(), ['is-ready']);
    renderer.render({ mode: 'message', tone: 'copy', text: 'Copied 01:23:456' });
    assert.deepEqual(colours(), ['is-copy']);
    renderer.render({ mode: 'message', tone: 'done', text: 'Cache cleared' });
    assert.deepEqual(colours(), ['is-done']);
    renderer.render({ mode: 'message', tone: 'error', text: 'Full audio failed' });
    assert.deepEqual(colours(), ['is-error']);
    renderer.render({ mode: 'message', tone: 'info', text: 'Pinned to this map' });
    assert.deepEqual(colours(), ['is-info']);
  } finally {
    restore();
  }
});

test('a download moving on is updated where it stands, not swapped', () => {
  const { renderer, element, layers, restore } = createRenderer();
  try {
    renderer.render({ mode: 'compact', kind: 'progress', progress: 0.09, text: '9%' });
    const [layer] = layers();
    renderer.render({ mode: 'compact', kind: 'progress', progress: 0.1, text: '10%' });
    assert.deepEqual(layers(), [layer], 'the same layer');
    assert.equal(element.children.length, 1, 'nothing crossfading');
    assert.equal(layer.querySelector('.map-preview-island-ring-fill').style.strokeDasharray, '10 100');
    assert.equal(layer.querySelector('.map-preview-island-figure').textContent, '10%', 'showing its own figure, not the one it was sized by');
  } finally {
    restore();
  }
});

test('a download keeps one width from its first percentage to its last', () => {
  const { renderer, element, restore } = createRenderer();
  try {
    const widths = [];
    for (const [progress, text] of [[0.03, '3%'], [0.42, '42%'], [0.99, '99%'], [1, '100%']]) {
      renderer.render({ mode: 'compact', kind: 'progress', progress, text });
      widths.push(px(element.style.width));
    }
    assert.deepEqual(new Set(widths).size, 1, `no growing a digit at a time: ${widths.join(', ')}`);
    assert.equal(widths[0], 24 + (6 * 4), 'sized for "100%" from the start');

    // Done: the tick has a size of its own again.
    renderer.render({ mode: 'compact', kind: 'ready' });
    assert.equal(px(element.style.width), 24);
  } finally {
    restore();
  }
});

test('without motion a replaced layer goes at once', () => {
  const { renderer, element, restore } = createRenderer({ motion: false });
  try {
    renderer.render({ mode: 'compact', kind: 'ready' });
    renderer.render({ mode: 'message', tone: 'info', text: 'Following the browser' });
    assert.equal(element.children.length, 1);
    assert.equal(element.children[0].classes.has('is-entering'), false);
  } finally {
    restore();
  }
});

test('a message is held to a badge\'s width, and inside what it sits in', () => {
  const longMessage = 'mapset page opened, exit this view to see it';
  const wide = createRenderer({ previewWidth: 900 });
  try {
    wide.renderer.render({ mode: 'message', tone: 'info', text: longMessage });
    assert.equal(wide.element.children[0].style.maxWidth, `${ISLAND_MAX_MESSAGE_PX}px`, 'a corner badge, however wide the window');
  } finally {
    wide.restore();
  }
  const narrow = createRenderer({ previewWidth: 200 });
  try {
    narrow.renderer.render({ mode: 'message', tone: 'info', text: longMessage });
    assert.equal(narrow.element.children[0].style.maxWidth, '188px', 'clear of the far edge of a narrow preview');
  } finally {
    narrow.restore();
  }
});

// --- where it sits --------------------------------------------------------------
//
// No layout engine here, so these guard the structure: the island is in the
// preview, pinned to its top-right corner and small, out of the header, and
// nothing like a button to look at.

const css = readFileSync(new URL('../popup.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');

const ruleFor = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `${selector} is styled in popup.css`);
  return match[1];
};

test('the island is in the preview\'s top-right corner, and small', () => {
  const preview = html.slice(html.indexOf('class="map-preview-canvas-wrap"'), html.indexOf('class="map-preview-controls"'));
  const header = html.slice(html.indexOf('class="map-preview-header"'), html.indexOf('class="map-preview-canvas-wrap"'));
  assert.ok(preview.includes('id="mapPreviewIsland"'), 'in the preview');
  assert.equal(header.includes('mapPreviewIsland'), false, 'not in the header');

  const island = ruleFor('.map-preview-island');
  assert.match(island, /position:\s*absolute/);
  assert.match(island, /top:\s*6px/);
  assert.match(island, /right:\s*6px/);
  assert.match(island, new RegExp(`width:\\s*${ISLAND_COMPACT_PX}px`));
  assert.ok(ISLAND_COMPACT_PX < 24, 'smaller than the header\'s 24px buttons');
});

test('it moves on a spring, and not like the popup\'s buttons', () => {
  const island = ruleFor('.map-preview-island');
  assert.match(island, /width var\(--island-morph\) var\(--island-spring\)/);
  assert.match(island, /--island-spring:\s*linear\(/, 'a sampled spring, overshoot and all');
  assert.doesNotMatch(island, /border:/, 'filled, with no button border');
  const element = html.match(/<div class="([^"]*)" id="mapPreviewIsland"/);
  assert.ok(element, 'the island is in popup.html');
  assert.doesNotMatch(element[1], /map-preview-info-btn/, 'not styled as one of the buttons');
  assert.match(element[1], /is-hidden/, 'and not there until it has something to show');
});

test('it is edged like the other elements, with no drop shadow', () => {
  const shadow = ruleFor('.map-preview-island').match(/box-shadow:\s*([^;]+);/)?.[1] || '';
  assert.match(shadow, /^inset\b/, 'a hairline, drawn inset');
  assert.doesNotMatch(shadow, /,/, 'and nothing under it');
});

test('every kind of thing is filled with a colour of its own', () => {
  const fills = ISLAND_COLOURS.map((name) => {
    const rule = ruleFor(`.map-preview-island.is-${name}`);
    const fill = rule.match(/--island-bg:\s*([^;]+);/)?.[1];
    assert.ok(fill, `a ${name} island has a fill`);
    return fill.trim();
  });
  assert.equal(new Set(fills).size, fills.length, 'no two alike');
  assert.match(ruleFor('.map-preview-island'), /background-color 0\.2s/, 'one colour blends into the next');
});
