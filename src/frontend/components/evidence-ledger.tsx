import { CheckCircle2, Expand, Minimize2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

import type {
  AttemptSnapshot,
  LiveAnnotation,
  LiveAttemptState,
  TranscriptSegment,
} from '../../shared';
import { StablePartialTranscript } from './stable-partial-transcript';

const TYPE_LABELS: Record<LiveAnnotation['type'], string> = {
  filler: '重复 / 填充', hedge: '弱化表达', vague: '指代不清', repetition: '重复 / 填充',
  self_correction: '自我修正', long_pause: '长停顿', speech_rate: '语速',
  structure: '结构信号', task_gap: '任务字段',
};

interface EvidenceLedgerProps {
  readonly state: LiveAttemptState;
  readonly currentHint: string;
  readonly id?: string;
  readonly labelledBy?: string;
}

interface FrozenEvidenceLedgerProps {
  readonly snapshot: AttemptSnapshot;
  readonly annotations?: readonly LiveAnnotation[];
  readonly currentHint: string;
  readonly activeEvidenceId?: string | null;
}

interface SemanticAnchor {
  readonly id: string;
  readonly offset: number;
}

interface LedgerSurfaceProps {
  readonly activeId: string | null;
  readonly annotations: readonly LiveAnnotation[];
  readonly attemptCode: 'A1' | 'A2';
  readonly currentHint: string;
  readonly feedbackVisible: boolean;
  readonly finalSegments: readonly TranscriptSegment[];
  readonly generation: number;
  readonly onActivate: (id: string) => void;
  readonly partial?: TranscriptSegment;
  readonly scrollerRef: RefObject<HTMLDivElement | null>;
  readonly variant: 'live' | 'frozen';
}

function markedText(
  segment: TranscriptSegment,
  annotations: readonly LiveAnnotation[],
  activeId: string | null,
  onActivate: (id: string) => void,
) {
  const spans = annotations
    .filter((item) => item.sourceSpan)
    .sort((a, b) => a.sourceSpan!.start - b.sourceSpan!.start);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const item of spans) {
    const span = item.sourceSpan!;
    if (span.start < cursor) continue;
    parts.push(segment.text.slice(cursor, span.start));
    parts.push(
      <mark
        className={`evidence-mark type-${item.type} ${activeId === item.id ? 'is-active' : ''}`}
        data-lifecycle={item.lifecycle}
        key={item.id}
      >
        {segment.text.slice(span.start, span.end)}
        <button
          aria-label={`定位 ${item.displayId} ${TYPE_LABELS[item.type]}`}
          className="evidence-anchor"
          data-evidence-id={item.id}
          onClick={() => onActivate(item.id)}
          type="button"
        >
          {item.displayId}
        </button>
      </mark>,
    );
    cursor = span.end;
  }
  parts.push(segment.text.slice(cursor));
  return parts;
}

function annotationLifecycleLabel(annotation: LiveAnnotation, variant: LedgerSurfaceProps['variant']) {
  if (annotation.lifecycle === 'withdrawn') {
    return variant === 'frozen' ? '中性历史态 · 本地' : '已撤回 · 本地';
  }
  if (annotation.lifecycle === 'confirmed') return '已确认 · 本地';
  return variant === 'frozen' ? '冻结时暂定 · 本地' : '实时暂定 · 本地';
}

function withdrawnReasonLabel(reason: string | null): string {
  const labels: Readonly<Record<string, string>> = {
    user_correction: '用户纠正后，这条记录已不再适用于当前文本。',
    transcript_correction_changed_source: '逐字稿纠正后，原精确位置已不再匹配。',
    tail_reanalysis_resolved: '尾句收束重算后，这条记录已不再适用。',
    tail_segment_replaced: '尾句更新后，原记录已转为历史。',
    qa_correction_history: '纠正后的迁移历史仍保留。',
    '实时阶段已撤回': '这条记录已在实时阶段撤回，历史仍保留。',
    '逐字稿纠正后，原精确位置已不再匹配': '逐字稿纠正后，原精确位置已不再匹配。',
  };
  return reason ? labels[reason] ?? '这条记录已不适用于当前文本，历史仍保留。' : '迁移历史仍保留。';
}

