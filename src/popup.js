import { parseMetadata, parseMapPreviewData, parseBreakPeriods } from './parser.js';
import { PreviewRenderer, clamp, formatTime } from './renderer.js';
import {
  PROVIDER_OVERRIDE_KEY,
  AUDIO_VOLUME_KEY,
  DEFAULT_AUDIO_VOLUME,
  MANIA_SCROLL_SPEED_KEY,
  MANIA_SCROLL_SCALE_WITH_BPM_KEY,
  MANIA_SCROLL_DIRECTION_KEY,
  MANIA_TIMING_NOTE_COLOURS_KEY,
  STANDARD_SNAKING_SLIDERS_KEY,
  STANDARD_SLIDER_SNAKE_OUT_KEY,
  STANDARD_SLIDER_END_CIRCLES_KEY,
  POPUP_SIZE_KEY,
  PROVIDER_PRIORITY_KEY,
  DISABLED_PROVIDERS_KEY,
  AUTO_FALLBACK_KEY,
  POPUP_SIZE_PRESETS,
  normalizeProviderOverride,
  normalizePreviewSettings,
} from './settings.js';
import {
  addRuntimeMessageListener,
  addStorageChangedListener,
  createTab,
  hasStorageArea,
  openOptionsPage,
  queryTabs,
  sendRuntimeMessage,
  storageGet,
  storageSet,
} from './webextension.js';
import { registry } from './core/cleanup.js';
import { buildCachedMapsetEntries } from './core/cachedMapsets.js';
import { extractBeatmapInfoFromUrl } from './core/beatmapUrl.js';
import { convertMapForMode } from './core/beatmapConversion.js';
import { getHistory, addToHistory, clearHistory, setHistoryDebugLogger } from './core/history.js';
import {
  state,
  resetState,
  setPlaybackState,
  setTimelineState,
  setUiState,
  setProviderState,
  setFullAudioState,
} from './core/state.js';
import { createTimingController } from './core/timing.js';
import {
  FULL_AUDIO_CACHE_NAME,
  getAudioMimeType,
  clearFullAudioCache,
  getFullAudioCacheUsage,
  normalizePath,
  pruneFullAudioCache,
  readCachedFullAudioBlob,
  setFullAudioCacheDebugLogger,
  writeCachedFullAudioBlob,
} from './audio/cache.js';
import { extractFullBeatmapAudio } from './audio/fullAudioExtractionCore.js';
import { getPreviewClipAnchorMapMs, isPreviewClipAnchorable, seekAudioElementToMapTime } from './audio/seek.js';
import {
  getProviderDisplayName,
  getProviderSequenceForDownload,
  loadProviderRuntimeState,
  probeArchiveSource,
  FETCH_TIMEOUT_MS,
  FETCH_TIMEOUT_FAILOVER_MS,
} from './audio/provider.js';
import { createPlaybackController } from './audio/playback.js';
import { createDebugPanelController } from './ui/debugPanel.js';
import { bindPopupUiEvents } from './ui/popupUI.js';
import { createUnsupportedViewController } from './ui/unsupportedView.js';

if (/firefox/i.test(globalThis.navigator?.userAgent || '')) {
  document.body?.classList.add('is-firefox-popup');
}

const IS_FIREFOX = /firefox|fxios/i.test(globalThis.navigator?.userAgent || '');
const IS_MOBILE_VIEW = /android|mobile|tablet|ipad|iphone|ipod/i.test(globalThis.navigator?.userAgent || '')
  || globalThis.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches;

const popup = document.querySelector('#mapPreviewPopup');
const titleLine = document.querySelector('#mapPreviewTitle');
const versionLine = document.querySelector('#mapPreviewVersion');
const timeLabel = document.querySelector('#mapPreviewTimeLabel');
const speedButton = document.querySelector('#mapPreviewSpeedBtn');
const speedControl = document.querySelector('#mapPreviewSpeedControl');
const speedSlider = document.querySelector('#mapPreviewSpeedSlider');
const speedResetButton = document.querySelector('#mapPreviewSpeedResetBtn');
const playfieldCanvas = document.querySelector('#mapPreviewCanvas');
const timelineCanvas = document.querySelector('#mapPreviewTimeline');
const volumeSlider = document.querySelector('#mapPreviewVolume');
const volumeLabel = document.querySelector('#mapPreviewVolumeLabel');
const toggleIndicator = document.querySelector('#mapPreviewToggleIndicator');
const unsupportedPanel = document.querySelector('#mapPreviewUnsupported');
const unsupportedAscii = document.querySelector('#mapPreviewUnsupportedAscii');
const audioStatusBadge = document.querySelector('#mapPreviewAudioBadge');
const popupToast = document.querySelector('#mapPreviewToast');
const debugPanel = document.querySelector('#mapPreviewDebugPanel');
const debugStatus = document.querySelector('#mapPreviewDebugStatus');
const debugLog = document.querySelector('#mapPreviewDebugLog');
const debugRunButton = document.querySelector('#mapPreviewDebugRunBtn');
const debugClearButton = document.querySelector('#mapPreviewDebugClearBtn');
const debugCloseButton = document.querySelector('#mapPreviewDebugCloseBtn');
const infoButtons = [...document.querySelectorAll('.js-map-preview-info-btn')];
const infoButton = infoButtons[0] || null;
const infoModal = document.querySelector('#mapPreviewInfoModal');
const infoBackdrop = document.querySelector('#mapPreviewInfoBackdrop');
const infoCloseButton = document.querySelector('#mapPreviewInfoCloseBtn');
const infoOptionsButton = document.querySelector('#mapPreviewInfoOptionsBtn');
const infoIssueButton = document.querySelector('#mapPreviewInfoIssueBtn');
const infoOsuButton = document.querySelector('#mapPreviewInfoOsuBtn');
const shortcutsButton = document.querySelector('#mapPreviewHelpBtn');
const shortcutsModal = document.querySelector('#mapPreviewShortcutsModal');
const shortcutsBackdrop = document.querySelector('#mapPreviewShortcutsBackdrop');
const shortcutsCloseButton = document.querySelector('#mapPreviewShortcutsCloseBtn');

const recentPanel = document.querySelector('#mapPreviewRecentPanel');
const recentList = document.querySelector('#mapPreviewRecentList');
const recentClearBtn = document.querySelector('#mapPreviewRecentClearBtn');

let lastInfoFocus = null;
let lastShortcutsFocus = null;
const MODAL_TRANSITION_MS = 180;
const modalHideTimers = new WeakMap();

const restoreFocus = (preferredElement, fallbackElement) => {
  const target = preferredElement instanceof HTMLElement
    && document.contains(preferredElement)
    && preferredElement.offsetParent !== null
    ? preferredElement
    : fallbackElement;
  target?.focus?.();
};

const setModalShellVisible = (modalShell, isVisible) => {
  if (!modalShell) {
    return;
  }

  const hideTimer = modalHideTimers.get(modalShell);
  if (hideTimer) {
    registry.clearTimeout(hideTimer);
    modalHideTimers.delete(modalShell);
  }

  if (isVisible) {
    modalShell.hidden = false;
    modalShell.classList.remove('is-closing');
    modalShell.classList.add('is-visible');
    void modalShell.offsetWidth;
    modalShell.classList.add('is-open');
    return;
  }

  modalShell.classList.remove('is-open');
  modalShell.classList.add('is-closing');
  const nextHideTimer = registry.addTimeout(setTimeout(() => {
    modalShell.hidden = true;
    modalShell.classList.remove('is-visible', 'is-closing');
    modalHideTimers.delete(modalShell);
  }, MODAL_TRANSITION_MS));
  modalHideTimers.set(modalShell, nextHideTimer);
};

