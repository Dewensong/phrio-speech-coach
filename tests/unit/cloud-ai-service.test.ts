// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  CloudAiService,
  CloudAiServiceError,
  canonicalJson,
  canonicalSha256,
  type CloudAiPersistence,
  type CloudAiSecretStore,
} from '../../src/backend/services/cloud-ai-service';
import {
  CloudAiRepository,
  type StoredAnalysisInput,
} from '../../src/backend/repositories/cloud-ai-repository';
import {
  APPROVED_AI_PROVIDER,
  APPROVED_LIVE_AI_POLICY,
  P1_MODE_PACKS,
  PracticeSessionSchema,
  createQueuedCloudDeepDiagnosis,
  createPracticeSession,
  transitionCloudDeepDiagnosis,
  type CloudAiConsent,
  type CloudAiRequestMetadata,
  type DeepDiagnosisPayload,
  type LiveAiPolicy,
  type LiveHintPayload,
  type PracticeSession,
  type SemanticComparisonPayload,
  type TranscriptSegment,
} from '../../src/shared';

class MemoryCloudAiPersistence implements CloudAiPersistence {
  readonly consents = new Map<string, CloudAiConsent>();
  readonly requests = new Map<string, CloudAiRequestMetadata>();
  readonly analysisInputs: StoredAnalysisInput[] = [];

  getConsent(id: string): CloudAiConsent | null {
    return this.consents.get(id) ?? null;
  }

  listConsents(purpose?: CloudAiConsent['purpose']): readonly CloudAiConsent[] {
    return [...this.consents.values()].filter((consent) => !purpose || consent.purpose === purpose);
  }

  putConsent(input: CloudAiConsent): CloudAiConsent {
    this.consents.set(input.id, input);
    return input;
  }

  revokeConsent(id: string, revokedAt: string): CloudAiConsent {
    const consent = this.consents.get(id);
    if (!consent) throw new Error('not found');
    const revoked = { ...consent, revokedAt };
    this.consents.set(id, revoked);
    return revoked;
  }

  putAnalysisInput(input: StoredAnalysisInput): StoredAnalysisInput {
    this.analysisInputs.push(input);
    return input;
  }

  putRequest(input: CloudAiRequestMetadata): CloudAiRequestMetadata {
    this.requests.set(input.id, input);
    return input;
  }

  listRequests(): readonly CloudAiRequestMetadata[] {
    return [...this.requests.values()];
  }
}

class MemorySecretStore implements CloudAiSecretStore {
  value: string | null = 'test-openai-service-key-000000000000';
  encryptionAvailable = true;

  isEncryptionAvailable(): boolean {
    return this.encryptionAvailable;
  }

  async getStatus(): Promise<{
    readonly configured: boolean;
    readonly keyHint: string | null;
    readonly keyStorage: 'system_encrypted' | 'local_private_file_unencrypted';
  }> {
    return {
      configured: this.value !== null,
      keyHint: this.value ? `••••${this.value.slice(-4)}` : null,
      keyStorage: this.encryptionAvailable
        ? 'system_encrypted'
        : 'local_private_file_unencrypted',
    };
  }

  async save(apiKey: string): Promise<void> {
    this.value = apiKey;
  }

  async read(): Promise<string> {
    if (!this.value) {
      throw Object.assign(new Error('secret body must never escape'), {
        code: 'API_KEY_NOT_CONFIGURED',
      });
    }
    return this.value;
  }

  async delete(): Promise<void> {
    this.value = null;
  }
}

const task = {
  modeId: 'clear-expression',
  taskId: 'weekly-scope',
  taskVersion: '1.0.0',
  prompt: '向团队说明本周取舍。',
  audience: '产品团队',
  objective: '明确取舍和下一步',
  background: '本周资源有限。',
  sourceMaterial: '',
  counterArgument: '',
  roleContext: '周会',
  successConditions: ['先给结论', '说明一个理由'],
  rubric: [{
    criterionId: 'conclusion-first',
    label: '结论先行',
    description: '先给出可执行结论。',
  }],
  drills: [{
    drillId: 'conclusion-drill',
    criterionId: 'conclusion-first',
    title: '一句话结论',
    instruction: '先只说结论。',
    template: '我建议……',
    successCondition: '第一句出现明确建议。',
  }],
} as const;

function makePolicy(): LiveAiPolicy {
  return {
    ...APPROVED_LIVE_AI_POLICY,
    sentFieldPaths: [...APPROVED_LIVE_AI_POLICY.sentFieldPaths],
  };
}

function makeLiveTask() {
  return {
    modeId: task.modeId,
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    prompt: task.prompt,
    audience: task.audience,
    objective: task.objective,
    rubric: task.rubric.map((criterion) => ({ ...criterion })),
  };
}

function makeLivePayload(
  policyHash: string,
  overrides: Partial<LiveHintPayload> = {},
): LiveHintPayload {
  const text = '我建议本周先冻结新增需求，集中完成已经承诺的交付，同时向相关方同步原因和明确下一步。';
  return {
    schemaVersion: 'live-hint-1',
    purpose: 'live_hint',
    sessionId: 'session-live',
    attemptId: 'attempt-live',
    generation: 1,
    phaseEpoch: 1,
    transcriptVersion: 1,
    requestSequence: 1,
    policyHash,
    task: makeLiveTask(),
    finalWindow: {
      text,
      segmentRevisions: [{
        id: 'segment-1',
        sequence: 0,
        revision: 1,
        startMs: 0,
        endMs: 4_000,
        text,
      }],
    },
    ...overrides,
  };
}

function makeLiveSession(
  sessionId: string,
  liveTask: LiveHintPayload['task'] = makeLiveTask(),
): PracticeSession {
  const mode = P1_MODE_PACKS.find((candidate) => candidate.id === liveTask.modeId)!;
  const baseTask = mode.tasks[0]!;
  const baseCriterion = mode.criteria[0]!;
  const baseDrill = mode.drills[0]!;
  const criterionIds = liveTask.rubric.map((criterion) => criterion.criterionId);
  const drillIds = criterionIds.map((criterionId, index) => `${criterionId}-test-drill-${index}`);
  const created = createPracticeSession({
    id: sessionId,
    modeVersion: mode.version,
    task: {
      ...baseTask,
      id: liveTask.taskId,
      version: liveTask.taskVersion,
      modeId: liveTask.modeId,
      prompt: liveTask.prompt,
      context: {
        ...baseTask.context,
        audience: liveTask.audience,
        objective: liveTask.objective,
      },
      focusCandidateCriterionIds: criterionIds,
      fallbackDrillIds: drillIds,
      focusDrillMappings: criterionIds.map((criterionId, index) => ({
        criterionId,
        drillIds: [drillIds[index]!],
      })),
      rubricSnapshot: liveTask.rubric.map((criterion) => ({
        ...baseCriterion,
        id: criterion.criterionId,
        label: criterion.label,
        description: criterion.description,
      })),
      drillSnapshot: criterionIds.map((criterionId, index) => ({
        ...baseDrill,
        id: drillIds[index]!,
        criterionId,
      })),
    },
    now: '2026-07-18T08:00:00.000Z',
  });
  return PracticeSessionSchema.parse({ ...created, status: 'first_attempt' });
}

interface TestLiveAuthority {
  readonly sessions: Map<string, PracticeSession>;
  readonly ledgers: Map<string, readonly TranscriptSegment[]>;
}

const testLiveAuthorities = new WeakMap<CloudAiService, TestLiveAuthority>();

function liveLedgerKey(attemptId: string, generation: number): string {
  return `${attemptId}\u0000${generation}`;
}

function authorizeLive(service: CloudAiService, payload: LiveHintPayload): void {
  const authority = testLiveAuthorities.get(service);
  if (!authority) throw new Error('TEST_LIVE_AUTHORITY_MISSING');
  const session = makeLiveSession(payload.sessionId, payload.task);
  authority.sessions.set(session.id, session);
  authority.ledgers.set(
    liveLedgerKey(payload.attemptId, payload.generation),
    payload.finalWindow.segmentRevisions.map((segment): TranscriptSegment => ({
      ...segment,
      attemptId: payload.attemptId,
      confidence: null,
      isFinal: true,
      emittedAt: '2026-07-18T08:00:00.000Z',
      finalizedAt: '2026-07-18T08:00:00.000Z',
      modelVersion: 'test-asr-1',
    })),
  );
  service.openLiveAttemptLease({
    session,
    attemptId: payload.attemptId,
    generation: payload.generation,
  });
  service.setLiveAttemptAiState({
    sessionId: payload.sessionId,
    attemptId: payload.attemptId,
    generation: payload.generation,
    enabled: true,
  });
}

function makeDeepPayload(): DeepDiagnosisPayload {
  return {
    schemaVersion: 'deep-diagnosis-1',
    purpose: 'deep_diagnosis',
    analysisInputId: 'analysis-deep',
    sessionId: 'session-deep',
    attemptId: 'attempt-deep',
    snapshotId: 'snapshot-deep',
    transcriptVersion: 1,
    task: {
      ...task,
      rubric: task.rubric.map((criterion) => ({ ...criterion })),
      drills: task.drills.map((drill) => ({ ...drill })),
      successConditions: [...task.successConditions],
    },
    finalSegments: [{
      id: 'segment-deep-1',
      sequence: 0,
      revision: 1,
      startMs: 0,
      endMs: 5_000,
      text: '我建议先冻结新增需求。',
    }],
    corrections: [],
    localEvidence: [],
    metrics: {
      words: 12,
      fillers: 0,
      hedges: 0,
      vagueWords: 0,
      repetitions: 0,
      selfCorrections: 0,
    },
  };
}

