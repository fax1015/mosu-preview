import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_IDS,
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
} from '../src/core/keybindings.js';

test('no two actions ship on the same key', () => {
  const seen = new Map();
  for (const action of SHORTCUT_ACTIONS) {
    for (const key of action.defaultKeys) {
      assert.equal(seen.get(key), undefined, `${key} is claimed by ${seen.get(key)} and ${action.id}`);
      seen.set(key, action.id);
    }
  }
});

test('no default sits on a key the preview keeps for itself', () => {
  for (const action of SHORTCUT_ACTIONS) {
    for (const key of action.defaultKeys) {
      assert.ok(isBindableKey(key), `${action.id} defaults to the reserved ${key}`);
    }
  }
  assert.ok(RESERVED_KEYS.has('escape'));
  assert.ok(RESERVED_KEYS.has('7'), 'the digits are the percentage jump');
});

test('every row points at actions that exist, and every action has a row', () => {
  const rowed = new Set();
  for (const row of SHORTCUT_ROWS) {
    assert.ok(row.label, 'a row says what it does');
    assert.ok(Array.isArray(row.actions) || Array.isArray(row.fixed), `${row.label} has keys`);
    for (const id of row.actions || []) {
      assert.ok(ACTION_IDS.includes(id), `${id} is a real action`);
      assert.equal(rowed.has(id), false, `${id} is listed twice`);
      rowed.add(id);
    }
  }
  assert.deepEqual([...rowed].sort(), [...ACTION_IDS].sort(), 'nothing is bindable but unlisted');
});

test('a keydown reads as the token its binding is stored under', () => {
  assert.equal(eventKeyToken({ key: 'ArrowLeft' }), 'arrowleft');
  assert.equal(eventKeyToken({ key: ' ' }), ' ');
  assert.equal(eventKeyToken({ key: 'S' }), 's', 'a shifted letter is still that letter');
  assert.equal(eventKeyToken({ key: '?' }), '?');
  // '?' is shift+'/' on most layouts, where the browser already says '?' --
  // but not on all of them.
  assert.equal(eventKeyToken({ key: '/', shiftKey: true }), '?');
  assert.equal(eventKeyToken({ key: '/' }), '/');
  assert.equal(eventKeyToken({}), '');
});

test('keys are written the way they are pressed', () => {
  assert.equal(formatKeyLabel(' '), 'Space');
  assert.equal(formatKeyLabel('arrowleft'), '←');
  assert.equal(formatKeyLabel('home'), 'Home');
  assert.equal(formatKeyLabel('s'), 'S');
  assert.equal(formatKeyLabel(','), ',');
  assert.equal(formatBindingLabel([]), 'Unset');
  assert.equal(formatBindingLabel(undefined), 'Unset');
  assert.equal(formatBindingLabel(['=', '+']), '=');
});

test('nothing stored means every shortcut is at its default', () => {
  assert.deepEqual(normalizeKeybindings(undefined), defaultKeybindings());
  assert.deepEqual(normalizeKeybindings(null), defaultKeybindings());
  assert.deepEqual(normalizeKeybindings('nonsense'), defaultKeybindings());
  assert.deepEqual(normalizeKeybindings([]), defaultKeybindings());
  assert.equal(hasCustomKeybindings(normalizeKeybindings({})), false);
});

test('only what moved off its default is stored', () => {
  const { bindings } = assignKeybinding(defaultKeybindings(), 'mute', 'x');
  const stored = toStoredKeybindings(bindings);

  assert.deepEqual(stored, { mute: ['x'] });
  assert.ok(hasCustomKeybindings(bindings));
  // ...and reading it back restores exactly that, defaults and all.
  assert.deepEqual(normalizeKeybindings(stored), bindings);
});

test('an unbound action is stored as such, not as a missing default', () => {
  const bindings = normalizeKeybindings({ playPause: [] });

  assert.deepEqual(bindings.playPause, []);
  assert.deepEqual(toStoredKeybindings(bindings), { playPause: [] });
  assert.deepEqual(normalizeKeybindings(toStoredKeybindings(bindings)).playPause, []);
});

test('unreadable stored data falls back rather than breaking the keyboard', () => {
  const bindings = normalizeKeybindings({
    notAnAction: ['q'],
    mute: 'x',
    restart: ['R', 'r', '  '],
    cycleSpeed: [null, 5, {}],
    // Keys the preview will not give up, however they got in there.
    copyTimestamp: ['escape', 'tab', '4', 'z'],
  });

  assert.equal(Object.hasOwn(bindings, 'notAnAction'), false);
  assert.deepEqual(bindings.mute, ['x'], 'a bare string is read as one key');
  assert.deepEqual(bindings.restart, ['r'], 'case folded and duplicates collapsed');
  assert.deepEqual(bindings.cycleSpeed, [], 'nothing readable means unbound');
  assert.deepEqual(bindings.copyTimestamp, ['z'], 'the reserved keys are dropped');
});

