import { clamp } from './core/math.js';
import { normalizeKeybindings, toStoredKeybindings } from './core/keybindings.js';

export const PROVIDER_OVERRIDE_KEY = 'providerOverride';
export const AUDIO_VOLUME_KEY = 'audioVolume';
export const MANIA_SCROLL_SPEED_KEY = 'maniaScrollSpeed';
export const MANIA_SCROLL_SCALE_WITH_BPM_KEY = 'maniaScaleScrollSpeedWithBpm';
export const MANIA_SCROLL_DIRECTION_KEY = 'maniaScrollDirection';
export const MANIA_TIMING_NOTE_COLOURS_KEY = 'maniaTimingNoteColours';
export const MANIA_KEY_COUNT_KEY = 'maniaKeyCount';
export const STANDARD_SNAKING_SLIDERS_KEY = 'standardSnakingSliders';
export const STANDARD_SLIDER_SNAKE_OUT_KEY = 'standardSliderSnakeOut';
export const STANDARD_SLIDER_END_CIRCLES_KEY = 'standardSliderEndCircles';
export const POPUP_SIZE_KEY = 'popupSize';
export const PROVIDER_PRIORITY_KEY = 'providerPriority';
export const DISABLED_PROVIDERS_KEY = 'disabledProviders';
export const AUTO_FALLBACK_KEY = 'autoFallback';
export const HITSOUNDS_KEY = 'hitsounds';
export const HITSOUND_VOLUME_KEY = 'hitsoundVolume';
export const HITSOUND_STYLE_KEY = 'hitsoundStyle';
export const AUTOPLAY_KEY = 'autoplay';
export const EMBEDDED_PLAYER_KEY = 'embeddedPlayer';
export const MINI_WAVY_PROGRESS_KEY = 'miniWavyProgress';
export const MINI_HITSOUNDS_WHEN_COLLAPSED_KEY = 'miniHitsoundsWhenCollapsed';
export const KEYBINDINGS_KEY = 'keybindings';

export const DEFAULT_AUDIO_VOLUME = 0.8;
export const MIN_MANIA_SCROLL_SPEED = 1;
export const MAX_MANIA_SCROLL_SPEED = 40;
export const DEFAULT_MANIA_SCROLL_SPEED = 28;
export const DEFAULT_MANIA_SCROLL_SCALE_WITH_BPM = false;
export const DEFAULT_MANIA_SCROLL_DIRECTION = 'down';
export const DEFAULT_MANIA_TIMING_NOTE_COLOURS = false;
// 'auto' leaves a convert at the column count the map itself works out, as
// osu!lazer does without a key mod.
export const DEFAULT_MANIA_KEY_COUNT = 'auto';
export const DEFAULT_STANDARD_SNAKING_SLIDERS = false;
export const DEFAULT_STANDARD_SLIDER_SNAKE_OUT = false;
export const DEFAULT_STANDARD_SLIDER_END_CIRCLES = true;
export const DEFAULT_POPUP_SIZE = 'default';
export const DEFAULT_DISABLED_PROVIDERS = [];
export const DEFAULT_AUTO_FALLBACK = true;
export const DEFAULT_HITSOUNDS = false;
export const DEFAULT_HITSOUND_VOLUME = 0.5;
export const DEFAULT_HITSOUND_STYLE = 'argon';
// On by default: clicking the icon to hear a map is the whole point of the
// popup. Off is for whoever opens it with the volume up and would rather it
// waited to be asked.
export const DEFAULT_AUTOPLAY = true;
export const DEFAULT_EMBEDDED_PLAYER = false;
// The collapsed miniplayer's progress as a wavy line rather than the map's
// timeline. On: it is the miniplayer's look; off is there to compare with.
export const DEFAULT_MINI_WAVY_PROGRESS = true;
// Keep existing behaviour unless the user turns collapsed hitsounds off.
export const DEFAULT_MINI_HITSOUNDS_WHEN_COLLAPSED = true;

