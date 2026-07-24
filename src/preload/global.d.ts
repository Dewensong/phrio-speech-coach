import type { PhrioDesktopApi } from '../shared';

declare global {
  interface Window {
    readonly phrio: PhrioDesktopApi;
  }
}

export {};
