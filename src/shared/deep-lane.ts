import { z } from 'zod';

import {
  CriterionComparisonDimensionSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  type CriterionComparisonDimension,
} from './domain';
import {
  DeepDiagnosisPayloadSchema,
  DeepDiagnosisResponseSchema,
  SemanticComparisonPayloadSchema,
  SemanticComparisonResponseSchema,
  evidenceReferencesApprovedSource,
  type DeepDiagnosisPayload,
  type DeepDiagnosisResponse,
  type SemanticComparisonPayload,
  type SemanticComparisonResponse,
} from './cloud-ai';
import {
  AttemptSnapshotSchema,
  LiveAnnotationTypeSchema,
  type LiveAnnotationType,
  type LiveMetricSnapshot,
  type AttemptSnapshot,
  type LiveAnnotation,
} from './live-practice';

export const TranscriptCorrectionSchema = z.object({
  id: IdentifierSchema,
  snapshotId: IdentifierSchema,
  segmentId: IdentifierSchema,
  originalText: z.string().min(1).max(4_000),
  correctedText: z.string().min(1).max(4_000),
  createdAt: IsoDateTimeSchema,
}).strict();
export type TranscriptCorrection = z.infer<typeof TranscriptCorrectionSchema>;

export const DeepReportSchema = z.object({
  id: IdentifierSchema,
  snapshotId: IdentifierSchema,
  transcriptVersion: z.number().int().positive(),
  status: z.enum(['queued', 'processing', 'complete', 'failed']),
  rubricCriterionId: IdentifierSchema.nullable(),
  evidenceIds: z.array(IdentifierSchema).max(12),
  judgment: z.string().max(1_000),
  focus: z.object({
    criterionId: IdentifierSchema,
    label: z.string().min(1).max(180),
    drillId: IdentifierSchema,
    drill: z.string().min(1).max(1_000),
  }).strict().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  error: z.string().max(1_000).nullable(),
}).strict();
export type DeepReport = z.infer<typeof DeepReportSchema>;

const ComparableMetricKeySchema = z.enum([
  'fillers',
  'hedges',
  'vagueWords',
  'repetitions',
  'selfCorrections',
]);
type ComparableMetricKey = z.infer<typeof ComparableMetricKeySchema>;

export const AttemptComparisonBasisSchema = z.object({
  dimensionId: CriterionComparisonDimensionSchema,
  label: z.string().min(1).max(180),
  signalLabel: z.string().min(1).max(300),
  source: z.enum(['deterministic_metric', 'annotation_evidence']),
  metricKeys: z.array(ComparableMetricKeySchema).max(8),
  annotationTypes: z.array(LiveAnnotationTypeSchema).max(9),
  initialValue: z.number().int().nonnegative().nullable(),
  retryValue: z.number().int().nonnegative().nullable(),
  comparable: z.boolean(),
}).strict().superRefine((basis, context) => {
  if (basis.source === 'deterministic_metric' && basis.metricKeys.length === 0) {
    context.addIssue({ code: 'custom', path: ['metricKeys'], message: 'metric comparison requires a metric key' });
  }
  if (basis.source === 'annotation_evidence' && basis.annotationTypes.length === 0) {
    context.addIssue({ code: 'custom', path: ['annotationTypes'], message: 'evidence comparison requires an annotation type' });
  }
  if (basis.comparable !== (basis.initialValue !== null && basis.retryValue !== null)) {
    context.addIssue({ code: 'custom', path: ['comparable'], message: 'comparable basis requires both paired values' });
  }
});
export type AttemptComparisonBasis = z.infer<typeof AttemptComparisonBasisSchema>;

export const AttemptComparisonSchema = z.object({
  id: IdentifierSchema,
  initialSnapshotId: IdentifierSchema,
  retrySnapshotId: IdentifierSchema,
  /** Correction-aware transcript versions used for this paired judgment. */
  initialTranscriptVersion: z.number().int().positive().optional(),
  retryTranscriptVersion: z.number().int().positive().optional(),
  criterionId: IdentifierSchema,
  protocolVersion: z.literal('paired-1'),
  result: z.enum(['improved', 'stable', 'regressed', 'insufficient_evidence']),
  /** Optional only so pre-closure local artifacts remain readable. New paired-1 writes it. */
  basis: AttemptComparisonBasisSchema.nullable().optional(),
  initialEvidenceIds: z.array(IdentifierSchema),
  retryEvidenceIds: z.array(IdentifierSchema),
  explanation: z.string().min(1).max(1_000),
  comparedAt: IsoDateTimeSchema,
}).strict();
export type AttemptComparison = z.infer<typeof AttemptComparisonSchema>;

export const DrillCompletionSchema = z.object({
  id: IdentifierSchema,
  snapshotId: IdentifierSchema,
  focusVersion: z.number().int().positive(),
  criterionId: IdentifierSchema,
  drillId: IdentifierSchema,
  rehearsalNote: z.string().max(2_000),
  selfChecked: z.literal(true),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
  durationMs: z.number().int().nonnegative().max(180_000),
}).strict().refine(
  (completion) => Date.parse(completion.completedAt) >= Date.parse(completion.startedAt),
  { message: 'Drill completion must follow its start', path: ['completedAt'] },
);
export type DrillCompletion = z.infer<typeof DrillCompletionSchema>;

