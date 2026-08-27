import { seekAudioElementToMapTime } from './seek.js';

// Owns the playback mode, the animation frame loop and every seek. Nothing
// outside this module should assign `state.rafId` or `state.playbackMode`.
//
// While audio plays, the media element is the only clock: each frame reads
// `audioAnchorMapMs + audio.currentTime * 1000` and nothing writes a correction
// back into it. There is no periodic resync because there are not two clocks to
// reconcile — the performance clock only runs the stretches audio cannot cover.
//
// Every operation that moves or replaces the audio — start, seek, source
// hotswap — takes an operation token first. Those operations await media events,
// and the user can seek again while one is in flight, so a continuation that
// comes back holding a stale token has to drop what it was about to do instead
// of dragging the playhead back to where its own operation started.

// How far the element may land from where it was sent and still count as having
// honoured the seek. Browsers seek to a frame boundary, and an MP3 frame is
// ~26ms, so landing a little off is normal. Landing further off than this means
// the element refused: a seek outside a b.ppy.sh preview clip clamps to the end
// of the clip, and adopting that position would both jump the playhead and put
// the wrong ten seconds of the song under the map.
const AUDIO_SEEK_LANDING_TOLERANCE_MS = 150;

// The gap a stall can plausibly open before the element starts producing sound
// again. Past this the element is not merely late, it is somewhere else entirely
// -- a preview clip still sitting in its own ten seconds while the map has moved
// on -- and taking its position would teleport the playhead.
const AUDIO_STALL_RECOVERY_TOLERANCE_MS = 1000;

