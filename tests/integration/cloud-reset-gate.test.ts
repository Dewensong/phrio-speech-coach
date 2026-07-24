// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AudioRepository } from '../../src/backend/repositories/audio-repository';
import { CloudAiRepository } from '../../src/backend/repositories/cloud-ai-repository';
import { SessionRepository } from '../../src/backend/repositories/session-repository';
import {
  CloudAiService,
  CloudAiServiceError,
  type CloudAiSecretStore,
} from '../../src/backend/services/cloud-ai-service';
import { EnvironmentService } from '../../src/backend/services/environment-service';
import { LocalAsrService } from '../../src/backend/services/local-asr-service';
import { PracticeSessionService } from '../../src/backend/services/practice-session-service';
import {
  buildDeepDiagnosisPayload,
  createQueuedCloudDeepDiagnosis,
  createLiveAttemptState,
  freezeAttemptSnapshot,
  reduceLiveAttempt,
  transitionCloudDeepDiagnosis,
} from '../../src/shared';

const temporaryDirectories: string[] = [];

class TestSecretStore implements CloudAiSecretStore {
  isEncryptionAvailable(): boolean {
    return true;
  }

  async getStatus(): Promise<{
    readonly configured: boolean;
    readonly keyHint: string | null;
    readonly keyStorage: 'system_encrypted';
  }> {
    return { configured: true, keyHint: '••••0000', keyStorage: 'system_encrypted' };
  }

  async save(): Promise<void> {}

  async read(): Promise<string> {
    return 'test-openai-reset-key-000000000000';
  }

  async delete(): Promise<void> {}
}

