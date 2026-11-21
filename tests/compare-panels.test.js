import test from 'node:test';
import assert from 'node:assert/strict';

// Just enough DOM for the panels controller: elements it creates, appends,
// labels and removes. Layout is the detached window's, which reads sizes
// rather than computing them.
class FakeClassList {
  constructor() {
    this.set = new Set();
  }

  add(...names) { names.forEach((name) => this.set.add(name)); }

  remove(...names) { names.forEach((name) => this.set.delete(name)); }

  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }

  contains(name) { return this.set.has(name); }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.style = {
      props: new Map(),
      setProperty(name, value) { this.props.set(name, value); },
      removeProperty(name) { this.props.delete(name); },
    };
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this.clientWidth = 1200;
    this.clientHeight = 800;
  }

  set className(value) { this.classList = new FakeClassList(); String(value).split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name)); }

  get className() { return [...this.classList.set].join(' '); }

  append(...nodes) {
    nodes.forEach((node) => {
      if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = this;
      this.children.push(node);
    });
  }

  replaceChildren(...nodes) {
    this.children.forEach((child) => { child.parent = null; });
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
  }

  contains(node) {
    for (let current = node; current; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  getAttribute(name) { return this.attributes.get(name) ?? null; }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  click() { (this.listeners.get('click') || []).forEach((listener) => listener({ target: this, stopPropagation() {} })); }

  querySelector(selector) {
    const name = selector.replace(/^\./, '');
    const stack = [...this.children];
    while (stack.length) {
      const node = stack.shift();
      if (node.classList.contains(name)) return node;
      stack.push(...node.children);
    }
    return null;
  }

  focus() {}

  // Every element sits in the same square: enough for the motion to run.
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 80 };
  }
}

const originalDocument = globalThis.document;
const originalHTMLCanvasElement = globalThis.HTMLCanvasElement;
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => Object.assign(new FakeElement('#text'), { textContent: text }),
  addEventListener() {},
  activeElement: null,
  styleSheets: [],
};
globalThis.HTMLCanvasElement = FakeElement;

test.after(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalHTMLCanvasElement === undefined) delete globalThis.HTMLCanvasElement;
  else globalThis.HTMLCanvasElement = originalHTMLCanvasElement;
});

const { createComparePanels, SELECTION_KEY } = await import('../src/ui/comparePanels.js');

const DIFFICULTIES = [
  { beatmapId: '1', mode: 1, version: 'Easy', stars: 2, convert: false },
  { beatmapId: '2', mode: 1, version: 'Normal', stars: 3, convert: false },
  { beatmapId: '3', mode: 1, version: 'Hard', stars: 4, convert: false },
  { beatmapId: '4', mode: 1, version: 'Oni', stars: 5, convert: false },
  { beatmapId: '5', mode: 1, version: 'Inner Oni', stars: 6, convert: false },
];

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const flush = async () => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
};

