import { z } from 'zod';

import {
  IdentifierSchema,
  IsoDateTimeSchema,
  ModeIdSchema,
} from './domain';
import { LiveAnnotationTypeSchema } from './live-practice';

export const SUPPORTED_AI_PROMPT_VERSIONS = [
  'phrio-2026-07-18.1',
  'phrio-2026-07-18.2',
] as const;
export const CURRENT_AI_PROMPT_VERSION = 'phrio-2026-07-18.2' as const;
const AiPromptVersionSchema = z.enum(SUPPORTED_AI_PROMPT_VERSIONS);

export const APPROVED_AI_PROVIDER = Object.freeze({
  id: 'openai',
  name: 'OpenAI',
  model: 'gpt-5.6-terra',
  origin: 'https://api.openai.com',
  endpoint: 'https://api.openai.com/v1/responses',
  protocolVersion: 'responses-json-schema-1',
  promptVersion: CURRENT_AI_PROMPT_VERSION,
  retentionNotice:
    'Phrio 会设置 store=false；OpenAI 文档仍说明默认滥用监控日志可能保留最多 30 天，Responses 应用状态是否保留取决于组织的数据控制配置。',
} as const);

export const AI_PURPOSES = ['live_hint', 'deep_diagnosis', 'comparison'] as const;
export const CloudAiPurposeSchema = z.enum(AI_PURPOSES);
export type CloudAiPurpose = z.infer<typeof CloudAiPurposeSchema>;

export const CloudAiConfigurationStatusSchema = z.object({
  provider: z.literal(APPROVED_AI_PROVIDER.id),
  providerName: z.literal(APPROVED_AI_PROVIDER.name),
  model: z.literal(APPROVED_AI_PROVIDER.model),
  endpoint: z.literal(APPROVED_AI_PROVIDER.endpoint),
  protocolVersion: z.literal(APPROVED_AI_PROVIDER.protocolVersion),
  configured: z.boolean(),
  encryptionAvailable: z.boolean(),
  keyStorage: z.enum(['system_encrypted', 'local_private_file_unencrypted']),
  keyHint: z.string().max(32).nullable(),
  retentionNotice: z.literal(APPROVED_AI_PROVIDER.retentionNotice),
}).strict();
export type CloudAiConfigurationStatus = z.infer<typeof CloudAiConfigurationStatusSchema>;

export const SaveCloudAiKeyInputSchema = z.object({
  apiKey: z.string().trim().min(20).max(512).refine(
    (value) => !/[\r\n\0]/.test(value),
    'API Key contains unsupported control characters',
  ),
}).strict();
export type SaveCloudAiKeyInput = z.infer<typeof SaveCloudAiKeyInputSchema>;

const RubricFieldSchema = z.object({
  criterionId: IdentifierSchema,
  label: z.string().min(1).max(180),
  description: z.string().min(1).max(1_000),
}).strict();

const TaskContextForAiSchema = z.object({
  modeId: ModeIdSchema,
  taskId: IdentifierSchema,
  taskVersion: z.string().min(1).max(64),
  prompt: z.string().min(1).max(1_000),
  audience: z.string().min(1).max(300),
  objective: z.string().min(1).max(500),
  background: z.string().max(2_000),
  sourceMaterial: z.string().max(5_000),
  counterArgument: z.string().max(2_000),
  roleContext: z.string().max(1_000),
  successConditions: z.array(z.string().min(1).max(500)).min(1).max(12),
  rubric: z.array(RubricFieldSchema).min(1).max(16),
  drills: z.array(z.object({
    drillId: IdentifierSchema,
    criterionId: IdentifierSchema,
    title: z.string().min(1).max(180),
    instruction: z.string().min(1).max(1_000),
    template: z.string().min(1).max(1_000),
    successCondition: z.string().min(1).max(500),
  }).strict()).min(1).max(32),
}).strict();
export type TaskContextForAi = z.infer<typeof TaskContextForAiSchema>;

export const LiveHintTaskSchema = TaskContextForAiSchema.pick({
  modeId: true,
  taskId: true,
  taskVersion: true,
  prompt: true,
  audience: true,
  objective: true,
  rubric: true,
});
export type LiveHintTask = z.infer<typeof LiveHintTaskSchema>;

