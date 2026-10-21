import { describe, expect, it } from 'vitest';

import {
  FULLSCREEN_ENTER_AREA,
  FULLSCREEN_EXIT_AREA,
  FULLSCREEN_TRANSITION_MS,
  LOSS_GRACE_MS,
  createWindowState,
  updateWindowState,
} from './window-state.js';

function loseTrackingAtHalfProgress() {
  const acquired = updateWindowState(createWindowState(), {
    activeHands: 2,
    visibleHands: 2,
    area: 0.8,
    now: 1_000,
  });
  const halfway = updateWindowState(acquired, {
    activeHands: 2,
    visibleHands: 2,
    area: 0.8,
    now: 1_110,
  });

  return updateWindowState(halfway, {
    activeHands: 0,
    visibleHands: 0,
    area: 0,
    now: 1_160,
  });
}

describe('window state constants', () => {
  it('exports the configured thresholds and durations', () => {
    expect(FULLSCREEN_ENTER_AREA).toBe(0.7);
    expect(FULLSCREEN_EXIT_AREA).toBe(0.55);
    expect(LOSS_GRACE_MS).toBe(250);
    expect(FULLSCREEN_TRANSITION_MS).toBe(220);
  });
});

describe('createWindowState', () => {
  it('creates a fresh immutable initial state with the exact structure', () => {
    const first = createWindowState();
    const second = createWindowState();

    expect(first).toEqual({
      phase: 'idle',
      lastTrackedAt: 0,
      opacity: 0,
      fullscreenProgress: 0,
      updatedAt: 0,
    });
    expect(Object.keys(first)).toEqual([
      'phase',
      'lastTrackedAt',
      'opacity',
      'fullscreenProgress',
      'updatedAt',
    ]);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe('updateWindowState', () => {
  it('enters window with exactly two hands at normal area', () => {
    const next = updateWindowState(createWindowState(), {
      activeHands: 2,
      area: 0.2,
      now: 100,
    });

    expect(next).toEqual({
      phase: 'window',
      lastTrackedAt: 100,
      opacity: 1,
      fullscreenProgress: 0,
      updatedAt: 100,
      trackingLost: false,
    });
  });

  it('enters fullscreen at or above the enter threshold', () => {
    const above = updateWindowState(createWindowState(), {
      activeHands: 2,
      area: 0.71,
      now: 110,
    });
    const boundary = updateWindowState(createWindowState(), {
      activeHands: 2,
      area: FULLSCREEN_ENTER_AREA,
      now: 110,
    });

    expect(above.phase).toBe('fullscreen');
    expect(boundary.phase).toBe('fullscreen');
  });

  it('preserves a visible phase through 250ms of tracking loss, then becomes idle', () => {
    const visible = updateWindowState(createWindowState(), {
      activeHands: 2,
      area: 0.2,
      now: 100,
    });

    expect(updateWindowState(visible, { activeHands: 0, area: 0, now: 300 }).phase).toBe(
      'window',
    );
    expect(updateWindowState(visible, { activeHands: 0, area: 0, now: 351 }).phase).toBe(
      'idle',
    );
  });

  it('uses hysteresis while fullscreen', () => {
    const fullscreen = updateWindowState(createWindowState(), {
      activeHands: 2,
      area: 0.8,
      now: 100,
    });

    const retained = updateWindowState(fullscreen, {
      activeHands: 2,
      area: FULLSCREEN_EXIT_AREA + 0.01,
      now: 120,
    });
    const exited = updateWindowState(retained, {
      activeHands: 2,
      area: FULLSCREEN_EXIT_AREA,
      now: 140,
    });

    expect(retained.phase).toBe('fullscreen');
    expect(exited.phase).toBe('window');
  });

  it('fades opacity linearly during tracking loss', () => {
    const visible = updateWindowState(createWindowState(), {
      activeHands: 2,
      area: 0.2,
      now: 100,
    });

    const halfway = updateWindowState(visible, { activeHands: 1, area: 0.2, now: 225 });
    const boundary = updateWindowState(visible, { activeHands: 0, area: 0, now: 350 });

    expect(halfway.opacity).toBe(0.5);
    expect(boundary.opacity).toBe(0);
    expect(boundary.phase).toBe('window');
    expect(halfway.lastTrackedAt).toBe(100);
  });

  it('starts first acquisition at zero progress regardless of the absolute timestamp', () => {
    const acquired = updateWindowState(createWindowState(), {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 10_000,
    });
    const halfway = updateWindowState(acquired, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 10_000 + FULLSCREEN_TRANSITION_MS / 2,
    });
    const complete = updateWindowState(halfway, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 10_000 + FULLSCREEN_TRANSITION_MS,
    });

    expect(acquired.phase).toBe('fullscreen');
    expect(acquired.fullscreenProgress).toBe(0);
    expect(halfway.fullscreenProgress).toBeCloseTo(0.5);
    expect(complete.fullscreenProgress).toBe(1);
  });

  it('ignores stale reacquisition, tracking loss, and low-area fullscreen exit', () => {
    const idle = Object.freeze({
      phase: 'idle',
      lastTrackedAt: 0,
      opacity: 0,
      fullscreenProgress: 0,
      updatedAt: 1_000,
      trackingLost: 'invalid',
    });
    const fullscreen = Object.freeze({
      phase: 'fullscreen',
      lastTrackedAt: 1_000,
      opacity: 1,
      fullscreenProgress: 0.5,
      updatedAt: 1_000,
      trackingLost: true,
    });

    const staleReacquisition = updateWindowState(idle, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 999,
    });
    const staleLoss = updateWindowState(fullscreen, {
      activeHands: 0,
      visibleHands: 0,
      area: 0,
      now: 999,
    });
    const staleExit = updateWindowState(fullscreen, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.2,
      now: 999,
    });

    expect(staleReacquisition).toEqual({ ...idle, trackingLost: false });
    expect(staleLoss).toEqual(fullscreen);
    expect(staleExit).toEqual(fullscreen);
    expect(staleReacquisition).not.toBe(idle);
    expect(staleLoss).not.toBe(fullscreen);
    expect(staleExit).not.toBe(fullscreen);
  });

  it('freezes fullscreen progress during genuine loss and resets after grace', () => {
    const acquired = updateWindowState(createWindowState(), {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 10_000,
    });
    const halfway = updateWindowState(acquired, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 10_110,
    });
    const fading = updateWindowState(halfway, {
      activeHands: 0,
      visibleHands: 0,
      area: 0,
      now: 10_210,
    });
    const graceBoundary = updateWindowState(fading, {
      activeHands: 0,
      visibleHands: 0,
      area: 0,
      now: 10_360,
    });
    const expired = updateWindowState(graceBoundary, {
      activeHands: 0,
      visibleHands: 0,
      area: 0,
      now: 10_361,
    });
    const reacquired = updateWindowState(expired, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 10_400,
    });
    const reacquiredHalfway = updateWindowState(reacquired, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 10_510,
    });

    expect(halfway.fullscreenProgress).toBe(0.5);
    expect(fading).toMatchObject({
      phase: 'fullscreen',
      opacity: 0.6,
      fullscreenProgress: 0.5,
      trackingLost: true,
    });
    expect(graceBoundary).toMatchObject({
      phase: 'fullscreen',
      opacity: 0,
      fullscreenProgress: 0.5,
      trackingLost: true,
    });
    expect(expired).toMatchObject({
      phase: 'idle',
      opacity: 0,
      fullscreenProgress: 0,
      trackingLost: false,
    });
    expect(reacquired).toMatchObject({
      phase: 'fullscreen',
      fullscreenProgress: 0,
      trackingLost: false,
    });
    expect(reacquiredHalfway.fullscreenProgress).toBe(0.5);
  });

  it('preserves progress when loss and the preceding tracked frame share a timestamp', () => {
    const acquired = updateWindowState(createWindowState(), {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 1_000,
    });
    const halfway = updateWindowState(acquired, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 1_110,
    });
    const lost = updateWindowState(halfway, {
      activeHands: 0,
      visibleHands: 0,
      area: 0,
      now: 1_110,
    });
    const reacquired = updateWindowState(lost, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 1_160,
    });
    const next = updateWindowState(reacquired, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 1_270,
    });

    expect(halfway.fullscreenProgress).toBe(0.5);
    expect(lost).toMatchObject({ fullscreenProgress: 0.5, trackingLost: true });
    expect(reacquired).toMatchObject({ fullscreenProgress: 0.5, trackingLost: false });
    expect(next.fullscreenProgress).toBe(1);
  });

  it('resumes an entering transition after within-grace reacquisition', () => {
    const lost = loseTrackingAtHalfProgress();

    const reacquired = updateWindowState(lost, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 1_210,
    });
    const next = updateWindowState(reacquired, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 1_320,
    });

    expect(lost.fullscreenProgress).toBe(0.5);
    expect(reacquired).toMatchObject({ phase: 'fullscreen', fullscreenProgress: 0.5 });
    expect(next.fullscreenProgress).toBe(1);
  });

  it('preserves fullscreen phase and progress when reacquired inside the hysteresis band', () => {
    const lost = loseTrackingAtHalfProgress();

    const reacquired = updateWindowState(lost, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.6,
      now: 1_210,
    });

    expect(reacquired).toMatchObject({ phase: 'fullscreen', fullscreenProgress: 0.5 });
  });

  it('resumes an exiting transition after low-area within-grace reacquisition', () => {
    const lost = loseTrackingAtHalfProgress();

    const reacquired = updateWindowState(lost, {
      activeHands: 2,
      visibleHands: 2,
      area: FULLSCREEN_EXIT_AREA,
      now: 1_210,
    });
    const next = updateWindowState(reacquired, {
      activeHands: 2,
      visibleHands: 2,
      area: FULLSCREEN_EXIT_AREA,
      now: 1_320,
    });

    expect(reacquired).toMatchObject({ phase: 'window', fullscreenProgress: 0.5 });
    expect(next.fullscreenProgress).toBe(0);
  });

  it('treats two visible hands with fewer than two pinches as an immediate release', () => {
    const acquired = updateWindowState(createWindowState(), {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 1_000,
    });
    const progressed = updateWindowState(acquired, {
      activeHands: 2,
      visibleHands: 2,
      area: 0.8,
      now: 1_110,
    });

    const released = updateWindowState(progressed, {
      activeHands: 1,
      visibleHands: 2,
      area: 0.8,
      now: 1_120,
    });

    expect(released).toMatchObject({
      phase: 'idle',
      opacity: 0,
      fullscreenProgress: 0,
      trackingLost: false,
    });
  });

  it('defaults invalid observation values safely and clamps area', () => {
    const visible = updateWindowState(createWindowState(), {
      activeHands: 2,
      area: 0.2,
      now: 100,
    });
    const invalid = updateWindowState(visible, {
      activeHands: Number.NaN,
      area: Number.POSITIVE_INFINITY,
      now: Number.NaN,
    });
    const clampedHigh = updateWindowState(createWindowState(), {
      activeHands: 2,
      area: 10,
      now: 1,
    });

    expect(invalid).toEqual({ ...visible, trackingLost: true });
    expect(Number.isNaN(invalid.fullscreenProgress)).toBe(false);
    expect(clampedHigh.phase).toBe('fullscreen');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'normalizes malformed state numeric fields containing %s',
    (invalidNumber) => {
      const malformed = {
        phase: 'unknown',
        lastTrackedAt: invalidNumber,
        opacity: invalidNumber,
        fullscreenProgress: invalidNumber,
        updatedAt: invalidNumber,
      };
      const snapshot = { ...malformed };

      const next = updateWindowState(malformed, {
        activeHands: 0,
        visibleHands: 0,
        area: 0,
        now: 10,
      });

      expect(next.phase).toBe('idle');
      expect(Number.isFinite(next.lastTrackedAt)).toBe(true);
      expect(Number.isFinite(next.opacity)).toBe(true);
      expect(Number.isFinite(next.fullscreenProgress)).toBe(true);
      expect(Number.isFinite(next.updatedAt)).toBe(true);
      expect(next.trackingLost).toBe(false);
      expect(malformed).toEqual(snapshot);
    },
  );

  it('requires exactly two finite active hands', () => {
    for (const activeHands of [0, 1, 3, '2', undefined, Number.POSITIVE_INFINITY]) {
      const next = updateWindowState(createWindowState(), { activeHands, area: 0.8, now: 300 });
      expect(next.phase).toBe('idle');
    }
  });

  it('returns a new state without mutating the input', () => {
    const state = createWindowState();
    const snapshot = { ...state };

    const next = updateWindowState(state, { activeHands: 2, area: 0.2, now: 100 });

    expect(next).not.toBe(state);
    expect(state).toEqual(snapshot);
  });
});
