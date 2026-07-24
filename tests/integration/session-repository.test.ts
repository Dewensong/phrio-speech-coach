// @vitest-environment node

import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_APP_SETTINGS,
  GATE_C_PM_TASK,
  P1_MODE_PACKS,
  PracticeSessionSchema,
  createPracticeSession,
  createQueuedCloudSemanticComparison,
  createLiveAttemptState,
  freezeAttemptSnapshot,
  getPrimaryPracticeFocus,
  reconcileFinalTailAnnotations,
  reduceLiveAttempt,
  transitionCloudSemanticComparison,
  transitionSession,
  type Attempt,
  type AttemptSnapshot,
  type TranscriptSegment,
} from '../../src/shared';
import { SessionRepository } from '../../src/backend/repositories/session-repository';
import { buildSemanticComparisonPayload } from '../../src/frontend/services/cloud-ai-api';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phrio-session-db-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('SessionRepository', () => {
  it('hardens the SQLite directory, DB, WAL and SHM permissions', async () => {
    const root = await createTemporaryDirectory();
    const dataDirectory = path.join(root, 'permissive-data');
    const databasePath = path.join(dataDirectory, 'phrio.sqlite3');
    await mkdir(dataDirectory, { mode: 0o777 });
    await chmod(dataDirectory, 0o777);

    const repository = new SessionRepository(databasePath);
    repository.createSession(
      createPracticeSession({
        id: 'session-permissions',
        modeVersion: '0.1.0-dev.1',
        task: GATE_C_PM_TASK,
        now: '2026-07-16T03:00:00.000Z',
      }),
    );

    expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
    const databaseFiles = await readdir(dataDirectory);
    expect(databaseFiles).toEqual(
      expect.arrayContaining(['phrio.sqlite3', 'phrio.sqlite3-wal', 'phrio.sqlite3-shm']),
    );
    for (const fileName of databaseFiles.filter((name) => name.startsWith('phrio.sqlite3'))) {
      expect((await stat(path.join(dataDirectory, fileName))).mode & 0o777).toBe(0o600);
    }
    repository.close();
  });

  it('persists a session graph and cascades attempt deletion', async () => {
    const root = await createTemporaryDirectory();
    const databasePath = path.join(root, 'data', 'phrio.sqlite3');
    const repository = new SessionRepository(databasePath);
    const created = createPracticeSession({
      id: 'session-persisted',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-16T03:00:00.000Z',
    });
    repository.createSession(created);
    const started = transitionSession(created, { type: 'start_practice' }, '2026-07-16T03:00:01.000Z');
    const attempt: Attempt = {
      id: 'attempt-persisted',
      sessionId: created.id,
      kind: 'initial',
      status: 'recorded',
      audioRef: 'session-persisted/attempt-persisted.webm',
      mimeType: 'audio/webm',
      durationMs: 45_000,
      byteLength: 4,
      createdAt: '2026-07-16T03:00:02.000Z',
      updatedAt: '2026-07-16T03:00:02.000Z',
      confirmedAt: null,
    };
    repository.updateSession({ ...started, attempts: [attempt] });
    repository.close();

    const reopened = new SessionRepository(databasePath);
    expect(reopened.getSession(created.id)).toMatchObject({
      id: created.id,
      status: 'first_attempt',
      attempts: [{ id: attempt.id, audioRef: attempt.audioRef }],
    });
    expect(reopened.getSettings()).toEqual(DEFAULT_APP_SETTINGS);
    expect(reopened.deleteSession(created.id)).toBe(true);
    expect(reopened.getSession(created.id)).toBeNull();
    expect(reopened.countAttemptsForSession(created.id)).toBe(0);
    reopened.close();
  });

  it('round-trips the exact diagnosis and comparison artifacts chosen for the Session path', async () => {
    const root = await createTemporaryDirectory();
    const databasePath = path.join(root, 'phrio.sqlite3');
    const repository = new SessionRepository(databasePath);
    const created = createPracticeSession({
      id: 'session-diagnosis-report',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-16T03:00:00.000Z',
    });
    repository.createSession(created);
    repository.updateSession(PracticeSessionSchema.parse({
      ...created,
      diagnosisReportId: 'deep-report-selected',
      comparisonArtifactId: 'paired-comparison-selected',
      comparisonViewedAt: '2026-07-16T03:00:01.000Z',
      updatedAt: '2026-07-16T03:00:01.000Z',
    }));
    repository.close();

    const reopened = new SessionRepository(databasePath);
    expect(reopened.getSession(created.id)?.diagnosisReportId).toBe('deep-report-selected');
    expect(reopened.getSession(created.id)?.comparisonArtifactId).toBe('paired-comparison-selected');
    reopened.close();
    const versionCheck = new DatabaseSync(databasePath, { readOnly: true });
    expect(versionCheck.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
    versionCheck.close();
  });

  it('migrates an intermediate v6 database to the exact comparison identity column', async () => {
    const root = await createTemporaryDirectory();
    const databasePath = path.join(root, 'phrio-v6.sqlite3');
    const repository = new SessionRepository(databasePath);
    const created = createPracticeSession({
      id: 'session-v6-comparison-migration',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-16T03:00:00.000Z',
    });
    repository.createSession(created);
    repository.close();

    const v6 = new DatabaseSync(databasePath);
    v6.exec(`
      ALTER TABLE practice_sessions DROP COLUMN comparison_artifact_id;
      PRAGMA user_version = 6;
    `);
    v6.close();

    const migrated = new SessionRepository(databasePath);
    expect(migrated.getSession(created.id)?.comparisonArtifactId).toBeNull();
    migrated.close();
    const versionCheck = new DatabaseSync(databasePath, { readOnly: true });
    expect(versionCheck.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
    expect(
      versionCheck.prepare('PRAGMA table_info(practice_sessions)').all(),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'comparison_artifact_id' }),
    ]));
    versionCheck.close();
  });

  it('migrates v7 record metadata and backfills the initial frozen first sentence', async () => {
    const root = await createTemporaryDirectory();
    const databasePath = path.join(root, 'phrio-v7-record-metadata.sqlite3');
    const repository = new SessionRepository(databasePath);
    const session = createPracticeSession({
      id: 'session-v7-record-title',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-17T03:00:00.000Z',
    });
    repository.createSession(session);
    const snapshot: AttemptSnapshot = {
      schemaVersion: 1,
      id: 'snapshot-v7-record-title',
      sessionId: session.id,
      attemptId: 'attempt-v7-record-title',
      generation: 1,
      kind: 'initial',
      frozenAt: '2026-07-17T03:00:03.000Z',
      audioWatermark: 3_000,
      transcriptVersion: 1,
      finalSegments: [{
        id: 'attempt-v7-record-title-segment-0',
        attemptId: 'attempt-v7-record-title',
        sequence: 0,
        revision: 1,
        text: '这是旧记录的第一句话。这里是后续内容。',
        startMs: 0,
        endMs: 3_000,
        confidence: null,
        isFinal: true,
        emittedAt: '2026-07-17T03:00:03.000Z',
        finalizedAt: '2026-07-17T03:00:03.000Z',
        modelVersion: 'migration-test-1',
      }],
      annotations: [],
      hints: [],
      metrics: {
        finalCharacters: 20,
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
    repository.putArtifact({
      type: 'attempt_snapshot',
      sessionId: session.id,
      id: snapshot.id,
      payload: snapshot,
    });
    repository.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP INDEX practice_sessions_history_index;
      ALTER TABLE practice_sessions DROP COLUMN pinned_at;
      ALTER TABLE practice_sessions DROP COLUMN record_title_source;
      ALTER TABLE practice_sessions DROP COLUMN record_title;
      PRAGMA user_version = 7;
    `);
    legacy.close();

    const migrated = new SessionRepository(databasePath);
    expect(migrated.getSession(session.id)).toMatchObject({
      recordTitle: '这是旧记录的第一句话。',
      recordTitleSource: 'first_final',
      pinnedAt: null,
    });
    migrated.close();

    const versionCheck = new DatabaseSync(databasePath, { readOnly: true });
    expect(versionCheck.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
    expect(versionCheck.prepare('PRAGMA index_list(practice_sessions)').all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'practice_sessions_history_index' })]),
    );
    versionCheck.close();
  });

  it('stores validated settings patches as a complete settings record', async () => {
    const root = await createTemporaryDirectory();
    const repository = new SessionRepository(path.join(root, 'phrio.sqlite3'));

    const updated = repository.updateSettings({
      ...DEFAULT_APP_SETTINGS,
      theme: 'dark',
      reducedMotion: true,
    });

    expect(updated.theme).toBe('dark');
    expect(updated.reducedMotion).toBe(true);
    repository.close();
  });

  it('migrates settings saved before local task favorites existed', async () => {
    const root = await createTemporaryDirectory();
    const databasePath = path.join(root, 'phrio.sqlite3');
    const repository = new SessionRepository(databasePath);
    repository.updateSettings(DEFAULT_APP_SETTINGS);
    repository.close();

    const database = new DatabaseSync(databasePath);
    const legacySettings = { ...DEFAULT_APP_SETTINGS } as Record<string, unknown>;
    delete legacySettings.favoriteTaskIds;
    database.prepare('UPDATE app_settings SET payload_json = ? WHERE singleton_id = 1')
      .run(JSON.stringify(legacySettings));
    database.close();

    const reopened = new SessionRepository(databasePath);
    expect(reopened.getSettings().favoriteTaskIds).toEqual([]);
    reopened.close();
  });

  it('persists frozen Fast snapshots for Deep Lane reload and cascades them with the session', async () => {
    const root = await createTemporaryDirectory();
    const databasePath = path.join(root, 'phrio.sqlite3');
    const repository = new SessionRepository(databasePath);
    const session = createPracticeSession({ id: 'session-artifacts', modeVersion: '0.1.0-dev.1', task: GATE_C_PM_TASK, now: '2026-07-17T03:00:00.000Z' });
    repository.createSession(session);
    let live = createLiveAttemptState({ sessionId: session.id, attemptId: 'attempt-artifacts', generation: 1, kind: 'initial' });
    live = reduceLiveAttempt(live, { id: 'event-start', generation: 1, type: 'recording_started' });
    const frozenFinal: TranscriptSegment = { id: 'attempt-artifacts-seg-0', attemptId: 'attempt-artifacts', sequence: 0, revision: 1, text: '我们先看一下当前情况。', startMs: 0, endMs: 3_000, confidence: null, isFinal: true, emittedAt: '2026-07-17T03:00:03.000Z', finalizedAt: '2026-07-17T03:00:03.000Z', modelVersion: 'test-1' };
    live = reduceLiveAttempt(live, { id: 'event-final', generation: 1, type: 'segment', segment: frozenFinal });
    const tailAnnotations = reconcileFinalTailAnnotations({
      finalSegments: [frozenFinal],
      existingAnnotations: [],
      startingOrdinal: 1,
      task: {
        requiredFields: session.taskSnapshot.requiredFields,
        successConditions: session.taskSnapshot.successConditions,
      },
    }).upserts;
    live = reduceLiveAttempt(live, { id: 'event-tail-annotations', generation: 1, type: 'annotations', segmentId: frozenFinal.id, annotations: tailAnnotations });
    live = reduceLiveAttempt(live, { id: 'event-stop', generation: 1, type: 'stop_requested', audioWatermark: 3_000 });
    live = reduceLiveAttempt(live, { id: 'event-tail', generation: 1, type: 'tail_complete' });
    const snapshot = freezeAttemptSnapshot({ state: live, snapshotId: 'snapshot-artifacts', frozenAt: '2026-07-17T03:00:04.000Z', transcriptVersion: 1 });
    repository.putArtifact({ type: 'attempt_snapshot', sessionId: session.id, id: snapshot.id, payload: snapshot });
    repository.close();

    const reopened = new SessionRepository(databasePath);
    expect(reopened.listArtifacts(session.id)).toEqual([
      expect.objectContaining({
        type: 'attempt_snapshot',
        id: snapshot.id,
        payload: expect.objectContaining({
          finalSegments: [expect.objectContaining({ text: '我们先看一下当前情况。' })],
          annotations: expect.arrayContaining([
            expect.objectContaining({ type: 'structure', displayId: 'O1', lifecycle: 'confirmed' }),
            expect.objectContaining({ type: 'task_gap', displayId: 'O2', lifecycle: 'confirmed' }),
          ]),
        }),
      }),
    ]);
    reopened.deleteSession(session.id);
    expect(reopened.listArtifacts(session.id)).toEqual([]);
    reopened.close();
  });

  it('rejects an artifact id collision across sessions instead of moving or corrupting history', async () => {
    const root = await createTemporaryDirectory();
    const repository = new SessionRepository(path.join(root, 'phrio.sqlite3'));
    const first = createPracticeSession({ id: 'session-artifact-owner-a', modeVersion: '0.1.0-dev.1', task: GATE_C_PM_TASK, now: '2026-07-17T03:00:00.000Z' });
    const second = createPracticeSession({ id: 'session-artifact-owner-b', modeVersion: '0.1.0-dev.1', task: GATE_C_PM_TASK, now: '2026-07-17T03:00:01.000Z' });
    repository.createSession(first);
    repository.createSession(second);

    let firstLive = createLiveAttemptState({ sessionId: first.id, attemptId: 'attempt-owner-a', generation: 1, kind: 'initial' });
    firstLive = reduceLiveAttempt(firstLive, { id: 'owner-a-start', generation: 1, type: 'recording_started' });
    firstLive = reduceLiveAttempt(firstLive, {
      id: 'owner-a-final',
      generation: 1,
      type: 'segment',
      segment: {
        id: 'attempt-owner-a-seg-0',
        attemptId: 'attempt-owner-a',
        sequence: 0,
        revision: 1,
        text: '这是一条用于验证归属冲突的 final。',
        startMs: 0,
        endMs: 1,
        confidence: null,
        isFinal: true,
        emittedAt: '2026-07-17T03:00:01.500Z',
        finalizedAt: '2026-07-17T03:00:01.500Z',
        modelVersion: 'test-1',
      },
    });
    firstLive = reduceLiveAttempt(firstLive, { id: 'owner-a-stop', generation: 1, type: 'stop_requested', audioWatermark: 1 });
    firstLive = reduceLiveAttempt(firstLive, { id: 'owner-a-tail', generation: 1, type: 'tail_complete' });
    const firstSnapshot = freezeAttemptSnapshot({ state: firstLive, snapshotId: 'shared-artifact-id', frozenAt: '2026-07-17T03:00:02.000Z', transcriptVersion: 1 });
    repository.putArtifact({ type: 'attempt_snapshot', sessionId: first.id, id: firstSnapshot.id, payload: firstSnapshot });

    const secondSnapshot = {
      ...firstSnapshot,
      sessionId: second.id,
      attemptId: 'attempt-owner-b',
      finalSegments: firstSnapshot.finalSegments.map((segment) => ({
        ...segment,
        attemptId: 'attempt-owner-b',
      })),
    };
    expect(() => repository.putArtifact({ type: 'attempt_snapshot', sessionId: second.id, id: secondSnapshot.id, payload: secondSnapshot }))
      .toThrowError(expect.objectContaining({ code: 'ARTIFACT_ID_CONFLICT' }));
    expect(repository.listArtifacts(first.id)).toHaveLength(1);
    expect(repository.listArtifacts(second.id)).toHaveLength(0);
    repository.close();
  });

  it('round-trips a completed cloud semantic comparison across a repository reload', async () => {
    const root = await createTemporaryDirectory();
    const databasePath = path.join(root, 'phrio.sqlite3');
    const repository = new SessionRepository(databasePath);
    const pack = P1_MODE_PACKS.find((candidate) => candidate.id === GATE_C_PM_TASK.modeId)!;
    const focus = getPrimaryPracticeFocus(GATE_C_PM_TASK.modeId, GATE_C_PM_TASK.id);
    const base = createPracticeSession({
      id: 'session-cloud-comparison-roundtrip',
      modeVersion: pack.version,
      task: GATE_C_PM_TASK,
      now: '2026-07-18T07:00:00.000Z',
    });
    const session = PracticeSessionSchema.parse({
      ...base,
      status: 'comparison',
      guidanceSource: 'self_directed',
      focus: {
        criterionId: focus.criterionId,
        drillId: focus.drillId,
        label: focus.criterionLabel,
        guidanceSource: 'self_directed',
        evidenceIds: [],
        selectedAt: '2026-07-18T07:00:01.000Z',
      },
      drillCompletedAt: '2026-07-18T07:00:02.000Z',
      attempts: (['initial', 'retry'] as const).map((kind) => ({
        id: `stored-${kind}-roundtrip`,
        sessionId: base.id,
        kind,
        status: 'confirmed' as const,
        audioRef: `audio/${kind}.webm`,
        mimeType: 'audio/webm',
        durationMs: 5_000,
        byteLength: 1_024,
        createdAt: '2026-07-18T07:00:00.000Z',
        updatedAt: '2026-07-18T07:00:00.000Z',
        confirmedAt: '2026-07-18T07:00:00.000Z',
      })),
    });
    const frozen = (kind: 'initial' | 'retry'): AttemptSnapshot => ({
      schemaVersion: 1,
      id: `snapshot-${kind}-roundtrip`,
      sessionId: session.id,
      attemptId: `frozen-${kind}-roundtrip`,
      generation: 1,
      kind,
      frozenAt: '2026-07-18T07:00:03.000Z',
      audioWatermark: 5_000,
      transcriptVersion: 1,
      finalSegments: [{
        id: `segment-${kind}-roundtrip`,
        attemptId: `frozen-${kind}-roundtrip`,
        sequence: 0,
        revision: 1,
        text: kind === 'initial' ? '我觉得可能应该冻结。' : '我的建议是本周冻结新增需求。',
        startMs: 0,
        endMs: 3_000,
        confidence: null,
        isFinal: true,
        emittedAt: '2026-07-18T07:00:03.000Z',
        finalizedAt: '2026-07-18T07:00:03.000Z',
        modelVersion: 'test-1',
      }],
      annotations: [],
      hints: [],
      focusVersion: kind === 'retry' ? 1 : null,
      metrics: {
        finalCharacters: 14,
        finalSegments: 1,
        fillers: 0,
        hedges: kind === 'initial' ? 1 : 0,
        vagueWords: 0,
        repetitions: 0,
        selfCorrections: 0,
        algorithmVersion: 'local-rules-1',
      },
    });
    const payload = buildSemanticComparisonPayload({
      session,
      initial: frozen('initial'),
      retry: frozen('retry'),
      criterionId: focus.criterionId,
      label: focus.criterionLabel,
      drillId: focus.drillId,
      corrections: [],
      analysisInputId: 'analysis-comparison-roundtrip',
    });
    const queued = createQueuedCloudSemanticComparison({
      payload,
      payloadHash: 'a'.repeat(64),
      consentId: 'consent-comparison-roundtrip',
      at: '2026-07-18T07:00:04.000Z',
    });
    const processing = transitionCloudSemanticComparison(queued, {
      status: 'processing',
      at: '2026-07-18T07:00:05.000Z',
    });
    const complete = transitionCloudSemanticComparison(processing, {
      status: 'complete',
      at: '2026-07-18T07:00:06.000Z',
      result: {
        result: 'improved',
        explanation: '复讲更直接地提出了建议。',
        initialEvidence: ['初讲用“可能”弱化了建议。'],
        retryEvidence: ['复讲用“我的建议”明确开头。'],
      },
    });
    repository.createSession(session);
    repository.putArtifact({
      type: 'cloud_semantic_comparison',
      sessionId: session.id,
      id: 'cloud-comparison-roundtrip',
      payload: complete,
    });
    repository.close();

    const reopened = new SessionRepository(databasePath);
    expect(reopened.listArtifacts(session.id)).toEqual([
      expect.objectContaining({
        type: 'cloud_semantic_comparison',
        payload: expect.objectContaining({
          status: 'complete',
          result: expect.objectContaining({ result: 'improved' }),
          approvedPayload: expect.objectContaining({
            focus: expect.objectContaining({ criterionId: focus.criterionId }),
          }),
        }),
      }),
    ]);
    reopened.close();
  });
});
