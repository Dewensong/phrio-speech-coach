import {
  CheckCircle2,
  Clock3,
  Flag,
  Mic2,
  SlidersHorizontal,
  Target,
  Users,
} from 'lucide-react';

import type { PracticeDraft } from '../types/ui';

interface TrainingSetupPageProps {
  draft: PracticeDraft;
  busy: boolean;
  error?: string;
  onChange: (draft: PracticeDraft) => void;
  onStart: () => void;
}

const SETUP_ROWS = [
  { icon: SlidersHorizontal, label: '模式', key: 'mode' },
  { icon: Flag, label: '任务', key: 'task' },
  { icon: Users, label: '听众', key: 'audience' },
  { icon: Target, label: '沟通目标', key: 'goal' },
  { icon: Clock3, label: '目标时长', key: 'duration' },
] as const;

export function TrainingSetupPage({
  draft,
  busy,
  error,
  onChange,
  onStart,
}: TrainingSetupPageProps) {
  const audienceReady = draft.audience.trim().length > 0;
  const goalReady = draft.goal.trim().length > 0;
  const completedRequiredFields = 3 + Number(audienceReady) + Number(goalReady);
  const canStart = audienceReady && goalReady;
  const rowValue = (key: (typeof SETUP_ROWS)[number]['key']) => {
    if (key === 'mode') return draft.task.modeLabel;
    if (key === 'task') return draft.task.title;
    if (key === 'audience') return draft.audience;
    if (key === 'goal') return draft.goal;
    return `${draft.durationSeconds} 秒`;
  };

  return (
    <div className="screen-grid setup-grid">
      <section className="main-pane setup-main">
        <div className="page-heading compact-heading setup-heading">
          <div>
            <p className="proof-kicker">REHEARSAL SHEET · 01</p>
            <h1>确认这一次要练什么</h1>
            <p>这是一张开口前的排练单。开始后，条件会随本轮记录冻结。</p>
          </div>
          <span className="metadata">必填项 {completedRequiredFields} / 5</span>
        </div>

        <section className="setup-sheet" aria-label="本轮排练单">
          <header>
            <div>
              <span>PHRIO / PRACTICE NOTE</span>
              <strong>{draft.task.modeLabel}</strong>
            </div>
            <span className="sheet-folio" aria-hidden="true">01</span>
          </header>
          <dl className="setup-list">
            {SETUP_ROWS.map(({ icon: Icon, label, key }) => (
              <div key={key}>
                <dt><Icon aria-hidden="true" size={17} />{label}</dt>
                <dd>
                  {key === 'audience' || key === 'goal' ? (
                    <input
                      aria-label={label}
                      aria-invalid={key === 'audience' ? !audienceReady : !goalReady}
                      maxLength={key === 'audience' ? 300 : 500}
                      onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
                      value={draft[key]}
                    />
                  ) : key === 'duration' ? (
                    <select
                      aria-label={label}
                      onChange={(event) => onChange({ ...draft, durationSeconds: Number(event.target.value) })}
                      value={draft.durationSeconds}
                    >
                      {[30, 45, 60, 90, 120, 180].map((seconds) => (
                        <option key={seconds} value={seconds}>{seconds} 秒</option>
                      ))}
                    </select>
                  ) : (
                    <strong>{rowValue(key)}</strong>
                  )}
                  <span>{key === 'task' ? '来自练习题库' : key === 'mode' ? '本轮冻结' : '可在开录前调整'}</span>
                </dd>
              </div>
            ))}
            <div className="setup-constraint">
              <dt><CheckCircle2 aria-hidden="true" size={17} />主要约束</dt>
              <dd>
                <strong>{draft.task.successConditions.join('；')}</strong>
                <span>将随任务快照冻结，并用于同题复讲比较</span>
              </dd>
            </div>
          </dl>
          <footer>
            <span className="privacy-dot" aria-hidden="true" />
            开始前仍可修改；开口之后，不用临时状态改写本轮条件。
          </footer>
        </section>

        {error ? <p className="inline-error" role="alert">{error}</p> : null}
      </section>

      <aside className="inspector setup-inspector">
        <header className="inspector-header">
          <strong>本轮摘要</strong>
          <span className="metadata">READY CHECK</span>
        </header>
        <div className="inspector-task-copy">
          <p className="eyebrow">{draft.task.modeLabel}</p>
          <h2>{draft.task.title}</h2>
          <p>{draft.goal}</p>
        </div>
        <dl className="inspector-facts">
          <div><dt>听众</dt><dd>{draft.audience || '待补充'}</dd></div>
          <div><dt><Mic2 size={15} /> 麦克风</dt><dd>开始时请求权限</dd></div>
          <div><dt>本地音频</dt><dd>完成后可删除</dd></div>
          <div><dt>内容版本</dt><dd>{draft.task.developmentFixture ? '开发示例' : '生产内容包'}</dd></div>
        </dl>
        <div className="inspector-command">
          <small>开始后会创建本轮 Session，并冻结这张排练单。</small>
          <button
            className="primary-button"
            disabled={busy || !canStart}
            onClick={onStart}
            type="button"
          >
            <Mic2 aria-hidden="true" size={16} />
            {busy ? '正在创建…' : canStart ? '开始初讲' : '请先补齐必填项'}
          </button>
        </div>
      </aside>
    </div>
  );
}
