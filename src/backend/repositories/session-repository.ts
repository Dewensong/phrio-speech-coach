import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  AppSettingsSchema,
  AttemptSchema,
  DEFAULT_APP_SETTINGS,
  PracticeSessionSchema,
  PracticeArtifactSchema,
  derivePracticeRecordTitle,
  type AppSettings,
  type Attempt,
  type AttemptKind,
  type PracticeSession,
  type PracticeArtifact,
} from '../../shared';

interface SessionRow {
  readonly id: string;
  readonly mode_id: string;
  readonly mode_version: string;
  readonly task_id: string;
  readonly task_version: string;
  readonly task_snapshot_json: string;
  readonly status: string;
  readonly outcome: string | null;
  readonly guidance_source: string | null;
  readonly focus_json: string | null;
  readonly diagnosis_report_id: string | null;
  readonly comparison_artifact_id: string | null;
  readonly record_title: string | null;
  readonly record_title_source: string | null;
  readonly pinned_at: string | null;
  readonly drill_completed_at: string | null;
  readonly comparison_viewed_at: string | null;
  readonly development_fixture: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AttemptRow {
  readonly id: string;
  readonly session_id: string;
  readonly kind: string;
  readonly status: string;
  readonly audio_ref: string | null;
  readonly mime_type: string;
  readonly duration_ms: number;
  readonly byte_length: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly confirmed_at: string | null;
}

export interface SessionRepositoryOptions {
  readonly readOnly?: boolean;
}

export interface PutArtifactOptions {
  readonly defaultRecordTitle?: string;
}

export interface UpdateSessionArtifactsOptions {
  readonly clearAutomaticRecordTitle?: boolean;
  readonly tombstoneAttempts?: readonly {
    readonly attemptId: string;
    readonly discardedAt: string;
    readonly kind: AttemptKind;
  }[];
}

/** SQLite persistence only. Business transitions and audio lifecycle live in services. */
export class SessionRepository {
  readonly #database: DatabaseSync;
  readonly #databasePath: string | null;
  readonly #databaseDirectory: string | null;
  readonly #readOnly: boolean;

  constructor(databasePath: string, options: SessionRepositoryOptions = {}) {
    this.#readOnly = options.readOnly ?? false;
    this.#databasePath = databasePath === ':memory:' ? null : path.resolve(databasePath);
    this.#databaseDirectory = this.#databasePath ? path.dirname(this.#databasePath) : null;
    if (this.#databaseDirectory && !this.#readOnly) {
      mkdirSync(this.#databaseDirectory, { recursive: true, mode: 0o700 });
      chmodSync(this.#databaseDirectory, 0o700);
    }

    this.#database = new DatabaseSync(this.#databasePath ?? ':memory:', {
      readOnly: this.#readOnly,
      enableForeignKeyConstraints: true,
    });
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.#database.exec('PRAGMA trusted_schema = OFF');
    if (!this.#readOnly) {
      this.#database.exec('PRAGMA journal_mode = WAL');
      this.#database.exec('PRAGMA synchronous = FULL');
      this.#migrate();
      this.#hardenStoragePermissions();
    }
  }

  close(): void {
    this.#hardenStoragePermissions();
    this.#database.close();
    this.#hardenStoragePermissions();
  }

  createSession(sessionInput: PracticeSession): PracticeSession {
    const session = PracticeSessionSchema.parse(sessionInput);
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO practice_sessions (
            id, mode_id, mode_version, task_id, task_version, task_snapshot_json,
            status, outcome, guidance_source, focus_json, diagnosis_report_id,
            comparison_artifact_id, record_title, record_title_source, pinned_at, drill_completed_at,
            comparison_viewed_at, development_fixture, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...this.#sessionValues(session));

      for (const attempt of session.attempts) {
        this.#insertAttempt(attempt);
      }
    });

    return this.getSessionOrThrow(session.id);
  }

  getSession(sessionId: string): PracticeSession | null {
    const row = this.#database
      .prepare('SELECT * FROM practice_sessions WHERE id = ?')
      .get(sessionId) as unknown as SessionRow | undefined;
    if (!row) {
      return null;
    }
    return this.#mapSession(row, this.listAttempts(sessionId));
  }

