import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrackFrameSeeker } from '../src/audio/frameSeeker.js';
import { buildOggVorbisIndex, readModeBlockFlags } from '../src/audio/oggIndex.js';

// --- synthetic Ogg Vorbis streams -----------------------------------------------
// Real headers and page framing around bodies that are only filler: the index
// reads structure, block sizes and positions, never the audio itself.
const SAMPLE_RATE = 44100;
const BLOCK = [256, 2048];
const ascii = (text) => [...text].map((char) => char.charCodeAt(0));

// Vorbis packs bits from the bottom of each byte up.
const packBits = (fields) => {
  const bytes = [];
  let bit = 0;
  for (const [value, count] of fields) {
    for (let i = 0; i < count; i += 1) {
      if (bit === 0) bytes.push(0);
      if ((value >> i) & 1) bytes[bytes.length - 1] |= 1 << bit;
      bit = (bit + 1) & 7;
    }
  }
  return Uint8Array.from(bytes);
};

const idHeader = () => {
  const bytes = new Uint8Array(30);
  bytes.set([1, ...ascii('vorbis')]);
  bytes[11] = 2;
  new DataView(bytes.buffer).setUint32(12, SAMPLE_RATE, true);
  bytes[28] = (11 << 4) | 8; // 256 and 2048 sample blocks
  bytes[29] = 1;
  return bytes;
};
const commentHeader = () => Uint8Array.from([3, ...ascii('vorbis'), 0, 0, 0, 0, 0, 0, 0, 0, 1]);
// Codebooks, floors and the rest stand in as filler; the modes and the framing
// bit close the packet, as they do in a real one.
const setupHeader = (modeFlags) => packBits([
  ...[5, ...ascii('vorbis')].map((byte) => [byte, 8]),
  ...Array.from({ length: 24 }, () => [0xff, 8]),
  [modeFlags.length - 1, 6],
  ...modeFlags.flatMap((flag) => [[flag, 1], [0, 16], [0, 16], [0, 8]]),
  [1, 1],
]);

// Mode 0 is a short block, mode 1 a long one.
const MODES = [0, 1];
const audioPacket = (isLong, previousLong, length = 120) => {
  const bytes = new Uint8Array(length).fill(0x55);
  bytes[0] = ((isLong ? 1 : 0) << 1) | (isLong ? ((previousLong ? 1 : 0) << 2) | (1 << 3) : 0);
  return bytes;
};

// Ogg's CRC, bit by bit, independent of the one under test.
const oggCrc = (bytes) => {
  let crc = 0;
  for (const byte of bytes) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let k = 0; k < 8; k += 1) crc = ((crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1)) >>> 0;
  }
  return crc;
};

const writePage = ({ flags, granule, serial, sequence, lacing, body }) => {
  const page = new Uint8Array(27 + lacing.length + body.length);
  const view = new DataView(page.buffer);
  page.set([...ascii('OggS'), 0, flags]);
  view.setBigInt64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(body, 27 + lacing.length);
  view.setUint32(22, oggCrc(page), true);
  return page;
};

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

/**
 * Packs packets into pages. Headers get the pages the spec gives them; audio
 * fills pages up to `segmentsPerPage` lacing values, so long packets run across
 * page boundaries. Granules are the samples out after each page's last finished
 * packet, plus `granuleOffset`. `audio[i]` says where audio packet i starts and
 * ends, and how many samples are out once it has.
 */
