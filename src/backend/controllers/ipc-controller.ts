import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { z, type ZodType } from 'zod';
import {
  BootstrapDataSchema,
  ApproveAiConsentInputSchema,
  ApproveAiConsentOutputSchema,
  CancelLiveHintInputSchema,
  CancelLiveHintOutputSchema,
  CancelLocalAsrModelInstallInputSchema,
  CancelLocalAsrModelInstallOutputSchema,
  ClearTrainingDataInputSchema,
  ClearTrainingDataOutputSchema,
  CreateSessionInputSchema,
  CreateSessionOutputSchema,
  DeleteSessionInputSchema,
  DeleteSessionOutputSchema,
  DeleteCloudAiKeyInputSchema,
  DeleteCloudAiKeyOutputSchema,
  DiagnosticStatusSchema,
  DiscardAttemptAudioInputSchema,
  DiscardAttemptAudioOutputSchema,
  EmptyInputSchema,
  FeedAsrInputSchema,
  FeedAsrOutputSchema,
  ExecuteDeepDiagnosisInputSchema,
  ExecuteDeepDiagnosisOutputSchema,
  ExecuteLiveHintInputSchema,
  ExecuteLiveHintOutputSchema,
  ExecuteSemanticComparisonInputSchema,
  ExecuteSemanticComparisonOutputSchema,
  ExportDiagnosticBundleOutputSchema,
  GetCloudAiConfigurationInputSchema,
  GetCloudAiConfigurationOutputSchema,
  GetCloudAiConsentStatusInputSchema,
  GetCloudAiConsentStatusOutputSchema,
  GetEnvironmentStatusInputSchema,
  GetEnvironmentStatusOutputSchema,
  GetLocalAsrModelInstallStatusInputSchema,
  GetLocalAsrModelInstallStatusOutputSchema,
  InstallLocalAsrModelInputSchema,
  InstallLocalAsrModelOutputSchema,
  GetSessionInputSchema,
  GetSessionOutputSchema,
  GetSettingsOutputSchema,
  IPC_CHANNELS,
  ListSessionsInputSchema,
  ListSessionsOutputSchema,
  ListArtifactsInputSchema,
  ListArtifactsOutputSchema,
  OpenDiagnosticDirectoryOutputSchema,
  PutArtifactInputSchema,
  PutArtifactOutputSchema,
  PrepareAiConsentInputSchema,
  PrepareAiConsentOutputSchema,
  ReadAttemptAudioInputSchema,
  ReadAttemptAudioOutputSchema,
  RecordDiagnosticEventInputSchema,
  RecordDiagnosticEventOutputSchema,
  ResetNonSensitiveSettingsInputSchema,
  ResetNonSensitiveSettingsOutputSchema,
  RevokeAiConsentInputSchema,
  RevokeAiConsentOutputSchema,
  SaveCloudAiKeyInputSchema,
  SaveCloudAiKeyOutputSchema,
  SaveAttemptAudioInputSchema,
  SaveAttemptAudioOutputSchema,
  SetLiveAttemptAiStateInputSchema,
  SetLiveAttemptAiStateOutputSchema,
  StartAsrInputSchema,
  StartAsrOutputSchema,
  StopAsrInputSchema,
  StopAsrOutputSchema,
  ClearDiagnosticLogsOutputSchema,
  TransitionSessionInputSchema,
  TransitionSessionOutputSchema,
  UpdateSessionRecordInputSchema,
  UpdateSessionRecordOutputSchema,
  UpdateSettingsInputSchema,
  UpdateSettingsOutputSchema,
  type IpcChannel,
} from '../../shared';
import type { TrustedRendererPolicy } from '../config/renderer-security';
import { AudioRepositoryError } from '../repositories/audio-repository';
import { SessionRepositoryError } from '../repositories/session-repository';
import {
  PracticeSessionService,
  PracticeSessionServiceError,
} from '../services/practice-session-service';
import { LocalAsrService, LocalAsrServiceError } from '../services/local-asr-service';
import { LocalAsrModelInstallerError } from '../services/local-asr-model-installer';
import { EnvironmentService } from '../services/environment-service';
import { CloudAiService, CloudAiServiceError } from '../services/cloud-ai-service';
import { DiagnosticLogService } from '../services/diagnostic-log-service';

