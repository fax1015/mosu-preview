import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { TimelineRenderer } from '../src/timeline.js';
import { getTimingStateAt } from '../src/core/controlPoints.js';
import { parseBreakPeriods, parseMapPreviewData, parseMetadata } from '../src/parser.js';
import { convertMapForMode } from '../src/core/beatmapConversion.js';
import { buildMiniPalette, extractCoverSeed } from '../src/core/coverPalette.js';
import {
  computeDraggedBounds,
  computeResizedBounds,
  DEFAULT_EMBEDDED_BOUNDS,
  normalizeEmbeddedBounds,
  resolveResumeSnapshot,
  serializeResumeSnapshot,
} from '../src/core/embeddedPlayer.js';
import { drawWavyProgress } from '../src/ui/wavyProgress.js';
import { buildHitsoundEvents } from '../src/audio/hitsounds.js';
import { extractZipEntry } from '../src/audio/zip.js';
import { buildMp3FrameIndex } from '../src/audio/mp3Index.js';
import {
  appendPerformanceResult,
  buildPerformanceRecord,
  getEnvironmentInfo,
  readBuildInfo,
  readPerformanceResults,
} from './performance-results.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ASPIRE_MAP_FILE = resolve(projectRoot, 'scripts', 'benchmark-maps', '5839914.osu');
const DEFAULT_SAMPLE_COUNT = 9;
const PARSER_QUERIES = 8000;
const RENDER_OBJECTS = 60000;

const percentile = (values, ratio) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
};

const summarizeSamples = (samples, iterations) => {
  const perIter = samples.map((sample) => sample / iterations);
  const sorted = [...perIter].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
};

const measure = (run, iterations, sampleCount) => {
  const samples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const start = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      run();
    }
    samples.push(performance.now() - start);
  }
  return summarizeSamples(samples, iterations);
};

const measureAsync = async (run, iterations, sampleCount) => {
  const samples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const start = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await run();
    }
    samples.push(performance.now() - start);
  }
  return summarizeSamples(samples, iterations);
};

const generateBenchmarkStandardOsu = (objectCount = 3000) => {
  const lines = [
    'osu file format v14',
    '',
    '[General]',
    'AudioFilename: audio.mp3',
    'PreviewTime: 12000',
    'Mode: 0',
    '',
    '[Metadata]',
    'Title: Benchmark Map',
    'Artist: mosu',
    'Creator: bench',
    'Version: Stress',
    'BeatmapSetID: 2400000',
    '',
    '[Difficulty]',
    'CircleSize:4',
    'SliderMultiplier:1.4',
    'SliderTickRate:1',
    'ApproachRate:9',
    'OverallDifficulty:7',
    '',
    '[Events]',
    '2,45000,48000',
    '2,90000,93000',
    '',
    '[TimingPoints]',
    '0,500,4,1,0,100,1,0',
    '30000,-80,4,2,1,90,0,1',
    '60000,420,4,1,0,100,1,0',
    '',
    '[HitObjects]',
  ];
  for (let i = 0; i < objectCount; i += 1) {
    const x = 35 + ((i * 71) % 442);
    const y = 35 + ((i * 113) % 314);
    const time = 1000 + (i * 45);
    const hitSound = (i % 16 === 0) ? 14 : ((i % 4 === 0) ? 2 : 0);
    if (i % 3 === 0) {
      const endX = 35 + ((i * 71 + 120) % 442);
      const endY = 35 + ((i * 113 + 80) % 314);
      lines.push(`${x},${y},${time},2,${hitSound},B|${endX}:${endY},2,160,0|2|0,0:0|0:0|0:0,0:0:0:0:`);
    } else {
      lines.push(`${x},${y},${time},1,${hitSound},0:0:0:0:`);
    }
  }
  return lines.join('\n');
};

