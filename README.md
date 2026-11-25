# mosu! preview

a browser extension that previews osu! beatmaps directly from the active tab.

## how it works

1. open an osu! beatmap page.
2. click the extension icon.
3. the popup fetches `https://osu.ppy.sh/osu/{beatmapId}`, parses the map, and renders a live preview.
4. playback starts right away using osu!'s preview audio while the full track downloads in the background.

a small indicator in the top-right corner shows download progress while the full track is fetching, along with brief notices like copied timestamps or errors. hover it to see the audio source, or click it to open the debug panel.

on pages without a beatmap, you can still open previously cached mapsets from the menu.

## detached window

click the detach button in the header to open the preview in its own resizable window. it remembers its size and position, picks up where the popup left off, and automatically switches as you browse to other beatmaps or difficulties. click the eye button in the header if you want to pin it to the current map.

opening the toolbar popup while the detached window is open closes the window so two previews never play over each other.

## pinned in-page miniplayer

an experimental option (off by default, under **Settings → in-page miniplayer**) adds a button to the header on `osu.ppy.sh` to put a floating miniplayer right on the page.

* drag the top bar to move it, drag any edge or corner to resize, or click the chevron (or double-click the bar) to collapse it into a compact bar. position, size, and collapsed state are remembered.
* it stays running as you move around osu.ppy.sh and follows along when you switch beatmaps or difficulties (use the eye button to pin it to one map). it also restores itself (tries to) after a page reload.
* opening the toolbar popup or detaching it closes the in-page player so audio doesn't overlap.

## preview

the preview follows osu!'s 4:3 framing, so if an object is offscreen in the preview, it's offscreen in-game too.

* **playback**: plays automatically when opened (you can turn this off with **play on open** in settings). music volume stays synced between the preview slider and settings.
* **hitsounds** *(experimental, off by default)*: synthesised in the browser for circles, slider nodes, and spinners, with `argon`, `lazer`, and `minimal` styles and its own volume control. taiko maps automatically use a synthesised taiko drum. custom map hitsounds aren't played.
* **mania key count**: standard maps converted to mania have a key count picker in the controls (`auto`, `4k`, `7k`, or anything from `1k` to `10k`, also cycled with `k`), remembered across converts. native mania maps keep their own key count.
* **media keys**: works with browser and system media controls (hardware keys, Windows media flyout, Android media notification) with map info and cover art, which makes it easy to pause a detached window in the background.
* **cached mapsets**: available from the menu on any page.

### comparing difficulties

click the compare button in the header to view up to four difficulties from the same set side by side on one clock and timeline (including converts for taiko, catch, and mania). click any difficulty's name to focus it for the timeline, hitsounds, and object selection. your open panels are remembered per set until you close the browser.

### timeline and timestamps

the timeline shows object density (green), kiai sections (amber), breaks (hatched), and the preview point (purple), with bar lines along the top.

* scroll to zoom around the cursor, `shift` + scroll (or swipe sideways) to pan, and use the bottom rail to move around while zoomed in.
* zoom in close enough and the density bars switch to individual objects on a beat grid, snapping to object heads when hovering (hold `alt` to seek freely).
* click the time readout or press `c` to copy the current time as `01:23:456`. when zoomed in, click objects to select them (`ctrl`/`cmd` + click to toggle, `shift` + click for a range) to copy an osu! editor timestamp like `01:23:456 (1,2,3) - ` (or `time|column` pairs for mania).

### shortcuts

