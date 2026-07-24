import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  CloudAiConsentSchema,
  CloudAiRequestMetadataSchema,
  ExactAiPayloadSchema,
  type CloudAiConsent,
  type CloudAiRequestMetadata,
  type CloudAiPurpose,
  type ExactAiPayload,
} from '../../shared';

interface JsonRow { readonly payload_json: string }
interface AuditIdentityRow extends JsonRow {
  readonly id: string;
  readonly session_id?: string | null;
}

export interface StoredAnalysisInput {
  readonly id: string;
  readonly sessionId: string | null;
  readonly purpose: CloudAiPurpose;
  readonly payloadHash: string;
  readonly payload: ExactAiPayload;
  readonly consentId: string;
  readonly approvedAt: string;
}

/** Persists consent/audit metadata and approved payload snapshots, never API keys or audio. */
export class CloudAiRepository {
  readonly #database: DatabaseSync;
  readonly #databasePath: string | null;

  constructor(databasePath: string) {
    this.#databasePath = databasePath === ':memory:' ? null : path.resolve(databasePath);
    if (this.#databasePath) {
      const directory = path.dirname(this.#databasePath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.#database = new DatabaseSync(this.#databasePath ?? ':memory:', {
      enableForeignKeyConstraints: true,
    });
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.#database.exec('PRAGMA trusted_schema = OFF');
    this.#database.exec('PRAGMA journal_mode = WAL');
    this.#database.exec('PRAGMA synchronous = FULL');
    this.#migrate();
    this.#harden();
  }

  close(): void {
    this.#harden();
    this.#database.close();
    this.#harden();
  }

