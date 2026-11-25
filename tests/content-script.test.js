import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION_ORIGIN, loadContentScript } from './helpers/contentScript.js';
import {
  EMBEDDED_HOST_TOKEN_MESSAGE,
  EMBEDDED_RESUME_STORAGE_KEY,
  buildEmbeddedPageUrl,
  readEmbeddedParams,
  serializeResumeSnapshot,
} from '../src/core/embeddedPlayer.js';

const queryOf = (url) => url.slice(url.indexOf('?'));

test('the shell is closed to the page, and only this extension speaks for its iframe', async () => {
  const page = await loadContentScript();
  await page.open();
  assert.deepEqual(page.shadowModes, ['closed']);

  // Another extension, and the page itself, cannot close it.
  page.postFromIframe({ type: 'requestClose' }, { origin: 'chrome-extension://another-extension' });
  page.postFromIframe({ type: 'requestClose' }, { origin: 'https://osu.ppy.sh', source: {} });
  page.postFromIframe({ type: 'requestClose' }, { source: {} });
  assert.ok(page.host(), 'still mounted');

  page.postFromIframe({ type: 'requestClose' });
  assert.equal(page.host(), null);
});

test('messages into the iframe wait until it has taken the shell\'s secret, and every one carries it', async () => {
  let answerToken;
  const page = await loadContentScript({
    answerRuntimeMessage: (message) => (message.type === EMBEDDED_HOST_TOKEN_MESSAGE
      ? new Promise((resolve) => { answerToken = resolve; })
      : undefined),
  });
  await page.open();
  const { mountId } = readEmbeddedParams(page.iframe().src);
  assert.match(mountId, /^[0-9a-f]{32}$/, 'the iframe is told which shell it belongs to');

  page.navigate('https://osu.ppy.sh/beatmapsets/55#osu/456');
  page.postFromIframe({ type: 'ready' });
  await page.settle();

  assert.equal(page.runtimeMessages.length, 1);
  const [handover] = page.runtimeMessages;
  assert.equal(handover.type, EMBEDDED_HOST_TOKEN_MESSAGE);
  assert.equal(handover.mount, mountId);
  assert.match(handover.token, /^[0-9a-f]{64}$/);
  assert.equal(page.iframe().src.includes(handover.token), false, 'the secret is never in the URL');
  assert.deepEqual(page.postedToIframe, [], 'nothing goes in before the iframe has the secret');

  answerToken({ ok: true });
  await page.settle();
  assert.deepEqual(page.postedToIframe.map(({ msg }) => msg.type), ['pageUrlChanged']);
  for (const { msg, origin } of page.postedToIframe) {
    assert.equal(origin, EXTENSION_ORIGIN);
    assert.equal(msg.token, handover.token);
  }

  // A later message goes straight in, with the same secret.
  page.byClass('mosu-btn').dispatch('click', {});
  const collapsed = page.postedToIframe.at(-1).msg;
  assert.equal(collapsed.type, 'collapsedChanged');
  assert.equal(collapsed.token, handover.token);
  page.close();

  // Opened again: a new shell, with its own id and secret.
  await page.open();
  page.postFromIframe({ type: 'ready' });
  await page.settle();
  answerToken({ ok: true });
  await page.settle();
  const second = page.runtimeMessages.at(-1);
  assert.notEqual(second.mount, mountId);
  assert.notEqual(second.token, handover.token);
  page.close();
});

test('a drag or resize ends when pointer capture is lost without a pointerup', async () => {
  const page = await loadContentScript();
  await page.open();
  const shell = page.shell();
  const grab = (node, pointerId) => node.dispatch('pointerdown', {
    button: 0,
    pointerId,
    clientX: 500,
    clientY: 500,
    target: { closest: () => null },
    preventDefault() {},
    stopPropagation() {},
  });

  const dragHandle = page.byClass('mosu-drag-handle');
  grab(dragHandle, 1);
  assert.equal(shell.classList.contains('is-interacting'), true, 'the iframe ignores the pointer mid-drag');
  dragHandle.dispatch('lostpointercapture', { pointerId: 1 });
  assert.equal(shell.classList.contains('is-interacting'), false);
  assert.equal(shell.classList.contains('is-dragging'), false);

  const corner = page.byClass('mosu-resize--se');
  grab(corner, 2);
  assert.equal(shell.classList.contains('is-interacting'), true);
  corner.dispatch('lostpointercapture', { pointerId: 2 });
  assert.equal(shell.classList.contains('is-interacting'), false);

  // A pointer already gone cannot be captured: no drag starts that nothing
  // would end.
  dragHandle.setPointerCapture = () => {
    throw new Error('No active pointer with the given id is found.');
  };
  grab(dragHandle, 3);
  assert.equal(shell.classList.contains('is-interacting'), false);
  page.close();
});

