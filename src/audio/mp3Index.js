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
  const tagOffset = offset + header.xingOffset;
  if (!reader.has(tagOffset, 160)) await reader.load(offset, header.xingOffset + 160);
  const tag = readAscii(reader, tagOffset, 4);
  if (tag !== 'Xing' && tag !== 'Info') {
    return readAscii(reader, offset + 36, 4) === 'VBRI' ? { hasLameTag: false, encoderDelay: 0 } : null;
  }
  const flags = reader.byte(tagOffset + 7);
  let cursor = tagOffset + 8;
  if (flags & 1) cursor += 4; // frame count
  if (flags & 2) cursor += 4; // byte count
  if (flags & 4) cursor += 100; // TOC
  if (flags & 8) cursor += 4; // quality
  const encoder = readAscii(reader, cursor, 4);
  if (!/^(LAME|Lavf|Lavc)$/.test(encoder) || !reader.has(cursor, 24)) {
    return { hasLameTag: false, encoderDelay: 0 };
  }
  const packed = (reader.byte(cursor + 21) << 16) | (reader.byte(cursor + 22) << 8) | reader.byte(cursor + 23);
  return { hasLameTag: true, encoderDelay: packed >> 12 };
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
  if (readAscii(reader, 0, 3) === 'ID3') {
    const size = ((reader.byte(6) & 0x7f) << 21) | ((reader.byte(7) & 0x7f) << 14)
      | ((reader.byte(8) & 0x7f) << 7) | (reader.byte(9) & 0x7f);
    offset = 10 + size + ((reader.byte(5) & 0x10) ? 10 : 0);
  }

  // The first frame is only trusted when the next one follows where it says it
  // ends; a stray 0xFFE in tag padding would otherwise start the index there.
  let first = null;
  for (let scanned = 0; offset + 4 <= reader.size && scanned < 64 * 1024; offset += 1, scanned += 1) {
    const header = await readHeaderAt(reader, offset);
    if (!header) continue;
    const next = await readHeaderAt(reader, offset + header.frameLength);
    if (next && sameStream(header, next)) {
      first = header;
      break;
    }
  }
  if (!first) return null;

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
      // Damage or trailing tags. Resynchronise on the next run of two frames;
      // give up at the end of the data.
      let found = -1;
      for (let probe = offset + 1; probe + 4 <= reader.size; probe += 1) {
        const candidate = await readHeaderAt(reader, probe);
        if (!candidate || !sameStream(candidate, first)) continue;
        const after = await readHeaderAt(reader, probe + candidate.frameLength);
        if (after && sameStream(after, first)) {
          found = probe;
          break;
        }
      }
      if (found < 0) break;
      offset = found;
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
    durationMs: ((totalSamples - startSkip) / sampleRate) * 1000,
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
