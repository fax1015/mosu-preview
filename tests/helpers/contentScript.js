// Runs src/content.js against a page just real enough for it: a DOM of plain
// objects that keeps its listeners, extension storage backed by Maps (pass
// the same Maps to a second load to stand in for a reload), and runtime
// messaging that records what was sent.
//
// Not a test file itself: `node --test` only runs files named *.test.js.

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EMBEDDED_MESSAGE_CHANNEL } from '../../src/core/embeddedPlayer.js';

const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const EXTENSION_ORIGIN = 'moz-extension://test-uuid';
const HOST_ID = 'mosu-preview-embedded-host';

const contentSource = readFile(new URL('../../src/content.js', import.meta.url), 'utf8');

const makeClassList = () => ({
  set: new Set(),
  add(...names) { names.forEach((name) => this.set.add(name)); },
  remove(...names) { names.forEach((name) => this.set.delete(name)); },
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : force;
    if (on) this.set.add(name);
    else this.set.delete(name);
  },
  contains(name) { return this.set.has(name); },
});

const createDom = ({ postedToIframe, shadowModes }) => {
  const makeNode = (tag) => {
    const listeners = new Map();
    const node = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      type: '',
      title: '',
      src: '',
      innerHTML: '',
      textContent: '',
      style: { setProperty(name, value) { this[name] = value; } },
      children: [],
      parentNode: null,
      shadowRoot: null,
      attributes: new Map(),
      listeners,
      classList: makeClassList(),
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      removeAttribute(name) { this.attributes.delete(name); },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener() {},
      dispatch(type, event = {}) {
        (listeners.get(type) || []).forEach((fn) => fn(event));
      },
      setPointerCapture() {},
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      remove() {
        if (this.parentNode) {
          const index = this.parentNode.children.indexOf(this);
          if (index >= 0) this.parentNode.children.splice(index, 1);
          this.parentNode = null;
        }
      },
      // The tests can see into a closed root; the page could not.
      attachShadow({ mode } = {}) {
        shadowModes.push(mode);
        const shadow = makeNode('shadow-root');
        this.shadowRoot = shadow;
        return shadow;
      },
    };
    if (tag === 'iframe') {
      node.contentWindow = { postMessage: (msg, origin) => postedToIframe.push({ msg, origin }) };
    }
    return node;
  };
  return makeNode;
};

const createStorageArea = (map, areaName, storageListeners) => ({
  get: async (keys) => {
    const items = {};
    for (const key of [].concat(keys ?? [])) {
      if (map.has(key)) items[key] = map.get(key);
    }
    return items;
  },
  set: async (items) => {
    const changes = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: map.get(key), newValue: value };
      map.set(key, value);
    }
    storageListeners.forEach((fn) => fn(changes, areaName));
  },
});

/**
 * @param {object} [options]
 * @param {Map} [options.local] storage.local
 * @param {Map} [options.sync] storage.sync
 * @param {Map} [options.session] window.sessionStorage
 * @param {(message: object) => any} [options.answerRuntimeMessage] what an
 *   extension page answers a runtime message with; by default the iframe
 *   takes the shell's secret.
 */
const loadContentScript = async ({
  local = new Map(),
  sync = new Map(),
  session = new Map(),
  viewport = VIEWPORT,
  href = 'https://osu.ppy.sh/beatmapsets/55#osu/123',
  answerRuntimeMessage = (message) => (message?.type === 'mosuEmbeddedHostToken' ? { ok: true } : undefined),
} = {}) => {
  const runtimeListeners = [];
  const storageListeners = [];
  const runtimeMessages = [];
  const postedToIframe = [];
  const shadowModes = [];
  const makeNode = createDom({ postedToIframe, shadowModes });
  const windowNode = makeNode('window');
  const documentNode = makeNode('document');

  const html = makeNode('html');
  html.appendChild(makeNode('body'));
  const mockWindow = {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    location: { href },
    sessionStorage: {
      getItem: (key) => (session.has(key) ? session.get(key) : null),
      setItem: (key, value) => { session.set(key, String(value)); },
      removeItem: (key) => { session.delete(key); },
    },
    addEventListener: (type, fn) => windowNode.addEventListener(type, fn),
  };
  const sandbox = {
    window: mockWindow,
    document: {
      documentElement: html,
      body: html.children[0],
      createElement: (tag) => makeNode(tag),
      addEventListener: (type, fn) => documentNode.addEventListener(type, fn),
    },
    browser: {
      runtime: {
        getURL: (path) => `${EXTENSION_ORIGIN}/${path}`,
        onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
        sendMessage: async (message) => {
          runtimeMessages.push(message);
          return answerRuntimeMessage(message);
        },
      },
      storage: {
        local: createStorageArea(local, 'local', storageListeners),
        sync: createStorageArea(sync, 'sync', storageListeners),
        onChanged: { addListener: (fn) => storageListeners.push(fn) },
      },
    },
    crypto: globalThis.crypto,
    TextEncoder,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(await contentSource, sandbox);

  const find = (node, predicate) => {
    if (!node) return null;
    if (predicate(node)) return node;
    for (const child of [...node.children, ...(node.shadowRoot ? [node.shadowRoot] : [])]) {
      const found = find(child, predicate);
      if (found) return found;
    }
    return null;
  };
  const hasClass = (name) => (node) => String(node.className).split(/\s+/).includes(name);
  const host = () => html.children.find((node) => node.id === HOST_ID) || null;
  const shell = () => find(host(), hasClass('mosu-shell'));
  const iframe = () => find(host(), (node) => node.tagName === 'IFRAME');

  return {
    html,
    local,
    sync,
    session,
    runtimeMessages,
    postedToIframe,
    shadowModes,
    host,
    shell,
    iframe,
    find: (predicate) => find(host(), predicate),
    byClass: (name) => find(host(), hasClass(name)),
    /** What the toolbar popup sends; answered with { ok }. */
    open: (message = {}) => new Promise((resolve) => {
      runtimeListeners[0]({
        type: 'mosuEmbeddedOpen',
        beatmapId: '123',
        setId: '55',
        mode: 0,
        resumeTimeMs: -1,
        resumePaused: false,
        ...message,
      }, {}, resolve);
    }),
    close: () => runtimeListeners[0]({ type: 'mosuEmbeddedClose' }, {}, () => {}),
    /** A message posted up by the iframe (or, with other options, by someone else). */
    postFromIframe: (data, { origin = EXTENSION_ORIGIN, source = iframe()?.contentWindow } = {}) => {
      windowNode.dispatch('message', { origin, source, data: { channel: EMBEDDED_MESSAGE_CHANNEL, ...data } });
    },
    navigate: (nextHref) => {
      mockWindow.location.href = nextHref;
      documentNode.dispatch('turbo:load');
    },
    changeStorage: (changes, areaName) => storageListeners.forEach((fn) => fn(changes, areaName)),
    /** Long enough for storage, signing and messaging promises to settle. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 20)),
  };
};

export { EXTENSION_ORIGIN, VIEWPORT, loadContentScript };
