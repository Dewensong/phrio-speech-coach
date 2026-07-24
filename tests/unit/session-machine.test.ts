import { describe, expect, it } from 'vitest';

import {
  AttemptSchema,
  GATE_C_PM_TASK,
  P1_MODE_PACKS,
  PracticeSessionSchema,
  SessionTransitionError,
  canTransition,
  createPracticeSession,
  getAllowedSessionEvents,
  getPrimaryPracticeFocus,
  getSessionCompletionPath,
  getSessionStage,
  transitionSession,
  upsertAttempt,
} from '../../src/shared';

const t0 = '2026-07-16T08:00:00.000Z';
const t1 = '2026-07-16T08:01:00.000Z';
const diagnosisReportId = 'deep-report-current';
const comparisonArtifactId = 'paired-comparison-current';

function newSession() {
  return createPracticeSession({
    id: 'session-1',
    modeVersion: '0.1.0-dev.1',
    task: GATE_C_PM_TASK,
    now: t0,
  });
}

function recordedAttempt(kind: 'initial' | 'retry', id = `attempt-${kind}`) {
  return AttemptSchema.parse({
    id,
    sessionId: 'session-1',
    kind,
    status: 'recorded',
    audioRef: `audio/${id}.webm`,
    mimeType: 'audio/webm;codecs=opus',
    durationMs: kind === 'initial' ? 74_000 : 42_000,
    byteLength: 4_096,
    createdAt: t0,
    updatedAt: t0,
    confirmedAt: null,
  });
}

function reachDiagnosis() {
  let session = transitionSession(newSession(), { type: 'start_practice' }, t0);
  session = upsertAttempt(session, recordedAttempt('initial'));
  session = transitionSession(session, { type: 'confirm_first_attempt' }, t1);
  return transitionSession(session, { type: 'confirm_transcript' }, t1);
}

