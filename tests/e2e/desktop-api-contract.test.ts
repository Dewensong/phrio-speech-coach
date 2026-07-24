import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_APP_SETTINGS,
  GATE_C_PM_TASK,
  P1_MODE_PACKS,
  createPracticeSession as createDomainSession,
  listFrozenPracticeFocusOptions,
  transitionSession,
  type PhrioDesktopApi,
  type PracticeSession,
} from '../../src/shared';
import {
  completeOnboarding,
  createPracticeSession,
  getAppSettings,
  getAudioRetentionPreference,
  getDesktopBootstrap,
  getFavoriteTaskIds,
  listPracticeHistory,
  renamePracticeSession,
  resumableSession,
  saveAttemptRecording,
  setAudioRetentionPreference,
  setFavoriteTaskIds,
  setPracticeSessionPinned,
  updateAppSettings,
} from '../../src/frontend/services/desktop-api';
import { CANONICAL_TASK } from '../../src/frontend/data/practice-catalog';

afterEach(() => {
  Reflect.deleteProperty(window, 'phrio');
  vi.restoreAllMocks();
});

describe('renderer desktop API adapter', () => {
  it('uses the frozen create-session and initial audio contracts', async () => {
    const session = {
      id: 'session-test',
    } as PracticeSession;
    const createSession = vi.fn().mockResolvedValue(session);
    const saveAttemptAudio = vi.fn().mockResolvedValue({ id: 'attempt-test' });
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        createSession,
        saveAttemptAudio,
      } as unknown as PhrioDesktopApi,
    });

    const sessionId = await createPracticeSession({
      mode: 'decision-alignment',
      task: CANONICAL_TASK,
      audience: '研发与业务负责人',
      goal: '推动清晰决定',
      durationSeconds: 90,
    });

    expect(sessionId).toBe('session-test');
    expect(createSession).toHaveBeenCalledWith({
      modeId: 'decision-alignment',
      taskId: 'freeze-new-requirements',
      developmentFixture: false,
      taskOverrides: {
        audience: '研发与业务负责人',
        objective: '推动清晰决定',
        durationSeconds: 90,
      },
    });

    const bytes = new Uint8Array([1, 2, 3]);
    await saveAttemptRecording({
      sessionId,
      attemptId: 'attempt-snapshot-test',
      attempt: 'first',
      bytes,
      mimeType: 'audio/webm;codecs=opus',
      durationMs: 1_500,
    });
    expect(saveAttemptAudio).toHaveBeenCalledWith({
      sessionId: 'session-test',
      attemptId: 'attempt-snapshot-test',
      kind: 'initial',
      bytes,
      mimeType: 'audio/webm;codecs=opus',
      durationMs: 1_500,
    });
  });

  it('restores the active local session and persists first-run completion', async () => {
    const setup = createDomainSession({
      id: 'session-resume',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-16T08:00:00.000Z',
    });
    const activeSession = transitionSession(
      setup,
      { type: 'start_practice' },
      '2026-07-16T08:01:00.000Z',
    );
    const updateSettings = vi.fn().mockResolvedValue({
      ...DEFAULT_APP_SETTINGS,
      onboardingCompleted: true,
    });
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getBootstrap: vi.fn().mockResolvedValue({
          modes: [...P1_MODE_PACKS],
          settings: { ...DEFAULT_APP_SETTINGS, onboardingCompleted: true },
          activeSession,
        }),
        updateSettings,
      } as unknown as PhrioDesktopApi,
    });

    const bootstrap = await getDesktopBootstrap();
    expect(bootstrap.onboardingCompleted).toBe(true);
    expect(bootstrap.activeSession).toMatchObject({
      sessionId: 'session-resume',
      status: 'first_attempt',
      screen: 'S04',
      draft: {
        mode: 'decision-alignment',
        durationSeconds: 90,
      },
    });

    await completeOnboarding();
    expect(updateSettings).toHaveBeenCalledWith({ onboardingCompleted: true });
  });

  it('preserves an AI-evidence focus source when a frozen Session is resumed', () => {
    const setup = createDomainSession({
      id: 'session-ai-focus-resume',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-16T08:00:00.000Z',
    });
    const focus = listFrozenPracticeFocusOptions(
      setup.taskSnapshot,
      setup.modeVersion,
    )[0]!;
    const session: PracticeSession = {
      ...setup,
      status: 'drill',
      guidanceSource: 'ai_evidence',
      focus: {
        criterionId: focus.criterionId,
        drillId: focus.drillId,
        label: focus.criterionLabel,
        guidanceSource: 'ai_evidence',
        evidenceIds: ['analysis-input-resume'],
        selectedAt: '2026-07-16T08:04:00.000Z',
      },
      updatedAt: '2026-07-16T08:04:00.000Z',
    };

    expect(resumableSession(session).selectedFocus).toMatchObject({
      criterionId: focus.criterionId,
      drillId: focus.drillId,
      guidanceSource: 'ai_evidence',
      evidenceIds: ['analysis-input-resume'],
    });
  });

  it('persists favorites and practice audio settings through the desktop bridge', async () => {
    const updateSettings = vi.fn()
      .mockResolvedValueOnce({
        ...DEFAULT_APP_SETTINGS,
        favoriteTaskIds: ['freeze-new-requirements'],
      })
      .mockResolvedValueOnce({
        ...DEFAULT_APP_SETTINGS,
        audioRetention: 'keep_with_session',
      });
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue({
          ...DEFAULT_APP_SETTINGS,
          favoriteTaskIds: ['freeze-new-requirements'],
        }),
        updateSettings,
      } as unknown as PhrioDesktopApi,
    });

    expect(await getFavoriteTaskIds()).toEqual(['freeze-new-requirements']);
    expect(await getAudioRetentionPreference()).toBe('delete_on_complete');
    expect(await setFavoriteTaskIds(['freeze-new-requirements', 'freeze-new-requirements']))
      .toEqual(['freeze-new-requirements']);
    expect(await setAudioRetentionPreference('keep_with_session')).toBe('keep_with_session');
    expect(updateSettings).toHaveBeenNthCalledWith(1, {
      favoriteTaskIds: ['freeze-new-requirements'],
    });
    expect(updateSettings).toHaveBeenNthCalledWith(2, {
      audioRetention: 'keep_with_session',
    });
  });

  it('projects frozen record titles, mode tags and pin state from persisted sessions', async () => {
    const base = createDomainSession({
      id: 'session-history-projection',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-21T08:00:00.000Z',
    });
    const listSessions = vi.fn().mockResolvedValue([{
      ...base,
      recordTitle: '先冻结本周新增需求。',
      recordTitleSource: 'first_final',
      pinnedAt: '2026-07-21T08:05:00.000Z',
    }]);
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: { listSessions } as unknown as PhrioDesktopApi,
    });

    expect(await listPracticeHistory()).toEqual([
      expect.objectContaining({
        id: base.id,
        title: '先冻结本周新增需求。',
        modeId: 'decision-alignment',
        modeTag: '决策与对齐',
        modeLabel: '决策与对齐 · 产品经理',
        pinnedAt: '2026-07-21T08:05:00.000Z',
      }),
    ]);
  });

  it('uses the schema-validated record command for rename, pin and unpin', async () => {
    const session = createDomainSession({
      id: 'session-history-actions',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now: '2026-07-21T08:00:00.000Z',
    });
    const updateSessionRecord = vi.fn().mockResolvedValue(session);
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: { updateSessionRecord } as unknown as PhrioDesktopApi,
    });

    await renamePracticeSession(session.id, '周会决策复盘');
    await setPracticeSessionPinned(session.id, true);
    await setPracticeSessionPinned(session.id, false);

    expect(updateSessionRecord).toHaveBeenNthCalledWith(1, {
      sessionId: session.id,
      action: 'rename',
      title: '周会决策复盘',
    });
    expect(updateSessionRecord).toHaveBeenNthCalledWith(2, {
      sessionId: session.id,
      action: 'set_pinned',
      pinned: true,
    });
    expect(updateSessionRecord).toHaveBeenNthCalledWith(3, {
      sessionId: session.id,
      action: 'set_pinned',
      pinned: false,
    });
  });

  it('maps the complete appearance system through the desktop settings bridge', async () => {
    const updateSettings = vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS);
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue({
          ...DEFAULT_APP_SETTINGS,
          theme: 'dark',
          lightAccent: 'ruby',
          darkAccent: 'fog-blue',
          textScale: 1.125,
          reducedMotion: true,
        }),
        updateSettings,
      } as unknown as PhrioDesktopApi,
    });

    await expect(getAppSettings()).resolves.toEqual({
      theme: 'dark',
      lightPalette: 'ruby',
      darkPalette: 'fog-blue',
      textScale: 1.125,
      reduceMotion: true,
    });

    await updateAppSettings({
      theme: 'light',
      lightPalette: 'smoky-jade',
      darkPalette: 'terracotta',
      textScale: 1.25,
      reduceMotion: false,
    });
    expect(updateSettings).toHaveBeenCalledWith({
      theme: 'light',
      lightAccent: 'smoky-jade',
      darkAccent: 'terracotta',
      textScale: 1.25,
      reducedMotion: false,
    });
  });
});
