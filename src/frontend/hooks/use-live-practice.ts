import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import {
  annotateFinalSegment,
  confirmOrWithdrawAnnotations,
  createLiveAttemptState,
  freezeAttemptSnapshot,
  LiveHintCoordinator,
  reconcileFinalTailAnnotations,
  reduceLiveAttempt,
  type AttemptSnapshot,
  type CloudAiConsentStatus,
  type LiveAnnotation,
  type LiveAttemptEvent,
  type PracticeSession,
  type TranscriptSegment,
} from '../../shared';
import {
  feedLocalAsr,
  getPracticeSession,
  savePracticeArtifact,
  startLocalAsr,
  stopLocalAsr,
} from '../services/desktop-api';
import {
  cancelLiveHint,
  executeLiveHint,
  getCloudAiConfiguration,
  getCloudAiConsentStatus,
  getCloudAiPreferences,
  PHRIO_LIVE_AI_POLICY,
  revokeCloudAiConsent,
  setLiveAttemptAiState,
  taskContextForCloudAi,
} from '../services/cloud-ai-api';
import { recordDiagnosticEvent } from '../services/diagnostics-api';
import {
  decodeRecordedAudioToMono16Khz,
  RecordedAudioDecodeError,
} from '../services/recorded-audio-decoder';
import {
  getEnvironmentStatus,
  installLocalAsrModel as installLocalAsrModelFromEnvironment,
} from '../services/environment-api';
import { useAudioRecorder, type RecordedAudio } from './use-audio-recorder';

interface UseLivePracticeInput {
  readonly sessionId: string;
  readonly kind: 'initial' | 'retry';
  readonly focusVersion?: number | null;
}

export type LiveAiReadiness =
  | 'loading'
  | 'ready'
  | 'key_missing'
  | 'purpose_disabled'
  | 'consent_missing'
  | 'session_unavailable'
  | 'load_failed';

export type LocalAsrReadiness = 'checking' | 'ready' | 'model_missing' | 'check_failed';
export type LocalAsrInstallStatus = 'idle' | 'installing' | 'installed' | 'failed';

function localAsrInstallErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ASR_MODEL_DIRECT_DOWNLOAD_FAILED')) {
    return '模型下载暂时中断；约 226 MB 三文件断点已保留，普通超时或断网不会触发约 1 GB 整包下载。网络恢复后可继续安装，已有录音仍留在本页。';
  }
  if (message.includes('ASR_MODEL_DOWNLOAD_FAILED')) {
    return '官方兼容整包下载暂时中断；已下载进度仍保留。网络恢复后可继续安装，已有录音仍留在本页。';
  }
  if (message.includes('INSTALL_TIMEOUT')) {
    return '模型安装等待超时；已下载进度保留。检查网络后可继续安装。';
  }
  if (message.includes('ARCHIVE_SIZE_MISMATCH') || message.includes('ARCHIVE_INVALID')) {
    return '模型包处理失败；可用下载进度仍保留，重试时会重新校验。';
  }
  if (message.includes('INTEGRITY_MISMATCH')) {
    return '模型包完整性校验失败，已丢弃不可信下载；请重新安装。';
  }
  if (message.includes('RESUME_REJECTED')) {
    return '服务器暂未接受断点续传；本地进度仍保留，请稍后继续安装。';
  }
  if (message.includes('REDIRECT_REJECTED')) {
    return '模型下载被不可信的跳转地址拦截，请稍后重试。';
  }
  if (message.includes('FILES_INVALID')) {
    return '模型文件校验失败，Phrio 没有替换当前模型；请重新安装。';
  }
  return '本地转写模型安装失败；已有录音仍保留在本页，请重试或在设置中检查环境。';
}

type EventWithoutMeta = LiveAttemptEvent extends infer Event
  ? Event extends LiveAttemptEvent
    ? Omit<Event, 'id' | 'generation' | 'sourceSequence'>
    : never
  : never;

type DiagnosticFields = Record<string, string | number | boolean | null>;

function recordLiveDiagnostic(input: Parameters<typeof recordDiagnosticEvent>[0]): void {
  try {
    void recordDiagnosticEvent(input).catch(() => undefined);
  } catch {
    // Diagnostics are an observational side channel and must never affect Fast Lane.
  }
}

function diagnosticComponentForLiveEvent(
  event: EventWithoutMeta,
): Parameters<typeof recordDiagnosticEvent>[0]['component'] {
  switch (event.type) {
    case 'permission_granted':
    case 'permission_denied':
    case 'recording_started':
    case 'capture_interrupted':
    case 'recording_too_short':
    case 'stop_requested':
    case 'tail_complete':
      return 'recording';
    case 'voice_detected':
    case 'no_speech':
      return 'vad';
    case 'segment':
    case 'asr_retry_reset':
    case 'asr_reconnecting':
    case 'asr_degraded':
    case 'transcription_failed':
      return 'asr';
    case 'ai_pending':
    case 'hint':
    case 'ai_failed':
    case 'live_ai_consent_status':
    case 'live_ai':
    case 'revoke_live_ai_consent':
      return 'ai';
    case 'snapshot_frozen':
    case 'report_status':
      return 'deep';
    case 'network':
      return 'app';
    case 'annotations':
    case 'annotation_withdrawn':
    case 'feedback_visibility':
    case 'local_annotations':
    case 'attempt_reset':
      return 'live';
  }
}

function diagnosticLevelForLiveEvent(
  event: EventWithoutMeta,
): Parameters<typeof recordDiagnosticEvent>[0]['level'] {
  switch (event.type) {
    case 'permission_denied':
    case 'capture_interrupted':
    case 'ai_failed':
    case 'asr_degraded':
    case 'transcription_failed':
      return 'error';
    case 'no_speech':
    case 'recording_too_short':
    case 'asr_reconnecting':
    case 'asr_retry_reset':
    case 'annotation_withdrawn':
      return 'warn';
    case 'report_status':
      return event.status === 'failed' ? 'error' : 'info';
    case 'network':
      return event.status === 'offline' ? 'warn' : 'info';
    default:
      return 'info';
  }
}

function diagnosticFieldsForLiveEvent(event: EventWithoutMeta): DiagnosticFields {
  switch (event.type) {
    case 'segment':
      return {
        sequence: event.segment.sequence,
        revision: event.segment.revision,
        characterCount: event.segment.text.length,
        status: event.segment.isFinal ? 'final' : 'partial',
      };
    case 'annotations':
      return {
        count: event.annotations.length,
        confirmedCount: event.annotations.filter((item) => item.lifecycle === 'confirmed').length,
        withdrawnCount: event.annotations.filter((item) => item.lifecycle === 'withdrawn').length,
      };
    case 'annotation_withdrawn':
      return { count: 1, reasonCode: 'annotation_withdrawn' };
    case 'hint':
      return {
        sequence: event.hint.requestSequence,
        count: event.hint.segmentIds.length,
        characterCount: event.hint.text.length,
        status: event.hint.lifecycle,
      };
    case 'network':
      return { status: event.status };
    case 'feedback_visibility':
      return { visible: event.visible };
    case 'local_annotations':
    case 'live_ai':
      return { enabled: event.enabled };
    case 'live_ai_consent_status':
      return { valid: event.valid };
    case 'stop_requested':
      return { durationMs: event.audioWatermark };
    case 'report_status':
      return {
        status: event.status,
        ...(event.reason ? { reasonCode: `report_${event.status}` } : {}),
      };
    case 'snapshot_frozen':
      return { status: 'frozen' };
    case 'attempt_reset':
      return { nextGeneration: event.nextGeneration };
    case 'permission_denied':
      return { reasonCode: 'permission_denied' };
    case 'capture_interrupted':
      return { reasonCode: 'capture_interrupted' };
    case 'ai_failed':
      return { reasonCode: 'ai_failed' };
    case 'asr_degraded':
      return { reasonCode: event.code ?? 'asr_degraded' };
    case 'transcription_failed':
      return { reasonCode: 'transcription_failed' };
    case 'recording_too_short':
      return { reasonCode: 'recording_too_short' };
    case 'asr_retry_reset':
      return { reasonCode: 'transient_transcript_cleared' };
    case 'permission_granted':
    case 'recording_started':
    case 'voice_detected':
    case 'no_speech':
    case 'ai_pending':
    case 'asr_reconnecting':
    case 'revoke_live_ai_consent':
    case 'tail_complete':
      return {};
  }
}

const QA_TEXT = [
  '我觉得就是我们可能需要先把这件事的边界说清楚。',
  '不然大家后面讨论的时候会一直在不同的范围里来回。',
  '然后第一个事情是把需求先冻结，第二个事情是这个。',
  '所以我的结论是，本周冻结新增需求，先先把版本稳定下来，周五再判断是否解除冻结。',
] as const;
const QA_TIMES = [[8_000, 13_000], [13_000, 17_000], [18_000, 27_000], [28_000, 34_000]] as const;
const MAX_PENDING_ASR_PCM_SAMPLES = 16_000 * 8;
const MAX_CAPTURED_ASR_PCM_SAMPLES = 16_000 * 300;
const RECOVERED_PCM_CHUNK_SAMPLES = 16_000;
const MAX_LIVE_HINT_SEGMENT_REFERENCES = 24;
export const NO_SPEECH_WARNING_MS = 8_000;
export const MIN_RELIABLE_RECORDING_MS = 20_000;
const ASR_OPERATION_TIMEOUT_MS = 8_000;
const SNAPSHOT_PERSIST_TIMEOUT_MS = 8_000;

type AsrStartOutcome = 'ready' | 'failed';

interface AttemptIdentity {
  readonly attemptId: string;
  readonly generation: number;
}

interface LiveHintRequestMeta {
  readonly windowHash: string;
  readonly segmentIds: readonly string[];
  readonly evidencePhrase: string | null;
  readonly criterionId: string | null;
}

interface LiveHintFinalWindow {
  readonly text: string;
  readonly segments: readonly TranscriptSegment[];
}

/**
 * Keeps the sent text and its frozen segment references on one exact boundary.
 * The oldest selected segment may be clipped by the character window, but every
 * selected segment contributes at least one character and no omitted segment is
 * claimed as evidence for the request.
 */
