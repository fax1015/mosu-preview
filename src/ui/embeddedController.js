// Bridge for the in-page osu.ppy.sh embedded miniplayer.
//
// Two sides live here depending on which surface owns this document:
// - Toolbar popup: pins the current preview into the active osu.ppy.sh tab and
//   dismisses any already-embedded players when the toolbar popup opens.
// - Embedded iframe (`popup.html?embedded=1&...`): listens for Turbo/hash/URL
//   changes from its host content script (plus `tabs.onUpdated` on its own tab
//   as a fallback for React pushState transitions), handles pin/follow, posts
//   periodic reload-resume snapshots, and asks the parent shell to close or
//   expand when needed.

import {
  addRuntimeMessageListener,
  addTabsUpdatedListener,
  executeContentScript,
  getCurrentTab,
  queryTabs,
  removeRuntimeMessageListener,
  removeTabsUpdatedListener,
  sendTabMessage,
} from '../webextension.js';
import {
  EMBEDDED_HOST_TOKEN_MESSAGE,
  EMBEDDED_MESSAGE_CHANNEL,
  OSU_ORIGIN,
  isOsuWebsiteUrl,
  normalizeHostToken,
  normalizeMountId,
  serializeResumeSnapshot,
} from '../core/embeddedPlayer.js';
import { extractBeatmapInfoFromUrl } from '../core/beatmapUrl.js';
import { isSameFollowTarget, toFollowTarget } from '../core/tabFollow.js';
import { formatRgb, formatRgba } from '../core/coverPalette.js';

const FOLLOW_SYNC_DEBOUNCE_MS = 250;
const SNAPSHOT_INTERVAL_MS = 2000;