type MaybePromise<T> = T | Promise<T>;

export interface DiagnosticDesktopActions {
  readonly chooseExportPath: () => Promise<string | null>;
  readonly openDirectory: (directoryPath: string) => Promise<string>;
}

const NON_RECURSIVE_DIAGNOSTIC_CHANNELS = new Set<IpcChannel>([
  IPC_CHANNELS.DIAGNOSTICS_RECORD_EVENT,
  IPC_CHANNELS.DIAGNOSTICS_GET_STATUS,
  IPC_CHANNELS.DIAGNOSTICS_OPEN_DIRECTORY,
  IPC_CHANNELS.DIAGNOSTICS_EXPORT_BUNDLE,
  IPC_CHANNELS.DIAGNOSTICS_CLEAR,
]);

// These reads are intentionally polled while a long-running operation is in
// progress. Recording a start/completion pair for every poll would quickly
// evict the installer milestones and the recording/ASR evidence that the
// diagnostic bundle is meant to preserve. Failures are still recorded.
const HIGH_FREQUENCY_STATUS_CHANNELS = new Set<IpcChannel>([
  IPC_CHANNELS.ENVIRONMENT_GET_ASR_MODEL_INSTALL_STATUS,
]);

export class IpcController {
  readonly #ipcMain: IpcMain;
  readonly #service: PracticeSessionService;
  readonly #asr: LocalAsrService;
  readonly #environment: EnvironmentService;
  readonly #cloudAi: CloudAiService;
  readonly #rendererPolicy: TrustedRendererPolicy;
  readonly #diagnostics: DiagnosticLogService;
  readonly #diagnosticDesktopActions: DiagnosticDesktopActions;
  readonly #registeredChannels = new Set<IpcChannel>();

  constructor(
    ipcMain: IpcMain,
    service: PracticeSessionService,
    asr: LocalAsrService,
    environment: EnvironmentService,
    cloudAi: CloudAiService,
    rendererPolicy: TrustedRendererPolicy,
    diagnostics: DiagnosticLogService,
    diagnosticDesktopActions: DiagnosticDesktopActions,
  ) {
    this.#ipcMain = ipcMain;
    this.#service = service;
    this.#asr = asr;
    this.#environment = environment;
    this.#cloudAi = cloudAi;
    this.#rendererPolicy = rendererPolicy;
    this.#diagnostics = diagnostics;
    this.#diagnosticDesktopActions = diagnosticDesktopActions;
  }

