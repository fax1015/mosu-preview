// The difficulties of a mapset, read from its osu.ppy.sh page.
//
// The page embeds the set as JSON (`<script id="json-beatmapset">`) for guests
// too, with every difficulty's star rating, and the star ratings of the
// osu!standard difficulties converted to each other ruleset. That is the list
// the site itself offers under each ruleset's tab, so it is the list offered
// here: a ruleset's own difficulties, plus, for taiko, catch and mania, the
// converts of the standard ones.
//
// Pure: no fetch, no DOM, so it can be tested on a saved page.

const MODE_IDS = Object.freeze({ osu: 0, taiko: 1, fruits: 2, mania: 3 });

// Linear-time extractor for `<script id="json-beatmapset">...</script>` that
// avoids polynomial regex backtracking and skips HTML comments.
const extractBeatmapsetScriptJson = (html) => {
  const lower = html.toLowerCase();
  let cursor = 0;
  while (cursor < html.length) {
    const commentStart = lower.indexOf('<!--', cursor);
    const scriptStart = lower.indexOf('<script', cursor);
    if (scriptStart === -1) {
      return null;
    }
    if (commentStart !== -1 && commentStart < scriptStart) {
      const commentEnd = lower.indexOf('-->', commentStart + 4);
      if (commentEnd === -1) {
        return null;
      }
      cursor = commentEnd + 3;
      continue;
    }

    // Find end of opening `<script ...>` tag while respecting quoted attributes.
    let tagEnd = scriptStart + 7;
    let quote = '';
    while (tagEnd < html.length) {
      const ch = html[tagEnd];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      tagEnd += 1;
    }
    if (tagEnd >= html.length) {
      return null;
    }

    const attrs = html.slice(scriptStart + 7, tagEnd);
    const closeTag = lower.indexOf('</script', tagEnd + 1);
    if (closeTag === -1) {
      return null;
    }
    const closeEnd = html.indexOf('>', closeTag + 8);
    if (closeEnd === -1) {
      return null;
    }

    if (/(?:^|\s)id\s*=\s*(?:"json-beatmapset"|'json-beatmapset'|json-beatmapset(?:\s|$))/i.test(attrs)) {
      return html.slice(tagEnd + 1, closeTag);
    }
    cursor = closeEnd + 1;
  }
  return null;
};

const toModeId = (entry) => {
  if (Number.isInteger(entry?.mode_int) && entry.mode_int >= 0 && entry.mode_int <= 3) {
    return entry.mode_int;
  }
  return Object.hasOwn(MODE_IDS, entry?.mode) ? MODE_IDS[entry.mode] : -1;
};

const toId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
};

const toStars = (value) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  const stars = Number(value);
  return Number.isFinite(stars) && stars >= 0 ? stars : null;
};

const toEntry = (raw, { convert }) => {
  const id = toId(raw?.id);
  const mode = toModeId(raw);
  if (!id || mode < 0 || raw?.deleted_at) {
    return null;
  }
  return {
    beatmapId: id,
    mode,
    version: String(raw?.version ?? '').trim(),
    stars: toStars(raw?.difficulty_rating),
    convert: Boolean(convert),
  };
};

/**
 * @returns {{ setId: string|null, difficulties: Array<{ beatmapId: string, mode: number,
 *   version: string, stars: number|null, convert: boolean }> } | null}
 *   null when the page carries no readable set.
 */
const parseBeatmapsetPage = (html) => {
  if (typeof html !== 'string') {
    return null;
  }
  const jsonText = extractBeatmapsetScriptJson(html);
  if (!jsonText) {
    return null;
  }

  let set;
  try {
    set = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!set || !Array.isArray(set.beatmaps)) {
    return null;
  }

  const natives = set.beatmaps.map((raw) => toEntry(raw, { convert: false })).filter(Boolean);
  // osu-web names a mania convert after the key count it works out, "[7K] Hard".
  // The preview converts at a count of its own choosing, so the convert keeps
  // the difficulty's own name.
  const nativeNames = new Map(natives.map((entry) => [entry.beatmapId, entry.version]));
  const converts = (Array.isArray(set.converts) ? set.converts : [])
    .map((raw) => toEntry(raw, { convert: true }))
    .filter((entry) => entry && entry.mode !== 0 && nativeNames.has(entry.beatmapId))
    .map((entry) => ({ ...entry, version: nativeNames.get(entry.beatmapId) || entry.version }));

  return {
    setId: toId(set.id),
    difficulties: [...natives, ...converts],
  };
};

