// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { LocalAsrDirectDownloader } from '../../src/backend/services/local-asr-direct-download';
import { LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH } from '../../src/backend/services/local-asr-model-distribution';
import {
  LocalAsrModelVerifier,
  createLocalAsrInstallationManifest,
  writeLocalAsrInstallationManifestAtomic,
} from '../../src/backend/services/local-asr-model-verifier';

const runRealDownload = process.env.PHRIO_REAL_MODEL_DOWNLOAD === '1' ? it : it.skip;

describe('real local ASR distribution', () => {
  runRealDownload('downloads, verifies, and initializes the frozen model', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'phrio-real-model-'));
    const checkpointDirectory = path.join(root, '.phrio-asr-direct-v2');
    const destinationDirectory = path.join(root, 'model');
    const startedAt = performance.now();
    let lastProgress = 0;
    const diagnostics: unknown[] = [];
    try {
      const result = await new LocalAsrDirectDownloader().download({
        checkpointDirectory,
        destinationDirectory,
        source: 'hf_mirror_acceleration',
        signal: new AbortController().signal,
        onProgress: (progress) => {
          lastProgress = progress.downloadedBytes;
        },
        onDiagnostic: (event, fields) => {
          diagnostics.push({ event, fields });
        },
      });
      expect(result).toMatchObject({
        source: 'hf_mirror_acceleration',
        downloadedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
        expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
      });
      expect(lastProgress).toBe(LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH);

      const receipt = await createLocalAsrInstallationManifest(
        destinationDirectory,
        new Date().toISOString(),
        result.resolvedSource === 'hf_mirror_acceleration'
          ? 'accelerated_direct'
          : 'huggingface_direct',
      );
      await writeLocalAsrInstallationManifestAtomic(destinationDirectory, receipt);
      await expect(new LocalAsrModelVerifier(destinationDirectory).inspect()).resolves.toMatchObject({
        state: 'ready',
        ready: true,
      });

      const elapsedMilliseconds = Math.round(performance.now() - startedAt);
      process.stdout.write(`${JSON.stringify({
        event: 'phrio.real-model-download.verified',
        downloadedBytes: result.downloadedBytes,
        elapsedMilliseconds,
        averageBytesPerSecond: Math.round(result.downloadedBytes / (elapsedMilliseconds / 1_000)),
        source: result.resolvedSource,
      })}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ diagnostics })}\n`);
      throw error;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
