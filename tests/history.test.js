import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNextHistory } from '../src/core/history.js';

test('history keeps one recent entry per beatmap set when set id is available', () => {
  const next = buildNextHistory([
    {
      beatmapId: '1001',
      beatmapSetId: '100',
      title: 'Older difficulty',
    },
    {
      beatmapId: '2001',
      beatmapSetId: '200',
      title: 'Other set',
    },
  ], {
    beatmapId: '1002',
    beatmapSetId: '100',
    title: 'Newer difficulty',
  }, 1234);

  assert.deepEqual(next, [
    {
      beatmapId: '1002',
      beatmapSetId: '100',
      title: 'Newer difficulty',
      viewedAt: 1234,
    },
    {
      beatmapId: '2001',
      beatmapSetId: '200',
      title: 'Other set',
    },
  ]);
});

test('history falls back to beatmap id dedupe when set id is missing', () => {
  const next = buildNextHistory([
    {
      beatmapId: '1001',
      title: 'Older difficulty',
    },
  ], {
    beatmapId: '1001',
    title: 'Same difficulty',
  }, 1234);

  assert.deepEqual(next, [
    {
      beatmapId: '1001',
      title: 'Same difficulty',
      viewedAt: 1234,
    },
  ]);
});
