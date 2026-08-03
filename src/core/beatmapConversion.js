const MODE_NAMES = ['osu', 'taiko', 'catch', 'mania'];
const OSU_WIDTH = 512;
const DEFAULT_BEAT_LENGTH = 500;
const TAIKO_VELOCITY_MULTIPLIER = 1.4;
const SWELL_HIT_MULTIPLIER = 1.65;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const numberOr = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeMode = (mode) => {
  if (typeof mode === 'string') {
    const normalized = mode.trim().toLowerCase();
    if (normalized === 'fruits' || normalized === 'catch') {
      return 2;
    }
    const namedMode = MODE_NAMES.indexOf(normalized);
    if (namedMode >= 0) {
      return namedMode;
    }
  }

  const numericMode = Number(mode);
  return Number.isInteger(numericMode) && numericMode >= 0 && numericMode <= 3
    ? numericMode
    : null;
};

const cloneSamples = (samples) => (Array.isArray(samples)
  ? samples.map((sample) => (Array.isArray(sample) ? [...sample] : { ...sample }))
  : []);

const cloneObject = (object) => ({
  ...object,
  sliderPoints: Array.isArray(object?.sliderPoints)
    ? object.sliderPoints.map((point) => ({ ...point }))
    : [],
  sliderEdgeSounds: Array.isArray(object?.sliderEdgeSounds)
    ? [...object.sliderEdgeSounds]
    : [],
  sliderEdgeSets: Array.isArray(object?.sliderEdgeSets)
    ? object.sliderEdgeSets.map((set) => (Array.isArray(set) ? [...set] : set))
    : [],
  nodeSamples: cloneSamples(object?.nodeSamples),
});

const cloneMapData = (mapData) => ({
  ...mapData,
  objects: Array.isArray(mapData?.objects) ? mapData.objects.map(cloneObject) : [],
  timingPoints: Array.isArray(mapData?.timingPoints)
    ? mapData.timingPoints.map((point) => ({ ...point }))
    : [],
  timingControlPoints: Array.isArray(mapData?.timingControlPoints)
    ? mapData.timingControlPoints.map((point) => ({ ...point }))
    : [],
  comboColours: Array.isArray(mapData?.comboColours)
    ? mapData.comboColours.map((colour) => ({ ...colour }))
    : [],
  catchObjects: Array.isArray(mapData?.catchObjects)
    ? mapData.catchObjects.map((object) => ({ ...object }))
    : undefined,
});

const getTimingState = (mapData, time) => {
  let beatLength = DEFAULT_BEAT_LENGTH;
  let svMultiplier = 1;
  let kiai = false;

  for (const point of mapData?.timingControlPoints || []) {
    if (!point || point.time > time) {
      break;
    }

    kiai = Boolean(point.kiai);
    if (point.uninherited && point.beatLength > 0) {
      beatLength = point.beatLength;
      svMultiplier = 1;
    } else if (!point.uninherited && point.svMultiplier > 0) {
      svMultiplier = point.svMultiplier;
    }
  }

  return { beatLength, svMultiplier, kiai };
};

const getSliderSpanTimes = (object) => {
  const slides = Math.max(1, Number.parseInt(object?.slides, 10) || 1);
  const duration = Math.max(0, (object?.endTime || object?.time || 0) - (object?.time || 0));
  const spanDuration = duration / slides;
  return Array.from({ length: slides + 1 }, (_, index) => (
    (object?.time || 0) + (spanDuration * index)
  ));
};

const getSliderEdgeSound = (object, index) => {
  const edgeSounds = Array.isArray(object?.sliderEdgeSounds) ? object.sliderEdgeSounds : [];
  const value = Number(edgeSounds[index]);
  return Number.isFinite(value) ? value : (Number(object?.hitSound) || 0);
};

const getSliderDistance = (object) => {
  if (Number.isFinite(object?.length) && object.length > 0) {
    return object.length;
  }

  const points = Array.isArray(object?.sliderPoints) ? object.sliderPoints : [];
  let distance = 0;
  let previous = { x: object?.x || 0, y: object?.y || 0 };
  for (const point of points) {
    distance += Math.hypot((point.x || 0) - previous.x, (point.y || 0) - previous.y);
    previous = point;
  }
  return distance;
};

const createConvertedObject = (source, overrides = {}) => ({
  ...source,
  ...overrides,
  sliderPoints: [],
  sliderEdgeSounds: [],
  sliderEdgeSets: [],
  nodeSamples: [],
});

