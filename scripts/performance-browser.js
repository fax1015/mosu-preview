import { parseBreakPeriods, parseMapPreviewData, parseMetadata } from '../src/parser.js';
import { PreviewRenderer } from '../src/renderer.js';
import { TimelineRenderer } from '../src/timeline.js';
import { convertMapForMode } from '../src/core/beatmapConversion.js';
import {
  buildMiniPalette,
  extractCoverSeed,
  formatRgb,
  formatRgba,
} from '../src/core/coverPalette.js';
import {
  computeDraggedBounds,
  computeResizedBounds,
  DEFAULT_EMBEDDED_BOUNDS,
  normalizeEmbeddedBounds,
  resolveResumeSnapshot,
  serializeResumeSnapshot,
} from '../src/core/embeddedPlayer.js';
import { createMiniMorph } from '../src/ui/miniMorph.js';
import { drawWavyProgress } from '../src/ui/wavyProgress.js';
import { buildHitsoundEvents, createHitsoundPlayer } from '../src/audio/hitsounds.js';
import {
  renderDistributionHistogram,
  renderFrameTimelineChart,
  renderHistoryTrendChart,
  renderMicroTrendChart,
  renderPercentileComparisonChart,
  renderStartupHistoryTrendChart,
  renderStartupWaterfallChart,
  renderSubsystemBarsChart,
  renderSuiteComparisonChart,
} from './performance-charts.js';

const DEFAULT_RUN_MS = 8000;
const OBJECT_COUNT = 8000;
const SLIDER_ANCHOR_COUNT = 4344;
const SLIDER_TIME_MS = 12961;
const SLIDER_STRESS_SCENARIO = 'anchor-heavy-slider';
const ASPIRE_SCENARIO = 'aspire-conic';
const OBJECT_STRESS_SCENARIO = 'object-stress';
const MANIA_SCENARIO = 'mania-7k';
const CATCH_SCENARIO = 'catch-fruits';
const COMPARE_SCENARIO = 'compare-4up';
const MINIPLAYER_COLLAPSED_SCENARIO = 'miniplayer-collapsed';
const MINIPLAYER_TOGGLE_SCENARIO = 'miniplayer-toggle';
const ASPIRE_MAP_ID = '5839914';
const ASPIRE_MAP_PATH = `/scripts/benchmark-maps/${ASPIRE_MAP_ID}.osu`;
const ASPIRE_MAP_TIME_MS = 83300;
const BASELINE_KEY = 'mosu-preview-performance-baseline-v1';

// DOM references
const metaPillEl = document.querySelector('#meta-pill');
const powerPillEl = document.querySelector('#power-pill');
const tabButtons = [...document.querySelectorAll('.tab-btn')];
const tabPanels = {
  browser: document.querySelector('#tab-browser'),
  startup: document.querySelector('#tab-startup'),
  history: document.querySelector('#tab-history'),
  micro: document.querySelector('#tab-micro'),
};
const historyCountEl = document.querySelector('#history-count');
const microCountEl = document.querySelector('#micro-count');

const scenarioElement = document.querySelector('#scenario');
const scenarioCardsEl = document.querySelector('#scenario-cards');
const modeButtons = [...document.querySelectorAll('#mode-control .seg-btn')];
const durationButtons = [...document.querySelectorAll('#duration-control .seg-btn')];
const runButton = document.querySelector('#run');
const runAllButton = document.querySelector('#run-all');
const stopButton = document.querySelector('#stop');
const saveButton = document.querySelector('#save');
const clearButton = document.querySelector('#clear');
const statusElement = document.querySelector('#status');
const liveFpsEl = document.querySelector('#live-fps');
const liveIntervalEl = document.querySelector('#live-interval');
const liveWorkEl = document.querySelector('#live-work');
const liveFramesEl = document.querySelector('#live-frames');
const progressFillEl = document.querySelector('#progress-fill');
const visibilityBannerEl = document.querySelector('#visibility-banner');
const stageBadgeEl = document.querySelector('#stage-badge');
const canvasPreviewWrapEl = document.querySelector('#canvas-preview-wrap');
const miniplayerRenderStageEl = document.querySelector('#miniplayer-render-stage');
const playfieldCanvas = document.querySelector('#playfield');
const timelineCanvas = document.querySelector('#timeline');

const suiteSummaryCardEl = document.querySelector('#suite-summary-card');
const suiteTabsEl = document.querySelector('#suite-tabs');
const suiteChartHostEl = document.querySelector('#suite-chart-host');

const resultsCardEl = document.querySelector('#results-card');
const resultsTitleEl = document.querySelector('#results-title');
const resultsMetaEl = document.querySelector('#results-meta');
const resultsElement = document.querySelector('#results');
const compareSelectEl = document.querySelector('#compare-select');
const copyMdButton = document.querySelector('#copy-md');
const exportJsonButton = document.querySelector('#export-json');

// Startup tab elements
const startupModeCardsEl = document.querySelector('#startup-mode-cards');
const startupIterButtons = [...document.querySelectorAll('#startup-iter-control .seg-btn')];
const startupSaveToggleEl = document.querySelector('#startup-save-toggle');
const runStartupBtn = document.querySelector('#run-startup');
const runStartupAllBtn = document.querySelector('#run-startup-all');
const stopStartupBtn = document.querySelector('#stop-startup');
const startupStatusEl = document.querySelector('#startup-status');
const startupLastEl = document.querySelector('#startup-last');
const startupProgressFillEl = document.querySelector('#startup-progress-fill');
const popupStageEl = document.querySelector('#popup-stage');
const startupResultsCardEl = document.querySelector('#startup-results-card');
const startupResultsTitleEl = document.querySelector('#startup-results-title');
const startupResultsMetaEl = document.querySelector('#startup-results-meta');
const startupSuiteTabsEl = document.querySelector('#startup-suite-tabs');
const startupResultsEl = document.querySelector('#startup-results');

// History tab elements
const historyKindButtons = [...document.querySelectorAll('#history-kind-control .seg-btn')];
const refreshHistoryBtn = document.querySelector('#refresh-history');
const historyScenarioEl = document.querySelector('#history-scenario');
const historyMetricEl = document.querySelector('#history-metric');
const historyStartupModeEl = document.querySelector('#history-startup-mode');
const historySameDeviceEl = document.querySelector('#history-same-device');
const historyExcludeEfficiencyEl = document.querySelector('#history-exclude-efficiency');
const historyChartTitleEl = document.querySelector('#history-chart-title');
const historyChartLegendEl = document.querySelector('#history-chart-legend');
const historyChartHostEl = document.querySelector('#history-chart-host');
const historyTableWrapEl = document.querySelector('#history-table-wrap');

// Micro tab elements
const microSaveToggleEl = document.querySelector('#micro-save-toggle');
const runMicroButton = document.querySelector('#run-micro');
const microStatusEl = document.querySelector('#micro-status');
const microLatestEl = document.querySelector('#micro-latest');
const microOpsCardEl = document.querySelector('#micro-ops-card');
const microOpsHostEl = document.querySelector('#micro-ops-host');
const microChartHostEl = document.querySelector('#micro-chart-host');
const microTableWrapEl = document.querySelector('#micro-table-wrap');

const formatMs = (value) => `${value.toFixed(2)} ms`;
const formatTime = (ms) => {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
};
const formatDeltaText = (current, baseline) => {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline <= 0) return '—';
  const delta = ((current / baseline) - 1) * 100;
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;
};
const deltaClass = (current, baseline, { lowerIsBetter = true } = {}) => {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline <= 0) return 'neutral';
  const pct = ((current / baseline) - 1) * 100;
  if (Math.abs(pct) < 1.5) return 'neutral';
  const good = lowerIsBetter ? pct < 0 : pct > 0;
  return good ? 'good' : 'bad';
};

const percentile = (values, ratio) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
};

const makeEl = (tag, className = '', text = '') => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
};

const generateObjectStressBeatmapText = (count = OBJECT_COUNT) => {
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

  for (let index = 0; index < count; index += 1) {
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
    if (index % 3 === 2 && anchors.length < SLIDER_ANCHOR_COUNT) {
      anchors.push(point);
    }
  }
  const path = anchors.map((point) => `${point.x}:${point.y}`).join('|');
  lines.push(`421,247,${SLIDER_TIME_MS},2,0,B|${path},1,5400,0|0,0:0:0:0:`);
  return lines.join('\n');
};

let cachedAspireMapText = null;
const loadAspireBenchmarkMapText = async () => {
  if (cachedAspireMapText) return cachedAspireMapText;
  const response = await fetch(ASPIRE_MAP_PATH);
  if (!response.ok) {
    throw new Error(`Benchmark map ${ASPIRE_MAP_ID} could not be loaded (${response.status}).`);
  }
  cachedAspireMapText = await response.text();
  return cachedAspireMapText;
};

const SCENARIOS = [
  {
    id: SLIDER_STRESS_SCENARIO,
    title: 'Anchor slider',
    tag: '4,344 anchors · std',
    description: `${SLIDER_ANCHOR_COUNT.toLocaleString()}-anchor slider (00:12 workload)`,
    fixedMapTimeMs: SLIDER_TIME_MS + 1,
    prepare: async () => parseMapPreviewData(generateAnchorStressBeatmapText(), { maxObjects: 1 }),
  },
  {
    id: ASPIRE_SCENARIO,
    title: `conic (${ASPIRE_MAP_ID})`,
    tag: '7,427 anchors · std',
    description: `conic (${ASPIRE_MAP_ID}) at ${formatTime(ASPIRE_MAP_TIME_MS)}`,
    fixedMapTimeMs: ASPIRE_MAP_TIME_MS,
    prepare: async () => parseMapPreviewData(await loadAspireBenchmarkMapText(), { maxObjects: 2000 }),
  },
  {
    id: OBJECT_STRESS_SCENARIO,
    title: 'Mixed objects',
    tag: '8,000 objects · std',
    description: `${OBJECT_COUNT.toLocaleString()} objects`,
    fixedMapTimeMs: null,
    prepare: async () => parseMapPreviewData(generateObjectStressBeatmapText(), { maxObjects: OBJECT_COUNT }),
  },
  {
    id: MANIA_SCENARIO,
    title: 'Mania 7K',
    tag: '8,000 notes · mania',
    description: '8,000 converted 7K mania notes + holds',
    fixedMapTimeMs: null,
    prepare: async () => {
      const text = generateObjectStressBeatmapText(OBJECT_COUNT);
      const parsed = { ...parseMapPreviewData(text, { maxObjects: OBJECT_COUNT }), breaks: [] };
      return convertMapForMode(parsed, 3, { maniaKeyCount: 7 });
    },
  },
  {
    id: CATCH_SCENARIO,
    title: 'Catch convert',
    tag: 'fruits + drops · ctb',
    description: '3,000 objects converted to Catch fruits & droplets',
    fixedMapTimeMs: null,
    prepare: async () => {
      const text = generateObjectStressBeatmapText(3000);
      const parsed = { ...parseMapPreviewData(text, { maxObjects: 3000 }), breaks: [] };
      return convertMapForMode(parsed, 2);
    },
  },
  {
    id: COMPARE_SCENARIO,
    title: '4-panel Compare',
    tag: '4× playfields · std',
    description: '4 simultaneous difficulty playfields on one clock',
    fixedMapTimeMs: null,
    multiPanelCount: 4,
    prepare: async () => parseMapPreviewData(generateObjectStressBeatmapText(3000), { maxObjects: 3000 }),
  },
  {
    id: MINIPLAYER_COLLAPSED_SCENARIO,
    title: 'Miniplayer Collapsed',
    tag: 'wavy bar · 156px',
    description: 'Collapsed miniplayer (OKLCH cover palette + wavy progress bar)',
    fixedMapTimeMs: null,
    miniplayer: { initialCollapsed: true, toggleIntervalMs: 0 },
    prepare: async () => parseMapPreviewData(await loadAspireBenchmarkMapText(), { maxObjects: 2000 }),
  },
  {
    id: MINIPLAYER_TOGGLE_SCENARIO,
    title: 'Miniplayer Toggle',
    tag: 'fade-through · 260ms',
    description: 'Miniplayer 260ms Material fade-through collapse/expand + repaint',
    fixedMapTimeMs: ASPIRE_MAP_TIME_MS,
    miniplayer: { initialCollapsed: false, toggleIntervalMs: 700 },
    prepare: async () => parseMapPreviewData(await loadAspireBenchmarkMapText(), { maxObjects: 2000 }),
  },
];

