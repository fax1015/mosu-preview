# mosu! preview

an extension popup that previews osu! beatmaps directly from the active tab.

## how it works

1. open an osu! beatmap page.
2. click the extension icon.
3. the popup validates the URL, fetches `https://osu.ppy.sh/osu/{beatmapId}`, parses hit objects, and renders a map preview.
4. no loading time is needed, as the extension uses the preview audio first, and fetches the full audio in the background.

the preview's top-right corner has an island: a small capsule that is only there while something is going on. while the full track downloads it holds a ring, filling as it goes, with the percentage once the size is known; when the track lands it shows a tick for a moment and then shrinks away. playing the preview clip or the full track with nothing happening shows nothing at all. hover the island for where the audio is coming from; click it for the debug panel.

every message the popup has -- a copied timestamp, a failure, the phone's "leave this view" -- comes from the same island. it springs out of the corner for a few seconds, then back to what it was showing, or away. click a message to put it away early. with no map open it sits in the same corner of the "unsupported webpage" card.

each kind of thing has a colour of its own: amber for the full track downloading, green for it arriving, violet for a copied timestamp, teal for anything else done (the cache cleared, the shortcuts reset), blue for something to know or go and do, red for a failure.

the extension only works on valid osu beatmap URLs.

## detached window

the header's detach button reopens the current preview in its own resizable window, so it stays put instead of closing the moment you click elsewhere. the window remembers its last size and position, and clicking detach again focuses the existing window rather than opening a second one.

clicking the toolbar icon while the window is open closes it, so two previews never play over each other.

the preview picks up from wherever the popup left off, and stays paused if it was paused. because a resume point sits past what the short b.ppy.sh preview clip covers, the window runs the timeline silently until the full track arrives rather than snapping back to the preview point. switching to another map afterwards starts at that map's own preview point.

the detached window then follows along as you browse: open another beatmap, or click a different difficulty on a beatmapset page, and the preview switches to it. you only detach once. the eye button in its header pins the window to the current map if you would rather it stayed put; clicking it again resumes following and jumps to whatever you are looking at now.

if no osu! beatmap page is open, the window keeps showing the last map rather than blanking.

the detached window cannot read the active tab, so the popup passes the beatmap and set ids in the page URL, and following reads tab URLs through the existing `https://osu.ppy.sh/*` host permission. no extra permission is needed. a phone has no separate windows to open a preview in, so the detach button is left out there.

## pinned in-page miniplayer

an experimental option (off by default, under **Settings → in-page miniplayer**) adds a pin-to-page button to the popup header on `osu.ppy.sh`. clicking it mounts the preview directly onto the osu! tab as a floating, draggable, resizable miniplayer. it attaches to `<html>` outside `<body>` so osu!'s Hotwire Turbo page switches leave the player running without resetting audio or canvas state, just like a persistent site miniplayer.

- drag the slim top bar to place it anywhere, drag any edge or corner to resize it, or click the chevron (or double-click the bar) to collapse it into a compact audio and timeline bar with its own play/pause button. position, size and collapsed state are remembered.
- by default it follows along as you switch beatmaps or difficulties on that osu! tab, and stays put on the current map when you visit profiles, rankings or forums; the eye button pins it to the current map.
- opening the toolbar popup or a detached window closes any open in-page player so two previews never play over each other, and the in-page player's detach button pops it straight out into a separate window.
- if the tab undergoes a hard reload (`F5`), the player restores itself from a short-lived per-tab session snapshot close to where it left off.

the content script only runs on `https://osu.ppy.sh/*` and stays idle with nothing mounted until you pin a preview.

## preview

hitsounds are available as an experimental option, off by default. every node of a slider sounds, not just its head: the tail and each reverse use their own `edgeSounds` entry from the beatmap, and spinners sound when they finish. the sounds themselves are generated in the browser rather than read from the beatmap's own samples, so custom hitsounds are not reproduced; volume is adjustable in settings, and so is the style: argon (the default), lazer or minimal, modelled on the argon skin, osu!lazer's default hitsounds and the Wintherest skin. none of those skins' samples are shipped; each style is re-made from synthesised layers.

taiko maps play the taiko drum instead, whichever style is chosen: a centre hit for a don, the rim for a kat, the big versions for finishes, and a flourish on runs of big kats, the way osu!lazer's default (argon) skin plays them. like lazer, the drum takes its softer or harder voice from the hit's volume rather than its sample bank, and a big note stops what that half of the drum is still ringing. each hit is about as loud as the same note in osu! mode with the chosen style (a kat as a hitnormal with its clap, a big note with its finish), so switching a map between osu! and taiko does not jump the volume; kats sit a little under that and dons a little over, for more thump. drumrolls are struck at every tick and swells as many times as they need, as lazer's autoplay strikes them. the drum is synthesised too, fitted to lazer's taiko samples, which are not shipped.

