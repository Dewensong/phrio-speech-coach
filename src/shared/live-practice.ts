import { z } from 'zod';

import { IdentifierSchema, IsoDateTimeSchema, VersionSchema } from './domain';

export const LIVE_ANNOTATION_TYPES = [
  'filler',
  'hedge',
  'vague',
  'repetition',
  'self_correction',
  'long_pause',
  'speech_rate',
  'structure',
  'task_gap',
] as const;
export const LiveAnnotationTypeSchema = z.enum(LIVE_ANNOTATION_TYPES);
export type LiveAnnotationType = z.infer<typeof LiveAnnotationTypeSchema>;

export const AnnotationLifecycleSchema = z.enum([
  'provisional',
  'confirmed',
  'withdrawn',
]);
export type AnnotationLifecycle = z.infer<typeof AnnotationLifecycleSchema>;

export const AiLifecycleSchema = z.enum([
  'pending',
  'provisional',
  'superseded',
  'withdrawn',
  'stale',
  'failed',
]);
export type AiLifecycle = z.infer<typeof AiLifecycleSchema>;

export const TranscriptSegmentSchema = z
  .object({
    id: IdentifierSchema,
    attemptId: IdentifierSchema,
    sequence: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    text: z.string().min(1).max(4_000),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1).nullable(),
    isFinal: z.boolean(),
    emittedAt: IsoDateTimeSchema,
    finalizedAt: IsoDateTimeSchema.nullable(),
    modelVersion: VersionSchema,
  })
  .strict()
  .superRefine((segment, context) => {
    if (segment.endMs < segment.startMs) {
      context.addIssue({ code: 'custom', path: ['endMs'], message: 'end must follow start' });
    }
    if (segment.isFinal !== (segment.finalizedAt !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['finalizedAt'],
        message: 'only final segments have finalizedAt',
      });
    }
  });
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const SourceSpanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    text: z.string().min(1).max(500),
  })
  .strict()
  .refine((span) => span.end > span.start, 'source span must not be empty');
export type SourceSpan = z.infer<typeof SourceSpanSchema>;

