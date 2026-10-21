import { describe, expect, it, vi } from 'vitest';
import * as RealThree from 'three';

import {
  EFFECT_MODES,
  TRIANGLE_OPACITY,
  cornersToClipPositions,
  cornersToScreenUvs,
  createEffectRenderer,
  interpolateCorners,
  normalizeMode,
  writeInterpolatedGeometry,
} from './effect-renderer.js';

const CORNERS = [
  { x: 0.2, y: 0.3 },
  { x: 0.7, y: 0.25 },
  { x: 0.8, y: 0.9 },
  { x: 0.1, y: 0.8 },
];

describe('effect renderer helpers', () => {
  it('exports the per-triangle blend opacity', () => {
    expect(TRIANGLE_OPACITY).toBe(0.72);
  });

  it('exports a frozen stable mode map', () => {
    expect(EFFECT_MODES).toEqual({ invert: 0, rainbow: 1, mirror: 2 });
    expect(Object.isFrozen(EFFECT_MODES)).toBe(true);
  });

  it.each([
    ['invert', 0],
    ['rainbow', 1],
    ['mirror', 2],
    [0, 0],
    [1, 1],
    [2, 2],
    ['unknown', 0],
    [3, 0],
    [Number.NaN, 0],
    [null, 0],
  ])('normalizes mode %j to %i', (mode, expected) => {
    expect(normalizeMode(mode)).toBe(expected);
  });

  it('interpolates corners without mutating the input', () => {
    const original = structuredClone(CORNERS);

    expect(interpolateCorners(CORNERS, 0.5)).toEqual([
      { x: 0.1, y: 0.15 },
      { x: 0.85, y: 0.125 },
      { x: 0.9, y: 0.95 },
      { x: 0.05, y: 0.9 },
    ]);
    expect(CORNERS).toEqual(original);
  });

  it('clamps fullscreen progress and reaches normalized fullscreen targets', () => {
    expect(interpolateCorners(CORNERS, -1)).toEqual(CORNERS);
    expect(interpolateCorners(CORNERS, 2)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
    expect(interpolateCorners(CORNERS, Number.NaN)).toEqual(CORNERS);
  });

  it.each([
    undefined,
    null,
    [],
    CORNERS.slice(0, 3),
    [...CORNERS, { x: 0, y: 0 }],
    [...CORNERS.slice(0, 3), { x: Number.NaN, y: 0 }],
    [...CORNERS.slice(0, 3), { x: 0, y: Number.POSITIVE_INFINITY }],
    [...CORNERS.slice(0, 3), null],
  ])('rejects malformed corners without throwing', (corners) => {
    expect(interpolateCorners(corners, 0.5)).toEqual([]);
  });

  it('converts normalized corners to clip-space positions in TL/TR/BR/BL order', () => {
    expect(cornersToClipPositions(CORNERS)).toEqual(new Float32Array([
      -0.6, 0.4, 0,
      0.4, 0.5, 0,
      0.6, -0.8, 0,
      -0.8, -0.6, 0,
    ]));
    expect(cornersToClipPositions(CORNERS)).toBeInstanceOf(Float32Array);
  });

  it('converts normalized corners to bottom-origin screen UVs', () => {
    expect(cornersToScreenUvs(CORNERS)).toEqual(new Float32Array([
      0.2, 0.7,
      0.7, 0.75,
      0.8, 0.1,
      0.1, 0.2,
    ]));
    expect(cornersToScreenUvs(CORNERS)).toBeInstanceOf(Float32Array);
  });

  it('returns empty typed arrays for invalid conversion input', () => {
    expect(cornersToClipPositions([])).toEqual(new Float32Array());
    expect(cornersToScreenUvs([{ x: 0, y: 0 }])).toEqual(new Float32Array());
  });

  it('writes interpolated positions and UVs directly into supplied targets', () => {
    const positions = new Float32Array(12);
    const uvs = new Float32Array(8);

    expect(writeInterpolatedGeometry(CORNERS, 0.5, positions, uvs)).toBe(true);
    expect(positions).toEqual(new Float32Array([
      -0.8, 0.7, 0,
      0.7, 0.75, 0,
      0.8, -0.9, 0,
      -0.9, -0.8, 0,
    ]));
    expect(uvs).toEqual(new Float32Array([
      0.1, 0.85,
      0.85, 0.875,
      0.9, 0.05,
      0.05, 0.1,
    ]));
  });

  it('rejects invalid direct writes without changing supplied targets', () => {
    const positions = new Float32Array(12).fill(7);
    const uvs = new Float32Array(8).fill(9);

    expect(writeInterpolatedGeometry(CORNERS.slice(0, 3), 0.5, positions, uvs)).toBe(false);
    expect(positions.every((value) => value === 7)).toBe(true);
    expect(uvs.every((value) => value === 9)).toBe(true);
  });

  it('writes through the actual arrays owned by real Three buffer attributes', () => {
    const copiedSource = new Float32Array(12);
    const copiedAttribute = new RealThree.Float32BufferAttribute(copiedSource, 3);
    const positionAttribute = new RealThree.Float32BufferAttribute(12, 3);
    const uvAttribute = new RealThree.Float32BufferAttribute(8, 2);

    expect(copiedAttribute.array).not.toBe(copiedSource);
    expect(positionAttribute.array).toBeInstanceOf(Float32Array);
    expect(uvAttribute.array).toBeInstanceOf(Float32Array);
    expect(writeInterpolatedGeometry(
      CORNERS,
      1,
      positionAttribute.array,
      uvAttribute.array,
    )).toBe(true);
    expect(positionAttribute.array).toEqual(new Float32Array([
      -1, 1, 0,
      1, 1, 0,
      1, -1, 0,
      -1, -1, 0,
    ]));
    expect(uvAttribute.array).toEqual(new Float32Array([
      0, 1,
      1, 1,
      1, 0,
      0, 0,
    ]));
  });
});

function createFakeThree({
  rendererThrows,
  setupThrows,
  videoTextureThrows,
  planeGeometryThrows,
  bufferGeometryThrowsAt,
  bufferGeometryThrows,
  shaderMaterialThrowsAt,
  shaderMaterialThrows,
  setSizeThrows,
  rendererDisposeThrows,
} = {}) {
  const instances = {
    renderers: [],
    scenes: [],
    textures: [],
    bufferGeometries: [],
    planeGeometries: [],
    shaderMaterials: [],
    lineMaterials: [],
  };

  class WebGLRenderer {
    constructor(options) {
      if (rendererThrows) throw rendererThrows;
      this.options = options;
      this.domElement = {
        style: {},
        parentNode: null,
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      };
      this.operations = [];
      this.setPixelRatio = vi.fn((value) => {
        this.operations.push(['pixelRatio', value]);
        if (setupThrows) throw setupThrows;
      });
      this.setSize = vi.fn((width, height, updateStyle) => {
        this.operations.push(['size', width, height, updateStyle]);
        if (setSizeThrows) throw setSizeThrows;
      });
      this.render = vi.fn();
      this.dispose = vi.fn(() => {
        if (rendererDisposeThrows) throw rendererDisposeThrows;
      });
      instances.renderers.push(this);
    }
  }

  class Scene {
    constructor() {
      this.children = [];
      instances.scenes.push(this);
    }

    add(...objects) {
      this.children.push(...objects);
    }
  }

  class OrthographicCamera {
    constructor(...args) {
      this.args = args;
    }
  }

  class VideoTexture {
    constructor(video) {
      if (videoTextureThrows) throw videoTextureThrows;
      this.video = video;
      this.dispose = vi.fn();
      instances.textures.push(this);
    }
  }

  let bufferGeometryCount = 0;

  class Float32BufferAttribute {
    constructor(array, itemSize) {
      this.array = new Float32Array(array);
      this.itemSize = itemSize;
      this.needsUpdate = false;
    }
  }

  class BufferGeometry {
    constructor() {
      bufferGeometryCount += 1;
      if (bufferGeometryThrowsAt === bufferGeometryCount) {
        throw bufferGeometryThrows ?? new Error(`buffer geometry ${bufferGeometryCount} failed`);
      }
      this.attributes = {};
      this.index = null;
      this.dispose = vi.fn();
      instances.bufferGeometries.push(this);
    }

    setAttribute(name, attribute) {
      this.attributes[name] = attribute;
      return this;
    }

    setIndex(index) {
      this.index = index;
      return this;
    }
  }

  class PlaneGeometry {
    constructor(...args) {
      if (planeGeometryThrows) throw planeGeometryThrows;
      this.args = args;
      this.dispose = vi.fn();
      instances.planeGeometries.push(this);
    }
  }

  let shaderMaterialCount = 0;

  class ShaderMaterial {
    constructor(options) {
      shaderMaterialCount += 1;
      if (shaderMaterialThrowsAt === shaderMaterialCount) {
        throw shaderMaterialThrows ?? new Error(`shader material ${shaderMaterialCount} failed`);
      }
      Object.assign(this, options);
      this.dispose = vi.fn();
      instances.shaderMaterials.push(this);
    }
  }

  class LineBasicMaterial {
    constructor(options) {
      Object.assign(this, options);
      this.dispose = vi.fn();
      instances.lineMaterials.push(this);
    }
  }

  class Mesh {
    constructor(geometry, material) {
      this.geometry = geometry;
      this.material = material;
      this.visible = true;
    }
  }

  class LineLoop extends Mesh {}

  class Vector2 {
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }

    set(x, y) {
      this.x = x;
      this.y = y;
      return this;
    }
  }

  return {
    api: {
      WebGLRenderer,
      Scene,
      OrthographicCamera,
      VideoTexture,
      Float32BufferAttribute,
      BufferGeometry,
      PlaneGeometry,
      ShaderMaterial,
      LineBasicMaterial,
      Mesh,
      LineLoop,
      Vector2,
      LinearFilter: 'LinearFilter',
      ClampToEdgeWrapping: 'ClampToEdgeWrapping',
      NoColorSpace: 'NoColorSpace',
      SRGBColorSpace: 'SRGBColorSpace',
    },
    instances,
  };
}

