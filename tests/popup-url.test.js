import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBeatmapInfoFromUrl, normalizeNumericId, parseModeToken } from '../src/core/beatmapUrl.js';

test('parses direct beatmap URLs', () => {
  assert.deepEqual(
    extractBeatmapInfoFromUrl('https://osu.ppy.sh/beatmaps/456'),
    {
      valid: true,
      beatmapId: '456',
      setId: null,
      mode: null,
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
      mode: 3,
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
      mode: null,
      sourceUrl: 'https://osu.ppy.sh/beatmapsets/123?b=456',
    },
  );
});

test('parses target mode query parameters', () => {
  assert.deepEqual(
    extractBeatmapInfoFromUrl('https://osu.ppy.sh/beatmaps/456?mode=taiko'),
    {
      valid: true,
      beatmapId: '456',
      setId: null,
      mode: 1,
      sourceUrl: 'https://osu.ppy.sh/beatmaps/456?mode=taiko',
    },
  );
});

test('marks non-osu URLs as unsupported', () => {
  const result = extractBeatmapInfoFromUrl('https://example.com/beatmapsets/123#osu/456');

  assert.equal(result.valid, false);
  assert.equal(result.unsupportedSite, true);
});

test('one mode parser accepts every spelling the extension meets', () => {
  // URL names, the alias osu! uses for catch, and stored mode numbers -- the
  // three copies this replaced disagreed on catch and on a numeric 0.
  assert.equal(parseModeToken('osu'), 0);
  assert.equal(parseModeToken('fruits'), 2);
  assert.equal(parseModeToken('catch'), 2);
  assert.equal(parseModeToken('Mania'), 3);
  assert.equal(parseModeToken(0), 0);
  assert.equal(parseModeToken('1'), 1);
  assert.equal(parseModeToken(4), null);
  assert.equal(parseModeToken(''), null);
  assert.equal(parseModeToken(undefined), null);
});

test('ids are digits only', () => {
  assert.equal(normalizeNumericId(' 123 '), '123');
  assert.equal(normalizeNumericId(456), '456');
  assert.equal(normalizeNumericId('12a'), '');
  assert.equal(normalizeNumericId(null), '');
});
