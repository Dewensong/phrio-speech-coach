import {
  DeepDiagnosisPayloadSchema,
  SemanticComparisonPayloadSchema,
  type DeepDiagnosisPayload,
  type SemanticComparisonPayload,
  type TaskContextForAi,
} from './cloud-ai';
import {
  evidenceForDeepLane,
  metricsForDeepLane,
  transcriptForDeepLane,
  transcriptVersionForDeepLane,
  type TranscriptCorrection,
} from './deep-lane';
import type { PracticeSession } from './domain';
import type { AttemptSnapshot } from './live-practice';
import { P1_MODE_PACKS } from './mode-packs';

/** Builds the immutable task context shared by renderer preview and backend validation. */
export function taskContextForCloudAi(session: PracticeSession): TaskContextForAi {
  const mode = P1_MODE_PACKS.find((candidate) => candidate.id === session.modeId);
  if (!mode) throw new Error('AI_TASK_MODE_NOT_FOUND');
  const task = session.taskSnapshot;
  const allowedDrillIds = new Set(task.fallbackDrillIds);
  const allowedCriterionIds = new Set(task.focusCandidateCriterionIds);
  const matchingLegacyTask = mode.tasks.find((candidate) => (
    candidate.id === task.id && candidate.version === task.version
  ));
  const legacyDefinitionsCompatible = mode.version === session.modeVersion || Boolean(matchingLegacyTask);
  const rubric = task.rubricSnapshot ?? (
    legacyDefinitionsCompatible
      ? mode.criteria.filter((criterion) => allowedCriterionIds.has(criterion.id))
      : null
  );
  const drills = task.drillSnapshot ?? (
    legacyDefinitionsCompatible
      ? mode.drills.filter((drill) => allowedDrillIds.has(drill.id))
      : null
  );
  if (!rubric || !drills) throw new Error('AI_TASK_DEFINITIONS_NOT_FROZEN');
  return {
    modeId: session.modeId,
    taskId: task.id,
    taskVersion: task.version,
    prompt: task.prompt,
    audience: task.context.audience,
    objective: task.context.objective,
    background: task.context.background,
    sourceMaterial: task.context.sourceMaterial,
    counterArgument: task.context.counterArgument,
    roleContext: task.context.roleContext,
    successConditions: task.successConditions,
    rubric: rubric.map((criterion) => ({
      criterionId: criterion.id,
      label: criterion.label,
      description: criterion.description,
    })),
    drills: drills.map((drill) => ({
      drillId: drill.id,
      criterionId: drill.criterionId,
      title: drill.title,
      instruction: drill.instruction,
      template: drill.template,
      successCondition: drill.successCondition,
    })),
  };
}

function finalSegmentsForCloudAi(
  snapshot: AttemptSnapshot,
  corrections: readonly TranscriptCorrection[] = [],
) {
  const currentText = new Map(
    transcriptForDeepLane(snapshot, corrections).map((segment) => [segment.segmentId, segment.currentText]),
  );
  return snapshot.finalSegments.map((segment) => ({
    id: segment.id,
    sequence: segment.sequence,
    revision: segment.revision,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: currentText.get(segment.id) ?? segment.text,
  }));
}

function localEvidenceForCloudAi(
  snapshot: AttemptSnapshot,
  corrections: readonly TranscriptCorrection[] = [],
) {
  return evidenceForDeepLane(snapshot, corrections)
    .filter((item) => item.currentLifecycle === 'confirmed')
    .map((item) => ({
      id: item.annotation.id,
      displayId: item.annotation.displayId,
      type: item.annotation.type,
      segmentId: item.annotation.segmentId,
      phrase: item.annotation.sourceSpan?.text ?? item.annotation.evidence,
      evidence: item.annotation.evidence,
      suggestion: item.annotation.suggestion,
      lifecycle: item.currentLifecycle,
      source: item.annotation.source,
    }));
}

function wordCount(text: string): number {
  return text.match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu)?.length ?? 0;
}

