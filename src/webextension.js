const browserApi = globalThis.browser ?? null;
const chromeApi = globalThis.chrome ?? null;
const extensionApi = browserApi ?? chromeApi;
const usesPromiseApi = Boolean(browserApi);

const toError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error;
  }
  return new Error(error?.message || fallbackMessage);
};

const getStorageArea = (areaName, fallbackAreaName = null) => (
  extensionApi?.storage?.[areaName]
  || (fallbackAreaName ? extensionApi?.storage?.[fallbackAreaName] : null)
  || null
);

export const storageGet = async (areaName, keys, { fallbackAreaName = null } = {}) => {
  const area = getStorageArea(areaName, fallbackAreaName);
  if (!area?.get) {
    throw new Error(`Storage area "${areaName}" is unavailable.`);
  }

  if (usesPromiseApi) {
    return area.get(keys);
  }

  return new Promise((resolve, reject) => {
    area.get(keys, (items) => {
      const error = chromeApi?.runtime?.lastError;
      if (error) {
        reject(toError(error, `Failed to read ${areaName} storage.`));
        return;
      }
      resolve(items || {});
    });
  });
};

export const storageSet = async (areaName, items, { fallbackAreaName = null } = {}) => {
  const area = getStorageArea(areaName, fallbackAreaName);
  if (!area?.set) {
    throw new Error(`Storage area "${areaName}" is unavailable.`);
  }

  if (usesPromiseApi) {
    await area.set(items);
    return;
  }

  await new Promise((resolve, reject) => {
    area.set(items, () => {
      const error = chromeApi?.runtime?.lastError;
      if (error) {
        reject(toError(error, `Failed to write ${areaName} storage.`));
        return;
      }
      resolve();
    });
  });
};

export const hasStorageArea = (areaName, fallbackAreaName = null) => Boolean(
  getStorageArea(areaName, fallbackAreaName),
);

export const queryTabs = async (queryInfo) => {
  if (!extensionApi?.tabs?.query) {
    throw new Error('Tabs API is unavailable.');
  }

  if (usesPromiseApi) {
    return extensionApi.tabs.query(queryInfo);
  }

  return new Promise((resolve, reject) => {
    extensionApi.tabs.query(queryInfo, (tabs) => {
      const error = chromeApi?.runtime?.lastError;
      if (error) {
        reject(toError(error, 'Failed to query tabs.'));
        return;
      }
      resolve(tabs || []);
    });
  });
};

export const createTab = async (createProperties) => {
  if (!extensionApi?.tabs?.create) {
    throw new Error('Tabs API is unavailable.');
  }

  if (usesPromiseApi) {
    return extensionApi.tabs.create(createProperties);
  }

  return new Promise((resolve, reject) => {
    extensionApi.tabs.create(createProperties, (tab) => {
      const error = chromeApi?.runtime?.lastError;
      if (error) {
        reject(toError(error, 'Failed to create tab.'));
        return;
      }
      resolve(tab || null);
    });
  });
};

export const hasWindowsApi = () => Boolean(extensionApi?.windows?.create);

export const getExtensionUrl = (path) => (
  extensionApi?.runtime?.getURL ? extensionApi.runtime.getURL(path) : path
);

export const createWindow = async (createData) => {
  if (!extensionApi?.windows?.create) {
    throw new Error('Windows API is unavailable.');
  }

  if (usesPromiseApi) {
    return extensionApi.windows.create(createData);
  }

  return new Promise((resolve, reject) => {
    extensionApi.windows.create(createData, (createdWindow) => {
      const error = chromeApi?.runtime?.lastError;
      if (error) {
        reject(toError(error, 'Failed to create window.'));
        return;
      }
      resolve(createdWindow || null);
    });
  });
};

/**
 * Resolves null instead of rejecting when the window is gone: the stored id of a
 * detached window that the user already closed is the expected case, not an error.
 */
export const getWindow = async (windowId) => {
  if (!extensionApi?.windows?.get) {
    return null;
  }

  if (usesPromiseApi) {
    try {
      return await extensionApi.windows.get(windowId);
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    extensionApi.windows.get(windowId, (existingWindow) => {
      // Reading lastError marks it as handled; skipping this logs a spurious
      // "Unchecked runtime.lastError" every time a stale id is probed.
      const error = chromeApi?.runtime?.lastError;
      resolve(error ? null : (existingWindow || null));
    });
  });
};

/** Resolves false rather than rejecting when the window is already gone. */
export const removeWindow = async (windowId) => {
  if (!extensionApi?.windows?.remove) {
    return false;
  }

  if (usesPromiseApi) {
    try {
      await extensionApi.windows.remove(windowId);
      return true;
    } catch {
      return false;
    }
  }

  return new Promise((resolve) => {
    extensionApi.windows.remove(windowId, () => {
      // Read to mark it handled, otherwise a stale id logs an unchecked error.
      const error = chromeApi?.runtime?.lastError;
      resolve(!error);
    });
  });
};

export const updateWindow = async (windowId, updateInfo) => {
  if (!extensionApi?.windows?.update) {
    throw new Error('Windows API is unavailable.');
  }

  if (usesPromiseApi) {
    return extensionApi.windows.update(windowId, updateInfo);
  }

  return new Promise((resolve, reject) => {
    extensionApi.windows.update(windowId, updateInfo, (updatedWindow) => {
      const error = chromeApi?.runtime?.lastError;
      if (error) {
        reject(toError(error, 'Failed to update window.'));
        return;
      }
      resolve(updatedWindow || null);
    });
  });
};

export const openOptionsPage = async () => {
  if (!extensionApi?.runtime?.openOptionsPage) {
    throw new Error('Runtime options page API is unavailable.');
  }

  if (usesPromiseApi) {
    return extensionApi.runtime.openOptionsPage();
  }

  return new Promise((resolve, reject) => {
    extensionApi.runtime.openOptionsPage(() => {
      const error = chromeApi?.runtime?.lastError;
      if (error) {
        reject(toError(error, 'Failed to open options page.'));
        return;
      }
      resolve();
    });
  });
};

// `windows.WINDOW_ID_NONE` reports that focus left the browser entirely.
export const WINDOW_ID_NONE = -1;

export const addTabsUpdatedListener = (listener) => {
  extensionApi?.tabs?.onUpdated?.addListener?.(listener);
};

export const addTabsActivatedListener = (listener) => {
  extensionApi?.tabs?.onActivated?.addListener?.(listener);
};

export const addTabsRemovedListener = (listener) => {
  extensionApi?.tabs?.onRemoved?.addListener?.(listener);
};

export const addWindowsFocusChangedListener = (listener) => {
  extensionApi?.windows?.onFocusChanged?.addListener?.(listener);
};

export const addStorageChangedListener = (listener) => {
  extensionApi?.storage?.onChanged?.addListener?.(listener);
};

export const addRuntimeMessageListener = (listener) => {
  extensionApi?.runtime?.onMessage?.addListener(listener);
};

export const sendRuntimeMessage = async (message) => {
  if (!extensionApi?.runtime?.sendMessage) {
    throw new Error('Runtime messaging API is unavailable.');
  }

  if (usesPromiseApi) {
    return extensionApi.runtime.sendMessage(message);
  }

  return new Promise((resolve, reject) => {
    extensionApi.runtime.sendMessage(message, (response) => {
      const error = chromeApi?.runtime?.lastError;
      if (error) {
        reject(toError(error, 'Failed to send runtime message.'));
        return;
      }
      resolve(response);
    });
  });
};
