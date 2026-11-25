import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendPerformanceResult,
  buildPerformanceRecord,
  DEFAULT_RESULTS_PATH,
  formatRelativeResultsPath,
  getEnvironmentInfo,
  readBuildInfo,
  readPerformanceResults,
} from './performance-results.mjs';
import { runMicroBenchmarks } from './performance.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_PORT = 4173;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_MICRO_BODY_BYTES = 4 * 1024;
const VALID_SCENARIOS = new Set([
  'anchor-heavy-slider',
  'aspire-conic',
  'object-stress',
  'mania-7k',
  'catch-fruits',
  'compare-4up',
  'miniplayer-collapsed',
  'miniplayer-toggle',
  'all',
]);
const VALID_TABS = new Set(['browser', 'startup', 'history', 'micro']);
const VALID_STARTUP_MODES = new Set([
  'cached',
  'cold',
  'unsupported',
  'miniplayer-expanded',
  'miniplayer-collapsed',
]);

const parsePort = (rawPort) => {
  if (rawPort === undefined || rawPort === '') return DEFAULT_PORT;
  const parsed = Number(rawPort);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid MOSU_PERF_PORT: "${rawPort}" (expected integer 0..65535).`);
  }
  return parsed;
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.osu': 'text/plain; charset=utf-8',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
};
const allowedRootFiles = new Set([
  'popup.css',
  `scripts${sep}performance.html`,
  `scripts${sep}performance.css`,
  `scripts${sep}performance-browser.js`,
  `scripts${sep}performance-charts.js`,
  `scripts${sep}performance-popup-shim.js`,
]);
const benchmarkMapRoot = `scripts${sep}benchmark-maps${sep}`;
const allowedFontsRoot = `assets${sep}fonts${sep}`;
const allowedFontExtensions = new Set(['.otf', '.ttf']);
const browserMetricKeys = [
  'fps',
  'frameCount',
  'elapsedMs',
  'intervalP50',
  'intervalP95',
  'intervalP99',
  'workP50',
  'workP95',
  'workP99',
  'droppedPercent',
];
const startupPhaseKeys = ['domCssMs', 'jsBootMs', 'revealMs', 'parseRenderMs', 'paintMs'];

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isValidBrowserResult = (result) => {
  if (!isPlainObject(result)) return false;
  if (!Number.isFinite(result.setupMs) || result.setupMs < 0) return false;
  if (typeof result.signature !== 'string' || result.signature.length > 2048) return false;
  if (!isPlainObject(result.device)) return false;
  if (!isPlainObject(result.benchmark)) return false;
  return ['visual', 'audio'].every((passName) => {
    const pass = result[passName];
    return isPlainObject(pass)
      && browserMetricKeys.every((key) => Number.isFinite(pass[key]) && pass[key] >= 0);
  });
};

const pickPassMetrics = (pass) => Object.fromEntries(
  browserMetricKeys.map((key) => [key, pass[key]]),
);

const sanitizePowerInfo = (power) => {
  if (!isPlainObject(power)) return undefined;
  const out = {
    efficiencyMode: Boolean(power.efficiencyMode),
    source: typeof power.source === 'string' ? power.source.slice(0, 32) : 'auto',
  };
  if (Number.isFinite(power.rafHz) && power.rafHz > 0 && power.rafHz <= 1000) {
    out.rafHz = Math.round(power.rafHz);
  }
  if (typeof power.onBattery === 'boolean') {
    out.onBattery = power.onBattery;
  }
  if (Number.isFinite(power.batteryLevel) && power.batteryLevel >= 0 && power.batteryLevel <= 1) {
    out.batteryLevel = Math.round(power.batteryLevel * 100) / 100;
  }
  if (typeof power.reducedMotion === 'boolean') {
    out.reducedMotion = power.reducedMotion;
  }
  return out;
};

const sanitizeDeviceInfo = (device) => {
  const sanitized = {
    userAgent: typeof device.userAgent === 'string' ? device.userAgent.slice(0, 512) : '',
    dpr: Number.isFinite(device.dpr) ? device.dpr : 1,
    screen: typeof device.screen === 'string' ? device.screen.slice(0, 64) : '',
  };
  const power = sanitizePowerInfo(device.power);
  if (power) sanitized.power = power;
  return sanitized;
};

const sanitizeBrowserResult = (result) => ({
  setupMs: result.setupMs,
  signature: result.signature.slice(0, 2048),
  device: sanitizeDeviceInfo(result.device),
  benchmark: {
    runMs: Number.isFinite(result.benchmark.runMs) ? result.benchmark.runMs : 0,
    objectCount: Number.isFinite(result.benchmark.objectCount) ? result.benchmark.objectCount : 0,
    scenario: typeof result.benchmark.scenario === 'string' ? result.benchmark.scenario.slice(0, 128) : '',
    description: typeof result.benchmark.description === 'string' ? result.benchmark.description.slice(0, 256) : '',
  },
  visual: pickPassMetrics(result.visual),
  audio: pickPassMetrics(result.audio),
});

const isValidStartupResult = (result) => {
  if (!isPlainObject(result)) return false;
  if (!VALID_STARTUP_MODES.has(result.mode)) return false;
  if (!Number.isInteger(result.iterations) || result.iterations < 1 || result.iterations > 50) return false;
  if (typeof result.signature !== 'string' || result.signature.length > 2048) return false;
  if (!isPlainObject(result.device)) return false;
  if (!isPlainObject(result.summary)) return false;
  if (!Number.isFinite(result.summary.totalMedianMs) || result.summary.totalMedianMs < 0) return false;
  if (!Number.isFinite(result.summary.totalP95Ms) || result.summary.totalP95Ms < 0) return false;
  if (!isPlainObject(result.summary.phases)) return false;
  return startupPhaseKeys.every((key) => Number.isFinite(result.summary.phases[key]) && result.summary.phases[key] >= 0);
};

const sanitizeStartupResult = (result) => ({
  mode: result.mode,
  mapId: typeof result.mapId === 'string' ? result.mapId.slice(0, 64) : '',
  iterations: result.iterations,
  signature: result.signature.slice(0, 2048),
  device: sanitizeDeviceInfo(result.device),
  summary: {
    totalMedianMs: result.summary.totalMedianMs,
    totalP95Ms: result.summary.totalP95Ms,
    totalMinMs: Number.isFinite(result.summary.totalMinMs) ? result.summary.totalMinMs : result.summary.totalMedianMs,
    phases: Object.fromEntries(startupPhaseKeys.map((key) => [key, result.summary.phases[key]])),
  },
});

const isAllowedHostHeader = (hostHeader, expectedPort, exposeOnNetwork) => {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return false;
  if (exposeOnNetwork) return true;
  const normalized = hostHeader.trim().toLowerCase();
  return normalized === `127.0.0.1:${expectedPort}`
    || normalized === `localhost:${expectedPort}`
    || normalized === `[::1]:${expectedPort}`;
};

const isAllowedNormalizedRelativePath = (platformPath) => (
  allowedRootFiles.has(platformPath)
  || (platformPath.startsWith(`src${sep}`) && extname(platformPath) === '.js')
  || (platformPath.startsWith(benchmarkMapRoot) && extname(platformPath) === '.osu')
  || (platformPath.startsWith(allowedFontsRoot) && allowedFontExtensions.has(extname(platformPath)))
);

const resolveAllowedFilePath = async (rawPathname, rootDir = projectRoot) => {
  const pathname = rawPathname === '/' ? '/scripts/performance.html' : rawPathname;
  if (pathname.includes('\0') || pathname.includes('\\')) {
    return null;
  }
  const segments = pathname.split('/');
  if (segments.some((segment) => segment === '..')) {
    return null;
  }
  const relativePath = pathname.replace(/^\/+/, '');
  const candidatePath = resolve(rootDir, relativePath);
  const rootPrefix = `${rootDir}${sep}`;
  if (!candidatePath.startsWith(rootPrefix)) {
    return null;
  }

  let realRoot;
  let realCandidate;
  try {
    realRoot = await realpath(rootDir);
    realCandidate = await realpath(candidatePath);
  } catch {
    return null;
  }
  if (!realCandidate.startsWith(`${realRoot}${sep}`)) {
    return null;
  }
  const normalizedRelative = relative(realRoot, realCandidate);
  if (!isAllowedNormalizedRelativePath(normalizedRelative)) {
    return null;
  }
  return realCandidate;
};

const getLanAddresses = () => {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && entry.family === 'IPv4' && !entry.internal && entry.address) {
        addresses.push(entry.address);
      }
    }
  }
  return [...new Set(addresses)];
};

const formatSavedBrowserSummary = (result) => {
  const scenario = result?.benchmark?.scenario || 'unknown';
  const v = result?.visual;
  const a = result?.audio;
  const power = result?.device?.power;
  const powerTag = power?.efficiencyMode
    ? ` [efficiency${Number.isFinite(power.rafHz) ? ` ~${power.rafHz}Hz` : ''}]`
    : '';
  const visualSummary = v
    ? `Visual ${v.fps.toFixed(1)} FPS (p95 ${v.intervalP95.toFixed(1)}ms, work ${v.workP95.toFixed(1)}ms)`
    : '';
  const audioSummary = a
    ? `Audio ${a.fps.toFixed(1)} FPS (p95 ${a.intervalP95.toFixed(1)}ms, work ${a.workP95.toFixed(1)}ms)`
    : '';
  return `[saved] ${scenario}${powerTag} · ${visualSummary} · ${audioSummary}`;
};

const readJsonBody = async (request, response, maxBytes) => {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    response.writeHead(413).end('Result is too large');
    return { ok: false };
  }

  const chunks = [];
  let byteLength = 0;
  let tooLarge = false;
  try {
    for await (const chunk of request) {
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        continue;
      }
      if (!tooLarge) chunks.push(chunk);
    }
  } catch {
    if (!response.headersSent) {
      response.writeHead(400).end('Request stream interrupted');
    } else {
      response.destroy();
    }
    return { ok: false };
  }
  if (tooLarge) {
    response.writeHead(413).end('Result is too large');
    return { ok: false };
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    response.writeHead(400).end('Invalid JSON');
    return { ok: false };
  }
};

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }).end(JSON.stringify(payload));
};

const createPerformanceServer = ({
  port = DEFAULT_PORT,
  exposeOnNetwork = false,
  rootDir = projectRoot,
  resultsFile = DEFAULT_RESULTS_PATH,
  onSaved = null,
} = {}) => {
  const verifyHost = (request, response) => {
    const activePort = server.address()?.port ?? port;
    if (!isAllowedHostHeader(request.headers.host, activePort, exposeOnNetwork)) {
      response.writeHead(403).end('Disallowed Host header');
      return false;
    }
    return true;
  };

  const verifySameOriginJsonPost = (request, response) => {
    if (!verifyHost(request, response)) return false;
    const origin = request.headers.origin;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).origin === `http://${request.headers.host}`;
    } catch {
      // A missing or malformed Origin is not same-origin.
    }
    if (!sameOrigin) {
      response.writeHead(403).end('Same-origin requests only');
      return false;
    }
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
      response.writeHead(415).end('Expected application/json');
      return false;
    }
    return true;
  };

  const handlePopupBenchHtml = async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    if (!verifyHost(request, response)) return;
    try {
      const popupHtmlPath = resolve(rootDir, 'popup.html');
      const rawHtml = await readFile(popupHtmlPath, 'utf8');
      const shimTag = '<script src="/scripts/performance-popup-shim.js"></script>';
      const instrumented = rawHtml.includes('<head>')
        ? rawHtml.replace('<head>', `<head>\n  ${shimTag}`)
        : `${shimTag}\n${rawHtml}`;
      const bytes = Buffer.from(instrumented, 'utf8');
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': bytes.byteLength,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self';",
      }).end(bytes);
    } catch {
      response.writeHead(500).end('Could not load popup harness');
    }
  };

  const handleGetMeta = async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    if (!verifyHost(request, response)) return;
    const activePort = server.address()?.port ?? port;
    const [build, environment] = [await readBuildInfo(), getEnvironmentInfo()];
    const lanUrls = exposeOnNetwork
      ? getLanAddresses().map((ip) => `http://${ip}:${activePort}/`)
      : [];
    sendJson(response, 200, {
      build,
      environment,
      resultsPath: formatRelativeResultsPath(resultsFile),
      exposeOnNetwork,
      lanUrls,
      port: activePort,
    });
  };

  const handleGetResults = async (request, response, searchParams) => {
    if (!verifyHost(request, response)) return;
    const rawKind = searchParams.get('kind');
    const kind = rawKind === 'browser' || rawKind === 'micro' || rawKind === 'startup' ? rawKind : null;
    const rawLimit = searchParams.get('limit');
    const parsedLimit = rawLimit ? Number(rawLimit) : null;
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 500)
      : null;

    try {
      const records = await readPerformanceResults({ kind, limit, resultsFile });
      const browser = kind && kind !== 'browser' ? [] : records.filter((entry) => entry.kind === 'browser');
      const startup = kind && kind !== 'startup' ? [] : records.filter((entry) => entry.kind === 'startup');
      const micro = kind && kind !== 'micro' ? [] : records.filter((entry) => entry.kind === 'micro');
      sendJson(response, 200, {
        resultsPath: formatRelativeResultsPath(resultsFile),
        total: records.length,
        browser,
        startup,
        micro,
      });
    } catch (error) {
      console.error(`Could not read benchmark results: ${error?.message || error}`);
      response.writeHead(500).end('Could not read results');
    }
  };

  const saveBrowserResult = async (request, response) => {
    if (!verifySameOriginJsonPost(request, response)) return;
    const body = await readJsonBody(request, response, MAX_RESULT_BYTES);
    if (!body.ok) return;

    const result = body.value;
    if (!isValidBrowserResult(result)) {
      response.writeHead(400).end('Invalid browser benchmark result');
      return;
    }

    const sanitized = sanitizeBrowserResult(result);
    try {
      const record = await buildPerformanceRecord('browser', sanitized);
      const resultsPath = await appendPerformanceResult('browser', sanitized, { resultsFile, record });
      if (typeof onSaved === 'function') {
        onSaved('browser', record, resultsPath);
      }
      sendJson(response, 201, { saved: true, resultsPath, record });
    } catch (error) {
      console.error(`Could not save browser benchmark results: ${error?.message || error}`);
      response.writeHead(500).end('Could not save result');
    }
  };

  const saveStartupResult = async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (!verifySameOriginJsonPost(request, response)) return;
    const body = await readJsonBody(request, response, MAX_RESULT_BYTES);
    if (!body.ok) return;

    const result = body.value;
    if (!isValidStartupResult(result)) {
      response.writeHead(400).end('Invalid startup benchmark result');
      return;
    }

    const sanitized = sanitizeStartupResult(result);
    try {
      const record = await buildPerformanceRecord('startup', sanitized);
      const resultsPath = await appendPerformanceResult('startup', sanitized, { resultsFile, record });
      if (typeof onSaved === 'function') {
        onSaved('startup', record, resultsPath);
      }
      sendJson(response, 201, { saved: true, resultsPath, record });
    } catch (error) {
      console.error(`Could not save startup benchmark results: ${error?.message || error}`);
      response.writeHead(500).end('Could not save startup result');
    }
  };

  const handleRunMicro = async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (!verifySameOriginJsonPost(request, response)) return;
    const body = await readJsonBody(request, response, MAX_MICRO_BODY_BYTES);
    if (!body.ok) return;

    const payload = isPlainObject(body.value) ? body.value : {};
    const save = payload.save !== false;
    const rawSamples = payload.sampleCount;
    const sampleCount = Number.isInteger(rawSamples) && rawSamples >= 1 && rawSamples <= 50
      ? rawSamples
      : 9;

    try {
      const result = await runMicroBenchmarks({ sampleCount });
      const record = await buildPerformanceRecord('micro', result);
      let resultsPath = formatRelativeResultsPath(resultsFile);
      if (save) {
        resultsPath = await appendPerformanceResult('micro', result, { resultsFile, record });
        if (typeof onSaved === 'function') {
          onSaved('micro', record, resultsPath);
        }
      }
      sendJson(response, save ? 201 : 200, { saved: save, resultsPath, record });
    } catch (error) {
      console.error(`Microbenchmark failed: ${error?.message || error}`);
      response.writeHead(500).end('Microbenchmark execution failed');
    }
  };

  const server = createServer((request, response) => {
    void (async () => {
      let url;
      let pathname;
      try {
        url = new URL(request.url || '/', 'http://localhost');
        pathname = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400).end('Bad request');
        return;
      }

      if (pathname === '/popup-bench.html') {
        await handlePopupBenchHtml(request, response);
        return;
      }
      if (pathname === '/api/meta') {
        await handleGetMeta(request, response);
        return;
      }
      if (pathname === '/api/results') {
        if (request.method === 'GET') {
          await handleGetResults(request, response, url.searchParams);
          return;
        }
        if (request.method === 'POST') {
          await saveBrowserResult(request, response);
          return;
        }
        response.writeHead(405, { Allow: 'GET, POST' }).end();
        return;
      }
      if (pathname === '/api/startup') {
        await saveStartupResult(request, response);
        return;
      }
      if (pathname === '/api/micro') {
        await handleRunMicro(request, response);
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }

      const absolutePath = await resolveAllowedFilePath(pathname, rootDir);
      if (!absolutePath) {
        response.writeHead(404).end('Not found');
        return;
      }

      try {
        const fileInfo = await stat(absolutePath);
        if (!fileInfo.isFile()) throw new Error('Not a file');
        response.writeHead(200, {
          'Content-Type': contentTypes[extname(absolutePath)] || 'application/octet-stream',
          'Content-Length': fileInfo.size,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        if (request.method === 'HEAD') {
          response.end();
          return;
        }
        const stream = createReadStream(absolutePath);
        stream.on('error', () => {
          if (!response.headersSent) {
            response.writeHead(500).end('Read error');
          } else {
            response.destroy();
          }
        });
        stream.pipe(response);
      } catch {
        if (!response.headersSent) {
          response.writeHead(404).end('Not found');
        }
      }
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end('Internal server error');
      } else {
        response.destroy();
      }
    });
  });

  return server;
};

