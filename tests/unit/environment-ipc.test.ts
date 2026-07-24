import { describe, expect, it } from 'vitest';

import {
  CLEAR_TRAINING_DATA_CONFIRMATION,
  CancelLocalAsrModelInstallOutputSchema,
  ClearTrainingDataInputSchema,
  GetEnvironmentStatusOutputSchema,
  GetLocalAsrModelInstallStatusOutputSchema,
  InstallLocalAsrModelOutputSchema,
  IPC_CHANNELS,
  IPC_CONTRACTS,
  LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
  LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH,
  RESET_NONSENSITIVE_SETTINGS_CONFIRMATION,
  ResetNonSensitiveSettingsInputSchema,
  UpdateSessionRecordInputSchema,
} from '../../src/shared';

const modelFiles = [
  { name: 'encoder.int8.onnx' as const, exists: true, readable: true },
  { name: 'decoder.int8.onnx' as const, exists: true, readable: true },
  { name: 'tokens.txt' as const, exists: true, readable: true },
];

describe('environment and data-governance IPC contracts', () => {
  it('keeps all 40 bridge contracts registered and namespaced', () => {
    expect(Object.values(IPC_CHANNELS)).toHaveLength(40);
    expect(Object.keys(IPC_CONTRACTS).sort()).toEqual(Object.values(IPC_CHANNELS).sort());
  });

  it('accepts only bounded rename and explicit pin record commands', () => {
    expect(UpdateSessionRecordInputSchema.parse({
      sessionId: 'session-record-command',
      action: 'rename',
      title: '  周会复盘  ',
    })).toEqual({
      sessionId: 'session-record-command',
      action: 'rename',
      title: '周会复盘',
    });
    expect(UpdateSessionRecordInputSchema.safeParse({
      sessionId: 'session-record-command',
      action: 'rename',
      title: '   ',
    }).success).toBe(false);
    expect(UpdateSessionRecordInputSchema.safeParse({
      sessionId: 'session-record-command',
      action: 'set_pinned',
      pinned: true,
      title: 'unexpected',
    }).success).toBe(false);
  });

  it('accepts only bounded, internally consistent model-install progress', () => {
    const valid = {
      stage: 'downloading' as const,
      downloadedBytes: 123_456,
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      cancellable: true,
      errorCode: null,
      updatedAt: '2026-07-20T03:00:00.000Z',
    };
    expect(GetLocalAsrModelInstallStatusOutputSchema.parse(valid)).toEqual(valid);
    expect(GetLocalAsrModelInstallStatusOutputSchema.safeParse({
      ...valid,
      expectedBytes: 1,
    }).success).toBe(false);
    expect(GetLocalAsrModelInstallStatusOutputSchema.safeParse({
      ...valid,
      stage: 'completed',
    }).success).toBe(false);
    expect(GetLocalAsrModelInstallStatusOutputSchema.safeParse({
      ...valid,
      stage: 'failed',
      cancellable: false,
      errorCode: 'ASR_MODEL_DOWNLOAD_FAILED',
    }).success).toBe(true);
    expect(GetLocalAsrModelInstallStatusOutputSchema.safeParse({
      ...valid,
      stage: 'paused',
      downloadedBytes: 64 * 1_024 * 1_024,
    }).success).toBe(true);
    expect(GetLocalAsrModelInstallStatusOutputSchema.safeParse({
      ...valid,
      stage: 'paused',
      cancellable: false,
    }).success).toBe(false);
    expect(GetLocalAsrModelInstallStatusOutputSchema.safeParse({
      ...valid,
      downloadedBytes: 12_345,
      expectedBytes: LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH,
      source: 'accelerated_direct',
      lastRecoverableErrorCode: null,
    }).success).toBe(true);
    expect(GetLocalAsrModelInstallStatusOutputSchema.safeParse({
      ...valid,
      expectedBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      source: 'accelerated_direct',
    }).success).toBe(false);
  });

  it('keeps model-install cancellation output narrow', () => {
    expect(CancelLocalAsrModelInstallOutputSchema.parse({ cancelled: true }))
      .toEqual({ cancelled: true });
    expect(CancelLocalAsrModelInstallOutputSchema.safeParse({
      cancelled: true,
      path: '/private/model',
    }).success).toBe(false);
  });

  it('accepts only a ready, size-consistent model installation receipt', () => {
    const valid = {
      outcome: 'installed' as const,
      downloadedArchiveBytes: LOCAL_ASR_MODEL_ARCHIVE_BYTE_LENGTH,
      installedModelBytes: 240 * 1_024 * 1_024,
      completedAt: '2026-07-20T03:00:00.000Z',
      localAsr: { state: 'ready' as const, ready: true, files: modelFiles },
    };
    expect(InstallLocalAsrModelOutputSchema.parse(valid)).toEqual(valid);
    expect(InstallLocalAsrModelOutputSchema.safeParse({
      ...valid,
      downloadedArchiveBytes: 1,
    }).success).toBe(false);
    expect(InstallLocalAsrModelOutputSchema.safeParse({
      ...valid,
      downloadedArchiveBytes: 0,
      validatedDownloadBytes: LOCAL_ASR_MODEL_DIRECT_BYTE_LENGTH,
      sourceUsed: 'accelerated_direct',
    }).success).toBe(true);
    expect(InstallLocalAsrModelOutputSchema.safeParse({
      ...valid,
      localAsr: { state: 'missing' as const, ready: false, files: modelFiles.map((file) => ({ ...file, readable: false })) },
    }).success).toBe(false);
  });

  it('returns only the bounded environment fields and all three model-file checks', () => {
    const valid = {
      checkedAt: '2026-07-18T04:00:00.000Z',
      dataDirectory: '/private/user-data',
      trainingRecordCount: 2,
      localAsr: { state: 'ready' as const, ready: true, files: modelFiles },
    };
    expect(GetEnvironmentStatusOutputSchema.parse(valid)).toEqual(valid);
    expect(
      GetEnvironmentStatusOutputSchema.safeParse({ ...valid, secret: 'must-not-cross-ipc' }).success,
    ).toBe(false);
    expect(
      GetEnvironmentStatusOutputSchema.safeParse({
        ...valid,
        localAsr: { state: 'ready', ready: true, files: [modelFiles[0], modelFiles[0], modelFiles[2]] },
      }).success,
    ).toBe(false);
    expect(
      GetEnvironmentStatusOutputSchema.safeParse({
        ...valid,
        localAsr: {
          state: 'ready',
          ready: true,
          files: modelFiles.map((file, index) =>
            index === 0 ? { ...file, readable: false } : file,
          ),
        },
      }).success,
    ).toBe(false);
  });

  it('requires exact confirmation sentinels for destructive and reset actions', () => {
    expect(
      ClearTrainingDataInputSchema.safeParse({
        confirmation: CLEAR_TRAINING_DATA_CONFIRMATION,
      }).success,
    ).toBe(true);
    expect(ClearTrainingDataInputSchema.safeParse({ confirmation: 'yes' }).success).toBe(false);
    expect(
      ResetNonSensitiveSettingsInputSchema.safeParse({
        confirmation: RESET_NONSENSITIVE_SETTINGS_CONFIRMATION,
      }).success,
    ).toBe(true);
    expect(ResetNonSensitiveSettingsInputSchema.safeParse({}).success).toBe(false);
  });
});
