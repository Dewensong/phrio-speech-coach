import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as shared from '../../src/shared';
import {
  APPROVED_AI_PROVIDER,
  DEFAULT_APP_SETTINGS,
  GATE_C_PM_TASK,
  createPracticeSession as createDomainSession,
  type PhrioDesktopApi,
  type PracticeArtifact,
  type TranscriptSegment,
} from '../../src/shared';
import type { RecordedAudio } from '../../src/frontend/hooks/use-audio-recorder';

const desktopApi = vi.hoisted(() => ({
  feedLocalAsr: vi.fn(),
  getPracticeSession: vi.fn().mockResolvedValue(null),
  savePracticeArtifact: vi.fn(),
  readAttemptRecording: vi.fn(),
  startLocalAsr: vi.fn(),
  stopLocalAsr: vi.fn(),
}));

const diagnosticsApi = vi.hoisted(() => ({
  recordDiagnosticEvent: vi.fn(),
}));

const recordedAudioDecoder = vi.hoisted(() => ({
  decode: vi.fn(),
}));

const audioRecorder = vi.hoisted(() => ({
  options: undefined as undefined | {
    onPermissionGranted?: () => void;
    onPermissionDenied?: (message: string) => void;
    onRecordingStarted?: () => void;
    onRecordingReady?: (recording: {
      blob: Blob;
      url: string;
      mimeType: string;
      durationMs: number;
    }) => void;
    onVoiceDetected?: () => void;
    onPcmChunk?: (samples: Float32Array) => void;
    onPcmUnavailable?: (message: string) => void;
    onPcmRecovered?: () => void;
    onStopRequested?: () => void;
    onCaptureInterrupted?: (message: string) => void;
    onCaptureError?: (message: string) => void;
  },
  status: 'idle' as 'idle' | 'requesting' | 'recording' | 'recorded' | 'error',
  elapsedMs: 0,
  recordedAudio: undefined as undefined | {
    blob: Blob;
    url: string;
    mimeType: string;
    durationMs: number;
  },
  error: undefined as string | undefined,
  inputDevices: [] as Array<{ deviceId: string; label: string; isDefault: boolean }>,
  selectedInputDeviceId: null as string | null,
  inputHealth: {
    status: 'unknown' as 'unknown' | 'healthy' | 'silent',
    trackLabel: null as string | null,
    deviceId: null as string | null,
    trackSettings: {
      sampleRate: null,
      channelCount: null,
      autoGainControl: null,
      echoCancellation: null,
      noiseSuppression: null,
    },
    pcmCallbackCount: 0,
    peak: 0,
    rms: 0,
    inputSampleRate: null as number | null,
    outputSampleRate: 16_000 as const,
  },
  selectInputDevice: vi.fn(),
  refreshInputDevices: vi.fn().mockResolvedValue([]),
  start: vi.fn(),
  stop: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('../../src/frontend/services/desktop-api', () => desktopApi);
vi.mock('../../src/frontend/services/diagnostics-api', () => diagnosticsApi);
vi.mock('../../src/frontend/services/recorded-audio-decoder', () => ({
  decodeRecordedAudioToMono16Khz: recordedAudioDecoder.decode,
  RecordedAudioDecodeError: class RecordedAudioDecodeError extends Error {
    readonly code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

vi.mock('../../src/frontend/hooks/use-audio-recorder', () => ({
  useAudioRecorder: (options: typeof audioRecorder.options) => {
    audioRecorder.options = options;
    return {
      status: audioRecorder.status,
      elapsedMs: audioRecorder.elapsedMs,
      recordedAudio: audioRecorder.recordedAudio,
      error: audioRecorder.error,
      inputDevices: audioRecorder.inputDevices,
      selectedInputDeviceId: audioRecorder.selectedInputDeviceId,
      inputHealth: audioRecorder.inputHealth,
      selectInputDevice: audioRecorder.selectInputDevice,
      refreshInputDevices: audioRecorder.refreshInputDevices,
      start: audioRecorder.start,
      stop: audioRecorder.stop,
      reset: audioRecorder.reset,
    };
  },
}));

import {
  selectLiveHintFinalWindow,
  useLivePractice,
} from '../../src/frontend/hooks/use-live-practice';
import { LivePracticePage } from '../../src/frontend/pages/live-practice-page';
import { CANONICAL_TASK } from '../../src/frontend/data/practice-catalog';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function finalSegment(attemptId: string, text = '本周冻结新增需求'): TranscriptSegment {
  const at = '2026-07-18T00:00:00.000Z';
  return {
    id: `${attemptId}-seg-0`,
    attemptId,
    sequence: 0,
    revision: 1,
    text,
    startMs: 0,
    endMs: 800,
    confidence: null,
    isFinal: true,
    emittedAt: at,
    finalizedAt: at,
    modelVersion: 'test-asr-1',
  };
}

function recording(durationMs = 30_000): RecordedAudio {
  return {
    blob: new Blob(['recorded-audio'], { type: 'audio/webm' }),
    url: `blob:recording-${durationMs}`,
    mimeType: 'audio/webm',
    durationMs,
  };
}

function environmentStatus(ready: boolean) {
  return {
    checkedAt: '2026-07-20T00:00:00.000Z',
    dataDirectory: '/test/data',
    trainingRecordCount: 0,
    localAsr: {
      ready,
      files: [
        { name: 'encoder.int8.onnx' as const, exists: ready, readable: ready },
        { name: 'decoder.int8.onnx' as const, exists: ready, readable: ready },
        { name: 'tokens.txt' as const, exists: ready, readable: ready },
      ],
    },
  };
}

function signalUsableRecording(durationMs = 30_000): void {
  audioRecorder.options?.onVoiceDetected?.();
  audioRecorder.options?.onRecordingReady?.(recording(durationMs));
}

beforeEach(() => {
  recordedAudioDecoder.decode.mockReset().mockRejectedValue(
    new Error('recorded audio decoding unavailable in default fixture'),
  );
  diagnosticsApi.recordDiagnosticEvent.mockReset().mockResolvedValue({
    sequence: 1,
    incidentId: null,
  });
  desktopApi.getPracticeSession.mockImplementation(async (sessionId: string) => createDomainSession({
    id: sessionId,
    modeVersion: '1.0.0-content.1',
    task: GATE_C_PM_TASK,
    now: '2026-07-18T00:00:00.000Z',
  }));
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  audioRecorder.options = undefined;
  audioRecorder.status = 'idle';
  audioRecorder.elapsedMs = 0;
  audioRecorder.recordedAudio = undefined;
  audioRecorder.error = undefined;
  audioRecorder.inputDevices = [];
  audioRecorder.selectedInputDeviceId = null;
  audioRecorder.inputHealth = {
    status: 'unknown',
    trackLabel: null,
    deviceId: null,
    trackSettings: {
      sampleRate: null,
      channelCount: null,
      autoGainControl: null,
      echoCancellation: null,
      noiseSuppression: null,
    },
    pcmCallbackCount: 0,
    peak: 0,
    rms: 0,
    inputSampleRate: null,
    outputSampleRate: 16_000,
  };
  vi.useRealTimers();
  window.history.replaceState({}, '', '/');
  Reflect.deleteProperty(window, 'phrio');
});

describe('useLivePractice durable snapshot boundary', () => {
  it('restores a stopped persisted attempt with playback and the same continue CTA', async () => {
    window.history.replaceState({}, '', '/?qa=1');
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const frozen = renderHook(() => useLivePractice({
      sessionId: 'session-restored-stop',
      kind: 'initial',
    }));
    act(() => {
      frozen.result.current.runQaSequence();
      frozen.result.current.qaSafeEnd();
    });
    await waitFor(() => expect(frozen.result.current.snapshot).not.toBeNull());
    const restoredSnapshot = frozen.result.current.snapshot!;
    frozen.unmount();

    const restoredBlob = new Blob(['persisted-audio'], { type: 'audio/webm' });
    desktopApi.readAttemptRecording.mockResolvedValue(restoredBlob);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:restored-attempt'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const onAccept = vi.fn();
    render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={onAccept}
        restoredSnapshot={restoredSnapshot}
        sessionId="session-restored-stop"
      />,
    );

    const continueButton = await screen.findByRole('button', { name: '继续：确认逐字稿' });
    expect(continueButton).toBeEnabled();
    expect(screen.getByLabelText('本遍录音回放').querySelector('audio'))
      .toHaveAttribute('src', 'blob:restored-attempt');
    fireEvent.click(continueButton);
    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({ blob: restoredBlob, url: 'blob:restored-attempt' }),
      restoredSnapshot,
    );
  });

  it('blocks a missing restored recording until it is retried or explicitly discarded', async () => {
    window.history.replaceState({}, '', '/?qa=1');
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const frozen = renderHook(() => useLivePractice({
      sessionId: 'session-restored-audio-missing',
      kind: 'initial',
    }));
    act(() => {
      frozen.result.current.runQaSequence();
      frozen.result.current.qaSafeEnd();
    });
    await waitFor(() => expect(frozen.result.current.snapshot).not.toBeNull());
    const restoredSnapshot = frozen.result.current.snapshot!;
    frozen.unmount();

    desktopApi.readAttemptRecording.mockResolvedValue(null);
    const onDiscardStoppedTake = vi.fn().mockResolvedValue(undefined);
    render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={vi.fn()}
        onDiscardStoppedTake={onDiscardStoppedTake}
        restoredSnapshot={restoredSnapshot}
        sessionId="session-restored-audio-missing"
      />,
    );

    const retry = await screen.findByRole('button', { name: '重试读取已保存录音' });
    expect(screen.queryByRole('button', { name: '开始录音' })).not.toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() => expect(desktopApi.readAttemptRecording).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: '丢弃不可用 take 并重录' }));
    await waitFor(() => expect(onDiscardStoppedTake).toHaveBeenCalledOnce());
  });

  it('persists the stopped audio/Attempt before enabling the continue CTA', async () => {
    window.history.replaceState({}, '', '/?qa=1');
    audioRecorder.recordedAudio = recording(30_000);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const persistence = deferred<void>();
    const onPersistStoppedTake = vi.fn(() => persistence.promise);
    render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={vi.fn()}
        onPersistStoppedTake={onPersistStoppedTake}
        sessionId="session-persisted-stop"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '载入可控 ASR 流' }));
    fireEvent.click(await screen.findByRole('button', { name: '完成尾句收束' }));
    await waitFor(() => expect(onPersistStoppedTake).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '正在持久化录音与快照…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重录这遍' })).toBeDisabled();

    await act(async () => {
      persistence.resolve();
      await persistence.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '继续：确认逐字稿' })).toBeEnabled());
  });

  it('does not spin on a failed stopped-take save and permits an explicit retry', async () => {
    window.history.replaceState({}, '', '/?qa=1');
    audioRecorder.recordedAudio = recording(30_000);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const onPersistStoppedTake = vi.fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce(undefined);
    render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={vi.fn()}
        onPersistStoppedTake={onPersistStoppedTake}
        sessionId="session-persist-retry"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '载入可控 ASR 流' }));
    fireEvent.click(await screen.findByRole('button', { name: '完成尾句收束' }));

    const retry = await screen.findByRole('button', { name: '重试保存当前 take' });
    expect(onPersistStoppedTake).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); });
    expect(onPersistStoppedTake).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    await waitFor(() => expect(onPersistStoppedTake).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '继续：确认逐字稿' })).toBeEnabled());
  });

  it('blocks microphone capture before permission when the local ASR model is missing', async () => {
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getEnvironmentStatus: vi.fn().mockResolvedValue(environmentStatus(false)),
      } as unknown as PhrioDesktopApi,
    });
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-model-preflight',
      kind: 'initial',
    }));

    await waitFor(() => expect(result.current.localAsrReadiness).toBe('model_missing'));
    let started = true;
    await act(async () => {
      started = await result.current.startRecording();
    });

    expect(started).toBe(false);
    expect(audioRecorder.start).not.toHaveBeenCalled();
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: 'asr',
      event: 'asr.recording_preflight_blocked',
      fields: expect.objectContaining({ reasonCode: 'model_missing' }),
    }));
  });

  it('installs the local model from the live page before exposing a real recording start', async () => {
    const getEnvironmentStatus = vi
      .fn()
      .mockResolvedValueOnce(environmentStatus(false))
      .mockResolvedValue(environmentStatus(true));
    const installLocalAsrModel = vi.fn().mockResolvedValue({
      outcome: 'installed',
      downloadedArchiveBytes: 1_047_319_737,
      installedModelBytes: 240 * 1_024 * 1_024,
      completedAt: '2026-07-20T00:01:00.000Z',
      localAsr: environmentStatus(true).localAsr,
    });
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: { getEnvironmentStatus, installLocalAsrModel } as unknown as PhrioDesktopApi,
    });
    render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={vi.fn()}
        sessionId="session-model-install-live"
      />,
    );

    const installButton = await screen.findByRole('button', {
      name: '安装本地转写模型（约 226 MB）',
    });
    fireEvent.click(installButton);

    await waitFor(() => expect(installLocalAsrModel).toHaveBeenCalledOnce());
    expect(await screen.findByRole('button', { name: '开始录音' })).toBeEnabled();
    expect(audioRecorder.start).not.toHaveBeenCalled();
  });

  it('recovers the live install action when an older bridge throws synchronously', async () => {
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getEnvironmentStatus: vi.fn().mockResolvedValue(environmentStatus(false)),
      } as unknown as PhrioDesktopApi,
    });
    render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={vi.fn()}
        sessionId="session-old-install-bridge"
      />,
    );

    const install = await screen.findByRole('button', {
      name: '安装本地转写模型（约 226 MB）',
    });
    fireEvent.click(install);

    expect(await screen.findByText(/本地转写模型安装失败.*已有录音仍保留/u))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: '安装本地转写模型（约 226 MB）' }))
      .toBeEnabled();
  });

  it('shows bounded model download progress and cancels from the live page', async () => {
    let rejectInstall!: (error: Error) => void;
    let modelCancellationCompleted = false;
    let modelStatusReadCount = 0;
    const installLocalAsrModel = vi.fn(() => new Promise((_resolve, reject) => {
      rejectInstall = reject;
    }));
    const cancelLocalAsrModelInstall = vi.fn(async () => {
      rejectInstall(new Error('PHRIO_ASR_MODEL_INSTALL_CANCELLED'));
      modelCancellationCompleted = true;
      return { cancelled: true };
    });
    const getLocalAsrModelInstallStatus = vi.fn(async () => {
      if (modelCancellationCompleted) {
        return {
          stage: 'cancelled' as const,
          downloadedBytes: 0,
          expectedBytes: 1_047_319_737,
          cancellable: false,
          errorCode: 'ASR_MODEL_INSTALL_CANCELLED',
          updatedAt: '2026-07-20T00:02:00.000Z',
        };
      }
      if (modelStatusReadCount++ === 0) {
        return {
          stage: 'idle' as const,
          downloadedBytes: 0,
          expectedBytes: 1_047_319_737,
          cancellable: false,
          errorCode: null,
          updatedAt: '2026-07-20T00:00:00.000Z',
        };
      }
      return {
        stage: 'downloading' as const,
        downloadedBytes: 250 * 1_024 * 1_024,
        expectedBytes: 1_047_319_737,
        cancellable: true,
        errorCode: null,
        updatedAt: '2026-07-20T00:01:00.000Z',
      };
    });
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getEnvironmentStatus: vi.fn().mockResolvedValue(environmentStatus(false)),
        installLocalAsrModel,
        getLocalAsrModelInstallStatus,
        cancelLocalAsrModelInstall,
      } as unknown as PhrioDesktopApi,
    });
    render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={vi.fn()}
        sessionId="session-model-install-progress-live"
      />,
    );

    fireEvent.click(await screen.findByRole('button', {
      name: '安装本地转写模型（约 226 MB）',
    }));
    expect(await screen.findByText(/正在下载转写模型.*250\.0.*MB.*25%/u))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消安装' }));

    expect(await screen.findByText(/模型安装已取消.*原有模型和当前录音不受影响/u))
      .toBeInTheDocument();
    expect(cancelLocalAsrModelInstall).toHaveBeenCalledOnce();
  });

  it('shows and resumes a preserved model download after reopening the live page', async () => {
    const getEnvironmentStatus = vi
      .fn()
      .mockResolvedValueOnce(environmentStatus(false))
      .mockResolvedValue(environmentStatus(true));
    const installLocalAsrModel = vi.fn().mockResolvedValue({
      outcome: 'installed',
      downloadedArchiveBytes: 1_047_319_737,
      installedModelBytes: 240 * 1_024 * 1_024,
      completedAt: '2026-07-20T00:01:00.000Z',
      localAsr: environmentStatus(true).localAsr,
    });
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getEnvironmentStatus,
        installLocalAsrModel,
        getLocalAsrModelInstallStatus: vi.fn().mockResolvedValue({
          stage: 'paused',
          downloadedBytes: 250 * 1_024 * 1_024,
          expectedBytes: 1_047_319_737,
          cancellable: true,
          errorCode: null,
          updatedAt: '2026-07-20T00:01:00.000Z',
        }),
      } as unknown as PhrioDesktopApi,
    });
    render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={vi.fn()}
        sessionId="session-model-resume-live"
      />,
    );

    expect(await screen.findByText(/已保留下载进度.*250\.0.*MB.*25%/u))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除已下载进度' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '继续安装本地转写模型' }));
    await waitFor(() => expect(installLocalAsrModel).toHaveBeenCalledOnce());
    expect(await screen.findByRole('button', { name: '开始录音' })).toBeEnabled();
  });

  it('waits for backend cancellation when attaching to an install started on another page', async () => {
    let cancellationRequested = false;
    let postCancelReads = 0;
    const cancelLocalAsrModelInstall = vi.fn(async () => {
      cancellationRequested = true;
      return { cancelled: true };
    });
    const getLocalAsrModelInstallStatus = vi.fn(async () => {
      if (!cancellationRequested) {
        return {
          stage: 'downloading' as const,
          downloadedBytes: 80 * 1_024 * 1_024,
          expectedBytes: 1_047_319_737,
          cancellable: true,
          errorCode: null,
          updatedAt: '2026-07-20T00:01:00.000Z',
        };
      }
      if (postCancelReads++ === 0) {
        return {
          stage: 'cancelling' as const,
          downloadedBytes: 80 * 1_024 * 1_024,
          expectedBytes: 1_047_319_737,
          cancellable: false,
          errorCode: null,
          updatedAt: '2026-07-20T00:02:00.000Z',
        };
      }
      return {
        stage: 'cancelled' as const,
        downloadedBytes: 0,
        expectedBytes: 1_047_319_737,
        cancellable: false,
        errorCode: 'ASR_MODEL_INSTALL_CANCELLED',
        updatedAt: '2026-07-20T00:02:01.000Z',
      };
    });
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getEnvironmentStatus: vi.fn().mockResolvedValue(environmentStatus(false)),
        getLocalAsrModelInstallStatus,
        cancelLocalAsrModelInstall,
      } as unknown as PhrioDesktopApi,
    });
    render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={vi.fn()}
        sessionId="session-cross-page-cancel-live"
      />,
    );

    expect(await screen.findByText(/正在下载转写模型.*80\.0.*MB.*8%/u))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消安装' }));
    expect(await screen.findByText(/正在取消并清理临时文件/u)).toBeInTheDocument();
    expect(await screen.findByText(/模型安装已取消.*原有模型和当前录音不受影响/u, {}, {
      timeout: 2_000,
    })).toBeInTheDocument();
    expect(cancelLocalAsrModelInstall).toHaveBeenCalledOnce();
  });

  it('reuses the retained PCM to complete the same take after a runtime ASR start failure', async () => {
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getEnvironmentStatus: vi.fn().mockResolvedValue(environmentStatus(true)),
      } as unknown as PhrioDesktopApi,
    });
    desktopApi.startLocalAsr
      .mockRejectedValueOnce(new Error('native model failed to initialize'))
      .mockResolvedValue(undefined);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-same-take-runtime-retry',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1, 0.2, 0.3]));
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });
    await waitFor(() => expect(result.current.state).toMatchObject({
      capture: 'recorded',
      asr: 'failed',
    }));

    desktopApi.feedLocalAsr.mockResolvedValue(
      finalSegment(attemptId, '模型恢复后，这段已经录好的音频形成了完整逐字稿。'),
    );
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    let recovered = false;
    await act(async () => {
      recovered = await result.current.retryTranscriptionFromCapturedPcm();
    });

    expect(recovered).toBe(true);
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.state).toMatchObject({ capture: 'safe_end', asr: 'ready' });
    expect(result.current.snapshot?.finalSegments.map((segment) => segment.text)).toEqual([
      '模型恢复后，这段已经录好的音频形成了完整逐字稿。',
    ]);
    expect(desktopApi.startLocalAsr).toHaveBeenCalledTimes(2);
  });

  it('records correlated Fast events with lengths and counts but never transcript content', () => {
    const sessionId = 'session-diagnostic-metadata';
    const { result } = renderHook(() => useLivePractice({ sessionId, kind: 'initial' }));

    act(() => result.current.runQaSequence());

    const events = diagnosticsApi.recordDiagnosticEvent.mock.calls.map(([input]) => input);
    const segmentEvents = events.filter((event) => event.event === 'live.segment');
    expect(segmentEvents.length).toBeGreaterThan(0);
    expect(segmentEvents[0]).toMatchObject({
      component: 'asr',
      sessionId,
      attemptId: result.current.state.attemptId,
      fields: {
        generation: 1,
        sequence: expect.any(Number),
        revision: expect.any(Number),
        characterCount: expect.any(Number),
        status: expect.stringMatching(/partial|final/u),
      },
    });
    expect(Object.keys(segmentEvents[0]!.fields)).not.toContain('text');
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('我觉得就是我们可能需要先把这件事的边界说清楚');
    expect(serialized).not.toContain('本周冻结新增需求');
    expect(serialized).not.toContain('同步冻结范围');
  });

  it('keeps a live-hint text window on no more than 24 exact contributing final segments', () => {
    const segments = Array.from({ length: 30 }, (_, sequence): TranscriptSegment => ({
      ...finalSegment('attempt-live-window', `第${sequence + 1}句${'证据'.repeat(12)}`),
      id: `attempt-live-window-seg-${sequence}`,
      sequence,
      startMs: sequence * 1_000,
      endMs: (sequence + 1) * 1_000,
    }));

    const window = selectLiveHintFinalWindow(segments);
    const reconstructed = window.segments.map((segment) => segment.text.trim()).join('');
    const textBeforeOldest = reconstructed.length - window.segments[0]!.text.trim().length;

    expect(window.segments.length).toBeLessThanOrEqual(24);
    expect(window.segments[0]!.sequence).toBeGreaterThan(0);
    expect(window.segments.at(-1)?.sequence).toBe(29);
    expect(window.text.length).toBeLessThanOrEqual(360);
    expect(reconstructed.endsWith(window.text)).toBe(true);
    expect(textBeforeOldest).toBeLessThan(360);
  });

  it('enters the recording state only after MediaRecorder has actually started', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-recording-state',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    expect(result.current.state.capture).toBe('ready');
    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce());
    expect(desktopApi.startLocalAsr.mock.calls[0]![0].attemptId)
      .not.toContain('session-recording-state');

    act(() => audioRecorder.options?.onRecordingStarted?.());
    expect(result.current.state.capture).toBe('recording');
    expect(result.current.state.asr).toBe('listening');
  });

  it('exposes a snapshot only after its artifact has been persisted and saves it once', async () => {
    const persistence = deferred<PracticeArtifact>();
    desktopApi.savePracticeArtifact.mockReturnValueOnce(persistence.promise);
    const { result, rerender } = renderHook(() => useLivePractice({
      sessionId: 'session-durable-success',
      kind: 'initial',
    }));

    act(() => {
      result.current.runQaSequence();
      result.current.qaSafeEnd();
    });

    await waitFor(() => expect(desktopApi.savePracticeArtifact).toHaveBeenCalledOnce());
    expect(result.current.snapshot).toBeNull();
    expect(result.current.state.frozenSnapshotId).toBeNull();

    act(() => {
      result.current.setFeedbackVisible(false);
      rerender();
    });
    expect(desktopApi.savePracticeArtifact).toHaveBeenCalledOnce();

    const artifact = desktopApi.savePracticeArtifact.mock.calls[0]![0] as PracticeArtifact;
    await act(async () => {
      persistence.resolve(artifact);
      await persistence.promise;
    });

    await waitFor(() => expect(result.current.snapshot?.id).toBe(artifact.id));
    expect(result.current.state.frozenSnapshotId).toBe(artifact.id);
    expect(result.current.state.report).toBe('awaiting_consent');
    expect(desktopApi.savePracticeArtifact).toHaveBeenCalledOnce();
  });

  it('does not auto-retry after failure, then reuses the same snapshot for one explicit retry', async () => {
    const persistence = deferred<PracticeArtifact>();
    const retryPersistence = deferred<PracticeArtifact>();
    desktopApi.savePracticeArtifact
      .mockReturnValueOnce(persistence.promise)
      .mockReturnValueOnce(retryPersistence.promise);
    const { result, rerender } = renderHook(() => useLivePractice({
      sessionId: 'session-durable-failure',
      kind: 'retry',
    }));

    act(() => {
      result.current.runQaSequence();
      result.current.qaSafeEnd();
    });
    await waitFor(() => expect(desktopApi.savePracticeArtifact).toHaveBeenCalledOnce());

    await act(async () => {
      persistence.reject(new Error('disk unavailable'));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.state.report).toBe('failed'));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.state.frozenSnapshotId).toBeNull();
    expect(result.current.state.lastError).toMatch(/冻结快照未能持久化/);

    act(() => {
      result.current.setFeedbackVisible(false);
      result.current.setLocalAnnotations(false);
      rerender();
    });
    await act(async () => Promise.resolve());
    expect(desktopApi.savePracticeArtifact).toHaveBeenCalledOnce();

    const firstArtifact = desktopApi.savePracticeArtifact.mock.calls[0]![0] as PracticeArtifact;
    act(() => {
      result.current.retrySnapshotPersistence();
      result.current.retrySnapshotPersistence();
    });
    await waitFor(() => expect(desktopApi.savePracticeArtifact).toHaveBeenCalledTimes(2));
    expect(desktopApi.savePracticeArtifact.mock.calls[1]![0]).toEqual(firstArtifact);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.state.report).toBe('queued');
    expect(result.current.state.lastError).toBeNull();

    await act(async () => {
      retryPersistence.resolve(firstArtifact);
      await retryPersistence.promise;
    });
    await waitFor(() => expect(result.current.snapshot?.id).toBe(firstArtifact.id));
    expect(result.current.state.frozenSnapshotId).toBe(firstArtifact.id);
    expect(result.current.state.report).toBe('awaiting_consent');
    expect(desktopApi.savePracticeArtifact).toHaveBeenCalledTimes(2);
  });

  it('turns a hung snapshot write into a visible retry instead of hiding the next step forever', async () => {
    vi.useFakeTimers();
    desktopApi.savePracticeArtifact.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-snapshot-timeout',
      kind: 'initial',
    }));

    act(() => {
      result.current.runQaSequence();
      result.current.qaSafeEnd();
    });
    await act(async () => Promise.resolve());
    expect(desktopApi.savePracticeArtifact).toHaveBeenCalledOnce();

    await act(async () => {
      vi.advanceTimersByTime(8_001);
      await Promise.resolve();
    });

    expect(result.current.snapshot).toBeNull();
    expect(result.current.state.report).toBe('failed');
    expect(result.current.state.lastError).toMatch(/冻结快照未能持久化/);
  });

  it('keeps Deep Lane blocked after failure and exposes an explicit retry that unlocks it', async () => {
    window.history.replaceState({}, '', '/?qa=1');
    let persistenceAttempt = 0;
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => {
      persistenceAttempt += 1;
      if (persistenceAttempt === 1) throw new Error('disk unavailable');
      return artifact;
    });
    const onAccept = vi.fn();
    render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={onAccept}
        sessionId="session-page-persistence-failure"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '载入可控 ASR 流' }));
    fireEvent.click(await screen.findByRole('button', { name: '完成尾句收束' }));

    expect(await screen.findByText(/冻结快照未能持久化/)).toBeInTheDocument();
    expect(screen.getByText('Deep Lane 未入队')).toBeInTheDocument();
    expect(screen.getByText('初讲 · 快照保存失败')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: '重试保存快照' });
    expect(retry).toBeEnabled();
    expect(desktopApi.savePracticeArtifact).toHaveBeenCalledOnce();

    fireEvent.click(retry);

    expect(await screen.findByText('Deep Lane 排队')).toBeInTheDocument();
    expect(screen.getByText('初讲快照 v1 · 已持久化')).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: '确认逐字稿' });
    expect(accept).toBeEnabled();
    fireEvent.click(accept);
    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'audio/wav', durationMs: 30_000 }),
      expect.objectContaining({ kind: 'initial' }),
    );
    expect(screen.queryByText(/冻结快照未能持久化/)).not.toBeInTheDocument();
    expect(desktopApi.savePracticeArtifact).toHaveBeenCalledTimes(2);
  });

  it('buffers PCM while ASR starts and waits to flush and stop before freezing', async () => {
    const start = deferred<void>();
    desktopApi.startLocalAsr.mockReturnValue(start.promise);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-fast-stop',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.feedLocalAsr.mockResolvedValue(finalSegment(attemptId));
    const samples = new Float32Array([0.1, 0.2, 0.3]);
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onPcmChunk?.(samples);
      audioRecorder.options?.onStopRequested?.();
      signalUsableRecording();
    });

    expect(result.current.state.capture).toBe('finalizing');
    expect(desktopApi.feedLocalAsr).not.toHaveBeenCalled();
    expect(desktopApi.stopLocalAsr).not.toHaveBeenCalled();
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();

    await act(async () => {
      start.resolve();
      await start.promise;
    });

    await waitFor(() => expect(desktopApi.stopLocalAsr).toHaveBeenCalledOnce());
    expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(desktopApi.feedLocalAsr).toHaveBeenCalledOnce();
    expect(desktopApi.feedLocalAsr.mock.calls[0]![0].samples).toEqual(samples);
    expect(desktopApi.feedLocalAsr.mock.invocationCallOrder[0])
      .toBeLessThan(desktopApi.stopLocalAsr.mock.invocationCallOrder[0]!);
    expect(result.current.snapshot?.finalSegments.map((segment) => segment.text))
      .toEqual(['本周冻结新增需求']);
    expect(result.current.state.capture).toBe('safe_end');
    act(() => audioRecorder.options?.onPcmChunk?.(new Float32Array([0.9])));
    expect(desktopApi.feedLocalAsr).toHaveBeenCalledOnce();
  });

  it('closes a late ASR start after the live attempt unmounts', async () => {
    const start = deferred<void>();
    desktopApi.startLocalAsr.mockReturnValue(start.promise);
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    const { unmount } = renderHook(() => useLivePractice({
      sessionId: 'session-unmounted-start',
      kind: 'initial',
    }));

    act(() => {
      audioRecorder.options?.onPermissionGranted?.();
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1, 0.2]));
    });
    unmount();
    expect(desktopApi.stopLocalAsr).not.toHaveBeenCalled();

    start.resolve();
    await waitFor(() => expect(desktopApi.stopLocalAsr).toHaveBeenCalledOnce());
    expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce();
    expect(desktopApi.feedLocalAsr).not.toHaveBeenCalled();
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();
  });

  it('exits finalizing into an actionable terminal state when ASR start fails', async () => {
    const start = deferred<void>();
    desktopApi.startLocalAsr.mockReturnValue(start.promise);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-start-failure',
      kind: 'initial',
    }));

    act(() => {
      audioRecorder.options?.onPermissionGranted?.();
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1]));
      audioRecorder.options?.onStopRequested?.();
      signalUsableRecording();
    });
    await act(async () => {
      start.reject(new Error('model unavailable'));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.state.asr).toBe('failed'));
    expect(result.current.state.capture).toBe('recorded');
    expect(result.current.state.lastError).toMatch(/启动失败/);
    expect(desktopApi.feedLocalAsr).not.toHaveBeenCalled();
    expect(desktopApi.stopLocalAsr).not.toHaveBeenCalled();
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
  });

  it('does not report a completed tail or freeze when ASR stop fails', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.feedLocalAsr.mockResolvedValue(null);
    desktopApi.stopLocalAsr.mockRejectedValue(new Error('stop failed'));
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-stop-failure',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1]));
      audioRecorder.options?.onStopRequested?.();
      signalUsableRecording();
    });

    await waitFor(() => expect(desktopApi.stopLocalAsr).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.state.asr).toBe('failed'));
    expect(result.current.state.capture).toBe('recorded');
    expect(result.current.state.lastError).toMatch(/停止、超时或尾句收束失败/);
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
  });

  it('keeps a feed failure degraded even when stop later returns a final tail', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.feedLocalAsr.mockRejectedValue(new Error('feed failed'));
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-feed-failure',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.stopLocalAsr.mockResolvedValue(finalSegment(attemptId));
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1]));
      audioRecorder.options?.onStopRequested?.();
      signalUsableRecording();
    });

    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.state.asr).toBe('failed'));
    expect(result.current.state.lastError).toMatch(/流式转写已中断/);
    expect(result.current.state.capture).toBe('recorded');
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
  });

  it('does not replay full PCM after a trusted final already exists and a later feed fails', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-feed-failure-after-final',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.feedLocalAsr
      .mockResolvedValueOnce(finalSegment(attemptId, '第一句已经由本地 ASR 落定。'))
      .mockRejectedValueOnce(new Error('later feed failed'));
    desktopApi.stopLocalAsr.mockResolvedValue(finalSegment(attemptId, '不完整尾句'));

    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1]));
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.2]));
    });
    await waitFor(() => expect(desktopApi.feedLocalAsr).toHaveBeenCalledTimes(2));
    act(() => {
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });

    await waitFor(() => expect(result.current.state.asr).toBe('failed'));
    expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce();
    expect(result.current.state.lastError).toMatch(/流式转写已中断/u);
    expect(result.current.snapshot).toBeNull();
  });

  it('replays the retained local PCM once when the streaming feed fails', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-feed-recovery',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.feedLocalAsr
      .mockRejectedValueOnce(new Error('stream interrupted'))
      .mockResolvedValueOnce(finalSegment(attemptId, '恢复后形成完整 final'));
    desktopApi.stopLocalAsr.mockResolvedValue(null);

    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1, 0.2, 0.3]));
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });

    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.state.capture).toBe('safe_end');
    expect(result.current.state.asr).toBe('ready');
    expect(result.current.snapshot?.finalSegments.map((segment) => segment.text))
      .toEqual(['恢复后形成完整 final']);
    expect(desktopApi.feedLocalAsr).toHaveBeenCalledTimes(2);
  });

  it('stops the recovery recognizer when the page unmounts during replay', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    const recoveryFeed = deferred<TranscriptSegment | null>();
    const { unmount } = renderHook(() => useLivePractice({
      sessionId: 'session-unmounted-recovery',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce());
    desktopApi.feedLocalAsr
      .mockRejectedValueOnce(new Error('stream interrupted'))
      .mockReturnValueOnce(recoveryFeed.promise);
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1, 0.2]));
    });
    await waitFor(() => expect(desktopApi.feedLocalAsr).toHaveBeenCalledOnce());
    act(() => {
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });
    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(desktopApi.feedLocalAsr).toHaveBeenCalledTimes(2));

    unmount();
    recoveryFeed.resolve(null);

    await waitFor(() => expect(desktopApi.stopLocalAsr).toHaveBeenCalledTimes(2));
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();
  });

  it('closes a recovery recognizer that starts after the renderer timeout', async () => {
    vi.useFakeTimers();
    const lateRecoveryStart = deferred<void>();
    desktopApi.startLocalAsr
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(lateRecoveryStart.promise);
    desktopApi.feedLocalAsr.mockRejectedValueOnce(new Error('stream interrupted'));
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    renderHook(() => useLivePractice({
      sessionId: 'session-late-recovery-start',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1, 0.2]));
    });
    await act(async () => Promise.resolve());
    act(() => {
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });
    await act(async () => Promise.resolve());
    expect(desktopApi.startLocalAsr).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(8_001));
    expect(desktopApi.stopLocalAsr).toHaveBeenCalledOnce();

    await act(async () => {
      lateRecoveryStart.resolve();
      await lateRecoveryStart.promise;
      await Promise.resolve();
    });
    expect(desktopApi.stopLocalAsr).toHaveBeenCalledTimes(2);
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();
  });

  it('clears a higher-revision partial before same-audio recovery accepts a fresh final', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-partial-recovery-reset',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    const stalePartial: TranscriptSegment = {
      ...finalSegment(attemptId, '旧的高 revision 临时稿'),
      revision: 7,
      isFinal: false,
      finalizedAt: null,
    };
    desktopApi.feedLocalAsr
      .mockResolvedValueOnce(stalePartial)
      .mockRejectedValueOnce(new Error('stream interrupted'))
      .mockResolvedValueOnce(finalSegment(attemptId, '恢复后落定的 final'))
      .mockResolvedValueOnce(null);
    desktopApi.stopLocalAsr.mockResolvedValue(null);

    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1]));
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.2]));
    });
    await waitFor(() => expect(desktopApi.feedLocalAsr).toHaveBeenCalledTimes(2));
    expect(result.current.state.segments).toEqual([stalePartial]);

    act(() => {
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(desktopApi.startLocalAsr).toHaveBeenCalledTimes(2);
    expect(result.current.state.segments).toEqual([
      expect.objectContaining({
        text: '恢复后落定的 final',
        revision: 1,
        isFinal: true,
      }),
    ]);
    expect(result.current.snapshot?.finalSegments).toHaveLength(1);
    expect(result.current.snapshot?.finalSegments[0]?.text).toBe('恢复后落定的 final');
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: 'asr',
      event: 'live.asr_retry_reset',
    }));
  });

  it('keeps accepting PCM after stop intent until MediaRecorder establishes the final watermark', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.feedLocalAsr.mockResolvedValue(null);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-stop-tail-pcm',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.stopLocalAsr.mockResolvedValue(finalSegment(attemptId, '尾块也已进入转写'));
    const firstHalfSecond = new Float32Array(8_000).fill(0.1);
    const finalHalfSecond = new Float32Array(8_000).fill(0.2);

    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onPcmChunk?.(firstHalfSecond);
    });
    await waitFor(() => expect(desktopApi.feedLocalAsr).toHaveBeenCalledOnce());
    act(() => {
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onPcmChunk?.(finalHalfSecond);
    });
    await waitFor(() => expect(desktopApi.feedLocalAsr).toHaveBeenCalledTimes(2));
    expect(desktopApi.stopLocalAsr).not.toHaveBeenCalled();

    act(() => audioRecorder.options?.onRecordingReady?.(recording()));

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(desktopApi.feedLocalAsr.mock.invocationCallOrder[1])
      .toBeLessThan(desktopApi.stopLocalAsr.mock.invocationCallOrder[0]!);
    expect(result.current.snapshot?.audioWatermark).toBe(1_000);
    expect(result.current.snapshot?.finalSegments[0]?.text).toBe('尾块也已进入转写');
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.capture_summary',
      fields: expect.objectContaining({
        queueLatencySampleCount: 2,
        averageQueueLatencyMs: expect.any(Number),
        maximumQueueLatencyMs: expect.any(Number),
        queueLatencyOver100MsCount: expect.any(Number),
        queueLatencyOver250MsCount: expect.any(Number),
      }),
    }));
  });

  it('recovers 16 kHz PCM from the same MediaRecorder take when live Web Audio emits no chunks', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    recordedAudioDecoder.decode.mockResolvedValue({
      samples: new Float32Array(16_000).fill(0.1),
      sourceSampleRate: 48_000,
      sourceChannelCount: 1,
      durationMs: 1_000,
      rms: 0.1,
      peak: 0.1,
    });
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-media-pcm-fallback',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.feedLocalAsr.mockResolvedValue(
      finalSegment(attemptId, '从同一遍录音恢复了 final'),
    );
    const captured = recording();
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(captured);
    });

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(recordedAudioDecoder.decode).toHaveBeenCalledWith(captured.blob);
    expect(desktopApi.startLocalAsr).toHaveBeenCalledTimes(2);
    expect(desktopApi.feedLocalAsr).toHaveBeenCalledWith(expect.objectContaining({
      attemptId,
      generation: 1,
      samples: expect.any(Float32Array),
    }));
    expect(result.current.snapshot?.finalSegments[0]?.text)
      .toBe('从同一遍录音恢复了 final');
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: 'recording',
      event: 'recording.pcm_recovered_from_media',
      fields: expect.objectContaining({ recoveredSamples: 16_000 }),
    }));
  });

  it('replaces an incomplete live PCM prefix with the full MediaRecorder take after a channel stall', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    desktopApi.feedLocalAsr.mockResolvedValueOnce(null);
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    recordedAudioDecoder.decode.mockResolvedValue({
      samples: new Float32Array(32_000).fill(0.1),
      sourceSampleRate: 48_000,
      sourceChannelCount: 1,
      durationMs: 2_000,
      rms: 0.1,
      peak: 0.1,
    });
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-media-pcm-prefix-replacement',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array(4_096).fill(0.1));
    });
    await waitFor(() => expect(desktopApi.feedLocalAsr).toHaveBeenCalledOnce());
    desktopApi.feedLocalAsr.mockResolvedValue(
      finalSegment(attemptId, '完整录音替换了中断的实时前缀'),
    );
    const captured = recording();
    act(() => {
      audioRecorder.options?.onPcmUnavailable?.('PCM 回调中途停止。');
      audioRecorder.options?.onPcmRecovered?.();
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(captured);
    });

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(recordedAudioDecoder.decode).toHaveBeenCalledWith(captured.blob);
    expect(desktopApi.startLocalAsr).toHaveBeenCalledTimes(2);
    const recoverySamples = desktopApi.feedLocalAsr.mock.calls.slice(1)
      .reduce((total, [input]) => total + input.samples.length, 0);
    expect(recoverySamples).toBe(32_000);
    expect(result.current.snapshot?.finalSegments[0]?.text)
      .toBe('完整录音替换了中断的实时前缀');
  });

  it('keeps a device-interrupted take terminal when MediaRecorder later exposes its audio', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-device-interrupted-ready-late',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce());
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1]));
      audioRecorder.options?.onCaptureInterrupted?.('麦克风设备已断开');
      audioRecorder.options?.onRecordingReady?.(recording());
    });

    await waitFor(() => expect(result.current.state).toMatchObject({
      capture: 'interrupted',
      asr: 'failed',
    }));
    expect(result.current.snapshot).toBeNull();
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();
  });

  it('reports PCM channel failure instead of mislabeling it as no speech', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-pcm-unavailable',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onPcmUnavailable?.('本地 PCM 通道未能启动；请重新录制。');
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });

    await waitFor(() => expect(result.current.state.asr).toBe('failed'));
    expect(result.current.state.capture).toBe('recorded');
    expect(result.current.state.lastError).toMatch(/PCM 通道未能启动/);
    expect(result.current.state.lastError).not.toMatch(/没有检测到有效语音/);
  });

  it('does not freeze an empty transcript when start and stop succeed without a final', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.feedLocalAsr.mockResolvedValue(null);
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-no-final',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1]));
      audioRecorder.options?.onStopRequested?.();
      signalUsableRecording();
    });

    await waitFor(() => expect(desktopApi.stopLocalAsr).toHaveBeenCalledTimes(2));
    expect(desktopApi.startLocalAsr).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.state.asr).toBe('failed'));
    expect(result.current.state.lastError).toMatch(/没有形成可用的 final/);
    expect(result.current.state.capture).toBe('recorded');
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
  });

  it('treats a non-empty ASR final as stronger speech evidence when RMS VAD did not fire', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-quiet-valid-speech',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.stopLocalAsr.mockResolvedValue(finalSegment(
      attemptId,
      '虽然输入音量很低，但本地模型已经形成了有效逐字稿。',
    ));
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.state.voiceDetected).toBe(true);
    expect(result.current.state.capture).toBe('safe_end');
    expect(result.current.state.lastError).toBeNull();
  });

  it('bounds the realtime startup queue and recovers from the retained full PCM', async () => {
    const start = deferred<void>();
    desktopApi.startLocalAsr.mockReturnValue(start.promise);
    desktopApi.feedLocalAsr.mockResolvedValue(null);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-buffer-overflow',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.stopLocalAsr.mockResolvedValue(finalSegment(attemptId));
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      for (let index = 0; index < 40; index += 1) {
        audioRecorder.options?.onPcmChunk?.(new Float32Array(4_096));
      }
      audioRecorder.options?.onStopRequested?.();
      signalUsableRecording();
    });

    expect(result.current.state.lastError).toMatch(/缓冲已满/);
    await act(async () => {
      start.resolve();
      await start.promise;
    });

    await waitFor(() => expect(desktopApi.stopLocalAsr).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(desktopApi.startLocalAsr).toHaveBeenCalledTimes(2);
    expect(desktopApi.startLocalAsr.mock.calls[1]?.[0]).toMatchObject({ restartIfNoFinal: true });
    expect(desktopApi.feedLocalAsr.mock.calls.length).toBeGreaterThanOrEqual(40);
    expect(result.current.state.capture).toBe('safe_end');
    expect(result.current.state.asr).toBe('ready');
  });

  it('bounds the steady-state feed queue and replays retained PCM when inference falls behind', async () => {
    const firstFeed = deferred<TranscriptSegment | null>();
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.feedLocalAsr
      .mockReturnValueOnce(firstFeed.promise)
      .mockResolvedValue(null);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-feed-backpressure',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.stopLocalAsr.mockResolvedValue(finalSegment(attemptId));
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      for (let index = 0; index < 40; index += 1) {
        audioRecorder.options?.onPcmChunk?.(new Float32Array(4_096));
      }
    });

    await waitFor(() => expect(result.current.state.lastError).toMatch(/处理速度跟不上/));
    act(() => {
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });
    await act(async () => firstFeed.resolve(null));

    await waitFor(() => expect(desktopApi.stopLocalAsr).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(desktopApi.startLocalAsr).toHaveBeenCalledTimes(2);
    expect(desktopApi.startLocalAsr.mock.calls[1]?.[0]).toMatchObject({ restartIfNoFinal: true });
    expect(desktopApi.feedLocalAsr.mock.calls.length).toBeGreaterThanOrEqual(40);
    expect(result.current.state.capture).toBe('safe_end');
    expect(result.current.state.asr).toBe('ready');
  });

  it('warns after eight seconds without speech and clears the warning when voice arrives', async () => {
    vi.useFakeTimers();
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-no-speech-warning',
      kind: 'initial',
    }));

    act(() => {
      audioRecorder.options?.onPermissionGranted?.();
      audioRecorder.options?.onRecordingStarted?.();
    });
    expect(result.current.state.asr).toBe('listening');

    act(() => vi.advanceTimersByTime(8_000));
    expect(result.current.state.asr).toBe('no_speech');
    expect(result.current.state.lastError).toMatch(/尚未检测到有效语音/);

    act(() => audioRecorder.options?.onVoiceDetected?.());
    expect(result.current.state.asr).toBe('voice_detected');
    expect(result.current.state.lastError).toBeNull();
  });

  it('requires confirmation before freezing a recording shorter than twenty seconds', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-short-recording',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.stopLocalAsr.mockResolvedValue(finalSegment(attemptId));
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording(12_000));
    });

    await waitFor(() => expect(result.current.shortRecordingPending).toBe(true));
    expect(result.current.state.capture).toBe('recorded');
    expect(result.current.state.asr).toBe('ready');
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();

    act(() => {
      result.current.acceptShortRecording();
      result.current.acceptShortRecording();
    });

    await waitFor(() => expect(result.current.state.capture).toBe('safe_end'));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(desktopApi.savePracticeArtifact).toHaveBeenCalledOnce();
  });

  it('includes annotations from the final stop tail before freezing the snapshot', async () => {
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-tail-annotation',
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.stopLocalAsr.mockResolvedValue(
      finalSegment(attemptId, '就是说，本周冻结新增需求'),
    );
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.snapshot?.finalSegments[0]?.text).toBe('就是说，本周冻结新增需求');
    expect(result.current.snapshot?.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'filler', sourceSpan: expect.objectContaining({ text: '就是说' }) }),
      ]),
    );
  });

  it('drops delayed frozen task context after unmount before reconciling the final tail', async () => {
    const session = createDomainSession({
      id: 'session-unmounted-tail-context',
      modeVersion: '1.0.0-content.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-18T00:00:00.000Z',
    });
    const context = deferred<typeof session>();
    const reconcile = vi.spyOn(shared, 'reconcileFinalTailAnnotations');
    desktopApi.getPracticeSession.mockReturnValue(context.promise);
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result, unmount } = renderHook(() => useLivePractice({
      sessionId: session.id,
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.stopLocalAsr.mockResolvedValue(
      finalSegment(attemptId, '就是说，我们今天先看一下当前情况。'),
    );
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });

    await waitFor(() => expect(result.current.tailAnnotationContextStatus).toBe('loading'));
    expect(reconcile).not.toHaveBeenCalled();
    unmount();
    await act(async () => {
      context.resolve(session);
      await context.promise;
      await Promise.resolve();
    });

    expect(reconcile).not.toHaveBeenCalled();
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();
  });

  it('freezes idempotent structure and task-gap evidence from the session task snapshot', async () => {
    const session = createDomainSession({
      id: 'session-frozen-tail-rules',
      modeVersion: '1.0.0-content.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-18T00:00:00.000Z',
    });
    desktopApi.getPracticeSession.mockResolvedValue(session);
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: session.id,
      kind: 'initial',
    }));

    await waitFor(() => expect(desktopApi.getPracticeSession).toHaveBeenCalledOnce());
    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.stopLocalAsr.mockResolvedValue({
      ...finalSegment(attemptId, '我们今天先看一下当前情况。'),
      endMs: 4_000,
    });
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const tailSignals = result.current.snapshot?.annotations.filter(
      (item) => item.type === 'structure' || item.type === 'task_gap',
    ) ?? [];
    expect(tailSignals.map((item) => item.type)).toEqual(['structure', 'task_gap']);
    expect(tailSignals.every((item) => item.lifecycle === 'confirmed')).toBe(true);
    expect(new Set(tailSignals.map((item) => item.displayId)).size).toBe(2);
    expect(tailSignals.find((item) => item.type === 'task_gap')?.evidence)
      .toMatch(/结论或决定.*理由或论证连接.*冻结成功条件/u);

    act(() => {
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });
    await act(async () => Promise.resolve());
    expect(result.current.state.annotations.filter(
      (item) => item.type === 'structure' || item.type === 'task_gap',
    )).toHaveLength(2);
    expect(desktopApi.getPracticeSession).toHaveBeenCalledOnce();
    expect(desktopApi.savePracticeArtifact).toHaveBeenCalledOnce();
  });

  it('keeps the final tail recoverable when frozen task context is unavailable, then confirms it after retry', async () => {
    const session = createDomainSession({
      id: 'session-tail-context-retry',
      modeVersion: '1.0.0-content.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-18T00:00:00.000Z',
    });
    let contextAvailable = false;
    desktopApi.getPracticeSession.mockImplementation(async () => {
      if (!contextAvailable) throw new Error('database temporarily unavailable');
      return session;
    });
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: session.id,
      kind: 'initial',
    }));

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.stopLocalAsr.mockResolvedValue(
      finalSegment(attemptId, '就是说，我们今天先看一下当前情况。'),
    );
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });

    await waitFor(() => expect(result.current.tailAnnotationContextStatus).toBe('failed'));
    expect(result.current.state.capture).toBe('finalizing');
    expect(result.current.snapshot).toBeNull();
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();
    expect(result.current.tailAnnotationContextError).toMatch(/任务缺口尚未核对.*不会冻结快照/u);
    expect(result.current.state.annotations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'filler', lifecycle: 'confirmed' }),
    ]));
    expect(result.current.state.annotations.some((item) => item.type === 'task_gap')).toBe(false);

    contextAvailable = true;
    act(() => {
      result.current.retryTailAnnotationContext();
      result.current.retryTailAnnotationContext();
    });

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.state.capture).toBe('safe_end');
    expect(result.current.tailAnnotationContextStatus).toBe('ready');
    expect(result.current.tailAnnotationContextError).toBeNull();
    expect(result.current.snapshot?.annotations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task_gap', lifecycle: 'confirmed' }),
    ]));
    expect(result.current.snapshot?.annotations.filter(
      (item) => item.lifecycle !== 'withdrawn',
    ).every((item) => item.lifecycle === 'confirmed')).toBe(true);
    expect(desktopApi.savePracticeArtifact).toHaveBeenCalledOnce();
  });

  it('shows the task-context degradation and gives the user one working recovery action', async () => {
    const session = createDomainSession({
      id: 'session-tail-context-ui',
      modeVersion: '1.0.0-content.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-18T00:00:00.000Z',
    });
    let contextAvailable = false;
    desktopApi.getPracticeSession.mockImplementation(async () => {
      if (!contextAvailable) throw new Error('database temporarily unavailable');
      return session;
    });
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={vi.fn()}
        sessionId={session.id}
      />,
    );

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await waitFor(() => expect(desktopApi.startLocalAsr).toHaveBeenCalledOnce());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    desktopApi.stopLocalAsr.mockResolvedValue(
      finalSegment(attemptId, '我们今天先看一下当前情况。'),
    );
    const captured = recording();
    audioRecorder.status = 'recorded';
    audioRecorder.recordedAudio = captured;
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(captured);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/任务缺口尚未核对.*不会冻结快照/u);
    expect(screen.getByText('任务核对待重试')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: '重试任务核对并冻结' });
    expect(retry).toBeEnabled();
    expect(screen.queryByText('Deep Lane 排队')).not.toBeInTheDocument();
    expect(desktopApi.savePracticeArtifact).not.toHaveBeenCalled();

    contextAvailable = true;
    fireEvent.click(retry);
    expect(await screen.findByText('Deep Lane 排队')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试任务核对并冻结' })).not.toBeInTheDocument();
    await waitFor(() => expect(
      screen.getByRole('button', { name: '继续：确认逐字稿' }),
    ).toBeEnabled());
    expect(desktopApi.savePracticeArtifact).toHaveBeenCalledOnce();
  });

  it('requires per-attempt AI ON and sends cumulative final-only text through the approved cloud boundary', async () => {
    const session = createDomainSession({
      id: 'session-live-cloud',
      modeVersion: '1.0.0-content.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-18T00:00:00.000Z',
    });
    desktopApi.getPracticeSession.mockResolvedValue(session);
    desktopApi.startLocalAsr.mockResolvedValue(undefined);
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    const executeLiveHint = vi.fn().mockResolvedValue({
      hint: '先用一句话说清决定，再展开原因。',
      evidencePhrase: '本周冻结新增需求',
      criterionId: 'decision-request',
    });
    const cancelLiveHint = vi.fn().mockResolvedValue({ cancelled: true });
    const setLiveAttemptAiState = vi.fn(async (input) => input);
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getCloudAiConfiguration: vi.fn().mockResolvedValue({
          provider: 'openai',
          providerName: 'OpenAI',
          model: APPROVED_AI_PROVIDER.model,
          endpoint: APPROVED_AI_PROVIDER.endpoint,
          protocolVersion: APPROVED_AI_PROVIDER.protocolVersion,
          configured: true,
          encryptionAvailable: true,
          keyStorage: 'system_encrypted',
          keyHint: '••••test',
          retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
        }),
        getSettings: vi.fn().mockResolvedValue({
          ...DEFAULT_APP_SETTINGS,
          cloudAi: { ...DEFAULT_APP_SETTINGS.cloudAi, liveHintEnabled: true },
        }),
        getCloudAiConsentStatus: vi.fn().mockResolvedValue({
          purpose: 'live_hint',
          active: true,
          consent: {
            id: 'consent-live-cloud',
            purpose: 'live_hint',
            scope: 'configuration',
            provider: 'openai',
            model: APPROVED_AI_PROVIDER.model,
            endpoint: APPROVED_AI_PROVIDER.endpoint,
            payloadHash: null,
            policyHash: 'a'.repeat(64),
            schemaVersion: 'live-window-1',
            promptVersion: APPROVED_AI_PROVIDER.promptVersion,
            approvedFields: ['finalWindow.text'],
            approvedAt: '2026-07-18T00:00:00.000Z',
            expiresAt: null,
          },
        }),
        executeLiveHint,
        cancelLiveHint,
        setLiveAttemptAiState,
      } as unknown as PhrioDesktopApi,
    });

    const { result } = renderHook(() => useLivePractice({
      sessionId: session.id,
      kind: 'initial',
    }));
    const enableFromPreRefreshRender = result.current.setLiveAi;
    let enabledImmediately = false;
    await act(async () => {
      expect(await result.current.refreshLiveAiReadiness()).toBe('ready');
      enabledImmediately = await enableFromPreRefreshRender(true);
    });
    expect(enabledImmediately).toBe(true);
    await waitFor(() => expect(result.current.state.liveAiConsentValid).toBe(true));
    expect(result.current.state.liveAiEnabled).toBe(true);
    // The reducer commit may occur in the same act; the important guarantee is
    // that an action captured before refresh accepted the newly valid consent.
    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    const attemptId = desktopApi.startLocalAsr.mock.calls[0]![0].attemptId as string;
    await waitFor(() => expect(setLiveAttemptAiState).toHaveBeenCalledWith({
      sessionId: session.id,
      attemptId,
      generation: 1,
      enabled: true,
    }));
    const text = '本周冻结新增需求，因为当前版本仍有两个阻塞问题，需要研发和业务今天确认范围。';
    desktopApi.feedLocalAsr.mockResolvedValue(finalSegment(attemptId, text));
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1, 0.2, 0.3]));
    });

    await waitFor(() => expect(executeLiveHint).toHaveBeenCalledOnce(), { timeout: 2_000 });
    const request = executeLiveHint.mock.calls[0]![0];
    expect(request.payload).toMatchObject({
      purpose: 'live_hint',
      attemptId,
      finalWindow: { text },
    });
    expect(JSON.stringify(request.payload)).not.toMatch(/partial|audio/i);
    await waitFor(() => expect(result.current.state.hints.at(-1)?.text)
      .toBe('先用一句话说清决定，再展开原因。'));
    const liveHintResultEvent = diagnosticsApi.recordDiagnosticEvent.mock.calls
      .map(([input]) => input)
      .find((input) => input.event === 'ai.live_hint_result');
    expect(liveHintResultEvent).toMatchObject({
      level: 'info',
      component: 'ai',
      sessionId: session.id,
      attemptId,
      fields: {
        generation: 1,
        sequence: 1,
        reasonCode: 'accepted',
        stale: false,
      },
    });
    expect(JSON.stringify(liveHintResultEvent)).not.toContain('先用一句话说清决定，再展开原因。');

    await act(async () => result.current.setLiveAi(false));
    expect(result.current.state.liveAiEnabled).toBe(false);
    expect(setLiveAttemptAiState).toHaveBeenLastCalledWith({
      sessionId: session.id,
      attemptId,
      generation: 1,
      enabled: false,
    });
    await act(async () => result.current.setLiveAi(true));
    expect(result.current.state.liveAiEnabled).toBe(true);
    expect(setLiveAttemptAiState).toHaveBeenLastCalledWith({
      sessionId: session.id,
      attemptId,
      generation: 1,
      enabled: true,
    });

    await act(async () => result.current.setLiveAi(false));
    setLiveAttemptAiState.mockRejectedValueOnce(new Error('lease rejected'));
    await act(async () => result.current.setLiveAi(true));
    expect(result.current.state.liveAiEnabled).toBe(false);
    expect(result.current.state.lastError).toMatch(/未能绑定到当前练习/u);

    act(() => audioRecorder.options?.onStopRequested?.());
    await waitFor(() => expect(result.current.state.liveAiEnabled).toBe(false));
    await waitFor(() => expect(setLiveAttemptAiState).toHaveBeenCalledWith({
      sessionId: session.id,
      attemptId,
      generation: 1,
      enabled: false,
      sealed: true,
    }));
    const callsAfterStop = setLiveAttemptAiState.mock.calls.length;
    await act(async () => expect(await result.current.setLiveAi(true)).toBe(false));
    expect(result.current.state.liveAiEnabled).toBe(false);
    expect(setLiveAttemptAiState).toHaveBeenCalledTimes(callsAfterStop);
    expect(cancelLiveHint).toHaveBeenCalledWith({ attemptId });
  });

  it('resets transcript, annotations and snapshot for one idempotent rerecord action', async () => {
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-rerecord',
      kind: 'retry',
    }));

    act(() => {
      result.current.runQaSequence();
      result.current.qaSafeEnd();
    });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.state.segments.length).toBeGreaterThan(0);
    expect(result.current.state.annotations.length).toBeGreaterThan(0);
    const staleCallbacks = audioRecorder.options;

    act(() => {
      result.current.rerecord();
      result.current.rerecord();
    });

    await waitFor(() => expect(result.current.state.generation).toBe(2));
    expect(audioRecorder.reset).toHaveBeenCalledOnce();
    expect(diagnosticsApi.recordDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: 'live',
      event: 'live.attempt_reset',
      sessionId: 'session-rerecord',
      fields: expect.objectContaining({ generation: 1, nextGeneration: 2 }),
    }));
    expect(result.current.state.capture).toBe('awaiting_permission');
    expect(result.current.state.segments).toEqual([]);
    expect(result.current.state.annotations).toEqual([]);
    expect(result.current.state.hints).toEqual([]);
    expect(result.current.snapshot).toBeNull();

    act(() => staleCallbacks?.onRecordingStarted?.());
    expect(result.current.state.capture).toBe('awaiting_permission');

    act(() => {
      result.current.runQaSequence();
      result.current.qaSafeEnd();
    });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const persistedSnapshots = desktopApi.savePracticeArtifact.mock.calls
      .map((call) => call[0] as PracticeArtifact)
      .filter((artifact): artifact is Extract<PracticeArtifact, { type: 'attempt_snapshot' }> => (
        artifact.type === 'attempt_snapshot'
      ));
    expect(persistedSnapshots).toHaveLength(2);
    expect(persistedSnapshots[1]!.id).not.toBe(persistedSnapshots[0]!.id);
    expect(persistedSnapshots[1]!.payload.attemptId)
      .not.toBe(persistedSnapshots[0]!.payload.attemptId);
    expect(persistedSnapshots[1]!.id).toBe(persistedSnapshots[1]!.payload.id);
  });

  it('freezes a direct retry without inventing a focus version', async () => {
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-free-retry-focus',
      kind: 'retry',
      focusVersion: null,
    }));

    act(() => {
      result.current.runQaSequence();
      result.current.qaSafeEnd();
    });

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.snapshot?.focusVersion).toBeNull();
  });

  it('ignores late finalization from the old generation after rerecord', async () => {
    const oldStart = deferred<void>();
    desktopApi.startLocalAsr
      .mockReturnValueOnce(oldStart.promise)
      .mockResolvedValue(undefined);
    desktopApi.stopLocalAsr.mockResolvedValue(null);
    desktopApi.savePracticeArtifact.mockImplementation(async (artifact: PracticeArtifact) => artifact);
    const { result } = renderHook(() => useLivePractice({
      sessionId: 'session-rerecord-late-finalize',
      kind: 'initial',
    }));

    act(() => {
      audioRecorder.options?.onPermissionGranted?.();
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
      result.current.rerecord();
    });
    await waitFor(() => expect(result.current.state.generation).toBe(2));

    await act(async () => oldStart.resolve());
    await waitFor(() => expect(desktopApi.stopLocalAsr).toHaveBeenCalledOnce());
    expect(result.current.state).toMatchObject({ capture: 'awaiting_permission', asr: 'idle' });

    act(() => audioRecorder.options?.onPermissionGranted?.());
    await act(async () => Promise.resolve());
    const newAttemptId = desktopApi.startLocalAsr.mock.calls[1]![0].attemptId as string;
    desktopApi.stopLocalAsr.mockResolvedValueOnce(finalSegment(newAttemptId));
    act(() => {
      audioRecorder.options?.onRecordingStarted?.();
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(recording());
    });

    await waitFor(() => expect(result.current.snapshot?.attemptId).toBe(newAttemptId));
    expect(result.current.state.capture).toBe('safe_end');
    expect(result.current.state.generation).toBe(2);
  });

  it('keeps failed audio playable, explains rererecord recovery, and reports activity changes', async () => {
    const activity = vi.fn();
    desktopApi.startLocalAsr.mockRejectedValue(new Error('model unavailable'));
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getEnvironmentStatus: vi.fn().mockResolvedValue({
          checkedAt: '2026-07-20T00:00:00.000Z',
          dataDirectory: '/test/data',
          trainingRecordCount: 0,
          localAsr: {
            ready: true,
            files: [
              { name: 'encoder.int8.onnx', exists: true, readable: true },
              { name: 'decoder.int8.onnx', exists: true, readable: true },
              { name: 'tokens.txt', exists: true, readable: true },
            ],
          },
        }),
      } as unknown as PhrioDesktopApi,
    });
    const view = render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={vi.fn()}
        onRecordingActivityChange={activity}
        sessionId="session-page-recovery"
      />,
    );

    const captured = recording();
    audioRecorder.status = 'recorded';
    audioRecorder.recordedAudio = captured;
    act(() => {
      audioRecorder.options?.onPermissionGranted?.();
      audioRecorder.options?.onRecordingStarted?.();
    });
    await waitFor(() => expect(activity).toHaveBeenLastCalledWith(true));
    act(() => {
      audioRecorder.options?.onVoiceDetected?.();
      audioRecorder.options?.onPcmChunk?.(new Float32Array([0.1, 0.2, 0.3]));
      audioRecorder.options?.onStopRequested?.();
      audioRecorder.options?.onRecordingReady?.(captured);
    });

    await screen.findByText(/实时转写没有得到完整 final/);
    expect(view.container.querySelector('audio')).toHaveAttribute('src', captured.url);
    expect(screen.getByRole('button', { name: '用这段录音重新转写' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '换输入设备并重录' })).toBeEnabled();
    expect(activity).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: '换输入设备并重录' }));
    expect(audioRecorder.reset).toHaveBeenCalledOnce();
  });
});
