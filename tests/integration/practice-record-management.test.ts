// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AudioRepository } from '../../src/backend/repositories/audio-repository';
import { SessionRepository } from '../../src/backend/repositories/session-repository';
import { PracticeSessionService } from '../../src/backend/services/practice-session-service';
import type { AttemptSnapshot } from '../../src/shared';

let root: string;
let sessions: SessionRepository;
let service: PracticeSessionService;
let idCounter: number;
let clock: number;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'phrio-record-management-'));
  sessions = new SessionRepository(path.join(root, 'phrio.sqlite3'));
  idCounter = 0;
  clock = Date.parse('2026-07-21T08:00:00.000Z');
  service = new PracticeSessionService(
    sessions,
    new AudioRepository(path.join(root, 'audio')),
    {
      createId: () => `record-session-${++idCounter}`,
      now: () => new Date((clock += 1_000)),
    },
  );
  await service.initialize();
});

afterEach(async () => {
  sessions.close();
  await rm(root, { recursive: true, force: true });
});

async function createStartedSession(): Promise<string> {
  const created = service.createSession({
    modeId: 'decision-alignment',
    taskId: 'freeze-new-requirements',
    developmentFixture: false,
  });
  await service.transitionSession(created.id, { type: 'start_practice' });
  return created.id;
}

