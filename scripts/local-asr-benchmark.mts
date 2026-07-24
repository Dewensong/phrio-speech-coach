#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  createLocalAsrRecognizerConfig,
  LOCAL_ASR_FROZEN_DIRECT_MODEL_FILES,
  LOCAL_ASR_INSTALL_MANIFEST_NAME,
  LOCAL_ASR_INSTALLATION_ROUTE_NAMES,
  LOCAL_ASR_MODEL_DIRECTORY_NAME,
  LOCAL_ASR_MODEL_ID,
  LOCAL_ASR_MODEL_REVISION,
  LOCAL_ASR_MODEL_VERSION,
  LOCAL_ASR_RECOGNIZER_PROFILE,
  LOCAL_ASR_RUNTIME_FILE_NAMES,
  LOCAL_ASR_SAMPLE_RATE_HZ,
} from '../src/backend/services/local-asr-recognizer-config.ts';
import {
  aggregateErrorRates,
  aggregateKeyTermRecall,
  aggregateRateCounts,
  calculateAccuracyMetrics,
  calculateRealTimeFactor,
  decodePcm16Wav,
  DEFAULT_LOCAL_ASR_CHUNK_MS,
  formatManifestValidationError,
  parseLocalAsrBenchmarkManifest,
  reduceSpeechSpanTiming,
  summarizeDistribution,
  validateSpeechSpans,
  type ErrorRateMetric,
  type LocalAsrAccuracyMetrics,
  type LocalAsrBenchmarkFixture,
  type LocalAsrBenchmarkManifest,
  type NaturalFinalTimelineEvent,
  type PartialTimelineEvent,
} from './lib/local-asr-benchmark.ts';

const DEFAULT_MANIFEST_PATH = path.resolve(
  'fixtures/asr-benchmark/manifest.example.json',
);
const MAXIMUM_WAV_BYTES = 512 * 1_024 * 1_024;
const MAXIMUM_AUDIO_DURATION_MS = 60 * 60 * 1_000;
const PRIVATE_FILE_MODE = 0o600;
const LEGACY_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2';
const LEGACY_ARCHIVE_CHECKSUM_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/checksum.txt';
const LEGACY_ARCHIVE_BYTE_LENGTH = 1_047_319_737;
const LEGACY_ARCHIVE_SHA256 =
  '5462a1fce42693deae572af1e8c4687124b12aa85fe61ff4d3168bb5280e205f';
const requireFromScript = createRequire(import.meta.url);

interface SherpaStream {
  acceptWaveform(input: { readonly samples: Float32Array; readonly sampleRate: number }): void;
  inputFinished(): void;
}

interface SherpaRecognizer {
  createStream(): SherpaStream;
  isReady(stream: SherpaStream): boolean;
  decode(stream: SherpaStream): void;
  getResult(stream: SherpaStream): { readonly text?: string };
  isEndpoint(stream: SherpaStream): boolean;
  reset(stream: SherpaStream): void;
}

interface SherpaModule {
  readonly OnlineRecognizer: new (config: unknown) => SherpaRecognizer;
  readonly version?: string;
}

interface CliOptions {
  readonly manifestPath: string;
  readonly modelDirectory: string;
  readonly outputPath: string | null;
  readonly chunkMsOverride: number | null;
  readonly pretty: boolean;
  readonly help: boolean;
}

interface VerifiedModel {
  readonly directory: string;
  readonly receiptSchemaVersion: 1 | 2;
  readonly modelId: string | null;
  readonly revision: string | null;
  readonly route: string | null;
  readonly installedAt: string;
  readonly files: readonly {
    readonly name: string;
    readonly byteLength: number;
    readonly sha256: string;
  }[];
}

