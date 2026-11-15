import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMapPreviewData } from '../src/parser.js';
import { convertMapForMode, createLegacyRandom } from '../src/core/beatmapConversion.js';
import { DEFAULT_COLOURS, assignComboIndices } from '../src/renderers/shared.js';
import {
  BANANA_COLOURS,
  CATCHER_Y,
  FRUIT_START_Y,
  buildCatchAutoplayFrames,
  buildCatchModel,
  getCatchObjectScale,
  getCatchObjectY,
  getCatchPlayfieldLayout,
  getCatchWidth,
  getCatcherColourAt,
  getCatcherScale,
  getCatcherXAt,
} from '../src/renderers/catch.js';

const close = (actual, expected, epsilon = 1e-6) => (
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} is not ${expected}`)
);

const catchMap = (hitObjects, { circleSize = 5, extra = '' } = {}) => parseMapPreviewData(`osu file format v14

[General]
Mode: 2

[Difficulty]
CircleSize:${circleSize}
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1
${extra}
[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
${hitObjects.join('\n')}
`);

test('fruit and catcher sizes follow lazer\'s circle size scale', () => {
  // LegacyRulesetExtensions.CalculateScaleFromCircleSize: 0.5 at CS 5.
  close(getCatchObjectScale(5), 0.5);
  close(getCatchObjectScale(4), 0.57);
  close(getCatcherScale(4), 1.14);
  // Catcher.CalculateCatchWidth: 106.75 x scale x 0.8.
  close(getCatchWidth(5), 85.4);
});

test('objects fall from y = -100 to the catcher at y = 340 over the approach time', () => {
  assert.equal(FRUIT_START_Y, -100);
  assert.equal(CATCHER_Y, 340);
  close(getCatchObjectY(2000, 2000 - 600, 600), -100);
  close(getCatchObjectY(2000, 2000, 600), 340);
  close(getCatchObjectY(2000, 1700, 600), 120);
});

test('the catch field sits in the 640x480 view where lazer puts it', () => {
  const layout = getCatchPlayfieldLayout(640, 480);
  assert.equal(layout.scale, 1);
  assert.equal(layout.fieldX, 64);
  // 115.2px of a 768px screen, the playfield's top in CatchPlayfieldAdjustmentContainer.
  assert.equal(layout.fieldY, 72);

  // The popup's 4:3 preview, and a wide cell that centres it.
  const popup = getCatchPlayfieldLayout(410, 308);
  close(popup.scale, Math.min(410 / 640, 308 / 480));
  const wide = getCatchPlayfieldLayout(1280, 480);
  assert.equal(wide.fieldX, 320 + 64);
});

test('autoplay walks, dashes, and stands still where lazer\'s does', () => {
  // CS 5: half the catch width is 42.7.
  const objects = [
    { time: 1000, x: 100, type: 'fruit', hyperDash: false },
    { time: 1500, x: 400, type: 'fruit', hyperDash: false },
    { time: 1600, x: 420, type: 'droplet', hyperDash: false },
  ];
  const frames = buildCatchAutoplayFrames(objects, 5);

  // Walking 156px at 0.5px/ms takes 312ms, ending on the fruit.
  close(getCatcherXAt(frames, 0), 256);
  close(getCatcherXAt(frames, 687), 256);
  close(getCatcherXAt(frames, 1000 - 156), 178);
  close(getCatcherXAt(frames, 1000), 100);
  // 300px in 500ms is too fast to walk: dash for 50ms, then walk.
  assert.equal(frames.dashing[Array.from(frames.times).indexOf(1001)], 1);
  close(getCatcherXAt(frames, 1050), 130);
  close(getCatcherXAt(frames, 1275), 265);
  close(getCatcherXAt(frames, 1500), 400);
  // 20px away is already under the plate.
  close(getCatcherXAt(frames, 1600), 400);
});

test('a hyperdash is marked on the object a dash cannot leave in time', () => {
  const map = convertMapForMode(catchMap([
    '0,192,1000,1,0,0:0:0:0:',
    '512,192,1200,5,0,0:0:0:0:',
    '480,192,2000,1,0,0:0:0:0:',
  ], { circleSize: 4 }), 2);
  const [first, second, third] = map.catchObjects;
  assert.equal(first.hyperDash, true);
  assert.equal(first.hyperDashTargetTime, 1200);
  assert.equal(first.hyperDashTargetX, 512);
  assert.equal(second.hyperDash, false, '32px in 800ms is a walk');
  assert.equal(third.hyperDash, false, 'the last object leads nowhere');
});

test('banana showers are laid out as lazer\'s BananaShower and thrown by its generator', () => {
  const map = convertMapForMode(catchMap(['256,192,1000,12,0,2000,0:0:0:0:']), 2);
  const bananas = map.catchObjects.filter((object) => object.type === 'banana');
  // 1000ms halved down to 62.5ms: a banana at every step, both ends included.
  assert.equal(bananas.length, 17);
  assert.deepEqual(bananas.slice(0, 3).map((banana) => banana.time), [1000, 1062.5, 1125]);
  assert.equal(bananas.at(-1).time, 2000);

  // CatchBeatmapProcessor: one generator seeded 1337, four numbers a banana.
  const random = createLegacyRandom(1337);
  const expected = bananas.map(() => {
    const x = random.nextDouble() * 512;
    random.nextUInt();
    random.nextUInt();
    random.nextUInt();
    return x;
  });
  assert.deepEqual(bananas.map((banana) => banana.x), expected);

  // A shower with no length has no bananas at all.
  const empty = convertMapForMode(catchMap(['256,192,1000,12,0,1000,0:0:0:0:']), 2);
  assert.equal(empty.catchObjects.filter((object) => object.type === 'banana').length, 0);
});

test('tiny droplets scatter up to 20px off the path; fruit and droplets stay on it', () => {
  const map = convertMapForMode(catchMap(['100,192,1000,2,0,L|400:192,1,300']), 2);
  const tiny = map.catchObjects.filter((object) => object.type === 'tinyDroplet');
  assert.ok(tiny.length > 4);
  assert.ok(tiny.every((object) => Math.abs(object.x - object.originalX) <= 20));
  assert.ok(tiny.some((object) => object.x !== object.originalX), 'some of them moved');
  for (const object of map.catchObjects.filter((item) => item.type !== 'tinyDroplet')) {
    close(object.x, object.originalX);
  }
});

const modelFor = (osuMap) => {
  const map = convertMapForMode(osuMap, 2);
  assignComboIndices(map.objects, 2);
  return { map, model: buildCatchModel(map, DEFAULT_COLOURS) };
};

test('catch objects take the colour after their own object\'s index, not their combo\'s', () => {
  const { model } = modelFor(catchMap([
    '64,192,1000,5,0,0:0:0:0:',
    '128,192,1500,1,0,0:0:0:0:',
    '192,192,2000,2,0,L|392:192,1,200',
    '256,192,4000,12,0,4500,0:0:0:0:',
  ]));
  const [first, second] = model.objects;
  // PalpableCatchHitObject.GetComboColour: IndexInBeatmap + 1.
  assert.deepEqual(first.colour, DEFAULT_COLOURS[1]);
  assert.deepEqual(second.colour, DEFAULT_COLOURS[2]);
  const stream = model.objects.filter((object) => object.sourceObjectIndex === 2);
  assert.ok(stream.length > 2);
  assert.ok(stream.every((object) => object.colour === DEFAULT_COLOURS[3]), 'a juice stream is one colour');
  const bananas = model.objects.filter((object) => object.type === 'banana');
  assert.ok(bananas.every((object) => BANANA_COLOURS.includes(object.colour)));
});

test('fruit stay on the plate until the combo ends; droplets bounce straight off', () => {
  const { model } = modelFor(catchMap([
    '256,192,1000,5,0,0:0:0:0:',
    '256,192,1300,1,0,0:0:0:0:',
    '256,192,1600,2,0,L|356:192,1,100',
    '256,192,3000,5,0,0:0:0:0:',
  ]));
  const fruit = model.objects.filter((object) => object.type === 'fruit');
  const comboEnd = model.objects.find((object) => object.lastInCombo);
  // The juice stream's tail is the last thing its combo made.
  assert.equal(comboEnd.sourceObjectIndex, 2);
  assert.equal(comboEnd.type, 'fruit');
  for (const object of fruit.filter((item) => item.time <= comboEnd.time)) {
    assert.equal(object.leaveTime, comboEnd.time);
  }
  assert.equal(fruit.at(-1).leaveTime, Infinity, 'the last combo never ends');
  for (const object of model.objects.filter((item) => item.type === 'droplet' || item.type === 'tinyDroplet')) {
    assert.equal(object.leaveTime, object.time);
  }

  // Two fruit in the same place do not end up on top of one another.
  const [a, b] = fruit;
  assert.ok(Math.hypot(a.plateX - b.plateX, a.plateY - b.plateY) > 0);
});

test('the catcher turns red for a hyperdash and back once it lands', () => {
  const { model } = modelFor(catchMap([
    '0,192,1000,5,0,0:0:0:0:',
    '512,192,1200,1,0,0:0:0:0:',
    '480,192,2500,1,0,0:0:0:0:',
  ], { circleSize: 4 }));
  assert.deepEqual(model.hyperDashSpans, [{ start: 1000, end: 1200 }]);
  assert.deepEqual(getCatcherColourAt(model.hyperDashSpans, 900).colour, { r: 255, g: 255, b: 255 });
  const during = getCatcherColourAt(model.hyperDashSpans, 1190);
  assert.equal(during.hyper, true);
  assert.ok(during.colour.g < 70 && during.colour.r === 255, 'red by the end of the jump');
  const after = getCatcherColourAt(model.hyperDashSpans, 1500);
  assert.deepEqual(after.colour, { r: 255, g: 255, b: 255 });
});

test('the catcher waits out a banana shower, catching only what lands on it', () => {
  const { model } = modelFor(catchMap([
    '256,192,1000,5,0,0:0:0:0:',
    '256,192,1500,12,0,4000,0:0:0:0:',
    '64,192,5000,5,0,0:0:0:0:',
  ]));
  const bananas = model.objects.filter((object) => object.type === 'banana');
  assert.ok(bananas.length > 10);

  // It stays under the first fruit for the whole shower...
  for (const banana of bananas) {
    close(getCatcherXAt(model.frames, banana.time), 256);
  }
  // ...and still makes it to the next fruit.
  close(getCatcherXAt(model.frames, 5000), 64);

  // A banana within the catcher's reach is caught, the rest are let fall.
  const halfReach = getCatchWidth(5) / 2;
  for (const banana of bananas) {
    assert.equal(banana.missed, Math.abs(banana.x - 256) > halfReach, `banana at ${banana.x.toFixed(1)}`);
    assert.equal(banana.staysOnPlate, !banana.missed);
  }
  assert.ok(bananas.some((banana) => banana.missed), 'some fall past');
});
