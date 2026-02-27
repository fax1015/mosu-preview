import { parseMetadata, parseMapPreviewData, parseBreakPeriods } from './parser.js';
import { PreviewRenderer, clamp } from './renderer.js';

const popup = document.querySelector('#mapPreviewPopup');
const titleLine = document.querySelector('#mapPreviewTitle');
const versionLine = document.querySelector('#mapPreviewVersion');
const timeLabel = document.querySelector('#mapPreviewTimeLabel');
const togglePlaybackButton = document.querySelector('#mapPreviewPlayBtn');
const playfieldCanvas = document.querySelector('#mapPreviewCanvas');
const timelineCanvas = document.querySelector('#mapPreviewTimeline');
const volumeSlider = document.querySelector('#mapPreviewVolume');
const volumeLabel = document.querySelector('#mapPreviewVolumeLabel');
const toggleIndicator = document.querySelector('#mapPreviewToggleIndicator');
const unsupportedPanel = document.querySelector('#mapPreviewUnsupported');
const unsupportedAscii = document.querySelector('#mapPreviewUnsupportedAscii');
// Compatibility shim for stale code paths that previously used a separate loading element.
const audioLoadingIndicator = null;
const audioStatusBadge = document.querySelector('#mapPreviewAudioBadge');
const debugPanel = document.querySelector('#mapPreviewDebugPanel');
const debugStatus = document.querySelector('#mapPreviewDebugStatus');
const debugLog = document.querySelector('#mapPreviewDebugLog');
const debugRunButton = document.querySelector('#mapPreviewDebugRunBtn');
const debugClearButton = document.querySelector('#mapPreviewDebugClearBtn');

const renderer = new PreviewRenderer(playfieldCanvas, timelineCanvas);
const CACHE_KEY = 'mosuPreviewCacheV1';
const CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 12;
const AUDIO_PREVIEW_BASE = 'https://b.ppy.sh/preview';
const FULL_AUDIO_CACHE_NAME = 'mosuPreviewFullAudioV1';
const FULL_AUDIO_CACHE_MAX_BYTES = 35 * 1024 * 1024;
const FULL_AUDIO_CACHE_TOTAL_MAX_BYTES = 140 * 1024 * 1024;
const FULL_AUDIO_CACHE_ENTRY_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const FULL_AUDIO_CACHE_PRUNE_INTERVAL_MS = 1000 * 60 * 30;
const FULL_AUDIO_CACHE_LAST_PRUNE_KEY = 'fullAudioCacheLastPruneMs';
const MAX_ARCHIVE_DOWNLOAD_BYTES = 120 * 1024 * 1024;
const MAX_ZIP_AUDIO_ENTRY_BYTES = 48 * 1024 * 1024;
const MAX_ZIP_ENTRY_INFLATE_RATIO = 80;
const MAX_ZIP_ENTRIES = 6000;
const PROVIDER_OVERRIDE_KEY = 'providerOverride';
const AUDIO_VOLUME_KEY = 'audioVolume';
const DEFAULT_AUDIO_VOLUME = 0.8;
const PROVIDER_FAILURE_COOLDOWN_MS = 1000 * 60 * 3;
const AUDIO_BADGE_AUTO_HIDE_DELAY_MS = 3500;
const FETCH_TIMEOUT_MS = 18000;
const DEBUG_LOG_LIMIT = 80;
const PREVIEW_AUDIO_PROVIDER_LABEL = 'b.ppy.sh';
const CACHE_AUDIO_PROVIDER_LABEL = 'cache';
const PLAYBACK_SPEED_CYCLE = [1, 0.75, 0.5, 1.5];
const UNSUPPORTED_ASCII_TICK_MS = 140;
const UNSUPPORTED_ASCII_CHAR_WIDTH_PX = 6.2;
const UNSUPPORTED_ASCII_CHAR_HEIGHT_PX = 11.2;
const UNSUPPORTED_ASCII_GLYPHS = ['.', 'o', 'O', '0', '@'];
const UNSUPPORTED_ASCII_BUBBLE_MIN_MS = 1300;
const UNSUPPORTED_ASCII_BUBBLE_MAX_MS = 3200;
const UNSUPPORTED_ASCII_BUBBLE_DENSITY = 0.065;
const UNSUPPORTED_ASCII_BUBBLE_MIN_RADIUS = 2;
const UNSUPPORTED_ASCII_BUBBLE_MAX_RADIUS = 5;
const UNSUPPORTED_ASCII_XY_RATIO = UNSUPPORTED_ASCII_CHAR_WIDTH_PX / UNSUPPORTED_ASCII_CHAR_HEIGHT_PX;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ARCHIVE_DOWNLOAD_SOURCES = [
  {
    id: 'osu_direct',
    label: 'osu.direct',
    rank: 0,
    url: (setId) => `https://osu.direct/api/d/${setId}`,
    credentials: 'omit',
  },
  {
    id: 'catboy',
    label: 'catboy',
    rank: 1,
    url: (setId) => `https://catboy.best/d/${setId}`,
    credentials: 'omit',
  },
  {
    id: 'osu',
    label: 'osu!',
    rank: 2,
    url: (setId) => `https://osu.ppy.sh/beatmapsets/${setId}/download?noVideo=1`,
    credentials: 'include',
  },
  {
    id: 'chimu',
    label: 'chimu',
    rank: 3,
    url: (setId) => `https://api.chimu.moe/v1/download/${setId}?n=1`,
    credentials: 'omit',
  },
];
const ALLOWED_PROVIDER_OVERRIDES = new Set(['auto', ...ARCHIVE_DOWNLOAD_SOURCES.map((source) => source.id)]);

const state = {
  metadata: null,
  mapData: null,
  breaks: [],
  durationMs: 0,
  currentTimeMs: 0,
  isPlaying: false,
  playbackMode: 'none',
  playStartPerfMs: 0,
  playStartMapMs: 0,
  rafId: null,
  indicatorTimer: null,
  audio: new Audio(),
  audioSyncEnabled: false,
  audioReady: false,
  audioAnchorMapMs: 0,
  previewSetId: null,
  fullAudioSetId: null,
  fullAudioStatus: 'idle',
  fullAudioCacheKey: '',
  fullAudioJobId: 0,
  fullAudioObjectUrl: null,
  fullAudioError: '',
  debugLogs: [],
  debugPanelOpen: false,
  activeSetId: null,
  providerOverride: 'auto',
  providerStats: {},
  providerCooldowns: {},
  currentArchiveProviderLabel: '',
  audioBadgeHideTimer: null,
  volume: DEFAULT_AUDIO_VOLUME,
  volumePersistTimer: null,
  hasAutoStarted: false,
  playbackSpeed: 1,
  unsupportedAsciiTimer: null,
  unsupportedAsciiField: null,
};

state.audio.preload = 'auto';
state.audio.addEventListener('canplay', () => {
  state.audioReady = true;
});
state.audio.addEventListener('error', () => {
  state.audioReady = false;
  state.audioSyncEnabled = false;
});

