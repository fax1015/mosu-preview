import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedHostHeader,
  isValidBrowserResult,
  parsePort,
  resolveAllowedFilePath,
  sanitizeBrowserResult,
} from '../scripts/performance-server.mjs';

test('resolveAllowedFilePath blocks path traversal bypasses like /src/..%2feslint.config.js (H24)', async () => {
  assert.equal(await resolveAllowedFilePath('/src/..%2feslint.config.js'), null);
  assert.equal(await resolveAllowedFilePath('/src/../package.json'), null);
  assert.equal(await resolveAllowedFilePath('/src/..\\eslint.config.js'), null);
  assert.equal(await resolveAllowedFilePath('/src/popup.js\0.js'), null);
  assert.equal(await resolveAllowedFilePath('/tests/parser.test.js'), null);

  const validJs = await resolveAllowedFilePath('/src/parser.js');
  assert.ok(validJs && validJs.endsWith('parser.js'));

  const rootPage = await resolveAllowedFilePath('/');
  assert.ok(rootPage && rootPage.endsWith('performance.html'));
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
  const pass = {
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
  assert.equal(isValidBrowserResult({ setupMs: 1, signature: 's', device: {}, benchmark: [], visual: pass, audio: pass }), false);
  assert.equal(isValidBrowserResult(null), false);

  const valid = {
    setupMs: 12,
    signature: 'sig-1',
    device: { userAgent: 'Chrome', dpr: 2, screen: '1920x1080', extra: 'drop' },
    benchmark: { runMs: 2000, objectCount: 500, scenario: 'std', description: 'desc', injected: 'bad' },
    visual: { ...pass, rogue: 1 },
    audio: pass,
    unexpectedTopLevel: 'drop',
  };
  assert.equal(isValidBrowserResult(valid), true);

  const sanitized = sanitizeBrowserResult(valid);
  assert.equal('unexpectedTopLevel' in sanitized, false);
  assert.equal('injected' in sanitized.benchmark, false);
  assert.equal('extra' in sanitized.device, false);
  assert.equal('rogue' in sanitized.visual, false);
  assert.equal(sanitized.benchmark.scenario, 'std');
});

test('parsePort validates port range', () => {
  assert.equal(parsePort(undefined), 4173);
  assert.equal(parsePort('8080'), 8080);
  assert.throws(() => parsePort('abc'), /Invalid MOSU_PERF_PORT/);
  assert.throws(() => parsePort('70000'), /Invalid MOSU_PERF_PORT/);
});
