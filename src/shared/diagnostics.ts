import { z } from 'zod';

import { IdentifierSchema, IsoDateTimeSchema } from './domain';

export const DIAGNOSTIC_SCHEMA_VERSION = 'diagnostic-event-1' as const;
export const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 'diagnostic-bundle-1' as const;
export const DIAGNOSTIC_RETENTION_DAYS = 7 as const;
export const DIAGNOSTIC_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const DIAGNOSTIC_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DIAGNOSTIC_MAX_BUFFERED_EVENTS = 2_048;

export const DiagnosticLevelSchema = z.enum([
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);
export type DiagnosticLevel = z.infer<typeof DiagnosticLevelSchema>;

export const DiagnosticComponentSchema = z.enum([
  'app',
  'window',
  'ipc',
  'renderer',
  'navigation',
  'recording',
  'vad',
  'asr',
  'session',
  'persistence',
  'live',
  'deep',
  'ai',
  'settings',
  'data',
  'diagnostics',
]);
export type DiagnosticComponent = z.infer<typeof DiagnosticComponentSchema>;

export const DiagnosticFieldValueSchema = z.union([
  z.string().max(240),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type DiagnosticFieldValue = z.infer<typeof DiagnosticFieldValueSchema>;

const DiagnosticFieldsSchema = z
  .record(
    z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u),
    DiagnosticFieldValueSchema,
  )
  .superRefine((fields, context) => {
    if (Object.keys(fields).length > 32) {
      context.addIssue({
        code: 'custom',
        message: 'diagnostic fields must contain at most 32 entries',
      });
    }
  });

const DiagnosticCorrelationSchema = z.object({
  sessionId: IdentifierSchema.nullable().default(null),
  attemptId: IdentifierSchema.nullable().default(null),
  operationId: IdentifierSchema.nullable().default(null),
  requestId: IdentifierSchema.nullable().default(null),
}).strict();

export const RecordDiagnosticEventInputSchema = DiagnosticCorrelationSchema.extend({
  level: DiagnosticLevelSchema,
  component: DiagnosticComponentSchema,
  event: z.string().min(3).max(96).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
  fields: DiagnosticFieldsSchema.default({}),
}).strict();
export type RecordDiagnosticEventInput = z.input<typeof RecordDiagnosticEventInputSchema>;
export type ParsedDiagnosticEventInput = z.output<typeof RecordDiagnosticEventInputSchema>;

export const DiagnosticEventSchema = RecordDiagnosticEventInputSchema.extend({
  schemaVersion: z.literal(DIAGNOSTIC_SCHEMA_VERSION),
  sequence: z.number().int().nonnegative(),
  occurredAt: IsoDateTimeSchema,
  monotonicMs: z.number().finite().nonnegative(),
  runId: IdentifierSchema,
  incidentId: IdentifierSchema.nullable(),
}).strict();
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;

export const RecordDiagnosticEventOutputSchema = z.object({
  sequence: z.number().int().nonnegative(),
  incidentId: IdentifierSchema.nullable(),
}).strict();
export type RecordDiagnosticEventOutput = z.infer<typeof RecordDiagnosticEventOutputSchema>;

export const DiagnosticStatusSchema = z.object({
  appVersion: z.string().min(1).max(64),
  currentRunId: IdentifierSchema,
  logDirectory: z.string().min(1).max(4_096),
  retentionDays: z.literal(DIAGNOSTIC_RETENTION_DAYS),
  maximumTotalBytes: z.literal(DIAGNOSTIC_MAX_TOTAL_BYTES),
  maximumBufferedEvents: z.literal(DIAGNOSTIC_MAX_BUFFERED_EVENTS),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  bufferedEventCount: z.number().int().nonnegative(),
  droppedEventCount: z.number().int().nonnegative(),
  writeFailureCount: z.number().int().nonnegative(),
  latestIncidentId: IdentifierSchema.nullable(),
}).strict();
export type DiagnosticStatus = z.infer<typeof DiagnosticStatusSchema>;

export const ClearDiagnosticLogsOutputSchema = z.object({
  deletedFileCount: z.number().int().nonnegative(),
  deletedBytes: z.number().int().nonnegative(),
}).strict();
export type ClearDiagnosticLogsOutput = z.infer<typeof ClearDiagnosticLogsOutputSchema>;

export const DiagnosticLogClearSummarySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('cleared'),
    deletedFileCount: z.number().int().nonnegative(),
    deletedBytes: z.number().int().nonnegative(),
    remainingFileCount: z.literal(0),
    remainingBytes: z.literal(0),
  }).strict(),
  z.object({
    status: z.literal('retry_required'),
    deletedFileCount: z.number().int().nonnegative(),
    deletedBytes: z.number().int().nonnegative(),
    remainingFileCount: z.number().int().nonnegative().nullable(),
    remainingBytes: z.number().int().nonnegative().nullable(),
  }).strict(),
]);
export type DiagnosticLogClearSummary = z.infer<typeof DiagnosticLogClearSummarySchema>;

export const OpenDiagnosticDirectoryOutputSchema = z.object({
  opened: z.boolean(),
  errorCode: z.string().min(1).max(120).nullable(),
}).strict();
export type OpenDiagnosticDirectoryOutput = z.infer<typeof OpenDiagnosticDirectoryOutputSchema>;

export const ExportDiagnosticBundleOutputSchema = z.object({
  cancelled: z.boolean(),
  filePath: z.string().min(1).max(4_096).nullable(),
  sourceFileCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
}).strict();
export type ExportDiagnosticBundleOutput = z.infer<typeof ExportDiagnosticBundleOutputSchema>;

export const DiagnosticBundleSchema = z.object({
  schemaVersion: z.literal(DIAGNOSTIC_BUNDLE_SCHEMA_VERSION),
  generatedAt: IsoDateTimeSchema,
  app: z.object({
    version: z.string().min(1).max(64),
    platform: z.string().min(1).max(32),
    architecture: z.string().min(1).max(32),
  }).strict(),
  retentionDays: z.literal(DIAGNOSTIC_RETENTION_DAYS),
  maximumBufferedEvents: z.literal(DIAGNOSTIC_MAX_BUFFERED_EVENTS),
  droppedEventCount: z.number().int().nonnegative(),
  sourceFileCount: z.number().int().nonnegative(),
  corruptLineCount: z.number().int().nonnegative(),
  events: z.array(DiagnosticEventSchema),
}).strict();
export type DiagnosticBundle = z.infer<typeof DiagnosticBundleSchema>;
