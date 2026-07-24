// @vitest-environment node

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { IpcController } from '../../src/backend/controllers/ipc-controller';
import type { TrustedRendererPolicy } from '../../src/backend/config/renderer-security';
import type { EnvironmentService } from '../../src/backend/services/environment-service';
import type { LocalAsrService } from '../../src/backend/services/local-asr-service';
import { LocalAsrModelInstallerError } from '../../src/backend/services/local-asr-model-installer';
import type { PracticeSessionService } from '../../src/backend/services/practice-session-service';
import type { DiagnosticLogService } from '../../src/backend/services/diagnostic-log-service';
import {
  CloudAiService,
  CloudAiServiceError,
} from '../../src/backend/services/cloud-ai-service';
import {
  APPROVED_AI_PROVIDER,
  CLEAR_TRAINING_DATA_CONFIRMATION,
  CloudAiConfigurationStatusSchema,
  CloudAiConsentStatusSchema,
  createPracticeSession,
  createQueuedCloudDeepDiagnosis,
  DIAGNOSTIC_MAX_TOTAL_BYTES,
  getModePack,
  getTaskTemplate,
  IPC_CHANNELS,
  IPC_CONTRACTS,
  LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
  LiveAiPolicySchema,
  SaveCloudAiKeyInputSchema,
  transitionSession,
  type DeepDiagnosisPayload,
} from '../../src/shared';

const deepPayload: DeepDiagnosisPayload = {
  schemaVersion: 'deep-diagnosis-1',
  purpose: 'deep_diagnosis',
  analysisInputId: 'analysis-ipc-authority',
  sessionId: 'session-ipc-authority',
  attemptId: 'attempt-ipc-authority',
  snapshotId: 'snapshot-ipc-authority',
  transcriptVersion: 1,
  task: {
    modeId: 'clear-expression',
    taskId: 'ipc-authority-task',
    taskVersion: '1.0.0',
    prompt: '说明本周决定。',
    audience: '产品团队',
    objective: '说明决定',
    background: '',
    sourceMaterial: '',
    counterArgument: '',
    roleContext: '',
    successConditions: ['先给结论'],
    rubric: [{
      criterionId: 'conclusion-first',
      label: '结论先行',
      description: '先说结论。',
    }],
    drills: [{
      drillId: 'conclusion-drill',
      criterionId: 'conclusion-first',
      title: '一句话结论',
      instruction: '先说结论。',
      template: '我建议……',
      successCondition: '首句给出建议。',
    }],
  },
  finalSegments: [{
    id: 'segment-ipc-authority',
    sequence: 0,
    revision: 1,
    startMs: 0,
    endMs: 2_000,
    text: '我建议冻结新增需求。',
  }],
  corrections: [],
  localEvidence: [],
  metrics: {
    words: 10,
    fillers: 0,
    hedges: 0,
    vagueWords: 0,
    repetitions: 0,
    selfCorrections: 0,
  },
};

const configurationStatus = {
  provider: APPROVED_AI_PROVIDER.id,
  providerName: APPROVED_AI_PROVIDER.name,
  model: APPROVED_AI_PROVIDER.model,
  endpoint: APPROVED_AI_PROVIDER.endpoint,
  protocolVersion: APPROVED_AI_PROVIDER.protocolVersion,
  configured: true,
  encryptionAvailable: true,
  keyStorage: 'system_encrypted',
  keyHint: '••••0000',
  retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
} as const;

