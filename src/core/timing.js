import { createMediaClockSmoother } from '../audio/mediaClock.js';

// Whenever audio is playing the media element *is* the clock. `currentTime`
// already advances at the effective `playbackRate`, so reading it back is exact
// by construction and there is nothing to correct; it is only smoothed where
// the browser moves it in steps, which leaves its average where it was. The
// performance-clock extrapolation below only covers the stretches that have no
// audio behind them: a b.ppy.sh preview clip spans ~10s of the map, and the
// rest of the timeline still has to move.
const createTimingController = ({
  state,
  clamp,
  getOutputLatencySec = null,
  getAttachedLatencySec = null,
  isMediaElementAttached = null,
  now = () => performance.now(),
}) => {
  // Firefox's currentTime moves in ~40ms steps; this reads it without them
  // (see audio/mediaClock.js). Chromium's barely steps, so it barely changes.
  const mediaClock = createMediaClockSmoother({ now });

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

  const getAudioOutputLatencyMapMs = () => {
    try {
      if (typeof isMediaElementAttached !== 'function' || !isMediaElementAttached()) {
        return 0;
      }
      const liveLatency = Number(getOutputLatencySec?.());
      const snapshotLatency = Number(getAttachedLatencySec?.());
      const latencySec = Number.isFinite(liveLatency) && liveLatency > 0 && liveLatency < 1
        ? liveLatency
        : snapshotLatency;
      if (!Number.isFinite(latencySec) || latencySec <= 0 || latencySec >= 1) {
        return 0;
      }
      const speed = Number.isFinite(state.playbackSpeed) && state.playbackSpeed > 0
        ? state.playbackSpeed
        : 1;
      return latencySec * 1000 * speed;
    } catch {
      return 0;
    }
  };

  const getAudioMappedTimeMs = () => {
    const rawMs = state.audioAnchorMapMs + mediaClock.read(state.audio, state.playbackSpeed);
    // When music is routed through the shared WebAudio graph, its audible output lags
    // `currentTime` by `outputLatency`. Visuals and hitsounds must lag by the same amount
    // or the preview appears ahead of the music. Scale by playbackSpeed because the map
    // timeline moves speed× wall time. Live reading is used (not snapshot) so the correct
    // latency is picked up once the context is running; BACKWARD_SEEK_TOLERANCE is widened
    // to absorb the one-time backward jump without double-scheduling hitsounds.
    return rawMs - getAudioOutputLatencyMapMs();
  };

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
    getAudioOutputLatencyMapMs,
    getAudioMappedTimeMs,
    isAudioClockAuthoritative,
    getEffectiveMapTimeMs,
    applyPlaybackRate,
  };
};

export { createTimingController };
