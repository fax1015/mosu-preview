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

test('a tab whose URL the browser withholds reads as unsupported', () => {
  // The new tab page, chrome:// pages and other extensions' pages hand the
  // popup no URL at all. That is a page with nothing to preview, so it gets
  // the unsupported view rather than the failed-load one.
  for (const url of ['', null, undefined, '   ']) {
    const result = extractBeatmapInfoFromUrl(url);
    assert.equal(result.valid, false);
    assert.equal(result.unsupportedSite, true);
  }
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

test('a set URL with no difficulty hands back the set so one can be resolved', () => {
  // What a search result, a forum link or the modding queue opens. The URL on
  // its own is still not previewable, but the set id is enough to look up the
  // difficulty the site itself would show.
  const result = extractBeatmapInfoFromUrl('https://osu.ppy.sh/beatmapsets/123');

  assert.equal(result.valid, false);
  assert.equal(result.needsDifficulty, true);
  assert.equal(result.setId, '123');
  assert.equal(result.mode, null);
  assert.equal(result.sourceUrl, 'https://osu.ppy.sh/beatmapsets/123');
});

test('a set URL keeps the ruleset it asked for', () => {
  assert.equal(
    extractBeatmapInfoFromUrl('https://osu.ppy.sh/beatmapsets/123?mode=taiko').mode,
    1,
  );
});

test('a discussion URL resolves the beatmap id from the path', () => {
  const timeline = extractBeatmapInfoFromUrl(
    'https://osu.ppy.sh/beatmapsets/2393653/discussion/5555469/timeline/total',
  );
  assert.equal(timeline.valid, true);
  assert.equal(timeline.setId, '2393653');
  assert.equal(timeline.beatmapId, '5555469');

  const general = extractBeatmapInfoFromUrl(
    'https://osu.ppy.sh/beatmapsets/123/discussion/456/general',
  );
  assert.equal(general.valid, true);
  assert.equal(general.setId, '123');
  assert.equal(general.beatmapId, '456');
});

test('a page that is not a set asks for nothing to be resolved', () => {
  const result = extractBeatmapInfoFromUrl('https://osu.ppy.sh/users/2');

  assert.equal(result.valid, false);
  assert.equal(result.needsDifficulty, undefined);
});
