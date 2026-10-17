import { normalizePath, getPathBaseName } from './cache.js';

// Sized for marathon maps. A 60-minute beatmap's audio.mp3 is ~60MB at 128kbps
// and ~90MB at 192kbps, so the old 48MB entry ceiling rejected the audio track
// outright and full audio could never load for them.
// INVARIANT: FULL_AUDIO_CACHE_MAX_BYTES (cache.js) must be >= this value.
// When it was smaller, extraction succeeded but the cache write failed, the
// worker reported failure, and the popup silently re-downloaded the entire
// archive a second time before hitting the same wall.
const MAX_ARCHIVE_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_AUDIO_ENTRY_BYTES = 150 * 1024 * 1024;
const MAX_ZIP_ENTRY_INFLATE_RATIO = 80;
const MAX_ZIP_ENTRIES = 6000;

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

const CP437_HIGH_CHARS = [
  '\u00c7', '\u00fc', '\u00e9', '\u00e2', '\u00e4', '\u00e0', '\u00e5', '\u00e7',
  '\u00ea', '\u00eb', '\u00e8', '\u00ef', '\u00ee', '\u00ec', '\u00c4', '\u00c5',
  '\u00c9', '\u00e6', '\u00c6', '\u00f4', '\u00f6', '\u00f2', '\u00fb', '\u00f9',
  '\u00ff', '\u00d6', '\u00dc', '\u00a2', '\u00a3', '\u00a5', '\u20a7', '\u0192',
  '\u00e1', '\u00ed', '\u00f3', '\u00fa', '\u00f1', '\u00d1', '\u00aa', '\u00ba',
  '\u00bf', '\u2310', '\u00ac', '\u00bd', '\u00bc', '\u00a1', '\u00ab', '\u00bb',
  '\u2591', '\u2592', '\u2593', '\u2502', '\u2524', '\u2561', '\u2562', '\u2556',
  '\u2555', '\u2563', '\u2551', '\u2557', '\u255d', '\u255c', '\u255b', '\u2510',
  '\u2514', '\u2534', '\u252c', '\u251c', '\u2500', '\u253c', '\u255e', '\u255f',
  '\u255a', '\u2554', '\u2569', '\u2566', '\u2560', '\u2550', '\u256c', '\u2567',
  '\u2568', '\u2564', '\u2565', '\u2559', '\u2558', '\u2552', '\u2553', '\u256b',
  '\u256a', '\u2518', '\u250c', '\u2588', '\u2584', '\u258c', '\u2590', '\u2580',
  '\u03b1', '\u00df', '\u0393', '\u03c0', '\u03a3', '\u03c3', '\u00b5', '\u03c4',
  '\u03a6', '\u0398', '\u03a9', '\u03b4', '\u221e', '\u03c6', '\u03b5', '\u2229',
  '\u2261', '\u00b1', '\u2265', '\u2264', '\u2320', '\u2321', '\u00f7', '\u2248',
  '\u00b0', '\u2219', '\u00b7', '\u221a', '\u207f', '\u00b2', '\u25a0', '\u00a0',
];

const decodeCp437 = (bytes) => Array.from(bytes, (value) => (
  value < 0x80 ? String.fromCharCode(value) : CP437_HIGH_CHARS[value - 0x80]
)).join('');

const decodeZipName = (nameBytes, isUtf8) => {
  if (!(nameBytes instanceof Uint8Array)) {
    return '';
  }

  if (!isUtf8) {
    return decodeCp437(nameBytes);
  }

  // Non-fatal, so malformed bytes become U+FFFD rather than an exception.
  return new TextDecoder('utf-8', { fatal: false }).decode(nameBytes);
};

const findZipEocdOffset = (bytes) => {
  const minimumLength = 22;
  if (!bytes || bytes.length < minimumLength) {
    return -1;
  }

  const scanStart = Math.max(0, bytes.length - (0xFFFF + minimumLength));
  let firstSignatureOffset = -1;

  for (let offset = bytes.length - minimumLength; offset >= scanStart; offset -= 1) {
    if (
      bytes[offset] !== 0x50
      || bytes[offset + 1] !== 0x4b
      || bytes[offset + 2] !== 0x05
      || bytes[offset + 3] !== 0x06
    ) {
      continue;
    }

    if (firstSignatureOffset === -1) {
      firstSignatureOffset = offset;
    }

    // The signature can also occur by chance inside compressed data. A real
    // end-of-central-directory record's comment length accounts for exactly the
    // bytes that follow it, so prefer a match that checks out.
    const commentLength = bytes[offset + 20] | (bytes[offset + 21] << 8);
    if (offset + minimumLength + commentLength === bytes.length) {
      return offset;
    }
  }

  // Fall back to the first signature so archives with trailing padding (which
  // used to work) keep working.
  return firstSignatureOffset;
};

