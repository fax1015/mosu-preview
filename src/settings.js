export const PROVIDER_OVERRIDE_KEY = 'providerOverride';
export const AUDIO_VOLUME_KEY = 'audioVolume';
export const MANIA_SCROLL_SPEED_KEY = 'maniaScrollSpeed';
export const MANIA_SCROLL_SCALE_WITH_BPM_KEY = 'maniaScaleScrollSpeedWithBpm';
export const MANIA_SCROLL_DIRECTION_KEY = 'maniaScrollDirection';
export const MANIA_TIMING_NOTE_COLOURS_KEY = 'maniaTimingNoteColours';
export const STANDARD_SNAKING_SLIDERS_KEY = 'standardSnakingSliders';
export const STANDARD_SLIDER_SNAKE_OUT_KEY = 'standardSliderSnakeOut';
export const STANDARD_SLIDER_END_CIRCLES_KEY = 'standardSliderEndCircles';
export const POPUP_SIZE_KEY = 'popupSize';
export const PROVIDER_PRIORITY_KEY = 'providerPriority';
export const DISABLED_PROVIDERS_KEY = 'disabledProviders';
export const AUTO_FALLBACK_KEY = 'autoFallback';

export const DEFAULT_AUDIO_VOLUME = 0.8;
export const MIN_MANIA_SCROLL_SPEED = 1;
export const MAX_MANIA_SCROLL_SPEED = 40;
export const DEFAULT_MANIA_SCROLL_SPEED = 28;
export const DEFAULT_MANIA_SCROLL_SCALE_WITH_BPM = false;
export const DEFAULT_MANIA_SCROLL_DIRECTION = 'down';
export const DEFAULT_MANIA_TIMING_NOTE_COLOURS = false;
export const DEFAULT_STANDARD_SNAKING_SLIDERS = false;
export const DEFAULT_STANDARD_SLIDER_SNAKE_OUT = false;
export const DEFAULT_STANDARD_SLIDER_END_CIRCLES = true;
export const DEFAULT_POPUP_SIZE = 'default';
export const DEFAULT_DISABLED_PROVIDERS = [];
export const DEFAULT_AUTO_FALLBACK = true;

export const PROVIDER_PRIORITY_TIERS = Object.freeze({
  PRIMARY: 'primary',
  SECONDARY: 'secondary',
  EXPERIMENTAL: 'experimental',
});

export const PROVIDER_TIER_LABELS = Object.freeze({
  primary: 'Primary',
  secondary: 'Secondary',
  experimental: 'Experimental',
});

