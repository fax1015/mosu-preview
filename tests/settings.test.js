import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assignKeybinding, defaultKeybindings } from '../src/core/keybindings.js';
import {
  PREVIEW_SETTING_KEYS,
  DEFAULT_DISABLED_PROVIDERS,
  DEFAULT_HITSOUND_STYLE,
  DEFAULT_MANIA_KEY_COUNT,
  HITSOUND_STYLES,
  MANIA_KEY_COUNT_KEY,
  MANIA_KEY_COUNTS,
  MANIA_PRIMARY_KEY_COUNTS,
  PREVIEW_ONLY_SETTING_KEYS,
  applyPreviewSettingChanges,
  hasPreviewSettingChange,
  AUTOPLAY_KEY,
  DEFAULT_AUTOPLAY,
  EMBEDDED_PLAYER_KEY,
  DEFAULT_EMBEDDED_PLAYER,
  KEYBINDINGS_KEY,
  normalizeAutoFallback,
  normalizeAutoplay,
  normalizeDisabledProviders,
  normalizeEmbeddedPlayer,
  normalizeHitsoundStyle,
  normalizeManiaKeyCount,
  normalizePreviewSettings,
  toPreviewSettingsStorage,
  DEFAULT_MINI_HITSOUNDS_WHEN_COLLAPSED,
  MINI_HITSOUNDS_WHEN_COLLAPSED_KEY,
  normalizeMiniHitsoundsWhenCollapsed,
  shouldPlayHitsounds,
} from '../src/settings.js';

test('disabled providers never alias the shared default array', () => {
  const first = normalizePreviewSettings().disabledProviders;
  first.push('mino');

  assert.deepEqual(DEFAULT_DISABLED_PROVIDERS, []);
  assert.deepEqual(normalizePreviewSettings().disabledProviders, []);
});

test('unknown provider ids are dropped and duplicates collapsed', () => {
  assert.deepEqual(
    normalizeDisabledProviders(['mino', 'mino', 'not-a-provider']),
    ['mino'],
  );
});

test('preview settings storage payload never contains a provider override', () => {
  // The options page has no override control; emitting the key here would let a
  // normalized `undefined` silently reset the user's stored choice to 'auto'.
  const payload = toPreviewSettingsStorage(normalizePreviewSettings());
  assert.equal(Object.hasOwn(payload, 'providerOverride'), false);
});

test('every persisted setting is also one the readers ask storage for', () => {
  // Both the popup and the options page read an explicit key list. When that
  // list was maintained by hand a new setting could be written but never read
  // back, so it silently reverted to its default on every open -- which is what
  // happened to the hitsound toggle.
  const persisted = Object.keys(toPreviewSettingsStorage(normalizePreviewSettings()));
  const missing = persisted.filter((key) => !PREVIEW_SETTING_KEYS.includes(key));

  assert.deepEqual(missing, [], `these settings are written but never read: ${missing.join(', ')}`);
});

test('the read list contains no keys that are never written', () => {
  const persisted = new Set(Object.keys(toPreviewSettingsStorage(normalizePreviewSettings())));
  const stale = PREVIEW_SETTING_KEYS.filter((key) => !persisted.has(key));

  assert.deepEqual(stale, [], `these keys are read but never written: ${stale.join(', ')}`);
});

test('a stored hitsound preference survives a read', () => {
  const stored = toPreviewSettingsStorage({ hitsounds: true, hitsoundVolume: 0.25 });
  const readBack = normalizePreviewSettings(stored);

  assert.equal(readBack.hitsounds, true);
  assert.equal(readBack.hitsoundVolume, 0.25);
});

