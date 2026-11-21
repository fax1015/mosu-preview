// osu!taiko's drum, as osu!lazer's default skin (Argon) plays it.
//
// In taiko nothing sounds because an object was reached: the drum sounds when
// it is struck, and lazer's autoplay strikes a centre for a don and a rim for a
// kat, both halves at once for a big note. What the strike plays depends only
// on that (DrumSampleTriggerSource, ArgonDrumSampleTriggerSource):
//
//   don        the centre voice, from the tier the hit's volume falls in
//   kat        the rim voice, likewise
//   big don    the strong centre voice, at any volume
//   big kat    the strong rim voice, plus a flourish if one is due
//
// Argon picks the tier by volume and ignores the bank the map names
// (VolumeAwareHitSampleInfo): most taiko maps keep to one bank and ride the
// volume instead, so quiet sections get the soft drum rather than just a
// quieter one.
//
// The voices are synthesised like every other hitsound here. They were fitted
// to lazer's own Argon taiko samples (ppy/osu-resources, CC-BY-NC 4.0), which
// were used only as references and are not shipped; only these layer
// parameters are. Each voice is set to one loudness and hitsounds.js levels
// them per style; the dons' low body (tones under 250Hz) is then lifted 2dB
// over the fit, for more thump.

const TAIKO_VOLUME_HARD = 90;
const TAIKO_VOLUME_MEDIUM = 60;

// Strong rim hits get a flourish at most this often. lazer decides it walking
// back from the latest strong rim, so a run of them flourishes at its end.
const TAIKO_FLOURISH_SPACING_MS = 2000;

