import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_SETTING_KEYS,
  DEFAULT_DISABLED_PROVIDERS,
  applyPreviewSettingChanges,
  hasPreviewSettingChange,
  normalizeAutoFallback,
  normalizeDisabledProviders,
  normalizePreviewSettings,
  toPreviewSettingsStorage,
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