// The voices each style plays live in audio/hitsounds.js; this is only the list
// a stored choice is checked against, so the options page does not have to load
// the synthesiser to validate a dropdown.
export const HITSOUND_STYLES = Object.freeze(['argon', 'lazer', 'minimal']);

// The key counts a mania convert can be forced to: osu!lazer's 1K-10K mods.
// 4K and 7K are what nearly every mania player plays, so they get the front of
// the picker and the rest sit behind it.
export const MANIA_KEY_COUNTS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
export const MANIA_PRIMARY_KEY_COUNTS = Object.freeze([4, 7]);

const PROVIDER_DEFINITIONS = [
  {
    id: 'mino',
    label: 'Mino',
    rank: 0,
    buildArchiveUrl: ({ setId, noVideo } = {}) => {
      const useNoVideo = noVideo !== false;
      return `https://catboy.best/d/${setId}${useNoVideo ? 'n' : ''}`;
    },
    expectedReliability: 0.85,
    averageStartupLatency: 1200,
  },
  {
    id: 'osu_direct',
    label: 'osu.direct',
    rank: 1,
    buildArchiveUrl: ({ setId } = {}) => `https://osu.direct/api/d/${setId}`,
    expectedReliability: 0.8,
    averageStartupLatency: 1500,
  },
  {
    id: 'nerinyan',
    label: 'NeriNyan',
    rank: 2,
    buildArchiveUrl: ({ setId } = {}) => `https://api.nerinyan.moe/d/${setId}`,
    expectedReliability: 0.82,
    averageStartupLatency: 1000,
  },
  {
    id: 'sayobot',
    label: 'Sayobot',
    rank: 3,
    buildArchiveUrl: ({ setId, noVideo } = {}) => {
      const useNoVideo = noVideo !== false;
      return `https://txy1.sayobot.cn/beatmaps/download/${useNoVideo ? 'novideo' : 'origin'}/${setId}?server=null`;
    },
    expectedReliability: 0.75,
    averageStartupLatency: 800,
  },
];

export const ARCHIVE_DOWNLOAD_SOURCES = Object.freeze(
  PROVIDER_DEFINITIONS.map((def) => Object.freeze({ ...def })),
);

export const ALLOWED_PROVIDER_OVERRIDES = Object.freeze(
  new Set(['auto', ...ARCHIVE_DOWNLOAD_SOURCES.map((source) => source.id)]),
);

export const LEGACY_PROVIDER_OVERRIDE_ALIASES = Object.freeze({
  catboy: 'mino',
});

// Every key normalizePreviewSettings understands, in one place. Both readers
// used to keep their own hand-written copy of this list, so a setting added to
// the normalizer but forgotten in a list was silently read as absent -- which is
// exactly how the hitsound toggle came back off on every popup open.
export const PREVIEW_SETTING_KEYS = Object.freeze([
  MANIA_SCROLL_SPEED_KEY,
  MANIA_SCROLL_SCALE_WITH_BPM_KEY,
  MANIA_SCROLL_DIRECTION_KEY,
  MANIA_TIMING_NOTE_COLOURS_KEY,
  MANIA_KEY_COUNT_KEY,
  STANDARD_SNAKING_SLIDERS_KEY,
  STANDARD_SLIDER_SNAKE_OUT_KEY,
  STANDARD_SLIDER_END_CIRCLES_KEY,
  POPUP_SIZE_KEY,
  PROVIDER_PRIORITY_KEY,
  DISABLED_PROVIDERS_KEY,
  AUTO_FALLBACK_KEY,
  HITSOUNDS_KEY,
  HITSOUND_VOLUME_KEY,
  HITSOUND_STYLE_KEY,
  AUTOPLAY_KEY,
  EMBEDDED_PLAYER_KEY,
  MINI_WAVY_PROGRESS_KEY,
  MINI_HITSOUNDS_WHEN_COLLAPSED_KEY,
  KEYBINDINGS_KEY,
]);

