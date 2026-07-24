import { describe, expect, it } from 'vitest';

import {
  annotateFinalSegment,
  confirmOrWithdrawAnnotations,
  createLiveAttemptState,
  freezeAttemptSnapshot,
  reconcileFinalTailAnnotations,
  reduceLiveAttempt,
  type LiveAttemptEvent,
  type TranscriptSegment,
} from '../../src/shared';

const at = '2026-07-17T04:00:00.000Z';

function segment(input: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'attempt-1-seg-0', attemptId: 'attempt-1', sequence: 0, revision: 1,
    text: '嗯，本周是不是先冻结新增需求。', startMs: 0, endMs: 4_000,
    confidence: null, isFinal: false, emittedAt: at, finalizedAt: null,
    modelVersion: 'test-1', ...input,
  };
}

type EventWithoutGeneration = LiveAttemptEvent extends infer Event
  ? Event extends LiveAttemptEvent
    ? Omit<Event, 'generation'>
    : never
  : never;

function event(value: EventWithoutGeneration): LiveAttemptEvent {
  return { ...value, generation: 1 } as LiveAttemptEvent;
}

describe('live attempt event model', () => {
  it('replaces partials, appends finals and ignores duplicate, old and out-of-order events', () => {
    let state = createLiveAttemptState({ sessionId: 'session-1', attemptId: 'attempt-1', generation: 1, kind: 'initial' });
    state = reduceLiveAttempt(state, event({ id: 'e-1', type: 'segment', segment: segment() }));
    state = reduceLiveAttempt(state, event({ id: 'e-2', type: 'segment', segment: segment({ revision: 2, text: '嗯，本周先冻结新增需求。' }) }));
    state = reduceLiveAttempt(state, event({ id: 'e-3', type: 'segment', segment: segment({ revision: 3, text: '本周先冻结新增需求。', isFinal: true, finalizedAt: at }) }));
    state = reduceLiveAttempt(state, event({ id: 'e-3', type: 'segment', segment: segment({ revision: 4, text: '重复事件', isFinal: true, finalizedAt: at }) }));
    state = reduceLiveAttempt(state, event({ id: 'e-4', type: 'segment', segment: segment({ revision: 2, text: '迟到旧 revision' }) }));
    state = reduceLiveAttempt(state, event({ id: 'e-5', type: 'segment', segment: segment({ id: 'attempt-1-seg-old', sequence: 0 }) }));
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0]).toMatchObject({ text: '本周先冻结新增需求。', revision: 3, isFinal: true });
    expect(state.metrics.finalSegments).toBe(1);
  });

  it('permits local annotation only after final and maps exact spans to stable O ids', () => {
    expect(() => annotateFinalSegment(segment())).toThrow('ANNOTATIONS_REQUIRE_FINAL_SEGMENT');
    const final = segment({ isFinal: true, finalizedAt: at });
    const annotations = annotateFinalSegment(final);
    expect(annotations.map((item) => item.displayId)).toEqual(['O1', 'O2']);
    expect(annotations[0]?.sourceSpan).toEqual({ start: 0, end: 1, text: '嗯' });
    expect(annotations[1]?.sourceSpan?.text).toBe('是不是');
  });

  it('confirms final exact and metric evidence, withdraws stale spans, and never revives history', () => {
    const partial = segment();
    expect(() => confirmOrWithdrawAnnotations({
      segment: partial,
      annotations: [],
      at,
    })).toThrow('ANNOTATION_CONFIRMATION_REQUIRES_FINAL_SEGMENT');

    const final = segment({ isFinal: true, finalizedAt: at });
    const provisional = annotateFinalSegment(final, 1, { previousFinalEndMs: -3_000 });
    const confirmed = confirmOrWithdrawAnnotations({ segment: final, annotations: provisional, at });
    expect(confirmed.length).toBeGreaterThan(2);
    expect(confirmed.every((item) => item.lifecycle === 'confirmed')).toBe(true);
    expect(confirmed.find((item) => item.type === 'long_pause')).toMatchObject({
      sourceSpan: null,
      lifecycle: 'confirmed',
    });

    const correctedFinal = { ...final, text: '本周先冻结新增需求。' };
    const withdrawn = confirmOrWithdrawAnnotations({
      segment: correctedFinal,
      annotations: confirmed,
      at: '2026-07-17T04:01:00.000Z',
    });
    expect(withdrawn.filter((item) => item.sourceSpan !== null).every(
      (item) => item.lifecycle === 'withdrawn',
    )).toBe(true);
    const replayed = confirmOrWithdrawAnnotations({ segment: final, annotations: withdrawn, at });
    expect(replayed.filter((item) => item.sourceSpan !== null).every(
      (item) => item.lifecycle === 'withdrawn',
    )).toBe(true);
  });

  it('supports all nine approved feedback categories without inventing exact spans', () => {
    const final = segment({
      text: '嗯，我重说，本周本周大概后面处理。',
      startMs: 4_000,
      endMs: 4_500,
      isFinal: true,
      finalizedAt: at,
    });
    const annotations = annotateFinalSegment(final, 1, {
      previousFinalEndMs: 0,
      expectedTaskTerms: ['负责人'],
      isLastSegment: true,
    });
    expect(new Set(annotations.map((item) => item.type))).toEqual(new Set([
      'filler', 'hedge', 'vague', 'repetition', 'self_correction', 'long_pause',
      'speech_rate', 'structure', 'task_gap',
    ]));
    expect(annotations.filter((item) => ['long_pause', 'speech_rate', 'structure', 'task_gap'].includes(item.type)).every((item) => item.sourceSpan === null)).toBe(true);
  });

  it('reconciles frozen-task tail signals idempotently and preserves stable history ids', () => {
    expect(() => reconcileFinalTailAnnotations({
      finalSegments: [segment()],
      existingAnnotations: [],
      startingOrdinal: 1,
      task: null,
    })).toThrow('TAIL_ANNOTATIONS_REQUIRE_FINAL_SEGMENTS');

    const final = segment({
      text: '我们今天先看一下当前情况。',
      isFinal: true,
      finalizedAt: at,
    });
    const task = {
      requiredFields: ['decision', 'reasons', 'next_action'],
      successConditions: ['结论明确', '理由完整', '下一步清楚'],
    } as const;
    const initial = reconcileFinalTailAnnotations({
      finalSegments: [final],
      existingAnnotations: [],
      startingOrdinal: 1,
      task,
    });
    expect(initial.upserts.map((item) => [item.type, item.displayId])).toEqual([
      ['structure', 'O1'],
      ['task_gap', 'O2'],
    ]);
    expect(initial.upserts.every((item) => item.sourceSpan === null)).toBe(true);
    expect(initial.upserts.every((item) => item.lifecycle === 'confirmed')).toBe(true);
    expect(initial.upserts.find((item) => item.type === 'task_gap')?.evidence)
      .toMatch(/结论或决定.*理由或论证连接.*冻结成功条件/u);

    const repeated = reconcileFinalTailAnnotations({
      finalSegments: [final, final],
      existingAnnotations: initial.upserts,
      startingOrdinal: initial.nextOrdinal,
      task,
    });
    expect(repeated).toEqual({ upserts: [], withdrawals: [], nextOrdinal: 3 });

    const updated = reconcileFinalTailAnnotations({
      finalSegments: [final],
      existingAnnotations: initial.upserts,
      startingOrdinal: initial.nextOrdinal,
      task: { ...task, successConditions: ['必须给出明确结论'] },
    });
    expect(updated.upserts).toHaveLength(1);
    expect(updated.upserts[0]).toMatchObject({
      id: initial.upserts[1]?.id,
      displayId: 'O2',
      type: 'task_gap',
    });
    expect(updated.nextOrdinal).toBe(3);

    const migrated = reconcileFinalTailAnnotations({
      finalSegments: [final, {
        ...final,
        id: 'attempt-1-seg-1',
        sequence: 1,
        text: '目前情况就是这样。',
      }],
      existingAnnotations: initial.upserts,
      startingOrdinal: initial.nextOrdinal,
      task,
    });
    expect(migrated.withdrawals).toEqual(initial.upserts.map((item) => ({
      annotationId: item.id,
      reason: 'tail_segment_replaced',
      at,
    })));
    expect(migrated.upserts.map((item) => [item.segmentId, item.displayId])).toEqual([
      ['attempt-1-seg-1', 'O3'],
      ['attempt-1-seg-1', 'O4'],
    ]);

    const resolved = reconcileFinalTailAnnotations({
      finalSegments: [{
        ...final,
        text: '我的决定是本周冻结新增需求，因为仍有阻塞。下一步由研发本周完成修复。',
      }],
      existingAnnotations: initial.upserts,
      startingOrdinal: initial.nextOrdinal,
      task,
    });
    expect(resolved.upserts).toEqual([]);
    expect(resolved.withdrawals.map((item) => item.annotationId)).toEqual(
      initial.upserts.map((item) => item.id),
    );
    expect(resolved.withdrawals.every((item) => item.reason === 'tail_reanalysis_resolved'))
      .toBe(true);

    const withdrawnHistory = initial.upserts.map((item) => ({
      ...item,
      lifecycle: 'withdrawn' as const,
      withdrawnReason: 'tail_reanalysis_resolved',
    }));
    const returned = reconcileFinalTailAnnotations({
      finalSegments: [final],
      existingAnnotations: withdrawnHistory,
      startingOrdinal: initial.nextOrdinal,
      task,
    });
    expect(returned.upserts.map((item) => item.displayId)).toEqual(['O3', 'O4']);
    expect(returned.upserts.every((item) => item.lifecycle === 'confirmed')).toBe(true);
    expect(returned.withdrawals).toEqual([]);
  });

  it('retains withdrawn evidence as neutral history and removes it from final-only counts', () => {
    const final = segment({ isFinal: true, finalizedAt: at });
    let state = createLiveAttemptState({ sessionId: 'session-1', attemptId: 'attempt-1', generation: 1, kind: 'initial' });
    state = reduceLiveAttempt(state, event({ id: 'e-1', type: 'segment', segment: final }));
    const annotations = annotateFinalSegment(final);
    state = reduceLiveAttempt(state, event({ id: 'e-2', type: 'annotations', segmentId: final.id, annotations }));
    expect(state.metrics.fillers).toBe(1);
    state = reduceLiveAttempt(state, event({ id: 'e-3', type: 'annotation_withdrawn', annotationId: annotations[0]!.id, reason: 'user_correction', at }));
    expect(state.annotations[0]).toMatchObject({ displayId: 'O1', lifecycle: 'withdrawn' });
    expect(state.metrics.fillers).toBe(0);
  });

  it('covers permission, no speech, reconnect, network and AI degradation independently', () => {
    let state = createLiveAttemptState({ sessionId: 'session-1', attemptId: 'attempt-1', generation: 1, kind: 'initial', liveAiEnabled: true, liveAiConsentValid: true });
    state = reduceLiveAttempt(state, event({ id: 'e-1', type: 'permission_granted' }));
    state = reduceLiveAttempt(state, event({ id: 'e-2', type: 'recording_started' }));
    state = reduceLiveAttempt(state, event({ id: 'e-3', type: 'no_speech' }));
    expect(state.capture).toBe('recording');
    expect(state.asr).toBe('no_speech');
    state = reduceLiveAttempt(state, event({ id: 'e-4', type: 'asr_reconnecting' }));
    state = reduceLiveAttempt(state, event({ id: 'e-5', type: 'network', status: 'offline' }));
    expect(state.asr).toBe('reconnecting');
    expect(state.analysis).toBe('local_only');
    state = reduceLiveAttempt(state, event({ id: 'e-6', type: 'ai_failed', reason: 'timeout' }));
    expect(state.analysis).toBe('ai_failed');
    expect(state.capture).toBe('recording');

    state = reduceLiveAttempt(state, event({ id: 'e-7', type: 'asr_degraded', reason: 'PCM unavailable' }));
    state = reduceLiveAttempt(state, event({ id: 'e-8', type: 'voice_detected' }));
    state = reduceLiveAttempt(state, event({ id: 'e-9', type: 'no_speech' }));
    expect(state.asr).toBe('degraded');
    expect(state.lastError).toBe('PCM unavailable');
  });

  it('clears a transient partial before same-audio ASR recovery accepts a fresh revision', () => {
    let state = createLiveAttemptState({
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      generation: 1,
      kind: 'initial',
    });
    state = reduceLiveAttempt(state, event({ id: 'e-1', type: 'recording_started' }));
    state = reduceLiveAttempt(state, event({
      id: 'e-2',
      type: 'segment',
      segment: segment({ revision: 7, text: '旧的临时稿' }),
    }));
    state = reduceLiveAttempt(state, event({ id: 'e-3', type: 'asr_degraded', reason: 'feed failed' }));

    state = reduceLiveAttempt(state, event({ id: 'e-4', type: 'asr_retry_reset' }));

    expect(state.segments).toEqual([]);
    expect(state.highestSequence).toBe(-1);
    expect(state.asr).toBe('reconnecting');
    expect(state.lastError).toBeNull();
    const recoveredFinal = segment({
      revision: 1,
      text: '恢复后落定的 final',
      isFinal: true,
      finalizedAt: at,
    });
    state = reduceLiveAttempt(state, event({
      id: 'e-5',
      type: 'segment',
      segment: recoveredFinal,
    }));
    expect(state.segments).toEqual([recoveredFinal]);
    expect(state.metrics.finalSegments).toBe(1);
  });

  it('does not move an Attempt back to reconnecting when a retry reset arrives after final', () => {
    const final = segment({ isFinal: true, finalizedAt: at });
    let state = createLiveAttemptState({
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      generation: 1,
      kind: 'initial',
    });
    state = reduceLiveAttempt(state, event({ id: 'e-1', type: 'recording_started' }));
    state = reduceLiveAttempt(state, event({ id: 'e-2', type: 'segment', segment: final }));
    state = reduceLiveAttempt(state, event({ id: 'e-3', type: 'asr_retry_reset' }));

    expect(state.segments).toEqual([final]);
    expect(state.asr).toBe('segment_finalized');
    expect(state.metrics.finalSegments).toBe(1);
  });

  it('requires tail completion before freezing and excludes partial revisions', () => {
    let state = createLiveAttemptState({ sessionId: 'session-1', attemptId: 'attempt-1', generation: 1, kind: 'initial' });
    const final = segment({ isFinal: true, finalizedAt: at });
    state = reduceLiveAttempt(state, event({ id: 'e-1', type: 'recording_started' }));
    state = reduceLiveAttempt(state, event({ id: 'e-2', type: 'segment', segment: final }));
    state = reduceLiveAttempt(state, event({ id: 'e-3', type: 'stop_requested', audioWatermark: 9_000 }));
    expect(() => freezeAttemptSnapshot({ state, snapshotId: 'snapshot-1', frozenAt: at, transcriptVersion: 1 })).toThrow('ATTEMPT_NOT_READY_TO_FREEZE');
    state = reduceLiveAttempt(state, event({ id: 'e-4', type: 'tail_complete' }));
    const snapshot = freezeAttemptSnapshot({ state, snapshotId: 'snapshot-1', frozenAt: at, transcriptVersion: 1 });
    expect(snapshot.finalSegments).toHaveLength(1);
    expect(snapshot.audioWatermark).toBe(9_000);
  });

  it('refuses to create a new frozen snapshot without at least one final segment', () => {
    let state = createLiveAttemptState({
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      generation: 1,
      kind: 'initial',
    });
    state = reduceLiveAttempt(state, event({ id: 'e-1', type: 'recording_started' }));
    state = reduceLiveAttempt(state, event({
      id: 'e-2',
      type: 'stop_requested',
      audioWatermark: 1_000,
    }));
    state = reduceLiveAttempt(state, event({ id: 'e-3', type: 'tail_complete' }));

    expect(() => freezeAttemptSnapshot({
      state,
      snapshotId: 'snapshot-empty',
      frozenAt: at,
      transcriptVersion: 1,
    })).toThrow('ATTEMPT_HAS_NO_FINAL_TRANSCRIPT');
  });

  it('moves capture and transcription failures out of finalizing into explicit terminals', () => {
    let state = createLiveAttemptState({ sessionId: 'session-1', attemptId: 'attempt-1', generation: 1, kind: 'initial' });
    state = reduceLiveAttempt(state, event({ id: 'e-1', type: 'recording_started' }));
    state = reduceLiveAttempt(state, event({ id: 'e-2', type: 'stop_requested', audioWatermark: 4_000 }));
    state = reduceLiveAttempt(state, event({ id: 'e-3', type: 'transcription_failed', reason: 'ASR stop failed' }));
    expect(state).toMatchObject({ capture: 'recorded', asr: 'failed', lastError: 'ASR stop failed' });

    state = reduceLiveAttempt(state, event({ id: 'e-4', type: 'capture_interrupted', reason: 'device removed' }));
    expect(state).toMatchObject({ capture: 'interrupted', asr: 'failed', lastError: 'device removed' });
    state = reduceLiveAttempt(state, event({ id: 'e-5', type: 'tail_complete' }));
    expect(state.capture).toBe('interrupted');
  });

  it('resets all attempt evidence under a new generation and ignores late old events', () => {
    const final = segment({ isFinal: true, finalizedAt: at });
    let state = createLiveAttemptState({ sessionId: 'session-1', attemptId: 'attempt-1', generation: 1, kind: 'retry', liveAiEnabled: true, liveAiConsentValid: true });
    state = reduceLiveAttempt(state, event({ id: 'e-1', type: 'recording_started' }));
    state = reduceLiveAttempt(state, event({ id: 'e-2', type: 'segment', segment: final }));
    state = reduceLiveAttempt(state, event({ id: 'e-3', type: 'annotations', segmentId: final.id, annotations: annotateFinalSegment(final) }));
    state = reduceLiveAttempt(state, event({ id: 'e-4', type: 'attempt_reset', nextAttemptId: 'attempt-2', nextGeneration: 2 }));

    expect(state).toMatchObject({
      attemptId: 'attempt-2',
      generation: 2,
      capture: 'awaiting_permission',
      asr: 'idle',
      liveAiEnabled: false,
      liveAiConsentValid: true,
    });
    expect(state.segments).toEqual([]);
    expect(state.annotations).toEqual([]);
    expect(state.audioWatermark).toBeNull();
    const afterLateEvent = reduceLiveAttempt(state, event({ id: 'e-5', type: 'recording_started' }));
    expect(afterLateEvent).toBe(state);
  });

  it('drops late AI results and keeps disabling AI separate from consent revocation', () => {
    let state = createLiveAttemptState({ sessionId: 'session-1', attemptId: 'attempt-1', generation: 1, kind: 'initial', liveAiEnabled: true, liveAiConsentValid: true });
    const hint = (sequence: number) => ({ id: `hint-${sequence}`, attemptId: 'attempt-1', requestSequence: sequence, windowHash: `window-000${sequence}`, segmentIds: ['attempt-1-seg-0'], text: `提示 ${sequence}`, lifecycle: 'provisional' as const, createdAt: at, updatedAt: at, reason: null });
    state = reduceLiveAttempt(state, event({ id: 'e-1', type: 'hint', hint: hint(2) }));
    state = reduceLiveAttempt(state, event({ id: 'e-2', type: 'hint', hint: hint(1) }));
    expect(state.hints.at(-1)?.lifecycle).toBe('stale');
    state = reduceLiveAttempt(state, event({ id: 'e-3', type: 'live_ai', enabled: false }));
    expect(state.liveAiConsentValid).toBe(true);
    state = reduceLiveAttempt(state, event({ id: 'e-4', type: 'revoke_live_ai_consent' }));
    expect(state.liveAiConsentValid).toBe(false);
  });

  it('uses a monotonic source watermark and semantic upserts instead of a bounded event-id window', () => {
    const final = segment({ isFinal: true, finalizedAt: at });
    const annotation = annotateFinalSegment(final)[0]!;
    const liveHint = {
      id: 'hint-stable',
      attemptId: 'attempt-1',
      requestSequence: 1,
      windowHash: 'window-stable-1',
      segmentIds: [final.id],
      text: '先给结论',
      lifecycle: 'provisional' as const,
      createdAt: at,
      updatedAt: at,
      reason: null,
    };
    let state = createLiveAttemptState({
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      generation: 1,
      kind: 'initial',
      liveAiEnabled: true,
      liveAiConsentValid: true,
    });
    const replayable = [
      { id: 'source-1', sourceSequence: 1, generation: 1, type: 'segment', segment: final },
      { id: 'source-2', sourceSequence: 2, generation: 1, type: 'annotations', segmentId: final.id, annotations: [annotation] },
      { id: 'source-3', sourceSequence: 3, generation: 1, type: 'hint', hint: liveHint },
    ] as const satisfies readonly LiveAttemptEvent[];
    for (const item of replayable) state = reduceLiveAttempt(state, item);

    const frozenReplayInput = JSON.parse(JSON.stringify(state));
    for (const item of replayable) state = reduceLiveAttempt(state, item);
    expect(state).toEqual(frozenReplayInput);
    expect(state.lastSourceSequence).toBe(3);
    expect(state.segments).toHaveLength(1);
    expect(state.annotations).toHaveLength(1);
    expect(state.hints).toHaveLength(1);
    expect('acceptedEventIds' in state).toBe(false);

    state = reduceLiveAttempt(state, {
      ...replayable[2],
      id: 'different-transport-id',
      sourceSequence: 4,
    });
    expect(state.hints).toHaveLength(1);
    expect(state.lastSourceSequence).toBe(4);
  });
});