export function selectLiveHintFinalWindow(
  finalSegments: readonly TranscriptSegment[],
): LiveHintFinalWindow {
  const selected: TranscriptSegment[] = [];
  let selectedCharacters = 0;
  for (let index = finalSegments.length - 1; index >= 0; index -= 1) {
    if (
      selected.length >= MAX_LIVE_HINT_SEGMENT_REFERENCES ||
      selectedCharacters >= PHRIO_LIVE_AI_POLICY.maximumWindowCharacters
    ) break;
    const segment = finalSegments[index]!;
    const text = segment.text.trim();
    if (!segment.isFinal || !text) continue;
    selected.unshift(segment);
    selectedCharacters += text.length;
  }
  const reconstructed = selected.map((segment) => segment.text.trim()).join('');
  return {
    text: reconstructed.slice(-PHRIO_LIVE_AI_POLICY.maximumWindowCharacters),
    segments: selected,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createAttemptIdentity(
  kind: UseLivePracticeInput['kind'],
  generation: number,
): AttemptIdentity {
  return {
    attemptId: `${kind}-g${generation}-${crypto.randomUUID()}`.slice(0, 96),
    generation,
  };
}

function withAsrTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ASR_OPERATION_TIMEOUT_MS);
    operation.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function qaMode(): boolean {
  return import.meta.env.DEV
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('qa');
}

export function useLivePractice({ sessionId, kind, focusVersion }: UseLivePracticeInput) {
  const [identity, setIdentity] = useState<AttemptIdentity>(() =>
    createAttemptIdentity(kind, 1),
  );
  const { attemptId, generation } = identity;
  const captureId = `${attemptId}-capture`.slice(0, 96);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [state, dispatch] = useReducer(
    reduceLiveAttempt,
    undefined,
    () => createLiveAttemptState({
      sessionId,
      attemptId,
      generation,
      kind,
      liveAiEnabled: qaMode(),
      liveAiConsentValid: qaMode(),
    }),
  );
  const eventCounterRef = useRef(0);
  const feedTailRef = useRef(Promise.resolve());
  const asrAvailableRef = useRef(false);
  const asrStartRef = useRef<Promise<AsrStartOutcome> | null>(null);
  const abandonPendingAsrStartRef = useRef<(() => void) | null>(null);
  const asrStopOperationsRef = useRef(
    new Map<string, Promise<TranscriptSegment | null>>(),
  );
  const asrStopRequestedRef = useRef(false);
  const recordingStopRequestedRef = useRef(false);
  const asrFeedFailedRef = useRef(false);
  const pcmChannelUnavailableRef = useRef(false);
  const pcmCaptureIncompleteRef = useRef(false);
  const asrProducedFinalRef = useRef(false);
  const asrFailureReasonRef = useRef<string | null>(null);
  const pendingPcmRef = useRef<Float32Array[]>([]);
  const pendingPcmSamplesRef = useRef(0);
  const pendingPcmOverflowRef = useRef(false);
  const feedQueueRef = useRef({ pendingSamples: 0 });
  const feedQueueHighWaterRef = useRef(0);
  const feedQueueLatencyCountRef = useRef(0);
  const feedQueueLatencyTotalMsRef = useRef(0);
  const feedQueueLatencyMaximumMsRef = useRef(0);
  const feedQueueLatencyOver100MsRef = useRef(0);
  const feedQueueLatencyOver250MsRef = useRef(0);
  const droppedPcmSamplesRef = useRef(0);
  const capturedPcmSamplesRef = useRef(0);
  const capturedPcmRef = useRef<Float32Array[]>([]);
  const asrRecoveryAttemptedRef = useRef(false);
  const acceptedSegmentsRef = useRef(new Map<string, TranscriptSegment>());
  const highestAcceptedSequenceRef = useRef(-1);
  const analyzedSegmentsRef = useRef(new Set<string>());
  const finalizedSegmentsRef = useRef<TranscriptSegment[]>([]);
  const localAnnotationsRef = useRef<LiveAnnotation[]>([]);
  const localAnnotationsEnabledRef = useRef(true);
  const nextAnnotationOrdinalRef = useRef(1);
  const frozenSessionRef = useRef<PracticeSession | null>(null);
  const frozenSessionLoadRef = useRef<Promise<PracticeSession | null> | null>(null);
  const frozenSessionRequestIdRef = useRef<string | null>(null);
  const voiceDetectedRef = useRef(false);
  const recordingReadyRef = useRef<RecordedAudio | null>(null);
  const tailReadyRef = useRef(false);
  const attemptFailedRef = useRef(false);
  const completionEmittedRef = useRef(false);
  const shortRecordingAcceptedRef = useRef(false);
  const shortRecordingGateShownRef = useRef(false);
  const noSpeechTimerRef = useRef<number | null>(null);
  const finalizePromiseRef = useRef<Promise<void> | null>(null);
  const snapshotCandidateRef = useRef<AttemptSnapshot | null>(null);
  const snapshotArtifactIdRef = useRef(`${attemptId}-snapshot`.slice(0, 96));
  const snapshotPersistenceRef = useRef<'idle' | 'pending' | 'succeeded' | 'failed'>('idle');
  const snapshotOperationTokenRef = useRef(0);
  const liveHintCoordinatorRef = useRef<LiveHintCoordinator | null>(null);
  const liveHintRequestMetaRef = useRef(new Map<number, LiveHintRequestMeta>());
  const liveHintAppendedSegmentsRef = useRef(new Set<string>());
  const liveAiConsentValidRef = useRef(qaMode());
  const explicitLiveAiOnRef = useRef(qaMode());
  const backendLiveAiOnRef = useRef(false);
  const liveAttemptLeaseReadyRef = useRef(false);
  const mountedRef = useRef(true);
  const resettingRef = useRef(false);
  const liveAiReadinessRevisionRef = useRef(0);
  const localAsrReadinessRevisionRef = useRef(0);
  const localAsrInstallRevisionRef = useRef(0);
  const localAsrInstallPromiseRef = useRef<Promise<boolean> | null>(null);
  const [durableSnapshot, setDurableSnapshot] = useState<AttemptSnapshot | null>(null);
  const [shortRecordingPending, setShortRecordingPending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const tailAnnotationContextStatusRef = useRef<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [tailAnnotationContextStatus, setTailAnnotationContextStatus] = useState<
    'idle' | 'loading' | 'ready' | 'failed'
  >('idle');
  const [tailAnnotationContextError, setTailAnnotationContextError] = useState<string | null>(null);
  const [cloudLiveContext, setCloudLiveContext] = useState<{
    readonly session: PracticeSession;
    readonly consent: NonNullable<CloudAiConsentStatus['consent']>;
  } | null>(null);
  const [liveAiReadiness, setLiveAiReadiness] = useState<LiveAiReadiness>(
    qaMode() ? 'ready' : 'loading',
  );
  const [localAsrReadiness, setLocalAsrReadiness] = useState<LocalAsrReadiness>(
    qaMode() ? 'ready' : 'checking',
  );
  const [localAsrInstallStatus, setLocalAsrInstallStatus] = useState<LocalAsrInstallStatus>('idle');
  const [localAsrInstallError, setLocalAsrInstallError] = useState<string | null>(null);

  const isActiveAttempt = useCallback((operationIdentity: AttemptIdentity): boolean => (
    mountedRef.current
    && identityRef.current.generation === operationIdentity.generation
    && identityRef.current.attemptId === operationIdentity.attemptId
  ), []);

  const emit = useCallback((event: EventWithoutMeta) => {
    eventCounterRef.current += 1;
    recordLiveDiagnostic({
      level: diagnosticLevelForLiveEvent(event),
      component: diagnosticComponentForLiveEvent(event),
      event: `live.${event.type}`,
      sessionId,
      attemptId,
      fields: {
        generation,
        ...diagnosticFieldsForLiveEvent(event),
      },
    });
    dispatch({
      ...event,
      id: `evt-${eventCounterRef.current}`,
      generation,
      sourceSequence: eventCounterRef.current,
    } as LiveAttemptEvent);
  }, [attemptId, generation, sessionId]);

  const syncBackendLiveAi = useCallback(async (
    operationIdentity: AttemptIdentity,
    enabled: boolean,
  ): Promise<boolean> => {
    try {
      const result = await setLiveAttemptAiState({
        sessionId,
        attemptId: operationIdentity.attemptId,
        generation: operationIdentity.generation,
        enabled,
      });
      if (!isActiveAttempt(operationIdentity)) {
        if (enabled) {
          void setLiveAttemptAiState({
            sessionId,
            attemptId: operationIdentity.attemptId,
            generation: operationIdentity.generation,
            enabled: false,
          }).catch(() => undefined);
        }
        return false;
      }
      backendLiveAiOnRef.current = result.enabled;
      return result.enabled === enabled;
    } catch {
      if (enabled && isActiveAttempt(operationIdentity)) {
        backendLiveAiOnRef.current = false;
        explicitLiveAiOnRef.current = false;
        liveHintCoordinatorRef.current?.disable();
        emit({ type: 'live_ai', enabled: false });
        emit({
          type: 'ai_failed',
          reason: '实时 AI 未能绑定到当前练习；本地转写与标注继续运行。',
        });
      }
      return false;
    }
  }, [emit, isActiveAttempt, sessionId]);

  const enableLiveCoordinator = useCallback(() => {
    if (!backendLiveAiOnRef.current || !explicitLiveAiOnRef.current || !navigator.onLine) return;
    liveHintCoordinatorRef.current?.enable();
    for (const segment of finalizedSegmentsRef.current) {
      if (liveHintAppendedSegmentsRef.current.has(segment.id)) continue;
      liveHintAppendedSegmentsRef.current.add(segment.id);
      liveHintCoordinatorRef.current?.appendFinal(segment.text);
    }
  }, []);

  const loadFrozenSession = useCallback((): Promise<PracticeSession | null> => {
    if (qaMode()) return Promise.resolve(null);
    if (frozenSessionRef.current?.id === sessionId) {
      return Promise.resolve(frozenSessionRef.current);
    }
    if (
      frozenSessionLoadRef.current &&
      frozenSessionRequestIdRef.current === sessionId
    ) return frozenSessionLoadRef.current;

    let operation: Promise<PracticeSession | null>;
    operation = Promise.resolve()
      .then(() => getPracticeSession(sessionId))
      .then((session) => {
        const frozen = session?.id === sessionId ? session : null;
        if (!frozen) throw new Error('PRACTICE_SESSION_CONTEXT_NOT_FOUND');
        frozenSessionRef.current = frozen;
        return frozen;
      })
      .catch((error: unknown) => {
        if (frozenSessionLoadRef.current === operation) {
          frozenSessionLoadRef.current = null;
          frozenSessionRequestIdRef.current = null;
        }
        throw error;
      });
    frozenSessionLoadRef.current = operation;
    frozenSessionRequestIdRef.current = sessionId;
    return operation;
  }, [sessionId]);

  useEffect(() => {
    void loadFrozenSession().catch(() => undefined);
  }, [loadFrozenSession]);

  const refreshLiveAiReadiness = useCallback(async (): Promise<LiveAiReadiness> => {
    if (qaMode()) return 'ready';
    const revision = ++liveAiReadinessRevisionRef.current;
    setLiveAiReadiness('loading');
    try {
      const [session, configuration, preferences, consent] = await Promise.all([
        loadFrozenSession(),
        getCloudAiConfiguration(),
        getCloudAiPreferences(),
        getCloudAiConsentStatus('live_hint'),
      ]);
      const readiness: LiveAiReadiness = !session
        ? 'session_unavailable'
        : !configuration.configured
          ? 'key_missing'
          : !consent.active || !consent.consent
            ? 'consent_missing'
            : !preferences.liveHintEnabled
              ? 'purpose_disabled'
              : 'ready';
      const valid = readiness === 'ready';
      if (!mountedRef.current || revision !== liveAiReadinessRevisionRef.current) return readiness;
      // Consumers may enable AI immediately after awaiting this refresh, before
      // React has committed the reducer event. Keep an imperative copy so that
      // action uses the just-verified consent rather than a stale render.
      liveAiConsentValidRef.current = valid;
      setCloudLiveContext(valid && session && consent.consent
        ? { session, consent: consent.consent }
        : null);
      setLiveAiReadiness(readiness);
      emit({ type: 'live_ai_consent_status', valid });
      return readiness;
    } catch {
      if (!mountedRef.current || revision !== liveAiReadinessRevisionRef.current) {
        return 'load_failed';
      }
      setCloudLiveContext(null);
      setLiveAiReadiness('load_failed');
      liveAiConsentValidRef.current = false;
      emit({ type: 'live_ai_consent_status', valid: false });
      return 'load_failed';
    }
  }, [emit, loadFrozenSession]);

  useEffect(() => {
    if (qaMode()) return;
    void refreshLiveAiReadiness();
  }, [refreshLiveAiReadiness]);

  const refreshLocalAsrReadiness = useCallback(async (): Promise<LocalAsrReadiness> => {
    if (qaMode()) return 'ready';
    const revision = ++localAsrReadinessRevisionRef.current;
    setLocalAsrReadiness('checking');
    try {
      const environment = await getEnvironmentStatus();
      const readiness: LocalAsrReadiness = environment.localAsr.ready
        ? 'ready'
        : 'model_missing';
      if (mountedRef.current && revision === localAsrReadinessRevisionRef.current) {
        setLocalAsrReadiness(readiness);
      }
      return readiness;
    } catch {
      if (mountedRef.current && revision === localAsrReadinessRevisionRef.current) {
        setLocalAsrReadiness('check_failed');
      }
      return 'check_failed';
    }
  }, []);

  useEffect(() => {
    if (qaMode()) return;
    void refreshLocalAsrReadiness();
  }, [refreshLocalAsrReadiness]);

  const installLocalAsrModel = useCallback((): Promise<boolean> => {
    if (qaMode()) return Promise.resolve(true);
    if (localAsrInstallPromiseRef.current) return localAsrInstallPromiseRef.current;

    const revision = ++localAsrInstallRevisionRef.current;
    setLocalAsrInstallStatus('installing');
    setLocalAsrInstallError(null);
    const operation = Promise.resolve()
      .then(() => installLocalAsrModelFromEnvironment())
      .then(async (result) => {
        const readiness = await refreshLocalAsrReadiness();
        const ready = result.localAsr.ready && readiness === 'ready';
        if (mountedRef.current && revision === localAsrInstallRevisionRef.current) {
          setLocalAsrInstallStatus(ready ? 'installed' : 'failed');
          setLocalAsrInstallError(ready
            ? null
            : '模型安装完成后仍未通过环境检查；请在设置中重新检查本地模型。');
        }
        return ready;
      })
      .catch((error: unknown) => {
        if (mountedRef.current && revision === localAsrInstallRevisionRef.current) {
          setLocalAsrInstallStatus('failed');
          setLocalAsrInstallError(localAsrInstallErrorMessage(error));
        }
        return false;
      })
      .finally(() => {
        if (localAsrInstallPromiseRef.current === operation) {
          localAsrInstallPromiseRef.current = null;
        }
      });
    localAsrInstallPromiseRef.current = operation;
    return operation;
  }, [refreshLocalAsrReadiness]);

  useEffect(() => {
    if (qaMode() || !cloudLiveContext) return;
    const task = taskContextForCloudAi(cloudLiveContext.session);
    const directedRubric = kind === 'retry' && cloudLiveContext.session.focus
      ? task.rubric.filter(
          (criterion) => criterion.criterionId === cloudLiveContext.session.focus?.criterionId,
        )
      : task.rubric;
    if (directedRubric.length === 0) {
      emit({
        type: 'ai_failed',
        reason: '复讲焦点与冻结 Rubric 不一致；实时 AI 已关闭，本地转写与标注继续运行。',
      });
      return;
    }
    const coordinator = new LiveHintCoordinator({
      attemptId,
      generation,
      policy: PHRIO_LIVE_AI_POLICY,
      request: async (request) => {
        const finalWindow = selectLiveHintFinalWindow(finalizedSegmentsRef.current);
        if (finalWindow.segments.length === 0 || !finalWindow.text) {
          throw new Error('LIVE_AI_NO_FINAL_SEGMENTS');
        }
        emit({ type: 'ai_pending' });
        const response = await executeLiveHint({
          schemaVersion: 'live-hint-1',
          purpose: 'live_hint',
          sessionId,
          attemptId,
          generation,
          phaseEpoch: generation,
          transcriptVersion: Math.max(1, finalizedSegmentsRef.current.length),
          requestSequence: request.requestSequence,
          policyHash: cloudLiveContext.consent.policyHash,
          task: {
            modeId: task.modeId,
            taskId: task.taskId,
            taskVersion: task.taskVersion,
            prompt: task.prompt,
            audience: task.audience,
            objective: task.objective,
            rubric: directedRubric,
          },
          finalWindow: {
            text: finalWindow.text,
            segmentRevisions: finalWindow.segments.map((segment) => ({
              id: segment.id,
              sequence: segment.sequence,
              revision: segment.revision,
              startMs: segment.startMs,
              endMs: segment.endMs,
              text: segment.text,
            })),
          },
        }, cloudLiveContext.consent.id);
        liveHintRequestMetaRef.current.set(request.requestSequence, {
          windowHash: await sha256(finalWindow.text),
          segmentIds: finalWindow.segments.map((segment) => segment.id),
          evidencePhrase: response.evidencePhrase,
          criterionId: response.criterionId,
        });
        return response.hint;
      },
      onResult: (result) => {
        recordLiveDiagnostic({
          level: result.reason === 'failed' || result.reason === 'timeout' ? 'warn' : 'info',
          component: 'ai',
          event: 'ai.live_hint_result',
          sessionId,
          attemptId,
          fields: {
            generation,
            sequence: result.requestSequence,
            reasonCode: result.reason,
            stale: result.stale,
          },
        });
        const meta = liveHintRequestMetaRef.current.get(result.requestSequence);
        liveHintRequestMetaRef.current.delete(result.requestSequence);
        if (result.reason === 'accepted' && meta) {
          const now = new Date().toISOString();
          emit({
            type: 'hint',
            hint: {
              id: `${attemptId}-hint-${result.requestSequence}`.slice(0, 96),
              attemptId,
              requestSequence: result.requestSequence,
              windowHash: meta.windowHash,
              segmentIds: [...meta.segmentIds],
              text: result.text,
              lifecycle: 'provisional',
              createdAt: now,
              updatedAt: now,
              reason: meta.evidencePhrase
                ? `基于精确 final 短语“${meta.evidencePhrase}”${meta.criterionId ? ` · ${meta.criterionId}` : ''}`
                : null,
            },
          });
          return;
        }
        if (result.reason === 'timeout' || result.reason === 'failed') {
          emit({
            type: 'ai_failed',
            reason: result.reason === 'timeout'
              ? '实时 AI 超时；本地转写与标注继续运行。'
              : '实时 AI 暂不可用；本地转写与标注继续运行。',
          });
        }
      },
    });
    coordinator.disable();
    liveHintCoordinatorRef.current = coordinator;
    liveHintAppendedSegmentsRef.current.clear();
    enableLiveCoordinator();
    return () => {
      coordinator.disable();
      if (liveHintCoordinatorRef.current === coordinator) {
        liveHintCoordinatorRef.current = null;
      }
      backendLiveAiOnRef.current = false;
      if (liveAttemptLeaseReadyRef.current) {
        void syncBackendLiveAi({ attemptId, generation }, false);
      }
      void cancelLiveHint(attemptId).catch(() => undefined);
    };
  }, [attemptId, cloudLiveContext, emit, enableLiveCoordinator, generation, kind, sessionId, syncBackendLiveAi]);

  useEffect(() => {
    const updateNetwork = () => {
      const online = navigator.onLine;
      emit({ type: 'network', status: online ? 'online' : 'offline' });
      if (!online) {
        backendLiveAiOnRef.current = false;
        liveHintCoordinatorRef.current?.disable();
        if (liveAttemptLeaseReadyRef.current) {
          void syncBackendLiveAi(identityRef.current, false);
        }
        void cancelLiveHint(attemptId).catch(() => undefined);
      } else if (explicitLiveAiOnRef.current) {
        const operationIdentity = identityRef.current;
        if (liveAttemptLeaseReadyRef.current) {
          void syncBackendLiveAi(operationIdentity, true).then((enabled) => {
            if (enabled) enableLiveCoordinator();
          });
        }
      }
    };
    window.addEventListener('online', updateNetwork);
    window.addEventListener('offline', updateNetwork);
    updateNetwork();
    return () => {
      window.removeEventListener('online', updateNetwork);
      window.removeEventListener('offline', updateNetwork);
    };
  }, [attemptId, emit, enableLiveCoordinator, syncBackendLiveAi]);

  const clearNoSpeechTimer = useCallback(() => {
    if (noSpeechTimerRef.current !== null) window.clearTimeout(noSpeechTimerRef.current);
    noSpeechTimerRef.current = null;
  }, []);

  const markAsrDegraded = useCallback((reason: string, code = 'asr_degraded') => {
    asrAvailableRef.current = false;
    asrFailureReasonRef.current = reason;
    emit({ type: 'asr_degraded', reason, code });
  }, [emit]);

  const requestAsrStop = useCallback((operationIdentity: AttemptIdentity) => {
    const key = `${operationIdentity.attemptId}:${operationIdentity.generation}`;
    const existing = asrStopOperationsRef.current.get(key);
    if (existing) return existing;
    const operation = Promise.resolve(stopLocalAsr(operationIdentity));
    asrStopOperationsRef.current.set(key, operation);
    return operation;
  }, []);

  const failTranscription = useCallback((reason: string) => {
    if (attemptFailedRef.current) return;
    attemptFailedRef.current = true;
    completionEmittedRef.current = true;
    setShortRecordingPending(false);
    emit({ type: 'transcription_failed', reason });
  }, [emit]);

  const ingestSegment = useCallback((segment: TranscriptSegment): boolean => {
    if (segment.attemptId !== identityRef.current.attemptId) return false;
    if (!voiceDetectedRef.current && segment.text.trim()) {
      voiceDetectedRef.current = true;
      clearNoSpeechTimer();
      emit({ type: 'voice_detected' });
    }
    const existing = acceptedSegmentsRef.current.get(segment.id);
    if (
      existing?.isFinal ||
      (existing && existing.revision >= segment.revision) ||
      (!existing && segment.sequence <= highestAcceptedSequenceRef.current)
    ) return false;

    acceptedSegmentsRef.current.set(segment.id, segment);
    highestAcceptedSequenceRef.current = Math.max(
      highestAcceptedSequenceRef.current,
      segment.sequence,
    );
    emit({ type: 'segment', segment });
    if (!segment.isFinal || analyzedSegmentsRef.current.has(segment.id)) return true;

    asrProducedFinalRef.current = true;
    analyzedSegmentsRef.current.add(segment.id);
    const previous = [...finalizedSegmentsRef.current]
      .sort((left, right) => left.sequence - right.sequence)
      .filter((candidate) => candidate.sequence < segment.sequence)
      .at(-1);
    finalizedSegmentsRef.current = [...finalizedSegmentsRef.current, segment]
      .sort((left, right) => left.sequence - right.sequence);
    if (localAnnotationsEnabledRef.current) {
      const provisional = annotateFinalSegment(segment, nextAnnotationOrdinalRef.current, {
        previousFinalEndMs: previous?.endMs,
      });
      const annotations = confirmOrWithdrawAnnotations({
        segment,
        annotations: provisional,
        at: segment.finalizedAt ?? segment.emittedAt,
      });
      nextAnnotationOrdinalRef.current += annotations.length;
      localAnnotationsRef.current.push(...annotations);
      emit({ type: 'annotations', segmentId: segment.id, annotations });
    }
    if (
      backendLiveAiOnRef.current &&
      explicitLiveAiOnRef.current &&
      navigator.onLine &&
      liveHintCoordinatorRef.current &&
      !liveHintAppendedSegmentsRef.current.has(segment.id)
    ) {
      liveHintAppendedSegmentsRef.current.add(segment.id);
      liveHintCoordinatorRef.current.appendFinal(segment.text);
    }
    return true;
  }, [clearNoSpeechTimer, emit]);

  const maybeCompleteTail = useCallback(() => {
    if (
      attemptFailedRef.current ||
      completionEmittedRef.current ||
      !tailReadyRef.current ||
      !recordingReadyRef.current
    ) return;

    if (finalizedSegmentsRef.current.length === 0) {
      failTranscription(
        '停止后没有形成可用的 final 逐字稿；当前音频会留在本页，请重新录制并重试转写。',
      );
      return;
    }

    if (
      recordingReadyRef.current.durationMs < MIN_RELIABLE_RECORDING_MS &&
      !shortRecordingAcceptedRef.current
    ) {
      if (!shortRecordingGateShownRef.current) {
        shortRecordingGateShownRef.current = true;
        setShortRecordingPending(true);
        emit({
          type: 'recording_too_short',
          reason: '这遍不足 20 秒，可能无法形成可靠证据。你可以回放后仍使用，或重新录制。',
        });
      }
      return;
    }

    completionEmittedRef.current = true;
    setShortRecordingPending(false);
    emit({ type: 'tail_complete' });
  }, [emit, failTranscription]);

  const reconcileTailAnnotations = useCallback(async (
    operationIdentity: AttemptIdentity,
  ): Promise<boolean> => {
    if (!isActiveAttempt(operationIdentity)) return false;
    if (
      !localAnnotationsEnabledRef.current ||
      finalizedSegmentsRef.current.length === 0
    ) {
      tailAnnotationContextStatusRef.current = 'ready';
      setTailAnnotationContextStatus('ready');
      setTailAnnotationContextError(null);
      return true;
    }

    tailAnnotationContextStatusRef.current = 'loading';
    setTailAnnotationContextStatus('loading');
    setTailAnnotationContextError(null);
    let session: PracticeSession | null;
    try {
      session = await loadFrozenSession();
    } catch {
      if (!isActiveAttempt(operationIdentity)) return false;
      const reason = '无法读取本轮冻结任务上下文；final 句段和本地规则证据已保留，但任务缺口尚未核对，当前不会冻结快照。请重试任务核对。';
      tailAnnotationContextStatusRef.current = 'failed';
      setTailAnnotationContextStatus('failed');
      setTailAnnotationContextError(reason);
      return false;
    }
    if (!isActiveAttempt(operationIdentity)) return false;
    if (!localAnnotationsEnabledRef.current) {
      tailAnnotationContextStatusRef.current = 'ready';
      setTailAnnotationContextStatus('ready');
      setTailAnnotationContextError(null);
      return true;
    }

    const reconciliation = reconcileFinalTailAnnotations({
      finalSegments: finalizedSegmentsRef.current,
      existingAnnotations: localAnnotationsRef.current,
      startingOrdinal: nextAnnotationOrdinalRef.current,
      task: session
        ? {
            requiredFields: session.taskSnapshot.requiredFields,
            successConditions: session.taskSnapshot.successConditions,
          }
        : null,
    });
    nextAnnotationOrdinalRef.current = reconciliation.nextOrdinal;

    for (const withdrawal of reconciliation.withdrawals) {
      localAnnotationsRef.current = localAnnotationsRef.current.map((item) =>
        item.id === withdrawal.annotationId
          ? {
              ...item,
              lifecycle: 'withdrawn' as const,
              updatedAt: withdrawal.at,
              withdrawnReason: withdrawal.reason,
            }
          : item,
      );
      emit({
        type: 'annotation_withdrawn',
        annotationId: withdrawal.annotationId,
        reason: withdrawal.reason,
        at: withdrawal.at,
      });
    }

    for (const annotation of reconciliation.upserts) {
      const existingIndex = localAnnotationsRef.current.findIndex(
        (item) => item.id === annotation.id,
      );
      if (existingIndex < 0) {
        localAnnotationsRef.current.push(annotation);
      } else {
        localAnnotationsRef.current = localAnnotationsRef.current.map((item) =>
          item.id === annotation.id ? annotation : item,
        );
      }
      emit({
        type: 'annotations',
        segmentId: annotation.segmentId,
        annotations: [annotation],
      });
    }
    const confirmationAt = finalizedSegmentsRef.current.at(-1)?.finalizedAt
      ?? finalizedSegmentsRef.current.at(-1)?.emittedAt
      ?? new Date().toISOString();
    for (const segment of finalizedSegmentsRef.current) {
      const reconciled = confirmOrWithdrawAnnotations({
        segment,
        annotations: localAnnotationsRef.current,
        at: confirmationAt,
      });
      const changed = reconciled.filter((annotation, index) =>
        annotation !== localAnnotationsRef.current[index],
      );
      localAnnotationsRef.current = [...reconciled];
      if (changed.length > 0) {
        emit({ type: 'annotations', segmentId: segment.id, annotations: changed });
      }
    }
    tailAnnotationContextStatusRef.current = 'ready';
    setTailAnnotationContextStatus('ready');
    setTailAnnotationContextError(null);
    return true;
  }, [emit, isActiveAttempt, loadFrozenSession]);

  const completeTail = useCallback(async (
    operationIdentity: AttemptIdentity,
  ): Promise<void> => {
    const reconciled = await reconcileTailAnnotations(operationIdentity);
    if (!reconciled || !isActiveAttempt(operationIdentity)) return;
    tailReadyRef.current = true;
    maybeCompleteTail();
  }, [isActiveAttempt, maybeCompleteTail, reconcileTailAnnotations]);

  const retryTailAnnotationContext = useCallback(() => {
    if (
      tailAnnotationContextStatusRef.current !== 'failed' ||
      completionEmittedRef.current ||
      tailReadyRef.current
    ) return;
    tailAnnotationContextStatusRef.current = 'loading';
    setTailAnnotationContextStatus('loading');
    setTailAnnotationContextError(null);
    void completeTail(identityRef.current);
  }, [completeTail]);

  const enqueuePcm = useCallback((samples: Float32Array) => {
    const operationIdentity = identityRef.current;
    const queue = feedQueueRef.current;
    const queuedAt = performance.now();
    if (queue.pendingSamples + samples.length > MAX_PENDING_ASR_PCM_SAMPLES) {
      pendingPcmOverflowRef.current = true;
      droppedPcmSamplesRef.current += samples.length;
      markAsrDegraded(
        '本地 ASR 处理速度跟不上录音，8 秒待处理队列已满；当前音频会留在本页，请重新录制并重试转写。',
        'feed_queue_overflow',
      );
      return;
    }
    queue.pendingSamples += samples.length;
    feedQueueHighWaterRef.current = Math.max(
      feedQueueHighWaterRef.current,
      queue.pendingSamples,
    );
    feedTailRef.current = feedTailRef.current
      .then(async () => {
        if (
          identityRef.current.generation !== operationIdentity.generation ||
          identityRef.current.attemptId !== operationIdentity.attemptId
        ) return;
        const queueLatencyMs = Math.max(0, Math.round(performance.now() - queuedAt));
        feedQueueLatencyCountRef.current += 1;
        feedQueueLatencyTotalMsRef.current += queueLatencyMs;
        feedQueueLatencyMaximumMsRef.current = Math.max(
          feedQueueLatencyMaximumMsRef.current,
          queueLatencyMs,
        );
        if (queueLatencyMs >= 100) feedQueueLatencyOver100MsRef.current += 1;
        if (queueLatencyMs >= 250) feedQueueLatencyOver250MsRef.current += 1;
        if (asrFeedFailedRef.current) return;
        try {
          const segment = await withAsrTimeout(
            feedLocalAsr({ ...operationIdentity, samples }),
            'ASR_FEED_TIMEOUT',
          );
          if (
            identityRef.current.generation !== operationIdentity.generation ||
            identityRef.current.attemptId !== operationIdentity.attemptId ||
            asrFeedFailedRef.current ||
            attemptFailedRef.current
          ) return;
          if (segment) {
            ingestSegment(segment);
          }
        } catch {
          if (
            identityRef.current.generation !== operationIdentity.generation ||
            identityRef.current.attemptId !== operationIdentity.attemptId
          ) return;
          asrFeedFailedRef.current = true;
          markAsrDegraded(
            '流式转写已中断；当前音频会留在本页，请重新录制并重试转写。',
            'feed_failed',
          );
        }
      })
      .finally(() => {
        queue.pendingSamples = Math.max(0, queue.pendingSamples - samples.length);
      });
  }, [ingestSegment, markAsrDegraded]);

  const onPermissionGranted = useCallback(() => {
    emit({ type: 'permission_granted' });
    asrAvailableRef.current = false;
    asrStopRequestedRef.current = false;
    recordingStopRequestedRef.current = false;
    asrFeedFailedRef.current = false;
    pcmChannelUnavailableRef.current = false;
    pcmCaptureIncompleteRef.current = false;
    asrProducedFinalRef.current = false;
    asrFailureReasonRef.current = null;
    pendingPcmRef.current = [];
    pendingPcmSamplesRef.current = 0;
    pendingPcmOverflowRef.current = false;
    feedQueueRef.current = { pendingSamples: 0 };
    feedQueueHighWaterRef.current = 0;
    feedQueueLatencyCountRef.current = 0;
    feedQueueLatencyTotalMsRef.current = 0;
    feedQueueLatencyMaximumMsRef.current = 0;
    feedQueueLatencyOver100MsRef.current = 0;
    feedQueueLatencyOver250MsRef.current = 0;
    droppedPcmSamplesRef.current = 0;
    capturedPcmSamplesRef.current = 0;
    feedTailRef.current = Promise.resolve();
    const operationIdentity = identityRef.current;
    let abandoned = false;
    abandonPendingAsrStartRef.current = () => {
      abandoned = true;
    };

    const rawStart = startLocalAsr({ sessionId, ...operationIdentity });
    const startOperation = withAsrTimeout(rawStart, 'ASR_START_TIMEOUT')
      .then<AsrStartOutcome>(async () => {
        if (
          abandoned ||
          identityRef.current.generation !== operationIdentity.generation ||
          identityRef.current.attemptId !== operationIdentity.attemptId
        ) {
          void requestAsrStop(operationIdentity).catch(() => undefined);
          return 'failed';
        }
        liveAttemptLeaseReadyRef.current = true;
        if (explicitLiveAiOnRef.current && navigator.onLine) {
          const enabled = await syncBackendLiveAi(operationIdentity, true);
          if (enabled) enableLiveCoordinator();
        }
        asrAvailableRef.current = true;
        const buffered = pendingPcmRef.current;
        pendingPcmRef.current = [];
        pendingPcmSamplesRef.current = 0;
        for (const samples of buffered) enqueuePcm(samples);
        return 'ready';
      })
      .catch<AsrStartOutcome>(() => {
        abandoned = true;
        liveAttemptLeaseReadyRef.current = false;
        backendLiveAiOnRef.current = false;
        pendingPcmRef.current = [];
        pendingPcmSamplesRef.current = 0;
        if (
          identityRef.current.generation === operationIdentity.generation &&
          identityRef.current.attemptId === operationIdentity.attemptId
        ) {
          markAsrDegraded(
            '本地 ASR 模型未安装、启动失败或超时；当前音频会留在本页，请重新录制并重试转写。',
            'start_failed_or_timeout',
          );
        }
        return 'failed';
      });
    void rawStart.then(() => {
      if (abandoned) {
        void requestAsrStop(operationIdentity).catch(() => undefined);
      }
    }).catch(() => undefined);
    asrStartRef.current = startOperation;
  }, [emit, enableLiveCoordinator, enqueuePcm, markAsrDegraded, requestAsrStop, sessionId, syncBackendLiveAi]);

  const onPcmChunk = useCallback((samples: Float32Array) => {
    if (asrStopRequestedRef.current) return;
    const retainedSamples = Math.min(
      capturedPcmSamplesRef.current,
      MAX_CAPTURED_ASR_PCM_SAMPLES,
    );
    capturedPcmSamplesRef.current += samples.length;
    const captureRemaining = MAX_CAPTURED_ASR_PCM_SAMPLES - retainedSamples;
    if (captureRemaining > 0) {
      capturedPcmRef.current.push(
        samples.length <= captureRemaining ? samples.slice() : samples.slice(0, captureRemaining),
      );
    }
    if (asrFeedFailedRef.current || pendingPcmOverflowRef.current) return;
    if (asrAvailableRef.current) {
      enqueuePcm(samples);
      return;
    }
    if (!asrStartRef.current) return;

    const remaining = MAX_PENDING_ASR_PCM_SAMPLES - pendingPcmSamplesRef.current;
    if (remaining > 0) {
      const retained = samples.length <= remaining ? samples : samples.slice(0, remaining);
      pendingPcmRef.current.push(retained);
      pendingPcmSamplesRef.current += retained.length;
      feedQueueHighWaterRef.current = Math.max(
        feedQueueHighWaterRef.current,
        pendingPcmSamplesRef.current,
      );
    }
    if (samples.length > remaining) {
      pendingPcmOverflowRef.current = true;
      droppedPcmSamplesRef.current += samples.length - Math.max(0, remaining);
      markAsrDegraded(
        '本地 ASR 启动过慢，8 秒实时缓冲已满；当前音频会留在本页，请重新录制并重试转写。',
        'startup_queue_overflow',
      );
    }
  }, [enqueuePcm, markAsrDegraded]);

  const resetTransientTranscriptForRecovery = useCallback((): boolean => {
    if (finalizedSegmentsRef.current.length > 0) return false;
    const finalEntries = [...acceptedSegmentsRef.current.entries()]
      .filter(([, segment]) => segment.isFinal);
    const finalSegmentIds = new Set(finalEntries.map(([segmentId]) => segmentId));
    acceptedSegmentsRef.current = new Map(finalEntries);
    highestAcceptedSequenceRef.current = finalEntries.reduce(
      (highest, [, segment]) => Math.max(highest, segment.sequence),
      -1,
    );
    analyzedSegmentsRef.current = new Set(
      [...analyzedSegmentsRef.current].filter((segmentId) => finalSegmentIds.has(segmentId)),
    );
    finalizedSegmentsRef.current = finalizedSegmentsRef.current
      .filter((segment) => finalSegmentIds.has(segment.id));
    localAnnotationsRef.current = localAnnotationsRef.current
      .filter((annotation) => finalSegmentIds.has(annotation.segmentId));
    liveHintAppendedSegmentsRef.current = new Set(
      [...liveHintAppendedSegmentsRef.current]
        .filter((segmentId) => finalSegmentIds.has(segmentId)),
    );
    nextAnnotationOrdinalRef.current = localAnnotationsRef.current.reduce((next, annotation) => {
      const ordinal = Number.parseInt(annotation.displayId.slice(1), 10);
      return Number.isFinite(ordinal) ? Math.max(next, ordinal + 1) : next;
    }, 1);
    asrProducedFinalRef.current = finalizedSegmentsRef.current.length > 0;
    emit({ type: 'asr_retry_reset' });
    return true;
  }, [emit]);

  const recoverAsrFromCapturedPcm = useCallback(async (
    operationIdentity: AttemptIdentity,
  ): Promise<boolean> => {
    // Replaying from sample zero after any final exists would fork both the UI
    // transcript and backend final ledger. Recovery is safe only while the
    // authoritative attempt still has no final; otherwise require re-recording.
    if (
      asrRecoveryAttemptedRef.current
      || asrProducedFinalRef.current
      || pcmCaptureIncompleteRef.current
      || capturedPcmRef.current.length === 0
    ) return false;
    asrRecoveryAttemptedRef.current = true;
    if (!resetTransientTranscriptForRecovery()) return false;
    const rawRecoveryStart = Promise.resolve().then(() =>
      startLocalAsr({ sessionId, ...operationIdentity, restartIfNoFinal: true }),
    );
    let recoveryStarted = false;
    let recoveryStopIssued = false;
    try {
      await withAsrTimeout(
        rawRecoveryStart,
        'ASR_RECOVERY_START_TIMEOUT',
      );
      recoveryStarted = true;
      if (!isActiveAttempt(operationIdentity)) return false;
      let recoveredFinal = false;
      for (const samples of capturedPcmRef.current) {
        if (!isActiveAttempt(operationIdentity)) return false;
        const segment = await withAsrTimeout(
          feedLocalAsr({ ...operationIdentity, samples }),
          'ASR_RECOVERY_FEED_TIMEOUT',
        );
        if (!isActiveAttempt(operationIdentity)) return false;
        if (segment) {
          const accepted = ingestSegment(segment);
          if (accepted && segment.isFinal) recoveredFinal = true;
        }
      }
      recoveryStopIssued = true;
      const tail = await withAsrTimeout(
        stopLocalAsr(operationIdentity),
        'ASR_RECOVERY_STOP_TIMEOUT',
      );
      if (!isActiveAttempt(operationIdentity)) return false;
      if (tail) {
        const accepted = ingestSegment(tail);
        if (accepted && tail.isFinal) recoveredFinal = true;
      }
      if (
        !recoveredFinal ||
        !asrProducedFinalRef.current ||
        finalizedSegmentsRef.current.length === 0
      ) return false;
      asrFeedFailedRef.current = false;
      pendingPcmOverflowRef.current = false;
      asrFailureReasonRef.current = null;
      return true;
    } catch {
      return false;
    } finally {
      if (!recoveryStopIssued) {
        if (recoveryStarted) {
          void stopLocalAsr(operationIdentity).catch(() => undefined);
        } else {
          // The renderer timeout does not cancel an already-dispatched IPC.
          // If native initialization succeeds late, close that recognizer as
          // soon as the original start promise settles.
          void rawRecoveryStart.then(() =>
            stopLocalAsr(operationIdentity),
          ).catch(() => undefined);
        }
      }
    }
  }, [ingestSegment, isActiveAttempt, resetTransientTranscriptForRecovery, sessionId]);

  const finalizeTail = useCallback((): Promise<void> => {
    if (completionEmittedRef.current || tailReadyRef.current) return Promise.resolve();
    if (finalizePromiseRef.current) return finalizePromiseRef.current;
    const operationIdentity = identityRef.current;
    const operation = (async () => {
      clearNoSpeechTimer();
      asrStopRequestedRef.current = true;
      explicitLiveAiOnRef.current = false;
      backendLiveAiOnRef.current = false;
      liveHintCoordinatorRef.current?.disable();
      if (liveAttemptLeaseReadyRef.current) {
        void syncBackendLiveAi(operationIdentity, false);
      }
      void cancelLiveHint(operationIdentity.attemptId).catch(() => undefined);
      emit({ type: 'live_ai', enabled: false });
      const audioWatermark = Math.max(
        0,
        Math.round((capturedPcmSamplesRef.current / 16_000) * 1_000),
      );
      emit({ type: 'stop_requested', audioWatermark });
      recordLiveDiagnostic({
        level: pendingPcmOverflowRef.current || asrFeedFailedRef.current ? 'warn' : 'info',
        component: 'asr',
        event: 'asr.capture_summary',
        sessionId,
        attemptId: operationIdentity.attemptId,
        fields: {
          generation: operationIdentity.generation,
          captureId,
          capturedSamples: capturedPcmSamplesRef.current,
          queueHighWaterSamples: feedQueueHighWaterRef.current,
          droppedSamples: droppedPcmSamplesRef.current,
          pendingSamples: feedQueueRef.current.pendingSamples,
          startupPendingSamples: pendingPcmSamplesRef.current,
          feedFailed: asrFeedFailedRef.current,
          overflowed: pendingPcmOverflowRef.current,
          queueLatencySampleCount: feedQueueLatencyCountRef.current,
          averageQueueLatencyMs: feedQueueLatencyCountRef.current > 0
            ? Math.round(
              feedQueueLatencyTotalMsRef.current / feedQueueLatencyCountRef.current,
            )
            : null,
          maximumQueueLatencyMs: feedQueueLatencyMaximumMsRef.current,
          queueLatencyOver100MsCount: feedQueueLatencyOver100MsRef.current,
          queueLatencyOver250MsCount: feedQueueLatencyOver250MsRef.current,
        },
      });

      const startOperation = asrStartRef.current;
      const startOutcome = startOperation ? await startOperation : 'failed';
      if (
        identityRef.current.generation !== operationIdentity.generation ||
        identityRef.current.attemptId !== operationIdentity.attemptId
      ) return;
      if (startOutcome !== 'ready') {
        failTranscription(
          asrFailureReasonRef.current ??
          '本地转写没有启动成功；当前音频会留在本页，请重新录制并重试转写。',
        );
        return;
      }

      try {
        await withAsrTimeout(feedTailRef.current, 'ASR_FEED_DRAIN_TIMEOUT');
      } catch {
        if (
          identityRef.current.generation !== operationIdentity.generation ||
          identityRef.current.attemptId !== operationIdentity.attemptId
        ) return;
        asrFeedFailedRef.current = true;
        const reason =
          '本地 ASR 待处理音频未能在 8 秒内收束；当前音频会留在本页，请重新录制并重试转写。';
        asrFailureReasonRef.current = reason;
        if (await recoverAsrFromCapturedPcm(operationIdentity)) {
          await completeTail(operationIdentity);
          return;
        }
        await requestAsrStop(operationIdentity).catch(() => undefined);
        failTranscription(reason);
        return;
      }
      if (
        identityRef.current.generation !== operationIdentity.generation ||
        identityRef.current.attemptId !== operationIdentity.attemptId
      ) return;
      if (asrFeedFailedRef.current || pendingPcmOverflowRef.current) {
        const reason = asrFeedFailedRef.current
          ? asrFailureReasonRef.current
            ?? '流式转写已中断；当前音频会留在本页，请重新录制并重试转写。'
          : asrFailureReasonRef.current
            ?? '本地 ASR 待处理音频超过 8 秒；当前音频会留在本页，请重新录制并重试转写。';
        if (await recoverAsrFromCapturedPcm(operationIdentity)) {
          await completeTail(operationIdentity);
          return;
        }
        await requestAsrStop(operationIdentity).catch(() => undefined);
        failTranscription(reason);
        return;
      }
      let tail: TranscriptSegment | null;
      try {
        tail = await withAsrTimeout(requestAsrStop(operationIdentity), 'ASR_STOP_TIMEOUT');
      } catch {
        if (
          identityRef.current.generation !== operationIdentity.generation ||
          identityRef.current.attemptId !== operationIdentity.attemptId
        ) return;
        asrStartRef.current = null;
        failTranscription(
          '本地 ASR 停止、超时或尾句收束失败；当前音频会留在本页，请重新录制并重试转写。',
        );
        return;
      }
      if (
        identityRef.current.generation !== operationIdentity.generation ||
        identityRef.current.attemptId !== operationIdentity.attemptId
      ) return;

      asrStartRef.current = null;
      asrAvailableRef.current = false;
      liveAttemptLeaseReadyRef.current = false;
      if (tail) {
        ingestSegment(tail);
      }
      if (!voiceDetectedRef.current) {
        failTranscription('这遍没有检测到有效语音，不会生成训练结论。请回放检查或重新录制。');
        return;
      }
      if (!asrProducedFinalRef.current) {
        if (await recoverAsrFromCapturedPcm(operationIdentity)) {
          await completeTail(operationIdentity);
          return;
        }
        failTranscription(
          '停止后没有形成可用的 final 逐字稿；当前音频会留在本页，请重新录制并重试转写。',
        );
        return;
      }
      await completeTail(operationIdentity);
    })().finally(() => {
      if (
        identityRef.current.generation === operationIdentity.generation &&
        identityRef.current.attemptId === operationIdentity.attemptId
      ) finalizePromiseRef.current = null;
    });
    finalizePromiseRef.current = operation;
    return operation;
  }, [
    captureId,
    clearNoSpeechTimer,
    completeTail,
    emit,
    failTranscription,
    ingestSegment,
    recoverAsrFromCapturedPcm,
    requestAsrStop,
    sessionId,
    syncBackendLiveAi,
  ]);

  const closeAsrWithoutFinalizing = useCallback((reason: string) => {
    if (attemptFailedRef.current) return;
    attemptFailedRef.current = true;
    completionEmittedRef.current = true;
    clearNoSpeechTimer();
    setShortRecordingPending(false);
    emit({ type: 'capture_interrupted', reason });
    asrStopRequestedRef.current = true;
    abandonPendingAsrStartRef.current?.();
    const operationIdentity = identityRef.current;
    explicitLiveAiOnRef.current = false;
    backendLiveAiOnRef.current = false;
    liveHintCoordinatorRef.current?.disable();
    if (liveAttemptLeaseReadyRef.current) {
      void syncBackendLiveAi(operationIdentity, false);
    }
    void cancelLiveHint(operationIdentity.attemptId).catch(() => undefined);
    const startOperation = asrStartRef.current;
    const feedTail = feedTailRef.current;
    void (async () => {
      const outcome = startOperation ? await startOperation.catch(() => 'failed' as const) : 'failed';
      if (outcome !== 'ready') return;
      await feedTail.catch(() => undefined);
      await requestAsrStop(operationIdentity).catch(() => undefined);
    })();
  }, [clearNoSpeechTimer, emit, requestAsrStop, syncBackendLiveAi]);

  const onRecordingStarted = useCallback(() => {
    emit({ type: 'recording_started' });
    clearNoSpeechTimer();
    noSpeechTimerRef.current = window.setTimeout(() => {
      if (!voiceDetectedRef.current && !asrStopRequestedRef.current) {
        emit({ type: 'no_speech' });
      }
    }, NO_SPEECH_WARNING_MS);
  }, [clearNoSpeechTimer, emit]);

  const onVoiceDetected = useCallback(() => {
    voiceDetectedRef.current = true;
    clearNoSpeechTimer();
    emit({ type: 'voice_detected' });
  }, [clearNoSpeechTimer, emit]);

  const onRecordingStopRequested = useCallback(() => {
    if (recordingStopRequestedRef.current) return;
    recordingStopRequestedRef.current = true;
    clearNoSpeechTimer();
    const operationIdentity = identityRef.current;
    explicitLiveAiOnRef.current = false;
    backendLiveAiOnRef.current = false;
    liveHintCoordinatorRef.current?.disable();
    if (liveAttemptLeaseReadyRef.current) {
      void Promise.resolve().then(() => setLiveAttemptAiState({
        sessionId,
        attemptId: operationIdentity.attemptId,
        generation: operationIdentity.generation,
        enabled: false,
        sealed: true,
      })).catch(() => undefined);
    }
    void cancelLiveHint(operationIdentity.attemptId).catch(() => undefined);
    emit({ type: 'live_ai', enabled: false });
    // MediaRecorder's stop event first disconnects the Web Audio analysis graph,
    // then invokes onRecordingReady. Only that callback is a safe PCM watermark:
    // finalizing ASR here could drop the last AudioWorklet block and its flush ACK.
  }, [clearNoSpeechTimer, emit, sessionId]);

  const recoverCapturedPcmFromRecording = useCallback(async (
    recording: RecordedAudio,
    operationIdentity: AttemptIdentity,
    replaceExistingCapture = false,
  ): Promise<boolean> => {
    if (
      (!replaceExistingCapture && capturedPcmSamplesRef.current > 0)
      || finalizedSegmentsRef.current.length > 0
      || attemptFailedRef.current
      || !isActiveAttempt(operationIdentity)
    ) return false;
    try {
      const decoded = await decodeRecordedAudioToMono16Khz(recording.blob);
      if (!isActiveAttempt(operationIdentity) || attemptFailedRef.current) return false;
      const retained = decoded.samples.length <= MAX_CAPTURED_ASR_PCM_SAMPLES
        ? decoded.samples
        : decoded.samples.slice(0, MAX_CAPTURED_ASR_PCM_SAMPLES);
      const chunks: Float32Array[] = [];
      for (let offset = 0; offset < retained.length; offset += RECOVERED_PCM_CHUNK_SAMPLES) {
        chunks.push(retained.slice(offset, offset + RECOVERED_PCM_CHUNK_SAMPLES));
      }
      capturedPcmRef.current = chunks;
      capturedPcmSamplesRef.current = retained.length;
      pcmCaptureIncompleteRef.current = false;
      // The live recognizer never received these samples. Force the existing
      // stop path through its one-time same-Attempt replay boundary.
      asrFeedFailedRef.current = true;
      asrFailureReasonRef.current =
        '实时 PCM 通道没有送达音频，已从本遍录音恢复并重新转写。';
      recordLiveDiagnostic({
        level: decoded.peak >= 0.015 || decoded.rms >= 0.003 ? 'info' : 'warn',
        component: 'recording',
        event: 'recording.pcm_recovered_from_media',
        sessionId,
        attemptId: operationIdentity.attemptId,
        fields: {
          generation: operationIdentity.generation,
          sourceSampleRate: decoded.sourceSampleRate,
          sourceChannelCount: decoded.sourceChannelCount,
          durationMs: decoded.durationMs,
          recoveredSamples: retained.length,
          peak: decoded.peak,
          rms: decoded.rms,
          truncated: retained.length !== decoded.samples.length,
        },
      });
      return retained.length > 0;
    } catch (error) {
      if (!isActiveAttempt(operationIdentity)) return false;
      recordLiveDiagnostic({
        level: 'warn',
        component: 'recording',
        event: 'recording.media_decode_failed',
        sessionId,
        attemptId: operationIdentity.attemptId,
        fields: {
          generation: operationIdentity.generation,
          errorCode: error instanceof RecordedAudioDecodeError
            ? error.code
            : 'RECORDED_AUDIO_DECODE_FAILED',
        },
      });
      return false;
    }
  }, [isActiveAttempt, sessionId]);

  const recorder = useAudioRecorder({
    sessionId,
    attemptId,
    captureId,
    onPermissionGranted,
    onPermissionDenied: (reason) => emit({ type: 'permission_denied', reason }),
    onCaptureError: closeAsrWithoutFinalizing,
    onCaptureInterrupted: closeAsrWithoutFinalizing,
    onRecordingStarted,
    onRecordingReady: (recording) => {
      recordingReadyRef.current = recording;
      const operationIdentity = identityRef.current;
      void (async () => {
        const replaceIncompleteLiveCapture = pcmCaptureIncompleteRef.current;
        if (
          recordingStopRequestedRef.current
          && finalizedSegmentsRef.current.length === 0
          && (capturedPcmSamplesRef.current === 0 || replaceIncompleteLiveCapture)
        ) {
          await recoverCapturedPcmFromRecording(
            recording,
            operationIdentity,
            replaceIncompleteLiveCapture,
          );
        }
        if (!isActiveAttempt(operationIdentity)) return;
        if (recordingStopRequestedRef.current) {
          await finalizeTail();
        } else {
          maybeCompleteTail();
        }
      })();
    },
    onVoiceDetected,
    onPcmUnavailable: (reason, degradationCode) => {
      pcmChannelUnavailableRef.current = true;
      pcmCaptureIncompleteRef.current = true;
      asrFeedFailedRef.current = true;
      markAsrDegraded(reason, degradationCode);
    },
    onPcmRecovered: () => {
      if (!pcmChannelUnavailableRef.current) return;
      pcmChannelUnavailableRef.current = false;
      markAsrDegraded(
        '实时 PCM 已恢复，但中断区间将在停止后从同一遍录音恢复转写。',
      );
    },
    onPcmChunk,
    onStopRequested: onRecordingStopRequested,
  });

  const persistSnapshot = useCallback((candidate: AttemptSnapshot) => {
    const previousStatus = snapshotPersistenceRef.current;
    if (previousStatus === 'pending' || previousStatus === 'succeeded') return;
    snapshotPersistenceRef.current = 'pending';
    if (previousStatus === 'failed') {
      emit({ type: 'report_status', status: 'queued', reason: null });
    }
    const operationToken = snapshotOperationTokenRef.current;
    const persistence = savePracticeArtifact({
      type: 'attempt_snapshot',
      id: candidate.id,
      sessionId: candidate.sessionId,
      payload: candidate,
    });
    void new Promise<Awaited<typeof persistence>>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('SNAPSHOT_PERSIST_TIMEOUT')),
        SNAPSHOT_PERSIST_TIMEOUT_MS,
      );
      persistence.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          window.clearTimeout(timer);
          reject(error);
        },
      );
    }).then((persisted) => {
      if (
        persisted.type !== 'attempt_snapshot' ||
        persisted.id !== candidate.id ||
        persisted.sessionId !== candidate.sessionId
      ) {
        throw new Error('PERSISTED_SNAPSHOT_IDENTITY_MISMATCH');
      }
      if (operationToken !== snapshotOperationTokenRef.current) return;
      snapshotPersistenceRef.current = 'succeeded';
      if (!mountedRef.current) return;
      setDurableSnapshot(candidate);
      emit({ type: 'snapshot_frozen', snapshotId: candidate.id });
      emit({ type: 'report_status', status: 'awaiting_consent' });
    }).catch(() => {
      if (operationToken !== snapshotOperationTokenRef.current) return;
      snapshotPersistenceRef.current = 'failed';
      if (!mountedRef.current) return;
      emit({ type: 'report_status', status: 'failed', reason: '冻结快照未能持久化。请保留在本页并重试保存。' });
    });
  }, [emit]);

  useEffect(() => {
    if (
      state.capture !== 'safe_end' ||
      state.asr !== 'ready' ||
      state.audioWatermark === null ||
      state.frozenSnapshotId ||
      snapshotPersistenceRef.current !== 'idle'
    ) return;
    const candidate = freezeAttemptSnapshot({
      state,
      snapshotId: snapshotArtifactIdRef.current,
      frozenAt: new Date().toISOString(),
      transcriptVersion: 1,
      focusVersion: focusVersion === undefined
        ? kind === 'retry' ? 1 : null
        : focusVersion,
    });
    snapshotCandidateRef.current = candidate;
    persistSnapshot(candidate);
  }, [attemptId, focusVersion, kind, persistSnapshot, state]);

  const retrySnapshotPersistence = useCallback(() => {
    const candidate = snapshotCandidateRef.current;
    if (!candidate || snapshotPersistenceRef.current !== 'failed') return;
    persistSnapshot(candidate);
  }, [persistSnapshot]);

  const acceptShortRecording = useCallback(() => {
    if (
      !shortRecordingGateShownRef.current ||
      shortRecordingAcceptedRef.current ||
      attemptFailedRef.current
    ) return;
    shortRecordingAcceptedRef.current = true;
    maybeCompleteTail();
  }, [maybeCompleteTail]);

  const startRecording = useCallback(async (): Promise<boolean> => {
    const readiness = await refreshLocalAsrReadiness();
    if (readiness !== 'ready') {
      recordLiveDiagnostic({
        level: readiness === 'model_missing' ? 'warn' : 'error',
        component: 'asr',
        event: 'asr.recording_preflight_blocked',
        sessionId,
        attemptId: identityRef.current.attemptId,
        fields: {
          generation: identityRef.current.generation,
          reasonCode: readiness,
        },
      });
      return false;
    }
    await recorder.start();
    return true;
  }, [recorder, refreshLocalAsrReadiness, sessionId]);

  const retryTranscriptionFromCapturedPcm = useCallback(async (): Promise<boolean> => {
    if (
      state.capture !== 'recorded'
      || state.asr !== 'failed'
      || !recordingReadyRef.current
      || capturedPcmRef.current.length === 0
      || finalizedSegmentsRef.current.length > 0
    ) return false;
    const readiness = await refreshLocalAsrReadiness();
    if (readiness !== 'ready') return false;

    const operationIdentity = identityRef.current;
    attemptFailedRef.current = false;
    completionEmittedRef.current = false;
    tailReadyRef.current = false;
    asrRecoveryAttemptedRef.current = false;
    asrFeedFailedRef.current = false;
    pcmChannelUnavailableRef.current = false;
    pendingPcmOverflowRef.current = false;
    asrFailureReasonRef.current = null;
    tailAnnotationContextStatusRef.current = 'idle';
    setTailAnnotationContextStatus('idle');
    setTailAnnotationContextError(null);

    const recovered = await recoverAsrFromCapturedPcm(operationIdentity);
    if (!isActiveAttempt(operationIdentity)) return false;
    if (!recovered) {
      failTranscription(
        '这段录音重新转写后仍未形成 final。音频仍保留在本页，请检查输入设备后重新录制。',
      );
      return false;
    }
    await completeTail(operationIdentity);
    return true;
  }, [
    completeTail,
    failTranscription,
    isActiveAttempt,
    recoverAsrFromCapturedPcm,
    refreshLocalAsrReadiness,
    state.asr,
    state.capture,
  ]);

  const rerecord = useCallback(() => {
    if (resettingRef.current) return;
    resettingRef.current = true;
    setResetting(true);
    clearNoSpeechTimer();
    const previousIdentity = identityRef.current;
    const previousStart = asrStartRef.current;
    const previousFeedTail = feedTailRef.current;
    abandonPendingAsrStartRef.current?.();
    asrStopRequestedRef.current = true;
    explicitLiveAiOnRef.current = false;
    backendLiveAiOnRef.current = false;
    liveHintCoordinatorRef.current?.disable();
    liveHintRequestMetaRef.current.clear();
    liveHintAppendedSegmentsRef.current.clear();
    if (liveAttemptLeaseReadyRef.current) {
      void syncBackendLiveAi(previousIdentity, false);
    }
    void cancelLiveHint(previousIdentity.attemptId).catch(() => undefined);
    recorder.reset();

    const nextIdentity = createAttemptIdentity(
      kind,
      previousIdentity.generation + 1,
    );
    snapshotArtifactIdRef.current = `${nextIdentity.attemptId}-snapshot`.slice(0, 96);
    eventCounterRef.current += 1;
    recordLiveDiagnostic({
      level: 'info',
      component: 'live',
      event: 'live.attempt_reset',
      sessionId,
      attemptId: previousIdentity.attemptId,
      fields: {
        generation: previousIdentity.generation,
        nextGeneration: nextIdentity.generation,
      },
    });
    dispatch({
      id: `evt-${eventCounterRef.current}`,
      type: 'attempt_reset',
      generation: previousIdentity.generation,
      nextAttemptId: nextIdentity.attemptId,
      nextGeneration: nextIdentity.generation,
    });
    identityRef.current = nextIdentity;
    setIdentity(nextIdentity);

    asrAvailableRef.current = false;
    liveAttemptLeaseReadyRef.current = false;
    asrStartRef.current = null;
    abandonPendingAsrStartRef.current = null;
    asrStopRequestedRef.current = false;
    recordingStopRequestedRef.current = false;
    asrFeedFailedRef.current = false;
    pcmChannelUnavailableRef.current = false;
    pcmCaptureIncompleteRef.current = false;
    asrProducedFinalRef.current = false;
    asrFailureReasonRef.current = null;
    pendingPcmRef.current = [];
    pendingPcmSamplesRef.current = 0;
    pendingPcmOverflowRef.current = false;
    feedQueueRef.current = { pendingSamples: 0 };
    feedQueueHighWaterRef.current = 0;
    droppedPcmSamplesRef.current = 0;
    capturedPcmSamplesRef.current = 0;
    capturedPcmRef.current = [];
    asrRecoveryAttemptedRef.current = false;
    feedTailRef.current = Promise.resolve();
    acceptedSegmentsRef.current = new Map();
    highestAcceptedSequenceRef.current = -1;
    analyzedSegmentsRef.current = new Set();
    finalizedSegmentsRef.current = [];
    localAnnotationsRef.current = [];
    nextAnnotationOrdinalRef.current = 1;
    tailAnnotationContextStatusRef.current = 'idle';
    voiceDetectedRef.current = false;
    recordingReadyRef.current = null;
    tailReadyRef.current = false;
    attemptFailedRef.current = false;
    completionEmittedRef.current = false;
    shortRecordingAcceptedRef.current = false;
    shortRecordingGateShownRef.current = false;
    finalizePromiseRef.current = null;
    snapshotCandidateRef.current = null;
    snapshotPersistenceRef.current = 'idle';
    snapshotOperationTokenRef.current += 1;
    setDurableSnapshot(null);
    setShortRecordingPending(false);
    setTailAnnotationContextStatus('idle');
    setTailAnnotationContextError(null);

    void (async () => {
      const outcome = previousStart
        ? await previousStart.catch(() => 'failed' as const)
        : 'failed';
      if (outcome === 'ready') {
        await previousFeedTail.catch(() => undefined);
        await requestAsrStop(previousIdentity).catch(() => undefined);
      }
    })().finally(() => {
      resettingRef.current = false;
      if (mountedRef.current) setResetting(false);
    });
  }, [clearNoSpeechTimer, kind, recorder, requestAsrStop, sessionId, syncBackendLiveAi]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      clearNoSpeechTimer();
      liveAiReadinessRevisionRef.current += 1;
      localAsrReadinessRevisionRef.current += 1;
      localAsrInstallRevisionRef.current += 1;
      abandonPendingAsrStartRef.current?.();
      const operationIdentity = identityRef.current;
      explicitLiveAiOnRef.current = false;
      backendLiveAiOnRef.current = false;
      liveHintCoordinatorRef.current?.disable();
      if (liveAttemptLeaseReadyRef.current) {
        void Promise.resolve().then(() => setLiveAttemptAiState({
          sessionId,
          attemptId: operationIdentity.attemptId,
          generation: operationIdentity.generation,
          enabled: false,
        })).catch(() => undefined);
      }
      void cancelLiveHint(operationIdentity.attemptId).catch(() => undefined);
      mountedRef.current = false;
      const startOperation = asrStartRef.current;
      const feedTail = feedTailRef.current;
      if (!startOperation || asrStopRequestedRef.current) return;
      asrStopRequestedRef.current = true;
      void startOperation.then(async (outcome) => {
        if (outcome !== 'ready') return;
        await feedTail.catch(() => undefined);
        await requestAsrStop(operationIdentity).catch(() => undefined);
      });
    };
  }, [clearNoSpeechTimer, requestAsrStop, sessionId]);

  const runQaSequence = useCallback(() => {
    emit({ type: 'permission_granted' });
    emit({ type: 'recording_started' });
    emit({ type: 'voice_detected' });
    const now = new Date().toISOString();
    QA_TEXT.forEach((text, sequence) => {
      const [startMs, endMs] = QA_TIMES[sequence]!;
      analyzedSegmentsRef.current.add(`${attemptId}-seg-${sequence}`);
      const partial: TranscriptSegment = {
        id: `${attemptId}-seg-${sequence}`,
        attemptId,
        sequence,
        revision: 1,
        text: text.slice(0, Math.max(3, Math.floor(text.length * 0.62))),
        startMs,
        endMs,
        confidence: null,
        isFinal: false,
        emittedAt: now,
        finalizedAt: null,
        modelVersion: 'qa-controlled-1',
      };
      emit({ type: 'segment', segment: partial });
      emit({ type: 'segment', segment: { ...partial, revision: 2, text, isFinal: true, finalizedAt: now } });
    });
    const qaAnnotation = (input: {
      readonly ordinal: number;
      readonly segmentIndex: number;
      readonly type: LiveAnnotation['type'];
      readonly phrase: string;
      readonly suggestion: string;
      readonly lifecycle?: LiveAnnotation['lifecycle'];
    }): LiveAnnotation => {
      const text = QA_TEXT[input.segmentIndex];
      const start = text.indexOf(input.phrase);
      return {
        id: `${attemptId}-qa-o${input.ordinal}`,
        displayId: `O${input.ordinal}`,
        segmentId: `${attemptId}-seg-${input.segmentIndex}`,
        type: input.type,
        sourceSpan: { start, end: start + input.phrase.length, text: input.phrase },
        evidence: `原句“${input.phrase}”`,
        suggestion: input.suggestion,
        source: 'local_rule',
        lifecycle: input.lifecycle ?? 'confirmed',
        algorithmVersion: 'qa-approved-v4',
        createdAt: now,
        updatedAt: now,
        withdrawnReason: input.lifecycle === 'withdrawn' ? 'qa_correction_history' : null,
      };
    };
    const approvedAnnotations = [
      qaAnnotation({ ordinal: 1, segmentIndex: 0, type: 'filler', phrase: '就是', suggestion: '「就是」可删除，不影响原意。' }),
      qaAnnotation({ ordinal: 2, segmentIndex: 2, type: 'vague', phrase: '这个', suggestion: '把「这个」直接说成“同步冻结范围”。' }),
      qaAnnotation({ ordinal: 3, segmentIndex: 3, type: 'self_correction', phrase: '先先', suggestion: '「先先」已撤回，迁移历史仍保留。', lifecycle: 'withdrawn' }),
      qaAnnotation({ ordinal: 4, segmentIndex: 3, type: 'task_gap', phrase: '本周冻结新增需求', suggestion: '已明确：本周冻结新增需求。' }),
    ];
    for (const segmentIndex of [0, 2, 3]) {
      emit({ type: 'annotations', segmentId: `${attemptId}-seg-${segmentIndex}`, annotations: approvedAnnotations.filter((item) => item.segmentId.endsWith(`seg-${segmentIndex}`)) });
    }
    emit({ type: 'ai_pending' });
    emit({
      type: 'hint',
      hint: {
        id: `${attemptId}-hint-1`,
        attemptId,
        requestSequence: 1,
        windowHash: 'qa-window-0001',
        segmentIds: [`${attemptId}-seg-0`, `${attemptId}-seg-1`],
        text: kind === 'retry' ? '保持结论先行，再补两个原因。' : '先说决定，再给两个原因。',
        lifecycle: 'provisional',
        createdAt: now,
        updatedAt: now,
        reason: null,
      },
    });
  }, [attemptId, emit, kind]);

  const qaSafeEnd = useCallback(() => {
    emit({ type: 'stop_requested', audioWatermark: 30_000 });
    emit({ type: 'tail_complete' });
  }, [emit]);

  return {
    state,
    recorder,
    snapshot: durableSnapshot,
    qa: qaMode(),
    runQaSequence,
    qaSafeEnd,
    shortRecordingPending,
    acceptShortRecording,
    rerecord,
    resetting,
    retrySnapshotPersistence,
    tailAnnotationContextStatus,
    tailAnnotationContextError,
    retryTailAnnotationContext,
    localAsrReadiness,
    refreshLocalAsrReadiness,
    localAsrInstallStatus,
    localAsrInstallError,
    installLocalAsrModel,
    startRecording,
    hasRetryableCapturedPcm:
      state.capture === 'recorded'
      && state.asr === 'failed'
      && capturedPcmRef.current.length > 0
      && finalizedSegmentsRef.current.length === 0,
    retryTranscriptionFromCapturedPcm,
    liveAiReadiness,
    refreshLiveAiReadiness,
    setFeedbackVisible: (visible: boolean) => emit({ type: 'feedback_visibility', visible }),
    setLocalAnnotations: (enabled: boolean) => {
      localAnnotationsEnabledRef.current = enabled;
      emit({ type: 'local_annotations', enabled });
    },
    setLiveAi: async (enabled: boolean): Promise<boolean> => {
      if (enabled && recordingStopRequestedRef.current) {
        explicitLiveAiOnRef.current = false;
        backendLiveAiOnRef.current = false;
        emit({ type: 'live_ai', enabled: false });
        return false;
      }
      const accepted = enabled && liveAiConsentValidRef.current;
      explicitLiveAiOnRef.current = accepted;
      emit({ type: 'live_ai', enabled: accepted });
      if (accepted && navigator.onLine && liveAttemptLeaseReadyRef.current) {
        const operationIdentity = identityRef.current;
        const backendEnabled = await syncBackendLiveAi(operationIdentity, true);
        if (backendEnabled) enableLiveCoordinator();
        return backendEnabled;
      } else {
        backendLiveAiOnRef.current = false;
        liveHintCoordinatorRef.current?.disable();
        if (liveAttemptLeaseReadyRef.current) {
          await syncBackendLiveAi(identityRef.current, false);
        }
        await cancelLiveHint(attemptId).catch(() => undefined);
      }
      return enabled ? accepted : true;
    },
    revokeLiveAiConsent: async () => {
      const consentId = cloudLiveContext?.consent.id;
      if (!consentId) return;
      try {
        await revokeCloudAiConsent(consentId);
        liveAiConsentValidRef.current = false;
        explicitLiveAiOnRef.current = false;
        backendLiveAiOnRef.current = false;
        liveHintCoordinatorRef.current?.disable();
        setCloudLiveContext(null);
        emit({ type: 'revoke_live_ai_consent' });
      } catch {
        emit({ type: 'ai_failed', reason: '实时 AI 同意撤回失败，请重试。' });
      }
    },
  };
}