  getSessionOrThrow(sessionId: string): PracticeSession {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new SessionRepositoryError('SESSION_NOT_FOUND', 'Practice session was not found.');
    }
    return session;
  }

  listSessions(): readonly PracticeSession[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM practice_sessions
         ORDER BY pinned_at DESC, updated_at DESC, id DESC`,
      )
      .all() as unknown as SessionRow[];
    return rows.map((row) => this.#mapSession(row, this.listAttempts(row.id)));
  }

  updateSession(sessionInput: PracticeSession): PracticeSession {
    const session = PracticeSessionSchema.parse(sessionInput);
    this.#transaction(() => {
      this.#updateSessionRows(session);
    });
    return this.getSessionOrThrow(session.id);
  }

  /** Atomically updates a Session graph and removes only the named derived artifacts. */
  updateSessionAndDeleteArtifacts(
    sessionInput: PracticeSession,
    artifactIdsInput: readonly string[],
    options: UpdateSessionArtifactsOptions = {},
  ): PracticeSession {
    const session = PracticeSessionSchema.parse(sessionInput);
    const artifactIds = [...new Set(artifactIdsInput)];
    this.#transaction(() => {
      this.#updateSessionRows(session);
      if (artifactIds.length > 0) {
        const placeholders = artifactIds.map(() => '?').join(', ');
        this.#database
          .prepare(
            `DELETE FROM practice_artifacts
             WHERE session_id = ? AND id IN (${placeholders})`,
          )
          .run(session.id, ...artifactIds);
      }
      if (options.clearAutomaticRecordTitle) {
        this.#database.prepare(
          `UPDATE practice_sessions
           SET record_title = NULL, record_title_source = NULL
           WHERE id = ? AND record_title_source = 'first_final'`,
        ).run(session.id);
      }
      for (const tombstone of options.tombstoneAttempts ?? []) {
        this.#database.prepare(
          `INSERT INTO discarded_attempts (session_id, attempt_id, kind, discarded_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, attempt_id) DO NOTHING`,
        ).run(session.id, tombstone.attemptId, tombstone.kind, tombstone.discardedAt);
      }
    });
    return this.getSessionOrThrow(session.id);
  }

  listAttempts(sessionId: string): readonly Attempt[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM attempts
         WHERE session_id = ?
         ORDER BY CASE kind WHEN 'initial' THEN 0 ELSE 1 END`,
      )
      .all(sessionId) as unknown as AttemptRow[];
    return rows.map((row) => this.#mapAttempt(row));
  }

  getAttempt(sessionId: string, kind: AttemptKind): Attempt | null {
    const row = this.#database
      .prepare('SELECT * FROM attempts WHERE session_id = ? AND kind = ?')
      .get(sessionId, kind) as unknown as AttemptRow | undefined;
    return row ? this.#mapAttempt(row) : null;
  }

  isAttemptDiscarded(sessionId: string, attemptId: string): boolean {
    return this.#database.prepare(
      'SELECT 1 FROM discarded_attempts WHERE session_id = ? AND attempt_id = ?',
    ).get(sessionId, attemptId) !== undefined;
  }

  /** Atomically swaps the current attempt for a slot and returns the replaced row. */
  replaceAttempt(attemptInput: Attempt): Attempt | null {
    const attempt = AttemptSchema.parse(attemptInput);
    return this.#transaction(() => {
      const previous = this.getAttempt(attempt.sessionId, attempt.kind);
      this.#database
        .prepare(
          `INSERT INTO attempts (
            id, session_id, kind, status, audio_ref, mime_type, duration_ms,
            byte_length, created_at, updated_at, confirmed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, kind) DO UPDATE SET
            id = excluded.id,
            status = excluded.status,
            audio_ref = excluded.audio_ref,
            mime_type = excluded.mime_type,
            duration_ms = excluded.duration_ms,
            byte_length = excluded.byte_length,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            confirmed_at = excluded.confirmed_at`,
        )
        .run(...this.#attemptValues(attempt));
      return previous;
    });
  }

  deleteAttempt(sessionId: string, kind: AttemptKind): Attempt | null {
    return this.#transaction(() => {
      const previous = this.getAttempt(sessionId, kind);
      if (previous) {
        this.#database
          .prepare('DELETE FROM attempts WHERE session_id = ? AND kind = ?')
          .run(sessionId, kind);
      }
      return previous;
    });
  }

  clearSessionAudioReferences(sessionId: string, updatedAt: string): void {
    this.#database
      .prepare(
        `UPDATE attempts
         SET audio_ref = NULL, updated_at = ?
         WHERE session_id = ? AND audio_ref IS NOT NULL`,
      )
      .run(updatedAt, sessionId);
    this.#hardenStoragePermissions();
  }

  clearAudioReference(audioRef: string, updatedAt: string): string | null {
    return this.#transaction(() => {
      const row = this.#database
        .prepare('SELECT session_id FROM attempts WHERE audio_ref = ?')
        .get(audioRef) as unknown as { session_id: string } | undefined;
      if (!row) {
        return null;
      }
      this.#database
        .prepare('UPDATE attempts SET audio_ref = NULL, updated_at = ? WHERE audio_ref = ?')
        .run(updatedAt, audioRef);
      this.#hardenStoragePermissions();
      return row.session_id;
    });
  }

  deleteSession(sessionId: string): boolean {
    const result = this.#database
      .prepare('DELETE FROM practice_sessions WHERE id = ?')
      .run(sessionId);
    this.#hardenStoragePermissions();
    return result.changes === 1;
  }

  countSessions(): number {
    const row = this.#database
      .prepare('SELECT COUNT(*) AS count FROM practice_sessions')
      .get() as unknown as { count: number };
    return row.count;
  }

  /** Deletes the complete training graph while preserving app settings. */
  deleteAllTrainingData(): number {
    return this.#transaction(() => {
      const deletedSessionCount = this.countSessions();
      this.#database.prepare('DELETE FROM practice_sessions').run();
      return deletedSessionCount;
    });
  }

  countAttemptsForSession(sessionId: string): number {
    const row = this.#database
      .prepare('SELECT COUNT(*) AS count FROM attempts WHERE session_id = ?')
      .get(sessionId) as unknown as { count: number };
    return row.count;
  }

  putArtifact(
    artifactInput: PracticeArtifact,
    options: PutArtifactOptions = {},
  ): PracticeArtifact {
    const artifact = PracticeArtifactSchema.parse(artifactInput);
    this.#transaction(() => {
      if (
        artifact.type === 'attempt_snapshot'
        && this.isAttemptDiscarded(artifact.sessionId, artifact.payload.attemptId)
      ) {
        throw new SessionRepositoryError(
          'ATTEMPT_DISCARDED',
          'A discarded attempt cannot reintroduce a frozen snapshot.',
        );
      }
      const result = this.#database.prepare(
        `INSERT INTO practice_artifacts (id, session_id, artifact_type, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json,
           artifact_type = excluded.artifact_type, updated_at = excluded.updated_at
         WHERE practice_artifacts.session_id = excluded.session_id`,
      ).run(artifact.id, artifact.sessionId, artifact.type, JSON.stringify(artifact.payload), new Date().toISOString());
      if (result.changes !== 1) {
        throw new SessionRepositoryError(
          'ARTIFACT_ID_CONFLICT',
          'Artifact ids cannot be reused across practice sessions.',
        );
      }
      if (options.defaultRecordTitle) {
        this.#database.prepare(
          `UPDATE practice_sessions
           SET record_title = ?, record_title_source = 'first_final'
           WHERE id = ? AND (record_title_source IS NULL OR record_title_source = 'first_final')`,
        ).run(options.defaultRecordTitle, artifact.sessionId);
      }
    });
    return artifact;
  }

  renameSessionRecord(sessionId: string, title: string): PracticeSession {
    const result = this.#database
      .prepare("UPDATE practice_sessions SET record_title = ?, record_title_source = 'user' WHERE id = ?")
      .run(title, sessionId);
    if (result.changes !== 1) {
      throw new SessionRepositoryError('SESSION_NOT_FOUND', 'Practice session was not found.');
    }
    this.#hardenStoragePermissions();
    return this.getSessionOrThrow(sessionId);
  }

  setSessionPinned(sessionId: string, pinnedAt: string | null): PracticeSession {
    const result = this.#database
      .prepare('UPDATE practice_sessions SET pinned_at = ? WHERE id = ?')
      .run(pinnedAt, sessionId);
    if (result.changes !== 1) {
      throw new SessionRepositoryError('SESSION_NOT_FOUND', 'Practice session was not found.');
    }
    this.#hardenStoragePermissions();
    return this.getSessionOrThrow(sessionId);
  }

  listArtifacts(sessionId: string): readonly PracticeArtifact[] {
    const rows = this.#database.prepare(
      'SELECT id, session_id, artifact_type, payload_json FROM practice_artifacts WHERE session_id = ? ORDER BY updated_at, id',
    ).all(sessionId) as unknown as Array<{ id: string; session_id: string; artifact_type: PracticeArtifact['type']; payload_json: string }>;
    return rows.map((row) => PracticeArtifactSchema.parse({
      id: row.id, sessionId: row.session_id, type: row.artifact_type, payload: JSON.parse(row.payload_json),
    }));
  }

  getSettings(): AppSettings {
    const row = this.#database
      .prepare('SELECT payload_json FROM app_settings WHERE singleton_id = 1')
      .get() as unknown as { payload_json: string } | undefined;
    if (!row) {
      return AppSettingsSchema.parse(DEFAULT_APP_SETTINGS);
    }
    const stored = JSON.parse(row.payload_json) as Record<string, unknown>;
    return AppSettingsSchema.parse({
      favoriteTaskIds: [],
      cloudAi: DEFAULT_APP_SETTINGS.cloudAi,
      ...stored,
    });
  }

  updateSettings(settingsInput: AppSettings): AppSettings {
    const settings = AppSettingsSchema.parse(settingsInput);
    this.#database
      .prepare(
        `INSERT INTO app_settings (singleton_id, payload_json)
         VALUES (1, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET payload_json = excluded.payload_json`,
      )
      .run(JSON.stringify(settings));
    this.#hardenStoragePermissions();
    return this.getSettings();
  }

  #migrate(): void {
    const version = this.#database.prepare('PRAGMA user_version').get() as unknown as {
      user_version: number;
    };
    const sessionColumns = this.#database
      .prepare('PRAGMA table_info(practice_sessions)')
      .all() as unknown as readonly { readonly name: string }[];
    const addDiagnosisReportColumn = sessionColumns.some(
      (column) => column.name === 'diagnosis_report_id',
    )
      ? ''
      : 'ALTER TABLE practice_sessions ADD COLUMN diagnosis_report_id TEXT;';
    const addComparisonArtifactColumn = sessionColumns.some(
      (column) => column.name === 'comparison_artifact_id',
    )
      ? ''
      : 'ALTER TABLE practice_sessions ADD COLUMN comparison_artifact_id TEXT;';
    const addRecordTitleColumn = sessionColumns.some(
      (column) => column.name === 'record_title',
    )
      ? ''
      : 'ALTER TABLE practice_sessions ADD COLUMN record_title TEXT;';
    const addPinnedAtColumn = sessionColumns.some(
      (column) => column.name === 'pinned_at',
    )
      ? ''
      : 'ALTER TABLE practice_sessions ADD COLUMN pinned_at TEXT;';
    const addRecordTitleSourceColumn = sessionColumns.some(
      (column) => column.name === 'record_title_source',
    )
      ? ''
      : 'ALTER TABLE practice_sessions ADD COLUMN record_title_source TEXT;';
    if (version.user_version > 8) {
      throw new SessionRepositoryError(
        'UNSUPPORTED_DATABASE_VERSION',
        'The local database was created by a newer version of Phrio.',
      );
    }
    if (version.user_version === 8) {
      this.#ensureDiscardedAttemptsTable();
      this.#ensureRecordHistoryIndex();
      this.#backfillRecordTitles();
      return;
    }

    const finishRecordMetadataMigration = () => {
      this.#ensureDiscardedAttemptsTable();
      this.#ensureRecordHistoryIndex();
      this.#backfillRecordTitles();
    };

    if (version.user_version === 7) {
      this.#transaction(() => {
        this.#database.exec(`
          ${addRecordTitleColumn}
          ${addRecordTitleSourceColumn}
          ${addPinnedAtColumn}
          PRAGMA user_version = 8;
        `);
      });
      finishRecordMetadataMigration();
      return;
    }

    if (version.user_version === 6) {
      this.#transaction(() => {
        this.#database.exec(`
          ${addDiagnosisReportColumn}
          ${addComparisonArtifactColumn}
          ${addRecordTitleColumn}
          ${addRecordTitleSourceColumn}
          ${addPinnedAtColumn}
          PRAGMA user_version = 8;
        `);
      });
      finishRecordMetadataMigration();
      return;
    }

    if (version.user_version === 5) {
      this.#transaction(() => {
        this.#database.exec(`
          ${addDiagnosisReportColumn}
          ${addComparisonArtifactColumn}
          ${addRecordTitleColumn}
          ${addRecordTitleSourceColumn}
          ${addPinnedAtColumn}
          PRAGMA user_version = 8;
        `);
      });
      finishRecordMetadataMigration();
      return;
    }

    if (version.user_version === 4) {
      this.#transaction(() => {
        this.#database.exec(`
          DROP INDEX practice_artifacts_session_index;
          ALTER TABLE practice_artifacts RENAME TO practice_artifacts_v4;
          CREATE TABLE practice_artifacts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
            artifact_type TEXT NOT NULL CHECK (artifact_type IN (
              'attempt_snapshot', 'transcript_correction', 'deep_report',
              'cloud_deep_diagnosis', 'cloud_semantic_comparison',
              'drill_completion', 'attempt_comparison'
            )),
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          INSERT INTO practice_artifacts (id, session_id, artifact_type, payload_json, updated_at)
            SELECT id, session_id, artifact_type, payload_json, updated_at
            FROM practice_artifacts_v4;
          DROP TABLE practice_artifacts_v4;
          CREATE INDEX practice_artifacts_session_index ON practice_artifacts(session_id, artifact_type);
          ${addDiagnosisReportColumn}
          ${addComparisonArtifactColumn}
          ${addRecordTitleColumn}
          ${addRecordTitleSourceColumn}
          ${addPinnedAtColumn}
          PRAGMA user_version = 8;
        `);
      });
      finishRecordMetadataMigration();
      return;
    }

    if (version.user_version === 3) {
      this.#transaction(() => {
        this.#database.exec(`
          DROP INDEX practice_artifacts_session_index;
          ALTER TABLE practice_artifacts RENAME TO practice_artifacts_v3;
          CREATE TABLE practice_artifacts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
            artifact_type TEXT NOT NULL CHECK (artifact_type IN (
              'attempt_snapshot', 'transcript_correction', 'deep_report',
              'cloud_deep_diagnosis', 'cloud_semantic_comparison',
              'drill_completion', 'attempt_comparison'
            )),
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          INSERT INTO practice_artifacts (id, session_id, artifact_type, payload_json, updated_at)
            SELECT id, session_id, artifact_type, payload_json, updated_at
            FROM practice_artifacts_v3;
          DROP TABLE practice_artifacts_v3;
          CREATE INDEX practice_artifacts_session_index ON practice_artifacts(session_id, artifact_type);
          ${addDiagnosisReportColumn}
          ${addComparisonArtifactColumn}
          ${addRecordTitleColumn}
          ${addRecordTitleSourceColumn}
          ${addPinnedAtColumn}
          PRAGMA user_version = 8;
        `);
      });
      finishRecordMetadataMigration();
      return;
    }

    if (version.user_version === 2) {
      this.#transaction(() => {
        this.#database.exec(`
          DROP INDEX practice_artifacts_session_index;
          ALTER TABLE practice_artifacts RENAME TO practice_artifacts_v2;
          CREATE TABLE practice_artifacts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
            artifact_type TEXT NOT NULL CHECK (artifact_type IN (
              'attempt_snapshot', 'transcript_correction', 'deep_report',
              'cloud_deep_diagnosis', 'cloud_semantic_comparison',
              'drill_completion', 'attempt_comparison'
            )),
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          INSERT INTO practice_artifacts (id, session_id, artifact_type, payload_json, updated_at)
            SELECT id, session_id, artifact_type, payload_json, updated_at
            FROM practice_artifacts_v2;
          DROP TABLE practice_artifacts_v2;
          CREATE INDEX practice_artifacts_session_index ON practice_artifacts(session_id, artifact_type);
          ${addDiagnosisReportColumn}
          ${addComparisonArtifactColumn}
          ${addRecordTitleColumn}
          ${addRecordTitleSourceColumn}
          ${addPinnedAtColumn}
          PRAGMA user_version = 8;
        `);
      });
      finishRecordMetadataMigration();
      return;
    }

    if (version.user_version === 1) {
      this.#transaction(() => {
        this.#database.exec(`
          CREATE TABLE practice_artifacts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
            artifact_type TEXT NOT NULL CHECK (artifact_type IN (
              'attempt_snapshot', 'transcript_correction', 'deep_report',
              'cloud_deep_diagnosis', 'cloud_semantic_comparison',
              'drill_completion', 'attempt_comparison'
            )),
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX practice_artifacts_session_index ON practice_artifacts(session_id, artifact_type);
          ${addDiagnosisReportColumn}
          ${addComparisonArtifactColumn}
          ${addRecordTitleColumn}
          ${addRecordTitleSourceColumn}
          ${addPinnedAtColumn}
          PRAGMA user_version = 8;
        `);
      });
      finishRecordMetadataMigration();
      return;
    }

    this.#transaction(() => {
      this.#database.exec(`
        CREATE TABLE practice_sessions (
          id TEXT PRIMARY KEY,
          mode_id TEXT NOT NULL,
          mode_version TEXT NOT NULL,
          task_id TEXT NOT NULL,
          task_version TEXT NOT NULL,
          task_snapshot_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'setup', 'first_attempt', 'transcript_review', 'diagnosis', 'focus',
            'drill', 'second_attempt', 'comparison', 'completed', 'abandoned'
          )),
          outcome TEXT CHECK (outcome IS NULL OR outcome IN (
            'analysis_only', 'free_retry_completed', 'practice_loop_completed',
            'practice_loop_abandoned'
          )),
          guidance_source TEXT CHECK (guidance_source IS NULL OR guidance_source IN (
            'ai_evidence', 'local_metric', 'self_directed'
          )),
          focus_json TEXT,
          diagnosis_report_id TEXT,
          comparison_artifact_id TEXT,
          record_title TEXT,
          record_title_source TEXT,
          pinned_at TEXT,
          drill_completed_at TEXT,
          comparison_viewed_at TEXT,
          development_fixture INTEGER NOT NULL CHECK (development_fixture IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE attempts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('initial', 'retry')),
          status TEXT NOT NULL CHECK (status IN ('recorded', 'confirmed', 'interrupted')),
          audio_ref TEXT,
          mime_type TEXT NOT NULL,
          duration_ms INTEGER NOT NULL CHECK (duration_ms > 0 AND duration_ms <= 300000),
          byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 67108864),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          confirmed_at TEXT,
          UNIQUE (session_id, kind)
        ) STRICT;

        CREATE INDEX attempts_session_id_index ON attempts(session_id);
        CREATE UNIQUE INDEX attempts_audio_ref_index
          ON attempts(audio_ref) WHERE audio_ref IS NOT NULL;

        CREATE TABLE discarded_attempts (
          session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
          attempt_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('initial', 'retry')),
          discarded_at TEXT NOT NULL,
          PRIMARY KEY (session_id, attempt_id)
        ) STRICT;

        CREATE TABLE app_settings (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          payload_json TEXT NOT NULL
        ) STRICT;

        CREATE TABLE practice_artifacts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
          artifact_type TEXT NOT NULL CHECK (artifact_type IN (
            'attempt_snapshot', 'transcript_correction', 'deep_report',
            'cloud_deep_diagnosis', 'cloud_semantic_comparison',
            'drill_completion', 'attempt_comparison'
          )),
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX practice_artifacts_session_index ON practice_artifacts(session_id, artifact_type);

        PRAGMA user_version = 8;
      `);
    });
    finishRecordMetadataMigration();
  }

  #ensureDiscardedAttemptsTable(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS discarded_attempts (
        session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('initial', 'retry')),
        discarded_at TEXT NOT NULL,
        PRIMARY KEY (session_id, attempt_id)
      ) STRICT;
    `);
  }

  #backfillRecordTitles(): void {
    const rows = this.#database.prepare(
      `SELECT artifacts.session_id, artifacts.payload_json
       FROM practice_artifacts AS artifacts
       INNER JOIN practice_sessions AS sessions ON sessions.id = artifacts.session_id
       WHERE artifacts.artifact_type = 'attempt_snapshot'
         AND sessions.record_title IS NULL
       ORDER BY artifacts.updated_at, artifacts.id`,
    ).all() as unknown as readonly { readonly session_id: string; readonly payload_json: string }[];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.session_id)) continue;
      try {
        const payload = JSON.parse(row.payload_json) as {
          readonly kind?: unknown;
          readonly finalSegments?: unknown;
        };
        if (payload.kind !== 'initial' || !Array.isArray(payload.finalSegments)) continue;
        const finalSegments = payload.finalSegments.flatMap((candidate) => {
          if (!candidate || typeof candidate !== 'object') return [];
          const segment = candidate as { readonly text?: unknown; readonly sequence?: unknown };
          return typeof segment.text === 'string' && Number.isInteger(segment.sequence)
            ? [{ text: segment.text, sequence: segment.sequence as number }]
            : [];
        });
        const title = derivePracticeRecordTitle(finalSegments);
        if (!title) continue;
        this.#database.prepare(
          `UPDATE practice_sessions SET record_title = ?, record_title_source = 'first_final'
           WHERE id = ? AND record_title IS NULL`,
        ).run(title, row.session_id);
        seen.add(row.session_id);
      } catch {
        // A legacy malformed artifact remains inspectable; it must not block DB startup.
      }
    }
    this.#hardenStoragePermissions();
  }

  #ensureRecordHistoryIndex(): void {
    this.#database.exec(
      `CREATE INDEX IF NOT EXISTS practice_sessions_history_index
       ON practice_sessions(pinned_at DESC, updated_at DESC, id DESC)`,
    );
    this.#hardenStoragePermissions();
  }

  #mapSession(row: SessionRow, attempts: readonly Attempt[]): PracticeSession {
    return PracticeSessionSchema.parse({
      id: row.id,
      modeId: row.mode_id,
      modeVersion: row.mode_version,
      taskId: row.task_id,
      taskVersion: row.task_version,
      taskSnapshot: JSON.parse(row.task_snapshot_json),
      status: row.status,
      outcome: row.outcome,
      guidanceSource: row.guidance_source,
      focus: row.focus_json ? JSON.parse(row.focus_json) : null,
      diagnosisReportId: row.diagnosis_report_id ?? null,
      comparisonArtifactId: row.comparison_artifact_id ?? null,
      recordTitle: row.record_title ?? null,
      recordTitleSource: row.record_title_source ?? null,
      pinnedAt: row.pinned_at ?? null,
      drillCompletedAt: row.drill_completed_at,
      comparisonViewedAt: row.comparison_viewed_at,
      developmentFixture: row.development_fixture === 1,
      attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #mapAttempt(row: AttemptRow): Attempt {
    return AttemptSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      status: row.status,
      audioRef: row.audio_ref,
      mimeType: row.mime_type,
      durationMs: row.duration_ms,
      byteLength: row.byte_length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      confirmedAt: row.confirmed_at,
    });
  }

  #insertAttempt(attempt: Attempt): void {
    this.#database
      .prepare(
        `INSERT INTO attempts (
          id, session_id, kind, status, audio_ref, mime_type, duration_ms,
          byte_length, created_at, updated_at, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...this.#attemptValues(attempt));
  }

  #upsertAttempt(attempt: Attempt): void {
    this.#database
      .prepare(
        `INSERT INTO attempts (
          id, session_id, kind, status, audio_ref, mime_type, duration_ms,
          byte_length, created_at, updated_at, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, kind) DO UPDATE SET
          id = excluded.id,
          status = excluded.status,
          audio_ref = excluded.audio_ref,
          mime_type = excluded.mime_type,
          duration_ms = excluded.duration_ms,
          byte_length = excluded.byte_length,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          confirmed_at = excluded.confirmed_at`,
      )
      .run(...this.#attemptValues(attempt));
  }

  #sessionValues(session: PracticeSession): SQLInputValue[] {
    return [
      session.id,
      session.modeId,
      session.modeVersion,
      session.taskId,
      session.taskVersion,
      JSON.stringify(session.taskSnapshot),
      session.status,
      session.outcome,
      session.guidanceSource,
      session.focus ? JSON.stringify(session.focus) : null,
      session.diagnosisReportId,
      session.comparisonArtifactId,
      session.recordTitle,
      session.recordTitleSource,
      session.pinnedAt,
      session.drillCompletedAt,
      session.comparisonViewedAt,
      session.developmentFixture ? 1 : 0,
      session.createdAt,
      session.updatedAt,
    ];
  }

  #attemptValues(attempt: Attempt): SQLInputValue[] {
    return [
      attempt.id,
      attempt.sessionId,
      attempt.kind,
      attempt.status,
      attempt.audioRef,
      attempt.mimeType,
      attempt.durationMs,
      attempt.byteLength,
      attempt.createdAt,
      attempt.updatedAt,
      attempt.confirmedAt,
    ];
  }

  #updateSessionRows(session: PracticeSession): void {
    const result = this.#database
      .prepare(
        `UPDATE practice_sessions SET
          mode_id = ?, mode_version = ?, task_id = ?, task_version = ?,
          task_snapshot_json = ?, status = ?, outcome = ?, guidance_source = ?,
          focus_json = ?, diagnosis_report_id = ?, comparison_artifact_id = ?,
          drill_completed_at = ?, comparison_viewed_at = ?, development_fixture = ?,
          created_at = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        session.modeId,
        session.modeVersion,
        session.taskId,
        session.taskVersion,
        JSON.stringify(session.taskSnapshot),
        session.status,
        session.outcome,
        session.guidanceSource,
        session.focus ? JSON.stringify(session.focus) : null,
        session.diagnosisReportId,
        session.comparisonArtifactId,
        session.drillCompletedAt,
        session.comparisonViewedAt,
        session.developmentFixture ? 1 : 0,
        session.createdAt,
        session.updatedAt,
        session.id,
      );
    if (result.changes !== 1) {
      throw new SessionRepositoryError('SESSION_NOT_FOUND', 'Practice session was not found.');
    }

    const kinds = new Set(session.attempts.map((attempt) => attempt.kind));
    if (!kinds.has('initial')) {
      this.#database
        .prepare("DELETE FROM attempts WHERE session_id = ? AND kind = 'initial'")
        .run(session.id);
    }
    if (!kinds.has('retry')) {
      this.#database
        .prepare("DELETE FROM attempts WHERE session_id = ? AND kind = 'retry'")
        .run(session.id);
    }
    for (const attempt of session.attempts) {
      this.#upsertAttempt(attempt);
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = operation();
      this.#database.exec('COMMIT');
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // COMMIT failures can leave no active transaction; preserve the original error.
      }
      this.#hardenStoragePermissions();
      throw error;
    }
    this.#hardenStoragePermissions();
    return result;
  }

  #hardenStoragePermissions(): void {
    if (this.#readOnly || !this.#databasePath || !this.#databaseDirectory) {
      return;
    }
    chmodSync(this.#databaseDirectory, 0o700);
    for (const filePath of [
      this.#databasePath,
      `${this.#databasePath}-wal`,
      `${this.#databasePath}-shm`,
    ]) {
      if (existsSync(filePath)) {
        chmodSync(filePath, 0o600);
      }
    }
  }
}

export class SessionRepositoryError extends Error {
  constructor(
    readonly code:
      | 'SESSION_NOT_FOUND'
      | 'UNSUPPORTED_DATABASE_VERSION'
      | 'ARTIFACT_ID_CONFLICT'
      | 'ATTEMPT_DISCARDED',
    message: string,
  ) {
    super(message);
    this.name = 'SessionRepositoryError';
  }
}
