import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getProviderSequenceForDownload,
  hydrateProviderRuntimeState,
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