const parseZipEntries = (archiveBytes) => {
  if (!(archiveBytes instanceof Uint8Array)) {
    throw new Error('Invalid beatmap archive payload.');
  }

  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  const eocdOffset = findZipEocdOffset(archiveBytes);
  if (eocdOffset < 0) {
    throw new Error('Beatmap archive is not a readable ZIP file.');
  }

  if (view.getUint32(eocdOffset, true) !== ZIP_EOCD_SIGNATURE) {
    throw new Error('ZIP footer signature mismatch.');
  }

  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  if (centralDirectorySize === 0xFFFFFFFF || centralDirectoryOffset === 0xFFFFFFFF) {
    throw new Error('ZIP64 beatmap archives are not supported.');
  }
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (
    centralDirectoryOffset < 0
    || centralDirectoryOffset >= archiveBytes.length
    || centralDirectoryEnd > archiveBytes.length
  ) {
    throw new Error('ZIP central directory is out of bounds.');
  }

  const entries = [];
  let cursor = centralDirectoryOffset;

  while (cursor < centralDirectoryEnd) {
    if (entries.length >= MAX_ZIP_ENTRIES) {
      throw new Error('ZIP contains too many entries.');
    }
    if (cursor + 46 > centralDirectoryEnd) {
      throw new Error('ZIP central directory entry is truncated.');
    }
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_SIGNATURE) {
      break;
    }

    const flags = view.getUint16(cursor + 8, true);
    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    if (
      compressedSize === 0xFFFFFFFF
      || uncompressedSize === 0xFFFFFFFF
      || localHeaderOffset === 0xFFFFFFFF
    ) {
      throw new Error('ZIP64 beatmap archives are not supported.');
    }

    const nameStart = cursor + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > archiveBytes.length) {
      break;
    }

    const nameBytes = archiveBytes.subarray(nameStart, nameEnd);
    const name = decodeZipName(nameBytes, (flags & 0x0800) !== 0);

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    const nextCursor = cursor + 46 + fileNameLength + extraLength + commentLength;
    if (nextCursor <= cursor || nextCursor > centralDirectoryEnd) {
      throw new Error('ZIP central directory entry bounds are invalid.');
    }
    cursor = nextCursor;
  }

  return entries;
};

const INFLATE_LIMIT_ERROR_NAME = 'ZipInflateLimitError';

/**
 * Inflates into a buffer of exactly `maxBytes`, cancelling the stream the moment
 * the output would overflow it.
 *
 * The sizes in the central directory come from whichever mirror served the
 * archive, so they cannot bound the work on their own: an entry declaring 3MB
 * can inflate to gigabytes. Buffering the whole output and comparing sizes
 * afterwards let a single archive exhaust the worker's heap before the check
 * ever ran.
 *
 * `maxBytes` is required, and allocated up front: callers pass the entry's
 * declared size, which also spares the copy a growing buffer would need.
 */
const inflateWithFormat = async (compressedBytes, format, maxBytes) => {
  if (!('DecompressionStream' in globalThis)) {
    throw new Error('Browser does not support ZIP inflation for full audio.');
  }
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error('ZIP inflation needs the expected output size.');
  }
  const limit = Math.min(Math.floor(maxBytes), MAX_ZIP_AUDIO_ENTRY_BYTES);
  const reader = new Blob([compressedBytes]).stream()
    .pipeThrough(new DecompressionStream(format))
    .getReader();
  const output = new Uint8Array(limit);
  let written = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (written + value.byteLength > limit) {
        await reader.cancel();
        throw Object.assign(
          new Error(`Inflated ZIP entry exceeds its declared size (${limit} bytes).`),
          { name: INFLATE_LIMIT_ERROR_NAME },
        );
      }
      output.set(value, written);
      written += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return written === limit ? output : output.subarray(0, written);
};

const inflateDeflateRaw = async (compressedBytes, maxBytes) => {
  try {
    return await inflateWithFormat(compressedBytes, 'deflate-raw', maxBytes);
  } catch (error) {
    // Overflowing is a verdict on the entry, not a hint that it might be
    // zlib-wrapped: retrying would inflate the same payload a second time and
    // replace this error with a misleading header-check failure.
    if (error?.name === INFLATE_LIMIT_ERROR_NAME) {
      throw error;
    }
    return inflateWithFormat(compressedBytes, 'deflate', maxBytes);
  }
};

const mergeUint8Chunks = (chunks, totalBytes) => {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
};

const createTimeoutError = () => Object.assign(new Error('timeout'), { name: 'AbortError' });

const withTimeout = async (promise, timeoutMs) => {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(createTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
};

const readStreamChunkWithDeadline = async (reader, remainingMs) => {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    await reader.cancel();
    throw createTimeoutError();
  }
  try {
    return await withTimeout(reader.read(), remainingMs);
  } catch (err) {
    if (err?.name === 'AbortError') {
      await reader.cancel();
    }
    throw err;
  }
};

