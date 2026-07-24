// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TrustedRendererPolicy } from '../../src/backend/config/renderer-security';
import { IpcController } from '../../src/backend/controllers/ipc-controller';
import type { CloudAiService } from '../../src/backend/services/cloud-ai-service';
import type { DiagnosticLogService } from '../../src/backend/services/diagnostic-log-service';
import type { EnvironmentService } from '../../src/backend/services/environment-service';
import { LocalAsrService } from '../../src/backend/services/local-asr-service';
import type { PracticeSessionService } from '../../src/backend/services/practice-session-service';
import { IPC_CHANNELS } from '../../src/shared';

const temporaryDirectories: string[] = [];

async function createModelRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phrio-asr-restart-ipc-'));
  temporaryDirectories.push(root);
  const modelDirectory = path.join(root, 'sherpa-onnx-streaming-paraformer-bilingual-zh-en');
  await mkdir(modelDirectory, { recursive: true });
  await Promise.all(
    ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt'].map((name) =>
      writeFile(path.join(modelDirectory, name), 'fixture'),
    ),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Local ASR atomic recovery across the IPC boundary', () => {
  it('replaces an incomplete stream before stop and preserves the final-ledger guard', async () => {
    const modelRoot = await createModelRoot();
    let streamOrdinal = 0;
    const acceptedByStream: number[] = [];
    const finishedStreams = new Set<number>();
    const asr = new LocalAsrService(modelRoot, {
      loadModule: () => ({
        OnlineRecognizer: class {
          createStream() {
            const ordinal = streamOrdinal;
            streamOrdinal += 1;
            acceptedByStream[ordinal] = 0;
            return {
              ordinal,
              acceptWaveform: ({ samples }: { samples: Float32Array }) => {
                acceptedByStream[ordinal] = (acceptedByStream[ordinal] ?? 0) + samples.length;
              },
              inputFinished: () => { finishedStreams.add(ordinal); },
            };
          }

          isReady() { return false; }
          decode() { return undefined; }
          getResult(stream: unknown) {
            const ordinal = (stream as { ordinal: number }).ordinal;
            return {
              text: finishedStreams.has(ordinal) || (acceptedByStream[ordinal] ?? 0) >= 4
                ? '恢复后的完整尾句'
                : '不完整 partial',
            };
          }
          isEndpoint() { return false; }
          reset() { return undefined; }
        },
      }),
    });

    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: typeof handlers extends Map<string, infer H> ? H : never) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const practice = {
      getSession: vi.fn(() => ({ id: 'session-asr-recovery', status: 'first_attempt' })),
    } as unknown as PracticeSessionService;
    const cloudAi = {
      hasLiveAttemptLease: vi.fn(() => false),
      openLiveAttemptLease: vi.fn(),
      releaseLiveAttemptLease: vi.fn(),
      releaseLiveAttemptGeneration: vi.fn(),
    } as unknown as CloudAiService;
    const frame = { url: 'phrio-app://renderer/index.html' };
    const sender = { mainFrame: frame };
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    const rendererPolicy = {
      isTrustedWebContents: () => true,
      isTrustedUrl: () => true,
    } as unknown as TrustedRendererPolicy;
    const diagnostics = {
      generation: 0,
      record: vi.fn(),
      recordError: vi.fn(),
      recordIfGeneration: vi.fn(),
      recordErrorIfGeneration: vi.fn(),
    } as unknown as DiagnosticLogService;
    const controller = new IpcController(
      ipcMain,
      practice,
      asr,
      {} as EnvironmentService,
      cloudAi,
      rendererPolicy,
      diagnostics,
      { chooseExportPath: vi.fn(), openDirectory: vi.fn() },
    );
    controller.register();

    const identity = {
      sessionId: 'session-asr-recovery',
      attemptId: 'attempt-asr-recovery',
      generation: 1,
    };
    await expect(handlers.get(IPC_CHANNELS.ASR_START)!(event, identity))
      .resolves.toMatchObject({ modelVersion: expect.any(String) });
    await expect(handlers.get(IPC_CHANNELS.ASR_FEED)!(event, {
      attemptId: identity.attemptId,
      generation: identity.generation,
      samples: new Float32Array([0.1]),
    })).resolves.toMatchObject({ isFinal: false, text: '不完整 partial' });

    await expect(handlers.get(IPC_CHANNELS.ASR_START)!(event, {
      ...identity,
      restartIfNoFinal: true,
    })).resolves.toMatchObject({ modelVersion: expect.any(String) });
    expect(streamOrdinal).toBe(2);

    await handlers.get(IPC_CHANNELS.ASR_FEED)!(event, {
      attemptId: identity.attemptId,
      generation: identity.generation,
      samples: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    });
    await expect(handlers.get(IPC_CHANNELS.ASR_STOP)!(event, {
      attemptId: identity.attemptId,
      generation: identity.generation,
    })).resolves.toMatchObject({ isFinal: true, text: '恢复后的完整尾句' });

    await expect(handlers.get(IPC_CHANNELS.ASR_START)!(event, {
      ...identity,
      restartIfNoFinal: true,
    })).rejects.toMatchObject({ message: 'PHRIO_ASR_FINAL_LEDGER_CONFLICT' });
  });
});
