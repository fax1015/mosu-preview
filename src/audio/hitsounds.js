import {
  SAMPLE_SET_NONE,
  SAMPLE_SET_NORMAL,
  SAMPLE_SET_SOFT,
  SAMPLE_SET_DRUM,
} from '../parser.js';

// Experimental hitsounds.
//
// Sounds are synthesised rather than taken from the beatmap archive. Most
// archives ship no sample files at all -- osu! falls back to its default skin,
// which this extension cannot redistribute -- so pulling samples from the zip
// would leave the feature silent on the majority of maps. Generating them keeps
// it working everywhere and adds nothing to the download.

const HITSOUND_WHISTLE = 2;
const HITSOUND_FINISH = 4;
const HITSOUND_CLAP = 8;

// How far ahead of the playhead voices are placed, rather than being fired as it
// crosses them: a voice started at `currentTime` is only heard once the device
// has played out what is already buffered, so it lands `outputLatency` behind
// music whose reported position already accounts for that.
//
// The window has to exceed the latency being compensated for -- a note closer
// than that cannot be pulled early enough -- while staying short enough that a
// seek throws away almost nothing.
const SCHEDULE_LOOKAHEAD_SEC = 0.35;

// How far behind the playhead an unscheduled event may be and still sound. A
// stall, a tab switch or a long seek leaves a much bigger gap, and firing
// everything in it at once produces a machine-gun burst.
const MAX_CATCHUP_MS = 180;

// The playhead never really runs backwards during playback, but the media clock
// can report a fraction of a millisecond of jitter across a frame. Resyncing on
// that would cancel scheduled voices for no reason.
const BACKWARD_SEEK_TOLERANCE_MS = 2;

// Silencing a bus outright clicks; over 5ms it reads as an instant stop.
const VOICE_BUS_FADE_SEC = 0.005;

// Long enough for the longest tail in the banks, and looped, so a voice is never
// cut off by running out of source material. It used to be 0.25s and unlooped,
// which silently truncated every finish -- a crash that stops dead at 250ms is
// most of why they read as clicks rather than cymbals.
const NOISE_BUFFER_SEC = 1;

// A short room around the hits. Dry percussion in a dead field is the other half
// of sounding tiny: without any space behind it, a hit has nowhere to be.
//
// Kept tight on purpose. The room is added to every voice, so its decay becomes
// the tail of every hit -- and a hit whose tail is mostly reverb reads as smeared
// rather than as spacious, especially in a stream where the tails overlap.
const ROOM_IMPULSE_SEC = 0.14;
const ROOM_WET_GAIN = 0.09;
// The low body would only turn the room to mud, so it does not go there.
const ROOM_SEND_HIGHPASS_HZ = 520;
// How much of the room's impulse is independent per channel. 1 is two unrelated
// reverbs and the widest possible image; 0 is mono and no width at all.
const ROOM_STEREO_WIDTH = 0.45;

// Voices start together and stack, and osu! plays a lot of them at once. Soft
// clipping keeps that from crunching, and adds harmonics that read as weight
// rather than as volume.
const SATURATION_DRIVE = 1.35;
// Odd, so the curve has a sample exactly at zero. An even count straddles it and
// leaves a small DC offset on a signal that should have passed through clean.
const SATURATION_CURVE_SAMPLES = 2049;

// Long enough to avoid a DC step, short enough to still be a transient. This is
// the difference between a hit that starts and a hit that swells: at 1.5ms the
// rise covers 66 samples and the attack audibly rounds off, which is most of
// what makes synthesised percussion sound soft. A tone starts at zero crossing
// anyway, so the only thing this really protects is the noise layers.
const DEFAULT_ATTACK_SEC = 0.0004;

// The same voice fired identically hundreds of times a minute reads as a machine
// gun. A fraction of a semitone of scatter is enough to break that up without
// making a tuned whistle sound out of tune.
const VOICE_PITCH_SCATTER = 0.008;

// osu! writes sample volume as a percentage, and mappers do use the bottom of
// that range: 5% sections are common, and a silenced section is a real thing a
// map asks for. Below this a voice is inaudible anyway, and skipping it keeps
// the envelope's exponential ramp away from zero, which it cannot start from.
const MIN_AUDIBLE_GAIN = 0.0005;
const DEFAULT_SAMPLE_VOLUME = 100;

