// Ruleset names as osu.ppy.sh spells them in URLs, indexed by mode number.
const MODE_URL_NAMES = Object.freeze(['osu', 'taiko', 'fruits', 'mania']);

/** A beatmap or beatmapset id: digits only, as a string, or '' when it is not one. */
const normalizeNumericId = (value) => {
  const candidate = String(value ?? '').trim();
  return /^\d+$/.test(candidate) ? candidate : '';
};

/**
 * A ruleset from a URL fragment, a query parameter or a stored mode: its URL
 * name, 'catch', or the number 0-3 (as a number or a string). Null otherwise.
 * The URL parser, the detached window and the converters each used to keep a
 * copy of this, with different spellings of catch.
 */
const parseModeToken = (token) => {
  const normalized = String(token ?? '').trim().toLowerCase();
  if (normalized === 'catch') {
    return 2;
  }

  if (MODE_URL_NAMES.includes(normalized)) {
    return MODE_URL_NAMES.indexOf(normalized);
  }

  if (/^\d+$/.test(normalized)) {
    const numeric = Number.parseInt(normalized, 10);
    return numeric >= 0 && numeric <= 3 ? numeric : null;
  }

  return null;
};

const getRequestedMode = (url) => {
  const queryMode = url.searchParams.get('mode') ?? url.searchParams.get('m');
  if (queryMode !== null) {
    const parsed = parseModeToken(queryMode);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
};

const extractBeatmapInfoFromUrl = (rawUrl) => {
  const candidate = String(rawUrl ?? '').trim();
  if (!candidate) {
    // No URL at all: a page the browser will not let an extension read, such
    // as the new tab page, a chrome:// page or another extension's. There is
    // nothing to preview there, which is an unsupported page, not a failure.
    return { valid: false, reason: 'unsupported website :(', unsupportedSite: true };
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { valid: false, reason: 'Active tab URL is not valid.' };
  }

  if (url.protocol !== 'https:' || !/^osu\.ppy\.sh$/i.test(url.hostname)) {
    return {
      valid: false,
      reason: 'unsupported website :(',
      unsupportedSite: true,
    };
  }

  const beatmapMatch = url.pathname.match(/^\/beatmaps\/(\d+)/i);
  if (beatmapMatch) {
    return {
      valid: true,
      beatmapId: beatmapMatch[1],
      setId: null,
      mode: getRequestedMode(url),
      sourceUrl: url.toString(),
    };
  }

  const beatmapSetMatch = url.pathname.match(/^\/beatmapsets\/(\d+)/i);
  if (!beatmapSetMatch) {
    return { valid: false, reason: 'Open a beatmap URL like /beatmapsets/... or /beatmaps/....' };
  }

  const hash = (url.hash || '').replace(/^#/, '');
  const hashBeatmapMatch = hash.match(/(osu|taiko|fruits|catch|mania)\/(\d+)/i);
  if (hashBeatmapMatch) {
    return {
      valid: true,
      beatmapId: hashBeatmapMatch[2],
      setId: beatmapSetMatch[1],
      mode: parseModeToken(hashBeatmapMatch[1]),
      sourceUrl: url.toString(),
    };
  }

  // Discussion pages embed the beatmap id in the path:
  // /beatmapsets/<setId>/discussion/<beatmapId>/...
  const discussionMatch = url.pathname.match(
    /\/beatmapsets\/\d+\/discussion\/(\d+)/i,
  );
  if (discussionMatch) {
    return {
      valid: true,
      beatmapId: discussionMatch[1],
      setId: beatmapSetMatch[1],
      mode: getRequestedMode(url),
      sourceUrl: url.toString(),
    };
  }

  const queryBeatmapId = url.searchParams.get('b');
  if (queryBeatmapId && /^\d+$/.test(queryBeatmapId)) {
    return {
      valid: true,
      beatmapId: queryBeatmapId,
      setId: beatmapSetMatch[1],
      mode: getRequestedMode(url),
      sourceUrl: url.toString(),
    };
  }

  // A set page with no difficulty in it: what a search result, a forum link or
  // the modding queue opens, and what the site itself shows a default
  // difficulty for. The set id is handed back so a caller that can read the
  // set's difficulty list resolves one rather than giving up; a caller that
  // cannot still sees an invalid URL.
  return {
    valid: false,
    reason: 'Beatmap set page found, but no beatmap difficulty ID in the URL hash.',
    needsDifficulty: true,
    setId: beatmapSetMatch[1],
    mode: getRequestedMode(url),
    sourceUrl: url.toString(),
  };
};

export {
  MODE_URL_NAMES,
  extractBeatmapInfoFromUrl,
  normalizeNumericId,
  parseModeToken,
};
