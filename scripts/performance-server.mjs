import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendPerformanceResult } from './performance-results.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const parsePort = (rawPort) => {
  if (rawPort === undefined || rawPort === '') return 4173;
  const parsed = Number(rawPort);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid MOSU_PERF_PORT: "${rawPort}" (expected integer 0..65535).`);
  }
  return parsed;
};
const MAX_RESULT_BYTES = 64 * 1024;
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.osu': 'text/plain; charset=utf-8',
};
const allowedRootFiles = new Set([
  `scripts${sep}performance.html`,
  `scripts${sep}performance-browser.js`,
]);
const benchmarkMapRoot = `scripts${sep}benchmark-maps${sep}`;
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

const sanitizeBrowserResult = (result) => ({
  setupMs: result.setupMs,
  signature: result.signature.slice(0, 2048),
  device: {
    userAgent: typeof result.device.userAgent === 'string' ? result.device.userAgent.slice(0, 512) : '',
    dpr: Number.isFinite(result.device.dpr) ? result.device.dpr : 1,
    screen: typeof result.device.screen === 'string' ? result.device.screen.slice(0, 64) : '',
  },
  benchmark: {
    runMs: Number.isFinite(result.benchmark.runMs) ? result.benchmark.runMs : 0,
    objectCount: Number.isFinite(result.benchmark.objectCount) ? result.benchmark.objectCount : 0,
    scenario: typeof result.benchmark.scenario === 'string' ? result.benchmark.scenario.slice(0, 128) : '',
    description: typeof result.benchmark.description === 'string' ? result.benchmark.description.slice(0, 256) : '',
  },
  visual: pickPassMetrics(result.visual),
  audio: pickPassMetrics(result.audio),
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

const createPerformanceServer = ({ port = 4173, exposeOnNetwork = false, rootDir = projectRoot } = {}) => {
  const saveBrowserResult = async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const activePort = server.address()?.port ?? port;
    if (!isAllowedHostHeader(request.headers.host, activePort, exposeOnNetwork)) {
      response.writeHead(403).end('Disallowed Host header');
      return;
    }
    const origin = request.headers.origin;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).origin === `http://${request.headers.host}`;
    } catch {
      // A missing or malformed Origin is not same-origin.
    }
    if (!sameOrigin) {
      response.writeHead(403).end('Same-origin requests only');
      return;
    }
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
      response.writeHead(415).end('Expected application/json');
      return;
    }
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESULT_BYTES) {
      request.resume();
      response.writeHead(413).end('Result is too large');
      return;
    }

    const chunks = [];
    let byteLength = 0;
    let tooLarge = false;
    try {
      for await (const chunk of request) {
        byteLength += chunk.length;
        if (byteLength > MAX_RESULT_BYTES) {
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
      return;
    }
    if (tooLarge) {
      response.writeHead(413).end('Result is too large');
      return;
    }

    let result;
    try {
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      response.writeHead(400).end('Invalid JSON');
      return;
    }
    if (!isValidBrowserResult(result)) {
      response.writeHead(400).end('Invalid browser benchmark result');
      return;
    }

    try {
      const resultsPath = await appendPerformanceResult('browser', sanitizeBrowserResult(result));
      response.writeHead(201, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      })
        .end(JSON.stringify({ saved: true, resultsPath }));
    } catch (error) {
      console.error(`Could not save browser benchmark results: ${error?.message || error}`);
      response.writeHead(500).end('Could not save result');
    }
  };

  const server = createServer((request, response) => {
    void (async () => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
      } catch {
        response.writeHead(400).end('Bad request');
        return;
      }
      if (pathname === '/api/results') {
        await saveBrowserResult(request, response);
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

const isEntrypoint = Boolean(process.argv[1])
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const port = parsePort(process.env.MOSU_PERF_PORT);
  // Loopback unless asked otherwise. The same-origin check on the save endpoint
  // trusts the Host header on LAN mode, so listening on every interface is opt-in.
  const exposeOnNetwork = process.env.MOSU_PERF_LAN === '1';
  const host = exposeOnNetwork ? '0.0.0.0' : '127.0.0.1';
  const server = createPerformanceServer({ port, exposeOnNetwork });
  server.listen(port, host, () => {
    const activePort = server.address()?.port ?? port;
    console.log(`mosu! preview performance test: http://127.0.0.1:${activePort}/`);
    if (exposeOnNetwork) {
      console.log(`Listening on all network interfaces (port ${activePort}) because MOSU_PERF_LAN=1.`);
    }
  });
}

export {
  createPerformanceServer,
  isAllowedHostHeader,
  isValidBrowserResult,
  parsePort,
  resolveAllowedFilePath,
  sanitizeBrowserResult,
};
