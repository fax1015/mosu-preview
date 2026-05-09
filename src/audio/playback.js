const createPlaybackController = ({
  state,
  renderer,
  config,
  helpers,
}) => {
  const {
    ensureTimelineDurationAnimation,
    getCurrentManualMapTime,
    shouldContinueTimelineWhileFetchingFullAudio,
    syncVisualClockToMapTime,
    getAudioMappedTimeMs,
    resyncVisualPlaybackToAudio,
    clearCurrentRaf,
    seekAudioToMapTime,
    renderFrame,
    clamp,
  } = helpers;

  const stopPlayback = () => {
    state.isPlaying = false;
    state.playbackMode = 'none';
    state.lastAudioVisualSyncPerfMs = 0;
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.audio && !state.audio.paused) {
      state.audio.pause();
    }
    ensureTimelineDurationAnimation();
  };

  const playbackTick = (now) => {
    if (!state.isPlaying) {
      return;
    }

    state.currentTimeMs = getCurrentManualMapTime(now);

    if (state.playbackMode === 'audio' && state.audioSyncEnabled && state.audio) {
      if (state.audio.paused) {
        state.playbackMode = 'manual';
        if (
          state.isPlaying
          && shouldContinueTimelineWhileFetchingFullAudio()
          && state.audio.ended
        ) {
          syncVisualClockToMapTime(
            clamp(getAudioMappedTimeMs(), 0, state.durationMs || 1),
            now,
          );
        } else {
          syncVisualClockToMapTime(state.currentTimeMs, now);
        }
      } else if ((now - state.lastAudioVisualSyncPerfMs) >= config.audioVisualSyncIntervalMs) {
        resyncVisualPlaybackToAudio({ nowPerfMs: now });
      }
    }

    if (state.currentTimeMs >= state.durationMs) {
      state.currentTimeMs = state.durationMs;
      renderFrame();
      stopPlayback();
      return;
    }

    renderFrame();
    state.rafId = requestAnimationFrame(playbackTick);
  };

  const startManualPlayback = () => {
    clearCurrentRaf();
    if (state.currentTimeMs >= state.durationMs) {
      state.currentTimeMs = 0;
    }
    state.playbackMode = 'manual';
    state.isPlaying = true;
    state.playStartPerfMs = performance.now();
    state.playStartMapMs = state.currentTimeMs;
    state.rafId = requestAnimationFrame(playbackTick);
    return true;
  };

  const startAudioPlayback = async () => {
    clearCurrentRaf();
    if (!state.audioSyncEnabled || !state.audio?.src) {
      return false;
    }

    try {
      const hasSeekTarget = seekAudioToMapTime(state.currentTimeMs);
      if (!hasSeekTarget) {
        return false;
      }
      syncVisualClockToMapTime(state.currentTimeMs);
      state.audio.playbackRate = state.playbackSpeed;
      await state.audio.play();
      state.playbackMode = 'audio';
      state.isPlaying = true;
      resyncVisualPlaybackToAudio({ force: true });
      state.rafId = requestAnimationFrame(playbackTick);
      return true;
    } catch {
      return false;
    }
  };

  const togglePlayback = async () => {
    if (!state.mapData || state.durationMs <= 0) {
      return false;
    }

    if (state.isPlaying) {
      stopPlayback();
      return false;
    }

    if (state.currentTimeMs >= state.durationMs) {
      state.currentTimeMs = 0;
    }

    const startedAudio = await startAudioPlayback();
    if (startedAudio) {
      return true;
    }
    return startManualPlayback();
  };

  const seekFromTimelineEvent = (event) => {
    if (!state.mapData || state.durationMs <= 0) {
      return;
    }

    const newTime = renderer.timeFromTimelineEvent(event);
    syncVisualClockToMapTime(newTime);

    if (state.audioSyncEnabled && state.audio?.src) {
      try {
        const hasTarget = seekAudioToMapTime(state.currentTimeMs);
        if (!hasTarget && state.isPlaying && state.playbackMode === 'audio') {
          state.audio.pause();
          state.playbackMode = 'manual';
        } else if (state.playbackMode === 'audio') {
          resyncVisualPlaybackToAudio({ force: true });
        }
      } catch {
        // Ignore seek errors; visual playback continues.
      }
    }

    renderFrame();
  };

  return {
    stopPlayback,
    playbackTick,
    startManualPlayback,
    startAudioPlayback,
    togglePlayback,
    seekFromTimelineEvent,
  };
};

export { createPlaybackController };