test('turning the miniplayer setting off takes the shell down', async () => {
  const page = await loadContentScript();
  await page.open();
  page.changeStorage({ somethingElse: { newValue: false } }, 'sync');
  page.changeStorage({ embeddedPlayer: { newValue: false } }, 'local');
  assert.ok(page.host(), 'other keys and areas leave it be');

  page.changeStorage({ embeddedPlayer: { oldValue: true, newValue: false } }, 'sync');
  assert.equal(page.host(), null);
});

test('a reload resumes only from a snapshot this script signed', async () => {
  const local = new Map();
  const sync = new Map([['embeddedPlayer', true]]);
  const session = new Map();

  const before = await loadContentScript({ local, sync, session });
  await before.open();
  before.postFromIframe({ type: 'ready' });
  await before.settle();
  const snapshot = serializeResumeSnapshot({
    beatmapId: '777',
    setId: '55',
    mode: 0,
    currentTimeMs: 5000,
    isPlaying: false,
    playbackSpeed: 1,
  });
  before.postFromIframe({ type: 'playbackSnapshot', snapshot });
  await before.settle();

  const stored = JSON.parse(session.get(EMBEDDED_RESUME_STORAGE_KEY));
  assert.equal(typeof stored.body, 'string');
  assert.match(stored.mac, /^[0-9a-f]{64}$/);
  assert.match(local.get('mosuEmbeddedResumeKeyV1'), /^[0-9a-f]{64}$/, 'the key is kept in extension storage');

  // Reloaded: the same tab's sessionStorage and the same extension storage.
  const after = await loadContentScript({ local, sync, session: new Map(session) });
  await after.settle();
  const resumed = readEmbeddedParams(after.iframe()?.src || '');
  assert.equal(resumed.beatmapId, '777');
  assert.equal(resumed.resumeTimeMs, 5000);
  assert.equal(resumed.resumePaused, true);

  // A snapshot the page wrote, or changed, is not acted on.
  const forgeries = [
    JSON.stringify({ ...snapshot, beatmapId: '666', savedAt: Date.now() }),
    JSON.stringify({ body: stored.body.replace('"777"', '"666"'), mac: stored.mac }),
    JSON.stringify({ body: stored.body, mac: '00'.repeat(32) }),
  ];
  for (const forged of forgeries) {
    const tampered = await loadContentScript({
      local,
      sync,
      session: new Map([[EMBEDDED_RESUME_STORAGE_KEY, forged]]),
    });
    await tampered.settle();
    assert.equal(tampered.host(), null, `ignored: ${forged.slice(0, 40)}`);
  }

  // With the setting off, even a genuine one is dropped.
  const disabledSession = new Map(session);
  const disabled = await loadContentScript({ local, sync: new Map(), session: disabledSession });
  await disabled.settle();
  assert.equal(disabled.host(), null);
  assert.equal(disabledSession.has(EMBEDDED_RESUME_STORAGE_KEY), false);
});

test('the iframe URL is the one buildEmbeddedPageUrl builds', async () => {
  const page = await loadContentScript();

  const cases = [
    { beatmapId: '123', setId: '55', mode: 3, resumeTimeMs: 42_500, resumePaused: true },
    { beatmapId: '', setId: '', mode: null, sourceUrl: 'https://osu.ppy.sh/beatmapsets/55#osu/123' },
  ];
  for (const options of cases) {
    await page.open(options);
    const src = page.iframe().src;
    const { mountId } = readEmbeddedParams(src);
    assert.equal(queryOf(src), queryOf(buildEmbeddedPageUrl({ ...options, mountId })));
    assert.equal(readEmbeddedParams(src).isEmbedded, true);
    page.close();
  }
});
