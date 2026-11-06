import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_BANKS,
  HITSOUND_STYLE_BANKS,
  HITSOUND_STYLE_ROOM,
  ROOM_WET_GAIN,
  createHitsoundPlayer,
} from '../src/audio/hitsounds.js';
import {
  SAMPLE_SET_NORMAL,
  SAMPLE_SET_SOFT,
  SAMPLE_SET_DRUM,
} from '../src/parser.js';
import { DEFAULT_HITSOUND_STYLE, HITSOUND_STYLES } from '../src/settings.js';

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
const ALL_STYLES = Object.entries(HITSOUND_STYLE_BANKS);

const renderAll = ({ volume = 100, style } = {}) => {
  const mock = createMockAudioContext();
  // `getAudioContext` is a constructor, not a factory: the player calls `new` on
  // it, which an arrow function cannot answer.
  function MockAudioContext() { return mock.context; }
  const player = createHitsoundPlayer({ getAudioContext: MockAudioContext });
  player.setEnabled(true);
  if (style !== undefined) {
    player.setStyle(style);
  }

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
  return { ...mock, placed, events, player };
};

test('a longer lookahead places hits that much further ahead', () => {
  // A hidden window's loop ticks far less often than frames do, so it asks for
  // two seconds rather than a third of one.
  const events = [0, 500, 1000, 1500, 2000, 2500].map((time) => buildEvent(time, 0, SAMPLE_SET_NORMAL));
  const placedWithin = (options) => {
    const mock = createMockAudioContext();
    function MockAudioContext() { return mock.context; }
    const player = createHitsoundPlayer({ getAudioContext: MockAudioContext });
    player.setEnabled(true);
    player.syncTo(events, 0);
    return player.update(events, 0, options);
  };

  assert.equal(placedWithin({ rate: 1 }), 1, 'a frame only reaches the next third of a second');
  assert.equal(placedWithin({ rate: 1, lookaheadSec: 2 }), 5);
  assert.equal(placedWithin({ rate: 2, lookaheadSec: 1 }), 5, 'the window is wall clock, so 2x covers twice the map');
});

test('every voice in every bank schedules without breaking a Web Audio rule', () => {
  for (const [style] of ALL_STYLES) {
    const { violations, placed, events } = renderAll({ style });
    assert.equal(placed, events.length, `${style}: every event should have been placed`);
    assert.deepEqual(violations, [], style);
  }
});