export const LiveAiPolicySchema = z.object({
  policyVersion: z.literal('live-window-1'),
  sentFieldPaths: z.array(z.enum([
    'task.modeId',
    'task.taskId',
    'task.taskVersion',
    'task.prompt',
    'task.audience',
    'task.objective',
    'task.rubric',
    'finalWindow.text',
    'finalWindow.segmentRevisions',
  ])).min(1),
  maximumWindowCharacters: z.number().int().min(80).max(1_000),
  minimumNewFinalCharacters: z.number().int().min(10).max(500),
  debounceMs: z.number().int().min(100).max(10_000),
  cooldownMs: z.number().int().min(500).max(60_000),
  maximumRequests: z.number().int().min(1).max(30),
  timeoutMs: z.number().int().min(1_000).max(30_000),
}).strict();
export type LiveAiPolicy = z.infer<typeof LiveAiPolicySchema>;

/** Versioned product policy: changing any value requires a new live consent. */
export const APPROVED_LIVE_AI_POLICY: Readonly<LiveAiPolicy> = (() => {
  const policy = LiveAiPolicySchema.parse({
    policyVersion: 'live-window-1',
    sentFieldPaths: [
      'task.modeId',
      'task.taskId',
      'task.taskVersion',
      'task.prompt',
      'task.audience',
      'task.objective',
      'task.rubric',
      'finalWindow.text',
    ],
    maximumWindowCharacters: 360,
    minimumNewFinalCharacters: 30,
    debounceMs: 700,
    cooldownMs: 4_000,
    maximumRequests: 8,
    timeoutMs: 12_000,
  });
  Object.freeze(policy.sentFieldPaths);
  return Object.freeze(policy);
})();

const FinalSegmentForAiSchema = z.object({
  id: IdentifierSchema,
  sequence: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().min(1).max(4_000),
}).strict().refine((segment) => segment.endMs >= segment.startMs, {
  message: 'final segment end must not precede start',
  path: ['endMs'],
});

export const LiveHintPayloadSchema = z.object({
  schemaVersion: z.literal('live-hint-1'),
  purpose: z.literal('live_hint'),
  sessionId: IdentifierSchema,
  attemptId: IdentifierSchema,
  generation: z.number().int().positive(),
  phaseEpoch: z.number().int().positive(),
  transcriptVersion: z.number().int().positive(),
  requestSequence: z.number().int().positive(),
  policyHash: z.string().length(64),
  task: LiveHintTaskSchema,
  finalWindow: z.object({
    text: z.string().min(1).max(1_000),
    segmentRevisions: z.array(FinalSegmentForAiSchema).min(1).max(30),
  }).strict(),
}).strict().superRefine((payload, context) => {
  const reconstructed = payload.finalWindow.segmentRevisions.map((segment) => segment.text).join('');
  if (!reconstructed.includes(payload.finalWindow.text) && !payload.finalWindow.text.includes(reconstructed)) {
    context.addIssue({
      code: 'custom',
      path: ['finalWindow', 'text'],
      message: 'final window must be derived from the declared final segments',
    });
  }
});
export type LiveHintPayload = z.infer<typeof LiveHintPayloadSchema>;

const LocalEvidenceForAiSchema = z.object({
  id: IdentifierSchema,
  displayId: z.string().regex(/^O\d+$/),
  type: LiveAnnotationTypeSchema,
  segmentId: IdentifierSchema,
  phrase: z.string().min(1).max(1_000),
  evidence: z.string().min(1).max(1_000),
  suggestion: z.string().min(1).max(1_000),
  lifecycle: z.enum(['provisional', 'confirmed', 'withdrawn']),
  source: z.enum(['local_rule', 'local_metric']),
}).strict();

