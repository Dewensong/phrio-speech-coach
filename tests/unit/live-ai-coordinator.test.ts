import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DeepReportCoordinator,
  LiveHintCoordinator,
  type LiveHintRequest,
  type LiveHintResult,
} from '../../src/shared';

const immediatePolicy = {
  minimumNewFinalCharacters: 1,
  debounceMs: 1,
  cooldownMs: 0,
  maximumRequests: 8,
  maximumWindowCharacters: 30,
  timeoutMs: 1_000,
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe('AI task coordinators', () => {
  it('debounces cumulative final text and limits it to one request window', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue('先说结论');
    const results: LiveHintResult[] = [];
    const coordinator = new LiveHintCoordinator({
      attemptId: 'attempt-1', generation: 1,
      policy: { minimumNewFinalCharacters: 5, debounceMs: 100, cooldownMs: 0, maximumRequests: 3, maximumWindowCharacters: 8, timeoutMs: 1_000 },
      request, onResult: (result) => results.push(result),
    });
    coordinator.appendFinal('第一句');
    coordinator.appendFinal('第二句');
    await vi.advanceTimersByTimeAsync(100);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].finalTextWindow.length).toBeLessThanOrEqual(8);
    await vi.runAllTimersAsync();
    expect(results[0]).toMatchObject({ stale: false, reason: 'accepted' });
  });

  it('deduplicates normalized hint text after the first accepted result', async () => {
    vi.useFakeTimers();
    const request = vi.fn()
      .mockResolvedValueOnce('先说结论')
      .mockResolvedValueOnce(' 先 说 结论 ');
    const results: LiveHintResult[] = [];
    const coordinator = new LiveHintCoordinator({
      attemptId: 'attempt-1', generation: 1,
      policy: immediatePolicy,
      request, onResult: (result) => results.push(result),
    });
    coordinator.appendFinal('第一句');
    await vi.advanceTimersByTimeAsync(1);
    coordinator.appendFinal('第二句');
    await vi.advanceTimersByTimeAsync(1);

    expect(results.map((result) => result.reason)).toEqual(['accepted', 'duplicate']);
    expect(results[1]).toMatchObject({ stale: true, text: '先 说 结论' });
  });

  it('times out even when the transport ignores abort and resolves later', async () => {
    vi.useFakeTimers();
    let resolveLate!: (value: string) => void;
    const request = vi.fn((_input: LiveHintRequest) => new Promise<string>((resolve) => { resolveLate = resolve; }));
    const results: LiveHintResult[] = [];
    const coordinator = new LiveHintCoordinator({
      attemptId: 'attempt-1', generation: 1,
      policy: { ...immediatePolicy, timeoutMs: 10 },
      request, onResult: (result) => results.push(result),
    });

    coordinator.appendFinal('足够触发');
    await vi.advanceTimersByTimeAsync(1);
    const signal = request.mock.calls[0]?.[0].signal;
    await vi.advanceTimersByTimeAsync(10);

    expect(signal).toMatchObject({ aborted: true, reason: 'timeout' });
    expect(results).toEqual([{
      requestSequence: 1, text: '', stale: true, reason: 'timeout',
    }]);

    resolveLate('绝不能被接受的迟到提示');
    await Promise.resolve();
    await Promise.resolve();
    expect(results).toHaveLength(1);
  });

  it('classifies a superseded request as late instead of timeout', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: string) => void> = [];
    const request = vi.fn((_input: LiveHintRequest) => new Promise<string>((resolve) => { resolvers.push(resolve); }));
    const results: LiveHintResult[] = [];
    const coordinator = new LiveHintCoordinator({
      attemptId: 'attempt-1', generation: 1,
      policy: immediatePolicy,
      request, onResult: (result) => results.push(result),
    });

    coordinator.appendFinal('第一句');
    await vi.advanceTimersByTimeAsync(1);
    const firstSignal = request.mock.calls[0]?.[0].signal;
    coordinator.appendFinal('第二句');
    await vi.advanceTimersByTimeAsync(1);

    expect(firstSignal).toMatchObject({ aborted: true, reason: 'superseded' });
    expect(results).toEqual([{
      requestSequence: 1, text: '', stale: true, reason: 'late',
    }]);

    resolvers[1]?.('采用新的提示');
    await vi.advanceTimersByTimeAsync(0);
    expect(results.at(-1)).toMatchObject({ requestSequence: 2, reason: 'accepted', stale: false });

    resolvers[0]?.('忽略 abort 的旧提示');
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(2);
  });

  it('classifies an in-flight request as disabled and never accepts its late result', async () => {
    vi.useFakeTimers();
    let resolveLate!: (value: string) => void;
    const request = vi.fn((_input: LiveHintRequest) => new Promise<string>((resolve) => { resolveLate = resolve; }));
    const results: LiveHintResult[] = [];
    const coordinator = new LiveHintCoordinator({
      attemptId: 'attempt-1', generation: 1,
      policy: immediatePolicy,
      request, onResult: (result) => results.push(result),
    });

    coordinator.appendFinal('足够触发');
    await vi.advanceTimersByTimeAsync(1);
    const signal = request.mock.calls[0]?.[0].signal;
    coordinator.disable();
    await vi.advanceTimersByTimeAsync(0);

    expect(signal).toMatchObject({ aborted: true, reason: 'disabled' });
    expect(results).toEqual([{
      requestSequence: 1, text: '', stale: true, reason: 'disabled',
    }]);

    resolveLate('关闭后到达的提示');
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(1);
  });

  it('returns a queued full-report task without blocking the realtime caller', async () => {
    let finish!: (value: string) => void;
    const coordinator = new DeepReportCoordinator<string>(() => new Promise((resolve) => { finish = resolve; }));
    const queued = coordinator.enqueue();
    expect(queued.status).toBe('queued');
    let completed = false;
    void queued.task.then(() => { completed = true; });
    expect(completed).toBe(false);
    finish('完整报告');
    await expect(queued.task).resolves.toBe('完整报告');
  });
});
