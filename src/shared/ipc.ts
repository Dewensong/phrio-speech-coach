import { z } from 'zod';

import {
  AppSettingsSchema,
  AttemptKindSchema,
  AttemptSchema,
  IdentifierSchema,
  ModeIdSchema,
  ModePackSchema,
  PracticeSessionSchema,
  SessionOutcomeSchema,
  type AppSettings,
  type Attempt,
  type ModePack,
  type PracticeSession,
} from './domain';
import { PracticeArtifactSchema } from './deep-lane';
import {
  ClearDiagnosticLogsOutputSchema,
  DiagnosticLogClearSummarySchema,
  DiagnosticStatusSchema,
  ExportDiagnosticBundleOutputSchema,
  OpenDiagnosticDirectoryOutputSchema,
  RecordDiagnosticEventInputSchema,
  RecordDiagnosticEventOutputSchema,
  type ClearDiagnosticLogsOutput,
  type DiagnosticStatus,
  type ExportDiagnosticBundleOutput,
  type OpenDiagnosticDirectoryOutput,
  type RecordDiagnosticEventInput,
  type RecordDiagnosticEventOutput,
} from './diagnostics';
import {
  ApproveAiConsentInputSchema,
  CancelLiveHintInputSchema,
  CancelLiveHintOutputSchema,
  CloudAiConfigurationStatusSchema,
  CloudAiConsentSchema,
  CloudAiConsentStatusSchema,
  DeepDiagnosisResponseSchema,
  ExecuteDeepDiagnosisInputSchema,
  ExecuteLiveHintInputSchema,
  ExecuteSemanticComparisonInputSchema,
  GetCloudAiConsentStatusInputSchema,
  LiveHintResponseSchema,
  PrepareAiConsentInputSchema,
  PreparedAiConsentSchema,
  RevokeAiConsentInputSchema,
  SaveCloudAiKeyInputSchema,
  SemanticComparisonResponseSchema,
  type ApproveAiConsentInput,
  type CancelLiveHintInput,
  type CancelLiveHintOutput,
  type CloudAiConfigurationStatus,
  type CloudAiConsent,
  type CloudAiConsentStatus,
  type DeepDiagnosisResponse,
  type ExecuteDeepDiagnosisInput,
  type ExecuteLiveHintInput,
  type ExecuteSemanticComparisonInput,
  type GetCloudAiConsentStatusInput,
  type LiveHintResponse,
  type PrepareAiConsentInput,
  type PreparedAiConsent,
  type RevokeAiConsentInput,
  type SaveCloudAiKeyInput,
  type SemanticComparisonResponse,
} from './cloud-ai';
import { SessionEventSchema, type SessionEvent } from './session-machine';
import { TranscriptSegmentSchema } from './live-practice';

export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
export const MAX_RECORDING_DURATION_MS = 300_000;

export const IPC_CHANNELS = Object.freeze({
  APP_GET_BOOTSTRAP: 'phrio:app:get-bootstrap',
  SESSIONS_CREATE: 'phrio:sessions:create',
  SESSIONS_GET: 'phrio:sessions:get',
  SESSIONS_LIST: 'phrio:sessions:list',
  SESSIONS_TRANSITION: 'phrio:sessions:transition',
  SESSIONS_UPDATE_RECORD: 'phrio:sessions:update-record',
  SESSIONS_DELETE: 'phrio:sessions:delete',
  ATTEMPTS_SAVE_AUDIO: 'phrio:attempts:save-audio',
  ATTEMPTS_READ_AUDIO: 'phrio:attempts:read-audio',
  ATTEMPTS_DISCARD: 'phrio:attempts:discard',
  SETTINGS_GET: 'phrio:settings:get',
  SETTINGS_UPDATE: 'phrio:settings:update',
  ARTIFACTS_PUT: 'phrio:artifacts:put',
  ARTIFACTS_LIST: 'phrio:artifacts:list',
  ASR_START: 'phrio:asr:start',
  ASR_FEED: 'phrio:asr:feed',
  ASR_STOP: 'phrio:asr:stop',
  ENVIRONMENT_GET_STATUS: 'phrio:environment:get-status',
  ENVIRONMENT_INSTALL_ASR_MODEL: 'phrio:environment:install-asr-model',
  ENVIRONMENT_GET_ASR_MODEL_INSTALL_STATUS: 'phrio:environment:get-asr-model-install-status',
  ENVIRONMENT_CANCEL_ASR_MODEL_INSTALL: 'phrio:environment:cancel-asr-model-install',
  DATA_CLEAR_TRAINING: 'phrio:data:clear-training',
  SETTINGS_RESET_NONSENSITIVE: 'phrio:settings:reset-nonsensitive',
  DIAGNOSTICS_RECORD_EVENT: 'phrio:diagnostics:record-event',
  DIAGNOSTICS_GET_STATUS: 'phrio:diagnostics:get-status',
  DIAGNOSTICS_OPEN_DIRECTORY: 'phrio:diagnostics:open-directory',
  DIAGNOSTICS_EXPORT_BUNDLE: 'phrio:diagnostics:export-bundle',
  DIAGNOSTICS_CLEAR: 'phrio:diagnostics:clear',
  CLOUD_AI_GET_CONFIGURATION: 'phrio:cloud-ai:get-configuration',
  CLOUD_AI_SAVE_KEY: 'phrio:cloud-ai:save-key',
  CLOUD_AI_DELETE_KEY: 'phrio:cloud-ai:delete-key',
  CLOUD_AI_GET_CONSENT_STATUS: 'phrio:cloud-ai:get-consent-status',
  CLOUD_AI_PREPARE_CONSENT: 'phrio:cloud-ai:prepare-consent',
  CLOUD_AI_APPROVE_CONSENT: 'phrio:cloud-ai:approve-consent',
  CLOUD_AI_REVOKE_CONSENT: 'phrio:cloud-ai:revoke-consent',
  CLOUD_AI_SET_LIVE_ATTEMPT_STATE: 'phrio:cloud-ai:set-live-attempt-state',
  CLOUD_AI_EXECUTE_LIVE_HINT: 'phrio:cloud-ai:execute-live-hint',
  CLOUD_AI_EXECUTE_DEEP_DIAGNOSIS: 'phrio:cloud-ai:execute-deep-diagnosis',
  CLOUD_AI_EXECUTE_COMPARISON: 'phrio:cloud-ai:execute-comparison',
  CLOUD_AI_CANCEL_LIVE_HINT: 'phrio:cloud-ai:cancel-live-hint',
} as const);

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const EmptyInputSchema = z.object({}).strict();
export type EmptyInput = z.infer<typeof EmptyInputSchema>;

