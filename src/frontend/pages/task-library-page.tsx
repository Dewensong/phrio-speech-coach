import { ArrowRight, Search, Star } from 'lucide-react';
import { useState } from 'react';

import { MODE_OPTIONS, PRACTICE_TASKS } from '../data/practice-catalog';
import type { ModeId, PracticeTask } from '../types/ui';

interface TaskLibraryPageProps {
  selectedMode: ModeId;
  selectedTask: PracticeTask;
  onSelectMode: (mode: ModeId) => void;
  onSelectTask: (task: PracticeTask) => void;
  onContinue: () => void;
  favoriteTaskIds: readonly string[];
  favoriteLoadState?: 'loading' | 'ready' | 'error';
  onToggleFavorite: (taskId: string) => void;
  onRetryFavorites?: () => void;
  saveError?: string;
}

export function TaskLibraryPage({
  selectedMode,
  selectedTask,
  onSelectMode,
  onSelectTask,
  onContinue,
  favoriteTaskIds,
  favoriteLoadState = 'ready',
  onToggleFavorite,
  onRetryFavorites,
  saveError,
}: TaskLibraryPageProps) {
  const [query, setQuery] = useState('');
  const keyword = query.trim().toLocaleLowerCase('zh-CN');
  const visibleTasks = PRACTICE_TASKS.filter((task) => (
    task.mode === selectedMode && (
      !keyword || `${task.title} ${task.hint} ${task.modeLabel} ${task.audience} ${task.goal}`
        .toLocaleLowerCase('zh-CN')
        .includes(keyword)
    )
  ));

  return (
    <div className="screen-grid task-library-grid">
      <section className="main-pane task-library-main">
        <div className="page-heading compact-heading">
          <div>
            <h1>挑一个你真的需要说清楚的场景</h1>
            <p>同一套练习闭环，题目条件随模式变化。</p>
          </div>
        </div>

        <label className="search-field">
          <Search aria-hidden="true" size={17} />
          <span className="sr-only">搜索练习题</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索场景、听众或目标…"
            type="search"
            value={query}
          />
        </label>

        <div className="mode-segmented" aria-label="按模式筛选">
          {MODE_OPTIONS.map((mode) => (
            <button
              aria-pressed={selectedMode === mode.id}
              className={selectedMode === mode.id ? 'is-selected' : ''}
              key={mode.id}
              onClick={() => onSelectMode(mode.id)}
              type="button"
            >
              <strong>{mode.title}</strong><span>· {mode.role}</span>
            </button>
          ))}
        </div>

        <section className="recommendations task-library-list">
          <header><h2>推荐给你 · {visibleTasks.length} 个场景</h2></header>
          <div className="task-rows detailed-task-rows">
            {visibleTasks.map((task) => (
              <button
                className={selectedTask.id === task.id ? 'is-selected' : ''}
                key={task.id}
                onClick={() => onSelectTask(task)}
                type="button"
              >
                <span className="row-marker" />
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.hint}</small>
                  <em>{task.modeLabel} · {task.durationSeconds} 秒</em>
                </span>
                <span className="task-favorite-slot">
                  {favoriteTaskIds.includes(task.id) ? <Star aria-label="已收藏" fill="currentColor" size={14} /> : null}
                </span>
                <ArrowRight aria-hidden="true" size={16} />
              </button>
            ))}
            {!visibleTasks.length ? <p className="task-search-empty">当前模式下没有匹配的题目。</p> : null}
          </div>
        </section>
        {favoriteLoadState === 'loading' ? <p role="status">正在读取本机收藏…</p> : null}
        {saveError ? (
          <div className="inline-retry-message">
            <p className="inline-error" role="alert">{saveError}</p>
            {favoriteLoadState === 'error' && onRetryFavorites ? <button className="secondary-button" onClick={onRetryFavorites} type="button">重试读取收藏</button> : null}
          </div>
        ) : null}
      </section>

      <aside className="inspector task-inspector">
        <header className="inspector-header">
          <strong>任务条件</strong>
          <button
            aria-pressed={favoriteTaskIds.includes(selectedTask.id)}
            className="text-button task-favorite-button"
            disabled={favoriteLoadState !== 'ready'}
            onClick={() => onToggleFavorite(selectedTask.id)}
            type="button"
          >
            <Star fill={favoriteTaskIds.includes(selectedTask.id) ? 'currentColor' : 'none'} size={14} />
            {favoriteTaskIds.includes(selectedTask.id) ? '已收藏' : '收藏'}
          </button>
        </header>
        <div className="inspector-task-copy">
          <p className="eyebrow">{selectedTask.modeLabel}</p>
          <h2>{selectedTask.title}</h2>
          <p>{selectedTask.hint}</p>
        </div>
        <dl className="inspector-facts">
          <div><dt>听众</dt><dd>{selectedTask.audience}</dd></div>
          <div><dt>目标时长</dt><dd>{selectedTask.durationSeconds} 秒</dd></div>
          <div><dt>成功条件</dt><dd>{selectedTask.successConditions.join('；')}</dd></div>
        </dl>
        <div className="inspector-command">
          <small>下一步可调整听众、时长和主要约束。</small>
          <button className="primary-button" onClick={onContinue} type="button">
            使用这个任务 <ArrowRight size={16} />
          </button>
        </div>
      </aside>
    </div>
  );
}
