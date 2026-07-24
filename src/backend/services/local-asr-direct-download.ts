import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  type Stats,
} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';

import type { LocalAsrModelFileName } from '../../shared';
import {
  LOCAL_ASR_DIRECT_DISTRIBUTION,
  type LocalAsrDirectModelDistribution,
  type LocalAsrDirectModelFileDescriptor,
  type LocalAsrDirectSourceId,
  assertValidLocalAsrDirectDistribution,
  getLocalAsrDirectSourceDescriptor,
  localAsrDirectFileUrl,
} from './local-asr-model-distribution';

const DIRECT_CHECKPOINT_SCHEMA_VERSION = 2;
export const LOCAL_ASR_DIRECT_CHECKPOINT_DIRECTORY_NAME = '.phrio-asr-direct-v2';
const DIRECT_CHECKPOINT_MANIFEST = 'manifest.json';
const DIRECT_CHECKPOINT_MANIFEST_MAXIMUM_BYTES = 64 * 1_024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAXIMUM_REDIRECTS = 4;
const MAXIMUM_DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_IDLE_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_SIGNED_QUERY_BYTES = 16 * 1_024;
const DIRECT_RETRY_BASE_DELAY_MILLISECONDS = 250;
const DIRECT_RETRY_AFTER_MAXIMUM_MILLISECONDS = 8_000;
const DIRECT_RETRY_DELAY_MAXIMUM_MILLISECONDS = 10_000;

type ModelHttpsGet = typeof https.get;

export interface LocalAsrDirectDownloadProgress {
  readonly source: LocalAsrDirectSourceId;
  readonly downloadedBytes: number;
  readonly expectedBytes: number;
  readonly fileName: LocalAsrModelFileName | null;
  readonly segmentIndex: number | null;
  readonly fileDownloadedBytes: number | null;
}

export interface LocalAsrDirectDownloadInput {
  readonly checkpointDirectory: string;
  readonly destinationDirectory: string;
  readonly source: LocalAsrDirectSourceId;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: LocalAsrDirectDownloadProgress) => void;
  readonly onDiagnostic?: (
    event: string,
    fields: Readonly<Record<string, string | number | boolean | null>>,
  ) => void;
}

export interface LocalAsrDirectDownloadResult {
  /** Entry source requested by the installer. */
  readonly source: LocalAsrDirectSourceId;
  /** Actual trusted entry source after any exact mirror-to-official migration. */
  readonly resolvedSource: LocalAsrDirectSourceId;
  readonly revision: string;
  readonly downloadedBytes: number;
  readonly expectedBytes: number;
  readonly files: readonly {
    readonly name: LocalAsrModelFileName;
    readonly byteLength: number;
    readonly sha256: string;
    readonly remoteKind: 'lfs' | 'git_blob';
  }[];
}

export interface LocalAsrDirectCheckpointStatus {
  readonly downloadedBytes: number;
  readonly expectedBytes: number;
  readonly complete: boolean;
}

export interface LocalAsrDirectDownloaderOptions {
  /** Production uses the immutable distribution; tests may inject byte-small fixtures. */
  readonly distribution?: LocalAsrDirectModelDistribution;
  /** Test transport seam. Production always uses node:https. */
  readonly requestGet?: ModelHttpsGet;
  /** Test-only override. Production keeps the 30 second per-attempt idle gate. */
  readonly idleTimeoutMilliseconds?: number;
  /** Test-only seam. Production uses bounded exponential delay plus jitter. */
  readonly retryDelayMilliseconds?: (
    attempt: number,
    retryAfterMilliseconds: number | null,
  ) => number;
}

interface DirectCheckpointManifest {
  readonly schemaVersion: typeof DIRECT_CHECKPOINT_SCHEMA_VERSION;
  readonly revision: string;
  readonly segmentCount: number;
  readonly files: readonly {
    readonly name: LocalAsrModelFileName;
    readonly byteLength: number;
    readonly sha256: string;
    readonly remoteKind: 'lfs' | 'git_blob';
  }[];
}

interface SegmentDescriptor {
  readonly file: LocalAsrDirectModelFileDescriptor;
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly byteLength: number;
  readonly checkpointPath: string;
  readonly key: string;
}

interface SegmentState {
  readonly segment: SegmentDescriptor;
  readonly downloadedBytes: number;
}

interface ResponseLease {
  readonly response: IncomingMessage;
  readonly touch: () => void;
  readonly dispose: () => void;
}

export type LocalAsrDirectDownloadErrorCode =
  | 'ASR_MODEL_DIRECT_DISTRIBUTION_INVALID'
  | 'ASR_MODEL_DIRECT_CHECKPOINT_INVALID'
  | 'ASR_MODEL_DIRECT_DESTINATION_INVALID'
  | 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED'
  | 'ASR_MODEL_DIRECT_RANGE_REJECTED'
  | 'ASR_MODEL_DIRECT_REDIRECT_REJECTED'
  | 'ASR_MODEL_DIRECT_INTEGRITY_MISMATCH';

export class LocalAsrDirectDownloadError extends Error {
  readonly code: LocalAsrDirectDownloadErrorCode;
  readonly retryAfterMilliseconds: number | null;
  readonly httpStatusCode: number | null;