function createVideo(videoWidth = 1280, videoHeight = 720, currentTime = 0) {
  return { videoWidth, videoHeight, currentTime };
}

function createMount(width = 640, height = 360, { appendThrows, removeThrows } = {}) {
  return {
    clientWidth: width,
    clientHeight: height,
    children: [],
    appendChild: vi.fn(function appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      if (appendThrows) throw appendThrows;
    }),
    removeChild: vi.fn(function removeChild(child) {
      if (removeThrows) throw removeThrows;
      this.children = this.children.filter((candidate) => candidate !== child);
      child.parentNode = null;
    }),
  };
}

function expectCreatedResourcesDisposed(instances) {
  const resources = [
    ...instances.textures,
    ...instances.bufferGeometries,
    ...instances.planeGeometries,
    ...instances.shaderMaterials,
    ...instances.lineMaterials,
    ...instances.renderers,
  ];
  for (const resource of resources) {
    expect(resource.dispose).toHaveBeenCalledOnce();
  }
}

function createRenderer(options = {}) {
  const fake = createFakeThree(options.threeOptions);
  const mount = options.mount ?? createMount();
  const video = options.video ?? createVideo();
  const rendererOptions = {
    mount,
    video,
    three: fake.api,
  };
  if (Object.hasOwn(options, 'pixelRatio')) {
    rendererOptions.pixelRatio = options.pixelRatio;
  }
  const effectRenderer = createEffectRenderer(rendererOptions);
  return { ...fake, mount, video, effectRenderer };
}

