import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TranscriptReviewPage } from '../../src/frontend/pages/transcript-review-page';
import type { AttemptSnapshot, PhrioDesktopApi, PracticeArtifact } from '../../src/shared';

const snapshot: AttemptSnapshot = {
  schemaVersion: 1,
  id: 'snapshot-correction-serial',
  sessionId: 'session-correction-serial',
  attemptId: 'attempt-correction-serial',
  generation: 1,
  kind: 'initial',
  frozenAt: '2026-07-18T08:00:10.000Z',
  audioWatermark: 8_000,
  transcriptVersion: 1,
  finalSegments: [
    {
      id: 'segment-serial-1',
      attemptId: 'attempt-correction-serial',
      sequence: 0,
      revision: 1,
      text: '第一句原文。',
      startMs: 0,
      endMs: 4_000,
      confidence: null,
      isFinal: true,
      emittedAt: '2026-07-18T08:00:04.000Z',
      finalizedAt: '2026-07-18T08:00:04.000Z',
      modelVersion: 'test-asr-1',
    },
    {
      id: 'segment-serial-2',
      attemptId: 'attempt-correction-serial',
      sequence: 1,
      revision: 1,
      text: '第二句原文。',
      startMs: 4_000,
      endMs: 8_000,
      confidence: null,
      isFinal: true,
      emittedAt: '2026-07-18T08:00:08.000Z',
      finalizedAt: '2026-07-18T08:00:08.000Z',
      modelVersion: 'test-asr-1',
    },
  ],
  annotations: [],
  hints: [],
  metrics: {
    finalCharacters: 12,
    finalSegments: 2,
    fillers: 0,
    hedges: 0,
    vagueWords: 0,
    repetitions: 0,
    selfCorrections: 0,
    algorithmVersion: 'local-rule-1',
  },
  focusVersion: null,
};

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'phrio');
  vi.restoreAllMocks();
});

describe('transcript correction serialization', () => {
  it('locks every other sentence until the active correction is durably saved', async () => {
    let resolveSave: ((artifact: PracticeArtifact) => void) | undefined;
    const putArtifact = vi.fn((artifact: PracticeArtifact) => (
      new Promise<PracticeArtifact>((resolve) => {
        resolveSave = resolve;
      })
    ));
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        listArtifacts: vi.fn().mockResolvedValue([{
          type: 'attempt_snapshot',
          sessionId: snapshot.sessionId,
          id: snapshot.id,
          payload: snapshot,
        }]),
        readAttemptAudio: vi.fn().mockRejectedValue(new Error('NO_AUDIO')),
        putArtifact,
      } as unknown as PhrioDesktopApi,
    });

    render(
      <TranscriptReviewPage
        onConfirm={vi.fn()}
        onRerecord={vi.fn()}
        sessionId={snapshot.sessionId}
        snapshot={snapshot}
      />,
    );

    const firstEdit = await screen.findByRole('button', { name: '纠正第 1 句' });
    fireEvent.click(firstEdit);
    fireEvent.change(screen.getByRole('textbox', { name: '纠正第 1 句' }), {
      target: { value: '第一句已纠正。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存纠正' }));

    await waitFor(() => expect(putArtifact).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '纠正第 2 句' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '确认逐字稿，进入复盘' })).toBeDisabled();

    const savedArtifact = putArtifact.mock.calls[0]?.[0];
    expect(savedArtifact).toBeDefined();
    resolveSave?.(savedArtifact!);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '纠正第 2 句' })).toBeEnabled();
    });
    expect(screen.getByText('第一句已纠正。')).toBeInTheDocument();
  });
});