interface MeasuredFixtureResult {
  readonly id: string;
  readonly language: LocalAsrBenchmarkFixture['language'];
  readonly status: 'measured';
  readonly audio: {
    readonly manifestPath: string;
    readonly sourceSha256: string;
    readonly canonicalPcmSha256: string;
    readonly sourceSampleRateHz: number;
    readonly targetSampleRateHz: number;
    readonly channels: number;
    readonly sourceDurationMs: number;
    readonly durationMs: number;
    readonly chunkMs: number;
    readonly chunkSamples: number;
    readonly chunkCount: number;
  };
  readonly reference: string;
  readonly hypothesis: string;
  readonly timing: {
    readonly speechSpans: ReturnType<typeof reduceSpeechSpanTiming>;
    readonly forcedFlush: {
      readonly flushProducedFinal: boolean;
      readonly flushLatencyMs: number;
    };
    readonly processingMs: number;
    readonly rtf: number | null;
    readonly decodeIterations: number;
    readonly latencyTraceHypothesisMatchesRtf: boolean;
  };
  readonly accuracy: LocalAsrAccuracyMetrics;
}

interface SkippedFixtureResult {
  readonly id: string;
  readonly language: LocalAsrBenchmarkFixture['language'];
  readonly status: 'skipped';
  readonly reason: string;
  readonly metrics: null;
}

interface FailedFixtureResult {
  readonly id: string;
  readonly language: LocalAsrBenchmarkFixture['language'];
  readonly status: 'error';
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
  readonly metrics: null;
}

type FixtureResult = MeasuredFixtureResult | SkippedFixtureResult | FailedFixtureResult;

interface RecognitionTrace {
  readonly hypothesis: string;
  readonly partialEvents: readonly PartialTimelineEvent[];
  readonly naturalFinalEvents: readonly NaturalFinalTimelineEvent[];
  readonly flushProducedFinal: boolean;
  readonly flushLatencyMs: number;
  readonly processingMs: number;
  readonly rtf: number | null;
  readonly chunkCount: number;
  readonly decodeIterations: number;
}

interface ReceiptFile {
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const loadedManifest = await loadManifest(options.manifestPath);
  const manifest = loadedManifest.manifest;
  const manifestDirectory = path.dirname(options.manifestPath);
  const skippedResults: SkippedFixtureResult[] = manifest.fixtures
    .filter((fixture) => fixture.skip)
    .map((fixture) => ({
      id: fixture.id,
      language: fixture.language,
      status: 'skipped',
      reason: fixture.skipReason ?? 'Fixture explicitly skipped by manifest',
      metrics: null,
    }));
  const activeFixtures = manifest.fixtures.filter((fixture) => !fixture.skip);

  if (activeFixtures.length === 0) {
    const report = createReport({
      options,
      manifest,
      manifestSha256: loadedManifest.sha256,
      model: null,
      modelLoadMs: null,
      sherpaVersion: null,
      results: skippedResults,
    });
    await emitReport(report, options);
    process.stderr.write(
      'ASR benchmark skipped: the manifest contains no active audio fixtures; no metrics were generated.\n',
    );
    return;
  }

  process.stderr.write(`Verifying installed ASR model: ${options.modelDirectory}\n`);
  const model = await verifyInstalledModel(options.modelDirectory);
  const sherpa = loadSherpaModule();
  const modelLoadStartedAt = performance.now();
  const recognizer = new sherpa.OnlineRecognizer(
    createLocalAsrRecognizerConfig(options.modelDirectory),
  );
  recognizer.createStream();
  const modelLoadMs = roundMilliseconds(performance.now() - modelLoadStartedAt);

  const resultById = new Map<string, FixtureResult>(
    skippedResults.map((result) => [result.id, result]),
  );
  for (const fixture of activeFixtures) {
    process.stderr.write(`Benchmarking fixture ${fixture.id}\n`);
    try {
      const result = await benchmarkFixture({
        fixture,
        manifest,
        manifestDirectory,
        recognizer,
        chunkMsOverride: options.chunkMsOverride,
      });
      resultById.set(fixture.id, result);
    } catch (error) {
      const normalized = normalizeError(error);
      resultById.set(fixture.id, {
        id: fixture.id,
        language: fixture.language,
        status: 'error',
        error: normalized,
        metrics: null,
      });
    }
  }
  const orderedResults = manifest.fixtures.map((fixture) => resultById.get(fixture.id)!);
  const report = createReport({
    options,
    manifest,
    manifestSha256: loadedManifest.sha256,
    model,
    modelLoadMs,
    sherpaVersion: typeof sherpa.version === 'string' ? sherpa.version : null,
    results: orderedResults,
  });
  await emitReport(report, options);
  if (orderedResults.some((result) => result.status === 'error')) process.exitCode = 1;
}

