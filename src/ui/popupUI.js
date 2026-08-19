import { formatTime } from '../renderer.js';

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

  let isCtrlTimelineZoomActive = false;
  let lastTimelinePointerEvent = null;
  let lastPointerPosition = null;
  let timelineZoomRafId = null;

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

  const isPointerNearTimeline = () => {
    if (!lastPointerPosition) {
      return false;
    }

    const rect = timelineCanvas.getBoundingClientRect();
    const verticalPadding = 24;
    const horizontalPadding = 12;
    return lastPointerPosition.clientX >= rect.left - horizontalPadding
      && lastPointerPosition.clientX <= rect.right + horizontalPadding
      && lastPointerPosition.clientY >= rect.top - verticalPadding
      && lastPointerPosition.clientY <= rect.bottom + verticalPadding;
  };

  const getTimelinePointerEvent = () => {
    if (!lastPointerPosition) {
      return null;
    }

    return {
      clientX: lastPointerPosition.clientX,
      clientY: lastPointerPosition.clientY,
    };
  };

  const scheduleTimelineZoomRender = () => {
    if (timelineZoomRafId !== null) {
      return;
    }

    const tick = () => {
      timelineZoomRafId = null;
      if (isCtrlTimelineZoomActive) {
        updateTimelineZoomTarget({ animate: false, schedule: false });
      }
      renderer.renderTimeline();
      if (isCtrlTimelineZoomActive || renderer.isTimelineAnimating()) {
        timelineZoomRafId = requestAnimationFrame(tick);
      }
    };

    timelineZoomRafId = requestAnimationFrame(tick);
  };

  const getTimelinePointerRatio = (event) => {
    const rect = timelineCanvas.getBoundingClientRect();
    if (rect.width <= 0) {
      return 0.5;
    }
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  };

  const updateTimelineZoomTarget = ({ animate = true, schedule = true } = {}) => {
    if (!state.mapData || state.durationMs <= 0) {
      return;
    }

    const pointerEvent = getTimelinePointerEvent();
    if (pointerEvent && isPointerNearTimeline()) {
      const anchorTimeMs = renderer.timeFromTimelineEvent(pointerEvent);
      renderer.setTimelineZoom(anchorTimeMs, 4000, {
        animate,
        anchorRatio: getTimelinePointerRatio(pointerEvent),
      });
    } else {
      renderer.setTimelineZoom(state.currentTimeMs, 4000, {
        animate,
        anchorRatio: 0.5,
      });
    }
    if (schedule) {
      scheduleTimelineZoomRender();
    }
  };

  const setCtrlTimelineZoomActive = (active) => {
    if (isCtrlTimelineZoomActive === active) {
      return;
    }

    isCtrlTimelineZoomActive = active;
    if (active) {
      updateTimelineZoomTarget({ animate: true });
      return;
    }

    renderer.resetTimelineZoom({ animate: true });
    scheduleTimelineZoomRender();
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

    if (key === 'Control') {
      setCtrlTimelineZoomActive(true);
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
      case '[':
        applyPlaybackSpeed(state.playbackSpeed - SPEED_NUDGE_STEP);
        break;
      case ']':
        applyPlaybackSpeed(state.playbackSpeed + SPEED_NUDGE_STEP);
        break;
      case '?':
      case '/':
        if (key === '?' || (key === '/' && shiftKey)) {
          setShortcutsMenuOpen(!state.shortcutsMenuOpen);
        }
        break;
    }
  });

  document.addEventListener('keyup', (event) => {
    if (event.key === 'Control') {
      setCtrlTimelineZoomActive(false);
    }
  });

  window.addEventListener('blur', () => {
    setCtrlTimelineZoomActive(false);
  });

  document.addEventListener('mousemove', (event) => {
    lastPointerPosition = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
  });

  const hideTimelineTooltip = () => {
    if (timelineTooltip && !timelineTooltip.hidden) {
      timelineTooltip.hidden = true;
    }
  };

  const updateTimelineTooltip = (event) => {
    if (!timelineTooltip || !timelineCanvas) {
      return;
    }
    if (!state.mapData || state.durationMs <= 0) {
      hideTimelineTooltip();
      return;
    }

    const rect = timelineCanvas.getBoundingClientRect();
    if (rect.width <= 0) {
      hideTimelineTooltip();
      return;
    }

    timelineTooltip.textContent = formatTime(renderer.timeFromTimelineEvent(event));
    timelineTooltip.hidden = false;

    // Positioned against the controls row, then held inside it so the label
    // stays readable at both ends instead of hanging off the edge.
    const parentRect = timelineTooltip.offsetParent?.getBoundingClientRect() || rect;
    const half = timelineTooltip.offsetWidth / 2;
    const rawLeft = event.clientX - parentRect.left;
    const minLeft = (rect.left - parentRect.left) + half;
    const maxLeft = (rect.right - parentRect.left) - half;
    timelineTooltip.style.left = `${Math.min(Math.max(rawLeft, minLeft), maxLeft)}px`;
  };

  timelineCanvas?.addEventListener('mousemove', updateTimelineTooltip);
  timelineCanvas?.addEventListener('mouseleave', hideTimelineTooltip);
  // A tooltip stranded over a map that is no longer loaded would be lying.
  window.addEventListener('blur', hideTimelineTooltip);

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

  // The speed popover opens and closes on click alone: hover-to-open has no
  // equivalent on touch, where there is no pointer to move away.
  // Read back from the class rather than a local flag, so the popover cannot
  // get out of step when loading a map force-closes it.
  const isSpeedPopoverOpen = () => Boolean(speedControl?.classList.contains('is-speed-open'));

  const setSpeedPopoverOpen = (open) => {
    const nextOpen = open && Boolean(speedControl) && !speedButton?.disabled;
    if (nextOpen === isSpeedPopoverOpen()) {
      return;
    }
    speedControl?.classList.toggle('is-speed-open', nextOpen);
    speedButton?.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  };

  speedButton?.addEventListener('click', () => {
    setSpeedPopoverOpen(!isSpeedPopoverOpen());
  });

  // Covers keyboard dismissal; pointers are handled by the outside pointerdown.
  speedControl?.addEventListener('focusout', (event) => {
    if (speedControl.contains(event.relatedTarget)) {
      return;
    }
    setSpeedPopoverOpen(false);
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
    if (!isSpeedPopoverOpen() || speedControl?.contains(event.target)) {
      return;
    }
    setSpeedPopoverOpen(false);
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

  timelineCanvas.addEventListener('mousedown', (event) => {
    lastTimelinePointerEvent = event;
    lastPointerPosition = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (event.ctrlKey && !isCtrlTimelineZoomActive) {
      setCtrlTimelineZoomActive(true);
    }
    seekTo(renderer.timeFromTimelineEvent(event));

    const onMove = (moveEvent) => {
      lastTimelinePointerEvent = moveEvent;
      lastPointerPosition = {
        clientX: moveEvent.clientX,
        clientY: moveEvent.clientY,
      };
      seekTo(renderer.timeFromTimelineEvent(moveEvent));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  timelineCanvas.addEventListener('mousemove', (event) => {
    const hadTimelinePointerEvent = Boolean(lastTimelinePointerEvent);
    lastTimelinePointerEvent = event;
    lastPointerPosition = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (isCtrlTimelineZoomActive) {
      updateTimelineZoomTarget({ animate: !hadTimelinePointerEvent });
      renderer.renderTimeline();
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
    if (isCtrlTimelineZoomActive) {
      setCtrlTimelineZoomActive(false);
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
    if (isSpeedPopoverOpen()) {
      if (speedControl?.contains(document.activeElement)) {
        speedButton?.focus();
      }
      setSpeedPopoverOpen(false);
      return;
    }
    window.close();
  });
};

export { bindPopupUiEvents };