function metricsForCloudAi(
  snapshot: AttemptSnapshot,
  corrections: readonly TranscriptCorrection[] = [],
) {
  const text = transcriptForDeepLane(snapshot, corrections)
    .map((segment) => segment.currentText)
    .join('');
  const metrics = metricsForDeepLane(snapshot, corrections);
  return {
    words: wordCount(text),
    fillers: metrics.fillers,
    hedges: metrics.hedges,
    vagueWords: metrics.vagueWords,
    repetitions: metrics.repetitions,
    selfCorrections: metrics.selfCorrections,
  };
}

export function buildDeepDiagnosisPayload(input: {
  readonly session: PracticeSession;
  readonly snapshot: AttemptSnapshot;
  readonly corrections: readonly TranscriptCorrection[];
  readonly analysisInputId?: string;
}): DeepDiagnosisPayload {
  const attempt = input.session.attempts.find(
    (candidate) => candidate.id === input.snapshot.attemptId,
  );
  if (
    input.snapshot.sessionId !== input.session.id
    || !attempt
    || attempt.kind !== input.snapshot.kind
    || input.session.taskSnapshot.id !== input.session.taskId
    || input.session.taskSnapshot.version !== input.session.taskVersion
  ) {
    throw new Error('AI_DEEP_SNAPSHOT_SESSION_MISMATCH');
  }
  const transcript = transcriptForDeepLane(input.snapshot, input.corrections);
  return DeepDiagnosisPayloadSchema.parse({
    schemaVersion: 'deep-diagnosis-1',
    purpose: 'deep_diagnosis',
    analysisInputId: input.analysisInputId ?? globalThis.crypto.randomUUID(),
    sessionId: input.session.id,
    attemptId: input.snapshot.attemptId,
    snapshotId: input.snapshot.id,
    transcriptVersion: transcriptVersionForDeepLane(input.snapshot, input.corrections),
    task: taskContextForCloudAi(input.session),
    finalSegments: finalSegmentsForCloudAi(input.snapshot, input.corrections),
    corrections: transcript
      .filter((segment) => segment.originalText !== segment.currentText)
      .map((segment) => ({
        segmentId: segment.segmentId,
        originalText: segment.originalText,
        approvedText: segment.currentText,
      })),
    localEvidence: localEvidenceForCloudAi(input.snapshot, input.corrections),
    metrics: metricsForCloudAi(input.snapshot, input.corrections),
  });
}

export function buildSemanticComparisonPayload(input: {
  readonly session: PracticeSession;
  readonly initial: AttemptSnapshot;
  readonly retry: AttemptSnapshot;
  readonly criterionId: string;
  readonly label: string;
  readonly drillId: string;
  readonly corrections: readonly TranscriptCorrection[];
  readonly analysisInputId?: string;
}): SemanticComparisonPayload {
  if (
    input.initial.sessionId !== input.session.id
    || input.retry.sessionId !== input.session.id
    || input.initial.kind !== 'initial'
    || input.retry.kind !== 'retry'
    || input.initial.id === input.retry.id
  ) throw new Error('AI_COMPARISON_SNAPSHOT_PAIR_INVALID');
  const persistedFocus = input.session.focus;
  if (
    !persistedFocus
    || persistedFocus.criterionId !== input.criterionId
    || persistedFocus.drillId !== input.drillId
    || persistedFocus.label !== input.label
    || input.retry.focusVersion === null
  ) throw new Error('AI_COMPARISON_FOCUS_NOT_PERSISTED');
  const initialAttempt = input.session.attempts.find((attempt) => attempt.kind === 'initial');
  const retryAttempt = input.session.attempts.find((attempt) => attempt.kind === 'retry');
  if (initialAttempt?.status !== 'confirmed' || retryAttempt?.status !== 'confirmed') {
    throw new Error('AI_COMPARISON_ATTEMPTS_NOT_CONFIRMED');
  }

  const attempt = (snapshot: AttemptSnapshot) => {
    const corrections = input.corrections.filter((correction) => correction.snapshotId === snapshot.id);
    return {
      attemptId: snapshot.attemptId,
      snapshotId: snapshot.id,
      transcriptVersion: transcriptVersionForDeepLane(snapshot, corrections),
      finalSegments: finalSegmentsForCloudAi(snapshot, corrections),
      localEvidence: localEvidenceForCloudAi(snapshot, corrections),
      metrics: metricsForCloudAi(snapshot, corrections),
    };
  };
  return SemanticComparisonPayloadSchema.parse({
    schemaVersion: 'comparison-1',
    purpose: 'comparison',
    analysisInputId: input.analysisInputId ?? globalThis.crypto.randomUUID(),
    sessionId: input.session.id,
    task: taskContextForCloudAi(input.session),
    focus: {
      version: input.retry.focusVersion,
      criterionId: input.criterionId,
      label: input.label,
      drillId: input.drillId,
    },
    protocolVersion: 'paired-1',
    initial: attempt(input.initial),
    retry: attempt(input.retry),
  });
}

