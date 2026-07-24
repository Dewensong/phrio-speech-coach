import { useCallback, useEffect, useRef, useState } from 'react';
import { type AttemptSnapshot, type DrillCompletion } from '../shared';

import { AppShell } from './components/app-shell';
import { ConfirmationDialog } from './components/confirmation-dialog';
import { RenamePracticeDialog } from './components/rename-practice-dialog';
import { CANONICAL_TASK, PRACTICE_TASKS } from './data/practice-catalog';
import { useTheme } from './hooks/use-theme';
import type { RecordedAudio } from './hooks/use-audio-recorder';
import { AppearancePage } from './pages/appearance-page';
import { DeepComparisonPage } from './pages/deep-comparison-page';
import { DeepLanePage } from './pages/deep-lane-page';
import { DrillPage } from './pages/drill-page';
import { DemoExperiencePage } from './pages/demo-experience-page';
import { FirstRunPage } from './pages/first-run-page';
import { FavoriteTasksPage } from './pages/favorite-tasks-page';
import { HistoryPage } from './pages/history-page';
import { HomePage } from './pages/home-page';
import { SettingsPage } from './pages/settings-page';
import { LivePracticePage } from './pages/live-practice-page';
import { PracticeRecordDetailPage } from './pages/practice-record-detail-page';
import { PracticeSettingsPage } from './pages/practice-settings-page';
import { TaskLibraryPage } from './pages/task-library-page';
import { TrainingSetupPage } from './pages/training-setup-page';
import { TranscriptReviewPage } from './pages/transcript-review-page';
import {
  completeOnboarding,
  createPracticeSession,
  deletePracticeSession,
  discardAttemptRecording,
  getDesktopBootstrap,
  getFavoriteTaskIds,
  getPracticeSession,
  listPracticeArtifacts,
  listPracticeHistory,
  renamePracticeSession,
  saveAttemptRecording,
  savePracticeArtifact,
  setFavoriteTaskIds,
  setPracticeSessionPinned,
  transitionPracticeSession,
  type ResumableSessionView,
} from './services/desktop-api';
import { recordDiagnosticEvent } from './services/diagnostics-api';
import type {
  AttemptKind,
  HistoryItemView,
  ModeId,
  PracticeDraft,
  PracticeTask,
  ScreenId,
  SelectedPracticeFocus,
} from './types/ui';

const INITIAL_DRAFT: PracticeDraft = {
  mode: 'decision-alignment',
  task: CANONICAL_TASK,
  audience: '研发与业务负责人',
  goal: '在限制中推动一次清晰决定',
  durationSeconds: 90,
};

function isSameFrozenDraft(left: PracticeDraft, right: PracticeDraft): boolean {
  return left.mode === right.mode
    && left.task.id === right.task.id
    && left.task.title === right.task.title
    && left.audience === right.audience
    && left.goal === right.goal
    && left.durationSeconds === right.durationSeconds;
}

function isQaRoute(): boolean {
  return import.meta.env.DEV
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('qa');
}

