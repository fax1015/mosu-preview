// The detached preview window: opening it from the toolbar popup, keeping a
// single one alive, remembering where it was, and -- once it is open -- following
// whichever beatmap the user is looking at in a normal browsing window.
//
// The pure parts (URL building, bounds, which tab to mirror) live in
// core/detachedWindow.js and core/tabFollow.js; this is the part that talks to
// the extension APIs and the header buttons.

import {
  addTabsActivatedListener,
  addTabsUpdatedListener,
  addWindowsFocusChangedListener,
  createTab,
  createWindow,
  getExtensionUrl,
  getWindow,
  hasWindowsApi,
  queryTabs,
  removeWindow,
  storageGet,
  storageSet,
  updateWindow,
  WINDOW_ID_NONE,
} from '../webextension.js';
import {
  DETACHED_WINDOW_BOUNDS_KEY,
  DETACHED_WINDOW_ID_KEY,
  buildDetachedPageUrl,
  hasDetachedPosition,
  isBoundsRejection,
  normalizeDetachedBounds,
  withoutDetachedPosition,
} from '../core/detachedWindow.js';
import { isSameFollowTarget, pickBeatmapTabInfo, toFollowTarget } from '../core/tabFollow.js';

// Long enough to collapse a burst of hash rewrites, short enough that clicking a
// difficulty feels like it loads immediately.
const FOLLOW_SYNC_DEBOUNCE_MS = 250;

/**
 * @param {object} options
 * @param {(options: { sourceUrlOverride: string }) => Promise<void>} options.loadPreview
 *   Loads the beatmap at a URL into this page.
 */
