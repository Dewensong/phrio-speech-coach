// @vitest-environment node

import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LOCAL_ASR_MODEL_ARCHIVE_URL,
  LOCAL_ASR_MODEL_ARCHIVE_SHA256,
  LOCAL_ASR_MODEL_INSTALL_REQUIRED_FREE_BYTES,
  LocalAsrModelInstaller,
  LocalAsrModelInstallerError,
  assertTrustedLocalAsrModelDownloadUrl,
  downloadOfficialLocalAsrModelArchive,
  extractOfficialLocalAsrModelArchive,
  type ModelArchiveDownloadInput,
  type ModelArchiveDownloadResult,
  type ModelArchiveExtractionInput,
} from '../../src/backend/services/local-asr-model-installer';
import {
  LOCAL_ASR_INSTALL_MANIFEST_NAME,
  createLocalAsrInstallationManifest,
  writeLocalAsrInstallationManifestAtomic,
} from '../../src/backend/services/local-asr-model-verifier';
import {
  LocalAsrDirectDownloadError,
  type LocalAsrDirectDownloader,
} from '../../src/backend/services/local-asr-direct-download';
import {
  LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
  LOCAL_ASR_DIRECT_MODEL_FILES,
  LOCAL_ASR_MODEL_REVISION,
} from '../../src/backend/services/local-asr-model-distribution';
import type { LocalAsrInstallPowerLease } from '../../src/backend/services/local-asr-install-power-save-blocker';
import {
  LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
  LOCAL_ASR_MODEL_FILE_NAMES,
} from '../../src/shared';

const MODEL_DIRECTORY_NAME = 'sherpa-onnx-streaming-paraformer-bilingual-zh-en';
const CHECKPOINT_DIRECTORY_NAME = '.phrio-asr-download-v1';
const CHECKPOINT_ARCHIVE_NAME = 'model.tar.bz2.partial';
const CHECKPOINT_MANIFEST_NAME = 'manifest.json';
const VALID_MODEL_SIZES = {
  'encoder.int8.onnx': 70 * 1_024 * 1_024,
  'decoder.int8.onnx': 10 * 1_024 * 1_024,
  'tokens.txt': 2_048,
} as const;
const temporaryDirectories: string[] = [];
const runFile = promisify(execFile);

function createPowerLease() {
  return {
    acquire: vi.fn(() => true),
    release: vi.fn<LocalAsrInstallPowerLease['release']>(() => true),
  } satisfies LocalAsrInstallPowerLease;
}

class FakeClientRequest extends EventEmitter {
  setTimeout(_milliseconds?: number, _callback?: () => void): this {
    return this;
  }

  destroy(error?: Error): this {
    if (error) this.emit('error', error);
    return this;
  }
}

class DelayedDestroyResponse extends Readable {
  readonly #onDestroyed: () => void;

  constructor(onDestroyed: () => void) {
    super();
    this.#onDestroyed = onDestroyed;
  }

  override _read(): void {
    // Keep the response open until the simulated request error destroys it.
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    setTimeout(() => {
      this.#onDestroyed();
      callback(error);
    }, 10);
  }
}

function fakeIncomingMessage(
  statusCode: number,
  headers: Readonly<Record<string, string>>,
  chunks: readonly Uint8Array[] = [],
): IncomingMessage {
  const response = Readable.from(chunks) as unknown as IncomingMessage;
  Object.defineProperty(response, 'statusCode', { value: statusCode, configurable: true });
  Object.defineProperty(response, 'headers', { value: headers, configurable: true });
  return response;
}

function checkpointArchivePath(modelDirectory: string): string {
  return path.join(
    path.dirname(modelDirectory),
    CHECKPOINT_DIRECTORY_NAME,
    CHECKPOINT_ARCHIVE_NAME,
  );
}

function checkpointManifestPath(modelDirectory: string): string {
  return path.join(
    path.dirname(modelDirectory),
    CHECKPOINT_DIRECTORY_NAME,
    CHECKPOINT_MANIFEST_NAME,
  );
}

async function waitForRequestCount(
  requests: readonly FakeClientRequest[],
  expectedCount: number,
): Promise<void> {
  for (let index = 0; index < 100 && requests.length < expectedCount; index += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  }
  expect(requests).toHaveLength(expectedCount);
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phrio-model-installer-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 500; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not reached');
}

async function writeSparseFile(filePath: string, byteLength: number): Promise<void> {
  await writeFile(filePath, new Uint8Array([1]), { mode: 0o600 });
  await truncate(filePath, byteLength);
}

async function createValidExtractedModel(input: ModelArchiveExtractionInput): Promise<void> {
  const modelDirectory = path.join(input.stagingDirectory, MODEL_DIRECTORY_NAME);
  await mkdir(modelDirectory, { recursive: true });
  await Promise.all(LOCAL_ASR_MODEL_FILE_NAMES.map((name) =>
    writeSparseFile(path.join(modelDirectory, name), VALID_MODEL_SIZES[name]),
  ));
}

async function createDirectCandidate(destinationDirectory: string): Promise<void> {
  await Promise.all(LOCAL_ASR_DIRECT_MODEL_FILES.map((file) =>
    writeSparseFile(path.join(destinationDirectory, file.name), file.byteLength),
  ));
}

async function fakeExactDownload(
  input: ModelArchiveDownloadInput,
): Promise<ModelArchiveDownloadResult> {
  await writeSparseFile(input.destinationPath, LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH);
  return {
    byteLength: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
    sha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
  };
}

