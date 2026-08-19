const formatDebugTime = (unixMs) => {
  const date = new Date(unixMs);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const createDebugPanelController = ({
  state,
  debugPanel,
  debugStatus,
  debugLog,
  debugLogLimit = 80,
  getProviderDisplayName,
}) => {
  const render = () => {
    if (debugPanel) {
      debugPanel.hidden = !state.debugPanelOpen;
    }

    // Nothing below is observable while the panel is closed, and addLog() calls
    // render() on every entry — including once per download-progress tick.
    if (!state.debugPanelOpen) {
      return;
    }

    if (debugStatus) {
      const status = state.fullAudioStatus || 'idle';
      const setLabel = state.activeSetId ? `set ${state.activeSetId}` : 'no set';
      const overrideLabel = `provider ${getProviderDisplayName(state.providerOverride)}`;
      const errorLabel = state.fullAudioError ? ` | error: ${state.fullAudioError}` : '';
      debugStatus.textContent = `status: ${status} | ${setLabel} | ${overrideLabel}${errorLabel}`;
    }

    if (debugLog) {
      if (!Array.isArray(state.debugLogs) || state.debugLogs.length === 0) {
        debugLog.textContent = 'No logs yet.';
      } else {
        debugLog.textContent = state.debugLogs
          .map((entry) => `[${formatDebugTime(entry.time)}] ${entry.message}`)
          .join('\n');
      }
    }
  };

  const addLog = (message) => {
    state.debugLogs.push({ time: Date.now(), message: String(message) });
    if (state.debugLogs.length > debugLogLimit) {
      state.debugLogs.splice(0, state.debugLogs.length - debugLogLimit);
    }
    render();
  };

  const clearLogs = () => {
    state.debugLogs = [];
    render();
  };

  const setOpen = (isOpen) => {
    state.debugPanelOpen = Boolean(isOpen);
    render();
  };

  const toggleOpen = () => {
    setOpen(!state.debugPanelOpen);
  };

  return {
    render,
    addLog,
    clearLogs,
    setOpen,
    toggleOpen,
  };
};

export { createDebugPanelController };
