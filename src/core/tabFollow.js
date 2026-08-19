// Picks which browser tab a detached preview window should mirror.
//
// The detached window is not tied to a tab, so it watches the browsing windows
// instead: whenever a normal window's active tab is an osu! beatmap page, that
// map becomes the preview. Difficulty switches on a beatmapset page are hash
// changes on the same tab, so they arrive through the same path as navigation.
//
// Extension APIs stay in the caller; this module only decides.

import { extractBeatmapInfoFromUrl } from './beatmapUrl.js';

/**
 * Chooses the beatmap tab to mirror.
 *
 * `preferredWindowId` is the last browsing window the user actually focused, so
 * that two osu! tabs open in different windows resolve to the one being used
 * rather than whichever the API happened to list first.
 * `excludeWindowId` drops the detached window itself.
 */
const pickBeatmapTabInfo = (tabs, { preferredWindowId = null, excludeWindowId = null } = {}) => {
  const candidates = [];

  for (const tab of tabs || []) {
    // `url` is only populated for tabs the extension has host access to, so a
    // non-osu! tab reads as undefined here rather than being filtered later.
    if (!tab?.url) {
      continue;
    }
    if (excludeWindowId !== null && excludeWindowId !== undefined && tab.windowId === excludeWindowId) {
      continue;
    }

    const info = extractBeatmapInfoFromUrl(tab.url);
    if (info.valid) {
      candidates.push({ tab, info });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const preferred = candidates.find((candidate) => (
    preferredWindowId !== null
    && preferredWindowId !== undefined
    && candidate.tab.windowId === preferredWindowId
  ));

  return preferred || candidates[0];
};

/**
 * Decides whether two URL targets mean the same preview.
 *
 * Picking a different difficulty changes the beatmap id, so that carries most of
 * the work. Mode only distinguishes two targets when both name one explicitly:
 * a `/beatmaps/{id}` URL requests no mode and resolves to the map's native
 * ruleset, so treating that absence as a difference would reload the map that is
 * already on screen every time the check runs.
 */
const isSameFollowTarget = (first, second) => {
  if (!first || !second) {
    return false;
  }

  if (String(first.beatmapId || '') !== String(second.beatmapId || '')) {
    return false;
  }

  const firstMode = first.mode ?? null;
  const secondMode = second.mode ?? null;
  if (firstMode === null || secondMode === null) {
    return true;
  }

  // Same map, explicitly different rulesets: a converted preview the user asked for.
  return firstMode === secondMode;
};

const toFollowTarget = (info) => (
  info?.valid
    ? { beatmapId: String(info.beatmapId || ''), mode: info.mode ?? null }
    : null
);

export { pickBeatmapTabInfo, isSameFollowTarget, toFollowTarget };
