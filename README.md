# mosu! preview

an extension popup that previews osu! beatmaps directly from the active tab.

## how it works

1. open an osu! beatmap page.
2. click the extension icon.
3. the popup validates the URL, fetches `https://osu.ppy.sh/osu/{beatmapId}`, parses hit objects, and renders a map preview.
4. no loading time is needed, as the extension uses the preview audio first, and fetches the full audio in the background.

the extension only works on valid osu beatmap URLs.

## detached window

the header's detach button reopens the current preview in its own resizable window, so it stays put instead of closing the moment you click elsewhere. the window remembers its last size and position, and clicking detach again focuses the existing window rather than opening a second one.

clicking the toolbar icon while the window is open closes it, so two previews never play over each other.

the preview picks up from wherever the popup left off, and stays paused if it was paused. because a resume point sits past what the short b.ppy.sh preview clip covers, the window runs the timeline silently until the full track arrives rather than snapping back to the preview point. switching to another map afterwards starts at that map's own preview point.

the detached window then follows along as you browse: open another beatmap, or click a different difficulty on a beatmapset page, and the preview switches to it. you only detach once. the eye button in its header pins the window to the current map if you would rather it stayed put; clicking it again resumes following and jumps to whatever you are looking at now.

if no osu! beatmap page is open, the window keeps showing the last map rather than blanking.

the detached window cannot read the active tab, so the popup passes the beatmap and set ids in the page URL, and following reads tab URLs through the existing `https://osu.ppy.sh/*` host permission. no extra permission is needed. on firefox for android, where there is no window management, the preview opens in a tab instead.

## preview

hitsounds are available as an experimental option, off by default. every node of a slider sounds, not just its head: the tail and each reverse use their own `edgeSounds` entry from the beatmap, and spinners sound when they finish. the sounds themselves are generated in the browser rather than read from the beatmap's own samples, so custom hitsounds are not reproduced; volume is adjustable in settings.

the cached mapsets list is reachable from the menu on any page, not just when no beatmap is open.

### shortcuts

- `space` play / pause
- `left` / `right` seek 5s, with `shift` 15s
- `up` / `down` volume
- `home` / `end` jump to start / end
- `0`-`9` jump to 0-90% of the map
- `,` / `.` pause and step one frame
- `[` / `]` nudge playback speed
- `s` cycle speed, `m` mute, `r` restart
- hovering the timeline shows the timestamp under the cursor

## permissions

the manifest requests only two extension permissions:

- `activeTab`
  reads the current tab URL so the popup can detect supported osu! beatmap pages.
- `storage`
  reads and writes user settings, short-lived preview cache data, and cache prune metadata.

### cache limits

- preview metadata cache max age: `12 hours`
- full audio per-entry limit: `150 MiB`
- full audio total cache limit: `256 MiB`
- full audio max age per entry: `7 days`
- prune interval: `30 minutes`

full audio cache eviction removes expired entries first, then removes the oldest remaining entries until the total size is back under the cap.

each cached audio entry also stores its mapset's title, artist and creator, so the cached mapsets list can name a set for as long as its audio is kept. the view history is a 20-entry recency list and ages out much sooner than the audio does.

## host permissions

host permissions are scoped to the services the extension actually fetches from:

- `https://osu.ppy.sh/*`
- `https://b.ppy.sh/*`
- `https://catboy.best/*`
- `https://osu.direct/*`
- `https://dl.osu.direct/*`
- `https://api.nerinyan.moe/*`
- `https://dl.nerinyan.moe/*`
- `https://txy1.sayobot.cn/*`
- `https://*.idrivee2-50.com/*`
- `https://tc1.sayobot.cn:25225/*`
- `https://osu.sayobot.cn/*`

the extension does not inject content scripts into arbitrary pages. it runs from the popup and makes network requests only to the hosts above.

## supported url formats

- `https://osu.ppy.sh/beatmapsets/{setId}#osu/{beatmapId}`
- `https://osu.ppy.sh/beatmapsets/{setId}#taiko/{beatmapId}`
- `https://osu.ppy.sh/beatmapsets/{setId}#fruits/{beatmapId}`
- `https://osu.ppy.sh/beatmapsets/{setId}#mania/{beatmapId}`
- `https://osu.ppy.sh/beatmaps/{beatmapId}`

## install locally

### chrome

1. open chrome and go to `chrome://extensions`.
2. enable **Developer mode**.
3. click **Load unpacked**.
4. select the `mosu-preview` folder.

### firefox

1. open firefox and go to `about:debugging#/runtime/this-firefox`.
2. click **Load Temporary Add-on...**.
3. select the `mosu-preview` zip file/xpi file.

## package

run `npm run package` to create release archives in `dist/`:

- `mosu!-preview-chrome v{version}.zip`
- `mosu!-preview-firefox v{version}.xpi`

to build just one target, run `npm run package:chrome` or `npm run package:firefox`.

## notes

this extension is kinda like a "refreshed" version of [osu! preview](https://github.com/JerryZhu99/osu-preview), updated to fit chrome's manifest V3 and firefox's webextension APIs. 

credits to [JerryZhu99](https://github.com/JerryZhu99) for the original extension.
