import { EventEmitter } from 'node:events';
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  RequestOptions,
} from 'node:http';
import { Readable } from 'node:stream';
import type {
  ClientRequest as ElectronClientRequest,
  ClientRequestConstructorOptions as ElectronClientRequestConstructorOptions,
} from 'electron';

export const ELECTRON_SYSTEM_NETWORK_TRANSPORT = 'electron_system_network' as const;

type HttpsGet = typeof import('node:https').get;
type ResponseListener = (response: IncomingMessage) => void;

export type ElectronSystemRequest = (
  options: ElectronClientRequestConstructorOptions,
) => ElectronClientRequest;

export interface ElectronSystemNetworkRequestOptions {
  /**
   * Bind this to Electron net.request with the default Session in production.
   * Chromium's request stack honors the OS proxy/PAC configuration, while the
   * injected seam keeps unit tests independent from an Electron runtime.
   */
  readonly request: ElectronSystemRequest;
  /** Called at most once and deliberately receives no URL or headers. */
  readonly onFirstRequest?: (metadata: {
    readonly transport: typeof ELECTRON_SYSTEM_NETWORK_TRANSPORT;
  }) => void;
}

export class ElectronSystemNetworkRequestError extends Error {
  readonly code = 'ELECTRON_SYSTEM_NETWORK_REQUEST_FAILED';

  constructor() {
    // Chromium errors may embed a signed redirect URL. Keep the public error
    // URL-free; the downloader maps this stable code into its own error type.
    super('ELECTRON_SYSTEM_NETWORK_REQUEST_FAILED');
    this.name = 'ElectronSystemNetworkRequestError';
  }
}

/**
 * Adapts Electron net.request (Chromium's system-aware network stack) to the
 * small callback-style https.get surface used by the model downloaders.
 *
 * Electron Session.fetch cannot be used here: with `redirect: "manual"` it
 * rejects with "Redirect was cancelled" instead of exposing the 3xx response.
 * net.request exposes the redirect status and headers through its `redirect`
 * event, which this adapter converts into an empty IncomingMessage so the
 * existing downloader can validate every signed target itself.
 */
export function createElectronSystemNetworkRequestGet(
  options: ElectronSystemNetworkRequestOptions,
): HttpsGet {
  let firstRequestReported = false;

  const requestGet = (
    input: string | URL,
    requestOptions: RequestOptions | ResponseListener,
    responseListener?: ResponseListener,
  ): ClientRequest => {
    const normalizedOptions = typeof requestOptions === 'function' ? {} : requestOptions;
    const listener = typeof requestOptions === 'function'
      ? requestOptions
      : responseListener;
    if (!listener) throw new TypeError('response listener is required');

    if (!firstRequestReported) {
      firstRequestReported = true;
      try {
        options.onFirstRequest?.({ transport: ELECTRON_SYSTEM_NETWORK_TRANSPORT });
      } catch {
        // Diagnostics must not affect the transfer.
      }
    }

    const request = new ElectronNetClientRequest({
      request: options.request,
      url: typeof input === 'string' ? input : input.href,
      headers: normalizeRequestHeaders(normalizedOptions.headers),
      externalSignal: normalizedOptions.signal,
      responseListener: listener,
    });
    request.start();
    return request as unknown as ClientRequest;
  };

  return requestGet as unknown as HttpsGet;
}

interface ElectronNetClientRequestInput {
  readonly request: ElectronSystemRequest;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly externalSignal: AbortSignal | undefined;
  readonly responseListener: ResponseListener;
}

class ElectronNetClientRequest extends EventEmitter {
  readonly #input: ElectronNetClientRequestInput;
  #request: ElectronClientRequest | null = null;
  #response: IncomingMessage | null = null;
  #externalAbortListener: (() => void) | null = null;
  #errorQueued = false;
  #closeQueued = false;
  #redirectDelivered = false;
  destroyed = false;