  putConsent(input: CloudAiConsent): CloudAiConsent {
    const consent = CloudAiConsentSchema.parse(input);
    this.#database.prepare(
      `INSERT INTO ai_consents (id, purpose, scope, session_id, payload_json, approved_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         payload_json = excluded.payload_json,
         revoked_at = excluded.revoked_at`,
    ).run(
      consent.id,
      consent.purpose,
      consent.scope,
      consent.sessionId,
      JSON.stringify(consent),
      consent.approvedAt,
      consent.revokedAt,
    );
    this.#harden();
    return this.getConsent(consent.id)!;
  }

  getConsent(id: string): CloudAiConsent | null {
    const row = this.#database.prepare('SELECT payload_json FROM ai_consents WHERE id = ?').get(id) as unknown as JsonRow | undefined;
    return row ? CloudAiConsentSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  listConsents(purpose?: CloudAiPurpose): readonly CloudAiConsent[] {
    const rows = (purpose
      ? this.#database.prepare('SELECT payload_json FROM ai_consents WHERE purpose = ? ORDER BY approved_at DESC').all(purpose)
      : this.#database.prepare('SELECT payload_json FROM ai_consents ORDER BY approved_at DESC').all()
    ) as unknown as JsonRow[];
    return rows.map((row) => CloudAiConsentSchema.parse(JSON.parse(row.payload_json)));
  }

  revokeConsent(id: string, revokedAt: string): CloudAiConsent {
    const current = this.getConsent(id);
    if (!current) throw new CloudAiRepositoryError('CONSENT_NOT_FOUND');
    return this.putConsent({ ...current, revokedAt });
  }

  putAnalysisInput(input: StoredAnalysisInput): StoredAnalysisInput {
    const payload = ExactAiPayloadSchema.parse(input.payload);
    this.#database.prepare(
      `INSERT INTO analysis_inputs (
        id, session_id, purpose, payload_hash, payload_json, consent_id, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`,
    ).run(
      input.id,
      input.sessionId,
      input.purpose,
      input.payloadHash,
      JSON.stringify(payload),
      input.consentId,
      input.approvedAt,
    );
    this.#harden();
    return { ...input, payload };
  }

  putRequest(input: CloudAiRequestMetadata): CloudAiRequestMetadata {
    const metadata = CloudAiRequestMetadataSchema.parse(input);
    this.#database.prepare(
      `INSERT INTO cloud_requests (id, purpose, status, payload_json, requested_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         payload_json = excluded.payload_json,
         completed_at = excluded.completed_at`,
    ).run(
      metadata.id,
      metadata.purpose,
      metadata.status,
      JSON.stringify(metadata),
      metadata.requestedAt,
      metadata.completedAt,
    );
    this.#harden();
    return this.getRequest(metadata.id)!;
  }

  getRequest(id: string): CloudAiRequestMetadata | null {
    const row = this.#database.prepare('SELECT payload_json FROM cloud_requests WHERE id = ?').get(id) as unknown as JsonRow | undefined;
    return row ? CloudAiRequestMetadataSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  listRequests(): readonly CloudAiRequestMetadata[] {
    const rows = this.#database.prepare('SELECT payload_json FROM cloud_requests ORDER BY requested_at DESC').all() as unknown as JsonRow[];
    return rows.map((row) => CloudAiRequestMetadataSchema.parse(JSON.parse(row.payload_json)));
  }

  deleteTrainingAuditData(): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.exec('DELETE FROM cloud_requests; DELETE FROM analysis_inputs;');
      this.#database.exec(`DELETE FROM ai_consents WHERE scope = 'payload' OR session_id IS NOT NULL;`);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    this.#harden();
  }

  /** Deletes only the cloud payload/audit graph derived from one local Session. */
  deleteSessionAuditData(sessionId: string, attemptIds: readonly string[]): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const attemptIdSet = new Set(attemptIds);
      const analysisRows = this.#database.prepare(
        'SELECT id, session_id, payload_json FROM analysis_inputs',
      ).all() as unknown as AuditIdentityRow[];
      const analysisIds = analysisRows
        .filter((row) => row.session_id === sessionId || auditJsonMatches(
          row.payload_json,
          sessionId,
          attemptIdSet,
        ))
        .map((row) => row.id);
      const requestRows = this.#database.prepare(
        'SELECT id, payload_json FROM cloud_requests',
      ).all() as unknown as AuditIdentityRow[];
      const requestIds = requestRows
        .filter((row) => auditJsonMatches(row.payload_json, sessionId, attemptIdSet))
        .map((row) => row.id);
      const deleteRequest = this.#database.prepare('DELETE FROM cloud_requests WHERE id = ?');
      const deleteAnalysis = this.#database.prepare('DELETE FROM analysis_inputs WHERE id = ?');
      for (const id of requestIds) deleteRequest.run(id);
      for (const id of analysisIds) deleteAnalysis.run(id);
      this.#database.prepare('DELETE FROM ai_consents WHERE session_id = ?').run(sessionId);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    this.#harden();
  }

  resetConsentData(): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.exec('DELETE FROM cloud_requests; DELETE FROM analysis_inputs; DELETE FROM ai_consents;');
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    this.#harden();
  }

  #migrate(): void {
    const version = this.#database.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
    if (version.user_version > 1) throw new CloudAiRepositoryError('UNSUPPORTED_DATABASE_VERSION');
    if (version.user_version === 1) return;
    this.#database.exec(`
      CREATE TABLE ai_consents (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL CHECK (purpose IN ('live_hint', 'deep_diagnosis', 'comparison')),
        scope TEXT NOT NULL CHECK (scope IN ('configuration', 'payload')),
        session_id TEXT,
        payload_json TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE TABLE analysis_inputs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        purpose TEXT NOT NULL CHECK (purpose IN ('live_hint', 'deep_diagnosis', 'comparison')),
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        consent_id TEXT NOT NULL REFERENCES ai_consents(id),
        approved_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX analysis_inputs_session_index ON analysis_inputs(session_id, purpose);
      CREATE TABLE cloud_requests (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL CHECK (purpose IN ('live_hint', 'deep_diagnosis', 'comparison')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'discarded')),
        payload_json TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
      CREATE INDEX cloud_requests_status_index ON cloud_requests(status, requested_at);
      PRAGMA user_version = 1;
    `);
  }

  #harden(): void {
    if (!this.#databasePath) return;
    for (const candidate of [this.#databasePath, `${this.#databasePath}-wal`, `${this.#databasePath}-shm`]) {
      try { chmodSync(candidate, 0o600); } catch { /* sidecars are optional */ }
    }
  }
}

function auditJsonMatches(
  payloadJson: string,
  sessionId: string,
  attemptIds: ReadonlySet<string>,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch {
    return false;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.sessionId === sessionId) return true;
  if (typeof record.attemptId === 'string' && attemptIds.has(record.attemptId)) return true;
  for (const key of ['initial', 'retry'] as const) {
    const attempt = record[key];
    if (
      attempt
      && typeof attempt === 'object'
      && !Array.isArray(attempt)
      && typeof (attempt as Record<string, unknown>).attemptId === 'string'
      && attemptIds.has((attempt as Record<string, unknown>).attemptId as string)
    ) {
      return true;
    }
  }
  return false;
}

export class CloudAiRepositoryError extends Error {
  constructor(readonly code: 'CONSENT_NOT_FOUND' | 'UNSUPPORTED_DATABASE_VERSION') {
    super(code);
    this.name = 'CloudAiRepositoryError';
  }
}
