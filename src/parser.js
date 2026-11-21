import { getTimingStateAt } from './core/controlPoints.js';
import { clamp } from './core/math.js';

// osu! holds a greenline's slider velocity to this range; without the clamp a
// beat length of -5 reads as 20x and the slider it times runs half as long as
// it should.
const MIN_SLIDER_VELOCITY = 0.1;
const MAX_SLIDER_VELOCITY = 10;

// The ranges osu!lazer's decoder holds a map's own numbers to. A .osu file is
// whatever its uploader typed, and every one of these is a divisor or a loop
// bound somewhere downstream: a tick rate of 1e9 asked the renderer for two
// billion slider ticks, and a beat length of 1e12 made one slider last 68
// years. Clamping here, once, is what keeps every consumer finite.
const MIN_SLIDER_MULTIPLIER = 0.4;
const MAX_SLIDER_MULTIPLIER = 3.6;
const MIN_SLIDER_TICK_RATE = 0.5;
const MAX_SLIDER_TICK_RATE = 8;
const MIN_BEAT_LENGTH = 6;
const MAX_BEAT_LENGTH = 60000;
// Positions and slider lengths, in osu!pixels (lazer's MAX_COORDINATE_VALUE).
const MAX_COORDINATE = 131072;
// Times are 32-bit milliseconds in osu!, a little under 25 days. An object
// outside that has nowhere on a timeline to go and is dropped, as lazer drops
// it; an object that starts inside it and runs past it ends there.
export const MAX_OBJECT_TIME_MS = 2147483647;

const clampCoordinate = (value) => clamp(value, -MAX_COORDINATE, MAX_COORDINATE);

export const parseMetadata = (content) => {
  const data = {};
  let section = '';

  content.split(/\r\n|\r|\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) {
      return;
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      section = trimmed.slice(1, -1).toLowerCase();
      return;
    }

    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim().toLowerCase();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (section === 'metadata') {
      if (key === 'title') data.Title = value;
      else if (key === 'titleunicode') data.TitleUnicode = value;
      else if (key === 'artist') data.Artist = value;
      else if (key === 'artistunicode') data.ArtistUnicode = value;
      else if (key === 'creator') data.Creator = value;
      else if (key === 'version') data.Version = value;
      else if (key === 'beatmapsetid') data.BeatmapSetID = value;
    } else if (section === 'general') {
      if (key === 'audiofilename') data.Audio = value;
      else if (key === 'mode') data.Mode = parseInt(value, 10);
      else if (key === 'previewtime') data.PreviewTime = parseInt(value, 10);
    }
  });

  const title = data.Title || 'Unknown Title';
  const titleUnicode = data.TitleUnicode || data.Title || 'Unknown Title';
  const artist = data.Artist || 'Unknown Artist';
  const artistUnicode = data.ArtistUnicode || data.Artist || 'Unknown Artist';
  const creator = data.Creator || 'Unknown Creator';
  const version = data.Version || 'Unknown Version';
  const rawBeatmapSetId = String(data.BeatmapSetID || '').trim();
  let beatmapSetID = 'Unknown';
  if (/^\d+$/.test(rawBeatmapSetId)) {
    const idNum = Number.parseInt(rawBeatmapSetId, 10);
    if (Number.isSafeInteger(idNum) && idNum > 0) {
      beatmapSetID = `https://osu.ppy.sh/beatmapsets/${String(idNum)}`;
    }
  }

  return {
    title,
    titleUnicode,
    artist,
    artistUnicode,
    creator,
    version,
    beatmapSetID,
    mode: Number.isFinite(data.Mode) ? Math.min(Math.max(data.Mode, 0), 3) : 0,
    audio: data.Audio || '',
    previewTime: Number.isFinite(data.PreviewTime)
      ? clamp(data.PreviewTime, -1, MAX_OBJECT_TIME_MS)
      : -1,
  };
};

// osu! itself has no hard cap on slider repeats, but real beatmaps never go
// far past single digits. An unbounded value here is turned into an array of
// that length by the ruleset converters, so a corrupt file could exhaust the
// heap. Clamping at parse time keeps every downstream consumer safe.
export const MAX_SLIDER_SLIDES = 1000;
export const MAX_SLIDER_CONTROL_POINTS = 16384;
export const MAX_BREAK_PERIODS = 10000;

