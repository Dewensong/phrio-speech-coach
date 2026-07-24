import {
  CLEAR_TRAINING_DATA_CONFIRMATION,
  RESET_NONSENSITIVE_SETTINGS_CONFIRMATION,
  type ClearTrainingDataOutput,
  type CancelLocalAsrModelInstallOutput,
  type GetEnvironmentStatusOutput,
  type GetLocalAsrModelInstallStatusOutput,
  type InstallLocalAsrModelOutput,
  type ResetNonSensitiveSettingsOutput,
} from '../../shared';

export type MicrophoneAccessState = 'allowed' | 'denied' | 'no_device';
export type MicrophoneTrackState = 'active' | 'inactive' | 'missing';
export type MicrophoneSignalState = 'detected' | 'silent' | 'unavailable';
export type MicrophoneSignalTransport =
  | 'audio_worklet'
  | 'script_processor_fallback'
  | 'unavailable';

export interface MicrophoneAccessResult {
  readonly state: MicrophoneAccessState;
  readonly trackState: MicrophoneTrackState;
  readonly signalState: MicrophoneSignalState;
  readonly transport: MicrophoneSignalTransport;
  readonly pcmCallbackCount: number;
  readonly rms: number;
  readonly peak: number;
  readonly checkedAt: string;
}

// Match the production PCM startup watchdog. A newly-created AudioWorklet can
// take longer than a few render quanta to become observable on a cold launch.
const MICROPHONE_CHECK_WORKLET_GRACE_MS = 1_000;
const MICROPHONE_CHECK_DURATION_MS = 2_000;
const MICROPHONE_CHECK_WORKLET_NAME = 'phrio-microphone-check';
const AUDIO_WORKLET_MODULE_URL = new URL(
  '../worklets/phrio-audio-worklets.js?no-inline',
  import.meta.url,
).href;