const renderer = new PreviewRenderer(playfieldCanvas, timelineCanvas);
const CACHE_KEY = 'mosuPreviewCacheV1';
const CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 12;
const AUDIO_PREVIEW_BASE = 'https://b.ppy.sh/preview';
const AUDIO_BADGE_AUTO_HIDE_DELAY_MS = 3500;
const DEBUG_LOG_LIMIT = 80;
const PREVIEW_AUDIO_PROVIDER_LABEL = 'b.ppy.sh';
const CACHE_AUDIO_PROVIDER_LABEL = 'cache';
// Matches lazer's rate adjust range and precision.
const MIN_PLAYBACK_SPEED = 0.1;
const MAX_PLAYBACK_SPEED = 2;
const PLAYBACK_SPEED_STEP = 0.05;
const PLAYBACK_SPEED_CYCLE = [1, 0.75, 0.5, 1.5];
// Marathon maps run well past 12k objects (a 60-minute map is comfortably over
// 20k). Parsing all of them costs ~40MB and ~300ms, and rendering is windowed,
// so the old cap only served to cut the timeline short.
const MAX_PREVIEW_OBJECTS = 40000;
const AUDIO_VISUAL_SYNC_INTERVAL_MS = 240;
const AUDIO_VISUAL_SYNC_THRESHOLD_MS = 90;
const SUPPORT_LINKS = {
  issue: 'https://github.com/fax1015/mosu-preview/issues/new',
  osu: 'https://osu.ppy.sh/users/faxaxaxa',
};
const UNSUPPORTED_ASCII_TICK_MS = 240;
const UNSUPPORTED_ASCII_CHAR_WIDTH_PX = 6.2;
const UNSUPPORTED_ASCII_CHAR_HEIGHT_PX = 11.2;
const UNSUPPORTED_ASCII_XY_RATIO = UNSUPPORTED_ASCII_CHAR_WIDTH_PX / UNSUPPORTED_ASCII_CHAR_HEIGHT_PX;

const setFullAudioObjectUrl = (newUrl) => {
  if (state.fullAudioObjectUrl) {
    URL.revokeObjectURL(state.fullAudioObjectUrl);
  }
  state.fullAudioObjectUrl = newUrl || null;
};

const hasFullAudioSource = () => (
  state.audioSyncEnabled
  && Boolean(state.fullAudioObjectUrl)
  && typeof state.audio?.src === 'string'
  && state.audio.src === state.fullAudioObjectUrl
);

// True while the visual preview should keep advancing even though the audio
// element has nothing left to play: either full audio is still downloading, or
// we only ever had the short b.ppy.sh preview clip. Freezing the timeline ~10
// seconds into an hour-long marathon is never the right answer.
const shouldContinueTimelineWithoutFullAudio = () => (
  state.audioSyncEnabled
  && !hasFullAudioSource()
  && state.currentTimeMs < (state.durationMs - 1)
);

const getResolvedPlaybackDurationMs = () => {
  const mappedDurationMs = Number.isFinite(state.mappedDurationMs) && state.mappedDurationMs > 0
    ? state.mappedDurationMs
    : 1;

  if (!hasFullAudioSource()) {
    return mappedDurationMs;
  }

  const audioDurationMs = Number.isFinite(state.audio?.duration) && state.audio.duration > 0
    ? Math.round((state.audio.duration * 1000) + state.audioAnchorMapMs)
    : 0;

  return Math.max(mappedDurationMs, audioDurationMs, 1);
};

// The timestamp reserves room for the widest label this duration can produce,
// measured once per duration rather than per frame: sizing it to the live text
// would make the whole control row twitch every time a digit rolled over.
const syncTimeLabelWidth = () => {
  if (!timeLabel) {
    return;
  }

  const durationLabel = formatTime(state.durationMs);
  // The elapsed side never renders wider than the duration side, and the label
  // uses tabular figures, so zeros stand in for whichever digits show up.
  const widestLabel = `${durationLabel} / ${durationLabel}`.replace(/\d/g, '0');
  const restoreText = timeLabel.textContent;

  // Measured on the label itself so the real font, letter spacing and padding
  // are accounted for. Both writes land in the same task, so nothing paints
  // between them.
  timeLabel.style.setProperty('--map-preview-time-label-width', 'auto');
  timeLabel.textContent = widestLabel;
  const measuredPx = Math.ceil(timeLabel.getBoundingClientRect().width);
  timeLabel.textContent = restoreText;
  timeLabel.style.setProperty(
    '--map-preview-time-label-width',
    measuredPx > 0 ? `${measuredPx}px` : `${widestLabel.length}ch`,
  );
};

const syncPlaybackDuration = () => {
  const previousDurationMs = state.durationMs;
  const nextDurationMs = getResolvedPlaybackDurationMs();
  setTimelineState({
    durationMs: nextDurationMs,
    currentTimeMs: clamp(state.currentTimeMs, 0, nextDurationMs),
  });
  if (nextDurationMs !== previousDurationMs) {
    syncTimeLabelWidth();
  }
  const shouldAnimateTimeline = hasFullAudioSource() && nextDurationMs > previousDurationMs;
  const isAnimatingTimeline = renderer.setDuration(nextDurationMs, { animate: shouldAnimateTimeline });
  if (isAnimatingTimeline) {
    ensureTimelineDurationAnimation();
  }
};

const stopTimelineDurationAnimation = () => {
  if (state.timelineAnimationRafId !== null) {
    cancelAnimationFrame(state.timelineAnimationRafId);
    state.timelineAnimationRafId = null;
  }
};

const tickTimelineDurationAnimation = () => {
  state.timelineAnimationRafId = null;

  if (state.isPlaying) {
    return;
  }

  renderFrame();

  if (renderer.isTimelineDurationAnimating()) {
    state.timelineAnimationRafId = requestAnimationFrame(tickTimelineDurationAnimation);
  }
};

const ensureTimelineDurationAnimation = () => {
  if (state.isPlaying || state.timelineAnimationRafId !== null || !renderer.isTimelineDurationAnimating()) {
    return;
  }

  state.timelineAnimationRafId = requestAnimationFrame(tickTimelineDurationAnimation);
};

state.audio.addEventListener('canplay', syncPlaybackDuration);
state.audio.addEventListener('error', () => {
  state.audioSyncEnabled = false;
  syncPlaybackDuration();
});
state.audio.addEventListener('loadedmetadata', syncPlaybackDuration);
state.audio.addEventListener('durationchange', syncPlaybackDuration);
state.audio.addEventListener('emptied', syncPlaybackDuration);
state.audio.addEventListener('playing', () => {
  if (state.playbackMode === 'audio') {
    resyncVisualPlaybackToAudio({ force: true });
  }
});
state.audio.addEventListener('seeked', () => {
  if (state.playbackMode === 'audio') {
    resyncVisualPlaybackToAudio({ force: true });
  }
});
state.audio.addEventListener('timeupdate', () => {
  if (state.playbackMode === 'audio') {
    resyncVisualPlaybackToAudio();
  }
});
state.audio.addEventListener('ended', () => {
  if (state.playbackMode === 'audio') {
    syncVisualClockToMapTime(getAudioMappedTimeMs());
  }
  state.currentTimeMs = clamp(state.currentTimeMs, 0, state.durationMs || 1);
  renderFrame();

  if (state.isPlaying && shouldContinueTimelineWithoutFullAudio()) {
    switchToManualTimeline();
    ensurePlaybackLoop();
    return;
  }

  stopPlayback();
});

