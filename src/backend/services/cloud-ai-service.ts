import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  APPROVED_AI_PROVIDER,
  APPROVED_LIVE_AI_POLICY,
  ApproveAiConsentInputSchema,
  CloudAiConfigurationStatusSchema,
  CloudAiConsentSchema,
  CloudAiConsentStatusSchema,
  DeepDiagnosisResponseSchema,
  ExecuteDeepDiagnosisInputSchema,
  ExecuteLiveHintInputSchema,
  ExecuteSemanticComparisonInputSchema,
  ExactAiPayloadSchema,
  GetCloudAiConsentStatusInputSchema,
  LiveHintResponseSchema,
  PrepareAiConsentInputSchema,
  PreparedAiConsentSchema,
  SaveCloudAiKeyInputSchema,
  SemanticComparisonResponseSchema,
  evidenceReferencesApprovedSource,
  type CloudAiConfigurationStatus,
  type CloudAiConsent,
  type CloudAiConsentStatus,
  type CloudAiPurpose,
  type CloudAiRequestMetadata,
  type DeepDiagnosisResponse,
  type ExactAiPayload,
  type LiveHintPayload,
  type LiveHintResponse,
  type PracticeSession,
  type PracticeArtifact,
  type PrepareAiConsentInput,
  type PreparedAiConsent,
  type RecordDiagnosticEventInput,
  type SemanticComparisonResponse,
  type TranscriptSegment,
  taskContextForCloudAi,
} from '../../shared';
import type { StoredAnalysisInput } from '../repositories/cloud-ai-repository';

const PREPARATION_TTL_MS = 15 * 60 * 1_000;
const MAX_PENDING_PREPARATIONS = 16;
const MAX_APPROVAL_PREVIEW_CHARACTERS = 128_000;
const MAX_REQUEST_BODY_BYTES = 512_000;
const MAX_RESPONSE_BODY_BYTES = 1_000_000;
const MAX_LIVE_HINT_SEGMENT_REFERENCES = 24;
const DEFAULT_TIMEOUT_MS = Object.freeze({
  live_hint: 12_000,
  deep_diagnosis: 30_000,
  comparison: 30_000,
} satisfies Record<CloudAiPurpose, number>);

const LIVE_APPROVED_FIELDS = Object.freeze([
  'finalWindow.text',
  'task.audience',
  'task.modeId',
  'task.objective',
  'task.prompt',
  'task.rubric',
  'task.taskId',
  'task.taskVersion',
]);

const DEEP_APPROVED_FIELDS = Object.freeze([
  'analysisInputId',
  'attemptId',
  'corrections',
  'finalSegments',
  'localEvidence',
  'metrics',
  'purpose',
  'schemaVersion',
  'sessionId',
  'snapshotId',
  'task',
  'transcriptVersion',
]);

const COMPARISON_APPROVED_FIELDS = Object.freeze([
  'analysisInputId',
  'focus',
  'initial',
  'protocolVersion',
  'purpose',
  'retry',
  'schemaVersion',
  'sessionId',
  'task',
]);

const IDENTIFIER_JSON_SCHEMA = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 96,
  pattern: '^[a-z0-9][a-z0-9._-]*$',
});

const OUTPUT_DESCRIPTORS = Object.freeze({
  live_hint: {
    name: 'phrio_live_hint',
    instructions: [
      '你是 Phrio 的实时短提示生成器。只依据已落定的 final 文本与冻结 Rubric 工作。',
      '输出一句平静、可立即执行的短提示；不得冒充最终诊断，不得补写用户没有说过的事实。',
      'evidencePhrase 必须是 finalWindow.text 中的精确短语；没有可靠短语时返回 null。',
      'criterionId 必须来自输入 rubric；无法可靠对应时返回 null。',
    ].join('\n'),
    maxOutputTokens: 300,
    responseSchema: LiveHintResponseSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        hint: { type: 'string', minLength: 1, maxLength: 140 },
        evidencePhrase: { type: ['string', 'null'], minLength: 1, maxLength: 120 },
        criterionId: {
          anyOf: [IDENTIFIER_JSON_SCHEMA, { type: 'null' }],
        },
      },
      required: ['hint', 'evidencePhrase', 'criterionId'],
    },
  },
  deep_diagnosis: {
    name: 'phrio_deep_diagnosis',
    instructions: [
      '你是 Phrio 的完整复盘生成器。只依据冻结快照、可追踪纠正、本地证据与当前任务 Rubric。',
      '每条 observation 都必须可回查；不得把实时短提示当最终诊断。',
      'quote 类 observation 的 evidence 必须用引号包含对应 final 句段中的精确原文短语。',
      '只选择一个训练焦点，并选择输入 task.drills 中与该 criterion 对应的一个短 Drill。',
      '证据不足时明确降低 confidence，不得编造音频、语气或 partial 信息。',
    ].join('\n'),
    maxOutputTokens: 1_800,
    responseSchema: DeepDiagnosisResponseSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        judgment: { type: 'string', minLength: 1, maxLength: 1_000 },
        observations: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: {
                type: 'string',
                enum: ['quote', 'deterministic_metric', 'task_requirement_gap'],
              },
              criterionId: IDENTIFIER_JSON_SCHEMA,
              segmentId: { anyOf: [IDENTIFIER_JSON_SCHEMA, { type: 'null' }] },
              evidence: { type: 'string', minLength: 1, maxLength: 1_000 },
              suggestion: { type: 'string', minLength: 1, maxLength: 1_000 },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            required: [
              'type',
              'criterionId',
              'segmentId',
              'evidence',
              'suggestion',
              'confidence',
            ],
          },
        },
        focus: {
          type: 'object',
          additionalProperties: false,
          properties: {
            criterionId: IDENTIFIER_JSON_SCHEMA,
            label: { type: 'string', minLength: 1, maxLength: 180 },
            reason: { type: 'string', minLength: 1, maxLength: 1_000 },
            drillId: IDENTIFIER_JSON_SCHEMA,
            drill: { type: 'string', minLength: 1, maxLength: 1_000 },
          },
          required: ['criterionId', 'label', 'reason', 'drillId', 'drill'],
        },
      },
      required: ['judgment', 'observations', 'focus'],
    },
  },
  comparison: {
    name: 'phrio_semantic_comparison',
    instructions: [
      '你是 Phrio 的同口径前后比较器。只比较输入中冻结的 initial 与 retry。',
      '必须使用 focus.criterionId 和 paired-1 口径；不要改换焦点，不要给总分。',
      'initialEvidence 与 retryEvidence 只放可从相应 final 文本、本地证据或确定性指标回查的依据。',
      '每条 evidence 必须用引号包含对应轮次 final 或本地证据中的精确短语；非证据不足结果两侧都至少一条。',
      '证据不足时返回 insufficient_evidence。',
    ].join('\n'),
    maxOutputTokens: 1_200,
    responseSchema: SemanticComparisonResponseSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        result: {
          type: 'string',
          enum: ['improved', 'stable', 'regressed', 'insufficient_evidence'],
        },
        explanation: { type: 'string', minLength: 1, maxLength: 1_000 },
        initialEvidence: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 1_000 },
        },
        retryEvidence: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 1_000 },
        },
      },
      required: ['result', 'explanation', 'initialEvidence', 'retryEvidence'],
    },
  },
} satisfies Record<CloudAiPurpose, OutputDescriptor<unknown>>);

export interface CloudAiPersistence {
  getConsent(id: string): CloudAiConsent | null;
  listConsents(purpose?: CloudAiPurpose): readonly CloudAiConsent[];
  putConsent(input: CloudAiConsent): CloudAiConsent;
  revokeConsent(id: string, revokedAt: string): CloudAiConsent;
  putAnalysisInput(input: StoredAnalysisInput): StoredAnalysisInput;
  putRequest(input: CloudAiRequestMetadata): CloudAiRequestMetadata;
  listRequests(): readonly CloudAiRequestMetadata[];
}

type CloudPracticeArtifact = Extract<PracticeArtifact, {
  type: 'cloud_deep_diagnosis' | 'cloud_semantic_comparison';
}>;

export interface CloudAiSecretStore {
  isEncryptionAvailable(): boolean;
  getStatus(): Promise<{
    readonly configured: boolean;
    readonly keyHint: string | null;
    readonly keyStorage: 'system_encrypted' | 'local_private_file_unencrypted';
  }>;
  save(apiKey: string): Promise<void>;
  read(): Promise<string>;
  delete(): Promise<void>;
}

export interface CloudAiServiceOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly createId?: () => string;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
  /** Trusted main-process lookups. Live AI is unavailable without both authorities. */
  readonly getPracticeSession?: (sessionId: string) => PracticeSession | null;
  readonly getAsrFinalSegments?: (input: {
    readonly attemptId: string;
    readonly generation: number;
  }) => readonly TranscriptSegment[];
  readonly releaseAsrAttemptLedger?: (input: {
    readonly attemptId: string;
    readonly generation: number;
  }) => void;
  readonly diagnostics?: CloudAiDiagnosticSink;
}

export interface CloudAiDiagnosticSink {
  record(input: RecordDiagnosticEventInput): unknown;
}

