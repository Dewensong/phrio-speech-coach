export type ScreenId =
  | 'S00'
  | 'S01'
  | 'S02'
  | 'S03'
  | 'S04'
  | 'S05'
  | 'S06'
  | 'S07'
  | 'S08'
  | 'S09'
  | 'S10'
  | 'S11'
  | 'S12'
  | 'S13'
  | 'S14'
  | 'S15'
  | 'S16';

import type {
  Accent,
  GuidanceSource,
  ModeId as SharedModeId,
  PracticeFocusOption,
} from '../../shared';

export type ModeId = SharedModeId;

export type AttemptKind = 'first' | 'second';

export type ThemePreference = 'system' | 'light' | 'dark';

export type PaletteId = Accent;

export type TextScale = 0.9 | 1 | 1.125 | 1.25;

export type AppearanceSaveStatus = 'loading' | 'idle' | 'saving' | 'saved' | 'error';

export interface PracticeTask {
  id: string;
  developmentFixture: boolean;
  title: string;
  hint: string;
  mode: ModeId;
  modeLabel: string;
  durationSeconds: number;
  audience: string;
  goal: string;
  successConditions: readonly string[];
}

export interface PracticeDraft {
  mode: ModeId;
  task: PracticeTask;
  audience: string;
  goal: string;
  durationSeconds: number;
}

export interface SelectedPracticeFocus extends PracticeFocusOption {
  readonly guidanceSource: GuidanceSource;
  readonly evidenceIds: readonly string[];
}

export interface SavedAttempt {
  attemptId: string;
  durationMs: number;
  mimeType: string;
  audioUrl?: string;
}

export interface AppAppearanceSettings {
  theme: ThemePreference;
  lightPalette: PaletteId;
  darkPalette: PaletteId;
  textScale: TextScale;
  reduceMotion: boolean;
}

export interface AppSettingsView extends AppAppearanceSettings {
  saveStatus: AppearanceSaveStatus;
  saveError: string | null;
}

export interface HistoryItemView {
  id: string;
  title: string;
  modeId: ModeId;
  modeTag: string;
  modeLabel: string;
  pinnedAt: string | null;
  updatedAt: string;
  updatedAtIso?: string;
  statusLabel: string;
  hasAudio: boolean;
  focusLabel: string;
  guidanceLabel: string;
  attemptSummary: string;
}
