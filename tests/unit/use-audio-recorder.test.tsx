import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const diagnosticsApi = vi.hoisted(() => ({
  recordDiagnosticEvent: vi.fn(),
}));

vi.mock('../../src/frontend/services/diagnostics-api', () => diagnosticsApi);

import { useAudioRecorder } from '../../src/frontend/hooks/use-audio-recorder';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeTrack extends EventTarget {
  readonly kind = 'audio';
  readonly label = 'Studio Microphone';
  enabled = true;
  muted = false;
  readyState: MediaStreamTrackState = 'live';
  readonly stop = vi.fn(() => {
    this.readyState = 'ended';
  });

  getSettings(): MediaTrackSettings {
    return {
      deviceId: 'test-microphone',
      sampleRate: 48_000,
      channelCount: 1,
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
    };
  }

  endUnexpectedly(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }

  mute(): void {
    this.muted = true;
    this.dispatchEvent(new Event('mute'));
  }

  unmute(): void {
    this.muted = false;
    this.dispatchEvent(new Event('unmute'));
  }
}

class FakeMediaDevices extends EventTarget {
  readonly getUserMedia = vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>();
  readonly enumerateDevices = vi.fn<() => Promise<MediaDeviceInfo[]>>(
    async () => [{
      kind: 'audioinput',
      deviceId: 'test-microphone',
      label: 'Studio Microphone',
    } as MediaDeviceInfo],
  );
}

class FakeAudioNode extends EventTarget {
  readonly connect = vi.fn((node: AudioNode) => node);
  readonly disconnect = vi.fn();
}

class FakeAudioWorkletNode extends FakeAudioNode {
  static acknowledgeFlush = true;

  sequence = 0;
  frameCount = 0;
  readonly port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    start: vi.fn(),
    close: vi.fn(),
    postMessage: vi.fn((message: { type?: string; requestId?: string }) => {
      if (
        message.type !== 'flush'
        || !message.requestId
        || !FakeAudioWorkletNode.acknowledgeFlush
      ) return;
      this.port.onmessage?.({
        data: {
          type: 'flushed',
          requestId: message.requestId,
          sequence: this.sequence,
          frameCount: this.frameCount,
        },
      } as MessageEvent<unknown>);
    }),
  };

  constructor(context: FakeAudioContext) {
    super();
    context.processor = this;
  }

  emitPcm(samples: Float32Array): void {
    this.frameCount += samples.length;
    this.port.onmessage?.({
      data: {
        type: 'pcm',
        sequence: this.sequence,
        frameCount: this.frameCount,
        samples,
      },
    } as MessageEvent<unknown>);
    this.sequence += 1;
  }
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = { value: 1 };
}

class FakeScriptProcessorNode extends FakeAudioNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;

  emitPcm(...channels: Float32Array[]): void {
    const length = channels[0]?.length ?? 0;
    this.onaudioprocess?.({
      inputBuffer: {
        length,
        numberOfChannels: channels.length,
        getChannelData: (channel: number) => channels[channel] ?? new Float32Array(length),
      },
    } as unknown as AudioProcessingEvent);
  }
}

class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = [];
  static actualSampleRate = 48_000;
  static workletModuleDelayMs = 0;

  readonly sampleRate = FakeAudioContext.actualSampleRate;
  state: AudioContextState = 'suspended';
  readonly destination = new FakeAudioNode();
  readonly source = new FakeAudioNode();
  processor!: FakeAudioWorkletNode;
  readonly scriptProcessors: FakeScriptProcessorNode[] = [];
  readonly gain = new FakeGainNode();
  readonly audioWorklet = {
    addModule: vi.fn(async (_moduleUrl: string) => {
      if (FakeAudioContext.workletModuleDelayMs > 0) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, FakeAudioContext.workletModuleDelayMs);
        });
      }
    }),
  };
  readonly resume = vi.fn(async () => {
    this.state = 'running';
    this.dispatchEvent(new Event('statechange'));
  });
  readonly close = vi.fn(async () => {
    this.state = 'closed';
    this.dispatchEvent(new Event('statechange'));
  });

  constructor(_options?: AudioContextOptions) {
    super();
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return this.source as unknown as MediaStreamAudioSourceNode;
  }

  createGain(): GainNode {
    return this.gain as unknown as GainNode;
  }

  readonly createScriptProcessor = vi.fn((_bufferSize?: number, _inputChannels?: number, _outputChannels?: number): ScriptProcessorNode => {
    const processor = new FakeScriptProcessorNode();
    this.scriptProcessors.push(processor);
    return processor as unknown as ScriptProcessorNode;
  });
}

