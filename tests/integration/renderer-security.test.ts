// @vitest-environment node

import type { BrowserWindow, Protocol, WebContents } from 'electron';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildContentSecurityPolicy,
  canCheckMicrophone,
  canRequestMicrophone,
  createTrustedRendererPolicy,
  installPackagedRendererProtocol,
  PHRIO_RENDERER_ENTRY_URL,
  PHRIO_RENDERER_ORIGIN,
  PHRIO_RENDERER_SCHEME,
  registerRendererSchemePrivileges,
  resolvePackagedRendererAsset,
} from '../../src/backend/config/renderer-security';

describe('renderer security policy', () => {
  it('keeps the packaged CSP local and disallows eval, frames and objects', () => {
    const policy = buildContentSecurityPolicy({ isPackaged: true });

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain('https:');
  });

  it('registers a standard secure renderer scheme without network-like privileges', () => {
    const registerSchemesAsPrivileged = vi.fn();
    registerRendererSchemePrivileges({
      registerSchemesAsPrivileged,
    } as unknown as Pick<Protocol, 'registerSchemesAsPrivileged'>);

    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: PHRIO_RENDERER_SCHEME,
      privileges: expect.objectContaining({
        allowExtensions: false,
        allowServiceWorkers: false,
        bypassCSP: false,
        corsEnabled: false,
        secure: true,
        standard: true,
        stream: false,
        supportFetchAPI: false,
      }),
    }]);
  });

  it('maps only the packaged entry point and flat allowlisted Vite assets', () => {
    const rendererDirectory = '/Applications/Phrio.app/Contents/Resources/app.asar/.vite/renderer/main_window';

    expect(resolvePackagedRendererAsset(PHRIO_RENDERER_ENTRY_URL, rendererDirectory)).toEqual({
      filePath: path.join(rendererDirectory, 'index.html'),
      mediaType: 'text/html; charset=utf-8',
      relativePath: 'index.html',
    });
    expect(resolvePackagedRendererAsset(`${PHRIO_RENDERER_ORIGIN}/assets/index-Ab12_cd.js`, rendererDirectory)).toMatchObject({
      filePath: path.join(rendererDirectory, 'assets/index-Ab12_cd.js'),
      mediaType: 'text/javascript; charset=utf-8',
      relativePath: 'assets/index-Ab12_cd.js',
    });

    for (const blockedUrl of [
      `${PHRIO_RENDERER_ORIGIN}/assets/../index.html`,
      `${PHRIO_RENDERER_ORIGIN}/%2e%2e/secret.js`,
      `${PHRIO_RENDERER_ORIGIN}/assets/nested/index.js`,
      `${PHRIO_RENDERER_ORIGIN}/assets/index.js?qa=1`,
      `${PHRIO_RENDERER_ORIGIN}/assets/index.js.map`,
      'phrio-app://other/index.html',
      'file:///Applications/Phrio.app/Contents/Resources/app.asar/.vite/renderer/main_window/index.html',
    ]) {
      expect(resolvePackagedRendererAsset(blockedUrl, rendererDirectory), blockedUrl).toBeNull();
    }
  });

  it('serves allowlisted assets read-only with nosniff and the packaged CSP', async () => {
    const rendererDirectory = await mkdtemp(path.join(tmpdir(), 'phrio-renderer-protocol-'));
    let handler: ((request: Request) => Response | Promise<Response>) | undefined;
    const handle = vi.fn((scheme: string, next: typeof handler) => {
      expect(scheme).toBe(PHRIO_RENDERER_SCHEME);
      handler = next;
    });
    try {
      await mkdir(path.join(rendererDirectory, 'assets'));
      await writeFile(path.join(rendererDirectory, 'index.html'), '<main>Phrio</main>');
      await writeFile(path.join(rendererDirectory, 'assets/index-Ab12.js'), 'export {};');
      installPackagedRendererProtocol(
        { handle } as unknown as Pick<Protocol, 'handle'>,
        rendererDirectory,
        "default-src 'self'; object-src 'none'",
      );
      expect(handler).toBeTypeOf('function');

      const html = await handler!(new Request(PHRIO_RENDERER_ENTRY_URL));
      expect(html.status).toBe(200);
      expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(html.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(html.headers.get('x-content-type-options')).toBe('nosniff');
      await expect(html.text()).resolves.toBe('<main>Phrio</main>');

      const head = await handler!(new Request(`${PHRIO_RENDERER_ORIGIN}/assets/index-Ab12.js`, { method: 'HEAD' }));
      expect(head.status).toBe(200);
      expect(head.body).toBeNull();
      expect(head.headers.get('content-length')).toBe(String('export {};'.length));

      const write = await handler!(new Request(PHRIO_RENDERER_ENTRY_URL, { method: 'POST' }));
      expect(write.status).toBe(405);
      expect(write.headers.get('allow')).toBe('GET, HEAD');

      const missing = await handler!(new Request(`${PHRIO_RENDERER_ORIGIN}/assets/missing.js`));
      expect(missing.status).toBe(404);
    } finally {
      await rm(rendererDirectory, { recursive: true, force: true });
    }
  });

  it('trusts only the active main webContents at the packaged renderer entry point', () => {
    const rendererDirectory = '/Applications/Phrio.app/Contents/Resources/renderer/main_window';
    const trustedUrl = PHRIO_RENDERER_ENTRY_URL;
    const webContents = {
      id: 17,
      getURL: () => trustedUrl,
    } as unknown as WebContents;
    const window = {
      isDestroyed: () => false,
      webContents,
    } as unknown as BrowserWindow;
    const policy = createTrustedRendererPolicy(() => window, undefined, rendererDirectory);

    expect(policy.isTrustedUrl(trustedUrl)).toBe(true);
    expect(
      policy.isTrustedUrl(
        `${PHRIO_RENDERER_ORIGIN}/assets/index-Ab12.js`,
      ),
    ).toBe(false);
    expect(policy.isTrustedUrl('https://example.com/')).toBe(false);
    expect(policy.isTrustedUrl(`${PHRIO_RENDERER_ENTRY_URL}?qa=1`)).toBe(false);
    expect(policy.isTrustedWebContents(webContents)).toBe(true);
    expect(
      policy.isTrustedWebContents({ id: 18, getURL: () => trustedUrl } as unknown as WebContents),
    ).toBe(false);
  });

  it('limits development trust and connections to the configured local origin', () => {
    const developmentServerUrl = 'http://127.0.0.1:5173/';
    const policy = createTrustedRendererPolicy(
      () => null,
      developmentServerUrl,
      '/unused',
    );
    const csp = buildContentSecurityPolicy({
      isPackaged: false,
      developmentServerUrl,
    });

    expect(policy.isTrustedUrl('http://127.0.0.1:5173/src/main.tsx')).toBe(true);
    expect(policy.isTrustedUrl('http://localhost:5173/src/main.tsx')).toBe(false);
    expect(csp).toContain('http://127.0.0.1:5173');
    expect(csp).toContain('ws://127.0.0.1:5173');
    expect(csp).toContain("script-src 'self' 'unsafe-eval' 'unsafe-inline'");
  });

  it('grants only main-frame audio capture from the trusted renderer URL', () => {
    const rendererDirectory = '/Applications/Phrio.app/Contents/Resources/renderer/main_window';
    const trustedUrl = PHRIO_RENDERER_ENTRY_URL;
    const webContents = {
      id: 17,
      getURL: () => trustedUrl,
    } as unknown as WebContents;
    const window = {
      isDestroyed: () => false,
      webContents,
    } as unknown as BrowserWindow;
    const policy = createTrustedRendererPolicy(() => window, undefined, rendererDirectory);

    expect(
      canRequestMicrophone(policy, webContents, 'media', {
        isMainFrame: true,
        requestingUrl: trustedUrl,
        mediaTypes: ['audio'],
      }),
    ).toBe(true);
    expect(
      canRequestMicrophone(policy, webContents, 'media', {
        isMainFrame: true,
        requestingUrl: trustedUrl,
        mediaTypes: ['video'],
      }),
    ).toBe(false);
    expect(
      canRequestMicrophone(policy, webContents, 'media', {
        isMainFrame: false,
        requestingUrl: trustedUrl,
        mediaTypes: ['audio'],
      }),
    ).toBe(false);
    expect(
      canCheckMicrophone(policy, webContents, 'media', PHRIO_RENDERER_ORIGIN, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: trustedUrl,
      }),
    ).toBe(true);
    expect(
      canCheckMicrophone(policy, webContents, 'media', PHRIO_RENDERER_ORIGIN, {
        isMainFrame: true,
        mediaType: 'video',
        requestingUrl: trustedUrl,
      }),
    ).toBe(false);
    expect(
      canCheckMicrophone(policy, webContents, 'media', 'https://example.com', {
        isMainFrame: true,
        mediaType: 'audio',
      }),
    ).toBe(false);
  });
});
