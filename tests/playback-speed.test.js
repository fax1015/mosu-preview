import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_PLAYBACK_SPEED,
  MIN_PLAYBACK_SPEED,
  PLAYBACK_SPEED_STEP,
  normalizePlaybackSpeed,
} from '../src/core/playbackSpeed.js';

test('nothing below half speed gets through', () => {
  // 0.1x was reachable before, and the audio stopped playing at all down there.
  assert.equal(MIN_PLAYBACK_SPEED, 0.5);
  assert.equal(normalizePlaybackSpeed(0.1), 0.5);
  assert.equal(normalizePlaybackSpeed(0.45), 0.5, 'a nudge down from 0.5x stays put');
  assert.equal(normalizePlaybackSpeed(0), 0.5);
  assert.equal(normalizePlaybackSpeed(-1), 0.5);
});

test('speeds snap to the slider step and stop at 2x', () => {
  assert.equal(normalizePlaybackSpeed(0.73), 0.75);
  assert.equal(normalizePlaybackSpeed(1.02), 1);
  assert.equal(normalizePlaybackSpeed(2.5), 2);
  assert.equal(normalizePlaybackSpeed(Number.NaN), 1);
  assert.equal(normalizePlaybackSpeed('1.5'), 1.5);
});

test('the slider offers exactly the range the clamp allows', () => {
  const html = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
  const slider = html.match(/<input[^>]*id="mapPreviewSpeedSlider"[^>]*>/)?.[0];
  assert.ok(slider, 'speed slider is in popup.html');
  const attribute = (name) => Number(slider.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1]);
  assert.equal(attribute('min'), MIN_PLAYBACK_SPEED * 100);
  assert.equal(attribute('max'), MAX_PLAYBACK_SPEED * 100);
  assert.equal(attribute('step'), PLAYBACK_SPEED_STEP * 100);

  const bounds = [...html.matchAll(/class="map-preview-speed-bound">([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(bounds, [`${MIN_PLAYBACK_SPEED}x`, `${MAX_PLAYBACK_SPEED}x`]);
});
