// The island: one small capsule in the top-right corner of the preview, there
// only while something is going on, that springs between whatever it has to
// show -- a ring while the full track downloads, a tick when it is in, a
// message -- and shrinks away to nothing when there is nothing left. Every
// message the popup has goes through it, so they all look and move alike.
//
// Each kind of thing has a colour of its own, so what it is about can be told
// before it is read: a download, the full track arriving, a copied timestamp,
// something else done, something to know, something that failed.
//
// Two halves. The model decides what is on show from what is going on (an
// activity, a message, or neither) and owns the timers; it has no DOM, so it
// can be tested. The renderer turns each of those into a layer, measures it,
// springs the capsule to its size and crossfades the old layer out.

// What a message can be about. Each is a colour (and a glyph) of its own.
//   info  - something to know, or to go and do      (blue)
//   done  - something asked for has been done       (teal)
//   copy  - a timestamp is on the clipboard         (violet)
//   error - something did not work                  (red)
const ISLAND_TONES = Object.freeze(['info', 'done', 'copy', 'error']);
// What an activity can be: the full track on its way (amber), or just in (green).
const ISLAND_ACTIVITIES = Object.freeze(['progress', 'ready']);
const ISLAND_COLOURS = Object.freeze([...ISLAND_TONES, ...ISLAND_ACTIVITIES]);
const DEFAULT_MESSAGE_MS = 3500;
// Instructions -- go and look somewhere else -- take longer to read than a
// confirmation, and the user has to act on them.
const INSTRUCTION_MESSAGE_MS = 6000;
// The capsule at its smallest: a circle in the corner.
const ISLAND_COMPACT_PX = 20;
// The widest a message gets, and how far it keeps from the far edge of what it
// sits in: it stays a badge in the corner, not a banner across the preview.
const ISLAND_MAX_MESSAGE_PX = 300;
const ISLAND_EDGE_PX = 12;
// The widest a download's figure gets, which its capsule is sized for throughout.
const WIDEST_FIGURE = '100%';
// How long a replaced layer takes to fade out before it is removed.
const LAYER_LEAVE_MS = 150;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * What the island shows. A message wins over an activity for as long as it is
 * up; with neither, the island is gone.
 *
 * @param activity null, or { kind: 'progress' | 'ready', progress?, text?, title? }
 * @param message null, or { text, tone }
 */
const resolveIslandView = ({ activity = null, message = null } = {}) => {
  if (message) {
    return { mode: 'message', tone: message.tone, text: message.text };
  }
  if (activity) {
    return { mode: 'compact', ...activity };
  }
  return { mode: 'hidden' };
};

// The island's colour for what it is showing.
const islandColour = (view) => {
  if (view.mode === 'message') {
    return view.tone;
  }
  return view.kind === 'ready' ? 'ready' : 'progress';
};

const createIslandModel = ({
  render,
  state,
  registry,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
}) => {
  let activity = null;
  let message = null;
  const update = () => render(resolveIslandView({ activity, message }));

  const setActivity = (next) => {
    activity = next || null;
    update();
  };

  /** @returns true when there was a message to put away. */
  const dismissMessage = () => {
    state.toastHideTimer = registry.clearTimeout(state.toastHideTimer);
    if (!message) {
      return false;
    }
    message = null;
    update();
    return true;
  };

  const showMessage = (text, { tone = 'info', durationMs = DEFAULT_MESSAGE_MS } = {}) => {
    state.toastHideTimer = registry.clearTimeout(state.toastHideTimer);
    message = {
      text: String(text ?? ''),
      tone: ISLAND_TONES.includes(tone) ? tone : 'info',
    };
    update();
    const delayMs = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : DEFAULT_MESSAGE_MS;
    state.toastHideTimer = registry.addTimeout(schedule(() => {
      state.toastHideTimer = registry.clearTimeout(state.toastHideTimer);
      message = null;
      update();
    }, delayMs));
  };

  return {
    setActivity,
    showMessage,
    dismissMessage,
    hasMessage: () => Boolean(message),
    getView: () => resolveIslandView({ activity, message }),
  };
};

// --- the renderer ------------------------------------------------------------

const svgElement = (tag, attributes = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
};

