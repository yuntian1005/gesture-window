import { describe, expect, it, vi } from 'vitest';

import { createUiController } from './ui-controller.js';

class FakeElement {
  constructor({ value = '', checked = false } = {}) {
    this.value = value;
    this.checked = checked;
    this._hidden = false;
    this._disabled = false;
    this._textContent = '';
    this.hiddenWrites = 0;
    this.disabledWrites = 0;
    this.textWrites = 0;
    this.datasetWrites = {};
    this.dataset = new Proxy({}, {
      set: (target, name, nextValue) => {
        this.datasetWrites[name] = (this.datasetWrites[name] ?? 0) + 1;
        target[name] = nextValue;
        return true;
      },
    });
    this.style = {
      values: {},
      setProperty: vi.fn(function setProperty(name, value) {
        this.values[name] = value;
      }),
      removeProperty: vi.fn(function removeProperty(name) {
        delete this.values[name];
      }),
    };
    this.listeners = new Map();
  }

  get hidden() {
    return this._hidden;
  }

  set hidden(value) {
    this.hiddenWrites += 1;
    this._hidden = value;
  }

  get disabled() {
    return this._disabled;
  }

  set disabled(value) {
    this.disabledWrites += 1;
    this._disabled = value;
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this.textWrites += 1;
    this._textContent = value;
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatch(type) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ target: this, currentTarget: this });
    }
  }
}

function createFixture() {
  const start = new FakeElement();
  const retry = new FakeElement();
  const status = new FakeElement();
  const modes = ['invert', 'rainbow', 'mirror'].map(
    (value, index) => new FakeElement({ value, checked: index === 0 }),
  );
  const markers = Array.from({ length: 4 }, () => new FakeElement());
  const root = new FakeElement();
  const singles = new Map([
    ['#start-camera', start],
    ['#retry-camera', retry],
    ['#camera-status', status],
  ]);

  root.querySelector = vi.fn((selector) => singles.get(selector) ?? null);
  root.querySelectorAll = vi.fn((selector) => {
    if (selector === 'input[name="display-mode"]') return modes;
    if (selector === '[data-fingertip-marker]') return markers;
    return [];
  });

  return { root, start, retry, status, modes, markers };
}

