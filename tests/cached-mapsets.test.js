import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCachedMapsetEntries, normalizeCachedSetId } from '../src/core/cachedMapsets.js';

test('normalizes cached mapset ids to safe numeric strings', () => {
  assert.equal(normalizeCachedSetId(12345), '12345');
  assert.equal(normalizeCachedSetId(' 67890 '), '67890');
  assert.equal(normalizeCachedSetId('123abc'), '');
  assert.equal(normalizeCachedSetId(''), '');
});

test('cached mapsets show one entry per set even when multiple difficulties were previewed', () => {
  const entries = buildCachedMapsetEntries(new Set(['100', '100', '200']), [
    {
      beatmapSetId: '100',
      beatmapId: '1001',
      title: 'First difficulty',
    },
    {
      beatmapSetId: '100',
      beatmapId: '1002',
      title: 'Second difficulty',
    },
    {
      beatmapSetId: '200',
      beatmapId: '2001',
      title: 'Other set',
    },
  ]);

  assert.deepEqual(entries, [
    {
      beatmapSetId: '200',
      beatmapId: '2001',
      title: 'Other set',
    },
    {
      beatmapSetId: '100',
      beatmapId: '1001',
      title: 'First difficulty',
    },
  ]);
});
