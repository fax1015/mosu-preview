import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const isAllowedPath = (relativePath) => {
  const platformPath = relativePath.split('/').join(sep);
  return (
    allowedRootFiles.has(platformPath)
    || (platformPath.startsWith(`src${sep}`) && extname(platformPath) === '.js')
  );
};

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
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

server.listen(port, '0.0.0.0', () => {
  console.log(`Performance page: http://localhost:${port}/`);
  const addresses = Object.values(networkInterfaces()).flatMap((entries) => entries || [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
  for (const address of new Set(addresses)) {
    console.log(`On the same Wi-Fi: http://${address}:${port}/`);
  }
  console.log('Stop with Ctrl+C. This server only exposes the benchmark page and JavaScript modules under src/.');
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
