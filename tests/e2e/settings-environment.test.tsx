import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsPage } from '../../src/frontend/pages/settings-page';
import {
  APPROVED_AI_PROVIDER,
  APPROVED_LIVE_AI_POLICY,
  DEFAULT_APP_SETTINGS,
  LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
  type PhrioDesktopApi,
} from '../../src/shared';

const environmentStatus = {
  checkedAt: '2026-07-18T04:00:00.000Z',
  dataDirectory: '/private/phrio-data',
  trainingRecordCount: 3,
  localAsr: {
    ready: true,
    files: [
      { name: 'encoder.int8.onnx' as const, exists: true, readable: true },
      { name: 'decoder.int8.onnx' as const, exists: true, readable: true },
      { name: 'tokens.txt' as const, exists: true, readable: true },
    ],
  },
};

function installBridge(overrides: Record<string, unknown> = {}) {
  const cloudConfiguration = {
    provider: 'openai' as const,
    providerName: 'OpenAI' as const,
    model: APPROVED_AI_PROVIDER.model,
    endpoint: APPROVED_AI_PROVIDER.endpoint,
    protocolVersion: APPROVED_AI_PROVIDER.protocolVersion,
    configured: false,
    encryptionAvailable: true,
    keyStorage: 'system_encrypted' as const,
    keyHint: null,
    retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
  };
  const bridge = {
    getEnvironmentStatus: vi.fn().mockResolvedValue(environmentStatus),
    installLocalAsrModel: vi.fn().mockResolvedValue({
      outcome: 'already_installed',
      downloadedArchiveBytes: 0,
      installedModelBytes: 240 * 1_024 * 1_024,
      completedAt: '2026-07-20T03:00:00.000Z',
      localAsr: environmentStatus.localAsr,
    }),
    getLocalAsrModelInstallStatus: vi.fn().mockResolvedValue({
      stage: 'idle',
      downloadedBytes: 0,
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      cancellable: false,
      errorCode: null,
      updatedAt: '2026-07-20T03:00:00.000Z',
    }),
    cancelLocalAsrModelInstall: vi.fn().mockResolvedValue({ cancelled: false }),
    clearTrainingData: vi.fn().mockResolvedValue({
      trainingDataCleared: true,
      deletedTrainingRecordCount: 3,
      diagnosticLogs: {
        status: 'cleared',
        deletedFileCount: 2,
        deletedBytes: 1_024,
        remainingFileCount: 0,
        remainingBytes: 0,
      },
      modelsPreserved: true,
      externalExportsPreserved: true,
      otherUserDataPreserved: true,
    }),
    resetNonSensitiveSettings: vi.fn().mockResolvedValue({
      ...DEFAULT_APP_SETTINGS,
      onboardingCompleted: true,
    }),
    getSettings: vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS),
    updateSettings: vi.fn().mockImplementation(async (patch) => ({
      ...DEFAULT_APP_SETTINGS,
      ...patch,
    })),
    getCloudAiConfiguration: vi.fn().mockResolvedValue(cloudConfiguration),
    saveCloudAiKey: vi.fn().mockResolvedValue({
      ...cloudConfiguration,
      configured: true,
      keyHint: '••••test',
    }),
    deleteCloudAiKey: vi.fn().mockResolvedValue(cloudConfiguration),
    getCloudAiConsentStatus: vi.fn().mockResolvedValue({
      purpose: 'live_hint',
      active: false,
      consent: null,
    }),
    recordDiagnosticEvent: vi.fn().mockResolvedValue({ recorded: true }),
    ...overrides,
  } as unknown as PhrioDesktopApi;
  Object.defineProperty(window, 'phrio', {
    configurable: true,
    value: bridge,
  });
  return bridge;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'phrio', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
});

