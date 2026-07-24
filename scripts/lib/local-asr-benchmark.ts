import path from 'node:path';

import { z } from 'zod';

export const LOCAL_ASR_BENCHMARK_SCHEMA_VERSION = 1 as const;
export const LOCAL_ASR_BENCHMARK_LANGUAGES = ['zh', 'en', 'mixed'] as const;
export const DEFAULT_LOCAL_ASR_CHUNK_MS = 64;

export type LocalAsrBenchmarkLanguage =
  (typeof LOCAL_ASR_BENCHMARK_LANGUAGES)[number];

export interface LocalAsrBenchmarkFixture {
  readonly id: string;
  readonly audio: string;
  readonly audioSha256?: string;
  readonly reference: string;
  readonly language: LocalAsrBenchmarkLanguage;
  readonly speechSpans: readonly LocalAsrSpeechSpan[];
  readonly keyTerms: readonly LocalAsrKeyTermAnnotation[];
  readonly chunkMs?: number;
  readonly skip: boolean;
  readonly skipReason?: string;
}

export interface LocalAsrSpeechSpan {
  /** Inclusive sample index on the canonical 16 kHz mono PCM clock. */
  readonly startSample: number;
  /** Exclusive sample index on the canonical 16 kHz mono PCM clock. */
  readonly endSample: number;
}

export interface LocalAsrKeyTermAnnotation {
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly occurrences: number;
}

export interface LocalAsrBenchmarkManifest {
  readonly schemaVersion: typeof LOCAL_ASR_BENCHMARK_SCHEMA_VERSION;
  readonly description?: string;
  readonly defaults: {
    readonly chunkMs: number;
  };
  readonly fixtures: readonly LocalAsrBenchmarkFixture[];
}

export interface ErrorRateMetric {
  readonly edits: number;
  readonly referenceUnits: number;
  readonly hypothesisUnits: number;
  readonly rate: number | null;
}

export interface KeyTermRecallMetric {
  readonly matchedOccurrences: number;
  readonly annotatedOccurrences: number;
  readonly recall: number | null;
  readonly precision: number | null;
  readonly hallucinatedOccurrences: number;
  readonly terms: readonly {
    readonly canonical: string;
    readonly aliases: readonly string[];
    readonly annotatedOccurrences: number;
    readonly observedOccurrences: number;
    readonly matchedOccurrences: number;
    readonly hallucinatedOccurrences: number;
  }[];
}

export interface LocalAsrAccuracyMetrics {
  readonly zhCer: ErrorRateMetric | null;
  readonly enWer: ErrorRateMetric | null;
  readonly mixedMer: ErrorRateMetric | null;
  readonly keyTermRecall: KeyTermRecallMetric | null;
}

export interface PartialTimelineEvent {
  readonly text: string;
  readonly segmentIndex: number;
  readonly audioSample: number;
  readonly wallMs: number;
}

export interface NaturalFinalTimelineEvent {
  readonly text: string;
  readonly audioSample: number;
  readonly wallMs: number;
}

export interface DistributionSummary {
  readonly count: number;
  readonly average: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly maximum: number | null;
}

export interface SpeechSpanTimingSummary {
  readonly spans: readonly {
    readonly spanIndex: number;
    readonly startSample: number;
    readonly endSample: number;
    readonly durationMs: number;
    readonly firstPartial: {
      readonly text: string;
      readonly audioSample: number;
      readonly wallLatencyMs: number;
    } | null;
    readonly activeSpeechGapsMs: readonly number[];
    readonly maximumActiveSpeechGapMs: number;
    readonly naturalFinal: {
      readonly text: string;
      readonly audioSample: number;
      readonly wallLatencyMs: number;
    } | null;
  }[];
  readonly firstPartialLatencyMs: DistributionSummary;
  readonly activeSpeechGapMs: DistributionSummary;
  readonly perSpanMaximumActiveSpeechGapMs: DistributionSummary;
  readonly naturalFinalLatencyMs: DistributionSummary;
  readonly firstPartialMisses: RateCount;
  readonly naturalFinalMisses: RateCount;
  readonly outsideActiveSpeechPartialCount: number;
  readonly unmatchedNaturalFinalCount: number;
}

export interface RateCount {
  readonly count: number;
  readonly total: number;
  readonly rate: number | null;
}

