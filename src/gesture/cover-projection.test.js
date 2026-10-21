import { describe, expect, it } from 'vitest';

import { projectCoverPoint, projectHandsForCover } from './cover-projection.js';

describe('projectCoverPoint', () => {
  it('projects a vertical crop when the source is narrower than the target', () => {
    const dimensions = {
      sourceWidth: 4,
      sourceHeight: 3,
      targetWidth: 16,
      targetHeight: 9,
    };

    expect(projectCoverPoint({ x: 0.25, y: 0.125 }, dimensions)).toEqual({ x: 0.25, y: 0 });
    expect(projectCoverPoint({ x: 0.75, y: 0.5 }, dimensions)).toEqual({ x: 0.75, y: 0.5 });
    expect(projectCoverPoint({ x: 0.25, y: 0.875 }, dimensions)).toEqual({ x: 0.25, y: 1 });
  });

  it('projects a horizontal crop when the source is wider than the target', () => {
    const dimensions = {
      sourceWidth: 16,
      sourceHeight: 9,
      targetWidth: 4,
      targetHeight: 3,
    };

    expect(projectCoverPoint({ x: 0.125, y: 0.25 }, dimensions)).toEqual({ x: 0, y: 0.25 });
    expect(projectCoverPoint({ x: 0.5, y: 0.75 }, dimensions)).toEqual({ x: 0.5, y: 0.75 });
    expect(projectCoverPoint({ x: 0.875, y: 0.25 }, dimensions)).toEqual({ x: 1, y: 0.25 });
  });

  it('leaves equal-aspect points unchanged without returning the input object', () => {
    const point = { x: 0.2, y: 0.8 };
    const projected = projectCoverPoint(point, {
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 1280,
      targetHeight: 720,
    });

    expect(projected).toEqual(point);
    expect(projected).not.toBe(point);
  });

  it.each([
    [{ x: 0.5, y: 0.1 }, { sourceWidth: 4, sourceHeight: 3, targetWidth: 16, targetHeight: 9 }],
    [{ x: 0.1, y: 0.5 }, { sourceWidth: 16, sourceHeight: 9, targetWidth: 4, targetHeight: 3 }],
    [{ x: Number.NaN, y: 0.5 }, { sourceWidth: 1, sourceHeight: 1, targetWidth: 1, targetHeight: 1 }],
    [{ x: 0.5, y: 0.5 }, { sourceWidth: 0, sourceHeight: 1, targetWidth: 1, targetHeight: 1 }],
    [{ x: 0.5, y: 0.5 }, { sourceWidth: 1, sourceHeight: Infinity, targetWidth: 1, targetHeight: 1 }],
  ])('returns null for cropped or invalid input %#', (point, dimensions) => {
    expect(projectCoverPoint(point, dimensions)).toBeNull();
  });
});

describe('projectHandsForCover', () => {
  it('preserves hand state, projects landmarks, and recomputes projected palm width', () => {
    const hands = [{
      thumb: { x: 0.2, y: 0.2 },
      index: { x: 0.8, y: 0.8 },
      wrist: { x: 0.2, y: 0.5 },
      indexMcp: { x: 0.8, y: 0.5 },
      palmWidth: 0.2,
      pinching: true,
      handedness: 'Left',
    }];

    const projected = projectHandsForCover(hands, {
      sourceWidth: 16,
      sourceHeight: 9,
      targetWidth: 4,
      targetHeight: 3,
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ pinching: true, handedness: 'Left' });
    expect(projected[0].thumb).toMatchObject({ y: 0.2 });
    expect(projected[0].index).toMatchObject({ y: 0.8 });
    expect(projected[0].wrist).toMatchObject({ y: 0.5 });
    expect(projected[0].indexMcp).toMatchObject({ y: 0.5 });
    expect(projected[0].thumb.x).toBeCloseTo(0.1);
    expect(projected[0].index.x).toBeCloseTo(0.9);
    expect(projected[0].wrist.x).toBeCloseTo(0.1);
    expect(projected[0].indexMcp.x).toBeCloseTo(0.9);
    expect(projected[0].palmWidth).toBeCloseTo(0.8);
  });

  it('excludes hands whose projected thumb or index is outside the visible crop', () => {
    const visible = {
      thumb: { x: 0.2, y: 0.5 },
      index: { x: 0.8, y: 0.5 },
      pinching: true,
      handedness: 'Left',
    };
    const cropped = {
      thumb: { x: 0.05, y: 0.5 },
      index: { x: 0.8, y: 0.5 },
      pinching: true,
      handedness: 'Right',
    };

    expect(projectHandsForCover([visible, cropped], {
      sourceWidth: 16,
      sourceHeight: 9,
      targetWidth: 4,
      targetHeight: 3,
    })).toEqual([
      expect.objectContaining({ handedness: 'Left', pinching: true }),
    ]);
  });

  it.each([undefined, null, {}, { sourceWidth: 1, sourceHeight: 1, targetWidth: 0, targetHeight: 1 }])(
    'returns no usable hands for invalid input %#',
    (input) => {
      expect(projectHandsForCover(input === undefined ? undefined : [], input)).toEqual([]);
    },
  );
});
