// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  type PracticeArtifact,
  type PracticeSession,
} from '../../src/shared';

const BASE_AT = Date.parse('2026-07-21T10:00:00.000Z');

let root: string;
let sessions: SessionRepository;
let service: PracticeSessionService;
let clock: number;
let idOrdinal: number;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'phrio-legacy-diagnosis-'));
  sessions = new SessionRepository(path.join(root, 'phrio.sqlite3'));
  service = new PracticeSessionService(
    sessions,
    new AudioRepository(path.join(root, 'temporary-audio')),
    {
      createId: () => `legacy-diagnosis-${++idOrdinal}`,
      now: () => new Date((clock += 1_000)),
    },
  );
  clock = BASE_AT;
  idOrdinal = 0;
  await service.initialize();
});

afterEach(async () => {
  sessions.close();
  await rm(root, { recursive: true, force: true });
});

function at(offsetSeconds: number): string {
  return new Date(BASE_AT + offsetSeconds * 1_000).toISOString();
}

function snapshot(input: {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly kind: 'initial' | 'retry';
  readonly focusVersion: number | null;
}): AttemptSnapshot {
  const text = input.kind === 'initial'
    ? '我的建议是本周冻结新增需求。'
    : '我的建议是本周冻结新增需求，并明确下一步。';
  const frozenAt = at(input.kind === 'initial' ? 20 : 40);
  return {
    schemaVersion: 1,
    id: `${input.attemptId}-${input.kind}-snapshot`,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    generation: input.kind === 'initial' ? 1 : 2,
    kind: input.kind,
    frozenAt,
    audioWatermark: 3_000,
    transcriptVersion: 1,
    finalSegments: [{
      id: `${input.attemptId}-${input.kind}-segment`,
      attemptId: input.attemptId,
      sequence: 0,
      revision: 1,
      text,
      startMs: 0,
      endMs: 3_000,
      confidence: null,
      isFinal: true,
      emittedAt: frozenAt,
      finalizedAt: frozenAt,
      modelVersion: 'legacy-recovery-test-1',
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

function putArtifact(artifact: PracticeArtifact): void {
  service.putArtifact(artifact);
}

type PreparedDiagnosis = {
  readonly sessionId: string;
  readonly initial: AttemptSnapshot;
  readonly report: DeepReport;
  readonly option: ReturnType<typeof listFrozenPracticeFocusOptions>[number];
};

async function prepareDiagnosis(): Promise<PreparedDiagnosis> {
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
    durationMs: 30_000,
  });
  await service.transitionSession(created.id, { type: 'confirm_first_attempt' });
  await service.transitionSession(created.id, { type: 'confirm_transcript' });

  const initial = snapshot({
    sessionId: created.id,
    attemptId: attempt.id,
    kind: 'initial',
    focusVersion: null,
  });
  putArtifact({
    type: 'attempt_snapshot',
    sessionId: created.id,
    id: initial.id,
    payload: initial,
  });
  const current = service.getSession(created.id)!;
  const option = listFrozenPracticeFocusOptions(
    current.taskSnapshot,
    current.modeVersion,
  )[0]!;
  const report = buildLocalDeepReport({
    id: `${created.id}-diagnosis-report`,
    snapshot: initial,
    at: at(21),
    focus: {
      criterionId: option.criterionId,
      label: option.criterionLabel,
      drillId: option.drillId,
      drill: option.drillTemplate,
    },
  });
  putArtifact({
    type: 'deep_report',
    sessionId: created.id,
    id: report.id,
    payload: report,
  });
  return { sessionId: created.id, initial, report, option };
}

function eraseLegacyReportIdentity(sessionId: string): PracticeSession {
  const current = service.getSession(sessionId)!;
  return sessions.updateSession({ ...current, diagnosisReportId: null });
}

async function startFreeRetry(prepared: PreparedDiagnosis): Promise<void> {
  await service.transitionSession(prepared.sessionId, {
    type: 'skip_focus',
    diagnosisReportId: prepared.report.id,
  });
}

async function startFocusedRetry(prepared: PreparedDiagnosis): Promise<DrillCompletion> {
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
    startedAt: at(30),
    completedAt: at(31),
    durationMs: 1_000,
  };
  putArtifact({
    type: 'drill_completion',
    sessionId: prepared.sessionId,
    id: drill.id,
    payload: drill,
  });
  return drill;
}

async function recordRetry(
  sessionId: string,
  focusVersion: number | null,
): Promise<AttemptSnapshot> {
  const attempt = await service.saveAttemptAudio({
    sessionId,
    kind: 'retry',
    bytes: new Uint8Array([5, 6, 7, 8]),
    mimeType: 'audio/webm',
    durationMs: 28_000,
  });
  const retry = snapshot({
    sessionId,
    attemptId: attempt.id,
    kind: 'retry',
    focusVersion,
  });
  putArtifact({
    type: 'attempt_snapshot',
    sessionId,
    id: retry.id,
    payload: retry,
  });
  return retry;
}

async function captureDurableState(sessionId: string): Promise<{
  readonly session: PracticeSession;
  readonly artifacts: readonly PracticeArtifact[];
  readonly audio: Readonly<Record<string, readonly number[]>>;
}> {
  const session = service.getSession(sessionId)!;
  const audioEntries: Array<readonly [string, readonly number[]]> = [];
  for (const attempt of session.attempts) {
    if (!attempt.audioRef) continue;
    const stored = await service.readAttemptAudio({ sessionId, kind: attempt.kind });
    audioEntries.push([attempt.kind, [...stored.bytes]]);
  }
  return {
    session: structuredClone(session),
    artifacts: structuredClone(sessions.listArtifacts(sessionId)),
    audio: Object.fromEntries(audioEntries),
  };
}

async function expectRecoveryRejectedWithoutMutation(
  sessionId: string,
  action: () => Promise<unknown>,
  messageFragment: string,
): Promise<void> {
  const before = await captureDurableState(sessionId);
  await expect(action()).rejects.toMatchObject({
    code: 'CURRENT_DEEP_REPORT_REQUIRED',
    message: expect.stringContaining(messageFragment),
  });
  expect(await captureDurableState(sessionId)).toEqual(before);
}

describe('legacy diagnosis report identity recovery', () => {
  it('backfills the sole current diagnosis atomically when a legacy Drill continues', async () => {
    const prepared = await prepareDiagnosis();
    await startFocusedRetry(prepared);
    eraseLegacyReportIdentity(prepared.sessionId);

    const continued = await service.transitionSession(prepared.sessionId, {
      type: 'complete_drill',
    });

    expect(continued).toMatchObject({
      status: 'second_attempt',
      diagnosisReportId: prepared.report.id,
    });
    expect(service.getSession(prepared.sessionId)?.diagnosisReportId).toBe(prepared.report.id);
  });

  it('backfills the diagnosis matching a frozen legacy focus when other focus reports exist', async () => {
    const prepared = await prepareDiagnosis();
    const current = service.getSession(prepared.sessionId)!;
    const otherOption = listFrozenPracticeFocusOptions(
      current.taskSnapshot,
      current.modeVersion,
    ).find((candidate) => (
      candidate.criterionId !== prepared.option.criterionId
      || candidate.drillId !== prepared.option.drillId
    ));
    expect(otherOption).toBeDefined();
    const otherReport = buildLocalDeepReport({
      id: `${prepared.sessionId}-other-focus-report`,
      snapshot: prepared.initial,
      at: at(22),
      focus: {
        criterionId: otherOption!.criterionId,
        label: otherOption!.criterionLabel,
        drillId: otherOption!.drillId,
        drill: otherOption!.drillTemplate,
      },
    });
    putArtifact({
      type: 'deep_report',
      sessionId: prepared.sessionId,
      id: otherReport.id,
      payload: otherReport,
    });
    await startFocusedRetry(prepared);
    eraseLegacyReportIdentity(prepared.sessionId);

    const continued = await service.transitionSession(prepared.sessionId, {
      type: 'complete_drill',
    });

    expect(continued).toMatchObject({
      status: 'second_attempt',
      diagnosisReportId: prepared.report.id,
    });
  });

  it('carries the sole current diagnosis through legacy free-retry completion', async () => {
    const prepared = await prepareDiagnosis();
    await startFreeRetry(prepared);
    const retry = await recordRetry(prepared.sessionId, null);
    await service.transitionSession(prepared.sessionId, { type: 'confirm_second_attempt' });
    eraseLegacyReportIdentity(prepared.sessionId);

    const completed = await service.transitionSession(prepared.sessionId, {
      type: 'finish_retry_without_comparison',
    });

    expect(completed).toMatchObject({
      status: 'completed',
      outcome: 'free_retry_completed',
      diagnosisReportId: prepared.report.id,
    });
    expect(retry.focusVersion).toBeNull();
  });

  it('carries the sole current diagnosis through an exact legacy comparison', async () => {
    const prepared = await prepareDiagnosis();
    await startFocusedRetry(prepared);
    await service.transitionSession(prepared.sessionId, { type: 'complete_drill' });
    const retry = await recordRetry(prepared.sessionId, 1);
    await service.transitionSession(prepared.sessionId, { type: 'confirm_second_attempt' });
    const comparison = compareFrozenAttempts({
      id: `${prepared.sessionId}-comparison`,
      initial: prepared.initial,
      retry,
      criterionId: prepared.option.criterionId,
      comparisonDimension: prepared.option.comparisonDimension,
      at: at(50),
    });
    putArtifact({
      type: 'attempt_comparison',
      sessionId: prepared.sessionId,
      id: comparison.id,
      payload: comparison,
    });
    eraseLegacyReportIdentity(prepared.sessionId);

    const completed = await service.transitionSession(prepared.sessionId, {
      type: 'view_comparison',
      comparisonArtifactId: comparison.id,
    });

    expect(completed).toMatchObject({
      status: 'completed',
      outcome: 'practice_loop_completed',
      diagnosisReportId: prepared.report.id,
    });
  });

  it('blocks a legacy completion with no current report and preserves its graph and audio', async () => {
    const prepared = await prepareDiagnosis();
    await startFreeRetry(prepared);
    await recordRetry(prepared.sessionId, null);
    await service.transitionSession(prepared.sessionId, { type: 'confirm_second_attempt' });
    const legacy = eraseLegacyReportIdentity(prepared.sessionId);
    sessions.updateSessionAndDeleteArtifacts(legacy, [prepared.report.id]);

    await expectRecoveryRejectedWithoutMutation(
      prepared.sessionId,
      () => service.transitionSession(prepared.sessionId, {
        type: 'finish_retry_without_comparison',
      }),
      'no valid complete diagnosis',
    );
  });

  it('blocks ambiguous legacy completion instead of guessing and preserves its graph and audio', async () => {
    const prepared = await prepareDiagnosis();
    const secondReport = buildLocalDeepReport({
      id: `${prepared.sessionId}-second-current-report`,
      snapshot: prepared.initial,
      at: at(22),
      focus: prepared.report.focus!,
    });
    putArtifact({
      type: 'deep_report',
      sessionId: prepared.sessionId,
      id: secondReport.id,
      payload: secondReport,
    });
    await startFreeRetry(prepared);
    await recordRetry(prepared.sessionId, null);
    await service.transitionSession(prepared.sessionId, { type: 'confirm_second_attempt' });
    eraseLegacyReportIdentity(prepared.sessionId);

    await expectRecoveryRejectedWithoutMutation(
      prepared.sessionId,
      () => service.transitionSession(prepared.sessionId, {
        type: 'finish_retry_without_comparison',
      }),
      'multiple valid diagnoses',
    );
  });

  it('ignores a structurally current report whose persisted derivation is invalid', async () => {
    const prepared = await prepareDiagnosis();
    const invalidReport = buildLocalDeepReport({
      id: `${prepared.sessionId}-invalid-current-report`,
      snapshot: prepared.initial,
      at: at(22),
      focus: prepared.report.focus!,
    });
    sessions.putArtifact({
      type: 'deep_report',
      sessionId: prepared.sessionId,
      id: invalidReport.id,
      payload: {
        ...invalidReport,
        judgment: 'A legacy row cannot become authoritative by bypassing derivation validation.',
      },
    });
    await startFreeRetry(prepared);
    await recordRetry(prepared.sessionId, null);
    await service.transitionSession(prepared.sessionId, { type: 'confirm_second_attempt' });
    eraseLegacyReportIdentity(prepared.sessionId);

    const completed = await service.transitionSession(prepared.sessionId, {
      type: 'finish_retry_without_comparison',
    });

    expect(completed).toMatchObject({
      status: 'completed',
      diagnosisReportId: prepared.report.id,
    });
  });

  it('keeps explicit report selection authoritative even when several reports are current', async () => {
    const prepared = await prepareDiagnosis();
    const secondReport = buildLocalDeepReport({
      id: `${prepared.sessionId}-explicit-report`,
      snapshot: prepared.initial,
      at: at(22),
      focus: prepared.report.focus!,
    });
    putArtifact({
      type: 'deep_report',
      sessionId: prepared.sessionId,
      id: secondReport.id,
      payload: secondReport,
    });

    const completed = await service.transitionSession(prepared.sessionId, {
      type: 'finish_analysis_only',
      diagnosisReportId: secondReport.id,
    });

    expect(completed).toMatchObject({
      status: 'completed',
      outcome: 'analysis_only',
      diagnosisReportId: secondReport.id,
    });
  });
});
