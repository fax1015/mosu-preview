# mosu! preview — Improvement Roadmap

This document outlines a prioritised list of improvements, ranging from quick bug fixes to larger architectural refactors, based on a thorough code audit. The goal is to make the extension more robust, maintainable, and ready for future features without introducing mysterious regressions.

---

## 1. Critical fixes (low effort, high impact)

### 1.1 Fix the broken support link

**Problem**  
The issue link uses a double hyphen:

```js
issue: 'https://github.com/fax1015/mosu--preview/issues/new',
```

The correct repo name is `mosu-preview`.

**Fix**  
Change it to:

```js
issue: 'https://github.com/fax1015/mosu-preview/issues/new',
```

**Files**  
`src/popup.js` (search for `SUPPORT_LINKS`).

---

### 1.2 Remove unnecessary `browsingActivity` permission

**Problem**  
The manifest declares `data_collection_permissions` with `"browsingActivity"`. This may trigger an extra privacy warning on Firefox and is not actually used.

**Fix**  
Delete the entire `data_collection_permissions` block from `manifest.json`:

```json
"browser_specific_settings": {
  "gecko": {
    "id": "{4b8ec57c-3fdf-4fda-8fda-95c9ad94f4df}",
    "strict_min_version": "140.0"
  },
  "gecko_android": {
    "strict_min_version": "142.0"
  }
}
```

**Files**  
`manifest.json`.

---

### 1.3 Plug memory leaks: object URLs and dual requestAnimationFrame loops

**Problem**  
- `URL.revokeObjectURL` isn’t always called when a full audio load is cancelled or replaced.  
- After a hotswap to full audio, a second `requestAnimationFrame` loop can start while an existing one is still running, causing doubled CPU usage and visual glitches.

**Fix**

#### a) Centralise object URL revocation

Create a helper in `popup.js` (or a future audio module) that always revokes before assigning a new URL:

```js
function setFullAudioObjectUrl(newUrl) {
  if (state.fullAudioObjectUrl) {
    URL.revokeObjectURL(state.fullAudioObjectUrl);
    state.fullAudioObjectUrl = null;
  }
  state.fullAudioObjectUrl = newUrl || null;
}
```

Replace all direct assignments to `state.fullAudioObjectUrl` with `setFullAudioObjectUrl(...)`. In the `unload` handler, already existing `URL.revokeObjectURL` can stay.

#### b) Prevent duplicate requestAnimationFrame loops

When starting any kind of playback (manual, audio), **always** cancel the existing RAF first:

```js
function clearCurrentRaf() {
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
}
```

Call `clearCurrentRaf()` at the beginning of:
- `startManualPlayback`
- `startAudioPlayback`
- `hotswapToFullAudio` (before setting the new RAF)
- `stopPlayback` (already does it, keep it)

This guarantees at most one animation loop is alive at any time.

**Files**  
`src/popup.js`.

---

### 1.4 Add a Content Security Policy (CSP)

**Problem**  
No CSP is declared. While the extension has no inline scripts, a strict CSP adds defense-in-depth against XSS if a dependency is ever compromised.

**Fix**  
Add this to `manifest.json` (adjust for your actual assets):

```json
"content_security_policy": {
  "extension_pages": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src https://osu.ppy.sh https://b.ppy.sh https://osu.direct https://api.nerinyan.moe https://txy1.sayobot.cn https://catboy.best https://osu.sayobot.cn; font-src 'self';"
}
```

**Note**  
If you use external fonts (the Torus font is bundled, so fine), adjust accordingly. The `manifest.json` CSP does not affect the popup's ability to fetch audio, because the `connect-src` already whitelists the required hosts.

**Files**  
`manifest.json`.

---

## 2. Architectural improvements (higher effort, long-term gain)

### 2.1 Split `popup.js` into focused modules

**Problem**  
`popup.js` is a ~2000 line monolith that mixes UI, audio, caching, parsing, rendering, and state management. This makes it fragile and hard to test.

**Step-by-step plan**

1. Create the following directory structure under `src/`:

```
src/
├── audio/
│   ├── playback.js          # toggle, stop, play/seek logic
│   ├── provider.js          # download, provider selection, stats
│   └── cache.js             # full audio cache read/write/prune
├── ui/
│   ├── popupUI.js           # DOM references, events, status, toast
│   ├── debugPanel.js        # debug panel toggle, logging
│   └── unsupportedView.js   # ASCII animation, unsupported state
├── core/
│   ├── state.js             # central state object, reset, cancellation tokens
│   └── timing.js            # clock sync, duration management
└── ...
```

2. **Extract state**  
Move the giant `state` object to `core/state.js`. Export it as a singleton, but add a `resetState()` function that resets all fields (useful when popup closes). Gradually restrict direct mutation from other modules – eventually replace with setter functions.