const formatDebugTime = (unixMs) => {
  const date = new Date(unixMs);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const renderDebugPanel = () => {
  if (debugPanel) {
    debugPanel.hidden = !state.debugPanelOpen;
  }

  if (debugStatus) {
    const status = state.fullAudioStatus || 'idle';
    const setLabel = state.activeSetId ? `set ${state.activeSetId}` : 'no set';
    const overrideLabel = `provider ${getProviderDisplayName(state.providerOverride)}`;
    const errorLabel = state.fullAudioError ? ` | error: ${state.fullAudioError}` : '';
    debugStatus.textContent = `status: ${status} | ${setLabel} | ${overrideLabel}${errorLabel}`;
  }

  if (debugLog) {
    if (!Array.isArray(state.debugLogs) || state.debugLogs.length === 0) {
      debugLog.textContent = 'No logs yet.';
    } else {
      debugLog.textContent = state.debugLogs
        .map((entry) => `[${formatDebugTime(entry.time)}] ${entry.message}`)
        .join('\n');
    }
  }
};

const addDebugLog = (message) => {
  state.debugLogs.push({ time: Date.now(), message: String(message) });
  if (state.debugLogs.length > DEBUG_LOG_LIMIT) {
    state.debugLogs.splice(0, state.debugLogs.length - DEBUG_LOG_LIMIT);
  }
  renderDebugPanel();
};

const clearDebugLogs = () => {
  state.debugLogs = [];
  renderDebugPanel();
};

const randomRange = (min, max) => min + (Math.random() * (max - min));
const randomInt = (min, max) => Math.floor(randomRange(min, max + 1));

const getUnsupportedAsciiGridSize = () => {
  const width = Math.max(140, unsupportedPanel?.clientWidth || 0);
  const height = Math.max(120, unsupportedPanel?.clientHeight || 0);
  const cols = Math.max(26, Math.min(120, Math.ceil(width / UNSUPPORTED_ASCII_CHAR_WIDTH_PX) + 1));
  const rows = Math.max(12, Math.min(40, Math.ceil(height / UNSUPPORTED_ASCII_CHAR_HEIGHT_PX) + 1));
  return { cols, rows };
};

const createUnsupportedBubble = (cols, rows) => ({
  col: randomInt(0, Math.max(0, cols - 1)),
  row: randomInt(0, Math.max(0, rows - 1)),
  maxRadius: randomInt(UNSUPPORTED_ASCII_BUBBLE_MIN_RADIUS, UNSUPPORTED_ASCII_BUBBLE_MAX_RADIUS),
  ageMs: -randomRange(0, 680),
  durationMs: randomRange(UNSUPPORTED_ASCII_BUBBLE_MIN_MS, UNSUPPORTED_ASCII_BUBBLE_MAX_MS),
});

const createUnsupportedAsciiField = () => {
  const { cols, rows } = getUnsupportedAsciiGridSize();
  const bubbleCount = Math.max(30, Math.min(180, Math.round(cols * rows * UNSUPPORTED_ASCII_BUBBLE_DENSITY)));
  return {
    cols,
    rows,
    bubbles: Array.from({ length: bubbleCount }, () => createUnsupportedBubble(cols, rows)),
    lastTickMs: performance.now(),
  };
};

const bubbleSizeForProgress = (maxRadius, progress) => {
  if (progress <= 0 || progress >= 1) {
    return 0;
  }
  if (progress < 0.24) {
    const growRatio = progress / 0.24;
    return Math.max(1, Math.round(maxRadius * growRatio));
  }
  if (progress > 0.74) {
    const shrinkRatio = (1 - progress) / 0.26;
    return Math.max(1, Math.round(maxRadius * shrinkRatio));
  }
  return maxRadius;
};

const renderUnsupportedAsciiFrame = (field, nowMs) => {
  if (!field || !unsupportedAscii) {
    return;
  }

  const deltaMs = Math.max(8, Math.min(280, nowMs - field.lastTickMs));
  field.lastTickMs = nowMs;

  const { cols, rows } = field;
  const cellCount = cols * rows;
  const chars = new Array(cellCount).fill(' ');
  const weights = new Array(cellCount).fill(0);

  for (let i = 0; i < field.bubbles.length; i += 1) {
    const bubble = field.bubbles[i];
    bubble.ageMs += deltaMs;

    if (bubble.ageMs >= bubble.durationMs) {
      field.bubbles[i] = createUnsupportedBubble(cols, rows);
      continue;
    }

    if (bubble.ageMs < 0) {
      continue;
    }

    const progress = clamp(bubble.ageMs / bubble.durationMs, 0, 1);
    const radius = bubbleSizeForProgress(bubble.maxRadius, progress);
    if (radius <= 0) {
      continue;
    }

    const glyph = UNSUPPORTED_ASCII_GLYPHS[Math.min(UNSUPPORTED_ASCII_GLYPHS.length - 1, Math.max(1, radius - 1))] || 'O';
    const maxDx = Math.ceil(radius / Math.max(0.2, UNSUPPORTED_ASCII_XY_RATIO));
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -maxDx; dx <= maxDx; dx += 1) {
        const col = bubble.col + dx;
        const row = bubble.row + dy;
        if (col < 0 || col >= cols || row < 0 || row >= rows) {
          continue;
        }

        const dist = Math.hypot(dx * UNSUPPORTED_ASCII_XY_RATIO, dy);
        const ringEdge = radius - 0.9;
        if (dist > radius + 0.2 || dist < ringEdge) {
          continue;
        }

        const idx = (row * cols) + col;
        const drawWeight = radius + (1 - Math.abs(dist - radius));
        if (drawWeight < weights[idx]) {
          continue;
        }

        weights[idx] = drawWeight;
        chars[idx] = glyph;
      }
    }
  }

  const lines = [];
  for (let row = 0; row < rows; row += 1) {
    const start = row * cols;
    lines.push(chars.slice(start, start + cols).join(''));
  }
  unsupportedAscii.textContent = lines.join('\n');
};

const stopUnsupportedAsciiAnimation = () => {
  if (state.unsupportedAsciiTimer) {
    clearInterval(state.unsupportedAsciiTimer);
    state.unsupportedAsciiTimer = null;
  }
  state.unsupportedAsciiField = null;
};

const startUnsupportedAsciiAnimation = () => {
  if (!unsupportedPanel || !unsupportedAscii) {
    return;
  }

  stopUnsupportedAsciiAnimation();
  state.unsupportedAsciiField = createUnsupportedAsciiField();
  renderUnsupportedAsciiFrame(state.unsupportedAsciiField, performance.now());

  state.unsupportedAsciiTimer = setInterval(() => {
    if (!state.unsupportedAsciiField) {
      return;
    }

    const { cols, rows } = getUnsupportedAsciiGridSize();
    if (cols !== state.unsupportedAsciiField.cols || rows !== state.unsupportedAsciiField.rows) {
      state.unsupportedAsciiField = createUnsupportedAsciiField();
    }

    renderUnsupportedAsciiFrame(state.unsupportedAsciiField, performance.now());
  }, UNSUPPORTED_ASCII_TICK_MS);
};

const setUnsupportedMode = (enabled) => {
  if (!popup) {
    return;
  }

  popup.classList.toggle('is-unsupported', Boolean(enabled));
  if (!unsupportedPanel || !unsupportedAscii) {
    return;
  }

  if (!enabled) {
    unsupportedPanel.hidden = true;
    stopUnsupportedAsciiAnimation();
    unsupportedAscii.textContent = '';
    return;
  }

  unsupportedPanel.hidden = false;
  startUnsupportedAsciiAnimation();
};

const getProviderById = (providerId) => ARCHIVE_DOWNLOAD_SOURCES.find((source) => source.id === providerId) || null;

const getProviderDisplayName = (providerId) => {
  if (providerId === 'auto') {
    return 'auto';
  }
  return getProviderById(providerId)?.label || providerId;
};

const ensureProviderStats = (providerId) => {
  if (!state.providerStats[providerId]) {
    state.providerStats[providerId] = { successes: 0, failures: 0 };
  }
  return state.providerStats[providerId];
};

const getProviderCooldownRemainingMs = (providerId) => {
  const cooldownUntil = Number(state.providerCooldowns[providerId] || 0);
  return Math.max(0, cooldownUntil - Date.now());
};

const isProviderInCooldown = (providerId) => getProviderCooldownRemainingMs(providerId) > 0;

const markProviderSuccess = (providerId) => {
  const stats = ensureProviderStats(providerId);
  stats.successes += 1;
  delete state.providerCooldowns[providerId];
};

const markProviderFailure = (providerId) => {
  const stats = ensureProviderStats(providerId);
  stats.failures += 1;
  state.providerCooldowns[providerId] = Date.now() + PROVIDER_FAILURE_COOLDOWN_MS;
};

const getProviderReliabilityScore = (providerId) => {
  const stats = ensureProviderStats(providerId);
  const attempts = stats.successes + stats.failures;
  if (attempts <= 0) {
    return 0.5;
  }
  return stats.successes / attempts;
};

const getAutoOrderedProviders = () => {
  const available = ARCHIVE_DOWNLOAD_SOURCES.filter((source) => !isProviderInCooldown(source.id));
  return available.sort((a, b) => {
    const aScore = getProviderReliabilityScore(a.id);
    const bScore = getProviderReliabilityScore(b.id);
    if (aScore !== bScore) {
      return bScore - aScore;
    }

    const aStats = ensureProviderStats(a.id);
    const bStats = ensureProviderStats(b.id);
    const aAttempts = aStats.successes + aStats.failures;
    const bAttempts = bStats.successes + bStats.failures;
    if (aAttempts !== bAttempts) {
      return bAttempts - aAttempts;
    }
    return a.rank - b.rank;
  });
};

