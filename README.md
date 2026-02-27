# mosu! Map Preview (Chrome Extension)

A Manifest V3 Chrome extension popup that previews osu! beatmaps directly from the active tab.

## How it works

1. Open an osu! beatmap page.
2. Click the extension icon.
3. The popup validates the URL, fetches `https://osu.ppy.sh/osu/{beatmapId}`, parses hit objects, and renders a map preview.

The extension only works on valid osu beatmap URLs.

## Supported URL formats

- `https://osu.ppy.sh/beatmapsets/{setId}#osu/{beatmapId}`
- `https://osu.ppy.sh/beatmapsets/{setId}#taiko/{beatmapId}`
- `https://osu.ppy.sh/beatmapsets/{setId}#fruits/{beatmapId}`
- `https://osu.ppy.sh/beatmapsets/{setId}#mania/{beatmapId}`
- `https://osu.ppy.sh/beatmaps/{beatmapId}`

## Install locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `C:\Users\Kyson\Documents\GitHub\mosu!-preview`.

## Notes

- No Tauri/Rust dependencies are used.
- Preview playback is a visual simulation based on beatmap timing.
- If a beatmap URL does not include a beatmap difficulty ID, popup shows an error.
