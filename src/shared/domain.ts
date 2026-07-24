import { z } from 'zod';

const idPattern = /^[a-z0-9][a-z0-9._-]*$/;

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(idPattern, 'must be a lowercase identifier');

export const VersionSchema = z.string().min(1).max(32);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const MODE_IDS = [
  'clear-expression',
  'decision-alignment',
  'argument-rebuttal',
] as const;
export const ModeIdSchema = z.enum(MODE_IDS);
export type ModeId = z.infer<typeof ModeIdSchema>;

export const EvidenceKindSchema = z.enum([
  'quote',
  'audio_span',
  'deterministic_metric',
  'task_requirement_gap',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

/**
 * Frozen local comparison axes. These identify only problem signals that the
 * paired protocol can actually count; they are not scores for the criterion.
 */
export const CRITERION_COMPARISON_DIMENSIONS = [
  'delivery-friction',
  'vague-language',
  'pacing-flags',
  'structure-flags',
  'task-coverage-gaps',
  'task-structure-gaps',
] as const;
export const CriterionComparisonDimensionSchema = z.enum(CRITERION_COMPARISON_DIMENSIONS);
export type CriterionComparisonDimension = z.infer<typeof CriterionComparisonDimensionSchema>;

export const CriterionSchema = z
  .object({
    id: IdentifierSchema,
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    evidenceKinds: z.array(EvidenceKindSchema).min(1),
    offlineEligible: z.boolean(),
    /** Optional for legacy snapshots; every current production criterion sets one. */
    comparisonDimension: CriterionComparisonDimensionSchema.optional(),
    developmentFixture: z.boolean().default(false),
  })
  .strict();
export type Criterion = z.infer<typeof CriterionSchema>;

export const DrillSchema = z
  .object({
    id: IdentifierSchema,
    criterionId: IdentifierSchema,
    title: z.string().min(1).max(80),
    durationSeconds: z.number().int().min(60).max(180),
    instruction: z.string().min(1).max(1_000),
    template: z.string().min(1).max(1_000),
    successCondition: z.string().min(1).max(500),
    developmentFixture: z.boolean().default(false),
  })
  .strict();
export type Drill = z.infer<typeof DrillSchema>;

export const TaskContextSchema = z
  .object({
    audience: z.string().min(1).max(300),
    objective: z.string().min(1).max(500),
    background: z.string().max(2_000).default(''),
    sourceMaterial: z.string().max(5_000).default(''),
    counterArgument: z.string().max(2_000).default(''),
    roleContext: z.string().max(1_000).default(''),
  })
  .strict();
export type TaskContext = z.infer<typeof TaskContextSchema>;

export const TaskFocusDrillMappingSchema = z
  .object({
    criterionId: IdentifierSchema,
    drillIds: z.array(IdentifierSchema).min(1).max(8),
  })
  .strict();
export type TaskFocusDrillMapping = z.infer<typeof TaskFocusDrillMappingSchema>;

export const TaskTemplateSchema = z
  .object({
    id: IdentifierSchema,
    version: VersionSchema,
    modeId: ModeIdSchema,
    title: z.string().min(1).max(180),
    prompt: z.string().min(1).max(1_000),
    description: z.string().min(1).max(1_000),
    recommendedDurationSeconds: z.number().int().min(30).max(300),
    context: TaskContextSchema,
    constraints: z.array(z.string().min(1).max(500)).max(12),
    successConditions: z.array(z.string().min(1).max(500)).min(1).max(12),
    requiredFields: z.array(IdentifierSchema).max(16),
    focusCandidateCriterionIds: z.array(IdentifierSchema).min(1).max(16),
    fallbackDrillIds: z.array(IdentifierSchema).min(1).max(8),
    focusDrillMappings: z.array(TaskFocusDrillMappingSchema).min(1).max(16),
    /** Self-contained product definitions frozen into production Session snapshots. */
    rubricSnapshot: z.array(CriterionSchema).min(1).max(16).optional(),
    drillSnapshot: z.array(DrillSchema).min(1).max(16).optional(),
    developmentFixture: z.boolean().default(false),
  })
  .strict()
  .superRefine((task, context) => {
    const candidateCriteria = new Set(task.focusCandidateCriterionIds);
    const fallbackDrills = new Set(task.fallbackDrillIds);
    const mappedCriteria = new Set<string>();

    if ((task.rubricSnapshot === undefined) !== (task.drillSnapshot === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['rubricSnapshot'],
        message: 'frozen rubric and Drill definitions must be present together',
      });
    }
    if (task.rubricSnapshot && task.drillSnapshot) {
      const rubricIds = task.rubricSnapshot.map((criterion) => criterion.id);
      const drillIds = task.drillSnapshot.map((drill) => drill.id);
      if (new Set(rubricIds).size !== rubricIds.length) {
        context.addIssue({ code: 'custom', path: ['rubricSnapshot'], message: 'frozen criterion ids must be unique' });
      }
      if (new Set(drillIds).size !== drillIds.length) {
        context.addIssue({ code: 'custom', path: ['drillSnapshot'], message: 'frozen Drill ids must be unique' });
      }
      if (
        task.focusCandidateCriterionIds.some((criterionId) => !rubricIds.includes(criterionId))
        || rubricIds.some((criterionId) => !task.focusCandidateCriterionIds.includes(criterionId))
      ) {
        context.addIssue({ code: 'custom', path: ['rubricSnapshot'], message: 'frozen rubric must exactly match task focus candidates' });
      }
      if (
        task.fallbackDrillIds.some((drillId) => !drillIds.includes(drillId))
        || drillIds.some((drillId) => !task.fallbackDrillIds.includes(drillId))
      ) {
        context.addIssue({ code: 'custom', path: ['drillSnapshot'], message: 'frozen Drills must exactly match task fallbacks' });
      }
      for (const [index, drill] of task.drillSnapshot.entries()) {
        if (!rubricIds.includes(drill.criterionId)) {
          context.addIssue({ code: 'custom', path: ['drillSnapshot', index, 'criterionId'], message: 'frozen Drill criterion must exist in frozen rubric' });
        }
      }
    }

    for (const [index, mapping] of task.focusDrillMappings.entries()) {
      if (mappedCriteria.has(mapping.criterionId)) {
        context.addIssue({
          code: 'custom',
          path: ['focusDrillMappings', index, 'criterionId'],
          message: 'task focus mapping criterion ids must be unique',
        });
      }
      mappedCriteria.add(mapping.criterionId);

      if (!candidateCriteria.has(mapping.criterionId)) {
        context.addIssue({
          code: 'custom',
          path: ['focusDrillMappings', index, 'criterionId'],
          message: 'mapped criterion must be a task focus candidate',
        });
      }

      const uniqueDrills = new Set(mapping.drillIds);
      if (uniqueDrills.size !== mapping.drillIds.length) {
        context.addIssue({
          code: 'custom',
          path: ['focusDrillMappings', index, 'drillIds'],
          message: 'mapped drill ids must be unique',
        });
      }
      for (const drillId of mapping.drillIds) {
        if (!fallbackDrills.has(drillId)) {
          context.addIssue({
            code: 'custom',
            path: ['focusDrillMappings', index, 'drillIds'],
            message: `mapped drill must be a task fallback: ${drillId}`,
          });
        }
      }
    }

    for (const criterionId of candidateCriteria) {
      if (!mappedCriteria.has(criterionId)) {
        context.addIssue({
          code: 'custom',
          path: ['focusDrillMappings'],
          message: `focus candidate requires a Drill mapping: ${criterionId}`,
        });
      }
    }
  });
export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;

export const ModePackSchema = z
  .object({
    id: ModeIdSchema,
    version: VersionSchema,
    name: z.string().min(1).max(80),
    abilityName: z.string().min(1).max(80),
    typicalRole: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    criteria: z.array(CriterionSchema).min(1),
    drills: z.array(DrillSchema).min(1),
    tasks: z.array(TaskTemplateSchema).min(1),
    developmentFixture: z.boolean().default(false),
  })
  .strict()
  .superRefine((pack, context) => {
    const criterionIds = new Set(pack.criteria.map((criterion) => criterion.id));
    const drillIds = new Set(pack.drills.map((drill) => drill.id));

    if (criterionIds.size !== pack.criteria.length) {
      context.addIssue({
        code: 'custom',
        path: ['criteria'],
        message: 'criterion ids must be unique',
      });
    }

    if (drillIds.size !== pack.drills.length) {
      context.addIssue({
        code: 'custom',
        path: ['drills'],
        message: 'drill ids must be unique',
      });
    }

    for (const [index, drill] of pack.drills.entries()) {
      if (!criterionIds.has(drill.criterionId)) {
        context.addIssue({
          code: 'custom',
          path: ['drills', index, 'criterionId'],
          message: 'drill criterion must exist in this mode pack',
        });
      }
    }

    for (const [index, task] of pack.tasks.entries()) {
      if (task.modeId !== pack.id) {
        context.addIssue({
          code: 'custom',
          path: ['tasks', index, 'modeId'],
          message: 'task mode must match its mode pack',
        });
      }

      for (const criterionId of task.focusCandidateCriterionIds) {
        if (!criterionIds.has(criterionId)) {
          context.addIssue({
            code: 'custom',
            path: ['tasks', index, 'focusCandidateCriterionIds'],
            message: `unknown focus criterion: ${criterionId}`,
          });
        }
      }

      for (const drillId of task.fallbackDrillIds) {
        if (!drillIds.has(drillId)) {
          context.addIssue({
            code: 'custom',
            path: ['tasks', index, 'fallbackDrillIds'],
            message: `unknown fallback drill: ${drillId}`,
          });
        }
      }

      for (const [mappingIndex, mapping] of task.focusDrillMappings.entries()) {
        for (const drillId of mapping.drillIds) {
          const drill = pack.drills.find((candidate) => candidate.id === drillId);
          if (drill !== undefined && drill.criterionId !== mapping.criterionId) {
            context.addIssue({
              code: 'custom',
              path: ['tasks', index, 'focusDrillMappings', mappingIndex, 'drillIds'],
              message: `drill ${drillId} does not train criterion ${mapping.criterionId}`,
            });
          }
        }
      }
    }
  });
export type ModePack = z.infer<typeof ModePackSchema>;

export const ATTEMPT_KINDS = ['initial', 'retry'] as const;
export const AttemptKindSchema = z.enum(ATTEMPT_KINDS);
export type AttemptKind = z.infer<typeof AttemptKindSchema>;

export const AttemptStatusSchema = z.enum(['recorded', 'confirmed', 'interrupted']);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

export const AttemptSchema = z
  .object({
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    kind: AttemptKindSchema,
    status: AttemptStatusSchema,
    audioRef: z.string().min(1).max(500).nullable(),
    mimeType: z.string().min(1).max(120),
    durationMs: z.number().int().positive().max(300_000),
    byteLength: z.number().int().positive().max(64 * 1024 * 1024),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    confirmedAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (attempt.status === 'confirmed' && attempt.confirmedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['confirmedAt'],
        message: 'confirmed attempts require confirmedAt',
      });
    }

    if (attempt.status !== 'confirmed' && attempt.confirmedAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['confirmedAt'],
        message: 'only confirmed attempts may have confirmedAt',
      });
    }
  });
