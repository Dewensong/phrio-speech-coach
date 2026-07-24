import { BrainCircuit, CircleStop, CloudOff, Mic, Radio } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  getPrimaryPracticeFocus,
  type AttemptSnapshot,
  type GetLocalAsrModelInstallStatusOutput,
} from '../../shared';

import { EvidenceLedger } from '../components/evidence-ledger';
import { LiveAiSetup } from '../components/live-ai-setup';
import { LiveFocusSurface } from '../components/live-focus-surface';
import { useLivePractice } from '../hooks/use-live-practice';
import type { RecordedAudio } from '../hooks/use-audio-recorder';
import {
  cancelLocalAsrModelInstall,
  formatLocalAsrModelInstallProgress,
  getLocalAsrModelInstallStatus,
} from '../services/environment-api';
import { readAttemptRecording } from '../services/desktop-api';
import type { PracticeDraft, SelectedPracticeFocus } from '../types/ui';

interface LivePracticePageProps {
  readonly sessionId: string;
  readonly attempt: 'first' | 'second';
  readonly draft: PracticeDraft;
  readonly focus?: SelectedPracticeFocus | null;
  readonly busy: boolean;
  readonly saveError?: string;
  readonly onAccept: (audio: RecordedAudio, snapshot: AttemptSnapshot | null) => void;
  readonly restoredSnapshot?: AttemptSnapshot | null;
  readonly onPersistStoppedTake?: (audio: RecordedAudio, snapshot: AttemptSnapshot) => Promise<void>;
  readonly onDiscardStoppedTake?: (attemptId: string | null) => Promise<void>;
  readonly onRecordingActivityChange?: (active: boolean) => void;
  readonly onRecordingGuardReasonChange?: (reason: 'recording' | 'unsaved') => void;
}

const STATUS_COPY = {
  awaiting_permission: '待授权', ready: '待录音', recording: '录音中', finalizing: '正在收尾',
  recorded: '音频已停止',
  safe_end: '录音已安全结束', interrupted: '录音中断', permission_denied: '麦克风权限失败',
} as const;

const ASR_STATUS_COPY = {
  idle: 'ASR 待启动',
  listening: '正在监听',
  voice_detected: '已检测到语音',
  partial: 'partial 正在转写',
  segment_finalized: '句段已落定',
  reconnecting: '正在重连 ASR',
  degraded: '实时转写已降级',
  finalizing: '正在收束尾句',
  ready: '转写已完成',
  failed: '转写未完成',
  no_speech: '尚未检测到语音',
} as const;