const debugPanelController = createDebugPanelController({
  state,
  debugPanel,
  debugStatus,
  debugLog,
  debugLogLimit: DEBUG_LOG_LIMIT,
  getProviderDisplayName,
});
const {
  render: renderDebugPanel,
  addLog: addDebugLog,
  clearLogs: clearDebugLogs,
  setOpen: setDebugPanelOpen,
  toggleOpen: toggleDebugPanelOpen,
} = debugPanelController;
setFullAudioCacheDebugLogger(addDebugLog);
setHistoryDebugLogger(addDebugLog);

const unsupportedViewController = createUnsupportedViewController({
  popup,
  unsupportedPanel,
  unsupportedAscii,
  state,
  registry,
  clamp,
  config: {
    tickMs: UNSUPPORTED_ASCII_TICK_MS,
    charWidthPx: UNSUPPORTED_ASCII_CHAR_WIDTH_PX,
    charHeightPx: UNSUPPORTED_ASCII_CHAR_HEIGHT_PX,
    xyRatio: UNSUPPORTED_ASCII_XY_RATIO,
  },
});
const {
  setUnsupportedMode,
  stopUnsupportedAsciiAnimation,
} = unsupportedViewController;

const renderInfoMenu = () => {
  if (infoModal) {
    setModalShellVisible(infoModal, state.infoMenuOpen || state.shortcutsMenuOpen);
    infoModal.classList.toggle('is-background-menu', state.shortcutsMenuOpen);
  }

  infoButtons.forEach((button) => {
    button.setAttribute('aria-expanded', (state.infoMenuOpen || state.shortcutsMenuOpen) ? 'true' : 'false');
  });
};

const setInfoMenuOpen = (isOpen) => {
  if (isOpen) {
    lastInfoFocus = document.activeElement instanceof HTMLElement ? document.activeElement : infoButton;
  }
  setUiState({ infoMenuOpen: isOpen, shortcutsMenuOpen: isOpen ? state.shortcutsMenuOpen : false });
  renderInfoMenu();
  renderShortcutsMenu();
  if (isOpen) {
    infoCloseButton?.focus();
  } else if (lastInfoFocus) {
    restoreFocus(lastInfoFocus, infoButton);
    lastInfoFocus = null;
  }
};

const openSupportLink = async (url) => {
  if (!url) {
    return;
  }

  try {
    await createTab({ url });
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  setInfoMenuOpen(false);
};

const renderShortcutsMenu = () => {
  if (shortcutsModal) {
    setModalShellVisible(shortcutsModal, state.shortcutsMenuOpen);
  }
};

// The shortcuts dialog normally sits on top of the info menu, but the `?`
// shortcut can open it directly from anywhere. Remember which route was taken
// so closing it returns to the right place instead of revealing an info menu
// the user never opened.
let shortcutsOpenedFromInfoMenu = false;

const setShortcutsMenuOpen = (isOpen) => {
  if (isOpen) {
    lastShortcutsFocus = document.activeElement instanceof HTMLElement ? document.activeElement : shortcutsButton;
    shortcutsOpenedFromInfoMenu = state.infoMenuOpen;
    setUiState({ infoMenuOpen: true, shortcutsMenuOpen: true });
  } else {
    setUiState({ infoMenuOpen: shortcutsOpenedFromInfoMenu, shortcutsMenuOpen: false });
    shortcutsOpenedFromInfoMenu = false;
  }
  renderInfoMenu();
  renderShortcutsMenu();
  if (isOpen) {
    shortcutsCloseButton?.focus();
  } else if (lastShortcutsFocus) {
    restoreFocus(lastShortcutsFocus, shortcutsButton);
    lastShortcutsFocus = null;
  }
};

const getCachedSetIds = async () => {
  if (!('caches' in globalThis)) return null;
  try {
    const cache = await caches.open(FULL_AUDIO_CACHE_NAME);
    const requests = await cache.keys();
    const setIds = new Set();
    for (const req of requests) {
      const match = req.url.match(/beatmapsets\/(\d+)\/audio\//);
      if (match) {
        setIds.add(match[1]);
      }
    }
    return setIds.size > 0 ? setIds : null;
  } catch {
    return null;
  }
};

const formatBytes = (bytes) => {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
};

const updateRecentClearButtonCacheUsage = async () => {
  if (!recentClearBtn) {
    return;
  }

  const usage = await getFullAudioCacheUsage();
  const label = `Clear cache (${formatBytes(usage.bytes)} used)`;
  recentClearBtn.title = label;
  recentClearBtn.setAttribute('aria-label', label);
};

const renderRecentPanel = async () => {
  if (!recentPanel || !recentList) return;

  const cachedSetIds = await getCachedSetIds();
  if (!cachedSetIds || cachedSetIds.size === 0) {
    recentPanel.hidden = true;
    return;
  }

  const history = await getHistory();
  const cachedEntries = buildCachedMapsetEntries(cachedSetIds, history);

  recentPanel.hidden = false;
  void updateRecentClearButtonCacheUsage();
  recentList.innerHTML = '';

  cachedEntries.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'map-preview-recent-item';
    const thumbnail = document.createElement('div');
    thumbnail.className = 'map-preview-recent-thumbnail';
    const safeSetId = /^\d+$/.test(String(entry.beatmapSetId || ''))
      ? String(entry.beatmapSetId)
      : '';
    if (safeSetId) {
      thumbnail.style.backgroundImage = `url("https://assets.ppy.sh/beatmaps/${safeSetId}/covers/list.jpg")`;
    }

    const info = document.createElement('div');
    info.className = 'map-preview-recent-info';

    const title = document.createElement('div');
    title.className = 'map-preview-recent-item-title';
    title.textContent = entry.title || `Beatmap set #${safeSetId || 'unknown'}`;

    const meta = document.createElement('div');
    meta.className = 'map-preview-recent-item-meta';
    meta.textContent = entry.artist || entry.creator
      ? `${entry.artist || 'Unknown artist'} // ${entry.creator || 'Unknown creator'}`
      : 'Cached full audio';

    info.appendChild(title);
    info.appendChild(meta);
    item.appendChild(thumbnail);
    item.appendChild(info);
    item.addEventListener('click', () => {
      if (!safeSetId) {
        return;
      }
      createTab({ url: `https://osu.ppy.sh/beatmapsets/${safeSetId}` });
    });
    recentList.appendChild(item);
  });
};

const openExtensionOptions = async () => {
  try {
    await openOptionsPage();
  } catch {
    await createTab({ url: 'options.html' });
  }
  setInfoMenuOpen(false);
  if (IS_FIREFOX && IS_MOBILE_VIEW) {
    showPopupToast('settings page opened, exit this view to see settings');
  }
};

const showPopupToast = (message, hideDelayMs = 3500) => {
  if (!popupToast) {
    return;
  }

  state.toastHideTimer = registry.clearTimeout(state.toastHideTimer);

  popupToast.textContent = message;
  popupToast.classList.add('is-visible');
  state.toastHideTimer = registry.addTimeout(setTimeout(() => {
    popupToast.classList.remove('is-visible');
    state.toastHideTimer = null;
  }, hideDelayMs));
};


const readProviderOverrideSetting = async () => {
  try {
    const items = await storageGet('sync', [PROVIDER_OVERRIDE_KEY]);
    return normalizeProviderOverride(items?.[PROVIDER_OVERRIDE_KEY]);
  } catch {
    return 'auto';
  }
};

const readAudioVolumeSetting = async () => {
  try {
    const items = await storageGet('sync', [AUDIO_VOLUME_KEY]);
    const candidate = Number(items?.[AUDIO_VOLUME_KEY]);
    if (!Number.isFinite(candidate)) {
      return DEFAULT_AUDIO_VOLUME;
    }
    return clamp(candidate, 0, 1);
  } catch {
    return DEFAULT_AUDIO_VOLUME;
  }
};

