import {
  SAMPLE_SET_NORMAL,
  SAMPLE_SET_SOFT,
  SAMPLE_SET_DRUM,
} from '../parser.js';

// The other hitsound styles, in the same shape as SAMPLE_BANKS in hitsounds.js.
//
// None of these skins' samples ship with the extension. The skins carry no
// licence that allows it, and osu!'s own resources are CC-BY-NC, so each style
// is the reference sample re-made from the layers the player knows: tones at
// the sample's measured partials and filtered noise, each with its own attack
// and decay, and its own delay where the sample strikes twice -- a flam, or a
// clap's later bursts.
//
// The fit weighs the onset most, because that is where a hit's punch is: band
// energy over time (long windows for the low body, short ones for the
// transient), the millisecond envelope of the attack, and a fine spectrum that
// keeps the tones on the sample's own pitch. Every parameter of every layer was
// then refined numerically against all three, and layers the fit barely needed
// were dropped, since each one is a few audio nodes per hit.
//
// Each style keeps its skin's balance between sounds -- a loud clap stays loud
// next to its hitnormal -- and is set as loud as its loudest stack allows: the
// worst hitnormal-plus-addition runs about 2dB into the soft clipper, which
// flattens it much as these skins' own limiters flatten their samples. Nothing
// here is matched to Argon.
//
// Low body is always tonal. Narrow noise down there would be a tone whose level
// changed from hit to hit, which is the opposite of punch.
//
// Where a skin plays the same sample for several banks, the style shares one
// voice between them rather than inventing a difference the skin does not have.
//
// Minimal is deliberately not its skin's samples exactly. The skin hits with
// pitched pings that ring on for tens of milliseconds, and played on every
// note that reads as resonance rather than as a hit. Its fit target is each
// sample with its strike and body kept and the ring after them cut short; its
// voices are held to fairly broad noise and to tones that are struck once and
// gone within about 120ms. A fit that weighs the onset most keeps its clicks
// loud, and every sound becomes a snap, so where one came out sharper than its
// target its clicks were turned down and the sound brought back to its level.
// The clap never rang, and is the plain fit to its sample.

/**
 * The default samples osu!lazer plays. The fullest of the styles: normal's
 * hitnormal is a woody knock with a bright hiss over it, soft's a high metallic
 * tick, drum's a low kick, and the finishes are long crashes.
 */