const buildSyntheticZipFixture = (sizeBytes = 512 * 1024) => {
  // Pseudo-random bytes so deflate behaves like compressed audio rather than trivial zeros.
  const payload = Buffer.allocUnsafe(sizeBytes);
  let seed = 0x12345678;
  for (let i = 0; i < sizeBytes; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    payload.writeUInt32LE(seed, i);
  }
  const compressed = deflateRawSync(payload, { level: 1 });
  const name = Buffer.from('audio.mp3');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(name.length, 26);
  return {
    archive: new Uint8Array(Buffer.concat([header, name, compressed])),
    entry: {
      name: 'audio.mp3',
      compressionMethod: 8,
      compressedSize: compressed.byteLength,
      uncompressedSize: sizeBytes,
      localHeaderOffset: 0,
    },
  };
};

const buildSyntheticMp3Blob = (frameCount = 4500) => {
  // MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding -> 417 bytes/frame (~2 min at 4500 frames).
  const frameLen = 417;
  const bytes = new Uint8Array(frameCount * frameLen);
  for (let i = 0; i < frameCount; i += 1) {
    const offset = i * frameLen;
    bytes[offset] = 0xff;
    bytes[offset + 1] = 0xfb;
    bytes[offset + 2] = 0x90;
    bytes[offset + 3] = 0x00;
  }
  return new Blob([bytes], { type: 'audio/mpeg' });
};

