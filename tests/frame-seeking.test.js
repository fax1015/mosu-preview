import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import {
  DECODER_DELAY_SAMPLES,
  SEEK_PREROLL_FRAMES,
  buildMp3FrameIndex,
} from '../src/audio/mp3Index.js';
import { createFrameSeeker, createTrackFrameSeeker, findFrameAtOrBefore } from '../src/audio/frameSeeker.js';
import { createPlaybackController } from '../src/audio/playback.js';
import { createTimingController } from '../src/core/timing.js';

// --- synthetic MPEG-1 layer III streams ---------------------------------------
// Real frame headers with silent bodies: enough for anything that only walks
// the stream's structure, which is all the index does.
const SAMPLE_RATE = 44100;
const SAMPLES_PER_FRAME = 1152;
const BITRATE_INDEX = { 32: 1, 64: 5, 96: 7, 128: 9, 192: 11, 256: 13, 320: 14 };
const frameMs = (SAMPLES_PER_FRAME / SAMPLE_RATE) * 1000;

const frame = (kbps) => {
  const bytes = new Uint8Array(Math.floor((144 * kbps * 1000) / SAMPLE_RATE));
  // MPEG-1, layer III, no CRC; 44.1kHz, no padding; joint stereo.
  bytes.set([0xff, 0xfb, BITRATE_INDEX[kbps] << 4, 0x44]);
  return bytes;
};

