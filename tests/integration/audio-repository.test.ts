// @vitest-environment node

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AudioRepository,
  DEFAULT_AUDIO_TTL_MS,
} from '../../src/backend/repositories/audio-repository';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phrio-audio-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('AudioRepository', () => {
  it('atomically saves private audio with mode 0600 and no temporary residue', async () => {
    const root = await createTemporaryDirectory();
    const repository = new AudioRepository(path.join(root, 'audio'), {
      temporaryId: () => 'temporary-write',
    });
    await repository.initialize();

    const stored = await repository.save({
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      mimeType: 'audio/webm;codecs=opus',
      bytes: new Uint8Array([1, 3, 5, 7]),
    });

    const absolutePath = path.join(repository.rootDirectory, stored.relativePath);
    const metadata = await stat(absolutePath);
    const entries = await readdir(path.dirname(absolutePath));
    const read = await repository.read(stored.relativePath);

    expect(metadata.mode & 0o777).toBe(0o600);
    expect(entries).toEqual(['attempt-1.webm']);
    expect([...read.bytes]).toEqual([1, 3, 5, 7]);
    expect(stored.mimeType).toBe('audio/webm');
  });

  it('removes temporary attempt audio after the 24 hour recovery TTL', async () => {
    const root = await createTemporaryDirectory();
    const future = new Date(Date.now() + DEFAULT_AUDIO_TTL_MS + 60_000);
    const repository = new AudioRepository(path.join(root, 'audio'), {
      now: () => future,
    });
    await repository.initialize();
    const stored = await repository.save({
      sessionId: 'session-expired',
      attemptId: 'attempt-expired',
      mimeType: 'audio/webm',
      bytes: new Uint8Array([2, 4, 6]),
    });

    const deleted = await repository.cleanupExpired();

    expect(deleted).toEqual([stored.relativePath]);
    await expect(repository.read(stored.relativePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects renderer-like path traversal references', async () => {
    const root = await createTemporaryDirectory();
    const repository = new AudioRepository(path.join(root, 'audio'));
    await repository.initialize();

    await expect(repository.read('../outside.webm')).rejects.toMatchObject({
      code: 'INVALID_AUDIO_REFERENCE',
    });
  });
});