const SCENARIO_BY_ID = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

const STARTUP_MODES = [
  { id: 'cached', title: 'Cached Open', tag: 'popup · cache hit' },
  { id: 'cold', title: 'Cold Open', tag: 'popup · fetch + parse' },
  { id: 'unsupported', title: 'Unsupported Tab', tag: 'popup · non-osu' },
  { id: 'miniplayer-expanded', title: 'Miniplayer Expanded', tag: 'embedded · 440×444' },
  { id: 'miniplayer-collapsed', title: 'Miniplayer Collapsed', tag: 'embedded · 440×156' },
];
const STARTUP_MODE_BY_ID = Object.fromEntries(STARTUP_MODES.map((m) => [m.id, m]));

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

const resolveMapDurationMs = (mapData) => {
  let durationMs = Number.isFinite(mapData?.maxObjectTime) ? mapData.maxObjectTime : 0;
  for (const object of (mapData?.objects || [])) {
    const endTime = Number(object?.endTime);
    if (Number.isFinite(endTime) && endTime > durationMs) durationMs = endTime;
  }
  return Math.max(1, durationMs);
};

const makeRenderer = (mapData, { multiPanelCount = 1 } = {}) => {
  const durationMs = resolveMapDurationMs(mapData);
  const settings = {
    standardSnakingSliders: true,
    standardSliderSnakeOut: true,
    standardSliderEndCircles: true,
  };
  const primary = new PreviewRenderer(playfieldCanvas, timelineCanvas);
  primary.setBeatmap(mapData, durationMs);
  primary.setPreviewSettings(settings);

  const peers = [];
  for (let i = 1; i < multiPanelCount; i += 1) {
    const offscreen = document.createElement('canvas');
    offscreen.width = 512;
    offscreen.height = 384;
    const peer = new PreviewRenderer(offscreen, null, { lowLatency: false, selectionTimeline: primary.timeline });
    peer.setBeatmap(mapData, durationMs);
    peer.setPreviewSettings(settings);
    peers.push(peer);
  }

  return {
    setTime(ms) {
      primary.setTime(ms);
      for (const peer of peers) peer.setTime(ms);
    },
    render() {
      primary.render();
      for (const peer of peers) peer.renderPlayfield();
    },
    dispose() {
      primary.dispose?.();
      for (const peer of peers) peer.dispose?.();
    },
  };
};

const deviceSignature = () => JSON.stringify({
  userAgent: navigator.userAgent,
  dpr: window.devicePixelRatio || 1,
  screen: `${screen.width}x${screen.height}`,
});

const parseBrowserName = (ua = '') => {
  if (/Electron\/([\d.]+)/.test(ua)) return `Electron ${RegExp.$1.split('.')[0]}`;
  if (/Edg\/([\d.]+)/.test(ua)) return `Edge ${RegExp.$1.split('.')[0]}`;
  if (/Firefox\/([\d.]+)/.test(ua)) return `Firefox ${RegExp.$1.split('.')[0]}`;
  if (/Chrome\/([\d.]+)/.test(ua)) return `Chrome ${RegExp.$1.split('.')[0]}`;
  if (/Safari\/([\d.]+)/.test(ua)) return 'Safari';
  return 'Browser';
};

// Application state
const state = {
  activeTab: 'browser',
  passMode: 'full',
  runMs: DEFAULT_RUN_MS,
  running: false,
  abortController: null,
  tabWentHidden: false,
  latestResults: null,
  suiteResults: [],
  activeSuiteIndex: 0,
  activeChartView: 'timeline',
  timelineView: 'both',
  histogramMetric: 'intervals',
  compareTarget: 'baseline',
  // Startup tab state
  startupMode: 'cached',
  startupIters: 5,
  startupRunning: false,
  startupAbort: null,
  startupResultsList: [],
  activeStartupIndex: 0,
  startupChartView: 'waterfall', // 'waterfall' | 'subsystems'
  browserSubsystems: [],
  // History tab state
  historyKind: 'browser', // 'browser' | 'startup'
  historyBrowser: [],
  historyStartup: [],
  historyMicro: [],
  serverMeta: null,
  // Power / Efficiency mode detection
  powerOverride: 'auto', // 'auto' | 'efficiency' | 'normal'
  powerProbe: {
    rafHz: null,
    rafCapped: false,
    onBattery: null,
    batteryLevel: null,
    reducedMotion: Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches),
  },
};

const isPassRafCapped = (pass) => Boolean(
  pass
  && Number.isFinite(pass.intervalP50)
  && Number.isFinite(pass.workP50)
  && pass.intervalP50 >= 28
  && pass.workP50 < 8,
);

const resolvePowerMetadata = ({ visual = null, audio = null } = {}) => {
  const probe = state.powerProbe;
  const passCapped = isPassRafCapped(visual) || isPassRafCapped(audio);
  const passInterval = visual?.intervalP50 || audio?.intervalP50 || 0;
  const passHz = passInterval > 0 ? Math.round(1000 / passInterval) : null;
  const rafHz = passCapped && passHz ? passHz : (probe.rafHz ?? passHz);
  const autoEfficiency = Boolean(probe.rafCapped || passCapped);

  let efficiencyMode = autoEfficiency;
  let source = autoEfficiency ? 'detected-raf-cap' : (probe.onBattery ? 'battery' : 'normal');
  if (state.powerOverride === 'efficiency') {
    efficiencyMode = true;
    source = 'manual';
  } else if (state.powerOverride === 'normal') {
    efficiencyMode = false;
    source = 'manual';
  }

  const out = {
    efficiencyMode,
    source,
    reducedMotion: Boolean(probe.reducedMotion),
  };
  if (Number.isFinite(rafHz) && rafHz > 0) out.rafHz = rafHz;
  if (typeof probe.onBattery === 'boolean') out.onBattery = probe.onBattery;
  if (Number.isFinite(probe.batteryLevel)) out.batteryLevel = probe.batteryLevel;
  return out;
};

const renderPowerPill = () => {
  if (!powerPillEl) return;
  const power = resolvePowerMetadata();
  powerPillEl.classList.toggle('is-efficiency', power.efficiencyMode);
  const hzPart = Number.isFinite(power.rafHz) ? `~${power.rafHz}Hz` : '';
  const batPart = power.onBattery
    ? ` · ${Number.isFinite(power.batteryLevel) ? `${Math.round(power.batteryLevel * 100)}%` : 'bat'}`
    : '';
  if (power.efficiencyMode) {
    const detail = power.source === 'manual' ? 'manual' : (hzPart || '30Hz cap');
    powerPillEl.textContent = `Efficiency (${detail}${batPart})`;
  } else {
    const detail = hzPart || 'Normal';
    const tag = power.source === 'manual' ? ' · manual' : '';
    powerPillEl.textContent = `${detail}${batPart}${tag}`;
  }
};

const initPowerDetection = () => {
  renderPowerPill();
  const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (mq?.addEventListener) {
    mq.addEventListener('change', (e) => {
      state.powerProbe.reducedMotion = Boolean(e.matches);
      renderPowerPill();
    });
  }

  if (typeof navigator.getBattery === 'function') {
    void navigator.getBattery().then((battery) => {
      const syncBattery = () => {
        state.powerProbe.onBattery = !battery.charging;
        state.powerProbe.batteryLevel = Number.isFinite(battery.level) ? battery.level : null;
        renderPowerPill();
      };
      syncBattery();
      battery.addEventListener?.('chargingchange', syncBattery);
      battery.addEventListener?.('levelchange', syncBattery);
    }).catch(() => {});
  }

  // Brief 18-frame idle rAF cadence probe to detect browser Energy Saver /
  // Efficiency Mode ~30Hz rAF throttling immediately on page load.
  const samples = [];
  let prev = 0;
  let remaining = 18;
  const step = (ts) => {
    if (prev > 0) samples.push(ts - prev);
    prev = ts;
    remaining -= 1;
    if (remaining > 0) {
      requestAnimationFrame(step);
      return;
    }
    if (samples.length >= 6) {
      const med = percentile(samples, 0.5);
      if (med > 0) {
        state.powerProbe.rafHz = Math.round(1000 / med);
        state.powerProbe.rafCapped = med >= 28;
        renderPowerPill();
      }
    }
  };
  requestAnimationFrame(step);
};

document.addEventListener('visibilitychange', () => {
  if (state.running && document.hidden) {
    state.tabWentHidden = true;
    visibilityBannerEl.hidden = false;
  }
});

const setStatus = (text, tone = '') => {
  statusElement.textContent = text;
  statusElement.className = tone;
};

const setProgress = (fraction) => {
  progressFillEl.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
};

const resetLiveMetrics = () => {
  liveFpsEl.textContent = '—';
  liveIntervalEl.textContent = '—';
  liveWorkEl.textContent = '—';
  liveFramesEl.textContent = '0';
  setProgress(0);
};

const updateLiveMetrics = ({ fps, intervalMs, workMs, frames, progress }) => {
  liveFpsEl.textContent = Number.isFinite(fps) ? fps.toFixed(1) : '—';
  liveIntervalEl.textContent = Number.isFinite(intervalMs) ? `${intervalMs.toFixed(1)}ms` : '—';
  liveWorkEl.textContent = Number.isFinite(workMs) ? `${workMs.toFixed(2)}ms` : '—';
  liveFramesEl.textContent = frames.toLocaleString();
  if (Number.isFinite(progress)) setProgress(progress);
};

const runPass = ({
  renderer,
  player,
  events,
  audioEnabled,
  fixedMapTimeMs = null,
  runMs = state.runMs,
  signal = null,
  onProgress = null,
}) => new Promise((resolve, reject) => {
  const intervals = [];
  const workTimes = [];
  const times = [];
  let frameCount = 0;
  let previousFrameAt = 0;
  let firstFrameAt = 0;
  let lastProgressAt = 0;
  let frameId = 0;

  const cleanup = () => {
    if (frameId) cancelAnimationFrame(frameId);
    signal?.removeEventListener('abort', onAbort);
  };

  const onAbort = () => {
    cleanup();
    reject(new DOMException('Benchmark cancelled by user.', 'AbortError'));
  };

  if (signal?.aborted) {
    onAbort();
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  const onFrame = (rafTimestamp) => {
    if (signal?.aborted) {
      onAbort();
      return;
    }

    const workStart = performance.now();
    if (!firstFrameAt) firstFrameAt = rafTimestamp;
    const elapsed = rafTimestamp - firstFrameAt;
    if (previousFrameAt) {
      intervals.push(rafTimestamp - previousFrameAt);
      times.push(elapsed);
    }
    previousFrameAt = rafTimestamp;

    const mapTimeMs = Number.isFinite(fixedMapTimeMs)
      ? fixedMapTimeMs
      : Math.max(0, elapsed);
    if (audioEnabled) {
      player.update(events, mapTimeMs, { rate: 1 });
    }
    renderer.setTime(mapTimeMs);
    renderer.render();

    const workDuration = performance.now() - workStart;
    if (intervals.length > workTimes.length) {
      workTimes.push(workDuration);
    }
    frameCount += 1;

    if (onProgress && (rafTimestamp - lastProgressAt >= 250 || elapsed >= runMs)) {
      lastProgressAt = rafTimestamp;
      const liveFps = elapsed > 0 ? (frameCount * 1000) / elapsed : 0;
      const lastInterval = intervals.length ? intervals[intervals.length - 1] : 0;
      onProgress({
        fps: liveFps,
        intervalMs: lastInterval,
        workMs: workDuration,
        frames: frameCount,
        elapsedMs: elapsed,
        fraction: Math.min(1, elapsed / runMs),
      });
    }

    if (elapsed < runMs) {
      frameId = requestAnimationFrame(onFrame);
    } else {
      cleanup();
      const elapsedMs = Math.max(1, elapsed);
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
        droppedCount: dropped,
        samples: { intervals, workTimes, times },
      });
    }
  };

  frameId = requestAnimationFrame(onFrame);
});

