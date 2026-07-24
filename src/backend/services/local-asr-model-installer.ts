import {
  createReadStream,
  createWriteStream,
  constants,
  readdirSync,
  rmSync,
} from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import {
  LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
  LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH,
  LOCAL_ASR_MODEL_FILE_NAMES,
  type GetLocalAsrModelInstallStatusOutput,
  type InstallLocalAsrModelOutput,
  type RecordDiagnosticEventInput,
} from '../../shared';
import {
  LOCAL_ASR_INSTALL_MANIFEST_NAME,
  LOCAL_ASR_MODEL_ARCHIVE_SHA256,
  LOCAL_ASR_MODEL_ARCHIVE_URL,
  createLocalAsrInstallationManifest,
  verifyInstalledModelManifest,
  writeLocalAsrInstallationManifestAtomic,
} from './local-asr-model-verifier';
import {
  LOCAL_ASR_DIRECT_CHECKPOINT_DIRECTORY_NAME,
  LocalAsrDirectDownloadError,
  LocalAsrDirectDownloader,
  removeLocalAsrDirectCheckpoint,
  type LocalAsrDirectCheckpointStatus,
  type LocalAsrDirectDownloadResult,
} from './local-asr-direct-download';
import type { LocalAsrDirectSourceId } from './local-asr-model-distribution';
import type {
  LocalAsrInstallPowerLease,
  LocalAsrInstallPowerReleaseReason,
} from './local-asr-install-power-save-blocker';

export { LOCAL_ASR_MODEL_ARCHIVE_SHA256, LOCAL_ASR_MODEL_ARCHIVE_URL };

const MODEL_ARCHIVE_DIRECTORY = 'sherpa-onnx-streaming-paraformer-bilingual-zh-en';
const DOWNLOAD_CHECKPOINT_DIRECTORY = '.phrio-asr-download-v1';
const DOWNLOAD_CHECKPOINT_ARCHIVE = 'model.tar.bz2.partial';
const DOWNLOAD_CHECKPOINT_MANIFEST = 'manifest.json';
const DOWNLOAD_CHECKPOINT_SCHEMA_VERSION = 1;
const DOWNLOAD_CHECKPOINT_MANIFEST_MAXIMUM_BYTES = 16 * 1_024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAXIMUM_REDIRECTS = 4;
const MAXIMUM_DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_IDLE_TIMEOUT_MILLISECONDS = 30_000;
const EXTRACTION_TIMEOUT_MILLISECONDS = 30 * 60 * 1_000;
const DEFAULT_INSTALLATION_TIMEOUT_MILLISECONDS = 24 * 60 * 60 * 1_000;
const INSTALLATION_DISK_SAFETY_MARGIN_BYTES = 128 * 1_024 * 1_024;
const MAXIMUM_INSTALLED_MODEL_BYTES = 512 * 1_024 * 1_024;
export const LOCAL_ASR_MODEL_INSTALL_REQUIRED_FREE_BYTES =
  LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
  + MAXIMUM_INSTALLED_MODEL_BYTES
  + INSTALLATION_DISK_SAFETY_MARGIN_BYTES;
export const LOCAL_ASR_MODEL_DIRECT_INSTALL_REQUIRED_FREE_BYTES =
  LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH
  + LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH
  + INSTALLATION_DISK_SAFETY_MARGIN_BYTES;
const MODEL_FILE_MINIMUM_BYTES = Object.freeze({
  'encoder.int8.onnx': 64 * 1_024 * 1_024,
  'decoder.int8.onnx': 8 * 1_024 * 1_024,
  'tokens.txt': 1_024,
} satisfies Record<(typeof LOCAL_ASR_MODEL_FILE_NAMES)[number], number>);

const runFile = promisify(execFile);

export interface LocalAsrModelInstallDiagnosticSink {
  record(input: RecordDiagnosticEventInput): unknown;
}

export interface ModelArchiveDownloadInput {
  readonly sourceUrl: string;
  readonly destinationPath: string;
  readonly expectedBytes: number;
  readonly maximumBytes: number;
  readonly expectedSha256: string;
  readonly signal: AbortSignal;
  readonly resumeFromBytes: number;
  readonly ifRange: string | null;
  readonly onProgress: (downloadedBytes: number) => void;
  readonly onResponseMetadata: (metadata: ModelArchiveResponseMetadata) => MaybePromise<void>;
  readonly onDiagnostic?: (
    event: string,
    fields: Readonly<Record<string, string | number | boolean | null>>,
  ) => void;
  readonly requestGet?: ModelHttpsGet;
  /** Test-only override; production always uses the frozen 30 second idle gate. */
  readonly idleTimeoutMilliseconds?: number;
}