export interface CloudAiExecutionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface OutputDescriptor<T> {
  readonly name: string;
  readonly instructions: string;
  readonly maxOutputTokens: number;
  readonly responseSchema: z.ZodType<T>;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
}

interface StoredPreparation {
  readonly prepared: PreparedAiConsent;
  readonly source: PrepareAiConsentInput;
  readonly preparedAtMs: number;
}

interface LiveOrder {
  readonly generation: number;
  readonly phaseEpoch: number;
  readonly transcriptVersion: number;
  readonly requestSequence: number;
}

interface LiveAttemptLease {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly taskHash: string;
  aiEnabled: boolean;
  sealed: boolean;
}

export interface LiveAttemptLeaseIdentity {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly generation: number;
}

interface ActiveLiveRequest {
  readonly token: symbol;
  readonly order: LiveOrder;
  readonly consentId: string;
  readonly controller: AbortController;
}

interface RequestContext {
  readonly requestId: string;
  readonly payloadHash: string;
  readonly consent: CloudAiConsent;
  readonly metadata: CloudAiRequestMetadata;
  readonly liveToken: symbol | null;
  readonly controller: AbortController;
}

interface PendingLiveSetup {
  readonly order: LiveOrder;
  readonly countKey: string;
  readonly requestCount: number;
  readonly previous: ActiveLiveRequest | undefined;
}

interface InFlightCloudRequest {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly consentId: string;
  readonly sessionId: string | null;
  readonly attemptIds: readonly string[];
}

interface CloudRequestIdentity {
  readonly consentId: string;
  readonly sessionId: string | null;
  readonly attemptIds: readonly string[];
}

export interface SessionDataDeletionScope {
  readonly sessionId: string;
  readonly attemptIds: readonly string[];
}

/**
 * Owns the last cloud boundary. The renderer never supplies a provider URL,
 * model, API key, arbitrary body, audio, or partial transcript.
 */
export class CloudAiService {
  readonly #repository: CloudAiPersistence;
  readonly #secrets: CloudAiSecretStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #monotonicNow: () => number;
  readonly #createId: () => string;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;
  readonly #getPracticeSession: CloudAiServiceOptions['getPracticeSession'];
  readonly #getAsrFinalSegments: CloudAiServiceOptions['getAsrFinalSegments'];
  readonly #releaseAsrAttemptLedger: CloudAiServiceOptions['releaseAsrAttemptLedger'];
  readonly #diagnostics: CloudAiDiagnosticSink | undefined;
  readonly #preparations = new Map<string, StoredPreparation>();
  readonly #activeLiveRequests = new Map<string, ActiveLiveRequest>();
  readonly #latestLiveOrders = new Map<string, LiveOrder>();
  readonly #liveRequestCounts = new Map<string, number>();
  readonly #liveAttemptLeases = new Map<string, LiveAttemptLease>();
  readonly #sealedLiveAttempts = new Set<string>();
  readonly #inFlightRequests = new Map<symbol, InFlightCloudRequest>();
  readonly #activeDeepRequests = new Map<string, Promise<DeepDiagnosisResponse>>();
  readonly #sessionDataDeletionScopes = new Map<string, ReadonlySet<string>>();
  #keyMutationTail: Promise<void> = Promise.resolve();
  #apiKeyDeletionInProgress = false;
  #trainingDataResetInProgress = false;

  constructor(
    repository: CloudAiPersistence,
    secrets: CloudAiSecretStore,
    options: CloudAiServiceOptions = {},
  ) {
    this.#repository = repository;
    this.#secrets = secrets;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#createId = options.createId ?? randomUUID;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#getPracticeSession = options.getPracticeSession;
    this.#getAsrFinalSegments = options.getAsrFinalSegments;
    this.#releaseAsrAttemptLedger = options.releaseAsrAttemptLedger;
    this.#diagnostics = options.diagnostics;
  }

  async getConfigurationStatus(): Promise<CloudAiConfigurationStatus> {
    await this.#keyMutationTail;
    return this.#readConfigurationStatus();
  }