export const BootstrapDataSchema = z
  .object({
    modes: z.array(ModePackSchema),
    settings: AppSettingsSchema,
    activeSession: PracticeSessionSchema.nullable(),
  })
  .strict();
export type BootstrapData = z.infer<typeof BootstrapDataSchema>;

export const CreateSessionInputSchema = z
  .object({
    modeId: ModeIdSchema,
    taskId: z.string().min(1).max(96),
    developmentFixture: z.boolean().optional(),
    customTask: z
      .object({
        prompt: z.string().min(1).max(1_000),
        audience: z.string().min(1).max(300),
        objective: z.string().min(1).max(500),
        durationSeconds: z.number().int().min(30).max(300),
      })
      .strict()
      .optional(),
    taskOverrides: z
      .object({
        audience: z.string().min(1).max(300),
        objective: z.string().min(1).max(500),
        durationSeconds: z.number().int().min(30).max(300),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.customTask && (input.modeId !== 'clear-expression' || input.taskId !== 'free-expression')) {
      context.addIssue({
        code: 'custom',
        path: ['customTask'],
        message: 'free expression tasks require clear-expression/free-expression',
      });
    }
    if (input.customTask && input.taskOverrides) {
      context.addIssue({
        code: 'custom',
        path: ['taskOverrides'],
        message: 'free expression custom input already contains its task overrides',
      });
    }
  });
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;
export const CreateSessionOutputSchema = PracticeSessionSchema;
export type CreateSessionOutput = PracticeSession;

export const SessionIdInputSchema = z
  .object({ sessionId: z.string().min(1).max(96) })
  .strict();
export type SessionIdInput = z.infer<typeof SessionIdInputSchema>;

export const GetSessionInputSchema = SessionIdInputSchema;
export type GetSessionInput = SessionIdInput;
export const GetSessionOutputSchema = PracticeSessionSchema.nullable();
export type GetSessionOutput = PracticeSession | null;

export const ListSessionsInputSchema = z
  .object({
    modeId: ModeIdSchema.optional(),
    outcome: SessionOutcomeSchema.optional(),
  })
  .strict();
export type ListSessionsInput = z.infer<typeof ListSessionsInputSchema>;
export const ListSessionsOutputSchema = z.array(PracticeSessionSchema);
export type ListSessionsOutput = ReadonlyArray<PracticeSession>;

export const TransitionSessionInputSchema = z
  .object({
    sessionId: z.string().min(1).max(96),
    event: SessionEventSchema,
  })
  .strict();
export type TransitionSessionInput = z.infer<typeof TransitionSessionInputSchema>;
export const TransitionSessionOutputSchema = PracticeSessionSchema;
export type TransitionSessionOutput = PracticeSession;

export const UpdateSessionRecordInputSchema = z.discriminatedUnion('action', [
  z.object({
    sessionId: IdentifierSchema,
    action: z.literal('rename'),
    title: z.string().trim().min(1).max(200),
  }).strict(),
  z.object({
    sessionId: IdentifierSchema,
    action: z.literal('set_pinned'),
    pinned: z.boolean(),
  }).strict(),
]);
export type UpdateSessionRecordInput = z.infer<typeof UpdateSessionRecordInputSchema>;
export const UpdateSessionRecordOutputSchema = PracticeSessionSchema;
export type UpdateSessionRecordOutput = PracticeSession;

export const DeleteSessionInputSchema = SessionIdInputSchema;
export type DeleteSessionInput = SessionIdInput;
export const DeleteSessionOutputSchema = z
  .object({ deletedSessionId: z.string().min(1).max(96) })
  .strict();
export type DeleteSessionOutput = z.infer<typeof DeleteSessionOutputSchema>;

export const AudioBytesSchema = z
  .custom<Uint8Array>((value) => value instanceof Uint8Array, {
    message: 'audio bytes must be a Uint8Array',
  })
  .refine((bytes) => bytes.byteLength > 0, 'audio bytes cannot be empty')
  .refine(
    (bytes) => bytes.byteLength <= MAX_AUDIO_BYTES,
    `audio bytes cannot exceed ${MAX_AUDIO_BYTES}`,
  );

export const AudioMimeTypeSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^audio\/(webm|ogg|mp4|mpeg|wav)(?:;\s*codecs=[a-z0-9._-]+)?$/i,
    'unsupported audio MIME type',
  );

