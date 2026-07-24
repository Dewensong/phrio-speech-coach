import { describe, expect, it } from 'vitest';

import {
  MAX_PRACTICE_RECORD_TITLE_LENGTH,
  derivePracticeRecordTitle,
} from '../../src/shared';

describe('practice record title derivation', () => {
  it('uses the earliest final sequence and only its first Chinese sentence', () => {
    expect(derivePracticeRecordTitle([
      { sequence: 2, text: '这是后到的句段。' },
      { sequence: 0, text: '  我先讲结论。 然后补充原因。  ' },
    ])).toBe('我先讲结论。');
  });

  it('segments pure English and mixed quoted speech without losing closing punctuation', () => {
    expect(derivePracticeRecordTitle([
      { sequence: 0, text: 'Hello world. Then I will explain why.' },
    ])).toBe('Hello world.');
    expect(derivePracticeRecordTitle([
      { sequence: 0, text: '我说“Ship it.” Then we moved on.' },
    ])).toBe('我说“Ship it.”');
  });

  it('normalizes whitespace and ignores empty earlier segments', () => {
    expect(derivePracticeRecordTitle([
      { sequence: 0, text: '  \n  ' },
      { sequence: 1, text: 'This   is\tclear enough' },
    ])).toBe('This is clear enough');
  });

  it('bounds long emoji titles without splitting a Unicode code point', () => {
    const title = derivePracticeRecordTitle([
      { sequence: 0, text: `结论${'🙂'.repeat(180)}` },
    ]);
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(MAX_PRACTICE_RECORD_TITLE_LENGTH);
    expect(title).toMatch(/…$/u);
    expect(title).not.toContain('\uFFFD');
  });

  it('returns null when no frozen final contains spoken text', () => {
    expect(derivePracticeRecordTitle([])).toBeNull();
    expect(derivePracticeRecordTitle([{ sequence: 0, text: '   ' }])).toBeNull();
  });
});
