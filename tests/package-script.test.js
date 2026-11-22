import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createZip,
  dosDateTime,
  normalizeLocalReference,
  resolveBuildDate,
  stripJsComments,
  targets,
  validateJsImports,
} from '../scripts/package.mjs';

test('dosDateTime uses UTC getters and clamps years to [1980, 2107]', () => {
  const fixed = new Date('2024-01-02T03:04:06Z');
  const expectedDate = ((2024 - 1980) << 9) | (1 << 5) | 2;
  const expectedTime = (3 << 11) | (4 << 5) | 3;
  assert.deepEqual(dosDateTime(fixed), { time: expectedTime, date: expectedDate });

  const tooOld = dosDateTime(new Date('1970-01-01T00:00:00Z'));
  assert.equal((tooOld.date >> 9) + 1980, 1980);

  const tooNew = dosDateTime(new Date('2200-12-31T23:59:58Z'));
  assert.equal((tooNew.date >> 9) + 1980, 2107);
});

test('resolveBuildDate rejects invalid SOURCE_DATE_EPOCH values', () => {
  const prev = process.env.SOURCE_DATE_EPOCH;
  try {
    process.env.SOURCE_DATE_EPOCH = '1700000000';
    assert.equal(resolveBuildDate().getTime(), 1700000000 * 1000);

    process.env.SOURCE_DATE_EPOCH = 'not-a-number';
    assert.throws(() => resolveBuildDate(), /Invalid SOURCE_DATE_EPOCH/);

    process.env.SOURCE_DATE_EPOCH = '-5';
    assert.throws(() => resolveBuildDate(), /Invalid SOURCE_DATE_EPOCH/);
  } finally {
    if (prev === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = prev;
  }
});

test('createZip produces byte-identical DEFLATE archives with UTF-8 flag and valid CRC', () => {
  const payload = Buffer.from('hello world '.repeat(200), 'utf8');
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{"name":"test"}', 'utf8') },
    { name: 'src/café.js', data: payload },
  ];
  const date = new Date(1700000000 * 1000);
  const zipA = createZip(entries, date);
  const zipB = createZip(entries, date);

  assert.deepEqual(zipA, zipB, 'reproducible build must be byte-identical');
  // Compressible payload must shrink substantially below raw size.
  assert.ok(zipA.length < payload.length, `expected compressed zip < ${payload.length}, got ${zipA.length}`);
  // Local header bit 11 (0x0800) UTF-8 flag is set on first entry.
  assert.equal(zipA.readUInt16LE(6) & 0x0800, 0x0800);
});

test('normalizeLocalReference rejects escaping ../ paths and node:* imports', () => {
  assert.equal(normalizeLocalReference('src/popup.js', './core/state.js'), 'src/core/state.js');
  assert.match(normalizeLocalReference('src/popup.js', '../../outside.js')?.error || '', /escapes package root/i);
  assert.match(normalizeLocalReference('src/popup.js', 'node:fs')?.error || '', /Node built-in/i);
});

test('stripJsComments ignores commented-out imports and validateJsImports catches missing imports', async () => {
  const source = [
    '// read from \'nonexistent.js\'',
    '/* import { fake } from "./missing.js" */',
    'import {a}from\'./present.js\';',
  ].join('\n');
  const stripped = stripJsComments(source);
  assert.ok(!stripped.includes('nonexistent.js'));
  assert.ok(!stripped.includes('missing.js'));
  assert.ok(stripped.includes('./present.js'));

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mosu-pkg-test-'));
  try {
    const missingErrors = [];
    validateJsImports(new Map([
      ['src/a.js', Buffer.from('import {x}from"./missing.js";', 'utf8')],
    ]), missingErrors);
    assert.ok(missingErrors.some((msg) => /missing\.js/.test(msg)));

    const cleanErrors = [];
    validateJsImports(new Map([
      ['src/b.js', Buffer.from('// import from "./ghost.js"\nexport const ok = 1;\n', 'utf8')],
    ]), cleanErrors);
    assert.deepEqual(cleanErrors, []);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('target manifest transforms keep osu-scoped web_accessible_resources and strip Firefox-unsupported keys', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

  const chromeManifest = targets.chrome.manifest(manifest);
  assert.deepEqual(chromeManifest.web_accessible_resources?.[0]?.matches, ['https://osu.ppy.sh/*']);
  assert.deepEqual(chromeManifest.content_scripts?.[0]?.js, ['src/content.js']);
  assert.ok(chromeManifest.permissions.includes('scripting'));

  // Even if use_dynamic_url is ever re-added, the Firefox transform strips it.
  const withDynamicUrl = structuredClone(manifest);
  withDynamicUrl.web_accessible_resources[0].use_dynamic_url = true;
  const firefoxManifest = targets.firefox.manifest(withDynamicUrl);
  assert.equal(Object.hasOwn(firefoxManifest.web_accessible_resources?.[0] || {}, 'use_dynamic_url'), false);
  assert.deepEqual(firefoxManifest.web_accessible_resources?.[0]?.matches, ['https://osu.ppy.sh/*']);
  assert.deepEqual(firefoxManifest.content_scripts?.[0]?.js, ['src/content.js']);
});
