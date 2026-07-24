import exampleManifest from '../../fixtures/asr-benchmark/manifest.example.json';
import { describe, expect, it } from 'vitest';
import { LOCAL_ASR_DIRECT_MODEL_FILES } from '../../src/backend/services/local-asr-model-distribution';
import { LOCAL_ASR_FROZEN_DIRECT_MODEL_FILES } from '../../src/backend/services/local-asr-recognizer-config';
import {
  aggregateErrorRates,
  aggregateRateCounts,
  calculateAccuracyMetrics,
  calculateErrorRate,
  calculateKeyTermRecall,
  calculateRealTimeFactor,
  decodePcm16Wav,
  formatManifestValidationError,
  levenshteinDistance,
  parseLocalAsrBenchmarkManifest,
  reduceSpeechSpanTiming,
  summarizeDistribution,
  tokenizeEnglish,
  tokenizeEnWerUnits,
  tokenizeHanCharacters,
  tokenizeMixedUnits,
  tokenizeZhCharacters,
  validateSpeechSpans,
} from '../../scripts/lib/local-asr-benchmark';

describe('local ASR benchmark manifest', () => {
  it('pins the benchmark model identities to the production direct distribution', () => {
    expect(LOCAL_ASR_FROZEN_DIRECT_MODEL_FILES).toEqual(
      LOCAL_ASR_DIRECT_MODEL_FILES.map(({ name, byteLength, sha256 }) => ({
        name,
        byteLength,
        sha256,
      })),
    );
  });

  it('accepts the committed explicit-skip schema example without requiring audio files', () => {
    const manifest = parseLocalAsrBenchmarkManifest(exampleManifest);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.defaults.chunkMs).toBe(64);
    expect(manifest.fixtures).toHaveLength(3);
    expect(manifest.fixtures.every((fixture) => fixture.skip && fixture.skipReason)).toBe(true);
    expect(manifest.fixtures.map((fixture) => fixture.language)).toEqual(['zh', 'en', 'mixed']);
  });

  it('rejects duplicate ids, path escape, missing mixed terms, and terms absent from reference', () => {
    const invalid = {
      schemaVersion: 1,
      fixtures: [
        {
          id: 'duplicate',
          audio: '../outside.wav',
          reference: '我们使用 Agent。',
          language: 'mixed',
          speechSpans: [{ startSample: 0, endSample: 16_000 }],
          keyTerms: [],
        },
        {
          id: 'duplicate',
          audio: 'audio/inside.wav',
          reference: '我们使用 Agent。',
          language: 'mixed',
          speechSpans: [
            { startSample: 0, endSample: 16_000 },
            { startSample: 8_000, endSample: 24_000 },
          ],
          keyTerms: [{ canonical: 'workflow', aliases: [], occurrences: 1 }],
        },
        {
          id: 'ambiguous-terms',
          audio: 'audio/ambiguous.wav',
          reference: '我们使用 AI Agent。',
          language: 'mixed',
          speechSpans: [{ startSample: 0, endSample: 16_000 }],
          keyTerms: [
            { canonical: 'AI', aliases: [], occurrences: 1 },
            { canonical: 'Agent', aliases: ['AI'], occurrences: 1 },
          ],
        },
      ],
    };

    let message = '';
    try {
      parseLocalAsrBenchmarkManifest(invalid);
    } catch (error) {
      message = formatManifestValidationError(error);
    }
    expect(message).toContain('audio must be a relative path');
    expect(message).toContain('mixed fixtures require');
    expect(message).toContain('do not match reference occurrences');
    expect(message).toContain('overlaps or is out of order');
    expect(message).toContain('globally unique after normalization');
    expect(message).toContain('duplicate fixture id');
  });

  it('requires an explicit reason for skip and the matching reference units per language', () => {
    expect(() => parseLocalAsrBenchmarkManifest({
      schemaVersion: 1,
      fixtures: [
        {
          id: 'empty-en',
          audio: 'audio/empty.wav',
          reference: '你好',
          language: 'en',
          skip: true,
        },
      ],
    })).toThrow();
  });

  it('requires active fixtures to declare ordered canonical-PCM speech spans', () => {
    expect(() => parseLocalAsrBenchmarkManifest({
      schemaVersion: 1,
      fixtures: [{
        id: 'active-without-spans',
        audio: 'audio/example.wav',
        reference: '有效参考',
        language: 'zh',
      }],
    })).toThrow(/speechSpans|speech span/u);
  });

  it('treats punctuation-changing key-term variants as explicit approved aliases', () => {
    const manifest = parseLocalAsrBenchmarkManifest({
      schemaVersion: 1,
      fixtures: [{
        id: 'punctuated-term',
        audio: 'audio/example.wav',
        reference: '我们使用 GPT-5 完成任务',
        language: 'mixed',
        speechSpans: [{ startSample: 0, endSample: 16_000 }],
        keyTerms: [{ canonical: 'GPT-5', aliases: ['GPT 5'], occurrences: 1 }],
      }],
    });

    expect(manifest.fixtures[0].keyTerms[0].aliases).toEqual(['GPT 5']);
    expect(() => parseLocalAsrBenchmarkManifest({
      schemaVersion: 1,
      fixtures: [{
        id: 'punctuation-only-term',
        audio: 'audio/example.wav',
        reference: '我们使用 Agent 完成任务',
        language: 'mixed',
        speechSpans: [{ startSample: 0, endSample: 16_000 }],
        keyTerms: [{ canonical: '++', aliases: [], occurrences: 1 }],
      }],
    })).toThrow(/must contain Han, Latin, or numeric units/u);
  });
});

