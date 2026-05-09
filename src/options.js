import {
  PROVIDER_OVERRIDE_KEY,
  MANIA_SCROLL_SPEED_KEY,
  MANIA_SCROLL_SCALE_WITH_BPM_KEY,
  STANDARD_SNAKING_SLIDERS_KEY,
  STANDARD_SLIDER_END_CIRCLES_KEY,
  POPUP_SIZE_KEY,
  MIN_MANIA_SCROLL_SPEED,
  MAX_MANIA_SCROLL_SPEED,
  ALLOWED_PROVIDER_OVERRIDES,
  LEGACY_PROVIDER_OVERRIDE_ALIASES,
  normalizeProviderOverride,
  normalizePreviewSettings,
  toPreviewSettingsStorage,
  calculateManiaScrollTimeMs,
} from './settings.js';
import { storageGet, storageSet } from './webextension.js';

const providerSelect = document.querySelector('#providerOverride');
const popupSizeSelect = document.querySelector('#popupSize');
const maniaScrollSpeedRange = document.querySelector('#maniaScrollSpeedRange');
const maniaScrollSpeedInput = document.querySelector('#maniaScrollSpeedInput');
const maniaScrollSpeedValue = document.querySelector('#maniaScrollSpeedValue');
const maniaScrollTimeValue = document.querySelector('#maniaScrollTimeValue');
const maniaScaleScrollWithBpm = document.querySelector('#maniaScrollScaleWithBpm');
const standardSnakingSliders = document.querySelector('#standardSnakingSliders');
const standardSliderEndCircles = document.querySelector('#standardSliderEndCircles');
const saveStatus = document.querySelector('#saveStatus');
let saveStatusHideTimeout = null;
let saveStatusClearTimeout = null;

const readSettings = async () => {
  try {
    const items = await storageGet('sync', [
      PROVIDER_OVERRIDE_KEY,
      MANIA_SCROLL_SPEED_KEY,
      MANIA_SCROLL_SCALE_WITH_BPM_KEY,
      STANDARD_SNAKING_SLIDERS_KEY,
      STANDARD_SLIDER_END_CIRCLES_KEY,
      POPUP_SIZE_KEY,
    ]);

    return {
      providerOverride: normalizeProviderOverride(items?.[PROVIDER_OVERRIDE_KEY]),
      ...normalizePreviewSettings(items),
    };
  } catch {
    return {
      providerOverride: 'auto',
      ...normalizePreviewSettings(),
    };
  }
};

const writeSettings = async (settings) => {
  const providerOverride = normalizeProviderOverride(settings?.providerOverride);

  try {
    await storageSet('sync', {
      [PROVIDER_OVERRIDE_KEY]: providerOverride,
      ...toPreviewSettingsStorage(settings),
    });
    return true;
  } catch {
    return false;
  }
};

const showStatus = (text, isError = false) => {
  if (!saveStatus) {
    return;
  }

  if (saveStatusHideTimeout) {
    window.clearTimeout(saveStatusHideTimeout);
  }
  if (saveStatusClearTimeout) {
    window.clearTimeout(saveStatusClearTimeout);
  }

  saveStatus.textContent = text;
  saveStatus.classList.toggle('is-error', isError);
  saveStatus.classList.add('is-visible');

  saveStatusHideTimeout = window.setTimeout(() => {
    saveStatus.classList.remove('is-visible');
  }, 1400);

  saveStatusClearTimeout = window.setTimeout(() => {
    saveStatus.textContent = '';
    saveStatus.classList.remove('is-error');
  }, 1800);
};

const updateManiaScrollRangeProgress = (value) => {
  if (!maniaScrollSpeedRange) {
    return;
  }

  const numericValue = Number(value);
  const boundedValue = Number.isFinite(numericValue)
    ? Math.min(MAX_MANIA_SCROLL_SPEED, Math.max(MIN_MANIA_SCROLL_SPEED, numericValue))
    : MIN_MANIA_SCROLL_SPEED;
  const progress = ((boundedValue - MIN_MANIA_SCROLL_SPEED) / (MAX_MANIA_SCROLL_SPEED - MIN_MANIA_SCROLL_SPEED)) * 100;

  maniaScrollSpeedRange.style.setProperty('--range-progress', `${progress}%`);
};

