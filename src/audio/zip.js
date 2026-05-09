import { normalizePath, getPathBaseName } from './cache.js';

const MAX_ARCHIVE_DOWNLOAD_BYTES = 120 * 1024 * 1024;
const MAX_ZIP_AUDIO_ENTRY_BYTES = 48 * 1024 * 1024;
const MAX_ZIP_ENTRY_INFLATE_RATIO = 80;
const MAX_ZIP_ENTRIES = 6000;
const FETCH_TIMEOUT_ARCHIVE_BODY_MS = 1000 * 60;

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

const decodeZipName = (nameBytes, isUtf8) => {
  if (!(nameBytes instanceof Uint8Array)) {
    return '';
  }

  try {
    const decoder = new TextDecoder(isUtf8 ? 'utf-8' : 'utf-8', { fatal: false });
    return decoder.decode(nameBytes);
  } catch {
    return String.fromCharCode(...nameBytes);
  }
};

const findZipEocdOffset = (bytes) => {
  const minimumLength = 22;
  if (!bytes || bytes.length < minimumLength) {
    return -1;
  }

  const scanStart = Math.max(0, bytes.length - (0xFFFF + minimumLength));
  for (let offset = bytes.length - minimumLength; offset >= scanStart; offset -= 1) {
    if (
      bytes[offset] === 0x50
      && bytes[offset + 1] === 0x4b
      && bytes[offset + 2] === 0x05
      && bytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }

  return -1;
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

const inflateWithFormat = async (compressedBytes, format) => {
  if (!('DecompressionStream' in globalThis)) {
    throw new Error('Browser does not support ZIP inflation for full audio.');
  }
  const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const inflateDeflateRaw = async (compressedBytes) => {
  try {
    return await inflateWithFormat(compressedBytes, 'deflate-raw');
  } catch {
    return inflateWithFormat(compressedBytes, 'deflate');
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

const readStreamChunkWithDeadline = async (reader, remainingMs) => {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    await reader.cancel();
    const err = new Error('timeout');
    err.name = 'AbortError';
    throw err;
  }
  let timeoutId;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
        }, remainingMs);
      }),
    ]);
  } catch (err) {
    if (err?.name === 'AbortError') {
      await reader.cancel();
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

const emitArchiveBodyProgress = (onProgress, loaded, totalGuess) => {
  if (typeof onProgress !== 'function' || !(Number.isFinite(loaded) && loaded >= 0)) {
    return;
  }
  const total = Number.isFinite(totalGuess) && totalGuess > 0 ? Math.floor(totalGuess) : null;
  onProgress({ loaded: Math.floor(loaded), total });
};

const readResponseArrayBufferLimited = async (response, maxBytes, bodyBudgetMs, onProgress) => {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : MAX_ARCHIVE_DOWNLOAD_BYTES;
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > cap) {
    throw new Error(`archive too large (${contentLength} bytes)`);
  }
  const totalHint = Number.isFinite(contentLength) && contentLength > 0 ? Math.min(contentLength, cap) : null;

  const bodyDeadline = Number.isFinite(bodyBudgetMs) && bodyBudgetMs > 0
    ? performance.now() + bodyBudgetMs
    : null;

  if (!response.body) {
    if (bodyDeadline === null) {
      const fallbackBuffer = await response.arrayBuffer();
      if (fallbackBuffer.byteLength > cap) {
        throw new Error(`archive exceeds limit (${fallbackBuffer.byteLength} bytes)`);
      }
      emitArchiveBodyProgress(onProgress, fallbackBuffer.byteLength, totalHint ?? fallbackBuffer.byteLength);
      return fallbackBuffer;
    }
    const fallbackBuffer = await Promise.race([
      response.arrayBuffer(),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
        }, bodyBudgetMs);
      }),
    ]);
    if (fallbackBuffer.byteLength > cap) {
      throw new Error(`archive exceeds limit (${fallbackBuffer.byteLength} bytes)`);
    }
    emitArchiveBodyProgress(onProgress, fallbackBuffer.byteLength, totalHint ?? fallbackBuffer.byteLength);
    return fallbackBuffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const chunkResult = bodyDeadline === null
        ? await reader.read()
        : await readStreamChunkWithDeadline(reader, bodyDeadline - performance.now());
      const { done, value } = chunkResult;
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array) || value.byteLength <= 0) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > cap) {
        await reader.cancel();
        throw new Error(`archive exceeds limit (${totalBytes} bytes)`);
      }
      chunks.push(value);
      emitArchiveBodyProgress(onProgress, totalBytes, totalHint ?? null);
    }
  } finally {
    reader.releaseLock();
  }

  emitArchiveBodyProgress(onProgress, totalBytes, totalHint ?? totalBytes);
  return mergeUint8Chunks(chunks, totalBytes);
};

const responseLooksLikeBeatmapArchiveDownload = (response) => {
  const disposition = (response.headers.get('content-disposition') || '').toLowerCase();
  if (disposition.includes('.osz')) {
    return true;
  }
  const rawType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return rawType === 'application/zip' || rawType === 'application/x-zip-compressed';
};

