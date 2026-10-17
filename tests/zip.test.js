import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  decodeZipName,
  extractZipEntry,
  pickAudioEntryFromZip,
  readResponseArrayBufferLimited,
} from '../src/audio/zip.js';

// A deflated entry behind a bare local header, which is all extractZipEntry
// reads. `declaredSize` stands in for the central directory's claim.
const buildDeflatedEntry = (payload, declaredSize = payload.byteLength) => {
  const compressed = deflateRawSync(payload, { level: 9 });
  const name = Buffer.from('audio.mp3');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(name.length, 26);
  return {
    archive: new Uint8Array(Buffer.concat([header, name, compressed])),
    entry: {
      name: 'audio.mp3',
      compressionMethod: 8,
      compressedSize: compressed.byteLength,
      uncompressedSize: declaredSize,
      localHeaderOffset: 0,
    },
  };
};

// Counts what actually leaves the decompressor, so a test can tell an inflate
// that stopped at the limit from one that ran to the end and was checked after.
const countInflatedBytes = async (run) => {
  const Original = globalThis.DecompressionStream;
  let bytes = 0;
  globalThis.DecompressionStream = class {
    constructor(format) {
      const inner = new Original(format);
      this.writable = inner.writable;
      this.readable = inner.readable.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }));
    }
  };
  try {
    await run();
  } finally {
    globalThis.DecompressionStream = Original;
  }
  return bytes;
};

test('a deflated entry inflates to exactly its own bytes', async () => {
  // Random bytes, like real audio, so the ratio guard has no reason to object.
  const payload = randomBytes(256 * 1024);
  const { archive, entry } = buildDeflatedEntry(payload);

  const inflated = await extractZipEntry(archive, entry);

  assert.equal(inflated.byteLength, payload.byteLength);
  assert.deepEqual(Buffer.from(inflated), payload);
});

test('an entry inflating past its declared size stops at the limit', async () => {
  // 32 MiB of zeros deflates to ~32 KB. Declaring 50x that slips under the
  // ratio guard, so only the bounded inflate stands between this and the heap.
  const realSize = 32 * 1024 * 1024;
  const payload = Buffer.alloc(realSize);
  const compressedSize = deflateRawSync(payload, { level: 9 }).byteLength;
  const { archive, entry } = buildDeflatedEntry(payload, compressedSize * 50);

  let error = null;
  const inflatedBytes = await countInflatedBytes(async () => {
    try {
      await extractZipEntry(archive, entry);
    } catch (caught) {
      error = caught;
    }
  });

  assert.equal(error?.name, 'ZipInflateLimitError', 'the overflow must not be masked by the zlib retry');
  assert.ok(
    inflatedBytes < realSize / 4,
    `inflate should stop near the ${entry.uncompressedSize}-byte limit, but produced ${inflatedBytes} bytes`,
  );
});

test('an entry inflating short of its declared size is still rejected', async () => {
  const payload = randomBytes(4096);
  const { archive, entry } = buildDeflatedEntry(payload, payload.byteLength + 10);

  await assert.rejects(extractZipEntry(archive, entry), /size mismatch/);
});

test('decodes non-UTF8 ZIP filenames as CP437', () => {
  assert.equal(decodeZipName(new Uint8Array([0x63, 0x61, 0x66, 0x82, 0x2e, 0x6d, 0x70, 0x33]), false), 'caf\u00e9.mp3');
});

test('picks exact requested audio path before basename fallback', () => {
  const entries = [
    { name: 'other/song.mp3', uncompressedSize: 1000 },
    { name: 'audio/song.mp3', uncompressedSize: 1000 },
  ];

  assert.equal(pickAudioEntryFromZip(entries, 'audio/song.mp3').name, 'audio/song.mp3');
});

test('falls back to the only audio entry when no requested match exists', () => {
  const entries = [{ name: 'track.ogg', uncompressedSize: 1000 }];

  assert.equal(pickAudioEntryFromZip(entries, 'missing.mp3').name, 'track.ogg');
});

test('does not guess among multiple unmatched audio entries', () => {
  const entries = [
    { name: 'track-a.ogg', uncompressedSize: 1000 },
    { name: 'track-b.ogg', uncompressedSize: 1000 },
  ];

  assert.equal(pickAudioEntryFromZip(entries, 'missing.mp3'), null);
});

// A body delivered in fixed chunks, counting how much of it was ever pulled.
const chunkedResponse = (chunks, headers = {}) => {
  const stats = { pulled: 0, cancelled: false };
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      stats.pulled += 1;
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { response: new Response(body, { headers }), stats };
};

const zipChunks = (count, size = 1024) => Array.from({ length: count }, (_, i) => {
  const chunk = new Uint8Array(size).fill(i % 251);
  if (i === 0) {
    chunk[0] = 0x50;
    chunk[1] = 0x4b;
  }
  return chunk;
});

const concat = (chunks) => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

test('a body of announced size comes back byte for byte', async () => {
  const chunks = zipChunks(8);
  const { response } = chunkedResponse(chunks, { 'content-length': String(8 * 1024) });

  const buffer = await readResponseArrayBufferLimited(response, { requireZipSignature: true });

  assert.deepEqual(Buffer.from(buffer), concat(chunks));
});

test('a body longer than announced is kept whole, not cut at the announcement', async () => {
  // A compressed transfer reports its encoded size, so this really happens.
  const chunks = zipChunks(6);
  const { response } = chunkedResponse(chunks, { 'content-length': String(2 * 1024) });

  const buffer = await readResponseArrayBufferLimited(response);

  assert.deepEqual(Buffer.from(buffer), concat(chunks));
});

test('a body shorter than announced returns only what arrived', async () => {
  const chunks = zipChunks(3);
  const { response } = chunkedResponse(chunks, { 'content-length': String(10 * 1024) });

  const buffer = await readResponseArrayBufferLimited(response);

  assert.equal(buffer.byteLength, 3 * 1024);
  assert.deepEqual(Buffer.from(buffer), concat(chunks));
});

test('an error page served as 200 is abandoned after its first bytes', async () => {
  const page = new TextEncoder().encode('<!DOCTYPE html><title>rate limited</title>');
  const rest = Array.from({ length: 50 }, () => new Uint8Array(4096));
  const { response, stats } = chunkedResponse([page, ...rest]);

  const buffer = await readResponseArrayBufferLimited(response, { requireZipSignature: true });

  assert.equal(stats.cancelled, true);
  assert.ok(stats.pulled <= 2, `pulled ${stats.pulled} chunks of a page that was never going to be an archive`);
  assert.notEqual(new Uint8Array(buffer)[0], 0x50);
});

test('a body past the cap is refused', async () => {
  const { response } = chunkedResponse(zipChunks(4));
  await assert.rejects(readResponseArrayBufferLimited(response, { maxBytes: 3000 }), /exceeds limit/);
});
