import * as THREE from 'three';

export const EFFECT_MODES = Object.freeze({ invert: 0, rainbow: 1, mirror: 2 });
export const TRIANGLE_OPACITY = 0.72;

const FULLSCREEN_CORNERS = Object.freeze([
  Object.freeze({ x: 0, y: 0 }),
  Object.freeze({ x: 1, y: 0 }),
  Object.freeze({ x: 1, y: 1 }),
  Object.freeze({ x: 0, y: 1 }),
]);

function hasValidCorners(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return false;

  for (let index = 0; index < 4; index += 1) {
    const corner = corners[index];
    if (!corner || !Number.isFinite(corner.x) || !Number.isFinite(corner.y)) {
      return false;
    }
  }

  return true;
}

export function normalizeMode(mode) {
  if (typeof mode === 'string' && Object.hasOwn(EFFECT_MODES, mode)) {
    return EFFECT_MODES[mode];
  }

  return mode === EFFECT_MODES.invert
    || mode === EFFECT_MODES.rainbow
    || mode === EFFECT_MODES.mirror
    ? mode
    : EFFECT_MODES.invert;
}

export function interpolateCorners(corners, fullscreenProgress) {
  if (!hasValidCorners(corners)) return [];

  const progress = Number.isFinite(fullscreenProgress)
    ? Math.min(1, Math.max(0, fullscreenProgress))
    : 0;

  return corners.map((corner, index) => ({
    x: corner.x + (FULLSCREEN_CORNERS[index].x - corner.x) * progress,
    y: corner.y + (FULLSCREEN_CORNERS[index].y - corner.y) * progress,
  }));
}

export function cornersToClipPositions(corners) {
  if (!hasValidCorners(corners)) return new Float32Array();

  return new Float32Array(corners.flatMap(({ x, y }) => [x * 2 - 1, 1 - y * 2, 0]));
}

export function cornersToScreenUvs(corners) {
  if (!hasValidCorners(corners)) return new Float32Array();

  return new Float32Array(corners.flatMap(({ x, y }) => [x, 1 - y]));
}

export function writeInterpolatedGeometry(corners, fullscreenProgress, positions, uvs) {
  if (
    !hasValidCorners(corners)
    || !positions
    || positions.length < 12
    || !uvs
    || uvs.length < 8
  ) {
    return false;
  }

  const progress = Number.isFinite(fullscreenProgress)
    ? Math.min(1, Math.max(0, fullscreenProgress))
    : 0;

  for (let index = 0; index < 4; index += 1) {
    const corner = corners[index];
    const fullscreenX = index === 1 || index === 2 ? 1 : 0;
    const fullscreenY = index >= 2 ? 1 : 0;
    const x = corner.x + (fullscreenX - corner.x) * progress;
    const y = corner.y + (fullscreenY - corner.y) * progress;
    const positionOffset = index * 3;
    const uvOffset = index * 2;

    positions[positionOffset] = x * 2 - 1;
    positions[positionOffset + 1] = 1 - y * 2;
    positions[positionOffset + 2] = 0;
    uvs[uvOffset] = x;
    uvs[uvOffset + 1] = 1 - y;
  }

  return true;
}

function copyTriangleAttribute(source, itemSize, cornerIndices, target) {
  for (let targetIndex = 0; targetIndex < 3; targetIndex += 1) {
    const sourceOffset = cornerIndices[targetIndex] * itemSize;
    const targetOffset = targetIndex * itemSize;
    for (let component = 0; component < itemSize; component += 1) {
      target[targetOffset + component] = source[sourceOffset + component];
    }
  }
}

const BACKGROUND_VERTEX_SHADER = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const COVER_SAMPLE_GLSL = `
  vec2 coverUv(vec2 screenUv) {
    float screenAspect = uResolution.x / max(uResolution.y, 1.0);
    float videoAspect = uVideoSize.x / max(uVideoSize.y, 1.0);

    if (screenAspect > videoAspect) {
      screenUv.y = (screenUv.y - 0.5) * (videoAspect / screenAspect) + 0.5;
    } else {
      screenUv.x = (screenUv.x - 0.5) * (screenAspect / videoAspect) + 0.5;
    }

    return screenUv;
  }
`;

const BACKGROUND_FRAGMENT_SHADER = `
  uniform sampler2D uVideo;
  uniform vec2 uResolution;
  uniform vec2 uVideoSize;
  varying vec2 vUv;

  ${COVER_SAMPLE_GLSL}

  void main() {
    vec2 screenUv = vUv;
    screenUv.x = 1.0 - screenUv.x;
    gl_FragColor = texture2D(uVideo, coverUv(screenUv));
  }
`;