export const CloudDeepDiagnosisStatusSchema = z.enum([
  'queued',
  'processing',
  'complete',
  'failed',
  'superseded',
]);
export type CloudDeepDiagnosisStatus = z.infer<typeof CloudDeepDiagnosisStatusSchema>;

export const CloudDeepDiagnosisArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: IdentifierSchema,
  transcriptVersion: z.number().int().positive(),
  analysisInputId: IdentifierSchema,
  payloadHash: z.string().length(64),
  consentId: IdentifierSchema,
  approvedPayload: DeepDiagnosisPayloadSchema,
  status: CloudDeepDiagnosisStatusSchema,
  lifecycle: z.array(z.object({
    status: CloudDeepDiagnosisStatusSchema,
    at: IsoDateTimeSchema,
    errorCode: z.string().min(1).max(120).nullable(),
  }).strict()).min(1).max(20),
  result: DeepDiagnosisResponseSchema.nullable(),
  errorCode: z.string().min(1).max(120).nullable(),
  supersededReason: z.enum([
    'transcript_correction_changed_payload',
    'consent_reset',
  ]).nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict().superRefine((artifact, context) => {
  const payload = artifact.approvedPayload;
  const lastLifecycle = artifact.lifecycle.at(-1);
  const allowedTransitions: Readonly<Record<CloudDeepDiagnosisStatus, readonly CloudDeepDiagnosisStatus[]>> = {
    queued: ['processing', 'superseded'],
    processing: ['complete', 'failed', 'superseded'],
    complete: ['superseded'],
    failed: ['superseded'],
    superseded: [],
  };
  if (
    artifact.snapshotId !== payload.snapshotId
    || artifact.transcriptVersion !== payload.transcriptVersion
    || artifact.analysisInputId !== payload.analysisInputId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['approvedPayload'],
      message: 'cloud diagnosis identity must match its exact approved payload',
    });
  }
  if (lastLifecycle?.status !== artifact.status || lastLifecycle?.at !== artifact.updatedAt) {
    context.addIssue({
      code: 'custom',
      path: ['lifecycle'],
      message: 'cloud diagnosis lifecycle must end at the persisted current status',
    });
  }
  if (artifact.lifecycle[0]?.at !== artifact.createdAt) {
    context.addIssue({
      code: 'custom',
      path: ['createdAt'],
      message: 'cloud diagnosis creation time must match its first lifecycle event',
    });
  }
  if (artifact.lifecycle[0]?.status !== 'queued') {
    context.addIssue({ code: 'custom', path: ['lifecycle', 0, 'status'], message: 'cloud diagnosis must start queued' });
  }
  artifact.lifecycle.slice(1).forEach((event, index) => {
    const previous = artifact.lifecycle[index]!;
    if (!allowedTransitions[previous.status].includes(event.status)) {
      context.addIssue({
        code: 'custom',
        path: ['lifecycle', index + 1, 'status'],
        message: `illegal cloud diagnosis transition ${previous.status} -> ${event.status}`,
      });
    }
    if (event.at < previous.at) {
      context.addIssue({
        code: 'custom',
        path: ['lifecycle', index + 1, 'at'],
        message: 'cloud diagnosis lifecycle must be chronological',
      });
    }
  });
  if (artifact.status === 'complete' && !artifact.result) {
    context.addIssue({ code: 'custom', path: ['result'], message: 'complete diagnosis requires a result' });
  }
  if (artifact.status === 'failed' && !artifact.errorCode) {
    context.addIssue({ code: 'custom', path: ['errorCode'], message: 'failed diagnosis requires an error code' });
  }
  if (artifact.status !== 'failed' && artifact.errorCode !== null) {
    context.addIssue({ code: 'custom', path: ['errorCode'], message: 'only failed diagnosis has a current error code' });
  }
  if (artifact.status === 'superseded' && !artifact.supersededReason) {
    context.addIssue({ code: 'custom', path: ['supersededReason'], message: 'superseded diagnosis requires a reason' });
  }
  if (artifact.status !== 'superseded' && artifact.supersededReason !== null) {
    context.addIssue({ code: 'custom', path: ['supersededReason'], message: 'only superseded diagnosis has a superseded reason' });
  }
  if (['queued', 'processing', 'failed'].includes(artifact.status) && artifact.result !== null) {
    context.addIssue({ code: 'custom', path: ['result'], message: 'incomplete diagnosis cannot contain a result' });
  }
  if (artifact.lifecycle.some((event) => event.status === 'complete') && artifact.result === null) {
    context.addIssue({
      code: 'custom',
      path: ['result'],
      message: 'a superseded completed diagnosis must retain its provider result',
    });
  }
  if (!artifact.result) return;

  const criterionIds = new Set(payload.task.rubric.map((criterion) => criterion.criterionId));
  const segmentIds = new Set(payload.finalSegments.map((segment) => segment.id));
  const focusDrill = payload.task.drills.find(
    (drill) => drill.drillId === artifact.result?.focus.drillId,
  );
  if (
    !criterionIds.has(artifact.result.focus.criterionId)
    || !focusDrill
    || focusDrill.criterionId !== artifact.result.focus.criterionId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['result', 'focus'],
      message: 'AI focus must resolve to one criterion and Drill in the approved payload',
    });
  }
  artifact.result.observations.forEach((observation, index) => {
    if (!criterionIds.has(observation.criterionId)) {
      context.addIssue({
        code: 'custom',
        path: ['result', 'observations', index, 'criterionId'],
        message: 'AI observation criterion must exist in the approved rubric',
      });
    }
    if (observation.segmentId !== null && !segmentIds.has(observation.segmentId)) {
      context.addIssue({
        code: 'custom',
        path: ['result', 'observations', index, 'segmentId'],
        message: 'AI observation segment must exist in the approved transcript',
      });
    }
    if (observation.type === 'quote' && observation.segmentId === null) {
      context.addIssue({
        code: 'custom',
        path: ['result', 'observations', index, 'segmentId'],
        message: 'quoted AI evidence requires a traceable final segment',
      });
    }
    if (observation.type === 'quote' && observation.segmentId !== null) {
      const segment = payload.finalSegments.find((candidate) => candidate.id === observation.segmentId);
      if (!segment || !evidenceReferencesApprovedSource(observation.evidence, [segment.text])) {
        context.addIssue({
          code: 'custom',
          path: ['result', 'observations', index, 'evidence'],
          message: 'quoted AI evidence must quote an exact phrase from its approved segment',
        });
      }
    }
  });
});
export type CloudDeepDiagnosisArtifact = z.infer<typeof CloudDeepDiagnosisArtifactSchema>;

