import {
  LOCAL_ASR_MODEL_FILE_NAMES,
  type LocalAsrModelFileName,
} from '../../shared';

export const LOCAL_ASR_MODEL_REVISION =
  '8e40c43232a1c5c66c82111efc5820d3accca11b' as const;

export const LOCAL_ASR_DIRECT_SEGMENT_COUNT = 8 as const;
export const LOCAL_ASR_DIRECT_GLOBAL_CONCURRENCY = 8 as const;

export const LOCAL_ASR_DIRECT_SOURCE_IDS = [
  'huggingface_official',
  'hf_mirror_acceleration',
] as const;

export type LocalAsrDirectSourceId = (typeof LOCAL_ASR_DIRECT_SOURCE_IDS)[number];

export interface LocalAsrDirectModelFileDescriptor {
  readonly name: LocalAsrModelFileName;
  readonly byteLength: number;
  readonly sha256: string;
  readonly remoteKind: 'lfs' | 'git_blob';
}

export interface LocalAsrDirectSourceDescriptor {
  readonly id: LocalAsrDirectSourceId;
  /** The mirror is deliberately not represented as an official source. */
  readonly trust: 'official' | 'third_party_acceleration_mirror';
  readonly baseUrl: string;
}

export interface LocalAsrDirectModelDistribution {
  readonly revision: string;
  readonly files: readonly LocalAsrDirectModelFileDescriptor[];
  readonly sources: readonly LocalAsrDirectSourceDescriptor[];
  readonly segmentCount: number;
  readonly globalConcurrency: number;
}

const MODEL_REPOSITORY =
  'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en';

export const LOCAL_ASR_DIRECT_MODEL_FILES = Object.freeze([
  {
    name: 'encoder.int8.onnx',
    byteLength: 165_462_184,
    sha256: '81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a',
    remoteKind: 'lfs',
  },
  {
    name: 'decoder.int8.onnx',
    byteLength: 71_664_561,
    sha256: 'f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f',
    remoteKind: 'lfs',
  },
  {
    name: 'tokens.txt',
    byteLength: 75_756,
    sha256: '59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6',
    remoteKind: 'git_blob',
  },
] satisfies readonly LocalAsrDirectModelFileDescriptor[]);

export const LOCAL_ASR_DIRECT_DOWNLOAD_BYTE_LENGTH = LOCAL_ASR_DIRECT_MODEL_FILES
  .reduce((total, file) => total + file.byteLength, 0);

export const LOCAL_ASR_DIRECT_SOURCES = Object.freeze([
  {
    id: 'huggingface_official',
    trust: 'official',
    baseUrl: 'https://huggingface.co',
  },
  {
    id: 'hf_mirror_acceleration',
    trust: 'third_party_acceleration_mirror',
    baseUrl: 'https://hf-mirror.com',
  },
] satisfies readonly LocalAsrDirectSourceDescriptor[]);

export const LOCAL_ASR_DIRECT_DISTRIBUTION: LocalAsrDirectModelDistribution = Object.freeze({
  revision: LOCAL_ASR_MODEL_REVISION,
  files: LOCAL_ASR_DIRECT_MODEL_FILES,
  sources: LOCAL_ASR_DIRECT_SOURCES,
  segmentCount: LOCAL_ASR_DIRECT_SEGMENT_COUNT,
  globalConcurrency: LOCAL_ASR_DIRECT_GLOBAL_CONCURRENCY,
});

export function getLocalAsrDirectFileDescriptor(
  distribution: LocalAsrDirectModelDistribution,
  name: LocalAsrModelFileName,
): LocalAsrDirectModelFileDescriptor {
  const descriptor = distribution.files.find((file) => file.name === name);
  if (!descriptor) throw new Error('ASR_MODEL_DIRECT_DISTRIBUTION_INVALID');
  return descriptor;
}

export function getLocalAsrDirectSourceDescriptor(
  distribution: LocalAsrDirectModelDistribution,
  sourceId: LocalAsrDirectSourceId,
): LocalAsrDirectSourceDescriptor {
  const source = distribution.sources.find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error('ASR_MODEL_DIRECT_DISTRIBUTION_INVALID');
  return source;
}

export function localAsrDirectFileUrl(
  distribution: LocalAsrDirectModelDistribution,
  sourceId: LocalAsrDirectSourceId,
  name: LocalAsrModelFileName,
): string {
  const source = getLocalAsrDirectSourceDescriptor(distribution, sourceId);
  getLocalAsrDirectFileDescriptor(distribution, name);
  const encodedName = encodeURIComponent(name);
  return `${source.baseUrl}/${MODEL_REPOSITORY}/resolve/${distribution.revision}/${encodedName}?download=true`;
}

export function assertValidLocalAsrDirectDistribution(
  distribution: LocalAsrDirectModelDistribution,
): void {
  if (
    !/^[a-f0-9]{40}$/u.test(distribution.revision)
    || !Number.isSafeInteger(distribution.segmentCount)
    || distribution.segmentCount !== LOCAL_ASR_DIRECT_SEGMENT_COUNT
    || !Number.isSafeInteger(distribution.globalConcurrency)
    || distribution.globalConcurrency !== LOCAL_ASR_DIRECT_GLOBAL_CONCURRENCY
    || distribution.files.length !== LOCAL_ASR_MODEL_FILE_NAMES.length
    || distribution.sources.length !== LOCAL_ASR_DIRECT_SOURCE_IDS.length
  ) throw new Error('ASR_MODEL_DIRECT_DISTRIBUTION_INVALID');

  const names = new Set<LocalAsrModelFileName>();
  for (const file of distribution.files) {
    if (
      !LOCAL_ASR_MODEL_FILE_NAMES.includes(file.name)
      || names.has(file.name)
      || !Number.isSafeInteger(file.byteLength)
      || file.byteLength < distribution.segmentCount
      || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || (file.remoteKind !== 'lfs' && file.remoteKind !== 'git_blob')
    ) throw new Error('ASR_MODEL_DIRECT_DISTRIBUTION_INVALID');
    names.add(file.name);
  }
  if (LOCAL_ASR_MODEL_FILE_NAMES.some((name) => !names.has(name))) {
    throw new Error('ASR_MODEL_DIRECT_DISTRIBUTION_INVALID');
  }

  const sourceIds = new Set<LocalAsrDirectSourceId>();
  for (const source of distribution.sources) {
    if (
      !LOCAL_ASR_DIRECT_SOURCE_IDS.includes(source.id)
      || sourceIds.has(source.id)
      || (source.id === 'huggingface_official' && source.trust !== 'official')
      || (
        source.id === 'hf_mirror_acceleration'
        && source.trust !== 'third_party_acceleration_mirror'
      )
    ) throw new Error('ASR_MODEL_DIRECT_DISTRIBUTION_INVALID');
    let parsed: URL;
    try {
      parsed = new URL(source.baseUrl);
    } catch {
      throw new Error('ASR_MODEL_DIRECT_DISTRIBUTION_INVALID');
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.port !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
    ) throw new Error('ASR_MODEL_DIRECT_DISTRIBUTION_INVALID');
    sourceIds.add(source.id);
  }
}
