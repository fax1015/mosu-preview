import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
