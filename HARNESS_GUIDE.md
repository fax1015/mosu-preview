# Harness & Benchmark Guide for Agents

How to check a change to mosu! preview without loading the extension by hand: what each harness covers, how to run it, and what it cannot tell you.

| Need | Use | Command |
| --- | --- | --- |
| Logic, rendering math, settings, messaging rules | Node test suite | `npm test` |
| Style and module mistakes | ESLint | `npm run lint` |
| The in-page miniplayer, live in a browser | Miniplayer harness | `npm run harness` |
| Speed of parsing, conversion, drawing | Microbenchmarks | `npm run performance:micro -- --no-save` |
| Frame rate, popup startup time, trends | Benchmark dashboard | `npm run performance -- --no-open` |
| Release archives are well formed | Package validator | see [Package validator](#package-validator) |
| Anything the harnesses cannot fake | The real extension | README, "chrome" / "firefox" |

CI runs `npm run lint`, `npm test` and `npm run package` on Ubuntu and Windows with Node 22 (`.github/workflows/ci.yml`). Run the first two before calling any change done.

---

## 1. Node test suite (`npm test`)

`node --test` runs every `tests/*.test.js`, **each file in its own process**. Filter with `node --test --test-name-pattern="<regex>" tests/<file>.test.js`.

### Harnesses already in the suite

Reuse these before writing a new mock.

| Harness | Where | What it gives you |
| --- | --- | --- |
| Content script on a fake page | `tests/helpers/contentScript.js` (`loadContentScript`) | Runs the real `src/content.js` in a `vm` context with a listener-keeping DOM, `storage.local`/`sync` backed by Maps, `sessionStorage`, runtime messaging that records what was sent, and WebCrypto. Helpers: `open()`, `close()`, `postFromIframe()`, `navigate()`, `changeStorage()`, `shell()`, `iframe()`, `byClass()`, `settle()`. Pass the same Maps to a second load to simulate a reload. Used by `content-script.test.js` and `embedded-shell-anchor.test.js`. |
| Recording 2D context | `tests/wavy-progress.test.js` (`createRecordingContext`) | A `Proxy` canvas context that logs every call with the stroke/fill style at the time: assert *what* was drawn, in what order and colour. |
| Timeline / renderer on a fake canvas | `tests/wavy-progress.test.js` (`createCanvas`, `withWindow`), `tests/renderer.test.js` (`createPlayfieldHarness`, `withBrowserWindow`) | `TimelineRenderer` and `PreviewRenderer` without a browser. Call `render(now)` with explicit timestamps to step animations deterministically. |
| Playback clock | `tests/audio-clock.test.js`, `tests/full-audio-controller.test.js`, `tests/hidden-playback.test.js` (`createHarness`) | Fake audio elements, seek gates and a manual frame driver for preview-clip/full-audio handoff and seeking. |
| Cover palette pipeline | `tests/mini-theme.test.js` (`withFakeImagePipeline`, `coverFetch`) | Stubs `createImageBitmap` and `OffscreenCanvas` so `src/ui/miniTheme.js` runs its real fetch → sample → palette path. |
| Popup and options pages load | `tests/popup-loads.test.js` | Evaluates `popup.js` and `options.js` top to bottom against a stub DOM. The only test that loads them. |
| Extension bridge | `tests/embedded-controller.test.js` | Toolbar-popup and iframe sides of `src/ui/embeddedController.js`, plus an older inline content-script mount test. |

### Rules that will bite you

- **`src/webextension.js` grabs the extension API object once, on first import.** Within one test file, every test must mutate *one* shared `browser` mock (see `useBrowser` in `embedded-controller.test.js`). Assigning a fresh `globalThis.browser` in a later test silently does nothing, and assertions can pass vacuously.
- **`popup.js` is not unit-testable.** It is one large module wired to the DOM. Pull a decision into a pure, exported function (as `shouldPlayHitsounds` in `src/settings.js`) and test that.
- **`src/content.js` is a classic script.** It is linted as `sourceType: 'script'`, has no imports, and is tested only through `vm`. Its URL building must stay identical to `buildEmbeddedPageUrl` in `src/core/embeddedPlayer.js`; `content-script.test.js` enforces this.
- A file under `tests/helpers/` is not run as a test (only `*.test.js` is), so shared mocks go there.
- Check that a new test **fails without your fix**: revert the fix for a moment and run just that test.

---

## 2. Miniplayer harness (`npm run harness`)

A stand-in osu! page that runs the real `src/content.js` and the real `popup.html` in its iframe, so the in-page miniplayer can be clicked, collapsed, dragged and inspected in an ordinary browser. Files live in `scripts/miniplayer-harness/`; nothing in `scripts/` is packaged.

```powershell
npm run harness
```

Then open `http://127.0.0.1:4321/` (set another port with `MOSU_HARNESS_PORT`).

### What is real and what is stood in

| Real | Stood in |
| --- | --- |
| `src/content.js`: shell, closed shadow root, drag, resize, collapse anchoring, token handover, signed reload snapshot | `chrome.*` on the host page (`host.html`): in-memory storage with `embeddedPlayer` on; `runtime.sendMessage` delivers into the iframe with an osu.ppy.sh sender |
| `popup.html`, `popup.css`, every `src/` module in the iframe | `chrome.*` in the iframe (`iframe-shim.js`): in-memory storage, no tabs, the background worker answers `{ ok: false }` |
| Beatmaps, covers and preview audio from osu! | Fetched through the server's `/__proxy`, which only reaches `osu.ppy.sh`, `b.ppy.sh`, `assets.ppy.sh`, `catboy.best` and `osu.direct`. **Needs network.** |

The iframe sees the host as `https://osu.ppy.sh` (the shim rewrites `event.origin` and `parent`), so the embedded controller's origin and token checks run as they do on the real site.

### Driving it

Buttons along the top open four maps and toggle collapse. From the host page's console (or `javascript_tool` in the built-in browser):

| Helper | Does |
| --- | --- |
| `__openMap(beatmapId, setId)` | What the toolbar popup sends: mounts or reuses the shell |
| `__frame()` | The iframe element; `.contentDocument` is the miniplayer page (same origin here) |
| `__shadow()` | The shell's shadow root, captured even though it is closed |
| `__toggle()` / `__isCollapsed()` | Collapse or expand through the shell's own button / read its state |
| `__freezeAfterToggle(ms)`, `__seek(ms)`, `__resume()` | Toggle, then hold every running animation at `ms` to inspect a frame of the transition |
| `__runtimeSent`, `__shadowMode` | Runtime messages the content script sent (the token handover), and the mode the shadow root was made with |

Wait about 5–7 s after `__openMap` for the map and audio to arrive before asserting on the iframe.

**Example check:** collapse through the shell, then forge a message from the page. The forged one must be ignored because it lacks the token.

```js
__toggle();
__frame().contentWindow.postMessage(
  { channel: 'mosu-preview-embedded-v1', type: 'collapsedChanged', collapsed: false }, '*');
// __frame().contentDocument.documentElement.classList.contains('is-embedded-collapsed') stays true
```

### In the Claude desktop app's built-in browser

`preview_start` needs a `.claude/launch.json`. Create one for the session and delete it afterwards; it is not checked in.

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "mosu-miniplayer-harness", "runtimeExecutable": "npm", "runtimeArgs": ["run", "harness"], "port": 4321 }
  ]
}
```

- Prefer `javascript_tool` and `read_page` over screenshots for state.
- **Drags need the real mouse** (`computer` → `left_click_drag` on `.mosu-drag-handle`). A synthetic `PointerEvent` has no active pointer, so `setPointerCapture` throws and no drag starts.
- Screenshot coordinates are not CSS pixels. Compare the screenshot's coordinate frame with `innerWidth`/`innerHeight` and scale `getBoundingClientRect()` values before clicking.
- If a server from an earlier session is still on port 4321, `preview_stop` it first.

### What it cannot tell you

Check these in the real extension, loaded unpacked as the README describes:

- `web_accessible_resources`: everything here is served over plain http, so nothing is blocked.
- Real `runtime`/`tabs` messaging, `tabs.getCurrent`, the background worker and full-audio extraction.
- Extension-page CSP and Firefox-specific behaviour.

---

## 3. Benchmark suite

Two entry points share one results file, `performance-results/results.jsonl`. **This file is tracked in git.** Every saved run appends a line with the commit, a working-tree fingerprint and the machine. Save runs only when asked to record a baseline; otherwise use the no-save options below.

The fixed workload map is `scripts/benchmark-maps/5839914.osu` ("conic"). Benchmarks never touch the network.

### Microbenchmarks (Node, no browser)

```powershell
npm run performance:micro -- --no-save
```

| Option | Effect |
| --- | --- |
| `--no-save` | Do not append to `results.jsonl` (use by default) |
| `--samples <n>` | Samples per benchmark, 1–100 (default 9). Use the default for comparisons: one sample is noise. |
| `--json` | Machine-readable output |
| `--history [n]` | Print the last *n* saved runs and exit |
| `--no-color` | Plain text |

**What it measures:**

- **Gates** (`scripts/performance.mjs`). These are the pass/fail checks:
  - slider timing lookup, optimized vs reference, at least 1.10× faster;
  - zoomed timeline frame at 60,000 objects, at least 1.05× faster.
  - A failed gate sets exit code 1.
- **Subsystem timings**, reported as median and p95 and never failing:
  - parse "conic" and a 3,000-object map;
  - convert std → taiko / catch / mania 7K;
  - build hitsound events;
  - inflate `.osz` audio;
  - index MP3 frames;
  - cover OKLCH palette;
  - wavy progress bar (200 frames);
  - miniplayer bounds/resume geometry.

The report compares each number with the previous saved run. Only treat a change as real if it holds across default-sample runs on the same machine.

### Benchmark dashboard (browser)

```powershell
npm run performance -- --no-open
```

This serves `http://127.0.0.1:4173/` and prints the URL. If 4173 is taken and no `--port` was given, it moves to the next free port. `--lan` exposes it on the network. `--help` lists every option.

