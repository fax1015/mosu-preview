import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_SETTING_KEYS,
  DEFAULT_DISABLED_PROVIDERS,
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