// Guards against a pathological map turning into millions of voices.
const MAX_HITSOUND_EVENTS = 200000;

// Shared between banks: the skin these were measured from uses one clap and one
// finish throughout, and the same whistle for normal and drum.
const SHARED_CLAP = [
  { kind: 'tone', gain: 0.069, durationSec: 0.1161, frequency: 1249 },
  { kind: 'tone', gain: 0.049, durationSec: 0.1277, frequency: 732 },
  { kind: 'tone', gain: 0.033, durationSec: 0.1277, frequency: 861 },
  {
    kind: 'noise',
    gain: 0.126,
    durationSec: 0.0019,
    frequency: 18000,
    endFrequency: 18000,
    q: 0.67,
    type: 'highpass',
  },
  { kind: 'noise', gain: 0.2405, durationSec: 0.3312, frequency: 1121, q: 1.8 },
  {
    kind: 'noise',
    gain: 0.192,
    durationSec: 0.0197,
    frequency: 4718,
    endFrequency: 6602,
    q: 0.56,
  },
];

const SHARED_FINISH = [
  { kind: 'tone', gain: 0.143, durationSec: 0.0929, frequency: 194 },
  { kind: 'tone', gain: 0.137, durationSec: 0.0813, frequency: 1421 },
  { kind: 'tone', gain: 0.13, durationSec: 0.2554, frequency: 108 },
  {
    kind: 'noise',
    gain: 0.145,
    durationSec: 0.0066,
    frequency: 2128,
    q: 2.35,
    type: 'highpass',
  },
  {
    kind: 'noise',
    gain: 0.104,
    durationSec: 0.9601,
    frequency: 423,
    endFrequency: 592,
    q: 0.3,
  },
  {
    kind: 'noise',
    gain: 0.099,
    durationSec: 0.033,
    frequency: 3633,
    q: 2.29,
    type: 'highpass',
  },
];

const BRIGHT_WHISTLE = [
  {
    kind: 'noise',
    gain: 0.211,
    durationSec: 0.0023,
    frequency: 7656,
    endFrequency: 18000,
    q: 0.72,
    type: 'highpass',
  },
  { kind: 'tone', gain: 0.049, durationSec: 0.104, frequency: 4457 },
  { kind: 'tone', gain: 0.043, durationSec: 0.244, frequency: 9733 },
  { kind: 'tone', gain: 0.142, durationSec: 0.2499, frequency: 991 },
  {
    kind: 'noise',
    gain: 0.068,
    durationSec: 0.234,
    frequency: 600,
    endFrequency: 210,
    q: 2.94,
    type: 'highpass',
  },
];

/**
 * The synthesised voices, one stack of layers per bank and sound.
 *
 * Derived from a real skin rather than invented: each sound's tonal layers are
 * transcribed from the sample's measured partials -- frequency as measured and
 * flat, gain in proportion to the partial's amplitude, duration equal to that
 * partial's own decay -- with only the broadband bed underneath fitted
 * numerically. Pitch comes from measurement because that is the part a
 * spectrogram fit gets wrong: left free it picks overtones for fundamentals and
 * invents gliding tones that sound like birdsong.
 *
 * A hit is a stack, not a blip: a broadband transient for definition, pitched
 * layers for character, and a bed carrying the body. Every gain is a peak the
 * map's own volume then scales. Note that a `noise` layer's gain sits *after*
 * its filter, so it is not an amplitude -- reaching normal loudness through a
 * narrow bandpass takes a gain well above 1.
 *
 * Only `normal` differs across all three banks; the shared voices above cover
 * the rest.
 */
