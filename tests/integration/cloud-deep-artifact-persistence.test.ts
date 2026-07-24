// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionRepository } from '../../src/backend/repositories/session-repository';
import { taskContextForCloudAi } from '../../src/frontend/services/cloud-ai-api';
import {
  GATE_C_PM_TASK,
  createPracticeSession,
  createQueuedCloudDeepDiagnosis,
  transitionCloudDeepDiagnosis,
} from '../../src/shared';

const temporaryDirectories: string[] = [];
const t0 = '2026-07-18T02:00:00.000Z';
const t1 = '2026-07-18T02:00:01.000Z';
const t2 = '2026-07-18T02:00:02.000Z';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('cloud Deep diagnosis persistence', () => {
  it('migrates a v3 artifact table and round-trips a completed exact-payload run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'phrio-cloud-deep-db-'));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, 'phrio.sqlite3');
    const session = createPracticeSession({
      id: 'session-cloud-deep',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: t0,
    });

    const initial = new SessionRepository(databasePath);
    initial.createSession(session);
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP INDEX practice_artifacts_session_index;
      ALTER TABLE practice_artifacts RENAME TO practice_artifacts_current;
      CREATE TABLE practice_artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
        artifact_type TEXT NOT NULL CHECK (artifact_type IN (
          'attempt_snapshot', 'transcript_correction', 'deep_report',
          'drill_completion', 'attempt_comparison'
        )),
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      DROP TABLE practice_artifacts_current;
      CREATE INDEX practice_artifacts_session_index ON practice_artifacts(session_id, artifact_type);
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const task = taskContextForCloudAi(session);
    const drill = task.drills[0]!;
    const criterion = task.rubric.find(
      (candidate) => candidate.criterionId === drill.criterionId,
    )!;
    const queued = createQueuedCloudDeepDiagnosis({
      payload: {
        schemaVersion: 'deep-diagnosis-1',
        purpose: 'deep_diagnosis',
        analysisInputId: 'analysis-cloud-deep',
        sessionId: session.id,
        attemptId: 'attempt-cloud-deep',
        snapshotId: 'snapshot-cloud-deep',
        transcriptVersion: 1,
        task,
        finalSegments: [{
          id: 'segment-cloud-deep',
          sequence: 0,
          revision: 1,
          startMs: 0,
          endMs: 4_000,
          text: '我建议本周先冻结新增需求。',
        }],
        corrections: [],
        localEvidence: [],
        metrics: {
          words: 14,
          fillers: 0,
          hedges: 0,
          vagueWords: 0,
          repetitions: 0,
          selfCorrections: 0,
        },
      },
      payloadHash: 'a'.repeat(64),
      consentId: 'consent-cloud-deep',
      at: t0,
    });
    const complete = transitionCloudDeepDiagnosis(
      transitionCloudDeepDiagnosis(queued, { status: 'processing', at: t1 }),
      {
        status: 'complete',
        at: t2,
        result: {
          judgment: '本轮结论清楚，理由仍可更具体。',
          observations: [{
            type: 'quote',
            criterionId: criterion.criterionId,
            segmentId: 'segment-cloud-deep',
            evidence: '首句“我建议本周先冻结新增需求”给出了建议。',
            suggestion: '补充关键资源约束。',
            confidence: 'high',
          }],
          focus: {
            criterionId: criterion.criterionId,
            label: criterion.label,
            reason: '先巩固这一条当前 Rubric。',
            drillId: drill.drillId,
            drill: drill.template,
          },
        },
      },
    );

    const migrated = new SessionRepository(databasePath);
    migrated.putArtifact({
      type: 'cloud_deep_diagnosis',
      sessionId: session.id,
      id: 'cloud-deep-analysis-cloud-deep',
      payload: complete,
    });
    migrated.close();

    const reopened = new SessionRepository(databasePath);
    expect(reopened.listArtifacts(session.id)).toEqual([{
      type: 'cloud_deep_diagnosis',
      sessionId: session.id,
      id: 'cloud-deep-analysis-cloud-deep',
      payload: complete,
    }]);
    reopened.close();

    const versionCheck = new DatabaseSync(databasePath, { readOnly: true });
    expect(versionCheck.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
    versionCheck.close();
  });
});
