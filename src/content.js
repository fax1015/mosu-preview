// Content script for https://osu.ppy.sh/*.
//
// Runs as a classic MV3 script (no top-level ES imports). Does nothing on page
// load unless a fresh per-tab reload-resume snapshot exists in sessionStorage,
// or the toolbar popup asks it to mount the floating preview.
//
// The Shadow DOM host is appended directly to `document.documentElement`
// (`<html>`, outside `<body>`). osu-web uses Hotwire Turbo Drive, which swaps
// `document.body` via `document.body.replaceWith(...)` on in-site navigation,
// so keeping the host as a sibling of `<body>` leaves the iframe completely
// untouched across page switches.

(() => {
  if (globalThis.__mosuPreviewContentLoaded) {
    return;
  }
  globalThis.__mosuPreviewContentLoaded = true;

  const extensionApi = globalThis.browser ?? globalThis.chrome ?? null;
  if (!extensionApi?.runtime?.getURL) {
    return;
  }

  const HOST_ID = 'mosu-preview-embedded-host';
  const BOUNDS_KEY = 'mosuEmbeddedPlayerBoundsV1';
  const RESUME_KEY = 'mosuEmbeddedResumeV1';
  const EMBEDDED_SETTING_KEY = 'embeddedPlayer';
  const CHANNEL = 'mosu-preview-embedded-v1';
  const RESUME_MAX_AGE_MS = 60 * 1000;
  const RESUME_FUTURE_SKEW_MS = 5 * 1000;
  const MAX_RESUME_TIME_MS = 24 * 60 * 60 * 1000;

  const ASPECT_RATIO = 4 / 3;
  const CHROME_WIDTH = 26;
  const OUTER_BAR_AND_BORDER_HEIGHT = 30; // 28px bar + 2px shell border
  const DEFAULT_CHROME_HEIGHT = 132;
  const MIN_CHROME_HEIGHT = 80;
  const MAX_CHROME_HEIGHT = 240;

  let chromeHeight = DEFAULT_CHROME_HEIGHT;

  const heightForWidth = (width, ch = chromeHeight) => (
    Math.round(ch + (Math.max(0, width - CHROME_WIDTH) / ASPECT_RATIO))
  );

  const widthForHeight = (height, ch = chromeHeight) => (
    Math.round(CHROME_WIDTH + (Math.max(0, height - ch) * ASPECT_RATIO))
  );

  const DEFAULT_WIDTH = 440;
  const DEFAULT_BOUNDS = Object.freeze({
    width: DEFAULT_WIDTH,
    height: heightForWidth(DEFAULT_WIDTH, DEFAULT_CHROME_HEIGHT),
    right: 20,
    bottom: 72,
    collapsed: false,
  });

  const MIN_WIDTH = 340;
  const MAX_WIDTH = 1400;
  const COLLAPSED_HEIGHT = 112;
  const VIEWPORT_MARGIN = 8;

  const MODE_URL_NAMES = Object.freeze(['osu', 'taiko', 'fruits', 'mania']);
  const EXTENSION_ORIGIN_RE = /^(?:chrome|moz)-extension:\/\/[^/]+$/i;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const normalizeNumericId = (value) => {
    const text = String(value ?? '').trim();
    return /^\d+$/.test(text) && Number(text) > 0 ? text : '';
  };

  const normalizeMode = (value) => {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const raw = String(value).trim().toLowerCase();
    if (/^[0-3]$/.test(raw)) {
      return Number(raw);
    }
    if (raw === 'osu' || raw === 'standard') return 0;
    if (raw === 'taiko') return 1;
    if (raw === 'fruits' || raw === 'catch' || raw === 'ctb') return 2;
    if (raw === 'mania') return 3;
    return null;
  };

  const buildBeatmapSourceUrl = ({ beatmapId, setId, mode }) => {
    const safeBeatmapId = normalizeNumericId(beatmapId);
    if (!safeBeatmapId) {
      return '';
    }
    const safeSetId = normalizeNumericId(setId);
    const safeMode = normalizeMode(mode);
    if (safeSetId) {
      return safeMode === null
        ? `https://osu.ppy.sh/beatmapsets/${safeSetId}?b=${safeBeatmapId}`
        : `https://osu.ppy.sh/beatmapsets/${safeSetId}#${MODE_URL_NAMES[safeMode]}/${safeBeatmapId}`;
    }
    return safeMode === null
      ? `https://osu.ppy.sh/beatmaps/${safeBeatmapId}`
      : `https://osu.ppy.sh/beatmaps/${safeBeatmapId}?mode=${MODE_URL_NAMES[safeMode]}`;
  };

  const buildEmbeddedIframeUrl = ({
    beatmapId,
    setId,
    mode,
    resumeTimeMs,
    resumePaused,
    collapsed,
    followEnabled,
  }) => {
    const safeBeatmapId = normalizeNumericId(beatmapId);
    if (!safeBeatmapId) {
      return '';
    }
    const params = new URLSearchParams({
      embedded: '1',
      beatmapId: safeBeatmapId,
    });
    const safeSetId = normalizeNumericId(setId);
    if (safeSetId) {
      params.set('setId', safeSetId);
    }
    const safeMode = normalizeMode(mode);
    if (safeMode !== null) {
      params.set('mode', MODE_URL_NAMES[safeMode]);
    }
    if (Number.isFinite(resumeTimeMs) && resumeTimeMs >= 0 && resumeTimeMs <= MAX_RESUME_TIME_MS) {
      params.set('t', String(Math.round(resumeTimeMs)));
      if (resumePaused) {
        params.set('paused', '1');
      }
    }
    if (collapsed) {
      params.set('collapsed', '1');
    }
    if (followEnabled === false) {
      params.set('follow', '0');
    }
    const url = new URL(extensionApi.runtime.getURL('popup.html'));
    url.search = params.toString();
    return url.toString();
  };

  const getViewport = () => ({
    width: Math.max(200, window.innerWidth || document.documentElement?.clientWidth || 1280),
    height: Math.max(COLLAPSED_HEIGHT, window.innerHeight || document.documentElement?.clientHeight || 720),
  });

  const normalizeBounds = (raw = {}) => {
    const vp = getViewport();
    const collapsed = Boolean(raw?.collapsed);
    const maxViewportW = Math.max(200, Math.floor(vp.width - (VIEWPORT_MARGIN * 2)));
    const maxViewportH = Math.max(COLLAPSED_HEIGHT, Math.floor(vp.height - (VIEWPORT_MARGIN * 2)));
    const maxWByHeight = collapsed
      ? MAX_WIDTH
      : Math.max(200, Math.floor(CHROME_WIDTH + (Math.max(0, maxViewportH - chromeHeight) * ASPECT_RATIO)));
    const maxW = Math.max(200, Math.min(MAX_WIDTH, maxViewportW, maxWByHeight));
    const minW = Math.min(MIN_WIDTH, maxW);

    const width = Math.round(clamp(
      Number.isFinite(Number(raw?.width)) ? Number(raw.width) : DEFAULT_BOUNDS.width,
      minW,
      maxW,
    ));
    const height = heightForWidth(width);

    const effectiveHeight = collapsed ? Math.min(COLLAPSED_HEIGHT, maxViewportH) : height;
    const maxRight = Math.max(VIEWPORT_MARGIN, Math.floor(vp.width - width - VIEWPORT_MARGIN));
    const maxBottom = Math.max(VIEWPORT_MARGIN, Math.floor(vp.height - effectiveHeight - VIEWPORT_MARGIN));

    const right = Math.round(clamp(
      Number.isFinite(Number(raw?.right)) ? Number(raw.right) : DEFAULT_BOUNDS.right,
      VIEWPORT_MARGIN,
      maxRight,
    ));
    const bottom = Math.round(clamp(
      Number.isFinite(Number(raw?.bottom)) ? Number(raw.bottom) : DEFAULT_BOUNDS.bottom,
      VIEWPORT_MARGIN,
      maxBottom,
    ));

    return { width, height, right, bottom, collapsed };
  };

  const readStoredBounds = () => new Promise((resolve) => {
    const area = extensionApi?.storage?.local;
    if (!area?.get) {
      resolve(normalizeBounds(DEFAULT_BOUNDS));
      return;
    }
    try {
      if (globalThis.browser?.storage?.local?.get) {
        area.get([BOUNDS_KEY])
          .then((items) => resolve(normalizeBounds(items?.[BOUNDS_KEY] || DEFAULT_BOUNDS)))
          .catch(() => resolve(normalizeBounds(DEFAULT_BOUNDS)));
        return;
      }
      area.get([BOUNDS_KEY], (items) => {
        // Consume lastError so Chrome does not log an unchecked error.
        void extensionApi.runtime?.lastError;
        resolve(normalizeBounds(items?.[BOUNDS_KEY] || DEFAULT_BOUNDS));
      });
    } catch {
      resolve(normalizeBounds(DEFAULT_BOUNDS));
    }
  });

  const writeStoredBounds = (bounds) => {
    const area = extensionApi?.storage?.local;
    if (!area?.set) {
      return;
    }
    const payload = { [BOUNDS_KEY]: bounds };
    try {
      if (globalThis.browser?.storage?.local?.set) {
        void area.set(payload).catch(() => {});
        return;
      }
      area.set(payload, () => {
        void extensionApi.runtime?.lastError;
      });
    } catch {
      // Storage writes are best-effort.
    }
  };

  const readResumeSnapshot = () => {
    try {
      const rawText = window.sessionStorage.getItem(RESUME_KEY);
      if (!rawText) {
        return null;
      }
      const raw = JSON.parse(rawText);
      if (!raw || typeof raw !== 'object' || raw.version !== 1) {
        return null;
      }
      const beatmapId = normalizeNumericId(raw.beatmapId);
      const savedAt = Number(raw.savedAt);
      if (!beatmapId || !Number.isFinite(savedAt)) {
        return null;
      }
      const now = Date.now();
      const ageMs = now - savedAt;
      if (ageMs < -RESUME_FUTURE_SKEW_MS || ageMs > RESUME_MAX_AGE_MS) {
        window.sessionStorage.removeItem(RESUME_KEY);
        return null;
      }
      const baseTime = Number(raw.currentTimeMs);
      const safeBase = Number.isFinite(baseTime) && baseTime >= 0 ? baseTime : 0;
      const isPlaying = Boolean(raw.isPlaying);
      const speed = Number.isFinite(Number(raw.playbackSpeed)) && Number(raw.playbackSpeed) > 0 && Number(raw.playbackSpeed) <= 4
        ? Number(raw.playbackSpeed)
        : 1;
      const resumeTimeMs = Math.round(clamp(safeBase + (isPlaying ? Math.max(0, ageMs) * speed : 0), 0, MAX_RESUME_TIME_MS));
      return {
        beatmapId,
        setId: normalizeNumericId(raw.setId),
        mode: normalizeMode(raw.mode),
        resumeTimeMs,
        resumePaused: !isPlaying,
        followEnabled: raw.followEnabled !== false,
        collapsed: Boolean(raw.collapsed),
        sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : '',
      };
    } catch {
      return null;
    }
  };

  const writeResumeSnapshot = (snapshot) => {
    try {
      window.sessionStorage.setItem(RESUME_KEY, JSON.stringify(snapshot));
    } catch {
      // Private browsing / quota errors should not break playback.
    }
  };

  const clearResumeSnapshot = () => {
    try {
      window.sessionStorage.removeItem(RESUME_KEY);
    } catch {
      // Ignore storage errors on teardown.
    }
  };

  const getAllowedExtensionOrigins = () => {
    const origins = new Set();
    for (const path of ['', 'popup.html']) {
      try {
        const origin = new URL(extensionApi.runtime.getURL(path)).origin;
        if (origin && origin !== 'null') {
          origins.add(origin);
        }
      } catch {
        // Ignore malformed URLs.
      }
    }
    return origins;
  };

  let hostElement = null;
  let shellElement = null;
  let iframeElement = null;
  let collapseButton = null;
  let currentBounds = { ...DEFAULT_BOUNDS };
  let boundsPersistTimer = null;
  let iframeOrigin = null;
  let iframeReady = false;
  let pendingMessages = [];
  let lastNotifiedUrl = '';

  const scheduleBoundsPersist = () => {
    if (boundsPersistTimer !== null) {
      clearTimeout(boundsPersistTimer);
    }
    boundsPersistTimer = setTimeout(() => {
      boundsPersistTimer = null;
      writeStoredBounds(currentBounds);
    }, 350);
  };

  const postToIframe = (payload) => {
    if (!iframeElement?.contentWindow) {
      return;
    }
    if (!iframeReady || !iframeOrigin) {
      pendingMessages.push(payload);
      if (pendingMessages.length > 10) {
        pendingMessages = pendingMessages.slice(-10);
      }
      return;
    }
    try {
      iframeElement.contentWindow.postMessage({
        channel: CHANNEL,
        ...payload,
      }, iframeOrigin);
    } catch {
      // Iframe may be navigating or gone.
    }
  };

  const flushPendingMessages = () => {
    if (!iframeReady || !iframeOrigin || pendingMessages.length === 0) {
      return;
    }
    const queued = pendingMessages;
    pendingMessages = [];
    for (const payload of queued) {
      postToIframe(payload);
    }
  };

  const applyShellBounds = () => {
    if (!shellElement) {
      return;
    }
    currentBounds = normalizeBounds(currentBounds);
    const effectiveHeight = currentBounds.collapsed ? COLLAPSED_HEIGHT : currentBounds.height;
    shellElement.style.width = `${currentBounds.width}px`;
    shellElement.style.height = `${effectiveHeight}px`;
    shellElement.style.right = `${currentBounds.right}px`;
    shellElement.style.bottom = `${currentBounds.bottom}px`;
    shellElement.classList.toggle('is-collapsed', currentBounds.collapsed);
    if (collapseButton) {
      const label = currentBounds.collapsed ? 'Expand preview' : 'Collapse to mini-bar';
      collapseButton.title = label;
      collapseButton.setAttribute('aria-label', label);
      collapseButton.setAttribute('aria-expanded', currentBounds.collapsed ? 'false' : 'true');
    }
  };

  const setCollapsed = (nextCollapsed) => {
    const collapsed = Boolean(nextCollapsed);
    if (currentBounds.collapsed === collapsed) {
      return;
    }
    currentBounds = normalizeBounds({ ...currentBounds, collapsed });
    applyShellBounds();
    scheduleBoundsPersist();
    postToIframe({ type: 'collapsedChanged', collapsed });
  };

  const unmountOverlay = ({ clearResume = true } = {}) => {
    if (clearResume) {
      clearResumeSnapshot();
    }
    if (boundsPersistTimer !== null) {
      clearTimeout(boundsPersistTimer);
      boundsPersistTimer = null;
    }
    if (hostElement) {
      hostElement.remove();
    }
    hostElement = null;
    shellElement = null;
    iframeElement = null;
    collapseButton = null;
    iframeOrigin = null;
    iframeReady = false;
    pendingMessages = [];
    lastNotifiedUrl = '';
  };

  const notifyPageUrlChange = () => {
    if (!hostElement) {
      return;
    }
    // Safety net: ensure the host remains attached to <html> even if a script
    // altered the root element.
    if (hostElement.parentNode !== document.documentElement && document.documentElement) {
      document.documentElement.appendChild(hostElement);
    }
    const href = window.location.href;
    if (!href || href === lastNotifiedUrl) {
      return;
    }
    lastNotifiedUrl = href;
    postToIframe({ type: 'pageUrlChanged', url: href });
  };

  const SHELL_STYLES = `
    :host {
      all: initial;
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
    .mosu-shell {
      position: fixed;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.13);
      background: rgb(24, 23, 28);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.58), 0 0 0 1px rgba(0, 0, 0, 0.35);
      overflow: hidden;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #fff;
      user-select: none;
      touch-action: none;
    }
    .mosu-shell.is-interacting .mosu-frame {
      pointer-events: none;
    }
    .mosu-bar {
      flex: 0 0 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 6px 0 10px;
      background: linear-gradient(180deg, rgb(42, 40, 50) 0%, rgb(34, 32, 40) 100%);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      cursor: grab;
    }
    .mosu-shell.is-dragging .mosu-bar {
      cursor: grabbing;
    }
    .mosu-bar-left {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      pointer-events: none;
    }
    .mosu-grip {
      width: 10px;
      height: 10px;
      color: rgba(255, 255, 255, 0.38);
      flex: 0 0 auto;
    }
    .mosu-brand {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: rgba(255, 255, 255, 0.72);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mosu-bar-actions {
      display: flex;
      align-items: center;
      gap: 3px;
      flex: 0 0 auto;
    }
    .mosu-btn {
      appearance: none;
      border: none;
      background: transparent;
      color: rgba(255, 255, 255, 0.68);
      width: 22px;
      height: 20px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      transition: background 0.14s ease, color 0.14s ease;
    }
    .mosu-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }
    .mosu-btn--close:hover {
      background: rgba(214, 64, 64, 0.28);
      color: #ffd7d7;
    }
    .mosu-btn svg {
      width: 11px;
      height: 11px;
      fill: currentColor;
      display: block;
    }
    .mosu-shell.is-collapsed .mosu-collapse-icon {
      transform: rotate(180deg);
    }
    .mosu-collapse-icon {
      transition: transform 0.16s ease;
    }
    .mosu-body {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      background: rgb(36, 34, 42);
    }
    .mosu-frame {
      display: block;
      width: 100%;
      height: 100%;
      border: none;
      background: rgb(36, 34, 42);
    }
    .mosu-resize {
      position: absolute;
      z-index: 4;
    }
    .mosu-resize--n { top: 0; left: 10px; right: 10px; height: 5px; cursor: ns-resize; }
    .mosu-resize--s { bottom: 0; left: 10px; right: 10px; height: 5px; cursor: ns-resize; }
    .mosu-resize--w { left: 0; top: 10px; bottom: 10px; width: 5px; cursor: ew-resize; }
    .mosu-resize--e { right: 0; top: 10px; bottom: 10px; width: 5px; cursor: ew-resize; }
    .mosu-resize--nw { top: 0; left: 0; width: 11px; height: 11px; cursor: nwse-resize; }
    .mosu-resize--ne { top: 0; right: 0; width: 11px; height: 11px; cursor: nesw-resize; }
    .mosu-resize--sw { bottom: 0; left: 0; width: 11px; height: 11px; cursor: nesw-resize; }
    .mosu-resize--se { bottom: 0; right: 0; width: 11px; height: 11px; cursor: nwse-resize; }
    .mosu-shell.is-collapsed .mosu-resize--n,
    .mosu-shell.is-collapsed .mosu-resize--s,
    .mosu-shell.is-collapsed .mosu-resize--nw,
    .mosu-shell.is-collapsed .mosu-resize--ne,
    .mosu-shell.is-collapsed .mosu-resize--sw,
    .mosu-shell.is-collapsed .mosu-resize--se {
      display: none;
    }
  `;

  const bindDrag = (bar) => {
    let dragState = null;

    bar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) {
        return;
      }
      event.preventDefault();
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startBounds: { ...currentBounds },
      };
      shellElement?.classList.add('is-interacting', 'is-dragging');
      bar.setPointerCapture?.(event.pointerId);
    });

    bar.addEventListener('pointermove', (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      currentBounds = normalizeBounds({
        ...dragState.startBounds,
        right: dragState.startBounds.right - dx,
        bottom: dragState.startBounds.bottom - dy,
      });
      applyShellBounds();
    });

    const endDrag = (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      dragState = null;
      shellElement?.classList.remove('is-interacting', 'is-dragging');
      scheduleBoundsPersist();
    };

    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
    bar.addEventListener('dblclick', (event) => {
      if (event.target.closest('button')) {
        return;
      }
      setCollapsed(!currentBounds.collapsed);
    });
  };

  const bindResize = (handle, edge) => {
    let resizeState = null;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      resizeState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startBounds: { ...currentBounds },
      };
      shellElement?.classList.add('is-interacting');
      handle.setPointerCapture?.(event.pointerId);
    });

    handle.addEventListener('pointermove', (event) => {
      if (!resizeState || event.pointerId !== resizeState.pointerId) {
        return;
      }
      const dx = event.clientX - resizeState.startX;
      const dy = event.clientY - resizeState.startY;
      const base = resizeState.startBounds;
      const vp = getViewport();

      const hasW = edge.includes('w');
      const hasE = edge.includes('e');
      const hasN = !base.collapsed && edge.includes('n');
      const hasS = !base.collapsed && edge.includes('s');
      if (!hasW && !hasE && !hasN && !hasS) {
        return;
      }

      const maxViewportW = Math.max(200, Math.floor(vp.width - (VIEWPORT_MARGIN * 2)));
      const minW = Math.min(MIN_WIDTH, maxViewportW);

      const maxWByHoriz = hasE
        ? Math.floor(base.width + base.right - VIEWPORT_MARGIN)
        : Math.floor(vp.width - base.right - VIEWPORT_MARGIN);

      let maxWByVert = MAX_WIDTH;
      if (!base.collapsed) {
        const maxHAvail = hasS
          ? Math.floor(base.height + base.bottom - VIEWPORT_MARGIN)
          : Math.floor(vp.height - base.bottom - VIEWPORT_MARGIN);
        maxWByVert = Math.floor(CHROME_WIDTH + (Math.max(0, maxHAvail - chromeHeight) * ASPECT_RATIO));
      }

      const maxW = Math.max(minW, Math.min(MAX_WIDTH, maxWByHoriz, maxWByVert));

      let targetWidth = base.width;
      if ((hasW || hasE) && (hasN || hasS)) {
        const signedDx = hasW ? -dx : dx;
        const signedDy = hasN ? -dy : dy;
        targetWidth = Math.abs(signedDx) >= Math.abs(signedDy) * ASPECT_RATIO
          ? base.width + signedDx
          : widthForHeight(base.height + signedDy);
      } else if (hasW || hasE) {
        targetWidth = base.width + (hasW ? -dx : dx);
      } else {
        targetWidth = widthForHeight(base.height + (hasN ? -dy : dy));
      }

      const width = Math.round(clamp(targetWidth, minW, maxW));
      const height = heightForWidth(width);
      const right = hasE ? Math.round(base.right - (width - base.width)) : base.right;
      const bottom = hasS ? Math.round(base.bottom - (height - base.height)) : base.bottom;

      currentBounds = normalizeBounds({
        width,
        height,
        right,
        bottom,
        collapsed: base.collapsed,
      });
      applyShellBounds();
    });

    const endResize = (event) => {
      if (!resizeState || event.pointerId !== resizeState.pointerId) {
        return;
      }
      resizeState = null;
      shellElement?.classList.remove('is-interacting');
      scheduleBoundsPersist();
    };

    handle.addEventListener('pointerup', endResize);
    handle.addEventListener('pointercancel', endResize);
  };

  const mountOverlay = async (options) => {
    const storedBounds = await readStoredBounds();
    const initialCollapsed = typeof options.collapsed === 'boolean'
      ? options.collapsed
      : Boolean(storedBounds.collapsed);
    const iframeUrl = buildEmbeddedIframeUrl({
      beatmapId: options.beatmapId,
      setId: options.setId,
      mode: options.mode,
      resumeTimeMs: options.resumeTimeMs,
      resumePaused: options.resumePaused,
      collapsed: initialCollapsed,
      followEnabled: options.followEnabled !== false,
    });

    if (!iframeUrl) {
      return false;
    }

    // Reuse an already-mounted overlay without flickering the iframe if ready.
    if (hostElement && iframeElement) {
      if (options.expandOnOpen && currentBounds.collapsed) {
        setCollapsed(false);
      }
      const sourceUrl = buildBeatmapSourceUrl(options);
      if (iframeReady && sourceUrl) {
        postToIframe({
          type: 'loadBeatmap',
          sourceUrl,
          resumeTimeMs: options.resumeTimeMs,
          resumePaused: options.resumePaused,
        });
      } else {
        iframeReady = false;
        iframeElement.src = iframeUrl;
      }
      return true;
    }

    currentBounds = normalizeBounds({
      ...storedBounds,
      collapsed: options.expandOnOpen ? false : initialCollapsed,
    });

    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = SHELL_STYLES;
    shadow.appendChild(style);

    const shell = document.createElement('div');
    shell.className = 'mosu-shell';
    shell.setAttribute('role', 'region');
    shell.setAttribute('aria-label', 'mosu! beatmap preview');

    const bar = document.createElement('div');
    bar.className = 'mosu-bar';

    const barLeft = document.createElement('div');
    barLeft.className = 'mosu-bar-left';
    barLeft.innerHTML = `
      <svg class="mosu-grip" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="3" cy="3" r="1.2" fill="currentColor"></circle>
        <circle cx="9" cy="3" r="1.2" fill="currentColor"></circle>
        <circle cx="3" cy="9" r="1.2" fill="currentColor"></circle>
        <circle cx="9" cy="9" r="1.2" fill="currentColor"></circle>
      </svg>
      <span class="mosu-brand">mosu! preview</span>
    `;

    const actions = document.createElement('div');
    actions.className = 'mosu-bar-actions';

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'mosu-btn';
    collapseBtn.innerHTML = `
      <svg class="mosu-collapse-icon" viewBox="0 0 448 512" aria-hidden="true">
        <path d="M201.4 374.6c12.5 12.5 32.8 12.5 45.3 0l160-160c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 306.7 86.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l160 160z"></path>
      </svg>
    `;
    collapseBtn.addEventListener('click', () => {
      setCollapsed(!currentBounds.collapsed);
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'mosu-btn mosu-btn--close';
    closeBtn.title = 'Close preview';
    closeBtn.setAttribute('aria-label', 'Close preview');
    closeBtn.innerHTML = `
      <svg viewBox="0 0 384 512" aria-hidden="true">
        <path d="M342.6 150.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192 210.7 86.6 105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L146.7 256 41.4 361.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 301.3 297.4 406.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.3 256 342.6 150.6z"></path>
      </svg>
    `;
    closeBtn.addEventListener('click', () => {
      unmountOverlay({ clearResume: true });
    });

    actions.appendChild(collapseBtn);
    actions.appendChild(closeBtn);
    bar.appendChild(barLeft);
    bar.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'mosu-body';

    const iframe = document.createElement('iframe');
    iframe.className = 'mosu-frame';
    iframe.setAttribute('title', 'mosu! Beatmap Preview');
    iframe.setAttribute('allow', 'autoplay; clipboard-write');
    iframe.src = iframeUrl;
    body.appendChild(iframe);

    shell.appendChild(bar);
    shell.appendChild(body);

    for (const edge of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
      const handle = document.createElement('div');
      handle.className = `mosu-resize mosu-resize--${edge}`;
      bindResize(handle, edge);
      shell.appendChild(handle);
    }

    shadow.appendChild(shell);

    hostElement = host;
    shellElement = shell;
    iframeElement = iframe;
    collapseButton = collapseBtn;
    iframeOrigin = null;
    iframeReady = false;
    pendingMessages = [];
    lastNotifiedUrl = window.location.href;

    bindDrag(bar);
    applyShellBounds();

    // Mounted on <html> rather than <body> so Hotwire Turbo Drive body swaps
    // leave the iframe attached and uninterrupted.
    (document.documentElement || document.body).appendChild(host);
    return true;
  };

  window.addEventListener('message', (event) => {
    if (!iframeElement?.contentWindow || event.source !== iframeElement.contentWindow) {
      return;
    }
    const allowedOrigins = getAllowedExtensionOrigins();
    if (!allowedOrigins.has(event.origin) && !EXTENSION_ORIGIN_RE.test(event.origin)) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== 'object' || data.channel !== CHANNEL) {
      return;
    }

    if (data.type === 'ready') {
      iframeOrigin = event.origin;
      iframeReady = true;
      flushPendingMessages();
      return;
    }

    if (data.type === 'playbackSnapshot' && data.snapshot && typeof data.snapshot === 'object') {
      writeResumeSnapshot({
        ...data.snapshot,
        collapsed: currentBounds.collapsed,
      });
      return;
    }

    if (data.type === 'requestExpand') {
      setCollapsed(false);
      return;
    }

    if (data.type === 'chromeMetrics') {
      const innerHeight = Number(data.innerChromeHeight);
      if (Number.isFinite(innerHeight) && innerHeight > 0) {
        const nextChrome = Math.round(clamp(
          innerHeight + OUTER_BAR_AND_BORDER_HEIGHT,
          MIN_CHROME_HEIGHT,
          MAX_CHROME_HEIGHT,
        ));
        if (nextChrome !== chromeHeight) {
          chromeHeight = nextChrome;
          applyShellBounds();
        }
      }
      return;
    }

    if (data.type === 'requestClose') {
      unmountOverlay({ clearResume: true });
    }
  });

  // Hotwire Turbo Drive + in-page difficulty hash / history listeners.
  document.addEventListener('turbo:load', notifyPageUrlChange);
  document.addEventListener('turbo:render', notifyPageUrlChange);
  window.addEventListener('hashchange', notifyPageUrlChange);
  window.addEventListener('popstate', notifyPageUrlChange);
  window.addEventListener('resize', () => {
    if (shellElement) {
      applyShellBounds();
    }
  });

  const safeSendResponse = (sendResponse, payload) => {
    try {
      sendResponse(payload);
    } catch {
      // Message channel already closed; ignore.
    }
  };

  extensionApi.runtime.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') {
      return false;
    }
    if (message.type === 'mosuEmbeddedOpen') {
      Promise.resolve()
        .then(() => mountOverlay({
          beatmapId: message.beatmapId,
          setId: message.setId,
          mode: message.mode,
          resumeTimeMs: message.resumeTimeMs,
          resumePaused: message.resumePaused,
          expandOnOpen: true,
        }))
        .then(
          (ok) => safeSendResponse(sendResponse, { ok }),
          (error) => safeSendResponse(sendResponse, { ok: false, error: error?.message || String(error) }),
        );
      return true;
    }
    if (message.type === 'mosuEmbeddedClose') {
      const wasOpen = Boolean(hostElement);
      unmountOverlay({ clearResume: true });
      safeSendResponse(sendResponse, { ok: true, closed: wasOpen });
      return false;
    }
    return false;
  });

  const readEmbeddedSettingEnabled = () => new Promise((resolve) => {
    const area = extensionApi?.storage?.sync;
    if (!area?.get) {
      resolve(false);
      return;
    }
    const isTruthy = (v) => v === true || v === 'true' || v === 1 || v === '1';
    try {
      if (globalThis.browser?.storage?.sync?.get) {
        area.get([EMBEDDED_SETTING_KEY])
          .then((items) => resolve(isTruthy(items?.[EMBEDDED_SETTING_KEY])))
          .catch(() => resolve(false));
        return;
      }
      area.get([EMBEDDED_SETTING_KEY], (items) => {
        void extensionApi.runtime?.lastError;
        resolve(isTruthy(items?.[EMBEDDED_SETTING_KEY]));
      });
    } catch {
      resolve(false);
    }
  });

  extensionApi.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== 'sync' || !changes || !Object.hasOwn(changes, EMBEDDED_SETTING_KEY)) {
      return;
    }
    const nextValue = changes[EMBEDDED_SETTING_KEY]?.newValue;
    const enabled = nextValue === true || nextValue === 'true' || nextValue === 1 || nextValue === '1';
    if (!enabled) {
      unmountOverlay({ clearResume: true });
    }
  });

  // Best-effort restore after a hard reload (F5 / Ctrl+R) on the same tab,
  // only when the experimental setting is currently enabled.
  const resumeSnapshot = readResumeSnapshot();
  if (resumeSnapshot) {
    void readEmbeddedSettingEnabled().then((enabled) => {
      if (!enabled) {
        clearResumeSnapshot();
        return;
      }
      void mountOverlay({
        beatmapId: resumeSnapshot.beatmapId,
        setId: resumeSnapshot.setId,
        mode: resumeSnapshot.mode,
        resumeTimeMs: resumeSnapshot.resumeTimeMs,
        resumePaused: resumeSnapshot.resumePaused,
        collapsed: resumeSnapshot.collapsed,
        followEnabled: resumeSnapshot.followEnabled,
      });
    });
  }
})();
