// Which audio the preview plays, and the upgrade from the short b.ppy.sh clip
// to the full track: cache lookup, download (in the service worker, or here
// when the worker cannot help), and the hotswap onto the playing element.
//
// Owns the media element's source. Everything that moves the playhead still
// goes through the playback controller's operation tokens, so a seek and a
// hotswap can never both claim it.

import { setFullAudioState, setPlaybackState, setProviderState } from '../core/state.js';
import { normalizeNumericId } from '../core/beatmapUrl.js';
import { sendRuntimeMessage } from '../webextension.js';
import {
  ensureCachedMapsetInfo,
  getAudioMimeType,
  normalizePath,
  readCachedFullAudioBlob,
  writeCachedFullAudioBlob,
} from './cache.js';
import { extractFullBeatmapAudio, shouldRetryExtractionInPopup } from './fullAudioExtractionCore.js';
import {
  AUDIO_SEEK_SETTLE_TOLERANCE_SEC,
  waitForAudioElementReady,
  waitForAudioElementSeek,
} from './mediaEvents.js';
import { createTrackFrameSeeker } from './frameSeeker.js';
import {
  FETCH_TIMEOUT_FAILOVER_MS,
  FETCH_TIMEOUT_MS,
  getProviderDisplayName,
  getProviderSequenceForDownload,
  probeArchiveSource,
} from './provider.js';
import {
  PREVIEW_CLIP_LEAD_IN_MS,
  getPreviewClipAnchorMapMs,
  isPreviewClipAnchorable,
  seekAudioElementToMapTime,
} from './seek.js';

const AUDIO_PREVIEW_BASE = 'https://b.ppy.sh/preview';
const PREVIEW_AUDIO_PROVIDER_LABEL = 'b.ppy.sh';
const CACHE_AUDIO_PROVIDER_LABEL = 'cache';

