import { randomUUID } from 'node:crypto';
import {
  DEFAULT_APP_SETTINGS,
  PracticeSessionSchema,
  P1_MODE_PACKS,
  TaskTemplateSchema,
  UpdateSessionRecordInputSchema,
  buildLocalDeepReport,
  buildDeepDiagnosisPayload,
  buildSemanticComparisonPayload,
  compareFrozenAttempts,
  createFreeExpressionTask,
  evidenceForDeepLane,
  getModePack,
  getTaskTemplate,
  createPracticeSession,
  derivePracticeRecordTitle,
  removeAttempt,
  selectAttemptSnapshot,
  parseEditedComparisonPayload,
  parseEditedDeepPayload,
  transitionCloudDeepDiagnosis,
  transitionCloudSemanticComparison,
  transitionSession as applySessionTransition,
  transcriptVersionForDeepLane,
  upsertAttempt,
  type AppSettings,
  type AppSettingsPatch,
  type Attempt,
  type AttemptSnapshot,
  type AttemptKind,
  type ModeId,
  type BootstrapData,
  type DeepDiagnosisPayload,
  type ListSessionsInput,
  type PracticeSession,
  type PracticeArtifact,
  type SessionEvent,
  type SemanticComparisonPayload,
  type UpdateSessionRecordInput,
} from '../../shared';
import { AudioRepository } from '../repositories/audio-repository';
import { SessionRepository } from '../repositories/session-repository';

export interface CreateSessionUseCaseInput {
  readonly modeId: ModeId;
  readonly taskId: string;
  readonly developmentFixture?: boolean;
  readonly customTask?: {
    readonly prompt: string;
    readonly audience: string;
    readonly objective: string;
    readonly durationSeconds: number;
  };
  readonly taskOverrides?: {
    readonly audience: string;
    readonly objective: string;
    readonly durationSeconds: number;
  };
}

export interface SaveAttemptAudioUseCaseInput {
  readonly sessionId: string;
  readonly attemptId?: string;
  readonly kind: AttemptKind;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly durationMs: number;
}

export interface ReadAttemptAudioUseCaseInput {
  readonly sessionId: string;
  readonly kind: AttemptKind;
}

export interface DiscardAttemptAudioUseCaseInput extends ReadAttemptAudioUseCaseInput {
  readonly attemptId?: string;
}

export interface ReadAttemptAudioUseCaseResult {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface PracticeSessionServiceOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export class PracticeSessionService {
  readonly #sessions: SessionRepository;
  readonly #audio: AudioRepository;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #sessionOperationTails = new Map<string, Promise<void>>();
  readonly #terminalizingSessions = new Set<string>();
  #trainingDataResetInProgress = false;

  constructor(
    sessions: SessionRepository,
    audio: AudioRepository,
    options: PracticeSessionServiceOptions = {},
  ) {
    this.#sessions = sessions;
    this.#audio = audio;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  async initialize(): Promise<void> {
    await this.#audio.initialize();
    await this.cleanupExpiredAudio();
  }

  createSession(input: CreateSessionUseCaseInput): PracticeSession {
    this.#assertTrainingDataWritable();
    const mode = getModePack(input.modeId);
    if (
      input.customTask &&
      (input.modeId !== 'clear-expression' || input.taskId !== 'free-expression')
    ) {
      throw new PracticeSessionServiceError(
        'INVALID_CUSTOM_TASK',
        'Free expression tasks require the clear expression mode.',
      );
    }
    const baseTask = input.customTask
      ? createFreeExpressionTask(input.customTask)
      : getTaskTemplate(input.modeId, input.taskId);
    if (!mode || !baseTask) {
      throw new PracticeSessionServiceError('TASK_NOT_FOUND', 'Practice task was not found.');
    }
    if (input.customTask && input.taskOverrides) {
      throw new PracticeSessionServiceError(
        'INVALID_TASK_OVERRIDES',
        'A custom free task already contains its editable task fields.',
      );
    }
    const task = input.taskOverrides
      ? TaskTemplateSchema.parse({
          ...baseTask,
          recommendedDurationSeconds: input.taskOverrides.durationSeconds,
          context: {
            ...baseTask.context,
            audience: input.taskOverrides.audience,
            objective: input.taskOverrides.objective,
          },
        })
      : baseTask;
    const taskCriterionIds = new Set(task.focusCandidateCriterionIds);
    const taskDrillIds = new Set(task.fallbackDrillIds);
    const frozenTask = TaskTemplateSchema.parse({
      ...task,
      rubricSnapshot: mode.criteria.filter((criterion) => taskCriterionIds.has(criterion.id)),
      drillSnapshot: mode.drills.filter((drill) => taskDrillIds.has(drill.id)),
    });
    if (
      input.developmentFixture !== undefined &&
      input.developmentFixture !== task.developmentFixture
    ) {
      throw new PracticeSessionServiceError(
        'FIXTURE_FLAG_MISMATCH',
        'The requested task fixture flag does not match its frozen definition.',
      );
    }

    const session = createPracticeSession({
      id: this.#createId(),
      modeVersion: mode.version,
      task: frozenTask,
      now: this.#now().toISOString(),
    });
    return this.#sessions.createSession(session);
  }

  getSession(sessionId: string): PracticeSession | null {
    return this.#sessions.getSession(sessionId);
  }

