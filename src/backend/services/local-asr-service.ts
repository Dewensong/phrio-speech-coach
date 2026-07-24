import { constants, existsSync } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  LOCAL_ASR_MODEL_FILE_NAMES,
  type LocalAsrModelFileStatus,
  type RecordDiagnosticEventInput,
  type TranscriptSegment,
} from '../../shared';
import {
  createLocalAsrRecognizerConfig,
  LOCAL_ASR_MODEL_DIRECTORY_NAME as MODEL_DIRECTORY,
  LOCAL_ASR_MODEL_VERSION as MODEL_VERSION,
} from './local-asr-recognizer-config';

interface SherpaStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
}

interface SherpaRecognizer {
  createStream(): SherpaStream;
  isReady(stream: SherpaStream): boolean;
  decode(stream: SherpaStream): void;
  getResult(stream: SherpaStream): { text?: string };
  isEndpoint(stream: SherpaStream): boolean;
  reset(stream: SherpaStream): void;
}

interface SherpaModule {
  OnlineRecognizer: new (config: unknown) => SherpaRecognizer;
  version?: string;
}

export interface LocalAsrServiceOptions {
  readonly loadModule?: () => SherpaModule;
  readonly now?: () => number;
  readonly diagnostics?: LocalAsrDiagnosticSink;
}

export interface LocalAsrDiagnosticSink {
  record(input: RecordDiagnosticEventInput): unknown;
}

interface ActiveAsrAttempt {
  readonly attemptId: string;
  readonly generation: number;
  readonly startedAt: number;
  acceptedSamples: number;
  stream: SherpaStream;
  sequence: number;
  revision: number;
  partialText: string;
  lastPartialDiagnosticAtMs: number;
  currentSegmentStartMs: number | null;
  lastFinalEndMs: number;
  feedCount: number;
  feedDurationTotalMs: number;
  maximumFeedDurationMs: number;
  decodeIterationCount: number;
  firstPartialAudioMs: number | null;
  currentLastPartialAudioMs: number | null;
  partialGapCount: number;
  partialGapTotalMs: number;
  maximumPartialGapMs: number;
  partialToFinalCount: number;
  partialToFinalTotalMs: number;
  maximumPartialToFinalMs: number;
}

const loadNativeModule = createRequire(import.meta.url);

export function probeLocalAsrDependency(): {
  readonly packageName: 'sherpa-onnx-node';
  readonly recognizerConstructor: true;
  readonly version: string | null;
} {
  const sherpa = loadNativeModule('sherpa-onnx-node') as SherpaModule;
  if (typeof sherpa.OnlineRecognizer !== 'function') {
    throw new Error('sherpa-onnx-node did not export OnlineRecognizer');
  }
  return {
    packageName: 'sherpa-onnx-node',
    recognizerConstructor: true,
    version: typeof sherpa.version === 'string' ? sherpa.version : null,
  };
}

export class LocalAsrService {
  readonly #modelRoot: string;
  readonly #loadModule: () => SherpaModule;
  readonly #now: () => number;
  readonly #diagnostics: LocalAsrDiagnosticSink | undefined;
  #recognizer: SherpaRecognizer | null = null;
  #active: ActiveAsrAttempt | null = null;
  readonly #finalLedgers = new Map<string, Map<string, TranscriptSegment>>();

  constructor(modelRoot: string, options: LocalAsrServiceOptions = {}) {
    this.#modelRoot = path.resolve(modelRoot, MODEL_DIRECTORY);
    this.#loadModule = options.loadModule ?? (() => loadNativeModule('sherpa-onnx-node') as SherpaModule);
    this.#now = options.now ?? (() => performance.now());
    this.#diagnostics = options.diagnostics;
  }

  get modelDirectory(): string {
    return this.#modelRoot;
  }