export interface ModelArchiveDownloadResult {
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ModelArchiveResponseMetadata {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

type MaybePromise<T> = T | Promise<T>;
type ModelHttpsGet = typeof https.get;

export interface ModelArchiveExtractionInput {
  readonly archivePath: string;
  readonly stagingDirectory: string;
  readonly signal: AbortSignal;
}

export interface LocalAsrModelInstallerOptions {
  readonly downloadArchive?: (input: ModelArchiveDownloadInput) => Promise<ModelArchiveDownloadResult>;
  readonly extractArchive?: (input: ModelArchiveExtractionInput) => Promise<void>;
  readonly directDownloader?: Pick<
    LocalAsrDirectDownloader,
    'download' | 'inspectCheckpoint'
  > | null;
  readonly getAvailableDiskBytes?: (directoryPath: string) => Promise<number>;
  readonly verifyCandidateRuntime?: (
    candidateDirectory: string,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  readonly installationTimeoutMilliseconds?: number;
  readonly now?: () => Date;
  readonly diagnostics?: LocalAsrModelInstallDiagnosticSink;
  readonly installPowerLease?: LocalAsrInstallPowerLease;
}

interface VerifiedModelDirectory {
  readonly totalBytes: number;
}

interface ModelDownloadCheckpointManifest {
  readonly schemaVersion: typeof DOWNLOAD_CHECKPOINT_SCHEMA_VERSION;
  readonly sourceUrl: typeof LOCAL_ASR_MODEL_ARCHIVE_URL;
  readonly expectedBytes: typeof LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH;
  readonly expectedSha256: typeof LOCAL_ASR_MODEL_ARCHIVE_SHA256;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

interface ModelDownloadCheckpoint {
  readonly directoryPath: string;
  readonly archivePath: string;
  readonly manifestPath: string;
  readonly downloadedBytes: number;
  readonly manifest: ModelDownloadCheckpointManifest;
}

interface ActiveInstallation {
  readonly controller: AbortController;
  readonly promise: Promise<InstallLocalAsrModelOutput>;
}

/**
 * Installs the official k2-fsa model without exposing filesystem or network
 * primitives to the renderer. A complete candidate directory is validated
 * before it can replace the current model directory.
 */
export class LocalAsrModelInstaller {
  readonly #modelDirectory: string;
  readonly #downloadArchive: NonNullable<LocalAsrModelInstallerOptions['downloadArchive']>;
  readonly #extractArchive: NonNullable<LocalAsrModelInstallerOptions['extractArchive']>;
  readonly #directDownloader: NonNullable<LocalAsrModelInstallerOptions['directDownloader']> | null;
  readonly #getAvailableDiskBytes: NonNullable<
    LocalAsrModelInstallerOptions['getAvailableDiskBytes']
  >;
  readonly #verifyCandidateRuntime:
    LocalAsrModelInstallerOptions['verifyCandidateRuntime'];
  readonly #installationTimeoutMilliseconds: number;
  readonly #now: () => Date;
  readonly #diagnostics: LocalAsrModelInstallDiagnosticSink | undefined;
  readonly #installPowerLease: LocalAsrInstallPowerLease | undefined;
  #status: GetLocalAsrModelInstallStatusOutput;
  #activeInstallation: ActiveInstallation | null = null;
  #lastLoggedDownloadPercent = 0;
  #lastRecoverableErrorCode: LocalAsrModelInstallerErrorCode | null = null;

  constructor(modelDirectory: string, options: LocalAsrModelInstallerOptions = {}) {
    this.#modelDirectory = path.resolve(modelDirectory);
    this.#downloadArchive = options.downloadArchive ?? downloadOfficialLocalAsrModelArchive;
    this.#extractArchive = options.extractArchive ?? extractOfficialLocalAsrModelArchive;
    this.#directDownloader = options.directDownloader === undefined
      ? options.downloadArchive === undefined && options.extractArchive === undefined
        ? new LocalAsrDirectDownloader()
        : null
      : options.directDownloader;
    this.#getAvailableDiskBytes = options.getAvailableDiskBytes ?? getAvailableDiskBytes;
    this.#verifyCandidateRuntime = options.verifyCandidateRuntime;
    this.#installationTimeoutMilliseconds =
      options.installationTimeoutMilliseconds ?? DEFAULT_INSTALLATION_TIMEOUT_MILLISECONDS;
    if (
      !Number.isSafeInteger(this.#installationTimeoutMilliseconds)
      || this.#installationTimeoutMilliseconds <= 0
    ) {
      throw new TypeError('installationTimeoutMilliseconds must be a positive safe integer');
    }
    this.#now = options.now ?? (() => new Date());
    this.#diagnostics = options.diagnostics;
    this.#installPowerLease = options.installPowerLease;
    this.#status = {
      stage: 'idle',
      downloadedBytes: 0,
      expectedBytes: this.#directDownloader
        ? LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH
        : LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      source: this.#directDownloader ? 'accelerated_direct' : 'github_release_archive',
      lastRecoverableErrorCode: null,
      cancellable: false,
      errorCode: null,
      updatedAt: this.#now().toISOString(),
    };
  }

  async initialize(): Promise<void> {
    if (this.#activeInstallation) return;
    try {
      await this.#prepareModelParent(true);
    } catch (error) {
      const installerError = normalizeInstallerError(error, 'ASR_MODEL_INSTALL_FAILED');
      this.#setStatus('failed', this.#status.downloadedBytes, installerError.code);
      throw installerError;
    }
  }

  install(): Promise<InstallLocalAsrModelOutput> {
    if (this.#activeInstallation) return this.#activeInstallation.promise;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_TIMEOUT'));
    }, this.#installationTimeoutMilliseconds);
    timeout.unref();
    this.#lastLoggedDownloadPercent = 0;
    this.#lastRecoverableErrorCode = null;
    this.#setStatus(
      'preparing',
      0,
      null,
      this.#directDownloader ? 'accelerated_direct' : 'github_release_archive',
    );
    this.#acquireInstallPowerLease();
    let active!: ActiveInstallation;
    const installation = this.#install(controller.signal).finally(() => {
      clearTimeout(timeout);
      this.#releaseInstallPowerLease(powerReleaseReasonForStatus(this.#status.stage));
      if (this.#activeInstallation === active) this.#activeInstallation = null;
    });
    active = { controller, promise: installation };
    this.#activeInstallation = active;
    return installation;
  }

  cancel(): boolean {
    const active = this.#activeInstallation;
    if (!active) {
      if (this.#status.stage !== 'paused') return false;
      try {
        const modelParent = path.dirname(this.#modelDirectory);
        removeLegacyInstallationWorkspacesSync(modelParent);
        rmSync(this.#checkpointDirectory(), { recursive: true, force: true });
        rmSync(this.#directCheckpointDirectory(), { recursive: true, force: true });
      } catch (error) {
        this.#setStatus('failed', this.#status.downloadedBytes, 'ASR_MODEL_INSTALL_FAILED');
        this.#recordDiagnostic({
          level: 'error',
          component: 'asr',
          event: 'asr.model.checkpoint-cleanup-failed',
          fields: { errorCode: 'ASR_MODEL_INSTALL_FAILED' },
        });
        return false;
      }
      this.#setStatus('cancelled', 0, 'ASR_MODEL_INSTALL_CANCELLED');
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.model.install-cancelled',
        fields: { removedCheckpoint: true },
      });
      return true;
    }
    if (active.controller.signal.aborted || !this.#status.cancellable) return false;
    this.#recordDiagnostic({
      level: 'info',
      component: 'asr',
      event: 'asr.model.install-cancel-requested',
      fields: {},
    });
    this.#setStatus('cancelling', this.#status.downloadedBytes, null);
    active.controller.abort(new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_CANCELLED'));
    return true;
  }

  async pauseForShutdown(): Promise<void> {
    const active = this.#activeInstallation;
    if (!active) return;
    if (!active.controller.signal.aborted) {
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.model.shutdown-pause-requested',
        fields: { downloadedBytes: this.#status.downloadedBytes },
      });
      active.controller.abort(new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_PAUSED'));
    }
    try {
      await active.promise;
    } catch (error) {
      const installerError = normalizeInstallerError(error, 'ASR_MODEL_INSTALL_FAILED');
      if (installerError.code !== 'ASR_MODEL_INSTALL_PAUSED') throw installerError;
    }
  }

  getStatus(): GetLocalAsrModelInstallStatusOutput {
    return { ...this.#status };
  }

  hasActiveInstallation(): boolean {
    return this.#activeInstallation !== null;
  }

  #acquireInstallPowerLease(): void {
    try {
      this.#installPowerLease?.acquire();
    } catch {
      this.#recordDiagnostic({
        level: 'warn',
        component: 'asr',
        event: 'asr.model.power-save-blocker-acquire-failed',
        fields: { errorCode: 'ASR_MODEL_POWER_BLOCKER_ACQUIRE_FAILED' },
      });
    }
  }

  #releaseInstallPowerLease(reason: LocalAsrInstallPowerReleaseReason): void {
    try {
      this.#installPowerLease?.release(reason);
    } catch {
      this.#recordDiagnostic({
        level: 'warn',
        component: 'asr',
        event: 'asr.model.power-save-blocker-release-failed',
        fields: {
          reason,
          errorCode: 'ASR_MODEL_POWER_BLOCKER_RELEASE_FAILED',
        },
      });
    }
  }

  async #install(signal: AbortSignal): Promise<InstallLocalAsrModelOutput> {
    this.#recordDiagnostic({
      level: 'info',
      component: 'asr',
      event: 'asr.model.install-started',
      fields: { expectedBytes: this.#status.expectedBytes },
    });

    const modelParent = path.dirname(this.#modelDirectory);
    const backupDirectory = path.join(
      modelParent,
      `.${path.basename(this.#modelDirectory)}.previous`,
    );
    let workspace: string | null = null;
    try {
      await this.#prepareModelParent(false);
      throwIfInstallationAborted(signal);
      const current = await inspectVerifiedModelDirectory(this.#modelDirectory, false);
      const currentManifest = current
        ? await verifyInstalledModelManifest(this.#modelDirectory, signal)
        : null;
      if (current && currentManifest?.state === 'ready') {
        throwIfInstallationAborted(signal);
        await this.#assertCandidateRuntimeReady(this.#modelDirectory, signal);
        throwIfInstallationAborted(signal);
        await this.#removeDownloadCheckpointAfterSuccess();
        const result = await this.#createResult('already_installed', 0, current.totalBytes);
        this.#setStatus('completed', 0, null);
        this.#recordDiagnostic({
          level: 'info',
          component: 'asr',
          event: 'asr.model.install-skipped',
          fields: { installedBytes: current.totalBytes, status: 'already_installed' },
        });
        return result;
      }

      if (this.#directDownloader) {
        try {
          return await this.#installDirectModel(signal, modelParent, backupDirectory);
        } catch (error) {
          throwIfInstallationAborted(signal);
          if (!isRecoverableDirectDownloadError(error)) throw error;
          this.#lastRecoverableErrorCode = directErrorToInstallerCode(error);
          if (!shouldFallbackToArchive(error, this.#status.source)) {
            const retainedDirectCheckpoint = await this.#directDownloader
              .inspectCheckpoint(this.#directCheckpointDirectory())
              .catch(() => null);
            this.#recordDiagnostic({
              level: 'warn',
              component: 'asr',
              event: 'asr.model.direct-retry-required',
              fields: {
                reasonCode: this.#lastRecoverableErrorCode,
                archiveFallbackSuppressed: true,
                checkpointRetained:
                  (retainedDirectCheckpoint?.downloadedBytes ?? 0) > 0,
                downloadedBytes: retainedDirectCheckpoint?.downloadedBytes ?? 0,
              },
            });
            throw new LocalAsrModelInstallerError(
              this.#lastRecoverableErrorCode,
              error,
            );
          }
          this.#lastLoggedDownloadPercent = 0;
          this.#recordDiagnostic({
            level: 'warn',
            component: 'asr',
            event: 'asr.model.direct-fallback-started',
            fields: {
              reasonCode: this.#lastRecoverableErrorCode,
              source: 'github_release_archive',
              structuralIncompatibility: true,
            },
          });
        }
      }

      let checkpoint = await this.#readDownloadCheckpoint();
      const resumeFromBytes = checkpoint?.downloadedBytes ?? 0;
      // Once the compatibility route begins, all subsequent preflight errors
      // and retained bytes belong to the archive checkpoint rather than the
      // last direct source attempted.
      this.#setStatus(
        'preparing',
        resumeFromBytes,
        null,
        'github_release_archive',
      );
      this.#lastLoggedDownloadPercent = Math.floor(
        (resumeFromBytes / LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH) * 100,
      );
      let availableDiskBytes: number;
      try {
        availableDiskBytes = await this.#getAvailableDiskBytes(modelParent);
      } catch (error) {
        throw normalizeInstallerError(error, 'ASR_MODEL_DISK_CHECK_FAILED');
      }
      throwIfInstallationAborted(signal);
      const requiredFreeBytes = requiredFreeBytesForCheckpoint(resumeFromBytes);
      if (
        !Number.isSafeInteger(availableDiskBytes)
        || availableDiskBytes < requiredFreeBytes
      ) {
        throw new LocalAsrModelInstallerError('ASR_MODEL_INSUFFICIENT_DISK');
      }
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.model.disk-preflight-completed',
        fields: {
          availableBytes: availableDiskBytes,
          requiredBytes: requiredFreeBytes,
          resumeFromBytes,
        },
      });
      throwIfInstallationAborted(signal);

      checkpoint ??= await this.#createDownloadCheckpoint();
      workspace = await mkdtemp(path.join(modelParent, '.phrio-asr-install-'));
      await chmod(workspace, PRIVATE_DIRECTORY_MODE);
      const archivePath = checkpoint.archivePath;
      const extractionDirectory = path.join(workspace, 'extracted');
      const candidateDirectory = path.join(workspace, 'candidate');

      let downloadResult: ModelArchiveDownloadResult;
      this.#setStatus(
        'downloading',
        checkpoint.downloadedBytes,
        null,
        'github_release_archive',
      );
      if (checkpoint.downloadedBytes > 0) {
        this.#recordDiagnostic({
          level: 'info',
          component: 'asr',
          event: 'asr.model.download-resume-started',
          fields: {
            downloadedBytes: checkpoint.downloadedBytes,
            expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
          },
        });
      }
      let responseMetadata: ModelArchiveResponseMetadata = {
        etag: checkpoint.manifest.etag,
        lastModified: checkpoint.manifest.lastModified,
      };
      try {
        downloadResult = await this.#downloadArchive({
          sourceUrl: LOCAL_ASR_MODEL_ARCHIVE_URL,
          destinationPath: archivePath,
          expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
          maximumBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
          expectedSha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
          signal,
          resumeFromBytes: checkpoint.downloadedBytes,
          ifRange: checkpoint.manifest.etag ?? checkpoint.manifest.lastModified,
          onProgress: (downloadedBytes) => {
            if (!signal.aborted && this.#status.stage === 'downloading') {
              this.#setStatus('downloading', downloadedBytes, null);
              this.#recordDownloadProgressMilestone(downloadedBytes);
            }
          },
          onResponseMetadata: async (metadata) => {
            responseMetadata = metadata;
            try {
              await this.#writeDownloadCheckpointManifest({
                ...checkpoint!.manifest,
                etag: metadata.etag,
                lastModified: metadata.lastModified,
              });
            } catch {
              this.#recordDiagnostic({
                level: 'warn',
                component: 'asr',
                event: 'asr.model.checkpoint-metadata-write-failed',
                fields: {},
              });
            }
          },
          onDiagnostic: (event, fields) => {
            const level = event.endsWith('-failed') || event.endsWith('-timeout')
              ? 'warn'
              : 'info';
            this.#recordDiagnostic({
              level,
              component: 'asr',
              event: `asr.model.${event}`,
              fields,
            });
          },
        });
      } catch (error) {
        throwIfInstallationAborted(signal);
        throw normalizeInstallerError(error, 'ASR_MODEL_DOWNLOAD_FAILED');
      }
      throwIfInstallationAborted(signal);
      this.#setStatus('verifying', downloadResult.byteLength, null);
      const archiveMetadata = await stat(archivePath).catch(() => null);
      if (
        downloadResult.byteLength !== LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
        || archiveMetadata?.isFile() !== true
        || archiveMetadata.size !== LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
      ) {
        throw new LocalAsrModelInstallerError('ASR_MODEL_ARCHIVE_SIZE_MISMATCH');
      }
      if (downloadResult.sha256 !== LOCAL_ASR_MODEL_ARCHIVE_SHA256) {
        throw new LocalAsrModelInstallerError('ASR_MODEL_ARCHIVE_INTEGRITY_MISMATCH');
      }
      await chmod(archivePath, PRIVATE_FILE_MODE);
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.model.download-completed',
        fields: {
          downloadedBytes: downloadResult.byteLength,
          archiveSha256Verified: true,
          resumed: checkpoint.downloadedBytes > 0,
          validatorPresent: responseMetadata.etag !== null || responseMetadata.lastModified !== null,
        },
      });

      await mkdir(extractionDirectory, { mode: PRIVATE_DIRECTORY_MODE });
      this.#setStatus('extracting', downloadResult.byteLength, null);
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.model.extraction-started',
        fields: {},
      });
      try {
        await this.#extractArchive({ archivePath, stagingDirectory: extractionDirectory, signal });
      } catch (error) {
        throwIfInstallationAborted(signal);
        throw normalizeInstallerError(error, 'ASR_MODEL_ARCHIVE_INVALID');
      }
      throwIfInstallationAborted(signal);
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.model.extraction-completed',
        fields: {},
      });
      this.#setStatus('verifying', downloadResult.byteLength, null);
      await mkdir(candidateDirectory, { mode: PRIVATE_DIRECTORY_MODE });
      const extractedModelDirectory = path.join(extractionDirectory, MODEL_ARCHIVE_DIRECTORY);
      for (const name of LOCAL_ASR_MODEL_FILE_NAMES) {
        throwIfInstallationAborted(signal);
        const sourcePath = path.join(extractedModelDirectory, name);
        await assertValidModelFile(sourcePath, name);
        const candidatePath = path.join(candidateDirectory, name);
        await rename(sourcePath, candidatePath);
        await chmod(candidatePath, PRIVATE_FILE_MODE);
      }
      const candidate = await inspectVerifiedModelDirectory(candidateDirectory, true);
      if (!candidate) throw new LocalAsrModelInstallerError('ASR_MODEL_FILES_INVALID');
      throwIfInstallationAborted(signal);
      const installationManifest = await createLocalAsrInstallationManifest(
        candidateDirectory,
        this.#now().toISOString(),
        'github_release_archive',
        signal,
      );
      throwIfInstallationAborted(signal);
      await writeLocalAsrInstallationManifestAtomic(candidateDirectory, installationManifest);
      throwIfInstallationAborted(signal);
      if ((await verifyInstalledModelManifest(candidateDirectory, signal)).state !== 'ready') {
        throw new LocalAsrModelInstallerError('ASR_MODEL_FILES_INVALID');
      }
      throwIfInstallationAborted(signal);
      await this.#assertCandidateRuntimeReady(candidateDirectory, signal);
      throwIfInstallationAborted(signal);

      this.#setStatus('promoting', downloadResult.byteLength, null);
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.model.promotion-started',
        fields: { installedBytes: candidate.totalBytes },
      });
      await this.#promoteCandidate(candidateDirectory, backupDirectory, signal);
      const installed = await inspectVerifiedModelDirectory(this.#modelDirectory, true, true);
      if (!installed) throw new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_FAILED');
      if ((await verifyInstalledModelManifest(this.#modelDirectory)).state !== 'ready') {
        throw new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_FAILED');
      }
      await this.#finalizePromotionBackup(backupDirectory);
      await this.#removeDownloadCheckpointAfterSuccess();
      const result = await this.#createResult(
        'installed',
        downloadResult.byteLength,
        installed.totalBytes,
      );
      this.#setStatus('completed', downloadResult.byteLength, null);
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.model.install-completed',
        fields: {
          downloadedBytes: downloadResult.byteLength,
          installedBytes: installed.totalBytes,
          status: 'installed',
        },
      });
      return result;
    } catch (error) {
      let installerError = signal.aborted
        ? normalizeInstallerError(signal.reason, 'ASR_MODEL_INSTALL_CANCELLED')
        : normalizeInstallerError(error, 'ASR_MODEL_INSTALL_FAILED');
      try {
        await this.#recoverInterruptedPromotion(backupDirectory);
      } catch (recoveryError) {
        installerError = new LocalAsrModelInstallerError(
          'ASR_MODEL_INSTALL_RECOVERY_FAILED',
          recoveryError,
        );
      }
      const explicitCancellation = installerError.code === 'ASR_MODEL_INSTALL_CANCELLED';
      const invalidCheckpoint = installerError.code === 'ASR_MODEL_ARCHIVE_INTEGRITY_MISMATCH';
      if (explicitCancellation || invalidCheckpoint) {
        try {
          await this.#removeDownloadCheckpoint();
        } catch (cleanupError) {
          const cleanupFailure = new LocalAsrModelInstallerError(
            'ASR_MODEL_INSTALL_FAILED',
            cleanupError,
          );
          this.#setStatus('failed', this.#status.downloadedBytes, cleanupFailure.code);
          this.#recordDiagnostic({
            level: 'error',
            component: 'asr',
            event: 'asr.model.checkpoint-cleanup-failed',
            fields: { errorCode: cleanupFailure.code },
          });
          throw cleanupFailure;
        }
      }
      let retainedCheckpoint: ModelDownloadCheckpoint | null = null;
      let retainedDirectCheckpoint: LocalAsrDirectCheckpointStatus | null = null;
      if (!explicitCancellation && !invalidCheckpoint) {
        try {
          retainedCheckpoint = await this.#readDownloadCheckpoint();
        } catch (checkpointError) {
          const checkpointFailure = normalizeInstallerError(
            checkpointError,
            'ASR_MODEL_INSTALL_FAILED',
          );
          this.#setStatus('failed', this.#status.downloadedBytes, checkpointFailure.code);
          this.#recordDiagnostic({
            level: 'error',
            component: 'asr',
            event: 'asr.model.install-failed',
            fields: {
              errorCode: checkpointFailure.code,
              checkpointRetained: true,
            },
          });
          throw checkpointFailure;
        }
        if (this.#directDownloader) {
          retainedDirectCheckpoint = await this.#directDownloader.inspectCheckpoint(
            this.#directCheckpointDirectory(),
          ).catch(() => null);
        }
      }
      const retainDirect = this.#status.source !== 'github_release_archive';
      const retainedBytes = retainDirect
        ? retainedDirectCheckpoint?.downloadedBytes ?? this.#status.downloadedBytes
        : retainedCheckpoint?.downloadedBytes ?? this.#status.downloadedBytes;
      const retainedSource = retainDirect
        ? this.#status.source ?? 'accelerated_direct'
        : 'github_release_archive';
      if (installerError.code === 'ASR_MODEL_INSTALL_PAUSED') {
        this.#setStatus(
          'paused',
          retainedBytes,
          null,
          retainedSource,
        );
        this.#recordDiagnostic({
          level: 'info',
          component: 'asr',
          event: 'asr.model.install-paused',
          fields: {
            downloadedBytes: retainedBytes,
            reasonCode: installerError.code,
            checkpointRetained:
              retainedCheckpoint !== null || retainedDirectCheckpoint !== null,
          },
        });
      } else {
        this.#setStatus(
          explicitCancellation ? 'cancelled' : 'failed',
          explicitCancellation ? 0 : retainedBytes,
          installerError.code,
          retainedSource,
        );
      }
      if (installerError.code !== 'ASR_MODEL_INSTALL_PAUSED') {
        this.#recordDiagnostic({
          level: explicitCancellation ? 'warn' : 'error',
          component: 'asr',
          event: 'asr.model.install-failed',
          fields: {
            errorCode: installerError.code,
            checkpointRetained:
              retainedCheckpoint !== null || retainedDirectCheckpoint !== null,
          },
        });
      }
      throw installerError;
    } finally {
      if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #installDirectModel(
    signal: AbortSignal,
    modelParent: string,
    backupDirectory: string,
  ): Promise<InstallLocalAsrModelOutput> {
    if (!this.#directDownloader) {
      throw new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_FAILED');
    }
    const checkpointDirectory = this.#directCheckpointDirectory();
    let checkpoint: LocalAsrDirectCheckpointStatus;
    try {
      checkpoint = await this.#directDownloader.inspectCheckpoint(checkpointDirectory);
    } catch (error) {
      if (
        !(error instanceof LocalAsrDirectDownloadError)
        || error.code !== 'ASR_MODEL_DIRECT_CHECKPOINT_INVALID'
      ) throw error;
      await removeLocalAsrDirectCheckpoint(checkpointDirectory);
      checkpoint = await this.#directDownloader.inspectCheckpoint(checkpointDirectory);
      if (checkpoint.downloadedBytes !== 0) throw error;
      this.#recordDiagnostic({
        level: 'warn',
        component: 'asr',
        event: 'asr.model.direct-checkpoint-reset-before-retry',
        fields: { reasonCode: error.code },
      });
    }
    const remainingDownloadBytes = Math.max(
      0,
      LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH - checkpoint.downloadedBytes,
    );
    let availableDiskBytes: number;
    try {
      availableDiskBytes = await this.#getAvailableDiskBytes(modelParent);
    } catch (error) {
      throw new LocalAsrModelInstallerError('ASR_MODEL_DISK_CHECK_FAILED', error);
    }
    const requiredFreeBytes = remainingDownloadBytes
      + LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH
      + INSTALLATION_DISK_SAFETY_MARGIN_BYTES;
    if (
      !Number.isSafeInteger(availableDiskBytes)
      || availableDiskBytes < requiredFreeBytes
    ) throw new LocalAsrModelInstallerError('ASR_MODEL_INSUFFICIENT_DISK');
    this.#recordDiagnostic({
      level: 'info',
      component: 'asr',
      event: 'asr.model.direct-disk-preflight-completed',
      fields: {
        availableBytes: availableDiskBytes,
        requiredBytes: requiredFreeBytes,
        resumeFromBytes: checkpoint.downloadedBytes,
      },
    });
    throwIfInstallationAborted(signal);

    let workspace: string | null = await mkdtemp(path.join(modelParent, '.phrio-asr-install-'));
    await chmod(workspace, PRIVATE_DIRECTORY_MODE);
    const candidateDirectory = path.join(workspace, 'candidate');
    await mkdir(candidateDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    try {
      const sourceOrder: LocalAsrDirectSourceId[] = [
        'hf_mirror_acceleration',
        'huggingface_official',
      ];
      let officialIntegrityRetryScheduled = false;
      let invalidCheckpointRetryScheduled = false;
      let downloadResult: LocalAsrDirectDownloadResult | null = null;
      let lastSourceError: unknown = null;
      for (let sourceIndex = 0; sourceIndex < sourceOrder.length; sourceIndex += 1) {
        const source = sourceOrder[sourceIndex]!;
        throwIfInstallationAborted(signal);
        const checkpointStatus = await this.#directDownloader.inspectCheckpoint(
          checkpointDirectory,
        );
        let statusSource: 'accelerated_direct' | 'huggingface_direct' =
          source === 'hf_mirror_acceleration'
          ? 'accelerated_direct'
          : 'huggingface_direct';
        this.#lastLoggedDownloadPercent = Math.floor(
          (checkpointStatus.downloadedBytes / checkpointStatus.expectedBytes) * 100,
        );
        this.#setStatus('downloading', checkpointStatus.downloadedBytes, null, statusSource);
        this.#recordDiagnostic({
          level: 'info',
          component: 'asr',
          event: 'asr.model.direct-source-started',
          fields: {
            source,
            downloadedBytes: checkpointStatus.downloadedBytes,
            expectedBytes: checkpointStatus.expectedBytes,
          },
        });
        try {
          downloadResult = await this.#directDownloader.download({
            checkpointDirectory,
            destinationDirectory: candidateDirectory,
            source,
            signal,
            onProgress: (progress) => {
              if (!signal.aborted && this.#status.stage === 'downloading') {
                this.#setStatus('downloading', progress.downloadedBytes, null, statusSource);
                this.#recordDownloadProgressMilestone(progress.downloadedBytes);
              }
            },
            onDiagnostic: (event, fields) => {
              if (
                event === 'direct-mirror-entry-migrated'
                && statusSource === 'accelerated_direct'
              ) {
                statusSource = 'huggingface_direct';
                if (this.#status.stage === 'downloading') {
                  this.#setStatus(
                    'downloading',
                    this.#status.downloadedBytes,
                    null,
                    statusSource,
                  );
                }
              }
              this.#recordDiagnostic({
                level: event.endsWith('-failed') ? 'warn' : 'info',
                component: 'asr',
                event: `asr.model.${event}`,
                fields,
              });
            },
          });
          break;
        } catch (error) {
          throwIfInstallationAborted(signal);
          if (!isRecoverableDirectDownloadError(error)) throw error;
          lastSourceError = error;
          this.#lastRecoverableErrorCode = directErrorToInstallerCode(error);
          this.#recordDiagnostic({
            level: 'warn',
            component: 'asr',
            event: 'asr.model.direct-source-failed',
            fields: {
              source,
              errorCode: directErrorToInstallerCode(error),
            },
          });
          if (
            error instanceof LocalAsrDirectDownloadError
            && error.code === 'ASR_MODEL_DIRECT_CHECKPOINT_INVALID'
          ) {
            if (invalidCheckpointRetryScheduled) throw error;
            invalidCheckpointRetryScheduled = true;
            await removeLocalAsrDirectCheckpoint(checkpointDirectory);
            await rm(candidateDirectory, { recursive: true, force: true });
            await mkdir(candidateDirectory, { mode: PRIVATE_DIRECTORY_MODE });
            await chmod(candidateDirectory, PRIVATE_DIRECTORY_MODE);
            const cleanCheckpoint = await this.#directDownloader.inspectCheckpoint(
              checkpointDirectory,
            );
            if (cleanCheckpoint.downloadedBytes !== 0) throw error;
            sourceOrder.splice(sourceIndex + 1, 0, source);
            this.#recordDiagnostic({
              level: 'warn',
              component: 'asr',
              event: 'asr.model.direct-checkpoint-reset-before-retry',
              fields: { reasonCode: error.code, source },
            });
            continue;
          }
          if (
            error instanceof LocalAsrDirectDownloadError
            && error.code === 'ASR_MODEL_DIRECT_INTEGRITY_MISMATCH'
          ) {
            await removeLocalAsrDirectCheckpoint(checkpointDirectory);
            await rm(candidateDirectory, { recursive: true, force: true });
            await mkdir(candidateDirectory, { mode: PRIVATE_DIRECTORY_MODE });
            await chmod(candidateDirectory, PRIVATE_DIRECTORY_MODE);
            const cleanCheckpoint = await this.#directDownloader.inspectCheckpoint(
              checkpointDirectory,
            );
            if (cleanCheckpoint.downloadedBytes !== 0) {
              throw new LocalAsrDirectDownloadError(
                'ASR_MODEL_DIRECT_CHECKPOINT_INVALID',
              );
            }
            this.#recordDiagnostic({
              level: 'warn',
              component: 'asr',
              event: 'asr.model.direct-cross-source-reset-completed',
              fields: { failedSource: source },
            });
            if (source === 'huggingface_official' && !officialIntegrityRetryScheduled) {
              officialIntegrityRetryScheduled = true;
              sourceOrder.push('huggingface_official');
              this.#recordDiagnostic({
                level: 'warn',
                component: 'asr',
                event: 'asr.model.official-integrity-retry-scheduled',
                fields: { cleanCheckpoint: true },
              });
            }
          }
        }
      }
      if (!downloadResult) throw lastSourceError
        ?? new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_DOWNLOAD_FAILED');
      if (
        downloadResult.downloadedBytes !== LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH
        || downloadResult.expectedBytes !== LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH
      ) throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_INTEGRITY_MISMATCH');

      const receiptRoute = downloadResult.resolvedSource === 'hf_mirror_acceleration'
        ? 'accelerated_direct'
        : 'huggingface_direct';
      this.#setStatus(
        'verifying',
        downloadResult.downloadedBytes,
        null,
        receiptRoute,
      );
      for (const name of LOCAL_ASR_MODEL_FILE_NAMES) {
        throwIfInstallationAborted(signal);
        await assertValidModelFile(path.join(candidateDirectory, name), name);
        await chmod(path.join(candidateDirectory, name), PRIVATE_FILE_MODE);
      }
      const candidate = await inspectVerifiedModelDirectory(candidateDirectory, true);
      if (!candidate) throw new LocalAsrDirectDownloadError(
        'ASR_MODEL_DIRECT_INTEGRITY_MISMATCH',
      );
      const installationManifest = await createLocalAsrInstallationManifest(
        candidateDirectory,
        this.#now().toISOString(),
        receiptRoute,
        signal,
      );
      throwIfInstallationAborted(signal);
      await writeLocalAsrInstallationManifestAtomic(candidateDirectory, installationManifest);
      throwIfInstallationAborted(signal);
      if ((await verifyInstalledModelManifest(candidateDirectory, signal)).state !== 'ready') {
        throw new LocalAsrDirectDownloadError('ASR_MODEL_DIRECT_INTEGRITY_MISMATCH');
      }
      throwIfInstallationAborted(signal);
      await this.#assertCandidateRuntimeReady(candidateDirectory, signal);
      throwIfInstallationAborted(signal);

      this.#setStatus(
        'promoting',
        downloadResult.downloadedBytes,
        null,
        receiptRoute,
      );
      await this.#promoteCandidate(candidateDirectory, backupDirectory, signal);
      const installed = await inspectVerifiedModelDirectory(this.#modelDirectory, true, true);
      if (!installed || (await verifyInstalledModelManifest(this.#modelDirectory)).state !== 'ready') {
        throw new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_FAILED');
      }
      await this.#finalizePromotionBackup(backupDirectory);
      await this.#removeDownloadCheckpointAfterSuccess();
      const result = await this.#createResult(
        'installed',
        0,
        installed.totalBytes,
        receiptRoute,
        downloadResult.downloadedBytes,
      );
      this.#setStatus(
        'completed',
        downloadResult.downloadedBytes,
        null,
        receiptRoute,
      );
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.model.install-completed',
        fields: {
          downloadedBytes: downloadResult.downloadedBytes,
          installedBytes: installed.totalBytes,
          source: downloadResult.resolvedSource,
          status: 'installed',
        },
      });
      return result;
    } finally {
      if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      workspace = null;
    }
  }

  async #prepareModelParent(hydrateCheckpointStatus: boolean): Promise<void> {
    const modelParent = path.dirname(this.#modelDirectory);
    const backupDirectory = path.join(
      modelParent,
      `.${path.basename(this.#modelDirectory)}.previous`,
    );
    await ensurePrivateDirectory(modelParent);
    await this.#recoverInterruptedPromotion(backupDirectory);
    await this.#migrateLegacyDownloadCheckpoint(modelParent);
    const removedWorkspaceCount = await cleanupStaleInstallationWorkspaces(modelParent);
    if (removedWorkspaceCount > 0) {
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.model.stale-workspaces-cleaned',
        fields: { removedWorkspaceCount },
      });
    }
    if (!hydrateCheckpointStatus) return;
    const installed = await inspectVerifiedModelDirectory(this.#modelDirectory, false);
    const installedManifest = installed
      ? await verifyInstalledModelManifest(this.#modelDirectory)
      : null;
    if (installed && installedManifest?.state === 'ready') {
      await this.#removeDownloadCheckpointAfterSuccess();
      return;
    }
    if (this.#directDownloader) {
      try {
        const directCheckpoint = await this.#directDownloader.inspectCheckpoint(
          this.#directCheckpointDirectory(),
        );
        if (directCheckpoint.downloadedBytes > 0) {
          this.#lastLoggedDownloadPercent = Math.floor(
            (directCheckpoint.downloadedBytes / directCheckpoint.expectedBytes) * 100,
          );
          this.#setStatus(
            'paused',
            directCheckpoint.downloadedBytes,
            null,
            'accelerated_direct',
          );
          this.#recordDiagnostic({
            level: 'info',
            component: 'asr',
            event: 'asr.model.direct-checkpoint-restored',
            fields: {
              downloadedBytes: directCheckpoint.downloadedBytes,
              expectedBytes: directCheckpoint.expectedBytes,
            },
          });
          return;
        }
      } catch (error) {
        if (
          error instanceof LocalAsrDirectDownloadError
          && error.code === 'ASR_MODEL_DIRECT_CHECKPOINT_INVALID'
        ) {
          await removeLocalAsrDirectCheckpoint(this.#directCheckpointDirectory());
          this.#recordDiagnostic({
            level: 'warn',
            component: 'asr',
            event: 'asr.model.direct-checkpoint-discarded',
            fields: { reasonCode: error.code },
          });
        } else {
          throw new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_FAILED', error);
        }
      }
    }
    const checkpoint = await this.#readDownloadCheckpoint();
    if (!checkpoint) return;
    this.#lastLoggedDownloadPercent = Math.floor(
      (checkpoint.downloadedBytes / LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH) * 100,
    );
    this.#setStatus('paused', checkpoint.downloadedBytes, null, 'github_release_archive');
    this.#recordDiagnostic({
      level: 'info',
      component: 'asr',
      event: 'asr.model.checkpoint-restored',
      fields: {
        downloadedBytes: checkpoint.downloadedBytes,
        expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
        validatorPresent:
          checkpoint.manifest.etag !== null || checkpoint.manifest.lastModified !== null,
      },
    });
  }

  #checkpointDirectory(): string {
    return path.join(path.dirname(this.#modelDirectory), DOWNLOAD_CHECKPOINT_DIRECTORY);
  }

  #directCheckpointDirectory(): string {
    return path.join(
      path.dirname(this.#modelDirectory),
      LOCAL_ASR_DIRECT_CHECKPOINT_DIRECTORY_NAME,
    );
  }

  async #createDownloadCheckpoint(): Promise<ModelDownloadCheckpoint> {
    const directoryPath = this.#checkpointDirectory();
    await ensurePrivateDirectory(directoryPath);
    const archivePath = path.join(directoryPath, DOWNLOAD_CHECKPOINT_ARCHIVE);
    const manifestPath = path.join(directoryPath, DOWNLOAD_CHECKPOINT_MANIFEST);
    await writeFile(archivePath, new Uint8Array(), {
      flag: 'w',
      mode: PRIVATE_FILE_MODE,
    });
    await chmod(archivePath, PRIVATE_FILE_MODE);
    const manifest = createDownloadCheckpointManifest();
    await this.#writeDownloadCheckpointManifest(manifest);
    this.#recordDiagnostic({
      level: 'info',
      component: 'asr',
      event: 'asr.model.checkpoint-created',
      fields: {},
    });
    return {
      directoryPath,
      archivePath,
      manifestPath,
      downloadedBytes: 0,
      manifest,
    };
  }

  async #readDownloadCheckpoint(): Promise<ModelDownloadCheckpoint | null> {
    const directoryPath = this.#checkpointDirectory();
    const archivePath = path.join(directoryPath, DOWNLOAD_CHECKPOINT_ARCHIVE);
    const manifestPath = path.join(directoryPath, DOWNLOAD_CHECKPOINT_MANIFEST);
    try {
      const directoryMetadata = await lstatOrNull(directoryPath);
      if (!directoryMetadata) return null;
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
        throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID');
      }
      const manifestMetadata = await lstat(manifestPath);
      if (
        !manifestMetadata.isFile()
        || manifestMetadata.isSymbolicLink()
        || manifestMetadata.nlink !== 1
        || manifestMetadata.size < 2
        || manifestMetadata.size > DOWNLOAD_CHECKPOINT_MANIFEST_MAXIMUM_BYTES
      ) {
        throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID');
      }
      const manifest = parseDownloadCheckpointManifest(await readFile(manifestPath, 'utf8'));
      const archiveMetadata = await lstat(archivePath);
      if (
        !archiveMetadata.isFile()
        || archiveMetadata.isSymbolicLink()
        || archiveMetadata.nlink !== 1
        || archiveMetadata.size < 0
        || archiveMetadata.size > LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
      ) {
        throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID');
      }
      await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
      await chmod(archivePath, PRIVATE_FILE_MODE);
      await chmod(manifestPath, PRIVATE_FILE_MODE);
      return {
        directoryPath,
        archivePath,
        manifestPath,
        downloadedBytes: archiveMetadata.size,
        manifest,
      };
    } catch (error) {
      const explicitlyInvalid = isInstallerErrorCode(error, 'ASR_MODEL_CHECKPOINT_INVALID')
        || nodeErrorCode(error) === 'ENOENT';
      if (!explicitlyInvalid) {
        this.#recordDiagnostic({
          level: 'error',
          component: 'asr',
          event: 'asr.model.checkpoint-access-failed',
          fields: {
            errorCode: nodeErrorCode(error) ?? 'ASR_MODEL_INSTALL_FAILED',
            checkpointRetained: true,
          },
        });
        throw new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_FAILED', error);
      }
      try {
        await rm(directoryPath, { recursive: true, force: true });
      } catch (cleanupError) {
        this.#recordDiagnostic({
          level: 'error',
          component: 'asr',
          event: 'asr.model.checkpoint-cleanup-failed',
          fields: {
            errorCode: nodeErrorCode(cleanupError) ?? 'ASR_MODEL_INSTALL_FAILED',
            checkpointRetained: true,
          },
        });
        throw new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_FAILED', cleanupError);
      }
      this.#recordDiagnostic({
        level: 'warn',
        component: 'asr',
        event: 'asr.model.checkpoint-discarded',
        fields: { reasonCode: 'ASR_MODEL_CHECKPOINT_INVALID' },
      });
      return null;
    }
  }

  async #writeDownloadCheckpointManifest(
    manifest: ModelDownloadCheckpointManifest,
  ): Promise<void> {
    const directoryPath = this.#checkpointDirectory();
    await ensurePrivateDirectory(directoryPath);
    const manifestPath = path.join(directoryPath, DOWNLOAD_CHECKPOINT_MANIFEST);
    const temporaryPath = `${manifestPath}.tmp`;
    await rm(temporaryPath, { force: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(manifest)}\n`, {
        flag: 'wx',
        mode: PRIVATE_FILE_MODE,
      });
      await chmod(temporaryPath, PRIVATE_FILE_MODE);
      await rename(temporaryPath, manifestPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async #removeDownloadCheckpoint(): Promise<void> {
    await Promise.all([
      rm(this.#checkpointDirectory(), { recursive: true, force: true }),
      removeLocalAsrDirectCheckpoint(this.#directCheckpointDirectory()),
    ]);
  }

  async #removeDownloadCheckpointAfterSuccess(): Promise<void> {
    try {
      await this.#removeDownloadCheckpoint();
    } catch {
      this.#recordDiagnostic({
        level: 'warn',
        component: 'asr',
        event: 'asr.model.checkpoint-cleanup-failed',
        fields: { installedModelReady: true },
      });
    }
  }

  async #migrateLegacyDownloadCheckpoint(modelParent: string): Promise<void> {
    const entries = await readdir(modelParent, { withFileTypes: true });
    let bestLegacyArchive: { readonly path: string; readonly size: number } | null = null;
    for (const entry of entries) {
      if (!entry.name.startsWith('.phrio-asr-install-') || !entry.isDirectory()) continue;
      const archivePath = path.join(modelParent, entry.name, 'model.tar.bz2');
      try {
        const metadata = await lstat(archivePath);
        if (
          !metadata.isFile()
          || metadata.isSymbolicLink()
          || metadata.nlink !== 1
          || metadata.size <= 0
          || metadata.size > LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
          || (bestLegacyArchive && metadata.size <= bestLegacyArchive.size)
        ) continue;
        bestLegacyArchive = { path: archivePath, size: metadata.size };
      } catch {
        // Other stale workspaces are removed by the normal cleanup below.
      }
    }
    if (!bestLegacyArchive) return;

    let checkpoint = await this.#readDownloadCheckpoint();
    if (checkpoint && checkpoint.downloadedBytes >= bestLegacyArchive.size) return;
    checkpoint ??= await this.#createDownloadCheckpoint();
    let legacyMoved = false;
    try {
      // Both paths are children of modelParent. On the supported desktop
      // platform this is an atomic same-filesystem replacement and therefore
      // never needs a second, potentially 1 GB, copy before disk preflight.
      await rename(bestLegacyArchive.path, checkpoint.archivePath);
      legacyMoved = true;
      await chmod(checkpoint.archivePath, PRIVATE_FILE_MODE);
      const migrated = await assertValidPartialArchive(
        checkpoint.archivePath,
        LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      );
      if (migrated.size !== bestLegacyArchive.size) {
        throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID');
      }
      try {
        await this.#writeDownloadCheckpointManifest(createDownloadCheckpointManifest());
      } catch (error) {
        // The old manifest still describes the same frozen source and SHA. A
        // stale validator can only make the CDN answer 200, which safely
        // restarts the file through the normal download path.
        this.#recordDiagnostic({
          level: 'warn',
          component: 'asr',
          event: 'asr.model.legacy-checkpoint-manifest-reset-failed',
          fields: { errorCode: nodeErrorCode(error) ?? 'ASR_MODEL_INSTALL_FAILED' },
        });
      }
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.model.legacy-checkpoint-migrated',
        fields: {
          migratedBytes: bestLegacyArchive.size,
          replacedCheckpointBytes: checkpoint.downloadedBytes,
        },
      });
    } catch (error) {
      // A rename failure leaves both source and current checkpoint unchanged.
      // Do not turn it into a permanent startup loop: normal stale-workspace
      // cleanup below removes the unusable legacy source and installation can
      // continue from the deterministic checkpoint.
      this.#recordDiagnostic({
        level: 'warn',
        component: 'asr',
        event: legacyMoved
          ? 'asr.model.legacy-checkpoint-post-migration-failed'
          : 'asr.model.legacy-checkpoint-migration-skipped',
        fields: {
          errorCode: isInstallerErrorCode(error, 'ASR_MODEL_CHECKPOINT_INVALID')
            ? 'ASR_MODEL_CHECKPOINT_INVALID'
            : nodeErrorCode(error) ?? 'ASR_MODEL_INSTALL_FAILED',
          retainedCheckpointBytes: legacyMoved
            ? bestLegacyArchive.size
            : checkpoint.downloadedBytes,
        },
      });
    }
  }

  async #createResult(
    outcome: InstallLocalAsrModelOutput['outcome'],
    downloadedArchiveBytes: number,
    installedModelBytes: number,
    sourceUsed: NonNullable<InstallLocalAsrModelOutput['sourceUsed']> =
      'github_release_archive',
    validatedDownloadBytes = downloadedArchiveBytes,
  ): Promise<InstallLocalAsrModelOutput> {
    const files = await Promise.all(LOCAL_ASR_MODEL_FILE_NAMES.map(async (name) => {
      const modelPath = path.join(this.#modelDirectory, name);
      try {
        const metadata = await lstat(modelPath);
        const exists = metadata.isFile() && !metadata.isSymbolicLink();
        if (!exists) return { name, exists: false, readable: false } as const;
        await access(modelPath, constants.R_OK);
        return { name, exists: true, readable: true } as const;
      } catch {
        return { name, exists: false, readable: false } as const;
      }
    }));
    const ready = files.every((file) => file.readable);
    return {
      outcome,
      downloadedArchiveBytes,
      validatedDownloadBytes: outcome === 'already_installed' ? 0 : validatedDownloadBytes,
      sourceUsed: outcome === 'already_installed' ? null : sourceUsed,
      installedModelBytes,
      completedAt: this.#now().toISOString(),
      localAsr: { state: ready ? 'ready' : 'corrupt', ready, files },
    };
  }

  async #assertCandidateRuntimeReady(
    candidateDirectory: string,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfInstallationAborted(signal);
    if (!this.#verifyCandidateRuntime) return;
    let ready: boolean;
    try {
      ready = await raceWithInstallationAbort(
        Promise.resolve().then(() => this.#verifyCandidateRuntime!(candidateDirectory, signal)),
        signal,
      );
    } catch (error) {
      throwIfInstallationAborted(signal);
      throw new LocalAsrModelInstallerError('ASR_MODEL_RUNTIME_INIT_FAILED', error);
    }
    throwIfInstallationAborted(signal);
    if (!ready) throw new LocalAsrModelInstallerError('ASR_MODEL_RUNTIME_INIT_FAILED');
  }

  async #recoverInterruptedPromotion(backupDirectory: string): Promise<void> {
    const [currentExists, backupExists] = await Promise.all([
      pathExists(this.#modelDirectory),
      pathExists(backupDirectory),
    ]);
    if (!backupExists) return;
    if (!currentExists) {
      const backup = await inspectInstalledModelDirectoryWithReceipt(backupDirectory);
      if (backup) {
        await rename(backupDirectory, this.#modelDirectory);
        this.#recordDiagnostic({
          level: 'warn',
          component: 'asr',
          event: 'asr.model.promotion-rollback-completed',
          fields: { replacedInvalidCurrent: false },
        });
      } else {
        await rm(backupDirectory, { recursive: true, force: true });
        this.#recordDiagnostic({
          level: 'warn',
          component: 'asr',
          event: 'asr.model.invalid-promotion-state-discarded',
          fields: { currentPresent: false, backupValid: false },
        });
      }
      return;
    }

    const current = await inspectInstalledModelDirectoryWithReceipt(this.#modelDirectory);
    if (current) {
      await rm(backupDirectory, { recursive: true, force: true });
      return;
    }
    const backup = await inspectInstalledModelDirectoryWithReceipt(backupDirectory);
    if (!backup) {
      await Promise.all([
        rm(this.#modelDirectory, { recursive: true, force: true }),
        rm(backupDirectory, { recursive: true, force: true }),
      ]);
      this.#recordDiagnostic({
        level: 'warn',
        component: 'asr',
        event: 'asr.model.invalid-promotion-state-discarded',
        fields: { currentPresent: true, backupValid: false },
      });
      return;
    }

    const interruptedDirectory = `${this.#modelDirectory}.interrupted`;
    await rm(interruptedDirectory, { recursive: true, force: true });
    await rename(this.#modelDirectory, interruptedDirectory);
    try {
      await rename(backupDirectory, this.#modelDirectory);
    } catch (error) {
      await rename(interruptedDirectory, this.#modelDirectory).catch(() => undefined);
      throw new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_RECOVERY_FAILED', error);
    }
    await rm(interruptedDirectory, { recursive: true, force: true });
    this.#recordDiagnostic({
      level: 'warn',
      component: 'asr',
      event: 'asr.model.promotion-rollback-completed',
      fields: { replacedInvalidCurrent: true },
    });
  }

  async #promoteCandidate(
    candidateDirectory: string,
    backupDirectory: string,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfInstallationAborted(signal);
    const existing = await pathExists(this.#modelDirectory);
    throwIfInstallationAborted(signal);
    const backupExists = await pathExists(backupDirectory);
    throwIfInstallationAborted(signal);
    if (backupExists) {
      throw new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_RECOVERY_FAILED');
    }
    // This is the commit boundary. Once the first rename starts, finish the
    // atomic promotion/rollback sequence rather than observing a late abort.
    throwIfInstallationAborted(signal);
    if (existing) await rename(this.#modelDirectory, backupDirectory);
    try {
      await rename(candidateDirectory, this.#modelDirectory);
    } catch (error) {
      if (existing) await rename(backupDirectory, this.#modelDirectory).catch(() => undefined);
      throw new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_FAILED', error);
    }
  }

  async #finalizePromotionBackup(backupDirectory: string): Promise<void> {
    if (!(await pathExists(backupDirectory))) return;
    try {
      await rm(backupDirectory, { recursive: true, force: true });
    } catch {
      // The candidate has already passed receipt and runtime validation. A
      // retained backup is safe: startup recovery validates the current
      // receipt before deciding which side to keep.
      this.#recordDiagnostic({
        level: 'warn',
        component: 'asr',
        event: 'asr.model.promotion-backup-cleanup-failed',
        fields: {},
      });
    }
  }

  #recordDiagnostic(input: RecordDiagnosticEventInput): void {
    try {
      this.#diagnostics?.record(input);
    } catch {
      // Model installation must not be gated by observational diagnostics.
    }
  }

  #setStatus(
    stage: GetLocalAsrModelInstallStatusOutput['stage'],
    downloadedBytes: number,
    errorCode: LocalAsrModelInstallerErrorCode | null,
    source: NonNullable<GetLocalAsrModelInstallStatusOutput['source']> =
      this.#status.source ?? 'github_release_archive',
  ): void {
    const expectedBytes = source === 'github_release_archive'
      ? LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
      : LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH;
    const boundedDownloadedBytes = Math.min(
      expectedBytes,
      Math.max(0, Math.trunc(downloadedBytes)),
    );
    this.#status = {
      stage,
      downloadedBytes: boundedDownloadedBytes,
      expectedBytes,
      source,
      lastRecoverableErrorCode: this.#lastRecoverableErrorCode,
      cancellable:
        stage === 'preparing'
        || stage === 'downloading'
        || stage === 'verifying'
        || stage === 'extracting'
        || stage === 'paused',
      errorCode,
      updatedAt: this.#now().toISOString(),
    };
  }

  #recordDownloadProgressMilestone(downloadedBytes: number): void {
    const expectedBytes = this.#status.expectedBytes;
    const percentage = Math.floor(
      (downloadedBytes / expectedBytes) * 100,
    );
    const milestone = Math.min(100, percentage);
    if (milestone < 1 || milestone <= this.#lastLoggedDownloadPercent) return;
    this.#lastLoggedDownloadPercent = milestone;
    this.#recordDiagnostic({
      level: 'info',
      component: 'asr',
      event: 'asr.model.download-progress',
      fields: {
        downloadedBytes,
        expectedBytes,
        percentage: milestone,
      },
    });
  }
}

