import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
  LOCAL_ASR_MODEL_FILE_NAMES,
  type LocalAsrModelFileStatus,
  type LocalAsrReadinessState,
} from '../../shared';
import { LOCAL_ASR_DIRECT_MODEL_FILES } from './local-asr-model-distribution';
import {
  createLocalAsrRecognizerConfig,
  LOCAL_ASR_INSTALL_MANIFEST_NAME,
  LOCAL_ASR_MODEL_ID,
  LOCAL_ASR_MODEL_REVISION,
} from './local-asr-recognizer-config';

export {
  LOCAL_ASR_INSTALL_MANIFEST_NAME,
  LOCAL_ASR_MODEL_ID,
  LOCAL_ASR_MODEL_REVISION,
} from './local-asr-recognizer-config';

export const LOCAL_ASR_MODEL_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2';
export const LOCAL_ASR_MODEL_ARCHIVE_CHECKSUM_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/checksum.txt';
/** Frozen from the k2-fsa `asr-models` release checksum.txt. */
export const LOCAL_ASR_MODEL_ARCHIVE_SHA256 =
  '5462a1fce42693deae572af1e8c4687124b12aa85fe61ff4d3168bb5280e205f';
export const LOCAL_ASR_INSTALLATION_ROUTES = [
  'huggingface_direct',
  'accelerated_direct',
  'github_release_archive',
] as const;

const LEGACY_INSTALL_MANIFEST_SCHEMA_VERSION = 1;
const INSTALL_MANIFEST_SCHEMA_VERSION = 2;
const INSTALL_MANIFEST_MAXIMUM_BYTES = 64 * 1_024;
const PRIVATE_FILE_MODE = 0o600;
const MAXIMUM_MODEL_FILE_BYTES = 512 * 1_024 * 1_024;
const loadNativeModule = createRequire(import.meta.url);

type ModelFileName = (typeof LOCAL_ASR_MODEL_FILE_NAMES)[number];

export interface LocalAsrInstalledFileIdentity {
  readonly name: ModelFileName;
  readonly byteLength: number;
  readonly sha256: string;
}

export type LocalAsrInstallationRoute = (typeof LOCAL_ASR_INSTALLATION_ROUTES)[number];

export interface LocalAsrInstallationManifestV1 {
  readonly schemaVersion: typeof LEGACY_INSTALL_MANIFEST_SCHEMA_VERSION;
  readonly source: {
    readonly archiveUrl: typeof LOCAL_ASR_MODEL_ARCHIVE_URL;
    readonly checksumUrl: typeof LOCAL_ASR_MODEL_ARCHIVE_CHECKSUM_URL;
    readonly archiveByteLength: typeof LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH;
    readonly archiveSha256: typeof LOCAL_ASR_MODEL_ARCHIVE_SHA256;
  };
  readonly installedAt: string;
  readonly files: readonly LocalAsrInstalledFileIdentity[];
}

export interface LocalAsrInstallationManifestV2 {
  readonly schemaVersion: typeof INSTALL_MANIFEST_SCHEMA_VERSION;
  readonly modelId: typeof LOCAL_ASR_MODEL_ID;
  readonly revision: typeof LOCAL_ASR_MODEL_REVISION;
  readonly route: LocalAsrInstallationRoute;
  readonly installedAt: string;
  readonly files: readonly LocalAsrInstalledFileIdentity[];
}

export type LocalAsrInstallationManifest =
  | LocalAsrInstallationManifestV1
  | LocalAsrInstallationManifestV2;

interface RuntimeProbeRecognizer {
  createStream(): unknown;
}

interface RuntimeProbeModule {
  OnlineRecognizer: new (config: unknown) => RuntimeProbeRecognizer;
}

interface SerializedInstallationManifest {
  readonly schemaVersion?: unknown;
  readonly source?: unknown;
  readonly modelId?: unknown;
  readonly revision?: unknown;
  readonly route?: unknown;
  readonly installedAt?: unknown;
  readonly files?: unknown;
}

export interface LocalAsrModelVerification {
  readonly state: LocalAsrReadinessState;
  readonly ready: boolean;
  readonly files: readonly LocalAsrModelFileStatus[];
}

export interface LocalAsrModelVerifierOptions {
  readonly loadModule?: () => RuntimeProbeModule;
  readonly probeRuntime?: (module: RuntimeProbeModule, modelDirectory: string) => void;
}