function LedgerSurface({
  activeId,
  annotations,
  attemptCode,
  currentHint,
  feedbackVisible,
  finalSegments,
  generation,
  onActivate,
  partial,
  scrollerRef,
  variant,
}: LedgerSurfaceProps) {
  const frozen = variant === 'frozen';
  return (
    <>
      <div className="evidence-column-head" aria-hidden="true">
        <span>
          <strong>转录原文</strong>
          <small className="header-meta-wide">
            {frozen
              ? '时间 · sentenceId · 冻结生命周期'
              : feedbackVisible ? '时间 · sentenceId · 生命周期' : '实时反馈已隐藏 · 转录继续记录'}
          </small>
          <small className="header-meta-compact">
            {frozen ? '冻结原句' : feedbackVisible ? '18px 原句' : '反馈已隐藏'}
          </small>
        </span>
        {feedbackVisible ? (
          <span>
            <strong>对应问题与建议</strong>
            <small className="header-meta-wide">划线与 O 记录同色</small>
            <small className="header-meta-compact">同色对齐</small>
          </span>
        ) : null}
      </div>
      {feedbackVisible ? (
        <div className="live-coaching" aria-label={frozen ? '冻结时提示' : '当前提示'}>
          <span>{frozen ? '冻结时提示' : '当前建议'}</span>
          <strong>{currentHint}</strong>
          <small>{frozen ? '实时短提示 · 非最终诊断' : '快反馈 · 暂定 · 完整复盘随后补充'}</small>
        </div>
      ) : null}
      <div className="evidence-ledger" ref={scrollerRef}>
        {finalSegments.map((segment) => {
          const records = annotations.filter((item) => item.segmentId === segment.id);
          return (
            <article className="evidence-row" data-segment-row={segment.id} key={segment.id}>
              <div className="evidence-source-cell">
                <div className="segment-meta">
                  <time>
                    {String(Math.floor(segment.startMs / 60_000)).padStart(2, '0')}:
                    {String(Math.floor(segment.startMs / 1_000) % 60).padStart(2, '0')}–
                    {String(Math.floor(segment.endMs / 60_000)).padStart(2, '0')}:
                    {String(Math.floor(segment.endMs / 1_000) % 60).padStart(2, '0')}
                  </time>
                  <span>· FINAL</span>
                  <span>· {attemptCode}:S{String(segment.sequence + 1).padStart(2, '0')}.1</span>
                  {records.filter((item) => !item.sourceSpan).map((item) => (
                    <button
                      aria-label={`定位 ${item.displayId} ${TYPE_LABELS[item.type]} 整句证据`}
                      className={`segment-evidence-anchor type-${item.type} ${activeId === item.id ? 'is-active' : ''}`}
                      data-evidence-id={item.id}
                      data-lifecycle={item.lifecycle}
                      key={item.id}
                      onClick={() => onActivate(item.id)}
                      type="button"
                    >
                      {item.displayId}<small>整句</small>
                    </button>
                  ))}
                </div>
                <p>{feedbackVisible ? markedText(segment, records, activeId, onActivate) : segment.text}</p>
              </div>
              {feedbackVisible ? (
                <div className="evidence-record-cell">
                  {records.length ? records.map((item) => (
                    <button
                      className={`evidence-record type-${item.type} ${activeId === item.id ? 'is-active' : ''}`}
                      data-evidence-id={item.id}
                      data-lifecycle={item.lifecycle}
                      key={item.id}
                      onClick={() => onActivate(item.id)}
                      type="button"
                    >
                      <span className="record-heading">
                        <b>{item.displayId}</b>
                        <strong>{TYPE_LABELS[item.type]}</strong>
                        <em>{annotationLifecycleLabel(item, variant)}</em>
                      </span>
                      <span className="record-suggestion">
                        {item.lifecycle === 'withdrawn'
                          ? `${item.evidence.replace('原句', '')} 已转为中性历史态。${withdrawnReasonLabel(item.withdrawnReason)}`
                          : item.suggestion}
                      </span>
                    </button>
                  )) : (
                    <p className="record-empty"><CheckCircle2 aria-hidden="true" size={14} />当前句未发现需打断的问题</p>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
        {partial ? (
          <article className="evidence-row is-partial" data-segment-row={partial.id}>
            <div className="evidence-source-cell">
              <div className="segment-meta"><span>partial · 临时</span></div>
              <StablePartialTranscript
                key={`${generation}:${finalSegments.length}:${partial.id}`}
                observationKey={`${partial.revision}:${partial.emittedAt}`}
                text={partial.text}
              />
            </div>
            {feedbackVisible ? (
              <div className="evidence-record-cell"><p className="record-empty">partial 不生成正式证据</p></div>
            ) : null}
          </article>
        ) : null}
        {!finalSegments.length && !partial ? (
          <div className="evidence-empty">
            <strong>{frozen ? '本次没有可回放的 final' : '等待你开口'}</strong>
            <span>{frozen
              ? 'partial 是临时状态，不进入冻结记录；这里不会事后拼造转写过程。'
              : feedbackVisible
                ? 'partial 会先出现；只有 final 会进入右侧证据记录。'
                : 'partial 与 final 会继续进入转录原文；实时反馈当前隐藏。'}</span>
          </div>
        ) : null}
      </div>
    </>
  );
}

export function EvidenceLedger({ currentHint, id, labelledBy, state }: EvidenceLedgerProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<SemanticAnchor | null>(null);

  const captureAnchor = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-segment-row]')];
    const row = rows.find((candidate) => candidate.getBoundingClientRect().bottom > scrollerTop) ?? rows[0];
    if (row) anchorRef.current = { id: row.dataset.segmentRow!, offset: row.getBoundingClientRect().top - scrollerTop };
  }, []);

  const restoreAnchor = useCallback(() => {
    const scroller = scrollerRef.current;
    const anchor = anchorRef.current;
    if (!scroller || !anchor) return;
    const row = scroller.querySelector<HTMLElement>(`[data-segment-row="${anchor.id}"]`);
    if (!row) return;
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
  }, []);

  const setEvidenceFullscreen = useCallback((next: boolean) => {
    captureAnchor();
    document.documentElement.dataset.evidenceFullscreen = next ? 'true' : 'false';
    setFullscreen(next);
    requestAnimationFrame(() => {
      restoreAnchor();
      if (!next) triggerRef.current?.focus();
    });
  }, [captureAnchor, restoreAnchor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && fullscreen) {
        event.preventDefault();
        setEvidenceFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen, setEvidenceFullscreen]);

  useEffect(() => () => {
    delete document.documentElement.dataset.evidenceFullscreen;
  }, []);

  const activate = (id: string) => {
    setActiveId(id);
    requestAnimationFrame(() => {
      const matches = scrollerRef.current?.querySelectorAll<HTMLElement>(`[data-evidence-id="${id}"]`);
      const target = matches?.[matches.length - 1];
      if (typeof target?.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' });
    });
  };

  const finalSegments = state.segments.filter((segment) => segment.isFinal);
  const partial = state.segments.filter((segment) => !segment.isFinal).at(-1);
  const feedbackVisible = state.realtimeFeedbackVisible;

  return (
    <section
      className={`evidence-workspace ${fullscreen ? 'is-fullscreen' : ''} ${feedbackVisible ? '' : 'is-feedback-hidden'}`}
      aria-label="实时证据工作区"
      aria-labelledby={labelledBy}
      data-feedback-visible={feedbackVisible}
      id={id}
      role={labelledBy ? 'tabpanel' : undefined}
    >
      <header className="evidence-toolbar">
        <button
          className="secondary-button evidence-fullscreen-button"
          onClick={() => setEvidenceFullscreen(!fullscreen)}
          ref={triggerRef}
          type="button"
        >
          {fullscreen ? <Minimize2 aria-hidden="true" size={15} /> : <Expand aria-hidden="true" size={15} />}
          {fullscreen ? '退出证据全屏' : '证据全屏'}
        </button>
      </header>
      <LedgerSurface
        activeId={activeId}
        annotations={state.annotations}
        attemptCode={state.kind === 'initial' ? 'A1' : 'A2'}
        currentHint={currentHint}
        feedbackVisible={feedbackVisible}
        finalSegments={finalSegments}
        generation={state.generation}
        onActivate={activate}
        partial={partial}
        scrollerRef={scrollerRef}
        variant="live"
      />
    </section>
  );
}

export function FrozenEvidenceLedger({
  activeEvidenceId,
  annotations,
  currentHint,
  snapshot,
}: FrozenEvidenceLedgerProps) {
  const [activeId, setActiveId] = useState<string | null>(activeEvidenceId ?? null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const activate = useCallback((id: string) => {
    setActiveId(id);
    requestAnimationFrame(() => {
      const matches = scrollerRef.current?.querySelectorAll<HTMLElement>(`[data-evidence-id="${id}"]`);
      const target = matches?.[matches.length - 1];
      if (typeof target?.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  useEffect(() => {
    setActiveId(activeEvidenceId ?? null);
    if (!activeEvidenceId) return;
    requestAnimationFrame(() => {
      const matches = scrollerRef.current?.querySelectorAll<HTMLElement>(
        `[data-evidence-id="${activeEvidenceId}"]`,
      );
      const target = matches?.[matches.length - 1];
      if (typeof target?.focus === 'function') target.focus({ preventScroll: true });
      if (typeof target?.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
    });
  }, [activeEvidenceId, snapshot.id]);

  return (
    <section className="frozen-evidence-ledger" aria-label="冻结的实时证据工作区">
      <LedgerSurface
        activeId={activeId}
        annotations={annotations ?? snapshot.annotations}
        attemptCode={snapshot.kind === 'initial' ? 'A1' : 'A2'}
        currentHint={currentHint}
        feedbackVisible
        finalSegments={snapshot.finalSegments}
        generation={snapshot.generation}
        onActivate={activate}
        scrollerRef={scrollerRef}
        variant="frozen"
      />
    </section>
  );
}
