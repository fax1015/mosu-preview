const COLORS = {
  visual: '#8c66ff',
  visualFill: 'rgba(140, 102, 255, 0.22)',
  visualWork: '#59c8f0',
  audio: '#efc45f',
  audioFill: 'rgba(239, 196, 95, 0.2)',
  audioWork: '#3bcf80',
  baseline: '#7d7894',
  dropped: '#e05252',
  grid: 'rgba(255, 255, 255, 0.08)',
  axis: 'rgba(255, 255, 255, 0.16)',
  text: '#a29db6',
  textStrong: '#f5f4fa',
  budget60: 'rgba(59, 207, 128, 0.5)',
  budget120: 'rgba(89, 200, 240, 0.45)',
  budget30: 'rgba(224, 82, 82, 0.45)',
  p50: '#59c8f0',
  p95: '#efc45f',
  p99: '#e05252',
};

const FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const makeEl = (tag, className = '', text = '') => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
};

const setupCanvas = (host, heightCss) => {
  host.replaceChildren();
  const widthCss = Math.max(300, Math.floor(host.clientWidth || host.parentElement?.clientWidth || 640));
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const canvas = document.createElement('canvas');
  canvas.className = 'chart-canvas';
  canvas.width = Math.round(widthCss * dpr);
  canvas.height = Math.round(heightCss * dpr);
  canvas.style.width = '100%';
  canvas.style.height = `${heightCss}px`;

  const tooltip = makeEl('div', 'chart-tooltip');
  host.append(canvas, tooltip);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { canvas, ctx, tooltip, width: widthCss, height: heightCss };
};

const positionTooltip = (tooltip, host, x, y, lines) => {
  tooltip.replaceChildren();
  lines.forEach((line, index) => {
    const row = makeEl('div', index === 0 ? 'chart-tooltip-title' : '', line);
    tooltip.append(row);
  });
  tooltip.classList.add('visible');
  const hostRect = host.getBoundingClientRect();
  const tipWidth = tooltip.offsetWidth || 180;
  const tipHeight = tooltip.offsetHeight || 60;
  const left = x + 14 + tipWidth > hostRect.width ? Math.max(4, x - tipWidth - 14) : x + 14;
  const top = Math.max(4, Math.min(hostRect.height - tipHeight - 4, y - tipHeight / 2));
  tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
};

const hideTooltip = (tooltip) => {
  tooltip.classList.remove('visible');
};

const niceMax = (value) => {
  if (!Number.isFinite(value) || value <= 0) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  if (normalized <= 1.2) return 1.2 * magnitude;
  if (normalized <= 1.5) return 1.5 * magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 2.5) return 2.5 * magnitude;
  if (normalized <= 3) return 3 * magnitude;
  if (normalized <= 4) return 4 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  if (normalized <= 6) return 6 * magnitude;
  if (normalized <= 8) return 8 * magnitude;
  return 10 * magnitude;
};

const drawHorizontalGrid = (ctx, pad, plotW, plotH, yMax, { ticks = 4, unit = '', decimals = 1 } = {}) => {
  ctx.font = `11px ${FONT_MONO}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= ticks; i += 1) {
    const ratio = i / ticks;
    const y = pad.top + plotH * (1 - ratio);
    const val = yMax * ratio;
    ctx.strokeStyle = i === 0 ? COLORS.axis : COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, Math.round(y) + 0.5);
    ctx.lineTo(pad.left + plotW, Math.round(y) + 0.5);
    ctx.stroke();

    ctx.fillStyle = COLORS.text;
    const label = decimals === 0 ? Math.round(val).toString() : val.toFixed(decimals);
    ctx.fillText(`${label}${unit}`, pad.left - 8, y);
  }
};

const formatShortDate = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day}`;
};

const formatDateTime = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

