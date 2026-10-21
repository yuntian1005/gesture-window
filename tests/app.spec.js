import { PNG } from 'playwright-core/lib/utilsBundle';

import { expect, isAllowedRequest, test } from './fixtures/playwright-test.js';

const TRACKER_CHUNK = /\/assets\/hand-tracker-[^/]+\.js$/;
const RENDERER_CHUNK = /\/assets\/effect-renderer-[^/]+\.js$/;
const WINDOW_HANDS = [
  { handedness: 'Left', thumb: { x: 0.275, y: 0.3 }, index: { x: 0.275, y: 0.7 }, wrist: { x: 0.3, y: 0.55 }, indexMcp: { x: 0.36, y: 0.55 }, pinching: false },
  { handedness: 'Right', thumb: { x: 0.725, y: 0.3 }, index: { x: 0.725, y: 0.7 }, wrist: { x: 0.7, y: 0.55 }, indexMcp: { x: 0.64, y: 0.55 }, pinching: false },
];
const CROSSED_HANDS = [
  { ...WINDOW_HANDS[0], thumb: WINDOW_HANDS[0].index, index: WINDOW_HANDS[0].thumb },
  WINDOW_HANDS[1],
];
const MOBILE_WINDOW_HANDS = [
  { handedness: 'Left', thumb: { x: 0.422, y: 0.3 }, index: { x: 0.422, y: 0.7 }, wrist: { x: 0.44, y: 0.55 }, indexMcp: { x: 0.46, y: 0.55 }, pinching: false },
  { handedness: 'Right', thumb: { x: 0.578, y: 0.3 }, index: { x: 0.578, y: 0.7 }, wrist: { x: 0.56, y: 0.55 }, indexMcp: { x: 0.54, y: 0.55 }, pinching: false },
];

function watchPageFailures(page) {
  const failures = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  return failures;
}

function runtimeRequests(requests) {
  return requests.filter((url) => TRACKER_CHUNK.test(url) || RENDERER_CHUNK.test(url));
}

async function waitForAnimationFrames(page, count = 2) {
  await page.evaluate((frameCount) => new Promise((resolve) => {
    function next(remaining) {
      if (remaining === 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => next(remaining - 1));
    }
    next(frameCount);
  }), count);
}

async function compositedOpacity(locator) {
  return locator.evaluate((element) => {
    let opacity = 1;
    for (let current = element; current; current = current.parentElement) {
      opacity *= Number.parseFloat(getComputedStyle(current).opacity);
    }
    return opacity;
  });
}

async function assertInsideViewport(locator, viewport) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  return box;
}

function overlaps(a, b) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function colorDistance(first, second) {
  return first.slice(0, 3).reduce((total, channel, index) => (
    total + Math.abs(channel - second[index])
  ), 0);
}

function normalizedInvertStrength(background, rendered) {
  const fullInvertDistance = background.slice(0, 3).reduce((total, channel) => (
    total + Math.abs(255 - 2 * channel)
  ), 0);
  return fullInvertDistance > 0
    ? colorDistance(background, rendered) / fullInvertDistance
    : 0;
}

function contrastRatio(foreground, background) {
  const luminance = (channels) => channels.slice(0, 3).reduce((total, channel, index) => {
    const normalized = channel / 255;
    const linear = normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
    return total + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function installSyntheticCamera(page) {
  await page.addInitScript(() => {
    globalThis.__mockHands = [];
    globalThis.__getUserMediaCalls = 0;
    globalThis.__patternPaused = false;
    globalThis.__paintingCancelled = false;
    globalThis.__paintFrames = 0;
    globalThis.__trackStops = 0;

    const source = document.createElement('canvas');
    source.width = 640;
    source.height = 360;
    const context = source.getContext('2d');
    let frame = 0;
    let paintRaf;

    function paint() {
      globalThis.__paintFrames += 1;
      if (!globalThis.__patternPaused) {
        const colors = ['#ef3340', '#35c759', '#246bfe', '#ffd23f'];
        context.fillStyle = colors[0];
        context.fillRect(0, 0, 320, 180);
        context.fillStyle = colors[1];
        context.fillRect(320, 0, 320, 180);
        context.fillStyle = colors[2];
        context.fillRect(0, 180, 320, 180);
        context.fillStyle = colors[3];
        context.fillRect(320, 180, 320, 180);

        const offset = frame % 40;
        for (let y = -40; y < source.height + 40; y += 40) {
          for (let x = -40; x < source.width + 40; x += 40) {
            if (((x + y) / 40) % 2 === 0) {
              context.fillStyle = 'rgba(255,255,255,0.24)';
              context.fillRect(x + offset, y, 20, 20);
            }
          }
        }
        frame += 3;
      }
      paintRaf = requestAnimationFrame(paint);
    }
    paint();

    const stream = source.captureStream(30);
    const track = stream.getVideoTracks()[0];
    const stopTrack = track.stop.bind(track);
    Object.defineProperty(track, 'stop', {
      configurable: true,
      value: () => {
        globalThis.__trackStops += 1;
        cancelAnimationFrame(paintRaf);
        globalThis.__paintingCancelled = true;
        stopTrack();
      },
    });
    globalThis.__cameraSource = source;
    globalThis.__syntheticTrack = track;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          globalThis.__getUserMediaCalls += 1;
          return stream;
        },
      },
    });
  });
}