export const DeepDiagnosisPayloadSchema = z.object({
  schemaVersion: z.literal('deep-diagnosis-1'),
  purpose: z.literal('deep_diagnosis'),
  analysisInputId: IdentifierSchema,
  sessionId: IdentifierSchema,
  attemptId: IdentifierSchema,
  snapshotId: IdentifierSchema,
  transcriptVersion: z.number().int().positive(),
  task: TaskContextForAiSchema,
  finalSegments: z.array(FinalSegmentForAiSchema).min(1).max(500),
  corrections: z.array(z.object({
    segmentId: IdentifierSchema,
    originalText: z.string().min(1).max(4_000),
    approvedText: z.string().min(1).max(4_000),
  }).strict()).max(500),
  localEvidence: z.array(LocalEvidenceForAiSchema).max(500),
  metrics: z.object({
    words: z.number().int().nonnegative(),
    fillers: z.number().int().nonnegative(),
    hedges: z.number().int().nonnegative(),
    vagueWords: z.number().int().nonnegative(),
    repetitions: z.number().int().nonnegative(),
    selfCorrections: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type DeepDiagnosisPayload = z.infer<typeof DeepDiagnosisPayloadSchema>;

const ComparisonAttemptPayloadSchema = z.object({
  attemptId: IdentifierSchema,
  snapshotId: IdentifierSchema,
  transcriptVersion: z.number().int().positive(),
  finalSegments: z.array(FinalSegmentForAiSchema).min(1).max(500),
  localEvidence: z.array(LocalEvidenceForAiSchema).max(500),
  metrics: DeepDiagnosisPayloadSchema.shape.metrics,
}).strict();

export const SemanticComparisonPayloadSchema = z.object({
  schemaVersion: z.literal('comparison-1'),
  purpose: z.literal('comparison'),
  analysisInputId: IdentifierSchema,
  sessionId: IdentifierSchema,
  task: TaskContextForAiSchema,
  focus: z.object({
    version: z.number().int().positive(),
    criterionId: IdentifierSchema,
    label: z.string().min(1).max(180),
    drillId: IdentifierSchema,
  }).strict(),
  protocolVersion: z.literal('paired-1'),
  initial: ComparisonAttemptPayloadSchema,
  retry: ComparisonAttemptPayloadSchema,
}).strict().superRefine((payload, context) => {
  if (!payload.task.rubric.some((criterion) => criterion.criterionId === payload.focus.criterionId)) {
    context.addIssue({
      code: 'custom',
      path: ['focus', 'criterionId'],
      message: 'comparison focus must exist in the frozen rubric',
    });
  }
  const focusDrill = payload.task.drills.find((drill) => drill.drillId === payload.focus.drillId);
  if (!focusDrill || focusDrill.criterionId !== payload.focus.criterionId) {
    context.addIssue({
      code: 'custom',
      path: ['focus', 'drillId'],
      message: 'comparison focus Drill must match the frozen criterion',
    });
  }
  if (
    payload.initial.attemptId === payload.retry.attemptId
    || payload.initial.snapshotId === payload.retry.snapshotId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['retry', 'snapshotId'],
      message: 'comparison requires two distinct frozen attempts',
    });
  }
});
export type SemanticComparisonPayload = z.infer<typeof SemanticComparisonPayloadSchema>;

export const ExactAiPayloadSchema = z.discriminatedUnion('purpose', [
  LiveHintPayloadSchema,
  DeepDiagnosisPayloadSchema,
  SemanticComparisonPayloadSchema,
]);
export type ExactAiPayload = z.infer<typeof ExactAiPayloadSchema>;

export const PrepareAiConsentInputSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('live_hint'), policy: LiveAiPolicySchema }).strict(),
  z.object({ purpose: z.literal('deep_diagnosis'), payload: DeepDiagnosisPayloadSchema }).strict(),
  z.object({ purpose: z.literal('comparison'), payload: SemanticComparisonPayloadSchema }).strict(),
]);
export type PrepareAiConsentInput = z.infer<typeof PrepareAiConsentInputSchema>;

export const PreparedAiConsentSchema = z.object({
  preparationId: IdentifierSchema,
  purpose: CloudAiPurposeSchema,
  scope: z.enum(['configuration', 'payload']),
  provider: z.literal(APPROVED_AI_PROVIDER.id),
  model: z.literal(APPROVED_AI_PROVIDER.model),
  endpoint: z.literal(APPROVED_AI_PROVIDER.endpoint),
  payloadHash: z.string().length(64).nullable(),
  policyHash: z.string().length(64),
  schemaVersion: z.string().min(1).max(64),
  promptVersion: z.literal(APPROVED_AI_PROVIDER.promptVersion),
  approvedFields: z.array(z.string().min(1).max(160)).min(1).max(64),
  previewJson: z.string().min(2).max(128_000),
  retentionNotice: z.literal(APPROVED_AI_PROVIDER.retentionNotice),
  preparedAt: IsoDateTimeSchema,
}).strict();
export type PreparedAiConsent = z.infer<typeof PreparedAiConsentSchema>;

export const ApproveAiConsentInputSchema = z.object({
  preparationId: IdentifierSchema,
  purpose: CloudAiPurposeSchema,
  payloadHash: z.string().length(64).nullable(),
  policyHash: z.string().length(64),
  approvedFields: z.array(z.string().min(1).max(160)).min(1).max(64),
}).strict();
export type ApproveAiConsentInput = z.infer<typeof ApproveAiConsentInputSchema>;