const EFFECT_VERTEX_SHADER = `
  varying vec2 vScreenUv;

  void main() {
    vScreenUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const EFFECT_FRAGMENT_SHADER = `
  uniform sampler2D uVideo;
  uniform vec2 uResolution;
  uniform vec2 uVideoSize;
  uniform float uOpacity;
  uniform float uMode;
  uniform float uTime;
  varying vec2 vScreenUv;

  ${COVER_SAMPLE_GLSL}

  vec3 rotateHueKeepingLuminance(vec3 rgb, float angle) {
    vec3 yiq = vec3(
      dot(rgb, vec3(0.299, 0.587, 0.114)),
      dot(rgb, vec3(0.596, -0.275, -0.321)),
      dot(rgb, vec3(0.212, -0.523, 0.311))
    );
    float cosine = cos(angle);
    float sine = sin(angle);
    float i = yiq.y * cosine - yiq.z * sine;
    float q = yiq.y * sine + yiq.z * cosine;

    return clamp(vec3(
      yiq.x + 0.956 * i + 0.621 * q,
      yiq.x - 0.272 * i - 0.647 * q,
      yiq.x - 1.106 * i + 1.703 * q
    ), 0.0, 1.0);
  }

  void main() {
    vec2 effectUv = vScreenUv;
    if (uMode > 1.5) {
      effectUv.x = 1.0 - effectUv.x;
    }

    effectUv.x = 1.0 - effectUv.x;
    vec4 sampled = texture2D(uVideo, coverUv(effectUv));
    vec3 color = 1.0 - sampled.rgb;

    if (uMode > 0.5 && uMode < 1.5) {
      float hue = uTime * 0.8 + vScreenUv.x * 6.28318530718;
      color = rotateHueKeepingLuminance(sampled.rgb, hue);
    } else if (uMode > 1.5) {
      color = sampled.rgb;
    }

    gl_FragColor = vec4(color, sampled.a * uOpacity);
  }