  async inspectModelFiles(): Promise<readonly LocalAsrModelFileStatus[]> {
    const startedAt = this.#now();
    const statuses = await Promise.all(
      LOCAL_ASR_MODEL_FILE_NAMES.map(async (name): Promise<LocalAsrModelFileStatus> => {
        const modelPath = path.join(this.#modelRoot, name);
        let exists = false;
        try {
          const metadata = await lstat(modelPath);
          exists = metadata.isFile() && !metadata.isSymbolicLink();
        } catch {
          return { name, exists: false, readable: false };
        }
        if (!exists) {
          return { name, exists: false, readable: false };
        }
        try {
          await access(modelPath, constants.R_OK);
          return { name, exists: true, readable: true };
        } catch {
          return { name, exists: true, readable: false };
        }
      }),
    );
    this.#recordDiagnostic({
      level: statuses.every((status) => status.readable) ? 'info' : 'warn',
      component: 'asr',
      event: 'asr.model.inspected',
      fields: {
        fileCount: statuses.length,
        readableFileCount: statuses.filter((status) => status.readable).length,
        missingFileCount: statuses.filter((status) => !status.exists).length,
        unreadableFileCount: statuses.filter((status) => status.exists && !status.readable).length,
        durationMs: elapsedMilliseconds(startedAt, this.#now()),
      },
    });
    return statuses;
  }

