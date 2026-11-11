// The preview's own keyboard shortcuts: what each one does, the key it starts
// on, and the reading of a stored remap.
//
// A binding is a list of key tokens, and a token is `event.key` lowercased --
// ' ', 'arrowleft', 's', ','. A list rather than one key because a few defaults
// have to cover more than one physical key: '+' is shift+'=' on a US layout but
// its own key elsewhere, so zooming in answers to both. Remapping replaces the
// list with the single key the user pressed.
//
// An action missing from storage is at its default; an action stored with an
// empty list was deliberately unbound. That distinction is why the stored shape
// is a sparse object rather than the whole table.
//
// Pure: no DOM and no storage, so the table, the matching and the conflict
// handling are all testable on plain objects.

const SPACE = ' ';

/**
 * Keys the preview will not hand over, whatever the user presses while
 * rebinding:
 *
 * - tab, enter and escape run the dialogs themselves. Binding one would make
 *   the shortcuts panel impossible to leave by keyboard.
 * - the digits jump to a percentage of the map, which is a range rather than
 *   an action and so has no row to rebind.
 */
const RESERVED_KEYS = Object.freeze(new Set([
  'tab', 'enter', 'escape',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
]));

/**
 * Every remappable action, in the order a conflict is settled in: where stored
 * data somehow gives one key to two actions, the earlier one keeps it.
 */
const SHORTCUT_ACTIONS = Object.freeze([
  { id: 'playPause', label: 'Play / pause', defaultKeys: [SPACE] },
  { id: 'mute', label: 'Mute', defaultKeys: ['m'] },
  { id: 'restart', label: 'Restart', defaultKeys: ['r'] },
  { id: 'volumeUp', label: 'Volume up', defaultKeys: ['arrowup'] },
  { id: 'volumeDown', label: 'Volume down', defaultKeys: ['arrowdown'] },
  { id: 'cycleSpeed', label: 'Cycle speed', defaultKeys: ['s'] },
  { id: 'speedDown', label: 'Nudge speed down', defaultKeys: ['['] },
  { id: 'speedUp', label: 'Nudge speed up', defaultKeys: [']'] },
  { id: 'seekBackward', label: 'Seek back', defaultKeys: ['arrowleft'] },
  { id: 'seekForward', label: 'Seek forward', defaultKeys: ['arrowright'] },
  { id: 'jumpStart', label: 'Jump to start', defaultKeys: ['home'] },
  { id: 'jumpEnd', label: 'Jump to end', defaultKeys: ['end'] },
  { id: 'previousSection', label: 'Previous section', defaultKeys: ['p'] },
  { id: 'nextSection', label: 'Next section', defaultKeys: ['n'] },
  { id: 'frameBack', label: 'Step back a frame', defaultKeys: [','] },
  { id: 'frameForward', label: 'Step on a frame', defaultKeys: ['.'] },
  // '+' and '-' are shifted keys on some layouts and their own on others.
  { id: 'zoomIn', label: 'Zoom in', defaultKeys: ['=', '+'] },
  { id: 'zoomOut', label: 'Zoom out', defaultKeys: ['-', '_'] },
  { id: 'cycleManiaKeys', label: 'Cycle mania keys', defaultKeys: ['k'] },
  { id: 'copyTimestamp', label: 'Copy timestamp', defaultKeys: ['c'] },
  { id: 'showShortcuts', label: 'Show shortcuts', defaultKeys: ['?'] },
]);

const ACTION_IDS = Object.freeze(SHORTCUT_ACTIONS.map((action) => action.id));
const ACTIONS_BY_ID = Object.freeze(Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action.id, action]),
));

/**
 * The panel's rows. A row is what is read, an action is what is bound: pairs
 * that belong together ("Seek", "Zoom") stay on one line with a chip each,
 * which keeps the list short without making half a pair unrebindable.
 *
 * A row with `fixed` instead of `actions` is something the preview does not
 * own -- a range of keys, the wheel, the dialog key the dialogs need -- so it
 * is listed to be read and not to be changed.
 */
