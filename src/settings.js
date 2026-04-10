export const PROVIDER_OVERRIDE_KEY = 'providerOverride';
export const AUDIO_VOLUME_KEY = 'audioVolume';
export const MANIA_SCROLL_SPEED_KEY = 'maniaScrollSpeed';
export const MANIA_SCROLL_SCALE_WITH_BPM_KEY = 'maniaScaleScrollSpeedWithBpm';
export const STANDARD_SNAKING_SLIDERS_KEY = 'standardSnakingSliders';
export const STANDARD_SLIDER_END_CIRCLES_KEY = 'standardSliderEndCircles';
export const POPUP_SIZE_KEY = 'popupSize';

export const DEFAULT_AUDIO_VOLUME = 0.8;
export const MIN_MANIA_SCROLL_SPEED = 1;
export const MAX_MANIA_SCROLL_SPEED = 40;
export const DEFAULT_MANIA_SCROLL_SPEED = 28;
export const DEFAULT_MANIA_SCROLL_SCALE_WITH_BPM = false;
export const DEFAULT_STANDARD_SNAKING_SLIDERS = false;
export const DEFAULT_STANDARD_SLIDER_END_CIRCLES = true;
export const DEFAULT_POPUP_SIZE = 'default';

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
});

export const toPreviewSettingsStorage = (settings = {}) => {
  const normalized = normalizePreviewSettings(settings);
  return {
    [MANIA_SCROLL_SPEED_KEY]: normalized.maniaScrollSpeed,
    [MANIA_SCROLL_SCALE_WITH_BPM_KEY]: normalized.maniaScaleScrollSpeedWithBpm,
    [STANDARD_SNAKING_SLIDERS_KEY]: normalized.standardSnakingSliders,
    [STANDARD_SLIDER_END_CIRCLES_KEY]: normalized.standardSliderEndCircles,
    [POPUP_SIZE_KEY]: normalized.popupSize,
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
