import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import {
  buildLaunchUrl,
  createPerformanceServer,
  formatSavedBrowserSummary,
  isAllowedHostHeader,
  isValidBrowserResult,
  isValidStartupResult,
  parsePort,
  parseServerArgs,
  resolveAllowedFilePath,
  sanitizeBrowserResult,
  sanitizeStartupResult,
} from '../scripts/performance-server.mjs';
import {
  appendPerformanceResult,
  readPerformanceResults,
} from '../scripts/performance-results.mjs';
import {
  formatMicroHistory,
  formatMicroReport,
  parseMicroArgs,
  runMicroBenchmarks,
} from '../scripts/performance.mjs';

const samplePass = {
  fps: 60,
  frameCount: 120,
  elapsedMs: 2000,
  intervalP50: 16.6,
  intervalP95: 17.2,
  intervalP99: 18.0,
  workP50: 2.1,
  workP95: 3.4,
  workP99: 4.0,
  droppedPercent: 0,
};

test('resolveAllowedFilePath blocks path traversal bypasses like /src/..%2feslint.config.js (H24)', async () => {
  assert.equal(await resolveAllowedFilePath('/src/..%2feslint.config.js'), null);
  assert.equal(await resolveAllowedFilePath('/src/../package.json'), null);
  assert.equal(await resolveAllowedFilePath('/src/..\\eslint.config.js'), null);
  assert.equal(await resolveAllowedFilePath('/src/popup.js\0.js'), null);
  assert.equal(await resolveAllowedFilePath('/tests/parser.test.js'), null);
  assert.equal(await resolveAllowedFilePath('/assets/fonts/../package.json'), null);

  const validJs = await resolveAllowedFilePath('/src/parser.js');
  assert.ok(validJs && validJs.endsWith('parser.js'));

  const rootPage = await resolveAllowedFilePath('/');
  assert.ok(rootPage && rootPage.endsWith('performance.html'));

  const cssFile = await resolveAllowedFilePath('/scripts/performance.css');
  assert.ok(cssFile && cssFile.endsWith('performance.css'));

  const chartsFile = await resolveAllowedFilePath('/scripts/performance-charts.js');
  assert.ok(chartsFile && chartsFile.endsWith('performance-charts.js'));

  const shimFile = await resolveAllowedFilePath('/scripts/performance-popup-shim.js');
  assert.ok(shimFile && shimFile.endsWith('performance-popup-shim.js'));

  const popupCss = await resolveAllowedFilePath('/popup.css');
  assert.ok(popupCss && popupCss.endsWith('popup.css'));

  const fontFile = await resolveAllowedFilePath('/assets/fonts/Torus-Regular.otf');
  assert.ok(fontFile && fontFile.endsWith('Torus-Regular.otf'));
});

test('isAllowedHostHeader blocks DNS rebinding on loopback mode', () => {
  assert.equal(isAllowedHostHeader('127.0.0.1:4173', 4173, false), true);
  assert.equal(isAllowedHostHeader('localhost:4173', 4173, false), true);
  assert.equal(isAllowedHostHeader('[::1]:4173', 4173, false), true);
  assert.equal(isAllowedHostHeader('evil.example:4173', 4173, false), false);
  assert.equal(isAllowedHostHeader('127.0.0.1:9999', 4173, false), false);
  assert.equal(isAllowedHostHeader('192.168.1.5:4173', 4173, true), true);
});

test('isValidBrowserResult rejects array benchmark payloads and sanitizeBrowserResult strips extra fields', () => {
  assert.equal(isValidBrowserResult({ setupMs: 1, signature: 's', device: {}, benchmark: [], visual: samplePass, audio: samplePass }), false);
  assert.equal(isValidBrowserResult(null), false);

  const valid = {
    setupMs: 12,
    signature: 'sig-1',
    device: { userAgent: 'Chrome', dpr: 2, screen: '1920x1080', extra: 'drop' },
    benchmark: { runMs: 2000, objectCount: 500, scenario: 'std', description: 'desc', injected: 'bad' },
    visual: { ...samplePass, rogue: 1 },
    audio: samplePass,
    unexpectedTopLevel: 'drop',
  };
  assert.equal(isValidBrowserResult(valid), true);

  const sanitized = sanitizeBrowserResult(valid);
  assert.equal('unexpectedTopLevel' in sanitized, false);
  assert.equal('injected' in sanitized.benchmark, false);
  assert.equal('extra' in sanitized.device, false);
  assert.equal('power' in sanitized.device, false);
  assert.equal('rogue' in sanitized.visual, false);
  assert.equal(sanitized.benchmark.scenario, 'std');

  const withPower = sanitizeBrowserResult({
    ...valid,
    device: {
      ...valid.device,
      power: { efficiencyMode: true, source: 'detected-raf-cap', rafHz: 32.6, onBattery: true, batteryLevel: 0.425, reducedMotion: false, bogus: 1 },
    },
  });
  assert.deepEqual(withPower.device.power, {
    efficiencyMode: true,
    source: 'detected-raf-cap',
    rafHz: 33,
    onBattery: true,
    batteryLevel: 0.43,
    reducedMotion: false,
  });
  assert.match(formatSavedBrowserSummary(withPower), /\[efficiency ~33Hz\]/);
});

