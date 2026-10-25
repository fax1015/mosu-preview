import { parseMapPreviewData } from '../src/parser.js';
import { PreviewRenderer } from '../src/renderer.js';
import { buildHitsoundEvents, createHitsoundPlayer } from '../src/audio/hitsounds.js';

const RUN_MS = 8000;
const OBJECT_COUNT = 8000;
const SLIDER_ANCHOR_COUNT = 4344;
const SLIDER_TIME_MS = 12961;
const SLIDER_STRESS_SCENARIO = 'anchor-heavy-slider';
const ASPIRE_SCENARIO = 'aspire-conic';
const ASPIRE_MAP_ID = '5839914';
const ASPIRE_MAP_PATH = `/scripts/benchmark-maps/${ASPIRE_MAP_ID}.osu`;
// osu! beatmap 5839914 ("conic", Aspire) at the point where its 7,427-anchor
// decorative sliders are on screen. This is the map that made culling anchor
// dense slider paths worthwhile in the first place.
const ASPIRE_MAP_TIME_MS = 83300;
const BASELINE_KEY = 'mosu-preview-performance-baseline-v1';
const runButton = document.querySelector('#run');
const scenarioElement = document.querySelector('#scenario');
const saveButton = document.querySelector('#save');
const clearButton = document.querySelector('#clear');
const statusElement = document.querySelector('#status');
const resultsElement = document.querySelector('#results');
const playfieldCanvas = document.querySelector('#playfield');
const timelineCanvas = document.querySelector('#timeline');

const percentile = (values, ratio) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
};

const generateObjectStressBeatmapText = () => {
  const lines = [
    'osu file format v14',
    '',
    '[General]',
    'Mode:0',
    '',
    '[Difficulty]',
    'CircleSize:4',
    'SliderMultiplier:1.4',
    'SliderTickRate:1',
    'ApproachRate:9',
    'OverallDifficulty:7',
    '',
    '[TimingPoints]',
    '0,500,4,1,0,100,1,0',
    '',
    '[HitObjects]',
  ];

  for (let index = 0; index < OBJECT_COUNT; index += 1) {
    const x = 35 + ((index * 71) % 442);
    const y = 35 + ((index * 113) % 314);
    const time = 1000 + (index * 30);
    const hitSound = (index % 24 === 0) ? 14 : ((index % 5 === 0) ? 2 : 0);
    if (index % 3 === 0) {
      const endX = 35 + ((index * 71 + 130) % 442);
      const endY = 35 + ((index * 113 + 95) % 314);
      lines.push(`${x},${y},${time},2,${hitSound},B|${endX}:${endY},1,180`);
    } else {
      lines.push(`${x},${y},${time},1,${hitSound},0:0:0:0:`);
    }
  }
  return lines.join('\n');
};

const generateAnchorStressBeatmapText = () => {
  const lines = [
    'osu file format v14',
    '',
    '[General]',
    'Mode:0',
    '',
    '[Difficulty]',
    'CircleSize:4.2',
    'SliderMultiplier:1.4',
    'SliderTickRate:1',
    'ApproachRate:9.5',
    'OverallDifficulty:8',
    '',
    '[TimingPoints]',
    '0,500,4,1,0,100,1,0',
    '',
    '[HitObjects]',
  ];
  const anchors = [];
  for (let index = 0; anchors.length < SLIDER_ANCHOR_COUNT; index += 1) {
    const progress = index / (SLIDER_ANCHOR_COUNT * 0.72);
    const phase = progress * Math.PI * 16;
    const point = index === 0
      ? { x: 421, y: 247 }
      : {
        x: Math.round(256 + (238 * Math.sin(phase)) + (2 * Math.sin(index * 1.71))),
        y: Math.round(192 + (174 * Math.sin(phase * 0.71)) + (2 * Math.cos(index * 1.37))),
      };
    anchors.push(point);
    // Repeated anchors split the path into the small Bezier spans used by
    // the reference map. Keep the raw anchor count exact for comparisons.
    if (index % 3 === 2 && anchors.length < SLIDER_ANCHOR_COUNT) {
      anchors.push(point);
    }
  }
  const path = anchors.map((point) => `${point.x}:${point.y}`).join('|');
  lines.push(`421,247,${SLIDER_TIME_MS},2,0,B|${path},1,5400,0|0,0:0:0:0:`);
  return lines.join('\n');
};

const loadAspireBenchmarkMapText = async () => {
  const response = await fetch(ASPIRE_MAP_PATH);
  if (!response.ok) {
    throw new Error(`Benchmark map ${ASPIRE_MAP_ID} could not be loaded (${response.status}).`);
  }
  return response.text();
};

