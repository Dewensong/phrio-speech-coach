import type { BrowserWindow, Protocol, Session, WebContents } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const PHRIO_RENDERER_SCHEME = 'phrio-app';
export const PHRIO_RENDERER_HOST = 'renderer';
export const PHRIO_RENDERER_ORIGIN = `${PHRIO_RENDERER_SCHEME}://${PHRIO_RENDERER_HOST}`;
export const PHRIO_RENDERER_ENTRY_URL = `${PHRIO_RENDERER_ORIGIN}/index.html`;

const PACKAGED_RENDERER_MEDIA_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

export interface PackagedRendererAsset {
  readonly filePath: string;
  readonly mediaType: string;
  readonly relativePath: string;
}

type ProtocolSchemeRegistrar = Pick<Protocol, 'registerSchemesAsPrivileged'>;
type ProtocolRequestHandler = (request: Request) => Response | Promise<Response>;
type ProtocolHandlerRegistrar = Pick<Protocol, 'handle'>;

export function registerRendererSchemePrivileges(protocol: ProtocolSchemeRegistrar): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PHRIO_RENDERER_SCHEME,
      privileges: {
        allowExtensions: false,
        allowServiceWorkers: false,
        bypassCSP: false,
        codeCache: true,
        corsEnabled: false,
        secure: true,
        standard: true,
        stream: false,
        supportFetchAPI: false,
      },
    },
  ]);
}

function rawPathname(rawUrl: string): string | null {
  const schemeSeparator = rawUrl.indexOf('://');
  if (schemeSeparator < 0) return null;
  const pathStart = rawUrl.indexOf('/', schemeSeparator + 3);
  if (pathStart < 0) return '/';
  const queryStart = rawUrl.indexOf('?', pathStart);
  const fragmentStart = rawUrl.indexOf('#', pathStart);
  const pathEnd = [queryStart, fragmentStart]
    .filter((candidate) => candidate >= 0)
    .reduce((lowest, candidate) => Math.min(lowest, candidate), rawUrl.length);
  return rawUrl.slice(pathStart, pathEnd);
}

