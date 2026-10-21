function hasPositiveDimensions(dimensions) {
  return (
    Number.isFinite(dimensions?.sourceWidth)
    && dimensions.sourceWidth > 0
    && Number.isFinite(dimensions?.sourceHeight)
    && dimensions.sourceHeight > 0
    && Number.isFinite(dimensions?.targetWidth)
    && dimensions.targetWidth > 0
    && Number.isFinite(dimensions?.targetHeight)
    && dimensions.targetHeight > 0
  );
}

export function projectCoverPoint(point, dimensions) {
  if (
    !Number.isFinite(point?.x)
    || !Number.isFinite(point?.y)
    || !hasPositiveDimensions(dimensions)
  ) {
    return null;
  }

  const sourceAspect = dimensions.sourceWidth / dimensions.sourceHeight;
  const targetAspect = dimensions.targetWidth / dimensions.targetHeight;
  let x = point.x;
  let y = point.y;

  if (sourceAspect < targetAspect) {
    const visibleY = sourceAspect / targetAspect;
    y = (y - (1 - visibleY) / 2) / visibleY;
  } else if (sourceAspect > targetAspect) {
    const visibleX = targetAspect / sourceAspect;
    x = (x - (1 - visibleX) / 2) / visibleX;
  }

  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

export function projectHandsForCover(hands, dimensions) {
  if (!Array.isArray(hands) || !hasPositiveDimensions(dimensions)) return [];

  const projectedHands = [];
  for (const hand of hands) {
    const thumb = projectCoverPoint(hand?.thumb, dimensions);
    const index = projectCoverPoint(hand?.index, dimensions);
    if (!thumb || !index) continue;

    const wrist = projectCoverPoint(hand?.wrist, dimensions);
    const indexMcp = projectCoverPoint(hand?.indexMcp, dimensions);
    const palmWidth = wrist && indexMcp
      ? Math.hypot(wrist.x - indexMcp.x, wrist.y - indexMcp.y)
      : null;

    projectedHands.push({
      ...hand,
      thumb,
      index,
      wrist,
      indexMcp,
      palmWidth,
      pinching: hand?.pinching === true,
      handedness: hand?.handedness,
    });
  }
  return projectedHands;
}
