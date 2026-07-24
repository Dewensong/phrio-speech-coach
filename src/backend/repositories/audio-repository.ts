import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_AUDIO_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_MAX_AUDIO_BYTES = 64 * 1_024 * 1_024;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

const MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/x-m4a': 'm4a',
});

export interface SaveAudioFileInput {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface StoredAudioFile {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly createdAt: string;
}

export interface ReadAudioFileResult {
  readonly bytes: Uint8Array;
  readonly byteLength: number;
}

export interface AudioRepositoryOptions {
  readonly ttlMs?: number;
  readonly maxBytes?: number;
  readonly now?: () => Date;
  readonly temporaryId?: () => string;
  readonly retainedRootDirectory?: string;
}

/**
 * Owns private, temporary attempt recordings. Callers only receive relative
 * references; an arbitrary renderer-controlled path never reaches the file
 * system.
 */
export class AudioRepository {
  readonly #rootDirectory: string;
  readonly #retainedRootDirectory: string;
  readonly #ttlMs: number;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  readonly #temporaryId: () => string;

  constructor(rootDirectory: string, options: AudioRepositoryOptions = {}) {
    this.#rootDirectory = path.resolve(rootDirectory);
    this.#retainedRootDirectory = path.resolve(
      options.retainedRootDirectory ?? path.join(path.dirname(this.#rootDirectory), 'retained-audio'),
    );
    this.#ttlMs = options.ttlMs ?? DEFAULT_AUDIO_TTL_MS;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    this.#now = options.now ?? (() => new Date());
    this.#temporaryId = options.temporaryId ?? randomUUID;
  }

  get rootDirectory(): string {
    return this.#rootDirectory;
  }

  get retainedRootDirectory(): string {
    return this.#retainedRootDirectory;
  }

  async initialize(): Promise<void> {
    for (const directory of [this.#rootDirectory, this.#retainedRootDirectory]) {
      await mkdir(directory, {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
      });
      await chmod(directory, PRIVATE_DIRECTORY_MODE);
    }
  }

  async save(input: SaveAudioFileInput): Promise<StoredAudioFile> {
    this.#assertSafeSegment(input.sessionId, 'sessionId');
    this.#assertSafeSegment(input.attemptId, 'attemptId');

    if (input.bytes.byteLength === 0) {
      throw new AudioRepositoryError('EMPTY_AUDIO', 'Audio payload is empty.');
    }
    if (input.bytes.byteLength > this.#maxBytes) {
      throw new AudioRepositoryError('AUDIO_TOO_LARGE', 'Audio payload exceeds the allowed size.');
    }

    const extension = this.#extensionFor(input.mimeType);
    const sessionDirectory = this.#resolveWithinRoot(input.sessionId);
    await mkdir(sessionDirectory, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    await chmod(sessionDirectory, PRIVATE_DIRECTORY_MODE);

    const finalPath = this.#resolveWithinRoot(input.sessionId, `${input.attemptId}.${extension}`);
    const temporaryPath = this.#resolveWithinRoot(
      input.sessionId,
      `.${input.attemptId}.${this.#temporaryId()}.tmp`,
    );

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
      const buffer = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
      await handle.writeFile(buffer);
      await handle.sync();
      await handle.close();
      handle = undefined;

      await chmod(temporaryPath, PRIVATE_FILE_MODE);
      await rename(temporaryPath, finalPath);
      await chmod(finalPath, PRIVATE_FILE_MODE);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    return {
      relativePath: path.relative(this.#rootDirectory, finalPath),
      byteLength: input.bytes.byteLength,
      mimeType: this.#normalizeMimeType(input.mimeType),
      createdAt: this.#now().toISOString(),
    };
  }

  async read(relativePath: string): Promise<ReadAudioFileResult> {
    const { absolutePath } = this.#resolveReference(relativePath);
    const bytes = await readFile(absolutePath);
    return {
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      byteLength: bytes.byteLength,
    };
  }

  async delete(relativePath: string | null | undefined): Promise<void> {
    if (!relativePath) {
      return;
    }

    const { absolutePath, storageRoot } = this.#resolveReference(relativePath);
    await unlink(absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
    await this.#removeEmptyParent(absolutePath, storageRoot);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.#assertSafeSegment(sessionId, 'sessionId');
    const temporarySessionDirectory = this.#resolveWithinRoot(sessionId);
    const retainedSessionDirectory = this.#resolveWithin(
      this.#retainedRootDirectory,
      sessionId,
    );
    await Promise.all([
      rm(temporarySessionDirectory, { recursive: true, force: true }),
      rm(retainedSessionDirectory, { recursive: true, force: true }),
    ]);
  }

  /** Deletes only safe session directories inside Phrio-owned audio roots. */
  async deleteAllTrainingAudio(): Promise<void> {
    await this.initialize();
    const sessionIds = new Set<string>();
    for (const storageRoot of [this.#rootDirectory, this.#retainedRootDirectory]) {
      const entries = await readdir(storageRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && SAFE_PATH_SEGMENT.test(entry.name)) {
          sessionIds.add(entry.name);
        }
      }
    }
    await Promise.all([...sessionIds].map((sessionId) => this.deleteSession(sessionId)));
  }

  /** Atomically promotes a completed session out of TTL-managed storage. */
  async retainSession(sessionId: string): Promise<void> {
    this.#assertSafeSegment(sessionId, 'sessionId');
    await this.initialize();
    const temporarySessionDirectory = this.#resolveWithinRoot(sessionId);
    const retainedSessionDirectory = this.#resolveWithin(
      this.#retainedRootDirectory,
      sessionId,
    );
    await rename(temporarySessionDirectory, retainedSessionDirectory);
    await chmod(retainedSessionDirectory, PRIVATE_DIRECTORY_MODE);
  }

  /** Reverses a retain rename when the matching database commit did not land. */
  async restoreRetainedSession(sessionId: string): Promise<void> {
    this.#assertSafeSegment(sessionId, 'sessionId');
    await this.initialize();
    const temporarySessionDirectory = this.#resolveWithinRoot(sessionId);
    const retainedSessionDirectory = this.#resolveWithin(
      this.#retainedRootDirectory,
      sessionId,
    );
    await rename(retainedSessionDirectory, temporarySessionDirectory);
    await chmod(temporarySessionDirectory, PRIVATE_DIRECTORY_MODE);
  }

  toRetainedReference(relativePath: string): string {
    if (relativePath.startsWith('retained/')) {
      this.#resolveReference(relativePath);
      return relativePath;
    }
    const { storageRoot, storageRelativePath } = this.#resolveReference(relativePath);
    if (storageRoot !== this.#rootDirectory) {
      throw new AudioRepositoryError('INVALID_AUDIO_REFERENCE', 'Audio is already retained.');
    }
    return `retained/${storageRelativePath.split(path.sep).join('/')}`;
  }

  toTemporaryReference(relativePath: string): string {
    const { storageRoot, storageRelativePath } = this.#resolveReference(relativePath);
    if (storageRoot === this.#rootDirectory) {
      return storageRelativePath.split(path.sep).join('/');
    }
    return storageRelativePath.split(path.sep).join('/');
  }

  async referenceExists(relativePath: string): Promise<boolean> {
    const { absolutePath } = this.#resolveReference(relativePath);
    try {
      const metadata = await lstat(absolutePath);
      return metadata.isFile() && !metadata.isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /** Returns app-owned files only; callers use it to remove unreferenced crash residue. */
  async listStoredReferences(): Promise<readonly string[]> {
    await this.initialize();
    const temporary = await this.#listReferencesIn(this.#rootDirectory, false);
    const retained = await this.#listReferencesIn(this.#retainedRootDirectory, true);
    return [...temporary, ...retained];
  }

  /**
   * Deletes both finalized and interrupted temporary files once their mtime is
   * older than the recovery TTL. Symlinks and unknown directory entries are
   * never followed.
   */
  async cleanupExpired(): Promise<readonly string[]> {
    await this.initialize();
    const cutoff = this.#now().getTime() - this.#ttlMs;
    const deleted: string[] = [];
    const sessionEntries = await readdir(this.#rootDirectory, { withFileTypes: true });

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory() || !SAFE_PATH_SEGMENT.test(sessionEntry.name)) {
        continue;
      }

      const sessionDirectory = this.#resolveWithinRoot(sessionEntry.name);
      const audioEntries = await readdir(sessionDirectory, { withFileTypes: true });
      for (const audioEntry of audioEntries) {
        if (!audioEntry.isFile()) {
          continue;
        }

        const absolutePath = this.#resolveWithinRoot(sessionEntry.name, audioEntry.name);
        const metadata = await stat(absolutePath);
        if (metadata.mtimeMs > cutoff) {
          continue;
        }

        await unlink(absolutePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        });
        deleted.push(path.relative(this.#rootDirectory, absolutePath));
      }

      await rmdir(sessionDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') {
          throw error;
        }
      });
    }

    return deleted;
  }

  #extensionFor(mimeType: string): string {
    const normalized = this.#normalizeMimeType(mimeType);
    const extension = MIME_EXTENSIONS[normalized];
    if (!extension) {
      throw new AudioRepositoryError('UNSUPPORTED_MIME_TYPE', 'Audio MIME type is not supported.');
    }
    return extension;
  }

