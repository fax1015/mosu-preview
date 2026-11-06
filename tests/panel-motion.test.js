import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelMotion, cubicBezier, scaleRect } from '../src/ui/panelMotion.js';

const makeElement = (rect = { left: 0, top: 0, width: 100, height: 80 }) => {
  const style = {
    removeProperty(name) {
      delete this[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
    },
  };
  return {
    rect,
    style,
    getBoundingClientRect() { return this.rect; },
  };
};

const makeClock = () => {
  const clock = { t: 0, frames: [], timers: [] };
  clock.now = () => clock.t;
  clock.requestFrame = (callback) => { clock.frames.push(callback); return clock.frames.length; };
  clock.cancelFrame = () => { clock.frames.length = 0; };
  clock.setTimer = (callback, ms) => { clock.timers.push({ at: clock.t + ms, callback }); return clock.timers.length; };
  clock.clearTimer = (id) => { if (clock.timers[id - 1]) clock.timers[id - 1].callback = null; };
  clock.step = (ms) => {
    clock.t += ms;
    const pending = clock.frames.splice(0);
    pending.forEach((callback) => callback());
  };
  return clock;
};

const makeMotion = (clock, { hidden = () => false } = {}) => createPanelMotion({
  now: clock.now,
  requestFrame: clock.requestFrame,
  cancelFrame: clock.cancelFrame,
  setTimer: clock.setTimer,
  clearTimer: clock.clearTimer,
  isHidden: hidden,
});

const px = (value) => Number.parseFloat(value);

test('the easing is the popovers\' ease-out: pinned at both ends, quick to start', () => {
  const ease = cubicBezier(0.32, 0.72, 0, 1);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(ease(0.25) > 0.5, `ease(0.25) = ${ease(0.25)}`);
  let previous = 0;
  for (let i = 1; i <= 100; i += 1) {
    const value = ease(i / 100);
    assert.ok(value >= previous - 1e-9, 'never runs backwards');
    previous = value;
  }
});

test('a panel starting tucked under the lead is a smaller copy of the lead\'s box, centred on it', () => {
  assert.deepEqual(scaleRect({ x: 0, y: 0, w: 100, h: 50 }, 0.5), { x: 25, y: 12.5, w: 50, h: 25 });
});

test('positions are measured within the container', () => {
  const motion = makeMotion(makeClock());
  const container = makeElement({ left: 20, top: 60, width: 357, height: 276 });
  const panel = makeElement({ left: 199.5, top: 60, width: 177.5, height: 276 });
  assert.deepEqual(motion.capture(container, [panel]).get(panel), { x: 179.5, y: 0, w: 177.5, h: 276 });
});

test('a move resizes the panel for real, drawing after each step, and hands it back to the grid', async () => {
  const clock = makeClock();
  const motion = makeMotion(clock);
  const lead = makeElement();
  let drawn = 0;
  // The lead going from the whole area to its left half.
  const done = motion.play([{
    element: lead,
    from: { x: 0, y: 0, w: 357, h: 276 },
    to: { x: 0, y: 0, w: 177.5, h: 276 },
    zIndex: 3,
  }], { duration: 100, onFrame: () => { drawn += 1; } });

  assert.equal(lead.style.position, 'absolute');
  assert.equal(px(lead.style.width), 357, 'first frame: where it was');
  assert.equal(px(lead.style.height), 276, 'the height it keeps is never touched');
  assert.equal(lead.style.zIndex, '3');
  assert.equal(drawn, 1);

  clock.step(30);
  const width = px(lead.style.width);
  assert.ok(width < 357 && width > 177.5, `on its way: ${width}`);
  assert.equal(px(lead.style.height), 276);
  assert.equal(drawn, 2, 'drawn again at the new size');

  clock.step(100);
  assert.equal(await done, true);
  for (const property of ['position', 'left', 'top', 'width', 'height', 'zIndex']) {
    assert.equal(lead.style[property], undefined, `${property} given back to the grid`);
  }
  assert.equal(drawn, 3, 'and once more where the grid puts it');
});

test('an arrival is solid by half way; a departure fades all the way', () => {
  const clock = makeClock();
  const motion = makeMotion(clock);
  const arriving = makeElement();
  const leaving = makeElement();
  const rect = { x: 0, y: 0, w: 100, h: 80 };
  void motion.play([
    { element: arriving, from: rect, to: rect, opacity: [0.35, 1] },
    { element: leaving, from: rect, to: rect, opacity: [1, 0], fade: 'full' },
  ], { duration: 100, easing: [0.45, 0, 0.55, 1] });
  assert.equal(arriving.style.opacity, '0.35');
  clock.step(50);
  assert.equal(arriving.style.opacity, '1');
  const half = Number(leaving.style.opacity);
  assert.ok(half > 0.3 && half < 0.7, `half way out: ${half}`);
});

test('cancelling a move resolves it as unfinished and clears its styles', async () => {
  const clock = makeClock();
  const motion = makeMotion(clock);
  const element = makeElement();
  const done = motion.play([{
    element,
    from: { x: 0, y: 0, w: 50, h: 40 },
    to: { x: 0, y: 0, w: 100, h: 80 },
    opacity: [0.35, 1],
  }]);
  assert.ok(motion.isRunning());
  motion.cancel();
  assert.equal(await done, false);
  assert.equal(element.style.width, undefined);
  assert.equal(element.style.opacity, undefined);
  assert.ok(!motion.isRunning());
});

test('a hidden page skips the motion, and one whose frames stop still ends on time', async () => {
  const clock = makeClock();
  let hidden = true;
  const motion = makeMotion(clock, { hidden: () => hidden });
  const element = makeElement();
  const item = { element, from: { x: 0, y: 0, w: 50, h: 40 }, to: { x: 0, y: 0, w: 100, h: 80 } };
  let drawnHidden = 0;
  assert.equal(await motion.play([item], { duration: 100, onFrame: () => { drawnHidden += 1; } }), true);
  assert.equal(element.style.width, undefined, 'never moved');
  assert.equal(drawnHidden, 1, 'but drawn once where it ends, for when the page is shown');

  hidden = false;
  let drawn = 0;
  const done = motion.play([item], { duration: 100, onFrame: () => { drawn += 1; } });
  assert.equal(px(element.style.width), 50, 'first frame drawn');
  // No more frames arrive; only the safety timer does.
  clock.t += 400;
  clock.timers.filter((timer) => timer.callback && timer.at <= clock.t).forEach((timer) => timer.callback());
  assert.equal(await done, true);
  assert.equal(element.style.width, undefined);
  assert.equal(drawn, 2, 'drawn where it ended');
  assert.ok(!motion.isRunning());
});