// Sample bank ids as the .osu format numbers them. 0 means "inherit from
// whatever is further up the chain", which is why it has a name of its own.
export const SAMPLE_SET_NONE = 0;
export const SAMPLE_SET_NORMAL = 1;
export const SAMPLE_SET_SOFT = 2;
export const SAMPLE_SET_DRUM = 3;

const SAMPLE_SET_NAMES = Object.freeze({
  none: SAMPLE_SET_NONE,
  normal: SAMPLE_SET_NORMAL,
  soft: SAMPLE_SET_SOFT,
  drum: SAMPLE_SET_DRUM,
});

// [General] spells the bank out; everywhere else numbers it.
const parseSampleSetName = (value) => {
  const key = String(value || '').trim().toLowerCase();
  return Object.hasOwn(SAMPLE_SET_NAMES, key) ? SAMPLE_SET_NAMES[key] : SAMPLE_SET_NONE;
};

const parseSampleSetIndex = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= SAMPLE_SET_NORMAL && parsed <= SAMPLE_SET_DRUM
    ? parsed
    : SAMPLE_SET_NONE;
};

// osu! writes volume as a percentage. Old file formats omit the column, and
// those maps play at full volume rather than silently.
const DEFAULT_SAMPLE_VOLUME = 100;

const parseSampleVolume = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SAMPLE_VOLUME;
  }
  return Math.min(100, Math.max(0, parsed));
};

// The shape every consumer of timing reads: the parser's own slider timing, the
// converters and the renderer all look these up through core/controlPoints.js.
const toTimingControlPoint = (tp) => ({
  time: tp.time,
  beatLength: tp.beatLength,
  meter: Number.isFinite(tp.meter) && tp.meter > 0 ? clamp(tp.meter, 1, 64) : 4,
  sampleSet: tp.sampleSet,
  sampleIndex: tp.sampleIndex,
  volume: tp.volume,
  uninherited: Boolean(tp.uninherited),
  bpm: tp.uninherited && tp.beatLength > 0 ? (60000 / tp.beatLength) : 0,
  svMultiplier: !tp.uninherited && tp.beatLength < 0
    ? clamp(-100 / tp.beatLength, MIN_SLIDER_VELOCITY, MAX_SLIDER_VELOCITY)
    : 1,
  omitFirstBarLine: Boolean((tp.effects || 0) & 8),
  kiai: Boolean((tp.effects || 0) & 1),
});