  #normalizeMimeType(mimeType: string): string {
    return mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  }

  #resolveReference(relativePath: string): {
    readonly absolutePath: string;
    readonly storageRoot: string;
    readonly storageRelativePath: string;
  } {
    if (path.isAbsolute(relativePath) || relativePath.includes('\0')) {
      throw new AudioRepositoryError('INVALID_AUDIO_REFERENCE', 'Audio reference is invalid.');
    }
    const pathSegments = relativePath.split(/[\\/]/u);
    const retained = pathSegments[0] === 'retained';
    const storageRoot = retained ? this.#retainedRootDirectory : this.#rootDirectory;
    const storageSegments = retained ? pathSegments.slice(1) : pathSegments;
    if (storageSegments.length === 0 || storageSegments.some((segment) => segment === '')) {
      throw new AudioRepositoryError('INVALID_AUDIO_REFERENCE', 'Audio reference is invalid.');
    }
    return {
      absolutePath: this.#resolveWithin(storageRoot, ...storageSegments),
      storageRoot,
      storageRelativePath: storageSegments.join(path.sep),
    };
  }

  #resolveWithinRoot(...segments: readonly string[]): string {
    return this.#resolveWithin(this.#rootDirectory, ...segments);
  }

  #resolveWithin(storageRoot: string, ...segments: readonly string[]): string {
    const resolved = path.resolve(storageRoot, ...segments);
    const relative = path.relative(storageRoot, resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return resolved;
    }
    throw new AudioRepositoryError('INVALID_AUDIO_REFERENCE', 'Audio reference escapes private storage.');
  }

  #assertSafeSegment(value: string, field: string): void {
    if (!SAFE_PATH_SEGMENT.test(value)) {
      throw new AudioRepositoryError('INVALID_IDENTIFIER', `${field} is invalid.`);
    }
  }

  async #removeEmptyParent(absolutePath: string, storageRoot: string): Promise<void> {
    const parent = path.dirname(absolutePath);
    if (parent === storageRoot) {
      return;
    }
    await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') {
        throw error;
      }
    });
  }

  async #listReferencesIn(
    storageRoot: string,
    retained: boolean,
  ): Promise<readonly string[]> {
    const references: string[] = [];
    const sessionEntries = await readdir(storageRoot, { withFileTypes: true });
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory() || !SAFE_PATH_SEGMENT.test(sessionEntry.name)) {
        continue;
      }
      const sessionDirectory = this.#resolveWithin(storageRoot, sessionEntry.name);
      const fileEntries = await readdir(sessionDirectory, { withFileTypes: true });
      for (const fileEntry of fileEntries) {
        if (!fileEntry.isFile()) {
          continue;
        }
        const storageRelativePath = path.join(sessionEntry.name, fileEntry.name);
        references.push(
          retained
            ? `retained/${storageRelativePath.split(path.sep).join('/')}`
            : storageRelativePath.split(path.sep).join('/'),
        );
      }
    }
    return references;
  }
}

export class AudioRepositoryError extends Error {
  constructor(
    readonly code:
      | 'EMPTY_AUDIO'
      | 'AUDIO_TOO_LARGE'
      | 'UNSUPPORTED_MIME_TYPE'
      | 'INVALID_AUDIO_REFERENCE'
      | 'INVALID_IDENTIFIER',
    message: string,
  ) {
    super(message);
    this.name = 'AudioRepositoryError';
  }
}
