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
  PREVIEW_SETTING_KEYS,
  HITSOUNDS_KEY,
  HITSOUND_VOLUME_KEY,
  POPUP_SIZE_PRESETS,
  normalizeProviderOverride,
  normalizePreviewSettings,
} from './settings.js';
import {
  addRuntimeMessageListener,
  addStorageChangedListener,
  createTab,
  createWindow,
  getExtensionUrl,
  getWindow,
  hasStorageArea,
  hasWindowsApi,
  openOptionsPage,
  queryTabs,
  removeWindow,
  sendRuntimeMessage,
  storageGet,
  storageSet,
  updateWindow,
  WINDOW_ID_NONE,
  addTabsActivatedListener,
  addTabsUpdatedListener,
  addWindowsFocusChangedListener,
} from './webextension.js';
import { registry } from './core/cleanup.js';
import { buildCachedMapsetEntries } from './core/cachedMapsets.js';
import { extractBeatmapInfoFromUrl } from './core/beatmapUrl.js';
import {
  DETACHED_WINDOW_BOUNDS_KEY,
  DETACHED_WINDOW_ID_KEY,
  MIN_DETACHED_HEIGHT,
  MIN_DETACHED_WIDTH,
  buildBeatmapSourceUrl,
  buildDetachedPageUrl,
  normalizeDetachedBounds,
  isBoundsRejection,
  withoutDetachedPosition,
  hasDetachedPosition,
  readDetachedParams,
} from './core/detachedWindow.js';
import { isSameFollowTarget, pickBeatmapTabInfo, toFollowTarget } from './core/tabFollow.js';
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
  ensureCachedMapsetInfo,
  getCachedMapsetSummaries,
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
import {
  PREVIEW_CLIP_LEAD_IN_MS,
  getPreviewClipAnchorMapMs,
  isPreviewClipAnchorable,
  seekAudioElementToMapTime,
} from './audio/seek.js';
import {
  getProviderDisplayName,
  getProviderSequenceForDownload,
  loadProviderRuntimeState,
  probeArchiveSource,
  FETCH_TIMEOUT_MS,
  FETCH_TIMEOUT_FAILOVER_MS,
} from './audio/provider.js';
import { createPlaybackController } from './audio/playback.js';
import { buildHitsoundEvents, createHitsoundPlayer } from './audio/hitsounds.js';
import { createDebugPanelController } from './ui/debugPanel.js';
import { bindPopupUiEvents } from './ui/popupUI.js';
import { createUnsupportedViewController } from './ui/unsupportedView.js';

// Resolved and applied before anything else renders: the detached flag decides
// whether the document is sized as a toolbar popup or as a window, and a late
// class flip would repaint the shell at the wrong width.
const detachedParams = readDetachedParams(globalThis.location?.search || '');
const IS_DETACHED_WINDOW = detachedParams.isDetached;

// Applies to the map the window opened with, and only that one. Following on to
// a different map afterwards should start at that map's own preview point, not
// at a timestamp inherited from the map before it.
let pendingResume = IS_DETACHED_WINDOW && detachedParams.resumeTimeMs >= 0
  ? { timeMs: detachedParams.resumeTimeMs, paused: detachedParams.resumePaused }
  : null;

const takePendingResume = () => {
  const resume = pendingResume;
  pendingResume = null;
  return resume;
};

