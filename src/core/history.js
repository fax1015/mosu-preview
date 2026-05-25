import { storageGet, storageSet } from '../webextension.js';

const HISTORY_KEY = 'mosuPreviewHistoryV1';
const HISTORY_LIMIT = 20;
let historyDebugLogger = null;

const setHistoryDebugLogger = (logger) => {
  historyDebugLogger = typeof logger === 'function' ? logger : null;
};

const debugHistory = (message) => {
  try {
    historyDebugLogger?.(message);
  } catch {
    // Debug logging should never affect history behavior.
  }
};

const getHistory = async () => {
  try {
    const items = await storageGet('local', [HISTORY_KEY]);
    return Array.isArray(items?.[HISTORY_KEY]) ? items[HISTORY_KEY] : [];
  } catch (error) {
    debugHistory(`history: read failed (${error?.message || error})`);
    return [];
  }
};

const buildNextHistory = (history, entry, now = Date.now()) => {
  if (!entry || !entry.beatmapId) {
    return Array.isArray(history) ? history : [];
  }

  const nextEntry = {
    ...entry,
    viewedAt: now,
  };
  const normalizedSetId = String(entry.beatmapSetId || '').trim();
  const filtered = (Array.isArray(history) ? history : []).filter((item) => (
    normalizedSetId
      ? String(item?.beatmapSetId || '').trim() !== normalizedSetId
      : item.beatmapId !== entry.beatmapId
  ));

  return [nextEntry, ...filtered].slice(0, HISTORY_LIMIT);
};

const addToHistory = async (entry) => {
  if (!entry || !entry.beatmapId) {
    return;
  }

  try {
    const history = await getHistory();
    const nextHistory = buildNextHistory(history, entry);

    await storageSet('local', { [HISTORY_KEY]: nextHistory });
  } catch (error) {
    debugHistory(`history: update failed (${error?.message || error})`);
  }
};

const clearHistory = async () => {
  try {
    await storageSet('local', { [HISTORY_KEY]: [] });
  } catch (error) {
    debugHistory(`history: clear failed (${error?.message || error})`);
  }
};

export { getHistory, addToHistory, clearHistory, setHistoryDebugLogger, buildNextHistory };