test('isValidStartupResult and sanitizeStartupResult validate startup payloads', () => {
  const valid = {
    mode: 'cached',
    mapId: '5839914',
    iterations: 5,
    signature: 'sig-s',
    device: { userAgent: 'Chrome', dpr: 1.5, screen: '1920x1080', extra: 1 },
    summary: {
      totalMedianMs: 85.4,
      totalP95Ms: 102.1,
      totalMinMs: 74.0,
      phases: { domCssMs: 20, jsBootMs: 25, revealMs: 5, parseRenderMs: 28, paintMs: 7.4, rogue: 99 },
    },
    extraTop: true,
  };
  assert.equal(isValidStartupResult(valid), true);
  assert.equal(isValidStartupResult({ ...valid, mode: 'miniplayer-expanded' }), true);
  assert.equal(isValidStartupResult({ ...valid, mode: 'miniplayer-collapsed' }), true);
  assert.equal(isValidStartupResult({ ...valid, mode: 'bad-mode' }), false);
  assert.equal(isValidStartupResult({ ...valid, iterations: 0 }), false);

  const sanitized = sanitizeStartupResult(valid);
  assert.equal('extraTop' in sanitized, false);
  assert.equal('extra' in sanitized.device, false);
  assert.equal('rogue' in sanitized.summary.phases, false);
  assert.equal(sanitized.summary.totalMedianMs, 85.4);
});

test('parsePort validates port range', () => {
  assert.equal(parsePort(undefined), 4173);
  assert.equal(parsePort('8080'), 8080);
  assert.throws(() => parsePort('abc'), /Invalid MOSU_PERF_PORT/);
  assert.throws(() => parsePort('70000'), /Invalid MOSU_PERF_PORT/);
});

test('parseServerArgs and buildLaunchUrl handle CLI flags and env vars', () => {
  const defaults = parseServerArgs([], {});
  assert.equal(defaults.port, 4173);
  assert.equal(defaults.explicitPort, false);
  assert.equal(defaults.exposeOnNetwork, false);
  assert.equal(defaults.openBrowser, true);

  const parsed = parseServerArgs(
    ['--port', '4555', '--lan', '--no-open', '--scenario=mania-7k', '--duration', '4', '--startup'],
    {},
  );
  assert.equal(parsed.port, 4555);
  assert.equal(parsed.explicitPort, true);
  assert.equal(parsed.exposeOnNetwork, true);
  assert.equal(parsed.openBrowser, false);
  assert.equal(parsed.scenario, 'mania-7k');
  assert.equal(parsed.durationSec, 4);
  assert.equal(parsed.tab, 'startup');

  assert.equal(
    buildLaunchUrl(4555, parsed),
    'http://127.0.0.1:4555/?scenario=mania-7k&duration=4&tab=startup',
  );

  const autoParsed = parseServerArgs(['--auto=miniplayer-toggle'], { MOSU_PERF_NO_OPEN: '1' });
  assert.equal(autoParsed.openBrowser, false);
  assert.equal(buildLaunchUrl(4173, autoParsed), 'http://127.0.0.1:4173/?autobench=miniplayer-toggle');

  const miniCollapsed = parseServerArgs(['--scenario=miniplayer-collapsed'], {});
  assert.equal(miniCollapsed.scenario, 'miniplayer-collapsed');

  assert.throws(() => parseServerArgs(['--scenario', 'nope'], {}), /Invalid --scenario/);
  assert.throws(() => parseServerArgs(['--duration', '999'], {}), /Invalid --duration/);
  assert.throws(() => parseServerArgs(['--unknown'], {}), /Unknown option/);
});