export const runMicroBenchmarks = async ({ sampleCount = DEFAULT_SAMPLE_COUNT } = {}) => {
  const safeSampleCount = Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 100
    ? sampleCount
    : DEFAULT_SAMPLE_COUNT;

  const timingPoints = Array.from({ length: 3000 }, (_, index) => ({
    time: index * 1200,
    beatLength: index % 2 === 0 ? 500 + (index % 7) : -50 - (index % 4),
    uninherited: index % 2 === 0,
  }));
  const queryTimes = Array.from({ length: PARSER_QUERIES }, (_, index) => (
    ((index * 7919) % (timingPoints.length * 1200)) - 2000
  ));

  const referenceTimingAt = (time) => {
    const first = timingPoints.find((point) => point.uninherited && point.beatLength > 0);
    let beatLength = first ? first.beatLength : 500;
    let sv = 1;
    for (const point of timingPoints) {
      if (point.time > time) break;
      if (point.uninherited && point.beatLength > 0) {
        beatLength = point.beatLength;
        sv = 1;
      } else if (!point.uninherited && point.beatLength < 0) {
        sv = -100 / point.beatLength;
      }
    }
    return { beatLength, sv: sv > 0 ? sv : 1 };
  };

  const controlPoints = timingPoints.map((point) => ({
    ...point,
    svMultiplier: !point.uninherited && point.beatLength < 0 ? -100 / point.beatLength : 1,
  }));
  const optimizedTimingAt = (time) => {
    const timing = getTimingStateAt(controlPoints, time);
    return { beatLength: timing.beatLength, sv: timing.svMultiplier };
  };
  for (const time of queryTimes.slice(0, 100)) {
    assert.deepEqual(optimizedTimingAt(time), referenceTimingAt(time));
  }

  const runReferenceTiming = () => {
    let checksum = 0;
    for (const time of queryTimes) {
      const timing = referenceTimingAt(time);
      checksum += timing.beatLength + timing.sv;
    }
    return checksum;
  };
  const runOptimizedTiming = () => {
    let checksum = 0;
    for (const time of queryTimes) {
      const timing = optimizedTimingAt(time);
      checksum += timing.beatLength + timing.sv;
    }
    return checksum;
  };
  assert.equal(runOptimizedTiming(), runReferenceTiming());

  const hadWindow = Object.hasOwn(globalThis, 'window');
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };

  let benchmarks;
  try {
    const context = new Proxy({}, {
      get: (_target, property) => (typeof property === 'string' ? () => {} : undefined),
      set: () => true,
    });
    const canvas = {
      width: 800,
      height: 120,
      clientWidth: 800,
      clientHeight: 120,
      getContext: () => context,
    };
    const objects = Array.from({ length: RENDER_OBJECTS }, (_, index) => ({
      time: index * 60,
      endTime: index * 60,
    }));
    const timeline = new TimelineRenderer(canvas);
    timeline.setBeatmap({ objects, timingControlPoints: [] }, RENDER_OBJECTS * 60);
    timeline.setView(120000, 120000, { animate: false });
    timeline.setTime(180000);
    timeline.render();

    const runReferenceTimeline = () => {
      timeline.viewDensityCache = null;
      timeline.render();
    };
    const runOptimizedTimeline = () => timeline.render();

    runReferenceTimeline();
    runOptimizedTimeline();

    const timingRef = measure(runReferenceTiming, 1, safeSampleCount);
    const timingOpt = measure(runOptimizedTiming, 1, safeSampleCount);
    const timelineRef = measure(runReferenceTimeline, 35, safeSampleCount);
    const timelineOpt = measure(runOptimizedTimeline, 35, safeSampleCount);

    benchmarks = [
      {
        name: 'slider timing lookup (8,000 queries / 3,000 timing points)',
        referenceMs: timingRef.median,
        optimizedMs: timingOpt.median,
        referenceMinMs: timingRef.min,
        referenceP95Ms: timingRef.p95,
        optimizedMinMs: timingOpt.min,
        optimizedP95Ms: timingOpt.p95,
        sampleCount: safeSampleCount,
        minimumSpeedup: 1.1,
      },
      {
        name: 'zoomed timeline frame (60,000 objects)',
        referenceMs: timelineRef.median,
        optimizedMs: timelineOpt.median,
        referenceMinMs: timelineRef.min,
        referenceP95Ms: timelineRef.p95,
        optimizedMinMs: timelineOpt.min,
        optimizedP95Ms: timelineOpt.p95,
        sampleCount: safeSampleCount,
        minimumSpeedup: 1.05,
      },
    ];
  } finally {
    if (hadWindow) {
      globalThis.window = previousWindow;
    } else {
      delete globalThis.window;
    }
  }

  let logSpeedup = 0;
  let passed = true;
  const benchmarkResults = [];
  for (const benchmark of benchmarks) {
    const safeOptimizedMs = Math.max(benchmark.optimizedMs, Number.EPSILON);
    const speedup = benchmark.referenceMs / safeOptimizedMs;
    logSpeedup += Math.log(Math.max(speedup, Number.EPSILON));
    const benchmarkPassed = speedup >= benchmark.minimumSpeedup;
    passed &&= benchmarkPassed;
    benchmarkResults.push({ ...benchmark, speedup, passed: benchmarkPassed });
  }

  // Real extension subsystem throughput benchmarks
  const opSamples = Math.min(safeSampleCount, 7);
  const aspireOsuText = await readFile(ASPIRE_MAP_FILE, 'utf8');
  const standardOsuText = generateBenchmarkStandardOsu(3000);
  const parsedStandard = {
    ...parseMapPreviewData(standardOsuText, { maxObjects: 3000 }),
    breaks: parseBreakPeriods(standardOsuText),
  };

  // Warm paths once
  parseMapPreviewData(aspireOsuText, { maxObjects: 2000 });
  convertMapForMode(parsedStandard, 1);
  convertMapForMode(parsedStandard, 2);
  convertMapForMode(parsedStandard, 3, { maniaKeyCount: 7 });
  buildHitsoundEvents(parsedStandard.objects, {
    samplePoints: parsedStandard.timingControlPoints,
    defaultSampleSet: parsedStandard.defaultSampleSet,
  });

  const zipFixture = buildSyntheticZipFixture(512 * 1024);
  const mp3Blob = buildSyntheticMp3Blob(4500);
  await extractZipEntry(zipFixture.archive, zipFixture.entry);
  await buildMp3FrameIndex(mp3Blob);

  const parseAspireStats = measure(() => {
    parseMetadata(aspireOsuText);
    parseMapPreviewData(aspireOsuText, { maxObjects: 2000 });
    parseBreakPeriods(aspireOsuText);
  }, 1, opSamples);

  const parseStdStats = measure(() => {
    parseMetadata(standardOsuText);
    parseMapPreviewData(standardOsuText, { maxObjects: 3000 });
    parseBreakPeriods(standardOsuText);
  }, 1, opSamples);

  const taikoStats = measure(() => convertMapForMode(parsedStandard, 1), 1, opSamples);
  const catchStats = measure(() => convertMapForMode(parsedStandard, 2), 1, opSamples);
  const maniaStats = measure(() => convertMapForMode(parsedStandard, 3, { maniaKeyCount: 7 }), 1, opSamples);
  const hitsoundStats = measure(() => buildHitsoundEvents(parsedStandard.objects, {
    samplePoints: parsedStandard.timingControlPoints,
    defaultSampleSet: parsedStandard.defaultSampleSet,
  }), 1, opSamples);
  const zipStats = await measureAsync(
    () => extractZipEntry(zipFixture.archive, zipFixture.entry),
    1,
    Math.min(opSamples, 5),
  );
  const mp3Stats = await measureAsync(
    () => buildMp3FrameIndex(mp3Blob),
    1,
    Math.min(opSamples, 5),
  );
  const miniplayerViewport = { width: 1440, height: 900 };
  const miniplayerEdges = ['nw', 'e', 'se', 'w', 's', 'n'];
  const miniplayerLayoutStats = measure(() => {
    let bounds = normalizeEmbeddedBounds(DEFAULT_EMBEDDED_BOUNDS, miniplayerViewport);
    for (let i = 0; i < 2000; i += 1) {
      const collapsed = (i & 1) === 1;
      bounds = computeDraggedBounds({ ...bounds, collapsed }, (i % 11) - 5, (i % 9) - 4, miniplayerViewport);
      bounds = computeResizedBounds(bounds, miniplayerEdges[i % miniplayerEdges.length], (i % 7) - 3, (i % 5) - 2, miniplayerViewport);
      if ((i & 31) === 0) {
        const snap = serializeResumeSnapshot({
          beatmapId: '5839914',
          setId: '2400000',
          mode: 0,
          currentTimeMs: i * 40,
          isPlaying: true,
          collapsed,
        }, 100000);
        resolveResumeSnapshot(snap, 100850);
      }
    }
  }, 1, opSamples);

  const coverPixels = new Uint8ClampedArray(32 * 24 * 4);
  for (let i = 0; i < coverPixels.length; i += 4) {
    const idx = i >> 2;
    coverPixels[i] = (idx * 17) & 255;
    coverPixels[i + 1] = 60 + ((idx * 7) % 140);
    coverPixels[i + 2] = 180 + ((idx * 11) % 75);
    coverPixels[i + 3] = 255;
  }
  const coverPaletteStats = measure(() => {
    for (let i = 0; i < 100; i += 1) {
      buildMiniPalette(extractCoverSeed(coverPixels));
    }
  }, 1, opSamples);

  const waveCtx = new Proxy({}, {
    get: (_target, property) => (typeof property === 'string' ? () => {} : undefined),
    set: () => true,
  });
  const waveColours = { wave: '#b8acff', waveTrack: 'rgba(188,183,206,0.3)', playhead: '#f1eff8' };
  const wavyProgressStats = measure(() => {
    for (let i = 0; i < 200; i += 1) {
      drawWavyProgress(waveCtx, {
        width: 396,
        height: 20,
        headX: 40 + (i * 1.5),
        amplitude: 1,
        shiftPx: i * 1.2,
        loadingMix: 0,
        loadingShiftPx: 0,
        colours: waveColours,
      });
    }
  }, 1, opSamples);

  const operations = [
    { id: 'parse-conic', name: 'Parse conic (5839914.osu)', category: 'parse', medianMs: parseAspireStats.median, p95Ms: parseAspireStats.p95 },
    { id: 'parse-standard', name: 'Parse 3,000 objects (.osu)', category: 'parse', medianMs: parseStdStats.median, p95Ms: parseStdStats.p95 },
    { id: 'convert-taiko', name: 'Convert std → Taiko (3k)', category: 'convert', medianMs: taikoStats.median, p95Ms: taikoStats.p95 },
    { id: 'convert-catch', name: 'Convert std → Catch (3k)', category: 'convert', medianMs: catchStats.median, p95Ms: catchStats.p95 },
    { id: 'convert-mania', name: 'Convert std → Mania 7K (3k)', category: 'convert', medianMs: maniaStats.median, p95Ms: maniaStats.p95 },
    { id: 'hitsounds-build', name: 'Build hitsound events (3k)', category: 'audio', medianMs: hitsoundStats.median, p95Ms: hitsoundStats.p95 },
    { id: 'zip-extract', name: 'Inflate .osz audio (512 KB)', category: 'audio', medianMs: zipStats.median, p95Ms: zipStats.p95 },
    { id: 'mp3-index', name: 'Index MP3 frames (4,500)', category: 'audio', medianMs: mp3Stats.median, p95Ms: mp3Stats.p95 },
    { id: 'cover-palette', name: 'Cover OKLCH palette (100×)', category: 'render', medianMs: coverPaletteStats.median, p95Ms: coverPaletteStats.p95 },
    { id: 'wavy-progress', name: 'Miniplayer wavy bar (200f)', category: 'render', medianMs: wavyProgressStats.median, p95Ms: wavyProgressStats.p95 },
    { id: 'miniplayer-layout', name: 'Miniplayer bounds/resume (2k)', category: 'render', medianMs: miniplayerLayoutStats.median, p95Ms: miniplayerLayoutStats.p95 },
  ];

  const overallSpeedup = Math.exp(logSpeedup / benchmarks.length);
  return {
    benchmarks: benchmarkResults,
    operations,
    overallSpeedup,
    passed,
  };
};