export const SaveAttemptAudioInputSchema = z
  .object({
    sessionId: z.string().min(1).max(96),
    attemptId: IdentifierSchema.optional(),
    kind: AttemptKindSchema,
    bytes: AudioBytesSchema,
    mimeType: AudioMimeTypeSchema,
    durationMs: z.number().int().positive().max(MAX_RECORDING_DURATION_MS),
  })
  .strict();
export type SaveAttemptAudioInput = z.infer<typeof SaveAttemptAudioInputSchema>;
export const SaveAttemptAudioOutputSchema = AttemptSchema;
export type SaveAttemptAudioOutput = Attempt;

export const AttemptSlotInputSchema = z
  .object({
    sessionId: z.string().min(1).max(96),
    kind: AttemptKindSchema,
  })
  .strict();
export type AttemptSlotInput = z.infer<typeof AttemptSlotInputSchema>;

export const ReadAttemptAudioInputSchema = AttemptSlotInputSchema;
export type ReadAttemptAudioInput = AttemptSlotInput;
export const ReadAttemptAudioOutputSchema = z
  .object({
    bytes: AudioBytesSchema,
    mimeType: AudioMimeTypeSchema,
  })
  .strict();
export type ReadAttemptAudioOutput = z.infer<typeof ReadAttemptAudioOutputSchema>;

export const DiscardAttemptAudioInputSchema = AttemptSlotInputSchema.extend({
  // A stopped take freezes its snapshot before the audio file is persisted.
  // Carry that identity when discarding so a failed audio save can remove only
  // the matching pre-persisted graph, without touching a newer take in the slot.
  attemptId: IdentifierSchema.optional(),
}).strict();
export type DiscardAttemptAudioInput = z.infer<typeof DiscardAttemptAudioInputSchema>;
export const DiscardAttemptAudioOutputSchema = PracticeSessionSchema;
export type DiscardAttemptAudioOutput = PracticeSession;

export const GetSettingsInputSchema = EmptyInputSchema;
export type GetSettingsInput = EmptyInput;
export const GetSettingsOutputSchema = AppSettingsSchema;
export type GetSettingsOutput = AppSettings;

export const AppSettingsPatchSchema = AppSettingsSchema.omit({ schemaVersion: true })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'settings patch cannot be empty');
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;
export const UpdateSettingsInputSchema = AppSettingsPatchSchema;
export type UpdateSettingsInput = AppSettingsPatch;
export const UpdateSettingsOutputSchema = AppSettingsSchema;
export type UpdateSettingsOutput = AppSettings;

export const LOCAL_ASR_MODEL_FILE_NAMES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'tokens.txt',
] as const;
export const LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH = 1_047_319_737;
export const LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH = 237_202_501;
export const LOCAL_ASR_MODEL_ESTIMATED_INSTALLED_BYTE_LENGTH = 240 * 1_024 * 1_024;
export const LocalAsrModelFileNameSchema = z.enum(LOCAL_ASR_MODEL_FILE_NAMES);
export type LocalAsrModelFileName = z.infer<typeof LocalAsrModelFileNameSchema>;
export const LocalAsrModelFileStatusSchema = z
  .object({
    name: LocalAsrModelFileNameSchema,
    exists: z.boolean(),
    readable: z.boolean(),
  })
  .strict()
  .refine((file) => !file.readable || file.exists, 'a readable model file must exist');
export type LocalAsrModelFileStatus = z.infer<typeof LocalAsrModelFileStatusSchema>;

export const LocalAsrReadinessStateSchema = z.enum([
  'ready',
  'missing',
  'corrupt',
  'dependency_missing',
  'runtime_init_failed',
]);
export type LocalAsrReadinessState = z.infer<typeof LocalAsrReadinessStateSchema>;

export const LocalAsrStatusSchema = z
  .object({
    state: LocalAsrReadinessStateSchema,
    ready: z.boolean(),
    files: z.array(LocalAsrModelFileStatusSchema).length(LOCAL_ASR_MODEL_FILE_NAMES.length),
  })
  .strict()
  .superRefine((status, context) => {
    const expectedNames = new Set<string>(LOCAL_ASR_MODEL_FILE_NAMES);
    const actualNames = new Set<string>(status.files.map((file) => file.name));
    if (
      actualNames.size !== expectedNames.size ||
      [...expectedNames].some((name) => !actualNames.has(name))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'local ASR status must include each required model file exactly once',
      });
    }
    if (status.ready !== (status.state === 'ready')) {
      context.addIssue({
        code: 'custom',
        path: ['ready'],
        message: 'local ASR readiness must match the verified readiness state',
      });
    }
    if (
      (status.state === 'ready' || status.state === 'dependency_missing' || status.state === 'runtime_init_failed')
      && !status.files.every((file) => file.readable)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'runtime readiness states require all model files to be readable',
      });
    }
  });
export type LocalAsrStatus = z.infer<typeof LocalAsrStatusSchema>;