const buildStream = ({ blocks, lengths = [], segmentsPerPage = 4, granuleOffset = 0, serial = 0x1234 } = {}) => {
  const packets = [idHeader(), commentHeader(), setupHeader(MODES)];
  const ends = [0, 0, 0];
  let samples = 0;
  blocks.forEach((isLong, i) => {
    packets.push(audioPacket(isLong, blocks[i - 1] ?? false, lengths[i] ?? 120));
    samples += i === 0 ? 0 : (BLOCK[blocks[i - 1] ? 1 : 0] + BLOCK[isLong ? 1 : 0]) / 4;
    ends.push(samples);
  });

  const pages = [];
  const audio = [];
  let lacing = [];
  let body = [];
  let pageContinued = false;
  let lastEnded = null;
  const flush = (isLast = false) => {
    let flags = pageContinued ? 1 : 0;
    if (pages.length === 0) flags |= 2;
    if (isLast) flags |= 4;
    const granule = lastEnded === null ? -1 : (lastEnded >= 3 ? ends[lastEnded] + granuleOffset : 0);
    pages.push({ flags, granule, serial, sequence: pages.length, lacing: Uint8Array.from(lacing), body: Uint8Array.from(body) });
    lacing = [];
    body = [];
    lastEnded = null;
  };
  packets.forEach((packet, index) => {
    const values = [...Array(Math.floor(packet.length / 255)).fill(255), packet.length % 255];
    let at = 0;
    let startPage = null;
    values.forEach((value, v) => {
      if (lacing.length === (index < 3 ? 255 : segmentsPerPage)) {
        flush();
        pageContinued = v > 0;
      }
      if (v === 0) startPage = pages.length;
      lacing.push(value);
      body.push(...packet.subarray(at, at + value));
      at += value;
      if (v === values.length - 1) lastEnded = index;
    });
    if (index >= 3) audio.push({ startPage, endPage: pages.length, end: ends[index] });
    if (index === 0 || index === 2) {
      flush();
      pageContinued = false;
    }
  });
  flush(true);
  const lastPage = pages.length - 1;
  // The packets a slice can start from: not the first (the file itself primes
  // on it), and only ones that finish on the page they start on, which is not
  // the last page, with another packet finishing after them there.
  const pointEnds = audio
    .filter((packet, i) => i >= 1 && packet.startPage === packet.endPage && packet.startPage !== lastPage
      && audio[i + 1]?.endPage === packet.endPage)
    .map((packet) => packet.end);
  return { pages, ends, audio, pointEnds, bytes: () => concat(pages.map(writePage)) };
};

const readPages = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pages = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.equal(String.fromCharCode(...bytes.subarray(offset, offset + 4)), 'OggS', `page at ${offset}`);
    const segments = bytes[offset + 26];
    const lacing = bytes.subarray(offset + 27, offset + 27 + segments);
    const length = 27 + segments + lacing.reduce((sum, value) => sum + value, 0);
    const page = bytes.slice(offset, offset + length);
    const stored = view.getUint32(offset + 22, true);
    new DataView(page.buffer).setUint32(22, 0, true);
    pages.push({ offset, length, flags: bytes[offset + 5], granule: Number(view.getBigInt64(offset + 6, true)), lacing, crcOk: oggCrc(page) === stored });
    offset += length;
  }
  return pages;
};

// Where FFmpeg starts a stream, by both of its rules. Before July 2026: the
// first audio page's position less every packet on it. Since: zero less the
// first packet. Durations as libavcodec's vorbis_parser gives them after a
// reset: a long block reads its previous-window flag, a short one assumes a
// short block before it.
const ffmpegStarts = (bytes) => {
  const page = readPages(bytes)[2];
  const durations = [];
  let previous = BLOCK[0];
  let at = page.offset + 27 + page.lacing.length;
  let length = 0;
  for (const value of page.lacing) {
    length += value;
    if (value < 255) {
      const isLong = (bytes[at] >> 1) & 1;
      const prior = isLong ? BLOCK[(bytes[at] >> 2) & 1] : previous;
      durations.push((prior + BLOCK[isLong]) / 4);
      previous = BLOCK[isLong];
      at += length;
      length = 0;
    }
  }
  return { beforeJuly2026: page.granule - durations.reduce((sum, d) => sum + d, 0), sinceJuly2026: -durations[0] };
};

const BLOCKS = [true, true, false, false, true, true, true, false, true, false, false, true, true, true, true, false, true, true];
const blobOf = (bytes) => new Blob([bytes], { type: 'audio/ogg' });
const msOf = (samples) => (samples / SAMPLE_RATE) * 1000;

// --- the index --------------------------------------------------------------------
test('the setup header\'s modes are read back from its end', () => {
  assert.deepEqual(readModeBlockFlags(setupHeader([0, 1])), [0, 1]);
  assert.deepEqual(readModeBlockFlags(setupHeader([1, 0, 1])), [1, 0, 1]);
  assert.equal(readModeBlockFlags(Uint8Array.from([5, ...ascii('vorbis'), 0, 0, 0])), null);
});