  register(): void {
    this.#register(
      IPC_CHANNELS.APP_GET_BOOTSTRAP,
      EmptyInputSchema,
      BootstrapDataSchema,
      () => this.#service.getBootstrap(),
    );
    this.#register(
      IPC_CHANNELS.SESSIONS_CREATE,
      CreateSessionInputSchema,
      CreateSessionOutputSchema,
      (input) => this.#service.createSession(input),
    );
    this.#register(
      IPC_CHANNELS.SESSIONS_GET,
      GetSessionInputSchema,
      GetSessionOutputSchema,
      (input) => this.#service.getSession(input.sessionId),
    );
    this.#register(
      IPC_CHANNELS.SESSIONS_LIST,
      ListSessionsInputSchema,
      ListSessionsOutputSchema,
      (input) => this.#service.listSessions(input),
    );
    this.#register(
      IPC_CHANNELS.SESSIONS_TRANSITION,
      TransitionSessionInputSchema,
      TransitionSessionOutputSchema,
      async (input) => {
        const session = await this.#service.transitionSession(input.sessionId, input.event);
        if (session.status !== 'first_attempt' && session.status !== 'second_attempt') {
          this.#cloudAi.releaseLiveSessionLeases(session.id, 'disabled');
        }
        return session;
      },
    );
    this.#register(
      IPC_CHANNELS.SESSIONS_UPDATE_RECORD,
      UpdateSessionRecordInputSchema,
      UpdateSessionRecordOutputSchema,
      (input) => this.#service.updateSessionRecord(input),
    );
    this.#register(
      IPC_CHANNELS.SESSIONS_DELETE,
      DeleteSessionInputSchema,
      DeleteSessionOutputSchema,
      async (input) => {
        this.#cloudAi.releaseLiveSessionLeases(input.sessionId);
        await this.#environment.deletePracticeSession(input.sessionId);
        return { deletedSessionId: input.sessionId };
      },
    );
    this.#register(
      IPC_CHANNELS.ATTEMPTS_SAVE_AUDIO,
      SaveAttemptAudioInputSchema,
      SaveAttemptAudioOutputSchema,
      (input) => this.#service.saveAttemptAudio(input),
    );
    this.#register(
      IPC_CHANNELS.ATTEMPTS_READ_AUDIO,
      ReadAttemptAudioInputSchema,
      ReadAttemptAudioOutputSchema,
      (input) => this.#service.readAttemptAudio(input),
    );
    this.#register(
      IPC_CHANNELS.ATTEMPTS_DISCARD,
      DiscardAttemptAudioInputSchema,
      DiscardAttemptAudioOutputSchema,
      (input) => this.#service.discardAttemptAudio(input),
    );
    this.#register(
      IPC_CHANNELS.SETTINGS_GET,
      EmptyInputSchema,
      GetSettingsOutputSchema,
      () => this.#service.getSettings(),
    );
    this.#register(
      IPC_CHANNELS.SETTINGS_UPDATE,
      UpdateSettingsInputSchema,
      UpdateSettingsOutputSchema,
      (input) => this.#service.updateSettings(input),
    );
    this.#register(IPC_CHANNELS.ASR_START, StartAsrInputSchema, StartAsrOutputSchema, (input) => {
      const session = this.#service.getSession(input.sessionId);
      if (!session) throw new CloudAiServiceError('LIVE_ATTEMPT_LEASE_REJECTED');
      const leaseExisted = this.#cloudAi.hasLiveAttemptLease(input);
      this.#cloudAi.openLiveAttemptLease({
        session,
        attemptId: input.attemptId,
        generation: input.generation,
      });
      try {
        return input.restartIfNoFinal
          ? this.#asr.restartIfNoFinal(input)
          : this.#asr.start(input);
      } catch (error) {
        if (!leaseExisted) this.#cloudAi.releaseLiveAttemptLease(input);
        throw error;
      }
    });
    this.#register(IPC_CHANNELS.ASR_FEED, FeedAsrInputSchema, FeedAsrOutputSchema, (input) =>
      this.#asr.feed(input),
    );
    this.#register(IPC_CHANNELS.ASR_STOP, StopAsrInputSchema, StopAsrOutputSchema, (input) => {
      try {
        return this.#asr.stop(input);
      } finally {
        this.#cloudAi.releaseLiveAttemptGeneration(input);
      }
    });
    this.#register(
      IPC_CHANNELS.ARTIFACTS_PUT,
      PutArtifactInputSchema,
      PutArtifactOutputSchema,
      (input) => {
        if (
          input.type === 'cloud_deep_diagnosis'
          || input.type === 'cloud_semantic_comparison'
        ) {
          this.#cloudAi.assertCloudArtifactAttested(input);
        }
        return this.#service.putArtifact(input);
      },
    );
    this.#register(IPC_CHANNELS.ARTIFACTS_LIST, ListArtifactsInputSchema, ListArtifactsOutputSchema, (input) =>
      [...this.#service.listArtifacts(input.sessionId)],
    );
    this.#register(
      IPC_CHANNELS.ENVIRONMENT_GET_STATUS,
      GetEnvironmentStatusInputSchema,
      GetEnvironmentStatusOutputSchema,
      () => this.#environment.getStatus(),
    );
    this.#register(
      IPC_CHANNELS.ENVIRONMENT_INSTALL_ASR_MODEL,
      InstallLocalAsrModelInputSchema,
      InstallLocalAsrModelOutputSchema,
      () => this.#environment.installLocalAsrModel(),
    );
    this.#register(
      IPC_CHANNELS.ENVIRONMENT_GET_ASR_MODEL_INSTALL_STATUS,
      GetLocalAsrModelInstallStatusInputSchema,
      GetLocalAsrModelInstallStatusOutputSchema,
      () => this.#environment.getLocalAsrModelInstallStatus(),
    );
    this.#register(
      IPC_CHANNELS.ENVIRONMENT_CANCEL_ASR_MODEL_INSTALL,
      CancelLocalAsrModelInstallInputSchema,
      CancelLocalAsrModelInstallOutputSchema,
      () => ({ cancelled: this.#environment.cancelLocalAsrModelInstallation() }),
    );
    this.#register(
      IPC_CHANNELS.DATA_CLEAR_TRAINING,
      ClearTrainingDataInputSchema,
      ClearTrainingDataOutputSchema,
      () => {
        this.#cloudAi.releaseAllLiveAttemptLeases();
        return this.#environment.clearTrainingData();
      },
    );
    this.#register(
      IPC_CHANNELS.SETTINGS_RESET_NONSENSITIVE,
      ResetNonSensitiveSettingsInputSchema,
      ResetNonSensitiveSettingsOutputSchema,
      () => {
        this.#cloudAi.releaseAllLiveAttemptLeases('consent_reset');
        return this.#environment.resetNonSensitiveSettings();
      },
    );
    this.#register(
      IPC_CHANNELS.DIAGNOSTICS_RECORD_EVENT,
      RecordDiagnosticEventInputSchema,
      RecordDiagnosticEventOutputSchema,
      (input) => this.#diagnostics.record(input),
    );
    this.#register(
      IPC_CHANNELS.DIAGNOSTICS_GET_STATUS,
      EmptyInputSchema,
      DiagnosticStatusSchema,
      () => this.#diagnostics.getStatus(),
    );
    this.#register(
      IPC_CHANNELS.DIAGNOSTICS_OPEN_DIRECTORY,
      EmptyInputSchema,
      OpenDiagnosticDirectoryOutputSchema,
      async () => {
        try {
          const errorMessage = await this.#diagnosticDesktopActions.openDirectory(
            this.#diagnostics.getStatus().logDirectory,
          );
          if (errorMessage !== '') {
            this.#recordDiagnostic({
              level: 'warn',
              component: 'diagnostics',
              event: 'diagnostics.directory-open-failed',
              fields: { errorCode: 'SHELL_OPEN_FAILED' },
            });
          }
          return {
            opened: errorMessage === '',
            errorCode: errorMessage === '' ? null : 'SHELL_OPEN_FAILED',
          };
        } catch (error) {
          this.#recordDiagnosticError('diagnostics', 'diagnostics.directory-open-failed', error);
          return { opened: false, errorCode: 'SHELL_OPEN_FAILED' };
        }
      },
    );
    this.#register(
      IPC_CHANNELS.DIAGNOSTICS_EXPORT_BUNDLE,
      EmptyInputSchema,
      ExportDiagnosticBundleOutputSchema,
      async () => {
        try {
          const destinationPath = await this.#diagnosticDesktopActions.chooseExportPath();
          if (!destinationPath) {
            return {
              cancelled: true,
              filePath: null,
              sourceFileCount: 0,
              eventCount: 0,
              byteLength: 0,
            };
          }
          const result = this.#diagnostics.exportBundle(destinationPath);
          this.#recordDiagnostic({
            level: 'info',
            component: 'diagnostics',
            event: 'diagnostics.export-completed',
            fields: {
              sourceFileCount: result.sourceFileCount,
              eventCount: result.eventCount,
              byteLength: result.byteLength,
            },
          });
          return result;
        } catch (error) {
          this.#recordDiagnosticError('diagnostics', 'diagnostics.export-failed', error);
          throw error;
        }
      },
    );
    this.#register(
      IPC_CHANNELS.DIAGNOSTICS_CLEAR,
      EmptyInputSchema,
      ClearDiagnosticLogsOutputSchema,
      () => this.#diagnostics.clear(),
    );
    this.#register(
      IPC_CHANNELS.CLOUD_AI_GET_CONFIGURATION,
      GetCloudAiConfigurationInputSchema,
      GetCloudAiConfigurationOutputSchema,
      () => this.#cloudAi.getConfigurationStatus(),
    );
    this.#register(
      IPC_CHANNELS.CLOUD_AI_SAVE_KEY,
      SaveCloudAiKeyInputSchema,
      SaveCloudAiKeyOutputSchema,
      (input) => this.#cloudAi.saveApiKey(input),
    );
    this.#register(
      IPC_CHANNELS.CLOUD_AI_DELETE_KEY,
      DeleteCloudAiKeyInputSchema,
      DeleteCloudAiKeyOutputSchema,
      () => this.#cloudAi.deleteApiKey(),
    );
    this.#register(
      IPC_CHANNELS.CLOUD_AI_GET_CONSENT_STATUS,
      GetCloudAiConsentStatusInputSchema,
      GetCloudAiConsentStatusOutputSchema,
      (input) => this.#cloudAi.getConsentStatus(input),
    );
    this.#register(
      IPC_CHANNELS.CLOUD_AI_PREPARE_CONSENT,
      PrepareAiConsentInputSchema,
      PrepareAiConsentOutputSchema,
      (input) => this.#cloudAi.prepareConsent(input),
    );
    this.#register(
      IPC_CHANNELS.CLOUD_AI_APPROVE_CONSENT,
      ApproveAiConsentInputSchema,
      ApproveAiConsentOutputSchema,
      (input) => this.#cloudAi.approveConsent(input),
    );
    this.#register(
      IPC_CHANNELS.CLOUD_AI_REVOKE_CONSENT,
      RevokeAiConsentInputSchema,
      RevokeAiConsentOutputSchema,
      (input) => this.#cloudAi.revokeConsent(input.consentId),
    );
    this.#register(
      IPC_CHANNELS.CLOUD_AI_SET_LIVE_ATTEMPT_STATE,
      SetLiveAttemptAiStateInputSchema,
      SetLiveAttemptAiStateOutputSchema,
      (input) => this.#cloudAi.setLiveAttemptAiState(input),
    );
    this.#register(
      IPC_CHANNELS.CLOUD_AI_EXECUTE_LIVE_HINT,
      ExecuteLiveHintInputSchema,
      ExecuteLiveHintOutputSchema,
      (input) => this.#cloudAi.executeLiveHint(input),
    );
    this.#register(
      IPC_CHANNELS.CLOUD_AI_EXECUTE_DEEP_DIAGNOSIS,
      ExecuteDeepDiagnosisInputSchema,
      ExecuteDeepDiagnosisOutputSchema,
      (input) => {
        this.#service.assertCloudExecutionApproved(input.payload, input.consentId);
        return this.#cloudAi.executeDeepDiagnosis(input);
      },
    );
    this.#register(
      IPC_CHANNELS.CLOUD_AI_EXECUTE_COMPARISON,
      ExecuteSemanticComparisonInputSchema,
      ExecuteSemanticComparisonOutputSchema,
      (input) => {
        this.#service.assertCloudExecutionApproved(input.payload, input.consentId);
        return this.#cloudAi.executeSemanticComparison(input);
      },
    );
    this.#register(
      IPC_CHANNELS.CLOUD_AI_CANCEL_LIVE_HINT,
      CancelLiveHintInputSchema,
      CancelLiveHintOutputSchema,
      (input) => {
        this.#cloudAi.cancelLiveHint(input.attemptId);
        return { cancelledAttemptId: input.attemptId };
      },
    );
  }

  dispose(): void {
    for (const channel of this.#registeredChannels) {
      this.#ipcMain.removeHandler(channel);
    }
    this.#registeredChannels.clear();
  }

  #register<Input, Output>(
    channel: IpcChannel,
    inputSchema: ZodType<Input>,
    outputSchema: ZodType<Output>,
    useCase: (input: Input) => MaybePromise<Output>,
  ): void {
    if (this.#registeredChannels.has(channel)) {
      throw new Error(`IPC channel is already registered: ${channel}`);
    }

    this.#ipcMain.handle(channel, async (event, rawInput: unknown = {}) => {
      const startedAt = performance.now();
      const diagnosticGeneration = this.#diagnostics.generation;
      let correlation: DiagnosticCorrelation = this.#shouldRecordInvocationStart(channel)
        ? { operationId: `operation-${randomUUID()}` }
        : {};
      try {
        this.#assertTrustedSender(event);
        const input = inputSchema.parse(rawInput);
        correlation = {
          ...correlation,
          ...getDiagnosticCorrelation(input),
        };
        if (this.#shouldRecordInvocationStart(channel)) {
          this.#recordDiagnostic({
            level: 'debug',
            component: 'ipc',
            event: 'ipc.invoke-started',
            ...correlation,
            fields: { channel, ...getDiagnosticInvocationFields(channel, input) },
          });
        }
        const output = await useCase(input);
        const parsedOutput = outputSchema.parse(output);
        if (this.#shouldRecordInvocationCompletion(channel)) {
          this.#recordDiagnosticForGeneration(diagnosticGeneration, {
            level: 'debug',
            component: 'ipc',
            event: 'ipc.invoke-completed',
            ...correlation,
            fields: {
              channel,
              durationMs: Math.max(0, performance.now() - startedAt),
            },
          });
        }
        return parsedOutput;
      } catch (error) {
        if (this.#shouldRecordInvocationFailure(channel)) {
          this.#recordDiagnosticErrorForGeneration(diagnosticGeneration, 'ipc', 'ipc.invoke-failed', error, {
            channel,
            durationMs: Math.max(0, performance.now() - startedAt),
          }, correlation);
        }
        throw toRendererSafeError(error);
      }
    });
    this.#registeredChannels.add(channel);
  }

  #assertTrustedSender(event: IpcMainInvokeEvent): void {
    const frame = event.senderFrame;
    if (
      frame === null ||
      frame !== event.sender.mainFrame ||
      !this.#rendererPolicy.isTrustedWebContents(event.sender) ||
      !this.#rendererPolicy.isTrustedUrl(frame.url)
    ) {
      throw new IpcSecurityError();
    }
  }

  #shouldRecordInvocationStart(channel: IpcChannel): boolean {
    // Renderer diagnostics already describe their originating action. Skipping
    // these channels prevents self-recursion. PCM feed is intentionally too
    // frequent for operational logs.
    return !NON_RECURSIVE_DIAGNOSTIC_CHANNELS.has(channel)
      && channel !== IPC_CHANNELS.ASR_FEED
      && !HIGH_FREQUENCY_STATUS_CHANNELS.has(channel);
  }

  #shouldRecordInvocationCompletion(channel: IpcChannel): boolean {
    // EnvironmentService clears diagnostic storage as the final successful
    // all-data-clear step. Writing a completion span here would recreate it.
    return this.#shouldRecordInvocationStart(channel)
      && channel !== IPC_CHANNELS.DATA_CLEAR_TRAINING;
  }

  #shouldRecordInvocationFailure(channel: IpcChannel): boolean {
    // Failed clears keep their start/error evidence; only successful clears
    // suppress the post-operation completion event. High-frequency status
    // reads suppress successful spans but retain failures as useful evidence.
    return !NON_RECURSIVE_DIAGNOSTIC_CHANNELS.has(channel)
      && channel !== IPC_CHANNELS.ASR_FEED;
  }

  #recordDiagnostic(input: Parameters<DiagnosticLogService['record']>[0]): void {
    try {
      this.#diagnostics.record(input);
    } catch {
      // Diagnostics are observational and never gate a product operation.
    }
  }

  #recordDiagnosticForGeneration(
    generation: number,
    input: Parameters<DiagnosticLogService['record']>[0],
  ): void {
    try {
      this.#diagnostics.recordIfGeneration(generation, input);
    } catch {
      // Diagnostics are observational and never gate a product operation.
    }
  }

  #recordDiagnosticError(
    component: Parameters<DiagnosticLogService['recordError']>[0]['component'],
    event: string,
    error: unknown,
    fields: Readonly<Record<string, unknown>> = {},
    correlation: DiagnosticCorrelation = {},
  ): void {
    try {
      this.#diagnostics.recordError({
        level: 'error',
        component,
        event,
        error,
        fields,
        ...correlation,
      });
    } catch {
      // Diagnostics are observational and never gate a product operation.
    }
  }

  #recordDiagnosticErrorForGeneration(
    generation: number,
    component: Parameters<DiagnosticLogService['recordError']>[0]['component'],
    event: string,
    error: unknown,
    fields: Readonly<Record<string, unknown>> = {},
    correlation: DiagnosticCorrelation = {},
  ): void {
    try {
      this.#diagnostics.recordErrorIfGeneration(generation, {
        level: 'error',
        component,
        event,
        error,
        fields,
        ...correlation,
      });
    } catch {
      // Diagnostics are observational and never gate a product operation.
    }
  }
}

