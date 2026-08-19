import {
  PROVIDER_OVERRIDE_KEY,
  MANIA_SCROLL_SPEED_KEY,
  MANIA_SCROLL_SCALE_WITH_BPM_KEY,
  MANIA_SCROLL_DIRECTION_KEY,
  MANIA_TIMING_NOTE_COLOURS_KEY,
  STANDARD_SNAKING_SLIDERS_KEY,
  STANDARD_SLIDER_SNAKE_OUT_KEY,
  STANDARD_SLIDER_END_CIRCLES_KEY,
  POPUP_SIZE_KEY,
  PROVIDER_PRIORITY_KEY,
  DISABLED_PROVIDERS_KEY,
  AUTO_FALLBACK_KEY,
  MIN_MANIA_SCROLL_SPEED,
  MAX_MANIA_SCROLL_SPEED,
  normalizeProviderOverride,
  normalizePreviewSettings,
  toPreviewSettingsStorage,
  calculateManiaScrollTimeMs,
  ARCHIVE_DOWNLOAD_SOURCES,
} from './settings.js';
import { storageGet, storageSet } from './webextension.js';

const popupSizeSelect = document.querySelector('#popupSize');
const maniaScrollSpeedRange = document.querySelector('#maniaScrollSpeedRange');
const maniaScrollSpeedInput = document.querySelector('#maniaScrollSpeedInput');
const maniaScrollSpeedValue = document.querySelector('#maniaScrollSpeedValue');
const maniaScrollTimeValue = document.querySelector('#maniaScrollTimeValue');
const maniaScaleScrollWithBpm = document.querySelector('#maniaScrollScaleWithBpm');
const maniaScrollDirection = document.querySelector('#maniaScrollDirection');
const maniaTimingNoteColours = document.querySelector('#maniaTimingNoteColours');
const standardSnakingSliders = document.querySelector('#standardSnakingSliders');
const standardSliderSnakeOut = document.querySelector('#standardSliderSnakeOut');
const standardSliderEndCircles = document.querySelector('#standardSliderEndCircles');
const autoFallbackToggle = document.querySelector('#autoFallback');
const providerPriorityList = document.querySelector('#providerPriorityList');
const saveStatus = document.querySelector('#saveStatus');
const mobileWidthQuery = globalThis.matchMedia?.('(max-width: 640px)') ?? null;
const coarsePointerQuery = globalThis.matchMedia?.('(hover: none), (pointer: coarse)') ?? null;
let isMobileOptionsLayout = Boolean(mobileWidthQuery?.matches || coarsePointerQuery?.matches);
let saveStatusHideTimeout = null;
let saveStatusClearTimeout = null;

const readSettings = async () => {
  try {
    const items = await storageGet('sync', [
      PROVIDER_OVERRIDE_KEY,
      MANIA_SCROLL_SPEED_KEY,
      MANIA_SCROLL_SCALE_WITH_BPM_KEY,
      MANIA_SCROLL_DIRECTION_KEY,
      MANIA_TIMING_NOTE_COLOURS_KEY,
      STANDARD_SNAKING_SLIDERS_KEY,
      STANDARD_SLIDER_SNAKE_OUT_KEY,
      STANDARD_SLIDER_END_CIRCLES_KEY,
      POPUP_SIZE_KEY,
      PROVIDER_PRIORITY_KEY,
      DISABLED_PROVIDERS_KEY,
      AUTO_FALLBACK_KEY,
    ]);

    return {
      providerOverride: normalizeProviderOverride(items?.[PROVIDER_OVERRIDE_KEY]),
      providerPriority: items?.[PROVIDER_PRIORITY_KEY] || [],
      disabledProviders: items?.[DISABLED_PROVIDERS_KEY] || [],
      autoFallback: items?.[AUTO_FALLBACK_KEY] ?? true,
      ...normalizePreviewSettings(items),
    };
  } catch {
    return {
      providerOverride: 'auto',
      providerPriority: [],
      disabledProviders: [],
      autoFallback: true,
      ...normalizePreviewSettings(),
    };
  }
};

const writeSettings = async (settings) => {
  try {
    // Provider priority / disabled providers / auto-fallback are all emitted by
    // toPreviewSettingsStorage, so they must not be written separately here —
    // the spread would overwrite them anyway.
    const payload = toPreviewSettingsStorage(settings);

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

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'priority-btn';
    upBtn.dataset.action = 'up';
    upBtn.dataset.id = source.id;
    upBtn.title = 'Move up';
    if (index === 0) upBtn.disabled = true;
    upBtn.innerHTML = '<svg viewBox="0 0 320 512"><path d="M182.6 137.4c-12.5-12.5-32.8-12.5-45.3 0l-128 128c-9.2 9.2-11.9 22.9-6.9 34.9s16.6 19.8 29.6 19.8H288c13 0 24.6-7.8 29.6-19.8s2.2-25.7-6.9-34.9l-128-128z"/></svg>';

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'priority-btn';
    downBtn.dataset.action = 'down';
    downBtn.dataset.id = source.id;
    downBtn.title = 'Move down';
    if (index === sortedSources.length - 1) downBtn.disabled = true;
    downBtn.innerHTML = '<svg viewBox="0 0 320 512"><path d="M137.4 374.6c12.5 12.5 32.8 12.5 45.3 0l128-128c9.2-9.2 11.9-22.9 6.9-34.9s-16.6-19.8-29.6-19.8H32c-13 0-24.6 7.8-29.6 19.8s-2.2 25.7 6.9 34.9l128 128z"/></svg>';

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
  if (autoFallbackToggle) {
    autoFallbackToggle.checked = settings.autoFallback;
  }
  popupSizeSelect.value = settings.popupSize;
  renderManiaScrollSpeed(settings.maniaScrollSpeed);
  renderProviderPriority();
  maniaScaleScrollWithBpm.checked = settings.maniaScaleScrollSpeedWithBpm;
  maniaScrollDirection.value = settings.maniaScrollDirection;
  maniaTimingNoteColours.checked = settings.maniaTimingNoteColours;
  standardSnakingSliders.checked = settings.standardSnakingSliders;
  standardSliderSnakeOut.checked = settings.standardSliderSnakeOut;
  standardSliderEndCircles.checked = settings.standardSliderEndCircles;

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

initialize();

mobileWidthQuery?.addEventListener?.('change', refreshProviderPriorityInteractionMode);
coarsePointerQuery?.addEventListener?.('change', refreshProviderPriorityInteractionMode);
