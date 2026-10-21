import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

import { isPinching } from '../gesture/geometry.js';

export const DEFAULT_WASM_PATH =
  '/mediapipe/wasm';
export const DEFAULT_HAND_LANDMARKER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

function isLandmark(landmark) {
  return Number.isFinite(landmark?.x) && Number.isFinite(landmark?.y);
}

function mirrorLandmark(landmark) {
  return { x: 1 - landmark.x, y: landmark.y };
}

function getHandedness(result, index) {
  const category = result?.handedness?.[index]?.[0];

  if (typeof category === 'string') {
    return category;
  }

  for (const value of [category?.categoryName, category?.displayName, category?.label]) {
    if (typeof value === 'string') {
      return value;
    }
  }

  return undefined;
}

export function mapHandResults(result) {
  if (!Array.isArray(result?.landmarks)) {
    return [];
  }

  const hands = [];

  for (let handIndex = 0; handIndex < result.landmarks.length; handIndex += 1) {
    const landmarks = result.landmarks[handIndex];
    const required = [landmarks?.[0], landmarks?.[4], landmarks?.[5], landmarks?.[8]];

    if (!required.every(isLandmark)) {
      continue;
    }

    const wrist = mirrorLandmark(landmarks[0]);
    const thumb = mirrorLandmark(landmarks[4]);
    const indexMcp = mirrorLandmark(landmarks[5]);
    const index = mirrorLandmark(landmarks[8]);
    const palmWidth = Math.hypot(wrist.x - indexMcp.x, wrist.y - indexMcp.y);

    hands.push({
      thumb,
      index,
      wrist,
      indexMcp,
      palmWidth,
      pinching: isPinching(thumb, index, palmWidth),
      handedness: getHandedness(result, handIndex),
    });
  }

  return hands;
}

function createLandmarkerOptions(modelAssetPath, delegate) {
  return {
    baseOptions: {
      modelAssetPath,
      ...(delegate ? { delegate } : {}),
    },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
  };
}

export async function createHandTracker({
  FilesetResolver: Resolver = FilesetResolver,
  HandLandmarker: Landmarker = HandLandmarker,
  wasmPath = DEFAULT_WASM_PATH,
  modelAssetPath = DEFAULT_HAND_LANDMARKER_MODEL_URL,
} = {}) {
  const fileset = await Resolver.forVisionTasks(wasmPath);
  let landmarker;

  try {
    landmarker = await Landmarker.createFromOptions(
      fileset,
      createLandmarkerOptions(modelAssetPath, 'GPU'),
    );
  } catch (gpuCause) {
    try {
      landmarker = await Landmarker.createFromOptions(
        fileset,
        createLandmarkerOptions(modelAssetPath),
      );
    } catch (cause) {
      const error = new Error(
        'Failed to create the MediaPipe hand landmarker with GPU and CPU delegates.',
        { cause },
      );
      error.gpuCause = gpuCause;
      throw error;
    }
  }

  let lastVideo = null;
  let lastVideoTime;
  let lastTimestamp;
  let latestHands = [];
  let closed = false;

  function resetCache({ clearTimestamp = false } = {}) {
    lastVideo = null;
    lastVideoTime = undefined;
    latestHands = [];

    if (clearTimestamp) {
      lastTimestamp = undefined;
    }
  }

  function detect(video, timestamp) {
    if (closed) {
      return [];
    }

    if (
      !Number.isFinite(video?.readyState) ||
      video.readyState < 2 ||
      !Number.isFinite(video?.currentTime)
    ) {
      resetCache();
      return [];
    }

    if (video === lastVideo && video.currentTime === lastVideoTime) {
      return latestHands;
    }

    if (
      !Number.isFinite(timestamp) ||
      (Number.isFinite(lastTimestamp) && timestamp <= lastTimestamp)
    ) {
      return [];
    }

    const hands = mapHandResults(landmarker.detectForVideo(video, timestamp));
    lastVideo = video;
    lastVideoTime = video.currentTime;
    lastTimestamp = timestamp;
    latestHands = hands;
    return latestHands;
  }

  function close() {
    if (closed) {
      return;
    }

    closed = true;
    resetCache({ clearTimestamp: true });
    landmarker.close();
  }

  return { detect, close };
}