const readPreviewSettings = async () => {
  try {
    const items = await storageGet('sync', [
      MANIA_SCROLL_SPEED_KEY,
      MANIA_SCROLL_SCALE_WITH_BPM_KEY,
      MANIA_SCROLL_DIRECTION_KEY,
      MANIA_TIMING_NOTE_COLOURS_KEY,
      STANDARD_SNAKING_SLIDERS_KEY,
      STANDARD_SLIDER_SNAKE_OUT_KEY,
      STANDARD_SLIDER_END_CIRCLES_KEY,
      POPUP_SIZE_KEY,
      PROVIDER_PRIORITY_KEY,
      DISABLED_PROVIDERS_KEY,
      AUTO_FALLBACK_KEY,
    ]);
    return normalizePreviewSettings(items);
  } catch {
    return normalizePreviewSettings();
  }
};

const writeAudioVolumeSetting = async (volume) => {
  try {
    await storageSet('sync', { [AUDIO_VOLUME_KEY]: clamp(volume, 0, 1) });
    return true;
  } catch {
    return false;
  }
};

const applyAudioVolume = (volume) => {
  const nextVolume = clamp(Number.isFinite(volume) ? volume : DEFAULT_AUDIO_VOLUME, 0, 1);
  state.volume = nextVolume;
  state.audio.volume = nextVolume;

  if (volumeSlider) {
    volumeSlider.value = String(Math.round(nextVolume * 100));
    volumeSlider.style.setProperty('--range-progress', `${Math.round(nextVolume * 100)}%`);
  }
  if (volumeLabel) {
    volumeLabel.textContent = `${Math.round(nextVolume * 100)}%`;
  }
};

const applyPopupSize = (popupSize) => {
  const normalized = normalizePreviewSettings({ popupSize }).popupSize;
  const preset = POPUP_SIZE_PRESETS[normalized] || POPUP_SIZE_PRESETS.default;

  setUiState({ popupSize: normalized });
  document.documentElement.style.setProperty('--popup-shell-width', `${preset.shellWidth}px`);
  document.documentElement.style.setProperty('--popup-content-width', `${preset.contentWidth}px`);
  document.documentElement.style.setProperty('--popup-shell-width-mobile', `${preset.mobileShellWidth}px`);
  document.documentElement.style.setProperty('--popup-content-width-mobile', `${preset.mobileContentWidth}px`);
};