test('a key two actions somehow claim is kept by one of them', () => {
  // Hand-edited sync data, or two builds disagreeing. One keypress must never
  // fire two actions.
  const bindings = normalizeKeybindings({ mute: ['z'], restart: ['z'] });

  assert.deepEqual(bindings.mute, ['z']);
  assert.deepEqual(bindings.restart, []);

  const lookup = createKeybindingLookup(bindings);
  assert.equal(lookup.get('z'), 'mute');
});

test('the lookup answers every default key', () => {
  const lookup = createKeybindingLookup(defaultKeybindings());

  assert.equal(lookup.get(' '), 'playPause');
  assert.equal(lookup.get('arrowleft'), 'seekBackward');
  assert.equal(lookup.get('n'), 'nextSection');
  assert.equal(lookup.get('c'), 'copyTimestamp');
  // Both spellings of the zoom keys, since layouts disagree about which is shifted.
  assert.equal(lookup.get('='), 'zoomIn');
  assert.equal(lookup.get('+'), 'zoomIn');
  assert.equal(lookup.get('-'), 'zoomOut');
  assert.equal(lookup.get('_'), 'zoomOut');
  assert.equal(lookup.get('q'), undefined);
});

test('rebinding takes the key from whatever held it', () => {
  // Refusing would send the user off to clear the other shortcut first; this
  // way the row that lost its key says so in the same list.
  const { bindings, replaced } = assignKeybinding(defaultKeybindings(), 'mute', 'r');

  assert.equal(replaced, 'restart');
  assert.deepEqual(bindings.mute, ['r']);
  assert.deepEqual(bindings.restart, []);
  assert.equal(createKeybindingLookup(bindings).get('r'), 'mute');
});

test('rebinding replaces a multi-key default with the one key pressed', () => {
  const { bindings } = assignKeybinding(defaultKeybindings(), 'zoomIn', 'w');

  assert.deepEqual(bindings.zoomIn, ['w']);
  assert.equal(createKeybindingLookup(bindings).get('='), undefined);
});

test('rebinding an action to the key it already has changes nothing', () => {
  const { bindings, replaced } = assignKeybinding(defaultKeybindings(), 'mute', 'm');

  assert.equal(replaced, null);
  assert.deepEqual(bindings.mute, ['m']);
  assert.equal(hasCustomKeybindings(bindings), false);
});

test('a reserved or unknown rebind is refused outright', () => {
  const start = defaultKeybindings();

  for (const key of ['escape', 'tab', 'enter', '3', 'shift', '']) {
    const { bindings, replaced } = assignKeybinding(start, 'mute', key);
    assert.deepEqual(bindings, start, `${key} was taken`);
    assert.equal(replaced, null);
  }

  assert.deepEqual(assignKeybinding(start, 'notAnAction', 'q').bindings, start);
});

test('space can be rebound and rebound onto', () => {
  const moved = assignKeybinding(defaultKeybindings(), 'playPause', 'z').bindings;
  assert.deepEqual(moved.playPause, ['z']);

  const back = assignKeybinding(moved, 'mute', ' ');
  assert.deepEqual(back.bindings.mute, [' ']);
  assert.equal(createKeybindingLookup(back.bindings).get(' '), 'mute');
});

test('resetting one action takes its default back off whoever has it', () => {
  const stolen = assignKeybinding(defaultKeybindings(), 'mute', 'r').bindings;
  const { bindings, replaced } = resetKeybinding(stolen, 'restart');

  assert.deepEqual(bindings.restart, ['r']);
  assert.deepEqual(bindings.mute, [], 'mute had taken R, so it loses it again');
  assert.equal(replaced, 'mute');
});

test('resetting restores every key of a multi-key default', () => {
  const moved = assignKeybinding(defaultKeybindings(), 'zoomIn', 'w').bindings;

  assert.deepEqual(resetKeybinding(moved, 'zoomIn').bindings.zoomIn, ['=', '+']);
});

test('findActionByKey reads a key the way the handler will', () => {
  const bindings = defaultKeybindings();

  assert.equal(findActionByKey(bindings, 'm'), 'mute');
  assert.equal(findActionByKey(bindings, 'M'), 'mute');
  assert.equal(findActionByKey(bindings, ' '), 'playPause');
  assert.equal(findActionByKey(bindings, 'q'), null);
  assert.equal(findActionByKey(bindings, null), null);
});
