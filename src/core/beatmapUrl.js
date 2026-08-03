const MODE_NAMES = ['osu', 'taiko', 'fruits', 'mania'];

const parseModeToken = (token) => {
  const normalized = String(token || '').trim().toLowerCase();
  if (normalized === 'catch') {
    return 2;
  }

  if (MODE_NAMES.includes(normalized)) {
    return MODE_NAMES.indexOf(normalized);
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
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'Active tab URL is not valid.' };
  }

  if (!/^osu\.ppy\.sh$/i.test(url.hostname)) {
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

  return {
    valid: false,
    reason: 'Beatmap set page found, but no beatmap difficulty ID in the URL hash.',
  };
};

export { extractBeatmapInfoFromUrl };