const applyPreviewSettings = (settings = {}) => {
  const normalized = normalizePreviewSettings(settings);
  state.maniaScrollSpeed = normalized.maniaScrollSpeed;
  state.maniaScaleScrollSpeedWithBpm = normalized.maniaScaleScrollSpeedWithBpm;
  state.maniaScrollDirection = normalized.maniaScrollDirection;
  state.maniaTimingNoteColours = normalized.maniaTimingNoteColours;
  state.standardSnakingSliders = normalized.standardSnakingSliders;
  state.standardSliderSnakeOut = normalized.standardSliderSnakeOut;
  state.standardSliderEndCircles = normalized.standardSliderEndCircles;
  state.providerPriority = normalized.providerPriority;
  state.disabledProviders = normalized.disabledProviders;
  state.autoFallback = normalized.autoFallback;
  applyPopupSize(normalized.popupSize);
  renderer.setPreviewSettings(normalized);
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

const normalizePlaybackSpeed = (speed) => {
  const value = Number(speed);
  if (!Number.isFinite(value)) {
    return 1;
  }
  const stepped = Math.round(value / PLAYBACK_SPEED_STEP) * PLAYBACK_SPEED_STEP;
  return Number(clamp(stepped, MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED).toFixed(2));
};

const syncPlaybackSpeedControls = () => {
  const label = formatPlaybackSpeedLabel(state.playbackSpeed);

  if (speedButton) {
    speedButton.textContent = label;
    speedButton.title = `Playback speed (${label})`;
  }

  if (speedSlider) {
    const percent = Math.round(state.playbackSpeed * 100);
    if (Number(speedSlider.value) !== percent) {
      speedSlider.value = String(percent);
    }
    const min = Number(speedSlider.min) || MIN_PLAYBACK_SPEED * 100;
    const max = Number(speedSlider.max) || MAX_PLAYBACK_SPEED * 100;
    const progress = ((percent - min) / Math.max(1, max - min)) * 100;
    speedSlider.style.setProperty('--range-progress', `${clamp(progress, 0, 100)}%`);
    speedSlider.setAttribute('aria-valuetext', label);
  }

  if (speedResetButton) {
    const canReset = state.playbackSpeed !== 1 && !speedButton?.disabled;
    speedResetButton.classList.toggle('is-visible', canReset);
    speedResetButton.disabled = !canReset;
  }
};

const setPlaybackSpeedControlEnabled = (enabled) => {
  if (speedButton) {
    speedButton.disabled = !enabled;
  }
  if (speedSlider) {
    speedSlider.disabled = !enabled;
  }
  if (!enabled) {
    speedControl?.classList.remove('is-speed-open');
    speedButton?.setAttribute('aria-expanded', 'false');
  }
  syncPlaybackSpeedControls();
};

const timingController = createTimingController({
  state,
  clamp,
  thresholdMs: AUDIO_VISUAL_SYNC_THRESHOLD_MS,
});
const {
  getCurrentManualMapTime,
  syncVisualClockToMapTime,
  getAudioMappedTimeMs,
  resyncVisualPlaybackToAudio,
} = timingController;

const applyPlaybackSpeed = (nextSpeed) => {
  const normalized = normalizePlaybackSpeed(nextSpeed);

  if (state.isPlaying) {
    const now = performance.now();
    state.currentTimeMs = clamp(getCurrentManualMapTime(now), 0, state.durationMs || 1);
    state.playStartMapMs = state.currentTimeMs;
    state.playStartPerfMs = now;
  }

  state.playbackSpeed = normalized;
  state.audio.playbackRate = normalized;
  syncPlaybackSpeedControls();

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

  state.audioBadgeHideTimer = registry.clearTimeout(state.audioBadgeHideTimer);

  audioStatusBadge.classList.remove('is-hidden');
  audioStatusBadge.classList.remove('is-preview', 'is-loading', 'is-ready', 'is-failed');
  audioStatusBadge.classList.add(`is-${stateName}`);
  audioStatusBadge.textContent = label;
  audioStatusBadge.title = tooltip || label;

  if (stateName === 'ready') {
    state.audioBadgeHideTimer = registry.addTimeout(setTimeout(() => {
      audioStatusBadge.classList.add('is-hidden');
      state.audioBadgeHideTimer = null;
    }, AUDIO_BADGE_AUTO_HIDE_DELAY_MS));
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

const formatArchiveDownloadSize = (bytes) => {
  if (!(typeof bytes === 'number') || bytes < 0) {
    return '';
  }
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? `${mb.toFixed(1)} MB` : `${mb.toFixed(2)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
};

const buildArchiveProviderProgressParts = (progress) => {
  if (!progress || typeof progress.loaded !== 'number' || progress.loaded < 0) {
    return { providerSuffix: '', tooltipDownload: '' };
  }
  const { loaded } = progress;
  const total = typeof progress.total === 'number' && progress.total > 0 ? progress.total : null;
  if (total !== null) {
    const pct = Math.min(100, Math.round((100 * loaded) / total));
    return {
      providerSuffix: ` · ${pct}%`,
      tooltipDownload: `${formatArchiveDownloadSize(loaded)} / ${formatArchiveDownloadSize(total)}`,
    };
  }
  return {
    providerSuffix: ` · ${formatArchiveDownloadSize(loaded)}`,
    tooltipDownload: `${formatArchiveDownloadSize(loaded)} received`,
  };
};

const showTryingArchiveProviderBadge = (providerLabel, progress) => {
  const label = String(providerLabel || '').trim()
    || getProviderDisplayName(state.providerOverride);
  setProviderState({ currentArchiveProviderLabel: label });
  const { providerSuffix, tooltipDownload } = buildArchiveProviderProgressParts(progress);
  const providerLine = `${label}${providerSuffix}`;
  const title = tooltipDownload
    ? `Fetching beatmap archive from ${label} — ${tooltipDownload}`
    : `Fetching beatmap archive from ${label}`;
  setAudioBadgeWithProvider(
    'loading',
    'Loading full audio',
    providerLine,
    title,
  );
};

// `requireFreshEvent` is for the case where the source was just swapped: the
// element can still report the previous source's readyState for a tick, so the
// caller has to wait for an actual event rather than trust it.
const waitForAudioElementReady = (
  audioElement,
  { timeoutMs = 10000, requireFreshEvent = false } = {},
) => new Promise((resolve) => {
  if (!requireFreshEvent && audioElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
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
    registry.clearTimeout(timer);
    audioElement.removeEventListener('canplay', onReady);
    audioElement.removeEventListener('loadeddata', onReady);
    audioElement.removeEventListener('error', onError);
  };

  const timer = registry.addTimeout(setTimeout(onTimeout, timeoutMs));
  audioElement.addEventListener('canplay', onReady);
  audioElement.addEventListener('loadeddata', onReady);
  audioElement.addEventListener('error', onError);
});

const waitForAudioElementSeek = (audioElement, timeoutMs = 2500) => new Promise((resolve) => {
  if (!audioElement?.src || audioElement.seeking === false) {
    resolve(true);
    return;
  }

  const onSeeked = () => {
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
    registry.clearTimeout(timer);
    audioElement.removeEventListener('seeked', onSeeked);
    audioElement.removeEventListener('error', onError);
  };

  const timer = registry.addTimeout(setTimeout(onTimeout, timeoutMs));
  audioElement.addEventListener('seeked', onSeeked, { once: true });
  audioElement.addEventListener('error', onError, { once: true });
});

const setAudioElementSource = (sourceUrl, anchorMapMs) => {
  state.audioSyncEnabled = Boolean(sourceUrl);
  state.lastAudioVisualSyncPerfMs = 0;
  state.audioAnchorMapMs = Math.max(0, Number.isFinite(anchorMapMs) ? anchorMapMs : 0);
  state.audio.playbackRate = state.playbackSpeed;
  if (!sourceUrl) {
    state.audio.removeAttribute('src');
    state.audio.load();
    syncPlaybackDuration();
    return;
  }

  if (state.audio.src !== sourceUrl) {
    state.audio.src = sourceUrl;
    state.audio.load();
    state.audio.playbackRate = state.playbackSpeed;
    syncPlaybackDuration();
    return true;
  }
  return false;
};

const renderFrame = () => {
  renderer.setTime(state.currentTimeMs);
  renderer.render();
  timeLabel.textContent = `${renderer.getCurrentLabel()} / ${renderer.getDurationLabel()}`;
};

const {
  clearCurrentRaf,
  ensurePlaybackLoop,
  switchToManualTimeline,
  stopPlayback,
  togglePlayback,
  seekTo,
  seekRelative,
  restartPreview,
} = createPlaybackController({
  state,
  config: {
    audioVisualSyncIntervalMs: AUDIO_VISUAL_SYNC_INTERVAL_MS,
  },
  helpers: {
    ensureTimelineDurationAnimation,
    getCurrentManualMapTime,
    syncVisualClockToMapTime,
    resyncVisualPlaybackToAudio,
    renderFrame,
  },
});

const showCanvasToggleFeedback = (action) => {
  if (!toggleIndicator) {
    return;
  }

  state.indicatorTimer = registry.clearTimeout(state.indicatorTimer);

  toggleIndicator.classList.remove('is-visible', 'is-play', 'is-pause');
  void toggleIndicator.offsetWidth;
  toggleIndicator.classList.add(action === 'pause' ? 'is-pause' : 'is-play');
  toggleIndicator.classList.add('is-visible');

  state.indicatorTimer = registry.addTimeout(setTimeout(() => {
    toggleIndicator.classList.remove('is-visible', 'is-play', 'is-pause');
    state.indicatorTimer = null;
  }, 400));
};

const setStatus = (text, isError = false) => {
  titleLine.title = text || '';
  versionLine.title = versionLine.textContent || '';
  if (isError) {
    titleLine.textContent = 'Preview unavailable';
  }
};

const toggleMute = () => {
  if (state.volume > 0) {
    state.preMuteVolume = state.volume;
    applyAudioVolume(0);
  } else {
    applyAudioVolume(state.preMuteVolume || 0.8);
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
  setFullAudioState({
    previewSetId: null,
    activeSetId: null,
    fullAudioSetId: null,
    fullAudioStatus: 'idle',
    fullAudioCacheKey: '',
    fullAudioError: '',
  });
  setProviderState({ currentArchiveProviderLabel: '' });
  setFullAudioLoading(false);
  setAudioBadgeWithProvider('preview', 'Preview audio', PREVIEW_AUDIO_PROVIDER_LABEL);

  setFullAudioObjectUrl(null);

  if (!setId || !/^\d+$/.test(String(setId))) {
    setAudioElementSource('', 0);
    return;
  }

  const normalizedSetId = String(setId);
  setFullAudioState({
    previewSetId: normalizedSetId,
    activeSetId: normalizedSetId,
  });

  // The b.ppy.sh clip is a ~10s excerpt with a 100ms lead-in before the
  // beatmap's PreviewTime. When PreviewTime is -1 (or absent) osu! generates the
  // clip from ~40% into the track instead, and that offset is not derivable from
  // the .osu file. Anchoring it at 0 anyway played the middle of the song over
  // the start of the map — a large, constant desync. Better to stay silent until
  // full audio arrives.
  if (!isPreviewClipAnchorable(previewTimeMs)) {
    setAudioElementSource('', 0);
    setAudioBadgeWithProvider(
      'preview',
      'No preview point',
      PREVIEW_AUDIO_PROVIDER_LABEL,
      'This beatmap has no preview point, so the short preview clip cannot be lined up with the map. Waiting for full audio.',
    );
    return;
  }

  const nextSrc = `${AUDIO_PREVIEW_BASE}/${normalizedSetId}.mp3`;
  setAudioElementSource(nextSrc, getPreviewClipAnchorMapMs(previewTimeMs));
};

const hotswapToFullAudio = async (audioBlob, setId, sourceAudioFilename, jobId, providerLabel = '') => {
  if (!audioBlob || !setId || jobId !== state.fullAudioJobId) {
    return false;
  }

  addDebugLog(`audio: hotswap start (${sourceAudioFilename}, ${Math.round(audioBlob.size / 1024)} KB)`);
  // Only used for the preflight probe below, which just needs *some* valid
  // position. The real commit re-reads the playhead (see commitMapTimeMs).
  const preflightMapTimeMs = state.currentTimeMs;
  const wasPlaying = state.isPlaying;
  const fullAudioUrl = URL.createObjectURL(audioBlob);

  try {
    const testAudio = new Audio();
    const releaseTestAudio = () => {
      testAudio.removeAttribute('src');
      testAudio.load();
    };
    testAudio.preload = 'auto';
    testAudio.src = fullAudioUrl;
    testAudio.load();

    const ready = await waitForAudioElementReady(testAudio);
    if (!ready || jobId !== state.fullAudioJobId) {
      addDebugLog('audio: hotswap failed, media element not ready');
      releaseTestAudio();
      URL.revokeObjectURL(fullAudioUrl);
      return false;
    }

    let testSeekOk = false;
    try {
      testSeekOk = seekAudioElementToMapTime(testAudio, preflightMapTimeMs, 0, { requireCoverage: false });
    } catch {
      testSeekOk = false;
    }

    if (!testSeekOk) {
      addDebugLog('audio: hotswap failed, preflight seek rejected');
      releaseTestAudio();
      URL.revokeObjectURL(fullAudioUrl);
      return false;
    }

    const testSeekSettled = await waitForAudioElementSeek(testAudio);
    releaseTestAudio();
    if (!testSeekSettled || jobId !== state.fullAudioJobId) {
      addDebugLog('audio: hotswap failed, preflight seek did not settle');
      URL.revokeObjectURL(fullAudioUrl);
      return false;
    }
  } catch (error) {
    addDebugLog(`audio: hotswap preflight failed (${error?.message || 'unknown error'})`);
    URL.revokeObjectURL(fullAudioUrl);
    return false;
  }

  if (state.audio && !state.audio.paused) {
    state.audio.pause();
  }

  const previousAudioState = {
    src: state.audio?.src || '',
    anchorMapMs: state.audioAnchorMapMs,
    syncEnabled: state.audioSyncEnabled,
    fullAudioObjectUrl: state.fullAudioObjectUrl,
  };
  const rollbackCommittedSwap = () => {
    URL.revokeObjectURL(fullAudioUrl);
    state.fullAudioObjectUrl = previousAudioState.fullAudioObjectUrl || null;
    setAudioElementSource(previousAudioState.src, previousAudioState.anchorMapMs);
    state.audioSyncEnabled = previousAudioState.syncEnabled;
  };

  state.fullAudioObjectUrl = fullAudioUrl;
  const sourceChanged = setAudioElementSource(fullAudioUrl, 0);
  const realReady = await waitForAudioElementReady(state.audio, { requireFreshEvent: sourceChanged });
  if (!realReady || jobId !== state.fullAudioJobId) {
    addDebugLog('audio: hotswap failed, media element not ready after commit');
    rollbackCommittedSwap();
    return false;
  }

  syncPlaybackDuration();

  // Re-read the playhead instead of reusing the value captured before the four
  // awaits above. The visual timeline keeps running while the element loads and
  // seeks, and the user can scrub during that window, so committing the stale
  // timestamp silently threw their seek away and dropped the map back to
  // wherever it was when the swap started.
  const commitMapTimeMs = state.currentTimeMs;
  if (Math.abs(commitMapTimeMs - preflightMapTimeMs) > 1) {
    addDebugLog(`audio: playhead moved during hotswap, committing at ${Math.round(commitMapTimeMs)}ms`);
  }

  let hasSyncedSeek = false;
  try {
    // Full audio may be marginally shorter than the mapped duration, so clamp
    // rather than refuse when the playhead sits in that tail.
    hasSyncedSeek = seekAudioElementToMapTime(
      state.audio,
      commitMapTimeMs,
      state.audioAnchorMapMs,
      { requireCoverage: false },
    );
  } catch {
    hasSyncedSeek = false;
  }

  if (!hasSyncedSeek) {
    addDebugLog('audio: hotswap failed, seek sync rejected after commit');
    rollbackCommittedSwap();
    return false;
  }

  const seekSettled = await waitForAudioElementSeek(state.audio);
  if (!seekSettled || jobId !== state.fullAudioJobId) {
    addDebugLog('audio: hotswap failed, seek did not settle after commit');
    rollbackCommittedSwap();
    return false;
  }

  if (previousAudioState.fullAudioObjectUrl && previousAudioState.fullAudioObjectUrl !== fullAudioUrl) {
    URL.revokeObjectURL(previousAudioState.fullAudioObjectUrl);
  }

  setFullAudioState({
    fullAudioSetId: String(setId),
    fullAudioStatus: 'ready',
    fullAudioCacheKey: `${setId}:${normalizePath(sourceAudioFilename).toLowerCase()}`,
    fullAudioError: '',
  });
  setAudioBadgeWithProvider(
    'ready',
    'Full audio ready',
    providerLabel,
    `Using full audio: ${sourceAudioFilename}`,
  );

  const shouldResumePlayback = wasPlaying || state.isPlaying;
  clearCurrentRaf();
  if (shouldResumePlayback) {
    try {
      state.audio.playbackRate = state.playbackSpeed;
      await state.audio.play();
      setPlaybackState({ playbackMode: 'audio', isPlaying: true });
      syncVisualClockToMapTime(getAudioMappedTimeMs());
      resyncVisualPlaybackToAudio({ force: true });
      ensurePlaybackLoop();
      addDebugLog('audio: hotswap success, playback resumed');
      return true;
    } catch {
      state.isPlaying = true;
      switchToManualTimeline();
      ensurePlaybackLoop();
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
  setFullAudioState({
    fullAudioStatus: 'loading',
    fullAudioCacheKey: cacheKey,
    fullAudioError: '',
  });
  setFullAudioLoading(true);
  const firstTrySequence = getProviderSequenceForDownload(
    state.providerOverride,
    state.providerPriority,
    state.disabledProviders,
    state.autoFallback,
  );
  showTryingArchiveProviderBadge(
    firstTrySequence[0]?.label ?? getProviderDisplayName(state.providerOverride),
  );
  addDebugLog(`audio: full-load start set=${setId} file=${audioFileName}`);

  try {
    const cachedBlob = await readCachedFullAudioBlob(setId, audioFileName);
    if (cachedBlob && jobId === state.fullAudioJobId) {
      setProviderState({ currentArchiveProviderLabel: CACHE_AUDIO_PROVIDER_LABEL });
      setAudioBadgeWithProvider('loading', 'Loading full audio', CACHE_AUDIO_PROVIDER_LABEL, 'Using cached full audio');
      addDebugLog(`audio: cache hit (${Math.round(cachedBlob.size / 1024)} KB)`);
      await hotswapToFullAudio(cachedBlob, setId, audioFileName, jobId, CACHE_AUDIO_PROVIDER_LABEL);
      return;
    }
    addDebugLog('audio: cache miss');

    let extractionResult;
    try {
      extractionResult = await sendRuntimeMessage({
        type: 'extractFullAudio',
        jobId,
        setId,
        audioFilename: audioFileName,
        providerOverride: state.providerOverride,
        providerPriority: state.providerPriority,
        disabledProviders: state.disabledProviders,
        autoFallback: state.autoFallback,
      });
    } catch (swMessageError) {
      addDebugLog(`audio: service worker message failed (${swMessageError?.message || swMessageError})`);
      extractionResult = { ok: false, error: swMessageError?.message || 'runtime message failed' };
    }

    if (!extractionResult?.ok) {
      addDebugLog(`audio: worker path failed (${extractionResult?.error || 'unknown'}); retry download in popup`);
      extractionResult = await extractFullBeatmapAudio({
        setId,
        audioFilename: audioFileName,
        providerOverride: state.providerOverride,
        userPriority: state.providerPriority,
        disabledProviders: state.disabledProviders,
        autoFallback: state.autoFallback,
        onTryingSource: showTryingArchiveProviderBadge,
        onDownloadProgress: (evt) => {
          if (jobId !== state.fullAudioJobId) {
            return;
          }
          showTryingArchiveProviderBadge(evt.providerLabel, {
            loaded: evt.loaded,
            total: evt.total,
          });
        },
      });
    }
    if (!extractionResult?.ok) {
      throw new Error(extractionResult?.error || 'background extraction failed');
    }

    if (jobId !== state.fullAudioJobId) {
      return;
    }
    const {
      sourceLabel,
      pickedAudioFilename,
      normalizedPickedAudioFilename,
      normalizedRequestedAudioFilename,
      mime,
      byteLength: cachedByteLength,
    } = extractionResult;

    setProviderState({ currentArchiveProviderLabel: sourceLabel });
    setAudioBadgeWithProvider('loading', 'Loading full audio', sourceLabel, `Downloading from ${sourceLabel}`);

    let audioBlob = await readCachedFullAudioBlob(setId, audioFileName);
    let byteLength = Number.isFinite(cachedByteLength) ? cachedByteLength : (audioBlob?.size || 0);
    if (audioBlob) {
      addDebugLog(`audio: archive extracted in worker from ${sourceLabel} (${Math.round(byteLength / 1024)} KB)`);
    } else if (extractionResult.audioBytes instanceof Uint8Array && extractionResult.audioBytes.byteLength > 0) {
      audioBlob = new Blob([extractionResult.audioBytes], { type: mime || getAudioMimeType(pickedAudioFilename) });
      byteLength = extractionResult.audioBytes.byteLength;
      addDebugLog(`audio: archive extracted in popup from ${sourceLabel} (${Math.round(byteLength / 1024)} KB)`);
      await writeCachedFullAudioBlob(setId, audioFileName, audioBlob);
    }

    if (!audioBlob || byteLength <= 0) {
      throw new Error('Full-audio extraction returned no cached audio payload.');
    }
    addDebugLog(`audio: selected entry ${pickedAudioFilename}`);

    if (normalizedPickedAudioFilename !== normalizedRequestedAudioFilename) {
      addDebugLog('audio: cache stored under requested metadata filename');
    }
    await hotswapToFullAudio(audioBlob, setId, pickedAudioFilename, jobId, sourceLabel);
  } catch (error) {
    if (jobId === state.fullAudioJobId) {
      setFullAudioState({
        fullAudioStatus: 'failed',
        fullAudioError: error?.message || 'unknown error',
      });
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
      syncPlaybackDuration();
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

  const sources = getProviderSequenceForDownload(
    state.providerOverride,
    state.providerPriority,
    state.disabledProviders,
    state.autoFallback,
  );
  if (!sources.length) {
    addDebugLog('probe: no providers available');
    return;
  }

  const probeTimeoutMs = sources.length > 1 ? FETCH_TIMEOUT_FAILOVER_MS : Math.min(FETCH_TIMEOUT_MS, 12000);
  addDebugLog(`probe: running provider checks for set ${targetSetId} (${getProviderDisplayName(state.providerOverride)})`);
  addDebugLog(`probe: provider order ${sources.map((source) => source.label).join(' -> ')}`);
  for (const source of sources) {
    const result = await probeArchiveSource(source, targetSetId, probeTimeoutMs);
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

const queryActiveTab = async () => {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  return Array.isArray(tabs) ? tabs[0] : null;
};

const fetchBeatmapFile = async (beatmapId) => {
  const controller = registry.createAbortController();
  try {
    const response = await fetch(`https://osu.ppy.sh/osu/${beatmapId}`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Beatmap request failed (${response.status}).`);
    }

    // Reading the body has to stay inside the controller's lifetime, otherwise
    // closing the popup mid-download leaves the read running unaborted.
    const text = await response.text();
    if (!text.includes('[HitObjects]')) {
      throw new Error('Fetched data is not a valid .osu beatmap file.');
    }

    return text;
  } finally {
    registry.releaseAbortController(controller);
  }
};

const readCachedPreview = async () => {
  if (!hasStorageArea('session', 'local')) {
    return null;
  }

  try {
    const items = await storageGet('session', [CACHE_KEY], { fallbackAreaName: 'local' });
    return items?.[CACHE_KEY] || null;
  } catch {
    return null;
  }
};

const writeCachedPreview = async (value) => {
  if (!hasStorageArea('session', 'local')) {
    return false;
  }

  try {
    await storageSet('session', { [CACHE_KEY]: value }, { fallbackAreaName: 'local' });
    return true;
  } catch {
    return false;
  }
};

const initializePreviewForCurrentTab = async () => {
  stopTimelineDurationAnimation();
  stopPlayback();
  setPlaybackSpeedControlEnabled(false);
  popup?.classList.add('is-open');
  setUnsupportedMode(false);
  void pruneFullAudioCache();
  clearDebugLogs();
  state.hasAutoStarted = false;
  state.fullAudioJobId += 1;
  setFullAudioLoading(false);
  setAudioBadgeWithProvider('preview', 'Preview audio', PREVIEW_AUDIO_PROVIDER_LABEL);
  addDebugLog('init: popup opened');

  setProviderState({ providerOverride: await readProviderOverrideSetting() });
  await loadProviderRuntimeState();
  addDebugLog(`init: provider override ${getProviderDisplayName(state.providerOverride)}`);
  applyAudioVolume(await readAudioVolumeSetting());
  addDebugLog(`init: audio volume ${Math.round(state.volume * 100)}%`);
  applyPreviewSettings(await readPreviewSettings());
  addDebugLog(
    `init: mania scroll speed ${state.maniaScrollSpeed}`
    + (state.maniaScaleScrollSpeedWithBpm ? ' (scaled with BPM)' : ' (fixed)'),
  );

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
      if (unsupportedAscii) {
        if (unsupportedPanel && !info.unsupportedSite) {
          const titleEl = unsupportedPanel.querySelector('.map-preview-unsupported-title');
          if (titleEl) titleEl.textContent = 'no map detected... o_0';
        }
        setUnsupportedMode(true);
        void renderRecentPanel();
      } else {
        setUnsupportedMode(false);
        titleLine.textContent = 'Preview unavailable';
        setStatus(info.reason, true);
      }
      renderer.setBeatmap({ objects: [], mode: 0, comboColours: [] }, [], 1);
      setTimelineState({ currentTimeMs: 0, durationMs: 1 });
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
    const parsedMapData = parseMapPreviewData(osuContent, { maxObjects: MAX_PREVIEW_OBJECTS });
    const breaks = parseBreakPeriods(osuContent);
    const requestedMode = Number.isInteger(info.mode) ? info.mode : parsedMapData.mode;
    // Breaks feed the mania converter's drain-time difficulty, so they have to
    // be parsed before the conversion rather than alongside the renderer setup.
    const mapData = convertMapForMode({ ...parsedMapData, breaks }, requestedMode);
    const modeNames = ['osu!', 'taiko', 'catch', 'mania'];
    if (mapData.mode !== parsedMapData.mode) {
      addDebugLog(
        `init: converted ${modeNames[parsedMapData.mode] || 'unknown'} -> ${modeNames[mapData.mode] || 'unknown'}`,
      );
    } else {
      addDebugLog(`init: using ${modeNames[mapData.mode] || 'unknown'} ruleset`);
    }
    if (parsedMapData.truncated) {
      addDebugLog(
        `init: map truncated to ${parsedMapData.renderedObjectCount} of `
        + `${parsedMapData.hitObjectCount} objects (timeline still spans the full map)`,
      );
    }
    const resolvedSetId = info.setId || extractSetIdFromMetadata(metadata.beatmapSetID);
    addDebugLog(`init: resolved set id ${resolvedSetId || 'none'}`);

    if (!Array.isArray(mapData.objects) || mapData.objects.length === 0) {
      throw new Error('Beatmap has no readable hit objects.');
    }

    const durationMs = Math.max(mapData.maxObjectTime + 2000, 2000);

    state.metadata = metadata;
    state.mapData = mapData;
    state.breaks = breaks;
    state.mappedDurationMs = durationMs;
    setTimelineState({
      durationMs,
      currentTimeMs: clamp(metadata.previewTime > 0 ? metadata.previewTime : 0, 0, durationMs),
    });
    configureAudioPreview(resolvedSetId, metadata.previewTime);


    renderer.setBeatmap(mapData, breaks, durationMs);
    syncPlaybackDuration();
    setMetadataText();

    void addToHistory({
      beatmapId: info.beatmapId || resolvedSetId,
      beatmapSetId: resolvedSetId,
      title: metadata.title,
      artist: metadata.artist,
      creator: metadata.creator,
    });
    renderFrame();

    setPlaybackSpeedControlEnabled(true);

    // Start the current source before launching the full-audio upgrade. Both
    // paths use the same HTMLAudioElement; starting them together lets the
    // slower promise overwrite the other's seek/play state, which presents as
    // a map-specific audio delay when the full track is already cached.
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
    setPlaybackSpeedControlEnabled(false);
    titleLine.textContent = 'Preview unavailable';
    versionLine.textContent = '';
    versionLine.title = '';
    configureAudioPreview(null, 0);
    setStatus(error?.message || 'Failed to load beatmap preview.', true);
    renderer.setBeatmap({ objects: [], mode: 0, comboColours: [] }, [], 1);
    state.mappedDurationMs = 1;
    setTimelineState({ currentTimeMs: 0, durationMs: 1 });
    syncTimeLabelWidth();
    renderFrame();
  }
};