const emitArchiveBodyProgress = (onProgress, loaded, totalGuess) => {
  if (typeof onProgress !== 'function' || !(Number.isFinite(loaded) && loaded >= 0)) {
    return;
  }
  const total = Number.isFinite(totalGuess) && totalGuess > 0 ? Math.floor(totalGuess) : null;
  onProgress({ loaded: Math.floor(loaded), total });
};

/**
 * Collects a body into one buffer. When the server announces its size the
 * buffer is allocated once and written in place; holding the chunks and copying
 * them into a second buffer at the end needed twice the archive's size at the
 * peak, which for a 200MB download is a lot to ask of a service worker.
 */
const createByteSink = (expectedBytes) => {
  let buffer = expectedBytes > 0 ? new Uint8Array(expectedBytes) : null;
  let chunks = buffer ? null : [];
  let length = 0;

  return {
    get length() {
      return length;
    },
    push(chunk) {
      if (buffer && length + chunk.byteLength > buffer.byteLength) {
        // More than announced -- a compressed transfer reports its encoded
        // size -- so carry on as chunks from here.
        chunks = [buffer.subarray(0, length)];
        buffer = null;
      }
      if (buffer) {
        buffer.set(chunk, length);
      } else {
        chunks.push(chunk);
      }
      length += chunk.byteLength;
    },
    toArrayBuffer() {
      if (!buffer) {
        return mergeUint8Chunks(chunks, length);
      }
      return length === buffer.byteLength ? buffer.buffer : buffer.slice(0, length).buffer;
    },
  };
};

const startsWithZipSignature = (bytes) => bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;

/**
 * Reads a response body into one ArrayBuffer, under a size cap and a deadline
 * for the whole body.
 *
 * With `requireZipSignature`, the read stops as soon as the first two bytes
 * show the body is not a ZIP -- a mirror answering 200 with an HTML error page
 * is caught there rather than downloaded in full. `zipProbeMs` additionally
 * limits how long those first bytes may take, for callers with another
 * provider to move on to.
 */
const readResponseArrayBufferLimited = async (response, {
  maxBytes = MAX_ARCHIVE_DOWNLOAD_BYTES,
  bodyBudgetMs = null,
  requireZipSignature = false,
  zipProbeMs = null,
  onProgress,
} = {}) => {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : MAX_ARCHIVE_DOWNLOAD_BYTES;
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > cap) {
    throw new Error(`archive too large (${contentLength} bytes)`);
  }
  const totalHint = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;

  const startedAtMs = performance.now();
  const bodyDeadline = Number.isFinite(bodyBudgetMs) && bodyBudgetMs > 0 ? startedAtMs + bodyBudgetMs : null;
  const probeDeadline = Number.isFinite(zipProbeMs) && zipProbeMs > 0 ? startedAtMs + zipProbeMs : null;

  if (!response.body) {
    const pending = response.arrayBuffer();
    const fallbackBuffer = bodyDeadline === null
      ? await pending
      : await withTimeout(pending, bodyDeadline - performance.now());
    if (fallbackBuffer.byteLength > cap) {
      throw new Error(`archive exceeds limit (${fallbackBuffer.byteLength} bytes)`);
    }
    emitArchiveBodyProgress(onProgress, fallbackBuffer.byteLength, totalHint ?? fallbackBuffer.byteLength);
    return fallbackBuffer;
  }

  const reader = response.body.getReader();
  const sink = createByteSink(totalHint ?? 0);
  const head = [];
  let probing = requireZipSignature || probeDeadline !== null;

  try {
    while (true) {
      const now = performance.now();
      const remainingMs = Math.min(
        bodyDeadline === null ? Number.POSITIVE_INFINITY : bodyDeadline - now,
        probing && probeDeadline !== null ? probeDeadline - now : Number.POSITIVE_INFINITY,
      );
      const { done, value } = remainingMs === Number.POSITIVE_INFINITY
        ? await reader.read()
        : await readStreamChunkWithDeadline(reader, remainingMs);
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array) || value.byteLength <= 0) {
        continue;
      }

      if (sink.length + value.byteLength > cap) {
        await reader.cancel();
        throw new Error(`archive exceeds limit (${sink.length + value.byteLength} bytes)`);
      }
      sink.push(value);
      emitArchiveBodyProgress(onProgress, sink.length, totalHint);

      if (probing) {
        for (let i = 0; i < value.byteLength && head.length < 2; i += 1) {
          head.push(value[i]);
        }
        if (head.length >= 2) {
          if (!startsWithZipSignature(head)) {
            // The caller sees the non-ZIP header and reports it as such.
            await reader.cancel();
            break;
          }
          probing = false;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  emitArchiveBodyProgress(onProgress, sink.length, totalHint ?? sink.length);
  return sink.toArrayBuffer();
};

const responseLooksLikeBeatmapArchiveDownload = (response) => {
  const disposition = (response.headers.get('content-disposition') || '').toLowerCase();
  if (disposition.includes('.osz')) {
    return true;
  }
  const rawType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return rawType === 'application/zip' || rawType === 'application/x-zip-compressed';
};

const extractZipEntry = async (archiveBytes, entry) => {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  const localOffset = entry.localHeaderOffset;
  const compressedSize = Number(entry.compressedSize);
  const uncompressedSize = Number(entry.uncompressedSize);

  if (
    !Number.isFinite(compressedSize)
    || !Number.isFinite(uncompressedSize)
    || compressedSize <= 0
    || uncompressedSize <= 0
    || compressedSize > MAX_ARCHIVE_DOWNLOAD_BYTES
    || uncompressedSize > MAX_ZIP_AUDIO_ENTRY_BYTES
  ) {
    throw new Error('ZIP entry size is invalid or exceeds security limits.');
  }

  if (
    compressedSize > 0
    && uncompressedSize > (compressedSize * MAX_ZIP_ENTRY_INFLATE_RATIO)
  ) {
    throw new Error('ZIP entry inflate ratio is suspiciously high.');
  }

  if (
    !Number.isFinite(localOffset)
    || localOffset < 0
    || localOffset + 30 > archiveBytes.length
    || view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE
  ) {
    throw new Error('ZIP local file header is invalid.');
  }

  const localFileNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + localFileNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;

  if (dataStart < 0 || dataEnd > archiveBytes.length || dataEnd <= dataStart) {
    throw new Error('ZIP entry data is out of bounds.');
  }

  const compressed = archiveBytes.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) {
    if (compressed.byteLength !== uncompressedSize) {
      throw new Error('Stored ZIP entry size mismatch.');
    }
    return new Uint8Array(compressed);
  }
  if (entry.compressionMethod === 8) {
    // The declared size was already held to MAX_ZIP_AUDIO_ENTRY_BYTES above, so
    // bounding the inflate by it bounds it by the global ceiling too.
    const inflated = await inflateDeflateRaw(compressed, uncompressedSize);
    if (inflated.byteLength !== uncompressedSize) {
      throw new Error('Inflated ZIP entry size mismatch.');
    }
    return inflated;
  }

  throw new Error(`ZIP compression method ${entry.compressionMethod} is unsupported.`);
};