const SAMPLE_BANKS = {
  [SAMPLE_SET_NORMAL]: {
    normal: [
      { kind: 'tone', gain: 0.1505, durationSec: 0.0929, frequency: 1077 },
      { kind: 'tone', gain: 0.194, durationSec: 0.0697, frequency: 624 },
      { kind: 'tone', gain: 0.158, durationSec: 0.0697, frequency: 280 },
      {
        kind: 'noise',
        gain: 0.467,
        durationSec: 0.0023,
        frequency: 13076,
        endFrequency: 18000,
        q: 0.78,
        type: 'highpass',
      },
      {
        kind: 'noise',
        gain: 2.2526,
        durationSec: 0.1563,
        frequency: 421,
        endFrequency: 589,
        q: 1.43,
      },
      {
        kind: 'noise',
        gain: 0.147,
        durationSec: 0.3246,
        frequency: 417,
        endFrequency: 584,
        q: 1.13,
      },
    ],
    whistle: BRIGHT_WHISTLE,
    clap: SHARED_CLAP,
    finish: SHARED_FINISH,
  },
  [SAMPLE_SET_SOFT]: {
    normal: [
      { kind: 'tone', gain: 0.23, durationSec: 0.1045, frequency: 431 },
      { kind: 'tone', gain: 0.211, durationSec: 0.1161, frequency: 194 },
      { kind: 'tone', gain: 0.2, durationSec: 0.0929, frequency: 258 },
      {
        kind: 'noise',
        gain: 0.22,
        durationSec: 0.002,
        frequency: 18000,
        endFrequency: 18000,
        q: 0.3,
        type: 'highpass',
      },
      {
        kind: 'noise',
        gain: 1.688,
        durationSec: 0.3234,
        frequency: 83,
        endFrequency: 102,
        q: 1.32,
      },
    ],
    whistle: [
      {
        kind: 'noise',
        gain: 0.019,
        durationSec: 0.0038,
        frequency: 2663,
        endFrequency: 3726,
        q: 0.45,
        type: 'highpass',
      },
      {
        kind: 'noise',
        gain: 0.017,
        durationSec: 0.009,
        frequency: 14713,
        q: 2.5,
        type: 'highpass',
      },
      {
        kind: 'noise',
        gain: 0.221,
        durationSec: 0.2907,
        frequency: 5223,
        endFrequency: 3736,
        q: 0.32,
      },
    ],
    clap: SHARED_CLAP,
    finish: SHARED_FINISH,
  },
  [SAMPLE_SET_DRUM]: {
    normal: [
      { kind: 'tone', gain: 0.187, durationSec: 0.1625, frequency: 431 },
      { kind: 'tone', gain: 0.12, durationSec: 0.1045, frequency: 194 },
      { kind: 'tone', gain: 0.095, durationSec: 0.1625, frequency: 258 },
      {
        kind: 'noise',
        gain: 0.283,
        durationSec: 0.003,
        frequency: 8461,
        endFrequency: 11840,
        q: 0.65,
        type: 'highpass',
      },
      {
        kind: 'noise',
        gain: 1.02,
        durationSec: 0.0544,
        frequency: 1479,
        endFrequency: 1036,
        q: 1.4,
      },
      {
        kind: 'noise',
        gain: 2.418,
        durationSec: 0.412,
        frequency: 133,
        endFrequency: 101,
        q: 0.97,
      },
    ],
    whistle: BRIGHT_WHISTLE,
    clap: SHARED_CLAP,
    finish: SHARED_FINISH,
  },
};

const normalizeSampleSet = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= SAMPLE_SET_NORMAL && parsed <= SAMPLE_SET_DRUM
    ? parsed
    : SAMPLE_SET_NONE;
};

const getBank = (sampleSet) => (
  SAMPLE_BANKS[normalizeSampleSet(sampleSet)] ?? SAMPLE_BANKS[SAMPLE_SET_NORMAL]
);

const getNodeHitSound = (object, nodeIndex) => {
  const edgeSounds = Array.isArray(object?.sliderEdgeSounds) ? object.sliderEdgeSounds : [];
  const value = Number(edgeSounds[nodeIndex]);
  // An absent or malformed edge entry inherits the object's own hitsound, which
  // is what osu! does for sliders that declare no per-edge sounds at all.
  return Number.isFinite(value) ? value : (Number(object?.hitSound) || 0);
};

// Slider nodes may name their own banks in `edgeSets`; the parser has already
// folded the object's own banks in as the fallback for nodes that do not.
const getNodeSampleSets = (object, nodeIndex) => {
  const nodeSamples = Array.isArray(object?.nodeSamples) ? object.nodeSamples : [];
  const node = nodeSamples[nodeIndex];
  return {
    normalSet: normalizeSampleSet(node?.normalSet ?? object?.sampleSet),
    additionSet: normalizeSampleSet(node?.additionSet ?? object?.additionSet),
  };
};

