import { bindTimelineInput } from './timelineInput.js';
import { createKeybindingLookup, eventKeyToken } from '../core/keybindings.js';

// Speed, volume and mania's key count each show their value on a button that
// opens a panel above it. All open and close on click alone: hover-to-open has
// no equivalent on touch, where there is no pointer to move away. Read back
// from the class rather than a local flag, so a popover cannot get out of step
// when loading a map force-closes it. `canOpen` covers a button that stays
// but has nothing to open yet (the compare picker before its map's set is in).
const bindPopover = ({
  control, button, openClass, canOpen = () => true,
}) => {
  const isOpen = () => Boolean(control?.classList.contains(openClass));

  const setOpen = (open) => {
    const nextOpen = open && Boolean(control) && !button?.disabled && canOpen();
    if (nextOpen === isOpen()) {
      return;
    }
    control?.classList.toggle(openClass, nextOpen);
    button?.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  };

  button?.addEventListener('click', () => {
    setOpen(!isOpen());
  });

  // Covers keyboard dismissal; pointers are handled by the outside pointerdown.
  // A click on a plain part of the panel moves focus to the body rather than to
  // another element, which reads as `relatedTarget: null` -- focus has not left
  // the popover, so that must not close it. Only focus moving to another
  // element outside does.
  control?.addEventListener('focusout', (event) => {
    if (!event.relatedTarget || control.contains(event.relatedTarget)) {
      return;
    }
    setOpen(false);
  });

  document.addEventListener('pointerdown', (event) => {
    if (!isOpen() || control?.contains(event.target)) {
      return;
    }
    setOpen(false);
  });

  // For the Escape chain: closes it if open, handing focus back to the button.
  const dismiss = () => {
    if (!isOpen()) {
      return false;
    }
    if (control?.contains(document.activeElement)) {
      button?.focus();
    }
    setOpen(false);
    return true;
  };

  return { dismiss };
};