const getProviderSequenceForDownload = () => {
  if (state.providerOverride !== 'auto') {
    const forced = getProviderById(state.providerOverride);
    return forced ? [forced] : [];
  }

  const autoOrdered = getAutoOrderedProviders();
  if (autoOrdered.length > 0) {
    return autoOrdered;
  }

  // If every provider is cooling down, use reliability order anyway as a last resort.
  return [...ARCHIVE_DOWNLOAD_SOURCES].sort((a, b) => {
    const aScore = getProviderReliabilityScore(a.id);
    const bScore = getProviderReliabilityScore(b.id);
    if (aScore !== bScore) {
      return bScore - aScore;
    }
    return a.rank - b.rank;
  });
};

const readProviderOverrideSetting = () => new Promise((resolve) => {
  chrome.storage.sync.get([PROVIDER_OVERRIDE_KEY], (items) => {
    const error = chrome.runtime.lastError;
    if (error) {
      resolve('auto');
      return;
    }

    const candidate = String(items?.[PROVIDER_OVERRIDE_KEY] || 'auto');
    resolve(ALLOWED_PROVIDER_OVERRIDES.has(candidate) ? candidate : 'auto');
  });
});

const readAudioVolumeSetting = () => new Promise((resolve) => {
  chrome.storage.sync.get([AUDIO_VOLUME_KEY], (items) => {
    const error = chrome.runtime.lastError;
    if (error) {
      resolve(DEFAULT_AUDIO_VOLUME);
      return;
    }

    const candidate = Number(items?.[AUDIO_VOLUME_KEY]);
    if (!Number.isFinite(candidate)) {
      resolve(DEFAULT_AUDIO_VOLUME);
      return;
    }
    resolve(clamp(candidate, 0, 1));
  });
});

const writeAudioVolumeSetting = (volume) => new Promise((resolve) => {
  chrome.storage.sync.set({ [AUDIO_VOLUME_KEY]: clamp(volume, 0, 1) }, () => {
    const error = chrome.runtime.lastError;
    resolve(!error);
  });
});

const applyAudioVolume = (volume) => {
  const nextVolume = clamp(Number.isFinite(volume) ? volume : DEFAULT_AUDIO_VOLUME, 0, 1);
  state.volume = nextVolume;
  state.audio.volume = nextVolume;

  if (volumeSlider) {
    volumeSlider.value = String(Math.round(nextVolume * 100));
    volumeSlider.style.setProperty('--volume-progress', `${Math.round(nextVolume * 100)}%`);
  }
  if (volumeLabel) {
    volumeLabel.textContent = `${Math.round(nextVolume * 100)}%`;
  }
};

const formatPlaybackSpeedLabel = (speed) => {
  const value = Number(speed);
  if (!Number.isFinite(value) || value <= 0) {
    return '1x';
  }
  const text = Number.isInteger(value)
    ? String(value)
    : String(value).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return `${text}x`;
};

const setPlaybackSpeedButtonLabel = () => {
  if (!togglePlaybackButton) {
    return;
  }
  const label = formatPlaybackSpeedLabel(state.playbackSpeed);
  togglePlaybackButton.textContent = label;
  togglePlaybackButton.title = `Playback speed (${label})`;
};

const getCurrentManualMapTime = (nowPerfMs) => (
  state.playStartMapMs + ((nowPerfMs - state.playStartPerfMs) * state.playbackSpeed)
);

const applyPlaybackSpeed = (nextSpeed) => {
  const normalized = PLAYBACK_SPEED_CYCLE.find((value) => Math.abs(value - Number(nextSpeed)) < 0.0001) || 1;

  if (state.isPlaying && state.playbackMode === 'manual') {
    const now = performance.now();
    state.currentTimeMs = clamp(getCurrentManualMapTime(now), 0, state.durationMs || 1);
    state.playStartMapMs = state.currentTimeMs;
    state.playStartPerfMs = now;
  }

  state.playbackSpeed = normalized;
  state.audio.playbackRate = normalized;
  setPlaybackSpeedButtonLabel();

  if (state.mapData) {
    renderFrame();
  }
};

const cyclePlaybackSpeed = () => {
  const currentIndex = PLAYBACK_SPEED_CYCLE.findIndex((value) => Math.abs(value - state.playbackSpeed) < 0.0001);
  const nextIndex = currentIndex < 0 ? 0 : ((currentIndex + 1) % PLAYBACK_SPEED_CYCLE.length);
  applyPlaybackSpeed(PLAYBACK_SPEED_CYCLE[nextIndex]);
};

const setFullAudioLoading = (isLoading) => {
  if (!audioStatusBadge) {
    return;
  }
  audioStatusBadge.classList.toggle('is-spinning', Boolean(isLoading));
};

const setAudioBadge = (stateName, label, tooltip = '') => {
  if (!audioStatusBadge) {
    return;
  }

  if (state.audioBadgeHideTimer) {
    clearTimeout(state.audioBadgeHideTimer);
    state.audioBadgeHideTimer = null;
  }

  audioStatusBadge.classList.remove('is-hidden');
  audioStatusBadge.classList.remove('is-preview', 'is-loading', 'is-ready', 'is-failed');
  audioStatusBadge.classList.add(`is-${stateName}`);
  audioStatusBadge.textContent = label;
  audioStatusBadge.title = tooltip || label;

  if (stateName === 'ready') {
    state.audioBadgeHideTimer = setTimeout(() => {
      audioStatusBadge.classList.add('is-hidden');
      state.audioBadgeHideTimer = null;
    }, AUDIO_BADGE_AUTO_HIDE_DELAY_MS);
  }

  renderDebugPanel();
};

const formatAudioBadgeLabel = (label, providerLabel) => {
  if (!providerLabel) {
    return label;
  }
  return `${label} - ${providerLabel}`;
};

const setAudioBadgeWithProvider = (stateName, label, providerLabel, tooltip = '') => {
  const finalLabel = formatAudioBadgeLabel(label, providerLabel);
  const finalTooltip = tooltip || finalLabel;
  setAudioBadge(stateName, finalLabel, finalTooltip);
};

const getAudioMimeType = (filename) => {
  if (!filename || typeof filename !== 'string') {
    return 'audio/mpeg';
  }
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.opus')) return 'audio/ogg';
  return 'audio/mpeg';
};

const normalizePath = (path) => String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');

const getPathBaseName = (path) => {
  const normalized = normalizePath(path);
  const pieces = normalized.split('/');
  return (pieces[pieces.length - 1] || '').toLowerCase();
};

const makeFullAudioCacheKey = (setId, audioFilename) => {
  const safeSetId = encodeURIComponent(String(setId || '').trim());
  const safeFile = encodeURIComponent(normalizePath(audioFilename).toLowerCase());
  return `https://osu.ppy.sh/beatmapsets/${safeSetId}/audio/${safeFile}`;
};

const readLastFullAudioPruneTime = () => new Promise((resolve) => {
  if (!chrome.storage?.local?.get) {
    resolve(0);
    return;
  }

  chrome.storage.local.get([FULL_AUDIO_CACHE_LAST_PRUNE_KEY], (items) => {
    const error = chrome.runtime.lastError;
    if (error) {
      resolve(0);
      return;
    }
    const value = Number(items?.[FULL_AUDIO_CACHE_LAST_PRUNE_KEY]);
    resolve(Number.isFinite(value) && value > 0 ? value : 0);
  });
});

const writeLastFullAudioPruneTime = (unixMs) => new Promise((resolve) => {
  if (!chrome.storage?.local?.set) {
    resolve(false);
    return;
  }

  chrome.storage.local.set({ [FULL_AUDIO_CACHE_LAST_PRUNE_KEY]: Math.max(0, Math.floor(unixMs)) }, () => {
    const error = chrome.runtime.lastError;
    resolve(!error);
  });
});

const parseCachedAtMs = (response) => {
  const headerValue = response?.headers?.get('x-mosu-cached-at') || '';
  const numeric = Number.parseInt(headerValue, 10);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  return 0;
};

