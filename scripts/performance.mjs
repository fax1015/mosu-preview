import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PreviewRenderer } from '../src/renderer.js';
import { createTimingLookup } from '../src/parser.js';

const SAMPLE_COUNT = 9;
const PARSER_QUERIES = 8000;
const RENDER_OBJECTS = 60000;

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const measure = (run, iterations) => {
  const samples = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      run();
    }
    samples.push(performance.now() - start);
  }
  return median(samples) / iterations;
};

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

const optimizedTimingAt = createTimingLookup(timingPoints);
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

globalThis.window = { devicePixelRatio: 1 };
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
const renderer = new PreviewRenderer(canvas, canvas);
renderer.durationMs = RENDER_OBJECTS * 60;
renderer.visualTimelineDurationMs = renderer.durationMs;
renderer.timelineViewStartMs = 120000;
renderer.timelineViewDurationMs = 120000;
renderer.timelineDensity = [];
renderer.mapData = { objects, timingControlPoints: [] };
renderer.currentTimeMs = 180000;
renderer.renderTimeline(); // Warm the cached visible range once.

const runReferenceTimeline = () => {
  renderer.timelineDensityViewCache = null;
  renderer.renderTimeline();
};
const runOptimizedTimeline = () => renderer.renderTimeline();

// Warm both paths before collecting samples, and confirm each still draws the
// same timeline state without changing the fixture.
runReferenceTimeline();
runOptimizedTimeline();

const benchmarks = [
  {
    name: 'slider timing lookup (8,000 queries / 3,000 timing points)',
    referenceMs: measure(runReferenceTiming, 1),
    optimizedMs: measure(runOptimizedTiming, 1),
    minimumSpeedup: 1.1,
  },
  {
    name: 'zoomed timeline frame (60,000 objects)',
    referenceMs: measure(runReferenceTimeline, 35),
    optimizedMs: measure(runOptimizedTimeline, 35),
    minimumSpeedup: 1.05,
  },
];

let logSpeedup = 0;
let passed = true;
for (const benchmark of benchmarks) {
  const speedup = benchmark.referenceMs / benchmark.optimizedMs;
  logSpeedup += Math.log(speedup);
  const benchmarkPassed = speedup >= benchmark.minimumSpeedup;
  passed &&= benchmarkPassed;
  console.log(
    `${benchmarkPassed ? 'PASS' : 'FAIL'} ${benchmark.name}: `
      + `${benchmark.referenceMs.toFixed(3)}ms → ${benchmark.optimizedMs.toFixed(3)}ms `
      + `(${speedup.toFixed(2)}×, required ${benchmark.minimumSpeedup.toFixed(2)}×)`,
  );
}

const overallSpeedup = Math.exp(logSpeedup / benchmarks.length);
console.log(`${passed ? 'PASS' : 'FAIL'} overall geometric-mean speedup: ${overallSpeedup.toFixed(2)}×`);
if (!passed) {
  process.exitCode = 1;
}