const createToneWavUrl = () => {
  const sampleRate = 22050;
  const sampleCount = sampleRate;
  const bytes = new ArrayBuffer(44 + (sampleCount * 2));
  const view = new DataView(bytes);
  const writeText = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, sampleCount * 2, true);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin((2 * Math.PI * 110 * index) / sampleRate) * 0.035;
    view.setInt16(44 + (index * 2), sample * 32767, true);
  }
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
};

// parseMapPreviewData reports the map's last object time as `maxObjectTime`,
// not `durationMs`. Passing the missing field let setBeatmap fall back to a
// one-millisecond duration, so every benchmark pass clamped its time to 1 ms
// and drew an empty playfield. Derive the duration from the parsed objects
// instead, so a scenario's fixed time is always reachable.
const resolveMapDurationMs = (mapData) => {
  let durationMs = Number.isFinite(mapData?.maxObjectTime) ? mapData.maxObjectTime : 0;
  for (const object of (mapData?.objects || [])) {
    const endTime = Number(object?.endTime);
    if (Number.isFinite(endTime) && endTime > durationMs) durationMs = endTime;
  }
  return Math.max(1, durationMs);
};

const makeRenderer = (mapData) => {
  const renderer = new PreviewRenderer(playfieldCanvas, timelineCanvas);
  renderer.setBeatmap(mapData, resolveMapDurationMs(mapData));
  renderer.setPreviewSettings({
    standardSnakingSliders: true,
    standardSliderSnakeOut: true,
    standardSliderEndCircles: true,
  });
  return renderer;
};

const deviceSignature = () => JSON.stringify({
  userAgent: navigator.userAgent,
  dpr: window.devicePixelRatio || 1,
  screen: `${screen.width}x${screen.height}`,
});

const runPass = ({ renderer, player, events, audioEnabled, fixedMapTimeMs = null }) => new Promise((resolve) => {
  const intervals = [];
  const workTimes = [];
  let frameCount = 0;
  let previousFrameAt = 0;
  let firstFrameAt = 0;
  let frameId = 0;

  const onFrame = (rafTimestamp) => {
    const workStart = performance.now();
    if (!firstFrameAt) firstFrameAt = rafTimestamp;
    if (previousFrameAt) intervals.push(rafTimestamp - previousFrameAt);
    previousFrameAt = rafTimestamp;

    const mapTimeMs = Number.isFinite(fixedMapTimeMs)
      ? fixedMapTimeMs
      : Math.max(0, rafTimestamp - firstFrameAt);
    if (audioEnabled) {
      player.update(events, mapTimeMs, { rate: 1 });
    }
    renderer.setTime(mapTimeMs);
    renderer.render();

    workTimes.push(performance.now() - workStart);
    frameCount += 1;
    if ((rafTimestamp - firstFrameAt) < RUN_MS) {
      frameId = requestAnimationFrame(onFrame);
    } else {
      cancelAnimationFrame(frameId);
      const elapsedMs = Math.max(1, rafTimestamp - firstFrameAt);
      const nominalInterval = percentile(intervals, 0.5) || (1000 / 60);
      const dropped = intervals.filter((interval) => interval > nominalInterval * 1.5).length;
      resolve({
        fps: (frameCount * 1000) / elapsedMs,
        frameCount,
        elapsedMs,
        intervalP50: percentile(intervals, 0.5),
        intervalP95: percentile(intervals, 0.95),
        intervalP99: percentile(intervals, 0.99),
        workP50: percentile(workTimes, 0.5),
        workP95: percentile(workTimes, 0.95),
        workP99: percentile(workTimes, 0.99),
        droppedPercent: intervals.length ? (dropped * 100) / intervals.length : 0,
      });
    }
  };

  frameId = requestAnimationFrame(onFrame);
});

const formatMs = (value) => `${value.toFixed(2)} ms`;
const formatTime = (ms) => {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
};
const formatDelta = (current, baseline) => {
  if (!Number.isFinite(baseline) || baseline <= 0) return '—';
  const delta = ((current / baseline) - 1) * 100;
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;
};

