// Experimental hitsounds.
//
// Sounds are synthesised rather than taken from the beatmap archive. Most
// archives ship no sample files at all -- osu! falls back to its default skin,
// which this extension cannot redistribute -- so pulling samples from the zip
// would leave the feature silent on the majority of maps. Generating them keeps
// it working everywhere and adds nothing to the download.
//
// Hits fire as the playhead crosses them rather than being scheduled ahead on
// the audio clock. That costs some timing precision (a frame, so up to ~16ms)
// but means seeking, speed changes and pausing need no separate bookkeeping:
// the sounds follow whatever the visual clock does.

// Bitmask from the .osu [HitObjects] format.
const HITSOUND_WHISTLE = 2;
const HITSOUND_FINISH = 4;
const HITSOUND_CLAP = 8;

// How far behind the playhead a crossed object may be and still sound. A frame
// is ~16ms; a stall, a tab switch or a long seek leaves a much bigger gap, and
// firing everything in it at once produces a machine-gun burst.
const MAX_CATCHUP_MS = 180;

// A slider makes a sound at every node, not just where it starts: the head, one
// at each reverse, and one at the tail. The .osu format carries a separate
// bitmask per node in `edgeSounds`, which the parser already keeps as
// `sliderEdgeSounds`, so the only work is turning nodes into timestamps.
//
// Guards against a pathological map turning into millions of voices.
const MAX_HITSOUND_EVENTS = 200000;

const getNodeHitSound = (object, nodeIndex) => {
  const edgeSounds = Array.isArray(object?.sliderEdgeSounds) ? object.sliderEdgeSounds : [];
  const value = Number(edgeSounds[nodeIndex]);
  // An absent or malformed edge entry inherits the object's own hitsound, which
  // is what osu! does for sliders that declare no per-edge sounds at all.
  return Number.isFinite(value) ? value : (Number(object?.hitSound) || 0);
};

/**
 * Flattens hit objects into the individual sounds the map should make, in time
 * order. Circles contribute one; sliders contribute one per node; spinners
 * sound when they finish.
 *
 * Objects that a ruleset conversion has already expanded into one object per
 * sound arrive here as plain circles, so they pass straight through rather than
 * being expanded a second time.
 */