// ---------------------------------------------------------------------------
// 1. Frame-Time Timeline Chart
// ---------------------------------------------------------------------------
export const renderFrameTimelineChart = (host, { visual, audio = null, activeView = 'both' } = {}) => {
  const visualSamples = visual?.samples;
  const audioSamples = audio?.samples;
  if (!visualSamples?.intervals?.length && !audioSamples?.intervals?.length) {
    host.replaceChildren(makeEl('div', 'chart-empty', 'Per-frame timeline data is captured during live runs in this session.'));
    return;
  }

  const showVisual = activeView === 'both' || activeView === 'visual' || !audioSamples?.intervals?.length;
  const showAudio = Boolean(audioSamples?.intervals?.length) && (activeView === 'both' || activeView === 'audio');

  const height = 240;
  const { canvas, ctx, tooltip, width } = setupCanvas(host, height);
  const pad = { top: 18, right: 18, bottom: 28, left: 54 };
  const plotW = Math.max(80, width - pad.left - pad.right);
  const plotH = Math.max(80, height - pad.top - pad.bottom);

  const series = [];
  if (showVisual && visualSamples?.intervals?.length) {
    series.push({
      key: 'visual',
      label: 'Visual',
      color: COLORS.visual,
      workColor: COLORS.visualWork,
      times: visualSamples.times,
      intervals: visualSamples.intervals,
      workTimes: visualSamples.workTimes,
      nominal: visual.intervalP50 || 16.67,
      elapsedMs: visual.elapsedMs || 1,
    });
  }
  if (showAudio && audioSamples?.intervals?.length) {
    series.push({
      key: 'audio',
      label: 'Visual + Audio',
      color: COLORS.audio,
      workColor: COLORS.audioWork,
      times: audioSamples.times,
      intervals: audioSamples.intervals,
      workTimes: audioSamples.workTimes,
      nominal: audio.intervalP50 || 16.67,
      elapsedMs: audio.elapsedMs || 1,
    });
  }

  let maxTimeMs = 1000;
  let maxMs = 20;
  for (const s of series) {
    if (s.elapsedMs > maxTimeMs) maxTimeMs = s.elapsedMs;
    const p99Cap = Math.max(20, (s.key === 'visual' ? visual.intervalP99 : audio.intervalP99) * 1.45);
    for (const v of s.intervals) {
      if (v > maxMs) maxMs = Math.min(v, Math.max(p99Cap, 40));
    }
    for (const v of s.workTimes) {
      if (v > maxMs) maxMs = Math.min(v, Math.max(p99Cap, 40));
    }
  }
  const yMax = niceMax(Math.max(maxMs * 1.08, 18));

  const xForTime = (ms) => pad.left + (Math.min(ms, maxTimeMs) / maxTimeMs) * plotW;
  const yForMs = (ms) => pad.top + plotH * (1 - Math.min(ms, yMax) / yMax);

  const drawChart = (hoverX = null) => {
    ctx.clearRect(0, 0, width, height);
    drawHorizontalGrid(ctx, pad, plotW, plotH, yMax, { ticks: 4, unit: 'ms', decimals: 1 });

    // Budget reference lines
    const budgets = [
      { ms: 8.33, label: '120 FPS (8.3ms)', color: COLORS.budget120 },
      { ms: 16.67, label: '60 FPS (16.7ms)', color: COLORS.budget60 },
      { ms: 33.33, label: '30 FPS (33.3ms)', color: COLORS.budget30 },
    ];
    for (const b of budgets) {
      if (b.ms >= yMax * 0.96) continue;
      const y = Math.round(yForMs(b.ms)) + 0.5;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.restore();

      ctx.font = `10px ${FONT_MONO}`;
      ctx.fillStyle = b.color;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(b.label, pad.left + plotW - 4, y - 2);
    }

    // X-axis labels
    ctx.font = `11px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = 5;
    for (let i = 0; i <= xTicks; i += 1) {
      const t = (maxTimeMs * i) / xTicks;
      const x = xForTime(t);
      ctx.fillText(`${(t / 1000).toFixed(1)}s`, x, pad.top + plotH + 8);
    }

    // Plot series
    for (const s of series) {
      const n = s.intervals.length;
      if (n === 0) continue;

      // JS Work filled area (subtle)
      ctx.beginPath();
      const firstX = xForTime(s.times[0] || 0);
      ctx.moveTo(firstX, pad.top + plotH);
      for (let i = 0; i < n; i += 1) {
        const x = xForTime(s.times[i] ?? (i / n) * s.elapsedMs);
        const y = yForMs(s.workTimes[i] || 0);
        ctx.lineTo(x, y);
      }
      const lastX = xForTime(s.times[n - 1] ?? s.elapsedMs);
      ctx.lineTo(lastX, pad.top + plotH);
      ctx.closePath();
      ctx.fillStyle = s.key === 'visual' ? 'rgba(89, 200, 240, 0.12)' : 'rgba(59, 207, 128, 0.12)';
      ctx.fill();

      // JS Work stroke
      ctx.beginPath();
      for (let i = 0; i < n; i += 1) {
        const x = xForTime(s.times[i] ?? (i / n) * s.elapsedMs);
        const y = yForMs(s.workTimes[i] || 0);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = s.workColor;
      ctx.lineWidth = 1.25;
      ctx.stroke();

      // Frame Interval stroke
      ctx.beginPath();
      for (let i = 0; i < n; i += 1) {
        const x = xForTime(s.times[i] ?? (i / n) * s.elapsedMs);
        const y = yForMs(s.intervals[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.7;
      ctx.stroke();

      // Dropped frame markers
      const dropThreshold = s.nominal * 1.5;
      ctx.fillStyle = COLORS.dropped;
      for (let i = 0; i < n; i += 1) {
        if (s.intervals[i] > dropThreshold) {
          const x = xForTime(s.times[i] ?? (i / n) * s.elapsedMs);
          const y = yForMs(s.intervals[i]);
          ctx.beginPath();
          ctx.arc(x, y, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Hover crosshair
    if (hoverX != null && hoverX >= pad.left && hoverX <= pad.left + plotW) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hoverX, pad.top);
      ctx.lineTo(hoverX, pad.top + plotH);
      ctx.stroke();
      ctx.restore();
    }
  };

  drawChart(null);

  const findNearestIndex = (times, targetMs) => {
    let low = 0;
    let high = times.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (times[mid] < targetMs) low = mid + 1;
      else high = mid;
    }
    if (low > 0 && Math.abs(times[low - 1] - targetMs) < Math.abs(times[low] - targetMs)) {
      return low - 1;
    }
    return low;
  };

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < pad.left || x > pad.left + plotW || y < pad.top || y > pad.top + plotH) {
      drawChart(null);
      hideTooltip(tooltip);
      return;
    }
    const targetMs = ((x - pad.left) / plotW) * maxTimeMs;
    drawChart(x);

    const lines = [`t = ${(targetMs / 1000).toFixed(2)}s`];
    for (const s of series) {
      if (!s.times.length) continue;
      const idx = findNearestIndex(s.times, targetMs);
      const interval = s.intervals[idx];
      const work = s.workTimes[idx] ?? 0;
      const instantFps = interval > 0 ? (1000 / interval).toFixed(0) : '—';
      const droppedTag = interval > s.nominal * 1.5 ? ' [DROP]' : '';
      lines.push(`${s.label} #${idx + 1}: ${interval.toFixed(2)}ms (${instantFps} fps) · JS ${work.toFixed(2)}ms${droppedTag}`);
    }
    positionTooltip(tooltip, host, x, y, lines);
  });

  canvas.addEventListener('pointerleave', () => {
    drawChart(null);
    hideTooltip(tooltip);
  });
};