const renderManiaScrollSpeed = (value) => {
  const normalized = normalizePreviewSettings({ maniaScrollSpeed: value }).maniaScrollSpeed;
  const baseScrollTimeMs = calculateManiaScrollTimeMs(normalized);

  if (maniaScrollSpeedRange) {
    maniaScrollSpeedRange.value = String(normalized);
  }
  updateManiaScrollRangeProgress(normalized);
  if (maniaScrollSpeedInput) {
    maniaScrollSpeedInput.value = String(normalized);
  }
  if (maniaScrollSpeedValue) {
    maniaScrollSpeedValue.textContent = String(normalized);
  }
  if (maniaScrollTimeValue) {
    maniaScrollTimeValue.textContent = `${baseScrollTimeMs} ms`;
  }
};

const getFormSettings = () => ({
  providerOverride: ALLOWED_PROVIDER_OVERRIDES.has(providerSelect?.value)
    ? providerSelect.value
    : 'auto',
  ...normalizePreviewSettings({
    popupSize: popupSizeSelect?.value,
    maniaScrollSpeed: maniaScrollSpeedInput?.value ?? maniaScrollSpeedRange?.value,
    maniaScaleScrollSpeedWithBpm: maniaScaleScrollWithBpm?.checked,
    standardSnakingSliders: standardSnakingSliders?.checked,
    standardSliderEndCircles: standardSliderEndCircles?.checked,
  }),
});

const persistFormSettings = async () => {
  const didSave = await writeSettings(getFormSettings());
  if (didSave) {
    showStatus('Saved');
    return true;
  }
  showStatus('Failed to save', true);
  return false;
};

const initialize = async () => {
  if (
    !providerSelect
    || !popupSizeSelect
    || !maniaScrollSpeedRange
    || !maniaScrollSpeedInput
    || !maniaScaleScrollWithBpm
    || !standardSnakingSliders
    || !standardSliderEndCircles
  ) {
    return;
  }

  maniaScrollSpeedRange.min = String(MIN_MANIA_SCROLL_SPEED);
  maniaScrollSpeedRange.max = String(MAX_MANIA_SCROLL_SPEED);
  maniaScrollSpeedInput.min = String(MIN_MANIA_SCROLL_SPEED);
  maniaScrollSpeedInput.max = String(MAX_MANIA_SCROLL_SPEED);

  const settings = await readSettings();
  providerSelect.value = settings.providerOverride;
  popupSizeSelect.value = settings.popupSize;
  renderManiaScrollSpeed(settings.maniaScrollSpeed);
  maniaScaleScrollWithBpm.checked = settings.maniaScaleScrollSpeedWithBpm;
  standardSnakingSliders.checked = settings.standardSnakingSliders;
  standardSliderEndCircles.checked = settings.standardSliderEndCircles;

  providerSelect.addEventListener('change', async () => {
    await persistFormSettings();
  });

  popupSizeSelect.addEventListener('change', async () => {
    await persistFormSettings();
  });

  maniaScrollSpeedRange.addEventListener('input', () => {
    renderManiaScrollSpeed(maniaScrollSpeedRange.value);
  });

  maniaScrollSpeedRange.addEventListener('change', async () => {
    renderManiaScrollSpeed(maniaScrollSpeedRange.value);
    await persistFormSettings();
  });

  maniaScrollSpeedInput.addEventListener('input', () => {
    const candidate = Number(maniaScrollSpeedInput.value);
    if (!Number.isFinite(candidate)) {
      return;
    }
    renderManiaScrollSpeed(candidate);
  });

  maniaScrollSpeedInput.addEventListener('change', async () => {
    const raw = maniaScrollSpeedInput.value;
    const normalized = normalizePreviewSettings({ maniaScrollSpeed: raw }).maniaScrollSpeed;
    if (String(raw) !== String(normalized)) {
      maniaScrollSpeedInput.classList.add('input-error');
      setTimeout(() => maniaScrollSpeedInput.classList.remove('input-error'), 600);
    }
    renderManiaScrollSpeed(normalized);
    await persistFormSettings();
  });

  maniaScaleScrollWithBpm.addEventListener('change', async () => {
    await persistFormSettings();
  });

  standardSnakingSliders.addEventListener('change', async () => {
    await persistFormSettings();
  });

  standardSliderEndCircles.addEventListener('change', async () => {
    await persistFormSettings();
  });
};

initialize();
