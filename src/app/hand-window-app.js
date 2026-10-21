import { createCameraController } from '../camera/camera-controller.js';
import { projectHandsForCover } from '../gesture/cover-projection.js';
import { smoothPoints, trianglePairArea } from '../gesture/geometry.js';
import { orderSemanticHands } from '../gesture/semantic-hands.js';
import { createWindowState, updateWindowState } from '../gesture/window-state.js';
import { createUiController } from '../ui/ui-controller.js';

const INFERENCE_INTERVAL_MS = 1000 / 30;
const SMOOTHING_ALPHA = 0.32;
const START_MESSAGES = Object.freeze({
  ready: '准备就绪',
  loading: '正在加载',
  tracking: '等待双手',
});

export async function loadRuntimeModules() {
  const [trackingModule, rendererModule] = await Promise.all([
    import('../tracking/hand-tracker.js'),
    import('../render/effect-renderer.js'),
  ]);
  return {
    createHandTracker: trackingModule.createHandTracker,
    createEffectRenderer: rendererModule.createEffectRenderer,
  };
}

function startupError(error, stage) {
  if (stage === 'runtime') {
    return { phase: 'camera-error', message: '运行组件加载失败' };
  }
  if (stage === 'tracker') {
    return { phase: 'camera-error', message: '手势识别加载失败' };
  }
  if (stage === 'renderer' && error?.code === 'webgl-unavailable') {
    return { phase: 'unsupported', message: '当前浏览器不支持 WebGL' };
  }
  if (stage === 'camera' && error?.name === 'CameraError' && error.code === 'permission-denied') {
    return { phase: 'camera-error', message: '摄像头权限被拒绝' };
  }
  if (stage === 'camera' && error?.name === 'CameraError' && error.code === 'device-not-found') {
    return { phase: 'camera-error', message: '未找到摄像头' };
  }
  return { phase: 'camera-error', message: '无法启动摄像头' };
}

function statusFor(visibleHands, activeHands, phase) {
  if (visibleHands === 0) return '等待双手';
  if (visibleHands === 1) return '检测到一只手';
  if (activeHands !== 2) return '调整手势';
  return phase === 'fullscreen' ? '全屏效果' : '已连接';
}

function hasWindowFingertips(hand) {
  return [hand?.thumb, hand?.index].every(
    (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y),
  );
}

