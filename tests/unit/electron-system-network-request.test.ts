// @vitest-environment node

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type {
  ClientRequest as ElectronClientRequest,
  ClientRequestConstructorOptions,
  IncomingMessage as ElectronIncomingMessage,
} from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  ELECTRON_SYSTEM_NETWORK_TRANSPORT,
  ElectronSystemNetworkRequestError,
  createElectronSystemNetworkRequestGet,
  type ElectronSystemRequest,
} from '../../src/backend/services/electron-system-network-request';

const SIGNED_REDIRECT =
  'https://cas-bridge.xethub.hf.co/xet/model?X-Amz-Signature=secret-test-signature';

class FakeElectronRequest extends EventEmitter {
  readonly #onEnd: (request: FakeElectronRequest) => void;
  abortCallCount = 0;
  ended = false;

  constructor(onEnd: (request: FakeElectronRequest) => void) {
    super();
    this.#onEnd = onEnd;
  }

  abort(): void {
    this.abortCallCount += 1;
    this.emit('abort');
    this.emit('close');
  }

  end(): this {
    this.ended = true;
    this.#onEnd(this);
    return this;
  }
}

function fakeRequestFactory(
  onEnd: (request: FakeElectronRequest) => void,
): {
  readonly request: ElectronSystemRequest;
  readonly requestOptions: ClientRequestConstructorOptions[];
  readonly requests: FakeElectronRequest[];
} {
  const requestOptions: ClientRequestConstructorOptions[] = [];
  const requests: FakeElectronRequest[] = [];
  return {
    requestOptions,
    requests,
    request(options) {
      requestOptions.push(options);
      const request = new FakeElectronRequest(onEnd);
      requests.push(request);
      return request as unknown as ElectronClientRequest;
    },
  };
}

function electronResponse(
  chunks: readonly Uint8Array[],
  input: {
    readonly statusCode: number;
    readonly headers: Readonly<Record<string, string | readonly string[]>>;
  },
): ElectronIncomingMessage {
  const response = Readable.from(chunks);
  Object.defineProperties(response, {
    statusCode: { value: input.statusCode, configurable: true, enumerable: true },
    statusMessage: { value: '', configurable: true, enumerable: true },
    headers: { value: input.headers, configurable: true, enumerable: true },
    rawHeaders: { value: [], configurable: true, enumerable: true },
  });
  return response as unknown as ElectronIncomingMessage;
}

function responseFrom(
  requestGet: ReturnType<typeof createElectronSystemNetworkRequestGet>,
  input: string | URL,
  options: Parameters<ReturnType<typeof createElectronSystemNetworkRequestGet>>[1],
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = requestGet(input, options, resolve);
    request.once('error', reject);
  });
}

