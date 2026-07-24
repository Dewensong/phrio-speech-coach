import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttemptAudioPlayback } from '../../src/frontend/components/attempt-audio-playback';
import type { Attempt } from '../../src/shared';

const at = '2026-07-18T06:00:00.000Z';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function retainedAttempt(audioRef: string | null = 'retained/session-a/attempt-a.webm'): Attempt {
  return {
    id: 'attempt-a',
    sessionId: 'session-a',
    kind: 'initial',
    status: 'confirmed',
    audioRef,
    mimeType: 'audio/webm',
    durationMs: 12_000,
    byteLength: 24,
    createdAt: at,
    updatedAt: at,
    confirmedAt: at,
  };
}

describe('practice record audio playback', () => {
  it('loads a retained recording through the controlled reader and revokes its Blob URL', async () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retained-attempt');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let resolveRecording: ((blob: Blob) => void) | undefined;
    const loadRecording = vi.fn(() => new Promise<Blob>((resolve) => {
      resolveRecording = resolve;
    }));
    const { unmount } = render(
      <AttemptAudioPlayback
        attempt={retainedAttempt()}
        attemptKind="first"
        label="初讲"
        loadRecording={loadRecording}
        sessionId="session-a"
      />,
    );

    expect(screen.queryByRole('audio')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '加载回放' }));
    expect(screen.getByRole('status')).toHaveTextContent('正在读取本机录音');
    resolveRecording?.(new Blob(['real-audio-bytes'], { type: 'audio/webm' }));

    const playback = await screen.findByLabelText('初讲录音回放');
    expect(playback).toHaveAttribute('src', 'blob:retained-attempt');
    expect(loadRecording).toHaveBeenCalledWith({ sessionId: 'session-a', attempt: 'first' });
    expect(createObjectUrl).toHaveBeenCalledOnce();
    unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:retained-attempt');
  });

  it('states honestly when audio was not retained and never calls the reader', () => {
    const loadRecording = vi.fn();
    render(
      <AttemptAudioPlayback
        attempt={retainedAttempt(null)}
        attemptKind="first"
        label="初讲"
        loadRecording={loadRecording}
        sessionId="session-a"
      />,
    );

    expect(screen.getByText('原始录音未保留，或已按本机保留设置删除。')).toBeInTheDocument();
    expect(loadRecording).not.toHaveBeenCalled();
  });

  it('distinguishes a missing file, a read failure and a decode failure', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retry-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const loadRecording = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('disk read failed'))
      .mockResolvedValueOnce(new Blob(['unsupported'], { type: 'audio/webm' }));
    render(
      <AttemptAudioPlayback
        attempt={retainedAttempt()}
        attemptKind="first"
        label="初讲"
        loadRecording={loadRecording}
        sessionId="session-a"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '加载回放' }));
    expect(await screen.findByText('记录仍在，但对应录音文件当前不可用。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新读取录音' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('读取本机录音失败');
    fireEvent.click(screen.getByRole('button', { name: '重新读取录音' }));
    const playback = await screen.findByLabelText('初讲录音回放');
    fireEvent.error(playback);
    expect(await screen.findByRole('alert')).toHaveTextContent('无法解码这个音频格式');
  });
});
