import { describe, expect, it } from 'vitest';

import {
  P1_MODE_PACKS,
  buildLocalDeepReport,
  compareFrozenAttempts,
  createTranscriptCorrectionId,
  evidenceForDeepLane,
  getPrimaryPracticeFocus,
  listPracticeFocusOptions,
  metricsForDeepLane,
  selectAttemptSnapshot,
  transcriptForDeepLane,
  transcriptVersionForDeepLane,
  type AttemptSnapshot,
  type CriterionComparisonDimension,
  type LiveAnnotationType,
} from '../../src/shared';

const at = '2026-07-17T04:00:00.000Z';
function snapshot(kind: 'initial' | 'retry', fillers: number): AttemptSnapshot {
  return {
    schemaVersion: 1, id: `snapshot-${kind}`, sessionId: 'session-1', attemptId: `attempt-${kind}`,
    generation: 1, kind, frozenAt: at, audioWatermark: 9_000, transcriptVersion: 1,
    finalSegments: [{ id: `attempt-${kind}-seg-0`, attemptId: `attempt-${kind}`, sequence: 0, revision: 1, text: kind === 'initial' ? '嗯，可能后面再确认。' : '本周冻结新增需求。', startMs: 0, endMs: 4_000, confidence: null, isFinal: true, emittedAt: at, finalizedAt: at, modelVersion: 'test-1' }],
    annotations: [], hints: [], focusVersion: 1,
    metrics: { finalCharacters: 10, finalSegments: 1, fillers, hedges: kind === 'initial' ? 1 : 0, vagueWords: kind === 'initial' ? 1 : 0, repetitions: 0, selfCorrections: 0, algorithmVersion: 'local-rules-1' },
  };
}

function withAnnotation(
  snapshotInput: AttemptSnapshot,
  type: LiveAnnotationType,
  algorithmVersion = 'local-rules-1',
): AttemptSnapshot {
  return {
    ...snapshotInput,
    annotations: [{
      id: `${snapshotInput.attemptId}-${type}-1`,
      displayId: 'O1',
      segmentId: snapshotInput.finalSegments[0]!.id,
      type,
      sourceSpan: null,
      evidence: `冻结的 ${type} 问题证据`,
      suggestion: '围绕本轮冻结焦点复讲。',
      source: 'local_metric',
      lifecycle: 'confirmed',
      algorithmVersion,
      createdAt: at,
      updatedAt: at,
      withdrawnReason: null,
    }],
  };
}

function pairedSnapshotsForDimension(dimension: CriterionComparisonDimension): {
  readonly initial: AttemptSnapshot;
  readonly retry: AttemptSnapshot;
} {
  let initial = snapshot('initial', 0);
  const retry = snapshot('retry', 0);
  switch (dimension) {
    case 'delivery-friction':
      initial = { ...initial, metrics: { ...initial.metrics, fillers: 2, repetitions: 1 } };
      break;
    case 'vague-language':
      initial = { ...initial, metrics: { ...initial.metrics, vagueWords: 2 } };
      break;
    case 'pacing-flags':
      initial = withAnnotation(initial, 'long_pause');
      break;
    case 'structure-flags':
      initial = withAnnotation(initial, 'structure');
      break;
    case 'task-coverage-gaps':
      initial = withAnnotation(initial, 'task_gap');
      break;
    case 'task-structure-gaps':
      initial = withAnnotation(initial, 'structure');
      break;
  }
  return { initial, retry };
}