const renderResults = (results, baseline) => {
  const passes = [
    ['Visual only', results.visual, baseline?.visual],
    ['Visual + audio', results.audio, baseline?.audio],
  ];
  const rows = passes.map(([name, value, old]) => `
    <tr>
      <td>${name}</td>
      <td>${value.fps.toFixed(1)}</td>
      <td>${formatMs(value.intervalP50)}</td>
      <td>${formatMs(value.intervalP95)}</td>
      <td>${formatMs(value.intervalP99)}</td>
      <td>${formatMs(value.workP95)}</td>
      <td>${value.droppedPercent.toFixed(1)}%</td>
      <td>${formatDelta(value.intervalP95, old?.intervalP95)}</td>
    </tr>`).join('');

  let summary = 'Save this run as a baseline to compare code changes on this device.';
  if (baseline?.visual && baseline?.audio) {
    const frameDelta = ((results.audio.intervalP95 / baseline.audio.intervalP95) - 1) * 100;
    const workDelta = ((results.audio.workP95 / baseline.audio.workP95) - 1) * 100;
    const frameLabel = `${frameDelta > 0 ? '+' : ''}${frameDelta.toFixed(1)}%`;
    const workLabel = `${workDelta > 0 ? '+' : ''}${workDelta.toFixed(1)}%`;
    summary = `Audio-pass p95 frame interval vs baseline: ${frameLabel}; p95 JS work: ${workLabel}. `
    + 'Negative percentages mean faster. Compare on the same device and browser.';
  }

  resultsElement.innerHTML = `
    <p><strong>${summary}</strong></p>
    <table>
      <thead><tr><th>Pass</th><th>FPS</th><th>Frame p50</th><th>Frame p95</th><th>Frame p99</th><th>JS work p95</th><th>Dropped</th><th>p95 vs baseline</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">Device: ${navigator.userAgent} · DPR ${window.devicePixelRatio || 1} · ${results.benchmark.description} · ${results.visual.frameCount.toLocaleString()} measured frames per pass</p>`;
};

// Both anchor-heavy scenarios can be run straight from the URL, which is how
// they are driven when comparing renderer changes.
const AUTO_BENCHMARK_SCENARIOS = {
  [SLIDER_STRESS_SCENARIO]: {
    title: 'Anchor-heavy slider',
    prepare: async () => parseMapPreviewData(generateAnchorStressBeatmapText(), { maxObjects: 1 }),
    fixedMapTimeMs: SLIDER_TIME_MS + 1,
    note: `${SLIDER_ANCHOR_COUNT.toLocaleString()} generated anchors, held at ${formatTime(SLIDER_TIME_MS + 1)} for ${RUN_MS / 1000} seconds.`,
  },
  [ASPIRE_SCENARIO]: {
    title: `conic (${ASPIRE_MAP_ID})`,
    prepare: async () => parseMapPreviewData(
      await loadAspireBenchmarkMapText(),
      { maxObjects: 2000 },
    ),
    fixedMapTimeMs: ASPIRE_MAP_TIME_MS,
    note: `osu! beatmap ${ASPIRE_MAP_ID} ("conic", Aspire), held at ${formatTime(ASPIRE_MAP_TIME_MS)} (7,427-anchor decorative sliders on screen) for ${RUN_MS / 1000} seconds.`,
  },
};

const runAutomaticVisualBenchmark = async (scenarioKey) => {
  const scenario = AUTO_BENCHMARK_SCENARIOS[scenarioKey];
  runButton.disabled = true;
  statusElement.textContent = `Preparing ${scenario.title}…`;
  try {
    const mapData = await scenario.prepare();
    const renderer = makeRenderer(mapData);
    const visual = await runPass({
      renderer,
      player: null,
      events: [],
      audioEnabled: false,
      fixedMapTimeMs: scenario.fixedMapTimeMs,
    });
    resultsElement.innerHTML = `
      <p><strong>${scenario.title} FPS: ${visual.fps.toFixed(1)}</strong></p>
      <p>Frame interval p50/p95/p99: ${formatMs(visual.intervalP50)} / ${formatMs(visual.intervalP95)} / ${formatMs(visual.intervalP99)}. JS work p95: ${formatMs(visual.workP95)}. Dropped frames: ${visual.droppedPercent.toFixed(1)}%.</p>
      <p class="note">${scenario.note}</p>`;
    statusElement.textContent = `Visual benchmark complete (${visual.frameCount.toLocaleString()} frames).`;
  } catch (error) {
    statusElement.textContent = `Benchmark failed: ${error?.message || error}`;
  } finally {
    runButton.disabled = false;
  }
};

const autoBenchmark = new URLSearchParams(window.location.search).get('autobench');
if (autoBenchmark && AUTO_BENCHMARK_SCENARIOS[autoBenchmark]) {
  scenarioElement.value = autoBenchmark;
  void runAutomaticVisualBenchmark(autoBenchmark);
}