export function parseEditedDeepPayload(
  json: string,
  original: DeepDiagnosisPayload,
): DeepDiagnosisPayload {
  const parsed = DeepDiagnosisPayloadSchema.parse(JSON.parse(json));
  if (
    parsed.sessionId !== original.sessionId
    || parsed.attemptId !== original.attemptId
    || parsed.snapshotId !== original.snapshotId
    || parsed.analysisInputId !== original.analysisInputId
    || parsed.transcriptVersion !== original.transcriptVersion
    || parsed.task.modeId !== original.task.modeId
    || parsed.task.taskId !== original.task.taskId
    || parsed.task.taskVersion !== original.task.taskVersion
  ) throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');

  const originalSegments = new Map(original.finalSegments.map((segment) => [segment.id, segment]));
  const originalCorrections = new Map(original.corrections.map((correction) => [correction.segmentId, correction]));
  const originalEvidence = new Map(original.localEvidence.map((evidence) => [evidence.id, evidence]));
  const originalRubric = new Set(original.task.rubric.map((criterion) => criterion.criterionId));
  const originalDrills = new Map(original.task.drills.map((drill) => [drill.drillId, drill]));
  if (
    hasDuplicateIds(parsed.finalSegments.map((segment) => segment.id))
    || hasDuplicateIds(parsed.corrections.map((correction) => correction.segmentId))
    || hasDuplicateIds(parsed.localEvidence.map((evidence) => evidence.id))
    || hasDuplicateIds(parsed.task.rubric.map((criterion) => criterion.criterionId))
    || hasDuplicateIds(parsed.task.drills.map((drill) => drill.drillId))
  ) throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');

  for (const segment of parsed.finalSegments) {
    const source = originalSegments.get(segment.id);
    if (!source
      || segment.sequence !== source.sequence
      || segment.revision !== source.revision
      || segment.startMs !== source.startMs
      || segment.endMs !== source.endMs) {
      throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');
    }
  }
  for (const correction of parsed.corrections) {
    if (!originalCorrections.has(correction.segmentId)) throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');
  }
  for (const evidence of parsed.localEvidence) {
    const source = originalEvidence.get(evidence.id);
    if (!source
      || evidence.displayId !== source.displayId
      || evidence.type !== source.type
      || evidence.segmentId !== source.segmentId
      || evidence.lifecycle !== source.lifecycle
      || evidence.source !== source.source) {
      throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');
    }
  }
  if (
    parsed.task.successConditions.length > original.task.successConditions.length
    || JSON.stringify(parsed.metrics) !== JSON.stringify(original.metrics)
    || parsed.task.rubric.some((criterion) => !originalRubric.has(criterion.criterionId))
  ) throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');
  for (const drill of parsed.task.drills) {
    const source = originalDrills.get(drill.drillId);
    if (!source || drill.criterionId !== source.criterionId) throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');
  }
  const retainedSegmentIds = new Set(parsed.finalSegments.map((segment) => segment.id));
  const retainedCriterionIds = new Set(parsed.task.rubric.map((criterion) => criterion.criterionId));
  if (
    parsed.corrections.some((correction) => !retainedSegmentIds.has(correction.segmentId))
    || parsed.localEvidence.some((evidence) => !retainedSegmentIds.has(evidence.segmentId))
    || parsed.task.drills.some((drill) => !retainedCriterionIds.has(drill.criterionId))
  ) throw new Error('AI_PAYLOAD_SCOPE_INVALID');
  return parsed;
}