export type LocalAsrModelInstallerErrorCode =
  | 'ASR_MODEL_DOWNLOAD_FAILED'
  | 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED'
  | 'ASR_MODEL_DIRECT_RANGE_REJECTED'
  | 'ASR_MODEL_DIRECT_REDIRECT_REJECTED'
  | 'ASR_MODEL_DIRECT_INTEGRITY_MISMATCH'
  | 'ASR_MODEL_DIRECT_CHECKPOINT_INVALID'
  | 'ASR_MODEL_REDIRECT_REJECTED'
  | 'ASR_MODEL_RESUME_REJECTED'
  | 'ASR_MODEL_CHECKPOINT_INVALID'
  | 'ASR_MODEL_DISK_CHECK_FAILED'
  | 'ASR_MODEL_INSUFFICIENT_DISK'
  | 'ASR_MODEL_ARCHIVE_SIZE_MISMATCH'
  | 'ASR_MODEL_ARCHIVE_INTEGRITY_MISMATCH'
  | 'ASR_MODEL_ARCHIVE_INVALID'
  | 'ASR_MODEL_FILES_INVALID'
  | 'ASR_MODEL_RUNTIME_INIT_FAILED'
  | 'ASR_MODEL_INSTALL_CANCELLED'
  | 'ASR_MODEL_INSTALL_PAUSED'
  | 'ASR_MODEL_INSTALL_TIMEOUT'
  | 'ASR_MODEL_INSTALL_RECOVERY_FAILED'
  | 'ASR_MODEL_INSTALL_FAILED';