function completedResponse(value: unknown): Response {
  return new Response(JSON.stringify({
    id: 'resp-reset-late',
    status: 'completed',
    output: [{
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }],
    }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('cloud request gate during training-data reset', () => {
  it('waits for a late request, deletes its audit, and rejects artifact recreation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'phrio-cloud-reset-'));
    temporaryDirectories.push(root);
    const sessionRepository = new SessionRepository(path.join(root, 'phrio.sqlite3'));
    const audioRepository = new AudioRepository(path.join(root, 'temporary-audio'));
    const ids = ['session-reset', 'attempt-reset'];
    const practice = new PracticeSessionService(sessionRepository, audioRepository, {
      createId: () => ids.shift() ?? 'unexpected-practice-id',
      now: () => new Date('2026-07-18T09:00:00.000Z'),
    });
    await practice.initialize();

    const cloudDatabasePath = path.join(root, 'cloud-ai.sqlite3');
    const cloudRepository = new CloudAiRepository(cloudDatabasePath);
    let resolveLate!: (response: Response) => void;
    let requestSignal: AbortSignal | null = null;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const network = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init?.signal ?? null;
      markFetchStarted();
      return new Promise<Response>((resolve) => {
        resolveLate = resolve;
      });
    });
    let cloudId = 0;
    const cloud = new CloudAiService(cloudRepository, new TestSecretStore(), {
      fetch: network,
      createId: () => `cloud-reset-${++cloudId}`,
      now: () => new Date('2026-07-18T09:00:01.000Z'),
    });
    const localAsr = new LocalAsrService(path.join(root, 'models'));
    const environment = new EnvironmentService(practice, localAsr, root, {
      cloudDataGovernance: cloudRepository,
      cloudRequestLifecycle: cloud,
    });

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
        bytes: new Uint8Array([1, 2, 3]),
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
          id: 'segment-reset-1',
          attemptId: attempt.id,
          sequence: 0,
          revision: 1,
          text: '我建议先冻结新增需求。',
          startMs: 0,
          endMs: 1_000,
          confidence: null,
          isFinal: true,
          emittedAt: '2026-07-18T09:00:00.250Z',
          finalizedAt: '2026-07-18T09:00:00.250Z',
          modelVersion: 'controlled-test-1',
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
        snapshotId: 'snapshot-reset',
        frozenAt: '2026-07-18T09:00:00.500Z',
        transcriptVersion: 1,
      });
      const snapshotArtifact = {
        type: 'attempt_snapshot' as const,
        sessionId: session.id,
        id: snapshot.id,
        payload: snapshot,
      };
      practice.putArtifact(snapshotArtifact);

      const payload = buildDeepDiagnosisPayload({
        session: practice.getSession(session.id)!,
        snapshot,
        corrections: [],
        analysisInputId: 'analysis-reset',
      });
      const prepared = cloud.prepareConsent({ purpose: payload.purpose, payload });
      const consent = cloud.approveConsent({
        preparationId: prepared.preparationId,
        purpose: prepared.purpose,
        payloadHash: prepared.payloadHash,
        policyHash: prepared.policyHash,
        approvedFields: prepared.approvedFields,
      });

      const queuedDiagnosis = createQueuedCloudDeepDiagnosis({
        payload,
        payloadHash: prepared.payloadHash!,
        consentId: consent.id,
        at: '2026-07-18T09:00:01.000Z',
      });
      const processingDiagnosis = transitionCloudDeepDiagnosis(queuedDiagnosis, {
        status: 'processing',
        at: '2026-07-18T09:00:02.000Z',
      });
      const cloudArtifact = {
        type: 'cloud_deep_diagnosis' as const,
        sessionId: session.id,
        id: 'cloud-deep-analysis-reset',
        payload: processingDiagnosis,
      };
      practice.putArtifact({
        ...cloudArtifact,
        payload: queuedDiagnosis,
      });
      practice.putArtifact(cloudArtifact);

      const pending = cloud.executeDeepDiagnosis({ payload, consentId: consent.id });
      const pendingError = pending.catch((error: unknown) => error);
      let clearing!: ReturnType<EnvironmentService['clearTrainingData']>;
      const lateArtifactWrite = pending.catch(async (error: unknown) => {
        const failedDiagnosis = transitionCloudDeepDiagnosis(processingDiagnosis, {
          status: 'failed',
          at: '2026-07-18T09:00:03.000Z',
          errorCode: error instanceof CloudAiServiceError
            ? error.code
            : 'DEEP_DIAGNOSIS_FAILED',
        });
        // IPC delivery can trail the main-process request settlement. Force the
        // renderer-like write to arrive after the destructive transaction.
        await clearing;
        try {
          practice.putArtifact({ ...cloudArtifact, payload: failedDiagnosis });
          return 'recreated' as const;
        } catch {
          return 'blocked' as const;
        }
      });
      await fetchStarted;
      expect(cloudRepository.listRequests()).toHaveLength(1);

      let clearSettled = false;
      clearing = environment.clearTrainingData().finally(() => {
        clearSettled = true;
      });
      await vi.waitFor(() => {
        expect(requestSignal).toMatchObject({
          aborted: true,
          reason: 'training_data_reset',
        });
      });
      await Promise.resolve();
      expect(clearSettled).toBe(false);

      await expect(cloud.executeDeepDiagnosis({ payload, consentId: consent.id }))
        .rejects.toMatchObject({ code: 'TRAINING_DATA_RESET_IN_PROGRESS' });
      expect(() => cloud.prepareConsent({ purpose: payload.purpose, payload }))
        .toThrowError(CloudAiServiceError);
      expect(network).toHaveBeenCalledOnce();

      resolveLate(completedResponse({
        judgment: '迟到结果不得保留。',
        observations: [],
        focus: {
          criterionId: 'conclusion-first',
          label: '结论先行',
          reason: '继续巩固结论先行。',
          drillId: 'conclusion-drill',
          drill: '我建议……',
        },
      }));
      await expect(pendingError).resolves.toMatchObject({
        code: 'RESULT_DISCARDED',
        detail: 'training_data_reset',
      });
      await expect(clearing).resolves.toMatchObject({ deletedTrainingRecordCount: 1 });
      await expect(lateArtifactWrite).resolves.toBe('blocked');

      expect(sessionRepository.countSessions()).toBe(0);
      expect(sessionRepository.listArtifacts(session.id)).toEqual([]);
      expect(cloudRepository.listRequests()).toEqual([]);
      expect(cloudRepository.listConsents('deep_diagnosis')).toEqual([]);
      const auditDatabase = new DatabaseSync(cloudDatabasePath, { readOnly: true });
      try {
        expect(auditDatabase.prepare('SELECT COUNT(*) AS count FROM analysis_inputs').get())
          .toEqual({ count: 0 });
      } finally {
        auditDatabase.close();
      }

      // The deleted parent session remains an additional write barrier even for
      // any other late lifecycle artifact writer.
      expect(() => practice.putArtifact(snapshotArtifact)).toThrowError();
      expect(sessionRepository.listArtifacts(session.id)).toEqual([]);

      await expect(cloud.executeDeepDiagnosis({ payload, consentId: consent.id }))
        .rejects.toMatchObject({ code: 'CONSENT_NOT_FOUND' });
      expect(cloudRepository.listRequests()).toEqual([]);
      expect(network).toHaveBeenCalledOnce();
    } finally {
      cloudRepository.close();
      sessionRepository.close();
    }
  });

  it('supersedes resumable artifacts before resetting consent and keeps the terminal history on reload', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'phrio-cloud-consent-reset-'));
    temporaryDirectories.push(root);
    const sessionRepository = new SessionRepository(path.join(root, 'phrio.sqlite3'));
    const audioRepository = new AudioRepository(path.join(root, 'temporary-audio'));
    const ids = ['session-consent-reset', 'attempt-consent-reset'];
    const practice = new PracticeSessionService(sessionRepository, audioRepository, {
      createId: () => ids.shift() ?? 'unexpected-practice-id',
      now: () => new Date('2026-07-18T10:00:00.000Z'),
    });
    await practice.initialize();
    const cloudDatabasePath = path.join(root, 'cloud-ai.sqlite3');
    const cloudRepository = new CloudAiRepository(cloudDatabasePath);
    let cloudId = 0;
    const cloud = new CloudAiService(cloudRepository, new TestSecretStore(), {
      fetch: vi.fn(),
      createId: () => `cloud-consent-reset-${++cloudId}`,
      now: () => new Date('2026-07-18T10:00:01.000Z'),
    });
    const environment = new EnvironmentService(
      practice,
      new LocalAsrService(path.join(root, 'models')),
      root,
      {
        cloudDataGovernance: cloudRepository,
        cloudRequestLifecycle: cloud,
      },
    );

    try {
      const session = practice.createSession({
        modeId: 'clear-expression',
        taskId: 'free-expression',
        customTask: {
          prompt: '说明设置重置的影响。',
          audience: '产品团队',
          objective: '确保云端处理中状态可终结',
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
      let live = createLiveAttemptState({
        sessionId: session.id,
        attemptId: attempt.id,
        generation: 1,
        kind: 'initial',
      });
      live = reduceLiveAttempt(live, {
        id: 'event-consent-reset-recording',
        generation: 1,
        type: 'recording_started',
      });
      live = reduceLiveAttempt(live, {
        id: 'event-consent-reset-final',
        generation: 1,
        type: 'segment',
        segment: {
          id: 'segment-consent-reset-1',
          attemptId: attempt.id,
          sequence: 0,
          revision: 1,
          text: '我建议先终结旧的云端处理状态。',
          startMs: 0,
          endMs: 1_000,
          confidence: null,
          isFinal: true,
          emittedAt: '2026-07-18T10:00:00.250Z',
          finalizedAt: '2026-07-18T10:00:00.250Z',
          modelVersion: 'controlled-test-1',
        },
      });
      live = reduceLiveAttempt(live, {
        id: 'event-consent-reset-stop',
        generation: 1,
        type: 'stop_requested',
        audioWatermark: 1_000,
      });
      live = reduceLiveAttempt(live, {
        id: 'event-consent-reset-tail',
        generation: 1,
        type: 'tail_complete',
      });
      const snapshot = freezeAttemptSnapshot({
        state: live,
        snapshotId: 'snapshot-consent-reset',
        frozenAt: '2026-07-18T10:00:00.500Z',
        transcriptVersion: 1,
      });
      practice.putArtifact({
        type: 'attempt_snapshot',
        sessionId: session.id,
        id: snapshot.id,
        payload: snapshot,
      });
      const payload = buildDeepDiagnosisPayload({
        session: practice.getSession(session.id)!,
        snapshot,
        corrections: [],
        analysisInputId: 'analysis-consent-reset',
      });
      const prepared = cloud.prepareConsent({ purpose: payload.purpose, payload });
      const consent = cloud.approveConsent({
        preparationId: prepared.preparationId,
        purpose: prepared.purpose,
        payloadHash: prepared.payloadHash,
        policyHash: prepared.policyHash,
        approvedFields: prepared.approvedFields,
      });
      const queued = createQueuedCloudDeepDiagnosis({
        payload,
        payloadHash: prepared.payloadHash!,
        consentId: consent.id,
        at: '2026-07-18T10:00:01.000Z',
      });
      const artifactId = 'cloud-deep-analysis-consent-reset';
      practice.putArtifact({
        type: 'cloud_deep_diagnosis',
        sessionId: session.id,
        id: artifactId,
        payload: queued,
      });
      expect(cloudRepository.listConsents('deep_diagnosis')).toHaveLength(1);

      await expect(environment.resetNonSensitiveSettings()).resolves.toBeDefined();

      const terminal = practice.listArtifacts(session.id).find(
        (artifact) => artifact.id === artifactId,
      );
      expect(terminal).toMatchObject({
        type: 'cloud_deep_diagnosis',
        payload: {
          status: 'superseded',
          supersededReason: 'consent_reset',
        },
      });
      expect(cloudRepository.listConsents()).toEqual([]);
      expect(cloudRepository.listRequests()).toEqual([]);
      const auditDatabase = new DatabaseSync(cloudDatabasePath, { readOnly: true });
      try {
        expect(auditDatabase.prepare('SELECT COUNT(*) AS count FROM analysis_inputs').get())
          .toEqual({ count: 0 });
      } finally {
        auditDatabase.close();
      }
      expect(() => practice.assertCloudExecutionApproved(payload, consent.id))
        .toThrowError(expect.objectContaining({ code: 'ARTIFACT_REFERENCE_NOT_FOUND' }));

      const reloadedPractice = new PracticeSessionService(
        sessionRepository,
        audioRepository,
        { now: () => new Date('2026-07-18T10:00:02.000Z') },
      );
      expect(reloadedPractice.listArtifacts(session.id).find(
        (artifact) => artifact.id === artifactId,
      )).toMatchObject({
        payload: { status: 'superseded', supersededReason: 'consent_reset' },
      });
    } finally {
      cloudRepository.close();
      sessionRepository.close();
    }
  });
});
