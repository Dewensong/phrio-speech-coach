// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AudioRepository } from '../../src/backend/repositories/audio-repository';
import { SessionRepository } from '../../src/backend/repositories/session-repository';
import { PracticeSessionService } from '../../src/backend/services/practice-session-service';
import {
  buildDeepDiagnosisPayload,
  buildSemanticComparisonPayload,
  compareFrozenAttempts,
  buildLocalDeepReport,
  createQueuedCloudDeepDiagnosis,
  createQueuedCloudSemanticComparison,
  deriveLocalDeepReportId,
  listFrozenPracticeFocusOptions,
  transitionCloudDeepDiagnosis,
  transitionCloudSemanticComparison,
  type Attempt,
  type AttemptSnapshot,
  type DeepReport,
  type DrillCompletion,
  type PracticeSession,
  type TranscriptCorrection,
} from '../../src/shared';

const CREATED_AT = '2026-07-18T08:00:00.000Z';
const UPDATED_AT = '2026-07-18T08:00:01.000Z';

let root: string;
let sessions: SessionRepository;
let service: PracticeSessionService;
let nextSessionOrdinal: number;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'phrio-artifact-identity-'));
  sessions = new SessionRepository(path.join(root, 'phrio.sqlite3'));
  service = new PracticeSessionService(
    sessions,
    new AudioRepository(path.join(root, 'temporary-audio')),
    {
      createId: () => `session-identity-${++nextSessionOrdinal}`,
      now: () => new Date(UPDATED_AT),
    },
  );
  nextSessionOrdinal = 0;
  await service.initialize();
});

afterEach(async () => {
  sessions.close();
  await rm(root, { recursive: true, force: true });
});

function createSession(): PracticeSession {
  return service.createSession({
    modeId: 'decision-alignment',
    taskId: 'freeze-new-requirements',
    developmentFixture: false,
  });
}

function attempt(sessionId: string, kind: 'initial' | 'retry'): Attempt {
  return {
    id: `${sessionId}-${kind}-attempt`,
    sessionId,
    kind,
    status: 'confirmed',
    audioRef: null,
    mimeType: 'audio/webm',
    durationMs: 30_000,
    byteLength: 3,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    confirmedAt: UPDATED_AT,
  };
}

function snapshot(
  sessionId: string,
  kind: 'initial' | 'retry',
  focusVersion: number | null = kind === 'retry' ? 1 : null,
): AttemptSnapshot {
  const attemptId = `${sessionId}-${kind}-attempt`;
  const id = `${sessionId}-${kind}-snapshot`;
  const segmentId = `${attemptId}-segment`;
  return {
    schemaVersion: 1,
    id,
    sessionId,
    attemptId,
    generation: kind === 'initial' ? 1 : 2,
    kind,
    frozenAt: UPDATED_AT,
    audioWatermark: 3_000,
    transcriptVersion: 1,
    finalSegments: [{
      id: segmentId,
      attemptId,
      sequence: 0,
      revision: 1,
      text: '嗯，我们先明确本周的决定。',
      startMs: 0,
      endMs: 3_000,
      confidence: null,
      isFinal: true,
      emittedAt: UPDATED_AT,
      finalizedAt: UPDATED_AT,
      modelVersion: 'identity-test-1',
    }],
    annotations: [{
      id: `${id}-annotation`,
      displayId: 'O1',
      segmentId,
      type: 'filler',
      sourceSpan: { start: 0, end: 1, text: '嗯' },
      evidence: '句首出现填充词“嗯”',
      suggestion: '直接说出本周决定',
      source: 'local_rule',
      lifecycle: 'confirmed',
      algorithmVersion: 'local-rules-1',
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      withdrawnReason: null,
    }],
    hints: [],
    metrics: {
      finalCharacters: 14,
      finalSegments: 1,
      fillers: 1,
      hedges: 0,
      vagueWords: 0,
      repetitions: 0,
      selfCorrections: 0,
      algorithmVersion: 'local-rules-1',
    },
    focusVersion,
  };
}