export const parseMapPreviewData = (content, options = {}) => {
  const maxObjects = Number.isFinite(options?.maxObjects) && options.maxObjects > 0
    ? Math.floor(options.maxObjects)
    : 8000;

  const timingPoints = [];
  const hitObjectLines = [];
  const objects = [];

  let section = '';
  let sliderMultiplier = 1.0;
  let sliderTickRate = 1.0;
  let circleSize = 5;
  let approachRate = null;
  let overallDifficulty = 5;
  let hpDrainRate = 5;
  let stackLeniency = 0.7;
  let mode = 0;
  let beatmapVersion = 14;
  // [General] SampleSet is the bank a hit falls back to when neither the object
  // nor the timing point names one.
  let defaultSampleSet = SAMPLE_SET_NONE;
  // [Editor] Bookmarks: where the mapper marked something worth coming back
  // to. Nothing in the preview is drawn from them; they are places to seek to.
  let bookmarks = [];

  const lines = content.split(/\r\n|\r|\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) {
      continue;
    }

    const formatMatch = trimmed.match(/^osu file format v(\d+)$/i);
    if (formatMatch) {
      beatmapVersion = Number.parseInt(formatMatch[1], 10) || beatmapVersion;
      continue;
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      section = trimmed.slice(1, -1).toLowerCase();
      continue;
    }

    if (section === 'general') {
      const sep = trimmed.indexOf(':');
      if (sep !== -1) {
        const key = trimmed.slice(0, sep).trim().toLowerCase();
        if (key === 'stackleniency') {
          const value = parseFloat(trimmed.slice(sep + 1));
          if (Number.isFinite(value)) {
            stackLeniency = value;
          }
        } else if (key === 'mode') {
          const value = parseInt(trimmed.slice(sep + 1), 10);
          if (Number.isFinite(value)) {
            mode = value;
          }
        } else if (key === 'sampleset') {
          defaultSampleSet = parseSampleSetName(trimmed.slice(sep + 1));
        }
      }
      continue;
    }

    if (section === 'editor') {
      const sep = trimmed.indexOf(':');
      if (sep !== -1 && trimmed.slice(0, sep).trim().toLowerCase() === 'bookmarks') {
        // A comma list of whole milliseconds. Older editors wrote a trailing
        // comma, and a map saved with the bookmarks cleared writes the key with
        // nothing after it, so both leave empty fields to drop.
        bookmarks = [...new Set(
          trimmed.slice(sep + 1)
            .split(',')
            .map((field) => Number.parseInt(field.trim(), 10))
            .filter((time) => Number.isFinite(time) && time >= 0 && time <= MAX_OBJECT_TIME_MS),
        )].sort((a, b) => a - b);
      }
      continue;
    }

    if (section === 'difficulty') {
      const sep = trimmed.indexOf(':');
      if (sep === -1) {
        continue;
      }

      const key = trimmed.slice(0, sep).trim().toLowerCase();
      const value = parseFloat(trimmed.slice(sep + 1));
      if (!Number.isFinite(value)) {
        continue;
      }

      if (key === 'slidermultiplier') {
        sliderMultiplier = clamp(value, MIN_SLIDER_MULTIPLIER, MAX_SLIDER_MULTIPLIER);
      } else if (key === 'slidertickrate') {
        sliderTickRate = clamp(value, MIN_SLIDER_TICK_RATE, MAX_SLIDER_TICK_RATE);
      } else if (key === 'circlesize') {
        circleSize = value;
      } else if (key === 'approachrate') {
        approachRate = value;
      } else if (key === 'overalldifficulty') {
        overallDifficulty = value;
      } else if (key === 'hpdrainrate') {
        hpDrainRate = value;
      }
      continue;
    }

    if (section === 'timingpoints') {
      const parts = trimmed.split(',');
      if (parts.length < 2) {
        continue;
      }

      const time = parseInt(parts[0], 10);
      const rawBeatLength = parseFloat(parts[1]);
      if (!Number.isFinite(time) || !Number.isFinite(rawBeatLength) || Math.abs(time) > MAX_OBJECT_TIME_MS) {
        continue;
      }

      // `osu file format` v4 and earlier omit the uninherited column entirely;
      // there the sign of beatLength is the discriminator (negative values are
      // inherited slider-velocity multipliers). Treating those as uninherited
      // silently drops every SV change on legacy beatmaps.
      const uninherited = parts.length > 6
        ? parts[6].trim() === '1'
        : rawBeatLength > 0;
      // Only a real tempo is held to the range: a negative value on a
      // greenline is a slider velocity, clamped where it is read.
      const beatLength = uninherited && rawBeatLength > 0
        ? clamp(rawBeatLength, MIN_BEAT_LENGTH, MAX_BEAT_LENGTH)
        : rawBeatLength;
      const rawMeter = Number.parseInt(parts[2], 10);
      const meter = Number.isFinite(rawMeter) && rawMeter > 0 ? clamp(rawMeter, 1, 64) : 4;

      timingPoints.push({
        time,
        beatLength,
        meter,
        // Every timing point carries a sample bank and a volume, inherited ones
        // included -- greenlines are how a mapper rides hitsound dynamics
        // through a map, so these are not optional detail.
        sampleSet: parseSampleSetIndex(parts[3]),
        sampleIndex: Number.parseInt(parts[4], 10) || 0,
        volume: parseSampleVolume(parts[5]),
        uninherited,
        effects: Number.parseInt(parts[7], 10) || 0,
      });
      continue;
    }

    if (section === 'hitobjects') {
      hitObjectLines.push(trimmed);
    }
  }

  timingPoints.sort((a, b) => (a.time - b.time) || (Number(b.uninherited) - Number(a.uninherited)));
  // Built before the hit objects so slider durations are timed by the same
  // lookup the converters and the renderer use afterwards.
  const timingControlPoints = timingPoints.map(toTimingControlPoint);

  const parseSampleData = (sampleString) => {
    const parts = String(sampleString || '').split(':');
    const parseSet = (value) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    return {
      normalSet: parseSet(parts[0]),
      additionSet: parseSet(parts[1]),
      customIndex: parseSet(parts[2]),
      volume: parseSet(parts[3]),
      filename: parts.slice(4).join(':') || '',
    };
  };

  let truncatedAtIndex = -1;
  for (let lineIndex = 0; lineIndex < hitObjectLines.length; lineIndex += 1) {
    const parts = hitObjectLines[lineIndex].split(',');
    if (parts.length < 5) {
      continue;
    }

    const rawX = parseFloat(parts[0]);
    const rawY = parseFloat(parts[1]);
    const time = parseInt(parts[2], 10);
    const type = parseInt(parts[3], 10);
    const hitSound = parseInt(parts[4], 10);

    if (
      !Number.isFinite(rawX) || !Number.isFinite(rawY) || !Number.isFinite(time) || !Number.isFinite(type)
      || Math.abs(time) > MAX_OBJECT_TIME_MS
    ) {
      continue;
    }

    if (objects.length >= maxObjects) {
      truncatedAtIndex = lineIndex;
      break;
    }

    const x = clampCoordinate(rawX);
    const y = clampCoordinate(rawY);

    const isSlider = (type & 2) !== 0;
    const isSpinner = (type & 8) !== 0;
    const isHold = (type & 128) !== 0;
    const kind = isSlider ? 'slider' : (isSpinner ? 'spinner' : (isHold ? 'hold' : 'circle'));

    let endTime = time;
    let sliderPoints = [];
    let sliderCurveType = 'B';
    let slides = 1;
    let length = 0;
    let sliderEdgeSounds = [];
    let sliderEdgeSets = [];
    let sampleData = parseSampleData('');

    if (isSlider) {
      if (parts.length >= 8) {
        const pathString = parts[5] || '';
        const firstToken = pathString.split('|')[0] || '';
        sliderCurveType = firstToken.trim().charAt(0).toUpperCase() || 'B';
        slides = Math.min(MAX_SLIDER_SLIDES, Math.max(1, parseInt(parts[6], 10) || 1));
        length = clamp(parseFloat(parts[7]) || 0, 0, MAX_COORDINATE);
        const rawEdgeSounds = (parts[8] || '').trim();
        sliderEdgeSounds = rawEdgeSounds
          ? rawEdgeSounds.split('|').map((value) => {
            const parsed = Number.parseInt(value, 10);
            return Number.isFinite(parsed) ? parsed : undefined;
          })
          : [];
        const rawEdgeSets = (parts[9] || '').trim();
        sliderEdgeSets = rawEdgeSets
          ? rawEdgeSets.split('|').map((value) => {
            const components = value.split(':').map((component) => Number.parseInt(component, 10));
            return components.length >= 2 && Number.isFinite(components[0]) && Number.isFinite(components[1])
              ? [components[0], components[1]]
              : null;
          })
          : [];
        sampleData = parseSampleData(parts[10]);

        const timing = getTimingStateAt(timingControlPoints, time);
        const duration = (length / (sliderMultiplier * 100 * timing.svMultiplier)) * timing.beatLength * slides;
        endTime = time + Math.max(0, Math.round(duration));

        sliderPoints = parseSliderPath(pathString)
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
          .map((point) => ({ x: clampCoordinate(point.x), y: clampCoordinate(point.y) }));
      }
    } else if (isSpinner) {
      const parsedEndTime = parseInt(parts[5], 10);
      endTime = Number.isFinite(parsedEndTime) ? parsedEndTime : time;
      sampleData = parseSampleData(parts[6]);
    } else if (isHold) {
      const holdData = parts[5] || '';
      const firstColon = holdData.indexOf(':');
      const parsedEndTime = parseInt(firstColon >= 0 ? holdData.slice(0, firstColon) : holdData, 10);
      endTime = Number.isFinite(parsedEndTime) ? parsedEndTime : time;
      sampleData = parseSampleData(firstColon >= 0 ? holdData.slice(firstColon + 1) : '');
    } else {
      sampleData = parseSampleData(parts[5]);
    }

    const sampleSets = [sampleData.normalSet, sampleData.additionSet]
      .filter((set) => Number.isFinite(set) && set > 0);
    const nodeSamples = sliderEdgeSets.map((set, index) => ({
      normalSet: Number.isFinite(set?.[0]) ? set[0] : sampleData.normalSet,
      additionSet: Number.isFinite(set?.[1]) ? set[1] : sampleData.additionSet,
      edgeIndex: index,
    }));

    objects.push({
      x,
      y,
      time,
      // NaN from a duration that overflowed reads as "no length" rather than
      // poisoning every comparison made against it.
      endTime: Number.isFinite(endTime) ? clamp(endTime, time, MAX_OBJECT_TIME_MS) : time,
      kind,
      type,
      sourceType: type,
      hitSound: Number.isFinite(hitSound) ? hitSound : 0,
      sampleSet: sampleData.normalSet,
      additionSet: sampleData.additionSet,
      customIndex: sampleData.customIndex,
      sampleVolume: sampleData.volume,
      sampleFilename: sampleData.filename,
      sampleSets,
      nodeSamples,
      sliderPoints,
      sliderCurveType,
      slides,
      length,
      sliderEdgeSounds,
      sliderEdgeSets,
      newCombo: (type & 4) !== 0,
      comboSkip: (type >> 4) & 0b111,
    });
  }

  objects.sort((a, b) => a.time - b.time);

  let maxObjectTime = 0;
  for (const object of objects) {
    if (object.endTime > maxObjectTime) {
      maxObjectTime = object.endTime;
    }
  }

  // When the object cap truncates a map, the timeline must still span the real
  // beatmap: deriving the duration from the last *kept* object left the second
  // half of a marathon unreachable by the scrubber. Reading just the timestamp
  // of the dropped lines is cheap and keeps the duration honest.
  const isTruncated = truncatedAtIndex !== -1;
  if (isTruncated) {
    for (let index = truncatedAtIndex; index < hitObjectLines.length; index += 1) {
      const parts = hitObjectLines[index].split(',');
      if (parts.length < 5) {
        continue;
      }
      const rawX = parseFloat(parts[0]);
      const rawY = parseFloat(parts[1]);
      const time = Number.parseInt(parts[2], 10);
      const type = Number.parseInt(parts[3], 10);
      if (
        !Number.isFinite(rawX) || !Number.isFinite(rawY)
        || !Number.isFinite(time) || !Number.isFinite(type)
        || Math.abs(time) > MAX_OBJECT_TIME_MS
      ) {
        continue;
      }
      if (time > maxObjectTime) {
        maxObjectTime = time;
      }
    }
  }

  let bpmMin = 0;
  let bpmMax = 0;
  let primaryBpm = 0;
  const uninheritedTimingPoints = timingPoints
    .filter((tp) => tp.uninherited && Number.isFinite(tp.beatLength) && tp.beatLength > 0)
    .map((tp) => ({
      time: tp.time,
      bpm: 60000 / tp.beatLength,
    }))
    .filter((tp) => Number.isFinite(tp.bpm) && tp.bpm > 0);

  if (uninheritedTimingPoints.length > 0) {
    bpmMin = uninheritedTimingPoints[0].bpm;
    bpmMax = uninheritedTimingPoints[0].bpm;
    for (let i = 1; i < uninheritedTimingPoints.length; i += 1) {
      const { bpm } = uninheritedTimingPoints[i];
      if (bpm < bpmMin) bpmMin = bpm;
      if (bpm > bpmMax) bpmMax = bpm;
    }

    let longestSectionDuration = -1;
    for (let i = 0; i < uninheritedTimingPoints.length; i += 1) {
      const sectionStart = uninheritedTimingPoints[i].time;
      const sectionEnd = i + 1 < uninheritedTimingPoints.length
        ? uninheritedTimingPoints[i + 1].time
        : maxObjectTime;
      const duration = Math.max(0, sectionEnd - sectionStart);
      if (duration > longestSectionDuration) {
        longestSectionDuration = duration;
        primaryBpm = uninheritedTimingPoints[i].bpm;
      }
    }

    if (!(Number.isFinite(primaryBpm) && primaryBpm > 0)) {
      primaryBpm = uninheritedTimingPoints[0].bpm;
    }
  }

  const normalizedMode = Number.isFinite(mode) ? clamp(mode, 0, 3) : 0;
  const normalizedOverallDifficulty = clamp(Number.isFinite(overallDifficulty) ? overallDifficulty : 5, 0, 10);
  const normalizedApproachRate = clamp(
    Number.isFinite(approachRate) ? approachRate : normalizedOverallDifficulty,
    0,
    10,
  );
  const normalizedHpDrainRate = clamp(Number.isFinite(hpDrainRate) ? hpDrainRate : 5, 0, 10);
  const normalizedStackLeniency = clamp(Number.isFinite(stackLeniency) ? stackLeniency : 0.7, 0, 1);
  const normalizedCircleSize = clamp(
    Number.isFinite(circleSize) ? circleSize : 5,
    normalizedMode === 3 ? 1 : 0,
    normalizedMode === 3 ? 20 : 10,
  );

  return {
    objects,
    circleSize: normalizedCircleSize,
    approachRate: normalizedApproachRate,
    overallDifficulty: normalizedOverallDifficulty,
    hpDrainRate: normalizedHpDrainRate,
    stackLeniency: normalizedStackLeniency,
    mode: normalizedMode,
    beatmapVersion: Number.isFinite(beatmapVersion) ? beatmapVersion : 14,
    sliderMultiplier: Number.isFinite(sliderMultiplier) ? sliderMultiplier : 1.0,
    sliderTickRate: Number.isFinite(sliderTickRate) ? sliderTickRate : 1.0,
    bpmMin,
    bpmMax,
    primaryBpm: Number.isFinite(primaryBpm) && primaryBpm > 0 ? primaryBpm : 0,
    timingPoints: uninheritedTimingPoints,
    defaultSampleSet,
    timingControlPoints,
    bookmarks,
    comboColours: parseColours(content),
    maxObjectTime,
    hitObjectCount: hitObjectLines.length,
    renderedObjectCount: objects.length,
    truncated: isTruncated,
  };
};

