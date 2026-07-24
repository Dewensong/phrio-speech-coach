import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/frontend/app';
import { Sidebar } from '../../src/frontend/components/sidebar';
import { RenamePracticeDialog } from '../../src/frontend/components/rename-practice-dialog';
import { HomePage } from '../../src/frontend/pages/home-page';
import { RecordingPage } from '../../src/frontend/pages/recording-page';
import { LivePracticePage } from '../../src/frontend/pages/live-practice-page';
import { PracticeRecordDetailPage } from '../../src/frontend/pages/practice-record-detail-page';
import { PracticeSettingsPage } from '../../src/frontend/pages/practice-settings-page';
import { TrainingSetupPage } from '../../src/frontend/pages/training-setup-page';
import { CANONICAL_TASK, PRACTICE_TASKS } from '../../src/frontend/data/practice-catalog';
import {
  DEFAULT_APP_SETTINGS,
  GATE_C_PM_TASK,
  P1_MODE_PACKS,
  createPracticeSession as createDomainSession,
  type AttemptSnapshot,
  type PhrioDesktopApi,
} from '../../src/shared';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'phrio');
  window.history.replaceState({}, '', '/');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Phrio P1 renderer flow', () => {
  it('does not let a late desktop bootstrap overwrite completed onboarding', async () => {
    const bootstrap = deferred<Awaited<ReturnType<PhrioDesktopApi['getBootstrap']>>>();
    const updatedSettings = { ...DEFAULT_APP_SETTINGS, onboardingCompleted: true };
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getBootstrap: () => bootstrap.promise,
        getSettings: async () => DEFAULT_APP_SETTINGS,
        listSessions: async () => [],
        updateSettings: vi.fn(async () => updatedSettings),
      } as unknown as PhrioDesktopApi,
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '了解并进入练习' }));
    expect(await screen.findByRole('heading', { name: '开始一次练习' })).toBeInTheDocument();

    await act(async () => {
      bootstrap.resolve({
        settings: { ...DEFAULT_APP_SETTINGS, onboardingCompleted: false },
        modes: [...P1_MODE_PACKS],
        activeSession: null,
      });
      await bootstrap.promise;
    });

    expect(screen.getByRole('heading', { name: '开始一次练习' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '先看清楚，什么会留在本机' })).not.toBeInTheDocument();
  });

  it('keeps a failed free-practice creation visible beside the initiating control', () => {
    render(
      <HomePage
        busy={false}
        canResume={false}
        error="没有成功创建本轮自由练习。"
        onBrowseTasks={vi.fn()}
        onResume={vi.fn()}
        onSelectMode={vi.fn()}
        onSelectTask={vi.fn()}
        onStart={vi.fn()}
        onStartFree={vi.fn()}
        selectedMode="decision-alignment"
        selectedTask={CANONICAL_TASK}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('没有成功创建本轮自由练习。');
    expect(screen.getByRole('button', { name: '直接开始' })).toBeEnabled();
  });

  it('keeps the complete free and guided practice entry points behind the quieter home hierarchy', () => {
    const onStartFree = vi.fn();
    const onSelectMode = vi.fn();
    const onSelectTask = vi.fn();
    const onStart = vi.fn();
    render(
      <HomePage
        busy={false}
        canResume={false}
        onBrowseTasks={vi.fn()}
        onResume={vi.fn()}
        onSelectMode={onSelectMode}
        onSelectTask={onSelectTask}
        onStart={onStart}
        onStartFree={onStartFree}
        selectedMode="decision-alignment"
        selectedTask={CANONICAL_TASK}
      />,
    );

    fireEvent.click(screen.getByText('练习条件'));
    fireEvent.change(screen.getByRole('textbox', { name: '听众' }), {
      target: { value: '设计评审参与者' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '目标' }), {
      target: { value: '让大家明确下一步' },
    });
    fireEvent.click(screen.getByRole('button', { name: '直接开始' }));
    expect(onStartFree).toHaveBeenCalledWith({
      topic: '',
      audience: '设计评审参与者',
      goal: '让大家明确下一步',
    });

    expect(
      within(screen.getByLabelText('推荐练习题')).getAllByRole('button'),
    ).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '开始初讲' }));
    expect(onSelectTask).toHaveBeenCalledWith(CANONICAL_TASK);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('moves from the local-first boundary into the A3 practice composer', async () => {
    const { container } = render(<App />);

    expect(
      screen.getByRole('heading', { name: '先看清楚，什么会留在本机' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('收藏题目')).not.toBeInTheDocument();
    expect(screen.queryByText('综合总分')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '了解并进入练习' }));

    expect(
      await screen.findByRole('heading', { name: '开始一次练习' }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('选择练习模式'))
        .getByRole('button', { name: /决策与对齐/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: '想到什么，就从这里直接开始说' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '直接开始' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '浏览全部' }));
    expect(await screen.findByRole('heading', { name: '挑一个你真的需要说清楚的场景' })).toBeInTheDocument();
    const selectedPrimaryNavigation = container.querySelectorAll('.primary-nav button.is-active');
    expect(selectedPrimaryNavigation).toHaveLength(1);
    expect(selectedPrimaryNavigation[0]).toHaveTextContent('新练习');
    expect(screen.queryByRole('button', { name: '练习题库' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /论证与反驳.*辩手/ }));
    expect(
      within(screen.getByLabelText('按模式筛选')).getByRole('button', {
        name: /论证与反驳.*辩手/,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    const argumentTask = PRACTICE_TASKS.find((task) => task.mode === 'argument-rebuttal');
    expect(argumentTask).toBeDefined();
    expect(screen.getByRole('heading', { name: argumentTask!.title })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '外观' }));
    expect(
      await screen.findByRole('heading', { name: '外观' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /浅色/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /深色/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '常规与隐私' }));
    expect(
      await screen.findByRole('heading', { name: '常规与隐私' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '外观' })).not.toBeInTheDocument();
  });

  it('opens one recent practice directly while All opens the history collection', () => {
    const onNavigate = vi.fn();
    const onOpenHistory = vi.fn();
    const { container } = render(
      <Sidebar
        currentScreen="S13"
        onboarding={false}
        onNavigate={onNavigate}
        onOpenHistory={onOpenHistory}
        recentHistory={[{
          id: 'session-recent',
          title: '说明为什么本周应冻结新增需求',
          modeId: 'decision-alignment',
          modeTag: '决策与对齐',
          modeLabel: '决策与对齐 · 产品经理',
          pinnedAt: null,
          updatedAt: '今天 14:32',
          statusLabel: '已完成闭环',
          hasAudio: false,
          focusLabel: '结论先行',
          guidanceLabel: '本地规则',
          attemptSummary: '初讲 + 复讲',
        }]}
        selectedHistoryId="session-recent"
      />,
    );

    const recent = screen.getByRole('button', { name: '说明为什么本周应冻结新增需求' });
    expect(recent).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '练习记录' })).not.toHaveAttribute('aria-current');
    expect(container.querySelectorAll('.primary-nav button.is-active, .recent-practice-row.is-active')).toHaveLength(1);
    fireEvent.click(recent);
    expect(onOpenHistory).toHaveBeenCalledWith('session-recent');
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(onNavigate).toHaveBeenCalledWith('S10');
  });

  it('shows a separate mode tag and exposes real rename, pin and delete actions', () => {
    const item = {
      id: 'session-actions',
      title: '先讲结论，再解释原因。',
      modeId: 'decision-alignment' as const,
      modeTag: '决策与对齐',
      modeLabel: '决策与对齐 · 产品经理',
      pinnedAt: null,
      updatedAt: '今天 14:32',
      statusLabel: '诊断已保存',
      hasAudio: true,
      focusLabel: '结论先行',
      guidanceLabel: '本地规则',
      attemptSummary: '仅初讲',
    };
    const onOpenHistory = vi.fn();
    const onRenameHistory = vi.fn();
    const onSetHistoryPinned = vi.fn();
    const onDeleteHistory = vi.fn();
    const { rerender } = render(
      <Sidebar
        currentScreen="S01"
        onboarding={false}
        onDeleteHistory={onDeleteHistory}
        onNavigate={vi.fn()}
        onOpenHistory={onOpenHistory}
        onRenameHistory={onRenameHistory}
        onSetHistoryPinned={onSetHistoryPinned}
        recentHistory={[item]}
        selectedHistoryId={null}
      />,
    );

    expect(screen.getByText('决策与对齐')).toHaveAttribute('data-mode', 'decision-alignment');
    expect(screen.getByRole('button', { name: item.title })).toHaveAccessibleDescription('决策与对齐');
    const actions = screen.getByRole('button', { name: `管理“${item.title}”` });
    fireEvent.click(actions);
    expect(screen.getByRole('menu', { name: `“${item.title}”的操作` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    expect(onRenameHistory).toHaveBeenCalledWith(item);
    expect(onOpenHistory).not.toHaveBeenCalled();

    fireEvent.click(actions);
    fireEvent.click(screen.getByRole('menuitem', { name: '置顶' }));
    expect(onSetHistoryPinned).toHaveBeenCalledWith(item, true);

    fireEvent.click(actions);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    expect(onDeleteHistory).toHaveBeenCalledWith(item);

    const pinned = { ...item, pinnedAt: '2026-07-21T08:00:00.000Z' };
    rerender(
      <Sidebar
        currentScreen="S01"
        onboarding={false}
        onDeleteHistory={onDeleteHistory}
        onNavigate={vi.fn()}
        onOpenHistory={onOpenHistory}
        onRenameHistory={onRenameHistory}
        onSetHistoryPinned={onSetHistoryPinned}
        recentHistory={[pinned]}
        selectedHistoryId={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: `管理“${item.title}”` }));
    expect(screen.getByRole('button', { name: item.title })).toHaveAccessibleDescription('决策与对齐，已置顶');
    fireEvent.click(screen.getByRole('menuitem', { name: '取消置顶' }));
    expect(onSetHistoryPinned).toHaveBeenLastCalledWith(pinned, false);
  });

  it('supports menu-button arrow, Tab, Escape and scroll focus behavior', async () => {
    const title = '键盘可操作的练习';
    render(
      <Sidebar
        currentScreen="S01"
        onboarding={false}
        onNavigate={vi.fn()}
        onOpenHistory={vi.fn()}
        recentHistory={[{
          id: 'session-keyboard-menu',
          title,
          modeId: 'clear-expression',
          modeTag: '清晰表达',
          modeLabel: '清晰表达 · 通用',
          pinnedAt: null,
          updatedAt: '刚刚',
          statusLabel: '可继续',
          hasAudio: false,
          focusLabel: '待选择',
          guidanceLabel: '待确认',
          attemptSummary: '尚未录音',
        }]}
        selectedHistoryId={null}
      />,
    );
    const trigger = screen.getByRole('button', { name: `管理“${title}”` });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(await screen.findByRole('menuitem', { name: '重命名' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(await screen.findByRole('menuitem', { name: '删除' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(await screen.findByRole('menuitem', { name: '重命名' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    await waitFor(() => expect(screen.getByRole('button', { name: '外观' })).toHaveFocus());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(await screen.findByRole('menuitem', { name: '重命名' })).toHaveFocus();
    fireEvent.scroll(window);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('validates rename input and supports Escape cancellation', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <RenamePracticeDialog
        item={{
          id: 'session-rename-dialog',
          title: '原名称',
          modeId: 'clear-expression',
          modeTag: '清晰表达',
          modeLabel: '清晰表达 · 通用',
          pinnedAt: null,
          updatedAt: '刚刚',
          statusLabel: '诊断已保存',
          hasAudio: false,
          focusLabel: '待选择',
          guidanceLabel: '待确认',
          attemptSummary: '仅初讲',
        }}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    const input = screen.getByRole('textbox', { name: '记录名称' });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: '保存名称' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('名称不能为空');
    fireEvent.change(input, { target: { value: '  新的复盘名称  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
    expect(onConfirm).toHaveBeenCalledWith('新的复盘名称');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('locks every global navigation target while a durable workflow is committing', () => {
    const onNavigate = vi.fn();
    const onOpenHistory = vi.fn();
    render(
      <Sidebar
        currentScreen="S13"
        navigationDisabled
        onboarding={false}
        onNavigate={onNavigate}
        onOpenHistory={onOpenHistory}
        recentHistory={[{
          id: 'session-locked',
          title: '正在提交的练习',
          modeId: 'clear-expression',
          modeTag: '清晰表达',
          modeLabel: '清晰表达 · 通用',
          pinnedAt: null,
          updatedAt: '刚刚',
          statusLabel: '逐字稿待确认',
          hasAudio: true,
          focusLabel: '待选择',
          guidanceLabel: '待确认',
          attemptSummary: '仅初讲',
        }]}
        selectedHistoryId="session-locked"
      />,
    );

    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onOpenHistory).not.toHaveBeenCalled();
  });

  it('keeps global navigation about practice objects while modes stay in the workspace', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '了解并进入练习' }));
    await screen.findByRole('heading', { name: '开始一次练习' });

    const navigation = screen.getByRole('navigation', { name: '产品导航' });
    expect(within(navigation).getByRole('button', { name: '新练习' })).toHaveAttribute('aria-current', 'page');
    expect(within(navigation).getByRole('button', { name: '练习记录' })).toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: '收藏题目' })).toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: '练习设置' })).toBeInTheDocument();
    expect(within(navigation).queryByText('模式')).not.toBeInTheDocument();
    expect(screen.getByLabelText('选择练习模式')).toBeInTheDocument();

    fireEvent.click(within(navigation).getByRole('button', { name: '收藏题目' }));
    expect(await screen.findByRole('heading', { name: '收藏题目' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '练习设置' }));
    expect(await screen.findByRole('heading', { name: '练习设置' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /完成后删除原始音频/ })).toBeChecked();
  });

  it('does not resurrect cleared recent practices when an older history request resolves late', async () => {
    const oldHistory = deferred<Awaited<ReturnType<PhrioDesktopApi['listSessions']>>>();
    const staleSession = createDomainSession({
      id: 'session-cleared-history',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-17T06:32:00.000Z',
    });
    const listSessions = vi.fn()
      .mockImplementationOnce(() => oldHistory.promise)
      .mockResolvedValue([]);
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getBootstrap: async () => ({
          settings: { ...DEFAULT_APP_SETTINGS, onboardingCompleted: true },
          modes: [...P1_MODE_PACKS],
          activeSession: null,
        }),
        getSettings: async () => ({ ...DEFAULT_APP_SETTINGS, onboardingCompleted: true }),
        updateSettings: async (patch: Partial<typeof DEFAULT_APP_SETTINGS>) => ({
          ...DEFAULT_APP_SETTINGS,
          onboardingCompleted: true,
          ...patch,
        }),
        listSessions,
        getEnvironmentStatus: async () => ({
          checkedAt: '2026-07-18T04:00:00.000Z',
          dataDirectory: '/private/phrio-data',
          trainingRecordCount: 1,
          localAsr: {
            ready: true,
            files: [
              { name: 'encoder.int8.onnx', exists: true, readable: true },
              { name: 'decoder.int8.onnx', exists: true, readable: true },
              { name: 'tokens.txt', exists: true, readable: true },
            ],
          },
        }),
        clearTrainingData: async () => ({
          trainingDataCleared: true,
          deletedTrainingRecordCount: 1,
          diagnosticLogs: {
            status: 'cleared',
            deletedFileCount: 0,
            deletedBytes: 0,
            remainingFileCount: 0,
            remainingBytes: 0,
          },
          modelsPreserved: true,
          externalExportsPreserved: true,
          otherUserDataPreserved: true,
        }),
      } as unknown as PhrioDesktopApi,
    });

    render(<App />);
    expect(await screen.findByRole('heading', { name: '开始一次练习' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '常规与隐私' }));
    expect(await screen.findByRole('heading', { name: '常规与隐私' })).toBeInTheDocument();
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: '清除全部训练数据' }));
    fireEvent.click(screen.getByRole('button', { name: '确认永久清除' }));
    expect(await screen.findByText('已清除 1 条训练记录、关联音频和诊断日志。')).toBeInTheDocument();
    await act(async () => {
      oldHistory.resolve([staleSession]);
      await oldHistory.promise;
    });

    expect(screen.queryByRole('button', { name: staleSession.taskSnapshot.title })).not.toBeInTheDocument();
  });

  it('rolls failed audio-retention writes back to the last persisted value', async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error('settings unavailable'));
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getSettings: async () => DEFAULT_APP_SETTINGS,
        updateSettings,
      } as unknown as PhrioDesktopApi,
    });

    render(<PracticeSettingsPage />);
    const deleteAfterCompletion = screen.getByRole('radio', { name: /完成后删除原始音频/ });
    const keepWithSession = screen.getByRole('radio', { name: /随本次练习保存在本机/ });
    await waitFor(() => expect(deleteAfterCompletion).toBeChecked());

    fireEvent.click(keepWithSession);
    fireEvent.click(deleteAfterCompletion);

    expect(await screen.findByText('没有保存成功，已恢复本机中上一次保存的设置。')).toBeInTheDocument();
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(deleteAfterCompletion).toBeChecked();
    expect(keepWithSession).not.toBeChecked();
  });

  it('reconciles a remounted audio-retention page after an earlier write finishes late', async () => {
    const saveGate = deferred<void>();
    let persistedRetention: typeof DEFAULT_APP_SETTINGS.audioRetention = 'delete_on_complete';
    const getSettings = vi.fn(async () => ({
      ...DEFAULT_APP_SETTINGS,
      audioRetention: persistedRetention,
    }));
    const updateSettings = vi.fn(async (
      patch: Parameters<PhrioDesktopApi['updateSettings']>[0],
    ) => {
      await saveGate.promise;
      persistedRetention = patch.audioRetention ?? persistedRetention;
      return {
        ...DEFAULT_APP_SETTINGS,
        audioRetention: persistedRetention,
      };
    });
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: { getSettings, updateSettings } as unknown as PhrioDesktopApi,
    });

    const firstView = render(<PracticeSettingsPage />);
    const keepWithSession = await screen.findByRole('radio', { name: /随本次练习保存在本机/ });
    fireEvent.click(keepWithSession);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledOnce());
    firstView.unmount();

    render(<PracticeSettingsPage />);
    expect(screen.getByRole('radio', { name: /完成后删除原始音频/ })).toBeChecked();
    await act(async () => {
      saveGate.resolve();
      await saveGate.promise;
    });

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /随本次练习保存在本机/ })).toBeChecked();
    });
    expect(persistedRetention).toBe('keep_with_session');
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it('prevents creating a frozen session until editable required fields are complete', () => {
    const onChange = vi.fn();
    const onStart = vi.fn();
    render(
      <TrainingSetupPage
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '',
          goal: '推动一次清晰决定',
          durationSeconds: 90,
        }}
        onChange={onChange}
        onStart={onStart}
      />,
    );

    expect(screen.getByText('必填项 4 / 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '请先补齐必填项' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '听众' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('saves a task from the library into the real favorites collection', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '了解并进入练习' }));
    await screen.findByRole('heading', { name: '开始一次练习' });
    fireEvent.click(screen.getByRole('button', { name: '浏览全部' }));
    await screen.findByRole('heading', { name: '挑一个你真的需要说清楚的场景' });

    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    fireEvent.click(screen.getByRole('button', { name: '收藏题目' }));

    expect(await screen.findByRole('heading', { name: '收藏题目' })).toBeInTheDocument();
    expect(screen.getByText(CANONICAL_TASK.title)).toBeInTheDocument();
  });

  it('renders a single practice record from the frozen Session instead of transient UI state', async () => {
    const session = createDomainSession({
      id: 'session-detail',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-17T06:32:00.000Z',
    });
    const onRepeat = vi.fn();
    const onResume = vi.fn();
    render(
      <PracticeRecordDetailPage
        loadRecord={async () => ({
          session,
          artifacts: [],
          resumable: {
            sessionId: session.id,
            status: session.status,
            screen: 'S03',
            draft: {
              mode: 'decision-alignment',
              task: CANONICAL_TASK,
              audience: session.taskSnapshot.context.audience,
              goal: session.taskSnapshot.context.objective,
              durationSeconds: session.taskSnapshot.recommendedDurationSeconds,
            },
          },
        })}
        onBack={vi.fn()}
        onDeleted={vi.fn()}
        onRepeat={onRepeat}
        onResume={onResume}
        sessionId={session.id}
      />,
    );

    expect(await screen.findByRole('heading', { name: session.taskSnapshot.prompt })).toBeInTheDocument();
    expect(screen.getByText('尚未选择焦点')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续本次练习' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '再练同一题' }));
    expect(onRepeat).toHaveBeenCalledOnce();
  });

  it('shows history resume progress and failure beside the initiating action', async () => {
    const session = createDomainSession({
      id: 'session-resume-feedback',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-17T06:32:00.000Z',
    });
    render(
      <PracticeRecordDetailPage
        loadRecord={async () => ({
          session,
          artifacts: [],
          resumable: {
            sessionId: session.id,
            status: session.status,
            screen: 'S03',
            draft: {
              mode: 'decision-alignment',
              task: CANONICAL_TASK,
              audience: session.taskSnapshot.context.audience,
              goal: session.taskSnapshot.context.objective,
              durationSeconds: session.taskSnapshot.recommendedDurationSeconds,
            },
          },
        })}
        onBack={vi.fn()}
        onDeleted={vi.fn()}
        onRepeat={vi.fn()}
        onResume={vi.fn()}
        resumeBusy
        resumeError="冻结产物没有成功恢复，请重试。"
        sessionId={session.id}
      />,
    );

    expect(await screen.findByRole('button', { name: '正在恢复练习…' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('冻结产物没有成功恢复，请重试。');
    expect(screen.getByRole('button', { name: '再练同一题' })).toBeDisabled();
  });

  it('requires an accessible second step before deleting a frozen practice record', async () => {
    const session = createDomainSession({
      id: 'session-delete-confirmation',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-17T06:32:00.000Z',
    });
    const onDeleted = vi.fn();
    render(
      <PracticeRecordDetailPage
        loadRecord={async () => ({
          session,
          artifacts: [],
          resumable: {
            sessionId: session.id,
            status: session.status,
            screen: 'S03',
            draft: {
              mode: 'decision-alignment',
              task: CANONICAL_TASK,
              audience: session.taskSnapshot.context.audience,
              goal: session.taskSnapshot.context.objective,
              durationSeconds: session.taskSnapshot.recommendedDurationSeconds,
            },
          },
        })}
        onBack={vi.fn()}
        onDeleted={onDeleted}
        onRepeat={vi.fn()}
        onResume={vi.fn()}
        sessionId={session.id}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '删除本次练习' }));
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '删除这次练习？' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认永久删除' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  });

  it('keeps corrected source text, withdrawn evidence and late AI history inspectable in a frozen record', async () => {
    const session = createDomainSession({
      id: 'session-history-evidence',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-17T06:32:00.000Z',
    });
    const snapshot: AttemptSnapshot = {
      schemaVersion: 1,
      id: 'snapshot-history-evidence',
      sessionId: session.id,
      attemptId: 'attempt-history-evidence',
      generation: 1,
      kind: 'initial',
      frozenAt: '2026-07-17T06:33:00.000Z',
      audioWatermark: 4_000,
      transcriptVersion: 1,
      finalSegments: [{
        id: 'attempt-history-evidence-seg-0',
        attemptId: 'attempt-history-evidence',
        sequence: 0,
        revision: 1,
        text: '我觉得应该先冻结。',
        startMs: 0,
        endMs: 4_000,
        confidence: null,
        isFinal: true,
        emittedAt: '2026-07-17T06:32:30.000Z',
        finalizedAt: '2026-07-17T06:32:30.000Z',
        modelVersion: 'test-asr-1',
      }],
      annotations: [{
        id: 'annotation-history-evidence',
        displayId: 'O1',
        segmentId: 'attempt-history-evidence-seg-0',
        type: 'hedge',
        sourceSpan: { start: 0, end: 3, text: '我觉得' },
        evidence: '原句“我觉得”',
        suggestion: '直接说出决定。',
        source: 'local_rule',
        lifecycle: 'withdrawn',
        algorithmVersion: 'local-rule-1',
        createdAt: '2026-07-17T06:32:30.000Z',
        updatedAt: '2026-07-17T06:34:00.000Z',
        withdrawnReason: 'transcript_correction_changed_source',
      }],
      hints: [{
        id: 'hint-history-evidence',
        attemptId: 'attempt-history-evidence',
        requestSequence: 1,
        windowHash: 'window-history-1',
        segmentIds: ['attempt-history-evidence-seg-0'],
        text: '先说决定，再补原因。',
        lifecycle: 'stale',
        createdAt: '2026-07-17T06:32:31.000Z',
        updatedAt: '2026-07-17T06:32:35.000Z',
        reason: 'late_result',
      }],
      metrics: {
        finalCharacters: 10,
        finalSegments: 1,
        fillers: 0,
        hedges: 1,
        vagueWords: 0,
        repetitions: 0,
        selfCorrections: 0,
        algorithmVersion: 'local-rule-1',
      },
      focusVersion: null,
    };

    render(
      <PracticeRecordDetailPage
        loadRecord={async () => ({
          session,
          artifacts: [
            { type: 'attempt_snapshot', sessionId: session.id, id: snapshot.id, payload: snapshot },
            {
              type: 'transcript_correction',
              sessionId: session.id,
              id: 'correction-history-evidence',
              payload: {
                id: 'correction-history-evidence',
                snapshotId: snapshot.id,
                segmentId: 'attempt-history-evidence-seg-0',
                originalText: '我觉得应该先冻结。',
                correctedText: '本周应先冻结新增需求。',
                createdAt: '2026-07-17T06:34:00.000Z',
              },
            },
          ],
          resumable: {
            sessionId: session.id,
            status: session.status,
            screen: 'S05',
            draft: {
              mode: 'decision-alignment',
              task: CANONICAL_TASK,
              audience: session.taskSnapshot.context.audience,
              goal: session.taskSnapshot.context.objective,
              durationSeconds: session.taskSnapshot.recommendedDurationSeconds,
            },
          },
        })}
        onBack={vi.fn()}
        onDeleted={vi.fn()}
        onRepeat={vi.fn()}
        onResume={vi.fn()}
        sessionId={session.id}
      />,
    );

    expect(await screen.findByText('本周应先冻结新增需求。')).toBeInTheDocument();
    expect(screen.getByText('ASR 原句：我觉得应该先冻结。')).toBeInTheDocument();
    expect(screen.getByText(/已撤回 · 历史保留 · 直接说出决定/)).toBeInTheDocument();
    expect(screen.getByText('迟到结果已丢弃')).toBeInTheDocument();
    expect(screen.getByText('先说决定，再补原因。')).toBeInTheDocument();
  });

  it('starts a one-off free practice with the entered topic and freezes common mode', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '了解并进入练习' }));
    await screen.findByRole('heading', { name: '开始一次练习' });

    fireEvent.change(screen.getByRole('textbox', { name: '自由练习题目' }), {
      target: { value: '复盘今天最难的一次沟通' },
    });
    fireEvent.click(screen.getByRole('button', { name: '直接开始' }));

    expect(
      await screen.findByText('复盘今天最难的一次沟通 · 初讲'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '先把这一遍说完' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '专注' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '证据' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('清晰表达 · 通用')).toBeInTheDocument();
    expect(screen.queryByLabelText('选择练习模式')).not.toBeInTheDocument();
  });

  it('records, stops, replays and accepts a real MediaRecorder blob', async () => {
    const trackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }

      readonly mimeType = 'audio/webm;codecs=opus';
      state: 'inactive' | 'recording' = 'inactive';

      start() {
        this.state = 'recording';
      }

      stop() {
        this.state = 'inactive';
        const dataEvent = new Event('dataavailable') as Event & { data: Blob };
        dataEvent.data = new Blob(['recorded-audio'], { type: this.mimeType });
        this.dispatchEvent(dataEvent);
        this.dispatchEvent(new Event('stop'));
      }
    }

    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:phrio-test'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });

    const onAccept = vi.fn();
    render(
      <RecordingPage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={onAccept}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole('button', { name: '停止录音' }));

    const acceptButton = await screen.findByRole('button', {
      name: '确认使用这遍',
    });
    expect(screen.getByRole('button', { name: '重录' })).toBeInTheDocument();
    expect(document.querySelector('audio source')).toHaveAttribute(
      'src',
      'blob:phrio-test',
    );

    fireEvent.click(acceptButton);
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onAccept.mock.calls[0]?.[0].blob).toBeInstanceOf(Blob);
    expect(trackStop).toHaveBeenCalled();
  });

  it('keeps the same evidence state and stop control across fullscreen, then restores focus on Escape', async () => {
    window.history.replaceState({}, '', '/?qa=1');
    const { container } = render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment', task: CANONICAL_TASK,
          audience: '研发与业务负责人', goal: '推动清晰决定', durationSeconds: 90,
        }}
        onAccept={vi.fn()}
        sessionId="session-qa"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '载入可控 ASR 流' }));
    const stopBefore = await screen.findByRole('button', { name: '结束录音' });
    expect(container.querySelectorAll('.focus-transcript-line')).toHaveLength(4);
    fireEvent.click(screen.getByRole('tab', { name: '证据' }));
    await waitFor(() => expect(container.querySelectorAll('.evidence-row')).toHaveLength(4));
    const segmentText = container.querySelector('.evidence-source-cell p');
    expect(segmentText).not.toBeNull();
    const trigger = screen.getByRole('button', { name: '证据全屏' });
    fireEvent.click(trigger);
    expect(document.documentElement).toHaveAttribute('data-evidence-fullscreen', 'true');
    expect(container.querySelector('.evidence-source-cell p')).toBe(segmentText);
    expect(screen.getByRole('button', { name: '结束录音' })).toBe(stopBefore);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.documentElement).toHaveAttribute('data-evidence-fullscreen', 'false');
  });
});