const makePanels = ({
  session = new Map(),
  fetchBeatmap,
  allowMotion = () => false,
  area = { width: 1200, height: 800 },
  renderPlayfields = () => {},
  onSoundSourceChange = () => {},
  onCanvasClick = () => {},
} = {}) => {
  const root = new FakeElement('html');
  const canvasWrap = new FakeElement();
  canvasWrap.clientWidth = area.width;
  canvasWrap.clientHeight = area.height;
  const panelsElement = new FakeElement();
  const leadPanel = new FakeElement();
  leadPanel.className = 'map-preview-panel is-lead';
  panelsElement.append(leadPanel);
  const leadLabel = new FakeElement('span');
  const leadSelect = new FakeElement('button');
  leadSelect.className = 'map-preview-panel-select';
  leadLabel.append(leadSelect);
  ['map-preview-panel-stars', 'map-preview-panel-name', 'map-preview-panel-keys'].forEach((name) => {
    const part = new FakeElement('span');
    part.className = name;
    leadSelect.append(part);
  });
  const control = new FakeElement();
  const button = new FakeElement('button');
  const listElement = new FakeElement();
  const statusElement = new FakeElement();
  control.append(button, listElement, statusElement);

  const renderers = [];
  const fetches = [];
  let changes = 0;
  const panels = createComparePanels({
    root,
    canvasWrap,
    panelsElement,
    leadLabel,
    control,
    button,
    listElement,
    statusElement,
    isDetached: true,
    allowMotion,
    renderPlayfields,
    onSoundSourceChange,
    bindPopover: ({ control: popoverControl, openClass }) => ({
      dismiss: () => {
        const wasOpen = popoverControl.classList.contains(openClass);
        popoverControl.classList.remove(openClass);
        return wasOpen;
      },
    }),
    fetchDifficulties: async () => DIFFICULTIES,
    fetchBeatmap: fetchBeatmap || (async (id) => {
      fetches.push(id);
      return `osu ${id}`;
    }),
    prepareMap: (osuText, mode) => ({
      metadata: { version: `v${osuText.split(' ')[1]}` },
      sourceMapData: {},
      mapData: { mode, objects: [{}], maxObjectTime: 1000 * Number(osuText.split(' ')[1]) },
    }),
    convertMap: (source, mode) => ({ mode, objects: [{}] }),
    createRenderer: () => {
      const renderer = {
        setBeatmap() {}, setTime(ms) { this.time = ms; }, renderPlayfield() { this.frames = (this.frames || 0) + 1; },
        setDuration() {}, setPreviewSettings() {}, replaceManiaObjects() {},
      };
      renderers.push(renderer);
      return renderer;
    },
    getDurationMs: () => 60000,
    readSession: async (key) => session.get(key) ?? null,
    writeSession: async (key, value) => { session.set(key, value); },
    onPanelsChanged: () => { changes += 1; },
    onCanvasClick,
  });

  const shownIds = () => panelsElement.children.filter((child) => child !== leadPanel).map((child) => child.dataset.beatmapId);
  const statuses = () => panelsElement.children
    .filter((child) => child !== leadPanel)
    .map((child) => {
      const status = child.querySelector('map-preview-panel-status');
      return status.hidden ? 'ready' : status.textContent;
    });
  return {
    panels, root, session, renderers, fetches, shownIds, statuses, control, listElement, panelsElement, canvasWrap,
    leadLabel, leadSelect, getChanges: () => changes,
  };
};

const LEAD = { setId: '9', beatmapId: '4', mode: 1, version: 'Oni' };

test('a remembered selection comes back beside the same lead', async () => {
  const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '1', '3'] }]]);
  const { panels, shownIds, statuses, root } = makePanels({ session });
  await panels.setLead(LEAD);
  await flush();
  assert.deepEqual(shownIds(), ['1', '3']);
  assert.deepEqual(statuses(), ['ready', 'ready']);
  assert.ok(root.classList.contains('is-comparing'));
  assert.equal(panels.getCount(), 3);
});

test('panels set up from the URL still finish loading once the lead is in', async () => {
  // The popup sets the lead up before its map has loaded, then again after.
  // A panel still loading across the second call used to drop its map.
  const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '2'] }]]);
  const pending = deferred();
  const { panels, shownIds, statuses } = makePanels({ session, fetchBeatmap: () => pending.promise });
  await panels.setLead({ setId: '9', beatmapId: '4', mode: 1 });
  assert.deepEqual(statuses(), ['Loading…']);
  await panels.setLead(LEAD);
  pending.resolve('osu 2');
  await flush();
  assert.deepEqual(shownIds(), ['2']);
  assert.deepEqual(statuses(), ['ready']);
});

test('moving to a shown difficulty swaps it with the lead, and it is remembered', async () => {
  const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '1'] }]]);
  const { panels, shownIds } = makePanels({ session });
  await panels.setLead(LEAD);
  await flush();
  await panels.setLead({ setId: '9', beatmapId: '1', mode: 1, version: 'Easy' });
  await flush();
  assert.deepEqual(shownIds(), ['4']);
  assert.deepEqual(session.get(SELECTION_KEY), { setId: '9', mode: 1, leadId: '1', ids: ['1', '4'], soundId: null });
});