interface DiagnosticCorrelation {
  readonly sessionId?: string;
  readonly attemptId?: string;
  readonly operationId?: string;
  readonly requestId?: string;
}

function getDiagnosticCorrelation(input: unknown): DiagnosticCorrelation {
  if (!input || typeof input !== 'object') return {};
  const record = input as Readonly<Record<string, unknown>>;
  return {
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    ...(typeof record.attemptId === 'string' ? { attemptId: record.attemptId } : {}),
    ...(typeof record.operationId === 'string' ? { operationId: record.operationId } : {}),
    ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
  };
}

function getDiagnosticInvocationFields(
  channel: IpcChannel,
  input: unknown,
): Readonly<Record<string, string>> {
  if (!input || typeof input !== 'object') return {};
  const record = input as Readonly<Record<string, unknown>>;
  if (channel === IPC_CHANNELS.ARTIFACTS_PUT && typeof record.type === 'string') {
    const payload = record.payload && typeof record.payload === 'object'
      ? record.payload as Readonly<Record<string, unknown>>
      : null;
    return {
      artifactType: record.type,
      ...(typeof payload?.status === 'string' ? { lifecycleStatus: payload.status } : {}),
    };
  }
  if (channel === IPC_CHANNELS.SESSIONS_CREATE && typeof record.modeId === 'string') {
    return { modeId: record.modeId };
  }
  if (channel === IPC_CHANNELS.SESSIONS_TRANSITION) {
    const transition = record.event && typeof record.event === 'object'
      ? record.event as Readonly<Record<string, unknown>>
      : null;
    return typeof transition?.type === 'string'
      ? { transitionType: transition.type }
      : {};
  }
  if (channel === IPC_CHANNELS.SESSIONS_UPDATE_RECORD && typeof record.action === 'string') {
    return {
      recordAction: record.action,
      ...(typeof record.pinned === 'boolean' ? { pinned: String(record.pinned) } : {}),
      ...(typeof record.title === 'string' ? { titleLength: String(record.title.length) } : {}),
    };
  }
  if (typeof record.purpose === 'string') return { purpose: record.purpose };
  return {};
}

class IpcSecurityError extends Error {
  constructor() {
    super('IPC sender is not trusted.');
    this.name = 'IpcSecurityError';
  }
}

function toRendererSafeError(error: unknown): Error {
  let code = 'INTERNAL_ERROR';
  if (error instanceof IpcSecurityError) {
    code = 'UNTRUSTED_SENDER';
  } else if (error instanceof z.ZodError) {
    code = 'INVALID_INPUT';
  } else if (
    error instanceof PracticeSessionServiceError ||
    error instanceof SessionRepositoryError ||
    error instanceof AudioRepositoryError ||
    error instanceof LocalAsrServiceError ||
    error instanceof LocalAsrModelInstallerError ||
    error instanceof CloudAiServiceError
  ) {
    code = error.code;
  } else if (
    error instanceof Error &&
    error.name === 'SessionTransitionError' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    code = error.code.toUpperCase();
  }

  const safeError = new Error(`PHRIO_${code}`);
  safeError.name = 'PhrioIpcError';
  return safeError;
}
