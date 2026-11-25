// Stand-ins for the extension APIs popup.html uses, for the dev harness only.
(() => {
  const PROXY_HOSTS = ['osu.ppy.sh', 'b.ppy.sh', 'assets.ppy.sh', 'catboy.best', 'osu.direct'];
  const proxied = (raw) => {
    try {
      const url = new URL(raw, location.href);
      if (url.protocol === 'https:' && PROXY_HOSTS.includes(url.hostname)) {
        return `/__proxy?url=${encodeURIComponent(url.href)}`;
      }
    } catch {
      // Not a URL.
    }
    return null;
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input?.url;
    const rewritten = raw ? proxied(raw) : null;
    return nativeFetch(rewritten || input, init);
  };

  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    enumerable: srcDescriptor.enumerable,
    get() {
      return srcDescriptor.get.call(this);
    },
    set(value) {
      srcDescriptor.set.call(this, proxied(value) || value);
    },
  });

  const stores = { sync: { embeddedPlayer: true }, local: {}, session: {} };
  const later = (callback, ...args) => setTimeout(() => callback?.(...args), 0);
  const area = (name) => ({
    get(keys, callback) {
      const source = stores[name];
      const out = {};
      if (keys == null) {
        Object.assign(out, source);
      } else if (typeof keys === 'string') {
        if (keys in source) out[keys] = source[keys];
      } else if (Array.isArray(keys)) {
        keys.forEach((key) => {
          if (key in source) out[key] = source[key];
        });
      } else {
        Object.keys(keys).forEach((key) => {
          out[key] = key in source ? source[key] : keys[key];
        });
      }
      later(callback, out);
    },
    set(items, callback) {
      Object.assign(stores[name], items);
      later(callback);
    },
    remove(keys, callback) {
      [].concat(keys).forEach((key) => delete stores[name][key]);
      later(callback);
    },
    clear(callback) {
      stores[name] = {};
      later(callback);
    },
    getBytesInUse(keys, callback) {
      later(callback, 0);
    },
  });
  const noopEvent = { addListener() {}, removeListener() {}, hasListener: () => false };
  const runtimeListeners = [];
  const runtimeEvent = {
    addListener: (fn) => runtimeListeners.push(fn),
    removeListener: (fn) => {
      const index = runtimeListeners.indexOf(fn);
      if (index >= 0) runtimeListeners.splice(index, 1);
    },
    hasListener: (fn) => runtimeListeners.includes(fn),
  };
  // What the browser does with a runtime message sent from the host's
  // content script: every listener here hears it, the first answer wins.
  window.__deliverRuntimeMessage = (message, sender) => {
    let response;
    [...runtimeListeners].forEach((fn) => fn(message, sender, (answer) => {
      if (response === undefined) response = answer;
    }));
    return response;
  };

  window.chrome = {
    runtime: {
      id: 'harness',
      lastError: undefined,
      getURL: (path) => new URL(path, `${location.origin}/`).href,
      getManifest: () => ({ version: '0.8.0' }),
      sendMessage: (...args) => later(args.find((arg) => typeof arg === 'function'), { ok: false, error: 'harness' }),
      onMessage: runtimeEvent,
      connect: () => ({ onMessage: noopEvent, onDisconnect: noopEvent, postMessage() {}, disconnect() {} }),
    },
    storage: {
      sync: area('sync'),
      local: area('local'),
      session: area('session'),
      onChanged: noopEvent,
    },
    tabs: {
      getCurrent: (callback) => later(callback, undefined),
      query: (query, callback) => later(callback, []),
      sendMessage: (...args) => later(args.find((arg) => typeof arg === 'function'), undefined),
      create: (options, callback) => later(callback, {}),
      onUpdated: noopEvent,
      onActivated: noopEvent,
    },
    windows: {
      getCurrent: (...args) => later(args.find((arg) => typeof arg === 'function'), { id: 1 }),
      onRemoved: noopEvent,
      onBoundsChanged: noopEvent,
    },
    commands: { getAll: (callback) => later(callback, []) },
    scripting: { executeScript: (options, callback) => later(callback, []) },
  };

  // The page posts to https://osu.ppy.sh and only listens to it; here the
  // host is this same origin.
  const realParent = window.parent;
  if (realParent && realParent !== window) {
    // `parent` is [Replaceable], so this page can see a stand-in without the
    // host page itself being touched.
    const fakeParent = {
      postMessage: (message, targetOrigin, transfer) => realParent.postMessage(message, '*', transfer),
    };
    window.parent = fakeParent;
    const nativeAdd = window.addEventListener;
    const nativeRemove = window.removeEventListener;
    const wrapped = new WeakMap();
    window.addEventListener = function addEventListener(type, listener, options) {
      if (type === 'message' && typeof listener === 'function') {
        const wrapper = (event) => {
          if (event.source !== realParent) {
            listener.call(this, event);
            return;
          }
          listener.call(this, new Proxy(event, {
            get(target, property) {
              if (property === 'origin') return 'https://osu.ppy.sh';
              if (property === 'source') return fakeParent;
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }));
        };
        wrapped.set(listener, wrapper);
        return nativeAdd.call(this, type, wrapper, options);
      }
      return nativeAdd.call(this, type, listener, options);
    };
    window.removeEventListener = function removeEventListener(type, listener, options) {
      return nativeRemove.call(this, type, wrapped.get(listener) || listener, options);
    };
  }
})();
