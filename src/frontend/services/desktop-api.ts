import type {
  Accent,
  FeedAsrOutput,
  PracticeArtifact,
  PhrioDesktopApi,
  PracticeSession,
  SessionEvent,
  SessionStatus,
} from '../../shared';
import {
  P1_MODE_PACKS,
  getSessionCompletionPath,
  listFrozenPracticeFocusOptions,
} from '../../shared';
import type {
  AppAppearanceSettings,
  AttemptKind,
  HistoryItemView,
  PracticeDraft,
  ScreenId,
  SelectedPracticeFocus,
  TextScale,
} from '../types/ui';

export interface SaveAudioInput {
  sessionId: string;
  attemptId: string;
  attempt: AttemptKind;
  bytes: Uint8Array;
  mimeType: string;
  durationMs: number;
}

export interface SaveAudioResult {
  attemptId: string;
}

export interface ResumableSessionView {
  sessionId: string;
  status: SessionStatus;
  screen: ScreenId;
  draft: PracticeDraft;
  selectedFocus?: SelectedPracticeFocus | null;
  resumeBlockedReason?: string | null;
}

export interface DesktopBootstrapView {
  onboardingCompleted: boolean;
  activeSession: ResumableSessionView | null;
}

export interface PracticeRecordView {
  readonly session: PracticeSession;
  readonly artifacts: readonly PracticeArtifact[];
  readonly resumable: ResumableSessionView;
}

export type AudioRetentionPreference = 'delete_on_complete' | 'keep_with_session';

const FALLBACK_SETTINGS: AppAppearanceSettings = {
  theme: 'system',
  lightPalette: 'flow-teal',
  darkPalette: 'flow-teal',
  textScale: 1,
  reduceMotion: false,
};

const SUPPORTED_TEXT_SCALES: readonly TextScale[] = [0.9, 1, 1.125, 1.25];

function getBridge(): PhrioDesktopApi | undefined {
  if ('phrio' in window) return window.phrio;
  if (import.meta.env.DEV) return undefined;
  throw new Error('PHRIO_DESKTOP_BRIDGE_UNAVAILABLE');
}

function attemptSlot(attempt: AttemptKind): 'initial' | 'retry' {
  return attempt === 'first' ? 'initial' : 'retry';
}

function screenForStatus(status: SessionStatus): ScreenId {
  const screens: Record<SessionStatus, ScreenId> = {
    setup: 'S03',
    first_attempt: 'S04',
    transcript_review: 'S05',
    diagnosis: 'S06',
    focus: 'S06',
    drill: 'S07',
    second_attempt: 'S08',
    comparison: 'S09',
    completed: 'S10',
    abandoned: 'S10',
  };
  return screens[status];
}

export function resumableSession(session: PracticeSession): ResumableSessionView {
  const task = session.taskSnapshot;
  const mode = P1_MODE_PACKS.find((candidate) => candidate.id === session.modeId);
  let focusOption;
  let resumeBlockedReason: string | null = null;
  if (session.focus) {
    try {
      focusOption = listFrozenPracticeFocusOptions(session.taskSnapshot, session.modeVersion).find(
        (candidate) => candidate.criterionId === session.focus?.criterionId && candidate.drillId === session.focus.drillId,
      );
      if (!focusOption) resumeBlockedReason = '冻结的训练焦点或 Drill 无法解析；记录仍可查看，但不能继续复讲。';
    } catch {
      resumeBlockedReason = '这条旧记录缺少可验证的冻结 Rubric/Drill 定义；记录仍可查看，但不能用当前定义继续。';
    }
  }
  return {
    sessionId: session.id,
    status: session.status,
    screen: screenForStatus(session.status),
    selectedFocus: session.focus && focusOption ? {
      ...focusOption,
      guidanceSource: session.focus.guidanceSource,
      evidenceIds: session.focus.evidenceIds,
    } : null,
    resumeBlockedReason,
    draft: {
      mode: session.modeId,
      task: {
        id: task.id,
        developmentFixture: task.developmentFixture,
        title: task.prompt,
        hint: task.description,
        mode: task.modeId,
        modeLabel: mode?.name ?? task.modeId,
        durationSeconds: task.recommendedDurationSeconds,
        audience: task.context.audience,
        goal: task.context.objective,
        successConditions: task.successConditions,
      },
      audience: task.context.audience,
      goal: task.context.objective,
      durationSeconds: task.recommendedDurationSeconds,
    },
  };
}

