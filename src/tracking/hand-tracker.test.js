import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_HAND_LANDMARKER_MODEL_URL,
  DEFAULT_WASM_PATH,
  createHandTracker,
  mapHandResults,
} from './hand-tracker.js';

function point(x, y) {
  return { x, y, z: 0 };
}

function handLandmarks({
  wrist = point(0.25, 0.5),
  thumb = point(0.5, 0.5),
  indexMcp = point(0.75, 0.5),
  index = point(0.5625, 0.5),
} = {}) {
  const landmarks = Array.from({ length: 21 }, () => point(0, 0));
  landmarks[0] = wrist;
  landmarks[4] = thumb;
  landmarks[5] = indexMcp;
  landmarks[8] = index;
  return landmarks;
}

function createDependencies({ createFromOptions } = {}) {
  const fileset = { wasmLoaderPath: 'fake-loader' };
  const FilesetResolver = {
    forVisionTasks: vi.fn().mockResolvedValue(fileset),
  };
  const landmarker = {
    detectForVideo: vi.fn().mockReturnValue({ landmarks: [], handedness: [] }),
    close: vi.fn(),
  };
  const HandLandmarker = {
    createFromOptions:
      createFromOptions ?? vi.fn().mockResolvedValue(landmarker),
  };

  return { fileset, FilesetResolver, HandLandmarker, landmarker };
}

describe('mapHandResults', () => {
  it('mirrors required landmarks, computes palm width, pinch, and handedness', () => {
    const result = mapHandResults({
      landmarks: [handLandmarks()],
      handedness: [[{ categoryName: 'Left', score: 0.99 }]],
    });

    expect(result).toEqual([
      {
        thumb: { x: 0.5, y: 0.5 },
        index: { x: 0.4375, y: 0.5 },
        wrist: { x: 0.75, y: 0.5 },
        indexMcp: { x: 0.25, y: 0.5 },
        palmWidth: 0.5,
        pinching: true,
        handedness: 'Left',
      },
    ]);
  });

  it('keeps valid hands when handedness is absent', () => {
    expect(mapHandResults({ landmarks: [handLandmarks()] })).toMatchObject([
      { handedness: undefined },
    ]);
  });

  it.each([
    undefined,
    null,
    {},
    { landmarks: null },
    { landmarks: [null] },
    { landmarks: [[]] },
    { landmarks: [handLandmarks({ thumb: point(Number.NaN, 0.5) })] },
    { landmarks: [handLandmarks({ index: null })] },
  ])('skips malformed hand results without throwing', (result) => {
    expect(() => mapHandResults(result)).not.toThrow();
    expect(mapHandResults(result)).toEqual([]);
  });

  it('skips only malformed entries when another hand is valid', () => {
    expect(mapHandResults({ landmarks: [[], handLandmarks()] })).toHaveLength(1);
  });
});

