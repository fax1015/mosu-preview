class CleanupRegistry {
  constructor() {
    this.timers = new Set();
    this.intervals = new Set();
    this.controllers = new Set();
  }

  addTimeout(id) {
    this.timers.add(id);
    return id;
  }

  addInterval(id) {
    this.intervals.add(id);
    return id;
  }

  /**
   * Clears a timer and drops it from the registry. Without these the sets only
   * ever grow: every toast, badge auto-hide, modal close and restarted
   * animation registered an id that then stayed for the lifetime of the page.
   * Returns null so callers can write `state.timer = registry.clearTimeout(state.timer)`.
   */
  clearTimeout(id) {
    if (id === null || id === undefined) {
      return null;
    }
    clearTimeout(id);
    this.timers.delete(id);
    return null;
  }

  clearInterval(id) {
    if (id === null || id === undefined) {
      return null;
    }
    clearInterval(id);
    this.intervals.delete(id);
    return null;
  }

  addAbortController(controller) {
    this.controllers.add(controller);
    return controller;
  }

  createAbortController() {
    return this.addAbortController(new AbortController());
  }

  releaseAbortController(controller) {
    if (!controller) {
      return;
    }
    this.controllers.delete(controller);
  }

  cleanup() {
    this.timers.forEach(clearTimeout);
    this.intervals.forEach(clearInterval);
    this.controllers.forEach((c) => c.abort());
    this.timers.clear();
    this.intervals.clear();
    this.controllers.clear();
  }
}

const registry = new CleanupRegistry();

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => registry.cleanup());
}

export { CleanupRegistry, registry };