async function measureWithScriptProcessor(
  context: AudioContext,
  stream: MediaStream,
): Promise<{
  readonly signalState: MicrophoneSignalState;
  readonly transport: 'script_processor_fallback';
  readonly pcmCallbackCount: number;
  readonly rms: number;
  readonly peak: number;
}> {
  if (typeof context.createScriptProcessor !== 'function') {
    throw new Error('SCRIPT_PROCESSOR_UNAVAILABLE');
  }
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(2_048, 1, 1);
  const sink = context.createGain();
  sink.gain.value = 1;
  let callbacks = 0;
  let frames = 0;
  let squareSum = 0;
  let peak = 0;
  let firstCallback: (() => void) | null = null;
  let callbackTimer: number | null = null;
  try {
    const firstCallbackOrTimeout = new Promise<void>((resolve) => {
      firstCallback = () => {
        if (callbackTimer !== null) window.clearTimeout(callbackTimer);
        callbackTimer = null;
        resolve();
      };
      callbackTimer = window.setTimeout(resolve, MICROPHONE_CHECK_DURATION_MS);
    });
    processor.onaudioprocess = (event) => {
      const inputBuffer = event.inputBuffer;
      const channelCount = inputBuffer.numberOfChannels;
      if (channelCount === 0 || inputBuffer.length === 0) return;
      let callbackSquareSum = 0;
      let callbackPeak = 0;
      for (let frame = 0; frame < inputBuffer.length; frame += 1) {
        let mixed = 0;
        for (let channel = 0; channel < channelCount; channel += 1) {
          mixed += inputBuffer.getChannelData(channel)[frame] ?? 0;
        }
        mixed /= channelCount;
        callbackPeak = Math.max(callbackPeak, Math.abs(mixed));
        callbackSquareSum += mixed * mixed;
      }
      callbacks += 1;
      frames += inputBuffer.length;
      squareSum += callbackSquareSum;
      peak = Math.max(peak, callbackPeak);
      firstCallback?.();
      firstCallback = null;
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    await context.resume();
    await firstCallbackOrTimeout;
    const rms = frames > 0 ? Math.sqrt(squareSum / frames) : 0;
    return {
      signalState: callbacks === 0
        ? 'unavailable'
        : rms >= 0.003 || peak >= 0.015
          ? 'detected'
          : 'silent',
      transport: 'script_processor_fallback',
      pcmCallbackCount: callbacks,
      rms,
      peak,
    };
  } finally {
    if (callbackTimer !== null) window.clearTimeout(callbackTimer);
    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    sink.disconnect();
  }
}

async function measureMicrophoneSignal(stream: MediaStream): Promise<{
  readonly signalState: MicrophoneSignalState;
  readonly transport: MicrophoneSignalTransport;
  readonly pcmCallbackCount: number;
  readonly rms: number;
  readonly peak: number;
}> {
  if (typeof AudioContext === 'undefined') {
    return {
      signalState: 'unavailable', transport: 'unavailable',
      pcmCallbackCount: 0, rms: 0, peak: 0,
    };
  }
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: AudioWorkletNode | null = null;
  let sink: GainNode | null = null;
  let firstCallback: (() => void) | null = null;
  let callbackTimer: number | null = null;
  try {
    context = new AudioContext();
    if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      return await measureWithScriptProcessor(context, stream);
    }
    await context.audioWorklet.addModule(AUDIO_WORKLET_MODULE_URL);
    source = context.createMediaStreamSource(stream);
    processor = new AudioWorkletNode(context, MICROPHONE_CHECK_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    sink = context.createGain();
    // The processor intentionally leaves its output buffer untouched (silence).
    // Keep a non-zero render path so Chromium cannot optimize away the upstream
    // AudioWorklet before it posts the input metrics we are measuring.
    sink.gain.value = 1;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    let callbacks = 0;
    let frames = 0;
    let squareSum = 0;
    let peak = 0;
    const firstCallbackOrTimeout = new Promise<void>((resolve) => {
      firstCallback = () => {
        if (callbackTimer !== null) window.clearTimeout(callbackTimer);
        callbackTimer = null;
        resolve();
      };
      callbackTimer = window.setTimeout(resolve, MICROPHONE_CHECK_WORKLET_GRACE_MS);
    });
    processor.port.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data as {
        readonly type?: string;
        readonly frames?: number;
        readonly squareSum?: number;
        readonly peak?: number;
      };
      if (
        message.type !== 'metrics'
        || !Number.isFinite(message.frames)
        || !Number.isFinite(message.squareSum)
        || !Number.isFinite(message.peak)
      ) return;
      callbacks += 1;
      frames += message.frames!;
      squareSum += message.squareSum!;
      peak = Math.max(peak, message.peak!);
      firstCallback?.();
      firstCallback = null;
    };
    processor.port.start();
    await context.resume();
    await firstCallbackOrTimeout;
    if (callbacks === 0) {
      processor.port.onmessage = null;
      processor.port.close();
      processor.disconnect();
      source.disconnect();
      sink.disconnect();
      processor = null;
      source = null;
      sink = null;
      return await measureWithScriptProcessor(context, stream);
    }
    const rms = frames > 0 ? Math.sqrt(squareSum / frames) : 0;
    return {
      signalState: rms >= 0.003 || peak >= 0.015 ? 'detected' : 'silent',
      transport: 'audio_worklet',
      pcmCallbackCount: callbacks,
      rms,
      peak,
    };
  } catch {
    processor?.port.close();
    processor?.disconnect();
    source?.disconnect();
    sink?.disconnect();
    processor = null;
    source = null;
    sink = null;
    if (context) {
      try {
        return await measureWithScriptProcessor(context, stream);
      } catch {
        // Fall through to the explicit unavailable result below.
      }
    }
    return {
      signalState: 'unavailable', transport: 'unavailable',
      pcmCallbackCount: 0, rms: 0, peak: 0,
    };
  } finally {
    if (callbackTimer !== null) window.clearTimeout(callbackTimer);
    if (processor) processor.port.onmessage = null;
    processor?.port.close();
    processor?.disconnect();
    source?.disconnect();
    sink?.disconnect();
    await context?.close().catch(() => undefined);
  }
}

function desktopApi() {
  if (typeof window === 'undefined' || !window.phrio) {
    throw new Error('PHRIO_DESKTOP_BRIDGE_UNAVAILABLE');
  }
  return window.phrio;
}

export function getEnvironmentStatus(): Promise<GetEnvironmentStatusOutput> {
  return desktopApi().getEnvironmentStatus();
}

export function installLocalAsrModel(): Promise<InstallLocalAsrModelOutput> {
  return desktopApi().installLocalAsrModel();
}

export function getLocalAsrModelInstallStatus(): Promise<GetLocalAsrModelInstallStatusOutput> {
  return desktopApi().getLocalAsrModelInstallStatus();
}

