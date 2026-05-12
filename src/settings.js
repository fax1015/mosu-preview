export const PROVIDER_OVERRIDE_KEY = 'providerOverride';
export const AUDIO_VOLUME_KEY = 'audioVolume';
export const MANIA_SCROLL_SPEED_KEY = 'maniaScrollSpeed';
export const MANIA_SCROLL_SCALE_WITH_BPM_KEY = 'maniaScaleScrollSpeedWithBpm';
export const STANDARD_SNAKING_SLIDERS_KEY = 'standardSnakingSliders';
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
export const DEFAULT_STANDARD_SNAKING_SLIDERS = false;
export const DEFAULT_STANDARD_SLIDER_END_CIRCLES = true;
export const DEFAULT_POPUP_SIZE = 'default';
export const DEFAULT_DISABLED_PROVIDERS = [];
export const DEFAULT_AUTO_FALLBACK = true;

export const ARCHIVE_DOWNLOAD_SOURCES = Object.freeze([
  Object.freeze({
    id: 'mino',
    label: 'Mino',
    rank: 0,
    url: (setId) => `https://catboy.best/d/${setId}n`,
    credentials: 'omit',
  }),
  Object.freeze({
    id: 'osu_direct',
    label: 'osu.direct',
    rank: 1,
    url: (setId) => `https://osu.direct/api/d/${setId}`,
    credentials: 'omit',
  }),
  Object.freeze({
    id: 'nerinyan',
    label: 'NeriNyan',
    rank: 2,
    url: (setId) => `https://api.nerinyan.moe/d/${setId}`,
    credentials: 'omit',
  }),
  Object.freeze({
    id: 'sayobot',
    label: 'Sayobot',
    rank: 3,
    url: (setId) => `https://txy1.sayobot.cn/beatmaps/download/novideo/${setId}?server=null`,
    credentials: 'omit',
  }),
  Object.freeze({
    id: 'chimu',
    label: 'Chimu',
    rank: 4,
    url: (setId) => `https://api.chimu.moe/v1/download/${setId}?n=1`,
    credentials: 'omit',
  }),
]);

export const ALLOWED_PROVIDER_OVERRIDES = Object.freeze(
  new Set(['auto', ...ARCHIVE_DOWNLOAD_SOURCES.map((source) => source.id)]),
);

export const LEGACY_PROVIDER_OVERRIDE_ALIASES = Object.freeze({
  catboy: 'mino',
});

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

export const normalizeStandardSnakingSliders = (value) => (
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
  standardSnakingSliders: normalizeStandardSnakingSliders(
    items?.[STANDARD_SNAKING_SLIDERS_KEY] ?? items?.standardSnakingSliders,
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
    [STANDARD_SNAKING_SLIDERS_KEY]: normalized.standardSnakingSliders,
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