async function benchmarkFixture(input: {
  readonly fixture: LocalAsrBenchmarkFixture;
  readonly manifest: LocalAsrBenchmarkManifest;
  readonly manifestDirectory: string;
  readonly recognizer: SherpaRecognizer;
  readonly chunkMsOverride: number | null;
}): Promise<MeasuredFixtureResult> {
  const audioPath = path.resolve(input.manifestDirectory, input.fixture.audio);
  assertPathContainedBy(input.manifestDirectory, audioPath);
  assertPathContainedBy(
    await realpath(input.manifestDirectory),
    await realpath(audioPath),
  );
  const metadata = await lstat(audioPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('WAV_NOT_REGULAR_FILE');
  if (metadata.size <= 0 || metadata.size > MAXIMUM_WAV_BYTES) {
    throw new Error('WAV_FILE_SIZE_OUT_OF_RANGE');
  }
  const wavBuffer = await readFile(audioPath);
  const sourceSha256 = sha256Buffer(wavBuffer);
  if (input.fixture.audioSha256 && input.fixture.audioSha256 !== sourceSha256) {
    throw new Error('WAV_SHA256_MISMATCH');
  }
  const decoded = decodePcm16Wav(wavBuffer, LOCAL_ASR_SAMPLE_RATE_HZ);
  if (decoded.durationMs <= 0 || decoded.durationMs > MAXIMUM_AUDIO_DURATION_MS) {
    throw new Error('WAV_DURATION_OUT_OF_RANGE');
  }
  const speechSpanErrors = validateSpeechSpans(
    input.fixture.speechSpans,
    decoded.samples.length,
  );
  if (speechSpanErrors.length > 0) {
    throw new Error(`SPEECH_SPANS_OUT_OF_BOUNDS:${speechSpanErrors.join('|')}`);
  }
  const chunkMs = input.chunkMsOverride
    ?? input.fixture.chunkMs
    ?? input.manifest.defaults.chunkMs;
  const chunkSamples = Math.max(
    1,
    Math.round((chunkMs * LOCAL_ASR_SAMPLE_RATE_HZ) / 1_000),
  );
  const latencyTrace = await recognizeChunked(
    input.recognizer,
    decoded.samples,
    chunkSamples,
    true,
  );
  const rtfTrace = await recognizeChunked(
    input.recognizer,
    decoded.samples,
    chunkSamples,
    false,
  );
  const speechSpanTiming = reduceSpeechSpanTiming({
    partials: latencyTrace.partialEvents,
    naturalFinals: latencyTrace.naturalFinalEvents,
    speechSpans: input.fixture.speechSpans,
    sampleRateHz: LOCAL_ASR_SAMPLE_RATE_HZ,
  });
  return {
    id: input.fixture.id,
    language: input.fixture.language,
    status: 'measured',
    audio: {
      manifestPath: input.fixture.audio,
      sourceSha256,
      canonicalPcmSha256: sha256Buffer(Buffer.from(
        decoded.samples.buffer,
        decoded.samples.byteOffset,
        decoded.samples.byteLength,
      )),
      sourceSampleRateHz: decoded.sourceSampleRateHz,
      targetSampleRateHz: decoded.targetSampleRateHz,
      channels: decoded.channels,
      sourceDurationMs: decoded.durationMs,
      durationMs: roundMilliseconds(
        (decoded.samples.length / decoded.targetSampleRateHz) * 1_000,
      ),
      chunkMs,
      chunkSamples,
      chunkCount: rtfTrace.chunkCount,
    },
    reference: input.fixture.reference,
    hypothesis: rtfTrace.hypothesis,
    timing: {
      speechSpans: speechSpanTiming,
      forcedFlush: {
        flushProducedFinal: latencyTrace.flushProducedFinal,
        flushLatencyMs: latencyTrace.flushLatencyMs,
      },
      processingMs: rtfTrace.processingMs,
      rtf: rtfTrace.rtf,
      decodeIterations: rtfTrace.decodeIterations,
      latencyTraceHypothesisMatchesRtf: latencyTrace.hypothesis === rtfTrace.hypothesis,
    },
    accuracy: calculateAccuracyMetrics(
      input.fixture.language,
      input.fixture.reference,
      rtfTrace.hypothesis,
      input.fixture.keyTerms,
    ),
  };
}

async function recognizeChunked(
  recognizer: SherpaRecognizer,
  samples: Float32Array,
  chunkSamples: number,
  paced: boolean,
): Promise<RecognitionTrace> {
  const stream = recognizer.createStream();
  const startedAt = performance.now();
  const partialEvents: PartialTimelineEvent[] = [];
  const naturalFinalEvents: NaturalFinalTimelineEvent[] = [];
  const finalTexts: string[] = [];
  let currentPartialText = '';
  let segmentIndex = 0;
  let chunkCount = 0;
  let decodeIterations = 0;

  for (let offset = 0; offset < samples.length; offset += chunkSamples) {
    const chunk = samples.subarray(offset, Math.min(samples.length, offset + chunkSamples));
    const audioSample = offset + chunk.length;
    const audioMs = (audioSample / LOCAL_ASR_SAMPLE_RATE_HZ) * 1_000;
    if (paced) await waitUntil(startedAt + audioMs);
    stream.acceptWaveform({ samples: chunk, sampleRate: LOCAL_ASR_SAMPLE_RATE_HZ });
    chunkCount += 1;
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
      decodeIterations += 1;
    }
    const text = (recognizer.getResult(stream).text ?? '').trim();
    const endpoint = recognizer.isEndpoint(stream);
    if (!text) continue;
    if (endpoint) {
      naturalFinalEvents.push({
        text,
        audioSample,
        wallMs: performance.now() - startedAt,
      });
      finalTexts.push(text);
      recognizer.reset(stream);
      segmentIndex += 1;
      currentPartialText = '';
      continue;
    }
    if (text === currentPartialText) continue;
    currentPartialText = text;
    partialEvents.push({
      text,
      segmentIndex,
      audioSample,
      wallMs: performance.now() - startedAt,
    });
  }

  const finalizationStartedAt = performance.now();
  stream.inputFinished();
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream);
    decodeIterations += 1;
  }
  const tailText = (recognizer.getResult(stream).text ?? '').trim();
  if (tailText) {
    finalTexts.push(tailText);
  }
  const completedAt = performance.now();
  const processingMs = roundMilliseconds(completedAt - startedAt);
  const audioDurationMs = (samples.length / LOCAL_ASR_SAMPLE_RATE_HZ) * 1_000;
  return {
    hypothesis: finalTexts.join(' ').replace(/\s+/gu, ' ').trim(),
    partialEvents,
    naturalFinalEvents,
    flushProducedFinal: tailText.length > 0,
    flushLatencyMs: roundMilliseconds(completedAt - finalizationStartedAt),
    processingMs,
    rtf: calculateRealTimeFactor(processingMs, audioDurationMs),
    chunkCount,
    decodeIterations,
  };
}

