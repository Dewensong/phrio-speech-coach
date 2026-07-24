import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PracticeSessionSchema,
  P1_MODE_PACKS,
  buildLocalDeepReport,
  compareFrozenAttempts,
  createPracticeSession,
  deriveLocalDeepReportId,
  listPracticeFocusOptions,
  type AttemptSnapshot,
  type PracticeArtifact,
  type PracticeSession,
} from '../../src/shared';
import { PRACTICE_TASKS } from '../../src/frontend/data/practice-catalog';
import { DeepComparisonPage } from '../../src/frontend/pages/deep-comparison-page';
import { DeepLanePage } from '../../src/frontend/pages/deep-lane-page';
import { DrillPage } from '../../src/frontend/pages/drill-page';
import {
  PracticeRecordDetailPage,
  derivePracticeRecordDetail,
} from '../../src/frontend/pages/practice-record-detail-page';
import type { PracticeDraft } from '../../src/frontend/types/ui';

const at = '2026-07-17T04:00:00.000Z';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(cleanup);

function snapshot(kind: 'initial' | 'retry'): AttemptSnapshot {
  return {
    schemaVersion: 1,
    id: `snapshot-${kind}`,
    sessionId: 'session-argument',
    attemptId: `attempt-${kind}`,
    generation: 1,
    kind,
    frozenAt: at,
    audioWatermark: 9_000,
    transcriptVersion: 1,
    finalSegments: [{
      id: `attempt-${kind}-seg-0`,
      attemptId: `attempt-${kind}`,
      sequence: 0,
      revision: 1,
      text: kind === 'initial' ? '我的主张是应该谨慎使用。' : '我的主张是应该谨慎使用，因为用户需要保持控制权。',
      startMs: 0,
      endMs: 4_000,
      confidence: null,
      isFinal: true,
      emittedAt: at,
      finalizedAt: at,
      modelVersion: 'test-1',
    }],
    annotations: [],
    hints: [],
    focusVersion: kind === 'retry' ? 1 : null,
    metrics: {
      finalCharacters: 15,
      finalSegments: 1,
      fillers: kind === 'initial' ? 1 : 0,
      hedges: 0,
      vagueWords: 0,
      repetitions: 0,
      selfCorrections: 0,
      algorithmVersion: 'local-rules-1',
    },
  };
}

function withTaskGapEvidence(snapshotInput: AttemptSnapshot): AttemptSnapshot {
  return {
    ...snapshotInput,
    annotations: [{
      id: `${snapshotInput.attemptId}-task-gap-1`,
      displayId: 'O1',
      segmentId: snapshotInput.finalSegments[0]!.id,
      type: 'task_gap',
      sourceSpan: null,
      evidence: '冻结任务要求尚未覆盖论证依据与主张之间的关系。',
      suggestion: '明确说明依据为什么支持主张。',
      source: 'local_metric',
      lifecycle: 'confirmed',
      algorithmVersion: snapshotInput.metrics.algorithmVersion,
      createdAt: at,
      updatedAt: at,
      withdrawnReason: null,
    }],
  };
}

function argumentDraft(): PracticeDraft {
  const task = PRACTICE_TASKS.find((item) => item.id === 'ai-assistant-decisions')!;
  return {
    mode: task.mode,
    task,
    audience: task.audience,
    goal: task.goal,
    durationSeconds: task.durationSeconds,
  };
}

function persistedSession(attemptSnapshot: AttemptSnapshot): PracticeSession {
  const task = P1_MODE_PACKS
    .find((pack) => pack.id === 'argument-rebuttal')!
    .tasks.find((candidate) => candidate.id === 'ai-assistant-decisions')!;
  const base = createPracticeSession({
    id: attemptSnapshot.sessionId,
    modeVersion: '1.0.0',
    task,
    now: at,
  });
  return PracticeSessionSchema.parse({
    ...base,
    status: 'diagnosis',
    attempts: [{
      id: attemptSnapshot.attemptId,
      sessionId: attemptSnapshot.sessionId,
      kind: attemptSnapshot.kind,
      status: 'confirmed',
      audioRef: `${attemptSnapshot.attemptId}.webm`,
      mimeType: 'audio/webm',
      durationMs: attemptSnapshot.audioWatermark,
      byteLength: 1_024,
      createdAt: at,
      updatedAt: at,
      confirmedAt: at,
    }],
  });
}

function selectedArgumentFocus(criterionId = 'claim-evidence-bridge') {
  const option = listPracticeFocusOptions('argument-rebuttal', 'ai-assistant-decisions')
    .find((candidate) => candidate.criterionId === criterionId)!;
  return { ...option, guidanceSource: 'self_directed' as const, evidenceIds: [] };
}

