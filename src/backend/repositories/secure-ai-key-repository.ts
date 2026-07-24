import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export interface StringEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export type AiKeyStorageMode = 'system_encrypted' | 'local_private_file_unencrypted';

const EncryptedStoredKeySchema = z.object({
  version: z.literal(1),
  encryptedBase64: z.string().min(1).max(4_096),
  keyHint: z.string().min(4).max(12),
}).strict();

const PrivateFileStoredKeySchema = z.object({
  version: z.literal(2),
  storage: z.literal('local_private_file_unencrypted'),
  apiKey: z.string().min(20).max(512).refine((value) => !/[\r\n\0]/.test(value)),
  keyHint: z.string().min(4).max(12),
}).strict();

const StoredKeySchema = z.discriminatedUnion('version', [
  EncryptedStoredKeySchema,
  PrivateFileStoredKeySchema,
]);
type StoredKey = z.infer<typeof StoredKeySchema>;

interface AiKeyStatus {
  readonly configured: boolean;
  readonly keyHint: string | null;
  readonly keyStorage: AiKeyStorageMode;
}

/**
 * Stores an API key outside SQLite and renderer state.
 *
 * Version 1 preserves compatibility with Electron safeStorage callers. Version
 * 2 is an explicit local-only fallback protected by a 0700 parent directory and
 * a 0600 regular file. Production may deliberately choose version 2 when an OS
 * encryption API can synchronously block the Electron main thread.
 */
export class SecureAiKeyRepository {
  readonly #filePath: string;
  readonly #directory: string;
  readonly #encryption: StringEncryption;

  constructor(filePath: string, encryption: StringEncryption) {
    this.#filePath = path.resolve(filePath);
    this.#directory = path.dirname(this.#filePath);
    this.#encryption = encryption;
  }

  isEncryptionAvailable(): boolean {
    return this.#encryption.isEncryptionAvailable();
  }

  async getStatus(): Promise<AiKeyStatus> {
    const stored = await this.#readStored();
    if (!stored) {
      return {
        configured: false,
        keyHint: null,
        keyStorage: this.#preferredStorage(),
      };
    }
    if (stored.version === 1 && !this.isEncryptionAvailable()) {
      // The legacy encrypted file is retained and remains deletable, but it
      // cannot be advertised as usable until safeStorage becomes available.
      return {
        configured: false,
        keyHint: null,
        keyStorage: 'local_private_file_unencrypted',
      };
    }
    return {
      configured: true,
      keyHint: stored.keyHint,
      keyStorage: stored.version === 1
        ? 'system_encrypted'
        : 'local_private_file_unencrypted',
    };
  }

  async save(apiKeyInput: string): Promise<void> {
    const apiKey = validateApiKey(apiKeyInput);
    const keyHint = `••••${apiKey.slice(-4)}`;
    let encrypted: Buffer | null = null;
    let stored: StoredKey;

    if (this.isEncryptionAvailable()) {
      encrypted = this.#encryption.encryptString(apiKey);
      stored = EncryptedStoredKeySchema.parse({
        version: 1,
        encryptedBase64: encrypted.toString('base64'),
        keyHint,
      });
    } else {
      stored = PrivateFileStoredKeySchema.parse({
        version: 2,
        storage: 'local_private_file_unencrypted',
        apiKey,
        keyHint,
      });
    }

    try {
      await this.#writeAtomically(JSON.stringify(stored));
    } finally {
      encrypted?.fill(0);
    }
  }

