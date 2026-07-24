// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioRepository } from '../../src/backend/repositories/audio-repository';
import { SessionRepository } from '../../src/backend/repositories/session-repository';
import { PracticeSessionService } from '../../src/backend/services/practice-session-service';
import {
  buildLocalDeepReport,
  compareFrozenAttempts,
  listFrozenPracticeFocusOptions,
  type AttemptSnapshot,
  type DeepReport,
  type DrillCompletion,
  type PracticeSession,
  type TranscriptCorrection,
} from '../../src/shared';

const BASE_AT = Date.parse('2026-07-21T08:00:00.000Z');

let root: string;
let sessions: SessionRepository;
let audio: AudioRepository;
let service: PracticeSessionService;
let clock: number;
let idOrdinal: number;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'phrio-terminal-gates-'));
  sessions = new SessionRepository(path.join(root, 'phrio.sqlite3'));
  audio = new AudioRepository(path.join(root, 'temporary-audio'));
  clock = BASE_AT;
  idOrdinal = 0;
  service = new PracticeSessionService(sessions, audio, {
    createId: () => `terminal-gate-${++idOrdinal}`,
    now: () => new Date((clock += 1_000)),
  });
  await service.initialize();
});

afterEach(async () => {
  sessions.close();
  await rm(root, { recursive: true, force: true });
});

function frozenAt(offsetSeconds: number): string {
  return new Date(BASE_AT + offsetSeconds * 1_000).toISOString();
}

function snapshotForAttempt(input: {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly kind: 'initial' | 'retry';
  readonly focusVersion: number | null;
  readonly suffix?: string;
}): AttemptSnapshot {
  const at = frozenAt(input.kind === 'initial' ? 20 : 40);
  const suffix = input.suffix ?? input.kind;
  const text = input.kind === 'initial'
    ? '我的建议是本周冻结新增需求。'
    : '我的建议是本周冻结新增需求，并明确下一步。';
  return {
    schemaVersion: 1,
    id: `${input.attemptId}-${suffix}-snapshot`,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    generation: input.kind === 'initial' ? 1 : 2,
    kind: input.kind,
    frozenAt: at,
    audioWatermark: 3_000,
    transcriptVersion: 1,
    finalSegments: [{
      id: `${input.attemptId}-${suffix}-segment`,
      attemptId: input.attemptId,
      sequence: 0,
      revision: 1,
      text,
      startMs: 0,
      endMs: 3_000,
      confidence: null,
      isFinal: true,
      emittedAt: at,
      finalizedAt: at,
      modelVersion: 'terminal-gate-test-1',
    }],
    annotations: [],
    hints: [],
    metrics: {
      finalCharacters: text.length,
      finalSegments: 1,
      fillers: 0,
      hedges: 0,
      vagueWords: 0,
      repetitions: 0,
      selfCorrections: 0,
      algorithmVersion: 'local-rules-1',
    },
    focusVersion: input.focusVersion,
  };
}

function persistSnapshot(snapshot: AttemptSnapshot): void {
  service.putArtifact({
    type: 'attempt_snapshot',
    sessionId: snapshot.sessionId,
    id: snapshot.id,
    payload: snapshot,
  });
}

type PreparedDiagnosis = {
  readonly sessionId: string;
  readonly initial: AttemptSnapshot;
  readonly report: DeepReport;
  readonly option: ReturnType<typeof listFrozenPracticeFocusOptions>[number];
};

