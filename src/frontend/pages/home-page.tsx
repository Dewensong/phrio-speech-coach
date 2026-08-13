import {
  ArrowRight,
  ChevronDown,
  Clock3,
  Lightbulb,
  Mic2,
  Play,
  RotateCcw,
  Sparkles,
  Users,
} from 'lucide-react';
import { useState } from 'react';

import {
  CANONICAL_TASK,
  MODE_OPTIONS,
  PRACTICE_TASKS,
} from '../data/practice-catalog';
import type { ModeId, PracticeTask } from '../types/ui';

interface HomePageProps {
  selectedMode: ModeId;
  selectedTask: PracticeTask;
  busy: boolean;
  error?: string;
  onSelectMode: (mode: ModeId) => void;
  onSelectTask: (task: PracticeTask) => void;
  onBrowseTasks: () => void;
  onStart: () => void;
  onStartFree: (input: { topic: string; audience: string; goal: string }) => void;
  onResume: () => void;
  onTryDemo?: () => void;
  canResume: boolean;
}

const FREE_PRACTICE_STARTERS = [
  {
    label: '解释一个复杂概念',
    topic: '向不熟悉背景的人解释：最近遇到的一个复杂问题，真正难在哪里？',
    audience: '一位不了解背景但愿意听我说明的人',
    goal: '先说核心结论，再用一个例子把难点讲明白',
  },
  {
    label: '推动一次决定',
    topic: '说明一个现在需要做出的决定：你建议怎么选，为什么？',
    audience: '需要共同做出决定的参与者',
    goal: '先给建议，再说明依据、取舍和下一步',
  },
  {
    label: '复盘一次失误',
    topic: '复盘一件没有达到预期的事：发生了什么，你学到了什么？',
    audience: '一位关心事实和下一步行动的同伴',
    goal: '讲清事实、原因和下次会改变的一个动作',
  },
] as const;