const SHORTCUT_ROWS = Object.freeze([
  { group: 'Playback', actions: ['playPause'], label: 'Play / pause' },
  { group: 'Playback', actions: ['mute'], label: 'Mute' },
  { group: 'Playback', actions: ['restart'], label: 'Restart' },
  { group: 'Playback', actions: ['volumeUp', 'volumeDown'], label: 'Volume' },
  { group: 'Playback', actions: ['cycleSpeed'], label: 'Cycle speed' },
  { group: 'Playback', actions: ['speedDown', 'speedUp'], label: 'Nudge speed' },

  { group: 'Seeking', actions: ['seekBackward', 'seekForward'], label: 'Seek 5s', note: 'Shift: 15s' },
  { group: 'Seeking', actions: ['jumpStart', 'jumpEnd'], label: 'Start / end' },
  { group: 'Seeking', actions: ['previousSection', 'nextSection'], label: 'Jump by section' },
  { group: 'Seeking', actions: ['frameBack', 'frameForward'], label: 'Step one frame' },
  { group: 'Seeking', fixed: ['0 – 9'], label: 'Jump to 0–90%' },

  { group: 'Timeline', actions: ['zoomIn', 'zoomOut'], label: 'Zoom' },
  { group: 'Timeline', fixed: ['Scroll'], label: 'Zoom at cursor' },
  { group: 'Timeline', fixed: ['⇧ Scroll'], label: 'Pan zoomed' },
  { group: 'Timeline', fixed: ['Esc'], label: 'Zoom out / close' },

  { group: 'Other', actions: ['cycleManiaKeys'], label: 'Cycle mania keys' },
  { group: 'Other', actions: ['copyTimestamp'], label: 'Copy timestamp', note: 'picked objects' },
  { group: 'Other', actions: ['showShortcuts'], label: 'Show shortcuts' },
]);

const KEY_LABELS = Object.freeze({
  [SPACE]: 'Space',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  backspace: '⌫',
  delete: 'Del',
  insert: 'Ins',
});

/** How a key token is written on a chip. */
const formatKeyLabel = (key) => {
  const token = String(key ?? '');
  if (!token) {
    return 'Unset';
  }
  if (KEY_LABELS[token]) {
    return KEY_LABELS[token];
  }
  return token.length === 1 ? token.toUpperCase() : token.replace(/^./, (c) => c.toUpperCase());
};

/** A whole binding on one chip: the first key, or "Unset" when there is none. */
const formatBindingLabel = (keys) => (
  Array.isArray(keys) && keys.length > 0 ? formatKeyLabel(keys[0]) : 'Unset'
);

/**
 * The token a keydown means.
 *
 * '?' is shift+'/' on most layouts, where the browser already reports '?' --
 * but not on all of them, so a shifted '/' is read as '?' either way. Nothing
 * else needs normalising: a shifted letter still reports the letter.
 */
const eventKeyToken = (event) => {
  const key = String(event?.key ?? '');
  if (!key) {
    return '';
  }
  if (key === '/' && event?.shiftKey) {
    return '?';
  }
  return key.toLowerCase();
};

/** Whether a key can be bound at all. Modifier-only presses included. */
const isBindableKey = (key) => {
  const token = String(key ?? '').toLowerCase();
  if (!token || RESERVED_KEYS.has(token)) {
    return false;
  }
  return !['shift', 'control', 'alt', 'meta', 'altgraph', 'dead', 'unidentified'].includes(token);
};

const defaultKeybindings = () => Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action.id, [...action.defaultKeys]]),
);

const sameKeys = (a, b) => (
  a.length === b.length && a.every((key, index) => key === b[index])
);

/**
 * A stored remap read back over the defaults.
 *
 * Anything unreadable falls back rather than throwing: an unknown action id is
 * dropped, a key the preview will not give up is dropped, and a key that two
 * actions somehow claim is kept by the earlier one, so a hand-edited sync blob
 * can never leave the preview with a shortcut that fires two things at once.
 */