function createReport(input: {
  readonly options: CliOptions;
  readonly manifest: LocalAsrBenchmarkManifest;
  readonly manifestSha256: string;
  readonly model: VerifiedModel | null;
  readonly modelLoadMs: number | null;
  readonly sherpaVersion: string | null;
  readonly results: readonly FixtureResult[];
}): object {
  const measured = input.results.filter(
    (result): result is MeasuredFixtureResult => result.status === 'measured',
  );
  const errors = input.results.filter((result) => result.status === 'error').length;
  const skipped = input.results.filter((result) => result.status === 'skipped').length;
  const status = errors > 0
    ? (measured.length > 0 ? 'partial' : 'failed')
    : measured.length > 0
      ? 'completed'
      : 'skipped';
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    methodology: {
      offline: true,
      streamingChunks: true,
      realtimePacing: { latencyRun: true, rtfRun: false },
      timingClock: 'monotonic_wall_clock',
      latencyRun: 'model-warm, 1.0x paced chunk delivery using a monotonic clock',
      rtfRun: 'separate model-warm unpaced pass over the same canonical PCM',
      speechSpanClock: 'manifest startSample inclusive and endSample exclusive on canonical 16 kHz mono PCM',
      firstPartial: 'first changed non-final hypothesis emitted inside each annotated speech span; latency is measured from that span onset',
      partialGap: 'paced-wall-clock onset-to-first, changed-partial inter-update, and last-to-offset gaps inside each annotated active-speech span; never inferred from the delivered chunk cursor',
      finalLatency: 'first one-to-one natural endpoint after each annotated speech offset and before the next onset; misses and forced flush remain separate',
      rtf: 'per-utterance processing wall time divided by decoded audio duration; model load excluded',
      canonicalPcmHashEncoding: `float32-${os.endianness().toLocaleLowerCase('en-US')}`,
    },
    manifest: {
      path: displayPath(input.options.manifestPath),
      sha256: input.manifestSha256,
      description: input.manifest.description ?? null,
    },
    model: input.model
      ? {
          ...input.model,
          directory: input.options.modelDirectory,
          sherpaVersion: input.sherpaVersion,
          modelLoadMs: input.modelLoadMs,
          modelVersion: LOCAL_ASR_MODEL_VERSION,
          recognizerProfile: LOCAL_ASR_RECOGNIZER_PROFILE,
          recognizerProfileSha256: sha256Buffer(
            Buffer.from(JSON.stringify(LOCAL_ASR_RECOGNIZER_PROFILE), 'utf8'),
          ),
          runtime: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
          },
        }
      : null,
    results: input.results,
    summary: {
      total: input.results.length,
      measured: measured.length,
      skipped,
      errors,
      timing: measured.length > 0
        ? {
            firstPartialLatencyMs: summarizeDistribution(
              measured.flatMap((result) => result.timing.speechSpans.spans.flatMap((span) =>
                span.firstPartial ? [span.firstPartial.wallLatencyMs] : [])),
            ),
            activeSpeechGapMs: summarizeDistribution(
              measured.flatMap((result) => result.timing.speechSpans.spans.flatMap(
                (span) => span.activeSpeechGapsMs,
              )),
            ),
            perSpanMaximumActiveSpeechGapMs: summarizeDistribution(
              measured.flatMap((result) => result.timing.speechSpans.spans.map(
                (span) => span.maximumActiveSpeechGapMs,
              )),
            ),
            naturalFinalLatencyMs: summarizeDistribution(
              measured.flatMap((result) => result.timing.speechSpans.spans.flatMap((span) =>
                span.naturalFinal ? [span.naturalFinal.wallLatencyMs] : [])),
            ),
            firstPartialMisses: aggregateRateCounts(
              measured.map((result) => result.timing.speechSpans.firstPartialMisses),
            ),
            naturalFinalMisses: aggregateRateCounts(
              measured.map((result) => result.timing.speechSpans.naturalFinalMisses),
            ),
            flushLatencyMs: summarizeDistribution(
              measured.map((result) => result.timing.forcedFlush.flushLatencyMs),
            ),
            forcedFlushProducedFinalFixtureCount: measured.filter(
              (result) => result.timing.forcedFlush.flushProducedFinal,
            ).length,
            rtf: summarizeDistribution(
              measured.flatMap((result) => result.timing.rtf === null
                ? []
                : [result.timing.rtf]),
            ),
            microRtf: calculateRealTimeFactor(
              measured.reduce((total, result) => total + result.timing.processingMs, 0),
              measured.reduce((total, result) => total + result.audio.durationMs, 0),
            ),
          }
        : null,
      accuracy: measured.length > 0 ? summarizeAccuracy(measured) : null,
    },
  };
}

