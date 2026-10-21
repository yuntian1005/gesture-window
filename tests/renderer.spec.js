import { expect, test } from './fixtures/playwright-test.js';

const FULL_QUAD = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
const SKEWED_QUAD = [
  { x: 0.18, y: 0.22 },
  { x: 0.82, y: 0.12 },
  { x: 0.73, y: 0.78 },
  { x: 0.29, y: 0.88 },
];

function shaderFailures(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || /shader|webgl.*error/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  return errors;
}

function isMagenta([red, green, blue]) {
  return red > 180 && green < 80 && blue > 180;
}

function colorDistance(first, second) {
  return first.slice(0, 3).reduce((total, channel, index) => (
    total + Math.abs(channel - second[index])
  ), 0);
}

function luminance([red, green, blue]) {
  return red * 0.299 + green * 0.587 + blue * 0.114;
}

function chroma([red, green, blue]) {
  return Math.max(red, green, blue) - Math.min(red, green, blue);
}

function hueSignature([red, green, blue]) {
  const channels = [red, green, blue];
  return `${channels.indexOf(Math.max(...channels))}:${channels.indexOf(Math.min(...channels))}`;
}

function normalizedInvertStrength(background, rendered) {
  const fullInvertDistance = background.slice(0, 3).reduce((total, channel) => (
    total + Math.abs(255 - 2 * channel)
  ), 0);
  return fullInvertDistance > 0
    ? colorDistance(background, rendered) / fullInvertDistance
    : 0;
}

async function openHarness(page, options) {
  await page.goto('/tests/fixtures/renderer-harness.html');
  await page.waitForFunction(() => Boolean(globalThis.rendererHarness));
  return page.evaluate((setupOptions) => globalThis.rendererHarness.setup(setupOptions), options);
}

test('real WebGL output is nonblank, nonuniform, mirrored, and cover-cropped', async ({ page }) => {
  const errors = shaderFailures(page);
  await openHarness(page, { width: 360, height: 120, pixelRatio: 1 });
  const landscape = await page.evaluate(() => globalThis.rendererHarness.render());
  expect(landscape.nonBlack).toBeGreaterThan(100);
  expect(landscape.maximum - landscape.minimum).toBeGreaterThan(100);
  expect(landscape.samples.topLeft[1]).toBeGreaterThan(landscape.samples.topLeft[0]);
  expect(landscape.samples.topRight[0]).toBeGreaterThan(landscape.samples.topRight[1]);
  expect(isMagenta(landscape.samples.edgeTop)).toBe(false);

  await page.evaluate(() => globalThis.rendererHarness.resize({ width: 120, height: 360 }));
  const portrait = await page.evaluate(() => globalThis.rendererHarness.render());
  expect(portrait.width).toBe(120);
  expect(portrait.height).toBe(360);
  expect(portrait.hash).not.toBe(landscape.hash);
  expect(portrait.samples.topLeft[1]).toBeGreaterThan(portrait.samples.topLeft[0]);
  expect(portrait.samples.topRight[0]).toBeGreaterThan(portrait.samples.topRight[1]);
  expect(isMagenta(portrait.samples.edgeLeft)).toBe(false);
  expect(errors).toEqual([]);
});

test('real shader modes differ and partial opacity blends with the background', async ({ page }) => {
  const errors = shaderFailures(page);
  await openHarness(page, { width: 320, height: 180, pixelRatio: 1 });
  const blendSamples = {
    upperInterior: { x: 0.45, y: 0.25 },
    lowerInterior: { x: 0.55, y: 0.75 },
    upperLeft: { x: 0.25, y: 0.2 },
    upperRight: { x: 0.75, y: 0.2 },
    lowerLeft: { x: 0.25, y: 0.8 },
    lowerRight: { x: 0.75, y: 0.8 },
  };
  const background = await page.evaluate((samples) => globalThis.rendererHarness.render({}, samples), blendSamples);
  const invert = await page.evaluate(({ corners, samples }) => globalThis.rendererHarness.render(
    { corners, opacity: 1, mode: 'invert' },
    samples,
  ), { corners: FULL_QUAD, samples: blendSamples });
  const rainbow = await page.evaluate(({ corners, samples }) => globalThis.rendererHarness.render(
    { corners, opacity: 1, mode: 'rainbow', time: 1.7 },
    samples,
  ), { corners: FULL_QUAD, samples: blendSamples });
  const mirror = await page.evaluate(({ corners, samples }) => globalThis.rendererHarness.render(
    { corners, opacity: 1, mode: 'mirror' },
    samples,
  ), { corners: FULL_QUAD, samples: blendSamples });
  expect(new Set([invert.hash, rainbow.hash, mirror.hash]).size).toBe(3);

  for (const sampleName of Object.keys(blendSamples)) {
    for (let channel = 0; channel < 3; channel += 1) {
      const source = background.samples[sampleName][channel];
      const expected = source * 0.28 + (255 - source) * 0.72;
      expect(Math.abs(invert.samples[sampleName][channel] - expected)).toBeLessThanOrEqual(4);
    }
    expect(Math.abs(
      luminance(rainbow.samples[sampleName]) - luminance(background.samples[sampleName]),
    )).toBeLessThanOrEqual(28);
  }
  for (const [sampleName, oppositeName] of [
    ['upperLeft', 'upperRight'],
    ['upperRight', 'upperLeft'],
    ['lowerLeft', 'lowerRight'],
    ['lowerRight', 'lowerLeft'],
  ]) {
    for (let channel = 0; channel < 3; channel += 1) {
      const expected = background.samples[sampleName][channel] * 0.28
        + background.samples[oppositeName][channel] * 0.72;
      expect(Math.abs(mirror.samples[sampleName][channel] - expected)).toBeLessThanOrEqual(4);
    }
  }
  const rainbowLuminances = Object.keys(blendSamples).map((name) => luminance(rainbow.samples[name]));
  expect(Math.max(...rainbowLuminances) - Math.min(...rainbowLuminances)).toBeGreaterThan(60);
  const rainbowDistances = Object.keys(blendSamples).map((name) => (
    colorDistance(rainbow.samples[name], background.samples[name])
  ));
  expect(Math.min(...rainbowDistances)).toBeGreaterThan(24);
  const rainbowChromas = Object.keys(blendSamples).map((name) => chroma(rainbow.samples[name]));
  expect(rainbowChromas.filter((value) => value > 18).length).toBeGreaterThanOrEqual(5);
  const rainbowHues = new Set(Object.keys(blendSamples).map((name) => hueSignature(rainbow.samples[name])));
  expect(rainbowHues.size).toBeGreaterThanOrEqual(3);

  const half = await page.evaluate(({ corners, samples }) => globalThis.rendererHarness.render(
    { corners, opacity: 0.5, mode: 'invert' },
    samples,
  ), { corners: FULL_QUAD, samples: blendSamples });
  for (const sampleName of Object.keys(blendSamples)) {
    for (let channel = 0; channel < 3; channel += 1) {
      const source = background.samples[sampleName][channel];
      const expected = source * 0.64 + (255 - source) * 0.36;
      expect(Math.abs(half.samples[sampleName][channel] - expected)).toBeLessThanOrEqual(3);
    }
  }
  expect(half.hash).not.toBe(background.hash);
  expect(half.hash).not.toBe(invert.hash);
  expect(errors).toEqual([]);
});