export function createQueuedCloudDeepDiagnosis(input: {
  readonly payload: DeepDiagnosisPayload;
  readonly payloadHash: string;
  readonly consentId: string;
  readonly at: string;
}): CloudDeepDiagnosisArtifact {
  return CloudDeepDiagnosisArtifactSchema.parse({
    schemaVersion: 1,
    snapshotId: input.payload.snapshotId,
    transcriptVersion: input.payload.transcriptVersion,
    analysisInputId: input.payload.analysisInputId,
    payloadHash: input.payloadHash,
    consentId: input.consentId,
    approvedPayload: input.payload,
    status: 'queued',
    lifecycle: [{ status: 'queued', at: input.at, errorCode: null }],
    result: null,
    errorCode: null,
    supersededReason: null,
    createdAt: input.at,
    updatedAt: input.at,
  });
}

export function transitionCloudDeepDiagnosis(
  artifactInput: CloudDeepDiagnosisArtifact,
  transition: {
    readonly status: CloudDeepDiagnosisStatus;
    readonly at: string;
    readonly result?: DeepDiagnosisResponse | null;
    readonly errorCode?: string | null;
    readonly supersededReason?: 'transcript_correction_changed_payload' | 'consent_reset' | null;
  },
): CloudDeepDiagnosisArtifact {
  const artifact = CloudDeepDiagnosisArtifactSchema.parse(artifactInput);
  return CloudDeepDiagnosisArtifactSchema.parse({
    ...artifact,
    status: transition.status,
    lifecycle: [...artifact.lifecycle, {
      status: transition.status,
      at: transition.at,
      errorCode: transition.errorCode ?? null,
    }],
    result: transition.result === undefined ? artifact.result : transition.result,
    errorCode: transition.errorCode ?? null,
    supersededReason: transition.status === 'superseded'
      ? transition.supersededReason ?? 'transcript_correction_changed_payload'
      : null,
    updatedAt: transition.at,
  });
}

