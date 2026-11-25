// Colours for the collapsed miniplayer, taken from the beatmap's cover art.
//
// The cover is sampled down to a few hundred pixels, the most colourful hue in
// it is picked as the seed, and every colour the mini-bar paints is a tone of
// that one hue at a fixed lightness, in OKLCH. Fixing the lightness rather than
// the chroma is what keeps the bar readable whatever the cover is: a neon pink
// cover and a muted brown one give a pink and a brown bar of the same contrast.
//
// Kept free of DOM APIs so it can be unit tested; src/ui/miniTheme.js does the
// fetching and the painting.

import { clamp } from './math.js';

// Colours the mini-bar uses when there is no cover, or the cover has no colour
// worth taking (black and white art, a failed fetch). The extension's own
// greys and purple, as in the design.
const DEFAULT_MINI_PALETTE = Object.freeze({
  surface: Object.freeze([36, 34, 42]),
  surfaceHigh: Object.freeze([53, 50, 63]),
  onSurface: Object.freeze([241, 239, 248]),
  onSurfaceVariant: Object.freeze([188, 183, 206]),
  primaryContainer: Object.freeze([67, 52, 127]),
  onPrimaryContainer: Object.freeze([226, 217, 255]),
  secondaryContainer: Object.freeze([52, 45, 79]),
  onSecondaryContainer: Object.freeze([184, 172, 255]),
  accent: Object.freeze([184, 172, 255]),
  playContainer: Object.freeze([236, 233, 246]),
  onPlayContainer: Object.freeze([31, 29, 38]),
});

const PALETTE_KEYS = Object.freeze(Object.keys(DEFAULT_MINI_PALETTE));

// Each role as an OKLCH lightness and a chroma budget: the share of the seed's
// own chroma it takes, never more than the cap and never less than the floor.
// Surfaces stay near grey, containers carry the colour.
const ROLE_TONES = Object.freeze({
  surface: { l: 0.255, share: 0.22, min: 0.008, max: 0.024 },
  surfaceHigh: { l: 0.335, share: 0.28, min: 0.01, max: 0.032 },
  onSurface: { l: 0.965, share: 0.06, min: 0, max: 0.012 },
  onSurfaceVariant: { l: 0.8, share: 0.3, min: 0.01, max: 0.036 },
  primaryContainer: { l: 0.4, share: 0.85, min: 0.05, max: 0.13 },
  onPrimaryContainer: { l: 0.92, share: 0.4, min: 0.02, max: 0.06 },
  secondaryContainer: { l: 0.32, share: 0.5, min: 0.03, max: 0.07 },
  onSecondaryContainer: { l: 0.83, share: 0.8, min: 0.04, max: 0.11 },
  accent: { l: 0.82, share: 0.85, min: 0.05, max: 0.13 },
  playContainer: { l: 0.945, share: 0.14, min: 0.004, max: 0.022 },
  onPlayContainer: { l: 0.235, share: 0.2, min: 0.006, max: 0.03 },
});

// Pixels this close to grey, or this dark or bright, say nothing about the
// cover's colour: a black border or a white sky would otherwise outvote it.
const MIN_SEED_CHROMA = 0.035;
const MIN_SEED_LIGHTNESS = 0.18;
const MAX_SEED_LIGHTNESS = 0.94;
// A hue has to hold at least this share of the counted pixels to be picked, so
// a few coloured pixels in an otherwise grey cover do not tint the whole bar.
const MIN_SEED_SHARE = 0.03;
const HUE_BINS = 36;

const srgbToLinear = (channel) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const linearToSrgb = (channel) => {
  const c = channel <= 0.0031308 ? channel * 12.92 : (1.055 * (channel ** (1 / 2.4))) - 0.055;
  return c * 255;
};

/** sRGB bytes to OKLab, as [L, a, b]. */
const rgbToOklab = (r, g, b) => {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt((0.4122214708 * lr) + (0.5363325363 * lg) + (0.0514459929 * lb));
  const m = Math.cbrt((0.2119034982 * lr) + (0.6806995451 * lg) + (0.1073969566 * lb));
  const s = Math.cbrt((0.0883024619 * lr) + (0.2817188376 * lg) + (0.6299787005 * lb));
  return [
    (0.2104542553 * l) + (0.793617785 * m) - (0.0040720468 * s),
    (1.9779984951 * l) - (2.428592205 * m) + (0.4505937099 * s),
    (0.0259040371 * l) + (0.7827717662 * m) - (0.808675766 * s),
  ];
};

/** OKLab to unclamped sRGB channels (0-255, possibly out of range). */
const oklabToRgbUnclamped = (lightness, a, b) => {
  const l = (lightness + (0.3963377774 * a) + (0.2158037573 * b)) ** 3;
  const m = (lightness - (0.1055613458 * a) - (0.0638541728 * b)) ** 3;
  const s = (lightness - (0.0894841775 * a) - (1.291485548 * b)) ** 3;
  return [
    linearToSrgb((4.0767416621 * l) - (3.3077115913 * m) + (0.2309699292 * s)),
    linearToSrgb((-1.2684380046 * l) + (2.6097574011 * m) - (0.3413193965 * s)),
    linearToSrgb((-0.0041960863 * l) - (0.7034186147 * m) + (1.707614701 * s)),
  ];
};

const isInGamut = (channels) => channels.every((value) => value >= -0.5 && value <= 255.5);

