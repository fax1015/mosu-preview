// The shortcuts panel: a compact list of what every key does, and the place
// those keys are changed.
//
// The list is built here rather than written out in popup.html because the
// keys on it are no longer fixed -- a chip is a button that rebinds the action
// next to it, and the row has to redraw when it does. The table it is built
// from lives in core/keybindings.js, so adding a shortcut means adding a row
// there and nothing here.
//
// Capture works by borrowing the popup's own keydown handler rather than
// adding a second one: while a chip is armed, `consumeCaptureKey` takes the
// next keypress before the preview sees it. That keeps one owner for the
// keyboard, which is the only way Escape can mean "stop rebinding" here and
// "close this" everywhere else.

import {
  ACTIONS_BY_ID,
  SHORTCUT_ROWS,
  assignKeybinding,
  eventKeyToken,
  formatBindingLabel,
  hasCustomKeybindings,
  isBindableKey,
  resetKeybinding,
  defaultKeybindings,
} from '../core/keybindings.js';

const createElement = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
};

const createShortcutsPanel = ({
  listElement,
  state,
  persistKeybindings,
  showPopupToast,
  addDebugLog = () => {},
}) => {
  // The browser owns the shortcut that opens the preview, so it is read once
  // and shown rather than offered for rebinding here.
  let browserShortcut = null;
  // Each action's chip, so a rebind can redraw the two rows it touched instead
  // of the whole list -- which would take the focus off the chip just used.
  const chips = new Map();
  let resetAllButton = null;

  const stopCapture = ({ redraw = true } = {}) => {
    const actionId = state.capturingShortcutAction;
    state.capturingShortcutAction = null;
    if (actionId && redraw) {
      refreshChip(actionId);
    }
    return actionId;
  };

  function refreshChip(actionId) {
    const chip = chips.get(actionId);
    if (!chip) {
      return;
    }

    const isCapturing = state.capturingShortcutAction === actionId;
    const keys = state.keybindings?.[actionId] || [];
    const label = ACTIONS_BY_ID[actionId]?.label || actionId;

    chip.textContent = isCapturing ? 'Press…' : formatBindingLabel(keys);
    chip.classList.toggle('is-capturing', isCapturing);
    chip.classList.toggle('is-unset', !isCapturing && keys.length === 0);
    chip.title = isCapturing
      ? 'Press a key, or Escape to cancel'
      : `${label} — click to rebind, right-click to reset`;
    chip.setAttribute('aria-label', isCapturing
      ? `Press a key for ${label}`
      : `${label}, ${formatBindingLabel(keys)}. Click to rebind.`);
    chip.setAttribute('aria-pressed', isCapturing ? 'true' : 'false');
  }

  const refreshResetAll = () => {
    if (resetAllButton) {
      resetAllButton.hidden = !hasCustomKeybindings(state.keybindings);
    }
  };

  const applyBindings = async (next, { changed = [] } = {}) => {
    state.keybindings = next;
    for (const actionId of changed) {
      refreshChip(actionId);
    }
    refreshResetAll();
    try {
      await persistKeybindings(next);
    } catch (error) {
      addDebugLog(`shortcuts: could not save the keymap (${error?.message || error})`);
      showPopupToast?.('Could not save that shortcut');
    }
  };

  const startCapture = (actionId) => {
    const previous = stopCapture();
    if (previous === actionId) {
      return;
    }
    state.capturingShortcutAction = actionId;
    refreshChip(actionId);
  };

  const rebind = async (actionId, key) => {
    const { bindings, replaced } = assignKeybinding(state.keybindings, actionId, key);
    stopCapture({ redraw: false });
    await applyBindings(bindings, { changed: [actionId, replaced].filter(Boolean) });
    if (replaced) {
      showPopupToast?.(`${ACTIONS_BY_ID[replaced]?.label || replaced} is now unset`);
    }
  };

  const resetOne = async (actionId) => {
    const { bindings, replaced } = resetKeybinding(state.keybindings, actionId);
    stopCapture({ redraw: false });
    await applyBindings(bindings, { changed: [actionId, replaced].filter(Boolean) });
  };

  const resetAll = async () => {
    stopCapture({ redraw: false });
    const bindings = defaultKeybindings();
    await applyBindings(bindings, { changed: [...chips.keys()] });
    showPopupToast?.('Shortcuts reset');
  };

  const formatKeyForMessage = (key) => (key === ' ' ? 'Space' : key);

  /**
   * The next keypress while a chip is armed.
   *
   * @returns true when it was taken, so the caller stops handling it.
   */
  const consumeCaptureKey = (event) => {
    if (!state.capturingShortcutAction) {
      return false;
    }

    const key = String(event?.key ?? '');
    // A modifier on its own is someone reaching for a combination the preview
    // does not take; wait rather than binding 'shift'.
    if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes(key)) {
      return true;
    }
    if (key === 'Escape') {
      stopCapture();
      return true;
    }

    const token = eventKeyToken(event);
    if (!isBindableKey(token)) {
      showPopupToast?.(`${formatKeyForMessage(key)} is kept by the preview`);
      stopCapture();
      return true;
    }
    if (event?.ctrlKey || event?.metaKey || event?.altKey) {
      showPopupToast?.('Shortcuts are single keys');
      stopCapture();
      return true;
    }

    void rebind(state.capturingShortcutAction, token);
    return true;
  };

  const buildChip = (actionId) => {
    const chip = createElement('button', 'map-preview-shortcut-key');
    chip.type = 'button';
    chip.dataset.action = actionId;
    chip.addEventListener('click', () => startCapture(actionId));
    chip.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void resetOne(actionId);
    });
    chips.set(actionId, chip);
    refreshChip(actionId);
    return chip;
  };

  const buildFixedChip = (label) => {
    const chip = createElement('span', 'map-preview-shortcut-key is-fixed', label);
    return chip;
  };

  const buildRow = (row) => {
    const item = createElement('div', 'map-preview-shortcut-item');

    const copy = createElement('div', 'map-preview-shortcut-copy');
    copy.append(createElement('span', 'map-preview-shortcut-desc', row.label));
    if (row.note) {
      copy.append(createElement('span', 'map-preview-shortcut-note', row.note));
    }

    const keys = createElement('div', 'map-preview-shortcut-keys');
    if (Array.isArray(row.fixed)) {
      row.fixed.forEach((label) => keys.append(buildFixedChip(label)));
    } else {
      row.actions.forEach((actionId) => keys.append(buildChip(actionId)));
    }

    item.append(keys, copy);
    return item;
  };

  const render = () => {
    if (!listElement) {
      return;
    }

    chips.clear();
    listElement.replaceChildren();

    // Read from the browser, not bound here, so it leads the list and says who
    // owns it rather than looking like a chip that refuses to be clicked.
    if (browserShortcut !== null) {
      const group = createElement('p', 'map-preview-shortcut-group', 'Browser');
      // "Alt + Shift + O" is far wider than any single key, so this row sizes
      // its key column to the chip instead of to the column the rest share.
      // The heading already says whose shortcut it is, so it carries no note:
      // there is no room for one beside a chip that long.
      const item = createElement('div', 'map-preview-shortcut-item map-preview-shortcut-item--browser');
      item.title = 'Change or clear this in the browser’s own extension shortcuts';
      const keys = createElement('div', 'map-preview-shortcut-keys');
      keys.append(buildFixedChip(browserShortcut || 'Not set'));
      const copy = createElement('div', 'map-preview-shortcut-copy');
      copy.append(createElement('span', 'map-preview-shortcut-desc', 'Open preview'));
      item.append(keys, copy);
      listElement.append(group, item);
    }

    let lastGroup = '';
    for (const row of SHORTCUT_ROWS) {
      if (row.group !== lastGroup) {
        lastGroup = row.group;
        listElement.append(createElement('p', 'map-preview-shortcut-group', row.group));
      }
      listElement.append(buildRow(row));
    }

    const footer = createElement('div', 'map-preview-shortcut-footer');
    // Short enough not to truncate at the panel's width; each chip's own
    // tooltip carries the right-click half.
    const hint = createElement('span', 'map-preview-shortcut-hint', 'Click a key to rebind');
    hint.title = 'Click a key to rebind it, right-click to put it back';
    footer.append(hint);
    resetAllButton = createElement('button', 'map-preview-shortcut-reset', 'Reset all');
    resetAllButton.type = 'button';
    resetAllButton.addEventListener('click', () => { void resetAll(); });
    footer.append(resetAllButton);
    listElement.append(footer);
    refreshResetAll();
  };

  /** The browser's own binding, once it has been read. */
  const setBrowserShortcut = (shortcut) => {
    // Joined tight rather than with spaces: a chord is already the widest
    // thing in the list, and this is how the browser's own shortcuts page
    // writes it.
    browserShortcut = shortcut === null || shortcut === undefined
      ? null
      : String(shortcut).split('+').map((part) => part.trim()).filter(Boolean).join('+');
    render();
  };

  /** A keymap that arrived from storage while the panel was up. */
  const setKeybindings = (bindings) => {
    state.keybindings = bindings;
    stopCapture({ redraw: false });
    for (const actionId of chips.keys()) {
      refreshChip(actionId);
    }
    refreshResetAll();
  };

  /** Closing the panel leaves nothing armed and waiting. */
  const dismiss = () => Boolean(stopCapture());

  return {
    render,
    dismiss,
    consumeCaptureKey,
    setBrowserShortcut,
    setKeybindings,
    isCapturing: () => Boolean(state.capturingShortcutAction),
  };
};

export { createShortcutsPanel };
