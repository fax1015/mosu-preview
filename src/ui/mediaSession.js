// The browser's media controls: hardware media keys, the OS media flyout and,
// on Android, the media notification. A detached window keeps playing while it
// is hidden or minimised, and without these the only way to pause it was to go
// and find it.
//
// The position comes from the map clock, never from the audio element: after a
// seek the element plays a slice of the track, and its own currentTime and
// duration describe that slice rather than the song.

// Matches the arrow keys.
const DEFAULT_SEEK_OFFSET_SEC = 5;
// A pushed position is extrapolated by the browser from the last one it got.
// Re-sending it only when it has drifted by more than this keeps a call per
// frame down to a few comparisons.
const POSITION_DRIFT_TOLERANCE_SEC = 0.5;

const ARTWORK_SIZES = Object.freeze([
  { file: 'list.jpg', sizes: '150x150' },
  { file: 'list@2x.jpg', sizes: '300x300' },
]);

const buildArtwork = (setId) => {
  const safeSetId = String(setId ?? '').trim();
  if (!/^\d+$/.test(safeSetId)) {
    return [];
  }
  return ARTWORK_SIZES.map(({ file, sizes }) => ({
    src: `https://assets.ppy.sh/beatmaps/${safeSetId}/covers/${file}`,
    sizes,
    type: 'image/jpeg',
  }));
};

/**
 * @param {object} options
 * @param {MediaSession|null} [options.mediaSession]
 * @param {typeof MediaMetadata|null} [options.MediaMetadataCtor]
 * @param {() => { isPlaying: boolean, positionMs: number, durationMs: number, rate: number }} options.getPlayback
 * @param {{ play: () => void, pause: () => void, seekTo: (ms: number) => void, seekBy: (ms: number) => void }} options.actions
 * @param {() => number} [options.now] seconds, for tests
 */
const createMediaSessionController = ({
  mediaSession = globalThis.navigator?.mediaSession ?? null,
  MediaMetadataCtor = globalThis.MediaMetadata ?? null,
  getPlayback,
  actions,
  now = () => (globalThis.performance?.now?.() ?? Date.now()) / 1000,
} = {}) => {
  if (!mediaSession || typeof getPlayback !== 'function' || !actions) {
    return { setTrack() {}, clearTrack() {}, sync() {} };
  }

  let hasTrack = false;
  // What the browser was last told, to extrapolate from.
  let pushed = null;

  const setHandler = (action, handler) => {
    try {
      mediaSession.setActionHandler(action, handler);
    } catch {
      // An action this browser does not know about.
    }
  };

  setHandler('play', () => actions.play());
  setHandler('pause', () => actions.pause());
  setHandler('seekbackward', (details) => {
    actions.seekBy(-1000 * (details?.seekOffset || DEFAULT_SEEK_OFFSET_SEC));
  });
  setHandler('seekforward', (details) => {
    actions.seekBy(1000 * (details?.seekOffset || DEFAULT_SEEK_OFFSET_SEC));
  });
  setHandler('seekto', (details) => {
    if (Number.isFinite(details?.seekTime)) {
      actions.seekTo(details.seekTime * 1000);
    }
  });

  const setPlaybackState = (value) => {
    if (mediaSession.playbackState !== value) {
      mediaSession.playbackState = value;
    }
  };

  const pushPosition = (snapshot) => {
    if (typeof mediaSession.setPositionState !== 'function') {
      return;
    }
    try {
      mediaSession.setPositionState({
        duration: snapshot.durationSec,
        playbackRate: snapshot.rate,
        position: snapshot.positionSec,
      });
      pushed = { ...snapshot, at: now() };
    } catch {
      // Rejected (a position past the duration, say); the next sync retries.
      pushed = null;
    }
  };

  const sync = () => {
    if (!hasTrack) {
      return;
    }
    const playback = getPlayback();
    const durationSec = Math.max(0, (Number(playback?.durationMs) || 0) / 1000);
    const rate = Number(playback?.rate) > 0 ? Number(playback.rate) : 1;
    const isPlaying = Boolean(playback?.isPlaying);
    const positionSec = Math.min(durationSec, Math.max(0, (Number(playback?.positionMs) || 0) / 1000));

    setPlaybackState(isPlaying ? 'playing' : 'paused');
    if (durationSec <= 0) {
      return;
    }

    const snapshot = { durationSec, rate, isPlaying, positionSec };
    if (
      !pushed
      || pushed.isPlaying !== isPlaying
      || pushed.rate !== rate
      || Math.abs(pushed.durationSec - durationSec) > 0.001
    ) {
      pushPosition(snapshot);
      return;
    }

    const expectedSec = pushed.isPlaying
      ? pushed.positionSec + ((now() - pushed.at) * pushed.rate)
      : pushed.positionSec;
    if (Math.abs(expectedSec - positionSec) > POSITION_DRIFT_TOLERANCE_SEC) {
      pushPosition(snapshot);
    }
  };

  const setTrack = ({ title = '', artist = '', version = '', setId = null } = {}) => {
    hasTrack = true;
    pushed = null;
    if (typeof MediaMetadataCtor === 'function') {
      try {
        mediaSession.metadata = new MediaMetadataCtor({
          title: String(title || ''),
          artist: String(artist || ''),
          album: String(version || ''),
          artwork: buildArtwork(setId),
        });
      } catch {
        mediaSession.metadata = null;
      }
    }
    sync();
  };

  const clearTrack = () => {
    hasTrack = false;
    pushed = null;
    mediaSession.metadata = null;
    setPlaybackState('none');
    try {
      mediaSession.setPositionState?.();
    } catch {
      // Older implementations want an argument; there is nothing to clear then.
    }
  };

  return { setTrack, clearTrack, sync };
};

export { createMediaSessionController, buildArtwork };
