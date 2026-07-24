import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface StablePartialTranscriptProps {
  readonly observationKey: string;
  readonly text: string;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const PARTIAL_ANNOUNCEMENT_DEBOUNCE_MS = 450;

function graphemes(value: string): readonly string[] {
  return [...GRAPHEME_SEGMENTER.segment(value)].map(({ segment }) => segment);
}

export function longestCommonGraphemePrefix(left: string, right: string): string {
  const leftGraphemes = graphemes(left);
  const rightGraphemes = graphemes(right);
  const shared: string[] = [];
  const length = Math.min(leftGraphemes.length, rightGraphemes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftGraphemes[index] !== rightGraphemes[index]) break;
    shared.push(leftGraphemes[index]!);
  }
  return shared.join('');
}

/**
 * Gives two consecutive partial hypotheses a visual stability treatment only.
 * The full string remains one accessible partial transcript; nothing here can
 * create annotations, mutate the attempt, or cross the persistence boundary.
 */
export function StablePartialTranscript({
  observationKey,
  text,
}: StablePartialTranscriptProps) {
  const previousObservation = useRef<string | null>(null);
  const previousText = useRef<string | null>(null);
  const committedStablePrefix = useRef('');
  const [announcedText, setAnnouncedText] = useState('');
  const observationChanged = previousObservation.current !== observationKey;
  const textChangedWithoutRevision = !observationChanged && previousText.current !== text;
  const stablePrefix = !text || textChangedWithoutRevision
    ? ''
    : observationChanged && previousText.current
      ? longestCommonGraphemePrefix(previousText.current, text)
      : committedStablePrefix.current;

  useLayoutEffect(() => {
    previousObservation.current = text ? observationKey : null;
    previousText.current = text || null;
    committedStablePrefix.current = text ? stablePrefix : '';
  }, [observationKey, stablePrefix, text]);

  useEffect(() => {
    if (!text) {
      setAnnouncedText('');
      return;
    }
    const timer = window.setTimeout(() => {
      setAnnouncedText(text);
    }, PARTIAL_ANNOUNCEMENT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [observationKey, text]);

  const revisableSuffix = text.slice(stablePrefix.length);

  return (
    <p className="partial-transcript">
      <span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
        {announcedText ? `临时转写：${announcedText}` : ''}
      </span>
      <span aria-hidden="true" className="partial-transcript-visual">
        {stablePrefix ? (
          <span className="partial-stable-prefix" data-testid="partial-stable-prefix">
            {stablePrefix}
          </span>
        ) : null}
        <span className="partial-revisable-suffix" data-testid="partial-revisable-suffix">
          {revisableSuffix}
        </span>
        <span className="partial-caret" />
      </span>
    </p>
  );
}
