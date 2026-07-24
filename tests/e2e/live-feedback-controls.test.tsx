import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvidenceLedger } from '../../src/frontend/components/evidence-ledger';
import { CANONICAL_TASK } from '../../src/frontend/data/practice-catalog';
import { LivePracticePage } from '../../src/frontend/pages/live-practice-page';
import {
  createLiveAttemptState,
  listPracticeFocusOptions,
  reduceLiveAttempt,
  type LiveAnnotation,
  type LiveAttemptEvent,
  type TranscriptSegment,
} from '../../src/shared';

const at = '2026-07-17T08:00:00.000Z';

function finalSegment(input: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'attempt-controls-seg-0',
    attemptId: 'attempt-controls',
    sequence: 0,
    revision: 1,
    text: '我觉得本周先冻结新增需求。',
    startMs: 0,
    endMs: 3_000,
    confidence: null,
    isFinal: true,
    emittedAt: at,
    finalizedAt: at,
    modelVersion: 'test-1',
    ...input,
  };
}

function annotation(segment: TranscriptSegment, id = 'annotation-1'): LiveAnnotation {
  return {
    id,
    displayId: 'O1',
    segmentId: segment.id,
    type: 'hedge',
    sourceSpan: { start: 0, end: 3, text: '我觉得' },
    evidence: '原句“我觉得”',
    suggestion: '直接说本周先冻结新增需求。',
    source: 'local_rule',
    lifecycle: 'confirmed',
    algorithmVersion: 'test-1',
    createdAt: at,
    updatedAt: at,
    withdrawnReason: null,
  };
}

type EventWithoutGeneration = LiveAttemptEvent extends infer Event
  ? Event extends LiveAttemptEvent
    ? Omit<Event, 'generation'>
    : never
  : never;