describe('createHandTracker', () => {
  it('uses versioned defaults and creates a GPU video landmarker', async () => {
    const dependencies = createDependencies();

    await createHandTracker(dependencies);

    expect(DEFAULT_WASM_PATH).toBe('/mediapipe/wasm');
    expect(DEFAULT_HAND_LANDMARKER_MODEL_URL).toBe(
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    );
    expect(dependencies.FilesetResolver.forVisionTasks).toHaveBeenCalledWith(DEFAULT_WASM_PATH);
    expect(dependencies.HandLandmarker.createFromOptions).toHaveBeenCalledWith(
      dependencies.fileset,
      {
        baseOptions: {
          modelAssetPath: DEFAULT_HAND_LANDMARKER_MODEL_URL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.55,
      },
    );
  });

  it('supports custom asset paths', async () => {
    const dependencies = createDependencies();

    await createHandTracker({
      ...dependencies,
      wasmPath: '/local/wasm',
      modelAssetPath: '/local/hand.task',
    });

    expect(dependencies.FilesetResolver.forVisionTasks).toHaveBeenCalledWith('/local/wasm');
    expect(dependencies.HandLandmarker.createFromOptions).toHaveBeenCalledWith(
      dependencies.fileset,
      expect.objectContaining({
        baseOptions: { modelAssetPath: '/local/hand.task', delegate: 'GPU' },
      }),
    );
  });

  it('retries once without the GPU delegate', async () => {
    const gpuError = new Error('GPU unavailable');
    const dependencies = createDependencies();
    dependencies.HandLandmarker.createFromOptions
      .mockRejectedValueOnce(gpuError)
      .mockResolvedValueOnce(dependencies.landmarker);

    await createHandTracker(dependencies);

    expect(dependencies.HandLandmarker.createFromOptions).toHaveBeenCalledTimes(2);
    expect(dependencies.HandLandmarker.createFromOptions.mock.calls[1]).toEqual([
      dependencies.fileset,
      {
        baseOptions: { modelAssetPath: DEFAULT_HAND_LANDMARKER_MODEL_URL },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.55,
      },
    ]);
  });

  it('surfaces a clear error with the CPU failure as its cause', async () => {
    const gpuError = new Error('GPU unavailable');
    const cpuError = new Error('CPU unavailable');
    const dependencies = createDependencies();
    dependencies.HandLandmarker.createFromOptions
      .mockRejectedValueOnce(gpuError)
      .mockRejectedValueOnce(cpuError);

    await expect(createHandTracker(dependencies)).rejects.toMatchObject({
      message: expect.stringMatching(/hand landmarker/i),
      cause: cpuError,
      gpuCause: gpuError,
    });
  });

  it('infers once per new video frame and returns the latest mapped hands', async () => {
    const dependencies = createDependencies();
    dependencies.landmarker.detectForVideo.mockReturnValue({
      landmarks: [handLandmarks()],
      handedness: [[{ categoryName: 'Right' }]],
    });
    const tracker = await createHandTracker(dependencies);
    const video = { readyState: 2, currentTime: 1 };

    const first = tracker.detect(video, 100);
    const repeated = tracker.detect(video, 101);
    video.currentTime = 2;
    const second = tracker.detect(video, 102);

    expect(dependencies.landmarker.detectForVideo).toHaveBeenCalledTimes(2);
    expect(dependencies.landmarker.detectForVideo).toHaveBeenNthCalledWith(1, video, 100);
    expect(dependencies.landmarker.detectForVideo).toHaveBeenNthCalledWith(2, video, 102);
    expect(first).toEqual(second);
    expect(repeated).toBe(first);
  });

  it('infers for a different video object at the same currentTime', async () => {
    const dependencies = createDependencies();
    const tracker = await createHandTracker(dependencies);
    const firstVideo = { readyState: 2, currentTime: 1 };
    const secondVideo = { readyState: 2, currentTime: 1 };

    tracker.detect(firstVideo, 100);
    tracker.detect(secondVideo, 101);

    expect(dependencies.landmarker.detectForVideo).toHaveBeenCalledTimes(2);
    expect(dependencies.landmarker.detectForVideo).toHaveBeenNthCalledWith(
      2,
      secondVideo,
      101,
    );
  });

  it('retries the same frame when inference throws', async () => {
    const inferenceError = new Error('inference failed');
    const dependencies = createDependencies();
    dependencies.landmarker.detectForVideo
      .mockImplementationOnce(() => {
        throw inferenceError;
      })
      .mockReturnValueOnce({ landmarks: [], handedness: [] });
    const tracker = await createHandTracker(dependencies);
    const video = { readyState: 2, currentTime: 1 };

    expect(() => tracker.detect(video, 100)).toThrow(inferenceError);
    expect(tracker.detect(video, 100)).toEqual([]);
    expect(dependencies.landmarker.detectForVideo).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['equal', 100],
    ['decreasing', 99],
  ])(
    'rejects a new frame with a non-increasing MediaPipe timestamp (%s)',
    async (_label, timestamp) => {
      const dependencies = createDependencies();
      const tracker = await createHandTracker(dependencies);
      const video = { readyState: 2, currentTime: 1 };
      tracker.detect(video, 100);
      video.currentTime = 2;

      expect(tracker.detect(video, timestamp)).toEqual([]);
      expect(dependencies.landmarker.detectForVideo).toHaveBeenCalledOnce();

      expect(tracker.detect(video, 101)).toEqual([]);
      expect(dependencies.landmarker.detectForVideo).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['missing', { currentTime: 1 }],
    ['NaN', { readyState: Number.NaN, currentTime: 1 }],
    ['Infinity', { readyState: Number.POSITIVE_INFINITY, currentTime: 1 }],
    ['negative Infinity', { readyState: Number.NEGATIVE_INFINITY, currentTime: 1 }],
    ['below two', { readyState: 1, currentTime: 1 }],
  ])('does not infer when readyState is %s', async (_label, video) => {
    const dependencies = createDependencies();
    const tracker = await createHandTracker(dependencies);

    expect(tracker.detect(video, 100)).toEqual([]);
    expect(dependencies.landmarker.detectForVideo).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'does not infer when timestamp is %s',
    async (timestamp) => {
      const dependencies = createDependencies();
      const tracker = await createHandTracker(dependencies);

      expect(tracker.detect({ readyState: 2, currentTime: 1 }, timestamp)).toEqual([]);
      expect(dependencies.landmarker.detectForVideo).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['unready', (video) => {
      video.readyState = 1;
    }],
    ['missing currentTime', (video) => {
      delete video.currentTime;
    }],
    ['NaN currentTime', (video) => {
      video.currentTime = Number.NaN;
    }],
    ['infinite currentTime', (video) => {
      video.currentTime = Number.POSITIVE_INFINITY;
    }],
  ])('clears cached hands for invalid video state (%s)', async (_label, makeInvalid) => {
    const dependencies = createDependencies();
    dependencies.landmarker.detectForVideo.mockReturnValue({
      landmarks: [handLandmarks()],
      handedness: [[{ categoryName: 'Right' }]],
    });
    const tracker = await createHandTracker(dependencies);
    const video = { readyState: 2, currentTime: 1 };
    tracker.detect(video, 100);
    makeInvalid(video);

    expect(tracker.detect(video, 101)).toEqual([]);
    expect(dependencies.landmarker.detectForVideo).toHaveBeenCalledOnce();

    video.readyState = 2;
    video.currentTime = 1;
    expect(tracker.detect(video, 102)).toHaveLength(1);
    expect(dependencies.landmarker.detectForVideo).toHaveBeenCalledTimes(2);
  });

  it('returns an empty result after close without calling the disposed landmarker', async () => {
    const dependencies = createDependencies();
    dependencies.landmarker.detectForVideo.mockReturnValue({
      landmarks: [handLandmarks()],
      handedness: [[{ categoryName: 'Right' }]],
    });
    const tracker = await createHandTracker(dependencies);
    const video = { readyState: 2, currentTime: 1 };
    tracker.detect(video, 100);

    tracker.close();
    video.currentTime = 2;

    expect(tracker.detect(video, 101)).toEqual([]);
    expect(dependencies.landmarker.detectForVideo).toHaveBeenCalledOnce();
  });

  it('closes the MediaPipe landmarker only once', async () => {
    const dependencies = createDependencies();
    const tracker = await createHandTracker(dependencies);

    tracker.close();
    tracker.close();

    expect(dependencies.landmarker.close).toHaveBeenCalledOnce();
  });
});
