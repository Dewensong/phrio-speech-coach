import { describe, expect, it } from 'vitest';

import {
  AppSettingsSchema,
  AttemptSchema,
  DEFAULT_APP_SETTINGS,
  GATE_C_PM_TASK,
  ModePackSchema,
  P1_MODE_PACKS,
  PracticeSessionSchema,
  createPracticeSession,
} from '../../src/shared';

const now = '2026-07-16T08:00:00.000Z';

function recordedAttempt(kind: 'initial' | 'retry', sessionId = 'session-1') {
  return AttemptSchema.parse({
    id: `attempt-${kind}`,
    sessionId,
    kind,
    status: 'recorded',
    audioRef: `audio/${kind}.webm`,
    mimeType: 'audio/webm;codecs=opus',
    durationMs: kind === 'initial' ? 74_000 : 42_000,
    byteLength: 2_048,
    createdAt: now,
    updatedAt: now,
    confirmedAt: null,
  });
}

describe('shared domain schemas', () => {
  it('parses every P1 mode pack and its nested references', () => {
    expect(P1_MODE_PACKS).toHaveLength(3);
    for (const pack of P1_MODE_PACKS) {
      expect(ModePackSchema.parse(pack)).toEqual(pack);
    }
  });

  it('rejects a task that points to a criterion outside its mode pack', () => {
    const pack = structuredClone(P1_MODE_PACKS[0]);
    pack.tasks[0].focusCandidateCriterionIds = ['missing-criterion'];

    const result = ModePackSchema.safeParse(pack);
    expect(result.success).toBe(false);
  });

  it('rejects a task mapping that pairs a Drill with the wrong criterion', () => {
    const pack = structuredClone(P1_MODE_PACKS[1]);
    pack.criteria.push({
      id: 'other-focus',
      label: '另一个焦点',
      description: '仅用于验证错误的 Drill 映射会被拒绝。',
      evidenceKinds: ['quote'],
      offlineEligible: false,
      developmentFixture: true,
    });
    pack.drills.push({
      id: 'other-drill',
      criterionId: 'other-focus',
      title: '另一个 Drill',
      durationSeconds: 60,
      instruction: '执行另一个练习。',
      template: '练习___。',
      successCondition: '完成练习。',
      developmentFixture: true,
    });
    pack.tasks[0].fallbackDrillIds = ['other-drill'];
    pack.tasks[0].focusDrillMappings = [
      { criterionId: 'conclusion-first', drillIds: ['other-drill'] },
    ];

    expect(ModePackSchema.safeParse(pack).success).toBe(false);
  });

  it('requires confirmedAt exactly when an attempt is confirmed', () => {
    const recorded = recordedAttempt('initial');
    expect(AttemptSchema.safeParse({ ...recorded, status: 'confirmed' }).success).toBe(false);
    expect(
      AttemptSchema.safeParse({
        ...recorded,
        status: 'confirmed',
        confirmedAt: now,
      }).success,
    ).toBe(true);
    expect(
      AttemptSchema.safeParse({ ...recorded, confirmedAt: now }).success,
    ).toBe(false);
  });

  it('allows audioRef to become null after lifecycle cleanup', () => {
    const attempt = recordedAttempt('initial');
    expect(AttemptSchema.safeParse({ ...attempt, audioRef: null }).success).toBe(true);
  });

  it('defaults legacy Sessions to no frozen result identities and round-trips exact artifact ids', () => {
    const session = createPracticeSession({
      id: 'session-1',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now,
    });
    expect(session.diagnosisReportId).toBeNull();
    expect(session.comparisonArtifactId).toBeNull();
    const {
      diagnosisReportId: _omittedDiagnosis,
      comparisonArtifactId: _omittedComparison,
      ...legacy
    } = session;
    const parsedLegacy = PracticeSessionSchema.parse(legacy);
    expect(parsedLegacy.diagnosisReportId).toBeNull();
    expect(parsedLegacy.comparisonArtifactId).toBeNull();
    const exact = PracticeSessionSchema.parse({
      ...session,
      diagnosisReportId: 'deep-report-current',
      comparisonArtifactId: 'paired-comparison-current',
      comparisonViewedAt: now,
    });
    expect(exact.diagnosisReportId).toBe('deep-report-current');
    expect(exact.comparisonArtifactId).toBe('paired-comparison-current');
  });

  it('rejects duplicate attempt slots and attempts from another session', () => {
    const session = createPracticeSession({
      id: 'session-1',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now,
    });
    const initial = recordedAttempt('initial');

    expect(
      PracticeSessionSchema.safeParse({
        ...session,
        attempts: [initial, { ...initial, id: 'attempt-initial-2' }],
      }).success,
    ).toBe(false);
    expect(
      PracticeSessionSchema.safeParse({
        ...session,
        attempts: [{ ...initial, sessionId: 'another-session' }],
      }).success,
    ).toBe(false);
  });

  it('requires confirmed attempts before entering downstream stages', () => {
    const session = createPracticeSession({
      id: 'session-1',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now,
    });
    const recorded = recordedAttempt('initial');
    const confirmed = { ...recorded, status: 'confirmed' as const, confirmedAt: now };

    for (const status of [
      'transcript_review',
      'diagnosis',
      'focus',
      'second_attempt',
    ] as const) {
      expect(
        PracticeSessionSchema.safeParse({ ...session, status, attempts: [recorded] }).success,
      ).toBe(false);
      expect(
        PracticeSessionSchema.safeParse({ ...session, status, attempts: [confirmed] })
          .success,
      ).toBe(true);
    }

    expect(
      PracticeSessionSchema.safeParse({
        ...session,
        status: 'comparison',
        attempts: [confirmed],
      }).success,
    ).toBe(false);
  });

  it('rejects a persisted focus outside the task snapshot', () => {
    const session = createPracticeSession({
      id: 'session-1',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now,
    });
    const initial = {
      ...recordedAttempt('initial'),
      status: 'confirmed' as const,
      confirmedAt: now,
    };

    expect(
      PracticeSessionSchema.safeParse({
        ...session,
        status: 'drill',
        attempts: [initial],
        guidanceSource: 'self_directed',
        focus: {
          criterionId: 'unknown-focus',
          drillId: 'decision-first-three-lines',
          label: '无效焦点',
          guidanceSource: 'self_directed',
          evidenceIds: [],
          selectedAt: now,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a guidance source without a selected focus', () => {
    const session = createPracticeSession({
      id: 'session-1',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now,
    });

    expect(
      PracticeSessionSchema.safeParse({
        ...session,
        guidanceSource: 'self_directed',
      }).success,
    ).toBe(false);
  });

  it('rejects a claimed full-loop outcome without its required evidence chain', () => {
    const session = createPracticeSession({
      id: 'session-1',
      modeVersion: '0.1.0-dev.1',
      task: GATE_C_PM_TASK,
      now,
    });

    expect(
      PracticeSessionSchema.safeParse({
        ...session,
        status: 'completed',
        outcome: 'practice_loop_completed',
      }).success,
    ).toBe(false);
  });

  it('parses the default settings and rejects unknown settings keys', () => {
    expect(AppSettingsSchema.parse(DEFAULT_APP_SETTINGS)).toEqual(DEFAULT_APP_SETTINGS);
    expect(
      AppSettingsSchema.safeParse({ ...DEFAULT_APP_SETTINGS, aiEnabled: true }).success,
    ).toBe(false);
  });
});
