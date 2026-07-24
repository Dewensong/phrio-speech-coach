import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PRACTICE_TASKS } from '../../src/frontend/data/practice-catalog';
import { PracticeRecordDetailPage } from '../../src/frontend/pages/practice-record-detail-page';
import {
  P1_MODE_PACKS,
  PracticeSessionSchema,
  buildLocalDeepReport,
  createPracticeSession,
  listPracticeFocusOptions,
  type AttemptSnapshot,
  type PracticeArtifact,
} from '../../src/shared';

const at = '2026-07-21T08:00:00.000Z';

afterEach(cleanup);

function snapshot(kind: 'initial' | 'retry'): AttemptSnapshot {
  const attemptId = `attempt-record-views-${kind}`;
  const text = kind === 'initial'
    ? '我觉得这个方案比较可行。'
    : '本周应先冻结新增需求，因为验收风险仍未收敛。';
  return {
    schemaVersion: 1,
    id: `snapshot-record-views-${kind}`,
    sessionId: 'session-record-views',
    attemptId,
    generation: kind === 'initial' ? 1 : 2,
    kind,
    frozenAt: kind === 'initial' ? at : '2026-07-21T08:04:00.000Z',
    audioWatermark: 6_000,
    transcriptVersion: 1,
    finalSegments: [{
      id: `${attemptId}-segment-0`,
      attemptId,
      sequence: 0,
      revision: 1,
      text,
      startMs: 0,
      endMs: 6_000,
      confidence: null,
      isFinal: true,
      emittedAt: at,
      finalizedAt: at,
      modelVersion: 'test-asr-1',
    }],
    annotations: kind === 'initial' ? [
      {
        id: 'annotation-record-views-o1',
        displayId: 'O1',
        segmentId: `${attemptId}-segment-0`,
        type: 'hedge',
        sourceSpan: { start: 0, end: 3, text: '我觉得' },
        evidence: '原句“我觉得”',
        suggestion: '直接说出本周的决定。',
        source: 'local_rule',
        lifecycle: 'confirmed',
        algorithmVersion: 'local-rules-1',
        createdAt: at,
        updatedAt: at,
        withdrawnReason: null,
      },
      {
        id: 'annotation-record-views-o2',
        displayId: 'O2',
        segmentId: `${attemptId}-segment-0`,
        type: 'task_gap',
        sourceSpan: null,
        evidence: '尚未明确下一步行动。',
        suggestion: '补充负责人和下一步。',
        source: 'local_metric',
        lifecycle: 'confirmed',
        algorithmVersion: 'local-rules-1',
        createdAt: at,
        updatedAt: at,
        withdrawnReason: null,
      },
    ] : [{
      id: 'annotation-record-views-retry-o1',
      displayId: 'O1',
      segmentId: `${attemptId}-segment-0`,
      type: 'structure',
      sourceSpan: null,
      evidence: '复讲已出现理由连接。',
      suggestion: '保持结论—原因顺序。',
      source: 'local_metric',
      lifecycle: 'confirmed',
      algorithmVersion: 'local-rules-1',
      createdAt: at,
      updatedAt: at,
      withdrawnReason: null,
    }],
    hints: kind === 'initial' ? [{
      id: 'hint-record-views',
      attemptId,
      requestSequence: 1,
      windowHash: 'record-views-window-1',
      segmentIds: [`${attemptId}-segment-0`],
      text: '先说决定，再补负责人和下一步。',
      lifecycle: 'provisional',
      createdAt: at,
      updatedAt: at,
      reason: null,
    }] : [],
    metrics: {
      finalCharacters: text.length,
      finalSegments: 1,
      fillers: 0,
      hedges: kind === 'initial' ? 1 : 0,
      vagueWords: 0,
      repetitions: 0,
      selfCorrections: 0,
      algorithmVersion: 'local-rules-1',
    },
    focusVersion: kind === 'retry' ? 1 : null,
  };
}

