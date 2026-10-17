// The audio status badge over the playfield: which audio is playing, where the
// full track is coming from, and how far its download has got.

const AUDIO_BADGE_AUTO_HIDE_DELAY_MS = 3500;

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

const buildArchiveProviderProgressParts = (progress) => {
  if (!progress || typeof progress.loaded !== 'number' || progress.loaded < 0) {
    return { providerSuffix: '', tooltipDownload: '' };
  }
  const { loaded } = progress;
  const total = typeof progress.total === 'number' && progress.total > 0 ? progress.total : null;
  if (total !== null) {
    const pct = Math.min(100, Math.round((100 * loaded) / total));
    return {
      providerSuffix: ` · ${pct}%`,
      tooltipDownload: `${formatArchiveDownloadSize(loaded)} / ${formatArchiveDownloadSize(total)}`,
    };
  }
  return {
    providerSuffix: ` · ${formatArchiveDownloadSize(loaded)}`,
    tooltipDownload: `${formatArchiveDownloadSize(loaded)} received`,
  };
};

const createAudioBadgeController = ({
  badge,
  state,
  registry,
  renderDebugPanel,
  getProviderDisplayName,
  setProviderState,
}) => {
  const setFullAudioLoading = (isLoading) => {
    badge?.classList.toggle('is-spinning', Boolean(isLoading));
  };

  const setAudioBadge = (stateName, label, tooltip = '') => {
    if (!badge) {
      return;
    }

    state.audioBadgeHideTimer = registry.clearTimeout(state.audioBadgeHideTimer);

    badge.classList.remove('is-hidden');
    badge.classList.remove('is-preview', 'is-loading', 'is-ready', 'is-failed');
    badge.classList.add(`is-${stateName}`);
    badge.textContent = label;
    badge.title = tooltip || label;

    if (stateName === 'ready') {
      state.audioBadgeHideTimer = registry.addTimeout(setTimeout(() => {
        badge.classList.add('is-hidden');
        state.audioBadgeHideTimer = null;
      }, AUDIO_BADGE_AUTO_HIDE_DELAY_MS));
    }

    renderDebugPanel();
  };

  // For states with nothing true to say: no map loaded, or the load failed. An
  // optimistic "Preview audio" label over silence is worse than no label at all.
  const hideAudioBadge = () => {
    if (!badge) {
      return;
    }

    state.audioBadgeHideTimer = registry.clearTimeout(state.audioBadgeHideTimer);
    badge.classList.add('is-hidden');
    badge.classList.remove('is-spinning');
    renderDebugPanel();
  };

  const setAudioBadgeWithProvider = (stateName, label, providerLabel, tooltip = '') => {
    const finalLabel = formatAudioBadgeLabel(label, providerLabel);
    setAudioBadge(stateName, finalLabel, tooltip || finalLabel);
  };

  const showTryingArchiveProviderBadge = (providerLabel, progress) => {
    const label = String(providerLabel || '').trim()
      || getProviderDisplayName(state.providerOverride);
    setProviderState({ currentArchiveProviderLabel: label });
    const { providerSuffix, tooltipDownload } = buildArchiveProviderProgressParts(progress);
    const title = tooltipDownload
      ? `Fetching beatmap archive from ${label} — ${tooltipDownload}`
      : `Fetching beatmap archive from ${label}`;
    setAudioBadgeWithProvider('loading', 'Loading full audio', `${label}${providerSuffix}`, title);
  };

  return {
    setFullAudioLoading,
    setAudioBadge,
    hideAudioBadge,
    setAudioBadgeWithProvider,
    showTryingArchiveProviderBadge,
  };
};

export { buildArchiveProviderProgressParts, createAudioBadgeController, formatArchiveDownloadSize };
