import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeZipName, pickAudioEntryFromZip } from '../src/audio/zip.js';

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
