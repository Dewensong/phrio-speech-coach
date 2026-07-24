import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { getAppSettings, updateAppSettings } from '../services/desktop-api';
import type {
  AppAppearanceSettings,
  AppSettingsView,
  PaletteId,
  TextScale,
  ThemePreference,
} from '../types/ui';

const DEFAULT_SETTINGS: AppAppearanceSettings = {
  theme: 'system',
  lightPalette: 'flow-teal',
  darkPalette: 'flow-teal',
  textScale: 1,
  reduceMotion: false,
};

const APPEARANCE_CACHE_KEY = 'phrio.appearance.v1';
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];
const PALETTES: readonly PaletteId[] = [
  'flow-teal',
  'fog-blue',
  'smoky-jade',
  'olive',
  'amber',
  'ruby',
  'cocoa',
  'terracotta',
];
const TEXT_SCALES: readonly TextScale[] = [0.9, 1, 1.125, 1.25];

function settingsView(
  values: AppAppearanceSettings,
  saveStatus: AppSettingsView['saveStatus'],
  saveError: string | null = null,
): AppSettingsView {
  return { ...values, saveStatus, saveError };
}

function appearanceValues(settings: AppAppearanceSettings): AppAppearanceSettings {
  return {
    theme: settings.theme,
    lightPalette: settings.lightPalette,
    darkPalette: settings.darkPalette,
    textScale: settings.textScale,
    reduceMotion: settings.reduceMotion,
  };
}

function isAppearanceSettings(value: unknown): value is AppAppearanceSettings {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AppAppearanceSettings>;
  return THEMES.includes(candidate.theme as ThemePreference) &&
    PALETTES.includes(candidate.lightPalette as PaletteId) &&
    PALETTES.includes(candidate.darkPalette as PaletteId) &&
    TEXT_SCALES.includes(candidate.textScale as TextScale) &&
    typeof candidate.reduceMotion === 'boolean';
}

function readAppearanceCache(): AppAppearanceSettings | null {
  try {
    const cached = window.localStorage.getItem(APPEARANCE_CACHE_KEY);
    if (!cached) return null;
    const parsed: unknown = JSON.parse(cached);
    return isAppearanceSettings(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeAppearanceCache(settings: AppAppearanceSettings): void {
  try {
    window.localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(settings));
  } catch {
    // SQLite remains authoritative; this cache only avoids a first-frame theme flash.
  }
}

function applyAppearance(settings: AppAppearanceSettings): void {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.lightPalette = settings.lightPalette;
  root.dataset.darkPalette = settings.darkPalette;
  root.dataset.textScale = String(settings.textScale);
  root.dataset.reduceMotion = String(settings.reduceMotion);
}

export function useTheme() {
  const [initialSettings] = useState<AppAppearanceSettings>(
    () => readAppearanceCache() ?? DEFAULT_SETTINGS,
  );
  const [settings, setSettings] = useState<AppSettingsView>(
    () => settingsView(initialSettings, 'loading'),
  );
  const optimisticRef = useRef(initialSettings);
  const persistedRef = useRef(initialSettings);
  const saveRevisionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const savedTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    applyAppearance(settings);
  }, [
    settings.darkPalette,
    settings.lightPalette,
    settings.reduceMotion,
    settings.textScale,
    settings.theme,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    void getAppSettings()
      .then((persisted) => {
        if (!active) return;
        if (saveRevisionRef.current !== 0) return;
        persistedRef.current = persisted;
        writeAppearanceCache(persisted);
        optimisticRef.current = persisted;
        setSettings(settingsView(persisted, 'idle'));
      })
      .catch(() => {
        if (!active || saveRevisionRef.current !== 0) return;
        setSettings(settingsView(
          optimisticRef.current,
          'error',
          '暂时无法读取本机外观设置，当前使用上次可用外观。',
        ));
      });

    return () => {
      active = false;
      mountedRef.current = false;
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  const saveSettings = useCallback((next: AppAppearanceSettings) => {
    const appearance = appearanceValues(next);
    const revision = ++saveRevisionRef.current;
    optimisticRef.current = appearance;
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    setSettings(settingsView(appearance, 'saving'));

    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await updateAppSettings(appearance);
          persistedRef.current = appearance;
          writeAppearanceCache(appearance);
          if (!mountedRef.current || revision !== saveRevisionRef.current) return;
          setSettings(settingsView(appearance, 'saved'));
          savedTimerRef.current = window.setTimeout(() => {
            if (!mountedRef.current || revision !== saveRevisionRef.current) return;
            setSettings(settingsView(appearance, 'idle'));
            savedTimerRef.current = null;
          }, 1_600);
        } catch {
          if (!mountedRef.current || revision !== saveRevisionRef.current) return;
          const persisted = persistedRef.current;
          optimisticRef.current = persisted;
          setSettings(settingsView(
            persisted,
            'error',
            '外观没有保存成功，已恢复本机中上一次保存的设置。',
          ));
        }
      });
  }, []);

  const waitForPendingSaves = useCallback(async (): Promise<void> => {
    await saveQueueRef.current.catch(() => undefined);
  }, []);

  const replaceSettings = useCallback((next: AppAppearanceSettings) => {
    const appearance = appearanceValues(next);
    ++saveRevisionRef.current;
    optimisticRef.current = appearance;
    persistedRef.current = appearance;
    writeAppearanceCache(appearance);
    setSettings(settingsView(appearance, 'idle'));
  }, []);

  return { settings, saveSettings, waitForPendingSaves, replaceSettings };
}