async function canvasStats(canvas, samplePoints = {}) {
  const image = PNG.sync.read(await canvas.screenshot());
  let minimum = 255;
  let maximum = 0;
  let nonBlack = 0;
  let hash = 2166136261;
  const pixelStep = Math.max(1, Math.floor((image.width * image.height) / 5000));
  for (let pixel = 0; pixel < image.width * image.height; pixel += pixelStep) {
    const index = pixel * 4;
    const value = image.data[index] + image.data[index + 1] + image.data[index + 2];
    minimum = Math.min(minimum, image.data[index], image.data[index + 1], image.data[index + 2]);
    maximum = Math.max(maximum, image.data[index], image.data[index + 1], image.data[index + 2]);
    if (value > 12) nonBlack += 1;
  }
  for (const channel of image.data) hash = Math.imul(hash ^ channel, 16777619) >>> 0;
  const samples = Object.fromEntries(Object.entries(samplePoints).map(([name, point]) => {
    const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x * (image.width - 1))));
    const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y * (image.height - 1))));
    const index = (y * image.width + x) * 4;
    return [name, [...image.data.slice(index, index + 4)]];
  }));
  return { width: image.width, height: image.height, minimum, maximum, nonBlack, hash, samples };
}

test('offline policy allows only the configured preview origin', () => {
  const origin = 'http://127.0.0.1:4173';
  expect(isAllowedRequest(`${origin}/assets/app.js`, origin)).toBe(true);
  expect(isAllowedRequest('about:blank', origin)).toBe(true);
  expect(isAllowedRequest('data:text/plain,local', origin)).toBe(true);
  expect(isAllowedRequest('blob:http://127.0.0.1:4173/id', origin)).toBe(true);
  expect(isAllowedRequest('http://127.0.0.1:4174/probe', origin)).toBe(false);
  expect(isAllowedRequest('http://localhost:4173/probe', origin)).toBe(false);
  expect(isAllowedRequest('https://127.0.0.1:4173/probe', origin)).toBe(false);
});

test('serves MediaPipe WASM from the local application origin', async ({ page }) => {
  await page.goto('/');
  const asset = await page.evaluate(async () => {
    const response = await fetch('/mediapipe/wasm/vision_wasm_internal.wasm');
    return {
      bytes: (await response.arrayBuffer()).byteLength,
      contentType: response.headers.get('content-type'),
      status: response.status,
    };
  });

  expect(asset.status).toBe(200);
  expect(asset.contentType).toContain('application/wasm');
  expect(asset.bytes).toBeGreaterThan(1_000_000);
});

