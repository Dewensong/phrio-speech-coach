// @vitest-environment node

import { chmod, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LOCAL_ASR_INSTALL_MANIFEST_NAME,
  LOCAL_ASR_INSTALLATION_ROUTES,
  LOCAL_ASR_MODEL_ARCHIVE_SHA256,
  LOCAL_ASR_MODEL_ARCHIVE_URL,
  LOCAL_ASR_MODEL_ID,
  LOCAL_ASR_MODEL_REVISION,
  LocalAsrModelVerifier,
  createLocalAsrInstallationManifest,
  verifyInstalledModelManifest,
  writeLocalAsrInstallationManifestAtomic,
} from '../../src/backend/services/local-asr-model-verifier';
import {
  LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
  LOCAL_ASR_MODEL_FILE_NAMES,
} from '../../src/shared';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function createInstalledFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phrio-model-verifier-'));
  temporaryDirectories.push(directory);
  for (const [index, name] of LOCAL_ASR_MODEL_FILE_NAMES.entries()) {
    await writeFile(path.join(directory, name), Buffer.alloc(128 + index, index + 1), {
      mode: 0o600,
    });
  }
  const manifest = await createLocalAsrInstallationManifest(
    directory,
    '2026-07-20T10:00:00.000Z',
  );
  await writeLocalAsrInstallationManifestAtomic(directory, manifest);
  return directory;
}

