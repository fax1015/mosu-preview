import {
  AUDIO_VOLUME_KEY,
  DEFAULT_AUDIO_VOLUME,
  PROVIDER_OVERRIDE_KEY,
  PREVIEW_ONLY_SETTING_KEYS,
  PREVIEW_SETTING_KEYS,
  MIN_MANIA_SCROLL_SPEED,
  MAX_MANIA_SCROLL_SPEED,
  normalizeProviderOverride,
  normalizePreviewSettings,
  toPreviewSettingsStorage,
  calculateManiaScrollTimeMs,
  ARCHIVE_DOWNLOAD_SOURCES,
} from './settings.js';
import { storageGet, storageSet } from './webextension.js';
import {
  FULL_AUDIO_CACHE_TOTAL_MAX_BYTES,
  clearFullAudioCache,
  getFullAudioCacheUsage,
} from './audio/cache.js';
import { clearHistory } from './core/history.js';

const popupSizeSelect = document.querySelector('#popupSize');
const maniaScrollSpeedRange = document.querySelector('#maniaScrollSpeedRange');
const maniaScrollSpeedInput = document.querySelector('#maniaScrollSpeedInput');
const maniaScrollSpeedValue = document.querySelector('#maniaScrollSpeedValue');
const maniaScrollTimeValue = document.querySelector('#maniaScrollTimeValue');
const maniaScaleScrollWithBpm = document.querySelector('#maniaScrollScaleWithBpm');
const hitsoundsToggle = document.querySelector('#hitsounds');
const hitsoundVolumeRange = document.querySelector('#hitsoundVolume');
const hitsoundVolumeValue = document.querySelector('#hitsoundVolumeValue');
const hitsoundStyleSelect = document.querySelector('#hitsoundStyle');
const maniaScrollDirection = document.querySelector('#maniaScrollDirection');
const maniaTimingNoteColours = document.querySelector('#maniaTimingNoteColours');
const standardSnakingSliders = document.querySelector('#standardSnakingSliders');
const standardSliderSnakeOut = document.querySelector('#standardSliderSnakeOut');
const standardSliderEndCircles = document.querySelector('#standardSliderEndCircles');
const autoFallbackToggle = document.querySelector('#autoFallback');
const autoplayToggle = document.querySelector('#autoplay');
const audioVolumeRange = document.querySelector('#audioVolume');
const audioVolumeValue = document.querySelector('#audioVolumeValue');
const providerPriorityList = document.querySelector('#providerPriorityList');
const cacheUsageValue = document.querySelector('#cacheUsageValue');
const cacheClearButton = document.querySelector('#cacheClearBtn');
const resetDefaultsButton = document.querySelector('#resetDefaultsBtn');
const saveStatus = document.querySelector('#saveStatus');
const mobileWidthQuery = globalThis.matchMedia?.('(max-width: 640px)') ?? null;
const coarsePointerQuery = globalThis.matchMedia?.('(hover: none), (pointer: coarse)') ?? null;
let isMobileOptionsLayout = Boolean(mobileWidthQuery?.matches || coarsePointerQuery?.matches);
let saveStatusHideTimeout = null;
let saveStatusClearTimeout = null;

// Clamped the same way the preview clamps it, so a hand-edited value cannot
// put the slider off its track.
const normalizeAudioVolume = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_AUDIO_VOLUME;
  }
  return Math.min(1, Math.max(0, Math.round(numeric * 100) / 100));
};

const readSettings = async () => {
  try {
    const items = await storageGet('sync', [
      PROVIDER_OVERRIDE_KEY,
      AUDIO_VOLUME_KEY,
      ...PREVIEW_SETTING_KEYS,
    ]);

    return {
      providerOverride: normalizeProviderOverride(items?.[PROVIDER_OVERRIDE_KEY]),
      audioVolume: normalizeAudioVolume(items?.[AUDIO_VOLUME_KEY]),
      ...normalizePreviewSettings(items),
    };
  } catch {
    return {
      providerOverride: 'auto',
      audioVolume: DEFAULT_AUDIO_VOLUME,
      ...normalizePreviewSettings(),
    };
  }
};

