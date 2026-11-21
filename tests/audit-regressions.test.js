import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMapPreviewData, MAX_OBJECT_TIME_MS } from '../src/parser.js';
import { buildSliderCurvePoints } from '../src/core/sliderPath.js';
import { convertMapForMode } from '../src/core/beatmapConversion.js';
import { PreviewRenderer } from '../src/renderer.js';
import { applyPreviewStacking, getStandardPlayfieldLayout } from '../src/renderers/standard.js';
import { buildCatchAutoplayFrames, getCatchObjectScale } from '../src/renderers/catch.js';
import { generateManiaBarLines, buildManiaKeyPresses, getLaneLight } from '../src/renderers/mania.js';
import { drawSelectionRings } from '../src/renderers/shared.js';
import { TimelineRenderer } from '../src/timeline.js';
import { buildMp3FrameIndex } from '../src/audio/mp3Index.js';
import { buildOggVorbisIndex, readModeBlockFlags } from '../src/audio/oggIndex.js';
import {
  MAX_ZIP_AUDIO_ENTRY_BYTES,
  extractZipEntry,
  parseZipEntries,
  pickAudioEntryFromZip,
} from '../src/audio/zip.js';
import {
  compactFullAudioAliasesForCacheKeys,
  normalizePath,
  readCachedFullAudioBlob,
  writeCachedFullAudioBlob,
} from '../src/audio/cache.js';
import { createMessageListener, getExtractionRequestKey, handleExtractFullAudio } from '../src/background.js';
import { buildNextHistory } from '../src/core/history.js';
import {
  DEFAULT_HITSOUND_VOLUME,
  DEFAULT_MANIA_SCROLL_SPEED,
  computeProviderScore,
  normalizeHitsoundVolume,
  normalizeManiaScrollSpeed,
  normalizeProviderPriority,
} from '../src/settings.js';
import { formatKeyLabel, normalizeKeybindings, resetKeybinding } from '../src/core/keybindings.js';
import { createHitsoundPlayer } from '../src/audio/hitsounds.js';

// --- C1: Taiko drumroll / drawSelectionRings negative corner -----------------
test('C1: drawSelectionRings never throws RangeError on zero/negative width or height targets', () => {
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    arc() {},
    rect() {},
    roundRect(_x, _y, _w, _h, r) {
      if (r < 0) throw new RangeError('negative radius');
    },
    stroke() {},
  };
  const targets = [
    { index: 0, x: -200, y: 100, width: -15, height: 20, corner: 10 },
    { index: 1, x: 50, y: 100, width: 0, height: 20, corner: 10 },
    { index: 2, x: 50, y: 100, width: 40, height: 20, corner: -5 },
  ];
  assert.doesNotThrow(() => drawSelectionRings(ctx, targets, new Set([0, 1, 2])));
});

// --- H1 & H2: HitsoundPlayer suspended AudioContext & attachMediaElement -----
test('H1/H2: HitsoundPlayer advances cursor without scheduling voices when suspended and resumes on attachMediaElement', () => {
  const prevAudioContext = globalThis.AudioContext;
  let resumeCalls = 0;
  let oscCreated = 0;
  const fakeGain = () => ({
    gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} },
    connect() { return this; },
    disconnect() {},
  });
  globalThis.AudioContext = class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 0;
      this.sampleRate = 44100;
      this.destination = {};
      this.baseLatency = 0;
      this.outputLatency = 0;
    }

    resume() {
      resumeCalls += 1;
      return Promise.resolve();
    }

    createGain() { return fakeGain(); }

    createDynamicsCompressor() {
      return {
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 1 },
        attack: { value: 0 },
        release: { value: 0 },
        connect() { return this; },
      };
    }

    createMediaElementSource() { return { connect() {} }; }

    createWaveShaper() { return { curve: null, oversample: 'none', connect() { return this; } }; }

    createConvolver() { return { buffer: null, connect() { return this; } }; }

    createBiquadFilter() {
      return {
        type: 'highpass',
        frequency: { value: 1000, setValueAtTime() {} },
        Q: { value: 1 },
        connect() { return this; },
      };
    }

    createBuffer(channels, length) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { getChannelData: (ch) => data[ch] };
    }

    createOscillator() {
      oscCreated += 1;
      return {
        type: 'sine',
        frequency: { value: 440, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() { return this; },
        start() {},
        stop() {},
      };
    }
  };

  try {
    const player = createHitsoundPlayer();
    player.setEnabled(true);
    const events = [
      { time: 100, hitSound: 1, sampleSet: 'normal', additionSet: 'normal', volume: 100 },
      { time: 200, hitSound: 1, sampleSet: 'normal', additionSet: 'normal', volume: 100 },
    ];
    player.attachMediaElement({});
    assert.ok(resumeCalls >= 1, 'attachMediaElement should request resume() on suspended context');

    const scheduled = player.update({
      events,
      currentTimeMs: 250,
      isPlaying: true,
      playbackSpeed: 1,
    });
    assert.equal(scheduled, 0, 'suspended AudioContext must not schedule burst of voices');
    assert.equal(oscCreated, 0);
  } finally {
    if (prevAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = prevAudioContext;
  }
});