export const CloudSemanticComparisonArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  analysisInputId: IdentifierSchema,
  initialAttemptId: IdentifierSchema,
  initialSnapshotId: IdentifierSchema,
  initialTranscriptVersion: z.number().int().positive(),
  retryAttemptId: IdentifierSchema,
  retrySnapshotId: IdentifierSchema,
  retryTranscriptVersion: z.number().int().positive(),
  focusVersion: z.number().int().positive(),
  criterionId: IdentifierSchema,
  drillId: IdentifierSchema,
  protocolVersion: z.literal('paired-1'),
  payloadHash: z.string().length(64),
  consentId: IdentifierSchema,
  approvedPayload: SemanticComparisonPayloadSchema,
  status: CloudDeepDiagnosisStatusSchema,
  lifecycle: z.array(z.object({
    status: CloudDeepDiagnosisStatusSchema,
    at: IsoDateTimeSchema,
    errorCode: z.string().min(1).max(120).nullable(),
  }).strict()).min(1).max(30),
  result: SemanticComparisonResponseSchema.nullable(),
  errorCode: z.string().min(1).max(120).nullable(),
  supersededReason: z.enum(['comparison_payload_changed', 'consent_reset']).nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict().superRefine((artifact, context) => {
  const payload = artifact.approvedPayload;
  const lastLifecycle = artifact.lifecycle.at(-1);
  const allowedTransitions: Readonly<Record<CloudDeepDiagnosisStatus, readonly CloudDeepDiagnosisStatus[]>> = {
    queued: ['processing', 'superseded'],
    processing: ['complete', 'failed', 'superseded'],
    complete: ['superseded'],
    failed: ['processing', 'superseded'],
    superseded: [],
  };
  if (
    artifact.analysisInputId !== payload.analysisInputId
    || artifact.initialAttemptId !== payload.initial.attemptId
    || artifact.initialSnapshotId !== payload.initial.snapshotId
    || artifact.initialTranscriptVersion !== payload.initial.transcriptVersion
    || artifact.retryAttemptId !== payload.retry.attemptId
    || artifact.retrySnapshotId !== payload.retry.snapshotId
    || artifact.retryTranscriptVersion !== payload.retry.transcriptVersion
    || artifact.focusVersion !== payload.focus.version
    || artifact.criterionId !== payload.focus.criterionId
    || artifact.drillId !== payload.focus.drillId
    || artifact.protocolVersion !== payload.protocolVersion
  ) {
    context.addIssue({
      code: 'custom',
      path: ['approvedPayload'],
      message: 'cloud comparison identity must match its exact approved payload',
    });
  }
  if (payload.initial.snapshotId === payload.retry.snapshotId) {
    context.addIssue({
      code: 'custom',
      path: ['approvedPayload', 'retry', 'snapshotId'],
      message: 'comparison requires two distinct frozen snapshots',
    });
  }
  if (lastLifecycle?.status !== artifact.status || lastLifecycle?.at !== artifact.updatedAt) {
    context.addIssue({
      code: 'custom',
      path: ['lifecycle'],
      message: 'cloud comparison lifecycle must end at the persisted current status',
    });
  }
  if (artifact.lifecycle[0]?.at !== artifact.createdAt) {
    context.addIssue({
      code: 'custom',
      path: ['createdAt'],
      message: 'cloud comparison creation time must match its first lifecycle event',
    });
  }
  if (artifact.lifecycle[0]?.status !== 'queued') {
    context.addIssue({
      code: 'custom',
      path: ['lifecycle', 0, 'status'],
      message: 'cloud comparison must start queued',
    });
  }
  artifact.lifecycle.slice(1).forEach((event, index) => {
    const previous = artifact.lifecycle[index]!;
    if (!allowedTransitions[previous.status].includes(event.status)) {
      context.addIssue({
        code: 'custom',
        path: ['lifecycle', index + 1, 'status'],
        message: `illegal cloud comparison transition ${previous.status} -> ${event.status}`,
      });
    }
    if (event.at < previous.at) {
      context.addIssue({
        code: 'custom',
        path: ['lifecycle', index + 1, 'at'],
        message: 'cloud comparison lifecycle must be chronological',
      });
    }
  });
  if (artifact.status === 'complete' && !artifact.result) {
    context.addIssue({ code: 'custom', path: ['result'], message: 'complete comparison requires a result' });
  }
  if (['queued', 'processing', 'failed'].includes(artifact.status) && artifact.result !== null) {
    context.addIssue({ code: 'custom', path: ['result'], message: 'incomplete comparison cannot contain a result' });
  }
  if (artifact.lifecycle.some((event) => event.status === 'complete') && artifact.result === null) {
    context.addIssue({
      code: 'custom',
      path: ['result'],
      message: 'a superseded completed comparison must retain its provider result',
    });
  }
  if (artifact.status === 'failed' && !artifact.errorCode) {
    context.addIssue({ code: 'custom', path: ['errorCode'], message: 'failed comparison requires an error code' });
  }
  if (artifact.status !== 'failed' && artifact.errorCode !== null) {
    context.addIssue({ code: 'custom', path: ['errorCode'], message: 'only failed comparison has an error code' });
  }
  if (artifact.status === 'superseded' && !artifact.supersededReason) {
    context.addIssue({ code: 'custom', path: ['supersededReason'], message: 'superseded comparison requires a reason' });
  }
  if (artifact.status !== 'superseded' && artifact.supersededReason !== null) {
    context.addIssue({ code: 'custom', path: ['supersededReason'], message: 'only superseded comparison has a superseded reason' });
  }
  if (artifact.result) {
    const initialSources = [
      ...payload.initial.finalSegments.map((segment) => segment.text),
      ...payload.initial.localEvidence.flatMap((evidence) => [evidence.phrase, evidence.evidence]),
    ];
    const retrySources = [
      ...payload.retry.finalSegments.map((segment) => segment.text),
      ...payload.retry.localEvidence.flatMap((evidence) => [evidence.phrase, evidence.evidence]),
    ];
    if (
      artifact.result.result !== 'insufficient_evidence'
      && (artifact.result.initialEvidence.length === 0 || artifact.result.retryEvidence.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'a semantic trend requires evidence from both attempts',
      });
    }
    artifact.result.initialEvidence.forEach((evidence, index) => {
      if (!evidenceReferencesApprovedSource(evidence, initialSources)) {
        context.addIssue({
          code: 'custom',
          path: ['result', 'initialEvidence', index],
          message: 'initial semantic evidence must quote its approved attempt',
        });
      }
    });
    artifact.result.retryEvidence.forEach((evidence, index) => {
      if (!evidenceReferencesApprovedSource(evidence, retrySources)) {
        context.addIssue({
          code: 'custom',
          path: ['result', 'retryEvidence', index],
          message: 'retry semantic evidence must quote its approved attempt',
        });
      }
    });
  }
});
export type CloudSemanticComparisonArtifact = z.infer<typeof CloudSemanticComparisonArtifactSchema>;

export function createQueuedCloudSemanticComparison(input: {
  readonly payload: SemanticComparisonPayload;
  readonly payloadHash: string;
  readonly consentId: string;
  readonly at: string;
}): CloudSemanticComparisonArtifact {
  const payload = SemanticComparisonPayloadSchema.parse(input.payload);
  return CloudSemanticComparisonArtifactSchema.parse({
    schemaVersion: 1,
    analysisInputId: payload.analysisInputId,
    initialAttemptId: payload.initial.attemptId,
    initialSnapshotId: payload.initial.snapshotId,
    initialTranscriptVersion: payload.initial.transcriptVersion,
    retryAttemptId: payload.retry.attemptId,
    retrySnapshotId: payload.retry.snapshotId,
    retryTranscriptVersion: payload.retry.transcriptVersion,
    focusVersion: payload.focus.version,
    criterionId: payload.focus.criterionId,
    drillId: payload.focus.drillId,
    protocolVersion: payload.protocolVersion,
    payloadHash: input.payloadHash,
    consentId: input.consentId,
    approvedPayload: payload,
    status: 'queued',
    lifecycle: [{ status: 'queued', at: input.at, errorCode: null }],
    result: null,
    errorCode: null,
    supersededReason: null,
    createdAt: input.at,
    updatedAt: input.at,
  });
}