describe('Deep Lane frozen inputs', () => {
  it('reads frozen final text plus traceable correction, never mutable UI state', () => {
    const initial = snapshot('initial', 1);
    const transcript = transcriptForDeepLane(initial, [{ id: 'correction-1', snapshotId: initial.id, segmentId: initial.finalSegments[0]!.id, originalText: initial.finalSegments[0]!.text, correctedText: '本周可能冻结新增需求。', createdAt: at }]);
    expect(transcript[0]).toEqual({ segmentId: initial.finalSegments[0]!.id, originalText: '嗯，可能后面再确认。', currentText: '本周可能冻结新增需求。' });
  });

  it('selects the newest correction by timestamp even when repository events arrive out of order', () => {
    const initial = snapshot('initial', 1);
    const segment = initial.finalSegments[0]!;
    const transcript = transcriptForDeepLane(initial, [
      { id: 'correction-new', snapshotId: initial.id, segmentId: segment.id, originalText: segment.text, correctedText: '较新的纠正。', createdAt: '2026-07-17T04:02:00.000Z' },
      { id: 'correction-old', snapshotId: initial.id, segmentId: segment.id, originalText: segment.text, correctedText: '较早的纠正。', createdAt: '2026-07-17T04:01:00.000Z' },
    ]);
    expect(transcript[0]?.currentText).toBe('较新的纠正。');
  });

  it('retains an O anchor as neutral history when a correction removes its exact phrase', () => {
    const initial = snapshot('initial', 1);
    const withEvidence: AttemptSnapshot = {
      ...initial,
      annotations: [{
        id: 'annotation-1', displayId: 'O1', segmentId: initial.finalSegments[0]!.id,
        type: 'filler', sourceSpan: { start: 0, end: 1, text: '嗯' },
        evidence: '原句“嗯”', suggestion: '删除填充表达', source: 'local_rule',
        lifecycle: 'confirmed', algorithmVersion: 'local-rules-1', createdAt: at,
        updatedAt: at, withdrawnReason: null,
      }],
    };
    const correction = {
      id: 'correction-1', snapshotId: initial.id, segmentId: initial.finalSegments[0]!.id,
      originalText: initial.finalSegments[0]!.text, correctedText: '本周冻结新增需求。', createdAt: at,
    } as const;

    expect(evidenceForDeepLane(withEvidence, [correction])[0]).toMatchObject({
      currentLifecycle: 'withdrawn',
      historyReason: '逐字稿纠正后，原精确位置已不再匹配',
      annotation: { displayId: 'O1' },
    });
    expect(buildLocalDeepReport({
      id: 'report-corrected', snapshot: withEvidence, corrections: [correction], at,
    }).evidenceIds).toEqual([]);
  });

  it('neutralizes an exact O anchor when the same phrase moves to another position', () => {
    const initial = snapshot('initial', 1);
    const withEvidence: AttemptSnapshot = {
      ...initial,
      annotations: [{
        id: 'annotation-shifted', displayId: 'O1', segmentId: initial.finalSegments[0]!.id,
        type: 'filler', sourceSpan: { start: 0, end: 1, text: '嗯' },
        evidence: '原句“嗯”', suggestion: '删除填充表达', source: 'local_rule',
        lifecycle: 'confirmed', algorithmVersion: 'local-rules-1', createdAt: at,
        updatedAt: at, withdrawnReason: null,
      }],
    };
    const correction = {
      id: 'correction-shifted', snapshotId: initial.id,
      segmentId: initial.finalSegments[0]!.id, originalText: initial.finalSegments[0]!.text,
      correctedText: '今天嗯，可能后面再确认。', createdAt: at,
    } as const;

    expect(evidenceForDeepLane(withEvidence, [correction])[0]?.currentLifecycle).toBe('withdrawn');
    expect(metricsForDeepLane(withEvidence, [correction]).fillers).toBe(0);
    expect(buildLocalDeepReport({
      id: 'report-shifted', snapshot: withEvidence, corrections: [correction], at,
    })).toMatchObject({ transcriptVersion: 2, evidenceIds: [] });
  });

  it('advances versions only for corrections belonging to the referenced snapshot', () => {
    const initial = snapshot('initial', 0);
    const retry = snapshot('retry', 0);
    const correction = {
      id: 'correction-retry-only', snapshotId: retry.id,
      segmentId: retry.finalSegments[0]!.id, originalText: retry.finalSegments[0]!.text,
      correctedText: '复讲纠正。', createdAt: at,
    } as const;
    expect(transcriptVersionForDeepLane(initial, [correction])).toBe(1);
    expect(transcriptVersionForDeepLane(retry, [correction])).toBe(2);
  });

  it('selects the current Attempt snapshot and never falls back across a hard identity', () => {
    const older = snapshot('initial', 0);
    const newer: AttemptSnapshot = {
      ...older,
      id: 'snapshot-initial-new',
      attemptId: 'attempt-initial-new',
      generation: 2,
      frozenAt: '2026-07-17T04:01:00.000Z',
      finalSegments: older.finalSegments.map((segment) => ({
        ...segment,
        id: 'attempt-initial-new-seg-0',
        attemptId: 'attempt-initial-new',
      })),
    };
    const artifacts = [older, newer].map((candidate) => ({
      type: 'attempt_snapshot' as const,
      sessionId: candidate.sessionId,
      id: candidate.id,
      payload: candidate,
    }));
    expect(selectAttemptSnapshot({
      artifacts, kind: 'initial', expectedAttemptId: newer.attemptId,
    })?.id).toBe(newer.id);
    expect(selectAttemptSnapshot({
      artifacts, kind: 'initial', expectedAttemptId: 'missing-attempt',
    })).toBeNull();
    expect(selectAttemptSnapshot({ artifacts, kind: 'initial' })?.id).toBe(newer.id);
  });

  it('creates collision-resistant correction identities independent of snapshot id length', () => {
    expect(createTranscriptCorrectionId()).not.toBe(createTranscriptCorrectionId());
  });

  it('does not promote provisional legacy evidence into a formal Deep report or comparison', () => {
    const provisionalInitial: AttemptSnapshot = {
      ...withAnnotation(snapshot('initial', 0), 'task_gap'),
      annotations: withAnnotation(snapshot('initial', 0), 'task_gap').annotations.map((item) => ({
        ...item,
        lifecycle: 'provisional' as const,
      })),
    };
    expect(buildLocalDeepReport({
      id: 'report-provisional',
      snapshot: provisionalInitial,
      at,
    }).evidenceIds).toEqual([]);
    expect(compareFrozenAttempts({
      id: 'comparison-provisional',
      initial: provisionalInitial,
      retry: snapshot('retry', 0),
      criterionId: 'position-boundary',
      comparisonDimension: 'task-coverage-gaps',
      at,
    })).toMatchObject({
      result: 'insufficient_evidence',
      initialEvidenceIds: [],
      retryEvidenceIds: [],
    });
  });

  it('compares initial/retry under one criterion and one paired protocol', () => {
    const comparison = compareFrozenAttempts({
      id: 'comparison-1',
      initial: snapshot('initial', 2),
      retry: snapshot('retry', 0),
      criterionId: 'concise-delivery',
      comparisonDimension: 'delivery-friction',
      at,
    });
    expect(comparison).toMatchObject({
      result: 'improved',
      protocolVersion: 'paired-1',
      criterionId: 'concise-delivery',
      basis: {
        dimensionId: 'delivery-friction',
        initialValue: 2,
        retryValue: 0,
        comparable: true,
      },
    });
  });

  it('binds every current mode criterion to its own supported comparison dimension', () => {
    for (const pack of P1_MODE_PACKS) {
      for (const criterion of pack.criteria) {
        const dimension = criterion.comparisonDimension;
        expect(dimension, `${pack.id}/${criterion.id}`).toBeDefined();
        if (!dimension) throw new Error(`missing comparison dimension for ${criterion.id}`);
        const pair = pairedSnapshotsForDimension(dimension);
        const comparison = compareFrozenAttempts({
          id: `comparison-${criterion.id}`,
          ...pair,
          criterionId: criterion.id,
          comparisonDimension: dimension,
          at,
        });
        expect(comparison, `${pack.id}/${criterion.id}`).toMatchObject({
          criterionId: criterion.id,
          result: 'improved',
          basis: { dimensionId: dimension, comparable: true },
        });
      }
    }
  });

  it('does not substitute filler totals for argument or structure focus evidence', () => {
    const argument = P1_MODE_PACKS.find((pack) => pack.id === 'argument-rebuttal')!;
    for (const criterion of argument.criteria) {
      const comparison = compareFrozenAttempts({
        id: `comparison-unrelated-${criterion.id}`,
        initial: snapshot('initial', 8),
        retry: snapshot('retry', 0),
        criterionId: criterion.id,
        comparisonDimension: criterion.comparisonDimension,
        at,
      });
      expect(comparison, criterion.id).toMatchObject({
        result: 'insufficient_evidence',
        basis: {
          dimensionId: criterion.comparisonDimension,
          initialValue: null,
          retryValue: null,
          comparable: false,
        },
        initialEvidenceIds: [],
        retryEvidenceIds: [],
      });
      expect(comparison.explanation).toContain('不能把零条当作已达标');
    }
  });

  it('reports stable only when the selected metric dimension has equal paired evidence', () => {
    const comparison = compareFrozenAttempts({
      id: 'comparison-stable-vague',
      initial: { ...snapshot('initial', 6), metrics: { ...snapshot('initial', 6).metrics, vagueWords: 2 } },
      retry: { ...snapshot('retry', 0), metrics: { ...snapshot('retry', 0).metrics, vagueWords: 2 } },
      criterionId: 'concrete-support',
      comparisonDimension: 'vague-language',
      at,
    });
    expect(comparison).toMatchObject({
      result: 'stable',
      basis: { dimensionId: 'vague-language', initialValue: 2, retryValue: 2 },
    });
  });

  it('keeps a semantic focus insufficient when corresponding evidence is absent', () => {
    const comparison = compareFrozenAttempts({
      id: 'comparison-no-structure-evidence',
      initial: snapshot('initial', 5),
      retry: snapshot('retry', 0),
      criterionId: 'logical-order',
      comparisonDimension: 'structure-flags',
      at,
    });
    expect(comparison).toMatchObject({ result: 'insufficient_evidence' });
    expect(comparison.explanation).toContain('正式证据');
  });

  it('refuses to infer a trend when local metric versions differ', () => {
    const initial = snapshot('initial', 2);
    const retry = {
      ...snapshot('retry', 0),
      metrics: { ...snapshot('retry', 0).metrics, algorithmVersion: 'local-rules-2' },
    };
    const comparison = compareFrozenAttempts({
      id: 'comparison-version-mismatch',
      initial,
      retry,
      criterionId: 'concise-delivery',
      comparisonDimension: 'delivery-friction',
      at,
    });
    expect(comparison).toMatchObject({ result: 'insufficient_evidence' });
    expect(comparison.explanation).toContain('本地指标版本不同');
  });

  it('refuses an annotation-backed trend produced by a different algorithm version', () => {
    const comparison = compareFrozenAttempts({
      id: 'comparison-evidence-version-mismatch',
      initial: withAnnotation(snapshot('initial', 0), 'task_gap', 'local-rules-0'),
      retry: snapshot('retry', 0),
      criterionId: 'position-boundary',
      comparisonDimension: 'task-coverage-gaps',
      at,
    });
    expect(comparison).toMatchObject({ result: 'insufficient_evidence' });
    expect(comparison.explanation).toContain('算法版本不一致');
  });

  it('does not let unrelated old annotation traces invalidate frozen metric counters', () => {
    const comparison = compareFrozenAttempts({
      id: 'comparison-metric-with-old-trace',
      initial: withAnnotation(snapshot('initial', 2), 'filler', 'local-rules-0'),
      retry: snapshot('retry', 0),
      criterionId: 'concise-delivery',
      comparisonDimension: 'delivery-friction',
      at,
    });
    expect(comparison).toMatchObject({
      result: 'improved',
      initialEvidenceIds: [],
      retryEvidenceIds: [],
    });
  });

  it('builds one complete report with exactly one focus and an inline Drill', () => {
    const report = buildLocalDeepReport({ id: 'report-1', snapshot: snapshot('initial', 1), at });
    expect(report).toMatchObject({ status: 'complete', rubricCriterionId: 'decision-request' });
    expect(report.focus).toMatchObject({ label: '结论先行', drillId: 'decision-first-30s' });
    expect(report.focus?.drill).toContain('我的建议是');
  });

  it('resolves a valid mode-specific focus and Drill for every current task and free expression', () => {
    for (const pack of P1_MODE_PACKS) {
      for (const task of pack.tasks) {
        const focus = getPrimaryPracticeFocus(pack.id, task.id);
        const options = listPracticeFocusOptions(pack.id, task.id);
        expect(task.focusCandidateCriterionIds).toContain(focus.criterionId);
        expect(task.fallbackDrillIds).toContain(focus.drillId);
        expect(options.filter((option) => option.recommended)).toHaveLength(1);
        expect(options.every((option) => task.focusCandidateCriterionIds.includes(option.criterionId))).toBe(true);
        expect(focus.criterionLabel).not.toBe('');
        expect(focus.drillTemplate).not.toBe('');
      }
    }

    expect(getPrimaryPracticeFocus('clear-expression', 'free-expression')).toMatchObject({
      criterionId: 'main-point-early',
      drillId: 'main-point-one-line',
    });
  });

  it('builds Deep output with the selected mode criterion instead of a PM fallback', () => {
    const focus = getPrimaryPracticeFocus('argument-rebuttal', 'ai-assistant-decisions');
    const report = buildLocalDeepReport({
      id: 'report-argument',
      snapshot: snapshot('initial', 1),
      at,
      focus: {
        criterionId: focus.criterionId,
        label: focus.criterionLabel,
        drillId: focus.drillId,
        drill: focus.drillTemplate,
      },
    });
    expect(report).toMatchObject({
      rubricCriterionId: 'claim-evidence-bridge',
      focus: { drillId: 'claim-evidence-because', label: '论证桥完整' },
    });
  });
});