export const GetEnvironmentStatusInputSchema = EmptyInputSchema;
export type GetEnvironmentStatusInput = EmptyInput;
export const GetEnvironmentStatusOutputSchema = z
  .object({
    checkedAt: z.string().datetime({ offset: true }),
    dataDirectory: z.string().min(1).max(2_048),
    trainingRecordCount: z.number().int().nonnegative(),
    localAsr: LocalAsrStatusSchema,
  })
  .strict();
export type GetEnvironmentStatusOutput = z.infer<typeof GetEnvironmentStatusOutputSchema>;

export const InstallLocalAsrModelInputSchema = EmptyInputSchema;
export type InstallLocalAsrModelInput = EmptyInput;
export const InstallLocalAsrModelOutputSchema = z
  .object({
    outcome: z.enum(['installed', 'already_installed']),
    downloadedArchiveBytes: z
      .number()
      .int()
      .nonnegative()
      .max(LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH),
    validatedDownloadBytes: z
      .number()
      .int()
      .nonnegative()
      .max(LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH)
      .optional(),
    sourceUsed: z
      .enum(['huggingface_direct', 'accelerated_direct', 'github_release_archive'])
      .nullable()
      .optional(),
    installedModelBytes: z.number().int().positive().max(512 * 1_024 * 1_024),
    completedAt: z.string().datetime({ offset: true }),
    localAsr: LocalAsrStatusSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (!result.localAsr.ready) {
      context.addIssue({
        code: 'custom',
        path: ['localAsr', 'ready'],
        message: 'a completed model installation must be ready',
      });
    }
    const expectedDownloadedBytes = result.outcome === 'installed'
      && (result.sourceUsed === undefined || result.sourceUsed === 'github_release_archive')
      ? LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
      : 0;
    if (result.downloadedArchiveBytes !== expectedDownloadedBytes) {
      context.addIssue({
        code: 'custom',
        path: ['downloadedArchiveBytes'],
        message: 'downloaded archive bytes must match the installation outcome',
      });
    }
    if (result.validatedDownloadBytes !== undefined) {
      const expectedValidatedBytes = result.outcome === 'already_installed'
        ? 0
        : result.sourceUsed === 'github_release_archive'
          ? LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
          : LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH;
      if (result.validatedDownloadBytes !== expectedValidatedBytes) {
        context.addIssue({
          code: 'custom',
          path: ['validatedDownloadBytes'],
          message: 'validated download bytes must match the selected model source',
        });
      }
    }
  });
export type InstallLocalAsrModelOutput = z.infer<typeof InstallLocalAsrModelOutputSchema>;

export const LocalAsrModelInstallStageSchema = z.enum([
  'idle',
  'preparing',
  'downloading',
  'verifying',
  'extracting',
  'promoting',
  'paused',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
]);
export type LocalAsrModelInstallStage = z.infer<typeof LocalAsrModelInstallStageSchema>;
export const GetLocalAsrModelInstallStatusInputSchema = EmptyInputSchema;
export type GetLocalAsrModelInstallStatusInput = EmptyInput;
export const GetLocalAsrModelInstallStatusOutputSchema = z
  .object({
    stage: LocalAsrModelInstallStageSchema,
    downloadedBytes: z.number().int().nonnegative().max(LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH),
    expectedBytes: z.union([
      z.literal(LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH),
      z.literal(LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH),
    ]),
    source: z
      .enum(['huggingface_direct', 'accelerated_direct', 'github_release_archive'])
      .nullable()
      .optional(),
    lastRecoverableErrorCode: z
      .string()
      .min(1)
      .max(120)
      .regex(/^ASR_MODEL_[A-Z0-9_]+$/u)
      .nullable()
      .optional(),
    cancellable: z.boolean(),
    errorCode: z.string().min(1).max(120).regex(/^ASR_MODEL_[A-Z0-9_]+$/u).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((status, context) => {
    if (status.downloadedBytes > status.expectedBytes) {
      context.addIssue({
        code: 'custom',
        path: ['downloadedBytes'],
        message: 'downloaded bytes cannot exceed the selected source size',
      });
    }
    if (
      status.source !== undefined
      && status.source !== null
      && status.expectedBytes !== (
        status.source === 'github_release_archive'
          ? LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
          : LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedBytes'],
        message: 'expected bytes must match the selected model source',
      });
    }
    const cancellableStages: ReadonlySet<LocalAsrModelInstallStage> = new Set([
      'preparing',
      'downloading',
      'verifying',
      'extracting',
      'paused',
    ]);
    if (status.cancellable !== cancellableStages.has(status.stage)) {
      context.addIssue({
        code: 'custom',
        path: ['cancellable'],
        message: 'cancellable must match the active installation stage',
      });
    }
    const errorStage = status.stage === 'failed' || status.stage === 'cancelled';
    if (errorStage !== (status.errorCode !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'only failed or cancelled installation status carries an error code',
      });
    }
  });
export type GetLocalAsrModelInstallStatusOutput = z.infer<
  typeof GetLocalAsrModelInstallStatusOutputSchema
>;

export const CancelLocalAsrModelInstallInputSchema = EmptyInputSchema;
export type CancelLocalAsrModelInstallInput = EmptyInput;
export const CancelLocalAsrModelInstallOutputSchema = z
  .object({ cancelled: z.boolean() })
  .strict();
export type CancelLocalAsrModelInstallOutput = z.infer<
  typeof CancelLocalAsrModelInstallOutputSchema
>;

