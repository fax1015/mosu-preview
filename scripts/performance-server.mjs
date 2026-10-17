import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendPerformanceResult } from './performance-results.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.MOSU_PERF_PORT) || 4173;
const allowedRootFiles = new Set([
  `scripts${sep}performance.html`,
  `scripts${sep}performance-browser.js`,
]);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const MAX_RESULT_BYTES = 64 * 1024;
const browserMetricKeys = [
  'fps', 'frameCount', 'elapsedMs', 'intervalP50', 'intervalP95', 'intervalP99',
  'workP50', 'workP95', 'workP99', 'droppedPercent',
];

const isValidBrowserResult = (result) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (!Number.isFinite(result.setupMs) || result.setupMs < 0) return false;
  if (typeof result.signature !== 'string' || result.signature.length > 2048) return false;
  if (!result.device || typeof result.device !== 'object' || Array.isArray(result.device)) return false;
  if (!result.benchmark || typeof result.benchmark !== 'object') return false;
  return ['visual', 'audio'].every((passName) => {
    const pass = result[passName];
    return pass && typeof pass === 'object' && !Array.isArray(pass)
      && browserMetricKeys.every((key) => Number.isFinite(pass[key]) && pass[key] >= 0);
  });
};

const saveBrowserResult = async (request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' }).end();
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
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > MAX_RESULT_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(chunk);
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
    const resultsPath = await appendPerformanceResult('browser', result);
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

const isAllowedPath = (relativePath) => {
  const platformPath = relativePath.split('/').join(sep);
  return (
    allowedRootFiles.has(platformPath)
    || (platformPath.startsWith(`src${sep}`) && extname(platformPath) === '.js')
  );
};

const server = createServer(async (request, response) => {
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

  if (pathname === '/') pathname = '/scripts/performance.html';
  const relativePath = pathname.replace(/^\/+/, '');
  const absolutePath = resolve(projectRoot, relativePath);
  if (
    !isAllowedPath(relativePath)
    || !(absolutePath === projectRoot || absolutePath.startsWith(`${projectRoot}${sep}`))
  ) {
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
    createReadStream(absolutePath).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

// Loopback unless asked otherwise. The same-origin check on the save endpoint
// trusts the Host header, which any client on the network can set, so listening
// on every interface let anyone on the same Wi-Fi append to the results file.
const exposeOnNetwork = process.env.MOSU_PERF_LAN === '1';
const host = exposeOnNetwork ? '0.0.0.0' : '127.0.0.1';

server.listen(port, host, () => {
  console.log(`Performance page: http://localhost:${port}/`);
  if (exposeOnNetwork) {
    const addresses = Object.values(networkInterfaces()).flatMap((entries) => entries || [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => entry.address);
    for (const address of new Set(addresses)) {
      console.log(`On the same Wi-Fi: http://${address}:${port}/`);
    }
  } else {
    console.log('Only this machine can reach it. Set MOSU_PERF_LAN=1 to test from another device on the network.');
  }
  console.log('Stop with Ctrl+C. This server exposes the benchmark page, JavaScript modules under src/, and a validated result-save endpoint.');
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