function makeComparisonPayload(): SemanticComparisonPayload {
  const deep = makeDeepPayload();
  return {
    schemaVersion: 'comparison-1',
    purpose: 'comparison',
    analysisInputId: 'analysis-comparison',
    sessionId: deep.sessionId,
    task: deep.task,
    focus: {
      version: 1,
      criterionId: 'conclusion-first',
      label: '结论先行',
      drillId: 'conclusion-drill',
    },
    protocolVersion: 'paired-1',
    initial: {
      attemptId: 'attempt-initial',
      snapshotId: 'snapshot-initial',
      transcriptVersion: 1,
      finalSegments: deep.finalSegments,
      localEvidence: [],
      metrics: { ...deep.metrics, hedges: 1 },
    },
    retry: {
      attemptId: 'attempt-retry',
      snapshotId: 'snapshot-retry',
      transcriptVersion: 1,
      finalSegments: [{ ...deep.finalSegments[0]!, id: 'segment-retry-1' }],
      localEvidence: [],
      metrics: deep.metrics,
    },
  };
}

function completedResponse(value: unknown): Response {
  return new Response(JSON.stringify({
    id: 'resp-test',
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

function approveLive(service: CloudAiService): { consent: CloudAiConsent; policyHash: string } {
  const prepared = service.prepareConsent({ purpose: 'live_hint', policy: makePolicy() });
  const consent = service.approveConsent({
    preparationId: prepared.preparationId,
    purpose: prepared.purpose,
    payloadHash: prepared.payloadHash,
    policyHash: prepared.policyHash,
    approvedFields: prepared.approvedFields,
  });
  authorizeLive(service, makeLivePayload(prepared.policyHash));
  return { consent, policyHash: prepared.policyHash };
}

function approvePayload(
  service: CloudAiService,
  payload: DeepDiagnosisPayload | SemanticComparisonPayload,
): CloudAiConsent {
  const prepared = service.prepareConsent({ purpose: payload.purpose, payload });
  return service.approveConsent({
    preparationId: prepared.preparationId,
    purpose: prepared.purpose,
    payloadHash: prepared.payloadHash,
    policyHash: prepared.policyHash,
    approvedFields: prepared.approvedFields,
  });
}

function createService(
  fetchImplementation: typeof fetch = vi.fn(),
  options: ConstructorParameters<typeof CloudAiService>[2] = {},
): {
  service: CloudAiService;
  repository: MemoryCloudAiPersistence;
  secrets: MemorySecretStore;
} {
  const repository = new MemoryCloudAiPersistence();
  const secrets = new MemorySecretStore();
  let nextId = 0;
  return {
    service: createTestService(repository, secrets, {
      ...options,
      fetch: fetchImplementation,
      createId: () => `cloud-id-${++nextId}`,
      now: () => new Date('2026-07-18T08:00:00.000Z'),
    }),
    repository,
    secrets,
  };
}

function createTestService(
  repository: CloudAiPersistence,
  secrets: CloudAiSecretStore,
  options: ConstructorParameters<typeof CloudAiService>[2] = {},
): CloudAiService {
  const authority: TestLiveAuthority = {
    sessions: new Map(),
    ledgers: new Map(),
  };
  const service = new CloudAiService(repository, secrets, {
    ...options,
    getPracticeSession: (sessionId) => authority.sessions.get(sessionId) ?? null,
    getAsrFinalSegments: (identity) => (
      authority.ledgers.get(liveLedgerKey(identity.attemptId, identity.generation)) ?? []
    ),
    releaseAsrAttemptLedger: (identity) => {
      authority.ledgers.delete(liveLedgerKey(identity.attemptId, identity.generation));
    },
  });
  testLiveAuthorities.set(service, authority);
  return service;
}

function expectServiceCode(error: unknown, code: CloudAiServiceError['code']): boolean {
  expect(error).toBeInstanceOf(CloudAiServiceError);
  expect(error).toMatchObject({ code, message: code });
  return true;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CloudAiService canonical approval boundary', () => {
  it('uses stable canonical SHA-256 independent of object key insertion order', () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, a: ['甲', '乙'] }))
      .toBe('{"a":["甲","乙"],"nested":{"a":1,"b":2},"z":1}');
    expect(canonicalSha256({ b: 2, a: 1 })).toBe(canonicalSha256({ a: 1, b: 2 }));
    expect(canonicalSha256({ a: [1, 2] })).not.toBe(canonicalSha256({ a: [2, 1] }));
  });

  it('prepares configuration consent for live and exact hash-bound consent for deep', () => {
    const { service, repository } = createService();
    const livePrepared = service.prepareConsent({ purpose: 'live_hint', policy: makePolicy() });
    expect(livePrepared).toMatchObject({
      scope: 'configuration',
      payloadHash: null,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      endpoint: 'https://api.openai.com/v1/responses',
    });
    expect(JSON.parse(livePrepared.previewJson)).toEqual(makePolicy());

    expect(() => service.approveConsent({
      preparationId: livePrepared.preparationId,
      purpose: livePrepared.purpose,
      payloadHash: livePrepared.payloadHash,
      policyHash: livePrepared.policyHash,
      approvedFields: [...livePrepared.approvedFields, 'unexpected.field'],
    })).toThrowError(expect.objectContaining({ code: 'CONSENT_PREPARATION_MISMATCH' }));

    const deep = makeDeepPayload();
    const deepPrepared = service.prepareConsent({ purpose: 'deep_diagnosis', payload: deep });
    expect(deepPrepared).toMatchObject({
      scope: 'payload',
      payloadHash: canonicalSha256(deep),
      schemaVersion: 'deep-diagnosis-1',
    });
    const consent = service.approveConsent({
      preparationId: deepPrepared.preparationId,
      purpose: deepPrepared.purpose,
      payloadHash: deepPrepared.payloadHash,
      policyHash: deepPrepared.policyHash,
      approvedFields: [...deepPrepared.approvedFields].reverse(),
    });
    expect(consent).toMatchObject({ purpose: 'deep_diagnosis', scope: 'payload' });
    expect(repository.analysisInputs).toHaveLength(1);
    expect(repository.analysisInputs[0]).toMatchObject({
      purpose: 'deep_diagnosis',
      payloadHash: canonicalSha256(deep),
      payload: deep,
      consentId: consent.id,
    });
  });

  it('bounds pending consent preparations and evicts the oldest unused preview', () => {
    const { service } = createService();
    const prepared = Array.from({ length: 17 }, () => (
      service.prepareConsent({ purpose: 'deep_diagnosis', payload: makeDeepPayload() })
    ));

    expect(() => service.approveConsent({
      preparationId: prepared[0]!.preparationId,
      purpose: prepared[0]!.purpose,
      payloadHash: prepared[0]!.payloadHash,
      policyHash: prepared[0]!.policyHash,
      approvedFields: prepared[0]!.approvedFields,
    })).toThrowError(expect.objectContaining({ code: 'CONSENT_PREPARATION_NOT_FOUND' }));

    expect(service.approveConsent({
      preparationId: prepared.at(-1)!.preparationId,
      purpose: prepared.at(-1)!.purpose,
      payloadHash: prepared.at(-1)!.payloadHash,
      policyHash: prepared.at(-1)!.policyHash,
      approvedFields: prepared.at(-1)!.approvedFields,
    })).toMatchObject({ purpose: 'deep_diagnosis' });
  });

  it('refuses a live policy whose approval preview omits fields the transport sends', () => {
    const { service } = createService();
    const policy = makePolicy();
    expect(() => service.prepareConsent({
      purpose: 'live_hint',
      policy: { ...policy, sentFieldPaths: ['task.prompt'] },
    })).toThrowError(expect.objectContaining({ code: 'CONSENT_SCOPE_MISMATCH' }));
    expect(() => service.prepareConsent({
      purpose: 'live_hint',
      policy: { ...policy, maximumWindowCharacters: policy.maximumWindowCharacters + 1 },
    })).toThrowError(expect.objectContaining({ code: 'CONSENT_SCOPE_MISMATCH' }));
  });

  it('restores only safe metadata for the latest active configuration consent', () => {
    const { service } = createService();
    expect(service.getConsentStatus({ purpose: 'live_hint' })).toEqual({
      purpose: 'live_hint',
      active: false,
      consent: null,
    });

    const { consent, policyHash } = approveLive(service);
    expect(service.getConsentStatus({ purpose: 'live_hint' })).toEqual({
      purpose: 'live_hint',
      active: true,
      consent: {
        id: consent.id,
        purpose: 'live_hint',
        scope: 'configuration',
        provider: 'openai',
        model: 'gpt-5.6-terra',
        endpoint: 'https://api.openai.com/v1/responses',
        payloadHash: null,
        policyHash,
        schemaVersion: 'live-window-1',
        promptVersion: APPROVED_AI_PROVIDER.promptVersion,
        approvedFields: consent.approvedFields,
        approvedAt: consent.approvedAt,
        expiresAt: null,
      },
    });
    service.revokeConsent(consent.id);
    expect(service.getConsentStatus({ purpose: 'live_hint' })).toMatchObject({
      active: false,
      consent: null,
    });
  });

  it('reuses one configuration consent across tasks while keeping each sent payload explicit', async () => {
    const response = {
      hint: '先给结论。',
      evidencePhrase: null,
      criterionId: 'conclusion-first',
    };
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completedResponse(response))
      .mockResolvedValueOnce(completedResponse(response));
    const { service } = createService(network);
    const { consent, policyHash } = approveLive(service);

    const firstPayload = makeLivePayload(policyHash);
    authorizeLive(service, firstPayload);
    await service.executeLiveHint({
      payload: firstPayload,
      consentId: consent.id,
      explicitAttemptAiOn: true,
    });
    const otherTaskPayload = makeLivePayload(policyHash, {
        attemptId: 'attempt-other-task',
        task: {
          ...makeLiveTask(),
          taskId: 'another-approved-task',
          prompt: '介绍另一个真实场景。',
        },
      });
    authorizeLive(service, otherTaskPayload);
    await service.executeLiveHint({
      payload: otherTaskPayload,
      consentId: consent.id,
      explicitAttemptAiOn: true,
    });

    const sentPayloads = network.mock.calls.map(([, init]) =>
      JSON.parse(JSON.parse(String(init?.body)).input[0].content[0].text),
    );
    expect(sentPayloads.map((payload) => payload.task.taskId)).toEqual([
      'weekly-scope',
      'another-approved-task',
    ]);
    expect(sentPayloads).toEqual([
      { task: firstPayload.task, finalWindow: { text: firstPayload.finalWindow.text } },
      { task: otherTaskPayload.task, finalWindow: { text: otherTaskPayload.finalWindow.text } },
    ]);
  });

  it('clears payload audit while preserving live configuration, then resets all consent', async () => {
    const repository = new CloudAiRepository(':memory:');
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completedResponse({
        hint: '先给结论。',
        evidencePhrase: null,
        criterionId: 'conclusion-first',
      }))
      .mockResolvedValueOnce(completedResponse({
        judgment: '结论已出现。',
        observations: [],
        focus: {
          criterionId: 'conclusion-first',
          label: '结论先行',
          reason: '继续稳定第一句。',
          drillId: 'conclusion-drill',
          drill: '只说一句结论。',
        },
      }));
    const service = createTestService(repository, new MemorySecretStore(), { fetch: network });
    try {
      const live = approveLive(service);
      const deep = makeDeepPayload();
      const deepConsent = approvePayload(service, deep);
      await service.executeLiveHint({
        payload: makeLivePayload(live.policyHash),
        consentId: live.consent.id,
        explicitAttemptAiOn: true,
      });
      await service.executeDeepDiagnosis({ payload: deep, consentId: deepConsent.id });
      expect(repository.listRequests()).toHaveLength(2);
      expect(repository.listConsents()).toHaveLength(2);

      repository.deleteTrainingAuditData();
      expect(repository.listRequests()).toEqual([]);
      expect(repository.listConsents()).toEqual([live.consent]);
      expect(service.getConsentStatus({ purpose: 'live_hint' })).toMatchObject({ active: true });
      expect(service.getConsentStatus({ purpose: 'deep_diagnosis' })).toMatchObject({ active: false });

      repository.resetConsentData();
      expect(repository.listConsents()).toEqual([]);
      expect(service.getConsentStatus({ purpose: 'live_hint' })).toMatchObject({ active: false });
    } finally {
      repository.close();
    }
  });

  it('deletes one Session cloud graph including live rows linked only by Attempt id', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'phrio-cloud-session-delete-'));
    const databasePath = path.join(root, 'cloud-ai.sqlite3');
    const repository = new CloudAiRepository(databasePath);
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completedResponse({
        hint: '先给结论。', evidencePhrase: null, criterionId: 'conclusion-first',
      }))
      .mockResolvedValueOnce(completedResponse({
        hint: '保留其他练习。', evidencePhrase: null, criterionId: 'conclusion-first',
      }));
    const service = createTestService(repository, new MemorySecretStore(), { fetch: network });
    try {
      const live = approveLive(service);
      const deep = makeDeepPayload();
      const deepConsent = approvePayload(service, deep);
      const comparison = makeComparisonPayload();
      const comparisonConsent = approvePayload(service, comparison);
      const deletedLive = makeLivePayload(live.policyHash, {
        sessionId: deep.sessionId,
        attemptId: deep.attemptId,
      });
      authorizeLive(service, deletedLive);
      await service.executeLiveHint({
        payload: deletedLive,
        consentId: live.consent.id,
        explicitAttemptAiOn: true,
      });
      const unrelatedLive = makeLivePayload(live.policyHash, {
          sessionId: 'session-unrelated',
          attemptId: 'attempt-unrelated',
          requestSequence: 2,
        });
      authorizeLive(service, unrelatedLive);
      await service.executeLiveHint({
        payload: unrelatedLive,
        consentId: live.consent.id,
        explicitAttemptAiOn: true,
      });

      repository.deleteSessionAuditData(deep.sessionId, [
        deep.attemptId,
        comparison.initial.attemptId,
        comparison.retry.attemptId,
      ]);

      expect(repository.listConsents()).toEqual([live.consent]);
      expect(repository.listRequests()).toHaveLength(1);
      expect(repository.listRequests()[0]).toMatchObject({ attemptId: 'attempt-unrelated' });
      expect(repository.getConsent(deepConsent.id)).toBeNull();
      expect(repository.getConsent(comparisonConsent.id)).toBeNull();
      repository.close();

      const audit = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(audit.prepare('SELECT COUNT(*) AS count FROM analysis_inputs').get())
          .toEqual({ count: 1 });
        expect(audit.prepare('SELECT COUNT(*) AS count FROM cloud_requests').get())
          .toEqual({ count: 1 });
      } finally {
        audit.close();
      }
    } finally {
      try { repository.close(); } catch { /* already closed after the assertions */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('revokes consent and rejects the exact request before secret or network access', async () => {
    const network = vi.fn<typeof fetch>();
    const { service, repository } = createService(network);
    const deep = makeDeepPayload();
    const consent = approvePayload(service, deep);
    expect(service.revokeConsent(consent.id).revokedAt).toBe('2026-07-18T08:00:00.000Z');

    await expect(service.executeDeepDiagnosis({ payload: deep, consentId: consent.id }))
      .rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'CONSENT_REVOKED'));
    expect(network).not.toHaveBeenCalled();
    expect(repository.requests).toHaveLength(0);
  });

  it('requires an exact deep/comparison payload hash and records both approvals independently', async () => {
    const network = vi.fn<typeof fetch>();
    const { service, repository } = createService(network);
    const deep = makeDeepPayload();
    const deepConsent = approvePayload(service, deep);
    const changed = {
      ...deep,
      finalSegments: [{ ...deep.finalSegments[0]!, text: '未经批准的新正文。' }],
    };
    await expect(service.executeDeepDiagnosis({ payload: changed, consentId: deepConsent.id }))
      .rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'CONSENT_SCOPE_MISMATCH'));

    const comparison = makeComparisonPayload();
    const comparisonConsent = approvePayload(service, comparison);
    expect(comparisonConsent).toMatchObject({ purpose: 'comparison', scope: 'payload' });
    expect(repository.analysisInputs.map((input) => input.purpose))
      .toEqual(['deep_diagnosis', 'comparison']);
    expect(network).not.toHaveBeenCalled();
  });
});