let latestResults = null;
runButton.addEventListener('click', async () => {
  runButton.disabled = true;
  saveButton.disabled = true;
  resultsElement.textContent = '';
  let player;
  let audio;
  let audioUrl;
  try {
    const scenario = scenarioElement.value;
    const isSliderStress = scenario === SLIDER_STRESS_SCENARIO;
    const isAspire = scenario === ASPIRE_SCENARIO;
    const fixedMapTimeMs = isSliderStress
      ? SLIDER_TIME_MS + 1
      : (isAspire ? ASPIRE_MAP_TIME_MS : null);
    statusElement.textContent = isSliderStress
      ? `Preparing a ${SLIDER_ANCHOR_COUNT.toLocaleString()}-anchor slider…`
      : (isAspire
        ? `Preparing conic (${ASPIRE_MAP_ID})…`
        : 'Preparing 8,000 objects and slider geometry…');
    const setupStart = performance.now();
    let mapText;
    if (isAspire) {
      mapText = await loadAspireBenchmarkMapText();
    } else {
      mapText = isSliderStress ? generateAnchorStressBeatmapText() : generateObjectStressBeatmapText();
    }
    const mapData = parseMapPreviewData(
      mapText,
      { maxObjects: isSliderStress ? 1 : (isAspire ? 2000 : OBJECT_COUNT) },
    );
    const renderer = makeRenderer(mapData);
    const events = buildHitsoundEvents(mapData.objects, {
      samplePoints: mapData.timingControlPoints,
      defaultSampleSet: mapData.defaultSampleSet,
    });
    const setupMs = performance.now() - setupStart;

    // Unlock audio while the Run button's user activation is still current.
    // The first pass pauses it; the second pass starts it again for measurement.
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error('Web Audio is unavailable in this browser.');
    player = createHitsoundPlayer();
    player.setEnabled(true);
    player.setVolume(0.25);
    player.setMusicVolume(0.08);
    audioUrl = createToneWavUrl();
    audio = new Audio(audioUrl);
    audio.loop = true;
    audio.preload = 'auto';
    audio.muted = true;
    player.attachMediaElement(audio);
    player.ensureContext();
    player.resumeContext();
    const audioUnlock = audio.play();

    statusElement.textContent = `Visual-only pass (setup ${setupMs.toFixed(0)} ms)…`;
    await audioUnlock;
    audio.pause();
    audio.muted = false;
    player.setEnabled(false);
    const visual = await runPass({ renderer, player: null, events, audioEnabled: false, fixedMapTimeMs });

    player.setEnabled(true);
    player.syncTo(events, 0);
    player.resumeContext();
    await audio.play();

    statusElement.textContent = 'Visual + synthesized audio pass…';
    const audioPass = await runPass({ renderer, player, events, audioEnabled: true, fixedMapTimeMs });
    audio.pause();
    player.setEnabled(false);

    latestResults = {
      visual,
      audio: audioPass,
      setupMs,
      signature: deviceSignature(),
      device: {
        userAgent: navigator.userAgent,
        dpr: window.devicePixelRatio || 1,
        screen: `${screen.width}x${screen.height}`,
      },
      benchmark: {
        runMs: RUN_MS,
        objectCount: mapData.objects.length,
        scenario,
        description: isSliderStress
          ? `${SLIDER_ANCHOR_COUNT.toLocaleString()}-anchor slider (00:12 workload)`
          : (isAspire
            ? `conic (${ASPIRE_MAP_ID}) at ${formatTime(ASPIRE_MAP_TIME_MS)}`
            : `${OBJECT_COUNT.toLocaleString()} objects`),
      },
    };
    let baseline = null;
    try {
      const stored = JSON.parse(localStorage.getItem(BASELINE_KEY) || 'null');
      if (stored?.signature === latestResults.signature
        && stored?.benchmark?.scenario === latestResults.benchmark.scenario) baseline = stored;
    } catch {
      // No usable baseline stored: compare against nothing.
    }
    renderResults(latestResults, baseline);
    saveButton.disabled = false;
    try {
      const response = await fetch('/api/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(latestResults),
      });
      if (!response.ok) throw new Error(await response.text());
      const saved = await response.json();
      statusElement.textContent = `Complete. Results saved to ${saved.resultsPath}.`;
    } catch (error) {
      statusElement.textContent = `Complete, but run history could not be saved: ${error?.message || error}`;
    }
  } catch (error) {
    statusElement.textContent = `Benchmark failed: ${error?.message || error}`;
  } finally {
    audio?.pause();
    player?.dispose();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    runButton.disabled = false;
  }
});

saveButton.addEventListener('click', () => {
  if (!latestResults) return;
  localStorage.setItem(BASELINE_KEY, JSON.stringify(latestResults));
  renderResults(latestResults, latestResults);
  statusElement.textContent = 'Baseline saved on this device and browser.';
});

clearButton.addEventListener('click', () => {
  localStorage.removeItem(BASELINE_KEY);
  if (latestResults) renderResults(latestResults, null);
  statusElement.textContent = 'Saved baseline cleared.';
});
