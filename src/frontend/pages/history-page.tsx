import { ChevronRight, Clock3, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { PracticeRecordActionsMenu } from '../components/practice-record-actions-menu';
import type { HistoryItemView, ModeId } from '../types/ui';

interface HistoryPageProps {
  readonly error?: string;
  readonly items: readonly HistoryItemView[];
  readonly loading: boolean;
  readonly onDeleteSession: (item: HistoryItemView) => void;
  onOpenSession: (sessionId: string) => void;
  readonly onRenameSession: (item: HistoryItemView) => void;
  readonly onRetry: () => void;
  readonly onSetSessionPinned: (item: HistoryItemView, pinned: boolean) => void;
}

export function HistoryPage({
  error,
  items,
  loading,
  onDeleteSession,
  onOpenSession,
  onRenameSession,
  onRetry,
  onSetSessionPinned,
}: HistoryPageProps) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'all' | ModeId>('all');

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('zh-CN');
    return items.filter((item) => {
      const matchesQuery = !keyword || `${item.title} ${item.focusLabel}`.toLocaleLowerCase('zh-CN').includes(keyword);
      const matchesMode = mode === 'all' || (
        mode === 'clear-expression'
          ? item.modeLabel.startsWith('清晰表达')
          : mode === 'decision-alignment'
            ? item.modeLabel.startsWith('决策与对齐')
            : item.modeLabel.startsWith('论证与反驳')
      );
      return matchesQuery && matchesMode;
    });
  }, [items, mode, query]);
  const practiceFacts = useMemo(() => ({
    total: items.length,
    retries: items.filter((item) => item.hasRetry ?? item.attemptSummary === '初讲 + 复讲').length,
    focused: items.filter((item) => item.hasFocus ?? !['尚未选择焦点', '待选择'].includes(item.focusLabel)).length,
    audio: items.filter((item) => item.hasAudio).length,
  }), [items]);

  return (
    <section className="history-all-page">
      <header className="history-all-heading">
        <div>
          <span className="history-folio" aria-hidden="true">
            LOCAL ARCHIVE · {items.length.toString().padStart(2, '0')}
          </span>
          <h1>回到具体的一次练习</h1>
          <p>点击任一记录查看冻结逐字稿、原句证据、唯一焦点和前后对比。</p>
        </div>
        <span>记录保存在本机 · 当前显示 {filteredItems.length} 条</span>
      </header>

      <section className="practice-facts" aria-label="本地练习轨迹">
        <header>
          <div>
            <span className="history-folio">PRACTICE TRAIL</span>
            <h2>本地练习轨迹</h2>
          </div>
          <p>只统计这台设备上的练习事实，不生成分数或连续打卡压力。</p>
        </header>
        <dl>
          <div><dt>累计练习</dt><dd>{practiceFacts.total}</dd><small>条本地记录</small></div>
          <div><dt>完成复讲</dt><dd>{practiceFacts.retries}</dd><small>次初讲 + 复讲</small></div>
          <div><dt>明确焦点</dt><dd>{practiceFacts.focused}</dd><small>次只练一个动作</small></div>
          <div><dt>本地留音</dt><dd>{practiceFacts.audio}</dd><small>条仍可回放</small></div>
        </dl>
      </section>

      <div className="history-filters">
        <label>
          <Search aria-hidden="true" size={16} />
          <span className="sr-only">搜索练习记录</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务或焦点…"
            value={query}
          />
        </label>
        <select
          aria-label="按模式筛选"
          onChange={(event) => setMode(event.target.value as 'all' | ModeId)}
          value={mode}
        >
          <option value="all">全部模式</option>
          <option value="clear-expression">清晰表达</option>
          <option value="decision-alignment">决策与对齐</option>
          <option value="argument-rebuttal">论证与反驳</option>
        </select>
      </div>

      {error ? (
        <div className="inline-error command-error" role="alert">
          <span>{error}</span>
          <button
            className="text-button"
            onClick={onRetry}
            type="button"
          >
            重新读取
          </button>
        </div>
      ) : null}
      {loading ? <p className="empty-state">正在读取本地记录…</p> : null}
      {!loading && items.length === 0 ? (
        <div className="history-empty-state">
          <Clock3 aria-hidden="true" size={22} />
          <h2>还没有练习记录</h2>
          <p>开始或完成一次练习后，它会出现在左侧“最近练习”和这里。</p>
        </div>
      ) : null}
      {!loading && items.length > 0 && filteredItems.length === 0 ? (
        <p className="empty-state">没有符合当前筛选条件的记录。</p>
      ) : null}

      {filteredItems.length ? (
        <div className="history-table" role="list">
          <div className="history-table-head" aria-hidden="true">
            <span>任务与时间</span><span>本轮焦点</span><span>结果</span><span>引导来源</span><span />
          </div>
          {filteredItems.map((item, index) => (
            <article className={item.pinnedAt ? 'is-pinned' : ''} key={item.id} role="listitem">
              <button className="history-row-open" onClick={() => onOpenSession(item.id)} type="button">
                <span className="history-task-cell">
                  <span className="history-row-number" aria-hidden="true">
                    {(index + 1).toString().padStart(2, '0')}
                  </span>
                  <span className="history-task-copy">
                    <strong>{item.title}</strong>
                    <small>
                      <span className="history-mode-tag" data-mode={item.modeId}>{item.modeTag}</span>
                      {item.pinnedAt ? <span className="history-pinned-label">已置顶</span> : null}
                      <span>{item.updatedAt}</span>
                    </small>
                  </span>
                </span>
                <strong className="history-focus-cell">{item.focusLabel}</strong>
                <span className="history-result-cell">
                  <small>{item.statusLabel}</small>
                  <em>{item.attemptSummary} · {item.hasAudio ? '录音已保留' : '音频未保留'}</em>
                </span>
                <span className="history-guidance-cell">{item.guidanceLabel}</span>
                <ChevronRight aria-hidden="true" size={16} />
              </button>
              <PracticeRecordActionsMenu
                item={item}
                onDelete={onDeleteSession}
                onRename={onRenameSession}
                onSetPinned={onSetSessionPinned}
              />
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