function readySession(created: PracticeSession): {
  readonly session: PracticeSession;
  readonly criterionId: string;
  readonly drillId: string;
} {
  const mapping = created.taskSnapshot.focusDrillMappings[0]!;
  const criterion = created.taskSnapshot.rubricSnapshot!.find(
    (candidate) => candidate.id === mapping.criterionId,
  )!;
  const drill = created.taskSnapshot.drillSnapshot!.find(
    (candidate) => candidate.id === mapping.drillIds[0],
  )!;
  const prepared = sessions.updateSession({
    ...created,
    status: 'comparison',
    guidanceSource: 'self_directed',
    focus: {
      criterionId: criterion.id,
      drillId: drill.id,
      label: criterion.label,
      guidanceSource: 'self_directed',
      evidenceIds: [],
      selectedAt: UPDATED_AT,
    },
    drillCompletedAt: UPDATED_AT,
    attempts: [attempt(created.id, 'initial'), attempt(created.id, 'retry')],
    updatedAt: UPDATED_AT,
  });
  return { session: prepared, criterionId: criterion.id, drillId: drill.id };
}

function persistSnapshot(value: AttemptSnapshot): void {
  service.putArtifact({
    type: 'attempt_snapshot',
    sessionId: value.sessionId,
    id: value.id,
    payload: value,
  });
}

function drillCompletion(input: {
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly criterionId: string;
  readonly drillId: string;
  readonly focusVersion?: number;
}): DrillCompletion {
  return {
    id: `${input.sessionId}-drill-completion`,
    snapshotId: input.snapshotId,
    focusVersion: input.focusVersion ?? 1,
    criterionId: input.criterionId,
    drillId: input.drillId,
    rehearsalNote: '',
    selfChecked: true,
    startedAt: CREATED_AT,
    completedAt: UPDATED_AT,
    durationMs: 1_000,
  };
}