  start(input: { readonly attemptId: string; readonly generation: number }): {
    readonly modelVersion: string;
  } {
    const diagnosticStartedAt = this.#now();
    const recognizerWarm = this.#recognizer !== null;
    this.#recordDiagnostic({
      level: 'info',
      component: 'asr',
      event: 'asr.attempt.starting',
      attemptId: input.attemptId,
      fields: { generation: input.generation, recognizerWarm },
    });
    try {
      this.#ensureRecognizer();
      const ledgerKey = attemptLedgerKey(input);
      const existingLedger = this.#finalLedgers.get(ledgerKey);
      if (existingLedger && existingLedger.size > 0) {
        throw new LocalAsrServiceError('ASR_FINAL_LEDGER_CONFLICT');
      }
      if (!existingLedger) this.#finalLedgers.set(ledgerKey, new Map());
      const attemptStartedAt = this.#now();
      this.#active = this.#createActiveAttempt(input, attemptStartedAt);
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.attempt.started',
        attemptId: input.attemptId,
        fields: {
          generation: input.generation,
          recognizerWarm,
          durationMs: elapsedMilliseconds(diagnosticStartedAt, attemptStartedAt),
          modelVersion: MODEL_VERSION,
        },
      });
      return { modelVersion: MODEL_VERSION };
    } catch (error) {
      this.#recordDiagnostic({
        level: 'error',
        component: 'asr',
        event: 'asr.attempt.start_failed',
        attemptId: input.attemptId,
        fields: {
          generation: input.generation,
          durationMs: elapsedMilliseconds(diagnosticStartedAt, this.#now()),
          errorCode: safeLocalAsrErrorCode(error),
        },
      });
      throw error;
    }
  }

  /**
   * Atomically abandons an incomplete stream and starts the same Attempt again.
   * The main process, not the Renderer, owns the no-final proof so a delayed or
   * compromised caller cannot erase an authoritative final ledger.
   */
  restartIfNoFinal(input: { readonly attemptId: string; readonly generation: number }): {
    readonly modelVersion: string;
  } {
    const diagnosticStartedAt = this.#now();
    this.#recordDiagnostic({
      level: 'warn',
      component: 'asr',
      event: 'asr.attempt.restart-if-no-final-starting',
      attemptId: input.attemptId,
      fields: { generation: input.generation },
    });
    try {
      this.#ensureRecognizer();
      const ledgerKey = attemptLedgerKey(input);
      const existingLedger = this.#finalLedgers.get(ledgerKey);
      if (existingLedger && existingLedger.size > 0) {
        throw new LocalAsrServiceError('ASR_FINAL_LEDGER_CONFLICT');
      }
      if (
        this.#active
        && (
          this.#active.attemptId !== input.attemptId
          || this.#active.generation !== input.generation
        )
      ) {
        throw new LocalAsrServiceError('STALE_ASR_ATTEMPT');
      }

      const abandonedSamples = this.#active?.acceptedSamples ?? 0;
      const restartedAt = this.#now();
      this.#finalLedgers.set(ledgerKey, new Map());
      this.#active = this.#createActiveAttempt(input, restartedAt);
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.attempt.restart-if-no-final-completed',
        attemptId: input.attemptId,
        fields: {
          generation: input.generation,
          abandonedSamples,
          durationMs: elapsedMilliseconds(diagnosticStartedAt, restartedAt),
          modelVersion: MODEL_VERSION,
        },
      });
      return { modelVersion: MODEL_VERSION };
    } catch (error) {
      this.#recordDiagnostic({
        level: 'error',
        component: 'asr',
        event: 'asr.attempt.restart-if-no-final-failed',
        attemptId: input.attemptId,
        fields: {
          generation: input.generation,
          durationMs: elapsedMilliseconds(diagnosticStartedAt, this.#now()),
          errorCode: safeLocalAsrErrorCode(error),
        },
      });
      throw error;
    }
  }

  feed(input: {
    readonly attemptId: string;
    readonly generation: number;
    readonly samples: Float32Array;
  }): TranscriptSegment | null {
    const feedStartedAt = this.#now();
    let activeForMetrics: ActiveAsrAttempt | null = null;
    let decodeIterations = 0;
    try {
      const active = this.#requireActive(input);
      activeForMetrics = active;
      active.stream.acceptWaveform({ samples: input.samples, sampleRate: 16_000 });
      active.acceptedSamples += input.samples.length;
      while (this.#recognizer!.isReady(active.stream)) {
        this.#recognizer!.decode(active.stream);
        decodeIterations += 1;
      }
      const text = (this.#recognizer!.getResult(active.stream).text ?? '').trim();
      const endpoint = this.#recognizer!.isEndpoint(active.stream);
      // Sherpa may mark an endpoint without changing the last partial text. The endpoint
      // still has to promote that partial to a final segment instead of being dropped.
      if (!text || (text === active.partialText && !endpoint)) return null;
      const endMs = sampleClockMilliseconds(active.acceptedSamples);
      if (active.currentSegmentStartMs === null) {
        active.currentSegmentStartMs = Math.max(active.lastFinalEndMs, endMs);
      }
      let partialGapAudioMs: number | null = null;
      let lastPartialToFinalAudioMs: number | null = null;
      if (endpoint) {
        if (active.currentLastPartialAudioMs !== null) {
          lastPartialToFinalAudioMs = Math.max(0, endMs - active.currentLastPartialAudioMs);
          active.partialToFinalCount += 1;
          active.partialToFinalTotalMs += lastPartialToFinalAudioMs;
          active.maximumPartialToFinalMs = Math.max(
            active.maximumPartialToFinalMs,
            lastPartialToFinalAudioMs,
          );
        }
      } else {
        if (active.firstPartialAudioMs === null) active.firstPartialAudioMs = endMs;
        if (active.currentLastPartialAudioMs !== null) {
          partialGapAudioMs = Math.max(0, endMs - active.currentLastPartialAudioMs);
          active.partialGapCount += 1;
          active.partialGapTotalMs += partialGapAudioMs;
          active.maximumPartialGapMs = Math.max(active.maximumPartialGapMs, partialGapAudioMs);
        }
        active.currentLastPartialAudioMs = endMs;
      }
      active.partialText = text;
      active.revision += 1;
      const emittedAt = new Date().toISOString();
      const segment: TranscriptSegment = {
        id: `${active.attemptId}-seg-${active.sequence}`,
        attemptId: active.attemptId,
        sequence: active.sequence,
        revision: active.revision,
        text,
        startMs: active.currentSegmentStartMs,
        endMs,
        confidence: null,
        isFinal: endpoint,
        emittedAt,
        finalizedAt: endpoint ? emittedAt : null,
        modelVersion: MODEL_VERSION,
      };
      if (endpoint) {
        this.#recordFinal(input, segment);
        this.#recognizer!.reset(active.stream);
        active.lastFinalEndMs = endMs;
        active.currentSegmentStartMs = null;
        active.sequence += 1;
        active.revision = 0;
        active.partialText = '';
        active.currentLastPartialAudioMs = null;
      }
      if (endpoint || endMs - active.lastPartialDiagnosticAtMs >= 1_000) {
        this.#recordDiagnostic({
          level: 'debug',
          component: 'asr',
          event: endpoint ? 'asr.final.emitted' : 'asr.partial.emitted',
          attemptId: input.attemptId,
          fields: {
            generation: input.generation,
            sequence: segment.sequence,
            revision: segment.revision,
            characterCount: text.length,
            segmentDurationMs: Math.max(0, segment.endMs - segment.startMs),
            firstPartialAudioMs: active.firstPartialAudioMs,
            partialGapAudioMs,
            lastPartialToFinalAudioMs,
          },
        });
        if (!endpoint) active.lastPartialDiagnosticAtMs = endMs;
      }
      return segment;
    } catch (error) {
      this.#recordDiagnostic({
        level: 'error',
        component: 'asr',
        event: 'asr.feed.failed',
        attemptId: input.attemptId,
        fields: {
          generation: input.generation,
          errorCode: safeLocalAsrErrorCode(error),
          acceptedSamples: this.#active?.attemptId === input.attemptId
            && this.#active.generation === input.generation
            ? this.#active.acceptedSamples
            : 0,
        },
      });
      throw error;
    } finally {
      if (activeForMetrics) {
        const durationMs = elapsedMilliseconds(feedStartedAt, this.#now());
        activeForMetrics.feedCount += 1;
        activeForMetrics.feedDurationTotalMs += durationMs;
        activeForMetrics.maximumFeedDurationMs = Math.max(
          activeForMetrics.maximumFeedDurationMs,
          durationMs,
        );
        activeForMetrics.decodeIterationCount += decodeIterations;
      }
    }
  }

  stop(input: { readonly attemptId: string; readonly generation: number }): TranscriptSegment | null {
    const stopStartedAt = this.#now();
    this.#recordDiagnostic({
      level: 'info',
      component: 'asr',
      event: 'asr.attempt.stopping',
      attemptId: input.attemptId,
      fields: { generation: input.generation },
    });
    try {
      const active = this.#requireActive(input);
      active.stream.inputFinished();
      while (this.#recognizer!.isReady(active.stream)) this.#recognizer!.decode(active.stream);
      const text = (this.#recognizer!.getResult(active.stream).text ?? '').trim();
      const emittedAt = new Date().toISOString();
      const endMs = sampleClockMilliseconds(active.acceptedSamples);
      let lastPartialToFinalAudioMs: number | null = null;
      if (text && active.currentLastPartialAudioMs !== null) {
        lastPartialToFinalAudioMs = Math.max(0, endMs - active.currentLastPartialAudioMs);
        active.partialToFinalCount += 1;
        active.partialToFinalTotalMs += lastPartialToFinalAudioMs;
        active.maximumPartialToFinalMs = Math.max(
          active.maximumPartialToFinalMs,
          lastPartialToFinalAudioMs,
        );
      }
      const tail = text
        ? {
            id: `${active.attemptId}-seg-${active.sequence}`,
            attemptId: active.attemptId,
            sequence: active.sequence,
            revision: active.revision + 1,
            text,
            startMs: active.currentSegmentStartMs ?? active.lastFinalEndMs,
            endMs,
            confidence: null,
            isFinal: true,
            emittedAt,
            finalizedAt: emittedAt,
            modelVersion: MODEL_VERSION,
          }
        : null;
      if (tail) {
        this.#recordFinal(input, tail);
        this.#recordDiagnostic({
          level: 'debug',
          component: 'asr',
          event: 'asr.final.emitted',
          attemptId: input.attemptId,
          fields: {
            generation: input.generation,
            sequence: tail.sequence,
            revision: tail.revision,
            characterCount: text.length,
            segmentDurationMs: Math.max(0, tail.endMs - tail.startMs),
            tail: true,
            lastPartialToFinalAudioMs,
          },
        });
      }
      const finalSegmentCount = this.#finalLedgers.get(attemptLedgerKey(input))?.size ?? 0;
      this.#active = null;
      this.#recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.attempt.stopped',
        attemptId: input.attemptId,
        fields: {
          generation: input.generation,
          durationMs: elapsedMilliseconds(stopStartedAt, this.#now()),
          attemptDurationMs: endMs,
          acceptedSamples: active.acceptedSamples,
          finalSegmentCount,
          tailFinalized: tail !== null,
          feedCount: active.feedCount,
          averageFeedDurationMs: averageMetric(
            active.feedDurationTotalMs,
            active.feedCount,
          ),
          maximumFeedDurationMs: active.maximumFeedDurationMs,
          decodeIterationCount: active.decodeIterationCount,
          firstPartialAudioMs: active.firstPartialAudioMs,
          partialGapCount: active.partialGapCount,
          averagePartialGapMs: averageMetric(
            active.partialGapTotalMs,
            active.partialGapCount,
          ),
          maximumPartialGapMs: active.maximumPartialGapMs,
          partialToFinalCount: active.partialToFinalCount,
          averagePartialToFinalMs: averageMetric(
            active.partialToFinalTotalMs,
            active.partialToFinalCount,
          ),
          maximumPartialToFinalMs: active.maximumPartialToFinalMs,
        },
      });
      return tail;
    } catch (error) {
      this.#recordDiagnostic({
        level: 'error',
        component: 'asr',
        event: 'asr.attempt.stop_failed',
        attemptId: input.attemptId,
        fields: {
          generation: input.generation,
          durationMs: elapsedMilliseconds(stopStartedAt, this.#now()),
          errorCode: safeLocalAsrErrorCode(error),
          acceptedSamples: this.#active?.attemptId === input.attemptId
            && this.#active.generation === input.generation
            ? this.#active.acceptedSamples
            : 0,
        },
      });
      throw error;
    }
  }

  getFinalSegments(input: {
    readonly attemptId: string;
    readonly generation: number;
  }): readonly TranscriptSegment[] {
    return [...(this.#finalLedgers.get(attemptLedgerKey(input))?.values() ?? [])]
      .sort((left, right) => left.sequence - right.sequence)
      .map((segment) => ({ ...segment }));
  }

  releaseAttemptLedger(input: {
    readonly attemptId: string;
    readonly generation: number;
  }): void {
    const releasedFinalCount = this.#finalLedgers.get(attemptLedgerKey(input))?.size ?? 0;
    const releasedActiveAttempt = this.#active?.attemptId === input.attemptId
      && this.#active.generation === input.generation;
    this.#finalLedgers.delete(attemptLedgerKey(input));
    if (
      this.#active?.attemptId === input.attemptId
      && this.#active.generation === input.generation
    ) this.#active = null;
    this.#recordDiagnostic({
      level: 'debug',
      component: 'asr',
      event: 'asr.ledger.released',
      attemptId: input.attemptId,
      fields: { generation: input.generation, releasedFinalCount, releasedActiveAttempt },
    });
  }

  cancel(): void {
    const attemptId = this.#active?.attemptId ?? null;
    const generation = this.#active?.generation ?? null;
    const releasedLedgerCount = this.#finalLedgers.size;
    this.#active = null;
    this.#finalLedgers.clear();
    this.#recordDiagnostic({
      level: 'info',
      component: 'asr',
      event: 'asr.service.cancelled',
      attemptId,
      fields: { generation, releasedLedgerCount },
    });
  }

  #recordDiagnostic(input: RecordDiagnosticEventInput): void {
    recordDiagnosticFailOpen(this.#diagnostics, input);
  }

  #recordFinal(
    input: { readonly attemptId: string; readonly generation: number },
    segment: TranscriptSegment,
  ): void {
    if (!segment.isFinal || segment.attemptId !== input.attemptId) {
      throw new LocalAsrServiceError('ASR_FINAL_LEDGER_CONFLICT');
    }
    const key = attemptLedgerKey(input);
    const ledger = this.#finalLedgers.get(key) ?? new Map<string, TranscriptSegment>();
    this.#finalLedgers.set(key, ledger);
    const existing = ledger.get(segment.id);
    if (existing) {
      if (!sameFinalSegment(existing, segment)) {
        throw new LocalAsrServiceError('ASR_FINAL_LEDGER_CONFLICT');
      }
      return;
    }
    if ([...ledger.values()].some((candidate) => candidate.sequence === segment.sequence)) {
      throw new LocalAsrServiceError('ASR_FINAL_LEDGER_CONFLICT');
    }
    ledger.set(segment.id, { ...segment });
  }

  #requireActive(input: { readonly attemptId: string; readonly generation: number }): ActiveAsrAttempt {
    if (
      !this.#active ||
      this.#active.attemptId !== input.attemptId ||
      this.#active.generation !== input.generation
    ) {
      throw new LocalAsrServiceError('STALE_ASR_ATTEMPT');
    }
    return this.#active;
  }

  #createActiveAttempt(
    input: { readonly attemptId: string; readonly generation: number },
    startedAt: number,
  ): ActiveAsrAttempt {
    return {
      attemptId: input.attemptId,
      generation: input.generation,
      startedAt,
      acceptedSamples: 0,
      stream: this.#recognizer!.createStream(),
      sequence: 0,
      revision: 0,
      partialText: '',
      lastPartialDiagnosticAtMs: Number.NEGATIVE_INFINITY,
      currentSegmentStartMs: 0,
      lastFinalEndMs: 0,
      feedCount: 0,
      feedDurationTotalMs: 0,
      maximumFeedDurationMs: 0,
      decodeIterationCount: 0,
      firstPartialAudioMs: null,
      currentLastPartialAudioMs: null,
      partialGapCount: 0,
      partialGapTotalMs: 0,
      maximumPartialGapMs: 0,
      partialToFinalCount: 0,
      partialToFinalTotalMs: 0,
      maximumPartialToFinalMs: 0,
    };
  }

  #ensureRecognizer(): void {
    if (this.#recognizer) return;
    const encoder = path.join(this.#modelRoot, 'encoder.int8.onnx');
    const decoder = path.join(this.#modelRoot, 'decoder.int8.onnx');
    const tokens = path.join(this.#modelRoot, 'tokens.txt');
    if (![encoder, decoder, tokens].every(existsSync)) {
      throw new LocalAsrServiceError('ASR_MODEL_MISSING');
    }
    // eslint-free CommonJS load is required because this native package has no TypeScript declarations.
    const sherpa = this.#loadModule();
    this.#recognizer = new sherpa.OnlineRecognizer(
      createLocalAsrRecognizerConfig(this.#modelRoot),
    );
  }
}

export class LocalAsrServiceError extends Error {
  readonly code: 'ASR_MODEL_MISSING' | 'STALE_ASR_ATTEMPT' | 'ASR_FINAL_LEDGER_CONFLICT';

  constructor(code: LocalAsrServiceError['code']) {
    super(code);
    this.name = 'LocalAsrServiceError';
    this.code = code;
  }
}

function attemptLedgerKey(input: { readonly attemptId: string; readonly generation: number }): string {
  return `${input.attemptId}\u0000${input.generation}`;
}

function sameFinalSegment(left: TranscriptSegment, right: TranscriptSegment): boolean {
  return left.id === right.id
    && left.attemptId === right.attemptId
    && left.sequence === right.sequence
    && left.revision === right.revision
    && left.text === right.text
    && left.startMs === right.startMs
    && left.endMs === right.endMs
    && left.confidence === right.confidence
    && left.isFinal === right.isFinal
    && left.emittedAt === right.emittedAt
    && left.finalizedAt === right.finalizedAt
    && left.modelVersion === right.modelVersion;
}

function safeLocalAsrErrorCode(error: unknown): string {
  return error instanceof LocalAsrServiceError ? error.code : 'ASR_RUNTIME_FAILURE';
}

function elapsedMilliseconds(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

function sampleClockMilliseconds(acceptedSamples: number): number {
  return Math.max(0, Math.round((acceptedSamples / 16_000) * 1_000));
}

function averageMetric(total: number, count: number): number | null {
  return count > 0 ? Math.round(total / count) : null;
}

function recordDiagnosticFailOpen(
  diagnostics: LocalAsrDiagnosticSink | undefined,
  input: RecordDiagnosticEventInput,
): void {
  if (!diagnostics) return;
  try {
    const result = diagnostics.record(input);
    if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Diagnostics must never change the recording or ASR control path.
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as PromiseLike<unknown>).then === 'function';
}
