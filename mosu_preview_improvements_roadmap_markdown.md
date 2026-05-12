# mosu-preview — Planned Improvements Roadmap

This roadmap focuses on features that deepen the extension’s identity without dramatically widening scope. The goal is to evolve mosu-preview into a polished interactive beatmap/media preview tool while keeping architecture maintainable.

---

# 1. Timeline & Scrubbing Improvements

These are among the highest-impact UX upgrades.

---

## 1.1 Kiai Timeline Indicators

### Goal
Show kiai sections directly on the timeline.

### UX
- Yellow highlighted timeline regions
- Subtle, not overpowering
- Should remain visible while playing/scrubbing

### Rendering Ideas
Possible styles:
- translucent yellow bars
- glow overlay
- thin upper/lower strip
- soft gradient

### Data Source
Already available from timing points.

No additional parsing needed.

### Complexity
Low.

### Future Expansion
Could later expand to:
- break sections
- BPM changes
- spinner regions

without changing architecture.

---

## 1.2 Precision Scrubbing Popup

### Goal
Show a zoomed-in local timeline while scrubbing.

### UX
Appears during:
- timeline drag
- optionally Shift+drag only

Popup displays:
- nearby hitobjects
- beat snap lines
- exact timestamp
- center marker

### Suggested MVP
- ±2 seconds around cursor
- 200–300px popup canvas

### Visual Contents
- object markers
- beat lines
- current target marker
- optional density graph later

### Interaction
Main timeline:
- coarse navigation

Popup:
- precision targeting

### Recommended Implementation
Separate lightweight timeline renderer:

```js
renderScrubPreview(centerTimeMs, windowMs)
```

Do NOT reuse full gameplay renderer.

### Complexity
Medium.

### Risks
Avoid:
- giant popup
- excessive animation
- overdraw

Should feel like:
> precision lens

not:
> second timeline UI

---

## 1.3 Click Timestamp to Copy

### Goal
Quickly copy current timestamp.

### UX
Clicking timestamp:

```txt
01:42:381
```

copies:

```txt
01:42:381
```

to clipboard.

### Additions
Optional formats later:
- raw ms
- editor format
- Discord format

### Recommended
Show toast:

```txt
Copied timestamp
```

### Complexity
Very low.

---

# 2. Keyboard Shortcuts

One of the best low-scope/high-value additions.

---

## Supported Shortcuts

| Shortcut | Action |
|---|---|
| Space | Play/pause |
| ← / → | Seek ±5s |
| Shift + ← / → | Seek ±15s |
| ↑ / ↓ | Volume |
| S | Cycle speed |
| M | Mute |
| R | Restart preview |

---

## UX Requirements

### Ignore while typing
Do not trigger inside:
- inputs
- textareas
- editable elements

### Prevent browser scrolling
Needed for:
- arrows
- spacebar

### Shortcut Discoverability
Add:
- tiny help modal
- shortcut hint button
- maybe:

```txt
?
```

### Suggested UX
Press:

```txt
?
```

or:

```txt
Shift+/
```

to open shortcuts panel.

---

## Complexity
Low.

---

# 3. Recently Previewed Panel

Very strong usability feature.

---

## Goal
Show recently opened beatmaps.

### Suggested Locations
Option A:
- empty state when no map detected

Option B:
- info/settings panel

Option C:
- dedicated small expandable panel

---

## Suggested Data
Each entry:
- title
- difficulty
- mapper
- mode icon
- thumbnail (optional)
- last viewed time

### Recommended Limit
- 10–20 entries

---

## Storage
Can reuse existing cache metadata.

No heavy infrastructure needed.

---

## Nice Enhancement
Click entry:
- instantly reopen preview

Very high perceived polish.

---

# 5. Mirror Provider Expansion

Current planned provider list is strong.

---

## Provider List

### Core Providers
1. Mino
2. osu.direct
3. Nerinyan
4. Sayobot

### Secondary Providers
5. BeatConnect
6. osz.direct
7. rai.moe

---

## Recommendations
Treat:
- Mino
- osu.direct
- Nerinyan
- Sayobot

as primary trusted providers.

Others:
- fallback/experimental weighting

---

## Additional Suggestion
Add provider metadata:

```js
{
  id,
  supportsNoVideo,
  regionBias,
  startupLatencyScore,
  reliabilityScore
}
```

This will help future orchestration enormously.

---

# 6. Provider Priority System

Very good advanced-user feature.

---

## Goal
Allow users to influence provider ordering.

### IMPORTANT
User ordering should be:
> preference weighting

NOT:
> absolute hard override

---

## Recommended Scoring Model

Example:

```txt
finalProviderScore =
(userPreference * 0.6)
+
(runtimeTelemetry * 0.4)
```

This preserves:
- user intent
- automatic reliability handling

---

## UI Design

### Mode Toggle

```txt
Automatic (recommended)
Custom priority
```

---

## Custom Priority UI

```txt
☰ Sayobot        [x]
☰ Mino           [x]
☰ Nerinyan       [x]
☰ osu.direct     [x]
☰ BeatConnect    [x]
☰ osz.direct     [x]
☰ rai.moe        [ ]
```

Where:
- drag handle = reorder
- checkbox = enable/disable

---

## Additional Buttons
- Reset
- Recommended
- Auto-sort by latency maybe later

---

## Complexity
Medium.

Mostly UI + scoring integration.

---

# 7. Shortcut Help Menu

Should stay tiny.

---

## Goal
Improve discoverability.

### Suggested Design
Minimal overlay:

```txt
Keyboard shortcuts

Space      Play/pause
← / →      Seek
Shift+←/→  Fine seek
S          Speed
M          Mute
R          Restart
```

### Trigger
- help icon
- ?
- long-press maybe

---

## Complexity
Very low.

---

# Suggested Priority Order

## Phase 1 — Quick Wins
These give huge polish for low effort.

1. click timestamp to copy
2. keyboard shortcuts
3. shortcut help menu
4. kiai timeline bars
5. beatmap background art

---

## Phase 2 — Strong UX Upgrades
6. recently previewed panel
7. provider priority system
8. additional providers

---

## Phase 3 — More Advanced
9. precision scrubbing popup

This one has the most interaction design complexity.

---

# Additional Technical Recommendations

## Playback / Timeline
- Keep timeline rendering separate from gameplay rendering.
- Avoid introducing additional RAF loops.
- Reuse parsed timing data aggressively.
- Binary-search visible object ranges during scrubbing.

## Provider Infrastructure
- Track startup latency separately from total download time.
- Add provider cooldowns and temporary blacklisting.
- Consider speculative fallback racing later.
- Persist provider telemetry lightly.

## UX Philosophy
The extension should continue feeling:
- lightweight
- responsive
- mapper-friendly
- visually polished

Avoid drifting toward:
- replay simulation platform
- full osu client
- heavy customization engine
- social platform