async function seedRetainedCheckpoint(
  modelDirectory: string,
  retainedBytes: number,
): Promise<LocalAsrModelInstaller> {
  const installer = new LocalAsrModelInstaller(modelDirectory, {
    downloadArchive: async (input) => {
      await writeSparseFile(input.destinationPath, retainedBytes);
      input.onProgress(retainedBytes);
      throw new LocalAsrModelInstallerError('ASR_MODEL_DOWNLOAD_FAILED');
    },
    extractArchive: createValidExtractedModel,
  });
  await expect(installer.install()).rejects.toMatchObject({
    code: 'ASR_MODEL_DOWNLOAD_FAILED',
  });
  return installer;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe('LocalAsrModelInstaller', () => {
  it('rejects untrusted mirror fixture bytes without starting the large archive', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const downloadArchive = vi.fn(fakeExactDownload);
    const extractArchive = vi.fn(createValidExtractedModel);
    const diagnostics = { record: vi.fn() };
    const directDownloader = {
      inspectCheckpoint: vi.fn(async () => ({
        downloadedBytes: 0,
        expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
        complete: false,
      })),
      download: vi.fn(async (input) => {
        await createDirectCandidate(input.destinationDirectory);
        input.onProgress({
          source: input.source,
          downloadedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
          expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
          fileName: null,
          segmentIndex: null,
          fileDownloadedBytes: null,
        });
        return {
          source: input.source,
          resolvedSource: input.source,
          revision: LOCAL_ASR_MODEL_REVISION,
          downloadedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
          expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
          files: LOCAL_ASR_DIRECT_MODEL_FILES,
        };
      }),
    } satisfies Pick<LocalAsrDirectDownloader, 'download' | 'inspectCheckpoint'>;
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      directDownloader,
      downloadArchive,
      extractArchive,
      diagnostics,
    });

    await expect(installer.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_DIRECT_INTEGRITY_MISMATCH',
    });
    expect(directDownloader.download).toHaveBeenCalledOnce();
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(extractArchive).not.toHaveBeenCalled();
    expect(installer.getStatus()).toMatchObject({
      stage: 'failed',
      source: 'accelerated_direct',
      expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
      errorCode: 'ASR_MODEL_DIRECT_INTEGRITY_MISMATCH',
    });
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.install-started',
      fields: { expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH },
    }));
  });

  it('relabels an exact mirror migration as official while the download remains active', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const diagnostics = { record: vi.fn() };
    let markMigrated!: () => void;
    const migrated = new Promise<void>((resolve) => {
      markMigrated = resolve;
    });
    const directDownloader = {
      inspectCheckpoint: vi.fn(async () => ({
        downloadedBytes: 0,
        expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
        complete: false,
      })),
      download: vi.fn(async (input) => {
        input.onDiagnostic?.('direct-mirror-entry-migrated', {
          source: 'huggingface_official',
          reasonCode: 'MIRROR_ENTRY_MIGRATED_TO_OFFICIAL',
        });
        markMigrated();
        return new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      }),
    } satisfies Pick<LocalAsrDirectDownloader, 'download' | 'inspectCheckpoint'>;
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      directDownloader,
      downloadArchive: vi.fn(fakeExactDownload),
      extractArchive: vi.fn(createValidExtractedModel),
      diagnostics,
    });

    const installation = installer.install();
    await migrated;
    expect(installer.getStatus()).toMatchObject({
      stage: 'downloading',
      source: 'huggingface_direct',
    });
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.direct-mirror-entry-migrated',
    }));
    expect(installer.cancel()).toBe(true);
    await expect(installation).rejects.toMatchObject({ code: 'ASR_MODEL_INSTALL_CANCELLED' });
  });

  it('uses a retained GitHub checkpoint only after the official direct source rejects ranges', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const retainedBytes = 32 * 1_024 * 1_024;
    await seedRetainedCheckpoint(modelDirectory, retainedBytes);
    const directDownloader = {
      inspectCheckpoint: vi.fn(async () => ({
        downloadedBytes: 0,
        expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
        complete: false,
      })),
      download: vi.fn(async () => {
        throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_RANGE_REJECTED');
      }),
    } satisfies Pick<LocalAsrDirectDownloader, 'download' | 'inspectCheckpoint'>;
    const downloadArchive = vi.fn(async (input: ModelArchiveDownloadInput) => {
      expect(input.resumeFromBytes).toBe(retainedBytes);
      await writeSparseFile(input.destinationPath, LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH);
      input.onProgress(LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH);
      return {
        byteLength: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
        sha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
      };
    });
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      directDownloader,
      downloadArchive,
      extractArchive: createValidExtractedModel,
      getAvailableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
    });

    await expect(installer.install()).resolves.toMatchObject({
      outcome: 'installed',
      sourceUsed: 'github_release_archive',
      downloadedArchiveBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
    });
    expect(directDownloader.download).toHaveBeenCalledTimes(2);
    expect(downloadArchive).toHaveBeenCalledOnce();
    expect(installer.getStatus()).toMatchObject({
      source: 'github_release_archive',
      lastRecoverableErrorCode: 'ASR_MODEL_DIRECT_RANGE_REJECTED',
    });
  });

  it('attributes archive preflight failures to the archive after direct fallback begins', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const directDownloader = {
      inspectCheckpoint: vi.fn(async () => ({
        downloadedBytes: 0,
        expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
        complete: false,
      })),
      download: vi.fn(async () => {
        throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_RANGE_REJECTED');
      }),
    } satisfies Pick<LocalAsrDirectDownloader, 'download' | 'inspectCheckpoint'>;
    const downloadArchive = vi.fn(fakeExactDownload);
    let diskCheckCount = 0;
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      directDownloader,
      downloadArchive,
      extractArchive: createValidExtractedModel,
      getAvailableDiskBytes: async () => diskCheckCount++ === 0
        ? Number.MAX_SAFE_INTEGER
        : 0,
    });

    await expect(installer.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_INSUFFICIENT_DISK',
    });
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(installer.getStatus()).toMatchObject({
      stage: 'failed',
      source: 'github_release_archive',
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      lastRecoverableErrorCode: 'ASR_MODEL_DIRECT_RANGE_REJECTED',
      errorCode: 'ASR_MODEL_INSUFFICIENT_DISK',
    });
  });

  it('retains the 226 MiB checkpoint and suppresses the archive after transient official failure', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const retainedDirectBytes = 55 * 1_024 * 1_024;
    const diagnostics = { record: vi.fn() };
    const directDownloader = {
      inspectCheckpoint: vi.fn(async () => ({
        downloadedBytes: retainedDirectBytes,
        expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
        complete: false,
      })),
      download: vi.fn(async (input) => {
        if (input.source === 'hf_mirror_acceleration') {
          throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_REDIRECT_REJECTED');
        }
        throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DOWNLOAD_FAILED');
      }),
    } satisfies Pick<LocalAsrDirectDownloader, 'download' | 'inspectCheckpoint'>;
    const downloadArchive = vi.fn(fakeExactDownload);
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      directDownloader,
      downloadArchive,
      extractArchive: createValidExtractedModel,
      diagnostics,
      getAvailableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
    });

    await expect(installer.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED',
    });
    expect(directDownloader.download).toHaveBeenCalledTimes(2);
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(installer.getStatus()).toMatchObject({
      stage: 'failed',
      source: 'huggingface_direct',
      downloadedBytes: retainedDirectBytes,
      expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
      lastRecoverableErrorCode: 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED',
      errorCode: 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED',
    });
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.direct-retry-required',
      fields: expect.objectContaining({
        reasonCode: 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED',
        archiveFallbackSuppressed: true,
        checkpointRetained: true,
        downloadedBytes: retainedDirectBytes,
      }),
    }));
  });

  it('cleans one invalid direct checkpoint and retries the same small-file source once', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const sourceAttempts: string[] = [];
    let mirrorAttempt = 0;
    const directDownloader = {
      inspectCheckpoint: vi.fn(async () => ({
        downloadedBytes: 0,
        expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
        complete: false,
      })),
      download: vi.fn(async (input) => {
        sourceAttempts.push(input.source);
        if (input.source === 'hf_mirror_acceleration' && mirrorAttempt++ === 0) {
          throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID');
        }
        throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DOWNLOAD_FAILED');
      }),
    } satisfies Pick<LocalAsrDirectDownloader, 'download' | 'inspectCheckpoint'>;
    const downloadArchive = vi.fn(fakeExactDownload);
    const diagnostics = { record: vi.fn() };
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      directDownloader,
      downloadArchive,
      extractArchive: createValidExtractedModel,
      diagnostics,
      getAvailableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
    });

    await expect(installer.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED',
    });
    expect(sourceAttempts).toEqual([
      'hf_mirror_acceleration',
      'hf_mirror_acceleration',
      'huggingface_official',
    ]);
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.direct-checkpoint-reset-before-retry',
    }));
  });

  it('repairs an invalid direct checkpoint discovered before disk preflight', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    let inspectionCount = 0;
    let markDirectStarted!: () => void;
    const directStarted = new Promise<void>((resolve) => {
      markDirectStarted = resolve;
    });
    const directDownloader = {
      inspectCheckpoint: vi.fn(async () => {
        if (inspectionCount++ === 0) {
          throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_CHECKPOINT_INVALID');
        }
        return {
          downloadedBytes: 0,
          expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
          complete: false,
        };
      }),
      download: vi.fn(async (input) => {
        markDirectStarted();
        return new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      }),
    } satisfies Pick<LocalAsrDirectDownloader, 'download' | 'inspectCheckpoint'>;
    const downloadArchive = vi.fn(fakeExactDownload);
    const diagnostics = { record: vi.fn() };
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      directDownloader,
      downloadArchive,
      extractArchive: createValidExtractedModel,
      diagnostics,
      getAvailableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
    });

    const installation = installer.install();
    await directStarted;
    expect(directDownloader.download).toHaveBeenCalledWith(expect.objectContaining({
      source: 'hf_mirror_acceleration',
    }));
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.direct-checkpoint-reset-before-retry',
    }));
    expect(installer.cancel()).toBe(true);
    await expect(installation).rejects.toMatchObject({ code: 'ASR_MODEL_INSTALL_CANCELLED' });
  });

  it('resets restored archive progress to the direct route when a new install starts', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const retainedBytes = 8 * 1_024 * 1_024;
    await seedRetainedCheckpoint(modelDirectory, retainedBytes);
    let markDirectStarted!: () => void;
    const directStarted = new Promise<void>((resolve) => {
      markDirectStarted = resolve;
    });
    const directDownloader = {
      inspectCheckpoint: vi.fn(async () => ({
        downloadedBytes: 0,
        expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
        complete: false,
      })),
      download: vi.fn(async (input) => {
        markDirectStarted();
        return new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      }),
    } satisfies Pick<LocalAsrDirectDownloader, 'download' | 'inspectCheckpoint'>;
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      directDownloader,
      downloadArchive: fakeExactDownload,
      extractArchive: createValidExtractedModel,
    });

    await installer.initialize();
    expect(installer.getStatus()).toMatchObject({
      stage: 'paused',
      source: 'github_release_archive',
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
    });
    const installation = installer.install();
    await directStarted;
    expect(installer.getStatus()).toMatchObject({
      stage: 'downloading',
      source: 'accelerated_direct',
      expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
    });
    expect(installer.cancel()).toBe(true);
    await expect(installation).rejects.toMatchObject({ code: 'ASR_MODEL_INSTALL_CANCELLED' });
  });

  it('cleans mirror integrity bytes before trying the official direct source', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const sourceAttempts: string[] = [];
    let officialStartedClean = false;
    const directDownloader = {
      inspectCheckpoint: vi.fn(async (checkpointDirectory: string) => {
        const entries = await readdir(checkpointDirectory).catch(() => []);
        return {
          downloadedBytes: entries.length > 0 ? 1 : 0,
          expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
          complete: false,
        };
      }),
      download: vi.fn(async (input) => {
        sourceAttempts.push(input.source);
        if (input.source === 'hf_mirror_acceleration') {
          await mkdir(input.checkpointDirectory, { recursive: true });
          await writeFile(path.join(input.checkpointDirectory, 'contaminated.segment'), 'x');
          await writeFile(path.join(input.destinationDirectory, 'contaminated.candidate'), 'x');
          throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_INTEGRITY_MISMATCH');
        }
        officialStartedClean =
          (await readdir(input.checkpointDirectory).catch(() => [])).length === 0
          && (await readdir(input.destinationDirectory)).length === 0;
        throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DOWNLOAD_FAILED');
      }),
    } satisfies Pick<LocalAsrDirectDownloader, 'download' | 'inspectCheckpoint'>;
    const downloadArchive = vi.fn(fakeExactDownload);
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      directDownloader,
      downloadArchive,
      extractArchive: createValidExtractedModel,
    });

    await expect(installer.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED',
    });
    expect(sourceAttempts).toEqual(['hf_mirror_acceleration', 'huggingface_official']);
    expect(officialStartedClean).toBe(true);
    expect(downloadArchive).not.toHaveBeenCalled();
  });

  it('retries one official integrity mismatch from a second clean checkpoint', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const sourceAttempts: string[] = [];
    let officialCleanStarts = 0;
    const directDownloader = {
      inspectCheckpoint: vi.fn(async (checkpointDirectory: string) => ({
        downloadedBytes: (await readdir(checkpointDirectory).catch(() => [])).length > 0 ? 1 : 0,
        expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
        complete: false,
      })),
      download: vi.fn(async (input) => {
        sourceAttempts.push(input.source);
        if (input.source === 'hf_mirror_acceleration') {
          throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DOWNLOAD_FAILED');
        }
        if (
          (await readdir(input.checkpointDirectory).catch(() => [])).length === 0
          && (await readdir(input.destinationDirectory)).length === 0
        ) officialCleanStarts += 1;
        await mkdir(input.checkpointDirectory, { recursive: true });
        await writeFile(path.join(input.checkpointDirectory, 'wrong.segment'), 'x');
        await writeFile(path.join(input.destinationDirectory, 'wrong.candidate'), 'x');
        throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_INTEGRITY_MISMATCH');
      }),
    } satisfies Pick<LocalAsrDirectDownloader, 'download' | 'inspectCheckpoint'>;
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      directDownloader,
      downloadArchive: fakeExactDownload,
      extractArchive: createValidExtractedModel,
    });

    await expect(installer.install()).resolves.toMatchObject({
      outcome: 'installed',
      sourceUsed: 'github_release_archive',
    });
    expect(sourceAttempts).toEqual([
      'hf_mirror_acceleration',
      'huggingface_official',
      'huggingface_official',
    ]);
    expect(officialCleanStarts).toBe(2);
  });

  it('stages, validates, and promotes the runtime files with an integrity manifest', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(path.join(modelDirectory, 'encoder.int8.onnx'), 'old-partial-model');
    await writeFile(path.join(modelDirectory, 'unrelated.txt'), 'must-not-survive-promotion');
    const diagnostics = { record: vi.fn() };
    const installPowerLease = createPowerLease();
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: fakeExactDownload,
      extractArchive: createValidExtractedModel,
      now: () => new Date('2026-07-20T03:00:00.000Z'),
      diagnostics,
      installPowerLease,
    });

    const installation = installer.install();
    expect(installer.hasActiveInstallation()).toBe(true);
    const result = await installation;

    expect(result).toMatchObject({
      outcome: 'installed',
      downloadedArchiveBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      completedAt: '2026-07-20T03:00:00.000Z',
      localAsr: { ready: true },
    });
    expect(result.installedModelBytes).toBe(
      Object.values(VALID_MODEL_SIZES).reduce((sum, size) => sum + size, 0),
    );
    expect((await readdir(modelDirectory)).sort()).toEqual([
      ...LOCAL_ASR_MODEL_FILE_NAMES,
      LOCAL_ASR_INSTALL_MANIFEST_NAME,
    ].sort());
    for (const name of LOCAL_ASR_MODEL_FILE_NAMES) {
      const metadata = await lstat(path.join(modelDirectory, name));
      expect(metadata.isFile()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.mode & 0o777).toBe(0o600);
    }
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.install-completed',
    }));
    expect(installer.getStatus()).toMatchObject({
      stage: 'completed',
      downloadedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      cancellable: false,
      errorCode: null,
    });
    expect(installer.hasActiveInstallation()).toBe(false);
    expect(installPowerLease.acquire).toHaveBeenCalledOnce();
    expect(installPowerLease.release).toHaveBeenCalledExactlyOnceWith('completed');
  });

  it('keeps a runtime-probe failure failed even when its archive checkpoint is recoverable', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: fakeExactDownload,
      extractArchive: createValidExtractedModel,
      verifyCandidateRuntime: async () => false,
    });

    await expect(installer.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_RUNTIME_INIT_FAILED',
    });
    expect(installer.getStatus()).toMatchObject({
      stage: 'failed',
      errorCode: 'ASR_MODEL_RUNTIME_INIT_FAILED',
      downloadedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
    });
    await expect(lstat(checkpointArchivePath(modelDirectory))).resolves.toMatchObject({
      size: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
    });
    await expect(lstat(modelDirectory)).rejects.toThrow();
  });

  it('cancels an archive install while its runtime probe is still pending and never promotes', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    const installPowerLease = createPowerLease();
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: fakeExactDownload,
      extractArchive: createValidExtractedModel,
      verifyCandidateRuntime: async () => {
        markProbeStarted();
        return new Promise<boolean>(() => undefined);
      },
      installPowerLease,
    });

    const installation = installer.install();
    const concurrentInstallation = installer.install();
    expect(concurrentInstallation).toBe(installation);
    expect(installer.hasActiveInstallation()).toBe(true);
    expect(installPowerLease.acquire).toHaveBeenCalledOnce();
    await probeStarted;
    expect(installer.getStatus()).toMatchObject({ stage: 'verifying', cancellable: true });
    expect(installer.cancel()).toBe(true);
    await expect(installation).rejects.toMatchObject({ code: 'ASR_MODEL_INSTALL_CANCELLED' });
    expect(installer.hasActiveInstallation()).toBe(false);
    expect(installPowerLease.release).toHaveBeenCalledExactlyOnceWith('cancelled');
    expect(installer.getStatus()).toMatchObject({
      stage: 'cancelled',
      errorCode: 'ASR_MODEL_INSTALL_CANCELLED',
    });
    await expect(lstat(modelDirectory)).rejects.toThrow();
    await expect(lstat(checkpointArchivePath(modelDirectory))).rejects.toThrow();
  });

  it('pauses a direct install during receipt hashing and never enters promotion', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const downloadArchive = vi.fn(fakeExactDownload);
    const directDownloader = {
      inspectCheckpoint: vi.fn(async () => ({
        downloadedBytes: 0,
        expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
        complete: false,
      })),
      download: vi.fn(async (input) => {
        await createDirectCandidate(input.destinationDirectory);
        return {
          source: input.source,
          resolvedSource: input.source,
          revision: LOCAL_ASR_MODEL_REVISION,
          downloadedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
          expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
          files: LOCAL_ASR_DIRECT_MODEL_FILES,
        };
      }),
    } satisfies Pick<LocalAsrDirectDownloader, 'download' | 'inspectCheckpoint'>;
    const installPowerLease = createPowerLease();
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      directDownloader,
      downloadArchive,
      extractArchive: createValidExtractedModel,
      installPowerLease,
    });

    const installation = installer.install();
    void installation.catch(() => undefined);
    await waitUntil(() => installer.getStatus().stage === 'verifying');
    await installer.pauseForShutdown();
    expect(installer.hasActiveInstallation()).toBe(false);
    expect(installPowerLease.release).toHaveBeenCalledExactlyOnceWith('paused');
    await expect(installation).rejects.toMatchObject({ code: 'ASR_MODEL_INSTALL_PAUSED' });
    expect(installer.getStatus()).toMatchObject({
      stage: 'paused',
      errorCode: null,
      source: 'accelerated_direct',
    });
    expect(downloadArchive).not.toHaveBeenCalled();
    await expect(lstat(modelDirectory)).rejects.toThrow();
  });

  it('skips the network when a complete validated model is already installed', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    await mkdir(modelDirectory, { recursive: true });
    await Promise.all(LOCAL_ASR_MODEL_FILE_NAMES.map((name) =>
      writeSparseFile(path.join(modelDirectory, name), VALID_MODEL_SIZES[name]),
    ));
    await writeLocalAsrInstallationManifestAtomic(
      modelDirectory,
      await createLocalAsrInstallationManifest(modelDirectory, '2026-07-20T03:00:00.000Z'),
    );
    const downloadArchive = vi.fn(fakeExactDownload);
    const verifyCandidateRuntime = vi.fn(async () => true);
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive,
      extractArchive: createValidExtractedModel,
      verifyCandidateRuntime,
    });

    await expect(installer.install()).resolves.toMatchObject({
      outcome: 'already_installed',
      downloadedArchiveBytes: 0,
      localAsr: { ready: true },
    });
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(verifyCandidateRuntime).toHaveBeenCalledOnce();
    expect(verifyCandidateRuntime).toHaveBeenCalledWith(
      modelDirectory,
      expect.any(AbortSignal),
    );
    expect(installer.getStatus()).toMatchObject({
      stage: 'completed',
      downloadedBytes: 0,
      errorCode: null,
    });
  });

  it('does not report ready when the already-installed model fails its runtime probe', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    await mkdir(modelDirectory, { recursive: true });
    await Promise.all(LOCAL_ASR_MODEL_FILE_NAMES.map((name) =>
      writeSparseFile(path.join(modelDirectory, name), VALID_MODEL_SIZES[name]),
    ));
    await writeLocalAsrInstallationManifestAtomic(
      modelDirectory,
      await createLocalAsrInstallationManifest(modelDirectory, '2026-07-20T03:00:00.000Z'),
    );
    const downloadArchive = vi.fn(fakeExactDownload);
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive,
      extractArchive: createValidExtractedModel,
      verifyCandidateRuntime: async () => false,
    });

    await expect(installer.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_RUNTIME_INIT_FAILED',
    });
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(installer.getStatus()).toMatchObject({
      stage: 'failed',
      errorCode: 'ASR_MODEL_RUNTIME_INIT_FAILED',
    });
    await expect(lstat(path.join(modelDirectory, 'encoder.int8.onnx')))
      .resolves.toMatchObject({ size: VALID_MODEL_SIZES['encoder.int8.onnx'] });
  });

  it('rejects an archive size mismatch without changing existing partial files', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    await mkdir(modelDirectory, { recursive: true });
    const existingPath = path.join(modelDirectory, 'encoder.int8.onnx');
    await writeFile(existingPath, 'existing-partial-model');
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: async (input) => {
        await writeSparseFile(input.destinationPath, LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH - 1);
        return {
          byteLength: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH - 1,
          sha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
        };
      },
      extractArchive: createValidExtractedModel,
    });

    await expect(installer.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_ARCHIVE_SIZE_MISMATCH',
    });
    expect(await readFile(existingPath, 'utf8')).toBe('existing-partial-model');
  });

  it('rejects undersized extracted files and preserves the previous model directory', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    await mkdir(modelDirectory, { recursive: true });
    const existingPath = path.join(modelDirectory, 'tokens.txt');
    await writeFile(existingPath, 'existing tokens');
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: fakeExactDownload,
      extractArchive: async (input) => {
        await createValidExtractedModel(input);
        await truncate(
          path.join(input.stagingDirectory, MODEL_DIRECTORY_NAME, 'decoder.int8.onnx'),
          32,
        );
      },
    });

    await expect(installer.install()).rejects.toMatchObject({ code: 'ASR_MODEL_FILES_INVALID' });
    expect(await readFile(existingPath, 'utf8')).toBe('existing tokens');
  });

  it('rejects symlinked model members and keeps installation retryable', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    await mkdir(modelDirectory, { recursive: true });
    const existingPath = path.join(modelDirectory, 'tokens.txt');
    await writeFile(existingPath, 'existing tokens');
    const extractArchive = async (input: ModelArchiveExtractionInput) => {
      await createValidExtractedModel(input);
      const encoder = path.join(input.stagingDirectory, MODEL_DIRECTORY_NAME, 'encoder.int8.onnx');
      await rm(encoder);
      await symlink('/private/tmp/untrusted-encoder.onnx', encoder);
    };
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: fakeExactDownload,
      extractArchive,
    });

    await expect(installer.install()).rejects.toMatchObject({ code: 'ASR_MODEL_FILES_INVALID' });
    expect(await readFile(existingPath, 'utf8')).toBe('existing tokens');

    const retry = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: fakeExactDownload,
      extractArchive: createValidExtractedModel,
    });
    await expect(retry.install()).resolves.toMatchObject({ outcome: 'installed' });
  });

  it('fails disk preflight before any download when the installation peak cannot fit', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const downloadArchive = vi.fn(fakeExactDownload);
    const diagnostics = { record: vi.fn() };
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive,
      extractArchive: createValidExtractedModel,
      getAvailableDiskBytes: async () => LOCAL_ASR_MODEL_INSTALL_REQUIRED_FREE_BYTES - 1,
      diagnostics,
    });

    await expect(installer.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_INSUFFICIENT_DISK',
    });
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(installer.getStatus()).toMatchObject({
      stage: 'failed',
      errorCode: 'ASR_MODEL_INSUFFICIENT_DISK',
    });
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.install-failed',
      fields: expect.objectContaining({ errorCode: 'ASR_MODEL_INSUFFICIENT_DISK' }),
    }));
  });

  it('preserves the installation failure when acquire and release seams throw', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const diagnostics = { record: vi.fn() };
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: vi.fn(fakeExactDownload),
      extractArchive: createValidExtractedModel,
      getAvailableDiskBytes: async () => 0,
      diagnostics,
      installPowerLease: {
        acquire: () => { throw new Error('power acquire failed'); },
        release: () => { throw new Error('power release failed'); },
      },
    });

    await expect(installer.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_INSUFFICIENT_DISK',
    });
    expect(installer.getStatus()).toMatchObject({
      stage: 'failed',
      errorCode: 'ASR_MODEL_INSUFFICIENT_DISK',
    });
    expect(installer.hasActiveInstallation()).toBe(false);
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.power-save-blocker-acquire-failed',
    }));
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.power-save-blocker-release-failed',
      fields: expect.objectContaining({ reason: 'failed' }),
    }));
  });

  it('rejects a byte-exact archive when its frozen official SHA-256 does not match', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: async (input) => {
        await writeSparseFile(input.destinationPath, LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH);
        return {
          byteLength: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
          sha256: '0'.repeat(64),
        };
      },
      extractArchive: createValidExtractedModel,
    });

    await expect(installer.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_ARCHIVE_INTEGRITY_MISMATCH',
    });
    await expect(lstat(modelDirectory)).rejects.toThrow();
  });

  it('cleans stale private workspaces during startup preparation', async () => {
    const root = await createTemporaryDirectory();
    const modelParent = path.join(root, 'models');
    const modelDirectory = path.join(modelParent, MODEL_DIRECTORY_NAME);
    const staleDirectory = path.join(modelParent, '.phrio-asr-install-stale-directory');
    const staleFile = path.join(modelParent, '.phrio-asr-install-stale-file');
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(path.join(staleDirectory, 'partial-download'), 'partial');
    await writeFile(staleFile, 'partial');
    const diagnostics = { record: vi.fn() };
    const installer = new LocalAsrModelInstaller(modelDirectory, { diagnostics });

    await installer.initialize();

    await expect(lstat(staleDirectory)).rejects.toThrow();
    await expect(lstat(staleFile)).rejects.toThrow();
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.stale-workspaces-cleaned',
      fields: { removedWorkspaceCount: 2 },
    }));
  });

  it('cancels an active download, removes staging, and stays retryable', async () => {
    const root = await createTemporaryDirectory();
    const modelParent = path.join(root, 'models');
    const modelDirectory = path.join(modelParent, MODEL_DIRECTORY_NAME);
    let markDownloadStarted!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve;
    });
    const diagnostics = { record: vi.fn() };
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: (input) => new Promise((_resolve, reject) => {
        markDownloadStarted();
        input.onProgress(128 * 1_024 * 1_024);
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      }),
      extractArchive: createValidExtractedModel,
      diagnostics,
    });

    const installation = installer.install();
    await downloadStarted;
    expect(installer.getStatus()).toMatchObject({
      stage: 'downloading',
      downloadedBytes: 128 * 1_024 * 1_024,
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      cancellable: true,
    });
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.download-progress',
      fields: expect.objectContaining({ percentage: 12 }),
    }));
    expect(installer.cancel()).toBe(true);
    expect(installer.getStatus()).toMatchObject({ stage: 'cancelling', cancellable: false });
    await expect(installation).rejects.toMatchObject({ code: 'ASR_MODEL_INSTALL_CANCELLED' });
    expect(installer.getStatus()).toMatchObject({
      stage: 'cancelled',
      errorCode: 'ASR_MODEL_INSTALL_CANCELLED',
    });
    expect(installer.cancel()).toBe(false);
    expect((await readdir(modelParent)).some((name) => name.startsWith('.phrio-asr-install-')))
      .toBe(false);
    await expect(lstat(path.join(modelParent, CHECKPOINT_DIRECTORY_NAME))).rejects.toThrow();

    const retry = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: fakeExactDownload,
      extractArchive: createValidExtractedModel,
    });
    await expect(retry.install()).resolves.toMatchObject({ outcome: 'installed' });
  });

  it('reports a timed-out installation as failed while a restart restores its checkpoint', async () => {
    vi.useFakeTimers();
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const installPowerLease = createPowerLease();
    let markCheckpointReady!: () => void;
    const checkpointReady = new Promise<void>((resolve) => {
      markCheckpointReady = resolve;
    });
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      installationTimeoutMilliseconds: 10,
      downloadArchive: async (input) => {
        await writeSparseFile(input.destinationPath, 8 * 1_024 * 1_024);
        input.onProgress(8 * 1_024 * 1_024);
        markCheckpointReady();
        return new Promise((_resolve, reject) => {
          if (input.signal.aborted) {
            reject(input.signal.reason);
            return;
          }
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      },
      extractArchive: createValidExtractedModel,
      installPowerLease,
    });

    try {
      const installation = installer.install();
      await checkpointReady;
      await vi.advanceTimersByTimeAsync(10);
      await expect(installation).rejects.toMatchObject({
        code: 'ASR_MODEL_INSTALL_TIMEOUT',
      });
      expect(installPowerLease.acquire).toHaveBeenCalledOnce();
      expect(installPowerLease.release).toHaveBeenCalledExactlyOnceWith('failed');
      expect(installer.hasActiveInstallation()).toBe(false);
      expect(installer.getStatus()).toMatchObject({
        stage: 'failed',
        downloadedBytes: 8 * 1_024 * 1_024,
        errorCode: 'ASR_MODEL_INSTALL_TIMEOUT',
      });
    } finally {
      vi.useRealTimers();
    }

    const restarted = new LocalAsrModelInstaller(modelDirectory);
    await restarted.initialize();
    expect(restarted.getStatus()).toMatchObject({
      stage: 'paused',
      downloadedBytes: 8 * 1_024 * 1_024,
      cancellable: true,
    });
  });

  it('resumes a retained partial archive after a network failure and adjusts disk preflight', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const retainedBytes = 128 * 1_024 * 1_024;
    const first = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: async (input) => {
        await writeSparseFile(input.destinationPath, retainedBytes);
        input.onProgress(retainedBytes);
        throw new LocalAsrModelInstallerError('ASR_MODEL_DOWNLOAD_FAILED');
      },
      extractArchive: createValidExtractedModel,
    });

    await expect(first.install()).rejects.toMatchObject({ code: 'ASR_MODEL_DOWNLOAD_FAILED' });
    expect(first.getStatus()).toMatchObject({
      stage: 'failed',
      downloadedBytes: retainedBytes,
      errorCode: 'ASR_MODEL_DOWNLOAD_FAILED',
    });

    const resumedDownload = vi.fn(async (input: ModelArchiveDownloadInput) => {
      expect(input.resumeFromBytes).toBe(retainedBytes);
      expect(input.ifRange).toBeNull();
      await writeSparseFile(input.destinationPath, LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH);
      input.onProgress(LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH);
      return {
        byteLength: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
        sha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
      };
    });
    const resumed = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: resumedDownload,
      extractArchive: createValidExtractedModel,
      getAvailableDiskBytes: async () =>
        LOCAL_ASR_MODEL_INSTALL_REQUIRED_FREE_BYTES - retainedBytes,
    });
    await resumed.initialize();
    expect(resumed.getStatus()).toMatchObject({
      stage: 'paused',
      downloadedBytes: retainedBytes,
    });
    await expect(resumed.install()).resolves.toMatchObject({ outcome: 'installed' });
    expect(resumedDownload).toHaveBeenCalledOnce();
    await expect(lstat(path.join(
      path.dirname(modelDirectory),
      CHECKPOINT_DIRECTORY_NAME,
    ))).rejects.toThrow();
  });

  it('retains a checkpoint when manifest access fails transiently and restores it later', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const retainedBytes = 16 * 1_024 * 1_024;
    await seedRetainedCheckpoint(modelDirectory, retainedBytes);
    const manifestPath = checkpointManifestPath(modelDirectory);
    await chmod(manifestPath, 0);
    const diagnostics = { record: vi.fn() };
    const inaccessible = new LocalAsrModelInstaller(modelDirectory, { diagnostics });

    await expect(inaccessible.initialize()).rejects.toMatchObject({
      code: 'ASR_MODEL_INSTALL_FAILED',
    });
    expect(inaccessible.getStatus()).toMatchObject({
      stage: 'failed',
      errorCode: 'ASR_MODEL_INSTALL_FAILED',
    });
    expect((await lstat(checkpointArchivePath(modelDirectory))).size).toBe(retainedBytes);
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.checkpoint-access-failed',
      fields: expect.objectContaining({ checkpointRetained: true }),
    }));

    await chmod(manifestPath, 0o600);
    const recovered = new LocalAsrModelInstaller(modelDirectory);
    await recovered.initialize();
    expect(recovered.getStatus()).toMatchObject({
      stage: 'paused',
      downloadedBytes: retainedBytes,
    });
  });

  it('rejects and removes a symlinked checkpoint manifest without chmodding its target', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    await seedRetainedCheckpoint(modelDirectory, 8 * 1_024 * 1_024);
    const externalManifest = path.join(root, 'external-manifest.json');
    await writeFile(externalManifest, '{"external":true}\n', { mode: 0o644 });
    await rm(checkpointManifestPath(modelDirectory), { force: true });
    await symlink(externalManifest, checkpointManifestPath(modelDirectory));
    const diagnostics = { record: vi.fn() };
    const restarted = new LocalAsrModelInstaller(modelDirectory, { diagnostics });

    await restarted.initialize();

    await expect(lstat(checkpointArchivePath(modelDirectory))).rejects.toThrow();
    expect((await lstat(externalManifest)).mode & 0o777).toBe(0o644);
    expect(await readFile(externalManifest, 'utf8')).toBe('{"external":true}\n');
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.checkpoint-discarded',
    }));
  });

  it('rejects hard-linked and oversized checkpoint manifests before reading them', async () => {
    const root = await createTemporaryDirectory();
    const hardlinkModelDirectory = path.join(root, 'hardlink-models', MODEL_DIRECTORY_NAME);
    await seedRetainedCheckpoint(hardlinkModelDirectory, 4 * 1_024 * 1_024);
    const externalManifest = path.join(root, 'hardlinked-manifest.json');
    await writeFile(externalManifest, await readFile(
      checkpointManifestPath(hardlinkModelDirectory),
    ), { mode: 0o600 });
    await rm(checkpointManifestPath(hardlinkModelDirectory), { force: true });
    await link(externalManifest, checkpointManifestPath(hardlinkModelDirectory));

    const hardlinkRestart = new LocalAsrModelInstaller(hardlinkModelDirectory);
    await hardlinkRestart.initialize();
    await expect(lstat(checkpointArchivePath(hardlinkModelDirectory))).rejects.toThrow();
    expect((await lstat(externalManifest)).nlink).toBe(1);

    const oversizedModelDirectory = path.join(root, 'oversized-models', MODEL_DIRECTORY_NAME);
    await seedRetainedCheckpoint(oversizedModelDirectory, 4 * 1_024 * 1_024);
    await writeFile(
      checkpointManifestPath(oversizedModelDirectory),
      'x'.repeat(20 * 1_024),
      { mode: 0o600 },
    );
    const oversizedRestart = new LocalAsrModelInstaller(oversizedModelDirectory);
    await oversizedRestart.initialize();
    await expect(lstat(checkpointArchivePath(oversizedModelDirectory))).rejects.toThrow();
  });

  it('preserves a structurally valid partial when the CDN rejects its resume response', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const retainedBytes = 24 * 1_024 * 1_024;
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: async (input) => {
        await writeSparseFile(input.destinationPath, retainedBytes);
        input.onProgress(retainedBytes);
        throw new LocalAsrModelInstallerError('ASR_MODEL_RESUME_REJECTED');
      },
      extractArchive: createValidExtractedModel,
    });

    await expect(installer.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_RESUME_REJECTED',
    });
    expect(installer.getStatus()).toMatchObject({
      stage: 'failed',
      downloadedBytes: retainedBytes,
      errorCode: 'ASR_MODEL_RESUME_REJECTED',
    });
    expect((await lstat(checkpointArchivePath(modelDirectory))).size).toBe(retainedBytes);
  });

  it('keeps a checkpoint when shutdown pauses an active download and explicit cancel removes it', async () => {
    const root = await createTemporaryDirectory();
    const modelDirectory = path.join(root, 'models', MODEL_DIRECTORY_NAME);
    const retainedBytes = 32 * 1_024 * 1_024;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: async (input) => {
        await writeSparseFile(input.destinationPath, retainedBytes);
        input.onProgress(retainedBytes);
        markStarted();
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      },
      extractArchive: createValidExtractedModel,
    });

    const installation = installer.install();
    await started;
    await installer.pauseForShutdown();
    await expect(installation).rejects.toMatchObject({ code: 'ASR_MODEL_INSTALL_PAUSED' });
    expect(installer.getStatus()).toMatchObject({
      stage: 'paused',
      downloadedBytes: retainedBytes,
    });
    expect((await lstat(checkpointArchivePath(modelDirectory))).size).toBe(retainedBytes);

    expect(installer.cancel()).toBe(true);
    expect(installer.getStatus()).toMatchObject({
      stage: 'cancelled',
      downloadedBytes: 0,
      errorCode: 'ASR_MODEL_INSTALL_CANCELLED',
    });
    await expect(lstat(checkpointArchivePath(modelDirectory))).rejects.toThrow();
  });

  it('migrates the largest legacy staging download before stale-workspace cleanup', async () => {
    const root = await createTemporaryDirectory();
    const modelParent = path.join(root, 'models');
    const modelDirectory = path.join(modelParent, MODEL_DIRECTORY_NAME);
    const smallerWorkspace = path.join(modelParent, '.phrio-asr-install-smaller');
    const largerWorkspace = path.join(modelParent, '.phrio-asr-install-larger');
    await mkdir(smallerWorkspace, { recursive: true });
    await mkdir(largerWorkspace, { recursive: true });
    await writeSparseFile(path.join(smallerWorkspace, 'model.tar.bz2'), 8 * 1_024 * 1_024);
    await writeSparseFile(path.join(largerWorkspace, 'model.tar.bz2'), 24 * 1_024 * 1_024);
    const legacyInode = (await lstat(path.join(largerWorkspace, 'model.tar.bz2'))).ino;
    const diagnostics = { record: vi.fn() };
    const installer = new LocalAsrModelInstaller(modelDirectory, { diagnostics });

    await installer.initialize();

    expect(installer.getStatus()).toMatchObject({
      stage: 'paused',
      downloadedBytes: 24 * 1_024 * 1_024,
    });
    expect((await lstat(checkpointArchivePath(modelDirectory))).size).toBe(24 * 1_024 * 1_024);
    expect((await lstat(checkpointArchivePath(modelDirectory))).ino).toBe(legacyInode);
    await expect(lstat(smallerWorkspace)).rejects.toThrow();
    await expect(lstat(largerWorkspace)).rejects.toThrow();
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.legacy-checkpoint-migrated',
      fields: expect.objectContaining({ migratedBytes: 24 * 1_024 * 1_024 }),
    }));
  });

  it('migrates legacy bytes without copy before low-disk preflight and can resume later', async () => {
    const root = await createTemporaryDirectory();
    const modelParent = path.join(root, 'models');
    const modelDirectory = path.join(modelParent, MODEL_DIRECTORY_NAME);
    const legacyWorkspace = path.join(modelParent, '.phrio-asr-install-low-disk');
    const retainedBytes = 32 * 1_024 * 1_024;
    await mkdir(legacyWorkspace, { recursive: true });
    const legacyPath = path.join(legacyWorkspace, 'model.tar.bz2');
    await writeSparseFile(legacyPath, retainedBytes);
    const legacyInode = (await lstat(legacyPath)).ino;
    const downloadArchive = vi.fn(fakeExactDownload);
    const lowDisk = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive,
      extractArchive: createValidExtractedModel,
      getAvailableDiskBytes: async () => 0,
    });

    await expect(lowDisk.install()).rejects.toMatchObject({
      code: 'ASR_MODEL_INSUFFICIENT_DISK',
    });
    expect(downloadArchive).not.toHaveBeenCalled();
    expect((await lstat(checkpointArchivePath(modelDirectory))).ino).toBe(legacyInode);
    expect((await lstat(checkpointArchivePath(modelDirectory))).size).toBe(retainedBytes);
    await expect(lstat(legacyWorkspace)).rejects.toThrow();

    const resumed = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: fakeExactDownload,
      extractArchive: createValidExtractedModel,
      getAvailableDiskBytes: async () => LOCAL_ASR_MODEL_INSTALL_REQUIRED_FREE_BYTES,
    });
    await expect(resumed.install()).resolves.toMatchObject({ outcome: 'installed' });
  });

  it('explicitly deleting a paused checkpoint also removes legacy bytes so they cannot revive', async () => {
    const root = await createTemporaryDirectory();
    const modelParent = path.join(root, 'models');
    const modelDirectory = path.join(modelParent, MODEL_DIRECTORY_NAME);
    const paused = await seedRetainedCheckpoint(modelDirectory, 8 * 1_024 * 1_024);
    const legacyWorkspace = path.join(modelParent, '.phrio-asr-install-after-pause');
    await mkdir(legacyWorkspace, { recursive: true });
    await writeSparseFile(path.join(legacyWorkspace, 'model.tar.bz2'), 16 * 1_024 * 1_024);

    expect(paused.getStatus()).toMatchObject({
      stage: 'failed',
      errorCode: 'ASR_MODEL_DOWNLOAD_FAILED',
    });
    const restored = new LocalAsrModelInstaller(modelDirectory);
    await restored.initialize();
    expect(restored.getStatus()).toMatchObject({ stage: 'paused' });
    expect(restored.cancel()).toBe(true);
    await expect(lstat(path.join(modelParent, CHECKPOINT_DIRECTORY_NAME))).rejects.toThrow();
    await expect(lstat(legacyWorkspace)).rejects.toThrow();

    const restarted = new LocalAsrModelInstaller(modelDirectory);
    await restarted.initialize();
    expect(restarted.getStatus()).toMatchObject({ stage: 'idle', downloadedBytes: 0 });
  });

  it('replaces a smaller deterministic checkpoint with a larger legacy download', async () => {
    const root = await createTemporaryDirectory();
    const modelParent = path.join(root, 'models');
    const modelDirectory = path.join(modelParent, MODEL_DIRECTORY_NAME);
    const checkpointBytes = 4 * 1_024 * 1_024;
    const first = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: async (input) => {
        await writeSparseFile(input.destinationPath, checkpointBytes);
        input.onProgress(checkpointBytes);
        throw new LocalAsrModelInstallerError('ASR_MODEL_DOWNLOAD_FAILED');
      },
      extractArchive: createValidExtractedModel,
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'ASR_MODEL_DOWNLOAD_FAILED' });

    const legacyWorkspace = path.join(modelParent, '.phrio-asr-install-newer');
    const legacyBytes = 12 * 1_024 * 1_024;
    await mkdir(legacyWorkspace, { recursive: true });
    await writeSparseFile(path.join(legacyWorkspace, 'model.tar.bz2'), legacyBytes);
    const restarted = new LocalAsrModelInstaller(modelDirectory);

    await restarted.initialize();

    expect(restarted.getStatus()).toMatchObject({
      stage: 'paused',
      downloadedBytes: legacyBytes,
    });
    expect((await lstat(checkpointArchivePath(modelDirectory))).size).toBe(legacyBytes);
    await expect(lstat(legacyWorkspace)).rejects.toThrow();
  });

  it('discards an unusable current and backup promotion pair so reinstall can self-heal', async () => {
    const root = await createTemporaryDirectory();
    const modelParent = path.join(root, 'models');
    const modelDirectory = path.join(modelParent, MODEL_DIRECTORY_NAME);
    const backupDirectory = path.join(modelParent, `.${MODEL_DIRECTORY_NAME}.previous`);
    await mkdir(modelDirectory, { recursive: true });
    await mkdir(backupDirectory, { recursive: true });
    await writeFile(path.join(modelDirectory, 'encoder.int8.onnx'), 'invalid current');
    await writeFile(path.join(backupDirectory, 'encoder.int8.onnx'), 'invalid backup');
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: fakeExactDownload,
      extractArchive: createValidExtractedModel,
    });

    await installer.initialize();
    await expect(lstat(modelDirectory)).rejects.toThrow();
    await expect(lstat(backupDirectory)).rejects.toThrow();
    await expect(installer.install()).resolves.toMatchObject({ outcome: 'installed' });
  });

  it('restores a receipt-verified backup instead of trusting only current file sizes', async () => {
    const root = await createTemporaryDirectory();
    const modelParent = path.join(root, 'models');
    const modelDirectory = path.join(modelParent, MODEL_DIRECTORY_NAME);
    const backupDirectory = path.join(modelParent, `.${MODEL_DIRECTORY_NAME}.previous`);
    await Promise.all([
      mkdir(modelDirectory, { recursive: true }),
      mkdir(backupDirectory, { recursive: true }),
    ]);
    await Promise.all([
      ...LOCAL_ASR_MODEL_FILE_NAMES.map((name) =>
        writeSparseFile(path.join(modelDirectory, name), VALID_MODEL_SIZES[name])),
      ...LOCAL_ASR_MODEL_FILE_NAMES.map((name) =>
        writeSparseFile(path.join(backupDirectory, name), VALID_MODEL_SIZES[name])),
    ]);
    await writeFile(
      path.join(modelDirectory, LOCAL_ASR_INSTALL_MANIFEST_NAME),
      '{"schemaVersion":2,"corrupt":true}\n',
      { mode: 0o600 },
    );
    const backupInstalledAt = '2026-07-20T06:30:00.000Z';
    await writeLocalAsrInstallationManifestAtomic(
      backupDirectory,
      await createLocalAsrInstallationManifest(backupDirectory, backupInstalledAt),
    );
    const diagnostics = { record: vi.fn() };
    const installer = new LocalAsrModelInstaller(modelDirectory, {
      downloadArchive: fakeExactDownload,
      extractArchive: createValidExtractedModel,
      diagnostics,
    });

    await installer.initialize();

    await expect(lstat(backupDirectory)).rejects.toThrow();
    const restoredReceipt = JSON.parse(await readFile(
      path.join(modelDirectory, LOCAL_ASR_INSTALL_MANIFEST_NAME),
      'utf8',
    )) as { readonly installedAt?: unknown };
    expect(restoredReceipt.installedAt).toBe(backupInstalledAt);
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.promotion-rollback-completed',
      fields: { replacedInvalidCurrent: true },
    }));
  });
});