const stripSamplesForSave = (results) => {
  const pickPass = (pass) => ({
    fps: pass.fps,
    frameCount: pass.frameCount,
    elapsedMs: pass.elapsedMs,
    intervalP50: pass.intervalP50,
    intervalP95: pass.intervalP95,
    intervalP99: pass.intervalP99,
    workP50: pass.workP50,
    workP95: pass.workP95,
    workP99: pass.workP99,
    droppedPercent: pass.droppedPercent,
  });
  return {
    setupMs: results.setupMs,
    signature: results.signature,
    device: results.device,
    benchmark: results.benchmark,
    visual: pickPass(results.visual),
    audio: results.audio ? pickPass(results.audio) : null,
  };
};

// Baseline & comparison helpers
const readLocalBaseline = (scenarioId) => {
  try {
    const stored = JSON.parse(localStorage.getItem(BASELINE_KEY) || 'null');
    if (stored?.signature === deviceSignature()
      && stored?.benchmark?.scenario === scenarioId) {
      return stored;
    }
  } catch {
    // Ignore malformed localStorage baseline.
  }
  return null;
};

const syncBaselineButtons = () => {
  const scenarioId = state.latestResults?.benchmark?.scenario;
  const hasBaseline = Boolean(scenarioId && readLocalBaseline(scenarioId));
  clearButton.hidden = !hasBaseline;
};

const resolveComparisonRun = (current) => {
  if (!current) return { label: '', run: null };
  const target = state.compareTarget;
  if (target === 'none') return { label: '', run: null };
  if (target === 'baseline') {
    return { label: 'baseline', run: readLocalBaseline(current.benchmark.scenario) };
  }
  if (target === 'previous') {
    const matching = state.historyBrowser.filter(
      (entry) => entry.benchmark?.scenario === current.benchmark.scenario,
    );
    const candidates = current.recordedAt
      ? matching.filter((entry) => entry.recordedAt !== current.recordedAt)
      : matching;
    const prev = candidates.at(-1) || null;
    const sha = prev?.build?.gitCommit ? prev.build.gitCommit.slice(0, 7) : 'prev';
    return { label: sha, run: prev };
  }
  if (target.startsWith('history:')) {
    const idx = Number(target.slice('history:'.length));
    const entry = state.historyBrowser[idx] || null;
    if (entry) {
      const sha = entry.build?.gitCommit ? entry.build.gitCommit.slice(0, 7) : 'saved';
      return { label: sha, run: entry };
    }
  }
  return { label: '', run: null };
};

const refreshCompareSelectOptions = () => {
  const prevValue = compareSelectEl.value || state.compareTarget;
  compareSelectEl.replaceChildren();
  compareSelectEl.append(
    new Option('vs Baseline', 'baseline'),
    new Option('vs Previous', 'previous'),
    new Option('No diff', 'none'),
  );
  if (state.historyBrowser.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Saved runs';
    for (let i = state.historyBrowser.length - 1; i >= 0; i -= 1) {
      const entry = state.historyBrowser[i];
      const dateStr = entry.recordedAt ? new Date(entry.recordedAt).toLocaleDateString() : '—';
      const sha = entry.build?.gitCommit ? entry.build.gitCommit.slice(0, 7) : '—';
      const fps = entry.audio?.fps ?? entry.visual?.fps;
      const fpsLabel = Number.isFinite(fps) ? `${fps.toFixed(0)} fps` : '';
      group.append(new Option(`${dateStr} · ${entry.benchmark?.scenario || '?'} · ${sha} (${fpsLabel})`, `history:${i}`));
    }
    compareSelectEl.append(group);
  }
  if ([...compareSelectEl.options].some((opt) => opt.value === prevValue)) {
    compareSelectEl.value = prevValue;
    state.compareTarget = prevValue;
  } else {
    compareSelectEl.value = 'baseline';
    state.compareTarget = 'baseline';
  }
};

// ---------------------------------------------------------------------------
// Focused Render Results Rendering
// ---------------------------------------------------------------------------
const buildKpiCard = ({ label, value, tone = '', sub = '', delta = null, deltaTone = 'neutral' }) => {
  const card = makeEl('div', 'kpi-card');
  card.append(makeEl('div', 'kpi-label', label));
  card.append(makeEl('div', `kpi-value ${tone}`.trim(), value));
  if (sub || delta) {
    const subRow = makeEl('div', 'kpi-sub');
    if (sub) subRow.append(makeEl('span', '', sub));
    if (delta) subRow.append(makeEl('span', `delta-badge ${deltaTone}`, delta));
    card.append(subRow);
  }
  return card;
};

const addLegendSwatch = (parent, color, label) => {
  const item = makeEl('span', 'legend-item');
  const swatch = makeEl('span', 'legend-swatch');
  swatch.style.background = color;
  item.append(swatch, document.createTextNode(label));
  parent.append(item);
};

const renderActiveResults = () => {
  const results = state.latestResults;
  if (!results) {
    resultsCardEl.hidden = true;
    return;
  }
  resultsCardEl.hidden = false;
  syncBaselineButtons();

  const hasAudio = Boolean(results.audio);
  const primaryPass = hasAudio ? results.audio : results.visual;
  const { run: comparison } = resolveComparisonRun(results);
  const comparePrimary = hasAudio ? comparison?.audio : (comparison?.visual || comparison?.audio);

  const scenarioInfo = SCENARIO_BY_ID[results.benchmark.scenario];
  resultsTitleEl.textContent = scenarioInfo?.title || results.benchmark.scenario;
  resultsMetaEl.replaceChildren();
  resultsMetaEl.append(
    document.createTextNode(`${(results.benchmark.runMs / 1000).toFixed(0)}s · setup ${results.setupMs.toFixed(0)}ms`),
  );
  if (results.device?.power?.efficiencyMode) {
    const hz = Number.isFinite(results.device.power.rafHz) ? ` ~${results.device.power.rafHz}Hz` : '';
    resultsMetaEl.append(document.createTextNode(' '), makeEl('span', 'badge badge-efficiency', `Efficiency${hz}`));
  }

  copyMdButton.disabled = false;
  exportJsonButton.disabled = false;
  saveButton.disabled = false;

  const fragment = document.createDocumentFragment();

  const kpiGrid = makeEl('div', 'kpi-grid');
  const fpsTone = primaryPass.fps >= 58 ? 'good' : (primaryPass.fps >= 35 ? 'warn' : 'bad');
  kpiGrid.append(buildKpiCard({
    label: hasAudio ? 'Audio FPS' : 'Visual FPS',
    value: primaryPass.fps.toFixed(1),
    tone: fpsTone,
    sub: hasAudio ? `vis ${results.visual.fps.toFixed(1)}` : `${primaryPass.frameCount} frames`,
    delta: comparePrimary ? formatDeltaText(primaryPass.fps, comparePrimary.fps) : null,
    deltaTone: comparePrimary ? deltaClass(primaryPass.fps, comparePrimary.fps, { lowerIsBetter: false }) : 'neutral',
  }));

  const p95Tone = primaryPass.intervalP95 <= 17.5 ? 'good' : (primaryPass.intervalP95 <= 33.4 ? 'warn' : 'bad');
  kpiGrid.append(buildKpiCard({
    label: 'Frame p95',
    value: formatMs(primaryPass.intervalP95),
    tone: p95Tone,
    sub: `p50 ${primaryPass.intervalP50.toFixed(1)} · p99 ${primaryPass.intervalP99.toFixed(1)}`,
    delta: comparePrimary ? formatDeltaText(primaryPass.intervalP95, comparePrimary.intervalP95) : null,
    deltaTone: comparePrimary ? deltaClass(primaryPass.intervalP95, comparePrimary.intervalP95, { lowerIsBetter: true }) : 'neutral',
  }));

  const budgetPct = (primaryPass.workP95 / 16.67) * 100;
  const workTone = primaryPass.workP95 <= 6 ? 'good' : (primaryPass.workP95 <= 13 ? 'warn' : 'bad');
  kpiGrid.append(buildKpiCard({
    label: 'JS Work p95',
    value: formatMs(primaryPass.workP95),
    tone: workTone,
    sub: `${budgetPct.toFixed(0)}% of 60Hz`,
    delta: comparePrimary ? formatDeltaText(primaryPass.workP95, comparePrimary.workP95) : null,
    deltaTone: comparePrimary ? deltaClass(primaryPass.workP95, comparePrimary.workP95, { lowerIsBetter: true }) : 'neutral',
  }));

  const dropTone = primaryPass.droppedPercent <= 2 ? 'good' : (primaryPass.droppedPercent <= 10 ? 'warn' : 'bad');
  const audioOverheadSub = hasAudio
    ? `audio ${(results.audio.workP95 - results.visual.workP95 >= 0 ? '+' : '')}${(results.audio.workP95 - results.visual.workP95).toFixed(2)}ms`
    : `${primaryPass.droppedCount ?? 0} / ${primaryPass.frameCount}`;
  kpiGrid.append(buildKpiCard({
    label: 'Dropped',
    value: `${primaryPass.droppedPercent.toFixed(1)}%`,
    tone: dropTone,
    sub: audioOverheadSub,
    delta: comparePrimary ? formatDeltaText(primaryPass.droppedPercent, comparePrimary.droppedPercent) : null,
    deltaTone: comparePrimary ? deltaClass(primaryPass.droppedPercent, comparePrimary.droppedPercent, { lowerIsBetter: true }) : 'neutral',
  }));

  fragment.append(kpiGrid);

  // Switchable chart card
  const chartCard = makeEl('div', 'chart-card');
  const chartHead = makeEl('div', 'chart-head');

  const viewSwitcher = makeEl('div', 'segmented');
  for (const [key, label] of [['timeline', 'Timeline'], ['distribution', 'Distribution'], ['percentiles', 'Percentiles']]) {
    const btn = makeEl('button', `seg-btn${state.activeChartView === key ? ' active' : ''}`, label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      state.activeChartView = key;
      renderActiveResults();
    });
    viewSwitcher.append(btn);
  }
  chartHead.append(viewSwitcher);

  const controlsRight = makeEl('div', 'chart-controls');
  if (state.activeChartView === 'timeline') {
    if (hasAudio) {
      const passSeg = makeEl('div', 'segmented');
      for (const [key, label] of [['both', 'Both'], ['visual', 'Visual'], ['audio', 'Audio']]) {
        const btn = makeEl('button', `seg-btn${state.timelineView === key ? ' active' : ''}`, label);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          state.timelineView = key;
          renderActiveResults();
        });
        passSeg.append(btn);
      }
      controlsRight.append(passSeg);
    }
    const legend = makeEl('div', 'chart-legend');
    addLegendSwatch(legend, '#8c66ff', 'Visual');
    if (hasAudio) addLegendSwatch(legend, '#efc45f', 'Audio');
    addLegendSwatch(legend, '#59c8f0', 'JS');
    addLegendSwatch(legend, '#e05252', 'Drop');
    controlsRight.append(legend);
  } else if (state.activeChartView === 'distribution') {
    const metricSeg = makeEl('div', 'segmented');
    for (const [key, label] of [['intervals', 'Frame'], ['workTimes', 'JS Work']]) {
      const btn = makeEl('button', `seg-btn${state.histogramMetric === key ? ' active' : ''}`, label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        state.histogramMetric = key;
        renderActiveResults();
      });
      metricSeg.append(btn);
    }
    controlsRight.append(metricSeg);
  } else {
    const legend = makeEl('div', 'chart-legend');
    addLegendSwatch(legend, '#8c66ff', 'Visual');
    if (hasAudio) addLegendSwatch(legend, '#efc45f', 'Audio');
    if (comparison) addLegendSwatch(legend, '#7d7894', 'Comp');
    controlsRight.append(legend);
  }

  chartHead.append(controlsRight);
  const chartHost = makeEl('div', 'chart-host');
  chartCard.append(chartHead, chartHost);
  fragment.append(chartCard);

  const drawer = document.createElement('details');
  drawer.className = 'details-drawer';
  const summary = document.createElement('summary');
  summary.textContent = 'Detailed metrics & device';
  const detailsBody = makeEl('div', 'details-body');

  const tableWrap = makeEl('div', 'table-wrap');
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['Pass', 'FPS', 'p50', 'p95', 'p99', 'JS p50', 'JS p95', 'JS p99', 'Drop', 'Diff']) {
    headerRow.append(makeEl('th', '', label));
  }
  thead.append(headerRow);

  const tbody = document.createElement('tbody');
  const passes = [['Visual', results.visual, comparison?.visual]];
  if (hasAudio) passes.push(['Visual + Audio', results.audio, comparison?.audio]);
  for (const [name, value, old] of passes) {
    const row = document.createElement('tr');
    const cells = [
      [name, ''],
      [value.fps.toFixed(1), 'mono'],
      [formatMs(value.intervalP50), 'mono'],
      [formatMs(value.intervalP95), 'mono'],
      [formatMs(value.intervalP99), 'mono'],
      [formatMs(value.workP50), 'mono'],
      [formatMs(value.workP95), 'mono'],
      [formatMs(value.workP99), 'mono'],
      [`${value.droppedPercent.toFixed(1)}%`, 'mono'],
    ];
    for (const [cellText, cls] of cells) {
      row.append(makeEl('td', cls, cellText));
    }
    const deltaTd = document.createElement('td');
    const dText = formatDeltaText(value.intervalP95, old?.intervalP95);
    const dCls = deltaClass(value.intervalP95, old?.intervalP95, { lowerIsBetter: true });
    deltaTd.append(makeEl('span', `delta-badge ${dCls}`, dText));
    row.append(deltaTd);
    tbody.append(row);
  }
  table.append(thead, tbody);
  tableWrap.append(table);

  const deviceLine = makeEl(
    'p',
    'device-line',
    `${parseBrowserName(results.device.userAgent)} · DPR ${results.device.dpr} · ${results.device.screen} · `
      + `${results.visual.frameCount}v${hasAudio ? ` / ${results.audio.frameCount}a` : ''} frames`,
  );
  detailsBody.append(tableWrap, deviceLine);
  drawer.append(summary, detailsBody);
  fragment.append(drawer);

  resultsElement.replaceChildren(fragment);

  requestAnimationFrame(() => {
    if (state.activeChartView === 'timeline') {
      renderFrameTimelineChart(chartHost, {
        visual: results.visual,
        audio: results.audio,
        activeView: state.timelineView,
      });
    } else if (state.activeChartView === 'distribution') {
      renderDistributionHistogram(chartHost, {
        visual: results.visual,
        audio: results.audio,
        metric: state.histogramMetric,
      });
    } else {
      renderPercentileComparisonChart(chartHost, {
        current: results,
        baseline: comparison,
      });
    }
  });
};