describe('CloudAiService cloud artifact attestation', () => {
  const providerResult = {
    judgment: '本轮先给出了建议，理由还可以更具体。',
    observations: [{
      type: 'quote' as const,
      criterionId: 'conclusion-first',
      segmentId: 'segment-deep-1',
      evidence: '原句“我建议先冻结新增需求”直接给出了结论。',
      suggestion: '再补充一个资源约束作为理由。',
      confidence: 'high' as const,
    }],
    focus: {
      criterionId: 'conclusion-first',
      label: '结论先行',
      reason: '先稳定结论先行这一条。',
      drillId: 'conclusion-drill',
      drill: '我建议……',
    },
  };

  it('rejects a renderer-forged completion and accepts only the hash-attested provider result', async () => {
    const payload = makeDeepPayload();
    const network = vi.fn<typeof fetch>().mockResolvedValue(completedResponse(providerResult));
    const { service, repository } = createService(network);
    const consent = approvePayload(service, payload);
    const queued = createQueuedCloudDeepDiagnosis({
      payload,
      payloadHash: canonicalSha256(payload),
      consentId: consent.id,
      at: '2026-07-18T08:00:00.000Z',
    });
    const processing = transitionCloudDeepDiagnosis(queued, {
      status: 'processing',
      at: '2026-07-18T08:00:01.000Z',
    });
    const forged = transitionCloudDeepDiagnosis(processing, {
      status: 'complete',
      at: '2026-07-18T08:00:02.000Z',
      result: { ...providerResult, judgment: '这是渲染层伪造、但结构合法的结论。' },
    });

    expect(() => service.assertCloudArtifactAttested({
      id: 'cloud-deep-analysis-deep',
      sessionId: payload.sessionId,
      type: 'cloud_deep_diagnosis',
      payload: queued,
    })).not.toThrow();
    expect(() => service.assertCloudArtifactAttested({
      id: 'cloud-deep-analysis-deep',
      sessionId: payload.sessionId,
      type: 'cloud_deep_diagnosis',
      payload: processing,
    })).not.toThrow();
    expect(() => service.assertCloudArtifactAttested({
      id: 'cloud-deep-analysis-deep',
      sessionId: payload.sessionId,
      type: 'cloud_deep_diagnosis',
      payload: forged,
    })).toThrowError(expect.objectContaining({ code: 'CLOUD_ARTIFACT_NOT_ATTESTED' }));

    await expect(service.executeDeepDiagnosis({ payload, consentId: consent.id }))
      .resolves.toEqual(providerResult);
    const completed = transitionCloudDeepDiagnosis(processing, {
      status: 'complete',
      at: '2026-07-18T08:00:03.000Z',
      result: providerResult,
    });
    expect(() => service.assertCloudArtifactAttested({
      id: 'cloud-deep-analysis-deep',
      sessionId: payload.sessionId,
      type: 'cloud_deep_diagnosis',
      payload: completed,
    })).not.toThrow();
    expect([...repository.requests.values()].at(-1)).toMatchObject({
      status: 'completed',
      outcomeCode: 'ok',
      resultHash: canonicalSha256(providerResult),
    });
  });

  it('rejects a cloud artifact whose payload hash was never approved', () => {
    const payload = makeDeepPayload();
    const { service } = createService();
    const consent = approvePayload(service, payload);
    const queued = createQueuedCloudDeepDiagnosis({
      payload,
      payloadHash: '0'.repeat(64),
      consentId: consent.id,
      at: '2026-07-18T08:00:00.000Z',
    });

    expect(() => service.assertCloudArtifactAttested({
      id: 'cloud-deep-analysis-deep',
      sessionId: payload.sessionId,
      type: 'cloud_deep_diagnosis',
      payload: queued,
    })).toThrowError(expect.objectContaining({ code: 'CLOUD_ARTIFACT_NOT_ATTESTED' }));
  });

  it('binds failed state to a real outcome and rejects future renderer timestamps', () => {
    const payload = makeDeepPayload();
    const { service, repository } = createService();
    const consent = approvePayload(service, payload);
    const queued = createQueuedCloudDeepDiagnosis({
      payload,
      payloadHash: canonicalSha256(payload),
      consentId: consent.id,
      at: '2026-07-18T08:00:00.000Z',
    });
    const processing = transitionCloudDeepDiagnosis(queued, {
      status: 'processing',
      at: '2026-07-18T08:00:01.000Z',
    });
    const forgedFailure = transitionCloudDeepDiagnosis(processing, {
      status: 'failed',
      at: '2026-07-18T08:00:02.000Z',
      errorCode: 'PROVIDER_UNAVAILABLE',
    });
    expect(() => service.assertCloudArtifactAttested({
      id: 'cloud-deep-analysis-deep',
      sessionId: payload.sessionId,
      type: 'cloud_deep_diagnosis',
      payload: forgedFailure,
    })).toThrowError(expect.objectContaining({ code: 'CLOUD_ARTIFACT_NOT_ATTESTED' }));

    repository.putRequest({
      id: 'request-failed-after-artifact',
      sessionId: payload.sessionId,
      attemptId: payload.attemptId,
      purpose: payload.purpose,
      provider: consent.provider,
      model: consent.model,
      endpoint: consent.endpoint,
      requestSequence: null,
      payloadHash: canonicalSha256(payload),
      policyHash: consent.policyHash,
      approvedFields: consent.approvedFields,
      consentId: consent.id,
      requestedAt: '2026-07-18T08:00:00.000Z',
      completedAt: '2026-07-18T08:00:05.000Z',
      status: 'failed',
      outcomeCode: 'provider_unavailable',
      resultHash: null,
      rawAudioIncluded: false,
      partialTranscriptIncluded: false,
    });
    expect(() => service.assertCloudArtifactAttested({
      id: 'cloud-deep-analysis-deep',
      sessionId: payload.sessionId,
      type: 'cloud_deep_diagnosis',
      payload: forgedFailure,
    })).toThrowError(expect.objectContaining({ code: 'CLOUD_ARTIFACT_NOT_ATTESTED' }));

    const future = createQueuedCloudDeepDiagnosis({
      payload,
      payloadHash: canonicalSha256(payload),
      consentId: consent.id,
      at: '2026-07-18T09:00:00.000Z',
    });
    expect(() => service.assertCloudArtifactAttested({
      id: 'cloud-deep-analysis-deep',
      sessionId: payload.sessionId,
      type: 'cloud_deep_diagnosis',
      payload: future,
    })).toThrowError(expect.objectContaining({ code: 'CLOUD_ARTIFACT_NOT_ATTESTED' }));
  });

  it('allows only truthful no-request terminalization for revoked or old-prompt consent', () => {
    const payload = makeDeepPayload();
    const { service, repository } = createService();
    const consent = approvePayload(service, payload);
    const queued = createQueuedCloudDeepDiagnosis({
      payload,
      payloadHash: canonicalSha256(payload),
      consentId: consent.id,
      at: '2026-07-18T08:00:00.000Z',
    });
    const processing = transitionCloudDeepDiagnosis(queued, {
      status: 'processing',
      at: '2026-07-18T08:00:01.000Z',
    });
    service.revokeConsent(consent.id);
    const revoked = transitionCloudDeepDiagnosis(processing, {
      status: 'failed',
      at: '2026-07-18T08:00:02.000Z',
      errorCode: 'CONSENT_REVOKED',
    });
    expect(() => service.assertCloudArtifactAttested({
      id: 'cloud-deep-analysis-deep',
      sessionId: payload.sessionId,
      type: 'cloud_deep_diagnosis',
      payload: revoked,
    })).not.toThrow();
    expect(() => service.assertCloudArtifactAttested({
      id: 'cloud-deep-analysis-deep',
      sessionId: payload.sessionId,
      type: 'cloud_deep_diagnosis',
      payload: { ...revoked, errorCode: 'PROVIDER_UNAVAILABLE' },
    })).toThrowError(expect.objectContaining({ code: 'CLOUD_ARTIFACT_NOT_ATTESTED' }));

    repository.putConsent({
      ...consent,
      id: 'legacy-prompt-consent',
      promptVersion: 'phrio-2026-07-18.1',
      revokedAt: null,
    });
    const legacyQueued = createQueuedCloudDeepDiagnosis({
      payload,
      payloadHash: canonicalSha256(payload),
      consentId: 'legacy-prompt-consent',
      at: '2026-07-18T08:00:00.000Z',
    });
    expect(() => service.assertCloudArtifactAttested({
      id: 'cloud-deep-analysis-deep',
      sessionId: payload.sessionId,
      type: 'cloud_deep_diagnosis',
      payload: legacyQueued,
    })).toThrowError(expect.objectContaining({ code: 'CLOUD_ARTIFACT_NOT_ATTESTED' }));
    const legacyFailed = transitionCloudDeepDiagnosis(
      transitionCloudDeepDiagnosis(legacyQueued, {
        status: 'processing',
        at: '2026-07-18T08:00:01.000Z',
      }),
      {
        status: 'failed',
        at: '2026-07-18T08:00:02.000Z',
        errorCode: 'CONSENT_SCOPE_MISMATCH',
      },
    );
    expect(() => service.assertCloudArtifactAttested({
      id: 'cloud-deep-analysis-deep',
      sessionId: payload.sessionId,
      type: 'cloud_deep_diagnosis',
      payload: legacyFailed,
    })).not.toThrow();
  });
});