const createColors = (enabled) => {
  const wrap = (code) => (enabled ? (text) => `\x1b[${code}m${text}\x1b[0m` : (text) => String(text));
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    green: wrap('32'),
    red: wrap('31'),
    yellow: wrap('33'),
    cyan: wrap('36'),
    magenta: wrap('35'),
    bgGreen: wrap('42;30;1'),
    bgRed: wrap('41;37;1'),
  };
};

const renderBar = (value, maxValue, width = 22) => {
  if (!Number.isFinite(value) || !Number.isFinite(maxValue) || maxValue <= 0) {
    return '░'.repeat(width);
  }
  const ratio = Math.max(0, Math.min(1, value / maxValue));
  const filled = value > 0 ? Math.max(1, Math.round(ratio * width)) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
};

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

const renderSparkline = (values) => {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values.map((value) => {
    if (span <= Number.EPSILON) return SPARK_CHARS[4];
    const normalized = (value - min) / span;
    const index = Math.min(SPARK_CHARS.length - 1, Math.max(0, Math.round(normalized * (SPARK_CHARS.length - 1))));
    return SPARK_CHARS[index];
  }).join('');
};

const formatDelta = (current, previous, { lowerIsBetter = true, colors } = {}) => {
  if (!Number.isFinite(previous) || previous <= 0) return '';
  const pct = ((current / previous) - 1) * 100;
  const sign = pct > 0 ? '+' : '';
  const label = `${sign}${pct.toFixed(1)}%`;
  const improved = lowerIsBetter ? pct < -1.5 : pct > 1.5;
  const regressed = lowerIsBetter ? pct > 1.5 : pct < -1.5;
  if (improved) return colors.green(label);
  if (regressed) return colors.red(label);
  return colors.dim(label);
};

