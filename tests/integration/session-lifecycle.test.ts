// @vitest-environment node

import { access, mkdtemp, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioRepository } from '../../src/backend/repositories/audio-repository';
import { SessionRepository } from '../../src/backend/repositories/session-repository';
import { PracticeSessionService } from '../../src/backend/services/practice-session-service';
import {
  PracticeSessionSchema,
  buildDeepDiagnosisPayload,
  buildLocalDeepReport,
  buildSemanticComparisonPayload,
  compareFrozenAttempts,
  createQueuedCloudDeepDiagnosis,
  createQueuedCloudSemanticComparison,
  listFrozenPracticeFocusOptions,
  type AttemptSnapshot,
} from '../../src/shared';

let root: string;
let sessions: SessionRepository;
let audio: AudioRepository;
let service: PracticeSessionService;
let ids: string[];
let tick: number;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'phrio-lifecycle-test-'));
  sessions = new SessionRepository(path.join(root, 'phrio.sqlite3'));
  audio = new AudioRepository(path.join(root, 'temporary-audio'));
  ids = ['session-1', 'attempt-1', 'attempt-2', 'attempt-3', 'attempt-4'];
  tick = Date.parse('2026-07-16T03:00:00.000Z');
  service = new PracticeSessionService(sessions, audio, {
    createId: () => ids.shift()!,
    now: () => new Date((tick += 1_000)),
  });
  await service.initialize();
});

afterEach(async () => {
  vi.restoreAllMocks();
  sessions.close();
  await rm(root, { recursive: true, force: true });
});

async function createStartedSession(): Promise<string> {
  const created = service.createSession({
    modeId: 'decision-alignment',
    taskId: 'freeze-new-requirements',
    developmentFixture: false,
  });
  const started = await service.transitionSession(created.id, { type: 'start_practice' });
  return started.id;
}

async function advanceToSecondAttempt(sessionId: string): Promise<void> {
  await service.saveAttemptAudio({
    sessionId,
    kind: 'initial',
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/webm',
    durationMs: 32_000,
  });
  await service.transitionSession(sessionId, { type: 'confirm_first_attempt' });
  await service.transitionSession(sessionId, { type: 'confirm_transcript' });
  const diagnosis = persistDiagnosisForInitialAttempt({ sessionId });
  await service.transitionSession(sessionId, {
    type: 'skip_focus',
    diagnosisReportId: diagnosis.report.id,
  });
}

function snapshotForAttempt(input: {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly kind: 'initial' | 'retry';
  readonly id: string;
  readonly text: string;
  readonly focusVersion?: number | null;
}): AttemptSnapshot {
  const at = '2026-07-16T03:20:00.000Z';
  return {
    schemaVersion: 1,
    id: input.id,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    generation: 1,
    kind: input.kind,
    frozenAt: at,
    audioWatermark: 3_000,
    transcriptVersion: 1,
    finalSegments: [{
      id: `${input.id}-segment`,
      attemptId: input.attemptId,
      sequence: 0,
      revision: 1,
      text: input.text,
      startMs: 0,
      endMs: 3_000,
      confidence: null,
      isFinal: true,
      emittedAt: at,
      finalizedAt: at,
      modelVersion: 'lifecycle-test-1',
    }],
    annotations: [],
    hints: [],
    metrics: {
      finalCharacters: input.text.length,
      finalSegments: 1,
      fillers: 0,
      hedges: 0,
      vagueWords: 0,
      repetitions: 0,
      selfCorrections: 0,
      algorithmVersion: 'local-rules-1',
    },
    focusVersion: input.focusVersion ?? null,
  };
}

function persistDiagnosisForInitialAttempt(input: {
  readonly sessionId: string;
  readonly snapshotId?: string;
  readonly reportId?: string;
  readonly text?: string;
}) {
  const session = service.getSession(input.sessionId)!;
  const attempt = session.attempts.find((candidate) => candidate.kind === 'initial')!;
  const snapshot = snapshotForAttempt({
    sessionId: input.sessionId,
    attemptId: attempt.id,
    kind: 'initial',
    id: input.snapshotId ?? `${attempt.id}-snapshot-initial`,
    text: input.text ?? '我的建议是本周冻结新增需求。',
  });
  service.putArtifact({
    type: 'attempt_snapshot',
    sessionId: input.sessionId,
    id: snapshot.id,
    payload: snapshot,
  });
  const focus = listFrozenPracticeFocusOptions(
    session.taskSnapshot,
    session.modeVersion,
  )[0]!;
  const report = buildLocalDeepReport({
    id: input.reportId ?? `${attempt.id}-diagnosis-report`,
    snapshot,
    at: snapshot.frozenAt,
    focus: {
      criterionId: focus.criterionId,
      label: focus.criterionLabel,
      drillId: focus.drillId,
      drill: focus.drillTemplate,
    },
  });
  service.putArtifact({
    type: 'deep_report',
    sessionId: input.sessionId,
    id: report.id,
    payload: report,
  });
  return { focus, report, snapshot };
}

