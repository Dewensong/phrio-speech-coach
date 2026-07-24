// @vitest-environment node

import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DiagnosticLogClearError,
  DiagnosticLogService,
} from '../../src/backend/services/diagnostic-log-service';
import {
  DIAGNOSTIC_MAX_FILE_BYTES,
  DIAGNOSTIC_MAX_BUFFERED_EVENTS,
  DIAGNOSTIC_MAX_TOTAL_BYTES,
  DiagnosticBundleSchema,
  DiagnosticEventSchema,
} from '../../src/shared/diagnostics';

const temporaryDirectories: string[] = [];

async function temporaryLogDirectory(): Promise<{ root: string; logs: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phrio-diagnostics-'));
  temporaryDirectories.push(root);
  return { root, logs: path.join(root, 'logs') };
}

function deterministicIds(): () => string {
  let sequence = 0;
  return () => `test-id-${++sequence}`;
}

function service(
  logs: string,
  options: Partial<ConstructorParameters<typeof DiagnosticLogService>[1]> = {},
): DiagnosticLogService {
  return new DiagnosticLogService(logs, {
    appVersion: '0.1.0-test',
    createId: deterministicIds(),
    monotonicNow: () => 123.5,
    ...options,
  });
}

async function logFiles(logs: string): Promise<string[]> {
  return (await readdir(logs))
    .filter((name) => name.startsWith('phrio-diagnostic-') && name.endsWith('.jsonl'))
    .sort();
}

async function readEvents(logs: string): Promise<ReturnType<typeof DiagnosticEventSchema.parse>[]> {
  const events: ReturnType<typeof DiagnosticEventSchema.parse>[] = [];
  for (const name of await logFiles(logs)) {
    const raw = await readFile(path.join(logs, name), 'utf8');
    for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
      events.push(DiagnosticEventSchema.parse(JSON.parse(line)));
    }
  }
  return events;
}