const parseServerArgs = (argv = [], env = process.env) => {
  const hasEnvPort = env.MOSU_PERF_PORT !== undefined && env.MOSU_PERF_PORT !== '';
  const options = {
    port: parsePort(env.MOSU_PERF_PORT),
    explicitPort: hasEnvPort,
    exposeOnNetwork: env.MOSU_PERF_LAN === '1',
    openBrowser: env.MOSU_PERF_NO_OPEN !== '1' && !env.CI,
    scenario: null,
    durationSec: null,
    autobench: null,
    tab: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--lan') {
      options.exposeOnNetwork = true;
    } else if (arg === '--no-open') {
      options.openBrowser = false;
    } else if (arg === '--open') {
      options.openBrowser = true;
    } else if (arg === '--startup') {
      options.tab = 'startup';
    } else if (arg === '--history') {
      options.tab = 'history';
    } else if (arg === '--micro') {
      options.tab = 'micro';
    } else if (arg === '--port' || arg === '-p' || arg.startsWith('--port=')) {
      const raw = arg.includes('=') ? arg.slice('--port='.length) : argv[++index];
      options.port = parsePort(raw);
      options.explicitPort = true;
    } else if (arg === '--scenario' || arg === '-s' || arg.startsWith('--scenario=')) {
      const raw = arg.includes('=') ? arg.slice('--scenario='.length) : argv[++index];
      if (!VALID_SCENARIOS.has(raw)) {
        throw new Error(`Invalid --scenario "${raw}". Choose one of: ${[...VALID_SCENARIOS].join(', ')}.`);
      }
      options.scenario = raw;
    } else if (arg === '--duration' || arg === '-d' || arg.startsWith('--duration=')) {
      const raw = arg.includes('=') ? arg.slice('--duration='.length) : argv[++index];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60) {
        throw new Error(`Invalid --duration "${raw}" (expected seconds between 1 and 60).`);
      }
      options.durationSec = Math.round(parsed);
    } else if (arg === '--auto' || arg === '--autobench' || arg.startsWith('--auto=') || arg.startsWith('--autobench=')) {
      const raw = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : (options.scenario || 'aspire-conic');
      if (!VALID_SCENARIOS.has(raw)) {
        throw new Error(`Invalid --auto scenario "${raw}". Choose one of: ${[...VALID_SCENARIOS].join(', ')}.`);
      }
      options.autobench = raw;
    } else if (arg === '--tab' || arg.startsWith('--tab=')) {
      const raw = arg.includes('=') ? arg.slice('--tab='.length) : argv[++index];
      if (!VALID_TABS.has(raw)) {
        throw new Error(`Invalid --tab "${raw}". Choose one of: ${[...VALID_TABS].join(', ')}.`);
      }
      options.tab = raw;
    } else {
      throw new Error(`Unknown option: "${arg}". Run with --help to see available options.`);
    }
  }

  return options;
};

