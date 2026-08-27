import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_BANKS,
  createHitsoundPlayer,
} from '../src/audio/hitsounds.js';
import {
  SAMPLE_SET_NORMAL,
  SAMPLE_SET_SOFT,
  SAMPLE_SET_DRUM,
} from '../src/parser.js';

// Web Audio enforces its automation rules at call time and throws: an
// exponential ramp to zero is a RangeError, a negative start offset is a
// RangeError, and a ramp with no preceding event has nothing to ramp from. None
// of that shows up in a test that only reads the bank tables, and none of it is
// audible to me -- so the mock enforces the rules the browser would, and every
// voice in every bank gets rendered through it.
const createMockAudioContext = ({ sampleRate = 8000 } = {}) => {
  const violations = [];
  const nodes = [];

  const createParam = (label, initialValue = 0) => {
    let lastTime = -Infinity;
    let lastValue = initialValue;
    const param = {
      get value() { return lastValue; },
      set value(next) { lastValue = next; },
      setValueAtTime(value, time) {
        if (!Number.isFinite(time) || time < 0) {
          violations.push(`${label}: setValueAtTime at ${time}`);
        }
        if (time < lastTime) {
          violations.push(`${label}: setValueAtTime goes back in time (${time} < ${lastTime})`);
        }
        lastTime = time;
        lastValue = value;
        return param;
      },
      exponentialRampToValueAtTime(value, time) {
        if (value === 0) {
          violations.push(`${label}: exponential ramp to zero`);
        }
        if (lastValue === 0) {
          violations.push(`${label}: exponential ramp from zero`);
        }
        if (!Number.isFinite(time) || time < 0) {
          violations.push(`${label}: ramp to ${time}`);
        }
        if (time < lastTime) {
          violations.push(`${label}: ramp goes back in time (${time} < ${lastTime})`);
        }
        if (lastTime === -Infinity) {
          violations.push(`${label}: ramp with no preceding event`);
        }
        lastTime = time;
        lastValue = value;
        return param;
      },
      linearRampToValueAtTime(value, time) {
        if (time < lastTime) {
          violations.push(`${label}: linear ramp goes back in time`);
        }
        lastTime = time;
        lastValue = value;
        return param;
      },
      cancelScheduledValues() { return param; },
    };
    return param;
  };

  const track = (node) => {
    nodes.push(node);
    return node;
  };

  const context = {
    sampleRate,
    currentTime: 100,
    state: 'running',
    destination: { kind: 'destination' },
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
    createGain: () => track({
      kind: 'gain', gain: createParam('gain', 1), connect() {}, disconnect() {},
    }),
    createBiquadFilter: () => track({
      kind: 'filter',
      type: 'bandpass',
      frequency: createParam('filter.frequency', 1),
      Q: createParam('filter.Q', 1),
      connect() {},
      disconnect() {},
    }),
    createWaveShaper: () => track({
      kind: 'shaper', curve: null, oversample: 'none', connect() {}, disconnect() {},
    }),
    createConvolver: () => track({
      kind: 'convolver', buffer: null, connect() {}, disconnect() {},
    }),
    createBuffer: (channels, frames, rate) => ({
      numberOfChannels: channels,
      length: frames,
      sampleRate: rate,
      duration: frames / rate,
      getChannelData: () => new Float32Array(frames),
    }),
    createBufferSource: () => {
      const node = track({
        kind: 'bufferSource',
        buffer: null,
        loop: false,
        startTime: null,
        stopTime: null,
        offset: null,
        connect() {},
        disconnect() {},
        start(when, offset = 0) {
          if (!Number.isFinite(when) || when < 0) {
            violations.push(`bufferSource: start at ${when}`);
          }
          if (offset < 0) {
            violations.push(`bufferSource: negative start offset ${offset}`);
          }
          if (node.buffer && offset >= node.buffer.duration) {
            violations.push(`bufferSource: start offset ${offset} past the buffer`);
          }
          node.startTime = when;
          node.offset = offset;
        },
        stop(when) {
          if (!(when > node.startTime)) {
            violations.push(`bufferSource: stop (${when}) not after start (${node.startTime})`);
          }
          node.stopTime = when;
        },
      });
      return node;
    },
    createOscillator: () => {
      const node = track({
        kind: 'oscillator',
        type: 'sine',
        frequency: createParam('oscillator.frequency', 440),
        startTime: null,
        stopTime: null,
        connect() {},
        disconnect() {},
        start(when) {
          if (!Number.isFinite(when) || when < 0) {
            violations.push(`oscillator: start at ${when}`);
          }
          node.startTime = when;
        },
        stop(when) {
          if (!(when > node.startTime)) {
            violations.push(`oscillator: stop (${when}) not after start (${node.startTime})`);
          }
          node.stopTime = when;
        },
      });
      return node;
    },
  };

  return { context, violations, nodes };
};

const buildEvent = (time, hitSound, set, volume = 100) => ({
  time, hitSound, normalSet: set, additionSet: set, volume,
});