const AUDIO_ENTRY_EXTENSIONS = ['.mp3', '.ogg', '.wav', '.flac', '.opus'];

const isAudioEntryName = (value) => AUDIO_ENTRY_EXTENSIONS.some(
  (ext) => String(value || '').toLowerCase().endsWith(ext),
);

/** Audio entries that exist but were skipped purely for being too large. */
const findOversizedAudioEntries = (entries) => (entries || []).filter((entry) => (
  entry
  && isAudioEntryName(entry.name)
  && Number.isFinite(entry.uncompressedSize)
  && entry.uncompressedSize > MAX_ZIP_AUDIO_ENTRY_BYTES
));

const pickAudioEntryFromZip = (entries, requestedAudioFilename) => {
  const targetBaseName = getPathBaseName(requestedAudioFilename);
  const isAudioName = isAudioEntryName;
  const safeEntries = entries.filter((entry) => (
    isAudioName(entry.name)
    && Number.isFinite(entry.uncompressedSize)
    && entry.uncompressedSize > 0
    && entry.uncompressedSize <= MAX_ZIP_AUDIO_ENTRY_BYTES
  ));

  const requestedPath = normalizePath(requestedAudioFilename).toLowerCase();
  if (requestedPath) {
    const exactPathMatch = safeEntries.find((entry) => normalizePath(entry.name).toLowerCase() === requestedPath);
    if (exactPathMatch) {
      return exactPathMatch;
    }
  }

  if (targetBaseName) {
    const exactBaseMatch = safeEntries.find((entry) => getPathBaseName(entry.name) === targetBaseName);
    if (exactBaseMatch) {
      return exactBaseMatch;
    }
  }

  return safeEntries.length === 1 ? safeEntries[0] : null;
};

export {
  MAX_ARCHIVE_DOWNLOAD_BYTES,
  MAX_ZIP_AUDIO_ENTRY_BYTES,
  decodeZipName,
  isAudioEntryName,
  findOversizedAudioEntries,
  findZipEocdOffset,
  parseZipEntries,
  inflateWithFormat,
  inflateDeflateRaw,
  mergeUint8Chunks,
  readStreamChunkWithDeadline,
  readResponseArrayBufferLimited,
  responseLooksLikeBeatmapArchiveDownload,
  extractZipEntry,
  pickAudioEntryFromZip,
};