// --- H5: mp3Index bounded resync & invalid duration --------------------------
test('H5: buildMp3FrameIndex scans trailing garbage within bounded window without hanging', async () => {
  // Build 4 valid MPEG-1 Layer III 128kbps 44100Hz frames (417 bytes each) followed by 256KB of 0xFF garbage.
  const frameLen = 417;
  const header = [0xff, 0xfb, 0x90, 0x00];
  const validBytes = new Uint8Array(frameLen * 4);
  for (let i = 0; i < 4; i += 1) {
    validBytes.set(header, i * frameLen);
  }
  const garbage = new Uint8Array(256 * 1024).fill(0xff);
  const combined = new Uint8Array(validBytes.length + garbage.length);
  combined.set(validBytes, 0);
  combined.set(garbage, validBytes.length);

  const started = performance.now();
  const index = await buildMp3FrameIndex(new Blob([combined], { type: 'audio/mpeg' }), { chunkBytes: 4096 });
  const elapsed = performance.now() - started;

  assert.ok(index, 'valid frames before trailing garbage are still indexed');
  assert.equal(index.count, 4);
  assert.ok(index.durationMs > 0);
  assert.ok(elapsed < 500, `bounded resync should be fast, took ${elapsed.toFixed(1)}ms`);
});

// --- H6: background.js provider-keyed dedupe & cross-context isolation -------
test('H6: background extraction keys include provider config and separate contexts do not abort each other', async () => {
  const keyA = getExtractionRequestKey({ setId: ' 456 ', audioFilename: 'Audio\\Song.MP3', providerOverride: 'mino' });
  const keyB = getExtractionRequestKey({ setId: '456', audioFilename: 'audio/song.mp3', providerOverride: 'mino' });
  const keyC = getExtractionRequestKey({ setId: '456', audioFilename: 'audio/song.mp3', providerOverride: 'nerinyan' });
  assert.equal(keyA, keyB);
  assert.notEqual(keyA, keyC);

  let abortedFirst = false;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const extract = async ({ setId, signal }) => {
    if (setId === '101') {
      signal.addEventListener('abort', () => { abortedFirst = true; });
      await firstGate;
      return { ok: true, setId: '101' };
    }
    return { ok: true, setId: '202' };
  };

  const first = handleExtractFullAudio({ setId: '101', audioFilename: 'a.mp3', jobId: 1 }, extract, { contextKey: 'doc:popup' });
  const second = await handleExtractFullAudio({ setId: '202', audioFilename: 'b.mp3', jobId: 2 }, extract, { contextKey: 'doc:detached' });
  assert.equal(abortedFirst, false, 'detached window must not abort toolbar popup extraction');
  assert.equal(second.setId, '202');
  releaseFirst();
  assert.equal((await first).setId, '101');

  // Closed sendResponse throwing must not reject unhandled.
  const listener = createMessageListener(async () => ({ ok: true }));
  assert.equal(listener({ type: 'extractFullAudio' }, {}, () => { throw new Error('channel closed'); }), true);
  await new Promise((resolve) => { setImmediate(resolve); });
});

