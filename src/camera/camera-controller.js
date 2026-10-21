export const CAMERA_ERROR_CODES = Object.freeze({
  PERMISSION_DENIED: 'permission-denied',
  DEVICE_NOT_FOUND: 'device-not-found',
  UNAVAILABLE: 'unavailable',
  PLAYBACK_FAILED: 'playback-failed',
  CANCELLED: 'cancelled',
});

export class CameraError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'CameraError';
    this.code = code;
    this.cause = cause;
  }
}

const CAMERA_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: 'user',
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
};

function getCameraErrorCode(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return CAMERA_ERROR_CODES.PERMISSION_DENIED;
  }

  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return CAMERA_ERROR_CODES.DEVICE_NOT_FOUND;
  }

  return CAMERA_ERROR_CODES.UNAVAILABLE;
}

function stopStream(stream, stoppedTracks, failedTracks) {
  const tracks = new Set(failedTracks);

  try {
    for (const track of stream?.getTracks?.() ?? []) {
      tracks.add(track);
    }
  } catch {
    // Previously failed tracks are still retried when stream enumeration fails.
  }

  for (const track of tracks) {
    if (stoppedTracks.has(track)) {
      failedTracks.delete(track);
      continue;
    }

    try {
      track?.stop?.();
      stoppedTracks.add(track);
      failedTracks.delete(track);
    } catch {
      failedTracks.add(track);
    }
  }
}

export function createCameraController(
  video,
  { mediaDevices = globalThis.navigator?.mediaDevices } = {},
) {
  let stream = null;
  let generation = 0;
  const stoppedTracks = new WeakSet();
  const failedTracks = new Set();

  function clearVideo(expectedStream) {
    try {
      if (video && (expectedStream === undefined || video.srcObject === expectedStream)) {
        video.srcObject = null;
      }
    } catch {
      // stop() intentionally never surfaces media element cleanup failures.
    }
  }

  function releaseStream(targetStream) {
    if (stream === targetStream) {
      stream = null;
    }

    stopStream(targetStream, stoppedTracks, failedTracks);
    clearVideo(targetStream);
  }

  function stopActiveStream() {
    const activeStream = stream;
    stream = null;
    stopStream(activeStream, stoppedTracks, failedTracks);
    clearVideo();
  }

  function stop() {
    generation += 1;
    stopActiveStream();
  }

  function createCancellationError(cause) {
    return new CameraError(
      CAMERA_ERROR_CODES.CANCELLED,
      'Camera start was cancelled or superseded by a newer operation.',
      cause,
    );
  }

  async function start() {
    const operation = ++generation;

    if (!video || typeof video.play !== 'function') {
      throw new CameraError(
        CAMERA_ERROR_CODES.UNAVAILABLE,
        'A valid video element is required to start the camera.',
      );
    }

    if (typeof mediaDevices?.getUserMedia !== 'function') {
      throw new CameraError(
        CAMERA_ERROR_CODES.UNAVAILABLE,
        'Camera access is not supported in this environment.',
      );
    }

    stopActiveStream();

    let acquiredStream;
    try {
      acquiredStream = await mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    } catch (cause) {
      if (operation !== generation) {
        throw createCancellationError(cause);
      }

      const code = getCameraErrorCode(cause);
      throw new CameraError(code, `Unable to acquire camera stream: ${code}.`, cause);
    }

    if (operation !== generation) {
      stopStream(acquiredStream, stoppedTracks, failedTracks);
      throw createCancellationError();
    }

    stream = acquiredStream;

    try {
      video.srcObject = acquiredStream;
      await video.play();
    } catch (cause) {
      if (operation !== generation) {
        releaseStream(acquiredStream);
        throw createCancellationError(cause);
      }

      releaseStream(acquiredStream);
      throw new CameraError(
        CAMERA_ERROR_CODES.PLAYBACK_FAILED,
        'Camera stream playback failed.',
        cause,
      );
    }

    if (operation !== generation) {
      releaseStream(acquiredStream);
      throw createCancellationError();
    }

    return acquiredStream;
  }

  return {
    start,
    stop,
    getStream: () => stream,
  };
}
