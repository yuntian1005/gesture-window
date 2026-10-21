const PHASES = new Set([
  'ready',
  'loading',
  'camera-error',
  'tracking',
  'window',
  'fullscreen',
  'unsupported',
]);
const MODES = new Set(['invert', 'rainbow', 'mirror']);

function isNormalizedPoint(point) {
  return (
    Number.isFinite(point?.x)
    && Number.isFinite(point?.y)
    && point.x >= 0
    && point.x <= 1
    && point.y >= 0
    && point.y <= 1
  );
}

function subscribe(subscribers, handler, isDisposed) {
  if (typeof handler !== 'function' || isDisposed()) return () => {};
  subscribers.add(handler);
  let active = true;

  return () => {
    if (!active) return;
    active = false;
    subscribers.delete(handler);
  };
}

export function createUiController(root) {
  const startButton = root?.querySelector?.('#start-camera');
  const retryButton = root?.querySelector?.('#retry-camera');
  const status = root?.querySelector?.('#camera-status');
  const modeInputs = [...(root?.querySelectorAll?.('input[name="display-mode"]') ?? [])];
  const markers = [...(root?.querySelectorAll?.('[data-fingertip-marker]') ?? [])];

  if (!startButton || !retryButton || !status || modeInputs.length !== 3) {
    throw new TypeError('createUiController requires the complete application controls');
  }
  if (markers.length !== 4) {
    throw new TypeError('createUiController requires exactly four fingertip markers');
  }

  const subscribers = {
    start: new Set(),
    retry: new Set(),
    mode: new Set(),
  };
  let mode = modeInputs.find((input) => input.checked)?.value ?? 'invert';
  let lastPhase;
  let lastMessage;
  let disposed = false;

  function notify(type, value) {
    for (const handler of subscribers[type]) handler(value);
  }

  function handleStart() {
    notify('start');
  }

  function handleRetry() {
    notify('retry');
  }

  function applyMode(nextMode, shouldNotify = true) {
    if (!MODES.has(nextMode)) throw new TypeError(`Unsupported display mode: ${nextMode}`);
    const changed = mode !== nextMode;
    mode = nextMode;
    for (const input of modeInputs) input.checked = input.value === mode;
    if (changed && shouldNotify) notify('mode', mode);
  }

  function handleModeChange(event) {
    if (event.target?.checked) applyMode(event.target.value);
  }

  startButton.addEventListener('click', handleStart);
  retryButton.addEventListener('click', handleRetry);
  for (const input of modeInputs) input.addEventListener('change', handleModeChange);
  applyMode(MODES.has(mode) ? mode : 'invert', false);

  function clearFingertips() {
    for (const marker of markers) {
      marker.hidden = true;
      marker.dataset.pinching = 'false';
      marker.style.removeProperty('--marker-x');
      marker.style.removeProperty('--marker-y');
    }
  }

  clearFingertips();

  return {
    setPhase(phase, message = '') {
      if (!PHASES.has(phase)) throw new TypeError(`Unsupported application phase: ${phase}`);
      if (phase !== lastPhase) {
        root.dataset.appState = phase;
        startButton.hidden = phase !== 'ready';
        retryButton.hidden = phase !== 'camera-error';
        startButton.disabled = phase !== 'ready';
        retryButton.disabled = phase !== 'camera-error';
        for (const input of modeInputs) input.disabled = phase === 'loading';
        lastPhase = phase;
      }
      if (message !== lastMessage) {
        status.textContent = message;
        lastMessage = message;
      }
    },
    setMode(nextMode) {
      applyMode(nextMode);
    },
    getMode() {
      return mode;
    },
    setFingertips(hands) {
      let markerIndex = 0;
      for (const hand of Array.isArray(hands) ? hands.slice(0, 2) : []) {
        for (const point of [hand?.thumb, hand?.index]) {
          const marker = markers[markerIndex];
          markerIndex += 1;
          if (!isNormalizedPoint(point)) {
            marker.hidden = true;
            marker.dataset.pinching = 'false';
            marker.style.removeProperty('--marker-x');
            marker.style.removeProperty('--marker-y');
            continue;
          }
          marker.hidden = false;
          marker.dataset.pinching = String(hand?.pinching === true);
          marker.style.setProperty('--marker-x', `${point.x * 100}%`);
          marker.style.setProperty('--marker-y', `${point.y * 100}%`);
        }
      }
      for (; markerIndex < markers.length; markerIndex += 1) {
        const marker = markers[markerIndex];
        marker.hidden = true;
        marker.dataset.pinching = 'false';
        marker.style.removeProperty('--marker-x');
        marker.style.removeProperty('--marker-y');
      }
    },
    clearFingertips,
    onStart(handler) {
      return subscribe(subscribers.start, handler, () => disposed);
    },
    onRetry(handler) {
      return subscribe(subscribers.retry, handler, () => disposed);
    },
    onModeChange(handler) {
      return subscribe(subscribers.mode, handler, () => disposed);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      startButton.removeEventListener('click', handleStart);
      retryButton.removeEventListener('click', handleRetry);
      for (const input of modeInputs) input.removeEventListener('change', handleModeChange);
      for (const set of Object.values(subscribers)) set.clear();
      clearFingertips();
    },
  };
}