if (IS_DETACHED_WINDOW) {
  document.documentElement.classList.add('is-detached-window');
}

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
const timelineTooltip = document.querySelector('#mapPreviewTimelineTooltip');
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
const detachButton = document.querySelector('#mapPreviewDetachBtn');
const followButton = document.querySelector('#mapPreviewFollowBtn');
const infoButtons = [...document.querySelectorAll('.js-map-preview-info-btn')];
const infoButton = infoButtons[0] || null;
const infoModal = document.querySelector('#mapPreviewInfoModal');
const infoBackdrop = document.querySelector('#mapPreviewInfoBackdrop');
const infoCloseButton = document.querySelector('#mapPreviewInfoCloseBtn');
const infoOptionsButton = document.querySelector('#mapPreviewInfoOptionsBtn');
const infoCachedButton = document.querySelector('#mapPreviewInfoCachedBtn');
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
// Long enough to collapse a burst of hash rewrites, short enough that clicking a
// difficulty feels like it loads immediately.
const FOLLOW_SYNC_DEBOUNCE_MS = 250;
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
// The element is the clock, so losing it is a state transition, not a
// correction: hand the preview back to the visual timeline and keep it moving.
state.audio.addEventListener('error', () => {
  state.audioSyncEnabled = false;
  if (state.playbackMode === 'audio' || state.playbackMode === 'seeking') {
    releaseAudioClock();
  }
  syncPlaybackDuration();
});
state.audio.addEventListener('loadedmetadata', syncPlaybackDuration);
state.audio.addEventListener('durationchange', syncPlaybackDuration);
state.audio.addEventListener('emptied', syncPlaybackDuration);
// No 'seeked' or 'timeupdate' listener on purpose. Both used to write a
// corrected timestamp back into the visual clock, which is how a late event
// from a superseded seek could drag the playhead backwards. Seeks are awaited
// by whoever issued them now, and the frame loop reads the element directly.
state.audio.addEventListener('playing', () => {
  if (!state.isPlaying) {
    return;
  }
  if (state.playbackMode === 'audio') {
    ensurePlaybackLoop();
    return;
  }
  // Sound again after a stall handed the clock to the visual timeline.
  if (resumeAudioClockAfterStall()) {
    addDebugLog('audio: media clock resumed after a stall');
  }
});
state.audio.addEventListener('ended', () => {
  // Only take the element's own position if the anchor still describes the
  // source that just ended; mid-swap it does not.
  if (isAudioClockAuthoritative()) {
    syncVisualClockToMapTime(getAudioMappedTimeMs());
  }
  state.currentTimeMs = clamp(state.currentTimeMs, 0, state.durationMs || 1);
  renderFrame();

  if (state.isPlaying && shouldContinueTimelineWithoutFullAudio()) {
    releaseAudioClock();
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

// Stored alongside the cached audio so the cached-mapsets list can name a set
// long after it has aged out of the 20-entry view history.
const getCurrentMapsetInfo = () => ({
  title: state.metadata?.title || '',
  artist: state.metadata?.artist || '',
  creator: state.metadata?.creator || '',
});

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

  const cachedMapsets = await getCachedMapsetSummaries();
  if (!cachedMapsets || cachedMapsets.length === 0) {
    recentPanel.hidden = true;
    return;
  }

  const history = await getHistory();
  const cachedEntries = buildCachedMapsetEntries(cachedMapsets, history);

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

/**
 * The cached list used to be reachable only from the "unsupported page" view,
 * which meant it was invisible exactly when you were browsing beatmaps.
 */
const toggleCachedMapsetsPanel = async () => {
  if (!recentPanel) {
    return;
  }

  setInfoMenuOpen(false);

  // The unsupported view shows the list as its main content, so there is nothing
  // to toggle back to. The button is hidden there; this keeps a keyboard route
  // from stranding the view on an empty title card anyway.
  if (popup?.classList.contains('is-unsupported')) {
    return;
  }

  if (!recentPanel.hidden) {
    recentPanel.hidden = true;
    return;
  }

  await renderRecentPanel();
  // renderRecentPanel leaves the panel hidden when nothing is cached, so say so
  // rather than letting the menu entry look broken.
  if (recentPanel.hidden) {
    showPopupToast('No cached mapsets yet');
  }
};

/**
 * Dismisses the floating cached list. Deliberately does nothing on the
 * unsupported view: there the list is not an overlay over a preview, it is the
 * whole page, so closing it would leave an empty popup with no way back.
 */
const closeCachedMapsetsPanel = () => {
  if (!recentPanel || recentPanel.hidden || popup?.classList.contains('is-unsupported')) {
    return;
  }
  recentPanel.hidden = true;
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

const setDetachContext = ({ beatmapId, setId, mode } = {}) => {
  state.detachContext = {
    beatmapId: String(beatmapId || ''),
    setId: String(setId || ''),
    mode: Number.isInteger(mode) ? mode : null,
  };

  if (detachButton) {
    detachButton.disabled = !state.detachContext.beatmapId;
  }
};

const readStoredDetachedWindowId = async () => {
  try {
    const items = await storageGet('session', [DETACHED_WINDOW_ID_KEY], { fallbackAreaName: 'local' });
    const windowId = Number(items?.[DETACHED_WINDOW_ID_KEY]);
    return Number.isInteger(windowId) ? windowId : null;
  } catch {
    return null;
  }
};

const writeStoredDetachedWindowId = async (windowId) => {
  try {
    await storageSet('session', { [DETACHED_WINDOW_ID_KEY]: windowId ?? null }, { fallbackAreaName: 'local' });
  } catch (error) {
    addDebugLog(`detach: could not persist window id (${error?.message || error})`);
  }
};

const readDetachedBounds = async () => {
  try {
    const items = await storageGet('local', [DETACHED_WINDOW_BOUNDS_KEY]);
    return normalizeDetachedBounds(items?.[DETACHED_WINDOW_BOUNDS_KEY] || {});
  } catch {
    return normalizeDetachedBounds({});
  }
};

/**
 * Focuses the previously opened detached window if it is still around, so the
 * button never leaves the user with two windows fighting over the same audio.
 */
const focusExistingDetachedWindow = async () => {
  const windowId = await readStoredDetachedWindowId();
  if (windowId === null) {
    return false;
  }

  const existingWindow = await getWindow(windowId);
  if (!existingWindow) {
    await writeStoredDetachedWindowId(null);
    return false;
  }

  try {
    // `drawAttention` is deliberately omitted: Firefox ignores it on a window
    // that is being focused in the same call.
    await updateWindow(windowId, { focused: true });
    return true;
  } catch {
    await writeStoredDetachedWindowId(null);
    return false;
  }
};

/**
 * Opening the toolbar popup while a detached window is up closes that window.
 * The action has a `default_popup`, so clicking the icon always opens this page;
 * without this the two previews would play over each other.
 */
const closeDetachedWindowIfOpen = async () => {
  try {
    const windowId = await readStoredDetachedWindowId();
    if (windowId === null) {
      return false;
    }

    const existingWindow = await getWindow(windowId);
    if (!existingWindow) {
      await writeStoredDetachedWindowId(null);
      return false;
    }

    const closed = await removeWindow(windowId);
    await writeStoredDetachedWindowId(null);
    if (closed) {
      addDebugLog('detach: closed the detached window on popup open');
    }
    return closed;
  } catch (error) {
    addDebugLog(`detach: could not close detached window (${error?.message || error})`);
    return false;
  }
};

const openDetachedWindow = async () => {
  const pagePath = buildDetachedPageUrl({
    beatmapId: state.detachContext.beatmapId,
    setId: state.detachContext.setId,
    mode: state.detachContext.mode,
    // Hand over the playhead so the window picks up where the popup left off.
    resumeTimeMs: state.mapData ? state.currentTimeMs : -1,
    resumePaused: !state.isPlaying,
  });

  if (!pagePath) {
    showPopupToast('No beatmap to detach yet');
    return;
  }

  const pageUrl = getExtensionUrl(pagePath);

  // Firefox for Android has no window management, so the preview opens as a tab
  // there instead of failing outright.
  if (!hasWindowsApi()) {
    try {
      await createTab({ url: pageUrl });
      window.close();
    } catch (error) {
      addDebugLog(`detach: tab fallback failed (${error?.message || error})`);
      showPopupToast('Could not open a separate view');
    }
    return;
  }

  try {
    if (await focusExistingDetachedWindow()) {
      window.close();
      return;
    }

    const bounds = await readDetachedBounds();
    let createdWindow = null;
    try {
      createdWindow = await createWindow({ url: pageUrl, type: 'popup', ...bounds });
    } catch (error) {
      if (!isBoundsRejection(error) || !hasDetachedPosition(bounds)) {
        throw error;
      }
      // The remembered position is not on a screen any more -- a monitor was
      // unplugged, or the resolution changed under it. Keep the size, let the
      // browser choose where, and forget the position so it cannot strand the
      // detach button again.
      addDebugLog('detach: remembered position is off-screen, letting the browser place it');
      const size = withoutDetachedPosition(bounds);
      createdWindow = await createWindow({ url: pageUrl, type: 'popup', ...size });
      void storageSet('local', { [DETACHED_WINDOW_BOUNDS_KEY]: size }).catch(() => {});
    }
    await writeStoredDetachedWindowId(createdWindow?.id ?? null);
    window.close();
  } catch (error) {
    addDebugLog(`detach: failed (${error?.message || error})`);
    showPopupToast('Could not open a separate window');
  }
};

const setFollowEnabled = (isEnabled) => {
  state.followEnabled = Boolean(isEnabled);

  if (followButton) {
    followButton.classList.toggle('is-following', state.followEnabled);
    followButton.setAttribute('aria-pressed', state.followEnabled ? 'true' : 'false');
    const label = state.followEnabled
      ? 'Following the browser — click to pin this map'
      : 'Pinned to this map — click to follow the browser';
    followButton.title = label;
    followButton.setAttribute('aria-label', label);
  }
};

const toggleFollowEnabled = () => {
  setFollowEnabled(!state.followEnabled);
  showPopupToast(state.followEnabled ? 'Following the browser' : 'Pinned to this map');

  // Catch up immediately: the user may have browsed elsewhere while pinned.
  if (state.followEnabled) {
    void syncPreviewWithBrowsingTabs();
  }
};

/**
 * Loads whichever beatmap the user is looking at in a normal browsing window.
 * Staying put when no beatmap tab is open is deliberate: browsing away to an
 * unrelated page should leave the current preview alone rather than blank it.
 */
const syncPreviewWithBrowsingTabs = async () => {
  if (!state.followEnabled) {
    return;
  }

  let tabs = [];
  try {
    // Extension popup windows report as type 'popup', so this cannot match the
    // detached window itself.
    tabs = await queryTabs({ active: true, windowType: 'normal' });
  } catch (error) {
    addDebugLog(`follow: tab query failed (${error?.message || error})`);
    return;
  }

  const picked = pickBeatmapTabInfo(tabs, {
    preferredWindowId: state.lastFocusedBrowsingWindowId,
    excludeWindowId: state.detachedWindowId,
  });

  if (!picked) {
    return;
  }

  if (isSameFollowTarget(state.followTarget, toFollowTarget(picked.info))) {
    return;
  }

  addDebugLog(`follow: switching to beatmap ${picked.info.beatmapId}`);
  await initializePreviewForCurrentTab({ sourceUrlOverride: picked.tab.url });
};

const scheduleFollowSync = () => {
  // Difficulty clicks rewrite the hash in bursts; the debounce collapses those
  // into the one map the user actually settled on.
  state.followSyncTimer = registry.clearTimeout(state.followSyncTimer);
  state.followSyncTimer = registry.addTimeout(setTimeout(() => {
    void syncPreviewWithBrowsingTabs();
  }, FOLLOW_SYNC_DEBOUNCE_MS));
};

const startFollowingBrowsingTabs = () => {
  setFollowEnabled(true);

  // Needed to exclude this window from the tab scan, and harmless if it fails.
  void (async () => {
    try {
      state.detachedWindowId = await readStoredDetachedWindowId();
    } catch {
      state.detachedWindowId = null;
    }
  })();

  addTabsUpdatedListener((_tabId, changeInfo) => {
    // Fires for hash changes too, which is how in-page difficulty switching on a
    // beatmapset page reaches us.
    if (changeInfo?.url || changeInfo?.status === 'complete') {
      scheduleFollowSync();
    }
  });

  addTabsActivatedListener(() => {
    scheduleFollowSync();
  });

  addWindowsFocusChangedListener((windowId) => {
    if (windowId === WINDOW_ID_NONE) {
      return;
    }
    if (windowId !== state.detachedWindowId) {
      state.lastFocusedBrowsingWindowId = windowId;
    }
    // Syncing on focus of either window is the safety net: if a hash change ever
    // fails to raise onUpdated, clicking back to the preview still picks it up.
    scheduleFollowSync();
  });
};

const persistDetachedBounds = () => {
  state.detachedBoundsTimer = registry.clearTimeout(state.detachedBoundsTimer);
  state.followSyncTimer = registry.clearTimeout(state.followSyncTimer);
  state.detachedBoundsTimer = registry.addTimeout(setTimeout(() => {
    const bounds = normalizeDetachedBounds({
      width: window.outerWidth,
      height: window.outerHeight,
      left: window.screenX,
      top: window.screenY,
    });
    void storageSet('local', { [DETACHED_WINDOW_BOUNDS_KEY]: bounds }).catch(() => {});
  }, 400));
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
    const items = await storageGet('sync', [...PREVIEW_SETTING_KEYS]);
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
  state.hitsounds = normalized.hitsounds;
  state.hitsoundVolume = normalized.hitsoundVolume;
  hitsoundPlayer.setEnabled(normalized.hitsounds);
  hitsoundPlayer.setVolume(normalized.hitsoundVolume);
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
});
const {
  getCurrentManualMapTime,
  syncVisualClockToMapTime: syncVisualClockToMapTimeRaw,
  getAudioMappedTimeMs,
  isAudioClockAuthoritative,
  applyPlaybackRate,
} = timingController;

const hitsoundPlayer = createHitsoundPlayer({ onLog: addDebugLog });

// Every jump in the clock -- a scrub, a restart, an audio resync -- funnels
// through here, so it is the one place the hitsound cursor has to catch up.
// Without it a seek would replay every object between the old and new position.
const syncVisualClockToMapTime = (mapTimeMs, nowPerfMs) => {
  syncVisualClockToMapTimeRaw(mapTimeMs, nowPerfMs);
  hitsoundPlayer.syncTo(state.hitsoundEvents, state.currentTimeMs);
};

const applyPlaybackSpeed = (nextSpeed) => {
  const normalized = normalizePlaybackSpeed(nextSpeed);

  const mapTimeMs = applyPlaybackRate(normalized);
  // Hitsounds are placed ahead of the playhead against the rate that was
  // running when they were placed, so the ones already queued are wrong now.
  hitsoundPlayer.syncTo(state.hitsoundEvents, mapTimeMs);
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

// For states with nothing true to say: no map loaded, or the load failed. An
// optimistic "Preview audio" label over silence is worse than no label at all.
const hideAudioBadge = () => {
  if (!audioStatusBadge) {
    return;
  }

  state.audioBadgeHideTimer = registry.clearTimeout(state.audioBadgeHideTimer);
  audioStatusBadge.classList.add('is-hidden');
  audioStatusBadge.classList.remove('is-spinning');
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
  // Replacing the source invalidates anything still waiting on the old one: its
  // seeks can never land now, and its anchor no longer describes this element.
  beginAudioOperation();
  state.pendingSeekMapMs = null;
  if (state.playbackMode === 'seeking') {
    // Whatever the preview was frozen on is unreachable, and a new source can
    // take minutes to arrive. Let the visual clock carry it in the meantime.
    releaseAudioClock();
  }
  state.audioSyncEnabled = Boolean(sourceUrl);
  state.audioAnchorMapMs = Math.max(0, Number.isFinite(anchorMapMs) ? anchorMapMs : 0);
  state.audioAnchorSrc = sourceUrl || '';
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

let lastTimeLabelText = '';

const renderFrame = () => {
  // Only while playing: a paused scrub should show the map, not sound it.
  if (state.isPlaying) {
    hitsoundPlayer.update(state.hitsoundEvents, state.currentTimeMs, { rate: state.playbackSpeed });
  }
  renderer.setTime(state.currentTimeMs);
  renderer.render();

  // The label only changes once a second, but writing it every frame dirtied
  // layout, which the next frame's canvas size read then had to resolve.
  const nextTimeLabel = `${renderer.getCurrentLabel()} / ${renderer.getDurationLabel()}`;
  if (nextTimeLabel !== lastTimeLabelText) {
    lastTimeLabelText = nextTimeLabel;
    timeLabel.textContent = nextTimeLabel;
  }
};

const {
  beginAudioOperation,
  isCurrentAudioOperation,
  holdForAudioSeek,
  adoptAudioClock,
  releaseAudioClock,
  resumeAudioClockAfterStall,
  ensurePlaybackLoop,
  stopPlayback,
  togglePlayback,
  seekTo,
  seekRelative,
  restartPreview,
} = createPlaybackController({
  state,
  helpers: {
    ensureTimelineDurationAnimation,
    getCurrentManualMapTime,
    getAudioMappedTimeMs,
    isAudioClockAuthoritative,
    syncVisualClockToMapTime,
    renderFrame,
    waitForAudioSeek: (audioElement) => waitForAudioElementSeek(audioElement),
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

const configureAudioPreview = (setId, previewTimeMs, { skipPreviewClip = false } = {}) => {
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
    hideAudioBadge();
    return;
  }

  const normalizedSetId = String(setId);
  setFullAudioState({
    previewSetId: normalizedSetId,
    activeSetId: normalizedSetId,
  });

  // PreviewTime is only known once the .osu file has been fetched and parsed, so
  // the first call of a load passes null. Reporting a verdict about the preview
  // point here would be guessing, and on a slow connection that guess stays on
  // screen for the whole download.
  if (previewTimeMs === null || previewTimeMs === undefined) {
    setAudioElementSource('', 0);
    setFullAudioLoading(true);
    setAudioBadge('loading', 'Loading audio', 'Reading the beatmap to line the audio up.');
    return;
  }

  // Resuming lands mid-map, and the b.ppy.sh clip only spans ~10s around the
  // beatmap's preview point, so it essentially never covers that position.
  // Attaching it anyway was actively harmful: the clip's duration is still
  // unknown when playback starts, so the seek out to the resume point is
  // accepted unvalidated, the element clamps to the end of the clip, and the
  // forced resync then reports that clamped position back as the playhead --
  // landing the preview seconds into the map instead of where it left off.
  if (skipPreviewClip) {
    setAudioElementSource('', 0);
    setAudioBadge(
      'loading',
      'Waiting for full audio',
      'Picking the preview up mid-map, past what the short preview clip covers. Waiting for the full track.',
    );
    return;
  }

  // The b.ppy.sh clip is a ~10s excerpt with a 100ms lead-in before the
  // beatmap's PreviewTime. When PreviewTime is -1 (or absent) osu! generates the
  // clip from ~40% into the track instead, and that offset is not derivable from
  // the .osu file. Anchoring it at 0 anyway played the middle of the song over
  // the start of the map — a large, constant desync. Better to stay silent until
  // full audio arrives.
  //
  // Named for what happens next rather than for the missing metadata: the full
  // track is already on its way, and the b.ppy.sh clip being unusable is a
  // detail, not a failure the user has to act on.
  if (!isPreviewClipAnchorable(previewTimeMs)) {
    setAudioElementSource('', 0);
    setAudioBadge(
      'loading',
      'Waiting for full audio',
      'This beatmap has no preview point, so the short preview clip cannot be lined up with the map. Waiting for the full track.',
    );
    return;
  }

  // Worth logging in full, because this is the only anchor in the app that is
  // inferred rather than known: the clip belongs to the beatmapset while
  // PreviewTime is read from this difficulty, and b.ppy.sh's lead-in is a
  // constant we assume rather than one the file states.
  const previewAnchorMapMs = getPreviewClipAnchorMapMs(previewTimeMs);
  addDebugLog(
    `audio: preview clip anchored at ${Math.round(previewAnchorMapMs)}ms `
    + `(PreviewTime ${Math.round(previewTimeMs)}ms, assumed ${PREVIEW_CLIP_LEAD_IN_MS}ms lead-in)`,
  );
  const nextSrc = `${AUDIO_PREVIEW_BASE}/${normalizedSetId}.mp3`;
  setAudioElementSource(nextSrc, previewAnchorMapMs);
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

  // From here the swap goes through the same operation controller as a user
  // seek, so the two cannot both claim the playhead: whichever started last
  // wins, and the loser's continuation drops out below instead of resuming from
  // a timestamp the user has already left.
  const commitToken = beginAudioOperation();
  holdForAudioSeek(commitMapTimeMs);

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
    releaseAudioClock();
    return false;
  }

  const seekSettled = await waitForAudioElementSeek(state.audio);
  const landedMapMs = getAudioMappedTimeMs();
  if (Math.abs(landedMapMs - commitMapTimeMs) > 1) {
    addDebugLog(
      `audio: full audio landed at ${Math.round(landedMapMs)}ms for a `
      + `${Math.round(commitMapTimeMs)}ms seek`,
    );
  }
  // A seek issued after ours has already moved this element and owns the
  // playhead. Its own continuation will position and resume it, so the swap
  // stops here rather than rolling back a source that is perfectly good.
  const isSupersededCommit = !isCurrentAudioOperation(commitToken);
  if (!isSupersededCommit && (!seekSettled || jobId !== state.fullAudioJobId)) {
    addDebugLog('audio: hotswap failed, seek did not settle after commit');
    rollbackCommittedSwap();
    releaseAudioClock();
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

  if (isSupersededCommit) {
    addDebugLog('audio: hotswap committed, a newer seek owns the playhead');
    return true;
  }

  const shouldResumePlayback = wasPlaying || state.isPlaying;
  if (!shouldResumePlayback) {
    releaseAudioClock();
    addDebugLog('audio: hotswap success (paused state)');
    renderFrame();
    return true;
  }

  try {
    state.audio.playbackRate = state.playbackSpeed;
    await state.audio.play();
    if (!isCurrentAudioOperation(commitToken)) {
      addDebugLog('audio: hotswap resume superseded by a newer seek');
      return true;
    }
    setPlaybackState({ isPlaying: true });
    adoptAudioClock();
    renderFrame();
    addDebugLog('audio: hotswap success, playback resumed');
    return true;
  } catch {
    if (!isCurrentAudioOperation(commitToken)) {
      return false;
    }
    setPlaybackState({ isPlaying: true });
    releaseAudioClock();
    addDebugLog('audio: hotswap fallback to manual timeline');
    return false;
  }
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

    // Staleness is checked on its own, before the cache result is interpreted.
    // Folding the two together meant a superseded job that had *found* its audio
    // fell through to the download path and reported a cache miss: the entry was
    // there, it just belonged to a job nobody was waiting for any more. Worse,
    // the service worker aborts whatever extraction is in flight when a new
    // request arrives, so a stale job reaching that path cancels the download
    // the live job is waiting on. The newer job does its own cache read, so
    // there is nothing to hand over here.
    if (jobId !== state.fullAudioJobId) {
      addDebugLog('audio: full-load superseded before it could start');
      return;
    }

    if (cachedBlob) {
      setProviderState({ currentArchiveProviderLabel: CACHE_AUDIO_PROVIDER_LABEL });
      setAudioBadgeWithProvider('loading', 'Loading full audio', CACHE_AUDIO_PROVIDER_LABEL, 'Using cached full audio');
      addDebugLog(`audio: cache hit (${Math.round(cachedBlob.size / 1024)} KB)`);
      // Entries cached before names were stored only ever get one chance to pick
      // theirs up, since the write path is skipped for a hit.
      void ensureCachedMapsetInfo(setId, audioFileName, getCurrentMapsetInfo(), cachedBlob);
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
        mapsetInfo: getCurrentMapsetInfo(),
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
      await writeCachedFullAudioBlob(setId, audioFileName, audioBlob, getCurrentMapsetInfo());
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

// Bumped by every load so an older, slower one cannot overwrite the newer map's
// state when the user switches difficulties faster than a fetch completes.
let previewLoadToken = 0;

const initializePreviewForCurrentTab = async ({ sourceUrlOverride = '' } = {}) => {
  previewLoadToken += 1;
  const loadToken = previewLoadToken;
  const isStaleLoad = () => loadToken !== previewLoadToken;

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

  if (isStaleLoad()) {
    return;
  }

  try {
    let sourceUrl = '';
    if (sourceUrlOverride) {
      // A followed tab already resolved to a beatmap URL.
      sourceUrl = sourceUrlOverride;
    } else if (IS_DETACHED_WINDOW) {
      // The ids arrived in the page URL; rebuilding a canonical beatmap URL from
      // them keeps both entry points on the same validation path below.
      setStatus('Loading detached preview...');
      sourceUrl = buildBeatmapSourceUrl(detachedParams);
      addDebugLog(`init: detached window for beatmap ${detachedParams.beatmapId}`);
    } else {
      setStatus('Checking current tab...');
      const activeTab = await queryActiveTab();

      if (!activeTab?.url) {
        throw new Error('No active tab URL found.');
      }
      sourceUrl = activeTab.url;
    }

    const info = extractBeatmapInfoFromUrl(sourceUrl);
    if (!info.valid) {
      addDebugLog(`init: invalid tab url (${info.reason})`);
      versionLine.textContent = '';
      versionLine.title = '';
      configureAudioPreview(null, null);
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

    // Set before the fetch so detaching works while the map is still loading.
    setDetachContext({ beatmapId: info.beatmapId, setId: info.setId, mode: info.mode });
    // Recorded from the URL's own request, not the resolved ruleset, so the
    // follow check compares like with like.
    state.followTarget = toFollowTarget(info);

    if (info.setId) {
      addDebugLog(`init: active set id ${info.setId}`);
      configureAudioPreview(info.setId, null);
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
      if (isStaleLoad()) {
        return;
      }
      await writeCachedPreview({
        version: 1,
        beatmapId: info.beatmapId,
        sourceUrl: info.sourceUrl,
        savedAt: Date.now(),
        osuContent,
      });
    }

    if (isStaleLoad()) {
      return;
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

    // Re-pin with the resolved set id and post-conversion mode so a detached
    // window reproduces this exact ruleset and can reach the full audio.
    setDetachContext({ beatmapId: info.beatmapId, setId: resolvedSetId, mode: mapData.mode });

    if (!Array.isArray(mapData.objects) || mapData.objects.length === 0) {
      throw new Error('Beatmap has no readable hit objects.');
    }

    const durationMs = Math.max(mapData.maxObjectTime + 2000, 2000);

    state.metadata = metadata;
    state.mapData = mapData;
    state.breaks = breaks;
    state.mappedDurationMs = durationMs;
    const resume = takePendingResume();
    const startTimeMs = resume
      ? clamp(resume.timeMs, 0, durationMs)
      : clamp(metadata.previewTime > 0 ? metadata.previewTime : 0, 0, durationMs);
    if (resume) {
      addDebugLog(`init: resuming at ${formatTime(startTimeMs)}${resume.paused ? ' (paused)' : ''}`);
    }
    setTimelineState({
      durationMs,
      currentTimeMs: startTimeMs,
    });
    configureAudioPreview(resolvedSetId, metadata.previewTime, { skipPreviewClip: Boolean(resume) });


    renderer.setBeatmap(mapData, breaks, durationMs);
    // Flattened once per map: sliders contribute a sound per node, so this is
    // longer than the object list and has its own ordering.
    state.hitsoundEvents = buildHitsoundEvents(mapData.objects, {
      samplePoints: mapData.timingControlPoints,
      defaultSampleSet: mapData.defaultSampleSet,
    });
    addDebugLog(
      `hitsounds: ${state.hitsoundEvents.length} events from ${mapData.objects.length} objects, `
      + `${(mapData.timingControlPoints || []).length} sample points`,
    );
    hitsoundPlayer.syncTo(state.hitsoundEvents, startTimeMs);
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
    if (!state.hasAutoStarted && !isStaleLoad()) {
      state.hasAutoStarted = true;
      // A preview that was paused when it popped out stays paused; auto-playing
      // would be its own discontinuity.
      if (!resume?.paused) {
        await togglePlayback();
      }
    }

    if (isStaleLoad()) {
      return;
    }

    if (resolvedSetId && metadata.audio) {
      void upgradeToFullAudioIfPossible(resolvedSetId, metadata.audio);
    } else {
      setFullAudioLoading(false);
      if (isPreviewClipAnchorable(metadata.previewTime)) {
        setAudioBadgeWithProvider(
          'preview',
          'Preview audio',
          PREVIEW_AUDIO_PROVIDER_LABEL,
          'Full audio not available for this beatmap',
        );
      } else {
        // Nothing is playing and nothing is coming: the earlier "waiting" badge
        // would otherwise sit there forever.
        setAudioBadge(
          'preview',
          'No audio available',
          'This beatmap has no preview point and no downloadable audio, so the preview runs silently.',
        );
      }
      addDebugLog('audio: metadata has no AudioFilename or set id');
    }
  } catch (error) {
    // A superseded load's failure must not wipe the map that replaced it.
    if (isStaleLoad()) {
      return;
    }
    setUnsupportedMode(false);
    addDebugLog(`init: failed -> ${error?.message || 'unknown error'}`);
    stopPlayback();
    setPlaybackSpeedControlEnabled(false);
    titleLine.textContent = 'Preview unavailable';
    versionLine.textContent = '';
    versionLine.title = '';
    configureAudioPreview(null, null);
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
    infoCachedButton,
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
    recentPanel,
    popupToast,
    detachButton,
    followButton,
    timelineTooltip,
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
    openDetachedWindow,
    toggleFollowEnabled,
    toggleCachedMapsetsPanel,
    closeCachedMapsetsPanel,
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
  state.detachedBoundsTimer = registry.clearTimeout(state.detachedBoundsTimer);
  state.audioBadgeHideTimer = registry.clearTimeout(state.audioBadgeHideTimer);
  state.toastHideTimer = registry.clearTimeout(state.toastHideTimer);
  stopPlayback();
  state.indicatorTimer = registry.clearTimeout(state.indicatorTimer);
  stopTimelineDurationAnimation();
  setFullAudioObjectUrl(null);
  stopUnsupportedAsciiAnimation();
  hitsoundPlayer.dispose();
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

// The renderer resizes its backing store from the CSS box every frame, but a
// paused preview has no frame loop, so a resize needs an explicit repaint.
if (IS_DETACHED_WINDOW) {
  window.addEventListener('resize', () => {
    persistDetachedBounds();
    if (!state.isPlaying) {
      renderFrame();
    }
  });
}

// Fired before the preview loads so the detached window is gone before this one
// starts playing, rather than both running for a moment.
if (!IS_DETACHED_WINDOW) {
  void closeDetachedWindowIfOpen();
}

setDetachContext({});
// Matches the markup's default so the toggle is in step from the first paint,
// even though the listeners only attach after the initial load.
setFollowEnabled(IS_DETACHED_WINDOW);
applyAudioVolume(DEFAULT_AUDIO_VOLUME);
applyPlaybackSpeed(1);
syncTimeLabelWidth();
applyPreviewSettings(normalizePreviewSettings());
renderDebugPanel();
renderInfoMenu();
// Following starts only once the detached window has loaded the map it was
// opened with. Attaching the listeners earlier lets the new window's own focus
// event fire a sync against a target that is not set yet, which reloads the same
// map a second time on every open.
initializePreviewForCurrentTab().finally(() => {
  if (IS_DETACHED_WINDOW) {
    startFollowingBrowsingTabs();
  }
});

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
    || changes[HITSOUNDS_KEY]
    || changes[HITSOUND_VOLUME_KEY]
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
      hitsounds: changes[HITSOUNDS_KEY]?.newValue ?? state.hitsounds,
      hitsoundVolume: changes[HITSOUND_VOLUME_KEY]?.newValue ?? state.hitsoundVolume,
    });

    renderFrame();

    if ((state.mapData?.mode ?? 0) === 0 || (state.mapData?.mode ?? 0) === 3) {
      renderFrame();
    }
  }
});
