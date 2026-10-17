import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFullBeatmapAudioToCache,
  shouldRetryExtractionInPopup,
} from '../src/audio/fullAudioExtractionCore.js';

// A single stored (uncompressed) entry with a real central directory, enough for
// the whole parse-pick-extract pipeline to run.
const buildStoredZip = (name, data) => {
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + nameBytes.length + data.length;
  const centralSize = central.length + nameBytes.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
};

const withFetch = async (respond, run) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => respond();
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test('the popup downloads only when the worker gave no answer', () => {
  // A rejected message, a port closed before the reply, or a listener that
  // returned nothing all surface here as a missing result.
  assert.equal(shouldRetryExtractionInPopup(null), true);
  assert.equal(shouldRetryExtractionInPopup(undefined), true);
  assert.equal(shouldRetryExtractionInPopup(true), true);
});

test('a failed mirror sweep in the worker is final', () => {
  // The worker has already tried every mirror; doing it again from the popup
  // fetched nothing new and doubled the wait for the failure badge.
  assert.equal(shouldRetryExtractionInPopup({
    ok: false,
    error: 'archive download failed (Mino:404, Mino:404(retry))',
  }), false);
  assert.equal(shouldRetryExtractionInPopup({ ok: false, error: 'Invalid full-audio request.' }), false);
});

test('a worker that downloaded but could not cache still lets the popup try', () => {
  assert.equal(shouldRetryExtractionInPopup({
    ok: false,
    error: 'Could not write extracted audio to cache.',
    cacheWriteFailed: true,
  }), true);
});

test('a successful worker result is used as is', () => {
  assert.equal(shouldRetryExtractionInPopup({ ok: true, sourceLabel: 'Mino' }), false);
});

test('mirrors that all fail produce a result the popup does not repeat', async () => {
  const result = await withFetch(
    () => new Response('not found', { status: 404 }),
    () => extractFullBeatmapAudioToCache({ setId: '123', audioFilename: 'audio.mp3', providerOverride: 'mino' }),
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /archive download failed/);
  assert.equal(shouldRetryExtractionInPopup(result), false);
});

test('a download whose audio cannot be cached is flagged for the popup', async () => {
  // Node has no Cache API, which is exactly the worker-cannot-store case.
  assert.equal('caches' in globalThis, false);
  const archive = buildStoredZip('audio.mp3', Buffer.from('ID3 pretend audio'));

  const result = await withFetch(
    () => new Response(archive, { status: 200, headers: { 'content-type': 'application/zip' } }),
    () => extractFullBeatmapAudioToCache({ setId: '123', audioFilename: 'audio.mp3', providerOverride: 'mino' }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.cacheWriteFailed, true);
  assert.equal(shouldRetryExtractionInPopup(result), true);
});
