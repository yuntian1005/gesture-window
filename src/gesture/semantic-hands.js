function normalizedHandedness(hand) {
  return typeof hand?.handedness === 'string'
    ? hand.handedness.trim().toLowerCase()
    : '';
}

function finiteX(point) {
  return Number.isFinite(point?.x) ? point.x : undefined;
}

function fingertipMidpointX(hand) {
  const thumbX = finiteX(hand?.thumb);
  const indexX = finiteX(hand?.index);
  return thumbX !== undefined && indexX !== undefined
    ? (thumbX + indexX) / 2
    : Number.POSITIVE_INFINITY;
}

export function orderSemanticHands(hands) {
  if (
    !Array.isArray(hands)
    || hands.length !== 2
    || hands.some((hand) => !hand || typeof hand !== 'object')
  ) {
    return [];
  }

  const labels = hands.map(normalizedHandedness);
  const leftIndex = labels.indexOf('left');
  const rightIndex = labels.indexOf('right');
  if (leftIndex !== -1 && rightIndex !== -1) {
    return [hands[leftIndex], hands[rightIndex]];
  }

  return hands
    .map((hand, index) => ({
      hand,
      index,
      fingertipX: fingertipMidpointX(hand),
      wristX: finiteX(hand?.wrist) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((first, second) => (
      first.fingertipX - second.fingertipX
      || first.wristX - second.wristX
      || first.index - second.index
    ))
    .map(({ hand }) => hand);
}