// --- H8, H10, H11: parser fixes ----------------------------------------------
test('H8: mania hold-note hitsound metadata is parsed after stripping endTime prefix', () => {
  const map = parseMapPreviewData(`osu file format v14
[General]
Mode: 3
[Difficulty]
CircleSize: 4
[TimingPoints]
0,500,4,2,0,100,1,0
[HitObjects]
64,192,1000,128,2,2000:2:3:1:75:custom.wav
`);
  assert.equal(map.objects.length, 1);
  const hold = map.objects[0];
  assert.equal(hold.kind, 'hold');
  assert.equal(hold.endTime, 2000);
  assert.equal(hold.sampleSet, 2);
  assert.equal(hold.additionSet, 3);
  assert.equal(hold.sampleVolume, 75);
  assert.equal(hold.sampleFilename, 'custom.wav');
});

test('H10 & H11: parser handles 140k redlines without stack overflow and clamps difficulty values', () => {
  const redlines = Array.from({ length: 140000 }, (_, i) => `${i * 10},500,4,2,0,100,1,0`).join('\n');
  const map = parseMapPreviewData(`osu file format v14
[General]
Mode: 0
StackLeniency: 999999
SampleSet: constructor
[Difficulty]
CircleSize: 99
ApproachRate: -5
OverallDifficulty: 100000
HPDrainRate: 50
[TimingPoints]
${redlines}
[HitObjects]
256,192,2000,1,0
256,192,1000,1,0
`);
  assert.equal(map.bpmMin, 120);
  assert.equal(map.bpmMax, 120);
  assert.equal(map.circleSize, 10);
  assert.equal(map.approachRate, 0);
  assert.equal(map.overallDifficulty, 10);
  assert.equal(map.hpDrainRate, 10);
  assert.equal(map.stackLeniency, 1);
  assert.equal(map.defaultSampleSet, 0);
  assert.deepEqual(map.objects.map((o) => o.time), [1000, 2000], 'out-of-order objects are sorted');
});