const pruneFullAudioCache = async ({ force = false } = {}) => {
  if (!('caches' in window)) {
    return;
  }

  const now = Date.now();
  if (!force) {
    const lastPruneAt = await readLastFullAudioPruneTime();
    if (lastPruneAt > 0 && (now - lastPruneAt) < FULL_AUDIO_CACHE_PRUNE_INTERVAL_MS) {
      return;
    }
  }

  try {
    const cache = await caches.open(FULL_AUDIO_CACHE_NAME);
    const requests = await cache.keys();
    if (!Array.isArray(requests) || requests.length === 0) {
      await writeLastFullAudioPruneTime(now);
      return;
    }

    const entries = [];
    for (const request of requests) {
      try {
        const response = await cache.match(request);
        if (!response) {
          continue;
        }

        const blob = await response.blob();
        const size = Number.isFinite(blob.size) ? blob.size : 0;
        const cachedAtMs = parseCachedAtMs(response);
        entries.push({ request, size: Math.max(0, size), cachedAtMs });
      } catch {
        // Ignore unreadable entries and keep pruning others.
      }
    }

    let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);

    const deletedRequests = new Set();
    for (const entry of entries) {
      const isExpired = entry.cachedAtMs > 0 && (now - entry.cachedAtMs) > FULL_AUDIO_CACHE_ENTRY_MAX_AGE_MS;
      if (!isExpired) {
        continue;
      }

      if (await cache.delete(entry.request)) {
        totalBytes -= entry.size;
        deletedRequests.add(entry.request.url);
      }
    }

    if (totalBytes > FULL_AUDIO_CACHE_TOTAL_MAX_BYTES) {
      const candidates = entries
        .filter((entry) => !deletedRequests.has(entry.request.url))
        .sort((a, b) => (a.cachedAtMs || 0) - (b.cachedAtMs || 0));

      for (const entry of candidates) {
        if (totalBytes <= FULL_AUDIO_CACHE_TOTAL_MAX_BYTES) {
          break;
        }
        if (await cache.delete(entry.request)) {
          totalBytes -= entry.size;
        }
      }
    }
  } catch {
    // Cache cleanup should never block preview loading.
  } finally {
    await writeLastFullAudioPruneTime(now);
  }
};

const readCachedFullAudioBlob = async (setId, audioFilename) => {
  if (!setId || !audioFilename || !('caches' in window)) {
    return null;
  }
  try {
    const cache = await caches.open(FULL_AUDIO_CACHE_NAME);
    const response = await cache.match(makeFullAudioCacheKey(setId, audioFilename));
    if (!response || !response.ok) {
      return null;
    }
    return await response.blob();
  } catch {
    return null;
  }
};

const writeCachedFullAudioBlob = async (setId, audioFilename, blob) => {
  if (
    !setId
    || !audioFilename
    || !blob
    || !('caches' in window)
    || !Number.isFinite(blob.size)
    || blob.size <= 0
    || blob.size > FULL_AUDIO_CACHE_MAX_BYTES
  ) {
    return false;
  }

  try {
    const cache = await caches.open(FULL_AUDIO_CACHE_NAME);
    const key = makeFullAudioCacheKey(setId, audioFilename);
    await cache.put(
      key,
      new Response(blob, {
        headers: {
          'content-type': blob.type || getAudioMimeType(audioFilename),
          'x-mosu-cached-at': String(Date.now()),
        },
      }),
    );
    void pruneFullAudioCache();
    return true;
  } catch {
    return false;
  }
};

const waitForAudioReady = () => new Promise((resolve) => {
  if (state.audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    resolve(true);
    return;
  }

  const onReady = () => {
    cleanup();
    resolve(true);
  };

  const onError = () => {
    cleanup();
    resolve(false);
  };

  const onTimeout = () => {
    cleanup();
    resolve(false);
  };

  const cleanup = () => {
    clearTimeout(timer);
    state.audio.removeEventListener('canplay', onReady);
    state.audio.removeEventListener('loadeddata', onReady);
    state.audio.removeEventListener('error', onError);
  };

  const timer = setTimeout(onTimeout, 10000);
  state.audio.addEventListener('canplay', onReady);
  state.audio.addEventListener('loadeddata', onReady);
  state.audio.addEventListener('error', onError);
});

const setAudioElementSource = (sourceUrl, anchorMapMs) => {
  state.audioSyncEnabled = Boolean(sourceUrl);
  state.audioReady = false;
  state.audioAnchorMapMs = Math.max(0, Number.isFinite(anchorMapMs) ? anchorMapMs : 0);
  state.audio.playbackRate = state.playbackSpeed;
  if (!sourceUrl) {
    state.audio.removeAttribute('src');
    state.audio.load();
    return;
  }

  if (state.audio.src !== sourceUrl) {
    state.audio.src = sourceUrl;
    state.audio.load();
  }
  state.audio.playbackRate = state.playbackSpeed;
};

const decodeZipName = (nameBytes, isUtf8) => {
  if (!(nameBytes instanceof Uint8Array)) {
    return '';
  }

  try {
    const decoder = new TextDecoder(isUtf8 ? 'utf-8' : 'utf-8', { fatal: false });
    return decoder.decode(nameBytes);
  } catch {
    return String.fromCharCode(...nameBytes);
  }
};

const findZipEocdOffset = (bytes) => {
  const minimumLength = 22;
  if (!bytes || bytes.length < minimumLength) {
    return -1;
  }

  const scanStart = Math.max(0, bytes.length - (0xFFFF + minimumLength));
  for (let offset = bytes.length - minimumLength; offset >= scanStart; offset -= 1) {
    if (
      bytes[offset] === 0x50
      && bytes[offset + 1] === 0x4b
      && bytes[offset + 2] === 0x05
      && bytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }

  return -1;
};

const parseZipEntries = (archiveBytes) => {
  if (!(archiveBytes instanceof Uint8Array)) {
    throw new Error('Invalid beatmap archive payload.');
  }

  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  const eocdOffset = findZipEocdOffset(archiveBytes);
  if (eocdOffset < 0) {
    throw new Error('Beatmap archive is not a readable ZIP file.');
  }

  if (view.getUint32(eocdOffset, true) !== ZIP_EOCD_SIGNATURE) {
    throw new Error('ZIP footer signature mismatch.');
  }

  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (
    centralDirectoryOffset < 0
    || centralDirectoryOffset >= archiveBytes.length
    || centralDirectoryEnd > archiveBytes.length
  ) {
    throw new Error('ZIP central directory is out of bounds.');
  }

  const entries = [];
  let cursor = centralDirectoryOffset;

  while (cursor < centralDirectoryEnd) {
    if (entries.length >= MAX_ZIP_ENTRIES) {
      throw new Error('ZIP contains too many entries.');
    }
    if (cursor + 46 > centralDirectoryEnd) {
      throw new Error('ZIP central directory entry is truncated.');
    }
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_SIGNATURE) {
      break;
    }

    const flags = view.getUint16(cursor + 8, true);
    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const nameStart = cursor + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > archiveBytes.length) {
      break;
    }

    const nameBytes = archiveBytes.subarray(nameStart, nameEnd);
    const name = decodeZipName(nameBytes, (flags & 0x0800) !== 0);

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    const nextCursor = cursor + 46 + fileNameLength + extraLength + commentLength;
    if (nextCursor <= cursor || nextCursor > centralDirectoryEnd) {
      throw new Error('ZIP central directory entry bounds are invalid.');
    }
    cursor = nextCursor;
  }

  return entries;
};

