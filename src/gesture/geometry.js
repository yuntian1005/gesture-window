const PINCH_THRESHOLD = 0.22;
const MIN_POLYGON_AREA = 1e-8;

function isPoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

function hasOnlyFinitePoints(points) {
  if (!Array.isArray(points)) {
    return false;
  }

  for (let index = 0; index < points.length; index += 1) {
    if (!isPoint(points[index])) {
      return false;
    }
  }

  return true;
}

function clonePoints(points) {
  return points.map((point) => ({ ...point }));
}

function signedPolygonArea(points) {
  let sum = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }

  return sum / 2;
}

export function isPinching(thumb, index, palmWidth) {
  if (!isPoint(thumb) || !isPoint(index) || !Number.isFinite(palmWidth) || palmWidth <= 0) {
    return false;
  }

  return Math.hypot(index.x - thumb.x, index.y - thumb.y) / palmWidth <= PINCH_THRESHOLD;
}

/** Returns [] for malformed, duplicate, or negligible-area quadrilaterals. */
export function orderCorners(points) {
  if (!hasOnlyFinitePoints(points) || points.length !== 4) {
    return [];
  }

  const hasDuplicate = points.some((point, index) =>
    points.slice(0, index).some((other) => point.x === other.x && point.y === other.y),
  );

  if (hasDuplicate) {
    return [];
  }

  const centroid = points.reduce(
    (center, point) => ({ x: center.x + point.x / 4, y: center.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  const ordered = clonePoints(points).sort((a, b) => {
    const angleDifference =
      Math.atan2(a.y - centroid.y, a.x - centroid.x) -
      Math.atan2(b.y - centroid.y, b.x - centroid.x);

    if (angleDifference !== 0) {
      return angleDifference;
    }

    const aDistance = (a.x - centroid.x) ** 2 + (a.y - centroid.y) ** 2;
    const bDistance = (b.x - centroid.x) ** 2 + (b.y - centroid.y) ** 2;
    return aDistance - bDistance || a.x - b.x || a.y - b.y;
  });
  const topLeftIndex = ordered.reduce((smallestIndex, point, index) => {
    const smallest = ordered[smallestIndex];
    const comparison =
      point.x + point.y - (smallest.x + smallest.y) ||
      point.x - smallest.x ||
      point.y - smallest.y;

    return comparison < 0 ? index : smallestIndex;
  }, 0);
  const rotated = [...ordered.slice(topLeftIndex), ...ordered.slice(0, topLeftIndex)];
  const area = signedPolygonArea(rotated);

  if (Math.abs(area) < MIN_POLYGON_AREA) {
    return [];
  }

  return area < 0 ? [rotated[0], ...rotated.slice(1).reverse()] : rotated;
}

/** Returns 0 unless given at least three finite points. */
export function polygonArea(points) {
  if (!hasOnlyFinitePoints(points) || points.length < 3) {
    return 0;
  }

  return Math.abs(signedPolygonArea(points));
}

function triangleArea(first, second, third) {
  return Math.abs(
    (second.x - first.x) * (third.y - first.y)
    - (second.y - first.y) * (third.x - first.x),
  ) / 2;
}

/** Sums semantic triangles [0,1,2] and [0,2,3], intentionally counting overlap twice. */
export function trianglePairArea(points) {
  if (!hasOnlyFinitePoints(points) || points.length !== 4) return 0;

  return triangleArea(points[0], points[1], points[2])
    + triangleArea(points[0], points[2], points[3]);
}

/** Returns [] for invalid next points and clones next when previous is unusable. */
export function smoothPoints(previous, next, alpha) {
  if (!hasOnlyFinitePoints(next) || next.length === 0) {
    return [];
  }

  if (!hasOnlyFinitePoints(previous) || previous.length !== next.length) {
    return clonePoints(next);
  }

  const clampedAlpha = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;

  return next.map((point, index) => ({
    x: previous[index].x + (point.x - previous[index].x) * clampedAlpha,
    y: previous[index].y + (point.y - previous[index].y) * clampedAlpha,
  }));
}
