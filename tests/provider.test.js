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

// Headers arrive at once; the body resolves only after `releaseBody()` is
// called, while `performance.now` is advanced deterministically so the test
// never depends on wall-clock sleeps or event-loop jitter.
const withControlledArchiveFetch = async (bodyDelayMs, run) => {
  const originalFetch = globalThis.fetch;
  const originalNow = performance.now;
  let fakeNow = 1000;
  performance.now = () => fakeNow;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      fakeNow += bodyDelayMs;
      controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
      controller.close();
    },
  }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'application/zip' } });
  try {
    return await run();
  } finally {
    performance.now = originalNow;
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

  const result = await withControlledArchiveFetch(bodyDelayMs, () => downloadBeatmapArchive('123', {
    providerOverride: 'mino',
  }));

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

  await withControlledArchiveFetch(bodyDelayMs, () => downloadBeatmapArchive('123', {
    userPriority: ['mino', 'osu_direct', 'nerinyan', 'sayobot'],
  }));

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

const countFetches = async (status, run) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('nope', { status });
  };
  try {
    await run().catch(() => {});
  } finally {
    globalThis.fetch = originalFetch;
  }
  return calls;
};

test('a provider that answers 4xx is not asked again', async () => {
  // A 404 means it does not have the set; a second, longer attempt gets the same answer.
  resetProviderRuntimeState();
  const calls = await countFetches(404, () => downloadBeatmapArchive('123', { providerOverride: 'mino' }));
  assert.equal(calls, 1);
});

test('a provider that answers 5xx gets its second attempt', async () => {
  resetProviderRuntimeState();
  const calls = await countFetches(503, () => downloadBeatmapArchive('123', { providerOverride: 'mino' }));
  assert.equal(calls, 2);
});

test('autoFallback false sticks to the top provider even while it is in cooldown', () => {
  resetProviderRuntimeState();
  const cooldownUntil = Date.now() + 60_000;
  providerCooldowns.mino = cooldownUntil;

  const singleCooldown = getProviderSequenceForDownload(
    'auto',
    ['mino', 'osu_direct', 'nerinyan', 'sayobot'],
    [],
    false,
  );
  assert.deepEqual(singleCooldown.map((s) => s.id), ['mino']);

  providerCooldowns.osu_direct = cooldownUntil;
  providerCooldowns.nerinyan = cooldownUntil;
  providerCooldowns.sayobot = cooldownUntil;
  const allCooldown = getProviderSequenceForDownload(
    'auto',
    ['mino', 'osu_direct', 'nerinyan', 'sayobot'],
    [],
    false,
  );
  assert.deepEqual(allCooldown.map((s) => s.id), ['mino']);
});

test('downloadBeatmapArchive validates setId and rejects unsafe redirect targets', async () => {
  resetProviderRuntimeState();
  await assert.rejects(downloadBeatmapArchive('../evil'), /Invalid beatmapset ID/);
  await assert.rejects(downloadBeatmapArchive('0'), /Invalid beatmapset ID/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'http://evil.example/archive.osz',
    headers: new Headers({ 'content-type': 'application/zip' }),
    body: { cancel: async () => {} },
  });
  try {
    await assert.rejects(
      downloadBeatmapArchive('123', { providerOverride: 'mino' }),
      /redirect target is not allowed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('downloadBeatmapArchive fails over to the next provider after 404 or non-zip responses', async () => {
  resetProviderRuntimeState();
  const originalFetch = globalThis.fetch;
  const triedHosts = [];
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    triedHosts.push(host);
    if (triedHosts.length === 1) {
      return new Response('not found', { status: 404 });
    }
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), {
      status: 200,
      headers: { 'content-type': 'application/zip' },
    });
  };
  try {
    const result = await downloadBeatmapArchive('123', {
      userPriority: ['mino', 'osu_direct'],
      disabledProviders: ['nerinyan', 'sayobot'],
      autoFallback: true,
    });
    assert.equal(triedHosts.length, 2);
    assert.notEqual(triedHosts[0], triedHosts[1]);
    assert.equal(result.archiveBuffer.byteLength, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