const inflateWithFormat = async (compressedBytes, format) => {
  if (!('DecompressionStream' in window)) {
    throw new Error('Browser does not support ZIP inflation for full audio.');
  }
  const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const inflateDeflateRaw = async (compressedBytes) => {
  try {
    return await inflateWithFormat(compressedBytes, 'deflate-raw');
  } catch {
    return inflateWithFormat(compressedBytes, 'deflate');
  }
};

const readResponseArrayBufferLimited = async (response, maxBytes) => {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : MAX_ARCHIVE_DOWNLOAD_BYTES;
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > cap) {
    throw new Error(`archive too large (${contentLength} bytes)`);
  }

  if (!response.body) {
    const fallbackBuffer = await response.arrayBuffer();
    if (fallbackBuffer.byteLength > cap) {
      throw new Error(`archive exceeds limit (${fallbackBuffer.byteLength} bytes)`);
    }
    return fallbackBuffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    // Stream the response with a hard cap to avoid memory exhaustion.
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array) || value.byteLength <= 0) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > cap) {
        await reader.cancel();
        throw new Error(`archive exceeds limit (${totalBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
};

const extractZipEntry = async (archiveBytes, entry) => {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  const localOffset = entry.localHeaderOffset;
  const compressedSize = Number(entry.compressedSize);
  const uncompressedSize = Number(entry.uncompressedSize);

  if (
    !Number.isFinite(compressedSize)
    || !Number.isFinite(uncompressedSize)
    || compressedSize <= 0
    || uncompressedSize <= 0
    || compressedSize > MAX_ARCHIVE_DOWNLOAD_BYTES
    || uncompressedSize > MAX_ZIP_AUDIO_ENTRY_BYTES
  ) {
    throw new Error('ZIP entry size is invalid or exceeds security limits.');
  }

  if (
    compressedSize > 0
    && uncompressedSize > (compressedSize * MAX_ZIP_ENTRY_INFLATE_RATIO)
  ) {
    throw new Error('ZIP entry inflate ratio is suspiciously high.');
  }

  if (
    !Number.isFinite(localOffset)
    || localOffset < 0
    || localOffset + 30 > archiveBytes.length
    || view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE
  ) {
    throw new Error('ZIP local file header is invalid.');
  }

  const localFileNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + localFileNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;

  if (dataStart < 0 || dataEnd > archiveBytes.length || dataEnd <= dataStart) {
    throw new Error('ZIP entry data is out of bounds.');
  }

  const compressed = archiveBytes.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) {
    if (compressed.byteLength !== uncompressedSize) {
      throw new Error('Stored ZIP entry size mismatch.');
    }
    return new Uint8Array(compressed);
  }
  if (entry.compressionMethod === 8) {
    const inflated = await inflateDeflateRaw(compressed);
    if (inflated.byteLength !== uncompressedSize) {
      throw new Error('Inflated ZIP entry size mismatch.');
    }
    if (inflated.byteLength > MAX_ZIP_AUDIO_ENTRY_BYTES) {
      throw new Error('Inflated ZIP entry exceeds maximum allowed size.');
    }
    return inflated;
  }

  throw new Error(`ZIP compression method ${entry.compressionMethod} is unsupported.`);
};

const pickAudioEntryFromZip = (entries, requestedAudioFilename) => {
  const targetBaseName = getPathBaseName(requestedAudioFilename);
  const audioExtensions = ['.mp3', '.ogg', '.wav', '.flac', '.opus'];
  const isAudioName = (value) => audioExtensions.some((ext) => value.toLowerCase().endsWith(ext));
  const safeEntries = entries.filter((entry) => (
    isAudioName(entry.name)
    && Number.isFinite(entry.uncompressedSize)
    && entry.uncompressedSize > 0
    && entry.uncompressedSize <= MAX_ZIP_AUDIO_ENTRY_BYTES
  ));

  if (targetBaseName) {
    const exactBaseMatch = safeEntries.find((entry) => getPathBaseName(entry.name) === targetBaseName);
    if (exactBaseMatch) {
      return exactBaseMatch;
    }
  }

  const requestedPath = normalizePath(requestedAudioFilename).toLowerCase();
  if (requestedPath) {
    const exactPathMatch = safeEntries.find((entry) => normalizePath(entry.name).toLowerCase() === requestedPath);
    if (exactPathMatch) {
      return exactPathMatch;
    }
  }

  return safeEntries[0] || null;
};

const fetchArrayBufferWithTimeout = async (
  url,
  options = {},
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_ARCHIVE_DOWNLOAD_BYTES,
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const buffer = await readResponseArrayBufferLimited(response, maxBytes);
    return { response, buffer };
  } finally {
    clearTimeout(timer);
  }
};

const probeArchiveSource = async (source, setId) => {
  const url = source.url(setId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(FETCH_TIMEOUT_MS, 12000));
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: source.credentials || 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });

    let firstBytes = '';
    if (response.body) {
      const reader = response.body.getReader();
      const chunk = await reader.read();
      if (!chunk.done && chunk.value instanceof Uint8Array) {
        firstBytes = Array.from(chunk.value.slice(0, 4))
          .map((value) => value.toString(16).padStart(2, '0'))
          .join(' ');
      }
      await reader.cancel();
    }

    return {
      ok: response.ok,
      status: response.status,
      redirected: response.redirected,
      finalUrl: response.url,
      firstBytes,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      redirected: false,
      finalUrl: url,
      firstBytes: '',
      error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'network error'),
    };
  } finally {
    clearTimeout(timer);
  }
};

const downloadBeatmapArchive = async (setId) => {
  const failures = [];
  const sources = getProviderSequenceForDownload();
  const modeLabel = state.providerOverride === 'auto'
    ? 'auto'
    : `forced:${getProviderDisplayName(state.providerOverride)}`;
  const autoHasAvailableProviders = state.providerOverride === 'auto' && getAutoOrderedProviders().length > 0;

  if (!sources.length) {
    throw new Error('no providers available');
  }

  addDebugLog(`audio: trying providers for set ${setId} (${modeLabel})`);

  for (const source of sources) {
    try {
      const cooldownRemainingMs = getProviderCooldownRemainingMs(source.id);
      if (autoHasAvailableProviders && cooldownRemainingMs > 0) {
        addDebugLog(`audio: ${source.label} skipped (cooldown ${Math.ceil(cooldownRemainingMs / 1000)}s)`);
        continue;
      }

      state.currentArchiveProviderLabel = source.label;
      setAudioBadgeWithProvider('loading', 'Loading full audio', source.label, `Downloading from ${source.label}`);
      const requestUrl = source.url(setId);
      addDebugLog(`audio: ${source.label} -> request start`);

      const { response, buffer } = await fetchArrayBufferWithTimeout(requestUrl, {
        method: 'GET',
        credentials: source.credentials || 'omit',
        cache: 'no-store',
        redirect: 'follow',
      }, FETCH_TIMEOUT_MS);

      if (!response.ok) {
        failures.push(`${source.label}:${response.status}`);
        addDebugLog(`audio: ${source.label} -> http ${response.status}`);
        markProviderFailure(source.id);
        addDebugLog(`audio: ${source.label} cooldown ${Math.ceil(PROVIDER_FAILURE_COOLDOWN_MS / 1000)}s`);
        continue;
      }

      const archiveBuffer = buffer;
      const header = new Uint8Array(archiveBuffer.slice(0, 4));
      const isZip = header.length === 4 && header[0] === 0x50 && header[1] === 0x4b;
      if (!isZip) {
        failures.push(`${source.label}:non-zip`);
        addDebugLog(`audio: ${source.label} -> non-zip response (${response.url})`);
        markProviderFailure(source.id);
        addDebugLog(`audio: ${source.label} cooldown ${Math.ceil(PROVIDER_FAILURE_COOLDOWN_MS / 1000)}s`);
        continue;
      }

      markProviderSuccess(source.id);
      addDebugLog(`audio: ${source.label} -> zip ok (${response.url})`);
      return { archiveBuffer, sourceLabel: source.label };
    } catch (error) {
      const isTimeout = error?.name === 'AbortError';
      failures.push(`${source.label}:${isTimeout ? 'timeout' : (error?.message || 'network error')}`);
      addDebugLog(`audio: ${source.label} -> ${isTimeout ? 'timeout' : (error?.message || 'network error')}`);
      markProviderFailure(source.id);
      addDebugLog(`audio: ${source.label} cooldown ${Math.ceil(PROVIDER_FAILURE_COOLDOWN_MS / 1000)}s`);
    }
  }

  addDebugLog(`audio: all providers failed (${failures.join(', ')})`);
  throw new Error(`archive download failed (${failures.join(', ')})`);
};

const stopPlayback = () => {
  state.isPlaying = false;
  state.playbackMode = 'none';
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  if (state.audio && !state.audio.paused) {
    state.audio.pause();
  }
};

const renderFrame = () => {
  renderer.setTime(state.currentTimeMs);
  renderer.render();
  timeLabel.textContent = `${renderer.getCurrentLabel()} / ${renderer.getDurationLabel()}`;
};

const playbackTick = (now) => {
  if (!state.isPlaying) {
    return;
  }

  if (
    state.playbackMode === 'audio'
    && state.audioSyncEnabled
    && state.audio
  ) {
    if (state.audio.paused) {
      state.playbackMode = 'manual';
      state.playStartPerfMs = now;
      state.playStartMapMs = state.currentTimeMs;
      state.rafId = requestAnimationFrame(playbackTick);
      return;
    }
    state.currentTimeMs = clamp(
      state.audioAnchorMapMs + ((state.audio.currentTime || 0) * 1000),
      0,
      state.durationMs,
    );
  } else {
    state.currentTimeMs = getCurrentManualMapTime(now);
  }

  if (state.currentTimeMs >= state.durationMs) {
    state.currentTimeMs = state.durationMs;
    renderFrame();
    stopPlayback();
    return;
  }

  renderFrame();
  state.rafId = requestAnimationFrame(playbackTick);
};

const showCanvasToggleFeedback = (action) => {
  if (!toggleIndicator) {
    return;
  }

  if (state.indicatorTimer) {
    clearTimeout(state.indicatorTimer);
    state.indicatorTimer = null;
  }

  toggleIndicator.classList.remove('is-visible', 'is-play', 'is-pause');
  void toggleIndicator.offsetWidth;
  toggleIndicator.classList.add(action === 'pause' ? 'is-pause' : 'is-play');
  toggleIndicator.classList.add('is-visible');

  state.indicatorTimer = setTimeout(() => {
    toggleIndicator.classList.remove('is-visible', 'is-play', 'is-pause');
    state.indicatorTimer = null;
  }, 400);
};

const setStatus = (text, isError = false) => {
  titleLine.title = text || '';
  versionLine.title = versionLine.textContent || '';
  if (isError) {
    titleLine.textContent = 'Preview unavailable';
  }
};

const setMetadataText = () => {
  if (!state.metadata || !state.mapData) {
    titleLine.textContent = 'Map Preview';
    versionLine.textContent = '';
    return;
  }

  titleLine.textContent = `${state.metadata.artist} - ${state.metadata.title}`;
  versionLine.textContent = state.metadata.version || '';
  versionLine.title = state.metadata.version || '';

  const objectCount = state.mapData.objects.length;
  const modeNames = ['osu!', 'taiko', 'catch', 'mania'];
  const modeLabel = modeNames[state.mapData.mode] || 'unknown';

  const bpmLabel = state.mapData.bpmMin > 0
    ? (Math.round(state.mapData.bpmMin) === Math.round(state.mapData.bpmMax)
      ? `${Math.round(state.mapData.bpmMin)} BPM`
      : `${Math.round(state.mapData.bpmMin)}-${Math.round(state.mapData.bpmMax)} BPM`)
    : 'BPM n/a';
  titleLine.title = `${state.metadata.artist} - ${state.metadata.title} | ${modeLabel} | ${objectCount.toLocaleString()} objects | ${bpmLabel}`;
};

const extractSetIdFromMetadata = (beatmapSetID) => {
  if (typeof beatmapSetID !== 'string' || !beatmapSetID) {
    return null;
  }
  const direct = beatmapSetID.trim();
  if (/^\d+$/.test(direct)) {
    return direct;
  }
  const match = direct.match(/beatmapsets\/(\d+)/i);
  return match ? match[1] : null;
};

const configureAudioPreview = (setId, previewTimeMs) => {
  state.previewSetId = null;
  state.activeSetId = null;
  state.fullAudioSetId = null;
  state.fullAudioStatus = 'idle';
  state.fullAudioCacheKey = '';
  state.fullAudioError = '';
  state.currentArchiveProviderLabel = '';
  setFullAudioLoading(false);
  setAudioBadgeWithProvider('preview', 'Preview audio', PREVIEW_AUDIO_PROVIDER_LABEL);

  if (state.fullAudioObjectUrl) {
    URL.revokeObjectURL(state.fullAudioObjectUrl);
    state.fullAudioObjectUrl = null;
  }

  if (!setId || !/^\d+$/.test(String(setId))) {
    setAudioElementSource('', 0);
    return;
  }

  const normalizedSetId = String(setId);
  const nextSrc = `${AUDIO_PREVIEW_BASE}/${normalizedSetId}.mp3`;
  state.previewSetId = normalizedSetId;
  state.activeSetId = normalizedSetId;
  setAudioElementSource(nextSrc, Math.max(0, Number.isFinite(previewTimeMs) && previewTimeMs > 0 ? previewTimeMs : 0));
};

const seekAudioToMapTime = (mapTimeMs) => {
  const targetSec = (mapTimeMs - state.audioAnchorMapMs) / 1000;
  if (!Number.isFinite(targetSec) || targetSec < 0) {
    return false;
  }

  const maxDuration = Number.isFinite(state.audio.duration) && state.audio.duration > 0
    ? state.audio.duration
    : targetSec;
  state.audio.currentTime = Math.max(0, Math.min(targetSec, maxDuration));
  return true;
};

const hotswapToFullAudio = async (audioBlob, setId, sourceAudioFilename, jobId, providerLabel = '') => {
  if (!audioBlob || !setId || jobId !== state.fullAudioJobId) {
    return false;
  }

  addDebugLog(`audio: hotswap start (${sourceAudioFilename}, ${Math.round(audioBlob.size / 1024)} KB)`);
  const swapMapTimeMs = state.currentTimeMs;
  const wasPlaying = state.isPlaying;

  if (state.audio && !state.audio.paused) {
    state.audio.pause();
  }

  if (state.fullAudioObjectUrl) {
    URL.revokeObjectURL(state.fullAudioObjectUrl);
    state.fullAudioObjectUrl = null;
  }

  const fullAudioUrl = URL.createObjectURL(audioBlob);
  state.fullAudioObjectUrl = fullAudioUrl;
  state.fullAudioSetId = String(setId);
  state.fullAudioStatus = 'ready';
  state.fullAudioCacheKey = `${setId}:${normalizePath(sourceAudioFilename).toLowerCase()}`;
  state.fullAudioError = '';
  setAudioBadgeWithProvider(
    'ready',
    'Full audio ready',
    providerLabel,
    `Using full audio: ${sourceAudioFilename}`,
  );
  setAudioElementSource(fullAudioUrl, 0);

  const ready = await waitForAudioReady();
  if (!ready || jobId !== state.fullAudioJobId) {
    addDebugLog('audio: hotswap failed, media element not ready');
    return false;
  }

  let hasSyncedSeek = false;
  try {
    hasSyncedSeek = seekAudioToMapTime(swapMapTimeMs);
  } catch {
    hasSyncedSeek = false;
  }

  if (!hasSyncedSeek) {
    addDebugLog('audio: hotswap failed, seek sync rejected');
    return false;
  }

  if (wasPlaying) {
    try {
      state.audio.playbackRate = state.playbackSpeed;
      await state.audio.play();
      state.playbackMode = 'audio';
      state.isPlaying = true;
      if (state.rafId === null) {
        state.rafId = requestAnimationFrame(playbackTick);
      }
      addDebugLog('audio: hotswap success, playback resumed');
      return true;
    } catch {
      state.playbackMode = 'manual';
      state.isPlaying = true;
      state.playStartPerfMs = performance.now();
      state.playStartMapMs = state.currentTimeMs;
      if (state.rafId === null) {
        state.rafId = requestAnimationFrame(playbackTick);
      }
      addDebugLog('audio: hotswap fallback to manual timeline');
      return false;
    }
  }

  addDebugLog('audio: hotswap success (paused state)');
  renderFrame();
  return true;
};

const upgradeToFullAudioIfPossible = async (setId, audioFilename) => {
  if (!setId || !audioFilename || !/^\d+$/.test(String(setId))) {
    return;
  }

  const audioFileName = String(audioFilename).trim();
  if (!audioFileName) {
    return;
  }

  const cacheKey = `${setId}:${normalizePath(audioFileName).toLowerCase()}`;
  if (
    state.fullAudioStatus === 'loading'
    && state.fullAudioCacheKey === cacheKey
  ) {
    return;
  }

  if (
    state.fullAudioStatus === 'ready'
    && state.fullAudioCacheKey === cacheKey
    && state.fullAudioSetId === String(setId)
  ) {
    return;
  }

  state.fullAudioJobId += 1;
  const jobId = state.fullAudioJobId;
  state.fullAudioStatus = 'loading';
  state.fullAudioCacheKey = cacheKey;
  state.fullAudioError = '';
  setFullAudioLoading(true);
  setAudioBadgeWithProvider('loading', 'Loading full audio', state.currentArchiveProviderLabel);
  addDebugLog(`audio: full-load start set=${setId} file=${audioFileName}`);

  try {
    const cachedBlob = await readCachedFullAudioBlob(setId, audioFileName);
    if (cachedBlob && jobId === state.fullAudioJobId) {
      state.currentArchiveProviderLabel = CACHE_AUDIO_PROVIDER_LABEL;
      setAudioBadgeWithProvider('loading', 'Loading full audio', CACHE_AUDIO_PROVIDER_LABEL, 'Using cached full audio');
      addDebugLog(`audio: cache hit (${Math.round(cachedBlob.size / 1024)} KB)`);
      await hotswapToFullAudio(cachedBlob, setId, audioFileName, jobId, CACHE_AUDIO_PROVIDER_LABEL);
      return;
    }
    addDebugLog('audio: cache miss');

    const { archiveBuffer, sourceLabel } = await downloadBeatmapArchive(setId);
    if (jobId !== state.fullAudioJobId) {
      return;
    }
    state.currentArchiveProviderLabel = sourceLabel;
    setAudioBadgeWithProvider('loading', 'Loading full audio', sourceLabel, `Downloading from ${sourceLabel}`);
    addDebugLog(`audio: archive downloaded from ${sourceLabel} (${Math.round(archiveBuffer.byteLength / 1024)} KB)`);

    const archiveBytes = new Uint8Array(archiveBuffer);
    const entries = parseZipEntries(archiveBytes);
    addDebugLog(`audio: zip entries parsed (${entries.length})`);
    const pickedEntry = pickAudioEntryFromZip(entries, audioFileName);
    if (!pickedEntry) {
      throw new Error('Could not find an audio track in beatmap archive.');
    }
    addDebugLog(`audio: selected entry ${pickedEntry.name}`);

    const audioBytes = await extractZipEntry(archiveBytes, pickedEntry);
    if (jobId !== state.fullAudioJobId) {
      return;
    }
    addDebugLog(`audio: extracted entry (${Math.round(audioBytes.byteLength / 1024)} KB)`);

    const mime = getAudioMimeType(pickedEntry.name);
    const audioBlob = new Blob([audioBytes], { type: mime });
    await writeCachedFullAudioBlob(setId, audioFileName, audioBlob);
    addDebugLog('audio: cache write attempted');
    await hotswapToFullAudio(audioBlob, setId, pickedEntry.name, jobId, sourceLabel);
  } catch (error) {
    if (jobId === state.fullAudioJobId) {
      state.fullAudioStatus = 'failed';
      state.fullAudioError = error?.message || 'unknown error';
      setAudioBadgeWithProvider(
        'failed',
        'Full audio failed',
        state.currentArchiveProviderLabel,
        state.fullAudioError,
      );
      addDebugLog(`audio: full-load failed -> ${state.fullAudioError}`);
    }
  } finally {
    if (jobId === state.fullAudioJobId) {
      setFullAudioLoading(false);
      addDebugLog(`audio: full-load end (status=${state.fullAudioStatus})`);
    }
  }
};

const runAudioFetchProbe = async () => {
  const targetSetId = state.activeSetId || state.previewSetId || state.fullAudioSetId;
  if (!targetSetId) {
    addDebugLog('probe: no beatmap set id available');
    return;
  }

  const sources = getProviderSequenceForDownload();
  if (!sources.length) {
    addDebugLog('probe: no providers available');
    return;
  }

  addDebugLog(`probe: running provider checks for set ${targetSetId} (${getProviderDisplayName(state.providerOverride)})`);
  for (const source of sources) {
    const result = await probeArchiveSource(source, targetSetId);
    if (result.ok) {
      addDebugLog(
        `probe: ${source.label} ok (${result.status}) bytes=[${result.firstBytes || 'none'}] url=${result.finalUrl}`,
      );
    } else {
      addDebugLog(
        `probe: ${source.label} fail (${result.status || 0}) ${result.error || ''} url=${result.finalUrl}`,
      );
    }
  }
  addDebugLog('probe: complete');
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
      sourceUrl: url.toString(),
    };
  }

  const beatmapSetMatch = url.pathname.match(/^\/beatmapsets\/(\d+)/i);
  if (!beatmapSetMatch) {
    return { valid: false, reason: 'Open a beatmap URL like /beatmapsets/... or /beatmaps/....' };
  }

  const hash = (url.hash || '').replace(/^#/, '');
  const hashBeatmapMatch = hash.match(/(?:osu|taiko|fruits|mania)\/(\d+)/i);
  if (hashBeatmapMatch) {
    return {
      valid: true,
      beatmapId: hashBeatmapMatch[1],
      setId: beatmapSetMatch[1],
      sourceUrl: url.toString(),
    };
  }

  const queryBeatmapId = url.searchParams.get('b');
  if (queryBeatmapId && /^\d+$/.test(queryBeatmapId)) {
    return {
      valid: true,
      beatmapId: queryBeatmapId,
      setId: beatmapSetMatch[1],
      sourceUrl: url.toString(),
    };
  }

  return {
    valid: false,
    reason: 'Beatmap set page found, but no beatmap difficulty ID in the URL hash.',
  };
};

const queryActiveTab = () => new Promise((resolve, reject) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const error = chrome.runtime.lastError;
    if (error) {
      reject(new Error(error.message || 'Failed to query active tab.'));
      return;
    }

    resolve(Array.isArray(tabs) ? tabs[0] : null);
  });
});

const fetchBeatmapFile = async (beatmapId) => {
  const response = await fetch(`https://osu.ppy.sh/osu/${beatmapId}`, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Beatmap request failed (${response.status}).`);
  }

  const text = await response.text();
  if (!text.includes('[HitObjects]')) {
    throw new Error('Fetched data is not a valid .osu beatmap file.');
  }

  return text;
};