export const LAZER_BANKS = {
  [SAMPLE_SET_NORMAL]: {
    normal: [
      { kind: 'noise', gain: 0.519, durationSec: 0.0142, attackSec: 0.0003, frequency: 9466, q: 0.59 },
      { kind: 'tone', gain: 0.2312, durationSec: 0.076, attackSec: 0.0101, frequency: 441 },
      { kind: 'tone', gain: 0.1584, durationSec: 0.236, attackSec: 0.0189, frequency: 236 },
      { kind: 'tone', gain: 0.08181, durationSec: 0.2922, attackSec: 0.0151, frequency: 232 },
      { kind: 'noise', gain: 0.4787, durationSec: 0.4497, attackSec: 0.0045, frequency: 792, q: 0.85 },
      { kind: 'noise', gain: 0.6334, durationSec: 0.4043, attackSec: 0.0003, frequency: 8904, q: 2.04 },
      { kind: 'noise', gain: 0.2606, durationSec: 0.3722, attackSec: 0.0352, frequency: 5616, q: 0.5 },
    ],
    whistle: [
      { kind: 'tone', gain: 0.1247, durationSec: 0.1584, attackSec: 0.0108, frequency: 364 },
      { kind: 'tone', gain: 0.1011, durationSec: 0.4025, attackSec: 0.0054, frequency: 998 },
      { kind: 'tone', gain: 0.08886, durationSec: 0.2655, attackSec: 0.0095, frequency: 656 },
      { kind: 'noise', gain: 0.2865, durationSec: 0.4515, attackSec: 0.0237, frequency: 2984, q: 0.35 },
      { kind: 'noise', gain: 1.087, durationSec: 0.1624, attackSec: 0.0206, frequency: 426, q: 2.1 },
      { kind: 'noise', gain: 0.4733, durationSec: 0.0948, attackSec: 0.0039, frequency: 2424, q: 0.7 },
      { kind: 'noise', gain: 1.172, durationSec: 0.0676, frequency: 8668, q: 3.38 },
    ],
    finish: [
      { kind: 'tone', gain: 0.1467, durationSec: 0.5056, attackSec: 0.0315, frequency: 103 },
      { kind: 'tone', gain: 0.1121, durationSec: 1.1395, frequency: 2198 },
      { kind: 'tone', gain: 0.2079, durationSec: 0.0752, attackSec: 0.0012, delaySec: 0.01, frequency: 271 },
      { kind: 'noise', gain: 0.4827, durationSec: 1.1287, attackSec: 0.0259, frequency: 4175, q: 0.56 },
      { kind: 'noise', gain: 0.3854, durationSec: 1.1079, attackSec: 0.0061, frequency: 767, q: 0.3 },
      { kind: 'noise', gain: 0.1801, durationSec: 1.0992, attackSec: 0.009, frequency: 12175, q: 0.45 },
      { kind: 'noise', gain: 0.7327, durationSec: 0.0296, frequency: 6467, q: 0.86 },
    ],
    clap: [
      { kind: 'noise', gain: 0.9926, durationSec: 0.0248, frequency: 7961, q: 1.35 },
      { kind: 'tone', gain: 0.1003, durationSec: 0.4681, attackSec: 0.0112, frequency: 1005 },
      { kind: 'tone', gain: 0.05471, durationSec: 0.1576, attackSec: 0.0161, frequency: 185 },
      { kind: 'noise', gain: 0.6385, durationSec: 0.4834, attackSec: 0.0259, frequency: 2164, q: 0.93 },
      { kind: 'noise', gain: 0.3229, durationSec: 0.3953, attackSec: 0.0033, frequency: 2544, endFrequency: 1302, q: 0.51 },
      { kind: 'noise', gain: 1.021, durationSec: 0.1369, attackSec: 0.0009, delaySec: 0.0404, frequency: 1194, q: 1.16 },
    ],
  },
  [SAMPLE_SET_SOFT]: {
    normal: [
      { kind: 'noise', gain: 0.4878, durationSec: 0.0153, attackSec: 0.0005, delaySec: 0.012, frequency: 4444, q: 1.27 },
      { kind: 'tone', gain: 0.1211, durationSec: 0.1773, attackSec: 0.0007, frequency: 7244 },
      { kind: 'tone', gain: 0.05873, durationSec: 0.5665, attackSec: 0.0034, frequency: 7250 },
      { kind: 'noise', gain: 0.1914, durationSec: 0.9291, attackSec: 0.0051, frequency: 7637, q: 1.17 },
      { kind: 'noise', gain: 0.3146, durationSec: 0.3021, attackSec: 0.0047, frequency: 12330, q: 1.04 },
      { kind: 'noise', gain: 0.3733, durationSec: 0.1432, frequency: 9948, q: 2.4 },
    ],
    whistle: [
      { kind: 'tone', gain: 0.03327, durationSec: 1.0446, attackSec: 0.0033, frequency: 2088 },
      { kind: 'noise', gain: 0.3232, durationSec: 1.0244, attackSec: 0.0026, frequency: 5558, q: 1.36 },
      { kind: 'noise', gain: 0.3443, durationSec: 0.904, frequency: 10266, q: 1.37 },
      { kind: 'noise', gain: 0.2641, durationSec: 0.1274, delaySec: 0.01, frequency: 1589, q: 0.38 },
      { kind: 'noise', gain: 1.642, durationSec: 0.0382, attackSec: 0.002, delaySec: 0.026, frequency: 145, q: 1.4 },
      { kind: 'noise', gain: 1.044, durationSec: 0.0424, attackSec: 0.001, delaySec: 0.0395, frequency: 65, q: 1.95 },
    ],
    finish: [
      { kind: 'noise', gain: 1.183, durationSec: 0.0135, delaySec: 0.006, frequency: 1258, q: 0.62 },
      { kind: 'tone', gain: 0.1511, durationSec: 0.1739, attackSec: 0.0131, frequency: 418 },
      { kind: 'tone', gain: 0.08937, durationSec: 0.6132, attackSec: 0.0035, frequency: 2334 },
      { kind: 'tone', gain: 0.0574, durationSec: 0.3265, attackSec: 0.0081, frequency: 418 },
      { kind: 'noise', gain: 0.3649, durationSec: 1.0258, frequency: 5608, q: 1.1 },
      { kind: 'noise', gain: 0.08124, durationSec: 0.7347, attackSec: 0.0042, frequency: 569, q: 1.3 },
    ],
    clap: [
      { kind: 'noise', gain: 0.9634, durationSec: 0.025, frequency: 8652, q: 1.52 },
      { kind: 'noise', gain: 1.179, durationSec: 0.0237, delaySec: 0.0125, frequency: 3718, q: 0.98 },
      { kind: 'tone', gain: 0.1069, durationSec: 0.4085, attackSec: 0.0157, frequency: 1273 },
      { kind: 'noise', gain: 0.3529, durationSec: 0.5199, attackSec: 0.0024, frequency: 2171, q: 1.02 },
      { kind: 'noise', gain: 0.5847, durationSec: 0.4538, attackSec: 0.0247, frequency: 1766, q: 0.97 },
      { kind: 'noise', gain: 0.2647, durationSec: 0.038, attackSec: 0.003, frequency: 212, q: 0.67 },
    ],
  },
  [SAMPLE_SET_DRUM]: {
    normal: [
      { kind: 'noise', gain: 1.868, durationSec: 0.006, frequency: 2500, q: 1.3 },
      { kind: 'tone', gain: 0.1747, durationSec: 0.2839, attackSec: 0.0161, frequency: 158 },
      { kind: 'tone', gain: 0.09252, durationSec: 0.721, attackSec: 0.0049, frequency: 159 },
      { kind: 'tone', gain: 0.1856, durationSec: 0.1251, attackSec: 0.0003, delaySec: 0.0189, frequency: 208 },
      { kind: 'noise', gain: 0.4523, durationSec: 1.15, attackSec: 0.0003, frequency: 426, endFrequency: 149, q: 1.17 },
      { kind: 'noise', gain: 0.4114, durationSec: 0.6206, attackSec: 0.0025, frequency: 2784, endFrequency: 2757, q: 0.45 },
      { kind: 'noise', gain: 1.11, durationSec: 0.0494, attackSec: 0.0007, frequency: 6209, q: 1.05 },
    ],
    whistle: [
      { kind: 'tone', gain: 0.02067, durationSec: 0.4495, attackSec: 0.006, frequency: 240 },
      { kind: 'noise', gain: 0.2264, durationSec: 0.7108, attackSec: 0.0092, frequency: 400, q: 0.25 },
      { kind: 'noise', gain: 0.1072, durationSec: 0.6843, attackSec: 0.0026, frequency: 4200, q: 3.96, type: 'highpass' },
      { kind: 'noise', gain: 0.5273, durationSec: 0.3136, attackSec: 0.0009, frequency: 5730, endFrequency: 5720, q: 0.59 },
      { kind: 'noise', gain: 1.742, durationSec: 0.2248, attackSec: 0.0057, frequency: 486, q: 3.11 },
    ],
    finish: [
      { kind: 'tone', gain: 0.3483, durationSec: 0.1147, attackSec: 0.0113, frequency: 217 },
      { kind: 'tone', gain: 0.2758, durationSec: 0.6598, attackSec: 0.0279, frequency: 95 },
      { kind: 'tone', gain: 0.4754, durationSec: 0.1126, attackSec: 0.0007, delaySec: 0.0284, frequency: 92 },
      { kind: 'noise', gain: 0.3706, durationSec: 0.5503, attackSec: 0.0125, frequency: 536, q: 0.27 },
      { kind: 'noise', gain: 0.3517, durationSec: 0.484, attackSec: 0.0205, frequency: 6110, q: 0.85 },
      { kind: 'noise', gain: 0.8446, durationSec: 0.1014, attackSec: 0.0009, frequency: 1271, q: 0.54 },
    ],
    clap: [
      { kind: 'tone', gain: 0.3614, durationSec: 0.1192, attackSec: 0.0158, frequency: 218 },
      { kind: 'tone', gain: 0.3217, durationSec: 0.5929, attackSec: 0.0003, delaySec: 0.0316, frequency: 107 },
      { kind: 'tone', gain: 0.7136, durationSec: 0.1677, attackSec: 0.0003, delaySec: 0.0375, frequency: 107 },
      { kind: 'noise', gain: 3.043, durationSec: 0.338, attackSec: 0.0053, frequency: 199, q: 2.03 },
      { kind: 'noise', gain: 0.4661, durationSec: 0.2886, attackSec: 0.0236, frequency: 4668, q: 1.52 },
      { kind: 'noise', gain: 0.9154, durationSec: 0.1315, frequency: 4749, q: 3.29 },
      { kind: 'noise', gain: 0.9057, durationSec: 0.082, attackSec: 0.0038, frequency: 1072, q: 1.45 },
    ],
  },
};