test('hitsounds in the collapsed miniplayer bar: on by default, stored, and obeyed', () => {
  assert.equal(DEFAULT_MINI_HITSOUNDS_WHEN_COLLAPSED, true);
  assert.ok(PREVIEW_SETTING_KEYS.includes(MINI_HITSOUNDS_WHEN_COLLAPSED_KEY));
  assert.equal(normalizePreviewSettings().miniHitsoundsWhenCollapsed, true);
  assert.equal(normalizeMiniHitsoundsWhenCollapsed('false'), false);
  assert.equal(normalizeMiniHitsoundsWhenCollapsed(undefined), true);

  const stored = toPreviewSettingsStorage({ miniHitsoundsWhenCollapsed: false });
  assert.equal(stored[MINI_HITSOUNDS_WHEN_COLLAPSED_KEY], false);
  assert.equal(normalizePreviewSettings(stored).miniHitsoundsWhenCollapsed, false);
  const changed = applyPreviewSettingChanges(
    normalizePreviewSettings(),
    { [MINI_HITSOUNDS_WHEN_COLLAPSED_KEY]: { oldValue: true, newValue: false } },
  );
  assert.equal(changed.miniHitsoundsWhenCollapsed, false);

  const play = (overrides) => shouldPlayHitsounds({
    hitsounds: true, isEmbedded: true, collapsed: true, whenCollapsed: false, ...overrides,
  });
  assert.equal(play({}), false, 'the collapsed bar stays quiet when the setting is off');
  assert.equal(play({ whenCollapsed: true }), true);
  assert.equal(play({ collapsed: false }), true, 'expanded, it plays as usual');
  assert.equal(play({ isEmbedded: false }), true, 'the toolbar popup has no collapsed bar');
  assert.equal(play({ hitsounds: false, whenCollapsed: true }), false, 'hitsounds off is off everywhere');

  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  assert.match(html, /id="miniHitsoundsWhenCollapsed"/);
  const optionsSource = readFileSync(new URL('../src/options.js', import.meta.url), 'utf8');
  assert.match(optionsSource, /miniHitsoundsWhenCollapsed: miniHitsoundsWhenCollapsedToggle\?\.checked/);
});

test('a storage change only moves the settings it names', () => {
  const current = normalizePreviewSettings({ maniaScrollSpeed: 12, hitsounds: true, popupSize: 'large' });

  const next = applyPreviewSettingChanges(current, {
    maniaScrollSpeed: { oldValue: 12, newValue: 30 },
    providerOverride: { newValue: 'mino' },
  });

  assert.equal(next.maniaScrollSpeed, 30);
  assert.equal(next.hitsounds, true, 'untouched settings keep their current value');
  assert.equal(next.popupSize, 'large');
});

test('a setting removed from storage falls back to its default', () => {
  // The old listener kept whatever the page had, so clearing a setting did nothing.
  const current = normalizePreviewSettings({ hitsounds: true, standardSliderEndCircles: false });

  const next = applyPreviewSettingChanges(current, {
    hitsounds: { oldValue: true },
    standardSliderEndCircles: { oldValue: false },
  });

  assert.equal(next.hitsounds, false);
  assert.equal(next.standardSliderEndCircles, true);
});

test('every preview setting is one the change listener reacts to', () => {
  for (const key of PREVIEW_SETTING_KEYS) {
    assert.equal(hasPreviewSettingChange({ [key]: { newValue: null } }), true, key);
  }
  assert.equal(hasPreviewSettingChange({ audioVolume: { newValue: 0.4 } }), false);
  assert.equal(hasPreviewSettingChange({}), false);
});

test('auto-fallback reads a stored string the same way every other toggle does', () => {
  assert.equal(normalizeAutoFallback('false'), false);
  assert.equal(normalizeAutoFallback(false), false);
  assert.equal(normalizeAutoFallback(undefined), true);
  assert.equal(normalizeAutoFallback('true'), true);
});

test('hitsounds keep their original style until another is chosen', () => {
  assert.equal(DEFAULT_HITSOUND_STYLE, 'argon');
  assert.equal(normalizePreviewSettings().hitsoundStyle, 'argon');
  assert.equal(normalizePreviewSettings({ hitsoundVolume: 0.3 }).hitsoundStyle, 'argon');
});