export function HomePage({
  selectedMode,
  selectedTask,
  busy,
  error,
  onSelectMode,
  onSelectTask,
  onBrowseTasks,
  onStart,
  onStartFree,
  onResume,
  onTryDemo = () => undefined,
  canResume,
}: HomePageProps) {
  const [freeTopic, setFreeTopic] = useState('');
  const [freeAudience, setFreeAudience] = useState('任何愿意听我说的人');
  const [freeGoal, setFreeGoal] = useState('把此刻最想表达的内容讲清楚');
  const activeTask = selectedTask.mode === selectedMode
    ? selectedTask
    : selectedMode === 'decision-alignment'
      ? CANONICAL_TASK
      : PRACTICE_TASKS.find((task) => task.mode === selectedMode) ?? CANONICAL_TASK;
  const recommendations = [
    ...PRACTICE_TASKS.filter(
      (task) => task.id !== activeTask.id && task.mode === selectedMode,
    ),
    ...PRACTICE_TASKS.filter(
      (task) => task.id !== activeTask.id && task.mode !== selectedMode,
    ),
  ].slice(0, 3);

  return (
    <div className="screen-grid home-grid">
      <section className="main-pane home-main">
        <div className="page-heading compact-heading home-heading">
          <div>
            <p className="proof-kicker">Phrio · 本地表达排练</p>
            <h1>开始一次练习</h1>
            <p className="home-editorial-line">把想法，说得更清楚。</p>
            <p>先说一遍，只找一个值得改的动作，再说一次。</p>
          </div>
          <button
            className="text-button"
            disabled={!canResume}
            onClick={onResume}
            type="button"
          >
            <RotateCcw aria-hidden="true" size={15} />
            继续上次练习
          </button>
        </div>

        <section className="free-practice-card" aria-labelledby="free-practice-title">
          <header>
            <div>
              <p className="proof-kicker">QUICK START · 30 SEC</p>
              <h2 id="free-practice-title">想到什么，就从这里直接开始说</h2>
              <p>不需要先选模板。留空也可以直接开口。</p>
            </div>
            <span className="sheet-folio" aria-hidden="true">01</span>
          </header>
          <label>
            <span className="sr-only">自由练习题目</span>
            <textarea
              maxLength={1_000}
              onChange={(event) => setFreeTopic(event.target.value)}
              placeholder="可以写一句这次想说什么；留空也能直接开始"
              value={freeTopic}
            />
          </label>
          <div className="free-practice-starters" aria-label="场景灵感">
            <span><Lightbulb aria-hidden="true" size={14} />没有题目？</span>
            {FREE_PRACTICE_STARTERS.map((starter) => (
              <button
                key={starter.label}
                onClick={() => {
                  setFreeTopic(starter.topic);
                  setFreeAudience(starter.audience);
                  setFreeGoal(starter.goal);
                }}
                type="button"
              >
                {starter.label}
              </button>
            ))}
          </div>
          <div className="free-practice-command">
            <details className="free-practice-details">
              <summary>
                <ChevronDown aria-hidden="true" size={14} />
                练习条件
                <small>听众与表达目标</small>
              </summary>
              <div className="free-practice-options">
                <label>
                  听众
                  <input
                    maxLength={300}
                    onChange={(event) => setFreeAudience(event.target.value)}
                    value={freeAudience}
                  />
                </label>
                <label>
                  目标
                  <input
                    maxLength={500}
                    onChange={(event) => setFreeGoal(event.target.value)}
                    value={freeGoal}
                  />
                </label>
              </div>
            </details>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => onStartFree({ topic: freeTopic, audience: freeAudience, goal: freeGoal })}
              type="button"
            >
              <Mic2 aria-hidden="true" size={16} />{busy ? '正在创建…' : '直接开始'}
            </button>
          </div>
          {error ? <p className="inline-error" role="alert">{error}</p> : null}
          <footer>
            <span className="privacy-dot" aria-hidden="true" />
            只有你点击开始后才会请求麦克风；自由题目不会保存为模板。
          </footer>
        </section>

        <section className="home-demo-strip" aria-label="受控演示入口">
          <span><Sparkles aria-hidden="true" size={16} /></span>
          <div>
            <strong>还不确定怎么练？先看一遍完整方法</strong>
            <small>30 秒受控演示 · 不用麦克风 · 不安装模型 · 不创建记录</small>
          </div>
          <button className="secondary-button" onClick={onTryDemo} type="button">
            <Play aria-hidden="true" size={14} />查看演示
          </button>
        </section>

        <section className="guided-practice">
          <header className="section-heading">
            <div>
              <p className="proof-kicker">GUIDED PRACTICE</p>
              <h2>也可以带着一个真实场景练</h2>
            </div>
            <button className="text-button" onClick={onBrowseTasks} type="button">
              浏览全部
            </button>
          </header>

          <div className="mode-segmented" aria-label="选择练习模式">
            {MODE_OPTIONS.map((mode) => (
              <button
                aria-pressed={selectedMode === mode.id}
                className={selectedMode === mode.id ? 'is-selected' : ''}
                key={mode.id}
                onClick={() => onSelectMode(mode.id)}
                type="button"
              >
                <strong>{mode.title}</strong>
                <span>{mode.role}</span>
              </button>
            ))}
          </div>

          <section className="practice-composer">
            <span className="composer-proof-mark" aria-hidden="true">02</span>
            <div className="composer-copy">
              <p className="eyebrow">{activeTask.modeLabel}</p>
              <h2>{activeTask.title}</h2>
              <p>{activeTask.hint}</p>
            </div>
            <footer>
              <div className="composer-meta">
                <span><Users size={15} />听众：{activeTask.audience}</span>
                <span><Clock3 size={15} />建议 {activeTask.durationSeconds} 秒</span>
                <span><Mic2 size={15} />语音输入</span>
              </div>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => {
                  onSelectTask(activeTask);
                  onStart();
                }}
                type="button"
              >
                <Mic2 aria-hidden="true" size={16} />
                {busy ? '正在创建…' : '开始初讲'}
              </button>
            </footer>
          </section>

          <div className="recommendations" aria-label="推荐练习题">
            <div className="task-rows">
              {recommendations.map((task) => (
                <button
                  aria-pressed={activeTask.id === task.id}
                  className={activeTask.id === task.id ? 'is-selected' : ''}
                  key={task.id}
                  onClick={() => {
                    onSelectMode(task.mode);
                    onSelectTask(task);
                  }}
                  type="button"
                >
                  <span className="row-marker" />
                  <strong>{task.title}</strong>
                  <small>{task.modeLabel} · {task.durationSeconds} 秒</small>
                  <ArrowRight aria-hidden="true" size={15} />
                </button>
              ))}
            </div>
          </div>
        </section>
      </section>

      <aside className="inspector home-inspector">
        <header className="inspector-header">
          <strong>这次练习</strong>
          <span className="metadata">DRAFT</span>
        </header>
        <div className="inspector-task-copy">
          <p className="eyebrow">{activeTask.modeLabel}</p>
          <h2>{activeTask.title}</h2>
          <p>{activeTask.goal}</p>
        </div>
        <dl className="inspector-facts">
          <div><dt>听众</dt><dd>{activeTask.audience}</dd></div>
          <div><dt>目标时长</dt><dd>{activeTask.durationSeconds} 秒</dd></div>
          <div><dt>输入方式</dt><dd>真实语音</dd></div>
        </dl>
        <div className="loop-preview">
          <p>这次会经过</p>
          {['初讲', '原句诊断', '选择一个焦点', '短 Drill', '同题复讲', '前后对比'].map(
            (stage, index) => (
              <div className={index === 0 ? 'is-current' : ''} key={stage}>
                <span />
                <strong>{stage}</strong>
                <small>{index === 0 ? '现在' : '待开始'}</small>
              </div>
            ),
          )}
        </div>
        <footer className="inspector-footer-note">
          <ShieldCheckIcon />
          录音、本地模型和记录都留在这台设备上
        </footer>
      </aside>
    </div>
  );
}

function ShieldCheckIcon() {
  return <span className="privacy-dot" aria-hidden="true" />;
}