function event(value: EventWithoutGeneration): LiveAttemptEvent {
  return { ...value, generation: 1 } as LiveAttemptEvent;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('live feedback controls', () => {
  it('shows only the common grapheme prefix of consecutive partials as visually stable', async () => {
    let state = createLiveAttemptState({
      sessionId: 'session-partial-stability',
      attemptId: 'attempt-controls',
      generation: 1,
      kind: 'initial',
    });
    const firstPartial = finalSegment({
      id: 'attempt-controls-seg-partial',
      revision: 1,
      text: '你好👍🏽呀',
      isFinal: false,
      finalizedAt: null,
    });
    state = reduceLiveAttempt(state, event({
      id: 'event-partial-first',
      type: 'segment',
      segment: firstPartial,
    }));

    const { container, rerender } = render(
      <EvidenceLedger currentHint="先说决定。" state={state} />,
    );
    expect(container.querySelector('.partial-stable-prefix')).toBeNull();
    expect(container.querySelector('.partial-revisable-suffix')).toHaveTextContent('你好👍🏽呀');

    const revisedPartial = {
      ...firstPartial,
      revision: 2,
      text: '你好👍🏻哦',
      emittedAt: '2026-07-17T08:00:00.100Z',
    };
    state = reduceLiveAttempt(state, event({
      id: 'event-partial-second',
      type: 'segment',
      segment: revisedPartial,
    }));
    rerender(<EvidenceLedger currentHint="先说决定。" state={state} />);

    expect(container.querySelector('.partial-stable-prefix')?.textContent).toBe('你好');
    expect(container.querySelector('.partial-revisable-suffix')?.textContent).toBe('👍🏻哦');
    await waitFor(() => {
      expect(screen.getByText('临时转写：你好👍🏻哦')).toHaveClass('sr-only');
      expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
      expect(screen.getByRole('status')).toHaveAttribute('aria-atomic', 'true');
    }, { timeout: 1_000 });
    expect(screen.getByText('partial 不生成正式证据')).toBeInTheDocument();
  });

  it('resets partial stability after a final, an empty partial and a new generation', () => {
    let state = createLiveAttemptState({
      sessionId: 'session-partial-reset',
      attemptId: 'attempt-controls',
      generation: 1,
      kind: 'initial',
    });
    const partial = finalSegment({ isFinal: false, finalizedAt: null, text: '我们先' });
    state = reduceLiveAttempt(state, event({ id: 'event-reset-partial-1', type: 'segment', segment: partial }));
    const { container, rerender } = render(<EvidenceLedger currentHint="先说决定。" state={state} />);

    state = reduceLiveAttempt(state, event({
      id: 'event-reset-partial-2',
      type: 'segment',
      segment: { ...partial, revision: 2, text: '我们先决定', emittedAt: '2026-07-17T08:00:00.100Z' },
    }));
    rerender(<EvidenceLedger currentHint="先说决定。" state={state} />);
    expect(container.querySelector('.partial-stable-prefix')?.textContent).toBe('我们先');

    state = reduceLiveAttempt(state, event({
      id: 'event-reset-final',
      type: 'segment',
      segment: { ...partial, revision: 3, text: '我们先决定', isFinal: true, finalizedAt: at },
    }));
    rerender(<EvidenceLedger currentHint="先说决定。" state={state} />);
    expect(container.querySelector('.partial-stable-prefix')).toBeNull();

    const nextPartial = finalSegment({
      id: 'attempt-controls-seg-1',
      sequence: 1,
      revision: 1,
      text: '然后解释',
      isFinal: false,
      finalizedAt: null,
    });
    state = reduceLiveAttempt(state, event({ id: 'event-reset-next-partial', type: 'segment', segment: nextPartial }));
    rerender(<EvidenceLedger currentHint="先说决定。" state={state} />);
    expect(container.querySelector('.partial-stable-prefix')).toBeNull();

    state = { ...state, segments: state.segments.filter((segment) => segment.isFinal) };
    rerender(<EvidenceLedger currentHint="先说决定。" state={state} />);
    state = { ...state, segments: [...state.segments, nextPartial] };
    rerender(<EvidenceLedger currentHint="先说决定。" state={state} />);
    expect(container.querySelector('.partial-stable-prefix')).toBeNull();

    state = reduceLiveAttempt(state, event({
      id: 'event-reset-next-partial-revision',
      type: 'segment',
      segment: {
        ...nextPartial,
        revision: 2,
        text: '然后解释原因',
        emittedAt: '2026-07-17T08:00:00.200Z',
      },
    }));
    rerender(<EvidenceLedger currentHint="先说决定。" state={state} />);
    expect(container.querySelector('.partial-stable-prefix')?.textContent).toBe('然后解释');

    const nextGeneration = createLiveAttemptState({
      sessionId: 'session-partial-reset',
      attemptId: 'attempt-controls-next',
      generation: 2,
      kind: 'initial',
    });
    const nextGenerationState = reduceLiveAttempt(nextGeneration, {
      id: 'event-reset-generation',
      generation: 2,
      type: 'segment',
      segment: { ...nextPartial, attemptId: 'attempt-controls-next' },
    });
    rerender(<EvidenceLedger currentHint="先说决定。" state={nextGenerationState} />);
    expect(container.querySelector('.partial-stable-prefix')).toBeNull();
  });

  it('links either O entry point to the same source mark and record', () => {
    const segment = finalSegment();
    let state = createLiveAttemptState({
      sessionId: 'session-linkage',
      attemptId: 'attempt-controls',
      generation: 1,
      kind: 'initial',
    });
    state = reduceLiveAttempt(state, event({ id: 'event-link-segment', type: 'segment', segment }));
    state = reduceLiveAttempt(state, event({
      id: 'event-link-annotation',
      type: 'annotations',
      segmentId: segment.id,
      annotations: [annotation(segment)],
    }));

    const first = render(<EvidenceLedger currentHint="先说决定。" state={state} />);
    fireEvent.click(screen.getByRole('button', { name: /O1.*弱化表达.*已确认/ }));
    expect(first.container.querySelector('.evidence-mark.is-active')).not.toBeNull();
    expect(first.container.querySelector('.evidence-record.is-active')).not.toBeNull();
    first.unmount();

    const second = render(<EvidenceLedger currentHint="先说决定。" state={state} />);
    fireEvent.click(screen.getByRole('button', { name: '定位 O1 弱化表达' }));
    expect(second.container.querySelector('.evidence-mark.is-active')).not.toBeNull();
    expect(second.container.querySelector('.evidence-record.is-active')).not.toBeNull();
  });

  it('hides rendered marks, records and the current hint while retaining the plain transcript, then restores them', () => {
    const segment = finalSegment();
    let state = createLiveAttemptState({
      sessionId: 'session-controls',
      attemptId: 'attempt-controls',
      generation: 1,
      kind: 'initial',
    });
    state = reduceLiveAttempt(state, event({ id: 'event-segment', type: 'segment', segment }));
    state = reduceLiveAttempt(state, event({
      id: 'event-annotation',
      type: 'annotations',
      segmentId: segment.id,
      annotations: [annotation(segment)],
    }));

    const { container, rerender } = render(
      <EvidenceLedger currentHint="先说决定，再给原因。" state={state} />,
    );
    expect(screen.getByLabelText('当前提示')).toHaveTextContent('先说决定，再给原因。');
    expect(screen.getByRole('button', { name: '定位 O1 弱化表达' })).toBeInTheDocument();
    expect(screen.getByText('直接说本周先冻结新增需求。')).toBeInTheDocument();

    state = reduceLiveAttempt(state, event({
      id: 'event-hide-feedback',
      type: 'feedback_visibility',
      visible: false,
    }));
    rerender(<EvidenceLedger currentHint="先说决定，再给原因。" state={state} />);

    expect(screen.getByText(segment.text)).toBeInTheDocument();
    expect(screen.queryByLabelText('当前提示')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '定位 O1 弱化表达' })).not.toBeInTheDocument();
    expect(screen.queryByText('直接说本周先冻结新增需求。')).not.toBeInTheDocument();
    expect(container.querySelector('.evidence-mark')).toBeNull();
    expect(container.querySelector('.evidence-record-cell')).toBeNull();

    state = reduceLiveAttempt(state, event({
      id: 'event-show-feedback',
      type: 'feedback_visibility',
      visible: true,
    }));
    rerender(<EvidenceLedger currentHint="先说决定，再给原因。" state={state} />);
    expect(screen.getByLabelText('当前提示')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '定位 O1 弱化表达' })).toBeInTheDocument();
    expect(container.querySelector('.evidence-mark')).not.toBeNull();
  });

  it('makes the LivePracticePage visibility switch change the rendered workspace without hiding transcript or channel status', async () => {
    window.history.replaceState({}, '', '/?qa=1');
    const { container } = render(
      <LivePracticePage
        attempt="first"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        onAccept={vi.fn()}
        sessionId="session-feedback-qa"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '载入可控 ASR 流' }));
    await waitFor(() => expect(container.querySelectorAll('.focus-transcript-line')).toHaveLength(4));
    expect(screen.getByRole('tab', { name: '专注' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('当前提示')).toBeInTheDocument();
    expect(container.querySelector('.evidence-row')).toBeNull();
    expect(screen.getByText('录音与转写正常')).toBeInTheDocument();

    const focusTab = screen.getByRole('tab', { name: '专注' });
    focusTab.focus();
    fireEvent.keyDown(focusTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '证据' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: '证据' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(container.querySelectorAll('.evidence-row')).toHaveLength(4));
    fireEvent.click(screen.getByText('采集详情'));
    expect(container.querySelector('.capture-health-details')).toHaveAttribute('open');
    fireEvent.click(screen.getByText('反馈设置'));

    expect(screen.getByText(/关闭本地标注只影响之后落定的句段/)).toBeInTheDocument();
    expect(screen.getByLabelText('当前提示')).toBeInTheDocument();
    expect(container.querySelector('.evidence-record')).not.toBeNull();
    const feedbackToggle = screen.getByRole('checkbox', { name: '显示实时反馈' });
    fireEvent.click(feedbackToggle);

    await waitFor(() => expect(screen.queryByLabelText('当前提示')).not.toBeInTheDocument());
    expect(screen.getByLabelText('实时通道状态')).toBeInTheDocument();
    expect(screen.getByText('实时反馈已隐藏 · 分析通道仍运行')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '转录原文继续记录，实时反馈已隐藏' })).toBeInTheDocument();
    expect(container.querySelector('.evidence-source-cell p')).toHaveTextContent('我觉得就是我们可能需要先把这件事的边界说清楚。');
    expect(container.querySelector('.evidence-mark')).toBeNull();
    expect(container.querySelector('.evidence-record')).toBeNull();
    expect(screen.getAllByText('反馈已隐藏')).not.toHaveLength(0);

    fireEvent.click(feedbackToggle);
    await waitFor(() => expect(screen.getByLabelText('当前提示')).toBeInTheDocument());
    expect(container.querySelector('.evidence-mark')).not.toBeNull();
    expect(container.querySelector('.evidence-record')).not.toBeNull();
  });

  it('keeps existing local records but rejects annotations for finals received after local annotation is disabled', () => {
    const first = finalSegment();
    const second = finalSegment({
      id: 'attempt-controls-seg-1',
      sequence: 1,
      text: '第二句继续转写。',
      startMs: 3_100,
      endMs: 5_000,
    });
    let state = createLiveAttemptState({
      sessionId: 'session-controls',
      attemptId: 'attempt-controls',
      generation: 1,
      kind: 'initial',
    });
    state = reduceLiveAttempt(state, event({ id: 'event-first', type: 'segment', segment: first }));
    state = reduceLiveAttempt(state, event({ id: 'event-first-annotation', type: 'annotations', segmentId: first.id, annotations: [annotation(first)] }));
    state = reduceLiveAttempt(state, event({ id: 'event-disable-local', type: 'local_annotations', enabled: false }));
    state = reduceLiveAttempt(state, event({ id: 'event-second', type: 'segment', segment: second }));
    state = reduceLiveAttempt(state, event({ id: 'event-second-annotation', type: 'annotations', segmentId: second.id, annotations: [annotation(second, 'annotation-2')] }));

    expect(state.segments).toHaveLength(2);
    expect(state.annotations).toHaveLength(1);
    expect(state.annotations[0]?.segmentId).toBe(first.id);
  });

  it('keeps the retry guidance on the persisted single focus instead of falling back to the task default', async () => {
    window.history.replaceState({}, '', '/?qa=1');
    const selected = listPracticeFocusOptions('decision-alignment', CANONICAL_TASK.id)[1]!;
    render(
      <LivePracticePage
        attempt="second"
        busy={false}
        draft={{
          mode: 'decision-alignment',
          task: CANONICAL_TASK,
          audience: '研发与业务负责人',
          goal: '推动清晰决定',
          durationSeconds: 90,
        }}
        focus={{ ...selected, guidanceSource: 'self_directed', evidenceIds: [] }}
        onAccept={vi.fn()}
        sessionId="session-retry-focus-qa"
      />,
    );

    expect(screen.getByLabelText('当前提示')).toHaveTextContent(
      `只练“${selected.criterionLabel}”，其他问题留到下一轮。`,
    );
  });
});