test('another ruleset clears the panels, and the selection waits for that set again', async () => {
  const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '1'] }]]);
  const { panels, shownIds, root } = makePanels({ session });
  await panels.setLead(LEAD);
  await flush();
  await panels.setLead({ setId: '9', beatmapId: '4', mode: 3 });
  await flush();
  assert.deepEqual(shownIds(), []);
  assert.ok(!root.classList.contains('is-comparing'));
});

test('a failed lead takes the panels down but keeps what was chosen', async () => {
  const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '1'] }]]);
  const { panels, shownIds } = makePanels({ session });
  await panels.setLead(LEAD);
  await flush();
  panels.clear();
  assert.deepEqual(shownIds(), []);
  assert.deepEqual(session.get(SELECTION_KEY).ids, ['4', '1']);
});

test('the picker adds and removes difficulties, up to four in all', async () => {
  const { panels, shownIds, control, listElement, session } = makePanels();
  await panels.setLead(LEAD);
  control.classList.add('is-compare-open');
  control.children[0].click();
  await flush();
  const row = (id) => listElement.children.find((child) => child.dataset.beatmapId === id);
  assert.equal(listElement.children.length, 5);
  assert.equal(row('4').disabled, true, 'the lead cannot be added again');

  row('1').click();
  row('2').click();
  row('3').click();
  await flush();
  assert.deepEqual(shownIds(), ['1', '2', '3']);
  assert.equal(row('5').disabled, true, 'a fifth cannot be added');
  row('5').click();
  assert.deepEqual(shownIds(), ['1', '2', '3']);

  row('2').click();
  assert.deepEqual(shownIds(), ['1', '3']);
  assert.equal(row('5').disabled, false);
  assert.deepEqual(session.get(SELECTION_KEY).ids, ['4', '1', '3']);
});

test('un-ticking a difficulty lets its check leave before the tag changes', async (t) => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let panels = null;
  try {
    const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '1'] }]]);
    const built = makePanels({ session, allowMotion: () => true });
    panels = built.panels;
    const { control, listElement } = built;
    await panels.setLead(LEAD);
    await flush();
    control.classList.add('is-compare-open');
    control.children[0].click();
    await flush();

    const row = listElement.children.find((child) => child.dataset.beatmapId === '1');
    const tag = row.children[2];
    const check = tag.children[0];
    assert.ok(check.classList.contains('map-preview-compare-check'));

    row.click();
    assert.equal(tag.children[0], check, 'it is still there on the way out');
    assert.ok(check.classList.contains('is-leaving'));

    t.mock.timers.tick(200);
    assert.equal(tag.children.length, 0, 'and the tag is cleared once it has gone');
  } finally {
    panels?.dispose();
    if (originalRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRaf;
    if (originalCancelRaf === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelRaf;
  }
});

test('every panel draws at the lead\'s time', async () => {
  const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '1', '2'] }]]);
  const { panels, renderers } = makePanels({ session });
  await panels.setLead(LEAD);
  await flush();
  panels.render(12345);
  assert.equal(renderers.length, 2);
  assert.ok(renderers.every((renderer) => renderer.time === 12345 && renderer.frames === 1));
  // The longest of them, for a timeline that has to reach their ends.
  assert.equal(panels.getLongestMappedDurationMs(), 4000);
  panels.dispose();
});

test('a removed difficulty stays in the grid until it has slid back under the lead', async () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  let panels = null;
  try {
    const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '1', '2'] }]]);
    const built = makePanels({ session, allowMotion: () => true });
    panels = built.panels;
    const { shownIds, control, listElement } = built;
    await panels.setLead(LEAD);
    await flush();
    control.classList.add('is-compare-open');
    control.children[0].click();
    await flush();
    frames.length = 0;

    listElement.children.find((child) => child.dataset.beatmapId === '1').click();
    // Gone from what is shown, remembered and drawn at once...
    assert.equal(panels.getCount(), 2);
    assert.deepEqual(session.get(SELECTION_KEY).ids, ['4', '2']);
    // ...but its element waits for the exit to play out.
    assert.deepEqual(shownIds(), ['1', '2']);
    const realNow = performance.now;
    performance.now = () => realNow.call(performance) + 1000;
    try {
      while (frames.length) {
        frames.shift()();
      }
      await flush();
    } finally {
      performance.now = realNow;
    }
    assert.deepEqual(shownIds(), ['2']);
  } finally {
    panels?.dispose();
    if (originalRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRaf;
    if (originalCancelRaf === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelRaf;
  }
});

