const normalizeCachedSetId = (value) => {
  const setId = String(value || '').trim();
  return /^\d+$/.test(setId) ? setId : '';
};

const normalizeInfoField = (value) => String(value ?? '').trim();

/**
 * Accepts either a bare set id or a record carrying the name stored alongside
 * the cached audio. Bare ids remain supported because entries written before
 * names were cached still come back that way.
 */
const toCachedMapsetRecord = (value) => {
  if (value && typeof value === 'object') {
    const setId = normalizeCachedSetId(value.setId ?? value.beatmapSetId);
    return setId
      ? {
        setId,
        title: normalizeInfoField(value.title),
        artist: normalizeInfoField(value.artist),
        creator: normalizeInfoField(value.creator),
      }
      : null;
  }

  const setId = normalizeCachedSetId(value);
  return setId ? { setId, title: '', artist: '', creator: '' } : null;
};

const hasAnyName = (record) => Boolean(record?.title || record?.artist || record?.creator);

const buildCachedMapsetEntries = (cachedMapsets, history = []) => {
  const recordsBySetId = new Map();
  for (const value of cachedMapsets || []) {
    const record = toCachedMapsetRecord(value);
    if (!record) {
      continue;
    }
    // A named record supersedes a bare duplicate of the same set.
    if (!recordsBySetId.has(record.setId) || (!hasAnyName(recordsBySetId.get(record.setId)) && hasAnyName(record))) {
      recordsBySetId.set(record.setId, record);
    }
  }

  const historyBySetId = new Map();
  for (const entry of history || []) {
    const setId = normalizeCachedSetId(entry?.beatmapSetId);
    if (setId && !historyBySetId.has(setId)) {
      historyBySetId.set(setId, entry);
    }
  }

  return [...recordsBySetId.values()]
    .sort((a, b) => Number(b.setId) - Number(a.setId))
    .map((record) => {
      // History still fills in entries cached before names were stored, but a
      // name travelling with the cache entry wins: history only remembers the 20
      // most recent previews, so it goes stale long before the audio does.
      const entry = {
        ...(historyBySetId.get(record.setId) || {}),
        beatmapSetId: record.setId,
      };
      if (record.title) entry.title = record.title;
      if (record.artist) entry.artist = record.artist;
      if (record.creator) entry.creator = record.creator;
      return entry;
    });
};

export { buildCachedMapsetEntries, normalizeCachedSetId, toCachedMapsetRecord };