const readCachedPreview = () => new Promise((resolve) => {
  if (!chrome.storage?.session?.get) {
    resolve(null);
    return;
  }

  chrome.storage.session.get([CACHE_KEY], (items) => {
    const error = chrome.runtime.lastError;
    if (error) {
      resolve(null);
      return;
    }
    resolve(items?.[CACHE_KEY] || null);
  });
});

const writeCachedPreview = (value) => new Promise((resolve) => {
  if (!chrome.storage?.session?.set) {
    resolve(false);
    return;
  }

  chrome.storage.session.set({ [CACHE_KEY]: value }, () => {
    const error = chrome.runtime.lastError;
    resolve(!error);
  });
});

const initializePreviewForCurrentTab = async () => {
  stopPlayback();
  togglePlaybackButton.disabled = true;
  popup?.classList.add('is-open');
  setUnsupportedMode(false);
  void pruneFullAudioCache();
  clearDebugLogs();
  state.hasAutoStarted = false;
  state.fullAudioJobId += 1;
  setFullAudioLoading(false);
  setAudioBadgeWithProvider('preview', 'Preview audio', PREVIEW_AUDIO_PROVIDER_LABEL);
  addDebugLog('init: popup opened');

  state.providerOverride = await readProviderOverrideSetting();
  addDebugLog(`init: provider override ${getProviderDisplayName(state.providerOverride)}`);
  applyAudioVolume(await readAudioVolumeSetting());
  addDebugLog(`init: audio volume ${Math.round(state.volume * 100)}%`);

  try {
    setStatus('Checking current tab...');
    const activeTab = await queryActiveTab();

    if (!activeTab?.url) {
      throw new Error('No active tab URL found.');
    }

    const info = extractBeatmapInfoFromUrl(activeTab.url);
    if (!info.valid) {
      addDebugLog(`init: invalid tab url (${info.reason})`);
      versionLine.textContent = '';
      versionLine.title = '';
      configureAudioPreview(null, 0);
      if (info.unsupportedSite) {
        setUnsupportedMode(true);
        titleLine.textContent = 'unsupported website :(';
        setStatus(info.reason, false);
      } else {
        setUnsupportedMode(false);
        titleLine.textContent = 'Preview unavailable';
        setStatus(info.reason, true);
      }
      renderer.setBeatmap({ objects: [], mode: 0, comboColours: [] }, [], 1);
      state.currentTimeMs = 0;
      state.durationMs = 1;
      renderFrame();
      return;
    }

    if (info.setId) {
      addDebugLog(`init: active set id ${info.setId}`);
      configureAudioPreview(info.setId, 0);
    }

    let osuContent = '';
    const cached = await readCachedPreview();
    const isCacheUsable = Boolean(
      cached
      && cached.version === 1
      && cached.beatmapId === info.beatmapId
      && Number.isFinite(cached.savedAt)
      && (Date.now() - cached.savedAt) <= CACHE_MAX_AGE_MS
      && typeof cached.osuContent === 'string'
      && cached.osuContent.includes('[HitObjects]'),
    );

    if (isCacheUsable) {
      setStatus(`Loaded cached beatmap #${info.beatmapId}`);
      osuContent = cached.osuContent;
    } else {
      setStatus(`Fetching beatmap #${info.beatmapId}...`);
      osuContent = await fetchBeatmapFile(info.beatmapId);
      await writeCachedPreview({
        version: 1,
        beatmapId: info.beatmapId,
        sourceUrl: info.sourceUrl,
        savedAt: Date.now(),
        osuContent,
      });
    }

    const metadata = parseMetadata(osuContent);
    const mapData = parseMapPreviewData(osuContent, { maxObjects: 12000 });
    const breaks = parseBreakPeriods(osuContent);
    const resolvedSetId = info.setId || extractSetIdFromMetadata(metadata.beatmapSetID);
    addDebugLog(`init: resolved set id ${resolvedSetId || 'none'}`);

    if (!Array.isArray(mapData.objects) || mapData.objects.length === 0) {
      throw new Error('Beatmap has no readable hit objects.');
    }

    const durationMs = Math.max(mapData.maxObjectTime + 2000, 2000);

    state.metadata = metadata;
    state.mapData = mapData;
    state.breaks = breaks;
    state.durationMs = durationMs;
    state.currentTimeMs = clamp(metadata.previewTime > 0 ? metadata.previewTime : 0, 0, durationMs);
    configureAudioPreview(resolvedSetId, metadata.previewTime);

    renderer.setBeatmap(mapData, breaks, durationMs);
    setMetadataText();
    renderFrame();

    togglePlaybackButton.disabled = false;

    if (!state.hasAutoStarted) {
      state.hasAutoStarted = true;
      await togglePlayback();
    }

    if (resolvedSetId && metadata.audio) {
      void upgradeToFullAudioIfPossible(resolvedSetId, metadata.audio);
    } else {
      setAudioBadgeWithProvider(
        'preview',
        'Preview audio',
        PREVIEW_AUDIO_PROVIDER_LABEL,
        'Full audio not available for this beatmap',
      );
      addDebugLog('audio: metadata has no AudioFilename or set id');
    }
  } catch (error) {
    setUnsupportedMode(false);
    addDebugLog(`init: failed -> ${error?.message || 'unknown error'}`);
    stopPlayback();
    togglePlaybackButton.disabled = true;
    titleLine.textContent = 'Preview unavailable';
    versionLine.textContent = '';
    versionLine.title = '';
    configureAudioPreview(null, 0);
    setStatus(error?.message || 'Failed to load beatmap preview.', true);
    renderer.setBeatmap({ objects: [], mode: 0, comboColours: [] }, [], 1);
    state.currentTimeMs = 0;
    state.durationMs = 1;
    renderFrame();
  }
};

