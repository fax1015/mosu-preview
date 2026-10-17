import test from 'node:test';
import assert from 'node:assert/strict';
import { createHitsoundPlayer } from '../src/audio/hitsounds.js';

// Just enough of a context to route a media element. Like a browser, it refuses
// a second MediaElementSource for an element that already has one -- which is
// what made "detaching" and attaching again leave the music silent.
const createRoutingContext = () => {
  const sourcesByElement = new Map();
  const log = { sourcesCreated: 0, disconnected: [] };
  const node = (kind) => ({
    kind,
    gain: { value: 1, setValueAtTime(value) { this.value = value; } },
    frequency: { value: 0 },
    connect() {},
    disconnect() { log.disconnected.push(kind); },
  });

  const context = {
    sampleRate: 48000,
    currentTime: 0,
    state: 'running',
    outputLatency: 0.02,
    destination: node('destination'),
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
    createGain: () => node('gain'),
    createBiquadFilter: () => ({ ...node('filter'), Q: { value: 1 } }),
    createWaveShaper: () => node('shaper'),
    createConvolver: () => node('convolver'),
    createBuffer: (channels, frames) => ({ getChannelData: () => new Float32Array(frames) }),
    createMediaElementSource: (element) => {
      if (sourcesByElement.has(element)) {
        throw new Error('HTMLMediaElement already connected previously to a different MediaElementSourceNode');
      }
      const source = node('mediaSource');
      sourcesByElement.set(element, source);
      log.sourcesCreated += 1;
      return source;
    },
  };
  function RoutingContext(...args) {
    log.constructedWith = args;
    return context;
  }
  return { RoutingContext, log };
};

const createElement = () => ({ volume: 0.4, crossOrigin: null });

test('music joins the graph once and stays there when hitsounds are switched off', () => {
  const { RoutingContext, log } = createRoutingContext();
  const player = createHitsoundPlayer({ getAudioContext: RoutingContext });
  const element = createElement();

  assert.equal(player.attachMediaElement(element), true);
  player.setEnabled(false);

  assert.equal(player.isMediaElementAttached(), true, 'switching hitsounds off must not unroute the music');
  assert.equal(log.disconnected.includes('mediaSource'), false, 'a disconnected source plays nothing at all');
  assert.equal(player.attachMediaElement(element), true, 'switching them back on finds the music still routed');
  assert.equal(log.sourcesCreated, 1, 'a second source for the same element would throw');
});

test('there is no detach that would silence the music', () => {
  const player = createHitsoundPlayer({ getAudioContext: createRoutingContext().RoutingContext });
  assert.equal('detachMediaElement' in player, false);
});

test('once routed, the gain node is the only volume control', () => {
  const player = createHitsoundPlayer({ getAudioContext: createRoutingContext().RoutingContext });
  const element = createElement();
  player.setMusicVolume(0.6);

  player.attachMediaElement(element);

  assert.equal(element.volume, 1, 'element volume would attenuate the music a second time');
  assert.equal(element.crossOrigin, 'anonymous');
});

test('the context asks for bigger buffers only when told to', () => {
  const phone = createRoutingContext();
  createHitsoundPlayer({ getAudioContext: phone.RoutingContext, latencyHint: 'playback' }).ensureContext();
  assert.deepEqual(phone.log.constructedWith, [{ latencyHint: 'playback' }]);

  // Desktop keeps the browser's default, which its latency compensation was
  // measured against.
  const desktop = createRoutingContext();
  createHitsoundPlayer({ getAudioContext: desktop.RoutingContext }).ensureContext();
  assert.deepEqual(desktop.log.constructedWith, []);
});

test('dispose is what finally takes the music out of the graph', () => {
  const { RoutingContext, log } = createRoutingContext();
  const player = createHitsoundPlayer({ getAudioContext: RoutingContext });
  player.attachMediaElement(createElement());

  player.dispose();

  assert.ok(log.disconnected.includes('mediaSource'));
  assert.equal(player.isMediaElementAttached(), false);
});
