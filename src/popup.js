import { parseMetadata, parseMapPreviewData, parseBreakPeriods } from './parser.js';
import { PreviewRenderer, formatTime } from './renderer.js';
import { clamp } from './core/math.js';
import {
  PROVIDER_OVERRIDE_KEY,
  AUDIO_VOLUME_KEY,
  DEFAULT_AUDIO_VOLUME,
  PREVIEW_SETTING_KEYS,
  POPUP_SIZE_PRESETS,
  applyPreviewSettingChanges,
  hasPreviewSettingChange,
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
  storageGet,
  storageSet,
} from './webextension.js';
import { registry } from './core/cleanup.js';
import { buildCachedMapsetEntries } from './core/cachedMapsets.js';
import { extractBeatmapInfoFromUrl, normalizeNumericId } from './core/beatmapUrl.js';
import { buildBeatmapSourceUrl, readDetachedParams } from './core/detachedWindow.js';
import { toFollowTarget } from './core/tabFollow.js';
import { convertMapForMode } from './core/beatmapConversion.js';
import { getHistory, addToHistory, clearHistory, setHistoryDebugLogger } from './core/history.js';
import {
  state,
  resetState,
  setTimelineState,
  setUiState,
  setProviderState,
} from './core/state.js';
import { createTimingController } from './core/timing.js';
import {
  getCachedMapsetSummaries,
  clearFullAudioCache,
  getFullAudioCacheUsage,
  pruneFullAudioCache,
  setFullAudioCacheDebugLogger,
} from './audio/cache.js';
import { isPreviewClipAnchorable } from './audio/seek.js';
import { getProviderDisplayName, loadProviderRuntimeState } from './audio/provider.js';
import { createPlaybackController } from './audio/playback.js';
import { PREVIEW_AUDIO_PROVIDER_LABEL, createFullAudioController } from './audio/fullAudioController.js';
import { waitForAudioElementSeek } from './audio/mediaEvents.js';
import { buildHitsoundEvents, createHitsoundPlayer } from './audio/hitsounds.js';
import { createAudioBadgeController } from './ui/audioBadge.js';
import { createDebugPanelController } from './ui/debugPanel.js';
import { createDetachController } from './ui/detachController.js';
import { bindPopupUiEvents } from './ui/popupUI.js';
import { createUnsupportedViewController } from './ui/unsupportedView.js';
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED, normalizePlaybackSpeed } from './core/playbackSpeed.js';

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
const DEBUG_LOG_LIMIT = 80;
// Matches lazer's rate adjust range and precision.
const PLAYBACK_SPEED_CYCLE = [1, 0.75, 0.5, 1.5];
// Marathon maps run well past 12k objects (a 60-minute map is comfortably over
// 20k). Parsing all of them costs ~40MB and ~300ms, and rendering is windowed,
// so the old cap only served to cut the timeline short.
const MAX_PREVIEW_OBJECTS = 40000;
const BEATMAP_FETCH_TIMEOUT_MS = 15000;
const SUPPORT_LINKS = {
  issue: 'https://github.com/fax1015/mosu-preview/issues/new',
  osu: 'https://osu.ppy.sh/users/faxaxaxa',
};
// Display names, indexed by mode number.
const MODE_LABELS = Object.freeze(['osu!', 'taiko', 'catch', 'mania']);
const UNSUPPORTED_ASCII_TICK_MS = 240;
const UNSUPPORTED_ASCII_CHAR_WIDTH_PX = 6.2;
const UNSUPPORTED_ASCII_CHAR_HEIGHT_PX = 11.2;
const UNSUPPORTED_ASCII_XY_RATIO = UNSUPPORTED_ASCII_CHAR_WIDTH_PX / UNSUPPORTED_ASCII_CHAR_HEIGHT_PX;