export const LiveAnnotationSchema = z
  .object({
    id: IdentifierSchema,
    displayId: z.string().regex(/^O\d+$/),
    segmentId: IdentifierSchema,
    type: LiveAnnotationTypeSchema,
    sourceSpan: SourceSpanSchema.nullable(),
    evidence: z.string().min(1).max(500),
    suggestion: z.string().min(1).max(500),
    source: z.enum(['local_rule', 'local_metric']),
    lifecycle: AnnotationLifecycleSchema,
    algorithmVersion: VersionSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    withdrawnReason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type LiveAnnotation = z.infer<typeof LiveAnnotationSchema>;

export const LiveHintSchema = z
  .object({
    id: IdentifierSchema,
    attemptId: IdentifierSchema,
    requestSequence: z.number().int().positive(),
    windowHash: z.string().min(8).max(128),
    segmentIds: z.array(IdentifierSchema).min(1).max(24),
    text: z.string().min(1).max(280),
    lifecycle: AiLifecycleSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    reason: z.string().max(500).nullable(),
  })
  .strict();
export type LiveHint = z.infer<typeof LiveHintSchema>;

export const LiveMetricSnapshotSchema = z
  .object({
    finalCharacters: z.number().int().nonnegative(),
    finalSegments: z.number().int().nonnegative(),
    fillers: z.number().int().nonnegative(),
    hedges: z.number().int().nonnegative(),
    vagueWords: z.number().int().nonnegative(),
    repetitions: z.number().int().nonnegative(),
    selfCorrections: z.number().int().nonnegative(),
    algorithmVersion: VersionSchema,
  })
  .strict();
export type LiveMetricSnapshot = z.infer<typeof LiveMetricSnapshotSchema>;

export const CaptureStatusSchema = z.enum([
  'awaiting_permission',
  'ready',
  'recording',
  'finalizing',
  'recorded',
  'safe_end',
  'interrupted',
  'permission_denied',
]);
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;
export const AsrStatusSchema = z.enum([
  'idle',
  'listening',
  'voice_detected',
  'partial',
  'segment_finalized',
  'reconnecting',
  'degraded',
  'finalizing',
  'ready',
  'failed',
  'no_speech',
]);
export type AsrStatus = z.infer<typeof AsrStatusSchema>;
export const AnalysisStatusSchema = z.enum([
  'idle',
  'annotating',
  'local_ready',
  'ai_pending',
  'hint_ready',
  'local_only',
  'ai_failed',
  'ai_off',
]);
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;
export const NetworkStatusSchema = z.enum(['online', 'offline', 'recovering']);
export type NetworkStatus = z.infer<typeof NetworkStatusSchema>;
export const DeepReportStatusSchema = z.enum([
  'idle',
  'queued',
  'awaiting_consent',
  'processing',
  'complete',
  'failed',
]);
export type DeepReportStatus = z.infer<typeof DeepReportStatusSchema>;

export const LiveAttemptStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: IdentifierSchema,
    attemptId: IdentifierSchema,
    generation: z.number().int().positive(),
    kind: z.enum(['initial', 'retry']),
    capture: CaptureStatusSchema,
    asr: AsrStatusSchema,
    analysis: AnalysisStatusSchema,
    network: NetworkStatusSchema,
    report: DeepReportStatusSchema,
    voiceDetected: z.boolean(),
    realtimeFeedbackVisible: z.boolean(),
    localAnnotationsEnabled: z.boolean(),
    liveAiEnabled: z.boolean(),
    liveAiConsentValid: z.boolean(),
    lastSourceSequence: z.number().int().nonnegative(),
    highestSequence: z.number().int(),
    segments: z.array(TranscriptSegmentSchema),
    annotations: z.array(LiveAnnotationSchema),
    hints: z.array(LiveHintSchema),
    metrics: LiveMetricSnapshotSchema,
    audioWatermark: z.number().int().nonnegative().nullable(),
    frozenSnapshotId: IdentifierSchema.nullable(),
    lastError: z.string().max(1_000).nullable(),
  })
  .strict();
export type LiveAttemptState = z.infer<typeof LiveAttemptStateSchema>;