/**
 * After Wintherest, made thacky. Everything is short: one ~1.7kHz tick for every
 * hitnormal, and a single whistle, finish and clap shared by all three banks.
 * The tick is mostly noise in that band, over a short tone at its pitch: as a
 * pure tone it was most of the hit, and rang on every note however short it
 * was. The tone comes in over 4ms rather than at once, which keeps the hit
 * from turning into a snap now that there is less noise around it. The finish is fitted to 404 SkinNotFound's instead -- Wintherest's was
 * nearly all a pure ~790Hz tone -- keeping more of its tail than the other
 * sounds keep of theirs, and at 404's balance against its hitnormal (2.8dB
 * over it), so it carries past the tick rather than sitting under it. Most of
 * its energy is in its tone rather than its noise: over a hitnormal that is
 * itself mostly noise, a noisy finish blurred into it.
 */
const MINIMAL_HITNORMAL = [
  { kind: 'noise', gain: 1.308, durationSec: 0.0074, delaySec: 0.006, frequency: 1259, q: 1.14 },
  { kind: 'tone', gain: 0.3268, durationSec: 0.04, attackSec: 0.004, frequency: 1699 },
  { kind: 'tone', gain: 0.04016, durationSec: 0.0572, frequency: 280, endFrequency: 133 },
  { kind: 'noise', gain: 0.8524, durationSec: 0.1231, attackSec: 0.0005, frequency: 1035, q: 1.25 },
  { kind: 'noise', gain: 0.9004, durationSec: 0.0935, attackSec: 0.0005, frequency: 1699, q: 1.3 },
  { kind: 'noise', gain: 0.1834, durationSec: 0.0824, delaySec: 0.0197, frequency: 260, q: 0.5 },
];