  async #readConfigurationStatus(): Promise<CloudAiConfigurationStatus> {
    const encryptionAvailable = this.#secrets.isEncryptionAvailable();
    const status = await this.#secrets.getStatus();
    return CloudAiConfigurationStatusSchema.parse({
      provider: APPROVED_AI_PROVIDER.id,
      providerName: APPROVED_AI_PROVIDER.name,
      model: APPROVED_AI_PROVIDER.model,
      endpoint: APPROVED_AI_PROVIDER.endpoint,
      protocolVersion: APPROVED_AI_PROVIDER.protocolVersion,
      configured: status.configured,
      encryptionAvailable,
      keyStorage: status.keyStorage,
      keyHint: status.keyHint,
      retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
    });
  }

  async saveApiKey(input: unknown): Promise<CloudAiConfigurationStatus> {
    const parsed = parseInput(SaveCloudAiKeyInputSchema, input);
    return this.#runKeyMutation(async () => {
      try {
        await this.#secrets.save(parsed.apiKey);
      } catch (error) {
        throw normalizeSecretError(error);
      }
      return this.#readConfigurationStatus();
    });
  }

  async deleteApiKey(): Promise<CloudAiConfigurationStatus> {
    if (this.#apiKeyDeletionInProgress) {
      throw new CloudAiServiceError('SECRET_STORAGE_FAILED', 'api_key_deletion_in_progress');
    }
    // Set the gate synchronously, before waiting behind an earlier key save, so
    // no request can enter between the user's delete action and the drain.
    this.#apiKeyDeletionInProgress = true;
    try {
      return await this.#runKeyMutation(async () => {
        const inFlight = [...this.#inFlightRequests.values()];
        for (const request of inFlight) {
          if (!request.controller.signal.aborted) request.controller.abort('api_key_deleted');
        }
        await Promise.all(inFlight.map((request) => request.settled));

        this.#activeLiveRequests.clear();
        this.#activeDeepRequests.clear();
        this.#latestLiveOrders.clear();
        this.#liveRequestCounts.clear();
        // Keep the local-ASR lease and final ledger alive. Deleting a cloud key
        // must not interrupt local transcription, but every lease returns to the
        // explicit-AI-OFF state before a future key can be used.
        for (const lease of this.#liveAttemptLeases.values()) lease.aiEnabled = false;

        try {
          await this.#secrets.delete();
        } catch {
          throw new CloudAiServiceError('SECRET_STORAGE_FAILED');
        }
        return this.#readConfigurationStatus();
      });
    } finally {
      this.#apiKeyDeletionInProgress = false;
    }
  }

  /**
   * Establishes an atomic boundary around destructive training-data cleanup.
   * No new consent or cloud execution may begin until the supplied cleanup has
   * completed, and every request that entered before the gate is settled first.
   */
  async runWithTrainingDataReset<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.#trainingDataResetInProgress || this.#sessionDataDeletionScopes.size > 0) {
      throw new CloudAiServiceError('TRAINING_DATA_RESET_IN_PROGRESS');
    }
    this.#trainingDataResetInProgress = true;
    this.#preparations.clear();

    try {
      const inFlight = [...this.#inFlightRequests.values()];
      for (const request of inFlight) {
        if (!request.controller.signal.aborted) {
          request.controller.abort('training_data_reset');
        }
      }
      await Promise.all(inFlight.map((request) => request.settled));

      this.#activeLiveRequests.clear();
      this.#activeDeepRequests.clear();
      this.#latestLiveOrders.clear();
      this.#liveRequestCounts.clear();
      return await operation();
    } finally {
      this.#trainingDataResetInProgress = false;
    }
  }

  /** Cancels and drains only work derived from the Session being deleted. */
  async runWithSessionDataDeletion<T>(
    scope: SessionDataDeletionScope,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    this.#assertTrainingDataWritable();
    if (this.#sessionDataDeletionScopes.has(scope.sessionId)) {
      throw new CloudAiServiceError('TRAINING_DATA_RESET_IN_PROGRESS');
    }
    const attemptIds = new Set(scope.attemptIds);
    this.#sessionDataDeletionScopes.set(scope.sessionId, attemptIds);
    for (const [preparationId, preparation] of this.#preparations) {
      if (consentSourceMatchesDeletion(preparation.source, scope.sessionId, attemptIds)) {
        this.#preparations.delete(preparationId);
      }
    }

    try {
      const inFlight = [...this.#inFlightRequests.values()].filter((request) => (
        requestMatchesDeletion(request, scope.sessionId, attemptIds)
      ));
      for (const request of inFlight) {
        if (!request.controller.signal.aborted) {
          request.controller.abort('session_data_deleted');
        }
      }
      await Promise.all(inFlight.map((request) => request.settled));

      for (const attemptId of attemptIds) {
        this.#activeLiveRequests.delete(attemptId);
        this.#latestLiveOrders.delete(attemptId);
        for (const countKey of this.#liveRequestCounts.keys()) {
          if (countKey.startsWith(`${attemptId}:`)) this.#liveRequestCounts.delete(countKey);
        }
      }
      return await operation();
    } finally {
      this.#sessionDataDeletionScopes.delete(scope.sessionId);
    }
  }

  getConsentStatus(input: unknown): CloudAiConsentStatus {
    const { purpose } = parseInput(GetCloudAiConsentStatusInputSchema, input);
    const now = this.#now().getTime();
    const consent = this.#repository
      .listConsents(purpose)
      .filter((candidate) => {
        const parsed = CloudAiConsentSchema.parse(candidate);
        return parsed.purpose === purpose
          && parsed.promptVersion === APPROVED_AI_PROVIDER.promptVersion
          && parsed.revokedAt === null
          && (parsed.expiresAt === null || Date.parse(parsed.expiresAt) > now);
      })
      .sort((left, right) => Date.parse(right.approvedAt) - Date.parse(left.approvedAt))[0] ?? null;
    return CloudAiConsentStatusSchema.parse({
      purpose,
      active: consent !== null,
      consent: consent ? {
        id: consent.id,
        purpose: consent.purpose,
        scope: consent.scope,
        provider: consent.provider,
        model: consent.model,
        endpoint: consent.endpoint,
        payloadHash: consent.payloadHash,
        policyHash: consent.policyHash,
        schemaVersion: consent.schemaVersion,
        promptVersion: consent.promptVersion,
        approvedFields: consent.approvedFields,
        approvedAt: consent.approvedAt,
        expiresAt: consent.expiresAt,
      } : null,
    });
  }

  prepareConsent(input: unknown): PreparedAiConsent {
    this.#assertTrainingDataWritable();
    const source = parseInput(PrepareAiConsentInputSchema, input);
    this.#assertConsentSourceWritable(source);
    const preparedAt = this.#now();
    this.#prunePreparations(preparedAt.getTime());
    const preparationId = this.#createId();

    let scope: PreparedAiConsent['scope'];
    let payloadHash: string | null;
    let policyHash: string;
    let schemaVersion: string;
    let approvedFields: readonly string[];
    let previewJson: string;

    if (source.purpose === 'live_hint') {
      if (
        canonicalJson(source.policy) !== canonicalJson(APPROVED_LIVE_AI_POLICY)
        || !sameStringSet(source.policy.sentFieldPaths, LIVE_APPROVED_FIELDS)
      ) {
        throw new CloudAiServiceError('CONSENT_SCOPE_MISMATCH');
      }
      scope = 'configuration';
      payloadHash = null;
      policyHash = canonicalSha256(APPROVED_LIVE_AI_POLICY);
      schemaVersion = source.policy.policyVersion;
      approvedFields = normalizeApprovedFields(source.policy.sentFieldPaths);
      previewJson = canonicalJson(source.policy);
    } else {
      scope = 'payload';
      payloadHash = canonicalSha256(source.payload);
      schemaVersion = source.payload.schemaVersion;
      approvedFields = source.purpose === 'deep_diagnosis'
        ? DEEP_APPROVED_FIELDS
        : COMPARISON_APPROVED_FIELDS;
      policyHash = purposePolicyHash(source.purpose, schemaVersion, approvedFields);
      previewJson = canonicalJson(source.payload);
    }

    if (
      previewJson.length > MAX_APPROVAL_PREVIEW_CHARACTERS
      || Buffer.byteLength(previewJson, 'utf8') > MAX_REQUEST_BODY_BYTES
    ) {
      throw new CloudAiServiceError('PAYLOAD_TOO_LARGE');
    }

    const prepared = PreparedAiConsentSchema.parse({
      preparationId,
      purpose: source.purpose,
      scope,
      provider: APPROVED_AI_PROVIDER.id,
      model: APPROVED_AI_PROVIDER.model,
      endpoint: APPROVED_AI_PROVIDER.endpoint,
      payloadHash,
      policyHash,
      schemaVersion,
      promptVersion: APPROVED_AI_PROVIDER.promptVersion,
      approvedFields: [...approvedFields],
      previewJson,
      retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
      preparedAt: preparedAt.toISOString(),
    });

    while (this.#preparations.size >= MAX_PENDING_PREPARATIONS) {
      const oldest = this.#preparations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#preparations.delete(oldest);
    }
    this.#preparations.set(preparationId, {
      prepared,
      source,
      preparedAtMs: preparedAt.getTime(),
    });
    return prepared;
  }

  approveConsent(input: unknown): CloudAiConsent {
    this.#assertTrainingDataWritable();
    const approval = parseInput(ApproveAiConsentInputSchema, input);
    const stored = this.#preparations.get(approval.preparationId);
    if (!stored) throw new CloudAiServiceError('CONSENT_PREPARATION_NOT_FOUND');
    this.#assertConsentSourceWritable(stored.source);
    if (this.#now().getTime() - stored.preparedAtMs > PREPARATION_TTL_MS) {
      this.#preparations.delete(approval.preparationId);
      throw new CloudAiServiceError('CONSENT_PREPARATION_EXPIRED');
    }

    const expected = stored.prepared;
    if (
      approval.purpose !== expected.purpose
      || approval.payloadHash !== expected.payloadHash
      || approval.policyHash !== expected.policyHash
      || !sameStringSet(approval.approvedFields, expected.approvedFields)
    ) {
      throw new CloudAiServiceError('CONSENT_PREPARATION_MISMATCH');
    }

    const approvedAt = this.#now().toISOString();
    const source = stored.source;
    const sessionId = source.purpose === 'live_hint' ? null : source.payload.sessionId;
    const consent = CloudAiConsentSchema.parse({
      id: this.#createId(),
      purpose: expected.purpose,
      scope: expected.scope,
      sessionId,
      provider: APPROVED_AI_PROVIDER.id,
      model: APPROVED_AI_PROVIDER.model,
      endpoint: APPROVED_AI_PROVIDER.endpoint,
      payloadHash: expected.payloadHash,
      policyHash: expected.policyHash,
      schemaVersion: expected.schemaVersion,
      promptVersion: APPROVED_AI_PROVIDER.promptVersion,
      approvedFields: expected.approvedFields,
      approvedAt,
      expiresAt: null,
      revokedAt: null,
    });
    const persisted = this.#repository.putConsent(consent);

    if (source.purpose !== 'live_hint') {
      this.#repository.putAnalysisInput({
        id: this.#createId(),
        sessionId: source.payload.sessionId,
        purpose: source.purpose,
        payloadHash: expected.payloadHash!,
        payload: source.payload,
        consentId: persisted.id,
        approvedAt,
      });
    }

    this.#preparations.delete(approval.preparationId);
    return persisted;
  }

  revokeConsent(consentId: string): CloudAiConsent {
    this.#assertTrainingDataWritable();
    const parsed = z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9._-]*$/).safeParse(consentId);
    if (!parsed.success) throw new CloudAiServiceError('INVALID_INPUT');
    const revokedAt = this.#now().toISOString();
    let revoked: CloudAiConsent;
    try {
      revoked = this.#repository.revokeConsent(parsed.data, revokedAt);
    } catch {
      throw new CloudAiServiceError('CONSENT_NOT_FOUND');
    }
    for (const request of this.#inFlightRequests.values()) {
      if (request.consentId === revoked.id && !request.controller.signal.aborted) {
        request.controller.abort('consent_revoked');
      }
    }
    for (const [attemptId, active] of this.#activeLiveRequests) {
      if (active.consentId !== revoked.id) continue;
      if (!active.controller.signal.aborted) active.controller.abort('consent_revoked');
      this.#activeLiveRequests.delete(attemptId);
    }
    if (revoked.purpose === 'live_hint') {
      this.releaseAllLiveAttemptLeases('consent_revoked');
    }
    return revoked;
  }

  /**
   * Proves that a renderer-authored cloud artifact came from the exact payload
   * consented to and, when it carries a result, from a completed provider call.
   */
  assertCloudArtifactAttested(artifact: CloudPracticeArtifact): void {
    this.#assertTrainingDataWritable();
    const envelope = artifact.payload;
    const payload = ExactAiPayloadSchema.parse(envelope.approvedPayload);
    if (payload.purpose === 'live_hint') {
      throw new CloudAiServiceError('CLOUD_ARTIFACT_NOT_ATTESTED');
    }
    const payloadHash = canonicalSha256(payload);
    if (envelope.payloadHash !== payloadHash) {
      throw new CloudAiServiceError('CLOUD_ARTIFACT_NOT_ATTESTED');
    }

    const consent = this.#repository.getConsent(envelope.consentId);
    if (
      !consent
      || consent.purpose !== payload.purpose
      || consent.scope !== 'payload'
      || consent.sessionId !== payload.sessionId
      || consent.payloadHash !== payloadHash
      || consent.provider !== APPROVED_AI_PROVIDER.id
      || consent.model !== APPROVED_AI_PROVIDER.model
      || consent.endpoint !== APPROVED_AI_PROVIDER.endpoint
    ) {
      throw new CloudAiServiceError('CLOUD_ARTIFACT_NOT_ATTESTED');
    }

    const consentExpired = consent.expiresAt !== null
      && Date.parse(consent.expiresAt) <= this.#now().getTime();
    const nowMs = this.#now().getTime();
    if (
      Date.parse(envelope.createdAt) < Date.parse(consent.approvedAt)
      || Date.parse(envelope.updatedAt) > nowMs + 10_000
    ) {
      throw new CloudAiServiceError('CLOUD_ARTIFACT_NOT_ATTESTED');
    }
    if (
      (envelope.status === 'queued'
        || envelope.status === 'processing'
        || envelope.status === 'complete')
      && (
        consent.revokedAt !== null
        || consentExpired
        || consent.promptVersion !== APPROVED_AI_PROVIDER.promptVersion
      )
    ) {
      throw new CloudAiServiceError('CLOUD_ARTIFACT_NOT_ATTESTED');
    }

    const requests = this.#repository.listRequests().filter((request) => (
      request.purpose === payload.purpose
      && request.consentId === consent.id
      && request.payloadHash === payloadHash
      && request.sessionId === payload.sessionId
      && request.attemptId === attemptIdOf(payload)
    ));

    if (envelope.result !== null) {
      const resultHash = canonicalSha256(envelope.result);
      const attested = requests.find((request) => (
        request.status === 'completed'
        && request.outcomeCode === 'ok'
        && request.resultHash === resultHash
      ));
      if (!attested) throw new CloudAiServiceError('CLOUD_ARTIFACT_NOT_ATTESTED');
      if (
        !attested.completedAt
        || Date.parse(envelope.updatedAt) < Date.parse(attested.completedAt)
      ) {
        throw new CloudAiServiceError('CLOUD_ARTIFACT_NOT_ATTESTED');
      }
    }

    if (envelope.status === 'failed') {
      const normalizedError = normalizeArtifactErrorCode(envelope.errorCode);
      const attestedFailure = requests.find((request) => (
        (request.status === 'failed' || request.status === 'discarded')
        && (
          request.outcomeCode === normalizedError
          || (request.status === 'discarded' && normalizedError === 'result_discarded')
        )
      ));
      const truthfulPreRequestFailure = (
        consent.revokedAt !== null && normalizedError === 'consent_revoked'
      ) || (
        consentExpired && normalizedError === 'consent_expired'
      ) || (
        consent.promptVersion !== APPROVED_AI_PROVIDER.promptVersion
        && normalizedError === 'consent_scope_mismatch'
      );
      if (!attestedFailure && !truthfulPreRequestFailure) {
        throw new CloudAiServiceError('CLOUD_ARTIFACT_NOT_ATTESTED');
      }
      if (
        attestedFailure
        && (
          !attestedFailure.completedAt
          || Date.parse(envelope.updatedAt) < Date.parse(attestedFailure.completedAt)
        )
      ) {
        throw new CloudAiServiceError('CLOUD_ARTIFACT_NOT_ATTESTED');
      }
    }
  }

  /** Opens a trusted lease from the persisted Session before ASR starts. */
  openLiveAttemptLease(input: {
    readonly session: PracticeSession;
    readonly attemptId: string;
    readonly generation: number;
  }): LiveAttemptLeaseIdentity {
    this.#assertTrainingDataWritable();
    const session = input.session;
    if (
      !this.#getPracticeSession
      || !this.#getAsrFinalSegments
      || !input.attemptId
      || !Number.isInteger(input.generation)
      || input.generation <= 0
      || !isLiveAttemptSessionStatus(session.status)
    ) {
      throw new CloudAiServiceError('LIVE_ATTEMPT_LEASE_REJECTED');
    }
    const current = this.#getPracticeSession(session.id);
    if (!current || canonicalSha256(current) !== canonicalSha256(session)) {
      throw new CloudAiServiceError('LIVE_ATTEMPT_LEASE_REJECTED');
    }
    const taskHash = canonicalSha256(liveTaskForSession(current));
    const key = liveLeaseKey(input.attemptId, input.generation);
    const existing = this.#liveAttemptLeases.get(key);
    if (existing) {
      if (existing.sessionId !== session.id || existing.taskHash !== taskHash) {
        throw new CloudAiServiceError('LIVE_ATTEMPT_LEASE_REJECTED');
      }
      return leaseIdentity(existing);
    }

    // A Session has only one current recording generation. Re-recording revokes
    // the old generation before the new local-ASR stream is accepted.
    this.releaseLiveSessionLeases(session.id, 'superseded');
    const lease: LiveAttemptLease = {
      sessionId: session.id,
      attemptId: input.attemptId,
      generation: input.generation,
      taskHash,
      aiEnabled: false,
      sealed: this.#sealedLiveAttempts.has(key),
    };
    this.#liveAttemptLeases.set(key, lease);
    return leaseIdentity(lease);
  }

  hasLiveAttemptLease(input: {
    readonly attemptId: string;
    readonly generation: number;
  }): boolean {
    return this.#liveAttemptLeases.has(liveLeaseKey(input.attemptId, input.generation));
  }

  setLiveAttemptAiState(input: LiveAttemptLeaseIdentity & {
    readonly enabled: boolean;
    readonly sealed?: boolean;
  }): LiveAttemptLeaseIdentity & { readonly enabled: boolean } {
    const lease = this.#requireLiveAttemptLease(input);
    if (input.sealed) {
      lease.sealed = true;
      this.#sealedLiveAttempts.add(liveLeaseKey(input.attemptId, input.generation));
    }
    if (input.enabled && lease.sealed) {
      throw new CloudAiServiceError('LIVE_ATTEMPT_SEALED');
    }
    lease.aiEnabled = input.enabled;
    if (!input.enabled) this.#abortLiveAttempt(input.attemptId, 'disabled');
    return { ...leaseIdentity(lease), enabled: lease.aiEnabled };
  }

  releaseLiveAttemptLease(input: LiveAttemptLeaseIdentity): void {
    const key = liveLeaseKey(input.attemptId, input.generation);
    const lease = this.#liveAttemptLeases.get(key);
    if (!lease || lease.sessionId !== input.sessionId) return;
    this.#abortLiveAttempt(lease.attemptId, 'disabled');
    this.#liveAttemptLeases.delete(key);
    this.#releaseAsrAttemptLedger?.(lease);
  }

  releaseLiveAttemptGeneration(input: {
    readonly attemptId: string;
    readonly generation: number;
  }): void {
    const lease = this.#liveAttemptLeases.get(liveLeaseKey(input.attemptId, input.generation));
    if (lease) this.releaseLiveAttemptLease(leaseIdentity(lease));
    else this.#releaseAsrAttemptLedger?.(input);
  }

  releaseLiveSessionLeases(sessionId: string, reason = 'session_data_deleted'): void {
    for (const [key, lease] of this.#liveAttemptLeases) {
      if (lease.sessionId !== sessionId) continue;
      this.#abortLiveAttempt(lease.attemptId, reason);
      this.#liveAttemptLeases.delete(key);
      this.#releaseAsrAttemptLedger?.(lease);
    }
  }

  releaseAllLiveAttemptLeases(reason = 'training_data_reset'): void {
    for (const lease of this.#liveAttemptLeases.values()) {
      this.#abortLiveAttempt(lease.attemptId, reason);
      this.#releaseAsrAttemptLedger?.(lease);
    }
    this.#liveAttemptLeases.clear();
    if (reason === 'training_data_reset') this.#sealedLiveAttempts.clear();
  }

  async executeLiveHint(
    input: unknown,
    options: CloudAiExecutionOptions = {},
  ): Promise<LiveHintResponse> {
    const parsed = parseInput(ExecuteLiveHintInputSchema, input);
    this.#assertLiveAttemptAuthorized(parsed.payload);
    const identity = requestIdentityOf(parsed.payload, parsed.consentId);
    return this.#runTrackedRequest(
      identity,
      (signal) => this.#executeRequest(
        parsed.payload,
        parsed.consentId,
        parsed.explicitAttemptAiOn,
        OUTPUT_DESCRIPTORS.live_hint,
        { ...options, signal },
      ),
      options.signal,
    );
  }

  async executeDeepDiagnosis(
    input: unknown,
    options: CloudAiExecutionOptions = {},
  ): Promise<DeepDiagnosisResponse> {
    const parsed = parseInput(ExecuteDeepDiagnosisInputSchema, input);
    const identity = requestIdentityOf(parsed.payload, parsed.consentId);
    this.#assertRequestWritable(identity);
    const requestIdentity = [
      parsed.payload.analysisInputId,
      canonicalSha256(parsed.payload),
      parsed.consentId,
    ].join(':');
    const active = this.#activeDeepRequests.get(requestIdentity);
    if (active) return active;

    const execution = this.#runTrackedRequest(
      identity,
      (signal) => this.#executeRequest(
        parsed.payload,
        parsed.consentId,
        false,
        OUTPUT_DESCRIPTORS.deep_diagnosis,
        { ...options, signal },
      ),
      options.signal,
    );
    this.#activeDeepRequests.set(requestIdentity, execution);
    const clearIdentity = () => {
      if (this.#activeDeepRequests.get(requestIdentity) === execution) {
        this.#activeDeepRequests.delete(requestIdentity);
      }
    };
    void execution.then(clearIdentity, clearIdentity);
    return execution;
  }

  async executeSemanticComparison(
    input: unknown,
    options: CloudAiExecutionOptions = {},
  ): Promise<SemanticComparisonResponse> {
    const parsed = parseInput(ExecuteSemanticComparisonInputSchema, input);
    const identity = requestIdentityOf(parsed.payload, parsed.consentId);
    return this.#runTrackedRequest(
      identity,
      (signal) => this.#executeRequest(
        parsed.payload,
        parsed.consentId,
        false,
        OUTPUT_DESCRIPTORS.comparison,
        { ...options, signal },
      ),
      options.signal,
    );
  }

  cancelLiveHint(attemptId: string): void {
    for (const lease of this.#liveAttemptLeases.values()) {
      if (lease.attemptId === attemptId) lease.aiEnabled = false;
    }
    this.#abortLiveAttempt(attemptId, 'disabled');
    this.#recordDiagnostic({
      level: 'info',
      component: 'ai',
      event: 'ai.live.cancelled',
      attemptId,
      fields: { reasonCode: 'disabled' },
    });
  }

  #abortLiveAttempt(attemptId: string, reason: string): void {
    const active = this.#activeLiveRequests.get(attemptId);
    if (!active) return;
    active.controller.abort(reason);
    this.#activeLiveRequests.delete(attemptId);
  }

  #runTrackedRequest<T>(
    identity: CloudRequestIdentity,
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal: AbortSignal | undefined,
  ): Promise<T> {
    this.#assertRequestWritable(identity);
    const token = Symbol('cloud-request');
    const controller = new AbortController();
    const removeExternalAbort = forwardAbort(externalSignal, controller);
    const execution = operation(controller.signal);
    const tracked = execution.finally(() => {
      removeExternalAbort();
      this.#inFlightRequests.delete(token);
    });
    const settled = tracked.then(
      () => undefined,
      () => undefined,
    );
    this.#inFlightRequests.set(token, { controller, settled, ...identity });
    return tracked;
  }

  async #executeRequest<T>(
    rawPayload: ExactAiPayload,
    consentId: string,
    explicitAttemptAiOn: boolean,
    descriptor: OutputDescriptor<T>,
    options: CloudAiExecutionOptions,
  ): Promise<T> {
    const payload = ExactAiPayloadSchema.parse(rawPayload);
    if (payload.purpose === 'live_hint') this.#assertLiveAttemptAuthorized(payload);
    const timeoutMs = validatedTimeout(options.timeoutMs, payload.purpose);
    assertApprovedTransport();
    assertNoForbiddenCloudFields(payload);
    const payloadHash = canonicalSha256(payload);
    const consent = this.#validateConsent(
      payload,
      payloadHash,
      consentId,
      explicitAttemptAiOn,
    );
    const context = this.#createRequestContext(payload, payloadHash, consent);
    const requestStartedAt = this.#monotonicNow();
    let pendingLiveSetup: PendingLiveSetup | null = null;

    if (payload.purpose === 'live_hint') {
      assertLivePolicyPayload(payload);
      const order = liveOrderOf(payload);
      const latest = this.#latestLiveOrders.get(payload.attemptId);
      if (latest && compareLiveOrder(order, latest) <= 0) {
        this.#persistFinalRequest(context.metadata, 'discarded', 'stale_order', null);
        this.#recordRequestDiagnostic(context, payload.purpose, {
          level: 'warn',
          event: 'ai.request.discarded',
          fields: {
            status: 'discarded',
            outcomeCode: 'stale_order',
            durationMs: diagnosticElapsedMilliseconds(requestStartedAt, this.#monotonicNow()),
          },
        });
        throw new CloudAiServiceError('RESULT_DISCARDED', 'stale_order');
      }
      const countKey = `${payload.attemptId}:${payload.generation}`;
      const requestCount = this.#liveRequestCounts.get(countKey) ?? 0;
      if (requestCount >= APPROVED_LIVE_AI_POLICY.maximumRequests) {
        this.#persistFinalRequest(context.metadata, 'discarded', 'policy_request_limit', null);
        this.#recordRequestDiagnostic(context, payload.purpose, {
          level: 'warn',
          event: 'ai.request.discarded',
          fields: {
            status: 'discarded',
            outcomeCode: 'policy_request_limit',
            durationMs: diagnosticElapsedMilliseconds(requestStartedAt, this.#monotonicNow()),
          },
        });
        throw new CloudAiServiceError('LIVE_POLICY_LIMIT_EXCEEDED', 'policy_request_limit');
      }
      pendingLiveSetup = {
        order,
        countKey,
        requestCount,
        previous: this.#activeLiveRequests.get(payload.attemptId),
      };
    }

    // Exact Deep/Comparison payloads were already frozen once at approval.
    // Live configuration consent has no exact payload, so each actually sent
    // final-only window is frozen here without duplicating deep transcript data.
    if (payload.purpose === 'live_hint') {
      this.#repository.putAnalysisInput({
        id: context.requestId,
        sessionId: payload.sessionId,
        purpose: payload.purpose,
        payloadHash,
        payload,
        consentId: consent.id,
        approvedAt: consent.approvedAt,
      });
    }
    this.#recordRequestDiagnostic(context, payload.purpose, {
      level: 'info',
      event: 'ai.request.queued',
      fields: {
        status: 'queued',
        timeoutMs,
        provider: APPROVED_AI_PROVIDER.id,
        model: APPROVED_AI_PROVIDER.model,
      },
    });
    this.#repository.putRequest(context.metadata);
    this.#repository.putRequest({ ...context.metadata, status: 'processing' });
    this.#recordRequestDiagnostic(context, payload.purpose, {
      level: 'info',
      event: 'ai.request.started',
      fields: {
        status: 'processing',
        timeoutMs,
        durationMs: diagnosticElapsedMilliseconds(requestStartedAt, this.#monotonicNow()),
      },
    });

    if (payload.purpose === 'live_hint' && pendingLiveSetup) {
      this.#liveRequestCounts.set(
        pendingLiveSetup.countKey,
        pendingLiveSetup.requestCount + 1,
      );
      this.#latestLiveOrders.set(payload.attemptId, pendingLiveSetup.order);
      pendingLiveSetup.previous?.controller.abort('superseded');
      this.#activeLiveRequests.set(payload.attemptId, {
        token: context.liveToken!,
        order: pendingLiveSetup.order,
        consentId: consent.id,
        controller: context.controller,
      });
    }

    const timeout = this.#setTimer(() => context.controller.abort('timeout'), timeoutMs);
    const removeExternalAbort = forwardAbort(options.signal, context.controller);

    try {
      if (context.controller.signal.aborted) {
        throw abortError(context.controller.signal.reason);
      }
      let apiKey: string;
      if (payload.purpose === 'live_hint') this.#assertLiveAttemptAuthorized(payload);
      try {
        apiKey = await this.#secrets.read();
      } catch (error) {
        throw normalizeSecretError(error);
      }

      const requestBody = buildResponsesRequest(payload, descriptor);
      const serializedBody = JSON.stringify(requestBody);
      if (Buffer.byteLength(serializedBody, 'utf8') > MAX_REQUEST_BODY_BYTES) {
        throw new CloudAiServiceError('PAYLOAD_TOO_LARGE');
      }

      let response: Response;
      try {
        response = await this.#fetch(APPROVED_AI_PROVIDER.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: serializedBody,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: context.controller.signal,
        });
      } catch (error) {
        if (context.controller.signal.aborted) {
          throw abortError(context.controller.signal.reason);
        }
        throw new CloudAiServiceError('NETWORK_UNAVAILABLE');
      }

      this.#recordRequestDiagnostic(context, payload.purpose, {
        level: response.ok ? 'info' : 'warn',
        event: 'ai.provider.responded',
        fields: {
          provider: APPROVED_AI_PROVIDER.id,
          httpStatus: response.status,
          durationMs: diagnosticElapsedMilliseconds(requestStartedAt, this.#monotonicNow()),
        },
      });

      if (context.controller.signal.aborted) {
        throw abortError(context.controller.signal.reason);
      }
      if (payload.purpose === 'live_hint') {
        this.#assertLiveAttemptAuthorized(payload);
        const active = this.#activeLiveRequests.get(payload.attemptId);
        if (!active || active.token !== context.liveToken) {
          throw new CloudAiServiceError('RESULT_DISCARDED', 'late_result');
        }
      }

      assertApprovedResponse(response);
      assertProviderStatus(response.status);
      const result = await parseProviderResponse(response, descriptor.responseSchema);
      validateResultSemantics(payload, result);
      this.#assertConsentStillActive(context.consent.id);

      if (payload.purpose === 'live_hint') {
        this.#assertLiveAttemptAuthorized(payload);
        const active = this.#activeLiveRequests.get(payload.attemptId);
        if (
          context.controller.signal.aborted
          || !active
          || active.token !== context.liveToken
        ) {
          throw new CloudAiServiceError('RESULT_DISCARDED', 'late_result');
        }
      } else if (context.controller.signal.aborted) {
        throw abortError(context.controller.signal.reason);
      }

      this.#persistFinalRequest(
        context.metadata,
        'completed',
        'ok',
        canonicalSha256(result),
      );
      this.#recordRequestDiagnostic(context, payload.purpose, {
        level: 'info',
        event: 'ai.request.completed',
        fields: {
          status: 'completed',
          outcomeCode: 'ok',
          durationMs: diagnosticElapsedMilliseconds(requestStartedAt, this.#monotonicNow()),
        },
      });
      return result;
    } catch (error) {
      const normalized = normalizeExecutionError(error, context.controller.signal);
      const status = normalized.code === 'RESULT_DISCARDED' ? 'discarded' : 'failed';
      const outcomeCode = normalized.detail ?? normalized.code.toLowerCase();
      this.#persistFinalRequest(context.metadata, status, outcomeCode, null);
      this.#recordRequestDiagnostic(context, payload.purpose, {
        level: normalized.code === 'RESULT_DISCARDED' ? 'warn' : 'error',
        event: normalized.code === 'REQUEST_TIMEOUT'
          ? 'ai.request.timed_out'
          : normalized.code === 'RESULT_DISCARDED'
            ? 'ai.request.discarded'
            : 'ai.request.failed',
        fields: {
          status,
          outcomeCode,
          errorCode: normalized.code,
          durationMs: diagnosticElapsedMilliseconds(requestStartedAt, this.#monotonicNow()),
        },
      });
      throw normalized;
    } finally {
      this.#clearTimer(timeout);
      removeExternalAbort();
      if (payload.purpose === 'live_hint') {
        const active = this.#activeLiveRequests.get(payload.attemptId);
        if (active?.token === context.liveToken) {
          this.#activeLiveRequests.delete(payload.attemptId);
        }
      }
    }
  }

  #recordRequestDiagnostic(
    context: RequestContext,
    purpose: CloudAiPurpose,
    input: Pick<RecordDiagnosticEventInput, 'level' | 'event' | 'fields'>,
  ): void {
    this.#recordDiagnostic({
      ...input,
      component: 'ai',
      sessionId: context.metadata.sessionId,
      attemptId: context.metadata.attemptId,
      requestId: context.requestId,
      fields: { purpose, ...input.fields },
    });
  }

  #recordDiagnostic(input: RecordDiagnosticEventInput): void {
    recordCloudDiagnosticFailOpen(this.#diagnostics, input);
  }

  #requireLiveAttemptLease(input: LiveAttemptLeaseIdentity): LiveAttemptLease {
    const lease = this.#liveAttemptLeases.get(liveLeaseKey(input.attemptId, input.generation));
    if (
      !lease
      || lease.sessionId !== input.sessionId
      || lease.attemptId !== input.attemptId
      || lease.generation !== input.generation
    ) {
      throw new CloudAiServiceError('LIVE_ATTEMPT_LEASE_REQUIRED');
    }
    const session = this.#getPracticeSession?.(lease.sessionId) ?? null;
    if (
      !session
      || !isLiveAttemptSessionStatus(session.status)
      || canonicalSha256(liveTaskForSession(session)) !== lease.taskHash
    ) {
      this.releaseLiveAttemptLease(leaseIdentity(lease));
      throw new CloudAiServiceError('LIVE_ATTEMPT_LEASE_REJECTED');
    }
    return lease;
  }

  #assertLiveAttemptAuthorized(payload: LiveHintPayload): LiveAttemptLease {
    const lease = this.#requireLiveAttemptLease(payload);
    if (!lease.aiEnabled) throw new CloudAiServiceError('ATTEMPT_AI_OFF');
    if (payload.phaseEpoch !== lease.generation) {
      throw new CloudAiServiceError('LIVE_ATTEMPT_LEASE_REJECTED');
    }
    const session = this.#getPracticeSession?.(lease.sessionId) ?? null;
    if (!session || canonicalSha256(liveTaskForSession(session)) !== canonicalSha256(payload.task)) {
      throw new CloudAiServiceError('LIVE_TASK_NOT_FROZEN');
    }
    const ledger = this.#getAsrFinalSegments?.({
      attemptId: lease.attemptId,
      generation: lease.generation,
    }) ?? [];
    assertLiveFinalWindowAttested(payload, ledger);
    return lease;
  }

  #validateConsent(
    payload: ExactAiPayload,
    payloadHash: string,
    consentId: string,
    explicitAttemptAiOn: boolean,
  ): CloudAiConsent {
    const consent = this.#repository.getConsent(consentId);
    if (!consent) throw new CloudAiServiceError('CONSENT_NOT_FOUND');
    const parsed = CloudAiConsentSchema.parse(consent);
    if (parsed.revokedAt) throw new CloudAiServiceError('CONSENT_REVOKED');
    if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= this.#now().getTime()) {
      throw new CloudAiServiceError('CONSENT_EXPIRED');
    }
    if (
      parsed.purpose !== payload.purpose
      || parsed.provider !== APPROVED_AI_PROVIDER.id
      || parsed.model !== APPROVED_AI_PROVIDER.model
      || parsed.endpoint !== APPROVED_AI_PROVIDER.endpoint
      || parsed.promptVersion !== APPROVED_AI_PROVIDER.promptVersion
    ) {
      throw new CloudAiServiceError('CONSENT_SCOPE_MISMATCH');
    }

    if (payload.purpose === 'live_hint') {
      if (!explicitAttemptAiOn) throw new CloudAiServiceError('ATTEMPT_AI_OFF');
      const expectedPolicyHash = canonicalSha256(APPROVED_LIVE_AI_POLICY);
      if (
        parsed.scope !== 'configuration'
        || parsed.payloadHash !== null
        || parsed.policyHash !== expectedPolicyHash
        || payload.policyHash !== expectedPolicyHash
        || !sameStringSet(parsed.approvedFields, LIVE_APPROVED_FIELDS)
      ) {
        throw new CloudAiServiceError('CONSENT_SCOPE_MISMATCH');
      }
    } else {
      const approvedFields = payload.purpose === 'deep_diagnosis'
        ? DEEP_APPROVED_FIELDS
        : COMPARISON_APPROVED_FIELDS;
      const expectedPolicyHash = purposePolicyHash(
        payload.purpose,
        payload.schemaVersion,
        approvedFields,
      );
      if (
        parsed.scope !== 'payload'
        || parsed.payloadHash !== payloadHash
        || parsed.policyHash !== expectedPolicyHash
        || !sameStringSet(parsed.approvedFields, approvedFields)
      ) {
        throw new CloudAiServiceError('CONSENT_SCOPE_MISMATCH');
      }
    }
    return parsed;
  }

  #createRequestContext(
    payload: ExactAiPayload,
    payloadHash: string,
    consent: CloudAiConsent,
  ): RequestContext {
    const requestId = this.#createId();
    const controller = new AbortController();
    const liveToken = payload.purpose === 'live_hint' ? Symbol(requestId) : null;
    const metadata: CloudAiRequestMetadata = {
      id: requestId,
      sessionId: sessionIdOf(payload),
      attemptId: attemptIdOf(payload),
      purpose: payload.purpose,
      provider: APPROVED_AI_PROVIDER.id,
      model: APPROVED_AI_PROVIDER.model,
      endpoint: APPROVED_AI_PROVIDER.endpoint,
      requestSequence: payload.purpose === 'live_hint' ? payload.requestSequence : null,
      payloadHash,
      policyHash: consent.policyHash,
      approvedFields: consent.approvedFields,
      consentId: consent.id,
      requestedAt: this.#now().toISOString(),
      completedAt: null,
      status: 'queued',
      outcomeCode: null,
      resultHash: null,
      rawAudioIncluded: false,
      partialTranscriptIncluded: false,
    };
    return { requestId, payloadHash, consent, metadata, liveToken, controller };
  }

  #persistFinalRequest(
    metadata: CloudAiRequestMetadata,
    status: 'completed' | 'failed' | 'discarded',
    outcomeCode: string,
    resultHash: string | null,
  ): void {
    this.#repository.putRequest({
      ...metadata,
      status,
      completedAt: this.#now().toISOString(),
      outcomeCode: outcomeCode.slice(0, 80),
      resultHash,
    });
  }

  #assertConsentStillActive(consentId: string): void {
    const consent = this.#repository.getConsent(consentId);
    if (!consent || consent.revokedAt) {
      throw new CloudAiServiceError('RESULT_DISCARDED', 'consent_revoked');
    }
    if (consent.expiresAt && Date.parse(consent.expiresAt) <= this.#now().getTime()) {
      throw new CloudAiServiceError('RESULT_DISCARDED', 'consent_expired');
    }
  }

  #runKeyMutation<T>(operation: () => Promise<T>): Promise<T> {
    const execution = this.#keyMutationTail.then(operation);
    this.#keyMutationTail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  #prunePreparations(nowMs: number): void {
    for (const [preparationId, preparation] of this.#preparations) {
      if (nowMs - preparation.preparedAtMs > PREPARATION_TTL_MS) {
        this.#preparations.delete(preparationId);
      }
    }
  }

  #assertConsentSourceWritable(source: PrepareAiConsentInput): void {
    if (source.purpose === 'live_hint') return;
    this.#assertRequestWritable(requestIdentityOf(source.payload, 'pending-consent'));
  }

  #assertRequestWritable(identity: CloudRequestIdentity): void {
    this.#assertTrainingDataWritable();
    if (this.#apiKeyDeletionInProgress) {
      throw new CloudAiServiceError('AI_NOT_CONFIGURED');
    }
    for (const [sessionId, attemptIds] of this.#sessionDataDeletionScopes) {
      if (requestMatchesDeletion(identity, sessionId, attemptIds)) {
        throw new CloudAiServiceError('TRAINING_DATA_RESET_IN_PROGRESS');
      }
    }
  }

  #assertTrainingDataWritable(): void {
    if (this.#trainingDataResetInProgress) {
      throw new CloudAiServiceError('TRAINING_DATA_RESET_IN_PROGRESS');
    }
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('CANONICAL_JSON_UNSUPPORTED_VALUE');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('CANONICAL_JSON_CYCLIC_VALUE');
    seen.add(value);
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('CANONICAL_JSON_CYCLIC_VALUE');
    seen.add(value);
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) throw new TypeError('CANONICAL_JSON_UNSUPPORTED_VALUE');
      result[key] = canonicalize(record[key], seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError('CANONICAL_JSON_UNSUPPORTED_VALUE');
}