async function responseBytes(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('Electron system network request adapter', () => {
  it('streams a 206 body through an IncomingMessage-compatible response', async () => {
    const firstRequest = vi.fn();
    const transport = fakeRequestFactory((request) => {
      queueMicrotask(() => request.emit('response', electronResponse(
        [Uint8Array.from([1, 2]), Uint8Array.from([3, 4])],
        {
          statusCode: 206,
          headers: {
            'content-length': '4',
            'content-range': 'bytes 10-13/40',
          },
        },
      )));
    });
    const requestGet = createElectronSystemNetworkRequestGet({
      request: transport.request,
      onFirstRequest: firstRequest,
    });
    const controller = new AbortController();

    const response = await responseFrom(
      requestGet,
      new URL('https://huggingface.co/model'),
      {
        signal: controller.signal,
        headers: {
          Range: 'bytes=10-13',
          'X-Test-Multi': ['one', 'two'],
        },
      },
    );

    expect(response.statusCode).toBe(206);
    expect(response.headers['content-length']).toBe('4');
    expect(response.headers['content-range']).toBe('bytes 10-13/40');
    await expect(responseBytes(response)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    expect(transport.requestOptions).toHaveLength(1);
    expect(transport.requestOptions[0]).toMatchObject({
      method: 'GET',
      url: 'https://huggingface.co/model',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      bypassCustomProtocolHandlers: true,
      headers: {
        range: 'bytes=10-13',
        'x-test-multi': 'one, two',
      },
    });
    expect(transport.requests[0]?.ended).toBe(true);
    expect(firstRequest).toHaveBeenCalledOnce();
    expect(firstRequest).toHaveBeenCalledWith({
      transport: ELECTRON_SYSTEM_NETWORK_TRANSPORT,
    });
  });

  it('converts a manual redirect event to a 302 and swallows Electron cancellation', async () => {
    const transport = fakeRequestFactory((request) => {
      queueMicrotask(() => {
        // Electron 43 emits close before redirect and then reports its expected
        // manual-redirect cancellation as an error.
        request.emit('close');
        request.emit('redirect', 302, 'GET', SIGNED_REDIRECT, {
          Location: [SIGNED_REDIRECT],
          'X-Linked-Etag': ['pinned-etag'],
          'X-Linked-Size': ['12'],
        });
        request.emit('error', new Error('Redirect was cancelled'));
      });
    });
    const requestGet = createElectronSystemNetworkRequestGet({ request: transport.request });
    const emittedErrors: Error[] = [];
    const responsePromise = new Promise<IncomingMessage>((resolve) => {
      const request = requestGet(
        'https://huggingface.co/model',
        { headers: {} },
        resolve,
      );
      request.on('error', (error) => emittedErrors.push(error));
    });

    const response = await responsePromise;

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(SIGNED_REDIRECT);
    expect(response.headers['x-linked-etag']).toBe('pinned-etag');
    expect(response.headers['x-linked-size']).toBe('12');
    await expect(responseBytes(response)).resolves.toEqual(Buffer.alloc(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(emittedErrors).toEqual([]);
  });

  it('aborts the Chromium request and emits the caller abort reason once', async () => {
    const transport = fakeRequestFactory(() => undefined);
    const requestGet = createElectronSystemNetworkRequestGet({ request: transport.request });
    const controller = new AbortController();
    const responseListener = vi.fn();
    const request = requestGet(
      'https://huggingface.co/model',
      { signal: controller.signal },
      responseListener,
    );
    const emittedErrors: Error[] = [];
    const closeListener = vi.fn();
    request.on('close', closeListener);
    const errorPromise = new Promise<Error>((resolve) => {
      request.on('error', (error) => {
        emittedErrors.push(error);
        resolve(error);
      });
    });
    const reason = new Error('explicit test abort');

    controller.abort(reason);

    await expect(errorPromise).resolves.toBe(reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport.requests[0]?.abortCallCount).toBe(1);
    expect((request as ClientRequest).destroyed).toBe(true);
    expect(responseListener).not.toHaveBeenCalled();
    expect(emittedErrors).toEqual([reason]);
    expect(closeListener).toHaveBeenCalledOnce();
  });

  it('destroys an active response without double-emitting a late inner error', async () => {
    const body = new PassThrough();
    Object.defineProperties(body, {
      statusCode: { value: 200, configurable: true, enumerable: true },
      statusMessage: { value: 'OK', configurable: true, enumerable: true },
      headers: { value: {}, configurable: true, enumerable: true },
      rawHeaders: { value: [], configurable: true, enumerable: true },
    });
    const transport = fakeRequestFactory((request) => {
      queueMicrotask(() => request.emit('response', body));
    });
    const requestGet = createElectronSystemNetworkRequestGet({ request: transport.request });
    let request: ClientRequest;
    const response = await new Promise<IncomingMessage>((resolve) => {
      request = requestGet('https://huggingface.co/model', { headers: {} }, resolve);
    });
    response.once('error', () => undefined);
    const emittedErrors: Error[] = [];
    const closeListener = vi.fn();
    request!.on('error', (error) => emittedErrors.push(error));
    request!.on('close', closeListener);
    const reason = new Error('idle timeout');

    request!.destroy(reason);
    transport.requests[0]?.emit('error', new Error('late Chromium abort'));

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(response.destroyed).toBe(true);
    expect(transport.requests[0]?.abortCallCount).toBe(1);
    expect(emittedErrors).toEqual([reason]);
    expect(closeListener).toHaveBeenCalledOnce();
  });

  it('turns a request failure into a URL-free request error', async () => {
    const transport = fakeRequestFactory((request) => {
      queueMicrotask(() => request.emit(
        'error',
        new TypeError(`failed to fetch ${SIGNED_REDIRECT}`),
      ));
    });
    const requestGet = createElectronSystemNetworkRequestGet({ request: transport.request });
    const responseListener = vi.fn();
    const request = requestGet(
      'https://huggingface.co/model',
      { headers: {} },
      responseListener,
    );
    const error = await new Promise<Error>((resolve) => request.once('error', resolve));

    expect(error).toBeInstanceOf(ElectronSystemNetworkRequestError);
    expect(error).toMatchObject({ code: 'ELECTRON_SYSTEM_NETWORK_REQUEST_FAILED' });
    expect(error.message).not.toContain(SIGNED_REDIRECT);
    expect(error).not.toHaveProperty('cause');
    expect(responseListener).not.toHaveBeenCalled();
  });

  it('wires net.request with the default Session into both model download routes', async () => {
    const source = await readFile(
      path.join(process.cwd(), 'src/backend/main.ts'),
      'utf8',
    );

    expect(source).toMatch(
      /request: \(requestOptions\) => net\.request\(\{\s*\.\.\.requestOptions,\s*session: session\.defaultSession,?\s*\}\)/u,
    );
    expect(source).toMatch(
      /new LocalAsrDirectDownloader\(\{\s*requestGet: modelDownloadRequestGet,?\s*\}\)/u,
    );
    expect(source).toMatch(
      /downloadOfficialLocalAsrModelArchive\(\{\s*\.\.\.input,\s*requestGet: modelDownloadRequestGet,?\s*\}\)/u,
    );
    expect(source).toContain("event: 'asr.model.download-transport-selected'");
    expect(source).toContain('fields: { transport }');
  });
});