export type Attempt = z.infer<typeof AttemptSchema>;

export const SESSION_STAGES = [
  'setup',
  'first_attempt',
  'diagnosis',
  'focus',
  'drill',
  'second_attempt',
  'comparison',
  'complete',
] as const;
export const SessionStageSchema = z.enum(SESSION_STAGES);
export type SessionStage = z.infer<typeof SessionStageSchema>;

export const SESSION_STATUSES = [
  'setup',
  'first_attempt',
  'transcript_review',
  'diagnosis',
  'focus',
  'drill',
  'second_attempt',
  'comparison',
  'completed',
  'abandoned',
] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SESSION_OUTCOMES = [
  'analysis_only',
  'free_retry_completed',
  'practice_loop_completed',
  'practice_loop_abandoned',
] as const;
export const SessionOutcomeSchema = z.enum(SESSION_OUTCOMES);
export type SessionOutcome = z.infer<typeof SessionOutcomeSchema>;

export const GUIDANCE_SOURCES = ['ai_evidence', 'local_metric', 'self_directed'] as const;
export const GuidanceSourceSchema = z.enum(GUIDANCE_SOURCES);
export type GuidanceSource = z.infer<typeof GuidanceSourceSchema>;

export const FocusSelectionSchema = z
  .object({
    criterionId: IdentifierSchema,
    drillId: IdentifierSchema,
    label: z.string().min(1).max(180),
    guidanceSource: GuidanceSourceSchema,
    evidenceIds: z.array(IdentifierSchema).max(12),
    selectedAt: IsoDateTimeSchema,
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
export type FocusSelection = z.infer<typeof FocusSelectionSchema>;

function countConfirmedAttempts(
  attempts: ReadonlyArray<Attempt>,
  kind?: AttemptKind,
): number {
  return attempts.filter(
    (attempt) => attempt.status === 'confirmed' && (kind === undefined || attempt.kind === kind),
  ).length;
}

export const PracticeSessionSchema = z
  .object({
    id: IdentifierSchema,
    modeId: ModeIdSchema,
    modeVersion: VersionSchema,
    taskId: IdentifierSchema,
    taskVersion: VersionSchema,
    taskSnapshot: TaskTemplateSchema,
    status: SessionStatusSchema,
    outcome: SessionOutcomeSchema.nullable(),
    guidanceSource: GuidanceSourceSchema.nullable(),
    focus: FocusSelectionSchema.nullable(),
    /** Exact persisted Deep report shown when the user chose this Session path. */
    diagnosisReportId: IdentifierSchema.nullable().default(null),
    /** Exact persisted comparison the user explicitly opened before completion. */
    comparisonArtifactId: IdentifierSchema.nullable().default(null),
    /** First frozen spoken sentence by default; user renames replace this value. */
    recordTitle: z.string().trim().min(1).max(200).nullable().default(null),
    recordTitleSource: z.enum(['first_final', 'user']).nullable().default(null),
    /** Pin order is independent from practice activity and completion time. */
    pinnedAt: IsoDateTimeSchema.nullable().default(null),
    drillCompletedAt: IsoDateTimeSchema.nullable(),
    comparisonViewedAt: IsoDateTimeSchema.nullable(),
    developmentFixture: z.boolean(),
    attempts: z.array(AttemptSchema).max(2),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((session, context) => {
    if ((session.recordTitle === null) !== (session.recordTitleSource === null)) {
      context.addIssue({
        code: 'custom',
        path: ['recordTitleSource'],
        message: 'record title and its source must be set or cleared together',
      });
    }

    if (
      session.taskSnapshot.id !== session.taskId ||
      session.taskSnapshot.version !== session.taskVersion ||
      session.taskSnapshot.modeId !== session.modeId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['taskSnapshot'],
        message: 'task snapshot must match the frozen session task identity',
      });
    }

    if (session.taskSnapshot.developmentFixture !== session.developmentFixture) {
      context.addIssue({
        code: 'custom',
        path: ['developmentFixture'],
        message: 'session fixture flag must match its task snapshot',
      });
    }

    const attemptKinds = new Set<AttemptKind>();
    for (const [index, attempt] of session.attempts.entries()) {
      if (attempt.sessionId !== session.id) {
        context.addIssue({
          code: 'custom',
          path: ['attempts', index, 'sessionId'],
          message: 'attempt must belong to this session',
        });
      }
      if (attemptKinds.has(attempt.kind)) {
        context.addIssue({
          code: 'custom',
          path: ['attempts', index, 'kind'],
          message: 'a session may have only one attempt per slot',
        });
      }
      attemptKinds.add(attempt.kind);
    }

    if (attemptKinds.has('retry') && !attemptKinds.has('initial')) {
      context.addIssue({
        code: 'custom',
        path: ['attempts'],
        message: 'retry attempt requires an initial attempt',
      });
    }

    if (session.focus === null && session.guidanceSource !== null) {
      context.addIssue({
        code: 'custom',
        path: ['guidanceSource'],
        message: 'guidance source must be null until a focus is selected',
      });
    }

    if (
      session.focus !== null &&
      session.guidanceSource !== session.focus.guidanceSource
    ) {
      context.addIssue({
        code: 'custom',
        path: ['guidanceSource'],
        message: 'session guidance source must match the selected focus',
      });
    }

    if (session.focus !== null) {
      if (!session.taskSnapshot.focusCandidateCriterionIds.includes(session.focus.criterionId)) {
        context.addIssue({
          code: 'custom',
          path: ['focus', 'criterionId'],
          message: 'selected focus criterion is not allowed by the task snapshot',
        });
      }
      if (!session.taskSnapshot.fallbackDrillIds.includes(session.focus.drillId)) {
        context.addIssue({
          code: 'custom',
          path: ['focus', 'drillId'],
          message: 'selected focus Drill is not allowed by the task snapshot',
        });
      }
      const mapping = session.taskSnapshot.focusDrillMappings.find(
        (candidate) => candidate.criterionId === session.focus?.criterionId,
      );
      if (mapping === undefined || !mapping.drillIds.includes(session.focus.drillId)) {
        context.addIssue({
          code: 'custom',
          path: ['focus'],
          message: 'selected Drill does not train the selected task criterion',
        });
      }
    }

    if (session.drillCompletedAt !== null && session.focus === null) {
      context.addIssue({
        code: 'custom',
        path: ['drillCompletedAt'],
        message: 'a completed Drill requires a valid selected focus',
      });
    }

    if (session.comparisonViewedAt === null && session.comparisonArtifactId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['comparisonArtifactId'],
        message: 'a frozen comparison identity requires an explicit comparison view',
      });
    }

    const isTerminal = session.status === 'completed' || session.status === 'abandoned';
    if (isTerminal !== (session.outcome !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'only terminal sessions have an outcome',
      });
    }

    if (
      (session.status === 'abandoned') !==
      (session.outcome === 'practice_loop_abandoned')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'abandoned status and outcome must occur together',
      });
    }

    const confirmedInitial = countConfirmedAttempts(session.attempts, 'initial');
    const confirmedRetry = countConfirmedAttempts(session.attempts, 'retry');

    const statusesRequiringInitial: ReadonlyArray<SessionStatus> = [
      'transcript_review',
      'diagnosis',
      'focus',
      'drill',
      'second_attempt',
      'comparison',
    ];
    if (statusesRequiringInitial.includes(session.status) && confirmedInitial !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['attempts'],
        message: `${session.status} requires one confirmed initial attempt`,
      });
    }

    if (session.status === 'comparison' && confirmedRetry !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['attempts'],
        message: 'comparison requires one confirmed retry attempt',
      });
    }

    if (session.status === 'drill' && session.focus === null) {
      context.addIssue({
        code: 'custom',
        path: ['focus'],
        message: 'Drill stage requires a valid selected focus',
      });
    }

    if (
      (session.status === 'second_attempt' || session.status === 'comparison') &&
      session.focus !== null &&
      session.drillCompletedAt === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['drillCompletedAt'],
        message: 'focused retry and comparison require a completed Drill',
      });
    }

    if (session.outcome === 'analysis_only') {
      if (confirmedInitial !== 1 || confirmedRetry !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['outcome'],
          message: 'analysis_only requires one confirmed initial attempt and no retry',
        });
      }
    }

    if (session.outcome === 'free_retry_completed') {
      if (confirmedInitial !== 1 || confirmedRetry !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['outcome'],
          message: 'free retry requires two confirmed attempts',
        });
      }
      if (
        session.focus !== null
        && session.drillCompletedAt !== null
        && session.comparisonViewedAt !== null
      ) {
        context.addIssue({
          code: 'custom',
          path: ['outcome'],
          message: 'a focused completed drill with a viewed comparison must be recorded as a full practice loop',
        });
      }
    }

    if (session.outcome === 'practice_loop_completed') {
      if (
        confirmedInitial !== 1 ||
        confirmedRetry !== 1 ||
        session.focus === null ||
        session.guidanceSource === null ||
        session.drillCompletedAt === null ||
        session.comparisonViewedAt === null
      ) {
        context.addIssue({
          code: 'custom',
          path: ['outcome'],
          message: 'full practice loop requires two attempts, focus, drill and viewed comparison',
        });
      }
    }
  });