// A 128kbps "Xing" (VBR) or "Info" (CBR) frame. With `lameDelay` it carries a
// LAME tag recording that many samples of encoder delay.
const tagFrame = (tag, lameDelay = null) => {
  const bytes = frame(128);
  const text = (offset, value) => [...value].forEach((char, i) => { bytes[offset + i] = char.charCodeAt(0); });
  const tagOffset = 4 + 32; // after the stereo side info
  text(tagOffset, tag);
  bytes[tagOffset + 7] = 0x0f; // frames, bytes, TOC and quality all present
  if (lameDelay !== null) {
    const lame = tagOffset + 8 + 4 + 4 + 100 + 4;
    text(lame, 'LAME3.100');
    const packed = (lameDelay << 12) | 1000;
    bytes.set([(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff], lame + 21);
  }
  return bytes;
};

const id3Tag = (bodyLength) => {
  const bytes = new Uint8Array(10 + bodyLength);
  bytes.set([0x49, 0x44, 0x33, 3, 0, 0]);
  bytes.set([(bodyLength >> 21) & 0x7f, (bodyLength >> 14) & 0x7f, (bodyLength >> 7) & 0x7f, bodyLength & 0x7f], 6);
  return bytes;
};

const concatBytes = (parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const VBR_PATTERN = [128, 320, 64, 192, 256, 96, 128, 32, 320, 192];
const vbrFrames = (count) => Array.from({ length: count }, (_, i) => frame(VBR_PATTERN[i % VBR_PATTERN.length]));
const mp3Blob = (parts) => new Blob([concatBytes(parts)], { type: 'audio/mpeg' });

test('frame times accumulate exactly across varying bitrates', async () => {
  const frames = vbrFrames(40);
  const index = await buildMp3FrameIndex(mp3Blob(frames));

  assert.equal(index.count, 40);
  assert.equal(index.isVbr, true);
  let offset = 0;
  frames.forEach((bytes, i) => {
    assert.equal(index.offsets[i], offset, `frame ${i} offset`);
    assert.ok(Math.abs(index.startMs[i] - (i * frameMs)) < 1e-9, `frame ${i} time`);
    offset += bytes.length;
  });
  assert.ok(Math.abs(index.durationMs - (40 * frameMs)) < 1e-9);
});

test('a constant-bitrate stream is not VBR, even behind an Info frame', async () => {
  // LAME marks CBR files with "Info"; the browser seeks those accurately.
  const index = await buildMp3FrameIndex(mp3Blob([tagFrame('Info'), ...Array.from({ length: 12 }, () => frame(128))]));
  assert.equal(index.isVbr, false);
  assert.equal(index.count, 12, 'the tag frame carries no audio');
});

test('the LAME encoder delay moves frames onto the trimmed timeline browsers report', async () => {
  const withDelay = await buildMp3FrameIndex(mp3Blob([tagFrame('Xing', 576), ...vbrFrames(8)]));
  assert.ok(Math.abs(withDelay.startMs[0] + (((576 + DECODER_DELAY_SAMPLES) / SAMPLE_RATE) * 1000)) < 1e-9);
  assert.equal(withDelay.offsets[0], frame(128).length, 'audio starts after the Xing frame');

  // A LAME tag recording no delay still gets the decoder's own trimmed.
  const zeroDelay = await buildMp3FrameIndex(mp3Blob([tagFrame('Xing', 0), ...vbrFrames(8)]));
  assert.ok(Math.abs(zeroDelay.startMs[0] + ((DECODER_DELAY_SAMPLES / SAMPLE_RATE) * 1000)) < 1e-9);

  // No LAME tag at all: nothing is trimmed.
  const untagged = await buildMp3FrameIndex(mp3Blob([tagFrame('Xing'), ...vbrFrames(8)]));
  assert.equal(untagged.startMs[0], 0);
});

test('a header-shaped sequence in junk before the audio is not taken for a frame', async () => {
  const junk = new Uint8Array(57);
  junk.set([0xff, 0xfb, 0x90, 0x44]); // a valid header, not followed by another
  const frames = vbrFrames(6);
  const prefix = id3Tag(100).length + junk.length;
  const index = await buildMp3FrameIndex(mp3Blob([id3Tag(100), junk, ...frames]));

  assert.equal(index.offsets[0], prefix);
  assert.equal(index.count, 6);
});

test('damage in the middle of the stream is stepped over', async () => {
  const frames = vbrFrames(12);
  const damage = new Uint8Array(37).fill(0x55);
  const index = await buildMp3FrameIndex(mp3Blob([...frames.slice(0, 5), damage, ...frames.slice(5)]));

  assert.equal(index.count, 12);
  const sixth = frames.slice(0, 5).reduce((sum, bytes) => sum + bytes.length, 0) + damage.length;
  assert.equal(index.offsets[5], sixth);
});

test('a stream that crosses the reader\'s chunk boundaries indexes the same', async () => {
  const blob = mp3Blob(vbrFrames(200));
  const whole = await buildMp3FrameIndex(blob);
  const chunked = await buildMp3FrameIndex(blob, { chunkBytes: 1000 });
  assert.deepEqual([...chunked.offsets], [...whole.offsets]);
  assert.deepEqual([...chunked.startMs], [...whole.startMs]);
});

test('anything that is not an MPEG audio stream is left to the browser', async () => {
  assert.equal(await buildMp3FrameIndex(new Blob([new TextEncoder().encode('RIFF....WAVEfmt ')])), null);
  assert.equal(await buildMp3FrameIndex(new Blob([])), null);
  assert.equal(await buildMp3FrameIndex(null), null);
});

test('the frame for a time is the last one starting at or before it', async () => {
  const index = await buildMp3FrameIndex(mp3Blob(vbrFrames(10)));
  assert.equal(findFrameAtOrBefore(index, -50), 0);
  assert.equal(findFrameAtOrBefore(index, 0), 0);
  assert.equal(findFrameAtOrBefore(index, frameMs * 3), 3);
  assert.equal(findFrameAtOrBefore(index, (frameMs * 3) + 1), 3);
  assert.equal(findFrameAtOrBefore(index, 1e9), 9);
});

// --- the seeker ---------------------------------------------------------------
const createSeekerState = () => ({
  audio: { src: '', loads: 0, playbackRate: 1, load() { this.loads += 1; this.playbackRate = 1; } },
  playbackSpeed: 1.5,
  audioAnchorMapMs: 0,
  audioAnchorSrc: '',
  fullAudioSliceUrl: null,
});

const createSeekerHarness = async () => {
  const blob = mp3Blob(vbrFrames(60));
  const index = await buildMp3FrameIndex(blob);
  const state = createSeekerState();
  return { blob, index, state, seeker: createFrameSeeker({ state, blob, index }) };
};

test('a constant-bitrate MP3 seeks by frame too, anchored on the delay-trimmed timeline', async () => {
  // Chromium seeking a real 48kHz CBR track played its 23ms encoder delay ahead
  // of currentTime over most of the track, so CBR is no reason to trust it.
  const blob = mp3Blob([tagFrame('Info', 576), ...Array.from({ length: 40 }, () => frame(128))]);
  const state = createSeekerState();
  const seeker = await createTrackFrameSeeker({ state, blob, filename: 'audio.mp3' });

  assert.ok(seeker);
  assert.equal(seeker.index.isVbr, false);
  assert.equal(seeker.seek(seeker.index.startMs[20] + 7), true);
  const frameStart = 20 - SEEK_PREROLL_FRAMES;
  const trimmedMs = (((frameStart * SAMPLES_PER_FRAME) - (576 + DECODER_DELAY_SAMPLES)) / SAMPLE_RATE) * 1000;
  assert.ok(Math.abs(state.audioAnchorMapMs - trimmedMs) < 1e-9);
  assert.equal(state.audio.src, state.audioAnchorSrc);
  seeker.dispose();
});

test('a variable-bitrate MP3 gets a frame seeker from its type alone', async () => {
  const seeker = await createTrackFrameSeeker({ state: createSeekerState(), blob: mp3Blob(vbrFrames(20)), filename: '' });
  assert.equal(seeker?.index.isVbr, true);
});

test('only an actual MP3 is taken off the browser\'s own seeking', async () => {
  const ogg = new Blob([new TextEncoder().encode('OggS\0\x02')], { type: 'audio/ogg' });
  assert.equal(await createTrackFrameSeeker({ state: createSeekerState(), blob: ogg, filename: 'audio.ogg' }), null);
  // Named like one, but nothing in it parses as MPEG audio.
  const notMpeg = new Blob([new Uint8Array(4096)]);
  assert.equal(await createTrackFrameSeeker({ state: createSeekerState(), blob: notMpeg, filename: 'audio.mp3' }), null);
});

test('a seek plays on from a frame boundary just before the target, anchored to its exact time', async () => {
  const { blob, index, state, seeker } = await createSeekerHarness();
  const target = index.startMs[20] + 7;

  assert.equal(seeker.seek(target), true);

  const frame = 20 - SEEK_PREROLL_FRAMES;
  assert.equal(state.audioAnchorMapMs, index.startMs[frame]);
  assert.equal(state.audio.src, state.audioAnchorSrc, 'the anchor has to describe the source it was set for');
  assert.equal(state.fullAudioSliceUrl, state.audio.src);
  assert.equal(resolveObjectURL(state.audio.src).size, blob.size - index.offsets[frame]);
  assert.equal(state.audio.loads, 1);
  assert.equal(state.audio.playbackRate, 1.5, 'load() resets the rate, so it is put back');
});

test('each seek releases the slice it replaces', async () => {
  const { index, state, seeker } = await createSeekerHarness();
  seeker.seek(index.startMs[10]);
  const first = state.audio.src;
  seeker.seek(index.startMs[30]);

  assert.equal(resolveObjectURL(first), undefined);
  assert.ok(resolveObjectURL(state.audio.src));
  seeker.dispose();
  assert.equal(resolveObjectURL(state.audio.src), undefined);
});

test('a seek outside the track only lands when the caller allows clamping', async () => {
  const { index, state, seeker } = await createSeekerHarness();

  assert.equal(seeker.seek(index.durationMs + 1000), false);
  assert.equal(seeker.seek(-1000), false);
  assert.equal(state.audio.loads, 0, 'a refused seek leaves the element alone');

  assert.equal(seeker.seek(index.durationMs + 1000, { requireCoverage: false }), true);
  assert.equal(state.audioAnchorMapMs, index.startMs[index.count - 1 - SEEK_PREROLL_FRAMES]);
  assert.equal(seeker.seek(-1000, { requireCoverage: false }), true);
  assert.equal(state.audioAnchorMapMs, index.startMs[0]);
});

// --- the playback controller's hook ---------------------------------------------
test('every seek the playback controller makes goes through the injected seekAudio', async () => {
  const calls = [];
  const audio = {
    src: 'blob:full', duration: 600, currentTime: 0, paused: true, playbackRate: 1,
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
  const state = {
    audio,
    audioAnchorMapMs: 0,
    audioAnchorSrc: audio.src,
    audioSyncEnabled: true,
    audioOpToken: 0,
    pendingSeekMapMs: null,
    currentTimeMs: 0,
    durationMs: 600_000,
    mapData: { objects: [] },
    isPlaying: false,
    playbackMode: 'none',
    playbackSpeed: 1,
    playStartMapMs: 0,
    playStartPerfMs: 0,
    rafId: null,
  };
  const latencyMs = 30;
  const controller = createPlaybackController({
    state,
    helpers: {
      ...createTimingController({ state, clamp: (v, min, max) => Math.min(max, Math.max(min, v)) }),
      getAudioOutputLatencyMapMs: () => latencyMs,
      ensureTimelineDurationAnimation: () => {},
      renderFrame: () => {},
      waitForAudioSeek: async () => true,
      requestFrame: () => 1,
      cancelFrame: () => {},
      seekAudio: (targetMs, options) => {
        calls.push({ targetMs, options });
        audio.currentTime = targetMs / 1000;
        return true;
      },
    },
  });

  state.currentTimeMs = 12_000;
  await controller.togglePlayback();
  controller.seekTo(5_000);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.deepEqual(calls.map((call) => call.targetMs), [12_000 + latencyMs, 5_000 + latencyMs]);
});
