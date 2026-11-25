import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEWPORT, loadContentScript } from './helpers/contentScript.js';

const VIEWPORT_HEIGHT = VIEWPORT.height;

// Mounts the shell with `storedBounds` as the position it was last left at.
const mountShell = async (storedBounds) => {
  const page = await loadContentScript({ local: new Map([['mosuEmbeddedPlayerBoundsV1', storedBounds]]) });
  await page.open();

  const shell = page.shell();
  const collapseButton = page.find((node) => node.tagName === 'BUTTON'
    && /collapse|expand/i.test(node.attributes.get('aria-label') || ''));
  assert.ok(shell, 'the shell mounted');
  assert.ok(collapseButton, 'the collapse button mounted');

  const edges = () => {
    const bottom = Number.parseFloat(shell.style.bottom);
    const height = Number.parseFloat(shell.style.height);
    return { top: VIEWPORT_HEIGHT - bottom - height, bottom, height };
  };
  const toggle = () => collapseButton.dispatch('click', {});

  return { edges, toggle, close: page.close };
};

const EXPANDED_HEIGHT_GUESS = 443;

test('in the top half of the screen the bar collapses up to its top edge and expands back down', async () => {
  const shell = await mountShell({ width: 440, right: 20, bottom: VIEWPORT_HEIGHT - 40 - EXPANDED_HEIGHT_GUESS, collapsed: false });
  const expanded = shell.edges();
  assert.ok(expanded.top + (expanded.height / 2) < VIEWPORT_HEIGHT / 2, 'starts in the top half');

  shell.toggle();
  const collapsed = shell.edges();
  assert.ok(collapsed.height < expanded.height, 'collapsed');
  assert.equal(collapsed.top, expanded.top, 'the top edge stays put');
  assert.ok(collapsed.bottom > expanded.bottom, 'the bottom edge comes up');

  shell.toggle();
  assert.deepEqual(shell.edges(), expanded, 'expanding comes back to the same place');
  shell.close();
});

test('in the bottom half the bar keeps its bottom edge, as before', async () => {
  const shell = await mountShell({ width: 440, right: 20, bottom: 72, collapsed: false });
  const expanded = shell.edges();
  assert.ok(expanded.top + (expanded.height / 2) > VIEWPORT_HEIGHT / 2, 'starts in the bottom half');

  shell.toggle();
  const collapsed = shell.edges();
  assert.ok(collapsed.height < expanded.height);
  assert.equal(collapsed.bottom, expanded.bottom, 'the bottom edge stays put');

  shell.toggle();
  assert.deepEqual(shell.edges(), expanded);
  shell.close();
});

test('a bar put away collapsed near the top opens expanded downwards from its top edge', async () => {
  // Opening from the toolbar always expands; the bar was left collapsed at
  // 40px from the top.
  const shell = await mountShell({ width: 440, right: 20, bottom: VIEWPORT_HEIGHT - 40 - 156, collapsed: true });
  const opened = shell.edges();
  assert.ok(opened.height > 156, 'opened expanded');
  assert.equal(opened.top, 40, 'from the top edge the bar had');
  shell.close();
});