function purposePolicyHash(
  purpose: Exclude<CloudAiPurpose, 'live_hint'>,
  schemaVersion: string,
  approvedFields: readonly string[],
): string {
  return canonicalSha256({
    purpose,
    schemaVersion,
    approvedFields: normalizeApprovedFields(approvedFields),
    provider: APPROVED_AI_PROVIDER.id,
    model: APPROVED_AI_PROVIDER.model,
    endpoint: APPROVED_AI_PROVIDER.endpoint,
    protocolVersion: APPROVED_AI_PROVIDER.protocolVersion,
    promptVersion: APPROVED_AI_PROVIDER.promptVersion,
  });
}

function normalizeApprovedFields(fields: readonly string[]): string[] {
  return [...new Set(fields)].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson(normalizeApprovedFields(left)) === canonicalJson(normalizeApprovedFields(right));
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new CloudAiServiceError('INVALID_INPUT');
  return parsed.data;
}

function assertApprovedTransport(): void {
  const endpoint = new URL(APPROVED_AI_PROVIDER.endpoint);
  const origin = new URL(APPROVED_AI_PROVIDER.origin);
  if (
    endpoint.protocol !== 'https:'
    || endpoint.origin !== origin.origin
    || endpoint.pathname !== '/v1/responses'
    || endpoint.search !== ''
    || endpoint.hash !== ''
    || endpoint.username !== ''
    || endpoint.password !== ''
  ) {
    throw new CloudAiServiceError('TRANSPORT_BOUNDARY_REJECTED');
  }
}