test('the same holds at the quiet end of the volume range', () => {
  // 5% sections are common, and the envelope floor is where ramps get delicate.
  for (const [style] of ALL_STYLES) {
    const { violations, placed } = renderAll({ volume: 5, style });
    assert.deepEqual(violations, [], style);
    assert.ok(placed > 0, style);
  }
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
  for (const [style, banks] of ALL_STYLES) {
    for (const set of ALL_SETS) {
      const where = `${style} bank ${set}`;
      const bank = banks[set];
      for (const sound of ['normal', 'whistle', 'clap', 'finish']) {
        assert.ok(Array.isArray(bank[sound]) && bank[sound].length > 0, `${where} has ${sound}`);
      }

      // The thing that stopped these sounding tiny: a hit needs a broadband
      // transient for definition and pitched content for character, not one blip.
      const layers = bank.normal;
      assert.ok(layers.length >= 3, `${where} hitnormal needs more than a blip`);
      assert.ok(layers.some((l) => l.kind === 'tone'), `${where} hitnormal has no pitched layer`);
      assert.ok(layers.some((l) => l.kind === 'noise'), `${where} hitnormal has no broadband bed`);
      assert.ok(
        layers.some((l) => l.kind === 'noise' && l.durationSec <= 0.025),
        `${where} hitnormal has no transient`,
      );

      // Nothing tonal should sit where small speakers stop reproducing and start
      // flapping. The upper end is deliberately unbounded: where the pitched
      // content sits is measured off the sample, not chosen here.
      const lowest = Math.min(...layers.filter((l) => l.kind === 'tone').map((l) => l.frequency));
      assert.ok(lowest > 60, `${where} hitnormal has a ${lowest}Hz tone, into subsonic mud`);
    }
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
  for (const [style, banks] of ALL_STYLES) {
    assert.equal(Object.keys(banks).length, 3, `${style} should have three banks`);
    for (const set of [SAMPLE_SET_NORMAL, SAMPLE_SET_SOFT, SAMPLE_SET_DRUM]) {
      for (const sound of ['normal', 'whistle', 'clap', 'finish']) {
        const layers = banks[set]?.[sound];
        assert.ok(Array.isArray(layers) && layers.length > 0, `${style} bank ${set} is missing ${sound}`);
        for (const layer of layers) {
          const where = `${style} ${set}/${sound}`;
          assert.ok(layer.kind === 'tone' || layer.kind === 'noise', `${where}: kind ${layer.kind}`);
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
          // A swell longer than this is no longer a hit, and a strike this late
          // reads as a second note rather than part of the first.
          if (layer.attackSec !== undefined) {
            assert.ok(layer.attackSec > 0 && layer.attackSec <= 0.06, `${where}: attack ${layer.attackSec}`);
          }
          if (layer.delaySec !== undefined) {
            assert.ok(layer.delaySec >= 0 && layer.delaySec <= 0.07, `${where}: delay ${layer.delaySec}`);
          }
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
  for (const [style, banks] of ALL_STYLES) {
    for (const [set, sounds] of Object.entries(banks)) {
      for (const [sound, layers] of Object.entries(sounds)) {
        for (const layer of layers) {
          if (!layer.endFrequency || layer.frequency < 1500 || layer.durationSec <= 0.025) continue;
          const pitched = layer.kind === 'tone' || (layer.q ?? 0) > 1.5;
          if (!pitched) continue;
          const semitones = 12 * Math.log2(layer.endFrequency / layer.frequency);
          offenders.push(`${style} ${set}/${sound}: ${layer.frequency}Hz `
            + `${semitones.toFixed(1)}st over ${Math.round(layer.durationSec * 1000)}ms`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the settings offer exactly the styles there are voices for', () => {
  // A style the dropdown offers with no banks behind it would quietly play the
  // default; banks no setting can reach are dead weight in the download.
  assert.deepEqual(Object.keys(HITSOUND_STYLE_BANKS).sort(), [...HITSOUND_STYLES].sort());
  assert.equal(HITSOUND_STYLE_BANKS[DEFAULT_HITSOUND_STYLE], SAMPLE_BANKS,
    'the default style is the voices the player had before styles existed');
});

test('the fitted styles play dry, and the room follows a change of style', () => {
  // Argon was tuned with the room; the others are fitted to dry samples, and a
  // tail on top of their own decay is exactly what blunts them.
  assert.deepEqual(Object.keys(HITSOUND_STYLE_ROOM).sort(), [...HITSOUND_STYLES].sort());
  assert.equal(HITSOUND_STYLE_ROOM[DEFAULT_HITSOUND_STYLE], ROOM_WET_GAIN);

  const isRoom = (node) => node.kind === 'gain' && node.gain.value === ROOM_WET_GAIN;
  const { nodes, player } = renderAll({ style: DEFAULT_HITSOUND_STYLE });
  const room = nodes.find(isRoom);
  assert.ok(room, 'the default style plays into the room');

  player.setStyle('lazer');
  assert.equal(room.gain.value, 0, 'switching to a fitted style takes the room out');
  player.setStyle(DEFAULT_HITSOUND_STYLE);
  assert.equal(room.gain.value, ROOM_WET_GAIN, 'and switching back restores it');

  // Chosen before there is any audio graph: the room is built dry.
  const dry = renderAll({ style: 'minimal' });
  assert.equal(dry.nodes.filter(isRoom).length, 0);
  assert.deepEqual(dry.violations, []);
});

test('each style is its own set of voices', () => {
  const tables = ALL_STYLES.map(([, banks]) => JSON.stringify(banks));
  assert.equal(new Set(tables).size, ALL_STYLES.length, 'two styles are the same table');
});

const ADDITION_FLAGS = { whistle: 2, finish: 4, clap: 8 };

// How many oscillators and noise sources renderAll() should start with these
// banks: hitnormal under every event, plus each addition its bitmask names.
const expectedVoices = (banks) => {
  const counts = { tone: 0, noise: 0 };
  for (const set of ALL_SETS) {
    for (const hitSound of HIT_SOUND_COMBINATIONS) {
      const sounds = ['normal', ...Object.keys(ADDITION_FLAGS)
        .filter((sound) => (hitSound & ADDITION_FLAGS[sound]) !== 0)];
      for (const sound of sounds) {
        for (const layer of banks[set][sound]) {
          counts[layer.kind] += 1;
        }
      }
    }
  }
  return counts;
};

const placedVoices = (style) => {
  const { nodes } = renderAll({ style });
  return {
    tone: nodes.filter((node) => node.kind === 'oscillator').length,
    noise: nodes.filter((node) => node.kind === 'bufferSource').length,
  };
};

test('choosing a style changes the voices the player places', () => {
  for (const [style, banks] of ALL_STYLES) {
    assert.deepEqual(placedVoices(style), expectedVoices(banks), `${style} should place its own layers`);
  }
});

test('an unknown style plays the default voices rather than nothing', () => {
  const defaults = expectedVoices(SAMPLE_BANKS);
  for (const style of ['not-a-style', undefined, '__proto__', 'toString']) {
    assert.deepEqual(placedVoices(style), defaults, String(style));
  }
});