// ---------------------------------------------------------------------------
// 2. Frame-Time / JS Work Distribution Histogram
// ---------------------------------------------------------------------------
export const renderDistributionHistogram = (host, { visual, audio = null, metric = 'intervals' } = {}) => {
  const visArr = visual?.samples?.[metric] || [];
  const audArr = audio?.samples?.[metric] || [];
  if (visArr.length === 0 && audArr.length === 0) {
    host.replaceChildren(makeEl('div', 'chart-empty', 'Distribution histogram is available for live runs in this session.'));
    return;
  }

  const height = 220;
  const { canvas, ctx, tooltip, width } = setupCanvas(host, height);
  const pad = { top: 24, right: 16, bottom: 28, left: 48 };
  const plotW = Math.max(80, width - pad.left - pad.right);
  const plotH = Math.max(80, height - pad.top - pad.bottom);

  const p99Ref = Math.max(
    metric === 'intervals' ? (visual?.intervalP99 || 0) : (visual?.workP99 || 0),
    metric === 'intervals' ? (audio?.intervalP99 || 0) : (audio?.workP99 || 0),
    metric === 'intervals' ? 20 : 2,
  );
  const capMax = niceMax(p99Ref * 1.25);
  const binCount = 24;
  const binSize = capMax / binCount;

  const buildBins = (values) => {
    const counts = new Array(binCount).fill(0);
    for (const v of values) {
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor(v / binSize)));
      counts[idx] += 1;
    }
    return counts;
  };

  const visBins = buildBins(visArr);
  const audBins = audArr.length > 0 ? buildBins(audArr) : null;
  const maxPct = Math.max(
    1,
    ...visBins.map((c) => (visArr.length ? (c * 100) / visArr.length : 0)),
    ...(audBins ? audBins.map((c) => (audArr.length ? (c * 100) / audArr.length : 0)) : [0]),
  );
  const yMax = niceMax(maxPct * 1.1);

  const markersSource = audio || visual;
  const markers = metric === 'intervals'
    ? [
      { label: 'p50', val: markersSource.intervalP50, color: COLORS.p50 },
      { label: 'p95', val: markersSource.intervalP95, color: COLORS.p95 },
      { label: 'p99', val: markersSource.intervalP99, color: COLORS.p99 },
    ]
    : [
      { label: 'p50', val: markersSource.workP50, color: COLORS.p50 },
      { label: 'p95', val: markersSource.workP95, color: COLORS.p95 },
      { label: 'p99', val: markersSource.workP99, color: COLORS.p99 },
    ];

  const drawChart = (hoverBin = -1) => {
    ctx.clearRect(0, 0, width, height);
    drawHorizontalGrid(ctx, pad, plotW, plotH, yMax, { ticks: 4, unit: '%', decimals: 0 });

    const groupW = plotW / binCount;
    for (let i = 0; i < binCount; i += 1) {
      const x0 = pad.left + i * groupW;
      if (i === hoverBin) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.fillRect(x0, pad.top, groupW, plotH);
      }

      const visPct = visArr.length ? (visBins[i] * 100) / visArr.length : 0;
      const audPct = audBins && audArr.length ? (audBins[i] * 100) / audArr.length : 0;

      if (audBins) {
        const barW = Math.max(2, (groupW - 3) / 2);
        const visH = (visPct / yMax) * plotH;
        const audH = (audPct / yMax) * plotH;
        ctx.fillStyle = COLORS.visual;
        ctx.fillRect(x0 + 1, pad.top + plotH - visH, barW, visH);
        ctx.fillStyle = COLORS.audio;
        ctx.fillRect(x0 + 1 + barW + 1, pad.top + plotH - audH, barW, audH);
      } else {
        const barW = Math.max(3, groupW - 3);
        const visH = (visPct / yMax) * plotH;
        ctx.fillStyle = COLORS.visual;
        ctx.fillRect(x0 + 1.5, pad.top + plotH - visH, barW, visH);
      }
    }

    // X-axis ticks
    ctx.font = `11px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i += 1) {
      const val = (capMax * i) / 4;
      const x = pad.left + (plotW * i) / 4;
      const label = i === 4 ? `${val.toFixed(1)}+ms` : `${val.toFixed(1)}ms`;
      ctx.fillText(label, x, pad.top + plotH + 8);
    }

    // Percentile markers
    let lastLabelX = -100;
    for (const marker of markers) {
      if (!Number.isFinite(marker.val)) continue;
      const ratio = Math.min(1, Math.max(0, marker.val / capMax));
      const x = pad.left + ratio * plotW;
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = marker.color;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + plotH);
      ctx.stroke();
      ctx.restore();

      const labelX = Math.max(lastLabelX + 34, Math.min(pad.left + plotW - 14, x));
      lastLabelX = labelX;
      ctx.font = `10px ${FONT_MONO}`;
      ctx.fillStyle = marker.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(marker.label, labelX, pad.top - 5);
    }
  };

  drawChart(-1);

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < pad.left || x > pad.left + plotW || y < pad.top || y > pad.top + plotH) {
      drawChart(-1);
      hideTooltip(tooltip);
      return;
    }
    const binIdx = Math.min(binCount - 1, Math.max(0, Math.floor(((x - pad.left) / plotW) * binCount)));
    drawChart(binIdx);
    const lo = binIdx * binSize;
    const hi = (binIdx + 1) * binSize;
    const rangeLabel = binIdx === binCount - 1
      ? `≥ ${lo.toFixed(2)} ms`
      : `${lo.toFixed(2)} – ${hi.toFixed(2)} ms`;
    const lines = [rangeLabel];
    if (visArr.length) {
      const pct = ((visBins[binIdx] * 100) / visArr.length).toFixed(1);
      lines.push(`Visual: ${visBins[binIdx]} frames (${pct}%)`);
    }
    if (audBins && audArr.length) {
      const pct = ((audBins[binIdx] * 100) / audArr.length).toFixed(1);
      lines.push(`Audio:  ${audBins[binIdx]} frames (${pct}%)`);
    }
    positionTooltip(tooltip, host, x, y, lines);
  });

  canvas.addEventListener('pointerleave', () => {
    drawChart(-1);
    hideTooltip(tooltip);
  });
};

// ---------------------------------------------------------------------------
// 3. Percentile Breakdown Horizontal Bar Chart (Visual vs Audio vs Baseline)
// ---------------------------------------------------------------------------
export const renderPercentileComparisonChart = (host, { current, baseline = null } = {}) => {
  if (!current?.visual) {
    host.replaceChildren(makeEl('div', 'chart-empty', 'Run a benchmark to see percentile breakdowns.'));
    return;
  }

  const rows = [
    { label: 'Frame p50', key: 'intervalP50' },
    { label: 'Frame p95', key: 'intervalP95' },
    { label: 'Frame p99', key: 'intervalP99' },
    { label: 'JS Work p50', key: 'workP50' },
    { label: 'JS Work p95', key: 'workP95' },
    { label: 'JS Work p99', key: 'workP99' },
  ];

  const seriesDefs = [
    { label: 'Visual', color: COLORS.visual, read: (key) => current.visual[key] },
  ];
  if (current.audio) {
    seriesDefs.push({ label: 'Visual + Audio', color: COLORS.audio, read: (key) => current.audio[key] });
  }
  const basePass = baseline?.audio || baseline?.visual;
  if (basePass) {
    seriesDefs.push({ label: 'Comparison', color: COLORS.baseline, read: (key) => basePass[key] });
  }

  let rawMax = 1;
  for (const row of rows) {
    for (const s of seriesDefs) {
      const v = s.read(row.key);
      if (Number.isFinite(v) && v > rawMax) rawMax = v;
    }
  }
  const xMax = niceMax(rawMax * 1.12);

  const rowHeight = seriesDefs.length * 11 + 16;
  const pad = { top: 14, right: 56, bottom: 24, left: 92 };
  const height = pad.top + pad.bottom + rows.length * rowHeight;
  const { ctx, width } = setupCanvas(host, height);
  const plotW = Math.max(80, width - pad.left - pad.right);

  // Vertical grid lines
  ctx.font = `10px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 4; i += 1) {
    const val = (xMax * i) / 4;
    const x = Math.round(pad.left + (plotW * i) / 4) + 0.5;
    ctx.strokeStyle = i === 0 ? COLORS.axis : COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, height - pad.bottom);
    ctx.stroke();

    ctx.fillStyle = COLORS.text;
    ctx.fillText(`${val.toFixed(1)}ms`, x, height - pad.bottom + 6);
  }

  rows.forEach((row, rowIndex) => {
    const yStart = pad.top + rowIndex * rowHeight + 4;
    ctx.font = `11px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.textStrong;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(row.label, pad.left - 10, yStart + (seriesDefs.length * 10) / 2);

    seriesDefs.forEach((s, sIdx) => {
      const val = s.read(row.key);
      if (!Number.isFinite(val)) return;
      const barY = yStart + sIdx * 11;
      const barW = Math.max(2, (val / xMax) * plotW);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.roundRect(pad.left, barY, barW, 8, 3);
      ctx.fill();

      ctx.font = `10px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${val.toFixed(2)}ms`, pad.left + barW + 6, barY + 4);
    });
  });
};

// ---------------------------------------------------------------------------
// 4. Suite Cross-Scenario Comparison Chart
// ---------------------------------------------------------------------------
export const renderSuiteComparisonChart = (host, suiteResults) => {
  if (!suiteResults || suiteResults.length === 0) {
    host.replaceChildren();
    return;
  }

  const height = 185;
  const { ctx, width } = setupCanvas(host, height);
  const pad = { top: 20, right: 20, bottom: 32, left: 54 };
  const plotW = Math.max(120, width - pad.left - pad.right);
  const plotH = Math.max(80, height - pad.top - pad.bottom);

  let maxFps = 60;
  for (const item of suiteResults) {
    if (item.visual?.fps > maxFps) maxFps = item.visual.fps;
    if (item.audio?.fps > maxFps) maxFps = item.audio.fps;
  }
  const yMax = niceMax(maxFps * 1.15);

  drawHorizontalGrid(ctx, pad, plotW, plotH, yMax, { ticks: 4, unit: ' fps', decimals: 0 });

  const groupW = plotW / suiteResults.length;
  suiteResults.forEach((item, index) => {
    const centerX = pad.left + groupW * (index + 0.5);
    const hasAudio = Boolean(item.audio);
    const barW = Math.min(44, (groupW - 28) / (hasAudio ? 2 : 1));

    const drawBar = (x, fps, color) => {
      const h = (fps / yMax) * plotH;
      const y = pad.top + plotH - h;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, h, [5, 5, 0, 0]);
      ctx.fill();

      ctx.font = `11px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.textStrong;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fps.toFixed(1), x + barW / 2, y - 4);
    };

    if (hasAudio) {
      drawBar(centerX - barW - 3, item.visual.fps, COLORS.visual);
      drawBar(centerX + 3, item.audio.fps, COLORS.audio);
    } else {
      drawBar(centerX - barW / 2, item.visual.fps, COLORS.visual);
    }

    ctx.font = `11px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(item.benchmark.scenario, centerX, pad.top + plotH + 10);
  });
};

// ---------------------------------------------------------------------------
// 5. Historical Trend Chart (Browser runs from results.jsonl)
// ---------------------------------------------------------------------------
export const renderHistoryTrendChart = (host, runs, { metric = 'fps' } = {}) => {
  if (!runs || runs.length === 0) {
    host.replaceChildren(makeEl('div', 'chart-empty', 'No saved browser benchmark runs match the current filter.'));
    return;
  }

  const metricMeta = {
    fps: { unit: ' fps', decimals: 1, lowerIsBetter: false, split: true },
    intervalP95: { unit: ' ms', decimals: 1, lowerIsBetter: true, split: true },
    workP95: { unit: ' ms', decimals: 2, lowerIsBetter: true, split: true },
    droppedPercent: { unit: '%', decimals: 1, lowerIsBetter: true, split: true },
    setupMs: { unit: ' ms', decimals: 0, lowerIsBetter: true, split: false },
  }[metric] || { unit: '', decimals: 1, lowerIsBetter: false, split: true };

  const height = 240;
  const { canvas, ctx, tooltip, width } = setupCanvas(host, height);
  const pad = { top: 20, right: 24, bottom: 38, left: 60 };
  const plotW = Math.max(100, width - pad.left - pad.right);
  const plotH = Math.max(80, height - pad.top - pad.bottom);

  const visualVals = runs.map((run) => (metricMeta.split ? run.visual?.[metric] : run.setupMs));
  const audioVals = metricMeta.split ? runs.map((run) => run.audio?.[metric]) : [];
  const allVals = [...visualVals, ...audioVals].filter((v) => Number.isFinite(v));
  const yMax = niceMax(Math.max(...allVals, 1) * 1.15);

  const xForIndex = (idx) => (
    runs.length === 1
      ? pad.left + plotW / 2
      : pad.left + (idx / (runs.length - 1)) * plotW
  );
  const yForVal = (val) => pad.top + plotH * (1 - Math.max(0, val) / yMax);

  const drawSeries = (values, color) => {
    ctx.beginPath();
    let started = false;
    values.forEach((val, idx) => {
      if (!Number.isFinite(val)) return;
      const x = xForIndex(idx);
      const y = yForVal(val);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    values.forEach((val, idx) => {
      if (!Number.isFinite(val)) return;
      const x = xForIndex(idx);
      const y = yForVal(val);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#141318';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  };

  const drawChart = (hoverIdx = -1) => {
    ctx.clearRect(0, 0, width, height);
    drawHorizontalGrid(ctx, pad, plotW, plotH, yMax, {
      ticks: 4,
      unit: metricMeta.unit,
      decimals: metricMeta.decimals === 2 ? 1 : metricMeta.decimals,
    });

    if (hoverIdx >= 0 && hoverIdx < runs.length) {
      const hx = xForIndex(hoverIdx);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.beginPath();
      ctx.moveTo(hx, pad.top);
      ctx.lineTo(hx, pad.top + plotH);
      ctx.stroke();
      ctx.restore();
    }

    drawSeries(visualVals, COLORS.visual);
    if (metricMeta.split) {
      drawSeries(audioVals, COLORS.audio);
    }

    // X-axis labels (up to 6 evenly spaced)
    ctx.font = `10px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const maxLabels = Math.min(runs.length, 6);
    const step = maxLabels <= 1 ? 1 : (runs.length - 1) / (maxLabels - 1);
    const drawn = new Set();
    for (let i = 0; i < maxLabels; i += 1) {
      const idx = Math.round(i * step);
      if (drawn.has(idx)) continue;
      drawn.add(idx);
      const run = runs[idx];
      const x = xForIndex(idx);
      const sha = run.build?.gitCommit ? run.build.gitCommit.slice(0, 7) : '—';
      ctx.fillText(formatShortDate(run.recordedAt), x, pad.top + plotH + 7);
      ctx.fillStyle = '#76708a';
      ctx.fillText(sha, x, pad.top + plotH + 20);
      ctx.fillStyle = COLORS.text;
    }
  };

  drawChart(-1);

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < pad.left - 12 || x > pad.left + plotW + 12 || y < pad.top || y > pad.top + plotH) {
      drawChart(-1);
      hideTooltip(tooltip);
      return;
    }
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < runs.length; i += 1) {
      const dist = Math.abs(xForIndex(i) - x);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    drawChart(bestIdx);
    const run = runs[bestIdx];
    const sha = run.build?.gitCommit
      ? `${run.build.gitCommit.slice(0, 7)}${run.build.workingTreeClean === false ? '*' : ''}`
      : 'unknown';
    const power = run.device?.power;
    const lines = [
      `${formatDateTime(run.recordedAt)} · ${sha}`,
      `Scenario: ${run.benchmark?.scenario || '—'} (${run.build?.gitBranch || '—'})`,
    ];
    if (power?.efficiencyMode) {
      lines.push(`Power: Efficiency${Number.isFinite(power.rafHz) ? ` (~${power.rafHz}Hz)` : ''}`);
    }
    if (metricMeta.split) {
      if (Number.isFinite(visualVals[bestIdx])) {
        lines.push(`Visual: ${visualVals[bestIdx].toFixed(metricMeta.decimals)}${metricMeta.unit}`);
      }
      if (Number.isFinite(audioVals[bestIdx])) {
        lines.push(`Audio:  ${audioVals[bestIdx].toFixed(metricMeta.decimals)}${metricMeta.unit}`);
      }
    } else if (Number.isFinite(visualVals[bestIdx])) {
      lines.push(`Setup: ${visualVals[bestIdx].toFixed(metricMeta.decimals)}${metricMeta.unit}`);
    }
    positionTooltip(tooltip, host, xForIndex(bestIdx), y, lines);
  });

  canvas.addEventListener('pointerleave', () => {
    drawChart(-1);
    hideTooltip(tooltip);
  });
};