export async function getDesktopBootstrap(): Promise<DesktopBootstrapView> {
  const bridge = getBridge();
  if (!bridge) {
    return { onboardingCompleted: false, activeSession: null };
  }
  const bootstrap = await bridge.getBootstrap();
  return {
    onboardingCompleted: bootstrap.settings.onboardingCompleted,
    activeSession: bootstrap.activeSession
      ? resumableSession(bootstrap.activeSession)
      : null,
  };
}

export async function completeOnboarding(): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  await bridge.updateSettings({ onboardingCompleted: true });
}

export async function createPracticeSession(
  draft: PracticeDraft,
): Promise<string> {
  const bridge = getBridge();
  if (!bridge) return `preview-${Date.now()}`;

  const session = await bridge.createSession({
    modeId: draft.mode,
    taskId: draft.task.id,
    developmentFixture: draft.task.developmentFixture,
    ...(draft.task.id === 'free-expression'
      ? {
          customTask: {
            prompt: draft.task.title,
            audience: draft.audience,
            objective: draft.goal,
            durationSeconds: draft.durationSeconds,
          },
        }
      : {}),
    ...(draft.task.id !== 'free-expression'
      ? {
          taskOverrides: {
            audience: draft.audience,
            objective: draft.goal,
            durationSeconds: draft.durationSeconds,
          },
        }
      : {}),
  });
  return session.id;
}

export async function saveAttemptRecording(
  input: SaveAudioInput,
): Promise<SaveAudioResult> {
  const bridge = getBridge();
  if (!bridge) return { attemptId: `${input.attempt}-${Date.now()}` };

  const attempt = await bridge.saveAttemptAudio({
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    kind: attemptSlot(input.attempt),
    bytes: input.bytes,
    mimeType: input.mimeType,
    durationMs: input.durationMs,
  });
  return { attemptId: attempt.id };
}

export async function discardAttemptRecording(input: {
  sessionId: string;
  attempt: AttemptKind;
  attemptId?: string;
}): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  await bridge.discardAttemptAudio({
    sessionId: input.sessionId,
    kind: attemptSlot(input.attempt),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
  });
}

export async function readAttemptRecording(input: {
  sessionId: string;
  attempt: AttemptKind;
}): Promise<Blob | null> {
  const bridge = getBridge();
  if (!bridge) return null;
  const audio = await bridge.readAttemptAudio({
    sessionId: input.sessionId,
    kind: attemptSlot(input.attempt),
  });
  const bytes = new Uint8Array(audio.bytes);
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], {
    type: audio.mimeType,
  });
}

export async function transitionPracticeSession(input: {
  sessionId: string;
  event: SessionEvent;
}): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  await bridge.transitionSession(input);
}

export async function listPracticeHistory(): Promise<HistoryItemView[]> {
  const bridge = getBridge();
  if (!bridge) return [];
  const sessions = await bridge.listSessions();

  return sessions.map((session) => {
    const completionPath = getSessionCompletionPath(session);
    const modeLabel =
      session.modeId === 'decision-alignment'
        ? '决策与对齐 · 产品经理'
        : session.modeId === 'clear-expression'
          ? '清晰表达 · 通用'
          : '论证与反驳 · 辩手';
    return ({
      id: session.id,
      title: session.recordTitle ?? session.taskSnapshot.title,
      modeId: session.modeId,
      modeTag: modeLabel.split(' · ')[0]!,
      modeLabel,
      pinnedAt: session.pinnedAt,
      updatedAtIso: session.updatedAt,
      updatedAt: new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(session.updatedAt)),
      statusLabel: session.status !== 'completed'
        ? session.status === 'abandoned' ? '已结束' : '可继续这次练习'
        : completionPath === 'practice_loop_completed'
          ? '已完成完整练习闭环'
          : completionPath === 'focused_retry_without_comparison'
            ? '焦点复讲已保存 · 对比未查看'
            : completionPath === 'free_retry'
              ? '自由复讲已保存'
              : '诊断已保存',
      hasAudio: session.attempts.some((attempt) => attempt.audioRef !== null),
      focusLabel: session.focus?.label ?? '尚未选择焦点',
      guidanceLabel:
        session.guidanceSource === 'ai_evidence'
          ? 'AI 证据'
          : session.guidanceSource === 'local_metric'
            ? '本地规则'
            : session.guidanceSource === 'self_directed'
              ? '用户自选'
              : '待确认',
      hasRetry: session.attempts.length === 2,
      hasFocus: session.focus !== null,
      attemptSummary: session.attempts.length === 2
        ? '初讲 + 复讲'
        : session.attempts.length === 1
          ? '仅初讲'
          : '尚未录音',
    });
  });
}