/**
 * The music volume is written on its own, not with the form: the preview's own
 * slider writes it on a debounce, and folding it into the whole-form save
 * would have this page overwrite a level set there a moment ago.
 */
const writeAudioVolume = async (volume) => {
  try {
    await storageSet('sync', { [AUDIO_VOLUME_KEY]: normalizeAudioVolume(volume) });
    return true;
  } catch {
    return false;
  }
};

const writeSettings = async (settings) => {
  try {
    // Provider priority / disabled providers / auto-fallback are all emitted by
    // toPreviewSettingsStorage, so they must not be written separately here —
    // the spread would overwrite them anyway.
    const payload = toPreviewSettingsStorage(settings);
    // Settings picked in the preview, like the mania key count, have no control
    // here. Writing the form's default for them would undo the pick on every
    // save.
    for (const key of PREVIEW_ONLY_SETTING_KEYS) {
      delete payload[key];
    }

    // This page has no provider-override control. Only write the key when a
    // caller actually supplied one; otherwise writing a normalized `undefined`
    // silently resets the user's stored override to 'auto'.
    if (settings?.providerOverride !== undefined) {
      payload[PROVIDER_OVERRIDE_KEY] = normalizeProviderOverride(settings.providerOverride);
    }

    await storageSet('sync', payload);
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

let currentProviderPriority = [];
let disabledProviders = [];
let activePointerDrag = null;

const getProviderPriorityDomOrder = () => (
  [...providerPriorityList.querySelectorAll('.priority-item')].map(el => el.dataset.id)
);

const clearProviderPriorityDragStyles = () => {
  providerPriorityList.querySelectorAll('.priority-item').forEach(el => {
    el.style.transform = '';
    el.style.transition = '';
  });
};

const moveDraggingProviderItem = (draggingItem, targetItem, clientY) => {
  if (!draggingItem || !targetItem || draggingItem === targetItem) {
    return;
  }

  const items = [...providerPriorityList.querySelectorAll('.priority-item')];
  const positions = items.map(el => el.getBoundingClientRect().top);
  const bounding = targetItem.getBoundingClientRect();
  const offset = clientY - (bounding.top + (bounding.height / 2));
  let changed = false;

  if (offset > 0) {
    if (targetItem.nextSibling !== draggingItem) {
      targetItem.after(draggingItem);
      changed = true;
    }
  } else if (targetItem.previousSibling !== draggingItem) {
    targetItem.before(draggingItem);
    changed = true;
  }

  if (!changed) {
    return;
  }

  const newItems = [...providerPriorityList.querySelectorAll('.priority-item')];
  newItems.forEach((el) => {
    if (el === draggingItem) return;
    const oldTop = positions[items.indexOf(el)];
    const newTop = el.getBoundingClientRect().top;
    const delta = oldTop - newTop;

    if (delta !== 0) {
      el.style.transition = 'none';
      el.style.transform = `translateY(${delta}px)`;
      el.offsetHeight;
      el.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)';
      el.style.transform = 'translateY(0)';
    }
  });
};

const finishProviderPriorityReorder = async () => {
  providerPriorityList.classList.remove('is-dragging-active');
  clearProviderPriorityDragStyles();

  const newOrder = getProviderPriorityDomOrder();
  if (JSON.stringify(newOrder) !== JSON.stringify(currentProviderPriority)) {
    currentProviderPriority = newOrder;
    renderProviderPriority();
    await persistFormSettings();
  }
};

const renderProviderPriority = () => {
  if (!providerPriorityList) return;

  const allIds = ARCHIVE_DOWNLOAD_SOURCES.map((s) => s.id);
  const normalizedPriority = [...currentProviderPriority];
  allIds.forEach((id) => {
    if (!normalizedPriority.includes(id)) {
      normalizedPriority.push(id);
    }
  });

  const sortedSources = [...ARCHIVE_DOWNLOAD_SOURCES].sort((a, b) => {
    const indexA = normalizedPriority.indexOf(a.id);
    const indexB = normalizedPriority.indexOf(b.id);
    return indexA - indexB;
  });

  providerPriorityList.innerHTML = '';
  sortedSources.forEach((source, index) => {
    const isEnabled = !disabledProviders.includes(source.id);
    const item = document.createElement('div');
    item.className = `priority-item ${isEnabled ? '' : 'is-disabled'}`;
    item.draggable = !isMobileOptionsLayout;
    item.dataset.id = source.id;
    const handle = document.createElement('div');
    handle.className = 'priority-handle';
    handle.textContent = '⋮⋮';

    const label = document.createElement('div');
    label.className = 'priority-label';
    label.textContent = source.label;

    const actions = document.createElement('div');
    actions.className = 'priority-actions';

    const toggleWrap = document.createElement('div');
    toggleWrap.className = 'priority-toggle-wrap';

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'priority-toggle';
    toggleLabel.title = isEnabled ? `Disable ${source.label}` : `Enable ${source.label}`;

    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.className = 'priority-toggle-input';
    toggleInput.dataset.id = source.id;
    toggleInput.checked = isEnabled;
    toggleInput.setAttribute('aria-label', `${isEnabled ? 'Disable' : 'Enable'} ${source.label}`);

    const toggleMark = document.createElement('span');
    toggleMark.className = 'settings-toggle-mark';
    toggleMark.setAttribute('aria-hidden', 'true');

    toggleLabel.appendChild(toggleInput);
    toggleLabel.appendChild(toggleMark);
    toggleWrap.appendChild(toggleLabel);

    const moveBtns = document.createElement('div');
    moveBtns.className = 'priority-move-btns';

    // Caret glyphs below are Font Awesome Free 7.3.1 solid (CC BY 4.0).
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'priority-btn';
    upBtn.dataset.action = 'up';
    upBtn.dataset.id = source.id;
    upBtn.title = 'Move up';
    if (index === 0) upBtn.disabled = true;
    upBtn.innerHTML = '<svg viewBox="0 0 320 512"><path d="M140.3 135.2c12.6-10.3 31.1-9.5 42.8 2.2l128 128c9.2 9.2 11.9 22.9 6.9 34.9S301.4 320 288.5 320l-256 0c-12.9 0-24.6-7.8-29.6-19.8S.7 274.5 9.9 265.4l128-128 2.4-2.2z"/></svg>';

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'priority-btn';
    downBtn.dataset.action = 'down';
    downBtn.dataset.id = source.id;
    downBtn.title = 'Move down';
    if (index === sortedSources.length - 1) downBtn.disabled = true;
    downBtn.innerHTML = '<svg viewBox="0 0 320 512"><path d="M140.3 376.8c12.6 10.2 31.1 9.5 42.8-2.2l128-128c9.2-9.2 11.9-22.9 6.9-34.9S301.4 192 288.5 192l-256 0c-12.9 0-24.6 7.8-29.6 19.8S.7 237.5 9.9 246.6l128 128 2.4 2.2z"/></svg>';

    moveBtns.appendChild(upBtn);
    moveBtns.appendChild(downBtn);
    actions.appendChild(moveBtns);
    actions.appendChild(toggleWrap);
    item.appendChild(handle);
    item.appendChild(label);
    item.appendChild(actions);

    handle.draggable = !isMobileOptionsLayout;

    item.addEventListener('dragstart', (e) => {
      if (isMobileOptionsLayout) {
        e.preventDefault();
        return;
      }
      if (!e.target.closest('.priority-handle')) {
        e.preventDefault();
        return;
      }

      e.dataTransfer.setData('text/plain', source.id);
      e.dataTransfer.effectAllowed = 'move';
      
      const img = new Image();
      img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      e.dataTransfer.setDragImage(img, 0, 0);

      // Use requestAnimationFrame to avoid browser cancelling drag due to immediate style changes
      requestAnimationFrame(() => {
        item.classList.add('is-dragging');
        providerPriorityList.classList.add('is-dragging-active');
      });
    });

    item.addEventListener('dragend', async () => {
      if (isMobileOptionsLayout) {
        return;
      }
      item.classList.remove('is-dragging');
      providerPriorityList.classList.remove('is-dragging-active');

      // Reset any animation styles applied during dragging
      clearProviderPriorityDragStyles();

      await finishProviderPriorityReorder();
    });

    item.addEventListener('dragover', (e) => {
      if (isMobileOptionsLayout) {
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      moveDraggingProviderItem(providerPriorityList.querySelector('.is-dragging'), item, e.clientY);
    });

    handle.addEventListener('pointerdown', (event) => {
      if (isMobileOptionsLayout) {
        return;
      }
      if (event.pointerType === 'mouse') {
        return;
      }
      event.preventDefault();
      activePointerDrag = {
        pointerId: event.pointerId,
        item,
      };
      handle.setPointerCapture?.(event.pointerId);
      item.classList.add('is-dragging');
      providerPriorityList.classList.add('is-dragging-active');
    });

    handle.addEventListener('pointermove', (event) => {
      if (isMobileOptionsLayout) {
        return;
      }
      if (!activePointerDrag || activePointerDrag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.priority-item');
      if (target && providerPriorityList.contains(target)) {
        moveDraggingProviderItem(activePointerDrag.item, target, event.clientY);
      }
    });

    handle.addEventListener('pointerup', async (event) => {
      if (isMobileOptionsLayout) {
        return;
      }
      if (!activePointerDrag || activePointerDrag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      activePointerDrag.item.classList.remove('is-dragging');
      activePointerDrag = null;
      await finishProviderPriorityReorder();
    });

    handle.addEventListener('pointercancel', () => {
      if (isMobileOptionsLayout) {
        return;
      }
      if (!activePointerDrag) {
        return;
      }
      activePointerDrag.item.classList.remove('is-dragging');
      activePointerDrag = null;
      providerPriorityList.classList.remove('is-dragging-active');
      clearProviderPriorityDragStyles();
      renderProviderPriority();
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
    });

    providerPriorityList.appendChild(item);
  });
};

const refreshProviderPriorityInteractionMode = () => {
  const nextIsMobileOptionsLayout = Boolean(mobileWidthQuery?.matches || coarsePointerQuery?.matches);
  if (nextIsMobileOptionsLayout === isMobileOptionsLayout) {
    return;
  }
  isMobileOptionsLayout = nextIsMobileOptionsLayout;
  activePointerDrag = null;
  providerPriorityList?.classList.remove('is-dragging-active');
  clearProviderPriorityDragStyles();
  renderProviderPriority();
};

const moveProvider = async (id, direction) => {
  const allIds = ARCHIVE_DOWNLOAD_SOURCES.map((s) => s.id);
  if (currentProviderPriority.length === 0) {
    currentProviderPriority = [...allIds];
  }

  const index = currentProviderPriority.indexOf(id);
  if (index === -1) return;

  const newIndex = direction === 'up' ? index - 1 : index + 1;
  if (newIndex < 0 || newIndex >= currentProviderPriority.length) return;

  const temp = currentProviderPriority[index];
  currentProviderPriority[index] = currentProviderPriority[newIndex];
  currentProviderPriority[newIndex] = temp;

  renderProviderPriority();
  await persistFormSettings();
};

const toggleProvider = async (id, isEnabled) => {
  if (isEnabled) {
    disabledProviders = disabledProviders.filter((d) => d !== id);
  } else if (!disabledProviders.includes(id)) {
    disabledProviders.push(id);
  }

  // Update DOM directly to allow transitions to play
  const item = providerPriorityList.querySelector(`.priority-item[data-id="${id}"]`);
  if (item) {
    item.classList.toggle('is-disabled', !isEnabled);
    const input = item.querySelector('.priority-toggle-input');
    if (input) {
      input.setAttribute('aria-label', `${isEnabled ? 'Disable' : 'Enable'} ${item.querySelector('.priority-label')?.textContent || id}`);
    }
    const label = item.querySelector('.priority-toggle');
    if (label) {
      label.title = `${isEnabled ? 'Disable' : 'Enable'} ${item.querySelector('.priority-label')?.textContent || id}`;
    }
  }

  await persistFormSettings();
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
    maniaScrollSpeedValue.textContent = normalized.toFixed(1);
  }
  if (maniaScrollTimeValue) {
    maniaScrollTimeValue.textContent = `${baseScrollTimeMs} ms`;
  }
};

// Stored as 0-1, presented as a percentage.
const renderPercentSetting = (labelEl, value) => {
  if (labelEl) {
    labelEl.textContent = `${Math.round(Number(value) * 100)}%`;
  }
};

const getFormSettings = () => ({
  ...normalizePreviewSettings({
    popupSize: popupSizeSelect?.value,
    maniaScrollSpeed: maniaScrollSpeedInput?.value ?? maniaScrollSpeedRange?.value,
    maniaScaleScrollSpeedWithBpm: maniaScaleScrollWithBpm?.checked,
    maniaScrollDirection: maniaScrollDirection?.value,
    maniaTimingNoteColours: maniaTimingNoteColours?.checked,
    standardSnakingSliders: standardSnakingSliders?.checked,
    standardSliderSnakeOut: standardSliderSnakeOut?.checked,
    standardSliderEndCircles: standardSliderEndCircles?.checked,
    providerPriority: currentProviderPriority,
    disabledProviders,
    autoFallback: autoFallbackToggle?.checked ?? true,
    autoplay: autoplayToggle?.checked,
    hitsounds: hitsoundsToggle?.checked ?? false,
    hitsoundVolume: hitsoundVolumeRange ? Number(hitsoundVolumeRange.value) / 100 : undefined,
    hitsoundStyle: hitsoundStyleSelect?.value,
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

/**
 * Puts a whole settings object on the form. Both the first read and a reset go
 * through this, so neither can set a control the other forgets.
 */
const applySettingsToForm = (settings) => {
  if (autoFallbackToggle) {
    autoFallbackToggle.checked = settings.autoFallback;
  }
  if (autoplayToggle) {
    autoplayToggle.checked = settings.autoplay;
  }
  if (popupSizeSelect) {
    popupSizeSelect.value = settings.popupSize;
  }
  renderManiaScrollSpeed(settings.maniaScrollSpeed);
  renderProviderPriority();
  if (maniaScaleScrollWithBpm) {
    maniaScaleScrollWithBpm.checked = settings.maniaScaleScrollSpeedWithBpm;
  }
  if (maniaScrollDirection) {
    maniaScrollDirection.value = settings.maniaScrollDirection;
  }
  if (maniaTimingNoteColours) {
    maniaTimingNoteColours.checked = settings.maniaTimingNoteColours;
  }
  if (standardSnakingSliders) {
    standardSnakingSliders.checked = settings.standardSnakingSliders;
  }
  if (standardSliderSnakeOut) {
    standardSliderSnakeOut.checked = settings.standardSliderSnakeOut;
  }
  if (standardSliderEndCircles) {
    standardSliderEndCircles.checked = settings.standardSliderEndCircles;
  }
  if (hitsoundsToggle) {
    hitsoundsToggle.checked = settings.hitsounds;
  }
  if (hitsoundVolumeRange) {
    hitsoundVolumeRange.value = String(Math.round(settings.hitsoundVolume * 100));
    renderPercentSetting(hitsoundVolumeValue, settings.hitsoundVolume);
  }
  if (hitsoundStyleSelect) {
    hitsoundStyleSelect.value = settings.hitsoundStyle;
  }
  // Absent on a reset payload built from preview settings alone, where the
  // caller passes the default in alongside.
  if (audioVolumeRange && settings.audioVolume !== undefined) {
    const percent = Math.round(settings.audioVolume * 100);
    audioVolumeRange.value = String(percent);
    renderPercentSetting(audioVolumeValue, settings.audioVolume);
  }
};

const MIB = 1024 * 1024;

const formatMib = (bytes) => {
  const mib = Number(bytes) / MIB;
  if (!Number.isFinite(mib) || mib <= 0) {
    return '0 MiB';
  }
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MiB`;
};

/**
 * What the full-audio cache is holding. The caps are documented but nothing
 * showed what was actually used, so "Clear" was a button with no number next
 * to it.
 */
const renderCacheUsage = async () => {
  if (!cacheUsageValue) {
    return;
  }

  try {
    const { bytes, entries } = await getFullAudioCacheUsage();
    const cap = formatMib(FULL_AUDIO_CACHE_TOTAL_MAX_BYTES);
    if (entries === 0) {
      cacheUsageValue.textContent = `Nothing cached yet — up to ${cap}`;
    } else {
      const maps = entries === 1 ? '1 mapset' : `${entries} mapsets`;
      cacheUsageValue.textContent = `${formatMib(bytes)} of ${cap} — ${maps}`;
    }
    if (cacheClearButton) {
      cacheClearButton.disabled = entries === 0;
    }
  } catch {
    cacheUsageValue.textContent = 'Could not read the cache';
  }
};

// Clearing throws away audio that has to be downloaded again, so the first
// click only arms the button and the second does it. Anything else -- another
// click elsewhere, or waiting it out -- disarms.
const ARM_TIMEOUT_MS = 4000;
let armedButton = null;
let armTimeout = null;

const disarm = () => {
  if (armTimeout) {
    window.clearTimeout(armTimeout);
    armTimeout = null;
  }
  if (armedButton) {
    armedButton.classList.remove('is-armed');
    armedButton.textContent = armedButton.dataset.idleLabel || armedButton.textContent;
    armedButton = null;
  }
};

/** @returns true once the user has confirmed, by clicking a second time. */
const confirmBySecondClick = (button, armedLabel) => {
  if (armedButton === button) {
    disarm();
    return true;
  }
  disarm();
  armedButton = button;
  button.dataset.idleLabel = button.dataset.idleLabel || button.textContent;
  button.textContent = armedLabel;
  button.classList.add('is-armed');
  armTimeout = window.setTimeout(disarm, ARM_TIMEOUT_MS);
  return false;
};

const clearCache = async () => {
  if (cacheClearButton) {
    cacheClearButton.disabled = true;
  }
  try {
    await clearFullAudioCache();
    // The cached mapsets list is named from the cache entries, so it goes with
    // them rather than listing sets whose audio is gone.
    await clearHistory();
    showStatus('Cache cleared');
  } catch (error) {
    showStatus(`Could not clear the cache (${error?.message || error})`, true);
  }
  await renderCacheUsage();
};

const resetToDefaults = async () => {
  const defaults = normalizePreviewSettings();
  const didSave = await writeSettings(defaults);
  const didSaveVolume = await writeAudioVolume(DEFAULT_AUDIO_VOLUME);
  if (!didSave || !didSaveVolume) {
    showStatus('Failed to reset', true);
    return;
  }

  // Straight from what was written, so the form shows the settings that are
  // now in force rather than a second normalisation of the same input.
  currentProviderPriority = defaults.providerPriority;
  disabledProviders = defaults.disabledProviders;
  applySettingsToForm({ ...defaults, audioVolume: DEFAULT_AUDIO_VOLUME });
  showStatus('Settings reset');
};

const initialize = async () => {
  if (
    !popupSizeSelect
    || !maniaScrollSpeedRange
    || !maniaScrollSpeedInput
    || !maniaScaleScrollWithBpm
    || !maniaScrollDirection
    || !maniaTimingNoteColours
    || !standardSnakingSliders
    || !standardSliderSnakeOut
    || !standardSliderEndCircles
    || !providerPriorityList
  ) {
    return;
  }

  maniaScrollSpeedRange.min = String(MIN_MANIA_SCROLL_SPEED);
  maniaScrollSpeedRange.max = String(MAX_MANIA_SCROLL_SPEED);
  maniaScrollSpeedInput.min = String(MIN_MANIA_SCROLL_SPEED);
  maniaScrollSpeedInput.max = String(MAX_MANIA_SCROLL_SPEED);

  const settings = await readSettings();
  currentProviderPriority = settings.providerPriority || [];
  disabledProviders = settings.disabledProviders || [];
  applySettingsToForm(settings);
  void renderCacheUsage();

  hitsoundsToggle?.addEventListener('change', async () => {
    await persistFormSettings();
  });

  hitsoundStyleSelect?.addEventListener('change', async () => {
    await persistFormSettings();
  });

  hitsoundVolumeRange?.addEventListener('input', () => {
    renderPercentSetting(hitsoundVolumeValue, Number(hitsoundVolumeRange.value) / 100);
  });
  hitsoundVolumeRange?.addEventListener('change', async () => {
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

  maniaScrollDirection.addEventListener('change', async () => {
    await persistFormSettings();
  });

  maniaTimingNoteColours.addEventListener('change', async () => {
    await persistFormSettings();
  });

  autoFallbackToggle?.addEventListener('change', async () => {
    await persistFormSettings();
  });

  autoplayToggle?.addEventListener('change', async () => {
    await persistFormSettings();
  });

  audioVolumeRange?.addEventListener('input', () => {
    renderPercentSetting(audioVolumeValue, Number(audioVolumeRange.value) / 100);
  });
  audioVolumeRange?.addEventListener('change', async () => {
    const didSave = await writeAudioVolume(Number(audioVolumeRange.value) / 100);
    showStatus(didSave ? 'Saved' : 'Failed to save', !didSave);
  });

  cacheClearButton?.addEventListener('click', async () => {
    if (!confirmBySecondClick(cacheClearButton, 'Clear?')) {
      return;
    }
    await clearCache();
  });

  resetDefaultsButton?.addEventListener('click', async () => {
    if (!confirmBySecondClick(resetDefaultsButton, 'Reset?')) {
      return;
    }
    await resetToDefaults();
  });

  // Anywhere else cancels an armed button, so one left armed and forgotten
  // cannot be set off by the next click that lands on it.
  document.addEventListener('pointerdown', (event) => {
    if (armedButton && !armedButton.contains(event.target)) {
      disarm();
    }
  });

  standardSnakingSliders.addEventListener('change', async () => {
    await persistFormSettings();
  });

  standardSliderSnakeOut.addEventListener('change', async () => {
    await persistFormSettings();
  });

  standardSliderEndCircles.addEventListener('change', async () => {
    await persistFormSettings();
  });

  providerPriorityList.addEventListener('click', async (event) => {
    const btn = event.target.closest('.priority-btn');
    if (!btn) return;
    const { id, action } = btn.dataset;
    if (id && action) {
      await moveProvider(id, action);
    }
  });

  providerPriorityList.addEventListener('change', async (event) => {
    const toggle = event.target.closest('.priority-toggle-input');
    if (!toggle) return;
    const { id } = toggle.dataset;
    if (id) {
      await toggleProvider(id, toggle.checked);
    }
  });

  providerPriorityList.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  providerPriorityList.addEventListener('dragenter', (e) => {
    e.preventDefault();
  });
};

initialize().catch((error) => {
  // Otherwise the page sits there with every control unbound and no sign why.
  showStatus(`Could not load settings (${error?.message || error})`, true);
});

mobileWidthQuery?.addEventListener?.('change', refreshProviderPriorityInteractionMode);
coarsePointerQuery?.addEventListener?.('change', refreshProviderPriorityInteractionMode);
