// @vitest-environment node

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AudioRepository } from '../../src/backend/repositories/audio-repository';
import { SessionRepository } from '../../src/backend/repositories/session-repository';
import { DiagnosticLogService } from '../../src/backend/services/diagnostic-log-service';
import { EnvironmentService } from '../../src/backend/services/environment-service';
import { LocalAsrService } from '../../src/backend/services/local-asr-service';
import { PracticeSessionService } from '../../src/backend/services/practice-session-service';
import { DiagnosticBundleSchema } from '../../src/shared';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phrio-diagnostic-governance-'));
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

describe('diagnostic data governance', () => {
  it('clears local diagnostic logs with training data while preserving an explicit export', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const repository = new SessionRepository(path.join(dataDirectory, 'phrio.sqlite3'));
    const audio = new AudioRepository(path.join(dataDirectory, 'temporary-audio'));
    const practice = new PracticeSessionService(repository, audio, {
      createId: () => 'session-diagnostic-clear',
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });
    await practice.initialize();
    const session = practice.createSession({
      modeId: 'clear-expression',
      taskId: 'free-expression',
      customTask: {
        prompt: '验证训练数据和诊断日志一起清除。',
        audience: '测试人员',
        objective: '确认本机数据治理边界',
        durationSeconds: 60,
      },
    });
    const diagnostics = new DiagnosticLogService(path.join(dataDirectory, 'diagnostics'), {
      appVersion: '0.1.0-test',
      createId: () => 'diagnostic-governance-id',
      now: () => new Date('2026-07-18T12:00:01.000Z'),
      monotonicNow: () => 10,
      platform: 'darwin',
      architecture: 'arm64',
    });
    diagnostics.record({
      level: 'info',
      component: 'session',
      event: 'session.created',
      sessionId: session.id,
      fields: { modeId: 'clear-expression' },
    });
    const exportPath = path.join(dataDirectory, 'exports', 'phrio-diagnostics.json');
    diagnostics.exportBundle(exportPath);
    const deleteTrainingAuditData = vi.fn();
    const environment = new EnvironmentService(
      practice,
      new LocalAsrService(path.join(dataDirectory, 'models')),
      dataDirectory,
      {
        cloudDataGovernance: {
          deleteTrainingAuditData,
          resetConsentData: vi.fn(),
        },
        diagnosticDataGovernance: diagnostics,
      },
    );

    try {
      expect(diagnostics.getStatus()).toMatchObject({ fileCount: 1 });
      await expect(environment.clearTrainingData()).resolves.toMatchObject({
        deletedTrainingRecordCount: 1,
        externalExportsPreserved: true,
      });

      expect(deleteTrainingAuditData).toHaveBeenCalledOnce();
      expect(repository.countSessions()).toBe(0);
      expect(diagnostics.getStatus()).toMatchObject({
        fileCount: 0,
        totalBytes: 0,
        bufferedEventCount: 0,
      });
      await expect(stat(exportPath)).resolves.toBeDefined();
      expect(
        DiagnosticBundleSchema.parse(JSON.parse(await readFile(exportPath, 'utf8'))).events,
      ).toHaveLength(1);
    } finally {
      repository.close();
    }
  });

  it('reports training data as cleared while keeping failed diagnostic deletion retryable', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const repository = new SessionRepository(path.join(dataDirectory, 'phrio.sqlite3'));
    const audio = new AudioRepository(path.join(dataDirectory, 'temporary-audio'));
    const practice = new PracticeSessionService(repository, audio, {
      createId: () => 'session-diagnostic-retry',
      now: () => new Date('2026-07-18T12:10:00.000Z'),
    });
    await practice.initialize();
    practice.createSession({
      modeId: 'clear-expression',
      taskId: 'free-expression',
      customTask: {
        prompt: '验证诊断日志清除失败后的重试。',
        audience: '测试人员',
        objective: '保留准确的部分完成事实',
        durationSeconds: 60,
      },
    });
    let failUnlinkOnce = true;
    const diagnostics = new DiagnosticLogService(path.join(dataDirectory, 'diagnostics'), {
      appVersion: '0.1.0-test',
      createId: () => 'diagnostic-retry-id',
      now: () => new Date('2026-07-18T12:10:01.000Z'),
      monotonicNow: () => 10,
      unlinkFile: (filePath) => {
        if (failUnlinkOnce) {
          failUnlinkOnce = false;
          throw Object.assign(new Error('injected unlink failure'), { code: 'EBUSY' });
        }
        unlinkSync(filePath);
      },
    });
    diagnostics.record({
      level: 'info',
      component: 'session',
      event: 'session.created',
      fields: { modeId: 'clear-expression' },
    });
    const deleteTrainingAuditData = vi.fn();
    const environment = new EnvironmentService(
      practice,
      new LocalAsrService(path.join(dataDirectory, 'models')),
      dataDirectory,
      {
        cloudDataGovernance: {
          deleteTrainingAuditData,
          resetConsentData: vi.fn(),
        },
        diagnosticDataGovernance: diagnostics,
      },
    );

    try {
      await expect(environment.clearTrainingData()).resolves.toMatchObject({
        trainingDataCleared: true,
        deletedTrainingRecordCount: 1,
        diagnosticLogs: {
          status: 'retry_required',
          deletedFileCount: 0,
          remainingFileCount: 1,
        },
      });
      expect(repository.countSessions()).toBe(0);
      expect(diagnostics.getStatus()).toMatchObject({ fileCount: 1 });

      await expect(environment.clearTrainingData()).resolves.toMatchObject({
        trainingDataCleared: true,
        deletedTrainingRecordCount: 0,
        diagnosticLogs: {
          status: 'cleared',
          deletedFileCount: 1,
          remainingFileCount: 0,
        },
      });
      expect(diagnostics.getStatus()).toMatchObject({ fileCount: 0, totalBytes: 0 });
      expect(deleteTrainingAuditData).toHaveBeenCalledTimes(2);
    } finally {
      repository.close();
    }
  });
});