const normalizeKeybindings = (value) => {
  const bindings = defaultKeybindings();
  const stored = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};

  for (const id of ACTION_IDS) {
    if (!Object.hasOwn(stored, id)) {
      continue;
    }
    const raw = stored[id];
    // A single key is accepted as well as a list: it is what a remap writes if
    // some other build ever stores the simpler shape.
    const list = Array.isArray(raw) ? raw : [raw];
    bindings[id] = [...new Set(
      list
        .filter((key) => typeof key === 'string')
        .map((key) => (key === SPACE ? SPACE : key.trim().toLowerCase()))
        .filter(isBindableKey),
    )];
  }

  const claimed = new Map();
  for (const id of ACTION_IDS) {
    bindings[id] = bindings[id].filter((key) => {
      if (claimed.has(key)) {
        return false;
      }
      claimed.set(key, id);
      return true;
    });
  }

  return bindings;
};

/** Only what differs from the defaults, so the table can grow without a migration. */
const toStoredKeybindings = (bindings) => {
  const normalized = normalizeKeybindings(bindings);
  const stored = {};
  for (const action of SHORTCUT_ACTIONS) {
    if (!sameKeys(normalized[action.id], action.defaultKeys)) {
      stored[action.id] = normalized[action.id];
    }
  }
  return stored;
};

/** Key token -> action id, for the keydown handler to read once per map. */
const createKeybindingLookup = (bindings) => {
  const normalized = normalizeKeybindings(bindings);
  const lookup = new Map();
  for (const id of ACTION_IDS) {
    for (const key of normalized[id]) {
      if (!lookup.has(key)) {
        lookup.set(key, id);
      }
    }
  }
  return lookup;
};

/** Which action already answers to a key, or null. */
const findActionByKey = (bindings, key) => {
  // Space lowercases to itself, so this is safe for every token.
  const token = typeof key === 'string' ? key.toLowerCase() : '';
  return createKeybindingLookup(bindings).get(token) ?? null;
};

/**
 * Gives `key` to `actionId`, taking it from whatever held it.
 *
 * Taking rather than refusing: a refusal makes the user go and clear the other
 * shortcut first, and they can see in the same list what just lost its key.
 *
 * @returns {{ bindings: object, replaced: string|null }} `replaced` is the
 *   action that lost the key, for the panel to point at.
 */
const assignKeybinding = (bindings, actionId, key) => {
  const current = normalizeKeybindings(bindings);
  if (!Object.hasOwn(ACTIONS_BY_ID, actionId) || !isBindableKey(key)) {
    return { bindings: current, replaced: null };
  }

  const token = key === SPACE ? SPACE : String(key).toLowerCase();
  const previous = findActionByKey(current, token);
  if (previous === actionId && current[actionId].length === 1) {
    return { bindings: current, replaced: null };
  }

  const next = { ...current };
  if (previous && previous !== actionId) {
    next[previous] = current[previous].filter((candidate) => candidate !== token);
  }
  next[actionId] = [token];
  return { bindings: next, replaced: previous && previous !== actionId ? previous : null };
};

/** Puts one action back on its default key, taking it from whoever holds it. */
const resetKeybinding = (bindings, actionId) => {
  const action = ACTIONS_BY_ID[actionId];
  if (!action) {
    return { bindings: normalizeKeybindings(bindings), replaced: null };
  }

  const current = normalizeKeybindings(bindings);
  const next = { ...current };
  let replaced = null;
  for (const key of action.defaultKeys) {
    const holder = findActionByKey(next, key);
    if (holder && holder !== actionId) {
      next[holder] = next[holder].filter((candidate) => candidate !== key);
      replaced = replaced || holder;
    }
  }
  next[actionId] = [...action.defaultKeys];
  return { bindings: next, replaced };
};

/** Whether anything has been moved off its default. */
const hasCustomKeybindings = (bindings) => Object.keys(toStoredKeybindings(bindings)).length > 0;

export {
  ACTION_IDS,
  ACTIONS_BY_ID,
  RESERVED_KEYS,
  SHORTCUT_ACTIONS,
  SHORTCUT_ROWS,
  assignKeybinding,
  createKeybindingLookup,
  defaultKeybindings,
  eventKeyToken,
  findActionByKey,
  formatBindingLabel,
  formatKeyLabel,
  hasCustomKeybindings,
  isBindableKey,
  normalizeKeybindings,
  resetKeybinding,
  toStoredKeybindings,
};