export function resolvePackagedRendererAsset(
  rawUrl: string,
  packagedRendererDirectory: string,
): PackagedRendererAsset | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${PHRIO_RENDERER_SCHEME}:` ||
    parsed.hostname !== PHRIO_RENDERER_HOST ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null;
  }

  const encodedPath = rawPathname(rawUrl);
  if (encodedPath === null) return null;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (decodedPath.includes('\0') || decodedPath.includes('\\')) return null;
  const pathSegments = decodedPath.split('/');
  if (pathSegments.some((segment) => segment === '.' || segment === '..')) return null;

  let relativePath: string;
  if (decodedPath === '/' || decodedPath === '/index.html') {
    relativePath = 'index.html';
  } else {
    const assetMatch = /^\/assets\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/u.exec(decodedPath);
    if (!assetMatch) return null;
    relativePath = path.posix.join('assets', assetMatch[1]!);
  }

  const extension = path.extname(relativePath).toLowerCase();
  const mediaType = PACKAGED_RENDERER_MEDIA_TYPES[
    extension as keyof typeof PACKAGED_RENDERER_MEDIA_TYPES
  ];
  if (!mediaType || (relativePath === 'index.html' && extension !== '.html')) return null;

  const rendererDirectory = path.resolve(packagedRendererDirectory);
  const filePath = path.resolve(rendererDirectory, relativePath);
  const relative = path.relative(rendererDirectory, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return { filePath, mediaType, relativePath };
}

function protocolError(status: number, headers?: Readonly<Record<string, string>>): Response {
  return new Response(null, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export function installPackagedRendererProtocol(
  protocol: ProtocolHandlerRegistrar,
  packagedRendererDirectory: string,
  contentSecurityPolicy: string,
): void {
  const handleRequest: ProtocolRequestHandler = async (request) => {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return protocolError(405, { Allow: 'GET, HEAD' });
    }
    const asset = resolvePackagedRendererAsset(request.url, packagedRendererDirectory);
    if (!asset) return protocolError(404);

    try {
      const contents = await readFile(asset.filePath);
      return new Response(method === 'HEAD' ? null : new Uint8Array(contents), {
        status: 200,
        headers: {
          'Cache-Control': asset.relativePath === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
          'Content-Length': String(contents.byteLength),
          'Content-Security-Policy': contentSecurityPolicy,
          'Content-Type': asset.mediaType,
          'Cross-Origin-Resource-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return protocolError(404);
    }
  };

  protocol.handle(PHRIO_RENDERER_SCHEME, handleRequest);
}

export interface RendererSecurityOptions {
  readonly electronSession: Session;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly developmentServerUrl?: string;
  readonly packagedRendererDirectory: string;
  readonly isPackaged: boolean;
}

export interface TrustedRendererPolicy {
  isTrustedWebContents(webContents: WebContents): boolean;
  isTrustedUrl(url: string): boolean;
}

interface MediaPermissionRequestDetails {
  readonly isMainFrame: boolean;
  readonly requestingUrl: string;
  readonly mediaTypes?: ReadonlyArray<'audio' | 'video'>;
}

interface MediaPermissionCheckDetails {
  readonly isMainFrame: boolean;
  readonly mediaType?: 'audio' | 'video' | 'unknown';
  readonly requestingUrl?: string;
}

export function createTrustedRendererPolicy(
  getMainWindow: () => BrowserWindow | null,
  developmentServerUrl: string | undefined,
  packagedRendererDirectory: string,
): TrustedRendererPolicy {
  const developmentOrigin = developmentServerUrl
    ? new URL(developmentServerUrl).origin
    : undefined;
  const isTrustedUrl = (rawUrl: string): boolean => {
    try {
      const parsed = new URL(rawUrl);
      if (developmentOrigin) {
        return parsed.origin === developmentOrigin;
      }
      return resolvePackagedRendererAsset(rawUrl, packagedRendererDirectory)?.relativePath === 'index.html';
    } catch {
      return false;
    }
  };

  return {
    isTrustedUrl,
    isTrustedWebContents(webContents) {
      const mainWindow = getMainWindow();
      return (
        mainWindow !== null &&
        !mainWindow.isDestroyed() &&
        webContents.id === mainWindow.webContents.id &&
        isTrustedUrl(webContents.getURL())
      );
    },
  };
}

export function installRendererSecurity(options: RendererSecurityOptions): TrustedRendererPolicy {
  const policy = createTrustedRendererPolicy(
    options.getMainWindow,
    options.developmentServerUrl,
    options.packagedRendererDirectory,
  );
  const contentSecurityPolicy = buildContentSecurityPolicy({
    developmentServerUrl: options.developmentServerUrl,
    isPackaged: options.isPackaged,
  });

  if (options.isPackaged) {
    installPackagedRendererProtocol(
      options.electronSession.protocol,
      options.packagedRendererDirectory,
      contentSecurityPolicy,
    );
  }

  options.electronSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy],
      },
    });
  });

  options.electronSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        'mediaTypes' in details &&
          canRequestMicrophone(policy, webContents, permission, details),
      );
    },
  );

  options.electronSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      canCheckMicrophone(
        policy,
        webContents,
        permission,
        requestingOrigin,
        details,
      ),
  );

  return policy;
}

export function canRequestMicrophone(
  policy: TrustedRendererPolicy,
  webContents: WebContents,
  permission: string,
  details: MediaPermissionRequestDetails,
): boolean {
  return (
    permission === 'media' &&
    details.isMainFrame &&
    details.mediaTypes?.length === 1 &&
    details.mediaTypes[0] === 'audio' &&
    policy.isTrustedWebContents(webContents) &&
    policy.isTrustedUrl(details.requestingUrl)
  );
}

export function canCheckMicrophone(
  policy: TrustedRendererPolicy,
  webContents: WebContents | null,
  permission: string,
  requestingOrigin: string,
  details: MediaPermissionCheckDetails,
): boolean {
  const requestingUrl = details.requestingUrl ?? requestingOrigin;
  return (
    webContents !== null &&
    permission === 'media' &&
    details.isMainFrame &&
    details.mediaType === 'audio' &&
    policy.isTrustedWebContents(webContents) &&
    policy.isTrustedUrl(requestingUrl)
  );
}

export function hardenWindowNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

export function buildContentSecurityPolicy(options: {
  readonly isPackaged: boolean;
  readonly developmentServerUrl?: string;
}): string {
  const developmentOrigin = options.developmentServerUrl
    ? new URL(options.developmentServerUrl).origin
    : undefined;
  const developmentSocketOrigin = developmentOrigin
    ? developmentOrigin.replace(/^http/u, 'ws')
    : undefined;
  const scriptSources = options.isPackaged
    ? "'self'"
    : "'self' 'unsafe-eval' 'unsafe-inline'";
  const connectSources = ["'self'", developmentOrigin, developmentSocketOrigin]
    .filter((source): source is string => Boolean(source))
    .join(' ');

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src ${connectSources}`,
  ].join('; ');
}