mania previews show the key count in the controls row. for a standard map converted to mania it opens a picker, like osu!lazer's key mods: auto (the count the map works out for itself), 4k and 7k up front and every other count from 1k to 10k one click further, also on `k`. the choice is remembered for every convert. mania maps keep their own key count, as they do in lazer.

the cached mapsets list is reachable from the menu on any page, not just when no beatmap is open. on firefox for android a set picked from it opens behind the popup, so the popup says to leave it to see the page, as it does for the settings page. those two messages stay up longer than the rest, since they are something to do rather than something done.

the preview starts playing as soon as it opens. **play on open** in settings turns that off, for whoever would rather it waited for `space`; a detached window still keeps playing, or keeps paused, as the popup left it, whatever the setting says. the music volume is on the settings page as well as the preview's own slider, and setting it either way is remembered.

### preview size

**the preview's height is fixed by a reference slider. do not change it without checking that slider.**

the reference is beatmap [5337582](https://osu.ppy.sh/beatmaps/5337582) (Aphex Twin - Cock/ver10 [7\\]) at 2:50: a CS 5.1 slider that loops around the outside of the playfield, from x -32 to 544 and y -24 to 392. its body should lie just inside the preview, about 3px clear of every edge. that makes the preview 4:3, the shape of osu!'s own 640x480 view. a taller preview leaves a band above and below the slider (at 1.29:1, nearly ten pixels each way), and a shorter one cuts it off.

the playfield is never stretched to fit. it used to be squashed vertically so this slider met both edges, and when that was taken out the preview kept its old 1.29:1 shape, which left the gap. the preview is sized to the field now, not the other way round.

the number lives in the `aspect-ratio` on `.map-preview-canvas-wrap` in `popup.css`, and the compare panels' `PANEL_ASPECT` in `src/core/panelLayout.js` has to match it. `tests/renderer.test.js` draws the slider from its line in the map at every popup size and fails if the body runs past an edge or sits more than 5px inside one, and fails if the two numbers differ.

### several difficulties at once

the two-panel button in the header shows other difficulties of the set beside the one you opened, up to four in all, on one clock and one timeline. the list comes from the set's osu.ppy.sh page, with star ratings, and offers what the site lists under that ruleset's tab: its own difficulties and, for taiko, catch and mania, the converts of the standard ones. the preview keeps its size, in the toolbar popup, the detached window and on a phone alike: the difficulties share it, in whichever grid gives each the most room for its shape (in the popup, two side by side and three or four in a 2x2 grid; a tall window stacks them, a wide one lines them up), and every playfield keeps its proportions. the map you opened leads, and one difficulty at a time is in focus: the lead, until another's name is clicked. the one in focus is the one you hear, its hitsounds playing, and the one the timeline shows: its objects, breaks and timing, with the bars growing and shrinking out of the last one's as focus moves (they change at once with reduced motion on). the view, the zoom and the playhead stay where they are, since the song is the same. objects are picked out on the timeline or on the playfield of the difficulty it is showing, and moving focus lets go of them. a mania convert's key count applies to every convert shown.

what is shown is remembered per set until the browser closes, so reopening the popup, detaching it or following on to another difficulty of the set keeps the same panels; following on to one that is already shown swaps it into the lead. another set or ruleset starts with none.

### media keys

the preview reports to the browser's media controls, with the map's title, artist, difficulty and cover: hardware media keys, the windows media flyout and the android media notification can play, pause and seek it, which is the easy way to pause a detached window that is playing out of sight.

### shortcuts

- `space` play / pause
- `left` / `right` seek 5s, with `shift` 15s
- `up` / `down` volume
- `home` / `end` jump to start / end
- `0`-`9` jump to 0-90% of the map
- `n` / `p` jump to the next or previous section the map names for itself
- `c` copy the playhead as an osu!-editor timestamp; clicking the time readout does the same
- `,` / `.` pause and step one frame
- `[` / `]` nudge playback speed
- `s` cycle speed, `m` mute, `r` restart
- `k` cycle a mania convert's key count: auto, 4k, 7k
- `?` show the shortcuts list
- `=` / `-` (or `+`) zoom the timeline in and out around the playhead, `esc` zooms back out
- hovering the timeline shows the timestamp under the cursor, to the millisecond once zoomed in
- `alt` + `shift` + `o` opens the preview from any tab. the browser owns this one: change or clear it at `chrome://extensions/shortcuts` (firefox: `about:addons`, manage extension shortcuts). the shortcuts list shows whatever it is set to

on a phone the list is left out of the menu, there being no keyboard for it to describe.

the list itself groups them and is where they are changed: click a key to rebind it, right-click to put it back, **reset all** to put them all back. every one is a single key, and giving a key to one action takes it from whatever held it — the row that lost it says "unset" rather than two things firing at once. the digits, `esc`, `tab` and `enter` are kept by the preview and its dialogs, so they cannot be bound; `alt` + `shift` + `o` belongs to the browser, as above. the keymap is stored with the rest of the settings, so it follows the detached window and syncs to your other machines.

### sections

`n` and `p` walk the places the map names for itself, earliest first: the mapper's own editor bookmarks, where each kiai section starts, and where each break starts. The preview says which one it landed on, since the timeline draws them but does not name them. A bookmark sitting on a kiai start is one place, not two. A map that marks nothing says so rather than seeking nowhere.

### timestamps

clicking the time readout, or pressing `c`, copies the playhead as `01:23:456` — just the time, ready to paste into a mod or a chat.

to name objects as well, click them on the timeline first. zoomed in far enough to see them, each one can be picked out: click to take one, `ctrl` (or `cmd`) + click to add or drop one, `shift` + click to take everything up to it. picked objects are ringed in amber, and the copy then reads `01:23:456 (1,2,3) - ` the way osu!'s editor writes it, timed from the first of them. mania uses the `time|column` pairs its own editor uses instead of combo numbers. clicking empty track lets them go again, and so does clicking anywhere that is not the preview — the playfield and the timeline are where they are chosen, so anywhere else is a click away from them. the copy button is the one exception, since it reads what is picked out.

at that zoom the objects are also magnetic: the playhead lands on the one you aimed at rather than a few milliseconds off it, and the readout under the cursor names where it will actually land. only their heads pull, so scrubbing through a long slider is not dragged back to its start. hold `alt` to put the playhead down exactly where the pointer is, which also leaves whatever is picked out alone.

### timeline

the timeline shows the whole map at first: object density in green, kiai sections in amber, breaks hatched, the preview point in purple. scroll on it to zoom in around the cursor; close enough, the bars turn into the objects themselves, with the beat grid behind them. `shift` + scroll (or a sideways swipe) pans. while zoomed, a rail along the bottom shows which part of the map is on screen: drag it to move around, or click beside it to jump there. a zoomed timeline follows the playhead while the preview plays, and dragging the playhead past either end scrolls it along.

the marks along its top edge are the map's own bars, at every zoom: every bar close in, then every two, four, eight as the view widens, each tempo counting from its own downbeat. they used to be round seconds, which share no factor with a map's bpm or its offset and so sat visibly off the notes they were drawn over. a map with no timing points at all falls back to the clock, there being no beat to count from.

### maps with extreme values

a `.osu` file is whatever its uploader typed, so the numbers a map sets for itself are held to the ranges osu!lazer holds them to before anything is built from them: slider multiplier 0.4-3.6, slider tick rate 0.5-8, a tempo of 6-60000ms a beat, positions and slider lengths within 131072 osu!pixels, and times within osu!'s 32-bit timeline. an object outside that timeline is dropped; one that runs past it ends there. a slider lays ticks along its first 100,000 pixels and no more than 20,000 of them, and a single Bezier span too large to subdivide in about a second is drawn as its control polygon. without these a map could ask for billions of slider ticks, or a timeline decades long, and take the popup down with it.

## permissions

the manifest requests only two extension permissions:

- `activeTab`
  reads the current tab URL so the popup can detect supported osu! beatmap pages.
- `storage`
  reads and writes user settings (`storage.sync`), provider stats, view history, detached window geometry, cache prune metadata (`storage.local`), and short-lived preview/compare cache data (`storage.session`). full audio blobs are stored in the browser Cache API (`mosuPreviewFullAudioV1`).

### cache limits

- preview metadata cache max age: `12 hours`
- full audio per-entry limit: `150 MiB`
- full audio total cache limit: `256 MiB`
- full audio max age per entry: `7 days`
- prune interval: `30 minutes`

full audio cache eviction removes expired entries first, then removes the oldest remaining entries until the total size is back under the cap.

the settings page reports what the cache is holding against that cap, and clears it; clearing takes the cached mapsets list with it, since that list is named from the cache entries. the same page restores every setting on it to its default. both ask twice: the first click arms the button, the second does it.

each cached audio entry also stores its mapset's title, artist and creator, so the cached mapsets list can name a set for as long as its audio is kept. the view history is a 20-entry recency list and ages out much sooner than the audio does.

an entry past its max age is deleted when it is next read and is already left out of the cached mapsets list, so every set the list offers loads from the cache rather than downloading its archive again.

## host permissions

host permissions are scoped to the services the extension actually fetches from:

- `https://osu.ppy.sh/*`
- `https://b.ppy.sh/*`
- `https://catboy.best/*`
- `https://osu.direct/*`
- `https://storage.osu.direct/*` (download redirect target)
- `https://api.nerinyan.moe/*`
- `https://dl.nerinyan.moe/*` (download redirect target)
- `https://txy1.sayobot.cn/*`
- `https://tc1.sayobot.cn/*` (download redirect target, including port `:25225`)

mapset cover thumbnails and media-session artwork are also loaded as images from `https://assets.ppy.sh` (allowed via `img-src`, no host permission needed).

the extension does not inject content scripts into arbitrary pages. a thin content script (`src/content.js`) is scoped strictly to `https://osu.ppy.sh/*` to host the optional in-page miniplayer on demand; everything else runs in the popup, options page, and background service worker / event page (`src/background.js`), making network requests only to the hosts above.

## supported url formats

- `https://osu.ppy.sh/beatmapsets/{setId}#osu/{beatmapId}`
- `https://osu.ppy.sh/beatmapsets/{setId}#taiko/{beatmapId}`
- `https://osu.ppy.sh/beatmapsets/{setId}#fruits/{beatmapId}` (or `#catch/{beatmapId}`)
- `https://osu.ppy.sh/beatmapsets/{setId}#mania/{beatmapId}`
- `https://osu.ppy.sh/beatmapsets/{setId}/discussion/{beatmapId}/...`
- `https://osu.ppy.sh/beatmapsets/{setId}?b={beatmapId}`
- `https://osu.ppy.sh/beatmaps/{beatmapId}` (optional `?mode=` or `?m=` ruleset override)
- `https://osu.ppy.sh/beatmapsets/{setId}`, and its discussion pages, which name no difficulty

a set URL with no difficulty in it — what a search result, a forum link or the modding queue opens — has nothing to preview yet, so the popup lists the set's difficulties instead: grouped by ruleset where the set has more than one, easiest first, each with its star rating, in the ruleset the link asked for where it asked for one. picking one moves the tab to that difficulty's discussion page and loads its preview. the list is read from the set's own page, so it costs one fetch; if it cannot be read, the cached mapsets list is shown as on any other page. the detached window still follows only URLs that name a difficulty.

## install locally

### chrome

1. open chrome and go to `chrome://extensions`.
2. enable **Developer mode**.
3. click **Load unpacked**.
4. select the `mosu!-preview` folder (or run `npm run package:chrome` and unpack `dist/mosu!-preview-chrome v{version}.zip` to omit Firefox-only manifest keys).

### firefox

1. run `npm run package:firefox` to build `dist/mosu!-preview-firefox v{version}.xpi`.
2. open firefox and go to `about:debugging#/runtime/this-firefox`.
3. click **Load Temporary Add-on...**.
4. select `dist/mosu!-preview-firefox v{version}.xpi` (or `manifest.json` from the `mosu!-preview` folder).

## package

run `npm run package` to create release archives in `dist/`:

- `mosu!-preview-chrome v{version}.zip`
- `mosu!-preview-firefox v{version}.xpi`

to build just one target, run `npm run package:chrome` or `npm run package:firefox`.

## performance benchmarks

run `npm run performance:micro` for the Node microbenchmarks. Run `npm run performance` to open the browser benchmark, then press **Run 8-second tests**. Each completed run is appended to `performance-results/results.jsonl` with its timestamp, benchmark metrics, build revision, and environment details. Keep this file with the build history to compare results across revisions. The browser benchmark's **Save result as baseline** button separately stores a same-device comparison baseline in that browser's local storage.

the scenario list has three workloads: 8,000 mixed objects, a synthetic 4,344-anchor slider, and `aspire-conic`, which replays osu! beatmap 5839914 ("conic", Aspire) at 01:23 from the bundled `scripts/benchmark-maps/5839914.osu`. That moment is the slider-body worst case, because 7,427-anchor decorative sliders are on screen. Append `?autobench=aspire-conic` or `?autobench=anchor-heavy-slider` to the page URL to run that scenario's visual-only pass straight away (autobench does not append to `results.jsonl`, and does not support `object-stress`).

the benchmark server only listens on this machine. to run it from a phone or another device on the same network, start it with `MOSU_PERF_LAN=1 npm run performance` (PowerShell: `$env:MOSU_PERF_LAN='1'; npm run performance`). Pass `--no-save` to `npm run performance:micro -- --no-save` to skip appending to `performance-results/results.jsonl`.

## development

run `npm install` once, then `npm test` for the test suite and `npm run lint` for ESLint. both run on every push and pull request.

## notes

this extension is kinda like a "refreshed" version of [osu! preview](https://github.com/JerryZhu99/osu-preview), updated to fit chrome's manifest V3 and firefox's webextension APIs. 

credits to [JerryZhu99](https://github.com/JerryZhu99) for the original extension.