const createEmbeddedController = ({
  state,
  registry,
  isEmbedded = false,
  // The `mount` id in this iframe's URL: which shell's secret to take.
  hostMountId = '',
  elements: { embedButton, unsupportedEmbedButton, followButton },
  addDebugLog,
  showPopupToast,
  loadPreview,
  closeDetachedWindowIfOpen,
  flushPendingCacheWrite,
  onCollapsedChange,
  onHostClosing,
}) => {
  let embedInFlight = false;
  let pendingClosePromise = null;
  let hasUserToggledFollow = false;
  let ownTabId = null;
  let latestTabUrl = '';
  let snapshotTimer = null;
  let bridgeStarted = false;
  // Bumped each time the bridge stops, so work started before then lets go.
  let bridgeGeneration = 0;
  let lastReportedInnerChromeHeight = null;
  const ownMountId = normalizeMountId(hostMountId);
  // The secret the shell around this iframe handed over by extension
  // messaging. The osu! page shares the shell's origin and can post to this
  // window too, so a message from the shell counts only if it carries this.
  let hostToken = '';

  const updateEmbedButtonState = () => {
    const canEmbed = Boolean(
      !isEmbedded
      && state.embeddedPlayer
      && isOsuWebsiteUrl(state.embedContext?.tabUrl || ''),
    );
    if (embedButton) {
      embedButton.disabled = !canEmbed;
    }
    if (unsupportedEmbedButton) {
      unsupportedEmbedButton.disabled = !canEmbed;
    }
  };

  const setEmbedContext = ({ tabId = null, tabUrl = '' } = {}) => {
    state.embedContext = {
      tabId: Number.isInteger(tabId) ? tabId : null,
      tabUrl: typeof tabUrl === 'string' ? tabUrl : '',
    };
    updateEmbedButtonState();
  };

  /**
   * Closes any open embedded players across osu.ppy.sh tabs so two previews
   * never play over each other when the toolbar popup or detached window opens.
   */
  const closeEmbeddedPlayersOnOsuTabs = () => {
    if (pendingClosePromise) {
      return pendingClosePromise;
    }
    const run = (async () => {
      let tabs = [];
      try {
        tabs = await queryTabs({ url: 'https://osu.ppy.sh/*' });
      } catch {
        return 0;
      }

      let closedCount = 0;
      await Promise.all(
        (tabs || []).map(async (tab) => {
          if (!Number.isInteger(tab?.id)) {
            return;
          }
          try {
            const response = await sendTabMessage(tab.id, { type: 'mosuEmbeddedClose' });
            if (response?.closed) {
              closedCount += 1;
            }
          } catch {
            // Tab may not have the content script injected (e.g. opened before install).
          }
        }),
      );

      if (closedCount > 0) {
        addDebugLog(`embed: closed ${closedCount} embedded player(s)`);
      }
      return closedCount;
    })().finally(() => {
      if (pendingClosePromise === run) {
        pendingClosePromise = null;
      }
    });
    pendingClosePromise = run;
    return run;
  };

  const postToHost = (payload) => {
    if (!isEmbedded || !globalThis.parent || globalThis.parent === globalThis.window) {
      return false;
    }
    try {
      globalThis.parent.postMessage({
        channel: EMBEDDED_MESSAGE_CHANNEL,
        ...payload,
      }, OSU_ORIGIN);
      return true;
    } catch {
      return false;
    }
  };

  const publishResumeSnapshot = () => {
    if (!isEmbedded) {
      return false;
    }
    const beatmapId = state.detachContext?.beatmapId || '';
    if (!beatmapId) {
      return false;
    }
    const snapshot = serializeResumeSnapshot({
      beatmapId,
      setId: state.detachContext?.setId || '',
      mode: state.detachContext?.mode ?? null,
      currentTimeMs: state.mapData ? state.currentTimeMs : 0,
      isPlaying: state.isPlaying,
      playbackSpeed: state.playbackSpeed,
      followEnabled: state.followEnabled,
      collapsed: state.embeddedCollapsed,
      sourceUrl: latestTabUrl,
    });
    if (!snapshot) {
      return false;
    }
    return postToHost({ type: 'playbackSnapshot', snapshot });
  };

  /**
   * Hands the shell around the iframe the cover-art colours its own bar is
   * drawn in while collapsed (src/ui/miniTheme.js), so the top row it draws
   * over this page matches the page under it.
   */
  const publishMiniPalette = (palette) => {
    if (!palette?.surface || !palette.onSurfaceVariant || !palette.onSurface) {
      return false;
    }
    return postToHost({
      type: 'miniPalette',
      palette: {
        surface: formatRgb(palette.surface),
        chromeForeground: formatRgb(palette.onSurfaceVariant),
        chromeButton: formatRgba(palette.onSurface, 0.07),
      },
    });
  };

  const requestCloseEmbedded = () => postToHost({ type: 'requestClose' });

  const requestExpandEmbedded = () => {
    if (!isEmbedded || !state.embeddedCollapsed) {
      return false;
    }
    return postToHost({ type: 'requestExpand' });
  };

  const reportChromeMetrics = (innerChromeHeight) => {
    if (!isEmbedded || state.embeddedCollapsed) {
      return false;
    }
    const rounded = Math.ceil(Number(innerChromeHeight));
    if (!Number.isFinite(rounded) || rounded <= 0 || rounded === lastReportedInnerChromeHeight) {
      return false;
    }
    lastReportedInnerChromeHeight = rounded;
    return postToHost({ type: 'chromeMetrics', innerChromeHeight: rounded });
  };

  const openEmbeddedPlayer = async () => {
    if (embedInFlight || isEmbedded || !state.embeddedPlayer) {
      return false;
    }
    const beatmapId = state.detachContext?.beatmapId || '';

    embedInFlight = true;
    try {
      // Wait for any startup close sweep so it cannot arrive after mosuEmbeddedOpen
      // and tear down the newly mounted overlay.
      if (pendingClosePromise) {
        await pendingClosePromise;
      }

      let targetTabId = state.embedContext?.tabId ?? null;
      let targetTabUrl = state.embedContext?.tabUrl || '';

      if (!Number.isInteger(targetTabId) || !isOsuWebsiteUrl(targetTabUrl)) {
        const tabs = await queryTabs({ active: true, currentWindow: true }).catch(() => []);
        const activeTab = Array.isArray(tabs) ? tabs[0] : null;
        if (activeTab && Number.isInteger(activeTab.id) && isOsuWebsiteUrl(activeTab.url)) {
          targetTabId = activeTab.id;
          targetTabUrl = activeTab.url;
        }
      }

      if (!Number.isInteger(targetTabId) || !isOsuWebsiteUrl(targetTabUrl)) {
        showPopupToast('Open an osu.ppy.sh tab to pin the preview');
        return false;
      }

      if (typeof closeDetachedWindowIfOpen === 'function') {
        await closeDetachedWindowIfOpen();
      }

      // Let an in-flight .osu session cache write finish before closing the
      // toolbar popup so the embedded iframe gets an immediate cache hit.
      if (typeof flushPendingCacheWrite === 'function') {
        let flushTimer = null;
        try {
          await Promise.race([
            Promise.resolve().then(() => flushPendingCacheWrite()).catch(() => {}),
            new Promise((resolve) => {
              flushTimer = setTimeout(resolve, 150);
            }),
          ]);
        } finally {
          if (flushTimer !== null) {
            clearTimeout(flushTimer);
          }
        }
      }

      // Only carry a resume timestamp and pause flag once playback has actually
      // initialized (or been manually started). Clicking the miniplayer button
      // immediately after the popup appears -- while afterNextPaint / WebAudio
      // attach is still running before autoplay fires -- would otherwise see
      // `state.mapData && !state.isPlaying` and hand over a spurious `paused=1`.
      const hasLivePlaybackState = Boolean(state.mapData && (state.hasAutoStarted || state.isPlaying));
      const payload = {
        type: 'mosuEmbeddedOpen',
        beatmapId,
        sourceUrl: beatmapId ? '' : targetTabUrl,
        setId: state.detachContext?.setId || '',
        mode: state.detachContext?.mode ?? null,
        resumeTimeMs: hasLivePlaybackState ? Math.round(state.currentTimeMs) : -1,
        resumePaused: hasLivePlaybackState ? !state.isPlaying : false,
      };

      // Whether a content script answered at all, and what it said. One that
      // answers { ok: false } is there and turned the mount down (a close
      // overtook it), which injecting it again would not change.
      const sendOpen = async () => {
        try {
          const response = await sendTabMessage(targetTabId, payload);
          return response && typeof response === 'object'
            ? { reached: true, response }
            : { reached: false, error: new Error('No content script answered.') };
        } catch (error) {
          return { reached: false, error };
        }
      };

      try {
        let result = await sendOpen();
        if (!result.reached) {
          // Static content scripts are skipped on already-open tabs after an
          // install/reload and in Firefox MV3 when host permissions have not
          // been permanently granted. Inject on demand via activeTab + scripting.
          addDebugLog(`embed: initial message failed (${result.error?.message || result.error}); injecting content script`);
          await executeContentScript(targetTabId, ['src/content.js']);
          result = await sendOpen();
        }
        if (!result.reached || !result.response.ok) {
          throw result.error || new Error(result.response?.error || 'Could not mount embedded player.');
        }
      } catch (error) {
        addDebugLog(`embed: could not mount on osu! tab (${error?.message || error})`);
        showPopupToast('Could not pin preview to this osu! tab', { tone: 'error' });
        return false;
      }

      globalThis.window?.close?.();
      return true;
    } finally {
      embedInFlight = false;
    }
  };

  const setEmbeddedFollowEnabled = (isEnabled) => {
    state.followEnabled = Boolean(isEnabled);

    if (followButton) {
      followButton.classList.toggle('is-following', state.followEnabled);
      // Pressed means pinned: that is the state the button shows as on.
      followButton.setAttribute('aria-pressed', state.followEnabled ? 'false' : 'true');
      const label = state.followEnabled
        ? 'Following this osu! tab — click to pin this map'
        : 'Pinned to this map — click to follow this osu! tab';
      followButton.title = label;
      followButton.setAttribute('aria-label', label);
    }

    if (isEmbedded) {
      publishResumeSnapshot();
    }
  };

  const syncPreviewWithHostUrl = async (candidateUrl) => {
    const url = typeof candidateUrl === 'string' && candidateUrl ? candidateUrl : latestTabUrl;
    if (!url || !state.followEnabled) {
      return;
    }

    const info = extractBeatmapInfoFromUrl(url);
    if (!info.valid) {
      // Navigating to rankings, profiles, forums, or a mapset without a
      // difficulty leaves the current preview playing untouched.
      return;
    }

    const nextTarget = toFollowTarget(info);
    const nativeMode = Number.isInteger(state.sourceMapData?.mode)
      ? state.sourceMapData.mode
      : (Number.isInteger(state.mapData?.mode) ? state.mapData.mode : null);
    if (isSameFollowTarget(state.followTarget, nextTarget, { nativeMode })) {
      return;
    }

    state.followTarget = nextTarget;
    addDebugLog(`embed-follow: switching to beatmap ${info.beatmapId}`);
    await loadPreview({ sourceUrlOverride: url });
  };

  const scheduleEmbeddedFollowSync = (url) => {
    if (typeof url === 'string' && url) {
      latestTabUrl = url;
    }
    if (!state.followEnabled) {
      return;
    }
    state.followSyncTimer = registry.clearTimeout(state.followSyncTimer);
    state.followSyncTimer = registry.addTimeout(setTimeout(() => {
      state.followSyncTimer = registry.clearTimeout(state.followSyncTimer);
      void syncPreviewWithHostUrl(latestTabUrl);
    }, FOLLOW_SYNC_DEBOUNCE_MS));
  };

  const toggleEmbeddedFollowEnabled = () => {
    hasUserToggledFollow = true;
    setEmbeddedFollowEnabled(!state.followEnabled);
    showPopupToast(state.followEnabled ? 'Following this osu! tab' : 'Pinned to this map');

    if (state.followEnabled) {
      void syncPreviewWithHostUrl(latestTabUrl);
    }
  };

  const applyCollapsedState = (collapsed) => {
    const nextCollapsed = Boolean(collapsed);
    if (state.embeddedCollapsed === nextCollapsed) {
      return;
    }
    state.embeddedCollapsed = nextCollapsed;
    onCollapsedChange?.(nextCollapsed);
    publishResumeSnapshot();
  };

  const handleHostMessage = (event) => {
    if (!isEmbedded) {
      return;
    }
    if (event.origin !== OSU_ORIGIN || !globalThis.parent || event.source !== globalThis.parent) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== 'object' || data.channel !== EMBEDDED_MESSAGE_CHANNEL) {
      return;
    }
    if (!hostToken || data.token !== hostToken) {
      return;
    }

    if (data.type === 'pageUrlChanged' && typeof data.url === 'string') {
      scheduleEmbeddedFollowSync(data.url);
      return;
    }

    if (data.type === 'collapsedChanged') {
      applyCollapsedState(Boolean(data.collapsed));
      return;
    }

    // The shell is fading out and will remove this page once it has: stop
    // now, so nothing plays on under a window that is already going.
    if (data.type === 'closing') {
      onHostClosing?.();
      return;
    }

    if (data.type === 'loadBeatmap' && typeof data.sourceUrl === 'string') {
      latestTabUrl = data.sourceUrl;
      const info = extractBeatmapInfoFromUrl(data.sourceUrl);
      if (info.valid) {
        state.followTarget = toFollowTarget(info);
        void loadPreview({
          sourceUrlOverride: data.sourceUrl,
          resumeOverride: Number.isFinite(data.resumeTimeMs) && data.resumeTimeMs >= 0
            ? { timeMs: data.resumeTimeMs, paused: Boolean(data.resumePaused) }
            : null,
        });
      }
    }
  };

  // The shell's content script handing over its secret, keyed by the mount id
  // in this iframe's URL; every other tab's shell has its own. Only extension
  // contexts can send runtime messages, and the page cannot see them.
  const handleHostTokenMessage = (message, sender, sendResponse) => {
    if (message?.type !== EMBEDDED_HOST_TOKEN_MESSAGE || !ownMountId || message.mount !== ownMountId) {
      return false;
    }
    const token = normalizeHostToken(message.token);
    if (!token || !isOsuWebsiteUrl(sender?.url || '')) {
      return false;
    }
    hostToken = token;
    sendResponse?.({ ok: true });
    return false;
  };

  const handleTabUpdated = (tabId, changeInfo) => {
    if (ownTabId === null || tabId !== ownTabId) {
      return;
    }
    if (changeInfo?.url) {
      scheduleEmbeddedFollowSync(changeInfo.url);
    }
  };

  const startEmbeddedBridge = ({ initialFollowEnabled = true } = {}) => {
    if (!isEmbedded || bridgeStarted) {
      return;
    }
    bridgeStarted = true;
    const generation = bridgeGeneration;

    if (!hasUserToggledFollow) {
      setEmbeddedFollowEnabled(initialFollowEnabled);
    }

    globalThis.window?.addEventListener?.('message', handleHostMessage);
    // Listening before saying ready: the shell hands its secret over on hearing it.
    addRuntimeMessageListener(handleHostTokenMessage);

    // Fallback for in-page React `history.pushState` transitions that do not
    // fire `turbo:load` or `hashchange`: scoped strictly to our hosting tab.
    void (async () => {
      let currentTab = null;
      try {
        currentTab = await getCurrentTab();
      } catch {
        currentTab = null;
      }
      if (!bridgeStarted || generation !== bridgeGeneration) {
        return;
      }
      ownTabId = Number.isInteger(currentTab?.id) ? currentTab.id : null;
      if (ownTabId !== null && currentTab.url) {
        latestTabUrl = currentTab.url;
      }
    })();

    addTabsUpdatedListener(handleTabUpdated);

    snapshotTimer = registry.addInterval(setInterval(() => {
      if (state.isPlaying) {
        publishResumeSnapshot();
      }
    }, SNAPSHOT_INTERVAL_MS));

    // Handshake: lets the content script capture our exact runtime origin
    // (required when Chrome assigns a per-session `use_dynamic_url` origin).
    postToHost({ type: 'ready' });
    publishResumeSnapshot();
  };

  const disposeEmbeddedBridge = () => {
    if (!bridgeStarted) {
      return;
    }
    publishResumeSnapshot();
    snapshotTimer = registry.clearInterval(snapshotTimer);
    globalThis.window?.removeEventListener?.('message', handleHostMessage);
    removeRuntimeMessageListener(handleHostTokenMessage);
    removeTabsUpdatedListener(handleTabUpdated);
    bridgeGeneration += 1;
    bridgeStarted = false;
    hostToken = '';
    ownTabId = null;
  };

  return {
    setEmbedContext,
    updateEmbedButtonState,
    openEmbeddedPlayer,
    closeEmbeddedPlayersOnOsuTabs,
    setEmbeddedFollowEnabled,
    toggleEmbeddedFollowEnabled,
    startEmbeddedBridge,
    disposeEmbeddedBridge,
    publishResumeSnapshot,
    publishMiniPalette,
    requestCloseEmbedded,
    requestExpandEmbedded,
    reportChromeMetrics,
  };
};

export { createEmbeddedController };
