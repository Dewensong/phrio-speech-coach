import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, Circle, Play, RotateCcw, Timer } from 'lucide-react';

import { getPrimaryPracticeFocus, type DrillCompletion } from '../../shared';
import type { PracticeDraft, SelectedPracticeFocus } from '../types/ui';

interface DrillPageProps {
  readonly sessionId?: string;
  readonly snapshotId?: string | null;
  readonly draft: PracticeDraft;
  readonly focus?: SelectedPracticeFocus | null;
  readonly busy?: boolean;
  readonly error?: string;
  readonly onContinue: (completion: DrillCompletion) => void;
}

export function DrillPage({
  sessionId = 'qa-session',
  snapshotId = null,
  draft,
  focus: providedFocus,
  busy = false,
  error,
  onContinue,
}: DrillPageProps) {
  const fallback = useMemo(
    () => getPrimaryPracticeFocus(draft.mode, draft.task.id),
    [draft.mode, draft.task.id],
  );
  const focus = providedFocus ?? {
    ...fallback,
    recommended: true,
    guidanceSource: 'self_directed' as const,
    evidenceIds: [],
  };
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [rehearsalNote, setRehearsalNote] = useState('');
  const [selfChecked, setSelfChecked] = useState(false);

  useEffect(() => {
    if (startedAt === null) return;
    const update = () => setElapsedMs(Math.min(180_000, Date.now() - startedAt));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const start = () => {
    setStartedAt(Date.now());
    setElapsedMs(0);
    setSelfChecked(false);
  };

  const complete = () => {
    if (startedAt === null || !selfChecked || !snapshotId) return;
    const completedAt = new Date();
    onContinue({
      id: `${sessionId}-drill-${completedAt.getTime()}`.slice(0, 96),
      snapshotId,
      focusVersion: 1,
      criterionId: focus.criterionId,
      drillId: focus.drillId,
      rehearsalNote: rehearsalNote.trim(),
      selfChecked: true,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.min(180_000, Math.max(0, completedAt.getTime() - startedAt)),
    });
  };

  const started = startedAt !== null;
  return (
    <div className="screen-grid drill-grid">
      <section className="main-pane drill-main">
        <div className="page-heading">
          <p className="eyebrow">30 秒微 Drill</p>
          <h1>{focus.drillTitle}</h1>
          <p>{focus.drillInstruction}</p>
          <span className="drill-folio" aria-hidden="true">REHEARSAL · 01</span>
        </div>

        <div className="drill-steps">
          <article>
            <span>1</span>
            <div><h2>看清本轮唯一动作</h2><p>{focus.criterionDescription}</p></div>
            <CheckCircle2 aria-label="已选择" size={18} />
          </article>
          <article className={started ? 'is-active' : ''}>
            <span>2</span>
            <div><h2>按模板口述一遍</h2><p>{focus.drillTemplate}</p></div>
            {started ? <Timer aria-label="计时中" size={18} /> : <Circle aria-label="待开始" size={18} />}
          </article>
          <article className={selfChecked ? 'is-complete' : ''}>
            <span>3</span>
            <div><h2>用成功条件自检</h2><p>{focus.successCondition}</p></div>
            {selfChecked ? <CheckCircle2 aria-label="已自检" size={18} /> : <Circle aria-label="待自检" size={18} />}
          </article>
        </div>

        <section className="drill-rehearsal" aria-label="Drill 练习区">
          <div>
            <Timer size={18} />
            <strong>{started ? `已练习 ${formatDuration(elapsedMs)}` : '准备后开始短练习'}</strong>
          </div>
          <p>{started ? '请按模板真实口述一遍；这里不会录音，也不会发送网络请求。' : '点击开始后计时。完成口述并自检，才会进入同题复讲。'}</p>
          <div className="page-actions">
            {!started ? (
              <button className="primary-button" onClick={start} type="button"><Play size={15} />开始 Drill</button>
            ) : (
              <button className="secondary-button" disabled={busy} onClick={start} type="button"><RotateCcw size={15} />重新计时</button>
            )}
          </div>
          {started ? (
            <>
              <label className="drill-note-field">
                <span>可选：记下一句准备带回复讲的话</span>
                <textarea maxLength={2_000} onChange={(event) => setRehearsalNote(event.target.value)} placeholder="例如：我的建议是本周冻结新增需求，因为……" value={rehearsalNote} />
              </label>
              <label className="drill-self-check">
                <input checked={selfChecked} onChange={(event) => setSelfChecked(event.target.checked)} type="checkbox" />
                <span>我已按模板真实口述一遍，并依据成功条件完成自检。</span>
              </label>
            </>
          ) : null}
        </section>
      </section>

      <aside className="inspector drill-inspector">
        <header className="inspector-header"><strong>本轮焦点</strong></header>
        <div className="focus-card-plain">
          <p>只练一个动作</p>
          <h2>{focus.criterionLabel}</h2>
          <span>其他表达问题留到下一轮，不在这次同时纠正。</span>
        </div>
        <div className="inspector-note">第二遍仍面对同一个任务、听众和限制，才可以进行同口径比较。</div>
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <div className="inspector-command">
          <small>{!started ? '先完成一次短练习。' : !selfChecked ? '完成口述后勾选自检。' : '完成记录会与本次 Session 一起保留。'}</small>
          <button className="primary-button" disabled={busy || !started || !selfChecked || !snapshotId} onClick={complete} type="button">
            {busy ? '正在保存…' : '保存 Drill 并进入复讲'} <ArrowRight size={16} />
          </button>
        </div>
      </aside>
    </div>
  );
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