export type PracticeSession = z.infer<typeof PracticeSessionSchema>;

export const ThemeSchema = z.enum(['system', 'light', 'dark']);
export type Theme = z.infer<typeof ThemeSchema>;

export const AccentSchema = z.enum([
  'flow-teal',
  'fog-blue',
  'smoky-jade',
  'olive',
  'amber',
  'ruby',
  'cocoa',
  'terracotta',
]);
export type Accent = z.infer<typeof AccentSchema>;

export const AudioRetentionSchema = z.enum(['delete_on_complete', 'keep_with_session']);
export type AudioRetention = z.infer<typeof AudioRetentionSchema>;

export const CloudAiPreferencesSchema = z.object({
  liveHintEnabled: z.boolean(),
  deepDiagnosisEnabled: z.boolean(),
  comparisonEnabled: z.boolean(),
}).strict();
export type CloudAiPreferences = z.infer<typeof CloudAiPreferencesSchema>;

export const AppSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    theme: ThemeSchema,
    lightAccent: AccentSchema,
    darkAccent: AccentSchema,
    textScale: z.number().min(0.9).max(1.25),
    reducedMotion: z.boolean(),
    audioRetention: AudioRetentionSchema,
    cloudAi: CloudAiPreferencesSchema,
    favoriteTaskIds: z.array(IdentifierSchema).max(100),
    onboardingCompleted: z.boolean(),
  })
  .strict();
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  schemaVersion: 1,
  theme: 'system',
  lightAccent: 'flow-teal',
  darkAccent: 'flow-teal',
  textScale: 1,
  reducedMotion: false,
  audioRetention: 'delete_on_complete',
  cloudAi: {
    liveHintEnabled: false,
    deepDiagnosisEnabled: false,
    comparisonEnabled: false,
  },
  favoriteTaskIds: [],
  onboardingCompleted: false,
});