describe('createEffectRenderer', () => {
  it.each([
    [createVideo(1, 1), null],
    [createMount(), null],
    [null, createVideo(1, 1)],
  ])('validates mount and video prerequisites', (mount, video) => {
    const { api } = createFakeThree();
    expect(() => createEffectRenderer({ mount, video, three: api })).toThrow(TypeError);
  });

  it.each([
    [{}, 'missing properties'],
    [{ videoWidth: 0, videoHeight: 0 }, 'missing currentTime'],
    [{ videoWidth: Number.NaN, videoHeight: 0, currentTime: 0 }, 'NaN width'],
    [{ videoWidth: 0, videoHeight: Infinity, currentTime: 0 }, 'infinite height'],
    [{ videoWidth: 0, videoHeight: 0, currentTime: Number.NaN }, 'NaN currentTime'],
    [{ videoWidth: -1, videoHeight: 0, currentTime: 0 }, 'negative width'],
  ])('rejects video input with %s before constructing WebGL', (video) => {
    const { api, instances } = createFakeThree();

    expect(() => createEffectRenderer({ mount: createMount(), video, three: api })).toThrow(TypeError);
    expect(instances.renderers).toHaveLength(0);
  });

  it('accepts a not-ready video with zero dimensions', () => {
    const { effectRenderer } = createRenderer({ video: createVideo(0, 0) });
    expect(effectRenderer.canvas).toBeDefined();
    effectRenderer.dispose();
  });

  it.each(['constructor', 'setup'])('maps WebGL %s failures to a stable error code', (stage) => {
    const cause = new Error(`${stage} failed`);
    const { api } = createFakeThree({
      rendererThrows: stage === 'constructor' ? cause : undefined,
      setupThrows: stage === 'setup' ? cause : undefined,
    });

    expect(() => createEffectRenderer({
      mount: createMount(),
      video: createVideo(),
      three: api,
    })).toThrow(expect.objectContaining({ code: 'webgl-unavailable', cause }));
  });

  it.each([
    ['video texture', (cause) => ({ videoTextureThrows: cause })],
    ['plane geometry', (cause) => ({ planeGeometryThrows: cause })],
    ['buffer geometry', (cause) => ({ bufferGeometryThrowsAt: 1, bufferGeometryThrows: cause })],
    ['shader material', (cause) => ({ shaderMaterialThrowsAt: 1, shaderMaterialThrows: cause })],
  ])('transactionally cleans up a %s setup failure', (_stage, getOptions) => {
    const cause = new Error(`${_stage} failed`);
    const fake = createFakeThree(getOptions(cause));
    const mount = createMount();

    expect(() => createEffectRenderer({
      mount,
      video: createVideo(),
      three: fake.api,
    })).toThrow(expect.objectContaining({
      code: 'webgl-unavailable',
      cause,
    }));
    expectCreatedResourcesDisposed(fake.instances);
    expect(mount.removeChild).not.toHaveBeenCalled();
  });

  it.each(['append', 'resize'])('cleans all resources and attached canvas after %s failure', (stage) => {
    const cause = new Error(`${stage} failed`);
    const fake = createFakeThree({ setSizeThrows: stage === 'resize' ? cause : undefined });
    const mount = createMount(640, 360, {
      appendThrows: stage === 'append' ? cause : undefined,
    });

    expect(() => createEffectRenderer({
      mount,
      video: createVideo(),
      three: fake.api,
    })).toThrow(expect.objectContaining({ code: 'webgl-unavailable', cause }));
    expectCreatedResourcesDisposed(fake.instances);
    expect(mount.removeChild).toHaveBeenCalledOnce();
    expect(fake.instances.renderers[0].domElement.parentNode).toBeNull();
  });

  it('preserves the setup cause when cleanup also throws', () => {
    const cause = new Error('append failed');
    const cleanupError = new Error('renderer dispose failed');
    const fake = createFakeThree({ rendererDisposeThrows: cleanupError });
    const mount = createMount(640, 360, { appendThrows: cause });

    expect(() => createEffectRenderer({
      mount,
      video: createVideo(),
      three: fake.api,
    })).toThrow(expect.objectContaining({ code: 'webgl-unavailable', cause }));
    expect(mount.removeChild).toHaveBeenCalledOnce();
    expect(fake.instances.renderers[0].dispose).toHaveBeenCalledOnce();
  });

  it('constructs and configures an accessible full-mount renderer', () => {
    const { instances, mount, effectRenderer } = createRenderer({ pixelRatio: 9 });
    const renderer = instances.renderers[0];

    expect(renderer.options).toEqual({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    expect(renderer.setPixelRatio).toHaveBeenCalledWith(2);
    expect(renderer).not.toHaveProperty('outputColorSpace');
    expect(renderer.setSize).toHaveBeenCalledWith(640, 360, false);
    expect(mount.appendChild).toHaveBeenCalledWith(effectRenderer.canvas);
    expect(effectRenderer.canvas.attributes).toMatchObject({
      'aria-hidden': 'true',
      role: 'presentation',
    });
    expect(effectRenderer.canvas.style).toMatchObject({ width: '100%', height: '100%', display: 'block' });
  });

  it('samples video as encoded display RGB without renderer output overrides', () => {
    const { instances } = createRenderer();

    expect(instances.textures[0].colorSpace).toBe('NoColorSpace');
    expect(instances.renderers[0]).not.toHaveProperty('outputColorSpace');
  });

  it('creates two independently ordered triangle meshes and outlines', () => {
    const { instances } = createRenderer();
    const [firstEffect, secondEffect, firstOutline, secondOutline] =
      instances.scenes[0].children.slice(1);
    const [firstGeometry, firstLineGeometry, secondGeometry, secondLineGeometry] =
      instances.bufferGeometries;

    expect(firstGeometry.attributes.position.array).toHaveLength(9);
    expect(firstGeometry.attributes.uv.array).toHaveLength(6);
    expect(secondGeometry.attributes.position.array).toHaveLength(9);
    expect(secondGeometry.attributes.uv.array).toHaveLength(6);
    expect(firstLineGeometry.attributes.position.array).toHaveLength(9);
    expect(secondLineGeometry.attributes.position.array).toHaveLength(9);
    expect([firstEffect.renderOrder, secondEffect.renderOrder]).toEqual([1, 2]);
    expect([firstOutline.renderOrder, secondOutline.renderOrder]).toEqual([3, 4]);
  });

  it('applies 72 percent state opacity to both triangle materials', () => {
    const { effectRenderer, instances } = createRenderer();

    effectRenderer.render({ corners: CORNERS, opacity: 1 });

    expect(instances.shaderMaterials[1].uniforms.uOpacity.value).toBeCloseTo(0.72);
    expect(instances.shaderMaterials[2].uniforms.uOpacity.value).toBeCloseTo(0.72);
  });

  it('recalculates default DPR on resize and applies changes before sizing', () => {
    vi.stubGlobal('devicePixelRatio', 1.25);
    try {
      const { effectRenderer, instances } = createRenderer();
      const renderer = instances.renderers[0];
      expect(renderer.setPixelRatio).toHaveBeenCalledWith(1.25);

      globalThis.devicePixelRatio = 3;
      effectRenderer.resize();
      expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(2);
      expect(renderer.operations.slice(-2)).toEqual([
        ['pixelRatio', 2],
        ['size', 640, 360, false],
      ]);

      effectRenderer.resize();
      expect(renderer.setPixelRatio).toHaveBeenCalledTimes(2);

      globalThis.devicePixelRatio = 0.5;
      effectRenderer.resize();
      expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retains an explicit DPR override across resize', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    try {
      const { effectRenderer, instances } = createRenderer({ pixelRatio: 1.5 });
      const renderer = instances.renderers[0];
      globalThis.devicePixelRatio = 1;

      effectRenderer.resize();

      expect(renderer.setPixelRatio).toHaveBeenCalledOnce();
      expect(renderer.setPixelRatio).toHaveBeenCalledWith(1.5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('creates a mirrored cover-crop background and reusable triangle resources', () => {
    const { instances } = createRenderer();
    const [backgroundMaterial, firstEffectMaterial, secondEffectMaterial] =
      instances.shaderMaterials;
    const [firstGeometry, firstLineGeometry, secondGeometry, secondLineGeometry] =
      instances.bufferGeometries;

    expect(instances.planeGeometries[0].args).toEqual([2, 2]);
    expect(backgroundMaterial.fragmentShader).toMatch(/1\.0\s*-\s*screenUv\.x/);
    expect(backgroundMaterial.fragmentShader).toMatch(/uVideoSize/);
    expect(backgroundMaterial.fragmentShader).toMatch(/uResolution/);
    for (const geometry of [firstGeometry, secondGeometry]) {
      expect(geometry.index).toBeNull();
      expect(geometry.attributes.position.array).toHaveLength(9);
      expect(geometry.attributes.uv.array).toHaveLength(6);
    }
    expect(firstLineGeometry.attributes.position.array).toHaveLength(9);
    expect(secondLineGeometry.attributes.position.array).toHaveLength(9);
    expect(instances.lineMaterials[0]).toMatchObject({
      color: 0xc8fbff,
      linewidth: 1,
      transparent: true,
    });
    expect(firstEffectMaterial.transparent).toBe(true);
    expect(secondEffectMaterial.transparent).toBe(true);
    expect(instances.scenes[0].children.map((child) => child.renderOrder)).toEqual([0, 1, 2, 3, 4]);
  });

  it('implements invert, luminance-preserving animated rainbow, and independent mirror sampling', () => {
    const { instances } = createRenderer();
    const shader = instances.shaderMaterials[1].fragmentShader;

    expect(shader).toMatch(/1\.0\s*-\s*sampled\.rgb/);
    expect(shader).toMatch(/uMode\s*<\s*1\.5/);
    expect(shader).toMatch(/uTime/);
    expect(shader).toMatch(/yiq\.x/);
    expect(shader).toMatch(/1\.0\s*-\s*effectUv\.x/);
    expect(shader).toMatch(/uOpacity/);
  });

  it('updates reusable attributes and sanitized uniforms in place', () => {
    const { effectRenderer, instances } = createRenderer();
    const [firstGeometry, firstLineGeometry, secondGeometry, secondLineGeometry] =
      instances.bufferGeometries;
    const firstPosition = firstGeometry.attributes.position;
    const firstUv = firstGeometry.attributes.uv;
    const secondPosition = secondGeometry.attributes.position;
    const secondUv = secondGeometry.attributes.uv;
    const firstLinePosition = firstLineGeometry.attributes.position;
    const secondLinePosition = secondLineGeometry.attributes.position;

    effectRenderer.render({
      corners: CORNERS,
      opacity: 3,
      fullscreenProgress: 0.5,
      mode: 'rainbow',
      time: 12.5,
    });

    expect(firstPosition.array).toEqual(new Float32Array([
      -0.8, 0.7, 0, 0.7, 0.75, 0, 0.8, -0.9, 0,
    ]));
    expect(firstUv.array).toEqual(new Float32Array([
      0.1, 0.85, 0.85, 0.875, 0.9, 0.05,
    ]));
    expect(secondPosition.array).toEqual(new Float32Array([
      -0.8, 0.7, 0, 0.8, -0.9, 0, -0.9, -0.8, 0,
    ]));
    expect(secondUv.array).toEqual(new Float32Array([
      0.1, 0.85, 0.9, 0.05, 0.05, 0.1,
    ]));
    expect(firstLinePosition.array).toEqual(firstPosition.array);
    expect(secondLinePosition.array).toEqual(secondPosition.array);
    for (const attribute of [firstPosition, firstUv, secondPosition, secondUv, firstLinePosition, secondLinePosition]) {
      expect(attribute.needsUpdate).toBe(true);
    }
    for (const material of instances.shaderMaterials.slice(1)) {
      expect(material.uniforms.uOpacity.value).toBeCloseTo(0.72);
      expect(material.uniforms.uMode.value).toBe(EFFECT_MODES.rainbow);
      expect(material.uniforms.uTime.value).toBe(12.5);
    }
  });

  it('avoids allocating helper paths during repeated valid renders', () => {
    const { effectRenderer, instances } = createRenderer();
    const [firstGeometry, firstLineGeometry, secondGeometry, secondLineGeometry] =
      instances.bufferGeometries;
    const firstPositionArray = firstGeometry.attributes.position.array;
    const firstUvArray = firstGeometry.attributes.uv.array;
    const firstLineArray = firstLineGeometry.attributes.position.array;
    const secondPositionArray = secondGeometry.attributes.position.array;
    const secondUvArray = secondGeometry.attributes.uv.array;
    const secondLineArray = secondLineGeometry.attributes.position.array;
    const originalMap = Array.prototype.map;
    const originalFlatMap = Array.prototype.flatMap;
    const originalValues = Object.values;
    const OriginalFloat32Array = globalThis.Float32Array;
    const rejectAllocation = () => {
      throw new Error('allocating helper invoked in render hot path');
    };

    Array.prototype.map = rejectAllocation;
    Array.prototype.flatMap = rejectAllocation;
    Object.values = rejectAllocation;
    globalThis.Float32Array = class ForbiddenFloat32Array extends OriginalFloat32Array {
      constructor() {
        throw new Error('typed array allocated in render hot path');
      }
    };

    let renderError;
    try {
      effectRenderer.render({ corners: CORNERS, opacity: 1, mode: 'rainbow' });
      effectRenderer.render({ corners: CORNERS, opacity: 1, mode: 2, fullscreenProgress: 1 });
    } catch (error) {
      renderError = error;
    } finally {
      Array.prototype.map = originalMap;
      Array.prototype.flatMap = originalFlatMap;
      Object.values = originalValues;
      globalThis.Float32Array = OriginalFloat32Array;
    }

    expect(renderError).toBeUndefined();
    expect(firstGeometry.attributes.position.array).toBe(firstPositionArray);
    expect(firstGeometry.attributes.uv.array).toBe(firstUvArray);
    expect(firstLineGeometry.attributes.position.array).toBe(firstLineArray);
    expect(secondGeometry.attributes.position.array).toBe(secondPositionArray);
    expect(secondGeometry.attributes.uv.array).toBe(secondUvArray);
    expect(secondLineGeometry.attributes.position.array).toBe(secondLineArray);
    expect(firstPositionArray).toEqual(new Float32Array([
      -1, 1, 0, 1, 1, 0, 1, -1, 0,
    ]));
    expect(firstUvArray).toEqual(new Float32Array([0, 1, 1, 1, 1, 0]));
    expect(secondPositionArray).toEqual(new Float32Array([
      -1, 1, 0, 1, -1, 0, -1, -1, 0,
    ]));
    expect(secondUvArray).toEqual(new Float32Array([0, 1, 1, 0, 0, 0]));
    expect(firstLineArray).toEqual(firstPositionArray);
    expect(secondLineArray).toEqual(secondPositionArray);
  });

  it('hides invalid or transparent effects while still rendering the background', () => {
    const { effectRenderer, instances } = createRenderer();
    const visibleResources = instances.scenes[0].children.slice(1);
    const renderer = instances.renderers[0];

    effectRenderer.render({ corners: CORNERS, opacity: 0.5 });
    expect(visibleResources.every((resource) => resource.visible)).toBe(true);

    effectRenderer.render({ corners: [], opacity: 1 });
    expect(visibleResources.every((resource) => !resource.visible)).toBe(true);

    effectRenderer.render({ corners: CORNERS, opacity: Number.NaN, mode: 'bad', time: Infinity });
    expect(visibleResources.every((resource) => !resource.visible)).toBe(true);
    for (const material of instances.shaderMaterials.slice(1)) {
      expect(material.uniforms).toMatchObject({
        uOpacity: { value: 0 },
        uMode: { value: EFFECT_MODES.invert },
        uTime: { value: 0 },
      });
    }
    expect(renderer.render).toHaveBeenCalledTimes(3);
  });

  it('updates video and resolution uniforms and uses positive resize fallbacks', () => {
    const { effectRenderer, instances, mount, video } = createRenderer();
    const renderer = instances.renderers[0];
    video.videoWidth = 1920;
    video.videoHeight = 1080;

    effectRenderer.render({ corners: CORNERS, opacity: 1 });
    for (const material of instances.shaderMaterials) {
      expect(material.uniforms.uVideoSize.value).toMatchObject({ x: 1920, y: 1080 });
    }

    mount.clientWidth = Number.NaN;
    mount.clientHeight = 0;
    effectRenderer.resize();
    expect(renderer.setSize).toHaveBeenLastCalledWith(1, 1, false);
    for (const material of instances.shaderMaterials) {
      expect(material.uniforms.uResolution.value).toMatchObject({ x: 1, y: 1 });
    }
  });

  it('disposes once, removes only its mounted canvas, and makes later calls no-ops', () => {
    const { effectRenderer, instances, mount } = createRenderer();
    const renderer = instances.renderers[0];

    effectRenderer.dispose();
    effectRenderer.dispose();
    effectRenderer.render({ corners: CORNERS, opacity: 1 });
    effectRenderer.resize();

    expect(instances.textures[0].dispose).toHaveBeenCalledOnce();
    expect(instances.planeGeometries[0].dispose).toHaveBeenCalledOnce();
    expect(instances.bufferGeometries.every((geometry) => geometry.dispose.mock.calls.length === 1)).toBe(true);
    expect(instances.shaderMaterials.every((material) => material.dispose.mock.calls.length === 1)).toBe(true);
    expect(instances.lineMaterials[0].dispose).toHaveBeenCalledOnce();
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(mount.removeChild).toHaveBeenCalledOnce();
    expect(renderer.render).not.toHaveBeenCalled();
    expect(renderer.setSize).toHaveBeenCalledOnce();
  });

  it('does not remove a canvas reparented before disposal', () => {
    const { effectRenderer, mount } = createRenderer();
    effectRenderer.canvas.parentNode = {};

    effectRenderer.dispose();

    expect(mount.removeChild).not.toHaveBeenCalled();
  });
});
