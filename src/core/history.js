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

const addToHistory = async (entry) => {
  if (!entry || !entry.beatmapId) {
    return;
  }

  try {
    const history = await getHistory();
    const nextEntry = {
      ...entry,
      viewedAt: Date.now(),
    };

    // Remove existing entry for the same beatmapId to move it to the top
    const filtered = history.filter((item) => item.beatmapId !== entry.beatmapId);
    const nextHistory = [nextEntry, ...filtered].slice(0, HISTORY_LIMIT);

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

export { getHistory, addToHistory, clearHistory, setHistoryDebugLogger };
