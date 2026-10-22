// Exact packet positions for an Ogg Vorbis track, so a seek can start playback
// at a packet whose time is known to the sample.
//
// Chromium seeks Ogg by landing on a page and labelling the first sound it puts
// out with that page's start. A Vorbis decoder spends the first packet after a
// seek priming its window and outputs nothing for it, though, so playback runs
// that packet's length -- up to 23ms at 44.1kHz -- ahead of currentTime.
// Measured on a real track: +20-23ms at most positions, less where the blocks
// were short. A slice made of the headers plus the stream from a chosen packet
// primes exactly the same way, but here the packet is known, so the slice is
// anchored to the sample it really starts at. Pages are too coarse to start on
// (often ~0.2s apart), so the slice's first page is rebuilt to begin at the
// packet.
//
// Chromium also gets that page renumbered to count from the slice's own start,
// because its FFmpeg has changed its mind about where a stream begins. Since
// July 2026 FFmpeg starts every stream at zero whatever its first page says;
// before that it took the start from the first page's position, and Chromium
// keeps a start above zero as it is (the spec's "offsets into the media
// resource"). A slice that kept its original position had currentTime count
// from where it was cut -- 101s in for a seek to 101s -- in any Chromium still
// on the older FFmpeg, such as an Opera GX that had not updated, and the map
// ran at twice the position and straight off its end. Renumbered, the first
// packet ends at position zero, as in a freshly encoded file, and both read it
// the same way. Later pages keep their positions: Chromium counts samples on
// from the first page, and renumbering every page would mean building each
// slice from a header and a body part per page, which Chromium takes about
// 0.2ms a page over -- seconds, for an hour-long track, on every seek.
//
// Firefox reads Ogg with its own demuxer, which already counts a stream from
// its first page whatever that says -- and plays a jump in positions as
// silence, which is what a renumbered first page followed by the original
// ones is. Its slices keep the positions they had.

import { createChunkReader } from './blobReader.js';

const READS_OGG_WITH_FFMPEG = !/firefox|fxios/i.test(globalThis.navigator?.userAgent || '');

const FLAG_CONTINUED = 0x01;
const FLAG_EOS = 0x04;
const PAGE_HEADER_BYTES = 27;
const MAX_PAGE_BYTES = PAGE_HEADER_BYTES + 255 + (255 * 255);

// Ogg's CRC-32: polynomial 0x04c11db7, unreflected, zero initial value and no
// final xor. That makes it linear, which is what lets a page be rebuilt from a
// packet onwards without holding the page's bytes (see sliceFrom).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 0x80000000) ? ((value << 1) ^ 0x04c11db7) : (value << 1);
    }
    table[i] = value >>> 0;
  }
  return table;
})();
const crcByte = (crc, byte) => ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
// The CRC after `count` more zero bytes.
const crcZeros = (crc, count) => {
  let value = crc;
  for (let i = 0; i < count; i += 1) value = ((value << 8) ^ CRC_TABLE[value >>> 24]) >>> 0;
  return value;
};

class NotIndexable extends Error {}
const fail = () => { throw new NotIndexable(); };

/**
 * The block flag of each mode, read from the end of the setup header. Modes are
 * its last field and everything before them is variable-length, so like ffmpeg
 * (and liboggz) this walks back from the framing bit instead of decoding
 * codebooks it has no use for.
 */
const readModeBlockFlags = (setup) => {
  if (setup.length < 7 || setup[0] !== 5) return null;
  const totalBits = setup.length * 8;
  // Vorbis packs bits from the bottom of each byte up, so walking the stream
  // backwards visits each byte's bits from the top down.
  const bitFromEnd = (i) => (setup[setup.length - 1 - (i >> 3)] >> (7 - (i & 7))) & 1;
  const readBits = (at, count) => {
    let value = 0;
    for (let k = 0; k < count; k += 1) value = (value << 1) | bitFromEnd(at + k);
    return value;
  };

  let at = 0;
  while (totalBits - at > 97 && !bitFromEnd(at)) at += 1;
  if (totalBits - at <= 97) return null;
  const modesEnd = at + 1;

  // Each mode, read backwards: an 8-bit mapping (at most 63), 16-bit transform
  // and window types (both always 0), then the block flag. The count field
  // before the first mode says where they really start.
  let modeCount = 0;
  let confirmedCount = 0;
  at = modesEnd;
  while (totalBits - at >= 97) {
    if (readBits(at, 8) > 63 || readBits(at + 8, 16) || readBits(at + 24, 16)) break;
    at += 41;
    modeCount += 1;
    if (modeCount > 63) break;
    if (readBits(at, 6) + 1 === modeCount) confirmedCount = modeCount;
  }
  if (!confirmedCount) return null;

  const flags = new Array(confirmedCount);
  for (let i = confirmedCount - 1, mode = modesEnd; i >= 0; i -= 1, mode += 41) {
    flags[i] = bitFromEnd(mode + 40);
  }
  return flags;
};

