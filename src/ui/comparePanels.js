// Several difficulties of one mapset, previewed side by side on one clock.
//
// The map you opened stays the lead: its renderer owns the timeline, and its
// hitsounds are the ones that play. Each added difficulty gets a panel of its
// own with a playfield-only renderer, drawn at the lead's time every frame.
// They are offered in the lead's ruleset, as the site's ruleset tabs list them:
// that ruleset's own difficulties and, outside osu!standard, the converts.
//
// What is shown is remembered per set for the session, so reopening the popup,
// detaching it, or following on to another difficulty of the same set keeps the
// same panels. Moving to one of the shown difficulties swaps it into the lead.

import { listDifficultiesForRuleset, formatStars, getStarRatingColour, getStarRatingTextColour } from '../core/beatmapsetPage.js';
import { MAX_PREVIEW_PANELS, choosePanelGrid } from '../core/panelLayout.js';
import { PANEL_TUCK_EASING, createPanelMotion, scaleRect } from './panelMotion.js';

const SELECTION_KEY = 'mosuCompareSelectionV1';
const LIST_CACHE_KEY = 'mosuSetDifficultiesV1';
// A set's difficulty list barely changes; this only bounds a stale one.
const LIST_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// The hairline between panels.
const PANEL_GAP_PX = 2;
// A difficulty coming in starts this size, under the lead, and grows to its
// own cell; one going out shrinks back under it.
const PANEL_TUCKED_SCALE = 0.86;
const PANEL_LEAVE_MS = 260;

const MODE_NAMES = Object.freeze(['osu!', 'osu!taiko', 'osu!catch', 'osu!mania']);

const sameIds = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Works out which difficulties sit beside a new lead. `live` is what is on
 * screen now (lead first), `stored` the remembered selection; either may be
 * null. A lead that was already shown swaps places with the old lead; any
 * other lead takes the old lead's place.
 */
const resolveCompareIds = ({ lead, live = null, stored = null, maxPanels = MAX_PREVIEW_PANELS }) => {
  const matches = (selection) => Boolean(
    selection
    && selection.setId === lead.setId
    && selection.mode === lead.mode
    && Array.isArray(selection.ids),
  );
  const source = matches(live) ? live : (matches(stored) ? stored : null);
  if (!source) {
    return [];
  }
  const ids = source.ids.map(String);
  const kept = ids.includes(lead.beatmapId)
    ? ids.filter((id) => id !== lead.beatmapId)
    : ids.filter((id) => id !== String(source.leadId));
  return [...new Set(kept)].slice(0, Math.max(0, maxPanels - 1));
};

const createElement = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

// A small stroked icon on a 10x10 grid, or null where SVG cannot be made.
// Drawn rather than typed: Torus's × and ✓ sit off the centre of their boxes.
const createIcon = (pathData, size = 8) => {
  const icon = document.createElementNS?.(SVG_NS, 'svg');
  if (!icon) {
    return null;
  }
  icon.setAttribute('viewBox', '0 0 10 10');
  icon.setAttribute('width', String(size));
  icon.setAttribute('height', String(size));
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathData);
  icon.append(path);
  return icon;
};

const CROSS_PATH = 'M2 2l6 6M8 2l-6 6';

// The volume button's speaker, smaller: shown on the difficulty whose
// hitsounds are playing.
const createSpeakerIcon = () => {
  const icon = document.createElementNS?.(SVG_NS, 'svg');
  if (!icon) {
    return null;
  }
  icon.setAttribute('viewBox', '0 0 20 16');
  icon.setAttribute('width', '11');
  icon.setAttribute('height', '9');
  icon.setAttribute('aria-hidden', 'true');
  [
    ['map-preview-panel-sound-body', 'M1.5 5.5h3L8.5 2v12l-4-3.5h-3z'],
    ['map-preview-panel-sound-wave', 'M11.3 5.7a3.2 3.2 0 0 1 0 4.6'],
    ['map-preview-panel-sound-wave', 'M13.9 3.2a6.6 6.6 0 0 1 0 9.6'],
  ].forEach(([className, d]) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', className);
    path.setAttribute('d', d);
    icon.append(path);
  });
  return icon;
};