describe('cloud AI IPC contracts', () => {
  it('adds only fixed-provider, schema-validated channels to the narrow bridge', () => {
    const cloudChannels = Object.values(IPC_CHANNELS).filter((channel) =>
      channel.startsWith('phrio:cloud-ai:'),
    );
    expect(cloudChannels).toHaveLength(12);
    expect(Object.values(IPC_CHANNELS)).toHaveLength(40);
    expect(Object.keys(IPC_CONTRACTS).sort()).toEqual(Object.values(IPC_CHANNELS).sort());
    expect(new Set(cloudChannels).size).toBe(cloudChannels.length);

    expect(SaveCloudAiKeyInputSchema.safeParse({
      apiKey: 'test-openai-valid-key-000000000000',
    }).success).toBe(true);
    expect(SaveCloudAiKeyInputSchema.safeParse({
      apiKey: 'test-openai-valid-key-000000000000',
      endpoint: 'https://attacker.example/v1/responses',
    }).success).toBe(false);
    expect(SaveCloudAiKeyInputSchema.safeParse({ apiKey: 'short' }).success).toBe(false);

    expect(CloudAiConfigurationStatusSchema.parse(configurationStatus)).toEqual(configurationStatus);
    expect(CloudAiConfigurationStatusSchema.parse({
      ...configurationStatus,
      encryptionAvailable: false,
      keyStorage: 'local_private_file_unencrypted',
    })).toMatchObject({
      configured: true,
      encryptionAvailable: false,
      keyStorage: 'local_private_file_unencrypted',
    });
    expect(CloudAiConfigurationStatusSchema.safeParse({
      ...configurationStatus,
      apiKey: 'must-never-cross-to-renderer',
    }).success).toBe(false);
  });

  it('keeps live consent configuration-level instead of binding it to one task value', () => {
    const policy = {
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
        'finalWindow.segmentRevisions',
      ],
      maximumWindowCharacters: 600,
      minimumNewFinalCharacters: 20,
      debounceMs: 600,
      cooldownMs: 2_000,
      maximumRequests: 8,
      timeoutMs: 8_000,
    } as const;
    expect(LiveAiPolicySchema.safeParse(policy).success).toBe(true);
    expect(LiveAiPolicySchema.safeParse({
      ...policy,
      task: { taskId: 'must-not-bind-configuration-consent' },
    }).success).toBe(false);
  });

  it('exposes only safe consent metadata for restart recovery', () => {
    const valid = {
      purpose: 'live_hint',
      active: true,
      consent: {
        id: 'consent-live',
        purpose: 'live_hint',
        scope: 'configuration',
        provider: APPROVED_AI_PROVIDER.id,
        model: APPROVED_AI_PROVIDER.model,
        endpoint: APPROVED_AI_PROVIDER.endpoint,
        payloadHash: null,
        policyHash: 'a'.repeat(64),
        schemaVersion: 'live-window-1',
        promptVersion: APPROVED_AI_PROVIDER.promptVersion,
        approvedFields: ['finalWindow.text'],
        approvedAt: '2026-07-18T08:00:00.000Z',
        expiresAt: null,
      },
    } as const;
    expect(CloudAiConsentStatusSchema.parse(valid)).toEqual(valid);
    expect(CloudAiConsentStatusSchema.safeParse({
      ...valid,
      consent: { ...valid.consent, payload: { transcript: 'must-not-cross' } },
    }).success).toBe(false);
    expect(CloudAiConsentStatusSchema.safeParse({
      purpose: 'live_hint',
      active: false,
      consent: valid.consent,
    }).success).toBe(false);
  });
});