test('each packet that finishes on its page is a point, timed where its output begins', async () => {
  const stream = buildStream({ blocks: BLOCKS });
  const index = await buildOggVorbisIndex(blobOf(stream.bytes()));

  assert.equal(index.format, 'ogg');
  assert.equal(index.sampleRate, SAMPLE_RATE);
  assert.equal(index.startMs[0], 0, 'point 0 is the file from its start');
  // A slice primes on its first packet, so it starts where that packet's
  // output ends.
  assert.ok(stream.pointEnds.length > 8);
  assert.deepEqual([...index.startMs.slice(1)], stream.pointEnds.map(msOf));
  assert.ok(Math.abs(index.durationMs - msOf(stream.ends.at(-1))) < 1e-9);
});

// The slice's first page, the page of the file it was rebuilt from, and where
// the slice goes back to the file's own bytes.
const rebuiltPage = (bytes, slice) => {
  const original = readPages(bytes);
  const rebuilt = readPages(slice)[2];
  const tailStart = rebuilt.offset + rebuilt.length;
  const source = original.find((page) => page.offset + page.length === bytes.length - (slice.length - tailStart));
  return { original, rebuilt, source, tailStart };
};

test('a slice is the headers, a page rebuilt to start at the packet, then the rest as it was', async () => {
  const stream = buildStream({ blocks: BLOCKS });
  const bytes = stream.bytes();

  for (const renumberSlices of [true, false]) {
    const index = await buildOggVorbisIndex(blobOf(bytes), { renumberSlices });
    for (let point = 1; point < index.count; point += 1) {
      const slice = new Uint8Array(await index.sliceFrom(blobOf(bytes), point).arrayBuffer());
      assert.ok(readPages(slice).every((page) => page.crcOk), `point ${point}: every page's CRC holds`);
      const { original, rebuilt, source, tailStart } = rebuiltPage(bytes, slice);

      // The two header pages, untouched.
      const headerEnd = original[1].offset + original[1].length;
      assert.deepEqual(slice.subarray(0, headerEnd), bytes.subarray(0, headerEnd));

      // The rebuilt page: a fresh packet first, the original page's tail after
      // it, and the file as it was from there.
      assert.ok(source && source.offset >= headerEnd, `point ${point}: rebuilt from an audio page`);
      assert.equal(rebuilt.flags & 1, 0, 'not a continuation');
      assert.deepEqual([...rebuilt.lacing], [...source.lacing.subarray(source.lacing.length - rebuilt.lacing.length)]);
      assert.deepEqual(slice.subarray(tailStart), bytes.subarray(source.offset + source.length));

      // Renumbered, the page counts the samples its packets put out after the
      // one the slice primes on. Kept, it is where the page was.
      const primedSamples = Math.round((index.startMs[point] / 1000) * SAMPLE_RATE);
      assert.equal(rebuilt.granule, renumberSlices ? source.granule - primedSamples : source.granule);
    }
  }
});

test('either FFmpeg starts a renumbered slice where a freshly encoded file starts', async () => {
  const bytes = buildStream({ blocks: BLOCKS }).bytes();
  const index = await buildOggVorbisIndex(blobOf(bytes), { renumberSlices: true });

  for (let point = 1; point < index.count; point += 1) {
    const slice = new Uint8Array(await index.sliceFrom(blobOf(bytes), point).arrayBuffer());
    const { beforeJuly2026, sinceJuly2026 } = ffmpegStarts(slice);
    // Just below zero, by the packet the decoder primes on and puts nothing out
    // for, so the first sample out is at zero: the anchor.
    assert.ok(sinceJuly2026 < 0);
    assert.equal(beforeJuly2026, sinceJuly2026, `point ${point}: both rules agree`);
  }

  // Left where it was in the track, the older rule starts the slice there, and
  // Chromium plays a start above zero as it is.
  const kept = await buildOggVorbisIndex(blobOf(bytes), { renumberSlices: false });
  const late = new Uint8Array(await kept.sliceFrom(blobOf(bytes), kept.count - 1).arrayBuffer());
  assert.ok(ffmpegStarts(late).beforeJuly2026 > 0);
});