describe('settings environment and data governance', () => {
  it('does not request microphone access on load, stops test tracks, and requires two clear clicks', async () => {
    const bridge = installBridge();
    const onTrainingDataCleared = vi.fn();
    const stop = vi.fn();
    const track = { kind: 'audio', readyState: 'live', enabled: true, stop };
    const getUserMedia = vi.fn().mockResolvedValue({
      getAudioTracks: () => [track],
      getTracks: () => [track],
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });

    render(<SettingsPage onTrainingDataCleared={onTrainingDataCleared} />);

    expect(await screen.findByText('/private/phrio-data')).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '检查麦克风' }));
    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(screen.getByText('权限已允许；轨道正常；PCM 信号未能验证')).toBeInTheDocument();
    await waitFor(() => expect(bridge.recordDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'recording',
        event: 'recording.microphone_check_completed',
        fields: expect.objectContaining({
          permission: 'allowed',
          track: 'active',
          signal: 'unavailable',
          transport: 'unavailable',
          pcmCallbackCount: 0,
        }),
      }),
    ));

    fireEvent.click(screen.getByRole('button', { name: '清除全部训练数据' }));
    expect(bridge.clearTrainingData).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认永久清除' }));
    await waitFor(() => expect(bridge.clearTrainingData).toHaveBeenCalledOnce());
    expect(onTrainingDataCleared).toHaveBeenCalledOnce();
    expect(await screen.findByText('已清除 3 条训练记录、关联音频和诊断日志。')).toBeInTheDocument();
  });

  it('keeps diagnostic residue visible and retryable after training records were deleted', async () => {
    const clearTrainingData = vi.fn()
      .mockResolvedValueOnce({
        trainingDataCleared: true,
        deletedTrainingRecordCount: 3,
        diagnosticLogs: {
          status: 'retry_required',
          deletedFileCount: 1,
          deletedBytes: 512,
          remainingFileCount: 1,
          remainingBytes: 512,
        },
        modelsPreserved: true,
        externalExportsPreserved: true,
        otherUserDataPreserved: true,
      })
      .mockResolvedValueOnce({
        trainingDataCleared: true,
        deletedTrainingRecordCount: 0,
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
      });
    const onTrainingDataCleared = vi.fn();
    installBridge({ clearTrainingData });
    render(<SettingsPage onTrainingDataCleared={onTrainingDataCleared} />);
    await screen.findByText('/private/phrio-data');

    fireEvent.click(screen.getByRole('button', { name: '清除全部训练数据' }));
    fireEvent.click(screen.getByRole('button', { name: '确认永久清除' }));

    expect(await screen.findByText(
      '已清除 3 条训练记录及关联音频，但仍有 1 个诊断日志文件未删除。请重试永久清除。',
    )).toBeInTheDocument();
    expect(onTrainingDataCleared).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '重试永久清除' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '重试永久清除' }));
    expect(await screen.findByText('训练数据、关联音频和诊断日志已全部清除。')).toBeInTheDocument();
    expect(clearTrainingData).toHaveBeenCalledTimes(2);
  });

  it('requires a separate confirmation before deleting the local API Key', async () => {
    const configuration = {
      provider: 'openai' as const,
      providerName: 'OpenAI' as const,
      model: APPROVED_AI_PROVIDER.model,
      endpoint: APPROVED_AI_PROVIDER.endpoint,
      protocolVersion: APPROVED_AI_PROVIDER.protocolVersion,
      configured: true,
      encryptionAvailable: true,
      keyStorage: 'system_encrypted' as const,
      keyHint: '••••test',
      retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
    };
    const deleteCloudAiKey = vi.fn().mockResolvedValue({
      ...configuration,
      configured: false,
      keyHint: null,
    });
    installBridge({
      getCloudAiConfiguration: vi.fn().mockResolvedValue(configuration),
      deleteCloudAiKey,
    });

    render(<SettingsPage />);
    expect(await screen.findByText(/已配置.*test/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除 Key' }));
    expect(deleteCloudAiKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认删除 Key' }));
    await waitFor(() => expect(deleteCloudAiKey).toHaveBeenCalledOnce());
    expect(await screen.findByText('API Key 已从本机密钥存储删除。')).toBeInTheDocument();
  });

  it('keeps API Key input and save usable through the disclosed private-file fallback', async () => {
    const fallbackConfiguration = {
      provider: 'openai' as const,
      providerName: 'OpenAI' as const,
      model: APPROVED_AI_PROVIDER.model,
      endpoint: APPROVED_AI_PROVIDER.endpoint,
      protocolVersion: APPROVED_AI_PROVIDER.protocolVersion,
      configured: false,
      encryptionAvailable: false,
      keyStorage: 'local_private_file_unencrypted' as const,
      keyHint: null,
      retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
    };
    const saveCloudAiKey = vi.fn().mockResolvedValue({
      ...fallbackConfiguration,
      configured: true,
      keyHint: '••••7890',
    });
    installBridge({
      getCloudAiConfiguration: vi.fn().mockResolvedValue(fallbackConfiguration),
      saveCloudAiKey,
    });

    render(<SettingsPage />);

    expect(await screen.findByText('本机私有文件（未加密）', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText(/为避免系统钥匙串阻塞整个应用/)).toBeInTheDocument();
    const input = screen.getByLabelText('OpenAI API Key');
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute('placeholder', '写入本机私有文件（未加密）');
    fireEvent.change(input, { target: { value: 'test-openai-fallback-key-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 Key' }));

    await waitFor(() => expect(saveCloudAiKey).toHaveBeenCalledWith({
      apiKey: 'test-openai-fallback-key-1234567890',
    }));
    expect(await screen.findByText(/API Key 已写入本机私有文件（未加密，权限 0600）/)).toBeInTheDocument();
  });

  it('installs a missing local transcription model with visible size, wait, and retry-safe status', async () => {
    const missingEnvironment = {
      ...environmentStatus,
      localAsr: {
        ready: false,
        files: environmentStatus.localAsr.files.map((file) => ({
          ...file,
          exists: false,
          readable: false,
        })),
      },
    };
    let finishInstall!: (value: unknown) => void;
    const installation = new Promise((resolve) => {
      finishInstall = resolve;
    });
    const getEnvironmentStatus = vi.fn()
      .mockResolvedValueOnce(missingEnvironment)
      .mockResolvedValue(environmentStatus);
    const installLocalAsrModel = vi.fn(() => installation);
    installBridge({
      getEnvironmentStatus,
      installLocalAsrModel,
      getLocalAsrModelInstallStatus: vi.fn()
        .mockResolvedValueOnce({
          stage: 'idle',
          downloadedBytes: 0,
          expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
          cancellable: false,
          errorCode: null,
          updatedAt: '2026-07-20T03:00:00.000Z',
        })
        .mockResolvedValue({
          stage: 'downloading',
          downloadedBytes: 100 * 1_024 * 1_024,
          expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
          cancellable: true,
          errorCode: null,
          updatedAt: '2026-07-20T03:00:00.000Z',
        }),
    });

    render(<SettingsPage />);
    expect(await screen.findByText('模型未就绪')).toBeInTheDocument();
    expect(screen.getByText(/三个.*运行文件.*约 226 MB.*SHA-256.*普通超时或断网.*约 1 GB.*GitHub 备用整包/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '一键安装本地转写模型' }));
    expect(await screen.findByText(/正在下载转写模型.*100\.0.*MB.*10%/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '正在下载并安装…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消安装' })).toBeEnabled();

    finishInstall({
      outcome: 'installed',
      downloadedArchiveBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      installedModelBytes: 240 * 1_024 * 1_024,
      completedAt: '2026-07-20T03:00:00.000Z',
      localAsr: environmentStatus.localAsr,
    });
    expect(await screen.findByText(/本地转写模型安装完成/)).toBeInTheDocument();
    expect(await screen.findByText('模型完整且可读')).toBeInTheDocument();
    expect(installLocalAsrModel).toHaveBeenCalledOnce();
    expect(getEnvironmentStatus).toHaveBeenCalledTimes(2);
  });

  it('explains that a transient three-file failure keeps its checkpoint without starting 1 GB', async () => {
    const missingEnvironment = {
      ...environmentStatus,
      localAsr: {
        ready: false,
        files: environmentStatus.localAsr.files.map((file) => ({
          ...file,
          exists: false,
          readable: false,
        })),
      },
    };
    installBridge({
      getEnvironmentStatus: vi.fn().mockResolvedValue(missingEnvironment),
      installLocalAsrModel: vi.fn().mockRejectedValue(
        new Error('ASR_MODEL_DIRECT_DOWNLOAD_FAILED'),
      ),
    });

    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '一键安装本地转写模型' }));

    expect(await screen.findByText(
      '三文件下载暂时中断；已完成的约 226 MB 断点保留在本机，不会自动改下约 1 GB 整包。恢复网络后点击继续安装。',
    )).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: '重试安装本地转写模型' })).toBeEnabled();
  });

  it('cancels a running model installation and keeps the install action retryable', async () => {
    const missingEnvironment = {
      ...environmentStatus,
      localAsr: {
        ready: false,
        files: environmentStatus.localAsr.files.map((file) => ({
          ...file,
          exists: false,
          readable: false,
        })),
      },
    };
    let rejectInstall!: (error: Error) => void;
    let cancellationCompleted = false;
    let statusReadCount = 0;
    const installLocalAsrModel = vi.fn(() => new Promise((_resolve, reject) => {
      rejectInstall = reject;
    }));
    const cancelLocalAsrModelInstall = vi.fn(async () => {
      rejectInstall(new Error('PHRIO_ASR_MODEL_INSTALL_CANCELLED'));
      cancellationCompleted = true;
      return { cancelled: true };
    });
    const getLocalAsrModelInstallStatus = vi.fn(async () => {
      if (cancellationCompleted) {
        return {
          stage: 'cancelled' as const,
          downloadedBytes: 0,
          expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
          cancellable: false,
          errorCode: 'ASR_MODEL_INSTALL_CANCELLED',
          updatedAt: '2026-07-20T03:01:00.000Z',
        };
      }
      if (statusReadCount++ === 0) {
        return {
          stage: 'idle' as const,
          downloadedBytes: 0,
          expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
          cancellable: false,
          errorCode: null,
          updatedAt: '2026-07-20T03:00:00.000Z',
        };
      }
      return {
        stage: 'downloading' as const,
        downloadedBytes: 100 * 1_024 * 1_024,
        expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
        cancellable: true,
        errorCode: null,
        updatedAt: '2026-07-20T03:00:00.000Z',
      };
    });
    installBridge({
      getEnvironmentStatus: vi.fn().mockResolvedValue(missingEnvironment),
      installLocalAsrModel,
      cancelLocalAsrModelInstall,
      getLocalAsrModelInstallStatus,
    });

    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '一键安装本地转写模型' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消安装' }));

    expect(await screen.findByText(/模型安装已取消.*临时下载已清理/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一键安装本地转写模型' })).toBeEnabled();
    expect(cancelLocalAsrModelInstall).toHaveBeenCalledOnce();
  });

  it('restores a resumable model checkpoint after reopening settings', async () => {
    const missingEnvironment = {
      ...environmentStatus,
      localAsr: {
        ready: false,
        files: environmentStatus.localAsr.files.map((file) => ({
          ...file,
          exists: false,
          readable: false,
        })),
      },
    };
    const installLocalAsrModel = vi.fn().mockResolvedValue({
      outcome: 'installed',
      downloadedArchiveBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      installedModelBytes: 240 * 1_024 * 1_024,
      completedAt: '2026-07-20T03:00:00.000Z',
      localAsr: environmentStatus.localAsr,
    });
    installBridge({
      getEnvironmentStatus: vi.fn()
        .mockResolvedValueOnce(missingEnvironment)
        .mockResolvedValue(environmentStatus),
      installLocalAsrModel,
      getLocalAsrModelInstallStatus: vi.fn().mockResolvedValue({
        stage: 'paused',
        downloadedBytes: 250 * 1_024 * 1_024,
        expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
        cancellable: true,
        errorCode: null,
        updatedAt: '2026-07-20T03:00:00.000Z',
      }),
    });

    render(<SettingsPage />);

    expect(await screen.findByText(/已保留下载进度.*250\.0.*MB.*25%/)).toBeInTheDocument();
    const resume = screen.getByRole('button', { name: '继续安装本地转写模型' });
    expect(resume).toBeEnabled();
    expect(screen.getByRole('button', { name: '删除已下载进度' })).toBeEnabled();
    fireEvent.click(resume);
    await waitFor(() => expect(installLocalAsrModel).toHaveBeenCalledOnce());
  });

  it('lets the user explicitly discard a paused model checkpoint', async () => {
    const missingEnvironment = {
      ...environmentStatus,
      localAsr: {
        ready: false,
        files: environmentStatus.localAsr.files.map((file) => ({
          ...file,
          exists: false,
          readable: false,
        })),
      },
    };
    const paused = {
      stage: 'paused' as const,
      downloadedBytes: 250 * 1_024 * 1_024,
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      cancellable: true,
      errorCode: null,
      updatedAt: '2026-07-20T03:00:00.000Z',
    };
    const cancelled = {
      ...paused,
      stage: 'cancelled' as const,
      downloadedBytes: 0,
      cancellable: false,
      errorCode: 'ASR_MODEL_INSTALL_CANCELLED',
    };
    const cancelLocalAsrModelInstall = vi.fn().mockResolvedValue({ cancelled: true });
    installBridge({
      getEnvironmentStatus: vi.fn().mockResolvedValue(missingEnvironment),
      getLocalAsrModelInstallStatus: vi.fn()
        .mockResolvedValueOnce(paused)
        .mockResolvedValue(cancelled),
      cancelLocalAsrModelInstall,
    });

    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '删除已下载进度' }));

    await waitFor(() => expect(cancelLocalAsrModelInstall).toHaveBeenCalledOnce());
    expect(await screen.findByText(/模型安装已取消.*临时下载已清理/)).toBeInTheDocument();
  });

  it('cancels an active model install attached from another page without a local Promise', async () => {
    const missingEnvironment = {
      ...environmentStatus,
      localAsr: {
        ready: false,
        files: environmentStatus.localAsr.files.map((file) => ({
          ...file,
          exists: false,
          readable: false,
        })),
      },
    };
    let cancellationRequested = false;
    let postCancelReads = 0;
    const cancelLocalAsrModelInstall = vi.fn(async () => {
      cancellationRequested = true;
      return { cancelled: true };
    });
    const getLocalAsrModelInstallStatus = vi.fn(async () => {
      if (!cancellationRequested) {
        return {
          stage: 'downloading' as const,
          downloadedBytes: 80 * 1_024 * 1_024,
          expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
          cancellable: true,
          errorCode: null,
          updatedAt: '2026-07-20T03:00:00.000Z',
        };
      }
      if (postCancelReads++ === 0) {
        return {
          stage: 'cancelling' as const,
          downloadedBytes: 80 * 1_024 * 1_024,
          expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
          cancellable: false,
          errorCode: null,
          updatedAt: '2026-07-20T03:01:00.000Z',
        };
      }
      return {
        stage: 'cancelled' as const,
        downloadedBytes: 0,
        expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
        cancellable: false,
        errorCode: 'ASR_MODEL_INSTALL_CANCELLED',
        updatedAt: '2026-07-20T03:01:01.000Z',
      };
    });
    const installLocalAsrModel = vi.fn();
    installBridge({
      getEnvironmentStatus: vi.fn().mockResolvedValue(missingEnvironment),
      getLocalAsrModelInstallStatus,
      cancelLocalAsrModelInstall,
      installLocalAsrModel,
    });

    render(<SettingsPage />);
    expect(await screen.findByText(/正在下载转写模型.*80\.0.*MB.*8%/u))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消安装' }));

    expect(await screen.findByText(/模型安装已取消.*临时下载已清理/u, {}, {
      timeout: 2_000,
    })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一键安装本地转写模型' })).toBeEnabled();
    expect(installLocalAsrModel).not.toHaveBeenCalled();
  });

  it('exposes explicit retries for environment, clear, and preference failures', async () => {
    const getEnvironmentStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('first environment failure'))
      .mockResolvedValue(environmentStatus);
    const clearTrainingData = vi
      .fn()
      .mockRejectedValueOnce(new Error('first clear failure'))
      .mockResolvedValue({
        trainingDataCleared: true,
        deletedTrainingRecordCount: 3,
        diagnosticLogs: {
          status: 'cleared',
          deletedFileCount: 2,
          deletedBytes: 1_024,
          remainingFileCount: 0,
          remainingBytes: 0,
        },
        modelsPreserved: true,
        externalExportsPreserved: true,
        otherUserDataPreserved: true,
      });
    const resetNonSensitiveSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error('first reset failure'))
      .mockResolvedValue(DEFAULT_APP_SETTINGS);
    installBridge({
      getEnvironmentStatus,
      clearTrainingData,
      resetNonSensitiveSettings,
    });

    render(<SettingsPage />);

    expect(await screen.findByText('本地环境检查失败，请重试。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试环境检查' }));
    expect(await screen.findByText('/private/phrio-data')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '清除全部训练数据' }));
    fireEvent.click(screen.getByRole('button', { name: '确认永久清除' }));
    expect(await screen.findByText('训练数据清除失败，请重试。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试永久清除' }));
    expect(await screen.findByText('已清除 3 条训练记录、关联音频和诊断日志。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '恢复默认偏好' }));
    expect(resetNonSensitiveSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认恢复默认偏好' }));
    expect(await screen.findByText('偏好重置失败，请重试。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试恢复默认偏好' }));
    expect(
      await screen.findByText(/非敏感偏好已恢复默认值并立即生效，AI 同意与请求审计已清除/),
    ).toBeInTheDocument();
  });

  it('stores the key securely and requires a visible configuration consent before enabling live hints', async () => {
    const prepared = {
      preparationId: 'preparation-live-1',
      purpose: 'live_hint' as const,
      scope: 'configuration' as const,
      provider: 'openai' as const,
      model: APPROVED_AI_PROVIDER.model,
      endpoint: APPROVED_AI_PROVIDER.endpoint,
      payloadHash: null,
      policyHash: 'a'.repeat(64),
      schemaVersion: APPROVED_LIVE_AI_POLICY.policyVersion,
      promptVersion: APPROVED_AI_PROVIDER.promptVersion,
      approvedFields: [...APPROVED_LIVE_AI_POLICY.sentFieldPaths],
      previewJson: JSON.stringify(APPROVED_LIVE_AI_POLICY),
      retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
      preparedAt: '2026-07-18T04:00:00.000Z',
    };
    const consent = {
      id: 'consent-live-1',
      purpose: 'live_hint' as const,
      scope: 'configuration' as const,
      sessionId: null,
      provider: 'openai' as const,
      model: APPROVED_AI_PROVIDER.model,
      endpoint: APPROVED_AI_PROVIDER.endpoint,
      payloadHash: null,
      policyHash: prepared.policyHash,
      schemaVersion: prepared.schemaVersion,
      promptVersion: APPROVED_AI_PROVIDER.promptVersion,
      approvedFields: prepared.approvedFields,
      approvedAt: '2026-07-18T04:01:00.000Z',
      expiresAt: null,
      revokedAt: null,
    };
    const getCloudAiConsentStatus = vi.fn()
      .mockResolvedValueOnce({ purpose: 'live_hint', active: false, consent: null })
      .mockResolvedValue({ purpose: 'live_hint', active: true, consent });
    const bridge = installBridge({
      getCloudAiConsentStatus,
      prepareAiConsent: vi.fn().mockResolvedValue(prepared),
      approveAiConsent: vi.fn().mockResolvedValue(consent),
    });

    render(<SettingsPage />);
    await screen.findByText('未配置');
    fireEvent.change(screen.getByLabelText('OpenAI API Key'), {
      target: { value: 'test-openai-key-12345678901234567890' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存 Key' }));
    await waitFor(() => expect(bridge.saveCloudAiKey).toHaveBeenCalledWith({
      apiKey: 'test-openai-key-12345678901234567890',
    }));
    expect(await screen.findByText(/API Key 已写入系统加密存储/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /实时短提示/ }));
    expect(await screen.findByRole('region', { name: '实时短提示同意预览' })).toBeInTheDocument();
    expect(bridge.updateSettings).not.toHaveBeenCalled();
    expect(screen.getAllByText(APPROVED_AI_PROVIDER.retentionNotice)).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '批准此配置' }));
    await waitFor(() => expect(bridge.approveAiConsent).toHaveBeenCalledWith({
      preparationId: prepared.preparationId,
      purpose: 'live_hint',
      payloadHash: null,
      policyHash: prepared.policyHash,
      approvedFields: prepared.approvedFields,
    }));
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({
      cloudAi: {
        ...DEFAULT_APP_SETTINGS.cloudAi,
        liveHintEnabled: true,
      },
    }));
    expect(await screen.findByText(/每次练习仍必须显式打开 AI/)).toBeInTheDocument();
  });
});