class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = [];
  static emitBlobOnStop = true;
  static emitStopEvent = true;
  static startFailure: Error | null = null;
  static startDelayMs = 0;

  static isTypeSupported(): boolean {
    return true;
  }

  readonly mimeType = 'audio/webm;codecs=opus';
  state: RecordingState = 'inactive';
  readonly startCalls: number[] = [];
  stopCalls = 0;

  constructor(readonly stream: MediaStream) {
    super();
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice?: number): void {
    if (FakeMediaRecorder.startFailure) throw FakeMediaRecorder.startFailure;
    if (FakeMediaRecorder.startDelayMs > 0) {
      vi.advanceTimersByTime(FakeMediaRecorder.startDelayMs);
    }
    this.startCalls.push(timeslice ?? 0);
    this.state = 'recording';
  }

  stop(): void {
    this.stopCalls += 1;
    this.state = 'inactive';
    if (FakeMediaRecorder.emitBlobOnStop) {
      const dataEvent = new Event('dataavailable') as Event & { data: Blob };
      dataEvent.data = new Blob(['recorded-audio'], { type: this.mimeType });
      this.dispatchEvent(dataEvent);
    }
    if (FakeMediaRecorder.emitStopEvent) this.dispatchEvent(new Event('stop'));
  }

  fail(): void {
    this.dispatchEvent(new Event('error'));
  }
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
const originalAudioWorkletNode = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');

let mediaDevices: FakeMediaDevices;

function streamWith(track: FakeTrack): MediaStream {
  return { getTracks: () => [track] } as unknown as MediaStream;
}

beforeEach(() => {
  diagnosticsApi.recordDiagnosticEvent.mockReset().mockResolvedValue({
    sequence: 1,
    incidentId: null,
  });
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.emitBlobOnStop = true;
  FakeMediaRecorder.emitStopEvent = true;
  FakeMediaRecorder.startFailure = null;
  FakeMediaRecorder.startDelayMs = 0;
  FakeAudioContext.instances = [];
  FakeAudioContext.actualSampleRate = 48_000;
  FakeAudioContext.workletModuleDelayMs = 0;
  FakeAudioWorkletNode.acknowledgeFlush = true;
  mediaDevices = new FakeMediaDevices();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: mediaDevices,
  });
  Object.defineProperty(globalThis, 'MediaRecorder', {
    configurable: true,
    value: FakeMediaRecorder,
  });
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: FakeAudioContext,
  });
  Object.defineProperty(globalThis, 'AudioWorkletNode', {
    configurable: true,
    value: FakeAudioWorkletNode,
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:audio-recorder-test'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  else Reflect.deleteProperty(navigator, 'mediaDevices');
  if (originalCreateObjectUrl) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevokeObjectUrl) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
  if (originalAudioContext) Object.defineProperty(globalThis, 'AudioContext', originalAudioContext);
  else Reflect.deleteProperty(globalThis, 'AudioContext');
  if (originalAudioWorkletNode) {
    Object.defineProperty(globalThis, 'AudioWorkletNode', originalAudioWorkletNode);
  } else Reflect.deleteProperty(globalThis, 'AudioWorkletNode');
});

