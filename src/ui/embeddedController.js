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
  addTabsUpdatedListener,
  getCurrentTab,
  queryTabs,
  sendTabMessage,
} from '../webextension.js';
import {
  EMBEDDED_MESSAGE_CHANNEL,
  OSU_ORIGIN,
  isOsuWebsiteUrl,
  serializeResumeSnapshot,
} from '../core/embeddedPlayer.js';
import { extractBeatmapInfoFromUrl } from '../core/beatmapUrl.js';
import { isSameFollowTarget, toFollowTarget } from '../core/tabFollow.js';

const FOLLOW_SYNC_DEBOUNCE_MS = 250;
const SNAPSHOT_INTERVAL_MS = 2000;

const createEmbeddedController = ({
  state,
  registry,
  isEmbedded = false,
  elements: { embedButton, followButton },
  addDebugLog,
  showPopupToast,
  loadPreview,
  closeDetachedWindowIfOpen,
  onCollapsedChange,
}) => {
  let embedInFlight = false;
  let hasUserToggledFollow = false;
  let ownTabId = null;
  let latestTabUrl = '';
  let snapshotTimer = null;
  let bridgeStarted = false;

  const updateEmbedButtonState = () => {
    if (!embedButton) {
      return;
    }
    const canEmbed = Boolean(
      !isEmbedded
      && state.embeddedPlayer
      && state.detachContext?.beatmapId
      && isOsuWebsiteUrl(state.embedContext?.tabUrl || ''),
    );
    embedButton.disabled = !canEmbed;
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
  const closeEmbeddedPlayersOnOsuTabs = async () => {
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

  const requestCloseEmbedded = () => postToHost({ type: 'requestClose' });

  const requestExpandEmbedded = () => {
    if (!isEmbedded || !state.embeddedCollapsed) {
      return false;
    }
    return postToHost({ type: 'requestExpand' });
  };

  const openEmbeddedPlayer = async () => {
    if (embedInFlight || isEmbedded || !state.embeddedPlayer) {
      return false;
    }
    const beatmapId = state.detachContext?.beatmapId || '';
    if (!beatmapId) {
      showPopupToast('No beatmap to pin yet');
      return false;
    }

    embedInFlight = true;
    try {
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

      const payload = {
        type: 'mosuEmbeddedOpen',
        beatmapId,
        setId: state.detachContext?.setId || '',
        mode: state.detachContext?.mode ?? null,
        resumeTimeMs: state.mapData ? Math.round(state.currentTimeMs) : -1,
        resumePaused: !state.isPlaying,
      };

      try {
        const response = await sendTabMessage(targetTabId, payload);
        if (!response?.ok) {
          throw new Error(response?.error || 'Could not mount embedded player.');
        }
      } catch (error) {
        addDebugLog(`embed: could not reach osu! tab (${error?.message || error})`);
        showPopupToast('Reload the osu! tab once to pin the preview', { tone: 'info' });
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
      followButton.setAttribute('aria-pressed', state.followEnabled ? 'true' : 'false');
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
    if (event.origin !== OSU_ORIGIN) {
      return;
    }
    if (globalThis.parent && event.source && event.source !== globalThis.parent) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== 'object' || data.channel !== EMBEDDED_MESSAGE_CHANNEL) {
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

  const startEmbeddedBridge = ({ initialFollowEnabled = true } = {}) => {
    if (!isEmbedded || bridgeStarted) {
      return;
    }
    bridgeStarted = true;

    if (!hasUserToggledFollow) {
      setEmbeddedFollowEnabled(initialFollowEnabled);
    }

    globalThis.window?.addEventListener?.('message', handleHostMessage);

    // Fallback for in-page React `history.pushState` transitions that do not
    // fire `turbo:load` or `hashchange`: scoped strictly to our hosting tab.
    void (async () => {
      try {
        const currentTab = await getCurrentTab();
        if (Number.isInteger(currentTab?.id)) {
          ownTabId = currentTab.id;
          if (currentTab.url) {
            latestTabUrl = currentTab.url;
          }
        }
      } catch {
        ownTabId = null;
      }
    })();

    addTabsUpdatedListener((tabId, changeInfo) => {
      if (ownTabId === null || tabId !== ownTabId) {
        return;
      }
      if (changeInfo?.url) {
        scheduleEmbeddedFollowSync(changeInfo.url);
      }
    });

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
    bridgeStarted = false;
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
    requestCloseEmbedded,
    requestExpandEmbedded,
  };
};

export { createEmbeddedController };