export function transitionCloudSemanticComparison(
  artifactInput: CloudSemanticComparisonArtifact,
  transition: {
    readonly status: CloudDeepDiagnosisStatus;
    readonly at: string;
    readonly result?: SemanticComparisonResponse | null;
    readonly errorCode?: string | null;
    readonly supersededReason?: 'comparison_payload_changed' | 'consent_reset' | null;
  },
): CloudSemanticComparisonArtifact {
  const artifact = CloudSemanticComparisonArtifactSchema.parse(artifactInput);
  return CloudSemanticComparisonArtifactSchema.parse({
    ...artifact,
    status: transition.status,
    lifecycle: [...artifact.lifecycle, {
      status: transition.status,
      at: transition.at,
      errorCode: transition.errorCode ?? null,
    }],
    result: transition.result === undefined ? artifact.result : transition.result,
    errorCode: transition.status === 'failed' ? transition.errorCode ?? 'PHRIO_COMPARISON_FAILED' : null,
    supersededReason: transition.status === 'superseded'
      ? transition.supersededReason ?? 'comparison_payload_changed'
      : null,
    updatedAt: transition.at,
  });
}

export const PracticeArtifactSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('attempt_snapshot'), sessionId: IdentifierSchema, id: IdentifierSchema, payload: AttemptSnapshotSchema }).strict()
    .superRefine((artifact, context) => {
      if (artifact.id !== artifact.payload.id) {
        context.addIssue({ code: 'custom', path: ['payload', 'id'], message: 'snapshot payload id must match its artifact id' });
      }
      if (artifact.sessionId !== artifact.payload.sessionId) {
        context.addIssue({ code: 'custom', path: ['payload', 'sessionId'], message: 'snapshot payload must belong to its artifact session' });
      }
    }),
  z.object({ type: z.literal('transcript_correction'), sessionId: IdentifierSchema, id: IdentifierSchema, payload: TranscriptCorrectionSchema }).strict()
    .superRefine((artifact, context) => {
      if (artifact.id !== artifact.payload.id) {
        context.addIssue({ code: 'custom', path: ['payload', 'id'], message: 'correction payload id must match its artifact id' });
      }
    }),
  z.object({ type: z.literal('deep_report'), sessionId: IdentifierSchema, id: IdentifierSchema, payload: DeepReportSchema }).strict()
    .superRefine((artifact, context) => {
      if (artifact.id !== artifact.payload.id) {
        context.addIssue({ code: 'custom', path: ['payload', 'id'], message: 'report payload id must match its artifact id' });
      }
    }),
  z.object({ type: z.literal('cloud_deep_diagnosis'), sessionId: IdentifierSchema, id: IdentifierSchema, payload: CloudDeepDiagnosisArtifactSchema }).strict()
    .superRefine((artifact, context) => {
      if (artifact.payload.approvedPayload.sessionId !== artifact.sessionId) {
        context.addIssue({
          code: 'custom',
          path: ['payload', 'approvedPayload', 'sessionId'],
          message: 'cloud diagnosis payload must belong to its artifact session',
        });
      }
    }),
  z.object({ type: z.literal('cloud_semantic_comparison'), sessionId: IdentifierSchema, id: IdentifierSchema, payload: CloudSemanticComparisonArtifactSchema }).strict()
    .superRefine((artifact, context) => {
      if (artifact.payload.approvedPayload.sessionId !== artifact.sessionId) {
        context.addIssue({
          code: 'custom',
          path: ['payload', 'approvedPayload', 'sessionId'],
          message: 'cloud comparison payload must belong to its artifact session',
        });
      }
    }),
  z.object({ type: z.literal('drill_completion'), sessionId: IdentifierSchema, id: IdentifierSchema, payload: DrillCompletionSchema }).strict()
    .superRefine((artifact, context) => {
      if (artifact.id !== artifact.payload.id) {
        context.addIssue({ code: 'custom', path: ['payload', 'id'], message: 'Drill payload id must match its artifact id' });
      }
    }),
  z.object({ type: z.literal('attempt_comparison'), sessionId: IdentifierSchema, id: IdentifierSchema, payload: AttemptComparisonSchema }).strict()
    .superRefine((artifact, context) => {
      if (artifact.id !== artifact.payload.id) {
        context.addIssue({ code: 'custom', path: ['payload', 'id'], message: 'comparison payload id must match its artifact id' });
      }
    }),
]);
export type PracticeArtifact = z.infer<typeof PracticeArtifactSchema>;

/**
 * Resolves the one frozen snapshot that is allowed to drive a current UI.
 * When a persisted Attempt identity is known it is a hard boundary: an older
 * snapshot of the same kind must never be used as a fallback.
 */
