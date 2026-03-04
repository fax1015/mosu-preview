# mosu! preview

an extension popup that previews osu! beatmaps directly from the active tab.

## how it works

1. open an osu! beatmap page.
2. click the extension icon.
3. the popup validates the URL, fetches `https://osu.ppy.sh/osu/{beatmapId}`, parses hit objects, and renders a map preview.
4. no loading time is needed, as the extension uses the preview audio first, and fetches the full audio in the background.

the extension only works on valid osu beatmap URLs.

## permissions

the manifest requests only two extension permissions:

- `activeTab`
  reads the current tab URL so the popup can detect supported osu! beatmap pages.
- `storage`
  reads and writes user settings, short-lived preview cache data, and cache prune metadata.

### cache limits

- preview metadata cache max age: `12 hours`
- full audio per-entry limit: `35 MiB`
- full audio total cache limit: `64 MiB`
- full audio max age per entry: `7 days`
- prune interval: `30 minutes`

full audio cache eviction removes expired entries first, then removes the oldest remaining entries until the total size is back under the cap.

## host permissions

host permissions are scoped to the services the extension actually fetches from:

- `https://osu.ppy.sh/*`
- `https://b.ppy.sh/*`
- `https://osu.direct/*`
- `https://api.nerinyan.moe/*`
- `https://txy1.sayobot.cn/*`
- `https://catboy.best/*`
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

## notes

this extension is kinda like a "refreshed" version of [osu! preview](https://github.com/JerryZhu99/osu-preview), updated to fit chrome's manifest V3 and firefox's webextension APIs. 

credits to [JerryZhu99](https://github.com/JerryZhu99) for the original extension.