// @generated-taiko-voices-start
const TAIKO_DRUM = Object.freeze({
  centre: Object.freeze({
    soft: [
      { kind: 'tone', gain: 0.3035, durationSec: 0.0696, attackSec: 0.0281, frequency: 131 },
      { kind: 'tone', gain: 0.2418, durationSec: 0.3991, attackSec: 0.0045, frequency: 123 },
      { kind: 'noise', gain: 0.1226, durationSec: 0.2443, attackSec: 0.0008, frequency: 886, q: 3.54 },
      { kind: 'noise', gain: 0.1005, durationSec: 0.5893, attackSec: 0.0201, frequency: 414, q: 2.2 },
      { kind: 'tone', gain: 0.07431, durationSec: 0.2262, attackSec: 0.0003, frequency: 308 },
      { kind: 'tone', gain: 0.06486, durationSec: 0.0556, attackSec: 0.003, frequency: 644, endFrequency: 166 },
      { kind: 'tone', gain: 0.05052, durationSec: 0.259, attackSec: 0.06, frequency: 219 },
    ],
    normal: [
      { kind: 'noise', gain: 0.488, durationSec: 0.6398, attackSec: 0.005, frequency: 479, q: 4 },
      { kind: 'noise', gain: 0.4176, durationSec: 0.0328, attackSec: 0.0003, frequency: 1885, q: 2.17 },
      { kind: 'tone', gain: 0.1333, durationSec: 0.7246, attackSec: 0.0078, frequency: 136 },
      { kind: 'tone', gain: 0.1275, durationSec: 0.613, attackSec: 0.0038, frequency: 66.2 },
      { kind: 'tone', gain: 0.08204, durationSec: 0.7544, attackSec: 0.0014, frequency: 212, endFrequency: 177 },
      { kind: 'tone', gain: 0.0585, durationSec: 0.6172, attackSec: 0.0003, frequency: 316, endFrequency: 315 },
      { kind: 'tone', gain: 0.02381, durationSec: 0.3549, attackSec: 0.0029, frequency: 798 },
    ],
    drum: [
      { kind: 'noise', gain: 1.205, durationSec: 0.0747, attackSec: 0.0021, frequency: 571, q: 3.2 },
      { kind: 'noise', gain: 0.6112, durationSec: 0.0343, frequency: 2486, q: 3.13 },
      { kind: 'noise', gain: 0.4489, durationSec: 0.9351, attackSec: 0.0179, frequency: 532, q: 3.97 },
      { kind: 'tone', gain: 0.1052, durationSec: 0.9892, attackSec: 0.004, frequency: 134 },
      { kind: 'tone', gain: 0.08145, durationSec: 0.9066, attackSec: 0.012, frequency: 70.6 },
      { kind: 'tone', gain: 0.07922, durationSec: 0.9797, attackSec: 0.0003, frequency: 206 },
      { kind: 'tone', gain: 0.05918, durationSec: 0.9074, attackSec: 0.0003, frequency: 313 },
    ],
    strong: [
      { kind: 'noise', gain: 0.6726, durationSec: 0.0779, attackSec: 0.0015, frequency: 2327, q: 2.97 },
      { kind: 'noise', gain: 0.5591, durationSec: 1.9, attackSec: 0.0007, frequency: 400, q: 2.21 },
      { kind: 'noise', gain: 0.2581, durationSec: 0.4522, attackSec: 0.0016, frequency: 802, q: 0.55 },
      { kind: 'noise', gain: 0.08608, durationSec: 0.0172, attackSec: 0.0011, frequency: 5258, q: 4, type: 'highpass' },
      { kind: 'tone', gain: 0.06605, durationSec: 0.1621, attackSec: 0.0003, frequency: 262 },
      { kind: 'tone', gain: 0.07757, durationSec: 1.9, attackSec: 0.0029, frequency: 118 },
      { kind: 'tone', gain: 0.04931, durationSec: 1.9, attackSec: 0.0176, frequency: 72.5 },
      { kind: 'tone', gain: 0.04644, durationSec: 1.9, attackSec: 0.0038, frequency: 202 },
    ],
  }),
  rim: Object.freeze({
    soft: [
      { kind: 'noise', gain: 2.613, durationSec: 0.0427, frequency: 2494, q: 3.87 },
      { kind: 'noise', gain: 0.285, durationSec: 0.3242, attackSec: 0.0003, frequency: 1510, q: 3.52 },
      { kind: 'noise', gain: 0.1524, durationSec: 0.504, attackSec: 0.0019, frequency: 2682, q: 3.77 },
      { kind: 'noise', gain: 0.1475, durationSec: 0.7438, attackSec: 0.0229, frequency: 629, q: 1.24 },
      { kind: 'tone', gain: 0.03985, durationSec: 0.2467, frequency: 800 },
      { kind: 'tone', gain: 0.03337, durationSec: 0.2936, attackSec: 0.0003, frequency: 1147 },
      { kind: 'noise', gain: 0.2487, durationSec: 0.0546, attackSec: 0.001, delaySec: 0.0115, frequency: 401, q: 2.24 },
    ],
    normal: [
      { kind: 'noise', gain: 2.192, durationSec: 0.0263, frequency: 2657, q: 4 },
      { kind: 'noise', gain: 0.5091, durationSec: 0.3276, attackSec: 0.0244, frequency: 947, q: 3.83 },
      { kind: 'noise', gain: 0.3288, durationSec: 0.8692, attackSec: 0.0034, frequency: 524, q: 3.66 },
      { kind: 'tone', gain: 0.2543, durationSec: 0.054, frequency: 986, endFrequency: 246 },
      { kind: 'tone', gain: 0.05714, durationSec: 0.2173, attackSec: 0.0013, frequency: 1286 },
      { kind: 'tone', gain: 0.05595, durationSec: 0.5361, attackSec: 0.0141, frequency: 622 },
      { kind: 'tone', gain: 0.02914, durationSec: 0.275, frequency: 2002 },
    ],
    drum: [
      { kind: 'noise', gain: 1.669, durationSec: 0.0333, frequency: 2241, q: 1.77 },
      { kind: 'noise', gain: 0.3236, durationSec: 0.4684, attackSec: 0.0027, frequency: 1534, q: 3.83 },
      { kind: 'tone', gain: 0.06375, durationSec: 0.6968, attackSec: 0.0094, frequency: 499 },
      { kind: 'tone', gain: 0.06296, durationSec: 0.3884, attackSec: 0.0056, frequency: 979 },
      { kind: 'tone', gain: 0.0562, durationSec: 0.5639, attackSec: 0.015, frequency: 632 },
      { kind: 'tone', gain: 0.01842, durationSec: 0.7837, attackSec: 0.018, frequency: 354 },
      { kind: 'noise', gain: 0.3028, durationSec: 0.3248, delaySec: 0.0279, frequency: 651, q: 0.98 },
    ],
    strong: [
      { kind: 'noise', gain: 2.377, durationSec: 0.0109, attackSec: 0.0003, frequency: 406, q: 3.59 },
      { kind: 'noise', gain: 0.3617, durationSec: 1.9, attackSec: 0.0327, frequency: 400, q: 1.04 },
      { kind: 'noise', gain: 0.2437, durationSec: 1.6911, attackSec: 0.0047, frequency: 400, q: 0.27 },
      { kind: 'noise', gain: 0.2303, durationSec: 0.1428, attackSec: 0.0015, frequency: 3517, q: 0.75 },
      { kind: 'tone', gain: 0.04906, durationSec: 1.6617, attackSec: 0.0196, frequency: 516 },
      { kind: 'tone', gain: 0.02363, durationSec: 1.9, attackSec: 0.0015, frequency: 208 },
    ],
  }),
  flourish: [
    { kind: 'noise', gain: 0.1371, durationSec: 1.15, attackSec: 0.0599, frequency: 873, q: 1.79 },
    { kind: 'tone', gain: 0.03619, durationSec: 1.15, attackSec: 0.0442, frequency: 2571 },
    { kind: 'noise', gain: 0.03369, durationSec: 1.15, attackSec: 0.0354, frequency: 5002, q: 3.86 },
    { kind: 'noise', gain: 0.02966, durationSec: 1.1432, attackSec: 0.0076, frequency: 2227, q: 2.91 },
    { kind: 'tone', gain: 0.01964, durationSec: 1.15, attackSec: 0.0259, frequency: 411 },
    { kind: 'tone', gain: 0.01177, durationSec: 1.15, attackSec: 0.0117, frequency: 3269 },
    { kind: 'tone', gain: 0.004416, durationSec: 1.15, attackSec: 0.0017, frequency: 3319 },
  ],
});
// @generated-taiko-voices-end