export const CLEAR_TRAINING_DATA_CONFIRMATION = 'clear-training-data' as const;
export const ClearTrainingDataInputSchema = z
  .object({ confirmation: z.literal(CLEAR_TRAINING_DATA_CONFIRMATION) })
  .strict();
export type ClearTrainingDataInput = z.infer<typeof ClearTrainingDataInputSchema>;
export const ClearTrainingDataOutputSchema = z
  .object({
    trainingDataCleared: z.literal(true),
    deletedTrainingRecordCount: z.number().int().nonnegative(),
    diagnosticLogs: DiagnosticLogClearSummarySchema,
    modelsPreserved: z.literal(true),
    externalExportsPreserved: z.literal(true),
    otherUserDataPreserved: z.literal(true),
  })
  .strict();
export type ClearTrainingDataOutput = z.infer<typeof ClearTrainingDataOutputSchema>;

export const RESET_NONSENSITIVE_SETTINGS_CONFIRMATION =
  'reset-nonsensitive-preferences' as const;
export const ResetNonSensitiveSettingsInputSchema = z
  .object({ confirmation: z.literal(RESET_NONSENSITIVE_SETTINGS_CONFIRMATION) })
  .strict();
export type ResetNonSensitiveSettingsInput = z.infer<
  typeof ResetNonSensitiveSettingsInputSchema
>;
export const ResetNonSensitiveSettingsOutputSchema = AppSettingsSchema;
export type ResetNonSensitiveSettingsOutput = AppSettings;

const AsrAttemptInputSchema = z.object({
  attemptId: z.string().min(1).max(96),
  generation: z.number().int().positive(),
}).strict();
const LiveAttemptIdentitySchema = AsrAttemptInputSchema.extend({
  sessionId: IdentifierSchema,
}).strict();
export const StartAsrInputSchema = LiveAttemptIdentitySchema.extend({
  restartIfNoFinal: z.literal(true).optional(),
}).strict();
export const StartAsrOutputSchema = z.object({ modelVersion: z.string().min(1).max(128) }).strict();
export const PcmSamplesSchema = z.custom<Float32Array>(
  (value) => value instanceof Float32Array && value.length > 0 && value.length <= 32_000,
  { message: 'PCM samples must be a bounded Float32Array' },
);
export const FeedAsrInputSchema = AsrAttemptInputSchema.extend({ samples: PcmSamplesSchema }).strict();
export const FeedAsrOutputSchema = TranscriptSegmentSchema.nullable();
export const StopAsrInputSchema = AsrAttemptInputSchema;
export const StopAsrOutputSchema = FeedAsrOutputSchema;
export type StartAsrInput = z.infer<typeof StartAsrInputSchema>;
export type StartAsrOutput = z.infer<typeof StartAsrOutputSchema>;
export type FeedAsrInput = z.infer<typeof FeedAsrInputSchema>;
export type FeedAsrOutput = z.infer<typeof FeedAsrOutputSchema>;
export type StopAsrInput = z.infer<typeof StopAsrInputSchema>;
export type StopAsrOutput = z.infer<typeof StopAsrOutputSchema>;

export const SetLiveAttemptAiStateInputSchema = LiveAttemptIdentitySchema.extend({
  enabled: z.boolean(),
  sealed: z.boolean().optional(),
}).strict();
export const SetLiveAttemptAiStateOutputSchema = SetLiveAttemptAiStateInputSchema;
export type SetLiveAttemptAiStateInput = z.infer<typeof SetLiveAttemptAiStateInputSchema>;
export type SetLiveAttemptAiStateOutput = z.infer<typeof SetLiveAttemptAiStateOutputSchema>;

export const GetCloudAiConfigurationInputSchema = EmptyInputSchema;
export type GetCloudAiConfigurationInput = EmptyInput;
export const GetCloudAiConfigurationOutputSchema = CloudAiConfigurationStatusSchema;
export type GetCloudAiConfigurationOutput = CloudAiConfigurationStatus;

export const SaveCloudAiKeyOutputSchema = CloudAiConfigurationStatusSchema;
export type SaveCloudAiKeyOutput = CloudAiConfigurationStatus;
export const DeleteCloudAiKeyInputSchema = EmptyInputSchema;
export type DeleteCloudAiKeyInput = EmptyInput;
export const DeleteCloudAiKeyOutputSchema = CloudAiConfigurationStatusSchema;
export type DeleteCloudAiKeyOutput = CloudAiConfigurationStatus;
export const GetCloudAiConsentStatusOutputSchema = CloudAiConsentStatusSchema;
export type GetCloudAiConsentStatusOutput = CloudAiConsentStatus;
export const PrepareAiConsentOutputSchema = PreparedAiConsentSchema;
export type PrepareAiConsentOutput = PreparedAiConsent;
export const ApproveAiConsentOutputSchema = CloudAiConsentSchema;
export type ApproveAiConsentOutput = CloudAiConsent;
export const RevokeAiConsentOutputSchema = CloudAiConsentSchema;
export type RevokeAiConsentOutput = CloudAiConsent;
export const ExecuteLiveHintOutputSchema = LiveHintResponseSchema;
export type ExecuteLiveHintOutput = LiveHintResponse;
export const ExecuteDeepDiagnosisOutputSchema = DeepDiagnosisResponseSchema;
export type ExecuteDeepDiagnosisOutput = DeepDiagnosisResponse;
export const ExecuteSemanticComparisonOutputSchema = SemanticComparisonResponseSchema;
export type ExecuteSemanticComparisonOutput = SemanticComparisonResponse;

