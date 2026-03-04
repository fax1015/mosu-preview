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

export const addStorageChangedListener = (listener) => {
  extensionApi?.storage?.onChanged?.addListener?.(listener);
};