const createSoundMark = () => {
  const mark = document.createElement('span');
  mark.className = 'map-preview-panel-sound';
  mark.setAttribute('aria-hidden', 'true');
  const icon = createSpeakerIcon();
  if (icon) {
    mark.append(icon);
  } else {
    mark.textContent = '♪';
  }
  return mark;
};
// Centred on the grid: its box runs 2.5-7.6 across and 3.2-7.0 down.
const CHECK_PATH = 'M2.5 5.2l1.8 1.8 3.3-3.8';

const fillStarPill = (pill, stars) => {
  if (!pill) {
    return;
  }
  if (!Number.isFinite(stars)) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  pill.textContent = `★ ${formatStars(stars)}`;
  pill.style.setProperty('--star-bg', getStarRatingColour(stars));
  pill.style.setProperty('--star-fg', getStarRatingTextColour(stars));
};

const createComparePanels = ({
  root,
  canvasWrap,
  panelsElement,
  leadLabel,
  control,
  button,
  listElement,
  statusElement,
  // Whether panels move when one is added or removed: off for reduced motion,
  // and in Firefox's toolbar popup, which has no transitions.
  allowMotion = () => !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
  bindPopover,
  fetchDifficulties,
  fetchBeatmap,
  prepareMap,
  convertMap,
  createRenderer,
  // Told the map whose hitsounds should play when that changes: an added
  // difficulty's, or null for the lead's.
  onSoundSourceChange = () => {},
  // Draws every playfield at the current time, for a move that resizes them.
  renderPlayfields = () => {},
  getDurationMs,
  readSession,
  writeSession,
  onPanelsChanged = () => {},
  onCanvasClick = () => {},
  addDebugLog = () => {},
}) => {
  let lead = null;
  let leadGeneration = 0;
  /** @type {Array<object>} */
  let panels = [];
  // setId -> { difficulties } | { pending: Promise } | { error }
  const lists = new Map();
  // beatmapId -> the picker's row for it, for the set it was made for.
  const pickerRows = new Map();
  let pickerRowsSetId = null;

  const leadParts = {
    select: leadLabel?.querySelector('.map-preview-panel-select') ?? null,
    stars: leadLabel?.querySelector('.map-preview-panel-stars') ?? null,
    name: leadLabel?.querySelector('.map-preview-panel-name') ?? null,
    keys: leadLabel?.querySelector('.map-preview-panel-keys') ?? null,
  };

  // Whose hitsounds play: a difficulty picked by its pill, or null to follow
  // the lead, as they do until one is picked. Only one plays at a time.
  let soundId = null;
  // The map the popup was last told to sound, to tell it only of changes.
  let toldSoundMap;

  const getSoundPanel = () => (
    soundId && lead && soundId !== lead.beatmapId
      ? panels.find((panel) => panel.beatmapId === soundId) || null
      : null
  );

  // An added difficulty's map once it is in; until then, and for the lead, null.
  const getSoundMap = () => {
    const panel = getSoundPanel();
    return panel?.status === 'ready' ? panel.mapData : null;
  };

  const notifySound = ({ force = false } = {}) => {
    const map = getSoundMap();
    if (!force && map === toldSoundMap) {
      return;
    }
    toldSoundMap = map;
    onSoundSourceChange(map);
  };

  const picker = bindPopover({
    control,
    button,
    openClass: 'is-compare-open',
    canOpen: () => Boolean(lead?.setId),
  });
  const isPickerOpen = () => Boolean(control?.classList.contains('is-compare-open'));

  const getDifficulties = () => {
    const entry = lead?.setId ? lists.get(lead.setId) : null;
    return entry?.difficulties ? listDifficultiesForRuleset(entry.difficulties, lead.mode) : null;
  };

  const findDifficulty = (beatmapId) => getDifficulties()?.find((entry) => entry.beatmapId === beatmapId) ?? null;

  // --- labels ---------------------------------------------------------------

  const fillLabel = (parts, { version, stars, keys }) => {
    if (parts.name) {
      parts.name.textContent = version || '';
      parts.name.title = version || '';
    }
    fillStarPill(parts.stars, stars);
    if (parts.keys) {
      parts.keys.hidden = !Number.isFinite(keys);
      parts.keys.textContent = Number.isFinite(keys) ? `${keys}K` : '';
    }
  };

  const getManiaKeys = (mapData) => (
    mapData?.mode === 3 && Number.isFinite(mapData?.mania?.totalColumns) ? mapData.mania.totalColumns : null
  );

  const markSoundSource = () => {
    const soundPanel = getSoundPanel();
    const describe = (select, version, isSource) => {
      if (!select) {
        return;
      }
      select.setAttribute('aria-pressed', isSource ? 'true' : 'false');
      select.title = isSource
        ? `Hitsounds from ${version || 'this difficulty'}`
        : `Play ${version || 'this difficulty'}'s hitsounds`;
    };
    leadLabel?.classList.toggle('is-sound-source', !soundPanel);
    describe(leadParts.select, lead?.version || leadParts.name?.textContent, !soundPanel);
    panels.forEach((panel) => {
      const isSource = panel === soundPanel;
      panel.label.classList.toggle('is-sound-source', isSource);
      describe(panel.labelParts.select, panel.version || panel.labelParts.name.textContent, isSource);
    });
  };

  const refreshLabels = () => {
    if (lead) {
      // Until the lead's own file is in, the set's list names it.
      const listed = findDifficulty(lead.beatmapId);
      fillLabel(leadParts, {
        version: lead.version || listed?.version || '',
        stars: listed?.stars ?? null,
        keys: lead.keys,
      });
    }
    panels.forEach((panel) => {
      const listed = findDifficulty(panel.beatmapId);
      fillLabel(panel.labelParts, {
        version: panel.version || listed?.version || `#${panel.beatmapId}`,
        stars: listed?.stars ?? null,
        keys: getManiaKeys(panel.mapData),
      });
      panel.removeButton.setAttribute('aria-label', `Stop showing ${panel.version || listed?.version || 'this difficulty'}`);
    });
    markSoundSource();
  };

  // --- layout ---------------------------------------------------------------

  // The preview keeps the size it has -- in the toolbar popup, a detached
  // window or on a phone -- and the panels share it, in the grid that gives
  // each playfield the most room for that shape. The window never resizes for
  // them, and the timeline and controls stay where they are.
  const layout = () => {
    // Counted from the page, so a panel still on its way out keeps its cell.
    const count = Math.max(1, panelsElement.children.length);
    const comparing = count > 1;
    root?.classList.toggle('is-comparing', comparing);

    const cells = [...panelsElement.children];
    cells.forEach((cell) => cell.style.removeProperty('grid-column'));

    if (!comparing) {
      panelsElement.style.removeProperty('--panel-cols');
      panelsElement.style.removeProperty('--panel-rows');
      return;
    }

    const grid = choosePanelGrid(count, canvasWrap?.clientWidth || 0, canvasWrap?.clientHeight || 0, {
      gap: PANEL_GAP_PX,
    });
    panelsElement.style.setProperty('--panel-cols', String(grid.cols));
    panelsElement.style.setProperty('--panel-rows', String(grid.rows));
    // A short last row is stretched rather than left with a hole in it.
    const empty = (grid.cols * grid.rows) - count;
    if (empty > 0 && cells.length > 0) {
      cells[cells.length - 1].style.setProperty('grid-column', `span ${empty + 1}`);
    }
  };

  // A window resized, a phone turned: the grid is chosen again for the new
  // shape, and every playfield drawn again at its new size. Paused, nothing
  // else would draw it, and the browser stretched the old picture to fit.
  if (typeof ResizeObserver === 'function' && canvasWrap) {
    new ResizeObserver(() => {
      if (panelsElement.children.length > 1) {
        layout();
      }
      try {
        renderPlayfields();
      } catch {
        // The next frame draws.
      }
    }).observe(canvasWrap);
  }

  // --- panels ---------------------------------------------------------------

  const setPanelStatus = (panel, text) => {
    panel.statusElement.textContent = text || '';
    panel.statusElement.hidden = !text;
    panel.element.classList.toggle('is-loading', panel.status === 'loading');
  };

  // A panel outlives a new lead of the same set and ruleset (the lead is set up
  // from the URL before its map loads, and again once it has), so only a panel
  // that has left the screen drops its result. A new set or ruleset removes
  // every panel.
  const loadPanel = async (panel) => {
    const mode = lead.mode;
    panel.status = 'loading';
    setPanelStatus(panel, 'Loading…');
    try {
      const osuText = await fetchBeatmap(panel.beatmapId);
      if (!panels.includes(panel)) {
        return;
      }
      const prepared = prepareMap(osuText, mode);
      if (prepared.mapData.mode !== mode) {
        throw new Error(`this difficulty cannot be shown in ${MODE_NAMES[mode] || 'this ruleset'}`);
      }
      if (!Array.isArray(prepared.mapData.objects) || prepared.mapData.objects.length === 0) {
        throw new Error('the difficulty has no readable hit objects');
      }
      panel.sourceMapData = prepared.sourceMapData;
      panel.mapData = prepared.mapData;
      panel.version = prepared.metadata?.version || '';
      panel.renderer = createRenderer(panel.canvas);
      panel.renderer.setBeatmap(panel.mapData, getDurationMs());
      panel.status = 'ready';
      setPanelStatus(panel, '');
      // The map fades up over the empty playfield rather than cutting in.
      if (allowMotion()) {
        panel.canvas.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      }
      addDebugLog(`compare: showing ${panel.version || panel.beatmapId} (${panel.mapData.objects.length} objects)`);
      // Picked to sound before its map was in: it takes over now.
      notifySound();
    } catch (error) {
      if (!panels.includes(panel)) {
        return;
      }
      panel.status = 'error';
      setPanelStatus(panel, "Couldn't load this difficulty");
      addDebugLog(`compare: ${panel.beatmapId} failed -> ${error?.message || 'unknown error'}`);
    }
    refreshLabels();
    onPanelsChanged();
  };

  const createPanel = (beatmapId) => {
    const element = createElement('div', 'map-preview-panel');
    element.dataset.beatmapId = beatmapId;
    const canvas = createElement('canvas', 'map-preview-canvas');
    canvas.dataset.compare = 'true';
    const label = createElement('span', 'map-preview-panel-label');
    const labelParts = {
      select: createElement('button', 'map-preview-panel-select'),
      stars: createElement('span', 'map-preview-panel-stars'),
      name: createElement('span', 'map-preview-panel-name'),
      keys: createElement('span', 'map-preview-panel-keys'),
    };
    labelParts.select.type = 'button';
    labelParts.stars.hidden = true;
    labelParts.keys.hidden = true;
    const removeButton = createElement('button', 'map-preview-panel-remove');
    removeButton.type = 'button';
    const cross = createIcon(CROSS_PATH);
    if (cross) {
      removeButton.append(cross);
    } else {
      removeButton.textContent = '×';
    }
    labelParts.select.append(createSoundMark(), labelParts.stars, labelParts.name, labelParts.keys);
    label.append(labelParts.select, removeButton);
    const statusElement = createElement('span', 'map-preview-panel-status');
    statusElement.hidden = true;
    element.append(canvas, label, statusElement);

    const panel = {
      beatmapId,
      element,
      canvas,
      label,
      labelParts,
      removeButton,
      statusElement,
      renderer: null,
      mapData: null,
      sourceMapData: null,
      version: '',
      status: 'idle',
    };
    labelParts.select.addEventListener('click', (event) => {
      event.stopPropagation();
      selectSound(beatmapId);
    });
    removeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleDifficulty(beatmapId);
    });
    return panel;
  };

  const persist = () => {
    if (!lead?.setId) {
      return;
    }
    void writeSession(SELECTION_KEY, {
      setId: lead.setId,
      mode: lead.mode,
      leadId: lead.beatmapId,
      ids: [lead.beatmapId, ...panels.map((panel) => panel.beatmapId)],
      soundId,
    }).catch(() => {});
  };

  // A pill clicked: that difficulty's hitsounds play from here on. The lead's
  // pill goes back to following the lead.
  function selectSound(beatmapId) {
    if (!lead) {
      return;
    }
    soundId = beatmapId === lead.beatmapId ? null : beatmapId;
    markSoundSource();
    persist();
    notifySound();
  }

  leadParts.select?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (lead) {
      selectSound(lead.beatmapId);
    }
  });

  // --- moving between layouts -----------------------------------------------

  const motion = createPanelMotion();
  // Panels on their way out, still in the grid until they have gone.
  let leavingPanels = [];

  const getLeadElement = () => panelsElement.children[0] || null;
  const measure = (elements) => motion.capture(panelsElement, elements);
  // Each step of a move resizes the panels, so their maps are drawn again at
  // the new size there and then, playing or not: a canvas left for the browser
  // to stretch is what looked squashed.
  const playMotion = (items, options = {}) => motion.play(items, {
    ...options,
    onFrame: () => {
      try {
        renderPlayfields();
      } catch {
        // A frame missed; the next one draws.
      }
    },
  });

  // An exit still playing ends at once when the panels change again.
  const finishLeaving = () => {
    if (leavingPanels.length === 0) {
      return;
    }
    motion.cancel();
    leavingPanels.forEach((panel) => panel.element.remove());
    leavingPanels = [];
  };

  // Lays the panels out in `next`'s order and moves them there from where they
  // were, the new ones out from under the lead.
  const settleInto = (next, entering, { animate }) => {
    const leadElement = getLeadElement();
    const staying = [leadElement, ...next.filter((panel) => !entering.includes(panel)).map((panel) => panel.element)]
      .filter(Boolean);
    const first = animate ? measure(staying) : null;
    motion.cancel();

    next.forEach((panel) => panelsElement.append(panel.element));
    refreshLabels();
    layout();
    if (!animate || !leadElement) {
      return;
    }

    const last = measure([...staying, ...entering.map((panel) => panel.element)]);
    const leadFrom = first.get(leadElement);
    const items = staying.map((element) => ({
      element,
      from: first.get(element),
      to: last.get(element),
      // The lead on top, so what comes out from under it does.
      zIndex: element === leadElement ? 3 : 2,
    }));
    entering.forEach((panel) => {
      items.push({
        element: panel.element,
        from: scaleRect(leadFrom, PANEL_TUCKED_SCALE),
        to: last.get(panel.element),
        opacity: [0.35, 1],
        zIndex: 1,
      });
    });
    void playMotion(items);
  };

  // Makes the panels match `ids`, in that order, keeping the ones already up.
  // `animate` is for the user's own adds and removes; a new lead or ruleset
  // just puts the panels where they belong.
  const reconcile = (ids, { animate = false } = {}) => {
    finishLeaving();
    const current = new Map(panels.map((panel) => [panel.beatmapId, panel]));
    const next = ids.map((id) => current.get(id) || createPanel(id));
    const removed = panels.filter((panel) => !ids.includes(panel.beatmapId));
    const entering = next.filter((panel) => !current.has(panel.beatmapId));
    const moving = animate && allowMotion() && Boolean(getLeadElement());
    panels = next;
    // The difficulty whose hitsounds were playing has gone: the lead's take over.
    if (soundId && soundId !== lead?.beatmapId && !ids.includes(soundId)) {
      soundId = null;
    }
    notifySound();
    next.filter((panel) => panel.status === 'idle').forEach((panel) => void loadPanel(panel));

    if (!moving || removed.length === 0) {
      removed.forEach((panel) => panel.element.remove());
      settleInto(next, entering, { animate: moving });
      return;
    }

    // Out first, back under the lead, and only then do the others close up:
    // the grid keeps its shape until the panel has gone.
    const leadElement = getLeadElement();
    const others = [leadElement, ...next.map((panel) => panel.element)];
    const leaving = removed.map((panel) => panel.element);
    const first = measure([...others, ...leaving]);
    motion.cancel();
    const laidOut = measure([...others, ...leaving]);
    const leadRect = laidOut.get(leadElement);
    leavingPanels = removed;
    const items = [
      ...others.map((element) => ({
        element,
        from: first.get(element),
        to: laidOut.get(element),
        zIndex: element === leadElement ? 3 : 2,
      })),
      ...leaving.map((element) => ({
        element,
        from: first.get(element),
        to: scaleRect(leadRect, PANEL_TUCKED_SCALE),
        opacity: [1, 0],
        fade: 'full',
        zIndex: 1,
      })),
    ];
    refreshLabels();
    void playMotion(items, { duration: PANEL_LEAVE_MS, easing: PANEL_TUCK_EASING }).then((finished) => {
      if (!finished) {
        return;
      }
      removed.forEach((panel) => panel.element.remove());
      leavingPanels = [];
      settleInto(panels, entering.filter((panel) => panels.includes(panel)), { animate: true });
    });
  };

  // --- the difficulty list --------------------------------------------------

  const readCachedList = async (setId) => {
    try {
      const cached = await readSession(LIST_CACHE_KEY);
      if (
        cached?.setId === setId
        && Array.isArray(cached.difficulties)
        && Number.isFinite(cached.savedAt)
        && (Date.now() - cached.savedAt) <= LIST_CACHE_MAX_AGE_MS
      ) {
        return cached.difficulties;
      }
    } catch {
      // Fall through to the network.
    }
    return null;
  };

  // The compare button is there only when something can be put beside the
  // lead: hidden for a set with no other difficulty in this ruleset, and until
  // its list says otherwise (it loads as the map does, and is kept for the
  // session). Shown if the list could not be had, so the picker can say so.
  function syncCompareButton() {
    const entry = lead?.setId ? lists.get(lead.setId) : null;
    let available = false;
    if (panels.length > 0 || entry?.error) {
      available = true;
    } else if (entry?.difficulties) {
      available = (getDifficulties() || []).some((difficulty) => difficulty.beatmapId !== lead.beatmapId);
    }
    if (control) {
      control.hidden = !available;
    }
    if (button) {
      button.disabled = !available;
    }
    if (!available) {
      picker.dismiss();
    }
  }

  const afterListChange = () => { refreshLabels(); renderPicker(); syncCompareButton(); };

  const ensureList = (setId, { retry = false } = {}) => {
    const existing = lists.get(setId);
    if (existing && (existing.difficulties || existing.pending) && !retry) {
      return existing.pending || Promise.resolve(existing.difficulties);
    }
    if (existing?.error && !retry) {
      return Promise.resolve(null);
    }
    const pending = (async () => {
      const cached = await readCachedList(setId);
      if (cached) {
        return cached;
      }
      const difficulties = await fetchDifficulties(setId);
      void writeSession(LIST_CACHE_KEY, { setId, savedAt: Date.now(), difficulties }).catch(() => {});
      return difficulties;
    })().then((difficulties) => {
      lists.set(setId, { difficulties });
      afterListChange();
      return difficulties;
    }, (error) => {
      lists.set(setId, { error: error?.message || 'unknown error' });
      addDebugLog(`compare: difficulty list for set ${setId} failed -> ${error?.message || 'unknown error'}`);
      afterListChange();
      return null;
    });
    lists.set(setId, { pending });
    return pending;
  };

  // --- the picker -----------------------------------------------------------

  const setStatus = (text, { retry = false } = {}) => {
    if (!statusElement) {
      return;
    }
    statusElement.replaceChildren();
    statusElement.hidden = !text;
    if (!text) {
      return;
    }
    statusElement.append(document.createTextNode(text));
    if (retry) {
      const retryButton = createElement('button', 'map-preview-compare-retry', 'Retry');
      retryButton.type = 'button';
      retryButton.addEventListener('click', () => {
        if (lead?.setId) {
          void ensureList(lead.setId, { retry: true });
          renderPicker();
        }
      });
      statusElement.append(retryButton);
    }
  };

  function renderPicker() {
    if (!listElement || !isPickerOpen() || !lead?.setId) {
      return;
    }
    const entry = lists.get(lead.setId);
    if (!entry || entry.pending) {
      listElement.replaceChildren();
      setStatus('Loading difficulties…');
      return;
    }
    if (entry.error) {
      listElement.replaceChildren();
      setStatus("Couldn't load this set's difficulties.", { retry: true });
      return;
    }

    if (pickerRowsSetId !== lead.setId) {
      pickerRows.clear();
      pickerRowsSetId = lead.setId;
    }
    const difficulties = getDifficulties() || [];
    const shown = new Set(panels.map((panel) => panel.beatmapId));
    const isFull = 1 + panels.length >= MAX_PREVIEW_PANELS;
    const others = difficulties.filter((difficulty) => difficulty.beatmapId !== lead.beatmapId);
    if (others.length === 0) {
      setStatus(`No other ${MODE_NAMES[lead.mode] || ''} difficulties in this set.`.replace('  ', ' '));
    } else {
      setStatus('');
    }

    // Rows are kept and updated in place: rebuilding them would take focus
    // off the row just clicked, and the popover closes when focus leaves it.
    const rows = difficulties.map((difficulty) => {
      let row = pickerRows.get(difficulty.beatmapId);
      if (!row) {
        row = createPickerRow(difficulty);
        pickerRows.set(difficulty.beatmapId, row);
      }
      const isLead = difficulty.beatmapId === lead.beatmapId;
      const isShown = isLead || shown.has(difficulty.beatmapId);
      row.element.setAttribute('aria-pressed', isShown ? 'true' : 'false');
      row.element.classList.toggle('is-lead', isLead);
      row.element.disabled = isLead || (!isShown && isFull);
      const tagState = isLead ? 'lead' : (isShown ? 'shown' : '');
      if (row.tagState !== tagState) {
        row.tagState = tagState;
        if (tagState === 'lead') {
          row.tag.replaceChildren();
          row.tag.textContent = 'Opened';
        } else if (tagState === 'shown') {
          // Put back each time it is shown, so its little arrival plays.
          row.tag.replaceChildren(row.check);
        } else {
          row.tag.replaceChildren();
        }
      }
      return row.element;
    });
    const current = [...listElement.children];
    if (current.length !== rows.length || current.some((element, index) => element !== rows[index])) {
      listElement.replaceChildren(...rows);
    }
  }

  function createPickerRow(difficulty) {
    const element = createElement('button', 'map-preview-compare-option');
    element.type = 'button';
    element.dataset.beatmapId = difficulty.beatmapId;
    const stars = createElement('span', 'map-preview-panel-stars');
    fillStarPill(stars, difficulty.stars);
    if (stars.hidden) {
      stars.hidden = false;
      stars.textContent = '★ ?';
    }
    const name = createElement('span', 'map-preview-compare-option-name', difficulty.version || `#${difficulty.beatmapId}`);
    const tag = createElement('span', 'map-preview-compare-option-tag');
    const check = createElement('span', 'map-preview-compare-check');
    const checkIcon = createIcon(CHECK_PATH);
    if (checkIcon) {
      check.append(checkIcon);
    } else {
      check.textContent = '✓';
    }
    element.append(stars, name, tag);
    element.title = difficulty.convert ? `${difficulty.version} (converted)` : difficulty.version;
    element.addEventListener('click', () => {
      if (difficulty.beatmapId !== lead?.beatmapId) {
        toggleDifficulty(difficulty.beatmapId);
      }
    });
    return { element, tag, check, tagState: null };
  }

  button?.addEventListener('click', () => {
    if (isPickerOpen() && lead?.setId) {
      renderPicker();
      void ensureList(lead.setId);
    }
  });

  function toggleDifficulty(beatmapId) {
    if (!lead?.setId || beatmapId === lead.beatmapId) {
      return;
    }
    const ids = panels.map((panel) => panel.beatmapId);
    if (ids.includes(beatmapId)) {
      reconcile(ids.filter((id) => id !== beatmapId), { animate: true });
    } else if (1 + ids.length < MAX_PREVIEW_PANELS) {
      reconcile([...ids, beatmapId], { animate: true });
    } else {
      return;
    }
    persist();
    renderPicker();
    onPanelsChanged();
  }

  panelsElement?.addEventListener('click', (event) => {
    if (event.target instanceof HTMLCanvasElement && event.target.dataset.compare === 'true') {
      onCanvasClick();
    }
  });

  // --- what the popup calls -------------------------------------------------

  /**
   * After the lead map is in. `keys` is the lead's mania column count.
   */
  const setLead = async ({ setId, beatmapId, mode, version = '', keys = null }) => {
    const previous = lead;
    const live = previous ? {
      setId: previous.setId,
      mode: previous.mode,
      leadId: previous.beatmapId,
      ids: [previous.beatmapId, ...panels.map((panel) => panel.beatmapId)],
    } : null;
    const next = {
      setId: setId ? String(setId) : null,
      beatmapId: String(beatmapId ?? ''),
      mode: Number.isInteger(mode) ? mode : 0,
      version,
      keys: Number.isFinite(keys) ? keys : null,
    };
    const changedRuleset = !previous || previous.setId !== next.setId || previous.mode !== next.mode;
    // A choice of hitsounds lasts as long as its difficulty is shown.
    const liveSoundId = changedRuleset ? null : soundId;
    lead = next;
    leadGeneration += 1;
    const generation = leadGeneration;
    if (button) {
      button.disabled = !next.setId;
    }
    syncCompareButton();
    if (changedRuleset) {
      // Panels of another set or ruleset are never kept, and a panel still
      // loading for one must not land in the next.
      reconcile([]);
    }
    if (!next.setId) {
      picker.dismiss();
      return;
    }

    let stored = null;
    if (!live || changedRuleset) {
      try {
        stored = await readSession(SELECTION_KEY);
      } catch {
        stored = null;
      }
    }
    if (generation !== leadGeneration) {
      return;
    }

    const ids = resolveCompareIds({ lead: next, live: changedRuleset ? null : live, stored });
    const storedSoundId = stored?.setId === next.setId && stored?.mode === next.mode ? (stored.soundId ?? null) : null;
    const wantedSoundId = changedRuleset ? storedSoundId : liveSoundId;
    const current = panels.map((panel) => panel.beatmapId);
    if (!sameIds(ids, current)) {
      // A difficulty that moves into the lead keeps nothing of its panel: the
      // lead loads its own copy, with the timeline and hitsounds.
      reconcile(ids);
    }
    soundId = wantedSoundId && (wantedSoundId === next.beatmapId || ids.includes(wantedSoundId))
      ? wantedSoundId
      : null;
    refreshLabels();
    persist();
    // The popup has just built the lead's hitsounds for the new map; a choice
    // of another difficulty's is put back over them.
    notifySound({ force: true });
    void ensureList(next.setId);
    syncCompareButton();
    renderPicker();
    onPanelsChanged();
  };

  // The lead failed or the tab has no map: the panels go, the selection stays
  // for when a map of that set comes back.
  const clear = () => {
    lead = null;
    leadGeneration += 1;
    if (button) {
      button.disabled = true;
    }
    if (control) {
      control.hidden = true;
    }
    picker.dismiss();
    reconcile([]);
  };

  const render = (timeMs) => {
    for (const panel of panels) {
      if (panel.renderer) {
        panel.renderer.setTime(timeMs);
        panel.renderer.renderPlayfield();
      }
    }
  };

  const setDuration = (durationMs) => {
    panels.forEach((panel) => panel.renderer?.setDuration(durationMs));
  };

  const setPreviewSettings = (settings) => {
    panels.forEach((panel) => panel.renderer?.setPreviewSettings(settings));
  };

  // A new mania key count: converts follow it, as the lead does.
  const reconvert = () => {
    let changed = false;
    panels.forEach((panel) => {
      if (panel.mapData?.conversion?.targetMode !== 3 || !panel.sourceMapData) {
        return;
      }
      panel.mapData = convertMap(panel.sourceMapData, 3);
      panel.renderer?.replaceManiaObjects(panel.mapData);
      changed = true;
    });
    if (changed) {
      refreshLabels();
      notifySound();
    }
  };

  const setLeadKeys = (keys) => {
    if (lead) {
      lead.keys = Number.isFinite(keys) ? keys : null;
      refreshLabels();
    }
  };

  // The longest of the added difficulties, for a timeline that has to reach
  // the end of all of them before the full track says how long the song is.
  const getLongestMappedDurationMs = () => panels.reduce((longest, panel) => (
    Number.isFinite(panel.mapData?.maxObjectTime)
      ? Math.max(longest, panel.mapData.maxObjectTime + 2000)
      : longest
  ), 0);

  return {
    setLead,
    clear,
    render,
    setDuration,
    setPreviewSettings,
    reconvert,
    setLeadKeys,
    relayout: layout,
    getLongestMappedDurationMs,
    getSoundMap,
    selectSound,
    getCount: () => 1 + panels.length,
    dismissPicker: () => picker.dismiss(),
    containsPickerTarget: (target) => Boolean(control?.contains(target)),
  };
};

export { createComparePanels, resolveCompareIds, SELECTION_KEY, LIST_CACHE_KEY };
