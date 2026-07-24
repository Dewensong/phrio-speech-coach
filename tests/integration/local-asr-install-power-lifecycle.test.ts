// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalAsrDirectDownloader } from '../../src/backend/services/local-asr-direct-download';
import {
  LocalAsrInstallPowerSaveBlocker,
} from '../../src/backend/services/local-asr-install-power-save-blocker';
import { LocalAsrModelInstaller } from '../../src/backend/services/local-asr-model-installer';
import { LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH } from '../../src/backend/services/local-asr-model-distribution';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe('local ASR installation power lifecycle', () => {
  it('binds one native blocker to one physical install promise through cancellation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'phrio-asr-power-lifecycle-'));
    temporaryDirectories.push(root);
    const activeIds = new Set<number>();
    const start = vi.fn(() => {
      activeIds.add(101);
      return 101;
    });
    const stop = vi.fn((id: number) => activeIds.delete(id));
    const diagnostics = { record: vi.fn() };
    const powerLease = new LocalAsrInstallPowerSaveBlocker({
      powerSaveBlocker: {
        start,
        isStarted: (id) => activeIds.has(id),
        stop,
      },
      diagnostics,
    });
    let markDownloadStarted!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve;
    });
    const directDownloader = {
      inspectCheckpoint: vi.fn(async () => ({
        downloadedBytes: 0,
        expectedBytes: LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH,
        complete: false,
      })),
      download: vi.fn(async (input) => {
        markDownloadStarted();
        return new Promise<never>((_resolve, reject) => {
          if (input.signal.aborted) {
            reject(input.signal.reason);
            return;
          }
          input.signal.addEventListener(
            'abort',
            () => reject(input.signal.reason),
            { once: true },
          );
        });
      }),
    } satisfies Pick<LocalAsrDirectDownloader, 'download' | 'inspectCheckpoint'>;
    const installer = new LocalAsrModelInstaller(
      path.join(root, 'models', 'sherpa-onnx-streaming-paraformer-bilingual-zh-en'),
      {
        directDownloader,
        getAvailableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
        installPowerLease: powerLease,
      },
    );

    const installation = installer.install();
    const concurrentInstallation = installer.install();
    expect(concurrentInstallation).toBe(installation);
    expect(installer.hasActiveInstallation()).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    await downloadStarted;
    expect(activeIds).toEqual(new Set([101]));

    expect(installer.cancel()).toBe(true);
    await expect(installation).rejects.toMatchObject({
      code: 'ASR_MODEL_INSTALL_CANCELLED',
    });

    expect(installer.hasActiveInstallation()).toBe(false);
    expect(stop).toHaveBeenCalledExactlyOnceWith(101);
    expect(activeIds.size).toBe(0);
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.power-save-blocker-acquired',
    }));
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.power-save-blocker-released',
      fields: expect.objectContaining({ reason: 'cancelled' }),
    }));
  });
});
