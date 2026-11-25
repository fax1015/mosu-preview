// Content script for https://osu.ppy.sh/*.
//
// Runs as a classic MV3 script (no top-level ES imports). Does nothing on page
// load unless a fresh per-tab reload-resume snapshot exists in sessionStorage,
// or the toolbar popup asks it to mount the floating preview.
//
// The page's own scripts share this window, its sessionStorage and its message
// events, so nothing they can reach is trusted on its own: the shadow root is
// closed, messages into the iframe carry a per-mount secret the iframe was
// handed through extension messaging (which the page cannot see), and the
// reload snapshot is signed with a key kept in extension storage.
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
  // Extension messaging, not postMessage: how the iframe is handed the secret
  // that every message to it then carries (see shareHostToken).
  const HOST_TOKEN_MESSAGE = 'mosuEmbeddedHostToken';
  // Each try waits this long first; the iframe is listening before it says it
  // is ready, so the first try is all it normally takes.
  const HOST_TOKEN_RETRY_DELAYS_MS = Object.freeze([0, 250, 1000]);
  // In storage.local, out of the page's reach: what reload snapshots are signed
  // with, so one the page wrote into sessionStorage itself is not acted on.
  const RESUME_SIGNING_KEY = 'mosuEmbeddedResumeKeyV1';
  const RESUME_SIGNING_KEY_BYTES = 32;
  const RESUME_MAX_AGE_MS = 60 * 1000;
  const RESUME_FUTURE_SKEW_MS = 5 * 1000;
  const MAX_RESUME_TIME_MS = 24 * 60 * 60 * 1000;

  const ASPECT_RATIO = 4 / 3;
  const CHROME_WIDTH = 26;
  const OUTER_BAR_AND_BORDER_HEIGHT = 34; // 32px bar + 2px shell border
  const DEFAULT_CHROME_HEIGHT = 136;
  const MIN_CHROME_HEIGHT = 80;
  const MAX_CHROME_HEIGHT = 240;

  let chromeHeight = DEFAULT_CHROME_HEIGHT;
  let fontsLoaded = false;

  const ensureTopBarFonts = () => {
    if (fontsLoaded || typeof globalThis.FontFace !== 'function' || !document.fonts?.add) {
      return;
    }
    fontsLoaded = true;
    const faces = [
      { file: 'assets/fonts/Torus-SemiBold.otf', weight: '600' },
      { file: 'assets/fonts/Torus-Bold.otf', weight: '700' },
    ];
    for (const { file, weight } of faces) {
      try {
        const fontUrl = extensionApi.runtime.getURL(file);
        const face = new globalThis.FontFace('MosuTorus', `url("${fontUrl}")`, { weight, style: 'normal' });
        document.fonts.add(face);
        void face.load().catch(() => {});
      } catch {
        // Fallback to site Torus / sans-serif if FontFace fails.
      }
    }
  };

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
  // The collapsed bar's 154px page plus the shell's 1px border top and bottom
  // (see "Collapsed in-page miniplayer" in popup.css).
  const COLLAPSED_HEIGHT = 156;
  // Material 3's emphasized easing: quick to start and soft to land, kept
  // short so collapsing and expanding snap. The page inside fades through
  // from one layout to the other in the same time (src/ui/miniMorph.js: 70ms
  // out, 190ms in).
  const CONTAINER_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
  const CONTAINER_EASING_MS = 260;
  // The bar's buttons changing shape.
  const SHAPE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
  const SHAPE_EASING_MS = 220;
  // Closing: the window sinks a little, shrinks a touch and fades, all on one
  // short clock. The movement eases to a soft stop just as the fade reaches
  // nothing, so the window is never left sitting still and half there. It is
  // removed once gone.
  const CLOSE_MS = 100;
  const CLOSE_MOVE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
  const CLOSE_FADE_EASING = 'linear';
  const CLOSE_TRANSFORM = 'translateY(4px) scale(0.97)';
  // How long a collapse or expand is left to run before the shell stops
  // animating its size: the easing, and a little slack.
  const COLLAPSE_ANIMATION_MS = CONTAINER_EASING_MS + 60;
  const VIEWPORT_MARGIN = 8;

  const MODE_URL_NAMES = Object.freeze(['osu', 'taiko', 'fruits', 'mania']);

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  const fromHex = (text) => {
    if (typeof text !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(text)) {
      return null;
    }
    const bytes = new Uint8Array(text.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(text.slice(index * 2, (index * 2) + 2), 16);
    }
    return bytes;
  };

  const randomHex = (byteCount) => toHex(globalThis.crypto.getRandomValues(new Uint8Array(byteCount)));

  const wait = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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

  const normalizeOsuSourceUrl = (value) => {
    const candidate = String(value ?? '').trim();
    if (!candidate) {
      return '';
    }
    try {
      const url = new URL(candidate);
      return url.origin === 'https://osu.ppy.sh' && !url.username && !url.password
        ? url.toString()
        : '';
    } catch {
      return '';
    }
  };

  const buildBeatmapSourceUrl = ({ beatmapId, setId, mode, sourceUrl }) => {
    const safeBeatmapId = normalizeNumericId(beatmapId);
    if (!safeBeatmapId) {
      return normalizeOsuSourceUrl(sourceUrl);
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
    sourceUrl,
    mountId,
  }) => {
    const safeBeatmapId = normalizeNumericId(beatmapId);
    const safeSourceUrl = normalizeOsuSourceUrl(sourceUrl);
    if (!safeBeatmapId && !safeSourceUrl) {
      return '';
    }
    const params = new URLSearchParams({ embedded: '1' });
    if (safeBeatmapId) {
      params.set('beatmapId', safeBeatmapId);
    } else {
      params.set('sourceUrl', safeSourceUrl);
    }
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
    // Which shell the iframe belongs to, so it takes its secret from this one
    // (shareHostToken). Not a secret itself.
    if (typeof mountId === 'string' && /^[0-9a-f]{32}$/.test(mountId)) {
      params.set('mount', mountId);
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

  // The shell is placed by its bottom edge, so a change of height keeps that
  // edge and moves the top. In the top half of the screen that would pull the
  // window away from where it was put, so there it keeps its top edge instead
  // and grows or folds from that: the bottom it needs for that.
  const bottomForHeightChange = (bottom, fromHeight, toHeight) => {
    const viewportHeight = getViewport().height;
    const top = viewportHeight - bottom - fromHeight;
    const isUpperHalf = top + (fromHeight / 2) < viewportHeight / 2;
    return isUpperHalf ? bottom + (fromHeight - toHeight) : bottom;
  };

  // The bounds after collapsing or expanding. Up top, the bar folds up towards
  // its top edge, which also leaves the collapse button where it was clicked.
  // A round trip comes back to the same place: whichever edge stays put, the
  // bar ends up further into the same half.
  const boundsForCollapsed = (bounds, collapsed) => {
    const from = normalizeBounds(bounds);
    const next = Boolean(collapsed);
    if (from.collapsed === next) {
      return from;
    }
    const fromHeight = from.collapsed ? COLLAPSED_HEIGHT : from.height;
    const toHeight = next ? COLLAPSED_HEIGHT : from.height;
    return normalizeBounds({
      ...from,
      collapsed: next,
      bottom: bottomForHeightChange(from.bottom, fromHeight, toHeight),
    });
  };

  // One stored value, in either browser's style of the API. Never rejects: a
  // value that cannot be read is undefined.
  const storageGet = (areaName, key) => new Promise((resolve) => {
    const area = extensionApi?.storage?.[areaName];
    if (!area?.get) {
      resolve(undefined);
      return;
    }
    try {
      if (globalThis.browser?.storage?.[areaName]?.get) {
        area.get([key]).then((items) => resolve(items?.[key]), () => resolve(undefined));
        return;
      }
      area.get([key], (items) => {
        // Consume lastError so Chrome does not log an unchecked error.
        void extensionApi.runtime?.lastError;
        resolve(items?.[key]);
      });
    } catch {
      resolve(undefined);
    }
  });

  // Best-effort; resolves whether it was written.
  const storageSet = (areaName, items) => new Promise((resolve) => {
    const area = extensionApi?.storage?.[areaName];
    if (!area?.set) {
      resolve(false);
      return;
    }
    try {
      if (globalThis.browser?.storage?.[areaName]?.set) {
        area.set(items).then(() => resolve(true), () => resolve(false));
        return;
      }
      area.set(items, () => {
        resolve(!extensionApi.runtime?.lastError);
      });
    } catch {
      resolve(false);
    }
  });

  const sendRuntimeMessage = (message) => new Promise((resolve) => {
    const runtime = extensionApi.runtime;
    if (typeof runtime?.sendMessage !== 'function') {
      resolve(null);
      return;
    }
    try {
      if (globalThis.browser?.runtime?.sendMessage) {
        runtime.sendMessage(message).then((response) => resolve(response ?? null), () => resolve(null));
        return;
      }
      runtime.sendMessage(message, (response) => {
        void extensionApi.runtime?.lastError;
        resolve(response ?? null);
      });
    } catch {
      resolve(null);
    }
  });

  const readStoredBounds = async () => normalizeBounds((await storageGet('local', BOUNDS_KEY)) || DEFAULT_BOUNDS);

  const writeStoredBounds = (bounds) => {
    void storageSet('local', { [BOUNDS_KEY]: bounds });
  };

  // The key reload snapshots are signed with, made the first time one is
  // written. A failed or missing read is not cached, so the next try reads
  // again.
  let resumeKeyPromise = null;

  const loadResumeKey = async ({ create }) => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      return null;
    }
    let raw = fromHex(await storageGet('local', RESUME_SIGNING_KEY));
    if (raw?.length !== RESUME_SIGNING_KEY_BYTES) {
      if (!create) {
        return null;
      }
      const made = randomHex(RESUME_SIGNING_KEY_BYTES);
      if (!(await storageSet('local', { [RESUME_SIGNING_KEY]: made }))) {
        return null;
      }
      // Another osu! tab may have made one at the same moment: use whichever
      // was kept, so both tabs sign with it.
      raw = fromHex(await storageGet('local', RESUME_SIGNING_KEY)) || fromHex(made);
    }
    return subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  };

  const getResumeKey = ({ create = false } = {}) => {
    if (!resumeKeyPromise) {
      const pending = loadResumeKey({ create }).catch(() => null);
      resumeKeyPromise = pending;
      void pending.then((key) => {
        if (!key && resumeKeyPromise === pending) {
          resumeKeyPromise = null;
        }
      });
    }
    return resumeKeyPromise;
  };

  // The snapshot, if this script wrote it: its signature must check out
  // against the key only the extension can read.
  const readSignedResumeText = async () => {
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(RESUME_KEY) || 'null');
      const mac = fromHex(stored?.mac);
      if (typeof stored?.body !== 'string' || !mac) {
        return null;
      }
      const key = await getResumeKey();
      if (!key) {
        return null;
      }
      const genuine = await globalThis.crypto.subtle.verify('HMAC', key, mac, new TextEncoder().encode(stored.body));
      return genuine ? stored.body : null;
    } catch {
      return null;
    }
  };

  const readResumeSnapshot = async () => {
    try {
      // One that does not check out is left where it is, ignored: clearing it
      // here could take a fresh one written meanwhile with it.
      const rawText = await readSignedResumeText();
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

  // Signing takes a moment; a snapshot overtaken by a newer one (or by a
  // clear) while it is signed is dropped rather than written over it.
  let resumeWriteSeq = 0;

  const writeResumeSnapshot = (snapshot) => {
    resumeWriteSeq += 1;
    const seq = resumeWriteSeq;
    const body = JSON.stringify(snapshot);
    void (async () => {
      const key = await getResumeKey({ create: true });
      if (!key || seq !== resumeWriteSeq) {
        return;
      }
      const signature = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
      if (seq !== resumeWriteSeq) {
        return;
      }
      window.sessionStorage.setItem(RESUME_KEY, JSON.stringify({ body, mac: toHex(new Uint8Array(signature)) }));
    })().catch(() => {
      // Private browsing / quota errors should not break playback.
    });
  };

  const clearResumeSnapshot = () => {
    resumeWriteSeq += 1;
    try {
      window.sessionStorage.removeItem(RESUME_KEY);
    } catch {
      // Ignore storage errors on teardown.
    }
  };

  // Only this extension's own origin may speak for the iframe. Read off the
  // base URL as text as well: a URL parser may call a non-web scheme's origin
  // "null".
  const ALLOWED_EXTENSION_ORIGINS = (() => {
    const origins = new Set();
    try {
      const base = String(extensionApi.runtime.getURL('') || '');
      const match = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)\/?$/i.exec(base);
      if (match) {
        origins.add(match[1]);
      }
      const parsed = new URL(base).origin;
      if (parsed && parsed !== 'null') {
        origins.add(parsed);
      }
    } catch {
      // Ignore malformed URLs.
    }
    return origins;
  })();

  let hostElement = null;
  let shellElement = null;
  let iframeElement = null;
  let collapseButton = null;
  let currentBounds = { ...DEFAULT_BOUNDS };
  let boundsPersistTimer = null;
  let collapseTransitionTimer = null;
  let iframeOrigin = null;
  let iframeReady = false;
  let pendingMessages = [];
  let lastNotifiedUrl = '';
  let mountGeneration = 0;
  // The mounted shell's id (in the iframe's URL) and secret (never in it).
  let hostMount = null;

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
    if (!iframeElement?.contentWindow || !hostMount) {
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
        ...payload,
        channel: CHANNEL,
        token: hostMount.token,
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

  // Hands the iframe this shell's secret through extension messaging, which
  // the page cannot see or forge, then lets the queued messages go. The page
  // can post to the iframe too (it learns the iframe's window from any message
  // the iframe posts up), so the iframe takes only messages that carry it.
  const shareHostToken = async (frame) => {
    const mount = hostMount;
    if (!mount) {
      return;
    }
    const isCurrent = () => iframeElement === frame && hostMount === mount;
    for (const delay of HOST_TOKEN_RETRY_DELAYS_MS) {
      if (delay > 0) {
        await wait(delay);
      }
      if (!isCurrent()) {
        return;
      }
      const response = await sendRuntimeMessage({ type: HOST_TOKEN_MESSAGE, mount: mount.id, token: mount.token });
      if (!isCurrent()) {
        return;
      }
      if (response?.ok === true) {
        iframeReady = true;
        flushPendingMessages();
        return;
      }
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

  const clearCollapseAnimation = () => {
    if (collapseTransitionTimer !== null) {
      clearTimeout(collapseTransitionTimer);
      collapseTransitionTimer = null;
    }
    shellElement?.classList.remove('is-collapse-animating');
  };

  const setCollapsed = (nextCollapsed) => {
    const collapsed = Boolean(nextCollapsed);
    if (currentBounds.collapsed === collapsed) {
      return;
    }
    clearCollapseAnimation();
    shellElement?.classList.add('is-collapse-animating');
    currentBounds = boundsForCollapsed(currentBounds, collapsed);
    applyShellBounds();
    scheduleBoundsPersist();
    postToIframe({ type: 'collapsedChanged', collapsed });
    collapseTransitionTimer = setTimeout(() => {
      collapseTransitionTimer = null;
      shellElement?.classList.remove('is-collapse-animating');
    }, COLLAPSE_ANIMATION_MS);
  };

  // The colours the miniplayer's page took from the cover art, for the top
  // row this shell draws over it while collapsed. Checked to be plain rgb()
  // and rgba() values before they go anywhere near a style.
  const SHELL_PALETTE_PROPERTIES = Object.freeze({
    surface: '--mosu-surface',
    chromeForeground: '--mosu-chrome-fg',
    chromeButton: '--mosu-chrome-button',
  });
  const SAFE_COLOUR_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d{1,3})\s*)?\)$/;

  const applyShellPalette = (palette) => {
    const style = shellElement?.style;
    if (!style || typeof style.setProperty !== 'function' || !palette || typeof palette !== 'object') {
      return;
    }
    for (const [key, property] of Object.entries(SHELL_PALETTE_PROPERTIES)) {
      const value = palette[key];
      if (typeof value === 'string' && SAFE_COLOUR_RE.test(value)) {
        style.setProperty(property, value);
      }
    }
  };

  const prefersReducedMotion = () => Boolean(
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
  );

  // Plays the closing animation on a shell that has already been let go of,
  // then removes it. Everything else about the overlay is reset at once, so a
  // preview opened again straight away mounts fresh beside the one leaving.
  const animateHostOut = (host, shell) => {
    if (typeof shell?.animate !== 'function' || prefersReducedMotion()) {
      host.remove();
      return;
    }
    // Out of the way of the page, and of any getElementById for a new one.
    host.removeAttribute?.('id');
    shell.style.pointerEvents = 'none';
    shell.style.transformOrigin = '50% 100%';
    let removed = false;
    const remove = () => {
      if (!removed) {
        removed = true;
        host.remove();
      }
    };
    shell.animate(
      [{ transform: 'none' }, { transform: CLOSE_TRANSFORM }],
      { duration: CLOSE_MS, easing: CLOSE_MOVE_EASING, fill: 'forwards' },
    );
    const fade = shell.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: CLOSE_MS, easing: CLOSE_FADE_EASING, fill: 'forwards' },
    );
    fade.finished?.then(remove, remove);
    // A page that stops drawing (a background tab) may never finish it.
    setTimeout(remove, CLOSE_MS + 250);
  };

  /**
   * Takes the overlay down. `animate` plays the closing animation (the user
   * closing it, or something asking it to close); without it the overlay just
   * goes.
   */
  const unmountOverlay = ({ clearResume = true, animate = false } = {}) => {
    mountGeneration += 1;
    clearCollapseAnimation();
    if (clearResume) {
      clearResumeSnapshot();
    }
    if (boundsPersistTimer !== null) {
      clearTimeout(boundsPersistTimer);
      boundsPersistTimer = null;
    }
    if (hostElement) {
      if (animate) {
        // Silence it now rather than when the window is finally removed.
        postToIframe({ type: 'closing' });
        animateHostOut(hostElement, shellElement);
      } else {
        hostElement.remove();
      }
    }
    hostElement = null;
    shellElement = null;
    iframeElement = null;
    collapseButton = null;
    iframeOrigin = null;
    iframeReady = false;
    pendingMessages = [];
    lastNotifiedUrl = '';
    hostMount = null;
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
      /* Matches Firefox's 24px extension popup window radius (see popup.css). */
      border-radius: 24px;
      border: 1px solid rgba(255, 255, 255, 0.11);
      /* The cover-art colours the page took, for the collapsed top row
         (applyShellPalette). Until one arrives, the page's own defaults. */
      --mosu-surface: rgb(36, 34, 42);
      --mosu-chrome-fg: rgb(188, 183, 206);
      --mosu-chrome-button: rgba(241, 239, 248, 0.07);
      background: rgb(36, 34, 42);
      box-shadow: 0 20px 52px rgba(0, 0, 0, 0.56), 0 0 0 1px rgba(0, 0, 0, 0.34);
      transition: background-color 700ms ease;
      overflow: hidden;
      font-family: 'MosuTorus', 'Torus', sans-serif;
      -webkit-font-smoothing: antialiased;
      color: #fff;
      user-select: none;
      touch-action: none;
    }
    .mosu-shell.is-collapsed {
      background: var(--mosu-surface);
    }
    /* Resizes on the emphasized curve, both ways: the expanded view can be
       narrower than the bar when the window is short (normalizeBounds), so
       the width and the right edge move too. */
    .mosu-shell.is-collapse-animating:not(.is-interacting) {
      transition: width ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING},
                  height ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING},
                  right ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING},
                  bottom ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING},
                  background-color 700ms ease;
    }
    .mosu-shell.is-interacting .mosu-frame {
      pointer-events: none;
    }
    .mosu-bar {
      position: relative;
      z-index: 6;
      flex: 0 0 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 0 0 16px;
      background: rgba(24, 23, 28, 0.72);
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    }
    .mosu-bar-left {
      display: flex;
      align-items: center;
      min-width: 0;
      pointer-events: none;
    }
    .mosu-brand {
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 700;
      letter-spacing: 0.015em;
      line-height: 1;
      color: rgba(255, 255, 255, 0.8);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mosu-drag-handle {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      z-index: 5;
      height: 22px;
      padding: 0 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
    }
    .mosu-shell.is-dragging .mosu-drag-handle {
      cursor: grabbing;
    }
    .mosu-drag-pill {
      display: block;
      width: 30px;
      height: 3px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.16);
      pointer-events: none;
      transition: background 0.16s ease, width 0.16s cubic-bezier(0.32, 0.72, 0, 1);
    }
    .mosu-drag-handle:hover .mosu-drag-pill {
      background: rgba(255, 255, 255, 0.32);
      width: 36px;
    }
    .mosu-shell.is-dragging .mosu-drag-pill {
      background: rgba(140, 102, 255, 0.78);
      width: 40px;
    }
    .mosu-bar-actions {
      position: relative;
      z-index: 5;
      height: 100%;
      display: flex;
      align-items: stretch;
      gap: 0;
      flex: 0 0 auto;
    }
    .mosu-btn {
      appearance: none;
      border: none;
      background: transparent;
      color: rgb(148, 143, 163);
      width: 34px;
      height: 100%;
      border-radius: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      transition: background 0.16s ease, color 0.16s ease;
    }
    .mosu-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
    }
    .mosu-btn:active {
      background: rgba(255, 255, 255, 0.12);
    }
    .mosu-btn:focus-visible {
      outline: 2px solid rgba(205, 223, 255, 0.9);
      outline-offset: -2px;
    }
    /* Matches the outer shell's 24px corner radius (minus 1px border). */
    .mosu-btn--close {
      width: 42px;
      padding-right: 4px;
      border-radius: 0 23px 0 0;
    }
    .mosu-btn--close:hover {
      background: rgba(214, 64, 64, 0.28);
      color: #ffd7d7;
    }
    .mosu-btn--close:active {
      background: rgba(214, 64, 64, 0.38);
    }
    .mosu-btn svg {
      width: 10px;
      height: 10px;
      fill: currentColor;
      display: block;
    }
    .mosu-shell.is-collapsed .mosu-collapse-icon {
      transform: rotate(180deg);
    }
    .mosu-collapse-icon {
      transition: transform 240ms cubic-bezier(0.32, 0.72, 0, 1);
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
    .mosu-resize--n { top: 0; left: 16px; right: 16px; height: 5px; cursor: ns-resize; }
    .mosu-resize--s { bottom: 0; left: 16px; right: 16px; height: 5px; cursor: ns-resize; }
    .mosu-resize--w { left: 0; top: 16px; bottom: 16px; width: 5px; cursor: ew-resize; }
    .mosu-resize--e { right: 0; top: 16px; bottom: 16px; width: 5px; cursor: ew-resize; }
    .mosu-resize--nw { top: 0; left: 0; width: 14px; height: 14px; cursor: nwse-resize; }
    .mosu-resize--ne { top: 0; right: 0; width: 14px; height: 14px; cursor: nesw-resize; }
    .mosu-resize--sw { bottom: 0; left: 0; width: 14px; height: 14px; cursor: nesw-resize; }
    .mosu-resize--se { bottom: 0; right: 0; width: 14px; height: 14px; cursor: nwse-resize; }
    .mosu-shell.is-collapsed .mosu-resize--n,
    .mosu-shell.is-collapsed .mosu-resize--s,
    .mosu-shell.is-collapsed .mosu-resize--nw,
    .mosu-shell.is-collapsed .mosu-resize--ne,
    .mosu-shell.is-collapsed .mosu-resize--sw,
    .mosu-shell.is-collapsed .mosu-resize--se {
      display: none;
    }

    /* Collapsed, the bar stops being a strip of its own and becomes the top
       row of the miniplayer's page, drawn over it: see-through, so the
       cover's colours run up behind it, with the brand, the drag handle and
       two round buttons laid on the page's 16px margins (popup.css,
       "Collapsed in-page miniplayer"). The bar overlaps the page by its own
       height, and every step of the change moves along with the window. */
    .mosu-bar {
      transition: flex-basis ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING},
                  height ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING},
                  margin-bottom ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING},
                  padding ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING},
                  background-color 260ms ease,
                  border-color 260ms ease;
    }
    .mosu-shell.is-collapsed .mosu-bar {
      flex-basis: 42px;
      height: 42px;
      margin-bottom: -42px;
      padding: 0 16px;
      background-color: transparent;
      border-bottom-color: transparent;
    }
    .mosu-brand {
      transition: color 300ms ease, font-size ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING};
    }
    .mosu-shell.is-collapsed .mosu-brand {
      font-size: 11px;
      color: color-mix(in srgb, var(--mosu-chrome-fg) 85%, transparent);
      text-shadow: 0 1px 8px rgba(0, 0, 0, 0.45);
    }
    .mosu-bar-actions {
      transition: height ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING},
                  gap ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING};
    }
    .mosu-shell.is-collapsed .mosu-bar-actions {
      height: 22px;
      align-items: center;
      gap: 4px;
    }
    .mosu-btn {
      transition: background-color 0.16s ease,
                  color 0.16s ease,
                  width ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING},
                  height ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING},
                  padding ${CONTAINER_EASING_MS}ms ${CONTAINER_EASING},
                  border-radius ${SHAPE_EASING_MS}ms ${SHAPE_EASING},
                  transform ${SHAPE_EASING_MS}ms ${SHAPE_EASING};
    }
    .mosu-shell.is-collapsed .mosu-btn {
      width: 22px;
      height: 22px;
      padding: 0;
      border-radius: 11px;
      background-color: var(--mosu-chrome-button);
      color: var(--mosu-chrome-fg);
    }
    .mosu-shell.is-collapsed .mosu-btn:hover {
      background-color: rgba(255, 255, 255, 0.16);
      color: #fff;
    }
    .mosu-shell.is-collapsed .mosu-btn--close:hover {
      background-color: rgba(214, 64, 64, 0.4);
      color: #ffd7d7;
    }
    /* Pressed, a round button squares up and dips a little. */
    .mosu-shell.is-collapsed .mosu-btn:active {
      border-radius: 7px;
      transform: scale(0.88);
    }
    .mosu-shell.is-collapsed .mosu-btn:focus-visible {
      outline-offset: 2px;
    }
    .mosu-collapse-icon {
      transition: transform ${SHAPE_EASING_MS}ms ${SHAPE_EASING};
    }
    .mosu-drag-pill {
      transition: background-color 0.16s ease,
                  width ${SHAPE_EASING_MS}ms ${SHAPE_EASING},
                  height ${SHAPE_EASING_MS}ms ${SHAPE_EASING};
    }
    .mosu-shell.is-collapsed .mosu-drag-pill {
      width: 32px;
      height: 4px;
      background-color: color-mix(in srgb, var(--mosu-chrome-fg) 40%, transparent);
    }
    .mosu-shell.is-collapsed .mosu-drag-handle:hover .mosu-drag-pill {
      width: 40px;
      background-color: color-mix(in srgb, var(--mosu-chrome-fg) 70%, transparent);
    }
    .mosu-shell.is-collapsed.is-dragging .mosu-drag-pill {
      width: 44px;
      background-color: rgba(140, 102, 255, 0.78);
    }
    .mosu-shell.is-collapsed .mosu-body,
    .mosu-shell.is-collapsed .mosu-frame {
      background: var(--mosu-surface);
    }

    @media (prefers-reduced-motion: reduce) {
      .mosu-shell,
      .mosu-shell.is-collapse-animating:not(.is-interacting),
      .mosu-bar,
      .mosu-brand,
      .mosu-bar-actions,
      .mosu-btn,
      .mosu-collapse-icon,
      .mosu-drag-pill {
        transition: none;
      }
    }
  `;

  const bindDrag = (bar) => {
    let dragState = null;

    bar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) {
        return;
      }
      event.preventDefault();
      // Captured first: a pointer that is already gone cannot be captured,
      // and a drag started without capture would never hear it end.
      try {
        bar.setPointerCapture?.(event.pointerId);
      } catch {
        return;
      }
      clearCollapseAnimation();
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startBounds: { ...currentBounds },
      };
      shellElement?.classList.add('is-interacting', 'is-dragging');
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
    // Capture can go without either of those (a window switch mid-drag);
    // the shell must not be left ignoring the pointer.
    bar.addEventListener('lostpointercapture', endDrag);
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
      try {
        handle.setPointerCapture?.(event.pointerId);
      } catch {
        return;
      }
      clearCollapseAnimation();
      resizeState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startBounds: { ...currentBounds },
      };
      shellElement?.classList.add('is-interacting');
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
    handle.addEventListener('lostpointercapture', endResize);
  };

  const mountOverlay = async (options) => {
    mountGeneration += 1;
    const generation = mountGeneration;
    const storedBounds = await readStoredBounds();
    if (generation !== mountGeneration) {
      return false;
    }
    const initialCollapsed = typeof options.collapsed === 'boolean'
      ? options.collapsed
      : Boolean(storedBounds.collapsed);
    const effectiveCollapsed = options.expandOnOpen ? false : initialCollapsed;
    const isReusing = Boolean(hostElement && iframeElement && hostMount);
    const mount = isReusing ? hostMount : { id: randomHex(16), token: randomHex(32) };
    const iframeUrl = buildEmbeddedIframeUrl({
      beatmapId: options.beatmapId,
      setId: options.setId,
      mode: options.mode,
      sourceUrl: options.sourceUrl,
      resumeTimeMs: options.resumeTimeMs,
      resumePaused: options.resumePaused,
      collapsed: effectiveCollapsed,
      followEnabled: options.followEnabled !== false,
      mountId: mount.id,
    });

    if (!iframeUrl) {
      return false;
    }

    // Reuse an already-mounted overlay without flickering the iframe if ready.
    if (isReusing) {
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

    // Opened expanded from a bar that was put away collapsed: it unfolds from
    // the same edge a click on the bar would have.
    currentBounds = boundsForCollapsed(storedBounds, effectiveCollapsed);

    ensureTopBarFonts();

    const host = document.createElement('div');
    host.id = HOST_ID;
    // Closed: the page cannot reach into the shell or read the iframe's URL.
    const shadow = host.attachShadow({ mode: 'closed' });

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
    barLeft.innerHTML = '<span class="mosu-brand">mosu! preview</span>';

    const dragHandle = document.createElement('div');
    dragHandle.className = 'mosu-drag-handle';
    dragHandle.title = 'Drag to move';

    const dragPill = document.createElement('span');
    dragPill.className = 'mosu-drag-pill';
    dragPill.setAttribute('aria-hidden', 'true');
    dragHandle.appendChild(dragPill);

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
      unmountOverlay({ clearResume: true, animate: true });
    });

    actions.appendChild(collapseBtn);
    actions.appendChild(closeBtn);
    bar.appendChild(barLeft);
    bar.appendChild(dragHandle);
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
    hostMount = mount;

    bindDrag(dragHandle);
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
    if (!ALLOWED_EXTENSION_ORIGINS.has(event.origin)) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== 'object' || data.channel !== CHANNEL) {
      return;
    }

    if (data.type === 'ready') {
      iframeOrigin = event.origin;
      iframeReady = false;
      void shareHostToken(iframeElement);
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

    if (data.type === 'miniPalette') {
      applyShellPalette(data.palette);
      return;
    }

    if (data.type === 'chromeMetrics') {
      if (currentBounds.collapsed || shellElement?.classList.contains('is-collapse-animating')) {
        return;
      }
      const innerHeight = Number(data.innerChromeHeight);
      if (Number.isFinite(innerHeight) && innerHeight > 0) {
        const nextChrome = Math.round(clamp(
          innerHeight + OUTER_BAR_AND_BORDER_HEIGHT,
          MIN_CHROME_HEIGHT,
          MAX_CHROME_HEIGHT,
        ));
        if (nextChrome !== chromeHeight) {
          const fromHeight = currentBounds.height;
          chromeHeight = nextChrome;
          // The window's height follows its chrome; up top it keeps its top.
          currentBounds = {
            ...currentBounds,
            bottom: bottomForHeightChange(currentBounds.bottom, fromHeight, heightForWidth(currentBounds.width)),
          };
          applyShellBounds();
        }
      }
      return;
    }

    if (data.type === 'requestClose') {
      unmountOverlay({ clearResume: true, animate: true });
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
      mountOverlay({
        beatmapId: message.beatmapId,
        setId: message.setId,
        mode: message.mode,
        sourceUrl: message.sourceUrl,
        resumeTimeMs: message.resumeTimeMs,
        resumePaused: message.resumePaused,
        expandOnOpen: true,
      }).then(
        (ok) => safeSendResponse(sendResponse, { ok }),
        (error) => safeSendResponse(sendResponse, { ok: false, error: error?.message || String(error) }),
      );
      return true;
    }
    if (message.type === 'mosuEmbeddedClose') {
      const wasOpen = Boolean(hostElement);
      unmountOverlay({ clearResume: true, animate: true });
      safeSendResponse(sendResponse, { ok: true, closed: wasOpen });
      return false;
    }
    return false;
  });

  const isTruthySetting = (value) => value === true || value === 'true' || value === 1 || value === '1';

  const readEmbeddedSettingEnabled = async () => isTruthySetting(await storageGet('sync', EMBEDDED_SETTING_KEY));

  extensionApi.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== 'sync' || !changes || !Object.hasOwn(changes, EMBEDDED_SETTING_KEY)) {
      return;
    }
    if (!isTruthySetting(changes[EMBEDDED_SETTING_KEY]?.newValue)) {
      unmountOverlay({ clearResume: true, animate: true });
    }
  });

  // Best-effort restore after a hard reload (F5 / Ctrl+R) on the same tab,
  // only when the experimental setting is currently enabled. Nothing is read
  // from extension storage unless there is a snapshot to check.
  const hasResumeSnapshot = (() => {
    try {
      return Boolean(window.sessionStorage.getItem(RESUME_KEY));
    } catch {
      return false;
    }
  })();
  if (hasResumeSnapshot) {
    void (async () => {
      const resumeSnapshot = await readResumeSnapshot();
      if (!resumeSnapshot) {
        return;
      }
      if (!(await readEmbeddedSettingEnabled())) {
        clearResumeSnapshot();
        return;
      }
      // Opened from the toolbar while the snapshot was being checked.
      if (hostElement) {
        return;
      }
      await mountOverlay({
        beatmapId: resumeSnapshot.beatmapId,
        setId: resumeSnapshot.setId,
        mode: resumeSnapshot.mode,
        resumeTimeMs: resumeSnapshot.resumeTimeMs,
        resumePaused: resumeSnapshot.resumePaused,
        collapsed: resumeSnapshot.collapsed,
        followEnabled: resumeSnapshot.followEnabled,
      });
    })();
  }
})();
