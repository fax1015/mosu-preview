// How several difficulties share the preview area. The area keeps its size
// whatever is shown in it; only the grid inside it changes. Pure, so it can be
// tested.

// The map you opened plus three more. Past four, the panels in the popup's
// own preview area are too small to read, and every one is a full render per
// frame.
const MAX_PREVIEW_PANELS = 4;

// Width over height of a panel at rest: the single preview's own proportions,
// so a panel holds the playfield the way the single preview always has. Kept
// equal to the aspect-ratio on .map-preview-canvas-wrap in popup.css, which is
// set by a reference slider (see there, and the README's "preview size").
const PANEL_ASPECT = 4 / 3;

/**
 * Picks the columns and rows that give each panel the largest playfield in a
 * `width` x `height` area. A playfield keeps its proportions, so a panel's
 * worth is the smaller of its width over PANEL_ASPECT and its height. On a
 * tie (within half a pixel) the grid with fewer empty cells wins, and then the
 * one with more columns. The popup's own preview has the panels' proportions,
 * so two panels side by side and two stacked come out the same size there, and
 * which one won used to come down to rounding: side by side keeps the labels in
 * a row, as they always have been in the popup.
 */
const choosePanelGrid = (count, width, height, { gap = 0, aspect = PANEL_ASPECT } = {}) => {
  const panels = Math.max(1, Math.floor(Number(count) || 1));
  const areaWidth = Math.max(0, Number(width) || 0);
  const areaHeight = Math.max(0, Number(height) || 0);

  let best = null;
  for (let cols = 1; cols <= panels; cols += 1) {
    const rows = Math.ceil(panels / cols);
    const cellWidth = Math.max(0, (areaWidth - (gap * (cols - 1))) / cols);
    const cellHeight = Math.max(0, (areaHeight - (gap * (rows - 1))) / rows);
    const fit = Math.min(cellWidth / aspect, cellHeight);
    const empty = (cols * rows) - panels;
    // Columns are tried in ascending order, so on a full tie the later one wins.
    if (!best || fit > best.fit + 0.5 || (Math.abs(fit - best.fit) <= 0.5 && empty <= best.empty)) {
      best = { cols, rows, fit, empty, cellWidth, cellHeight };
    }
  }

  return { cols: best.cols, rows: best.rows, cellWidth: best.cellWidth, cellHeight: best.cellHeight };
};

export { MAX_PREVIEW_PANELS, PANEL_ASPECT, choosePanelGrid };