const formatShortDate = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 16).replace('T', ' ');
};

export const formatMicroReport = (
  result,
  {
    previousRun = null,
    history = [],
    build = null,
    environment = null,
    useColor = false,
  } = {},
) => {
  const c = createColors(useColor);
  const lines = [];

  const title = c.bold(c.magenta('mosu! preview · Node Microbenchmarks'));
  const buildParts = [];
  if (build?.version) buildParts.push(`v${build.version}`);
  if (build?.gitBranch) buildParts.push(build.gitBranch);
  if (build?.gitCommit) buildParts.push(build.gitCommit.slice(0, 7) + (build.workingTreeClean === false ? '*' : ''));
  if (environment?.node) buildParts.push(`Node ${environment.node}`);

  lines.push('');
  lines.push(title);
  if (buildParts.length > 0) lines.push(c.dim(buildParts.join(' · ')));
  lines.push(c.dim('─'.repeat(72)));

  for (const benchmark of result.benchmarks) {
    const badge = benchmark.passed ? c.bgGreen(' PASS ') : c.bgRed(' FAIL ');
    const prevBench = previousRun?.benchmarks?.find((entry) => entry.name === benchmark.name);
    const prevOptDelta = prevBench
      ? ` ${c.dim('vs prev')} ${formatDelta(benchmark.optimizedMs, prevBench.optimizedMs, { lowerIsBetter: true, colors: c })}`
      : '';

    lines.push(`${badge} ${c.bold(benchmark.name)}`);
    const maxMs = Math.max(benchmark.referenceMs, benchmark.optimizedMs, Number.EPSILON);
    const refBar = c.dim(renderBar(benchmark.referenceMs, maxMs, 22));
    const optBar = benchmark.passed ? c.green(renderBar(benchmark.optimizedMs, maxMs, 22)) : c.red(renderBar(benchmark.optimizedMs, maxMs, 22));

    lines.push(`  Ref  ${refBar}  ${benchmark.referenceMs.toFixed(3).padStart(8)} ms`);
    lines.push(
      `  Opt  ${optBar}  ${c.bold(benchmark.optimizedMs.toFixed(3).padStart(8))} ms`
      + `  ${c.cyan(`${benchmark.speedup.toFixed(2)}×`)} ${c.dim(`(≥ ${benchmark.minimumSpeedup.toFixed(2)}×)`)}${prevOptDelta}`,
    );
    lines.push('');
  }

  if (Array.isArray(result.operations) && result.operations.length > 0) {
    lines.push(c.bold('Extension Subsystems (median / p95)'));
    const maxOpMs = Math.max(...result.operations.map((op) => op.medianMs), Number.EPSILON);
    for (const op of result.operations) {
      const prevOp = previousRun?.operations?.find((entry) => entry.id === op.id);
      const delta = prevOp
        ? ` ${formatDelta(op.medianMs, prevOp.medianMs, { lowerIsBetter: true, colors: c })}`
        : '';
      const bar = c.cyan(renderBar(op.medianMs, maxOpMs, 16));
      lines.push(
        `  ${op.name.padEnd(30)} ${bar}  ${c.bold(op.medianMs.toFixed(2).padStart(6))} ms `
        + `${c.dim(`(p95 ${op.p95Ms.toFixed(2)})`)}${delta}`,
      );
    }
    lines.push('');
  }

  const overallBadge = result.passed ? c.bgGreen(' PASS ') : c.bgRed(' FAIL ');
  const prevOverall = Number.isFinite(previousRun?.overallSpeedup)
    ? `  ${c.dim('vs prev')} ${formatDelta(result.overallSpeedup, previousRun.overallSpeedup, { lowerIsBetter: false, colors: c })}`
    : '';
  lines.push(c.dim('─'.repeat(72)));
  lines.push(
    `${overallBadge} Overall geometric-mean speedup: ${c.bold(c.cyan(`${result.overallSpeedup.toFixed(2)}×`))}${prevOverall}`,
  );

  const speedupSeries = [...history.map((run) => run.overallSpeedup), result.overallSpeedup]
    .filter((value) => Number.isFinite(value));
  if (speedupSeries.length >= 2) {
    const spark = renderSparkline(speedupSeries.slice(-20));
    lines.push(
      `${c.dim(`History (${speedupSeries.length} runs):`)} ${c.magenta(spark)} `
      + c.dim(`(${Math.min(...speedupSeries).toFixed(1)}× .. ${Math.max(...speedupSeries).toFixed(1)}×)`),
    );
  }
  lines.push('');
  return lines.join('\n');
};