// Each drawn around the middle of a 16-unit box (8, 8), so it sits centred in
// the circle.
const TICK = 'M3.6 8.3l2.9 2.9 5.9-6.3';
const GLYPHS = Object.freeze({
  info: [['circle', { cx: 8, cy: 8, r: 6.2 }], ['path', { d: 'M8 7.3v3.6' }], ['path', { d: 'M8 4.9v.01' }]],
  done: [['path', { d: TICK }]],
  ready: [['path', { d: TICK }]],
  // Two sheets, one over the other.
  copy: [['rect', { x: 5.6, y: 5.6, width: 7.2, height: 7.2, rx: 1.6 }], ['path', { d: 'M3.2 10.2V4.6c0-.8.6-1.4 1.4-1.4h5.6' }]],
  error: [['circle', { cx: 8, cy: 8, r: 6.2 }], ['path', { d: 'M8 4.7v3.8' }], ['path', { d: 'M8 11.1v.01' }]],
});

const buildGlyph = (name) => {
  const glyph = svgElement('svg', { viewBox: '0 0 16 16', class: `map-preview-island-glyph is-${name}`, 'aria-hidden': 'true' });
  GLYPHS[name].forEach(([tag, attributes]) => glyph.append(svgElement(tag, attributes)));
  return glyph;
};

const buildRing = () => {
  const ring = svgElement('svg', { viewBox: '0 0 16 16', class: 'map-preview-island-ring', 'aria-hidden': 'true' });
  ring.append(
    svgElement('circle', { class: 'map-preview-island-ring-track', cx: 8, cy: 8, r: 6.25, pathLength: 100 }),
    svgElement('circle', { class: 'map-preview-island-ring-fill', cx: 8, cy: 8, r: 6.25, pathLength: 100 }),
  );
  return ring;
};

const textSpan = (text, className) => {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
};

const fillProgress = (layer, view) => {
  const known = Number.isFinite(view.progress);
  layer.classList.toggle('has-progress', known);
  const fill = layer.querySelector('.map-preview-island-ring-fill');
  if (fill) {
    fill.style.strokeDasharray = known
      ? `${Math.max(2, Math.round(Math.min(1, Math.max(0, view.progress)) * 100))} 100`
      : '';
  }
  const text = layer.querySelector('.map-preview-island-figure');
  if (text) {
    text.textContent = view.text || '';
    text.hidden = !view.text;
  }
};

const buildLayer = (view) => {
  const layer = document.createElement('div');
  layer.className = `map-preview-island-layer is-${view.mode}`;
  if (view.mode === 'message') {
    layer.append(buildGlyph(view.tone), textSpan(view.text, 'map-preview-island-text'));
    return layer;
  }
  layer.setAttribute('aria-hidden', 'true');
  if (view.kind === 'ready') {
    layer.append(buildGlyph('ready'));
    return layer;
  }
  layer.append(buildRing(), textSpan('', 'map-preview-island-figure'));
  fillProgress(layer, view);
  return layer;
};

const sameShape = (a, b) => (
  a && b && a.mode === b.mode && (
    (a.mode === 'compact' && a.kind === b.kind)
    || (a.mode === 'message' && a.text === b.text && a.tone === b.tone)
  )
);

/**
 * @param element the capsule. Whatever it sits in -- the preview, or the
 *   "unsupported webpage" card with no map -- is what a message is measured
 *   against.
 * @param allowMotion false where the popup has no transitions (reduced motion,
 *   Firefox's toolbar popup); the island then changes at once.
 */