export class LocalAsrModelInstallerError extends Error {
  readonly code: LocalAsrModelInstallerErrorCode;

  constructor(code: LocalAsrModelInstallerErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'LocalAsrModelInstallerError';
    this.code = code;
  }
}

/** Restricts both the fixed source URL and every redirect target. */
export function assertTrustedLocalAsrModelDownloadUrl(rawUrl: string, redirectDepth: number): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_REDIRECT_REJECTED', error);
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || (url.port !== '' && url.port !== '443')
    || url.hash !== ''
  ) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_REDIRECT_REJECTED');
  }
  if (redirectDepth === 0) {
    if (url.href !== LOCAL_ASR_MODEL_ARCHIVE_URL) {
      throw new LocalAsrModelInstallerError('ASR_MODEL_REDIRECT_REJECTED');
    }
    return url;
  }
  if (
    url.hostname !== 'release-assets.githubusercontent.com'
    || !url.pathname.startsWith('/github-production-release-asset/531380835/')
  ) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_REDIRECT_REJECTED');
  }
  return url;
}

export async function downloadOfficialLocalAsrModelArchive(
  input: ModelArchiveDownloadInput,
): Promise<ModelArchiveDownloadResult> {
  if (
    input.expectedBytes !== LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
    || input.maximumBytes !== LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
  ) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_ARCHIVE_SIZE_MISMATCH');
  }
  if (input.expectedSha256 !== LOCAL_ASR_MODEL_ARCHIVE_SHA256) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_ARCHIVE_INTEGRITY_MISMATCH');
  }
  throwIfInstallationAborted(input.signal);
  const initialMetadata: ModelArchiveResponseMetadata = {
    etag: normalizeHttpValidator(input.ifRange?.startsWith('"') ? input.ifRange : null),
    lastModified: normalizeHttpValidator(input.ifRange?.startsWith('"') ? null : input.ifRange),
  };
  let responseMetadata = initialMetadata;
  const requestGet = input.requestGet ?? https.get;

  for (let attempt = 1; attempt <= MAXIMUM_DOWNLOAD_ATTEMPTS; attempt += 1) {
    throwIfInstallationAborted(input.signal);
    const archiveMetadata = await assertValidPartialArchive(
      input.destinationPath,
      input.expectedBytes,
    );
    if (archiveMetadata.size < input.resumeFromBytes && attempt === 1) {
      throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID');
    }
    if (archiveMetadata.size === input.expectedBytes) {
      const archiveHash = await hashArchivePrefix(
        input.destinationPath,
        input.expectedBytes,
        input.signal,
      );
      const sha256 = archiveHash.digest('hex');
      if (sha256 !== input.expectedSha256) {
        throw new LocalAsrModelInstallerError('ASR_MODEL_ARCHIVE_INTEGRITY_MISMATCH');
      }
      input.onProgress(input.expectedBytes);
      return { byteLength: input.expectedBytes, sha256 };
    }

    const attemptOffset = archiveMetadata.size;
    const prefixHash = await hashArchivePrefix(
      input.destinationPath,
      attemptOffset,
      input.signal,
    );
    emitDownloadDiagnostic(input, 'download-attempt-started', {
      attempt,
      maximumAttempts: MAXIMUM_DOWNLOAD_ATTEMPTS,
      offsetBytes: attemptOffset,
      ifRangePresent: selectIfRange(responseMetadata) !== null,
    });
    try {
      const result = await downloadOfficialArchiveAttempt({
        ...input,
        requestGet,
        attempt,
        prefixHash,
        resumeFromBytes: attemptOffset,
        ifRange: selectIfRange(responseMetadata),
        onResponseMetadata: async (metadata) => {
          responseMetadata = metadata;
          await input.onResponseMetadata(metadata);
        },
      });
      emitDownloadDiagnostic(input, 'download-attempt-completed', {
        attempt,
        offsetBytes: attemptOffset,
        downloadedBytes: result.byteLength,
      });
      return result;
    } catch (error) {
      if (input.signal.aborted) {
        throw normalizeInstallerError(input.signal.reason, 'ASR_MODEL_INSTALL_CANCELLED');
      }
      const installerError = normalizeInstallerError(error, 'ASR_MODEL_DOWNLOAD_FAILED');
      emitDownloadDiagnostic(input, 'download-attempt-failed', {
        attempt,
        offsetBytes: attemptOffset,
        errorCode: installerError.code,
      });
      if (
        installerError.code !== 'ASR_MODEL_DOWNLOAD_FAILED'
        || attempt === MAXIMUM_DOWNLOAD_ATTEMPTS
      ) {
        throw installerError;
      }
      const delayMilliseconds = downloadRetryDelayMilliseconds(attempt);
      emitDownloadDiagnostic(input, 'download-retry-scheduled', {
        attempt,
        nextAttempt: attempt + 1,
        delayMilliseconds,
      });
      await waitForDownloadRetry(attempt, input.signal);
    }
  }
  throw new LocalAsrModelInstallerError('ASR_MODEL_DOWNLOAD_FAILED');
}

