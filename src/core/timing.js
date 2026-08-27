// Whenever audio is playing the media element *is* the clock. `currentTime`
// already advances at the effective `playbackRate`, so reading it back is exact
// by construction and there is nothing to correct. The performance-clock
// extrapolation below only covers the stretches that have no audio behind them:
// a b.ppy.sh preview clip spans ~10s of the map, and the rest of the timeline
// still has to move.
const createTimingController = ({
  state,
  clamp,
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
    state.audioAnchorMapMs + ((state.audio?.currentTime || 0) * 1000)
  );

  // `audioAnchorMapMs` only describes the source it was set for. While a swap is
  // in flight the element still answers with the old source's position, and
  // mapping that through the new anchor lands the playhead somewhere arbitrary
  // -- the preview clip's 5s reading as 5s into the map, for instance.
  const isAudioClockAuthoritative = () => (
    state.playbackMode === 'audio'
    && state.audioSyncEnabled
    && Boolean(state.audio?.src)
    && state.audio.src === state.audioAnchorSrc
  );

  // The one question anything that needs "where are we?" should ask, so a rate
  // change and a render frame can never disagree about which clock is running.
  const getEffectiveMapTimeMs = (nowPerfMs = performance.now()) => {
    if (isAudioClockAuthoritative()) {
      return getAudioMappedTimeMs();
    }

    // A pending seek owns the playhead until the element settles on it, and a
    // paused preview simply stays where it was put.
    if (state.playbackMode === 'seeking' || !state.isPlaying) {
      return state.currentTimeMs;
    }

    return getCurrentManualMapTime(nowPerfMs);
  };

  /**
   * Changing the rate has to inherit the position from whichever clock is
   * actually running, sampled immediately before the element's `playbackRate`
   * changes under it. Rebasing from the visual clock instead carried the old
   * rate's accumulated drift across the change, which is exactly where the
   * desync used to be most audible.
   */
  const applyPlaybackRate = (nextSpeed, nowPerfMs = performance.now()) => {
    syncVisualClockToMapTime(getEffectiveMapTimeMs(nowPerfMs), nowPerfMs);
    state.playbackSpeed = nextSpeed;
    if (state.audio) {
      state.audio.playbackRate = nextSpeed;
    }
    return state.currentTimeMs;
  };

  return {
    getCurrentManualMapTime,
    syncVisualClockToMapTime,
    getAudioMappedTimeMs,
    isAudioClockAuthoritative,
    getEffectiveMapTimeMs,
    applyPlaybackRate,
  };
};

export { createTimingController };
