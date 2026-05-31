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
    playfieldCanvas,
    timelineCanvas,
    audioStatusBadge,
    infoButton,
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
  } = elements;

  const {
    cyclePlaybackSpeed,
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
    seekToTimeMs,
    restartPreview,
    toggleMute,
    setShortcutsMenuOpen,
    clearHistory,
  } = actions;

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
    if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
      event.preventDefault();
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
      case 'escape':
        setCtrlTimelineZoomActive(false);
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

  speedButton.addEventListener('click', () => {
    cyclePlaybackSpeed();
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
        setTimeout(() => popupToast.classList.remove('is-copied'), 3700);
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
    const startTimeMs = renderer.timeFromTimelineEvent(event);
    seekToTimeMs(startTimeMs);

    const onMove = (moveEvent) => {
      lastTimelinePointerEvent = moveEvent;
      lastPointerPosition = {
        clientX: moveEvent.clientX,
        clientY: moveEvent.clientY,
      };
      seekToTimeMs(renderer.timeFromTimelineEvent(moveEvent));
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

  infoButton?.addEventListener('click', () => {
    setInfoMenuOpen(!state.infoMenuOpen);
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

    if (state.volumePersistTimer) {
      clearTimeout(state.volumePersistTimer);
    }
    state.volumePersistTimer = registry.addTimeout(setTimeout(async () => {
      state.volumePersistTimer = null;
      await writeAudioVolumeSetting(state.volume);
    }, 220));
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
      if (state.shortcutsMenuOpen) {
        setShortcutsMenuOpen(false);
        return;
      }
      if (state.infoMenuOpen) {
        setInfoMenuOpen(false);
        return;
      }
      window.close();
    }
  });
};

export { bindPopupUiEvents };