function assertApprovedResponse(response: Response): void {
  if (response.redirected) throw new CloudAiServiceError('TRANSPORT_BOUNDARY_REJECTED');
  if (response.url && response.url !== APPROVED_AI_PROVIDER.endpoint) {
    throw new CloudAiServiceError('TRANSPORT_BOUNDARY_REJECTED');
  }
}

function assertProviderStatus(status: number): void {
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403) {
    throw new CloudAiServiceError('AUTHENTICATION_FAILED');
  }
  if (status === 429) throw new CloudAiServiceError('RATE_LIMITED');
  if (status >= 500) throw new CloudAiServiceError('PROVIDER_UNAVAILABLE');
  throw new CloudAiServiceError('PROVIDER_REJECTED');
}

function assertNoForbiddenCloudFields(value: unknown, path: readonly string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenCloudFields(item, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
    if (
      normalizedKey === 'audio'
      || normalizedKey === 'rawaudio'
      || normalizedKey === 'audiobytes'
      || normalizedKey === 'audioblob'
      || normalizedKey === 'partial'
      || normalizedKey === 'partialtranscript'
      || normalizedKey === 'partialtext'
    ) {
      throw new CloudAiServiceError('TRANSPORT_BOUNDARY_REJECTED');
    }
    assertNoForbiddenCloudFields(child, [...path, key]);
  }
}