interface OfficialArchiveAttemptInput extends ModelArchiveDownloadInput {
  readonly requestGet: ModelHttpsGet;
  readonly attempt: number;
  readonly prefixHash: ReturnType<typeof createHash>;
}

async function downloadOfficialArchiveAttempt(
  input: OfficialArchiveAttemptInput,
): Promise<ModelArchiveDownloadResult> {
  const download = async (
    rawUrl: string,
    redirectDepth: number,
  ): Promise<ModelArchiveDownloadResult> => {
    if (redirectDepth > MAXIMUM_REDIRECTS) {
      throw new LocalAsrModelInstallerError('ASR_MODEL_REDIRECT_REJECTED');
    }
    const url = assertTrustedLocalAsrModelDownloadUrl(rawUrl, redirectDepth);
    const requestHeaders: Record<string, string> = {
      Accept: 'application/octet-stream',
      'Accept-Encoding': 'identity',
      'User-Agent': 'Phrio-local-model-installer/0.1',
    };
    if (input.resumeFromBytes > 0) {
      requestHeaders.Range = `bytes=${input.resumeFromBytes}-`;
      if (input.ifRange) requestHeaders['If-Range'] = input.ifRange;
    }

    const responseLease = await requestOfficialArchiveResponse(input, url, requestHeaders);
    const { response } = responseLease;
    try {
      const statusCode = response.statusCode ?? 0;
      emitDownloadDiagnostic(input, 'download-response-received', {
        attempt: input.attempt,
        redirectDepth,
        offsetBytes: input.resumeFromBytes,
        statusCode,
      });
      if (statusCode >= 300 && statusCode < 400) {
        const location = response.headers.location;
        await disposeDownloadResponse(response);
        if (!location) {
          throw new LocalAsrModelInstallerError('ASR_MODEL_REDIRECT_REJECTED');
        }
        let target: string;
        try {
          target = new URL(location, url).href;
        } catch (error) {
          throw new LocalAsrModelInstallerError('ASR_MODEL_REDIRECT_REJECTED', error);
        }
        return download(target, redirectDepth + 1);
      }

      const isResume = input.resumeFromBytes > 0;
      const serverRestartedDownload = isResume && statusCode === 200;
      const expectedStatus = isResume ? 206 : 200;
      if (statusCode !== expectedStatus && !serverRestartedDownload) {
        await disposeDownloadResponse(response);
        throw new LocalAsrModelInstallerError(
          isResume ? 'ASR_MODEL_RESUME_REJECTED' : 'ASR_MODEL_DOWNLOAD_FAILED',
        );
      }

      const writeOffset = serverRestartedDownload ? 0 : input.resumeFromBytes;
      const expectedResponseBytes = input.expectedBytes - writeOffset;
      const contentLength = Number(response.headers['content-length']);
      const expectedContentRange = `bytes ${input.resumeFromBytes}-${input.expectedBytes - 1}/${input.expectedBytes}`;
      if (
        !Number.isSafeInteger(contentLength)
        || contentLength !== expectedResponseBytes
        || response.headers['content-encoding'] !== undefined
        || (
          statusCode === 206
          && response.headers['content-range'] !== expectedContentRange
        )
        || (statusCode === 200 && response.headers['content-range'] !== undefined)
      ) {
        await disposeDownloadResponse(response);
        throw new LocalAsrModelInstallerError(
          statusCode === 206
            ? 'ASR_MODEL_RESUME_REJECTED'
            : 'ASR_MODEL_ARCHIVE_SIZE_MISMATCH',
        );
      }

      if (serverRestartedDownload) {
        input.onProgress(0);
        emitDownloadDiagnostic(input, 'download-server-restarted', {
          attempt: input.attempt,
          previousOffsetBytes: input.resumeFromBytes,
          statusCode,
        });
      }
      const metadata: ModelArchiveResponseMetadata = {
        etag: normalizeStrongEtag(response.headers.etag),
        lastModified: normalizeHttpValidator(response.headers['last-modified']),
      };
      const archiveHash = serverRestartedDownload ? createHash('sha256') : input.prefixHash;
      let receivedResponseBytes = 0;
      const byteLimit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          responseLease.touch();
          receivedResponseBytes += chunk.byteLength;
          const totalBytes = writeOffset + receivedResponseBytes;
          if (
            receivedResponseBytes > expectedResponseBytes
            || totalBytes > input.maximumBytes
          ) {
            callback(new LocalAsrModelInstallerError('ASR_MODEL_ARCHIVE_SIZE_MISMATCH'));
            return;
          }
          archiveHash.update(chunk);
          input.onProgress(totalBytes);
          callback(null, chunk);
        },
      });
      const destination = createWriteStream(input.destinationPath, {
        flags: writeOffset > 0 ? 'a' : 'w',
        mode: PRIVATE_FILE_MODE,
      });
      const transferOutcome = pipeline(response, byteLimit, destination, {
        signal: input.signal,
      }).then(
        () => ({ error: null as unknown }),
        (error: unknown) => ({ error }),
      );
      let metadataError: unknown = null;
      try {
        await input.onResponseMetadata(metadata);
      } catch (error) {
        metadataError = error;
        response.destroy(normalizeInstallerError(error, 'ASR_MODEL_DOWNLOAD_FAILED'));
        destination.destroy(normalizeInstallerError(error, 'ASR_MODEL_DOWNLOAD_FAILED'));
      }
      const { error: transferError } = await transferOutcome;
      if (input.signal.aborted) {
        throw normalizeInstallerError(input.signal.reason, 'ASR_MODEL_INSTALL_CANCELLED');
      }
      if (metadataError) {
        throw normalizeInstallerError(metadataError, 'ASR_MODEL_DOWNLOAD_FAILED');
      }
      if (transferError) {
        throw normalizeInstallerError(transferError, 'ASR_MODEL_DOWNLOAD_FAILED');
      }

      const totalBytes = writeOffset + receivedResponseBytes;
      if (totalBytes !== input.expectedBytes) {
        throw new LocalAsrModelInstallerError('ASR_MODEL_ARCHIVE_SIZE_MISMATCH');
      }
      const sha256 = archiveHash.digest('hex');
      if (sha256 !== input.expectedSha256) {
        throw new LocalAsrModelInstallerError('ASR_MODEL_ARCHIVE_INTEGRITY_MISMATCH');
      }
      return { byteLength: totalBytes, sha256 };
    } finally {
      responseLease.dispose();
    }
  };

  return download(input.sourceUrl, 0);
}