export const parseBreakPeriods = (content) => {
  let inEvents = false;
  const rawBreaks = [];
  const lines = content.split(/\r\n|\r|\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inEvents = trimmed.toLowerCase() === '[events]';
      continue;
    }

    if (!inEvents || trimmed.startsWith('//')) {
      continue;
    }

    const parts = trimmed.split(',').map((part) => part.trim());
    if (parts.length < 3) {
      continue;
    }

    const typeToken = parts[0];
    if (typeToken !== '2' && typeToken.toLowerCase() !== 'break') {
      continue;
    }

    const rawStart = Number.parseInt(parts[1], 10);
    const rawEnd = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      continue;
    }

    const startTime = clamp(rawStart, 0, MAX_OBJECT_TIME_MS);
    const endTime = clamp(rawEnd, 0, MAX_OBJECT_TIME_MS);
    if (endTime > startTime) {
      rawBreaks.push({ start: startTime, end: endTime });
      if (rawBreaks.length >= MAX_BREAK_PERIODS) {
        break;
      }
    }
  }

  rawBreaks.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const merged = [];
  for (const period of rawBreaks) {
    const last = merged[merged.length - 1];
    if (last && period.start <= last.end) {
      last.end = Math.max(last.end, period.end);
    } else {
      merged.push(period);
    }
  }

  return merged;
};

