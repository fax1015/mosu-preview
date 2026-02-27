const PROVIDER_OVERRIDE_KEY = 'providerOverride';
const ALLOWED_PROVIDER_OVERRIDES = new Set(['auto', 'osu_direct', 'catboy', 'osu', 'chimu']);

const providerSelect = document.querySelector('#providerOverride');
const saveStatus = document.querySelector('#saveStatus');

const readSettings = () => new Promise((resolve) => {
  chrome.storage.sync.get([PROVIDER_OVERRIDE_KEY], (items) => {
    const error = chrome.runtime.lastError;
    if (error) {
      resolve({ providerOverride: 'auto' });
      return;
    }

    const candidate = String(items?.[PROVIDER_OVERRIDE_KEY] || 'auto');
    resolve({
      providerOverride: ALLOWED_PROVIDER_OVERRIDES.has(candidate) ? candidate : 'auto',
    });
  });
});

const writeSettings = (providerOverride) => new Promise((resolve) => {
  chrome.storage.sync.set({ [PROVIDER_OVERRIDE_KEY]: providerOverride }, () => {
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

const initialize = async () => {
  if (!providerSelect) {
    return;
  }

  const settings = await readSettings();
  providerSelect.value = settings.providerOverride;

  providerSelect.addEventListener('change', async () => {
    const nextValue = ALLOWED_PROVIDER_OVERRIDES.has(providerSelect.value)
      ? providerSelect.value
      : 'auto';
    const didSave = await writeSettings(nextValue);
    if (didSave) {
      showStatus('Saved.');
      return;
    }
    showStatus('Could not save setting.', true);
  });
};

initialize();