const renderSuiteOverview = () => {
  if (state.suiteResults.length <= 1) {
    suiteSummaryCardEl.hidden = true;
    return;
  }
  suiteSummaryCardEl.hidden = false;
  suiteTabsEl.replaceChildren();
  state.suiteResults.forEach((item, index) => {
    const info = SCENARIO_BY_ID[item.benchmark.scenario];
    const primary = item.audio || item.visual;
    const pill = makeEl('button', `suite-pill${index === state.activeSuiteIndex ? ' active' : ''}`);
    pill.type = 'button';
    pill.append(
      makeEl('span', '', info?.title || item.benchmark.scenario),
      makeEl('span', 'mono', `${primary.fps.toFixed(1)} fps`),
    );
    pill.addEventListener('click', () => {
      state.activeSuiteIndex = index;
      state.latestResults = item;
      renderSuiteOverview();
      renderActiveResults();
    });
    suiteTabsEl.append(pill);
  });
  requestAnimationFrame(() => {
    renderSuiteComparisonChart(suiteChartHostEl, state.suiteResults);
  });
};

// ---------------------------------------------------------------------------
// Render Scenario Execution
// ---------------------------------------------------------------------------
const setControlsBusy = (busy) => {
  state.running = busy;
  runButton.disabled = busy;
  runAllButton.disabled = busy;
  stopButton.hidden = !busy;
  if (busy) saveButton.disabled = true;
  for (const btn of [...scenarioCardsEl.querySelectorAll('.scenario-card'), ...modeButtons, ...durationButtons]) {
    btn.disabled = busy;
  }
};

const executeSingleScenario = async (scenarioId, {
  includeAudio = state.passMode === 'full',
  runMs = state.runMs,
  signal = null,
  saveToServer = includeAudio,
  progressOffset = 0,
  progressSpan = 1,
} = {}) => {
  const scenario = SCENARIO_BY_ID[scenarioId];
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);

  let renderer;
  let player;
  let audio;
  let audioUrl;
  try {
    stageBadgeEl.textContent = 'Preparing';
    setStatus(`Preparing ${scenario.title}…`);
    const setupStart = performance.now();
    const mapData = await scenario.prepare();
    if (signal?.aborted) throw new DOMException('Benchmark cancelled by user.', 'AbortError');

    if (scenario.miniplayer) {
      const probe = await fetch('/popup-bench.html', { cache: 'no-store' });
      if (!probe.ok) {
        throw new Error(`Server missing /popup-bench.html (HTTP ${probe.status}) — restart "npm run performance".`);
      }
      const aspireText = await loadAspireBenchmarkMapText();
      window.__MOSU_BENCH_MAPS__ = { [ASPIRE_MAP_ID]: aspireText };
      canvasPreviewWrapEl.hidden = true;
      miniplayerRenderStageEl.hidden = false;
      renderer = await makeMiniplayerRenderer(mapData, scenario.miniplayer, { signal });
    } else {
      canvasPreviewWrapEl.hidden = false;
      miniplayerRenderStageEl.hidden = true;
      miniplayerRenderStageEl.replaceChildren();
      renderer = makeRenderer(mapData, { multiPanelCount: scenario.multiPanelCount || 1 });
    }
    const events = buildHitsoundEvents(mapData.objects, {
      samplePoints: mapData.timingControlPoints,
      defaultSampleSet: mapData.defaultSampleSet,
    });
    const setupMs = performance.now() - setupStart;

    let audioUnlock = null;
    if (includeAudio) {
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
      audioUnlock = audio.play();
    }

    if (audioUnlock) {
      await audioUnlock;
      audio.pause();
      audio.muted = false;
      player.setEnabled(false);
    }

    const visualWeight = includeAudio ? 0.5 : 1;
    stageBadgeEl.textContent = 'Visual';
    setStatus(`${scenario.title} · Visual pass…`);

    const visual = await runPass({
      renderer,
      player: null,
      events,
      audioEnabled: false,
      fixedMapTimeMs: scenario.fixedMapTimeMs,
      runMs,
      signal,
      onProgress: (info) => {
        updateLiveMetrics({
          ...info,
          progress: progressOffset + progressSpan * (info.fraction * visualWeight),
        });
      },
    });

    let audioPass = null;
    if (includeAudio) {
      player.setEnabled(true);
      player.syncTo(events, 0);
      player.resumeContext();
      await audio.play();

      stageBadgeEl.textContent = 'Visual + Audio';
      setStatus(`${scenario.title} · Audio pass…`);
      audioPass = await runPass({
        renderer,
        player,
        events,
        audioEnabled: true,
        fixedMapTimeMs: scenario.fixedMapTimeMs,
        runMs,
        signal,
        onProgress: (info) => {
          updateLiveMetrics({
            ...info,
            progress: progressOffset + progressSpan * (0.5 + info.fraction * 0.5),
          });
        },
      });
      audio.pause();
      player.setEnabled(false);
    }

    const power = resolvePowerMetadata({ visual, audio: audioPass });
    if (power.source === 'detected-raf-cap' && !state.powerProbe.rafCapped) {
      state.powerProbe.rafCapped = true;
      if (Number.isFinite(power.rafHz)) state.powerProbe.rafHz = power.rafHz;
      renderPowerPill();
    }

    const result = {
      visual,
      audio: audioPass,
      setupMs,
      signature: deviceSignature(),
      device: {
        userAgent: navigator.userAgent,
        dpr: window.devicePixelRatio || 1,
        screen: `${screen.width}x${screen.height}`,
        power,
      },
      benchmark: {
        runMs,
        objectCount: mapData.objects.length,
        scenario: scenario.id,
        description: scenario.description,
      },
    };

    let savedPath = null;
    let saveError = null;
    if (saveToServer && audioPass) {
      try {
        const response = await fetch('/api/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(stripSamplesForSave(result)),
        });
        if (!response.ok) throw new Error(await response.text());
        const saved = await response.json();
        savedPath = saved.resultsPath;
        if (saved.record) {
          result.recordedAt = saved.record.recordedAt;
          result.build = saved.record.build;
          state.historyBrowser.push(saved.record);
          updateTabCounts();
          refreshCompareSelectOptions();
        }
      } catch (error) {
        saveError = error?.message || String(error);
      }
    }

    return { result, savedPath, saveError };
  } finally {
    audio?.pause();
    player?.dispose();
    renderer?.dispose();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }
};

const runScenarios = async (scenarioIds, { includeAudio = state.passMode === 'full', saveToServer = includeAudio } = {}) => {
  if (state.running) return;
  const controller = new AbortController();
  state.abortController = controller;
  state.tabWentHidden = false;
  visibilityBannerEl.hidden = true;
  resetLiveMetrics();
  setControlsBusy(true);

  const collected = [];
  let lastSavedPath = null;
  let lastSaveError = null;
  try {
    const span = 1 / scenarioIds.length;
    for (let i = 0; i < scenarioIds.length; i += 1) {
      const id = scenarioIds[i];
      selectScenario(id);
      const { result, savedPath, saveError } = await executeSingleScenario(id, {
        includeAudio,
        runMs: state.runMs,
        signal: controller.signal,
        saveToServer,
        progressOffset: i * span,
        progressSpan: span,
      });
      collected.push(result);
      if (savedPath) lastSavedPath = savedPath;
      if (saveError) lastSaveError = saveError;
      state.suiteResults = collected;
      state.activeSuiteIndex = collected.length - 1;
      state.latestResults = result;
      renderSuiteOverview();
      renderActiveResults();
    }

    setProgress(1);
    stageBadgeEl.textContent = 'Done';
    saveButton.disabled = !state.latestResults;

    if (lastSaveError) {
      setStatus(`Done (save failed: ${lastSaveError})`, 'warn');
    } else if (lastSavedPath) {
      setStatus(collected.length > 1 ? `Saved ${collected.length} runs` : 'Saved');
    } else {
      setStatus('Done (visual only)');
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      stageBadgeEl.textContent = 'Stopped';
      setStatus('Stopped', 'warn');
    } else {
      stageBadgeEl.textContent = 'Error';
      setStatus(`Failed: ${error?.message || error}`, 'error');
    }
  } finally {
    state.abortController = null;
    setControlsBusy(false);
    if (state.latestResults) saveButton.disabled = false;
  }
};

// ---------------------------------------------------------------------------
// Open & Load (Real Popup Cold/Cached Open + In-Browser Subsystems)
// ---------------------------------------------------------------------------
const setStartupStatus = (text, tone = '') => {
  startupStatusEl.textContent = text;
  startupStatusEl.className = tone;
};

const setStartupProgress = (fraction) => {
  startupProgressFillEl.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
};

const setStartupBusy = (busy) => {
  state.startupRunning = busy;
  runStartupBtn.disabled = busy;
  runStartupAllBtn.disabled = busy;
  stopStartupBtn.hidden = !busy;
  for (const btn of [...startupModeCardsEl.querySelectorAll('.scenario-card'), ...startupIterButtons]) {
    btn.disabled = busy;
  }
};

const buildMiniplayerShellDom = (stageEl, { collapsed = false, iframeUrl, title }) => {
  const shell = makeEl('div', `miniplayer-shell-frame${collapsed ? ' is-collapsed' : ''}`);
  const bar = makeEl('div', 'miniplayer-shell-bar');
  const brand = makeEl('span', 'miniplayer-shell-brand', 'mosu! preview');
  const stateLabel = makeEl('span', 'miniplayer-shell-state', collapsed ? 'Collapsed' : 'Expanded');
  bar.append(brand, makeEl('span', 'miniplayer-shell-pill'), stateLabel);
  const iframe = document.createElement('iframe');
  iframe.className = 'miniplayer-shell-iframe';
  iframe.title = title;
  shell.append(bar, iframe);

  const stageWidth = Math.max(260, (stageEl.clientWidth || 440) - 20);
  const stageHeight = Math.max(160, (stageEl.clientHeight || 360) - 20);
  const naturalHeight = collapsed ? 156 : 444;
  const scale = Math.min(1, stageWidth / 440, stageHeight / naturalHeight);
  shell.style.transform = scale < 1 ? `scale(${scale.toFixed(3)})` : '';

  iframe.src = iframeUrl;
  stageEl.replaceChildren(shell);
  return { shell, iframe, stateLabel };
};

