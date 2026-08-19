import test from 'node:test';
import assert from 'node:assert/strict';
import { abortActiveExtraction, getExtractionRequestKey, handleExtractFullAudio } from '../src/background.js';

test('the same track produces one key regardless of how it was spelled', () => {
  // If these diverge the dedupe silently stops working and both callers
  // download the same archive.
  const canonical = getExtractionRequestKey({ setId: '456', audioFilename: 'audio.mp3' });

  assert.equal(getExtractionRequestKey({ setId: 456, audioFilename: 'audio.mp3' }), canonical);
  assert.equal(getExtractionRequestKey({ setId: '456', audioFilename: 'Audio.MP3' }), canonical);
  assert.equal(getExtractionRequestKey({ setId: '456', audioFilename: '  audio.mp3  ' }), canonical);
});

test('different tracks and different sets stay distinct', () => {
  const base = getExtractionRequestKey({ setId: '456', audioFilename: 'audio.mp3' });

  assert.notEqual(getExtractionRequestKey({ setId: '457', audioFilename: 'audio.mp3' }), base);
  assert.notEqual(getExtractionRequestKey({ setId: '456', audioFilename: 'other.mp3' }), base);
});

test('a missing set id does not collide with a missing filename', () => {
  assert.notEqual(
    getExtractionRequestKey({ setId: '456' }),
    getExtractionRequestKey({ audioFilename: '456' }),
  );
  assert.equal(getExtractionRequestKey({}), getExtractionRequestKey(undefined));
});

test('two contexts asking for the same track share one download', async () => {
  // The toolbar popup and a detached window can both ask at once. Restarting the
  // extraction for the second caller cancelled the first one's transfer, and the
  // aborted caller then downloaded the same archive itself.
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const extract = async () => { calls += 1; await gate; return { ok: true, sourceLabel: 'Mino' }; };

  const message = { setId: '456', audioFilename: 'audio.mp3', jobId: 1 };
  const first = handleExtractFullAudio(message, extract);
  const second = handleExtractFullAudio({ ...message, jobId: 2 }, extract);

  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(calls, 1, 'the archive should only be fetched once');
  assert.deepEqual(a, { ok: true, sourceLabel: 'Mino' });
  assert.equal(a, b, 'both callers should receive the same result');
});

test('a request for a different track supersedes the one in flight', async () => {
  let abortedFirst = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const extract = async ({ setId, signal }) => {
    if (setId === '456') {
      signal.addEventListener('abort', () => { abortedFirst = true; });
      await gate;
      return { ok: false, error: 'aborted' };
    }
    return { ok: true, sourceLabel: 'Mino' };
  };

  const first = handleExtractFullAudio({ setId: '456', audioFilename: 'a.mp3', jobId: 1 }, extract);
  const second = await handleExtractFullAudio({ setId: '999', audioFilename: 'b.mp3', jobId: 2 }, extract);

  release();
  await first;

  assert.equal(abortedFirst, true, 'the superseded download should be cancelled');
  assert.deepEqual(second, { ok: true, sourceLabel: 'Mino' });
  abortActiveExtraction();
});

test('a finished job is not joined by a later request for the same track', async () => {
  let calls = 0;
  const extract = async () => { calls += 1; return { ok: true }; };
  const message = { setId: '456', audioFilename: 'audio.mp3', jobId: 1 };

  await handleExtractFullAudio(message, extract);
  await handleExtractFullAudio(message, extract);

  assert.equal(calls, 2, 'a completed extraction must not be reused as if in flight');
});
