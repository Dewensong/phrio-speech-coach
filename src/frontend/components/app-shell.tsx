import type { ReactNode } from 'react';
import { Folder, Laptop2, Mic2, ShieldCheck, Sparkles } from 'lucide-react';

import type { HistoryItemView, ModeId, ScreenId } from '../types/ui';
import { Sidebar } from './sidebar';
import { StageRail } from './stage-rail';

interface AppShellProps {
  screen: ScreenId;
  title: string;
  taskContext?: string;
  stageIndex?: number;
  commandStatus?: string;
  children: ReactNode;
  activeMode: ModeId;
  recentHistory: readonly HistoryItemView[];
  selectedHistoryId: string | null;
  navigationDisabled?: boolean;
  onboardingContext?: boolean;
  onNavigate: (screen: ScreenId) => void;
  onOpenHistory: (sessionId: string) => void;
  onDeleteHistory: (item: HistoryItemView) => void;
  onRenameHistory: (item: HistoryItemView) => void;
  onSetHistoryPinned: (item: HistoryItemView, pinned: boolean) => void;
}

function commandIcon(screen: ScreenId) {
  if (screen === 'S00') return <ShieldCheck aria-hidden="true" size={17} />;
  if (screen === 'S16') return <Sparkles aria-hidden="true" size={17} />;
  if (screen === 'S01' || screen === 'S02') {
    return <Mic2 aria-hidden="true" size={17} />;
  }
  if (screen === 'S11' || screen === 'S12') return <Laptop2 aria-hidden="true" size={17} />;
  return <Folder aria-hidden="true" size={17} />;
}

export function AppShell({
  screen,
  title,
  taskContext,
  stageIndex,
  commandStatus,
  children,
  activeMode,
  recentHistory,
  selectedHistoryId,
  navigationDisabled = false,
  onboardingContext = false,
  onNavigate,
  onOpenHistory,
  onDeleteHistory,
  onRenameHistory,
  onSetHistoryPinned,
}: AppShellProps) {
  const onboarding = screen === 'S00' || onboardingContext;
  const activeModeLabel =
    activeMode === 'clear-expression'
      ? '清晰表达 · 通用'
      : activeMode === 'decision-alignment'
        ? '决策与对齐 · 产品经理'
        : '论证与反驳 · 辩手';

  return (
    <div aria-busy={navigationDisabled || undefined} className="app-shell" data-screen={screen}>
      <Sidebar
        currentScreen={screen}
        navigationDisabled={navigationDisabled}
        onboarding={onboarding}
        recentHistory={recentHistory}
        selectedHistoryId={selectedHistoryId}
        onNavigate={onNavigate}
        onOpenHistory={onOpenHistory}
        onDeleteHistory={onDeleteHistory}
        onRenameHistory={onRenameHistory}
        onSetHistoryPinned={onSetHistoryPinned}
      />
      <div className="app-workspace">
        <header className="command-bar">
          <div className="command-title">
            {commandIcon(screen)}
            <strong>{title}</strong>
            {taskContext ? <span>· {taskContext}</span> : null}
          </div>
          {screen === 'S04' || screen === 'S08' ? (
            <div className="command-approved-actions" aria-label="练习状态">
              <span className="command-mode-pill">{activeModeLabel}</span>
              <span className="command-save-pill">快照自动保留</span>
            </div>
          ) : <div className="command-status">{commandStatus}</div>}
        </header>
        {typeof stageIndex === 'number' ? (
          <StageRail activeIndex={stageIndex} />
        ) : null}
        <main className="screen-canvas">{children}</main>
      </div>
    </div>
  );
}
