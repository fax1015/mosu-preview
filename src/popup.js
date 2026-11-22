import { parseMetadata, parseMapPreviewData, parseBreakPeriods } from './parser.js';
import { PreviewRenderer } from './renderer.js';
import { formatTime } from './renderers/shared.js';
import { clamp } from './core/math.js';
import {
  PROVIDER_OVERRIDE_KEY,
  AUDIO_VOLUME_KEY,
  DEFAULT_AUDIO_VOLUME,
  KEYBINDINGS_KEY,
  MANIA_KEY_COUNT_KEY,
  MANIA_PRIMARY_KEY_COUNTS,
  PREVIEW_SETTING_KEYS,
  POPUP_SIZE_PRESETS,
  applyPreviewSettingChanges,
  hasPreviewSettingChange,
  normalizeManiaKeyCount,
  normalizeProviderOverride,
  normalizePreviewSettings,
} from './settings.js';
import {
  addRuntimeMessageListener,
  addStorageChangedListener,
  createTab,
  getCommandShortcut,
  hasStorageArea,
  openOptionsPage,
  storageGet,
  storageSet,
  updateTab,
} from './webextension.js';
import { registry } from './core/cleanup.js';
import { buildCachedMapsetEntries } from './core/cachedMapsets.js';
import { MODE_URL_NAMES, normalizeNumericId } from './core/beatmapUrl.js';
import { toFollowTarget } from './core/tabFollow.js';
import {
  BEATMAP_FETCH_TIMEOUT_MS,
  detachedParams,
  embeddedParams,
  fetchBeatmapFile,
  queryActiveTab,
  requestBeatmapForLoad,
  takeInitialMapRequest,
} from './mapRequest.js';
import {
  buildSectionMarks,
  findNextSectionMark,
  findPreviousSectionMark,
} from './core/sectionMarks.js';
import { formatEditorTimestamp } from './core/timestamp.js';
import { applySelectionClick, isClickAwayFromSelection } from './core/objectSelection.js';
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
import { INSTRUCTION_MESSAGE_MS, createIsland } from './ui/island.js';
import { createDebugPanelController } from './ui/debugPanel.js';
import { createDetachController } from './ui/detachController.js';
import { createEmbeddedController } from './ui/embeddedController.js';
import { bindPopupUiEvents, bindPopover } from './ui/popupUI.js';
import { createShortcutsPanel } from './ui/shortcutsPanel.js';
import { toStoredKeybindings } from './core/keybindings.js';
import { attachOverlayScrollbar } from './ui/overlayScrollbar.js';
import { createUnsupportedViewController } from './ui/unsupportedView.js';
import { createMediaSessionController } from './ui/mediaSession.js';
import { createComparePanels } from './ui/comparePanels.js';
import {
  formatStars,
  getStarRatingColour,
  getStarRatingTextColour,
  listDifficultiesForRuleset,
  parseBeatmapsetPage,
} from './core/beatmapsetPage.js';
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED, normalizePlaybackSpeed } from './core/playbackSpeed.js';

// Resolved and applied before anything else renders: the detached/embedded
// flags decide whether the document is sized as a toolbar popup or fills a
// host viewport, and a late class flip would repaint the shell at the wrong width.
const IS_DETACHED_WINDOW = detachedParams.isDetached;
const IS_EMBEDDED_PLAYER = !IS_DETACHED_WINDOW && embeddedParams.isEmbedded;
const HANDOFF_PARAMS = IS_DETACHED_WINDOW ? detachedParams : (IS_EMBEDDED_PLAYER ? embeddedParams : null);

// Applies to the map the window/miniplayer opened with, and only that one.
// Following on to a different map afterwards should start at that map's own
// preview point, not at a timestamp inherited from the map before it.
let pendingResume = HANDOFF_PARAMS && HANDOFF_PARAMS.resumeTimeMs >= 0
  ? { timeMs: HANDOFF_PARAMS.resumeTimeMs, paused: HANDOFF_PARAMS.resumePaused }
  : null;

const takePendingResume = () => {
  const resume = pendingResume;
  pendingResume = null;
  return resume;
};

if (IS_DETACHED_WINDOW) {
  document.documentElement.classList.add('is-detached-window');
}
if (IS_EMBEDDED_PLAYER) {
  document.documentElement.classList.add('is-embedded-player');
  if (embeddedParams.collapsed) {
    state.embeddedCollapsed = true;
    document.documentElement.classList.add('is-embedded-collapsed');
  }
}

const IS_FIREFOX = /firefox|fxios/i.test(globalThis.navigator?.userAgent || '');
const IS_MOBILE_VIEW = /android|mobile|tablet|ipad|iphone|ipod/i.test(globalThis.navigator?.userAgent || '')
  || Boolean(globalThis.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches);
// Firefox for Android shows the popup as a page of its own, and a tab opened
// from it opens behind that page: the user has to leave the popup to see it.
const OPENS_TABS_OUT_OF_SIGHT = IS_FIREFOX && IS_MOBILE_VIEW;

if (IS_FIREFOX) {
  document.body?.classList.add('is-firefox-popup');
}

// A phone has no windows to detach into and no keyboard to bind, so the detach
// button and the shortcuts list are left out there (see popup.css).
if (IS_MOBILE_VIEW) {
  document.documentElement.classList.add('is-mobile-view');
}

const popup = document.querySelector('#mapPreviewPopup');
const titleLine = document.querySelector('#mapPreviewTitle');
const versionLine = document.querySelector('#mapPreviewVersion');
const artistLine = document.querySelector('#mapPreviewArtist');
const subtitleLine = document.querySelector('#mapPreviewSubtitle');

// The second header line, artist and difficulty; empty and hidden without a map.
const setHeaderSubtitle = ({ artist = '', version = '' } = {}) => {
  if (artistLine) {
    artistLine.textContent = artist;
    artistLine.title = artist;
  }
  versionLine.textContent = version;
  versionLine.title = version;
  if (subtitleLine) {
    subtitleLine.hidden = !artist && !version;
  }
};
const timeLabel = document.querySelector('#mapPreviewTimeLabel');
const speedButton = document.querySelector('#mapPreviewSpeedBtn');
const speedControl = document.querySelector('#mapPreviewSpeedControl');
const speedSlider = document.querySelector('#mapPreviewSpeedSlider');
const speedResetButton = document.querySelector('#mapPreviewSpeedResetBtn');
const keysControl = document.querySelector('#mapPreviewKeysControl');
const keysButton = document.querySelector('#mapPreviewKeysBtn');
const keysDivider = document.querySelector('#mapPreviewKeysDivider');
const keysMore = document.querySelector('#mapPreviewKeysMore');
const keysMoreButton = document.querySelector('#mapPreviewKeysMoreBtn');
const keysOptions = [...document.querySelectorAll('.map-preview-keys-option')];
const playfieldCanvas = document.querySelector('#mapPreviewCanvas');
const canvasWrap = document.querySelector('#mapPreviewCanvasWrap');
const panelsElement = document.querySelector('#mapPreviewPanels');
const leadPanelLabel = document.querySelector('#mapPreviewLeadLabel');
const compareControl = document.querySelector('#mapPreviewCompareControl');
const compareButton = document.querySelector('#mapPreviewCompareBtn');
const compareList = document.querySelector('#mapPreviewCompareList');
const compareStatus = document.querySelector('#mapPreviewCompareStatus');
const timelineCanvas = document.querySelector('#mapPreviewTimeline');
const timelineTooltip = document.querySelector('#mapPreviewTimelineTooltip');
const volumeSlider = document.querySelector('#mapPreviewVolume');
const volumeButton = document.querySelector('#mapPreviewVolumeBtn');
const volumeControl = document.querySelector('#mapPreviewVolumeControl');
const volumeValue = document.querySelector('#mapPreviewVolumeValue');
const volumeSpeaker = document.querySelector('.map-preview-volume-icon-speaker');

// The volume icon only animates changes the user makes: the level restored as
// the popup opens arrives before any click or keypress, and lands still.
const enableVolumeIconMotion = () => volumeButton?.classList.add('is-animated');
document.addEventListener('pointerdown', enableVolumeIconMotion, { once: true, capture: true });
document.addEventListener('keydown', enableVolumeIconMotion, { once: true, capture: true });
const toggleIndicator = document.querySelector('#mapPreviewToggleIndicator');
const unsupportedPanel = document.querySelector('#mapPreviewUnsupported');
const unsupportedAscii = document.querySelector('#mapPreviewUnsupportedAscii');
// The island: the audio status and every message, in one small capsule in the
// preview's corner that is only there while it has something to show
// (src/ui/island.js).
const islandElement = document.querySelector('#mapPreviewIsland');
// A click on the island while it shows the audio opens the debug panel.
const audioStatusBadge = islandElement;
const popupToast = islandElement;
const debugPanel = document.querySelector('#mapPreviewDebugPanel');
const debugStatus = document.querySelector('#mapPreviewDebugStatus');
const debugLog = document.querySelector('#mapPreviewDebugLog');
const debugRunButton = document.querySelector('#mapPreviewDebugRunBtn');
const debugClearButton = document.querySelector('#mapPreviewDebugClearBtn');
const debugCloseButton = document.querySelector('#mapPreviewDebugCloseBtn');
const embedButton = document.querySelector('#mapPreviewEmbedBtn');
const detachButton = document.querySelector('#mapPreviewDetachBtn');
const followButton = document.querySelector('#mapPreviewFollowBtn');
const miniPlayButton = document.querySelector('#mapPreviewMiniPlayBtn');
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
const shortcutsList = document.querySelector('#mapPreviewShortcutsList');