// ---------------------------------------------------------------------------
// 6. Microbenchmark Speedup Trend Chart
// ---------------------------------------------------------------------------
export const renderMicroTrendChart = (host, runs) => {
  if (!runs || runs.length === 0) {
    host.replaceChildren(makeEl('div', 'chart-empty', 'No saved Node microbenchmark runs yet. Click "Run Microbenchmarks" above to record one.'));
    return;
  }

  const height = 220;
  const { canvas, ctx, tooltip, width } = setupCanvas(host, height);
  const pad = { top: 20, right: 24, bottom: 38, left: 56 };
  const plotW = Math.max(100, width - pad.left - pad.right);
  const plotH = Math.max(80, height - pad.top - pad.bottom);

  const overall = runs.map((r) => r.overallSpeedup);
  const timing = runs.map((r) => r.benchmarks?.[0]?.speedup);
  const timeline = runs.map((r) => r.benchmarks?.[1]?.speedup);
  const allVals = [...overall, ...timing, ...timeline].filter((v) => Number.isFinite(v));
  const yMax = niceMax(Math.max(...allVals, 2) * 1.12);

  const xForIndex = (idx) => (
    runs.length === 1
      ? pad.left + plotW / 2
      : pad.left + (idx / (runs.length - 1)) * plotW
  );
  const yForVal = (val) => pad.top + plotH * (1 - Math.max(0, val) / yMax);

  const drawLine = (values, color, lineWidth = 2) => {
    ctx.beginPath();
    let started = false;
    values.forEach((v, idx) => {
      if (!Number.isFinite(v)) return;
      const x = xForIndex(idx);
      const y = yForVal(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    values.forEach((v, idx) => {
      if (!Number.isFinite(v)) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(xForIndex(idx), yForVal(v), 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  const drawChart = (hoverIdx = -1) => {
    ctx.clearRect(0, 0, width, height);
    drawHorizontalGrid(ctx, pad, plotW, plotH, yMax, { ticks: 4, unit: '×', decimals: 0 });

    if (hoverIdx >= 0 && hoverIdx < runs.length) {
      const hx = xForIndex(hoverIdx);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.beginPath();
      ctx.moveTo(hx, pad.top);
      ctx.lineTo(hx, pad.top + plotH);
      ctx.stroke();
      ctx.restore();
    }

    drawLine(timing, COLORS.audioWork, 1.5);
    drawLine(timeline, COLORS.audio, 1.5);
    drawLine(overall, COLORS.visual, 2.4);

    ctx.font = `10px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const maxLabels = Math.min(runs.length, 6);
    const step = maxLabels <= 1 ? 1 : (runs.length - 1) / (maxLabels - 1);
    const drawn = new Set();
    for (let i = 0; i < maxLabels; i += 1) {
      const idx = Math.round(i * step);
      if (drawn.has(idx)) continue;
      drawn.add(idx);
      const run = runs[idx];
      const x = xForIndex(idx);
      const sha = run.build?.gitCommit ? run.build.gitCommit.slice(0, 7) : '—';
      ctx.fillText(formatShortDate(run.recordedAt), x, pad.top + plotH + 7);
      ctx.fillStyle = '#76708a';
      ctx.fillText(sha, x, pad.top + plotH + 20);
      ctx.fillStyle = COLORS.text;
    }
  };

  drawChart(-1);

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < pad.left - 12 || x > pad.left + plotW + 12 || y < pad.top || y > pad.top + plotH) {
      drawChart(-1);
      hideTooltip(tooltip);
      return;
    }
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < runs.length; i += 1) {
      const dist = Math.abs(xForIndex(i) - x);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    drawChart(bestIdx);
    const run = runs[bestIdx];
    const sha = run.build?.gitCommit ? run.build.gitCommit.slice(0, 7) : '—';
    const lines = [
      `${formatDateTime(run.recordedAt)} · ${sha} (${run.passed ? 'PASS' : 'FAIL'})`,
      `Overall: ${run.overallSpeedup?.toFixed(2) ?? '—'}×`,
    ];
    for (const b of (run.benchmarks || [])) {
      const shortName = b.name.split('(')[0].trim();
      lines.push(`${shortName}: ${b.optimizedMs.toFixed(3)}ms (${b.speedup.toFixed(1)}×)`);
    }
    positionTooltip(tooltip, host, xForIndex(bestIdx), y, lines);
  });

  canvas.addEventListener('pointerleave', () => {
    drawChart(-1);
    hideTooltip(tooltip);
  });
};

// ---------------------------------------------------------------------------
// 7. Popup Startup Phase Waterfall (Stacked Horizontal Bars)
// ---------------------------------------------------------------------------
const STARTUP_PHASES = [
  { key: 'domCssMs', label: 'DOM + CSS', color: '#59c8f0' },
  { key: 'jsBootMs', label: 'JS Boot', color: '#8c66ff' },
  { key: 'revealMs', label: 'Reveal', color: '#c48bff' },
  { key: 'parseRenderMs', label: 'Parse + Render', color: '#efc45f' },
  { key: 'paintMs', label: 'Paint', color: '#3bcf80' },
];

export const renderStartupWaterfallChart = (host, { iterations = [], summary = null } = {}) => {
  if (!summary && iterations.length === 0) {
    host.replaceChildren(makeEl('div', 'chart-empty', 'Run an open benchmark to see the startup waterfall.'));
    return;
  }

  const rows = [];
  if (summary) {
    rows.push({ label: 'Median', totalMs: summary.totalMedianMs, phases: summary.phases, highlight: true });
  }
  iterations.forEach((iter, idx) => {
    rows.push({ label: `Run #${idx + 1}`, totalMs: iter.totalMs, phases: iter.phases, highlight: false });
  });

  const maxTotal = Math.max(
    ...rows.map((r) => {
      const sum = STARTUP_PHASES.reduce((acc, p) => acc + (r.phases?.[p.key] || 0), 0);
      return Math.max(r.totalMs || 0, sum);
    }),
    10,
  );
  const xMax = niceMax(maxTotal * 1.12);

  const rowH = 26;
  const pad = { top: 14, right: 64, bottom: 26, left: 68 };
  const height = Math.max(120, pad.top + pad.bottom + rows.length * rowH);
  const { canvas, ctx, tooltip, width } = setupCanvas(host, height);
  const plotW = Math.max(100, width - pad.left - pad.right);

  const drawChart = (hoverRow = -1) => {
    ctx.clearRect(0, 0, width, height);

    ctx.font = `10px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i += 1) {
      const val = (xMax * i) / 4;
      const x = Math.round(pad.left + (plotW * i) / 4) + 0.5;
      ctx.strokeStyle = i === 0 ? COLORS.axis : COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, height - pad.bottom);
      ctx.stroke();

      ctx.fillStyle = COLORS.text;
      ctx.fillText(`${val.toFixed(0)}ms`, x, height - pad.bottom + 7);
    }

    rows.forEach((row, rIdx) => {
      const y = pad.top + rIdx * rowH;
      if (rIdx === hoverRow) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.fillRect(pad.left, y + 1, plotW, rowH - 2);
      }

      ctx.font = `${row.highlight ? '700 ' : ''}11px ${FONT_MONO}`;
      ctx.fillStyle = row.highlight ? COLORS.textStrong : COLORS.text;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(row.label, pad.left - 10, y + rowH / 2);

      let cursorX = pad.left;
      const barY = y + 5;
      const barH = rowH - 10;
      for (const phase of STARTUP_PHASES) {
        const val = Math.max(0, row.phases?.[phase.key] || 0);
        if (val <= 0) continue;
        const w = (val / xMax) * plotW;
        ctx.fillStyle = phase.color;
        ctx.fillRect(cursorX, barY, Math.max(1.5, w), barH);
        cursorX += w;
      }

      ctx.font = `10.5px ${FONT_MONO}`;
      ctx.fillStyle = row.highlight ? COLORS.textStrong : COLORS.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${row.totalMs.toFixed(1)}ms`, cursorX + 7, y + rowH / 2);
    });
  };

  drawChart(-1);

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (y < pad.top || y > height - pad.bottom || x < pad.left || x > pad.left + plotW) {
      drawChart(-1);
      hideTooltip(tooltip);
      return;
    }
    const rIdx = Math.min(rows.length - 1, Math.max(0, Math.floor((y - pad.top) / rowH)));
    drawChart(rIdx);
    const row = rows[rIdx];
    const total = Math.max(row.totalMs, 0.01);
    const lines = [`${row.label} · ${row.totalMs.toFixed(1)} ms`];
    for (const phase of STARTUP_PHASES) {
      const val = row.phases?.[phase.key] || 0;
      const pct = ((val / total) * 100).toFixed(0);
      lines.push(`${phase.label}: ${val.toFixed(1)} ms (${pct}%)`);
    }
    positionTooltip(tooltip, host, x, y, lines);
  });

  canvas.addEventListener('pointerleave', () => {
    drawChart(-1);
    hideTooltip(tooltip);
  });
};

// ---------------------------------------------------------------------------
// 8. Subsystem Horizontal Timing Bars (Parse / Convert / Render / Audio)
// ---------------------------------------------------------------------------
const CATEGORY_COLORS = {
  parse: '#59c8f0',
  convert: '#8c66ff',
  render: '#3bcf80',
  audio: '#efc45f',
};

export const renderSubsystemBarsChart = (host, operations = []) => {
  if (!operations || operations.length === 0) {
    host.replaceChildren(makeEl('div', 'chart-empty', 'No subsystem timings recorded yet.'));
    return;
  }

  const xMax = niceMax(Math.max(...operations.map((op) => op.p95Ms || op.medianMs || 0), 1) * 1.15);
  const rowH = 28;
  const pad = { top: 12, right: 78, bottom: 24, left: 178 };
  const height = pad.top + pad.bottom + operations.length * rowH;
  const { canvas, ctx, tooltip, width } = setupCanvas(host, height);
  const plotW = Math.max(80, width - pad.left - pad.right);

  const drawChart = (hoverIdx = -1) => {
    ctx.clearRect(0, 0, width, height);

    ctx.font = `10px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i += 1) {
      const val = (xMax * i) / 4;
      const x = Math.round(pad.left + (plotW * i) / 4) + 0.5;
      ctx.strokeStyle = i === 0 ? COLORS.axis : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, height - pad.bottom);
      ctx.stroke();

      ctx.fillStyle = COLORS.text;
      ctx.fillText(`${val.toFixed(1)}ms`, x, height - pad.bottom + 6);
    }

    operations.forEach((op, idx) => {
      const y = pad.top + idx * rowH;
      if (idx === hoverIdx) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.fillRect(pad.left, y + 1, plotW, rowH - 2);
      }

      ctx.font = `11px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.textStrong;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(op.name, pad.left - 10, y + rowH / 2);

      const color = CATEGORY_COLORS[op.category] || COLORS.visual;
      const medW = Math.max(2, ((op.medianMs || 0) / xMax) * plotW);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(pad.left, y + 7, medW, rowH - 14, 4);
      ctx.fill();

      // p95 whisker tick if available
      if (Number.isFinite(op.p95Ms) && op.p95Ms > op.medianMs) {
        const p95X = pad.left + Math.min(1, op.p95Ms / xMax) * plotW;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(pad.left + medW, y + rowH / 2);
        ctx.lineTo(p95X, y + rowH / 2);
        ctx.moveTo(p95X, y + 8);
        ctx.lineTo(p95X, y + rowH - 8);
        ctx.stroke();
      }

      ctx.font = `10.5px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${op.medianMs.toFixed(2)}ms`, pad.left + Math.max(medW, ((op.p95Ms || op.medianMs) / xMax) * plotW) + 8, y + rowH / 2);
    });
  };

  drawChart(-1);

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (y < pad.top || y > height - pad.bottom || x < pad.left || x > pad.left + plotW) {
      drawChart(-1);
      hideTooltip(tooltip);
      return;
    }
    const idx = Math.min(operations.length - 1, Math.max(0, Math.floor((y - pad.top) / rowH)));
    drawChart(idx);
    const op = operations[idx];
    const lines = [
      op.name,
      `Median: ${op.medianMs.toFixed(2)} ms`,
    ];
    if (Number.isFinite(op.p95Ms)) lines.push(`p95:    ${op.p95Ms.toFixed(2)} ms`);
    positionTooltip(tooltip, host, x, y, lines);
  });

  canvas.addEventListener('pointerleave', () => {
    drawChart(-1);
    hideTooltip(tooltip);
  });
};