export const AttemptSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    attemptId: IdentifierSchema,
    generation: z.number().int().positive(),
    kind: z.enum(['initial', 'retry']),
    frozenAt: IsoDateTimeSchema,
    audioWatermark: z.number().int().nonnegative(),
    transcriptVersion: z.number().int().positive(),
    // Legacy builds could persist an empty snapshot before the final-transcript
    // guard existed. Keep the storage schema readable so one historical artifact
    // cannot poison the whole record list; freezeAttemptSnapshot rejects new ones.
    finalSegments: z.array(TranscriptSegmentSchema),
    annotations: z.array(LiveAnnotationSchema),
    hints: z.array(LiveHintSchema),
    metrics: LiveMetricSnapshotSchema,
    focusVersion: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.finalSegments.some((segment) => !segment.isFinal)) {
      context.addIssue({
        code: 'custom',
        path: ['finalSegments'],
        message: 'frozen snapshots contain final segments only',
      });
    }

    const segmentIds = new Set<string>();
    const segmentSequences = new Set<number>();
    snapshot.finalSegments.forEach((segment, index) => {
      if (segment.attemptId !== snapshot.attemptId) {
        context.addIssue({
          code: 'custom',
          path: ['finalSegments', index, 'attemptId'],
          message: 'frozen segment must belong to the snapshot attempt',
        });
      }
      if (segmentIds.has(segment.id)) {
        context.addIssue({
          code: 'custom',
          path: ['finalSegments', index, 'id'],
          message: 'frozen segment ids must be unique',
        });
      }
      if (segmentSequences.has(segment.sequence)) {
        context.addIssue({
          code: 'custom',
          path: ['finalSegments', index, 'sequence'],
          message: 'frozen segment sequences must be unique',
        });
      }
      segmentIds.add(segment.id);
      segmentSequences.add(segment.sequence);
    });

    const annotationIds = new Set<string>();
    const annotationDisplayIds = new Set<string>();
    snapshot.annotations.forEach((annotation, index) => {
      if (!segmentIds.has(annotation.segmentId)) {
        context.addIssue({
          code: 'custom',
          path: ['annotations', index, 'segmentId'],
          message: 'frozen annotation must reference a final segment in the snapshot',
        });
      }
      if (annotationIds.has(annotation.id)) {
        context.addIssue({
          code: 'custom',
          path: ['annotations', index, 'id'],
          message: 'frozen annotation ids must be unique',
        });
      }
      if (annotationDisplayIds.has(annotation.displayId)) {
        context.addIssue({
          code: 'custom',
          path: ['annotations', index, 'displayId'],
          message: 'frozen annotation display ids must be unique',
        });
      }
      annotationIds.add(annotation.id);
      annotationDisplayIds.add(annotation.displayId);
    });

    const hintIds = new Set<string>();
    snapshot.hints.forEach((hint, index) => {
      if (hint.attemptId !== snapshot.attemptId) {
        context.addIssue({
          code: 'custom',
          path: ['hints', index, 'attemptId'],
          message: 'frozen hint must belong to the snapshot attempt',
        });
      }
      if (hint.segmentIds.some((segmentId) => !segmentIds.has(segmentId))) {
        context.addIssue({
          code: 'custom',
          path: ['hints', index, 'segmentIds'],
          message: 'frozen hint may reference final segments from this snapshot only',
        });
      }
      if (hintIds.has(hint.id)) {
        context.addIssue({
          code: 'custom',
          path: ['hints', index, 'id'],
          message: 'frozen hint ids must be unique',
        });
      }
      hintIds.add(hint.id);
    });
  });
export type AttemptSnapshot = z.infer<typeof AttemptSnapshotSchema>;

type LiveAttemptEventPayload =
  | { readonly id: string; readonly type: 'permission_granted'; readonly generation: number }
  | { readonly id: string; readonly type: 'permission_denied'; readonly generation: number; readonly reason: string }
  | { readonly id: string; readonly type: 'recording_started'; readonly generation: number }
  | { readonly id: string; readonly type: 'capture_interrupted'; readonly generation: number; readonly reason: string }
  | { readonly id: string; readonly type: 'voice_detected'; readonly generation: number }
  | { readonly id: string; readonly type: 'no_speech'; readonly generation: number }
  | { readonly id: string; readonly type: 'segment'; readonly generation: number; readonly segment: TranscriptSegment }
  | { readonly id: string; readonly type: 'annotations'; readonly generation: number; readonly segmentId: string; readonly annotations: readonly LiveAnnotation[] }
  | { readonly id: string; readonly type: 'annotation_withdrawn'; readonly generation: number; readonly annotationId: string; readonly reason: string; readonly at: string }
  | { readonly id: string; readonly type: 'ai_pending'; readonly generation: number }
  | { readonly id: string; readonly type: 'hint'; readonly generation: number; readonly hint: LiveHint }
  | { readonly id: string; readonly type: 'ai_failed'; readonly generation: number; readonly reason: string }
  | { readonly id: string; readonly type: 'network'; readonly generation: number; readonly status: NetworkStatus }
  | { readonly id: string; readonly type: 'asr_retry_reset'; readonly generation: number }
  | { readonly id: string; readonly type: 'asr_reconnecting'; readonly generation: number }
  | { readonly id: string; readonly type: 'asr_degraded'; readonly generation: number; readonly reason: string; readonly code?: string }
  | { readonly id: string; readonly type: 'transcription_failed'; readonly generation: number; readonly reason: string }
  | { readonly id: string; readonly type: 'recording_too_short'; readonly generation: number; readonly reason: string }
  | { readonly id: string; readonly type: 'feedback_visibility'; readonly generation: number; readonly visible: boolean }
  | { readonly id: string; readonly type: 'local_annotations'; readonly generation: number; readonly enabled: boolean }
  | { readonly id: string; readonly type: 'live_ai_consent_status'; readonly generation: number; readonly valid: boolean }
  | { readonly id: string; readonly type: 'live_ai'; readonly generation: number; readonly enabled: boolean }
  | { readonly id: string; readonly type: 'revoke_live_ai_consent'; readonly generation: number }
  | { readonly id: string; readonly type: 'stop_requested'; readonly generation: number; readonly audioWatermark: number }
  | { readonly id: string; readonly type: 'tail_complete'; readonly generation: number }
  | { readonly id: string; readonly type: 'snapshot_frozen'; readonly generation: number; readonly snapshotId: string }
  | { readonly id: string; readonly type: 'report_status'; readonly generation: number; readonly status: DeepReportStatus; readonly reason?: string | null }
  | { readonly id: string; readonly type: 'attempt_reset'; readonly generation: number; readonly nextAttemptId: string; readonly nextGeneration: number };

