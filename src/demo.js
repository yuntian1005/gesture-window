import { createEffectRenderer } from './render/effect-renderer.js';

const source = document.createElement('canvas');
source.width = 1600;
source.height = 1000;
const context = source.getContext('2d');
const video = document.querySelector('#source');
let mode = 'invert';
let frame;
let renderer;
let stream;

function paint(time) {
  const gradient = context.createLinearGradient(0, 0, 1600, 1000);
  gradient.addColorStop(0, '#dc7654');
  gradient.addColorStop(0.5, '#314b54');
  gradient.addColorStop(1, '#202d4c');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1600, 1000);
  for (let i = 0; i < 11; i++) {
    const x = 800 + Math.sin(time / 3000 + i * 0.7) * (200 + i * 40);
    const y = 500 + Math.cos(time / 4000 + i * 1.1) * 280;
    context.beginPath();context.arc(x, y, 35 + i * 8, 0, Math.PI * 2);
    context.fillStyle = i % 2 ? '#d7f59e55' : '#f1c8a655';context.fill();
  }
  // The camera renderer mirrors its source; pre-mirror text for a readable demo.
  context.save();context.translate(1600, 0);context.scale(-1, 1);
  context.fillStyle = '#f5f2e9';context.font = 'bold 130px sans-serif';
  context.fillText('SHAPE', 160, 470);context.fillText('THE WINDOW.', 160, 620);
  context.font = '22px monospace';context.fillText('SYNTHETIC PREVIEW / NO CAMERA', 170, 680);
  context.restore();
  const drift = Math.sin(time / 2400) * 0.07;
  renderer?.render({
    corners: [{ x: 0.22 + drift, y: 0.25 }, { x: 0.78, y: 0.32 + drift }, { x: 0.78 - drift, y: 0.78 }, { x: 0.22, y: 0.72 - drift }],
    opacity: 1, mode, time: time / 1000,
  });
  frame = requestAnimationFrame(paint);
}

async function start() {
  stream = source.captureStream(30);video.srcObject = stream;
  paint(0);
  await video.play();
  if (!video.videoWidth) await new Promise(resolve => video.addEventListener('loadedmetadata', resolve, { once: true }));
  renderer = createEffectRenderer({ mount: document.querySelector('#mount'), video });
  window.addEventListener('resize', () => renderer.resize());
}
for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => {
    mode = button.dataset.mode;
    for (const item of document.querySelectorAll('[data-mode]')) item.setAttribute('aria-pressed', String(item === button));
  });
}
window.addEventListener('pagehide', () => {
  cancelAnimationFrame(frame);renderer?.dispose();stream?.getTracks().forEach(track => track.stop());
});
start().catch(() => { document.querySelector('#status').textContent = '当前浏览器无法运行演示，请使用支持 WebGL 的 Chrome 或 Edge。'; });