  constructor(input: ElectronNetClientRequestInput) {
    super();
    this.#input = input;
    this.once('response', input.responseListener);

    if (input.externalSignal) {
      this.#externalAbortListener = () => {
        this.destroy(abortReason(input.externalSignal!));
      };
      input.externalSignal.addEventListener('abort', this.#externalAbortListener, {
        once: true,
      });
      if (input.externalSignal.aborted) this.#externalAbortListener();
    }
  }

  start(): void {
    if (this.destroyed) return;

    let request: ElectronClientRequest;
    try {
      request = this.#input.request({
        method: 'GET',
        url: this.#input.url,
        headers: { ...this.#input.headers },
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        bypassCustomProtocolHandlers: true,
      });
    } catch {
      this.destroy(new ElectronSystemNetworkRequestError());
      return;
    }
    this.#request = request;

    request.on('response', (response) => this.#deliverResponse(
      response as unknown as IncomingMessage,
    ));
    request.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
      this.#redirectDelivered = true;
      this.#deliverResponse(createRedirectIncomingMessage(
        statusCode,
        redirectUrl,
        responseHeaders,
      ));
    });
    request.on('error', () => {
      // With manual redirects Electron emits a successful redirect event and
      // then an expected "Redirect was cancelled" error. Once the synthetic
      // response has been delivered, that internal cancellation belongs only
      // to the old hop and must not poison the downloader's next request.
      if (this.#redirectDelivered || this.destroyed) return;
      this.destroy(new ElectronSystemNetworkRequestError());
    });

    try {
      request.end();
    } catch {
      this.destroy(new ElectronSystemNetworkRequestError());
    }
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.#detachExternalAbort();

    if (this.#response && !this.#response.destroyed) {
      this.#response.destroy(error);
    }
    try {
      this.#request?.abort();
    } catch {
      // The externally visible request still closes deterministically.
    }
    if (error) this.#queueError(error);
    else this.#queueClose();
    return this;
  }

  #deliverResponse(response: IncomingMessage): void {
    if (this.destroyed || this.#response) {
      if (!response.destroyed) response.destroy();
      return;
    }
    this.#response = response;
    response.once('close', () => this.#complete());
    this.emit('response', response);
  }

  #complete(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.#detachExternalAbort();
    this.#queueClose();
  }

  #queueError(error: Error): void {
    if (this.#errorQueued) return;
    this.#errorQueued = true;
    queueMicrotask(() => {
      this.emit('error', error);
      this.#queueClose();
    });
  }

  #queueClose(): void {
    if (this.#closeQueued) return;
    this.#closeQueued = true;
    queueMicrotask(() => this.emit('close'));
  }

  #detachExternalAbort(): void {
    if (!this.#externalAbortListener || !this.#input.externalSignal) return;
    this.#input.externalSignal.removeEventListener(
      'abort',
      this.#externalAbortListener,
    );
    this.#externalAbortListener = null;
  }
}

function createRedirectIncomingMessage(
  statusCode: number,
  redirectUrl: string,
  responseHeaders: Readonly<Record<string, readonly string[]>>,
): IncomingMessage {
  const incoming = Readable.from([]);
  const headers = normalizeElectronResponseHeaders(responseHeaders);
  if (headers.location === undefined) headers.location = redirectUrl;
  const rawHeaders = Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return Array.isArray(value)
      ? value.flatMap((entry) => [name, entry])
      : [name, value];
  });

  Object.defineProperties(incoming, {
    statusCode: { value: statusCode, configurable: true, enumerable: true },
    statusMessage: { value: '', configurable: true, enumerable: true },
    headers: { value: headers, configurable: true, enumerable: true },
    rawHeaders: { value: rawHeaders, configurable: true, enumerable: true },
  });
  return incoming as unknown as IncomingMessage;
}

function normalizeRequestHeaders(
  headers: RequestOptions['headers'],
): Readonly<Record<string, string>> {
  if (!headers) return {};
  const normalized: Record<string, string> = {};
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) {
      normalized[headers[index]!.toLowerCase()] = headers[index + 1]!;
    }
    return normalized;
  }
  for (const [name, value] of Object.entries(headers as OutgoingHttpHeaders)) {
    if (value === undefined) continue;
    normalized[name.toLowerCase()] = Array.isArray(value)
      ? value.join(', ')
      : String(value);
  }
  return normalized;
}

function normalizeElectronResponseHeaders(
  headers: Readonly<Record<string, readonly string[]>>,
): IncomingHttpHeaders {
  const normalized: IncomingHttpHeaders = {};
  for (const [name, values] of Object.entries(headers)) {
    if (values.length === 0) continue;
    const key = name.toLowerCase();
    normalized[key] = values.length === 1 ? values[0] : [...values];
  }
  return normalized;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('ELECTRON_SYSTEM_NETWORK_REQUEST_ABORTED');
}