test('changing the panels again mid-exit finishes the exit at once', async () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  let panels = null;
  try {
    const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '1'] }]]);
    const built = makePanels({ session, allowMotion: () => true });
    panels = built.panels;
    const { shownIds, control, listElement } = built;
    await panels.setLead(LEAD);
    await flush();
    control.classList.add('is-compare-open');
    control.children[0].click();
    await flush();
    const row = (id) => listElement.children.find((child) => child.dataset.beatmapId === id);
    row('1').click();
    assert.deepEqual(shownIds(), ['1']);
    row('3').click();
    await flush();
    assert.deepEqual(shownIds(), ['3']);
  } finally {
    panels?.dispose();
    if (originalRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRaf;
    if (originalCancelRaf === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelRaf;
  }
});

test('the preview keeps its size: panels share the area, in a grid that suits its shape', async () => {
  const shapes = [
    { area: { width: 357, height: 267 }, grids: ['2x1', '2x2', '2x2'] },
    { area: { width: 380, height: 860 }, grids: ['1x2', '1x3', '1x4'] },
    { area: { width: 1400, height: 470 }, grids: ['2x1', '3x1', '4x1'] },
  ];
  for (const { area, grids } of shapes) {
    const { panels, control, listElement, panelsElement, canvasWrap, root } = makePanels({ area });
    await panels.setLead(LEAD);
    control.classList.add('is-compare-open');
    control.children[0].click();
    await flush();
    const row = (id) => listElement.children.find((child) => child.dataset.beatmapId === id);
    const seen = [];
    for (const id of ['1', '2', '3']) {
      row(id).click();
      seen.push(`${panelsElement.style.props.get('--panel-cols')}x${panelsElement.style.props.get('--panel-rows')}`);
    }
    assert.deepEqual(seen, grids, `${area.width}x${area.height}`);
    assert.equal(canvasWrap.style.props.size, 0, 'nothing set on the preview area itself');
    assert.ok(root.classList.contains('is-comparing'));
    assert.ok(!root.classList.contains('is-comparing-wide'), 'the popup does not widen');
  }
});

test('a move draws the playfields at every step, so none is left stretched by the browser', async () => {
  const frames = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  try {
    let drawn = 0;
    const { panels, control, listElement } = makePanels({
      allowMotion: () => true,
      renderPlayfields: () => { drawn += 1; },
    });
    await panels.setLead(LEAD);
    control.classList.add('is-compare-open');
    control.children[0].click();
    await flush();
    listElement.children.find((child) => child.dataset.beatmapId === '1').click();
    assert.equal(drawn, 1, 'the first step');
    frames.shift()();
    assert.equal(drawn, 2, 'and each one after');
  } finally {
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
  }
});

const pillOf = (panelsElement, id) => panelsElement.children
  .find((child) => child.dataset.beatmapId === id)
  .querySelector('map-preview-panel-select');
const labelOf = (panelsElement, id) => panelsElement.children
  .find((child) => child.dataset.beatmapId === id)
  .querySelector('map-preview-panel-label');