const createFullAudioController = ({
  state,
  registry,
  hitsoundPlayer,
  // False while the popup is holding the music's join to the WebAudio graph
  // back for a load (see requestMusicAttach in popup.js); it joins there.
  canAttachMusic = () => true,
  addDebugLog,
  badge: {
    setAudioBadge,
    setAudioBadgeWithProvider,
    hideAudioBadge,
    setFullAudioLoading,
    showTryingArchiveProviderBadge,
  },
  playback: {
    beginAudioOperation,
    isCurrentAudioOperation,
    holdForAudioSeek,
    adoptAudioClock,
    releaseAudioClock,
  },
  timing: {
    getAudioMappedTimeMs,
    getAudioOutputLatencyMapMs,
  },
  syncPlaybackDuration,
  renderFrame,
  getCurrentMapsetInfo,
  // Optional overrides for unit tests; production callers rely on the defaults.
  deps = {},
}) => {
  const {
    sendMessage = sendRuntimeMessage,
    readCachedBlob = readCachedFullAudioBlob,
    writeCachedBlob = writeCachedFullAudioBlob,
    ensureCachedInfo = ensureCachedMapsetInfo,
    extractAudio = extractFullBeatmapAudio,
    createFrameSeeker = createTrackFrameSeeker,
    waitForReady = waitForAudioElementReady,
    waitForSeek = waitForAudioElementSeek,
    createAudio = () => new Audio(),
  } = deps;

  // Set while the full track is an MP3 or Ogg Vorbis (see audio/frameSeeker.js).
  let frameSeeker = null;
  let activePopupExtractionController = null;

  const abortPopupExtraction = () => {
    if (activePopupExtractionController) {
      activePopupExtractionController.abort();
      registry.releaseAbortController(activePopupExtractionController);
      activePopupExtractionController = null;
    }
  };

  const releaseFrameSeeker = () => {
    frameSeeker?.dispose();
    frameSeeker = null;
    state.fullAudioSliceUrl = null;
    state.fullAudioDurationMs = 0;
  };

  const setFullAudioObjectUrl = (newUrl) => {
    if (state.fullAudioObjectUrl) {
      URL.revokeObjectURL(state.fullAudioObjectUrl);
    }
    state.fullAudioObjectUrl = newUrl || null;
    if (!newUrl) {
      releaseFrameSeeker();
    }
  };

  const isPlayingFullAudio = () => Boolean(state.audio?.src) && (
    state.audio.src === state.fullAudioObjectUrl
    || (Boolean(state.fullAudioSliceUrl) && state.audio.src === state.fullAudioSliceUrl)
  );

  /**
   * Moves the audio to `targetMs` on the track's own timeline. The playback
   * controller sends every seek through here, so a track that cannot be trusted
   * to seek by itself never is.
   */
  const seekAudioToTrackTime = (targetMs, options) => (
    frameSeeker && isPlayingFullAudio()
      ? frameSeeker.seek(targetMs, options)
      : seekAudioElementToMapTime(state.audio, targetMs, state.audioAnchorMapMs, options)
  );

  // Returns whether the element started loading a new source, which tells a
  // caller waiting for it that the next ready event belongs to that source.
  const setAudioElementSource = (sourceUrl, anchorMapMs) => {
    // Replacing the source invalidates anything still waiting on the old one: its
    // seeks can never land now, and its anchor no longer describes this element.
    beginAudioOperation();
    state.pendingSeekMapMs = null;
    if (state.playbackMode === 'seeking') {
      // Whatever the preview was frozen on is unreachable, and a new source can
      // take minutes to arrive. Let the visual clock carry it in the meantime.
      releaseAudioClock();
    }
    state.audioSyncEnabled = Boolean(sourceUrl);
    state.audioAnchorMapMs = Math.max(0, Number.isFinite(anchorMapMs) ? anchorMapMs : 0);
    state.audioAnchorSrc = sourceUrl || '';
    state.audio.playbackRate = state.playbackSpeed;
    if (!sourceUrl) {
      state.audio.removeAttribute('src');
      state.audio.load();
      syncPlaybackDuration();
      return false;
    }

    if (state.audio.src !== sourceUrl) {
      // Has to be in place before `src` for the load to run in CORS mode, which
      // the WebAudio routing needs to hear anything from a remote source.
      state.audio.crossOrigin = 'anonymous';
      state.audio.src = sourceUrl;
      state.audio.load();
      state.audio.playbackRate = state.playbackSpeed;
      // Routing survives a change of `src`. This only retries an attach that
      // failed earlier, and wakes the context for the source about to play.
      if (state.hitsounds && canAttachMusic()) {
        hitsoundPlayer.attachMediaElement(state.audio);
      }
      hitsoundPlayer.resumeContext();
      syncPlaybackDuration();
      return true;
    }
    return false;
  };

  const configureAudioPreview = (setId, previewTimeMs) => {
    state.fullAudioJobId += 1;
    abortPopupExtraction();
    setFullAudioState({
      previewSetId: null,
      activeSetId: null,
      fullAudioSetId: null,
      fullAudioStatus: 'idle',
      fullAudioCacheKey: '',
      fullAudioError: '',
    });
    setProviderState({ currentArchiveProviderLabel: '' });
    setFullAudioLoading(false);
    setAudioBadgeWithProvider('preview', 'Preview audio', PREVIEW_AUDIO_PROVIDER_LABEL);

    setFullAudioObjectUrl(null);

    const normalizedSetId = normalizeNumericId(setId);
    if (!normalizedSetId) {
      setAudioElementSource('', 0);
      hideAudioBadge();
      return;
    }

    setFullAudioState({
      previewSetId: normalizedSetId,
      activeSetId: normalizedSetId,
    });

    // PreviewTime is only known once the .osu file has been fetched and parsed, so
    // the first call of a load passes null. Reporting a verdict about the preview
    // point here would be guessing, and on a slow connection that guess stays on
    // screen for the whole download.
    if (previewTimeMs === null || previewTimeMs === undefined) {
      setAudioElementSource('', 0);
      setFullAudioLoading(true);
      setAudioBadge('loading', 'Loading audio', 'Reading the beatmap to line the audio up.');
      return;
    }

    // The b.ppy.sh clip is a ~10s excerpt with a 100ms lead-in before the
    // beatmap's PreviewTime. When PreviewTime is -1 (or absent) osu! generates the
    // clip from ~40% into the track instead, and that offset is not derivable from
    // the .osu file. Anchoring it at 0 anyway played the middle of the song over
    // the start of the map — a large, constant desync. Better to stay silent until
    // full audio arrives.
    //
    // Named for what happens next rather than for the missing metadata: the full
    // track is already on its way, and the b.ppy.sh clip being unusable is a
    // detail, not a failure the user has to act on.
    if (!isPreviewClipAnchorable(previewTimeMs)) {
      setAudioElementSource('', 0);
      setAudioBadge(
        'loading',
        'Waiting for full audio',
        'This beatmap has no preview point, so the short preview clip cannot be lined up with the map. Waiting for the full track.',
      );
      return;
    }

    // Worth logging in full, because this is the only anchor in the app that is
    // inferred rather than known: the clip belongs to the beatmapset while
    // PreviewTime is read from this difficulty, and b.ppy.sh's lead-in is a
    // constant we assume rather than one the file states.
    const previewAnchorMapMs = getPreviewClipAnchorMapMs(previewTimeMs);
    addDebugLog(
      `audio: preview clip anchored at ${Math.round(previewAnchorMapMs)}ms `
      + `(PreviewTime ${Math.round(previewTimeMs)}ms, assumed ${PREVIEW_CLIP_LEAD_IN_MS}ms lead-in)`,
    );
    const nextSrc = `${AUDIO_PREVIEW_BASE}/${normalizedSetId}.mp3`;
    setAudioElementSource(nextSrc, previewAnchorMapMs);
  };

  const hotswapToFullAudio = async (audioBlob, setId, sourceAudioFilename, jobId, providerLabel = '') => {
    if (!audioBlob || !setId || jobId !== state.fullAudioJobId) {
      return false;
    }

    addDebugLog(`audio: hotswap start (${sourceAudioFilename}, ${Math.round(audioBlob.size / 1024)} KB)`);
    // Only used for the preflight probe below, which just needs *some* valid
    // position. The real commit re-reads the playhead (see commitMapTimeMs).
    const preflightMapTimeMs = state.currentTimeMs;
    const fullAudioUrl = URL.createObjectURL(audioBlob);

    let testAudio = null;
    const releaseTestAudio = () => {
      if (!testAudio) {
        return;
      }
      try {
        testAudio.removeAttribute?.('src');
        testAudio.load?.();
      } catch {
        // Ignore cleanup failures on detached or mock audio elements.
      }
      testAudio = null;
    };

    try {
      testAudio = createAudio();
      testAudio.preload = 'auto';
      testAudio.src = fullAudioUrl;
      testAudio.load();

      const ready = await waitForReady(testAudio);
      if (!ready || jobId !== state.fullAudioJobId) {
        addDebugLog('audio: hotswap failed, media element not ready');
        URL.revokeObjectURL(fullAudioUrl);
        return false;
      }

      let testSeekOk = false;
      try {
        testSeekOk = seekAudioElementToMapTime(testAudio, preflightMapTimeMs, 0, { requireCoverage: false });
      } catch {
        testSeekOk = false;
      }

      if (!testSeekOk) {
        addDebugLog('audio: hotswap failed, preflight seek rejected');
        URL.revokeObjectURL(fullAudioUrl);
        return false;
      }

      const testSeekTargetSec = Math.max(0, Number.isFinite(testAudio.duration)
        ? Math.min(preflightMapTimeMs / 1000, testAudio.duration)
        : preflightMapTimeMs / 1000);
      const testSeekSettled = await waitForSeek(testAudio, {
        expectedTimeSec: testSeekTargetSec,
      });
      if (!testSeekSettled || jobId !== state.fullAudioJobId) {
        addDebugLog('audio: hotswap failed, preflight seek did not settle');
        URL.revokeObjectURL(fullAudioUrl);
        return false;
      }
    } catch (error) {
      addDebugLog(`audio: hotswap preflight failed (${error?.message || 'unknown error'})`);
      URL.revokeObjectURL(fullAudioUrl);
      return false;
    } finally {
      releaseTestAudio();
    }

    const nextFrameSeeker = await createFrameSeeker({
      state,
      blob: audioBlob,
      filename: sourceAudioFilename,
      onSourceChange: () => hitsoundPlayer.resumeContext(),
    }).catch((error) => {
      addDebugLog(`audio: could not index the track (${error?.message || error}); using browser seeking`);
      return null;
    });
    if (jobId !== state.fullAudioJobId) {
      nextFrameSeeker?.dispose();
      URL.revokeObjectURL(fullAudioUrl);
      return false;
    }
    if (nextFrameSeeker) {
      const { index } = nextFrameSeeker;
      const kind = index.format === 'mp3' ? `${index.isVbr ? 'variable' : 'constant'}-bitrate mp3` : 'ogg vorbis';
      addDebugLog(`audio: ${kind}, seeking from ${index.count} exact points`);
    }

    if (state.audio && !state.audio.paused) {
      state.audio.pause();
    }

    const previousFrameSeeker = frameSeeker;
    const previousAudioState = {
      src: state.audio?.src || '',
      anchorMapMs: state.audioAnchorMapMs,
      syncEnabled: state.audioSyncEnabled,
      fullAudioObjectUrl: state.fullAudioObjectUrl,
      fullAudioSliceUrl: state.fullAudioSliceUrl,
      fullAudioDurationMs: state.fullAudioDurationMs,
    };
    const cleanupSupersededSwap = () => {
      if (previousFrameSeeker && previousFrameSeeker !== frameSeeker) {
        previousFrameSeeker.dispose();
      }
      if (nextFrameSeeker && nextFrameSeeker !== frameSeeker) {
        nextFrameSeeker.dispose();
      }
      if (state.fullAudioObjectUrl !== fullAudioUrl && state.audio?.src !== fullAudioUrl) {
        URL.revokeObjectURL(fullAudioUrl);
      }
    };
    const rollbackCommittedSwap = () => {
      URL.revokeObjectURL(fullAudioUrl);
      if (frameSeeker === nextFrameSeeker) {
        frameSeeker?.dispose();
        frameSeeker = previousFrameSeeker;
      } else {
        nextFrameSeeker?.dispose();
      }
      state.fullAudioSliceUrl = previousAudioState.fullAudioSliceUrl || null;
      state.fullAudioDurationMs = previousAudioState.fullAudioDurationMs || 0;
      state.fullAudioObjectUrl = previousAudioState.fullAudioObjectUrl || null;
      setAudioElementSource(previousAudioState.src, previousAudioState.anchorMapMs);
      state.audioSyncEnabled = previousAudioState.syncEnabled;
    };

    // Keep previousFrameSeeker intact until the new swap commits so a rollback
    // can restore its slice URL without pointing the element at a revoked blob.
    frameSeeker = nextFrameSeeker;
    state.fullAudioSliceUrl = null;
    state.fullAudioDurationMs = nextFrameSeeker?.durationMs ?? 0;
    state.fullAudioObjectUrl = fullAudioUrl;
    const sourceChanged = setAudioElementSource(fullAudioUrl, 0);
    const realReady = await waitForReady(state.audio, { requireFreshEvent: sourceChanged });
    if (jobId !== state.fullAudioJobId) {
      addDebugLog('audio: hotswap superseded while waiting for media element');
      cleanupSupersededSwap();
      return false;
    }
    if (!realReady) {
      addDebugLog('audio: hotswap failed, media element not ready after commit');
      rollbackCommittedSwap();
      return false;
    }

    syncPlaybackDuration();

    // Re-read the playhead instead of reusing the value captured before the four
    // awaits above. The visual timeline keeps running while the element loads and
    // seeks, and the user can scrub during that window, so committing the stale
    // timestamp silently threw their seek away and dropped the map back to
    // wherever it was when the swap started.
    const commitMapTimeMs = state.currentTimeMs;
    if (Math.abs(commitMapTimeMs - preflightMapTimeMs) > 1) {
      addDebugLog(`audio: playhead moved during hotswap, committing at ${Math.round(commitMapTimeMs)}ms`);
    }

    // From here the swap goes through the same operation controller as a user
    // seek, so the two cannot both claim the playhead: whichever started last
    // wins, and the loser's continuation drops out below instead of resuming from
    // a timestamp the user has already left.
    const commitToken = beginAudioOperation();
    holdForAudioSeek(commitMapTimeMs);

    const prevSrc = state.audio?.src || '';
    let hasSyncedSeek = false;
    try {
      // Full audio may be marginally shorter than the mapped duration, so clamp
      // rather than refuse when the playhead sits in that tail.
      hasSyncedSeek = seekAudioToTrackTime(
        commitMapTimeMs + getAudioOutputLatencyMapMs(),
        { requireCoverage: false },
      );
    } catch {
      hasSyncedSeek = false;
    }

    if (!hasSyncedSeek) {
      addDebugLog('audio: hotswap failed, seek sync rejected after commit');
      if (jobId === state.fullAudioJobId) {
        rollbackCommittedSwap();
        releaseAudioClock();
      } else {
        cleanupSupersededSwap();
      }
      return false;
    }

    const usedFrameSeekerSlice = Boolean(
      state.audio?.src
      && state.audio.src !== prevSrc
      && state.fullAudioSliceUrl
      && state.audio.src === state.fullAudioSliceUrl,
    );
    let seekSettled = false;
    if (usedFrameSeekerSlice) {
      // FrameSeeker loads a fresh Blob slice (audio.load()), so no `seeked`
      // event fires and playback starts at currentTime === 0 anchored at
      // state.audioAnchorMapMs.
      seekSettled = await waitForReady(state.audio, {
        requireFreshEvent: true,
        timeoutMs: 2500,
      });
      if (seekSettled && jobId === state.fullAudioJobId && isCurrentAudioOperation(commitToken)) {
        const rawSliceTimeSec = Number(state.audio?.currentTime) || 0;
        seekSettled = state.audio.src === state.audioAnchorSrc
          && Math.abs(rawSliceTimeSec) <= AUDIO_SEEK_SETTLE_TOLERANCE_SEC;
      }
    } else {
      const rawSeekTargetSec = (
        commitMapTimeMs + getAudioOutputLatencyMapMs() - state.audioAnchorMapMs
      ) / 1000;
      const seekTargetSec = Math.max(0, Number.isFinite(state.audio.duration)
        ? Math.min(rawSeekTargetSec, state.audio.duration)
        : rawSeekTargetSec);
      seekSettled = await waitForSeek(state.audio, {
        expectedTimeSec: seekTargetSec,
      });
    }

    // Check job supersession unconditionally before touching state/badge, even
    // when a newer audio operation (from the new map) also bumped commitToken.
    if (jobId !== state.fullAudioJobId) {
      addDebugLog('audio: hotswap superseded before seek settled');
      cleanupSupersededSwap();
      return false;
    }

    const landedMapMs = getAudioMappedTimeMs();
    if (Math.abs(landedMapMs - commitMapTimeMs) > 1) {
      addDebugLog(
        `audio: full audio landed at ${Math.round(landedMapMs)}ms for a `
        + `${Math.round(commitMapTimeMs)}ms seek`,
      );
    }
    // A seek issued after ours has already moved this element and owns the
    // playhead. Its own continuation will position and resume it, so the swap
    // stops here rather than rolling back a source that is perfectly good.
    const isSupersededCommit = !isCurrentAudioOperation(commitToken);
    if (!isSupersededCommit && !seekSettled) {
      addDebugLog('audio: hotswap failed, seek did not settle after commit');
      rollbackCommittedSwap();
      releaseAudioClock();
      return false;
    }

    if (previousFrameSeeker && previousFrameSeeker !== frameSeeker) {
      previousFrameSeeker.dispose();
    }
    if (previousAudioState.fullAudioObjectUrl && previousAudioState.fullAudioObjectUrl !== fullAudioUrl) {
      URL.revokeObjectURL(previousAudioState.fullAudioObjectUrl);
    }

    setFullAudioState({
      fullAudioSetId: String(setId),
      fullAudioStatus: 'ready',
      fullAudioCacheKey: `${setId}:${normalizePath(sourceAudioFilename).toLowerCase()}`,
      fullAudioError: '',
    });
    setAudioBadgeWithProvider(
      'ready',
      'Full audio ready',
      providerLabel,
      `Using full audio: ${sourceAudioFilename}`,
    );

    if (isSupersededCommit) {
      addDebugLog('audio: hotswap committed, a newer seek owns the playhead');
      return true;
    }

    if (!state.isPlaying) {
      releaseAudioClock();
      addDebugLog('audio: hotswap success (paused state)');
      renderFrame();
      return true;
    }

    try {
      state.audio.playbackRate = state.playbackSpeed;
      await state.audio.play();
      if (jobId !== state.fullAudioJobId) {
        return false;
      }
      if (!isCurrentAudioOperation(commitToken)) {
        addDebugLog('audio: hotswap resume superseded by a newer seek');
        return true;
      }
      setPlaybackState({ isPlaying: true });
      adoptAudioClock();
      renderFrame();
      addDebugLog('audio: hotswap success, playback resumed');
      return true;
    } catch {
      if (jobId !== state.fullAudioJobId || !isCurrentAudioOperation(commitToken)) {
        return false;
      }
      setPlaybackState({ isPlaying: true });
      releaseAudioClock();
      addDebugLog('audio: hotswap fallback to manual timeline');
      return false;
    }
  };

  const upgradeToFullAudioIfPossible = async (setId, audioFilename) => {
    const normalizedSetId = normalizeNumericId(setId);
    if (!audioFilename || !normalizedSetId) {
      return;
    }

    const audioFileName = String(audioFilename).trim();
    if (!audioFileName) {
      return;
    }

    const cacheKey = `${normalizedSetId}:${normalizePath(audioFileName).toLowerCase()}`;
    if (
      state.fullAudioStatus === 'loading'
      && state.fullAudioCacheKey === cacheKey
    ) {
      return;
    }

    if (
      state.fullAudioStatus === 'ready'
      && state.fullAudioCacheKey === cacheKey
      && state.fullAudioSetId === normalizedSetId
    ) {
      return;
    }

    state.fullAudioJobId += 1;
    const jobId = state.fullAudioJobId;
    abortPopupExtraction();
    // Capture mapset metadata synchronously before any awaits so a rapid map
    // switch cannot poison this track's cache headers with the next map's info.
    const mapsetInfo = getCurrentMapsetInfo?.();
    setFullAudioState({
      fullAudioStatus: 'loading',
      fullAudioCacheKey: cacheKey,
      fullAudioError: '',
    });
    setFullAudioLoading(true);
    // The cache is read before any provider is considered, so the badge has to
    // say that. Picking the provider sequence up here used to announce
    // "Fetching beatmap archive from <provider>" before the lookup had even
    // started: a cached load flashed a download label, which reads as the
    // extension going to the network when it never did.
    setProviderState({ currentArchiveProviderLabel: CACHE_AUDIO_PROVIDER_LABEL });
    setAudioBadgeWithProvider(
      'loading',
      'Loading full audio',
      CACHE_AUDIO_PROVIDER_LABEL,
      'Checking the audio cache',
    );
    addDebugLog(`audio: full-load start set=${normalizedSetId} file=${audioFileName}`);

    try {
      const cacheLookupStartedMs = performance.now();
      const cachedBlob = await readCachedBlob(normalizedSetId, audioFileName);
      const cacheLookupMs = Math.round(performance.now() - cacheLookupStartedMs);

      // Staleness is checked on its own, before the cache result is interpreted.
      // Folding the two together meant a superseded job that had *found* its audio
      // fell through to the download path and reported a cache miss: the entry was
      // there, it just belonged to a job nobody was waiting for any more. Worse,
      // the service worker aborts whatever extraction is in flight when a new
      // request arrives, so a stale job reaching that path cancels the download
      // the live job is waiting on. The newer job does its own cache read, so
      // there is nothing to hand over here.
      if (jobId !== state.fullAudioJobId) {
        addDebugLog('audio: full-load superseded before it could start');
        return;
      }

      if (cachedBlob) {
        setProviderState({ currentArchiveProviderLabel: CACHE_AUDIO_PROVIDER_LABEL });
        setAudioBadgeWithProvider('loading', 'Loading full audio', CACHE_AUDIO_PROVIDER_LABEL, 'Using cached full audio');
        addDebugLog(`audio: cache hit (${Math.round(cachedBlob.size / 1024)} KB, looked up in ${cacheLookupMs} ms)`);
        // Entries cached before names were stored only ever get one chance to pick
        // theirs up, since the write path is skipped for a hit.
        void ensureCachedInfo(normalizedSetId, audioFileName, mapsetInfo, cachedBlob);
        const swapped = await hotswapToFullAudio(
          cachedBlob,
          normalizedSetId,
          audioFileName,
          jobId,
          CACHE_AUDIO_PROVIDER_LABEL,
        );
        if (!swapped && jobId === state.fullAudioJobId && state.fullAudioStatus !== 'ready') {
          throw new Error('Failed to load cached full audio.');
        }
        return;
      }
      addDebugLog(`audio: cache miss (${cacheLookupMs} ms)`);

      // Nothing before this point may touch the network, so this is the first
      // moment a "fetching from ..." label can be true.
      const firstTrySequence = getProviderSequenceForDownload(
        state.providerOverride,
        state.providerPriority,
        state.disabledProviders,
        state.autoFallback,
      );
      showTryingArchiveProviderBadge(
        firstTrySequence[0]?.label ?? getProviderDisplayName(state.providerOverride),
      );

      // Stays null when the worker never answers, which is the main case the
      // popup's own download exists for.
      let extractionResult = null;
      try {
        extractionResult = await sendMessage({
          type: 'extractFullAudio',
          jobId,
          setId: normalizedSetId,
          audioFilename: audioFileName,
          mapsetInfo,
          providerOverride: state.providerOverride,
          providerPriority: state.providerPriority,
          disabledProviders: state.disabledProviders,
          autoFallback: state.autoFallback,
        });
      } catch (swMessageError) {
        addDebugLog(`audio: service worker message failed (${swMessageError?.message || swMessageError})`);
      }

      if (jobId !== state.fullAudioJobId) {
        addDebugLog('audio: full-load superseded while waiting for worker');
        return;
      }

      if (shouldRetryExtractionInPopup(extractionResult)) {
        // Re-check the cache once before re-downloading: the service worker may
        // have been terminated right after writing the extracted audio to cache.
        const recoveredBlob = await readCachedBlob(normalizedSetId, audioFileName);
        if (jobId !== state.fullAudioJobId) {
          return;
        }
        if (recoveredBlob) {
          setProviderState({ currentArchiveProviderLabel: CACHE_AUDIO_PROVIDER_LABEL });
          setAudioBadgeWithProvider('loading', 'Loading full audio', CACHE_AUDIO_PROVIDER_LABEL, 'Using cached full audio');
          addDebugLog(`audio: cache recovered after worker disconnect (${Math.round(recoveredBlob.size / 1024)} KB)`);
          void ensureCachedInfo(normalizedSetId, audioFileName, mapsetInfo, recoveredBlob);
          const swapped = await hotswapToFullAudio(
            recoveredBlob,
            normalizedSetId,
            audioFileName,
            jobId,
            CACHE_AUDIO_PROVIDER_LABEL,
          );
          if (!swapped && jobId === state.fullAudioJobId && state.fullAudioStatus !== 'ready') {
            throw new Error('Failed to load recovered cached full audio.');
          }
          return;
        }

        addDebugLog(extractionResult?.cacheWriteFailed
          ? 'audio: worker could not cache the audio; retry download in popup'
          : 'audio: worker unreachable; retry download in popup');
        // Tied to this job and stored on the controller so configureAudioPreview
        // or a new upgradeToFullAudioIfPossible aborts even a header-stalled fetch.
        const controller = registry.createAbortController();
        activePopupExtractionController = controller;
        const isSuperseded = () => {
          if (jobId === state.fullAudioJobId) {
            return false;
          }
          controller.abort();
          return true;
        };
        try {
          extractionResult = await extractAudio({
            setId: normalizedSetId,
            audioFilename: audioFileName,
            providerOverride: state.providerOverride,
            userPriority: state.providerPriority,
            disabledProviders: state.disabledProviders,
            autoFallback: state.autoFallback,
            signal: controller.signal,
            onTryingSource: (providerLabel) => {
              if (!isSuperseded()) {
                showTryingArchiveProviderBadge(providerLabel);
              }
            },
            onDownloadProgress: (evt) => {
              if (isSuperseded()) {
                return;
              }
              showTryingArchiveProviderBadge(evt.providerLabel, {
                loaded: evt.loaded,
                total: evt.total,
              });
            },
          });
        } finally {
          if (activePopupExtractionController === controller) {
            activePopupExtractionController = null;
          }
          registry.releaseAbortController(controller);
        }
      } else if (!extractionResult.ok) {
        addDebugLog('audio: worker download failed; not repeating it in popup');
      }
      if (!extractionResult?.ok) {
        throw new Error(extractionResult?.error || 'background extraction failed');
      }

      if (jobId !== state.fullAudioJobId) {
        return;
      }
      const {
        sourceLabel,
        pickedAudioFilename,
        normalizedPickedAudioFilename,
        normalizedRequestedAudioFilename,
        mime,
        byteLength: cachedByteLength,
      } = extractionResult;

      setProviderState({ currentArchiveProviderLabel: sourceLabel });
      setAudioBadgeWithProvider('loading', 'Loading full audio', sourceLabel, `Downloading from ${sourceLabel}`);

      let audioBlob = await readCachedBlob(normalizedSetId, audioFileName);
      if (jobId !== state.fullAudioJobId) {
        return;
      }
      let byteLength = Number.isFinite(cachedByteLength) ? cachedByteLength : (audioBlob?.size || 0);
      if (audioBlob) {
        addDebugLog(`audio: archive extracted in worker from ${sourceLabel} (${Math.round(byteLength / 1024)} KB)`);
      } else if (extractionResult.audioBytes instanceof Uint8Array && extractionResult.audioBytes.byteLength > 0) {
        audioBlob = new Blob([extractionResult.audioBytes], { type: mime || getAudioMimeType(pickedAudioFilename) });
        byteLength = extractionResult.audioBytes.byteLength;
        addDebugLog(`audio: archive extracted in popup from ${sourceLabel} (${Math.round(byteLength / 1024)} KB)`);
        const cachedWriteOk = await writeCachedBlob(
          normalizedSetId,
          audioFileName,
          audioBlob,
          mapsetInfo,
        );
        if (!cachedWriteOk) {
          // Nothing else reports this: the audio still plays, but the next load
          // finds no entry and downloads the archive again.
          addDebugLog('audio: cache write failed; this track will be downloaded again next time');
        }
      }

      if (jobId !== state.fullAudioJobId) {
        return;
      }
      if (!audioBlob || byteLength <= 0) {
        throw new Error('Full-audio extraction returned no cached audio payload.');
      }
      addDebugLog(`audio: selected entry ${pickedAudioFilename}`);

      if (normalizedPickedAudioFilename !== normalizedRequestedAudioFilename) {
        addDebugLog('audio: cache stored under requested metadata filename');
      }
      const swapped = await hotswapToFullAudio(audioBlob, normalizedSetId, pickedAudioFilename, jobId, sourceLabel);
      if (!swapped && jobId === state.fullAudioJobId && state.fullAudioStatus !== 'ready') {
        throw new Error('Failed to load extracted full audio.');
      }
    } catch (error) {
      if (jobId === state.fullAudioJobId) {
        setFullAudioState({
          fullAudioStatus: 'failed',
          fullAudioError: error?.message || 'unknown error',
        });
        setAudioBadgeWithProvider(
          'failed',
          'Full audio failed',
          state.currentArchiveProviderLabel,
          state.fullAudioError,
        );
        addDebugLog(`audio: full-load failed -> ${state.fullAudioError}`);
      }
    } finally {
      if (jobId === state.fullAudioJobId) {
        setFullAudioLoading(false);
        syncPlaybackDuration();
        addDebugLog(`audio: full-load end (status=${state.fullAudioStatus})`);
      }
    }
  };

  const runAudioFetchProbe = async () => {
    const targetSetId = state.activeSetId || state.previewSetId || state.fullAudioSetId;
    if (!targetSetId) {
      addDebugLog('probe: no beatmap set id available');
      return;
    }

    const sources = getProviderSequenceForDownload(
      state.providerOverride,
      state.providerPriority,
      state.disabledProviders,
      state.autoFallback,
    );
    if (!sources.length) {
      addDebugLog('probe: no providers available');
      return;
    }

    const probeTimeoutMs = sources.length > 1 ? FETCH_TIMEOUT_FAILOVER_MS : Math.min(FETCH_TIMEOUT_MS, 12000);
    addDebugLog(`probe: running provider checks for set ${targetSetId} (${getProviderDisplayName(state.providerOverride)})`);
    addDebugLog(`probe: provider order ${sources.map((source) => source.label).join(' -> ')}`);
    for (const source of sources) {
      const result = await probeArchiveSource(source, targetSetId, probeTimeoutMs);
      if (result.ok) {
        addDebugLog(
          `probe: ${source.label} ok (${result.status}) bytes=[${result.firstBytes || 'none'}] url=${result.finalUrl}`,
        );
      } else {
        addDebugLog(
          `probe: ${source.label} fail (${result.status || 0}) ${result.error || ''} url=${result.finalUrl}`,
        );
      }
    }
    addDebugLog('probe: complete');
  };

  return {
    configureAudioPreview,
    upgradeToFullAudioIfPossible,
    runAudioFetchProbe,
    seekAudioToTrackTime,
    releaseFullAudioObjectUrl: () => setFullAudioObjectUrl(null),
  };
};

export { PREVIEW_AUDIO_PROVIDER_LABEL, createFullAudioController };