function summarizeAccuracy(results: readonly MeasuredFixtureResult[]): object {
  const languageResults = (language: LocalAsrBenchmarkFixture['language']) =>
    results.filter((result) => result.language === language);
  const zh = languageResults('zh');
  const en = languageResults('en');
  const mixed = languageResults('mixed');
  return {
    zh: zh.length > 0
      ? { fixtureCount: zh.length, cer: aggregateMetric(zh, 'zhCer') }
      : null,
    en: en.length > 0
      ? { fixtureCount: en.length, wer: aggregateMetric(en, 'enWer') }
      : null,
    mixed: mixed.length > 0
      ? {
          fixtureCount: mixed.length,
          mer: aggregateMetric(mixed, 'mixedMer'),
          hanCer: aggregateMetric(mixed, 'zhCer'),
          englishTokenWer: aggregateMetric(mixed, 'enWer'),
          keyTermRecall: aggregateKeyTermRecall(
            mixed.map((result) => result.accuracy.keyTermRecall),
          ),
        }
      : null,
  };
}

function aggregateMetric(
  results: readonly MeasuredFixtureResult[],
  key: 'zhCer' | 'enWer' | 'mixedMer',
): ErrorRateMetric | null {
  return aggregateErrorRates(results.map((result) => result.accuracy[key]));
}

