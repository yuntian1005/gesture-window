import { describe, expect, it, vi } from 'vitest';

import {
  CAMERA_ERROR_CODES,
  CameraError,
  createCameraController,
} from './camera-controller.js';

function createTrack() {
  return { stop: vi.fn() };
}

function createStream(trackCount = 2) {
  const tracks = Array.from({ length: trackCount }, createTrack);
  return { getTracks: vi.fn(() => tracks), tracks };
}

function createVideo() {
  return { srcObject: null, play: vi.fn().mockResolvedValue(undefined) };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function expectCancellation(promise) {
  return expect(promise).rejects.toMatchObject({
    name: 'CameraError',
    code: CAMERA_ERROR_CODES.CANCELLED,
    message: expect.stringMatching(/cancel|supersed|stale/i),
  });
}

describe('createCameraController', () => {
  it('exports stable camera error codes', () => {
    expect(CAMERA_ERROR_CODES).toEqual({
      PERMISSION_DENIED: 'permission-denied',
      DEVICE_NOT_FOUND: 'device-not-found',
      UNAVAILABLE: 'unavailable',
      PLAYBACK_FAILED: 'playback-failed',
      CANCELLED: 'cancelled',
    });
  });

  it('requests the user-facing camera, attaches it, and starts playback', async () => {
    const stream = createStream();
    const video = createVideo();
    const mediaDevices = { getUserMedia: vi.fn().mockResolvedValue(stream) };
    const camera = createCameraController(video, { mediaDevices });

    await expect(camera.start()).resolves.toBe(stream);

    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    expect(video.srcObject).toBe(stream);
    expect(video.play).toHaveBeenCalledOnce();
    expect(camera.getStream()).toBe(stream);
  });

  it.each([
    ['NotAllowedError', CAMERA_ERROR_CODES.PERMISSION_DENIED],
    ['SecurityError', CAMERA_ERROR_CODES.PERMISSION_DENIED],
    ['NotFoundError', CAMERA_ERROR_CODES.DEVICE_NOT_FOUND],
    ['DevicesNotFoundError', CAMERA_ERROR_CODES.DEVICE_NOT_FOUND],
    ['NotReadableError', CAMERA_ERROR_CODES.UNAVAILABLE],
  ])('maps %s camera errors to %s', async (name, code) => {
    const cause = Object.assign(new Error(name), { name });
    const mediaDevices = { getUserMedia: vi.fn().mockRejectedValue(cause) };
    const camera = createCameraController(createVideo(), { mediaDevices });

    await expect(camera.start()).rejects.toMatchObject({
      name: 'CameraError',
      code,
      cause,
    });
  });

  it.each([
    [null, { getUserMedia: vi.fn() }],
    [createVideo(), null],
    [createVideo(), {}],
  ])('reports unavailable when camera prerequisites are missing', async (video, mediaDevices) => {
    const camera = createCameraController(video, { mediaDevices });

    await expect(camera.start()).rejects.toBeInstanceOf(CameraError);
    await expect(camera.start()).rejects.toMatchObject({ code: CAMERA_ERROR_CODES.UNAVAILABLE });
  });

  it('cleans up the acquired stream when playback fails', async () => {
    const stream = createStream();
    const cause = new Error('autoplay blocked');
    const video = createVideo();
    video.play.mockRejectedValue(cause);
    const camera = createCameraController(video, {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });

    await expect(camera.start()).rejects.toMatchObject({
      code: CAMERA_ERROR_CODES.PLAYBACK_FAILED,
      cause,
    });
    expect(stream.tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(camera.getStream()).toBeNull();
  });

  it('stops every track once and remains safe when stopped repeatedly', async () => {
    const stream = createStream(3);
    const video = createVideo();
    const camera = createCameraController(video, {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    await camera.start();

    expect(() => camera.stop()).not.toThrow();
    expect(() => camera.stop()).not.toThrow();

    expect(stream.tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(camera.getStream()).toBeNull();
  });

  it('stops the existing stream before acquiring a replacement', async () => {
    const first = createStream();
    const second = createStream();
    const video = createVideo();
    const mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    };
    const camera = createCameraController(video, { mediaDevices });
    await camera.start();

    await expect(camera.start()).resolves.toBe(second);

    expect(first.tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
    expect(second.tracks.every((track) => track.stop.mock.calls.length === 0)).toBe(true);
    expect(video.srcObject).toBe(second);
    expect(camera.getStream()).toBe(second);
  });

  it('invalidates and cleans up a pending start when stopped', async () => {
    const acquisition = createDeferred();
    const stream = createStream();
    const video = createVideo();
    const camera = createCameraController(video, {
      mediaDevices: { getUserMedia: vi.fn().mockReturnValue(acquisition.promise) },
    });
    const pendingStart = camera.start();
    const cancellation = expectCancellation(pendingStart);

    camera.stop();
    acquisition.resolve(stream);

    await cancellation;
    expect(stream.tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(video.play).not.toHaveBeenCalled();
    expect(camera.getStream()).toBeNull();
  });

  it('keeps only the latest overlapping start when the old request resolves first', async () => {
    const firstAcquisition = createDeferred();
    const secondAcquisition = createDeferred();
    const firstStream = createStream();
    const secondStream = createStream();
    const video = createVideo();
    const mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockReturnValueOnce(firstAcquisition.promise)
        .mockReturnValueOnce(secondAcquisition.promise),
    };
    const camera = createCameraController(video, { mediaDevices });
    const firstStart = camera.start();
    const firstCancellation = expectCancellation(firstStart);
    const secondStart = camera.start();

    firstAcquisition.resolve(firstStream);
    await firstCancellation;

    expect(firstStream.tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(video.play).not.toHaveBeenCalled();

    secondAcquisition.resolve(secondStream);
    await expect(secondStart).resolves.toBe(secondStream);
    expect(video.srcObject).toBe(secondStream);
    expect(camera.getStream()).toBe(secondStream);
  });

  it('keeps only the latest overlapping start when the new request resolves first', async () => {
    const firstAcquisition = createDeferred();
    const secondAcquisition = createDeferred();
    const firstStream = createStream();
    const secondStream = createStream();
    const video = createVideo();
    const mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockReturnValueOnce(firstAcquisition.promise)
        .mockReturnValueOnce(secondAcquisition.promise),
    };
    const camera = createCameraController(video, { mediaDevices });
    const firstStart = camera.start();
    const firstCancellation = expectCancellation(firstStart);
    const secondStart = camera.start();

    secondAcquisition.resolve(secondStream);
    await expect(secondStart).resolves.toBe(secondStream);
    firstAcquisition.resolve(firstStream);
    await firstCancellation;

    expect(firstStream.tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
    expect(secondStream.tracks.every((track) => track.stop.mock.calls.length === 0)).toBe(true);
    expect(video.srcObject).toBe(secondStream);
    expect(camera.getStream()).toBe(secondStream);
  });

  it('does not disturb a newer stream when an invalidated play later resolves', async () => {
    const firstPlay = createDeferred();
    const firstStream = createStream();
    const secondStream = createStream();
    const video = createVideo();
    video.play.mockImplementationOnce(() => firstPlay.promise).mockResolvedValueOnce(undefined);
    const mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValueOnce(firstStream).mockResolvedValueOnce(secondStream),
    };
    const camera = createCameraController(video, { mediaDevices });
    const firstStart = camera.start();
    const firstCancellation = expectCancellation(firstStart);
    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());

    await expect(camera.start()).resolves.toBe(secondStream);
    firstPlay.resolve();
    await firstCancellation;

    expect(firstStream.tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
    expect(secondStream.tracks.every((track) => track.stop.mock.calls.length === 0)).toBe(true);
    expect(video.srcObject).toBe(secondStream);
    expect(camera.getStream()).toBe(secondStream);
  });

  it('does not throw if a track or srcObject cleanup fails', async () => {
    const stream = createStream();
    stream.tracks[0].stop.mockImplementation(() => {
      throw new Error('track cleanup failed');
    });
    const video = createVideo();
    const camera = createCameraController(video, {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    await camera.start();
    Object.defineProperty(video, 'srcObject', {
      configurable: true,
      get: () => stream,
      set: () => {
        throw new Error('detach failed');
      },
    });

    expect(() => camera.stop()).not.toThrow();
    expect(stream.tracks[0].stop).toHaveBeenCalledOnce();
    expect(stream.tracks[1].stop).toHaveBeenCalledOnce();
    expect(camera.getStream()).toBeNull();
  });

  it('retries failed track cleanup without stopping successful tracks twice', async () => {
    const stream = createStream();
    stream.tracks[0].stop
      .mockImplementationOnce(() => {
        throw new Error('temporary cleanup failure');
      })
      .mockImplementationOnce(() => undefined);
    const camera = createCameraController(createVideo(), {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    await camera.start();

    expect(() => camera.stop()).not.toThrow();
    expect(stream.tracks[0].stop).toHaveBeenCalledOnce();
    expect(stream.tracks[1].stop).toHaveBeenCalledOnce();

    expect(() => camera.stop()).not.toThrow();
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(2);
    expect(stream.tracks[1].stop).toHaveBeenCalledOnce();

    expect(() => camera.stop()).not.toThrow();
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(2);
    expect(stream.tracks[1].stop).toHaveBeenCalledOnce();
  });
});
