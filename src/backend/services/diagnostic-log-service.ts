import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ClearDiagnosticLogsOutputSchema,
  DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  DIAGNOSTIC_MAX_FILE_BYTES,
  DIAGNOSTIC_MAX_BUFFERED_EVENTS,
  DIAGNOSTIC_MAX_TOTAL_BYTES,
  DIAGNOSTIC_RETENTION_DAYS,
  DIAGNOSTIC_SCHEMA_VERSION,
  DiagnosticBundleSchema,
  DiagnosticEventSchema,
  DiagnosticStatusSchema,
  ExportDiagnosticBundleOutputSchema,
  RecordDiagnosticEventInputSchema,
  RecordDiagnosticEventOutputSchema,
  type ClearDiagnosticLogsOutput,
  type DiagnosticBundle,
  type DiagnosticComponent,
  type DiagnosticEvent,
  type DiagnosticFieldValue,
  type DiagnosticLevel,
  type DiagnosticStatus,
  type ExportDiagnosticBundleOutput,
  type RecordDiagnosticEventInput,
  type RecordDiagnosticEventOutput,
} from '../../shared/diagnostics';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LOG_FILE_PREFIX = 'phrio-diagnostic-';
const LOG_FILE_SUFFIX = '.jsonl';
const RETENTION_MILLISECONDS = DIAGNOSTIC_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const MAINTENANCE_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;
const MAXIMUM_EVENTS_PER_FLUSH_TURN = 64;
const MAX_STACK_LINES = 5;
const MAX_STACK_CHARACTERS = 240;

const FORBIDDEN_FIELD_FRAGMENTS = Object.freeze([
  'audio',
  'pcm',
  'transcript',
  'partial',
  'payload',
  'authorization',
  'apikey',
  'prompt',
  'content',
]);

const FORBIDDEN_FIELD_NAMES = new Set([
  'body',
  'text',
  'finaltext',
  'request',
  'response',
  'requestbody',
  'responsebody',
  'requestcontent',
  'responsecontent',
]);

// Strings are the only flat field values capable of carrying arbitrary user
// or provider prose. Numeric/boolean metadata remains open by key, while
// strings use a deliberately small operational vocabulary.
const SAFE_STRING_FIELD_NAMES = new Set([
  'artifactType',
  'audioContextState',
  'blockerType',
  'channel',
  'componentStack',
  'errorCode',
  'errorFingerprint',
  'errorName',
  'errorStack',
  'fileName',
  'from',
  'lifecycleStatus',
  'mimeCategory',
  'modeId',
  'model',
  'modelVersion',
  'networkCode',
  'outcomeCode',
  'processType',
  'protocol',
  'provider',
  'permission',
  'purpose',
  'reason',
  'reasonCode',
  'requestPhase',
  'screen',
  'status',
  'signal',
  'source',
  'to',
  'track',
  'transport',
  'transitionType',
]);

// These are aggregate operational counters/states, never PCM samples or audio
// bytes. Retaining them is essential for distinguishing a dead worklet from a
// genuinely silent microphone while preserving the raw-content boundary.
const SAFE_AUDIO_DIAGNOSTIC_FIELD_NAMES = new Set([
  'audioContextState',
  'pcmCallbackCount',
  'pcmDurationMs',
  'pcmFrameCount',
  'pcmGapMs',
  'pcmInputFrames',
  'pcmOutputSamples',
]);

const FREEFORM_SANITIZED_STRING_FIELDS = new Set(['componentStack', 'errorStack']);