const getTaikoDrumTier = (volume) => {
  const raw = volume == null || (typeof volume === 'string' && volume.trim() === '')
    ? Number.NaN
    : Number(volume);
  const numeric = Number.isFinite(raw) ? raw : 100;
  if (numeric >= TAIKO_VOLUME_HARD) {
    return 'drum';
  }
  return numeric >= TAIKO_VOLUME_MEDIUM ? 'normal' : 'soft';
};

/** The layer stacks one drum event plays, in order. */
const getTaikoDrumVoices = (event, drum = TAIKO_DRUM) => {
  const side = event?.drum === 'rim' ? drum.rim : drum.centre;
  const voices = [event?.strong ? side.strong : side[getTaikoDrumTier(event?.volume)]];
  if (event?.flourish) {
    voices.push(drum.flourish);
  }
  return voices;
};

/**
 * Marks which strong rim hits flourish, the way ArgonFlourishTriggerSource
 * does: walking back from the last one, a hit flourishes when the last
 * flourish found is at least the spacing after it. lazer only walks the
 * objects alive on screen; this walks the whole map, which agrees except where
 * a run of strong rims is longer than the screen. `events` must be in time
 * order; they are marked in place.
 */
const markTaikoFlourishes = (events) => {
  let lastFlourishMs = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.drum !== 'rim' || !event.strong) {
      continue;
    }
    const flourish = lastFlourishMs === null || (lastFlourishMs - event.time) >= TAIKO_FLOURISH_SPACING_MS;
    if (flourish) {
      lastFlourishMs = event.time;
    }
    event.flourish = flourish;
  }
  return events;
};

export {
  TAIKO_DRUM,
  TAIKO_FLOURISH_SPACING_MS,
  TAIKO_VOLUME_HARD,
  TAIKO_VOLUME_MEDIUM,
  getTaikoDrumTier,
  getTaikoDrumVoices,
  markTaikoFlourishes,
};