test('an unknown hitsound style falls back to the default rather than going silent', () => {
  // A style dropped in a later build, a hand-edited value, or junk in sync data.
  for (const value of ['skinnotfound', '', null, undefined, 3, {}, ['lazer'], 'toString']) {
    assert.equal(normalizeHitsoundStyle(value), DEFAULT_HITSOUND_STYLE, String(value));
  }
  assert.equal(normalizeHitsoundStyle('Lazer'), 'lazer', 'case does not matter');
});

test('the options page offers every hitsound style, with the default first', () => {
  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  const select = html.match(/<select[^>]*id="hitsoundStyle"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select, 'the style dropdown is in options.html');
  const offered = [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(offered, [...HITSOUND_STYLES]);
  assert.equal(offered[0], DEFAULT_HITSOUND_STYLE);
});

test('every hitsound style survives a round trip through storage', () => {
  for (const style of HITSOUND_STYLES) {
    const stored = toPreviewSettingsStorage({ hitsoundStyle: style });
    assert.equal(stored.hitsoundStyle, style);
    assert.equal(normalizePreviewSettings(stored).hitsoundStyle, style);
  }
});

test('a hitsound style change reaches an open popup, and clearing it restores the default', () => {
  const current = normalizePreviewSettings({ hitsounds: true, hitsoundStyle: 'lazer' });

  const changed = applyPreviewSettingChanges(current, {
    hitsoundStyle: { oldValue: 'lazer', newValue: 'minimal' },
  });
  assert.equal(changed.hitsoundStyle, 'minimal');
  assert.equal(changed.hitsounds, true);

  const cleared = applyPreviewSettingChanges(changed, { hitsoundStyle: { oldValue: 'minimal' } });
  assert.equal(cleared.hitsoundStyle, DEFAULT_HITSOUND_STYLE);
});

test('mania converts keep their own key count until one is chosen', () => {
  assert.equal(DEFAULT_MANIA_KEY_COUNT, 'auto');
  assert.equal(normalizePreviewSettings().maniaKeyCount, 'auto');
  assert.ok(PREVIEW_SETTING_KEYS.includes(MANIA_KEY_COUNT_KEY));
});

test('a key count is a whole 1K-10K or auto, never the nearest count to junk', () => {
  for (const keys of MANIA_KEY_COUNTS) {
    assert.equal(normalizeManiaKeyCount(keys), keys);
    // The options page's <select> hands its values over as strings.
    assert.equal(normalizeManiaKeyCount(String(keys)), keys);
  }
  for (const value of [0, 11, 18, -4, 4.5, '4.5', '', ' ', 'auto', 'AUTO', '7k', null, undefined, true, {}, [4], NaN]) {
    assert.equal(normalizeManiaKeyCount(value), 'auto', String(value));
  }
});

test('4K and 7K lead the key counts, and every count survives storage', () => {
  assert.deepEqual([...MANIA_PRIMARY_KEY_COUNTS], [4, 7]);
  assert.ok(MANIA_PRIMARY_KEY_COUNTS.every((keys) => MANIA_KEY_COUNTS.includes(keys)));
  for (const keys of [...MANIA_KEY_COUNTS, 'auto']) {
    const stored = toPreviewSettingsStorage({ maniaKeyCount: keys });
    assert.equal(stored[MANIA_KEY_COUNT_KEY], keys);
    assert.equal(normalizePreviewSettings(stored).maniaKeyCount, keys);
  }
});

test('a key count picked in one window reaches the others, and clearing it is auto again', () => {
  const current = normalizePreviewSettings({ maniaScrollSpeed: 20 });
  assert.ok(hasPreviewSettingChange({ [MANIA_KEY_COUNT_KEY]: { newValue: 4 } }));

  const changed = applyPreviewSettingChanges(current, { [MANIA_KEY_COUNT_KEY]: { oldValue: 'auto', newValue: 7 } });
  assert.equal(changed.maniaKeyCount, 7);
  assert.equal(changed.maniaScrollSpeed, 20);

  const cleared = applyPreviewSettingChanges(changed, { [MANIA_KEY_COUNT_KEY]: { oldValue: 7 } });
  assert.equal(cleared.maniaKeyCount, 'auto');
});

test('the key count is picked in the preview only, and an options save leaves it alone', () => {
  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  assert.ok(!/maniaKeyCount/.test(html), 'the options page has no key count control');
  assert.ok(PREVIEW_ONLY_SETTING_KEYS.includes(MANIA_KEY_COUNT_KEY));

  // What the options page saves: its form, which has no key count, minus the
  // preview-only keys. The 4K picked in the preview must not come back as auto.
  const stored = toPreviewSettingsStorage({ maniaKeyCount: 4 });
  const formSave = toPreviewSettingsStorage({ ...normalizePreviewSettings(stored), maniaKeyCount: undefined });
  for (const key of PREVIEW_ONLY_SETTING_KEYS) {
    delete formSave[key];
  }
  const after = normalizePreviewSettings({ ...stored, ...formSave });
  assert.equal(after.maniaKeyCount, 4);

  const optionsSource = readFileSync(new URL('../src/options.js', import.meta.url), 'utf8');
  assert.match(optionsSource, /PREVIEW_ONLY_SETTING_KEYS/, 'the options page drops them from its saves');
});

test('autoplay is on by default, and reads like every other toggle', () => {
  assert.equal(DEFAULT_AUTOPLAY, true);
  assert.equal(normalizePreviewSettings().autoplay, true);
  assert.ok(PREVIEW_SETTING_KEYS.includes(AUTOPLAY_KEY));

  // Storage holds real booleans, but older builds and hand-edited sync data
  // have written the string and numeric spellings too -- and a stored 'false'
  // read as true is exactly the bug that Boolean(value) caused elsewhere.
  assert.equal(normalizeAutoplay(false), false);
  assert.equal(normalizeAutoplay('false'), false);
  assert.equal(normalizeAutoplay(0), false);
  assert.equal(normalizeAutoplay('0'), false);
  assert.equal(normalizeAutoplay(true), true);
  assert.equal(normalizeAutoplay('true'), true);
  assert.equal(normalizeAutoplay(1), true);
  assert.equal(normalizeAutoplay(undefined), true);
  assert.equal(normalizeAutoplay(null), true);
});

test('autoplay survives storage and reaches an open preview', () => {
  const stored = toPreviewSettingsStorage({ autoplay: false });
  assert.equal(stored[AUTOPLAY_KEY], false);
  assert.equal(normalizePreviewSettings(stored).autoplay, false);

  const current = normalizePreviewSettings({ autoplay: false, maniaScrollSpeed: 20 });
  const changed = applyPreviewSettingChanges(current, {
    [AUTOPLAY_KEY]: { oldValue: false, newValue: true },
  });
  assert.equal(changed.autoplay, true);
  assert.equal(changed.maniaScrollSpeed, 20);

  // Removing the key falls back to the default rather than keeping the old value.
  const cleared = applyPreviewSettingChanges(current, { [AUTOPLAY_KEY]: { oldValue: false } });
  assert.equal(cleared.autoplay, DEFAULT_AUTOPLAY);
});

test('the options page controls autoplay, the music volume, the cache and a reset', () => {
  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');

  for (const id of ['autoplay', 'audioVolume', 'cacheUsageValue', 'cacheClearBtn', 'resetDefaultsBtn']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is on the options page`);
  }

  // Restoring defaults has to write what the normalizer calls a default, not a
  // second copy of the list that can drift from it.
  const optionsSource = readFileSync(new URL('../src/options.js', import.meta.url), 'utf8');
  assert.match(optionsSource, /normalizePreviewSettings\(\)/);
});

test('a remapped shortcut survives storage and reaches the other window', () => {
  const { bindings } = assignKeybinding(defaultKeybindings(), 'mute', 'x');
  const stored = toPreviewSettingsStorage({ keybindings: bindings });

  // Sparse on the way out, whole on the way back.
  assert.deepEqual(stored[KEYBINDINGS_KEY], { mute: ['x'] });
  assert.deepEqual(normalizePreviewSettings(stored).keybindings, bindings);
  assert.ok(PREVIEW_SETTING_KEYS.includes(KEYBINDINGS_KEY));
  assert.ok(hasPreviewSettingChange({ [KEYBINDINGS_KEY]: { newValue: {} } }));

  const changed = applyPreviewSettingChanges(
    normalizePreviewSettings(),
    { [KEYBINDINGS_KEY]: { newValue: { mute: ['x'] } } },
  );
  assert.deepEqual(changed.keybindings.mute, ['x']);
});

test('saving the options form leaves a remapped shortcut alone', () => {
  // The page writes its whole form on every save and has no keymap control, so
  // without this the first options change would put every key back.
  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  assert.ok(!/keybinding/i.test(html), 'the options page has no keymap control');
  assert.ok(PREVIEW_ONLY_SETTING_KEYS.includes(KEYBINDINGS_KEY));

  const { bindings } = assignKeybinding(defaultKeybindings(), 'mute', 'x');
  const stored = toPreviewSettingsStorage({ keybindings: bindings });
  const formSave = toPreviewSettingsStorage(normalizePreviewSettings({ hitsounds: true }));
  for (const key of PREVIEW_ONLY_SETTING_KEYS) {
    delete formSave[key];
  }

  const after = normalizePreviewSettings({ ...stored, ...formSave });
  assert.deepEqual(after.keybindings.mute, ['x']);
  assert.equal(after.hitsounds, true);
});

test('in-page miniplayer is off by default, experimental in options, and syncs through storage', () => {
  assert.equal(DEFAULT_EMBEDDED_PLAYER, false);
  assert.equal(normalizePreviewSettings().embeddedPlayer, false);
  assert.ok(PREVIEW_SETTING_KEYS.includes(EMBEDDED_PLAYER_KEY));

  assert.equal(normalizeEmbeddedPlayer(true), true);
  assert.equal(normalizeEmbeddedPlayer('true'), true);
  assert.equal(normalizeEmbeddedPlayer(1), true);
  assert.equal(normalizeEmbeddedPlayer('false'), false);
  assert.equal(normalizeEmbeddedPlayer(undefined), false);

  const stored = toPreviewSettingsStorage({ embeddedPlayer: true });
  assert.equal(stored[EMBEDDED_PLAYER_KEY], true);
  assert.equal(normalizePreviewSettings(stored).embeddedPlayer, true);

  const changed = applyPreviewSettingChanges(
    normalizePreviewSettings(),
    { [EMBEDDED_PLAYER_KEY]: { oldValue: false, newValue: true } },
  );
  assert.equal(changed.embeddedPlayer, true);

  const cleared = applyPreviewSettingChanges(changed, { [EMBEDDED_PLAYER_KEY]: { oldValue: true } });
  assert.equal(cleared.embeddedPlayer, false);

  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  assert.match(html, /id="embeddedPlayer"/);
  const audioIdx = html.indexOf('>audio<');
  const expIdx = html.indexOf('>experimental<');
  const embeddedIdx = html.indexOf('id="embeddedPlayer"');
  const hitsoundsIdx = html.indexOf('id="hitsounds"');
  const cacheIdx = html.indexOf('>cache<');
  const resetIdx = html.indexOf('>reset<');
  assert.ok(audioIdx > 0 && expIdx > audioIdx, 'experimental section sits below audio');
  assert.ok(embeddedIdx > expIdx && hitsoundsIdx > expIdx, 'experimental controls live inside the experimental section');
  assert.ok(cacheIdx > hitsoundsIdx && resetIdx > cacheIdx, 'cache and reset stay below experimental');
});