function sortHistoryRecords(items: readonly HistoryItemView[]): HistoryItemView[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      if (left.item.pinnedAt && right.item.pinnedAt) {
        return right.item.pinnedAt.localeCompare(left.item.pinnedAt) || left.index - right.index;
      }
      if (left.item.pinnedAt) return -1;
      if (right.item.pinnedAt) return 1;
      if (left.item.updatedAtIso && right.item.updatedAtIso) {
        return right.item.updatedAtIso.localeCompare(left.item.updatedAtIso) || left.index - right.index;
      }
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

const SCREEN_COMMANDS: Record<
  ScreenId,
  { title: string; taskContext?: string; status?: string }
> = {
  S00: { title: '准备练习环境', status: '本地优先' },
  S01: { title: '新练习', status: '麦克风将在开始时请求' },
  S02: { title: '练习题库', status: '选择真实场景' },
  S03: { title: '说明为什么本周应冻结新增需求', taskContext: '决策与对齐', status: '准备开始' },
  S04: { title: '本周冻结新增需求 · 初讲' },
  S05: { title: '说明为什么本周应冻结新增需求', taskContext: '逐字稿确认', status: '冻结原句可回查' },
  S06: { title: '说明为什么本周应冻结新增需求', taskContext: '决策与对齐', status: '本地复盘已先可用' },
  S07: { title: '说明为什么本周应冻结新增需求', taskContext: '短 Drill', status: '只练一个动作' },
  S08: { title: '本周冻结新增需求 · 复讲' },
  S09: { title: '说明为什么本周应冻结新增需求', taskContext: '复讲已保存', status: '对比可选' },
  S10: { title: '练习记录', status: '仅本机' },
  S11: { title: '外观', status: '自动保存到本机' },
  S12: { title: '常规与隐私', status: '本地优先' },
  S13: { title: '本次练习', status: '冻结记录' },
  S14: { title: '收藏题目', status: '保存在本机' },
  S15: { title: '练习设置', status: '自动保存到本机' },
  S16: { title: '30 秒受控演示', status: '不请求麦克风 · 不创建记录' },
};

const STAGE_BY_SCREEN: Partial<Record<ScreenId, number>> = {
  S01: 0,
  S03: 0,
  S04: 0,
  S05: 1,
  S06: 1,
  S07: 1,
  S08: 2,
  S09: 2,
};

export function App() {
  const [screen, setScreen] = useState<ScreenId>('S00');
  const [demoReturnScreen, setDemoReturnScreen] = useState<ScreenId>('S00');
  const [comparisonEntered, setComparisonEntered] = useState(false);
  const focusTransitionPending = useRef(false);
  const [draft, setDraft] = useState<PracticeDraft>(INITIAL_DRAFT);
  const [activeSession, setActiveSession] =
    useState<ResumableSessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [recordingGuard, setRecordingGuard] = useState<'idle' | 'recording' | 'unsaved'>('idle');
  const [pendingNavigation, setPendingNavigation] = useState<ScreenId | null>(null);
  const [confirmRerecord, setConfirmRerecord] = useState(false);
  const [error, setError] = useState<string>();
  const [initialSnapshot, setInitialSnapshot] = useState<AttemptSnapshot | null>(null);
  const [retrySnapshot, setRetrySnapshot] = useState<AttemptSnapshot | null>(null);
  const [selectedFocus, setSelectedFocus] = useState<SelectedPracticeFocus | null>(null);
  const [recentHistory, setRecentHistory] = useState<Awaited<ReturnType<typeof listPracticeHistory>>>([]);
  const [historyLoadState, setHistoryLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [historyRenameTarget, setHistoryRenameTarget] = useState<HistoryItemView | null>(null);
  const [historyDeleteTarget, setHistoryDeleteTarget] = useState<HistoryItemView | null>(null);
  const [historyActionError, setHistoryActionError] = useState<string>();
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [favoriteTaskIds, setFavoriteTaskIdsState] = useState<readonly string[]>([]);
  const [favoriteLoadState, setFavoriteLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [favoriteError, setFavoriteError] = useState<string>();
  const favoriteTaskIdsRef = useRef<readonly string[]>([]);
  const persistedFavoriteTaskIdsRef = useRef<readonly string[]>([]);
  const favoriteSaveRevision = useRef(0);
  const favoriteLoadRevision = useRef(0);
  const favoriteSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const historyLoadRevision = useRef(0);
  const snapshotLoadRevision = useRef(0);
  const resumeRequestRevision = useRef(0);
  const bootstrapRevision = useRef(0);
  const qaBootstrapPromise = useRef<Promise<string> | null>(null);
  const workflowRevision = useRef(0);
  const workflowPending = useRef(false);
  const previousDiagnosticContext = useRef<{
    readonly screen: ScreenId;
    readonly sessionId: string | null;
  } | null>(null);
  const {
    settings,
    saveSettings,
    waitForPendingSaves: waitForPendingThemeSaves,
    replaceSettings: replaceThemeSettings,
  } = useTheme();
  const sessionId = activeSession?.sessionId;

  useEffect(() => {
    const currentSessionId = sessionId ?? null;
    const previous = previousDiagnosticContext.current;
    previousDiagnosticContext.current = { screen, sessionId: currentSessionId };
    if (previous?.screen === screen && previous.sessionId === currentSessionId) return;
    const screenChanged = previous?.screen !== screen;
    void recordDiagnosticEvent({
      level: 'info',
      component: screenChanged ? 'navigation' : 'session',
      event: screenChanged ? 'navigation.screen_changed' : 'session.context_changed',
      sessionId: currentSessionId,
      fields: {
        from: previous?.screen ?? 'application_start',
        to: screen,
      },
    }).catch(() => undefined);
  }, [screen, sessionId]);

  useEffect(() => {
    if (!error) return;
    void recordDiagnosticEvent({
      level: 'warn',
      component: 'renderer',
      event: 'renderer.error_presented',
      sessionId: sessionId ?? null,
      fields: { screen },
    }).catch(() => undefined);
  }, [error, screen, sessionId]);
  const handleRecordingActivityChange = useCallback((active: boolean) => {
    setRecordingGuard((current) => active
      ? current === 'idle' ? 'recording' : current
      : 'idle');
  }, []);
  const handleRecordingGuardReasonChange = useCallback((reason: 'recording' | 'unsaved') => {
    setRecordingGuard(reason);
  }, []);

  const beginWorkflowOperation = (): number | null => {
    if (workflowPending.current) return null;
    // Any user-started durable workflow owns the current navigation state. A
    // bootstrap response that was already in flight must never overwrite it.
    ++bootstrapRevision.current;
    workflowPending.current = true;
    const revision = ++workflowRevision.current;
    setBusy(true);
    return revision;
  };

  const isCurrentWorkflow = (revision: number): boolean => (
    workflowRevision.current === revision
  );

  const finishWorkflowOperation = (revision: number): void => {
    if (!isCurrentWorkflow(revision)) return;
    workflowPending.current = false;
    setBusy(false);
  };

  const hydrateSessionArtifacts = async (targetSessionId: string): Promise<boolean> => {
    const revision = ++snapshotLoadRevision.current;
    setInitialSnapshot(null);
    setRetrySnapshot(null);
    const artifacts = await listPracticeArtifacts(targetSessionId);
    if (revision !== snapshotLoadRevision.current) return false;
    let nextInitial: AttemptSnapshot | null = null;
    let nextRetry: AttemptSnapshot | null = null;
    for (const artifact of artifacts) {
      if (artifact.type !== 'attempt_snapshot') continue;
      if (artifact.payload.kind === 'initial') nextInitial = artifact.payload;
      else nextRetry = artifact.payload;
    }
    setInitialSnapshot(nextInitial);
    setRetrySnapshot(nextRetry);
    return true;
  };

  const refreshHistory = useCallback(async (): Promise<void> => {
    const loadRevision = ++historyLoadRevision.current;
    setHistoryLoadState((current) => current === 'ready' ? current : 'loading');
    await listPracticeHistory()
      .then((history) => {
        if (loadRevision !== historyLoadRevision.current) return;
        setRecentHistory(history);
        setHistoryLoadState('ready');
      })
      .catch(() => {
        if (loadRevision === historyLoadRevision.current) setHistoryLoadState('error');
      });
  }, []);

  const requestHistoryRename = (item: HistoryItemView) => {
    if (workflowPending.current) return;
    setHistoryActionError(undefined);
    setHistoryRenameTarget(item);
  };

  const requestHistoryDelete = (item: HistoryItemView) => {
    if (workflowPending.current) return;
    if (activeSession?.sessionId === item.id && recordingGuard !== 'idle') {
      setError('请先结束或放弃当前录音，再删除这次练习。');
      return;
    }
    setHistoryActionError(undefined);
    setHistoryDeleteTarget(item);
  };

  const renameHistoryRecord = async (title: string) => {
    const target = historyRenameTarget;
    if (!target) return;
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    setHistoryActionError(undefined);
    let saved = false;
    try {
      const updated = await renamePracticeSession(target.id, title);
      if (!isCurrentWorkflow(workflow)) return;
      setRecentHistory((current) => current.map((item) => (
        item.id === target.id
          ? { ...item, title: updated.recordTitle ?? title, updatedAtIso: updated.updatedAt }
          : item
      )));
      setHistoryRenameTarget(null);
      saved = true;
    } catch {
      if (isCurrentWorkflow(workflow)) setHistoryActionError('名称没有保存成功，请重试。');
    } finally {
      finishWorkflowOperation(workflow);
    }
    if (saved) void refreshHistory();
  };

  const setHistoryRecordPinned = async (item: HistoryItemView, pinned: boolean) => {
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    setError(undefined);
    setHistoryActionError(undefined);
    let saved = false;
    try {
      const updated = await setPracticeSessionPinned(item.id, pinned);
      if (!isCurrentWorkflow(workflow)) return;
      setRecentHistory((current) => sortHistoryRecords(current.map((candidate) => (
        candidate.id === item.id
          ? {
              ...candidate,
              pinnedAt: updated.pinnedAt,
              updatedAtIso: updated.updatedAt,
            }
          : candidate
      ))));
      saved = true;
    } catch {
      if (isCurrentWorkflow(workflow)) {
        const message = pinned
          ? '这次练习没有成功置顶，请重试。'
          : '没有成功取消置顶，请重试。';
        setError(message);
        setHistoryActionError(message);
      }
    } finally {
      finishWorkflowOperation(workflow);
    }
    if (saved) void refreshHistory();
  };

  const deleteHistoryRecord = async () => {
    const target = historyDeleteTarget;
    if (!target) return;
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    setHistoryActionError(undefined);
    try {
      await deletePracticeSession(target.id);
      if (!isCurrentWorkflow(workflow)) return;
      const deletingActive = activeSession?.sessionId === target.id;
      const deletingSelected = selectedHistoryId === target.id;
      if (deletingActive) {
        ++snapshotLoadRevision.current;
        ++resumeRequestRevision.current;
        setActiveSession(null);
        setInitialSnapshot(null);
        setRetrySnapshot(null);
        setSelectedFocus(null);
        setRecordingGuard('idle');
      }
      if (deletingSelected) setSelectedHistoryId(null);
      setRecentHistory((current) => current.filter((item) => item.id !== target.id));
      setHistoryDeleteTarget(null);
      if (deletingSelected && screen === 'S13') setScreen('S10');
      else if (deletingActive) setScreen('S01');
      await refreshHistory();
    } catch {
      if (isCurrentWorkflow(workflow)) setHistoryActionError('删除没有完成，请重试。');
    } finally {
      finishWorkflowOperation(workflow);
    }
  };

  const loadFavorites = useCallback(async () => {
    const loadRevision = ++favoriteLoadRevision.current;
    setFavoriteLoadState('loading');
    setFavoriteError(undefined);
    try {
      const taskIds = await getFavoriteTaskIds();
      if (loadRevision !== favoriteLoadRevision.current) return;
      favoriteTaskIdsRef.current = taskIds;
      persistedFavoriteTaskIdsRef.current = taskIds;
      setFavoriteTaskIdsState(taskIds);
      setFavoriteLoadState('ready');
    } catch {
      if (loadRevision !== favoriteLoadRevision.current) return;
      setFavoriteLoadState('error');
      setFavoriteError('收藏题目没有成功读取；在重试成功前不会覆盖本机收藏。');
    }
  }, []);

  useEffect(() => {
    if (isQaRoute()) {
      if (!qaBootstrapPromise.current) {
        setBusy(true);
        qaBootstrapPromise.current = (async () => {
          const id = await createPracticeSession(INITIAL_DRAFT);
          try {
            await transitionPracticeSession({
              sessionId: id,
              event: { type: 'start_practice' },
            });
          } catch (cause) {
            await deletePracticeSession(id).catch(() => undefined);
            throw cause;
          }
          return id;
        })();
      }
      let active = true;
      void qaBootstrapPromise.current.then((id) => {
        if (!active) return;
        setDraft(INITIAL_DRAFT);
        setActiveSession({
          sessionId: id,
          status: 'first_attempt',
          screen: 'S04',
          draft: INITIAL_DRAFT,
        });
        setScreen('S04');
        setBusy(false);
      }).catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : '受控验收 Session 没有成功创建。');
        setBusy(false);
      });
      return () => {
        active = false;
      };
    }
    const revision = ++bootstrapRevision.current;
    let active = true;
    void getDesktopBootstrap()
      .then((bootstrap) => {
        if (!active || revision !== bootstrapRevision.current) return;
        setActiveSession(bootstrap.activeSession);
        if (bootstrap.activeSession) {
          setDraft(bootstrap.activeSession.draft);
          setSelectedFocus(bootstrap.activeSession.selectedFocus ?? null);
          void hydrateSessionArtifacts(bootstrap.activeSession.sessionId).catch(() => {
            if (active && revision === bootstrapRevision.current) {
              setError('上次练习的冻结快照没有成功载入，请从练习记录重试。');
            }
          });
        }
        setScreen(bootstrap.onboardingCompleted ? 'S01' : 'S00');
      })
      .catch(() => {
        if (active && revision === bootstrapRevision.current) {
          setError('无法读取本地启动状态，请重新打开 Phrio。');
        }
      });
    return () => {
      active = false;
      if (bootstrapRevision.current === revision) ++bootstrapRevision.current;
    };
  }, []);

  useEffect(() => {
    void loadFavorites();
    return () => {
      ++favoriteLoadRevision.current;
    };
  }, [loadFavorites]);

  useEffect(() => {
    if (screen !== 'S00') refreshHistory();
  }, [refreshHistory, screen]);

  useEffect(() => {
    if (screen !== 'S09') setComparisonEntered(false);
  }, [screen]);

  useEffect(() => () => {
    ++historyLoadRevision.current;
  }, []);

  const navigate = (nextScreen: ScreenId) => {
    if (workflowPending.current && nextScreen !== screen) return;
    if (recordingGuard !== 'idle' && nextScreen !== screen) {
      setPendingNavigation(nextScreen);
      return;
    }
    if (nextScreen !== screen) {
      ++workflowRevision.current;
      ++snapshotLoadRevision.current;
      ++resumeRequestRevision.current;
    }
    setError(undefined);
    setScreen(nextScreen);
  };

  const openDemo = (returnScreen: 'S00' | 'S01') => {
    // The demo is a user-owned navigation choice. Invalidate any bootstrap
    // response that was already in flight so it cannot replace the demo.
    ++bootstrapRevision.current;
    setDemoReturnScreen(returnScreen);
    navigate('S16');
  };

  const resumeSession = async (session: ResumableSessionView) => {
    if (session.resumeBlockedReason) {
      setError(session.resumeBlockedReason);
      return;
    }
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    const requestRevision = ++resumeRequestRevision.current;
    setError(undefined);
    try {
      const hydrated = await hydrateSessionArtifacts(session.sessionId);
      if (!hydrated
        || requestRevision !== resumeRequestRevision.current
        || !isCurrentWorkflow(workflow)) return;
      setActiveSession(session);
      setDraft(session.draft);
      setSelectedFocus(session.selectedFocus ?? null);
      setScreen(session.screen);
    } catch (cause) {
      if (requestRevision !== resumeRequestRevision.current || !isCurrentWorkflow(workflow)) return;
      setError(cause instanceof Error ? cause.message : '本次练习的冻结产物没有成功载入。');
    } finally {
      finishWorkflowOperation(workflow);
    }
  };

  const selectMode = (mode: ModeId) => {
    if (workflowPending.current) return;
    setDraft((current) => {
      const nextTask = PRACTICE_TASKS.find((task) => task.mode === mode);
      return {
        ...current,
        mode,
        task: nextTask ?? current.task,
        durationSeconds: nextTask?.durationSeconds ?? current.durationSeconds,
        audience: nextTask?.audience ?? current.audience,
        goal: nextTask?.goal ?? current.goal,
      };
    });
  };

  const selectTask = (task: PracticeTask) => {
    if (workflowPending.current) return;
    setDraft((current) => ({
      ...current,
      mode: task.mode,
      task,
      durationSeconds: task.durationSeconds,
      audience: task.audience,
      goal: task.goal,
    }));
  };

  const toggleFavoriteTask = (taskId: string) => {
    if (favoriteLoadState !== 'ready') {
      setFavoriteError('收藏尚未读取完成；请先重试，Phrio 不会用空列表覆盖本机收藏。');
      return;
    }
    const current = favoriteTaskIdsRef.current;
    const next = current.includes(taskId)
      ? current.filter((candidate) => candidate !== taskId)
      : [...current, taskId];
    const revision = ++favoriteSaveRevision.current;
    favoriteTaskIdsRef.current = next;
    setFavoriteTaskIdsState(next);
    setFavoriteError(undefined);

    favoriteSaveQueue.current = favoriteSaveQueue.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const persisted = await setFavoriteTaskIds(next);
          persistedFavoriteTaskIdsRef.current = persisted;
          if (revision !== favoriteSaveRevision.current) return;
          favoriteTaskIdsRef.current = persisted;
          setFavoriteTaskIdsState(persisted);
        } catch {
          if (revision !== favoriteSaveRevision.current) return;
          const persisted = persistedFavoriteTaskIdsRef.current;
          favoriteTaskIdsRef.current = persisted;
          setFavoriteTaskIdsState(persisted);
          setFavoriteError('收藏没有保存成功，已恢复本机中的状态。');
        }
      });
  };

  const startSession = async (sessionDraft: PracticeDraft = draft) => {
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    setError(undefined);
    try {
      const reuseSetup = activeSession?.status === 'setup'
        && isSameFrozenDraft(activeSession.draft, sessionDraft);
      const id = reuseSetup
        ? activeSession.sessionId
        : await createPracticeSession(sessionDraft);
      try {
        await transitionPracticeSession({
          sessionId: id,
          event: { type: 'start_practice' },
        });
      } catch (cause) {
        if (!reuseSetup) {
          try {
            await deletePracticeSession(id);
          } catch {
            throw new Error('练习未能启动，且临时 Session 清理失败；请在练习记录中检查后重试。');
          }
        }
        throw cause;
      }
      if (!isCurrentWorkflow(workflow)) return;
      setActiveSession({
        sessionId: id,
        status: 'first_attempt',
        screen: 'S04',
        draft: sessionDraft,
      });
      setDraft(sessionDraft);
      ++snapshotLoadRevision.current;
      setInitialSnapshot(null);
      setRetrySnapshot(null);
      setSelectedFocus(null);
      setScreen('S04');
      refreshHistory();
    } catch (cause) {
      if (!isCurrentWorkflow(workflow)) return;
      setError(
        cause instanceof Error ? cause.message : '没有成功创建本轮练习。',
      );
    } finally {
      finishWorkflowOperation(workflow);
    }
  };

  const startFreePractice = (input: {
    topic: string;
    audience: string;
    goal: string;
  }) => {
    if (workflowPending.current) return;
    const topic = input.topic.trim() || '自由表达：说说此刻最想讲清楚的一件事';
    const audience = input.audience.trim() || '任何愿意听我说的人';
    const goal = input.goal.trim() || '把此刻最想表达的内容讲清楚';
    const freeDraft: PracticeDraft = {
      mode: 'clear-expression',
      task: {
        id: 'free-expression',
        developmentFixture: false,
        title: topic,
        hint: '一次性自由题目；先得到诊断，再自主结束、自由复讲或进入单焦点训练。',
        mode: 'clear-expression',
        modeLabel: '清晰表达 · 通用',
        durationSeconds: 90,
        audience,
        goal,
        successConditions: ['让听众理解这次最想表达的核心内容'],
      },
      audience,
      goal,
      durationSeconds: 90,
    };
    setDraft(freeDraft);
    void startSession(freeDraft);
  };

  const finishOnboarding = async () => {
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    setError(undefined);
    try {
      await completeOnboarding();
      if (!isCurrentWorkflow(workflow)) return;
      setScreen('S01');
    } catch {
      if (!isCurrentWorkflow(workflow)) return;
      setError('首次设置没有保存成功，请重试。');
    } finally {
      finishWorkflowOperation(workflow);
    }
  };

  const saveRecording = async (
    attempt: AttemptKind,
    audio: RecordedAudio,
    snapshot: AttemptSnapshot | null,
  ) => {
    if (!sessionId) {
      setError('当前 Session 不存在，请返回新练习重新开始。');
      return;
    }
    if (!snapshot) {
      setError('冻结快照尚未持久化，当前录音不会被保存；请重试快照保存。');
      return;
    }
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    const targetSessionId = sessionId;
    setError(undefined);
    try {
      const bytes = new Uint8Array(await audio.blob.arrayBuffer());
      if (!isCurrentWorkflow(workflow)) return;
      await saveAttemptRecording({
        sessionId: targetSessionId,
        attemptId: snapshot.attemptId,
        attempt,
        bytes,
        mimeType: audio.mimeType,
        durationMs: audio.durationMs,
      });
      await transitionPracticeSession({
        sessionId: targetSessionId,
        event: {
          type:
            attempt === 'first'
              ? 'confirm_first_attempt'
              : 'confirm_second_attempt',
        },
      });
      if (!isCurrentWorkflow(workflow)) return;
      if (attempt === 'first') {
        setInitialSnapshot(snapshot);
      } else {
        setRetrySnapshot(snapshot);
      }
      const nextScreen = attempt === 'first' ? 'S05' : 'S09';
      const nextStatus = attempt === 'first' ? 'transcript_review' : 'comparison';
      setActiveSession((current) =>
        current
          ? { ...current, screen: nextScreen, status: nextStatus }
          : current,
      );
      setScreen(nextScreen);
    } catch (cause) {
      if (!isCurrentWorkflow(workflow)) return;
      setError(cause instanceof Error ? cause.message : '录音没有成功保存。');
    } finally {
      finishWorkflowOperation(workflow);
    }
  };

  const persistStoppedRecording = async (
    attempt: AttemptKind,
    audio: RecordedAudio,
    snapshot: AttemptSnapshot,
  ): Promise<void> => {
    if (!sessionId) throw new Error('当前 Session 不存在。');
    const bytes = new Uint8Array(await audio.blob.arrayBuffer());
    await saveAttemptRecording({
      sessionId,
      attemptId: snapshot.attemptId,
      attempt,
      bytes,
      mimeType: audio.mimeType,
      durationMs: audio.durationMs,
    });
    if (attempt === 'first') setInitialSnapshot(snapshot);
    else setRetrySnapshot(snapshot);
  };

  const discardStoppedRecording = async (
    attempt: AttemptKind,
    attemptId: string | null,
  ): Promise<void> => {
    if (!sessionId) throw new Error('当前 Session 不存在。');
    await discardAttemptRecording({
      sessionId,
      attempt,
      ...(attemptId ? { attemptId } : {}),
    });
    if (attempt === 'first') setInitialSnapshot(null);
    else setRetrySnapshot(null);
  };

  const restartInitialAttempt = async () => {
    if (!sessionId) return;
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    const targetSessionId = sessionId;
    setError(undefined);
    try {
      const replacementId = await createPracticeSession(draft);
      try {
        await transitionPracticeSession({
          sessionId: replacementId,
          event: { type: 'start_practice' },
        });
      } catch (cause) {
        try {
          await deletePracticeSession(replacementId);
        } catch {
          throw new Error('新录制 Session 未能启动，且临时 Session 清理失败；原初讲仍保留，请在练习记录中检查。');
        }
        throw cause;
      }
      try {
        await deletePracticeSession(targetSessionId);
      } catch {
        try {
          await deletePracticeSession(replacementId);
        } catch {
          throw new Error('原初讲仍保留，但新旧 Session 都需要在练习记录中检查；当前没有切换到新录制。');
        }
        throw new Error('原初讲未能安全删除，因此新录制没有生效；原数据仍完整保留。');
      }
      if (!isCurrentWorkflow(workflow)) return;
      ++snapshotLoadRevision.current;
      setInitialSnapshot(null);
      setRetrySnapshot(null);
      setSelectedFocus(null);
      setActiveSession({
        sessionId: replacementId,
        status: 'first_attempt',
        screen: 'S04',
        draft,
      });
      setConfirmRerecord(false);
      setScreen('S04');
      refreshHistory();
    } catch (cause) {
      if (!isCurrentWorkflow(workflow)) return;
      setConfirmRerecord(false);
      setError(cause instanceof Error ? cause.message : '没有成功重置这次初讲。');
    } finally {
      finishWorkflowOperation(workflow);
    }
  };

  const advance = async (
    nextScreen: ScreenId,
    event: Parameters<typeof transitionPracticeSession>[0]['event'],
  ) => {
    if (!sessionId) {
      setScreen(nextScreen);
      return;
    }
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    const targetSessionId = sessionId;
    setError(undefined);
    try {
      await transitionPracticeSession({ sessionId: targetSessionId, event });
      if (!isCurrentWorkflow(workflow)) return;
      setActiveSession((current) =>
        current
          ? {
              ...current,
              screen: nextScreen,
              status:
                event.type === 'confirm_transcript'
                  ? 'diagnosis'
                  : event.type === 'complete_drill'
                    ? 'second_attempt'
                    : current.status,
            }
          : current,
      );
      setScreen(nextScreen);
    } catch (cause) {
      if (!isCurrentWorkflow(workflow)) return;
      setError(cause instanceof Error ? cause.message : '当前步骤没有保存成功。');
    } finally {
      finishWorkflowOperation(workflow);
    }
  };

  const completeDrill = async (completion: DrillCompletion) => {
    if (!sessionId) return;
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    const targetSessionId = sessionId;
    setError(undefined);
    try {
      await savePracticeArtifact({
        type: 'drill_completion',
        sessionId: targetSessionId,
        id: completion.id,
        payload: completion,
      });
      await transitionPracticeSession({
        sessionId: targetSessionId,
        event: { type: 'complete_drill' },
      });
      if (!isCurrentWorkflow(workflow)) return;
      setActiveSession((current) => current ? {
        ...current,
        screen: 'S08',
        status: 'second_attempt',
      } : current);
      setScreen('S08');
    } catch (cause) {
      if (!isCurrentWorkflow(workflow)) return;
      setError(cause instanceof Error ? cause.message : 'Drill 完成记录没有保存成功。');
    } finally {
      finishWorkflowOperation(workflow);
    }
  };

  const recoverCompletedTransition = async (
    targetSessionId: string,
    workflow: number,
    destination: 'history' | 'detail',
  ): Promise<boolean> => {
    const persisted = await getPracticeSession(targetSessionId).catch(() => null);
    // A newer workflow owns navigation; suppress stale failure copy from this
    // operation even when its reconciliation read finishes later.
    if (!isCurrentWorkflow(workflow)) return true;
    if (persisted?.status !== 'completed') return false;

    setActiveSession(null);
    setError(undefined);
    refreshHistory();
    if (destination === 'detail') {
      setSelectedHistoryId(targetSessionId);
      setScreen('S13');
    } else {
      setScreen('S10');
    }
    return true;
  };

  const saveCompletedSession = async (comparisonArtifactId: string) => {
    if (!sessionId) {
      setScreen('S10');
      return;
    }
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    const targetSessionId = sessionId;
    setError(undefined);
    try {
      await transitionPracticeSession({
        sessionId: targetSessionId,
        event: { type: 'view_comparison', comparisonArtifactId },
      });
      if (!isCurrentWorkflow(workflow)) return;
      setActiveSession(null);
      setScreen('S10');
    } catch (cause) {
      if (!isCurrentWorkflow(workflow)) return;
      if (await recoverCompletedTransition(targetSessionId, workflow, 'history')) return;
      if (!isCurrentWorkflow(workflow)) return;
      setError(cause instanceof Error ? cause.message : '本轮练习没有成功保存。');
    } finally {
      finishWorkflowOperation(workflow);
    }
  };

  const finishAnalysisOnly = async (diagnosisReportId: string) => {
    if (!sessionId) {
      setScreen('S10');
      return;
    }
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    const targetSessionId = sessionId;
    setError(undefined);
    try {
      await transitionPracticeSession({
        sessionId: targetSessionId,
        event: { type: 'finish_analysis_only', diagnosisReportId },
      });
      if (!isCurrentWorkflow(workflow)) return;
      setActiveSession(null);
      setSelectedHistoryId(targetSessionId);
      refreshHistory();
      setScreen('S13');
    } catch (cause) {
      if (!isCurrentWorkflow(workflow)) return;
      if (await recoverCompletedTransition(targetSessionId, workflow, 'detail')) return;
      if (!isCurrentWorkflow(workflow)) return;
      setError(cause instanceof Error ? cause.message : '诊断结果没有成功保存。');
    } finally {
      finishWorkflowOperation(workflow);
    }
  };

  const startFreeRetry = async (diagnosisReportId: string) => {
    if (!sessionId) {
      setSelectedFocus(null);
      setScreen('S08');
      return;
    }
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    const targetSessionId = sessionId;
    setError(undefined);
    try {
      await transitionPracticeSession({
        sessionId: targetSessionId,
        event: { type: 'skip_focus', diagnosisReportId },
      });
      if (!isCurrentWorkflow(workflow)) return;
      setSelectedFocus(null);
      setActiveSession((current) => current ? {
        ...current,
        screen: 'S08',
        status: 'second_attempt',
        selectedFocus: null,
      } : current);
      setScreen('S08');
    } catch (cause) {
      if (!isCurrentWorkflow(workflow)) return;
      setError(cause instanceof Error ? cause.message : '自由复讲没有成功开始。');
    } finally {
      finishWorkflowOperation(workflow);
    }
  };

  const finishRetryWithoutComparison = async () => {
    if (!sessionId) {
      setScreen('S10');
      return;
    }
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    const targetSessionId = sessionId;
    setError(undefined);
    try {
      await transitionPracticeSession({
        sessionId: targetSessionId,
        event: { type: 'finish_retry_without_comparison' },
      });
      if (!isCurrentWorkflow(workflow)) return;
      setActiveSession(null);
      setSelectedHistoryId(targetSessionId);
      refreshHistory();
      setScreen('S13');
    } catch (cause) {
      if (!isCurrentWorkflow(workflow)) return;
      if (await recoverCompletedTransition(targetSessionId, workflow, 'detail')) return;
      if (!isCurrentWorkflow(workflow)) return;
      setError(cause instanceof Error ? cause.message : '复讲结果没有成功保存。');
    } finally {
      finishWorkflowOperation(workflow);
    }
  };

  const selectPracticeFocus = async (
    focus: SelectedPracticeFocus,
    diagnosisReportId: string,
  ) => {
    if (focusTransitionPending.current) return;
    if (!sessionId) {
      setSelectedFocus(focus);
      setScreen('S07');
      return;
    }
    const workflow = beginWorkflowOperation();
    if (workflow === null) return;
    const targetSessionId = sessionId;
    focusTransitionPending.current = true;
    setError(undefined);
    try {
      await transitionPracticeSession({
        sessionId: targetSessionId,
        event: {
          type: 'select_focus',
          diagnosisReportId,
          focus: {
            criterionId: focus.criterionId,
            drillId: focus.drillId,
            label: focus.criterionLabel,
            guidanceSource: focus.guidanceSource,
            evidenceIds: [...focus.evidenceIds],
          },
        },
      });
      if (!isCurrentWorkflow(workflow)) return;
      setActiveSession((current) =>
        current ? { ...current, screen: 'S07', status: 'drill', selectedFocus: focus } : current,
      );
      setSelectedFocus(focus);
      setScreen('S07');
    } catch (cause) {
      if (!isCurrentWorkflow(workflow)) return;
      setError(cause instanceof Error ? cause.message : '训练焦点没有成功保存。');
    } finally {
      focusTransitionPending.current = false;
      finishWorkflowOperation(workflow);
    }
  };

  const command = (() => {
    const base = SCREEN_COMMANDS[screen];
    if (screen === 'S04' || screen === 'S08') {
      return {
        ...base,
        title: `${draft.task.title} · ${screen === 'S04' ? '初讲' : '复讲'}`,
        taskContext: draft.task.modeLabel,
      };
    }
    if (screen === 'S03' || screen === 'S05' || screen === 'S06' || screen === 'S07' || screen === 'S09') {
      return {
        ...base,
        title: draft.task.title,
        taskContext: screen === 'S03'
          ? draft.task.modeLabel
          : screen === 'S06'
            ? '诊断结果 · 可选训练'
            : base.taskContext,
      };
    }
    return base;
  })();

  return (
    <AppShell
      activeMode={draft.mode}
      commandStatus={command.status}
      navigationDisabled={busy}
      onboardingContext={screen === 'S16' && demoReturnScreen === 'S00'}
      recentHistory={recentHistory}
      selectedHistoryId={selectedHistoryId}
      onNavigate={navigate}
      onDeleteHistory={requestHistoryDelete}
      onOpenHistory={(historyId) => {
        if (workflowPending.current) return;
        setSelectedHistoryId(historyId);
        navigate('S13');
      }}
      onRenameHistory={requestHistoryRename}
      onSetHistoryPinned={(item, pinned) => void setHistoryRecordPinned(item, pinned)}
      screen={screen}
      stageIndex={screen === 'S09' && comparisonEntered ? 3 : STAGE_BY_SCREEN[screen]}
      taskContext={command.taskContext}
      title={command.title}
    >
      {screen === 'S00' ? (
        <FirstRunPage
          busy={busy}
          error={error}
          onContinue={() => void finishOnboarding()}
          onTryDemo={() => openDemo('S00')}
        />
      ) : null}
      {screen === 'S01' ? (
        <HomePage
          busy={busy}
          canResume={activeSession !== null && !activeSession.resumeBlockedReason}
          error={error}
          onBrowseTasks={() => navigate('S02')}
          onResume={() => {
            if (activeSession) void resumeSession(activeSession);
          }}
          onSelectMode={selectMode}
          onSelectTask={selectTask}
          onStart={() => navigate('S03')}
          onStartFree={startFreePractice}
          onTryDemo={() => openDemo('S01')}
          selectedMode={draft.mode}
          selectedTask={draft.task}
        />
      ) : null}
      {screen === 'S02' ? (
        <TaskLibraryPage
          favoriteTaskIds={favoriteTaskIds}
          favoriteLoadState={favoriteLoadState}
          onContinue={() => navigate('S03')}
          onSelectMode={selectMode}
          onSelectTask={selectTask}
          onToggleFavorite={toggleFavoriteTask}
          onRetryFavorites={() => void loadFavorites()}
          saveError={favoriteError ?? error}
          selectedMode={draft.mode}
          selectedTask={draft.task}
        />
      ) : null}
      {screen === 'S03' ? (
        <TrainingSetupPage
          busy={busy}
          draft={draft}
          error={error}
          onChange={setDraft}
          onStart={() => void startSession()}
        />
      ) : null}
      {screen === 'S04' ? (
        <LivePracticePage
          attempt="first"
          busy={busy}
          draft={draft}
          sessionId={sessionId ?? 'qa-session'}
          onAccept={(audio, snapshot) => void saveRecording('first', audio, snapshot)}
          onDiscardStoppedTake={(attemptId) => discardStoppedRecording('first', attemptId)}
          onPersistStoppedTake={(audio, snapshot) => persistStoppedRecording('first', audio, snapshot)}
          onRecordingActivityChange={handleRecordingActivityChange}
          onRecordingGuardReasonChange={handleRecordingGuardReasonChange}
          restoredSnapshot={initialSnapshot}
          saveError={error}
        />
      ) : null}
      {screen === 'S05' ? (
        <TranscriptReviewPage
          busy={busy}
          error={error}
          onRerecord={() => setConfirmRerecord(true)}
          onConfirm={() => void advance('S06', { type: 'confirm_transcript' })}
          sessionId={sessionId ?? 'qa-session'}
          snapshot={initialSnapshot}
        />
      ) : null}
      {screen === 'S06' ? (
        <DeepLanePage
          busy={busy}
          draft={draft}
          error={error}
          sessionId={sessionId ?? 'qa-session'}
          snapshot={initialSnapshot}
          onFinishAnalysis={(diagnosisReportId) => void finishAnalysisOnly(diagnosisReportId)}
          onStartFreeRetry={(diagnosisReportId) => void startFreeRetry(diagnosisReportId)}
          onStartDrill={(focus, diagnosisReportId) => void selectPracticeFocus(focus, diagnosisReportId)}
        />
      ) : null}
      {screen === 'S07' ? (
        <DrillPage
          busy={busy}
          draft={draft}
          error={error}
          focus={selectedFocus}
          onContinue={(completion) => void completeDrill(completion)}
          sessionId={sessionId ?? 'qa-session'}
          snapshotId={initialSnapshot?.id ?? null}
        />
      ) : null}
      {screen === 'S08' ? (
        <LivePracticePage
          attempt="second"
          busy={busy}
          draft={draft}
          focus={selectedFocus}
          sessionId={sessionId ?? 'qa-session'}
          onAccept={(audio, snapshot) => void saveRecording('second', audio, snapshot)}
          onDiscardStoppedTake={(attemptId) => discardStoppedRecording('second', attemptId)}
          onPersistStoppedTake={(audio, snapshot) => persistStoppedRecording('second', audio, snapshot)}
          onRecordingActivityChange={handleRecordingActivityChange}
          onRecordingGuardReasonChange={handleRecordingGuardReasonChange}
          restoredSnapshot={retrySnapshot}
          saveError={error}
        />
      ) : null}
      {screen === 'S09' ? (
        <DeepComparisonPage
          draft={draft}
          focus={selectedFocus}
          initial={initialSnapshot}
          retry={retrySnapshot}
          sessionId={sessionId ?? 'qa-session'}
          busy={busy}
          error={error}
          requireExplicitEntry
          onEnterComparison={() => setComparisonEntered(true)}
          onFinishWithoutComparison={() => void finishRetryWithoutComparison()}
          onSave={saveCompletedSession}
        />
      ) : null}
      {screen === 'S10' ? (
        <HistoryPage
          error={historyActionError ?? (
            historyLoadState === 'error' ? '暂时无法读取本地练习记录。' : undefined
          )}
          items={recentHistory}
          loading={historyLoadState === 'loading'}
          onDeleteSession={requestHistoryDelete}
          onOpenSession={(historyId) => {
            if (workflowPending.current) return;
            setSelectedHistoryId(historyId);
            navigate('S13');
          }}
          onRenameSession={requestHistoryRename}
          onRetry={() => void refreshHistory()}
          onSetSessionPinned={(item, pinned) => void setHistoryRecordPinned(item, pinned)}
        />
      ) : null}
      {screen === 'S11' ? (
        <AppearancePage onChange={saveSettings} settings={settings} />
      ) : null}
      {screen === 'S12' ? (
        <SettingsPage
          onBeforeSettingsReset={async () => {
            await Promise.all([
              waitForPendingThemeSaves(),
              favoriteSaveQueue.current.catch(() => undefined),
            ]);
          }}
          onSettingsReset={(resetSettings) => {
            ++favoriteLoadRevision.current;
            ++favoriteSaveRevision.current;
            replaceThemeSettings({
              theme: resetSettings.theme,
              lightPalette: resetSettings.lightAccent,
              darkPalette: resetSettings.darkAccent,
              textScale: resetSettings.textScale === 0.9
                || resetSettings.textScale === 1.125
                || resetSettings.textScale === 1.25
                ? resetSettings.textScale
                : 1,
              reduceMotion: resetSettings.reducedMotion,
            });
            const resetFavorites = resetSettings.favoriteTaskIds;
            favoriteTaskIdsRef.current = resetFavorites;
            persistedFavoriteTaskIdsRef.current = resetFavorites;
            setFavoriteTaskIdsState(resetFavorites);
            setFavoriteLoadState('ready');
            setFavoriteError(undefined);
          }}
          onTrainingDataCleared={() => {
            ++workflowRevision.current;
            workflowPending.current = false;
            ++historyLoadRevision.current;
            ++snapshotLoadRevision.current;
            ++resumeRequestRevision.current;
            setBusy(false);
            setActiveSession(null);
            setInitialSnapshot(null);
            setRetrySnapshot(null);
            setSelectedFocus(null);
            setSelectedHistoryId(null);
            setRecentHistory([]);
            setHistoryLoadState('ready');
            setHistoryRenameTarget(null);
            setHistoryDeleteTarget(null);
            setHistoryActionError(undefined);
            setError(undefined);
          }}
        />
      ) : null}
      {screen === 'S13' && selectedHistoryId ? (
        <PracticeRecordDetailPage
          onBack={() => navigate('S10')}
          onDeleted={() => {
            if (activeSession?.sessionId === selectedHistoryId) setActiveSession(null);
            setSelectedHistoryId(null);
            refreshHistory();
            navigate('S10');
          }}
          onRepeat={(recordDraft) => {
            if (workflowPending.current) return;
            setActiveSession(null);
            setDraft(recordDraft);
            navigate('S03');
          }}
          onResume={(session) => void resumeSession(session)}
          resumeBusy={busy}
          resumeError={error}
          sessionId={selectedHistoryId}
        />
      ) : null}
      {screen === 'S14' ? (
        <FavoriteTasksPage
          favoriteTaskIds={favoriteTaskIds}
          favoriteLoadState={favoriteLoadState}
          onBrowseTasks={() => navigate('S02')}
          onRemoveFavorite={toggleFavoriteTask}
          onRetryFavorites={() => void loadFavorites()}
          onUseTask={(task) => {
            selectTask(task);
            navigate('S03');
          }}
          saveError={favoriteError ?? error}
        />
      ) : null}
      {screen === 'S15' ? <PracticeSettingsPage /> : null}
      {screen === 'S16' ? (
        <DemoExperiencePage
          onExit={() => setScreen(demoReturnScreen)}
          onStartRealPractice={() => {
            if (demoReturnScreen === 'S00') void finishOnboarding();
            else navigate('S01');
          }}
        />
      ) : null}
      {pendingNavigation ? (
        <ConfirmationDialog
          busy={busy}
          cancelLabel="留在录音页"
          confirmDangerous
          confirmLabel="放弃这遍并离开"
          description={recordingGuard === 'unsaved'
            ? '录音已经停止，但音频与冻结快照尚未确认保存。现在离开会放弃这遍；当前练习 Session 仍会保留。'
            : '录音或尾句收束仍在进行。现在离开会停止并放弃这遍；当前练习 Session 仍会保留。'}
          onCancel={() => {
            if (!workflowPending.current) setPendingNavigation(null);
          }}
          onConfirm={() => {
            if (workflowPending.current) return;
            const target = pendingNavigation;
            setPendingNavigation(null);
            setRecordingGuard('idle');
            ++workflowRevision.current;
            ++snapshotLoadRevision.current;
            ++resumeRequestRevision.current;
            setError(undefined);
            setScreen(target);
          }}
          title={recordingGuard === 'unsaved' ? '这遍录音还没有保存' : '当前录音还没有结束'}
        />
      ) : null}
      {confirmRerecord ? (
        <ConfirmationDialog
          busy={busy}
          cancelLabel="保留当前初讲"
          confirmDangerous
          confirmLabel={busy ? '正在重置…' : '确认重新录制'}
          description="Phrio 会先安全创建并启动同题的新 Session，再删除当前初讲的音频、冻结逐字稿和衍生产物；任一步失败都会保留原初讲。外部已经导出的文件不会被处理。"
          onCancel={() => setConfirmRerecord(false)}
          onConfirm={() => void restartInitialAttempt()}
          title="重新录制初讲？"
        />
      ) : null}
      {historyRenameTarget ? (
        <RenamePracticeDialog
          busy={busy}
          error={historyActionError}
          item={historyRenameTarget}
          onCancel={() => {
            if (busy) return;
            setHistoryActionError(undefined);
            setHistoryRenameTarget(null);
          }}
          onConfirm={(title) => void renameHistoryRecord(title)}
        />
      ) : null}
      {historyDeleteTarget ? (
        <ConfirmationDialog
          busy={busy}
          cancelLabel="保留这次练习"
          confirmDangerous
          confirmLabel={busy ? '正在删除…' : '删除记录'}
          description={(
            <>
              <p>“{historyDeleteTarget.title}”的逐字稿、证据、诊断结果和本机录音会一起删除，无法撤销。</p>
              {historyActionError ? <p className="inline-error" role="alert">{historyActionError}</p> : null}
            </>
          )}
          onCancel={() => {
            if (busy) return;
            setHistoryActionError(undefined);
            setHistoryDeleteTarget(null);
          }}
          onConfirm={() => void deleteHistoryRecord()}
          title="删除这次练习？"
        />
      ) : null}
    </AppShell>
  );
}
