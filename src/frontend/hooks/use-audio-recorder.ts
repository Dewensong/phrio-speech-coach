import { useCallback, useEffect, useRef, useState } from 'react';

import { recordDiagnosticEvent } from '../services/diagnostics-api';

export type RecorderStatus =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'recorded'
  | 'error';

export interface RecordedAudio {
  blob: Blob;
  url: string;
  mimeType: string;
  durationMs: number;
}

export type AudioInputHealthStatus = 'unknown' | 'healthy' | 'silent';

export interface AudioInputDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly isDefault: boolean;
}

export interface AudioInputTrackSettings {
  readonly sampleRate: number | null;
  readonly channelCount: number | null;
  readonly autoGainControl: boolean | null;
  readonly echoCancellation: boolean | null;
  readonly noiseSuppression: boolean | null;
}

export interface AudioInputHealth {
  readonly status: AudioInputHealthStatus;
  readonly trackLabel: string | null;
  readonly deviceId: string | null;
  readonly trackSettings: AudioInputTrackSettings;
  readonly pcmCallbackCount: number;
  readonly peak: number;
  readonly rms: number;
  readonly inputSampleRate: number | null;
  readonly outputSampleRate: 16_000;
}

export interface AudioRecorderOptions {
  readonly sessionId?: string;
  readonly attemptId?: string;
  readonly captureId?: string;
  readonly onPermissionGranted?: () => void;
  readonly onPermissionDenied?: (message: string) => void;
  readonly onRecordingStarted?: () => void;
  readonly onRecordingReady?: (recording: RecordedAudio) => void;
  readonly onVoiceDetected?: () => void;
  readonly onPcmChunk?: (samples: Float32Array) => void;
  readonly onPcmUnavailable?: (message: string, degradationCode: string) => void;
  readonly onPcmRecovered?: () => void;
  readonly onInputSilence?: (health: AudioInputHealth) => void;
  readonly onStopRequested?: () => void;
  readonly onCaptureInterrupted?: (message: string) => void;
  readonly onCaptureError?: (message: string) => void;
}

const MAX_RECORDING_MS = 5 * 60 * 1000;
const STOP_EVENT_TIMEOUT_MS = 5_000;
const PCM_START_TIMEOUT_MS = 2_000;
const PCM_RECOVERY_GRACE_MS = 1_000;
const PCM_CAPTURE_GAP_TOLERANCE_MS = 500;
const PCM_STOP_TAIL_GRACE_MS = 300;
const PCM_FLUSH_TIMEOUT_MS = 1_000;
const ASR_SAMPLE_RATE = 16_000 as const;
const HEALTHY_RMS_THRESHOLD = 0.003;
const HEALTHY_PEAK_THRESHOLD = 0.015;
const VOICE_RMS_THRESHOLD = 0.006;
const VOICE_PEAK_THRESHOLD = 0.025;
const NEAR_SILENT_DURATION_SECONDS = 2;
const SPEECH_ACTIVATION_SECONDS = 0.24;
const SPEECH_HANGOVER_SECONDS = 0.4;
const AUDIO_WORKLET_PROCESSOR_NAME = 'phrio-pcm-capture';
const AUDIO_WORKLET_MODULE_URL = new URL(
  '../worklets/phrio-audio-worklets.js?no-inline',
  import.meta.url,
).href;
// Electron builds can expose AudioWorklet while never scheduling its render
// callback. ScriptProcessor is intentionally retained only as a bounded local
// compatibility transport so real-time ASR does not disappear in that state.
const SCRIPT_PROCESSOR_BLOCK_FRAMES = 2_048;

type PcmCaptureTransport = 'audio_worklet' | 'script_processor_fallback';
type PcmWatchdogScheduler = (
  delayMs: number,
  reasonCode: string,
  allowResumeRecovery: boolean,
  allowFallbackRecovery: boolean,
) => void;

const EMPTY_TRACK_SETTINGS: AudioInputTrackSettings = {
  sampleRate: null,
  channelCount: null,
  autoGainControl: null,
  echoCancellation: null,
  noiseSuppression: null,
};

const EMPTY_INPUT_HEALTH: AudioInputHealth = {
  status: 'unknown',
  trackLabel: null,
  deviceId: null,
  trackSettings: EMPTY_TRACK_SETTINGS,
  pcmCallbackCount: 0,
  peak: 0,
  rms: 0,
  inputSampleRate: null,
  outputSampleRate: ASR_SAMPLE_RATE,
};

interface StreamingResamplerState {
  inputSampleRate: number;
  totalInputSamples: number;
  nextOutputPosition: number;
  previousSample: number | null;
}

function createStreamingResamplerState(inputSampleRate: number): StreamingResamplerState {
  return {
    inputSampleRate,
    totalInputSamples: 0,
    nextOutputPosition: 0,
    previousSample: null,
  };
}

/**
 * Resamples consecutive PCM chunks without resetting phase at chunk boundaries.
 * AudioContext is allowed to ignore the requested sample rate, so ASR must only
 * ever receive samples that are actually spaced at 16 kHz.
 */