describe('practice record result and frozen evidence views', () => {
  it('keeps the diagnosis hierarchy and replays both Attempts in the original shared-row format', async () => {
    const initial = snapshot('initial');
    const retry = snapshot('retry');
    const task = P1_MODE_PACKS
      .find((pack) => pack.id === 'decision-alignment')!
      .tasks.find((candidate) => candidate.id === 'freeze-new-requirements')!;
    const base = createPracticeSession({
      id: initial.sessionId,
      modeVersion: '1.0.0',
      task,
      now: at,
    });
    const correction = {
      id: 'correction-record-views',
      snapshotId: initial.id,
      segmentId: initial.finalSegments[0]!.id,
      originalText: initial.finalSegments[0]!.text,
      correctedText: '本周应先冻结新增需求。',
      createdAt: '2026-07-21T08:02:00.000Z',
    } as const;
    const focus = listPracticeFocusOptions('decision-alignment', 'freeze-new-requirements')[0]!;
    const report = buildLocalDeepReport({
      id: 'report-record-views',
      snapshot: initial,
      corrections: [correction],
      at: correction.createdAt,
      focus: {
        criterionId: focus.criterionId,
        label: focus.criterionLabel,
        drillId: focus.drillId,
        drill: focus.drillTemplate,
      },
    });
    const attempt = (kind: 'initial' | 'retry', attemptSnapshot: AttemptSnapshot) => ({
      id: attemptSnapshot.attemptId,
      sessionId: base.id,
      kind,
      status: 'confirmed' as const,
      audioRef: null,
      mimeType: 'audio/webm',
      durationMs: attemptSnapshot.audioWatermark,
      byteLength: 1_024,
      createdAt: at,
      updatedAt: at,
      confirmedAt: at,
    });
    const session = PracticeSessionSchema.parse({
      ...base,
      status: 'completed',
      outcome: 'free_retry_completed',
      diagnosisReportId: report.id,
      attempts: [attempt('initial', initial), attempt('retry', retry)],
      updatedAt: '2026-07-21T08:05:00.000Z',
    });
    const artifacts: PracticeArtifact[] = [
      { type: 'attempt_snapshot', sessionId: session.id, id: initial.id, payload: initial },
      { type: 'attempt_snapshot', sessionId: session.id, id: retry.id, payload: retry },
      { type: 'transcript_correction', sessionId: session.id, id: correction.id, payload: correction },
      { type: 'deep_report', sessionId: session.id, id: report.id, payload: report },
    ];
    const draftTask = PRACTICE_TASKS.find((candidate) => candidate.id === 'freeze-new-requirements')!;

    const { container } = render(
      <PracticeRecordDetailPage
        loadRecord={async () => ({
          session,
          artifacts,
          resumable: {
            sessionId: session.id,
            status: session.status,
            screen: 'S10',
            draft: {
              mode: draftTask.mode,
              task: draftTask,
              audience: task.context.audience,
              goal: task.context.objective,
              durationSeconds: task.recommendedDurationSeconds,
            },
            selectedFocus: null,
          },
        })}
        onBack={vi.fn()}
        onDeleted={vi.fn()}
        onRepeat={vi.fn()}
        onResume={vi.fn()}
        resumeError="恢复练习失败，请稍后重试。"
        sessionId={session.id}
      />,
    );

    expect(await screen.findByRole('heading', { name: '本轮最需要先处理的一件事' })).toBeInTheDocument();
    expect(screen.getByText('一句话结论')).toBeInTheDocument();
    expect(screen.getByText('为什么这样判断')).toBeInTheDocument();
    expect(screen.getByText('只练一个焦点')).toBeInTheDocument();
    expect(screen.getByText('下一步怎么改')).toBeInTheDocument();
    expect(screen.getByText(correction.correctedText)).toBeInTheDocument();

    const diagnosisTab = screen.getByRole('tab', { name: /诊断结果/ });
    const evidenceTab = screen.getByRole('tab', { name: /实时证据/ });
    expect(diagnosisTab).toHaveAttribute('aria-selected', 'true');
    evidenceTab.focus();
    fireEvent.keyDown(evidenceTab, { key: 'ArrowLeft' });
    expect(diagnosisTab).toHaveFocus();
    fireEvent.keyDown(diagnosisTab, { key: 'ArrowRight' });
    expect(evidenceTab).toHaveFocus();

    expect(await screen.findByRole('heading', { name: '原句与问题逐句对齐' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('恢复练习失败，请稍后重试。');
    expect(container.querySelector('.evidence-source-cell p')?.textContent?.replace(/O\d+/gu, ''))
      .toBe(initial.finalSegments[0]!.text);
    expect(screen.getByLabelText('冻结时提示')).toHaveTextContent('先说决定，再补负责人和下一步。');
    expect(container.querySelector('.evidence-row.is-partial')).toBeNull();
    expect(container.querySelector('.segment-meta')).toHaveTextContent('A1:S01.1');
    expect(container.querySelector('.evidence-mark')).toHaveTextContent('我觉得O1');
    expect(container.querySelector('.evidence-mark')).toHaveAttribute('data-lifecycle', 'withdrawn');
    expect(screen.getByText(/逐字稿纠正后，原精确位置已不再匹配/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '定位 O1 弱化表达' }));
    expect(container.querySelector('.evidence-mark.is-active')).not.toBeNull();
    expect(container.querySelector('.evidence-record.is-active')).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /复讲/ }));
    expect(screen.getByText(retry.finalSegments[0]!.text)).toBeInTheDocument();
    expect(container.querySelector('.segment-meta')).toHaveTextContent('A2:S01.1');

    fireEvent.click(screen.getByRole('tab', { name: /诊断结果/ }));
    fireEvent.click(screen.getByRole('button', { name: /定位冻结原句/ }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /实时证据/ })).toHaveAttribute('aria-selected', 'true'));
    const locatedRecord = container.querySelector<HTMLElement>(
      '.evidence-record[data-evidence-id="annotation-record-views-o2"].is-active',
    );
    expect(locatedRecord).not.toBeNull();
    await waitFor(() => expect(locatedRecord).toHaveFocus());
  });
});