const readResponseArrayBufferLimitedWithInitialZipProbe = async (
  response,
  maxBytes,
  initialReadDeadlineMs,
  archiveBodyBudgetMs,
  onProgress,
) => {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : MAX_ARCHIVE_DOWNLOAD_BYTES;
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > cap) {
    throw new Error(`archive too large (${contentLength} bytes)`);
  }
  const totalHint = Number.isFinite(contentLength) && contentLength > 0 ? Math.min(contentLength, cap) : null;

  if (!response.body) {
    const fallbackBuffer = await Promise.race([
      response.arrayBuffer(),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
        }, archiveBodyBudgetMs);
      }),
    ]);
    if (fallbackBuffer.byteLength > cap) {
      throw new Error(`archive exceeds limit (${fallbackBuffer.byteLength} bytes)`);
    }
    emitArchiveBodyProgress(onProgress, fallbackBuffer.byteLength, totalHint ?? fallbackBuffer.byteLength);
    return fallbackBuffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  const bodyReadStart = performance.now();
  const bodyDeadline = performance.now() + archiveBodyBudgetMs;
  let zipConfirmed = false;

  try {
    while (true) {
      const now = performance.now();
      const remainingBudget = bodyDeadline - now;
      if (remainingBudget <= 0) {
        await reader.cancel();
        const err = new Error('timeout');
        err.name = 'AbortError';
        throw err;
      }

      let remainingForRace;
      if (zipConfirmed) {
        remainingForRace = remainingBudget;
      } else {
        const elapsed = now - bodyReadStart;
        const remainingProbe = initialReadDeadlineMs - elapsed;
        remainingForRace = Math.min(remainingBudget, remainingProbe);
      }

      const chunkResult = await readStreamChunkWithDeadline(reader, remainingForRace);
      const { done, value } = chunkResult;
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array) || value.byteLength <= 0) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > cap) {
        await reader.cancel();
        throw new Error(`archive exceeds limit (${totalBytes} bytes)`);
      }
      chunks.push(value);
      emitArchiveBodyProgress(onProgress, totalBytes, totalHint ?? null);

      if (!zipConfirmed && totalBytes >= 2) {
        const head = new Uint8Array(2);
        let o = 0;
        for (const ch of chunks) {
          for (let i = 0; i < ch.byteLength && o < 2; i += 1) {
            head[o] = ch[i];
            o += 1;
          }
          if (o >= 2) {
            break;
          }
        }
        if (head[0] === 0x50 && head[1] === 0x4b) {
          zipConfirmed = true;
        } else {
          await reader.cancel();
          emitArchiveBodyProgress(onProgress, totalBytes, totalHint ?? null);
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  emitArchiveBodyProgress(onProgress, totalBytes, totalHint ?? totalBytes);
  return mergeUint8Chunks(chunks, totalBytes);
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
    const inflated = await inflateDeflateRaw(compressed);
    if (inflated.byteLength !== uncompressedSize) {
      throw new Error('Inflated ZIP entry size mismatch.');
    }
    if (inflated.byteLength > MAX_ZIP_AUDIO_ENTRY_BYTES) {
      throw new Error('Inflated ZIP entry exceeds maximum allowed size.');
    }
    return inflated;
  }

  throw new Error(`ZIP compression method ${entry.compressionMethod} is unsupported.`);
};

const pickAudioEntryFromZip = (entries, requestedAudioFilename) => {
  const targetBaseName = getPathBaseName(requestedAudioFilename);
  const audioExtensions = ['.mp3', '.ogg', '.wav', '.flac', '.opus'];
  const isAudioName = (value) => audioExtensions.some((ext) => value.toLowerCase().endsWith(ext));
  const safeEntries = entries.filter((entry) => (
    isAudioName(entry.name)
    && Number.isFinite(entry.uncompressedSize)
    && entry.uncompressedSize > 0
    && entry.uncompressedSize <= MAX_ZIP_AUDIO_ENTRY_BYTES
  ));

  if (targetBaseName) {
    const exactBaseMatch = safeEntries.find((entry) => getPathBaseName(entry.name) === targetBaseName);
    if (exactBaseMatch) {
      return exactBaseMatch;
    }
  }

  const requestedPath = normalizePath(requestedAudioFilename).toLowerCase();
  if (requestedPath) {
    const exactPathMatch = safeEntries.find((entry) => normalizePath(entry.name).toLowerCase() === requestedPath);
    if (exactPathMatch) {
      return exactPathMatch;
    }
  }

  return safeEntries[0] || null;
};

export {
  MAX_ARCHIVE_DOWNLOAD_BYTES,
  MAX_ZIP_AUDIO_ENTRY_BYTES,
  decodeZipName,
  findZipEocdOffset,
  parseZipEntries,
  inflateWithFormat,
  inflateDeflateRaw,
  mergeUint8Chunks,
  readStreamChunkWithDeadline,
  readResponseArrayBufferLimited,
  readResponseArrayBufferLimitedWithInitialZipProbe,
  responseLooksLikeBeatmapArchiveDownload,
  extractZipEntry,
  pickAudioEntryFromZip,
};