// Settings changed only from the preview itself, with no control on the
// options page. That page writes its whole form on every save, so it leaves
// these out; writing the form's default instead would reset them each time.
export const PREVIEW_ONLY_SETTING_KEYS = Object.freeze([MANIA_KEY_COUNT_KEY, KEYBINDINGS_KEY]);

export const PROVIDER_SCORE_WEIGHTS = Object.freeze({
  staticWeight: 0.10,
  reliability: 0.35,
  speed: 0.25,
  userPreference: 0.20,
  recencyBonus: 0.10,
});

export const computeProviderScore = (provider, stats, userPriorityIndex = -1) => {
  const successes = Number.isFinite(stats?.successes) ? stats.successes : 0;
  const failures = Number.isFinite(stats?.failures) ? stats.failures : 0;
  const timedSuccesses = Number.isFinite(stats?.timedSuccesses) ? stats.timedSuccesses : 0;
  const totalSuccessMs = Number.isFinite(stats?.totalSuccessMs) ? stats.totalSuccessMs : 0;
  const totalAttempts = successes + failures;
  const reliability = totalAttempts > 0
    ? (successes / totalAttempts)
    : (provider.expectedReliability ?? 0.5);
  const avgSpeed = timedSuccesses > 0
    ? (totalSuccessMs / timedSuccesses)
    : (provider.averageStartupLatency ?? 3000);
  const speedScore = Math.max(0, 1 - (avgSpeed / 30000));
  const userPreferenceScore = userPriorityIndex >= 0
    ? Math.max(0, 1 - (userPriorityIndex / 10))
    : 0.5;
  const recencyBonus = Math.min(1, totalAttempts / 10);

  return (
    (provider.expectedReliability ?? 0.5) * PROVIDER_SCORE_WEIGHTS.staticWeight
    + reliability * PROVIDER_SCORE_WEIGHTS.reliability
    + speedScore * PROVIDER_SCORE_WEIGHTS.speed
    + userPreferenceScore * PROVIDER_SCORE_WEIGHTS.userPreference
    + recencyBonus * PROVIDER_SCORE_WEIGHTS.recencyBonus
  );
};

export const normalizeProviderOverride = (value) => {
  const candidate = String(value ?? 'auto').trim().toLowerCase() || 'auto';
  const normalizedCandidate = Object.hasOwn(LEGACY_PROVIDER_OVERRIDE_ALIASES, candidate)
    ? LEGACY_PROVIDER_OVERRIDE_ALIASES[candidate]
    : candidate;
  return ALLOWED_PROVIDER_OVERRIDES.has(normalizedCandidate) ? normalizedCandidate : 'auto';
};

export const POPUP_SIZE_PRESETS = Object.freeze({
  compact: Object.freeze({
    shellWidth: 414,
    contentWidth: 398,
    mobileShellWidth: 360,
    mobileContentWidth: 344,
  }),
  default: Object.freeze({
    shellWidth: 454,
    contentWidth: 438,
    mobileShellWidth: 398,
    mobileContentWidth: 382,
  }),
  large: Object.freeze({
    shellWidth: 510,
    contentWidth: 494,
    mobileShellWidth: 430,
    mobileContentWidth: 414,
  }),
});

const toFiniteSettingNumber = (value) => {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return Number.NaN;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return Number.NaN;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
};

export const normalizeManiaScrollSpeed = (value) => {
  const numeric = toFiniteSettingNumber(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_MANIA_SCROLL_SPEED;
  }
  return clamp(Math.round(numeric), MIN_MANIA_SCROLL_SPEED, MAX_MANIA_SCROLL_SPEED);
};

// Storage holds real booleans, but older builds and hand-edited sync data have
// written the string and numeric spellings too. Anything else is false; an
// absent value takes the setting's own default.
const normalizeBooleanSetting = (value, fallback) => {
  if (value === undefined || value === null) {
    return fallback;
  }
  return value === true || value === 'true' || value === 1 || value === '1';
};

