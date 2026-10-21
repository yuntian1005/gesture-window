export const FULLSCREEN_ENTER_AREA = 0.7;
export const FULLSCREEN_EXIT_AREA = 0.55;
export const LOSS_GRACE_MS = 250;
export const FULLSCREEN_TRANSITION_MS = 220;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function freezeState(
  phase,
  lastTrackedAt,
  opacity,
  fullscreenProgress,
  updatedAt,
  trackingLost,
) {
  const state = {
    phase,
    lastTrackedAt,
    opacity,
    fullscreenProgress,
    updatedAt,
  };

  if (typeof trackingLost === 'boolean') {
    state.trackingLost = trackingLost;
  }

  return Object.freeze(state);
}

function normalizeState(state) {
  const updatedAt = Number.isFinite(state?.updatedAt) ? Math.max(0, state.updatedAt) : 0;
  const lastTrackedAt = Number.isFinite(state?.lastTrackedAt)
    ? clamp(state.lastTrackedAt, 0, updatedAt)
    : 0;
  const phase = ['idle', 'window', 'fullscreen'].includes(state?.phase) ? state.phase : 'idle';
  const opacity =
    phase === 'idle' || !Number.isFinite(state?.opacity) ? 0 : clamp(state.opacity, 0, 1);
  const fullscreenProgress =
    phase === 'idle' || !Number.isFinite(state?.fullscreenProgress)
      ? 0
      : clamp(state.fullscreenProgress, 0, 1);
  const trackingLost = typeof state?.trackingLost === 'boolean' ? state.trackingLost : false;

  return freezeState(
    phase,
    lastTrackedAt,
    opacity,
    fullscreenProgress,
    updatedAt,
    trackingLost,
  );
}

export function createWindowState() {
  return freezeState('idle', 0, 0, 0, 0);
}

export function updateWindowState(state, observation = {}) {
  const current = normalizeState(state);
  const activeHands = Number.isFinite(observation?.activeHands) ? observation.activeHands : 0;
  const visibleHands = Number.isFinite(observation?.visibleHands)
    ? observation.visibleHands
    : activeHands > 0
      ? activeHands
      : 0;
  const area = Number.isFinite(observation?.area) ? clamp(observation.area, 0, 1) : 0;

  if (Number.isFinite(observation?.now) && observation.now < current.updatedAt) {
    return current;
  }

  const now = Number.isFinite(observation?.now) ? observation.now : current.updatedAt;
  const elapsed = now - current.updatedAt;
  const tracked = activeHands === 2 && visibleHands === 2;
  const trackingLost = visibleHands < 2;

  let phase;
  let lastTrackedAt = current.lastTrackedAt;
  let opacity;
  let fullscreenProgress;
  let nextTrackingLost;

  if (tracked) {
    const reacquiredDuringGrace = current.trackingLost;
    const remainsFullscreen = current.phase === 'fullscreen' && area > FULLSCREEN_EXIT_AREA;
    phase = remainsFullscreen || area >= FULLSCREEN_ENTER_AREA ? 'fullscreen' : 'window';
    lastTrackedAt = now;
    opacity = 1;
    nextTrackingLost = false;
    const progressStep =
      current.phase === 'idle' || reacquiredDuringGrace
        ? 0
        : elapsed / FULLSCREEN_TRANSITION_MS;
    fullscreenProgress = clamp(
      current.fullscreenProgress + (phase === 'fullscreen' ? progressStep : -progressStep),
      0,
      1,
    );
  } else if (trackingLost) {
    const trackingLoss = now - current.lastTrackedAt;
    const withinGrace = current.phase !== 'idle' && trackingLoss <= LOSS_GRACE_MS;
    phase = withinGrace ? current.phase : 'idle';
    opacity = withinGrace ? clamp(1 - trackingLoss / LOSS_GRACE_MS, 0, 1) : 0;
    fullscreenProgress = withinGrace ? current.fullscreenProgress : 0;
    nextTrackingLost = withinGrace;
  } else {
    phase = 'idle';
    opacity = 0;
    fullscreenProgress = 0;
    nextTrackingLost = false;
  }

  return freezeState(
    phase,
    lastTrackedAt,
    opacity,
    fullscreenProgress,
    now,
    nextTrackingLost,
  );
}