describe('session state machine', () => {
  it('accepts the configured focus and Drill for every current mode task', () => {
    for (const pack of P1_MODE_PACKS) {
      for (const [index, task] of pack.tasks.entries()) {
        const sessionId = `session-${pack.id}-${index}`;
        let session = createPracticeSession({
          id: sessionId,
          modeVersion: pack.version,
          task,
          now: t0,
        });
        session = transitionSession(session, { type: 'start_practice' }, t0);
        session = upsertAttempt(session, AttemptSchema.parse({
          ...recordedAttempt('initial'),
          id: `attempt-${pack.id}-${index}`,
          sessionId,
          audioRef: `audio/${pack.id}-${index}.webm`,
        }));
        session = transitionSession(session, { type: 'confirm_first_attempt' }, t1);
        session = transitionSession(session, { type: 'confirm_transcript' }, t1);
        session = transitionSession(session, { type: 'continue_to_focus' }, t1);
        const focus = getPrimaryPracticeFocus(pack.id, task.id);
        session = transitionSession(session, {
          type: 'select_focus',
          diagnosisReportId,
          focus: {
            criterionId: focus.criterionId,
            drillId: focus.drillId,
            label: focus.criterionLabel,
            guidanceSource: 'self_directed',
            evidenceIds: [],
          },
        }, t1);
        expect(session).toMatchObject({
          status: 'drill',
          focus: { criterionId: focus.criterionId, drillId: focus.drillId },
        });
      }
    }
  });

  it('completes a focused practice loop and derives its outcome', () => {
    const original = newSession();
    let session = transitionSession(original, { type: 'start_practice' }, t0);
    session = upsertAttempt(session, recordedAttempt('initial'));
    session = transitionSession(session, { type: 'confirm_first_attempt' }, t1);
    session = transitionSession(session, { type: 'confirm_transcript' }, t1);
    session = transitionSession(session, { type: 'continue_to_focus' }, t1);
    session = transitionSession(
      session,
      {
        type: 'select_focus',
        diagnosisReportId,
        focus: {
          criterionId: 'decision-request',
          drillId: 'decision-first-three-lines',
          label: '结论、决策或请求',
          guidanceSource: 'self_directed',
          evidenceIds: [],
        },
      },
      t1,
    );
    session = transitionSession(session, { type: 'complete_drill' }, t1);
    session = upsertAttempt(session, recordedAttempt('retry'));
    session = transitionSession(session, { type: 'confirm_second_attempt' }, t1);
    session = transitionSession(session, { type: 'view_comparison', comparisonArtifactId }, t1);

    expect(original.status).toBe('setup');
    expect(session.status).toBe('completed');
    expect(session.outcome).toBe('practice_loop_completed');
    expect(session.comparisonArtifactId).toBe(comparisonArtifactId);
    expect(getSessionCompletionPath(session)).toBe('practice_loop_completed');
    expect(session.guidanceSource).toBe('self_directed');
    expect(session.attempts).toHaveLength(2);
    expect(session.attempts.every((attempt) => attempt.status === 'confirmed')).toBe(true);
    expect(getSessionStage(session)).toBe('complete');
    expect(PracticeSessionSchema.parse(session)).toEqual(session);
  });

  it('accepts default local guidance without annotation ids but requires an AI analysis id', () => {
    const session = reachDiagnosis();
    const local = transitionSession(session, {
      type: 'select_focus',
      diagnosisReportId,
      focus: {
        criterionId: 'decision-request',
        drillId: 'decision-first-three-lines',
        label: '结论、决策或请求',
        guidanceSource: 'local_metric',
        evidenceIds: [],
      },
    }, t1);
    expect(local.focus).toMatchObject({ guidanceSource: 'local_metric', evidenceIds: [] });

    expect(() => transitionSession(session, {
      type: 'select_focus',
      diagnosisReportId,
      focus: {
        criterionId: 'decision-request',
        drillId: 'decision-first-three-lines',
        label: '结论、决策或请求',
        guidanceSource: 'ai_evidence',
        evidenceIds: [],
      },
    }, t1)).toThrow(/traceable analysis id/);

    const ai = transitionSession(session, {
      type: 'select_focus',
      diagnosisReportId,
      focus: {
        criterionId: 'decision-request',
        drillId: 'decision-first-three-lines',
        label: '结论、决策或请求',
        guidanceSource: 'ai_evidence',
        evidenceIds: ['cloud-analysis-1'],
      },
    }, t1);
    expect(ai.focus).toMatchObject({
      guidanceSource: 'ai_evidence',
      evidenceIds: ['cloud-analysis-1'],
    });
  });

  it('atomically selects or skips focus directly from diagnosis while retaining the explicit focus stage', () => {
    const diagnosis = reachDiagnosis();
    const focus = transitionSession(diagnosis, {
      type: 'select_focus',
      diagnosisReportId,
      focus: {
        criterionId: 'decision-request',
        drillId: 'decision-first-three-lines',
        label: '结论、决策或请求',
        guidanceSource: 'self_directed',
        evidenceIds: [],
      },
    }, t1);
    const retry = transitionSession(diagnosis, { type: 'skip_focus', diagnosisReportId }, t1);
    const explicitFocusStage = transitionSession(diagnosis, { type: 'continue_to_focus' }, t1);

    expect(focus).toMatchObject({
      status: 'drill',
      focus: { criterionId: 'decision-request', drillId: 'decision-first-three-lines' },
    });
    expect(retry).toMatchObject({
      status: 'second_attempt',
      focus: null,
      guidanceSource: null,
    });
    expect(explicitFocusStage.status).toBe('focus');
  });

  it('records a retry without focus or Drill as free_retry_completed', () => {
    let session = reachDiagnosis();
    session = transitionSession(session, { type: 'continue_to_focus' }, t1);
    session = transitionSession(session, { type: 'skip_focus', diagnosisReportId }, t1);
    session = upsertAttempt(session, recordedAttempt('retry'));
    session = transitionSession(session, { type: 'confirm_second_attempt' }, t1);
    session = transitionSession(session, { type: 'view_comparison', comparisonArtifactId }, t1);

    expect(session.outcome).toBe('free_retry_completed');
    expect(getSessionCompletionPath(session)).toBe('free_retry');
    expect(session.focus).toBeNull();
    expect(session.guidanceSource).toBeNull();
  });

  it('can finish a confirmed retry without viewing comparison', () => {
    let session = reachDiagnosis();
    session = transitionSession(session, { type: 'continue_to_focus' }, t1);
    session = transitionSession(session, { type: 'skip_focus', diagnosisReportId }, t1);
    session = upsertAttempt(session, recordedAttempt('retry'));
    session = transitionSession(session, { type: 'confirm_second_attempt' }, t1);

    expect(getAllowedSessionEvents(session)).toContain('finish_retry_without_comparison');
    session = transitionSession(session, { type: 'finish_retry_without_comparison' }, t1);

    expect(session).toMatchObject({
      status: 'completed',
      outcome: 'free_retry_completed',
      comparisonViewedAt: null,
    });
    expect(getSessionCompletionPath(session)).toBe('free_retry');
    expect(session.attempts.every((attempt) => attempt.status === 'confirmed')).toBe(true);
    expect(PracticeSessionSchema.parse(session)).toEqual(session);
  });

  it('keeps a focused Drill retry non-loop when comparison was not viewed', () => {
    let session = reachDiagnosis();
    session = transitionSession(session, { type: 'continue_to_focus' }, t1);
    session = transitionSession(session, {
      type: 'select_focus',
      diagnosisReportId,
      focus: {
        criterionId: 'decision-request',
        drillId: 'decision-first-three-lines',
        label: '结论、决策或请求',
        guidanceSource: 'self_directed',
        evidenceIds: [],
      },
    }, t1);
    session = transitionSession(session, { type: 'complete_drill' }, t1);
    session = upsertAttempt(session, recordedAttempt('retry'));
    session = transitionSession(session, { type: 'confirm_second_attempt' }, t1);
    session = transitionSession(session, { type: 'finish_retry_without_comparison' }, t1);

    expect(session).toMatchObject({
      status: 'completed',
      outcome: 'free_retry_completed',
      comparisonViewedAt: null,
      drillCompletedAt: t1,
    });
    expect(session.focus).not.toBeNull();
    expect(getSessionCompletionPath(session)).toBe('focused_retry_without_comparison');
    expect(PracticeSessionSchema.parse(session)).toEqual(session);
  });

  it('keeps the no-focus second-attempt path valid only as a free retry', () => {
    let session = reachDiagnosis();
    session = transitionSession(session, { type: 'continue_to_focus' }, t1);
    session = transitionSession(session, { type: 'skip_focus', diagnosisReportId }, t1);

    expect(session.status).toBe('second_attempt');
    expect(session.focus).toBeNull();
    expect(PracticeSessionSchema.safeParse(session).success).toBe(true);

    session = upsertAttempt(session, recordedAttempt('retry'));
    session = transitionSession(session, { type: 'confirm_second_attempt' }, t1);
    expect(session.status).toBe('comparison');
    expect(PracticeSessionSchema.safeParse(session).success).toBe(true);
  });

  it('records an analysis-only terminal result without a retry', () => {
    const session = transitionSession(
      reachDiagnosis(),
      { type: 'finish_analysis_only', diagnosisReportId },
      t1,
    );

    expect(session.status).toBe('completed');
    expect(session.outcome).toBe('analysis_only');
    expect(getSessionCompletionPath(session)).toBe('analysis_only');
    expect(session.attempts).toHaveLength(1);
  });

  it('can abandon any active status but cannot leave a terminal status', () => {
    const abandoned = transitionSession(newSession(), { type: 'abandon' }, t1);
    expect(abandoned.status).toBe('abandoned');
    expect(abandoned.outcome).toBe('practice_loop_abandoned');
    expect(getAllowedSessionEvents(abandoned)).toEqual([]);
    expect(canTransition(abandoned, { type: 'start_practice' })).toBe(false);
  });

  it('rejects illegal transitions and confirmation without audio', () => {
    expect(() =>
      transitionSession(newSession(), { type: 'confirm_transcript' }, t1),
    ).toThrow(SessionTransitionError);

    const started = transitionSession(newSession(), { type: 'start_practice' }, t0);
    expect(() =>
      transitionSession(started, { type: 'confirm_first_attempt' }, t1),
    ).toThrow(/must be saved/);
    expect(() =>
      transitionSession(reachDiagnosis(), { type: 'finish_retry_without_comparison' }, t1),
    ).toThrow(SessionTransitionError);
  });

  it('rejects a focus criterion or Drill outside the frozen task snapshot', () => {
    let session = reachDiagnosis();
    session = transitionSession(session, { type: 'continue_to_focus' }, t1);

    expect(() =>
      transitionSession(
        session,
        {
          type: 'select_focus',
          diagnosisReportId,
          focus: {
            criterionId: 'unknown-focus',
            drillId: 'decision-first-three-lines',
            label: '无效焦点',
            guidanceSource: 'self_directed',
            evidenceIds: [],
          },
        },
        t1,
      ),
    ).toThrow(/not available for task/);

    expect(() =>
      transitionSession(
        session,
        {
          type: 'select_focus',
          diagnosisReportId,
          focus: {
            criterionId: 'decision-request',
            drillId: 'unknown-drill',
            label: '无效 Drill',
            guidanceSource: 'self_directed',
            evidenceIds: [],
          },
        },
        t1,
      ),
    ).toThrow(/not available for task/);
  });

  it('upserts by attempt slot and never grows beyond two attempts', () => {
    let session = transitionSession(newSession(), { type: 'start_practice' }, t0);
    session = upsertAttempt(session, recordedAttempt('initial', 'attempt-initial-v1'));
    session = upsertAttempt(session, recordedAttempt('initial', 'attempt-initial-v2'));

    expect(session.attempts).toHaveLength(1);
    expect(session.attempts[0].id).toBe('attempt-initial-v2');

    session = upsertAttempt(session, recordedAttempt('retry'));
    expect(session.attempts.map((attempt) => attempt.kind)).toEqual(['initial', 'retry']);
  });

  it('rejects a retry slot before the initial slot exists', () => {
    const session = transitionSession(newSession(), { type: 'start_practice' }, t0);
    expect(() => upsertAttempt(session, recordedAttempt('retry'))).toThrow(
      /requires an initial attempt/,
    );
  });
});