const createIslandRenderer = ({
  element,
  allowMotion = () => true,
  registry = null,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
}) => {
  let current = null;
  const retireTimers = new Set();

  const setSize = (width, height) => {
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
  };

  const maxMessageWidth = () => {
    const room = (element.parentElement?.offsetWidth || 0) - ISLAND_EDGE_PX;
    return Math.max(ISLAND_COMPACT_PX * 4, Math.min(ISLAND_MAX_MESSAGE_PX, room));
  };

  // A download's capsule is as wide as it will be at 100% from its first
  // percentage to its last, rather than growing a digit at a time: the room
  // for the widest figure is kept, and the width read once, with it showing.
  const lockedWidths = new WeakMap();
  const lockProgressWidth = (layer) => {
    if (lockedWidths.has(layer)) {
      return lockedWidths.get(layer);
    }
    const figure = layer.querySelector('.map-preview-island-figure');
    const shown = figure.textContent;
    figure.textContent = WIDEST_FIGURE;
    figure.hidden = false;
    figure.style.minWidth = `${Math.ceil(figure.offsetWidth)}px`;
    const width = Math.max(ISLAND_COMPACT_PX, Math.ceil(layer.offsetWidth));
    figure.textContent = shown;
    lockedWidths.set(layer, width);
    return width;
  };

  const measure = (layer, view) => {
    if (view.mode === 'message') {
      layer.style.maxWidth = `${maxMessageWidth()}px`;
    }
    if (view.mode === 'compact' && view.kind === 'progress' && view.text) {
      return {
        width: lockProgressWidth(layer),
        height: Math.max(ISLAND_COMPACT_PX, Math.ceil(layer.offsetHeight)),
      };
    }
    return {
      width: Math.max(ISLAND_COMPACT_PX, Math.ceil(layer.offsetWidth)),
      height: Math.max(ISLAND_COMPACT_PX, Math.ceil(layer.offsetHeight)),
    };
  };

  const retire = (layer) => {
    if (!layer) {
      return;
    }
    layer.classList.add('is-leaving');
    layer.setAttribute('aria-hidden', 'true');
    if (allowMotion()) {
      const timerId = schedule(() => {
        retireTimers.delete(timerId);
        registry?.clearTimeout?.(timerId);
        layer.remove();
      }, LAYER_LEAVE_MS);
      retireTimers.add(timerId);
      registry?.addTimeout?.(timerId);
    } else {
      layer.remove();
    }
  };

  const settle = (view) => {
    element.classList.toggle('is-message', view.mode === 'message');
    const colour = islandColour(view);
    ISLAND_COLOURS.forEach((name) => element.classList.toggle(`is-${name}`, name === colour));
    element.title = view.mode === 'compact' ? (view.title || '') : '';
  };

  const render = (view) => {
    if (view.mode === 'hidden') {
      retire(current?.layer);
      current = null;
      // Its colour is kept, so it fades out as what it was rather than grey.
      element.classList.add('is-hidden');
      element.title = '';
      // Back to a dot in the corner, so it shrinks into nothing and the next
      // thing grows out of the same place.
      setSize(ISLAND_COMPACT_PX, ISLAND_COMPACT_PX);
      return;
    }

    // The same thing again, updated where it stands: a download moving on.
    // Nothing is crossfaded.
    if (sameShape(current?.view, view)) {
      if (view.mode === 'compact') {
        fillProgress(current.layer, view);
        const size = measure(current.layer, view);
        setSize(size.width, size.height);
      }
      settle(view);
      current.view = view;
      return;
    }

    const motion = allowMotion();
    const layer = buildLayer(view);
    if (motion) {
      layer.classList.add('is-entering');
    }
    element.append(layer);
    // Reading its size lays the new layer out in its entering state, which is
    // what lets the class coming off below run as a transition.
    const size = measure(layer, view);
    retire(current?.layer);
    current = { view, layer };

    element.classList.remove('is-hidden');
    setSize(size.width, size.height);
    settle(view);
    layer.classList.remove('is-entering');
  };

  return { render };
};

/**
 * The island as the popup uses it: the model wired to the renderer, and a
 * click on a message putting it away (and nothing else -- a click on the
 * compact island is the audio status's, for the debug panel).
 */
const createIsland = ({
  element,
  state,
  registry,
  allowMotion,
}) => {
  const renderer = element
    ? createIslandRenderer({ element, allowMotion, registry })
    : { render: () => {} };
  const model = createIslandModel({ render: renderer.render, state, registry });
  element?.addEventListener('click', (event) => {
    if (model.dismissMessage()) {
      event.stopImmediatePropagation();
    }
  });
  return model;
};

export {
  DEFAULT_MESSAGE_MS,
  INSTRUCTION_MESSAGE_MS,
  ISLAND_COLOURS,
  ISLAND_COMPACT_PX,
  ISLAND_MAX_MESSAGE_PX,
  ISLAND_TONES,
  createIsland,
  createIslandModel,
  createIslandRenderer,
  islandColour,
  resolveIslandView,
};
