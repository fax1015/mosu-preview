const createTimingController = ({
  state,
  clamp,
  thresholdMs,
}) => {
  const getCurrentManualMapTime = (nowPerfMs) => (
    state.playStartMapMs + ((nowPerfMs - state.playStartPerfMs) * state.playbackSpeed)
  );

  const syncVisualClockToMapTime = (mapTimeMs, nowPerfMs = performance.now()) => {
    state.currentTimeMs = clamp(mapTimeMs, 0, state.durationMs || 1);
    if (state.isPlaying) {
      state.playStartMapMs = state.currentTimeMs;
      state.playStartPerfMs = nowPerfMs;
    }
  };

  const getAudioMappedTimeMs = () => (
    state.audioAnchorMapMs + ((state.audio.currentTime || 0) * 1000)
  );

  const resyncVisualPlaybackToAudio = ({ force = false, nowPerfMs = performance.now() } = {}) => {
    if (
      !state.audioSyncEnabled
      || !state.audio
      || !state.audio.src
      || state.audio.paused
    ) {
      return false;
    }

    const audioMappedTimeMs = clamp(getAudioMappedTimeMs(), 0, state.durationMs || 1);
    const driftMs = Math.abs(audioMappedTimeMs - state.currentTimeMs);
    state.lastAudioVisualSyncPerfMs = nowPerfMs;

    if (force || driftMs >= thresholdMs) {
      syncVisualClockToMapTime(audioMappedTimeMs, nowPerfMs);
      return true;
    }

    return false;
  };

  return {
    getCurrentManualMapTime,
    syncVisualClockToMapTime,
    getAudioMappedTimeMs,
    resyncVisualPlaybackToAudio,
  };
};

export { createTimingController };