async function waitForDiagnosticBufferToDrain(diagnostics: DiagnosticLogService): Promise<void> {
  for (let turn = 0; turn < 64; turn += 1) {
    if (diagnostics.getStatus().bufferedEventCount === 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('diagnostic buffer did not drain');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('DiagnosticLogService', () => {
  it('writes ordered structured JSONL with private directory and file permissions', async () => {
    const { logs } = await temporaryLogDirectory();
    const diagnostics = service(logs);

    const first = diagnostics.record({
      level: 'info',
      component: 'app',
      event: 'app.started',
      fields: { coldStart: true },
    });
    const second = diagnostics.recordError({
      component: 'persistence',
      event: 'persistence.write-failed',
      operationId: 'operation-1',
      error: Object.assign(new Error('database unavailable'), { code: 'SQLITE_BUSY' }),
    });

    const files = await logFiles(logs);
    const events = await readEvents(logs);
    expect(files).toHaveLength(1);
    expect(first).toEqual({ sequence: 0, incidentId: null });
    expect(second.sequence).toBe(1);
    expect(second.incidentId).toMatch(/^incident-/u);
    expect(events.map((event) => event.sequence)).toEqual([0, 1]);
    expect(events[0]).toMatchObject({
      schemaVersion: 'diagnostic-event-1',
      runId: diagnostics.runId,
      monotonicMs: 123.5,
    });
    expect(events[1]?.fields).toMatchObject({
      errorName: 'Error',
      errorCode: 'SQLITE_BUSY',
    });
    expect(events[1]?.fields.errorFingerprint).toMatch(/^[a-f0-9]{32}$/u);
    expect((await stat(logs)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(logs, files[0]!))).mode & 0o777).toBe(0o600);
  });

  it('centrally removes content fields and redacts credentials and the user home path', async () => {
    const { logs } = await temporaryLogDirectory();
    const fakeHome = '/private/example-home';
    const diagnostics = service(logs, { homeDirectory: fakeHome });
    const secret = ['sk-proj', 'super-secret-value'].join('-');

    const providerError = Object.assign(
      new Error(`Bearer provider-token failed at ${fakeHome}/Library/Phrio`),
      { code: 'PROVIDER_FAILED' },
    );
    providerError.stack = [
      `Error: Bearer provider-token failed at ${fakeHome}/Library/Phrio`,
      `    at providerCall (${fakeHome}/app/provider.ts:10:2)`,
    ].join('\n');
    diagnostics.recordError({
      component: 'ai',
      event: 'ai.request-failed',
      error: providerError,
      fields: {
        audioBytes: 200,
        pcmChunk: 4,
        pcmCallbackCount: 12,
        pcmInputFrames: 24_576,
        audioContextState: 'running',
        transport: 'script_processor_fallback',
        blockerType: 'prevent-app-suspension',
        source: 'hf_mirror_acceleration',
        fileName: 'encoder.int8.onnx',
        requestPhase: 'range_response',
        networkCode: 'ECONNRESET',
        url: 'https://example.test/model?signature=must-not-leak',
        transcriptVersion: 2,
        partialText: 'sensitive partial',
        finalText: 'sensitive final',
        payload: '{sensitive}',
        requestBody: '{sensitive}',
        responseBody: '{sensitive}',
        authorization: 'Bearer provider-token',
        apiKey: secret,
        prompt: 'sensitive prompt',
        content: 'sensitive content',
        text: 'sensitive text',
        reasonCode: `${secret} Bearer second-token ${fakeHome}/Documents/file`,
        message: 'arbitrary user prose must be dropped',
        utterance: 'spoken content must be dropped',
      } as never,
    });

    const [event] = await readEvents(logs);
    expect(event?.fields).not.toHaveProperty('audioBytes');
    expect(event?.fields).not.toHaveProperty('pcmChunk');
    expect(event?.fields).toMatchObject({
      pcmCallbackCount: 12,
      pcmInputFrames: 24_576,
      audioContextState: 'running',
      transport: 'script_processor_fallback',
      blockerType: 'prevent-app-suspension',
      source: 'hf_mirror_acceleration',
      fileName: 'encoder.int8.onnx',
      requestPhase: 'range_response',
      networkCode: 'ECONNRESET',
    });
    expect(event?.fields).not.toHaveProperty('url');
    expect(event?.fields).not.toHaveProperty('transcriptVersion');
    expect(event?.fields).not.toHaveProperty('partialText');
    expect(event?.fields).not.toHaveProperty('finalText');
    expect(event?.fields).not.toHaveProperty('payload');
    expect(event?.fields).not.toHaveProperty('requestBody');
    expect(event?.fields).not.toHaveProperty('responseBody');
    expect(event?.fields).not.toHaveProperty('authorization');
    expect(event?.fields).not.toHaveProperty('apiKey');
    expect(event?.fields).not.toHaveProperty('prompt');
    expect(event?.fields).not.toHaveProperty('content');
    expect(event?.fields).not.toHaveProperty('text');
    expect(event?.fields.reasonCode).toBe('redacted');
    expect(event?.fields).not.toHaveProperty('message');
    expect(event?.fields).not.toHaveProperty('utterance');
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('provider-token');
    expect(serialized).not.toContain(fakeHome);
    expect(serialized).not.toContain('sensitive final');
    expect(String(event?.fields.errorStack)).toContain('<HOME>');
  });

  it('removes events older than seven days even when their file mtime is recent', async () => {
    const { logs } = await temporaryLogDirectory();
    const eightDaysAgo = new Date('2026-07-10T12:00:00.000Z');
    const original = service(logs, { now: () => eightDaysAgo });
    original.record({ level: 'info', component: 'app', event: 'app.expired' });
    const [oldName] = await logFiles(logs);
    const oldFile = path.join(logs, oldName!);
    const now = new Date('2026-07-18T12:00:00.000Z');

    // A restore/touch makes mtime look current without changing event age.
    await utimes(oldFile, now, now);

    service(logs, { now: () => now });

    await expect(stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prunes expired events during a long-running process before writing the next day', async () => {
    const { logs } = await temporaryLogDirectory();
    let now = new Date('2026-07-18T12:00:00.000Z');
    const diagnostics = service(logs, { now: () => now });
    diagnostics.record({ level: 'info', component: 'app', event: 'app.day-zero' });

    now = new Date('2026-07-26T12:00:00.000Z');
    const [oldName] = await logFiles(logs);
    await utimes(path.join(logs, oldName!), now, now);
    diagnostics.record({ level: 'info', component: 'app', event: 'app.day-eight' });

    const events = await readEvents(logs);
    expect(events.map((event) => event.event)).toEqual(['app.day-eight']);
    expect(events[0]?.runId).toBe(diagnostics.runId);
  });

  it('rotates before a JSONL file would exceed five megabytes', async () => {
    const { logs } = await temporaryLogDirectory();
    const diagnostics = service(logs);
    diagnostics.record({ level: 'info', component: 'app', event: 'app.started' });
    const [firstName] = await logFiles(logs);
    const firstPath = path.join(logs, firstName!);
    await truncate(firstPath, DIAGNOSTIC_MAX_FILE_BYTES);

    diagnostics.record({ level: 'info', component: 'app', event: 'app.ready' });

    const files = await logFiles(logs);
    expect(files).toHaveLength(2);
    expect((await stat(firstPath)).size).toBe(DIAGNOSTIC_MAX_FILE_BYTES);
    expect((await stat(path.join(logs, files[1]!))).size).toBeLessThan(
      DIAGNOSTIC_MAX_FILE_BYTES,
    );
  });

  it('deletes the oldest files first when total storage exceeds twenty-five megabytes', async () => {
    const { logs } = await temporaryLogDirectory();
    await mkdir(logs, { recursive: true });
    const now = new Date('2026-07-18T12:00:00.000Z');
    const filePaths: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const filePath = path.join(
        logs,
        `phrio-diagnostic-seeded-run-${String(index).padStart(4, '0')}.jsonl`,
      );
      await writeFile(filePath, '');
      await truncate(filePath, DIAGNOSTIC_MAX_FILE_BYTES);
      const modifiedAt = new Date(now.getTime() - (6 - index) * 60_000);
      await utimes(filePath, modifiedAt, modifiedAt);
      filePaths.push(filePath);
    }

    const diagnostics = service(logs, { now: () => now });
    const status = diagnostics.getStatus();

    expect(status.totalBytes).toBeLessThanOrEqual(DIAGNOSTIC_MAX_TOTAL_BYTES);
    expect(status.fileCount).toBe(5);
    await expect(stat(filePaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(filePaths[5]!)).resolves.toBeDefined();
  });

  it('clears persisted and buffered diagnostics without resetting the run identity', async () => {
    const { logs } = await temporaryLogDirectory();
    const diagnostics = service(logs);
    diagnostics.recordError({
      component: 'app',
      event: 'app.start-failed',
      error: new Error('safe test failure'),
    });
    const runId = diagnostics.runId;
    const generationBeforeClear = diagnostics.generation;
    expect(diagnostics.getStatus().latestIncidentId).toMatch(/^incident-/u);

    const result = diagnostics.clear();
    const status = diagnostics.getStatus();

    expect(result.deletedFileCount).toBe(1);
    expect(result.deletedBytes).toBeGreaterThan(0);
    expect(status).toMatchObject({
      currentRunId: runId,
      fileCount: 0,
      totalBytes: 0,
      bufferedEventCount: 0,
      latestIncidentId: null,
    });
    expect(diagnostics.generation).toBe(generationBeforeClear + 1);

    expect(diagnostics.recordIfGeneration(generationBeforeClear, {
      level: 'error',
      component: 'ipc',
      event: 'ipc.stale-operation-completed',
    })).toBeNull();
    expect(diagnostics.recordIfGeneration(diagnostics.generation, {
      level: 'info',
      component: 'app',
      event: 'app.after-clear',
    })).toMatchObject({ incidentId: null });
    expect((await readEvents(logs)).map((event) => event.event)).toEqual([
      'app.after-clear',
    ]);
  });

  it('throws a retryable error and reports the rescanned file when unlink fails', async () => {
    const { logs } = await temporaryLogDirectory();
    const diagnostics = service(logs, {
      unlinkFile: () => {
        throw Object.assign(new Error('injected unlink failure'), { code: 'EBUSY' });
      },
    });
    diagnostics.record({ level: 'info', component: 'app', event: 'app.before-clear' });
    const bytesBeforeClear = diagnostics.getStatus().totalBytes;

    let failure: unknown;
    try {
      diagnostics.clear();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DiagnosticLogClearError);
    expect(failure).toMatchObject({
      code: 'DIAGNOSTIC_LOG_CLEAR_FAILED',
      retryable: true,
      deletedFileCount: 0,
      deletedBytes: 0,
      remainingFileCount: 1,
      remainingBytes: bytesBeforeClear,
    });
    expect(diagnostics.getStatus()).toMatchObject({
      fileCount: 1,
      totalBytes: bytesBeforeClear,
      bufferedEventCount: 0,
    });
  });

  it('keeps a partially deleted clear visible and removes the remainder on retry', async () => {
    const { logs } = await temporaryLogDirectory();
    let failSeededFileOnce = true;
    const diagnostics = service(logs, {
      unlinkFile: (filePath) => {
        if (failSeededFileOnce && path.basename(filePath).includes('seeded')) {
          failSeededFileOnce = false;
          throw Object.assign(new Error('injected partial unlink failure'), { code: 'EBUSY' });
        }
        unlinkSync(filePath);
      },
    });
    diagnostics.record({ level: 'info', component: 'app', event: 'app.before-partial-clear' });
    const seededFile = path.join(logs, 'phrio-diagnostic-seeded-run-0001.jsonl');
    await writeFile(seededFile, '{}\n');

    let failure: unknown;
    try {
      diagnostics.clear();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DiagnosticLogClearError);
    expect(failure).toMatchObject({
      deletedFileCount: 1,
      remainingFileCount: 1,
      remainingBytes: 3,
    });
    expect(await logFiles(logs)).toEqual([path.basename(seededFile)]);
    expect(diagnostics.getStatus()).toMatchObject({ fileCount: 1, totalBytes: 3 });

    expect(diagnostics.clear()).toEqual({ deletedFileCount: 1, deletedBytes: 3 });
    expect(diagnostics.getStatus()).toMatchObject({
      fileCount: 0,
      totalBytes: 0,
      writeFailureCount: 0,
      latestIncidentId: null,
    });
  });

  it('exports a validated bundle and counts malformed JSONL lines without including them', async () => {
    const { root, logs } = await temporaryLogDirectory();
    const diagnostics = service(logs, {
      now: () => new Date('2026-07-18T12:00:00.000Z'),
      platform: 'darwin',
      architecture: 'arm64',
    });
    diagnostics.record({
      level: 'info',
      component: 'session',
      event: 'session.created',
      sessionId: 'session-1',
    });
    const [fileName] = await logFiles(logs);
    await appendFile(path.join(logs, fileName!), '{not-valid-json}\n');
    const destination = path.join(root, 'exports', 'phrio-diagnostics.json');

    const output = diagnostics.exportBundle(destination);
    const bundle = DiagnosticBundleSchema.parse(JSON.parse(await readFile(destination, 'utf8')));

    expect(output).toMatchObject({
      cancelled: false,
      filePath: destination,
      sourceFileCount: 1,
      eventCount: 1,
    });
    expect(output.byteLength).toBe((await stat(destination)).size);
    expect(bundle).toMatchObject({
      schemaVersion: 'diagnostic-bundle-1',
      sourceFileCount: 1,
      corruptLineCount: 1,
      app: { version: '0.1.0-test', platform: 'darwin', architecture: 'arm64' },
    });
    expect(bundle.events).toHaveLength(1);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });

  it('buffers write failures without throwing and retries them on a later record', async () => {
    const { root, logs } = await temporaryLogDirectory();
    await writeFile(logs, 'path collision');
    const diagnostics = service(logs);

    expect(() => diagnostics.record({
      level: 'info',
      component: 'app',
      event: 'app.started',
    })).not.toThrow();
    expect(diagnostics.getStatus()).toMatchObject({
      bufferedEventCount: 1,
    });

    await unlink(logs);
    await mkdir(logs, { mode: 0o700 });
    await chmod(logs, 0o700);
    expect(() => diagnostics.record({
      level: 'info',
      component: 'app',
      event: 'app.recovered',
    })).not.toThrow();

    expect(diagnostics.getStatus()).toMatchObject({
      bufferedEventCount: 0,
      fileCount: 1,
    });
    expect((await readEvents(logs)).map((event) => event.event)).toEqual([
      'app.started',
      'app.recovered',
    ]);
    expect(path.dirname(logs)).toBe(root);
  });

  it('rolls back a partial JSONL write before retrying the same sequence', async () => {
    const { logs } = await temporaryLogDirectory();
    let injectPartialFailure = true;
    let writeCall = 0;
    const diagnostics = service(logs, {
      writeChunk: (descriptor, buffer, offset, length) => {
        if (injectPartialFailure) {
          writeCall += 1;
          if (writeCall === 1) {
            return writeSync(descriptor, buffer, offset, Math.max(1, Math.floor(length / 2)));
          }
          throw new Error('injected write failure');
        }
        return writeSync(descriptor, buffer, offset, length);
      },
    });

    expect(() => diagnostics.record({
      level: 'info',
      component: 'app',
      event: 'app.partial-write',
    })).not.toThrow();

    injectPartialFailure = false;
    diagnostics.record({
      level: 'info',
      component: 'app',
      event: 'app.writer-recovered',
    });

    const events = await readEvents(logs);
    expect(events.map((event) => [event.sequence, event.event])).toEqual([
      [0, 'app.partial-write'],
      [1, 'app.writer-recovered'],
    ]);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);
    expect(diagnostics.getStatus()).toMatchObject({
      bufferedEventCount: 0,
      writeFailureCount: 1,
    });
  });

  it('bounds a failed writer buffer, reports dropped events, and preserves sequence order on recovery', async () => {
    const { logs } = await temporaryLogDirectory();
    await writeFile(logs, 'path collision');
    const diagnostics = service(logs);

    for (let index = 0; index < DIAGNOSTIC_MAX_BUFFERED_EVENTS + 2; index += 1) {
      diagnostics.record({
        level: 'debug',
        component: 'asr',
        event: 'asr.partial-sampled',
        fields: { sequence: index },
      });
    }
    diagnostics.recordError({
      component: 'asr',
      event: 'asr.failed',
      error: new Error('test failure'),
    });
    expect(diagnostics.getStatus()).toMatchObject({
      bufferedEventCount: DIAGNOSTIC_MAX_BUFFERED_EVENTS,
      droppedEventCount: 3,
      maximumBufferedEvents: DIAGNOSTIC_MAX_BUFFERED_EVENTS,
    });

    await unlink(logs);
    await mkdir(logs, { mode: 0o700 });
    diagnostics.record({ level: 'info', component: 'app', event: 'app.writer-recovered' });
    expect(diagnostics.getStatus().bufferedEventCount).toBeGreaterThan(0);
    await waitForDiagnosticBufferToDrain(diagnostics);
    const events = await readEvents(logs);
    expect(events).toHaveLength(DIAGNOSTIC_MAX_BUFFERED_EVENTS);
    expect(events.some((event) => event.event === 'asr.failed')).toBe(true);
    expect(events.at(-1)?.event).toBe('app.writer-recovered');
    expect(events.map((event) => event.sequence)).toEqual(
      [...events].map((event) => event.sequence).sort((left, right) => left - right),
    );
    diagnostics.clear();
    expect(diagnostics.getStatus()).toMatchObject({
      bufferedEventCount: 0,
      droppedEventCount: 0,
      writeFailureCount: 0,
      latestIncidentId: null,
    });
  });

  it('exports buffered events when the managed log directory is unavailable', async () => {
    const { root, logs } = await temporaryLogDirectory();
    await writeFile(logs, 'path collision');
    const diagnostics = service(logs);
    diagnostics.record({ level: 'warn', component: 'app', event: 'app.buffered-only' });
    const destination = path.join(root, 'buffered-diagnostics.json');

    const output = diagnostics.exportBundle(destination);
    const bundle = DiagnosticBundleSchema.parse(JSON.parse(await readFile(destination, 'utf8')));

    expect(output.eventCount).toBe(1);
    expect(bundle.events.map((event) => event.event)).toEqual(['app.buffered-only']);
    expect(bundle.droppedEventCount).toBe(0);
  });
});