// ---------------------------------------------------------------------------
// 9. Startup History Trend Chart
// ---------------------------------------------------------------------------
export const renderStartupHistoryTrendChart = (host, runs = []) => {
  if (!runs || runs.length === 0) {
    host.replaceChildren(makeEl('div', 'chart-empty', 'No saved Open & Load runs match this filter.'));
    return;
  }

  const height = 220;
  const { canvas, ctx, tooltip, width } = setupCanvas(host, height);
  const pad = { top: 20, right: 24, bottom: 38, left: 56 };
  const plotW = Math.max(100, width - pad.left - pad.right);
  const plotH = Math.max(80, height - pad.top - pad.bottom);

  const medians = runs.map((r) => r.summary?.totalMedianMs);
  const p95s = runs.map((r) => r.summary?.totalP95Ms);
  const allVals = [...medians, ...p95s].filter((v) => Number.isFinite(v));
  const yMax = niceMax(Math.max(...allVals, 10) * 1.15);

  const xForIndex = (idx) => (
    runs.length === 1 ? pad.left + plotW / 2 : pad.left + (idx / (runs.length - 1)) * plotW
  );
  const yForVal = (val) => pad.top + plotH * (1 - Math.max(0, val) / yMax);

  const drawLine = (values, color) => {
    ctx.beginPath();
    let started = false;
    values.forEach((val, idx) => {
      if (!Number.isFinite(val)) return;
      const x = xForIndex(idx);
      const y = yForVal(val);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    values.forEach((val, idx) => {
      if (!Number.isFinite(val)) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(xForIndex(idx), yForVal(val), 3.8, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  const drawChart = (hoverIdx = -1) => {
    ctx.clearRect(0, 0, width, height);
    drawHorizontalGrid(ctx, pad, plotW, plotH, yMax, { ticks: 4, unit: 'ms', decimals: 0 });
    if (hoverIdx >= 0 && hoverIdx < runs.length) {
      const hx = xForIndex(hoverIdx);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.beginPath();
      ctx.moveTo(hx, pad.top);
      ctx.lineTo(hx, pad.top + plotH);
      ctx.stroke();
      ctx.restore();
    }
    drawLine(p95s, COLORS.audio);
    drawLine(medians, COLORS.visual);

    ctx.font = `10px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const maxLabels = Math.min(runs.length, 6);
    const step = maxLabels <= 1 ? 1 : (runs.length - 1) / (maxLabels - 1);
    const drawn = new Set();
    for (let i = 0; i < maxLabels; i += 1) {
      const idx = Math.round(i * step);
      if (drawn.has(idx)) continue;
      drawn.add(idx);
      const run = runs[idx];
      const x = xForIndex(idx);
      const sha = run.build?.gitCommit ? run.build.gitCommit.slice(0, 7) : '—';
      ctx.fillText(formatShortDate(run.recordedAt), x, pad.top + plotH + 7);
      ctx.fillStyle = '#76708a';
      ctx.fillText(sha, x, pad.top + plotH + 20);
      ctx.fillStyle = COLORS.text;
    }
  };

  drawChart(-1);

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < pad.left - 12 || x > pad.left + plotW + 12 || y < pad.top || y > pad.top + plotH) {
      drawChart(-1);
      hideTooltip(tooltip);
      return;
    }
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < runs.length; i += 1) {
      const dist = Math.abs(xForIndex(i) - x);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    drawChart(bestIdx);
    const run = runs[bestIdx];
    const sha = run.build?.gitCommit ? run.build.gitCommit.slice(0, 7) : '—';
    const power = run.device?.power;
    const lines = [
      `${formatDateTime(run.recordedAt)} · ${sha} (${run.mode})`,
      `Median: ${run.summary?.totalMedianMs?.toFixed(1) ?? '—'} ms`,
      `p95:    ${run.summary?.totalP95Ms?.toFixed(1) ?? '—'} ms`,
    ];
    if (power?.efficiencyMode) {
      lines.push(`Power: Efficiency${Number.isFinite(power.rafHz) ? ` (~${power.rafHz}Hz)` : ''}`);
    }
    positionTooltip(tooltip, host, xForIndex(bestIdx), y, lines);
  });

  canvas.addEventListener('pointerleave', () => {
    drawChart(-1);
    hideTooltip(tooltip);
  });
};