export function selectAttemptSnapshot(input: {
  readonly artifacts: readonly PracticeArtifact[];
  readonly kind: AttemptSnapshot['kind'];
  readonly expectedAttemptId?: string | null;
  readonly preferredSnapshotId?: string | null;
}): AttemptSnapshot | null {
  const candidates = input.artifacts
    .filter((artifact): artifact is Extract<PracticeArtifact, { type: 'attempt_snapshot' }> => (
      artifact.type === 'attempt_snapshot' && artifact.payload.kind === input.kind
    ))
    .map((artifact) => artifact.payload);
  if (input.expectedAttemptId) {
    return candidates.find((snapshot) => snapshot.attemptId === input.expectedAttemptId) ?? null;
  }
  const preferred = input.preferredSnapshotId
    ? candidates.find((snapshot) => snapshot.id === input.preferredSnapshotId)
    : null;
  if (preferred) return preferred;
  return candidates.sort((left, right) => (
    right.frozenAt.localeCompare(left.frozenAt)
    || right.generation - left.generation
    || right.id.localeCompare(left.id)
  ))[0] ?? null;
}

export function createTranscriptCorrectionId(): string {
  const entropy = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `correction-${entropy}`.slice(0, 96);
}

/** Every immutable correction event advances only its own frozen snapshot. */
export function transcriptVersionForDeepLane(
  snapshotInput: AttemptSnapshot,
  correctionsInput: readonly TranscriptCorrection[],
): number {
  const snapshot = AttemptSnapshotSchema.parse(snapshotInput);
  const correctionCount = correctionsInput
    .map((correction) => TranscriptCorrectionSchema.parse(correction))
    .filter((correction) => correction.snapshotId === snapshot.id)
    .length;
  return snapshot.transcriptVersion + correctionCount;
}

/**
 * Derives the immutable identity of one local Deep report input. The complete
 * SHA-256 digest avoids the truncation collisions caused by concatenating
 * user-controlled identifiers, while remaining stable across page reloads.
 */
export async function deriveLocalDeepReportId(input: {
  readonly snapshotId: string;
  readonly transcriptVersion: number;
  readonly criterionId: string;
  readonly drillId: string;
}): Promise<string> {
  const identity = JSON.stringify([
    'deep-report-1',
    IdentifierSchema.parse(input.snapshotId),
    z.number().int().positive().parse(input.transcriptVersion),
    IdentifierSchema.parse(input.criterionId),
    IdentifierSchema.parse(input.drillId),
  ]);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(identity),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return IdentifierSchema.parse(`deep-report-${hex}`);
}

export function transcriptForDeepLane(
  snapshotInput: AttemptSnapshot,
  correctionsInput: readonly TranscriptCorrection[],
): readonly { readonly segmentId: string; readonly originalText: string; readonly currentText: string }[] {
  const snapshot = AttemptSnapshotSchema.parse(snapshotInput);
  const corrections = correctionsInput.map((item) => TranscriptCorrectionSchema.parse(item));
  return snapshot.finalSegments.map((segment) => {
    const latest = corrections
      .filter((item) => item.snapshotId === snapshot.id && item.segmentId === segment.id)
      .reduce<TranscriptCorrection | undefined>((current, candidate) => (
        !current || candidate.createdAt >= current.createdAt ? candidate : current
      ), undefined);
    return { segmentId: segment.id, originalText: segment.text, currentText: latest?.correctedText ?? segment.text };
  });
}

export interface DeepEvidenceView {
  readonly annotation: LiveAnnotation;
  readonly currentLifecycle: LiveAnnotation['lifecycle'];
  readonly historyReason: string | null;
}

/**
 * Keeps immutable Fast Lane evidence while deriving its current Deep Lane state.
 * A user correction never deletes the old O anchor; it neutralizes evidence whose
 * exact marked phrase no longer exists in the corrected sentence.
 */
export function evidenceForDeepLane(
  snapshotInput: AttemptSnapshot,
  correctionsInput: readonly TranscriptCorrection[],
): readonly DeepEvidenceView[] {
  const snapshot = AttemptSnapshotSchema.parse(snapshotInput);
  const transcript = transcriptForDeepLane(snapshot, correctionsInput);
  const currentTextBySegment = new Map(
    transcript.map((segment) => [segment.segmentId, segment.currentText]),
  );
  return snapshot.annotations.map((annotation) => {
    if (annotation.lifecycle === 'withdrawn') {
      return {
        annotation,
        currentLifecycle: 'withdrawn' as const,
        historyReason: annotation.withdrawnReason ?? '实时阶段已撤回',
      };
    }
    const sourceSpan = annotation.sourceSpan;
    const currentText = currentTextBySegment.get(annotation.segmentId);
    if (
      sourceSpan
      && currentText !== undefined
      && currentText.slice(sourceSpan.start, sourceSpan.end) !== sourceSpan.text
    ) {
      return {
        annotation,
        currentLifecycle: 'withdrawn' as const,
        historyReason: '逐字稿纠正后，原精确位置已不再匹配',
      };
    }
    return { annotation, currentLifecycle: annotation.lifecycle, historyReason: null };
  });
}

/**
 * Derives Deep Lane counters from the corrected transcript and evidence that
 * remains confirmed. It never mutates the frozen Fast Lane metrics.
 */