describe('CloudAiService fixed OpenAI transport', () => {
  it('reports and updates only the narrow encrypted-key configuration status', async () => {
    const { service } = createService();
    await expect(service.getConfigurationStatus()).resolves.toMatchObject({
      provider: 'openai',
      providerName: 'OpenAI',
      model: 'gpt-5.6-terra',
      configured: true,
      encryptionAvailable: true,
      keyStorage: 'system_encrypted',
      keyHint: '••••0000',
    });
    await expect(service.saveApiKey({ apiKey: 'test-openai-replacement-key-000000000' }))
      .resolves.toMatchObject({ configured: true, keyHint: '••••0000' });
    await expect(service.deleteApiKey()).resolves.toMatchObject({
      configured: false,
      keyHint: null,
    });
  });

  it('keeps AI configured through the disclosed private-file fallback', async () => {
    const { service, secrets } = createService();
    secrets.encryptionAvailable = false;

    await expect(service.getConfigurationStatus()).resolves.toMatchObject({
      configured: true,
      encryptionAvailable: false,
      keyStorage: 'local_private_file_unencrypted',
      keyHint: '••••0000',
    });
    await expect(service.saveApiKey({ apiKey: 'test-openai-fallback-key-00000000000' }))
      .resolves.toMatchObject({
        configured: true,
        encryptionAvailable: false,
        keyStorage: 'local_private_file_unencrypted',
      });
  });

  it('serializes conflicting key mutations so a delayed save cannot resurrect a deleted key', async () => {
    const { service, secrets } = createService();
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const save = vi.spyOn(secrets, 'save').mockImplementation(async (apiKey) => {
      await saveGate;
      secrets.value = apiKey;
    });
    const remove = vi.spyOn(secrets, 'delete');

    const saving = service.saveApiKey({ apiKey: 'test-openai-delayed-key-0000000000000' });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const deleting = service.deleteApiKey();
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();

    releaseSave();
    await expect(saving).resolves.toMatchObject({ configured: true });
    await expect(deleting).resolves.toMatchObject({ configured: false, keyHint: null });
    expect(secrets.value).toBeNull();
  });

  it('gates, aborts, and drains all three cloud purposes before deleting the API key', async () => {
    const responseResolvers: Array<(response: Response) => void> = [];
    const requestSignals: AbortSignal[] = [];
    // Deliberately ignore AbortSignal in the provider stub. The service must
    // still discard every late response before it can persist completion.
    const network = vi.fn<typeof fetch>((_input, init) => {
      requestSignals.push(init?.signal as AbortSignal);
      return new Promise<Response>((resolve) => responseResolvers.push(resolve));
    });
    const { service, repository, secrets } = createService(network);
    const { consent: liveConsent, policyHash } = approveLive(service);
    const deep = makeDeepPayload();
    const deepConsent = approvePayload(service, deep);
    const comparison = makeComparisonPayload();
    const comparisonConsent = approvePayload(service, comparison);
    const pending = [
      service.executeLiveHint({
        payload: makeLivePayload(policyHash),
        consentId: liveConsent.id,
        explicitAttemptAiOn: true,
      }),
      service.executeDeepDiagnosis({ payload: deep, consentId: deepConsent.id }),
      service.executeSemanticComparison({
        payload: comparison,
        consentId: comparisonConsent.id,
      }),
    ];
    const observed = pending.map((request) => request.catch((error: unknown) => error));
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(3));
    const remove = vi.spyOn(secrets, 'delete');

    const deleting = service.deleteApiKey();
    await vi.waitFor(() => {
      expect(requestSignals).toHaveLength(3);
      for (const signal of requestSignals) {
        expect(signal).toMatchObject({ aborted: true, reason: 'api_key_deleted' });
      }
    });
    expect(remove).not.toHaveBeenCalled();
    await expect(service.executeDeepDiagnosis({ payload: deep, consentId: deepConsent.id }))
      .rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'AI_NOT_CONFIGURED'));
    expect(network).toHaveBeenCalledTimes(3);

    for (const resolve of responseResolvers) resolve(completedResponse({}));
    for (const result of await Promise.all(observed)) {
      expectServiceCode(result, 'RESULT_DISCARDED');
      expect(result).toMatchObject({ detail: 'api_key_deleted' });
    }
    await expect(deleting).resolves.toMatchObject({ configured: false, keyHint: null });
    expect(remove).toHaveBeenCalledOnce();
    expect(secrets.value).toBeNull();
    expect([...repository.requests.values()]).toHaveLength(3);
    expect([...repository.requests.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'discarded', outcomeCode: 'api_key_deleted' }),
      expect.objectContaining({ status: 'discarded', outcomeCode: 'api_key_deleted' }),
      expect.objectContaining({ status: 'discarded', outcomeCode: 'api_key_deleted' }),
    ]));
    expect([...repository.requests.values()].some((request) => request.status === 'completed'))
      .toBe(false);
  });

  it('reports API key deletion failure as retryable without claiming the key is gone', async () => {
    const { service, secrets } = createService();
    const remove = vi.spyOn(secrets, 'delete')
      .mockRejectedValueOnce(new Error('injected keychain deletion failure'));

    await expect(service.deleteApiKey()).rejects.toSatisfy((error: unknown) =>
      expectServiceCode(error, 'SECRET_STORAGE_FAILED'));
    await expect(service.getConfigurationStatus()).resolves.toMatchObject({ configured: true });
    expect(secrets.value).not.toBeNull();

    await expect(service.deleteApiKey()).resolves.toMatchObject({ configured: false });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(secrets.value).toBeNull();
  });

  it('sends only final text to the fixed Responses endpoint with store false and strict schema', async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(completedResponse({
      hint: '先把结论压缩成一句，再补理由。',
      evidencePhrase: '先冻结新增需求',
      criterionId: 'conclusion-first',
    }));
    const { service, repository, secrets } = createService(network);
    const { consent, policyHash } = approveLive(service);
    const sessionId = 'session-live-private-identity';
    const attemptId = `initial-g1-1700000000000-${sessionId}`;
    const basePayload = makeLivePayload(policyHash);
    const segmentId = `${attemptId}-seg-0`;
    const payload = makeLivePayload(policyHash, {
      sessionId,
      attemptId,
      finalWindow: {
        ...basePayload.finalWindow,
        segmentRevisions: basePayload.finalWindow.segmentRevisions.map((segment) => ({
          ...segment,
          id: segmentId,
        })),
      },
    });
    authorizeLive(service, payload);

    await expect(service.executeLiveHint({
      payload,
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).resolves.toEqual({
      hint: '先把结论压缩成一句，再补理由。',
      evidencePhrase: '先冻结新增需求',
      criterionId: 'conclusion-first',
    });

    expect(network).toHaveBeenCalledOnce();
    const [url, init] = network.mock.calls[0]!;
    expect(url).toBe(APPROVED_AI_PROVIDER.endpoint);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${secrets.value}`,
      'content-type': 'application/json',
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'gpt-5.6-terra',
      store: false,
      text: { format: { type: 'json_schema', strict: true, name: 'phrio_live_hint' } },
    });
    expect(body.input[0].content).toEqual([{
      type: 'input_text',
      text: canonicalJson({
        task: payload.task,
        finalWindow: { text: payload.finalWindow.text },
      }),
    }]);
    const serializedBody = JSON.stringify(body);
    expect(serializedBody).not.toContain(sessionId);
    expect(serializedBody).not.toContain(attemptId);
    expect(serializedBody).not.toContain(segmentId);
    expect(body.input[0].content[0].text).not.toMatch(
      /attemptId|generation|phaseEpoch|transcriptVersion|requestSequence|policyHash|segmentRevisions/u,
    );
    expect(serializedBody).not.toMatch(/audio|partial/i);

    expect(repository.analysisInputs.at(-1)).toMatchObject({
      sessionId: payload.sessionId,
      purpose: 'live_hint',
      payload,
      consentId: consent.id,
    });
    expect([...repository.requests.values()].at(-1)).toMatchObject({
      sessionId: payload.sessionId,
      status: 'completed',
      outcomeCode: 'ok',
      rawAudioIncluded: false,
      partialTranscriptIncluded: false,
    });
    const metadataJson = JSON.stringify([...repository.requests.values()]);
    expect(metadataJson).not.toContain(secrets.value);
    expect(metadataJson).not.toContain(payload.finalWindow.text);
  });

  it('emits content-free request lifecycle diagnostics and keeps sink failures fail-open', async () => {
    const result = {
      hint: '这是不允许进入诊断日志的 AI 返回内容。',
      evidencePhrase: null,
      criterionId: 'conclusion-first',
    };
    const network = vi.fn<typeof fetch>().mockResolvedValue(completedResponse(result));
    const diagnostics = vi.fn();
    let monotonic = 0;
    const { service, secrets } = createService(network, {
      diagnostics: { record: diagnostics },
      monotonicNow: () => { monotonic += 7; return monotonic; },
    });
    const { consent, policyHash } = approveLive(service);
    const payload = makeLivePayload(policyHash);
    authorizeLive(service, payload);

    await expect(service.executeLiveHint({
      payload,
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).resolves.toEqual(result);

    expect(diagnostics.mock.calls.map(([event]) => event.event)).toEqual(expect.arrayContaining([
      'ai.request.queued',
      'ai.request.started',
      'ai.provider.responded',
      'ai.request.completed',
    ]));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      event: 'ai.provider.responded',
      fields: expect.objectContaining({
        purpose: 'live_hint',
        provider: 'openai',
        httpStatus: 200,
        durationMs: expect.any(Number),
      }),
    }));
    const serializedDiagnostics = JSON.stringify(diagnostics.mock.calls);
    expect(serializedDiagnostics).not.toContain(payload.finalWindow.text);
    expect(serializedDiagnostics).not.toContain(payload.task.prompt);
    expect(serializedDiagnostics).not.toContain(result.hint);
    expect(serializedDiagnostics).not.toContain(secrets.value);

    const failingDiagnostics = vi.fn()
      .mockImplementationOnce(() => { throw new Error('diagnostic write failed'); })
      .mockRejectedValue(new Error('diagnostic async write failed'));
    const failOpenNetwork = vi.fn<typeof fetch>().mockResolvedValue(completedResponse(result));
    const failOpen = createService(failOpenNetwork, {
      diagnostics: { record: failingDiagnostics },
    });
    const approved = approveLive(failOpen.service);
    const failOpenPayload = makeLivePayload(approved.policyHash);
    authorizeLive(failOpen.service, failOpenPayload);
    await expect(failOpen.service.executeLiveHint({
      payload: failOpenPayload,
      consentId: approved.consent.id,
      explicitAttemptAiOn: true,
    })).resolves.toEqual(result);
    await Promise.resolve();
  });

  it('requires explicit per-attempt AI ON and rejects partial/audio-shaped renderer input', async () => {
    const network = vi.fn<typeof fetch>();
    const { service } = createService(network);
    const { consent, policyHash } = approveLive(service);
    const payload = makeLivePayload(policyHash);

    await expect(service.executeLiveHint({
      payload,
      consentId: consent.id,
      explicitAttemptAiOn: false,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'INVALID_INPUT'));
    await expect(service.executeLiveHint({
      payload: { ...payload, partialTranscript: '尚未落定' },
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'INVALID_INPUT'));
    await expect(service.executeLiveHint({
      payload: { ...payload, audio: 'base64-audio' },
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'INVALID_INPUT'));
    expect(network).not.toHaveBeenCalled();
  });

  it('rejects missing/off leases, forged finals, and a renderer-forged frozen task before transport', async () => {
    const network = vi.fn<typeof fetch>();
    const { service } = createService(network);
    const { consent, policyHash } = approveLive(service);
    const payload = makeLivePayload(policyHash);

    service.releaseAllLiveAttemptLeases();
    await expect(service.executeLiveHint({
      payload,
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'LIVE_ATTEMPT_LEASE_REQUIRED'));

    authorizeLive(service, payload);
    service.setLiveAttemptAiState({
      sessionId: payload.sessionId,
      attemptId: payload.attemptId,
      generation: payload.generation,
      enabled: false,
    });
    await expect(service.executeLiveHint({
      payload,
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'ATTEMPT_AI_OFF'));

    authorizeLive(service, payload);
    const forgedText = '这是 renderer 伪造、从未由本地 ASR 落定的 final 文本。';
    await expect(service.executeLiveHint({
      payload: {
        ...payload,
        finalWindow: {
          text: forgedText,
          segmentRevisions: [{
            ...payload.finalWindow.segmentRevisions[0]!,
            text: forgedText,
          }],
        },
      },
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'LIVE_FINAL_NOT_ATTESTED'));

    await expect(service.executeLiveHint({
      payload: {
        ...payload,
        task: { ...payload.task, objective: 'renderer 擅自扩大的任务目的' },
      },
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'LIVE_TASK_NOT_FROZEN'));
    expect(network).not.toHaveBeenCalled();
  });

  it('permanently seals one stopped attempt while allowing a new attempt identity', () => {
    const { service } = createService(vi.fn<typeof fetch>());
    const payload = makeLivePayload('a'.repeat(64));
    authorizeLive(service, payload);
    expect(service.setLiveAttemptAiState({
      sessionId: payload.sessionId,
      attemptId: payload.attemptId,
      generation: payload.generation,
      enabled: false,
      sealed: true,
    })).toMatchObject({ enabled: false });
    expect(() => service.setLiveAttemptAiState({
      sessionId: payload.sessionId,
      attemptId: payload.attemptId,
      generation: payload.generation,
      enabled: true,
    })).toThrowError(expect.objectContaining({ code: 'LIVE_ATTEMPT_SEALED' }));

    const authority = testLiveAuthorities.get(service)!;
    const session = authority.sessions.get(payload.sessionId)!;
    service.releaseLiveAttemptGeneration(payload);
    service.openLiveAttemptLease({
      session,
      attemptId: payload.attemptId,
      generation: payload.generation,
    });
    expect(() => service.setLiveAttemptAiState({
      sessionId: payload.sessionId,
      attemptId: payload.attemptId,
      generation: payload.generation,
      enabled: true,
    })).toThrowError(expect.objectContaining({ code: 'LIVE_ATTEMPT_SEALED' }));

    service.openLiveAttemptLease({ session, attemptId: 'attempt-new', generation: 2 });
    expect(service.setLiveAttemptAiState({
      sessionId: payload.sessionId,
      attemptId: 'attempt-new',
      generation: 2,
      enabled: true,
    })).toMatchObject({ enabled: true });
  });

  it('accepts only the canonical latest final window and closes the lease after ASR stop', async () => {
    const network = vi.fn<typeof fetch>();
    const { service } = createService(network);
    const { consent, policyHash } = approveLive(service);
    const first = makeLivePayload(policyHash).finalWindow.segmentRevisions[0]!;
    const second = {
      ...first,
      id: 'segment-2',
      sequence: 1,
      startMs: first.endMs,
      endMs: first.endMs + 4_000,
      text: '第二句已经由本地 ASR 落定，而且它必须出现在最新窗口中。',
    };
    const canonicalPayload = makeLivePayload(policyHash, {
      transcriptVersion: 2,
      finalWindow: {
        text: `${first.text}${second.text}`,
        segmentRevisions: [first, second],
      },
    });
    authorizeLive(service, canonicalPayload);

    await expect(service.executeLiveHint({
      payload: {
        ...canonicalPayload,
        finalWindow: { text: first.text, segmentRevisions: [first] },
      },
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'LIVE_FINAL_NOT_ATTESTED'));
    await expect(service.executeLiveHint({
      payload: { ...canonicalPayload, phaseEpoch: canonicalPayload.generation + 1 },
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'LIVE_ATTEMPT_LEASE_REJECTED'));

    service.releaseLiveAttemptGeneration(canonicalPayload);
    expect(() => service.setLiveAttemptAiState({
      sessionId: canonicalPayload.sessionId,
      attemptId: canonicalPayload.attemptId,
      generation: canonicalPayload.generation,
      enabled: true,
    })).toThrowError(expect.objectContaining({ code: 'LIVE_ATTEMPT_LEASE_REQUIRED' }));
    await expect(service.executeLiveHint({
      payload: canonicalPayload,
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'LIVE_ATTEMPT_LEASE_REQUIRED'));
    expect(network).not.toHaveBeenCalled();
  });

  it('rechecks the approved live window and per-attempt request limits at transport time', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () => completedResponse({
      hint: '保持当前结论。',
      evidencePhrase: null,
      criterionId: 'conclusion-first',
    }));
    const { service } = createService(network);
    const { consent, policyHash } = approveLive(service);
    const oversizedText = '结'.repeat(APPROVED_LIVE_AI_POLICY.maximumWindowCharacters + 1);
    const oversizedPayload = makeLivePayload(policyHash, {
      finalWindow: {
        text: oversizedText,
        segmentRevisions: [{
          id: 'segment-oversized',
          sequence: 0,
          revision: 1,
          startMs: 0,
          endMs: 4_000,
          text: oversizedText,
        }],
      },
    });
    authorizeLive(service, oversizedPayload);
    await expect(service.executeLiveHint({
      payload: oversizedPayload,
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'LIVE_FINAL_NOT_ATTESTED'));

    const countedPayload = makeLivePayload(policyHash, { attemptId: 'attempt-policy-count' });
    authorizeLive(service, countedPayload);
    for (let sequence = 1; sequence <= APPROVED_LIVE_AI_POLICY.maximumRequests; sequence += 1) {
      await service.executeLiveHint({
        payload: makeLivePayload(policyHash, {
          attemptId: 'attempt-policy-count',
          requestSequence: sequence,
        }),
        consentId: consent.id,
        explicitAttemptAiOn: true,
      });
    }
    await expect(service.executeLiveHint({
      payload: makeLivePayload(policyHash, {
        attemptId: 'attempt-policy-count',
        requestSequence: APPROVED_LIVE_AI_POLICY.maximumRequests + 1,
      }),
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'LIVE_POLICY_LIMIT_EXCEEDED'));
    expect(network).toHaveBeenCalledTimes(APPROVED_LIVE_AI_POLICY.maximumRequests);
  });

  it('validates structured output locally and checks evidence/criterion semantics', async () => {
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completedResponse({
        hint: '先说结论。',
        evidencePhrase: '输入中不存在的短语',
        criterionId: 'conclusion-first',
      }))
      .mockResolvedValueOnce(completedResponse({
        judgment: '总体结论。',
        observations: [],
        focus: {
          criterionId: 'conclusion-first',
          label: '结论先行',
          reason: '需要优先训练。',
          drillId: 'not-approved-drill',
          drill: '做一个练习。',
        },
      }));
    const { service } = createService(network);
    const { consent, policyHash } = approveLive(service);
    await expect(service.executeLiveHint({
      payload: makeLivePayload(policyHash),
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'INVALID_PROVIDER_RESPONSE'));

    const deep = makeDeepPayload();
    const deepConsent = approvePayload(service, deep);
    await expect(service.executeDeepDiagnosis({ payload: deep, consentId: deepConsent.id }))
      .rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'INVALID_PROVIDER_RESPONSE'));
  });

  it('executes deep diagnosis and paired comparison with their own strict output contracts', async () => {
    const deepResult = {
      judgment: '结论清楚，但理由还可以更具体。',
      observations: [{
        type: 'quote',
        criterionId: 'conclusion-first',
        segmentId: 'segment-deep-1',
        evidence: '“我建议先冻结新增需求”给出了明确结论。',
        suggestion: '下一句补充资源约束。',
        confidence: 'high',
      }],
      focus: {
        criterionId: 'conclusion-first',
        label: '结论先行',
        reason: '先稳定第一句，再补充理由。',
        drillId: 'conclusion-drill',
        drill: '用“我建议……”完成一句话结论。',
      },
    } as const;
    const comparisonResult = {
      result: 'improved',
      explanation: '复讲仍使用同一 criterion，第一句更直接。',
      initialEvidence: ['初讲“我建议先冻结新增需求”给出了建议。'],
      retryEvidence: ['复讲“我建议先冻结新增需求”仍保持结论先行。'],
    } as const;
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completedResponse(deepResult))
      .mockResolvedValueOnce(completedResponse(comparisonResult));
    const { service, repository } = createService(network);

    const deep = makeDeepPayload();
    const deepConsent = approvePayload(service, deep);
    await expect(service.executeDeepDiagnosis({ payload: deep, consentId: deepConsent.id }))
      .resolves.toEqual(deepResult);

    const comparison = makeComparisonPayload();
    const comparisonConsent = approvePayload(service, comparison);
    await expect(service.executeSemanticComparison({
      payload: comparison,
      consentId: comparisonConsent.id,
    })).resolves.toEqual(comparisonResult);

    const bodies = network.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.text.format.name)).toEqual([
      'phrio_deep_diagnosis',
      'phrio_semantic_comparison',
    ]);
    expect(bodies.every((body) => body.store === false)).toBe(true);
    expect([...repository.requests.values()].every((request) => request.status === 'completed'))
      .toBe(true);
    expect(repository.analysisInputs.filter((input) => input.purpose === 'deep_diagnosis'))
      .toHaveLength(1);
    expect(repository.analysisInputs.filter((input) => input.purpose === 'comparison'))
      .toHaveLength(1);
  });

  it('rejects structurally valid but untraceable Deep and comparison conclusions', async () => {
    const validFocus = {
      criterionId: 'conclusion-first',
      label: '结论先行',
      reason: '优先训练。',
      drillId: 'conclusion-drill',
      drill: '我建议……',
    } as const;
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completedResponse({
        judgment: '伪造诊断。',
        observations: [{
          type: 'quote',
          criterionId: 'conclusion-first',
          segmentId: 'segment-deep-1',
          evidence: '“用户从未说过的话”却伪装成原句。',
          suggestion: '无效建议。',
          confidence: 'high',
        }],
        focus: validFocus,
      }))
      .mockResolvedValueOnce(completedResponse({
        result: 'improved',
        explanation: '没有两侧证据却宣称改善。',
        initialEvidence: [],
        retryEvidence: [],
      }))
      .mockResolvedValueOnce(completedResponse({
        result: 'improved',
        explanation: '用无法回查的文字宣称改善。',
        initialEvidence: ['初讲表现不好。'],
        retryEvidence: ['复讲表现更好。'],
      }));
    const { service } = createService(network);
    const deep = makeDeepPayload();
    const deepConsent = approvePayload(service, deep);
    await expect(service.executeDeepDiagnosis({ payload: deep, consentId: deepConsent.id }))
      .rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'INVALID_PROVIDER_RESPONSE'));

    const comparison = makeComparisonPayload();
    const emptyConsent = approvePayload(service, comparison);
    await expect(service.executeSemanticComparison({ payload: comparison, consentId: emptyConsent.id }))
      .rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'INVALID_PROVIDER_RESPONSE'));
    const proseConsent = approvePayload(service, comparison);
    await expect(service.executeSemanticComparison({ payload: comparison, consentId: proseConsent.id }))
      .rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'INVALID_PROVIDER_RESPONSE'));
  });

  it('coalesces concurrent retries of the same approved Deep payload into one provider request', async () => {
    const deepResult = {
      judgment: '结论清楚，可以继续补足理由。',
      observations: [],
      focus: {
        criterionId: 'conclusion-first',
        label: '结论先行',
        reason: '先稳定第一句。',
        drillId: 'conclusion-drill',
        drill: '用“我建议……”完成一句话结论。',
      },
    } as const;
    let resolveResponse!: (response: Response) => void;
    const network = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    const { service, repository } = createService(network);
    const deep = makeDeepPayload();
    const consent = approvePayload(service, deep);

    const first = service.executeDeepDiagnosis({ payload: deep, consentId: consent.id });
    const second = service.executeDeepDiagnosis({ payload: deep, consentId: consent.id });
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
    resolveResponse(completedResponse(deepResult));

    await expect(Promise.all([first, second])).resolves.toEqual([deepResult, deepResult]);
    expect(network).toHaveBeenCalledTimes(1);
    expect(repository.requests.size).toBe(1);
  });

  it('rejects a redirected response even if a fetch implementation ignores redirect:error', async () => {
    const redirected = completedResponse({
      hint: '不应采用。',
      evidencePhrase: null,
      criterionId: null,
    });
    Object.defineProperty(redirected, 'redirected', { value: true });
    const network = vi.fn<typeof fetch>().mockResolvedValue(redirected);
    const { service } = createService(network);
    const { consent, policyHash } = approveLive(service);
    await expect(service.executeLiveHint({
      payload: makeLivePayload(policyHash),
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'TRANSPORT_BOUNDARY_REJECTED'));
  });

  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [403, 'AUTHENTICATION_FAILED'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [503, 'PROVIDER_UNAVAILABLE'],
    [400, 'PROVIDER_REJECTED'],
  ] as const)('maps HTTP %i without exposing provider body or key', async (status, code) => {
    const providerBody = 'provider-secret-body-with-user-text';
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response(providerBody, { status }));
    const diagnostics = vi.fn();
    const { service, secrets } = createService(network, {
      diagnostics: { record: diagnostics },
    });
    const deep = makeDeepPayload();
    const consent = approvePayload(service, deep);
    const rejection = service.executeDeepDiagnosis({ payload: deep, consentId: consent.id });
    await expect(rejection).rejects.toSatisfy((error: unknown) => {
      expectServiceCode(error, code);
      expect((error as Error).message).not.toContain(providerBody);
      expect((error as Error).message).not.toContain(secrets.value);
      expect((error as Error).message).not.toContain(deep.finalSegments[0]!.text);
      return true;
    });
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      event: 'ai.provider.responded',
      fields: expect.objectContaining({ httpStatus: status, purpose: 'deep_diagnosis' }),
    }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      event: 'ai.request.failed',
      fields: expect.objectContaining({ errorCode: code, status: 'failed' }),
    }));
    const serializedDiagnostics = JSON.stringify(diagnostics.mock.calls);
    expect(serializedDiagnostics).not.toContain(providerBody);
    expect(serializedDiagnostics).not.toContain(secrets.value);
    expect(serializedDiagnostics).not.toContain(deep.finalSegments[0]!.text);
  });

  it('maps offline transport failure and missing secret to safe errors', async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline with internal URL'));
    const first = createService(network);
    const deep = makeDeepPayload();
    const consent = approvePayload(first.service, deep);
    await expect(first.service.executeDeepDiagnosis({ payload: deep, consentId: consent.id }))
      .rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'NETWORK_UNAVAILABLE'));

    const second = createService(network);
    second.secrets.value = null;
    const otherConsent = approvePayload(second.service, deep);
    await expect(second.service.executeDeepDiagnosis({ payload: deep, consentId: otherConsent.id }))
      .rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'AI_NOT_CONFIGURED'));
    expect(network).toHaveBeenCalledOnce();
  });
});

describe('CloudAiService cancellation and latest-wins', () => {
  it('aborts revoked Deep and comparison requests and discards providers that ignore abort', async () => {
    const responseResolvers: Array<(response: Response) => void> = [];
    const requestSignals: AbortSignal[] = [];
    const network = vi.fn<typeof fetch>((_input, init) => {
      requestSignals.push(init?.signal as AbortSignal);
      return new Promise<Response>((resolve) => {
        responseResolvers.push(resolve);
      });
    });
    const { service, repository } = createService(network);
    const deep = makeDeepPayload();
    const deepConsent = approvePayload(service, deep);
    const comparison = makeComparisonPayload();
    const comparisonConsent = approvePayload(service, comparison);

    const requests = [
      service.executeDeepDiagnosis({ payload: deep, consentId: deepConsent.id }),
      service.executeSemanticComparison({ payload: comparison, consentId: comparisonConsent.id }),
    ];
    const observed = requests.map((request) => request.catch((error: unknown) => error));
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(2));

    service.revokeConsent(deepConsent.id);
    service.revokeConsent(comparisonConsent.id);
    expect(requestSignals).toEqual([
      expect.objectContaining({ aborted: true, reason: 'consent_revoked' }),
      expect.objectContaining({ aborted: true, reason: 'consent_revoked' }),
    ]);

    responseResolvers[0]!(completedResponse({
      judgment: '不应被采用的迟到诊断。',
      observations: [],
      focus: {
        criterionId: 'conclusion-first',
        label: '结论先行',
        reason: '迟到结果。',
        drillId: 'conclusion-drill',
        drill: '只说一句结论。',
      },
    }));
    responseResolvers[1]!(completedResponse({
      result: 'insufficient_evidence',
      explanation: '不应被采用的迟到比较。',
      initialEvidence: [],
      retryEvidence: [],
    }));

    for (const result of await Promise.all(observed)) {
      expectServiceCode(result, 'RESULT_DISCARDED');
      expect(result).toMatchObject({ detail: 'consent_revoked' });
    }
    expect([...repository.requests.values()].map((request) => request.status))
      .toEqual(['discarded', 'discarded']);
  });

  it('rechecks consent after provider completion even when revocation bypassed the local abort path', async () => {
    let resolveLate!: (response: Response) => void;
    const network = vi.fn<typeof fetch>(() => new Promise((resolve) => {
      resolveLate = resolve;
    }));
    const { service, repository } = createService(network);
    const deep = makeDeepPayload();
    const consent = approvePayload(service, deep);
    const pending = service.executeDeepDiagnosis({ payload: deep, consentId: consent.id });
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce());

    repository.revokeConsent(consent.id, '2026-07-18T08:00:00.000Z');
    resolveLate(completedResponse({
      judgment: '撤回后不得落地。',
      observations: [],
      focus: {
        criterionId: 'conclusion-first',
        label: '结论先行',
        reason: '撤回后的迟到结果。',
        drillId: 'conclusion-drill',
        drill: '只说一句结论。',
      },
    }));

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      expectServiceCode(error, 'RESULT_DISCARDED');
      expect(error).toMatchObject({ detail: 'consent_revoked' });
      return true;
    });
  });

  it('gates and drains only requests belonging to the Session being deleted', async () => {
    const responseResolvers: Array<(response: Response) => void> = [];
    const requestSignals: AbortSignal[] = [];
    const network = vi.fn<typeof fetch>((_input, init) => {
      requestSignals.push(init?.signal as AbortSignal);
      return new Promise<Response>((resolve) => {
        responseResolvers.push(resolve);
      });
    });
    const { service } = createService(network);
    const deep = makeDeepPayload();
    const consent = approvePayload(service, deep);
    const live = approveLive(service);
    const sessionLivePayload = makeLivePayload(live.policyHash, {
      sessionId: deep.sessionId,
      attemptId: deep.attemptId,
    });
    authorizeLive(service, sessionLivePayload);
    const requests = [
      service.executeDeepDiagnosis({ payload: deep, consentId: consent.id }),
      service.executeLiveHint({
        payload: sessionLivePayload,
        consentId: live.consent.id,
        explicitAttemptAiOn: true,
      }),
    ];
    const observed = requests.map((request) => request.catch((error: unknown) => error));
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(2));

    let deletionStarted = false;
    const deleting = service.runWithSessionDataDeletion({
      sessionId: deep.sessionId,
      attemptIds: [deep.attemptId],
    }, () => {
      deletionStarted = true;
    });
    await vi.waitFor(() => {
      expect(requestSignals).toHaveLength(2);
      for (const signal of requestSignals) {
        expect(signal).toMatchObject({
          aborted: true,
          reason: 'session_data_deleted',
        });
      }
    });
    expect(deletionStarted).toBe(false);
    await expect(service.executeDeepDiagnosis({ payload: deep, consentId: consent.id }))
      .rejects.toSatisfy((error: unknown) => (
        expectServiceCode(error, 'TRAINING_DATA_RESET_IN_PROGRESS')
      ));

    for (const resolve of responseResolvers) resolve(completedResponse({}));
    for (const result of await Promise.all(observed)) {
      expect(result).toMatchObject({
        code: 'RESULT_DISCARDED',
        detail: 'session_data_deleted',
      });
    }
    await expect(deleting).resolves.toBeUndefined();
    expect(deletionStarted).toBe(true);
  });

  it('gates new writes and drains live, Deep, and comparison requests before reset cleanup', async () => {
    const responseResolvers: Array<(response: Response) => void> = [];
    const requestSignals: AbortSignal[] = [];
    const network = vi.fn<typeof fetch>((_input, init) => {
      requestSignals.push(init?.signal as AbortSignal);
      return new Promise<Response>((resolve) => {
        responseResolvers.push(resolve);
      });
    });
    const { service } = createService(network);
    const { consent: liveConsent, policyHash } = approveLive(service);
    const deep = makeDeepPayload();
    const deepConsent = approvePayload(service, deep);
    const comparison = makeComparisonPayload();
    const comparisonConsent = approvePayload(service, comparison);

    const pending = [
      service.executeLiveHint({
        payload: makeLivePayload(policyHash),
        consentId: liveConsent.id,
        explicitAttemptAiOn: true,
      }),
      service.executeDeepDiagnosis({ payload: deep, consentId: deepConsent.id }),
      service.executeSemanticComparison({
        payload: comparison,
        consentId: comparisonConsent.id,
      }),
    ];
    const observed = pending.map((request) => request.catch((error: unknown) => error));
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(3));

    let cleanupStarted = false;
    const reset = service.runWithTrainingDataReset(() => {
      cleanupStarted = true;
    });
    await vi.waitFor(() => {
      expect(requestSignals).toHaveLength(3);
      for (const signal of requestSignals) {
        expect(signal).toMatchObject({
          aborted: true,
          reason: 'training_data_reset',
        });
      }
    });
    expect(cleanupStarted).toBe(false);

    await expect(service.executeDeepDiagnosis({ payload: deep, consentId: deepConsent.id }))
      .rejects.toSatisfy((error: unknown) => (
        expectServiceCode(error, 'TRAINING_DATA_RESET_IN_PROGRESS')
      ));
    await expect(service.runWithTrainingDataReset(() => undefined))
      .rejects.toSatisfy((error: unknown) => (
        expectServiceCode(error, 'TRAINING_DATA_RESET_IN_PROGRESS')
      ));
    expect(() => service.prepareConsent({ purpose: deep.purpose, payload: deep }))
      .toThrowError(CloudAiServiceError);
    expect(network).toHaveBeenCalledTimes(3);

    for (const resolve of responseResolvers) {
      resolve(completedResponse({}));
    }
    for (const result of await Promise.all(observed)) {
      expectServiceCode(result, 'RESULT_DISCARDED');
      expect(result).toMatchObject({ detail: 'training_data_reset' });
    }
    await expect(reset).resolves.toBeUndefined();
    expect(cleanupStarted).toBe(true);

    expect(service.prepareConsent({ purpose: deep.purpose, payload: deep }))
      .toMatchObject({ purpose: 'deep_diagnosis' });
  });

  it('times out a request, aborts fetch, and persists a safe failed outcome', async () => {
    vi.useFakeTimers();
    const network = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const diagnostics = vi.fn();
    const { service, repository } = createService(network, {
      diagnostics: { record: diagnostics },
    });
    const { consent, policyHash } = approveLive(service);
    const pending = service.executeLiveHint({
      payload: makeLivePayload(policyHash),
      consentId: consent.id,
      explicitAttemptAiOn: true,
    }, { timeoutMs: 1_000 });
    // Attach the rejection observer before advancing fake time so Node never
    // sees a transiently unhandled timeout rejection.
    const observed = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);
    expectServiceCode(await observed, 'REQUEST_TIMEOUT');
    expect(network.mock.calls[0]?.[1]?.signal).toMatchObject({ aborted: true, reason: 'timeout' });
    expect([...repository.requests.values()].at(-1)).toMatchObject({
      status: 'failed',
      outcomeCode: 'request_timeout',
    });
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      event: 'ai.request.timed_out',
      fields: expect.objectContaining({
        status: 'failed',
        errorCode: 'REQUEST_TIMEOUT',
      }),
    }));
  });

  it('aborts the older live request and discards its late result even if fetch ignores abort', async () => {
    let resolveFirst!: (response: Response) => void;
    const network = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(completedResponse({
        hint: '采用最新提示。',
        evidencePhrase: null,
        criterionId: 'conclusion-first',
      }));
    const { service, repository } = createService(network);
    const { consent, policyHash } = approveLive(service);
    const first = service.executeLiveHint({
      payload: makeLivePayload(policyHash),
      consentId: consent.id,
      explicitAttemptAiOn: true,
    });
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce());
    const firstSignal = network.mock.calls[0]?.[1]?.signal;

    const secondPayload = makeLivePayload(policyHash, {
      requestSequence: 2,
    });
    await expect(service.executeLiveHint({
      payload: secondPayload,
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).resolves.toMatchObject({ hint: '采用最新提示。' });
    expect(firstSignal).toMatchObject({ aborted: true, reason: 'superseded' });

    resolveFirst(completedResponse({
      hint: '绝不能采用的迟到提示。',
      evidencePhrase: null,
      criterionId: 'conclusion-first',
    }));
    await expect(first).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'RESULT_DISCARDED'));
    const statuses = [...repository.requests.values()].map(({ requestSequence, status }) => ({
      requestSequence,
      status,
    }));
    expect(statuses).toEqual(expect.arrayContaining([
      { requestSequence: 1, status: 'discarded' },
      { requestSequence: 2, status: 'completed' },
    ]));

    await expect(service.executeLiveHint({
      payload: makeLivePayload(policyHash),
      consentId: consent.id,
      explicitAttemptAiOn: true,
    })).rejects.toSatisfy((error: unknown) => expectServiceCode(error, 'RESULT_DISCARDED'));
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('cancels live AI when feedback is turned off and never accepts the late response', async () => {
    let resolveLate!: (response: Response) => void;
    const network = vi.fn<typeof fetch>(() => new Promise((resolve) => { resolveLate = resolve; }));
    const { service } = createService(network);
    const { consent, policyHash } = approveLive(service);
    const pending = service.executeLiveHint({
      payload: makeLivePayload(policyHash),
      consentId: consent.id,
      explicitAttemptAiOn: true,
    });
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce());
    service.cancelLiveHint('attempt-live');
    resolveLate(completedResponse({
      hint: '关闭后迟到。',
      evidencePhrase: null,
      criterionId: null,
    }));
    await expect(pending).rejects.toSatisfy((error: unknown) => {
      expectServiceCode(error, 'RESULT_DISCARDED');
      expect(error).toMatchObject({ detail: 'disabled' });
      return true;
    });
  });
});
