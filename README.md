# mosu! preview

an extension popup that previews osu! beatmaps directly from the active tab.

## how it works

1. open an osu! beatmap page.
2. click the extension icon.
3. the popup validates the URL, fetches `https://osu.ppy.sh/osu/{beatmapId}`, parses hit objects, and renders a map preview.
4. no loading time is needed, as the extension uses the preview audio first, and fetches the full audio in the background.

the extension only works on valid osu beatmap URLs.

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
3. select the project's `manifest.json` file.

## notes

this extension is kinda like a "refreshed" version of [osu! preview](https://github.com/JerryZhu99/osu-preview), updated to fit chrome's manifest V3 and Firefox's WebExtension APIs. credits to [JerryZhu99](https://github.com/JerryZhu99) for the original idea.