// --- H9: perfect-circle slider direction -------------------------------------
test('H9: perfect-circle slider with small intermediate angle does not invert 360 degrees', () => {
  const points = buildSliderCurvePoints({
    kind: 'slider',
    x: 0,
    y: 100,
    length: 512,
    sliderCurveType: 'P',
    sliderPoints: [{ x: 511, y: 101 }, { x: 512, y: 101 }],
  });
  const end = points.at(-1);
  assert.ok(end.x > 400, `expected slider to end near x=512, got (${end.x}, ${end.y})`);
  assert.ok(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

// --- H12 & H13: converter caps & Catch banana float32 ULP stall --------------
test('H13: Catch banana shower near MAX_OBJECT_TIME_MS does not stall on float32 ULP', () => {
  const start = MAX_OBJECT_TIME_MS - 500;
  const end = MAX_OBJECT_TIME_MS;
  const map = parseMapPreviewData(`osu file format v14
[General]
Mode: 2
[Difficulty]
CircleSize: 4
[TimingPoints]
0,500,4,2,0,100,1,0
[HitObjects]
256,192,${start},12,0,${end}
`);
  const converted = convertMapForMode(map, 2);
  assert.ok(converted.catchObjects.length < 1000, `expected bounded bananas, got ${converted.catchObjects.length}`);
});

// --- H14, H15, H16: Standard stacking, opaque fill & CS 0 picking ------------
test('H15: even-span repeat sliders stack following objects against their head, not their tail', () => {
  const objects = [
    { kind: 'slider', x: 100, y: 100, time: 1000, endTime: 1400, slides: 2, length: 200, sliderCurveType: 'L', sliderPoints: [{ x: 300, y: 100 }] },
    { kind: 'circle', x: 100, y: 100, time: 1500, endTime: 1500 },
  ];
  applyPreviewStacking(objects, 5, 0.7, 14, 5);
  assert.notEqual(objects[1].stackIndex, 0, 'circle at head of 2-span repeat slider should stack');
});

test('H16: StandardRenderer hit-tests CS 0 circles at their true radius and spinners at playfield center', () => {
  const prevWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const noop = () => {};
    const ctx = new Proxy({ canvas: { width: 512, height: 384 } }, {
      get(target, prop) { return prop in target ? target[prop] : noop; },
    });
    const canvas = { clientWidth: 512, clientHeight: 384, width: 512, height: 384, getContext: () => ctx };
    const renderer = new PreviewRenderer(canvas, null);
    renderer.setBeatmap({
      mode: 0,
      circleSize: 0,
      approachRate: 5,
      sliderMultiplier: 1.4,
      sliderTickRate: 1,
      timingControlPoints: [{ time: 0, beatLength: 500, uninherited: true, meter: 4 }],
      objects: [
        { kind: 'circle', x: 256, y: 192, time: 1000, endTime: 1000 },
        { kind: 'spinner', x: 10, y: 10, time: 3000, endTime: 5000 },
      ],
    }, 6000);

    // CS 0 radius is 54.4 osu px (vs 32 at CS 5). Clicking 42 osu px from center hits at CS 0.
    renderer.setTime(1000);
    renderer.renderPlayfield();
    const layout = getStandardPlayfieldLayout(512, 384, 0, 0);
    const edgeX = layout.playfieldX + ((256 + 42) * layout.scale);
    const edgeY = layout.playfieldY + (192 * layout.scaleY);
    assert.equal(renderer.objectIndexAtPoint(edgeX, edgeY), 0);

    // Spinner is hit-tested at playfield center (256, 192), not (10, 10).
    renderer.setTime(3500);
    renderer.renderPlayfield();
    const centerX = layout.playfieldX + (256 * layout.scale);
    const centerY = layout.playfieldY + (192 * layout.scaleY);
    assert.equal(renderer.objectIndexAtPoint(centerX, centerY), 1);
    renderer.dispose();
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

// --- H17 & H11: Catch autoplay monotonicity & CS clamping --------------------
test('H17: buildCatchAutoplayFrames keeps frames.times monotonic when 0 < timeAtDashSpeed < 1 and clamps CS', () => {
  assert.ok(getCatchObjectScale(15) > 0, 'CS > 12.14 must clamp to [0, 10] and stay positive');
  assert.equal(getCatchObjectScale(null), getCatchObjectScale(5));

  // Need positionChange = 250.25 in 500ms -> timeAtNormalSpeed = 500.5 -> timeAtDashSpeed = 0.5ms (< 1ms).
  const frames = buildCatchAutoplayFrames([
    { time: 1000, x: 100, type: 'fruit', hyperDash: false },
    { time: 1500, x: 350.25, type: 'fruit', hyperDash: false },
  ], 5);
  for (let i = 1; i < frames.times.length; i += 1) {
    assert.ok(frames.times[i] >= frames.times[i - 1], `non-monotonic frames at ${i}: ${frames.times[i - 1]} -> ${frames.times[i]}`);
  }
});

// --- Mania bar lines & overlapping column key light --------------------------
test('Mania does not duplicate bar lines at BPM changes and keeps lane lit across overlapping holds', () => {
  const lines = generateManiaBarLines([
    { time: 0, beatLength: 500, uninherited: true, meter: 4 },
    { time: 4000, beatLength: 250, uninherited: true, meter: 4 },
  ], 0, 5000);
  const at4000 = lines.filter((line) => Math.abs(line.time - 4000) < 1e-3);
  assert.equal(at4000.length, 1, 'boundary at 4000ms must emit only one bar line');

  const presses = buildManiaKeyPresses([
    { time: 1000, endTime: 3000, column: 0, kind: 'hold' },
    { time: 1500, endTime: 1500, column: 0, kind: 'circle' },
  ], (o) => o.column, 1);
  assert.ok(getLaneLight(presses[0], 2500) >= 0.49, 'lane stays lit while overlapping hold is still held');
});

// --- Timeline: huge meter guard, pastEnd shading & overview bracket ----------
test('Timeline guards huge meter overflow, clamps overview bracket, and keeps pastEnd shading', () => {
  const prevWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const fills = [];
    const ctx = new Proxy({ fillStyle: '' }, {
      get(target, prop) {
        if (prop === 'fillRect') return (...args) => fills.push({ style: target.fillStyle, args });
        if (prop in target) return target[prop];
        return () => {};
      },
    });
    const canvas = { clientWidth: 200, clientHeight: 24, width: 200, height: 24, getContext: () => ctx };
    const timeline = new TimelineRenderer(canvas);
    timeline.setBeatmap({
      timingControlPoints: [{ time: 0, beatLength: 500, uninherited: true, meter: 1e305 }],
      objects: [{ time: 1000, endTime: 1000, kind: 'circle' }],
      breaks: [],
    }, 10000);
    timeline.setSongEnd(2000);
    timeline.setView(5000, 1000, { animate: false });
    assert.doesNotThrow(() => timeline.render(100));
    assert.ok(fills.some((f) => f.style === 'rgba(0, 0, 0, 0.05)'), 'pastEnd shading persists when panned past songEndMs');

    timeline.setView(0, 500, { animate: false });
    timeline.width = 200;
    const leftBracket = timeline.getOverviewBracket();
    assert.ok(leftBracket.x0 >= 0 && leftBracket.x1 <= 200);
    timeline.dispose();
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

// --- Ogg Vorbis: 64 modes & truncated segment table --------------------------
test('Ogg Vorbis accepts 64 modes and safely rejects truncated segment tables', async () => {
  // Pack a valid 64-mode setup header (vorbis_mode_count = 64 -> 6-bit field = 63).
  const bytes = [];
  let bit = 0;
  const pushBits = (val, count) => {
    for (let i = 0; i < count; i += 1) {
      if (bit === 0) bytes.push(0);
      if ((val >> i) & 1) bytes[bytes.length - 1] |= 1 << bit;
      bit = (bit + 1) & 7;
    }
  };
  for (const ch of [5, ...[...'vorbis'].map((c) => c.charCodeAt(0))]) pushBits(ch, 8);
  for (let i = 0; i < 8; i += 1) pushBits(0xff, 8);
  pushBits(63, 6); // 64 modes
  for (let m = 0; m < 64; m += 1) {
    pushBits(m & 1, 1);
    pushBits(0, 16);
    pushBits(0, 16);
    pushBits(0, 8);
  }
  pushBits(1, 1);
  const flags = readModeBlockFlags(Uint8Array.from(bytes));
  assert.equal(flags?.length, 64);

  // Truncated Ogg page claiming 200 segments with only 27 bytes total.
  const truncated = new Uint8Array(28);
  truncated.set([0x4f, 0x67, 0x67, 0x53, 0, 2]);
  truncated[26] = 200;
  assert.equal(await buildOggVorbisIndex(new Blob([truncated], { type: 'audio/ogg' })), null);
});

// --- ZIP: oversized song + small hitsound, CRC-32 mismatch, encrypted --------
test('ZIP rejects oversized song fallback to hitsound, CRC-32 mismatch, and encrypted entries', async () => {
  const picked = pickAudioEntryFromZip([
    { name: 'audio.mp3', uncompressedSize: MAX_ZIP_AUDIO_ENTRY_BYTES + 1024 },
    { name: 'soft-hitnormal.wav', uncompressedSize: 4096 },
  ], 'audio.mp3');
  assert.equal(picked, null, 'must not play hitsound .wav when requested song is oversized');

  // Stored entry with wrong CRC-32.
  const payload = Buffer.from('audio-data');
  const name = Buffer.from('audio.mp3');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(0x12345678, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  const archive = new Uint8Array(Buffer.concat([local, name, payload]));
  await assert.rejects(extractZipEntry(archive, {
    name: 'audio.mp3',
    flags: 0,
    crc32: 0x12345678,
    compressionMethod: 0,
    compressedSize: payload.length,
    uncompressedSize: payload.length,
    localHeaderOffset: 0,
  }), /CRC-32/);

  // Encrypted entry (bit 0 set).
  local.writeUInt16LE(0x0001, 6);
  const encryptedArchive = new Uint8Array(Buffer.concat([local, name, payload]));
  await assert.rejects(extractZipEntry(encryptedArchive, {
    name: 'audio.mp3',
    flags: 0x0001,
    compressionMethod: 0,
    compressedSize: payload.length,
    uncompressedSize: payload.length,
    localHeaderOffset: 0,
  }), /Encrypted/);

  // Truncated central directory filename throws rather than silent break.
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(100, 28); // filename longer than central dir
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(0, 16);
  assert.throws(() => parseZipEntries(new Uint8Array(Buffer.concat([central, eocd]))), /truncated/);
});

// --- Cache: subdirectory collision, QuotaExceeded retry, compaction, .. ------
test('Cache prevents subdirectory alias collisions, retries on QuotaExceededError, and compacts dead targets', async () => {
  assert.equal(normalizePath('..'), '');
  assert.equal(normalizePath('./a/../song.mp3'), 'song.mp3');

  const live = compactFullAudioAliasesForCacheKeys({
    'https://osu.ppy.sh/beatmapsets/1/audio/a.mp3': 'https://osu.ppy.sh/beatmapsets/1/audio/dead%2Fa.mp3',
  }, new Set(['https://osu.ppy.sh/beatmapsets/1/audio/a.mp3']));
  assert.deepEqual(live, {}, 'dangling alias pointing to dead primary key must be dropped');

  const store = new Map();
  let failOnceWithQuota = true;
  const prevCaches = globalThis.caches;
  globalThis.caches = {
    open: async () => ({
      keys: async () => [...store.keys()].map((url) => ({ url })),
      match: async (req) => store.get(typeof req === 'string' ? req : req.url),
      delete: async (req) => store.delete(typeof req === 'string' ? req : req.url),
      put: async (url, response) => {
        if (failOnceWithQuota) {
          failOnceWithQuota = false;
          throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        }
        store.set(url, response);
      },
    }),
  };
  try {
    // Seed an old entry to be evicted on QuotaExceededError.
    store.set('https://osu.ppy.sh/beatmapsets/999/audio/old.mp3', new Response(new Uint8Array(100), {
      headers: { 'x-mosu-cached-at': '1', 'x-mosu-size': '100' },
    }));
    const blobV1 = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' });
    const wrote = await writeCachedFullAudioBlob('123', 'v1/audio.mp3', blobV1, null, { awaitPrune: true });
    assert.equal(wrote, true, 'QuotaExceededError should evict old entry and retry once');

    // v1/audio.mp3 hits, while v2/audio.mp3 (different subdirectory) must NOT collide onto v1/audio.mp3.
    const hitV1 = await readCachedFullAudioBlob('123', 'v1/audio.mp3');
    const missV2 = await readCachedFullAudioBlob('123', 'v2/audio.mp3');
    assert.equal(hitV1?.size, 4);
    assert.equal(missV2, null);
  } finally {
    if (prevCaches === undefined) delete globalThis.caches;
    else globalThis.caches = prevCaches;
  }
});

// --- History, Settings & Keybindings edge cases ------------------------------
test('History filters null entries; Settings and Keybindings validate edge cases safely', () => {
  const next = buildNextHistory([null, { beatmapId: '10', title: 'Old' }], {
    beatmapId: '10',
    beatmapSetId: '100',
    title: 'Updated',
  }, 500);
  assert.equal(next.length, 1);
  assert.equal(next[0].title, 'Updated');

  assert.deepEqual(normalizeProviderPriority(['mino', 'mino', 'nerinyan']), ['mino', 'nerinyan', 'osu_direct', 'sayobot']);
  assert.equal(normalizeManiaScrollSpeed(''), DEFAULT_MANIA_SCROLL_SPEED);
  assert.equal(normalizeManiaScrollSpeed(null), DEFAULT_MANIA_SCROLL_SPEED);
  assert.equal(normalizeHitsoundVolume(''), DEFAULT_HITSOUND_VOLUME);
  assert.equal(normalizeHitsoundVolume(null), DEFAULT_HITSOUND_VOLUME);
  assert.ok(Number.isFinite(computeProviderScore({ id: 'mino', rank: 1 }, {})));

  assert.equal(formatKeyLabel('toString'), 'ToString');
  assert.doesNotThrow(() => resetKeybinding({}, 'constructor'));
  const normalized = normalizeKeybindings({ playPause: null, mute: 42 });
  assert.deepEqual(normalized.playPause, [' '], 'corrupt null entry falls back to default');
  assert.deepEqual(normalized.mute, ['m'], 'corrupt numeric entry falls back to default');
});