// The full track, or the slice of it playback runs from after a seek.
const hasFullAudioSource = () => (
  state.audioSyncEnabled
  && Boolean(state.fullAudioObjectUrl)
  && typeof state.audio?.src === 'string'
  && (
    state.audio.src === state.fullAudioObjectUrl
    || (Boolean(state.fullAudioSliceUrl) && state.audio.src === state.fullAudioSliceUrl)
  )
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

  // A slice cannot be trusted to know the track's length -- an MP3 slice has
  // no header to measure itself by -- but the index does.
  const audioDurationMs = state.fullAudioDurationMs > 0
    ? Math.round(state.fullAudioDurationMs)
    : (Number.isFinite(state.audio?.duration) && state.audio.duration > 0
      ? Math.round((state.audio.duration * 1000) + state.audioAnchorMapMs)
      : 0);

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
    // A real button, so the list can be reached and opened from the keyboard.
    // Its parts are spans because a button may only hold phrasing content.
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'map-preview-recent-item';
    const thumbnail = document.createElement('span');
    thumbnail.className = 'map-preview-recent-thumbnail';
    thumbnail.setAttribute('aria-hidden', 'true');
    const safeSetId = normalizeNumericId(entry.beatmapSetId);
    if (safeSetId) {
      thumbnail.style.backgroundImage = `url("https://assets.ppy.sh/beatmaps/${safeSetId}/covers/list.jpg")`;
    } else {
      item.disabled = true;
    }

    const info = document.createElement('span');
    info.className = 'map-preview-recent-info';

    const title = document.createElement('span');
    title.className = 'map-preview-recent-item-title';
    title.textContent = entry.title || `Beatmap set #${safeSetId || 'unknown'}`;

    const meta = document.createElement('span');
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
      createTab({ url: `https://osu.ppy.sh/beatmapsets/${safeSetId}` }).catch((error) => {
        addDebugLog(`cached: could not open set ${safeSetId} (${error?.message || error})`);
      });
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


const {
  setDetachContext,
  openDetachedWindow,
  closeDetachedWindowIfOpen,
  setFollowEnabled,
  toggleFollowEnabled,
  startFollowingBrowsingTabs,
  persistDetachedBounds,
} = createDetachController({
  state,
  registry,
  elements: { detachButton, followButton },
  addDebugLog,
  showPopupToast,
  // Declared further down; resolved when a followed tab actually changes.
  loadPreview: (options) => initializePreviewForCurrentTab(options),
});

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
  // Once the music is routed through WebAudio its gain node is the volume
  // control and the element stays at 1, or the level would be applied twice.
  // The gain is kept current either way, so an attach later starts at the
  // right level.
  hitsoundPlayer.setMusicVolume(nextVolume);
  state.audio.volume = hitsoundPlayer.isMediaElementAttached() ? 1 : nextVolume;

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
  // The music joins the WebAudio graph the first time hitsounds are on, so the
  // two share one output latency; until then it plays straight from the
  // element, without that delay. It does not leave again when they are switched
  // off: an element cannot be taken back out of the graph, and disconnecting it
  // silenced the music (see attachMediaElement).
  //
  // Joining needs no clock rebase. The visual clock applies the live latency
  // every frame, and the hitsound player's backward-seek tolerance absorbs the
  // one-time step -- an explicit syncTo() here would cancel and reschedule the
  // hits already queued, which sounds doubled.
  if (normalized.hitsounds) {
    hitsoundPlayer.attachMediaElement(state.audio);
  }
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

// Phones get bigger audio buffers: with the default ones, Firefox for Android
// crackled through the synthesised hitsounds whenever the device was busy.
// Desktop keeps the default, which is what its latency compensation was
// measured against.
const hitsoundPlayer = createHitsoundPlayer({
  onLog: addDebugLog,
  latencyHint: IS_MOBILE_VIEW ? 'playback' : undefined,
});

const timingController = createTimingController({
  state,
  clamp,
  getOutputLatencySec: hitsoundPlayer.getOutputLatencySec,
  getAttachedLatencySec: hitsoundPlayer.getAttachedLatencySec,
  isMediaElementAttached: hitsoundPlayer.isMediaElementAttached,
});
const {
  getCurrentManualMapTime,
  syncVisualClockToMapTime: syncVisualClockToMapTimeRaw,
  getAudioMappedTimeMs,
  getAudioOutputLatencyMapMs,
  isAudioClockAuthoritative,
  applyPlaybackRate,
} = timingController;

// A suspended AudioContext (autoplay policy) has to be resumed from the same
// user gesture that starts the media element, and music routed through it is
// silent until it is -- including after hitsounds were switched back off.
// Wrapping play() covers every caller (the playback controller, the hotswap)
// without threading a helper through each of them.
const playAudioElement = state.audio.play.bind(state.audio);
state.audio.play = (...args) => {
  if (state.hitsounds || hitsoundPlayer.isMediaElementAttached()) {
    hitsoundPlayer.ensureContext();
    hitsoundPlayer.resumeContext();
  }
  return playAudioElement(...args);
};

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

const {
  setFullAudioLoading,
  setAudioBadge,
  hideAudioBadge,
  setAudioBadgeWithProvider,
  showTryingArchiveProviderBadge,
} = createAudioBadgeController({
  badge: audioStatusBadge,
  state,
  registry,
  renderDebugPanel,
  getProviderDisplayName,
  setProviderState,
});

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
    getAudioOutputLatencyMapMs,
    isAudioClockAuthoritative,
    syncVisualClockToMapTime,
    renderFrame,
    waitForAudioSeek: (audioElement, expectedTimeSec) => waitForAudioElementSeek(audioElement, {
      expectedTimeSec,
    }),
    // Declared just below; the full-audio controller needs this one first.
    seekAudio: (targetMs, options) => seekAudioToTrackTime(targetMs, options),
  },
});