describe('local ASR benchmark accuracy metrics', () => {
  it('normalizes zh CER and preserves full deletion or insertion error rates', () => {
    expect(tokenizeZhCharacters('你好，World ２！')).toEqual([
      '你', '好', 'w', 'o', 'r', 'l', 'd', '2',
    ]);
    expect(calculateAccuracyMetrics('zh', '你好，世界！', '你好世').zhCer).toEqual({
      edits: 1,
      referenceUnits: 4,
      hypothesisUnits: 3,
      rate: 0.25,
    });
    expect(calculateErrorRate(['a'], ['a', 'b', 'c'])).toEqual({
      edits: 2,
      referenceUnits: 1,
      hypothesisUnits: 3,
      rate: 2,
    });
    expect(calculateErrorRate(['a', 'b'], [])).toEqual({
      edits: 2,
      referenceUnits: 2,
      hypothesisUnits: 0,
      rate: 1,
    });
  });

  it('freezes English token rules and counts foreign-script hallucinations as insertions', () => {
    expect(tokenizeEnglish("We're AI-first ２０２６")).toEqual(["we're", 'ai', 'first', '2026']);
    expect(tokenizeEnWerUnits("We're ready 中文")).toEqual(["we're", 'ready', '中', '文']);
    const metric = calculateAccuracyMetrics('en', "We're ready", "We're ready 中文").enWer;
    expect(metric).toEqual({
      edits: 2,
      referenceUnits: 2,
      hypothesisUnits: 4,
      rate: 1,
    });
  });

  it('keeps mixed Han CER, English token WER, and exact key-term recall separate', () => {
    expect(tokenizeHanCharacters('我们 use Agent 2.0')).toEqual(['我', '们']);
    expect(tokenizeMixedUnits('我们用 Agent workflow')).toEqual([
      '我', '们', '用', 'agent', 'workflow',
    ]);
    const metrics = calculateAccuracyMetrics(
      'mixed',
      '我们用 Agent workflow 完成复盘',
      '我们用 agent work flow 完成复盘',
      [
        { canonical: 'Agent', aliases: [], occurrences: 1 },
        { canonical: 'workflow', aliases: ['work flow'], occurrences: 1 },
      ],
    );

    expect(metrics.zhCer?.rate).toBe(0);
    expect(metrics.enWer).toEqual({
      edits: 2,
      referenceUnits: 2,
      hypothesisUnits: 3,
      rate: 1,
    });
    expect(metrics.mixedMer).toEqual({
      edits: 2,
      referenceUnits: 9,
      hypothesisUnits: 10,
      rate: 0.222222,
    });
    expect(metrics.keyTermRecall).toEqual({
      matchedOccurrences: 2,
      annotatedOccurrences: 2,
      recall: 1,
      precision: 1,
      hallucinatedOccurrences: 0,
      terms: [
        {
          canonical: 'Agent',
          aliases: [],
          annotatedOccurrences: 1,
          observedOccurrences: 1,
          matchedOccurrences: 1,
          hallucinatedOccurrences: 0,
        },
        {
          canonical: 'workflow',
          aliases: ['work flow'],
          annotatedOccurrences: 1,
          observedOccurrences: 1,
          matchedOccurrences: 1,
          hallucinatedOccurrences: 0,
        },
      ],
    });
  });

  it('matches annotated occurrences one-to-one and reports extra guesses as hallucinations', () => {
    const metric = calculateKeyTermRecall(
      [{ canonical: 'AI', aliases: [], occurrences: 1 }],
      'AI AI appears, but chair is not another term',
    );
    expect(metric.matchedOccurrences).toBe(1);
    expect(metric.annotatedOccurrences).toBe(1);
    expect(metric.recall).toBe(1);
    expect(metric.precision).toBe(0.5);
    expect(metric.hallucinatedOccurrences).toBe(1);
    expect(metric.terms[0].observedOccurrences).toBe(2);
    expect(calculateKeyTermRecall(
      [{ canonical: 'GPT-5', aliases: ['GPT 5'], occurrences: 1 }],
      'Use GPT 5 today',
    ).recall).toBe(1);
    expect(calculateKeyTermRecall(
      [{ canonical: 'GPT-5', aliases: [], occurrences: 1 }],
      'Use GPT 5 today',
    ).recall).toBe(0);
    expect(calculateKeyTermRecall(
      [{ canonical: 'C++', aliases: [], occurrences: 1 }],
      'Use C today',
    ).recall).toBe(0);
    expect(calculateKeyTermRecall(
      [{ canonical: 'C', aliases: [], occurrences: 1 }],
      'Use C++ today',
    ).recall).toBe(0);
    expect(calculateKeyTermRecall(
      [{ canonical: 'Agent', aliases: [], occurrences: 1 }],
      'Use Agent, today',
    ).recall).toBe(1);

    const nested = calculateKeyTermRecall([
      { canonical: 'AI', aliases: [], occurrences: 1 },
      { canonical: 'AI Agent', aliases: [], occurrences: 1 },
    ], 'AI Agent then AI');
    expect(nested.terms.map((term) => term.observedOccurrences)).toEqual([1, 1]);
  });

  it('uses edit distance and micro aggregation without averaging per-file rates', () => {
    expect(levenshteinDistance(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toBe(2);
    expect(aggregateErrorRates([
      { edits: 1, referenceUnits: 1, hypothesisUnits: 1, rate: 1 },
      { edits: 1, referenceUnits: 9, hypothesisUnits: 9, rate: 0.111111 },
    ])).toEqual({
      edits: 2,
      referenceUnits: 10,
      hypothesisUnits: 10,
      rate: 0.2,
    });
  });
});

describe('local ASR benchmark timing reducers', () => {
  it('anchors partial and natural-final latency to annotated speech spans', () => {
    const summary = reduceSpeechSpanTiming({
      sampleRateHz: 1_000,
      speechSpans: [
        { startSample: 100, endSample: 500 },
        { startSample: 700, endSample: 900 },
      ],
      partials: [
        { text: '', segmentIndex: 0, audioSample: 50, wallMs: 50 },
        { text: 'premature', segmentIndex: 0, audioSample: 80, wallMs: 80 },
        { text: 'a', segmentIndex: 0, audioSample: 200, wallMs: 210 },
        { text: 'a', segmentIndex: 0, audioSample: 250, wallMs: 260 },
        { text: 'ab', segmentIndex: 0, audioSample: 350, wallMs: 365 },
        { text: 'late', segmentIndex: 0, audioSample: 600, wallMs: 610 },
      ],
      naturalFinals: [
        { text: 'premature final', audioSample: 450, wallMs: 460 },
        { text: 'natural final', audioSample: 600, wallMs: 620 },
      ],
    });

    expect(summary.spans[0].firstPartial).toEqual({
      text: 'a',
      audioSample: 200,
      wallLatencyMs: 110,
    });
    expect(summary.spans[0].activeSpeechGapsMs).toEqual([110, 155, 135]);
    expect(summary.spans[0].naturalFinal).toEqual({
      text: 'natural final',
      audioSample: 600,
      wallLatencyMs: 120,
    });
    expect(summary.spans[1].firstPartial).toBeNull();
    expect(summary.spans[1].activeSpeechGapsMs).toEqual([200]);
    expect(summary.spans[1].naturalFinal).toBeNull();
    expect(summary.firstPartialMisses).toEqual({ count: 1, total: 2, rate: 0.5 });
    expect(summary.naturalFinalMisses).toEqual({ count: 1, total: 2, rate: 0.5 });
    expect(summary.outsideActiveSpeechPartialCount).toBe(2);
    expect(summary.unmatchedNaturalFinalCount).toBe(1);
    expect(summary.firstPartialLatencyMs.average).toBe(110);
    expect(summary.naturalFinalLatencyMs.average).toBe(120);
    expect(summary.activeSpeechGapMs.maximum).toBe(200);
    expect(summary.perSpanMaximumActiveSpeechGapMs).toEqual({
      count: 2,
      average: 177.5,
      p50: 155,
      p95: 200,
      maximum: 200,
    });
    expect(summarizeDistribution([1, 2, 3, 4, 100]).p95).toBe(100);
  });

  it('validates ordered span bounds and rejects non-monotonic event traces', () => {
    expect(validateSpeechSpans([
      { startSample: 0, endSample: 100 },
      { startSample: 90, endSample: 200 },
    ], 150)).toEqual([
      'speechSpans[1] overlaps or is out of order',
      'speechSpans[1].endSample exceeds canonical PCM length',
    ]);
    expect(() => reduceSpeechSpanTiming({
      sampleRateHz: 1_000,
      speechSpans: [{ startSample: 0, endSample: 300 }],
      partials: [
        { text: 'later', segmentIndex: 0, audioSample: 200, wallMs: 200 },
        { text: 'earlier', segmentIndex: 0, audioSample: 100, wallMs: 210 },
      ],
      naturalFinals: [],
    })).toThrow('PARTIAL_TIMELINE_NON_MONOTONIC');
    expect(() => summarizeDistribution([1, Number.NaN])).toThrow('DISTRIBUTION_VALUE_INVALID');
  });

  it('aggregates misses and returns null instead of invented latency samples', () => {
    const summary = reduceSpeechSpanTiming({
      sampleRateHz: 1_000,
      speechSpans: [{ startSample: 100, endSample: 300 }],
      partials: [],
      naturalFinals: [],
    });
    expect(summary.firstPartialLatencyMs).toEqual({
      count: 0,
      average: null,
      p50: null,
      p95: null,
      maximum: null,
    });
    expect(summary.spans[0].activeSpeechGapsMs).toEqual([200]);
    expect(aggregateRateCounts([
      { count: 1, total: 2, rate: 0.5 },
      { count: 2, total: 3, rate: 0.666667 },
    ])).toEqual({ count: 3, total: 5, rate: 0.6 });
    expect(calculateRealTimeFactor(250, 1_000)).toBe(0.25);
    expect(calculateRealTimeFactor(0, 0)).toBeNull();
  });
});

describe('16-bit PCM WAV decoder', () => {
  it('downmixes stereo PCM and linearly resamples to the production 16 kHz clock', () => {
    const wav = createPcm16Wav({
      sampleRateHz: 8_000,
      channels: 2,
      interleavedSamples: [32_767, 32_767, -32_768, -32_768],
    });
    const decoded = decodePcm16Wav(wav);

    expect(decoded.sourceSampleRateHz).toBe(8_000);
    expect(decoded.targetSampleRateHz).toBe(16_000);
    expect(decoded.channels).toBe(2);
    expect(decoded.sourceFrameCount).toBe(2);
    expect(decoded.samples).toHaveLength(4);
    expect(decoded.samples[0]).toBeCloseTo(32_767 / 32_768, 5);
    expect(decoded.samples[1]).toBeCloseTo(-1 / 65_536, 5);
    expect(decoded.samples[2]).toBe(-1);
    expect(decoded.samples[3]).toBe(-1);
  });

  it('rejects non-16-bit PCM and truncated RIFF data', () => {
    const nonPcm16 = createPcm16Wav({
      sampleRateHz: 16_000,
      channels: 1,
      interleavedSamples: [0, 1],
    });
    nonPcm16.writeUInt16LE(24, 34);
    expect(() => decodePcm16Wav(nonPcm16)).toThrow('WAV_REQUIRES_PCM_16_BIT');

    const truncated = createPcm16Wav({
      sampleRateHz: 16_000,
      channels: 1,
      interleavedSamples: [0, 1],
    }).subarray(0, 43);
    expect(() => decodePcm16Wav(truncated)).toThrow('WAV_TRUNCATED_RIFF');
  });
});

function createPcm16Wav(input: {
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly interleavedSamples: readonly number[];
}): Buffer {
  if (input.interleavedSamples.length % input.channels !== 0) {
    throw new Error('test samples must contain complete frames');
  }
  const dataBytes = input.interleavedSamples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(input.channels, 22);
  buffer.writeUInt32LE(input.sampleRateHz, 24);
  buffer.writeUInt32LE(input.sampleRateHz * input.channels * 2, 28);
  buffer.writeUInt16LE(input.channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  input.interleavedSamples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}