export type LiveAttemptEvent = LiveAttemptEventPayload & {
  /** Stable monotonic sequence assigned by the Attempt event source. */
  readonly sourceSequence?: number;
};

const EMPTY_METRICS: LiveMetricSnapshot = {
  finalCharacters: 0,
  finalSegments: 0,
  fillers: 0,
  hedges: 0,
  vagueWords: 0,
  repetitions: 0,
  selfCorrections: 0,
  algorithmVersion: 'local-rules-1',
};

export function createLiveAttemptState(input: {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly kind: 'initial' | 'retry';
  readonly liveAiEnabled?: boolean;
  readonly liveAiConsentValid?: boolean;
}): LiveAttemptState {
  return LiveAttemptStateSchema.parse({
    schemaVersion: 1,
    ...input,
    capture: 'awaiting_permission',
    asr: 'idle',
    analysis: input.liveAiEnabled ? 'idle' : 'ai_off',
    network: navigatorSafeOnline(),
    report: 'idle',
    voiceDetected: false,
    realtimeFeedbackVisible: true,
    localAnnotationsEnabled: true,
    liveAiEnabled: input.liveAiEnabled ?? false,
    liveAiConsentValid: input.liveAiConsentValid ?? false,
    lastSourceSequence: 0,
    highestSequence: -1,
    segments: [],
    annotations: [],
    hints: [],
    metrics: EMPTY_METRICS,
    audioWatermark: null,
    frozenSnapshotId: null,
    lastError: null,
  });
}

function navigatorSafeOnline(): NetworkStatus {
  return typeof navigator === 'undefined' || navigator.onLine ? 'online' : 'offline';
}

function recomputeMetrics(
  segments: readonly TranscriptSegment[],
  annotations: readonly LiveAnnotation[],
): LiveMetricSnapshot {
  const finals = segments.filter((segment) => segment.isFinal);
  const active = annotations.filter((annotation) => annotation.lifecycle !== 'withdrawn');
  const count = (type: LiveAnnotationType) =>
    active.filter((annotation) => annotation.type === type).length;
  return {
    finalCharacters: finals.reduce((total, segment) => total + segment.text.length, 0),
    finalSegments: finals.length,
    fillers: count('filler'),
    hedges: count('hedge'),
    vagueWords: count('vague'),
    repetitions: count('repetition'),
    selfCorrections: count('self_correction'),
    algorithmVersion: 'local-rules-1',
  };
}