const startManualPlayback = () => {
  if (state.currentTimeMs >= state.durationMs) {
    state.currentTimeMs = 0;
  }
  state.playbackMode = 'manual';
  state.isPlaying = true;
  state.playStartPerfMs = performance.now();
  state.playStartMapMs = state.currentTimeMs;
  state.rafId = requestAnimationFrame(playbackTick);
  return true;
};

const startAudioPlayback = async () => {
  if (!state.audioSyncEnabled || !state.audio?.src) {
    return false;
  }

  try {
    const hasSeekTarget = seekAudioToMapTime(state.currentTimeMs);
    if (!hasSeekTarget) {
      return false;
    }
    state.audio.playbackRate = state.playbackSpeed;
    await state.audio.play();
    state.playbackMode = 'audio';
    state.isPlaying = true;
    state.rafId = requestAnimationFrame(playbackTick);
    return true;
  } catch {
    return false;
  }
};

const togglePlayback = async () => {
  if (!state.mapData || state.durationMs <= 0) {
    return false;
  }

  if (state.isPlaying) {
    stopPlayback();
    return false;
  }

  if (state.currentTimeMs >= state.durationMs) {
    state.currentTimeMs = 0;
  }

  const startedAudio = await startAudioPlayback();
  if (startedAudio) {
    return true;
  }
  return startManualPlayback();
};