const persistStoppedTakeFallback = async (): Promise<void> => undefined;
const discardStoppedTakeFallback = async (): Promise<void> => undefined;

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function modelInstallStatusIsActive(
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

function createControlledQaRecording(): RecordedAudio {
  const sampleRate = 8_000;
  const sampleFrames = 800;
  const bytes = new ArrayBuffer(44 + sampleFrames * 2);
  const view = new DataView(bytes);
  const writeAscii = (offset: number, value: string) => {
    [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, sampleFrames * 2, true);
  return {
    blob: new Blob([bytes], { type: 'audio/wav' }),
    url: '',
    mimeType: 'audio/wav',
    durationMs: 30_000,
  };
}

export function LivePracticePage({
  sessionId,
  attempt,
  draft,
  focus = null,
  busy,
  saveError,
  onAccept,
  restoredSnapshot = null,
  onPersistStoppedTake = persistStoppedTakeFallback,
  onDiscardStoppedTake = discardStoppedTakeFallback,
  onRecordingActivityChange,
  onRecordingGuardReasonChange,
}: LivePracticePageProps) {
  const live = useLivePractice({
    sessionId,
    kind: attempt === 'first' ? 'initial' : 'retry',
    focusVersion: attempt === 'second' ? focus ? 1 : null : null,
  });
  const { state, recorder } = live;
  const [restoredAudio, setRestoredAudio] = useState<RecordedAudio | null>(null);
  const [viewMode, setViewMode] = useState<'focus' | 'evidence'>('focus');
  const [takePersistence, setTakePersistence] = useState<'idle' | 'loading' | 'saving' | 'saved' | 'error'>(
    restoredSnapshot ? 'loading' : 'idle',
  );
  const [discardingTake, setDiscardingTake] = useState(false);
  const [takeRestoreRevision, setTakeRestoreRevision] = useState(0);
  const persistStoppedTakeRef = useRef(onPersistStoppedTake);
  const takePersistenceRevision = useRef(0);
  persistStoppedTakeRef.current = onPersistStoppedTake;
  useEffect(() => () => { ++takePersistenceRevision.current; }, []);
  const recordedAudio = recorder.recordedAudio ?? restoredAudio;
  const durableSnapshot = live.snapshot ?? restoredSnapshot;
  const recording = recorder.status === 'recording' || state.capture === 'recording';
  const hasUnsavedTake = Boolean(recordedAudio) && takePersistence !== 'saved';
  const recordingActivity =
    recorder.status === 'requesting'
    || recording
    || state.capture === 'finalizing'
    || hasUnsavedTake;
  const recordingActivityReason = hasUnsavedTake ? 'unsaved' : 'recording';
  const safeEnd = state.capture === 'safe_end' || Boolean(restoredAudio && restoredSnapshot);
  const transcriptionFailure = state.asr === 'failed' && state.capture === 'recorded';
  const captureInterrupted = state.capture === 'interrupted';
  const restoredTakeUnavailable = Boolean(restoredSnapshot)
    && takePersistence === 'error'
    && !recordedAudio;
  const repairRequired = transcriptionFailure || captureInterrupted || restoredTakeUnavailable;
  const snapshotReady = durableSnapshot !== null;
  const activeHint = state.hints.filter((hint) => hint.lifecycle === 'provisional').at(-1);
  const finalCount = state.segments.filter((segment) => segment.isFinal).length;
  const retainedCount = state.annotations.length;
  const snapshotPendingLabel = state.report === 'failed' ? '重试保存快照' : '正在冻结快照…';
  const tailContextFailed = live.tailAnnotationContextStatus === 'failed';
  const qaRecordedAudio = useMemo(createControlledQaRecording, []);
  const feedbackVisible = state.realtimeFeedbackVisible;
  const defaultFocus = getPrimaryPracticeFocus(draft.mode, draft.task.id);
  const currentHint = attempt === 'second'
    ? focus
      ? safeEnd
        ? `复讲已围绕“${focus.criterionLabel}”完成收束。`
        : `只练“${focus.criterionLabel}”，其他问题留到下一轮。`
      : safeEnd
        ? '自由复讲已完成收束；两遍原句会保留，但不会生成虚假的焦点改善结论。'
        : '自由复讲：保持同一题目，尝试把刚才最想表达的内容说得更清楚。'
    : activeHint?.text ?? defaultFocus.drillInstruction;
  const [aiSetupOpen, setAiSetupOpen] = useState(false);
  const [aiActionPending, setAiActionPending] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [transcriptionRetrying, setTranscriptionRetrying] = useState(false);
  const [modelInstallProgress, setModelInstallProgress] =
    useState<GetLocalAsrModelInstallStatusOutput | null>(null);
  const [modelInstallCancelPending, setModelInstallCancelPending] = useState(false);
  const [modelInstallCancellationRequested, setModelInstallCancellationRequested] = useState(false);
  const inputDevices = recorder.inputDevices ?? [];
  const selectedInputDeviceId = recorder.selectedInputDeviceId ?? null;
  const selectedInputDevice = inputDevices.find(
    (device) => device.deviceId === selectedInputDeviceId,
  );
  const inputDeviceLabel = recorder.inputHealth?.trackLabel
    || selectedInputDevice?.label
    || '系统默认麦克风';
  const inputIsSilent = recorder.inputHealth?.status === 'silent'
    && (recording || Boolean(recorder.recordedAudio));
  const modelInstalling = live.localAsrInstallStatus === 'installing'
    || modelInstallStatusIsActive(modelInstallProgress);
  const tailProcessing = !recording
    && Boolean(recordedAudio)
    && !safeEnd
    && !repairRequired
    && !live.shortRecordingPending
    && (state.capture === 'recorded' || state.capture === 'finalizing');
  const analysisChannelCopy = (() => {
    if (tailContextFailed) {
      return { title: '任务核对待重试', detail: 'task_gap 尚未生成 · 快照尚未冻结' };
    }
    if (safeEnd) {
      return snapshotReady
        ? { title: 'Deep Lane 排队', detail: '完整报告不阻塞已持久化快照' }
        : state.report === 'failed'
          ? { title: 'Deep Lane 未入队', detail: '快照保存失败，当前仍停留在本页' }
          : { title: '正在持久化快照', detail: '持久化成功后才能进入准确复盘' };
    }
    if (state.network === 'offline') {
      return { title: '网络已中断 · 本地继续', detail: '录音、转写和本地标注不停；AI 短提示暂停' };
    }
    if (state.network === 'recovering') {
      return { title: '网络恢复中 · 本地继续', detail: '累计 final 保留，等通道恢复后再请求短提示' };
    }
    if (!feedbackVisible) {
      return {
        title: state.liveAiEnabled ? 'AI 通道继续 · 反馈已隐藏' : '本地分析 · 反馈已隐藏',
        detail: '实时反馈已隐藏 · 分析通道仍运行',
      };
    }
    if (!state.liveAiEnabled) {
      return { title: '本地分析', detail: '等待累计 final 文本' };
    }
    if (state.analysis === 'ai_failed') {
      return { title: 'AI 暂不可用 · 本地继续', detail: '短提示未到达；转写和本地标注不受影响' };
    }
    if (state.analysis === 'ai_pending') {
      return { title: 'AI 实时处理中', detail: '正在使用累计 final 生成短提示' };
    }
    if (activeHint || state.analysis === 'hint_ready') {
      return { title: '短提示已到达 · 暂定', detail: '短提示不是最终诊断；完整报告不阻塞' };
    }
    if (state.asr === 'idle') {
      return { title: 'AI 已开启 · 待录音', detail: '建立本地 ASR 后才发送累计 final' };
    }
    return { title: 'AI 已开启 · 等待 final', detail: '只有已落定原句才会进入短提示请求' };
  })();
  const captureHealthCopy = (() => {
    if (repairRequired) {
      return {
        detail: recordedAudio ? '录音已保留，按下方恢复操作继续' : '当前 take 不完整，需要重新录制',
        title: '采集需要处理',
        tone: 'warning',
      };
    }
    if (inputIsSilent) {
      return {
        detail: `${inputDeviceLabel} 持续未检测到有效输入`,
        title: '没有听到麦克风输入',
        tone: 'warning',
      };
    }
    if (safeEnd) {
      return {
        detail: `${finalCount} final · ${snapshotReady ? '快照已持久化' : '正在持久化快照'}`,
        title: '本遍已安全收束',
        tone: 'complete',
      };
    }
    if (modelInstalling) {
      return {
        detail: '本地转写模型完成前不会请求麦克风',
        title: '正在准备转写环境',
        tone: 'preparing',
      };
    }
    if (live.localAsrReadiness === 'model_missing') {
      return {
        detail: '先安装固定版本本地模型，再开始录音',
        title: '转写模型尚未安装',
        tone: 'preparing',
      };
    }
    if (
      live.localAsrReadiness === 'check_failed'
      || state.capture === 'permission_denied'
      || recorder.status === 'error'
    ) {
      return {
        detail: state.capture === 'permission_denied'
          ? '请在系统设置中允许麦克风访问，再重新检查'
          : '按下方主操作重新检查环境',
        title: state.capture === 'permission_denied' ? '麦克风权限未就绪' : '采集环境检查失败',
        tone: 'warning',
      };
    }
    if (live.localAsrReadiness === 'checking') {
      return {
        detail: '正在核对本地模型与运行环境',
        title: '正在检查转写环境',
        tone: 'preparing',
      };
    }
    if (stopRequested || tailProcessing) {
      return {
        detail: `${finalCount} final 已保留，正在等待尾句与快照`,
        title: '正在安全收束这一遍',
        tone: 'finalizing',
      };
    }
    if (recording) {
      return {
        detail: `${inputDeviceLabel} · ${finalCount} final${state.asr === 'partial' ? ' · partial 正在修订' : ''}`,
        title: state.voiceDetected || finalCount > 0 ? '录音与转写正常' : '录音中，等待你开口',
        tone: 'active',
      };
    }
    if (recorder.status === 'requesting') {
      return {
        detail: '仅用于本次本地录音与转写',
        title: '正在请求麦克风权限',
        tone: 'preparing',
      };
    }
    return {
      detail: `${inputDeviceLabel} · 本地处理 · 未发送文本`,
      title: '采集环境已就绪',
      tone: 'ready',
    };
  })();
  const primaryActionPhase = recording
    ? 'stop'
    : tailProcessing
      ? 'tail_processing'
      : tailContextFailed
        ? 'retry_task_context'
        : repairRequired && !recordedAudio
          ? 'repair_without_audio'
          : live.shortRecordingPending && recordedAudio
            ? 'accept_short_recording'
            : safeEnd && recordedAudio
              ? snapshotReady
                ? 'accept_snapshot'
                : state.report === 'failed'
                  ? 'retry_snapshot'
                  : 'persisting_snapshot'
              : safeEnd && !recordedAudio && live.qa
                ? snapshotReady
                  ? 'accept_snapshot'
                  : state.report === 'failed' ? 'retry_snapshot' : 'persisting_snapshot'
                : !recording && !recordedAudio && !safeEnd && !repairRequired
                  ? 'start'
                  : 'none';
  const liveStatusAnnouncement = stopRequested
    ? '已收到结束录音请求，正在保留末尾音频。'
    : recording
      ? '录音已开始。主操作已切换为结束录音。'
      : tailContextFailed
        ? '任务上下文读取失败。final 句段已保留，快照尚未冻结；主操作已切换为重试任务核对。'
        : state.capture === 'finalizing'
          ? '录音已停止，正在收束尾句。'
          : live.shortRecordingPending
            ? '录音不足二十秒。可以重录，也可以确认仍使用这遍。'
            : repairRequired
              ? live.localAsrReadiness === 'model_missing'
                ? '转写模型缺失。录音仍保留；主操作已切换为安装模型并重新转写这段录音。'
                : live.hasRetryableCapturedPcm
                  ? '转写未完整落定。录音仍保留；可以直接重新转写，或更换输入设备后重录。'
                  : finalCount > 0
                    ? '转写在已有 final 后中断。为避免重复账本，已落定原句会保留，但这遍需要重新录制。'
                    : '本遍没有可重放的本地 PCM。录音可回放，但转写需要切换或检查输入设备后重录。'
              : safeEnd && snapshotReady
                ? `快照已安全持久化。主操作已切换为${attempt === 'first' ? '确认逐字稿' : '选择下一步'}。`
                : safeEnd && state.report === 'failed'
                  ? '快照保存失败。主操作已切换为重试保存快照。'
                  : safeEnd
                    ? '尾句已收束，正在持久化冻结快照。'
                    : recorder.status === 'requesting'
                      ? '正在请求麦克风权限。'
                      : '录音已就绪。';
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const tailProcessingRef = useRef<HTMLSpanElement>(null);
  const aiSetupTriggerRef = useRef<HTMLButtonElement>(null);
  const liveAiToggleRef = useRef<HTMLInputElement>(null);
  const previousPrimaryActionPhase = useRef(primaryActionPhase);
  const restorePrimaryActionFocus = useRef(false);

  useEffect(() => {
    let disposed = false;
    const loadStatus = async () => {
      try {
        const status = await getLocalAsrModelInstallStatus();
        if (!disposed) setModelInstallProgress(status);
      } catch {
        // Keep recording controls usable if an older bridge lacks install status.
      }
    };
    void loadStatus();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (modelInstallProgress?.stage === 'completed') {
      void live.refreshLocalAsrReadiness();
    }
  }, [live.refreshLocalAsrReadiness, modelInstallProgress?.stage]);

  useEffect(() => {
    if (!modelInstalling) {
      setModelInstallCancelPending(false);
      return undefined;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const status = await getLocalAsrModelInstallStatus();
        if (!disposed) setModelInstallProgress(status);
      } catch {
        // The installer Promise remains authoritative if one progress read fails.
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 500);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [modelInstalling]);

  useEffect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      if (
        event.target !== primaryActionRef.current
        && event.target !== tailProcessingRef.current
      ) restorePrimaryActionFocus.current = false;
    };
    document.addEventListener('focusin', handleFocusIn);
    return () => document.removeEventListener('focusin', handleFocusIn);
  }, []);

  useLayoutEffect(() => {
    if (previousPrimaryActionPhase.current === primaryActionPhase) return;
    previousPrimaryActionPhase.current = primaryActionPhase;
    const action = primaryActionPhase === 'tail_processing'
      ? tailProcessingRef.current
      : primaryActionRef.current;
    const actionDisabled = action instanceof HTMLButtonElement && action.disabled;
    if (restorePrimaryActionFocus.current && action && !actionDisabled) {
      action.focus({ preventScroll: true });
    }
  }, [primaryActionPhase]);

  const keepFocusWithPrimaryAction = () => {
    restorePrimaryActionFocus.current = true;
  };

  const handleReadyToRecordAction = async () => {
    keepFocusWithPrimaryAction();
    if (live.localAsrReadiness === 'model_missing') {
      setModelInstallCancellationRequested(false);
      setModelInstallProgress(null);
      await live.installLocalAsrModel();
      return;
    }
    if (live.localAsrReadiness === 'check_failed') {
      await live.refreshLocalAsrReadiness();
      return;
    }
    await live.startRecording();
  };

  const installModelAndRetryCapturedAudio = async () => {
    keepFocusWithPrimaryAction();
    setTranscriptionRetrying(true);
    setModelInstallCancellationRequested(false);
    setModelInstallProgress(null);
    try {
      const installed = await live.installLocalAsrModel();
      if (installed) await live.retryTranscriptionFromCapturedPcm();
    } finally {
      setTranscriptionRetrying(false);
    }
  };

  const cancelModelInstallation = async () => {
    const cancellingPausedCheckpoint = modelInstallProgress?.stage === 'paused';
    setModelInstallCancelPending(true);
    try {
      const result = await cancelLocalAsrModelInstall();
      if (result.cancelled) {
        setModelInstallCancellationRequested(true);
        if (cancellingPausedCheckpoint) {
          const status = await getLocalAsrModelInstallStatus();
          setModelInstallProgress(status);
          setModelInstallCancelPending(false);
        } else {
          // Read the backend-owned transition immediately, then keep polling
          // until asynchronous stream cleanup publishes cancelled.
          setModelInstallProgress(await getLocalAsrModelInstallStatus());
        }
      } else setModelInstallCancelPending(false);
    } catch {
      setModelInstallCancelPending(false);
    }
  };

  const refreshModelAndRetryCapturedAudio = async () => {
    keepFocusWithPrimaryAction();
    setTranscriptionRetrying(true);
    try {
      const readiness = await live.refreshLocalAsrReadiness();
      if (readiness === 'ready') await live.retryTranscriptionFromCapturedPcm();
    } finally {
      setTranscriptionRetrying(false);
    }
  };

  const closeAiSetup = () => {
    setAiSetupOpen(false);
    window.requestAnimationFrame(() => {
      (aiSetupTriggerRef.current ?? liveAiToggleRef.current)?.focus({ preventScroll: true });
    });
  };

  const handleLiveAiToggle = async (enabled: boolean) => {
    if (aiActionPending) return;
    setAiActionPending(true);
    try {
      await live.setLiveAi(enabled);
    } finally {
      setAiActionPending(false);
    }
  };

  const handleLiveAiConsentRevoke = async () => {
    if (aiActionPending) return;
    setAiActionPending(true);
    try {
      await live.revokeLiveAiConsent();
    } finally {
      setAiActionPending(false);
    }
  };

  useEffect(() => {
    if (!recording) setStopRequested(false);
  }, [recording]);

  useEffect(() => {
    if (!restoredSnapshot || recorder.recordedAudio) return undefined;
    let active = true;
    let url: string | null = null;
    setTakePersistence('loading');
    void readAttemptRecording({ sessionId, attempt }).then((blob) => {
      if (!active) return;
      if (!blob) {
        setTakePersistence('error');
        return;
      }
      url = URL.createObjectURL(blob);
      setRestoredAudio({
        blob,
        url,
        mimeType: blob.type,
        durationMs: Math.max(1, restoredSnapshot.audioWatermark),
      });
      setTakePersistence('saved');
    }).catch(() => {
      if (active) setTakePersistence('error');
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attempt, recorder.recordedAudio, restoredSnapshot, sessionId, takeRestoreRevision]);

  useEffect(() => {
    if (
      !recorder.recordedAudio
      || !live.snapshot
      || state.capture !== 'safe_end'
      || takePersistence !== 'idle'
    ) return;
    if (persistStoppedTakeRef.current === persistStoppedTakeFallback) {
      setTakePersistence('saved');
      return;
    }
    const revision = ++takePersistenceRevision.current;
    setTakePersistence('saving');
    void persistStoppedTakeRef.current(recorder.recordedAudio, live.snapshot).then(() => {
      if (takePersistenceRevision.current === revision) setTakePersistence('saved');
    }).catch(() => {
      if (takePersistenceRevision.current === revision) setTakePersistence('error');
    });
  }, [live.snapshot, recorder.recordedAudio, state.capture, takePersistence]);

  const rerecord = async () => {
    keepFocusWithPrimaryAction();
    if (takePersistence === 'saved' || takePersistence === 'error') {
      setDiscardingTake(true);
      try {
        await onDiscardStoppedTake(durableSnapshot?.attemptId ?? null);
      } catch {
        setTakePersistence('error');
        setDiscardingTake(false);
        return;
      }
    }
    setRestoredAudio(null);
    ++takePersistenceRevision.current;
    setTakePersistence('idle');
    setDiscardingTake(false);
    live.rerecord();
  };

  useEffect(() => {
    onRecordingActivityChange?.(recordingActivity);
  }, [onRecordingActivityChange, recordingActivity]);

  useEffect(() => {
    if (recordingActivity) onRecordingGuardReasonChange?.(recordingActivityReason);
  }, [onRecordingGuardReasonChange, recordingActivity, recordingActivityReason]);

  useEffect(() => () => {
    onRecordingActivityChange?.(false);
  }, [onRecordingActivityChange]);

  return (
    <div className={`live-practice-page${recordedAudio && !recording ? ' has-recording-review' : ''}`}>
      <p aria-atomic="true" aria-live="polite" className="sr-only">{liveStatusAnnouncement}</p>
      <section className="channel-strip" aria-label="实时通道状态">
        <div className="capture-health-summary" data-tone={captureHealthCopy.tone}>
          <span aria-hidden="true" className="capture-health-dot" />
          <span><strong>{captureHealthCopy.title}</strong><small>{captureHealthCopy.detail}</small></span>
          <span className="capture-health-privacy">本地采集</span>
        </div>
        <details className="capture-health-details">
          <summary>采集详情</summary>
          <div className="channel-details-grid">
            <div className="recording-channel" data-state={state.capture}>
              <Mic aria-hidden="true" size={18} />
              <span><strong>{safeEnd ? '录音已结束' : stopRequested ? '正在结束录音' : recording ? `正在录音 · ${live.qa && finalCount ? '00:34' : formatDuration(recorder.elapsedMs)}` : STATUS_COPY[state.capture]}</strong><small>{safeEnd ? `${formatDuration(recordedAudio?.durationMs ?? recorder.elapsedMs)} · 尾句已收束` : stopRequested ? `正在保留末尾音频 · ${inputDeviceLabel}` : recording ? inputIsSilent ? `未检测到输入 · ${inputDeviceLabel}` : state.voiceDetected ? `已检测到有效语音 · ${inputDeviceLabel}` : `正在监听 · ${inputDeviceLabel}` : repairRequired ? recordedAudio ? `音频已保留 · ${inputDeviceLabel}` : '当前录音不可用 · 需要重新录制' : `开始后请求 · ${inputDeviceLabel}`}</small></span>
              {inputDevices.length > 0 ? (
                <label className="recording-input-select">
                  <span className="sr-only">麦克风输入设备</span>
                  <select
                    aria-describedby="microphone-switch-hint"
                    aria-label="麦克风输入设备"
                    disabled={recording || recorder.status === 'requesting'}
                    onChange={(event) => recorder.selectInputDevice(event.target.value || null)}
                    title={recording ? '录音中不能切换输入设备；结束后可以切换并重录。' : '为下一遍选择麦克风'}
                    value={selectedInputDeviceId ?? ''}
                  >
                    <option value="">系统默认</option>
                    {inputDevices.filter((device) => device.deviceId !== 'default').map((device, index) => (
                      <option key={device.deviceId || `input-${index}`} value={device.deviceId}>
                        {device.label || `麦克风 ${index + 1}`}
                      </option>
                    ))}
                  </select>
                  <span className="sr-only" id="microphone-switch-hint">录音中不能切换输入设备；结束后可以切换并重录。</span>
                </label>
              ) : null}
            </div>
            <div className="transcript-channel" data-state={state.asr}><Radio aria-hidden="true" size={18} /><span><strong>{ASR_STATUS_COPY[state.asr]}</strong><small>{finalCount} final · {state.asr === 'partial' ? '当前含临时 partial' : state.asr === 'failed' ? '不会冻结不完整逐字稿' : state.asr === 'no_speech' ? '录音仍继续，可直接开始说话' : '当前无临时 partial'}</small></span></div>
            <div className="analysis-channel" data-state={state.analysis}>{state.network === 'offline' ? <CloudOff aria-hidden="true" size={18} /> : <BrainCircuit aria-hidden="true" size={18} />}<span><strong>{analysisChannelCopy.title}</strong><small>{analysisChannelCopy.detail}</small></span></div>
          </div>
        </details>
      </section>

      <header className="live-context-bar">
        <div className="live-context-copy">
          <p className="eyebrow">{safeEnd ? snapshotReady ? `${attempt === 'first' ? '初讲' : '复讲'}快照 v1 · 已持久化` : state.report === 'failed' ? `${attempt === 'first' ? '初讲' : '复讲'} · 快照保存失败` : `${attempt === 'first' ? '初讲' : '复讲'} · 正在持久化快照` : `${attempt === 'first' ? '初讲' : '复讲'} · ${viewMode === 'focus' ? '专注练习' : '实时证据'}`}</p>
          <h1>{viewMode === 'focus'
            ? safeEnd ? '这一遍已经说完，原句完整保留' : '先把这一遍说完'
            : feedbackVisible ? safeEnd ? '原句问题已标注，左右仍按句对齐' : '原句与问题逐句对齐' : safeEnd ? '转录原文已冻结，实时反馈已隐藏' : '转录原文继续记录，实时反馈已隐藏'}</h1>
        </div>
        <div className="live-view-controls">
          {viewMode === 'evidence' && feedbackVisible ? <div className="evidence-legend" aria-label="证据语义图例"><span className="legend-amber">冗余</span><span className="legend-blue">清晰</span><span className="legend-neutral">节奏</span><span className="legend-teal">结构</span></div> : null}
          <div
            aria-label="实时工作区视图"
            className="live-view-tabs"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
              const currentIndex = tabs.findIndex((tab) => tab === document.activeElement);
              if (currentIndex < 0) return;
              event.preventDefault();
              const nextIndex = event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : event.key === 'ArrowRight'
                    ? (currentIndex + 1) % tabs.length
                    : (currentIndex - 1 + tabs.length) % tabs.length;
              tabs[nextIndex]?.click();
              tabs[nextIndex]?.focus();
            }}
            role="tablist"
          >
            <button aria-controls="live-focus-panel" aria-selected={viewMode === 'focus'} className={viewMode === 'focus' ? 'is-active' : ''} id="live-focus-tab" onClick={() => setViewMode('focus')} role="tab" tabIndex={viewMode === 'focus' ? 0 : -1} type="button">专注</button>
            <button aria-controls="live-evidence-panel" aria-selected={viewMode === 'evidence'} className={viewMode === 'evidence' ? 'is-active' : ''} id="live-evidence-tab" onClick={() => setViewMode('evidence')} role="tab" tabIndex={viewMode === 'evidence' ? 0 : -1} type="button">证据</button>
          </div>
        </div>
      </header>

      <div className="degradation-stack">
        {state.lastError ? <p className="degradation-banner" role="alert">{state.lastError}</p> : null}
        {!recording && !recorder.recordedAudio && live.localAsrReadiness === 'model_missing' ? (
          modelInstallProgress?.stage === 'paused' ? (
            <div className="degradation-banner model-install-progress">
              <span role="status">{formatLocalAsrModelInstallProgress(modelInstallProgress)}；点击继续安装会从这里续传。</span>
              <button
                className="secondary-button"
                disabled={modelInstallCancelPending || !modelInstallProgress.cancellable}
                onClick={() => void cancelModelInstallation()}
                type="button"
              >
                {modelInstallCancelPending ? '正在删除…' : '删除已下载进度'}
              </button>
            </div>
          ) : <p className="degradation-banner" role="alert">本地转写模型尚未安装。默认分段下载约 226 MB 的固定版本运行文件，支持断点续传和 SHA-256 校验；普通断网或超时只保留断点，只有官方三文件源明确不兼容安全分段、跳转或完整性校验时才使用约 1 GB 备用整包。完成前不会请求麦克风。</p>
        ) : null}
        {!recording && !recorder.recordedAudio && live.localAsrReadiness === 'check_failed' ? (
          <p className="degradation-banner" role="alert">本地转写环境检查失败；请重新检查后再开始录音。</p>
        ) : null}
        {modelInstalling ? (
          <div className="degradation-banner model-install-progress">
              <span>
              {modelInstallProgress
                ? formatLocalAsrModelInstallProgress(modelInstallProgress)
                : '正在准备分段下载并校验约 226 MB 的固定版本运行文件'}
              ；完成前不会请求麦克风，当前练习与下载进度会保留。
            </span>
            <button
              className="secondary-button"
              disabled={
                modelInstallCancelPending
                || modelInstallProgress?.cancellable === false
              }
              onClick={() => void cancelModelInstallation()}
              type="button"
            >
              {modelInstallCancelPending ? '正在取消…' : '取消安装'}
            </button>
          </div>
        ) : null}
        {modelInstallCancellationRequested && !modelInstalling ? (
          <p className="degradation-banner" role="status">模型安装已取消；临时下载会清理，原有模型和当前录音不受影响。</p>
        ) : null}
        {modelInstallProgress?.stage === 'failed' && live.localAsrInstallStatus === 'idle' ? (
          <p className="degradation-banner" role="alert">模型安装暂时中断；如果已下载部分数据，重新安装会从保留进度继续。</p>
        ) : null}
        {live.localAsrInstallError && !modelInstallCancellationRequested ? <p className="degradation-banner" role="alert">{live.localAsrInstallError}</p> : null}
        {inputIsSilent ? <p className="degradation-banner" role="alert">“{inputDeviceLabel}”持续未检测到有效输入。请确认系统输入音量和静音状态；停止后可在上方切换麦克风再重录。</p> : null}
        {live.tailAnnotationContextError ? <p className="degradation-banner" role="alert">{live.tailAnnotationContextError}</p> : null}
        {recorder.error && recorder.error !== state.lastError ? <p className="degradation-banner" role="alert">{recorder.error}</p> : null}
      </div>

      {viewMode === 'focus' ? (
        <LiveFocusSurface
          attempt={attempt}
          currentHint={currentHint}
          id="live-focus-panel"
          labelledBy="live-focus-tab"
          safeEnd={safeEnd}
          state={state}
        />
      ) : (
        <EvidenceLedger
          currentHint={currentHint}
          id="live-evidence-panel"
          labelledBy="live-evidence-tab"
          state={state}
        />
      )}

      {recordedAudio && !recording ? (
        <section className="recording-review" aria-label="本遍录音回放">
          <p className="eyebrow">本遍录音 · {formatDuration(recordedAudio.durationMs)}</p>
          <audio controls preload="metadata" src={recordedAudio.url}>
            当前环境不能播放这段录音。
          </audio>
          {live.shortRecordingPending ? <p>不足 20 秒：可以回放后仍使用，但证据可能不足；也可以直接重录。</p> : null}
          {repairRequired ? <p>{live.localAsrReadiness === 'model_missing' && live.hasRetryableCapturedPcm ? '本地模型尚未就绪；音频和可用 PCM 已保留。安装完成后可直接重新转写这段录音。' : live.hasRetryableCapturedPcm ? '实时转写没有得到完整 final；可直接重新转写这段录音，或切换输入设备后重录。' : finalCount > 0 ? '实时转写在已有 final 后中断。为避免从头重放造成重复原句，本遍只保留回放和已落定证据，请切换输入设备后重录。' : '本遍没有可重放的本地 PCM；录音仍可回放，但需要检查或切换输入设备后重录。'}</p> : null}
        </section>
      ) : null}

      {live.qa && !recording && !state.segments.length ? <button className="qa-seed-button" onClick={live.runQaSequence} type="button">载入可控 ASR 流</button> : null}
      {live.qa && state.segments.length > 0 && !safeEnd ? <button className="qa-seed-button" onClick={live.qaSafeEnd} type="button">完成尾句收束</button> : null}

      <footer className="recording-command-bar">
        <div className="live-stats" aria-label="本轮实时统计"><span><strong>{live.qa && finalCount && !safeEnd ? '34 秒' : formatDuration(recorder.elapsedMs)}</strong><small>{attempt === 'first' ? '初讲' : '复讲'}</small></span><span><strong>{finalCount} final</strong><small>句段已落定</small></span><span><strong>{feedbackVisible ? `${retainedCount} 条记录` : '反馈已隐藏'}</strong><small>{feedbackVisible ? state.annotations.some((item) => item.lifecycle === 'withdrawn') ? '含 1 次撤回' : '原文 + 问题实时留存' : '不影响转录与通道状态'}</small></span></div>
        <div className="footer-actions">
        <details
          className="feedback-settings"
          onToggle={(event) => {
            if (!event.currentTarget.open && aiSetupOpen) setAiSetupOpen(false);
          }}
        >
          <summary>反馈设置</summary>
          <section className="live-controls" aria-label="实时反馈控制">
            <label><input checked={state.realtimeFeedbackVisible} onChange={(event) => live.setFeedbackVisible(event.target.checked)} type="checkbox" />显示实时反馈</label>
            <label><input checked={state.localAnnotationsEnabled} onChange={(event) => live.setLocalAnnotations(event.target.checked)} type="checkbox" />本地标注（仅后续 final）</label>
            {live.liveAiReadiness === 'ready' ? (
              <label title="配置级同意不会自动开启；每次练习都需要在这里确认。"><input checked={state.liveAiEnabled} disabled={aiActionPending} onChange={(event) => void handleLiveAiToggle(event.target.checked)} ref={liveAiToggleRef} type="checkbox" />实时 AI（本次）</label>
            ) : (
              <button
                aria-controls="live-ai-setup-panel"
                aria-expanded={aiSetupOpen}
                className="text-button live-ai-setup-trigger"
                onClick={() => setAiSetupOpen((open) => !open)}
                ref={aiSetupTriggerRef}
                type="button"
              >
                {live.liveAiReadiness === 'loading' ? '正在检查实时 AI…' : aiSetupOpen ? '收起实时 AI 设置' : '设置实时 AI'}
              </button>
            )}
            <span className="feedback-ai-status">{aiActionPending ? '正在更新本次 AI 状态…' : live.liveAiReadiness === 'ready' ? state.liveAiEnabled ? '本次已开启；短提示只读取累计 final。' : '配置已就绪；这次练习仍需显式开启。' : live.liveAiReadiness === 'key_missing' ? '缺少 API Key' : live.liveAiReadiness === 'consent_missing' ? '待批准配置级同意' : live.liveAiReadiness === 'purpose_disabled' ? '实时短提示用途未开启' : live.liveAiReadiness === 'load_failed' ? 'AI 配置读取失败' : live.liveAiReadiness === 'session_unavailable' ? '本轮 AI 会话尚未建立' : '正在检查本轮 AI 配置'}</span>
            {state.liveAiConsentValid ? <button className="text-button" disabled={aiActionPending} onClick={() => void handleLiveAiConsentRevoke()} type="button">撤回 live_hint 同意</button> : null}
            <span className="feedback-control-note">关闭本地标注只影响之后落定的句段；已有记录保留，显示由“显示实时反馈”控制。</span>
            {aiSetupOpen ? (
              <LiveAiSetup
                onCancel={closeAiSetup}
                onReady={async () => {
                  const readiness = await live.refreshLiveAiReadiness();
                  if (readiness !== 'ready') return false;
                  const enabled = await live.setLiveAi(true);
                  if (!enabled) return false;
                  closeAiSetup();
                  return true;
                }}
              />
            ) : null}
          </section>
        </details>
        <span className="retained-pill">{feedbackVisible ? '原文 + 记录实时留存' : '转录原文实时留存'}</span>
        {!recording && !recordedAudio && !safeEnd && !repairRequired ? <button className="primary-button" disabled={live.resetting || recorder.status === 'requesting' || live.localAsrReadiness === 'checking' || modelInstalling} onClick={() => void handleReadyToRecordAction()} onFocus={keepFocusWithPrimaryAction} ref={primaryActionRef} type="button"><Mic aria-hidden="true" size={17} />{modelInstalling ? '正在安装本地模型…' : live.localAsrReadiness === 'checking' ? '正在检查转写环境…' : live.localAsrReadiness === 'model_missing' ? modelInstallProgress?.stage === 'paused' ? '继续安装本地转写模型' : '安装本地转写模型（约 226 MB）' : live.localAsrReadiness === 'check_failed' ? '重新检查转写环境' : recorder.status === 'error' || state.capture === 'permission_denied' ? '重新检查麦克风' : '开始录音'}</button> : null}
        {recording ? <button className="stop-recording-button" disabled={stopRequested} onClick={() => { keepFocusWithPrimaryAction(); setStopRequested(true); recorder.stop(); }} onFocus={keepFocusWithPrimaryAction} ref={primaryActionRef} type="button"><CircleStop aria-hidden="true" size={17} />{stopRequested ? '正在结束…' : '结束录音'}</button> : null}
        {tailProcessing ? <span aria-live="polite" className="processing-action" ref={tailProcessingRef} role="status" tabIndex={-1}>录音已停止 · 正在完成尾句转写与快照保存…</span> : null}
        {tailContextFailed ? <button className="primary-button" onClick={() => { keepFocusWithPrimaryAction(); live.retryTailAnnotationContext(); }} onFocus={keepFocusWithPrimaryAction} ref={primaryActionRef} type="button">重试任务核对并冻结</button> : null}
        {!recording && recordedAudio && (safeEnd || repairRequired || live.shortRecordingPending) ? <button className="secondary-button" disabled={busy || live.resetting || transcriptionRetrying || discardingTake || takePersistence === 'loading' || takePersistence === 'saving'} onClick={() => void rerecord()} type="button">{discardingTake ? '正在丢弃当前 take…' : live.resetting ? '正在重置…' : repairRequired ? '换输入设备并重录' : '重录这遍'}</button> : null}
        {repairRequired && recorder.recordedAudio && live.hasRetryableCapturedPcm && live.localAsrReadiness === 'ready' ? <button className="primary-button" disabled={transcriptionRetrying || busy} onClick={() => { keepFocusWithPrimaryAction(); setTranscriptionRetrying(true); void live.retryTranscriptionFromCapturedPcm().finally(() => setTranscriptionRetrying(false)); }} onFocus={keepFocusWithPrimaryAction} ref={primaryActionRef} type="button">{transcriptionRetrying ? '正在重新转写…' : '用这段录音重新转写'}</button> : null}
        {repairRequired && recorder.recordedAudio && live.hasRetryableCapturedPcm && live.localAsrReadiness === 'model_missing' ? <button className="primary-button" disabled={transcriptionRetrying || busy || modelInstalling} onClick={() => void installModelAndRetryCapturedAudio()} onFocus={keepFocusWithPrimaryAction} ref={primaryActionRef} type="button">{transcriptionRetrying || modelInstalling ? '正在安装并重新转写…' : '安装模型并重新转写这段录音'}</button> : null}
        {repairRequired && recorder.recordedAudio && live.hasRetryableCapturedPcm && live.localAsrReadiness === 'checking' ? <button className="primary-button" disabled type="button">正在检查转写环境…</button> : null}
        {repairRequired && recorder.recordedAudio && live.hasRetryableCapturedPcm && live.localAsrReadiness === 'check_failed' ? <button className="primary-button" disabled={transcriptionRetrying || busy} onClick={() => void refreshModelAndRetryCapturedAudio()} onFocus={keepFocusWithPrimaryAction} ref={primaryActionRef} type="button">{transcriptionRetrying ? '正在重新检查并转写…' : '重新检查并转写这段录音'}</button> : null}
        {restoredTakeUnavailable ? <button className="secondary-button" disabled={discardingTake} onClick={() => { setTakePersistence('loading'); setTakeRestoreRevision((revision) => revision + 1); }} type="button">重试读取已保存录音</button> : null}
        {repairRequired && !recorder.recordedAudio ? <button className="primary-button" disabled={live.resetting || discardingTake || takePersistence === 'loading'} onClick={() => { keepFocusWithPrimaryAction(); void rerecord(); }} onFocus={keepFocusWithPrimaryAction} ref={primaryActionRef} type="button">{discardingTake ? '正在丢弃当前 take…' : live.resetting ? '正在重置…' : restoredTakeUnavailable ? '丢弃不可用 take 并重录' : '重置后重新录音'}</button> : null}
        {live.shortRecordingPending && recorder.recordedAudio ? <button className="primary-button" disabled={busy || live.resetting} onClick={() => { keepFocusWithPrimaryAction(); live.acceptShortRecording(); }} onFocus={keepFocusWithPrimaryAction} ref={primaryActionRef} type="button">仍使用这遍</button> : null}
        {safeEnd && recordedAudio && takePersistence === 'error' ? <button className="secondary-button" disabled={busy || discardingTake} onClick={() => setTakePersistence('idle')} type="button">重试保存当前 take</button> : null}
        {safeEnd && recordedAudio ? <button className="primary-button" disabled={busy || takePersistence !== 'saved' || (!snapshotReady && state.report !== 'failed')} onClick={() => { keepFocusWithPrimaryAction(); if (durableSnapshot) onAccept(recordedAudio, durableSnapshot); else live.retrySnapshotPersistence(); }} onFocus={keepFocusWithPrimaryAction} ref={primaryActionRef} type="button">{busy ? '正在保存录音…' : takePersistence === 'loading' ? '正在恢复已保存录音…' : takePersistence === 'saving' ? '正在持久化录音与快照…' : takePersistence === 'error' ? '录音持久化失败，请重录' : !snapshotReady ? snapshotPendingLabel : attempt === 'first' ? '继续：确认逐字稿' : '继续：选择下一步'}</button> : null}
        {safeEnd && !recorder.recordedAudio && live.qa ? <button className="primary-button" disabled={busy || (!snapshotReady && state.report !== 'failed')} onClick={() => { keepFocusWithPrimaryAction(); if (durableSnapshot) onAccept(qaRecordedAudio, durableSnapshot); else live.retrySnapshotPersistence(); }} onFocus={keepFocusWithPrimaryAction} ref={primaryActionRef} type="button">{busy ? '正在保存受控录音…' : snapshotReady ? attempt === 'first' ? '确认逐字稿' : '选择下一步' : snapshotPendingLabel}</button> : null}
        {saveError ? <p className="inline-error" role="alert">{saveError}</p> : null}
        </div>
      </footer>
    </div>
  );
}