const waitForBenchIframeReady = ({ iframe, runId, signal }) => new Promise((resolve, reject) => {
  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    signal?.removeEventListener('abort', onAbort);
    clearTimeout(timeoutId);
  };

  const onAbort = () => {
    cleanup();
    iframe.remove();
    reject(new DOMException('Cancelled', 'AbortError'));
  };

  const onMessage = (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type !== 'mosu-popup-bench-done' || event.data?.runId !== runId) return;
    cleanup();
    resolve(event.data.metrics);
  };

  iframe.addEventListener('load', () => {
    try {
      const id = iframe.contentWindow?.browser?.runtime?.id;
      if (id !== 'mosu-benchmark-harness') {
        cleanup();
        reject(new Error('Popup harness failed to initialize — restart "npm run performance".'));
      }
    } catch {
      cleanup();
      reject(new Error('Popup harness could not be accessed — restart "npm run performance".'));
    }
  }, { once: true });

  const timeoutId = setTimeout(() => {
    cleanup();
    reject(new Error('Popup open benchmark timed out.'));
  }, 15000);

  if (signal?.aborted) {
    onAbort();
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  window.addEventListener('message', onMessage);
});

const makeMiniplayerRenderer = async (mapData, { initialCollapsed = false, toggleIntervalMs = 0 }, { signal = null } = {}) => {
  const runId = `mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mode = initialCollapsed ? 'miniplayer-collapsed' : 'miniplayer-expanded';
  const iframeUrl = `/popup-bench.html?embedded=1&beatmapId=${encodeURIComponent(ASPIRE_MAP_ID)}`
    + `&setId=2400000&mode=osu${initialCollapsed ? '&collapsed=1' : ''}`
    + `&benchMode=${encodeURIComponent(mode)}&benchMapId=${encodeURIComponent(ASPIRE_MAP_ID)}`
    + `&benchRunId=${encodeURIComponent(runId)}`;

  window.__MOSU_BENCH_T0_EPOCH__ = performance.timeOrigin + performance.now();
  const { shell, iframe, stateLabel } = buildMiniplayerShellDom(miniplayerRenderStageEl, {
    collapsed: initialCollapsed,
    iframeUrl,
    title: 'Miniplayer render benchmark',
  });
  // Always scale for the expanded height when toggling so it never clips.
  if (toggleIntervalMs > 0) {
    const stageWidth = Math.max(260, (miniplayerRenderStageEl.clientWidth || 440) - 20);
    const stageHeight = Math.max(220, (miniplayerRenderStageEl.clientHeight || 330) - 20);
    const scale = Math.min(1, stageWidth / 440, stageHeight / 444);
    shell.style.transform = scale < 1 ? `scale(${scale.toFixed(3)})` : '';
  }

  await waitForBenchIframeReady({ iframe, runId, signal });

  const iframeDoc = iframe.contentDocument;
  const iframeWin = iframe.contentWindow;
  const innerPopup = iframeDoc?.querySelector('#mapPreviewPopup');
  const innerPlayfield = iframeDoc?.querySelector('#mapPreviewCanvas') || playfieldCanvas;
  const innerTimeline = iframeDoc?.querySelector('#mapPreviewTimeline') || timelineCanvas;
  const innerRenderer = new PreviewRenderer(innerPlayfield, innerTimeline);
  innerRenderer.setBeatmap(mapData, resolveMapDurationMs(mapData));
  innerRenderer.setPreviewSettings({
    standardSnakingSliders: true,
    standardSliderSnakeOut: true,
    standardSliderEndCircles: true,
  });

  // Build real OKLCH collapsed timeline colours matching src/ui/miniTheme.js.
  const samplePixels = new Uint8ClampedArray(32 * 24 * 4);
  for (let i = 0; i < samplePixels.length; i += 4) {
    const idx = i >> 2;
    samplePixels[i] = (idx * 17) & 255;
    samplePixels[i + 1] = 60 + ((idx * 7) % 140);
    samplePixels[i + 2] = 180 + ((idx * 11) % 75);
    samplePixels[i + 3] = 255;
  }
  const palette = buildMiniPalette(extractCoverSeed(samplePixels));
  const waveColours = {
    played: formatRgb(palette.onSurface),
    upcoming: formatRgba(palette.onSurfaceVariant, 0.3),
    playhead: formatRgb(palette.onSurface),
    playheadStyle: 'bar',
    preview: formatRgba(palette.accent, 0.95),
    kiaiFill: formatRgba(palette.accent, 0.08),
    kiaiEdge: formatRgba(palette.accent, 0.7),
    breakHatch: 'rgba(255, 255, 255, 0.08)',
    hover: formatRgba(palette.onSurface, 0.32),
    tick: 'rgba(0, 0, 0, 0)',
    wave: formatRgb(palette.accent),
    waveTrack: formatRgba(palette.onSurfaceVariant, 0.3),
  };

  const syncCollapsedTimelineMode = (isCollapsed) => {
    innerRenderer.timeline?.setColours?.(isCollapsed ? waveColours : null);
    innerRenderer.timeline?.setProgressStyle?.(isCollapsed ? 'wave' : 'map');
    innerRenderer.timeline?.setPlaying?.(true);
  };
  syncCollapsedTimelineMode(initialCollapsed);

  const morphTimers = new Set();
  const morph = iframeDoc && innerPopup
    ? createMiniMorph({
      root: iframeDoc.documentElement,
      popup: innerPopup,
      allowsMotion: () => true,
      setTimer: (fn, delay) => {
        const id = setTimeout(() => {
          morphTimers.delete(id);
          fn();
        }, delay);
        morphTimers.add(id);
        return id;
      },
      clearTimer: (id) => {
        clearTimeout(id);
        morphTimers.delete(id);
      },
    })
    : null;

  let collapsed = initialCollapsed;
  let lastToggleAt = performance.now();

  const applyCollapsed = (nextCollapsed) => {
    collapsed = nextCollapsed;
    shell.classList.toggle('is-collapsed', collapsed);
    stateLabel.textContent = collapsed ? 'Collapsed' : 'Expanded';
    if (morph) {
      morph.setCollapsed(collapsed, {
        animate: true,
        onSwitch: (nowCollapsed) => {
          syncCollapsedTimelineMode(nowCollapsed);
          try {
            iframeWin?.dispatchEvent(new iframeWin.Event('resize'));
          } catch {
            // Ignore resize dispatch errors during teardown.
          }
        },
      });
    } else {
      iframeDoc?.documentElement?.classList?.toggle('is-embedded-collapsed', collapsed);
      syncCollapsedTimelineMode(collapsed);
    }
  };

  return {
    setTime(ms) {
      if (toggleIntervalMs > 0) {
        const now = performance.now();
        if (now - lastToggleAt >= toggleIntervalMs) {
          lastToggleAt = now;
          applyCollapsed(!collapsed);
        }
      }
      innerRenderer.setTime(ms);
    },
    render() {
      if (collapsed) {
        innerRenderer.renderTimeline();
      } else {
        innerRenderer.render();
      }
    },
    dispose() {
      morph?.dispose();
      for (const id of morphTimers) clearTimeout(id);
      morphTimers.clear();
      innerRenderer.dispose?.();
    },
  };
};

const measureSinglePopupOpen = (mode, { mapId = ASPIRE_MAP_ID, signal = null } = {}) => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const isMiniExpanded = mode === 'miniplayer-expanded';
  const isMiniCollapsed = mode === 'miniplayer-collapsed';
  const isMini = isMiniExpanded || isMiniCollapsed;

  window.__MOSU_BENCH_T0_EPOCH__ = performance.timeOrigin + performance.now();
  const baseQuery = `benchMode=${encodeURIComponent(mode)}&benchMapId=${encodeURIComponent(mapId)}&benchRunId=${encodeURIComponent(runId)}`;
  const url = isMini
    ? `/popup-bench.html?embedded=1&beatmapId=${encodeURIComponent(mapId)}&setId=2400000&mode=osu${isMiniCollapsed ? '&collapsed=1' : ''}&${baseQuery}`
    : `/popup-bench.html?${baseQuery}`;

  let iframe;
  if (isMini) {
    ({ iframe } = buildMiniplayerShellDom(popupStageEl, {
      collapsed: isMiniCollapsed,
      iframeUrl: url,
      title: `Miniplayer open benchmark (${mode})`,
    }));
  } else {
    iframe = document.createElement('iframe');
    iframe.className = 'popup-bench-iframe';
    iframe.title = `Popup open benchmark (${mode})`;
    const stageWidth = popupStageEl.clientWidth || 454;
    const scale = Math.min(1, stageWidth / 454);
    iframe.style.transform = scale < 1 ? `scale(${scale.toFixed(3)})` : '';
    iframe.src = url;
    popupStageEl.replaceChildren(iframe);
  }

  return waitForBenchIframeReady({ iframe, runId, signal });
};

const measureBrowserSubsystems = async () => {
  const aspireText = await loadAspireBenchmarkMapText();
  const stdText = generateObjectStressBeatmapText(3000);
  const sampleRuns = 5;

  const sampleOp = (fn) => {
    fn(); // warm
    const times = [];
    for (let i = 0; i < sampleRuns; i += 1) {
      const t0 = performance.now();
      fn();
      times.push(performance.now() - t0);
    }
    return { medianMs: percentile(times, 0.5), p95Ms: percentile(times, 0.95) };
  };

  const parsedStd = {
    ...parseMapPreviewData(stdText, { maxObjects: 3000 }),
    breaks: parseBreakPeriods(stdText),
  };
  const parsedAspire = parseMapPreviewData(aspireText, { maxObjects: 2000 });

  const offPlayfield = document.createElement('canvas');
  offPlayfield.width = 512;
  offPlayfield.height = 384;
  const offTimeline = document.createElement('canvas');
  offTimeline.width = 512;
  offTimeline.height = 42;
  const tl = new TimelineRenderer(offTimeline);
  tl.setBeatmap(parsedStd, resolveMapDurationMs(parsedStd));

  const ops = [
    {
      id: 'parse-conic',
      name: 'Parse conic (5839914)',
      category: 'parse',
      ...sampleOp(() => {
        parseMetadata(aspireText);
        parseMapPreviewData(aspireText, { maxObjects: 2000 });
        parseBreakPeriods(aspireText);
      }),
    },
    {
      id: 'parse-std',
      name: 'Parse 3,000 objects',
      category: 'parse',
      ...sampleOp(() => {
        parseMetadata(stdText);
        parseMapPreviewData(stdText, { maxObjects: 3000 });
      }),
    },
    {
      id: 'convert-taiko',
      name: 'Convert std → Taiko',
      category: 'convert',
      ...sampleOp(() => convertMapForMode(parsedStd, 1)),
    },
    {
      id: 'convert-catch',
      name: 'Convert std → Catch',
      category: 'convert',
      ...sampleOp(() => convertMapForMode(parsedStd, 2)),
    },
    {
      id: 'convert-mania',
      name: 'Convert std → Mania 7K',
      category: 'convert',
      ...sampleOp(() => convertMapForMode(parsedStd, 3, { maniaKeyCount: 7 })),
    },
    {
      id: 'hitsounds-build',
      name: 'Build hitsounds (3k)',
      category: 'audio',
      ...sampleOp(() => buildHitsoundEvents(parsedStd.objects, {
        samplePoints: parsedStd.timingControlPoints,
        defaultSampleSet: parsedStd.defaultSampleSet,
      })),
    },
    {
      id: 'first-frame',
      name: 'Setup + 1st frame (conic)',
      category: 'render',
      ...sampleOp(() => {
        const r = new PreviewRenderer(offPlayfield, offTimeline);
        r.setBeatmap(parsedAspire, resolveMapDurationMs(parsedAspire));
        r.setTime(ASPIRE_MAP_TIME_MS);
        r.render();
      }),
    },
    {
      id: 'timeline-zoom',
      name: 'Timeline zoom + render',
      category: 'render',
      ...sampleOp(() => {
        tl.setView(15000, 18000, { animate: false });
        tl.setTime(22000);
        tl.render();
      }),
    },
    {
      id: 'cover-palette',
      name: 'Cover OKLCH palette (100×)',
      category: 'render',
      ...sampleOp(() => {
        const pixels = new Uint8ClampedArray(32 * 24 * 4);
        for (let i = 0; i < pixels.length; i += 4) {
          const idx = i >> 2;
          pixels[i] = (idx * 17) & 255;
          pixels[i + 1] = 60 + ((idx * 7) % 140);
          pixels[i + 2] = 180 + ((idx * 11) % 75);
          pixels[i + 3] = 255;
        }
        for (let i = 0; i < 100; i += 1) {
          buildMiniPalette(extractCoverSeed(pixels));
        }
      }),
    },
    {
      id: 'wavy-progress',
      name: 'Miniplayer wavy bar (200f)',
      category: 'render',
      ...sampleOp(() => {
        const ctx = offTimeline.getContext('2d');
        const cols = { wave: '#b8acff', waveTrack: 'rgba(188,183,206,0.3)', playhead: '#f1eff8' };
        for (let i = 0; i < 200; i += 1) {
          drawWavyProgress(ctx, {
            width: 396,
            height: 20,
            headX: 40 + (i * 1.5),
            amplitude: 1,
            shiftPx: i * 1.2,
            loadingMix: 0,
            loadingShiftPx: 0,
            colours: cols,
          });
        }
      }),
    },
    {
      id: 'miniplayer-layout',
      name: 'Miniplayer bounds/resume (2k)',
      category: 'render',
      ...sampleOp(() => {
        const vp = { width: 1440, height: 900 };
        const edges = ['nw', 'e', 'se', 'w', 's', 'n'];
        let bounds = normalizeEmbeddedBounds(DEFAULT_EMBEDDED_BOUNDS, vp);
        for (let i = 0; i < 2000; i += 1) {
          const collapsed = (i & 1) === 1;
          bounds = computeDraggedBounds({ ...bounds, collapsed }, (i % 11) - 5, (i % 9) - 4, vp);
          bounds = computeResizedBounds(bounds, edges[i % edges.length], (i % 7) - 3, (i % 5) - 2, vp);
          if ((i & 31) === 0) {
            const snap = serializeResumeSnapshot({
              beatmapId: ASPIRE_MAP_ID,
              setId: '2400000',
              mode: 0,
              currentTimeMs: i * 40,
              isPlaying: true,
              collapsed,
            }, 100000);
            resolveResumeSnapshot(snap, 100850);
          }
        }
      }),
    },
  ];
  return ops;
};

const summarizeStartupIterations = (iterations) => {
  const totals = iterations.map((r) => r.totalMs);
  const phaseKeys = ['domCssMs', 'jsBootMs', 'revealMs', 'parseRenderMs', 'paintMs'];
  const phases = Object.fromEntries(
    phaseKeys.map((key) => [key, percentile(iterations.map((r) => r.phases?.[key] || 0), 0.5)]),
  );
  return {
    totalMedianMs: percentile(totals, 0.5),
    totalP95Ms: percentile(totals, 0.95),
    totalMinMs: Math.min(...totals),
    phases,
  };
};

const renderStartupResults = () => {
  const active = state.startupResultsList[state.activeStartupIndex];
  if (!active) {
    startupResultsCardEl.hidden = true;
    return;
  }
  startupResultsCardEl.hidden = false;

  const modeInfo = STARTUP_MODE_BY_ID[active.mode];
  startupResultsTitleEl.textContent = modeInfo?.title || active.mode;
  startupResultsMetaEl.replaceChildren(
    document.createTextNode(`${active.iterations.length} opens · conic (${ASPIRE_MAP_ID})`),
  );
  if (active.power?.efficiencyMode) {
    const hz = Number.isFinite(active.power.rafHz) ? ` ~${active.power.rafHz}Hz` : '';
    startupResultsMetaEl.append(document.createTextNode(' '), makeEl('span', 'badge badge-efficiency', `Efficiency${hz}`));
  }

  startupSuiteTabsEl.replaceChildren();
  if (state.startupResultsList.length > 1) {
    state.startupResultsList.forEach((item, idx) => {
      const mInfo = STARTUP_MODE_BY_ID[item.mode];
      const pill = makeEl('button', `suite-pill${idx === state.activeStartupIndex ? ' active' : ''}`);
      pill.type = 'button';
      pill.append(
        makeEl('span', '', mInfo?.title || item.mode),
        makeEl('span', 'mono', `${item.summary.totalMedianMs.toFixed(0)}ms`),
      );
      pill.addEventListener('click', () => {
        state.activeStartupIndex = idx;
        renderStartupResults();
      });
      startupSuiteTabsEl.append(pill);
    });
  }

  const prevSameMode = state.historyStartup
    .filter((entry) => entry.mode === active.mode && entry.recordedAt !== active.recordedAt)
    .at(-1) || null;

  const { summary } = active;
  const p = summary.phases;
  const fragment = document.createDocumentFragment();

  const kpiGrid = makeEl('div', 'kpi-grid');
  const totalTone = summary.totalMedianMs <= 120 ? 'good' : (summary.totalMedianMs <= 260 ? 'warn' : 'bad');
  kpiGrid.append(buildKpiCard({
    label: 'Total Open',
    value: `${summary.totalMedianMs.toFixed(1)} ms`,
    tone: totalTone,
    sub: `p95 ${summary.totalP95Ms.toFixed(1)}ms`,
    delta: prevSameMode ? formatDeltaText(summary.totalMedianMs, prevSameMode.summary?.totalMedianMs) : null,
    deltaTone: prevSameMode ? deltaClass(summary.totalMedianMs, prevSameMode.summary?.totalMedianMs, { lowerIsBetter: true }) : 'neutral',
  }));
  kpiGrid.append(buildKpiCard({
    label: 'DOM + CSS',
    value: `${p.domCssMs.toFixed(1)} ms`,
    sub: `${((p.domCssMs / Math.max(summary.totalMedianMs, 1)) * 100).toFixed(0)}% of open`,
  }));
  kpiGrid.append(buildKpiCard({
    label: 'JS Boot + Reveal',
    value: `${(p.jsBootMs + p.revealMs).toFixed(1)} ms`,
    sub: `boot ${p.jsBootMs.toFixed(1)} · rev ${p.revealMs.toFixed(1)}`,
  }));
  kpiGrid.append(buildKpiCard({
    label: 'Parse + Paint',
    value: `${(p.parseRenderMs + p.paintMs).toFixed(1)} ms`,
    sub: `parse ${p.parseRenderMs.toFixed(1)} · paint ${p.paintMs.toFixed(1)}`,
  }));
  fragment.append(kpiGrid);

  // Switchable Waterfall / Subsystems chart
  const chartCard = makeEl('div', 'chart-card');
  const chartHead = makeEl('div', 'chart-head');
  const switcher = makeEl('div', 'segmented');
  for (const [key, label] of [['waterfall', 'Open Waterfall'], ['subsystems', 'Browser Subsystems']]) {
    const btn = makeEl('button', `seg-btn${state.startupChartView === key ? ' active' : ''}`, label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      state.startupChartView = key;
      renderStartupResults();
    });
    switcher.append(btn);
  }
  chartHead.append(switcher);

  const legend = makeEl('div', 'chart-legend');
  if (state.startupChartView === 'waterfall') {
    addLegendSwatch(legend, '#59c8f0', 'DOM/CSS');
    addLegendSwatch(legend, '#8c66ff', 'JS Boot');
    addLegendSwatch(legend, '#c48bff', 'Reveal');
    addLegendSwatch(legend, '#efc45f', 'Parse/Render');
    addLegendSwatch(legend, '#3bcf80', 'Paint');
  } else {
    addLegendSwatch(legend, '#59c8f0', 'Parse');
    addLegendSwatch(legend, '#8c66ff', 'Convert');
    addLegendSwatch(legend, '#3bcf80', 'Render');
    addLegendSwatch(legend, '#efc45f', 'Audio');
  }
  chartHead.append(legend);
  const chartHost = makeEl('div', 'chart-host');
  chartCard.append(chartHead, chartHost);
  fragment.append(chartCard);

  // Collapsible per-iteration table
  const drawer = document.createElement('details');
  drawer.className = 'details-drawer';
  const summaryEl = document.createElement('summary');
  summaryEl.textContent = 'Per-iteration timings';
  const body = makeEl('div', 'details-body');
  const tableWrap = makeEl('div', 'table-wrap');
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of ['Run', 'Total', 'DOM + CSS', 'JS Boot', 'Reveal', 'Parse + Render', 'Paint']) {
    headRow.append(makeEl('th', '', col));
  }
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  active.iterations.forEach((iter, idx) => {
    const row = document.createElement('tr');
    for (const [val, cls] of [
      [`#${idx + 1}`, 'mono'],
      [`${iter.totalMs.toFixed(1)} ms`, 'mono'],
      [`${iter.phases.domCssMs.toFixed(1)} ms`, 'mono'],
      [`${iter.phases.jsBootMs.toFixed(1)} ms`, 'mono'],
      [`${iter.phases.revealMs.toFixed(1)} ms`, 'mono'],
      [`${iter.phases.parseRenderMs.toFixed(1)} ms`, 'mono'],
      [`${iter.phases.paintMs.toFixed(1)} ms`, 'mono'],
    ]) {
      row.append(makeEl('td', cls, val));
    }
    tbody.append(row);
  });
  table.append(thead, tbody);
  tableWrap.append(table);
  body.append(tableWrap);
  drawer.append(summaryEl, body);
  fragment.append(drawer);

  startupResultsEl.replaceChildren(fragment);

  requestAnimationFrame(() => {
    if (state.startupChartView === 'waterfall') {
      renderStartupWaterfallChart(chartHost, {
        iterations: active.iterations,
        summary: active.summary,
      });
    } else {
      renderSubsystemBarsChart(chartHost, state.browserSubsystems);
    }
  });
};