/** Pure, generation-safe and idempotent event reducer for both UI and persistence replay. */
export function reduceLiveAttempt(
  current: LiveAttemptState,
  event: LiveAttemptEvent,
): LiveAttemptState {
  if (
    event.sourceSequence !== undefined
    && (!Number.isSafeInteger(event.sourceSequence) || event.sourceSequence < 1)
  ) return current;
  if (
    event.generation !== current.generation
    || (
      event.sourceSequence !== undefined
      && event.sourceSequence <= current.lastSourceSequence
    )
  ) {
    return current;
  }
  const state = event.sourceSequence === undefined
    ? current
    : { ...current, lastSourceSequence: event.sourceSequence };
  switch (event.type) {
    case 'permission_granted':
      return { ...state, capture: 'ready', lastError: null };
    case 'permission_denied':
      return { ...state, capture: 'permission_denied', lastError: event.reason };
    case 'recording_started':
      return { ...state, capture: 'recording', asr: 'listening', lastError: null };
    case 'capture_interrupted':
      return {
        ...state,
        capture: 'interrupted',
        asr: 'failed',
        report: 'idle',
        lastError: event.reason,
      };
    case 'voice_detected': {
      const terminalOrDegraded = [
        'degraded',
        'failed',
        'finalizing',
        'ready',
      ].includes(state.asr);
      return {
        ...state,
        voiceDetected: true,
        asr: terminalOrDegraded ? state.asr : 'voice_detected',
        lastError: state.asr === 'no_speech' ? null : state.lastError,
      };
    }
    case 'no_speech':
      return state.asr === 'degraded' || state.asr === 'failed' || state.asr === 'finalizing'
        ? state
        : { ...state, asr: 'no_speech', lastError: '尚未检测到有效语音' };
    case 'segment': {
      const incoming = TranscriptSegmentSchema.parse(event.segment);
      if (incoming.attemptId !== state.attemptId) return state;
      const existing = state.segments.find((segment) => segment.id === incoming.id);
      if (existing && existing.sequence !== incoming.sequence) return state;
      if (existing?.isFinal || (existing && existing.revision >= incoming.revision)) return state;
      if (!existing && incoming.sequence <= state.highestSequence) return state;
      const segments = existing
        ? state.segments.map((segment) => (segment.id === incoming.id ? incoming : segment))
        : [...state.segments, incoming].sort((a, b) => a.sequence - b.sequence);
      return {
        ...state,
        segments,
        highestSequence: Math.max(state.highestSequence, incoming.sequence),
        asr: incoming.isFinal ? 'segment_finalized' : 'partial',
        metrics: recomputeMetrics(segments, state.annotations),
      };
    }
    case 'annotations': {
      const final = state.segments.find(
        (segment) => segment.id === event.segmentId && segment.isFinal,
      );
      if (!final || !state.localAnnotationsEnabled) return state;
      const incoming = event.annotations
        .map((item) => LiveAnnotationSchema.parse(item))
        .filter((item) => item.segmentId === event.segmentId);
      const annotations = [...state.annotations];
      for (const item of incoming) {
        const existingIndex = annotations.findIndex((candidate) => candidate.id === item.id);
        if (existingIndex < 0) {
          annotations.push(item);
          continue;
        }
        const existing = annotations[existingIndex]!;
        if (
          existing.segmentId !== item.segmentId
          || existing.lifecycle === 'withdrawn'
          || !annotationAdvances(existing, item)
        ) continue;
        annotations[existingIndex] = item;
      }
      return {
        ...state,
        annotations,
        analysis: state.liveAiEnabled ? 'local_ready' : 'ai_off',
        metrics: recomputeMetrics(state.segments, annotations),
      };
    }
    case 'annotation_withdrawn': {
      const annotations = state.annotations.map((annotation) =>
        annotation.id === event.annotationId
          ? {
              ...annotation,
              lifecycle: 'withdrawn' as const,
              updatedAt: event.at,
              withdrawnReason: event.reason,
            }
          : annotation,
      );
      return { ...state, annotations, metrics: recomputeMetrics(state.segments, annotations) };
    }
    case 'ai_pending':
      return state.liveAiEnabled && state.liveAiConsentValid && state.network === 'online'
        ? { ...state, analysis: 'ai_pending' }
        : state;
    case 'hint': {
      const hint = LiveHintSchema.parse(event.hint);
      if (!state.liveAiEnabled || !state.liveAiConsentValid || hint.attemptId !== state.attemptId) {
        return state;
      }
      // requestSequence is the provider coordinator's stable semantic identity;
      // id is retained as an independent collision guard. A replay can never
      // append or revive an already-accounted hint.
      if (state.hints.some(
        (item) => item.id === hint.id || item.requestSequence === hint.requestSequence,
      )) return state;
      const newest = state.hints.reduce((value, item) => Math.max(value, item.requestSequence), 0);
      if (hint.requestSequence < newest) {
        return { ...state, hints: [...state.hints, { ...hint, lifecycle: 'stale' }] };
      }
      const hints = state.hints.map((item) =>
        item.lifecycle === 'provisional'
          ? { ...item, lifecycle: 'superseded' as const, updatedAt: hint.createdAt }
          : item,
      );
      return { ...state, hints: [...hints, hint], analysis: 'hint_ready' };
    }
    case 'ai_failed':
      return { ...state, analysis: 'ai_failed', lastError: event.reason };
    case 'network':
      return {
        ...state,
        network: event.status,
        analysis:
          event.status === 'online'
            ? state.liveAiEnabled
              ? 'local_ready'
              : 'ai_off'
            : 'local_only',
      };
    case 'asr_retry_reset': {
      // Replaying from sample zero is forbidden once any authoritative final
      // exists. A delayed reset event must not move a valid Attempt backwards.
      if (state.segments.some((segment) => segment.isFinal)) return state;
      const removedSegmentIds = new Set(
        state.segments.filter((segment) => !segment.isFinal).map((segment) => segment.id),
      );
      const segments = state.segments.filter((segment) => segment.isFinal);
      const annotations = state.annotations.filter(
        (annotation) => !removedSegmentIds.has(annotation.segmentId),
      );
      const hints = state.hints.filter(
        (hint) => !hint.segmentIds.some((segmentId) => removedSegmentIds.has(segmentId)),
      );
      return {
        ...state,
        segments,
        annotations,
        hints,
        highestSequence: segments.reduce(
          (highest, segment) => Math.max(highest, segment.sequence),
          -1,
        ),
        metrics: recomputeMetrics(segments, annotations),
        asr: 'reconnecting',
        lastError: null,
      };
    }
    case 'asr_reconnecting':
      return { ...state, asr: 'reconnecting' };
    case 'asr_degraded':
      return { ...state, asr: 'degraded', lastError: event.reason };
    case 'transcription_failed':
      return {
        ...state,
        capture: state.capture === 'interrupted' ? 'interrupted' : 'recorded',
        asr: 'failed',
        report: 'idle',
        lastError: event.reason,
      };
    case 'recording_too_short':
      return {
        ...state,
        capture: 'recorded',
        asr: 'ready',
        lastError: event.reason,
      };
    case 'feedback_visibility':
      return { ...state, realtimeFeedbackVisible: event.visible };
    case 'local_annotations':
      return { ...state, localAnnotationsEnabled: event.enabled };
    case 'live_ai_consent_status':
      return event.valid
        ? { ...state, liveAiConsentValid: true }
        : {
            ...state,
            liveAiEnabled: false,
            liveAiConsentValid: false,
            analysis: 'ai_off',
            hints: state.hints.map((hint) =>
              hint.lifecycle === 'pending' || hint.lifecycle === 'provisional'
                ? { ...hint, lifecycle: 'withdrawn' as const, reason: 'consent_unavailable' }
                : hint,
            ),
          };
    case 'live_ai':
      return {
        ...state,
        liveAiEnabled: event.enabled && state.liveAiConsentValid,
        analysis: event.enabled && state.liveAiConsentValid ? 'local_ready' : 'ai_off',
      };
    case 'revoke_live_ai_consent':
      return {
        ...state,
        liveAiEnabled: false,
        liveAiConsentValid: false,
        analysis: 'ai_off',
        hints: state.hints.map((hint) =>
          hint.lifecycle === 'pending' || hint.lifecycle === 'provisional'
            ? { ...hint, lifecycle: 'withdrawn' as const, reason: 'consent_revoked' }
            : hint,
        ),
      };
    case 'stop_requested':
      if (
        state.capture === 'finalizing' ||
        state.capture === 'recorded' ||
        state.capture === 'safe_end' ||
        state.capture === 'interrupted'
      ) return state;
      return {
        ...state,
        capture: 'finalizing',
        asr: 'finalizing',
        audioWatermark: event.audioWatermark,
      };
    case 'tail_complete':
      if (
        (state.capture !== 'finalizing' && state.capture !== 'recorded') ||
        (state.asr !== 'finalizing' &&
          state.asr !== 'segment_finalized' &&
          state.asr !== 'reconnecting' &&
          state.asr !== 'ready')
      ) return state;
      return { ...state, capture: 'safe_end', asr: 'ready', report: 'queued', lastError: null };
    case 'snapshot_frozen':
      return { ...state, frozenSnapshotId: event.snapshotId };
    case 'report_status':
      return {
        ...state,
        report: event.status,
        lastError: event.reason === undefined ? state.lastError : event.reason,
      };
    case 'attempt_reset': {
      const reset = createLiveAttemptState({
        sessionId: state.sessionId,
        attemptId: event.nextAttemptId,
        generation: event.nextGeneration,
        kind: state.kind,
        liveAiEnabled: false,
        liveAiConsentValid: state.liveAiConsentValid,
      });
      return {
        ...reset,
        lastSourceSequence: event.sourceSequence ?? state.lastSourceSequence,
        realtimeFeedbackVisible: state.realtimeFeedbackVisible,
        localAnnotationsEnabled: state.localAnnotationsEnabled,
      };
    }
  }
}