// Every addition a bitmask can ask for, on its own and stacked.
const HIT_SOUND_COMBINATIONS = [0, 2, 4, 8, 2 | 4, 2 | 8, 4 | 8, 2 | 4 | 8];
const ALL_SETS = [SAMPLE_SET_NORMAL, SAMPLE_SET_SOFT, SAMPLE_SET_DRUM];

const renderAll = ({ volume = 100 } = {}) => {
  const mock = createMockAudioContext();
  // `getAudioContext` is a constructor, not a factory: the player calls `new` on
  // it, which an arrow function cannot answer.
  function MockAudioContext() { return mock.context; }
  const player = createHitsoundPlayer({ getAudioContext: MockAudioContext });
  player.setEnabled(true);

  const events = [];
  let time = 0;
  for (const set of ALL_SETS) {
    for (const hitSound of HIT_SOUND_COMBINATIONS) {
      events.push(buildEvent(time, hitSound, set, volume));
      time += 10;
    }
  }

  player.syncTo(events, 0);
  const placed = player.update(events, 0, { rate: 1 });
  return { ...mock, placed, events };
};

test('every voice in every bank schedules without breaking a Web Audio rule', () => {
  const { violations, placed, events } = renderAll();
  assert.equal(placed, events.length, 'every event should have been placed');
  assert.deepEqual(violations, []);
});

test('the same holds at the quiet end of the volume range', () => {
  // 5% sections are common, and the envelope floor is where ramps get delicate.
  const { violations, placed } = renderAll({ volume: 5 });
  assert.deepEqual(violations, []);
  assert.ok(placed > 0);
});

test('noise voices loop, so a long tail is never cut off by the buffer', () => {
  const { nodes } = renderAll();
  const sources = nodes.filter((node) => node.kind === 'bufferSource');
  assert.ok(sources.length > 0, 'noise voices should exist');

  for (const source of sources) {
    assert.equal(source.loop, true, 'a noise source that does not loop can run out mid-tail');
    assert.ok(source.buffer, 'a noise source needs its buffer');
  }

  // The regression this guards: a 0.8s crash over a 0.25s buffer used to stop
  // dead a third of the way through.
  const longest = Math.max(...sources.map((source) => source.stopTime - source.startTime));
  assert.ok(longest > 0.5, `the longest tail should survive, got ${longest}s`);
});

test('hits are placed into a room, not straight at the output', () => {
  const { nodes } = renderAll();
  assert.equal(nodes.filter((node) => node.kind === 'convolver').length, 1);
  assert.equal(nodes.filter((node) => node.kind === 'shaper').length, 1);

  const convolver = nodes.find((node) => node.kind === 'convolver');
  assert.ok(convolver.buffer, 'the room needs an impulse response');
  assert.equal(convolver.buffer.numberOfChannels, 2, 'a mono room has no width');

  const shaper = nodes.find((node) => node.kind === 'shaper');
  assert.ok(shaper.curve && shaper.curve.length > 0, 'the soft clipper needs a curve');
  assert.equal(shaper.oversample, '4x', 'clipping without oversampling aliases');
});

test('the soft clipper is gentle in the middle and firm at the edges', () => {
  const { nodes } = renderAll();
  const { curve } = nodes.find((node) => node.kind === 'shaper');
  const at = (x) => curve[Math.round(((x + 1) / 2) * (curve.length - 1))];

  assert.ok(Math.abs(at(0)) < 1e-6, 'silence in, silence out');
  assert.ok(Math.abs(at(1) - 1) < 1e-6, 'full scale in, full scale out');
  assert.ok(Math.abs(at(-1) + 1) < 1e-6, 'and symmetric');
  // A quiet single hit should pass through close to unchanged...
  assert.ok(at(0.2) > 0.2, 'quiet hits should not be squashed');
  // ...while a stack that would have gone past full scale is pulled back.
  assert.ok(at(0.8) < 0.95, 'loud stacks should be reined in');
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(curve[i] >= curve[i - 1], 'the curve has to stay monotonic to avoid distortion');
  }
});

test('every bank answers every sound, and every hit is a stack rather than a blip', () => {
  for (const set of ALL_SETS) {
    const bank = SAMPLE_BANKS[set];
    for (const sound of ['normal', 'whistle', 'clap', 'finish']) {
      assert.ok(Array.isArray(bank[sound]) && bank[sound].length > 0, `bank ${set} has ${sound}`);
    }

    // The thing that stopped these sounding tiny: a hit needs a broadband
    // transient for definition and pitched content for character, not one blip.
    const layers = bank.normal;
    assert.ok(layers.length >= 3, `bank ${set} hitnormal needs more than a blip`);
    assert.ok(layers.some((l) => l.kind === 'tone'), `bank ${set} hitnormal has no pitched layer`);
    assert.ok(layers.some((l) => l.kind === 'noise'), `bank ${set} hitnormal has no broadband bed`);
    assert.ok(
      layers.some((l) => l.kind === 'noise' && l.durationSec <= 0.025),
      `bank ${set} hitnormal has no transient`,
    );

    // Nothing tonal should sit where small speakers stop reproducing and start
    // flapping. The upper end is deliberately unbounded: where the pitched
    // content sits is measured off the sample, not chosen here.
    const lowest = Math.min(...layers.filter((l) => l.kind === 'tone').map((l) => l.frequency));
    assert.ok(lowest > 60, `bank ${set} hitnormal has a ${lowest}Hz tone, into subsonic mud`);
  }
});