const recentPanel = document.querySelector('#mapPreviewRecentPanel');
const recentList = document.querySelector('#mapPreviewRecentList');
const recentClearBtn = document.querySelector('#mapPreviewRecentClearBtn');
if (recentPanel) {
  recentPanel.inert = Boolean(recentPanel.hidden);
}
const recentScrollbar = attachOverlayScrollbar({
  scroller: recentList,
  track: document.querySelector('#mapPreviewRecentScrollbar'),
  thumb: document.querySelector('#mapPreviewRecentScrollbarThumb'),
});

const setRecentPanelHidden = (hidden) => {
  if (!recentPanel) {
    return;
  }
  const nextHidden = Boolean(hidden);
  recentPanel.hidden = nextHidden;
  recentPanel.inert = nextHidden;
};

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
    requestExpandEmbedded?.();
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
// Assigned once the playback controller exists, which its actions need. Until
// then there is nothing playing for it to report.
let mediaSessionController = null;
// The other difficulties shown beside this one; assigned once the loaders it
// uses are declared. The lead's own length is kept apart from theirs, so the
// timeline can stretch to the longest of them and back.
let comparePanels = null;
// The shortcuts panel; assigned once the writer it saves a keymap through is
// declared. Both the popup and the detached window get one.
let shortcutsPanel = null;
let leadMappedDurationMs = 1;
// What the renderers were last configured with, for a panel made later.
let lastRendererSettings = null;
const DEBUG_LOG_LIMIT = 80;
// Matches lazer's rate adjust range and precision.
const PLAYBACK_SPEED_CYCLE = [1, 0.75, 0.5, 1.5];
// What K steps through: the two counts nearly every mania player plays, and
// back to the map's own. A count picked from the rest steps on to Auto.
const MANIA_KEY_COUNT_CYCLE = Object.freeze(['auto', ...MANIA_PRIMARY_KEY_COUNTS]);
// Marathon maps run well past 12k objects (a 60-minute map is comfortably over
// 20k). Parsing all of them costs ~40MB and ~300ms, and rendering is windowed,
// so the old cap only served to cut the timeline short.
const MAX_PREVIEW_OBJECTS = 40000;
// The longest the unsupported view waits for its cached list before showing.
const RECENT_PANEL_REVEAL_WAIT_MS = 150;
// How long the loading screen holds its spinner back, and so the longest a load
// can have run without showing one. Matches the delay in popup.css.
const LOADING_MARK_DELAY_MS = 150;
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

// Where the song ends in map time, or 0 while only the preview clip (or
// nothing) is playing and its length is not the song's.
const getFullAudioEndMs = () => {
  if (!hasFullAudioSource()) {
    return 0;
  }

  // A slice cannot be trusted to know the track's length -- an MP3 slice has
  // no header to measure itself by -- but the index does.
  if (state.fullAudioDurationMs > 0) {
    return Math.round(state.fullAudioDurationMs);
  }
  return Number.isFinite(state.audio?.duration) && state.audio.duration > 0
    ? Math.round((state.audio.duration * 1000) + state.audioAnchorMapMs)
    : 0;
};

const getResolvedPlaybackDurationMs = () => {
  const mappedDurationMs = Number.isFinite(state.mappedDurationMs) && state.mappedDurationMs > 0
    ? state.mappedDurationMs
    : 1;

  return Math.max(mappedDurationMs, getFullAudioEndMs(), 1);
};

