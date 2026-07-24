import { useLayoutEffect, useRef } from 'react';

import type { LiveAttemptState } from '../../shared';
import { StablePartialTranscript } from './stable-partial-transcript';

interface LiveFocusSurfaceProps {
  readonly attempt: 'first' | 'second';
  readonly currentHint: string;
  readonly id: string;
  readonly labelledBy: string;
  readonly safeEnd: boolean;
  readonly state: LiveAttemptState;
}

function formatSegmentTime(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * A calm, transcript-first projection of the existing attempt state.
 * It cannot mutate partial/final lifecycle, annotations, persistence or consent.
 */
export function LiveFocusSurface({
  attempt,
  currentHint,
  id,
  labelledBy,
  safeEnd,
  state,
}: LiveFocusSurfaceProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const finalSegments = state.segments.filter((segment) => segment.isFinal);
  const partial = state.segments.filter((segment) => !segment.isFinal).at(-1);
  const latestObservation = partial
    ? `${partial.id}:${partial.revision}:${partial.emittedAt}`
    : `${state.generation}:${finalSegments.length}`;

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const latest = scroller?.querySelector<HTMLElement>('[data-focus-latest="true"]');
    if (!scroller || !latest) return;
    if (latest.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().bottom + 48) return;
    if (typeof latest.scrollIntoView === 'function') {
      latest.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }
  }, [latestObservation]);

  return (
    <section aria-labelledby={labelledBy} className="live-focus-surface" id={id} role="tabpanel">
      <header className="focus-surface-heading">
        <div>
          <span className="focus-edition-mark">{attempt === 'first' ? 'A1' : 'A2'}</span>
          <p>{safeEnd
            ? '本遍原句已经冻结'
            : partial
              ? '临时文字会继续修订'
              : finalSegments.length
                ? '只看原句，继续把这一遍说完'
                : '准备好后，从第一句话开始'}</p>
        </div>
        <span className="focus-transcript-count">
          {finalSegments.length} final{partial ? ' · 1 partial' : ''}
        </span>
      </header>

      <div className="focus-transcript-scroll" ref={scrollerRef}>
        {finalSegments.map((segment, index) => (
          <article
            className="focus-transcript-line"
            data-focus-latest={!partial && index === finalSegments.length - 1}
            key={segment.id}
          >
            <span className="focus-line-index">{String(index + 1).padStart(2, '0')}</span>
            <div>
              <span className="focus-line-time">
                {formatSegmentTime(segment.startMs)}–{formatSegmentTime(segment.endMs)} · FINAL
              </span>
              <p>{segment.text}</p>
            </div>
          </article>
        ))}
        {partial ? (
          <article className="focus-transcript-line is-partial" data-focus-latest="true">
            <span className="focus-line-index">··</span>
            <div>
              <span className="focus-line-time">正在听 · PARTIAL</span>
              <StablePartialTranscript
                key={`${state.generation}:${finalSegments.length}:${partial.id}`}
                observationKey={`${partial.revision}:${partial.emittedAt}`}
                text={partial.text}
              />
            </div>
          </article>
        ) : null}
        {!finalSegments.length && !partial ? (
          <div className="focus-transcript-empty">
            <span aria-hidden="true">“</span>
            <strong>这里会跟随你的表达逐句落字</strong>
            <p>partial 只是临时听写；只有 final 会进入本遍记录。</p>
          </div>
        ) : null}
      </div>

      {state.realtimeFeedbackVisible ? (
        <aside aria-label="当前提示" className="focus-current-guidance">
          <span>本遍只记一件事</span>
          <strong>{currentHint}</strong>
          <small>实时建议是暂定提示，完整诊断会在停止并冻结快照后生成。</small>
        </aside>
      ) : (
        <aside className="focus-current-guidance is-hidden">
          <span>实时反馈已隐藏</span>
          <strong>逐字稿仍会继续记录</strong>
          <small>录音、partial/final 与本地分析通道不受影响。</small>
        </aside>
      )}
    </section>
  );
}