function assertLivePolicyPayload(payload: LiveHintPayload): void {
  const length = payload.finalWindow.text.length;
  if (
    length < APPROVED_LIVE_AI_POLICY.minimumNewFinalCharacters
    || length > APPROVED_LIVE_AI_POLICY.maximumWindowCharacters
  ) {
    throw new CloudAiServiceError('LIVE_POLICY_LIMIT_EXCEEDED', 'policy_window_limit');
  }
}

function buildResponsesRequest<T>(
  payload: ExactAiPayload,
  descriptor: OutputDescriptor<T>,
): Readonly<Record<string, unknown>> {
  const providerPayload = payload.purpose === 'live_hint'
    ? {
        task: payload.task,
        finalWindow: { text: payload.finalWindow.text },
      }
    : payload;
  return {
    model: APPROVED_AI_PROVIDER.model,
    store: false,
    instructions: descriptor.instructions,
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        // Attempt, Session, segment and ordering identities are local authority
        // metadata. Configuration consent approves only the frozen task and the
        // final text window, so no local identity may cross this boundary.
        text: canonicalJson(providerPayload),
      }],
    }],
    max_output_tokens: descriptor.maxOutputTokens,
    text: {
      format: {
        type: 'json_schema',
        name: descriptor.name,
        strict: true,
        schema: descriptor.jsonSchema,
      },
    },
    metadata: {
      phrio_purpose: payload.purpose,
      phrio_prompt_version: APPROVED_AI_PROVIDER.promptVersion,
    },
  };
}

