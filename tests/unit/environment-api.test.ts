import { describe, expect, it, vi } from 'vitest';

import {
  checkMicrophoneAccess,
  formatLocalAsrModelInstallProgress,
} from '../../src/frontend/services/environment-api';
import { LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH } from '../../src/shared';

describe('environment renderer service', () => {
  it('labels the 1 GB archive as a structural compatibility fallback', () => {
    expect(formatLocalAsrModelInstallProgress({
      stage: 'downloading',
      downloadedBytes: 64 * 1_024 * 1_024,
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      source: 'github_release_archive',
      lastRecoverableErrorCode: 'ASR_MODEL_DIRECT_RANGE_REJECTED',
      cancellable: true,
      errorCode: null,
      updatedAt: '2026-07-20T03:00:00.000Z',
    })).toContain('官方三文件源结构不兼容，已切换约 1 GB 备用整包');
  });

  it('requests microphone access only when called and immediately stops every track', async () => {
    const stopFirst = vi.fn();
    const stopSecond = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: stopFirst }, { stop: stopSecond }],
    });

    expect(getUserMedia).not.toHaveBeenCalled();
    await expect(
      checkMicrophoneAccess({ getUserMedia } as unknown as MediaDevices),
    ).resolves.toMatchObject({ state: 'allowed' });

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(stopFirst).toHaveBeenCalledOnce();
    expect(stopSecond).toHaveBeenCalledOnce();
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'no_device'],
    ['DevicesNotFoundError', 'no_device'],
  ] as const)('maps %s to %s', async (name, state) => {
    const error = new Error('microphone check failed');
    error.name = name;
    const getUserMedia = vi.fn().mockRejectedValue(error);

    await expect(
      checkMicrophoneAccess({ getUserMedia } as unknown as MediaDevices),
    ).resolves.toMatchObject({ state });
  });

  it('reports no device when the media API is unavailable and preserves retryable failures', async () => {
    await expect(checkMicrophoneAccess(undefined)).resolves.toMatchObject({ state: 'no_device' });

    const failure = new Error('device is busy');
    failure.name = 'NotReadableError';
    await expect(
      checkMicrophoneAccess({
        getUserMedia: vi.fn().mockRejectedValue(failure),
      } as unknown as MediaDevices),
    ).rejects.toBe(failure);
  });

  it('separates permission, active-track, and measured PCM signal states', async () => {
    const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
    const originalAudioWorkletNode = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');
    const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const stop = vi.fn();
    const addModule = vi.fn(async (_moduleUrl: string) => undefined);
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const sink = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    class SignalWorkletNode {
      readonly connect = vi.fn();
      readonly disconnect = vi.fn();
      readonly port = {
        onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
        start: vi.fn(() => {
          this.port.onmessage?.({
            data: { type: 'metrics', frames: 128, squareSum: 0.0128, peak: 0.02 },
          } as MessageEvent<unknown>);
        }),
        close: vi.fn(),
      };
    }
    class SignalAudioContext {
      readonly audioWorklet = { addModule };
      readonly destination = {};
      readonly resume = vi.fn(async () => undefined);
      readonly close = vi.fn(async () => undefined);
      createMediaStreamSource() { return source; }
      createGain() { return sink; }
    }
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: SignalAudioContext,
    });
    Object.defineProperty(globalThis, 'AudioWorkletNode', {
      configurable: true,
      value: SignalWorkletNode,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:microphone-check-test'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const track = { kind: 'audio', readyState: 'live', enabled: true, stop };

    try {
      await expect(checkMicrophoneAccess({
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        }),
      } as unknown as MediaDevices)).resolves.toMatchObject({
        state: 'allowed',
        trackState: 'active',
        signalState: 'detected',
        transport: 'audio_worklet',
        pcmCallbackCount: 1,
        rms: 0.01,
        peak: 0.02,
      });
      expect(stop).toHaveBeenCalledOnce();
      const workletUrl = addModule.mock.calls[0]?.[0];
      expect(workletUrl).toContain('phrio-audio-worklets');
      expect(workletUrl).not.toMatch(/^blob:/u);
      expect(workletUrl).not.toMatch(/^data:/u);
    } finally {
      if (originalAudioContext) Object.defineProperty(globalThis, 'AudioContext', originalAudioContext);
      else Reflect.deleteProperty(globalThis, 'AudioContext');
      if (originalAudioWorkletNode) {
        Object.defineProperty(globalThis, 'AudioWorkletNode', originalAudioWorkletNode);
      } else Reflect.deleteProperty(globalThis, 'AudioWorkletNode');
      if (originalCreateObjectUrl) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (originalRevokeObjectUrl) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('falls back to ScriptProcessor when AudioWorklet produces no PCM callbacks', async () => {
    vi.useFakeTimers();
    const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
    const originalAudioWorkletNode = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');
    const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const stop = vi.fn();
    const addModule = vi.fn(async (_moduleUrl: string) => undefined);
    const createScriptProcessor = vi.fn(() => scriptProcessor);
    const worklet = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      port: { onmessage: null, start: vi.fn(), close: vi.fn() },
    };
    const scriptProcessor = {
      onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const source = {
      connect: vi.fn((node: unknown) => {
        if (node !== scriptProcessor) return;
        scriptProcessor.onaudioprocess?.({
          inputBuffer: {
            length: 256,
            numberOfChannels: 1,
            getChannelData: () => new Float32Array(256).fill(0.04),
          },
        } as unknown as AudioProcessingEvent);
      }),
      disconnect: vi.fn(),
    };
    const sinks = Array.from({ length: 2 }, () => ({
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    class SilentWorkletNode {
      readonly connect = worklet.connect;
      readonly disconnect = worklet.disconnect;
      readonly port = worklet.port;
    }
    class FallbackAudioContext {
      readonly audioWorklet = { addModule };
      readonly destination = {};
      readonly resume = vi.fn(async () => undefined);
      readonly close = vi.fn(async () => undefined);
      createMediaStreamSource() { return source; }
      createGain() { return sinks.shift(); }
      readonly createScriptProcessor = createScriptProcessor;
    }
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: FallbackAudioContext,
    });
    Object.defineProperty(globalThis, 'AudioWorkletNode', {
      configurable: true,
      value: SilentWorkletNode,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:microphone-check-fallback'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const track = { kind: 'audio', readyState: 'live', enabled: true, stop };

    try {
      const check = checkMicrophoneAccess({
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        }),
      } as unknown as MediaDevices);
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(check).resolves.toMatchObject({
        state: 'allowed',
        trackState: 'active',
        signalState: 'detected',
        transport: 'script_processor_fallback',
        pcmCallbackCount: 1,
        rms: expect.closeTo(0.04, 5),
        peak: expect.closeTo(0.04, 5),
      });
      expect(worklet.disconnect).toHaveBeenCalledOnce();
      expect(worklet.port.close).toHaveBeenCalledOnce();
      expect(scriptProcessor.disconnect).toHaveBeenCalledOnce();
      expect(scriptProcessor.onaudioprocess).toBeNull();
      expect(addModule.mock.calls[0]?.[0]).not.toMatch(/^blob:/u);
      expect(addModule.mock.calls[0]?.[0]).not.toMatch(/^data:/u);
      expect(createScriptProcessor).toHaveBeenCalledWith(2_048, 1, 1);
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      if (originalAudioContext) Object.defineProperty(globalThis, 'AudioContext', originalAudioContext);
      else Reflect.deleteProperty(globalThis, 'AudioContext');
      if (originalAudioWorkletNode) {
        Object.defineProperty(globalThis, 'AudioWorkletNode', originalAudioWorkletNode);
      } else Reflect.deleteProperty(globalThis, 'AudioWorkletNode');
      if (originalCreateObjectUrl) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (originalRevokeObjectUrl) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });
});