`;

function positiveDimension(value) {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function clampPixelRatio(value) {
  return Number.isFinite(value) ? Math.min(2, Math.max(1, value)) : 1;
}

function createWebglError(cause) {
  const error = new Error('WebGL is unavailable', { cause });
  error.code = 'webgl-unavailable';
  return error;
}

export function createEffectRenderer(options = {}) {
  const { mount, video, three = THREE } = options;
  const hasPixelRatioOverride = Object.hasOwn(options, 'pixelRatio');
  const fixedPixelRatio = hasPixelRatioOverride
    ? clampPixelRatio(options.pixelRatio)
    : undefined;

  if (
    !mount
    || typeof mount.appendChild !== 'function'
    || typeof mount.removeChild !== 'function'
    || !video
    || typeof video !== 'object'
    || !Number.isFinite(video.videoWidth)
    || video.videoWidth < 0
    || !Number.isFinite(video.videoHeight)
    || video.videoHeight < 0
    || !Number.isFinite(video.currentTime)
  ) {
    throw new TypeError('createEffectRenderer requires a mount and video');
  }

  const disposables = [];
  let renderer;
  let canvas;
  let canvasAttached = false;
  let disposed = false;
  let appliedPixelRatio;

  function trackDisposable(resource) {
    disposables.push(resource);
    return resource;
  }

  function cleanup() {
    if (
      canvasAttached
      && canvas === renderer?.domElement
      && canvas.parentNode === mount
    ) {
      try {
        mount.removeChild(canvas);
      } catch {
        // Cleanup must never replace the originating failure.
      }
    }
    canvasAttached = false;

    for (let index = disposables.length - 1; index >= 0; index -= 1) {
      try {
        disposables[index].dispose();
      } catch {
        // Continue disposing every resource even if one cleanup fails.
      }
    }
  }

  try {
    renderer = trackDisposable(new three.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    }));
    appliedPixelRatio = fixedPixelRatio ?? clampPixelRatio(globalThis.devicePixelRatio);
    renderer.setPixelRatio(appliedPixelRatio);

    canvas = renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.setAttribute('role', 'presentation');

    const scene = new three.Scene();
    const camera = new three.OrthographicCamera(-1, 1, 1, -1, 0, 2);
    if (camera.position) camera.position.z = 1;

    const videoTexture = trackDisposable(new three.VideoTexture(video));
    videoTexture.minFilter = three.LinearFilter;
    videoTexture.magFilter = three.LinearFilter;
    videoTexture.wrapS = three.ClampToEdgeWrapping;
    videoTexture.wrapT = three.ClampToEdgeWrapping;
    if (three.NoColorSpace !== undefined) {
      // Effects intentionally operate on encoded display RGB for direct creative invert/hue behavior.
      videoTexture.colorSpace = three.NoColorSpace;
    }

    const resolution = new three.Vector2(1, 1);
    const videoSize = new three.Vector2(1, 1);
    const sharedUniforms = {
      uVideo: { value: videoTexture },
      uResolution: { value: resolution },
      uVideoSize: { value: videoSize },
    };

    const backgroundGeometry = trackDisposable(new three.PlaneGeometry(2, 2));
    const backgroundMaterial = trackDisposable(new three.ShaderMaterial({
      uniforms: { ...sharedUniforms },
      vertexShader: BACKGROUND_VERTEX_SHADER,
      fragmentShader: BACKGROUND_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    }));
    const background = new three.Mesh(backgroundGeometry, backgroundMaterial);
    background.renderOrder = 0;

    const lineMaterial = trackDisposable(new three.LineBasicMaterial({
      color: 0xc8fbff,
      linewidth: 1,
      transparent: true,
      opacity: 0.72,
      depthTest: false,
      depthWrite: false,
    }));
    const cornerPositions = new Float32Array(12);
    const cornerUvs = new Float32Array(8);

    function createTriangle(cornerIndices, effectRenderOrder, boundaryRenderOrder) {
      const geometry = trackDisposable(new three.BufferGeometry());
      const position = new three.Float32BufferAttribute(9, 3);
      const uv = new three.Float32BufferAttribute(6, 2);
      geometry.setAttribute('position', position);
      geometry.setAttribute('uv', uv);

      const materialOptions = {
        uniforms: {
          ...sharedUniforms,
          uOpacity: { value: 0 },
          uMode: { value: EFFECT_MODES.invert },
          uTime: { value: 0 },
        },
        vertexShader: EFFECT_VERTEX_SHADER,
        fragmentShader: EFFECT_FRAGMENT_SHADER,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      };
      if (three.DoubleSide !== undefined) materialOptions.side = three.DoubleSide;
      const material = trackDisposable(new three.ShaderMaterial(materialOptions));
      const effect = new three.Mesh(geometry, material);
      effect.visible = false;
      effect.renderOrder = effectRenderOrder;

      const lineGeometry = trackDisposable(new three.BufferGeometry());
      const linePosition = new three.Float32BufferAttribute(9, 3);
      lineGeometry.setAttribute('position', linePosition);
      const boundary = new three.LineLoop(lineGeometry, lineMaterial);
      boundary.visible = false;
      boundary.renderOrder = boundaryRenderOrder;

      return {
        boundary,
        cornerIndices,
        effect,
        linePosition,
        material,
        position,
        uv,
      };
    }

    const triangles = [
      createTriangle([0, 1, 2], 1, 3),
      createTriangle([0, 2, 3], 2, 4),
    ];

    scene.add(
      background,
      triangles[0].effect,
      triangles[1].effect,
      triangles[0].boundary,
      triangles[1].boundary,
    );
    try {
      mount.appendChild(canvas);
    } finally {
      canvasAttached = canvas.parentNode === mount;
    }

    function resize() {
      if (disposed) return;
      if (!hasPixelRatioOverride) {
        const nextPixelRatio = clampPixelRatio(globalThis.devicePixelRatio);
        if (nextPixelRatio !== appliedPixelRatio) {
          renderer.setPixelRatio(nextPixelRatio);
          appliedPixelRatio = nextPixelRatio;
        }
      }
      const width = positiveDimension(mount.clientWidth);
      const height = positiveDimension(mount.clientHeight);
      renderer.setSize(width, height, false);
      resolution.set(width, height);
    }

    function render({
      corners,
      opacity = 0,
      fullscreenProgress = 0,
      mode = 'invert',
      time = 0,
    } = {}) {
      if (disposed) return;

      const safeOpacity = Number.isFinite(opacity)
        ? Math.min(1, Math.max(0, opacity))
        : 0;
      const safeMode = normalizeMode(mode);
      const safeTime = Number.isFinite(time) ? time : 0;
      for (const triangle of triangles) {
        triangle.material.uniforms.uOpacity.value = safeOpacity * TRIANGLE_OPACITY;
        triangle.material.uniforms.uMode.value = safeMode;
        triangle.material.uniforms.uTime.value = safeTime;
      }
      videoSize.set(
        positiveDimension(video.videoWidth),
        positiveDimension(video.videoHeight),
      );

      const valid = writeInterpolatedGeometry(
        corners,
        fullscreenProgress,
        cornerPositions,
        cornerUvs,
      );
      const visible = valid && safeOpacity > 0;
      for (const triangle of triangles) {
        triangle.effect.visible = visible;
        triangle.boundary.visible = visible;

        if (valid) {
          copyTriangleAttribute(
            cornerPositions,
            3,
            triangle.cornerIndices,
            triangle.position.array,
          );
          copyTriangleAttribute(cornerUvs, 2, triangle.cornerIndices, triangle.uv.array);
          triangle.linePosition.array.set(triangle.position.array);
          triangle.position.needsUpdate = true;
          triangle.uv.needsUpdate = true;
          triangle.linePosition.needsUpdate = true;
        }
      }

      renderer.render(scene, camera);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      cleanup();
    }

    resize();

    return { render, resize, dispose, canvas };
  } catch (cause) {
    disposed = true;
    cleanup();
    throw createWebglError(cause);
  }
}
