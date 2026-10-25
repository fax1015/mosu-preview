import { bindTimelineInput } from './timelineInput.js';

// Speed and volume each show their value on a button that opens a slider above
// it. Both open and close on click alone: hover-to-open has no equivalent on
// touch, where there is no pointer to move away. Read back from the class
// rather than a local flag, so a popover cannot get out of step when loading a
// map force-closes it.
const bindPopover = ({ control, button, openClass }) => {
  const isOpen = () => Boolean(control?.classList.contains(openClass));

  const setOpen = (open) => {
    const nextOpen = open && Boolean(control) && !button?.disabled;
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
  control?.addEventListener('focusout', (event) => {
    if (control.contains(event.relatedTarget)) {
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
    playfieldCanvas,
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
    popupToast,
    detachButton,
    followButton,
    timelineTooltip,
  } = elements;

  const {
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
    clearHistory,
    openDetachedWindow,
    toggleFollowEnabled,
    toggleCachedMapsetsPanel,
    closeCachedMapsetsPanel,
  } = actions;

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

  document.addEventListener('keydown', async (event) => {
    if (trapDialogTab(event, state.shortcutsMenuOpen ? shortcutsModal : infoModal)) {
      return;
    }

    // Ignore while typing
    const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)
      || event.target.isContentEditable;
    if (isTyping) return;

    const { key, shiftKey } = event;

    // Ctrl+R, Cmd+W and the like belong to the browser; in the detached window
    // Ctrl+R used to restart the preview as well as reload it. AltGr arrives as
    // Ctrl+Alt on Windows, and is how several layouts type `[` and `]`.
    const hasCommandModifier = (event.ctrlKey || event.metaKey || event.altKey)
      && !event.getModifierState?.('AltGraph');
    if (hasCommandModifier) {
      return;
    }

    const isShortcutsKey = key === '?' || (key === '/' && shiftKey);

    // A dialog is modal: the preview behind it must not react, and Space on one
    // of its buttons has to reach that button instead of toggling playback.
    if (state.infoMenuOpen || state.shortcutsMenuOpen) {
      if (isShortcutsKey) {
        setShortcutsMenuOpen(!state.shortcutsMenuOpen);
      }
      return;
    }

    // The cached-mapsets rows are buttons too.
    if ((key === ' ' || key === 'Enter') && recentPanel?.contains(event.target)) {
      return;
    }

    // Prevention of browser scrolling for specific keys
    if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
      event.preventDefault();
    }

    // Digits jump to a percentage of the map: 0 is the start, 9 is 90%.
    if (!shiftKey && /^[0-9]$/.test(key) && state.durationMs > 0) {
      seekTo((Number(key) / 10) * state.durationMs);
      return;
    }

    switch (key.toLowerCase()) {
      case ' ': {
        const wasPlaying = state.isPlaying;
        const isPlayingNow = await togglePlayback();
        if (isPlayingNow || wasPlaying) {
          showCanvasToggleFeedback(wasPlaying ? 'pause' : 'play');
        }
        break;
      }
      case 'arrowleft':
        seekRelative(shiftKey ? -15000 : -5000);
        break;
      case 'arrowright':
        seekRelative(shiftKey ? 15000 : 5000);
        break;
      case 'arrowup':
        applyAudioVolume(state.volume + 0.05);
        break;
      case 'arrowdown':
        applyAudioVolume(state.volume - 0.05);
        break;
      case 's':
        cyclePlaybackSpeed();
        break;
      case 'm':
        toggleMute();
        break;
      case 'r':
        restartPreview();
        break;
      case 'home':
        seekTo(0);
        break;
      case 'end':
        // A hair inside the end, so the clock does not immediately trip the
        // end-of-map stop and reset to zero.
        if (state.durationMs > 0) {
          seekTo(Math.max(0, state.durationMs - 1));
        }
        break;
      case ',':
      case '.': {
        // Stepping a frame only means anything on a paused preview: at normal
        // speed playback covers the step before the next frame is drawn.
        if (state.isPlaying) {
          await togglePlayback();
          showCanvasToggleFeedback('pause');
        }
        seekRelative(key === ',' ? -FRAME_STEP_MS : FRAME_STEP_MS);
        break;
      }
      case '=':
      case '+':
        timelineControls.zoomIn();
        break;
      case '-':
      case '_':
        timelineControls.zoomOut();
        break;
      case '[':
        applyPlaybackSpeed(state.playbackSpeed - SPEED_NUDGE_STEP);
        break;
      case ']':
        applyPlaybackSpeed(state.playbackSpeed + SPEED_NUDGE_STEP);
        break;
      case '?':
      case '/':
        if (isShortcutsKey) {
          setShortcutsMenuOpen(!state.shortcutsMenuOpen);
        }
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

  detachButton?.addEventListener('click', () => {
    void openDetachedWindow?.();
  });

  followButton?.addEventListener('click', () => {
    toggleFollowEnabled?.();
  });

  infoCachedButton?.addEventListener('click', () => {
    void toggleCachedMapsetsPanel?.();
  });

  const speedPopover = bindPopover({ control: speedControl, button: speedButton, openClass: 'is-speed-open' });
  const volumePopover = bindPopover({ control: volumeControl, button: volumeButton, openClass: 'is-volume-open' });

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
    const tsMs = state.currentTimeMs;
    if (!Number.isFinite(tsMs) || tsMs < 0) return;
    const totalSec = Math.floor(tsMs / 1000);
    const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const secs = String(totalSec % 60).padStart(2, '0');
    const ms = String(Math.floor(tsMs % 1000)).padStart(3, '0');
    const timestamp = `${mins}:${secs}:${ms}`;

    navigator.clipboard.writeText(timestamp).then(() => {
      showPopupToast(`Copied ${timestamp}`);
      if (popupToast) {
        popupToast.classList.add('is-copied');
        registry.addTimeout(setTimeout(() => popupToast.classList.remove('is-copied'), 3700));
      }
    }).catch((err) => {
      addDebugLog(`ui: failed to copy timestamp -> ${err?.message || 'unknown error'}`);
    });
  });

  playfieldCanvas.addEventListener('click', async () => {
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

    state.volumePersistTimer = registry.clearTimeout(state.volumePersistTimer);
    state.volumePersistTimer = registry.addTimeout(setTimeout(async () => {
      state.volumePersistTimer = null;
      await writeAudioVolumeSetting(state.volume);
    }, 220));
  });

  volumeSlider?.addEventListener('change', async () => {
    const next = Number(volumeSlider.value) / 100;
    applyAudioVolume(next);
    state.volumePersistTimer = registry.clearTimeout(state.volumePersistTimer);
    await writeAudioVolumeSetting(state.volume);
  });

  // Single owner for Escape, so dismissing the timeline zoom or a dialog never
  // falls through to closing the whole popup.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    if (state.shortcutsMenuOpen) {
      setShortcutsMenuOpen(false);
      return;
    }
    if (state.infoMenuOpen) {
      setInfoMenuOpen(false);
      return;
    }
    if (speedPopover.dismiss() || volumePopover.dismiss()) {
      return;
    }
    // Zooming back out is the step before closing, not instead of it.
    if (timelineControls.isZoomed()) {
      timelineControls.resetZoom();
      return;
    }
    window.close();
  });
};

export { bindPopupUiEvents };