export const PutArtifactInputSchema = PracticeArtifactSchema;
export const PutArtifactOutputSchema = PracticeArtifactSchema;
export const ListArtifactsInputSchema = SessionIdInputSchema;
export const ListArtifactsOutputSchema = z.array(PracticeArtifactSchema);
export type PutArtifactInput = z.infer<typeof PutArtifactInputSchema>;
export type PutArtifactOutput = z.infer<typeof PutArtifactOutputSchema>;
export type ListArtifactsInput = z.infer<typeof ListArtifactsInputSchema>;
export type ListArtifactsOutput = z.infer<typeof ListArtifactsOutputSchema>;

export interface PhrioDesktopApi {
  getBootstrap(): Promise<BootstrapData>;
  createSession(input: CreateSessionInput): Promise<CreateSessionOutput>;
  getSession(input: GetSessionInput): Promise<GetSessionOutput>;
  listSessions(input?: ListSessionsInput): Promise<ListSessionsOutput>;
  transitionSession(input: TransitionSessionInput): Promise<TransitionSessionOutput>;
  updateSessionRecord(input: UpdateSessionRecordInput): Promise<UpdateSessionRecordOutput>;
  deleteSession(input: DeleteSessionInput): Promise<DeleteSessionOutput>;
  saveAttemptAudio(input: SaveAttemptAudioInput): Promise<SaveAttemptAudioOutput>;
  readAttemptAudio(input: ReadAttemptAudioInput): Promise<ReadAttemptAudioOutput>;
  discardAttemptAudio(input: DiscardAttemptAudioInput): Promise<DiscardAttemptAudioOutput>;
  getSettings(): Promise<GetSettingsOutput>;
  updateSettings(input: UpdateSettingsInput): Promise<UpdateSettingsOutput>;
  startAsr(input: StartAsrInput): Promise<StartAsrOutput>;
  feedAsr(input: FeedAsrInput): Promise<FeedAsrOutput>;
  stopAsr(input: StopAsrInput): Promise<StopAsrOutput>;
  putArtifact(input: PutArtifactInput): Promise<PutArtifactOutput>;
  listArtifacts(input: ListArtifactsInput): Promise<ListArtifactsOutput>;
  getEnvironmentStatus(): Promise<GetEnvironmentStatusOutput>;
  installLocalAsrModel(): Promise<InstallLocalAsrModelOutput>;
  getLocalAsrModelInstallStatus(): Promise<GetLocalAsrModelInstallStatusOutput>;
  cancelLocalAsrModelInstall(): Promise<CancelLocalAsrModelInstallOutput>;
  clearTrainingData(input: ClearTrainingDataInput): Promise<ClearTrainingDataOutput>;
  resetNonSensitiveSettings(
    input: ResetNonSensitiveSettingsInput,
  ): Promise<ResetNonSensitiveSettingsOutput>;
  recordDiagnosticEvent(
    input: RecordDiagnosticEventInput,
  ): Promise<RecordDiagnosticEventOutput>;
  getDiagnosticStatus(): Promise<DiagnosticStatus>;
  openDiagnosticDirectory(): Promise<OpenDiagnosticDirectoryOutput>;
  exportDiagnosticBundle(): Promise<ExportDiagnosticBundleOutput>;
  clearDiagnosticLogs(): Promise<ClearDiagnosticLogsOutput>;
  getCloudAiConfiguration(): Promise<GetCloudAiConfigurationOutput>;
  saveCloudAiKey(input: SaveCloudAiKeyInput): Promise<SaveCloudAiKeyOutput>;
  deleteCloudAiKey(): Promise<DeleteCloudAiKeyOutput>;
  getCloudAiConsentStatus(
    input: GetCloudAiConsentStatusInput,
  ): Promise<GetCloudAiConsentStatusOutput>;
  prepareAiConsent(input: PrepareAiConsentInput): Promise<PrepareAiConsentOutput>;
  approveAiConsent(input: ApproveAiConsentInput): Promise<ApproveAiConsentOutput>;
  revokeAiConsent(input: RevokeAiConsentInput): Promise<RevokeAiConsentOutput>;
  setLiveAttemptAiState(
    input: SetLiveAttemptAiStateInput,
  ): Promise<SetLiveAttemptAiStateOutput>;
  executeLiveHint(input: ExecuteLiveHintInput): Promise<ExecuteLiveHintOutput>;
  executeDeepDiagnosis(
    input: ExecuteDeepDiagnosisInput,
  ): Promise<ExecuteDeepDiagnosisOutput>;
  executeSemanticComparison(
    input: ExecuteSemanticComparisonInput,
  ): Promise<ExecuteSemanticComparisonOutput>;
  cancelLiveHint(input: CancelLiveHintInput): Promise<CancelLiveHintOutput>;
}

export interface IpcContract<Input, Output> {
  readonly input: z.ZodType<Input>;
  readonly output: z.ZodType<Output>;
}