describe('local ASR installation manifest and runtime verifier', () => {
  it('probes the native recognizer with the production endpoint thresholds', async () => {
    const directory = await createInstalledFixture();
    let recognizerConfig: Record<string, unknown> | null = null;
    const verifier = new LocalAsrModelVerifier(directory, {
      loadModule: () => ({
        OnlineRecognizer: class {
          constructor(config: unknown) {
            recognizerConfig = config as Record<string, unknown>;
          }

          createStream() { return {}; }
        },
      }),
    });

    await expect(verifier.inspect()).resolves.toMatchObject({ state: 'ready', ready: true });
    expect(recognizerConfig).toMatchObject({
      enableEndpoint: true,
      rule1MinTrailingSilence: 1.8,
      rule2MinTrailingSilence: 0.8,
      rule3MinUtteranceLength: 20,
    });
  });

  it('stops receipt hashing at a stream chunk when its AbortSignal is cancelled', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'phrio-model-abort-hash-'));
    temporaryDirectories.push(directory);
    for (const [index, name] of LOCAL_ASR_MODEL_FILE_NAMES.entries()) {
      await writeFile(path.join(directory, name), Buffer.alloc(128 + index, index + 1));
    }
    await truncate(path.join(directory, 'encoder.int8.onnx'), 64 * 1_024 * 1_024);
    const controller = new AbortController();
    const reason = new Error('stop receipt hashing');
    const operation = createLocalAsrInstallationManifest(
      directory,
      '2026-07-20T10:00:00.000Z',
      'github_release_archive',
      controller.signal,
    );
    setImmediate(() => controller.abort(reason));

    await expect(operation).rejects.toBe(reason);
  });

  it('atomically records a v2 receipt with the frozen model identity and exact files', async () => {
    const directory = await createInstalledFixture();
    const serialized = await readFile(
      path.join(directory, LOCAL_ASR_INSTALL_MANIFEST_NAME),
      'utf8',
    );
    const manifest = JSON.parse(serialized);

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      modelId: LOCAL_ASR_MODEL_ID,
      revision: LOCAL_ASR_MODEL_REVISION,
      route: 'github_release_archive',
      installedAt: '2026-07-20T10:00:00.000Z',
    });
    expect(manifest.files.map((file: { name: string }) => file.name)).toEqual(
      LOCAL_ASR_MODEL_FILE_NAMES,
    );
    expect(manifest.files.every((file: { byteLength: number; sha256: string }) =>
      file.byteLength > 0 && /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(serialized.endsWith('\n')).toBe(true);
  });

  it.each(LOCAL_ASR_INSTALLATION_ROUTES)(
    'records and enforces the identity policy for the %s installation route',
    async (route) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'phrio-model-route-'));
      temporaryDirectories.push(directory);
      for (const [index, name] of LOCAL_ASR_MODEL_FILE_NAMES.entries()) {
        await writeFile(path.join(directory, name), Buffer.alloc(128 + index, index + 1));
      }

      const manifest = await createLocalAsrInstallationManifest(
        directory,
        '2026-07-20T10:00:00.000Z',
        route,
      );
      expect(manifest.route).toBe(route);
      await writeLocalAsrInstallationManifestAtomic(directory, manifest);
      await expect(verifyInstalledModelManifest(directory)).resolves.toEqual({
        state: route === 'github_release_archive' ? 'ready' : 'corrupt',
      });
    },
  );

  it('rejects a self-consistent direct receipt that does not match the frozen files', async () => {
    const directory = await createInstalledFixture();
    const manifestPath = path.join(directory, LOCAL_ASR_INSTALL_MANIFEST_NAME);
    const selfConsistentReceipt = JSON.parse(await readFile(manifestPath, 'utf8'));

    await writeFile(manifestPath, `${JSON.stringify({
      ...selfConsistentReceipt,
      route: 'accelerated_direct',
    })}\n`);

    await expect(verifyInstalledModelManifest(directory)).resolves.toEqual({ state: 'corrupt' });
  });

  it('continues to verify an existing v1 archive receipt', async () => {
    const directory = await createInstalledFixture();
    const current = JSON.parse(await readFile(
      path.join(directory, LOCAL_ASR_INSTALL_MANIFEST_NAME),
      'utf8',
    ));
    await writeFile(
      path.join(directory, LOCAL_ASR_INSTALL_MANIFEST_NAME),
      `${JSON.stringify({
        schemaVersion: 1,
        source: {
          archiveUrl: LOCAL_ASR_MODEL_ARCHIVE_URL,
          checksumUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/checksum.txt',
          archiveByteLength: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
          archiveSha256: LOCAL_ASR_MODEL_ARCHIVE_SHA256,
        },
        installedAt: current.installedAt,
        files: current.files,
      })}\n`,
      { mode: 0o600 },
    );

    await expect(verifyInstalledModelManifest(directory)).resolves.toEqual({ state: 'ready' });
  });

  it('rejects a v2 receipt with a mutable model identity or unknown route', async () => {
    const directory = await createInstalledFixture();
    const manifestPath = path.join(directory, LOCAL_ASR_INSTALL_MANIFEST_NAME);
    const original = JSON.parse(await readFile(manifestPath, 'utf8'));

    await writeFile(manifestPath, JSON.stringify({ ...original, revision: 'main' }));
    await expect(verifyInstalledModelManifest(directory)).resolves.toEqual({ state: 'corrupt' });

    await writeFile(manifestPath, JSON.stringify({ ...original, route: 'unknown_mirror' }));
    await expect(verifyInstalledModelManifest(directory)).resolves.toEqual({ state: 'corrupt' });
  });

  it('distinguishes missing, corrupt, dependency and runtime initialization failures', async () => {
    const missing = await mkdtemp(path.join(os.tmpdir(), 'phrio-model-missing-'));
    temporaryDirectories.push(missing);
    await expect(new LocalAsrModelVerifier(missing).inspect()).resolves.toMatchObject({
      state: 'missing',
      ready: false,
    });

    const corrupt = await createInstalledFixture();
    await writeFile(path.join(corrupt, 'tokens.txt'), 'tampered');
    await expect(new LocalAsrModelVerifier(corrupt).inspect()).resolves.toMatchObject({
      state: 'corrupt',
      ready: false,
    });

    const dependency = await createInstalledFixture();
    await expect(new LocalAsrModelVerifier(dependency, {
      loadModule: () => { throw new Error('module not found'); },
    }).inspect()).resolves.toMatchObject({ state: 'dependency_missing', ready: false });

    const runtime = await createInstalledFixture();
    await expect(new LocalAsrModelVerifier(runtime, {
      loadModule: () => ({ OnlineRecognizer: class { createStream() {} } }),
      probeRuntime: () => { throw new Error('bad model graph'); },
    }).inspect()).resolves.toMatchObject({ state: 'runtime_init_failed', ready: false });
  });

  it('caches a successful native/model probe until an installed file identity changes', async () => {
    const directory = await createInstalledFixture();
    const probeRuntime = vi.fn();
    const verifier = new LocalAsrModelVerifier(directory, {
      loadModule: () => ({ OnlineRecognizer: class { createStream() {} } }),
      probeRuntime,
    });

    await expect(verifier.inspect()).resolves.toMatchObject({ state: 'ready', ready: true });
    await expect(verifier.inspect()).resolves.toMatchObject({ state: 'ready', ready: true });
    expect(probeRuntime).toHaveBeenCalledOnce();

    await chmod(path.join(directory, 'tokens.txt'), 0o400);
    await expect(verifier.inspect()).resolves.toMatchObject({ state: 'ready', ready: true });
    expect(probeRuntime).toHaveBeenCalledTimes(2);
  });
});