  constructor(
    code: LocalAsrDirectDownloadErrorCode,
    cause?: unknown,
    metadata: {
      readonly retryAfterMilliseconds?: number | null;
      readonly httpStatusCode?: number | null;
    } = {},
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'LocalAsrDirectDownloadError';
    this.code = code;
    this.retryAfterMilliseconds = metadata.retryAfterMilliseconds ?? null;
    this.httpStatusCode = metadata.httpStatusCode ?? null;
  }
}

/**
 * Downloads only the three runtime files. Each file is divided into eight
 * deterministic ranges and all ranges share one bounded eight-worker pool.
 * Checkpoint segments remain source-agnostic because immutable revision,
 * exact size and final SHA-256 are the authority.
 */
export class LocalAsrDirectDownloader {
  readonly #distribution: LocalAsrDirectModelDistribution;
  readonly #requestGet: ModelHttpsGet;
  readonly #idleTimeoutMilliseconds: number;
  readonly #retryDelayMilliseconds: NonNullable<
    LocalAsrDirectDownloaderOptions['retryDelayMilliseconds']
  >;

  constructor(options: LocalAsrDirectDownloaderOptions = {}) {
    this.#distribution = options.distribution ?? LOCAL_ASR_DIRECT_DISTRIBUTION;
    try {
      assertValidLocalAsrDirectDistribution(this.#distribution);
    } catch (error) {
      throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DISTRIBUTION_INVALID', error);
    }
    this.#requestGet = options.requestGet ?? https.get;
    this.#idleTimeoutMilliseconds = options.idleTimeoutMilliseconds
      ?? DOWNLOAD_IDLE_TIMEOUT_MILLISECONDS;
    this.#retryDelayMilliseconds = options.retryDelayMilliseconds
      ?? ((attempt, retryAfterMilliseconds) => calculateDirectRetryDelayMilliseconds(
        attempt,
        retryAfterMilliseconds,
      ));
    if (
      !Number.isSafeInteger(this.#idleTimeoutMilliseconds)
      || this.#idleTimeoutMilliseconds <= 0
    ) throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DISTRIBUTION_INVALID');
  }

  async inspectCheckpoint(checkpointDirectory: string): Promise<LocalAsrDirectCheckpointStatus> {
    const checkpoint = path.resolve(checkpointDirectory);
    assertSafeCheckpointDirectoryPath(checkpoint);
    const metadata = await lstatOrNull(checkpoint);
    const expectedBytes = distributionByteLength(this.#distribution);
    if (!metadata) return { downloadedBytes: 0, expectedBytes, complete: false };
    await validateCheckpointDirectory(checkpoint, metadata);
    await readAndValidateCheckpointManifest(checkpoint, this.#distribution);
    const states = await inspectAllSegments(checkpoint, this.#distribution);
    const downloadedBytes = states.reduce((sum, state) => sum + state.downloadedBytes, 0);
    return { downloadedBytes, expectedBytes, complete: downloadedBytes === expectedBytes };
  }

  async download(input: LocalAsrDirectDownloadInput): Promise<LocalAsrDirectDownloadResult> {
    getLocalAsrDirectSourceDescriptor(this.#distribution, input.source);
    let resolvedSource = input.source;
    let mirrorMigrationReported = false;
    const transferInput: LocalAsrDirectDownloadInput = {
      ...input,
      onDiagnostic: (event, fields) => {
        if (event === 'direct-mirror-entry-migrated') {
          resolvedSource = 'huggingface_official';
          if (mirrorMigrationReported) return;
          mirrorMigrationReported = true;
        }
        input.onDiagnostic?.(event, fields);
      },
    };
    throwIfAborted(input.signal);
    const checkpointDirectory = path.resolve(input.checkpointDirectory);
    const destinationDirectory = path.resolve(input.destinationDirectory);
    assertSafeCheckpointDirectoryPath(checkpointDirectory);
    if (
      checkpointDirectory === destinationDirectory
      || destinationDirectory.startsWith(`${checkpointDirectory}${path.sep}`)
      || checkpointDirectory.startsWith(`${destinationDirectory}${path.sep}`)
    ) {
      throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DESTINATION_INVALID');
    }

    await prepareDestinationDirectory(destinationDirectory, this.#distribution);
    const checkpointWasDiscarded = await prepareCheckpointDirectory(
      checkpointDirectory,
      this.#distribution,
    );
    if (checkpointWasDiscarded) {
      emitDiagnostic(input, 'direct-checkpoint-discarded', {
        reasonCode: 'ASR_MODEL_DIRECT_CHECKPOINT_INVALID',
      });
    }
    throwIfAborted(input.signal);

    let states = await inspectAllSegments(checkpointDirectory, this.#distribution);
    const progressBySegment = new Map(
      states.map((state) => [state.segment.key, state.downloadedBytes]),
    );
    const fileProgress = new Map<LocalAsrModelFileName, number>();
    for (const state of states) {
      fileProgress.set(
        state.segment.file.name,
        (fileProgress.get(state.segment.file.name) ?? 0) + state.downloadedBytes,
      );
    }
    const expectedBytes = distributionByteLength(this.#distribution);
    let aggregateProgress = [...progressBySegment.values()].reduce((sum, bytes) => sum + bytes, 0);
    reportProgress(input, {
      source: input.source,
      downloadedBytes: aggregateProgress,
      expectedBytes,
      fileName: null,
      segmentIndex: null,
      fileDownloadedBytes: null,
    });

    const updateProgress = (
      segment: SegmentDescriptor,
      downloadedBytes: number,
    ): void => {
      const previous = progressBySegment.get(segment.key) ?? 0;
      const bounded = Math.min(segment.byteLength, Math.max(0, downloadedBytes));
      if (bounded === previous) return;
      const delta = bounded - previous;
      progressBySegment.set(segment.key, bounded);
      aggregateProgress += delta;
      const nextFileProgress = (fileProgress.get(segment.file.name) ?? 0) + delta;
      fileProgress.set(segment.file.name, nextFileProgress);
      reportProgress(input, {
        source: input.source,
        downloadedBytes: aggregateProgress,
        expectedBytes,
        fileName: segment.file.name,
        segmentIndex: segment.index,
        fileDownloadedBytes: nextFileProgress,
      });
    };

    const pending = interleavePendingSegments(states);
    if (pending.length === 0) {
      // A completed checkpoint is deliberately source-agnostic and no new
      // network hop can establish mirror provenance. Attribute the frozen,
      // hash-verified distribution to its authoritative official source rather
      // than producing an inaccurate accelerated receipt after restart.
      resolvedSource = 'huggingface_official';
    }
    if (pending.length > 0) {
      emitDiagnostic(input, 'direct-download-started', {
        source: input.source,
        downloadedBytes: aggregateProgress,
        expectedBytes,
        pendingSegmentCount: pending.length,
        concurrency: this.#distribution.globalConcurrency,
      });
      await this.#downloadPendingSegments(transferInput, pending, updateProgress);
    }
    throwIfAborted(input.signal);

    states = await inspectAllSegments(checkpointDirectory, this.#distribution);
    aggregateProgress = states.reduce((sum, state) => sum + state.downloadedBytes, 0);
    if (aggregateProgress !== expectedBytes) {
      throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID');
    }

    const writtenFiles: string[] = [];
    try {
      for (const file of this.#distribution.files) {
        throwIfAborted(input.signal);
        const destinationPath = path.join(destinationDirectory, file.name);
        await assembleAndVerifyFile(
          checkpointDirectory,
          destinationPath,
          file,
          this.#distribution,
          input.signal,
        );
        writtenFiles.push(destinationPath);
        emitDiagnostic(input, 'direct-file-verified', {
          source: input.source,
          fileName: file.name,
          byteLength: file.byteLength,
          sha256Verified: true,
        });
      }
    } catch (error) {
      await Promise.all(writtenFiles.map((filePath) => rm(filePath, { force: true })));
      throw error;
    }

    reportProgress(input, {
      source: input.source,
      downloadedBytes: expectedBytes,
      expectedBytes,
      fileName: null,
      segmentIndex: null,
      fileDownloadedBytes: null,
    });
    emitDiagnostic(input, 'direct-download-completed', {
      source: resolvedSource,
      downloadedBytes: expectedBytes,
      expectedBytes,
      fileCount: this.#distribution.files.length,
    });
    return {
      source: input.source,
      resolvedSource,
      revision: this.#distribution.revision,
      downloadedBytes: expectedBytes,
      expectedBytes,
      files: this.#distribution.files.map((file) => ({ ...file })),
    };
  }

  async #downloadPendingSegments(
    input: LocalAsrDirectDownloadInput,
    pending: readonly SegmentState[],
    onProgress: (segment: SegmentDescriptor, downloadedBytes: number) => void,
  ): Promise<void> {
    const batchController = new AbortController();
    const abortFromParent = () => batchController.abort(input.signal.reason);
    input.signal.addEventListener('abort', abortFromParent, { once: true });
    let nextIndex = 0;
    let firstError: unknown = null;
    const workerCount = Math.min(this.#distribution.globalConcurrency, pending.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (!batchController.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const state = pending[index];
        if (!state) return;
        try {
          await this.#downloadSegment(input, state.segment, batchController.signal, onProgress);
        } catch (error) {
          if (firstError === null) firstError = error;
          if (!batchController.signal.aborted) batchController.abort(error);
          throw error;
        }
      }
      throwIfAborted(batchController.signal);
    });
    const outcomes = await Promise.allSettled(workers);
    input.signal.removeEventListener('abort', abortFromParent);
    emitDiagnostic(input, 'direct-download-workers-settled', {
      source: input.source,
      workerCount,
      rejectedWorkerCount: outcomes.filter((outcome) => outcome.status === 'rejected').length,
    });
    if (input.signal.aborted) throwIfAborted(input.signal);
    if (firstError !== null) throw firstError;
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  }

  async #downloadSegment(
    input: LocalAsrDirectDownloadInput,
    segment: SegmentDescriptor,
    signal: AbortSignal,
    onProgress: (segment: SegmentDescriptor, downloadedBytes: number) => void,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAXIMUM_DOWNLOAD_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      let metadata = await inspectSegmentFile(segment);
      if (
        segment.file.remoteKind === 'git_blob'
        && metadata.size > 0
        && metadata.size < segment.byteLength
      ) {
        // The small git blob CDN may legally ignore Range and return a
        // chunked 200. A partial blob is therefore never resumed from a
        // non-zero offset; restart its single segment from byte zero.
        await rm(segment.checkpointPath, { force: true });
        onProgress(segment, 0);
        metadata = { size: 0 };
      }
      if (metadata.size === segment.byteLength) return;
      emitDiagnostic(input, 'direct-segment-attempt-started', {
        source: input.source,
        fileName: segment.file.name,
        segmentIndex: segment.index,
        attempt,
        resumeBytes: metadata.size,
        segmentBytes: segment.byteLength,
      });
      try {
        await this.#downloadSegmentAttempt(
          input,
          segment,
          metadata.size,
          signal,
          (downloadedBytes) => onProgress(segment, downloadedBytes),
        );
        return;
      } catch (error) {
        if (signal.aborted) throwIfAborted(signal);
        const normalized = normalizeDirectError(error, 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED');
        if (normalized.code === 'ASR_MODEL_DIRECT_RANGE_REJECTED') {
          // Protocol-invalid bytes are never a resumable checkpoint. In
          // particular, an overlong body may already have filled the segment
          // before the Transform rejects the trailing bytes.
          await rm(segment.checkpointPath, { force: true });
          onProgress(segment, 0);
        } else {
          const durable = await inspectSegmentFile(segment);
          onProgress(segment, durable.size);
        }
        emitDiagnostic(input, 'direct-segment-attempt-failed', {
          source: input.source,
          fileName: segment.file.name,
          segmentIndex: segment.index,
          attempt,
          errorCode: normalized.code,
          httpStatusCode: normalized.httpStatusCode,
        });
        if (
          normalized.code !== 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED'
          || attempt === MAXIMUM_DOWNLOAD_ATTEMPTS
        ) throw normalized;
        const delayMilliseconds = this.#retryDelayMilliseconds(
          attempt,
          normalized.retryAfterMilliseconds,
        );
        if (!Number.isSafeInteger(delayMilliseconds) || delayMilliseconds < 0) {
          throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DISTRIBUTION_INVALID');
        }
        emitDiagnostic(input, 'direct-segment-retry-scheduled', {
          source: input.source,
          fileName: segment.file.name,
          segmentIndex: segment.index,
          attempt,
          nextAttempt: attempt + 1,
          delayMilliseconds,
          retryAfterMilliseconds: normalized.retryAfterMilliseconds,
          httpStatusCode: normalized.httpStatusCode,
        });
        await waitForRetry(delayMilliseconds, signal);
      }
    }
  }

  async #downloadSegmentAttempt(
    input: LocalAsrDirectDownloadInput,
    segment: SegmentDescriptor,
    resumeBytes: number,
    signal: AbortSignal,
    onProgress: (downloadedBytes: number) => void,
  ): Promise<void> {
    const requestStart = segment.start + resumeBytes;
    const requestEnd = segment.end;
    const expectedResponseBytes = requestEnd - requestStart + 1;
    const initialUrl = localAsrDirectFileUrl(
      this.#distribution,
      input.source,
      segment.file.name,
    );

    const request = async (
      rawUrl: string,
      redirectDepth: number,
      redirectTrust: {
        readonly sawRedirect: boolean;
        readonly pinnedMetadataValidated: boolean;
      },
    ): Promise<void> => {
      if (redirectDepth > MAXIMUM_REDIRECTS) {
        throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
      }
      const url = assertTrustedLocalAsrDirectDownloadUrl({
        rawUrl,
        initialUrl,
        redirectDepth,
      });
      const responseLease = await requestDirectResponse({
        requestGet: this.#requestGet,
        idleTimeoutMilliseconds: this.#idleTimeoutMilliseconds,
        signal,
        url,
        headers: {
          Accept: 'application/octet-stream',
          'Accept-Encoding': 'identity',
          Range: `bytes=${requestStart}-${requestEnd}`,
          'User-Agent': 'Phrio-local-model-direct-installer/0.1',
        },
      });
      const { response } = responseLease;
      try {
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400) {
          const location = singleHeader(response.headers.location);
          const linkedSize = singleHeader(response.headers['x-linked-size']);
          const linkedEtag = singleHeader(response.headers['x-linked-etag']);
          await disposeResponse(response);
          if (!location) {
            throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
          }
          let target: URL;
          try {
            target = assertTrustedLocalAsrDirectDownloadUrl({
              rawUrl: new URL(location, url).href,
              initialUrl,
              redirectDepth: redirectDepth + 1,
            });
          } catch (error) {
            if (error instanceof LocalAsrDirectDownloadError) throw error;
            throw new LocalAsrDirectDownloadError(
              'ASR_MODEL_DIRECT_REDIRECT_REJECTED',
              error,
            );
          }
          const mirrorEntryMigration = isExactMirrorToOfficialEntryTransition({
            current: url,
            target,
            initialUrl,
          });
          if (mirrorEntryMigration) {
            emitDiagnostic(input, 'direct-mirror-entry-migrated', {
              source: 'huggingface_official',
              reasonCode: 'MIRROR_ENTRY_MIGRATED_TO_OFFICIAL',
            });
          }
          let pinnedMetadataValidated = redirectTrust.pinnedMetadataValidated;
          if (isTrustedDirectEntryUrl(url, initialUrl)) {
            if (!mirrorEntryMigration) {
              assertPinnedRedirectMetadata(linkedSize, linkedEtag, segment.file);
              pinnedMetadataValidated = true;
            }
          } else if (!pinnedMetadataValidated) {
            throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
          }
          await request(target.href, redirectDepth + 1, {
            sawRedirect: true,
            pinnedMetadataValidated,
          });
          return;
        }

        if (isRetryableDirectHttpStatus(statusCode)) {
          const retryAfterMilliseconds = parseRetryAfterMilliseconds(
            singleHeader(response.headers['retry-after']),
          );
          await disposeResponse(response);
          throw new LocalAsrDirectDownloadError(
            'ASR_MODEL_DIRECT_DOWNLOAD_FAILED',
            undefined,
            { httpStatusCode: statusCode, retryAfterMilliseconds },
          );
        }

        const contentLengthHeader = singleHeader(response.headers['content-length']);
        const contentLength = contentLengthHeader === null
          ? null
          : Number(contentLengthHeader);
        const contentRange = singleHeader(response.headers['content-range']);
        const expectedContentRange =
          `bytes ${requestStart}-${requestEnd}/${segment.file.byteLength}`;
        const strictRangeResponse =
          statusCode === 206
          && Number.isSafeInteger(contentLength)
          && contentLength === expectedResponseBytes
          && contentRange === expectedContentRange;
        const completeGitBlobResponse =
          segment.file.remoteKind === 'git_blob'
          && requestStart === 0
          && requestEnd === segment.file.byteLength - 1
          && statusCode === 200
          && contentRange === null
          && (contentLength === null || contentLength === expectedResponseBytes);
        if (
          (strictRangeResponse || completeGitBlobResponse)
          && redirectTrust.sawRedirect
          && !redirectTrust.pinnedMetadataValidated
        ) {
          await disposeResponse(response);
          throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
        }
        if (
          (!strictRangeResponse && !completeGitBlobResponse)
          || response.headers['content-encoding'] !== undefined
        ) {
          emitDiagnostic(input, 'direct-range-rejected', {
            source: input.source,
            fileName: segment.file.name,
            segmentIndex: segment.index,
            statusCode,
            contentLength:
              contentLength !== null && Number.isFinite(contentLength) ? contentLength : -1,
            expectedContentLength: expectedResponseBytes,
            contentRange: contentRange ?? 'missing',
            expectedContentRange,
            contentEncodingPresent: response.headers['content-encoding'] !== undefined,
          });
          await disposeResponse(response);
          throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_RANGE_REJECTED');
        }

        let receivedBytes = 0;
        const byteGate = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            responseLease.touch();
            receivedBytes += chunk.byteLength;
            if (receivedBytes > expectedResponseBytes) {
              callback(new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_RANGE_REJECTED'));
              return;
            }
            onProgress(resumeBytes + receivedBytes);
            callback(null, chunk);
          },
        });
        const destination = createWriteStream(segment.checkpointPath, {
          flags: 'a',
          mode: PRIVATE_FILE_MODE,
        });
        try {
          await pipeline(response, byteGate, destination, { signal });
        } catch (error) {
          if (signal.aborted) throwIfAborted(signal);
          throw normalizeDirectError(error, 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED');
        }
        if (receivedBytes !== expectedResponseBytes) {
          throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DOWNLOAD_FAILED');
        }
        const completed = await inspectSegmentFile(segment);
        if (completed.size !== segment.byteLength) {
          throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID');
        }
        await chmod(segment.checkpointPath, PRIVATE_FILE_MODE);
      } finally {
        responseLease.dispose();
      }
    };

    await request(initialUrl, 0, {
      sawRedirect: false,
      pinnedMetadataValidated: false,
    });
  }
}

export async function removeLocalAsrDirectCheckpoint(
  checkpointDirectory: string,
): Promise<void> {
  const resolved = path.resolve(checkpointDirectory);
  assertSafeCheckpointDirectoryPath(resolved);
  await rm(resolved, { recursive: true, force: true });
}

export function assertTrustedLocalAsrDirectDownloadUrl(input: {
  readonly rawUrl: string;
  readonly initialUrl: string;
  readonly redirectDepth: number;
}): URL {
  let url: URL;
  try {
    url = new URL(input.rawUrl);
  } catch (error) {
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_REDIRECT_REJECTED', error);
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || (url.port !== '' && url.port !== '443')
    || url.hash !== ''
    || url.search.length > MAXIMUM_SIGNED_QUERY_BYTES
  ) throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');

  if (input.redirectDepth === 0) {
    if (url.href !== input.initialUrl) {
      throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
    }
    return url;
  }

  const encodedTraversal = /%2f|%5c|%2e/iu.test(url.pathname);
  const containsTraversal = url.pathname.includes('..') || url.pathname.includes('\\');
  const hasObjectIdentity = /(?:^|\/)[a-f0-9]{64}(?:$|\/)/u.test(url.pathname);
  const casPath = /^\/xet-bridge-[a-z0-9-]+\/[a-f0-9]{24}\/[a-f0-9]{64}$/u
    .test(url.pathname);
  const initial = new URL(input.initialUrl);
  const officialMirrorEntry = exactOfficialEntryForMirror(initial);
  const exactMirrorEntryMigration =
    input.redirectDepth === 1
    && officialMirrorEntry !== null
    && url.href === officialMirrorEntry.href;
  const sameHostResolveCachePath = expectedResolveCachePath(initial);
  const trustedHostAndPath =
    exactMirrorEntryMigration
    || (url.hostname === 'cas-bridge.xethub.hf.co' && casPath)
    || (
      url.hostname === 'us.aws.cdn.hf.co'
      && url.pathname.length <= 4_096
      && hasObjectIdentity
    )
    || (
      (
        url.hostname === initial.hostname
        || (officialMirrorEntry !== null && url.hostname === officialMirrorEntry.hostname)
      )
      && sameHostResolveCachePath !== null
      && url.pathname === sameHostResolveCachePath
    );
  if (encodedTraversal || containsTraversal || !trustedHostAndPath) {
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
  }
  return url;
}

function exactOfficialEntryForMirror(initial: URL): URL | null {
  if (initial.hostname !== 'hf-mirror.com') return null;
  const official = new URL(initial.href);
  official.hostname = 'huggingface.co';
  return official;
}

function isTrustedDirectEntryUrl(current: URL, initialUrl: string): boolean {
  const initial = new URL(initialUrl);
  if (current.href === initial.href) return true;
  return current.href === exactOfficialEntryForMirror(initial)?.href;
}

function isExactMirrorToOfficialEntryTransition(input: {
  readonly current: URL;
  readonly target: URL;
  readonly initialUrl: string;
}): boolean {
  const initial = new URL(input.initialUrl);
  const official = exactOfficialEntryForMirror(initial);
  return official !== null
    && input.current.href === initial.href
    && input.target.href === official.href;
}

async function prepareCheckpointDirectory(
  checkpointDirectory: string,
  distribution: LocalAsrDirectModelDistribution,
): Promise<boolean> {
  const existing = await lstatOrNull(checkpointDirectory);
  if (!existing) {
    await createCheckpointDirectory(checkpointDirectory, distribution);
    return false;
  }
  await validateCheckpointDirectory(checkpointDirectory, existing);
  try {
    await readAndValidateCheckpointManifest(checkpointDirectory, distribution);
    await inspectAllSegments(checkpointDirectory, distribution);
    return false;
  } catch (error) {
    if (!isDirectError(error, 'ASR_MODEL_DIRECT_CHECKPOINT_INVALID')) throw error;
    await rm(checkpointDirectory, { recursive: true, force: true });
    await createCheckpointDirectory(checkpointDirectory, distribution);
    return true;
  }
}

async function createCheckpointDirectory(
  checkpointDirectory: string,
  distribution: LocalAsrDirectModelDistribution,
): Promise<void> {
  await mkdir(checkpointDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = await lstat(checkpointDirectory);
  await validateCheckpointDirectory(checkpointDirectory, metadata);
  const manifest = createCheckpointManifest(distribution);
  const manifestPath = path.join(checkpointDirectory, DIRECT_CHECKPOINT_MANIFEST);
  const temporaryPath = path.join(
    checkpointDirectory,
    `.${DIRECT_CHECKPOINT_MANIFEST}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest)}\n`, {
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
    await chmod(temporaryPath, PRIVATE_FILE_MODE);
    await rename(temporaryPath, manifestPath);
    await chmod(manifestPath, PRIVATE_FILE_MODE);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function validateCheckpointDirectory(
  checkpointDirectory: string,
  metadata: Stats,
): Promise<void> {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID');
  }
  await chmod(checkpointDirectory, PRIVATE_DIRECTORY_MODE).catch((error) => {
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID', error);
  });
}

function createCheckpointManifest(
  distribution: LocalAsrDirectModelDistribution,
): DirectCheckpointManifest {
  return {
    schemaVersion: DIRECT_CHECKPOINT_SCHEMA_VERSION,
    revision: distribution.revision,
    segmentCount: distribution.segmentCount,
    files: distribution.files.map((file) => ({ ...file })),
  };
}

async function readAndValidateCheckpointManifest(
  checkpointDirectory: string,
  distribution: LocalAsrDirectModelDistribution,
): Promise<DirectCheckpointManifest> {
  const manifestPath = path.join(checkpointDirectory, DIRECT_CHECKPOINT_MANIFEST);
  let metadata: Stats;
  try {
    metadata = await lstat(manifestPath);
  } catch (error) {
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID', error);
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.size < 2
    || metadata.size > DIRECT_CHECKPOINT_MANIFEST_MAXIMUM_BYTES
  ) throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID', error);
  }
  const expected = createCheckpointManifest(distribution);
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID');
  }
  await chmod(manifestPath, PRIVATE_FILE_MODE);
  return expected;
}

async function inspectAllSegments(
  checkpointDirectory: string,
  distribution: LocalAsrDirectModelDistribution,
): Promise<SegmentState[]> {
  const segments = createAllSegments(checkpointDirectory, distribution);
  const allowedEntries = new Set([
    DIRECT_CHECKPOINT_MANIFEST,
    ...segments.map((segment) => path.basename(segment.checkpointPath)),
  ]);
  const entries = await readdir(checkpointDirectory);
  if (entries.some((entry) => !allowedEntries.has(entry))) {
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID');
  }
  return Promise.all(segments.map(async (segment) => ({
    segment,
    downloadedBytes: (await inspectSegmentFile(segment)).size,
  })));
}

function createAllSegments(
  checkpointDirectory: string,
  distribution: LocalAsrDirectModelDistribution,
): SegmentDescriptor[] {
  const segments: SegmentDescriptor[] = [];
  for (const file of distribution.files) {
    const fileSegmentCount = file.remoteKind === 'git_blob'
      ? 1
      : distribution.segmentCount;
    for (let index = 0; index < fileSegmentCount; index += 1) {
      const start = Math.floor((file.byteLength * index) / fileSegmentCount);
      const endExclusive = Math.floor(
        (file.byteLength * (index + 1)) / fileSegmentCount,
      );
      const end = endExclusive - 1;
      segments.push({
        file,
        index,
        start,
        end,
        byteLength: endExclusive - start,
        checkpointPath: path.join(
          checkpointDirectory,
          `${file.name}.segment-${String(index).padStart(2, '0')}.partial`,
        ),
        key: `${file.name}:${index}`,
      });
    }
  }
  return segments;
}

async function inspectSegmentFile(
  segment: SegmentDescriptor,
): Promise<{ readonly size: number }> {
  const metadata = await lstatOrNull(segment.checkpointPath);
  if (!metadata) return { size: 0 };
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.size < 0
    || metadata.size > segment.byteLength
  ) throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID');
  await chmod(segment.checkpointPath, PRIVATE_FILE_MODE);
  return { size: metadata.size };
}

function interleavePendingSegments(states: readonly SegmentState[]): SegmentState[] {
  return [...states]
    .filter((state) => state.downloadedBytes < state.segment.byteLength)
    .sort((left, right) => (
      left.segment.index - right.segment.index
      || left.segment.file.name.localeCompare(right.segment.file.name)
    ));
}

async function prepareDestinationDirectory(
  destinationDirectory: string,
  distribution: LocalAsrDirectModelDistribution,
): Promise<void> {
  await mkdir(destinationDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = await lstat(destinationDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DESTINATION_INVALID');
  }
  await chmod(destinationDirectory, PRIVATE_DIRECTORY_MODE);
  if ((await readdir(destinationDirectory)).length > 0) {
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DESTINATION_INVALID');
  }
  if (distribution.files.some((file) => path.basename(file.name) !== file.name)) {
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DISTRIBUTION_INVALID');
  }
}

async function assembleAndVerifyFile(
  checkpointDirectory: string,
  destinationPath: string,
  file: LocalAsrDirectModelFileDescriptor,
  distribution: LocalAsrDirectModelDistribution,
  signal: AbortSignal,
): Promise<void> {
  const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;
  const segments = createAllSegments(checkpointDirectory, distribution)
    .filter((segment) => segment.file.name === file.name)
    .sort((left, right) => left.index - right.index);
  const hash = createHash('sha256');
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let writtenBytes = 0;
  try {
    handle = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    for (const segment of segments) {
      throwIfAborted(signal);
      const metadata = await inspectSegmentFile(segment);
      if (metadata.size !== segment.byteLength) {
        throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID');
      }
      for await (const chunk of createReadStream(segment.checkpointPath)) {
        throwIfAborted(signal);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const { bytesWritten } = await handle.write(
            bytes,
            offset,
            bytes.byteLength - offset,
            null,
          );
          if (bytesWritten <= 0) {
            throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DESTINATION_INVALID');
          }
          offset += bytesWritten;
          writtenBytes += bytesWritten;
        }
      }
    }
    const sha256 = hash.digest('hex');
    if (writtenBytes !== file.byteLength || sha256 !== file.sha256) {
      await removeFileSegments(checkpointDirectory, file.name, distribution);
      throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_INTEGRITY_MISMATCH');
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporaryPath, PRIVATE_FILE_MODE);
    await rename(temporaryPath, destinationPath);
    const promoted = await stat(destinationPath);
    if (!promoted.isFile() || promoted.size !== file.byteLength) {
      throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DESTINATION_INVALID');
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await rm(destinationPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeFileSegments(
  checkpointDirectory: string,
  fileName: LocalAsrModelFileName,
  distribution: LocalAsrDirectModelDistribution,
): Promise<void> {
  const segments = createAllSegments(checkpointDirectory, distribution)
    .filter((segment) => segment.file.name === fileName);
  await Promise.all(segments.map((segment) => rm(segment.checkpointPath, { force: true })));
}

function assertPinnedRedirectMetadata(
  linkedSizeHeader: string | null,
  linkedEtagHeader: string | null,
  file: LocalAsrDirectModelFileDescriptor,
): void {
  const linkedSize = Number(linkedSizeHeader);
  if (file.remoteKind === 'lfs') {
    const linkedEtag = normalizeQuotedSha256(linkedEtagHeader);
    if (linkedSize === file.byteLength && linkedEtag === file.sha256) return;
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
  }
  const gitBlobEtag = normalizeQuotedGitBlob(linkedEtagHeader);
  const linkedSizeAcceptable = linkedSizeHeader === null || linkedSize === file.byteLength;
  if (!linkedSizeAcceptable || gitBlobEtag === null) {
    throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
  }
}

function normalizeQuotedSha256(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function normalizeQuotedGitBlob(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
  return /^[a-f0-9]{40}$/u.test(normalized) ? normalized : null;
}

function expectedResolveCachePath(initialUrl: URL): string | null {
  const match = /^\/(.+)\/resolve\/([a-f0-9]{40})\/([^/]+)$/u.exec(initialUrl.pathname);
  if (!match) return null;
  const [, repository, revision, fileName] = match;
  if (!repository || !revision || !fileName) return null;
  return `/api/resolve-cache/models/${repository}/${revision}/${fileName}`;
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0];
  return null;
}

async function requestDirectResponse(input: {
  readonly requestGet: ModelHttpsGet;
  readonly idleTimeoutMilliseconds: number;
  readonly signal: AbortSignal;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
}): Promise<ResponseLease> {
  return new Promise((resolve, reject) => {
    let response: IncomingMessage | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let disposed = false;
    let settled = false;
    let request: ClientRequest;
    let abortAttached = false;

    const clearIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearIdleTimer();
      if (abortAttached) input.signal.removeEventListener('abort', onAbort);
    };
    const onIdleTimeout = () => {
      if (disposed) return;
      const error = new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DOWNLOAD_FAILED');
      if (response && !response.destroyed) response.destroy(error);
      request.destroy(error);
    };
    const touch = () => {
      if (disposed) return;
      clearIdleTimer();
      idleTimer = setTimeout(onIdleTimeout, input.idleTimeoutMilliseconds);
      idleTimer.unref();
    };
    const onAbort = () => {
      const reason = abortReason(input.signal);
      if (response && !response.destroyed) response.destroy(reason);
      request.destroy(reason);
    };

    request = input.requestGet(input.url, {
      signal: input.signal,
      headers: input.headers,
    }, (incoming) => {
      response = incoming;
      incoming.once('error', () => undefined);
      incoming.once('aborted', () => {
        if (!incoming.destroyed) {
          incoming.destroy(new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DOWNLOAD_FAILED'));
        }
      });
      touch();
      settled = true;
      resolve({ response: incoming, touch, dispose });
    });
    input.signal.addEventListener('abort', onAbort, { once: true });
    abortAttached = true;
    if (input.signal.aborted) onAbort();
    touch();
    request.once('error', (error) => {
      if (settled) {
        if (response && !response.destroyed) response.destroy(error);
        return;
      }
      dispose();
      reject(
        input.signal.aborted
          ? abortReason(input.signal)
          : new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DOWNLOAD_FAILED', error),
      );
    });
  });
}

async function disposeResponse(response: IncomingMessage): Promise<void> {
  const close = finished(response).catch(() => undefined);
  response.destroy();
  await close;
}

function distributionByteLength(distribution: LocalAsrDirectModelDistribution): number {
  return distribution.files.reduce((sum, file) => sum + file.byteLength, 0);
}

function reportProgress(
  input: LocalAsrDirectDownloadInput,
  progress: LocalAsrDirectDownloadProgress,
): void {
  try {
    input.onProgress(progress);
  } catch {
    // Observability cannot alter transfer semantics.
  }
}

function emitDiagnostic(
  input: LocalAsrDirectDownloadInput,
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  try {
    input.onDiagnostic?.(event, fields);
  } catch {
    // Observability cannot alter transfer semantics.
  }
}

async function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delay);
    const abort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function calculateDirectRetryDelayMilliseconds(
  attempt: number,
  retryAfterMilliseconds: number | null,
  random: () => number = Math.random,
): number {
  const exponentialDelay = Math.min(
    DIRECT_RETRY_AFTER_MAXIMUM_MILLISECONDS,
    DIRECT_RETRY_BASE_DELAY_MILLISECONDS * (2 ** Math.max(0, attempt - 1)),
  );
  const serverDelay = retryAfterMilliseconds === null
    ? 0
    : Math.min(DIRECT_RETRY_AFTER_MAXIMUM_MILLISECONDS, Math.max(0, retryAfterMilliseconds));
  const baseDelay = Math.max(exponentialDelay, serverDelay);
  const randomValue = random();
  const boundedRandom = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0;
  const jitterWindow = Math.min(1_000, Math.max(1, Math.floor(baseDelay * 0.2)));
  return Math.min(
    DIRECT_RETRY_DELAY_MAXIMUM_MILLISECONDS,
    baseDelay + Math.floor(jitterWindow * boundedRandom),
  );
}

function isRetryableDirectHttpStatus(statusCode: number): boolean {
  return statusCode === 408
    || statusCode === 425
    || statusCode === 429
    || (statusCode >= 500 && statusCode <= 599);
}

function parseRetryAfterMilliseconds(value: string | null): number | null {
  if (!value || value.length > 128 || value.includes('\r') || value.includes('\n')) return null;
  if (/^\d{1,9}$/u.test(value)) {
    return Math.min(
      DIRECT_RETRY_AFTER_MAXIMUM_MILLISECONDS,
      Number(value) * 1_000,
    );
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(
    DIRECT_RETRY_AFTER_MAXIMUM_MILLISECONDS,
    Math.max(0, timestamp - Date.now()),
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DOWNLOAD_FAILED');
}

function normalizeDirectError(
  error: unknown,
  fallback: LocalAsrDirectDownloadErrorCode,
): LocalAsrDirectDownloadError {
  return error instanceof LocalAsrDirectDownloadError
    ? error
    : new LocalAsrDirectDownloadError(fallback, error);
}

function isDirectError(
  error: unknown,
  code: LocalAsrDirectDownloadErrorCode,
): error is LocalAsrDirectDownloadError {
  return error instanceof LocalAsrDirectDownloadError && error.code === code;
}

async function lstatOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function nodeErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function assertSafeCheckpointDirectoryPath(checkpointDirectory: string): void {
  const parent = path.dirname(checkpointDirectory);
  if (
    path.basename(checkpointDirectory) !== LOCAL_ASR_DIRECT_CHECKPOINT_DIRECTORY_NAME
    || parent === checkpointDirectory
    || parent === path.parse(checkpointDirectory).root
  ) throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID');
}