export const CloudAiConsentSchema = z.object({
  id: IdentifierSchema,
  purpose: CloudAiPurposeSchema,
  scope: z.enum(['configuration', 'payload']),
  sessionId: IdentifierSchema.nullable(),
  provider: z.literal(APPROVED_AI_PROVIDER.id),
  model: z.literal(APPROVED_AI_PROVIDER.model),
  endpoint: z.literal(APPROVED_AI_PROVIDER.endpoint),
  payloadHash: z.string().length(64).nullable(),
  policyHash: z.string().length(64),
  schemaVersion: z.string().min(1).max(64),
  promptVersion: AiPromptVersionSchema,
  approvedFields: z.array(z.string().min(1).max(160)).min(1).max(64),
  approvedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
}).strict().superRefine((consent, context) => {
  if (consent.purpose === 'live_hint' && (consent.scope !== 'configuration' || consent.payloadHash !== null)) {
    context.addIssue({ code: 'custom', path: ['scope'], message: 'live hints require configuration consent' });
  }
  if (consent.purpose !== 'live_hint' && (consent.scope !== 'payload' || consent.payloadHash === null)) {
    context.addIssue({ code: 'custom', path: ['payloadHash'], message: 'deep requests require exact payload consent' });
  }
}).strict();
export type CloudAiConsent = z.infer<typeof CloudAiConsentSchema>;

export const RevokeAiConsentInputSchema = z.object({ consentId: IdentifierSchema }).strict();
export type RevokeAiConsentInput = z.infer<typeof RevokeAiConsentInputSchema>;

export const GetCloudAiConsentStatusInputSchema = z.object({
  purpose: CloudAiPurposeSchema,
}).strict();
export type GetCloudAiConsentStatusInput = z.infer<
  typeof GetCloudAiConsentStatusInputSchema
>;

export const CloudAiConsentStatusSchema = z.object({
  purpose: CloudAiPurposeSchema,
  active: z.boolean(),
  consent: z.object({
    id: IdentifierSchema,
    purpose: CloudAiPurposeSchema,
    scope: z.enum(['configuration', 'payload']),
    provider: z.literal(APPROVED_AI_PROVIDER.id),
    model: z.literal(APPROVED_AI_PROVIDER.model),
    endpoint: z.literal(APPROVED_AI_PROVIDER.endpoint),
    payloadHash: z.string().length(64).nullable(),
    policyHash: z.string().length(64),
    schemaVersion: z.string().min(1).max(64),
    promptVersion: AiPromptVersionSchema,
    approvedFields: z.array(z.string().min(1).max(160)).min(1).max(64),
    approvedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.nullable(),
  }).strict().nullable(),
}).strict().superRefine((status, context) => {
  if (status.active !== (status.consent !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['active'],
      message: 'active must reflect whether a current consent is present',
    });
  }
  if (status.consent && status.consent.purpose !== status.purpose) {
    context.addIssue({
      code: 'custom',
      path: ['consent', 'purpose'],
      message: 'consent purpose must match the requested purpose',
    });
  }
  if (
    status.consent?.purpose === 'live_hint'
    && (status.consent.scope !== 'configuration' || status.consent.payloadHash !== null)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['consent', 'scope'],
      message: 'live consent status must remain configuration scoped',
    });
  }
  if (
    status.consent
    && status.consent.purpose !== 'live_hint'
    && (status.consent.scope !== 'payload' || status.consent.payloadHash === null)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['consent', 'payloadHash'],
      message: 'deep consent status must remain exact-payload scoped',
    });
  }
});
export type CloudAiConsentStatus = z.infer<typeof CloudAiConsentStatusSchema>;

export const LiveHintResponseSchema = z.object({
  hint: z.string().min(1).max(140),
  evidencePhrase: z.string().min(1).max(120).nullable(),
  criterionId: IdentifierSchema.nullable(),
}).strict();
export type LiveHintResponse = z.infer<typeof LiveHintResponseSchema>;