const PROVIDER_DEFINITIONS = [
  {
    id: 'mino',
    label: 'Mino',
    rank: 0,
    buildArchiveUrl: ({ setId, noVideo } = {}) => {
      const useNoVideo = noVideo !== false;
      return `https://catboy.best/d/${setId}${useNoVideo ? 'n' : ''}`;
    },
    supportsNoVideo: true,
    supportsCors: true,
    supportsRangeRequests: false,
    regionBias: 'global',
    expectedReliability: 0.85,
    averageStartupLatency: 1200,
  },
  {
    id: 'osu_direct',
    label: 'osu.direct',
    rank: 1,
    buildArchiveUrl: ({ setId } = {}) => `https://osu.direct/api/d/${setId}`,
    supportsNoVideo: false,
    supportsCors: true,
    supportsRangeRequests: false,
    regionBias: 'global',
    expectedReliability: 0.8,
    averageStartupLatency: 1500,
  },
  {
    id: 'nerinyan',
    label: 'NeriNyan',
    rank: 2,
    buildArchiveUrl: ({ setId } = {}) => `https://api.nerinyan.moe/d/${setId}`,
    supportsNoVideo: false,
    supportsCors: true,
    supportsRangeRequests: false,
    regionBias: 'global',
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
    supportsNoVideo: true,
    supportsCors: true,
    supportsRangeRequests: false,
    regionBias: 'asia',
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

export const PROVIDER_SCORE_WEIGHTS = Object.freeze({
  staticWeight: 0.10,
  reliability: 0.35,
  speed: 0.25,
  userPreference: 0.20,
  recencyBonus: 0.10,
});

export const computeProviderScore = (provider, stats, userPriorityIndex = -1) => {
  const totalAttempts = (stats?.successes ?? 0) + (stats?.failures ?? 0);
  const reliability = totalAttempts > 0
    ? (stats.successes / totalAttempts)
    : (provider.expectedReliability ?? 0.5);
  const avgSpeed = (stats?.timedSuccesses ?? 0) > 0
    ? (stats.totalSuccessMs / stats.timedSuccesses)
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
  const candidate = String(value || 'auto');
  const normalizedCandidate = LEGACY_PROVIDER_OVERRIDE_ALIASES[candidate] || candidate;
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

export const clampSetting = (value, min, max) => Math.min(max, Math.max(min, value));

export const normalizeManiaScrollSpeed = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_MANIA_SCROLL_SPEED;
  }
  return clampSetting(Math.round(numeric), MIN_MANIA_SCROLL_SPEED, MAX_MANIA_SCROLL_SPEED);
};

export const normalizeManiaScrollScaleWithBpm = (value) => (
  value === true
  || value === 'true'
  || value === 1
  || value === '1'
);

export const normalizeManiaScrollDirection = (value) => (
  String(value || DEFAULT_MANIA_SCROLL_DIRECTION).toLowerCase() === 'up' ? 'up' : DEFAULT_MANIA_SCROLL_DIRECTION
);

export const normalizeManiaTimingNoteColours = (value) => (
  value === true
  || value === 'true'
  || value === 1
  || value === '1'
);

export const normalizeStandardSnakingSliders = (value) => (
  value === true
  || value === 'true'
  || value === 1
  || value === '1'
);

export const normalizeStandardSliderSnakeOut = (value) => (
  value === true
  || value === 'true'
  || value === 1
  || value === '1'
);

export const normalizeStandardSliderEndCircles = (value) => (
  value === true
  || value === 'true'
  || value === 1
  || value === '1'
  || value === undefined
  || value === null
);

export const normalizePopupSize = (value) => {
  const candidate = String(value || DEFAULT_POPUP_SIZE);
  return Object.hasOwn(POPUP_SIZE_PRESETS, candidate) ? candidate : DEFAULT_POPUP_SIZE;
};

export const normalizeProviderPriority = (value) => {
  if (!Array.isArray(value)) {
    return ARCHIVE_DOWNLOAD_SOURCES.map((s) => s.id);
  }
  const validIds = new Set(ARCHIVE_DOWNLOAD_SOURCES.map((s) => s.id));
  const prioritized = value.filter((id) => validIds.has(id));
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
  disabledProviders: Array.isArray(items?.[DISABLED_PROVIDERS_KEY])
    ? items[DISABLED_PROVIDERS_KEY]
    : (Array.isArray(items?.disabledProviders) ? items.disabledProviders : DEFAULT_DISABLED_PROVIDERS),
  autoFallback: items?.[AUTO_FALLBACK_KEY] ?? items?.autoFallback ?? DEFAULT_AUTO_FALLBACK,
});

export const toPreviewSettingsStorage = (settings = {}) => {
  const normalized = normalizePreviewSettings(settings);
  return {
    [MANIA_SCROLL_SPEED_KEY]: normalized.maniaScrollSpeed,
    [MANIA_SCROLL_SCALE_WITH_BPM_KEY]: normalized.maniaScaleScrollSpeedWithBpm,
    [MANIA_SCROLL_DIRECTION_KEY]: normalized.maniaScrollDirection,
    [MANIA_TIMING_NOTE_COLOURS_KEY]: normalized.maniaTimingNoteColours,
    [STANDARD_SNAKING_SLIDERS_KEY]: normalized.standardSnakingSliders,
    [STANDARD_SLIDER_SNAKE_OUT_KEY]: normalized.standardSliderSnakeOut,
    [STANDARD_SLIDER_END_CIRCLES_KEY]: normalized.standardSliderEndCircles,
    [POPUP_SIZE_KEY]: normalized.popupSize,
    [PROVIDER_PRIORITY_KEY]: normalized.providerPriority,
    [DISABLED_PROVIDERS_KEY]: normalized.disabledProviders,
    [AUTO_FALLBACK_KEY]: normalized.autoFallback,
  };
};

export const calculateManiaScrollTimeMs = (scrollSpeed, bpm = 120, scaleWithBpm = false) => {
  const normalizedSpeed = normalizeManiaScrollSpeed(scrollSpeed);
  let scrollTimeMs = 1000 * (40 / normalizedSpeed);

  if (scaleWithBpm) {
    const normalizedBpm = Number(bpm);
    if (Number.isFinite(normalizedBpm) && normalizedBpm > 0) {
      scrollTimeMs *= 120 / normalizedBpm;
    }
  }

  return Math.max(120, Math.round(scrollTimeMs));
};
