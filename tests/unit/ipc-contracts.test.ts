import { describe, expect, it } from 'vitest';

import {
  AppSettingsPatchSchema,
  IPC_CHANNELS,
  IPC_CONTRACTS,
  MAX_AUDIO_BYTES,
  SaveAttemptAudioInputSchema,
  SetLiveAttemptAiStateInputSchema,
  StartAsrInputSchema,
  FeedAsrInputSchema,
  TransitionSessionInputSchema,
} from '../../src/shared';

describe('IPC contracts', () => {
  it('uses a unique, namespaced channel for every contract', () => {
    const channels = Object.values(IPC_CHANNELS);
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels.every((channel) => channel.startsWith('phrio:'))).toBe(true);
    expect(Object.keys(IPC_CONTRACTS).sort()).toEqual([...channels].sort());
  });

  it('accepts bounded audio bytes and rejects unsupported or oversized input', () => {
    const valid = {
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      kind: 'initial' as const,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/webm;codecs=opus',
      durationMs: 1_000,
    };
    expect(SaveAttemptAudioInputSchema.safeParse(valid).success).toBe(true);
    expect(
      SaveAttemptAudioInputSchema.safeParse({ ...valid, attemptId: '../escape' }).success,
    ).toBe(false);
    expect(
      SaveAttemptAudioInputSchema.safeParse({ ...valid, mimeType: 'text/html' }).success,
    ).toBe(false);
    expect(
      SaveAttemptAudioInputSchema.safeParse({
        ...valid,
        bytes: new Uint8Array(MAX_AUDIO_BYTES + 1),
      }).success,
    ).toBe(false);
  });

  it('validates discriminated session transition events', () => {
    expect(
      TransitionSessionInputSchema.safeParse({
        sessionId: 'session-1',
        event: { type: 'start_practice' },
      }).success,
    ).toBe(true);
    expect(
      TransitionSessionInputSchema.safeParse({
        sessionId: 'session-1',
        event: { type: 'finish_retry_without_comparison' },
      }).success,
    ).toBe(true);
    expect(
      TransitionSessionInputSchema.safeParse({
        sessionId: 'session-1',
        event: { type: 'select_focus' },
      }).success,
    ).toBe(false);
    expect(
      TransitionSessionInputSchema.safeParse({
        sessionId: 'session-1',
        event: { type: 'finish_analysis_only' },
      }).success,
    ).toBe(false);
    expect(
      TransitionSessionInputSchema.safeParse({
        sessionId: 'session-1',
        event: {
          type: 'finish_analysis_only',
          diagnosisReportId: 'deep-report-current',
        },
      }).success,
    ).toBe(true);
    expect(
      TransitionSessionInputSchema.safeParse({
        sessionId: 'session-1',
        event: { type: 'view_comparison' },
      }).success,
    ).toBe(false);
    expect(
      TransitionSessionInputSchema.safeParse({
        sessionId: 'session-1',
        event: {
          type: 'view_comparison',
          comparisonArtifactId: 'paired-comparison-current',
        },
      }).success,
    ).toBe(true);
  });

  it('binds ASR start and live AI state to one strict session attempt identity', () => {
    const identity = {
      sessionId: 'session-live-1',
      attemptId: 'attempt-live-1',
      generation: 2,
    };
    expect(StartAsrInputSchema.parse(identity)).toEqual(identity);
    expect(StartAsrInputSchema.parse({ ...identity, restartIfNoFinal: true })).toEqual({
      ...identity,
      restartIfNoFinal: true,
    });
    expect(StartAsrInputSchema.safeParse({ ...identity, restartIfNoFinal: false }).success)
      .toBe(false);
    expect(StartAsrInputSchema.safeParse({
      attemptId: identity.attemptId,
      generation: identity.generation,
    }).success).toBe(false);
    expect(FeedAsrInputSchema.safeParse({
      ...identity,
      samples: new Float32Array([0.1]),
    }).success).toBe(false);

    expect(SetLiveAttemptAiStateInputSchema.parse({ ...identity, enabled: true })).toEqual({
      ...identity,
      enabled: true,
    });
    expect(SetLiveAttemptAiStateInputSchema.safeParse({
      ...identity,
      enabled: true,
      explicitAttemptAiOn: true,
    }).success).toBe(false);
  });

  it('requires settings updates to be non-empty and rejects unknown keys', () => {
    expect(AppSettingsPatchSchema.safeParse({ theme: 'dark' }).success).toBe(true);
    expect(AppSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(AppSettingsPatchSchema.safeParse({ aiEnabled: true }).success).toBe(false);
  });
});