describe('real attempt audio lifecycle', () => {
  it('freezes a one-off free expression task without adding a reusable template', () => {
    const created = service.createSession({
      modeId: 'clear-expression',
      taskId: 'free-expression',
      developmentFixture: false,
      customTask: {
        prompt: '说说今天最想推动的一件事',
        audience: '团队同事',
        objective: '把想法讲清楚',
        durationSeconds: 90,
      },
    });

    expect(created.taskSnapshot.prompt).toBe('说说今天最想推动的一件事');
    expect(created.taskSnapshot.context.audience).toBe('团队同事');
    expect(created.taskSnapshot.id).toBe('free-expression');
    expect(created.taskSnapshot.developmentFixture).toBe(false);
    expect(created.taskSnapshot.rubricSnapshot?.map((criterion) => criterion.id))
      .toEqual(created.taskSnapshot.focusCandidateCriterionIds);
    expect(created.taskSnapshot.drillSnapshot?.map((drill) => drill.id))
      .toEqual(created.taskSnapshot.fallbackDrillIds);
  });

  it('allows discarding only the slot belonging to the current recording stage', async () => {
    const sessionId = await createStartedSession();
    const initial = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/webm',
      durationMs: 30_000,
    });
    await service.transitionSession(sessionId, { type: 'confirm_first_attempt' });
    const deleteSpy = vi.spyOn(audio, 'delete');

    await expect(
      service.discardAttemptAudio({ sessionId, kind: 'initial' }),
    ).rejects.toMatchObject({ code: 'INVALID_ATTEMPT_STAGE' });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(sessions.getAttempt(sessionId, 'initial')?.id).toBe(initial.id);
    await expect(access(path.join(audio.rootDirectory, initial.audioRef!))).resolves.toBeUndefined();

    const secondSessionId = service.createSession({
      modeId: 'decision-alignment',
      taskId: 'freeze-new-requirements',
      developmentFixture: false,
    }).id;
    await service.transitionSession(secondSessionId, { type: 'start_practice' });
    await advanceToSecondAttempt(secondSessionId);
    const retry = await service.saveAttemptAudio({
      sessionId: secondSessionId,
      kind: 'retry',
      bytes: new Uint8Array([4, 5, 6]),
      mimeType: 'audio/webm',
      durationMs: 30_000,
    });
    await service.transitionSession(secondSessionId, { type: 'confirm_second_attempt' });
    deleteSpy.mockClear();

    await expect(
      service.discardAttemptAudio({ sessionId: secondSessionId, kind: 'retry' }),
    ).rejects.toMatchObject({ code: 'INVALID_ATTEMPT_STAGE' });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(sessions.getAttempt(secondSessionId, 'retry')?.id).toBe(retry.id);
  });

  it('does not delete attempt audio when the discard DB update fails', async () => {
    const sessionId = await createStartedSession();
    const attempt = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([2, 2, 2]),
      mimeType: 'audio/webm',
      durationMs: 30_000,
    });
    const updateSpy = vi
      .spyOn(sessions, 'updateSessionAndDeleteArtifacts')
      .mockImplementationOnce(() => {
        throw new Error('injected DB failure');
      });
    const deleteSpy = vi.spyOn(audio, 'delete');

    await expect(
      service.discardAttemptAudio({ sessionId, kind: 'initial' }),
    ).rejects.toThrow('injected DB failure');

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(sessions.getAttempt(sessionId, 'initial')?.id).toBe(attempt.id);
    await expect(access(path.join(audio.rootDirectory, attempt.audioRef!))).resolves.toBeUndefined();
    updateSpy.mockRestore();
  });

  it('discards a pre-persisted snapshot after audio save fails and remains clean after restart', async () => {
    const sessionId = await createStartedSession();
    const attemptId = 'attempt-audio-save-failed';
    const snapshot = snapshotForAttempt({
      sessionId,
      attemptId,
      kind: 'initial',
      id: 'snapshot-audio-save-failed',
      text: '音频保存失败前已冻结的内容。',
    });
    service.putArtifact({
      type: 'attempt_snapshot',
      sessionId,
      id: snapshot.id,
      payload: snapshot,
    });
    // Exercise the full dependency cleanup even if an older build or a crash
    // left a derived row beside the pre-audio snapshot.
    sessions.putArtifact({
      type: 'transcript_correction',
      sessionId,
      id: 'correction-audio-save-failed',
      payload: {
        id: 'correction-audio-save-failed',
        snapshotId: snapshot.id,
        segmentId: snapshot.finalSegments[0]!.id,
        originalText: snapshot.finalSegments[0]!.text,
        correctedText: '音频保存失败后应一并丢弃。',
        createdAt: '2026-07-16T03:20:01.000Z',
      },
    });
    vi.spyOn(audio, 'save').mockRejectedValueOnce(new Error('injected audio save failure'));
    await expect(service.saveAttemptAudio({
      sessionId,
      attemptId,
      kind: 'initial',
      bytes: new Uint8Array([7, 7, 7]),
      mimeType: 'audio/webm',
      durationMs: 30_000,
    })).rejects.toThrow('injected audio save failure');
    expect(sessions.getAttempt(sessionId, 'initial')).toBeNull();
    expect(service.listArtifacts(sessionId)).toHaveLength(2);

    await service.discardAttemptAudio({ sessionId, kind: 'initial', attemptId });
    expect(service.listArtifacts(sessionId)).toEqual([]);

    sessions.close();
    sessions = new SessionRepository(path.join(root, 'phrio.sqlite3'));
    service = new PracticeSessionService(sessions, audio, {
      createId: () => ids.shift()!,
      now: () => new Date((tick += 1_000)),
    });
    await service.initialize();
    expect(service.listArtifacts(sessionId)).toEqual([]);
    await expect(service.saveAttemptAudio({
      sessionId,
      attemptId: 'attempt-after-restart',
      kind: 'initial',
      bytes: new Uint8Array([8, 8, 8]),
      mimeType: 'audio/webm',
      durationMs: 30_000,
    })).resolves.toMatchObject({ id: 'attempt-after-restart', kind: 'initial' });
  });

  it('rejects a stale discard identity without deleting the current take', async () => {
    const sessionId = await createStartedSession();
    const attempt = await service.saveAttemptAudio({
      sessionId,
      attemptId: 'attempt-current-owner',
      kind: 'initial',
      bytes: new Uint8Array([6, 6, 6]),
      mimeType: 'audio/webm',
      durationMs: 30_000,
    });
    const snapshot = snapshotForAttempt({
      sessionId,
      attemptId: attempt.id,
      kind: 'initial',
      id: 'snapshot-current-owner',
      text: '当前 take 不应被过期请求删除。',
    });
    service.putArtifact({
      type: 'attempt_snapshot',
      sessionId,
      id: snapshot.id,
      payload: snapshot,
    });

    await expect(service.discardAttemptAudio({
      sessionId,
      kind: 'initial',
      attemptId: 'attempt-stale-owner',
    })).rejects.toMatchObject({ code: 'ATTEMPT_ID_REUSE_MISMATCH' });
    expect(sessions.getAttempt(sessionId, 'initial')?.id).toBe(attempt.id);
    expect(service.listArtifacts(sessionId).map((artifact) => artifact.id)).toEqual([snapshot.id]);
    await expect(access(path.join(audio.rootDirectory, attempt.audioRef!))).resolves.toBeUndefined();
  });

  it('replaces a rerecorded slot and immediately removes the superseded file', async () => {
    const sessionId = await createStartedSession();
    const first = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([1, 1, 1]),
      mimeType: 'audio/webm;codecs=opus',
      durationMs: 30_000,
    });
    const firstAbsolutePath = path.join(audio.rootDirectory, first.audioRef!);
    const supersededSnapshot = snapshotForAttempt({
      sessionId,
      attemptId: first.id,
      kind: 'initial',
      id: 'snapshot-superseded-rerecord',
      text: '第一次录音的冻结内容。',
    });
    sessions.putArtifact({
      type: 'attempt_snapshot',
      sessionId,
      id: supersededSnapshot.id,
      payload: supersededSnapshot,
    });
    sessions.putArtifact({
      type: 'transcript_correction',
      sessionId,
      id: 'correction-superseded-rerecord',
      payload: {
        id: 'correction-superseded-rerecord',
        snapshotId: supersededSnapshot.id,
        segmentId: supersededSnapshot.finalSegments[0]!.id,
        originalText: supersededSnapshot.finalSegments[0]!.text,
        correctedText: '第一次录音的修正内容。',
        createdAt: '2026-07-16T03:20:01.000Z',
      },
    });

    const replacement = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([9, 8, 7, 6]),
      mimeType: 'audio/webm',
      durationMs: 42_000,
    });

    await expect(access(firstAbsolutePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(replacement.id).not.toBe(first.id);
    expect(sessions.listAttempts(sessionId)).toHaveLength(1);
    expect(sessions.listArtifacts(sessionId)).toEqual([]);
    const read = await service.readAttemptAudio({ sessionId, kind: 'initial' });
    expect([...read.bytes]).toEqual([9, 8, 7, 6]);
  });

  it('prunes the complete retry artifact graph while preserving the initial evidence graph', async () => {
    const sessionId = await createStartedSession();
    const initialAttempt = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/webm',
      durationMs: 30_000,
    });
    await service.transitionSession(sessionId, { type: 'confirm_first_attempt' });
    await service.transitionSession(sessionId, { type: 'confirm_transcript' });
    const diagnosis = persistDiagnosisForInitialAttempt({
      sessionId,
      snapshotId: 'snapshot-initial-preserved',
      reportId: 'report-initial-preserved',
      text: '我觉得可能要冻结新增需求。',
    });
    const initialSnapshot = diagnosis.snapshot;
    await service.transitionSession(sessionId, {
      type: 'skip_focus',
      diagnosisReportId: diagnosis.report.id,
    });
    const retryAttempt = await service.saveAttemptAudio({
      sessionId,
      kind: 'retry',
      bytes: new Uint8Array([4, 5, 6]),
      mimeType: 'audio/webm',
      durationMs: 31_000,
    });
    const retrySnapshot = snapshotForAttempt({
      sessionId,
      attemptId: retryAttempt.id,
      kind: 'retry',
      id: 'snapshot-retry-discarded',
      text: '我的建议是本周冻结新增需求。',
      focusVersion: 1,
    });
    for (const snapshot of [retrySnapshot]) {
      sessions.putArtifact({
        type: 'attempt_snapshot', sessionId, id: snapshot.id, payload: snapshot,
      });
    }
    const retryReport = buildLocalDeepReport({
      id: 'report-retry-discarded',
      snapshot: retrySnapshot,
      at: '2026-07-16T03:20:03.000Z',
    });
    sessions.putArtifact({
      type: 'deep_report', sessionId, id: retryReport.id, payload: retryReport,
    });
    sessions.putArtifact({
      type: 'transcript_correction',
      sessionId,
      id: 'correction-retry-discarded',
      payload: {
        id: 'correction-retry-discarded',
        snapshotId: retrySnapshot.id,
        segmentId: retrySnapshot.finalSegments[0]!.id,
        originalText: retrySnapshot.finalSegments[0]!.text,
        correctedText: '我的建议是：本周冻结新增需求。',
        createdAt: '2026-07-16T03:20:04.000Z',
      },
    });
    const current = service.getSession(sessionId)!;
    const focus = listFrozenPracticeFocusOptions(
      current.taskSnapshot,
      current.modeVersion,
    )[0]!;
    sessions.putArtifact({
      type: 'drill_completion',
      sessionId,
      id: 'drill-initial-preserved',
      payload: {
        id: 'drill-initial-preserved',
        snapshotId: initialSnapshot.id,
        focusVersion: 1,
        criterionId: focus.criterionId,
        drillId: focus.drillId,
        rehearsalNote: '',
        selfChecked: true,
        startedAt: '2026-07-16T03:20:04.000Z',
        completedAt: '2026-07-16T03:20:05.000Z',
        durationMs: 1_000,
      },
    });
    const comparison = compareFrozenAttempts({
      id: 'comparison-retry-discarded',
      initial: initialSnapshot,
      retry: retrySnapshot,
      criterionId: focus.criterionId,
      comparisonDimension: focus.comparisonDimension,
      at: '2026-07-16T03:20:06.000Z',
    });
    sessions.putArtifact({
      type: 'attempt_comparison', sessionId, id: comparison.id, payload: comparison,
    });
    const initialDiagnosisPayload = buildDeepDiagnosisPayload({
      session: current,
      snapshot: initialSnapshot,
      corrections: [],
      analysisInputId: 'analysis-initial-preserved',
    });
    const retryDiagnosisPayload = buildDeepDiagnosisPayload({
      session: current,
      snapshot: retrySnapshot,
      corrections: [],
      analysisInputId: 'analysis-retry-discarded',
    });
    for (const [id, payload, hash] of [
      ['cloud-diagnosis-initial-preserved', initialDiagnosisPayload, 'a'.repeat(64)],
      ['cloud-diagnosis-retry-discarded', retryDiagnosisPayload, 'b'.repeat(64)],
    ] as const) {
      sessions.putArtifact({
        type: 'cloud_deep_diagnosis',
        sessionId,
        id,
        payload: createQueuedCloudDeepDiagnosis({
          payload,
          payloadHash: hash,
          consentId: `${id}-consent`,
          at: '2026-07-16T03:20:07.000Z',
        }),
      });
    }
    const comparisonSession = PracticeSessionSchema.parse({
      ...current,
      guidanceSource: 'self_directed',
      drillCompletedAt: '2026-07-16T03:20:08.000Z',
      focus: {
        criterionId: focus.criterionId,
        drillId: focus.drillId,
        label: focus.criterionLabel,
        guidanceSource: 'self_directed',
        evidenceIds: [],
        selectedAt: '2026-07-16T03:20:08.000Z',
      },
      attempts: current.attempts.map((attempt) => ({
        ...attempt,
        status: 'confirmed',
        confirmedAt: '2026-07-16T03:20:08.000Z',
      })),
    });
    const cloudComparisonPayload = buildSemanticComparisonPayload({
      session: comparisonSession,
      initial: initialSnapshot,
      retry: retrySnapshot,
      criterionId: focus.criterionId,
      label: focus.criterionLabel,
      drillId: focus.drillId,
      corrections: [],
      analysisInputId: 'analysis-comparison-retry-discarded',
    });
    const cloudComparison = createQueuedCloudSemanticComparison({
      payload: cloudComparisonPayload,
      payloadHash: 'c'.repeat(64),
      consentId: 'consent-comparison-retry-discarded',
      at: '2026-07-16T03:20:09.000Z',
    });
    sessions.putArtifact({
      type: 'cloud_semantic_comparison',
      sessionId,
      id: 'cloud-comparison-retry-discarded',
      payload: cloudComparison,
    });

    await service.discardAttemptAudio({ sessionId, kind: 'retry' });

    expect(sessions.getAttempt(sessionId, 'initial')?.id).toBe(initialAttempt.id);
    expect(sessions.getAttempt(sessionId, 'retry')).toBeNull();
    expect(sessions.listArtifacts(sessionId).map((artifact) => artifact.id).sort()).toEqual([
      'cloud-diagnosis-initial-preserved',
      'drill-initial-preserved',
      'report-initial-preserved',
      'snapshot-initial-preserved',
    ]);
  });

  it('uses the frozen snapshot attempt identity idempotently and rejects identity reuse', async () => {
    const sessionId = await createStartedSession();
    const input = {
      sessionId,
      attemptId: 'attempt-from-frozen-snapshot',
      kind: 'initial' as const,
      bytes: new Uint8Array([1, 4, 7, 9]),
      mimeType: 'audio/webm;codecs=opus',
      durationMs: 33_000,
    };

    const first = await service.saveAttemptAudio(input);
    const retry = await service.saveAttemptAudio(input);

    expect(first.id).toBe(input.attemptId);
    expect(retry).toEqual(first);
    expect(sessions.listAttempts(sessionId)).toHaveLength(1);
    expect([...(await service.readAttemptAudio({ sessionId, kind: 'initial' })).bytes])
      .toEqual([...input.bytes]);

    await expect(service.saveAttemptAudio({
      ...input,
      durationMs: 34_000,
    })).rejects.toMatchObject({ code: 'ATTEMPT_ID_REUSE_MISMATCH' });
    await expect(service.saveAttemptAudio({
      ...input,
      bytes: new Uint8Array([9, 7, 4, 1]),
    })).rejects.toMatchObject({ code: 'ATTEMPT_ID_REUSE_MISMATCH' });
    expect([...(await service.readAttemptAudio({ sessionId, kind: 'initial' })).bytes])
      .toEqual([...input.bytes]);
  });

  it('keeps the committed replacement when old-file cleanup fails after unlink', async () => {
    const sessionId = await createStartedSession();
    const first = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([1, 1, 1]),
      mimeType: 'audio/webm',
      durationMs: 30_000,
    });
    const firstPath = path.join(audio.rootDirectory, first.audioRef!);
    const realDelete = audio.delete.bind(audio);
    vi.spyOn(audio, 'delete').mockImplementationOnce(async (audioRef) => {
      await realDelete(audioRef);
      throw new Error('injected parent cleanup failure');
    });

    const replacement = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([9, 9, 9]),
      mimeType: 'audio/webm',
      durationMs: 31_000,
    });

    expect(sessions.getAttempt(sessionId, 'initial')?.id).toBe(replacement.id);
    expect([...(await service.readAttemptAudio({ sessionId, kind: 'initial' })).bytes]).toEqual([
      9, 9, 9,
    ]);
    await expect(access(firstPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      access(path.join(audio.rootDirectory, replacement.audioRef!)),
    ).resolves.toBeUndefined();
  });

  it('cascades database and private audio deletion for an entire session', async () => {
    const sessionId = await createStartedSession();
    await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([3, 2, 1]),
      mimeType: 'audio/webm',
      durationMs: 35_000,
    });

    expect(await service.deleteSession(sessionId)).toBe(true);

    expect(sessions.getSession(sessionId)).toBeNull();
    expect(sessions.countAttemptsForSession(sessionId)).toBe(0);
    await expect(access(path.join(audio.rootDirectory, sessionId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a Session deletion when audio cleanup fails instead of reporting false success', async () => {
    const sessionId = await createStartedSession();
    await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([3, 2, 1]),
      mimeType: 'audio/webm',
      durationMs: 35_000,
    });
    vi.spyOn(audio, 'deleteSession').mockRejectedValueOnce(
      new Error('injected audio deletion failure'),
    );

    await expect(service.deleteSession(sessionId)).rejects.toMatchObject({
      code: 'SESSION_AUDIO_CLEANUP_FAILED',
    });
    expect(sessions.getSession(sessionId)).toBeNull();
  });

  it('does not touch session audio when the DB delete fails', async () => {
    const sessionId = await createStartedSession();
    const attempt = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([3, 3, 3]),
      mimeType: 'audio/webm',
      durationMs: 35_000,
    });
    const repositoryDelete = vi
      .spyOn(sessions, 'deleteSession')
      .mockImplementationOnce(() => {
        throw new Error('injected DB delete failure');
      });
    const audioDelete = vi.spyOn(audio, 'deleteSession');

    await expect(service.deleteSession(sessionId)).rejects.toThrow('injected DB delete failure');

    expect(audioDelete).not.toHaveBeenCalled();
    expect(sessions.getSession(sessionId)).not.toBeNull();
    await expect(access(path.join(audio.rootDirectory, attempt.audioRef!))).resolves.toBeUndefined();
    repositoryDelete.mockRestore();
  });

  it('uses one read/delete/reset barrier so clear waits for audio reads and rejects new ones', async () => {
    const sessionId = await createStartedSession();
    await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([4, 2, 4, 2]),
      mimeType: 'audio/webm',
      durationMs: 35_000,
    });
    const realRead = audio.read.bind(audio);
    let markReadStarted!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    vi.spyOn(audio, 'read').mockImplementationOnce(async (audioRef) => {
      markReadStarted();
      await readGate;
      return realRead(audioRef);
    });

    const reading = service.readAttemptAudio({ sessionId, kind: 'initial' });
    await readStarted;
    let clearSettled = false;
    const clearing = service.clearTrainingData().finally(() => {
      clearSettled = true;
    });
    await Promise.resolve();
    expect(clearSettled).toBe(false);
    expect(sessions.getSession(sessionId)).not.toBeNull();
    await expect(service.readAttemptAudio({ sessionId, kind: 'initial' }))
      .rejects.toMatchObject({ code: 'TRAINING_DATA_RESET_IN_PROGRESS' });

    releaseRead();
    await expect(reading).resolves.toMatchObject({
      bytes: new Uint8Array([4, 2, 4, 2]),
      mimeType: 'audio/webm',
    });
    await expect(clearing).resolves.toBe(1);
    expect(clearSettled).toBe(true);
  });

  it('cleans both recordings on completion while retaining honest attempt metadata', async () => {
    const sessionId = await createStartedSession();
    await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/webm',
      durationMs: 74_000,
    });
    await service.transitionSession(sessionId, { type: 'confirm_first_attempt' });
    await service.transitionSession(sessionId, { type: 'confirm_transcript' });
    await service.transitionSession(sessionId, { type: 'continue_to_focus' });
    const focusedSession = service.getSession(sessionId)!;
    const storedAttempt = focusedSession.attempts.find((attempt) => attempt.kind === 'initial')!;
    const focus = listFrozenPracticeFocusOptions(
      focusedSession.taskSnapshot,
      focusedSession.modeVersion,
    )[0]!;
    const frozenAt = '2026-07-16T03:10:00.000Z';
    const segmentId = `${storedAttempt.id}-segment-1`;
    const snapshot: AttemptSnapshot = {
      schemaVersion: 1,
      id: `${storedAttempt.id}-snapshot`,
      sessionId,
      attemptId: storedAttempt.id,
      generation: 1,
      kind: 'initial',
      frozenAt,
      audioWatermark: 3_000,
      transcriptVersion: 1,
      finalSegments: [{
        id: segmentId,
        attemptId: storedAttempt.id,
        sequence: 0,
        revision: 1,
        text: '本周应冻结新增需求。',
        startMs: 0,
        endMs: 3_000,
        confidence: null,
        isFinal: true,
        emittedAt: frozenAt,
        finalizedAt: frozenAt,
        modelVersion: 'lifecycle-test-1',
      }],
      annotations: [],
      hints: [],
      metrics: {
        finalCharacters: 10,
        finalSegments: 1,
        fillers: 0,
        hedges: 0,
        vagueWords: 0,
        repetitions: 0,
        selfCorrections: 0,
        algorithmVersion: 'local-rules-1',
      },
      focusVersion: null,
    };
    service.putArtifact({
      type: 'attempt_snapshot',
      sessionId,
      id: snapshot.id,
      payload: snapshot,
    });
    const report = buildLocalDeepReport({
      id: `${storedAttempt.id}-report`,
      snapshot,
      at: frozenAt,
      focus: {
        criterionId: focus.criterionId,
        label: focus.criterionLabel,
        drillId: focus.drillId,
        drill: focus.drillTemplate,
      },
    });
    service.putArtifact({ type: 'deep_report', sessionId, id: report.id, payload: report });
    await service.transitionSession(sessionId, {
      type: 'select_focus',
      diagnosisReportId: report.id,
      focus: {
        criterionId: focus.criterionId,
        drillId: focus.drillId,
        label: focus.criterionLabel,
        guidanceSource: 'self_directed',
        evidenceIds: [],
      },
    });
    const drillCompletion = {
      id: `${sessionId}-drill-completion`,
      snapshotId: snapshot.id,
      focusVersion: 1,
      criterionId: focus.criterionId,
      drillId: focus.drillId,
      rehearsalNote: '',
      selfChecked: true as const,
      startedAt: '2026-07-16T03:10:01.000Z',
      completedAt: '2026-07-16T03:10:02.000Z',
      durationMs: 1_000,
    };
    service.putArtifact({
      type: 'drill_completion',
      sessionId,
      id: drillCompletion.id,
      payload: drillCompletion,
    });
    await service.transitionSession(sessionId, { type: 'complete_drill' });
    const retryAttempt = await service.saveAttemptAudio({
      sessionId,
      kind: 'retry',
      bytes: new Uint8Array([4, 5, 6]),
      mimeType: 'audio/webm',
      durationMs: 42_000,
    });
    const retrySnapshot = snapshotForAttempt({
      sessionId,
      attemptId: retryAttempt.id,
      kind: 'retry',
      id: `${retryAttempt.id}-snapshot`,
      text: '我的建议是本周冻结新增需求，并明确下一步。',
      focusVersion: drillCompletion.focusVersion,
    });
    service.putArtifact({
      type: 'attempt_snapshot',
      sessionId,
      id: retrySnapshot.id,
      payload: retrySnapshot,
    });
    await service.transitionSession(sessionId, { type: 'confirm_second_attempt' });

    const comparison = compareFrozenAttempts({
      id: `${sessionId}-paired-comparison`,
      initial: snapshot,
      retry: retrySnapshot,
      criterionId: focus.criterionId,
      comparisonDimension: focus.comparisonDimension,
      at: '2026-07-16T03:20:00.000Z',
    });
    service.putArtifact({
      type: 'attempt_comparison',
      sessionId,
      id: comparison.id,
      payload: comparison,
    });
    const completed = await service.transitionSession(sessionId, {
      type: 'view_comparison',
      comparisonArtifactId: comparison.id,
    });

    expect(completed.status).toBe('completed');
    expect(completed.outcome).toBe('practice_loop_completed');
    expect(completed.attempts).toHaveLength(2);
    expect(completed.attempts.every((attempt) => attempt.audioRef === null)).toBe(true);
    await expect(access(path.join(audio.rootDirectory, sessionId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      service.readAttemptAudio({ sessionId, kind: 'initial' }),
    ).rejects.toMatchObject({ code: 'AUDIO_NOT_AVAILABLE' });
  });

  it('finishes a confirmed free retry without viewing comparison and applies terminal audio cleanup', async () => {
    const sessionId = await createStartedSession();
    await advanceToSecondAttempt(sessionId);
    const retryAttempt = await service.saveAttemptAudio({
      sessionId,
      kind: 'retry',
      bytes: new Uint8Array([4, 5, 6]),
      mimeType: 'audio/webm',
      durationMs: 31_000,
    });
    const retrySnapshot = snapshotForAttempt({
      sessionId,
      attemptId: retryAttempt.id,
      kind: 'retry',
      id: `${retryAttempt.id}-free-retry-snapshot`,
      text: '我的建议是本周冻结新增需求。',
      focusVersion: null,
    });
    service.putArtifact({
      type: 'attempt_snapshot',
      sessionId,
      id: retrySnapshot.id,
      payload: retrySnapshot,
    });
    await service.transitionSession(sessionId, { type: 'confirm_second_attempt' });

    const completed = await service.transitionSession(sessionId, {
      type: 'finish_retry_without_comparison',
    });

    expect(completed).toMatchObject({
      status: 'completed',
      outcome: 'free_retry_completed',
      comparisonViewedAt: null,
    });
    expect(completed.attempts).toHaveLength(2);
    expect(completed.attempts.every((attempt) => (
      attempt.status === 'confirmed' && attempt.audioRef === null
    ))).toBe(true);
    expect(service.getSession(sessionId)).toEqual(completed);
    await expect(access(path.join(audio.rootDirectory, sessionId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('promotes audio out of TTL storage only when retention was selected beforehand', async () => {
    service.updateSettings({ audioRetention: 'keep_with_session' });
    const sessionId = await createStartedSession();
    await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([7, 7, 7]),
      mimeType: 'audio/webm',
      durationMs: 32_000,
    });
    await service.transitionSession(sessionId, { type: 'confirm_first_attempt' });
    await service.transitionSession(sessionId, { type: 'confirm_transcript' });
    const diagnosis = persistDiagnosisForInitialAttempt({ sessionId });

    const completed = await service.transitionSession(sessionId, {
      type: 'finish_analysis_only',
      diagnosisReportId: diagnosis.report.id,
    });

    expect(completed.outcome).toBe('analysis_only');
    expect(completed.attempts[0]?.audioRef).toMatch(/^retained\//u);
    expect([...(await service.readAttemptAudio({ sessionId, kind: 'initial' })).bytes]).toEqual([
      7, 7, 7,
    ]);
    await expect(access(path.join(audio.rootDirectory, sessionId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('renames retained audio back when the terminal DB update fails', async () => {
    service.updateSettings({ audioRetention: 'keep_with_session' });
    const sessionId = await createStartedSession();
    const attempt = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([6, 6, 6]),
      mimeType: 'audio/webm',
      durationMs: 32_000,
    });
    await service.transitionSession(sessionId, { type: 'confirm_first_attempt' });
    await service.transitionSession(sessionId, { type: 'confirm_transcript' });
    const diagnosis = persistDiagnosisForInitialAttempt({ sessionId });
    const updateSpy = vi
      .spyOn(sessions, 'updateSession')
      .mockImplementationOnce(() => {
        throw new Error('injected terminal DB failure');
      });

    await expect(
      service.transitionSession(sessionId, {
        type: 'finish_analysis_only',
        diagnosisReportId: diagnosis.report.id,
      }),
    ).rejects.toThrow('injected terminal DB failure');

    updateSpy.mockRestore();
    expect(sessions.getSession(sessionId)?.status).toBe('diagnosis');
    expect(sessions.getAttempt(sessionId, 'initial')?.audioRef).toBe(attempt.audioRef);
    await expect(access(path.join(audio.rootDirectory, attempt.audioRef!))).resolves.toBeUndefined();
    await expect(access(path.join(audio.retainedRootDirectory, sessionId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('commits default completion before best-effort deletion and sweeps residue on restart', async () => {
    const sessionId = await createStartedSession();
    const attempt = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([8, 8, 8]),
      mimeType: 'audio/webm',
      durationMs: 32_000,
    });
    await service.transitionSession(sessionId, { type: 'confirm_first_attempt' });
    await service.transitionSession(sessionId, { type: 'confirm_transcript' });
    const diagnosis = persistDiagnosisForInitialAttempt({ sessionId });
    const deleteSpy = vi
      .spyOn(audio, 'deleteSession')
      .mockRejectedValueOnce(new Error('injected file deletion failure'));

    const completed = await service.transitionSession(sessionId, {
      type: 'finish_analysis_only',
      diagnosisReportId: diagnosis.report.id,
    });

    expect(completed.status).toBe('completed');
    expect(completed.attempts[0]?.audioRef).toBeNull();
    await expect(access(path.join(audio.rootDirectory, attempt.audioRef!))).resolves.toBeUndefined();
    deleteSpy.mockRestore();

    const restarted = new PracticeSessionService(sessions, audio, {
      now: () => new Date((tick += 1_000)),
    });
    await restarted.initialize();
    await expect(access(path.join(audio.rootDirectory, attempt.audioRef!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('repairs a crash-time retain rename whose DB commit never happened', async () => {
    const sessionId = await createStartedSession();
    const attempt = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([5, 5, 5]),
      mimeType: 'audio/webm',
      durationMs: 32_000,
    });
    await audio.retainSession(sessionId);

    const restarted = new PracticeSessionService(sessions, audio, {
      now: () => new Date((tick += 1_000)),
    });
    await restarted.initialize();

    expect(sessions.getSession(sessionId)?.status).toBe('first_attempt');
    await expect(access(path.join(audio.rootDirectory, attempt.audioRef!))).resolves.toBeUndefined();
    await expect(access(path.join(audio.retainedRootDirectory, sessionId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('abandons an active session and clears DB refs when TTL removes its audio', async () => {
    const sessionId = await createStartedSession();
    const attempt = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([4, 4, 4]),
      mimeType: 'audio/webm',
      durationMs: 32_000,
    });
    const absolutePath = path.join(audio.rootDirectory, attempt.audioRef!);
    await utimes(absolutePath, new Date(0), new Date(0));

    const deleted = await service.cleanupExpiredAudio();
    const reconciled = sessions.getSession(sessionId)!;

    expect(deleted).toContain(attempt.audioRef);
    expect(reconciled.status).toBe('abandoned');
    expect(reconciled.outcome).toBe('practice_loop_abandoned');
    expect(reconciled.attempts[0]?.audioRef).toBeNull();
  });

  it('reconciles a DB audio reference whose file disappeared before TTL', async () => {
    const sessionId = await createStartedSession();
    const attempt = await service.saveAttemptAudio({
      sessionId,
      kind: 'initial',
      bytes: new Uint8Array([9, 9, 9]),
      mimeType: 'audio/webm',
      durationMs: 32_000,
    });
    await rm(path.join(audio.rootDirectory, attempt.audioRef!));

    const restarted = new PracticeSessionService(sessions, audio, {
      now: () => new Date((tick += 1_000)),
    });
    await restarted.initialize();
    const reconciled = sessions.getSession(sessionId)!;

    expect(reconciled.status).toBe('abandoned');
    expect(reconciled.outcome).toBe('practice_loop_abandoned');
    expect(reconciled.attempts[0]?.audioRef).toBeNull();
  });
});
