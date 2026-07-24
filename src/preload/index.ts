import { contextBridge, ipcRenderer } from 'electron';
import type { z } from 'zod';
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
  ClearDiagnosticLogsOutputSchema,
  DiagnosticStatusSchema,
  ExportDiagnosticBundleOutputSchema,
  OpenDiagnosticDirectoryOutputSchema,
  RecordDiagnosticEventInputSchema,
  RecordDiagnosticEventOutputSchema,
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
  GetCloudAiConfigurationInputSchema,
  GetCloudAiConfigurationOutputSchema,
  GetCloudAiConsentStatusInputSchema,
  GetCloudAiConsentStatusOutputSchema,
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
  PutArtifactInputSchema,
  PutArtifactOutputSchema,
  PrepareAiConsentInputSchema,
  PrepareAiConsentOutputSchema,
  ReadAttemptAudioInputSchema,
  ReadAttemptAudioOutputSchema,
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
  TransitionSessionInputSchema,
  TransitionSessionOutputSchema,
  UpdateSessionRecordInputSchema,
  UpdateSessionRecordOutputSchema,
  UpdateSettingsInputSchema,
  UpdateSettingsOutputSchema,
  type IpcChannel,
  type PhrioDesktopApi,
} from '../shared';

async function invoke<Input, Output>(
  channel: IpcChannel,
  inputSchema: z.ZodType<Input>,
  outputSchema: z.ZodType<Output>,
  rawInput: Input,
): Promise<Output> {
  const input = inputSchema.parse(rawInput);
  const output: unknown = await ipcRenderer.invoke(channel, input);
  return outputSchema.parse(output);
}

