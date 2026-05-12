const bindPopupUiEvents = ({
  elements,
  state,
  registry,
  actions,
  supportLinks,
}) => {
  const {
    togglePlaybackButton,
    playfieldCanvas,
    timelineCanvas,
    audioStatusBadge,
    infoButton,
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
    shortcutsBackdrop,
    shortcutsCloseButton,
    recentClearBtn,
  } = elements;

  const {
    cyclePlaybackSpeed,
    togglePlayback,
    showCanvasToggleFeedback,
    seekFromTimelineEvent,
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
    restartPreview,
    toggleMute,
    setShortcutsMenuOpen,
    clearHistory,
  } = actions;

  document.addEventListener('keydown', async (event) => {
    // Ignore while typing
    const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)
      || event.target.isContentEditable;
    if (isTyping) return;

    const { key, shiftKey } = event;

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
      case '?':
      case '/':
        if (key === '?' || (key === '/' && shiftKey)) {
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

  togglePlaybackButton.addEventListener('click', () => {
    cyclePlaybackSpeed();
  });

  timeLabel?.addEventListener('click', () => {
    const text = timeLabel.textContent || '';
    const currentPart = text.split('/')[0].trim();
    if (!currentPart) return;

    navigator.clipboard.writeText(currentPart).then(() => {
      showPopupToast(`Copied ${currentPart}`);
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
      if (state.infoMenuOpen) {
        setInfoMenuOpen(false);
        return;
      }
      if (state.shortcutsMenuOpen) {
        setShortcutsMenuOpen(false);
        return;
      }
      window.close();
    }
  });
};

export { bindPopupUiEvents };
