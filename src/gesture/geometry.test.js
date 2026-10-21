import { describe, expect, it } from 'vitest';

import {
  isPinching,
  orderCorners,
  polygonArea,
  smoothPoints,
  trianglePairArea,
} from './geometry.js';

function permutations(points) {
  if (points.length === 0) {
    return [[]];
  }

  return points.flatMap((point, index) =>
    permutations(points.filter((_, candidateIndex) => candidateIndex !== index)).map(
      (remaining) => [point, ...remaining],
    ),
  );
}

describe('isPinching', () => {
  it('returns true at or below the normalized pinch threshold', () => {
    expect(isPinching({ x: 0, y: 0 }, { x: 0.04, y: 0 }, 0.5)).toBe(true);
    expect(isPinching({ x: 0, y: 0 }, { x: 0.11, y: 0 }, 0.5)).toBe(true);
  });

  it('returns false above the normalized pinch threshold', () => {
    expect(isPinching({ x: 0, y: 0 }, { x: 0.12, y: 0 }, 0.5)).toBe(false);
  });

  it.each([undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns false for invalid palm width %s',
    (palmWidth) => {
      expect(isPinching({ x: 0, y: 0 }, { x: 0.04, y: 0 }, palmWidth)).toBe(false);
    },
  );
});

describe('orderCorners', () => {
  it('orders a square from top-left clockwise', () => {
    const points = [
      { x: 1, y: 1 },
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ];

    expect(orderCorners(points)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
  });

  it('orders realistic quadrilaterals identically for every permutation', () => {
    const expected = [
      { x: 0.18, y: 0.2 },
      { x: 0.78, y: 0.14 },
      { x: 0.84, y: 0.72 },
      { x: 0.12, y: 0.8 },
    ];

    for (const points of permutations(expected)) {
      expect(orderCorners(points)).toEqual(expected);
    }
  });

  it.each([
    {
      invalidPoints: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
    },
    {
      invalidPoints: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ],
    },
    {
      invalidPoints: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: Number.NaN },
        { x: 0, y: 1 },
      ],
    },
    {
      invalidPoints: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1e-10 },
        { x: 0, y: 1e-10 },
      ],
    },
  ])('returns an empty array for every permutation of invalid points', ({ invalidPoints }) => {
    for (const points of permutations(invalidPoints)) {
      expect(orderCorners(points)).toEqual([]);
    }
  });

  it('does not mutate its input', () => {
    const points = [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    const snapshot = structuredClone(points);

    orderCorners(points);

    expect(points).toEqual(snapshot);
  });
});

describe('polygonArea', () => {
  it('returns one for a unit square', () => {
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ]),
    ).toBe(1);
  });

  it.each([
    { points: null },
    { points: [] },
    { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    {
      points: [
        { x: 0, y: 0 },
        { x: Number.POSITIVE_INFINITY, y: 0 },
        { x: 0, y: 1 },
      ],
    },
  ])('returns zero for invalid points', ({ points }) => {
    expect(polygonArea(points)).toBe(0);
  });
});

describe('trianglePairArea', () => {
  it('sums the two semantic triangle areas for a normal rectangle', () => {
    expect(trianglePairArea([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
    ])).toBe(1);
  });

  it('counts both triangles when semantic points cross and overlap', () => {
    expect(trianglePairArea([
      { x: 0, y: 1 },
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
    ])).toBe(1);
  });

  it.each([
    null,
    [],
    [{ x: 0, y: 0 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: Number.NaN }, { x: 0, y: 1 }],
  ])('returns zero for malformed semantic points', (points) => {
    expect(trianglePairArea(points)).toBe(0);
  });
});

describe('smoothPoints', () => {
  it('linearly interpolates matching points', () => {
    expect(smoothPoints([{ x: 0, y: 0 }], [{ x: 1, y: 1 }], 0.25)).toEqual([
      { x: 0.25, y: 0.25 },
    ]);
  });

  it('returns an empty array when next is not a usable point array', () => {
    expect(smoothPoints(null, null, 0.5)).toEqual([]);
    expect(smoothPoints(null, [], 0.5)).toEqual([]);
    expect(smoothPoints(null, [{ x: Number.NaN, y: 1 }], 0.5)).toEqual([]);
  });

  it('clones next points when previous contains an invalid point', () => {
    const previous = [{ x: Number.NaN, y: 0 }];
    const next = [{ x: 1, y: 1 }];
    const result = smoothPoints(previous, next, 0.5);

    expect(result).toEqual(next);
    expect(result).not.toBe(next);
    expect(result[0]).not.toBe(next[0]);
  });

  it.each([Number.NaN, undefined])('adopts next for non-finite alpha %s', (alpha) => {
    const next = [{ x: 1, y: 1 }];
    const result = smoothPoints([{ x: 0, y: 0 }], next, alpha);

    expect(result).toEqual(next);
    expect(result).not.toBe(next);
    expect(result[0]).not.toBe(next[0]);
  });

  it.each([
    { alpha: -1, expected: { x: 0, y: 0 } },
    { alpha: 2, expected: { x: 1, y: 1 } },
  ])('clamps alpha $alpha', ({ alpha, expected }) => {
    expect(smoothPoints([{ x: 0, y: 0 }], [{ x: 1, y: 1 }], alpha)).toEqual([expected]);
  });

  it('clones next points when previous is unusable or has a different length', () => {
    const next = [{ x: 1, y: 1 }];
    const withoutPrevious = smoothPoints(null, next, 0.5);
    const withDifferentLength = smoothPoints([], next, 0.5);

    expect(withoutPrevious).toEqual(next);
    expect(withDifferentLength).toEqual(next);
    expect(withoutPrevious).not.toBe(next);
    expect(withoutPrevious[0]).not.toBe(next[0]);
    expect(withDifferentLength).not.toBe(next);
    expect(withDifferentLength[0]).not.toBe(next[0]);
  });

  it('does not mutate either input array', () => {
    const previous = [{ x: 0, y: 0 }];
    const next = [{ x: 1, y: 1 }];
    const previousSnapshot = structuredClone(previous);
    const nextSnapshot = structuredClone(next);

    smoothPoints(previous, next, 0.25);

    expect(previous).toEqual(previousSnapshot);
    expect(next).toEqual(nextSnapshot);
  });
});
