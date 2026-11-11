// What the audio is doing, told to the header's island (island.js). Only what
// is going on shows: a ring while the full track is fetched, filling when its
// size is known; a tick when it has arrived, which then goes; a message when
// it could not be had. Preview audio or full audio with nothing happening is
// the usual state, not news, and shows nothing at all. The words that used to
// be on the badge are the island's tooltip, and the debug panel's.

// How long the tick stays once the full track is in.
const AUDIO_READY_SHOWN_MS = 1600;
// An explanation longer than this is told by its short label instead: a
// message has two lines at most.
const MAX_MESSAGE_CHARS = 64;

const formatAudioBadgeLabel = (label, providerLabel) => {
  if (!providerLabel) {
    return label;
  }
  return `${label} - ${providerLabel}`;
};

const formatArchiveDownloadSize = (bytes) => {
  if (!(typeof bytes === 'number') || bytes < 0) {
    return '';
  }
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? `${mb.toFixed(1)} MB` : `${mb.toFixed(2)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
};

// `fraction` is how far along the download is, 0 to 1, or null while its size
// is unknown -- the ring turns instead of filling then.
const buildArchiveProviderProgressParts = (progress) => {
  if (!progress || typeof progress.loaded !== 'number' || progress.loaded < 0) {
    return { providerSuffix: '', tooltipDownload: '', fraction: null };
  }
  const { loaded } = progress;
  const total = typeof progress.total === 'number' && progress.total > 0 ? progress.total : null;
  if (total !== null) {
    const pct = Math.min(100, Math.round((100 * loaded) / total));
    return {
      providerSuffix: ` · ${pct}%`,
      tooltipDownload: `${formatArchiveDownloadSize(loaded)} / ${formatArchiveDownloadSize(total)}`,
      fraction: Math.min(1, loaded / total),
    };
  }
  return {
    providerSuffix: ` · ${formatArchiveDownloadSize(loaded)}`,
    tooltipDownload: `${formatArchiveDownloadSize(loaded)} received`,
    fraction: null,
  };
};

// What the icon says, for its tooltip (one line each) and its accessible name.
const describeAudioBadge = (label, tooltip) => {
  const detail = String(tooltip || '').trim();
  const lines = detail && detail !== label ? [label, detail] : [label];
  return { title: lines.join('\n'), ariaLabel: lines.join('. ') };
};

// The island's activity for an audio state, or null for none. `spinning` is the
// full track being fetched while the label still says what is playing now.
const resolveAudioActivity = (audio, spinning) => {
  const title = audio ? describeAudioBadge(audio.label, audio.tooltip).title : '';
  if (audio?.stateName === 'ready') {
    return { kind: 'ready', title };
  }
  if (audio?.stateName === 'loading') {
    const known = Number.isFinite(audio.progress);
    return {
      kind: 'progress',
      progress: known ? audio.progress : null,
      text: known ? `${Math.round(Math.min(1, Math.max(0, audio.progress)) * 100)}%` : '',
      title,
    };
  }
  if (spinning && audio?.stateName !== 'failed') {
    return { kind: 'progress', progress: null, text: '', title: title || 'Loading full audio' };
  }
  return null;
};

const createAudioBadgeController = ({
  island,
  state,
  registry,
  renderDebugPanel,
  getProviderDisplayName,
  setProviderState,
}) => {
  let audio = null;
  let spinning = false;

  const sync = () => {
    island?.setActivity(resolveAudioActivity(audio, spinning));
  };

  const setFullAudioLoading = (isLoading) => {
    spinning = Boolean(isLoading);
    sync();
  };

  const setAudioBadge = (stateName, label, tooltip = '', { progress = null } = {}) => {
    state.audioBadgeHideTimer = registry.clearTimeout(state.audioBadgeHideTimer);
    const detail = String(tooltip || '').trim();
    audio = {
      stateName, label, tooltip: detail, progress,
    };

    if (stateName === 'failed') {
      // Said once, as a message; the island then goes, with the preview playing.
      island?.showMessage(label, { tone: 'error' });
    } else if (stateName === 'preview' && detail && detail !== label) {
      // Only the preview there will ever be -- worth saying once, and why.
      island?.showMessage(detail.length <= MAX_MESSAGE_CHARS ? detail : label);
    } else if (stateName === 'ready') {
      state.audioBadgeHideTimer = registry.addTimeout(setTimeout(() => {
        state.audioBadgeHideTimer = null;
        if (audio?.stateName === 'ready') {
          audio = { ...audio, stateName: 'settled' };
          sync();
        }
      }, AUDIO_READY_SHOWN_MS));
    }

    sync();
    renderDebugPanel();
  };

  // For states with nothing true to say: no map loaded, or the load failed. An
  // optimistic "Preview audio" label over silence is worse than no label at all.
  const hideAudioBadge = () => {
    state.audioBadgeHideTimer = registry.clearTimeout(state.audioBadgeHideTimer);
    audio = null;
    spinning = false;
    sync();
    renderDebugPanel();
  };

  const setAudioBadgeWithProvider = (stateName, label, providerLabel, tooltip = '', options = {}) => {
    const finalLabel = formatAudioBadgeLabel(label, providerLabel);
    setAudioBadge(stateName, finalLabel, tooltip || finalLabel, options);
  };

  const showTryingArchiveProviderBadge = (providerLabel, progress) => {
    const label = String(providerLabel || '').trim()
      || getProviderDisplayName(state.providerOverride);
    setProviderState({ currentArchiveProviderLabel: label });
    const { providerSuffix, tooltipDownload, fraction } = buildArchiveProviderProgressParts(progress);
    const title = tooltipDownload
      ? `Fetching beatmap archive from ${label} — ${tooltipDownload}`
      : `Fetching beatmap archive from ${label}`;
    setAudioBadgeWithProvider('loading', 'Loading full audio', `${label}${providerSuffix}`, title, { progress: fraction });
  };

  return {
    setFullAudioLoading,
    setAudioBadge,
    hideAudioBadge,
    setAudioBadgeWithProvider,
    showTryingArchiveProviderBadge,
  };
};

export {
  AUDIO_READY_SHOWN_MS,
  buildArchiveProviderProgressParts,
  createAudioBadgeController,
  describeAudioBadge,
  formatArchiveDownloadSize,
  resolveAudioActivity,
};