/**
 * The volume and banks a hit actually plays with.
 *
 * osu! resolves each through a chain, and every link matters in real maps: an
 * object may name its own, otherwise the timing point in force at that moment
 * decides, otherwise the beatmap's own default does. Volume is the same story,
 * and it is the one that changes constantly -- greenlines riding volume through
 * an intro, a build and a chorus are how a map breathes.
 *
 * `samplePoints` must be sorted by time, and `events` too: this walks both once.
 * Additions inherit the resolved normal bank rather than the timing point's, so
 * an object that names a bank names it for its whistles and claps as well.
 */
const resolveEventSamples = (events, samplePoints, defaultSampleSet) => {
  const points = Array.isArray(samplePoints) ? samplePoints : [];
  const beatmapSet = normalizeSampleSet(defaultSampleSet);
  // Times before the first timing point take that point's settings, the same
  // fallback osu! applies to everything else a control point governs.
  let active = points[0] ?? null;
  let index = 0;

  return events.map((event) => {
    while (index < points.length && points[index].time <= event.time) {
      active = points[index];
      index += 1;
    }

    const pointVolume = Number(active?.volume);
    const normalSet = normalizeSampleSet(event.normalSet)
      || normalizeSampleSet(active?.sampleSet)
      || beatmapSet
      || SAMPLE_SET_NORMAL;

    return {
      time: event.time,
      hitSound: event.hitSound,
      normalSet,
      // 0 means "whatever the normal bank ended up being", not "the default".
      additionSet: normalizeSampleSet(event.additionSet) || normalSet,
      volume: event.volume > 0
        ? event.volume
        : (Number.isFinite(pointVolume) ? pointVolume : DEFAULT_SAMPLE_VOLUME),
    };
  });
};

/**
 * Flattens hit objects into the individual sounds the map should make, in time
 * order. Circles contribute one; sliders contribute one per node; spinners
 * sound when they finish.
 *
 * Objects that a ruleset conversion has already expanded into one object per
 * sound arrive here as plain circles, so they pass straight through rather than
 * being expanded a second time.
 *
 * Banks and volume are resolved here, once per map, rather than per frame: a
 * slider crossing a greenline gets its nodes resolved individually, because
 * each node is its own event by the time the timing points are walked.
 */
const buildHitsoundEvents = (objects, { samplePoints = [], defaultSampleSet = 0 } = {}) => {
  const list = Array.isArray(objects) ? objects : [];
  const events = [];

  for (const object of list) {
    if (!object || !Number.isFinite(object.time)) {
      continue;
    }

    const startTime = object.time;
    const endTime = Number.isFinite(object.endTime) ? object.endTime : startTime;
    const objectSets = {
      normalSet: normalizeSampleSet(object.sampleSet),
      additionSet: normalizeSampleSet(object.additionSet),
    };
    // 0 here means "inherit"; the timing point decides during resolution.
    const volume = Number(object.sampleVolume) || 0;

    if (object.kind === 'spinner') {
      // A spinner is silent until it completes.
      events.push({
        time: endTime, hitSound: Number(object.hitSound) || 0, ...objectSets, volume,
      });
      continue;
    }

    const slides = Math.max(1, Math.floor(Number(object.slides) || 1));
    const isSlider = object.kind === 'slider' && endTime > startTime;

    if (!isSlider || slides < 1) {
      events.push({
        time: startTime, hitSound: Number(object.hitSound) || 0, ...objectSets, volume,
      });
      continue;
    }

    // `slides` counts spans, so a plain slider (1 span) has two nodes: head and
    // tail. Each extra span adds a reverse.
    const spanDuration = (endTime - startTime) / slides;
    for (let node = 0; node <= slides; node += 1) {
      events.push({
        time: startTime + (spanDuration * node),
        hitSound: getNodeHitSound(object, node),
        ...getNodeSampleSets(object, node),
        volume,
      });
      if (events.length >= MAX_HITSOUND_EVENTS) {
        break;
      }
    }

    if (events.length >= MAX_HITSOUND_EVENTS) {
      break;
    }
  }

  // Slider nodes interleave with later objects' heads, so the flattened list is
  // not sorted by construction even though the source objects are.
  events.sort((a, b) => a.time - b.time);
  return resolveEventSamples(events, samplePoints, defaultSampleSet);
};