const isOgg = (filename, blob) => (
  /\.og[ga]$/i.test(String(filename || '')) || /^(audio|application)\/ogg\b/i.test(blob?.type || '')
);

/**
 * Indexes an Ogg Vorbis Blob. Resolves null for anything else -- Opus, a chained
 * or multiplexed stream, a layout it cannot account for to the sample -- which
 * callers treat as "seek the way the browser does".
 *
 * Point 0 plays the whole file from its start. Every later point plays from an
 * audio packet, and `startMs[i]` is the time of the first sample that comes out.
 * `renumberSlices` says whether a slice's first page counts from the slice's
 * start (for FFmpeg) or keeps its place in the track (for Firefox).
 *
 * @returns {Promise<null | {
 *   format: 'ogg', count: number, startMs: Float64Array, durationMs: number,
 *   sampleRate: number, prerollPoints: number, sliceFrom: (blob: Blob, i: number) => Blob,
 * }>}
 */
const buildOggVorbisIndex = async (
  blob,
  { chunkBytes = 4 * 1024 * 1024, renumberSlices = READS_OGG_WITH_FFMPEG } = {},
) => {
  if (!blob || !(blob.size > PAGE_HEADER_BYTES)) return null;
  const reader = createChunkReader(blob, chunkBytes);
  const ensure = async (offset, length) => {
    if (!reader.has(offset, length)) await reader.load(offset, Math.max(length, MAX_PAGE_BYTES));
  };
  const u32 = (offset) => (
    (reader.byte(offset) | (reader.byte(offset + 1) << 8) | (reader.byte(offset + 2) << 16)) + (reader.byte(offset + 3) * 0x1000000)
  );

  // Per page.
  const pageBodyOffset = [];
  const pageBodyLength = [];
  const pageFlags = [];
  const pageGranule = [];
  const pageSequence = [];
  const pageLacingStart = [];
  const pageSegments = [];
  const pageBodyCrc = [];
  let lacing = new Uint8Array(4096);
  let lacingUsed = 0;
  let serial = null;

  // Per audio packet that completes on the page it starts on, the only kind a
  // slice can begin with (its rebuilt first page has to finish a packet).
  const pointPage = [];
  const pointSegment = [];
  const pointByte = [];
  const pointCrc = [];
  const pointEndSamples = [];

  // Vorbis stream state.
  let packetNumber = 0;
  let sampleRate = 0;
  const blockSizes = [0, 0];
  let modeFlags = null;
  let modeMask = 0;
  let previousBlock = null;
  let samples = 0;
  let granuleOffset = null;
  let lastGranule = 0;
  let audioStartOffset = -1;

  const completePacket = (packet, pageIndex) => {
    const number = packetNumber;
    packetNumber += 1;
    if (number === 0) {
      const id = packet.bytes;
      if (id.length < 30 || id[0] !== 1 || String.fromCharCode(...id.slice(1, 7)) !== 'vorbis') fail();
      sampleRate = (id[12] | (id[13] << 8) | (id[14] << 16)) + (id[15] * 0x1000000);
      blockSizes[0] = 1 << (id[28] & 0x0f);
      blockSizes[1] = 1 << (id[28] >> 4);
      if (!sampleRate || blockSizes[0] < 64 || blockSizes[1] < blockSizes[0]) fail();
      return null;
    }
    if (number === 1) {
      if (packet.bytes[0] !== 3) fail();
      return null;
    }
    if (number === 2) {
      modeFlags = readModeBlockFlags(packet.bytes);
      if (!modeFlags) fail();
      modeMask = ((1 << (Math.floor(Math.log2(Math.max(1, modeFlags.length - 1))) + 1)) - 1) << 1;
      return null;
    }

    if (packet.length === 0) return null;
    if (audioStartOffset < 0) {
      // The headers have to end a page for the slice to reuse them as they are.
      if (packet.startSegment !== 0) fail();
      audioStartOffset = pageBodyOffset[packet.startPage] - PAGE_HEADER_BYTES - pageSegments[packet.startPage];
    }
    const first = packet.first;
    if (first & 1) fail();
    const mode = modeFlags.length === 1 ? 0 : (first & modeMask) >> 1;
    if (mode >= modeFlags.length) fail();
    const block = blockSizes[modeFlags[mode]];
    // The first audio packet only primes the decoder; each later one returns
    // the overlap between its window and the one before.
    samples += previousBlock === null ? 0 : (previousBlock + block) / 4;
    const isFirstAudio = previousBlock === null;
    previousBlock = block;

    if (!isFirstAudio && packet.startPage === pageIndex) {
      pointPage.push(packet.startPage);
      pointSegment.push(packet.startSegment);
      pointByte.push(packet.firstByte);
      pointCrc.push(packet.startCrc);
      pointEndSamples.push(samples);
    }
    return samples;
  };

  let open = null;
  let offset = 0;
  try {
    while (offset + PAGE_HEADER_BYTES <= reader.size) {
      await ensure(offset, PAGE_HEADER_BYTES);
      if (reader.byte(offset) !== 0x4f || reader.byte(offset + 1) !== 0x67
        || reader.byte(offset + 2) !== 0x67 || reader.byte(offset + 3) !== 0x53) {
        // Junk after the last page ends the stream; junk before the first is
        // not something to guess about.
        if (pageFlags.length === 0) fail();
        break;
      }
      if (reader.byte(offset + 4) !== 0) fail();
      const flags = reader.byte(offset + 5);
      const granuleLow = u32(offset + 6);
      const granuleHigh = u32(offset + 10);
      const granule = granuleHigh === 0xffffffff && granuleLow === 0xffffffff ? -1 : (granuleHigh * 0x100000000) + granuleLow;
      const pageSerial = u32(offset + 14);
      const segments = reader.byte(offset + 26);
      await ensure(offset, PAGE_HEADER_BYTES + segments);
      let bodyLength = 0;
      for (let s = 0; s < segments; s += 1) bodyLength += reader.byte(offset + PAGE_HEADER_BYTES + s);
      const bodyOffset = offset + PAGE_HEADER_BYTES + segments;
      if (bodyOffset + bodyLength > reader.size) break;
      await ensure(offset, PAGE_HEADER_BYTES + segments + bodyLength);

      if (serial === null) serial = pageSerial;
      else if (pageSerial !== serial) fail();

      const pageIndex = pageFlags.length;
      pageBodyOffset.push(bodyOffset);
      pageBodyLength.push(bodyLength);
      pageFlags.push(flags);
      pageGranule.push(granule);
      pageSequence.push(u32(offset + 18));
      pageLacingStart.push(lacingUsed);
      pageSegments.push(segments);
      if (lacingUsed + segments > lacing.length) {
        const grown = new Uint8Array(lacing.length * 2 + segments);
        grown.set(lacing);
        lacing = grown;
      }

      let crc = 0;
      let at = bodyOffset;
      let lastSamples = null;
      for (let s = 0; s < segments; s += 1) {
        const size = reader.byte(offset + PAGE_HEADER_BYTES + s);
        lacing[lacingUsed + s] = size;
        if (!open) {
          if (s === 0 && (flags & FLAG_CONTINUED)) fail();
          open = {
            startPage: pageIndex,
            startSegment: s,
            firstByte: at,
            startCrc: crc,
            first: size > 0 ? reader.byte(at) : 0,
            length: 0,
            bytes: packetNumber < 3 ? [] : null,
          };
        } else if (s === 0 && !(flags & FLAG_CONTINUED)) {
          fail();
        }
        for (let i = 0; i < size; i += 1) {
          const byte = reader.byte(at + i);
          crc = crcByte(crc, byte);
          if (open.bytes) open.bytes.push(byte);
        }
        open.length += size;
        at += size;
        if (size < 255) {
          const ended = completePacket(open, pageIndex);
          if (ended !== null) lastSamples = ended;
          open = null;
        }
      }
      lacingUsed += segments;
      pageBodyCrc.push(crc);

      // Every page that finishes audio packets says where the stream is after
      // the last of them. The first fixes how the stream's positions relate to
      // the decoder's output; the rest have to agree to the sample, or the
      // anchors below would be guesses.
      if (lastSamples !== null) {
        if (granule < 0) fail();
        if (granuleOffset === null) granuleOffset = granule - lastSamples;
        else if (flags & FLAG_EOS) {
          // The last page may trim the final packet's padding.
          if (granule > lastSamples + granuleOffset) fail();
        } else if (granule - lastSamples !== granuleOffset) fail();
        lastGranule = granule;
      }
      offset = bodyOffset + bodyLength;
    }
  } catch (error) {
    if (error instanceof NotIndexable) return null;
    throw error;
  }
  if (granuleOffset === null || audioStartOffset < 0) return null;

  // A stream whose positions start above zero plays from zero all the same; one
  // that starts below has the samples before zero dropped.
  const timelineShift = Math.min(granuleOffset, 0);
  const origin = Math.max(granuleOffset, 0);
  const toMs = (sampleCount) => (sampleCount / sampleRate) * 1000;

  const points = [0];
  const startMs = [0];
  for (let p = 0; p < pointPage.length; p += 1) {
    const page = pointPage[p];
    if (pageFlags[page] & FLAG_EOS) continue;
    // Renumbered, the slice's first page sits at the samples its later packets
    // put out. With none after this one that is zero, which FFmpeg takes for a
    // broken file and drops every timestamp on the page.
    if (pageGranule[page] - granuleOffset - pointEndSamples[p] < 1) continue;
    const ms = toMs(pointEndSamples[p] + timelineShift);
    if (ms <= startMs[startMs.length - 1]) continue;
    points.push(p);
    startMs.push(ms);
  }

  const prefix = blob.slice(0, audioStartOffset);
  const type = blob.type || 'audio/ogg';

  const sliceFrom = (source, i) => {
    if (i <= 0) return source;
    const p = points[i];
    const page = pointPage[p];
    const firstSegment = pointSegment[p];
    const segments = pageSegments[page] - firstSegment;
    const header = new Uint8Array(PAGE_HEADER_BYTES + segments);
    const view = new DataView(header.buffer);
    // Renumbered, it counts from the end of the packet the slice primes on: the
    // sample startMs[i] describes.
    const granule = renumberSlices ? pageGranule[page] - granuleOffset - pointEndSamples[p] : pageGranule[page];
    header.set([0x4f, 0x67, 0x67, 0x53, 0, pageFlags[page] & FLAG_EOS]);
    view.setUint32(6, granule % 0x100000000, true);
    view.setUint32(10, Math.floor(granule / 0x100000000), true);
    view.setUint32(14, serial, true);
    view.setUint32(18, pageSequence[page], true);
    header[26] = segments;
    header.set(lacing.subarray(pageLacingStart[page] + firstSegment, pageLacingStart[page] + pageSegments[page]), PAGE_HEADER_BYTES);

    // The page's CRC without its bytes: with a linear CRC, the tail of the
    // body is the whole body less its head shifted past the tail.
    const tailLength = (pageBodyOffset[page] + pageBodyLength[page]) - pointByte[p];
    const tailCrc = (pageBodyCrc[page] ^ crcZeros(pointCrc[p], tailLength)) >>> 0;
    let headerCrc = 0;
    for (const byte of header) headerCrc = crcByte(headerCrc, byte);
    view.setUint32(22, (crcZeros(headerCrc, tailLength) ^ tailCrc) >>> 0, true);

    return new Blob([prefix, header, source.slice(pointByte[p])], { type });
  };

  return {
    format: 'ogg',
    count: startMs.length,
    startMs: Float64Array.from(startMs),
    durationMs: toMs(lastGranule - origin),
    sampleRate,
    // Priming is already in each point's time, so a slice can start right at
    // the point before the target.
    prerollPoints: 0,
    sliceFrom,
  };
};

export { buildOggVorbisIndex, isOgg, readModeBlockFlags };
