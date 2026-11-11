import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The header's second line is "artist · difficulty" on one nowrap row, and how
// it gives way when the two do not fit is decided entirely in CSS. There is no
// layout engine here, so these guard the intent rather than the pixels: the
// measurements behind them were taken in a browser at 360px through 900px.
//
// What went wrong once: the difficulty carried `max-width: 55%`, which reads
// like "keep it at least half the line" but means the opposite. A short artist
// left a third of the row empty and the difficulty was clipped anyway, however
// wide the window was pulled.

const css = readFileSync(new URL('../popup.css', import.meta.url), 'utf8');

const ruleFor = (selector) => {
  const match = css.match(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `${selector} is styled in popup.css`);
  return match[1];
};

const artistRule = () => ruleFor('.map-preview-artist');
const versionRule = () => ruleFor('.map-preview-version');

const shrinkFactor = (rule) => {
  const shorthand = rule.match(/flex:\s*(\d+)\s+(\d+)\s/);
  if (shorthand) {
    return Number(shorthand[2]);
  }
  const longhand = rule.match(/flex-shrink:\s*(\d+)/);
  return longhand ? Number(longhand[1]) : null;
};

test('neither half of the subtitle is capped to a share of the line', () => {
  // A percentage cap clips text with room beside it, which is the whole bug.
  for (const [name, rule] of [['artist', artistRule()], ['difficulty', versionRule()]]) {
    assert.doesNotMatch(rule, /max-width:\s*\d+%/, `the ${name} is capped to a percentage again`);
  }
});

test('both halves can give way, and both say so with an ellipsis', () => {
  for (const [name, rule] of [['artist', artistRule()], ['difficulty', versionRule()]]) {
    assert.ok(shrinkFactor(rule) > 0, `the ${name} cannot shrink, so the row will overflow`);
    assert.match(rule, /text-overflow:\s*ellipsis/, `the ${name} cuts without an ellipsis`);
    assert.match(rule, /overflow:\s*hidden/);
  }
});

test('the artist gives way before the difficulty', () => {
  // The difficulty is what says which map this is, so it is cut last.
  assert.ok(
    shrinkFactor(artistRule()) > shrinkFactor(versionRule()),
    'the artist should shrink faster than the difficulty',
  );
});

test('the artist keeps a stub rather than disappearing, unless it is empty', () => {
  // A difficulty name long enough to overrun the row would otherwise take
  // every pixel: the header is the only place the artist is written.
  assert.match(artistRule(), /min-width:\s*[1-9][\d.]*ch/);
  // ...but a floor under no text at all is just an indent before the difficulty.
  assert.match(css, /\.map-preview-artist:empty\s*\{\s*min-width:\s*0;\s*\}/);
});