const bindPopupUiEvents = ({
  elements,
  state,
  renderer,
  registry,
  actions,
  supportLinks,
}) => {
  const {
    speedButton,
    speedControl,
    speedSlider,
    speedResetButton,
    keysButton,
    keysControl,
    keysMoreButton,
    playfieldCanvas,
    compareControl,
    timelineCanvas,
    audioStatusBadge,
    infoButtons = [],
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
    embedButton,
    detachButton,
    followButton,
    miniPlayButton,
    timelineTooltip,
  } = elements;

  const {
    dismissComparePicker = () => false,
    cyclePlaybackSpeed,
    applyPlaybackSpeed,
    selectManiaKeyCount,
    cycleManiaKeyCount,
    toggleManiaKeysMore,
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
    seekRelative,
    seekTo,
    seekToSectionMark,
    copyEditorTimestamp,
    selectObjectAtPoint,
    consumeShortcutCapture,
    restartPreview,
    toggleMute,
    setShortcutsMenuOpen,
    clearHistory,
    openEmbeddedPlayer,
    openDetachedWindow,
    toggleFollowEnabled,
    closePreview = () => window.close(),
    toggleCachedMapsetsPanel,
    closeCachedMapsetsPanel,
  } = actions;

  // What a focused range input does for itself.
  const SLIDER_OWN_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];

  // One frame at 60fps: fine enough to step through a stack, coarse enough that
  // holding the key still moves visibly.
  const FRAME_STEP_MS = 1000 / 60;
  const SPEED_NUDGE_STEP = 0.05;

  const timelineControls = bindTimelineInput({
    canvas: timelineCanvas,
    tooltip: timelineTooltip,
    state,
    renderer,
    seekTo,
  });

  const trapDialogTab = (event, modalShell) => {
    if (event.key !== 'Tab' || !modalShell || modalShell.hidden) {
      return false;
    }

    const focusable = [...modalShell.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter((el) => !el.disabled && el.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      return true;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return true;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
      return true;
    }
    return false;
  };

  // Rebuilt only when the keymap is replaced -- which is what a rebind and a
  // settings change both do -- rather than on every keypress.
  let cachedBindings = null;
  let cachedLookup = new Map();
  const actionForEvent = (event) => {
    if (state.keybindings !== cachedBindings) {
      cachedBindings = state.keybindings;
      cachedLookup = createKeybindingLookup(state.keybindings);
    }
    return cachedLookup.get(eventKeyToken(event)) ?? null;
  };

  const scheduleVolumePersist = () => {
    if (typeof writeAudioVolumeSetting !== 'function') {
      return;
    }
    state.volumePersistTimer = registry.clearTimeout(state.volumePersistTimer);
    state.volumePersistTimer = registry.addTimeout(setTimeout(async () => {
      state.volumePersistTimer = registry.clearTimeout(state.volumePersistTimer);
      await writeAudioVolumeSetting(state.volume);
    }, 220));
  };

  document.addEventListener('keydown', async (event) => {
    // An armed chip in the shortcuts panel owns the keyboard outright: the
    // next key is the one being bound, so nothing below may read it first --
    // not the dialog's Tab trap and not Escape, which here means "never mind".
    if (consumeShortcutCapture?.(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (trapDialogTab(event, state.shortcutsMenuOpen ? shortcutsModal : infoModal)) {
      return;
    }

    const { key, shiftKey } = event;

    // Ignore while typing. A slider is an input too, but nothing is typed
    // into one: it keeps the keys that move it and the rest stay shortcuts.
    // Treating it as a text field left Space, M and every other key dead
    // from the moment the volume was dragged until something else was clicked.
    const isSlider = event.target.tagName === 'INPUT' && event.target.type === 'range';
    const isTyping = (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && !isSlider)
      || event.target.isContentEditable;
    if (isTyping) return;
    if (isSlider && SLIDER_OWN_KEYS.includes(key)) return;

    // Ctrl+R, Cmd+W and the like belong to the browser; in the detached window
    // Ctrl+R used to restart the preview as well as reload it. AltGr arrives as
    // Ctrl+Alt on Windows, and is how several layouts type `[` and `]`.
    const hasCommandModifier = (event.ctrlKey || event.metaKey || event.altKey)
      && !event.getModifierState?.('AltGraph');
    if (hasCommandModifier) {
      return;
    }

    const action = actionForEvent(event);

    // A dialog is modal: the preview behind it must not react, and Space on one
    // of its buttons has to reach that button instead of toggling playback.
    if (state.infoMenuOpen || state.shortcutsMenuOpen) {
      if (action === 'showShortcuts') {
        setShortcutsMenuOpen(!state.shortcutsMenuOpen);
      }
      return;
    }

    // Focused buttons and links own Space and Enter so keyboard users can
    // activate any toolbar or panel control without hijacking playback.
    const isInteractiveButtonOrLink = event.target?.tagName === 'BUTTON'
      || event.target?.tagName === 'A'
      || Boolean(event.target?.closest?.('button, a[href]'));
    if ((key === ' ' || key === 'Enter')
      && (isInteractiveButtonOrLink
        || recentPanel?.contains(event.target)
        || compareControl?.contains(event.target)
        || event.target === timeLabel)) {
      return;
    }

    // Prevention of browser scrolling for specific keys. Whatever they are
    // bound to, these scroll the page, so the list stays by key rather than by
    // action; a key that did reach an action is swallowed below.
    if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
      event.preventDefault();
    }

    // Digits jump to a percentage of the map: 0 is the start, 9 is 90%. A
    // range rather than an action, which is why the digits cannot be rebound.
    if (!shiftKey && /^[0-9]$/.test(key) && state.durationMs > 0) {
      seekTo((Number(key) / 10) * state.durationMs);
      return;
    }

    if (!action) {
      return;
    }
    event.preventDefault();

    switch (action) {
      case 'playPause': {
        const wasPlaying = state.isPlaying;
        const isPlayingNow = await togglePlayback();
        if (isPlayingNow || wasPlaying) {
          showCanvasToggleFeedback(wasPlaying ? 'pause' : 'play');
        }
        break;
      }
      // Shift is a modifier on the seek, not a binding of its own: whichever
      // key seeks, holding shift makes it the long one.
      case 'seekBackward':
        seekRelative(shiftKey ? -15000 : -5000);
        break;
      case 'seekForward':
        seekRelative(shiftKey ? 15000 : 5000);
        break;
      case 'volumeUp':
        applyAudioVolume(state.volume + 0.05);
        scheduleVolumePersist();
        break;
      case 'volumeDown':
        applyAudioVolume(state.volume - 0.05);
        scheduleVolumePersist();
        break;
      case 'cycleSpeed':
        cyclePlaybackSpeed();
        break;
      case 'cycleManiaKeys':
        cycleManiaKeyCount?.();
        break;
      case 'mute':
        toggleMute();
        scheduleVolumePersist();
        break;
      case 'restart':
        restartPreview();
        break;
      // The places the map names for itself: a bookmark, a kiai start, a
      // break. Faster than walking a marathon in five-second steps.
      case 'nextSection':
        seekToSectionMark?.(1);
        break;
      case 'previousSection':
        seekToSectionMark?.(-1);
        break;
      case 'copyTimestamp':
        void copyEditorTimestamp?.();
        break;
      case 'jumpStart':
        seekTo(0);
        break;
      case 'jumpEnd':
        // A hair inside the end, so the clock does not immediately trip the
        // end-of-map stop and reset to zero.
        if (state.durationMs > 0) {
          seekTo(Math.max(0, state.durationMs - 1));
        }
        break;
      case 'frameBack':
      case 'frameForward': {
        // Stepping a frame only means anything on a paused preview: at normal
        // speed playback covers the step before the next frame is drawn.
        if (state.isPlaying) {
          await togglePlayback();
          showCanvasToggleFeedback('pause');
        }
        seekRelative(action === 'frameBack' ? -FRAME_STEP_MS : FRAME_STEP_MS);
        break;
      }
      case 'zoomIn':
        timelineControls.zoomIn();
        break;
      case 'zoomOut':
        timelineControls.zoomOut();
        break;
      case 'speedDown':
        applyPlaybackSpeed(state.playbackSpeed - SPEED_NUDGE_STEP);
        break;
      case 'speedUp':
        applyPlaybackSpeed(state.playbackSpeed + SPEED_NUDGE_STEP);
        break;
      case 'showShortcuts':
        setShortcutsMenuOpen(!state.shortcutsMenuOpen);
        break;
    }
  });

  shortcutsButton?.addEventListener('click', () => {
    setShortcutsMenuOpen(!state.shortcutsMenuOpen);
  });

  shortcutsBackdrop?.addEventListener('click', () => {
    setShortcutsMenuOpen(false);
  });

  shortcutsCloseButton?.addEventListener('click', () => {
    setShortcutsMenuOpen(false);
  });

  recentClearBtn?.addEventListener('click', () => {
    void clearHistory();
  });

  embedButton?.addEventListener('click', () => {
    void openEmbeddedPlayer?.();
  });

  detachButton?.addEventListener('click', () => {
    void openDetachedWindow?.();
  });

  followButton?.addEventListener('click', () => {
    toggleFollowEnabled?.();
  });

  miniPlayButton?.addEventListener('click', async () => {
    await togglePlayback();
  });

  infoCachedButton?.addEventListener('click', () => {
    void toggleCachedMapsetsPanel?.();
  });

  const speedPopover = bindPopover({ control: speedControl, button: speedButton, openClass: 'is-speed-open' });
  const volumePopover = bindPopover({ control: volumeControl, button: volumeButton, openClass: 'is-volume-open' });
  // Only shown for a convert: a native mania map's key count cannot change.
  const keysPopover = bindPopover({ control: keysControl, button: keysButton, openClass: 'is-keys-open' });

  // Stays open after a pick, so 4K and 7K can be flipped between while the
  // map plays.
  keysControl?.addEventListener('click', (event) => {
    const option = event.target.closest?.('.map-preview-keys-option');
    if (!option || !keysControl.contains(option)) {
      return;
    }
    const { keys } = option.dataset;
    selectManiaKeyCount?.(keys === 'auto' ? 'auto' : Number(keys));
  });

  keysMoreButton?.addEventListener('click', () => {
    toggleManiaKeysMore?.();
  });

  speedSlider?.addEventListener('input', () => {
    applyPlaybackSpeed(Number(speedSlider.value) / 100);
  });

  speedResetButton?.addEventListener('click', () => {
    // Focus moves first: resetting disables this button, and focus dropping off
    // a disabled element would read as focus leaving the control.
    speedButton?.focus();
    applyPlaybackSpeed(1);
  });

  document.addEventListener('pointerdown', (event) => {
    if (!recentPanel || recentPanel.hidden || recentPanel.contains(event.target)) {
      return;
    }
    // The button that opened it owns its own toggle: closing here first would
    // let the click that follows immediately reopen the panel.
    if (infoCachedButton?.contains(event.target)) {
      return;
    }
    closeCachedMapsetsPanel?.();
  });

  timeLabel?.addEventListener('click', () => {
    if (state.embeddedCollapsed) {
      return;
    }
    void copyEditorTimestamp?.();
  });

  playfieldCanvas.addEventListener('click', async (event) => {
    // An object under the pointer is something to pick out; the rest of the
    // playfield is still the big play/pause button it has always been.
    if (selectObjectAtPoint?.(event)) {
      return;
    }
    const wasPlaying = state.isPlaying;
    const isPlayingNow = await togglePlayback();
    if (isPlayingNow || wasPlaying) {
      showCanvasToggleFeedback(wasPlaying ? 'pause' : 'play');
    }
  });

  audioStatusBadge?.addEventListener('click', () => {
    toggleDebugPanelOpen();
  });

  infoButtons.forEach((infoButton) => {
    infoButton.addEventListener('click', () => {
      setInfoMenuOpen(!state.infoMenuOpen);
    });
  });

  infoBackdrop?.addEventListener('click', () => {
    setInfoMenuOpen(false);
  });

  infoCloseButton?.addEventListener('click', () => {
    setInfoMenuOpen(false);
  });

  infoOptionsButton?.addEventListener('click', async () => {
    await openExtensionOptions();
  });

  infoIssueButton?.addEventListener('click', async () => {
    await openSupportLink(supportLinks.issue);
  });

  infoOsuButton?.addEventListener('click', async () => {
    await openSupportLink(supportLinks.osu);
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

  debugCloseButton?.addEventListener('click', () => {
    setDebugPanelOpen(false);
  });

  volumeSlider?.addEventListener('input', () => {
    const next = Number(volumeSlider.value) / 100;
    applyAudioVolume(next);
    scheduleVolumePersist();
  });

  volumeSlider?.addEventListener('change', async () => {
    const next = Number(volumeSlider.value) / 100;
    applyAudioVolume(next);
    state.volumePersistTimer = registry.clearTimeout(state.volumePersistTimer);
    await writeAudioVolumeSetting?.(state.volume);
  });

  // Single owner for Escape, so dismissing the timeline zoom or a dialog never
  // falls through to closing the whole popup.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    if (state.shortcutsMenuOpen) {
      event.preventDefault();
      setShortcutsMenuOpen(false);
      return;
    }
    if (state.infoMenuOpen) {
      event.preventDefault();
      setInfoMenuOpen(false);
      return;
    }
    if (dismissComparePicker() || speedPopover.dismiss() || volumePopover.dismiss() || keysPopover.dismiss()) {
      event.preventDefault();
      return;
    }
    if (recentPanel && !recentPanel.hidden && closeCachedMapsetsPanel?.()) {
      event.preventDefault();
      return;
    }
    if (state.debugPanelOpen && typeof setDebugPanelOpen === 'function') {
      event.preventDefault();
      setDebugPanelOpen(false);
      return;
    }
    // Zooming back out is the step before closing, not instead of it.
    if (timelineControls.isZoomed()) {
      event.preventDefault();
      timelineControls.resetZoom();
      return;
    }
    closePreview();
  });
};

export { bindPopupUiEvents, bindPopover };