const compareByStars = (a, b) => {
  const starsA = a.stars ?? Number.POSITIVE_INFINITY;
  const starsB = b.stars ?? Number.POSITIVE_INFINITY;
  if (starsA !== starsB) {
    return starsA - starsB;
  }
  return a.version.localeCompare(b.version);
};

/**
 * What can be shown next to a map in `mode`: that ruleset's own difficulties
 * and, outside osu!standard, the standard ones converted to it. Easiest first,
 * as the site lists them; a ruleset's own difficulty wins over a convert with
 * the same id, which cannot normally happen.
 */
const listDifficultiesForRuleset = (difficulties, mode) => {
  if (!Array.isArray(difficulties) || !Number.isInteger(mode)) {
    return [];
  }
  const byId = new Map();
  for (const entry of difficulties) {
    if (entry?.mode !== mode) {
      continue;
    }
    const existing = byId.get(entry.beatmapId);
    if (!existing || (existing.convert && !entry.convert)) {
      byId.set(entry.beatmapId, entry);
    }
  }
  return [...byId.values()].sort(compareByStars);
};

const formatStars = (stars) => (Number.isFinite(stars) ? stars.toFixed(2) : '');

export {
  parseBeatmapsetPage, listDifficultiesForRuleset, formatStars,
};

// osu-web's difficulty spectrum (its getDiffColour), interpolated the same way:
// in RGB with a 2.2 gamma, clamped at both ends.
const STAR_SPECTRUM = Object.freeze([
  [0.1, [0x42, 0x90, 0xfb]],
  [1.25, [0x4f, 0xc0, 0xff]],
  [2, [0x4f, 0xff, 0xd5]],
  [2.5, [0x7c, 0xff, 0x4f]],
  [3.3, [0xf6, 0xf0, 0x5c]],
  [4.2, [0xff, 0x80, 0x68]],
  [4.9, [0xff, 0x4e, 0x6f]],
  [5.8, [0xc6, 0x45, 0xb8]],
  [6.7, [0x65, 0x63, 0xde]],
  [7.7, [0x18, 0x15, 0x8e]],
  [9, [0x00, 0x00, 0x00]],
]);
const STAR_GAMMA = 2.2;

const toHex = (channels) => `#${channels.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;

const getStarRatingColour = (stars) => {
  const rating = Number(stars);
  if (!Number.isFinite(rating) || rating < 0.1) {
    return '#aaaaaa';
  }
  if (rating >= STAR_SPECTRUM[STAR_SPECTRUM.length - 1][0]) {
    return toHex(STAR_SPECTRUM[STAR_SPECTRUM.length - 1][1]);
  }
  for (let i = 1; i < STAR_SPECTRUM.length; i += 1) {
    const [upper, to] = STAR_SPECTRUM[i];
    if (rating <= upper) {
      const [lower, from] = STAR_SPECTRUM[i - 1];
      const t = (rating - lower) / (upper - lower);
      return toHex(from.map((a, channel) => {
        const b = to[channel];
        const mixed = ((a ** STAR_GAMMA) * (1 - t)) + ((b ** STAR_GAMMA) * t);
        return mixed ** (1 / STAR_GAMMA);
      }));
    }
  }
  return '#aaaaaa';
};

// Dark text on the light end, osu!'s pale gold on the dark end, as the site does.
const getStarRatingTextColour = (stars) => (Number(stars) >= 6.5 ? '#ffd966' : 'rgba(0, 0, 0, 0.82)');

export { getStarRatingColour, getStarRatingTextColour };