export interface DecodedPcm16Wav {
  readonly samples: Float32Array;
  readonly sourceSampleRateHz: number;
  readonly targetSampleRateHz: number;
  readonly channels: number;
  readonly sourceFrameCount: number;
  readonly durationMs: number;
}

const speechSpanSchema = z.object({
  startSample: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  endSample: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

const keyTermSchema = z.object({
  canonical: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  occurrences: z.number().int().min(1).max(1_000),
}).strict();

const fixtureSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  audio: z.string().trim().min(1).max(512),
  audioSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  reference: z.string().trim().min(1).max(50_000),
  language: z.enum(LOCAL_ASR_BENCHMARK_LANGUAGES),
  speechSpans: z.array(speechSpanSchema).max(1_000).default([]),
  keyTerms: z.array(keyTermSchema).max(200).default([]),
  chunkMs: z.number().int().min(20).max(1_000).optional(),
  skip: z.boolean().default(false),
  skipReason: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((fixture, context) => {
  if (!isSafeRelativeFixturePath(fixture.audio)) {
    context.addIssue({
      code: 'custom',
      path: ['audio'],
      message: 'audio must be a relative path contained by the manifest directory',
    });
  }
  if (fixture.skip && !fixture.skipReason) {
    context.addIssue({
      code: 'custom',
      path: ['skipReason'],
      message: 'skipReason is required when skip is true',
    });
  }
  const spanErrors = validateSpeechSpans(fixture.speechSpans);
  spanErrors.forEach((message) => {
    context.addIssue({
      code: 'custom',
      path: ['speechSpans'],
      message,
    });
  });
  if (!fixture.skip && fixture.speechSpans.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['speechSpans'],
      message: 'active fixtures require at least one canonical-PCM speech span',
    });
  }
  if (fixture.language === 'zh' && tokenizeZhCharacters(fixture.reference).length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['reference'],
      message: 'zh reference must contain at least one letter or number',
    });
  }
  if (fixture.language === 'en' && tokenizeEnglish(fixture.reference).length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['reference'],
      message: 'en reference must contain at least one English token',
    });
  }
  if (fixture.language === 'mixed') {
    if (tokenizeHanCharacters(fixture.reference).length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['reference'],
        message: 'mixed reference must contain at least one Han character',
      });
    }
    if (tokenizeEnglish(fixture.reference).length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['reference'],
        message: 'mixed reference must contain at least one English token',
      });
    }
    if (fixture.keyTerms.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['keyTerms'],
        message: 'mixed fixtures require at least one explicitly reviewed key term',
      });
    }
  }
  const patternOwners = new Map<string, number>();
  fixture.keyTerms.forEach((term, termIndex) => {
    const patterns = [term.canonical, ...term.aliases];
    const localPatterns = new Set<string>();
    patterns.forEach((pattern, patternIndex) => {
      const normalized = normalizeKeyTerm(pattern);
      if (
        !normalized
        || !tokenizeKeyTermUnits(pattern).some(isKeyTermLexicalUnit)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['keyTerms', termIndex, patternIndex === 0 ? 'canonical' : 'aliases'],
          message: 'key-term patterns must contain Han, Latin, or numeric units',
        });
        return;
      }
      if (localPatterns.has(normalized) || patternOwners.has(normalized)) {
        context.addIssue({
          code: 'custom',
          path: ['keyTerms', termIndex, patternIndex === 0 ? 'canonical' : 'aliases'],
          message: 'canonical and aliases must be globally unique after normalization',
        });
      }
      localPatterns.add(normalized);
      patternOwners.set(normalized, termIndex);
    });
  });
  if (fixture.keyTerms.length > 0 && patternOwners.size > 0) {
    const referenceMatches = matchAnnotatedKeyTerms(fixture.keyTerms, fixture.reference);
    referenceMatches.terms.forEach((term, index) => {
      if (term.observedOccurrences !== term.annotatedOccurrences) {
        context.addIssue({
          code: 'custom',
          path: ['keyTerms', index, 'occurrences'],
          message: `annotated occurrences ${term.annotatedOccurrences} do not match reference occurrences ${term.observedOccurrences}`,
        });
      }
    });
  }
});