async function loadManifest(manifestPath: string): Promise<{
  readonly manifest: LocalAsrBenchmarkManifest;
  readonly sha256: string;
}> {
  let serialized: Buffer;
  try {
    serialized = await readFile(manifestPath);
  } catch (error) {
    throw new Error(`BENCHMARK_MANIFEST_READ_FAILED: ${safeErrorMessage(error)}`);
  }
  try {
    return {
      manifest: parseLocalAsrBenchmarkManifest(JSON.parse(serialized.toString('utf8'))),
      sha256: sha256Buffer(serialized),
    };
  } catch (error) {
    throw new Error(`BENCHMARK_MANIFEST_INVALID: ${formatManifestValidationError(error)}`);
  }
}

async function verifyInstalledModel(modelDirectory: string): Promise<VerifiedModel> {
  const receiptPath = path.join(modelDirectory, LOCAL_ASR_INSTALL_MANIFEST_NAME);
  const receiptMetadata = await lstat(receiptPath).catch(() => null);
  if (
    !receiptMetadata
    || !receiptMetadata.isFile()
    || receiptMetadata.isSymbolicLink()
    || receiptMetadata.nlink !== 1
    || receiptMetadata.size < 2
    || receiptMetadata.size > 64 * 1_024
  ) throw new Error('ASR_MODEL_RECEIPT_MISSING_OR_INVALID');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown;
  if (!isRecord(receipt) || (receipt.schemaVersion !== 1 && receipt.schemaVersion !== 2)) {
    throw new Error('ASR_MODEL_RECEIPT_SCHEMA_UNSUPPORTED');
  }
  if (receipt.schemaVersion === 2) {
    if (
      receipt.modelId !== LOCAL_ASR_MODEL_ID
      || receipt.revision !== LOCAL_ASR_MODEL_REVISION
      || typeof receipt.route !== 'string'
      || !(LOCAL_ASR_INSTALLATION_ROUTE_NAMES as readonly string[]).includes(receipt.route)
    ) {
      throw new Error('ASR_MODEL_RECEIPT_IDENTITY_MISMATCH');
    }
  } else if (
    !isRecord(receipt.source)
    || receipt.source.archiveUrl !== LEGACY_ARCHIVE_URL
    || receipt.source.checksumUrl !== LEGACY_ARCHIVE_CHECKSUM_URL
    || receipt.source.archiveByteLength !== LEGACY_ARCHIVE_BYTE_LENGTH
    || receipt.source.archiveSha256 !== LEGACY_ARCHIVE_SHA256
  ) {
    throw new Error('ASR_MODEL_RECEIPT_IDENTITY_MISMATCH');
  }
  if (typeof receipt.installedAt !== 'string' || !Number.isFinite(Date.parse(receipt.installedAt))) {
    throw new Error('ASR_MODEL_RECEIPT_INSTALLED_AT_INVALID');
  }
  if (!Array.isArray(receipt.files) || receipt.files.length !== LOCAL_ASR_RUNTIME_FILE_NAMES.length) {
    throw new Error('ASR_MODEL_RECEIPT_FILES_INVALID');
  }
  const receiptFiles = receipt.files.map(parseReceiptFile);
  const byName = new Map(receiptFiles.map((file) => [file.name, file]));
  if (
    byName.size !== LOCAL_ASR_RUNTIME_FILE_NAMES.length
    || LOCAL_ASR_RUNTIME_FILE_NAMES.some((name) => !byName.has(name))
  ) throw new Error('ASR_MODEL_RECEIPT_FILES_INVALID');
  if (
    receipt.schemaVersion === 2
    && (receipt.route === 'huggingface_direct' || receipt.route === 'accelerated_direct')
    && LOCAL_ASR_FROZEN_DIRECT_MODEL_FILES.some((expected) => {
      const actual = byName.get(expected.name);
      return actual?.byteLength !== expected.byteLength || actual.sha256 !== expected.sha256;
    })
  ) throw new Error('ASR_MODEL_RECEIPT_FILES_INVALID');

  for (const name of LOCAL_ASR_RUNTIME_FILE_NAMES) {
    const expected = byName.get(name)!;
    const filePath = path.join(modelDirectory, name);
    const metadata = await lstat(filePath).catch(() => null);
    if (
      !metadata
      || !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size !== expected.byteLength
    ) throw new Error(`ASR_MODEL_FILE_INVALID:${name}`);
    const sha256 = await sha256File(filePath);
    if (sha256 !== expected.sha256) throw new Error(`ASR_MODEL_FILE_HASH_MISMATCH:${name}`);
  }

  return {
    directory: modelDirectory,
    receiptSchemaVersion: receipt.schemaVersion,
    modelId: receipt.schemaVersion === 2 ? String(receipt.modelId) : null,
    revision: receipt.schemaVersion === 2 ? String(receipt.revision) : null,
    route: receipt.schemaVersion === 2 && typeof receipt.route === 'string'
      ? receipt.route
      : receipt.schemaVersion === 1
        ? 'github_release_archive'
        : null,
    installedAt: receipt.installedAt,
    files: LOCAL_ASR_RUNTIME_FILE_NAMES.map((name) => byName.get(name)!),
  };
}

