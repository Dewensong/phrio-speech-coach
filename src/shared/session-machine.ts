import { z } from 'zod';

import {
  AttemptSchema,
  FocusSelectionSchema,
  GuidanceSourceSchema,
  IsoDateTimeSchema,
  PracticeSessionSchema,
  type Attempt,
  type AttemptKind,
  type PracticeSession,
  type SessionStage,
  type SessionStatus,
  TaskTemplateSchema,
  VersionSchema,
  IdentifierSchema,
} from './domain';

export const FocusSelectionDraftSchema = z
  .object({
    criterionId: IdentifierSchema,
    drillId: IdentifierSchema,
    label: z.string().min(1).max(180),
    guidanceSource: GuidanceSourceSchema,
    evidenceIds: z.array(IdentifierSchema).max(12),
  })
  .strict()
  .superRefine((focus, context) => {
    if (focus.guidanceSource === 'ai_evidence' && focus.evidenceIds.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceIds'],
        message: 'AI-guided focus requires at least one traceable analysis id',
      });
    }
  });
export type FocusSelectionDraft = z.infer<typeof FocusSelectionDraftSchema>;

export const SESSION_EVENT_TYPES = [
  'start_practice',
  'confirm_first_attempt',
  'confirm_transcript',
  'continue_to_focus',
  'select_focus',
  'skip_focus',
  'finish_analysis_only',
  'complete_drill',
  'confirm_second_attempt',
  'finish_retry_without_comparison',
  'view_comparison',
  'abandon',
] as const;

export const SessionEventTypeSchema = z.enum(SESSION_EVENT_TYPES);
export type SessionEventType = z.infer<typeof SessionEventTypeSchema>;

export const SessionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start_practice') }).strict(),
  z.object({ type: z.literal('confirm_first_attempt') }).strict(),
  z.object({ type: z.literal('confirm_transcript') }).strict(),
  z.object({ type: z.literal('continue_to_focus') }).strict(),
  z.object({
    type: z.literal('select_focus'),
    focus: FocusSelectionDraftSchema,
    diagnosisReportId: IdentifierSchema,
  }).strict(),
  z.object({ type: z.literal('skip_focus'), diagnosisReportId: IdentifierSchema }).strict(),
  z.object({ type: z.literal('finish_analysis_only'), diagnosisReportId: IdentifierSchema }).strict(),
  z.object({ type: z.literal('complete_drill') }).strict(),
  z.object({ type: z.literal('confirm_second_attempt') }).strict(),
  z.object({ type: z.literal('finish_retry_without_comparison') }).strict(),
  z.object({
    type: z.literal('view_comparison'),
    comparisonArtifactId: IdentifierSchema,
  }).strict(),
  z.object({ type: z.literal('abandon') }).strict(),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const CreatePracticeSessionParamsSchema = z
  .object({
    id: IdentifierSchema,
    modeVersion: VersionSchema,
    task: TaskTemplateSchema,
    now: IsoDateTimeSchema.optional(),
  })
  .strict();
export type CreatePracticeSessionParams = z.infer<typeof CreatePracticeSessionParamsSchema>;

const allowedEvents: Readonly<Record<SessionStatus, ReadonlyArray<SessionEventType>>> = {
  setup: ['start_practice', 'abandon'],
  first_attempt: ['confirm_first_attempt', 'abandon'],
  transcript_review: ['confirm_transcript', 'abandon'],
  diagnosis: [
    'continue_to_focus',
    'select_focus',
    'skip_focus',
    'finish_analysis_only',
    'abandon',
  ],
  focus: ['select_focus', 'skip_focus', 'finish_analysis_only', 'abandon'],
  drill: ['complete_drill', 'abandon'],
  second_attempt: ['confirm_second_attempt', 'abandon'],
  comparison: ['finish_retry_without_comparison', 'view_comparison', 'abandon'],
  completed: [],
  abandoned: [],
};

const stageByStatus: Readonly<Record<SessionStatus, SessionStage>> = {
  setup: 'setup',
  first_attempt: 'first_attempt',
  transcript_review: 'diagnosis',
  diagnosis: 'diagnosis',
  focus: 'focus',
  drill: 'drill',
  second_attempt: 'second_attempt',
  comparison: 'comparison',
  completed: 'complete',
  abandoned: 'complete',
};

export class SessionTransitionError extends Error {
  readonly code:
    | 'invalid_transition'
    | 'missing_attempt'
    | 'invalid_attempt'
    | 'missing_focus'
    | 'invalid_focus';

  constructor(
    code: SessionTransitionError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'SessionTransitionError';
    this.code = code;
  }
}

