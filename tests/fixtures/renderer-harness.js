import { createEffectRenderer } from '/src/render/effect-renderer.js';

const mount = document.querySelector('#mount');
const video = document.querySelector('#source');
let renderer;
let stream;
let paintFrame;

function paintPattern(canvas) {
  const context = canvas.getContext('2d');
  const quadrants = [
    [0, 0, '#e62828'],
    [canvas.width / 2, 0, '#28dc38'],
    [0, canvas.height / 2, '#2838dc'],
    [canvas.width / 2, canvas.height / 2, '#e6dc28'],
  ];
  for (const [x, y, color] of quadrants) {
    context.fillStyle = color;
    context.fillRect(x, y, canvas.width / 2, canvas.height / 2);
  }
  for (let y = 0; y < canvas.height; y += 24) {
    for (let x = 0; x < canvas.width; x += 24) {
      if ((x / 24 + y / 24) % 2 === 0) {
        context.fillStyle = 'rgba(255,255,255,0.12)';
        context.fillRect(x, y, 12, 12);
      }
    }
  }
  context.strokeStyle = '#ff00ff';
  context.lineWidth = 80;
  context.strokeRect(0, 0, canvas.width, canvas.height);
}

function readFramebuffer(customSamplePoints = {}) {
  const canvas = renderer.canvas;
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  function sample(x, y) {
    const px = Math.max(0, Math.min(canvas.width - 1, Math.round(x * (canvas.width - 1))));
    const py = Math.max(0, Math.min(canvas.height - 1, Math.round((1 - y) * (canvas.height - 1))));
    const offset = (py * canvas.width + px) * 4;
    return [...pixels.slice(offset, offset + 4)];
  }

  let minimum = 255;
  let maximum = 0;
  let nonBlack = 0;
  let hash = 2166136261;
  const step = Math.max(1, Math.floor((canvas.width * canvas.height) / 5000));
  for (let pixel = 0; pixel < canvas.width * canvas.height; pixel += step) {
    const offset = pixel * 4;
    const sum = pixels[offset] + pixels[offset + 1] + pixels[offset + 2];
    minimum = Math.min(minimum, pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    maximum = Math.max(maximum, pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    if (sum > 12) nonBlack += 1;
  }
  for (const channel of pixels) hash = Math.imul(hash ^ channel, 16777619) >>> 0;

  const samplePoints = {
    topLeft: { x: 0.2, y: 0.2 },
    topRight: { x: 0.8, y: 0.2 },
    bottomLeft: { x: 0.2, y: 0.8 },
    bottomRight: { x: 0.8, y: 0.8 },
    center: { x: 0.5, y: 0.5 },
    outside: { x: 0.08, y: 0.08 },
    edgeTop: { x: 0.5, y: 0.02 },
    edgeLeft: { x: 0.02, y: 0.5 },
    ...customSamplePoints,
  };

  return {
    width: canvas.width,
    height: canvas.height,
    minimum,
    maximum,
    nonBlack,
    hash,
    samples: Object.fromEntries(Object.entries(samplePoints).map(([name, point]) => (
      [name, sample(point.x, point.y)]
    ))),
  };
}

globalThis.rendererHarness = {
  async setup({ width = 320, height = 180, pixelRatio = 1 } = {}) {
    renderer?.dispose();
    cancelAnimationFrame(paintFrame);
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    mount.style.width = `${width}px`;
    mount.style.height = `${height}px`;

    const source = document.createElement('canvas');
    source.width = 640;
    source.height = 360;
    stream = source.captureStream(30);
    function pumpPattern() {
      paintPattern(source);
      paintFrame = requestAnimationFrame(pumpPattern);
    }
    pumpPattern();
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) => {
      if (video.videoWidth === 640 && video.videoHeight === 360) resolve();
      else video.addEventListener('loadedmetadata', resolve, { once: true });
    });
    renderer = createEffectRenderer({ mount, video, pixelRatio });
    await new Promise((resolve) => video.requestVideoFrameCallback(() => (
      requestAnimationFrame(resolve)
    )));
    return { videoWidth: video.videoWidth, videoHeight: video.videoHeight };
  },
  render(options = {}, samplePoints = {}) {
    renderer.render(options);
    return readFramebuffer(samplePoints);
  },
  resize({ width, height }) {
    mount.style.width = `${width}px`;
    mount.style.height = `${height}px`;
    renderer.resize();
    return { width: renderer.canvas.width, height: renderer.canvas.height };
  },
  dispose() {
    const canvas = renderer.canvas;
    renderer.dispose();
    cancelAnimationFrame(paintFrame);
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    return { attached: mount.contains(canvas), canvasCount: mount.querySelectorAll('canvas').length };
  },
};