  async read(): Promise<string> {
    const stored = await this.#readStored();
    if (!stored) throw new SecureAiKeyRepositoryError('API_KEY_NOT_CONFIGURED');
    if (stored.version === 2) return stored.apiKey;
    if (!this.isEncryptionAvailable()) {
      throw new SecureAiKeyRepositoryError('ENCRYPTION_UNAVAILABLE');
    }
    try {
      const encrypted = Buffer.from(stored.encryptedBase64, 'base64');
      try {
        return validateApiKey(this.#encryption.decryptString(encrypted));
      } finally {
        encrypted.fill(0);
      }
    } catch (error) {
      if (error instanceof SecureAiKeyRepositoryError && error.code === 'INVALID_API_KEY') {
        throw new SecureAiKeyRepositoryError('API_KEY_DECRYPTION_FAILED');
      }
      throw new SecureAiKeyRepositoryError('API_KEY_DECRYPTION_FAILED');
    }
  }

  async delete(): Promise<void> {
    const directoryExists = await this.#assertPrivateDirectory(false);
    if (!directoryExists) return;
    const destination = await this.#inspectDestination();
    if (!destination) return;
    await rm(this.#filePath);
    await this.#syncDirectory();
  }

  async #readStored(): Promise<StoredKey | null> {
    const directoryExists = await this.#assertPrivateDirectory(false);
    if (!directoryExists) return null;
    let handle;
    try {
      handle = await open(this.#filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new SecureAiKeyRepositoryError('API_KEY_STORAGE_CORRUPT');
    }
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile()
        || metadata.nlink !== 1
        || (metadata.mode & 0o777) !== 0o600
        || metadata.size > 16_384
      ) {
        throw new SecureAiKeyRepositoryError('API_KEY_STORAGE_CORRUPT');
      }
      const value = await handle.readFile({ encoding: 'utf8' });
      return StoredKeySchema.parse(JSON.parse(value));
    } catch (error) {
      if (error instanceof SecureAiKeyRepositoryError) throw error;
      throw new SecureAiKeyRepositoryError('API_KEY_STORAGE_CORRUPT');
    } finally {
      await handle.close();
    }
  }

  async #writeAtomically(value: string): Promise<void> {
    await this.#assertPrivateDirectory(true);
    await this.#inspectDestination();
    const temporaryPath = path.join(this.#directory, `.ai-key-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.chmod(0o600);
      await handle.writeFile(value, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#filePath);
      await chmod(this.#filePath, 0o600);
      await this.#inspectDestination();
      await this.#syncDirectory();
    } catch (error) {
      if (error instanceof SecureAiKeyRepositoryError) throw error;
      throw new SecureAiKeyRepositoryError('API_KEY_STORAGE_CORRUPT');
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async #assertPrivateDirectory(create: boolean): Promise<boolean> {
    if (create) {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    }
    let metadata;
    try {
      metadata = await lstat(this.#directory);
    } catch (error) {
      if (!create && isMissingFile(error)) return false;
      throw new SecureAiKeyRepositoryError('API_KEY_STORAGE_CORRUPT');
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new SecureAiKeyRepositoryError('API_KEY_STORAGE_CORRUPT');
    }
    if (create) await chmod(this.#directory, 0o700);
    else if ((metadata.mode & 0o777) !== 0o700) {
      throw new SecureAiKeyRepositoryError('API_KEY_STORAGE_CORRUPT');
    }
    return true;
  }

  async #inspectDestination(): Promise<boolean> {
    try {
      const metadata = await lstat(this.#filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new SecureAiKeyRepositoryError('API_KEY_STORAGE_CORRUPT');
      }
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      if (error instanceof SecureAiKeyRepositoryError) throw error;
      throw new SecureAiKeyRepositoryError('API_KEY_STORAGE_CORRUPT');
    }
  }

  async #syncDirectory(): Promise<void> {
    const directoryHandle = await open(this.#directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }

  #preferredStorage(): AiKeyStorageMode {
    return this.isEncryptionAvailable()
      ? 'system_encrypted'
      : 'local_private_file_unencrypted';
  }
}

function validateApiKey(apiKeyInput: string): string {
  const apiKey = apiKeyInput.trim();
  if (apiKey.length < 20 || apiKey.length > 512 || /[\r\n\0]/.test(apiKey)) {
    throw new SecureAiKeyRepositoryError('INVALID_API_KEY');
  }
  return apiKey;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class SecureAiKeyRepositoryError extends Error {
  constructor(readonly code:
    | 'ENCRYPTION_UNAVAILABLE'
    | 'INVALID_API_KEY'
    | 'API_KEY_NOT_CONFIGURED'
    | 'API_KEY_DECRYPTION_FAILED'
    | 'API_KEY_STORAGE_CORRUPT') {
    super(code);
    this.name = 'SecureAiKeyRepositoryError';
  }
}
