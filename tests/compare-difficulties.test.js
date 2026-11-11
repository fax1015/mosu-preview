import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBeatmapsetPage,
  listDifficultiesForRuleset,
  formatStars,
  getStarRatingColour,
  getStarRatingTextColour,
} from '../src/core/beatmapsetPage.js';
import { MAX_PREVIEW_PANELS, PANEL_ASPECT, choosePanelGrid } from '../src/core/panelLayout.js';
import { resolveCompareIds } from '../src/ui/comparePanels.js';

// Shaped like osu-web's set page for FREEDOM DiVE (set 39804), cut down to the
// fields that matter.
const SET = {
  id: 39804,
  title: 'FREEDOM DiVE',
  beatmaps: [
    { id: 126645, version: 'Another', mode: 'osu', mode_int: 0, difficulty_rating: 7.01799, deleted_at: null },
    { id: 129891, version: 'FOUR DIMENSIONS', mode: 'osu', mode_int: 0, difficulty_rating: 7.80579, deleted_at: null },
    { id: 132914, version: "Hayashi's Taiko Oni", mode: 'taiko', mode_int: 1, difficulty_rating: 5.95673, deleted_at: null },
    { id: 161275, version: "Ono's Taiko Oni", mode: 'taiko', mode_int: 1, difficulty_rating: 4.74396, deleted_at: null },
    { id: 999, version: 'Gone', mode: 'osu', mode_int: 0, difficulty_rating: 3, deleted_at: '2020-01-01T00:00:00Z' },
  ],
  converts: [
    { id: 126645, version: 'Another', mode: 'taiko', mode_int: 1, difficulty_rating: 4.90747, convert: true },
    { id: 129891, version: 'FOUR DIMENSIONS', mode: 'taiko', mode_int: 1, difficulty_rating: 5.6406, convert: true },
    { id: 126645, version: '[7K] Another', mode: 'mania', mode_int: 3, difficulty_rating: 3.70072, convert: true },
    { id: 129891, version: '[7K] FOUR DIMENSIONS', mode: 'mania', mode_int: 3, difficulty_rating: 3.77713, convert: true },
  ],
};

const page = (set) => `<!doctype html><html><body><div class="js-react--beatmapset-page"></div>
<script id="json-beatmapset" type="application/json">${JSON.stringify(set)}</script>
<script id="json-genres" type="application/json">[]</script></body></html>`;

test('reads every difficulty and convert from the set page', () => {
  const parsed = parseBeatmapsetPage(page(SET));
  assert.equal(parsed.setId, '39804');
  assert.equal(parsed.difficulties.filter((entry) => !entry.convert).length, 4, 'the deleted one is left out');
  assert.equal(parsed.difficulties.filter((entry) => entry.convert).length, 4);
  const fd = parsed.difficulties.find((entry) => entry.beatmapId === '129891' && entry.mode === 0);
  assert.deepEqual(fd, { beatmapId: '129891', mode: 0, version: 'FOUR DIMENSIONS', stars: 7.80579, convert: false });
});

test('a mania convert keeps its own name, not osu-web\'s key count prefix', () => {
  const parsed = parseBeatmapsetPage(page(SET));
  const mania = listDifficultiesForRuleset(parsed.difficulties, 3);
  assert.deepEqual(mania.map((entry) => entry.version), ['Another', 'FOUR DIMENSIONS']);
  assert.ok(mania.every((entry) => entry.convert));
});

test('each ruleset lists its own difficulties and, outside standard, the converts, easiest first', () => {
  const { difficulties } = parseBeatmapsetPage(page(SET));
  assert.deepEqual(listDifficultiesForRuleset(difficulties, 0).map((entry) => entry.beatmapId), ['126645', '129891']);
  assert.deepEqual(
    listDifficultiesForRuleset(difficulties, 1).map((entry) => [entry.version, entry.stars]),
    [
      ["Ono's Taiko Oni", 4.74396],
      ['Another', 4.90747],
      ['FOUR DIMENSIONS', 5.6406],
      ["Hayashi's Taiko Oni", 5.95673],
    ],
  );
  assert.deepEqual(listDifficultiesForRuleset(difficulties, 2), [], 'no catch difficulties or converts listed');
});

test('a page without the set, or with broken JSON, gives nothing rather than throwing', () => {
  assert.equal(parseBeatmapsetPage('<html><body>Just a moment...</body></html>'), null);
  assert.equal(parseBeatmapsetPage('<script id="json-beatmapset" type="application/json">{not json</script>'), null);
  assert.equal(parseBeatmapsetPage('<script id="json-beatmapset" type="application/json">{"id":1}</script>'), null);
  assert.equal(parseBeatmapsetPage(null), null);
});

test('stars are shown to two places, coloured on osu!\'s spectrum', () => {
  assert.equal(formatStars(7.80579), '7.81');
  assert.equal(formatStars(null), '');
  assert.equal(getStarRatingColour(0.05), '#aaaaaa');
  assert.equal(getStarRatingColour(0.1), '#4290fb');
  assert.equal(getStarRatingColour(3.3), '#f6f05c');
  assert.equal(getStarRatingColour(12), '#000000');
  // Between two stops it lands between them on every channel.
  const mid = getStarRatingColour(4.55);
  const channels = [1, 3, 5].map((i) => parseInt(mid.slice(i, i + 2), 16));
  assert.ok(channels[0] === 0xff && channels[1] < 0x80 && channels[1] > 0x4e, mid);
  assert.equal(getStarRatingTextColour(7), '#ffd966');
  assert.equal(getStarRatingTextColour(5), 'rgba(0, 0, 0, 0.82)');
});