3. **Move audio logic**  
Move `downloadBeatmapArchive`, `upgradeToFullAudioIfPossible`, `hotswapToFullAudio`, `configureAudioPreview`, and related helpers to `audio/` modules. They should operate on the shared state (or receive it as parameters). Keep the UI interactions (badge updates) via callbacks or imports.

4. **Move UI logic**  
All DOM queries, event listeners, and visual updates go to `ui/popupUI.js`. The main `popup.js` becomes a thin orchestrator that imports everything and wires it up.

5. **Maintain backward compatibility**  
Do this incrementally. Start by extracting one module (e.g., `audio/cache.js`), test thoroughly, then continue. Avoid rewriting everything at once.

**Why this helps**  
- Isolated responsibilities make bugs obvious.
- You can write unit tests for audio, cache, timing, and settings (outside the extension environment with mocked APIs).
- Future additions (e.g., a new game mode renderer) slot in cleanly.

---

### 2.2 Centralise cleanup and cancellation

**Problem**  
Timers, intervals, and fetch operations are started in various places and cancelled ad‑hoc. A popup that closes unexpectedly can leave dangling callbacks.

**Fix**

Create a `CleanupRegistry` in a new module `src/core/cleanup.js`:

```js
class CleanupRegistry {
  constructor() {
    this.timers = new Set();
    this.intervals = new Set();
    this.controllers = new Set();
  }

  addTimeout(id) { this.timers.add(id); return id; }
  addInterval(id) { this.intervals.add(id); return id; }
  addAbortController(controller) { this.controllers.add(controller); return controller; }

  cleanup() {
    this.timers.forEach(clearTimeout);
    this.intervals.forEach(clearInterval);
    this.controllers.forEach(c => c.abort());
    this.timers.clear();
    this.intervals.clear();
    this.controllers.clear();
  }
}

// Singleton
const registry = new CleanupRegistry();

window.addEventListener('unload', () => registry.cleanup());
```

Use it consistently:

```js
// Instead of direct setTimeout
const timerId = setTimeout(...);
registry.addTimeout(timerId);

// For fetch
const controller = registry.addAbortController(new AbortController());
fetch(url, { signal: controller.signal });
```

**Bonus**  
This automatically handles `AbortController` cleanup—you can now safely abort network requests when the popup closes.

---

### 2.3 Move heavy work out of the popup (service worker / background)

**Problem**  
Archive downloads and ZIP parsing occur inside the popup’s JavaScript context. If Chrome kills the popup while download is in progress, the extension silently fails.

**Solution**  
- **Phase 1**: Use the extension’s **background service worker** (Manifest V3) to fetch and cache full audio.  
- The popup posts a message like `{ type: 'fetchFullAudio', setId, audioFilename }`.  
- The service worker handles downloading, extraction, and storing into the Cache API. Once done, it messages the popup with the blob URL or error.

**How to implement**

1. Create `src/background.js` (or `service-worker.js`).  
2. In the manifest, add `"background": { "service_worker": "src/background.js" }`.  
3. In the service worker, import the necessary modules (audio providers, ZIP parsing, cache). You can reuse the same code with minimal changes because it runs in a worker context (no DOM).  
4. On popup open, send a message requesting full audio. The popup listens for a response:

```js
chrome.runtime.sendMessage({ type: 'fullAudio', ... }, (response) => {
  // handle success/failure
});
```

5. The service worker can also proactively start downloads based on the active tab’s beatmap set ID (via `tabs` API) – but keep it simple first.

**Benefits**  
- The popup stays responsive and never risks being killed mid‑download.  
- Full audio can be fetched **before** the user even opens the popup (if you later enable pre‑fetching).  
- The Cache API is already accessible from service workers.

---

### 2.4 Introduce stricter state boundaries

**Problem**  
The global `state` object is mutated from dozens of functions, making it impossible to track changes or guarantee consistency.

**Short‑term improvement** (without a full Redux‑like store)  
- Create **public setter functions** for each major state slice (`setIsPlaying`, `setCurrentTime`, etc.) that also emit events or call UI updates.  
- Gradually replace direct property mutation with these functions.

**Long‑term**  
Consider using a simple custom event‑based store:

```js
// core/store.js
const listeners = new Set();

export function subscribe(fn) { listeners.add(fn); }
export function dispatch(action) {
  state = reducer(state, action);   // pure reducer
  listeners.forEach(fn => fn(state));
}
```

This is optional but helps when you reach higher complexity.

---

## 3. Refinements & polish

### 3.1 Unify provider override normalisation

**Problem**  
The same logic for `normalizeProviderOverride` appears in both `options.js` and `popup.js`.

**Fix**  
Move the normalization function (and the `ALLOWED_PROVIDER_OVERRIDES` set, legacy aliases) to a shared module, e.g., `src/settings.js`:

