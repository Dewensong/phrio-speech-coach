import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decodeRecordedAudioToMono16Khz,
  RecordedAudioDecodeError,
} from '../../src/frontend/services/recorded-audio-decoder';

const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');

afterEach(() => {
  vi.restoreAllMocks();
  if (originalAudioContext) Object.defineProperty(globalThis, 'AudioContext', originalAudioContext);
  else Reflect.deleteProperty(globalThis, 'AudioContext');
});

describe('recorded audio PCM fallback', () => {
  it('downmixes stereo and resamples a retained 48 kHz take to mono 16 kHz', async () => {
    const left = new Float32Array(48_000).fill(0.4);
    const right = new Float32Array(48_000).fill(0.2);
    const close = vi.fn(async () => undefined);
    class FakeAudioContext {
      readonly close = close;

      async decodeAudioData(): Promise<AudioBuffer> {
        return {
          sampleRate: 48_000,
          length: 48_000,
          duration: 1,
          numberOfChannels: 2,
          getChannelData: (channel: number) => channel === 0 ? left : right,
        } as unknown as AudioBuffer;
      }
    }
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });
    const blob = {
      arrayBuffer: vi.fn(async () => new ArrayBuffer(16)),
    } as unknown as Blob;

    const decoded = await decodeRecordedAudioToMono16Khz(blob);

    expect(decoded).toMatchObject({
      sourceSampleRate: 48_000,
      sourceChannelCount: 2,
      durationMs: 1_000,
    });
    expect(decoded.samples).toHaveLength(16_000);
    expect(decoded.samples[0]).toBeCloseTo(0.3, 5);
    expect(decoded.samples.at(-1)).toBeCloseTo(0.3, 5);
    expect(decoded.rms).toBeCloseTo(0.3, 5);
    expect(decoded.peak).toBeCloseTo(0.3, 5);
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns a stable local error when Web Audio decoding is unavailable', async () => {
    Reflect.deleteProperty(globalThis, 'AudioContext');

    await expect(decodeRecordedAudioToMono16Khz(new Blob(['audio'])))
      .rejects.toEqual(expect.objectContaining<Partial<RecordedAudioDecodeError>>({
        code: 'RECORDED_AUDIO_DECODE_UNAVAILABLE',
      }));
  });

  it('times out and closes AudioContext when decodeAudioData never settles', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    class HangingAudioContext {
      readonly close = close;
      readonly decodeAudioData = vi.fn(() => new Promise<AudioBuffer>(() => undefined));
    }
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: HangingAudioContext,
    });
    const blob = {
      arrayBuffer: vi.fn(async () => new ArrayBuffer(16)),
    } as unknown as Blob;

    const decoding = decodeRecordedAudioToMono16Khz(blob);
    const rejected = expect(decoding).rejects.toEqual(
      expect.objectContaining<Partial<RecordedAudioDecodeError>>({
        code: 'RECORDED_AUDIO_DECODE_TIMEOUT',
      }),
    );
    await vi.advanceTimersByTimeAsync(15_001);

    await rejected;
    expect(close).toHaveBeenCalledOnce();
  });
});
