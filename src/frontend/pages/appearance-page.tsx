import { Check, Moon, Sun, SunMoon } from 'lucide-react';

import type {
  AppAppearanceSettings,
  AppSettingsView,
  PaletteId,
  TextScale,
  ThemePreference,
} from '../types/ui';

interface AppearancePageProps {
  settings: AppSettingsView;
  onChange: (settings: AppAppearanceSettings) => void;
}

const THEMES: readonly { id: ThemePreference; label: string; icon: typeof Sun }[] = [
  { id: 'system', label: '系统', icon: SunMoon },
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
];

const PALETTES: readonly { id: PaletteId; label: string }[] = [
  { id: 'flow-teal', label: '流青' },
  { id: 'fog-blue', label: '雾蓝' },
  { id: 'smoky-jade', label: '烟玉' },
  { id: 'olive', label: '草木' },
  { id: 'amber', label: '琥珀' },
  { id: 'ruby', label: '宝石' },
  { id: 'cocoa', label: '可可' },
  { id: 'terracotta', label: '陶橙' },
];

const TEXT_SCALES: readonly { value: TextScale; label: string; detail: string }[] = [
  { value: 0.9, label: '紧凑', detail: '90%' },
  { value: 1, label: '标准', detail: '100%' },
  { value: 1.125, label: '舒展', detail: '112.5%' },
  { value: 1.25, label: '大字', detail: '125%' },
];

function saveStatusCopy(settings: AppSettingsView): string {
  if (settings.saveStatus === 'loading') return '正在读取本机外观…';
  if (settings.saveStatus === 'saving') return '正在保存到本机…';
  if (settings.saveStatus === 'saved') return '已保存到本机';
  if (settings.saveStatus === 'error') return settings.saveError ?? '外观设置暂时不可用。';
  return '更改会自动保存';
}

function appearanceChange(
  settings: AppSettingsView,
  patch: Partial<AppAppearanceSettings>,
): AppAppearanceSettings {
  return {
    theme: settings.theme,
    lightPalette: settings.lightPalette,
    darkPalette: settings.darkPalette,
    textScale: settings.textScale,
    reduceMotion: settings.reduceMotion,
    ...patch,
  };
}

export function AppearancePage({ settings, onChange }: AppearancePageProps) {
  return (
    <div className="settings-layout">
      <section className="settings-main">
        <div className="page-heading appearance-heading">
          <div>
            <span className="settings-folio" aria-hidden="true">COMPOSITOR · 02</span>
            <h1>外观</h1>
          </div>
          <span
            aria-live="polite"
            className="appearance-save-status"
            data-status={settings.saveStatus}
            role={settings.saveStatus === 'error' ? 'alert' : 'status'}
          >
            {saveStatusCopy(settings)}
          </span>
        </div>
        <section className="settings-section">
          <h2>主题</h2>
          <div className="theme-options">
            {THEMES.map(({ id, label, icon: Icon }) => (
              <button
                aria-pressed={settings.theme === id}
                className={settings.theme === id ? 'is-selected' : ''}
                key={id}
                onClick={() => onChange(appearanceChange(settings, { theme: id }))}
                type="button"
              >
                <div className={`theme-preview theme-preview-${id}`}>
                  <Icon aria-hidden="true" size={18} />
                  <span /><span /><span />
                </div>
                <strong>{settings.theme === id ? <Check size={15} /> : null}{label}</strong>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <header>
            <h2>主题配色</h2>
            <p>浅色与深色分别保存；背景、前景和可读性由系统自动派生。</p>
          </header>
          <div className="palette-panels">
            <PalettePanel
              dark={false}
              onSelect={(lightPalette) =>
                onChange(appearanceChange(settings, { lightPalette }))
              }
              selected={settings.lightPalette}
            />
            <PalettePanel
              dark
              onSelect={(darkPalette) =>
                onChange(appearanceChange(settings, { darkPalette }))
              }
              selected={settings.darkPalette}
            />
          </div>
        </section>

        <section className="settings-section reading-settings">
          <header><h2>阅读与动效</h2><p>缩放会作用于整套界面与中文工作正文。</p></header>
          <div className="text-scale-setting">
            <span>界面与文字大小</span>
            <div className="text-scale-options" aria-label="界面与文字大小">
              {TEXT_SCALES.map((option) => (
                <button
                  aria-label={`${option.label} ${option.detail}`}
                  aria-pressed={settings.textScale === option.value}
                  className={settings.textScale === option.value ? 'is-selected' : ''}
                  key={option.value}
                  onClick={() =>
                    onChange(appearanceChange(settings, { textScale: option.value }))
                  }
                  type="button"
                >
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </button>
              ))}
            </div>
          </div>
          <label>
            <span>减少动效</span>
            <input
              checked={settings.reduceMotion}
              onChange={(event) =>
                onChange(appearanceChange(settings, { reduceMotion: event.target.checked }))
              }
              type="checkbox"
            />
          </label>
        </section>
      </section>
    </div>
  );
}

interface PalettePanelProps {
  dark: boolean;
  selected: PaletteId;
  onSelect: (palette: PaletteId) => void;
}

function PalettePanel({ dark, selected, onSelect }: PalettePanelProps) {
  return (
    <div className={`palette-panel ${dark ? 'is-dark' : ''}`}>
      <header><strong>{dark ? '深色主题' : '浅色主题'}</strong><span>当前：{PALETTES.find((item) => item.id === selected)?.label}</span></header>
      <p>强调色与选中态（受约束）</p>
      <div className="palette-grid">
        {PALETTES.map((palette) => (
          <button
            aria-pressed={selected === palette.id}
            className={`palette-${palette.id} ${selected === palette.id ? 'is-selected' : ''}`}
            key={palette.id}
            onClick={() => onSelect(palette.id)}
            type="button"
          >
            <span /><strong>{selected === palette.id ? '✓ ' : ''}{palette.label}</strong>
          </button>
        ))}
      </div>
      <dl>
        <div><dt>背景</dt><dd>自动</dd></div>
        <div><dt>前景</dt><dd>自动</dd></div>
        <div><dt>文字对比</dt><dd>{dark ? '增强' : '标准'}</dd></div>
      </dl>
    </div>
  );
}