describe('mode-specific Deep UI', () => {
  it('uses the argument Rubric and Drill instead of the decision fixture', async () => {
    const initial = snapshot('initial');
    const session = persistedSession(initial);
    render(
      <DeepLanePage
        cloudDependencies={{ getSession: async () => session }}
        draft={argumentDraft()}
        onStartDrill={vi.fn()}
        sessionId="session-argument"
        snapshot={initial}
      />,
    );

    expect((await screen.findAllByText('论证桥完整')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/我的主张是___。依据是___/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/本周冻结新增需求/)).not.toBeInTheDocument();
  });

  it('records the default task rule as local guidance even without annotation ids', async () => {
    const initial = snapshot('initial');
    const onStartDrill = vi.fn();
    render(
      <DeepLanePage
        cloudDependencies={{ getSession: async () => persistedSession(initial) }}
        draft={argumentDraft()}
        onStartDrill={onStartDrill}
        sessionId="session-argument"
        snapshot={initial}
      />,
    );

    const start = await screen.findByRole(
      'button',
      { name: '选择这个焦点，开始 Drill' },
      { timeout: 5_000 },
    );
    await waitFor(() => expect(start).toBeEnabled(), { timeout: 5_000 });
    fireEvent.click(start);
    expect(onStartDrill).toHaveBeenCalledWith(
      expect.objectContaining({
        guidanceSource: 'local_metric',
        evidenceIds: [],
      }),
      expect.stringMatching(/^deep-report-[a-f0-9]{64}$/),
    );
    expect(screen.getAllByText(/本地任务规则推荐/).length).toBeGreaterThanOrEqual(1);
  });

  it('presents diagnosis as a complete result and exposes non-forced next paths', async () => {
    const initial = withTaskGapEvidence(snapshot('initial'));
    const onFinishAnalysis = vi.fn();
    const onStartFreeRetry = vi.fn();
    const onStartDrill = vi.fn();
    render(
      <DeepLanePage
        cloudDependencies={{ getSession: async () => persistedSession(initial) }}
        draft={argumentDraft()}
        onFinishAnalysis={onFinishAnalysis}
        onStartDrill={onStartDrill}
        onStartFreeRetry={onStartFreeRetry}
        sessionId="session-argument"
        snapshot={initial}
      />,
    );

    const diagnosisHeading = await screen.findByRole('heading', { name: '本轮最需要先处理的一件事' });
    await waitFor(() => expect(diagnosisHeading).toHaveFocus());
    expect(screen.getByText(/冻结证据中仍有弱化/)).toBeInTheDocument();
    expect(screen.getByText('明确说明依据为什么支持主张。')).toBeInTheDocument();
    expect(screen.getByText(/这是诊断建议，不代表已替你选择训练路径/)).toBeInTheDocument();

    const finish = screen.getByRole('button', { name: /保存诊断，结束本轮/ });
    const freeRetry = screen.getByRole('button', { name: /不选焦点，直接复讲/ });
    const drill = screen.getByRole('button', { name: /开始 Drill|正在保存本地复盘/ });
    await waitFor(() => {
      expect(finish).toBeEnabled();
      expect(freeRetry).toBeEnabled();
      expect(drill).toBeEnabled();
      expect(drill).toHaveTextContent('选择这个焦点，开始 Drill');
    });

    fireEvent.click(finish);
    fireEvent.click(freeRetry);
    fireEvent.click(drill);
    const savedReportId = expect.stringMatching(/^deep-report-[a-f0-9]{64}$/);
    expect(onFinishAnalysis).toHaveBeenCalledWith(savedReportId);
    expect(onStartFreeRetry).toHaveBeenCalledWith(savedReportId);
    expect(onStartDrill).toHaveBeenCalledWith(expect.any(Object), savedReportId);
  });

  it('moves focus into a Deep transcript correction and restores its trigger on cancel', async () => {
    const initial = snapshot('initial');
    render(
      <DeepLanePage
        cloudDependencies={{ getSession: async () => persistedSession(initial) }}
        draft={argumentDraft()}
        onStartDrill={vi.fn()}
        sessionId="session-argument"
        snapshot={initial}
      />,
    );

    const trigger = await screen.findByRole('button', { name: '纠正第 1 句' });
    fireEvent.click(trigger);
    expect(screen.getByRole('textbox', { name: '纠正逐字稿' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '纠正第 1 句' })).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: '纠正第 1 句' }));
    fireEvent.click(screen.getByRole('button', { name: '保存纠正' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '纠正第 1 句' })).toHaveFocus());
  });

  it('keeps Drill disabled until a correction and its regenerated report are both persisted', async () => {
    const initial = snapshot('initial');
    const correctionWrite = deferred<PracticeArtifact>();
    const persistPracticeArtifact = vi.fn(async (artifact: PracticeArtifact) => {
      if (artifact.type === 'transcript_correction') return correctionWrite.promise;
      return artifact;
    });
    render(
      <DeepLanePage
        cloudDependencies={{ getSession: async () => persistedSession(initial) }}
        draft={argumentDraft()}
        onStartDrill={vi.fn()}
        persistPracticeArtifact={persistPracticeArtifact}
        sessionId="session-argument"
        snapshot={initial}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '选择这个焦点，开始 Drill' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '纠正第 1 句' }));
    fireEvent.change(screen.getByRole('textbox', { name: '纠正逐字稿' }), {
      target: { value: '这是纠正后的当前句段。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存纠正' }));
    expect(screen.getByRole('button', { name: '正在保存逐字稿纠正…' })).toBeDisabled();

    const correctionArtifact = persistPracticeArtifact.mock.calls
      .map(([artifact]) => artifact)
      .find((artifact) => artifact.type === 'transcript_correction')!;
    await act(async () => correctionWrite.resolve(correctionArtifact));
    await waitFor(() => expect(screen.getByRole('button', { name: '选择这个焦点，开始 Drill' })).toBeEnabled());
    expect(persistPracticeArtifact.mock.calls
      .map(([artifact]) => artifact)
      .filter((artifact) => artifact.type === 'deep_report')).toHaveLength(2);
  });

  it('restores the current report when a correction fails and the editor is cancelled', async () => {
    const initial = snapshot('initial');
    const persistPracticeArtifact = vi.fn(async (artifact: PracticeArtifact) => {
      if (artifact.type === 'transcript_correction') throw new Error('disk unavailable');
      return artifact;
    });
    render(
      <DeepLanePage
        cloudDependencies={{ getSession: async () => persistedSession(initial) }}
        draft={argumentDraft()}
        onStartDrill={vi.fn()}
        persistPracticeArtifact={persistPracticeArtifact}
        sessionId="session-argument"
        snapshot={initial}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '选择这个焦点，开始 Drill' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '纠正第 1 句' }));
    fireEvent.change(screen.getByRole('textbox', { name: '纠正逐字稿' }), {
      target: { value: '这次纠正会写入失败。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存纠正' }));

    await screen.findByText('逐字稿纠正没有保存成功，请在原句旁重试。');
    expect(screen.getByRole('button', { name: '请先保存或取消逐字稿纠正' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '选择这个焦点，开始 Drill' })).toBeEnabled());
  });

  it('records an explicit focus change as self-directed instead of local guidance', async () => {
    const initial = snapshot('initial');
    const onStartDrill = vi.fn();
    const options = listPracticeFocusOptions('argument-rebuttal', 'ai-assistant-decisions');
    const selected = options.find((option) => !option.recommended)!;
    render(
      <DeepLanePage
        cloudDependencies={{ getSession: async () => persistedSession(initial) }}
        draft={argumentDraft()}
        onStartDrill={onStartDrill}
        sessionId="session-argument"
        snapshot={initial}
      />,
    );

    fireEvent.change(await screen.findByRole('combobox', { name: '选择唯一训练焦点' }), {
      target: { value: `${selected.criterionId}:${selected.drillId}` },
    });
    const start = screen.getByRole('button', { name: /开始 Drill|正在保存本地复盘/ });
    await waitFor(() => expect(start).toHaveTextContent('选择这个焦点，开始 Drill'));
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(onStartDrill).toHaveBeenCalledWith(
      expect.objectContaining({
        criterionId: selected.criterionId,
        guidanceSource: 'self_directed',
        evidenceIds: [],
      }),
      expect.stringMatching(/^deep-report-[a-f0-9]{64}$/),
    );
    expect(screen.getAllByText(/由你明确选择/).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps completed reports immutable across focus changes and gates Drill on the current save', async () => {
    const initial = snapshot('initial');
    const stored: PracticeArtifact[] = [];
    const persistPracticeArtifact = vi.fn(async (artifact: PracticeArtifact) => {
      const existing = stored.find((candidate) => candidate.id === artifact.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(artifact)) {
        throw new Error('ARTIFACT_IDENTITY_MISMATCH');
      }
      if (!existing) stored.push(artifact);
      return artifact;
    });
    const onStartDrill = vi.fn();
    const selected = listPracticeFocusOptions('argument-rebuttal', 'ai-assistant-decisions')
      .find((option) => !option.recommended)!;
    render(
      <DeepLanePage
        cloudDependencies={{ getSession: async () => persistedSession(initial) }}
        draft={argumentDraft()}
        loadPracticeArtifacts={async () => []}
        onStartDrill={onStartDrill}
        persistPracticeArtifact={persistPracticeArtifact}
        sessionId="session-argument"
        snapshot={initial}
      />,
    );

    const start = await screen.findByRole('button', { name: /开始 Drill|正在保存本地复盘/ });
    await waitFor(() => expect(stored.filter((artifact) => artifact.type === 'deep_report')).toHaveLength(1));
    expect(start).toBeEnabled();
    const first = stored.find((artifact) => artifact.type === 'deep_report')!;

    fireEvent.change(screen.getByRole('combobox', { name: '选择唯一训练焦点' }), {
      target: { value: `${selected.criterionId}:${selected.drillId}` },
    });
    expect(start).toBeDisabled();
    expect(start).toHaveTextContent('正在保存本地复盘');
    await waitFor(() => expect(stored.filter((artifact) => artifact.type === 'deep_report')).toHaveLength(2));
    expect(start).toBeEnabled();
    const reports = stored.filter(
      (artifact): artifact is Extract<PracticeArtifact, { type: 'deep_report' }> => artifact.type === 'deep_report',
    );
    expect(reports.map((report) => report.id)).toEqual([
      expect.stringMatching(/^deep-report-[a-f0-9]{64}$/),
      expect.stringMatching(/^deep-report-[a-f0-9]{64}$/),
    ]);
    expect(new Set(reports.map((report) => report.id)).size).toBe(2);
    expect(reports[0]).toEqual(first);
    expect(reports[1]!.payload.focus).toMatchObject({
      criterionId: selected.criterionId,
      drillId: selected.drillId,
    });

    fireEvent.click(start);
    expect(onStartDrill).toHaveBeenCalledWith(
      expect.objectContaining({
        criterionId: selected.criterionId,
        guidanceSource: 'self_directed',
      }),
      reports[1]!.id,
    );
  });

  it('keeps Drill blocked after a local report failure and retries in place', async () => {
    const initial = snapshot('initial');
    const persistPracticeArtifact = vi.fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockImplementation(async (artifact: PracticeArtifact) => artifact);
    render(
      <DeepLanePage
        cloudDependencies={{ getSession: async () => persistedSession(initial) }}
        draft={argumentDraft()}
        loadPracticeArtifacts={async () => []}
        onStartDrill={vi.fn()}
        persistPracticeArtifact={persistPracticeArtifact}
        sessionId="session-argument"
        snapshot={initial}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('本地完整复盘没有保存成功');
    expect(screen.getByRole('button', { name: '需先保存本地复盘' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试保存本地复盘' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '选择这个焦点，开始 Drill' })).toBeEnabled());
    expect(persistPracticeArtifact).toHaveBeenCalledTimes(2);
  });

  it('shows the report matching the Session focus and current transcript version in history', async () => {
    const initial = snapshot('initial');
    const base = persistedSession(initial);
    const options = listPracticeFocusOptions('argument-rebuttal', 'ai-assistant-decisions');
    const previous = options[0]!;
    const current = options.find((option) => (
      option.criterionId !== previous.criterionId || option.drillId !== previous.drillId
    ))!;
    const focused = PracticeSessionSchema.parse({
      ...base,
      status: 'drill',
      guidanceSource: 'self_directed',
      focus: {
        criterionId: current.criterionId,
        drillId: current.drillId,
        label: current.criterionLabel,
        guidanceSource: 'self_directed',
        evidenceIds: [],
        selectedAt: at,
      },
    });
    const correction = {
      id: 'history-current-correction',
      snapshotId: initial.id,
      segmentId: initial.finalSegments[0]!.id,
      originalText: initial.finalSegments[0]!.text,
      correctedText: '纠正后的当前逐字稿。',
      createdAt: '2026-07-17T04:00:01.000Z',
    } as const;
    const reportFor = async (
      focus: typeof previous,
      corrections: readonly typeof correction[] = [],
    ) => {
      const id = await deriveLocalDeepReportId({
        snapshotId: initial.id,
        transcriptVersion: initial.transcriptVersion + corrections.length,
        criterionId: focus.criterionId,
        drillId: focus.drillId,
      });
      return buildLocalDeepReport({
        id,
        snapshot: initial,
        at,
        corrections,
        focus: {
          criterionId: focus.criterionId,
          label: focus.criterionLabel,
          drillId: focus.drillId,
          drill: focus.drillTemplate,
        },
      });
    };
    const previousReport = await reportFor(previous);
    const staleCurrentReport = await reportFor(current);
    const currentReport = await reportFor(current, [correction]);
    const artifacts: PracticeArtifact[] = [
      { type: 'attempt_snapshot', sessionId: focused.id, id: initial.id, payload: initial },
      { type: 'deep_report', sessionId: focused.id, id: currentReport.id, payload: currentReport },
      { type: 'transcript_correction', sessionId: focused.id, id: correction.id, payload: correction },
      { type: 'deep_report', sessionId: focused.id, id: staleCurrentReport.id, payload: staleCurrentReport },
      { type: 'deep_report', sessionId: focused.id, id: previousReport.id, payload: previousReport },
    ];
    expect(derivePracticeRecordDetail(artifacts, focused).report?.id).toBe(currentReport.id);
    render(
      <PracticeRecordDetailPage
        loadRecord={async () => ({
          session: focused,
          artifacts,
          resumable: {
            sessionId: focused.id,
            status: focused.status,
            screen: 'S07',
            draft: argumentDraft(),
            selectedFocus: { ...current, guidanceSource: 'self_directed', evidenceIds: [] },
          },
        })}
        onBack={vi.fn()}
        onDeleted={vi.fn()}
        onRepeat={vi.fn()}
        onResume={vi.fn()}
        sessionId={focused.id}
      />,
    );

    expect(await screen.findByRole('heading', { name: current.criterionLabel })).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(current.successCondition)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(current.drillTemplate)).toBeInTheDocument();
    expect(screen.queryByText(previous.drillTemplate)).not.toBeInTheDocument();
  });

  it('labels an analysis-only record as a saved diagnosis instead of a completed loop', async () => {
    const initial = snapshot('initial');
    const base = persistedSession(initial);
    const focusOptions = listPracticeFocusOptions('argument-rebuttal', 'ai-assistant-decisions');
    const focus = focusOptions[0]!;
    const competingFocus = focusOptions[1]!;
    const reportFor = async (option: typeof focus) => buildLocalDeepReport({
      id: await deriveLocalDeepReportId({
        snapshotId: initial.id,
        transcriptVersion: initial.transcriptVersion,
        criterionId: option.criterionId,
        drillId: option.drillId,
      }),
      snapshot: initial,
      at,
      focus: {
        criterionId: option.criterionId,
        label: option.criterionLabel,
        drillId: option.drillId,
        drill: option.drillTemplate,
      },
    });
    const report = await reportFor(focus);
    const competingReport = await reportFor(competingFocus);
    const completed = PracticeSessionSchema.parse({
      ...base,
      status: 'completed',
      outcome: 'analysis_only',
      diagnosisReportId: report.id,
    });
    const artifacts: PracticeArtifact[] = [
      { type: 'attempt_snapshot', sessionId: completed.id, id: initial.id, payload: initial },
      { type: 'deep_report', sessionId: completed.id, id: competingReport.id, payload: competingReport },
      { type: 'deep_report', sessionId: completed.id, id: report.id, payload: report },
    ];
    expect(derivePracticeRecordDetail(artifacts, completed).report?.id).toBe(report.id);
    render(
      <PracticeRecordDetailPage
        loadRecord={async () => ({
          session: completed,
          artifacts,
          resumable: {
            sessionId: completed.id,
            status: completed.status,
            screen: 'S10',
            draft: argumentDraft(),
            selectedFocus: null,
          },
        })}
        onBack={vi.fn()}
        onDeleted={vi.fn()}
        onRepeat={vi.fn()}
        onResume={vi.fn()}
        sessionId={completed.id}
      />,
    );

    expect(await screen.findByText('诊断已保存')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '诊断已保存，本轮在这里结束' })).toBeInTheDocument();
    expect(screen.getByText(/这是诊断建议，不代表已替你选择训练路径/)).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(focus.successCondition)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(focus.drillTemplate)).toBeInTheDocument();
    expect(screen.queryByText(competingFocus.drillTemplate)).not.toBeInTheDocument();
    expect(screen.queryByText('已完成完整练习闭环')).not.toBeInTheDocument();
  });

  it('shows the exact comparison the completed Session records instead of guessing the latest one', () => {
    const initial = snapshot('initial');
    const retry = snapshot('retry');
    const base = persistedSession(initial);
    const focus = selectedArgumentFocus();
    const earlier = compareFrozenAttempts({
      id: 'comparison-explicitly-viewed',
      initial,
      retry,
      criterionId: focus.criterionId,
      comparisonDimension: focus.comparisonDimension,
      at: '2026-07-17T04:00:01.000Z',
    });
    const later = compareFrozenAttempts({
      id: 'comparison-created-later',
      initial,
      retry,
      criterionId: focus.criterionId,
      comparisonDimension: focus.comparisonDimension,
      at: '2026-07-17T04:00:02.000Z',
    });
    const completed = PracticeSessionSchema.parse({
      ...base,
      status: 'completed',
      outcome: 'practice_loop_completed',
      guidanceSource: focus.guidanceSource,
      focus: {
        criterionId: focus.criterionId,
        drillId: focus.drillId,
        label: focus.criterionLabel,
        guidanceSource: focus.guidanceSource,
        evidenceIds: [],
        selectedAt: at,
      },
      drillCompletedAt: at,
      comparisonArtifactId: earlier.id,
      comparisonViewedAt: at,
      attempts: [
        base.attempts[0],
        {
          id: retry.attemptId,
          sessionId: base.id,
          kind: 'retry',
          status: 'confirmed',
          audioRef: null,
          mimeType: 'audio/webm',
          durationMs: retry.audioWatermark,
          byteLength: 1_024,
          createdAt: at,
          updatedAt: at,
          confirmedAt: at,
        },
      ],
    });
    const artifacts: PracticeArtifact[] = [
      { type: 'attempt_snapshot', sessionId: completed.id, id: initial.id, payload: initial },
      { type: 'attempt_snapshot', sessionId: completed.id, id: retry.id, payload: retry },
      { type: 'attempt_comparison', sessionId: completed.id, id: later.id, payload: later },
      { type: 'attempt_comparison', sessionId: completed.id, id: earlier.id, payload: earlier },
    ];

    expect(derivePracticeRecordDetail(artifacts, completed).comparison?.id).toBe(earlier.id);
  });

  it('renders the mode Drill as a 30-second micro action', () => {
    render(<DrillPage draft={argumentDraft()} onContinue={vi.fn()} />);
    expect(screen.getByText('30 秒微 Drill')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '主张—证据—论证桥' })).toBeInTheDocument();
    expect(screen.getAllByText(/这说明___，因为___/).length).toBeGreaterThanOrEqual(1);
  });

  it('does not claim an argument improvement from an unrelated filler change', () => {
    render(
      <DeepComparisonPage
        busy={false}
        draft={argumentDraft()}
        focus={selectedArgumentFocus()}
        initial={snapshot('initial')}
        onSave={vi.fn()}
        retry={snapshot('retry')}
        sessionId="session-argument"
      />,
    );
    expect(screen.getByRole('heading', { name: /论证桥完整：证据不足/ })).toBeInTheDocument();
    expect(screen.getAllByText(/明确说明依据为什么能够支持当前主张/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('任务要求缺口证据')).toBeInTheDocument();
    expect(screen.getByText(/不能把零条当作已达标/)).toBeInTheDocument();
    expect(screen.getByText(/其他问题数量不会参与本次结论/)).toBeInTheDocument();
    expect(screen.queryByText('填充表达')).not.toBeInTheDocument();
  });

  it('lets a saved retry end before comparison or explicitly enter the paired view', async () => {
    const onFinishWithoutComparison = vi.fn();
    const onEnterComparison = vi.fn();
    const onSave = vi.fn();
    const persistArtifact = vi.fn(async (artifact: PracticeArtifact) => artifact);
    const comparisonTime = '2026-07-17T04:12:34.000Z';
    const now = vi.fn(() => comparisonTime);
    document.documentElement.dataset.reduceMotion = 'true';
    try {
      render(
        <DeepComparisonPage
          busy={false}
          draft={argumentDraft()}
          error="终态证据暂时未保存"
          focus={selectedArgumentFocus()}
          initial={snapshot('initial')}
          loadArtifacts={async () => []}
          now={now}
          onEnterComparison={onEnterComparison}
          onFinishWithoutComparison={onFinishWithoutComparison}
          onSave={onSave}
          persistArtifact={persistArtifact}
          requireExplicitEntry
          retry={snapshot('retry')}
          sessionId="session-argument"
        />,
      );

      expect(screen.getByRole('heading', { name: '第二遍已经保存，不必强制查看对比' })).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('终态证据暂时未保存');
      expect(screen.queryByRole('heading', { name: /论证桥完整：/ })).not.toBeInTheDocument();
      expect(now).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '保存复讲，结束本轮' }));
      expect(onFinishWithoutComparison).toHaveBeenCalledOnce();

      const enter = screen.getByRole('button', { name: '查看同一口径对比' });
      enter.focus();
      expect(enter).toHaveFocus();
      fireEvent.click(enter);
      const comparisonHeading = await screen.findByRole('heading', { name: /论证桥完整：/ });
      await waitFor(() => expect(comparisonHeading).toHaveFocus());
      expect(now).toHaveBeenCalledOnce();
      expect(onEnterComparison).toHaveBeenCalledOnce();

      const save = screen.getByRole('button', { name: /保存本轮练习|正在核对纠正版本/ });
      await waitFor(() => expect(save).toBeEnabled());
      fireEvent.click(save);
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
      const comparisonArtifact = persistArtifact.mock.calls
        .map(([artifact]) => artifact)
        .find((artifact): artifact is Extract<PracticeArtifact, { type: 'attempt_comparison' }> => (
          artifact.type === 'attempt_comparison'
        ));
      expect(comparisonArtifact?.payload.comparedAt).toBe(comparisonTime);
    } finally {
      delete document.documentElement.dataset.reduceMotion;
    }
  });

  it('blocks terminal save until an open retry correction is cancelled or saved', async () => {
    const onSave = vi.fn();
    const persistArtifact = vi.fn(async (artifact: PracticeArtifact) => artifact);
    render(
      <DeepComparisonPage
        busy={false}
        draft={argumentDraft()}
        focus={selectedArgumentFocus()}
        initial={snapshot('initial')}
        loadArtifacts={async () => []}
        onSave={onSave}
        persistArtifact={persistArtifact}
        retry={snapshot('retry')}
        sessionId="session-argument"
      />,
    );

    const terminalSave = screen.getByRole('button', { name: /保存本轮练习|正在核对纠正版本/ });
    await waitFor(() => expect(terminalSave).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: '纠正这句' }));
    fireEvent.change(screen.getByRole('textbox', { name: '复讲逐字稿纠正' }), {
      target: { value: '先保留这条尚未提交的纠正。' },
    });
    expect(terminalSave).toBeDisabled();
    expect(terminalSave).toHaveTextContent('请先保存或取消复讲纠正');
    expect(screen.getByRole('status')).toHaveTextContent('请先保存或取消复讲逐字稿纠正');

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(terminalSave).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: '纠正这句' }));
    fireEvent.change(screen.getByRole('textbox', { name: '复讲逐字稿纠正' }), {
      target: { value: '保存后的复讲纠正。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存纠正' }));
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: '复讲逐字稿纠正' })).not.toBeInTheDocument();
      expect(terminalSave).toBeEnabled();
    });

    fireEvent.click(terminalSave);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(persistArtifact.mock.calls.some(([artifact]) => artifact.type === 'transcript_correction')).toBe(true);
  });

  it('locks retry correction controls and duplicate terminal submits while saving', async () => {
    const comparisonWrite = deferred<PracticeArtifact>();
    const onSave = vi.fn();
    const persistArtifact = vi.fn((artifact: PracticeArtifact) => (
      artifact.type === 'attempt_comparison'
        ? comparisonWrite.promise
        : Promise.resolve(artifact)
    ));
    render(
      <DeepComparisonPage
        busy={false}
        draft={argumentDraft()}
        focus={selectedArgumentFocus()}
        initial={snapshot('initial')}
        loadArtifacts={async () => []}
        onSave={onSave}
        persistArtifact={persistArtifact}
        retry={snapshot('retry')}
        sessionId="session-argument"
      />,
    );

    const terminalSave = screen.getByRole('button', { name: /保存本轮练习|正在核对纠正版本/ });
    await waitFor(() => expect(terminalSave).toBeEnabled());
    fireEvent.click(terminalSave);
    fireEvent.click(terminalSave);

    const correctionTrigger = screen.getByRole('button', { name: '纠正这句' });
    expect(correctionTrigger).toBeDisabled();
    fireEvent.click(correctionTrigger);
    expect(screen.queryByRole('textbox', { name: '复讲逐字稿纠正' })).not.toBeInTheDocument();
    expect(persistArtifact.mock.calls.filter(([artifact]) => artifact.type === 'attempt_comparison')).toHaveLength(1);

    const comparisonArtifact = persistArtifact.mock.calls.find(
      ([artifact]) => artifact.type === 'attempt_comparison',
    )?.[0];
    expect(comparisonArtifact?.type).toBe('attempt_comparison');
    await act(async () => {
      comparisonWrite.resolve(comparisonArtifact!);
      await comparisonWrite.promise;
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  });

  it('keeps a focus-free retry honest instead of inventing a comparison criterion', () => {
    const onFinishWithoutComparison = vi.fn();
    render(
      <DeepComparisonPage
        busy={false}
        draft={argumentDraft()}
        focus={null}
        initial={snapshot('initial')}
        onFinishWithoutComparison={onFinishWithoutComparison}
        onSave={vi.fn()}
        requireExplicitEntry
        retry={{ ...snapshot('retry'), focusVersion: null }}
        sessionId="session-argument"
      />,
    );

    expect(screen.getByText('自由复讲 · 未选择焦点')).toBeInTheDocument();
    expect(screen.getByText(/系统不会借用默认指标伪造“进步”/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看同一口径对比' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存复讲，结束本轮' }));
    expect(onFinishWithoutComparison).toHaveBeenCalledOnce();
  });

  it('shows improvement only when the frozen focus has corresponding paired evidence', () => {
    render(
      <DeepComparisonPage
        busy={false}
        draft={argumentDraft()}
        focus={selectedArgumentFocus()}
        initial={withTaskGapEvidence(snapshot('initial'))}
        onSave={vi.fn()}
        retry={snapshot('retry')}
        sessionId="session-argument"
      />,
    );
    expect(screen.getByRole('heading', { name: /论证桥完整：改善/ })).toBeInTheDocument();
    expect(screen.getByText('1 → 0 条问题信号')).toBeInTheDocument();
    expect(screen.getByText('与冻结任务要求相关的缺口记录')).toBeInTheDocument();
  });

  it('uses the persisted focus and every corrected final segment in the paired view', async () => {
    const initial = snapshot('initial');
    initial.finalSegments.push({
      ...initial.finalSegments[0]!,
      id: 'attempt-initial-seg-1',
      sequence: 1,
      text: '第二句保留完整的初讲证据。',
      startMs: 4_001,
      endMs: 8_000,
    });
    initial.metrics = { ...initial.metrics, finalCharacters: 28, finalSegments: 2 };
    const retry = snapshot('retry');
    retry.finalSegments.push({
      ...retry.finalSegments[0]!,
      id: 'attempt-retry-seg-1',
      sequence: 1,
      text: '第二句保留完整的复讲证据。',
      startMs: 4_001,
      endMs: 8_000,
    });
    retry.metrics = { ...retry.metrics, finalCharacters: 38, finalSegments: 2 };

    render(
      <DeepComparisonPage
        busy={false}
        draft={argumentDraft()}
        focus={selectedArgumentFocus('claim-reason')}
        initial={initial}
        loadArtifacts={async () => [{
          type: 'transcript_correction',
          sessionId: 'session-argument',
          id: 'correction-comparison-1',
          payload: {
            id: 'correction-comparison-1',
            snapshotId: initial.id,
            segmentId: initial.finalSegments[0]!.id,
            originalText: initial.finalSegments[0]!.text,
            correctedText: '纠正后的第一句初讲证据。',
            createdAt: at,
          },
        }]}
        onSave={vi.fn()}
        retry={retry}
        sessionId="session-argument"
      />,
    );

    expect(await screen.findByRole('heading', { name: /论点链条完整：证据不足/ })).toBeInTheDocument();
    expect(await screen.findByText('纠正后的第一句初讲证据。')).toBeInTheDocument();
    expect(screen.getByText('第二句保留完整的初讲证据。')).toBeInTheDocument();
    expect(screen.getByText('第二句保留完整的复讲证据。')).toBeInTheDocument();
    expect(screen.getAllByText(/2 个 final 句段/)).toHaveLength(2);
  });

  it('surfaces artifact save failures without calling completion or leaking a rejection', async () => {
    const onSave = vi.fn();
    const persistArtifact = vi.fn().mockRejectedValue(new Error('disk unavailable'));
    render(
      <DeepComparisonPage
        busy={false}
        draft={argumentDraft()}
        focus={selectedArgumentFocus()}
        initial={snapshot('initial')}
        loadArtifacts={async () => []}
        onSave={onSave}
        persistArtifact={persistArtifact}
        retry={snapshot('retry')}
        sessionId="session-argument"
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '保存本轮练习' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('前后对比没有保存成功');
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: '重新保存本轮练习' })).toBeEnabled());
  });
});
