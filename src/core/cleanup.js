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
  window.addEventListener('unload', () => registry.cleanup());
}

export { CleanupRegistry, registry };
