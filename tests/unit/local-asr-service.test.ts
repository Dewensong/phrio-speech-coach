// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalAsrService } from '../../src/backend/services/local-asr-service';
import { annotateFinalSegment } from '../../src/shared';

const temporaryDirectories: string[] = [];

async function createModelRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phrio-local-asr-test-'));
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

describe('LocalAsrService endpoint promotion', () => {
  it('aggregates content-free partial and final latency metrics with lower endpoint thresholds', async () => {
    const root = await createModelRoot();
    const diagnostics = vi.fn();
    let recognizerConfig: Record<string, unknown> | null = null;
    let feedCount = 0;
    let finished = false;
    const service = new LocalAsrService(root, {
      diagnostics: { record: diagnostics },
      loadModule: () => ({
        OnlineRecognizer: class {
          constructor(config: unknown) {
            recognizerConfig = config as Record<string, unknown>;
          }

          createStream() {
            return {
              acceptWaveform: () => { feedCount += 1; },
              inputFinished: () => { finished = true; },
            };
          }

          isReady() { return false; }
          decode() { return undefined; }
          getResult() {
            if (finished) return { text: '' };
            return { text: feedCount === 1 ? '第一' : feedCount === 2 ? '第一步' : '第一步完成' };
          }
          isEndpoint() { return feedCount === 3; }
          reset() { return undefined; }
        },
      }),
    });
    const identity = { attemptId: 'attempt-latency-metrics', generation: 1 };

    service.start(identity);
    service.feed({ ...identity, samples: new Float32Array(8_000) });
    service.feed({ ...identity, samples: new Float32Array(4_000) });
    service.feed({ ...identity, samples: new Float32Array(12_800) });
    expect(service.stop(identity)).toBeNull();

    expect(recognizerConfig).toMatchObject({
      enableEndpoint: true,
      rule1MinTrailingSilence: 1.8,
      rule2MinTrailingSilence: 0.8,
      rule3MinUtteranceLength: 20,
    });
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.attempt.stopped',
      fields: expect.objectContaining({
        feedCount: 3,
        firstPartialAudioMs: 500,
        partialGapCount: 1,
        averagePartialGapMs: 250,
        maximumPartialGapMs: 250,
        partialToFinalCount: 1,
        averagePartialToFinalMs: 800,
        maximumPartialToFinalMs: 800,
      }),
    }));
    const serializedDiagnostics = JSON.stringify(diagnostics.mock.calls);
    expect(serializedDiagnostics).not.toContain('第一步完成');
  });

  it('emits content-free attempt and segment diagnostics without affecting ASR', async () => {
    const root = await createModelRoot();
    const diagnostics = vi.fn();
    let feedCount = 0;
    let finished = false;
    const service = new LocalAsrService(root, {
      diagnostics: { record: diagnostics },
      loadModule: () => ({
        OnlineRecognizer: class {
          createStream() {
            return {
              acceptWaveform: () => { feedCount += 1; },
              inputFinished: () => { finished = true; },
            };
          }

          isReady() { return false; }
          decode() { return undefined; }
          getResult() {
            if (finished) return { text: '绝不能进入日志的尾句原文' };
            return { text: feedCount === 1 ? '绝不能进入日志的临时原文' : '绝不能进入日志的落定原文' };
          }
          isEndpoint() { return feedCount === 2; }
          reset() { return undefined; }
        },
      }),
    });
    const identity = { attemptId: 'attempt-diagnostic-safe', generation: 3 };

    service.start(identity);
    expect(service.feed({ ...identity, samples: new Float32Array([0.314159]) }))
      .toMatchObject({ isFinal: false });
    expect(service.feed({ ...identity, samples: new Float32Array([0.271828]) }))
      .toMatchObject({ isFinal: true });
    expect(service.stop(identity)).toMatchObject({ isFinal: true });

    expect(diagnostics.mock.calls.map(([event]) => event.event)).toEqual(expect.arrayContaining([
      'asr.attempt.starting',
      'asr.attempt.started',
      'asr.partial.emitted',
      'asr.final.emitted',
      'asr.attempt.stopping',
      'asr.attempt.stopped',
    ]));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.partial.emitted',
      fields: expect.objectContaining({ characterCount: expect.any(Number), generation: 3 }),
    }));
    const serializedDiagnostics = JSON.stringify(diagnostics.mock.calls);
    expect(serializedDiagnostics).not.toContain('绝不能进入日志');
    expect(serializedDiagnostics).not.toContain('0.314159');
    expect(serializedDiagnostics).not.toContain('0.271828');
  });

  it('keeps the ASR path fail-open when a diagnostic sink throws or rejects', async () => {
    const root = await createModelRoot();
    let feedCount = 0;
    const service = new LocalAsrService(root, {
      diagnostics: {
        record: vi.fn()
          .mockImplementationOnce(() => { throw new Error('diagnostic disk failure'); })
          .mockRejectedValue(new Error('diagnostic async failure')),
      },
      loadModule: () => ({
        OnlineRecognizer: class {
          createStream() {
            return {
              acceptWaveform: () => { feedCount += 1; },
              inputFinished: () => undefined,
            };
          }

          isReady() { return false; }
          decode() { return undefined; }
          getResult() { return { text: '业务结果不受日志影响' }; }
          isEndpoint() { return feedCount > 0; }
          reset() { return undefined; }
        },
      }),
    });
    const identity = { attemptId: 'attempt-diagnostic-fail-open', generation: 1 };

    expect(service.start(identity)).toMatchObject({ modelVersion: expect.any(String) });
    expect(service.feed({ ...identity, samples: new Float32Array([0.1]) }))
      .toMatchObject({ isFinal: true });
    expect(() => service.stop(identity)).not.toThrow();
    await Promise.resolve();
  });

  it('finalizes an unchanged partial when the recognizer reports an endpoint', async () => {
    const root = await createModelRoot();

    let feedCount = 0;
    let resetCount = 0;
    const service = new LocalAsrService(root, {
      loadModule: () => ({
        OnlineRecognizer: class {
          createStream() {
            return {
              acceptWaveform: () => { feedCount += 1; },
              inputFinished: () => undefined,
            };
          }

          isReady() { return false; }
          decode() { return undefined; }
          getResult() { return { text: '本周冻结新增需求' }; }
          isEndpoint() { return feedCount >= 2; }
          reset() { resetCount += 1; }
        },
      }),
    });

    service.start({ attemptId: 'attempt-endpoint', generation: 1 });
    const partial = service.feed({
      attemptId: 'attempt-endpoint',
      generation: 1,
      samples: new Float32Array([0.1]),
    });
    expect(service.getFinalSegments({ attemptId: 'attempt-endpoint', generation: 1 })).toEqual([]);
    const final = service.feed({
      attemptId: 'attempt-endpoint',
      generation: 1,
      samples: new Float32Array([0.1]),
    });

    expect(partial).toMatchObject({ isFinal: false, revision: 1, sequence: 0 });
    expect(final).toMatchObject({
      id: partial?.id,
      text: partial?.text,
      isFinal: true,
      revision: 2,
      sequence: 0,
    });
    expect(resetCount).toBe(1);
    const ledger = service.getFinalSegments({ attemptId: 'attempt-endpoint', generation: 1 });
    expect(ledger).toEqual([final]);
    (ledger[0] as { text: string }).text = 'renderer 尝试篡改返回副本';
    expect(service.getFinalSegments({ attemptId: 'attempt-endpoint', generation: 1 })[0]?.text)
      .toBe('本周冻结新增需求');

    expect(() => service.start({ attemptId: 'attempt-endpoint', generation: 1 }))
      .toThrowError(expect.objectContaining({ code: 'ASR_FINAL_LEDGER_CONFLICT' }));
    expect(service.getFinalSegments({ attemptId: 'attempt-endpoint', generation: 1 })).toEqual([final]);
    service.start({ attemptId: 'attempt-endpoint', generation: 2 });
    expect(service.getFinalSegments({ attemptId: 'attempt-endpoint', generation: 2 })).toEqual([]);
    service.cancel();
    expect(service.getFinalSegments({ attemptId: 'attempt-endpoint', generation: 1 })).toEqual([]);
  });

  it('attests a stop tail as final while never recording partial text', async () => {
    const root = await createModelRoot();
    let finished = false;
    const service = new LocalAsrService(root, {
      loadModule: () => ({
        OnlineRecognizer: class {
          createStream() {
            return {
              acceptWaveform: () => undefined,
              inputFinished: () => { finished = true; },
            };
          }

          isReady() { return false; }
          decode() { return undefined; }
          getResult() { return { text: finished ? '尾句最终文本' : '尾句临时文本' }; }
          isEndpoint() { return false; }
          reset() { return undefined; }
        },
      }),
    });
    const identity = { attemptId: 'attempt-tail-ledger', generation: 1 };
    service.start(identity);
    expect(service.feed({ ...identity, samples: new Float32Array([0.1]) }))
      .toMatchObject({ text: '尾句临时文本', isFinal: false });
    expect(service.getFinalSegments(identity)).toEqual([]);
    const tail = service.stop(identity);
    expect(tail).toMatchObject({ text: '尾句最终文本', isFinal: true });
    expect(service.getFinalSegments(identity)).toEqual([tail]);
  });

  it('atomically abandons an incomplete stream only while the final ledger is empty', async () => {
    const root = await createModelRoot();
    let streamOrdinal = 0;
    const acceptedByStream: number[] = [];
    const finishedStreams = new Set<number>();
    const service = new LocalAsrService(root, {
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
    const identity = { attemptId: 'attempt-atomic-restart', generation: 1 };

    service.start(identity);
    expect(service.feed({ ...identity, samples: new Float32Array([0.1]) }))
      .toMatchObject({ isFinal: false, text: '不完整 partial' });
    expect(service.restartIfNoFinal(identity)).toMatchObject({ modelVersion: expect.any(String) });
    expect(streamOrdinal).toBe(2);
    expect(service.getFinalSegments(identity)).toEqual([]);

    service.feed({ ...identity, samples: new Float32Array([0.1, 0.2, 0.3, 0.4]) });
    const tail = service.stop(identity);
    expect(tail).toMatchObject({ isFinal: true, text: '恢复后的完整尾句' });
    expect(() => service.restartIfNoFinal(identity))
      .toThrowError(expect.objectContaining({ code: 'ASR_FINAL_LEDGER_CONFLICT' }));
    expect(service.getFinalSegments(identity)).toEqual([tail]);
  });

  it('uses accepted samples rather than wall time for a stop-finalized tail', async () => {
    const root = await createModelRoot();
    let now = 0;
    let finished = false;
    const service = new LocalAsrService(root, {
      now: () => now,
      loadModule: () => ({
        OnlineRecognizer: class {
          createStream() {
            return {
              acceptWaveform: () => undefined,
              inputFinished: () => { finished = true; },
            };
          }

          isReady() { return false; }
          decode() { return undefined; }
          getResult() { return { text: finished ? '两秒尾句' : '' }; }
          isEndpoint() { return false; }
          reset() { return undefined; }
        },
      }),
    });
    const identity = { attemptId: 'attempt-stop-sample-clock', generation: 1 };
    service.start(identity);
    service.feed({ ...identity, samples: new Float32Array(32_000).fill(0.1) });
    now = 999_999;

    expect(service.stop(identity)).toMatchObject({
      isFinal: true,
      startMs: 0,
      endMs: 2_000,
    });
  });

  it('starts each new segment at its first non-empty result and preserves a measurable pause', async () => {
    const root = await createModelRoot();
    let now = 0;
    let feedCount = 0;
    const service = new LocalAsrService(root, {
      now: () => now,
      loadModule: () => ({
        OnlineRecognizer: class {
          createStream() {
            return {
              acceptWaveform: () => { feedCount += 1; },
              inputFinished: () => undefined,
            };
          }

          isReady() { return false; }
          decode() { return undefined; }
          getResult() {
            if (feedCount === 3) return { text: '' };
            return { text: feedCount <= 2 ? '第一句结论' : '第二句行动' };
          }
          isEndpoint() { return feedCount === 2 || feedCount === 5; }
          reset() { return undefined; }
        },
      }),
    });

    service.start({ attemptId: 'attempt-timestamps', generation: 1 });
    now = 1_000;
    service.feed({
      attemptId: 'attempt-timestamps',
      generation: 1,
      samples: new Float32Array(16_000).fill(0.1),
    });
    now = 2_000;
    const firstFinal = service.feed({
      attemptId: 'attempt-timestamps',
      generation: 1,
      samples: new Float32Array(16_000).fill(0.1),
    });
    now = 4_000;
    expect(service.feed({
      attemptId: 'attempt-timestamps',
      generation: 1,
      samples: new Float32Array(32_000),
    })).toBeNull();
    now = 5_000;
    service.feed({
      attemptId: 'attempt-timestamps',
      generation: 1,
      samples: new Float32Array(16_000).fill(0.1),
    });
    now = 6_000;
    const secondFinal = service.feed({
      attemptId: 'attempt-timestamps',
      generation: 1,
      samples: new Float32Array(16_000).fill(0.1),
    });

    expect(firstFinal).toMatchObject({ isFinal: true, startMs: 0, endMs: 2_000 });
    expect(secondFinal).toMatchObject({ isFinal: true, startMs: 5_000, endMs: 6_000 });
    const annotations = annotateFinalSegment(secondFinal!, 1, {
      previousFinalEndMs: firstFinal!.endMs,
    });
    expect(annotations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'long_pause', evidence: '句前停顿 3 秒' }),
    ]));
  });

  it('uses the 16 kHz sample clock when retained PCM is replayed faster than real time', async () => {
    const root = await createModelRoot();
    let feedCount = 0;
    const service = new LocalAsrService(root, {
      now: () => 7,
      loadModule: () => ({
        OnlineRecognizer: class {
          createStream() {
            return {
              acceptWaveform: () => { feedCount += 1; },
              inputFinished: () => undefined,
            };
          }

          isReady() { return false; }
          decode() { return undefined; }
          getResult() { return { text: feedCount === 90 ? '九十秒离线回放' : '' }; }
          isEndpoint() { return feedCount === 90; }
          reset() { return undefined; }
        },
      }),
    });
    const identity = { attemptId: 'attempt-offline-clock', generation: 1 };
    const oneSecond = new Float32Array(16_000).fill(0.1);
    service.start(identity);

    let final: ReturnType<LocalAsrService['feed']> = null;
    for (let index = 0; index < 90; index += 1) {
      final = service.feed({ ...identity, samples: oneSecond });
    }

    expect(final).toMatchObject({
      isFinal: true,
      startMs: 0,
      endMs: 90_000,
    });
  });
});