describe('official model URL policy', () => {
  it('allows only the frozen GitHub source and its release-asset redirect', () => {
    expect(assertTrustedLocalAsrModelDownloadUrl(LOCAL_ASR_MODEL_ARCHIVE_URL, 0).href)
      .toBe(LOCAL_ASR_MODEL_ARCHIVE_URL);
    expect(assertTrustedLocalAsrModelDownloadUrl(
      'https://release-assets.githubusercontent.com/github-production-release-asset/531380835/asset-id?sig=test',
      1,
    ).hostname).toBe('release-assets.githubusercontent.com');

    const rejected = [
      ['http://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/model.tar.bz2', 0],
      ['https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/other.tar.bz2', 0],
      ['https://release-assets.githubusercontent.com.evil.example/github-production-release-asset/531380835/asset', 1],
      ['https://release-assets.githubusercontent.com/github-production-release-asset/999/asset', 1],
      ['https://user:password@release-assets.githubusercontent.com/github-production-release-asset/531380835/asset', 1],
    ] as const;
    for (const [url, depth] of rejected) {
      expect(() => assertTrustedLocalAsrModelDownloadUrl(url, depth)).toThrowError(
        expect.objectContaining({ code: 'ASR_MODEL_REDIRECT_REJECTED' }),
      );
    }
  });

  it('sends Range and If-Range and rejects an imprecise 206 response', async () => {
    const root = await createTemporaryDirectory();
    const destinationPath = path.join(root, 'model.tar.bz2.partial');
    await writeFile(destinationPath, new Uint8Array([1]), { mode: 0o600 });
    const requestOptions: RequestOptions[] = [];
    const diagnostics = vi.fn();
    const requestGet = ((_url: URL, options: RequestOptions, listener: (
      response: IncomingMessage,
    ) => void) => {
      requestOptions.push(options);
      const request = new FakeClientRequest();
      queueMicrotask(() => listener(fakeIncomingMessage(206, {
        'content-length': String(LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH - 1),
        'content-range': `bytes 0-${LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH - 2}/${LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH}`,
        etag: '"official-etag"',
      })));
      return request as unknown as ClientRequest;
    }) as unknown as typeof import('node:https').get;

    await expect(downloadOfficialLocalAsrModelArchive({
      sourceUrl: LOCAL_ASR_MODEL_ARCHIVE_URL,
      destinationPath,
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      maximumBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      expectedSha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
      signal: new AbortController().signal,
      resumeFromBytes: 1,
      ifRange: '"official-etag"',
      onProgress: vi.fn(),
      onResponseMetadata: vi.fn(),
      onDiagnostic: diagnostics,
      requestGet,
    })).rejects.toMatchObject({ code: 'ASR_MODEL_RESUME_REJECTED' });
    expect(requestOptions[0]?.headers).toMatchObject({
      Range: 'bytes=1-',
      'If-Range': '"official-etag"',
      'Accept-Encoding': 'identity',
    });
    expect((await lstat(destinationPath)).size).toBe(1);
    expect(diagnostics).toHaveBeenCalledWith('download-attempt-started', {
      attempt: 1,
      maximumAttempts: 3,
      offsetBytes: 1,
      ifRangePresent: true,
    });
    expect(diagnostics).toHaveBeenCalledWith('download-response-received', expect.objectContaining({
      attempt: 1,
      offsetBytes: 1,
      statusCode: 206,
    }));
    expect(diagnostics).toHaveBeenCalledWith('download-attempt-failed', {
      attempt: 1,
      offsetBytes: 1,
      errorCode: 'ASR_MODEL_RESUME_REJECTED',
    });
  });

  it('fully closes a failed response pipeline before starting the next retry', async () => {
    const root = await createTemporaryDirectory();
    const destinationPath = path.join(root, 'model.tar.bz2.partial');
    await writeFile(destinationPath, new Uint8Array(), { mode: 0o600 });
    let requestCount = 0;
    let openResponses = 0;
    let overlappingAttempt = false;
    const diagnostics = vi.fn();
    const requestGet = ((_url: URL, _options: RequestOptions, listener: (
      response: IncomingMessage,
    ) => void) => {
      requestCount += 1;
      if (openResponses > 0) overlappingAttempt = true;
      openResponses += 1;
      const response = new DelayedDestroyResponse(() => {
        openResponses -= 1;
      }) as unknown as IncomingMessage;
      Object.defineProperty(response, 'statusCode', { value: 200, configurable: true });
      Object.defineProperty(response, 'headers', {
        value: { 'content-length': String(LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH) },
        configurable: true,
      });
      const request = new FakeClientRequest();
      queueMicrotask(() => {
        listener(response);
        queueMicrotask(() => {
          if (requestCount === 1) {
            request.emit('error', new Error('simulated request failure'));
          } else if (requestCount === 2) {
            response.emit('aborted');
          } else {
            response.emit('error', new Error('simulated response failure'));
          }
        });
      });
      return request as unknown as ClientRequest;
    }) as unknown as typeof import('node:https').get;

    await expect(downloadOfficialLocalAsrModelArchive({
      sourceUrl: LOCAL_ASR_MODEL_ARCHIVE_URL,
      destinationPath,
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      maximumBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      expectedSha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
      signal: new AbortController().signal,
      resumeFromBytes: 0,
      ifRange: null,
      onProgress: vi.fn(),
      onResponseMetadata: vi.fn(),
      onDiagnostic: diagnostics,
      requestGet,
    })).rejects.toMatchObject({ code: 'ASR_MODEL_DOWNLOAD_FAILED' });

    expect(requestCount).toBe(3);
    expect(openResponses).toBe(0);
    expect(overlappingAttempt).toBe(false);
    expect(diagnostics.mock.calls.filter(([event]) => event === 'download-attempt-failed'))
      .toHaveLength(3);
    expect(diagnostics.mock.calls.filter(([event]) => event === 'download-retry-scheduled'))
      .toHaveLength(2);
  });

  it('records idle timeouts and bounded retry backoff for all three attempts', async () => {
    const root = await createTemporaryDirectory();
    const destinationPath = path.join(root, 'model.tar.bz2.partial');
    await writeFile(destinationPath, new Uint8Array(), { mode: 0o600 });
    const idleTimeoutAt: number[] = [];
    const diagnostics = vi.fn((event: string, _fields?: unknown) => {
      if (event === 'download-idle-timeout') idleTimeoutAt.push(performance.now());
    });
    let requestCount = 0;
    const attemptStartedAt: number[] = [];
    const requestGet = ((_url: URL, _options: RequestOptions, _listener: (
      response: IncomingMessage,
    ) => void) => {
      requestCount += 1;
      attemptStartedAt.push(performance.now());
      return new FakeClientRequest() as unknown as ClientRequest;
    }) as unknown as typeof import('node:https').get;

    await expect(downloadOfficialLocalAsrModelArchive({
      sourceUrl: LOCAL_ASR_MODEL_ARCHIVE_URL,
      destinationPath,
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      maximumBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      expectedSha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
      signal: new AbortController().signal,
      resumeFromBytes: 0,
      ifRange: null,
      onProgress: vi.fn(),
      onResponseMetadata: vi.fn(),
      onDiagnostic: diagnostics,
      requestGet,
      idleTimeoutMilliseconds: 20,
    })).rejects.toMatchObject({ code: 'ASR_MODEL_DOWNLOAD_FAILED' });

    expect(requestCount).toBe(3);
    expect(diagnostics.mock.calls.filter(([event]) => event === 'download-idle-timeout'))
      .toHaveLength(3);
    for (const [index, call] of diagnostics.mock.calls
      .filter(([event]) => event === 'download-idle-timeout').entries()) {
      expect(call[1]).toMatchObject({ attempt: index + 1, timeoutMilliseconds: 20 });
      expect(idleTimeoutAt[index]! - attemptStartedAt[index]!).toBeGreaterThanOrEqual(15);
    }
    expect(diagnostics).toHaveBeenCalledWith('download-retry-scheduled', {
      attempt: 1,
      nextAttempt: 2,
      delayMilliseconds: 250,
    });
    expect(diagnostics).toHaveBeenCalledWith('download-retry-scheduled', {
      attempt: 2,
      nextAttempt: 3,
      delayMilliseconds: 500,
    });
  });

  it('clears each attempt timer so an old deadline cannot fire inside the next attempt', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTemporaryDirectory();
      const destinationPath = path.join(root, 'model.tar.bz2.partial');
      await writeFile(destinationPath, new Uint8Array(), { mode: 0o600 });
      const diagnostics = vi.fn();
      const requests: FakeClientRequest[] = [];
      const requestGet = ((_url: URL, _options: RequestOptions, _listener: (
        response: IncomingMessage,
      ) => void) => {
        const request = new FakeClientRequest();
        requests.push(request);
        return request as unknown as ClientRequest;
      }) as unknown as typeof import('node:https').get;

      const operation = downloadOfficialLocalAsrModelArchive({
        sourceUrl: LOCAL_ASR_MODEL_ARCHIVE_URL,
        destinationPath,
        expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
        maximumBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
        expectedSha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
        signal: new AbortController().signal,
        resumeFromBytes: 0,
        ifRange: null,
        onProgress: vi.fn(),
        onResponseMetadata: vi.fn(),
        onDiagnostic: diagnostics,
        requestGet,
      });
      const outcome = operation.catch((error: unknown) => error);

      await waitForRequestCount(requests, 1);
      await vi.advanceTimersByTimeAsync(25_000);
      requests[0]!.emit('error', new Error('attempt one failed before its idle deadline'));
      await vi.advanceTimersByTimeAsync(250);
      await waitForRequestCount(requests, 2);

      // Cross attempt boundary: the first timer's original 30 second deadline
      // passes five seconds into attempt two. It must have been removed.
      await vi.advanceTimersByTimeAsync(5_001);
      expect(diagnostics.mock.calls.filter(([event]) => event === 'download-idle-timeout'))
        .toHaveLength(0);

      requests[1]!.emit('error', new Error('attempt two failed independently'));
      await vi.advanceTimersByTimeAsync(500);
      await waitForRequestCount(requests, 3);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(diagnostics.mock.calls.filter(([event]) => event === 'download-idle-timeout'))
        .toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({ code: 'ASR_MODEL_DOWNLOAD_FAILED' });
      expect(diagnostics.mock.calls.filter(([event]) => event === 'download-idle-timeout'))
        .toEqual([[
          'download-idle-timeout',
          expect.objectContaining({ attempt: 3, timeoutMilliseconds: 30_000 }),
        ]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('safely truncates a partial archive when the server ignores Range with 200', async () => {
    const root = await createTemporaryDirectory();
    const destinationPath = path.join(root, 'model.tar.bz2.partial');
    await writeFile(destinationPath, new Uint8Array([1, 2, 3]), { mode: 0o600 });
    const progress = vi.fn();
    const diagnostics = vi.fn();
    const requestGet = ((_url: URL, _options: RequestOptions, listener: (
      response: IncomingMessage,
    ) => void) => {
      const request = new FakeClientRequest();
      queueMicrotask(() => listener(fakeIncomingMessage(200, {
        'content-length': String(LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH),
        etag: '"replacement-etag"',
      })));
      return request as unknown as ClientRequest;
    }) as unknown as typeof import('node:https').get;

    await expect(downloadOfficialLocalAsrModelArchive({
      sourceUrl: LOCAL_ASR_MODEL_ARCHIVE_URL,
      destinationPath,
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      maximumBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      expectedSha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
      signal: new AbortController().signal,
      resumeFromBytes: 3,
      ifRange: '"old-etag"',
      onProgress: progress,
      onResponseMetadata: vi.fn(),
      onDiagnostic: diagnostics,
      requestGet,
    })).rejects.toMatchObject({ code: 'ASR_MODEL_ARCHIVE_SIZE_MISMATCH' });
    expect((await lstat(destinationPath)).size).toBe(0);
    expect(progress).toHaveBeenCalledWith(0);
    expect(diagnostics).toHaveBeenCalledWith('download-server-restarted', {
      attempt: 1,
      previousOffsetBytes: 3,
      statusCode: 200,
    });
  });

  it('uses /usr/bin/tar to extract only the three fixed runtime members', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'source');
    const archivedModel = path.join(source, MODEL_DIRECTORY_NAME);
    const stagingDirectory = path.join(root, 'staging');
    const archivePath = path.join(root, 'model.tar.bz2');
    await mkdir(archivedModel, { recursive: true });
    await mkdir(stagingDirectory);
    await Promise.all([
      ...LOCAL_ASR_MODEL_FILE_NAMES.map((name) => writeFile(path.join(archivedModel, name), name)),
      writeFile(path.join(archivedModel, 'test-audio.wav'), 'must not be extracted'),
    ]);
    await runFile('/usr/bin/tar', [
      '-cjf',
      archivePath,
      '-C',
      source,
      MODEL_DIRECTORY_NAME,
    ]);

    await extractOfficialLocalAsrModelArchive({
      archivePath,
      stagingDirectory,
      signal: new AbortController().signal,
    });

    expect((await readdir(path.join(stagingDirectory, MODEL_DIRECTORY_NAME))).sort())
      .toEqual([...LOCAL_ASR_MODEL_FILE_NAMES].sort());
  });
});