export function cancelLocalAsrModelInstall(): Promise<CancelLocalAsrModelInstallOutput> {
  return desktopApi().cancelLocalAsrModelInstall();
}

export function formatLocalAsrModelInstallProgress(
  status: GetLocalAsrModelInstallStatusOutput,
): string {
  const stageLabels: Readonly<Record<GetLocalAsrModelInstallStatusOutput['stage'], string>> = {
    idle: '等待安装',
    paused: '已保留下载进度',
    preparing: '正在检查磁盘与清理临时文件',
    downloading: '正在下载转写模型',
    verifying: '正在校验模型完整性',
    extracting: '正在解压三个运行文件',
    promoting: '正在安全写入本地模型',
    cancelling: '正在取消并清理临时文件',
    completed: '模型安装完成',
    cancelled: '模型安装已取消',
    failed: '模型安装失败',
  };
  if (status.stage !== 'downloading' && status.stage !== 'paused') {
    return stageLabels[status.stage];
  }
  const sourceLabel = status.source === 'accelerated_direct'
    ? '加速直连'
    : status.source === 'huggingface_direct'
      ? '官方直连'
      : status.source === 'github_release_archive'
        ? 'GitHub 备用源'
        : null;
  const downloadedMegabytes = status.downloadedBytes / (1_024 * 1_024);
  const expectedMegabytes = status.expectedBytes / (1_024 * 1_024);
  const percentage = Math.min(100, Math.floor(
    (status.downloadedBytes / status.expectedBytes) * 100,
  ));
  const fallbackLabel = status.source === 'github_release_archive'
    && status.lastRecoverableErrorCode
    ? '官方三文件源结构不兼容，已切换约 1 GB 备用整包'
    : null;
  return [
    stageLabels[status.stage],
    fallbackLabel,
    sourceLabel,
    `${downloadedMegabytes.toFixed(1)} / ${expectedMegabytes.toFixed(1)} MB`,
    `${percentage}%`,
  ].filter(Boolean).join(' · ');
}

export function clearTrainingData(): Promise<ClearTrainingDataOutput> {
  return desktopApi().clearTrainingData({
    confirmation: CLEAR_TRAINING_DATA_CONFIRMATION,
  });
}

export function resetNonSensitiveSettings(): Promise<ResetNonSensitiveSettingsOutput> {
  return desktopApi().resetNonSensitiveSettings({
    confirmation: RESET_NONSENSITIVE_SETTINGS_CONFIRMATION,
  });
}

export async function checkMicrophoneAccess(
  mediaDevices: MediaDevices | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
): Promise<MicrophoneAccessResult> {
  if (!mediaDevices?.getUserMedia) {
    return {
      state: 'no_device',
      trackState: 'missing',
      signalState: 'unavailable',
      transport: 'unavailable',
      pcmCallbackCount: 0,
      rms: 0,
      peak: 0,
      checkedAt: new Date().toISOString(),
    };
  }

  let stream: MediaStream | null = null;
  try {
    stream = await mediaDevices.getUserMedia({ audio: true, video: false });
    const audioTrack = stream.getAudioTracks?.()[0]
      ?? stream.getTracks().find((track) => track.kind === 'audio')
      ?? null;
    const trackState: MicrophoneTrackState = !audioTrack
      ? 'missing'
      : audioTrack.readyState === 'ended' || audioTrack.enabled === false
        ? 'inactive'
        : 'active';
    const signal = trackState === 'active'
      ? await measureMicrophoneSignal(stream)
      : {
        signalState: 'unavailable' as const,
        transport: 'unavailable' as const,
        pcmCallbackCount: 0,
        rms: 0,
        peak: 0,
      };
    return {
      state: 'allowed',
      trackState,
      ...signal,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const name = error instanceof DOMException || error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return {
        state: 'denied', trackState: 'missing', signalState: 'unavailable',
        transport: 'unavailable',
        pcmCallbackCount: 0, rms: 0, peak: 0, checkedAt: new Date().toISOString(),
      };
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return {
        state: 'no_device', trackState: 'missing', signalState: 'unavailable',
        transport: 'unavailable',
        pcmCallbackCount: 0, rms: 0, peak: 0, checkedAt: new Date().toISOString(),
      };
    }
    throw error;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}
