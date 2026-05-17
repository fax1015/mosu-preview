import test from 'node:test';
import assert from 'node:assert/strict';
import { getStandardPlayfieldLayout } from '../src/renderer.js';

test('standard playfield layout reserves scaled edge space for hit circles', () => {
  const layout = getStandardPlayfieldLayout(438, 328, 2);

  assert.ok(layout.scale > 0);
  assert.ok(layout.edgePadding > 0);
  assert.ok(layout.visualX >= 0);
  assert.ok(layout.visualY >= 0);
  assert.ok(layout.playfieldX - layout.edgePadding >= 0);
  assert.ok(layout.playfieldY - layout.edgePadding >= 0);
  assert.ok(layout.playfieldX + layout.playfieldWidth + layout.edgePadding <= 438);
  assert.ok(layout.playfieldY + layout.playfieldHeight + layout.edgePadding <= 328);
});

test('standard playfield edge padding shrinks with smaller object radius', () => {
  const lowCs = getStandardPlayfieldLayout(438, 328, 2);
  const highCs = getStandardPlayfieldLayout(438, 328, 7);

  assert.ok(lowCs.edgePadding > highCs.edgePadding);
  assert.ok(highCs.scale > lowCs.scale);
});

test('standard playfield gutter is exactly the scaled drawn circle radius', () => {
  const layout = getStandardPlayfieldLayout(438, 328, 5);

  assert.equal(layout.playfieldX - layout.visualX, layout.edgePadding);
  assert.equal(layout.playfieldY - layout.visualY, layout.edgePadding);
  assert.equal(layout.visualWidth, layout.playfieldWidth + (layout.edgePadding * 2));
  assert.equal(layout.visualHeight, layout.playfieldHeight + (layout.edgePadding * 2));
});