/**
 * Verifies the installed model receipt and performs one native model-load probe
 * per unchanged on-disk model identity. It deliberately owns no recording state.
 */
export class LocalAsrModelVerifier {
  readonly #modelDirectory: string;
  readonly #loadModule: () => RuntimeProbeModule;
  readonly #probeRuntime: (module: RuntimeProbeModule, modelDirectory: string) => void;
  #successfulProbeFingerprint: string | null = null;
  #inFlight: Promise<LocalAsrModelVerification> | null = null;

  constructor(modelDirectory: string, options: LocalAsrModelVerifierOptions = {}) {
    this.#modelDirectory = path.resolve(modelDirectory);
    this.#loadModule = options.loadModule
      ?? (() => loadNativeModule('sherpa-onnx-node') as RuntimeProbeModule);
    this.#probeRuntime = options.probeRuntime ?? probeNativeRuntimeAndModel;
  }

  inspect(): Promise<LocalAsrModelVerification> {
    if (this.#inFlight) return this.#inFlight;
    const operation = this.#inspect();
    this.#inFlight = operation;
    void operation.finally(() => {
      if (this.#inFlight === operation) this.#inFlight = null;
    }).catch(() => undefined);
    return operation;
  }

  async #inspect(): Promise<LocalAsrModelVerification> {
    const files = await inspectModelFileStatuses(this.#modelDirectory);
    if (!files.every((file) => file.exists)) {
      this.#successfulProbeFingerprint = null;
      return { state: 'missing', ready: false, files };
    }

    if (!files.every((file) => file.readable)) {
      this.#successfulProbeFingerprint = null;
      return { state: 'corrupt', ready: false, files };
    }

    const fingerprint = await createModelStatFingerprint(this.#modelDirectory)
      .catch(() => null);
    if (fingerprint !== null && fingerprint === this.#successfulProbeFingerprint) {
      return { state: 'ready', ready: true, files };
    }

    const manifestVerification = await verifyInstalledModelManifest(this.#modelDirectory);
    if (manifestVerification.state !== 'ready') {
      this.#successfulProbeFingerprint = null;
      return { state: manifestVerification.state, ready: false, files };
    }

    if (fingerprint === null) return { state: 'corrupt', ready: false, files };

    let module: RuntimeProbeModule;
    try {
      module = this.#loadModule();
      if (typeof module.OnlineRecognizer !== 'function') throw new TypeError('missing constructor');
    } catch {
      return { state: 'dependency_missing', ready: false, files };
    }

    try {
      this.#probeRuntime(module, this.#modelDirectory);
    } catch {
      return { state: 'runtime_init_failed', ready: false, files };
    }

    this.#successfulProbeFingerprint = fingerprint;
    return { state: 'ready', ready: true, files };
  }
}

export async function createLocalAsrInstallationManifest(
  modelDirectory: string,
  installedAt: string,
  route: LocalAsrInstallationRoute = 'github_release_archive',
  signal?: AbortSignal,
): Promise<LocalAsrInstallationManifestV2> {
  throwIfVerificationAborted(signal);
  const files = await Promise.all(
    LOCAL_ASR_MODEL_FILE_NAMES.map(async (name) =>
      inspectInstalledFile(modelDirectory, name, signal)),
  );
  throwIfVerificationAborted(signal);
  return {
    schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
    modelId: LOCAL_ASR_MODEL_ID,
    revision: LOCAL_ASR_MODEL_REVISION,
    route,
    installedAt,
    files,
  };
}

export async function writeLocalAsrInstallationManifestAtomic(
  modelDirectory: string,
  manifest: LocalAsrInstallationManifest,
): Promise<void> {
  const manifestPath = path.join(modelDirectory, LOCAL_ASR_INSTALL_MANIFEST_NAME);
  const temporaryPath = path.join(
    modelDirectory,
    `.${LOCAL_ASR_INSTALL_MANIFEST_NAME}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporaryPath, PRIVATE_FILE_MODE);
    await rename(temporaryPath, manifestPath);
    await syncDirectoryBestEffort(modelDirectory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function verifyInstalledModelManifest(
  modelDirectory: string,
  signal?: AbortSignal,
): Promise<{ readonly state: 'ready' | 'missing' | 'corrupt' }>
{
  throwIfVerificationAborted(signal);
  const manifestPath = path.join(modelDirectory, LOCAL_ASR_INSTALL_MANIFEST_NAME);
  let metadata;
  try {
    metadata = await lstat(manifestPath);
  } catch (error) {
    return nodeErrorCode(error) === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'corrupt' };
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.size < 2
    || metadata.size > INSTALL_MANIFEST_MAXIMUM_BYTES
  ) return { state: 'corrupt' };

  let manifest: LocalAsrInstallationManifest;
  try {
    throwIfVerificationAborted(signal);
    manifest = parseInstallationManifest(await readFile(manifestPath, 'utf8'));
    throwIfVerificationAborted(signal);
  } catch (error) {
    if (signal?.aborted) throwVerificationAbortReason(signal);
    return { state: 'corrupt' };
  }

  try {
    for (const expected of manifest.files) {
      throwIfVerificationAborted(signal);
      const actual = await inspectInstalledFile(modelDirectory, expected.name, signal);
      if (
        actual.byteLength !== expected.byteLength
        || actual.sha256 !== expected.sha256
      ) return { state: 'corrupt' };
    }
  } catch (error) {
    if (signal?.aborted) throwVerificationAbortReason(signal);
    return { state: 'corrupt' };
  }
  throwIfVerificationAborted(signal);
  return { state: 'ready' };
}

async function inspectModelFileStatuses(
  modelDirectory: string,
): Promise<readonly LocalAsrModelFileStatus[]> {
  return Promise.all(LOCAL_ASR_MODEL_FILE_NAMES.map(async (name) => {
    const filePath = path.join(modelDirectory, name);
    let exists = false;
    try {
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        return { name, exists: false, readable: false };
      }
      exists = true;
      await access(filePath, constants.R_OK);
      return { name, exists: true, readable: true };
    } catch {
      return { name, exists, readable: false };
    }
  }));
}

async function inspectInstalledFile(
  modelDirectory: string,
  name: ModelFileName,
  signal?: AbortSignal,
): Promise<LocalAsrInstalledFileIdentity> {
  throwIfVerificationAborted(signal);
  const filePath = path.join(modelDirectory, name);
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.size <= 0
    || metadata.size > MAXIMUM_MODEL_FILE_BYTES
  ) throw new Error('ASR_MODEL_FILE_INVALID');
  await access(filePath, constants.R_OK);
  return {
    name,
    byteLength: metadata.size,
    sha256: await sha256File(filePath, signal),
  };
}

function parseInstallationManifest(serialized: string): LocalAsrInstallationManifest {
  const value = JSON.parse(serialized) as SerializedInstallationManifest;
  if (value.schemaVersion === LEGACY_INSTALL_MANIFEST_SCHEMA_VERSION) {
    if (!isRecord(value.source)) throw new Error('ASR_MODEL_MANIFEST_INVALID');
    if (
      value.source.archiveUrl !== LOCAL_ASR_MODEL_ARCHIVE_URL
      || value.source.checksumUrl !== LOCAL_ASR_MODEL_ARCHIVE_CHECKSUM_URL
      || value.source.archiveByteLength !== LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH
      || value.source.archiveSha256 !== LOCAL_ASR_MODEL_ARCHIVE_SHA256
    ) throw new Error('ASR_MODEL_MANIFEST_INVALID');
  } else if (value.schemaVersion === INSTALL_MANIFEST_SCHEMA_VERSION) {
    if (
      value.modelId !== LOCAL_ASR_MODEL_ID
      || value.revision !== LOCAL_ASR_MODEL_REVISION
      || !isLocalAsrInstallationRoute(value.route)
    ) throw new Error('ASR_MODEL_MANIFEST_INVALID');
  } else {
    throw new Error('ASR_MODEL_MANIFEST_INVALID');
  }

  if (
    typeof value.installedAt !== 'string'
    || !Number.isFinite(Date.parse(value.installedAt))
    || !Array.isArray(value.files)
    || value.files.length !== LOCAL_ASR_MODEL_FILE_NAMES.length
  ) throw new Error('ASR_MODEL_MANIFEST_INVALID');

  const byName = new Map<string, LocalAsrInstalledFileIdentity>();
  for (const file of value.files) {
    if (
      !isRecord(file)
      || !isModelFileName(file.name)
      || typeof file.byteLength !== 'number'
      || !Number.isSafeInteger(file.byteLength)
      || file.byteLength <= 0
      || file.byteLength > MAXIMUM_MODEL_FILE_BYTES
      || typeof file.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(file.sha256)
      || byName.has(file.name)
    ) throw new Error('ASR_MODEL_MANIFEST_INVALID');
    byName.set(file.name, {
      name: file.name,
      byteLength: file.byteLength,
      sha256: file.sha256,
    });
  }
  if (LOCAL_ASR_MODEL_FILE_NAMES.some((name) => !byName.has(name))) {
    throw new Error('ASR_MODEL_MANIFEST_INVALID');
  }
  const files = LOCAL_ASR_MODEL_FILE_NAMES.map((name) => {
    const file = byName.get(name);
    if (!file) throw new Error('ASR_MODEL_MANIFEST_INVALID');
    return file;
  });
  if (value.schemaVersion === LEGACY_INSTALL_MANIFEST_SCHEMA_VERSION) {
    return {
      schemaVersion: LEGACY_INSTALL_MANIFEST_SCHEMA_VERSION,
      source: {
        archiveUrl: LOCAL_ASR_MODEL_ARCHIVE_URL,
        checksumUrl: LOCAL_ASR_MODEL_ARCHIVE_CHECKSUM_URL,
        archiveByteLength: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
        archiveSha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
      },
      installedAt: value.installedAt,
      files,
    };
  }
  if (!isLocalAsrInstallationRoute(value.route)) {
    throw new Error('ASR_MODEL_MANIFEST_INVALID');
  }
  if (
    (value.route === 'accelerated_direct' || value.route === 'huggingface_direct')
    && !filesMatchFrozenDirectDistribution(files)
  ) {
    // A direct-download receipt is not an authority unto itself. Both the
    // receipt and the bytes must match the immutable distribution frozen in
    // the application, otherwise an attacker (or a damaged recovery tool)
    // could rewrite a file and its self-reported hash together.
    throw new Error('ASR_MODEL_MANIFEST_INVALID');
  }
  return {
    schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
    modelId: LOCAL_ASR_MODEL_ID,
    revision: LOCAL_ASR_MODEL_REVISION,
    route: value.route,
    installedAt: value.installedAt,
    files,
  };
}

function filesMatchFrozenDirectDistribution(
  files: readonly LocalAsrInstalledFileIdentity[],
): boolean {
  return LOCAL_ASR_DIRECT_MODEL_FILES.every((expected) => {
    const actual = files.find((file) => file.name === expected.name);
    return actual?.byteLength === expected.byteLength
      && actual.sha256 === expected.sha256;
  });
}

function isLocalAsrInstallationRoute(value: unknown): value is LocalAsrInstallationRoute {
  return typeof value === 'string'
    && (LOCAL_ASR_INSTALLATION_ROUTES as readonly string[]).includes(value);
}

function isModelFileName(value: unknown): value is ModelFileName {
  return typeof value === 'string'
    && (LOCAL_ASR_MODEL_FILE_NAMES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function createModelStatFingerprint(modelDirectory: string): Promise<string> {
  const names = [...LOCAL_ASR_MODEL_FILE_NAMES, LOCAL_ASR_INSTALL_MANIFEST_NAME];
  const identities = await Promise.all(names.map(async (name) => {
    const metadata = await lstat(path.join(modelDirectory, name));
    return [name, metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs];
  }));
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex');
}

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  throwIfVerificationAborted(signal);
  const hash = createHash('sha256');
  const source = createReadStream(filePath);
  try {
    for await (const chunk of source) {
      throwIfVerificationAborted(signal);
      hash.update(chunk);
    }
  } catch (error) {
    if (signal?.aborted) {
      source.destroy();
      throwVerificationAbortReason(signal);
    }
    throw error;
  }
  throwIfVerificationAborted(signal);
  return hash.digest('hex');
}

function throwIfVerificationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throwVerificationAbortReason(signal);
}

function throwVerificationAbortReason(signal: AbortSignal): never {
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('ASR_MODEL_VERIFICATION_ABORTED');
}

function probeNativeRuntimeAndModel(module: RuntimeProbeModule, modelDirectory: string): void {
  const recognizer = new module.OnlineRecognizer(
    createLocalAsrRecognizerConfig(modelDirectory),
  );
  recognizer.createStream();
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directoryPath, 'r');
    await handle.sync();
  } catch {
    // Atomic rename is the correctness boundary; directory fsync is a best-effort
    // durability enhancement on filesystems that allow opening directories.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function nodeErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}
