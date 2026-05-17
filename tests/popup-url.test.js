import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBeatmapInfoFromUrl } from '../src/core/beatmapUrl.js';

test('parses direct beatmap URLs', () => {
  assert.deepEqual(
    extractBeatmapInfoFromUrl('https://osu.ppy.sh/beatmaps/456'),
    {
      valid: true,
      beatmapId: '456',
      setId: null,
      sourceUrl: 'https://osu.ppy.sh/beatmaps/456',
    },
  );
});

test('parses beatmapset hash URLs', () => {
  assert.deepEqual(
    extractBeatmapInfoFromUrl('https://osu.ppy.sh/beatmapsets/123#mania/456'),
    {
      valid: true,
      beatmapId: '456',
      setId: '123',
      sourceUrl: 'https://osu.ppy.sh/beatmapsets/123#mania/456',
    },
  );
});

test('parses beatmapset query difficulty URLs', () => {
  assert.deepEqual(
    extractBeatmapInfoFromUrl('https://osu.ppy.sh/beatmapsets/123?b=456'),
    {
      valid: true,
      beatmapId: '456',
      setId: '123',
      sourceUrl: 'https://osu.ppy.sh/beatmapsets/123?b=456',
    },
  );
});

test('marks non-osu URLs as unsupported', () => {
  const result = extractBeatmapInfoFromUrl('https://example.com/beatmapsets/123#osu/456');

  assert.equal(result.valid, false);
  assert.equal(result.unsupportedSite, true);
});