describe('PracticeSessionService ordinary artifact reference graph', () => {
  it('rejects focus selection until a complete report matches the current correction version', async () => {
    const created = createSession();
    const initial = snapshot(created.id, 'initial');
    const prepared = sessions.updateSession({
      ...created,
      status: 'focus',
      attempts: [attempt(created.id, 'initial')],
      updatedAt: UPDATED_AT,
    });
    persistSnapshot(initial);
    const option = listFrozenPracticeFocusOptions(prepared.taskSnapshot, prepared.modeVersion)[0]!;
    const focusEvent = (diagnosisReportId: string) => ({
      type: 'select_focus' as const,
      diagnosisReportId,
      focus: {
        criterionId: option.criterionId,
        drillId: option.drillId,
        label: option.criterionLabel,
        guidanceSource: 'self_directed' as const,
        evidenceIds: [],
      },
    });
    await expect(service.transitionSession(
      created.id,
      focusEvent('missing-report'),
    )).rejects.toMatchObject({
      code: 'CURRENT_DEEP_REPORT_REQUIRED',
    });

    const reportFocus = {
      criterionId: option.criterionId,
      label: option.criterionLabel,
      drillId: option.drillId,
      drill: option.drillTemplate,
    };
    const report = buildLocalDeepReport({
      id: `${created.id}-current-report`,
      snapshot: initial,
      at: UPDATED_AT,
      focus: reportFocus,
    });
    service.putArtifact({ type: 'deep_report', sessionId: created.id, id: report.id, payload: report });
    const correction: TranscriptCorrection = {
      id: `${created.id}-late-correction`,
      snapshotId: initial.id,
      segmentId: initial.finalSegments[0]!.id,
      originalText: initial.finalSegments[0]!.text,
      correctedText: '我们先明确本周的决定。',
      createdAt: '2026-07-18T08:00:02.000Z',
    };
    service.putArtifact({
      type: 'transcript_correction',
      sessionId: created.id,
      id: correction.id,
      payload: correction,
    });
    await expect(service.transitionSession(
      created.id,
      focusEvent(report.id),
    )).rejects.toMatchObject({
      code: 'CURRENT_DEEP_REPORT_REQUIRED',
    });

    const currentReport = buildLocalDeepReport({
      id: `${created.id}-corrected-report`,
      snapshot: initial,
      corrections: [correction],
      at: '2026-07-18T08:00:03.000Z',
      focus: reportFocus,
    });
    service.putArtifact({
      type: 'deep_report',
      sessionId: created.id,
      id: currentReport.id,
      payload: currentReport,
    });
    await expect(service.transitionSession(
      created.id,
      focusEvent(currentReport.id),
    )).resolves.toMatchObject({
      status: 'drill',
      diagnosisReportId: currentReport.id,
    });
  });
  it('allows the production snapshot-before-audio order but rejects Session and attempt injection', () => {
    const first = createSession();
    const second = createSession();
    const pending = snapshot(first.id, 'initial');

    expect(service.putArtifact({
      type: 'attempt_snapshot',
      sessionId: first.id,
      id: pending.id,
      payload: pending,
    })).toEqual(expect.objectContaining({ id: pending.id }));

    // Even after an attacker rewrites the payload's self-reported sessionId,
    // the persisted foreign attempt identity remains owned by the first Session.
    const crossSession = {
      ...pending,
      id: `${second.id}-injected-snapshot`,
      sessionId: second.id,
    };
    expect(() => service.putArtifact({
      type: 'attempt_snapshot',
      sessionId: second.id,
      id: crossSession.id,
      payload: crossSession,
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_MISMATCH' }));

    expect(() => service.putArtifact({
      type: 'attempt_snapshot',
      sessionId: first.id,
      id: pending.id,
      payload: {
        ...pending,
        finalSegments: pending.finalSegments.map((segment) => ({
          ...segment,
          text: '同一冻结快照身份不能改写逐字稿。',
        })),
      },
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_IDENTITY_MISMATCH' }));

    const preparedSecond = readySession(second).session;
    const wrongAttempt = {
      ...snapshot(preparedSecond.id, 'initial'),
      attemptId: pending.attemptId,
      finalSegments: snapshot(preparedSecond.id, 'initial').finalSegments.map((segment) => ({
        ...segment,
        attemptId: pending.attemptId,
      })),
    };
    expect(() => service.putArtifact({
      type: 'attempt_snapshot',
      sessionId: preparedSecond.id,
      id: wrongAttempt.id,
      payload: wrongAttempt,
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_MISMATCH' }));
  });

  it('binds transcript corrections to one stored snapshot, final segment and immutable original text', () => {
    const first = readySession(createSession());
    const second = readySession(createSession());
    const firstSnapshot = snapshot(first.session.id, 'initial');
    persistSnapshot(firstSnapshot);

    const correction: TranscriptCorrection = {
      id: `${first.session.id}-correction`,
      snapshotId: firstSnapshot.id,
      segmentId: firstSnapshot.finalSegments[0]!.id,
      originalText: firstSnapshot.finalSegments[0]!.text,
      correctedText: '我们先明确本周的决定。',
      createdAt: UPDATED_AT,
    };
    expect(service.putArtifact({
      type: 'transcript_correction',
      sessionId: first.session.id,
      id: correction.id,
      payload: correction,
    })).toEqual(expect.objectContaining({ id: correction.id }));

    expect(() => service.putArtifact({
      type: 'transcript_correction',
      sessionId: first.session.id,
      id: correction.id,
      payload: { ...correction, correctedText: '用同一 ID 篡改纠正内容。' },
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_IDENTITY_MISMATCH' }));

    expect(() => service.putArtifact({
      type: 'transcript_correction',
      sessionId: second.session.id,
      id: `${second.session.id}-cross-correction`,
      payload: { ...correction, id: `${second.session.id}-cross-correction` },
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_NOT_FOUND' }));
    expect(() => service.putArtifact({
      type: 'transcript_correction',
      sessionId: first.session.id,
      id: `${first.session.id}-wrong-segment`,
      payload: {
        ...correction,
        id: `${first.session.id}-wrong-segment`,
        segmentId: 'missing-final-segment',
      },
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_NOT_FOUND' }));
    expect(() => service.putArtifact({
      type: 'transcript_correction',
      sessionId: first.session.id,
      id: `${first.session.id}-wrong-original`,
      payload: {
        ...correction,
        id: `${first.session.id}-wrong-original`,
        originalText: '另一条原句',
      },
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_MISMATCH' }));
  });

  it('rejects report evidence, Rubric and focus references outside the frozen snapshot and task', () => {
    const prepared = readySession(createSession());
    const initial = snapshot(prepared.session.id, 'initial');
    persistSnapshot(initial);
    const criterion = prepared.session.taskSnapshot.rubricSnapshot!.find(
      (candidate) => candidate.id === prepared.criterionId,
    )!;
    const drill = prepared.session.taskSnapshot.drillSnapshot!.find(
      (candidate) => candidate.id === prepared.drillId,
    )!;
    const report: DeepReport = buildLocalDeepReport({
      id: `${prepared.session.id}-report`,
      snapshot: initial,
      at: UPDATED_AT,
      focus: {
        criterionId: criterion.id,
        label: criterion.label,
        drillId: drill.id,
        drill: drill.template,
      },
    });
    expect(service.putArtifact({
      type: 'deep_report',
      sessionId: prepared.session.id,
      id: report.id,
      payload: report,
    })).toEqual(expect.objectContaining({ id: report.id }));

    expect(service.putArtifact({
      type: 'deep_report',
      sessionId: prepared.session.id,
      id: report.id,
      payload: report,
    })).toEqual(expect.objectContaining({ payload: report }));

    const rollbackPayloads: readonly DeepReport[] = [
      {
        ...report,
        status: 'queued',
        rubricCriterionId: null,
        evidenceIds: [],
        judgment: '',
        focus: null,
      },
      {
        ...report,
        status: 'failed',
        rubricCriterionId: null,
        evidenceIds: [],
        judgment: '',
        focus: null,
        error: 'late worker rollback',
      },
      { ...report, focus: null },
      { ...report, judgment: '' },
      { ...report, evidenceIds: [] },
    ];
    for (const rollback of rollbackPayloads) {
      expect(() => service.putArtifact({
        type: 'deep_report',
        sessionId: prepared.session.id,
        id: report.id,
        payload: rollback,
      })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_IDENTITY_MISMATCH' }));
    }
    expect(service.listArtifacts(prepared.session.id).find(
      (artifact) => artifact.type === 'deep_report' && artifact.id === report.id,
    )).toEqual(expect.objectContaining({ payload: report }));

    expect(() => service.putArtifact({
      type: 'deep_report',
      sessionId: prepared.session.id,
      id: `${report.id}-forged-judgment`,
      payload: {
        ...report,
        id: `${report.id}-forged-judgment`,
        judgment: '引用合法 O 编号但伪造了最终诊断。',
      },
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_MISMATCH' }));

    expect(() => service.putArtifact({
      type: 'deep_report',
      sessionId: prepared.session.id,
      id: `${report.id}-bad-evidence`,
      payload: { ...report, id: `${report.id}-bad-evidence`, evidenceIds: ['foreign-evidence'] },
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_MISMATCH' }));
    expect(() => service.putArtifact({
      type: 'deep_report',
      sessionId: prepared.session.id,
      id: `${report.id}-bad-focus`,
      payload: {
        ...report,
        id: `${report.id}-bad-focus`,
        rubricCriterionId: 'foreign-criterion',
        focus: report.focus ? { ...report.focus, criterionId: 'foreign-criterion' } : null,
      },
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_MISMATCH' }));
  });

  it('persists separate immutable reports for separate frozen focus inputs with stable ids', async () => {
    const prepared = readySession(createSession());
    const initial = snapshot(prepared.session.id, 'initial');
    persistSnapshot(initial);
    const options = listFrozenPracticeFocusOptions(
      prepared.session.taskSnapshot,
      prepared.session.modeVersion,
    );
    const first = options[0]!;
    const second = options.find((option) => (
      option.criterionId !== first.criterionId || option.drillId !== first.drillId
    ))!;
    const reportFor = async (focus: typeof first) => {
      const id = await deriveLocalDeepReportId({
        snapshotId: initial.id,
        transcriptVersion: initial.transcriptVersion,
        criterionId: focus.criterionId,
        drillId: focus.drillId,
      });
      return buildLocalDeepReport({
        id,
        snapshot: initial,
        at: UPDATED_AT,
        focus: {
          criterionId: focus.criterionId,
          label: focus.criterionLabel,
          drillId: focus.drillId,
          drill: focus.drillTemplate,
        },
      });
    };
    const firstReport = await reportFor(first);
    const secondReport = await reportFor(second);

    expect(firstReport.id).toMatch(/^deep-report-[a-f0-9]{64}$/);
    expect(secondReport.id).toMatch(/^deep-report-[a-f0-9]{64}$/);
    expect(secondReport.id).not.toBe(firstReport.id);
    await expect(deriveLocalDeepReportId({
      snapshotId: initial.id,
      transcriptVersion: initial.transcriptVersion + 1,
      criterionId: first.criterionId,
      drillId: first.drillId,
    })).resolves.not.toBe(firstReport.id);
    await expect(reportFor(first)).resolves.toMatchObject({ id: firstReport.id });
    for (const report of [firstReport, secondReport]) {
      service.putArtifact({
        type: 'deep_report',
        sessionId: prepared.session.id,
        id: report.id,
        payload: report,
      });
    }

    const stored = service.listArtifacts(prepared.session.id).filter(
      (artifact) => artifact.type === 'deep_report',
    );
    expect(stored).toHaveLength(2);
    expect(stored.map((artifact) => artifact.id)).toEqual(expect.arrayContaining([
      firstReport.id,
      secondReport.id,
    ]));
    expect(service.putArtifact({
      type: 'deep_report',
      sessionId: prepared.session.id,
      id: firstReport.id,
      payload: firstReport,
    })).toEqual(expect.objectContaining({ payload: firstReport }));
  });

  it('ties Drill and comparison references to the persisted attempts and selected focus', () => {
    const prepared = readySession(createSession());
    const initial = snapshot(prepared.session.id, 'initial');
    const retry = snapshot(prepared.session.id, 'retry');
    persistSnapshot(initial);
    persistSnapshot(retry);

    const completion = drillCompletion({
      sessionId: prepared.session.id,
      snapshotId: initial.id,
      criterionId: prepared.criterionId,
      drillId: prepared.drillId,
    });
    expect(service.putArtifact({
      type: 'drill_completion',
      sessionId: prepared.session.id,
      id: completion.id,
      payload: completion,
    })).toEqual(expect.objectContaining({ id: completion.id }));

    expect(() => service.putArtifact({
      type: 'drill_completion',
      sessionId: prepared.session.id,
      id: `${completion.id}-retry`,
      payload: { ...completion, id: `${completion.id}-retry`, snapshotId: retry.id },
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_MISMATCH' }));

    const criterion = prepared.session.taskSnapshot.rubricSnapshot!.find(
      (candidate) => candidate.id === prepared.criterionId,
    )!;
    const comparison = compareFrozenAttempts({
      id: `${prepared.session.id}-comparison`,
      initial,
      retry,
      criterionId: prepared.criterionId,
      comparisonDimension: criterion.comparisonDimension,
      at: UPDATED_AT,
    });
    expect(service.putArtifact({
      type: 'attempt_comparison',
      sessionId: prepared.session.id,
      id: comparison.id,
      payload: comparison,
    })).toEqual(expect.objectContaining({ id: comparison.id }));

    expect(() => service.putArtifact({
      type: 'attempt_comparison',
      sessionId: prepared.session.id,
      id: `${comparison.id}-forged-result`,
      payload: {
        ...comparison,
        id: `${comparison.id}-forged-result`,
        result: comparison.result === 'improved' ? 'regressed' : 'improved',
        explanation: '引用合法冻结身份但伪造了比较结论。',
      },
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_MISMATCH' }));

    expect(() => service.putArtifact({
      type: 'attempt_comparison',
      sessionId: prepared.session.id,
      id: `${comparison.id}-bad-evidence`,
      payload: {
        ...comparison,
        id: `${comparison.id}-bad-evidence`,
        initialEvidenceIds: ['retry-or-foreign-evidence'],
      },
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_MISMATCH' }));

    const mismatched = readySession(createSession());
    const mismatchedInitial = snapshot(mismatched.session.id, 'initial');
    const movedRetry = snapshot(mismatched.session.id, 'retry', 2);
    persistSnapshot(mismatchedInitial);
    persistSnapshot(movedRetry);
    const mismatchedDrill = drillCompletion({
      sessionId: mismatched.session.id,
      snapshotId: mismatchedInitial.id,
      criterionId: mismatched.criterionId,
      drillId: mismatched.drillId,
      focusVersion: 1,
    });
    service.putArtifact({
      type: 'drill_completion',
      sessionId: mismatched.session.id,
      id: mismatchedDrill.id,
      payload: mismatchedDrill,
    });
    const mismatchedCriterion = mismatched.session.taskSnapshot.rubricSnapshot!.find(
      (candidate) => candidate.id === mismatched.criterionId,
    )!;
    const mismatchedComparison = compareFrozenAttempts({
      id: `${mismatched.session.id}-comparison`,
      initial: mismatchedInitial,
      retry: movedRetry,
      criterionId: mismatched.criterionId,
      comparisonDimension: mismatchedCriterion.comparisonDimension,
      at: UPDATED_AT,
    });
    expect(() => service.putArtifact({
      type: 'attempt_comparison',
      sessionId: mismatched.session.id,
      id: mismatchedComparison.id,
      payload: mismatchedComparison,
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_MISMATCH' }));
  });

  it('binds cloud payloads to the frozen graph and only supersedes after real drift', () => {
    const prepared = readySession(createSession());
    const initial = snapshot(prepared.session.id, 'initial');
    persistSnapshot(initial);
    const payload = buildDeepDiagnosisPayload({
      session: prepared.session,
      snapshot: initial,
      corrections: [],
      analysisInputId: 'analysis-authority',
    });
    const queued = createQueuedCloudDeepDiagnosis({
      payload,
      payloadHash: 'a'.repeat(64),
      consentId: 'consent-authority',
      at: UPDATED_AT,
    });
    const artifact = {
      type: 'cloud_deep_diagnosis' as const,
      sessionId: prepared.session.id,
      id: 'cloud-deep-analysis-authority',
      payload: queued,
    };
    expect(service.putArtifact(artifact)).toMatchObject({ id: artifact.id });

    const forgedPayload = structuredClone(payload);
    forgedPayload.finalSegments[0]!.startMs += 1;
    const forgedQueued = createQueuedCloudDeepDiagnosis({
      payload: { ...forgedPayload, analysisInputId: 'analysis-forged-projection' },
      payloadHash: 'b'.repeat(64),
      consentId: 'consent-forged-projection',
      at: UPDATED_AT,
    });
    expect(() => service.putArtifact({
      type: 'cloud_deep_diagnosis',
      sessionId: prepared.session.id,
      id: 'cloud-deep-analysis-forged-projection',
      payload: forgedQueued,
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_MISMATCH' }));

    const prematureSupersede = transitionCloudDeepDiagnosis(queued, {
      status: 'superseded',
      at: '2026-07-18T08:00:02.000Z',
    });
    expect(() => service.putArtifact({ ...artifact, payload: prematureSupersede }))
      .toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_MISMATCH' }));

    const correction: TranscriptCorrection = {
      id: `${prepared.session.id}-cloud-drift-correction`,
      snapshotId: initial.id,
      segmentId: initial.finalSegments[0]!.id,
      originalText: initial.finalSegments[0]!.text,
      correctedText: '我们先明确本周的决定。',
      createdAt: '2026-07-18T08:00:02.000Z',
    };
    service.putArtifact({
      type: 'transcript_correction',
      sessionId: prepared.session.id,
      id: correction.id,
      payload: correction,
    });
    expect(service.putArtifact({ ...artifact, payload: prematureSupersede }))
      .toMatchObject({ payload: { status: 'superseded' } });
  });

  it('allows an abandoned Session to terminalize an existing cloud lifecycle but not create a new one', async () => {
    const prepared = readySession(createSession());
    const initial = snapshot(prepared.session.id, 'initial');
    persistSnapshot(initial);
    const payload = buildDeepDiagnosisPayload({
      session: prepared.session,
      snapshot: initial,
      corrections: [],
      analysisInputId: 'analysis-abandoned-existing',
    });
    const queued = createQueuedCloudDeepDiagnosis({
      payload,
      payloadHash: 'e'.repeat(64),
      consentId: 'consent-abandoned-existing',
      at: UPDATED_AT,
    });
    const artifact = {
      type: 'cloud_deep_diagnosis' as const,
      sessionId: prepared.session.id,
      id: 'cloud-deep-analysis-abandoned-existing',
      payload: queued,
    };
    service.putArtifact(artifact);
    await service.transitionSession(prepared.session.id, { type: 'abandon' });

    const processing = transitionCloudDeepDiagnosis(queued, {
      status: 'processing',
      at: '2026-07-18T08:00:02.000Z',
    });
    expect(service.putArtifact({ ...artifact, payload: processing })).toMatchObject({
      payload: { status: 'processing' },
    });
    const failed = transitionCloudDeepDiagnosis(processing, {
      status: 'failed',
      at: '2026-07-18T08:00:03.000Z',
      errorCode: 'request_cancelled',
    });
    expect(service.putArtifact({ ...artifact, payload: failed })).toMatchObject({
      payload: { status: 'failed' },
    });

    const newPayload = buildDeepDiagnosisPayload({
      session: prepared.session,
      snapshot: initial,
      corrections: [],
      analysisInputId: 'analysis-abandoned-new',
    });
    const newQueued = createQueuedCloudDeepDiagnosis({
      payload: newPayload,
      payloadHash: 'f'.repeat(64),
      consentId: 'consent-abandoned-new',
      at: '2026-07-18T08:00:04.000Z',
    });
    expect(() => service.putArtifact({
      type: 'cloud_deep_diagnosis',
      sessionId: prepared.session.id,
      id: 'cloud-deep-analysis-abandoned-new',
      payload: newQueued,
    })).toThrowError(expect.objectContaining({ code: 'SESSION_ARTIFACTS_FROZEN' }));
  });

  it('allows only one comparison artifact identity per approved analysis input', () => {
    const prepared = readySession(createSession());
    const initial = snapshot(prepared.session.id, 'initial');
    const retry = snapshot(prepared.session.id, 'retry');
    persistSnapshot(initial);
    persistSnapshot(retry);
    const criterion = prepared.session.taskSnapshot.rubricSnapshot!.find(
      (candidate) => candidate.id === prepared.criterionId,
    )!;
    const payload = buildSemanticComparisonPayload({
      session: prepared.session,
      initial,
      retry,
      criterionId: prepared.criterionId,
      label: criterion.label,
      drillId: prepared.drillId,
      corrections: [],
      analysisInputId: 'analysis-comparison-authority',
    });
    const first = createQueuedCloudSemanticComparison({
      payload,
      payloadHash: 'a'.repeat(64),
      consentId: 'consent-comparison-authority-a',
      at: UPDATED_AT,
    });
    service.putArtifact({
      type: 'cloud_semantic_comparison',
      sessionId: prepared.session.id,
      id: 'analysis-comparison-authority-consent-comparison-authority-a',
      payload: first,
    });
    const duplicate = createQueuedCloudSemanticComparison({
      payload,
      payloadHash: 'b'.repeat(64),
      consentId: 'consent-comparison-authority-b',
      at: UPDATED_AT,
    });
    expect(() => service.putArtifact({
      type: 'cloud_semantic_comparison',
      sessionId: prepared.session.id,
      id: 'analysis-comparison-authority-consent-comparison-authority-b',
      payload: duplicate,
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_IDENTITY_MISMATCH' }));
  });

  it('terminalizes queued and processing cloud artifacts before consent reset', () => {
    const prepared = readySession(createSession());
    const initial = snapshot(prepared.session.id, 'initial');
    const retry = snapshot(prepared.session.id, 'retry');
    persistSnapshot(initial);
    persistSnapshot(retry);

    const deepPayload = buildDeepDiagnosisPayload({
      session: prepared.session,
      snapshot: initial,
      corrections: [],
      analysisInputId: 'analysis-reset-deep',
    });
    const deepQueued = createQueuedCloudDeepDiagnosis({
      payload: deepPayload,
      payloadHash: 'c'.repeat(64),
      consentId: 'consent-reset-deep',
      at: UPDATED_AT,
    });
    service.putArtifact({
      type: 'cloud_deep_diagnosis',
      sessionId: prepared.session.id,
      id: 'cloud-deep-analysis-reset-deep',
      payload: deepQueued,
    });

    const criterion = prepared.session.taskSnapshot.rubricSnapshot!.find(
      (candidate) => candidate.id === prepared.criterionId,
    )!;
    const comparisonPayload = buildSemanticComparisonPayload({
      session: prepared.session,
      initial,
      retry,
      criterionId: prepared.criterionId,
      label: criterion.label,
      drillId: prepared.drillId,
      corrections: [],
      analysisInputId: 'analysis-reset-comparison',
    });
    const comparisonQueued = createQueuedCloudSemanticComparison({
      payload: comparisonPayload,
      payloadHash: 'd'.repeat(64),
      consentId: 'consent-reset-comparison',
      at: UPDATED_AT,
    });
    const comparisonProcessing = transitionCloudSemanticComparison(comparisonQueued, {
      status: 'processing',
      at: '2026-07-18T08:00:02.000Z',
    });
    const comparisonId = 'analysis-reset-comparison-consent-reset-comparison';
    service.putArtifact({
      type: 'cloud_semantic_comparison',
      sessionId: prepared.session.id,
      id: comparisonId,
      payload: comparisonQueued,
    });
    service.putArtifact({
      type: 'cloud_semantic_comparison',
      sessionId: prepared.session.id,
      id: comparisonId,
      payload: comparisonProcessing,
    });

    expect(service.supersedePendingCloudArtifactsForConsentReset()).toBe(2);
    const cloudArtifacts = service.listArtifacts(prepared.session.id).filter(
      (artifact) => artifact.type === 'cloud_deep_diagnosis'
        || artifact.type === 'cloud_semantic_comparison',
    );
    expect(cloudArtifacts).toHaveLength(2);
    expect(cloudArtifacts.map((artifact) => ({
      type: artifact.type,
      status: artifact.payload.status,
      reason: artifact.payload.supersededReason,
      lifecycle: artifact.payload.lifecycle.at(-1)?.status,
    })).sort((left, right) => left.type.localeCompare(right.type))).toEqual([
      {
        type: 'cloud_deep_diagnosis',
        status: 'superseded',
        reason: 'consent_reset',
        lifecycle: 'superseded',
      },
      {
        type: 'cloud_semantic_comparison',
        status: 'superseded',
        reason: 'consent_reset',
        lifecycle: 'superseded',
      },
    ]);
    expect(service.supersedePendingCloudArtifactsForConsentReset()).toBe(0);
  });
});