async function parseProviderResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BODY_BYTES) {
    throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
  }
  if (!isRecord(envelope) || envelope.status !== 'completed' || !Array.isArray(envelope.output)) {
    throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
  }

  const texts: string[] = [];
  let refused = false;
  for (const item of envelope.output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content)) continue;
      if (content.type === 'refusal') refused = true;
      if (content.type === 'output_text' && typeof content.text === 'string') {
        texts.push(content.text);
      }
    }
  }
  if (refused) throw new CloudAiServiceError('PROVIDER_REFUSED');
  if (texts.length !== 1 || texts[0]!.length > MAX_APPROVAL_PREVIEW_CHARACTERS) {
    throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(texts[0]!);
  } catch {
    throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
  return parsed.data;
}

function validateResultSemantics<T>(payload: ExactAiPayload, result: T): void {
  if (payload.purpose === 'live_hint') {
    const live = LiveHintResponseSchema.parse(result);
    if (
      live.criterionId
      && !payload.task.rubric.some((criterion) => criterion.criterionId === live.criterionId)
    ) {
      throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
    }
    if (
      live.evidencePhrase
      && !normalizeEvidence(payload.finalWindow.text).includes(normalizeEvidence(live.evidencePhrase))
    ) {
      throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
    }
    return;
  }
  if (payload.purpose === 'deep_diagnosis') {
    const deep = DeepDiagnosisResponseSchema.parse(result);
    const criterionIds = new Set(payload.task.rubric.map((criterion) => criterion.criterionId));
    const segmentIds = new Set(payload.finalSegments.map((segment) => segment.id));
    if (!criterionIds.has(deep.focus.criterionId)) {
      throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
    }
    const drill = payload.task.drills.find((item) => item.drillId === deep.focus.drillId);
    if (!drill || drill.criterionId !== deep.focus.criterionId) {
      throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
    }
    for (const observation of deep.observations) {
      if (
        !criterionIds.has(observation.criterionId)
        || (observation.segmentId !== null && !segmentIds.has(observation.segmentId))
      ) {
        throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
      }
      if (observation.type === 'quote') {
        const segment = payload.finalSegments.find(
          (candidate) => candidate.id === observation.segmentId,
        );
        if (!segment || !evidenceReferencesApprovedSource(observation.evidence, [segment.text])) {
          throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
        }
      }
    }
    return;
  }
  if (payload.purpose === 'comparison') {
    const comparison = SemanticComparisonResponseSchema.parse(result);
    const initialSources = [
      ...payload.initial.finalSegments.map((segment) => segment.text),
      ...payload.initial.localEvidence.flatMap((evidence) => [evidence.phrase, evidence.evidence]),
    ];
    const retrySources = [
      ...payload.retry.finalSegments.map((segment) => segment.text),
      ...payload.retry.localEvidence.flatMap((evidence) => [evidence.phrase, evidence.evidence]),
    ];
    if (
      comparison.result !== 'insufficient_evidence'
      && (comparison.initialEvidence.length === 0 || comparison.retryEvidence.length === 0)
    ) {
      throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
    }
    if (
      comparison.initialEvidence.some(
        (evidence) => !evidenceReferencesApprovedSource(evidence, initialSources),
      )
      || comparison.retryEvidence.some(
        (evidence) => !evidenceReferencesApprovedSource(evidence, retrySources),
      )
    ) {
      throw new CloudAiServiceError('INVALID_PROVIDER_RESPONSE');
    }
  }
}