export async function getPracticeRecord(
  sessionId: string,
): Promise<PracticeRecordView | null> {
  const bridge = getBridge();
  if (!bridge) return null;
  const session = await bridge.getSession({ sessionId });
  if (!session) return null;
  const artifacts = await bridge.listArtifacts({ sessionId });
  return { session, artifacts, resumable: resumableSession(session) };
}

export async function getPracticeSession(sessionId: string): Promise<PracticeSession | null> {
  const bridge = getBridge();
  if (!bridge) return null;
  return bridge.getSession({ sessionId });
}

export async function deletePracticeSession(sessionId: string): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  await bridge.deleteSession({ sessionId });
}

export async function renamePracticeSession(
  sessionId: string,
  title: string,
): Promise<PracticeSession> {
  const bridge = getBridge();
  if (!bridge) throw new Error('PHRIO_DESKTOP_BRIDGE_UNAVAILABLE');
  return bridge.updateSessionRecord({ sessionId, action: 'rename', title });
}

export async function setPracticeSessionPinned(
  sessionId: string,
  pinned: boolean,
): Promise<PracticeSession> {
  const bridge = getBridge();
  if (!bridge) throw new Error('PHRIO_DESKTOP_BRIDGE_UNAVAILABLE');
  return bridge.updateSessionRecord({ sessionId, action: 'set_pinned', pinned });
}

function accent(value: Accent): AppAppearanceSettings['lightPalette'] {
  return value;
}

function textScale(value: number): TextScale {
  return SUPPORTED_TEXT_SCALES.includes(value as TextScale) ? value as TextScale : 1;
}

export async function getAppSettings(): Promise<AppAppearanceSettings> {
  const bridge = getBridge();
  if (!bridge) return FALLBACK_SETTINGS;
  const settings = await bridge.getSettings();
  return {
    theme: settings.theme,
    lightPalette: accent(settings.lightAccent),
    darkPalette: accent(settings.darkAccent),
    textScale: textScale(settings.textScale),
    reduceMotion: settings.reducedMotion,
  };
}

export async function updateAppSettings(
  settings: AppAppearanceSettings,
): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  await bridge.updateSettings({
    theme: settings.theme,
    lightAccent: settings.lightPalette,
    darkAccent: settings.darkPalette,
    textScale: settings.textScale,
    reducedMotion: settings.reduceMotion,
  });
}

export async function getFavoriteTaskIds(): Promise<readonly string[]> {
  const bridge = getBridge();
  if (!bridge) return [];
  return (await bridge.getSettings()).favoriteTaskIds;
}

export async function setFavoriteTaskIds(taskIds: readonly string[]): Promise<readonly string[]> {
  const bridge = getBridge();
  if (!bridge) return [...taskIds];
  const settings = await bridge.updateSettings({ favoriteTaskIds: [...new Set(taskIds)] });
  return settings.favoriteTaskIds;
}

export async function getAudioRetentionPreference(): Promise<AudioRetentionPreference> {
  const bridge = getBridge();
  if (!bridge) return 'delete_on_complete';
  return (await bridge.getSettings()).audioRetention;
}

export async function setAudioRetentionPreference(
  audioRetention: AudioRetentionPreference,
): Promise<AudioRetentionPreference> {
  const bridge = getBridge();
  if (!bridge) return audioRetention;
  return (await bridge.updateSettings({ audioRetention })).audioRetention;
}

export async function startLocalAsr(input: {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly restartIfNoFinal?: true;
}): Promise<void> {
  const bridge = getBridge();
  if (!bridge) throw new Error('PHRIO_ASR_BRIDGE_UNAVAILABLE');
  await bridge.startAsr(input);
}

export async function feedLocalAsr(input: {
  readonly attemptId: string;
  readonly generation: number;
  readonly samples: Float32Array;
}): Promise<FeedAsrOutput> {
  const bridge = getBridge();
  if (!bridge) return null;
  return bridge.feedAsr(input);
}

export async function stopLocalAsr(input: {
  readonly attemptId: string;
  readonly generation: number;
}): Promise<FeedAsrOutput> {
  const bridge = getBridge();
  if (!bridge) return null;
  return bridge.stopAsr(input);
}

export async function savePracticeArtifact(artifact: PracticeArtifact): Promise<PracticeArtifact> {
  const bridge = getBridge();
  if (!bridge) return artifact;
  return bridge.putArtifact(artifact);
}

export async function listPracticeArtifacts(sessionId: string): Promise<readonly PracticeArtifact[]> {
  const bridge = getBridge();
  if (!bridge) return [];
  return bridge.listArtifacts({ sessionId });
}