bindPopupUiEvents({
  elements: {
    speedButton,
    speedControl,
    speedSlider,
    speedResetButton,
    playfieldCanvas,
    timelineCanvas,
    audioStatusBadge,
    infoButtons,
    infoModal,
    infoBackdrop,
    infoCloseButton,
    infoOptionsButton,
    infoIssueButton,
    infoOsuButton,
    debugRunButton,
    debugClearButton,
    debugCloseButton,
    volumeSlider,
    timeLabel,
    shortcutsButton,
    shortcutsModal,
    shortcutsBackdrop,
    shortcutsCloseButton,
    recentClearBtn,
    popupToast,
  },
  state,
  renderer,
  registry,
  supportLinks: SUPPORT_LINKS,
  actions: {
    cyclePlaybackSpeed,
    applyPlaybackSpeed,
    togglePlayback,
    showCanvasToggleFeedback,
    toggleDebugPanelOpen,
    setInfoMenuOpen,
    openExtensionOptions,
    openSupportLink,
    runAudioFetchProbe,
    clearDebugLogs,
    addDebugLog,
    setDebugPanelOpen,
    applyAudioVolume,
    writeAudioVolumeSetting,
    showPopupToast,
    seekRelative,
    seekTo,
    restartPreview,
    toggleMute,
    setShortcutsMenuOpen,
    clearHistory: async () => {
      await clearFullAudioCache();
      await clearHistory();
      await updateRecentClearButtonCacheUsage();
      showPopupToast('Cache cleared');
      void renderRecentPanel();
    },
  },
});