function snapshot(input: {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly snapshotId: string;
  readonly kind?: 'initial' | 'retry';
  readonly text: string;
}): AttemptSnapshot {
  const at = '2026-07-21T08:10:00.000Z';
  return {
    schemaVersion: 1,
    id: input.snapshotId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    generation: 1,
    kind: input.kind ?? 'initial',
    frozenAt: at,
    audioWatermark: 3_000,
    transcriptVersion: 1,
    finalSegments: [{
      id: `${input.attemptId}-segment-0`,
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
      modelVersion: 'record-management-test-1',
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
    focusVersion: input.kind === 'retry' ? 1 : null,
  };
}

function putSnapshot(value: AttemptSnapshot): void {
  service.putArtifact({
    type: 'attempt_snapshot',
    id: value.id,
    sessionId: value.sessionId,
    payload: value,
  });
}

describe('practice record metadata lifecycle', () => {
  it('names a record from the first frozen sentence and never lets retry overwrite it', async () => {
    const sessionId = await createStartedSession();
    putSnapshot(snapshot({
      sessionId,
      attemptId: 'attempt-initial-title',
      snapshotId: 'snapshot-initial-title',
      text: '先冻结本周新增需求。然后解释两个原因。',
    }));

    expect(service.getSession(sessionId)).toMatchObject({
      recordTitle: '先冻结本周新增需求。',
      recordTitleSource: 'first_final',
    });

    putSnapshot(snapshot({
      sessionId,
      attemptId: 'attempt-retry-title',
      snapshotId: 'snapshot-retry-title',
      kind: 'retry',
      text: '这次复讲更清楚。',
    }));
    expect(service.getSession(sessionId)?.recordTitle).toBe('先冻结本周新增需求。');
  });

  it('preserves a user rename across idempotent snapshot retries and initial discard', async () => {
    const sessionId = await createStartedSession();
    const initial = snapshot({
      sessionId,
      attemptId: 'attempt-user-title',
      snapshotId: 'snapshot-user-title',
      text: '自动生成的标题。',
    });
    putSnapshot(initial);
    await service.updateSessionRecord({
      sessionId,
      action: 'rename',
      title: '周会决策复盘',
    });

    putSnapshot(initial);
    await service.discardAttemptAudio({
      sessionId,
      kind: 'initial',
      attemptId: initial.attemptId,
    });
    expect(service.getSession(sessionId)).toMatchObject({
      recordTitle: '周会决策复盘',
      recordTitleSource: 'user',
    });
  });

  it('replaces an automatic title after the initial take is discarded and recorded again', async () => {
    const sessionId = await createStartedSession();
    const first = snapshot({
      sessionId,
      attemptId: 'attempt-auto-old',
      snapshotId: 'snapshot-auto-old',
      text: '这遍会被丢弃。',
    });
    putSnapshot(first);
    await service.discardAttemptAudio({
      sessionId,
      kind: 'initial',
      attemptId: first.attemptId,
    });
    expect(service.getSession(sessionId)).toMatchObject({
      recordTitle: null,
      recordTitleSource: null,
    });

    putSnapshot(snapshot({
      sessionId,
      attemptId: 'attempt-auto-new',
      snapshotId: 'snapshot-auto-new',
      text: '新的第一句话。后面还有内容。',
    }));
    expect(service.getSession(sessionId)).toMatchObject({
      recordTitle: '新的第一句话。',
      recordTitleSource: 'first_final',
    });
  });

  it('rejects a late snapshot after its stopped take was discarded', async () => {
    const sessionId = await createStartedSession();
    const discarded = snapshot({
      sessionId,
      attemptId: 'attempt-discarded-late',
      snapshotId: 'snapshot-discarded-late',
      text: '这句话不应在丢弃后复活。',
    });
    putSnapshot(discarded);
    await service.discardAttemptAudio({
      sessionId,
      kind: 'initial',
      attemptId: discarded.attemptId,
    });
    sessions.close();
    sessions = new SessionRepository(path.join(root, 'phrio.sqlite3'));
    service = new PracticeSessionService(
      sessions,
      new AudioRepository(path.join(root, 'audio')),
      {
        createId: () => `record-session-${++idCounter}`,
        now: () => new Date((clock += 1_000)),
      },
    );
    await service.initialize();

    expect(() => putSnapshot(discarded)).toThrowError(expect.objectContaining({
      code: 'ATTEMPT_DISCARDED',
    }));
    await expect(service.saveAttemptAudio({
      sessionId,
      attemptId: discarded.attemptId,
      kind: 'initial',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/webm',
      durationMs: 1_000,
    })).rejects.toMatchObject({ code: 'ATTEMPT_DISCARDED' });
    expect(service.listArtifacts(sessionId)).toEqual([]);
    expect(service.getSession(sessionId)).toMatchObject({
      recordTitle: null,
      recordTitleSource: null,
    });
  });

  it('keeps the new first sentence when an older discarded snapshot arrives last', async () => {
    const sessionId = await createStartedSession();
    const oldSnapshot = snapshot({
      sessionId,
      attemptId: 'attempt-interleaved-old',
      snapshotId: 'snapshot-interleaved-old',
      text: '旧录音的第一句话。',
    });
    putSnapshot(oldSnapshot);
    await service.discardAttemptAudio({
      sessionId,
      kind: 'initial',
      attemptId: oldSnapshot.attemptId,
    });
    const newSnapshot = snapshot({
      sessionId,
      attemptId: 'attempt-interleaved-new',
      snapshotId: 'snapshot-interleaved-new',
      text: '新录音才是当前第一句话。后面继续展开。',
    });
    putSnapshot(newSnapshot);

    expect(() => putSnapshot(oldSnapshot)).toThrowError(expect.objectContaining({
      code: 'ATTEMPT_DISCARDED',
    }));
    expect(service.getSession(sessionId)).toMatchObject({
      recordTitle: '新录音才是当前第一句话。',
      recordTitleSource: 'first_final',
    });
    expect(service.listArtifacts(sessionId).map((artifact) => artifact.id)).toEqual([
      newSnapshot.id,
    ]);
  });

  it('keeps record metadata when a stale workflow graph is saved later', async () => {
    const sessionId = await createStartedSession();
    const staleGraph = service.getSession(sessionId)!;
    putSnapshot(snapshot({
      sessionId,
      attemptId: 'attempt-stale-graph',
      snapshotId: 'snapshot-stale-graph',
      text: '自动标题不会被旧状态覆盖。',
    }));
    await service.updateSessionRecord({
      sessionId,
      action: 'set_pinned',
      pinned: true,
    });

    sessions.updateSession({
      ...staleGraph,
      updatedAt: '2026-07-21T08:30:00.000Z',
    });
    expect(service.getSession(sessionId)).toMatchObject({
      recordTitle: '自动标题不会被旧状态覆盖。',
      recordTitleSource: 'first_final',
      pinnedAt: expect.any(String),
    });
  });

  it('rolls record title initialization back when the snapshot artifact cannot be inserted', async () => {
    const ownerId = await createStartedSession();
    const targetId = await createStartedSession();
    putSnapshot(snapshot({
      sessionId: ownerId,
      attemptId: 'attempt-artifact-owner',
      snapshotId: 'snapshot-shared-record-id',
      text: '归属方标题。',
    }));

    expect(() => putSnapshot(snapshot({
      sessionId: targetId,
      attemptId: 'attempt-artifact-target',
      snapshotId: 'snapshot-shared-record-id',
      text: '不应该留下的标题。',
    }))).toThrowError(expect.objectContaining({ code: 'ARTIFACT_ID_CONFLICT' }));
    expect(service.getSession(targetId)).toMatchObject({
      recordTitle: null,
      recordTitleSource: null,
    });
  });

  it('orders pinned records first, keeps repeated pin idempotent, and restores activity order', async () => {
    const olderId = await createStartedSession();
    const newerId = await createStartedSession();
    expect(service.listSessions().map((session) => session.id)).toEqual([newerId, olderId]);

    const pinned = await service.updateSessionRecord({
      sessionId: olderId,
      action: 'set_pinned',
      pinned: true,
    });
    const firstPinnedAt = pinned.pinnedAt;
    expect(service.listSessions().map((session) => session.id)).toEqual([olderId, newerId]);

    const repeated = await service.updateSessionRecord({
      sessionId: olderId,
      action: 'set_pinned',
      pinned: true,
    });
    expect(repeated.pinnedAt).toBe(firstPinnedAt);

    await service.updateSessionRecord({
      sessionId: olderId,
      action: 'set_pinned',
      pinned: false,
    });
    expect(service.listSessions().map((session) => session.id)).toEqual([newerId, olderId]);
  });
});
