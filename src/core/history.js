import { storageGet, storageSet } from '../webextension.js';

const HISTORY_KEY = 'mosuPreviewHistoryV1';
const HISTORY_LIMIT = 20;
let historyDebugLogger = null;
let historyWriteQueue = Promise.resolve();

const enqueueHistoryWrite = (task) => {
  const next = historyWriteQueue.then(task, task);
  historyWriteQueue = next.catch(() => {});
  return next;
};

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

const readHistoryStrict = async () => {
  const items = await storageGet('local', [HISTORY_KEY]);
  return Array.isArray(items?.[HISTORY_KEY]) ? items[HISTORY_KEY] : [];
};

const getHistory = async () => {
  try {
    return await readHistoryStrict();
  } catch (error) {
    debugHistory(`history: read failed (${error?.message || error})`);
    return [];
  }
};

const buildNextHistory = (history, entry, now = Date.now()) => {
  const normalizedBeatmapId = String(entry?.beatmapId ?? '').trim();
  if (!entry || !normalizedBeatmapId) {
    return Array.isArray(history) ? history : [];
  }

  const nextEntry = {
    ...entry,
    beatmapId: normalizedBeatmapId,
    viewedAt: now,
  };
  const normalizedSetId = String(entry.beatmapSetId ?? '').trim();
  const filtered = (Array.isArray(history) ? history : []).filter((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    const itemBeatmapId = String(item.beatmapId ?? '').trim();
    if (itemBeatmapId && itemBeatmapId === normalizedBeatmapId) {
      return false;
    }
    if (normalizedSetId) {
      return String(item.beatmapSetId ?? '').trim() !== normalizedSetId;
    }
    return true;
  });

  return [nextEntry, ...filtered].slice(0, HISTORY_LIMIT);
};

const addToHistory = (entry) => {
  if (!entry || !String(entry.beatmapId ?? '').trim()) {
    return Promise.resolve();
  }

  return enqueueHistoryWrite(async () => {
    try {
      // Throw on storage read failure instead of silently treating it as empty
      // history, so a transient read error never overwrites existing entries.
      const history = await readHistoryStrict();
      const nextHistory = buildNextHistory(history, entry);

      await storageSet('local', { [HISTORY_KEY]: nextHistory });
    } catch (error) {
      debugHistory(`history: update failed (${error?.message || error})`);
    }
  });
};

const clearHistory = () => enqueueHistoryWrite(async () => {
  try {
    await storageSet('local', { [HISTORY_KEY]: [] });
  } catch (error) {
    debugHistory(`history: clear failed (${error?.message || error})`);
  }
});

export { getHistory, addToHistory, clearHistory, setHistoryDebugLogger, buildNextHistory };