const findFirstIndexAtOrAfter = (objects, timeMs) => {
  let low = 0;
  let high = objects.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (objects[mid].time < timeMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};

/**
 * The events a frame has to place: everything from `cursor` up to the horizon.
 *
 * Kept separate from playback so the cursor arithmetic can be tested without an
 * AudioContext. `cursor` is the index to resume scanning at; the caller stores
 * the returned one.
 *
 * `mapNowMs` only decides what is too stale to bother with. Events reached
 * normally are always ahead of it -- they are being scheduled, not fired -- so
 * the catch-up window matters exactly when a stall or a long frame left a run of
 * notes behind.
 */
const collectScheduledEvents = (events, cursor, mapNowMs, horizonMapMs) => {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0 || !(horizonMapMs >= mapNowMs)) {
    return { due: [], nextCursor: cursor };
  }

  const staleBeforeMs = mapNowMs - MAX_CATCHUP_MS;
  let index = Math.max(0, Math.min(cursor, list.length));

  // Strictly-less-than, so an event sitting exactly on the playhead still
  // sounds -- that is the first object of a map, and every object landing on a
  // seek target. Events already scheduled are excluded by the cursor, not by
  // this window, so nothing repeats.
  while (index < list.length && list[index].time < staleBeforeMs) {
    index += 1;
  }

  const due = [];
  while (index < list.length && list[index].time <= horizonMapMs) {
    due.push(list[index]);
    index += 1;
  }

  return { due, nextCursor: index };
};

// tanh-shaped soft clip. Gentle at the levels one hit reaches, firm by the time
// a stack of them would have gone past full scale.
const buildSaturationCurve = (drive) => {
  const curve = new Float32Array(SATURATION_CURVE_SAMPLES);
  const limit = Math.tanh(drive);
  for (let i = 0; i < SATURATION_CURVE_SAMPLES; i += 1) {
    const x = ((i / (SATURATION_CURVE_SAMPLES - 1)) * 2) - 1;
    curve[i] = Math.tanh(drive * x) / limit;
  }
  return curve;
};