function annotationAdvances(existing: LiveAnnotation, incoming: LiveAnnotation): boolean {
  const existingTime = Date.parse(existing.updatedAt);
  const incomingTime = Date.parse(incoming.updatedAt);
  if (incomingTime !== existingTime) return incomingTime > existingTime;
  const lifecycleRank = (annotation: LiveAnnotation) => annotation.lifecycle === 'withdrawn'
    ? 2
    : annotation.lifecycle === 'confirmed'
      ? 1
      : 0;
  return lifecycleRank(incoming) > lifecycleRank(existing);
}

export function freezeAttemptSnapshot(input: {
  readonly state: LiveAttemptState;
  readonly snapshotId: string;
  readonly frozenAt: string;
  readonly transcriptVersion: number;
  readonly focusVersion?: number | null;
}): AttemptSnapshot {
  const { state } = input;
  if (state.capture !== 'safe_end' || state.asr !== 'ready' || state.audioWatermark === null) {
    throw new Error('ATTEMPT_NOT_READY_TO_FREEZE');
  }
  const finalSegments = state.segments.filter((segment) => segment.isFinal);
  if (finalSegments.length === 0) throw new Error('ATTEMPT_HAS_NO_FINAL_TRANSCRIPT');
  return AttemptSnapshotSchema.parse({
    schemaVersion: 1,
    id: input.snapshotId,
    sessionId: state.sessionId,
    attemptId: state.attemptId,
    generation: state.generation,
    kind: state.kind,
    frozenAt: input.frozenAt,
    audioWatermark: state.audioWatermark,
    transcriptVersion: input.transcriptVersion,
    finalSegments,
    annotations: state.annotations,
    hints: state.hints,
    metrics: recomputeMetrics(state.segments, state.annotations),
    focusVersion: input.focusVersion ?? null,
  });
}