export interface DiagnosticLogServiceOptions {
  readonly appVersion: string;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly createId?: () => string;
  readonly platform?: string;
  readonly architecture?: string;
  readonly homeDirectory?: string;
  readonly writeChunk?: (
    descriptor: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => number;
  readonly unlinkFile?: (filePath: string) => void;
}

export interface DiagnosticLogClearFailureDetails {
  readonly deletedFileCount: number;
  readonly deletedBytes: number;
  readonly remainingFileCount: number | null;
  readonly remainingBytes: number | null;
}

export interface RecordDiagnosticErrorInput {
  readonly component: DiagnosticComponent;
  readonly event: string;
  readonly error: unknown;
  readonly level?: Extract<DiagnosticLevel, 'error' | 'fatal'>;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly sessionId?: string | null;
  readonly attemptId?: string | null;
  readonly operationId?: string | null;
  readonly requestId?: string | null;
}

interface DiagnosticLogFile {
  readonly filePath: string;
  readonly name: string;
  readonly size: number;
  readonly modifiedAtMs: number;
}

interface SafeErrorFields {
  readonly errorName: string;
  readonly errorCode: string;
  readonly errorStack: string;
  readonly errorFingerprint: string;
}

/**
 * The sole main-process writer for local operational diagnostics.
 *
 * Logging is deliberately fail-open for the product path: filesystem failures
 * never escape record/recordError. Unwritten events remain ordered in memory
 * and are retried by the next record or status/export operation.
 */
export class DiagnosticLogService {
  readonly #logDirectory: string;
  readonly #appVersion: string;
  readonly #now: () => Date;
  readonly #monotonicNow: () => number;
  readonly #createId: () => string;
  readonly #platform: string;
  readonly #architecture: string;
  readonly #homeDirectory: string;
  readonly #writeChunk: NonNullable<DiagnosticLogServiceOptions['writeChunk']>;
  readonly #unlinkFile: NonNullable<DiagnosticLogServiceOptions['unlinkFile']>;
  readonly #runId: string;
  readonly #buffer: DiagnosticEvent[] = [];
  #sequence = 0;
  #fileSequence = 0;
  #currentFilePath: string | null = null;
  #currentFileBytes = 0;
  #currentFileDateKey: string | null = null;
  #knownTotalBytes = 0;
  #writeFailureCount = 0;
  #droppedEventCount = 0;
  #latestIncidentId: string | null = null;
  #generation = 0;
  #nextMaintenanceAtMs = 0;
  #storageReady = false;
  #flushScheduled = false;

  constructor(logDirectory: string, options: DiagnosticLogServiceOptions) {
    this.#logDirectory = path.resolve(logDirectory);
    this.#appVersion = options.appVersion;
    this.#now = options.now ?? (() => new Date());
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#createId = options.createId ?? randomUUID;
    this.#platform = options.platform ?? process.platform;
    this.#architecture = options.architecture ?? process.arch;
    this.#homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
    this.#writeChunk = options.writeChunk ?? ((descriptor, buffer, offset, length) => (
      writeSync(descriptor, buffer, offset, length)
    ));
    this.#unlinkFile = options.unlinkFile ?? unlinkSync;
    this.#runId = safeIdentifier('run', this.#createId());