| Tab | Measures | URL / flag |
| --- | --- | --- |
| **Render** | Real canvas FPS, frame-interval p50/p95/p99, JS work per frame, dropped frames | `--scenario <id>`, `--duration <1–60>`, `--auto[=<id\|all>]` |
| **Open & Load** | Startup phases of the real popup (`DOM + CSS` → `JS Boot` → `Reveal` → `Parse + Render` → `Paint`) for cached, cold, unsupported-tab, miniplayer expanded and miniplayer collapsed | `--startup` (`?tab=startup`) |
| **History** | Trends across saved render and startup runs; tags runs made under a ~30 Hz frame cap or on battery as Efficiency Mode | `--history` (`?tab=history`) |
| **Micro** | The microbenchmarks above, run by the server | `--micro` (`?tab=micro`) |

**Render scenarios:**

| Scenario | Workload |
| --- | --- |
| `anchor-heavy-slider` | A slider with 4,344 anchors |
| `aspire-conic` | The "conic" map at its densest point |
| `object-stress` | 8,000 objects |
| `mania-7k` | 8,000 converted 7K notes and holds |
| `catch-fruits` | 3,000 objects as catch fruits and droplets |
| `compare-4up` | Four difficulty playfields on one clock |
| `miniplayer-collapsed` | The collapsed bar with cover palette and wavy progress |
| `miniplayer-toggle` | Repeated collapse/expand transitions |