const gridOf = (count, width, height) => {
  const { cols, rows } = choosePanelGrid(count, width, height, { gap: 2 });
  return `${cols}x${rows}`;
};

// The preview areas measured in Helium: the toolbar popup's, and a detached
// window's at its default size, tall and narrow, and wide and short. The
// popup's is 357 wide as measured, and as tall as the 4:3 preview makes that
// (it measured 276 when the preview was 1.29:1).
const AREAS = {
  popup: [357, 267],
  detachedDefault: [600, 585],
  tallNarrow: [380, 860],
  wideShort: [1400, 470],
};

test('in the popup\'s own area two sit side by side and three or four in a 2x2 grid', () => {
  const [w, h] = AREAS.popup;
  assert.equal(gridOf(2, w, h), '2x1');
  assert.equal(gridOf(3, w, h), '2x2');
  assert.equal(gridOf(4, w, h), '2x2');
  // An area the panels' own shape is a dead heat for two, and goes to side by
  // side whichever way the half pixel falls.
  for (const height of [299, 300, 301]) {
    assert.equal(`${choosePanelGrid(2, 400, height).cols}x${choosePanelGrid(2, 400, height).rows}`, '2x1', `400x${height}`);
  }
});

test('a squarish window uses a 2x2 grid once there are three', () => {
  const [w, h] = AREAS.detachedDefault;
  assert.equal(gridOf(2, w, h), '1x2');
  assert.equal(gridOf(3, w, h), '2x2');
  assert.equal(gridOf(4, w, h), '2x2');
});

test('a tall window stacks them, a wide one lines them up', () => {
  assert.equal(gridOf(2, ...AREAS.tallNarrow), '1x2');
  assert.equal(gridOf(3, ...AREAS.tallNarrow), '1x3');
  assert.equal(gridOf(4, ...AREAS.tallNarrow), '1x4');
  assert.equal(gridOf(2, ...AREAS.wideShort), '2x1');
  assert.equal(gridOf(3, ...AREAS.wideShort), '3x1');
  assert.equal(gridOf(4, ...AREAS.wideShort), '4x1');
});

test('whatever the shape, no other grid would give the panels more room', () => {
  for (const [name, [w, h]] of Object.entries(AREAS)) {
    for (let count = 2; count <= MAX_PREVIEW_PANELS; count += 1) {
      const chosen = choosePanelGrid(count, w, h, { gap: 2 });
      const fit = Math.min(chosen.cellWidth / PANEL_ASPECT, chosen.cellHeight);
      for (let cols = 1; cols <= count; cols += 1) {
        const rows = Math.ceil(count / cols);
        const other = Math.min(((w - (2 * (cols - 1))) / cols) / PANEL_ASPECT, (h - (2 * (rows - 1))) / rows);
        assert.ok(other <= fit + 0.5, `${name}, ${count} panels: ${cols} columns beat the choice`);
      }
    }
  }
});

test('at most four difficulties are shown at once', () => {
  assert.equal(MAX_PREVIEW_PANELS, 4);
  const lead = { setId: '1', mode: 0, beatmapId: 'a' };
  const ids = resolveCompareIds({
    lead,
    stored: { setId: '1', mode: 0, leadId: 'a', ids: ['a', 'b', 'c', 'd', 'e'] },
  });
  assert.deepEqual(ids, ['b', 'c', 'd']);
});

test('reopening on the same map brings the same panels back', () => {
  const lead = { setId: '39804', mode: 0, beatmapId: '129891' };
  assert.deepEqual(
    resolveCompareIds({ lead, stored: { setId: '39804', mode: 0, leadId: '129891', ids: ['129891', '126645'] } }),
    ['126645'],
  );
});

test('moving to a difficulty that was shown swaps it with the lead', () => {
  const lead = { setId: '39804', mode: 0, beatmapId: '126645' };
  assert.deepEqual(
    resolveCompareIds({ lead, live: { setId: '39804', mode: 0, leadId: '129891', ids: ['129891', '126645'] } }),
    ['129891'],
  );
});

test('moving to a difficulty that was not shown takes the old lead\'s place', () => {
  const lead = { setId: '1', mode: 1, beatmapId: 'c' };
  assert.deepEqual(
    resolveCompareIds({ lead, live: { setId: '1', mode: 1, leadId: 'a', ids: ['a', 'b'] } }),
    ['b'],
  );
});

test('another set or ruleset starts with no panels, whatever was remembered', () => {
  const remembered = { setId: '1', mode: 0, leadId: 'a', ids: ['a', 'b'] };
  assert.deepEqual(resolveCompareIds({ lead: { setId: '2', mode: 0, beatmapId: 'x' }, stored: remembered }), []);
  assert.deepEqual(resolveCompareIds({ lead: { setId: '1', mode: 1, beatmapId: 'a' }, stored: remembered }), []);
  assert.deepEqual(resolveCompareIds({ lead: { setId: '1', mode: 0, beatmapId: 'a' } }), []);
});

test('what is on screen wins over what was stored', () => {
  const lead = { setId: '1', mode: 0, beatmapId: 'a' };
  assert.deepEqual(
    resolveCompareIds({
      lead,
      live: { setId: '1', mode: 0, leadId: 'a', ids: ['a', 'c'] },
      stored: { setId: '1', mode: 0, leadId: 'a', ids: ['a', 'b'] },
    }),
    ['c'],
  );
});

