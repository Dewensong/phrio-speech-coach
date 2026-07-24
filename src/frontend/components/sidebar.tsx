import {
  ArrowLeft,
  History,
  MessageSquare,
  Mic2,
  Palette,
  PenLine,
  Pin,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Star,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type { HistoryItemView, ScreenId } from '../types/ui';
import { BrandMark } from './brand-mark';
import { PracticeRecordActionsMenu } from './practice-record-actions-menu';

interface SidebarProps {
  currentScreen: ScreenId;
  onboarding: boolean;
  recentHistory: readonly HistoryItemView[];
  selectedHistoryId: string | null;
  navigationDisabled?: boolean;
  onNavigate: (screen: ScreenId) => void;
  onOpenHistory: (sessionId: string) => void;
  onDeleteHistory?: (item: HistoryItemView) => void;
  onRenameHistory?: (item: HistoryItemView) => void;
  onSetHistoryPinned?: (item: HistoryItemView, pinned: boolean) => void;
}

const SETUP_STEPS = [
  '了解处理边界',
  '检查麦克风',
  '准备本地练习',
  '开始第一次练习',
] as const;

const PRACTICE_SCREENS = new Set<ScreenId>([
  'S01',
  'S02',
  'S03',
  'S04',
  'S05',
  'S06',
  'S07',
  'S08',
  'S09',
]);

function useCompactSidebar(): boolean {
  const [compact, setCompact] = useState(() => (
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1100px)').matches
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 1100px)');
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return compact;
}

export function Sidebar({
  currentScreen,
  onboarding,
  recentHistory,
  selectedHistoryId,
  navigationDisabled = false,
  onNavigate,
  onOpenHistory,
  onDeleteHistory = () => undefined,
  onRenameHistory = () => undefined,
  onSetHistoryPinned = () => undefined,
}: SidebarProps) {
  const compactSidebar = useCompactSidebar();
  const settingsContext = currentScreen === 'S11' || currentScreen === 'S12';
  const recentItems = recentHistory.slice(0, 5);
  const selectedRecentVisible = !compactSidebar && currentScreen === 'S13' && recentItems.some(
    (item) => item.id === selectedHistoryId,
  );
  const historyNavigationActive = currentScreen === 'S10' || (
    currentScreen === 'S13' && !selectedRecentVisible
  );

  return (
    <aside
      className={`sidebar ${onboarding ? 'sidebar-onboarding' : ''} ${
        settingsContext ? 'sidebar-settings' : ''
      }`}
    >
      {settingsContext ? (
        <button className="settings-back" disabled={navigationDisabled} onClick={() => onNavigate('S01')} type="button">
          <ArrowLeft aria-hidden="true" size={16} />返回练习
        </button>
      ) : (
        <div className="brand-lockup" aria-label="Phrio">
          <BrandMark className="brand-mark" />
          <span className="brand-name">Phrio</span>
        </div>
      )}

      {onboarding ? (
        <>
          <p className="sidebar-section-label">首次设置</p>
          <ol className="setup-steps">
            {SETUP_STEPS.map((step, index) => (
              <li className={index === 0 ? 'is-active' : ''} key={step}>
                <span>{index + 1}</span>
                <strong>{step}</strong>
              </li>
            ))}
          </ol>
          <div className="sidebar-promise">
            <strong>再说一遍，会更清楚。</strong>
            <span>设置保存在这台设备上</span>
          </div>
        </>
      ) : settingsContext ? (
        <nav className="settings-nav" aria-label="设置导航">
          <p className="sidebar-section-label">个人</p>
          <button
            aria-label="常规与隐私"
            className={currentScreen === 'S12' ? 'is-active' : ''}
            disabled={navigationDisabled}
            onClick={() => onNavigate('S12')}
            type="button"
          >
            <Settings2 aria-hidden="true" size={16} />常规与隐私
          </button>
          <button
            aria-label="外观"
            className={currentScreen === 'S11' ? 'is-active' : ''}
            disabled={navigationDisabled}
            onClick={() => onNavigate('S11')}
            type="button"
          >
            <Palette aria-hidden="true" size={16} />外观
          </button>
          <p className="sidebar-section-label">练习</p>
          <button
            aria-label="练习设置"
            disabled={navigationDisabled}
            onClick={() => onNavigate('S15')}
            type="button"
          >
            <SlidersHorizontal aria-hidden="true" size={16} />练习设置
          </button>
        </nav>
      ) : (
        <>
          <nav className="primary-nav" aria-label="产品导航">
            <p className="sidebar-section-label">练习</p>
            <button
              aria-label="新练习"
              className={PRACTICE_SCREENS.has(currentScreen) ? 'is-active' : ''}
              aria-current={PRACTICE_SCREENS.has(currentScreen) ? 'page' : undefined}
              disabled={navigationDisabled}
              onClick={() => onNavigate('S01')}
              type="button"
            >
              <PenLine aria-hidden="true" size={16} />
              <span>新练习</span>
            </button>
            <button
              aria-label="练习记录"
              aria-current={historyNavigationActive ? 'page' : undefined}
              className={historyNavigationActive ? 'is-active' : ''}
              disabled={navigationDisabled}
              onClick={() => onNavigate('S10')}
              type="button"
            >
              <History aria-hidden="true" size={16} />
              <span>练习记录</span>
            </button>
            <button
              aria-label="收藏题目"
              aria-current={currentScreen === 'S14' ? 'page' : undefined}
              className={currentScreen === 'S14' ? 'is-active' : ''}
              disabled={navigationDisabled}
              onClick={() => onNavigate('S14')}
              type="button"
            >
              <Star aria-hidden="true" size={16} />
              <span>收藏题目</span>
            </button>
            <button
              aria-label="练习设置"
              aria-current={currentScreen === 'S15' ? 'page' : undefined}
              className={currentScreen === 'S15' ? 'is-active' : ''}
              disabled={navigationDisabled}
              onClick={() => onNavigate('S15')}
              type="button"
            >
              <SlidersHorizontal aria-hidden="true" size={16} />
              <span>练习设置</span>
            </button>
          </nav>

          <section className="sidebar-history" aria-label="最近练习">
            <header>
              <p className="sidebar-section-label">最近练习</p>
              <button disabled={navigationDisabled} onClick={() => onNavigate('S10')} type="button">全部</button>
            </header>
            {recentItems.length ? recentItems.map((item) => (
              <div
                className={`recent-practice-row ${selectedHistoryId === item.id && currentScreen === 'S13' ? 'is-active' : ''}`}
                key={item.id}
              >
                <button
                  aria-current={selectedHistoryId === item.id && currentScreen === 'S13' ? 'page' : undefined}
                  aria-describedby={`recent-practice-meta-${item.id}`}
                  aria-label={item.title}
                  className="recent-practice-open"
                  disabled={navigationDisabled}
                  onClick={() => onOpenHistory(item.id)}
                  title={item.title}
                  type="button"
                >
                  {item.pinnedAt
                    ? <Pin aria-hidden="true" className="recent-practice-pin" size={13} />
                    : <MessageSquare aria-hidden="true" size={13} />}
                  <span className="recent-practice-copy">
                    <span className="recent-practice-title">{item.title}</span>
                    <span
                      className="recent-practice-mode"
                      data-mode={item.modeId}
                      id={`recent-practice-meta-${item.id}`}
                    >
                      {item.modeTag}
                      {item.pinnedAt ? <span className="sr-only">，已置顶</span> : null}
                    </span>
                  </span>
                </button>
                <PracticeRecordActionsMenu
                  disabled={navigationDisabled}
                  item={item}
                  onDelete={onDeleteHistory}
                  onRename={onRenameHistory}
                  onSetPinned={onSetHistoryPinned}
                />
              </div>
            )) : <p className="sidebar-history-empty">完成练习后会显示在这里</p>}
          </section>

          <div className="sidebar-bottom">
            <button aria-label="外观" disabled={navigationDisabled} onClick={() => onNavigate('S11')} type="button">
              <Palette aria-hidden="true" size={17} />
              <span>外观</span>
            </button>
            <button aria-label="常规与隐私" disabled={navigationDisabled} onClick={() => onNavigate('S12')} type="button">
              <Settings2 aria-hidden="true" size={17} />
              <span>常规与隐私</span>
            </button>
          </div>
        </>
      )}

      <span className="compact-privacy-icon" aria-hidden="true">
        {onboarding ? <ShieldCheck size={18} /> : <Mic2 size={18} />}
      </span>
    </aside>
  );
}