function parseReceiptFile(input: unknown): ReceiptFile {
  if (
    !isRecord(input)
    || typeof input.name !== 'string'
    || !LOCAL_ASR_RUNTIME_FILE_NAMES.includes(input.name as (typeof LOCAL_ASR_RUNTIME_FILE_NAMES)[number])
    || typeof input.byteLength !== 'number'
    || !Number.isSafeInteger(input.byteLength)
    || input.byteLength <= 0
    || typeof input.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(input.sha256)
  ) throw new Error('ASR_MODEL_RECEIPT_FILES_INVALID');
  return { name: input.name, byteLength: input.byteLength, sha256: input.sha256 };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function loadSherpaModule(): SherpaModule {
  const module = requireFromScript('sherpa-onnx-node') as SherpaModule;
  if (typeof module.OnlineRecognizer !== 'function') {
    throw new Error('SHERPA_ONNX_NODE_RECOGNIZER_MISSING');
  }
  return module;
}

function parseCliOptions(args: readonly string[]): CliOptions {
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let modelDirectory = defaultModelDirectory();
  let outputPath: string | null = null;
  let chunkMsOverride: number | null = null;
  let pretty = true;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      continue;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--compact') {
      pretty = false;
    } else if (argument === '--manifest') {
      manifestPath = path.resolve(requireArgumentValue(args, ++index, '--manifest'));
    } else if (argument === '--model-dir') {
      modelDirectory = path.resolve(requireArgumentValue(args, ++index, '--model-dir'));
    } else if (argument === '--output') {
      outputPath = path.resolve(requireArgumentValue(args, ++index, '--output'));
    } else if (argument === '--chunk-ms') {
      const parsed = Number(requireArgumentValue(args, ++index, '--chunk-ms'));
      if (!Number.isInteger(parsed) || parsed < 20 || parsed > 1_000) {
        throw new Error('--chunk-ms must be an integer between 20 and 1000');
      }
      chunkMsOverride = parsed;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { manifestPath, modelDirectory, outputPath, chunkMsOverride, pretty, help };
}

function defaultModelDirectory(): string {
  const environmentOverride = process.env.PHRIO_ASR_MODEL_DIR?.trim();
  if (environmentOverride) return path.resolve(environmentOverride);
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Phrio',
      'models',
      LOCAL_ASR_MODEL_DIRECTORY_NAME,
    );
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(
      process.env.APPDATA,
      'Phrio',
      'models',
      LOCAL_ASR_MODEL_DIRECTORY_NAME,
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'Phrio',
    'models',
    LOCAL_ASR_MODEL_DIRECTORY_NAME,
  );
}