async function requestOfficialArchiveResponse(
  input: OfficialArchiveAttemptInput,
  url: URL,
  requestHeaders: Readonly<Record<string, string>>,
): Promise<{
  readonly response: import('node:http').IncomingMessage;
  readonly touch: () => void;
  readonly dispose: () => void;
}> {
  return new Promise((resolve, reject) => {
    let activeResponse: import('node:http').IncomingMessage | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let disposed = false;
    const timeoutMilliseconds = input.idleTimeoutMilliseconds
      ?? DOWNLOAD_IDLE_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
      reject(new LocalAsrModelInstallerError('ASR_MODEL_DOWNLOAD_FAILED'));
      return;
    }
    const clearIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const onIdleTimeout = () => {
      if (disposed) return;
      disposed = true;
      clearIdleTimer();
      emitDownloadDiagnostic(input, 'download-idle-timeout', {
        attempt: input.attempt,
        offsetBytes: input.resumeFromBytes,
        timeoutMilliseconds,
      });
      const timeoutError = new LocalAsrModelInstallerError('ASR_MODEL_DOWNLOAD_FAILED');
      if (activeResponse && !activeResponse.destroyed) activeResponse.destroy(timeoutError);
      request.destroy(timeoutError);
    };
    const refreshIdleTimer = () => {
      if (disposed) return;
      clearIdleTimer();
      idleTimer = setTimeout(onIdleTimeout, timeoutMilliseconds);
      idleTimer.unref();
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearIdleTimer();
    };
    const request = input.requestGet(url, {
      signal: input.signal,
      headers: requestHeaders,
    }, (response) => {
      activeResponse = response;
      refreshIdleTimer();
      // Guard the response immediately. pipeline adds its own listener in the
      // next microtask, but a custom/mock transport may fail synchronously.
      response.once('error', () => {
        if (!response.destroyed) response.destroy();
      });
      response.once('aborted', () => {
        emitDownloadDiagnostic(input, 'download-response-aborted', {
          attempt: input.attempt,
          offsetBytes: input.resumeFromBytes,
        });
        if (!response.destroyed) {
          response.destroy(new LocalAsrModelInstallerError('ASR_MODEL_DOWNLOAD_FAILED'));
        }
      });
      resolve({ response, touch: refreshIdleTimer, dispose });
    });
    refreshIdleTimer();
    request.on('error', (error) => {
      const normalized = input.signal.aborted
        ? normalizeInstallerError(input.signal.reason, 'ASR_MODEL_INSTALL_CANCELLED')
        : normalizeInstallerError(error, 'ASR_MODEL_DOWNLOAD_FAILED');
      if (activeResponse) {
        if (!activeResponse.destroyed) activeResponse.destroy(normalized);
        return;
      }
      dispose();
      reject(normalized);
    });
  });
}

