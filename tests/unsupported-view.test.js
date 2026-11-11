import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUnsupportedViewController } from '../src/ui/unsupportedView.js';

const createMockElements = () => {
  const popupClasses = new Set();
  const unsupportedPanelClasses = new Set(['is-hidden']);
  let textContent = '';

  const popup = {
    classList: {
      toggle: (cls, force) => {
        if (force === undefined) {
          if (popupClasses.has(cls)) popupClasses.delete(cls);
          else popupClasses.add(cls);
        } else if (force) {
          popupClasses.add(cls);
        } else {
          popupClasses.delete(cls);
        }
      },
      contains: (cls) => popupClasses.has(cls),
    },
  };

  const unsupportedPanel = {
    clientWidth: 350,
    clientHeight: 180,
    classList: {
      toggle: (cls, force) => {
        if (force === undefined) {
          if (unsupportedPanelClasses.has(cls)) unsupportedPanelClasses.delete(cls);
          else unsupportedPanelClasses.add(cls);
        } else if (force) {
          unsupportedPanelClasses.add(cls);
        } else {
          unsupportedPanelClasses.delete(cls);
        }
      },
      contains: (cls) => unsupportedPanelClasses.has(cls),
    },
  };

  const unsupportedAscii = {
    clientWidth: 350,
    clientHeight: 180,
    get textContent() {
      return textContent;
    },
    set textContent(val) {
      textContent = val;
    },
  };

  return { popup, unsupportedPanel, unsupportedAscii };
};

test('unsupported ASCII view controller toggles unsupported state and runs Conway Game of Life', () => {
  const { popup, unsupportedPanel, unsupportedAscii } = createMockElements();
  const state = {
    unsupportedAsciiTimer: null,
    unsupportedAsciiField: null,
  };

  const intervals = new Set();
  const registry = {
    addInterval: (id) => {
      intervals.add(id);
      return id;
    },
    clearInterval: (id) => {
      if (id === null || id === undefined) {
        return null;
      }
      clearInterval(id);
      intervals.delete(id);
      return null;
    },
  };

  const controller = createUnsupportedViewController({
    popup,
    unsupportedPanel,
    unsupportedAscii,
    state,
    registry,
    config: {
      tickMs: 240,
      charWidthPx: 6.2,
      charHeightPx: 11.2,
      xyRatio: 6.2 / 11.2,
    },
  });

  // Enable unsupported mode
  controller.setUnsupportedMode(true);
  assert.equal(popup.classList.contains('is-unsupported'), true);
  assert.equal(unsupportedPanel.classList.contains('is-hidden'), false);
  assert.notEqual(state.unsupportedAsciiField, null);
  assert.notEqual(state.unsupportedAsciiTimer, null);
  assert.equal(typeof unsupportedAscii.textContent, 'string');
  assert.equal(unsupportedAscii.textContent.includes('\n'), true);

  // Check initial field properties
  assert.equal(state.unsupportedAsciiField.grid.length > 0, true);
  assert.equal(state.unsupportedAsciiField.generation, 1);

  // Disable unsupported mode
  controller.setUnsupportedMode(false);
  assert.equal(popup.classList.contains('is-unsupported'), false);
  assert.equal(unsupportedPanel.classList.contains('is-hidden'), true);
  assert.equal(state.unsupportedAsciiTimer, null);
  assert.equal(state.unsupportedAsciiField, null);
  assert.equal(unsupportedAscii.textContent, '');

  // Stopping must also deregister the interval, otherwise the cleanup registry
  // accumulates a dead id every time the animation restarts.
  assert.equal(intervals.size, 0);
});

// --- the menu button the cached-mapsets panel carries -----------------------
//
// There are two ways into the options menu and only one of them is ever on
// screen. Which one depends on this view: it hides the header, so the panel
// needs its own; everywhere else the header is right above the panel and a
// second button is the same button twice.

const popupHtml = () => readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
const popupCss = () => readFileSync(new URL('../popup.css', import.meta.url), 'utf8');

test('both menu buttons open the same menu', () => {
  const html = popupHtml();
  const buttons = [...html.matchAll(/js-map-preview-info-btn/g)];

  assert.equal(buttons.length, 2, 'the header carries one and the cached panel the other');
  assert.match(html, /id="mapPreviewHeaderInfoBtn"/);
  assert.match(html, /id="mapPreviewRecentInfoBtn"/);
});

test('this view hides the header, which is why the panel carries a menu button', () => {
  // The premise of the rule below. If the header is ever shown here too, the
  // panel's button stops being the only way in and should go entirely.
  const css = popupCss();
  const rule = css.match(/\.map-preview-popup\.is-unsupported>\s*:not\([^{]*\)\s*\{[^}]*\}/);

  assert.ok(rule, 'everything but a few children is hidden in the unsupported view');
  assert.ok(!/map-preview-header/.test(rule[0]), 'the header is not one of the exceptions');
  assert.match(rule[0], /display:\s*none/);
});

test('the panel does not repeat the menu button the header is already showing', () => {
  assert.match(popupHtml(), /class="[^"]*map-preview-recent-menu-btn[^"]*"[\s\S]{0,120}id="mapPreviewRecentInfoBtn"/);
  assert.match(
    popupCss(),
    /\.map-preview-popup:not\(\.is-unsupported\)\s+\.map-preview-recent-menu-btn\s*\{\s*display:\s*none;\s*\}/,
  );
});