describe('IpcController cloud AI boundary', () => {
  it('registers every contract, validates inputs, and strips service errors to codes', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: typeof handlers extends Map<string, infer H> ? H : never) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    let throwRateLimit = false;
    const saveApiKey = vi.fn().mockResolvedValue(configurationStatus);
    const assertCloudArtifactAttested = vi.fn();
    const executeDeepDiagnosis = vi.fn().mockResolvedValue({
      judgment: '结论清楚。',
      observations: [],
      focus: {
        criterionId: 'conclusion-first',
        label: '结论先行',
        reason: '先稳定结论。',
        drillId: 'conclusion-drill',
        drill: '我建议……',
      },
    });
    const openLiveAttemptLease = vi.fn();
    const setLiveAttemptAiState = vi.fn((input) => input);
    const releaseLiveAttemptLease = vi.fn();
    const releaseLiveAttemptGeneration = vi.fn();
    const cloudAi = {
      getConfigurationStatus: () => {
        if (throwRateLimit) throw new CloudAiServiceError('RATE_LIMITED');
        return configurationStatus;
      },
      saveApiKey,
      deleteApiKey: () => ({ ...configurationStatus, configured: false, keyHint: null }),
      getConsentStatus: () => ({ purpose: 'live_hint', active: false, consent: null }),
      prepareConsent: vi.fn(),
      approveConsent: vi.fn(),
      revokeConsent: vi.fn(),
      assertCloudArtifactAttested,
      executeLiveHint: vi.fn(),
      executeDeepDiagnosis,
      executeSemanticComparison: vi.fn(),
      cancelLiveHint: vi.fn(),
      openLiveAttemptLease,
      hasLiveAttemptLease: vi.fn(() => false),
      setLiveAttemptAiState,
      releaseLiveAttemptLease,
      releaseLiveAttemptGeneration,
      releaseLiveSessionLeases: vi.fn(),
      releaseAllLiveAttemptLeases: vi.fn(),
    } as unknown as CloudAiService;
    const putArtifact = vi.fn((artifact) => artifact);
    const listArtifacts = vi.fn(() => []);
    const task = getTaskTemplate('decision-alignment', 'freeze-new-requirements');
    if (!task) throw new Error('Expected the frozen requirements task fixture.');
    const createdSession = createPracticeSession({
      id: 'session-diagnostic-ipc',
      modeVersion: getModePack('decision-alignment').version,
      task,
      now: '2026-07-18T08:00:00.000Z',
    });
    const startedSession = transitionSession(
      createdSession,
      { type: 'start_practice' },
      '2026-07-18T08:00:01.000Z',
    );
    const createSession = vi.fn(() => createdSession);
    const transitionPracticeSession = vi.fn(() => startedSession);
    const assertCloudExecutionApproved = vi.fn();
    const practice = {
      createSession,
      transitionSession: transitionPracticeSession,
      putArtifact,
      listArtifacts,
      assertCloudExecutionApproved,
      getSession: vi.fn(() => ({ id: 'session-live-ipc', status: 'first_attempt' })),
    } as unknown as PracticeSessionService;
    const asr = {
      start: vi.fn(() => ({ modelVersion: 'test-asr-1' })),
      stop: vi.fn(() => null),
      feed: vi.fn(() => null),
    } as unknown as LocalAsrService;
    const frame = { url: 'phrio-app://renderer/index.html' };
    const sender = { mainFrame: frame };
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    const rendererPolicy = {
      isTrustedWebContents: () => true,
      isTrustedUrl: () => true,
    } as unknown as TrustedRendererPolicy;
    let diagnosticSequence = 0;
    const recordDiagnostic = vi.fn((_input?: unknown) => ({
      sequence: diagnosticSequence++,
      incidentId: null,
    }));
    const recordDiagnosticError = vi.fn((_input?: unknown) => ({
      sequence: diagnosticSequence++,
      incidentId: 'incident-test',
    }));
    const clearDiagnostics = vi.fn(() => ({
      deletedFileCount: 1,
      deletedBytes: 128,
    }));
    const diagnosticStatus = {
      appVersion: '0.1.0-test',
      currentRunId: 'run-test',
      logDirectory: '/tmp/phrio-test-diagnostics',
      retentionDays: 7,
      maximumTotalBytes: DIAGNOSTIC_MAX_TOTAL_BYTES,
      maximumBufferedEvents: 2_048,
      fileCount: 1,
      totalBytes: 128,
      bufferedEventCount: 0,
      droppedEventCount: 0,
      writeFailureCount: 0,
      latestIncidentId: null,
    } as const;
    const exportBundle = vi.fn((filePath: string) => ({
      cancelled: false,
      filePath,
      sourceFileCount: 1,
      eventCount: 4,
      byteLength: 1_024,
    }));
    const diagnostics = {
      generation: 0,
      record: recordDiagnostic,
      recordError: recordDiagnosticError,
      recordIfGeneration: vi.fn((
        _generation: number,
        input: Parameters<DiagnosticLogService['record']>[0],
      ) => recordDiagnostic(input)),
      recordErrorIfGeneration: vi.fn((
        _generation: number,
        input: Parameters<DiagnosticLogService['recordError']>[0],
      ) => recordDiagnosticError(input)),
      getStatus: vi.fn(() => diagnosticStatus),
      clear: clearDiagnostics,
      exportBundle,
    } as unknown as DiagnosticLogService;
    const clearTrainingData = vi.fn(() => {
      clearDiagnostics();
      return {
        trainingDataCleared: true,
        deletedTrainingRecordCount: 2,
        diagnosticLogs: {
          status: 'cleared',
          deletedFileCount: 1,
          deletedBytes: 512,
          remainingFileCount: 0,
          remainingBytes: 0,
        },
        modelsPreserved: true,
        externalExportsPreserved: true,
        otherUserDataPreserved: true,
      };
    });
    const installLocalAsrModel = vi.fn().mockResolvedValue({
      outcome: 'installed',
      downloadedArchiveBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      installedModelBytes: 240 * 1_024 * 1_024,
      completedAt: '2026-07-20T03:00:00.000Z',
      localAsr: {
        state: 'ready',
        ready: true,
        files: [
          { name: 'encoder.int8.onnx', exists: true, readable: true },
          { name: 'decoder.int8.onnx', exists: true, readable: true },
          { name: 'tokens.txt', exists: true, readable: true },
        ],
      },
    });
    const cancelLocalAsrModelInstallation = vi.fn(() => true);
    const getLocalAsrModelInstallStatus = vi.fn(() => ({
      stage: 'downloading' as const,
      downloadedBytes: 512,
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      cancellable: true,
      errorCode: null,
      updatedAt: '2026-07-20T03:00:00.000Z',
    }));
    const environment = {
      clearTrainingData,
      installLocalAsrModel,
      getLocalAsrModelInstallStatus,
      cancelLocalAsrModelInstallation,
    } as unknown as EnvironmentService;
    const chooseExportPath = vi.fn().mockResolvedValue('/tmp/phrio-diagnostics.json');
    const openDirectory = vi.fn().mockResolvedValue('');
    const controller = new IpcController(
      ipcMain,
      practice,
      asr,
      environment,
      cloudAi,
      rendererPolicy,
      diagnostics,
      { chooseExportPath, openDirectory },
    );
    controller.register();
    expect(handlers.size).toBe(40);

    await expect(handlers.get(IPC_CHANNELS.SESSIONS_CREATE)!(event, {
      modeId: 'decision-alignment',
      taskId: 'freeze-new-requirements',
      developmentFixture: false,
    })).resolves.toEqual(createdSession);
    await expect(handlers.get(IPC_CHANNELS.SESSIONS_TRANSITION)!(event, {
      sessionId: createdSession.id,
      event: { type: 'start_practice' },
    })).resolves.toEqual(startedSession);

    await expect(handlers.get(IPC_CHANNELS.DIAGNOSTICS_RECORD_EVENT)!(event, {
      level: 'info',
      component: 'renderer',
      event: 'renderer.test-event',
      fields: { screen: 'settings' },
    })).resolves.toMatchObject({ incidentId: null });
    expect(recordDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({
      event: 'renderer.test-event',
    }));
    await expect(handlers.get(IPC_CHANNELS.DIAGNOSTICS_GET_STATUS)!(event, {}))
      .resolves.toEqual(diagnosticStatus);
    await expect(handlers.get(IPC_CHANNELS.DIAGNOSTICS_OPEN_DIRECTORY)!(event, {}))
      .resolves.toEqual({ opened: true, errorCode: null });
    expect(openDirectory).toHaveBeenCalledWith(diagnosticStatus.logDirectory);
    openDirectory.mockResolvedValueOnce('native message with a private path');
    await expect(handlers.get(IPC_CHANNELS.DIAGNOSTICS_OPEN_DIRECTORY)!(event, {}))
      .resolves.toEqual({ opened: false, errorCode: 'SHELL_OPEN_FAILED' });
    expect(recordDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({
      event: 'diagnostics.directory-open-failed',
      fields: { errorCode: 'SHELL_OPEN_FAILED' },
    }));
    expect(JSON.stringify(recordDiagnostic.mock.calls)).not.toContain('private path');
    await expect(handlers.get(IPC_CHANNELS.DIAGNOSTICS_EXPORT_BUNDLE)!(event, {}))
      .resolves.toMatchObject({
        cancelled: false,
        filePath: '/tmp/phrio-diagnostics.json',
      });
    expect(exportBundle).toHaveBeenCalledWith('/tmp/phrio-diagnostics.json');
    await expect(handlers.get(IPC_CHANNELS.DIAGNOSTICS_CLEAR)!(event, {}))
      .resolves.toEqual({ deletedFileCount: 1, deletedBytes: 128 });

    const liveIdentity = {
      sessionId: 'session-live-ipc',
      attemptId: 'attempt-live-ipc',
      generation: 1,
    };
    await expect(handlers.get(IPC_CHANNELS.ASR_START)!(event, liveIdentity))
      .resolves.toEqual({ modelVersion: 'test-asr-1' });
    expect(openLiveAttemptLease).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ id: liveIdentity.sessionId }),
      attemptId: liveIdentity.attemptId,
      generation: liveIdentity.generation,
    }));
    await expect(handlers.get(IPC_CHANNELS.CLOUD_AI_SET_LIVE_ATTEMPT_STATE)!(event, {
      ...liveIdentity,
      enabled: true,
    })).resolves.toEqual({ ...liveIdentity, enabled: true });
    expect(setLiveAttemptAiState).toHaveBeenCalledWith({ ...liveIdentity, enabled: true });
    await expect(handlers.get(IPC_CHANNELS.ASR_STOP)!(event, {
      attemptId: liveIdentity.attemptId,
      generation: liveIdentity.generation,
    })).resolves.toBeNull();
    expect(releaseLiveAttemptGeneration).toHaveBeenCalledWith({
      attemptId: liveIdentity.attemptId,
      generation: liveIdentity.generation,
    });
    await expect(handlers.get(IPC_CHANNELS.ENVIRONMENT_INSTALL_ASR_MODEL)!(event, {}))
      .resolves.toMatchObject({ outcome: 'installed', localAsr: { ready: true } });
    expect(installLocalAsrModel).toHaveBeenCalledOnce();
    installLocalAsrModel.mockRejectedValueOnce(
      new LocalAsrModelInstallerError('ASR_MODEL_ARCHIVE_SIZE_MISMATCH'),
    );
    await expect(handlers.get(IPC_CHANNELS.ENVIRONMENT_INSTALL_ASR_MODEL)!(event, {}))
      .rejects.toMatchObject({
        name: 'PhrioIpcError',
        message: 'PHRIO_ASR_MODEL_ARCHIVE_SIZE_MISMATCH',
      });
    await expect(handlers.get(IPC_CHANNELS.ENVIRONMENT_CANCEL_ASR_MODEL_INSTALL)!(event, {}))
      .resolves.toEqual({ cancelled: true });
    expect(cancelLocalAsrModelInstallation).toHaveBeenCalledOnce();
    await expect(
      handlers.get(IPC_CHANNELS.ENVIRONMENT_GET_ASR_MODEL_INSTALL_STATUS)!(event, {}),
    ).resolves.toMatchObject({ stage: 'downloading', downloadedBytes: 512 });
    expect(getLocalAsrModelInstallStatus).toHaveBeenCalledOnce();

    await expect(handlers.get(IPC_CHANNELS.CLOUD_AI_SAVE_KEY)!(event, {
      apiKey: 'test-openai-valid-key-000000000000',
    })).resolves.toEqual(configurationStatus);
    expect(saveApiKey).toHaveBeenCalledWith({ apiKey: 'test-openai-valid-key-000000000000' });
    expect(JSON.stringify(recordDiagnostic.mock.calls)).not.toContain(
      'test-openai-valid-key-000000000000',
    );

    await expect(handlers.get(IPC_CHANNELS.CLOUD_AI_SAVE_KEY)!(event, {
      apiKey: 'test-openai-valid-key-000000000000',
      endpoint: 'https://attacker.example',
    })).rejects.toMatchObject({
      name: 'PhrioIpcError',
      message: 'PHRIO_INVALID_INPUT',
    });
    expect(saveApiKey).toHaveBeenCalledTimes(1);

    const queued = createQueuedCloudDeepDiagnosis({
      payload: deepPayload,
      payloadHash: 'a'.repeat(64),
      consentId: 'consent-ipc-authority',
      at: '2026-07-18T08:00:00.000Z',
    });
    const cloudArtifact = {
      type: 'cloud_deep_diagnosis' as const,
      sessionId: deepPayload.sessionId,
      id: 'cloud-deep-analysis-ipc-authority',
      payload: queued,
    };
    await expect(handlers.get(IPC_CHANNELS.ARTIFACTS_PUT)!(event, cloudArtifact))
      .resolves.toEqual(cloudArtifact);
    expect(assertCloudArtifactAttested).toHaveBeenCalledWith(cloudArtifact);
    expect(putArtifact).toHaveBeenCalledWith(cloudArtifact);
    await expect(handlers.get(IPC_CHANNELS.ARTIFACTS_LIST)!(event, {
      sessionId: deepPayload.sessionId,
    })).resolves.toEqual([]);
    expect(listArtifacts).toHaveBeenCalledWith(deepPayload.sessionId);

    const targetChannels = [
      IPC_CHANNELS.SESSIONS_CREATE,
      IPC_CHANNELS.SESSIONS_TRANSITION,
      IPC_CHANNELS.ARTIFACTS_PUT,
      IPC_CHANNELS.ARTIFACTS_LIST,
    ] as const;
    const diagnosticInputs = recordDiagnostic.mock.calls.map(([input]) => (
      input as Parameters<DiagnosticLogService['record']>[0]
    ));
    expect(diagnosticInputs.some((input) => (
      input.fields?.channel === IPC_CHANNELS.ENVIRONMENT_GET_ASR_MODEL_INSTALL_STATUS
      && (input.event === 'ipc.invoke-started' || input.event === 'ipc.invoke-completed')
    ))).toBe(false);
    const startOperationIds: string[] = [];
    for (const channel of targetChannels) {
      const spans = diagnosticInputs.filter((input) => input.fields?.channel === channel);
      const started = spans.find((input) => input.event === 'ipc.invoke-started');
      const completed = spans.find((input) => input.event === 'ipc.invoke-completed');
      expect(started?.operationId).toMatch(/^operation-/u);
      expect(completed?.operationId).toBe(started?.operationId);
      startOperationIds.push(started!.operationId!);
    }
    expect(new Set(startOperationIds).size).toBe(targetChannels.length);
    expect(diagnosticInputs).toContainEqual(expect.objectContaining({
      event: 'ipc.invoke-started',
      operationId: expect.stringMatching(/^operation-/u),
      fields: {
        channel: IPC_CHANNELS.ARTIFACTS_PUT,
        artifactType: 'cloud_deep_diagnosis',
        lifecycleStatus: 'queued',
      },
    }));
    expect(diagnosticInputs).toContainEqual(expect.objectContaining({
      event: 'ipc.invoke-started',
      fields: {
        channel: IPC_CHANNELS.SESSIONS_CREATE,
        modeId: 'decision-alignment',
      },
    }));
    expect(diagnosticInputs).toContainEqual(expect.objectContaining({
      event: 'ipc.invoke-started',
      sessionId: createdSession.id,
      fields: {
        channel: IPC_CHANNELS.SESSIONS_TRANSITION,
        transitionType: 'start_practice',
      },
    }));
    expect(JSON.stringify(diagnosticInputs)).not.toContain(deepPayload.finalSegments[0]!.text);
    expect(JSON.stringify(diagnosticInputs)).not.toContain(deepPayload.task.prompt);

    await expect(handlers.get(IPC_CHANNELS.CLOUD_AI_EXECUTE_DEEP_DIAGNOSIS)!(event, {
      payload: deepPayload,
      consentId: 'consent-ipc-authority',
    })).resolves.toMatchObject({ judgment: '结论清楚。' });
    expect(assertCloudExecutionApproved).toHaveBeenCalledWith(
      deepPayload,
      'consent-ipc-authority',
    );
    expect(executeDeepDiagnosis).toHaveBeenCalledOnce();

    recordDiagnostic.mockImplementationOnce(() => {
      throw new Error('diagnostic writer unavailable');
    });
    await expect(handlers.get(IPC_CHANNELS.CLOUD_AI_GET_CONFIGURATION)!(event, {}))
      .resolves.toEqual(configurationStatus);
    throwRateLimit = true;
    recordDiagnosticError.mockImplementationOnce(() => {
      throw new Error('diagnostic writer unavailable');
    });
    await expect(handlers.get(IPC_CHANNELS.CLOUD_AI_GET_CONFIGURATION)!(event, {}))
      .rejects.toMatchObject({
        name: 'PhrioIpcError',
        message: 'PHRIO_RATE_LIMITED',
      });

    const recordCountBeforeTrainingClear = recordDiagnostic.mock.calls.length;
    await expect(handlers.get(IPC_CHANNELS.DATA_CLEAR_TRAINING)!(event, {
      confirmation: CLEAR_TRAINING_DATA_CONFIRMATION,
    })).resolves.toMatchObject({ deletedTrainingRecordCount: 2 });
    expect(clearTrainingData).toHaveBeenCalledOnce();
    expect(recordDiagnostic).toHaveBeenCalledTimes(recordCountBeforeTrainingClear + 1);
    expect(recordDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({
      event: 'ipc.invoke-started',
      fields: { channel: IPC_CHANNELS.DATA_CLEAR_TRAINING },
    }));
    clearTrainingData.mockRejectedValueOnce(new Error('clear failed'));
    await expect(handlers.get(IPC_CHANNELS.DATA_CLEAR_TRAINING)!(event, {
      confirmation: CLEAR_TRAINING_DATA_CONFIRMATION,
    })).rejects.toMatchObject({
      name: 'PhrioIpcError',
      message: 'PHRIO_INTERNAL_ERROR',
    });
    expect(recordDiagnosticError).toHaveBeenLastCalledWith(expect.objectContaining({
      component: 'ipc',
      event: 'ipc.invoke-failed',
    }));
    controller.dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(40);
  });
});