export function createPracticeSession(
  input: CreatePracticeSessionParams,
): PracticeSession {
  const parsed = CreatePracticeSessionParamsSchema.parse(input);
  const now = parsed.now ?? new Date().toISOString();

  return PracticeSessionSchema.parse({
    id: parsed.id,
    modeId: parsed.task.modeId,
    modeVersion: parsed.modeVersion,
    taskId: parsed.task.id,
    taskVersion: parsed.task.version,
    taskSnapshot: parsed.task,
    status: 'setup',
    outcome: null,
    guidanceSource: null,
    focus: null,
    diagnosisReportId: null,
    comparisonArtifactId: null,
    recordTitle: null,
    recordTitleSource: null,
    pinnedAt: null,
    drillCompletedAt: null,
    comparisonViewedAt: null,
    developmentFixture: parsed.task.developmentFixture,
    attempts: [],
    createdAt: now,
    updatedAt: now,
  });
}

export function getSessionStage(
  sessionOrStatus: PracticeSession | SessionStatus,
): SessionStage {
  const status =
    typeof sessionOrStatus === 'string' ? sessionOrStatus : sessionOrStatus.status;
  return stageByStatus[status];
}

export type SessionCompletionPath =
  | 'in_progress'
  | 'analysis_only'
  | 'free_retry'
  | 'focused_retry_without_comparison'
  | 'practice_loop_completed'
  | 'abandoned';

/**
 * SessionOutcome remains compatible with the frozen product vocabulary. This
 * derived path preserves the material distinction between a truly free retry
 * and a focused Drill + retry whose optional comparison was skipped.
 */
export function getSessionCompletionPath(
  sessionInput: PracticeSession,
): SessionCompletionPath {
  const session = PracticeSessionSchema.parse(sessionInput);
  if (session.status === 'abandoned') return 'abandoned';
  if (session.status !== 'completed') return 'in_progress';
  if (session.outcome === 'analysis_only') return 'analysis_only';
  if (session.outcome === 'practice_loop_completed') return 'practice_loop_completed';
  if (session.focus !== null && session.drillCompletedAt !== null) {
    return 'focused_retry_without_comparison';
  }
  return 'free_retry';
}

export function getAllowedSessionEvents(
  sessionOrStatus: PracticeSession | SessionStatus,
): ReadonlyArray<SessionEventType> {
  const status =
    typeof sessionOrStatus === 'string' ? sessionOrStatus : sessionOrStatus.status;
  return [...allowedEvents[status]];
}

export function canTransition(
  session: PracticeSession,
  event: SessionEvent,
): boolean {
  const parsedSession = PracticeSessionSchema.safeParse(session);
  const parsedEvent = SessionEventSchema.safeParse(event);
  if (!parsedSession.success || !parsedEvent.success) return false;
  return allowedEvents[parsedSession.data.status].includes(parsedEvent.data.type);
}

function findAttempt(
  session: PracticeSession,
  kind: AttemptKind,
): Attempt | undefined {
  return session.attempts.find((attempt) => attempt.kind === kind);
}

function assertFocusAllowed(
  session: PracticeSession,
  focus: FocusSelectionDraft,
): void {
  if (!session.taskSnapshot.focusCandidateCriterionIds.includes(focus.criterionId)) {
    throw new SessionTransitionError(
      'invalid_focus',
      `criterion ${focus.criterionId} is not available for task ${session.taskId}`,
    );
  }
  if (!session.taskSnapshot.fallbackDrillIds.includes(focus.drillId)) {
    throw new SessionTransitionError(
      'invalid_focus',
      `Drill ${focus.drillId} is not available for task ${session.taskId}`,
    );
  }
  const mapping = session.taskSnapshot.focusDrillMappings.find(
    (candidate) => candidate.criterionId === focus.criterionId,
  );
  if (mapping === undefined || !mapping.drillIds.includes(focus.drillId)) {
    throw new SessionTransitionError(
      'invalid_focus',
      `Drill ${focus.drillId} does not train criterion ${focus.criterionId}`,
    );
  }
}

function confirmAttempt(
  session: PracticeSession,
  kind: AttemptKind,
  now: string,
): Attempt[] {
  const attempt = findAttempt(session, kind);
  if (attempt === undefined) {
    throw new SessionTransitionError(
      'missing_attempt',
      `${kind} attempt must be saved before it can be confirmed`,
    );
  }
  if (attempt.status === 'interrupted' || attempt.audioRef === null) {
    throw new SessionTransitionError(
      'invalid_attempt',
      `${kind} attempt must contain playable recorded audio`,
    );
  }

  return session.attempts.map((candidate) =>
    candidate.kind === kind
      ? AttemptSchema.parse({
          ...candidate,
          status: 'confirmed',
          confirmedAt: now,
          updatedAt: now,
        })
      : candidate,
  );
}