const buildLaunchUrl = (activePort, options = {}) => {
  const url = new URL(`http://127.0.0.1:${activePort}/`);
  if (options.autobench) {
    url.searchParams.set('autobench', options.autobench);
  } else if (options.scenario) {
    url.searchParams.set('scenario', options.scenario);
  }
  if (Number.isFinite(options.durationSec)) {
    url.searchParams.set('duration', String(options.durationSec));
  }
  if (options.tab && options.tab !== 'browser') {
    url.searchParams.set('tab', options.tab);
  }
  return url.toString();
};

const openInBrowser = (url) => {
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return false;
  try {
    let command;
    let args;
    if (process.platform === 'win32') {
      command = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      command = 'open';
      args = [url];
    } else {
      command = 'xdg-open';
      args = [url];
    }
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {
      // Headless environment or missing browser opener: URL is already printed.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
};

const listenWithFallback = (server, { port, host, allowFallback }) => new Promise((resolveListen, rejectListen) => {
  const maxAttempts = allowFallback ? 10 : 1;
  let attempt = 0;

  const tryListen = (candidatePort) => {
    const onError = (error) => {
      server.off('listening', onListening);
      if (allowFallback && error?.code === 'EADDRINUSE' && attempt < maxAttempts) {
        attempt += 1;
        const nextPort = attempt === maxAttempts ? 0 : port + attempt;
        tryListen(nextPort);
        return;
      }
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen(server.address()?.port ?? candidatePort);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(candidatePort, host);
  };

  tryListen(port);
});

const SERVER_HELP_TEXT = `Usage: npm run performance -- [options]

Options:
  -p, --port <n>       Port to bind (default: 4173, or MOSU_PERF_PORT)
  --lan                Listen on 0.0.0.0 for testing from phones/other devices
  --no-open            Do not automatically open the browser
  -s, --scenario <id>  Pre-select render scenario (anchor-heavy-slider | aspire-conic | object-stress | mania-7k | catch-fruits | compare-4up | miniplayer-collapsed | miniplayer-toggle | all)
  -d, --duration <sec> Pre-set pass duration in seconds (1..60, default: 8)
  --auto[=<scenario>]  Auto-run visual benchmark on page load (default: aspire-conic or --scenario)
  --startup            Open directly to the Open & Load (popup startup) tab
  --history            Open directly to the History tab
  --micro              Open directly to the Microbenchmarks tab
  -h, --help           Show this help message
`;

const isEntrypoint = Boolean(process.argv[1])
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  let options;
  try {
    options = parseServerArgs(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error?.message || error);
    process.exit(1);
  }

  if (options.help) {
    console.log(SERVER_HELP_TEXT);
  } else {
    const host = options.exposeOnNetwork ? '0.0.0.0' : '127.0.0.1';
    const server = createPerformanceServer({
      port: options.port,
      exposeOnNetwork: options.exposeOnNetwork,
      onSaved: (kind, record) => {
        if (kind === 'browser') {
          console.log(formatSavedBrowserSummary(record));
        } else if (kind === 'startup') {
          console.log(`[saved] startup (${record.mode}) · median ${record.summary.totalMedianMs.toFixed(1)}ms (p95 ${record.summary.totalP95Ms.toFixed(1)}ms)`);
        } else if (kind === 'micro') {
          const badge = record.passed ? 'PASS' : 'FAIL';
          console.log(`[saved] micro (${badge}) · overall ${record.overallSpeedup.toFixed(2)}×`);
        }
      },
    });

    try {
      const activePort = await listenWithFallback(server, {
        port: options.port,
        host,
        allowFallback: !options.explicitPort,
      });
      const launchUrl = buildLaunchUrl(activePort, options);
      console.log('');
      console.log('mosu! preview · Benchmark Dashboard');
      console.log(`  Local:   ${launchUrl}`);
      if (options.port !== activePort && !options.explicitPort) {
        console.log(`  Note:    Port ${options.port} was busy, switched to ${activePort}.`);
      }
      if (options.exposeOnNetwork) {
        const lanIps = getLanAddresses();
        if (lanIps.length > 0) {
          for (const ip of lanIps) {
            console.log(`  Network: http://${ip}:${activePort}/`);
          }
        } else {
          console.log(`  Network: listening on 0.0.0.0:${activePort}`);
        }
      }
      if (options.openBrowser) {
        openInBrowser(launchUrl);
        console.log('  Browser: opened automatically (pass --no-open to disable)');
      }
      console.log('  Press Ctrl+C to stop.');
      console.log('');

      const shutdown = () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500).unref();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    } catch (error) {
      console.error(`Could not start benchmark server: ${error?.message || error}`);
      process.exit(1);
    }
  }
}

export {
  buildLaunchUrl,
  createPerformanceServer,
  formatSavedBrowserSummary,
  getLanAddresses,
  isAllowedHostHeader,
  isValidBrowserResult,
  isValidStartupResult,
  parsePort,
  parseServerArgs,
  resolveAllowedFilePath,
  sanitizeBrowserResult,
  sanitizeStartupResult,
};
