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
  } = actions;

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

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.infoMenuOpen) {
      setInfoMenuOpen(false);
    }
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
      window.close();
    }
  });
};

export { bindPopupUiEvents };
