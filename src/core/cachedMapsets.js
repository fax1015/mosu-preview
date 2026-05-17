const normalizeCachedSetId = (value) => {
  const setId = String(value || '').trim();
  return /^\d+$/.test(setId) ? setId : '';
};

const buildCachedMapsetEntries = (cachedSetIds, history = []) => {
  const uniqueSetIds = new Set();
  for (const setId of cachedSetIds || []) {
    const normalizedSetId = normalizeCachedSetId(setId);
    if (normalizedSetId) {
      uniqueSetIds.add(normalizedSetId);
    }
  }

  const historyBySetId = new Map();
  for (const entry of history || []) {
    const setId = normalizeCachedSetId(entry?.beatmapSetId);
    if (setId && !historyBySetId.has(setId)) {
      historyBySetId.set(setId, entry);
    }
  }

  return [...uniqueSetIds]
    .sort((a, b) => Number(b) - Number(a))
    .map((setId) => ({
      ...(historyBySetId.get(setId) || {}),
      beatmapSetId: setId,
    }));
};

export { buildCachedMapsetEntries, normalizeCachedSetId };