async function disposeDownloadResponse(
  response: import('node:http').IncomingMessage,
): Promise<void> {
  const closed = finished(response).catch(() => undefined);
  response.destroy();
  await closed;
}

function emitDownloadDiagnostic(
  input: ModelArchiveDownloadInput,
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  try {
    input.onDiagnostic?.(event, fields);
  } catch {
    // Observability must never alter transfer semantics.
  }
}

export async function extractOfficialLocalAsrModelArchive(
  input: ModelArchiveExtractionInput,
): Promise<void> {
  throwIfInstallationAborted(input.signal);
  const members = LOCAL_ASR_MODEL_FILE_NAMES.map(
    (name) => `${MODEL_ARCHIVE_DIRECTORY}/${name}`,
  );
  try {
    await runFile('/usr/bin/tar', [
      '-xjf',
      input.archivePath,
      '-C',
      input.stagingDirectory,
      '--',
      ...members,
    ], {
      timeout: EXTRACTION_TIMEOUT_MILLISECONDS,
      maxBuffer: 1_024 * 1_024,
      signal: input.signal,
    });
  } catch (error) {
    throwIfInstallationAborted(input.signal);
    throw new LocalAsrModelInstallerError('ASR_MODEL_ARCHIVE_INVALID', error);
  }
}

