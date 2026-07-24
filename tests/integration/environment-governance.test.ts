// @vitest-environment node

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AudioRepository } from '../../src/backend/repositories/audio-repository';
import { SessionRepository } from '../../src/backend/repositories/session-repository';
import {
  EnvironmentService,
  type EnvironmentServiceOptions,
} from '../../src/backend/services/environment-service';
import { LocalAsrService } from '../../src/backend/services/local-asr-service';
import { PracticeSessionService } from '../../src/backend/services/practice-session-service';
import {
  DEFAULT_APP_SETTINGS,
  LOCAL_ASR_MODEL_FILE_NAMES,
  createLiveAttemptState,
  freezeAttemptSnapshot,
  reduceLiveAttempt,
} from '../../src/shared';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phrio-environment-test-'));
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

describe('environment status and local data governance', () => {
  it('deletes cloud audit first and preserves the local graph when cloud deletion fails', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const repository = new SessionRepository(path.join(dataDirectory, 'phrio.sqlite3'));
    const audio = new AudioRepository(path.join(dataDirectory, 'temporary-audio'));
    const practice = new PracticeSessionService(repository, audio, {
      createId: () => 'session-cloud-delete-failure',
      now: () => new Date('2026-07-18T02:00:00.000Z'),
    });
    await practice.initialize();
    const session = practice.createSession({
      modeId: 'clear-expression',
      taskId: 'free-expression',
      customTask: {
        prompt: '验证清除顺序。',
        audience: '自己',
        objective: '不留下半删除状态',
        durationSeconds: 60,
      },
    });
    const clearLocal = vi.spyOn(practice, 'clearTrainingData');
    const deleteTrainingAuditData = vi.fn(() => {
      throw new Error('cloud audit unavailable');
    });
    const environment = new EnvironmentService(
      practice,
      new LocalAsrService(path.join(dataDirectory, 'models')),
      dataDirectory,
      {
        cloudDataGovernance: {
          deleteTrainingAuditData,
          resetConsentData: vi.fn(),
        },
      },
    );

    try {
      await expect(environment.clearTrainingData()).rejects.toThrow('cloud audit unavailable');
      expect(deleteTrainingAuditData).toHaveBeenCalledOnce();
      expect(clearLocal).not.toHaveBeenCalled();
      expect(repository.getSession(session.id)).not.toBeNull();
    } finally {
      repository.close();
    }
  });

  it('keeps cloud audit deleted when local audio cleanup fails after record deletion', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const repository = new SessionRepository(path.join(dataDirectory, 'phrio.sqlite3'));
    const audio = new AudioRepository(path.join(dataDirectory, 'temporary-audio'));
    const practice = new PracticeSessionService(repository, audio, {
      createId: () => 'session-audio-delete-failure',
      now: () => new Date('2026-07-18T02:30:00.000Z'),
    });
    await practice.initialize();
    practice.createSession({
      modeId: 'clear-expression',
      taskId: 'free-expression',
      customTask: {
        prompt: '验证音频清理失败。',
        audience: '自己',
        objective: '云端审计仍先删除',
        durationSeconds: 60,
      },
    });
    vi.spyOn(audio, 'deleteAllTrainingAudio').mockRejectedValue(new Error('audio busy'));
    const calls: string[] = [];
    const deleteTrainingAuditData = vi.fn(() => calls.push('cloud-audit-deleted'));
    const environment = new EnvironmentService(
      practice,
      new LocalAsrService(path.join(dataDirectory, 'models')),
      dataDirectory,
      {
        cloudDataGovernance: {
          deleteTrainingAuditData,
          resetConsentData: vi.fn(),
        },
      },
    );

    try {
      await expect(environment.clearTrainingData()).rejects.toMatchObject({
        code: 'TRAINING_AUDIO_CLEANUP_FAILED',
      });
      expect(calls).toEqual(['cloud-audit-deleted']);
      expect(deleteTrainingAuditData).toHaveBeenCalledOnce();
      expect(repository.countSessions()).toBe(0);
    } finally {
      repository.close();
    }
  });

  it('deletes one Session through the cloud cancellation/audit boundary before local removal', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const repository = new SessionRepository(path.join(dataDirectory, 'phrio.sqlite3'));
    const audio = new AudioRepository(path.join(dataDirectory, 'temporary-audio'));
    const ids = ['session-delete', 'attempt-delete'];
    const practice = new PracticeSessionService(repository, audio, {
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-07-18T03:00:00.000Z'),
    });
    await practice.initialize();
    const localAsr = new LocalAsrService(path.join(dataDirectory, 'models'));
    const session = practice.createSession({
      modeId: 'clear-expression',
      taskId: 'free-expression',
      customTask: {
        prompt: '说明需要删除的练习。',
        audience: '自己',
        objective: '验证删除边界',
        durationSeconds: 60,
      },
    });
    await practice.transitionSession(session.id, { type: 'start_practice' });
    const attempt = await practice.saveAttemptAudio({
      sessionId: session.id,
      kind: 'initial',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/webm',
      durationMs: 1_000,
    });
    const calls: string[] = [];
    const deleteSessionAuditData = vi.fn(() => calls.push('cloud-audit'));
    const sessionDeletionGate = vi.fn();
    const runWithSessionDataDeletion = async <T>(
      scope: { readonly sessionId: string; readonly attemptIds: readonly string[] },
      operation: () => Promise<T> | T,
    ): Promise<T> => {
      sessionDeletionGate(scope);
      calls.push('cloud-gate');
      expect(scope).toEqual({ sessionId: session.id, attemptIds: [attempt.id] });
      return operation();
    };
    const environment = new EnvironmentService(practice, localAsr, dataDirectory, {
      cloudDataGovernance: {
        deleteTrainingAuditData: vi.fn(),
        deleteSessionAuditData,
        resetConsentData: vi.fn(),
      },
      cloudRequestLifecycle: {
        runWithTrainingDataReset: async <T>(operation: () => Promise<T> | T) => operation(),
        runWithSessionDataDeletion,
      },
    });

    try {
      await expect(environment.deletePracticeSession(session.id)).resolves.toBe(true);
      expect(calls).toEqual(['cloud-gate', 'cloud-audit']);
      expect(sessionDeletionGate).toHaveBeenCalledOnce();
      expect(deleteSessionAuditData).toHaveBeenCalledWith(session.id, [attempt.id]);
      expect(repository.getSession(session.id)).toBeNull();
      await expect(stat(path.join(audio.rootDirectory, session.id))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      repository.close();
    }
  });

  it('reports the narrow environment and clears only the complete training graph', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const repository = new SessionRepository(path.join(dataDirectory, 'phrio.sqlite3'));
    const audio = new AudioRepository(path.join(dataDirectory, 'temporary-audio'));
    const ids = ['session-governance', 'attempt-governance'];
    const practice = new PracticeSessionService(repository, audio, {
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-07-18T04:00:00.000Z'),
    });
    await practice.initialize();

    const localAsr = new LocalAsrService(path.join(dataDirectory, 'models'));
    await mkdir(localAsr.modelDirectory, { recursive: true });
    await Promise.all(
      LOCAL_ASR_MODEL_FILE_NAMES.map((name) =>
        writeFile(path.join(localAsr.modelDirectory, name), 'model-fixture'),
      ),
    );
    const exportFile = path.join(dataDirectory, 'exports', 'practice-summary.json');
    await mkdir(path.dirname(exportFile), { recursive: true });
    await writeFile(exportFile, '{}');

    try {
      const session = practice.createSession({
        modeId: 'clear-expression',
        taskId: 'free-expression',
        customTask: {
          prompt: '向产品团队说明本周的取舍。',
          audience: '产品团队',
          objective: '明确优先级与下一步',
          durationSeconds: 60,
        },
      });
      await practice.transitionSession(session.id, { type: 'start_practice' });
      const attempt = await practice.saveAttemptAudio({
        sessionId: session.id,
        kind: 'initial',
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: 'audio/webm',
        durationMs: 1_000,
      });

      let live = createLiveAttemptState({
        sessionId: session.id,
        attemptId: attempt.id,
        generation: 1,
        kind: 'initial',
      });
      live = reduceLiveAttempt(live, {
        id: 'event-recording-started',
        generation: 1,
        type: 'recording_started',
      });
      live = reduceLiveAttempt(live, {
        id: 'event-final-segment',
        generation: 1,
        type: 'segment',
        segment: {
          id: `${attempt.id}-seg-0`,
          attemptId: attempt.id,
          sequence: 0,
          revision: 1,
          text: '本周先完成真实录音与转写闭环。',
          startMs: 0,
          endMs: 1_000,
          confidence: null,
          isFinal: true,
          emittedAt: '2026-07-18T04:00:00.500Z',
          finalizedAt: '2026-07-18T04:00:00.500Z',
          modelVersion: 'test-1',
        },
      });
      live = reduceLiveAttempt(live, {
        id: 'event-stop-requested',
        generation: 1,
        type: 'stop_requested',
        audioWatermark: 1_000,
      });
      live = reduceLiveAttempt(live, {
        id: 'event-tail-complete',
        generation: 1,
        type: 'tail_complete',
      });
      const snapshot = freezeAttemptSnapshot({
        state: live,
        snapshotId: 'snapshot-governance',
        frozenAt: '2026-07-18T04:00:01.000Z',
        transcriptVersion: 1,
      });
      practice.putArtifact({
        type: 'attempt_snapshot',
        sessionId: session.id,
        id: snapshot.id,
        payload: snapshot,
      });

      const retainedResidue = path.join(
        audio.retainedRootDirectory,
        session.id,
        'retained.webm',
      );
      await mkdir(path.dirname(retainedResidue), { recursive: true });
      await writeFile(retainedResidue, 'retained-audio-fixture');

      practice.updateSettings({
        theme: 'dark',
        favoriteTaskIds: ['free-expression'],
        onboardingCompleted: true,
      });
      const cloudDataGovernance = {
        deleteTrainingAuditData: vi.fn(),
        resetConsentData: vi.fn(),
      };
      const runWithTrainingDataReset = vi.fn();
      const cloudRequestLifecycle: NonNullable<
        EnvironmentServiceOptions['cloudRequestLifecycle']
      > = {
        async runWithTrainingDataReset<T>(
          operation: () => Promise<T> | T,
        ): Promise<T> {
          runWithTrainingDataReset();
          return operation();
        },
      };
      const environment = new EnvironmentService(
        practice,
        localAsr,
        dataDirectory,
        {
          now: () => new Date('2026-07-18T04:00:02.000Z'),
          cloudDataGovernance,
          cloudRequestLifecycle,
        },
      );

      await expect(environment.getStatus()).resolves.toEqual({
        checkedAt: '2026-07-18T04:00:02.000Z',
        dataDirectory: path.resolve(dataDirectory),
        trainingRecordCount: 1,
        localAsr: {
          state: 'missing',
          ready: false,
          files: LOCAL_ASR_MODEL_FILE_NAMES.map((name) => ({
            name,
            exists: true,
            readable: true,
          })),
        },
      });

      await expect(environment.clearTrainingData()).resolves.toEqual({
        trainingDataCleared: true,
        deletedTrainingRecordCount: 1,
        diagnosticLogs: {
          status: 'cleared',
          deletedFileCount: 0,
          deletedBytes: 0,
          remainingFileCount: 0,
          remainingBytes: 0,
        },
        modelsPreserved: true,
        externalExportsPreserved: true,
        otherUserDataPreserved: true,
      });

      expect(repository.countSessions()).toBe(0);
      expect(repository.countAttemptsForSession(session.id)).toBe(0);
      expect(repository.listArtifacts(session.id)).toEqual([]);
      expect(await readdir(audio.rootDirectory)).toEqual([]);
      expect(await readdir(audio.retainedRootDirectory)).toEqual([]);
      expect((await stat(exportFile)).isFile()).toBe(true);
      for (const name of LOCAL_ASR_MODEL_FILE_NAMES) {
        expect((await stat(path.join(localAsr.modelDirectory, name))).isFile()).toBe(true);
      }
      expect(practice.getSettings()).toMatchObject({
        theme: 'dark',
        favoriteTaskIds: ['free-expression'],
        onboardingCompleted: true,
      });
      expect(cloudDataGovernance.deleteTrainingAuditData).toHaveBeenCalledOnce();
      expect(runWithTrainingDataReset).toHaveBeenCalledOnce();

      const resetCalls: string[] = [];
      const supersedePending = vi
        .spyOn(practice, 'supersedePendingCloudArtifactsForConsentReset')
        .mockImplementation(() => {
          resetCalls.push('artifacts-superseded');
          return 0;
        });
      cloudDataGovernance.resetConsentData.mockImplementation(() => {
        resetCalls.push('consent-audit-reset');
      });
      await expect(environment.resetNonSensitiveSettings()).resolves.toEqual({
        ...DEFAULT_APP_SETTINGS,
        onboardingCompleted: true,
      });
      expect(resetCalls).toEqual(['artifacts-superseded', 'consent-audit-reset']);
      expect(supersedePending).toHaveBeenCalledOnce();
      expect(cloudDataGovernance.resetConsentData).toHaveBeenCalledOnce();
      expect(runWithTrainingDataReset).toHaveBeenCalledTimes(2);
    } finally {
      repository.close();
    }
  });

  it('distinguishes missing local model files from readable files', async () => {
    const root = await createTemporaryDirectory();
    const localAsr = new LocalAsrService(path.join(root, 'models'));
    await mkdir(localAsr.modelDirectory, { recursive: true });
    await writeFile(path.join(localAsr.modelDirectory, 'tokens.txt'), 'tokens');

    await expect(localAsr.inspectModelFiles()).resolves.toEqual([
      { name: 'encoder.int8.onnx', exists: false, readable: false },
      { name: 'decoder.int8.onnx', exists: false, readable: false },
      { name: 'tokens.txt', exists: true, readable: true },
    ]);
  });
});
