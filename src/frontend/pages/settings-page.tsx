import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BrainCircuit,
  Database,
  FileArchive,
  KeyRound,
  Mic2,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import type {
  AppSettings,
  CloudAiConfigurationStatus,
  CloudAiConsentStatus,
  DiagnosticStatus,
  GetEnvironmentStatusOutput,
  GetLocalAsrModelInstallStatusOutput,
  PreparedAiConsent,
} from '../../shared';
import { ConfirmationDialog } from '../components/confirmation-dialog';
import { useDiagnostics } from '../hooks/use-diagnostics';
import {
  approvePreparedConsent,
  deleteCloudAiKey,
  getCloudAiConfiguration,
  getCloudAiConsentStatus,
  getCloudAiPreferences,
  prepareLiveHintConsent,
  revokeCloudAiConsent,
  saveCloudAiKey,
  updateCloudAiPreferences,
} from '../services/cloud-ai-api';
import {
  cancelLocalAsrModelInstall,
  checkMicrophoneAccess,
  clearTrainingData,
  formatLocalAsrModelInstallProgress,
  getEnvironmentStatus,
  getLocalAsrModelInstallStatus,
  installLocalAsrModel,
  resetNonSensitiveSettings,
  type MicrophoneAccessResult,
} from '../services/environment-api';
import { recordDiagnosticEvent } from '../services/diagnostics-api';

type OperationStatus = 'idle' | 'pending' | 'success' | 'error';
type ConfirmationKind = 'delete-key' | 'clear-training' | 'reset-preferences';

interface OperationState {
  readonly status: OperationStatus;
  readonly message: string;
}

const IDLE_OPERATION: OperationState = { status: 'idle', message: '' };

interface SettingsPageProps {
  readonly onTrainingDataCleared?: () => void;
  readonly onBeforeSettingsReset?: () => Promise<void>;
  readonly onSettingsReset?: (settings: AppSettings) => void;
}

function microphoneLabel(result: MicrophoneAccessResult | null): string {
  if (!result) return '未检查（仅在点击后请求）';
  if (result.state === 'denied') return '未授权';
  if (result.state === 'no_device') return '未发现可用设备';
  if (result.trackState !== 'active') return '权限已允许；音频轨道未激活';
  const transportLabel = result.transport === 'script_processor_fallback'
    ? '（兼容通道）'
    : '';
  if (result.signalState === 'detected') {
    return `权限已允许；轨道正常；检测到输入信号${transportLabel}（RMS ${result.rms.toFixed(4)}）`;
  }
  if (result.signalState === 'silent') {
    return `权限已允许；轨道正常；未检测到足够输入能量${transportLabel}`;
  }
  if (result.transport === 'script_processor_fallback') {
    return '权限已允许；轨道正常；主通道与兼容通道均未收到 PCM';
  }
  return '权限已允许；轨道正常；PCM 信号未能验证';
}

function modelFileLabel(file: GetEnvironmentStatusOutput['localAsr']['files'][number]): string {
  if (file.readable) return '存在且可读';
  if (file.exists) return '存在但不可读';
  return '缺失';
}

function modelInstallIsActive(
  status: GetLocalAsrModelInstallStatusOutput | null,
): boolean {
  return status !== null && [
    'preparing',
    'downloading',
    'verifying',
    'extracting',
    'promoting',
    'cancelling',
  ].includes(status.stage);
}

function modelInstallFailureMessage(error: unknown): OperationState {
  const errorText = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (errorText.includes('ASR_MODEL_INSTALL_CANCELLED')) {
    return {
      status: 'success',
      message: '模型安装已取消；临时下载已清理，原有模型文件没有被覆盖。',
    };
  }
  if (errorText.includes('ASR_MODEL_INSUFFICIENT_DISK')) {
    return {
      status: 'error',
      message: '可用磁盘空间不足；默认三文件安装需要约 580 MB，只有界面明确显示 GitHub 备用整包时才需要约 1.7 GB。原有模型文件没有被覆盖。',
    };
  }
  if (errorText.includes('ASR_MODEL_ARCHIVE_INTEGRITY_MISMATCH')) {
    return {
      status: 'error',
      message: '模型包完整性校验失败，安装已停止并清理临时文件；请稍后重新下载。',
    };
  }
  if (errorText.includes('ASR_MODEL_DOWNLOAD_FAILED')) {
    return {
      status: 'error',
      message: '模型下载暂时中断；已完成的进度保留在本机，恢复网络后点击继续安装。',
    };
  }
  if (errorText.includes('ASR_MODEL_DIRECT_DOWNLOAD_FAILED')) {
    return {
      status: 'error',
      message: '三文件下载暂时中断；已完成的约 226 MB 断点保留在本机，不会自动改下约 1 GB 整包。恢复网络后点击继续安装。',
    };
  }
  if (errorText.includes('ASR_MODEL_INSTALL_TIMEOUT')) {
    return {
      status: 'error',
      message: '模型安装等待超时；已完成的下载进度仍保留，检查网络后可继续安装。',
    };
  }
  return {
    status: 'error',
    message: '模型安装没有完成；已有文件未被覆盖。请检查网络和可用磁盘空间后重试。',
  };
}

function formatStorageBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function diagnosticWriterLabel(
  loadStatus: 'loading' | 'ready' | 'error',
  status: DiagnosticStatus | null,
): string {
  if (loadStatus === 'loading') return '检查中…';
  if (loadStatus === 'error' || !status) return '状态未知';
  if (status.droppedEventCount > 0) return '日志不完整 · 已丢弃低优先级事件';
  if (status.bufferedEventCount > 0) return '写入降级 · 事件暂存在内存';
  if (status.writeFailureCount > 0) return '已恢复 · 本次运行曾有写入异常';
  return '已开启 · 默认脱敏';
}

export function SettingsPage({
  onTrainingDataCleared,
  onBeforeSettingsReset,
  onSettingsReset,
}: SettingsPageProps = {}) {
  const [environment, setEnvironment] = useState<GetEnvironmentStatusOutput | null>(null);
  const [environmentState, setEnvironmentState] = useState<OperationState>({
    status: 'pending',
    message: '正在检查本地环境…',
  });
  const [modelCancelPending, setModelCancelPending] = useState(false);
  const [modelInstallProgress, setModelInstallProgress] =
    useState<GetLocalAsrModelInstallStatusOutput | null>(null);
  const [microphone, setMicrophone] = useState<MicrophoneAccessResult | null>(null);
  const [microphoneState, setMicrophoneState] = useState<OperationState>(IDLE_OPERATION);
  const [modelInstallState, setModelInstallState] = useState<OperationState>(IDLE_OPERATION);
  const [confirmation, setConfirmation] = useState<ConfirmationKind | null>(null);
  const [clearState, setClearState] = useState<OperationState>(IDLE_OPERATION);
  const [resetState, setResetState] = useState<OperationState>(IDLE_OPERATION);
  const [cloudConfiguration, setCloudConfiguration] = useState<CloudAiConfigurationStatus | null>(null);
  const [cloudPreferences, setCloudPreferences] = useState<AppSettings['cloudAi'] | null>(null);
  const [liveConsent, setLiveConsent] = useState<CloudAiConsentStatus | null>(null);
  const [preparedLiveConsent, setPreparedLiveConsent] = useState<PreparedAiConsent | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [cloudState, setCloudState] = useState<OperationState>({
    status: 'pending',
    message: '正在读取 AI 配置…',
  });
  const diagnostics = useDiagnostics();
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  const consentPreviewRef = useRef<HTMLElement>(null);
  const focusApiKeyAfterDelete = useRef(false);

  useEffect(() => {
    if (confirmation !== null || !focusApiKeyAfterDelete.current) return;
    focusApiKeyAfterDelete.current = false;
    apiKeyInputRef.current?.focus({ preventScroll: true });
  }, [confirmation]);

  useEffect(() => {
    if (!preparedLiveConsent) return;
    const frame = window.requestAnimationFrame(() => {
      consentPreviewRef.current?.focus({ preventScroll: false });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [preparedLiveConsent]);

  const refreshEnvironment = useCallback(async () => {
    setEnvironmentState({ status: 'pending', message: '正在检查本地模型与数据…' });
    try {
      const status = await getEnvironmentStatus();
      setEnvironment(status);
      setEnvironmentState({ status: 'success', message: '本地环境检查完成。' });
    } catch {
      setEnvironmentState({
        status: 'error',
        message: '本地环境检查失败，请重试。',
      });
    }
  }, []);

  useEffect(() => {
    void refreshEnvironment();
  }, [refreshEnvironment]);

  useEffect(() => {
    let disposed = false;
    const loadStatus = async () => {
      try {
        const status = await getLocalAsrModelInstallStatus();
        if (!disposed) setModelInstallProgress(status);
      } catch {
        // The environment card remains usable if an older bridge lacks progress status.
      }
    };
    void loadStatus();
    return () => {
      disposed = true;
    };
  }, []);

  const modelInstallRunning = modelInstallState.status === 'pending'
    || modelInstallIsActive(modelInstallProgress);

  useEffect(() => {
    if (!modelInstallRunning) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const status = await getLocalAsrModelInstallStatus();
        if (!disposed) setModelInstallProgress(status);
      } catch {
        // The install request remains authoritative; a missed progress poll is non-fatal.
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 500);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [modelInstallRunning]);

  useEffect(() => {
    if (!modelInstallProgress) return;
    if (modelInstallProgress.stage === 'completed') {
      setModelInstallState({ status: 'success', message: '本地转写模型安装完成。' });
      setModelCancelPending(false);
      void refreshEnvironment();
    } else if (modelInstallProgress.stage === 'failed') {
      setModelInstallState(modelInstallFailureMessage(
        new Error(modelInstallProgress.errorCode ?? 'ASR_MODEL_INSTALL_FAILED'),
      ));
      setModelCancelPending(false);
    } else if (modelInstallProgress.stage === 'cancelled') {
      setModelInstallState(modelInstallFailureMessage(
        new Error(modelInstallProgress.errorCode ?? 'ASR_MODEL_INSTALL_CANCELLED'),
      ));
      setModelCancelPending(false);
    }
  }, [modelInstallProgress, refreshEnvironment]);

  const refreshCloud = useCallback(async () => {
    setCloudState({ status: 'pending', message: '正在读取 AI 配置…' });
    try {
      const [configuration, preferences, consent] = await Promise.all([
        getCloudAiConfiguration(),
        getCloudAiPreferences(),
        getCloudAiConsentStatus('live_hint'),
      ]);
      setCloudConfiguration(configuration);
      setCloudPreferences(preferences);
      setLiveConsent(consent);
      setCloudState({ status: 'success', message: 'AI 配置已读取。' });
    } catch {
      setCloudState({ status: 'error', message: 'AI 配置读取失败，请重试。' });
    }
  }, []);

  useEffect(() => {
    void refreshCloud();
  }, [refreshCloud]);

  const runMicrophoneCheck = async () => {
    setMicrophoneState({ status: 'pending', message: '正在短暂检查麦克风…' });
    try {
      const result = await checkMicrophoneAccess();
      setMicrophone(result);
      setMicrophoneState({ status: 'success', message: '麦克风检查完成。' });
      void Promise.resolve()
        .then(() => recordDiagnosticEvent({
          level: result.state === 'allowed' ? 'info' : 'warn',
          component: 'recording',
          event: 'recording.microphone_check_completed',
          fields: {
            permission: result.state,
            track: result.trackState,
            signal: result.signalState,
            transport: result.transport,
            pcmCallbackCount: result.pcmCallbackCount,
            rms: result.rms,
            peak: result.peak,
          },
        }))
        .catch(() => undefined);
    } catch {
      setMicrophoneState({ status: 'error', message: '麦克风检查失败，请重试。' });
      void Promise.resolve()
        .then(() => recordDiagnosticEvent({
          level: 'error',
          component: 'recording',
          event: 'recording.microphone_check_failed',
          fields: { reasonCode: 'get_user_media_failed' },
        }))
        .catch(() => undefined);
    }
  };

  const runModelInstall = async () => {
    setModelCancelPending(false);
    setModelInstallProgress(null);
    setModelInstallState({
      status: 'pending',
      message: '正在分段下载并校验约 226 MB 运行文件；一般断网或超时会保留断点，不会自动改下约 1 GB 整包。',
    });
    try {
      const result = await installLocalAsrModel();
      setEnvironment((current) => current
        ? { ...current, checkedAt: result.completedAt, localAsr: result.localAsr }
        : current);
      setModelInstallState({
        status: 'success',
        message: result.outcome === 'already_installed'
          ? '本地转写模型已经完整，无需重复下载。'
          : '本地转写模型安装完成；练习时会直接启用实时 partial / final 转写。',
      });
      await refreshEnvironment();
    } catch (error) {
      setModelInstallState(modelInstallFailureMessage(error));
    } finally {
      setModelCancelPending(false);
    }
  };

  const runModelInstallCancel = async () => {
    const cancellingPausedCheckpoint = modelInstallProgress?.stage === 'paused';
    setModelCancelPending(true);
    setModelInstallState({
      status: 'pending',
      message: cancellingPausedCheckpoint
        ? '正在删除已保留的下载进度…'
        : '正在取消安装并清理临时文件…',
    });
    try {
      const result = await cancelLocalAsrModelInstall();
      if (!result.cancelled) {
        const status = await getLocalAsrModelInstallStatus();
        setModelInstallProgress(status);
        if (!modelInstallIsActive(status)) {
          setModelInstallState({
            status: 'error',
            message: '安装状态已经变化，取消请求未执行；请根据当前状态继续。',
          });
        }
        setModelCancelPending(false);
        return;
      }
      if (cancellingPausedCheckpoint) {
        const status = await getLocalAsrModelInstallStatus();
        setModelInstallProgress(status);
        setModelInstallState(modelInstallFailureMessage(
          new Error(status.errorCode ?? 'ASR_MODEL_INSTALL_CANCELLED'),
        ));
        setModelCancelPending(false);
      } else {
        // Keep polling the backend-owned operation until it reaches cancelled;
        // renderer reloads or cross-page attachment have no local install Promise.
        setModelInstallProgress(await getLocalAsrModelInstallStatus());
      }
    } catch {
      setModelCancelPending(false);
      setModelInstallState({
        status: 'error',
        message: '取消请求没有送达；安装可能仍在进行。请重试取消或退出应用。',
      });
    }
  };

  const runClearTrainingData = async () => {
    setClearState({ status: 'pending', message: '正在清除训练数据…' });
    try {
      const result = await clearTrainingData();
      onTrainingDataCleared?.();
      await Promise.all([refreshEnvironment(), diagnostics.refresh()]);
      if (result.diagnosticLogs.status === 'retry_required') {
        const remaining = result.diagnosticLogs.remainingFileCount;
        setClearState({
          status: 'error',
          message: remaining === null
            ? `已清除 ${result.deletedTrainingRecordCount} 条训练记录及关联音频，但无法确认诊断日志已经清空。请重试永久清除。`
            : `已清除 ${result.deletedTrainingRecordCount} 条训练记录及关联音频，但仍有 ${remaining} 个诊断日志文件未删除。请重试永久清除。`,
        });
        return;
      }
      setConfirmation(null);
      setClearState({
        status: 'success',
        message: result.deletedTrainingRecordCount > 0
          ? `已清除 ${result.deletedTrainingRecordCount} 条训练记录、关联音频和诊断日志。`
          : '训练数据、关联音频和诊断日志已全部清除。',
      });
    } catch {
      setClearState({ status: 'error', message: '训练数据清除失败，请重试。' });
    }
  };

  const runResetSettings = async () => {
    setResetState({ status: 'pending', message: '正在重置非敏感偏好…' });
    try {
      await onBeforeSettingsReset?.();
      const resetSettings = await resetNonSensitiveSettings();
      setConfirmation(null);
      setCloudPreferences(resetSettings.cloudAi);
      setPreparedLiveConsent(null);
      setLiveConsent({ purpose: 'live_hint', active: false, consent: null });
      onSettingsReset?.(resetSettings);
      setResetState({
        status: 'success',
        message: '非敏感偏好已恢复默认值并立即生效，AI 同意与请求审计已清除；本机 API Key 仍保留。',
      });
    } catch {
      setResetState({ status: 'error', message: '偏好重置失败，请重试。' });
    }
  };

  const runSaveApiKey = async () => {
    setCloudState({ status: 'pending', message: '正在写入本机密钥存储…' });
    try {
      const configuration = await saveCloudAiKey(apiKey);
      setCloudConfiguration(configuration);
      setApiKey('');
      setCloudState({
        status: 'success',
        message: configuration.keyStorage === 'system_encrypted'
          ? 'API Key 已写入系统加密存储；界面不会读取明文。'
          : 'API Key 已写入本机私有文件（未加密，权限 0600）；界面不会读取明文。',
      });
    } catch {
      setCloudState({ status: 'error', message: 'API Key 未保存。请检查格式和本机存储后重试。' });
    }
  };

  const runDeleteApiKey = async () => {
    setCloudState({ status: 'pending', message: '正在删除 API Key…' });
    try {
      const configuration = await deleteCloudAiKey();
      focusApiKeyAfterDelete.current = true;
      setConfirmation(null);
      setCloudConfiguration(configuration);
      setCloudState({ status: 'success', message: 'API Key 已从本机密钥存储删除。' });
    } catch {
      setCloudState({ status: 'error', message: 'API Key 删除失败，请重试。' });
    }
  };

  const updatePreference = async (
    key: keyof AppSettings['cloudAi'],
    enabled: boolean,
  ): Promise<boolean> => {
    if (!cloudPreferences) {
      setCloudState({ status: 'error', message: 'AI 用途设置尚未载入，请重新检查后再试。' });
      return false;
    }
    const previous = cloudPreferences;
    const next = { ...previous, [key]: enabled };
    setCloudPreferences(next);
    setCloudState({ status: 'pending', message: '正在保存 AI 用途设置…' });
    try {
      const persisted = await updateCloudAiPreferences(next);
      setCloudPreferences(persisted);
      setCloudState({ status: 'success', message: 'AI 用途设置已保存。' });
      return true;
    } catch {
      setCloudPreferences(previous);
      setCloudState({ status: 'error', message: 'AI 用途设置未保存，已恢复原值。' });
      return false;
    }
  };

  const requestLiveConsentPreview = async () => {
    if (!cloudConfiguration?.configured) {
      setCloudState({ status: 'error', message: '请先保存可用的 API Key，再配置实时短提示。' });
      return;
    }
    setCloudState({ status: 'pending', message: '正在生成 live_hint 配置级同意预览…' });
    try {
      const prepared = await prepareLiveHintConsent();
      setPreparedLiveConsent(prepared);
      setCloudState({ status: 'success', message: '请核对下方字段、策略与数据保留说明。' });
    } catch {
      setCloudState({ status: 'error', message: '同意预览生成失败，请重试。' });
    }
  };

  const approveLiveConsent = async () => {
    if (!preparedLiveConsent) return;
    setCloudState({ status: 'pending', message: '正在保存 live_hint 配置级同意…' });
    try {
      await approvePreparedConsent(preparedLiveConsent);
      const consent = await getCloudAiConsentStatus('live_hint');
      setLiveConsent(consent);
      setPreparedLiveConsent(null);
      const preferenceSaved = await updatePreference('liveHintEnabled', true);
      setCloudState(preferenceSaved
        ? { status: 'success', message: '配置级同意已保存；每次练习仍必须显式打开 AI。' }
        : { status: 'error', message: '配置级同意已保存，但用途开关未保存；请重新打开实时短提示。' });
    } catch {
      setCloudState({ status: 'error', message: '配置级同意未保存，请重新生成预览后重试。' });
    }
  };

  const revokeLiveConsent = async () => {
    const consentId = liveConsent?.consent?.id;
    if (!consentId) return;
    setCloudState({ status: 'pending', message: '正在撤回 live_hint 同意…' });
    try {
      await revokeCloudAiConsent(consentId);
      setLiveConsent(await getCloudAiConsentStatus('live_hint'));
      if (cloudPreferences?.liveHintEnabled) {
        const preferenceSaved = await updatePreference('liveHintEnabled', false);
        if (!preferenceSaved) {
          setCloudState({
            status: 'error',
            message: 'live_hint 同意已撤回，但用途开关未能同步关闭；实时请求仍会因无同意而被拒绝，请重试保存设置。',
          });
          return;
        }
      }
      setCloudState({ status: 'success', message: 'live_hint 同意已撤回；未完成请求会被取消。' });
    } catch {
      setCloudState({ status: 'error', message: '同意撤回失败，请重试。' });
    }
  };

  return (
    <div className="settings-layout product-settings-page">
      <section className="settings-main">
        <div className="page-heading">
          <div>
            <span className="settings-folio" aria-hidden="true">DEVICE LEDGER · 01</span>
            <h1>常规与隐私</h1>
            <p>检查本机能力，管理训练数据，并明确每次操作的实际范围。</p>
          </div>
        </div>

        <section className="settings-info-card">
          <header>
            <Mic2 aria-hidden="true" size={18} />
            <div>
              <h2>麦克风与本地转写</h2>
              <p>麦克风只在你点击检查或主动录音后请求；检查结束会立即停止音轨。</p>
            </div>
          </header>
          <dl>
            <div>
              <dt>麦克风</dt>
              <dd>{microphoneState.status === 'pending' ? '检查中…' : microphoneLabel(microphone)}</dd>
            </div>
            <div>
              <dt>本地 ASR</dt>
              <dd>
                {environmentState.status === 'pending'
                  ? '检查中…'
                  : environment?.localAsr.ready
                    ? '模型完整且可读'
                    : '模型未就绪'}
              </dd>
            </div>
            {environment?.localAsr.files.map((file) => (
              <div key={file.name}>
                <dt>{file.name}</dt>
                <dd>{modelFileLabel(file)}</dd>
              </div>
            ))}
          </dl>
          <div className="page-actions">
            <button
              className="secondary-button"
              disabled={microphoneState.status === 'pending'}
              onClick={() => void runMicrophoneCheck()}
              type="button"
            >
              {microphoneState.status === 'error' ? '重试麦克风检查' : '检查麦克风'}
            </button>
            <button
              className="secondary-button"
              disabled={environmentState.status === 'pending' || modelInstallRunning}
              onClick={() => void refreshEnvironment()}
              type="button"
            >
              {environmentState.status === 'error' ? '重试环境检查' : '重新检查本地模型'}
            </button>
            {environment && !environment.localAsr.ready ? (
              <button
                className="primary-button"
                disabled={modelInstallRunning}
                onClick={() => void runModelInstall()}
                type="button"
              >
                {modelInstallRunning
                  ? '正在下载并安装…'
                  : modelInstallProgress?.stage === 'paused'
                    ? '继续安装本地转写模型'
                    : modelInstallState.status === 'error'
                      ? '重试安装本地转写模型'
                      : '一键安装本地转写模型'}
              </button>
            ) : null}
            {modelInstallRunning || modelInstallProgress?.stage === 'paused' ? (
              <button
                className="secondary-button"
                disabled={modelCancelPending || modelInstallProgress?.cancellable === false}
                onClick={() => void runModelInstallCancel()}
                type="button"
              >
                {modelCancelPending
                  ? '正在取消…'
                  : modelInstallProgress?.stage === 'paused'
                    ? '删除已下载进度'
                    : '取消安装'}
              </button>
            ) : null}
          </div>
          {!environment?.localAsr.ready ? (
            <p className="retention-notice">
              默认只下载固定版本的三个 int8 / token 运行文件（约 226 MB），分段并发且逐文件校验 SHA-256；普通超时或断网只保留并续传三文件断点。仅当官方三文件源明确不支持安全分段、跳转或连续校验失败时，才自动使用约 1 GB 的 k2-fsa GitHub 备用整包。
            </p>
          ) : null}
          {modelInstallRunning || modelInstallProgress?.stage === 'paused' ? (
            <p>
              {modelInstallProgress
                ? formatLocalAsrModelInstallProgress(modelInstallProgress)
                : modelInstallState.message}
            </p>
          ) : null}
          {modelInstallState.status === 'error' ? (
            <p className="inline-error" role="alert">{modelInstallState.message}</p>
          ) : null}
          {modelInstallState.status === 'success' ? (
            <p aria-live="polite">{modelInstallState.message}</p>
          ) : null}
          {microphoneState.status === 'error' ? (
            <p className="inline-error" role="alert">{microphoneState.message}</p>
          ) : null}
          {environmentState.status === 'error' ? (
            <p className="inline-error" role="alert">{environmentState.message}</p>
          ) : null}
        </section>

        <section className="settings-info-card" aria-labelledby="diagnostic-logs-heading">
          <header>
            <FileArchive aria-hidden="true" size={18} />
            <div>
              <h2 id="diagnostic-logs-heading">本地诊断日志</h2>
              <p>脱敏记录应用、录音、转写、AI 与持久化状态，只保存在本机并滚动清理。</p>
            </div>
          </header>
          <dl>
            <div>
              <dt>本机记录</dt>
              <dd
                role={diagnostics.status && (
                  diagnostics.status.bufferedEventCount > 0
                  || diagnostics.status.droppedEventCount > 0
                ) ? 'alert' : 'status'}
              >
                {diagnosticWriterLabel(diagnostics.loadStatus, diagnostics.status)}
              </dd>
            </div>
            <div>
              <dt>保留期限</dt>
              <dd>{diagnostics.status ? `最长 ${diagnostics.status.retentionDays} 天` : '最长 7 天'}</dd>
            </div>
            <div>
              <dt>日志文件</dt>
              <dd>{diagnostics.status ? `${diagnostics.status.fileCount} 个 · ${formatStorageBytes(diagnostics.status.totalBytes)}` : '—'}</dd>
            </div>
            <div>
              <dt>待写入缓冲</dt>
              <dd>{diagnostics.status ? `${diagnostics.status.bufferedEventCount} 条` : '—'}</dd>
            </div>
            <div>
              <dt>已丢弃事件</dt>
              <dd>{diagnostics.status ? `${diagnostics.status.droppedEventCount} 条` : '—'}</dd>
            </div>
            <div>
              <dt>写入异常</dt>
              <dd>{diagnostics.status ? `${diagnostics.status.writeFailureCount} 次` : '—'}</dd>
            </div>
            <div>
              <dt>本次运行最近诊断 ID</dt>
              <dd><code>{diagnostics.status?.latestIncidentId ?? '暂无'}</code></dd>
            </div>
            <div>
              <dt>日志目录</dt>
              <dd><code>{diagnostics.status?.logDirectory ?? '读取中…'}</code></dd>
            </div>
          </dl>
          <p className="retention-notice">日志不包含音频、完整逐字稿、云端请求正文或 API Key；导出前仍可先清除。</p>
          <div className="page-actions">
            <button
              className="secondary-button"
              disabled={diagnostics.busy || diagnostics.loadStatus === 'loading'}
              onClick={() => void diagnostics.refresh()}
              type="button"
            >
              {diagnostics.loadStatus === 'loading'
                ? '正在刷新…'
                : diagnostics.loadStatus === 'error'
                  ? '重试日志检查'
                  : '刷新状态'}
            </button>
            <button
              className="secondary-button"
              disabled={diagnostics.busy}
              onClick={() => void diagnostics.openDirectory()}
              type="button"
            >
              {diagnostics.operationState.operation === 'open' && diagnostics.busy ? '正在打开…' : '打开日志目录'}
            </button>
            <button
              className="secondary-button"
              disabled={diagnostics.busy}
              onClick={() => void diagnostics.exportBundle()}
              type="button"
            >
              {diagnostics.operationState.operation === 'export' && diagnostics.busy ? '正在导出…' : '导出诊断包'}
            </button>
            <button
              className="danger-text-button"
              disabled={diagnostics.busy}
              onClick={() => void diagnostics.clearLogs()}
              type="button"
            >
              {diagnostics.operationState.operation === 'clear' && diagnostics.busy ? '正在清除…' : '清除诊断日志'}
            </button>
          </div>
          {diagnostics.loadError ? <p className="inline-error" role="alert">{diagnostics.loadError}</p> : null}
          {diagnostics.operationState.status !== 'idle' && diagnostics.operationState.status !== 'pending' ? (
            <p
              className={diagnostics.operationState.status === 'error' ? 'inline-error' : undefined}
              role={diagnostics.operationState.status === 'error' ? 'alert' : 'status'}
            >
              {diagnostics.operationState.message}
            </p>
          ) : null}
          {diagnostics.operationState.status === 'pending' ? (
            <p aria-live="polite">正在处理诊断日志操作…</p>
          ) : null}
        </section>

        <section className="settings-info-card cloud-ai-settings">
          <header>
            <BrainCircuit aria-hidden="true" size={18} />
            <div>
              <h2>可选 AI 分析</h2>
              <p>固定使用 OpenAI Responses；音频和 partial 不会发送，Deep Lane 必须逐 payload 批准。</p>
            </div>
          </header>
          <dl>
            <div><dt>Provider</dt><dd>{cloudConfiguration?.providerName ?? '读取中…'}</dd></div>
            <div><dt>Model</dt><dd><code>{cloudConfiguration?.model ?? '读取中…'}</code></dd></div>
            <div><dt>Endpoint</dt><dd><code>{cloudConfiguration?.endpoint ?? '读取中…'}</code></dd></div>
            <div>
              <dt>密钥存储</dt>
              <dd>{cloudConfiguration
                ? cloudConfiguration.keyStorage === 'system_encrypted'
                  ? '系统加密'
                  : '本机私有文件（未加密）'
                : '读取中…'}</dd>
            </div>
            <div><dt>API Key</dt><dd>{cloudConfiguration?.configured ? `已配置 ${cloudConfiguration.keyHint ?? ''}` : '未配置'}</dd></div>
          </dl>
          {cloudConfiguration?.keyStorage === 'local_private_file_unencrypted' ? (
            <p className="retention-notice" role="status">
              为避免系统钥匙串阻塞整个应用，本版本把 Key 保存在仅当前本机用户可读的私有文件中（权限 0600）；界面不会回显明文。
            </p>
          ) : null}
          <div className="api-key-editor">
            <label htmlFor="openai-api-key"><KeyRound aria-hidden="true" size={15} />OpenAI API Key</label>
            <input
              autoComplete="off"
              disabled={cloudState.status === 'pending'}
              id="openai-api-key"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={cloudConfiguration?.keyStorage === 'local_private_file_unencrypted'
                ? '写入本机私有文件（未加密）'
                : '写入本机系统加密存储'}
              ref={apiKeyInputRef}
              type="password"
              value={apiKey}
            />
            <div className="page-actions">
              <button className="secondary-button" disabled={apiKey.trim().length < 20 || cloudState.status === 'pending'} onClick={() => void runSaveApiKey()} type="button">保存 Key</button>
              {cloudConfiguration?.configured ? (
                <button
                  className="danger-text-button"
                  disabled={cloudState.status === 'pending'}
                  onClick={() => setConfirmation('delete-key')}
                  type="button"
                >
                  删除 Key
                </button>
              ) : null}
            </div>
          </div>

          <fieldset className="ai-purpose-list" disabled={!cloudPreferences || cloudState.status === 'pending'}>
            <legend>三个用途独立控制</legend>
            <label>
              <input
                checked={cloudPreferences?.liveHintEnabled ?? false}
                aria-describedby="live-hint-purpose-help"
                onChange={(event) => {
                  if (event.target.checked && !liveConsent?.active) void requestLiveConsentPreview();
                  else void updatePreference('liveHintEnabled', event.target.checked);
                }}
                type="checkbox"
              />
              <span><strong>实时短提示</strong><small id="live-hint-purpose-help">首次点击会定位到同意预览；批准后开启用途，每次练习仍需显式 AI ON。</small></span>
            </label>
            <label>
              <input checked={cloudPreferences?.deepDiagnosisEnabled ?? false} onChange={(event) => void updatePreference('deepDiagnosisEnabled', event.target.checked)} type="checkbox" />
              <span><strong>完整 AI 复盘</strong><small>本地复盘始终先可用；每一版最终 payload 单独展示和批准。</small></span>
            </label>
            <label>
              <input checked={cloudPreferences?.comparisonEnabled ?? false} onChange={(event) => void updatePreference('comparisonEnabled', event.target.checked)} type="checkbox" />
              <span><strong>语义前后比较</strong><small>本地同口径比较不依赖 AI；云端比较逐 payload 批准。</small></span>
            </label>
          </fieldset>

          {preparedLiveConsent ? (
            <section
              aria-label="实时短提示同意预览"
              className="consent-preview"
              ref={consentPreviewRef}
              tabIndex={-1}
            >
              <h3>live_hint 配置级同意</h3>
              <p>将允许以下字段类别按预览策略发送。这里不包含某个具体题目文本，也不替代每次练习的 AI ON。</p>
              <pre>{preparedLiveConsent.previewJson}</pre>
              <p>{preparedLiveConsent.retentionNotice}</p>
              <div className="page-actions">
                <button className="primary-button" disabled={cloudState.status === 'pending'} onClick={() => void approveLiveConsent()} type="button">批准此配置</button>
                <button className="secondary-button" disabled={cloudState.status === 'pending'} onClick={() => setPreparedLiveConsent(null)} type="button">取消</button>
              </div>
            </section>
          ) : null}
          <div className="page-actions">
            {liveConsent?.active ? <button className="danger-text-button" disabled={cloudState.status === 'pending'} onClick={() => void revokeLiveConsent()} type="button">撤回 live_hint 同意</button> : <button className="secondary-button" disabled={cloudState.status === 'pending'} onClick={() => void requestLiveConsentPreview()} type="button">查看 live_hint 同意预览</button>}
            <button className="secondary-button" disabled={cloudState.status === 'pending'} onClick={() => void refreshCloud()} type="button">重新检查 AI 配置</button>
          </div>
          <p className="retention-notice">{cloudConfiguration?.retentionNotice ?? '正在读取数据保留说明…'}</p>
          {cloudState.status === 'error' && confirmation !== 'delete-key' ? <p className="inline-error" role="alert">{cloudState.message}</p> : null}
          {cloudState.status === 'success' ? <p aria-live="polite">{cloudState.message}</p> : null}
        </section>

        <section className="settings-info-card">
          <header>
            <Database aria-hidden="true" size={18} />
            <div>
              <h2>本地训练数据</h2>
              <p>会话、逐字稿、证据与训练结果保存在下列本机目录。</p>
            </div>
          </header>
          <dl>
            <div><dt>数据目录</dt><dd><code>{environment?.dataDirectory ?? '检查中…'}</code></dd></div>
            <div><dt>训练记录</dt><dd>{environment ? `${environment.trainingRecordCount} 条` : '检查中…'}</dd></div>
          </dl>
          <div className="page-actions">
            <button
              className="secondary-button"
              disabled={environmentState.status === 'pending'}
              onClick={() => void refreshEnvironment()}
              type="button"
            >
              重新检查数据
            </button>
          </div>
        </section>

        <section className="settings-info-card">
          <header>
            <Trash2 aria-hidden="true" size={18} />
            <div>
              <h2>清除全部训练数据</h2>
              <p>删除全部训练会话、关联产物、已批准的 Deep/Comparison payload 审计、诊断日志，以及临时和已保留音频。</p>
            </div>
          </header>
          <dl>
            <div><dt>不会删除</dt><dd>本地模型、外部导出、本机 API Key 与 live_hint 配置级同意</dd></div>
          </dl>
          <div className="page-actions">
            <button
              className="danger-text-button"
              disabled={clearState.status === 'pending'}
              onClick={() => {
                setClearState(IDLE_OPERATION);
                setConfirmation('clear-training');
              }}
              type="button"
            >
              清除全部训练数据
            </button>
          </div>
          {clearState.status === 'error' && confirmation !== 'clear-training' ? (
            <p className="inline-error" role="alert">{clearState.message}</p>
          ) : null}
          {clearState.status === 'success' ? (
            <p aria-live="polite">{clearState.message}</p>
          ) : null}
        </section>

        <section className="settings-info-card">
          <header>
            <RotateCcw aria-hidden="true" size={18} />
            <div>
              <h2>重置非敏感偏好</h2>
              <p>恢复外观、动效、音频保留、收藏和 AI 用途开关；撤回 AI 同意并清除请求审计，不清除训练记录或本机 API Key。</p>
            </div>
          </header>
          <div className="page-actions">
            <button
              className="secondary-button"
              disabled={resetState.status === 'pending'}
              onClick={() => {
                setResetState(IDLE_OPERATION);
                setConfirmation('reset-preferences');
              }}
              type="button"
            >
              恢复默认偏好
            </button>
          </div>
          {resetState.status === 'error' && confirmation !== 'reset-preferences' ? (
            <p className="inline-error" role="alert">{resetState.message}</p>
          ) : null}
          {resetState.status === 'success' ? (
            <p aria-live="polite">{resetState.message}</p>
          ) : null}
        </section>

        <p className="privacy-boundary"><ShieldCheck aria-hidden="true" size={15} />这里的操作只作用于明确列出的本机范围；每次失败都可显式重试。</p>
      </section>
      {confirmation === 'delete-key' ? (
        <ConfirmationDialog
          busy={cloudState.status === 'pending'}
          cancelLabel="保留 Key"
          confirmDangerous
          confirmLabel={cloudState.status === 'pending' ? '正在删除…' : cloudState.status === 'error' ? '重试删除 Key' : '确认删除 Key'}
          description={(
            <>
              <p>删除后，所有云端 AI 请求都会停止；本地转写、标注与本地复盘仍可使用。</p>
              {cloudState.status === 'error' ? <p className="inline-error" role="alert">{cloudState.message}</p> : null}
            </>
          )}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void runDeleteApiKey()}
          title="删除 OpenAI API Key？"
        />
      ) : null}
      {confirmation === 'clear-training' ? (
        <ConfirmationDialog
          busy={clearState.status === 'pending'}
          cancelLabel="保留训练数据"
          confirmDangerous
          confirmLabel={clearState.status === 'pending' ? '正在清除…' : clearState.status === 'error' ? '重试永久清除' : '确认永久清除'}
          description={(
            <>
              <p>这会永久删除全部训练会话、逐字稿、证据、报告、AI payload 审计、诊断日志和关联音频，且无法撤销。</p>
              {clearState.status === 'error' ? <p className="inline-error" role="alert">{clearState.message}</p> : null}
            </>
          )}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void runClearTrainingData()}
          title="清除全部训练数据？"
        />
      ) : null}
      {confirmation === 'reset-preferences' ? (
        <ConfirmationDialog
          busy={resetState.status === 'pending'}
          cancelLabel="保留当前偏好"
          confirmDangerous
          confirmLabel={resetState.status === 'pending' ? '正在重置…' : resetState.status === 'error' ? '重试恢复默认偏好' : '确认恢复默认偏好'}
          description={(
            <>
              <p>这会立即撤回 AI 同意、清除请求审计并恢复外观与练习偏好；训练记录和本机 API Key 不受影响。</p>
              {resetState.status === 'error' ? <p className="inline-error" role="alert">{resetState.message}</p> : null}
            </>
          )}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void runResetSettings()}
          title="恢复默认偏好？"
        />
      ) : null}
    </div>
  );
}
