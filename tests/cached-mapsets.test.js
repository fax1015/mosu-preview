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

test('a name stored with the cache entry survives falling out of history', () => {
  // The bug this guards: history keeps 20 sets while the audio cache holds
  // several times that, so anything older showed as "Beatmap set #id".
  const entries = buildCachedMapsetEntries(
    [{ setId: '2604496', title: 'Freedom Dive', artist: 'xi', creator: 'Nakagawa-Kanon' }],
    [],
  );

  assert.deepEqual(entries, [{
    beatmapSetId: '2604496',
    title: 'Freedom Dive',
    artist: 'xi',
    creator: 'Nakagawa-Kanon',
  }]);
});

test('history still names entries cached before names were stored', () => {
  const entries = buildCachedMapsetEntries(
    [{ setId: '100' }],
    [{ beatmapSetId: '100', beatmapId: '1001', title: 'From history' }],
  );

  assert.equal(entries[0].title, 'From history');
});

test('the cached name wins over a stale history entry for the same set', () => {
  const entries = buildCachedMapsetEntries(
    [{ setId: '100', title: 'From cache', artist: 'Cached artist' }],
    [{ beatmapSetId: '100', title: 'From history', artist: 'History artist' }],
  );

  assert.equal(entries[0].title, 'From cache');
  assert.equal(entries[0].artist, 'Cached artist');
});

test('a named record supersedes a bare duplicate of the same set', () => {
  const entries = buildCachedMapsetEntries(
    [{ setId: '100' }, { setId: '100', title: 'Named' }],
    [],
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'Named');
});

test('records with an unusable set id are dropped', () => {
  assert.deepEqual(buildCachedMapsetEntries([{ setId: 'nope' }, { title: 'orphan' }], []), []);
});
