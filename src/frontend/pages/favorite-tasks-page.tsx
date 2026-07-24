import { ArrowRight, BookOpen, Star, StarOff } from 'lucide-react';

import { PRACTICE_TASKS } from '../data/practice-catalog';
import type { PracticeTask } from '../types/ui';

interface FavoriteTasksPageProps {
  favoriteTaskIds: readonly string[];
  favoriteLoadState?: 'loading' | 'ready' | 'error';
  onBrowseTasks: () => void;
  onRemoveFavorite: (taskId: string) => void;
  onUseTask: (task: PracticeTask) => void;
  saveError?: string;
  onRetryFavorites?: () => void;
}

export function FavoriteTasksPage({
  favoriteTaskIds,
  favoriteLoadState = 'ready',
  onBrowseTasks,
  onRemoveFavorite,
  onUseTask,
  saveError,
  onRetryFavorites,
}: FavoriteTasksPageProps) {
  const favorites = PRACTICE_TASKS.filter((task) => favoriteTaskIds.includes(task.id));

  return (
    <section className="favorite-tasks-page">
      <header>
        <div>
          <h1>收藏题目</h1>
          <p>把想反复练习的场景留在这里；模式仍在进入题目时选择。</p>
        </div>
        <span>{favorites.length} 个题目</span>
      </header>

      {favoriteLoadState === 'loading' ? <p role="status">正在读取本机收藏…</p> : null}
      {saveError ? (
        <div className="inline-retry-message">
          <p className="inline-error" role="alert">{saveError}</p>
          {favoriteLoadState === 'error' && onRetryFavorites ? <button className="secondary-button" onClick={onRetryFavorites} type="button">重试读取收藏</button> : null}
        </div>
      ) : null}

      {favoriteLoadState === 'ready' && favorites.length ? (
        <div className="favorite-task-list">
          {favorites.map((task) => (
            <article key={task.id}>
              <button className="favorite-task-open" onClick={() => onUseTask(task)} type="button">
                <Star aria-hidden="true" fill="currentColor" size={15} />
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.hint}</small>
                  <em>{task.modeLabel} · {task.durationSeconds} 秒</em>
                </span>
                <ArrowRight aria-hidden="true" size={16} />
              </button>
              <button
                aria-label={`取消收藏：${task.title}`}
                className="icon-button"
                disabled={favoriteLoadState !== 'ready'}
                onClick={() => onRemoveFavorite(task.id)}
                type="button"
              >
                <StarOff aria-hidden="true" size={15} />
              </button>
            </article>
          ))}
        </div>
      ) : favoriteLoadState === 'ready' ? (
        <div className="favorite-task-empty">
          <BookOpen aria-hidden="true" size={24} />
          <h2>还没有收藏题目</h2>
          <p>在练习题库右侧的任务条件中点击“收藏”，之后可从这里直接复练。</p>
          <button className="primary-button" onClick={onBrowseTasks} type="button">去题库看看</button>
        </div>
      ) : null}
    </section>
  );
}