  listSessions(filter: ListSessionsInput = {}): readonly PracticeSession[] {
    return this.#sessions.listSessions().filter((session) => {
      return (
        (filter.modeId === undefined || session.modeId === filter.modeId) &&
        (filter.outcome === undefined || session.outcome === filter.outcome)
      );
    });
  }

  putArtifact(artifact: PracticeArtifact): PracticeArtifact {
    this.#assertTrainingDataWritable();
    const session = this.#sessions.getSessionOrThrow(artifact.sessionId);
    const cloudArtifact = artifact.type === 'cloud_deep_diagnosis'
      || artifact.type === 'cloud_semantic_comparison';
    const terminalizing = this.#terminalizingSessions.has(session.id);
    if (!cloudArtifact && (
      terminalizing
      || session.status === 'completed'
      || session.status === 'abandoned'
    )) {
      throw new PracticeSessionServiceError(
        'SESSION_ARTIFACTS_FROZEN',
        'Ordinary practice artifacts are immutable once a Session is completing or closed.',
      );
    }
    if (cloudArtifact) {
      const existing = this.#sessions.listArtifacts(session.id).some(
        (candidate) => candidate.id === artifact.id && candidate.type === artifact.type,
      );
      if (
        (terminalizing || session.status === 'completed' || session.status === 'abandoned')
        && !existing
      ) {
        throw new PracticeSessionServiceError(
          'SESSION_ARTIFACTS_FROZEN',
          'A closed Session accepts only attested lifecycle updates to existing cloud artifacts.',
        );
      }
    }
    this.#assertArtifactReferences(session, artifact);
    const defaultRecordTitle = artifact.type === 'attempt_snapshot'
      && artifact.payload.kind === 'initial'
      ? derivePracticeRecordTitle(artifact.payload.finalSegments)
      : null;
    return this.#sessions.putArtifact(artifact, {
      ...(defaultRecordTitle ? { defaultRecordTitle } : {}),
    });
  }

  async updateSessionRecord(input: UpdateSessionRecordInput): Promise<PracticeSession> {
    this.#assertTrainingDataWritable();
    const command = UpdateSessionRecordInputSchema.parse(input);
    return this.#withSessionLock(command.sessionId, async () => {
      const current = this.#sessions.getSessionOrThrow(command.sessionId);
      if (command.action === 'rename') {
        return this.#sessions.renameSessionRecord(current.id, command.title);
      }
      if (command.pinned === (current.pinnedAt !== null)) return current;
      return this.#sessions.setSessionPinned(
        current.id,
        command.pinned ? this.#now().toISOString() : null,
      );
    });
  }

  /** Ensures cloud execution can only consume a graph-validated queued artifact. */
  assertCloudExecutionApproved(
    payload: DeepDiagnosisPayload | SemanticComparisonPayload,
    consentId: string,
  ): void {
    this.#assertTrainingDataWritable();
    const session = this.#sessions.getSessionOrThrow(payload.sessionId);
    const expectedType = payload.purpose === 'deep_diagnosis'
      ? 'cloud_deep_diagnosis'
      : 'cloud_semantic_comparison';
    const artifact = this.#sessions.listArtifacts(session.id).find((candidate) => (
      candidate.type === expectedType
      && candidate.payload.analysisInputId === payload.analysisInputId
      && candidate.payload.consentId === consentId
      && JSON.stringify(candidate.payload.approvedPayload) === JSON.stringify(payload)
      && candidate.payload.status !== 'complete'
      && candidate.payload.status !== 'superseded'
    ));
    if (
      !artifact
      || (artifact.type !== 'cloud_deep_diagnosis'
        && artifact.type !== 'cloud_semantic_comparison')
    ) {
      throw new PracticeSessionServiceError(
        'ARTIFACT_REFERENCE_NOT_FOUND',
        'Cloud execution requires its exact graph-validated queued artifact.',
      );
    }
    this.#assertArtifactReferences(session, artifact);
  }

  listArtifacts(sessionId: string): readonly PracticeArtifact[] {
    this.#sessions.getSessionOrThrow(sessionId);
    return this.#sessions.listArtifacts(sessionId);
  }

  getBootstrap(): BootstrapData {
    const activeSession =
      this.#sessions
        .listSessions()
        .find((session) => session.status !== 'completed' && session.status !== 'abandoned') ??
      null;
    return {
      modes: [...P1_MODE_PACKS],
      settings: this.getSettings(),
      activeSession,
    };
  }

  async saveAttemptAudio(input: SaveAttemptAudioUseCaseInput): Promise<Attempt> {
    return this.#withSessionLock(input.sessionId, () => this.#saveAttemptAudio(input));
  }

  async #saveAttemptAudio(input: SaveAttemptAudioUseCaseInput): Promise<Attempt> {
    const session = this.#sessions.getSessionOrThrow(input.sessionId);
    this.#assertAttemptCanBeRecorded(session, input.kind);

    const attemptId = input.attemptId ?? this.#createId();
    if (this.#sessions.isAttemptDiscarded(session.id, attemptId)) {
      throw new PracticeSessionServiceError(
        'ATTEMPT_DISCARDED',
        'This stopped take was already discarded and cannot be saved again.',
      );
    }
    const now = this.#now().toISOString();
    const previous = session.attempts.find((candidate) => candidate.kind === input.kind);
    if (previous?.id === attemptId) {
      const normalizedMimeType = input.mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      const sameRecording = previous.durationMs === input.durationMs
        && previous.byteLength === input.bytes.byteLength
        && previous.mimeType === normalizedMimeType
        && previous.audioRef !== null;
      if (sameRecording) {
        const stored = await this.#audio.read(previous.audioRef!);
        const identicalBytes = stored.byteLength === input.bytes.byteLength
          && stored.bytes.every((byte, index) => byte === input.bytes[index]);
        if (identicalBytes) return previous;
      }
      throw new PracticeSessionServiceError(
        'ATTEMPT_ID_REUSE_MISMATCH',
        'An attempt identity cannot be reused for different audio.',
      );
    }
    const stored = await this.#audio.save({
      sessionId: session.id,
      attemptId,
      bytes: input.bytes,
      mimeType: input.mimeType,
    });
    const attempt: Attempt = {
      id: attemptId,
      sessionId: session.id,
      kind: input.kind,
      status: 'recorded',
      audioRef: stored.relativePath,
      mimeType: stored.mimeType,
      durationMs: input.durationMs,
      byteLength: stored.byteLength,
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
    };
    let saved: PracticeSession;
    try {
      const next = upsertAttempt(session, attempt);
      const supersededArtifactIds = previous
        ? this.#artifactIdsForDiscardedAttempts(session.id, [previous])
        : [];
      saved = this.#sessions.updateSessionAndDeleteArtifacts(next, supersededArtifactIds, {
        clearAutomaticRecordTitle: input.kind === 'initial' && previous !== undefined,
        tombstoneAttempts: previous ? [{
          attemptId: previous.id,
          discardedAt: now,
          kind: previous.kind,
        }] : [],
      });
    } catch (error) {
      await this.#audio.delete(stored.relativePath).catch(() => undefined);
      throw error;
    }

    await this.#audio.delete(previous?.audioRef).catch(() => undefined);
    return saved.attempts.find((candidate) => candidate.kind === input.kind)!;
  }

  async readAttemptAudio(
    input: ReadAttemptAudioUseCaseInput,
  ): Promise<ReadAttemptAudioUseCaseResult> {
    return this.#withSessionLock(input.sessionId, () => this.#readAttemptAudio(input));
  }

  async #readAttemptAudio(
    input: ReadAttemptAudioUseCaseInput,
  ): Promise<ReadAttemptAudioUseCaseResult> {
    const attempt = this.#sessions.getAttempt(input.sessionId, input.kind);
    if (!attempt) {
      throw new PracticeSessionServiceError('ATTEMPT_NOT_FOUND', 'Attempt was not found.');
    }
    if (!attempt.audioRef) {
      throw new PracticeSessionServiceError(
        'AUDIO_NOT_AVAILABLE',
        'Temporary audio is no longer available.',
      );
    }

    const audio = await this.#audio.read(attempt.audioRef);
    return {
      bytes: audio.bytes,
      mimeType: attempt.mimeType,
    };
  }

  async discardAttemptAudio(
    input: DiscardAttemptAudioUseCaseInput,
  ): Promise<PracticeSession> {
    return this.#withSessionLock(input.sessionId, () => this.#discardAttemptAudio(input));
  }

  async #discardAttemptAudio(
    input: DiscardAttemptAudioUseCaseInput,
  ): Promise<PracticeSession> {
    const session = this.#sessions.getSessionOrThrow(input.sessionId);
    this.#assertAttemptCanBeDiscarded(session, input.kind);
    const discardedKinds: AttemptKind[] = input.kind === 'initial' ? ['initial', 'retry'] : ['retry'];
    const discardedAttempts = session.attempts.filter((attempt) =>
      discardedKinds.includes(attempt.kind),
    );
    const occupiedAttempt = session.attempts.find((attempt) => attempt.kind === input.kind);
    if (input.attemptId && occupiedAttempt && occupiedAttempt.id !== input.attemptId) {
      throw new PracticeSessionServiceError(
        'ATTEMPT_ID_REUSE_MISMATCH',
        'The requested stopped take no longer owns this Session attempt slot.',
      );
    }
    const discardedAttemptIds = new Set(discardedAttempts.map((attempt) => attempt.id));
    if (input.attemptId) discardedAttemptIds.add(input.attemptId);
    const discardedArtifactIds = this.#artifactIdsForDiscardedAttemptIds(
      session.id,
      discardedAttemptIds,
    );
    const discardedAt = this.#now().toISOString();
    const next = removeAttempt(session, input.kind, discardedAt);
    const discardedIdentities = new Map<string, AttemptKind>();
    for (const attempt of discardedAttempts) {
      discardedIdentities.set(attempt.id, attempt.kind);
    }
    if (input.attemptId) discardedIdentities.set(input.attemptId, input.kind);
    const saved = this.#sessions.updateSessionAndDeleteArtifacts(next, discardedArtifactIds, {
      clearAutomaticRecordTitle: input.kind === 'initial',
      tombstoneAttempts: [...discardedIdentities].map(([attemptId, kind]) => ({
        attemptId,
        discardedAt,
        kind,
      })),
    });
    await Promise.all(
      discardedAttempts.map((attempt) =>
        this.#audio.delete(attempt.audioRef).catch(() => undefined),
      ),
    );
    return saved;
  }

  #artifactIdsForDiscardedAttempts(
    sessionId: string,
    discardedAttempts: readonly Attempt[],
  ): readonly string[] {
    return this.#artifactIdsForDiscardedAttemptIds(
      sessionId,
      new Set(discardedAttempts.map((attempt) => attempt.id)),
    );
  }

  #artifactIdsForDiscardedAttemptIds(
    sessionId: string,
    discardedAttemptIds: ReadonlySet<string>,
  ): readonly string[] {
    const artifacts = this.#sessions.listArtifacts(sessionId);
    const discardedSnapshotIds = new Set(
      artifacts
        .filter((artifact): artifact is Extract<PracticeArtifact, { type: 'attempt_snapshot' }> => (
          artifact.type === 'attempt_snapshot'
          && discardedAttemptIds.has(artifact.payload.attemptId)
        ))
        .map((artifact) => artifact.payload.id),
    );
    const discardedArtifactIds = artifacts
      .filter((artifact) => this.#artifactDependsOnDiscardedAttempt(
        artifact,
        discardedAttemptIds,
        discardedSnapshotIds,
      ))
      .map((artifact) => artifact.id);
    return discardedArtifactIds;
  }

  #artifactDependsOnDiscardedAttempt(
    artifact: PracticeArtifact,
    discardedAttemptIds: ReadonlySet<string>,
    discardedSnapshotIds: ReadonlySet<string>,
  ): boolean {
    switch (artifact.type) {
      case 'attempt_snapshot':
        return discardedAttemptIds.has(artifact.payload.attemptId);
      case 'transcript_correction':
      case 'deep_report':
      case 'drill_completion':
      case 'cloud_deep_diagnosis':
        return discardedSnapshotIds.has(artifact.payload.snapshotId);
      case 'attempt_comparison':
        return discardedSnapshotIds.has(artifact.payload.initialSnapshotId)
          || discardedSnapshotIds.has(artifact.payload.retrySnapshotId);
      case 'cloud_semantic_comparison':
        return discardedAttemptIds.has(artifact.payload.initialAttemptId)
          || discardedAttemptIds.has(artifact.payload.retryAttemptId)
          || discardedSnapshotIds.has(artifact.payload.initialSnapshotId)
          || discardedSnapshotIds.has(artifact.payload.retrySnapshotId);
    }
  }

  async transitionSession(sessionId: string, event: SessionEvent): Promise<PracticeSession> {
    return this.#withSessionLock(sessionId, () => this.#transitionSession(sessionId, event));
  }

  async #transitionSession(sessionId: string, event: SessionEvent): Promise<PracticeSession> {
    const current = this.#sessions.getSessionOrThrow(sessionId);
    const transitionedWithoutLegacyRecovery = applySessionTransition(
      current,
      event,
      this.#now().toISOString(),
    );
    const recoveredReport = this.#recoverLegacyDiagnosisReportForTransition(current, event);
    const graphSession = recoveredReport
      ? PracticeSessionSchema.parse({
          ...current,
          diagnosisReportId: recoveredReport.id,
        })
      : current;
    const transitioned = recoveredReport
      ? PracticeSessionSchema.parse({
          ...transitionedWithoutLegacyRecovery,
          diagnosisReportId: recoveredReport.id,
        })
      : transitionedWithoutLegacyRecovery;
    if (
      event.type === 'select_focus'
      || event.type === 'skip_focus'
      || event.type === 'finish_analysis_only'
    ) {
      const report = this.#requireCurrentDiagnosisReport(
        current,
        event.diagnosisReportId,
      );
      if (
        event.type === 'select_focus'
        && (
          report.payload.focus?.criterionId !== event.focus.criterionId
          || report.payload.focus.drillId !== event.focus.drillId
        )
      ) {
        throw new PracticeSessionServiceError(
          'CURRENT_DEEP_REPORT_REQUIRED',
          'The selected focus must match the exact persisted diagnosis report.',
        );
      }
    }
    if (event.type === 'finish_retry_without_comparison') {
      this.#requireRetryCompletionArtifacts(graphSession);
    }
    if (event.type === 'view_comparison') {
      this.#requireCurrentComparisonArtifact(graphSession, event.comparisonArtifactId);
    }
    if (transitioned.status !== 'completed' && transitioned.status !== 'abandoned') {
      return this.#sessions.updateSession(transitioned);
    }

    this.#terminalizingSessions.add(sessionId);
    try {
      const shouldRetainAudio =
        transitioned.status === 'completed' &&
        this.#sessions.getSettings().audioRetention === 'keep_with_session';
      if (shouldRetainAudio) {
        await this.#audio.retainSession(sessionId);
        try {
          return this.#sessions.updateSession(
            PracticeSessionSchema.parse({
              ...transitioned,
              attempts: transitioned.attempts.map((attempt) => ({
                ...attempt,
                audioRef: attempt.audioRef
                  ? this.#audio.toRetainedReference(attempt.audioRef)
                  : null,
                updatedAt: transitioned.updatedAt,
              })),
            }),
          );
        } catch (databaseError) {
          try {
            await this.#audio.restoreRetainedSession(sessionId);
          } catch (compensationError) {
            throw new AggregateError(
              [databaseError, compensationError],
              'Retained audio could not be reconciled after a database failure.',
            );
          }
          throw databaseError;
        }
      }

      const withoutTemporaryAudio = PracticeSessionSchema.parse({
        ...transitioned,
        attempts: transitioned.attempts.map((attempt) => ({
          ...attempt,
          audioRef: null,
          updatedAt: transitioned.updatedAt,
        })),
      });
      const saved = this.#sessions.updateSession(withoutTemporaryAudio);
      await this.#audio.deleteSession(sessionId).catch(() => undefined);
      return saved;
    } finally {
      this.#terminalizingSessions.delete(sessionId);
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.#withSessionLock(sessionId, async () => {
      const deleted = this.#sessions.deleteSession(sessionId);
      try {
        await this.#audio.deleteSession(sessionId);
      } catch {
        throw new PracticeSessionServiceError(
          'SESSION_AUDIO_CLEANUP_FAILED',
          'The Session record was deleted, but storage reconciliation must retry audio cleanup.',
        );
      }
      return deleted;
    });
  }

  getSettings(): AppSettings {
    return this.#sessions.getSettings();
  }

  updateSettings(patch: AppSettingsPatch): AppSettings {
    const current = this.#sessions.getSettings();
    return this.#sessions.updateSettings({ ...current, ...patch });
  }

  countTrainingRecords(): number {
    return this.#sessions.countSessions();
  }

  async clearTrainingData(): Promise<number> {
    if (this.#trainingDataResetInProgress) {
      throw new PracticeSessionServiceError(
        'TRAINING_DATA_RESET_IN_PROGRESS',
        'Training data is already being cleared.',
      );
    }
    this.#trainingDataResetInProgress = true;
    try {
      await Promise.all(
        [...this.#sessionOperationTails.values()].map((tail) =>
          tail.catch(() => undefined),
        ),
      );
      const deletedTrainingRecordCount = this.#sessions.deleteAllTrainingData();
      try {
        await this.#audio.deleteAllTrainingAudio();
      } catch {
        throw new PracticeSessionServiceError(
          'TRAINING_AUDIO_CLEANUP_FAILED',
          'Training records were cleared, but audio cleanup needs to be retried.',
        );
      }
      return deletedTrainingRecordCount;
    } finally {
      this.#trainingDataResetInProgress = false;
    }
  }

  resetNonSensitivePreferences(): AppSettings {
    const current = this.#sessions.getSettings();
    return this.#sessions.updateSettings({
      ...DEFAULT_APP_SETTINGS,
      onboardingCompleted: current.onboardingCompleted,
    });
  }

  /**
   * Converts resumable cloud work into neutral history before consent/audit
   * reset. This is a main-process maintenance transition; renderer-authored
   * artifacts cannot use consent_reset to bypass the normal graph-drift gate.
   */
  supersedePendingCloudArtifactsForConsentReset(): number {
    this.#assertTrainingDataWritable();
    let supersededCount = 0;
    const nowMs = this.#now().getTime();
    for (const session of this.#sessions.listSessions()) {
      for (const artifact of this.#sessions.listArtifacts(session.id)) {
        if (
          (artifact.type !== 'cloud_deep_diagnosis'
            && artifact.type !== 'cloud_semantic_comparison')
          || (artifact.payload.status !== 'queued' && artifact.payload.status !== 'processing')
        ) continue;
        const at = new Date(Math.max(nowMs, Date.parse(artifact.payload.updatedAt))).toISOString();
        const payload = artifact.type === 'cloud_deep_diagnosis'
          ? transitionCloudDeepDiagnosis(artifact.payload, {
              status: 'superseded',
              at,
              supersededReason: 'consent_reset',
            })
          : transitionCloudSemanticComparison(artifact.payload, {
              status: 'superseded',
              at,
              supersededReason: 'consent_reset',
            });
        this.#sessions.putArtifact({ ...artifact, payload } as PracticeArtifact);
        supersededCount += 1;
      }
    }
    return supersededCount;
  }

  async cleanupExpiredAudio(): Promise<readonly string[]> {
    const deletedReferences = await this.#audio.cleanupExpired();
    await this.#reconcileAudioStorage();
    return deletedReferences;
  }

  #assertArtifactReferences(session: PracticeSession, artifact: PracticeArtifact): void {
    const cloudArtifact = artifact.type === 'cloud_deep_diagnosis'
      || artifact.type === 'cloud_semantic_comparison';
    if (!cloudArtifact && artifact.id !== artifact.payload.id) {
      this.#throwArtifactIdentity('Artifact id must match its ordinary payload id.');
    }

    const artifacts = this.#sessions.listArtifacts(session.id);
    const existing = artifacts.find((candidate) => candidate.id === artifact.id);
    if (existing && existing.type !== artifact.type) {
      this.#throwArtifactIdentity('An artifact id cannot change artifact type.');
    }
    if (existing && !this.#sameOrdinaryArtifactReference(existing, artifact)) {
      this.#throwArtifactIdentity('An artifact id cannot be moved to another frozen reference.');
    }

    const snapshotArtifacts = artifacts.filter(
      (candidate): candidate is Extract<PracticeArtifact, { readonly type: 'attempt_snapshot' }> =>
        candidate.type === 'attempt_snapshot',
    );
    const requireSnapshot = (snapshotId: string): AttemptSnapshot => {
      const snapshot = snapshotArtifacts.find((candidate) => candidate.id === snapshotId)?.payload;
      if (!snapshot) {
        throw new PracticeSessionServiceError(
          'ARTIFACT_REFERENCE_NOT_FOUND',
          `Referenced frozen snapshot was not found in Session ${session.id}.`,
        );
      }
      this.#assertSnapshotReferences(session, snapshot, true);
      return snapshot;
    };
    const correctionsFor = (snapshotId: string) => artifacts
      .filter((candidate): candidate is Extract<PracticeArtifact, { type: 'transcript_correction' }> => (
        candidate.type === 'transcript_correction'
        && candidate.payload.snapshotId === snapshotId
      ))
      .map((candidate) => candidate.payload);

    if (
      artifact.type === 'cloud_deep_diagnosis'
      || artifact.type === 'cloud_semantic_comparison'
    ) {
      const expectedId = artifact.type === 'cloud_deep_diagnosis'
        ? `cloud-deep-${artifact.payload.analysisInputId}`.slice(0, 96)
        : `${artifact.payload.analysisInputId}-${artifact.payload.consentId}`.slice(0, 96);
      if (artifact.id !== expectedId) {
        this.#throwArtifactIdentity('Cloud artifact id must use its canonical analysis identity.');
      }
      const duplicateAnalysis = artifacts.find((candidate) => (
        candidate.id !== artifact.id
        && candidate.type === artifact.type
        && candidate.payload.analysisInputId === artifact.payload.analysisInputId
      ));
      if (duplicateAnalysis) {
        this.#throwArtifactIdentity('One approved analysis input may have only one cloud artifact.');
      }
    }

    switch (artifact.type) {
      case 'attempt_snapshot': {
        const duplicateAttemptSnapshot = snapshotArtifacts.find(
          (candidate) => candidate.id !== artifact.id
            && candidate.payload.attemptId === artifact.payload.attemptId,
        );
        if (duplicateAttemptSnapshot) {
          this.#throwArtifactIdentity('One attempt may have only one frozen snapshot identity.');
        }
        this.#assertSnapshotReferences(session, artifact.payload, false);
        return;
      }
      case 'transcript_correction': {
        const snapshot = requireSnapshot(artifact.payload.snapshotId);
        const segment = snapshot.finalSegments.find(
          (candidate) => candidate.id === artifact.payload.segmentId,
        );
        if (!segment) {
          throw new PracticeSessionServiceError(
            'ARTIFACT_REFERENCE_NOT_FOUND',
            'A correction must reference a final segment in its frozen snapshot.',
          );
        }
        if (artifact.payload.originalText !== segment.text) {
          this.#throwArtifactReference(
            'A correction originalText must equal the immutable frozen segment text.',
          );
        }
        return;
      }
      case 'deep_report': {
        const snapshot = requireSnapshot(artifact.payload.snapshotId);
        const corrections = correctionsFor(snapshot.id);
        if (
          artifact.payload.transcriptVersion
          !== transcriptVersionForDeepLane(snapshot, corrections)
        ) {
          this.#throwArtifactReference('A report must use the current correction-aware transcript version.');
        }
        this.#assertCurrentEvidenceReferences(snapshot, corrections, artifact.payload.evidenceIds,
          'A report may cite current confirmed evidence from its referenced snapshot only.');
        if (artifact.payload.rubricCriterionId !== null) {
          this.#assertTaskCriterion(session, artifact.payload.rubricCriterionId);
        }
        if (artifact.payload.focus !== null) {
          this.#assertTaskFocus(
            session,
            artifact.payload.focus.criterionId,
            artifact.payload.focus.drillId,
          );
          if (artifact.payload.rubricCriterionId !== artifact.payload.focus.criterionId) {
            this.#throwArtifactReference('A report focus must match its Rubric criterion.');
          }
          const criterion = session.taskSnapshot.rubricSnapshot?.find(
            (candidate) => candidate.id === artifact.payload.focus?.criterionId,
          );
          const drill = session.taskSnapshot.drillSnapshot?.find(
            (candidate) => candidate.id === artifact.payload.focus?.drillId,
          );
          if (
            !criterion
            || !drill
            || artifact.payload.focus.label !== criterion.label
            || artifact.payload.focus.drill !== drill.template
          ) {
            this.#throwArtifactReference('A report must preserve the frozen Rubric and Drill wording.');
          }
        }
        if (artifact.payload.status === 'complete') {
          if (!artifact.payload.focus) {
            this.#throwArtifactReference('A complete local report requires one frozen training focus.');
          }
          const expected = buildLocalDeepReport({
            id: artifact.id,
            snapshot,
            corrections,
            at: artifact.payload.createdAt,
            focus: artifact.payload.focus,
          });
          if (
            JSON.stringify(artifact.payload.evidenceIds) !== JSON.stringify(expected.evidenceIds)
            || artifact.payload.judgment !== expected.judgment
          ) {
            this.#throwArtifactReference('A complete local report must match its frozen evidence derivation.');
          }
        }
        return;
      }
      case 'drill_completion': {
        const snapshot = requireSnapshot(artifact.payload.snapshotId);
        if (snapshot.kind !== 'initial') {
          this.#throwArtifactReference('A Drill must continue from the initial frozen snapshot.');
        }
        this.#assertSelectedFocus(
          session,
          artifact.payload.criterionId,
          artifact.payload.drillId,
        );
        return;
      }
      case 'attempt_comparison': {
        const initial = requireSnapshot(artifact.payload.initialSnapshotId);
        const retry = requireSnapshot(artifact.payload.retrySnapshotId);
        if (
          initial.id === retry.id
          || initial.kind !== 'initial'
          || retry.kind !== 'retry'
        ) {
          this.#throwArtifactReference(
            'A paired comparison requires distinct initial and retry frozen snapshots.',
          );
        }
        const focus = this.#assertSelectedFocus(session, artifact.payload.criterionId);
        const initialCorrections = correctionsFor(initial.id);
        const retryCorrections = correctionsFor(retry.id);
        const comparisonCorrections = [...initialCorrections, ...retryCorrections];
        this.#assertCurrentEvidenceReferences(
          initial,
          initialCorrections,
          artifact.payload.initialEvidenceIds,
          'Initial comparison evidence must belong to the initial snapshot.',
        );
        this.#assertCurrentEvidenceReferences(
          retry,
          retryCorrections,
          artifact.payload.retryEvidenceIds,
          'Retry comparison evidence must belong to the retry snapshot.',
        );
        const drill = artifacts.find(
          (candidate): candidate is Extract<PracticeArtifact, { readonly type: 'drill_completion' }> =>
            candidate.type === 'drill_completion'
            && candidate.payload.snapshotId === initial.id
            && candidate.payload.criterionId === focus.criterionId
            && candidate.payload.drillId === focus.drillId,
        );
        if (!drill) {
          throw new PracticeSessionServiceError(
            'ARTIFACT_REFERENCE_NOT_FOUND',
            'A paired comparison requires the persisted Drill for its selected focus.',
          );
        }
        if (retry.focusVersion !== drill.payload.focusVersion) {
          this.#throwArtifactReference(
            'Retry snapshot focus version must match the completed Drill focus version.',
          );
        }
        const criterion = session.taskSnapshot.rubricSnapshot?.find(
          (candidate) => candidate.id === focus.criterionId,
        );
        if (
          artifact.payload.basis
          && criterion?.comparisonDimension
          && artifact.payload.basis.dimensionId !== criterion.comparisonDimension
        ) {
          this.#throwArtifactReference(
            'Comparison basis must use the frozen selected criterion dimension.',
          );
        }
        const expected = compareFrozenAttempts({
          id: artifact.id,
          initial,
          retry,
          criterionId: artifact.payload.criterionId,
          comparisonDimension: criterion?.comparisonDimension,
          corrections: comparisonCorrections,
          at: artifact.payload.comparedAt,
        });
        if (JSON.stringify(artifact.payload) !== JSON.stringify(expected)) {
          this.#throwArtifactReference('A paired comparison must equal the server-derived frozen comparison.');
        }
        return;
      }
      case 'cloud_deep_diagnosis': {
        const snapshot = requireSnapshot(artifact.payload.snapshotId);
        const corrections = correctionsFor(snapshot.id);
        const currentTranscriptVersion = transcriptVersionForDeepLane(snapshot, corrections);
        const currentGraph = artifact.payload.approvedPayload.sessionId === session.id
          && artifact.payload.approvedPayload.attemptId === snapshot.attemptId
          && artifact.payload.transcriptVersion === currentTranscriptVersion;
        if (artifact.payload.status === 'superseded') {
          if (currentGraph) {
            this.#throwArtifactReference(
              'A current cloud diagnosis cannot be superseded without a transcript change.',
            );
          }
        } else if (!currentGraph) {
          this.#throwArtifactReference('Cloud diagnosis must match the current frozen snapshot graph.');
        }
        if (artifact.payload.status !== 'superseded') {
          const originalPayload = buildDeepDiagnosisPayload({
            session,
            snapshot,
            corrections,
            analysisInputId: artifact.payload.analysisInputId,
          });
          try {
            parseEditedDeepPayload(
              JSON.stringify(artifact.payload.approvedPayload),
              originalPayload,
            );
          } catch {
            this.#throwArtifactReference(
              'Cloud diagnosis payload must stay within the authoritative frozen snapshot.',
            );
          }
        }
        if (
          artifact.payload.approvedPayload.sessionId !== session.id
          || artifact.payload.approvedPayload.attemptId !== snapshot.attemptId
        ) {
          this.#throwArtifactReference('Cloud diagnosis must match the current frozen snapshot graph.');
        }
        this.#assertCloudArtifactTransition(existing, artifact);
        return;
      }
      case 'cloud_semantic_comparison': {
        const initial = requireSnapshot(artifact.payload.initialSnapshotId);
        const retry = requireSnapshot(artifact.payload.retrySnapshotId);
        if (initial.kind !== 'initial' || retry.kind !== 'retry') {
          this.#throwArtifactReference('Cloud comparison requires an initial and retry snapshot.');
        }
        this.#assertSelectedFocus(
          session,
          artifact.payload.criterionId,
          artifact.payload.drillId,
        );
        const initialCorrections = correctionsFor(initial.id);
        const retryCorrections = correctionsFor(retry.id);
        const currentGraph = artifact.payload.approvedPayload.sessionId === session.id
          && artifact.payload.initialAttemptId === initial.attemptId
          && artifact.payload.retryAttemptId === retry.attemptId
          && artifact.payload.initialTranscriptVersion
            === transcriptVersionForDeepLane(initial, initialCorrections)
          && artifact.payload.retryTranscriptVersion
            === transcriptVersionForDeepLane(retry, retryCorrections)
          && artifact.payload.focusVersion === retry.focusVersion
          && artifact.payload.criterionId === session.focus?.criterionId
          && artifact.payload.drillId === session.focus?.drillId;
        if (artifact.payload.status === 'superseded') {
          if (currentGraph) {
            this.#throwArtifactReference(
              'A current cloud comparison cannot be superseded without an input change.',
            );
          }
        } else if (!currentGraph) {
          this.#throwArtifactReference('Cloud comparison must match the current paired snapshot graph.');
        }
        if (artifact.payload.status !== 'superseded') {
          const originalPayload = buildSemanticComparisonPayload({
            session,
            initial,
            retry,
            criterionId: artifact.payload.criterionId,
            label: artifact.payload.approvedPayload.focus.label,
            drillId: artifact.payload.drillId,
            corrections: [...initialCorrections, ...retryCorrections],
            analysisInputId: artifact.payload.analysisInputId,
          });
          try {
            parseEditedComparisonPayload(
              JSON.stringify(artifact.payload.approvedPayload),
              originalPayload,
            );
          } catch {
            this.#throwArtifactReference(
              'Cloud comparison payload must stay within the authoritative paired snapshots.',
            );
          }
        }
        this.#assertCloudArtifactTransition(existing, artifact);
        return;
      }
    }
  }

  #assertSnapshotReferences(
    session: PracticeSession,
    snapshot: AttemptSnapshot,
    requirePersistedAttempt: boolean,
  ): void {
    if (snapshot.sessionId !== session.id) {
      this.#throwArtifactReference('A frozen snapshot must belong to its outer Session.');
    }
    for (const candidateSession of this.#sessions.listSessions()) {
      if (candidateSession.id === session.id) continue;
      const foreignAttempt = candidateSession.attempts.some(
        (candidate) => candidate.id === snapshot.attemptId,
      );
      const foreignSnapshot = this.#sessions.listArtifacts(candidateSession.id).some(
        (candidate) => candidate.type === 'attempt_snapshot'
          && candidate.payload.attemptId === snapshot.attemptId,
      );
      if (foreignAttempt || foreignSnapshot) {
        this.#throwArtifactReference('A frozen attempt identity is already owned by another Session.');
      }
    }
    const attempt = session.attempts.find((candidate) => candidate.id === snapshot.attemptId);
    const occupiedSlot = session.attempts.find((candidate) => candidate.kind === snapshot.kind);
    if (
      (attempt && attempt.kind !== snapshot.kind)
      || (occupiedSlot && occupiedSlot.id !== snapshot.attemptId)
    ) {
      this.#throwArtifactReference('A frozen snapshot must match its Session attempt slot.');
    }
    if (requirePersistedAttempt && !attempt) {
      throw new PracticeSessionServiceError(
        'ARTIFACT_REFERENCE_NOT_FOUND',
        'The frozen snapshot attempt was not found in its Session.',
      );
    }

    const segmentIds = new Set(snapshot.finalSegments.map((segment) => segment.id));
    if (snapshot.finalSegments.some((segment) => segment.attemptId !== snapshot.attemptId)) {
      this.#throwArtifactReference('Frozen segments must belong to the snapshot attempt.');
    }
    if (snapshot.annotations.some((annotation) => !segmentIds.has(annotation.segmentId))) {
      this.#throwArtifactReference('Frozen annotations must reference final segments in their snapshot.');
    }
    if (
      snapshot.hints.some(
        (hint) => hint.attemptId !== snapshot.attemptId
          || hint.segmentIds.some((segmentId) => !segmentIds.has(segmentId)),
      )
    ) {
      this.#throwArtifactReference('Frozen hints must reference their snapshot attempt and final segments.');
    }
  }

  #assertCurrentEvidenceReferences(
    snapshot: AttemptSnapshot,
    corrections: readonly Extract<PracticeArtifact, { type: 'transcript_correction' }>['payload'][],
    evidenceIds: readonly string[],
    message: string,
  ): void {
    const available = new Set(
      evidenceForDeepLane(snapshot, corrections)
        .filter((item) => item.currentLifecycle === 'confirmed')
        .map((item) => item.annotation.id),
    );
    if (evidenceIds.some((evidenceId) => !available.has(evidenceId))) {
      this.#throwArtifactReference(message);
    }
  }

  #assertCloudArtifactTransition(
    existing: PracticeArtifact | undefined,
    next: Extract<PracticeArtifact, { type: 'cloud_deep_diagnosis' | 'cloud_semantic_comparison' }>,
  ): void {
    if (!existing) {
      if (next.payload.status !== 'queued' || next.payload.lifecycle.length !== 1) {
        this.#throwArtifactReference('A cloud artifact must begin with one queued lifecycle event.');
      }
      return;
    }
    if (existing.type !== next.type) this.#throwArtifactIdentity('Cloud artifact type is immutable.');
    if (JSON.stringify(existing) === JSON.stringify(next)) return;
    const previousLifecycle = existing.payload.lifecycle;
    const nextLifecycle = next.payload.lifecycle;
    if (
      nextLifecycle.length !== previousLifecycle.length + 1
      || JSON.stringify(nextLifecycle.slice(0, -1)) !== JSON.stringify(previousLifecycle)
    ) {
      this.#throwArtifactIdentity('Cloud artifact lifecycle updates must append to the persisted state.');
    }
    if (
      existing.payload.result !== null
      && JSON.stringify(next.payload.result) !== JSON.stringify(existing.payload.result)
    ) {
      this.#throwArtifactIdentity('A persisted cloud provider result cannot be replaced or erased.');
    }
  }

  #assertTaskCriterion(session: PracticeSession, criterionId: string): void {
    if (!session.taskSnapshot.focusCandidateCriterionIds.includes(criterionId)) {
      this.#throwArtifactReference('Artifact criterion must exist in the frozen task Rubric.');
    }
  }

  #assertTaskFocus(session: PracticeSession, criterionId: string, drillId: string): void {
    this.#assertTaskCriterion(session, criterionId);
    const mapping = session.taskSnapshot.focusDrillMappings.find(
      (candidate) => candidate.criterionId === criterionId,
    );
    if (!mapping?.drillIds.includes(drillId)) {
      this.#throwArtifactReference('Artifact Drill must train its frozen task criterion.');
    }
  }

  #assertSelectedFocus(
    session: PracticeSession,
    criterionId: string,
    drillId?: string,
  ): NonNullable<PracticeSession['focus']> {
    const focus = session.focus;
    if (
      !focus
      || focus.criterionId !== criterionId
      || (drillId !== undefined && focus.drillId !== drillId)
    ) {
      this.#throwArtifactReference('Artifact focus must match the Session selected focus.');
    }
    this.#assertTaskFocus(session, focus.criterionId, focus.drillId);
    return focus;
  }

  #requireCurrentDiagnosisReport(
    session: PracticeSession,
    diagnosisReportId: string,
  ): Extract<PracticeArtifact, { readonly type: 'deep_report' }> {
    const currentReports = this.#listCurrentValidDiagnosisReports(session);
    const currentReport = currentReports.find((artifact) => artifact.id === diagnosisReportId);
    if (!currentReport) {
      throw new PracticeSessionServiceError(
        'CURRENT_DEEP_REPORT_REQUIRED',
        'This path requires the exact complete report for the current correction version.',
      );
    }
    return currentReport;
  }

  #recoverLegacyDiagnosisReportForTransition(
    session: PracticeSession,
    event: SessionEvent,
  ): Extract<PracticeArtifact, { readonly type: 'deep_report' }> | null {
    if (
      session.diagnosisReportId !== null
      || (
        event.type !== 'complete_drill'
        && event.type !== 'confirm_second_attempt'
        && event.type !== 'finish_retry_without_comparison'
        && event.type !== 'view_comparison'
      )
    ) {
      return null;
    }

    const currentReports = this.#listCurrentValidDiagnosisReports(session);
    if (currentReports.length === 0) {
      throw new PracticeSessionServiceError(
        'CURRENT_DEEP_REPORT_REQUIRED',
        'This legacy Session has no valid complete diagnosis for its current transcript. Reopen the diagnosis result and save it before continuing.',
      );
    }
    const frozenFocus = session.focus;
    const matchingReports = frozenFocus === null
      ? currentReports
      : currentReports.filter((report) => (
          report.payload.focus?.criterionId === frozenFocus.criterionId
          && report.payload.focus?.drillId === frozenFocus.drillId
        ));
    if (matchingReports.length === 0) {
      throw new PracticeSessionServiceError(
        'CURRENT_DEEP_REPORT_REQUIRED',
        'No current diagnosis matches this legacy Session focus. Reopen the diagnosis result and explicitly choose a path before continuing.',
      );
    }
    if (matchingReports.length > 1) {
      throw new PracticeSessionServiceError(
        'CURRENT_DEEP_REPORT_REQUIRED',
        'This legacy Session has multiple valid diagnoses for its current path. Reopen the diagnosis result and explicitly choose one before continuing.',
      );
    }

    return matchingReports[0]!;
  }

  #listCurrentValidDiagnosisReports(
    session: PracticeSession,
  ): readonly Extract<PracticeArtifact, { readonly type: 'deep_report' }>[] {
    const artifacts = this.#sessions.listArtifacts(session.id);
    const initialAttempt = session.attempts.find((attempt) => attempt.kind === 'initial');
    const snapshot = selectAttemptSnapshot({
      artifacts,
      kind: 'initial',
      expectedAttemptId: initialAttempt?.id,
    });
    if (!snapshot) {
      throw new PracticeSessionServiceError(
        'CURRENT_DEEP_REPORT_REQUIRED',
        'A diagnosis path requires the current persisted initial-attempt snapshot.',
      );
    }
    if (snapshot.finalSegments.length === 0) {
      throw new PracticeSessionServiceError(
        'REQUIRED_PRACTICE_ARTIFACT_MISSING',
        'A terminal diagnosis requires a frozen snapshot with at least one final segment.',
      );
    }
    const corrections = artifacts
      .filter((artifact): artifact is Extract<PracticeArtifact, { type: 'transcript_correction' }> => (
        artifact.type === 'transcript_correction'
        && artifact.payload.snapshotId === snapshot.id
      ))
      .map((artifact) => artifact.payload);
    const transcriptVersion = transcriptVersionForDeepLane(snapshot, corrections);
    const candidates = artifacts.filter((artifact): artifact is Extract<
      PracticeArtifact,
      { readonly type: 'deep_report' }
    > => (
      artifact.type === 'deep_report'
      && artifact.payload.snapshotId === snapshot.id
      && artifact.payload.transcriptVersion === transcriptVersion
      && artifact.payload.status === 'complete'
    ));
    return candidates.filter((candidate) => {
      try {
        this.#assertArtifactReferences(session, candidate);
        return true;
      } catch (error) {
        if (
          error instanceof PracticeSessionServiceError
          && (
            error.code === 'ARTIFACT_IDENTITY_MISMATCH'
            || error.code === 'ARTIFACT_REFERENCE_NOT_FOUND'
            || error.code === 'ARTIFACT_REFERENCE_MISMATCH'
          )
        ) {
          return false;
        }
        throw error;
      }
    });
  }

  #requireFrozenAttemptPair(session: PracticeSession): {
    readonly initial: AttemptSnapshot;
    readonly retry: AttemptSnapshot;
  } {
    const artifacts = this.#sessions.listArtifacts(session.id);
    const initialAttempt = session.attempts.find((attempt) => attempt.kind === 'initial');
    const retryAttempt = session.attempts.find((attempt) => attempt.kind === 'retry');
    const initial = selectAttemptSnapshot({
      artifacts,
      kind: 'initial',
      expectedAttemptId: initialAttempt?.id,
    });
    const retry = selectAttemptSnapshot({
      artifacts,
      kind: 'retry',
      expectedAttemptId: retryAttempt?.id,
    });
    if (!initial || !retry) {
      throw new PracticeSessionServiceError(
        'REQUIRED_PRACTICE_ARTIFACT_MISSING',
        'Completing a retry requires both persisted frozen Attempt snapshots.',
      );
    }
    if (initial.finalSegments.length === 0 || retry.finalSegments.length === 0) {
      throw new PracticeSessionServiceError(
        'REQUIRED_PRACTICE_ARTIFACT_MISSING',
        'Completing a retry requires final transcript evidence in both frozen snapshots.',
      );
    }
    this.#assertSnapshotReferences(session, initial, true);
    this.#assertSnapshotReferences(session, retry, true);
    return { initial, retry };
  }

  #requireRetryCompletionArtifacts(session: PracticeSession): {
    readonly initial: AttemptSnapshot;
    readonly retry: AttemptSnapshot;
  } {
    if (!session.diagnosisReportId) {
      throw new PracticeSessionServiceError(
        'REQUIRED_PRACTICE_ARTIFACT_MISSING',
        'Completing a retry requires the diagnosis report frozen for this path.',
      );
    }
    this.#requireCurrentDiagnosisReport(session, session.diagnosisReportId);
    const pair = this.#requireFrozenAttemptPair(session);
    if (session.focus === null) {
      if (pair.retry.focusVersion !== null) {
        throw new PracticeSessionServiceError(
          'ARTIFACT_REFERENCE_MISMATCH',
          'A free retry snapshot cannot claim a frozen focus version.',
        );
      }
      return pair;
    }

    const artifacts = this.#sessions.listArtifacts(session.id);
    const drill = artifacts.find((artifact): artifact is Extract<
      PracticeArtifact,
      { readonly type: 'drill_completion' }
    > => (
      artifact.type === 'drill_completion'
      && artifact.payload.snapshotId === pair.initial.id
      && artifact.payload.criterionId === session.focus?.criterionId
      && artifact.payload.drillId === session.focus?.drillId
    ));
    if (!drill) {
      throw new PracticeSessionServiceError(
        'REQUIRED_PRACTICE_ARTIFACT_MISSING',
        'A focused retry requires its persisted Drill completion.',
      );
    }
    this.#assertArtifactReferences(session, drill);
    if (pair.retry.focusVersion !== drill.payload.focusVersion) {
      throw new PracticeSessionServiceError(
        'ARTIFACT_REFERENCE_MISMATCH',
        'The retry snapshot must use the completed Drill focus version.',
      );
    }
    return pair;
  }

  #requireCurrentComparisonArtifact(
    session: PracticeSession,
    comparisonArtifactId: string,
  ): void {
    const { initial, retry } = this.#requireRetryCompletionArtifacts(session);
    const comparison = this.#sessions.listArtifacts(session.id).find(
      (artifact): artifact is Extract<
        PracticeArtifact,
        { readonly type: 'attempt_comparison' }
      > => (
        artifact.id === comparisonArtifactId
        && artifact.type === 'attempt_comparison'
        && artifact.payload.initialSnapshotId === initial.id
        && artifact.payload.retrySnapshotId === retry.id
        && artifact.payload.criterionId === session.focus?.criterionId
      ),
    );
    if (!comparison) {
      throw new PracticeSessionServiceError(
        'REQUIRED_PRACTICE_ARTIFACT_MISSING',
        'Viewing comparison requires the persisted comparison for both current snapshots.',
      );
    }
    this.#assertArtifactReferences(session, comparison);
  }

  #sameOrdinaryArtifactReference(
    existing: PracticeArtifact,
    next: PracticeArtifact,
  ): boolean {
    if (existing.type !== next.type) return false;
    switch (existing.type) {
      case 'attempt_snapshot':
        return next.type === 'attempt_snapshot'
          && existing.payload.sessionId === next.payload.sessionId
          && existing.payload.attemptId === next.payload.attemptId
          && existing.payload.kind === next.payload.kind
          && JSON.stringify(existing.payload) === JSON.stringify(next.payload);
      case 'transcript_correction':
        return next.type === 'transcript_correction'
          && existing.payload.snapshotId === next.payload.snapshotId
          && existing.payload.segmentId === next.payload.segmentId
          && JSON.stringify(existing.payload) === JSON.stringify(next.payload);
      case 'deep_report':
        return next.type === 'deep_report'
          && existing.payload.snapshotId === next.payload.snapshotId
          && JSON.stringify(existing.payload) === JSON.stringify(next.payload);
      case 'drill_completion':
        return next.type === 'drill_completion'
          && existing.payload.snapshotId === next.payload.snapshotId
          && existing.payload.focusVersion === next.payload.focusVersion
          && existing.payload.criterionId === next.payload.criterionId
          && existing.payload.drillId === next.payload.drillId;
      case 'attempt_comparison':
        return next.type === 'attempt_comparison'
          && existing.payload.initialSnapshotId === next.payload.initialSnapshotId
          && existing.payload.retrySnapshotId === next.payload.retrySnapshotId
          && existing.payload.criterionId === next.payload.criterionId;
      case 'cloud_deep_diagnosis':
        return next.type === 'cloud_deep_diagnosis'
          && existing.payload.snapshotId === next.payload.snapshotId
          && existing.payload.transcriptVersion === next.payload.transcriptVersion
          && existing.payload.analysisInputId === next.payload.analysisInputId
          && existing.payload.payloadHash === next.payload.payloadHash
          && existing.payload.consentId === next.payload.consentId
          && JSON.stringify(existing.payload.approvedPayload)
            === JSON.stringify(next.payload.approvedPayload);
      case 'cloud_semantic_comparison':
        return next.type === 'cloud_semantic_comparison'
          && existing.payload.analysisInputId === next.payload.analysisInputId
          && existing.payload.initialSnapshotId === next.payload.initialSnapshotId
          && existing.payload.retrySnapshotId === next.payload.retrySnapshotId
          && existing.payload.initialTranscriptVersion === next.payload.initialTranscriptVersion
          && existing.payload.retryTranscriptVersion === next.payload.retryTranscriptVersion
          && existing.payload.focusVersion === next.payload.focusVersion
          && existing.payload.criterionId === next.payload.criterionId
          && existing.payload.drillId === next.payload.drillId
          && existing.payload.payloadHash === next.payload.payloadHash
          && existing.payload.consentId === next.payload.consentId
          && JSON.stringify(existing.payload.approvedPayload)
            === JSON.stringify(next.payload.approvedPayload);
    }
  }

  #throwArtifactIdentity(message: string): never {
    throw new PracticeSessionServiceError('ARTIFACT_IDENTITY_MISMATCH', message);
  }

  #throwArtifactReference(message: string): never {
    throw new PracticeSessionServiceError('ARTIFACT_REFERENCE_MISMATCH', message);
  }

  #assertAttemptCanBeRecorded(session: PracticeSession, kind: AttemptKind): void {
    const expectedStatus = kind === 'initial' ? 'first_attempt' : 'second_attempt';
    if (session.status !== expectedStatus) {
      throw new PracticeSessionServiceError(
        'INVALID_ATTEMPT_STAGE',
        `${kind} attempt cannot be recorded while session is ${session.status}.`,
      );
    }
  }

  #assertAttemptCanBeDiscarded(session: PracticeSession, kind: AttemptKind): void {
    const expectedStatus = kind === 'initial' ? 'first_attempt' : 'second_attempt';
    if (session.status !== expectedStatus) {
      throw new PracticeSessionServiceError(
        'INVALID_ATTEMPT_STAGE',
        `${kind} attempt cannot be discarded while session is ${session.status}.`,
      );
    }
  }

  async #reconcileAudioStorage(): Promise<void> {
    let sessions = this.#sessions.listSessions();

    // Repair a crash between the directory rename and its matching DB commit.
    for (const session of sessions) {
      for (const attempt of session.attempts) {
        if (!attempt.audioRef || (await this.#audio.referenceExists(attempt.audioRef))) {
          continue;
        }
        const expectsRetained = attempt.audioRef.startsWith('retained/');
        const counterpart = expectsRetained
          ? this.#audio.toTemporaryReference(attempt.audioRef)
          : this.#audio.toRetainedReference(attempt.audioRef);
        if (!(await this.#audio.referenceExists(counterpart))) {
          continue;
        }
        try {
          if (expectsRetained) {
            await this.#audio.retainSession(session.id);
          } else {
            await this.#audio.restoreRetainedSession(session.id);
          }
        } catch {
          // Missing-reference reconciliation below keeps the DB honest if repair fails.
        }
        break;
      }
    }

    const now = this.#now().toISOString();
    sessions = this.#sessions.listSessions();
    for (const session of sessions) {
      const referencedAttempts = session.attempts.filter(
        (attempt): attempt is Attempt & { audioRef: string } => attempt.audioRef !== null,
      );
      const existence = await Promise.all(
        referencedAttempts.map((attempt) => this.#audio.referenceExists(attempt.audioRef)),
      );
      if (existence.every(Boolean)) {
        continue;
      }

      await this.#audio.deleteSession(session.id).catch(() => undefined);
      const withoutAudio = PracticeSessionSchema.parse({
        ...session,
        attempts: session.attempts.map((attempt) => ({
          ...attempt,
          audioRef: null,
          updatedAt: now,
        })),
        updatedAt: now,
      });
      const reconciled =
        withoutAudio.status === 'completed' || withoutAudio.status === 'abandoned'
          ? withoutAudio
          : applySessionTransition(withoutAudio, { type: 'abandon' }, now);
      this.#sessions.updateSession(reconciled);
    }

    const referencedAudio = new Set(
      this.#sessions
        .listSessions()
        .flatMap((session) => session.attempts)
        .flatMap((attempt) => (attempt.audioRef ? [attempt.audioRef] : [])),
    );
    for (const storedReference of await this.#audio.listStoredReferences()) {
      if (!referencedAudio.has(storedReference)) {
        await this.#audio.delete(storedReference).catch(() => undefined);
      }
    }
  }

  async #withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    this.#assertTrainingDataWritable();
    const previousTail = this.#sessionOperationTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentTail = previousTail.catch(() => undefined).then(() => gate);
    this.#sessionOperationTails.set(sessionId, currentTail);

    await previousTail.catch(() => undefined);
    try {
      this.#assertTrainingDataWritable();
      return await operation();
    } finally {
      release();
      if (this.#sessionOperationTails.get(sessionId) === currentTail) {
        this.#sessionOperationTails.delete(sessionId);
      }
    }
  }

  #assertTrainingDataWritable(): void {
    if (this.#trainingDataResetInProgress) {
      throw new PracticeSessionServiceError(
        'TRAINING_DATA_RESET_IN_PROGRESS',
        'Training data cannot change while it is being cleared.',
      );
    }
  }
}

export class PracticeSessionServiceError extends Error {
  constructor(
    readonly code:
      | 'TASK_NOT_FOUND'
      | 'INVALID_CUSTOM_TASK'
      | 'INVALID_TASK_OVERRIDES'
      | 'FIXTURE_FLAG_MISMATCH'
      | 'ATTEMPT_NOT_FOUND'
      | 'AUDIO_NOT_AVAILABLE'
      | 'INVALID_ATTEMPT_STAGE'
      | 'ATTEMPT_ID_REUSE_MISMATCH'
      | 'ATTEMPT_DISCARDED'
      | 'ARTIFACT_IDENTITY_MISMATCH'
      | 'ARTIFACT_REFERENCE_NOT_FOUND'
      | 'ARTIFACT_REFERENCE_MISMATCH'
      | 'CURRENT_DEEP_REPORT_REQUIRED'
      | 'REQUIRED_PRACTICE_ARTIFACT_MISSING'
      | 'SESSION_ARTIFACTS_FROZEN'
      | 'TRAINING_DATA_RESET_IN_PROGRESS'
      | 'SESSION_AUDIO_CLEANUP_FAILED'
      | 'TRAINING_AUDIO_CLEANUP_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'PracticeSessionServiceError';
  }
}