async function getAvailableDiskBytes(directoryPath: string): Promise<number> {
  try {
    const filesystem = await statfs(directoryPath, { bigint: true });
    const availableBytes = filesystem.bavail * filesystem.bsize;
    if (availableBytes > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Number(availableBytes);
  } catch (error) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_DISK_CHECK_FAILED', error);
  }
}

function requiredFreeBytesForCheckpoint(downloadedBytes: number): number {
  const boundedDownloadedBytes = Math.min(
    LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
    Math.max(0, Math.trunc(downloadedBytes)),
  );
  return (
    LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
    - boundedDownloadedBytes
    + MAXIMUM_INSTALLED_MODEL_BYTES
    + INSTALLATION_DISK_SAFETY_MARGIN_BYTES
  );
}

function createDownloadCheckpointManifest(): ModelDownloadCheckpointManifest {
  return {
    schemaVersion: DOWNLOAD_CHECKPOINT_SCHEMA_VERSION,
    sourceUrl: LOCAL_ASR_MODEL_ARCHIVE_URL,
    expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
    expectedSha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
    etag: null,
    lastModified: null,
  };
}

function parseDownloadCheckpointManifest(raw: string): ModelDownloadCheckpointManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID', error);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const expectedKeys = [
    'schemaVersion',
    'sourceUrl',
    'expectedBytes',
    'expectedSha256',
    'etag',
    'lastModified',
  ].sort();
  const actualKeys = Object.keys(record).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || record.schemaVersion !== DOWNLOAD_CHECKPOINT_SCHEMA_VERSION
    || record.sourceUrl !== LOCAL_ASR_MODEL_ARCHIVE_URL
    || record.expectedBytes !== LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
    || record.expectedSha256 !== LOCAL_ASR_MODEL_ARCHIVE_SHA256
  ) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID');
  }
  const etag = record.etag === null ? null : normalizeStrongEtag(record.etag);
  const lastModified = record.lastModified === null
    ? null
    : normalizeHttpValidator(record.lastModified);
  if (
    (record.etag !== null && etag === null)
    || (record.lastModified !== null && lastModified === null)
  ) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID');
  }
  return {
    ...createDownloadCheckpointManifest(),
    etag,
    lastModified,
  };
}

function normalizeStrongEtag(value: unknown): string | null {
  const normalized = normalizeHttpValidator(value);
  if (!normalized || normalized.startsWith('W/') || !normalized.startsWith('"')) return null;
  return normalized;
}

function normalizeHttpValidator(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) return null;
  if (!/^[\x20-\x7e]+$/u.test(value) || value.includes('\r') || value.includes('\n')) return null;
  return value;
}

function selectIfRange(metadata: ModelArchiveResponseMetadata): string | null {
  return metadata.etag ?? metadata.lastModified;
}

async function assertValidPartialArchive(
  archivePath: string,
  expectedBytes: number,
): Promise<{ readonly size: number }> {
  let metadata;
  try {
    metadata = await lstat(archivePath);
  } catch (error) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID', error);
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.size < 0
    || metadata.size > expectedBytes
  ) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID');
  }
  return { size: metadata.size };
}

async function hashArchivePrefix(
  archivePath: string,
  prefixBytes: number,
  signal: AbortSignal,
): Promise<ReturnType<typeof createHash>> {
  throwIfInstallationAborted(signal);
  const archiveHash = createHash('sha256');
  if (prefixBytes === 0) return archiveHash;
  let hashedBytes = 0;
  const source = createReadStream(archivePath, { start: 0, end: prefixBytes - 1 });
  try {
    for await (const chunk of source) {
      throwIfInstallationAborted(signal);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hashedBytes += bytes.byteLength;
      if (hashedBytes > prefixBytes) {
        throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID');
      }
      archiveHash.update(bytes);
    }
  } catch (error) {
    if (signal.aborted) throwIfInstallationAborted(signal);
    throw normalizeInstallerError(error, 'ASR_MODEL_CHECKPOINT_INVALID');
  }
  if (hashedBytes !== prefixBytes) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_CHECKPOINT_INVALID');
  }
  return archiveHash;
}

async function waitForDownloadRetry(attempt: number, signal: AbortSignal): Promise<void> {
  const delayMilliseconds = downloadRetryDelayMilliseconds(attempt);
  if (signal.aborted) throwIfInstallationAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMilliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(normalizeInstallerError(signal.reason, 'ASR_MODEL_INSTALL_CANCELLED'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function downloadRetryDelayMilliseconds(attempt: number): number {
  return Math.min(2_000, 250 * (2 ** (attempt - 1)));
}

async function cleanupStaleInstallationWorkspaces(modelParent: string): Promise<number> {
  const entries = await readdir(modelParent, { withFileTypes: true });
  let removedWorkspaceCount = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith('.phrio-asr-install-')) continue;
    await rm(path.join(modelParent, entry.name), { recursive: true, force: true });
    removedWorkspaceCount += 1;
  }
  return removedWorkspaceCount;
}

function throwIfInstallationAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw normalizeInstallerError(signal.reason, 'ASR_MODEL_INSTALL_CANCELLED');
}

function raceWithInstallationAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfInstallationAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(
      normalizeInstallerError(signal.reason, 'ASR_MODEL_INSTALL_CANCELLED'),
    ));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = await lstat(directoryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_INSTALL_FAILED');
  }
  await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
}

async function inspectVerifiedModelDirectory(
  directoryPath: string,
  requireExactEntries: boolean,
  expectInstallManifest = false,
): Promise<VerifiedModelDirectory | null> {
  let metadata;
  try {
    metadata = await lstat(directoryPath);
  } catch {
    return null;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
  if (requireExactEntries) {
    const entries = (await readdir(directoryPath)).sort();
    const expected = [
      ...LOCAL_ASR_MODEL_FILE_NAMES,
      ...(expectInstallManifest ? [LOCAL_ASR_INSTALL_MANIFEST_NAME] : []),
    ].sort();
    if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
      return null;
    }
  }
  let totalBytes = 0;
  try {
    for (const name of LOCAL_ASR_MODEL_FILE_NAMES) {
      totalBytes += await assertValidModelFile(path.join(directoryPath, name), name);
    }
  } catch {
    return null;
  }
  if (totalBytes > MAXIMUM_INSTALLED_MODEL_BYTES) return null;
  return { totalBytes };
}

async function inspectInstalledModelDirectoryWithReceipt(
  directoryPath: string,
): Promise<VerifiedModelDirectory | null> {
  const directory = await inspectVerifiedModelDirectory(directoryPath, false);
  if (!directory) return null;
  return (await verifyInstalledModelManifest(directoryPath)).state === 'ready'
    ? directory
    : null;
}

async function assertValidModelFile(
  filePath: string,
  name: (typeof LOCAL_ASR_MODEL_FILE_NAMES)[number],
): Promise<number> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_FILES_INVALID', error);
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.size < MODEL_FILE_MINIMUM_BYTES[name]
    || metadata.size > MAXIMUM_INSTALLED_MODEL_BYTES
  ) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_FILES_INVALID');
  }
  try {
    await access(filePath, constants.R_OK);
  } catch (error) {
    throw new LocalAsrModelInstallerError('ASR_MODEL_FILES_INVALID', error);
  }
  return metadata.size;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function lstatOrNull(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function removeLegacyInstallationWorkspacesSync(modelParent: string): void {
  for (const entry of readdirSync(modelParent, { withFileTypes: true })) {
    if (!entry.name.startsWith('.phrio-asr-install-')) continue;
    rmSync(path.join(modelParent, entry.name), { recursive: true, force: true });
  }
}

function isInstallerErrorCode(
  error: unknown,
  code: LocalAsrModelInstallerErrorCode,
): error is LocalAsrModelInstallerError {
  return error instanceof LocalAsrModelInstallerError && error.code === code;
}

function nodeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const { code } = error as Readonly<{ code?: unknown }>;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function isRecoverableDirectDownloadError(error: unknown): boolean {
  return error instanceof LocalAsrDirectDownloadError && [
    'ASR_MODEL_DIRECT_CHECKPOINT_INVALID',
    'ASR_MODEL_DIRECT_DOWNLOAD_FAILED',
    'ASR_MODEL_DIRECT_RANGE_REJECTED',
    'ASR_MODEL_DIRECT_REDIRECT_REJECTED',
    'ASR_MODEL_DIRECT_INTEGRITY_MISMATCH',
  ].includes(error.code);
}

/**
 * The ~1 GiB archive is a compatibility escape hatch, not a generic network
 * retry. Transient direct-download failures keep the smaller three-file
 * checkpoint and return control to the user. Archive fallback is allowed only
 * after the authoritative Hugging Face source proves that the segmented route
 * is structurally unusable or repeatedly violates the frozen file identity.
 */
function shouldFallbackToArchive(
  error: unknown,
  source: GetLocalAsrModelInstallStatusOutput['source'],
): boolean {
  return source === 'huggingface_direct'
    && error instanceof LocalAsrDirectDownloadError
    && [
      'ASR_MODEL_DIRECT_RANGE_REJECTED',
      'ASR_MODEL_DIRECT_REDIRECT_REJECTED',
      'ASR_MODEL_DIRECT_INTEGRITY_MISMATCH',
    ].includes(error.code);
}

function directErrorToInstallerCode(
  error: unknown,
): LocalAsrModelInstallerErrorCode {
  if (!(error instanceof LocalAsrDirectDownloadError)) {
    return 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED';
  }
  switch (error.code) {
    case 'ASR_MODEL_DIRECT_CHECKPOINT_INVALID':
      return 'ASR_MODEL_DIRECT_CHECKPOINT_INVALID';
    case 'ASR_MODEL_DIRECT_RANGE_REJECTED':
      return 'ASR_MODEL_DIRECT_RANGE_REJECTED';
    case 'ASR_MODEL_DIRECT_REDIRECT_REJECTED':
      return 'ASR_MODEL_DIRECT_REDIRECT_REJECTED';
    case 'ASR_MODEL_DIRECT_INTEGRITY_MISMATCH':
      return 'ASR_MODEL_DIRECT_INTEGRITY_MISMATCH';
    default:
      return 'ASR_MODEL_DIRECT_DOWNLOAD_FAILED';
  }
}

function normalizeInstallerError(
  error: unknown,
  fallback: LocalAsrModelInstallerErrorCode,
): LocalAsrModelInstallerError {
  return error instanceof LocalAsrModelInstallerError
    ? error
    : new LocalAsrModelInstallerError(fallback, error);
}

function powerReleaseReasonForStatus(
  stage: GetLocalAsrModelInstallStatusOutput['stage'],
): LocalAsrInstallPowerReleaseReason {
  switch (stage) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'paused':
      return 'paused';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}
