import { describe, expect, it } from 'vitest';

import { orderSemanticHands } from './semantic-hands.js';

function hand(handedness, thumbX, indexX, wristX = thumbX) {
  return {
    handedness,
    thumb: { x: thumbX, y: 0.3 },
    index: { x: indexX, y: 0.4 },
    wrist: { x: wristX, y: 0.7 },
  };
}

describe('orderSemanticHands', () => {
  it('orders reversed MediaPipe results by case-insensitive handedness', () => {
    const left = hand('left', 0.2, 0.3);
    const right = hand('RIGHT', 0.7, 0.8);

    expect(orderSemanticHands([right, left])).toEqual([left, right]);
  });

  it.each([
    [undefined, undefined],
    ['Left', 'Left'],
    ['Right', 'Right'],
    ['unknown', 'unknown'],
  ])('falls back to fingertip midpoint for ambiguous labels %s/%s', (firstLabel, secondLabel) => {
    const screenRight = hand(firstLabel, 0.75, 0.85);
    const screenLeft = hand(secondLabel, 0.15, 0.25);

    expect(orderSemanticHands([screenRight, screenLeft])).toEqual([screenLeft, screenRight]);
  });

  it('uses wrist X and then original index as deterministic fallback', () => {
    const right = { handedness: undefined, wrist: { x: 0.8, y: 0.5 } };
    const left = { handedness: undefined, wrist: { x: 0.2, y: 0.5 } };
    const first = { handedness: undefined };
    const second = { handedness: undefined };

    expect(orderSemanticHands([right, left])).toEqual([left, right]);
    expect(orderSemanticHands([first, second])).toEqual([first, second]);
  });

  it('uses wrist X when fingertip midpoints are tied', () => {
    const screenLeft = hand(undefined, 0.3, 0.7, 0.2);
    const screenRight = hand(undefined, 0.4, 0.6, 0.8);

    expect(orderSemanticHands([screenRight, screenLeft])).toEqual([screenLeft, screenRight]);
  });

  it('does not mutate the source array or hand objects', () => {
    const left = hand('Left', 0.2, 0.3);
    const right = hand('Right', 0.7, 0.8);
    const hands = [right, left];
    const snapshot = structuredClone(hands);

    const ordered = orderSemanticHands(hands);

    expect(hands).toEqual(snapshot);
    expect(ordered[0]).toBe(left);
    expect(ordered[1]).toBe(right);
  });

  it.each([undefined, null, [], [{}], [{}, {}, {}], [null, {}]])(
    'returns an empty array for invalid pair %j',
    (hands) => {
      expect(orderSemanticHands(hands)).toEqual([]);
    },
  );
});