export const normalizeManiaScrollScaleWithBpm = (value) => (
  normalizeBooleanSetting(value, DEFAULT_MANIA_SCROLL_SCALE_WITH_BPM)
);

export const normalizeManiaScrollDirection = (value) => (
  String(value || DEFAULT_MANIA_SCROLL_DIRECTION).toLowerCase() === 'up' ? 'up' : DEFAULT_MANIA_SCROLL_DIRECTION
);

export const normalizeManiaTimingNoteColours = (value) => (
  normalizeBooleanSetting(value, DEFAULT_MANIA_TIMING_NOTE_COLOURS)
);

// A whole number of keys from 1 to 10, or 'auto'. Anything else -- a key count
// lazer has no mod for, a fraction, a hand-edited string -- is 'auto' rather
// than the nearest count: the map's own layout is the safer guess.
export const normalizeManiaKeyCount = (value) => {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(numeric) && MANIA_KEY_COUNTS.includes(numeric) ? numeric : DEFAULT_MANIA_KEY_COUNT;
};

export const normalizeStandardSnakingSliders = (value) => (
  normalizeBooleanSetting(value, DEFAULT_STANDARD_SNAKING_SLIDERS)
);

export const normalizeStandardSliderSnakeOut = (value) => (
  normalizeBooleanSetting(value, DEFAULT_STANDARD_SLIDER_SNAKE_OUT)
);

export const normalizeStandardSliderEndCircles = (value) => (
  normalizeBooleanSetting(value, DEFAULT_STANDARD_SLIDER_END_CIRCLES)
);

export const normalizePopupSize = (value) => {
  const candidate = String(value || DEFAULT_POPUP_SIZE);
  return Object.hasOwn(POPUP_SIZE_PRESETS, candidate) ? candidate : DEFAULT_POPUP_SIZE;
};

export const normalizeDisabledProviders = (value) => {
  if (!Array.isArray(value)) {
    return [...DEFAULT_DISABLED_PROVIDERS];
  }
  const validIds = new Set(ARCHIVE_DOWNLOAD_SOURCES.map((s) => s.id));
  return [...new Set(value.filter((id) => validIds.has(id)))];
};

// Read like every other toggle: it used to be `Boolean(value)`, which turned a
// stored 'false' into true.
export const normalizeAutoFallback = (value) => normalizeBooleanSetting(value, DEFAULT_AUTO_FALLBACK);