async function prepareDiagnosis(input: {
  readonly persistReport?: boolean;
} = {}): Promise<PreparedDiagnosis> {
  const created = service.createSession({
    modeId: 'decision-alignment',
    taskId: 'freeze-new-requirements',
    developmentFixture: false,
  });
  await service.transitionSession(created.id, { type: 'start_practice' });
  const attempt = await service.saveAttemptAudio({
    sessionId: created.id,
    kind: 'initial',
    bytes: new Uint8Array([1, 2, 3, 4]),
    mimeType: 'audio/webm',
    durationMs: 32_000,
  });
  await service.transitionSession(created.id, { type: 'confirm_first_attempt' });
  await service.transitionSession(created.id, { type: 'confirm_transcript' });

  const initial = snapshotForAttempt({
    sessionId: created.id,
    attemptId: attempt.id,
    kind: 'initial',
    focusVersion: null,
  });
  persistSnapshot(initial);
  const current = service.getSession(created.id)!;
  const option = listFrozenPracticeFocusOptions(
    current.taskSnapshot,
    current.modeVersion,
  )[0]!;
  const report = buildLocalDeepReport({
    id: `${created.id}-diagnosis-report`,
    snapshot: initial,
    at: frozenAt(21),
    focus: {
      criterionId: option.criterionId,
      label: option.criterionLabel,
      drillId: option.drillId,
      drill: option.drillTemplate,
    },
  });
  if (input.persistReport !== false) {
    service.putArtifact({
      type: 'deep_report',
      sessionId: created.id,
      id: report.id,
      payload: report,
    });
  }
  return { sessionId: created.id, initial, report, option };
}

async function startFreeRetry(prepared: PreparedDiagnosis): Promise<void> {
  await service.transitionSession(prepared.sessionId, {
    type: 'skip_focus',
    diagnosisReportId: prepared.report.id,
  });
}

async function startFocusedRetry(
  prepared: PreparedDiagnosis,
  input: { readonly persistDrill: boolean },
): Promise<DrillCompletion> {
  await service.transitionSession(prepared.sessionId, {
    type: 'select_focus',
    diagnosisReportId: prepared.report.id,
    focus: {
      criterionId: prepared.option.criterionId,
      drillId: prepared.option.drillId,
      label: prepared.option.criterionLabel,
      guidanceSource: 'self_directed',
      evidenceIds: [],
    },
  });
  const drill: DrillCompletion = {
    id: `${prepared.sessionId}-drill-completion`,
    snapshotId: prepared.initial.id,
    focusVersion: 1,
    criterionId: prepared.option.criterionId,
    drillId: prepared.option.drillId,
    rehearsalNote: '',
    selfChecked: true,
    startedAt: frozenAt(30),
    completedAt: frozenAt(31),
    durationMs: 1_000,
  };
  if (input.persistDrill) {
    service.putArtifact({
      type: 'drill_completion',
      sessionId: prepared.sessionId,
      id: drill.id,
      payload: drill,
    });
  }
  await service.transitionSession(prepared.sessionId, { type: 'complete_drill' });
  return drill;
}

async function recordAndConfirmRetry(input: {
  readonly sessionId: string;
  readonly persistSnapshot: boolean;
  readonly focusVersion: number | null;
}): Promise<AttemptSnapshot | null> {
  const retryAttempt = await service.saveAttemptAudio({
    sessionId: input.sessionId,
    kind: 'retry',
    bytes: new Uint8Array([5, 6, 7, 8]),
    mimeType: 'audio/webm',
    durationMs: 30_000,
  });
  const retry = snapshotForAttempt({
    sessionId: input.sessionId,
    attemptId: retryAttempt.id,
    kind: 'retry',
    focusVersion: input.focusVersion,
  });
  if (input.persistSnapshot) persistSnapshot(retry);
  await service.transitionSession(input.sessionId, { type: 'confirm_second_attempt' });
  return input.persistSnapshot ? retry : null;
}

async function captureDurableState(sessionId: string): Promise<{
  readonly session: PracticeSession;
  readonly audioByKind: Readonly<Record<string, readonly number[]>>;
}> {
  const session = service.getSession(sessionId)!;
  const entries: Array<readonly [string, readonly number[]]> = [];
  for (const attempt of session.attempts) {
    if (!attempt.audioRef) continue;
    const stored = await service.readAttemptAudio({ sessionId, kind: attempt.kind });
    entries.push([attempt.kind, [...stored.bytes]]);
  }
  return {
    session: structuredClone(session),
    audioByKind: Object.fromEntries(entries),
  };
}

async function expectRejectedWithoutMutation(
  sessionId: string,
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  const before = await captureDurableState(sessionId);
  await expect(action()).rejects.toMatchObject({ code });
  expect(await captureDurableState(sessionId)).toEqual(before);
}

