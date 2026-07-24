import type { TranscriptSegment } from './live-practice';

export const MAX_PRACTICE_RECORD_TITLE_LENGTH = 200;

const FALLBACK_SENTENCE_END = /^(.*?(?:[。！？!?]+|[.]+)[”’"'」』】》）)]*)/u;

function normalizeSpokenText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function boundedTitle(text: string): string {
  if (text.length <= MAX_PRACTICE_RECORD_TITLE_LENGTH) return text;
  let prefix = '';
  for (const character of text) {
    if (prefix.length + character.length > MAX_PRACTICE_RECORD_TITLE_LENGTH - 1) break;
    prefix += character;
  }
  return `${prefix.trimEnd()}…`;
}

function firstSentence(text: string): string {
  if (typeof Intl.Segmenter === 'function') {
    const iterator = new Intl.Segmenter('zh-CN', { granularity: 'sentence' })
      .segment(text)[Symbol.iterator]();
    const first = iterator.next().value as Intl.SegmentData | undefined;
    const sentence = first?.segment.trim();
    if (sentence) return sentence;
  }
  return text.match(FALLBACK_SENTENCE_END)?.[1] ?? text;
}

/**
 * Derives the stable default record name from the first frozen final sentence.
 * Partial text never reaches this boundary, and an explicit rename is stored
 * with a source marker so an idempotent snapshot retry cannot overwrite the
 * user's choice.
 */
export function derivePracticeRecordTitle(
  finalSegments: readonly Pick<TranscriptSegment, 'text' | 'sequence'>[],
): string | null {
  const firstFinalText = [...finalSegments]
    .sort((left, right) => left.sequence - right.sequence)
    .map((segment) => normalizeSpokenText(segment.text))
    .find((text) => text.length > 0);
  if (!firstFinalText) return null;
  return boundedTitle(firstSentence(firstFinalText));
}
