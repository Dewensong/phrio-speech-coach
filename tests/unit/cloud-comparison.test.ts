import { describe, expect, it } from 'vitest';

import {
  CloudSemanticComparisonArtifactSchema,
  P1_MODE_PACKS,
  PracticeArtifactSchema,
  PracticeSessionSchema,
  createPracticeSession,
  createQueuedCloudSemanticComparison,
  listPracticeFocusOptions,
  transitionCloudSemanticComparison,
  type AttemptSnapshot,
  type PracticeSession,
  type TranscriptCorrection,
} from '../../src/shared';
import {
  buildSemanticComparisonPayload,
  parseEditedComparisonPayload,
} from '../../src/frontend/services/cloud-ai-api';

const at = '2026-07-18T06:00:00.000Z';

function snapshot(kind: 'initial' | 'retry'): AttemptSnapshot {
  return {
    schemaVersion: 1,
    id: `snapshot-${kind}`,
    sessionId: 'session-cloud-comparison',
    attemptId: `frozen-attempt-${kind}`,
    generation: 1,
    kind,
    frozenAt: at,
    audioWatermark: 8_000,
    transcriptVersion: 1,
    finalSegments: [{
      id: `segment-${kind}-1`,
      attemptId: `frozen-attempt-${kind}`,
      sequence: 0,
      revision: 1,
      text: kind === 'initial' ? '我觉得可能要谨慎处理。' : '我的主张是谨慎处理，因为用户需要控制权。',
      startMs: 0,
      endMs: 4_000,
      confidence: null,
      isFinal: true,
      emittedAt: at,
      finalizedAt: at,
      modelVersion: 'test-1',
    }],
    annotations: [],
    hints: [],
    focusVersion: kind === 'retry' ? 1 : null,
    metrics: {
      finalCharacters: kind === 'initial' ? 11 : 20,
      finalSegments: 1,
      fillers: 0,
      hedges: kind === 'initial' ? 1 : 0,
      vagueWords: 0,
      repetitions: 0,
      selfCorrections: 0,
      algorithmVersion: 'local-rules-1',
    },
  };
}

function selectedFocus() {
  const focus = listPracticeFocusOptions('argument-rebuttal', 'ai-assistant-decisions')
    .find((candidate) => candidate.criterionId === 'claim-evidence-bridge')!;
  return { ...focus, guidanceSource: 'self_directed' as const, evidenceIds: [] };
}

function session(): PracticeSession {
  const pack = P1_MODE_PACKS.find((candidate) => candidate.id === 'argument-rebuttal')!;
  const task = pack.tasks.find((candidate) => candidate.id === 'ai-assistant-decisions')!;
  const focus = selectedFocus();
  const base = createPracticeSession({
    id: 'session-cloud-comparison',
    modeVersion: pack.version,
    task,
    now: at,
  });
  const attempts = (['initial', 'retry'] as const).map((kind) => ({
    id: `stored-attempt-${kind}`,
    sessionId: base.id,
    kind,
    status: 'confirmed' as const,
    audioRef: `audio/${kind}.webm`,
    mimeType: 'audio/webm',
    durationMs: 8_000,
    byteLength: 1_024,
    createdAt: at,
    updatedAt: at,
    confirmedAt: at,
  }));
  return PracticeSessionSchema.parse({
    ...base,
    status: 'comparison',
    guidanceSource: 'self_directed',
    focus: {
      criterionId: focus.criterionId,
      drillId: focus.drillId,
      label: focus.criterionLabel,
      guidanceSource: 'self_directed',
      evidenceIds: [],
      selectedAt: at,
    },
    drillCompletedAt: at,
    attempts,
  });
}

function payload(corrections: readonly TranscriptCorrection[] = []) {
  const focus = selectedFocus();
  return buildSemanticComparisonPayload({
    session: session(),
    initial: snapshot('initial'),
    retry: snapshot('retry'),
    criterionId: focus.criterionId,
    label: focus.criterionLabel,
    drillId: focus.drillId,
    corrections,
    analysisInputId: 'analysis-cloud-comparison',
  });
}