export const IPC_CONTRACTS = {
  [IPC_CHANNELS.APP_GET_BOOTSTRAP]: {
    input: EmptyInputSchema,
    output: BootstrapDataSchema,
  } satisfies IpcContract<EmptyInput, BootstrapData>,
  [IPC_CHANNELS.SESSIONS_CREATE]: {
    input: CreateSessionInputSchema,
    output: CreateSessionOutputSchema,
  } satisfies IpcContract<CreateSessionInput, CreateSessionOutput>,
  [IPC_CHANNELS.SESSIONS_GET]: {
    input: GetSessionInputSchema,
    output: GetSessionOutputSchema,
  } satisfies IpcContract<GetSessionInput, GetSessionOutput>,
  [IPC_CHANNELS.SESSIONS_LIST]: {
    input: ListSessionsInputSchema,
    output: ListSessionsOutputSchema,
  } satisfies IpcContract<ListSessionsInput, ListSessionsOutput>,
  [IPC_CHANNELS.SESSIONS_TRANSITION]: {
    input: TransitionSessionInputSchema,
    output: TransitionSessionOutputSchema,
  } satisfies IpcContract<TransitionSessionInput, TransitionSessionOutput>,
  [IPC_CHANNELS.SESSIONS_UPDATE_RECORD]: {
    input: UpdateSessionRecordInputSchema,
    output: UpdateSessionRecordOutputSchema,
  } satisfies IpcContract<UpdateSessionRecordInput, UpdateSessionRecordOutput>,
  [IPC_CHANNELS.SESSIONS_DELETE]: {
    input: DeleteSessionInputSchema,
    output: DeleteSessionOutputSchema,
  } satisfies IpcContract<DeleteSessionInput, DeleteSessionOutput>,
  [IPC_CHANNELS.ATTEMPTS_SAVE_AUDIO]: {
    input: SaveAttemptAudioInputSchema,
    output: SaveAttemptAudioOutputSchema,
  } satisfies IpcContract<SaveAttemptAudioInput, SaveAttemptAudioOutput>,
  [IPC_CHANNELS.ATTEMPTS_READ_AUDIO]: {
    input: ReadAttemptAudioInputSchema,
    output: ReadAttemptAudioOutputSchema,
  } satisfies IpcContract<ReadAttemptAudioInput, ReadAttemptAudioOutput>,
  [IPC_CHANNELS.ATTEMPTS_DISCARD]: {
    input: DiscardAttemptAudioInputSchema,
    output: DiscardAttemptAudioOutputSchema,
  } satisfies IpcContract<DiscardAttemptAudioInput, DiscardAttemptAudioOutput>,
  [IPC_CHANNELS.SETTINGS_GET]: {
    input: GetSettingsInputSchema,
    output: GetSettingsOutputSchema,
  } satisfies IpcContract<GetSettingsInput, GetSettingsOutput>,
  [IPC_CHANNELS.SETTINGS_UPDATE]: {
    input: UpdateSettingsInputSchema,
    output: UpdateSettingsOutputSchema,
  } satisfies IpcContract<UpdateSettingsInput, UpdateSettingsOutput>,
  [IPC_CHANNELS.ASR_START]: { input: StartAsrInputSchema, output: StartAsrOutputSchema },
  [IPC_CHANNELS.ASR_FEED]: { input: FeedAsrInputSchema, output: FeedAsrOutputSchema },
  [IPC_CHANNELS.ASR_STOP]: { input: StopAsrInputSchema, output: StopAsrOutputSchema },
  [IPC_CHANNELS.ARTIFACTS_PUT]: { input: PutArtifactInputSchema, output: PutArtifactOutputSchema },
  [IPC_CHANNELS.ARTIFACTS_LIST]: { input: ListArtifactsInputSchema, output: ListArtifactsOutputSchema },
  [IPC_CHANNELS.ENVIRONMENT_GET_STATUS]: {
    input: GetEnvironmentStatusInputSchema,
    output: GetEnvironmentStatusOutputSchema,
  } satisfies IpcContract<GetEnvironmentStatusInput, GetEnvironmentStatusOutput>,
  [IPC_CHANNELS.ENVIRONMENT_INSTALL_ASR_MODEL]: {
    input: InstallLocalAsrModelInputSchema,
    output: InstallLocalAsrModelOutputSchema,
  } satisfies IpcContract<InstallLocalAsrModelInput, InstallLocalAsrModelOutput>,
  [IPC_CHANNELS.ENVIRONMENT_GET_ASR_MODEL_INSTALL_STATUS]: {
    input: GetLocalAsrModelInstallStatusInputSchema,
    output: GetLocalAsrModelInstallStatusOutputSchema,
  } satisfies IpcContract<
    GetLocalAsrModelInstallStatusInput,
    GetLocalAsrModelInstallStatusOutput
  >,
  [IPC_CHANNELS.ENVIRONMENT_CANCEL_ASR_MODEL_INSTALL]: {
    input: CancelLocalAsrModelInstallInputSchema,
    output: CancelLocalAsrModelInstallOutputSchema,
  } satisfies IpcContract<CancelLocalAsrModelInstallInput, CancelLocalAsrModelInstallOutput>,
  [IPC_CHANNELS.DATA_CLEAR_TRAINING]: {
    input: ClearTrainingDataInputSchema,
    output: ClearTrainingDataOutputSchema,
  } satisfies IpcContract<ClearTrainingDataInput, ClearTrainingDataOutput>,
  [IPC_CHANNELS.SETTINGS_RESET_NONSENSITIVE]: {
    input: ResetNonSensitiveSettingsInputSchema,
    output: ResetNonSensitiveSettingsOutputSchema,
  } satisfies IpcContract<ResetNonSensitiveSettingsInput, ResetNonSensitiveSettingsOutput>,
  [IPC_CHANNELS.DIAGNOSTICS_RECORD_EVENT]: {
    input: RecordDiagnosticEventInputSchema,
    output: RecordDiagnosticEventOutputSchema,
  } satisfies IpcContract<RecordDiagnosticEventInput, RecordDiagnosticEventOutput>,
  [IPC_CHANNELS.DIAGNOSTICS_GET_STATUS]: {
    input: EmptyInputSchema,
    output: DiagnosticStatusSchema,
  } satisfies IpcContract<EmptyInput, DiagnosticStatus>,
  [IPC_CHANNELS.DIAGNOSTICS_OPEN_DIRECTORY]: {
    input: EmptyInputSchema,
    output: OpenDiagnosticDirectoryOutputSchema,
  } satisfies IpcContract<EmptyInput, OpenDiagnosticDirectoryOutput>,
  [IPC_CHANNELS.DIAGNOSTICS_EXPORT_BUNDLE]: {
    input: EmptyInputSchema,
    output: ExportDiagnosticBundleOutputSchema,
  } satisfies IpcContract<EmptyInput, ExportDiagnosticBundleOutput>,
  [IPC_CHANNELS.DIAGNOSTICS_CLEAR]: {
    input: EmptyInputSchema,
    output: ClearDiagnosticLogsOutputSchema,
  } satisfies IpcContract<EmptyInput, ClearDiagnosticLogsOutput>,
  [IPC_CHANNELS.CLOUD_AI_GET_CONFIGURATION]: {
    input: GetCloudAiConfigurationInputSchema,
    output: GetCloudAiConfigurationOutputSchema,
  } satisfies IpcContract<GetCloudAiConfigurationInput, GetCloudAiConfigurationOutput>,
  [IPC_CHANNELS.CLOUD_AI_SAVE_KEY]: {
    input: SaveCloudAiKeyInputSchema,
    output: SaveCloudAiKeyOutputSchema,
  } satisfies IpcContract<SaveCloudAiKeyInput, SaveCloudAiKeyOutput>,
  [IPC_CHANNELS.CLOUD_AI_DELETE_KEY]: {
    input: DeleteCloudAiKeyInputSchema,
    output: DeleteCloudAiKeyOutputSchema,
  } satisfies IpcContract<DeleteCloudAiKeyInput, DeleteCloudAiKeyOutput>,
  [IPC_CHANNELS.CLOUD_AI_GET_CONSENT_STATUS]: {
    input: GetCloudAiConsentStatusInputSchema,
    output: GetCloudAiConsentStatusOutputSchema,
  } satisfies IpcContract<GetCloudAiConsentStatusInput, GetCloudAiConsentStatusOutput>,
  [IPC_CHANNELS.CLOUD_AI_PREPARE_CONSENT]: {
    input: PrepareAiConsentInputSchema,
    output: PrepareAiConsentOutputSchema,
  } satisfies IpcContract<PrepareAiConsentInput, PrepareAiConsentOutput>,
  [IPC_CHANNELS.CLOUD_AI_APPROVE_CONSENT]: {
    input: ApproveAiConsentInputSchema,
    output: ApproveAiConsentOutputSchema,
  } satisfies IpcContract<ApproveAiConsentInput, ApproveAiConsentOutput>,
  [IPC_CHANNELS.CLOUD_AI_REVOKE_CONSENT]: {
    input: RevokeAiConsentInputSchema,
    output: RevokeAiConsentOutputSchema,
  } satisfies IpcContract<RevokeAiConsentInput, RevokeAiConsentOutput>,
  [IPC_CHANNELS.CLOUD_AI_SET_LIVE_ATTEMPT_STATE]: {
    input: SetLiveAttemptAiStateInputSchema,
    output: SetLiveAttemptAiStateOutputSchema,
  } satisfies IpcContract<SetLiveAttemptAiStateInput, SetLiveAttemptAiStateOutput>,
  [IPC_CHANNELS.CLOUD_AI_EXECUTE_LIVE_HINT]: {
    input: ExecuteLiveHintInputSchema,
    output: ExecuteLiveHintOutputSchema,
  } satisfies IpcContract<ExecuteLiveHintInput, ExecuteLiveHintOutput>,
  [IPC_CHANNELS.CLOUD_AI_EXECUTE_DEEP_DIAGNOSIS]: {
    input: ExecuteDeepDiagnosisInputSchema,
    output: ExecuteDeepDiagnosisOutputSchema,
  } satisfies IpcContract<ExecuteDeepDiagnosisInput, ExecuteDeepDiagnosisOutput>,
  [IPC_CHANNELS.CLOUD_AI_EXECUTE_COMPARISON]: {
    input: ExecuteSemanticComparisonInputSchema,
    output: ExecuteSemanticComparisonOutputSchema,
  } satisfies IpcContract<ExecuteSemanticComparisonInput, ExecuteSemanticComparisonOutput>,
  [IPC_CHANNELS.CLOUD_AI_CANCEL_LIVE_HINT]: {
    input: CancelLiveHintInputSchema,
    output: CancelLiveHintOutputSchema,
  } satisfies IpcContract<CancelLiveHintInput, CancelLiveHintOutput>,
} as const;

export type { ModePack, SessionEvent };
