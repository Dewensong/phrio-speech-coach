const ASR_SAMPLE_RATE = 16_000 as const;
const MAXIMUM_DECODED_AUDIO_SECONDS = (5 * 60) + 5;
const RECORDED_AUDIO_DECODE_TIMEOUT_MS = 15_000;

export interface DecodedRecordedAudio {
  readonly samples: Float32Array;
  readonly sourceSampleRate: number;
  readonly sourceChannelCount: number;
  readonly durationMs: number;
  readonly rms: number;
  readonly peak: number;
}

/**
 * Recovers the same MediaRecorder take when the live Web Audio callback path
 * never produced PCM. The blob remains the source of truth: it is decoded,
 * downmixed and resampled locally and is never sent outside the renderer.
 */
export async function decodeRecordedAudioToMono16Khz(
  blob: Blob,
): Promise<DecodedRecordedAudio> {
  if (typeof AudioContext === 'undefined') {
    throw new RecordedAudioDecodeError('RECORDED_AUDIO_DECODE_UNAVAILABLE');
  }
  const context = new AudioContext();
  try {
    const audio = await withDecodeTimeout((async () => {
      const encoded = await blob.arrayBuffer();
      return context.decodeAudioData(encoded.slice(0));
    })());
    if (
      !Number.isFinite(audio.sampleRate)
      || audio.sampleRate <= 0
      || !Number.isSafeInteger(audio.length)
      || audio.length <= 0
      || audio.numberOfChannels <= 0
      || audio.duration > MAXIMUM_DECODED_AUDIO_SECONDS
    ) {
      throw new RecordedAudioDecodeError('RECORDED_AUDIO_DECODE_INVALID');
    }
    const mono = downmixToMono(audio);
    const samples = resampleMono(mono, audio.sampleRate, ASR_SAMPLE_RATE);
    let squareSum = 0;
    let peak = 0;
    for (const sample of samples) {
      const magnitude = Math.abs(sample);
      peak = Math.max(peak, magnitude);
      squareSum += sample * sample;
    }
    return {
      samples,
      sourceSampleRate: audio.sampleRate,
      sourceChannelCount: audio.numberOfChannels,
      durationMs: Math.round((samples.length / ASR_SAMPLE_RATE) * 1_000),
      rms: samples.length > 0 ? Math.sqrt(squareSum / samples.length) : 0,
      peak,
    };
  } catch (error) {
    if (error instanceof RecordedAudioDecodeError) throw error;
    throw new RecordedAudioDecodeError('RECORDED_AUDIO_DECODE_FAILED', error);
  } finally {
    try {
      void context.close().catch(() => undefined);
    } catch {
      // Closing is best-effort and must not turn a bounded decode into a hang.
    }
  }
}

async function withDecodeTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new RecordedAudioDecodeError('RECORDED_AUDIO_DECODE_TIMEOUT'));
        }, RECORDED_AUDIO_DECODE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function downmixToMono(audio: AudioBuffer): Float32Array {
  const mono = new Float32Array(audio.length);
  for (let channelIndex = 0; channelIndex < audio.numberOfChannels; channelIndex += 1) {
    const channel = audio.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < mono.length; sampleIndex += 1) {
      mono[sampleIndex] = (mono[sampleIndex] ?? 0) + ((channel[sampleIndex] ?? 0) / audio.numberOfChannels);
    }
  }
  return mono;
}

function resampleMono(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): Float32Array {
  if (inputSampleRate === outputSampleRate) return new Float32Array(input);
  const outputLength = Math.max(1, Math.round(input.length * (outputSampleRate / inputSampleRate)));
  const output = new Float32Array(outputLength);
  const ratio = inputSampleRate / outputSampleRate;
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const position = outputIndex * ratio;
    const lowerIndex = Math.min(input.length - 1, Math.floor(position));
    const upperIndex = Math.min(input.length - 1, lowerIndex + 1);
    const fraction = position - lowerIndex;
    const lower = input[lowerIndex] ?? 0;
    const upper = input[upperIndex] ?? lower;
    output[outputIndex] = lower + ((upper - lower) * fraction);
  }
  return output;
}

export type RecordedAudioDecodeErrorCode =
  | 'RECORDED_AUDIO_DECODE_UNAVAILABLE'
  | 'RECORDED_AUDIO_DECODE_INVALID'
  | 'RECORDED_AUDIO_DECODE_TIMEOUT'
  | 'RECORDED_AUDIO_DECODE_FAILED';

export class RecordedAudioDecodeError extends Error {
  readonly code: RecordedAudioDecodeErrorCode;

  constructor(code: RecordedAudioDecodeErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'RecordedAudioDecodeError';
    this.code = code;
  }
}