// This is the exact xorshift generator used by osu!stable and osu!lazer's
// legacy converters. Keeping it here makes generated conversion patterns
// stable across preview sessions and platforms.
const createLegacyRandom = (seed) => {
  let x = (Number(seed) || 0) >>> 0;
  let y = 842502087;
  let z = 3579807591;
  let w = 273326509;

  const nextUInt = () => {
    const t = (x ^ (x << 11)) >>> 0;
    x = y;
    y = z;
    z = w;
    w = (w ^ (w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return w;
  };

  return {
    nextUInt,
    next: (upperBound) => Math.floor((nextUInt() & 0x7fffffff) / 0x80000000 * upperBound),
    nextDouble: () => (nextUInt() & 0x7fffffff) / 0x80000000,
    nextBool: () => (nextUInt() & 1) === 1,
  };
};

const getManiaConversionSeed = (mapData) => (
  ((Math.round((numberOr(mapData?.hpDrainRate ?? mapData?.drainRate, 5) + numberOr(mapData?.circleSize, 5))) * 20)
    + Math.trunc(numberOr(mapData?.overallDifficulty, 5) * 41.2)
    + Math.round(numberOr(mapData?.approachRate, 5))) | 0
);

const getManiaKeyCount = (mapData) => {
  const circleSize = Math.round(numberOr(mapData?.circleSize, 5));
  const overallDifficulty = Math.round(numberOr(mapData?.overallDifficulty, 5));
  const objects = Array.isArray(mapData?.objects) ? mapData.objects : [];
  const endTimeObjects = objects.filter((object) => object.kind === 'slider' || object.kind === 'spinner').length;
  const specialObjectRatio = objects.length > 0 ? endTimeObjects / objects.length : 0;

  if (normalizeMode(mapData?.mode) === 3) {
    return Math.max(1, circleSize);
  }
  if (specialObjectRatio < 0.2) {
    return 7;
  }
  if (specialObjectRatio < 0.3 || circleSize >= 5) {
    return overallDifficulty > 5 ? 7 : 6;
  }
  if (specialObjectRatio > 0.6) {
    return overallDifficulty > 4 ? 5 : 4;
  }
  return clamp(overallDifficulty + 1, 4, 7);
};

const getManiaStageLayout = (mapData, keys) => {
  const sourceMode = normalizeMode(mapData?.mode);
  if (sourceMode === 3 && Number.isFinite(mapData?.mania?.stageCount)) {
    const stageCount = Math.max(1, Math.floor(mapData.mania.stageCount));
    const columnsPerStage = Math.max(1, Math.floor(mapData.mania.columnsPerStage || keys));
    return { stageCount, columnsPerStage };
  }

  // The current preview only renders one stage, but retaining this metadata
  // is important for native legacy maps and future dual-stage handling.
  return { stageCount: 1, columnsPerStage: keys };
};

const getColumnFromX = (x, keys) => clamp(
  Math.floor((clamp(Number(x) || 0, 0, OSU_WIDTH - 0.001) / OSU_WIDTH) * keys),
  0,
  keys - 1,
);

const getColumnX = (column, keys) => ((column + 0.5) / keys) * OSU_WIDTH;

const getSourceSampleNames = (source) => {
  const names = [];
  if (source?.sampleSet) names.push(String(source.sampleSet).toLowerCase());
  if (source?.additionSet) names.push(String(source.additionSet).toLowerCase());
  for (const sample of source?.samples || []) {
    if (typeof sample === 'string') names.push(sample.toLowerCase());
    else if (sample?.name) names.push(String(sample.name).toLowerCase());
  }
  return names;
};

const hasSample = (source, name) => getSourceSampleNames(source).some((value) => value.includes(name));

const getConversionDifficulty = (mapData) => clamp(
  numberOr(mapData?.overallDifficulty, 5)
    + numberOr(mapData?.circleSize, 5) * 0.1
    + numberOr(mapData?.hpDrainRate ?? mapData?.drainRate, 5) * 0.08,
  0,
  10,
);

const getManiaNoteCount = (keys, difficulty, source, random, type) => {
  if (keys <= 2 || type === 'spinner') return 1;
  if (hasSample(source, 'clap')) return 2;

  const p2 = difficulty > 6.5 ? 0.62 : (difficulty > 4 ? 0.15 : 0);
  const p3 = difficulty > 6.5 ? 0.22 : (difficulty > 4 ? 0.04 : 0);
  const p4 = difficulty > 7.5 ? 0.05 : 0;
  const value = random.nextDouble();
  if (keys >= 7 && value < p4) return 4;
  if (keys >= 5 && value < p3) return 3;
  if (keys >= 4 && value < p2) return 2;
  return 1;
};

const getOrderedColumns = (keys, preferred, used, direction) => {
  const result = [];
  for (let offset = 0; offset < keys; offset += 1) {
    const column = (preferred + (direction * offset) + (keys * 2)) % keys;
    if (!used.has(column)) result.push(column);
  }
  for (let column = 0; column < keys; column += 1) {
    if (!used.has(column) && !result.includes(column)) result.push(column);
  }
  return result;
};

const createManiaPatternGenerator = (mapData, keys, random) => {
  const difficulty = getConversionDifficulty(mapData);
  const columnsByTime = new Map();
  const previousColumns = [];
  const previousTimes = [];
  let lastColumn = Math.floor(keys / 2);
  let stairDirection = 1;

  const remember = (time, columns) => {
    previousColumns.push([...columns]);
    previousTimes.push(time);
    while (previousColumns.length > 7) previousColumns.shift();
    while (previousTimes.length > 7) previousTimes.shift();
    if (columns.length > 0) {
      lastColumn = columns[columns.length - 1];
      if (lastColumn === 0 || lastColumn === keys - 1) stairDirection *= -1;
    }
  };

  const getDensity = (time) => {
    if (previousTimes.length < 2) return Number.POSITIVE_INFINITY;
    return (time - previousTimes[0]) / previousTimes.length;
  };

  const columnsForTime = (time) => {
    const key = Math.round(time * 1000) / 1000;
    if (!columnsByTime.has(key)) columnsByTime.set(key, new Set());
    return columnsByTime.get(key);
  };

  const chooseColumns = (source, time, count, forceFree = false) => {
    const used = columnsForTime(time);
    const sourceColumn = getColumnFromX(source?.x, keys);
    const density = getDensity(time);
    const separation = previousTimes.length > 0 ? time - previousTimes.at(-1) : Number.POSITIVE_INFINITY;
    const fastStream = separation <= 125;
    const lowDensityStream = separation <= 150 && Math.abs(sourceColumn - lastColumn) <= 1;
    let preferred = sourceColumn;

    if (fastStream || lowDensityStream) {
      preferred = (lastColumn + stairDirection + keys) % keys;
    } else if (density < (getTimingState(mapData, time).beatLength / 2.5)) {
      preferred = lastColumn;
    }

    const direction = (random.nextBool() ? 1 : -1);
    const ordered = getOrderedColumns(keys, preferred, used, fastStream ? stairDirection : direction);
    const chosen = [];
    for (const column of ordered) {
      if (forceFree && previousColumns.at(-1)?.includes(column)) continue;
      chosen.push(column);
      used.add(column);
      if (chosen.length >= count) break;
    }
    if (chosen.length === 0) {
      const fallback = preferred % keys;
      chosen.push(fallback);
      used.add(fallback);
    }
    remember(time, chosen);
    return chosen;
  };

  return { chooseColumns };
};

const convertToTaiko = (mapData) => {
  const convertedObjects = [];

  for (const source of mapData.objects || []) {
    if (source.kind === 'slider') {
      const spanTimes = getSliderSpanTimes(source);
      const spans = Math.max(1, Number.parseInt(source.slides, 10) || 1);
      const timing = getTimingState(mapData, source.time);
      const sliderDistance = getSliderDistance(source);
      const sliderMultiplier = Math.max(0.1, Number(mapData.sliderMultiplier) || 1.4);
      const distance = sliderDistance * TAIKO_VELOCITY_MULTIPLIER * spans;
      const scoringDistance = 100 * sliderMultiplier * TAIKO_VELOCITY_MULTIPLIER;
      const taikoVelocity = scoringDistance;
      const conversionDuration = Math.max(1, Math.floor((distance / taikoVelocity) * timing.beatLength));
      const tickSpacing = Math.min(
        timing.beatLength / Math.max(0.1, Number(mapData.sliderTickRate) || 1),
        conversionDuration / spans,
      );
      const osuVelocity = taikoVelocity * (1000 / Math.max(1, timing.beatLength));
      const shouldSplitIntoHits = tickSpacing > 0
        && ((distance / Math.max(0.001, osuVelocity)) * 1000 < (2 * timing.beatLength));

      if (shouldSplitIntoHits) {
        let edgeIndex = 0;
        for (let time = source.time; time <= source.time + conversionDuration + (tickSpacing / 8); time += tickSpacing) {
          const clampedTime = Math.min(time, source.time + conversionDuration);
          convertedObjects.push(createConvertedObject(source, {
            time: clampedTime,
            endTime: clampedTime,
            kind: 'circle',
            taikoType: 'hit',
            taikoStrong: hasSample(source, 'finish') || (Number(source.hitSound) & 4) !== 0,
            hitSound: getSliderEdgeSound(source, edgeIndex),
            newCombo: edgeIndex === 0 && Boolean(source.newCombo),
            comboSkip: edgeIndex === 0 ? source.comboSkip : 0,
          }));
          edgeIndex = (edgeIndex + 1) % Math.max(1, spanTimes.length);
          if (clampedTime >= source.time + conversionDuration) break;
        }
      } else {
        convertedObjects.push(createConvertedObject(source, {
          endTime: source.time + conversionDuration,
          kind: 'hold',
          taikoType: 'drumroll',
          taikoTickSpacing: tickSpacing,
          taikoRequiredHits: Math.max(1, Math.ceil(conversionDuration / Math.max(1, tickSpacing))),
          hitSound: getSliderEdgeSound(source, 0),
        }));
      }
      continue;
    }

    if (source.kind === 'spinner' || source.kind === 'hold') {
      const duration = Math.max(1, source.endTime - source.time);
      const difficulty = clamp(Number(mapData.overallDifficulty) || 5, 0, 10);
      const requiredHitsPerSecond = (3 + ((difficulty / 10) * 4.5)) * SWELL_HIT_MULTIPLIER;
      convertedObjects.push(createConvertedObject(source, {
        kind: 'spinner',
        taikoType: 'swell',
        taikoRequiredHits: Math.max(1, Math.floor((duration / 1000) * requiredHitsPerSecond)),
      }));
      continue;
    }

    const hitSound = Number(source.hitSound) || 0;
    convertedObjects.push(createConvertedObject(source, {
      kind: 'circle',
      taikoType: 'hit',
      taikoStrong: hasSample(source, 'finish') || (hitSound & 4) !== 0,
    }));
  }

  return {
    ...mapData,
    mode: 1,
    objects: convertedObjects.sort((a, b) => a.time - b.time),
    conversion: { sourceMode: 0, targetMode: 1, velocityMultiplier: TAIKO_VELOCITY_MULTIPLIER },
  };
};

const getPathPosition = (object, progress) => {
  const points = [{ x: Number(object?.x) || 0, y: Number(object?.y) || 192 }, ...(object?.sliderPoints || [])];
  if (points.length === 1) return points[0];
  const clampedProgress = clamp(progress, 0, 1);
  const distances = [0];
  for (let i = 1; i < points.length; i += 1) {
    distances[i] = distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const total = distances.at(-1) || 1;
  const target = total * clampedProgress;
  for (let i = 1; i < distances.length; i += 1) {
    if (target <= distances[i]) {
      const span = Math.max(0.001, distances[i] - distances[i - 1]);
      const ratio = (target - distances[i - 1]) / span;
      return {
        x: points[i - 1].x + ((points[i].x - points[i - 1].x) * ratio),
        y: points[i - 1].y + ((points[i].y - points[i - 1].y) * ratio),
      };
    }
  }
  return points.at(-1);
};

const buildCatchObjects = (mapData) => {
  const result = [];
  let renderId = 0;
  const add = (source, time, x, type, extra = {}) => {
    result.push({
      time,
      x: clamp(Number(x) || 0, 0, OSU_WIDTH),
      type,
      sourceObjectIndex: source.index,
      comboIndex: source.comboIndex,
      comboIndexWithOffsets: source.comboIndexWithOffsets,
      renderId: renderId++,
      ...extra,
    });
  };

  for (let index = 0; index < (mapData.objects || []).length; index += 1) {
    const source = mapData.objects[index];
    if (!source) continue;
    const indexedSource = { ...source, index };

    if (source.kind === 'slider') {
      const spanTimes = getSliderSpanTimes(source);
      const spanCount = Math.max(1, spanTimes.length - 1);
      const beatLength = getTimingState(mapData, source.time).beatLength;
      const tickInterval = beatLength / Math.max(0.1, Number(mapData.sliderTickRate) || 1);
      const tinyInterval = Math.max(45, Math.min(90, tickInterval / 4));
      add(indexedSource, source.time, source.x, 'fruit');
      for (let span = 0; span < spanCount; span += 1) {
        const start = spanTimes[span];
        const end = spanTimes[span + 1];
        const duration = Math.max(1, end - start);
        const direction = span % 2 === 0 ? 1 : -1;
        const anchors = [start];

        if (tickInterval > 0) {
          for (let tickTime = start + tickInterval; tickTime < (end - 0.001); tickTime += tickInterval) {
            const ratio = (tickTime - start) / duration;
            const position = getPathPosition(source, direction > 0 ? ratio : 1 - ratio);
            anchors.push(tickTime);
            add(indexedSource, tickTime, position.x, 'droplet', { sliderSpan: span });
          }
        }

        anchors.push(end);
        if (end > source.time && end <= source.endTime) {
          const position = getPathPosition(source, direction > 0 ? 1 : 0);
          add(indexedSource, end, position.x, 'fruit', { sliderSpan: span });
        }

        anchors.sort((a, b) => a - b);
        for (let anchorIndex = 1; anchorIndex < anchors.length; anchorIndex += 1) {
          const segmentStart = anchors[anchorIndex - 1];
          const segmentEnd = anchors[anchorIndex];
          for (let tinyTime = segmentStart + tinyInterval; tinyTime < (segmentEnd - 0.001); tinyTime += tinyInterval) {
            const ratio = (tinyTime - start) / duration;
            const position = getPathPosition(source, direction > 0 ? ratio : 1 - ratio);
            add(indexedSource, tinyTime, position.x, 'tinyDroplet', { sliderSpan: span });
          }
        }
      }
      continue;
    }

    if (source.kind === 'spinner' || source.kind === 'hold') {
      const duration = Math.max(1, source.endTime - source.time);
      const timing = getTimingState(mapData, source.time);
      const count = Math.max(18, Math.ceil(duration / Math.max(20, timing.beatLength / 8)));
      for (let i = 0; i <= count; i += 1) {
        const time = source.time + ((duration * i) / count);
        const seed = ((source.time * 0.0017) + (i * 0.61803398875)) | 0;
        const random = createLegacyRandom(seed);
        add(indexedSource, time, random.nextDouble() * OSU_WIDTH, 'banana');
      }
      continue;
    }

    add(indexedSource, source.time, source.x, 'fruit');
  }

  return result.sort((a, b) => a.time - b.time);
};

const normalizeNativeMania = (mapData) => {
  const keys = Math.max(1, Math.round(Number(mapData.circleSize) || 4));
  const layout = getManiaStageLayout(mapData, keys);
  const normalizedObjects = [];
  for (const source of mapData.objects || []) {
    const column = Number.isInteger(source.column)
      ? clamp(source.column, 0, keys - 1)
      : getColumnFromX(source.x, keys);
    const kind = source.kind === 'spinner'
      ? (source.endTime > source.time ? 'hold' : 'circle')
      : source.kind;
    normalizedObjects.push(createConvertedObject(source, {
      kind,
      column,
      stage: Number.isInteger(source.stage) ? source.stage : 0,
      x: getColumnX(column, keys),
      y: 192,
      endTime: kind === 'hold' ? Math.max(source.time, source.endTime) : source.time,
    }));
  }
  return {
    ...mapData,
    objects: normalizedObjects.sort((a, b) => a.time - b.time),
    mania: { stageCount: layout.stageCount, columnsPerStage: layout.columnsPerStage, totalColumns: keys },
  };
};

const convertToMania = (mapData) => {
  const keys = getManiaKeyCount(mapData);
  const random = createLegacyRandom(getManiaConversionSeed(mapData));
  const pattern = createManiaPatternGenerator(mapData, keys, random);
  const convertedObjects = [];

  const pushNote = (source, time, endTime, kind, column, metadata = {}) => {
    convertedObjects.push(createConvertedObject(source, {
      x: getColumnX(column, keys),
      y: 192,
      column,
      stage: 0,
      time,
      endTime,
      kind,
      ...metadata,
    }));
  };

  for (const source of mapData.objects || []) {
    if (source.kind === 'spinner') {
      const duration = Math.max(0, source.endTime - source.time);
      const column = pattern.chooseColumns(source, source.time, 1)[0];
      if (duration >= 100) {
        pushNote(source, source.time, source.endTime, 'hold', column, { maniaSourceType: 'spinner' });
      } else {
        pushNote(source, source.time, source.time, 'circle', column, { maniaSourceType: 'spinner' });
      }
      continue;
    }

    if (source.kind === 'hold') {
      const column = Number.isInteger(source.column)
        ? clamp(source.column, 0, keys - 1)
        : pattern.chooseColumns(source, source.time, 1)[0];
      pushNote(source, source.time, Math.max(source.time, source.endTime), 'hold', column, { maniaSourceType: 'hold' });
      continue;
    }

    if (source.kind === 'slider') {
      const spanTimes = getSliderSpanTimes(source);
      const spans = Math.max(1, spanTimes.length - 1);
      const segmentDuration = (Math.max(0, source.endTime - source.time)) / spans;
      const sourcePosition = { ...source, x: getPathPosition(source, 0.5).x };

      if (segmentDuration <= 90) {
        const column = pattern.chooseColumns(sourcePosition, source.time, 1)[0];
        pushNote(source, source.time, source.endTime, 'hold', column, {
          maniaSourceType: 'slider',
          sliderSpanCount: spans,
          sliderSegmentDuration: segmentDuration,
        });
      } else if (segmentDuration <= 120) {
        for (let span = 0; span <= spans; span += 1) {
          const time = spanTimes[span];
          const column = pattern.chooseColumns(sourcePosition, time, 1, true)[0];
          pushNote(source, time, time, 'circle', column, {
            maniaSourceType: 'slider',
            sliderSpanIndex: span,
            sliderSpanCount: spans,
          });
        }
      } else {
        const column = pattern.chooseColumns(sourcePosition, source.time, 1)[0];
        pushNote(source, source.time, source.endTime, 'hold', column, {
          maniaSourceType: 'slider',
          sliderSpanCount: spans,
          sliderSegmentDuration: segmentDuration,
        });
        if (spans > 1 && segmentDuration <= 200) {
          for (let span = 1; span < spans; span += 1) {
            const time = spanTimes[span];
            const extraColumn = pattern.chooseColumns(sourcePosition, time, 1, true)[0];
            pushNote(source, time, time, 'circle', extraColumn, {
              maniaSourceType: 'slider',
              sliderSpanIndex: span,
              sliderSpanCount: spans,
            });
          }
        }
      }
      continue;
    }

    const noteCount = getManiaNoteCount(
      keys,
      getConversionDifficulty(mapData),
      source,
      random,
      'circle',
    );
    const columns = pattern.chooseColumns(source, source.time, noteCount);
    for (const column of columns) {
      pushNote(source, source.time, source.time, 'circle', column, {
        maniaSourceType: 'circle',
        maniaStrong: columns.length > 1,
      });
    }
  }

  return {
    ...mapData,
    mode: 3,
    circleSize: keys,
    objects: convertedObjects.sort((a, b) => a.time - b.time || a.column - b.column),
    mania: { stageCount: 1, columnsPerStage: keys, totalColumns: keys },
    conversion: {
      sourceMode: 0,
      targetMode: 3,
      keys,
      stageCount: 1,
      columnsPerStage: keys,
      randomSeed: getManiaConversionSeed(mapData),
    },
  };
};

const convertToCatch = (mapData) => ({
  ...mapData,
  mode: 2,
  catchObjects: buildCatchObjects(mapData),
  conversion: { sourceMode: 0, targetMode: 2 },
});

const convertMapForMode = (mapData, requestedMode) => {
  const source = cloneMapData(mapData || { objects: [], mode: 0 });
  const targetMode = normalizeMode(requestedMode);
  const sourceMode = normalizeMode(source.mode) ?? 0;

  if (targetMode === null || targetMode === sourceMode) {
    if (sourceMode === 3) return normalizeNativeMania(source);
    if (sourceMode === 2) return { ...source, catchObjects: source.catchObjects || buildCatchObjects(source) };
    return source;
  }

  // osu!lazer only converts standard maps into another ruleset. A native
  // taiko/catch/mania map must stay in its own ruleset even if a stale URL
  // contains a different target parameter.
  if (sourceMode !== 0) {
    if (sourceMode === 3) return normalizeNativeMania(source);
    if (sourceMode === 2) return { ...source, catchObjects: source.catchObjects || buildCatchObjects(source) };
    return source;
  }

  if (targetMode === 1) return convertToTaiko(source);
  if (targetMode === 2) return convertToCatch(source);
  if (targetMode === 3) return convertToMania(source);
  return source;
};

export {
  MODE_NAMES,
  convertMapForMode,
  createLegacyRandom,
  getManiaConversionSeed,
  getManiaKeyCount,
  normalizeMode,
};