test('a packet that runs onto the next page is not a point', async () => {
  // Packet 8 is long enough to span three pages of 4 segments.
  const lengths = BLOCKS.map((_, i) => (i === 8 ? 1500 : 60));
  const stream = buildStream({ blocks: BLOCKS, lengths, segmentsPerPage: 4 });
  const index = await buildOggVorbisIndex(blobOf(stream.bytes()));

  assert.ok(stream.audio[8].endPage > stream.audio[8].startPage, 'the test packet does span pages');
  assert.ok(index);
  assert.ok(!index.startMs.includes(msOf(stream.audio[8].end)), 'no point at the spanning packet');
  assert.deepEqual([...index.startMs.slice(1)], stream.pointEnds.map(msOf));
});

test('positions that disagree with the windows are not trusted', async () => {
  const stream = buildStream({ blocks: BLOCKS });
  const audioPage = stream.pages.findIndex((page, i) => i > 3 && page.granule > 0 && !(page.flags & 4));
  stream.pages[audioPage].granule += 64;
  assert.equal(await buildOggVorbisIndex(blobOf(stream.bytes())), null);
});

test('only a single Vorbis stream is indexed', async () => {
  const opus = buildStream({ blocks: BLOCKS });
  opus.pages[0].body = Uint8Array.from([...ascii('OpusHead'), 1, 2, 0, 0, 0x44, 0xac, 0, 0, 0, 0, 0]);
  opus.pages[0].lacing = Uint8Array.from([19]);
  assert.equal(await buildOggVorbisIndex(blobOf(opus.bytes())), null);

  const multiplexed = buildStream({ blocks: BLOCKS });
  multiplexed.pages[5].serial = 0x9999;
  assert.equal(await buildOggVorbisIndex(blobOf(multiplexed.bytes())), null);

  assert.equal(await buildOggVorbisIndex(blobOf(new Uint8Array(512).fill(7))), null);
});

test('a stream whose positions do not start at zero is still timed from zero', async () => {
  // Positions shifted up: playback still starts at zero, so the shift drops out.
  const later = buildStream({ blocks: BLOCKS, granuleOffset: 4096 });
  const laterIndex = await buildOggVorbisIndex(blobOf(later.bytes()), { renumberSlices: true });
  assert.deepEqual([...laterIndex.startMs.slice(1)], later.pointEnds.map(msOf));
  // A renumbered slice of it still counts from its own start.
  const slice = new Uint8Array(await laterIndex.sliceFrom(blobOf(later.bytes()), 3).arrayBuffer());
  assert.ok(ffmpegStarts(slice).beforeJuly2026 < 0);

  // Positions shifted down: the samples before zero are dropped, so every
  // point comes that much sooner.
  const trimmed = buildStream({ blocks: BLOCKS, granuleOffset: -300 });
  const trimmedIndex = await buildOggVorbisIndex(blobOf(trimmed.bytes()));
  assert.deepEqual([...trimmedIndex.startMs.slice(1)], trimmed.pointEnds.map((end) => msOf(end - 300)));
});

// --- the seeker -------------------------------------------------------------------
test('an Ogg Vorbis track seeks from the last point at or before the target', async () => {
  const stream = buildStream({ blocks: BLOCKS });
  const state = {
    audio: { src: '', playbackRate: 1, load() { this.playbackRate = 1; } },
    playbackSpeed: 1,
    audioAnchorMapMs: 0,
    audioAnchorSrc: '',
    fullAudioSliceUrl: null,
  };
  const seeker = await createTrackFrameSeeker({ state, blob: blobOf(stream.bytes()), filename: 'audio.ogg' });
  assert.ok(seeker);

  const target = seeker.index.startMs[4] + 1;
  assert.equal(seeker.seek(target), true);
  assert.equal(state.audioAnchorMapMs, seeker.index.startMs[4], 'priming is in the point\'s time, so no preroll');
  assert.equal(state.audio.src, state.audioAnchorSrc);

  // Before the first slice point, the whole file plays from its start.
  seeker.seek(seeker.index.startMs[1] - 1);
  assert.equal(state.audioAnchorMapMs, 0);
  seeker.dispose();
});