export const formatMicroHistory = (runs, { useColor = false } = {}) => {
  const c = createColors(useColor);
  if (runs.length === 0) {
    return `${c.dim('No saved microbenchmark runs found in performance-results/results.jsonl.')}\n`;
  }
  const lines = [
    '',
    c.bold(c.magenta(`mosu! preview · Microbenchmark History (${runs.length} runs)`)),
    c.dim('─'.repeat(78)),
    c.dim('Date (UTC)        Commit    Status  Overall   Timing opt   Timeline opt'),
  ];
  for (const run of runs) {
    const commit = run.build?.gitCommit
      ? `${run.build.gitCommit.slice(0, 7)}${run.build.workingTreeClean === false ? '*' : ' '}`
      : '—       ';
    const status = run.passed ? c.green('PASS') : c.red('FAIL');
    const overall = Number.isFinite(run.overallSpeedup) ? `${run.overallSpeedup.toFixed(2)}×`.padStart(8) : '—'.padStart(8);
    const timingBench = run.benchmarks?.[0];
    const timelineBench = run.benchmarks?.[1];
    const timingStr = Number.isFinite(timingBench?.optimizedMs)
      ? `${timingBench.optimizedMs.toFixed(3)} ms`.padStart(11)
      : '—'.padStart(11);
    const timelineStr = Number.isFinite(timelineBench?.optimizedMs)
      ? `${timelineBench.optimizedMs.toFixed(3)} ms`.padStart(11)
      : '—'.padStart(11);
    lines.push(`${formatShortDate(run.recordedAt)}  ${commit}  ${status}    ${overall}   ${timingStr}  ${timelineStr}`);
  }
  const speedups = runs.map((run) => run.overallSpeedup).filter((value) => Number.isFinite(value));
  if (speedups.length >= 2) {
    lines.push(c.dim('─'.repeat(78)));
    lines.push(`${c.dim('Overall speedup trend:')} ${c.magenta(renderSparkline(speedups))}`);
  }
  lines.push('');
  return lines.join('\n');
};

