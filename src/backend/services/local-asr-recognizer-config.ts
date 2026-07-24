import path from 'node:path';

export const LOCAL_ASR_MODEL_DIRECTORY_NAME =
  'sherpa-onnx-streaming-paraformer-bilingual-zh-en';
export const LOCAL_ASR_MODEL_ID =
  'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en' as const;
export const LOCAL_ASR_MODEL_REVISION =
  '8e40c43232a1c5c66c82111efc5820d3accca11b' as const;
export const LOCAL_ASR_INSTALL_MANIFEST_NAME = '.phrio-asr-install-manifest.json';
export const LOCAL_ASR_RUNTIME_FILE_NAMES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'tokens.txt',
] as const;
export const LOCAL_ASR_FROZEN_DIRECT_MODEL_FILES = Object.freeze([
  {
    name: 'encoder.int8.onnx',
    byteLength: 165_462_184,
    sha256: '81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a',
  },
  {
    name: 'decoder.int8.onnx',
    byteLength: 71_664_561,
    sha256: 'f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f',
  },
  {
    name: 'tokens.txt',
    byteLength: 75_756,
    sha256: '59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6',
  },
] as const);
export const LOCAL_ASR_INSTALLATION_ROUTE_NAMES = [
  'huggingface_direct',
  'accelerated_direct',
  'github_release_archive',
] as const;
// Keep this identifier inside the shared VersionSchema (32 characters max),
// because live feed/stop results cross that IPC output boundary.
export const LOCAL_ASR_MODEL_VERSION = 'sherpa-paraformer-zh-en-int8';
export const LOCAL_ASR_SAMPLE_RATE_HZ = 16_000;
export const LOCAL_ASR_RECOGNIZER_PROFILE = Object.freeze({
  sampleRateHz: LOCAL_ASR_SAMPLE_RATE_HZ,
  featureDim: 80,
  numThreads: 2,
  provider: 'cpu',
  decodingMethod: 'greedy_search',
  maxActivePaths: 4,
  enableEndpoint: true,
  rule1MinTrailingSilence: 1.8,
  rule2MinTrailingSilence: 0.8,
  rule3MinUtteranceLength: 20,
});

/**
 * Single production source for the Sherpa recognizer configuration used by
 * readiness probing, live transcription, and the offline quality benchmark.
 */
export function createLocalAsrRecognizerConfig(modelDirectory: string): unknown {
  const resolvedModelDirectory = path.resolve(modelDirectory);
  return {
    featConfig: {
      sampleRate: LOCAL_ASR_RECOGNIZER_PROFILE.sampleRateHz,
      featureDim: LOCAL_ASR_RECOGNIZER_PROFILE.featureDim,
    },
    modelConfig: {
      paraformer: {
        encoder: path.join(resolvedModelDirectory, 'encoder.int8.onnx'),
        decoder: path.join(resolvedModelDirectory, 'decoder.int8.onnx'),
      },
      tokens: path.join(resolvedModelDirectory, 'tokens.txt'),
      numThreads: LOCAL_ASR_RECOGNIZER_PROFILE.numThreads,
      provider: LOCAL_ASR_RECOGNIZER_PROFILE.provider,
      debug: false,
    },
    decodingMethod: LOCAL_ASR_RECOGNIZER_PROFILE.decodingMethod,
    maxActivePaths: LOCAL_ASR_RECOGNIZER_PROFILE.maxActivePaths,
    enableEndpoint: LOCAL_ASR_RECOGNIZER_PROFILE.enableEndpoint,
    rule1MinTrailingSilence: LOCAL_ASR_RECOGNIZER_PROFILE.rule1MinTrailingSilence,
    rule2MinTrailingSilence: LOCAL_ASR_RECOGNIZER_PROFILE.rule2MinTrailingSilence,
    rule3MinUtteranceLength: LOCAL_ASR_RECOGNIZER_PROFILE.rule3MinUtteranceLength,
  };
}