describe('PracticeSessionService terminal artifact gates', () => {
  it('rejects missing, wrong and correction-stale diagnosis reports without mutating Session or audio', async () => {
    const prepared = await prepareDiagnosis({ persistReport: false });

    await expectRejectedWithoutMutation(
      prepared.sessionId,
      () => service.transitionSession(prepared.sessionId, {
        type: 'finish_analysis_only',
        diagnosisReportId: 'missing-diagnosis-report',
      }),
      'CURRENT_DEEP_REPORT_REQUIRED',
    );

    service.putArtifact({
      type: 'deep_report',
      sessionId: prepared.sessionId,
      id: prepared.report.id,
      payload: prepared.report,
    });
    await expectRejectedWithoutMutation(
      prepared.sessionId,
      () => service.transitionSession(prepared.sessionId, {
        type: 'finish_analysis_only',
        diagnosisReportId: prepared.initial.id,
      }),
      'CURRENT_DEEP_REPORT_REQUIRED',
    );

    const segment = prepared.initial.finalSegments[0]!;
    const correction: TranscriptCorrection = {
      id: `${prepared.sessionId}-late-correction`,
      snapshotId: prepared.initial.id,
      segmentId: segment.id,
      originalText: segment.text,
      correctedText: '我的建议是本周先冻结新增需求。',
      createdAt: frozenAt(22),
    };
    service.putArtifact({
      type: 'transcript_correction',
      sessionId: prepared.sessionId,
      id: correction.id,
      payload: correction,
    });
    await expectRejectedWithoutMutation(
      prepared.sessionId,
      () => service.transitionSession(prepared.sessionId, {
        type: 'finish_analysis_only',
        diagnosisReportId: prepared.report.id,
      }),
      'CURRENT_DEEP_REPORT_REQUIRED',
    );
  });

  it('freezes ordinary artifacts while terminal audio retention is pending and after completion', async () => {
    const prepared = await prepareDiagnosis();
    sessions.updateSettings({
      ...sessions.getSettings(),
      audioRetention: 'keep_with_session',
    });
    const segment = prepared.initial.finalSegments[0]!;
    const correction: TranscriptCorrection = {
      id: `${prepared.sessionId}-terminal-race-correction`,
      snapshotId: prepared.initial.id,
      segmentId: segment.id,
      originalText: segment.text,
      correctedText: '我的建议是本周先冻结新增需求。',
      createdAt: frozenAt(22),
    };
    let releaseRetention!: () => void;
    let retentionStarted!: () => void;
    const enteredRetention = new Promise<void>((resolve) => {
      retentionStarted = resolve;
    });
    const retentionGate = new Promise<void>((resolve) => {
      releaseRetention = resolve;
    });
    const retainSpy = vi.spyOn(audio, 'retainSession').mockImplementation(async () => {
      retentionStarted();
      await retentionGate;
    });

    const completing = service.transitionSession(prepared.sessionId, {
      type: 'finish_analysis_only',
      diagnosisReportId: prepared.report.id,
    });
    await enteredRetention;
    expect(() => service.putArtifact({
      type: 'transcript_correction',
      sessionId: prepared.sessionId,
      id: correction.id,
      payload: correction,
    })).toThrowError(expect.objectContaining({ code: 'SESSION_ARTIFACTS_FROZEN' }));

    releaseRetention();
    const completed = await completing;
    expect(completed.status).toBe('completed');
    expect(() => service.putArtifact({
      type: 'transcript_correction',
      sessionId: prepared.sessionId,
      id: correction.id,
      payload: correction,
    })).toThrowError(expect.objectContaining({ code: 'SESSION_ARTIFACTS_FROZEN' }));
    expect(sessions.listArtifacts(prepared.sessionId).some(
      (artifact) => artifact.id === correction.id,
    )).toBe(false);
    retainSpy.mockRestore();
  });

  it('rejects completion when the confirmed free retry has no frozen retry snapshot', async () => {
    const prepared = await prepareDiagnosis();
    await startFreeRetry(prepared);
    await recordAndConfirmRetry({
      sessionId: prepared.sessionId,
      persistSnapshot: false,
      focusVersion: null,
    });

    await expectRejectedWithoutMutation(
      prepared.sessionId,
      () => service.transitionSession(prepared.sessionId, {
        type: 'finish_retry_without_comparison',
      }),
      'REQUIRED_PRACTICE_ARTIFACT_MISSING',
    );
  });

  it('rejects a free retry snapshot that falsely claims a focused path version', async () => {
    const prepared = await prepareDiagnosis();
    await startFreeRetry(prepared);
    await recordAndConfirmRetry({
      sessionId: prepared.sessionId,
      persistSnapshot: true,
      focusVersion: 1,
    });

    await expectRejectedWithoutMutation(
      prepared.sessionId,
      () => service.transitionSession(prepared.sessionId, {
        type: 'finish_retry_without_comparison',
      }),
      'ARTIFACT_REFERENCE_MISMATCH',
    );
  });

  it('rejects a focused retry when its Drill completion was never persisted', async () => {
    const prepared = await prepareDiagnosis();
    await startFocusedRetry(prepared, { persistDrill: false });
    await recordAndConfirmRetry({
      sessionId: prepared.sessionId,
      persistSnapshot: true,
      focusVersion: 1,
    });

    await expectRejectedWithoutMutation(
      prepared.sessionId,
      () => service.transitionSession(prepared.sessionId, {
        type: 'finish_retry_without_comparison',
      }),
      'REQUIRED_PRACTICE_ARTIFACT_MISSING',
    );
  });

  it('rejects a focused retry whose snapshot focusVersion differs from the completed Drill', async () => {
    const prepared = await prepareDiagnosis();
    await startFocusedRetry(prepared, { persistDrill: true });
    await recordAndConfirmRetry({
      sessionId: prepared.sessionId,
      persistSnapshot: true,
      focusVersion: 2,
    });

    await expectRejectedWithoutMutation(
      prepared.sessionId,
      () => service.transitionSession(prepared.sessionId, {
        type: 'finish_retry_without_comparison',
      }),
      'ARTIFACT_REFERENCE_MISMATCH',
    );
  });

  it('rejects missing and wrong comparison identities, then completes only with the exact persisted pair', async () => {
    const prepared = await prepareDiagnosis();
    await startFocusedRetry(prepared, { persistDrill: true });
    const retry = await recordAndConfirmRetry({
      sessionId: prepared.sessionId,
      persistSnapshot: true,
      focusVersion: 1,
    });
    expect(retry).not.toBeNull();

    await expectRejectedWithoutMutation(
      prepared.sessionId,
      () => service.transitionSession(prepared.sessionId, {
        type: 'view_comparison',
        comparisonArtifactId: 'missing-comparison-artifact',
      }),
      'REQUIRED_PRACTICE_ARTIFACT_MISSING',
    );

    const comparison = compareFrozenAttempts({
      id: `${prepared.sessionId}-current-comparison`,
      initial: prepared.initial,
      retry: retry!,
      criterionId: prepared.option.criterionId,
      comparisonDimension: prepared.option.comparisonDimension,
      at: frozenAt(50),
    });
    service.putArtifact({
      type: 'attempt_comparison',
      sessionId: prepared.sessionId,
      id: comparison.id,
      payload: comparison,
    });

    await expectRejectedWithoutMutation(
      prepared.sessionId,
      () => service.transitionSession(prepared.sessionId, {
        type: 'view_comparison',
        comparisonArtifactId: prepared.initial.id,
      }),
      'REQUIRED_PRACTICE_ARTIFACT_MISSING',
    );

    const completed = await service.transitionSession(prepared.sessionId, {
      type: 'view_comparison',
      comparisonArtifactId: comparison.id,
    });
    expect(completed).toMatchObject({
      status: 'completed',
      outcome: 'practice_loop_completed',
      diagnosisReportId: prepared.report.id,
      comparisonArtifactId: comparison.id,
    });
    expect(completed.comparisonViewedAt).not.toBeNull();
    expect(completed.attempts).toHaveLength(2);
    expect(completed.attempts.every((attempt) => attempt.audioRef === null)).toBe(true);
  });
});