export function parseEditedComparisonPayload(
  json: string,
  original: SemanticComparisonPayload,
): SemanticComparisonPayload {
  const parsed = SemanticComparisonPayloadSchema.parse(JSON.parse(json));
  if (
    parsed.sessionId !== original.sessionId
    || parsed.analysisInputId !== original.analysisInputId
    || parsed.protocolVersion !== original.protocolVersion
    || parsed.task.modeId !== original.task.modeId
    || parsed.task.taskId !== original.task.taskId
    || parsed.task.taskVersion !== original.task.taskVersion
    || parsed.initial.attemptId !== original.initial.attemptId
    || parsed.initial.snapshotId !== original.initial.snapshotId
    || parsed.initial.transcriptVersion !== original.initial.transcriptVersion
    || parsed.retry.attemptId !== original.retry.attemptId
    || parsed.retry.snapshotId !== original.retry.snapshotId
    || parsed.retry.transcriptVersion !== original.retry.transcriptVersion
    || parsed.focus.version !== original.focus.version
    || parsed.focus.criterionId !== original.focus.criterionId
    || parsed.focus.drillId !== original.focus.drillId
    || parsed.focus.label !== original.focus.label
  ) throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');

  const verifyAttempt = (
    candidate: SemanticComparisonPayload['initial'],
    source: SemanticComparisonPayload['initial'],
  ) => {
    if (
      hasDuplicateIds(candidate.finalSegments.map((segment) => segment.id))
      || hasDuplicateIds(candidate.localEvidence.map((evidence) => evidence.id))
    ) throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');
    const sourceSegments = new Map(source.finalSegments.map((segment) => [segment.id, segment]));
    const sourceEvidence = new Map(source.localEvidence.map((evidence) => [evidence.id, evidence]));
    for (const segment of candidate.finalSegments) {
      const originalSegment = sourceSegments.get(segment.id);
      if (!originalSegment
        || segment.sequence !== originalSegment.sequence
        || segment.revision !== originalSegment.revision
        || segment.startMs !== originalSegment.startMs
        || segment.endMs !== originalSegment.endMs) {
        throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');
      }
    }
    for (const evidence of candidate.localEvidence) {
      const originalEvidence = sourceEvidence.get(evidence.id);
      if (!originalEvidence
        || evidence.displayId !== originalEvidence.displayId
        || evidence.type !== originalEvidence.type
        || evidence.segmentId !== originalEvidence.segmentId
        || evidence.source !== originalEvidence.source) {
        throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');
      }
    }
    if (JSON.stringify(candidate.metrics) !== JSON.stringify(source.metrics)) {
      throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');
    }
  };
  verifyAttempt(parsed.initial, original.initial);
  verifyAttempt(parsed.retry, original.retry);

  if (
    hasDuplicateIds(parsed.task.rubric.map((criterion) => criterion.criterionId))
    || hasDuplicateIds(parsed.task.drills.map((drill) => drill.drillId))
  ) throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');
  const sourceRubric = new Set(original.task.rubric.map((criterion) => criterion.criterionId));
  const sourceDrills = new Map(original.task.drills.map((drill) => [drill.drillId, drill]));
  if (parsed.task.rubric.some((criterion) => !sourceRubric.has(criterion.criterionId))) {
    throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');
  }
  for (const drill of parsed.task.drills) {
    const source = sourceDrills.get(drill.drillId);
    if (!source || drill.criterionId !== source.criterionId) throw new Error('AI_PAYLOAD_IDENTITY_CHANGED');
  }
  return parsed;
}

function hasDuplicateIds(ids: readonly string[]): boolean {
  return new Set(ids).size !== ids.length;
}
