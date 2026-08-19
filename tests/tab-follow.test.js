import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameFollowTarget, pickBeatmapTabInfo, toFollowTarget } from '../src/core/tabFollow.js';
import { extractBeatmapInfoFromUrl } from '../src/core/beatmapUrl.js';

const tab = (windowId, url) => ({ windowId, url });
const targetFor = (url) => toFollowTarget(extractBeatmapInfoFromUrl(url));

test('non-beatmap tabs are ignored', () => {
  assert.equal(pickBeatmapTabInfo([
    tab(1, 'https://example.com/'),
    tab(1, 'https://osu.ppy.sh/rankings'),
  ]), null);

  // Tabs the extension has no host access to arrive without a url at all.
  assert.equal(pickBeatmapTabInfo([{ windowId: 1 }]), null);
  assert.equal(pickBeatmapTabInfo([]), null);
  assert.equal(pickBeatmapTabInfo(undefined), null);
});

test('the last focused browsing window wins over listing order', () => {
  const picked = pickBeatmapTabInfo([
    tab(1, 'https://osu.ppy.sh/beatmapsets/1#osu/11'),
    tab(2, 'https://osu.ppy.sh/beatmapsets/2#osu/22'),
  ], { preferredWindowId: 2 });

  assert.equal(picked.info.beatmapId, '22');
});

test('the detached window never mirrors itself', () => {
  const picked = pickBeatmapTabInfo([
    tab(9, 'https://osu.ppy.sh/beatmapsets/1#osu/11'),
    tab(3, 'https://osu.ppy.sh/beatmapsets/2#osu/22'),
  ], { excludeWindowId: 9 });

  assert.equal(picked.info.beatmapId, '22');
});

test('switching difficulty is seen as a new target', () => {
  const current = targetFor('https://osu.ppy.sh/beatmapsets/1#osu/11');
  const next = targetFor('https://osu.ppy.sh/beatmapsets/1#osu/22');

  assert.equal(isSameFollowTarget(current, next), false);
});

test('the same map with an explicit converted ruleset is a new target', () => {
  const standard = targetFor('https://osu.ppy.sh/beatmapsets/1#osu/11');
  const taiko = targetFor('https://osu.ppy.sh/beatmapsets/1#taiko/11');

  assert.equal(isSameFollowTarget(standard, taiko), false);
});

test('an unspecified mode does not count as a change', () => {
  // Detaching resolves the ruleset, so the loaded target can carry a mode the
  // followed URL never named. Treating that as a change would reload the map
  // already on screen on every single check.
  const resolved = { beatmapId: '11', mode: 0 };
  const fromPlainUrl = targetFor('https://osu.ppy.sh/beatmaps/11');

  assert.equal(fromPlainUrl.mode, null);
  assert.equal(isSameFollowTarget(resolved, fromPlainUrl), true);
  assert.equal(isSameFollowTarget(fromPlainUrl, resolved), true);
});

test('a first load with nothing loaded yet always counts as a change', () => {
  assert.equal(isSameFollowTarget(null, targetFor('https://osu.ppy.sh/beatmaps/11')), false);
  assert.equal(toFollowTarget({ valid: false }), null);
});
