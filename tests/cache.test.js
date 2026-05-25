import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getFullAudioCacheKeyCandidates,
  getFullAudioCacheAliasEntries,
  getPrimaryFullAudioCacheKey,
  compactFullAudioAliasesForCacheKeys,
  normalizePath,
  removeFullAudioAliasesForCacheKeys,
} from '../src/audio/cache.js';

test('normalizes backslashes in audio paths', () => {
  assert.equal(normalizePath('audio\\song.mp3'), 'audio/song.mp3');
});

test('cache key candidates include path and basename', () => {
  const candidates = getFullAudioCacheKeyCandidates('123', 'Audio/Song.MP3');

  assert.deepEqual(candidates, [
    'https://osu.ppy.sh/beatmapsets/123/audio/audio%2Fsong.mp3',
    'https://osu.ppy.sh/beatmapsets/123/audio/song.mp3',
  ]);
});

test('primary cache key only stores the canonical requested path', () => {
  assert.equal(
    getPrimaryFullAudioCacheKey('123', 'Audio/Song.MP3'),
    'https://osu.ppy.sh/beatmapsets/123/audio/audio%2Fsong.mp3',
  );
});

test('cache aliases point basename lookups to the canonical path key', () => {
  assert.deepEqual(getFullAudioCacheAliasEntries('123', 'Audio/Song.MP3'), [
    [
      'https://osu.ppy.sh/beatmapsets/123/audio/song.mp3',
      'https://osu.ppy.sh/beatmapsets/123/audio/audio%2Fsong.mp3',
    ],
  ]);
});

test('invalid cache inputs return no key candidates', () => {
  assert.deepEqual(getFullAudioCacheKeyCandidates('', 'song.mp3'), []);
  assert.deepEqual(getFullAudioCacheKeyCandidates('123', ''), []);
  assert.equal(getPrimaryFullAudioCacheKey('', 'song.mp3'), '');
});

test('cache aliases are removed when their alias or canonical key is deleted', () => {
  const alias = 'https://osu.ppy.sh/beatmapsets/123/audio/song.mp3';
  const primary = 'https://osu.ppy.sh/beatmapsets/123/audio/audio%2Fsong.mp3';
  const keptAlias = 'https://osu.ppy.sh/beatmapsets/456/audio/song.mp3';
  const keptPrimary = 'https://osu.ppy.sh/beatmapsets/456/audio/audio%2Fsong.mp3';

  assert.deepEqual(
    removeFullAudioAliasesForCacheKeys(
      {
        [alias]: primary,
        [keptAlias]: keptPrimary,
      },
      new Set([primary]),
    ),
    {
      [keptAlias]: keptPrimary,
    },
  );
});

test('cache aliases compact to live cache keys only', () => {
  const alias = 'https://osu.ppy.sh/beatmapsets/123/audio/song.mp3';
  const primary = 'https://osu.ppy.sh/beatmapsets/123/audio/audio%2Fsong.mp3';
  const staleAlias = 'https://osu.ppy.sh/beatmapsets/456/audio/song.mp3';
  const stalePrimary = 'https://osu.ppy.sh/beatmapsets/456/audio/audio%2Fsong.mp3';

  assert.deepEqual(
    compactFullAudioAliasesForCacheKeys(
      {
        [alias]: primary,
        [staleAlias]: stalePrimary,
      },
      new Set([primary]),
    ),
    {
      [alias]: primary,
    },
  );
});