function normalizeEvidence(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '');
}

function normalizeArtifactErrorCode(value: string | null): string {
  return (value ?? '')
    .replace(/^PHRIO_/u, '')
    .toLowerCase();
}

function liveLeaseKey(attemptId: string, generation: number): string {
  return `${attemptId}\u0000${generation}`;
}

function leaseIdentity(lease: LiveAttemptLease): LiveAttemptLeaseIdentity {
  return {
    sessionId: lease.sessionId,
    attemptId: lease.attemptId,
    generation: lease.generation,
  };
}

function isLiveAttemptSessionStatus(status: PracticeSession['status']): boolean {
  return status === 'first_attempt' || status === 'second_attempt';
}

function liveTaskForSession(session: PracticeSession): LiveHintPayload['task'] {
  const task = taskContextForCloudAi(session);
  const rubric = session.status === 'second_attempt' && session.focus
    ? task.rubric.filter((criterion) => criterion.criterionId === session.focus?.criterionId)
    : task.rubric;
  if (rubric.length === 0) throw new CloudAiServiceError('LIVE_TASK_NOT_FROZEN');
  return {
    modeId: task.modeId,
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    prompt: task.prompt,
    audience: task.audience,
    objective: task.objective,
    rubric,
  };
}

function assertLiveFinalWindowAttested(
  payload: LiveHintPayload,
  ledger: readonly TranscriptSegment[],
): void {
  const finalLedger = ledger
    .filter((segment) => (
      segment.isFinal
      && segment.attemptId === payload.attemptId
      && segment.text.trim().length > 0
    ))
    .sort((left, right) => left.sequence - right.sequence);
  if (payload.transcriptVersion !== finalLedger.length) {
    throw new CloudAiServiceError('LIVE_FINAL_NOT_ATTESTED');
  }
  const expected: TranscriptSegment[] = [];
  let selectedCharacters = 0;
  for (let index = finalLedger.length - 1; index >= 0; index -= 1) {
    if (
      expected.length >= MAX_LIVE_HINT_SEGMENT_REFERENCES
      || selectedCharacters >= APPROVED_LIVE_AI_POLICY.maximumWindowCharacters
    ) break;
    const segment = finalLedger[index]!;
    expected.unshift(segment);
    selectedCharacters += segment.text.trim().length;
  }
  if (payload.finalWindow.segmentRevisions.length !== expected.length) {
    throw new CloudAiServiceError('LIVE_FINAL_NOT_ATTESTED');
  }
  for (const [index, claimed] of payload.finalWindow.segmentRevisions.entries()) {
    const trusted = expected[index];
    if (
      !trusted
      || trusted.id !== claimed.id
      || trusted.sequence !== claimed.sequence
      || trusted.revision !== claimed.revision
      || trusted.startMs !== claimed.startMs
      || trusted.endMs !== claimed.endMs
      || trusted.text !== claimed.text
    ) {
      throw new CloudAiServiceError('LIVE_FINAL_NOT_ATTESTED');
    }
  }
  const canonicalText = expected
    .map((segment) => segment.text.trim())
    .join('')
    .slice(-APPROVED_LIVE_AI_POLICY.maximumWindowCharacters);
  if (payload.finalWindow.text !== canonicalText) {
    throw new CloudAiServiceError('LIVE_FINAL_NOT_ATTESTED');
  }
}

function sessionIdOf(payload: ExactAiPayload): string | null {
  return payload.sessionId;
}

function attemptIdOf(payload: ExactAiPayload): string | null {
  if (payload.purpose === 'live_hint' || payload.purpose === 'deep_diagnosis') {
    return payload.attemptId;
  }
  return null;
}

function attemptIdsOf(payload: ExactAiPayload): readonly string[] {
  if (payload.purpose === 'comparison') {
    return [payload.initial.attemptId, payload.retry.attemptId];
  }
  return [payload.attemptId];
}

function requestIdentityOf(
  payload: ExactAiPayload,
  consentId: string,
): CloudRequestIdentity {
  return {
    consentId,
    sessionId: sessionIdOf(payload),
    attemptIds: attemptIdsOf(payload),
  };
}

function requestMatchesDeletion(
  request: CloudRequestIdentity,
  sessionId: string,
  attemptIds: ReadonlySet<string>,
): boolean {
  return request.sessionId === sessionId
    || request.attemptIds.some((attemptId) => attemptIds.has(attemptId));
}

function consentSourceMatchesDeletion(
  source: PrepareAiConsentInput,
  sessionId: string,
  attemptIds: ReadonlySet<string>,
): boolean {
  if (source.purpose === 'live_hint') return false;
  return requestMatchesDeletion(
    requestIdentityOf(source.payload, 'pending-consent'),
    sessionId,
    attemptIds,
  );
}

function liveOrderOf(payload: LiveHintPayload): LiveOrder {
  return {
    generation: payload.generation,
    phaseEpoch: payload.phaseEpoch,
    transcriptVersion: payload.transcriptVersion,
    requestSequence: payload.requestSequence,
  };
}

function compareLiveOrder(left: LiveOrder, right: LiveOrder): number {
  return left.generation - right.generation
    || left.phaseEpoch - right.phaseEpoch
    || left.transcriptVersion - right.transcriptVersion
    || left.requestSequence - right.requestSequence;
}

function validatedTimeout(timeout: number | undefined, purpose: CloudAiPurpose): number {
  const value = timeout ?? DEFAULT_TIMEOUT_MS[purpose];
  if (!Number.isInteger(value) || value < 1_000 || value > 60_000) {
    throw new CloudAiServiceError('INVALID_INPUT');
  }
  return value;
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason ?? 'cancelled');
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function abortError(reason: unknown): CloudAiServiceError {
  if (reason === 'timeout') return new CloudAiServiceError('REQUEST_TIMEOUT');
  const detail = typeof reason === 'string' && [
    'superseded',
    'disabled',
    'cancelled',
    'consent_revoked',
    'api_key_deleted',
    'training_data_reset',
    'session_data_deleted',
  ].includes(reason)
    ? reason
    : 'cancelled';
  return new CloudAiServiceError('RESULT_DISCARDED', detail);
}

function normalizeExecutionError(error: unknown, signal: AbortSignal): CloudAiServiceError {
  if (signal.aborted) return abortError(signal.reason);
  if (error instanceof CloudAiServiceError) return error;
  return new CloudAiServiceError('PROVIDER_UNAVAILABLE');
}

function normalizeSecretError(error: unknown): CloudAiServiceError {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : null;
  if (code === 'API_KEY_NOT_CONFIGURED') return new CloudAiServiceError('AI_NOT_CONFIGURED');
  if (code === 'ENCRYPTION_UNAVAILABLE') return new CloudAiServiceError('ENCRYPTION_UNAVAILABLE');
  if (code === 'INVALID_API_KEY') return new CloudAiServiceError('INVALID_INPUT');
  return new CloudAiServiceError('SECRET_STORAGE_FAILED');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diagnosticElapsedMilliseconds(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

function recordCloudDiagnosticFailOpen(
  diagnostics: CloudAiDiagnosticSink | undefined,
  input: RecordDiagnosticEventInput,
): void {
  if (!diagnostics) return;
  try {
    const result = diagnostics.record(input);
    if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Operational diagnostics must never change consent, AI, or retry behavior.
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as PromiseLike<unknown>).then === 'function';
}

export type CloudAiServiceErrorCode =
  | 'INVALID_INPUT'
  | 'PAYLOAD_TOO_LARGE'
  | 'TRAINING_DATA_RESET_IN_PROGRESS'
  | 'AI_NOT_CONFIGURED'
  | 'ENCRYPTION_UNAVAILABLE'
  | 'SECRET_STORAGE_FAILED'
  | 'CONSENT_PREPARATION_NOT_FOUND'
  | 'CONSENT_PREPARATION_EXPIRED'
  | 'CONSENT_PREPARATION_MISMATCH'
  | 'CONSENT_NOT_FOUND'
  | 'CONSENT_REVOKED'
  | 'CONSENT_EXPIRED'
  | 'CONSENT_SCOPE_MISMATCH'
  | 'ATTEMPT_AI_OFF'
  | 'LIVE_ATTEMPT_LEASE_REQUIRED'
  | 'LIVE_ATTEMPT_LEASE_REJECTED'
  | 'LIVE_ATTEMPT_SEALED'
  | 'LIVE_TASK_NOT_FROZEN'
  | 'LIVE_FINAL_NOT_ATTESTED'
  | 'LIVE_POLICY_LIMIT_EXCEEDED'
  | 'TRANSPORT_BOUNDARY_REJECTED'
  | 'NETWORK_UNAVAILABLE'
  | 'REQUEST_TIMEOUT'
  | 'AUTHENTICATION_FAILED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_REFUSED'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'CLOUD_ARTIFACT_NOT_ATTESTED'
  | 'RESULT_DISCARDED';

export class CloudAiServiceError extends Error {
  constructor(
    readonly code: CloudAiServiceErrorCode,
    readonly detail: string | null = null,
  ) {
    super(code);
    this.name = 'CloudAiServiceError';
  }
}