export const parseMicroArgs = (argv = []) => {
  const options = {
    skipSave: false,
    json: false,
    history: false,
    historyLimit: 12,
    sampleCount: DEFAULT_SAMPLE_COUNT,
    noColor: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-save') {
      options.skipSave = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--no-color') {
      options.noColor = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--history') {
      options.history = true;
      const next = argv[index + 1];
      if (next && /^\d+$/.test(next)) {
        options.historyLimit = Math.max(1, Math.min(200, Number(next)));
        index += 1;
      }
    } else if (arg === '--samples' || arg.startsWith('--samples=')) {
      const raw = arg.includes('=') ? arg.slice('--samples='.length) : argv[++index];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new Error(`Invalid --samples value: "${raw}" (expected integer 1..100).`);
      }
      options.sampleCount = parsed;
    } else {
      throw new Error(`Unknown option: "${arg}". Run with --help to see available options.`);
    }
  }
  return options;
};

const MICRO_HELP_TEXT = `Usage: npm run performance:micro -- [options]

Options:
  --samples <n>   Number of timing samples per benchmark (1..100, default: ${DEFAULT_SAMPLE_COUNT})
  --no-save       Skip appending the run to performance-results/results.jsonl
  --history [n]   Display the last n saved microbenchmark runs (default: 12) and exit
  --json          Output results as JSON
  --no-color      Disable ANSI colors
  -h, --help      Show this help message
`;

const isEntrypoint = Boolean(process.argv[1])
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  let options;
  try {
    options = parseMicroArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }

  if (options?.help) {
    console.log(MICRO_HELP_TEXT);
  } else if (options) {
    const useColor = !options.noColor
      && !options.json
      && Boolean(process.stdout.isTTY)
      && !('NO_COLOR' in process.env);

    const history = await readPerformanceResults({ kind: 'micro' });

    if (options.history) {
      const slice = history.slice(-options.historyLimit);
      if (options.json) {
        console.log(JSON.stringify(slice, null, 2));
      } else {
        console.log(formatMicroHistory(slice, { useColor }));
      }
    } else {
      const result = await runMicroBenchmarks({ sampleCount: options.sampleCount });
      const previousRun = history.at(-1) || null;
      const [build, environment] = [await readBuildInfo(), getEnvironmentInfo()];
      let savedPath = null;
      if (!options.skipSave) {
        try {
          const record = await buildPerformanceRecord('micro', result);
          savedPath = await appendPerformanceResult('micro', result, { record });
        } catch (error) {
          console.error(`Could not save benchmark results: ${error?.message || error}`);
          process.exitCode = 1;
        }
      }

      if (options.json) {
        console.log(JSON.stringify({ ...result, savedPath, build, environment }, null, 2));
      } else {
        console.log(formatMicroReport(result, {
          previousRun,
          history,
          build,
          environment,
          useColor,
        }));
        if (savedPath) {
          console.log(`Saved run to ${savedPath}`);
        } else if (options.skipSave) {
          console.log('Skipped saving (--no-save).');
        }
      }

      if (!result.passed) {
        process.exitCode = 1;
      }
    }
  }
}
