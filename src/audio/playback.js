import { seekAudioElementToMapTime } from './seek.js';

// Owns the playback mode, the animation frame loop and every seek. Nothing
// outside this module should assign `state.rafId` or `state.playbackMode`: the
// audio clock and the visual clock only stay consistent because one place moves
// them together.
const createPlaybackController = ({
  state,
  config,
  helpers,
}) => {
  const {
    ensureTimelineDurationAnimation,
    getCurrentManualMapTime,
    syncVisualClockToMapTime,
    resyncVisualPlaybackToAudio,
    renderFrame,
  } = helpers;

  const seekAudioToMapTime = (mapTimeMs, options) => (
    seekAudioElementToMapTime(state.audio, mapTimeMs, state.audioAnchorMapMs, options)
  );

  const clearCurrentRaf = () => {
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
  };

  const ensurePlaybackLoop = () => {
    if (state.rafId === null) {
      state.rafId = requestAnimationFrame(playbackTick);
    }
  };

  // Hands the clock back to the visual timeline, for whenever the audio stops
  // being authoritative: it ended, it was paused, or the playhead moved outside
  // the range it covers.
  const switchToManualTimeline = (nowPerfMs = performance.now()) => {
    state.playbackMode = 'manual';
    state.playStartMapMs = state.currentTimeMs;
    state.playStartPerfMs = nowPerfMs;
    state.lastAudioVisualSyncPerfMs = 0;
  };

  const stopPlayback = () => {
    state.isPlaying = false;
    state.playbackMode = 'none';
    state.lastAudioVisualSyncPerfMs = 0;
    clearCurrentRaf();
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
        switchToManualTimeline(now);
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
    state.isPlaying = true;
    switchToManualTimeline();
    ensurePlaybackLoop();
    return true;
  };

  const startAudioPlayback = async () => {
    clearCurrentRaf();
    if (!state.audioSyncEnabled || !state.audio?.src) {
      return false;
    }

    try {
      if (!seekAudioToMapTime(state.currentTimeMs)) {
        return false;
      }
      syncVisualClockToMapTime(state.currentTimeMs);
      state.audio.playbackRate = state.playbackSpeed;
      await state.audio.play();
      state.playbackMode = 'audio';
      state.isPlaying = true;
      resyncVisualPlaybackToAudio({ force: true });
      ensurePlaybackLoop();
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

    return (await startAudioPlayback()) || startManualPlayback();
  };

  /**
   * The one seek path. Moves the visual clock, and moves the audio with it when
   * the audio actually covers that timestamp. When it does not — a b.ppy.sh
   * preview clip only spans ~10s around PreviewTime — the audio is paused and
   * the visual clock takes over, otherwise the 'seeked'/'timeupdate' listeners
   * drag the playhead straight back to the clip.
   */
  const seekTo = (mapTimeMs) => {
    if (!state.mapData || state.durationMs <= 0) {
      return;
    }

    syncVisualClockToMapTime(mapTimeMs);

    if (state.audioSyncEnabled && state.audio?.src) {
      try {
        if (seekAudioToMapTime(state.currentTimeMs)) {
          if (state.playbackMode === 'audio') {
            resyncVisualPlaybackToAudio({ force: true });
          }
        } else {
          if (!state.audio.paused) {
            state.audio.pause();
          }
          if (state.playbackMode === 'audio') {
            if (state.isPlaying) {
              switchToManualTimeline();
            } else {
              state.playbackMode = 'none';
            }
          }
        }
      } catch {
        // Ignore seek errors; visual playback continues.
      }
    }

    renderFrame();
  };

  const seekRelative = (deltaMs) => seekTo(state.currentTimeMs + deltaMs);

  const restartPreview = () => {
    seekTo(0);
    if (state.mapData && state.durationMs > 0 && !state.isPlaying) {
      void togglePlayback();
    }
  };

  return {
    clearCurrentRaf,
    ensurePlaybackLoop,
    switchToManualTimeline,
    stopPlayback,
    togglePlayback,
    seekTo,
    seekRelative,
    restartPreview,
  };
};

export { createPlaybackController };