describe('createUiController', () => {
  it('requires the complete reusable UI structure', () => {
    const fixture = createFixture();
    fixture.markers.pop();

    expect(() => createUiController(fixture.root)).toThrow(/four fingertip markers/i);
  });

  it.each([
    ['ready', '准备就绪', false, true, false],
    ['loading', '正在加载', true, true, true],
    ['camera-error', '摄像头权限被拒绝', true, false, true],
    ['tracking', '等待双手', true, true, true],
    ['window', '已连接', true, true, true],
    ['fullscreen', '全屏效果', true, true, true],
    ['unsupported', '当前浏览器不支持 WebGL', true, true, true],
  ])(
    'sets the %s DOM state and action availability',
    (phase, message, startHidden, retryHidden, startDisabled) => {
      const fixture = createFixture();
      const ui = createUiController(fixture.root);

      ui.setPhase(phase, message);

      expect(fixture.root.dataset.appState).toBe(phase);
      expect(fixture.status.textContent).toBe(message);
      expect(fixture.start.hidden).toBe(startHidden);
      expect(fixture.retry.hidden).toBe(retryHidden);
      expect(fixture.start.disabled).toBe(startDisabled);
      expect(fixture.retry.disabled).toBe(phase !== 'camera-error');
    },
  );

  it('rejects unknown phases without changing the current phase', () => {
    const fixture = createFixture();
    const ui = createUiController(fixture.root);
    ui.setPhase('tracking', '等待双手');

    expect(() => ui.setPhase('idle', 'bad')).toThrow(/phase/i);
    expect(fixture.root.dataset.appState).toBe('tracking');
  });

  it('does not rewrite unchanged phase state or reannounce unchanged status text', () => {
    const fixture = createFixture();
    const ui = createUiController(fixture.root);

    ui.setPhase('ready', '准备就绪');
    const firstWrites = {
      phase: fixture.root.datasetWrites.appState,
      status: fixture.status.textWrites,
      startHidden: fixture.start.hiddenWrites,
      startDisabled: fixture.start.disabledWrites,
      retryHidden: fixture.retry.hiddenWrites,
      retryDisabled: fixture.retry.disabledWrites,
      modesDisabled: fixture.modes.map((mode) => mode.disabledWrites),
    };

    ui.setPhase('ready', '准备就绪');
    expect({
      phase: fixture.root.datasetWrites.appState,
      status: fixture.status.textWrites,
      startHidden: fixture.start.hiddenWrites,
      startDisabled: fixture.start.disabledWrites,
      retryHidden: fixture.retry.hiddenWrites,
      retryDisabled: fixture.retry.disabledWrites,
      modesDisabled: fixture.modes.map((mode) => mode.disabledWrites),
    }).toEqual(firstWrites);

    ui.setPhase('ready', '仍在准备');
    expect(fixture.status.textWrites).toBe(firstWrites.status + 1);
    expect(fixture.root.datasetWrites.appState).toBe(firstWrites.phase);
    expect(fixture.start.hiddenWrites).toBe(firstWrites.startHidden);

    ui.setPhase('tracking', '仍在准备');
    expect(fixture.root.datasetWrites.appState).toBe(firstWrites.phase + 1);
    expect(fixture.start.hiddenWrites).toBe(firstWrites.startHidden + 1);
    expect(fixture.status.textWrites).toBe(firstWrites.status + 1);
  });

  it('stores renderer mode strings and notifies only for valid changed modes', () => {
    const fixture = createFixture();
    const ui = createUiController(fixture.root);
    const handler = vi.fn();
    ui.onModeChange(handler);

    ui.setMode('rainbow');
    fixture.modes[2].checked = true;
    fixture.modes[2].dispatch('change');
    fixture.modes[2].dispatch('change');

    expect(ui.getMode()).toBe('mirror');
    expect(fixture.modes.map((mode) => mode.checked)).toEqual([false, false, true]);
    expect(handler.mock.calls).toEqual([['rainbow'], ['mirror']]);
    expect(() => ui.setMode('sepia')).toThrow(/mode/i);
  });

  it('supports unsubscribe and dispose without duplicate action handlers', () => {
    const fixture = createFixture();
    const ui = createUiController(fixture.root);
    const start = vi.fn();
    const retry = vi.fn();
    const unsubscribeStart = ui.onStart(start);
    ui.onRetry(retry);

    fixture.start.dispatch('click');
    fixture.retry.dispatch('click');
    unsubscribeStart();
    unsubscribeStart();
    fixture.start.dispatch('click');
    ui.dispose();
    ui.dispose();
    fixture.retry.dispatch('click');

    expect(start).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('maps at most two mirrored hands to four transform-only markers', () => {
    const fixture = createFixture();
    const ui = createUiController(fixture.root);

    ui.setFingertips([
      { thumb: { x: 0.25, y: 0.4 }, index: { x: 0.5, y: 0.6 }, pinching: true },
      { thumb: { x: 0.1, y: 0.2 }, index: { x: 0.9, y: 0.8 }, pinching: false },
      { thumb: { x: 0, y: 0 }, index: { x: 1, y: 1 }, pinching: true },
    ]);

    expect(fixture.markers.map((marker) => marker.hidden)).toEqual([false, false, false, false]);
    expect(fixture.markers.map((marker) => marker.style.values)).toEqual([
      { '--marker-x': '25%', '--marker-y': '40%' },
      { '--marker-x': '50%', '--marker-y': '60%' },
      { '--marker-x': '10%', '--marker-y': '20%' },
      { '--marker-x': '90%', '--marker-y': '80%' },
    ]);
    expect(fixture.markers.map((marker) => marker.dataset.pinching)).toEqual([
      'true',
      'true',
      'false',
      'false',
    ]);
    expect(fixture.markers.every((marker) => !('top' in marker.style))).toBe(true);
    expect(fixture.markers.every((marker) => !('left' in marker.style))).toBe(true);
  });

  it('hides invalid fingertips and clearFingertips resets all markers', () => {
    const fixture = createFixture();
    const ui = createUiController(fixture.root);

    ui.setFingertips([
      { thumb: { x: Number.NaN, y: 0 }, index: { x: 0.5, y: 0.5 }, pinching: true },
      { thumb: { x: -0.1, y: 0.5 }, index: { x: 0.5, y: 1.1 }, pinching: true },
    ]);

    expect(fixture.markers.map((marker) => marker.hidden)).toEqual([true, false, true, true]);
    ui.clearFingertips();
    expect(fixture.markers.every((marker) => marker.hidden)).toBe(true);
    expect(fixture.markers.every((marker) => marker.dataset.pinching === 'false')).toBe(true);
  });
});