export function metricsForDeepLane(
  snapshotInput: AttemptSnapshot,
  correctionsInput: readonly TranscriptCorrection[] = [],
): LiveMetricSnapshot {
  const snapshot = AttemptSnapshotSchema.parse(snapshotInput);
  const transcript = transcriptForDeepLane(snapshot, correctionsInput);
  const neutralized = evidenceForDeepLane(snapshot, correctionsInput)
    .filter((item) => (
      item.annotation.lifecycle === 'confirmed' && item.currentLifecycle === 'withdrawn'
    ))
    .map((item) => item.annotation);
  const removed = (type: LiveAnnotationType) => (
    neutralized.filter((annotation) => annotation.type === type).length
  );
  return {
    finalCharacters: transcript.reduce((total, segment) => total + segment.currentText.length, 0),
    finalSegments: transcript.length,
    fillers: Math.max(0, snapshot.metrics.fillers - removed('filler')),
    hedges: Math.max(0, snapshot.metrics.hedges - removed('hedge')),
    vagueWords: Math.max(0, snapshot.metrics.vagueWords - removed('vague')),
    repetitions: Math.max(0, snapshot.metrics.repetitions - removed('repetition')),
    selfCorrections: Math.max(0, snapshot.metrics.selfCorrections - removed('self_correction')),
    algorithmVersion: snapshot.metrics.algorithmVersion,
  };
}

export function buildLocalDeepReport(input: {
  readonly id: string;
  readonly snapshot: AttemptSnapshot;
  readonly at: string;
  readonly focus?: {
    readonly criterionId: string;
    readonly label: string;
    readonly drillId: string;
    readonly drill: string;
  };
  readonly corrections?: readonly TranscriptCorrection[];
}): DeepReport {
  const snapshot = AttemptSnapshotSchema.parse(input.snapshot);
  const evidence = evidenceForDeepLane(snapshot, input.corrections ?? [])
    .filter((item) => item.currentLifecycle === 'confirmed')
    .map((item) => item.annotation);
  const focus = input.focus ?? {
    criterionId: 'decision-request',
    label: '结论先行',
    drillId: 'decision-first-30s',
    drill: '我的建议是___。原因有两点：___、___。今天需要大家决定___。',
  };
  return DeepReportSchema.parse({
    id: input.id,
    snapshotId: snapshot.id,
    transcriptVersion: transcriptVersionForDeepLane(snapshot, input.corrections ?? []),
    status: 'complete',
    rubricCriterionId: focus.criterionId,
    evidenceIds: evidence.slice(0, 12).map((item) => item.id),
    judgment: evidence.length > 0
      ? '冻结证据中仍有弱化、模糊、填充或节奏问题，可能增加听众提取核心信息的成本。'
      : '当前没有已确认的本地问题证据；仍需用当前任务 Rubric 检查目标行为是否完整。',
    focus,
    createdAt: input.at,
    updatedAt: input.at,
    error: null,
  });
}

interface ComparisonDimensionDefinition {
  readonly label: string;
  readonly signalLabel: string;
  readonly source: AttemptComparisonBasis['source'];
  readonly metricKeys: readonly ComparableMetricKey[];
  readonly annotationTypes: readonly LiveAnnotationType[];
  /** Annotation-only axes need at least one observed signal before zero can mean anything. */
  readonly requiresObservedEvidence: boolean;
}

const COMPARISON_DIMENSIONS: Readonly<Record<CriterionComparisonDimension, ComparisonDimensionDefinition>> = {
  'delivery-friction': {
    label: '简洁表达的问题信号',
    signalLabel: '填充表达、重复和自我修正',
    source: 'deterministic_metric',
    metricKeys: ['fillers', 'repetitions', 'selfCorrections'],
    annotationTypes: ['filler', 'repetition', 'self_correction'],
    requiresObservedEvidence: false,
  },
  'vague-language': {
    label: '模糊表达信号',
    signalLabel: '本地规则识别的模糊词',
    source: 'deterministic_metric',
    metricKeys: ['vagueWords'],
    annotationTypes: ['vague'],
    requiresObservedEvidence: false,
  },
  'pacing-flags': {
    label: '节奏异常证据',
    signalLabel: '长停顿和异常语速记录',
    source: 'annotation_evidence',
    metricKeys: [],
    annotationTypes: ['long_pause', 'speech_rate'],
    requiresObservedEvidence: true,
  },
  'structure-flags': {
    label: '结构问题证据',
    signalLabel: '与冻结焦点相关的结构记录',
    source: 'annotation_evidence',
    metricKeys: [],
    annotationTypes: ['structure'],
    requiresObservedEvidence: true,
  },
  'task-coverage-gaps': {
    label: '任务要求缺口证据',
    signalLabel: '与冻结任务要求相关的缺口记录',
    source: 'annotation_evidence',
    metricKeys: [],
    annotationTypes: ['task_gap'],
    requiresObservedEvidence: true,
  },
  'task-structure-gaps': {
    label: '任务与结构缺口证据',
    signalLabel: '与冻结任务要求或结构相关的缺口记录',
    source: 'annotation_evidence',
    metricKeys: [],
    annotationTypes: ['task_gap', 'structure'],
    requiresObservedEvidence: true,
  },
};

function metricProblemCount(
  metrics: LiveMetricSnapshot,
  keys: readonly ComparableMetricKey[],
): number {
  return keys.reduce((total, key) => total + metrics[key], 0);
}

function activeComparisonEvidence(
  snapshot: AttemptSnapshot,
  corrections: readonly TranscriptCorrection[],
  types: readonly LiveAnnotationType[],
): LiveAnnotation[] {
  const allowed = new Set(types);
  return evidenceForDeepLane(snapshot, corrections)
    .filter((item) => item.currentLifecycle === 'confirmed' && allowed.has(item.annotation.type))
    .map((item) => item.annotation);
}