`all` runs every scenario.

**Running it as an agent:**

- `http://127.0.0.1:<port>/?autobench=<id|all>&duration=<sec>` runs a **visual-only** pass as soon as the page loads, and **does not save** it.
- Watch `#status`, then read the results from `#results` (render) or `#startup-results` (startup). `#copy-md` copies a run as Markdown.
- **Visual + Audio** mode (the dashboard's default) saves render runs to `results.jsonl`. **Open & Load** saves only while `#startup-save-toggle` is on.
- **Keep the tab visible and in front.** A hidden or background tab throttles `requestAnimationFrame`, and its numbers are meaningless (the page shows a banner). If the built-in browser pane is hidden, ask for it to be shown first.
- A frame rate pinned near 30 FPS means the browser is capping frames (power saving), not that the code got slower. Such runs are tagged as Efficiency Mode.
- `/popup-bench.html` is the real `popup.html` with `scripts/performance-popup-shim.js` injected: mocked storage and network, and a generated cover. The Open & Load tab loads it in an iframe and hands it the map; opened on its own, it has no map.

### Server API (for scripts)

Same-origin only: requests are host-checked and POSTs must be same-origin JSON.

| Endpoint | Does |
| --- | --- |
| `GET /api/meta` | Build (version, commit, clean or dirty tree) and machine info |
| `GET /api/results` | Saved runs |
| `POST /api/results` / `POST /api/startup` | Save a render / startup run (the dashboard does this) |
| `POST /api/micro` | Run the microbenchmarks; body `{ "save": false, "sampleCount": 9 }` |

---

## 4. Package validator

`npm run package` builds both archives and validates them. It checks:

- the manifest;
- that every referenced file exists;
- `web_accessible_resources`;
- JS imports;
- the Firefox-only manifest changes.

It also **writes `dist/` and overwrites archives of the same version**. To validate without writing anything:

```powershell
node --input-type=module -e "import fs from 'node:fs/promises'; import { collectPackageFiles, createZip, targets, validatePackage, resolveBuildDate } from './scripts/package.mjs'; const m = JSON.parse(await fs.readFile('manifest.json', 'utf8')); const v = JSON.parse(await fs.readFile('package.json', 'utf8')).version; for (const t of Object.keys(targets)) { const f = await collectPackageFiles(process.cwd()); f.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(targets[t].manifest(m), null, 2) + '\n') }); validatePackage(t, f, createZip(f, resolveBuildDate()), { expectedVersion: v }); console.log(t, 'ok'); }"
```

The archive contains only `popup.html`, `popup.css`, `options.html`, `options.css`, `assets/` and `src/`. `scripts/` and `tests/` never ship.