const manifestSchema = z.object({
  $schema: z.string().trim().min(1).optional(),
  schemaVersion: z.literal(LOCAL_ASR_BENCHMARK_SCHEMA_VERSION),
  description: z.string().trim().min(1).max(2_000).optional(),
  defaults: z.object({
    chunkMs: z.number().int().min(20).max(1_000).default(DEFAULT_LOCAL_ASR_CHUNK_MS),
  }).strict().default({ chunkMs: DEFAULT_LOCAL_ASR_CHUNK_MS }),
  fixtures: z.array(fixtureSchema).min(1).max(10_000),
}).strict().superRefine((manifest, context) => {
  const ids = new Set<string>();
  manifest.fixtures.forEach((fixture, index) => {
    if (ids.has(fixture.id)) {
      context.addIssue({
        code: 'custom',
        path: ['fixtures', index, 'id'],
        message: `duplicate fixture id: ${fixture.id}`,
      });
    }
    ids.add(fixture.id);
  });
});

export function parseLocalAsrBenchmarkManifest(input: unknown): LocalAsrBenchmarkManifest {
  const parsed = manifestSchema.parse(input);
  return {
    schemaVersion: parsed.schemaVersion,
    ...(parsed.description ? { description: parsed.description } : {}),
    defaults: parsed.defaults,
    fixtures: parsed.fixtures.map((fixture) => ({
      ...fixture,
      speechSpans: fixture.speechSpans.map((span) => ({ ...span })),
      keyTerms: fixture.keyTerms.map((term) => ({
        ...term,
        aliases: [...term.aliases],
      })),
    })),
  };
}

export function formatManifestValidationError(error: unknown): string {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error.message : 'Unknown manifest validation error';
  }
  return error.issues
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join('; ');
}

export function calculateAccuracyMetrics(
  language: LocalAsrBenchmarkLanguage,
  reference: string,
  hypothesis: string,
  keyTerms: readonly LocalAsrKeyTermAnnotation[] = [],
): LocalAsrAccuracyMetrics {
  if (language === 'zh') {
    return {
      zhCer: calculateErrorRate(
        tokenizeZhCharacters(reference),
        tokenizeZhCharacters(hypothesis),
      ),
      enWer: null,
      mixedMer: null,
      keyTermRecall: null,
    };
  }
  if (language === 'en') {
    return {
      zhCer: null,
      enWer: calculateErrorRate(tokenizeEnWerUnits(reference), tokenizeEnWerUnits(hypothesis)),
      mixedMer: null,
      keyTermRecall: null,
    };
  }
  return {
    zhCer: calculateErrorRate(
      tokenizeHanCharacters(reference),
      tokenizeHanCharacters(hypothesis),
    ),
    enWer: calculateErrorRate(tokenizeEnglish(reference), tokenizeEnglish(hypothesis)),
    mixedMer: calculateErrorRate(tokenizeMixedUnits(reference), tokenizeMixedUnits(hypothesis)),
    keyTermRecall: calculateKeyTermRecall(keyTerms, hypothesis),
  };
}

export function calculateErrorRate(
  referenceUnits: readonly string[],
  hypothesisUnits: readonly string[],
): ErrorRateMetric {
  const edits = levenshteinDistance(referenceUnits, hypothesisUnits);
  return {
    edits,
    referenceUnits: referenceUnits.length,
    hypothesisUnits: hypothesisUnits.length,
    rate: referenceUnits.length > 0 ? roundMetric(edits / referenceUnits.length) : null,
  };
}

export function aggregateErrorRates(
  metrics: readonly (ErrorRateMetric | null)[],
): ErrorRateMetric | null {
  const available = metrics.filter((metric): metric is ErrorRateMetric => metric !== null);
  if (available.length === 0) return null;
  const totals = available.reduce(
    (accumulator, metric) => ({
      edits: accumulator.edits + metric.edits,
      referenceUnits: accumulator.referenceUnits + metric.referenceUnits,
      hypothesisUnits: accumulator.hypothesisUnits + metric.hypothesisUnits,
    }),
    { edits: 0, referenceUnits: 0, hypothesisUnits: 0 },
  );
  return {
    ...totals,
    rate: totals.referenceUnits > 0
      ? roundMetric(totals.edits / totals.referenceUnits)
      : null,
  };
}

export function calculateKeyTermRecall(
  keyTerms: readonly LocalAsrKeyTermAnnotation[],
  hypothesis: string,
): KeyTermRecallMetric {
  return matchAnnotatedKeyTerms(keyTerms, hypothesis);
}

export function aggregateKeyTermRecall(
  metrics: readonly (KeyTermRecallMetric | null)[],
): Pick<
  KeyTermRecallMetric,
  | 'matchedOccurrences'
  | 'annotatedOccurrences'
  | 'recall'
  | 'precision'
  | 'hallucinatedOccurrences'