function resultForProblemCounts(initialValue: number, retryValue: number): AttemptComparison['result'] {
  if (retryValue < initialValue) return 'improved';
  if (retryValue > initialValue) return 'regressed';
  return 'stable';
}

export function compareFrozenAttempts(input: {
  readonly id: string;
  readonly initial: AttemptSnapshot;
  readonly retry: AttemptSnapshot;
  readonly criterionId: string;
  readonly comparisonDimension?: CriterionComparisonDimension | null;
  readonly at: string;
  readonly corrections?: readonly TranscriptCorrection[];
}): AttemptComparison {
  const initial = AttemptSnapshotSchema.parse(input.initial);
  const retry = AttemptSnapshotSchema.parse(input.retry);
  if (initial.sessionId !== retry.sessionId || initial.kind !== 'initial' || retry.kind !== 'retry') {
    throw new Error('INCOMPATIBLE_ATTEMPT_PAIR');
  }
  const corrections = input.corrections ?? [];
  const initialMetrics = metricsForDeepLane(initial, corrections);
  const retryMetrics = metricsForDeepLane(retry, corrections);
  const comparableMetricVersion = initialMetrics.algorithmVersion === retryMetrics.algorithmVersion;
  const hasFinalPair = initial.finalSegments.length > 0 && retry.finalSegments.length > 0;
  const definition = input.comparisonDimension
    ? COMPARISON_DIMENSIONS[input.comparisonDimension]
    : null;
  const observedInitialEvidence = definition
    ? activeComparisonEvidence(initial, corrections, definition.annotationTypes)
    : [];
  const observedRetryEvidence = definition
    ? activeComparisonEvidence(retry, corrections, definition.annotationTypes)
    : [];
  const observedEvidence = [...observedInitialEvidence, ...observedRetryEvidence];
  const evidenceVersionsMatch = definition?.source !== 'annotation_evidence'
    || observedEvidence.every(
      (annotation) => annotation.algorithmVersion === initialMetrics.algorithmVersion,
    );
  const hasObservedEvidence = observedEvidence.length > 0;
  // Metric-backed axes are compared from their frozen counters. Annotation ids
  // are trace links only, so never attach traces produced by another algorithm.
  const initialEvidence = definition?.source === 'deterministic_metric'
    ? observedInitialEvidence.filter(
      (annotation) => annotation.algorithmVersion === initialMetrics.algorithmVersion,
    )
    : observedInitialEvidence;
  const retryEvidence = definition?.source === 'deterministic_metric'
    ? observedRetryEvidence.filter(
      (annotation) => annotation.algorithmVersion === retryMetrics.algorithmVersion,
    )
    : observedRetryEvidence;
  const comparable = Boolean(
    definition
    && hasFinalPair
    && comparableMetricVersion
    && evidenceVersionsMatch
    && (!definition.requiresObservedEvidence || hasObservedEvidence),
  );
  const initialValue = comparable && definition
    ? definition.source === 'deterministic_metric'
      ? metricProblemCount(initialMetrics, definition.metricKeys)
      : initialEvidence.length
    : null;
  const retryValue = comparable && definition
    ? definition.source === 'deterministic_metric'
      ? metricProblemCount(retryMetrics, definition.metricKeys)
      : retryEvidence.length
    : null;
  const result = initialValue === null || retryValue === null
    ? 'insufficient_evidence'
    : resultForProblemCounts(initialValue, retryValue);
  const basis = definition ? AttemptComparisonBasisSchema.parse({
    dimensionId: input.comparisonDimension,
    label: definition.label,
    signalLabel: definition.signalLabel,
    source: definition.source,
    metricKeys: definition.metricKeys,
    annotationTypes: definition.annotationTypes,
    initialValue,
    retryValue,
    comparable,
  }) : null;
  const explanation = !comparableMetricVersion
    ? '两遍本地指标版本不同，不能按同一口径判断变化。'
    : !hasFinalPair
      ? '两遍缺少可比较的 final 证据，因此不判断变化。'
      : !definition
        ? '当前冻结焦点没有 paired-1 支持的本地可比较维度；不能用其他表达问题数量代替。'
        : !evidenceVersionsMatch
          ? '焦点证据与冻结指标的算法版本不一致，因此不判断变化。'
          : definition.requiresObservedEvidence && !hasObservedEvidence
            ? `“${definition.label}”需要焦点对应的正式证据；两遍都没有形成这类证据，不能把零条当作已达标。`
            : `按冻结焦点对应的“${definition.label}”比较：${initialValue} → ${retryValue} 条问题信号；${
              result === 'improved'
                ? '数量减少'
                : result === 'regressed'
                  ? '数量增加'
                  : '数量持平'
            }。这只描述该维度的本轮可观察变化，不代表总分或整体能力判断。`;
  return AttemptComparisonSchema.parse({
    id: input.id,
    initialSnapshotId: initial.id,
    retrySnapshotId: retry.id,
    initialTranscriptVersion: transcriptVersionForDeepLane(initial, corrections),
    retryTranscriptVersion: transcriptVersionForDeepLane(retry, corrections),
    criterionId: input.criterionId,
    protocolVersion: 'paired-1',
    result,
    basis,
    initialEvidenceIds: initialEvidence.map((annotation) => annotation.id),
    retryEvidenceIds: retryEvidence.map((annotation) => annotation.id),
    explanation,
    comparedAt: input.at,
  });
}