describe('useAudioRecorder capture lifecycle', () => {
  it('records metadata-only capture diagnostics without affecting recording on log failure', async () => {
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    diagnosticsApi.recordDiagnosticEvent.mockImplementationOnce(() => {
      throw new Error('diagnostics unavailable');
    });
    const { result } = renderHook(() => useAudioRecorder({
      sessionId: 'session-recorder-diagnostics',
      attemptId: 'attempt-recorder-diagnostics',
      captureId: 'capture-recorder-diagnostics',
    }));

    await act(async () => result.current.start());
    act(() => result.current.stop());

    await waitFor(() => expect(result.current.status).toBe('recorded'));
    const events = diagnosticsApi.recordDiagnosticEvent.mock.calls.map(([input]) => input);
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      'recording.permission_requesting',
      'recording.permission_granted',
      'recording.track_metadata',
      'recording.started',
      'recording.ready',
    ]));
    expect(events.find((event) => event.event === 'recording.track_metadata')?.fields).toMatchObject({
      label: 'Studio Microphone',
      deviceId: 'test-microphone',
      sampleRate: 48_000,
      channelCount: 1,
    });
    expect(events.find((event) => event.event === 'recording.ready')?.fields).toMatchObject({
      durationMs: expect.any(Number),
      byteLength: expect.any(Number),
      chunkCount: 1,
      chunkBytes: expect.any(Number),
      mimeCategory: 'webm',
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('recorded-audio');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: 'session-recorder-diagnostics',
        attemptId: 'attempt-recorder-diagnostics',
        fields: expect.objectContaining({ captureId: 'capture-recorder-diagnostics' }),
      }),
    ]));
  });

  it('enumerates labeled inputs and requests the selected microphone exactly', async () => {
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const { result } = renderHook(() => useAudioRecorder());

    await waitFor(() => expect(result.current.inputDevices).toEqual([{
      deviceId: 'test-microphone',
      label: 'Studio Microphone',
      isDefault: false,
    }]));
    act(() => result.current.selectInputDevice('test-microphone'));
    await act(async () => result.current.start());

    expect(result.current.selectedInputDeviceId).toBe('test-microphone');
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        deviceId: { exact: 'test-microphone' },
      }),
    });
    expect(result.current.inputHealth).toMatchObject({
      status: 'unknown',
      trackLabel: 'Studio Microphone',
      deviceId: 'test-microphone',
      inputSampleRate: 48_000,
      trackSettings: {
        sampleRate: 48_000,
        channelCount: 1,
      },
    });
  });

  it('resamples actual 48 kHz PCM to 16 kHz and uses a zero-gain analysis sink', async () => {
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onPcmChunk = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onPcmChunk }));

    await act(async () => result.current.start());
    const context = FakeAudioContext.instances[0];
    const workletUrl = context?.audioWorklet.addModule.mock.calls[0]?.[0];
    expect(workletUrl).toContain('phrio-audio-worklets');
    expect(workletUrl).not.toMatch(/^blob:/u);
    expect(workletUrl).not.toMatch(/^data:/u);
    expect(context?.gain.gain.value).toBe(1);
    expect(context?.processor.connect).toHaveBeenCalledWith(context.gain);
    expect(context?.processor.connect).not.toHaveBeenCalledWith(context.destination);

    const first = Float32Array.from({ length: 24 }, (_, index) => index / 100);
    const second = Float32Array.from({ length: 24 }, (_, index) => (index + 24) / 100);
    act(() => {
      context?.processor.emitPcm(first);
      context?.processor.emitPcm(second);
    });

    const emitted = onPcmChunk.mock.calls.flatMap(([samples]) => Array.from(samples as Float32Array));
    expect(emitted).toHaveLength(16);
    expect(emitted).toEqual(
      Array.from({ length: 16 }, (_, index) => expect.closeTo((index * 3) / 100, 5)),
    );
    expect(result.current.inputHealth).toMatchObject({
      status: 'healthy',
      pcmCallbackCount: 2,
      inputSampleRate: 48_000,
      outputSampleRate: 16_000,
    });
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.pcm_started',
      fields: expect.objectContaining({
        inputSampleRate: 48_000,
        outputSampleRate: 16_000,
      }),
    }));
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.input_signal_detected',
    }));
  });

  it('warns after two seconds of near-silent input without stopping and recovers on signal', async () => {
    FakeAudioContext.actualSampleRate = 16_000;
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onInputSilence = vi.fn();
    const onPcmChunk = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onInputSilence, onPcmChunk }));

    await act(async () => result.current.start());
    const context = FakeAudioContext.instances[0];
    act(() => {
      for (let index = 0; index < 7; index += 1) {
        context?.processor.emitPcm(new Float32Array(4_096));
      }
    });
    expect(onInputSilence).not.toHaveBeenCalled();
    expect(result.current.inputHealth.status).toBe('unknown');

    act(() => context?.processor.emitPcm(new Float32Array(4_096)));
    expect(onInputSilence).toHaveBeenCalledOnce();
    expect(result.current.inputHealth).toMatchObject({
      status: 'silent',
      pcmCallbackCount: 8,
      peak: 0,
      rms: 0,
    });
    expect(FakeMediaRecorder.instances[0]?.state).toBe('recording');
    expect(onPcmChunk).toHaveBeenCalledTimes(8);
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.input_near_silent',
    }));

    act(() => context?.processor.emitPcm(new Float32Array(4_096).fill(0.1)));
    expect(result.current.inputHealth.status).toBe('healthy');
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.input_signal_recovered',
    }));
  });

  it('switches zero-callback AudioWorklet capture to one ScriptProcessor PCM stream', async () => {
    vi.useFakeTimers();
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onPcmUnavailable = vi.fn();
    const onPcmRecovered = vi.fn();
    const onPcmChunk = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({
      onPcmUnavailable,
      onPcmRecovered,
      onPcmChunk,
    }));

    await act(async () => result.current.start());
    expect(FakeAudioContext.instances[0]?.resume).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(2_001));

    expect(FakeAudioContext.instances[0]?.resume).toHaveBeenCalledOnce();
    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(FakeAudioContext.instances[0]?.processor.disconnect).toHaveBeenCalledOnce();
    expect(FakeAudioContext.instances[0]?.processor.port.close).toHaveBeenCalledOnce();
    expect(FakeAudioContext.instances[1]?.createScriptProcessor)
      .toHaveBeenCalledWith(2_048, 1, 1);
    expect(onPcmUnavailable).not.toHaveBeenCalled();
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.pcm_stalled',
      fields: expect.objectContaining({ reasonCode: 'pcm_callback_start_timeout' }),
    }));
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.pcm_transport_fallback_activated',
      fields: expect.objectContaining({
        reasonCode: 'pcm_callback_start_timeout',
        from: 'audio_worklet',
        to: 'script_processor_fallback',
        transport: 'script_processor_fallback',
      }),
    }));

    act(() => FakeAudioContext.instances[1]?.scriptProcessors[0]?.emitPcm(
      new Float32Array(4_096).fill(0.05),
    ));
    expect(onPcmChunk).toHaveBeenCalledOnce();
    expect(onPcmRecovered).not.toHaveBeenCalled();
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.pcm_started',
      fields: expect.objectContaining({ transport: 'script_processor_fallback' }),
    }));

    const fallbackProcessor = FakeAudioContext.instances[1]?.scriptProcessors[0];
    act(() => result.current.stop());
    await act(async () => vi.advanceTimersByTimeAsync(301));
    expect(fallbackProcessor?.disconnect).toHaveBeenCalledOnce();
    expect(fallbackProcessor?.onaudioprocess).toBeNull();
    act(() => fallbackProcessor?.emitPcm(new Float32Array(4_096).fill(0.2)));
    expect(onPcmChunk).toHaveBeenCalledOnce();
  });

  it('moves a stalled live worklet to fallback without delivering PCM twice', async () => {
    vi.useFakeTimers();
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onPcmUnavailable = vi.fn();
    const onPcmChunk = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onPcmUnavailable, onPcmChunk }));

    await act(async () => result.current.start());
    act(() => FakeAudioContext.instances[0]?.processor.emitPcm(
      new Float32Array(4_096).fill(0.05),
    ));
    act(() => vi.advanceTimersByTime(2_001));

    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(onPcmUnavailable).not.toHaveBeenCalled();
    act(() => {
      FakeAudioContext.instances[0]?.processor.emitPcm(new Float32Array(4_096).fill(0.2));
      FakeAudioContext.instances[1]?.scriptProcessors[0]?.emitPcm(
        new Float32Array(4_096).fill(0.1),
      );
    });
    expect(onPcmChunk).toHaveBeenCalledTimes(2);
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.pcm_transport_fallback_activated',
      fields: expect.objectContaining({
        reasonCode: 'pcm_callback_stalled',
        transport: 'script_processor_fallback',
      }),
    }));
  });

  it('reports an explicit degradation only when the compatibility PCM stream also stalls', async () => {
    vi.useFakeTimers();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(new FakeTrack()));
    const onPcmUnavailable = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onPcmUnavailable }));

    await act(async () => result.current.start());
    act(() => vi.advanceTimersByTime(4_002));

    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(onPcmUnavailable).toHaveBeenCalledWith(
      expect.stringMatching(/兼容 PCM 通道/u),
      'script_processor_callback_start_timeout',
    );
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.pcm_unavailable',
      fields: expect.objectContaining({
        reasonCode: 'script_processor_callback_start_timeout',
        transport: 'script_processor_fallback',
      }),
    }));
  });

  it('detects an incomplete PCM prefix at stop before the rolling watchdog fires', async () => {
    vi.useFakeTimers();
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onPcmUnavailable = vi.fn();
    const onRecordingReady = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({
      onPcmUnavailable,
      onRecordingReady,
    }));

    await act(async () => result.current.start());
    act(() => FakeAudioContext.instances[0]?.processor.emitPcm(
      new Float32Array(4_096).fill(0.05),
    ));
    act(() => vi.advanceTimersByTime(1_000));
    act(() => result.current.stop());
    await act(async () => vi.advanceTimersByTimeAsync(301));

    expect(onPcmUnavailable).toHaveBeenCalledOnce();
    expect(onRecordingReady).toHaveBeenCalledOnce();
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.pcm_capture_incomplete',
      fields: expect.objectContaining({
        pcmCallbackCount: 1,
        pcmGapMs: expect.any(Number),
      }),
    }));
  });

  it('does not count synchronous MediaRecorder startup latency as missing PCM', async () => {
    vi.useFakeTimers();
    FakeAudioContext.actualSampleRate = 16_000;
    FakeMediaRecorder.startDelayMs = 650;
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(new FakeTrack()));
    const onPcmUnavailable = vi.fn();
    const onRecordingReady = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({
      onPcmUnavailable,
      onRecordingReady,
    }));

    await act(async () => result.current.start());
    act(() => FakeAudioContext.instances[0]?.processor.emitPcm(
      new Float32Array(16_000).fill(0.05),
    ));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => result.current.stop());
    await act(async () => vi.advanceTimersByTimeAsync(301));

    expect(onRecordingReady).toHaveBeenCalledOnce();
    expect(onPcmUnavailable).not.toHaveBeenCalled();
    expect(diagnosticsApi.recordDiagnosticEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'recording.pcm_capture_incomplete' }),
    );
  });

  it('does not expose recording until a slow AudioWorklet module is ready', async () => {
    vi.useFakeTimers();
    FakeAudioContext.actualSampleRate = 16_000;
    FakeAudioContext.workletModuleDelayMs = 650;
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(new FakeTrack()));
    const onPcmUnavailable = vi.fn();
    const onRecordingStarted = vi.fn();
    const onRecordingReady = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({
      onPcmUnavailable,
      onRecordingStarted,
      onRecordingReady,
    }));

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start();
    });
    await act(async () => vi.advanceTimersByTimeAsync(649));
    expect(FakeMediaRecorder.instances[0]?.state).toBe('inactive');
    expect(onRecordingStarted).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await startPromise;
    });
    expect(FakeMediaRecorder.instances[0]?.state).toBe('recording');
    expect(onRecordingStarted).toHaveBeenCalledOnce();

    act(() => FakeAudioContext.instances[0]?.processor.emitPcm(
      new Float32Array(16_000).fill(0.05),
    ));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => result.current.stop());
    await act(async () => vi.advanceTimersByTimeAsync(301));

    expect(onRecordingReady).toHaveBeenCalledOnce();
    expect(onPcmUnavailable).not.toHaveBeenCalled();
    expect(diagnosticsApi.recordDiagnosticEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'recording.pcm_capture_incomplete' }),
    );
  });

  it('does not misclassify normal long ScriptProcessor stop finalization as lost PCM', async () => {
    vi.useFakeTimers();
    FakeAudioContext.actualSampleRate = 16_000;
    Reflect.deleteProperty(globalThis, 'AudioWorkletNode');
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(new FakeTrack()));
    const onPcmUnavailable = vi.fn();
    const onRecordingReady = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({
      onPcmUnavailable,
      onRecordingReady,
    }));

    await act(async () => result.current.start());
    const fallbackProcessor = FakeAudioContext.instances[1]?.scriptProcessors[0];
    expect(fallbackProcessor).toBeDefined();

    for (let index = 0; index < 340; index += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(256));
      act(() => fallbackProcessor?.emitPcm(new Float32Array(4_096).fill(0.05)));
    }
    await act(async () => vi.advanceTimersByTimeAsync(464));
    act(() => result.current.stop());
    await act(async () => vi.advanceTimersByTimeAsync(301));

    expect(onRecordingReady).toHaveBeenCalledOnce();
    expect(onPcmUnavailable).not.toHaveBeenCalled();
    expect(diagnosticsApi.recordDiagnosticEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'recording.pcm_capture_incomplete' }),
    );
  });

  it('still degrades a real ScriptProcessor PCM gap present before stop intent', async () => {
    vi.useFakeTimers();
    FakeAudioContext.actualSampleRate = 16_000;
    Reflect.deleteProperty(globalThis, 'AudioWorkletNode');
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(new FakeTrack()));
    const onPcmUnavailable = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onPcmUnavailable }));

    await act(async () => result.current.start());
    const fallbackProcessor = FakeAudioContext.instances[1]?.scriptProcessors[0];
    expect(fallbackProcessor).toBeDefined();
    for (let index = 0; index < 20; index += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(256));
      act(() => fallbackProcessor?.emitPcm(new Float32Array(4_096).fill(0.05)));
    }
    await act(async () => vi.advanceTimersByTimeAsync(1_200));
    act(() => result.current.stop());
    await act(async () => vi.advanceTimersByTimeAsync(301));

    expect(onPcmUnavailable).toHaveBeenCalledWith(
      expect.stringMatching(/实时 PCM 比录音文件短/u),
      'pcm_capture_incomplete',
    );
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.pcm_capture_incomplete',
      fields: expect.objectContaining({
        pcmGapMs: 1_200,
        captureCoverageTargetMs: 6_320,
        postStopFinalizationMs: 300,
      }),
    }));
  });

  it('requires sustained quiet speech energy and ignores a one-frame impulse', async () => {
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onVoiceDetected = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onVoiceDetected }));

    await act(async () => result.current.start());
    const impulse = new Float32Array(4_096);
    impulse[512] = 0.03;
    act(() => FakeAudioContext.instances[0]?.processor.emitPcm(impulse));
    expect(onVoiceDetected).not.toHaveBeenCalled();

    act(() => {
      for (let index = 0; index < 3; index += 1) {
        FakeAudioContext.instances[0]?.processor.emitPcm(new Float32Array(4_096).fill(0.007));
      }
    });

    expect(onVoiceDetected).toHaveBeenCalledOnce();
    expect(result.current.inputHealth.status).toBe('healthy');
  });

  it('records microphone mute and unmute lifecycle events', async () => {
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const { result } = renderHook(() => useAudioRecorder());

    await act(async () => result.current.start());
    act(() => {
      track.mute();
      track.unmute();
    });

    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.track_muted',
    }));
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.track_unmuted',
    }));
  });

  it('stops a getUserMedia stream that arrives after reset without starting capture', async () => {
    const pendingStream = deferred<MediaStream>();
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockReturnValue(pendingStream.promise);
    const onPermissionGranted = vi.fn();
    const onRecordingStarted = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({
      onPermissionGranted,
      onRecordingStarted,
    }));

    let startOperation!: Promise<void>;
    act(() => {
      startOperation = result.current.start();
      result.current.reset();
    });
    await act(async () => {
      pendingStream.resolve(streamWith(track));
      await startOperation;
    });

    expect(track.stop).toHaveBeenCalledOnce();
    expect(onPermissionGranted).not.toHaveBeenCalled();
    expect(onRecordingStarted).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(result.current.status).toBe('idle');
  });

  it('distinguishes permission denial from recorder startup failure in diagnostics', async () => {
    mediaDevices.getUserMedia.mockRejectedValueOnce(
      new DOMException('permission denied', 'NotAllowedError'),
    );
    const denied = renderHook(() => useAudioRecorder());
    await act(async () => denied.result.current.start());
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.permission_denied',
      fields: expect.objectContaining({ reasonCode: 'not_allowed' }),
    }));
    denied.unmount();

    diagnosticsApi.recordDiagnosticEvent.mockClear();
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    FakeMediaRecorder.startFailure = new Error('recorder start failed');
    const failedStart = renderHook(() => useAudioRecorder());
    await act(async () => failedStart.result.current.start());
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.capture_error',
      fields: expect.objectContaining({ reasonCode: 'media_recorder_start_failed' }),
    }));
    expect(failedStart.result.current.status).toBe('error');
    expect(track.stop).toHaveBeenCalled();
  });

  it('makes repeated start and stop clicks idempotent and returns one playable blob', async () => {
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onStopRequested = vi.fn();
    const onRecordingReady = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({
      onStopRequested,
      onRecordingReady,
    }));

    await act(async () => {
      await Promise.all([result.current.start(), result.current.start()]);
    });
    expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    act(() => {
      result.current.stop();
      result.current.stop();
    });

    await waitFor(() => expect(result.current.status).toBe('recorded'));
    expect(FakeMediaRecorder.instances[0]?.stopCalls).toBe(1);
    expect(onStopRequested).toHaveBeenCalledOnce();
    expect(onRecordingReady).toHaveBeenCalledOnce();
    expect(result.current.status).toBe('recorded');
    expect(result.current.recordedAudio?.blob.size).toBeGreaterThan(0);
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.stop_requested',
      fields: expect.objectContaining({ reasonCode: 'user_requested' }),
    }));
    expect(result.current.recordedAudio?.url).toBe('blob:audio-recorder-test');
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalledOnce();

    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
    expect(result.current.recordedAudio).toBeUndefined();
    expect(result.current.inputHealth).toEqual(expect.objectContaining({
      status: 'unknown',
      pcmCallbackCount: 0,
      peak: 0,
      rms: 0,
    }));
  });

  it('keeps one PCM-block grace after stop intent so the real tail reaches the watermark', async () => {
    vi.useFakeTimers();
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onPcmChunk = vi.fn();
    const onRecordingReady = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onPcmChunk, onRecordingReady }));

    await act(async () => result.current.start());
    act(() => FakeAudioContext.instances[0]?.processor.emitPcm(
      new Float32Array(4_096).fill(0.05),
    ));
    act(() => result.current.stop());
    expect(FakeMediaRecorder.instances[0]?.stopCalls).toBe(0);

    act(() => FakeAudioContext.instances[0]?.processor.emitPcm(
      new Float32Array(4_096).fill(0.07),
    ));
    await act(async () => vi.advanceTimersByTimeAsync(301));

    expect(FakeMediaRecorder.instances[0]?.stopCalls).toBe(1);
    expect(onPcmChunk).toHaveBeenCalledTimes(2);
    expect(onRecordingReady).toHaveBeenCalledOnce();
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.tail_grace_started',
      fields: expect.objectContaining({ graceMs: 300 }),
    }));
  });

  it('keeps the same stop tail grace when the PCM channel produced zero callbacks', async () => {
    vi.useFakeTimers();
    Reflect.deleteProperty(globalThis, 'AudioContext');
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(new FakeTrack()));
    const onRecordingReady = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onRecordingReady }));

    await act(async () => result.current.start());
    act(() => result.current.stop());
    expect(FakeMediaRecorder.instances[0]?.stopCalls).toBe(0);
    act(() => vi.advanceTimersByTime(299));
    expect(FakeMediaRecorder.instances[0]?.stopCalls).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(FakeMediaRecorder.instances[0]?.stopCalls).toBe(1);
    expect(onRecordingReady).toHaveBeenCalledOnce();
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.tail_grace_started',
      fields: expect.objectContaining({ pcmCallbackCount: 0, graceMs: 300 }),
    }));
  });

  it('bounds a missing AudioWorklet flush ACK and stops with an explicit degradation code', async () => {
    vi.useFakeTimers();
    FakeAudioWorkletNode.acknowledgeFlush = false;
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(new FakeTrack()));
    const onPcmUnavailable = vi.fn();
    const onRecordingReady = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({
      onPcmUnavailable,
      onRecordingReady,
    }));

    await act(async () => result.current.start());
    act(() => result.current.stop());
    await act(async () => vi.advanceTimersByTimeAsync(1_301));

    expect(FakeMediaRecorder.instances[0]?.stopCalls).toBe(1);
    expect(onRecordingReady).toHaveBeenCalledOnce();
    expect(onPcmUnavailable).toHaveBeenCalledWith(
      expect.stringMatching(/尾块/u),
      'audio_worklet_flush_timeout',
    );
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.pcm_flush_timeout',
      fields: expect.objectContaining({
        degradationCode: 'audio_worklet_flush_timeout',
        timeoutMs: 1_000,
      }),
    }));
  });

  it('distinguishes the five-minute automatic stop from a user-requested stop', async () => {
    vi.useFakeTimers();
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onStopRequested = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onStopRequested }));

    await act(async () => result.current.start());
    act(() => vi.advanceTimersByTime(5 * 60 * 1_000));
    await act(async () => vi.advanceTimersByTimeAsync(301));

    expect(FakeMediaRecorder.instances[0]?.stopCalls).toBe(1);
    expect(onStopRequested).toHaveBeenCalledOnce();
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.stop_requested',
      fields: expect.objectContaining({ reasonCode: 'maximum_duration' }),
    }));
  });

  it('fails visibly instead of hanging forever when MediaRecorder never emits stop', async () => {
    vi.useFakeTimers();
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onCaptureError = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onCaptureError }));

    await act(async () => result.current.start());
    FakeMediaRecorder.emitStopEvent = false;
    act(() => result.current.stop());
    expect(result.current.status).toBe('recording');

    await act(async () => vi.advanceTimersByTimeAsync(301));
    act(() => vi.advanceTimersByTime(5_001));

    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/没有完成停止/u);
    expect(onCaptureError).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.capture_error',
      fields: expect.objectContaining({ reasonCode: 'media_recorder_stop_timeout' }),
    }));
  });

  it('surfaces an ended microphone track as interrupted while preserving emitted audio', async () => {
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onCaptureInterrupted = vi.fn();
    const onRecordingReady = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({
      onCaptureInterrupted,
      onRecordingReady,
    }));

    await act(async () => result.current.start());
    act(() => track.endUnexpectedly());

    expect(onCaptureInterrupted).toHaveBeenCalledOnce();
    expect(onCaptureInterrupted.mock.calls[0]?.[0]).toMatch(/连接已中断/);
    expect(onRecordingReady).toHaveBeenCalledOnce();
    expect(result.current.status).toBe('recorded');
    expect(result.current.error).toMatch(/连接已中断/);
    expect(result.current.recordedAudio?.blob.size).toBeGreaterThan(0);
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.device_interrupted',
      fields: expect.objectContaining({ reasonCode: 'track_ended' }),
    }));
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.interrupted_audio_ready',
      fields: expect.objectContaining({ interrupted: true }),
    }));
  });

  it('cleans up an interrupted capture when MediaRecorder never emits stop', async () => {
    vi.useFakeTimers();
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onCaptureInterrupted = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onCaptureInterrupted }));

    await act(async () => result.current.start());
    FakeMediaRecorder.emitStopEvent = false;
    act(() => track.endUnexpectedly());
    expect(onCaptureInterrupted).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(5_001));

    expect(result.current.status).toBe('error');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalledOnce();
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.capture_error',
      fields: expect.objectContaining({
        reasonCode: 'media_recorder_stop_timeout_after_interruption',
      }),
    }));
  });

  it('surfaces MediaRecorder errors as interrupted exactly once', async () => {
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    const onCaptureInterrupted = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onCaptureInterrupted }));

    await act(async () => result.current.start());
    act(() => {
      FakeMediaRecorder.instances[0]?.fail();
      FakeMediaRecorder.instances[0]?.fail();
    });

    expect(onCaptureInterrupted).toHaveBeenCalledOnce();
    expect(result.current.error).toMatch(/录音器发生错误/);
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.media_recorder_error',
      fields: expect.objectContaining({ reasonCode: 'media_recorder_error' }),
    }));
  });

  it('surfaces device removal and preserves the captured blob', async () => {
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    mediaDevices.enumerateDevices.mockResolvedValue([]);
    const onCaptureInterrupted = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onCaptureInterrupted }));

    await act(async () => result.current.start());
    act(() => mediaDevices.dispatchEvent(new Event('devicechange')));

    await waitFor(() => expect(onCaptureInterrupted).toHaveBeenCalledOnce());
    expect(onCaptureInterrupted.mock.calls[0]?.[0]).toMatch(/设备已断开/);
    expect(result.current.recordedAudio?.blob.size).toBeGreaterThan(0);
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.device_interrupted',
      fields: expect.objectContaining({ reasonCode: 'device_removed' }),
    }));
  });

  it('reports an empty recording so the parent state cannot remain finalizing', async () => {
    const track = new FakeTrack();
    mediaDevices.getUserMedia.mockResolvedValue(streamWith(track));
    FakeMediaRecorder.emitBlobOnStop = false;
    const onCaptureError = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onCaptureError }));

    await act(async () => result.current.start());
    act(() => result.current.stop());

    await waitFor(() => {
      expect(onCaptureError).toHaveBeenCalledOnce();
      expect(result.current.status).toBe('error');
    });
    expect(onCaptureError.mock.calls[0]?.[0]).toMatch(/没有收到可保存的音频数据/);
    expect(result.current.recordedAudio).toBeUndefined();
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'recording.capture_error',
      fields: expect.objectContaining({ reasonCode: 'empty_audio' }),
    }));
  });
});
