import { describe, expect, it, vi } from 'vitest';

import { createHandWindowApp } from './hand-window-app.js';

function createUi() {
  const handlers = {};
  const ui = {
    setPhase: vi.fn((phase) => {
      ui.retryVisible = phase === 'camera-error';
    }),
    setMode: vi.fn(),
    getMode: vi.fn(() => 'invert'),
    setFingertips: vi.fn(),
    clearFingertips: vi.fn(),
    onStart: vi.fn((handler) => {
      handlers.start = handler;
      return () => delete handlers.start;
    }),
    onRetry: vi.fn((handler) => {
      handlers.retry = handler;
      return () => delete handlers.retry;
    }),
    onModeChange: vi.fn(() => () => {}),
    dispose: vi.fn(),
    handlers,
    retryVisible: false,
  };
  return ui;
}

function createRaf() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    request: vi.fn((callback) => {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    }),
    cancel: vi.fn((id) => callbacks.delete(id)),
    step(now) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(now);
    },
    get size() {
      return callbacks.size;
    },
  };
}

function createWindow() {
  const listeners = new Map();
  return {
    addEventListener: vi.fn((type, handler) => listeners.set(type, handler)),
    removeEventListener: vi.fn((type, handler) => {
      if (listeners.get(type) === handler) listeners.delete(type);
    }),
    matchMedia: vi.fn(() => ({ matches: false })),
    dispatch(type, event = {}) {
      listeners.get(type)?.(event);
    },
  };
}

function hand({ handedness, pinching = true, thumb, index } = {}) {
  return {
    handedness,
    pinching,
    thumb: thumb ?? { x: 0.1, y: 0.1 },
    index: index ?? { x: 0.2, y: 0.2 },
  };
}

function createHarness(overrides = {}) {
  const ui = createUi();
  const camera = { start: vi.fn().mockResolvedValue({}), stop: vi.fn() };
  const tracker = { detect: vi.fn(() => []), close: vi.fn() };
  const renderer = { render: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
  const raf = createRaf();
  const windowObject = createWindow();
  const resizeInstances = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observe = vi.fn();
      this.disconnect = vi.fn();
      resizeInstances.push(this);
    }
  }
  const dependencies = {
    root: {},
    video: { videoWidth: 1280, videoHeight: 720 },
    mount: { clientWidth: 1280, clientHeight: 720 },
    createUiController: vi.fn(() => ui),
    createCameraController: vi.fn(() => camera),
    createHandTracker: vi.fn().mockResolvedValue(tracker),
    createEffectRenderer: vi.fn(() => renderer),
    requestAnimationFrame: raf.request,
    cancelAnimationFrame: raf.cancel,
    ResizeObserver: FakeResizeObserver,
    window: windowObject,
    ...overrides,
  };
  const app = createHandWindowApp(dependencies);
  return {
    app,
    dependencies,
    ui,
    camera,
    tracker,
    renderer,
    raf,
    windowObject,
    resizeInstances,
  };
}