export function createHandWindowApp(options) {
  const {
    root,
    video,
    mount,
    createUiController: createUi = createUiController,
    createCameraController: createCamera = createCameraController,
    createHandTracker: createTrackerOverride,
    createEffectRenderer: createRendererOverride,
    loadRuntime: loadRuntime = loadRuntimeModules,
    requestAnimationFrame: requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
    cancelAnimationFrame: cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
    ResizeObserver: ResizeObserverApi = globalThis.ResizeObserver,
    window: windowObject = globalThis.window,
  } = options ?? {};

  const ui = createUi(root);
  const camera = createCamera(video);
  const reducedMotion = windowObject?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const unsubscribers = [];
  let generation = 0;
  let activeRun = null;
  let disposed = false;

  function cleanupRun(run) {
    if (!run || run.cleaned) return;
    run.cleaned = true;
    if (run.rafId !== null) cancelFrame?.(run.rafId);
    run.resizeObserver?.disconnect?.();
    if (run.resizeHandler) windowObject?.removeEventListener?.('resize', run.resizeHandler);
    try {
      run.tracker?.close?.();
    } catch {
      // Lifecycle cleanup continues through independent resources.
    }
    try {
      run.renderer?.dispose?.();
    } catch {
      // Lifecycle cleanup continues through independent resources.
    }
    if (activeRun === run) {
      activeRun = null;
      camera.stop();
    }
    ui.clearFingertips();
  }

  function failRun(run, error, stage) {
    if (disposed || activeRun !== run) {
      cleanupRun(run);
      return;
    }
    cleanupRun(run);
    const failure = startupError(error, stage);
    ui.setPhase(failure.phase, failure.message);
  }

  function failDetection(run) {
    cleanupRun(run);
    ui.setPhase('camera-error', '手势识别中断');
  }

  function updateGesture(run, hands) {
    run.visibleHands = hands.length;
    const semanticHands = orderSemanticHands(hands);
    const displayedHands = semanticHands.length === 2 ? semanticHands : hands;
    run.activeHands = semanticHands.reduce(
      (count, hand) => count + (hasWindowFingertips(hand) ? 1 : 0),
      0,
    );
    ui.setFingertips(displayedHands);

    if (run.visibleHands === 2 && run.activeHands === 2) {
      const semanticPoints = [
        semanticHands[0].thumb,
        semanticHands[0].index,
        semanticHands[1].index,
        semanticHands[1].thumb,
      ];
      if (trianglePairArea(semanticPoints) > 0) {
        run.corners = smoothPoints(run.corners, semanticPoints, SMOOTHING_ALPHA);
        run.area = trianglePairArea(run.corners);
      } else {
        run.corners = [];
        run.area = 0;
      }
    } else if (run.visibleHands >= 2) {
      run.corners = [];
      run.area = 0;
    }
  }

  function getProjectionDimensions() {
    return {
      sourceWidth: video?.videoWidth,
      sourceHeight: video?.videoHeight,
      targetWidth: mount?.clientWidth,
      targetHeight: mount?.clientHeight,
    };
  }

  function projectionKey(dimensions) {
    return [
      dimensions.sourceWidth,
      dimensions.sourceHeight,
      dimensions.targetWidth,
      dimensions.targetHeight,
    ].join(':');
  }

  function reprojectSourceHands(run) {
    const dimensions = getProjectionDimensions();
    const nextProjectionKey = projectionKey(dimensions);
    if (run.projectionKey !== nextProjectionKey) run.corners = [];
    run.projectionKey = nextProjectionKey;
    updateGesture(run, projectHandsForCover(run.sourceHands, dimensions));
  }

  function scheduleFrame(run) {
    run.rafId = requestFrame((timestamp) => {
      run.rafId = null;
      if (disposed || activeRun !== run || run.cleaned) return;
      if (!Number.isFinite(timestamp)) {
        scheduleFrame(run);
        return;
      }
      const now = Math.max(0, timestamp);
      if (now <= run.lastFrameAt) {
        scheduleFrame(run);
        return;
      }
      run.lastFrameAt = now;

      const dimensions = getProjectionDimensions();
      if (
        run.projectionKey !== null
        && run.projectionKey !== projectionKey(dimensions)
      ) {
        reprojectSourceHands(run);
      }

      if (now - run.lastInferenceAt >= INFERENCE_INTERVAL_MS) {
        run.lastInferenceAt = now;
        try {
          const detected = run.tracker.detect(video, now);
          run.detectFailures = 0;
          run.sourceHands = Array.isArray(detected) ? detected : [];
          reprojectSourceHands(run);
        } catch {
          run.detectFailures += 1;
          if (run.detectFailures >= 3) {
            failDetection(run);
            return;
          }
        }
      }

      run.state = updateWindowState(run.state, {
        visibleHands: run.visibleHands,
        activeHands: run.activeHands,
        area: run.area,
        now,
      });
      if (run.state.phase === 'idle' && run.visibleHands < 2 && !run.state.trackingLost) {
        run.corners = [];
        run.area = 0;
      }

      const appPhase = run.state.phase === 'idle' ? 'tracking' : run.state.phase;
      ui.setPhase(appPhase, statusFor(run.visibleHands, run.activeHands, run.state.phase));
      const fullscreenProgress = reducedMotion?.matches
        ? Number(run.state.phase === 'fullscreen')
        : run.state.fullscreenProgress;
      run.renderer.render({
        corners: run.corners,
        opacity: run.state.opacity,
        fullscreenProgress,
        mode: ui.getMode(),
        time: now / 1000,
      });
      scheduleFrame(run);
    });
  }

  function attachResize(run) {
    const resize = () => {
      if (disposed || activeRun !== run || run.cleaned) return;
      run.renderer?.resize?.();
      reprojectSourceHands(run);
    };
    if (typeof ResizeObserverApi === 'function') {
      run.resizeObserver = new ResizeObserverApi(resize);
      run.resizeObserver.observe(mount);
    } else {
      run.resizeHandler = resize;
      windowObject?.addEventListener?.('resize', resize);
    }
  }

  function resolveRuntimeFactories() {
    if (
      typeof createTrackerOverride === 'function'
      && typeof createRendererOverride === 'function'
    ) {
      return {
        createHandTracker: createTrackerOverride,
        createEffectRenderer: createRendererOverride,
      };
    }

    return Promise.resolve(loadRuntime()).then((runtime) => {
      const createHandTrackerFactory = createTrackerOverride ?? runtime?.createHandTracker;
      const createEffectRendererFactory = createRendererOverride ?? runtime?.createEffectRenderer;
      if (
        typeof createHandTrackerFactory !== 'function'
        || typeof createEffectRendererFactory !== 'function'
      ) {
        throw new TypeError('Runtime loader must provide tracker and renderer factories');
      }
      return {
        createHandTracker: createHandTrackerFactory,
        createEffectRenderer: createEffectRendererFactory,
      };
    });
  }

  async function start() {
    if (disposed) return;
    const operation = ++generation;
    cleanupRun(activeRun);
    const run = {
      generation: operation,
      renderer: null,
      tracker: null,
      resizeObserver: null,
      resizeHandler: null,
      rafId: null,
      state: createWindowState(),
      sourceHands: [],
      projectionKey: null,
      corners: [],
      area: 0,
      visibleHands: 0,
      activeHands: 0,
      lastInferenceAt: Number.NEGATIVE_INFINITY,
      lastFrameAt: Number.NEGATIVE_INFINITY,
      detectFailures: 0,
      cleaned: false,
    };
    activeRun = run;
    ui.setPhase('loading', START_MESSAGES.loading);
    let stage = 'runtime';

    try {
      const runtimeResult = resolveRuntimeFactories();
      const runtime = typeof runtimeResult?.then === 'function'
        ? await runtimeResult
        : runtimeResult;
      if (disposed || operation !== generation || activeRun !== run) {
        cleanupRun(run);
        return;
      }
      stage = 'renderer';
      run.renderer = runtime.createEffectRenderer({ mount, video });
      stage = 'camera';
      await camera.start();
      if (disposed || operation !== generation || activeRun !== run) {
        cleanupRun(run);
        return;
      }
      stage = 'tracker';
      const tracker = await runtime.createHandTracker();
      if (disposed || operation !== generation || activeRun !== run) {
        try {
          tracker?.close?.();
        } catch {
          // A stale tracker must not interfere with the current generation.
        }
        return;
      }
      run.tracker = tracker;
      attachResize(run);
      ui.setPhase('tracking', START_MESSAGES.tracking);
      scheduleFrame(run);
    } catch (error) {
      if (operation !== generation || disposed || activeRun !== run) {
        cleanupRun(run);
        return;
      }
      failRun(run, error, stage);
    }
  }

  function suspendActiveRun() {
    if (disposed) return;
    generation += 1;
    const run = activeRun;
    cleanupRun(run);
    if (!run) camera.stop();
    ui.setPhase('ready', START_MESSAGES.ready);
  }

  function handlePageHide(event) {
    if (event?.persisted) {
      suspendActiveRun();
    } else {
      dispose();
    }
  }

  function handlePageShow(event) {
    if (!disposed && event?.persisted) {
      ui.setPhase('ready', START_MESSAGES.ready);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    cleanupRun(activeRun);
    camera.stop();
    for (const unsubscribe of unsubscribers) unsubscribe();
    windowObject?.removeEventListener?.('pagehide', handlePageHide);
    windowObject?.removeEventListener?.('pageshow', handlePageShow);
    ui.dispose();
  }

  unsubscribers.push(ui.onStart(() => void start()));
  unsubscribers.push(ui.onRetry(() => void start()));
  windowObject?.addEventListener?.('pagehide', handlePageHide);
  windowObject?.addEventListener?.('pageshow', handlePageShow);
  ui.setPhase('ready', START_MESSAGES.ready);

  return { start, dispose };
}