test('clicking a difficulty\'s pill plays its hitsounds, and the speaker moves to it', async () => {
  const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '1', '2'] }]]);
  const told = [];
  const { panels, panelsElement, leadLabel, leadSelect } = makePanels({
    session,
    onSoundSourceChange: (map) => told.push(map ? map.maxObjectTime : 'lead'),
  });
  await panels.setLead(LEAD);
  await flush();
  assert.ok(leadLabel.classList.contains('is-sound-source'), 'the lead sounds to begin with');
  assert.equal(told.at(-1), 'lead');

  pillOf(panelsElement, '2').click();
  assert.equal(told.at(-1), 2000, 'the second difficulty\'s map');
  assert.ok(labelOf(panelsElement, '2').classList.contains('is-sound-source'));
  assert.ok(!leadLabel.classList.contains('is-sound-source'));
  assert.equal(pillOf(panelsElement, '2').getAttribute('aria-pressed'), 'true');
  assert.equal(session.get(SELECTION_KEY).soundId, '2', 'remembered with the panels');

  leadSelect.click();
  assert.equal(told.at(-1), 'lead', 'the lead\'s pill takes it back');
  assert.ok(leadLabel.classList.contains('is-sound-source'));
  assert.equal(session.get(SELECTION_KEY).soundId, null);
});

test('removing the difficulty that is sounding hands the hitsounds back to the lead', async () => {
  const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '1'] }]]);
  const told = [];
  const { panels, panelsElement, leadLabel } = makePanels({
    session,
    onSoundSourceChange: (map) => told.push(map ? map.maxObjectTime : 'lead'),
  });
  await panels.setLead(LEAD);
  await flush();
  pillOf(panelsElement, '1').click();
  assert.equal(told.at(-1), 1000);
  panelsElement.children.find((child) => child.dataset.beatmapId === '1')
    .querySelector('map-preview-panel-remove').click();
  assert.equal(told.at(-1), 'lead');
  assert.ok(leadLabel.classList.contains('is-sound-source'));
});

test('a picked difficulty sounds again after reopening, once its map is in', async () => {
  const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '3'], soundId: '3' }]]);
  const pending = deferred();
  const told = [];
  const { panels, panelsElement } = makePanels({
    session,
    fetchBeatmap: () => pending.promise,
    onSoundSourceChange: (map) => told.push(map ? map.maxObjectTime : 'lead'),
  });
  await panels.setLead(LEAD);
  // The speaker is on it straight away; the lead's hitsounds play until its map arrives.
  assert.ok(labelOf(panelsElement, '3').classList.contains('is-sound-source'));
  assert.equal(told.at(-1), 'lead');
  pending.resolve('osu 3');
  await flush();
  assert.equal(told.at(-1), 3000);
});

test('following on to the difficulty that was sounding keeps its hitsounds, now as the lead\'s', async () => {
  const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '1'] }]]);
  const told = [];
  const { panels, panelsElement, leadLabel } = makePanels({
    session,
    onSoundSourceChange: (map) => told.push(map ? map.maxObjectTime : 'lead'),
  });
  await panels.setLead(LEAD);
  await flush();
  pillOf(panelsElement, '1').click();
  await panels.setLead({ setId: '9', beatmapId: '1', mode: 1, version: 'Easy' });
  await flush();
  assert.equal(told.at(-1), 'lead', 'it is the lead now, sounding as one');
  assert.ok(leadLabel.classList.contains('is-sound-source'));
});

test('a click on an added playfield goes to the popup with that panel\'s renderer', async () => {
  // The popup picks out a circle under it while the timeline shows that
  // difficulty, so it has to know which playfield was clicked.
  const session = new Map([[SELECTION_KEY, { setId: '9', mode: 1, leadId: '4', ids: ['4', '1', '3'] }]]);
  const clicks = [];
  const { panels, panelsElement, renderers } = makePanels({
    session,
    onCanvasClick: (event, renderer) => clicks.push({ event, renderer }),
  });
  await panels.setLead(LEAD);
  await flush();

  const canvasOf = (beatmapId) => panelsElement.children
    .find((child) => child.dataset.beatmapId === beatmapId)
    .children.find((child) => child.dataset.compare === 'true');
  const clickOn = (target) => {
    const event = { target };
    panelsElement.listeners.get('click').forEach((listener) => listener(event));
    return event;
  };

  const event = clickOn(canvasOf('3'));
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].event, event, 'with the event, for where it landed');
  assert.equal(clicks[0].renderer, renderers[1], 'and the renderer of the panel it landed on');

  clickOn(panelsElement);
  assert.equal(clicks.length, 1, 'the gap between panels is not a playfield');
});