    this.#attemptStorageMaintenance();
  }

  get runId(): string {
    return this.#runId;
  }

  get generation(): number {
    return this.#generation;
  }

  record(input: RecordDiagnosticEventInput): RecordDiagnosticEventOutput {
    this.#attemptScheduledStorageMaintenance();
    const event = this.#createEvent(input);
    const accepted = this.#enqueue(event);
    if (accepted && event.incidentId) this.#latestIncidentId = event.incidentId;
    const writtenEventCount = this.#flushBufferedEvents();
    if (writtenEventCount > 0) this.#scheduleBufferedFlush();
    return RecordDiagnosticEventOutputSchema.parse({
      sequence: event.sequence,
      incidentId: event.incidentId,
    });
  }

  recordIfGeneration(
    generation: number,
    input: RecordDiagnosticEventInput,
  ): RecordDiagnosticEventOutput | null {
    if (generation !== this.#generation) return null;
    return this.record(input);
  }

  recordErrorIfGeneration(
    generation: number,
    input: RecordDiagnosticErrorInput,
  ): RecordDiagnosticEventOutput | null {
    if (generation !== this.#generation) return null;
    return this.recordError(input);
  }

  recordError(input: RecordDiagnosticErrorInput): RecordDiagnosticEventOutput {
    const errorFields = this.#safeErrorFields(input.error);
    return this.record({
      level: input.level ?? 'error',
      component: input.component,
      event: input.event,
      sessionId: input.sessionId ?? null,
      attemptId: input.attemptId ?? null,
      operationId: input.operationId ?? null,
      requestId: input.requestId ?? null,
      fields: {
        ...this.#sanitizeFields(input.fields),
        ...errorFields,
      },
    });
  }

  getStatus(): DiagnosticStatus {
    const writtenEventCount = this.#flushBufferedEvents();
    if (writtenEventCount > 0) this.#scheduleBufferedFlush();
    this.#attemptStorageMaintenance();
    const files = this.#safeListLogFiles();
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    this.#knownTotalBytes = totalBytes;
    return DiagnosticStatusSchema.parse({
      appVersion: this.#appVersion,
      currentRunId: this.#runId,
      logDirectory: this.#logDirectory,
      retentionDays: DIAGNOSTIC_RETENTION_DAYS,
      maximumTotalBytes: DIAGNOSTIC_MAX_TOTAL_BYTES,
      maximumBufferedEvents: DIAGNOSTIC_MAX_BUFFERED_EVENTS,
      fileCount: files.length,
      totalBytes,
      bufferedEventCount: this.#buffer.length,
      droppedEventCount: this.#droppedEventCount,
      writeFailureCount: this.#writeFailureCount,
      latestIncidentId: this.#latestIncidentId,
    });
  }

  clear(): ClearDiagnosticLogsOutput {
    this.#generation += 1;
    let deletedFileCount = 0;
    let deletedBytes = 0;
    let files: readonly DiagnosticLogFile[];
    try {
      files = this.#listLogFiles();
    } catch {
      this.#writeFailureCount += 1;
      this.#resetVolatileStateAfterClearAttempt();
      throw new DiagnosticLogClearError({
        deletedFileCount,
        deletedBytes,
        remainingFileCount: null,
        remainingBytes: null,
      });
    }

    let deletionFailed = false;
    for (const file of files) {
      try {
        this.#unlinkFile(file.filePath);
        deletedFileCount += 1;
        deletedBytes += file.size;
      } catch {
        this.#writeFailureCount += 1;
        deletionFailed = true;
      }
    }
    this.#resetVolatileStateAfterClearAttempt();

    let remainingFiles: readonly DiagnosticLogFile[];
    try {
      remainingFiles = this.#listLogFiles();
    } catch {
      this.#writeFailureCount += 1;
      this.#knownTotalBytes = Math.max(0, this.#knownTotalBytes - deletedBytes);
      throw new DiagnosticLogClearError({
        deletedFileCount,
        deletedBytes,
        remainingFileCount: null,
        remainingBytes: null,
      });
    }
    const remainingBytes = remainingFiles.reduce((total, file) => total + file.size, 0);
    this.#knownTotalBytes = remainingBytes;
    if (deletionFailed || remainingFiles.length > 0) {
      throw new DiagnosticLogClearError({
        deletedFileCount,
        deletedBytes,
        remainingFileCount: remainingFiles.length,
        remainingBytes,
      });
    }

    this.#latestIncidentId = null;
    this.#writeFailureCount = 0;
    this.#droppedEventCount = 0;
    return ClearDiagnosticLogsOutputSchema.parse({ deletedFileCount, deletedBytes });
  }

  exportBundle(destinationPath: string): ExportDiagnosticBundleOutput {
    const writtenEventCount = this.#flushBufferedEvents();
    if (writtenEventCount > 0) this.#scheduleBufferedFlush();
    this.#attemptStorageMaintenance();
    const files = [...this.#safeListLogFiles()].sort(compareLogFiles);
    const events: DiagnosticEvent[] = [];
    let corruptLineCount = 0;
    const retentionCutoff = this.#now().getTime() - RETENTION_MILLISECONDS;

    for (const file of files) {
      let raw: string;
      try {
        raw = readFileSync(file.filePath, 'utf8');
      } catch {
        corruptLineCount += 1;
        continue;
      }
      for (const line of raw.split(/\r?\n/u)) {
        if (line.trim() === '') continue;
        try {
          const parsed = DiagnosticEventSchema.safeParse(JSON.parse(line));
          if (
            parsed.success
            && Date.parse(parsed.data.occurredAt) >= retentionCutoff
          ) {
            events.push({
              ...parsed.data,
              fields: this.#sanitizeFields(parsed.data.fields),
            });
          }
          else corruptLineCount += 1;
        } catch {
          corruptLineCount += 1;
        }
      }
    }

    // A read-only or temporarily unavailable log directory must not make the
    // support bundle lose events which are still safely buffered in memory.
    events.push(...this.#buffer.map((event) => ({ ...event, fields: { ...event.fields } })));
    events.sort(compareEvents);

    const bundle: DiagnosticBundle = DiagnosticBundleSchema.parse({
      schemaVersion: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
      generatedAt: this.#now().toISOString(),
      app: {
        version: this.#appVersion,
        platform: this.#sanitizeString(this.#platform, 32),
        architecture: this.#sanitizeString(this.#architecture, 32),
      },
      retentionDays: DIAGNOSTIC_RETENTION_DAYS,
      maximumBufferedEvents: DIAGNOSTIC_MAX_BUFFERED_EVENTS,
      droppedEventCount: this.#droppedEventCount,
      sourceFileCount: files.length,
      corruptLineCount,
      events,
    });
    const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
    const resolvedDestination = path.resolve(destinationPath);
    const destinationDirectory = path.dirname(resolvedDestination);
    mkdirSync(destinationDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const temporaryPath = path.join(
      destinationDirectory,
      `.phrio-diagnostic-export-${safeIdentifier('temporary', this.#createId())}.tmp`,
    );
    try {
      writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' });
      chmodSync(temporaryPath, PRIVATE_FILE_MODE);
      renameSync(temporaryPath, resolvedDestination);
      chmodSync(resolvedDestination, PRIVATE_FILE_MODE);
    } finally {
      rmSync(temporaryPath, { force: true });
    }

    return ExportDiagnosticBundleOutputSchema.parse({
      cancelled: false,
      filePath: resolvedDestination,
      sourceFileCount: files.length,
      eventCount: events.length,
      byteLength: Buffer.byteLength(serialized, 'utf8'),
    });
  }

  #createEvent(input: RecordDiagnosticEventInput): DiagnosticEvent {
    const sequence = this.#sequence;
    this.#sequence += 1;
    let parsed: ReturnType<typeof RecordDiagnosticEventInputSchema.parse>;
    try {
      parsed = RecordDiagnosticEventInputSchema.parse({
        ...input,
        fields: this.#sanitizeFields(
          (input as { readonly fields?: Readonly<Record<string, unknown>> }).fields,
        ),
      });
    } catch {
      parsed = RecordDiagnosticEventInputSchema.parse({
        level: 'error',
        component: 'diagnostics',
        event: 'diagnostics.invalid-event',
        fields: { rejected: true },
      });
    }
    const incidentId = parsed.level === 'error' || parsed.level === 'fatal'
      ? safeIdentifier('incident', this.#createId())
      : null;
    return DiagnosticEventSchema.parse({
      ...parsed,
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      sequence,
      occurredAt: this.#now().toISOString(),
      monotonicMs: finiteNonnegative(this.#monotonicNow()),
      runId: this.#runId,
      incidentId,
    });
  }

  #sanitizeFields(fields: Readonly<Record<string, unknown>> | undefined): Record<string, DiagnosticFieldValue> {
    if (!fields) return {};
    const sanitized: Record<string, DiagnosticFieldValue> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (Object.keys(sanitized).length >= 32) break;
      if (
        !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key)
        || (!SAFE_AUDIO_DIAGNOSTIC_FIELD_NAMES.has(key) && isForbiddenFieldKey(key))
      ) continue;
      if (typeof value === 'string' && SAFE_STRING_FIELD_NAMES.has(key)) {
        const safeValue = this.#sanitizeString(value, 240);
        sanitized[key] = FREEFORM_SANITIZED_STRING_FIELDS.has(key)
          ? safeValue
          : /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/u.test(safeValue)
            ? safeValue
            : 'redacted';
      }
      else if (typeof value === 'number' && Number.isFinite(value)) sanitized[key] = value;
      else if (typeof value === 'boolean' || value === null) sanitized[key] = value;
    }
    return sanitized;
  }

  #safeErrorFields(error: unknown): SafeErrorFields {
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
    const name = error instanceof Error
      ? error.name
      : typeof record?.name === 'string' ? record.name : 'UnknownError';
    const rawCode = record?.code;
    const code = typeof rawCode === 'string' || typeof rawCode === 'number'
      ? String(rawCode)
      : 'UNKNOWN_ERROR';
    const rawStack = error instanceof Error && typeof error.stack === 'string'
      ? error.stack
      : `${name}: unavailable stack`;
    // Error messages frequently embed payloads or user text. Keep only stack
    // frames, never the message-bearing first line.
    const shortStack = rawStack
      .split(/\r?\n/u)
      .filter((line) => /^\s*at\s/u.test(line))
      .slice(0, MAX_STACK_LINES)
      .join('\n') || 'stack unavailable';
    const errorName = this.#sanitizeString(name || 'Error', 120);
    const errorCode = this.#sanitizeString(code, 120);
    const errorStack = this.#sanitizeString(shortStack, MAX_STACK_CHARACTERS);
    const errorFingerprint = createHash('sha256')
      .update(`${errorName}\u0000${errorCode}\u0000${errorStack}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
    return { errorName, errorCode, errorStack, errorFingerprint };
  }

  #sanitizeString(value: string, maximumLength: number): string {
    const homeExpression = new RegExp(escapeRegExp(this.#homeDirectory), 'gu');
    return value
      .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{4,}/giu, '[REDACTED_API_KEY]')
      .replace(homeExpression, '<HOME>')
      .slice(0, maximumLength);
  }

  #flushBufferedEvents(): number {
    if (this.#buffer.length === 0) return 0;
    let writtenEventCount = 0;
    let totalByteMaintenanceRequired = false;
    try {
      this.#ensureStorage();
      while (
        writtenEventCount < this.#buffer.length
        && writtenEventCount < MAXIMUM_EVENTS_PER_FLUSH_TURN
      ) {
        this.#appendEvent(this.#buffer[writtenEventCount]!);
        writtenEventCount += 1;
        totalByteMaintenanceRequired ||= this.#knownTotalBytes > DIAGNOSTIC_MAX_TOTAL_BYTES;
      }
    } catch {
      this.#writeFailureCount += 1;
      this.#storageReady = false;
    } finally {
      if (writtenEventCount > 0) this.#buffer.splice(0, writtenEventCount);
    }
    // Capacity maintenance is deliberately outside the append transaction. A
    // successfully persisted event must leave the retry buffer even when an
    // unrelated old-file deletion fails, otherwise the same sequence is
    // appended twice after storage recovers.
    if (totalByteMaintenanceRequired) {
      try {
        this.#enforceTotalByteLimit();
      } catch {
        this.#writeFailureCount += 1;
        this.#storageReady = false;
      }
    }
    return writtenEventCount;
  }

  #scheduleBufferedFlush(): void {
    if (this.#flushScheduled || this.#buffer.length === 0) return;
    this.#flushScheduled = true;
    setImmediate(() => {
      this.#flushScheduled = false;
      const writtenEventCount = this.#flushBufferedEvents();
      // Yield between batches so a recovered 2,048-event queue cannot monopolize
      // the Electron main thread. A zero-write failure waits for the next event,
      // status read or export instead of spinning.
      if (writtenEventCount > 0) this.#scheduleBufferedFlush();
    });
  }

  #enqueue(event: DiagnosticEvent): boolean {
    if (this.#buffer.length < DIAGNOSTIC_MAX_BUFFERED_EVENTS) {
      this.#buffer.push(event);
      return true;
    }
    const incomingPriority = diagnosticLevelPriority(event.level);
    let replacementIndex = 0;
    let replacementPriority = diagnosticLevelPriority(this.#buffer[0]!.level);
    for (let index = 1; index < this.#buffer.length; index += 1) {
      const priority = diagnosticLevelPriority(this.#buffer[index]!.level);
      if (priority < replacementPriority) {
        replacementIndex = index;
        replacementPriority = priority;
      }
    }
    this.#droppedEventCount += 1;
    if (incomingPriority <= replacementPriority) return false;
    this.#buffer.splice(replacementIndex, 1);
    this.#buffer.push(event);
    return true;
  }

  #appendEvent(event: DiagnosticEvent): void {
    const line = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
    const lineBytes = line.length;
    const eventDateKey = event.occurredAt.slice(0, 10);
    if (this.#currentFilePath && this.#currentFileDateKey !== eventDateKey) {
      this.#currentFilePath = null;
      this.#currentFileBytes = 0;
      this.#currentFileDateKey = null;
    }
    let currentSize = this.#currentFilePath && existsSync(this.#currentFilePath)
      ? statSync(this.#currentFilePath).size
      : 0;
    if (this.#currentFilePath) {
      this.#knownTotalBytes += currentSize - this.#currentFileBytes;
      this.#currentFileBytes = currentSize;
    }
    if (!this.#currentFilePath || (currentSize > 0 && currentSize + lineBytes > DIAGNOSTIC_MAX_FILE_BYTES)) {
      this.#fileSequence += 1;
      this.#currentFilePath = path.join(
        this.#logDirectory,
        `${LOG_FILE_PREFIX}${this.#runId}-${String(this.#fileSequence).padStart(4, '0')}${LOG_FILE_SUFFIX}`,
      );
      currentSize = existsSync(this.#currentFilePath) ? statSync(this.#currentFilePath).size : 0;
      this.#currentFileBytes = currentSize;
      this.#currentFileDateKey = eventDateKey;
    }

    const fileExisted = existsSync(this.#currentFilePath);
    const descriptor = openSync(this.#currentFilePath, 'a', PRIVATE_FILE_MODE);
    try {
      if (!fileExisted) fchmodSync(descriptor, PRIVATE_FILE_MODE);
      let offset = 0;
      while (offset < lineBytes) {
        const written = this.#writeChunk(descriptor, line, offset, lineBytes - offset);
        if (written <= 0) throw new Error('DIAGNOSTIC_WRITE_INCOMPLETE');
        offset += written;
      }
    } catch (error) {
      // A retry must start from the exact pre-event boundary. Without this
      // rollback, a partial JSON prefix followed by the complete retry becomes
      // one malformed line and silently loses the event during export.
      try {
        ftruncateSync(descriptor, currentSize);
      } catch {
        // The original append error remains the authoritative failure.
      }
      try {
        closeSync(descriptor);
      } catch {
        // The original append error remains the authoritative failure.
      }
      throw error;
    }
    try {
      closeSync(descriptor);
    } catch {
      // All bytes were handed to the filesystem. Retrying here would create a
      // duplicate sequence, so close failures remain fail-open.
    }
    this.#currentFileBytes += lineBytes;
    this.#knownTotalBytes += lineBytes;
  }

  #attemptStorageMaintenance(): void {
    try {
      this.#ensureStorage();
      this.#pruneExpiredEvents();
      this.#enforceTotalByteLimit();
    } catch {
      this.#writeFailureCount += 1;
      this.#storageReady = false;
    } finally {
      this.#nextMaintenanceAtMs = this.#now().getTime() + MAINTENANCE_INTERVAL_MILLISECONDS;
    }
  }

  #attemptScheduledStorageMaintenance(): void {
    if (this.#now().getTime() < this.#nextMaintenanceAtMs) return;
    this.#attemptStorageMaintenance();
  }

  #ensureStorage(): void {
    if (this.#storageReady && existsSync(this.#logDirectory)) return;
    const existed = existsSync(this.#logDirectory);
    mkdirSync(this.#logDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (!existed) chmodSync(this.#logDirectory, PRIVATE_DIRECTORY_MODE);
    this.#storageReady = true;
  }

  #pruneExpiredEvents(): void {
    const cutoff = this.#now().getTime() - RETENTION_MILLISECONDS;
    for (const file of this.#listLogFiles()) {
      // Filesystem mtime describes the container, not the events inside it. A
      // file may be touched, restored, or rewritten long after its oldest
      // event was recorded, so mtime cannot safely prove either expiry or
      // freshness. The bounded store is small enough to enforce retention
      // from the schema-owned occurredAt value for every line.
      const retainedLines: string[] = [];
      let changed = false;
      const raw = readFileSync(file.filePath, 'utf8');
      for (const line of raw.split(/\r?\n/u)) {
        if (line.trim() === '') continue;
        try {
          const parsed = DiagnosticEventSchema.safeParse(JSON.parse(line));
          // Retention only owns valid diagnostic events. Preserve malformed
          // lines so export can report them as corruption instead of making a
          // maintenance pass silently erase the evidence.
          if (!parsed.success) {
            retainedLines.push(line);
            continue;
          }
          if (Date.parse(parsed.data.occurredAt) < cutoff) {
            changed = true;
            continue;
          }
          retainedLines.push(JSON.stringify(parsed.data));
        } catch {
          retainedLines.push(line);
        }
      }
      if (!changed) continue;
      if (retainedLines.length === 0) {
        unlinkSync(file.filePath);
        this.#resetCurrentFileIf(file.filePath);
        continue;
      }
      const replacement = `${retainedLines.join('\n')}\n`;
      const temporaryPath = `${file.filePath}.maintenance-${safeIdentifier('temporary', this.#createId())}`;
      try {
        writeFileSync(temporaryPath, replacement, {
          encoding: 'utf8',
          mode: PRIVATE_FILE_MODE,
          flag: 'wx',
        });
        chmodSync(temporaryPath, PRIVATE_FILE_MODE);
        renameSync(temporaryPath, file.filePath);
        chmodSync(file.filePath, PRIVATE_FILE_MODE);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
      if (this.#currentFilePath === file.filePath) {
        this.#currentFileBytes = Buffer.byteLength(replacement, 'utf8');
      }
    }
  }

  #resetCurrentFileIf(filePath: string): void {
    if (this.#currentFilePath !== filePath) return;
    this.#currentFilePath = null;
    this.#currentFileBytes = 0;
    this.#currentFileDateKey = null;
  }

  #resetVolatileStateAfterClearAttempt(): void {
    this.#buffer.length = 0;
    this.#currentFilePath = null;
    this.#currentFileBytes = 0;
    this.#currentFileDateKey = null;
  }

  #enforceTotalByteLimit(): void {
    const files = this.#listLogFiles().sort(compareLogFiles);
    let totalBytes = files.reduce((total, file) => total + file.size, 0);
    for (const file of files) {
      if (totalBytes <= DIAGNOSTIC_MAX_TOTAL_BYTES) break;
      unlinkSync(file.filePath);
      totalBytes -= file.size;
      if (this.#currentFilePath === file.filePath) {
        this.#currentFilePath = null;
        this.#currentFileBytes = 0;
        this.#currentFileDateKey = null;
      }
    }
    this.#knownTotalBytes = totalBytes;
  }

  #safeListLogFiles(): readonly DiagnosticLogFile[] {
    try {
      return this.#listLogFiles();
    } catch {
      this.#writeFailureCount += 1;
      return [];
    }
  }

  #listLogFiles(): DiagnosticLogFile[] {
    if (!existsSync(this.#logDirectory)) return [];
    return readdirSync(this.#logDirectory, { withFileTypes: true })
      .filter((entry) => (
        entry.isFile()
        && entry.name.startsWith(LOG_FILE_PREFIX)
        && entry.name.endsWith(LOG_FILE_SUFFIX)
      ))
      .map((entry) => {
        const filePath = path.join(this.#logDirectory, entry.name);
        const metadata = statSync(filePath);
        return {
          filePath,
          name: entry.name,
          size: metadata.size,
          modifiedAtMs: metadata.mtimeMs,
        };
      });
  }
}

export class DiagnosticLogClearError extends Error {
  readonly code = 'DIAGNOSTIC_LOG_CLEAR_FAILED' as const;
  readonly retryable = true as const;
  readonly deletedFileCount: number;
  readonly deletedBytes: number;
  readonly remainingFileCount: number | null;
  readonly remainingBytes: number | null;

  constructor(details: DiagnosticLogClearFailureDetails) {
    super('Diagnostic logs were not completely deleted. Retry is required.');
    this.name = 'DiagnosticLogClearError';
    this.deletedFileCount = details.deletedFileCount;
    this.deletedBytes = details.deletedBytes;
    this.remainingFileCount = details.remainingFileCount;
    this.remainingBytes = details.remainingBytes;
  }
}

function isForbiddenFieldKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return FORBIDDEN_FIELD_NAMES.has(normalized)
    || FORBIDDEN_FIELD_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function safeIdentifier(prefix: string, value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
    .slice(0, 80);
  return `${prefix}-${normalized || randomUUID()}`.slice(0, 96);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function compareLogFiles(left: DiagnosticLogFile, right: DiagnosticLogFile): number {
  return left.modifiedAtMs - right.modifiedAtMs || left.name.localeCompare(right.name);
}

function compareEvents(left: DiagnosticEvent, right: DiagnosticEvent): number {
  if (left.runId === right.runId) return left.sequence - right.sequence;
  return Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
    || left.runId.localeCompare(right.runId);
}

function diagnosticLevelPriority(level: DiagnosticLevel): number {
  switch (level) {
    case 'debug': return 0;
    case 'info': return 1;
    case 'warn': return 2;
    case 'error': return 3;
    case 'fatal': return 4;
  }
}

function finiteNonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