export const DeepDiagnosisResponseSchema = z.object({
  judgment: z.string().min(1).max(1_000),
  observations: z.array(z.object({
    type: z.enum(['quote', 'deterministic_metric', 'task_requirement_gap']),
    criterionId: IdentifierSchema,
    segmentId: IdentifierSchema.nullable(),
    evidence: z.string().min(1).max(1_000),
    suggestion: z.string().min(1).max(1_000),
    confidence: z.enum(['low', 'medium', 'high']),
  }).strict()).max(12),
  focus: z.object({
    criterionId: IdentifierSchema,
    label: z.string().min(1).max(180),
    reason: z.string().min(1).max(1_000),
    drillId: IdentifierSchema,
    drill: z.string().min(1).max(1_000),
  }).strict(),
}).strict();
export type DeepDiagnosisResponse = z.infer<typeof DeepDiagnosisResponseSchema>;

export const SemanticComparisonResponseSchema = z.object({
  result: z.enum(['improved', 'stable', 'regressed', 'insufficient_evidence']),
  explanation: z.string().min(1).max(1_000),
  initialEvidence: z.array(z.string().min(1).max(1_000)).max(8),
  retryEvidence: z.array(z.string().min(1).max(1_000)).max(8),
}).strict();
export type SemanticComparisonResponse = z.infer<typeof SemanticComparisonResponseSchema>;

/** Provider prose is traceable only when it quotes an approved source phrase. */
export function evidenceReferencesApprovedSource(
  evidence: string,
  approvedSources: readonly string[],
): boolean {
  const phrases = [
    ...evidence.matchAll(/“([^”]{1,120})”/gu),
    ...evidence.matchAll(/"([^"\n]{1,120})"/gu),
  ].map((match) => match[1]!.normalize('NFKC').replace(/\s+/gu, ''))
    .filter((phrase) => phrase.length >= 2);
  if (phrases.length === 0) return false;
  const normalizedSources = approvedSources.map(
    (source) => source.normalize('NFKC').replace(/\s+/gu, ''),
  );
  return phrases.some((phrase) => normalizedSources.some((source) => source.includes(phrase)));
}

export const ExecuteLiveHintInputSchema = z.object({
  payload: LiveHintPayloadSchema,
  consentId: IdentifierSchema,
  explicitAttemptAiOn: z.literal(true),
}).strict();
export type ExecuteLiveHintInput = z.infer<typeof ExecuteLiveHintInputSchema>;

export const ExecuteDeepDiagnosisInputSchema = z.object({
  payload: DeepDiagnosisPayloadSchema,
  consentId: IdentifierSchema,
}).strict();
export type ExecuteDeepDiagnosisInput = z.infer<typeof ExecuteDeepDiagnosisInputSchema>;

export const ExecuteSemanticComparisonInputSchema = z.object({
  payload: SemanticComparisonPayloadSchema,
  consentId: IdentifierSchema,
}).strict();
export type ExecuteSemanticComparisonInput = z.infer<
  typeof ExecuteSemanticComparisonInputSchema
>;

export const CancelLiveHintInputSchema = z.object({ attemptId: IdentifierSchema }).strict();
export type CancelLiveHintInput = z.infer<typeof CancelLiveHintInputSchema>;
export const CancelLiveHintOutputSchema = z.object({
  cancelledAttemptId: IdentifierSchema,
}).strict();
export type CancelLiveHintOutput = z.infer<typeof CancelLiveHintOutputSchema>;

export const CloudAiExecutionStatusSchema = z.enum([
  'queued',
  'processing',
  'completed',
  'failed',
  'discarded',
]);

export const CloudAiRequestMetadataSchema = z.object({
  id: IdentifierSchema,
  sessionId: IdentifierSchema.nullable(),
  attemptId: IdentifierSchema.nullable(),
  purpose: CloudAiPurposeSchema,
  provider: z.literal(APPROVED_AI_PROVIDER.id),
  model: z.literal(APPROVED_AI_PROVIDER.model),
  endpoint: z.literal(APPROVED_AI_PROVIDER.endpoint),
  requestSequence: z.number().int().positive().nullable(),
  payloadHash: z.string().length(64),
  policyHash: z.string().length(64),
  approvedFields: z.array(z.string().min(1).max(160)).min(1).max(64),
  consentId: IdentifierSchema,
  requestedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
  status: CloudAiExecutionStatusSchema,
  outcomeCode: z.string().min(1).max(80).nullable(),
  /** Canonical provider result attestation; absent only on legacy audit rows. */
  resultHash: z.string().length(64).nullable().optional(),
  rawAudioIncluded: z.literal(false),
  partialTranscriptIncluded: z.literal(false),
}).strict();
export type CloudAiRequestMetadata = z.infer<typeof CloudAiRequestMetadataSchema>;