export const parseSliderPath = (pathString) => {
  if (!pathString) return [];

  const points = [];
  const parts = pathString.split('|', MAX_SLIDER_CONTROL_POINTS + 1);

  for (let i = 1; i < parts.length; i += 1) {
    const coords = parts[i].split(':');
    if (coords.length === 2) {
      points.push({
        x: parseFloat(coords[0]),
        y: parseFloat(coords[1]),
      });
    }
  }

  return points;
};

export const parseColours = (content) => {
  const colours = [];
  let inColours = false;
  const lines = content.split(/\r\n|\r|\n/);

  for (const line of lines) {
    const commentIndex = line.indexOf('//');
    const trimmed = (commentIndex >= 0 ? line.slice(0, commentIndex) : line).trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inColours = trimmed.toLowerCase() === '[colours]';
      continue;
    }

    if (!inColours) continue;

    // Case-sensitive on purpose: osu!lazer's LegacyBeatmapDecoder matches the
    // "Combo" prefix with StringComparison.Ordinal, so `combo3:` is not a
    // combo colour. Covered by tests/parser.test.js.
    const match = trimmed.match(/^Combo(\d+)\s*:\s*(.*)$/);
    if (!match) continue;

    const comboNumber = Number.parseInt(match[1], 10);
    if (!Number.isFinite(comboNumber) || comboNumber < 1 || comboNumber > 8) continue;

    const components = match[2].split(',').map((component) => component.trim());
    if (components.length !== 3 && components.length !== 4) continue;

    const rgb = components.slice(0, 3).map((component) => Number.parseInt(component, 10));
    if (rgb.some((component, index) => (
      !/^\d+$/.test(components[index]) || component < 0 || component > 255
    ))) {
      continue;
    }

    // osu!lazer accepts an optional fourth component in beatmap colours but
    // ignores it, matching osu!stable's [Colours] behavior.
    if (components.length === 4 && (!/^\d+$/.test(components[3]) || Number.parseInt(components[3], 10) > 255)) {
      continue;
    }

    colours.push({ r: rgb[0], g: rgb[1], b: rgb[2] });
  }

  return colours;
};