const runStartupModes = async (modes) => {
  if (state.startupRunning) return;
  const controller = new AbortController();
  state.startupAbort = controller;
  setStartupBusy(true);
  setStartupProgress(0);
  startupLastEl.textContent = '—';

  try {
    setStartupStatus('Checking popup harness…');
    const probe = await fetch('/popup-bench.html', { cache: 'no-store' });
    if (!probe.ok) {
      throw new Error(`Server missing /popup-bench.html (HTTP ${probe.status}) — restart "npm run performance".`);
    }

    setStartupStatus('Loading map fixture…');
    const aspireText = await loadAspireBenchmarkMapText();
    window.__MOSU_BENCH_MAPS__ = { [ASPIRE_MAP_ID]: aspireText };

    const totalSteps = modes.length * state.startupIters + 1;
    let doneSteps = 0;
    const resultsList = [];

    for (const mode of modes) {
      selectStartupMode(mode);
      const modeTitle = STARTUP_MODE_BY_ID[mode]?.title || mode;
      const iterations = [];
      for (let i = 0; i < state.startupIters; i += 1) {
        setStartupStatus(`${modeTitle} (${i + 1}/${state.startupIters})…`);
        const metrics = await measureSinglePopupOpen(mode, {
          mapId: ASPIRE_MAP_ID,
          signal: controller.signal,
        });
        iterations.push(metrics);
        startupLastEl.textContent = `${metrics.totalMs.toFixed(1)}ms`;
        doneSteps += 1;
        setStartupProgress(doneSteps / totalSteps);
        // Brief pause so iframe teardown settles cleanly between opens.
        await new Promise((r) => setTimeout(r, 80));
      }

      const summary = summarizeStartupIterations(iterations);
      const power = resolvePowerMetadata();
      const recordObj = {
        mode,
        mapId: ASPIRE_MAP_ID,
        iterations,
        summary,
        power,
        recordedAt: null,
      };

      if (startupSaveToggleEl.checked) {
        try {
          const response = await fetch('/api/startup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode,
              mapId: ASPIRE_MAP_ID,
              iterations: iterations.length,
              signature: deviceSignature(),
              device: {
                userAgent: navigator.userAgent,
                dpr: window.devicePixelRatio || 1,
                screen: `${screen.width}x${screen.height}`,
                power,
              },
              summary,
            }),
          });
          if (response.ok) {
            const saved = await response.json();
            if (saved.record) {
              recordObj.recordedAt = saved.record.recordedAt;
              state.historyStartup.push(saved.record);
              updateTabCounts();
            }
          }
        } catch {
          // Keep showing results even if save fails.
        }
      }

      resultsList.push(recordObj);
      state.startupResultsList = resultsList;
      state.activeStartupIndex = resultsList.length - 1;
      renderStartupResults();
    }

    setStartupStatus('Timing browser subsystems…');
    state.browserSubsystems = await measureBrowserSubsystems();
    setStartupProgress(1);
    renderStartupResults();
    setStartupStatus(startupSaveToggleEl.checked ? 'Saved' : 'Done');
  } catch (error) {
    if (error?.name === 'AbortError') {
      setStartupStatus('Stopped', 'warn');
    } else {
      setStartupStatus(`Failed: ${error?.message || error}`, 'error');
    }
  } finally {
    state.startupAbort = null;
    setStartupBusy(false);
  }
};