const {
  configureAudioPreview,
  upgradeToFullAudioIfPossible,
  runAudioFetchProbe,
  releaseFullAudioObjectUrl,
  seekAudioToTrackTime,
} = createFullAudioController({
  state,
  registry,
  hitsoundPlayer,
  addDebugLog,
  badge: {
    setAudioBadge,
    setAudioBadgeWithProvider,
    hideAudioBadge,
    setFullAudioLoading,
    showTryingArchiveProviderBadge,
  },
  playback: {
    beginAudioOperation,
    isCurrentAudioOperation,
    holdForAudioSeek,
    adoptAudioClock,
    releaseAudioClock,
  },
  timing: {
    getAudioMappedTimeMs,
    getAudioOutputLatencyMapMs,
  },
  syncPlaybackDuration,
  renderFrame,
  getCurrentMapsetInfo,
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
  const modeLabel = MODE_LABELS[state.mapData.mode] || 'unknown';

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
  const direct = normalizeNumericId(beatmapSetID);
  if (direct) {
    return direct;
  }
  const match = beatmapSetID.match(/beatmapsets\/(\d+)/i);
  return match ? match[1] : null;
};

const queryActiveTab = async () => {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  return Array.isArray(tabs) ? tabs[0] : null;
};

const fetchBeatmapFile = async (beatmapId) => {
  const controller = registry.createAbortController();
  // A .osu file is a few hundred KB at most. Without a deadline a stalled
  // request left "Fetching beatmap" on screen until the popup was closed.
  const timeout = registry.addTimeout(setTimeout(() => controller.abort(), BEATMAP_FETCH_TIMEOUT_MS));
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
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('osu.ppy.sh did not answer in time.');
    }
    throw error;
  } finally {
    registry.clearTimeout(timeout);
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
  const storedVolume = await readAudioVolumeSetting();
  // A following window reloads on every map switch. A volume change still
  // waiting to be written is newer than what storage holds, and applying the
  // stored one would undo it -- and then persist the undone value.
  if (state.volumePersistTimer === null) {
    applyAudioVolume(storedVolume);
  }
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
      renderer.setBeatmap({ objects: [], mode: 0, comboColours: [] }, 1);
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
    if (mapData.mode !== parsedMapData.mode) {
      addDebugLog(
        `init: converted ${MODE_LABELS[parsedMapData.mode] || 'unknown'} -> ${MODE_LABELS[mapData.mode] || 'unknown'}`,
      );
    } else {
      addDebugLog(`init: using ${MODE_LABELS[mapData.mode] || 'unknown'} ruleset`);
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


    renderer.setBeatmap(mapData, durationMs);
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
    renderer.setBeatmap({ objects: [], mode: 0, comboColours: [] }, 1);
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
  releaseFullAudioObjectUrl();
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
  if (areaName !== 'sync' || !hasPreviewSettingChange(changes)) {
    return;
  }

  // `state` carries every preview setting under its own key, so it stands in
  // for the settings in force.
  applyPreviewSettings(applyPreviewSettingChanges(state, changes));
  renderFrame();
});