describe('cloud semantic comparison boundary', () => {
  it('builds from both frozen finals, traceable corrections, one persisted focus and paired metrics', () => {
    const initial = snapshot('initial');
    const correction: TranscriptCorrection = {
      id: 'correction-initial-1',
      snapshotId: initial.id,
      segmentId: initial.finalSegments[0]!.id,
      originalText: initial.finalSegments[0]!.text,
      correctedText: '我的主张是谨慎处理。',
      createdAt: at,
    };
    const built = payload([correction]);

    expect(built).toMatchObject({
      protocolVersion: 'paired-1',
      focus: {
        version: 1,
        criterionId: selectedFocus().criterionId,
        drillId: selectedFocus().drillId,
      },
      initial: { snapshotId: initial.id, transcriptVersion: 2 },
      retry: { snapshotId: snapshot('retry').id, transcriptVersion: 1 },
    });
    expect(built.initial.finalSegments[0]?.text).toBe('我的主张是谨慎处理。');
    expect(built.initial.metrics.words).toBeGreaterThan(0);
  });

  it('allows deliberate redaction but rejects frozen identity, focus, timing and metric rewrites', () => {
    const original = payload();
    const redacted = structuredClone(original);
    redacted.task.sourceMaterial = '';
    redacted.initial.localEvidence = [];
    expect(parseEditedComparisonPayload(JSON.stringify(redacted), original).task.sourceMaterial).toBe('');

    const changedFocus = structuredClone(original);
    changedFocus.focus.label = '另一个焦点';
    expect(() => parseEditedComparisonPayload(JSON.stringify(changedFocus), original)).toThrow('AI_PAYLOAD_IDENTITY_CHANGED');

    const changedMetric = structuredClone(original);
    changedMetric.initial.metrics.hedges = 99;
    expect(() => parseEditedComparisonPayload(JSON.stringify(changedMetric), original)).toThrow('AI_PAYLOAD_IDENTITY_CHANGED');

    const changedTiming = structuredClone(original);
    changedTiming.retry.finalSegments[0]!.startMs = 20;
    expect(() => parseEditedComparisonPayload(JSON.stringify(changedTiming), original)).toThrow('AI_PAYLOAD_IDENTITY_CHANGED');
  });

  it('persists an exact-consent lifecycle and cannot attach the result to another focus', () => {
    const approvedPayload = payload();
    const queued = createQueuedCloudSemanticComparison({
      payload: approvedPayload,
      payloadHash: 'a'.repeat(64),
      consentId: 'consent-comparison-1',
      at,
    });
    const processing = transitionCloudSemanticComparison(queued, {
      status: 'processing',
      at: '2026-07-18T06:00:01.000Z',
    });
    const complete = transitionCloudSemanticComparison(processing, {
      status: 'complete',
      at: '2026-07-18T06:00:02.000Z',
      result: {
        result: 'improved',
        explanation: '复讲把主张和依据连接得更明确。',
        initialEvidence: ['初讲用“可能”弱化了主张。'],
        retryEvidence: ['复讲明确使用“因为”连接主张与依据。'],
      },
    });

    expect(complete.lifecycle.map((entry) => entry.status)).toEqual(['queued', 'processing', 'complete']);
    expect(PracticeArtifactSchema.parse({
      type: 'cloud_semantic_comparison',
      sessionId: approvedPayload.sessionId,
      id: 'cloud-comparison-artifact-1',
      payload: complete,
    })).toMatchObject({ type: 'cloud_semantic_comparison', payload: { status: 'complete' } });

    expect(() => CloudSemanticComparisonArtifactSchema.parse({
      ...complete,
      criterionId: 'another-focus',
    })).toThrow(/exact approved payload/);

    expect(() => transitionCloudSemanticComparison(complete, {
      status: 'processing',
      at: '2026-07-18T06:00:03.000Z',
      result: null,
    })).toThrow(/illegal cloud comparison transition/);
    expect(() => transitionCloudSemanticComparison(complete, {
      status: 'superseded',
      at: '2026-07-18T06:00:03.000Z',
      result: null,
      supersededReason: 'comparison_payload_changed',
    })).toThrow(/must retain its provider result/);
  });
});
