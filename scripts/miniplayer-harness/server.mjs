// Dev-only harness for the in-page miniplayer (see HARNESS_GUIDE.md). Serves
// this repo over http://127.0.0.1, runs the real src/content.js on a stand-in
// osu! page (host.html), injects stand-in extension APIs into popup.html
// (iframe-shim.js), and proxies the few osu! hosts the miniplayer reads so the
// page runs outside an extension. Never packaged: scripts/ is not in the build.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HARNESS, '..', '..');
const PORT = Number(process.env.MOSU_HARNESS_PORT || 4321);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const PROXY_HOSTS = new Set(['osu.ppy.sh', 'b.ppy.sh', 'assets.ppy.sh', 'catboy.best', 'osu.direct']);

const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

const serveFile = async (res, root, relativePath, transform) => {
  const target = normalize(join(root, relativePath));
  if (!target.startsWith(root + sep) && target !== root) {
    send(res, 403, 'forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      send(res, 404, 'not found');
      return;
    }
    let body = await readFile(target);
    if (transform) {
      body = transform(body.toString('utf8'));
    }
    send(res, 200, body, TYPES[extname(target)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found');
  }
};

const proxy = async (res, rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    send(res, 400, 'bad url');
    return;
  }
  if (url.protocol !== 'https:' || !PROXY_HOSTS.has(url.hostname)) {
    send(res, 403, 'host not proxied');
    return;
  }
  try {
    const upstream = await fetch(url, { headers: { 'user-agent': 'mosu-preview-dev-harness' } });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'max-age=3600',
    });
    res.end(body);
  } catch (error) {
    send(res, 502, String(error?.message || error));
  }
};

const injectShim = (html) => html.replace(
  /<script\b/i,
  '<script src="/__harness/iframe-shim.js"></script>\n  <script',
);

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/__proxy') {
    await proxy(res, url.searchParams.get('url') || '');
    return;
  }
  if (url.pathname.startsWith('/__harness/')) {
    await serveFile(res, HARNESS, url.pathname.slice('/__harness/'.length));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/host') {
    await serveFile(res, HARNESS, 'host.html');
    return;
  }
  if (url.pathname === '/popup.html') {
    await serveFile(res, REPO, 'popup.html', injectShim);
    return;
  }
  await serveFile(res, REPO, decodeURIComponent(url.pathname.slice(1)));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`harness on http://127.0.0.1:${PORT}/ serving ${REPO}`);
});