test('initial desktop renders controls without eagerly loading runtime chunks', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const failures = watchPageFailures(page);
  const requests = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));

  await page.goto('/');
  await expect(page.getByRole('button', { name: '开启摄像头' })).toBeVisible();
  await expect(page.getByRole('radio', { name: '反色' })).toBeVisible();
  await expect(page.getByRole('radio', { name: '彩虹' })).toBeVisible();
  await expect(page.getByRole('radio', { name: '镜像' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试' })).toBeHidden();
  const statusColors = await page.getByRole('status').evaluate((element) => {
    const parse = (value) => [...value.matchAll(/[\d.]+/g)].map(({ 0: number }) => Number(number));
    const style = getComputedStyle(element);
    return {
      background: parse(style.backgroundColor),
      foreground: parse(style.color),
      radius: Number.parseFloat(style.borderRadius),
    };
  });
  expect(statusColors.background[3] ?? 1).toBe(1);
  expect(Math.max(...statusColors.background.slice(0, 3))).toBeLessThan(32);
  expect(statusColors.radius).toBeLessThanOrEqual(6);
  expect(contrastRatio(statusColors.foreground, statusColors.background)).toBeGreaterThanOrEqual(4.5);
  await page.waitForLoadState('networkidle');
  await waitForAnimationFrames(page);

  expect(runtimeRequests(requests)).toEqual([]);
  expect(failures).toEqual([]);
  await page.screenshot({ path: 'output/playwright/initial-desktop.png' });
});

for (const viewport of [
  { width: 390, height: 844, screenshot: 'output/playwright/initial-mobile.png' },
  { width: 320, height: 240 },
]) {
  test(`initial controls fit and do not overlap at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');

    const boxes = [];
    boxes.push(await assertInsideViewport(page.getByRole('button', { name: '开启摄像头' }), viewport));
    boxes.push(await assertInsideViewport(page.locator('.segmented-control'), viewport));
    boxes.push(await assertInsideViewport(page.getByRole('status'), viewport));
    for (let first = 0; first < boxes.length; first += 1) {
      for (let second = first + 1; second < boxes.length; second += 1) {
        expect(overlaps(boxes[first], boxes[second])).toBe(false);
      }
    }

    const textFits = await page.locator('.segmented-control span, #start-camera, #camera-status')
      .evaluateAll((elements) => elements.every((element) => (
        element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
      )));
    expect(textFits).toBe(true);
    if (viewport.screenshot) await page.screenshot({ path: viewport.screenshot });
  });
}

test('permission denial reports the camera error and offers retry', async ({ page }) => {
  const failures = watchPageFailures(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '开启摄像头' }).click();

  await expect(page.getByRole('status')).toContainText('摄像头权限被拒绝');
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-app-state', 'camera-error');
  await expect(page.getByText('当前浏览器不支持 WebGL')).toHaveCount(0);
  expect(failures).toEqual([]);
});

test('synthetic camera and tracker drive the real app and WebGL renderer', async ({ page }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const failures = watchPageFailures(page);
  const requests = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.route('**/assets/hand-tracker-*.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `
      export async function createHandTracker() {
        globalThis.__trackerCreates = (globalThis.__trackerCreates ?? 0) + 1;
        return {
          detect() {
            const hands = globalThis.__mockHands ?? [];
            if (globalThis.__clearAfterNextDetect && hands.length === 2) {
              globalThis.__clearAfterNextDetect = false;
              queueMicrotask(() => globalThis.__beginMockHandLoss?.());
            }
            return hands;
          },
          close() { globalThis.__trackerCloses = (globalThis.__trackerCloses ?? 0) + 1; },
        };
      }
    `,
  }));
  await installSyntheticCamera(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(runtimeRequests(requests)).toEqual([]);

  await page.getByRole('button', { name: '开启摄像头' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-app-state', 'tracking');
  await expect(page.getByRole('status')).toContainText('等待双手');
  await expect.poll(() => ({
    renderer: requests.some((url) => RENDERER_CHUNK.test(url)),
    tracker: requests.some((url) => TRACKER_CHUNK.test(url)),
  })).toEqual({ renderer: true, tracker: true });
  await expect(page.locator('#camera-feed')).toHaveJSProperty('videoWidth', 640);
  await expect(page.locator('#camera-feed')).toHaveJSProperty('videoHeight', 360);

  const rendererCanvas = page.locator('#renderer canvas');
  await expect(rendererCanvas).toBeVisible();
  await page.evaluate(() => { globalThis.__patternPaused = true; });
  await waitForAnimationFrames(page, 3);
  const windowSamplePoints = {
    interior: { x: 0.5, y: 0.5 },
    exterior: { x: 0.1, y: 0.1 },
    firstOnly: { x: 0.35, y: 0.5 },
    overlap: { x: 0.5, y: 0.62 },
    secondOnly: { x: 0.65, y: 0.5 },
    crossedGap: { x: 0.5, y: 0.38 },
  };
  const baselineStats = await canvasStats(rendererCanvas, windowSamplePoints);

  await page.evaluate((hands) => { globalThis.__mockHands = hands; }, WINDOW_HANDS);
  await expect(page.locator('html')).toHaveAttribute('data-app-state', 'window');
  const markers = page.locator('[data-fingertip-marker]:visible');
  await expect(markers).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    await assertInsideViewport(markers.nth(index), { width: 1440, height: 900 });
  }
  let dimensions = await rendererCanvas.evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
  expect(dimensions.width).toBeGreaterThan(0);
  expect(dimensions.height).toBeGreaterThan(0);
  const windowStats = await canvasStats(rendererCanvas, windowSamplePoints);
  expect(windowStats.nonBlack).toBeGreaterThan(100);
  expect(windowStats.maximum - windowStats.minimum).toBeGreaterThan(40);
  expect(colorDistance(windowStats.samples.interior, baselineStats.samples.interior)).toBeGreaterThan(50);
  expect(colorDistance(windowStats.samples.exterior, baselineStats.samples.exterior)).toBeLessThanOrEqual(6);
  await page.screenshot({ path: 'output/playwright/window-effect.png' });

  await page.evaluate((hands) => { globalThis.__mockHands = hands; }, CROSSED_HANDS);
  await waitForAnimationFrames(page, 16);
  await expect(page.locator('html')).toHaveAttribute('data-app-state', 'window');
  await expect(markers).toHaveCount(4);
  const crossedStats = await canvasStats(rendererCanvas, windowSamplePoints);
  const firstStrength = normalizedInvertStrength(
    baselineStats.samples.firstOnly,
    crossedStats.samples.firstOnly,
  );
  const secondStrength = normalizedInvertStrength(
    baselineStats.samples.secondOnly,
    crossedStats.samples.secondOnly,
  );
  const overlapStrength = normalizedInvertStrength(
    baselineStats.samples.overlap,
    crossedStats.samples.overlap,
  );
  expect(overlapStrength).toBeGreaterThan(Math.max(firstStrength, secondStrength) + 0.08);
  expect(colorDistance(crossedStats.samples.crossedGap, baselineStats.samples.crossedGap))
    .toBeLessThanOrEqual(8);
  await page.screenshot({ path: 'output/playwright/triangle-overlap.png' });

  await page.evaluate(() => {
    const root = document.documentElement;
    globalThis.__beginMockHandLoss = () => {
      const clearedAt = performance.now();
      globalThis.__lossGraceProbe = new Promise((resolve) => {
        setTimeout(() => resolve({
          elapsed: performance.now() - clearedAt,
          phase: root.dataset.appState,
        }), 100);
      });
      globalThis.__lossAfterGraceProbe = new Promise((resolve) => {
        setTimeout(() => requestAnimationFrame(() => resolve({
          elapsed: performance.now() - clearedAt,
          phase: root.dataset.appState,
        })), 280);
      });
      globalThis.__mockHands = [];
    };
    globalThis.__clearAfterNextDetect = true;
  });
  await page.waitForFunction(() => Boolean(globalThis.__lossGraceProbe));
  const graceProbe = await page.evaluate(() => globalThis.__lossGraceProbe);
  expect(graceProbe.elapsed).toBeGreaterThanOrEqual(80);
  expect(graceProbe.phase).toBe('window');
  const afterGraceProbe = await page.evaluate(() => globalThis.__lossAfterGraceProbe);
  expect(afterGraceProbe.elapsed).toBeGreaterThan(250);
  await expect.poll(
    () => page.locator('html').getAttribute('data-app-state'),
    { intervals: [20, 40, 40], timeout: 600 },
  ).toBe('tracking');
  await page.evaluate((hands) => { globalThis.__mockHands = hands; }, WINDOW_HANDS);
  await expect(page.locator('html')).toHaveAttribute('data-app-state', 'window');

  await page.evaluate(() => {
    globalThis.__mockHands = [
      { handedness: 'Left', thumb: { x: 0.077, y: 0.05 }, index: { x: 0.077, y: 0.95 }, wrist: { x: 0.2, y: 0.5 }, indexMcp: { x: 0.26, y: 0.5 }, pinching: false },
      { handedness: 'Right', thumb: { x: 0.923, y: 0.05 }, index: { x: 0.923, y: 0.95 }, wrist: { x: 0.8, y: 0.5 }, indexMcp: { x: 0.74, y: 0.5 }, pinching: false },
    ];
  });
  await expect(page.locator('html')).toHaveAttribute('data-app-state', 'fullscreen');
  const modeControl = page.locator('.segmented-control');
  await expect.poll(() => compositedOpacity(modeControl))
    .toBeLessThan(0.3);
  const fullscreenStatus = page.getByRole('status');
  await expect.poll(() => compositedOpacity(fullscreenStatus)).toBeGreaterThan(0.99);
  const fullscreenStatusColors = await fullscreenStatus.evaluate((element) => {
    const parse = (value) => [...value.matchAll(/[\d.]+/g)].map(({ 0: number }) => Number(number));
    const style = getComputedStyle(element);
    return { background: parse(style.backgroundColor), foreground: parse(style.color) };
  });
  expect(contrastRatio(fullscreenStatusColors.foreground, fullscreenStatusColors.background))
    .toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: 'output/playwright/fullscreen-effect.png' });
  await page.getByRole('radio', { name: '彩虹' }).focus();
  await expect.poll(() => compositedOpacity(modeControl))
    .toBeGreaterThan(0.95);
  await page.screenshot({ path: 'output/playwright/fullscreen-effect-focused.png' });

  const modeStats = [];
  for (const mode of ['反色', '彩虹', '镜像']) {
    await page.locator('.segmented-control label').filter({ hasText: mode }).click();
    await expect(page.getByRole('radio', { name: mode })).toBeChecked();
    await waitForAnimationFrames(page, 2);
    modeStats.push(await canvasStats(rendererCanvas));
  }
  expect(new Set(modeStats.map(({ hash }) => hash)).size).toBe(3);
  for (const stats of modeStats) {
    expect(stats.nonBlack).toBeGreaterThan(100);
    expect(stats.maximum - stats.minimum).toBeGreaterThan(40);
  }
  expect(await page.evaluate(() => ({ camera: globalThis.__getUserMediaCalls, tracker: globalThis.__trackerCreates })))
    .toEqual({ camera: 1, tracker: 1 });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => rendererCanvas.evaluate((canvas) => `${canvas.width}x${canvas.height}`))
    .not.toBe(`${dimensions.width}x${dimensions.height}`);
  dimensions = await rendererCanvas.evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
  expect(dimensions.width).toBeGreaterThanOrEqual(390);
  expect(dimensions.height).toBeGreaterThanOrEqual(844);

  await page.evaluate((hands) => { globalThis.__mockHands = hands; }, MOBILE_WINDOW_HANDS);
  await expect(page.locator('html')).toHaveAttribute('data-app-state', 'window');
  await expect(markers).toHaveCount(4);
  const mobileViewport = { width: 390, height: 844 };
  const mobileUiBoxes = [
    await assertInsideViewport(page.locator('.segmented-control'), mobileViewport),
    await assertInsideViewport(page.getByRole('status'), mobileViewport),
  ];
  expect(overlaps(mobileUiBoxes[0], mobileUiBoxes[1])).toBe(false);
  const markerBoxes = [];
  for (let index = 0; index < 4; index += 1) {
    markerBoxes.push(await assertInsideViewport(markers.nth(index), mobileViewport));
  }
  for (let first = 0; first < markerBoxes.length; first += 1) {
    for (let second = first + 1; second < markerBoxes.length; second += 1) {
      expect(overlaps(markerBoxes[first], markerBoxes[second])).toBe(false);
    }
  }
  const mobileTextFits = await page.locator('.segmented-control span, #camera-status')
    .evaluateAll((elements) => elements.every((element) => (
      element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
    )));
  expect(mobileTextFits).toBe(true);
  await page.screenshot({ path: 'output/playwright/window-mobile.png' });

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  await expect.poll(() => page.evaluate(() => ({
    canvasCount: document.querySelectorAll('#renderer canvas').length,
    paintingCancelled: globalThis.__paintingCancelled,
    trackStops: globalThis.__trackStops,
    trackerCloses: globalThis.__trackerCloses,
    videoDetached: document.querySelector('#camera-feed').srcObject === null,
  }))).toEqual({
    canvasCount: 0,
    paintingCancelled: true,
    trackStops: 1,
    trackerCloses: 1,
    videoDetached: true,
  });
  const paintFrames = await page.evaluate(() => globalThis.__paintFrames);
  const paintFramesAfterTwoFrames = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return globalThis.__paintFrames;
  });
  expect(paintFramesAfterTwoFrames).toBe(paintFrames);
  expect(failures).toEqual([]);
});