// `pagehide` rather than `unload`: `unload` is deprecated, is not guaranteed to
// fire, and blocks the back/forward cache. CleanupRegistry listens on the same
// event, so both teardown paths now agree.
window.addEventListener('pagehide', () => {
  state.fullAudioJobId += 1;
  setFullAudioLoading(false);
  state.volumePersistTimer = registry.clearTimeout(state.volumePersistTimer);
  state.audioBadgeHideTimer = registry.clearTimeout(state.audioBadgeHideTimer);
  state.toastHideTimer = registry.clearTimeout(state.toastHideTimer);
  stopPlayback();
  state.indicatorTimer = registry.clearTimeout(state.indicatorTimer);
  stopTimelineDurationAnimation();
  setFullAudioObjectUrl(null);
  stopUnsupportedAsciiAnimation();
  resetState();
});

addRuntimeMessageListener((message) => {
  if (message?.type === 'fullAudioTryingSource') {
    if (message.jobId !== state.fullAudioJobId) {
      return;
    }
    showTryingArchiveProviderBadge(message.providerLabel);
    return;
  }
  if (message?.type === 'fullAudioDownloadProgress') {
    if (message.jobId !== state.fullAudioJobId) {
      return;
    }
    showTryingArchiveProviderBadge(message.providerLabel, {
      loaded: message.loaded,
      total: message.total,
    });
  }
});