const buildHitsoundEvents = (objects) => {
  const list = Array.isArray(objects) ? objects : [];
  const events = [];

  for (const object of list) {
    if (!object || !Number.isFinite(object.time)) {
      continue;
    }

    const startTime = object.time;
    const endTime = Number.isFinite(object.endTime) ? object.endTime : startTime;

    if (object.kind === 'spinner') {
      // A spinner is silent until it completes.
      events.push({ time: endTime, hitSound: Number(object.hitSound) || 0 });
      continue;
    }

    const slides = Math.max(1, Math.floor(Number(object.slides) || 1));
    const isSlider = object.kind === 'slider' && endTime > startTime;

    if (!isSlider || slides < 1) {
      events.push({ time: startTime, hitSound: Number(object.hitSound) || 0 });
      continue;
    }

    // `slides` counts spans, so a plain slider (1 span) has two nodes: head and
    // tail. Each extra span adds a reverse.
    const spanDuration = (endTime - startTime) / slides;
    for (let node = 0; node <= slides; node += 1) {
      events.push({
        time: startTime + (spanDuration * node),
        hitSound: getNodeHitSound(object, node),
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
  return events;
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
 * Objects crossed by moving the playhead from `fromMs` to `toMs`.
 *
 * Kept separate from playback so the cursor arithmetic can be tested without an
 * AudioContext. `cursor` is the index to resume scanning at; the caller stores
 * the returned one.
 */
const collectCrossedObjects = (objects, cursor, fromMs, toMs) => {
  const list = Array.isArray(objects) ? objects : [];
  if (list.length === 0 || !(toMs >= fromMs)) {
    return { hits: [], nextCursor: cursor };
  }

  // A jump forwards past the catch-up window is a seek, not playback: move the
  // cursor without sounding everything in between.
  const windowStartMs = Math.max(fromMs, toMs - MAX_CATCHUP_MS);
  let index = Math.max(0, Math.min(cursor, list.length));

  // Drops objects left far behind by a seek or a stall. Strictly-less-than, so
  // an object sitting exactly on the playhead still sounds -- that is the first
  // object of a map, and every object landing on a seek target. Objects already
  // played are excluded by the cursor, not by this window, so nothing repeats.
  while (index < list.length && list[index].time < windowStartMs) {
    index += 1;
  }

  const hits = [];
  while (index < list.length && list[index].time <= toMs) {
    hits.push(list[index]);
    index += 1;
  }

  return { hits, nextCursor: index };
};

const createHitsoundPlayer = ({ getAudioContext } = {}) => {
  let audioContext = null;
  let masterGain = null;
  let noiseBuffer = null;
  let enabled = false;
  let volume = 0.5;
  let cursor = 0;
  let lastTimeMs = 0;

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
      masterGain = audioContext.createGain();
      masterGain.gain.value = volume;
      masterGain.connect(audioContext.destination);

      // One short noise buffer, reused by every percussive voice.
      const frameCount = Math.floor(audioContext.sampleRate * 0.25);
      noiseBuffer = audioContext.createBuffer(1, frameCount, audioContext.sampleRate);
      const channel = noiseBuffer.getChannelData(0);
      for (let i = 0; i < frameCount; i += 1) {
        channel[i] = (Math.random() * 2) - 1;
      }
    } catch {
      audioContext = null;
      masterGain = null;
      noiseBuffer = null;
    }

    return audioContext;
  };

  const playNoise = ({ gain, durationSec, frequency, q = 1, type = 'bandpass' }) => {
    const source = audioContext.createBufferSource();
    source.buffer = noiseBuffer;

    const filter = audioContext.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;

    const envelope = audioContext.createGain();
    const now = audioContext.currentTime;
    envelope.gain.setValueAtTime(gain, now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(masterGain);
    source.start(now);
    source.stop(now + durationSec);
  };

  const playTone = ({ gain, durationSec, frequency, type = 'sine', endFrequency }) => {
    const oscillator = audioContext.createOscillator();
    oscillator.type = type;

    const now = audioContext.currentTime;
    oscillator.frequency.setValueAtTime(frequency, now);
    if (endFrequency) {
      oscillator.frequency.exponentialRampToValueAtTime(endFrequency, now + durationSec);
    }

    const envelope = audioContext.createGain();
    envelope.gain.setValueAtTime(gain, now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    oscillator.connect(envelope);
    envelope.connect(masterGain);
    oscillator.start(now);
    oscillator.stop(now + durationSec);
  };

  const playHit = (hitSound) => {
    const flags = Number.isFinite(hitSound) ? hitSound : 0;

    // hitnormal plays under every object, additions layer on top.
    playTone({ gain: 0.35, durationSec: 0.05, frequency: 320, endFrequency: 150 });
    playNoise({ gain: 0.16, durationSec: 0.035, frequency: 2600, q: 0.9 });

    if ((flags & HITSOUND_WHISTLE) !== 0) {
      playTone({ gain: 0.16, durationSec: 0.11, frequency: 1900, type: 'triangle' });
    }
    if ((flags & HITSOUND_CLAP) !== 0) {
      playNoise({ gain: 0.3, durationSec: 0.08, frequency: 1500, q: 0.7 });
    }
    if ((flags & HITSOUND_FINISH) !== 0) {
      playNoise({ gain: 0.24, durationSec: 0.42, frequency: 5200, q: 0.4, type: 'highpass' });
    }
  };

  /** Moves the cursor without sounding anything. Call after any jump. */
  const syncTo = (objects, timeMs) => {
    const list = Array.isArray(objects) ? objects : [];
    lastTimeMs = Number.isFinite(timeMs) ? timeMs : 0;
    cursor = findFirstIndexAtOrAfter(list, lastTimeMs);
  };

  const update = (objects, currentTimeMs) => {
    if (!Number.isFinite(currentTimeMs)) {
      return 0;
    }

    if (!enabled) {
      lastTimeMs = currentTimeMs;
      return 0;
    }

    // Going backwards is always a seek.
    if (currentTimeMs < lastTimeMs) {
      syncTo(objects, currentTimeMs);
      return 0;
    }

    const { hits, nextCursor } = collectCrossedObjects(objects, cursor, lastTimeMs, currentTimeMs);
    cursor = nextCursor;
    lastTimeMs = currentTimeMs;

    if (hits.length === 0) {
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

    for (const object of hits) {
      try {
        playHit(object?.hitSound);
      } catch {
        // One bad voice must not stop the rest of the frame.
      }
    }
    return hits.length;
  };

  const setEnabled = (nextEnabled) => {
    enabled = Boolean(nextEnabled);
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
    noiseBuffer = null;
  };

  return { setEnabled, setVolume, syncTo, update, dispose };
};

export {
  MAX_HITSOUND_EVENTS,
  buildHitsoundEvents,
  HITSOUND_WHISTLE,
  HITSOUND_FINISH,
  HITSOUND_CLAP,
  MAX_CATCHUP_MS,
  collectCrossedObjects,
  findFirstIndexAtOrAfter,
  createHitsoundPlayer,
};