const createPlaybackController = ({
  state,
  helpers,
}) => {
  const {
    ensureTimelineDurationAnimation,
    getCurrentManualMapTime,
    getAudioMappedTimeMs,
    isAudioClockAuthoritative = () => state.playbackMode === 'audio',
    syncVisualClockToMapTime,
    renderFrame,
    // Resolves true once the element reports the seek landed, false if it never
    // did. The default suits callers with no media element worth waiting on.
    waitForAudioSeek = async () => true,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (frameId) => cancelAnimationFrame(frameId),
  } = helpers;

  const seekAudioToMapTime = (mapTimeMs, options) => (
    seekAudioElementToMapTime(state.audio, mapTimeMs, state.audioAnchorMapMs, options)
  );

  const beginAudioOperation = () => {
    state.audioOpToken += 1;
    return state.audioOpToken;
  };

  const isCurrentAudioOperation = (token) => token === state.audioOpToken;

  // Whether the element is really where it was sent. Checked before playing
  // rather than after, so a refused seek never puts a single frame of the wrong
  // audio out.
  const hasAudioLandedNear = (intendedMapMs) => (
    !Number.isFinite(intendedMapMs)
    || Math.abs(getAudioMappedTimeMs() - intendedMapMs) <= AUDIO_SEEK_LANDING_TOLERANCE_MS
  );

  const pauseAudioElement = () => {
    if (state.audio && !state.audio.paused) {
      state.audio.pause();
    }
  };

  const clearCurrentRaf = () => {
    if (state.rafId !== null) {
      cancelFrame(state.rafId);
      state.rafId = null;
    }
  };

  const ensurePlaybackLoop = () => {
    if (state.rafId === null) {
      state.rafId = requestFrame(playbackTick);
    }
  };

  // Hands the clock back to the visual timeline, for whenever the audio stops
  // being authoritative: it ended, it stalled, or the playhead moved outside the
  // range it covers.
  const switchToManualTimeline = (nowPerfMs = performance.now()) => {
    state.playbackMode = 'manual';
    state.playStartMapMs = state.currentTimeMs;
    state.playStartPerfMs = nowPerfMs;
  };

  // Freezes the preview on the timestamp that was asked for while the element
  // works its way there. The audio is paused for the duration: an element left
  // running keeps advancing from its old position, and the next frame would read
  // that as the truth.
  const holdForAudioSeek = (mapTimeMs) => {
    pauseAudioElement();
    syncVisualClockToMapTime(mapTimeMs);
    state.playbackMode = 'seeking';
    if (state.isPlaying) {
      ensurePlaybackLoop();
    }
  };

  // Makes the media element authoritative and takes its position as the truth,
  // rather than assuming it landed exactly where it was sent.
  const adoptAudioClock = () => {
    state.playbackMode = 'audio';
    syncVisualClockToMapTime(getAudioMappedTimeMs());
    if (state.isPlaying) {
      ensurePlaybackLoop();
    }
  };

  // The audio could not take the clock after all. A playing preview keeps moving
  // on the visual clock; a paused one just has no clock at all.
  const releaseAudioClock = (nowPerfMs = performance.now()) => {
    if (state.isPlaying) {
      switchToManualTimeline(nowPerfMs);
      ensurePlaybackLoop();
      return;
    }
    state.playbackMode = 'none';
  };

  /**
   * Puts the clock back on the element after the frame loop handed it to the
   * visual timeline.
   *
   * Without this the handover is one-way: a single stalled frame switches to the
   * visual clock, the element resumes, and nothing ever switches back -- so the
   * preview runs on the performance clock while the audio plays independently,
   * and whatever gap the stall opened stays open for the rest of the map. It is
   * the transition the old periodic resync used to hide.
   */
  const resumeAudioClockAfterStall = () => {
    if (!state.isPlaying || state.playbackMode !== 'manual') {
      return false;
    }
    if (!state.audioSyncEnabled || !state.audio?.src || state.audio.paused) {
      return false;
    }
    if (state.audio.src !== state.audioAnchorSrc) {
      return false;
    }
    if (Math.abs(getAudioMappedTimeMs() - state.currentTimeMs) > AUDIO_STALL_RECOVERY_TOLERANCE_MS) {
      // Deliberately on the visual clock because the audio does not cover this
      // part of the map, not because it stalled.
      return false;
    }
    adoptAudioClock();
    return true;
  };

  const stopPlayback = () => {
    beginAudioOperation();
    state.pendingSeekMapMs = null;
    state.isPlaying = false;
    state.playbackMode = 'none';
    clearCurrentRaf();
    pauseAudioElement();
    // Pin the clock where it stopped. Sound scheduled ahead of this point is
    // never going to happen now, and this is what tells the rest of the app so.
    syncVisualClockToMapTime(state.currentTimeMs);
    ensureTimelineDurationAnimation();
  };

  const playbackTick = (now) => {
    state.rafId = null;

    if (!state.isPlaying) {
      return;
    }

    if (state.playbackMode === 'seeking') {
      // Held on the pending target. The seek's continuation restarts the clock.
      renderFrame();
      state.rafId = requestFrame(playbackTick);
      return;
    }

    if (state.playbackMode === 'manual') {
      resumeAudioClockAfterStall();
    }

    if (state.playbackMode === 'audio') {
      if (!isAudioClockAuthoritative() || state.audio.paused) {
        // The element stopped being the clock under us — a stall, an error, or a
        // pause from outside. Keep the preview moving rather than freezing it.
        switchToManualTimeline(now);
        state.currentTimeMs = getCurrentManualMapTime(now);
      } else {
        state.currentTimeMs = getAudioMappedTimeMs();
      }
    } else {
      state.currentTimeMs = getCurrentManualMapTime(now);
    }

    if (state.currentTimeMs >= state.durationMs) {
      state.currentTimeMs = state.durationMs;
      renderFrame();
      stopPlayback();
      return;
    }

    renderFrame();
    state.rafId = requestFrame(playbackTick);
  };

  // Only the newest seek matters. Each one supersedes the last, and the settle
  // loop always resolves against whatever the newest target is, so dragging the
  // timeline issues one resume when the drag settles instead of one per pointer
  // sample.
  let isSettlingSeek = false;

  const completePendingSeek = async (token, settled) => {
    const targetMapMs = state.pendingSeekMapMs;
    state.pendingSeekMapMs = null;

    if (!settled) {
      // The element never reported the seek. The intent still stands — that is
      // where the user asked to be — so keep it and let the visual clock carry
      // the preview rather than freezing on a seek that may never land.
      syncVisualClockToMapTime(targetMapMs ?? state.currentTimeMs);
      releaseAudioClock();
      renderFrame();
      return;
    }

    if (!hasAudioLandedNear(targetMapMs)) {
      // The element clamped instead of seeking -- the audio does not actually
      // cover this timestamp. Keep the timestamp the user asked for rather than
      // dragging them to wherever the audio stopped.
      syncVisualClockToMapTime(targetMapMs);
      releaseAudioClock();
      renderFrame();
      return;
    }

    if (!state.isPlaying) {
      syncVisualClockToMapTime(getAudioMappedTimeMs());
      state.playbackMode = 'none';
      renderFrame();
      return;
    }

    try {
      state.audio.playbackRate = state.playbackSpeed;
      await state.audio.play();
    } catch {
      if (isCurrentAudioOperation(token)) {
        releaseAudioClock();
        renderFrame();
      }
      return;
    }

    if (!isCurrentAudioOperation(token)) {
      return;
    }

    adoptAudioClock();
    renderFrame();
  };

  const runSeekSettleLoop = async () => {
    isSettlingSeek = true;
    try {
      while (state.pendingSeekMapMs !== null) {
        const token = state.audioOpToken;
        const settled = await waitForAudioSeek(state.audio);
        if (!isCurrentAudioOperation(token)) {
          // Superseded while we waited: whatever the element just reported
          // belongs to a target the user has already moved past. Wait for the
          // seek that replaced it instead.
          continue;
        }
        await completePendingSeek(token, settled);
      }
    } finally {
      isSettlingSeek = false;
    }
  };

  /**
   * The one seek path. Moves the visual clock, then moves the audio to match
   * when the audio actually covers that timestamp. When it does not — a b.ppy.sh
   * preview clip only spans ~10s around PreviewTime — the audio is paused and
   * the visual clock takes over, otherwise the preview would snap straight back
   * to the clip.
   */
  const seekTo = (mapTimeMs) => {
    if (!state.mapData || state.durationMs <= 0) {
      return;
    }

    beginAudioOperation();
    syncVisualClockToMapTime(mapTimeMs);
    const targetMapMs = state.currentTimeMs;

    if (!state.audioSyncEnabled || !state.audio?.src) {
      state.pendingSeekMapMs = null;
      if (state.playbackMode === 'seeking') {
        // The audio went away under an earlier seek. Nothing is coming to
        // release the hold, so this seek has to.
        releaseAudioClock();
      }
      renderFrame();
      return;
    }

    holdForAudioSeek(targetMapMs);

    let hasAudioTarget = false;
    try {
      hasAudioTarget = seekAudioToMapTime(targetMapMs);
    } catch {
      hasAudioTarget = false;
    }

    if (!hasAudioTarget) {
      state.pendingSeekMapMs = null;
      releaseAudioClock();
      renderFrame();
      return;
    }

    state.pendingSeekMapMs = targetMapMs;
    renderFrame();

    if (!isSettlingSeek) {
      void runSeekSettleLoop();
    }
  };

  const seekRelative = (deltaMs) => seekTo(state.currentTimeMs + deltaMs);

  const startManualPlayback = () => {
    beginAudioOperation();
    state.pendingSeekMapMs = null;
    clearCurrentRaf();
    pauseAudioElement();
    if (state.currentTimeMs >= state.durationMs) {
      state.currentTimeMs = 0;
    }
    state.isPlaying = true;
    switchToManualTimeline();
    ensurePlaybackLoop();
    return true;
  };

  /**
   * @returns {Promise<'started'|'unavailable'|'superseded'>} 'unavailable' means
   *   the caller should fall back to the visual clock; 'superseded' means a
   *   newer operation owns the audio and the caller must not touch it.
   */
  const startAudioPlayback = async () => {
    if (!state.audioSyncEnabled || !state.audio?.src) {
      return 'unavailable';
    }

    const token = beginAudioOperation();
    state.pendingSeekMapMs = null;
    clearCurrentRaf();
    pauseAudioElement();

    const targetMapMs = state.currentTimeMs;
    let hasAudioTarget = false;
    try {
      hasAudioTarget = seekAudioToMapTime(targetMapMs);
    } catch {
      hasAudioTarget = false;
    }

    if (!hasAudioTarget) {
      return 'unavailable';
    }

    syncVisualClockToMapTime(targetMapMs);
    state.playbackMode = 'seeking';
    state.audio.playbackRate = state.playbackSpeed;

    const settled = await waitForAudioSeek(state.audio);
    if (!isCurrentAudioOperation(token)) {
      return 'superseded';
    }
    if (!settled || !hasAudioLandedNear(targetMapMs)) {
      // Either the element never reported the seek, or it landed somewhere else
      // entirely -- a preview clip clamping to its own end, most often, which is
      // how starting mid-map used to drop the preview into the clip.
      state.playbackMode = 'none';
      return 'unavailable';
    }

    try {
      await state.audio.play();
    } catch {
      if (!isCurrentAudioOperation(token)) {
        return 'superseded';
      }
      state.playbackMode = 'none';
      return 'unavailable';
    }

    if (!isCurrentAudioOperation(token)) {
      return 'superseded';
    }

    state.isPlaying = true;
    adoptAudioClock();
    return 'started';
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

    const result = await startAudioPlayback();
    if (result === 'started') {
      return true;
    }
    if (result === 'superseded') {
      return state.isPlaying;
    }
    return startManualPlayback();
  };

  const restartPreview = () => {
    seekTo(0);
    if (state.mapData && state.durationMs > 0 && !state.isPlaying) {
      void togglePlayback();
    }
  };

  return {
    beginAudioOperation,
    isCurrentAudioOperation,
    holdForAudioSeek,
    adoptAudioClock,
    releaseAudioClock,
    resumeAudioClockAfterStall,
    ensurePlaybackLoop,
    stopPlayback,
    togglePlayback,
    seekTo,
    seekRelative,
    restartPreview,
  };
};

export { createPlaybackController };