test('readPerformanceResults reads JSONL safely, filters by kind/limit, and skips corrupt lines', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'mosu-perf-test-'));
  const file = join(tempDir, 'results.jsonl');
  try {
    assert.deepEqual(await readPerformanceResults({ resultsFile: file }), []);

    await appendPerformanceResult('micro', { overallSpeedup: 12.5, passed: true, benchmarks: [] }, { resultsFile: file });
    await appendPerformanceResult('browser', { benchmark: { scenario: 'aspire-conic' } }, { resultsFile: file });
    await writeFile(file, `${await readFile(file, 'utf8')}{broken json\n\n`, 'utf8');
    await appendPerformanceResult('micro', { overallSpeedup: 14.0, passed: true, benchmarks: [] }, { resultsFile: file });

    const all = await readPerformanceResults({ resultsFile: file });
    assert.equal(all.length, 3);
    const micro = await readPerformanceResults({ kind: 'micro', resultsFile: file });
    assert.equal(micro.length, 2);
    assert.equal(micro[1].overallSpeedup, 14.0);
    const limited = await readPerformanceResults({ kind: 'micro', limit: 1, resultsFile: file });
    assert.equal(limited.length, 1);
    assert.equal(limited[0].overallSpeedup, 14.0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('performance server serves popup harness, meta, history, and saves browser + startup + micro runs', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'mosu-perf-http-'));
  const resultsFile = join(tempDir, 'results.jsonl');
  const savedEvents = [];
  const server = createPerformanceServer({
    port: 0,
    exposeOnNetwork: false,
    resultsFile,
    onSaved: (kind, record) => savedEvents.push({ kind, record }),
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Popup open benchmark harness serves real popup.html with injected shim
    const harnessRes = await fetch(`${baseUrl}/popup-bench.html`);
    assert.equal(harnessRes.status, 200);
    const harnessHtml = await harnessRes.text();
    assert.match(harnessHtml, /performance-popup-shim\.js/);
    assert.match(harnessHtml, /src\/popup\.js/);

    const metaRes = await fetch(`${baseUrl}/api/meta`);
    assert.equal(metaRes.status, 200);
    const meta = await metaRes.json();
    assert.equal(meta.port, port);
    assert.ok(meta.environment?.node);

    const payload = {
      setupMs: 25,
      signature: 'sig-http',
      device: { userAgent: 'TestAgent', dpr: 1, screen: '1280x720' },
      benchmark: { runMs: 3000, objectCount: 1, scenario: 'anchor-heavy-slider', description: 'test' },
      visual: samplePass,
      audio: samplePass,
    };

    // Missing Origin header must be rejected
    const forbiddenRes = await fetch(`${baseUrl}/api/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(forbiddenRes.status, 403);

    // Valid same-origin browser POST
    const saveRes = await fetch(`${baseUrl}/api/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify(payload),
    });
    assert.equal(saveRes.status, 201);
    const saved = await saveRes.json();
    assert.equal(saved.saved, true);
    assert.equal(saved.record.kind, 'browser');

    // Valid same-origin startup POST
    const startupRes = await fetch(`${baseUrl}/api/startup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({
        mode: 'cached',
        mapId: '5839914',
        iterations: 3,
        signature: 'sig-http',
        device: { userAgent: 'TestAgent', dpr: 1, screen: '1280x720' },
        summary: {
          totalMedianMs: 72.5,
          totalP95Ms: 88.0,
          totalMinMs: 66.2,
          phases: { domCssMs: 18, jsBootMs: 22, revealMs: 4, parseRenderMs: 20, paintMs: 8.5 },
        },
      }),
    });
    assert.equal(startupRes.status, 201);
    const startupSaved = await startupRes.json();
    assert.equal(startupSaved.record.kind, 'startup');

    // Run microbenchmark via POST /api/micro without saving
    const microRes = await fetch(`${baseUrl}/api/micro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ save: false, sampleCount: 2 }),
    });
    assert.equal(microRes.status, 200);
    const microBody = await microRes.json();
    assert.equal(microBody.saved, false);
    assert.equal(microBody.record.benchmarks.length, 2);
    assert.ok(Array.isArray(microBody.record.operations) && microBody.record.operations.length >= 6);

    // Verify GET /api/results reflects both saved browser & startup runs
    const afterRes = await fetch(`${baseUrl}/api/results`);
    const afterBody = await afterRes.json();
    assert.equal(afterBody.browser.length, 1);
    assert.equal(afterBody.startup.length, 1);
    assert.equal(afterBody.micro.length, 0);
    assert.equal(savedEvents.length, 2);
    assert.match(formatSavedBrowserSummary(saved.record), /anchor-heavy-slider/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('microbenchmark runner, subsystem operations, arg parser, and CLI formatters work cleanly', async () => {
  const args = parseMicroArgs(['--no-save', '--samples=3', '--json', '--no-color']);
  assert.equal(args.skipSave, true);
  assert.equal(args.sampleCount, 3);
  assert.equal(args.json, true);
  assert.equal(args.noColor, true);

  const histArgs = parseMicroArgs(['--history', '5']);
  assert.equal(histArgs.history, true);
  assert.equal(histArgs.historyLimit, 5);
  assert.throws(() => parseMicroArgs(['--samples', '0']), /Invalid --samples/);

  const result = await runMicroBenchmarks({ sampleCount: 2 });
  assert.equal(result.benchmarks.length, 2);
  assert.ok(result.operations.length >= 11);
  assert.ok(result.operations.some((op) => op.id === 'miniplayer-layout'));
  assert.ok(result.operations.some((op) => op.id === 'cover-palette'));
  assert.ok(result.operations.some((op) => op.id === 'wavy-progress'));
  assert.ok(result.overallSpeedup > 1);
  assert.equal(typeof result.passed, 'boolean');

  const report = formatMicroReport(result, { useColor: false });
  assert.match(report, /Node Microbenchmarks/);
  assert.match(report, /Extension Subsystems/);
  assert.match(report, /Overall geometric-mean speedup/);

  const historyText = formatMicroHistory([
    { ...result, recordedAt: '2026-10-07T02:43:38.203Z', build: { gitCommit: 'abcdef123456', workingTreeClean: true } },
    { ...result, recordedAt: '2026-10-08T02:43:38.203Z', build: { gitCommit: '1234567890ab', workingTreeClean: false } },
  ], { useColor: false });
  assert.match(historyText, /Microbenchmark History \(2 runs\)/);
  assert.match(historyText, /Overall speedup trend/);
});
