// Exact frame positions for an MP3, so a seek can land on a frame boundary.
//
// Browsers seek a VBR MP3 from its coarse 100-entry Xing table -- or, without
// one, by assuming a constant bitrate -- and then report the time they were
// asked for rather than the time they reached. Measured on a real VBR track,
// seeks landed up to 0.7s from what currentTime claimed, depending on where in
// the track the target was. A constant-bitrate track is not safe either:
// Chromium seeking a 48kHz CBR track played exactly its encoder delay (23ms)
// ahead of currentTime across the first two thirds of it, and on time after.
// Everything here follows currentTime, so the map was drawn that far from the
// music. Playing on from a frame boundary is exact, which is what the index
// makes possible (see audio/frameSeeker.js).

import { createChunkReader } from './blobReader.js';

const BITRATES_KBPS = {
  // [MPEG-1 layer I, II, III], then [MPEG-2/2.5 layer I, II and III]
  v1: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  v2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// ffmpeg, which Chromium decodes MP3 with, trims the LAME tag's encoder delay
// plus the decoder's own 528-sample delay (and one more sample) from the start.
// Frame times are reported on that trimmed timeline, the one currentTime uses.
const DECODER_DELAY_SAMPLES = 529;

// Frames loaded ahead of a seek target. An MP3 frame can draw on up to 511
// bytes of the frames before it, so the first frames of a slice may decode as
// silence; starting a little early keeps that ahead of the target.
const SEEK_PREROLL_FRAMES = 2;

// Maximum bytes scanned when searching for initial sync or resynchronising
// after damage/trailing tags, and lookahead needed to validate two consecutive
// MPEG frames in one buffer window (max valid MPEG frame is < 2890 bytes).
const MAX_SYNC_SCAN_BYTES = 64 * 1024;
const SYNC_PAIR_LOOKAHEAD_BYTES = 4096;

/**
 * Reads the four header bytes of an MPEG audio frame. Returns null for anything
 * that is not a usable header, including free-format bitrates, whose frame
 * length cannot be known without decoding.
 */
const parseFrameHeader = (b0, b1, b2, b3) => {
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
  const layerBits = (b1 >> 1) & 3; // 3: layer I, 2: layer II, 1: layer III
  if (version === 1 || layerBits === 0) return null;
  const layer = 4 - layerBits;
  const bitrateIndex = b2 >> 4;
  const sampleRateIndex = (b2 >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const isV1 = version === 3;
  const bitrate = BITRATES_KBPS[isV1 ? 'v1' : 'v2'][layer - 1][bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  const padding = (b2 >> 1) & 1;
  const mono = (b3 >> 6) === 3;

  let frameLength;
  let samplesPerFrame;
  if (layer === 1) {
    frameLength = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
    samplesPerFrame = 384;
  } else if (layer === 2 || isV1) {
    frameLength = Math.floor((144 * bitrate) / sampleRate) + padding;
    samplesPerFrame = 1152;
  } else {
    frameLength = Math.floor((72 * bitrate) / sampleRate) + padding;
    samplesPerFrame = 576;
  }

  return {
    version,
    layer,
    bitrate,
    sampleRate,
    frameLength,
    samplesPerFrame,
    hasCrc: (b1 & 1) === 0,
    // Where a Xing/Info tag would start, after the layer III side info.
    xingOffset: 4 + ((b1 & 1) === 0 ? 2 : 0) + (isV1 ? (mono ? 17 : 32) : (mono ? 9 : 17)),
  };
};

const sameStream = (a, b) => a.version === b.version && a.layer === b.layer && a.sampleRate === b.sampleRate;

const readHeaderAt = async (reader, offset) => {
  if (offset + 4 > reader.size) return null;
  if (!reader.has(offset, 4)) await reader.load(offset, 4);
  return parseFrameHeader(reader.byte(offset), reader.byte(offset + 1), reader.byte(offset + 2), reader.byte(offset + 3));
};

const readAscii = (reader, offset, length) => {
  let text = '';
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(reader.byte(offset + i));
  return text;
};

/**
 * The encoder delay the LAME tag records, or null when the frame is not a
 * Xing/Info frame. Layout per the LAME tag spec: after "Xing"/"Info" come the
 * flags and whichever optional fields they announce, then a 9-byte encoder
 * string and 12 bytes of LAME fields before the packed delay/padding.
 */
const readXingFrame = async (reader, offset, header) => {
  const frameEnd = offset + header.frameLength;
  if (frameEnd > reader.size) return null;
  if (!reader.has(offset, header.frameLength)) await reader.load(offset, header.frameLength);
  const tagOffset = offset + header.xingOffset;
  if (tagOffset + 8 > frameEnd) {
    return offset + 40 <= frameEnd && readAscii(reader, offset + 36, 4) === 'VBRI'
      ? { hasLameTag: false, encoderDelay: 0 }
      : null;
  }
  const tag = readAscii(reader, tagOffset, 4);
  if (tag !== 'Xing' && tag !== 'Info') {
    return offset + 40 <= frameEnd && readAscii(reader, offset + 36, 4) === 'VBRI'
      ? { hasLameTag: false, encoderDelay: 0 }
      : null;
  }
  const flags = reader.byte(tagOffset + 7);
  let cursor = tagOffset + 8;
  if (flags & 1) cursor += 4; // frame count
  if (flags & 2) cursor += 4; // byte count
  if (flags & 4) cursor += 100; // TOC
  if (flags & 8) cursor += 4; // quality
  if (cursor + 24 > frameEnd) {
    return { hasLameTag: false, encoderDelay: 0 };
  }
  const encoder = readAscii(reader, cursor, 4);
  if (!/^(LAME|Lavf|Lavc)$/.test(encoder)) {
    return { hasLameTag: false, encoderDelay: 0 };
  }
  const packed = (reader.byte(cursor + 21) << 16) | (reader.byte(cursor + 22) << 8) | reader.byte(cursor + 23);
  return { hasLameTag: true, encoderDelay: packed >> 12 };
};

/**
 * Scans up to `maxScanBytes` from `startOffset` for two consecutive valid MPEG
 * frames belonging to the same stream (matching `requiredStream` when set).
 * Scans synchronously within each loaded chunk to avoid per-byte async waits
 * and backward chunk thrashing on chunk boundaries.
 */
const scanForSyncedFrame = async (reader, startOffset, maxScanBytes, requiredStream = null) => {
  const limit = Math.min(reader.size - 4, startOffset + maxScanBytes - 1);
  let probe = startOffset;
  while (probe <= limit) {
    if (!reader.has(probe, 4)) {
      await reader.load(probe, Math.min(reader.size - probe, SYNC_PAIR_LOOKAHEAD_BYTES * 2));
    }
    const buf = reader.bytes;
    const base = reader.start;
    const chunkEnd = Math.min(limit, reader.end - 4);
    for (; probe <= chunkEnd; probe += 1) {
      const idx = probe - base;
      if (buf[idx] !== 0xff || (buf[idx + 1] & 0xe0) !== 0xe0) continue;
      const candidate = parseFrameHeader(buf[idx], buf[idx + 1], buf[idx + 2], buf[idx + 3]);
      if (!candidate) continue;
      if (requiredStream && !sameStream(candidate, requiredStream)) continue;
      const nextOffset = probe + candidate.frameLength;
      if (nextOffset + 4 > reader.size) continue;
      let after;
      if (reader.has(nextOffset, 4)) {
        const nextIdx = nextOffset - base;
        after = parseFrameHeader(buf[nextIdx], buf[nextIdx + 1], buf[nextIdx + 2], buf[nextIdx + 3]);
      } else {
        // Load starting at `probe` with enough lookahead to include `nextOffset + 4`
        // so a failed probe does not discard the bytes immediately after `probe`.
        await reader.load(probe, candidate.frameLength + 4);
        after = reader.has(nextOffset, 4)
          ? parseFrameHeader(
            reader.byte(nextOffset),
            reader.byte(nextOffset + 1),
            reader.byte(nextOffset + 2),
            reader.byte(nextOffset + 3),
          )
          : null;
        if (after && sameStream(candidate, after)) {
          return { offset: probe, header: candidate };
        }
        probe += 1;
        break;
      }
      if (after && sameStream(candidate, after)) {
        return { offset: probe, header: candidate };
      }
    }
  }
  return null;
};

/**
 * Indexes every audio frame of an MP3 Blob. Resolves null for anything that is
 * not an MPEG audio stream it can follow, which callers treat as "seek the way
 * the browser does".
 *
 * @returns {Promise<null | {
 *   count: number, offsets: Float64Array, startMs: Float64Array,
 *   durationMs: number, sampleRate: number, isVbr: boolean,
 * }>}
 */
const buildMp3FrameIndex = async (blob, { chunkBytes = 4 * 1024 * 1024 } = {}) => {
  if (!blob || !(blob.size > 0)) return null;
  const reader = createChunkReader(blob, chunkBytes);
  await reader.load(0, 10);

  let offset = 0;
  if (reader.size >= 10 && readAscii(reader, 0, 3) === 'ID3') {
    const size = ((reader.byte(6) & 0x7f) << 21) | ((reader.byte(7) & 0x7f) << 14)
      | ((reader.byte(8) & 0x7f) << 7) | (reader.byte(9) & 0x7f);
    offset = 10 + size + ((reader.byte(5) & 0x10) ? 10 : 0);
  }

  // The first frame is only trusted when the next one follows where it says it
  // ends; a stray 0xFFE in tag padding would otherwise start the index there.
  const synced = await scanForSyncedFrame(reader, offset, MAX_SYNC_SCAN_BYTES);
  if (!synced) return null;
  offset = synced.offset;
  const first = synced.header;

  let startSkip = 0;
  const xing = first.layer === 3 ? await readXingFrame(reader, offset, first) : null;
  if (xing) {
    // The Xing/Info frame carries no audio; decoders drop it. ffmpeg trims
    // the decoder delay whenever a LAME tag is present, even a zero one.
    startSkip = xing.hasLameTag ? xing.encoderDelay + DECODER_DELAY_SAMPLES : 0;
    offset += first.frameLength;
  }

  let capacity = 4096;
  let offsets = new Float64Array(capacity);
  let samples = new Float64Array(capacity);
  let count = 0;
  let totalSamples = 0;
  // Variable bitrate is what breaks the browser's seeking; an "Info" tag marks
  // a constant-bitrate file, so the tag alone says nothing either way.
  let firstBitrate = 0;
  let isVbr = false;

  // Synchronous while the header is inside the loaded chunk: awaiting every
  // frame of a marathon's ~140k would cost far more than the parsing.
  const headerIfLoaded = (at) => (reader.has(at, 4)
    ? parseFrameHeader(reader.byte(at), reader.byte(at + 1), reader.byte(at + 2), reader.byte(at + 3))
    : undefined);

  while (offset + 4 <= reader.size) {
    let header = headerIfLoaded(offset);
    if (header === undefined) header = await readHeaderAt(reader, offset);
    if (!header || !sameStream(header, first) || offset + header.frameLength > reader.size) {
      // Damage or trailing tags. Resynchronise on the next run of two frames
      // within a bounded window; give up if none appears.
      const resynced = await scanForSyncedFrame(reader, offset + 1, MAX_SYNC_SCAN_BYTES, first);
      if (!resynced) break;
      offset = resynced.offset;
      continue;
    }

    if (count === capacity) {
      capacity *= 2;
      const grownOffsets = new Float64Array(capacity);
      grownOffsets.set(offsets);
      offsets = grownOffsets;
      const grownSamples = new Float64Array(capacity);
      grownSamples.set(samples);
      samples = grownSamples;
    }
    offsets[count] = offset;
    samples[count] = totalSamples;
    count += 1;
    totalSamples += header.samplesPerFrame;
    if (firstBitrate === 0) firstBitrate = header.bitrate;
    else if (header.bitrate !== firstBitrate) isVbr = true;
    offset += header.frameLength;
  }

  if (count === 0) return null;

  const sampleRate = first.sampleRate;
  const durationMs = ((totalSamples - startSkip) / sampleRate) * 1000;
  if (!(durationMs > 0)) return null;

  const startMs = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    startMs[i] = ((samples[i] - startSkip) / sampleRate) * 1000;
  }

  const frameOffsets = offsets.subarray(0, count);
  return {
    format: 'mp3',
    count,
    offsets: frameOffsets,
    startMs,
    durationMs,
    sampleRate,
    isVbr,
    prerollPoints: SEEK_PREROLL_FRAMES,
    // Plays from frame i: just the stream from that frame's first byte, with no
    // tag frame in front for the decoder to trim a delay by.
    sliceFrom: (source, i) => source.slice(frameOffsets[i], source.size, source.type || 'audio/mpeg'),
  };
};

const isMp3 = (filename, blob) => (
  /\.mp3$/i.test(String(filename || '')) || /^audio\/(mpeg|mp3)$/i.test(blob?.type || '')
);

export {
  DECODER_DELAY_SAMPLES,
  SEEK_PREROLL_FRAMES,
  buildMp3FrameIndex,
  isMp3,
  parseFrameHeader,
};