test('a skewed convex quad changes its polygon but not its bounding rectangle', async ({ page }) => {
  const errors = shaderFailures(page);
  await openHarness(page, { width: 320, height: 180, pixelRatio: 1 });
  const samplePoints = {
    polygonInterior: { x: 0.5, y: 0.5 },
    aboveSlopedEdge: { x: 0.24, y: 0.15 },
    rightOfSlopedEdge: { x: 0.78, y: 0.72 },
    outsideBounds: { x: 0.08, y: 0.08 },
  };
  const background = await page.evaluate((samples) => globalThis.rendererHarness.render({}, samples), samplePoints);
  const skewed = await page.evaluate(({ corners, samples }) => globalThis.rendererHarness.render(
    { corners, opacity: 1, mode: 'invert' },
    samples,
  ), { corners: SKEWED_QUAD, samples: samplePoints });
  expect(colorDistance(skewed.samples.polygonInterior, background.samples.polygonInterior))
    .toBeGreaterThan(80);
  expect(skewed.samples.aboveSlopedEdge).toEqual(background.samples.aboveSlopedEdge);
  expect(skewed.samples.rightOfSlopedEdge).toEqual(background.samples.rightOfSlopedEdge);
  expect(skewed.samples.outsideBounds).toEqual(background.samples.outsideBounds);
  expect(errors).toEqual([]);
});

test('crossed semantic points render two triangles with stronger overlap', async ({ page }) => {
  const errors = shaderFailures(page);
  await openHarness(page, { width: 640, height: 360, pixelRatio: 1 });
  const crossedCorners = [
    { x: 0.1, y: 0.45 },
    { x: 0.1, y: 0.1 },
    { x: 0.45, y: 0.45 },
    { x: 0.45, y: 0.1 },
  ];
  const samples = {
    firstOnly: { x: 0.17, y: 0.275 },
    overlap: { x: 0.275, y: 0.38 },
    secondOnly: { x: 0.38, y: 0.275 },
    outside: { x: 0.275, y: 0.17 },
  };
  const background = await page.evaluate(
    (points) => globalThis.rendererHarness.render({}, points),
    samples,
  );
  const crossed = await page.evaluate(({ corners, points }) => (
    globalThis.rendererHarness.render(
      { corners, opacity: 1, mode: 'invert' },
      points,
    )
  ), { corners: crossedCorners, points: samples });

  const firstStrength = normalizedInvertStrength(
    background.samples.firstOnly,
    crossed.samples.firstOnly,
  );
  const secondStrength = normalizedInvertStrength(
    background.samples.secondOnly,
    crossed.samples.secondOnly,
  );
  const overlapStrength = normalizedInvertStrength(
    background.samples.overlap,
    crossed.samples.overlap,
  );

  expect(firstStrength).toBeGreaterThan(0.62);
  expect(firstStrength).toBeLessThan(0.82);
  expect(secondStrength).toBeGreaterThan(0.62);
  expect(secondStrength).toBeLessThan(0.82);
  expect(overlapStrength).toBeGreaterThan(Math.max(firstStrength, secondStrength) + 0.12);
  expect(colorDistance(background.samples.outside, crossed.samples.outside)).toBeLessThanOrEqual(5);
  expect(errors).toEqual([]);
});

test('resize updates the drawing buffer at DPR and dispose removes the canvas', async ({ page }) => {
  const errors = shaderFailures(page);
  await openHarness(page, { width: 200, height: 100, pixelRatio: 2 });
  const resized = await page.evaluate(() => globalThis.rendererHarness.resize({ width: 123, height: 77 }));
  expect(resized).toEqual({ width: 246, height: 154 });
  const disposed = await page.evaluate(() => globalThis.rendererHarness.dispose());
  expect(disposed).toEqual({ attached: false, canvasCount: 0 });
  expect(errors).toEqual([]);
});
