// @vitest-environment node

import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SecureAiKeyRepository,
  SecureAiKeyRepositoryError,
  type StringEncryption,
} from '../../src/backend/repositories/secure-ai-key-repository';

const temporaryDirectories: string[] = [];

async function temporaryKeyPath(): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phrio-secure-key-'));
  temporaryDirectories.push(directory);
  return { directory, filePath: path.join(directory, 'secure', 'openai-api-key.json') };
}

function testEncryption(available = true): StringEncryption {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value.split('').reverse().join('')}`, 'utf8'),
    decryptString: (value) => {
      const encoded = value.toString('utf8');
      if (!encoded.startsWith('encrypted:')) throw new Error('invalid cipher text');
      return encoded.slice('encrypted:'.length).split('').reverse().join('');
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('SecureAiKeyRepository', () => {
  it('stores only encrypted bytes with owner-only permissions and a safe hint', async () => {
    const { filePath } = await temporaryKeyPath();
    const repository = new SecureAiKeyRepository(filePath, testEncryption());
    const apiKey = 'test-openai-user-secret-000000000000';

    await repository.save(apiKey);
    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toContain(apiKey);
    expect(raw).not.toContain('test-openai-user-secret');
    expect(JSON.parse(raw)).toMatchObject({ version: 1, keyHint: '••••0000' });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
    await expect(repository.read()).resolves.toBe(apiKey);
    await expect(repository.getStatus()).resolves.toEqual({
      configured: true,
      keyHint: '••••0000',
      keyStorage: 'system_encrypted',
    });

    await repository.delete();
    await expect(repository.getStatus()).resolves.toEqual({
      configured: false,
      keyHint: null,
      keyStorage: 'system_encrypted',
    });
  });

  it('uses an explicit private-file fallback when OS encryption is unavailable', async () => {
    const { filePath } = await temporaryKeyPath();
    const repository = new SecureAiKeyRepository(filePath, testEncryption(false));
    const apiKey = 'test-openai-user-secret-000000000000';

    await repository.save(apiKey);

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({
      version: 2,
      storage: 'local_private_file_unencrypted',
      keyHint: '••••0000',
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
    await expect(repository.read()).resolves.toBe(apiKey);
    await expect(repository.getStatus()).resolves.toEqual({
      configured: true,
      keyHint: '••••0000',
      keyStorage: 'local_private_file_unencrypted',
    });

    await repository.delete();
    await expect(repository.getStatus()).resolves.toEqual({
      configured: false,
      keyHint: null,
      keyStorage: 'local_private_file_unencrypted',
    });
  });

  it('keeps reading the legacy encrypted format after the fallback is added', async () => {
    const { filePath } = await temporaryKeyPath();
    const apiKey = 'test-openai-legacy-secret-0000000000';
    const encrypted = testEncryption().encryptString(apiKey).toString('base64');
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(filePath), 0o700);
    await writeFile(filePath, JSON.stringify({
      version: 1,
      encryptedBase64: encrypted,
      keyHint: '••••0000',
    }), { encoding: 'utf8', mode: 0o600 });

    const repository = new SecureAiKeyRepository(filePath, testEncryption());
    await expect(repository.read()).resolves.toBe(apiKey);
    await expect(repository.getStatus()).resolves.toMatchObject({
      configured: true,
      keyStorage: 'system_encrypted',
    });
  });

  it('turns corrupt storage into a code-only error without returning file contents', async () => {
    const { filePath } = await temporaryKeyPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{"encryptedBase64":"raw-secret"}', 'utf8');
    const repository = new SecureAiKeyRepository(filePath, testEncryption());
    const error = await repository.read().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecureAiKeyRepositoryError);
    expect(error).toMatchObject({
      code: 'API_KEY_STORAGE_CORRUPT',
      message: 'API_KEY_STORAGE_CORRUPT',
    });
  });

  it('rejects symlink and hardlink storage instead of following aliases', async () => {
    const symlinkCase = await temporaryKeyPath();
    const externalDirectory = await mkdtemp(path.join(os.tmpdir(), 'phrio-key-external-'));
    temporaryDirectories.push(externalDirectory);
    await mkdir(path.dirname(symlinkCase.filePath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(symlinkCase.filePath), 0o700);
    const externalFile = path.join(externalDirectory, 'external-key.json');
    await writeFile(externalFile, '{}', { mode: 0o600 });
    await symlink(externalFile, symlinkCase.filePath);
    const symlinkRepository = new SecureAiKeyRepository(symlinkCase.filePath, testEncryption(false));
    await expect(symlinkRepository.getStatus()).rejects.toMatchObject({
      code: 'API_KEY_STORAGE_CORRUPT',
    });

    const hardlinkCase = await temporaryKeyPath();
    await mkdir(path.dirname(hardlinkCase.filePath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(hardlinkCase.filePath), 0o700);
    const linkedSource = path.join(hardlinkCase.directory, 'linked-key.json');
    await writeFile(linkedSource, JSON.stringify({
      version: 2,
      storage: 'local_private_file_unencrypted',
      apiKey: 'test-openai-linked-secret-00000000000',
      keyHint: '••••0000',
    }), { mode: 0o600 });
    await link(linkedSource, hardlinkCase.filePath);
    const hardlinkRepository = new SecureAiKeyRepository(hardlinkCase.filePath, testEncryption(false));
    await expect(hardlinkRepository.read()).rejects.toMatchObject({
      code: 'API_KEY_STORAGE_CORRUPT',
    });
  });

  it('rejects a symlinked parent directory before any key is written', async () => {
    const { directory, filePath } = await temporaryKeyPath();
    const externalDirectory = await mkdtemp(path.join(os.tmpdir(), 'phrio-key-parent-'));
    temporaryDirectories.push(externalDirectory);
    await symlink(externalDirectory, path.dirname(filePath));
    const repository = new SecureAiKeyRepository(filePath, testEncryption(false));

    await expect(repository.save('test-openai-user-secret-000000000000'))
      .rejects.toMatchObject({ code: 'API_KEY_STORAGE_CORRUPT' });
    await expect(readFile(path.join(externalDirectory, 'openai-api-key.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(directory).toBeTruthy();
  });
});
