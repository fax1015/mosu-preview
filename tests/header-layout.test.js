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
// wide the window was pulled. And once more: the artist's floor was a fixed
// `min-width: 3ch`, which padded a name shorter than that ("Lia") out to 3ch
// and pushed the dot away from it.

const css = readFileSync(new URL('../popup.css', import.meta.url), 'utf8');

const ruleFor = (selector) => {
  const match = css.match(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `${selector} is styled in popup.css`);
  // Declarations only: the comments explain old values, and would match them.
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '');
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
    // An ellipsis needs overflow other than visible; either of these will do.
    assert.match(rule, /(^|[^-])overflow:\s*(hidden|clip)/, `the ${name} does not clip its overflow`);
  }
});

test('the artist gives way before the difficulty', () => {
  // The difficulty is what says which map this is, so it is cut last.
  assert.ok(
    shrinkFactor(artistRule()) > shrinkFactor(versionRule()),
    'the artist should shrink faster than the difficulty',
  );
});

test('the artist keeps a stub rather than disappearing, no wider than its own name', () => {
  const rule = artistRule();
  // A difficulty name long enough to overrun the row would otherwise take
  // every pixel: the header is the only place the artist is written. The stub
  // is a width with min-width left at auto, so a flex item's automatic minimum
  // makes the floor the smaller of that width and the name itself.
  assert.match(rule, /(^|[^-])width:\s*[1-9][\d.]*ch/, 'the artist has no stub to fall back to');
  assert.doesNotMatch(rule, /min-width:\s*[1-9][\d.]*ch/,
    'a fixed min-width pads a short artist ("Lia") out and leaves a gap before the dot');
  // That width must not also be the size: the basis is the text.
  assert.match(rule, /flex:\s*\d+\s+\d+\s+content\b|flex-basis:\s*content\b/,
    'the artist is sized by its width rather than its name');
  // A scroll container's automatic minimum is 0, which would throw the stub away.
  assert.doesNotMatch(rule, /(^|[^-])overflow:\s*hidden/, 'overflow: hidden drops the stub to 0');
});