const seekFromTimelineEvent = (event) => {
  if (!state.mapData || state.durationMs <= 0) {
    return;
  }

  const newTime = renderer.timeFromTimelineEvent(event);
  state.currentTimeMs = clamp(newTime, 0, state.durationMs);

  if (state.isPlaying && state.playbackMode === 'manual') {
    state.playStartPerfMs = performance.now();
    state.playStartMapMs = state.currentTimeMs;
  }

  if (state.playbackMode === 'audio' && state.audioSyncEnabled) {
    try {
      const hasTarget = seekAudioToMapTime(state.currentTimeMs);
      if (!hasTarget && state.isPlaying) {
        state.audio.pause();
        state.playbackMode = 'manual';
        state.playStartPerfMs = performance.now();
        state.playStartMapMs = state.currentTimeMs;
      }
    } catch {
      // Ignore seek errors; visual playback continues.
    }
  }

  renderFrame();
};

togglePlaybackButton.addEventListener('click', () => {
  cyclePlaybackSpeed();
});

playfieldCanvas.addEventListener('click', async () => {
  const wasPlaying = state.isPlaying;
  const isPlayingNow = await togglePlayback();
  if (isPlayingNow || wasPlaying) {
    showCanvasToggleFeedback(wasPlaying ? 'pause' : 'play');
  }
});

timelineCanvas.addEventListener('mousedown', (event) => {
  seekFromTimelineEvent(event);

  const onMove = (moveEvent) => {
    seekFromTimelineEvent(moveEvent);
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

audioStatusBadge?.addEventListener('click', () => {
  state.debugPanelOpen = !state.debugPanelOpen;
  renderDebugPanel();
});

debugRunButton?.addEventListener('click', async () => {
  debugRunButton.disabled = true;
  try {
    await runAudioFetchProbe();
  } finally {
    debugRunButton.disabled = false;
  }
});

debugClearButton?.addEventListener('click', () => {
  clearDebugLogs();
  addDebugLog('debug: logs cleared');
});

volumeSlider?.addEventListener('input', () => {
  const next = Number(volumeSlider.value) / 100;
  applyAudioVolume(next);

  if (state.volumePersistTimer) {
    clearTimeout(state.volumePersistTimer);
  }
  state.volumePersistTimer = setTimeout(async () => {
    state.volumePersistTimer = null;
    await writeAudioVolumeSetting(state.volume);
  }, 220);
});

volumeSlider?.addEventListener('change', async () => {
  const next = Number(volumeSlider.value) / 100;
  applyAudioVolume(next);
  if (state.volumePersistTimer) {
    clearTimeout(state.volumePersistTimer);
    state.volumePersistTimer = null;
  }
  await writeAudioVolumeSetting(state.volume);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.close();
  }
});

window.addEventListener('unload', () => {
  state.fullAudioJobId += 1;
  setFullAudioLoading(false);
  if (state.volumePersistTimer) {
    clearTimeout(state.volumePersistTimer);
    state.volumePersistTimer = null;
  }
  if (state.audioBadgeHideTimer) {
    clearTimeout(state.audioBadgeHideTimer);
    state.audioBadgeHideTimer = null;
  }
  stopPlayback();
  if (state.indicatorTimer) {
    clearTimeout(state.indicatorTimer);
    state.indicatorTimer = null;
  }
  if (state.fullAudioObjectUrl) {
    URL.revokeObjectURL(state.fullAudioObjectUrl);
    state.fullAudioObjectUrl = null;
  }
  stopUnsupportedAsciiAnimation();
});

applyAudioVolume(DEFAULT_AUDIO_VOLUME);
applyPlaybackSpeed(1);
renderDebugPanel();
initializePreviewForCurrentTab();