const MINIMAL_WHISTLE = [
  { kind: 'tone', gain: 0.2166, durationSec: 0.104, attackSec: 0.0013, frequency: 1462 },
  { kind: 'tone', gain: 0.1463, durationSec: 0.0946, attackSec: 0.0013, frequency: 259 },
  { kind: 'noise', gain: 1.066, durationSec: 0.1234, attackSec: 0.0014, frequency: 538, endFrequency: 217, q: 0.95 },
  { kind: 'noise', gain: 1.213, durationSec: 0.1088, attackSec: 0.0003, frequency: 3454, q: 1.43 },
  { kind: 'noise', gain: 0.3715, durationSec: 0.0686, delaySec: 0.0302, frequency: 296, q: 0.89 },
  { kind: 'noise', gain: 0.06428, durationSec: 0.0527, attackSec: 0.0018, delaySec: 0.0402, frequency: 3428, q: 1.45 },
];

const MINIMAL_FINISH = [
  { kind: 'tone', gain: 0.5198, durationSec: 0.1951, attackSec: 0.0006, frequency: 962 },
  { kind: 'noise', gain: 1.319, durationSec: 0.2454, delaySec: 0.01, frequency: 842, q: 1.5 },
  { kind: 'noise', gain: 0.869, durationSec: 0.1974, delaySec: 0.0402, frequency: 846, q: 1.5 },
];

const MINIMAL_CLAP = [
  { kind: 'tone', gain: 0.08214, durationSec: 0.0338, attackSec: 0.0005, frequency: 233 },
  { kind: 'tone', gain: 0.5129, durationSec: 0.0154, attackSec: 0.0003, delaySec: 0.01, frequency: 141 },
  { kind: 'noise', gain: 4.594, durationSec: 0.1775, attackSec: 0.0005, frequency: 1800, q: 3.82 },
  { kind: 'noise', gain: 0.6561, durationSec: 0.0955, delaySec: 0.0499, frequency: 2256, q: 2.94 },
];

export const MINIMAL_BANKS = {
  [SAMPLE_SET_NORMAL]: {
    normal: MINIMAL_HITNORMAL,
    whistle: MINIMAL_WHISTLE,
    finish: MINIMAL_FINISH,
    clap: MINIMAL_CLAP,
  },
  [SAMPLE_SET_SOFT]: {
    normal: MINIMAL_HITNORMAL,
    whistle: MINIMAL_WHISTLE,
    finish: MINIMAL_FINISH,
    clap: MINIMAL_CLAP,
  },
  [SAMPLE_SET_DRUM]: {
    normal: MINIMAL_HITNORMAL,
    whistle: MINIMAL_WHISTLE,
    finish: MINIMAL_FINISH,
    clap: MINIMAL_CLAP,
  },
};
