// @vitest-environment node

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { Readable } from 'node:stream';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LOCAL_ASR_DIRECT_CHECKPOINT_DIRECTORY_NAME,
  LocalAsrDirectDownloadError,
  LocalAsrDirectDownloader,
  assertTrustedLocalAsrDirectDownloadUrl,
  calculateDirectRetryDelayMilliseconds,
  removeLocalAsrDirectCheckpoint,
  type LocalAsrDirectDownloadProgress,
} from '../../src/backend/services/local-asr-direct-download';
import {
  LOCAL_ASR_DIRECT_DISTRIBUTION,
  LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
  LOCAL_ASR_DIRECT_GLOBAL_CONCURRENCY,
  LOCAL_ASR_DIRECT_MODEL_FILES,
  LOCAL_ASR_DIRECT_SEGMENT_COUNT,
  LOCAL_ASR_MODEL_REVISION,
  type LocalAsrDirectModelDistribution,
} from '../../src/backend/services/local-asr-model-distribution';
import type { LocalAsrModelFileName } from '../../src/shared';

const temporaryDirectories: string[] = [];

const FIXTURE_BYTES: Readonly<Record<LocalAsrModelFileName, Buffer>> = {
  'encoder.int8.onnx': Buffer.from('encoder-fixture-byte-range-content'),
  'decoder.int8.onnx': Buffer.from('decoder-fixture-content'),
  'tokens.txt': Buffer.from('tokens-fixture'),
};

const FIXTURE_DISTRIBUTION: LocalAsrDirectModelDistribution = {
  revision: 'a'.repeat(40),
  files: (Object.entries(FIXTURE_BYTES) as [LocalAsrModelFileName, Buffer][]).map(
    ([name, bytes]) => ({
      name,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      remoteKind: name === 'tokens.txt' ? 'git_blob' : 'lfs',
    }),
  ),
  sources: [
    { id: 'huggingface_official', trust: 'official', baseUrl: 'https://huggingface.co' },
    {
      id: 'hf_mirror_acceleration',
      trust: 'third_party_acceleration_mirror',
      baseUrl: 'https://hf-mirror.com',
    },
  ],
  segmentCount: 8,
  globalConcurrency: 8,
};

class FakeClientRequest extends EventEmitter {
  destroyed = false;

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (error) queueMicrotask(() => this.emit('error', error));
    return this;
  }
}

type RangeMode = 'success' | 'short_success' | 'fail_with_byte' | 'fail_empty' | 'hang';

class DelayedRangeResponse extends Readable {
  readonly #bytes: Buffer;
  readonly #mode: RangeMode;
  readonly #settled: () => void;
  #started = false;
  #didSettle = false;

  constructor(bytes: Buffer, mode: RangeMode, settled: () => void) {
    super();
    this.#bytes = bytes;
    this.#mode = mode;
    this.#settled = settled;
  }

