export const parseMetadata = (content) => {
  const data = {};
  let section = '';

  content.split(/\r?\n/).forEach((line) => {
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
  let beatmapSetID = data.BeatmapSetID || 'Unknown';
  const idNum = parseInt(beatmapSetID, 10);
  if (!Number.isNaN(idNum) && idNum > 0) {
    beatmapSetID = `https://osu.ppy.sh/beatmapsets/${beatmapSetID}`;
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
    previewTime: Number.isFinite(data.PreviewTime) ? data.PreviewTime : -1,
  };
};

export const parseMapPreviewData = (content, options = {}) => {
  const maxObjects = Number.isFinite(options?.maxObjects) && options.maxObjects > 0
    ? Math.floor(options.maxObjects)
    : 8000;

  const timingPoints = [];
  const objects = [];

  let section = '';
  let sliderMultiplier = 1.0;
  let circleSize = 5;
  let approachRate = 5;
  let overallDifficulty = 5;
  let stackLeniency = 0.7;
  let mode = 0;

  const lines = content.split(/\r?\n/);

  const getTiming = (time) => {
    let activeBeatLength = 60000 / 120;
    let activeSv = 1.0;

    for (const tp of timingPoints) {
      if (tp.time > time) {
        break;
      }

      if (tp.uninherited && tp.beatLength > 0) {
        activeBeatLength = tp.beatLength;
        activeSv = 1.0;
      } else if (!tp.uninherited && tp.beatLength < 0) {
        activeSv = -100 / tp.beatLength;
      }
    }

    return { beatLength: activeBeatLength, sv: activeSv > 0 ? activeSv : 1.0 };
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) {
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
        }
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
        sliderMultiplier = value || 1.0;
      } else if (key === 'circlesize') {
        circleSize = value;
      } else if (key === 'approachrate') {
        approachRate = value;
      } else if (key === 'overalldifficulty') {
        overallDifficulty = value;
      }
      continue;
    }

    if (section === 'timingpoints') {
      const parts = trimmed.split(',');
      if (parts.length < 2) {
        continue;
      }

      const time = parseInt(parts[0], 10);
      const beatLength = parseFloat(parts[1]);
      if (!Number.isFinite(time) || !Number.isFinite(beatLength)) {
        continue;
      }

      timingPoints.push({
        time,
        beatLength,
        uninherited: parts.length > 6 ? parts[6] === '1' : true,
      });
      continue;
    }

    if (section !== 'hitobjects') {
      continue;
    }

    if (objects.length >= maxObjects) {
      continue;
    }

    const parts = trimmed.split(',');
    if (parts.length < 5) {
      continue;
    }

    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    const time = parseInt(parts[2], 10);
    const type = parseInt(parts[3], 10);
    const hitSound = parseInt(parts[4], 10);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(time) || !Number.isFinite(type)) {
      continue;
    }

    const isSlider = (type & 2) !== 0;
    const isSpinner = (type & 8) !== 0;
    const isHold = (type & 128) !== 0;
    const kind = isSlider ? 'slider' : (isSpinner ? 'spinner' : (isHold ? 'hold' : 'circle'));

    let endTime = time;
    let sliderPoints = [];
    let sliderCurveType = 'B';
    let slides = 1;
    let length = 0;

    if (isSlider) {
      if (parts.length >= 8) {
        const pathString = parts[5] || '';
        const firstToken = pathString.split('|')[0] || '';
        sliderCurveType = firstToken.trim().charAt(0).toUpperCase() || 'B';
        slides = parseInt(parts[6], 10) || 1;
        length = parseFloat(parts[7]) || 0;

        const timing = getTiming(time);
        const duration = (length / (sliderMultiplier * 100 * timing.sv)) * timing.beatLength * slides;
        endTime = time + Math.max(0, Math.round(duration));

        sliderPoints = parseSliderPath(pathString)
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      }
    } else if (isSpinner) {
      endTime = parseInt(parts[5], 10) || time;
    } else if (isHold) {
      const holdData = parts[5] || '';
      endTime = parseInt(holdData.split(':')[0], 10) || time;
    }

    objects.push({
      x,
      y,
      time,
      endTime: Math.max(time, endTime),
      kind,
      hitSound: Number.isFinite(hitSound) ? hitSound : 0,
      sliderPoints,
      sliderCurveType,
      slides,
      length,
      newCombo: (type & 4) !== 0,
      comboSkip: (type >> 4) & 0b111,
    });
  }

  let maxObjectTime = 0;
  for (const object of objects) {
    if (object.endTime > maxObjectTime) {
      maxObjectTime = object.endTime;
    }
  }

  let bpmMin = 0;
  let bpmMax = 0;
  const uninheritedBpms = timingPoints
    .filter((tp) => tp.uninherited && Number.isFinite(tp.beatLength) && tp.beatLength > 0)
    .map((tp) => 60000 / tp.beatLength)
    .filter((bpm) => Number.isFinite(bpm) && bpm > 0);

  if (uninheritedBpms.length > 0) {
    bpmMin = Math.min(...uninheritedBpms);
    bpmMax = Math.max(...uninheritedBpms);
  }

  return {
    objects,
    circleSize: Number.isFinite(circleSize) ? circleSize : 5,
    approachRate: Number.isFinite(approachRate) ? approachRate : (Number.isFinite(overallDifficulty) ? overallDifficulty : 5),
    overallDifficulty: Number.isFinite(overallDifficulty) ? overallDifficulty : 5,
    stackLeniency: Number.isFinite(stackLeniency) ? stackLeniency : 0.7,
    mode: Number.isFinite(mode) ? Math.min(Math.max(mode, 0), 3) : 0,
    sliderMultiplier: Number.isFinite(sliderMultiplier) ? sliderMultiplier : 1.0,
    bpmMin,
    bpmMax,
    comboColours: parseColours(content),
    maxObjectTime,
  };
};

export const parseBreakPeriods = (content) => {
  let inEvents = false;
  const breaks = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inEvents = trimmed === '[Events]';
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

    const startTime = Number.parseInt(parts[1], 10);
    const endTime = Number.parseInt(parts[2], 10);
    if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime) {
      breaks.push({ start: startTime, end: endTime });
    }
  }

  return breaks;
};

export const parseSliderPath = (pathString) => {
  if (!pathString) return [];

  const points = [];
  const parts = pathString.split('|');

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
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inColours = trimmed.toLowerCase() === '[colours]';
      continue;
    }

    if (!inColours) continue;

    const match = trimmed.match(/^(Combo\d+)\s*:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/i);
    if (match) {
      colours.push({
        r: parseInt(match[2], 10),
        g: parseInt(match[3], 10),
        b: parseInt(match[4], 10),
      });
    }
  }

  return colours;
};