/**
 * An OKLCH colour as sRGB bytes. Colours outside sRGB keep their lightness and
 * hue and lose chroma until they fit, which is how a tone stays a tone.
 */
const oklchToRgb = (lightness, chroma, hueDegrees) => {
  const hue = (hueDegrees * Math.PI) / 180;
  const toRgb = (c) => oklabToRgbUnclamped(lightness, c * Math.cos(hue), c * Math.sin(hue));
  let channels = toRgb(chroma);
  if (!isInGamut(channels)) {
    let low = 0;
    let high = chroma;
    for (let step = 0; step < 18; step += 1) {
      const mid = (low + high) / 2;
      if (isInGamut(toRgb(mid))) {
        low = mid;
      } else {
        high = mid;
      }
    }
    channels = toRgb(low);
  }
  return channels.map((value) => Math.round(clamp(value, 0, 255)));
};

/**
 * The cover's seed colour, from RGBA pixel data (an ImageData's `data`).
 * Returns `{ hue, chroma }` in OKLCH, or null when the cover has no colour
 * strong enough to theme by.
 */
const extractCoverSeed = (pixels) => {
  if (!pixels || typeof pixels.length !== 'number' || pixels.length < 4) {
    return null;
  }
  const weights = new Float64Array(HUE_BINS);
  const sumA = new Float64Array(HUE_BINS);
  const sumB = new Float64Array(HUE_BINS);
  const counts = new Uint32Array(HUE_BINS);
  let counted = 0;

  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) {
      continue;
    }
    counted += 1;
    const [lightness, a, b] = rgbToOklab(pixels[index], pixels[index + 1], pixels[index + 2]);
    const chroma = Math.hypot(a, b);
    if (chroma < MIN_SEED_CHROMA || lightness < MIN_SEED_LIGHTNESS || lightness > MAX_SEED_LIGHTNESS) {
      continue;
    }
    let hue = (Math.atan2(b, a) * 180) / Math.PI;
    if (hue < 0) {
      hue += 360;
    }
    const bin = Math.floor(hue / (360 / HUE_BINS)) % HUE_BINS;
    // Vivid, mid-lightness pixels speak loudest: they are what the eye reads
    // as the cover's colour.
    const weight = chroma * (1 - (Math.abs(lightness - 0.62) * 0.9));
    weights[bin] += weight;
    sumA[bin] += a * weight;
    sumB[bin] += b * weight;
    counts[bin] += 1;
  }

  if (counted === 0) {
    return null;
  }

  // A hue is scored together with its neighbours, so a colour that happens to
  // sit on a bin edge is not split in two and outvoted.
  let bestBin = -1;
  let bestScore = 0;
  for (let bin = 0; bin < HUE_BINS; bin += 1) {
    const previous = (bin + HUE_BINS - 1) % HUE_BINS;
    const next = (bin + 1) % HUE_BINS;
    const score = weights[bin] + (0.5 * (weights[previous] + weights[next]));
    if (score > bestScore) {
      bestScore = score;
      bestBin = bin;
    }
  }
  if (bestBin < 0) {
    return null;
  }

  const neighbourhood = [(bestBin + HUE_BINS - 1) % HUE_BINS, bestBin, (bestBin + 1) % HUE_BINS];
  let totalWeight = 0;
  let totalA = 0;
  let totalB = 0;
  let totalCount = 0;
  for (const bin of neighbourhood) {
    totalWeight += weights[bin];
    totalA += sumA[bin];
    totalB += sumB[bin];
    totalCount += counts[bin];
  }
  if (totalWeight <= 0 || totalCount / counted < MIN_SEED_SHARE) {
    return null;
  }

  const meanA = totalA / totalWeight;
  const meanB = totalB / totalWeight;
  let hue = (Math.atan2(meanB, meanA) * 180) / Math.PI;
  if (hue < 0) {
    hue += 360;
  }
  return { hue, chroma: Math.hypot(meanA, meanB) };
};

/**
 * Every colour the mini-bar paints, as `[r, g, b]` bytes, from a seed. A
 * missing or invalid seed gives the default palette.
 */
const buildMiniPalette = (seed) => {
  if (!seed || !Number.isFinite(seed.hue) || !Number.isFinite(seed.chroma) || seed.chroma <= 0) {
    return DEFAULT_MINI_PALETTE;
  }
  const palette = {};
  for (const key of PALETTE_KEYS) {
    const tone = ROLE_TONES[key];
    const chroma = clamp(seed.chroma * tone.share, tone.min, tone.max);
    palette[key] = Object.freeze(oklchToRgb(tone.l, chroma, seed.hue));
  }
  return Object.freeze(palette);
};

const formatRgb = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;

const formatRgba = ([r, g, b], alpha) => `rgba(${r}, ${g}, ${b}, ${Number(clamp(alpha, 0, 1).toFixed(3))})`;

/** WCAG relative luminance of sRGB bytes. */
const relativeLuminance = ([r, g, b]) => (
  (0.2126 * srgbToLinear(r)) + (0.7152 * srgbToLinear(g)) + (0.0722 * srgbToLinear(b))
);

/** WCAG contrast ratio between two sRGB colours. */
const contrastRatio = (first, second) => {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

export {
  DEFAULT_MINI_PALETTE,
  PALETTE_KEYS,
  buildMiniPalette,
  contrastRatio,
  extractCoverSeed,
  formatRgb,
  formatRgba,
  oklchToRgb,
  rgbToOklab,
};