> | null {
  const available = metrics.filter((metric): metric is KeyTermRecallMetric => metric !== null);
  if (available.length === 0) return null;
  const matched = available.reduce(
    (total, metric) => total + metric.matchedOccurrences,
    0,
  );
  const annotated = available.reduce(
    (total, metric) => total + metric.annotatedOccurrences,
    0,
  );
  const hallucinated = available.reduce(
    (total, metric) => total + metric.hallucinatedOccurrences,
    0,
  );
  return {
    matchedOccurrences: matched,
    annotatedOccurrences: annotated,
    recall: annotated > 0 ? roundMetric(matched / annotated) : null,
    precision: matched + hallucinated > 0
      ? roundMetric(matched / (matched + hallucinated))
      : null,
    hallucinatedOccurrences: hallucinated,
  };
}

export function aggregateRateCounts(counts: readonly RateCount[]): RateCount | null {
  if (counts.length === 0) return null;
  const count = counts.reduce((total, item) => total + item.count, 0);
  const total = counts.reduce((sum, item) => sum + item.total, 0);
  return rateCount(count, total);
}

export function levenshteinDistance(
  referenceUnits: readonly string[],
  hypothesisUnits: readonly string[],
): number {
  if (referenceUnits.length === 0) return hypothesisUnits.length;
  if (hypothesisUnits.length === 0) return referenceUnits.length;
  let shorter = referenceUnits;
  let longer = hypothesisUnits;
  if (referenceUnits.length > hypothesisUnits.length) {
    shorter = hypothesisUnits;
    longer = referenceUnits;
  }
  let previous = Array.from({ length: shorter.length + 1 }, (_, index) => index);
  for (let row = 1; row <= longer.length; row += 1) {
    const current = new Array<number>(shorter.length + 1);
    current[0] = row;
    for (let column = 1; column <= shorter.length; column += 1) {
      const substitutionCost = longer[row - 1] === shorter[column - 1] ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + substitutionCost,
      );
    }
    previous = current;
  }
  return previous[shorter.length];
}

/** zh-only fixtures use all normalized Unicode letters/numbers as CER units. */
export function tokenizeZhCharacters(text: string): readonly string[] {
  return Array.from(text.normalize('NFKC').toLocaleLowerCase('zh-CN'))
    .filter((character) => /[\p{L}\p{N}]/u.test(character));
}

/** Mixed fixtures isolate Han characters so embedded English is not double-counted. */
export function tokenizeHanCharacters(text: string): readonly string[] {
  return Array.from(text.normalize('NFKC'))
    .filter((character) => /\p{Script=Han}/u.test(character));
}

