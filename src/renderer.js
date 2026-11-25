// The preview's renderer: the map, the clock and the timeline, and which
// ruleset draws the playfield. Each ruleset lives in its own module under
// renderers/ (standard, taiko, catch, mania), with what they share in
// renderers/shared.js; this only hands a frame to the right one.

import { getCanvasContext } from './core/canvas.js';
import { clamp } from './core/math.js';
import { TimelineRenderer } from './timeline.js';
import {
  DEFAULT_COLOURS,
  EMPTY_PLAYFIELD_BACKGROUND,
  assignComboIndices,
  formatTime,
  getMaxObjectDurationMs,
  normalizeComboColour,
} from './renderers/shared.js';
import { StandardRenderer } from './renderers/standard.js';
import { TaikoRenderer } from './renderers/taiko.js';
import { CatchRenderer } from './renderers/catch.js';
import { ManiaRenderer } from './renderers/mania.js';

export class PreviewRenderer {
  // Without a timeline canvas it draws the playfield only: the difficulties
  // shown next to the one you opened share that one's timeline, and draw to an
  // ordinary canvas rather than a low-latency one (see core/canvas.js). Such a
  // renderer is handed that shared timeline as `selectionTimeline`, so it rings
  // the objects picked there while the timeline is showing its difficulty.
  constructor(playfieldCanvas, timelineCanvas = null, { lowLatency = true, selectionTimeline = null } = {}) {
    this.playfieldCanvas = playfieldCanvas;
    this.timeline = timelineCanvas ? new TimelineRenderer(timelineCanvas) : null;
    this.selectionTimeline = this.timeline || selectionTimeline;
    this.lowLatencyPlayfield = lowLatency;
    this.mapData = null;
    this.durationMs = 0;
    this.currentTimeMs = 0;
    this.comboColours = DEFAULT_COLOURS;
    this.maxObjectDurationMs = 0;
    this.standard = new StandardRenderer(this);
    this.taiko = new TaikoRenderer(this);
    this.catch = new CatchRenderer(this);
    this.mania = new ManiaRenderer(this);
  }

  // The ruleset that draws `mode`; anything unknown is drawn as mania, as it
  // always has been.
  rulesetRenderer(mode = this.mapData?.mode ?? 0) {
    switch (mode) {
      case 0: return this.standard;
      case 1: return this.taiko;
      case 2: return this.catch;
      default: return this.mania;
    }
  }

  setBeatmap(mapData, durationMs, { previewTimeMs = -1 } = {}) {
    this.mapData = mapData;
    this.durationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 1) : 1;
    this.currentTimeMs = clamp(this.currentTimeMs, 0, this.durationMs);
    this.timeline?.setBeatmap(mapData, this.durationMs, { previewTimeMs });
    this.comboColours = (Array.isArray(mapData?.comboColours) && mapData.comboColours.length > 0)
      ? mapData.comboColours.map(normalizeComboColour)
      : DEFAULT_COLOURS;

    this.maxObjectDurationMs = getMaxObjectDurationMs(mapData?.objects);

    if (Array.isArray(this.mapData?.objects)) {
      assignComboIndices(this.mapData.objects, this.mapData.mode ?? 0);
    }
    this.standard.setBeatmap?.(mapData);
    this.taiko.setBeatmap?.(mapData);
    this.catch.setBeatmap?.(mapData);
    this.mania.setBeatmap?.(mapData);
  }

  /**
   * The same mania map converted again at another key count. Only the objects
   * change, so the timeline keeps its zoom and the full track's length rather
   * than starting over the way a new map does.
   */
  replaceManiaObjects(mapData) {
    // Unless the timeline is showing another difficulty, which keeps it.
    const timelineShowsThisMap = this.showsTimelineObjects();
    this.mapData = mapData;
    this.maxObjectDurationMs = getMaxObjectDurationMs(mapData?.objects);
    this.mania.setBeatmap(mapData);
    if (timelineShowsThisMap) {
      this.selectionTimeline?.setObjects(mapData?.objects);
    }
  }

  /**
   * Puts another difficulty's map on this renderer's timeline, or this one's
   * back: see TimelineRenderer.showMap. The playfield is not touched.
   */
  showTimelineMap(mapData, { animate = false } = {}) {
    this.timeline?.showMap(mapData, { animate });
  }

  /**
   * Whether the timeline that picks objects for this playfield is showing this
   * playfield's own map. The selection is indices into the timeline's objects,
   * so only then do they name objects drawn here.
   */
  showsTimelineObjects() {
    const objects = this.mapData?.objects;
    return Boolean(this.selectionTimeline) && Array.isArray(objects) && this.selectionTimeline.objects === objects;
  }

  isTimelineDurationAnimating() {
    return Boolean(this.timeline?.isDurationAnimating());
  }

  /**
   * The duration growing, the bars moving to another difficulty's, or the
   * collapsed bar's wavy line moving: anything a paused timeline needs frames
   * for.
   */
  isTimelineAnimating() {
    return Boolean(
      this.timeline?.isDurationAnimating()
      || this.timeline?.isDensityMorphing()
      || this.timeline?.isWaveAnimating?.(),
    );
  }

  setDuration(durationMs, { animate = false } = {}) {
    this.durationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 1) : 1;
    this.currentTimeMs = clamp(this.currentTimeMs, 0, this.durationMs);
    return Boolean(this.timeline?.setDuration(this.durationMs, { animate }));
  }

  setTime(ms) {
    if (!Number.isFinite(ms)) {
      return;
    }
    this.currentTimeMs = clamp(ms, 0, this.durationMs || 1);
    this.timeline?.setTime(this.currentTimeMs);
  }

  dispose() {
    this.standard.dispose?.();
    this.taiko.dispose?.();
    this.catch.dispose?.();
    this.mania.dispose?.();
    this.timeline?.dispose?.();
    this.mapData = null;
  }

  // Each ruleset picks out the settings that are its own.
  setPreviewSettings(settings = {}) {
    this.standard.setSettings(settings);
    this.mania.setSettings(settings);
  }

  getDurationLabel() {
    return formatTime(this.durationMs);
  }

  getCurrentLabel() {
    return formatTime(this.currentTimeMs);
  }

  render() {
    this.renderPlayfield();
    this.renderTimeline();
  }

  renderTimeline() {
    this.timeline?.render();
  }

  /**
   * The object under a point on the playfield, as an index into the map's
   * objects, or -1. Each ruleset answers from what its last frame drew, so
   * the answer is always something on screen -- for the rulesets that scroll,
   * wherever the note happened to be at that moment.
   */
  objectIndexAtPoint(canvasX, canvasY) {
    return this.rulesetRenderer().objectIndexAtPoint?.(canvasX, canvasY) ?? -1;
  }

  /**
   * The picked objects to ring on this playfield, as a Set of indices into its
   * map's objects, or null. The selection is the timeline's, so only while the
   * timeline shows this playfield's own map.
   */
  getSelectionToRing() {
    if (!this.showsTimelineObjects()) {
      return null;
    }
    const selection = this.selectionTimeline?.selection;
    return selection && selection.size > 0 ? selection : null;
  }

  renderPlayfield() {
    const { ctx, width, height } = getCanvasContext(this.playfieldCanvas, { lowLatency: this.lowLatencyPlayfield });

    if (!this.mapData || !Array.isArray(this.mapData.objects) || this.mapData.objects.length === 0) {
      ctx.fillStyle = EMPTY_PLAYFIELD_BACKGROUND;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.font = '600 14px Torus, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No preview data available', width / 2, height / 2);
      return;
    }

    this.rulesetRenderer().render(ctx, width, height);
  }
}