```js
export const PROVIDER_OVERRIDE_OPTIONS = ['auto', ...ARCHIVE_DOWNLOAD_SOURCES.map(s => s.id)];

export function normalizeProviderOverride(value) {
  const candidate = String(value || 'auto');
  const normalized = LEGACY_PROVIDER_OVERRIDE_ALIASES[candidate] || candidate;
  return PROVIDER_OVERRIDE_OPTIONS.includes(normalized) ? normalized : 'auto';
}
```

Then import it from both pages. This eliminates duplication and ensures consistency.

---

### 3.2 Improve slider tick timing accuracy (optional)

**Problem**  
Slider ticks are spaced using the BPM at the slider’s start time, but the BPM may change inside the slider. This is a cosmetic issue for previews but deviates from the official client.

**Fix**  
Instead of computing all ticks from `getStandardTimingState(object.time)`, iterate through the timing points that fall between `object.time` and `object.endTime` and generate ticks for each segment separately. This is more involved; only do it if you value high visual fidelity. The current approximation is acceptable for a preview extension.

---

### 3.3 Options page input UX

**Problem**  
If the user types an invalid number in the Mania scroll speed field, it silently reverts to the default value on blur.

**Fix**  
Add a CSS class for error and show a brief shake/highlight. After normalisation, if the value was invalid, briefly add the class:

```js
maniaScrollSpeedInput.addEventListener('change', async () => {
  const raw = maniaScrollSpeedInput.value;
  const normalized = normalizePreviewSettings({ maniaScrollSpeed: raw }).maniaScrollSpeed;
  if (String(raw) !== String(normalized)) {
    // flash input
    maniaScrollSpeedInput.classList.add('input-error');
    setTimeout(() => maniaScrollSpeedInput.classList.remove('input-error'), 600);
  }
  renderManiaScrollSpeed(normalized);
  await persistFormSettings();
});
```

---

### 3.4 Optimise the unsupported ASCII animation

**Problem**  
The ASCII bubble animation rebuilds a full grid every 140ms. On large popup sizes it might cause unnecessary CPU load.

**Fix**  
Replace the full grid rebuild with a partial update: only redraw the regions that have changed (bubbles entering/leaving). This is a micro‑optimisation and not urgent, but you can cache the “empty” row string and only overwrite the substrings that change.

---

### 3.5 More robust mobile/desktop detection

**Problem**  
The extension uses UA string sniffing and coarse pointer check to decide between desktop and mobile layout. This can misclassify touchscreen laptops or tablets in desktop mode.

**Fix**  
Continue using the same detection (since it’s only for cosmetic layout tweaks), but add a user‑configurable override in the options page: “Force mobile layout” / “Force desktop layout”. Store it in settings and respect it.

---

## 4. Maintenance & testing

### 4.1 Add a simple test harness

Because you plan to split into modules, you can test core logic (parsing, settings normalisation, provider sorting, cache pruning) with Node.js using a unit test framework (Jest, Vitest). This prevents regressions when refactoring.

Example structure:

```
tests/
  settings.test.js
  parser.test.js
  provider.test.js
```

### 4.2 Manual test checklist

After refactoring, run through:

- Opening a beatmap with and without a set ID.
- Switching between modes (osu!, taiko, mania, catch).
- Playing, pausing, seeking, changing volume.
- Changing playback speed.
- Full audio download and hotswap while playing.
- Provider failure simulation (block a provider in devtools).
- Popup close and reopen quickly while audio is loading.
- Mobile layout toggle (if added).
- Unsupported site view.

### 4.3 Versioning

After each significant change, increment the `version` in `manifest.json` so users can distinguish stable releases.

---

## 5. Prioritisation

| Priority | Item                                           | Effort | Impact |
|----------|------------------------------------------------|--------|--------|
| P0 (now) | Fix broken support link, remove browsingActivity, object URL & RAF fixes | Low    | High   |
| P0       | Add CSP                                        | Low    | Medium |
| P1 (next release) | Unify provider override normalization | Low | Medium |
| P1       | Options input UX improvement                   | Low    | Low    |
| P2 (later) | Split popup.js (start with audio module)      | Medium–High | High   |
| P2       | Centralise cleanup (CleanupRegistry)          | Medium | High   |
| P2       | Move heavy work to service worker             | High   | High   |
| P3       | State management improvement                  | High   | Medium |
| P3       | Slider tick accuracy, ASCII animation optimisation | Low–Med | Low    |

---

## 6. Conclusion

This roadmap transforms `mosu! preview` from a well‑crafted monolith into a modular, maintainable, and future‑proof extension. Start with the critical fixes, then gradually modularise the codebase while adding the cleanup registry. Moving heavy downloads to a service worker will be the biggest architectural leap, but can be deferred until the monolith is under control. Every step includes concrete implementation details so you can action them immediately.