describe('createHandWindowApp', () => {
  it('instantiates only UI and camera before the user starts', () => {
    const harness = createHarness();

    expect(harness.dependencies.createUiController).toHaveBeenCalledOnce();
    expect(harness.dependencies.createCameraController).toHaveBeenCalledWith(
      harness.dependencies.video,
    );
    expect(harness.dependencies.createEffectRenderer).not.toHaveBeenCalled();
    expect(harness.dependencies.createHandTracker).not.toHaveBeenCalled();
    expect(harness.camera.start).not.toHaveBeenCalled();
    expect(harness.ui.setPhase).toHaveBeenCalledWith('ready', '准备就绪');
  });

  it('does not load default runtime factories until Start', async () => {
    const tracker = { detect: vi.fn(() => []), close: vi.fn() };
    const renderer = { render: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    const createTracker = vi.fn().mockResolvedValue(tracker);
    const createRenderer = vi.fn(() => renderer);
    const loadRuntime = vi.fn().mockResolvedValue({
      createHandTracker: createTracker,
      createEffectRenderer: createRenderer,
    });
    const harness = createHarness({
      createHandTracker: undefined,
      createEffectRenderer: undefined,
      loadRuntime,
    });

    expect(loadRuntime).not.toHaveBeenCalled();
    expect(createRenderer).not.toHaveBeenCalled();
    expect(createTracker).not.toHaveBeenCalled();

    await harness.app.start();

    expect(loadRuntime).toHaveBeenCalledOnce();
    expect(createRenderer).toHaveBeenCalledWith({
      mount: harness.dependencies.mount,
      video: harness.dependencies.video,
    });
    expect(createTracker).toHaveBeenCalledOnce();
  });

  it('loads renderer, camera, and tracker before starting the frame loop', async () => {
    const harness = createHarness();

    await harness.app.start();

    expect(harness.ui.setPhase.mock.calls[1]).toEqual(['loading', '正在加载']);
    expect(harness.dependencies.createEffectRenderer).toHaveBeenCalledWith({
      mount: harness.dependencies.mount,
      video: harness.dependencies.video,
    });
    expect(harness.camera.start).toHaveBeenCalledOnce();
    expect(harness.dependencies.createHandTracker).toHaveBeenCalledOnce();
    expect(harness.ui.setPhase).toHaveBeenLastCalledWith('tracking', '等待双手');
    expect(harness.raf.size).toBe(1);
    expect(harness.resizeInstances[0].observe).toHaveBeenCalledWith(harness.dependencies.mount);
  });

  it.each([
    ['permission-denied', 'camera-error', '摄像头权限被拒绝'],
    ['device-not-found', 'camera-error', '未找到摄像头'],
    ['unavailable', 'camera-error', '无法启动摄像头'],
    ['webgl-unavailable', 'unsupported', '当前浏览器不支持 WebGL'],
  ])('maps %s startup failures and cleans partial resources', async (code, phase, message) => {
    const error = Object.assign(new Error(code), {
      code,
      name: code === 'webgl-unavailable' ? 'Error' : 'CameraError',
    });
    const renderer = { render: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    const harness = createHarness({
      createEffectRenderer: vi.fn(() => {
        if (code === 'webgl-unavailable') throw error;
        return renderer;
      }),
    });
    if (code !== 'webgl-unavailable') harness.camera.start.mockRejectedValue(error);

    await harness.app.start();

    expect(harness.camera.stop).toHaveBeenCalled();
    if (code !== 'webgl-unavailable') expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(harness.ui.clearFingertips).toHaveBeenCalled();
    expect(harness.ui.setPhase).toHaveBeenLastCalledWith(phase, message);
    expect(harness.raf.size).toBe(0);
  });

  it('stops the camera and renderer when tracker creation fails', async () => {
    const harness = createHarness({
      createHandTracker: vi.fn().mockRejectedValue(new Error('model load failed')),
    });

    await harness.app.start();

    expect(harness.camera.stop).toHaveBeenCalled();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(harness.ui.setPhase).toHaveBeenLastCalledWith(
      'camera-error',
      '手势识别加载失败',
    );
  });

  it('does not trust camera error codes on non-CameraError failures', async () => {
    const harness = createHarness();
    harness.camera.start.mockRejectedValue(
      Object.assign(new Error('not a camera error'), { code: 'permission-denied' }),
    );

    await harness.app.start();

    expect(harness.ui.setPhase).toHaveBeenLastCalledWith(
      'camera-error',
      '无法启动摄像头',
    );
  });

  it('reports runtime module loading failures as component loading errors', async () => {
    const harness = createHarness({
      createHandTracker: undefined,
      createEffectRenderer: undefined,
      loadRuntime: vi.fn().mockRejectedValue(new Error('chunk load failed')),
    });

    await harness.app.start();

    expect(harness.camera.start).not.toHaveBeenCalled();
    expect(harness.ui.setPhase).toHaveBeenLastCalledWith(
      'camera-error',
      '运行组件加载失败',
    );
  });

  it('supersedes an in-flight start without allowing stale failure UI', async () => {
    let rejectFirst;
    const firstCameraStart = new Promise((_, reject) => {
      rejectFirst = reject;
    });
    const harness = createHarness();
    harness.camera.start
      .mockReturnValueOnce(firstCameraStart)
      .mockResolvedValueOnce({});

    const first = harness.app.start();
    const second = harness.app.start();
    rejectFirst(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    await Promise.all([first, second]);

    expect(harness.dependencies.createHandTracker).toHaveBeenCalledOnce();
    expect(harness.ui.setPhase).toHaveBeenLastCalledWith('tracking', '等待双手');
    expect(harness.raf.size).toBe(1);
  });

  it('closes a tracker that resolves after its startup generation is superseded', async () => {
    let resolveFirstTracker;
    const firstTrackerPromise = new Promise((resolve) => {
      resolveFirstTracker = resolve;
    });
    const staleTracker = { detect: vi.fn(), close: vi.fn() };
    const currentTracker = { detect: vi.fn(() => []), close: vi.fn() };
    const createTracker = vi
      .fn()
      .mockReturnValueOnce(firstTrackerPromise)
      .mockResolvedValueOnce(currentTracker);
    const harness = createHarness({ createHandTracker: createTracker });

    const first = harness.app.start();
    await vi.waitFor(() => expect(createTracker).toHaveBeenCalledOnce());
    const second = harness.app.start();
    await second;
    resolveFirstTracker(staleTracker);
    await first;

    expect(staleTracker.close).toHaveBeenCalledOnce();
    expect(currentTracker.close).not.toHaveBeenCalled();
    expect(harness.raf.size).toBe(1);
  });

  it('renders every RAF, infers at no more than 30Hz, and applies mode on the next frame', async () => {
    const harness = createHarness();
    await harness.app.start();

    harness.raf.step(0);
    harness.raf.step(10);
    harness.ui.getMode.mockReturnValue('rainbow');
    harness.raf.step(34);

    expect(harness.tracker.detect).toHaveBeenCalledTimes(2);
    expect(harness.renderer.render).toHaveBeenCalledTimes(3);
    expect(harness.renderer.render.mock.calls[2][0]).toMatchObject({
      mode: 'rainbow',
      time: 0.034,
    });
  });

  it('retains the latest hand observation and corners between 30Hz inference ticks', async () => {
    const harness = createHarness();
    harness.tracker.detect.mockReturnValue([
      hand({ thumb: { x: 0.1, y: 0.1 }, index: { x: 0.1, y: 0.4 } }),
      hand({ thumb: { x: 0.4, y: 0.1 }, index: { x: 0.4, y: 0.4 } }),
    ]);
    await harness.app.start();

    harness.raf.step(100);
    const firstRender = harness.renderer.render.mock.calls[0][0];
    harness.raf.step(110);
    const retainedRender = harness.renderer.render.mock.calls[1][0];

    expect(harness.tracker.detect).toHaveBeenCalledOnce();
    expect(firstRender.corners).toHaveLength(4);
    expect(retainedRender.corners).toBe(firstRender.corners);
    expect(retainedRender).toMatchObject({ opacity: 1, fullscreenProgress: 0 });
    expect(harness.ui.setPhase).toHaveBeenLastCalledWith('window', '已连接');
  });

  it('aligns fingertip markers and corners with the renderer cover crop', async () => {
    const harness = createHarness({
      video: { videoWidth: 1600, videoHeight: 900 },
      mount: { clientWidth: 1200, clientHeight: 900 },
    });
    harness.tracker.detect.mockReturnValue([
      hand({ thumb: { x: 0.2, y: 0.2 }, index: { x: 0.2, y: 0.8 } }),
      hand({ thumb: { x: 0.8, y: 0.2 }, index: { x: 0.8, y: 0.8 } }),
    ]);
    await harness.app.start();

    harness.raf.step(100);

    const projectedHands = harness.ui.setFingertips.mock.calls.at(-1)[0];
    const corners = harness.renderer.render.mock.calls.at(-1)[0].corners;
    expect(projectedHands[0].thumb.x).toBeCloseTo(0.1);
    expect(projectedHands[1].index.x).toBeCloseTo(0.9);
    expect(corners).toEqual([
      projectedHands[0].thumb,
      projectedHands[0].index,
      projectedHands[1].index,
      projectedHands[1].thumb,
    ]);
  });

  it('does not count a hand whose thumb or index is outside the visible crop', async () => {
    const harness = createHarness({
      video: { videoWidth: 1600, videoHeight: 900 },
      mount: { clientWidth: 1200, clientHeight: 900 },
    });
    harness.tracker.detect.mockReturnValue([
      hand({ thumb: { x: 0.05, y: 0.4 }, index: { x: 0.2, y: 0.6 } }),
      hand({ thumb: { x: 0.3, y: 0.4 }, index: { x: 0.7, y: 0.6 } }),
    ]);
    await harness.app.start();

    harness.raf.step(100);

    expect(harness.ui.setFingertips).toHaveBeenLastCalledWith([
      expect.objectContaining({ pinching: true }),
    ]);
    expect(harness.ui.setPhase).toHaveBeenLastCalledWith('tracking', '检测到一只手');
    expect(harness.renderer.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ corners: [], opacity: 0 }),
    );
  });

  it('reprojects retained source landmarks when ResizeObserver reports new dimensions', async () => {
    const video = { videoWidth: 1600, videoHeight: 900 };
    const mount = { clientWidth: 1600, clientHeight: 900 };
    const harness = createHarness({ video, mount });
    harness.tracker.detect.mockReturnValue([
      hand({ thumb: { x: 0.2, y: 0.2 }, index: { x: 0.2, y: 0.8 } }),
      hand({ thumb: { x: 0.8, y: 0.2 }, index: { x: 0.8, y: 0.8 } }),
    ]);
    await harness.app.start();
    harness.raf.step(100);

    mount.clientWidth = 1200;
    harness.resizeInstances[0].callback();
    harness.raf.step(110);

    expect(harness.tracker.detect).toHaveBeenCalledOnce();
    const resizedHands = harness.ui.setFingertips.mock.calls.at(-1)[0];
    expect(resizedHands[0].thumb.x).toBeCloseTo(0.1);
    expect(resizedHands[1].thumb.x).toBeCloseTo(0.9);
    expect(harness.renderer.render.mock.calls.at(-1)[0].corners).toEqual([
      resizedHands[0].thumb,
      resizedHands[0].index,
      resizedHands[1].index,
      resizedHands[1].thumb,
    ]);
  });

  it('ignores equal or decreasing RAF timestamps and keeps tracker timestamps monotonic', async () => {
    const harness = createHarness();
    await harness.app.start();

    harness.raf.step(100);
    harness.raf.step(100);
    harness.raf.step(90);

    expect(harness.tracker.detect).toHaveBeenCalledTimes(1);
    expect(harness.renderer.render).toHaveBeenCalledTimes(1);

    harness.raf.step(134);

    expect(harness.tracker.detect.mock.calls.map((call) => call[1])).toEqual([100, 134]);
    expect(harness.renderer.render.mock.calls.map((call) => call[0].time)).toEqual([0.1, 0.134]);
  });

  it('keeps the four-point window active while thumb and index fingers are separated', async () => {
    const harness = createHarness();
    harness.tracker.detect.mockReturnValue([
      hand({ pinching: false, thumb: { x: 0.1, y: 0.1 }, index: { x: 0.1, y: 0.4 } }),
      hand({ pinching: false, thumb: { x: 0.4, y: 0.1 }, index: { x: 0.4, y: 0.4 } }),
    ]);
    await harness.app.start();

    harness.raf.step(0);

    expect(harness.ui.setPhase).toHaveBeenLastCalledWith('window', '已连接');
    expect(harness.renderer.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ corners: expect.any(Array), opacity: 1 }),
    );
    expect(harness.renderer.render.mock.calls[0][0].corners).toHaveLength(4);
  });

  it('preserves semantic fingertip order when tracker hand order reverses', async () => {
    const harness = createHarness();
    const left = hand({
      handedness: 'Left',
      pinching: false,
      thumb: { x: 0.8, y: 0.2 },
      index: { x: 0.2, y: 0.2 },
    });
    const right = hand({
      handedness: 'Right',
      pinching: false,
      thumb: { x: 0.8, y: 0.8 },
      index: { x: 0.2, y: 0.8 },
    });
    harness.tracker.detect.mockReturnValue([right, left]);
    await harness.app.start();

    harness.raf.step(0);

    expect(harness.renderer.render.mock.calls[0][0].corners).toEqual([
      left.thumb,
      left.index,
      right.index,
      right.thumb,
    ]);
  });

  it('updates fingertip, window, and fullscreen states without requiring a pinch', async () => {
    const harness = createHarness();
    const connected = [
      hand({ thumb: { x: 0.1, y: 0.1 }, index: { x: 0.1, y: 0.4 } }),
      hand({ thumb: { x: 0.4, y: 0.1 }, index: { x: 0.4, y: 0.4 } }),
    ];
    const fullscreen = [
      hand({ thumb: { x: 0.01, y: 0.01 }, index: { x: 0.01, y: 0.99 } }),
      hand({ thumb: { x: 0.99, y: 0.01 }, index: { x: 0.99, y: 0.99 } }),
    ];
    const separated = fullscreen.map((value) => ({ ...value, pinching: false }));
    harness.tracker.detect
      .mockReturnValueOnce(connected)
      .mockReturnValueOnce(fullscreen)
      .mockReturnValueOnce(fullscreen)
      .mockReturnValueOnce(fullscreen)
      .mockReturnValueOnce(fullscreen)
      .mockReturnValueOnce(fullscreen)
      .mockReturnValueOnce(separated);
    await harness.app.start();

    harness.raf.step(0);
    harness.raf.step(34);
    harness.raf.step(68);
    harness.raf.step(102);
    harness.raf.step(136);
    harness.raf.step(170);
    harness.raf.step(204);

    expect(harness.ui.setFingertips).toHaveBeenCalledTimes(7);
    expect(harness.ui.setPhase).toHaveBeenCalledWith('window', '已连接');
    expect(harness.ui.setPhase).toHaveBeenCalledWith('fullscreen', '全屏效果');
    expect(harness.ui.setPhase).toHaveBeenLastCalledWith('fullscreen', '全屏效果');
    expect(harness.renderer.render.mock.calls[6][0]).toMatchObject({ opacity: 1 });
    expect(harness.renderer.render.mock.calls[6][0].corners).toHaveLength(4);
  });

  it('keeps stable corners during genuine tracking-loss grace and clears after expiry', async () => {
    const harness = createHarness();
    harness.tracker.detect
      .mockReturnValueOnce([
        hand({ thumb: { x: 0.1, y: 0.1 }, index: { x: 0.1, y: 0.4 } }),
        hand({ thumb: { x: 0.4, y: 0.1 }, index: { x: 0.4, y: 0.4 } }),
      ])
      .mockReturnValue([]);
    await harness.app.start();

    harness.raf.step(100);
    const stableCorners = harness.renderer.render.mock.calls[0][0].corners;
    harness.raf.step(134);
    harness.raf.step(300);
    harness.raf.step(385);

    expect(harness.renderer.render.mock.calls[1][0].corners).toBe(stableCorners);
    expect(harness.renderer.render.mock.calls[2][0].corners).toBe(stableCorners);
    expect(harness.renderer.render.mock.calls[3][0].corners).toEqual([]);
  });

  it('makes fullscreen renderer progress immediate under reduced motion', async () => {
    const windowObject = createWindow();
    windowObject.matchMedia.mockReturnValue({ matches: true });
    const harness = createHarness({ window: windowObject });
    harness.tracker.detect.mockReturnValue([
      hand({ thumb: { x: 0.01, y: 0.01 }, index: { x: 0.01, y: 0.99 } }),
      hand({ thumb: { x: 0.99, y: 0.01 }, index: { x: 0.99, y: 0.99 } }),
    ]);
    await harness.app.start();

    harness.raf.step(100);

    expect(harness.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ fullscreenProgress: 1 }),
    );
    expect(harness.tracker.detect).toHaveBeenCalledOnce();
  });

  it('tolerates two detect errors then cleans up and offers retry on the third', async () => {
    const harness = createHarness();
    harness.tracker.detect.mockImplementation(() => {
      throw new Error('transient detect failure');
    });
    await harness.app.start();

    harness.raf.step(0);
    harness.raf.step(34);
    harness.raf.step(68);

    expect(harness.tracker.close).toHaveBeenCalledOnce();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(harness.camera.stop).toHaveBeenCalled();
    expect(harness.ui.setPhase).toHaveBeenLastCalledWith('camera-error', '手势识别中断');
    expect(harness.raf.size).toBe(0);
  });

  it('always treats the third detect exception as retryable even with a WebGL error code', async () => {
    const harness = createHarness();
    harness.tracker.detect.mockImplementation(() => {
      throw Object.assign(new Error('runtime inference failed'), {
        code: 'webgl-unavailable',
      });
    });
    await harness.app.start();

    harness.raf.step(0);
    harness.raf.step(34);
    harness.raf.step(68);

    expect(harness.ui.setPhase).toHaveBeenLastCalledWith(
      'camera-error',
      '手势识别中断',
    );
    expect(harness.ui.setPhase).not.toHaveBeenCalledWith(
      'unsupported',
      '当前浏览器不支持 WebGL',
    );
    expect(harness.ui.retryVisible).toBe(true);
    expect(harness.tracker.close).toHaveBeenCalledOnce();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(harness.raf.size).toBe(0);
  });

  it('uses resize fallback, pagehide cleanup, and idempotent public disposal', async () => {
    const harness = createHarness({ ResizeObserver: undefined });
    await harness.app.start();
    expect(harness.windowObject.addEventListener).toHaveBeenCalledWith(
      'resize',
      expect.any(Function),
    );

    harness.windowObject.dispatch('resize');
    expect(harness.renderer.resize).toHaveBeenCalledOnce();
    harness.windowObject.dispatch('pagehide');
    harness.app.dispose();

    expect(harness.ui.dispose).toHaveBeenCalledOnce();
    expect(harness.tracker.close).toHaveBeenCalledOnce();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(harness.windowObject.removeEventListener).toHaveBeenCalledWith(
      'pagehide',
      expect.any(Function),
    );
    expect(harness.raf.size).toBe(0);
  });

  it('suspends on persisted pagehide and restarts after persisted pageshow', async () => {
    const harness = createHarness();
    await harness.app.start();
    harness.raf.step(100);

    harness.windowObject.dispatch('pagehide', { persisted: true });

    expect(harness.tracker.close).toHaveBeenCalledOnce();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(harness.camera.stop).toHaveBeenCalled();
    expect(harness.resizeInstances[0].disconnect).toHaveBeenCalledOnce();
    expect(harness.ui.clearFingertips).toHaveBeenCalled();
    expect(harness.ui.dispose).not.toHaveBeenCalled();
    expect(harness.ui.setPhase).toHaveBeenLastCalledWith('ready', '准备就绪');
    expect(harness.ui.onStart).toHaveBeenCalledOnce();
    expect(harness.raf.size).toBe(0);

    harness.windowObject.dispatch('pageshow', { persisted: true });
    harness.ui.handlers.start();
    await vi.waitFor(() => expect(harness.raf.size).toBe(1));

    expect(harness.camera.start).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.createHandTracker).toHaveBeenCalledTimes(2);
    expect(harness.ui.onStart).toHaveBeenCalledOnce();
    expect(harness.ui.onRetry).toHaveBeenCalledOnce();
  });

  it('invalidates a pending runtime load when entering the bfcache', async () => {
    let resolveRuntime;
    const runtimePromise = new Promise((resolve) => {
      resolveRuntime = resolve;
    });
    const createTracker = vi.fn().mockResolvedValue({ detect: vi.fn(), close: vi.fn() });
    const createRenderer = vi.fn(() => ({ render: vi.fn(), resize: vi.fn(), dispose: vi.fn() }));
    const harness = createHarness({
      createHandTracker: undefined,
      createEffectRenderer: undefined,
      loadRuntime: vi.fn(() => runtimePromise),
    });

    const pendingStart = harness.app.start();
    harness.windowObject.dispatch('pagehide', { persisted: true });
    resolveRuntime({
      createHandTracker: createTracker,
      createEffectRenderer: createRenderer,
    });
    await pendingStart;

    expect(createRenderer).not.toHaveBeenCalled();
    expect(createTracker).not.toHaveBeenCalled();
    expect(harness.camera.start).not.toHaveBeenCalled();
    expect(harness.ui.setPhase).toHaveBeenLastCalledWith('ready', '准备就绪');
    expect(harness.ui.dispose).not.toHaveBeenCalled();
  });

  it('replaces ResizeObserver when a successful run is restarted', async () => {
    const harness = createHarness();
    await harness.app.start();
    const firstObserver = harness.resizeInstances[0];

    await harness.app.start();

    expect(harness.resizeInstances).toHaveLength(2);
    expect(firstObserver.disconnect).toHaveBeenCalledOnce();
    expect(harness.resizeInstances[1].observe).toHaveBeenCalledWith(
      harness.dependencies.mount,
    );
    expect(harness.raf.size).toBe(1);

    harness.ui.setFingertips.mockClear();
    firstObserver.callback();
    expect(harness.ui.setFingertips).not.toHaveBeenCalled();
  });
});
