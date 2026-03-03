import {
  PROVIDER_OVERRIDE_KEY,
  MANIA_SCROLL_SPEED_KEY,
  MANIA_SCROLL_SCALE_WITH_BPM_KEY,
  STANDARD_SNAKING_SLIDERS_KEY,
  STANDARD_SLIDER_END_CIRCLES_KEY,
  MIN_MANIA_SCROLL_SPEED,
  MAX_MANIA_SCROLL_SPEED,
  normalizePreviewSettings,
  toPreviewSettingsStorage,
  calculateManiaScrollTimeMs,
} from './settings.js';

const ALLOWED_PROVIDER_OVERRIDES = new Set(['auto', 'osu_direct', 'catboy', 'osu', 'chimu']);

const providerSelect = document.querySelector('#providerOverride');
const maniaScrollSpeedRange = document.querySelector('#maniaScrollSpeedRange');
const maniaScrollSpeedInput = document.querySelector('#maniaScrollSpeedInput');
const maniaScrollSpeedValue = document.querySelector('#maniaScrollSpeedValue');
const maniaScrollTimeValue = document.querySelector('#maniaScrollTimeValue');
const maniaScaleScrollWithBpm = document.querySelector('#maniaScrollScaleWithBpm');
const standardSnakingSliders = document.querySelector('#standardSnakingSliders');
const standardSliderEndCircles = document.querySelector('#standardSliderEndCircles');
const saveStatus = document.querySelector('#saveStatus');

const readSettings = () => new Promise((resolve) => {
  chrome.storage.sync.get([
    PROVIDER_OVERRIDE_KEY,
    MANIA_SCROLL_SPEED_KEY,
    MANIA_SCROLL_SCALE_WITH_BPM_KEY,
    STANDARD_SNAKING_SLIDERS_KEY,
    STANDARD_SLIDER_END_CIRCLES_KEY,
  ], (items) => {
    const error = chrome.runtime.lastError;
    if (error) {
      resolve({
        providerOverride: 'auto',
        ...normalizePreviewSettings(),
      });
      return;
    }

    const candidate = String(items?.[PROVIDER_OVERRIDE_KEY] || 'auto');
    resolve({
      providerOverride: ALLOWED_PROVIDER_OVERRIDES.has(candidate) ? candidate : 'auto',
      ...normalizePreviewSettings(items),
    });
  });
});

const writeSettings = (settings) => new Promise((resolve) => {
  const providerOverride = ALLOWED_PROVIDER_OVERRIDES.has(settings?.providerOverride)
    ? settings.providerOverride
    : 'auto';

  chrome.storage.sync.set({
    [PROVIDER_OVERRIDE_KEY]: providerOverride,
    ...toPreviewSettingsStorage(settings),
  }, () => {
    const error = chrome.runtime.lastError;
    resolve(!error);
  });
});

const showStatus = (text, isError = false) => {
  if (!saveStatus) {
    return;
  }
  saveStatus.textContent = text;
  saveStatus.style.color = isError ? 'rgb(255, 132, 132)' : 'rgb(134, 221, 170)';
};

const renderManiaScrollSpeed = (value) => {
  const normalized = normalizePreviewSettings({ maniaScrollSpeed: value }).maniaScrollSpeed;
  const baseScrollTimeMs = calculateManiaScrollTimeMs(normalized);

  if (maniaScrollSpeedRange) {
    maniaScrollSpeedRange.value = String(normalized);
  }
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
    maniaScrollSpeed: maniaScrollSpeedInput?.value ?? maniaScrollSpeedRange?.value,
    maniaScaleScrollSpeedWithBpm: maniaScaleScrollWithBpm?.checked,
    standardSnakingSliders: standardSnakingSliders?.checked,
    standardSliderEndCircles: standardSliderEndCircles?.checked,
  }),
});

const persistFormSettings = async () => {
  const didSave = await writeSettings(getFormSettings());
  if (didSave) {
    showStatus('Saved.');
    return true;
  }
  showStatus('Could not save setting.', true);
  return false;
};

const initialize = async () => {
  if (
    !providerSelect
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
  renderManiaScrollSpeed(settings.maniaScrollSpeed);
  maniaScaleScrollWithBpm.checked = settings.maniaScaleScrollSpeedWithBpm;
  standardSnakingSliders.checked = settings.standardSnakingSliders;
  standardSliderEndCircles.checked = settings.standardSliderEndCircles;

  providerSelect.addEventListener('change', async () => {
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
    renderManiaScrollSpeed(maniaScrollSpeedInput.value);
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