const phrioApi: PhrioDesktopApi = {
  getBootstrap: () =>
    invoke(
      IPC_CHANNELS.APP_GET_BOOTSTRAP,
      EmptyInputSchema,
      BootstrapDataSchema,
      {},
    ),
  createSession: (input) =>
    invoke(
      IPC_CHANNELS.SESSIONS_CREATE,
      CreateSessionInputSchema,
      CreateSessionOutputSchema,
      input,
    ),
  getSession: (input) =>
    invoke(
      IPC_CHANNELS.SESSIONS_GET,
      GetSessionInputSchema,
      GetSessionOutputSchema,
      input,
    ),
  listSessions: (input = {}) =>
    invoke(
      IPC_CHANNELS.SESSIONS_LIST,
      ListSessionsInputSchema,
      ListSessionsOutputSchema,
      input,
    ),
  transitionSession: (input) =>
    invoke(
      IPC_CHANNELS.SESSIONS_TRANSITION,
      TransitionSessionInputSchema,
      TransitionSessionOutputSchema,
      input,
    ),
  updateSessionRecord: (input) =>
    invoke(
      IPC_CHANNELS.SESSIONS_UPDATE_RECORD,
      UpdateSessionRecordInputSchema,
      UpdateSessionRecordOutputSchema,
      input,
    ),
  deleteSession: (input) =>
    invoke(
      IPC_CHANNELS.SESSIONS_DELETE,
      DeleteSessionInputSchema,
      DeleteSessionOutputSchema,
      input,
    ),
  saveAttemptAudio: (input) =>
    invoke(
      IPC_CHANNELS.ATTEMPTS_SAVE_AUDIO,
      SaveAttemptAudioInputSchema,
      SaveAttemptAudioOutputSchema,
      input,
    ),
  readAttemptAudio: (input) =>
    invoke(
      IPC_CHANNELS.ATTEMPTS_READ_AUDIO,
      ReadAttemptAudioInputSchema,
      ReadAttemptAudioOutputSchema,
      input,
    ),
  discardAttemptAudio: (input) =>
    invoke(
      IPC_CHANNELS.ATTEMPTS_DISCARD,
      DiscardAttemptAudioInputSchema,
      DiscardAttemptAudioOutputSchema,
      input,
    ),
  getSettings: () =>
    invoke(
      IPC_CHANNELS.SETTINGS_GET,
      EmptyInputSchema,
      GetSettingsOutputSchema,
      {},
    ),
  updateSettings: (input) =>
    invoke(
      IPC_CHANNELS.SETTINGS_UPDATE,
      UpdateSettingsInputSchema,
      UpdateSettingsOutputSchema,
      input,
    ),
  startAsr: (input) =>
    invoke(IPC_CHANNELS.ASR_START, StartAsrInputSchema, StartAsrOutputSchema, input),
  feedAsr: (input) =>
    invoke(IPC_CHANNELS.ASR_FEED, FeedAsrInputSchema, FeedAsrOutputSchema, input),
  stopAsr: (input) =>
    invoke(IPC_CHANNELS.ASR_STOP, StopAsrInputSchema, StopAsrOutputSchema, input),
  putArtifact: (input) =>
    invoke(IPC_CHANNELS.ARTIFACTS_PUT, PutArtifactInputSchema, PutArtifactOutputSchema, input),
  listArtifacts: (input) =>
    invoke(IPC_CHANNELS.ARTIFACTS_LIST, ListArtifactsInputSchema, ListArtifactsOutputSchema, input),
  getEnvironmentStatus: () =>
    invoke(
      IPC_CHANNELS.ENVIRONMENT_GET_STATUS,
      EmptyInputSchema,
      GetEnvironmentStatusOutputSchema,
      {},
    ),
  installLocalAsrModel: () =>
    invoke(
      IPC_CHANNELS.ENVIRONMENT_INSTALL_ASR_MODEL,
      InstallLocalAsrModelInputSchema,
      InstallLocalAsrModelOutputSchema,
      {},
    ),
  getLocalAsrModelInstallStatus: () =>
    invoke(
      IPC_CHANNELS.ENVIRONMENT_GET_ASR_MODEL_INSTALL_STATUS,
      GetLocalAsrModelInstallStatusInputSchema,
      GetLocalAsrModelInstallStatusOutputSchema,
      {},
    ),
  cancelLocalAsrModelInstall: () =>
    invoke(
      IPC_CHANNELS.ENVIRONMENT_CANCEL_ASR_MODEL_INSTALL,
      CancelLocalAsrModelInstallInputSchema,
      CancelLocalAsrModelInstallOutputSchema,
      {},
    ),
  clearTrainingData: (input) =>
    invoke(
      IPC_CHANNELS.DATA_CLEAR_TRAINING,
      ClearTrainingDataInputSchema,
      ClearTrainingDataOutputSchema,
      input,
    ),
  resetNonSensitiveSettings: (input) =>
    invoke(
      IPC_CHANNELS.SETTINGS_RESET_NONSENSITIVE,
      ResetNonSensitiveSettingsInputSchema,
      ResetNonSensitiveSettingsOutputSchema,
      input,
    ),
  recordDiagnosticEvent: (input) =>
    invoke(
      IPC_CHANNELS.DIAGNOSTICS_RECORD_EVENT,
      RecordDiagnosticEventInputSchema,
      RecordDiagnosticEventOutputSchema,
      input,
    ),
  getDiagnosticStatus: () =>
    invoke(
      IPC_CHANNELS.DIAGNOSTICS_GET_STATUS,
      EmptyInputSchema,
      DiagnosticStatusSchema,
      {},
    ),
  openDiagnosticDirectory: () =>
    invoke(
      IPC_CHANNELS.DIAGNOSTICS_OPEN_DIRECTORY,
      EmptyInputSchema,
      OpenDiagnosticDirectoryOutputSchema,
      {},
    ),
  exportDiagnosticBundle: () =>
    invoke(
      IPC_CHANNELS.DIAGNOSTICS_EXPORT_BUNDLE,
      EmptyInputSchema,
      ExportDiagnosticBundleOutputSchema,
      {},
    ),
  clearDiagnosticLogs: () =>
    invoke(
      IPC_CHANNELS.DIAGNOSTICS_CLEAR,
      EmptyInputSchema,
      ClearDiagnosticLogsOutputSchema,
      {},
    ),
  getCloudAiConfiguration: () =>
    invoke(
      IPC_CHANNELS.CLOUD_AI_GET_CONFIGURATION,
      GetCloudAiConfigurationInputSchema,
      GetCloudAiConfigurationOutputSchema,
      {},
    ),
  saveCloudAiKey: (input) =>
    invoke(
      IPC_CHANNELS.CLOUD_AI_SAVE_KEY,
      SaveCloudAiKeyInputSchema,
      SaveCloudAiKeyOutputSchema,
      input,
    ),
  deleteCloudAiKey: () =>
    invoke(
      IPC_CHANNELS.CLOUD_AI_DELETE_KEY,
      DeleteCloudAiKeyInputSchema,
      DeleteCloudAiKeyOutputSchema,
      {},
    ),
  getCloudAiConsentStatus: (input) =>
    invoke(
      IPC_CHANNELS.CLOUD_AI_GET_CONSENT_STATUS,
      GetCloudAiConsentStatusInputSchema,
      GetCloudAiConsentStatusOutputSchema,
      input,
    ),
  prepareAiConsent: (input) =>
    invoke(
      IPC_CHANNELS.CLOUD_AI_PREPARE_CONSENT,
      PrepareAiConsentInputSchema,
      PrepareAiConsentOutputSchema,
      input,
    ),
  approveAiConsent: (input) =>
    invoke(
      IPC_CHANNELS.CLOUD_AI_APPROVE_CONSENT,
      ApproveAiConsentInputSchema,
      ApproveAiConsentOutputSchema,
      input,
    ),
  revokeAiConsent: (input) =>
    invoke(
      IPC_CHANNELS.CLOUD_AI_REVOKE_CONSENT,
      RevokeAiConsentInputSchema,
      RevokeAiConsentOutputSchema,
      input,
    ),
  setLiveAttemptAiState: (input) =>
    invoke(
      IPC_CHANNELS.CLOUD_AI_SET_LIVE_ATTEMPT_STATE,
      SetLiveAttemptAiStateInputSchema,
      SetLiveAttemptAiStateOutputSchema,
      input,
    ),
  executeLiveHint: (input) =>
    invoke(
      IPC_CHANNELS.CLOUD_AI_EXECUTE_LIVE_HINT,
      ExecuteLiveHintInputSchema,
      ExecuteLiveHintOutputSchema,
      input,
    ),
  executeDeepDiagnosis: (input) =>
    invoke(
      IPC_CHANNELS.CLOUD_AI_EXECUTE_DEEP_DIAGNOSIS,
      ExecuteDeepDiagnosisInputSchema,
      ExecuteDeepDiagnosisOutputSchema,
      input,
    ),
  executeSemanticComparison: (input) =>
    invoke(
      IPC_CHANNELS.CLOUD_AI_EXECUTE_COMPARISON,
      ExecuteSemanticComparisonInputSchema,
      ExecuteSemanticComparisonOutputSchema,
      input,
    ),
  cancelLiveHint: (input) =>
    invoke(
      IPC_CHANNELS.CLOUD_AI_CANCEL_LIVE_HINT,
      CancelLiveHintInputSchema,
      CancelLiveHintOutputSchema,
      input,
    ),
};

Object.freeze(phrioApi);

contextBridge.exposeInMainWorld('phrio', phrioApi);

export { phrioApi };