async function emitReport(report: object, options: CliOptions): Promise<void> {
  const serialized = `${JSON.stringify(report, null, options.pretty ? 2 : 0)}\n`;
  if (!options.outputPath) {
    process.stdout.write(serialized);
    return;
  }
  await mkdir(path.dirname(options.outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${options.outputPath}.${process.pid}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, options.outputPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  process.stderr.write(`Wrote ASR benchmark report: ${options.outputPath}\n`);
}

function assertPathContainedBy(parentDirectory: string, candidatePath: string): void {
  const relative = path.relative(path.resolve(parentDirectory), path.resolve(candidatePath));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('FIXTURE_AUDIO_PATH_ESCAPES_MANIFEST_DIRECTORY');
  }
}

function requireArgumentValue(
  args: readonly string[],
  index: number,
  optionName: string,
): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${optionName} requires a value`);
  return value;
}

function normalizeError(error: unknown): { readonly code: string; readonly message: string } {
  const message = safeErrorMessage(error);
  const explicitCode = message.match(/^[A-Z][A-Z0-9_]*(?=[: ]|$)/u)?.[0];
  return {
    code: explicitCode ?? 'ASR_BENCHMARK_FIXTURE_FAILED',
    message,
  };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function displayPath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  return relative && !relative.startsWith(`..${path.sep}`) ? relative : filePath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

async function waitUntil(targetMs: number): Promise<void> {
  while (true) {
    const remainingMs = targetMs - performance.now();
    if (remainingMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remainingMs, 50)));
  }
}

function helpText(): string {
  return `Phrio offline local-ASR benchmark\n\nUsage:\n  pnpm benchmark:asr -- [options]\n\nOptions:\n  --manifest <path>   Fixture manifest JSON (default: fixtures/asr-benchmark/manifest.example.json)\n  --model-dir <path>  Installed model directory (default: Phrio userData model directory)\n  --output <path>     Atomically write JSON report instead of stdout\n  --chunk-ms <20-1000> Override manifest chunk duration (default: ${DEFAULT_LOCAL_ASR_CHUNK_MS} ms)\n  --compact           Emit compact JSON\n  -h, --help          Show this help\n\nThe tool is offline and never downloads a model or sends audio/transcripts over the network.\n`;
}

void main().catch((error) => {
  process.stderr.write(`ASR benchmark failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
