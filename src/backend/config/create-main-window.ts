import { BrowserWindow } from 'electron';
import path from 'node:path';
import {
  hardenWindowNavigation,
  PHRIO_RENDERER_ENTRY_URL,
} from './renderer-security';

export interface CreateMainWindowOptions {
  readonly developmentServerUrl?: string;
  readonly rendererName: string;
}

export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1_440,
    height: 960,
    minWidth: 1_024,
    minHeight: 720,
    backgroundColor: '#F4F1EA',
    show: false,
    title: 'Phrio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      webviewTag: false,
    },
  });

  hardenWindowNavigation(window);
  window.once('ready-to-show', () => {
    window.show();
  });

  return window;
}

export async function loadMainWindow(
  window: BrowserWindow,
  options: CreateMainWindowOptions,
): Promise<void> {
  if (options.developmentServerUrl) {
    await window.loadURL(options.developmentServerUrl);
    return;
  }
  await window.loadURL(PHRIO_RENDERER_ENTRY_URL);
}
