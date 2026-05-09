const randomRange = (min, max) => min + (Math.random() * (max - min));
const randomInt = (min, max) => Math.floor(randomRange(min, max + 1));

const createUnsupportedViewController = ({
  popup,
  unsupportedPanel,
  unsupportedAscii,
  state,
  registry,
  clamp,
  config,
}) => {
  const getUnsupportedAsciiGridSize = () => {
    const width = Math.max(140, unsupportedPanel?.clientWidth || 0);
    const height = Math.max(120, unsupportedPanel?.clientHeight || 0);
    const cols = Math.max(26, Math.min(120, Math.ceil(width / config.charWidthPx) + 1));
    const rows = Math.max(12, Math.min(40, Math.ceil(height / config.charHeightPx) + 1));
    return { cols, rows };
  };

  const createUnsupportedBubble = (cols, rows) => ({
    col: randomInt(0, Math.max(0, cols - 1)),
    row: randomInt(0, Math.max(0, rows - 1)),
    maxRadius: randomInt(config.bubbleMinRadius, config.bubbleMaxRadius),
    ageMs: -randomRange(0, 680),
    durationMs: randomRange(config.bubbleMinMs, config.bubbleMaxMs),
  });

  const createUnsupportedAsciiField = () => {
    const { cols, rows } = getUnsupportedAsciiGridSize();
    const bubbleCount = Math.max(30, Math.min(180, Math.round(cols * rows * config.bubbleDensity)));
    return {
      cols,
      rows,
      bubbles: Array.from({ length: bubbleCount }, () => createUnsupportedBubble(cols, rows)),
      lastTickMs: performance.now(),
    };
  };

  const bubbleSizeForProgress = (maxRadius, progress) => {
    if (progress <= 0 || progress >= 1) {
      return 0;
    }
    if (progress < 0.24) {
      const growRatio = progress / 0.24;
      return Math.max(1, Math.round(maxRadius * growRatio));
    }
    if (progress > 0.74) {
      const shrinkRatio = (1 - progress) / 0.26;
      return Math.max(1, Math.round(maxRadius * shrinkRatio));
    }
    return maxRadius;
  };

  const renderUnsupportedAsciiFrame = (field, nowMs) => {
    if (!field || !unsupportedAscii) {
      return;
    }

    const deltaMs = Math.max(8, Math.min(280, nowMs - field.lastTickMs));
    field.lastTickMs = nowMs;

    const { cols, rows } = field;
    const cellCount = cols * rows;
    const chars = new Array(cellCount).fill(' ');
    const weights = new Array(cellCount).fill(0);

    for (let i = 0; i < field.bubbles.length; i += 1) {
      const bubble = field.bubbles[i];
      bubble.ageMs += deltaMs;

      if (bubble.ageMs >= bubble.durationMs) {
        field.bubbles[i] = createUnsupportedBubble(cols, rows);
        continue;
      }

      if (bubble.ageMs < 0) {
        continue;
      }

      const progress = clamp(bubble.ageMs / bubble.durationMs, 0, 1);
      const radius = bubbleSizeForProgress(bubble.maxRadius, progress);
      if (radius <= 0) {
        continue;
      }

      const glyph = config.glyphs[Math.min(config.glyphs.length - 1, Math.max(1, radius - 1))] || 'O';
      const maxDx = Math.ceil(radius / Math.max(0.2, config.xyRatio));
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -maxDx; dx <= maxDx; dx += 1) {
          const col = bubble.col + dx;
          const row = bubble.row + dy;
          if (col < 0 || col >= cols || row < 0 || row >= rows) {
            continue;
          }

          const dist = Math.hypot(dx * config.xyRatio, dy);
          const ringEdge = radius - 0.9;
          if (dist > radius + 0.2 || dist < ringEdge) {
            continue;
          }

          const idx = (row * cols) + col;
          const drawWeight = radius + (1 - Math.abs(dist - radius));
          if (drawWeight < weights[idx]) {
            continue;
          }

          weights[idx] = drawWeight;
          chars[idx] = glyph;
        }
      }
    }

    const lines = [];
    for (let row = 0; row < rows; row += 1) {
      const start = row * cols;
      lines.push(chars.slice(start, start + cols).join(''));
    }
    unsupportedAscii.textContent = lines.join('\n');
  };

  const stopUnsupportedAsciiAnimation = () => {
    if (state.unsupportedAsciiTimer) {
      clearInterval(state.unsupportedAsciiTimer);
      state.unsupportedAsciiTimer = null;
    }
    state.unsupportedAsciiField = null;
  };

  const startUnsupportedAsciiAnimation = () => {
    if (!unsupportedPanel || !unsupportedAscii) {
      return;
    }

    stopUnsupportedAsciiAnimation();
    state.unsupportedAsciiField = createUnsupportedAsciiField();
    renderUnsupportedAsciiFrame(state.unsupportedAsciiField, performance.now());

    state.unsupportedAsciiTimer = registry.addInterval(setInterval(() => {
      if (!state.unsupportedAsciiField) {
        return;
      }

      const { cols, rows } = getUnsupportedAsciiGridSize();
      if (cols !== state.unsupportedAsciiField.cols || rows !== state.unsupportedAsciiField.rows) {
        state.unsupportedAsciiField = createUnsupportedAsciiField();
      }

      renderUnsupportedAsciiFrame(state.unsupportedAsciiField, performance.now());
    }, config.tickMs));
  };

  const setUnsupportedMode = (enabled) => {
    if (!popup) {
      return;
    }

    popup.classList.toggle('is-unsupported', Boolean(enabled));
    if (!unsupportedPanel || !unsupportedAscii) {
      return;
    }

    if (!enabled) {
      unsupportedPanel.hidden = true;
      stopUnsupportedAsciiAnimation();
      unsupportedAscii.textContent = '';
      return;
    }

    unsupportedPanel.hidden = false;
    startUnsupportedAsciiAnimation();
  };

  return {
    setUnsupportedMode,
    startUnsupportedAsciiAnimation,
    stopUnsupportedAsciiAnimation,
  };
};

export { createUnsupportedViewController };
