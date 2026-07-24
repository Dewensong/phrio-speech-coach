import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppAppearanceSettings } from '../../src/frontend/types/ui';

const desktopApi = vi.hoisted(() => ({
  getAppSettings: vi.fn(),
  updateAppSettings: vi.fn(),
}));

vi.mock('../../src/frontend/services/desktop-api', () => desktopApi);

import { useTheme } from '../../src/frontend/hooks/use-theme';
import { AppearancePage } from '../../src/frontend/pages/appearance-page';

const BASE_SETTINGS: AppAppearanceSettings = {
  theme: 'system',
  lightPalette: 'flow-teal',
  darkPalette: 'flow-teal',
  textScale: 1,
  reduceMotion: false,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.localStorage.clear();
  const root = document.documentElement;
  Reflect.deleteProperty(root.dataset, 'theme');
  Reflect.deleteProperty(root.dataset, 'lightPalette');
  Reflect.deleteProperty(root.dataset, 'darkPalette');
  Reflect.deleteProperty(root.dataset, 'textScale');
  Reflect.deleteProperty(root.dataset, 'reduceMotion');
});

describe('useTheme appearance persistence', () => {
  it('applies the persisted theme, palette, motion, and text scale as one appearance system', async () => {
    desktopApi.getAppSettings.mockResolvedValue({
      theme: 'dark',
      lightPalette: 'ruby',
      darkPalette: 'fog-blue',
      textScale: 1.125,
      reduceMotion: true,
    } satisfies AppAppearanceSettings);

    const { result } = renderHook(() => useTheme());

    await waitFor(() => expect(result.current.settings.saveStatus).toBe('idle'));
    expect(document.documentElement.dataset).toMatchObject({
      theme: 'dark',
      lightPalette: 'ruby',
      darkPalette: 'fog-blue',
      textScale: '1.125',
      reduceMotion: 'true',
    });
    expect(JSON.parse(window.localStorage.getItem('phrio.appearance.v1') ?? '{}'))
      .toEqual({
        theme: 'dark',
        lightPalette: 'ruby',
        darkPalette: 'fog-blue',
        textScale: 1.125,
        reduceMotion: true,
      });
  });

  it('serializes revisions and rolls back only the latest failed save', async () => {
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    desktopApi.getAppSettings.mockResolvedValue(BASE_SETTINGS);
    desktopApi.updateAppSettings
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const { result } = renderHook(() => useTheme());
    await waitFor(() => expect(result.current.settings.saveStatus).toBe('idle'));

    const firstRevision: AppAppearanceSettings = {
      ...BASE_SETTINGS,
      lightPalette: 'ruby',
      textScale: 1.125,
    };
    const secondRevision: AppAppearanceSettings = {
      ...firstRevision,
      lightPalette: 'cocoa',
      textScale: 1.25,
    };
    act(() => {
      result.current.saveSettings(firstRevision);
      result.current.saveSettings(secondRevision);
    });

    expect(result.current.settings).toMatchObject({
      lightPalette: 'cocoa',
      textScale: 1.25,
      saveStatus: 'saving',
    });
    expect(document.documentElement.dataset.lightPalette).toBe('cocoa');
    await waitFor(() => expect(desktopApi.updateAppSettings).toHaveBeenCalledTimes(1));
    expect(desktopApi.updateAppSettings).toHaveBeenNthCalledWith(1, firstRevision);

    await act(async () => {
      firstSave.resolve();
      await firstSave.promise;
    });
    await waitFor(() => expect(desktopApi.updateAppSettings).toHaveBeenCalledTimes(2));
    expect(desktopApi.updateAppSettings).toHaveBeenNthCalledWith(2, secondRevision);
    expect(result.current.settings.saveStatus).toBe('saving');

    await act(async () => {
      secondSave.reject(new Error('disk unavailable'));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.settings.saveStatus).toBe('error'));
    expect(result.current.settings).toMatchObject({
      lightPalette: 'ruby',
      textScale: 1.125,
      saveError: '外观没有保存成功，已恢复本机中上一次保存的设置。',
    });
    expect(document.documentElement.dataset.lightPalette).toBe('ruby');
    expect(document.documentElement.dataset.textScale).toBe('1.125');
    expect(JSON.parse(window.localStorage.getItem('phrio.appearance.v1') ?? '{}'))
      .toEqual(firstRevision);
  });

  it('does not let a stale initial read replace a revision that already saved', async () => {
    const initialRead = deferred<AppAppearanceSettings>();
    const failedSave = deferred<void>();
    desktopApi.getAppSettings.mockReturnValue(initialRead.promise);
    desktopApi.updateAppSettings
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(failedSave.promise);
    const { result } = renderHook(() => useTheme());
    const savedRevision: AppAppearanceSettings = {
      ...BASE_SETTINGS,
      theme: 'dark',
      darkPalette: 'ruby',
      textScale: 1.25,
    };

    act(() => result.current.saveSettings(savedRevision));
    await waitFor(() => expect(result.current.settings.saveStatus).toBe('saved'));

    await act(async () => {
      initialRead.resolve(BASE_SETTINGS);
      await initialRead.promise;
    });
    expect(result.current.settings).toMatchObject(savedRevision);

    act(() => result.current.saveSettings({ ...savedRevision, darkPalette: 'amber' }));
    await waitFor(() => expect(desktopApi.updateAppSettings).toHaveBeenCalledTimes(2));
    await act(async () => {
      failedSave.reject(new Error('disk unavailable'));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.settings.saveStatus).toBe('error'));
    expect(result.current.settings).toMatchObject(savedRevision);
    expect(document.documentElement.dataset.darkPalette).toBe('ruby');
  });
});

describe('AppearancePage controls', () => {
  it('shows durable save feedback and offers every supported text scale', () => {
    const onChange = vi.fn();
    render(
      <AppearancePage
        onChange={onChange}
        settings={{
          ...BASE_SETTINGS,
          saveStatus: 'saved',
          saveError: null,
        }}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('已保存到本机');
    expect(screen.getByRole('button', { name: '标准 100%' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '紧凑 90%' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '舒展 112.5%' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '大字 125%' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ textScale: 1.25 }));
  });
});