export function upsertAttempt(
  sessionInput: PracticeSession,
  attemptInput: Attempt,
): PracticeSession {
  const session = PracticeSessionSchema.parse(sessionInput);
  const attempt = AttemptSchema.parse(attemptInput);
  if (attempt.sessionId !== session.id) {
    throw new SessionTransitionError(
      'invalid_attempt',
      'attempt belongs to a different session',
    );
  }
  if (attempt.kind === 'retry' && findAttempt(session, 'initial') === undefined) {
    throw new SessionTransitionError(
      'invalid_attempt',
      'retry attempt requires an initial attempt',
    );
  }

  const withoutSlot = session.attempts.filter(
    (candidate) => candidate.kind !== attempt.kind,
  );
  const attempts = [...withoutSlot, attempt].sort((left, right) =>
    left.kind === 'initial' && right.kind === 'retry' ? -1 : 1,
  );

  return PracticeSessionSchema.parse({
    ...session,
    attempts,
    updatedAt: attempt.updatedAt,
  });
}

export function removeAttempt(
  sessionInput: PracticeSession,
  kind: AttemptKind,
  now: string = new Date().toISOString(),
): PracticeSession {
  const session = PracticeSessionSchema.parse(sessionInput);
  const attempts =
    kind === 'initial'
      ? []
      : session.attempts.filter((attempt) => attempt.kind !== 'retry');

  return PracticeSessionSchema.parse({
    ...session,
    attempts,
    updatedAt: now,
  });
}

export function transitionSession(
  sessionInput: PracticeSession,
  eventInput: SessionEvent,
  now: string = new Date().toISOString(),
): PracticeSession {
  const session = PracticeSessionSchema.parse(sessionInput);
  const event = SessionEventSchema.parse(eventInput);

  if (!allowedEvents[session.status].includes(event.type)) {
    throw new SessionTransitionError(
      'invalid_transition',
      `cannot apply ${event.type} while session is ${session.status}`,
    );
  }

  let next: PracticeSession;
  switch (event.type) {
    case 'start_practice':
      next = { ...session, status: 'first_attempt', updatedAt: now };
      break;
    case 'confirm_first_attempt':
      next = {
        ...session,
        status: 'transcript_review',
        attempts: confirmAttempt(session, 'initial', now),
        updatedAt: now,
      };
      break;
    case 'confirm_transcript':
      next = { ...session, status: 'diagnosis', updatedAt: now };
      break;
    case 'continue_to_focus':
      next = { ...session, status: 'focus', updatedAt: now };
      break;
    case 'select_focus': {
      assertFocusAllowed(session, event.focus);
      const focus = FocusSelectionSchema.parse({ ...event.focus, selectedAt: now });
      next = {
        ...session,
        status: 'drill',
        focus,
        guidanceSource: focus.guidanceSource,
        diagnosisReportId: event.diagnosisReportId,
        updatedAt: now,
      };
      break;
    }
    case 'skip_focus':
      next = {
        ...session,
        status: 'second_attempt',
        focus: null,
        guidanceSource: null,
        diagnosisReportId: event.diagnosisReportId,
        updatedAt: now,
      };
      break;
    case 'finish_analysis_only':
      next = {
        ...session,
        status: 'completed',
        outcome: 'analysis_only',
        diagnosisReportId: event.diagnosisReportId,
        updatedAt: now,
      };
      break;
    case 'complete_drill':
      if (session.focus === null) {
        throw new SessionTransitionError(
          'missing_focus',
          'a focus must be selected before completing a drill',
        );
      }
      next = {
        ...session,
        status: 'second_attempt',
        drillCompletedAt: now,
        updatedAt: now,
      };
      break;
    case 'confirm_second_attempt':
      next = {
        ...session,
        status: 'comparison',
        attempts: confirmAttempt(session, 'retry', now),
        updatedAt: now,
      };
      break;
    case 'finish_retry_without_comparison':
      next = {
        ...session,
        status: 'completed',
        outcome: 'free_retry_completed',
        comparisonArtifactId: null,
        comparisonViewedAt: null,
        updatedAt: now,
      };
      break;
    case 'view_comparison': {
      const fullLoop = session.focus !== null && session.drillCompletedAt !== null;
      next = {
        ...session,
        status: 'completed',
        outcome: fullLoop ? 'practice_loop_completed' : 'free_retry_completed',
        comparisonArtifactId: event.comparisonArtifactId,
        comparisonViewedAt: now,
        updatedAt: now,
      };
      break;
    }
    case 'abandon':
      next = {
        ...session,
        status: 'abandoned',
        outcome: 'practice_loop_abandoned',
        updatedAt: now,
      };
      break;
  }

  return PracticeSessionSchema.parse(next);
}