* `space` play / pause
* `left` / `right` seek 5s (`shift` for 15s)
* `up` / `down` volume
* `home` / `end` jump to start / end
* `0`–`9` jump to 0–90%
* `n` / `p` jump to the next or previous section (bookmarks, kiai starts, breaks)
* `c` copy timestamp
* `,` / `.` pause and step one frame
* `\[` / `]` adjust playback speed
* `s` cycle speed, `m` mute, `r` restart
* `k` cycle mania convert key count (`auto`, `4k`, `7k`)
* `=` / `-` zoom timeline around the playhead, `esc` zoom out
* `?` show and customize shortcuts
* `alt` + `shift` + `o` open the preview from any tab (managed by the browser at `chrome://extensions/shortcuts` or firefox's `about:addons` → manage extension shortcuts)

most shortcuts can be rebound from the `?` menu (click a key to change it, right-click to reset) and sync with your settings.

## supported url formats

* `https://osu.ppy.sh/beatmapsets/{setId}#osu/{beatmapId}`
* `https://osu.ppy.sh/beatmapsets/{setId}#taiko/{beatmapId}`
* `https://osu.ppy.sh/beatmapsets/{setId}#fruits/{beatmapId}` (or `#catch/{beatmapId}`)
* `https://osu.ppy.sh/beatmapsets/{setId}#mania/{beatmapId}`
* `https://osu.ppy.sh/beatmapsets/{setId}/discussion/{beatmapId}/...`
* `https://osu.ppy.sh/beatmapsets/{setId}?b={beatmapId}`
* `https://osu.ppy.sh/beatmaps/{beatmapId}` (optional `?mode=` or `?m=` ruleset override)
* `https://osu.ppy.sh/beatmapsets/{setId}` (and discussion pages without a difficulty)

opening a beatmapset URL that doesn't specify a difficulty shows a list of the set's difficulties with star ratings so you can pick one to preview.

## permissions

the manifest requests three extension permissions:

* `activeTab`: reads the current tab URL on osu! beatmap pages and grants temporary access when pinning the in-page miniplayer.
* `scripting`: injects the `osu.ppy.sh` miniplayer shell on demand.
* `storage`: saves settings (`storage.sync`), view history, window geometry, and cache metadata (`storage.local`), plus short-lived session caches (`storage.session`). full audio blobs are stored in the browser Cache API (`mosuPreviewFullAudioV1`).

### cache limits

* preview metadata max age: `12 hours`
* full audio per-entry limit: `150 MiB`
* full audio total limit: `256 MiB`
* full audio max age: `7 days`
* prune interval: `30 minutes`

expired audio entries are removed first, followed by the oldest entries until usage is back under the cap. you can view usage and clear the cache from the settings page.

### host permissions

network access is scoped to the services the extension fetches from:

* `https://osu.ppy.sh/\*`
* `https://b.ppy.sh/\*`
* `https://catboy.best/\*`
* `https://osu.direct/\*`
* `https://storage.osu.direct/\*` (download redirect)
* `https://api.nerinyan.moe/\*`
* `https://dl.nerinyan.moe/\*` (download redirect)
* `https://txy1.sayobot.cn/\*`
* `https://tc1.sayobot.cn/\*` (download redirect, including port `:25225`)

cover images are loaded from `https://assets.ppy.sh` via `img-src` (no host permission needed). no content scripts run on arbitrary pages: `src/content.js` is scoped to `https://osu.ppy.sh/\*` and stays idle until you pin a miniplayer.

## install locally

### chrome

1. open chrome and go to `chrome://extensions`.
2. enable **Developer mode**.
3. click **Load unpacked**.
4. select the `mosu!-preview` folder (or run `npm run package:chrome` and unpack `dist/mosu!-preview-chrome v{version}.zip` to omit firefox-only manifest keys).

### firefox

1. run `npm run package:firefox` to build `dist/mosu!-preview-firefox v{version}.xpi`.
2. open firefox and go to `about:debugging#/runtime/this-firefox`.
3. click **Load Temporary Add-on...**.
4. select `dist/mosu!-preview-firefox v{version}.xpi` (or `manifest.json` from the `mosu!-preview` folder).

## package

run `npm run package` to build release archives in `dist/`:

* `mosu!-preview-chrome v{version}.zip`
* `mosu!-preview-firefox v{version}.xpi`

to build just one target, run `npm run package:chrome` or `npm run package:firefox`.

## development

run `npm install` once, then:

* `npm test` to run the test suite
* `npm run lint` to run ESLint
* `npm run performance` to open the browser benchmark dashboard (pass `-- --lan` to access from another device on your network)
* `npm run performance:micro` to run Node microbenchmarks

## notes

this extension is kinda like a "refreshed" version of [osu! preview](https://github.com/JerryZhu99/osu-preview), updated to fit chrome's manifest V3 and firefox's webextension APIs.

credits to [JerryZhu99](https://github.com/JerryZhu99) for the original extension.