// The timestamp reserves room for the widest label this duration can produce,
// measured once per duration rather than per frame: sizing it to the live text
// would make the whole control row twitch every time a digit rolled over.
let measuredTimeLabel = '';
const syncTimeLabelWidth = ({ force = false } = {}) => {
  if (!timeLabel) {
    return;
  }

  const durationLabel = formatTime(state.durationMs);
  // The elapsed side never has more digits than the duration side. Torus has no
  // tabular figures, so its digits differ in width; zero is the widest, so zeros
  // stand in for whichever digits the elapsed side shows. The duration side is
  // known exactly and reserves no more than it needs.
  const widestLabel = `${durationLabel.replace(/\d/g, '0')} / ${durationLabel}`;
  // Keyed on the label rather than on a change of duration: loading a map sets
  // the duration before anything asks for a re-measure.
  if (!force && widestLabel === measuredTimeLabel) {
    return;
  }
  measuredTimeLabel = widestLabel;
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

// A map can load before Torus does, and a label measured in the fallback font
// reserved several pixels too many, all of it showing up as a lopsided gap.
//
// Only a face that has just loaded counts. Chrome fires loadingdone again for
// faces loaded long ago each time a media query flips, and a toolbar popup
// widened past its narrow layout (difficulties side by side) flips one on every
// relayout: re-measuring here caused the next relayout, about 130 a second.
const measuredFontFaces = new WeakSet();
document.fonts?.addEventListener?.('loadingdone', (event) => {
  const faces = Array.from(event?.fontfaces || []);
  const hasNewFace = faces.some((face) => !measuredFontFaces.has(face));
  faces.forEach((face) => measuredFontFaces.add(face));
  if (hasNewFace || faces.length === 0) {
    syncTimeLabelWidth({ force: true });
  }
});

const syncPlaybackDuration = () => {
  const previousDurationMs = state.durationMs;
  const nextDurationMs = getResolvedPlaybackDurationMs();
  setTimelineState({
    durationMs: nextDurationMs,
    currentTimeMs: clamp(state.currentTimeMs, 0, nextDurationMs),
  });
  syncTimeLabelWidth();
  const shouldAnimateTimeline = hasFullAudioSource() && nextDurationMs > previousDurationMs;
  const isAnimatingTimeline = renderer.setDuration(nextDurationMs, { animate: shouldAnimateTimeline });
  comparePanels?.setDuration(nextDurationMs);
  // The end line marks the song's end once the full track is in; until then the
  // timeline marks the last object instead.
  renderer.timeline.setSongEnd(getFullAudioEndMs() || null);
  if (isAnimatingTimeline) {
    ensureTimelineDurationAnimation();
  }
  mediaSessionController?.sync();
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

  // Only the timeline is animating while paused; repainting all playfields
  // and compare panels on every tick is wasted work.
  renderer.renderTimeline();

  if (renderer.isTimelineAnimating()) {
    state.timelineAnimationRafId = requestAnimationFrame(tickTimelineDurationAnimation);
  }
};

// Frames for a paused timeline that is still moving on its own: its length
// growing into the full track's, or its bars into another difficulty's.
const ensureTimelineDurationAnimation = () => {
  if (state.isPlaying || state.timelineAnimationRafId !== null || !renderer.isTimelineAnimating()) {
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
  setUnsupportedMode: setUnsupportedViewMode,
  stopUnsupportedAsciiAnimation,
} = unsupportedViewController;

// The island sits in the corner of whichever is the big panel: the preview, or
// the "unsupported webpage" card in its place when there is no map -- which is
// where the cached mapsets list, and its "leave this view" messages, are.
const setUnsupportedMode = (enabled) => {
  setUnsupportedViewMode(enabled);
  const home = enabled ? unsupportedPanel : canvasWrap;
  if (islandElement && home && islandElement.parentElement !== home) {
    home.append(islandElement);
  }
};

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
  // A chip left armed would otherwise still be holding the keyboard the next
  // time the panel opens.
  if (!state.shortcutsMenuOpen) {
    shortcutsPanel?.dismiss();
  }
};

// The shortcuts dialog normally sits on top of the info menu, but the `?`
// shortcut can open it directly from anywhere. Remember which route was taken
// so closing it returns to the right place instead of revealing an info menu
// the user never opened.
let shortcutsOpenedFromInfoMenu = false;

const setShortcutsMenuOpen = (isOpen) => {
  // Left out on a phone, where its button is hidden; a paired keyboard's `?`
  // must not open a dialog there is no button to have asked for.
  if (isOpen && IS_MOBILE_VIEW) {
    return;
  }
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

let recentPanelRenderToken = 0;

const renderRecentPanel = async ({ isStale = () => false } = {}) => {
  if (!recentPanel || !recentList) return;
  const renderToken = ++recentPanelRenderToken;
  const aborted = () => renderToken !== recentPanelRenderToken || isStale();

  const cachedMapsets = await getCachedMapsetSummaries();
  if (aborted()) return;
  if (!cachedMapsets || cachedMapsets.length === 0) {
    setRecentPanelHidden(true);
    return;
  }

  const history = await getHistory();
  if (aborted()) return;
  const cachedEntries = buildCachedMapsetEntries(cachedMapsets, history);

  setRecentPanelHidden(false);
  recentPanel.classList.remove('is-difficulty-view');
  const recentTitle = recentPanel.querySelector('.map-preview-recent-title');
  if (recentTitle) {
    recentTitle.textContent = 'Cached mapsets';
  }
  if (recentClearBtn) {
    recentClearBtn.hidden = false;
    recentClearBtn.style.display = '';
  }
  recentList.classList.remove('is-difficulty-grid');
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
      createTab({ url: `https://osu.ppy.sh/beatmapsets/${safeSetId}` }).then(() => {
        if (OPENS_TABS_OUT_OF_SIGHT) {
          showPopupToast('mapset page opened, exit this view to see it', { durationMs: INSTRUCTION_MESSAGE_MS });
        }
      }).catch((error) => {
        addDebugLog(`cached: could not open set ${safeSetId} (${error?.message || error})`);
        showPopupToast('Could not open that mapset', { tone: 'error' });
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
    setRecentPanelHidden(true);
    return;
  }

  await renderRecentPanel();
  // renderRecentPanel leaves the panel hidden when nothing is cached, so say so
  // rather than letting the menu entry look broken.
  if (recentPanel.hidden) {
    showPopupToast('No cached mapsets yet');
  } else {
    requestExpandEmbedded?.();
  }
};

/**
 * Dismisses the floating cached list. Deliberately does nothing on the
 * unsupported view: there the list is not an overlay over a preview, it is the
 * whole page, so closing it would leave an empty popup with no way back.
 *
 * @returns {boolean} true when the floating panel was closed.
 */
const closeCachedMapsetsPanel = () => {
  if (!recentPanel || recentPanel.hidden || popup?.classList.contains('is-unsupported')) {
    return false;
  }
  setRecentPanelHidden(true);
  return true;
};

const openExtensionOptions = async () => {
  try {
    await openOptionsPage();
  } catch {
    await createTab({ url: 'options.html' });
  }
  setInfoMenuOpen(false);
  if (OPENS_TABS_OUT_OF_SIGHT) {
    showPopupToast('settings page opened, exit this view to see settings', { durationMs: INSTRUCTION_MESSAGE_MS });
  }
};

// Whether things on the page move: off for reduced motion, and in Firefox's
// desktop toolbar popup, which has no transitions. Its detached window,
// embedded player, and Firefox for Android all animate normally.
const allowsMotion = () => !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  && !(IS_FIREFOX && !IS_DETACHED_WINDOW && !IS_EMBEDDED_PLAYER && !IS_MOBILE_VIEW);

const island = createIsland({
  element: islandElement,
  state,
  registry,
  allowMotion: allowsMotion,
});
if (!allowsMotion()) {
  islandElement?.classList.add('is-still');
}

/**
 * Every message the popup shows, in the island in the preview's corner
 * (src/ui/island.js). `tone` says what it is about, and is its colour: 'info'
 * (the default), 'done' for something asked for, 'copy' for the clipboard, or
 * 'error'. `durationMs` is how long it stays up.
 */
const showPopupToast = (message, { tone = 'info', durationMs } = {}) => {
  island.showMessage(message, { tone, durationMs });
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
  onContextChanged: () => updateEmbedButtonState(),
  onAfterOpen: IS_EMBEDDED_PLAYER ? () => requestCloseEmbedded() : null,
});

const {
  setEmbedContext,
  updateEmbedButtonState,
  openEmbeddedPlayer,
  closeEmbeddedPlayersOnOsuTabs,
  setEmbeddedFollowEnabled,
  toggleEmbeddedFollowEnabled,
  startEmbeddedBridge,
  disposeEmbeddedBridge,
  publishResumeSnapshot,
  requestCloseEmbedded,
  requestExpandEmbedded,
} = createEmbeddedController({
  state,
  registry,
  isEmbedded: IS_EMBEDDED_PLAYER,
  elements: { embedButton, followButton },
  addDebugLog,
  showPopupToast,
  loadPreview: (options) => initializePreviewForCurrentTab(options),
  closeDetachedWindowIfOpen,
  onCollapsedChange: (collapsed) => {
    document.documentElement.classList.toggle('is-embedded-collapsed', collapsed);
    if (!collapsed && !state.isPlaying && state.mapData) {
      renderFrame();
    }
  },
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

const writeKeybindingsSetting = async (bindings) => {
  await storageSet('sync', { [KEYBINDINGS_KEY]: toStoredKeybindings(bindings) });
  return true;
};

const writeAudioVolumeSetting = async (volume) => {
  try {
    await storageSet('sync', { [AUDIO_VOLUME_KEY]: clamp(volume, 0, 1) });
    return true;
  } catch {
    return false;
  }
};

// The speaker swells on the way up and shrinks on the way down, easing into
// that over the first fifth, then wobbles back on the spring the waves use.
// The stylesheet decides whether there is any motion at all (reduced motion,
// or nothing clicked yet), and how long the spring runs.
let volumeSpeakerBump = null;
const bumpVolumeSpeaker = (isLouder) => {
  if (!volumeButton || !volumeSpeaker?.animate) {
    return;
  }
  const style = getComputedStyle(volumeButton);
  if (style.getPropertyValue('--volume-motion').trim() !== '1') {
    return;
  }
  // A bump still in flight hands over from wherever it has got to, rather
  // than the speaker snapping back to its resting size first.
  const currentTransform = getComputedStyle(volumeSpeaker).transform;
  volumeSpeakerBump?.cancel();
  volumeSpeakerBump = volumeSpeaker.animate(
    [
      { transform: currentTransform === 'none' ? 'scale(1)' : currentTransform, easing: 'cubic-bezier(0.33, 0, 0.25, 1)' },
      {
        transform: `scale(${isLouder ? 1.16 : 0.86})`,
        offset: 0.2,
        easing: style.getPropertyValue('--map-preview-spring').trim() || 'ease-out',
      },
      { transform: 'scale(1)' },
    ],
    { duration: Number.parseFloat(style.getPropertyValue('--volume-spring-ms')) || 380 },
  );
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

  const percent = Math.round(nextVolume * 100);
  const label = `${percent}%`;
  if (volumeSlider) {
    volumeSlider.value = String(percent);
    volumeSlider.style.setProperty('--range-progress', label);
    volumeSlider.setAttribute('aria-valuetext', label);
  }
  if (volumeButton) {
    // How many waves the speaker icon shows: none when silent, then one for
    // each third of the range.
    const level = percent <= 0 ? 0 : Math.min(3, Math.ceil(percent / 34));
    const previousLevel = Number(volumeButton.dataset.level);
    if (level !== previousLevel) {
      volumeButton.dataset.level = String(level);
      bumpVolumeSpeaker(level > previousLevel);
    }
    volumeButton.title = `Volume (${label})`;
    volumeButton.setAttribute('aria-label', `Volume, ${label}`);
  }
  if (volumeValue) {
    volumeValue.textContent = label;
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

// True from the start of a load until its first render (see setPreviewLoading).
let isPreviewLoading = false;

// Routing the music through WebAudio builds the hitsound player's whole graph:
// tens of milliseconds in which the main thread does nothing else, and far more
// the first time a browser session opens an audio device. During a load that is
// time the preview is not on screen, so the join waits until the load is either
// idle on the network or has drawn its first frame (both in
// initializePreviewForCurrentTab). Anything that starts the audio joins first.
let isMusicAttachPending = false;

const attachPendingMusic = () => {
  if (!isMusicAttachPending) {
    return;
  }
  isMusicAttachPending = false;
  hitsoundPlayer.attachMediaElement(state.audio);
};

const requestMusicAttach = () => {
  if (isPreviewLoading && !hitsoundPlayer.isMediaElementAttached()) {
    isMusicAttachPending = true;
    return;
  }
  hitsoundPlayer.attachMediaElement(state.audio);
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
  state.hitsoundStyle = normalized.hitsoundStyle;
  state.autoplay = normalized.autoplay;
  state.embeddedPlayer = normalized.embeddedPlayer;
  state.keybindings = normalized.keybindings;
  document.documentElement.classList.toggle('is-embedded-enabled', normalized.embeddedPlayer);
  updateEmbedButtonState();
  shortcutsPanel?.setKeybindings(normalized.keybindings);
  hitsoundPlayer.setEnabled(normalized.hitsounds);
  hitsoundPlayer.setVolume(normalized.hitsoundVolume);
  hitsoundPlayer.setStyle(normalized.hitsoundStyle);
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
    requestMusicAttach();
  } else {
    isMusicAttachPending = false;
  }
  applyPopupSize(normalized.popupSize);
  // The speaker on a difficulty's pill dims while hitsounds are off.
  document.documentElement.classList.toggle('is-hitsounds-off', !normalized.hitsounds);
  renderer.setPreviewSettings(normalized);
  lastRendererSettings = normalized;
  comparePanels?.setPreviewSettings(normalized);
  applyManiaKeyCount(normalized.maniaKeyCount);
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
  attachPendingMusic();
  if (state.hitsounds || hitsoundPlayer.isMediaElementAttached()) {
    hitsoundPlayer.ensureContext();
    hitsoundPlayer.resumeContext();
  }
  return playAudioElement(...args);
};

// Every jump in the clock -- a scrub, a restart, an audio resync -- funnels
// through here, so it is the one place the hitsound cursor has to catch up.
// Without it a seek would replay every object between the old and new position.
let lastMiniPlayState = null;
const syncMiniPlayButton = () => {
  if (!miniPlayButton) {
    return;
  }
  const playing = Boolean(state.isPlaying);
  if (playing === lastMiniPlayState) {
    return;
  }
  lastMiniPlayState = playing;
  miniPlayButton.classList.toggle('is-playing', playing);
  miniPlayButton.setAttribute('aria-pressed', playing ? 'true' : 'false');
  miniPlayButton.title = playing ? 'Pause (Space)' : 'Play (Space)';
  miniPlayButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
};

const syncVisualClockToMapTime = (mapTimeMs, nowPerfMs) => {
  syncVisualClockToMapTimeRaw(mapTimeMs, nowPerfMs);
  hitsoundPlayer.syncTo(state.hitsoundEvents, state.currentTimeMs);
  mediaSessionController?.sync();
  syncMiniPlayButton();
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
  island,
  state,
  registry,
  renderDebugPanel,
  getProviderDisplayName,
  setProviderState,
});

let lastTimeLabelText = '';
let lastSelectedCount = -1;

// A hidden window's loop runs off a timer, and a browser that throttles it can
// stretch the ticks to a second apart, so its hitsounds are placed well past that.
const HIDDEN_HITSOUND_LOOKAHEAD_SEC = 2;

const isPageHidden = () => document.visibilityState === 'hidden';

// Resolves once the frame now pending has been drawn, for work that should not
// hold that frame up. A hidden page draws nothing and is given no frames, so it
// does not wait; the timer is for a page hidden while it was waiting.
const afterNextPaint = () => new Promise((resolve) => {
  if (isPageHidden()) {
    resolve();
    return;
  }
  const fallback = registry.addTimeout(setTimeout(resolve, 100));
  requestAnimationFrame(() => {
    // A task queued from the frame callback runs after that frame is painted.
    setTimeout(() => {
      registry.clearTimeout(fallback);
      resolve();
    }, 0);
  });
});

const renderFrame = () => {
  syncMiniPlayButton();
  // Cheap when nothing changed: it only re-sends a position that has drifted.
  mediaSessionController?.sync();
  // Only while playing: a paused scrub should show the map, not sound it.
  if (state.isPlaying) {
    const hidden = isPageHidden();
    hitsoundPlayer.update(state.hitsoundEvents, state.currentTimeMs, {
      rate: state.playbackSpeed,
      lookaheadSec: hidden ? HIDDEN_HITSOUND_LOOKAHEAD_SEC : undefined,
    });
    // A hidden window's playback loop runs for the clock and the hitsounds,
    // and the first frame back draws where it got to. Every other draw still
    // happens hidden: a popup's page starts out hidden, and a draw put off
    // until it was shown painted the empty map before the real one loaded.
    if (hidden) {
      return;
    }
  }
  // A zoomed timeline follows the playhead only while it plays.
  renderer.timeline.setPlaying(state.isPlaying);
  renderer.setTime(state.currentTimeMs);
  renderer.render();
  comparePanels?.render(state.currentTimeMs);

  // The label only changes once a second, but writing it every frame dirtied
  // layout, which the next frame's canvas size read then had to resolve.
  const nextTimeLabel = `${renderer.getCurrentLabel()} / ${renderer.getDurationLabel()}`;
  if (nextTimeLabel !== lastTimeLabelText) {
    lastTimeLabelText = nextTimeLabel;
    timeLabel.textContent = nextTimeLabel;
  }

  // What the button will actually copy changes with the selection, so it says
  // so -- on the same write-only-on-change footing as the label itself.
  const selectedCount = renderer.timeline?.getSelectedIndices?.().length ?? 0;
  if (selectedCount !== lastSelectedCount) {
    lastSelectedCount = selectedCount;
    const label = selectedCount === 0
      ? 'Copy timestamp (C)'
      : `Copy timestamp with ${selectedCount} object${selectedCount === 1 ? '' : 's'} (C)`;
    timeLabel.title = label;
    timeLabel.setAttribute('aria-label', label.replace(' (C)', ''));
  }
};

// Flattened once per map: sliders contribute a sound per node, so this is
// longer than the object list and has its own ordering. Taiko plays the drum.
const buildMapHitsoundEvents = (mapData) => buildHitsoundEvents(mapData.objects, {
  samplePoints: mapData.timingControlPoints,
  defaultSampleSet: mapData.defaultSampleSet,
  mode: mapData.mode,
});

// The key count only means something once a mania map is in. sourceMapData is
// cleared as each load starts, so the control is gone while the next map loads,
// and stays gone if it fails.
const getLoadedManiaMap = () => (
  state.sourceMapData && state.mapData?.mode === 3 ? state.mapData : null
);

const isManiaConvert = (mapData) => mapData?.conversion?.targetMode === 3;

const formatKeyCount = (keys) => `${keys}K`;

// The row folds away rather than leaving the page, so `inert` is what keeps
// its buttons out of reach while it is closed.
const isManiaKeysMoreOpen = () => Boolean(keysMore?.classList.contains('is-open'));

const setManiaKeysMoreOpen = (open) => {
  if (keysMore) {
    keysMore.classList.toggle('is-open', open);
    keysMore.inert = !open;
  }
  keysMoreButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
};

const closeManiaKeysPopover = () => {
  keysControl?.classList.remove('is-keys-open');
  keysButton?.setAttribute('aria-expanded', 'false');
};

const syncManiaKeyControls = () => {
  const mapData = getLoadedManiaMap();
  // Only a convert's key count can be chosen. A native mania map keeps its
  // own, as it does under lazer's key mods, so it gets no control at all
  // rather than one that does nothing.
  const showControl = Boolean(mapData) && isManiaConvert(mapData);
  if (keysControl) {
    keysControl.hidden = !showControl;
  }
  if (keysDivider) {
    keysDivider.hidden = !showControl;
  }
  if (!showControl || !keysButton) {
    closeManiaKeysPopover();
    return;
  }

  const keys = formatKeyCount(mapData.mania?.totalColumns || mapData.circleSize);
  keysButton.textContent = keys;
  const autoKeys = formatKeyCount(mapData.conversion.autoKeys);
  const isAuto = state.maniaKeyCount === 'auto';
  keysButton.title = isAuto ? `Key count (${keys}, auto)` : `Key count (${keys}; auto is ${autoKeys})`;
  keysButton.setAttribute('aria-label', isAuto ? `Key count ${keys}, auto` : `Key count ${keys}`);
  let isMinorSelected = false;
  for (const option of keysOptions) {
    const selected = option.dataset.keys === String(state.maniaKeyCount);
    option.setAttribute('aria-pressed', selected ? 'true' : 'false');
    if (selected && keysMore?.contains(option)) {
      isMinorSelected = true;
    }
  }
  keysMoreButton?.classList.toggle('has-selection', isMinorSelected);
  // A count from the second row opens with that row showing, so the pick is
  // in view rather than folded away.
  if (isMinorSelected) {
    setManiaKeysMoreOpen(true);
  }
};

/**
 * Converts the loaded map again at the key count in force, keeping the
 * playhead where it is. Only a convert changes: a native mania map keeps its
 * own count, as it does under lazer's key mods.
 */
const reconvertManiaMap = () => {
  const current = getLoadedManiaMap();
  if (!isManiaConvert(current)) {
    return;
  }

  const mapData = convertMapForMode(state.sourceMapData, 3, { maniaKeyCount: state.maniaKeyCount });
  const previousKeys = current.mania?.totalColumns;
  state.mapData = mapData;
  renderer.replaceManiaObjects(mapData);
  comparePanels?.setLeadKeys(mapData.mania?.totalColumns);
  addDebugLog(
    `mania: ${formatKeyCount(mapData.mania.totalColumns)}`
    + (mapData.conversion.keyMod ? ' (key mod)' : ' (auto)'),
  );
  // Auto landing on the count that was forced converts to the same notes, so
  // the hits already queued are still the right ones. Nor are the lead's the
  // ones playing when another difficulty's hitsounds were picked.
  if (mapData.mania.totalColumns !== previousKeys && !comparePanels?.getSoundMap()) {
    state.hitsoundEvents = buildMapHitsoundEvents(mapData);
    hitsoundPlayer.syncTo(state.hitsoundEvents, state.currentTimeMs);
  }
  if (!state.isPlaying) {
    renderFrame();
  }
};

// Applies a key count from wherever it came -- the picker, K, or a change in
// storage from another window or the options page -- converting only when it
// actually changed.
const applyManiaKeyCount = (keyCount) => {
  const normalized = normalizeManiaKeyCount(keyCount);
  if (normalized !== state.maniaKeyCount) {
    state.maniaKeyCount = normalized;
    reconvertManiaMap();
    comparePanels?.reconvert();
    if (!state.isPlaying && (comparePanels?.getCount() ?? 1) > 1) {
      renderFrame();
    }
  }
  syncManiaKeyControls();
};

// Remembered for every convert, the way a key mod stays selected in lazer.
const selectManiaKeyCount = (keyCount) => {
  applyManiaKeyCount(keyCount);
  void storageSet('sync', { [MANIA_KEY_COUNT_KEY]: state.maniaKeyCount }).catch((error) => {
    addDebugLog(`mania: could not save the key count -> ${error?.message || 'unknown error'}`);
  });
};

// K on a native mania map, which keeps its own key count and so has no
// control to change it: says why nothing happened.
const explainLockedManiaKeyCount = () => {
  const mapData = getLoadedManiaMap();
  if (mapData && !isManiaConvert(mapData)) {
    showPopupToast(`${formatKeyCount(mapData.mania?.totalColumns || mapData.circleSize)} map: key count is fixed`);
  }
};

const cycleManiaKeyCount = () => {
  const mapData = getLoadedManiaMap();
  if (!mapData) {
    return;
  }
  if (!isManiaConvert(mapData)) {
    explainLockedManiaKeyCount();
    return;
  }
  const index = MANIA_KEY_COUNT_CYCLE.indexOf(state.maniaKeyCount);
  selectManiaKeyCount(MANIA_KEY_COUNT_CYCLE[(index + 1) % MANIA_KEY_COUNT_CYCLE.length]);
};

const {
  beginAudioOperation,
  isCurrentAudioOperation,
  holdForAudioSeek,
  adoptAudioClock,
  releaseAudioClock,
  resumeAudioClockAfterStall,
  ensurePlaybackLoop,
  refreshPlaybackLoop,
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
    resetMediaClock: () => timingController.resetMediaClock?.(),
    renderFrame,
    waitForAudioSeek: (audioElement, expectedTimeSec) => waitForAudioElementSeek(audioElement, {
      expectedTimeSec,
    }),
    // Declared just below; the full-audio controller needs this one first.
    seekAudio: (targetMs, options) => seekAudioToTrackTime(targetMs, options),
  },
});

mediaSessionController = createMediaSessionController({
  getPlayback: () => ({
    isPlaying: state.isPlaying,
    positionMs: state.currentTimeMs,
    durationMs: state.durationMs,
    rate: state.playbackSpeed,
  }),
  actions: {
    play: () => {
      if (!state.isPlaying) {
        void togglePlayback();
      }
    },
    pause: () => {
      if (state.isPlaying) {
        stopPlayback();
      }
    },
    seekTo: (mapTimeMs) => seekTo(mapTimeMs),
    seekBy: (deltaMs) => seekRelative(deltaMs),
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
  canAttachMusic: () => !isMusicAttachPending,
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
    state.indicatorTimer = registry.clearTimeout(state.indicatorTimer);
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

/**
 * Jumps to the next or previous place the map names for itself -- a bookmark,
 * the start of a kiai section, or the start of a break -- and says which one
 * it landed on, since the timeline alone does not name them.
 */
const seekToSectionMark = (direction) => {
  const marks = state.sectionMarks;
  if (!state.mapData || !Array.isArray(marks) || marks.length === 0) {
    showPopupToast('This map marks no sections');
    return;
  }

  const mark = direction < 0
    ? findPreviousSectionMark(marks, state.currentTimeMs)
    : findNextSectionMark(marks, state.currentTimeMs);
  if (!mark) {
    showPopupToast(direction < 0 ? 'At the first section' : 'At the last section');
    return;
  }

  seekTo(clamp(mark.timeMs, 0, state.durationMs));
  showPopupToast(`${mark.label} — ${formatTime(mark.timeMs)}`);
};

/**
 * An osu!-editor timestamp on the clipboard, ready to paste into a mod or a
 * chat.
 *
 * With objects picked out on the timeline it names them, from the first one's
 * time -- which is the timestamp the editor would give for that selection.
 * With none it is the bare playhead, because a timestamp that named whatever
 * happened to be under the playhead would be guessing at what it is about.
 */
const copyEditorTimestamp = async () => {
  const selected = renderer.timeline?.getSelectedObjects?.() || [];
  const timeMs = selected.length > 0 ? Number(selected[0].time) : state.currentTimeMs;
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    return;
  }

  const timestamp = formatEditorTimestamp(timeMs, {
    objects: selected,
    mode: state.mapData?.mode ?? 0,
  });

  try {
    await navigator.clipboard.writeText(timestamp);
    showPopupToast(`Copied ${timestamp.replace(/\s*-\s*$/, '')}`, { tone: 'copy' });
  } catch (error) {
    addDebugLog(`ui: failed to copy timestamp -> ${error?.message || 'unknown error'}`);
    showPopupToast('Could not reach the clipboard', { tone: 'error' });
  }
};

// The last object picked out on the playfield, so shift-click there extends a
// run the same way it does on the timeline.
let playfieldSelectionAnchor = -1;

/**
 * Lets go of every picked object, for a click that lands away from the
 * preview. Escape is deliberately not wired to this: it already zooms out and
 * closes, and is given nothing else to do (see tests/popup-keys.test.js).
 *
 * @returns true when there was something to let go of.
 */
const clearObjectSelection = () => {
  const timeline = renderer.timeline;
  if (!timeline?.hasSelection()) {
    return false;
  }
  timeline.clearSelection();
  playfieldSelectionAnchor = -1;
  // A paused preview has no frame loop to take the rings off on.
  if (!state.isPlaying) {
    renderFrame();
  }
  return true;
};

/**
 * A click on a playfield that landed on an object: the lead's by default, or a
 * compared difficulty's. Only the playfield whose map the timeline is showing
 * picks anything out, since the selection is that map's objects; a click on
 * any other is play/pause as ever.
 *
 * @returns true when it picked one out, so the caller leaves playback alone.
 */
const selectObjectAtPoint = (event, { target = renderer, canvas = playfieldCanvas } = {}) => {
  const timeline = renderer.timeline;
  if (!timeline || !state.mapData || !target?.showsTimelineObjects()) {
    return false;
  }

  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const index = target.objectIndexAtPoint(event.clientX - rect.left, event.clientY - rect.top);
  if (index < 0) {
    return false;
  }

  const { selection, anchor } = applySelectionClick({
    selection: timeline.getSelectedIndices(),
    index,
    anchor: timeline.hasSelection() ? playfieldSelectionAnchor : -1,
    additive: event.ctrlKey || event.metaKey,
    ranged: event.shiftKey,
  });
  playfieldSelectionAnchor = anchor;
  timeline.setSelection(selection);
  // A paused preview has no frame loop to show the ring on.
  if (!state.isPlaying) {
    renderFrame();
  }
  return true;
};

const setMetadataText = () => {
  if (!state.metadata || !state.mapData) {
    titleLine.textContent = 'Map Preview';
    setHeaderSubtitle();
    return;
  }

  titleLine.textContent = state.metadata.title || 'Untitled';
  setHeaderSubtitle({ artist: state.metadata.artist || '', version: state.metadata.version || '' });

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

// The set's page embeds every difficulty, with star ratings, for guests too.
const fetchBeatmapsetDifficulties = async (setId) => {
  const controller = registry.createAbortController();
  const timeout = registry.addTimeout(setTimeout(() => controller.abort(), BEATMAP_FETCH_TIMEOUT_MS));
  try {
    const response = await fetch(`https://osu.ppy.sh/beatmapsets/${encodeURIComponent(setId)}`, {
      method: 'GET',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Beatmap set request failed (${response.status}).`);
    }
    const parsed = parseBeatmapsetPage(await response.text());
    if (!parsed) {
      throw new Error('The beatmap set page had no difficulty list.');
    }
    return parsed.difficulties;
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

// The grid names the first ruleset the way players do. "osu!" is the game's own
// branding and reads as a duplicate of the site beside "taiko" and the rest.
const DIFFICULTY_MODE_LABELS = Object.freeze(['standard', 'taiko', 'catch', 'mania']);
const difficultyModeLabel = (mode) => DIFFICULTY_MODE_LABELS[mode] || 'standard';

const renderDifficultiesPanel = async (setId, requestedMode = null, { isStale = () => false } = {}) => {
  if (!recentPanel || !recentList || !setId) {
    return false;
  }
  const renderToken = ++recentPanelRenderToken;
  const aborted = () => renderToken !== recentPanelRenderToken || isStale();

  let difficulties;
  try {
    difficulties = await fetchBeatmapsetDifficulties(setId);
  } catch (error) {
    addDebugLog(`diff-list: could not fetch difficulties for set ${setId} (${error?.message || error})`);
    return false;
  }
  if (aborted()) {
    return false;
  }

  if (!Array.isArray(difficulties) || difficulties.length === 0) {
    return false;
  }

  let list;
  if (Number.isInteger(requestedMode)) {
    list = listDifficultiesForRuleset(difficulties, requestedMode);
  }
  if (!list || list.length === 0) {
    const natives = difficulties.filter((entry) => entry && !entry.convert);
    list = natives.length > 0 ? natives : difficulties;
  }

  if (list.length === 0) {
    return false;
  }

  setRecentPanelHidden(false);
  recentPanel.classList.add('is-difficulty-view');
  const recentTitle = recentPanel.querySelector('.map-preview-recent-title');
  if (recentTitle) {
    recentTitle.textContent = 'Available difficulties';
  }
  if (recentClearBtn) {
    recentClearBtn.hidden = true;
    recentClearBtn.style.display = 'none';
  }
  recentList.classList.add('is-difficulty-grid');
  recentList.innerHTML = '';

  const groups = new Map();
  list.forEach((diff) => {
    const m = Number.isInteger(diff.mode) ? diff.mode : 0;
    if (!groups.has(m)) {
      groups.set(m, []);
    }
    groups.get(m).push(diff);
  });

  const sortedModes = [...groups.keys()].sort((a, b) => a - b);
  const groupsContainer = document.createElement('div');
  groupsContainer.className = 'map-preview-diff-groups';

  sortedModes.forEach((mode) => {
    const diffsInMode = groups.get(mode) || [];
    if (diffsInMode.length === 0) {
      return;
    }

    diffsInMode.sort((a, b) => {
      const starsA = a.stars ?? Number.POSITIVE_INFINITY;
      const starsB = b.stars ?? Number.POSITIVE_INFINITY;
      if (starsA !== starsB) return starsA - starsB;
      return String(a.version || '').localeCompare(String(b.version || ''));
    });

    const groupElement = document.createElement('div');
    groupElement.className = 'map-preview-diff-group';

    if (sortedModes.length > 1) {
      const header = document.createElement('div');
      header.className = 'map-preview-diff-group-header';
      header.textContent = `${difficultyModeLabel(mode)} (${diffsInMode.length})`;
      groupElement.appendChild(header);
    }

    const grid = document.createElement('div');
    grid.className = 'map-preview-diff-group-grid';

    diffsInMode.forEach((diff) => {
      const item = document.createElement('a');
      item.className = 'map-preview-recent-item';
      const modeQuery = diff.convert && Number.isInteger(diff.mode) && MODE_URL_NAMES[diff.mode]
        ? `?mode=${encodeURIComponent(MODE_URL_NAMES[diff.mode])}`
        : '';
      const targetUrl = `https://osu.ppy.sh/beatmapsets/${encodeURIComponent(setId)}/discussion/${encodeURIComponent(diff.beatmapId)}/timeline/total${modeQuery}`;
      item.href = targetUrl;
      item.rel = 'noopener noreferrer';

      const badge = document.createElement('div');
      badge.className = 'map-preview-diff-badge';

      const starPill = document.createElement('span');
      starPill.className = 'map-preview-panel-stars';
      if (Number.isFinite(diff.stars)) {
        starPill.textContent = `★ ${formatStars(diff.stars)}`;
        starPill.style.setProperty('--star-bg', getStarRatingColour(diff.stars));
        starPill.style.setProperty('--star-fg', getStarRatingTextColour(diff.stars));
      } else {
        starPill.textContent = '★ --';
      }

      badge.appendChild(starPill);

      const info = document.createElement('span');
      info.className = 'map-preview-recent-info';

      const title = document.createElement('span');
      title.className = 'map-preview-recent-item-title';
      title.textContent = diff.version || 'Difficulty';

      const modeLabel = difficultyModeLabel(diff.mode);

      item.title = `${diff.version || 'Difficulty'} (${modeLabel}${diff.convert ? ' convert' : ''}${Number.isFinite(diff.stars) ? ` ★ ${formatStars(diff.stars)}` : ''})`;

      info.appendChild(title);
      item.appendChild(badge);
      item.appendChild(info);

      item.addEventListener('click', async (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) {
          return;
        }
        event.preventDefault();
        try {
          const activeTab = await queryActiveTab().catch(() => null);
          if (activeTab?.id) {
            await updateTab(activeTab.id, { url: targetUrl });
          } else {
            await createTab({ url: targetUrl });
          }
        } catch {
          await createTab({ url: targetUrl }).catch(() => {});
        }
        initializePreviewForCurrentTab({ sourceUrlOverride: targetUrl }).catch((err) => {
          addDebugLog(`diff-select: failed to load preview (${err?.message || err})`);
        });
      });

      grid.appendChild(item);
    });

    groupElement.appendChild(grid);
    groupsContainer.appendChild(groupElement);
  });

  recentList.appendChild(groupsContainer);

  return true;
};

// Bumped by every load so an older, slower one cannot overwrite the newer map's
// state when the user switches difficulties faster than a fetch completes.
let previewLoadToken = 0;

// The popup stays invisible until it knows which view the tab gets. Showing the
// preview first meant a non-osu page flashed it before swapping in the
// unsupported view. Fades in, except in Firefox's popup, which has no
// transitions.
const revealPopup = () => {
  if (!popup || popup.classList.contains('is-open')) {
    return;
  }
  popup.classList.add('is-open');
  if (isPreviewLoading) {
    loadingShownAt = performance.now();
  }
};

// When the loading screen came into view, or null while it is not in view: it
// is up from the start of a load, but nothing is seen of it until the popup
// opens.
let loadingShownAt = null;

// The loading screen covers the shell from the start of a load until its first
// render, so the popup is never seen in a half-built state. Keyed on the shell
// rather than the overlay so both stay in step from one class.
const setPreviewLoading = (isLoading) => {
  if (!popup || isLoading === isPreviewLoading) {
    return;
  }
  isPreviewLoading = isLoading;
  if (isLoading) {
    loadingShownAt = popup.classList.contains('is-open') ? performance.now() : null;
    popup.classList.remove('is-quick-load');
  } else {
    // A load that was over before the spinner was due showed nothing but the
    // panel's own colour. Fading that out would only hold the finished preview
    // back behind it, so it goes at once (see is-quick-load in popup.css).
    const shownForMs = loadingShownAt === null ? 0 : performance.now() - loadingShownAt;
    popup.classList.toggle('is-quick-load', shownForMs < LOADING_MARK_DELAY_MS);
    loadingShownAt = null;
  }
  popup.classList.toggle('is-loading', isLoading);
  popup.setAttribute('aria-busy', isLoading ? 'true' : 'false');
};

const initializePreviewForCurrentTab = async ({ sourceUrlOverride = '', resumeOverride = null } = {}) => {
  previewLoadToken += 1;
  const loadToken = previewLoadToken;
  const isStaleLoad = () => loadToken !== previewLoadToken;

  if (resumeOverride && Number.isFinite(resumeOverride.timeMs) && resumeOverride.timeMs >= 0) {
    pendingResume = { timeMs: resumeOverride.timeMs, paused: Boolean(resumeOverride.paused) };
  }

  setPreviewLoading(true);

  // Which tab this is decides which view the popup opens on, and its map is the
  // slowest thing a load waits for, so both are asked for straight away,
  // alongside the settings below rather than after them. The page's first load
  // finds that request already made, before this file had even arrived
  // (src/mapRequest.js); it is dropped rather than used for any other load.
  const initialMapRequest = takeInitialMapRequest(sourceUrlOverride ? () => true : isStaleLoad);
  const mapRequest = (!sourceUrlOverride && initialMapRequest)
    || requestBeatmapForLoad({ sourceUrlOverride, isStaleLoad });

  stopTimelineDurationAnimation();
  stopPlayback();
  setPlaybackSpeedControlEnabled(false);
  state.mapData = null;
  state.sourceMapData = null;
  state.sectionMarks = [];
  syncManiaKeyControls();
  setUnsupportedMode(false);
  recentPanelRenderToken += 1;
  setRecentPanelHidden(true);
  void pruneFullAudioCache();
  clearDebugLogs();
  state.hasAutoStarted = false;
  state.fullAudioJobId += 1;
  setFullAudioLoading(false);
  setAudioBadgeWithProvider('preview', 'Preview audio', PREVIEW_AUDIO_PROVIDER_LABEL);
  addDebugLog('init: popup opened');

  // Independent reads, so they run at once rather than one after another: the
  // popup stays hidden until they are in, and each one is a round trip.
  const [providerOverride, , storedVolume, previewSettings] = await Promise.all([
    readProviderOverrideSetting(),
    loadProviderRuntimeState(),
    readAudioVolumeSetting(),
    readPreviewSettings(),
  ]);
  setProviderState({ providerOverride });
  addDebugLog(`init: provider override ${getProviderDisplayName(state.providerOverride)}`);
  // A following window reloads on every map switch. A volume change still
  // waiting to be written is newer than what storage holds, and applying the
  // stored one would undo it -- and then persist the undone value.
  if (state.volumePersistTimer === null) {
    applyAudioVolume(storedVolume);
  }
  addDebugLog(`init: audio volume ${Math.round(state.volume * 100)}%`);
  applyPreviewSettings(previewSettings);
  addDebugLog(
    `init: mania scroll speed ${state.maniaScrollSpeed}`
    + (state.maniaScaleScrollSpeedWithBpm ? ' (scaled with BPM)' : ' (fixed)'),
  );

  if (isStaleLoad()) {
    return;
  }

  try {
    if (IS_DETACHED_WINDOW && !sourceUrlOverride) {
      setStatus('Loading detached preview...');
      addDebugLog(`init: detached window for beatmap ${detachedParams.beatmapId}`);
    } else if (IS_EMBEDDED_PLAYER && !sourceUrlOverride) {
      setStatus('Loading embedded preview...');
      addDebugLog(`init: embedded player for beatmap ${embeddedParams.beatmapId}`);
    }

    // Which map this is, with its file already on the way.
    const { info, content: mapContentRequest, activeTab } = await mapRequest;
    if (isStaleLoad()) {
      return;
    }

    if (!IS_DETACHED_WINDOW && !IS_EMBEDDED_PLAYER) {
      if (activeTab) {
        setEmbedContext({ tabId: activeTab.id ?? null, tabUrl: activeTab.url || '' });
      } else if (sourceUrlOverride) {
        setEmbedContext({ tabId: state.embedContext?.tabId ?? null, tabUrl: sourceUrlOverride });
      }
    }

    if (!info.valid) {
      addDebugLog(`init: invalid tab url (${info.reason})`);
      setHeaderSubtitle();
      configureAudioPreview(null, null);
      if (unsupportedAscii) {
        if (unsupportedPanel) {
          const titleEl = unsupportedPanel.querySelector('.map-preview-unsupported-title');
          if (titleEl) {
            if (info.unsupportedSite) {
              titleEl.textContent = 'unsupported webpage :(';
            } else if (info.needsDifficulty) {
              titleEl.textContent = 'select a difficulty first';
            } else {
              titleEl.textContent = 'no map detected... o_0';
            }
          }
        }
        setUnsupportedMode(true);
        // The cached list is part of this view and takes room in it, so it gets
        // a moment to be in place before the popup shows rather than shoving
        // the art aside after. A slow cache read only holds it back so long.
        const listed = (info.needsDifficulty && info.setId
          ? renderDifficultiesPanel(info.setId, info.mode, { isStale: isStaleLoad }).then((ok) => {
            if (!ok && !isStaleLoad()) {
              return renderRecentPanel({ isStale: isStaleLoad });
            }
            return ok;
          })
          : renderRecentPanel({ isStale: isStaleLoad })
        ).catch((error) => {
          addDebugLog(`init: panel list unavailable -> ${error?.message || 'unknown error'}`);
        });
        let revealTimeout = null;
        try {
          await Promise.race([
            listed,
            new Promise((resolve) => {
              revealTimeout = registry.addTimeout(setTimeout(resolve, RECENT_PANEL_REVEAL_WAIT_MS));
            }),
          ]);
        } finally {
          registry.clearTimeout(revealTimeout);
        }
        if (isStaleLoad()) {
          return;
        }
      } else {
        setUnsupportedMode(false);
        titleLine.textContent = 'Preview unavailable';
        setStatus(info.needsDifficulty ? 'Select a difficulty first' : info.reason, true);
      }
      mediaSessionController?.clearTrack();
      comparePanels?.clear();
      renderer.setBeatmap({ objects: [], mode: 0, comboColours: [] }, 1);
      setTimelineState({ currentTimeMs: 0, durationMs: 1 });
      renderFrame();
      // This view is the answer, not a placeholder: nothing left to wait for.
      setPreviewLoading(false);
      revealPopup();
      return;
    }

    // Difficulties remembered beside this one are put up before the popup shows,
    // when the URL already says which set and ruleset this is, so it opens at
    // its compared width rather than widening once the map is in. They load
    // alongside the lead.
    if (info.setId && Number.isInteger(info.mode) && info.beatmapId) {
      await comparePanels?.setLead({ setId: info.setId, beatmapId: info.beatmapId, mode: info.mode });
      if (isStaleLoad()) {
        return;
      }
    }

    // A beatmap page: the preview is the right view, loading state and all.
    revealPopup();

    // Set before the fetch so detaching works while the map is still loading.
    setDetachContext({ beatmapId: info.beatmapId, setId: info.setId, mode: info.mode });
    // Recorded from the URL's own request, not the resolved ruleset, so the
    // follow check compares like with like.
    state.followTarget = toFollowTarget(info);

    if (info.setId) {
      addDebugLog(`init: active set id ${info.setId}`);
      configureAudioPreview(info.setId, null);
    }

    // With hitsounds on, the music has still to join the WebAudio graph (see
    // requestMusicAttach). A map that is still on its way leaves the main
    // thread idle, so it joins now, once the loading screen has had its frame.
    // A map that is already in is not held up for it, and joins after its
    // first frame instead.
    let isMapContentIn = false;
    const markMapContentIn = () => {
      isMapContentIn = true;
    };
    mapContentRequest.then(markMapContentIn, markMapContentIn);
    if (isMusicAttachPending) {
      void afterNextPaint().then(() => {
        if (!isMapContentIn && !isStaleLoad()) {
          attachPendingMusic();
        }
      });
    }

    setStatus(`Fetching beatmap #${info.beatmapId}...`);
    const { osuContent, fromCache } = await mapContentRequest;
    if (isStaleLoad()) {
      return;
    }
    if (fromCache) {
      setStatus(`Loaded cached beatmap #${info.beatmapId}`);
    }

    const metadata = parseMetadata(osuContent);
    const parsedMapData = parseMapPreviewData(osuContent, { maxObjects: MAX_PREVIEW_OBJECTS });
    const breaks = parseBreakPeriods(osuContent);
    const requestedMode = Number.isInteger(info.mode) ? info.mode : parsedMapData.mode;
    // Breaks feed the mania converter's drain-time difficulty, so they have to
    // be parsed before the conversion rather than alongside the renderer setup.
    const sourceMapData = { ...parsedMapData, breaks };
    const mapData = convertMapForMode(sourceMapData, requestedMode, { maniaKeyCount: state.maniaKeyCount });
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
    // Only mania converts again (for its key count); other maps need no copy.
    state.sourceMapData = mapData.mode === 3 ? sourceMapData : null;
    state.sectionMarks = buildSectionMarks(mapData);
    addDebugLog(`init: ${state.sectionMarks.length} section marks (bookmarks, kiai, breaks)`);
    leadMappedDurationMs = durationMs;
    state.mappedDurationMs = Math.max(durationMs, comparePanels?.getLongestMappedDurationMs() ?? 0);
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


    renderer.setBeatmap(mapData, durationMs, { previewTimeMs: metadata.previewTime });
    syncManiaKeyControls();
    if (mapData.mode === 3) {
      addDebugLog(
        `init: ${mapData.mania?.totalColumns}K`
        + (isManiaConvert(mapData) ? `, auto ${mapData.conversion.autoKeys}K` : ' (native, fixed)'),
      );
    }
    state.hitsoundEvents = buildMapHitsoundEvents(mapData);
    addDebugLog(
      `hitsounds: ${state.hitsoundEvents.length} events from ${mapData.objects.length} objects, `
      + `${(mapData.timingControlPoints || []).length} sample points`,
    );
    hitsoundPlayer.syncTo(state.hitsoundEvents, startTimeMs);
    syncPlaybackDuration();
    setMetadataText();
    mediaSessionController?.setTrack({
      title: metadata.title,
      artist: metadata.artist,
      version: metadata.version,
      setId: resolvedSetId,
    });
    void comparePanels?.setLead({
      setId: resolvedSetId,
      beatmapId: info.beatmapId,
      mode: mapData.mode,
      version: metadata.version,
      keys: mapData.mode === 3 ? mapData.mania?.totalColumns : null,
    });

    void addToHistory({
      beatmapId: info.beatmapId || resolvedSetId,
      beatmapSetId: resolvedSetId,
      title: metadata.title,
      artist: metadata.artist,
      creator: metadata.creator,
    });
    renderFrame();
    setPreviewLoading(false);

    setPlaybackSpeedControlEnabled(true);

    // The music joins the WebAudio graph here if it has not yet (see
    // requestMusicAttach), after the frame above is on screen rather than
    // before it, and ahead of the playback it has to be part of.
    if (isMusicAttachPending) {
      await afterNextPaint();
      if (!isStaleLoad()) {
        attachPendingMusic();
      }
    }

    // Start the current source before launching the full-audio upgrade. Both
    // paths use the same HTMLAudioElement; starting them together lets the
    // slower promise overwrite the other's seek/play state, which presents as
    // a map-specific audio delay when the full track is already cached.
    if (!state.hasAutoStarted && !isStaleLoad()) {
      state.hasAutoStarted = true;
      // A handoff carries its own playing state across: a preview that was
      // paused when it popped out stays paused, and one that was playing keeps
      // playing whatever autoplay says -- stopping it there would be its own
      // discontinuity. Autoplay only governs a preview opened from nothing.
      const shouldPlay = resume ? !resume.paused : state.autoplay;
      if (shouldPlay) {
        await togglePlayback();
      } else if (!resume) {
        addDebugLog('init: autoplay off, starting paused');
      }
    }

    if (isStaleLoad()) {
      return;
    }

    publishResumeSnapshot();

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
    revealPopup();
    addDebugLog(`init: failed -> ${error?.message || 'unknown error'}`);
    stopPlayback();
    setPlaybackSpeedControlEnabled(false);
    titleLine.textContent = 'Preview unavailable';
    setHeaderSubtitle();
    configureAudioPreview(null, null);
    setStatus(error?.message || 'Failed to load beatmap preview.', true);
    mediaSessionController?.clearTrack();
    comparePanels?.clear();
    renderer.setBeatmap({ objects: [], mode: 0, comboColours: [] }, 1);
    leadMappedDurationMs = 1;
    state.mappedDurationMs = 1;
    setTimelineState({ currentTimeMs: 0, durationMs: 1 });
    syncTimeLabelWidth();
    renderFrame();
    setPreviewLoading(false);
  }
};

// Parsed and converted the way the lead is, into the lead's ruleset.
const prepareCompareMap = (osuContent, mode) => {
  const metadata = parseMetadata(osuContent);
  const parsedMapData = parseMapPreviewData(osuContent, { maxObjects: MAX_PREVIEW_OBJECTS });
  const sourceMapData = { ...parsedMapData, breaks: parseBreakPeriods(osuContent) };
  const mapData = convertMapForMode(sourceMapData, mode, { maniaKeyCount: state.maniaKeyCount });
  return { metadata, sourceMapData, mapData };
};

// The hitsounds and the timeline of whichever difficulty is in focus (picked
// by its pill), or the lead's. syncTo picks up at the playhead, so a switch
// mid-play neither replays nor skips a note. The timeline shows that
// difficulty's objects, its bars growing and shrinking out of the last one's;
// the view and the playhead stay put, as the song has not changed.
const switchHitsoundSource = (sourceMap) => {
  const map = sourceMap || state.mapData;
  if (!map) {
    return;
  }
  state.hitsoundEvents = buildMapHitsoundEvents(map);
  hitsoundPlayer.syncTo(state.hitsoundEvents, state.currentTimeMs);
  addDebugLog(`hitsounds: from ${sourceMap ? 'an added difficulty' : 'the opened map'} (${state.hitsoundEvents.length} events)`);

  // What was picked out belonged to the map the timeline showed before.
  playfieldSelectionAnchor = -1;
  renderer.showTimelineMap(map, {
    animate: !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
  });
  if (!state.isPlaying) {
    renderFrame();
    ensureTimelineDurationAnimation();
  }
};

const togglePlaybackWithFeedback = async () => {
  const wasPlaying = state.isPlaying;
  const isPlayingNow = await togglePlayback();
  if (isPlayingNow || wasPlaying) {
    showCanvasToggleFeedback(wasPlaying ? 'pause' : 'play');
  }
};

comparePanels = createComparePanels({
  root: document.documentElement,
  canvasWrap,
  panelsElement,
  leadLabel: leadPanelLabel,
  control: compareControl,
  button: compareButton,
  listElement: compareList,
  statusElement: compareStatus,
  allowMotion: allowsMotion,
  bindPopover,
  fetchDifficulties: fetchBeatmapsetDifficulties,
  fetchBeatmap: fetchBeatmapFile,
  prepareMap: prepareCompareMap,
  convertMap: (sourceMapData, mode) => convertMapForMode(sourceMapData, mode, { maniaKeyCount: state.maniaKeyCount }),
  onSoundSourceChange: switchHitsoundSource,
  createRenderer: (canvas) => {
    const panelRenderer = new PreviewRenderer(canvas, null, {
      lowLatency: false,
      // Rings what is picked on the lead's timeline while it shows this one.
      selectionTimeline: renderer.timeline,
    });
    if (lastRendererSettings) {
      panelRenderer.setPreviewSettings(lastRendererSettings);
    }
    return panelRenderer;
  },
  renderPlayfields: () => {
    // Before a map is in there is nothing to draw but "no preview".
    if (!state.mapData) {
      return;
    }
    renderer.setTime(state.currentTimeMs);
    renderer.renderPlayfield();
    comparePanels?.render(state.currentTimeMs);
  },
  getDurationMs: () => state.durationMs,
  readSession: async (key) => {
    if (!hasStorageArea('session', 'local')) {
      return null;
    }
    const items = await storageGet('session', [key], { fallbackAreaName: 'local' });
    return items?.[key] ?? null;
  },
  writeSession: async (key, value) => {
    if (hasStorageArea('session', 'local')) {
      await storageSet('session', { [key]: value }, { fallbackAreaName: 'local' });
    }
  },
  onPanelsChanged: () => {
    state.mappedDurationMs = Math.max(leadMappedDurationMs, comparePanels?.getLongestMappedDurationMs() ?? 0);
    // Before the first map is in there is nothing to draw but "no preview".
    if (state.mapData) {
      syncPlaybackDuration();
      if (!state.isPlaying) {
        renderFrame();
      }
    }
  },
  // A compared difficulty's playfield: an object on it is picked out while the
  // timeline shows that difficulty, as on the lead's; elsewhere it is play/pause.
  onCanvasClick: (event, panelRenderer) => {
    if (event && panelRenderer && selectObjectAtPoint(event, { target: panelRenderer, canvas: event.target })) {
      return;
    }
    void togglePlaybackWithFeedback();
  },
  addDebugLog,
});

shortcutsPanel = createShortcutsPanel({
  listElement: shortcutsList,
  state,
  persistKeybindings: writeKeybindingsSetting,
  showPopupToast,
  addDebugLog,
});
shortcutsPanel.render();

// The browser owns the shortcut that opens the preview and the user can change
// or clear it, so the row reads it rather than repeating the manifest's
// suggestion. It arrives late; the panel redraws when it does.
getCommandShortcut('_execute_action').then((shortcut) => {
  if (shortcut !== null) {
    shortcutsPanel?.setBrowserShortcut(shortcut);
  }
}).catch(() => {});

bindPopupUiEvents({
  elements: {
    speedButton,
    speedControl,
    speedSlider,
    speedResetButton,
    keysButton,
    keysControl,
    keysMoreButton,
    playfieldCanvas,
    timelineCanvas,
    audioStatusBadge,
    compareControl,
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
    volumeButton,
    volumeControl,
    volumeSlider,
    timeLabel,
    shortcutsButton,
    shortcutsModal,
    shortcutsBackdrop,
    shortcutsCloseButton,
    recentClearBtn,
    recentPanel,
    popupToast,
    embedButton,
    detachButton,
    followButton,
    miniPlayButton,
    timelineTooltip,
  },
  state,
  renderer,
  registry,
  supportLinks: SUPPORT_LINKS,
  actions: {
    dismissComparePicker: () => Boolean(comparePanels?.dismissPicker()),
    cyclePlaybackSpeed,
    applyPlaybackSpeed,
    selectManiaKeyCount,
    cycleManiaKeyCount,
    toggleManiaKeysMore: () => setManiaKeysMoreOpen(!isManiaKeysMoreOpen()),
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
    seekToSectionMark,
    copyEditorTimestamp,
    selectObjectAtPoint,
    consumeShortcutCapture: (event) => Boolean(shortcutsPanel?.consumeCaptureKey(event)),
    restartPreview,
    toggleMute,
    setShortcutsMenuOpen,
    openEmbeddedPlayer,
    openDetachedWindow,
    toggleFollowEnabled: IS_EMBEDDED_PLAYER ? toggleEmbeddedFollowEnabled : toggleFollowEnabled,
    closePreview: IS_EMBEDDED_PLAYER ? () => requestCloseEmbedded() : () => window.close(),
    toggleCachedMapsetsPanel,
    closeCachedMapsetsPanel,
    clearHistory: async () => {
      await clearFullAudioCache();
      await clearHistory();
      await updateRecentClearButtonCacheUsage();
      showPopupToast('Cache cleared', { tone: 'done' });
      void renderRecentPanel();
    },
  },
});

// Clicking anywhere that is not the preview lets the picked objects go: the
// playfield and the timeline are where they live and where they are chosen, so
// anywhere else is a click away from them.
//
// Pointerdown rather than click, to match the other dismiss-on-outside
// handlers, and listening on the document so it catches the header, the
// controls, the menus and the gaps between them alike.
document.addEventListener('pointerdown', (event) => {
  if (isClickAwayFromSelection(event.target, {
    previewArea: canvasWrap,
    timelineCanvas,
    copyButton: timeLabel,
  })) {
    clearObjectSelection();
  }
});

// `pagehide` rather than `unload`: `unload` is deprecated, is not guaranteed to
// fire, and blocks the back/forward cache. CleanupRegistry listens on the same
// event, so both teardown paths now agree.
window.addEventListener('pagehide', () => {
  // Capture live playback position and playing intent before teardown zeroes them.
  disposeEmbeddedBridge();
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
  comparePanels?.dispose?.();
  recentScrollbar?.dispose?.();
  renderer?.dispose?.();
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
if (IS_DETACHED_WINDOW || IS_EMBEDDED_PLAYER) {
  window.addEventListener('resize', () => {
    if (IS_DETACHED_WINDOW) {
      persistDetachedBounds();
    }
    if (!state.isPlaying) {
      renderFrame();
    }
  });
}

// Minimised or covered, a detached window plays on through the playback loop's
// timer, and back on frames once it is shown again.
document.addEventListener('visibilitychange', refreshPlaybackLoop);

// Fired before the preview loads so any other live preview surface is closed
// before this one starts playing, rather than two previews playing over each other.
if (!IS_DETACHED_WINDOW && !IS_EMBEDDED_PLAYER) {
  void closeDetachedWindowIfOpen();
  void closeEmbeddedPlayersOnOsuTabs();
} else if (IS_DETACHED_WINDOW) {
  void closeEmbeddedPlayersOnOsuTabs();
}

setDetachContext({});
// Matches the markup's default so the toggle is in step from the first paint,
// even though the listeners only attach after the initial load.
if (IS_EMBEDDED_PLAYER) {
  setEmbeddedFollowEnabled(embeddedParams.followEnabled);
} else {
  setFollowEnabled(IS_DETACHED_WINDOW);
}
applyAudioVolume(DEFAULT_AUDIO_VOLUME);
applyPlaybackSpeed(1);
syncTimeLabelWidth();
applyPreviewSettings(normalizePreviewSettings());
renderDebugPanel();
renderInfoMenu();
// Following starts only once the detached window or embedded player has loaded
// the map it was opened with. Attaching the listeners earlier lets initial
// focus or tab events trigger a duplicate reload of the same map.
initializePreviewForCurrentTab().finally(() => {
  // Whatever happened, the popup must not stay invisible -- or under its
  // loading screen, if the load threw before it could clear that itself.
  setPreviewLoading(false);
  revealPopup();
  if (IS_DETACHED_WINDOW) {
    startFollowingBrowsingTabs();
  } else if (IS_EMBEDDED_PLAYER) {
    startEmbeddedBridge({ initialFollowEnabled: embeddedParams.followEnabled });
  }
});

addStorageChangedListener((changes, areaName) => {
  if (areaName !== 'sync') {
    return;
  }

  // The volume lives outside the preview-settings bundle because the slider
  // writes it on a debounce. A write still waiting here is newer than
  // whatever storage now holds, so applying that would undo the drag the user
  // is in the middle of -- the same guard the initial read uses.
  if (Object.hasOwn(changes, AUDIO_VOLUME_KEY) && state.volumePersistTimer === null) {
    const candidate = Number(changes[AUDIO_VOLUME_KEY]?.newValue);
    if (Number.isFinite(candidate)) {
      // applyAudioVolume only moves the level and its slider; persisting is a
      // separate call, so reacting here writes nothing back.
      applyAudioVolume(clamp(candidate, 0, 1));
    }
  }

  if (Object.hasOwn(changes, PROVIDER_OVERRIDE_KEY)) {
    const providerOverride = normalizeProviderOverride(changes[PROVIDER_OVERRIDE_KEY]?.newValue);
    setProviderState({ providerOverride });
    addDebugLog(`settings: provider override updated -> ${getProviderDisplayName(providerOverride)}`);
  }

  if (!hasPreviewSettingChange(changes)) {
    return;
  }

  // `state` carries every preview setting under its own key, so it stands in
  // for the settings in force.
  const nextSettings = applyPreviewSettingChanges(state, changes);
  applyPreviewSettings(nextSettings);
  if (IS_EMBEDDED_PLAYER && !nextSettings.embeddedPlayer) {
    requestCloseEmbedded();
    return;
  }
  renderFrame();
});
