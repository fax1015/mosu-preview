import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArtwork, createMediaSessionController } from '../src/ui/mediaSession.js';

class FakeMetadata {
  constructor(init) {
    Object.assign(this, init);
  }
}

const makeSession = () => {
  const session = {
    metadata: null,
    playbackState: 'none',
    handlers: new Map(),
    positions: [],
    setActionHandler(action, handler) {
      if (action === 'unknownAction') {
        throw new TypeError('unsupported');
      }
      this.handlers.set(action, handler);
    },
    setPositionState(state) {
      this.positions.push(state);
    },
  };
  return session;
};

const makeController = ({ playback, clock = { now: 0 }, session = makeSession() } = {}) => {
  const calls = [];
  const live = { isPlaying: false, positionMs: 0, durationMs: 60000, rate: 1, ...playback };
  const controller = createMediaSessionController({
    mediaSession: session,
    MediaMetadataCtor: FakeMetadata,
    getPlayback: () => ({ ...live }),
    actions: {
      play: () => calls.push(['play']),
      pause: () => calls.push(['pause']),
      seekTo: (ms) => calls.push(['seekTo', ms]),
      seekBy: (ms) => calls.push(['seekBy', ms]),
    },
    now: () => clock.now,
  });
  return { controller, session, calls, live, clock };
};

test('does nothing where the browser has no media session', () => {
  const controller = createMediaSessionController({
    mediaSession: null,
    getPlayback: () => ({}),
    actions: {},
  });
  assert.doesNotThrow(() => {
    controller.setTrack({ title: 'x' });
    controller.sync();
    controller.clearTrack();
  });
});

test('media keys drive the preview, seeking by the arrow keys\' 5s unless told otherwise', () => {
  const { session, calls } = makeController();
  session.handlers.get('play')();
  session.handlers.get('pause')();
  session.handlers.get('seekbackward')({});
  session.handlers.get('seekforward')({ seekOffset: 10 });
  session.handlers.get('seekto')({ seekTime: 83.5 });
  session.handlers.get('seekto')({});
  assert.deepEqual(calls, [
    ['play'],
    ['pause'],
    ['seekBy', -5000],
    ['seekBy', 10000],
    ['seekTo', 83500],
  ]);
});

test('the track carries the title, artist, difficulty and the set cover', () => {
  const { controller, session } = makeController();
  controller.setTrack({ title: 'FREEDOM DiVE', artist: 'xi', version: 'FOUR DIMENSIONS', setId: '39804' });
  assert.equal(session.metadata.title, 'FREEDOM DiVE');
  assert.equal(session.metadata.artist, 'xi');
  assert.equal(session.metadata.album, 'FOUR DIMENSIONS');
  assert.deepEqual(session.metadata.artwork.map((art) => art.src), [
    'https://assets.ppy.sh/beatmaps/39804/covers/list.jpg',
    'https://assets.ppy.sh/beatmaps/39804/covers/list@2x.jpg',
  ]);
  assert.equal(session.playbackState, 'paused');
});

test('a set id that is not a number gets no artwork rather than a made-up URL', () => {
  assert.deepEqual(buildArtwork(null), []);
  assert.deepEqual(buildArtwork('../evil'), []);
  assert.equal(buildArtwork(12).length, 2);
});

test('nothing is reported before a track is set or after it is cleared', () => {
  const { controller, session } = makeController({ playback: { isPlaying: true } });
  controller.sync();
  assert.equal(session.positions.length, 0);
  assert.equal(session.playbackState, 'none');

  controller.setTrack({ title: 'a', setId: 1 });
  assert.equal(session.playbackState, 'playing');
  const pushed = session.positions.length;
  controller.clearTrack();
  controller.sync();
  assert.equal(session.metadata, null);
  assert.equal(session.playbackState, 'none');
  assert.equal(session.positions.length, pushed + 1, 'only the clearing call');
});

test('the position is sent in seconds, of the map clock, and clamped to the song', () => {
  const { controller, session, live } = makeController({ playback: { positionMs: 70000, durationMs: 60000, rate: 1.5 } });
  controller.setTrack({ title: 'a' });
  assert.deepEqual(session.positions.at(-1), { duration: 60, playbackRate: 1.5, position: 60 });

  live.positionMs = -20;
  live.isPlaying = true;
  controller.sync();
  assert.deepEqual(session.positions.at(-1), { duration: 60, playbackRate: 1.5, position: 0 });
});

test('a steady playhead is not re-sent every frame, but a seek or a drift is', () => {
  const { controller, session, live, clock } = makeController({ playback: { isPlaying: true, positionMs: 10000 } });
  controller.setTrack({ title: 'a' });
  assert.equal(session.positions.length, 1);

  // Playing on as the browser expects.
  for (let frame = 1; frame <= 60; frame += 1) {
    clock.now = frame / 60;
    live.positionMs = 10000 + (frame * 1000) / 60;
    controller.sync();
  }
  assert.equal(session.positions.length, 1);

  // A seek.
  live.positionMs = 40000;
  controller.sync();
  assert.equal(session.positions.length, 2);
  assert.equal(session.positions.at(-1).position, 40);

  // A speed change.
  live.rate = 0.75;
  controller.sync();
  assert.equal(session.positions.length, 3);
  assert.equal(session.positions.at(-1).playbackRate, 0.75);

  // Pausing.
  live.isPlaying = false;
  controller.sync();
  assert.equal(session.playbackState, 'paused');
  assert.equal(session.positions.length, 4);

  // Paused, time passing changes nothing.
  clock.now += 10;
  controller.sync();
  assert.equal(session.positions.length, 4);
});

test('a new duration, as when the full track arrives, is sent at once', () => {
  const { controller, session, live } = makeController({ playback: { durationMs: 263000 } });
  controller.setTrack({ title: 'a' });
  live.durationMs = 269000;
  controller.sync();
  assert.equal(session.positions.at(-1).duration, 269);
});

test('no position is sent while the duration is unknown', () => {
  const { controller, session } = makeController({ playback: { durationMs: 0 } });
  controller.setTrack({ title: 'a' });
  assert.equal(session.positions.length, 0);
  assert.equal(session.playbackState, 'paused');
});

test('a rejected position is retried on the next sync', () => {
  const session = makeSession();
  let reject = true;
  session.setPositionState = function setPositionState(state) {
    if (reject) {
      throw new TypeError('bad position');
    }
    this.positions.push(state);
  };
  const { controller } = makeController({ session });
  assert.doesNotThrow(() => controller.setTrack({ title: 'a' }));
  reject = false;
  controller.sync();
  assert.equal(session.positions.length, 1);
});
