const createUnsupportedViewController = ({
  popup,
  unsupportedPanel,
  unsupportedAscii,
  state,
  registry,
  config,
}) => {
  const getUnsupportedAsciiGridSize = () => {
    const width = Math.max(140, unsupportedAscii?.clientWidth || unsupportedPanel?.clientWidth || 0);
    const height = Math.max(120, unsupportedAscii?.clientHeight || unsupportedPanel?.clientHeight || 0);
    const charWidth = config.charWidthPx || 6.2;
    const charHeight = config.charHeightPx || 11.2;
    const cols = Math.max(20, Math.min(120, Math.floor(width / charWidth)));
    const rows = Math.max(10, Math.min(60, Math.floor(height / charHeight)));
    return { cols, rows };
  };

  const seedLifeGrid = (field) => {
    const { cols, rows, grid, nextGrid, age } = field;
    grid.fill(0);
    nextGrid.fill(0);
    age.fill(0);
    field.generation = 0;

    const density = 0.22 + (Math.random() * 0.05);

    // Uniformly populate across the entire grid (no empty top or left offsets)
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (Math.random() < density) {
          const idx = (r * cols) + c;
          grid[idx] = 1;
          age[idx] = 1;
        }
      }
    }
  };

  const createUnsupportedAsciiField = () => {
    const { cols, rows } = getUnsupportedAsciiGridSize();
    const cellCount = cols * rows;
    const field = {
      cols,
      rows,
      grid: new Uint8Array(cellCount),
      nextGrid: new Uint8Array(cellCount),
      age: new Uint8Array(cellCount),
      generation: 0,
    };
    seedLifeGrid(field);
    return field;
  };

  const stepGameOfLife = (field) => {
    const { cols, rows, grid, nextGrid, age } = field;

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const idx = (r * cols) + c;

        // 8-neighbor count with toroidal wrapping
        let neighbors = 0;
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            if (dr === 0 && dc === 0) continue;
            const nc = (c + dc + cols) % cols;
            const nr = (r + dr + rows) % rows;
            if (grid[(nr * cols) + nc] > 0) {
              neighbors += 1;
            }
          }
        }

        const isAlive = grid[idx] > 0;
        if (isAlive) {
          if (neighbors === 2 || neighbors === 3) {
            nextGrid[idx] = 1;
            age[idx] = Math.min(255, age[idx] + 1);
          } else {
            nextGrid[idx] = 0;
            age[idx] = 0;
          }
        } else if (neighbors === 3) {
          nextGrid[idx] = 1;
          age[idx] = 1;
        } else {
          nextGrid[idx] = 0;
          age[idx] = 0;
        }
      }
    }

    // Copy nextGrid back into grid
    grid.set(nextGrid);
    field.generation += 1;
  };

  const renderUnsupportedAsciiFrame = (field) => {
    if (!field || !unsupportedAscii) {
      return;
    }

    const { cols, rows, grid, age } = field;
    const lines = [];

    for (let r = 0; r < rows; r += 1) {
      let rowChars = '';
      const rowStart = r * cols;
      for (let c = 0; c < cols; c += 1) {
        const idx = rowStart + c;
        if (grid[idx] > 0) {
          const cellAge = age[idx];
          if (cellAge === 1) rowChars += 'o';
          else if (cellAge < 6) rowChars += 'O';
          else rowChars += '#';
        } else {
          rowChars += ' ';
        }
      }
      lines.push(rowChars);
    }

    unsupportedAscii.textContent = lines.join('\n');
    stepGameOfLife(field);
  };

  const stopUnsupportedAsciiAnimation = () => {
    state.unsupportedAsciiTimer = registry.clearInterval(state.unsupportedAsciiTimer);
    state.unsupportedAsciiField = null;
  };

  const startUnsupportedAsciiAnimation = () => {
    if (!unsupportedPanel || !unsupportedAscii) {
      return;
    }

    stopUnsupportedAsciiAnimation();
    state.unsupportedAsciiField = createUnsupportedAsciiField();
    renderUnsupportedAsciiFrame(state.unsupportedAsciiField);

    state.unsupportedAsciiTimer = registry.addInterval(setInterval(() => {
      if (!state.unsupportedAsciiField) {
        return;
      }

      const { cols, rows } = getUnsupportedAsciiGridSize();
      if (Math.abs(cols - state.unsupportedAsciiField.cols) >= 2 || Math.abs(rows - state.unsupportedAsciiField.rows) >= 2) {
        state.unsupportedAsciiField = createUnsupportedAsciiField();
      }

      renderUnsupportedAsciiFrame(state.unsupportedAsciiField);
    }, config.tickMs || 240));
  };

  const setUnsupportedMode = (enabled) => {
    if (!popup) {
      return;
    }

    popup.classList.toggle('is-unsupported', Boolean(enabled));
    if (!unsupportedPanel || !unsupportedAscii) {
      return;
    }

    unsupportedPanel.classList.toggle('is-hidden', !enabled);
    if (!enabled) {
      stopUnsupportedAsciiAnimation();
      unsupportedAscii.textContent = '';
      return;
    }

    startUnsupportedAsciiAnimation();
  };

  return {
    setUnsupportedMode,
    startUnsupportedAsciiAnimation,
    stopUnsupportedAsciiAnimation,
  };
};

export { createUnsupportedViewController };