const createHitsoundPlayer = ({ getAudioContext, onLog } = {}) => {
  let audioContext = null;
  let masterGain = null;
  let mixBus = null;
  let roomSend = null;
  let voiceBus = null;
  let noiseBuffer = null;
  let enabled = false;
  let volume = 0.5;
  let cursor = 0;
  let lastTimeMs = 0;
  let hasLoggedLatency = false;

  const ensureContext = () => {
    if (audioContext) {
      return audioContext;
    }

    const AudioContextCtor = getAudioContext
      || globalThis.AudioContext
      || globalThis.webkitAudioContext;
    if (!AudioContextCtor) {
      return null;
    }

    try {
      audioContext = new AudioContextCtor();
      const { sampleRate } = audioContext;

      // voices -> voiceBus -+-> mixBus -> saturator -> masterGain -> out
      //                     `-> roomSend -> room ----^
      masterGain = audioContext.createGain();
      masterGain.gain.value = volume;
      masterGain.connect(audioContext.destination);

      const saturator = audioContext.createWaveShaper();
      saturator.curve = buildSaturationCurve(SATURATION_DRIVE);
      saturator.oversample = '4x';
      saturator.connect(masterGain);

      mixBus = audioContext.createGain();
      mixBus.gain.value = 1;
      mixBus.connect(saturator);

      // A small room, part shared between the channels and part not. Fully
      // independent channels give the widest possible reverb, which is where the
      // last of the smear was coming from; sharing most of the impulse pulls the
      // image back towards the centre while still leaving it some air.
      const roomFrames = Math.floor(sampleRate * ROOM_IMPULSE_SEC);
      const roomImpulse = audioContext.createBuffer(2, roomFrames, sampleRate);
      const shared = new Float32Array(roomFrames);
      for (let i = 0; i < roomFrames; i += 1) {
        shared[i] = (Math.random() * 2) - 1;
      }
      for (let channelIndex = 0; channelIndex < 2; channelIndex += 1) {
        const channel = roomImpulse.getChannelData(channelIndex);
        for (let i = 0; i < roomFrames; i += 1) {
          const independent = (Math.random() * 2) - 1;
          const mixed = (shared[i] * (1 - ROOM_STEREO_WIDTH)) + (independent * ROOM_STEREO_WIDTH);
          channel[i] = mixed * ((1 - (i / roomFrames)) ** 2.6);
        }
      }
      const room = audioContext.createConvolver();
      room.buffer = roomImpulse;
      const roomWet = audioContext.createGain();
      roomWet.gain.value = ROOM_WET_GAIN;
      room.connect(roomWet);
      roomWet.connect(mixBus);

      roomSend = audioContext.createBiquadFilter();
      roomSend.type = 'highpass';
      roomSend.frequency.value = ROOM_SEND_HIGHPASS_HZ;
      roomSend.connect(room);

      // Mono, and looped so a tail is never cut short by the end of the buffer.
      //
      // Mono matters more than it looks: two channels of independent noise are
      // completely uncorrelated, which is as wide as a stereo field goes. Every
      // noise layer was arriving smeared right across it, when a struck object
      // should sit in one place. The room is where width belongs, not the source.
      const noiseFrames = Math.floor(sampleRate * NOISE_BUFFER_SEC);
      noiseBuffer = audioContext.createBuffer(1, noiseFrames, sampleRate);
      const noiseChannel = noiseBuffer.getChannelData(0);
      for (let i = 0; i < noiseFrames; i += 1) {
        noiseChannel[i] = (Math.random() * 2) - 1;
      }
    } catch {
      // A half-built graph is unusable, and the context behind it would sit
      // there holding a device open for nothing.
      void audioContext?.close?.().catch(() => {});
      audioContext = null;
      masterGain = null;
      mixBus = null;
      roomSend = null;
      noiseBuffer = null;
    }

    return audioContext;
  };

  /**
   * What the device adds between a sample being handed to the context and being
   * heard. The music comes out of a media element whose reported position is
   * already corrected for it, so a voice placed at `currentTime` starts exactly
   * this far behind the note it belongs to.
   */
  const getOutputLatencySec = () => {
    const outputLatency = Number(audioContext?.outputLatency);
    if (Number.isFinite(outputLatency) && outputLatency > 0) {
      return outputLatency;
    }
    // Firefox and older Chrome only expose the context's own buffering.
    const baseLatency = Number(audioContext?.baseLatency);
    return Number.isFinite(baseLatency) && baseLatency > 0 ? baseLatency : 0;
  };

  /**
   * Every voice hangs off a per-generation bus, so a seek, a pause or a rate
   * change can silence everything already placed ahead of the playhead with one
   * ramp. Dropping the reference afterwards is enough: the sources on the old
   * bus still stop themselves at their scheduled times, they just do it into
   * silence, and the whole graph becomes collectable once they have.
   */
  const ensureVoiceBus = () => {
    if (!voiceBus) {
      voiceBus = audioContext.createGain();
      voiceBus.gain.value = 1;
      voiceBus.connect(mixBus);
      // Downstream of the bus on purpose: cancelling has to take the room with
      // it, or a seek would leave the tail of the old position ringing.
      voiceBus.connect(roomSend);
    }
    return voiceBus;
  };

  const cancelScheduledVoices = () => {
    if (!audioContext || !voiceBus) {
      return;
    }

    const now = audioContext.currentTime;
    voiceBus.gain.cancelScheduledValues(now);
    voiceBus.gain.setValueAtTime(voiceBus.gain.value, now);
    voiceBus.gain.linearRampToValueAtTime(0, now + VOICE_BUS_FADE_SEC);
    voiceBus = null;
  };

  // A percussive envelope: near-instant but not a step, then an exponential
  // decay. The ramps cannot start from or reach zero, hence the floor.
  const applyPercussiveEnvelope = (param, {
    startAt, peak, durationSec, attackSec = DEFAULT_ATTACK_SEC,
  }) => {
    const floor = 0.0001;
    const attackEnd = startAt + Math.min(attackSec, durationSec * 0.4);
    param.setValueAtTime(floor, startAt);
    param.exponentialRampToValueAtTime(peak, attackEnd);
    param.exponentialRampToValueAtTime(floor, startAt + durationSec);
  };

  const playNoise = ({
    startAt, destination, gain, durationSec, frequency, endFrequency, q = 1, type = 'bandpass',
  }) => {
    const source = audioContext.createBufferSource();
    source.buffer = noiseBuffer;
    // The buffer is a second long and the tails can be shorter or longer; loop
    // rather than let the source decide when the sound ends.
    source.loop = true;
    // Start somewhere arbitrary so repeated hits are not the identical waveform.
    const offsetSec = Math.random() * (NOISE_BUFFER_SEC - Math.min(durationSec, NOISE_BUFFER_SEC * 0.5));

    const filter = audioContext.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(frequency, startAt);
    if (endFrequency) {
      // Percussion darkens as it decays; a static filter is what makes a noise
      // burst sound like a burst of noise.
      filter.frequency.exponentialRampToValueAtTime(endFrequency, startAt + durationSec);
    }
    filter.Q.value = q;

    const envelope = audioContext.createGain();
    applyPercussiveEnvelope(envelope.gain, { startAt, peak: gain, durationSec });

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(destination);
    source.start(startAt, offsetSec);
    source.stop(startAt + durationSec);
  };

  const playTone = ({
    startAt, destination, gain, durationSec, frequency, type = 'sine', endFrequency,
  }) => {
    const oscillator = audioContext.createOscillator();
    oscillator.type = type;

    oscillator.frequency.setValueAtTime(frequency, startAt);
    if (endFrequency) {
      oscillator.frequency.exponentialRampToValueAtTime(endFrequency, startAt + durationSec);
    }

    const envelope = audioContext.createGain();
    applyPercussiveEnvelope(envelope.gain, { startAt, peak: gain, durationSec });

    oscillator.connect(envelope);
    envelope.connect(destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + durationSec);
  };

  const playLayers = (layers, startAt, destination, volumeScale) => {
    if (!Array.isArray(layers)) {
      return 0;
    }

    // One scatter per sound, not per layer, so the layers of a hit stay in tune
    // with each other while successive hits differ.
    const scatter = 1 + (((Math.random() * 2) - 1) * VOICE_PITCH_SCATTER);

    let played = 0;
    for (const layer of layers) {
      const gain = layer.gain * volumeScale;
      if (gain < MIN_AUDIBLE_GAIN) {
        continue;
      }
      const voice = {
        ...layer,
        gain,
        startAt,
        destination,
        frequency: layer.frequency * scatter,
        endFrequency: layer.endFrequency ? layer.endFrequency * scatter : undefined,
      };
      if (layer.kind === 'noise') {
        playNoise(voice);
      } else {
        playTone(voice);
      }
      played += 1;
    }
    return played;
  };

  const playHit = (event, startAt, destination) => {
    const mapVolume = Number(event?.volume);
    const volumeScale = (Number.isFinite(mapVolume) ? Math.min(100, Math.max(0, mapVolume)) : 100)
      / 100;
    if (volumeScale <= 0) {
      // A section the map deliberately silenced.
      return 0;
    }

    const flags = Number.isFinite(event?.hitSound) ? event.hitSound : 0;
    // hitnormal plays under every object and takes the normal bank; the
    // additions layered on top take the addition bank.
    const normalBank = getBank(event?.normalSet);
    const additionBank = getBank(event?.additionSet);

    let played = playLayers(normalBank.normal, startAt, destination, volumeScale);
    if ((flags & HITSOUND_WHISTLE) !== 0) {
      played += playLayers(additionBank.whistle, startAt, destination, volumeScale);
    }
    if ((flags & HITSOUND_CLAP) !== 0) {
      played += playLayers(additionBank.clap, startAt, destination, volumeScale);
    }
    if ((flags & HITSOUND_FINISH) !== 0) {
      played += playLayers(additionBank.finish, startAt, destination, volumeScale);
    }
    return played;
  };

  /**
   * Moves the cursor and drops whatever was already placed ahead of it. Call
   * after any jump: a seek, a pause, a rate change, a new map.
   */
  const syncTo = (objects, timeMs) => {
    const list = Array.isArray(objects) ? objects : [];
    lastTimeMs = Number.isFinite(timeMs) ? timeMs : 0;
    cursor = findFirstIndexAtOrAfter(list, lastTimeMs);
    cancelScheduledVoices();
  };

  /**
   * Places every voice that falls in the next lookahead window. Call once per
   * frame with the playhead and the rate the map is running at.
   */
  const update = (objects, currentTimeMs, { rate = 1 } = {}) => {
    if (!Number.isFinite(currentTimeMs)) {
      return 0;
    }

    if (!enabled) {
      lastTimeMs = currentTimeMs;
      return 0;
    }

    // Going backwards is a seek that did not come through syncTo.
    if (currentTimeMs < (lastTimeMs - BACKWARD_SEEK_TOLERANCE_MS)) {
      syncTo(objects, currentTimeMs);
      return 0;
    }
    lastTimeMs = currentTimeMs;

    const list = Array.isArray(objects) ? objects : [];
    if (cursor >= list.length) {
      return 0;
    }

    const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
    // The window is wall-clock time, so at 2x it spans twice as much map.
    const horizonMapMs = currentTimeMs + (SCHEDULE_LOOKAHEAD_SEC * 1000 * speed);
    if (list[cursor].time > horizonMapMs) {
      // Nothing near enough to place yet. Worth checking before building an
      // AudioContext for a map that has not started making noise.
      return 0;
    }

    if (!ensureContext()) {
      return 0;
    }

    // A suspended context (autoplay policy, or a tab that was backgrounded)
    // silently swallows everything until it is resumed.
    if (audioContext.state === 'suspended') {
      void audioContext.resume().catch(() => {});
    }

    const { due, nextCursor } = collectScheduledEvents(list, cursor, currentTimeMs, horizonMapMs);
    cursor = nextCursor;
    if (due.length === 0) {
      return 0;
    }

    const contextNowSec = audioContext.currentTime;
    const latencySec = getOutputLatencySec();
    const destination = ensureVoiceBus();

    // Logged from the first real schedule rather than from context creation:
    // the device does not report a latency worth reading until it is running.
    if (!hasLoggedLatency) {
      hasLoggedLatency = true;
      onLog?.(`hitsounds: ${Math.round(audioContext.sampleRate)}Hz, compensating `
        + `${(latencySec * 1000).toFixed(1)}ms of output latency`);
    }

    for (const object of due) {
      // The music is at `currentTimeMs` right now and covers `speed` ms of map
      // per ms of wall clock, so this note is that far ahead -- minus what the
      // device will add after the context hands the sample over.
      const leadSec = ((object.time - currentTimeMs) / 1000) / speed;
      const startAt = Math.max(contextNowSec, (contextNowSec + leadSec) - latencySec);
      try {
        playHit(object, startAt, destination);
      } catch {
        // One bad voice must not stop the rest of the frame.
      }
    }

    return due.length;
  };

  const setEnabled = (nextEnabled) => {
    enabled = Boolean(nextEnabled);
    if (!enabled) {
      cancelScheduledVoices();
    }
  };

  const setVolume = (nextVolume) => {
    const numeric = Number(nextVolume);
    volume = Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 0;
    if (masterGain) {
      masterGain.gain.value = volume;
    }
  };

  const dispose = () => {
    if (audioContext) {
      void audioContext.close().catch(() => {});
    }
    audioContext = null;
    masterGain = null;
    mixBus = null;
    roomSend = null;
    voiceBus = null;
    noiseBuffer = null;
  };

  return {
    setEnabled, setVolume, syncTo, update, dispose,
  };
};

export {
  MAX_HITSOUND_EVENTS,
  buildHitsoundEvents,
  resolveEventSamples,
  HITSOUND_WHISTLE,
  HITSOUND_FINISH,
  HITSOUND_CLAP,
  SAMPLE_BANKS,
  MAX_CATCHUP_MS,
  SCHEDULE_LOOKAHEAD_SEC,
  DEFAULT_SAMPLE_VOLUME,
  collectScheduledEvents,
  findFirstIndexAtOrAfter,
  createHitsoundPlayer,
};