const normalizeUnitRange = (value, fallback) => {
  const numeric = toFiniteSettingNumber(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return clamp(Math.round(numeric * 100) / 100, 0, 1);
};

export const normalizeHitsounds = (value) => normalizeBooleanSetting(value, DEFAULT_HITSOUNDS);

export const normalizeAutoplay = (value) => normalizeBooleanSetting(value, DEFAULT_AUTOPLAY);

export const normalizeEmbeddedPlayer = (value) => normalizeBooleanSetting(value, DEFAULT_EMBEDDED_PLAYER);
export const normalizeMiniWavyProgress = (value) => normalizeBooleanSetting(value, DEFAULT_MINI_WAVY_PROGRESS);
export const normalizeMiniHitsoundsWhenCollapsed = (value) => normalizeBooleanSetting(
  value,
  DEFAULT_MINI_HITSOUNDS_WHEN_COLLAPSED,
);

/**
 * Whether hitsounds play: when they are on, except in the in-page
 * miniplayer's collapsed bar when the setting for it is off.
 */
export const shouldPlayHitsounds = ({ hitsounds, isEmbedded, collapsed, whenCollapsed }) => Boolean(
  hitsounds && (!isEmbedded || !collapsed || whenCollapsed),
);

export const normalizeHitsoundVolume = (value) => normalizeUnitRange(value, DEFAULT_HITSOUND_VOLUME);

// A style removed in a later build, or a hand-edited value, plays the default
// rather than leaving the hits silent.
export const normalizeHitsoundStyle = (value) => {
  const candidate = typeof value === 'string' ? value.toLowerCase() : '';
  return HITSOUND_STYLES.includes(candidate) ? candidate : DEFAULT_HITSOUND_STYLE;
};

export const normalizeProviderPriority = (value) => {
  if (!Array.isArray(value)) {
    return ARCHIVE_DOWNLOAD_SOURCES.map((s) => s.id);
  }
  const validIds = new Set(ARCHIVE_DOWNLOAD_SOURCES.map((s) => s.id));
  const prioritized = [...new Set(value.filter((id) => validIds.has(id)))];
  const remaining = ARCHIVE_DOWNLOAD_SOURCES
    .map((s) => s.id)
    .filter((id) => !prioritized.includes(id));
  return [...prioritized, ...remaining];
};

export const normalizePreviewSettings = (items = {}) => ({
  maniaScrollSpeed: normalizeManiaScrollSpeed(items?.[MANIA_SCROLL_SPEED_KEY] ?? items?.maniaScrollSpeed),
  maniaScaleScrollSpeedWithBpm: normalizeManiaScrollScaleWithBpm(
    items?.[MANIA_SCROLL_SCALE_WITH_BPM_KEY] ?? items?.maniaScaleScrollSpeedWithBpm,
  ),
  maniaScrollDirection: normalizeManiaScrollDirection(
    items?.[MANIA_SCROLL_DIRECTION_KEY] ?? items?.maniaScrollDirection,
  ),
  maniaTimingNoteColours: normalizeManiaTimingNoteColours(
    items?.[MANIA_TIMING_NOTE_COLOURS_KEY] ?? items?.maniaTimingNoteColours,
  ),
  maniaKeyCount: normalizeManiaKeyCount(items?.[MANIA_KEY_COUNT_KEY] ?? items?.maniaKeyCount),
  standardSnakingSliders: normalizeStandardSnakingSliders(
    items?.[STANDARD_SNAKING_SLIDERS_KEY] ?? items?.standardSnakingSliders,
  ),
  standardSliderSnakeOut: normalizeStandardSliderSnakeOut(
    items?.[STANDARD_SLIDER_SNAKE_OUT_KEY] ?? items?.standardSliderSnakeOut,
  ),
  standardSliderEndCircles: normalizeStandardSliderEndCircles(
    items?.[STANDARD_SLIDER_END_CIRCLES_KEY] ?? items?.standardSliderEndCircles,
  ),
  popupSize: normalizePopupSize(items?.[POPUP_SIZE_KEY] ?? items?.popupSize),
  providerPriority: normalizeProviderPriority(items?.[PROVIDER_PRIORITY_KEY] ?? items?.providerPriority),
  // Always a fresh array: returning the shared DEFAULT_DISABLED_PROVIDERS
  // reference would let a caller's mutation corrupt the module-level default.
  disabledProviders: normalizeDisabledProviders(
    items?.[DISABLED_PROVIDERS_KEY] ?? items?.disabledProviders,
  ),
  autoFallback: normalizeAutoFallback(items?.[AUTO_FALLBACK_KEY] ?? items?.autoFallback),
  hitsounds: normalizeHitsounds(items?.[HITSOUNDS_KEY] ?? items?.hitsounds),
  hitsoundVolume: normalizeHitsoundVolume(items?.[HITSOUND_VOLUME_KEY] ?? items?.hitsoundVolume),
  hitsoundStyle: normalizeHitsoundStyle(items?.[HITSOUND_STYLE_KEY] ?? items?.hitsoundStyle),
  autoplay: normalizeAutoplay(items?.[AUTOPLAY_KEY] ?? items?.autoplay),
  embeddedPlayer: normalizeEmbeddedPlayer(items?.[EMBEDDED_PLAYER_KEY] ?? items?.embeddedPlayer),
  miniWavyProgress: normalizeMiniWavyProgress(items?.[MINI_WAVY_PROGRESS_KEY] ?? items?.miniWavyProgress),
  miniHitsoundsWhenCollapsed: normalizeMiniHitsoundsWhenCollapsed(
    items?.[MINI_HITSOUNDS_WHEN_COLLAPSED_KEY] ?? items?.miniHitsoundsWhenCollapsed,
  ),
  keybindings: normalizeKeybindings(items?.[KEYBINDINGS_KEY] ?? items?.keybindings),
});

export const toPreviewSettingsStorage = (settings = {}) => {
  const normalized = normalizePreviewSettings(settings);
  return {
    [MANIA_SCROLL_SPEED_KEY]: normalized.maniaScrollSpeed,
    [MANIA_SCROLL_SCALE_WITH_BPM_KEY]: normalized.maniaScaleScrollSpeedWithBpm,
    [MANIA_SCROLL_DIRECTION_KEY]: normalized.maniaScrollDirection,
    [MANIA_TIMING_NOTE_COLOURS_KEY]: normalized.maniaTimingNoteColours,
    [MANIA_KEY_COUNT_KEY]: normalized.maniaKeyCount,
    [STANDARD_SNAKING_SLIDERS_KEY]: normalized.standardSnakingSliders,
    [STANDARD_SLIDER_SNAKE_OUT_KEY]: normalized.standardSliderSnakeOut,
    [STANDARD_SLIDER_END_CIRCLES_KEY]: normalized.standardSliderEndCircles,
    [POPUP_SIZE_KEY]: normalized.popupSize,
    [PROVIDER_PRIORITY_KEY]: normalized.providerPriority,
    [DISABLED_PROVIDERS_KEY]: normalized.disabledProviders,
    [AUTO_FALLBACK_KEY]: normalized.autoFallback,
    [HITSOUNDS_KEY]: normalized.hitsounds,
    [HITSOUND_VOLUME_KEY]: normalized.hitsoundVolume,
    [HITSOUND_STYLE_KEY]: normalized.hitsoundStyle,
    [AUTOPLAY_KEY]: normalized.autoplay,
    [EMBEDDED_PLAYER_KEY]: normalized.embeddedPlayer,
    [MINI_WAVY_PROGRESS_KEY]: normalized.miniWavyProgress,
    [MINI_HITSOUNDS_WHEN_COLLAPSED_KEY]: normalized.miniHitsoundsWhenCollapsed,
    // Sparse: only what the user moved off its default, so adding a shortcut
    // later does not need a migration of everyone's stored map.
    [KEYBINDINGS_KEY]: toStoredKeybindings(normalized.keybindings),
  };
};

/** Whether a storage.onChanged payload touches any preview setting. */
export const hasPreviewSettingChange = (changes = {}) => (
  PREVIEW_SETTING_KEYS.some((key) => Object.hasOwn(changes || {}, key))
);

/**
 * The preview settings after a storage change. Keys the change does not mention
 * keep their current value; a key it removed falls back to its default, rather
 * than silently keeping whatever the page had before.
 *
 * Driven by PREVIEW_SETTING_KEYS for the same reason the readers are: the
 * listener used to spell every key out by hand, which is how a setting
 * added in one place goes missing in another.
 */
export const applyPreviewSettingChanges = (currentSettings = {}, changes = {}) => {
  const items = toPreviewSettingsStorage(currentSettings);
  for (const key of PREVIEW_SETTING_KEYS) {
    if (Object.hasOwn(changes || {}, key)) {
      items[key] = changes[key]?.newValue;
    }
  }
  return normalizePreviewSettings(items);
};

export const calculateManiaScrollTimeMs =(scrollSpeed, bpm = 120, scaleWithBpm = false) => {
  const normalizedSpeed = normalizeManiaScrollSpeed(scrollSpeed);
  let scrollTimeMs = 11485 / normalizedSpeed;

  if (scaleWithBpm) {
    const normalizedBpm = Number(bpm);
    if (Number.isFinite(normalizedBpm) && normalizedBpm > 0) {
      scrollTimeMs *= 120 / normalizedBpm;
    }
  }

  return Math.max(120, Math.round(scrollTimeMs));
};
