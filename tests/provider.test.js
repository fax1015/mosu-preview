import test from 'node:test';
import assert from 'node:assert/strict';
import {
  downloadBeatmapArchive,
  getProviderSequenceForDownload,
  hydrateProviderRuntimeState,
  mergeProviderRuntimeState,
  providerCooldowns,
  providerStats,
  serializeProviderRuntimeState,
} from '../src/audio/provider.js';

const resetProviderRuntimeState = () => {
  Object.keys(providerCooldowns).forEach((key) => {
    delete providerCooldowns[key];
  });
  Object.keys(providerStats).forEach((key) => {
    delete providerStats[key];
  });
};

test('disabled providers are skipped in auto mode', () => {
  resetProviderRuntimeState();
  const sequence = getProviderSequenceForDownload(
    'auto',
    ['mino', 'osu_direct', 'nerinyan', 'sayobot'],
    ['mino', 'nerinyan'],
    true,
  );

  assert.deepEqual(sequence.map((source) => source.id), ['osu_direct', 'sayobot']);
});

test('all disabled providers return empty sequence', () => {
  resetProviderRuntimeState();
  const sequence = getProviderSequenceForDownload(
    'auto',
    ['mino', 'osu_direct', 'nerinyan', 'sayobot'],
    ['mino', 'osu_direct', 'nerinyan', 'sayobot'],
    true,
  );

  assert.deepEqual(sequence, []);
});

test('autoFallback false only returns the best currently enabled provider', () => {
  resetProviderRuntimeState();
  const sequence = getProviderSequenceForDownload(
    'auto',
    ['sayobot', 'mino', 'osu_direct', 'nerinyan'],
    [],
    false,
  );

  assert.equal(sequence.length, 1);
  assert.equal(sequence[0].id, 'mino');
});

test('auto mode returns cooled down providers only when every enabled provider is cooling down', () => {
  resetProviderRuntimeState();
  const cooldownUntil = Date.now() + 60_000;
  providerCooldowns.mino = cooldownUntil;
  providerCooldowns.osu_direct = cooldownUntil;
  providerCooldowns.nerinyan = cooldownUntil;
  providerCooldowns.sayobot = cooldownUntil;

  const sequence = getProviderSequenceForDownload(
    'auto',
    ['mino', 'osu_direct', 'nerinyan', 'sayobot'],
    [],
    true,
  );

  assert.deepEqual(sequence.map((source) => source.id), ['mino', 'osu_direct', 'nerinyan', 'sayobot']);
});

test('forced provider override returns that provider', () => {
  resetProviderRuntimeState();
  const sequence = getProviderSequenceForDownload('nerinyan');

  assert.deepEqual(sequence.map((source) => source.id), ['nerinyan']);
});

test('provider runtime state serializes stats and live cooldowns', () => {
  resetProviderRuntimeState();
  const cooldownUntil = Date.now() + 60_000;
  hydrateProviderRuntimeState({
    version: 2,
    stats: {
      mino: {
        successes: 2,
        failures: 1,
        timedSuccesses: 2,
        totalSuccessMs: 3000,
      },
      unknown: {
        successes: 99,
      },
    },
    cooldowns: {
      nerinyan: cooldownUntil,
      unknown: cooldownUntil,
    },
  });

  const snapshot = serializeProviderRuntimeState();

  assert.deepEqual(snapshot.stats.mino, {
    successes: 2,
    failures: 1,
    timedSuccesses: 2,
    totalSuccessMs: 3000,
  });
  assert.equal(snapshot.stats.unknown, undefined);
  assert.equal(snapshot.cooldowns.nerinyan, cooldownUntil);
  assert.equal(snapshot.cooldowns.unknown, undefined);
});

// Headers arrive at once; the body takes `bodyDelayMs`, the way a large archive
// does on a real connection.
const withSlowArchiveFetch = async (bodyDelayMs, run) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    async start(controller) {
      await new Promise((resolve) => { setTimeout(resolve, bodyDelayMs); });
      controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'application/zip' } });
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const timedSuccessEntries = () => Object.entries(providerStats)
  .filter(([, stats]) => stats.timedSuccesses > 0);

test('a success is timed to the response headers, not the end of the body', async () => {
  // Timing the body made one big archive sink the provider that delivered it
  // below every provider that had never been tried.
  resetProviderRuntimeState();
  const bodyDelayMs = 300;

  const result = await withSlowArchiveFetch(bodyDelayMs, () => downloadBeatmapArchive('123', 'mino'));

  assert.equal(result.sourceLabel, 'Mino');
  assert.equal(providerStats.mino.timedSuccesses, 1);
  assert.ok(
    providerStats.mino.totalSuccessMs < bodyDelayMs / 2,
    `recorded ${providerStats.mino.totalSuccessMs}ms for headers that arrived immediately`,
  );
});

test('the multi-provider path also times a success to the headers', async () => {
  // With more than one candidate the download goes through the adaptive fetch,
  // which has its own return paths.
  resetProviderRuntimeState();
  const bodyDelayMs = 300;

  await withSlowArchiveFetch(bodyDelayMs, () => downloadBeatmapArchive(
    '123',
    'auto',
    {},
    ['mino', 'osu_direct', 'nerinyan', 'sayobot'],
    [],
    true,
  ));

  const timed = timedSuccessEntries();
  assert.equal(timed.length, 1, 'exactly one provider should have served the archive');
  const [id, stats] = timed[0];
  assert.ok(stats.totalSuccessMs < bodyDelayMs / 2, `${id} recorded ${stats.totalSuccessMs}ms`);
});

test('timings stored before version 2 are dropped, counts are kept', () => {
  // Version 1 averages are whole-download durations and would keep skewing
  // the ranking for as long as they stayed in the mean.
  resetProviderRuntimeState();
  const legacy = {
    version: 1,
    stats: {
      mino: {
        successes: 3, failures: 1, timedSuccesses: 3, totalSuccessMs: 60000,
      },
    },
  };

  hydrateProviderRuntimeState(legacy);
  assert.deepEqual(serializeProviderRuntimeState().stats.mino, {
    successes: 3, failures: 1, timedSuccesses: 0, totalSuccessMs: 0,
  });

  // The other realm can still write the old snapshot back; merging it must not
  // reintroduce what hydrate dropped.
  const merged = mergeProviderRuntimeState(legacy);
  assert.equal(merged.version, 2);
  assert.deepEqual(merged.stats.mino, {
    successes: 3, failures: 1, timedSuccesses: 0, totalSuccessMs: 0,
  });
});