  override _read(): void {
    if (this.#started) return;
    this.#started = true;
    if (this.#mode === 'hang') return;
    setTimeout(() => {
      if (this.destroyed) return;
      if (this.#mode === 'success') {
        this.push(this.#bytes);
        this.push(null);
        return;
      }
      if (this.#mode === 'short_success') {
        this.push(this.#bytes.subarray(0, Math.min(1, this.#bytes.byteLength)));
        this.push(null);
        return;
      }
      if (this.#mode === 'fail_with_byte' && this.#bytes.byteLength > 0) {
        this.push(this.#bytes.subarray(0, 1));
      }
      setTimeout(() => this.destroy(new Error('simulated range failure')), 1);
    }, 2);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.#didSettle) {
      this.#didSettle = true;
      this.#settled();
    }
    setTimeout(() => callback(error), 2);
  }
}

interface RangeCall {
  readonly fileName: LocalAsrModelFileName;
  readonly start: number;
  readonly end: number;
}

interface FakeTransportOptions {
  readonly mirrorMigratesToOfficial?: boolean;
  readonly omitPinnedMetadataOnLfsRedirect?: boolean;
  readonly serveOfficialEntryDirectly?: boolean;
  readonly modeForRange?: (call: RangeCall, callNumber: number) => RangeMode;
  readonly responseForRange?: (call: RangeCall, defaults: {
    readonly statusCode: number;
    readonly contentLength: string;
    readonly contentRange: string;
  }) => {
    readonly statusCode: number;
    readonly contentLength?: string;
    readonly contentRange?: string;
    readonly retryAfter?: string;
  };
}

function createFakeTransport(
  distribution: LocalAsrDirectModelDistribution,
  bytesByName: Readonly<Record<LocalAsrModelFileName, Buffer>>,
  options: FakeTransportOptions = {},
) {
  const objectByFile = new Map<LocalAsrModelFileName, string>();
  const fileByObject = new Map<string, LocalAsrModelFileName>();
  for (const file of distribution.files) {
    const objectIdentity = sha256(Buffer.from(`xet-object:${file.name}`));
    objectByFile.set(file.name, objectIdentity);
    fileByObject.set(objectIdentity, file.name);
  }
  const rangeCalls: RangeCall[] = [];
  let activeResponses = 0;
  let maximumActiveResponses = 0;

  const requestGet = ((url: URL, requestOptions: RequestOptions, listener: (
    response: IncomingMessage,
  ) => void) => {
    const request = new FakeClientRequest();
    queueMicrotask(() => {
      if (request.destroyed) return;
      const isResolveCache = url.pathname.startsWith('/api/resolve-cache/models/');
      let directEntryFileName: LocalAsrModelFileName | undefined;
      if (
        (url.hostname === 'huggingface.co' || url.hostname === 'hf-mirror.com')
        && !isResolveCache
      ) {
        const name = decodeURIComponent(
          url.pathname.split('/').at(-1) ?? '',
        ) as LocalAsrModelFileName;
        const file = distribution.files.find((candidate) => candidate.name === name);
        if (!file) {
          request.emit('error', new Error('unknown fixture file'));
          return;
        }
        if (url.hostname === 'hf-mirror.com' && options.mirrorMigratesToOfficial) {
          listener(fakeIncomingMessage(308, {
            location: `https://huggingface.co${url.pathname}${url.search}`,
          }));
          return;
        }
        if (url.hostname === 'huggingface.co' && options.serveOfficialEntryDirectly) {
          directEntryFileName = name;
        } else if (file.remoteKind === 'git_blob') {
          listener(fakeIncomingMessage(307, {
            location:
              `${url.origin}/api/resolve-cache/models/csukuangfj/`
              + `sherpa-onnx-streaming-paraformer-bilingual-zh-en/${distribution.revision}/`
              + `${file.name}?etag=test`,
            'x-linked-etag': `"${'4'.repeat(40)}"`,
          }));
        } else {
          const objectIdentity = objectByFile.get(name)!;
          const redirectHeaders: Record<string, string> = {
            location:
              `https://cas-bridge.xethub.hf.co/xet-bridge-us/${'1'.repeat(24)}/${objectIdentity}?X-Amz-Signature=test`,
          };
          if (!options.omitPinnedMetadataOnLfsRedirect) {
            redirectHeaders['x-linked-etag'] = `"${file.sha256}"`;
            redirectHeaders['x-linked-size'] = String(file.byteLength);
          }
          listener(fakeIncomingMessage(302, redirectHeaders));
          return;
        }
        if (!directEntryFileName) return;
      }

      const objectIdentity = url.pathname.split('/').at(-1) ?? '';
      const fileName = directEntryFileName ?? (isResolveCache
        ? decodeURIComponent(objectIdentity) as LocalAsrModelFileName
        : fileByObject.get(objectIdentity));
      if (!fileName) {
        request.emit('error', new Error('unknown fixture object'));
        return;
      }
      const headers = requestOptions.headers as Readonly<Record<string, string>>;
      const match = /^bytes=(\d+)-(\d+)$/u.exec(headers.Range ?? '');
      if (!match) {
        request.emit('error', new Error('missing exact range'));
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      const call = { fileName, start, end } satisfies RangeCall;
      rangeCalls.push(call);
      const source = bytesByName[fileName].subarray(start, end + 1);
      const mode = options.modeForRange?.(call, rangeCalls.length) ?? 'success';
      const defaults = {
        statusCode: 206,
        contentLength: String(source.byteLength),
        contentRange: `bytes ${start}-${end}/${bytesByName[fileName].byteLength}`,
      };
      const responseMetadata: {
        readonly statusCode: number;
        readonly contentLength?: string;
        readonly contentRange?: string;
        readonly retryAfter?: string;
      } = options.responseForRange?.(call, defaults) ?? defaults;
      activeResponses += 1;
      maximumActiveResponses = Math.max(maximumActiveResponses, activeResponses);
      const response = new DelayedRangeResponse(source, mode, () => {
        activeResponses -= 1;
      }) as unknown as IncomingMessage;
      Object.defineProperty(response, 'statusCode', {
        value: responseMetadata.statusCode,
        configurable: true,
      });
      Object.defineProperty(response, 'headers', {
        value: {
          'content-length': responseMetadata.contentLength,
          'content-range': responseMetadata.contentRange,
          'retry-after': responseMetadata.retryAfter,
        },
        configurable: true,
      });
      listener(response);
    });
    return request as unknown as ClientRequest;
  }) as unknown as typeof import('node:https').get;

  return {
    requestGet,
    rangeCalls,
    activeResponses: () => activeResponses,
    maximumActiveResponses: () => maximumActiveResponses,
  };
}

function fakeIncomingMessage(
  statusCode: number,
  headers: Readonly<Record<string, string>>,
): IncomingMessage {
  const response = Readable.from([]) as unknown as IncomingMessage;
  Object.defineProperty(response, 'statusCode', { value: statusCode, configurable: true });
  Object.defineProperty(response, 'headers', { value: headers, configurable: true });
  return response;
}

async function createPaths() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phrio-direct-download-'));
  temporaryDirectories.push(root);
  return {
    root,
    checkpoint: path.join(root, LOCAL_ASR_DIRECT_CHECKPOINT_DIRECTORY_NAME),
    candidate: path.join(root, 'candidate'),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition was not reached');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('local ASR direct distribution', () => {
  it('freezes the commit, exact three-file identities, 8x8 bounds, and mirror trust label', () => {
    expect(LOCAL_ASR_MODEL_REVISION).toBe('8e40c43232a1c5c66c82111efc5820d3accca11b');
    expect(LOCAL_ASR_DIRECT_SEGMENT_COUNT).toBe(8);
    expect(LOCAL_ASR_DIRECT_GLOBAL_CONCURRENCY).toBe(8);
    expect(LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH).toBe(237_202_501);
    expect(LOCAL_ASR_DIRECT_MODEL_FILES).toEqual([
      expect.objectContaining({
        name: 'encoder.int8.onnx',
        byteLength: 165_462_184,
        sha256: '81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a',
      }),
      expect.objectContaining({
        name: 'decoder.int8.onnx',
        byteLength: 71_664_561,
        sha256: 'f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f',
      }),
      expect.objectContaining({
        name: 'tokens.txt',
        byteLength: 75_756,
        sha256: '59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6',
      }),
    ]);
    expect(LOCAL_ASR_DIRECT_DISTRIBUTION.sources).toContainEqual(expect.objectContaining({
      id: 'huggingface_official',
      trust: 'official',
    }));
    expect(LOCAL_ASR_DIRECT_DISTRIBUTION.sources).toContainEqual(expect.objectContaining({
      id: 'hf_mirror_acceleration',
      trust: 'third_party_acceleration_mirror',
    }));
  });

  it('allows only the exact pinned entry URL and constrained HF object redirects', () => {
    const initialUrl =
      'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/'
      + `${'a'.repeat(40)}/encoder.int8.onnx?download=true`;
    expect(assertTrustedLocalAsrDirectDownloadUrl({
      rawUrl: initialUrl,
      initialUrl,
      redirectDepth: 0,
    }).href).toBe(initialUrl);
    expect(assertTrustedLocalAsrDirectDownloadUrl({
      rawUrl:
        `https://cas-bridge.xethub.hf.co/xet-bridge-us/${'1'.repeat(24)}/${'2'.repeat(64)}?sig=x`,
      initialUrl,
      redirectDepth: 1,
    }).hostname).toBe('cas-bridge.xethub.hf.co');
    expect(assertTrustedLocalAsrDirectDownloadUrl({
      rawUrl: `https://us.aws.cdn.hf.co/repos/model/${'3'.repeat(64)}?sig=x`,
      initialUrl,
      redirectDepth: 1,
    }).hostname).toBe('us.aws.cdn.hf.co');
    const mirrorInitial = initialUrl.replace('huggingface.co', 'hf-mirror.com');
    expect(assertTrustedLocalAsrDirectDownloadUrl({
      rawUrl: initialUrl,
      initialUrl: mirrorInitial,
      redirectDepth: 1,
    }).href).toBe(initialUrl);
    expect(() => assertTrustedLocalAsrDirectDownloadUrl({
      rawUrl: initialUrl.replace('encoder.int8.onnx', 'decoder.int8.onnx'),
      initialUrl: mirrorInitial,
      redirectDepth: 1,
    })).toThrowError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
    expect(() => assertTrustedLocalAsrDirectDownloadUrl({
      rawUrl: `${initialUrl}&changed=true`,
      initialUrl: mirrorInitial,
      redirectDepth: 1,
    })).toThrowError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
    expect(() => assertTrustedLocalAsrDirectDownloadUrl({
      rawUrl: initialUrl,
      initialUrl: mirrorInitial,
      redirectDepth: 2,
    })).toThrowError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
    const tokenInitial =
      'https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/'
      + `resolve/${'a'.repeat(40)}/tokens.txt?download=true`;
    const tokenCache =
      'https://hf-mirror.com/api/resolve-cache/models/csukuangfj/'
      + 'sherpa-onnx-streaming-paraformer-bilingual-zh-en/'
      + `${'a'.repeat(40)}/tokens.txt?etag=git-blob`;
    expect(assertTrustedLocalAsrDirectDownloadUrl({
      rawUrl: tokenCache,
      initialUrl: tokenInitial,
      redirectDepth: 1,
    }).pathname).toContain('/api/resolve-cache/models/');
    expect(() => assertTrustedLocalAsrDirectDownloadUrl({
      rawUrl: 'https://evil.example/model',
      initialUrl,
      redirectDepth: 1,
    })).toThrowError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
    expect(() => assertTrustedLocalAsrDirectDownloadUrl({
      rawUrl: `${initialUrl}&file=decoder`,
      initialUrl,
      redirectDepth: 0,
    })).toThrowError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
  });
});

describe('LocalAsrDirectDownloader', () => {
  it('uses bounded Retry-After-aware exponential jitter', () => {
    expect(calculateDirectRetryDelayMilliseconds(1, null, () => 0)).toBe(250);
    expect(calculateDirectRetryDelayMilliseconds(2, null, () => 1)).toBe(600);
    expect(calculateDirectRetryDelayMilliseconds(1, 8_000, () => 1)).toBe(9_000);
    expect(calculateDirectRetryDelayMilliseconds(10, 60_000, () => 1)).toBe(9_000);
  });

  it('downloads 8 ranges per LFS file and one exact git blob with global concurrency <= 8', async () => {
    const paths = await createPaths();
    const transport = createFakeTransport(FIXTURE_DISTRIBUTION, FIXTURE_BYTES);
    const progress: LocalAsrDirectDownloadProgress[] = [];
    const downloader = new LocalAsrDirectDownloader({
      distribution: FIXTURE_DISTRIBUTION,
      requestGet: transport.requestGet,
      idleTimeoutMilliseconds: 1_000,
    });

    const result = await downloader.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'huggingface_official',
      signal: new AbortController().signal,
      onProgress: (entry) => progress.push(entry),
    });

    expect(result.downloadedBytes).toBe(
      Object.values(FIXTURE_BYTES).reduce((sum, bytes) => sum + bytes.byteLength, 0),
    );
    expect(transport.rangeCalls).toHaveLength(17);
    expect(transport.maximumActiveResponses()).toBeLessThanOrEqual(8);
    for (const [name, expected] of Object.entries(FIXTURE_BYTES)) {
      expect(await readFile(path.join(paths.candidate, name))).toEqual(expected);
      expect(transport.rangeCalls.filter((call) => call.fileName === name)).toHaveLength(
        name === 'tokens.txt' ? 1 : 8,
      );
    }
    expect(progress.at(-1)).toMatchObject({
      downloadedBytes: result.expectedBytes,
      expectedBytes: result.expectedBytes,
    });
    await expect(downloader.inspectCheckpoint(paths.checkpoint)).resolves.toEqual({
      downloadedBytes: result.expectedBytes,
      expectedBytes: result.expectedBytes,
      complete: true,
    });
  });

  it('attributes a source-agnostic complete checkpoint to the official authority', async () => {
    const paths = await createPaths();
    const transport = createFakeTransport(FIXTURE_DISTRIBUTION, FIXTURE_BYTES);
    const downloader = new LocalAsrDirectDownloader({
      distribution: FIXTURE_DISTRIBUTION,
      requestGet: transport.requestGet,
      idleTimeoutMilliseconds: 1_000,
    });
    await downloader.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'huggingface_official',
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    const networkRequestsAfterCheckpoint = transport.rangeCalls.length;
    await rm(paths.candidate, { recursive: true, force: true });

    const restarted = await downloader.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'hf_mirror_acceleration',
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(restarted).toMatchObject({
      source: 'hf_mirror_acceleration',
      resolvedSource: 'huggingface_official',
    });
    expect(transport.rangeCalls).toHaveLength(networkRequestsAfterCheckpoint);
  });

  it('accepts only an exact mirror-to-official migration before pinned object metadata', async () => {
    const paths = await createPaths();
    const transport = createFakeTransport(FIXTURE_DISTRIBUTION, FIXTURE_BYTES, {
      mirrorMigratesToOfficial: true,
    });
    const downloader = new LocalAsrDirectDownloader({
      distribution: FIXTURE_DISTRIBUTION,
      requestGet: transport.requestGet,
      idleTimeoutMilliseconds: 1_000,
    });
    const diagnostics: string[] = [];

    await expect(downloader.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'hf_mirror_acceleration',
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onDiagnostic: (event) => diagnostics.push(event),
    })).resolves.toMatchObject({
      source: 'hf_mirror_acceleration',
      resolvedSource: 'huggingface_official',
    });
    expect(transport.rangeCalls).toHaveLength(17);
    expect(diagnostics.filter((event) => event === 'direct-mirror-entry-migrated'))
      .toHaveLength(1);
  });

  it('rejects a migrated mirror chain when the object hop omits pinned metadata', async () => {
    const paths = await createPaths();
    const transport = createFakeTransport(FIXTURE_DISTRIBUTION, FIXTURE_BYTES, {
      mirrorMigratesToOfficial: true,
      omitPinnedMetadataOnLfsRedirect: true,
    });
    const downloader = new LocalAsrDirectDownloader({
      distribution: FIXTURE_DISTRIBUTION,
      requestGet: transport.requestGet,
      idleTimeoutMilliseconds: 1_000,
    });

    await expect(downloader.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'hf_mirror_acceleration',
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).rejects.toMatchObject({ code: 'ASR_MODEL_DIRECT_REDIRECT_REJECTED' });
    expect(transport.rangeCalls).not.toHaveLength(0);
    expect(transport.rangeCalls.every((call) => call.fileName === 'tokens.txt')).toBe(true);
  });

  it('rejects a successful redirected body until pinned metadata has been validated', async () => {
    const paths = await createPaths();
    const transport = createFakeTransport(FIXTURE_DISTRIBUTION, FIXTURE_BYTES, {
      mirrorMigratesToOfficial: true,
      serveOfficialEntryDirectly: true,
    });
    const downloader = new LocalAsrDirectDownloader({
      distribution: FIXTURE_DISTRIBUTION,
      requestGet: transport.requestGet,
      idleTimeoutMilliseconds: 1_000,
    });

    await expect(downloader.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'hf_mirror_acceleration',
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).rejects.toMatchObject({ code: 'ASR_MODEL_DIRECT_REDIRECT_REJECTED' });
    expect(transport.rangeCalls).toHaveLength(8);
    await expect(downloader.inspectCheckpoint(paths.checkpoint)).resolves.toMatchObject({
      downloadedBytes: 0,
    });
  });

  it('accepts a chunked 200 response only for the complete pinned git blob', async () => {
    const paths = await createPaths();
    const transport = createFakeTransport(FIXTURE_DISTRIBUTION, FIXTURE_BYTES, {
      responseForRange: (call, defaults) => call.fileName === 'tokens.txt'
        ? { statusCode: 200 }
        : defaults,
    });
    const downloader = new LocalAsrDirectDownloader({
      distribution: FIXTURE_DISTRIBUTION,
      requestGet: transport.requestGet,
      idleTimeoutMilliseconds: 1_000,
    });

    await expect(downloader.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'hf_mirror_acceleration',
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).resolves.toMatchObject({ downloadedBytes: expect.any(Number) });
    expect(await readFile(path.join(paths.candidate, 'tokens.txt')))
      .toEqual(FIXTURE_BYTES['tokens.txt']);
  });

  it('restarts a short chunked git blob from byte zero and succeeds on retry', async () => {
    const paths = await createPaths();
    let tokenAttempts = 0;
    const transport = createFakeTransport(FIXTURE_DISTRIBUTION, FIXTURE_BYTES, {
      responseForRange: (call, defaults) => call.fileName === 'tokens.txt'
        ? { statusCode: 200 }
        : defaults,
      modeForRange: (call) => {
        if (call.fileName !== 'tokens.txt') return 'success';
        tokenAttempts += 1;
        return tokenAttempts === 1 ? 'short_success' : 'success';
      },
    });
    const downloader = new LocalAsrDirectDownloader({
      distribution: FIXTURE_DISTRIBUTION,
      requestGet: transport.requestGet,
      idleTimeoutMilliseconds: 1_000,
      retryDelayMilliseconds: () => 0,
    });

    await expect(downloader.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'hf_mirror_acceleration',
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    })).resolves.toMatchObject({ downloadedBytes: expect.any(Number) });

    expect(transport.rangeCalls.filter((call) => call.fileName === 'tokens.txt'))
      .toEqual([
        { fileName: 'tokens.txt', start: 0, end: FIXTURE_BYTES['tokens.txt'].byteLength - 1 },
        { fileName: 'tokens.txt', start: 0, end: FIXTURE_BYTES['tokens.txt'].byteLength - 1 },
      ]);
    expect(await readFile(path.join(paths.candidate, 'tokens.txt')))
      .toEqual(FIXTURE_BYTES['tokens.txt']);
  });

  it('recovers when any of the 17 segments receives one transient HTTP response', async () => {
    const paths = await createPaths();
    const failedSegments = new Set<string>();
    const retryStatusCodes = [408, 425, 429, 500, 502, 503, 504] as const;
    const transport = createFakeTransport(FIXTURE_DISTRIBUTION, FIXTURE_BYTES, {
      responseForRange: (call, defaults) => {
        const key = `${call.fileName}:${call.start}-${call.end}`;
        if (failedSegments.has(key)) return defaults;
        const statusCode = retryStatusCodes[failedSegments.size % retryStatusCodes.length]!;
        failedSegments.add(key);
        return { ...defaults, statusCode, retryAfter: '99999' };
      },
    });
    const observedRetryAfter: (number | null)[] = [];
    const diagnostics = vi.fn();
    const downloader = new LocalAsrDirectDownloader({
      distribution: FIXTURE_DISTRIBUTION,
      requestGet: transport.requestGet,
      idleTimeoutMilliseconds: 1_000,
      retryDelayMilliseconds: (_attempt, retryAfterMilliseconds) => {
        observedRetryAfter.push(retryAfterMilliseconds);
        return 0;
      },
    });

    await expect(downloader.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'huggingface_official',
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      onDiagnostic: diagnostics,
    })).resolves.toMatchObject({ downloadedBytes: expect.any(Number) });

    expect(failedSegments.size).toBe(17);
    expect(transport.rangeCalls).toHaveLength(34);
    expect(observedRetryAfter).toEqual(Array.from({ length: 17 }, () => 8_000));
    expect(diagnostics.mock.calls.filter(([event]) =>
      event === 'direct-segment-retry-scheduled')).toHaveLength(17);
  });

  it.each([
    {
      label: 'a 200 response',
      mutate: (defaults: { statusCode: number; contentLength: string; contentRange: string }) => ({
        ...defaults,
        statusCode: 200,
      }),
    },
    {
      label: 'an imprecise content length',
      mutate: (defaults: { statusCode: number; contentLength: string; contentRange: string }) => ({
        ...defaults,
        contentLength: String(Number(defaults.contentLength) + 1),
      }),
    },
    {
      label: 'an imprecise content range',
      mutate: (defaults: { statusCode: number; contentLength: string; contentRange: string }) => ({
        ...defaults,
        contentRange: defaults.contentRange.replace(/^bytes \d+-/u, 'bytes 999-'),
      }),
    },
  ])('rejects $label before appending checkpoint bytes', async ({ mutate }) => {
    const paths = await createPaths();
    let mutated = false;
    const transport = createFakeTransport(FIXTURE_DISTRIBUTION, FIXTURE_BYTES, {
      responseForRange: (_call, defaults) => {
        if (mutated) return defaults;
        mutated = true;
        return mutate(defaults);
      },
    });
    const downloader = new LocalAsrDirectDownloader({
      distribution: FIXTURE_DISTRIBUTION,
      requestGet: transport.requestGet,
      idleTimeoutMilliseconds: 1_000,
    });

    await expect(downloader.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'huggingface_official',
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    })).rejects.toMatchObject({ code: 'ASR_MODEL_DIRECT_RANGE_REJECTED' });
    expect(transport.activeResponses()).toBe(0);
    const rejectedCall = transport.rangeCalls[0]!;
    expect(rejectedCall.start).toBe(0);
    expect(transport.rangeCalls.filter((call) =>
      call.fileName === rejectedCall.fileName
      && call.start === rejectedCall.start
      && call.end === rejectedCall.end)).toHaveLength(1);
    expect(await readdir(paths.checkpoint)).not.toContain(
      `${rejectedCall.fileName}.segment-00.partial`,
    );
  });

  it('retains an independent partial segment, settles failed workers, and resumes its exact range', async () => {
    const paths = await createPaths();
    const encoderSegmentEnd = Math.floor(FIXTURE_BYTES['encoder.int8.onnx'].byteLength / 8) - 1;
    let targetFailures = 0;
    const failing = createFakeTransport(FIXTURE_DISTRIBUTION, FIXTURE_BYTES, {
      modeForRange: (call) => {
        if (call.fileName !== 'encoder.int8.onnx' || call.end !== encoderSegmentEnd) {
          return 'success';
        }
        targetFailures += 1;
        return targetFailures === 1 ? 'fail_with_byte' : 'fail_empty';
      },
    });
    const first = new LocalAsrDirectDownloader({
      distribution: FIXTURE_DISTRIBUTION,
      requestGet: failing.requestGet,
      idleTimeoutMilliseconds: 1_000,
    });

    await expect(first.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'hf_mirror_acceleration',
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    })).rejects.toMatchObject({ code: 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED' });
    expect(failing.activeResponses()).toBe(0);
    const retained = await first.inspectCheckpoint(paths.checkpoint);
    expect(retained.downloadedBytes).toBeGreaterThan(0);
    expect(retained.downloadedBytes).toBeLessThan(retained.expectedBytes);
    expect(await readdir(paths.candidate)).toEqual([]);

    const resumedTransport = createFakeTransport(FIXTURE_DISTRIBUTION, FIXTURE_BYTES);
    const resumed = new LocalAsrDirectDownloader({
      distribution: FIXTURE_DISTRIBUTION,
      requestGet: resumedTransport.requestGet,
      idleTimeoutMilliseconds: 1_000,
    });
    await resumed.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'huggingface_official',
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });

    expect(resumedTransport.rangeCalls).toContainEqual(expect.objectContaining({
      fileName: 'encoder.int8.onnx',
      start: 1,
      end: encoderSegmentEnd,
    }));
    expect(await readFile(path.join(paths.candidate, 'encoder.int8.onnx')))
      .toEqual(FIXTURE_BYTES['encoder.int8.onnx']);
  });

  it('aborts all active range pipelines and resolves rejection only after every worker settles', async () => {
    const paths = await createPaths();
    const transport = createFakeTransport(FIXTURE_DISTRIBUTION, FIXTURE_BYTES, {
      modeForRange: () => 'hang',
    });
    const downloader = new LocalAsrDirectDownloader({
      distribution: FIXTURE_DISTRIBUTION,
      requestGet: transport.requestGet,
      idleTimeoutMilliseconds: 10_000,
    });
    const controller = new AbortController();
    const operation = downloader.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'huggingface_official',
      signal: controller.signal,
      onProgress: vi.fn(),
    });

    await waitUntil(() => transport.activeResponses() === 8);
    controller.abort(new Error('explicit test abort'));
    await expect(operation).rejects.toThrow('explicit test abort');
    expect(transport.activeResponses()).toBe(0);
    expect(await readdir(paths.candidate)).toEqual([]);
  });

  it('removes only the corrupted file segments after final SHA mismatch and never promotes bytes', async () => {
    const paths = await createPaths();
    const corruptDistribution: LocalAsrDirectModelDistribution = {
      ...FIXTURE_DISTRIBUTION,
      files: FIXTURE_DISTRIBUTION.files.map((file) => file.name === 'encoder.int8.onnx'
        ? { ...file, sha256: '0'.repeat(64) }
        : file),
    };
    const transport = createFakeTransport(corruptDistribution, FIXTURE_BYTES);
    const downloader = new LocalAsrDirectDownloader({
      distribution: corruptDistribution,
      requestGet: transport.requestGet,
      idleTimeoutMilliseconds: 1_000,
    });

    await expect(downloader.download({
      checkpointDirectory: paths.checkpoint,
      destinationDirectory: paths.candidate,
      source: 'hf_mirror_acceleration',
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    })).rejects.toMatchObject({ code: 'ASR_MODEL_DIRECT_INTEGRITY_MISMATCH' });

    expect(await readdir(paths.candidate)).toEqual([]);
    const checkpointEntries = await readdir(paths.checkpoint);
    expect(checkpointEntries.some((entry) => entry.startsWith('encoder.int8.onnx.segment-')))
      .toBe(false);
    expect(checkpointEntries.some((entry) => entry.startsWith('decoder.int8.onnx.segment-')))
      .toBe(true);
  });

  it('limits cleanup to the fixed direct-v2 checkpoint basename', async () => {
    const paths = await createPaths();
    await expect(removeLocalAsrDirectCheckpoint(paths.root)).rejects.toBeInstanceOf(
      LocalAsrDirectDownloadError,
    );
    await removeLocalAsrDirectCheckpoint(paths.checkpoint);
  });
});