applyAudioVolume(DEFAULT_AUDIO_VOLUME);
applyPlaybackSpeed(1);
syncTimeLabelWidth();
applyPreviewSettings(normalizePreviewSettings());
renderDebugPanel();
renderInfoMenu();
initializePreviewForCurrentTab();

addStorageChangedListener((changes, areaName) => {
  if (areaName !== 'sync') {
    return;
  }

  if (
    changes[MANIA_SCROLL_SPEED_KEY]
    || changes[MANIA_SCROLL_SCALE_WITH_BPM_KEY]
    || changes[MANIA_SCROLL_DIRECTION_KEY]
    || changes[MANIA_TIMING_NOTE_COLOURS_KEY]
    || changes[STANDARD_SNAKING_SLIDERS_KEY]
    || changes[STANDARD_SLIDER_SNAKE_OUT_KEY]
    || changes[STANDARD_SLIDER_END_CIRCLES_KEY]
    || changes[POPUP_SIZE_KEY]
    || changes[PROVIDER_PRIORITY_KEY]
    || changes[DISABLED_PROVIDERS_KEY]
    || changes[AUTO_FALLBACK_KEY]
  ) {
    applyPreviewSettings({
      maniaScrollSpeed: changes[MANIA_SCROLL_SPEED_KEY]?.newValue ?? state.maniaScrollSpeed,
      maniaScaleScrollSpeedWithBpm: changes[MANIA_SCROLL_SCALE_WITH_BPM_KEY]?.newValue
        ?? state.maniaScaleScrollSpeedWithBpm,
      maniaScrollDirection: changes[MANIA_SCROLL_DIRECTION_KEY]?.newValue
        ?? state.maniaScrollDirection,
      maniaTimingNoteColours: changes[MANIA_TIMING_NOTE_COLOURS_KEY]?.newValue
        ?? state.maniaTimingNoteColours,
      standardSnakingSliders: changes[STANDARD_SNAKING_SLIDERS_KEY]?.newValue
        ?? state.standardSnakingSliders,
      standardSliderSnakeOut: changes[STANDARD_SLIDER_SNAKE_OUT_KEY]?.newValue
        ?? state.standardSliderSnakeOut,
      standardSliderEndCircles: changes[STANDARD_SLIDER_END_CIRCLES_KEY]?.newValue
        ?? state.standardSliderEndCircles,
      popupSize: changes[POPUP_SIZE_KEY]?.newValue ?? state.popupSize,
      providerPriority: changes[PROVIDER_PRIORITY_KEY]?.newValue ?? state.providerPriority,
      disabledProviders: changes[DISABLED_PROVIDERS_KEY]?.newValue ?? state.disabledProviders,
      autoFallback: changes[AUTO_FALLBACK_KEY]?.newValue ?? state.autoFallback,
    });

    if ((state.mapData?.mode ?? 0) === 0 || (state.mapData?.mode ?? 0) === 3) {
      renderFrame();
    }
  }
});
