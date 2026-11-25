# mosu! preview

A browser extension (Chrome MV3 and Firefox) that previews osu! beatmaps: the playfield, a timeline, and audio, in the toolbar popup, a detached window, or a miniplayer pinned onto an osu.ppy.sh tab. The README has the user-facing behaviour.

## Read before working

- **[HARNESS_GUIDE.md](HARNESS_GUIDE.md):** which test harness, browser harness or benchmark to use for a change, how to run each, and what each cannot tell you.
- **[UI_DESIGN_GUIDE.md](UI_DESIGN_GUIDE.md):** how to write UI and UI copy here.

## Commands

| Command | Does |
| --- | --- |
| `npm test` | Node test suite (`tests/*.test.js`, each file in its own process) |
| `npm run lint` | ESLint |
| `npm run harness` | Miniplayer harness on `http://127.0.0.1:4321/` |
| `npm run performance:micro -- --no-save` | Node microbenchmarks, without recording the run |
| `npm run performance -- --no-open` | Benchmark dashboard on `http://127.0.0.1:4173/` |

CI runs lint, tests and packaging on Ubuntu and Windows with Node 22. Run lint and tests before calling a change done.

## Where things are

- **`popup.html`, with `src/popup.js` as its main module, is three surfaces:**
  - the toolbar popup;
  - the detached window (`?detached…`);
  - the in-page miniplayer's iframe (`?embedded=1…`).
  - `src/mapRequest.js` loads ahead of `popup.js` to start the map fetch early.
- **`src/content.js`** draws the in-page miniplayer's shell on osu.ppy.sh. It runs there as a classic script, not a module.
- **`src/background.js`** is the service worker; it extracts full audio. **`options.html`** + **`src/options.js`** are the settings page.
- **`src/core/`** holds pure logic (URLs, parsing helpers, timing, geometry). **`src/ui/`** holds DOM controllers, **`src/audio/`** playback and sources, **`src/renderers/`** the per-ruleset playfields.
- **`scripts/`** has packaging, benchmarks and the miniplayer harness. It is never packaged.

## Pitfalls

- **`src/content.js` has no imports.** Its helpers duplicate parts of `src/core/embeddedPlayer.js`; keep the two in step (`tests/content-script.test.js` checks that both build the same iframe URL).
- **Messages from the content script to the iframe carry a per-mount token**, handed over through runtime messaging, and the iframe ignores any message without it. Don't add a host-to-iframe message that skips `postToIframe`.
- **Don't run `npm run package` just to check the build.** It overwrites same-version archives in `dist/`. Use the in-memory validator in HARNESS_GUIDE.md.
- **`performance-results/results.jsonl` is tracked.** A saved benchmark run appends to it, so don't save one unless asked.
- **`src/webextension.js` keeps the first extension API object it sees.** Tests in one file must share one `browser` mock.
- **`popup.js` can't be unit tested.** Put logic worth testing in a pure exported function in `src/core/`, `src/settings.js` or `src/ui/`.