function resamplePcmChunkTo16Khz(
  samples: Float32Array,
  state: StreamingResamplerState,
): Float32Array {
  if (samples.length === 0) return new Float32Array();
  if (state.inputSampleRate === ASR_SAMPLE_RATE) {
    state.totalInputSamples += samples.length;
    state.previousSample = samples[samples.length - 1] ?? state.previousSample;
    return new Float32Array(samples);
  }

  const ratio = state.inputSampleRate / ASR_SAMPLE_RATE;
  const chunkStart = state.totalInputSamples;
  const chunkEnd = chunkStart + samples.length - 1;
  const output: number[] = [];

  while (state.nextOutputPosition <= chunkEnd) {
    const lowerIndex = Math.floor(state.nextOutputPosition);
    const upperIndex = Math.ceil(state.nextOutputPosition);
    if (upperIndex > chunkEnd) break;

    const lowerSample = lowerIndex < chunkStart
      ? state.previousSample
      : samples[lowerIndex - chunkStart];
    const upperSample = samples[upperIndex - chunkStart];
    if (lowerSample === null || lowerSample === undefined || upperSample === undefined) break;

    const fraction = state.nextOutputPosition - lowerIndex;
    output.push(lowerSample + ((upperSample - lowerSample) * fraction));
    state.nextOutputPosition += ratio;
  }

  state.totalInputSamples += samples.length;
  state.previousSample = samples[samples.length - 1] ?? state.previousSample;
  return Float32Array.from(output);
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function publicTrackSettings(settings: MediaTrackSettings): AudioInputTrackSettings {
  return {
    sampleRate: nullableNumber(settings.sampleRate),
    channelCount: nullableNumber(settings.channelCount),
    autoGainControl: nullableBoolean(settings.autoGainControl),
    echoCancellation: nullableBoolean(settings.echoCancellation),
    noiseSuppression: nullableBoolean(settings.noiseSuppression),
  };
}

function recordRecorderDiagnosticRaw(input: Parameters<typeof recordDiagnosticEvent>[0]): void {
  try {
    void recordDiagnosticEvent(input).catch(() => undefined);
  } catch {
    // Diagnostics must never change the capture lifecycle.
  }
}

interface AudioWorkletFlushMessage {
  readonly type: 'flushed';
  readonly requestId: string;
  readonly sequence: number;
  readonly frameCount: number;
}

function mimeCategory(mimeType: string): string {
  const match = /^audio\/([a-z0-9.+-]+)/iu.exec(mimeType);
  return match?.[1]?.toLowerCase() ?? 'unknown';
}

function supportedMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

export function useAudioRecorder(options: AudioRecorderOptions = {}) {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordedAudio, setRecordedAudio] = useState<RecordedAudio>();
  const [error, setError] = useState<string>();
  const [inputDevices, setInputDevices] = useState<AudioInputDevice[]>([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState<string | null>(null);
  const [inputHealth, setInputHealth] = useState<AudioInputHealth>(EMPTY_INPUT_HEALTH);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef(0);
  const stopRequestedElapsedMsRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const maximumTimerRef = useRef<number | null>(null);
  const stopEventTimerRef = useRef<number | null>(null);
  const recorderStopDelayTimerRef = useRef<number | null>(null);
  const pcmWatchdogTimerRef = useRef<number | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const recordingGenerationRef = useRef(0);
  const optionsRef = useRef(options);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silentSinkRef = useRef<GainNode | null>(null);
  const activePcmTransportRef = useRef<PcmCaptureTransport | null>(null);
  const lastPcmTransportRef = useRef<PcmCaptureTransport | null>(null);
  const pcmWatchdogSchedulerRef = useRef<PcmWatchdogScheduler | null>(null);
  const voiceDetectedRef = useRef(false);
  const startGenerationRef = useRef<number | null>(null);
  const stopRequestedRef = useRef(false);
  const intentionalStopRef = useRef(false);
  const interruptionHandledRef = useRef(false);
  const trackListenerCleanupRef = useRef<(() => void)[]>([]);
  const selectedInputDeviceIdRef = useRef<string | null>(null);
  const inputHealthRef = useRef<AudioInputHealth>(EMPTY_INPUT_HEALTH);
  const pcmCallbackCountRef = useRef(0);
  const asrOutputSampleCountRef = useRef(0);
  const nearSilentInputFramesRef = useRef(0);
  const inputSignalLoggedRef = useRef(false);
  const resamplerRef = useRef<StreamingResamplerState | null>(null);
  const mediaChunkCountRef = useRef(0);
  const mediaChunkBytesRef = useRef(0);
  const pcmUnavailableReportedRef = useRef(false);
  const audioContextRecoveryAttemptedRef = useRef(false);
  const audioContextStateCleanupRef = useRef<(() => void) | null>(null);
  const captureIdRef = useRef<string | null>(null);
  const captureSessionIdRef = useRef<string | null>(null);
  const captureAttemptIdRef = useRef<string | null>(null);
  const pcmInputFrameCountRef = useRef(0);
  const pcmSquareSumRef = useRef(0);
  const pcmSilentFrameCountRef = useRef(0);
  const pcmMaximumPeakRef = useRef(0);
  const workletExpectedSequenceRef = useRef(0);
  const workletFrameCountRef = useRef(0);
  const pendingFlushesRef = useRef(new Map<string, (message: AudioWorkletFlushMessage) => void>());
  const speechCandidateFramesRef = useRef(0);
  const speechHangoverFramesRef = useRef(0);

  optionsRef.current = options;

  const recordRecorderDiagnostic = useCallback((
    input: Parameters<typeof recordDiagnosticEvent>[0],
  ): void => {
    const sessionId = captureSessionIdRef.current;
    const attemptId = captureAttemptIdRef.current;
    recordRecorderDiagnosticRaw({
      ...input,
      ...(sessionId ? { sessionId } : {}),
      ...(attemptId ? { attemptId } : {}),
      fields: {
        captureId: captureIdRef.current ?? 'capture-not-started',
        ...input.fields,
      },
    });
  }, []);

  const stopAudioAnalysis = useCallback(() => {
    if (pcmWatchdogTimerRef.current) window.clearTimeout(pcmWatchdogTimerRef.current);
    pcmWatchdogTimerRef.current = null;
    audioContextStateCleanupRef.current?.();
    audioContextStateCleanupRef.current = null;
    pcmWatchdogSchedulerRef.current = null;
    activePcmTransportRef.current = null;
    if (processorRef.current) processorRef.current.port.onmessage = null;
    processorRef.current?.disconnect();
    processorRef.current?.port.close();
    if (scriptProcessorRef.current) scriptProcessorRef.current.onaudioprocess = null;
    scriptProcessorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    silentSinkRef.current?.disconnect();
    void audioContextRef.current?.close().catch(() => undefined);
    processorRef.current = null;
    scriptProcessorRef.current = null;
    sourceRef.current = null;
    silentSinkRef.current = null;
    audioContextRef.current = null;
    resamplerRef.current = null;
    for (const resolve of pendingFlushesRef.current.values()) {
      resolve({
        type: 'flushed',
        requestId: 'capture-closed',
        sequence: workletExpectedSequenceRef.current,
        frameCount: workletFrameCountRef.current,
      });
    }
    pendingFlushesRef.current.clear();
  }, []);

  const publishInputHealth = useCallback((health: AudioInputHealth) => {
    inputHealthRef.current = health;
    if (mountedRef.current) setInputHealth(health);
  }, []);

  const handlePcmSamples = useCallback((
    samples: Float32Array,
    inputSampleRate: number,
    transport: PcmCaptureTransport,
    recordingGeneration: number,
    metadata?: { readonly sequence: number; readonly frameCount: number },
  ) => {
    if (
      recordingGenerationRef.current !== recordingGeneration
      || activePcmTransportRef.current !== transport
      || samples.length === 0
    ) return;
    if (pcmWatchdogTimerRef.current) {
      window.clearTimeout(pcmWatchdogTimerRef.current);
      pcmWatchdogTimerRef.current = null;
    }
    if (pcmUnavailableReportedRef.current) {
      pcmUnavailableReportedRef.current = false;
      audioContextRecoveryAttemptedRef.current = false;
      recordRecorderDiagnostic({
        level: 'info',
        component: 'recording',
        event: 'recording.pcm_channel_recovered',
        fields: {
          generation: recordingGeneration,
          pcmCallbackCount: pcmCallbackCountRef.current + 1,
          transport,
        },
      });
      optionsRef.current.onPcmRecovered?.();
    }

    let squareSum = 0;
    let peak = 0;
    for (const sample of samples) {
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
      squareSum += sample * sample;
    }
    const rms = Math.sqrt(squareSum / samples.length);
    pcmCallbackCountRef.current += 1;
    pcmInputFrameCountRef.current += samples.length;
    pcmSquareSumRef.current += squareSum;
    pcmMaximumPeakRef.current = Math.max(pcmMaximumPeakRef.current, peak);
    const pcmCallbackCount = pcmCallbackCountRef.current;
    if (pcmCallbackCount === 1) {
      recordRecorderDiagnostic({
        level: 'info',
        component: 'recording',
        event: 'recording.pcm_started',
        fields: {
          generation: recordingGeneration,
          inputSampleRate,
          outputSampleRate: ASR_SAMPLE_RATE,
          inputFrames: samples.length,
          transport,
          ...(metadata ?? {}),
        },
      });
    }

    const previousHealth = inputHealthRef.current;
    const hasSignal = rms >= HEALTHY_RMS_THRESHOLD || peak >= HEALTHY_PEAK_THRESHOLD;
    let healthStatus = previousHealth.status;
    if (hasSignal) {
      nearSilentInputFramesRef.current = 0;
      healthStatus = 'healthy';
      if (!inputSignalLoggedRef.current || previousHealth.status === 'silent') {
        recordRecorderDiagnostic({
          level: 'info',
          component: 'recording',
          event: previousHealth.status === 'silent'
            ? 'recording.input_signal_recovered'
            : 'recording.input_signal_detected',
          fields: {
            generation: recordingGeneration,
            pcmCallbackCount,
            peak,
            rms,
            signalType: 'energy',
            transport,
          },
        });
      }
      inputSignalLoggedRef.current = true;
    } else {
      pcmSilentFrameCountRef.current += samples.length;
      nearSilentInputFramesRef.current += samples.length;
      const nearSilentSeconds = nearSilentInputFramesRef.current / inputSampleRate;
      if (
        nearSilentSeconds >= NEAR_SILENT_DURATION_SECONDS
        && previousHealth.status !== 'silent'
      ) {
        healthStatus = 'silent';
        const silentHealth: AudioInputHealth = {
          ...previousHealth,
          status: healthStatus,
          pcmCallbackCount,
          peak,
          rms,
          inputSampleRate,
        };
        recordRecorderDiagnostic({
          level: 'warn',
          component: 'recording',
          event: 'recording.input_near_silent',
          fields: {
            generation: recordingGeneration,
            pcmCallbackCount,
            peak,
            rms,
            nearSilentSeconds,
            transport,
          },
        });
        optionsRef.current.onInputSilence?.(silentHealth);
      }
    }
    publishInputHealth({
      ...previousHealth,
      status: healthStatus,
      pcmCallbackCount,
      peak,
      rms,
      inputSampleRate,
    });

    const speechEnergy = rms >= VOICE_RMS_THRESHOLD
      || (rms >= HEALTHY_RMS_THRESHOLD && peak >= VOICE_PEAK_THRESHOLD);
    if (speechEnergy) {
      speechCandidateFramesRef.current += samples.length;
      speechHangoverFramesRef.current = 0;
    } else if (speechCandidateFramesRef.current > 0) {
      speechHangoverFramesRef.current += samples.length;
      if (speechHangoverFramesRef.current >= inputSampleRate * SPEECH_HANGOVER_SECONDS) {
        speechCandidateFramesRef.current = 0;
        speechHangoverFramesRef.current = 0;
      }
    }
    if (
      !voiceDetectedRef.current
      && speechCandidateFramesRef.current >= inputSampleRate * SPEECH_ACTIVATION_SECONDS
    ) {
      voiceDetectedRef.current = true;
      recordRecorderDiagnostic({
        level: 'info',
        component: 'vad',
        event: 'vad.speech_detected',
        fields: {
          generation: recordingGeneration,
          activationMs: Math.round(
            (speechCandidateFramesRef.current / inputSampleRate) * 1_000,
          ),
          rms,
          peak,
          transport,
        },
      });
      optionsRef.current.onVoiceDetected?.();
    }
    const resampler = resamplerRef.current;
    if (!resampler) return;
    const asrSamples = resamplePcmChunkTo16Khz(samples, resampler);
    if (asrSamples.length > 0) {
      asrOutputSampleCountRef.current += asrSamples.length;
      optionsRef.current.onPcmChunk?.(asrSamples);
    }
    pcmWatchdogSchedulerRef.current?.(
      PCM_START_TIMEOUT_MS,
      transport === 'audio_worklet'
        ? 'pcm_callback_stalled'
        : 'script_processor_callback_stalled',
      transport === 'audio_worklet',
      transport === 'audio_worklet',
    );
  }, [publishInputHealth, recordRecorderDiagnostic]);

  const startScriptProcessorFallback = useCallback((
    stream: MediaStream,
    recordingGeneration: number,
    reasonCode: string,
  ): boolean => {
    if (
      recordingGenerationRef.current !== recordingGeneration
      || stopRequestedRef.current
      || mediaRecorderRef.current?.state !== 'recording'
    ) return false;
    if (activePcmTransportRef.current === 'script_processor_fallback') return true;
    if (typeof AudioContext === 'undefined') return false;

    const previousTransport = activePcmTransportRef.current ?? 'unavailable';
    stopAudioAnalysis();
    try {
      const audioContext = new AudioContext({ sampleRate: ASR_SAMPLE_RATE });
      if (typeof audioContext.createScriptProcessor !== 'function') {
        void audioContext.close().catch(() => undefined);
        return false;
      }
      const source = audioContext.createMediaStreamSource(stream);
      const scriptProcessor = audioContext.createScriptProcessor(
        SCRIPT_PROCESSOR_BLOCK_FRAMES,
        1,
        1,
      );
      const silentSink = audioContext.createGain();
      silentSink.gain.value = 1;
      const inputSampleRate = Math.round(audioContext.sampleRate);

      audioContextRef.current = audioContext;
      sourceRef.current = source;
      scriptProcessorRef.current = scriptProcessor;
      silentSinkRef.current = silentSink;
      activePcmTransportRef.current = 'script_processor_fallback';
      lastPcmTransportRef.current = 'script_processor_fallback';
      resamplerRef.current = createStreamingResamplerState(inputSampleRate);
      audioContextRecoveryAttemptedRef.current = false;
      publishInputHealth({ ...inputHealthRef.current, inputSampleRate });

      const reportFallbackUnavailable = (fallbackReasonCode: string) => {
        if (
          recordingGenerationRef.current !== recordingGeneration
          || activePcmTransportRef.current !== 'script_processor_fallback'
          || pcmUnavailableReportedRef.current
        ) return;
        pcmUnavailableReportedRef.current = true;
        recordRecorderDiagnostic({
          level: 'warn',
          component: 'recording',
          event: 'recording.pcm_unavailable',
          fields: {
            generation: recordingGeneration,
            reasonCode: fallbackReasonCode,
            audioContextState: String(audioContext.state),
            pcmCallbackCount: pcmCallbackCountRef.current,
            transport: 'script_processor_fallback',
          },
        });
        optionsRef.current.onPcmUnavailable?.(
          '兼容 PCM 通道仍未收到音频；录音会继续，停止后将从同一遍录音恢复完整转写。',
          fallbackReasonCode,
        );
      };
      let fallbackResumeAttempted = false;
      const scheduleFallbackWatchdog: PcmWatchdogScheduler = (
        delayMs,
        fallbackReasonCode,
        allowResumeRecovery,
      ) => {
        if (pcmWatchdogTimerRef.current) window.clearTimeout(pcmWatchdogTimerRef.current);
        const observedCallbackCount = pcmCallbackCountRef.current;
        pcmWatchdogTimerRef.current = window.setTimeout(() => {
          pcmWatchdogTimerRef.current = null;
          if (
            recordingGenerationRef.current !== recordingGeneration
            || stopRequestedRef.current
            || activePcmTransportRef.current !== 'script_processor_fallback'
            || pcmCallbackCountRef.current > observedCallbackCount
          ) return;
          recordRecorderDiagnostic({
            level: 'warn',
            component: 'recording',
            event: 'recording.pcm_stalled',
            fields: {
              generation: recordingGeneration,
              reasonCode: fallbackReasonCode,
              audioContextState: String(audioContext.state),
              pcmCallbackCount: pcmCallbackCountRef.current,
              transport: 'script_processor_fallback',
            },
          });
          if (
            allowResumeRecovery
            && audioContext.state !== 'running'
            && !fallbackResumeAttempted
          ) {
            fallbackResumeAttempted = true;
            void audioContext.resume().catch(() => {
              reportFallbackUnavailable('script_processor_audio_context_resume_failed');
            });
            scheduleFallbackWatchdog(
              PCM_RECOVERY_GRACE_MS,
              'script_processor_callback_missing_after_resume',
              false,
              false,
            );
            return;
          }
          reportFallbackUnavailable(fallbackReasonCode);
        }, delayMs);
      };
      pcmWatchdogSchedulerRef.current = scheduleFallbackWatchdog;

      scriptProcessor.onaudioprocess = (event) => {
        if (activePcmTransportRef.current !== 'script_processor_fallback') return;
        const inputBuffer = event.inputBuffer;
        const channelCount = inputBuffer.numberOfChannels;
        if (channelCount === 0 || inputBuffer.length === 0) return;
        const samples = new Float32Array(inputBuffer.length);
        for (let channel = 0; channel < channelCount; channel += 1) {
          const channelSamples = inputBuffer.getChannelData(channel);
          for (let frame = 0; frame < samples.length; frame += 1) {
            samples[frame] += (channelSamples[frame] ?? 0) / channelCount;
          }
        }
        handlePcmSamples(
          samples,
          inputSampleRate,
          'script_processor_fallback',
          recordingGeneration,
        );
      };
      source.connect(scriptProcessor);
      scriptProcessor.connect(silentSink);
      silentSink.connect(audioContext.destination);
      recordRecorderDiagnostic({
        level: 'warn',
        component: 'recording',
        event: 'recording.pcm_transport_fallback_activated',
        fields: {
          generation: recordingGeneration,
          reasonCode,
          from: previousTransport,
          to: 'script_processor_fallback',
          transport: 'script_processor_fallback',
          inputSampleRate,
        },
      });
      scheduleFallbackWatchdog(
        PCM_START_TIMEOUT_MS,
        'script_processor_callback_start_timeout',
        true,
        false,
      );
      void audioContext.resume().catch(() => {
        reportFallbackUnavailable('script_processor_audio_context_resume_failed');
      });
      return true;
    } catch {
      stopAudioAnalysis();
      return false;
    }
  }, [handlePcmSamples, publishInputHealth, recordRecorderDiagnostic, stopAudioAnalysis]);

  const refreshInputDevices = useCallback(async (): Promise<AudioInputDevice[]> => {
    const enumerateDevices = navigator.mediaDevices?.enumerateDevices;
    if (typeof enumerateDevices !== 'function') return [];
    try {
      const devices = (await enumerateDevices.call(navigator.mediaDevices))
        .filter((device) => device.kind === 'audioinput')
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label,
          isDefault: device.deviceId === 'default',
        } satisfies AudioInputDevice));
      if (mountedRef.current) setInputDevices(devices);
      return devices;
    } catch {
      return [];
    }
  }, []);

  const selectInputDevice = useCallback((deviceId: string | null) => {
    const normalized = deviceId?.trim() || null;
    selectedInputDeviceIdRef.current = normalized;
    setSelectedInputDeviceId(normalized);
    recordRecorderDiagnostic({
      level: 'info',
      component: 'recording',
      event: 'recording.input_device_selected',
      fields: { deviceId: normalized ?? 'system_default' },
    });
  }, []);

  const detachTrackListeners = useCallback(() => {
    for (const cleanup of trackListenerCleanupRef.current.splice(0)) cleanup();
  }, []);

  const stopTracks = useCallback(() => {
    detachTrackListeners();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, [detachTrackListeners]);

  const clearTimers = useCallback(() => {
    if (elapsedTimerRef.current) window.clearInterval(elapsedTimerRef.current);
    if (maximumTimerRef.current) window.clearTimeout(maximumTimerRef.current);
    if (stopEventTimerRef.current) window.clearTimeout(stopEventTimerRef.current);
    if (recorderStopDelayTimerRef.current) {
      window.clearTimeout(recorderStopDelayTimerRef.current);
    }
    if (pcmWatchdogTimerRef.current) window.clearTimeout(pcmWatchdogTimerRef.current);
    elapsedTimerRef.current = null;
    maximumTimerRef.current = null;
    stopEventTimerRef.current = null;
    recorderStopDelayTimerRef.current = null;
    pcmWatchdogTimerRef.current = null;
  }, []);

  const flushAudioWorklet = useCallback(async (
    recordingGeneration: number,
  ): Promise<boolean> => {
    const processor = processorRef.current;
    if (!processor) return false;
    const requestId = crypto.randomUUID();
    const result = await new Promise<AudioWorkletFlushMessage | null>((resolve) => {
      const timer = window.setTimeout(() => {
        pendingFlushesRef.current.delete(requestId);
        resolve(null);
      }, PCM_FLUSH_TIMEOUT_MS);
      pendingFlushesRef.current.set(requestId, (message) => {
        window.clearTimeout(timer);
        pendingFlushesRef.current.delete(requestId);
        resolve(message.requestId === requestId ? message : null);
      });
      processor.port.postMessage({ type: 'flush', requestId });
    });
    if (recordingGenerationRef.current !== recordingGeneration) return false;
    if (!result) {
      recordRecorderDiagnostic({
        level: 'warn',
        component: 'recording',
        event: 'recording.pcm_flush_timeout',
        fields: {
          generation: recordingGeneration,
          degradationCode: 'audio_worklet_flush_timeout',
          timeoutMs: PCM_FLUSH_TIMEOUT_MS,
          pcmCallbackCount: pcmCallbackCountRef.current,
          pcmFrameCount: workletFrameCountRef.current,
        },
      });
      optionsRef.current.onPcmUnavailable?.(
        'PCM 尾块未能在时限内确认；录音仍会停止，并从同一遍录音恢复完整转写。',
        'audio_worklet_flush_timeout',
      );
      return false;
    }
    recordRecorderDiagnostic({
      level: 'info',
      component: 'recording',
      event: 'recording.pcm_flush_acknowledged',
      fields: {
        generation: recordingGeneration,
        sequence: result.sequence,
        pcmFrameCount: result.frameCount,
      },
    });
    return true;
  }, [recordRecorderDiagnostic]);

  const scheduleStopEventWatchdog = useCallback((
    recordingGeneration: number,
    message: string,
    reasonCode: string,
    notifyCaptureError: boolean,
  ) => {
    if (stopEventTimerRef.current) window.clearTimeout(stopEventTimerRef.current);
    stopEventTimerRef.current = window.setTimeout(() => {
      if (
        recordingGenerationRef.current !== recordingGeneration
        || !stopRequestedRef.current
      ) return;
      recordingGenerationRef.current += 1;
      interruptionHandledRef.current = true;
      intentionalStopRef.current = false;
      clearTimers();
      stopAudioAnalysis();
      stopTracks();
      mediaRecorderRef.current = null;
      recordRecorderDiagnostic({
        level: 'error',
        component: 'recording',
        event: 'recording.capture_error',
        fields: { generation: recordingGeneration, reasonCode },
      });
      if (mountedRef.current) {
        setError(message);
        setStatus('error');
      }
      if (notifyCaptureError) optionsRef.current.onCaptureError?.(message);
    }, STOP_EVENT_TIMEOUT_MS);
  }, [clearTimers, stopAudioAnalysis, stopTracks]);

  const interruptCapture = useCallback((
    message: string,
    recordingGeneration: number,
    reasonCode: string,
    diagnosticEvent: 'recording.device_interrupted' | 'recording.media_recorder_error' | 'recording.capture_error',
  ) => {
    if (
      recordingGenerationRef.current !== recordingGeneration ||
      interruptionHandledRef.current
    ) return;
    interruptionHandledRef.current = true;
    intentionalStopRef.current = false;
    clearTimers();
    setError(message);
    recordRecorderDiagnostic({
      level: diagnosticEvent === 'recording.capture_error' ? 'error' : 'warn',
      component: 'recording',
      event: diagnosticEvent,
      fields: { generation: recordingGeneration, reasonCode },
    });
    optionsRef.current.onCaptureInterrupted?.(message);

    const recorder = mediaRecorderRef.current;
    if (recorder?.state === 'recording') {
      stopRequestedRef.current = true;
      scheduleStopEventWatchdog(
        recordingGeneration,
        message,
        'media_recorder_stop_timeout_after_interruption',
        false,
      );
      try {
        recorder.stop();
        return;
      } catch {
        // Fall through to the explicit error cleanup below.
      }
    }
    clearTimers();
    stopAudioAnalysis();
    stopTracks();
    mediaRecorderRef.current = null;
    if (mountedRef.current) setStatus('error');
  }, [clearTimers, scheduleStopEventWatchdog, stopAudioAnalysis, stopTracks]);

  const stop = useCallback((reason: 'user_requested' | 'maximum_duration' = 'user_requested') => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === 'recording' && !stopRequestedRef.current) {
      stopRequestedRef.current = true;
      intentionalStopRef.current = true;
      stopRequestedElapsedMsRef.current = Math.max(
        0,
        performance.now() - startedAtRef.current,
      );
      recordRecorderDiagnostic({
        level: 'info',
        component: 'recording',
        event: 'recording.stop_requested',
        fields: {
          generation: recordingGenerationRef.current,
          reasonCode: reason,
        },
      });
      optionsRef.current.onStopRequested?.();
      const recordingGeneration = recordingGenerationRef.current;
      const stopRecorder = async () => {
        recorderStopDelayTimerRef.current = null;
        if (
          recordingGenerationRef.current !== recordingGeneration
          || mediaRecorderRef.current !== recorder
          || recorder.state !== 'recording'
        ) return;
        await flushAudioWorklet(recordingGeneration);
        if (
          recordingGenerationRef.current !== recordingGeneration
          || mediaRecorderRef.current !== recorder
          || recorder.state !== 'recording'
        ) return;
        scheduleStopEventWatchdog(
          recordingGeneration,
          '录音器没有完成停止；当前音频可能不完整，请检查设备后重新录制。',
          'media_recorder_stop_timeout',
          true,
        );
        try {
          recorder.stop();
        } catch {
          interruptCapture(
            '录音器未能正常停止；当前音频可能不完整，请重新录制。',
            recordingGeneration,
            'media_recorder_stop_failed',
            'recording.capture_error',
          );
        }
      };
      recordRecorderDiagnostic({
        level: 'info',
        component: 'recording',
        event: 'recording.tail_grace_started',
        fields: {
          generation: recordingGeneration,
          graceMs: PCM_STOP_TAIL_GRACE_MS,
          pcmCallbackCount: pcmCallbackCountRef.current,
        },
      });
      recorderStopDelayTimerRef.current = window.setTimeout(
        () => { void stopRecorder(); },
        PCM_STOP_TAIL_GRACE_MS,
      );
    }
  }, [flushAudioWorklet, interruptCapture, scheduleStopEventWatchdog]);

  const start = useCallback(async () => {
    if (startGenerationRef.current !== null || mediaRecorderRef.current?.state === 'recording') {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      const message = '当前环境不支持麦克风录音。';
      recordRecorderDiagnostic({
        level: 'error',
        component: 'recording',
        event: 'recording.capture_error',
        fields: { reasonCode: 'media_devices_unavailable' },
      });
      setStatus('error');
      setError(message);
      optionsRef.current.onCaptureError?.(message);
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      const message = '当前环境不支持 MediaRecorder。';
      recordRecorderDiagnostic({
        level: 'error',
        component: 'recording',
        event: 'recording.capture_error',
        fields: { reasonCode: 'media_recorder_unavailable' },
      });
      setStatus('error');
      setError(message);
      optionsRef.current.onCaptureError?.(message);
      return;
    }

    const recordingGeneration = recordingGenerationRef.current + 1;
    recordingGenerationRef.current = recordingGeneration;
    captureIdRef.current = optionsRef.current.captureId?.trim() || crypto.randomUUID();
    captureSessionIdRef.current = optionsRef.current.sessionId?.trim() || null;
    captureAttemptIdRef.current = optionsRef.current.attemptId?.trim() || null;
    startGenerationRef.current = recordingGeneration;
    clearTimers();
    stopAudioAnalysis();
    stopTracks();
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    setRecordedAudio(undefined);
    setElapsedMs(0);
    setError(undefined);
    setStatus('requesting');
    stopRequestedRef.current = false;
    intentionalStopRef.current = false;
    stopRequestedElapsedMsRef.current = null;
    interruptionHandledRef.current = false;
    pcmCallbackCountRef.current = 0;
    asrOutputSampleCountRef.current = 0;
    nearSilentInputFramesRef.current = 0;
    inputSignalLoggedRef.current = false;
    pcmUnavailableReportedRef.current = false;
    audioContextRecoveryAttemptedRef.current = false;
    activePcmTransportRef.current = null;
    lastPcmTransportRef.current = null;
    pcmWatchdogSchedulerRef.current = null;
    mediaChunkCountRef.current = 0;
    mediaChunkBytesRef.current = 0;
    pcmInputFrameCountRef.current = 0;
    pcmSquareSumRef.current = 0;
    pcmSilentFrameCountRef.current = 0;
    pcmMaximumPeakRef.current = 0;
    workletExpectedSequenceRef.current = 0;
    workletFrameCountRef.current = 0;
    speechCandidateFramesRef.current = 0;
    speechHangoverFramesRef.current = 0;
    publishInputHealth(EMPTY_INPUT_HEALTH);
    const requestedInputDeviceId = selectedInputDeviceIdRef.current;
    recordRecorderDiagnostic({
      level: 'info',
      component: 'recording',
      event: 'recording.permission_requesting',
      fields: {
        generation: recordingGeneration,
        requestedDeviceId: requestedInputDeviceId ?? 'system_default',
      },
    });

    let captureStage: 'permission' | 'recorder_setup' | 'recorder_start' | 'callbacks' = 'permission';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          ...(requestedInputDeviceId
            ? { deviceId: { exact: requestedInputDeviceId } }
            : {}),
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      captureStage = 'recorder_setup';
      if (
        !mountedRef.current ||
        recordingGenerationRef.current !== recordingGeneration
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const inputTrack = stream.getTracks().find((track) => track.kind === 'audio');
      const rawTrackSettings = inputTrack?.getSettings?.() ?? {};
      const trackSettings = publicTrackSettings(rawTrackSettings);
      const actualDeviceId = typeof rawTrackSettings.deviceId === 'string'
        ? rawTrackSettings.deviceId
        : null;
      const trackLabel = inputTrack?.label || null;
      recordRecorderDiagnostic({
        level: 'info',
        component: 'recording',
        event: 'recording.permission_granted',
        fields: {
          generation: recordingGeneration,
          requestedDeviceId: requestedInputDeviceId ?? 'system_default',
          actualDeviceId,
        },
      });
      recordRecorderDiagnostic({
        level: 'info',
        component: 'recording',
        event: 'recording.track_metadata',
        fields: {
          generation: recordingGeneration,
          label: trackLabel,
          deviceId: actualDeviceId,
          enabled: inputTrack?.enabled ?? null,
          muted: inputTrack?.muted ?? null,
          readyState: inputTrack?.readyState ?? null,
          sampleRate: trackSettings.sampleRate,
          channelCount: trackSettings.channelCount,
          autoGainControl: trackSettings.autoGainControl,
          echoCancellation: trackSettings.echoCancellation,
          noiseSuppression: trackSettings.noiseSuppression,
        },
      });
      publishInputHealth({
        ...EMPTY_INPUT_HEALTH,
        trackLabel,
        deviceId: actualDeviceId,
        trackSettings,
        inputSampleRate: trackSettings.sampleRate,
      });
      void refreshInputDevices();
      voiceDetectedRef.current = false;
      chunksRef.current = [];
      const mimeType = supportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.addEventListener('dataavailable', (event) => {
        if (
          recordingGenerationRef.current === recordingGeneration &&
          event.data.size > 0
        ) {
          chunksRef.current.push(event.data);
          mediaChunkCountRef.current += 1;
          mediaChunkBytesRef.current += event.data.size;
        }
      });
      recorder.addEventListener('error', () => {
        interruptCapture(
          '录音器发生错误；当前音频可能不完整，请重新录制。',
          recordingGeneration,
          'media_recorder_error',
          'recording.media_recorder_error',
        );
      });
      recorder.addEventListener(
        'stop',
        () => {
          if (recordingGenerationRef.current !== recordingGeneration) return;
          clearTimers();
          stopAudioAnalysis();
          stopTracks();
          if (mediaRecorderRef.current === recorder) mediaRecorderRef.current = null;
          stopRequestedRef.current = false;
          const durationMs = Math.min(
            MAX_RECORDING_MS,
            Math.max(1, Math.round(performance.now() - startedAtRef.current)),
          );
          const pcmDurationMs = Math.round(
            (asrOutputSampleCountRef.current / ASR_SAMPLE_RATE) * 1_000,
          );
          // MediaRecorder stops after the explicit tail grace and may emit its
          // stop event later still. ScriptProcessor delivers quantized blocks,
          // so that post-intent lifecycle time is not evidence that speech PCM
          // before the user's stop intent was lost. Keep the 300 ms window for
          // the final callback, but judge completeness against the stop intent.
          const captureCoverageTargetMs = (
            lastPcmTransportRef.current !== 'script_processor_fallback'
            || stopRequestedElapsedMsRef.current === null
          )
            ? durationMs
            : Math.min(durationMs, Math.round(stopRequestedElapsedMsRef.current));
          const pcmGapMs = Math.max(0, captureCoverageTargetMs - pcmDurationMs);
          if (
            pcmGapMs > PCM_CAPTURE_GAP_TOLERANCE_MS
            && !pcmUnavailableReportedRef.current
          ) {
            pcmUnavailableReportedRef.current = true;
            recordRecorderDiagnostic({
              level: 'warn',
              component: 'recording',
              event: 'recording.pcm_capture_incomplete',
              fields: {
                generation: recordingGeneration,
                durationMs,
                pcmDurationMs,
                pcmGapMs,
                captureCoverageTargetMs,
                postStopFinalizationMs: Math.max(0, durationMs - captureCoverageTargetMs),
                pcmCallbackCount: pcmCallbackCountRef.current,
              },
            });
            optionsRef.current.onPcmUnavailable?.(
              '实时 PCM 比录音文件短；停止后会从同一遍录音恢复完整转写。',
              'pcm_capture_incomplete',
            );
          }
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || mimeType || 'audio/webm',
          });
          if (!mountedRef.current) return;
          if (blob.size === 0) {
            const message = '没有收到可保存的音频数据，请检查麦克风后重试。';
            recordRecorderDiagnostic({
              level: 'error',
              component: 'recording',
              event: 'recording.capture_error',
              fields: { generation: recordingGeneration, reasonCode: 'empty_audio' },
            });
            setStatus('error');
            setError(message);
            if (!interruptionHandledRef.current) {
              optionsRef.current.onCaptureError?.(message);
            }
            return;
          }
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          setElapsedMs(durationMs);
          const recording = {
            blob,
            url,
            durationMs,
            mimeType: blob.type || 'audio/webm',
          } satisfies RecordedAudio;
          setRecordedAudio(recording);
          setStatus('recorded');
          const interrupted = interruptionHandledRef.current;
          recordRecorderDiagnostic({
            level: interrupted ? 'warn' : 'info',
            component: 'recording',
            event: interrupted ? 'recording.interrupted_audio_ready' : 'recording.ready',
            fields: {
              generation: recordingGeneration,
              durationMs,
              byteLength: blob.size,
              chunkCount: mediaChunkCountRef.current,
              chunkBytes: mediaChunkBytesRef.current,
              mimeCategory: mimeCategory(recording.mimeType),
              interrupted,
              pcmCallbackCount: pcmCallbackCountRef.current,
              pcmInputFrames: pcmInputFrameCountRef.current,
              pcmOutputSamples: asrOutputSampleCountRef.current,
              pcmDurationMs,
              transport: lastPcmTransportRef.current ?? 'unavailable',
              aggregateRms: pcmInputFrameCountRef.current > 0
                ? Math.sqrt(pcmSquareSumRef.current / pcmInputFrameCountRef.current)
                : 0,
              maximumPeak: pcmMaximumPeakRef.current,
              silentRatio: pcmInputFrameCountRef.current > 0
                ? pcmSilentFrameCountRef.current / pcmInputFrameCountRef.current
                : 1,
            },
          });
          optionsRef.current.onRecordingReady?.(recording);
        },
        { once: true },
      );
      let recorderStartAttempted = false;
      let recorderStarted = false;
      const startMediaRecorder = () => {
        if (recorderStarted) return;
        captureStage = 'recorder_start';
        recorderStartAttempted = true;
        recorder.start(250);
        recorderStarted = true;
        // MediaRecorder.start() can block while Chromium initializes the native
        // encoder. Start the user-visible/capture-coverage clock only after that
        // synchronous work succeeds; otherwise setup latency is misclassified as
        // missing PCM when the worklet begins immediately after start returns.
        startedAtRef.current = performance.now();
        captureStage = 'callbacks';
        optionsRef.current.onPermissionGranted?.();
        recordRecorderDiagnostic({
          level: 'info',
          component: 'recording',
          event: 'recording.started',
          fields: { generation: recordingGeneration },
        });
        optionsRef.current.onRecordingStarted?.();
        setStatus('recording');
      };

      for (const track of stream.getTracks()) {
        if (typeof track.addEventListener !== 'function') continue;
        const onEnded = () => {
          if (intentionalStopRef.current) return;
          interruptCapture(
            '麦克风连接已中断；这遍不会作为有效练习，请重新录制。',
            recordingGeneration,
            'track_ended',
            'recording.device_interrupted',
          );
        };
        const onMuted = () => {
          recordRecorderDiagnostic({
            level: 'warn',
            component: 'recording',
            event: 'recording.track_muted',
            fields: {
              generation: recordingGeneration,
              label: track.label || null,
              deviceId: track.getSettings?.().deviceId ?? null,
            },
          });
        };
        const onUnmuted = () => {
          recordRecorderDiagnostic({
            level: 'info',
            component: 'recording',
            event: 'recording.track_unmuted',
            fields: {
              generation: recordingGeneration,
              label: track.label || null,
              deviceId: track.getSettings?.().deviceId ?? null,
            },
          });
        };
        track.addEventListener('ended', onEnded);
        track.addEventListener('mute', onMuted);
        track.addEventListener('unmute', onUnmuted);
        trackListenerCleanupRef.current.push(() => track.removeEventListener('ended', onEnded));
        trackListenerCleanupRef.current.push(() => track.removeEventListener('mute', onMuted));
        trackListenerCleanupRef.current.push(() => track.removeEventListener('unmute', onUnmuted));
      }

      if (typeof AudioContext !== 'undefined') {
        try {
          const audioContext = new AudioContext({ sampleRate: ASR_SAMPLE_RATE });
          audioContextRef.current = audioContext;
          if (!audioContext.audioWorklet || typeof AudioWorkletNode === 'undefined') {
            throw new Error('AUDIO_WORKLET_UNAVAILABLE');
          }
          await audioContext.audioWorklet.addModule(AUDIO_WORKLET_MODULE_URL);
          const source = audioContext.createMediaStreamSource(stream);
          const processor = new AudioWorkletNode(audioContext, AUDIO_WORKLET_PROCESSOR_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
          });
          const silentSink = audioContext.createGain();
          // The worklet never copies microphone input into its output, so this
          // render path remains silent. A non-zero GainNode keeps Chromium from
          // pruning the upstream PCM processor as an inaudible zero-gain graph.
          silentSink.gain.value = 1;
          const inputSampleRate = Math.round(audioContext.sampleRate);
          sourceRef.current = source;
          processorRef.current = processor;
          silentSinkRef.current = silentSink;
          activePcmTransportRef.current = 'audio_worklet';
          lastPcmTransportRef.current = 'audio_worklet';
          resamplerRef.current = createStreamingResamplerState(inputSampleRate);
          publishInputHealth({
            ...inputHealthRef.current,
            inputSampleRate,
          });
          const reportPcmUnavailable = (reasonCode: string) => {
            if (
              recordingGenerationRef.current !== recordingGeneration
              || pcmUnavailableReportedRef.current
            ) return;
            pcmUnavailableReportedRef.current = true;
            recordRecorderDiagnostic({
              level: 'warn',
              component: 'recording',
              event: 'recording.pcm_unavailable',
              fields: {
                generation: recordingGeneration,
                reasonCode,
                audioContextState: String(audioContext.state),
                pcmCallbackCount: pcmCallbackCountRef.current,
                transport: 'audio_worklet',
              },
            });
            optionsRef.current.onPcmUnavailable?.(
              '本地 PCM 通道没有收到音频；录音仍继续，停止后会尝试从同一遍录音恢复转写。',
              reasonCode,
            );
          };
          const schedulePcmWatchdog = (
            delayMs: number,
            reasonCode: string,
            allowResumeRecovery: boolean,
            allowFallbackRecovery: boolean,
          ) => {
            if (pcmWatchdogTimerRef.current) {
              window.clearTimeout(pcmWatchdogTimerRef.current);
            }
            const observedCallbackCount = pcmCallbackCountRef.current;
            pcmWatchdogTimerRef.current = window.setTimeout(() => {
              pcmWatchdogTimerRef.current = null;
              if (
                recordingGenerationRef.current !== recordingGeneration
                || stopRequestedRef.current
                || pcmCallbackCountRef.current > observedCallbackCount
              ) return;
              recordRecorderDiagnostic({
                level: 'warn',
                component: 'recording',
                event: 'recording.pcm_stalled',
                fields: {
                  generation: recordingGeneration,
                  reasonCode,
                  audioContextState: String(audioContext.state),
                  pcmCallbackCount: pcmCallbackCountRef.current,
                  transport: 'audio_worklet',
                },
              });
              if (
                allowResumeRecovery
                && audioContext.state !== 'running'
                && !audioContextRecoveryAttemptedRef.current
              ) {
                audioContextRecoveryAttemptedRef.current = true;
                recordRecorderDiagnostic({
                  level: 'info',
                  component: 'recording',
                  event: 'recording.audio_context_resume_attempted',
                  fields: {
                    generation: recordingGeneration,
                    reasonCode,
                    audioContextState: String(audioContext.state),
                  },
                });
                void audioContext.resume().catch(() => {
                  reportPcmUnavailable('audio_context_resume_failed');
                });
                schedulePcmWatchdog(
                  PCM_RECOVERY_GRACE_MS,
                  'pcm_callback_missing_after_resume',
                  false,
                  true,
                );
                return;
              }
              if (allowFallbackRecovery) {
                const fallbackStarted = startScriptProcessorFallback(
                  stream,
                  recordingGeneration,
                  reasonCode,
                );
                if (fallbackStarted) return;
              }
              reportPcmUnavailable(reasonCode);
            }, delayMs);
          };
          pcmWatchdogSchedulerRef.current = schedulePcmWatchdog;
          const onAudioContextStateChange = () => {
            if (recordingGenerationRef.current !== recordingGeneration) return;
            const contextState = String(audioContext.state);
            recordRecorderDiagnostic({
              level: contextState === 'running' ? 'info' : 'warn',
              component: 'recording',
              event: 'recording.audio_context_state_changed',
              fields: {
                generation: recordingGeneration,
                audioContextState: contextState,
                pcmCallbackCount: pcmCallbackCountRef.current,
              },
            });
            if (
              contextState !== 'running'
              && !stopRequestedRef.current
              && mediaRecorderRef.current?.state === 'recording'
            ) {
              schedulePcmWatchdog(
                PCM_RECOVERY_GRACE_MS,
                'audio_context_not_running',
                true,
                true,
              );
            }
          };
          audioContext.addEventListener('statechange', onAudioContextStateChange);
          audioContextStateCleanupRef.current = () => {
            audioContext.removeEventListener('statechange', onAudioContextStateChange);
          };
          // Loading the worklet module can take hundreds of milliseconds on a
          // cold packaged start. Do not expose "recording" or start the encoded
          // take until this live PCM path is ready, otherwise the user's opening
          // words exist in MediaRecorder but are absent from local ASR.
          startMediaRecorder();
          source.connect(processor);
          processor.connect(silentSink);
          silentSink.connect(audioContext.destination);
          schedulePcmWatchdog(
            PCM_START_TIMEOUT_MS,
            'pcm_callback_start_timeout',
            true,
            true,
          );
          processor.port.onmessage = (event: MessageEvent<unknown>) => {
            const message = event.data as {
              readonly type?: unknown;
              readonly requestId?: unknown;
              readonly sequence?: unknown;
              readonly frameCount?: unknown;
              readonly samples?: unknown;
            };
            if (message.type === 'flushed' && typeof message.requestId === 'string') {
              pendingFlushesRef.current.get(message.requestId)?.({
                type: 'flushed',
                requestId: message.requestId,
                sequence: Number(message.sequence ?? 0),
                frameCount: Number(message.frameCount ?? 0),
              });
              return;
            }
            if (
              message.type !== 'pcm'
              || !(message.samples instanceof Float32Array)
              || typeof message.sequence !== 'number'
              || !Number.isInteger(message.sequence)
              || typeof message.frameCount !== 'number'
              || !Number.isInteger(message.frameCount)
            ) return;
            if (recordingGenerationRef.current !== recordingGeneration) return;
            const sequence = message.sequence;
            const frameCount = message.frameCount;
            const expectedSequence = workletExpectedSequenceRef.current;
            const expectedFrameCount = workletFrameCountRef.current + message.samples.length;
            if (sequence !== expectedSequence || frameCount !== expectedFrameCount) {
              recordRecorderDiagnostic({
                level: 'warn',
                component: 'recording',
                event: 'recording.pcm_sequence_gap',
                fields: {
                  generation: recordingGeneration,
                  expectedSequence,
                  actualSequence: sequence,
                  expectedFrameCount,
                  actualFrameCount: frameCount,
                  transport: 'audio_worklet',
                },
              });
              if (startScriptProcessorFallback(
                stream,
                recordingGeneration,
                'audio_worklet_sequence_gap',
              )) return;
              reportPcmUnavailable('audio_worklet_sequence_gap');
            }
            workletExpectedSequenceRef.current = sequence + 1;
            workletFrameCountRef.current = frameCount;
            const samples = message.samples;
            handlePcmSamples(samples, inputSampleRate, 'audio_worklet', recordingGeneration, {
              sequence,
              frameCount,
            });
          };
          processor.port.start();
          void audioContext.resume().catch(() => {
            if (recordingGenerationRef.current !== recordingGeneration) return;
            reportPcmUnavailable('audio_context_resume_failed');
          });
        } catch (workletError) {
          if (recorderStartAttempted && !recorderStarted) throw workletError;
          const reasonCode = workletError instanceof Error
            && workletError.message === 'AUDIO_WORKLET_UNAVAILABLE'
            ? 'audio_worklet_unavailable'
            : 'audio_worklet_initialization_failed';
          recordRecorderDiagnostic({
            level: 'warn',
            component: 'recording',
            event: 'recording.pcm_transport_initialization_failed',
            fields: {
              generation: recordingGeneration,
              reasonCode,
              transport: 'audio_worklet',
            },
          });
          startMediaRecorder();
          if (!startScriptProcessorFallback(stream, recordingGeneration, reasonCode)) {
            recordRecorderDiagnostic({
              level: 'warn',
              component: 'recording',
              event: 'recording.pcm_unavailable',
              fields: {
                generation: recordingGeneration,
                reasonCode: 'pcm_transport_initialization_failed',
                transport: 'unavailable',
              },
            });
            optionsRef.current.onPcmUnavailable?.(
              '当前环境无法启动实时 PCM 通道；录音仍继续，停止后会从同一遍录音恢复转写。',
              'pcm_transport_initialization_failed',
            );
          }
        }
      } else {
        startMediaRecorder();
        recordRecorderDiagnostic({
          level: 'warn',
          component: 'recording',
          event: 'recording.pcm_unavailable',
          fields: { generation: recordingGeneration, reasonCode: 'audio_context_unavailable' },
        });
        optionsRef.current.onPcmUnavailable?.(
          '当前环境不支持本地 PCM 分析；录音仍继续，但本轮转写需要重新录制后重试。',
          'audio_context_unavailable',
        );
      }
      elapsedTimerRef.current = window.setInterval(() => {
        setElapsedMs(Math.round(performance.now() - startedAtRef.current));
      }, 200);
      maximumTimerRef.current = window.setTimeout(
        () => stop('maximum_duration'),
        MAX_RECORDING_MS,
      );
    } catch (cause) {
      clearTimers();
      stopAudioAnalysis();
      stopTracks();
      mediaRecorderRef.current = null;
      if (
        !mountedRef.current ||
        recordingGenerationRef.current !== recordingGeneration
      ) return;
      const denied =
        cause instanceof DOMException &&
        (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');
      const message = denied
        ? '麦克风权限未开启。请在系统设置中允许 Phrio 使用麦克风。'
        : captureStage === 'permission'
          ? '没有成功连接麦克风，请检查设备后重试。'
          : '录音器未能启动，请检查设备后重试。';
      setError(message);
      if (denied) {
        recordRecorderDiagnostic({
          level: 'warn',
          component: 'recording',
          event: 'recording.permission_denied',
          fields: {
            generation: recordingGeneration,
            reasonCode: cause instanceof DOMException && cause.name === 'SecurityError'
              ? 'security_error'
              : 'not_allowed',
          },
        });
        optionsRef.current.onPermissionDenied?.(message);
      } else {
        const reasonCode = captureStage === 'permission'
          ? 'get_user_media_failed'
          : captureStage === 'recorder_setup'
            ? 'media_recorder_initialization_failed'
            : captureStage === 'recorder_start'
              ? 'media_recorder_start_failed'
              : 'recording_start_callback_failed';
        recordRecorderDiagnostic({
          level: 'error',
          component: 'recording',
          event: 'recording.capture_error',
          fields: { generation: recordingGeneration, reasonCode },
        });
        optionsRef.current.onCaptureError?.(message);
      }
      setStatus('error');
    } finally {
      if (startGenerationRef.current === recordingGeneration) {
        startGenerationRef.current = null;
      }
    }
  }, [
    clearTimers,
    handlePcmSamples,
    interruptCapture,
    publishInputHealth,
    refreshInputDevices,
    stop,
    stopAudioAnalysis,
    startScriptProcessorFallback,
    stopTracks,
  ]);

  const reset = useCallback(() => {
    recordingGenerationRef.current += 1;
    startGenerationRef.current = null;
    intentionalStopRef.current = true;
    stopRequestedRef.current = true;
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
    clearTimers();
    stopAudioAnalysis();
    stopTracks();
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    chunksRef.current = [];
    pcmCallbackCountRef.current = 0;
    stopRequestedElapsedMsRef.current = null;
    nearSilentInputFramesRef.current = 0;
    inputSignalLoggedRef.current = false;
    pcmUnavailableReportedRef.current = false;
    audioContextRecoveryAttemptedRef.current = false;
    activePcmTransportRef.current = null;
    lastPcmTransportRef.current = null;
    pcmWatchdogSchedulerRef.current = null;
    mediaChunkCountRef.current = 0;
    mediaChunkBytesRef.current = 0;
    pcmInputFrameCountRef.current = 0;
    pcmSquareSumRef.current = 0;
    pcmSilentFrameCountRef.current = 0;
    pcmMaximumPeakRef.current = 0;
    workletExpectedSequenceRef.current = 0;
    workletFrameCountRef.current = 0;
    speechCandidateFramesRef.current = 0;
    speechHangoverFramesRef.current = 0;
    setRecordedAudio(undefined);
    setElapsedMs(0);
    setError(undefined);
    setStatus('idle');
    publishInputHealth(EMPTY_INPUT_HEALTH);
    stopRequestedRef.current = false;
    intentionalStopRef.current = false;
    interruptionHandledRef.current = false;
  }, [clearTimers, publishInputHealth, stopAudioAnalysis, stopTracks]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    void refreshInputDevices();
    if (!mediaDevices?.addEventListener) return;
    const onDeviceChange = () => {
      void refreshInputDevices();
      const stream = streamRef.current;
      if (!stream || intentionalStopRef.current) return;
      const generation = recordingGenerationRef.current;
      const tracks = stream.getTracks().filter((track) => track.kind === 'audio');
      const activeTrack = tracks[0];
      if (!activeTrack || activeTrack.readyState === 'ended') {
        interruptCapture(
          '麦克风设备已断开；这遍不会作为有效练习，请重新录制。',
          generation,
          'device_removed',
          'recording.device_interrupted',
        );
        return;
      }
      const deviceId = activeTrack.getSettings?.().deviceId;
      if (!deviceId || typeof mediaDevices.enumerateDevices !== 'function') return;
      void mediaDevices.enumerateDevices().then((devices) => {
        if (
          recordingGenerationRef.current === generation &&
          !intentionalStopRef.current &&
          !devices.some((device) => device.kind === 'audioinput' && device.deviceId === deviceId)
        ) {
          interruptCapture(
            '麦克风设备已断开；这遍不会作为有效练习，请重新录制。',
            generation,
            'device_removed',
            'recording.device_interrupted',
          );
        }
      }).catch(() => undefined);
    };
    mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => mediaDevices.removeEventListener('devicechange', onDeviceChange);
  }, [interruptCapture, refreshInputDevices]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recordingGenerationRef.current += 1;
      startGenerationRef.current = null;
      intentionalStopRef.current = true;
      clearTimers();
      stopAudioAnalysis();
      stopTracks();
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [clearTimers, stopAudioAnalysis, stopTracks]);

  return {
    status,
    elapsedMs,
    recordedAudio,
    error,
    inputDevices,
    selectedInputDeviceId,
    selectInputDevice,
    refreshInputDevices,
    inputHealth,
    start,
    stop,
    reset,
  };
}
