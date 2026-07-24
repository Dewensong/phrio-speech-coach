import { LoaderCircle, Play, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { Attempt } from '../../shared';
import { readAttemptRecording } from '../services/desktop-api';
import type { AttemptKind } from '../types/ui';

type AudioLoadStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'failed';

interface AttemptAudioPlaybackProps {
  readonly attempt?: Attempt;
  readonly attemptKind: AttemptKind;
  readonly label: string;
  readonly sessionId: string;
  readonly loadRecording?: typeof readAttemptRecording;
}

export function AttemptAudioPlayback({
  attempt,
  attemptKind,
  label,
  sessionId,
  loadRecording = readAttemptRecording,
}: AttemptAudioPlaybackProps) {
  const [status, setStatus] = useState<AudioLoadStatus>('idle');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState(false);
  const requestRevision = useRef(0);

  useEffect(() => {
    requestRevision.current += 1;
    setStatus('idle');
    setAudioUrl(null);
    setPlaybackError(false);
    return () => {
      requestRevision.current += 1;
    };
  }, [attempt?.audioRef, attempt?.id, sessionId]);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const load = async () => {
    const revision = requestRevision.current + 1;
    requestRevision.current = revision;
    setStatus('loading');
    setPlaybackError(false);
    try {
      const recording = await loadRecording({ sessionId, attempt: attemptKind });
      if (revision !== requestRevision.current) return;
      if (!recording) {
        setStatus('missing');
        return;
      }
      setAudioUrl(URL.createObjectURL(recording));
      setStatus('ready');
    } catch {
      if (revision === requestRevision.current) setStatus('failed');
    }
  };

  if (!attempt) {
    return <p className="record-audio-state">尚未产生{label}录音。</p>;
  }

  if (!attempt.audioRef) {
    return <p className="record-audio-state">原始录音未保留，或已按本机保留设置删除。</p>;
  }

  return (
    <section className="record-audio-playback" aria-label={`${label}原始录音`}>
      <div>
        <strong>原始录音</strong>
        <span>仅从 Phrio 本机私有目录读取</span>
      </div>
      {status === 'idle' ? (
        <button className="secondary-button" onClick={() => void load()} type="button">
          <Play aria-hidden="true" size={14} />加载回放
        </button>
      ) : null}
      {status === 'loading' ? (
        <p className="record-audio-state" role="status">
          <LoaderCircle aria-hidden="true" className="spin" size={14} />正在读取本机录音…
        </p>
      ) : null}
      {status === 'ready' && audioUrl ? (
        <>
          <audio
            aria-label={`${label}录音回放`}
            controls
            onError={() => setPlaybackError(true)}
            preload="metadata"
            src={audioUrl}
          >
            你的浏览器不支持音频回放。
          </audio>
          {playbackError ? (
            <>
              <p className="inline-error" role="alert">录音已读取，但当前系统无法解码这个音频格式。</p>
              <button className="text-button" onClick={() => void load()} type="button">
                <RefreshCw aria-hidden="true" size={13} />重新读取录音
              </button>
            </>
          ) : null}
        </>
      ) : null}
      {status === 'missing' ? (
        <p className="inline-error" role="status">记录仍在，但对应录音文件当前不可用。</p>
      ) : null}
      {status === 'failed' ? (
        <p className="inline-error" role="alert">读取本机录音失败；练习记录本身没有被修改。</p>
      ) : null}
      {status === 'failed' || status === 'missing' ? (
        <button className="text-button" onClick={() => void load()} type="button">
          <RefreshCw aria-hidden="true" size={13} />重新读取录音
        </button>
      ) : null}
    </section>
  );
}