test('the three banks are genuinely different voices', () => {
  // Worth pinning because the bank system only earns its keep if the banks
  // differ -- a copy-paste that quietly made two of them identical would leave
  // every sampleSet in every beatmap sounding the same and raise no error.
  const hitnormals = ALL_SETS.map((set) => JSON.stringify(SAMPLE_BANKS[set].normal));
  assert.equal(new Set(hitnormals).size, ALL_SETS.length, 'two banks share a hitnormal');

  // And the one relationship the measurements actually established: normal's
  // pitched content sits well above soft's and drum's, which in this skin share
  // their partials and differ in the bed underneath.
  const dominant = (set) => SAMPLE_BANKS[set].normal.find((l) => l.kind === 'tone').frequency;
  assert.ok(
    dominant(SAMPLE_SET_NORMAL) > dominant(SAMPLE_SET_SOFT),
    `normal (${dominant(SAMPLE_SET_NORMAL)}Hz) should sit above soft (${dominant(SAMPLE_SET_SOFT)}Hz)`,
  );
  assert.ok(
    dominant(SAMPLE_SET_NORMAL) > dominant(SAMPLE_SET_DRUM),
    `normal (${dominant(SAMPLE_SET_NORMAL)}Hz) should sit above drum (${dominant(SAMPLE_SET_DRUM)}Hz)`,
  );
});

// The fitted profiles were produced by an optimiser rather than written by
// hand, so they get checked harder than a table someone typed would need to be.

test('the table is complete, and every layer is physically playable', () => {
  assert.equal(Object.keys(SAMPLE_BANKS).length, 3, 'there should be three banks');
  for (const set of [SAMPLE_SET_NORMAL, SAMPLE_SET_SOFT, SAMPLE_SET_DRUM]) {
    for (const sound of ['normal', 'whistle', 'clap', 'finish']) {
      const layers = SAMPLE_BANKS[set]?.[sound];
      assert.ok(Array.isArray(layers) && layers.length > 0, `bank ${set} is missing ${sound}`);
      for (const layer of layers) {
        const where = `${set}/${sound}`;
        // A noise layer's gain sits *after* its filter, and a narrow bandpass
        // throws most of a white-noise source away -- so the gain that reaches
        // normal loudness through a Q of 3 at 180Hz is 15, not 0.5. It is not an
        // amplitude and cannot be read as one, which is why this bound is loose:
        // it catches nonsense, not level. Level is verified by rendering.
        assert.ok(layer.gain > 0 && layer.gain <= 20, `${where}: gain ${layer.gain}`);
        assert.ok(layer.durationSec > 0 && layer.durationSec <= 1.2,
          `${where}: duration ${layer.durationSec}`);
        for (const key of ['frequency', 'endFrequency']) {
          if (layer[key] === undefined) continue;
          // Above Nyquist a filter or oscillator frequency is meaningless.
          assert.ok(layer[key] >= 20 && layer[key] <= 18000, `${where}: ${key} ${layer[key]}`);
        }
        if (layer.q !== undefined) {
          assert.ok(layer.q >= 0.2 && layer.q <= 4, `${where}: q ${layer.q}`);
        }
      }
    }
  }
});

test('the noise source is mono, so hits sit where they were struck', () => {
  // Two channels of independent noise are completely uncorrelated, which is as
  // wide as a stereo image gets. Every noise layer arriving that way smeared the
  // hits across the whole field. Width is the room's job, not the source's.
  const { nodes } = renderAll();
  const sources = nodes.filter((node) => node.kind === 'bufferSource');
  assert.ok(sources.length > 0);
  for (const source of sources) {
    assert.equal(source.buffer.numberOfChannels, 1, 'a stereo noise source is an unplaceable hit');
  }

  const convolver = nodes.find((node) => node.kind === 'convolver');
  assert.equal(convolver.buffer.numberOfChannels, 2, 'the room is where width is allowed');
});

test('no voice contains a pitch glide long enough to hear as a chirp', () => {
  // Fitting liked gliding a high tone to smear energy across the spectrum over
  // time. It scores well and sounds like a bird. A glide is only audible as a
  // sweep when the layer is pitched, high, and long enough to trace it -- short
  // ones read as a transient zip and are worth keeping.
  const offenders = [];
  for (const [set, sounds] of Object.entries(SAMPLE_BANKS)) {
    for (const [sound, layers] of Object.entries(sounds)) {
      for (const layer of layers) {
        if (!layer.endFrequency || layer.frequency < 1500 || layer.durationSec <= 0.025) continue;
        const pitched = layer.kind === 'tone' || (layer.q ?? 0) > 1.5;
        if (!pitched) continue;
        const semitones = 12 * Math.log2(layer.endFrequency / layer.frequency);
        offenders.push(`${set}/${sound}: ${layer.frequency}Hz `
          + `${semitones.toFixed(1)}st over ${Math.round(layer.durationSec * 1000)}ms`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
