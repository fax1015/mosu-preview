// Switching the in-page miniplayer between its expanded view and its
// collapsed bar.
//
// The two layouts share elements but hardly any positions, so nothing is moved
// from one to the other: that reads as everything scrambling at once. Instead
// it is Material's fade-through. The old view fades out fast, the layout
// switches while nothing is showing, and the new view fades in with a slight
// settle while the shell around the iframe (src/content.js) snaps to its new
// size. The page's background matches the popup's in both layouts (popup.css),
// so only the contents fade, never the surface.

const COLLAPSED_CLASS = 'is-embedded-collapsed';
// Held for the instant the layout switches, so nothing transitions into its
// new place: the new view arrives already laid out.
const SWITCHING_CLASS = 'is-mini-switching';

const FADE_OUT_MS = 70;
const FADE_IN_MS = 190;
// Material 3's emphasized accelerate and decelerate: out of the way quickly,
// in with a soft landing.
const FADE_OUT_EASING = 'cubic-bezier(0.3, 0, 1, 1)';
const FADE_IN_EASING = 'cubic-bezier(0.05, 0.7, 0.1, 1)';
// How far below full size the new view starts, settling up to it.
const FADE_IN_SCALE = 0.96;

const createMiniMorph = ({ root, popup, allowsMotion, setTimer, clearTimer }) => {
  let target = Boolean(root?.classList?.contains(COLLAPSED_CLASS));
  let switchTimer = null;
  let pendingOnSwitch = null;
  let pendingBeforeSwitch = null;
  let fade = null;

  const cancelFade = () => {
    fade?.cancel();
    fade = null;
  };

  const clearSwitchTimer = () => {
    if (switchTimer !== null) {
      clearTimer(switchTimer);
      switchTimer = null;
    }
  };

  const applyLayout = () => {
    root.classList.add(SWITCHING_CLASS);
    // Whatever has to go before the new layout arrives (menus, popovers)
    // goes now, unseen and without its own closing transition.
    const beforeSwitch = pendingBeforeSwitch;
    pendingBeforeSwitch = null;
    beforeSwitch?.(target);
    root.classList.toggle(COLLAPSED_CLASS, target);
    // Resolve the new layout's styles while transitions are off, so turning
    // them back on does not animate anything into place.
    void popup?.offsetWidth;
    root.classList.remove(SWITCHING_CLASS);
    const onSwitch = pendingOnSwitch;
    pendingOnSwitch = null;
    onSwitch?.(target);
  };

  const readOpacity = () => {
    const value = Number.parseFloat(globalThis.getComputedStyle?.(popup)?.opacity);
    return Number.isFinite(value) ? value : 1;
  };

  /**
   * Switches the page between the expanded view and the collapsed bar.
   * `onBeforeSwitch(collapsed)` runs while nothing is showing, just before
   * the layout changes, with transitions off: the place to close whatever the
   * new layout has no room for. `onSwitch(collapsed)` is called once the new
   * layout is in place, which is where anything measured from it (the
   * canvases) should be redrawn. `animate: false`, or reduced motion,
   * switches it outright.
   */
  const setCollapsed = (collapsed, { animate = true, onSwitch = null, onBeforeSwitch = null } = {}) => {
    target = Boolean(collapsed);
    pendingOnSwitch = onSwitch;
    pendingBeforeSwitch = onBeforeSwitch;
    const motion = animate && Boolean(allowsMotion?.()) && typeof popup?.animate === 'function';

    if (!motion) {
      clearSwitchTimer();
      cancelFade();
      applyLayout();
      return;
    }
    // Already faded out and waiting to switch: it will switch to wherever it
    // was last asked to go.
    if (switchTimer !== null) {
      return;
    }

    // Turned around mid-fade-in: leave from however visible it is now.
    const from = readOpacity();
    cancelFade();
    fade = popup.animate(
      [{ opacity: from }, { opacity: 0 }],
      { duration: Math.max(1, Math.round(FADE_OUT_MS * from)), easing: FADE_OUT_EASING, fill: 'forwards' },
    );

    switchTimer = setTimer(() => {
      switchTimer = null;
      applyLayout();
      cancelFade();
      const fadeIn = popup.animate(
        [
          { opacity: 0, transform: `scale(${FADE_IN_SCALE})` },
          { opacity: 1, transform: 'none' },
        ],
        { duration: FADE_IN_MS, easing: FADE_IN_EASING },
      );
      fade = fadeIn;
      fadeIn.addEventListener?.('finish', () => {
        if (fade === fadeIn) {
          fade = null;
        }
      });
    }, FADE_OUT_MS);
  };

  const dispose = () => {
    clearSwitchTimer();
    cancelFade();
  };

  return { setCollapsed, dispose };
};

export { FADE_IN_MS, FADE_OUT_MS, createMiniMorph };