// ---------------------------------------------------------------------------
// Export / Markdown summary
// ---------------------------------------------------------------------------
const buildMarkdownSummary = (results) => {
  const info = SCENARIO_BY_ID[results.benchmark.scenario];
  const { label: compareLabel, run: comparison } = resolveComparisonRun(results);
  const rows = [
    `### mosu! preview — ${info?.title || results.benchmark.scenario}`,
    '',
    '| Pass | FPS | p50 | p95 | p99 | JS p95 | Dropped | Diff |',
    '| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  const passes = [['Visual', results.visual, comparison?.visual]];
  if (results.audio) passes.push(['Visual + Audio', results.audio, comparison?.audio]);
  for (const [name, pass, old] of passes) {
    rows.push(
      `| ${name} | ${pass.fps.toFixed(1)} | ${formatMs(pass.intervalP50)} | ${formatMs(pass.intervalP95)} | `
      + `${formatMs(pass.intervalP99)} | ${formatMs(pass.workP95)} | ${pass.droppedPercent.toFixed(1)}% | `
      + `${old ? `${formatDeltaText(pass.intervalP95, old.intervalP95)} (${compareLabel})` : '—'} |`,
    );
  }
  return rows.join('\n');
};

// ---------------------------------------------------------------------------
// History Tab (Render + Open & Load)
// ---------------------------------------------------------------------------
const renderHistoryTab = () => {
  const isStartup = state.historyKind === 'startup';
  historyScenarioEl.hidden = isStartup;
  historyMetricEl.hidden = isStartup;
  historyStartupModeEl.hidden = !isStartup;

  const sameDeviceOnly = historySameDeviceEl.checked;
  const excludeEfficiency = Boolean(historyExcludeEfficiencyEl?.checked);
  const mySig = deviceSignature();

  if (isStartup) {
    const modeFilter = historyStartupModeEl.value;
    const filtered = state.historyStartup.filter((entry) => {
      if (modeFilter !== 'all' && entry.mode !== modeFilter) return false;
      if (sameDeviceOnly && entry.signature !== mySig) return false;
      if (excludeEfficiency && entry.device?.power?.efficiencyMode) return false;
      return true;
    });

    historyChartTitleEl.textContent = `Open Time · ${filtered.length} run${filtered.length === 1 ? '' : 's'}`;
    historyChartLegendEl.replaceChildren();
    addLegendSwatch(historyChartLegendEl, '#8c66ff', 'Median');
    addLegendSwatch(historyChartLegendEl, '#efc45f', 'p95');

    requestAnimationFrame(() => {
      renderStartupHistoryTrendChart(historyChartHostEl, filtered);
    });

    if (filtered.length === 0) {
      historyTableWrapEl.replaceChildren(makeEl('div', 'chart-empty', 'No saved Open & Load runs yet.'));
      return;
    }

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const label of ['Date', 'Commit', 'Mode', 'Median', 'p95', 'DOM/CSS', 'JS Boot', 'Parse/Render']) {
      headerRow.append(makeEl('th', '', label));
    }
    thead.append(headerRow);
    const tbody = document.createElement('tbody');
    for (let i = filtered.length - 1; i >= 0; i -= 1) {
      const run = filtered[i];
      const row = document.createElement('tr');
      const dateText = run.recordedAt
        ? new Date(run.recordedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—';
      row.append(makeEl('td', 'mono', dateText));

      const commitTd = document.createElement('td');
      const sha = run.build?.gitCommit ? run.build.gitCommit.slice(0, 7) : '—';
      commitTd.append(makeEl('span', 'mono', sha));
      if (run.build?.workingTreeClean === false) {
        commitTd.append(document.createTextNode(' '), makeEl('span', 'badge badge-dirty', '*'));
      }
      row.append(commitTd);

      const modeTd = document.createElement('td');
      modeTd.append(makeEl('span', 'badge badge-scenario', run.mode || '—'));
      if (run.device?.power?.efficiencyMode) {
        modeTd.append(document.createTextNode(' '), makeEl('span', 'badge badge-efficiency', 'Eff'));
      }
      row.append(modeTd);

      const s = run.summary;
      const p = s?.phases || {};
      row.append(
        makeEl('td', 'mono', Number.isFinite(s?.totalMedianMs) ? `${s.totalMedianMs.toFixed(1)} ms` : '—'),
        makeEl('td', 'mono', Number.isFinite(s?.totalP95Ms) ? `${s.totalP95Ms.toFixed(1)} ms` : '—'),
        makeEl('td', 'mono', Number.isFinite(p.domCssMs) ? `${p.domCssMs.toFixed(1)} ms` : '—'),
        makeEl('td', 'mono', Number.isFinite(p.jsBootMs) ? `${p.jsBootMs.toFixed(1)} ms` : '—'),
        makeEl('td', 'mono', Number.isFinite(p.parseRenderMs) ? `${p.parseRenderMs.toFixed(1)} ms` : '—'),
      );
      tbody.append(row);
    }
    table.append(thead, tbody);
    historyTableWrapEl.replaceChildren(table);
    return;
  }

  const scenarioFilter = historyScenarioEl.value;
  const metric = historyMetricEl.value;

  const filtered = state.historyBrowser.filter((entry) => {
    if (scenarioFilter !== 'all' && entry.benchmark?.scenario !== scenarioFilter) return false;
    if (sameDeviceOnly && entry.signature !== mySig) return false;
    if (excludeEfficiency && entry.device?.power?.efficiencyMode) return false;
    return true;
  });

  const metricLabel = historyMetricEl.selectedOptions[0]?.textContent || metric;
  historyChartTitleEl.textContent = `${metricLabel} · ${filtered.length} run${filtered.length === 1 ? '' : 's'}`;
  historyChartLegendEl.replaceChildren();
  if (metric === 'setupMs') {
    addLegendSwatch(historyChartLegendEl, '#8c66ff', 'Setup');
  } else {
    addLegendSwatch(historyChartLegendEl, '#8c66ff', 'Visual');
    addLegendSwatch(historyChartLegendEl, '#efc45f', 'Audio');
  }

  requestAnimationFrame(() => {
    renderHistoryTrendChart(historyChartHostEl, filtered, { metric });
  });

  if (filtered.length === 0) {
    historyTableWrapEl.replaceChildren(makeEl('div', 'chart-empty', 'No saved runs match this filter.'));
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['Date', 'Commit', 'Scenario', 'FPS', 'Frame p95', 'JS p95', 'Drop', '']) {
    headerRow.append(makeEl('th', '', label));
  }
  thead.append(headerRow);

  const tbody = document.createElement('tbody');
  for (let i = filtered.length - 1; i >= 0; i -= 1) {
    const run = filtered[i];
    const globalIdx = state.historyBrowser.indexOf(run);
    const row = document.createElement('tr');
    if (state.compareTarget === `history:${globalIdx}`) row.classList.add('highlighted');

    const dateText = run.recordedAt
      ? new Date(run.recordedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';
    row.append(makeEl('td', 'mono', dateText));

    const commitTd = document.createElement('td');
    const sha = run.build?.gitCommit ? run.build.gitCommit.slice(0, 7) : '—';
    commitTd.append(makeEl('span', 'mono', sha));
    if (run.build?.workingTreeClean === false) {
      commitTd.append(document.createTextNode(' '), makeEl('span', 'badge badge-dirty', '*'));
    }
    row.append(commitTd);

    const scenTd = document.createElement('td');
    scenTd.append(makeEl('span', 'badge badge-scenario', run.benchmark?.scenario || '—'));
    if (run.device?.power?.efficiencyMode) {
      scenTd.append(document.createTextNode(' '), makeEl('span', 'badge badge-efficiency', 'Eff'));
    }
    row.append(scenTd);

    const audioFps = Number.isFinite(run.audio?.fps) ? run.audio.fps.toFixed(1) : '—';
    row.append(
      makeEl('td', 'mono', audioFps),
      makeEl('td', 'mono', Number.isFinite(run.audio?.intervalP95) ? formatMs(run.audio.intervalP95) : '—'),
      makeEl('td', 'mono', Number.isFinite(run.audio?.workP95) ? formatMs(run.audio.workP95) : '—'),
      makeEl('td', 'mono', Number.isFinite(run.audio?.droppedPercent) ? `${run.audio.droppedPercent.toFixed(1)}%` : '—'),
    );

    const actionTd = document.createElement('td');
    const cmpBtn = makeEl('button', 'btn btn-secondary btn-sm', 'Compare');
    cmpBtn.type = 'button';
    cmpBtn.addEventListener('click', () => {
      state.compareTarget = `history:${globalIdx}`;
      compareSelectEl.value = state.compareTarget;
      switchTab('browser');
      if (state.latestResults) {
        renderActiveResults();
      } else {
        setStatus(`Comparing against ${sha}`);
      }
    });
    actionTd.append(cmpBtn);
    row.append(actionTd);
    tbody.append(row);
  }
  table.append(thead, tbody);
  historyTableWrapEl.replaceChildren(table);
};

// ---------------------------------------------------------------------------
// Microbenchmarks Tab
// ---------------------------------------------------------------------------
const renderMicroTab = () => {
  const runs = state.historyMicro;
  const latest = runs.at(-1) || null;
  const prev = runs.length >= 2 ? runs[runs.length - 2] : null;

  microLatestEl.replaceChildren();
  if (latest) {
    for (const bench of (latest.benchmarks || [])) {
      const card = makeEl('div', 'kpi-card');
      const headRow = makeEl('div', 'section-head');
      headRow.style.marginBottom = '6px';
      const shortName = bench.name.split('(')[0].trim();
      headRow.append(
        makeEl('strong', '', shortName),
        makeEl('span', `badge ${bench.passed ? 'badge-pass' : 'badge-fail'}`, `${bench.speedup.toFixed(1)}×`),
      );
      card.append(headRow);

      const maxMs = Math.max(bench.referenceMs, bench.optimizedMs, Number.EPSILON);
      const addBar = (label, ms, cls) => {
        const row = makeEl('div', 'micro-bar-row');
        row.append(makeEl('span', '', label));
        const track = makeEl('div', 'micro-bar-track');
        const fill = makeEl('div', `micro-bar-fill ${cls}`);
        fill.style.width = `${Math.max(2, (ms / maxMs) * 100).toFixed(1)}%`;
        track.append(fill);
        row.append(track, makeEl('span', '', `${ms.toFixed(3)}ms`));
        card.append(row);
      };
      addBar('Ref', bench.referenceMs, 'ref');
      addBar('Opt', bench.optimizedMs, bench.passed ? 'opt' : 'opt fail');

      const prevBench = prev?.benchmarks?.find((b) => b.name === bench.name);
      if (prevBench) {
        const dText = formatDeltaText(bench.optimizedMs, prevBench.optimizedMs);
        const dCls = deltaClass(bench.optimizedMs, prevBench.optimizedMs, { lowerIsBetter: true });
        const sub = makeEl('div', 'kpi-sub');
        sub.append(makeEl('span', '', 'vs prev'), makeEl('span', `delta-badge ${dCls}`, dText));
        card.append(sub);
      }
      microLatestEl.append(card);
    }
  } else {
    microLatestEl.append(makeEl('div', 'chart-empty', 'No microbenchmark runs yet.'));
  }

  const hasOps = Array.isArray(latest?.operations) && latest.operations.length > 0;
  microOpsCardEl.hidden = !hasOps;

  requestAnimationFrame(() => {
    if (hasOps) {
      renderSubsystemBarsChart(microOpsHostEl, latest.operations);
    }
    renderMicroTrendChart(microChartHostEl, runs);
  });

  if (runs.length === 0) {
    microTableWrapEl.replaceChildren();
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['Date', 'Commit', 'Status', 'Overall', 'Timing', 'Timeline']) {
    headerRow.append(makeEl('th', '', label));
  }
  thead.append(headerRow);
  const tbody = document.createElement('tbody');
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    const row = document.createElement('tr');
    const dateText = run.recordedAt
      ? new Date(run.recordedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';
    row.append(makeEl('td', 'mono', dateText));

    const sha = run.build?.gitCommit ? run.build.gitCommit.slice(0, 7) : '—';
    const commitTd = document.createElement('td');
    commitTd.append(makeEl('span', 'mono', sha));
    if (run.build?.workingTreeClean === false) {
      commitTd.append(document.createTextNode(' '), makeEl('span', 'badge badge-dirty', '*'));
    }
    row.append(commitTd);

    const statusTd = document.createElement('td');
    statusTd.append(makeEl('span', `badge ${run.passed ? 'badge-pass' : 'badge-fail'}`, run.passed ? 'PASS' : 'FAIL'));
    row.append(statusTd);

    const b0 = run.benchmarks?.[0];
    const b1 = run.benchmarks?.[1];
    row.append(
      makeEl('td', 'mono', Number.isFinite(run.overallSpeedup) ? `${run.overallSpeedup.toFixed(1)}×` : '—'),
      makeEl('td', 'mono', b0 ? `${b0.optimizedMs.toFixed(3)}ms` : '—'),
      makeEl('td', 'mono', b1 ? `${b1.optimizedMs.toFixed(3)}ms` : '—'),
    );
    tbody.append(row);
  }
  table.append(thead, tbody);
  microTableWrapEl.replaceChildren(table);
};

// ---------------------------------------------------------------------------
// Data Loading & Initialization
// ---------------------------------------------------------------------------
const updateTabCounts = () => {
  historyCountEl.textContent = String(state.historyBrowser.length + state.historyStartup.length);
  microCountEl.textContent = String(state.historyMicro.length);
};

const renderMetaPill = () => {
  metaPillEl.replaceChildren();
  const build = state.serverMeta?.build;
  if (!build) return;
  const sha = build.gitCommit ? build.gitCommit.slice(0, 7) : 'local';
  metaPillEl.append(
    makeEl('span', `dot${build.workingTreeClean === false ? ' dirty' : ''}`),
    document.createTextNode(`v${build.version} · ${sha}`),
  );
};

const fetchHistoryAndMeta = async () => {
  try {
    const [metaRes, resultsRes] = await Promise.all([
      fetch('/api/meta'),
      fetch('/api/results'),
    ]);
    if (metaRes.ok) {
      state.serverMeta = await metaRes.json();
      renderMetaPill();
    }
    if (resultsRes.ok) {
      const payload = await resultsRes.json();
      state.historyBrowser = Array.isArray(payload.browser) ? payload.browser : [];
      state.historyStartup = Array.isArray(payload.startup) ? payload.startup : [];
      state.historyMicro = Array.isArray(payload.micro) ? payload.micro : [];
      updateTabCounts();
      refreshCompareSelectOptions();
      if (state.activeTab === 'history') renderHistoryTab();
      if (state.activeTab === 'micro') renderMicroTab();
    }
  } catch {
    renderMetaPill();
  }
};

const selectScenario = (scenarioId) => {
  if (!SCENARIO_BY_ID[scenarioId]) return;
  scenarioElement.value = scenarioId;
  for (const card of scenarioCardsEl.querySelectorAll('.scenario-card')) {
    const isSelected = card.dataset.scenario === scenarioId;
    card.classList.toggle('selected', isSelected);
    card.setAttribute('aria-checked', String(isSelected));
  }
};

const buildScenarioCards = () => {
  scenarioCardsEl.replaceChildren();
  for (const scenario of SCENARIOS) {
    const card = makeEl('button', 'scenario-card');
    card.type = 'button';
    card.role = 'radio';
    card.dataset.scenario = scenario.id;
    card.append(
      makeEl('span', 'scenario-card-title', scenario.title),
      makeEl('span', 'scenario-tag', scenario.tag),
    );
    card.addEventListener('click', () => {
      if (state.running) return;
      selectScenario(scenario.id);
    });
    scenarioCardsEl.append(card);
  }
  selectScenario(scenarioElement.value || SLIDER_STRESS_SCENARIO);
};

const selectStartupMode = (modeId) => {
  if (!STARTUP_MODE_BY_ID[modeId]) return;
  state.startupMode = modeId;
  for (const card of startupModeCardsEl.querySelectorAll('.scenario-card')) {
    const isSelected = card.dataset.mode === modeId;
    card.classList.toggle('selected', isSelected);
    card.setAttribute('aria-checked', String(isSelected));
  }
};

const buildStartupModeCards = () => {
  startupModeCardsEl.replaceChildren();
  for (const mode of STARTUP_MODES) {
    const card = makeEl('button', 'scenario-card');
    card.type = 'button';
    card.role = 'radio';
    card.dataset.mode = mode.id;
    card.append(
      makeEl('span', 'scenario-card-title', mode.title),
      makeEl('span', 'scenario-tag', mode.tag),
    );
    card.addEventListener('click', () => {
      if (state.startupRunning) return;
      selectStartupMode(mode.id);
    });
    startupModeCardsEl.append(card);
  }
  selectStartupMode(state.startupMode);
};

const switchTab = (tabName) => {
  if (!Object.hasOwn(tabPanels, tabName)) return;
  state.activeTab = tabName;
  for (const btn of tabButtons) {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  for (const [name, panel] of Object.entries(tabPanels)) {
    panel.hidden = name !== tabName;
  }
  if (tabName === 'history') renderHistoryTab();
  if (tabName === 'micro') renderMicroTab();
  if (tabName === 'startup' && state.startupResultsList.length > 0) renderStartupResults();
  if (tabName === 'browser' && state.latestResults) {
    renderSuiteOverview();
    renderActiveResults();
  }
};

// Wire events
for (const btn of tabButtons) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}

for (const btn of modeButtons) {
  btn.addEventListener('click', () => {
    if (state.running) return;
    state.passMode = btn.dataset.mode;
    for (const b of modeButtons) b.classList.toggle('active', b === btn);
  });
}

for (const btn of durationButtons) {
  btn.addEventListener('click', () => {
    if (state.running) return;
    state.runMs = Number(btn.dataset.duration) || DEFAULT_RUN_MS;
    for (const b of durationButtons) b.classList.toggle('active', b === btn);
  });
}

for (const btn of startupIterButtons) {
  btn.addEventListener('click', () => {
    if (state.startupRunning) return;
    state.startupIters = Number(btn.dataset.iters) || 5;
    for (const b of startupIterButtons) b.classList.toggle('active', b === btn);
  });
}

for (const btn of historyKindButtons) {
  btn.addEventListener('click', () => {
    state.historyKind = btn.dataset.kind;
    for (const b of historyKindButtons) b.classList.toggle('active', b === btn);
    renderHistoryTab();
  });
}

scenarioElement.addEventListener('change', () => selectScenario(scenarioElement.value));

runButton.addEventListener('click', () => {
  void runScenarios([scenarioElement.value]);
});

runAllButton.addEventListener('click', () => {
  void runScenarios(SCENARIOS.map((s) => s.id));
});

stopButton.addEventListener('click', () => {
  state.abortController?.abort();
});

runStartupBtn.addEventListener('click', () => {
  void runStartupModes([state.startupMode]);
});

runStartupAllBtn.addEventListener('click', () => {
  void runStartupModes(STARTUP_MODES.map((m) => m.id));
});

stopStartupBtn.addEventListener('click', () => {
  state.startupAbort?.abort();
});

saveButton.addEventListener('click', () => {
  if (!state.latestResults) return;
  localStorage.setItem(BASELINE_KEY, JSON.stringify(stripSamplesForSave(state.latestResults)));
  state.compareTarget = 'baseline';
  compareSelectEl.value = 'baseline';
  renderActiveResults();
  setStatus('Baseline pinned');
});

clearButton.addEventListener('click', () => {
  localStorage.removeItem(BASELINE_KEY);
  if (state.latestResults) renderActiveResults();
  setStatus('Baseline cleared');
});

compareSelectEl.addEventListener('change', () => {
  state.compareTarget = compareSelectEl.value;
  renderActiveResults();
});

copyMdButton.addEventListener('click', async () => {
  if (!state.latestResults) return;
  try {
    await navigator.clipboard.writeText(buildMarkdownSummary(state.latestResults));
    const original = copyMdButton.textContent;
    copyMdButton.textContent = 'Copied';
    setTimeout(() => { copyMdButton.textContent = original; }, 1400);
  } catch {
    setStatus('Clipboard unavailable', 'warn');
  }
});

exportJsonButton.addEventListener('click', () => {
  if (!state.latestResults) return;
  const payload = stripSamplesForSave(state.latestResults);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `mosu-bench-${payload.benchmark.scenario}-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

refreshHistoryBtn.addEventListener('click', () => {
  void fetchHistoryAndMeta();
});
historyScenarioEl.addEventListener('change', renderHistoryTab);
historyMetricEl.addEventListener('change', renderHistoryTab);
historyStartupModeEl.addEventListener('change', renderHistoryTab);
historySameDeviceEl.addEventListener('change', renderHistoryTab);
historyExcludeEfficiencyEl?.addEventListener('change', renderHistoryTab);

powerPillEl?.addEventListener('click', () => {
  const order = ['auto', 'efficiency', 'normal'];
  state.powerOverride = order[(order.indexOf(state.powerOverride) + 1) % order.length];
  renderPowerPill();
});

runMicroButton.addEventListener('click', async () => {
  runMicroButton.disabled = true;
  microStatusEl.textContent = 'Running…';
  try {
    const response = await fetch('/api/micro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ save: microSaveToggleEl.checked }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    if (data.record) {
      state.historyMicro.push(data.record);
      updateTabCounts();
      renderMicroTab();
    }
    microStatusEl.textContent = `${data.record.overallSpeedup.toFixed(1)}× overall${data.saved ? ' · saved' : ''}`;
  } catch (error) {
    microStatusEl.textContent = `Failed: ${error?.message || error}`;
  } finally {
    runMicroButton.disabled = false;
  }
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.activeTab === 'browser' && state.latestResults) {
      renderSuiteOverview();
      renderActiveResults();
    } else if (state.activeTab === 'startup' && state.startupResultsList.length > 0) {
      renderStartupResults();
    } else if (state.activeTab === 'history') {
      renderHistoryTab();
    } else if (state.activeTab === 'micro') {
      renderMicroTab();
    }
  }, 140);
});

// Boot & URL parameter handling
buildScenarioCards();
buildStartupModeCards();
initPowerDetection();

const params = new URLSearchParams(window.location.search);
const paramScenario = params.get('scenario');
if (paramScenario && SCENARIO_BY_ID[paramScenario]) {
  selectScenario(paramScenario);
}
const paramDuration = Number(params.get('duration'));
if (Number.isFinite(paramDuration) && paramDuration >= 1 && paramDuration <= 60) {
  state.runMs = Math.round(paramDuration) * 1000;
  for (const btn of durationButtons) {
    btn.classList.toggle('active', Number(btn.dataset.duration) === state.runMs);
  }
}
const paramTab = params.get('tab');
if (paramTab && Object.hasOwn(tabPanels, paramTab)) {
  switchTab(paramTab);
}

void fetchHistoryAndMeta();

const autoBenchmark = params.get('autobench');
if (autoBenchmark) {
  const autoList = autoBenchmark === 'all'
    ? SCENARIOS.map((s) => s.id)
    : (SCENARIO_BY_ID[autoBenchmark] ? [autoBenchmark] : []);
  if (autoList.length > 0) {
    state.passMode = 'visual';
    for (const btn of modeButtons) {
      btn.classList.toggle('active', btn.dataset.mode === 'visual');
    }
    selectScenario(autoList[0]);
    void runScenarios(autoList, { includeAudio: false, saveToServer: false });
  }
}