const createDetachController = ({
  state,
  registry,
  elements: { detachButton, followButton },
  addDebugLog,
  showPopupToast,
  loadPreview,
  onContextChanged = null,
  onAfterOpen = null,
}) => {
  const setDetachContext = ({ beatmapId, setId, mode } = {}) => {
    state.detachContext = {
      beatmapId: String(beatmapId || ''),
      setId: String(setId || ''),
      mode: Number.isInteger(mode) ? mode : null,
    };

    if (detachButton) {
      detachButton.disabled = !state.detachContext.beatmapId;
    }
    onContextChanged?.(state.detachContext);
  };

  const readStoredDetachedWindowId = async () => {
    try {
      const items = await storageGet('session', [DETACHED_WINDOW_ID_KEY], { fallbackAreaName: 'local' });
      const windowId = Number(items?.[DETACHED_WINDOW_ID_KEY]);
      return Number.isInteger(windowId) ? windowId : null;
    } catch {
      return null;
    }
  };

  const writeStoredDetachedWindowId = async (windowId) => {
    try {
      await storageSet('session', { [DETACHED_WINDOW_ID_KEY]: windowId ?? null }, { fallbackAreaName: 'local' });
    } catch (error) {
      addDebugLog(`detach: could not persist window id (${error?.message || error})`);
    }
  };

  const readDetachedBounds = async () => {
    try {
      const items = await storageGet('local', [DETACHED_WINDOW_BOUNDS_KEY]);
      return normalizeDetachedBounds(items?.[DETACHED_WINDOW_BOUNDS_KEY] || {});
    } catch {
      return normalizeDetachedBounds({});
    }
  };

  /**
   * Focuses the previously opened detached window if it is still around, so the
   * button never leaves the user with two windows fighting over the same audio.
   */
  const focusExistingDetachedWindow = async () => {
    const windowId = await readStoredDetachedWindowId();
    if (windowId === null) {
      return false;
    }

    const existingWindow = await getWindow(windowId);
    if (!existingWindow) {
      await writeStoredDetachedWindowId(null);
      return false;
    }

    try {
      // `drawAttention` is deliberately omitted: Firefox ignores it on a window
      // that is being focused in the same call.
      await updateWindow(windowId, { focused: true });
      return true;
    } catch {
      await writeStoredDetachedWindowId(null);
      return false;
    }
  };

  let pendingClosePromise = null;
  let openInFlight = false;
  let hasUserToggledFollow = false;

  const getCurrentWindowId = async () => {
    const windowsApi = globalThis.browser?.windows ?? globalThis.chrome?.windows ?? null;
    if (!windowsApi?.getCurrent) {
      return null;
    }
    try {
      if (globalThis.browser?.windows?.getCurrent) {
        const win = await windowsApi.getCurrent();
        return Number.isInteger(win?.id) ? win.id : null;
      }
      return await new Promise((resolve) => {
        windowsApi.getCurrent((win) => {
          const error = globalThis.chrome?.runtime?.lastError;
          resolve(!error && Number.isInteger(win?.id) ? win.id : null);
        });
      });
    } catch {
      return null;
    }
  };

  /**
   * Opening the toolbar popup while a detached window is up closes that window.
   * The action has a `default_popup`, so clicking the icon always opens this page;
   * without this the two previews would play over each other.
   */
  const closeDetachedWindowIfOpen = () => {
    if (pendingClosePromise) {
      return pendingClosePromise;
    }
    const run = (async () => {
      try {
        const windowId = await readStoredDetachedWindowId();
        if (windowId === null) {
          return false;
        }

        const existingWindow = await getWindow(windowId);
        if (!existingWindow) {
          await writeStoredDetachedWindowId(null);
          return false;
        }

        const closed = await removeWindow(windowId);
        await writeStoredDetachedWindowId(null);
        if (closed) {
          addDebugLog('detach: closed the detached window on popup open');
        }
        return closed;
      } catch (error) {
        addDebugLog(`detach: could not close detached window (${error?.message || error})`);
        return false;
      } finally {
        if (pendingClosePromise === run) {
          pendingClosePromise = null;
        }
      }
    })();
    pendingClosePromise = run;
    return run;
  };

  const openDetachedWindow = async () => {
    if (openInFlight) {
      return;
    }
    const hasLivePlaybackState = Boolean(state.mapData && (state.hasAutoStarted || state.isPlaying));
    const pagePath = buildDetachedPageUrl({
      beatmapId: state.detachContext.beatmapId,
      setId: state.detachContext.setId,
      mode: state.detachContext.mode,
      // Hand over the playhead once playback has initialized; before autoplay
      // has run, let the detached window start fresh instead of carrying a
      // spurious `paused=1`.
      resumeTimeMs: hasLivePlaybackState ? state.currentTimeMs : -1,
      resumePaused: hasLivePlaybackState ? !state.isPlaying : false,
    });

    if (!pagePath) {
      showPopupToast('No beatmap to detach yet');
      return;
    }

    openInFlight = true;
    try {
      // Finish any in-flight close from popup open so it cannot overwrite the
      // new detached window's stored id with null.
      if (pendingClosePromise) {
        await pendingClosePromise;
      }

      const pageUrl = getExtensionUrl(pagePath);

      // Firefox for Android has no window management, so the preview opens as a tab
      // there instead of failing outright.
      if (!hasWindowsApi()) {
        try {
          await createTab({ url: pageUrl });
          if (typeof onAfterOpen === 'function') {
            onAfterOpen();
          } else {
            window.close();
          }
        } catch (error) {
          addDebugLog(`detach: tab fallback failed (${error?.message || error})`);
          showPopupToast('Could not open a separate view', { tone: 'error' });
        }
        return;
      }

      if (await focusExistingDetachedWindow()) {
        if (typeof onAfterOpen === 'function') {
          onAfterOpen();
        } else {
          window.close();
        }
        return;
      }

      const bounds = await readDetachedBounds();
      let createdWindow = null;
      try {
        createdWindow = await createWindow({ url: pageUrl, type: 'popup', ...bounds });
      } catch (error) {
        if (!isBoundsRejection(error) || !hasDetachedPosition(bounds)) {
          throw error;
        }
        // The remembered position is not on a screen any more -- a monitor was
        // unplugged, or the resolution changed under it. Keep the size, let the
        // browser choose where, and forget the position so it cannot strand the
        // detach button again.
        addDebugLog('detach: remembered position is off-screen, letting the browser place it');
        const size = withoutDetachedPosition(bounds);
        createdWindow = await createWindow({ url: pageUrl, type: 'popup', ...size });
        void storageSet('local', { [DETACHED_WINDOW_BOUNDS_KEY]: size }).catch(() => {});
      }
      await writeStoredDetachedWindowId(createdWindow?.id ?? null);
      if (typeof onAfterOpen === 'function') {
        onAfterOpen();
      } else {
        window.close();
      }
    } catch (error) {
      addDebugLog(`detach: failed (${error?.message || error})`);
      showPopupToast('Could not open a separate window', { tone: 'error' });
    } finally {
      openInFlight = false;
    }
  };

  const setFollowEnabled = (isEnabled) => {
    state.followEnabled = Boolean(isEnabled);

    if (followButton) {
      followButton.classList.toggle('is-following', state.followEnabled);
      // Pressed means pinned: that is the state the button shows as on.
      followButton.setAttribute('aria-pressed', state.followEnabled ? 'false' : 'true');
      const label = state.followEnabled
        ? 'Following the browser — click to pin this map'
        : 'Pinned to this map — click to follow the browser';
      followButton.title = label;
      followButton.setAttribute('aria-label', label);
    }
  };

  const toggleFollowEnabled = () => {
    hasUserToggledFollow = true;
    setFollowEnabled(!state.followEnabled);
    showPopupToast(state.followEnabled ? 'Following the browser' : 'Pinned to this map');

    // Catch up immediately: the user may have browsed elsewhere while pinned.
    if (state.followEnabled) {
      void syncPreviewWithBrowsingTabs();
    }
  };

  /**
   * Loads whichever beatmap the user is looking at in a normal browsing window.
   * Staying put when no beatmap tab is open is deliberate: browsing away to an
   * unrelated page should leave the current preview alone rather than blank it.
   */
  const syncPreviewWithBrowsingTabs = async () => {
    if (!state.followEnabled) {
      return;
    }

    let tabs = [];
    try {
      // Extension popup windows report as type 'popup', so this cannot match the
      // detached window itself.
      tabs = await queryTabs({ active: true, windowType: 'normal' });
    } catch (error) {
      addDebugLog(`follow: tab query failed (${error?.message || error})`);
      return;
    }

    // Re-check after the async query in case the user pinned while tabs were read.
    if (!state.followEnabled) {
      return;
    }

    const picked = pickBeatmapTabInfo(tabs, {
      preferredWindowId: state.lastFocusedBrowsingWindowId,
      excludeWindowId: state.detachedWindowId,
    });

    if (!picked) {
      return;
    }

    const nextTarget = toFollowTarget(picked.info);
    const nativeMode = Number.isInteger(state.sourceMapData?.mode)
      ? state.sourceMapData.mode
      : (Number.isInteger(state.mapData?.mode) ? state.mapData.mode : null);
    if (isSameFollowTarget(state.followTarget, nextTarget, { nativeMode })) {
      return;
    }

    // Update eagerly before awaiting loadPreview so a burst of tab events while
    // the map is fetching cannot restart the exact same load.
    state.followTarget = nextTarget;
    addDebugLog(`follow: switching to beatmap ${picked.info.beatmapId}`);
    await loadPreview({ sourceUrlOverride: picked.tab.url });
  };

  const scheduleFollowSync = () => {
    // Difficulty clicks rewrite the hash in bursts; the debounce collapses those
    // into the one map the user actually settled on.
    state.followSyncTimer = registry.clearTimeout(state.followSyncTimer);
    state.followSyncTimer = registry.addTimeout(setTimeout(() => {
      state.followSyncTimer = registry.clearTimeout(state.followSyncTimer);
      void syncPreviewWithBrowsingTabs();
    }, FOLLOW_SYNC_DEBOUNCE_MS));
  };

  const startFollowingBrowsingTabs = () => {
    if (!hasUserToggledFollow) {
      setFollowEnabled(true);
    }

    // Read this window's own id directly instead of racing the opener's storage
    // write, falling back to storage where windows.getCurrent is unavailable.
    void (async () => {
      try {
        const ownId = await getCurrentWindowId();
        state.detachedWindowId = ownId !== null ? ownId : await readStoredDetachedWindowId();
        if (state.detachedWindowId !== null && state.lastFocusedBrowsingWindowId === state.detachedWindowId) {
          state.lastFocusedBrowsingWindowId = null;
        }
      } catch {
        state.detachedWindowId = null;
      }
    })();

    addTabsUpdatedListener((_tabId, changeInfo) => {
      // Fires for hash changes too, which is how in-page difficulty switching on a
      // beatmapset page reaches us.
      if (changeInfo?.url || changeInfo?.status === 'complete') {
        scheduleFollowSync();
      }
    });

    addTabsActivatedListener(() => {
      scheduleFollowSync();
    });

    addWindowsFocusChangedListener((windowId) => {
      if (windowId === WINDOW_ID_NONE) {
        return;
      }
      if (windowId !== state.detachedWindowId) {
        state.lastFocusedBrowsingWindowId = windowId;
      }
      // Syncing on focus of either window is the safety net: if a hash change ever
      // fails to raise onUpdated, clicking back to the preview still picks it up.
      scheduleFollowSync();
    });
  };

  const persistDetachedBounds = () => {
    state.detachedBoundsTimer = registry.clearTimeout(state.detachedBoundsTimer);
    state.detachedBoundsTimer = registry.addTimeout(setTimeout(() => {
      const bounds = normalizeDetachedBounds({
        width: window.outerWidth,
        height: window.outerHeight,
        left: window.screenX,
        top: window.screenY,
      });
      void storageSet('local', { [DETACHED_WINDOW_BOUNDS_KEY]: bounds }).catch(() => {});
    }, 400));
  };

  return {
    setDetachContext,
    openDetachedWindow,
    closeDetachedWindowIfOpen,
    setFollowEnabled,
    toggleFollowEnabled,
    startFollowingBrowsingTabs,
    persistDetachedBounds,
  };
};

export { createDetachController };