export function tokenizeEnglish(text: string): readonly string[] {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .match(/[\p{Script=Latin}]+(?:['’][\p{Script=Latin}]+)*|\p{N}+/gu) ?? [];
}

/** Pure-English WER keeps foreign-script hallucinations as insertion units. */
export function tokenizeEnWerUnits(text: string): readonly string[] {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .match(/[\p{Script=Latin}]+(?:['’][\p{Script=Latin}]+)*|\p{N}+|\p{Script=Han}|[\p{L}]+/gu)
    ?? [];
}

/** Mixed MER uses one ordered sequence: one Han char, one Latin word, or one number per unit. */
export function tokenizeMixedUnits(text: string): readonly string[] {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .match(/\p{Script=Han}|[\p{Script=Latin}]+(?:['’][\p{Script=Latin}]+)*|\p{N}+|[\p{L}]+/gu)
    ?? [];
}

export function validateSpeechSpans(
  spans: readonly LocalAsrSpeechSpan[],
  totalSamples?: number,
): readonly string[] {
  const errors: string[] = [];
  if (
    totalSamples !== undefined
    && (!Number.isSafeInteger(totalSamples) || totalSamples <= 0)
  ) errors.push('canonical PCM sample count must be a positive safe integer');
  spans.forEach((span, index) => {
    if (
      !Number.isSafeInteger(span.startSample)
      || span.startSample < 0
      || !Number.isSafeInteger(span.endSample)
      || span.endSample <= span.startSample
    ) errors.push(`speechSpans[${index}] must satisfy 0 <= startSample < endSample`);
    if (index > 0 && span.startSample < spans[index - 1].endSample) {
      errors.push(`speechSpans[${index}] overlaps or is out of order`);
    }
    if (totalSamples !== undefined && span.endSample > totalSamples) {
      errors.push(`speechSpans[${index}].endSample exceeds canonical PCM length`);
    }
  });
  return errors;
}

export function reduceSpeechSpanTiming(input: {
  readonly partials: readonly PartialTimelineEvent[];
  readonly naturalFinals: readonly NaturalFinalTimelineEvent[];
  readonly speechSpans: readonly LocalAsrSpeechSpan[];
  readonly sampleRateHz: number;
}): SpeechSpanTimingSummary {
  if (!Number.isSafeInteger(input.sampleRateHz) || input.sampleRateHz <= 0) {
    throw new Error('SPEECH_SPAN_SAMPLE_RATE_INVALID');
  }
  const spanErrors = validateSpeechSpans(input.speechSpans);
  if (spanErrors.length > 0 || input.speechSpans.length === 0) {
    throw new Error(`SPEECH_SPANS_INVALID:${spanErrors.join('|')}`);
  }
  const partials = normalizePartialTimeline(input.partials);
  const naturalFinals = normalizeNaturalFinalTimeline(input.naturalFinals);
  const usedFinals = new Set<number>();
  const firstPartialLatencies: number[] = [];
  const activeSpeechGaps: number[] = [];
  const maximumActiveSpeechGaps: number[] = [];
  const naturalFinalLatencies: number[] = [];

  const spans = input.speechSpans.map((span, spanIndex) => {
    const spanPartials = partials.filter((event) =>
      event.audioSample > span.startSample && event.audioSample <= span.endSample);
    const firstPartialEvent = spanPartials[0] ?? null;
    const firstPartial = firstPartialEvent
      ? {
          text: firstPartialEvent.text,
          audioSample: firstPartialEvent.audioSample,
          wallLatencyMs: roundMilliseconds(Math.max(
            0,
            firstPartialEvent.wallMs
              - samplesToMilliseconds(span.startSample, input.sampleRateHz),
          )),
        }
      : null;
    if (firstPartial) firstPartialLatencies.push(firstPartial.wallLatencyMs);

    // Speech annotations anchor the virtual 1.0x playback wall clock. Partial
    // events use their measured emission wall time, so the gaps expose decoder
    // stalls and scheduling jitter instead of repeating the delivered chunk cursor.
    const boundaryWallMs = [
      samplesToMilliseconds(span.startSample, input.sampleRateHz),
      ...spanPartials.map((event) => event.wallMs),
      samplesToMilliseconds(span.endSample, input.sampleRateHz),
    ];
    const spanGaps = boundaryWallMs.slice(1).map((wallMs, index) =>
      roundMilliseconds(Math.max(0, wallMs - boundaryWallMs[index])));
    activeSpeechGaps.push(...spanGaps);
    const maximumActiveSpeechGapMs = Math.max(...spanGaps);
    maximumActiveSpeechGaps.push(maximumActiveSpeechGapMs);

    const nextSpan = input.speechSpans[spanIndex + 1] ?? null;
    const finalIndex = naturalFinals.findIndex((event, index) =>
      !usedFinals.has(index)
      && event.audioSample >= span.endSample
      && (nextSpan === null || event.audioSample <= nextSpan.startSample));
    const finalEvent = finalIndex >= 0 ? naturalFinals[finalIndex] : null;
    if (finalIndex >= 0) usedFinals.add(finalIndex);
    const naturalFinal = finalEvent
      ? {
          text: finalEvent.text,
          audioSample: finalEvent.audioSample,
          wallLatencyMs: roundMilliseconds(Math.max(
            0,
            finalEvent.wallMs - samplesToMilliseconds(span.endSample, input.sampleRateHz),
          )),
        }
      : null;
    if (naturalFinal) naturalFinalLatencies.push(naturalFinal.wallLatencyMs);

    return {
      spanIndex,
      startSample: span.startSample,
      endSample: span.endSample,
      durationMs: samplesToMilliseconds(
        span.endSample - span.startSample,
        input.sampleRateHz,
      ),
      firstPartial,
      activeSpeechGapsMs: spanGaps,
      maximumActiveSpeechGapMs,
      naturalFinal,
    };
  });

  const firstPartialMissCount = spans.filter((span) => span.firstPartial === null).length;
  const naturalFinalMissCount = spans.filter((span) => span.naturalFinal === null).length;
  const isInsideActiveSpeech = (event: PartialTimelineEvent) => input.speechSpans.some((span) =>
    event.audioSample > span.startSample && event.audioSample <= span.endSample);
  return {
    spans,
    firstPartialLatencyMs: summarizeDistribution(firstPartialLatencies),
    activeSpeechGapMs: summarizeDistribution(activeSpeechGaps),
    perSpanMaximumActiveSpeechGapMs: summarizeDistribution(maximumActiveSpeechGaps),
    naturalFinalLatencyMs: summarizeDistribution(naturalFinalLatencies),
    firstPartialMisses: rateCount(firstPartialMissCount, spans.length),
    naturalFinalMisses: rateCount(naturalFinalMissCount, spans.length),
    outsideActiveSpeechPartialCount: partials.filter((event) => !isInsideActiveSpeech(event)).length,
    unmatchedNaturalFinalCount: naturalFinals.length - usedFinals.size,
  };
}

export function summarizeDistribution(values: readonly number[]): DistributionSummary {
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('DISTRIBUTION_VALUE_INVALID');
  }
  const sorted = values
    .map(roundMilliseconds)
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { count: 0, average: null, p50: null, p95: null, maximum: null };
  }
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    average: roundMilliseconds(total / sorted.length),
    p50: nearestRankPercentile(sorted, 0.5),
    p95: nearestRankPercentile(sorted, 0.95),
    maximum: sorted[sorted.length - 1],
  };
}

export function calculateRealTimeFactor(
  processingMs: number,
  audioDurationMs: number,
): number | null {
  if (!Number.isFinite(processingMs) || processingMs < 0) return null;
  if (!Number.isFinite(audioDurationMs) || audioDurationMs <= 0) return null;
  return roundMetric(processingMs / audioDurationMs);
}

export function decodePcm16Wav(
  buffer: Buffer,
  targetSampleRateHz = 16_000,
): DecodedPcm16Wav {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('WAV_INVALID_RIFF_HEADER');
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV_INVALID_WAVE_HEADER');
  }
  const declaredEnd = buffer.readUInt32LE(4) + 8;
  if (declaredEnd < 12 || declaredEnd > buffer.length) {
    throw new Error('WAV_TRUNCATED_RIFF');
  }

  let format: {
    readonly channels: number;
    readonly sampleRateHz: number;
    readonly blockAlign: number;
  } | null = null;
  const dataChunks: Buffer[] = [];
  let offset = 12;
  while (offset + 8 <= declaredEnd) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > declaredEnd) throw new Error('WAV_TRUNCATED_CHUNK');
    if (chunkId === 'fmt ') {
      if (chunkSize < 16) throw new Error('WAV_INVALID_FMT_CHUNK');
      const audioFormat = buffer.readUInt16LE(dataStart);
      const channels = buffer.readUInt16LE(dataStart + 2);
      const sampleRateHz = buffer.readUInt32LE(dataStart + 4);
      const byteRate = buffer.readUInt32LE(dataStart + 8);
      const blockAlign = buffer.readUInt16LE(dataStart + 12);
      const bitsPerSample = buffer.readUInt16LE(dataStart + 14);
      if (audioFormat !== 1 || bitsPerSample !== 16) {
        throw new Error('WAV_REQUIRES_PCM_16_BIT');
      }
      if (channels < 1 || channels > 32) throw new Error('WAV_INVALID_CHANNEL_COUNT');
      if (sampleRateHz < 8_000 || sampleRateHz > 192_000) {
        throw new Error('WAV_INVALID_SAMPLE_RATE');
      }
      if (blockAlign !== channels * 2 || byteRate !== sampleRateHz * blockAlign) {
        throw new Error('WAV_INCONSISTENT_PCM_FORMAT');
      }
      format = { channels, sampleRateHz, blockAlign };
    } else if (chunkId === 'data') {
      dataChunks.push(buffer.subarray(dataStart, dataEnd));
    }
    offset = dataEnd + (chunkSize % 2);
  }
  if (!format) throw new Error('WAV_MISSING_FMT_CHUNK');
  if (dataChunks.length === 0) throw new Error('WAV_MISSING_DATA_CHUNK');
  const totalDataBytes = dataChunks.reduce((total, chunk) => total + chunk.length, 0);
  if (totalDataBytes === 0 || totalDataBytes % format.blockAlign !== 0) {
    throw new Error('WAV_INVALID_DATA_LENGTH');
  }

  const sourceFrameCount = totalDataBytes / format.blockAlign;
  const mono = new Float32Array(sourceFrameCount);
  let frameIndex = 0;
  for (const chunk of dataChunks) {
    if (chunk.length % format.blockAlign !== 0) throw new Error('WAV_INVALID_DATA_LENGTH');
    for (let chunkOffset = 0; chunkOffset < chunk.length; chunkOffset += format.blockAlign) {
      let sum = 0;
      for (let channel = 0; channel < format.channels; channel += 1) {
        sum += chunk.readInt16LE(chunkOffset + channel * 2) / 32_768;
      }
      mono[frameIndex] = sum / format.channels;
      frameIndex += 1;
    }
  }
  const samples = resampleLinear(mono, format.sampleRateHz, targetSampleRateHz);
  return {
    samples,
    sourceSampleRateHz: format.sampleRateHz,
    targetSampleRateHz,
    channels: format.channels,
    sourceFrameCount,
    durationMs: roundMilliseconds((sourceFrameCount / format.sampleRateHz) * 1_000),
  };
}

export function resampleLinear(
  input: Float32Array,
  inputSampleRateHz: number,
  outputSampleRateHz: number,
): Float32Array {
  if (!Number.isInteger(inputSampleRateHz) || inputSampleRateHz <= 0) {
    throw new Error('INVALID_INPUT_SAMPLE_RATE');
  }
  if (!Number.isInteger(outputSampleRateHz) || outputSampleRateHz <= 0) {
    throw new Error('INVALID_OUTPUT_SAMPLE_RATE');
  }
  if (input.length === 0) return new Float32Array();
  if (inputSampleRateHz === outputSampleRateHz) return new Float32Array(input);
  const outputLength = Math.max(
    1,
    Math.round((input.length * outputSampleRateHz) / inputSampleRateHz),
  );
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = (index * inputSampleRateHz) / outputSampleRateHz;
    const lowerIndex = Math.min(input.length - 1, Math.floor(sourcePosition));
    const upperIndex = Math.min(input.length - 1, lowerIndex + 1);
    const fraction = sourcePosition - lowerIndex;
    output[index] = input[lowerIndex] * (1 - fraction) + input[upperIndex] * fraction;
  }
  return output;
}

function normalizeKeyTerm(value: string): string {
  return tokenizeKeyTermUnits(value).join('\0');
}

function tokenizeKeyTermUnits(value: string): readonly string[] {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .match(
      /\p{Script=Han}|[\p{Script=Latin}\p{N}]+|[\p{L}\p{N}]+|[^\p{L}\p{N}\p{White_Space}]/gu,
    ) ?? [];
}

function isKeyTermLexicalUnit(unit: string): boolean {
  return /[\p{L}\p{N}]/u.test(unit);
}

function isBindingKeyTermPunctuation(
  units: readonly string[],
  index: number,
): boolean {
  const unit = units[index];
  if (!unit || isKeyTermLexicalUnit(unit)) return false;
  if (/^[+#&/@_%=*~\\]$/u.test(unit)) return true;
  if (!/^[.:'’\-·]$/u.test(unit)) return false;
  // Sentence punctuation remains a boundary, while punctuation between lexical
  // units is part of terms such as GPT-5 or AI's.
  return (index > 0 && isKeyTermLexicalUnit(units[index - 1]))
    && (index + 1 < units.length && isKeyTermLexicalUnit(units[index + 1]));
}

export function matchAnnotatedKeyTerms(
  annotations: readonly LocalAsrKeyTermAnnotation[],
  text: string,
): KeyTermRecallMetric {
  const patterns = annotations.flatMap((annotation, termIndex) =>
    [annotation.canonical, ...annotation.aliases].map((pattern, patternIndex) => ({
      termIndex,
      patternIndex,
      units: tokenizeKeyTermUnits(pattern),
    }))).filter((pattern) => pattern.units.some(isKeyTermLexicalUnit));
  const observed = Array.from({ length: annotations.length }, () => 0);
  const units = tokenizeKeyTermUnits(text);
  for (let cursor = 0; cursor < units.length;) {
    const matches = patterns.filter((pattern) =>
      pattern.units.length <= units.length - cursor
      && pattern.units.every((unit, offset) => unit === units[cursor + offset])
      && !isBindingKeyTermPunctuation(units, cursor - 1)
      && !isBindingKeyTermPunctuation(units, cursor + pattern.units.length));
    matches.sort((left, right) =>
      right.units.length - left.units.length
      || left.termIndex - right.termIndex
      || left.patternIndex - right.patternIndex);
    const selected = matches[0];
    if (!selected) {
      cursor += 1;
      continue;
    }
    observed[selected.termIndex] += 1;
    cursor += selected.units.length;
  }
  const terms = annotations.map((annotation, index) => {
    const observedOccurrences = observed[index];
    const matchedOccurrences = Math.min(annotation.occurrences, observedOccurrences);
    return {
      canonical: annotation.canonical,
      aliases: [...annotation.aliases],
      annotatedOccurrences: annotation.occurrences,
      observedOccurrences,
      matchedOccurrences,
      hallucinatedOccurrences: Math.max(0, observedOccurrences - annotation.occurrences),
    };
  });
  const matchedOccurrences = terms.reduce(
    (total, term) => total + term.matchedOccurrences,
    0,
  );
  const annotatedOccurrences = terms.reduce(
    (total, term) => total + term.annotatedOccurrences,
    0,
  );
  const observedOccurrences = terms.reduce(
    (total, term) => total + term.observedOccurrences,
    0,
  );
  const hallucinatedOccurrences = terms.reduce(
    (total, term) => total + term.hallucinatedOccurrences,
    0,
  );
  return {
    matchedOccurrences,
    annotatedOccurrences,
    recall: annotatedOccurrences > 0
      ? roundMetric(matchedOccurrences / annotatedOccurrences)
      : null,
    precision: observedOccurrences > 0
      ? roundMetric(matchedOccurrences / observedOccurrences)
      : null,
    hallucinatedOccurrences,
    terms,
  };
}

function normalizePartialTimeline(
  events: readonly PartialTimelineEvent[],
): readonly PartialTimelineEvent[] {
  const meaningful: PartialTimelineEvent[] = [];
  let previous: PartialTimelineEvent | null = null;
  for (const event of events) {
    if (
      !Number.isSafeInteger(event.segmentIndex)
      || event.segmentIndex < 0
      || !Number.isSafeInteger(event.audioSample)
      || event.audioSample < 0
      || !Number.isFinite(event.wallMs)
      || event.wallMs < 0
      || (previous !== null && (
        event.segmentIndex < previous.segmentIndex
        || event.audioSample < previous.audioSample
        || event.wallMs < previous.wallMs
      ))
    ) throw new Error('PARTIAL_TIMELINE_NON_MONOTONIC');
    previous = event;
    if (!event.text.trim()) continue;
    const priorMeaningful = meaningful.at(-1);
    if (
      priorMeaningful
      && priorMeaningful.segmentIndex === event.segmentIndex
      && priorMeaningful.text === event.text
    ) continue;
    meaningful.push(event);
  }
  return meaningful;
}

function normalizeNaturalFinalTimeline(
  events: readonly NaturalFinalTimelineEvent[],
): readonly NaturalFinalTimelineEvent[] {
  let previous: NaturalFinalTimelineEvent | null = null;
  return events.map((event) => {
    if (
      !event.text.trim()
      || !Number.isSafeInteger(event.audioSample)
      || event.audioSample < 0
      || !Number.isFinite(event.wallMs)
      || event.wallMs < 0
      || (previous !== null && (
        event.audioSample < previous.audioSample
        || event.wallMs < previous.wallMs
      ))
    ) throw new Error('NATURAL_FINAL_TIMELINE_NON_MONOTONIC');
    previous = event;
    return event;
  });
}

function samplesToMilliseconds(samples: number, sampleRateHz: number): number {
  return roundMilliseconds((samples / sampleRateHz) * 1_000);
}

function rateCount(count: number, total: number): RateCount {
  return {
    count,
    total,
    rate: total > 0 ? roundMetric(count / total) : null,
  };
}

function isSafeRelativeFixturePath(value: string): boolean {
  if (value.includes('\0') || path.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return normalized !== '..'
    && !normalized.startsWith('../')
    && normalized !== '.'
    && normalized.toLocaleLowerCase('en-US').endsWith('.wav');
}

function nearestRankPercentile(sortedValues: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sortedValues.length) - 1);
  return sortedValues[index];
}

function formatIssuePath(issuePath: readonly PropertyKey[]): string {
  if (issuePath.length === 0) return 'manifest';
  return issuePath.reduce<string>((formatted, part) => {
    if (typeof part === 'number') return `${formatted}[${part}]`;
    return formatted ? `${formatted}.${String(part)}` : String(part);
  }, '');
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
