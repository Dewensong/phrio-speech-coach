import { CircleStop, Mic, RotateCcw, ShieldCheck } from 'lucide-react';

import type { RecordedAudio, RecorderStatus } from '../hooks/use-audio-recorder';

interface AudioRecorderPanelProps {
  status: RecorderStatus;
  elapsedMs: number;
  recordedAudio?: RecordedAudio;
  error?: string;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  onAccept: () => void;
}

function formatDuration(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function AudioRecorderPanel({
  status,
  elapsedMs,
  recordedAudio,
  error,
  busy,
  onStart,
  onStop,
  onReset,
  onAccept,
}: AudioRecorderPanelProps) {
  const recording = status === 'recording';

  return (
    <section className={`recorder-panel ${recording ? 'is-recording' : ''}`}>
      <div className="recorder-time" aria-live="polite">
        {formatDuration(elapsedMs)}
      </div>
      <p className="recorder-state">
        {status === 'idle' && '准备好后再开始，不会自动录音'}
        {status === 'requesting' && '正在请求麦克风权限…'}
        {recording && '正在写入本机临时目录 · 最长 5 分钟'}
        {status === 'recorded' && '录音已停止，请先回放确认'}
        {status === 'error' && error}
      </p>

      {recording ? (
        <div className="signal-bars" aria-hidden="true">
          {Array.from({ length: 17 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
      ) : recordedAudio ? (
        <audio className="audio-playback" controls preload="metadata">
          <source src={recordedAudio.url} type={recordedAudio.mimeType} />
          当前环境不能播放这段录音。
        </audio>
      ) : (
        <div className="recorder-ready-mark" aria-hidden="true">
          <Mic size={28} />
        </div>
      )}

      <div className="recorder-actions">
        {recording ? (
          <button className="primary-button" onClick={onStop} type="button">
            <CircleStop aria-hidden="true" size={17} />
            停止录音
          </button>
        ) : recordedAudio ? (
          <>
            <button className="secondary-button" onClick={onReset} type="button">
              <RotateCcw aria-hidden="true" size={16} />
              重录
            </button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={onAccept}
              type="button"
            >
              {busy ? '正在保存…' : '确认使用这遍'}
            </button>
          </>
        ) : (
          <button
            className="primary-button"
            disabled={status === 'requesting'}
            onClick={onStart}
            type="button"
          >
            <Mic aria-hidden="true" size={17} />
            {status === 'error' ? '重新检查麦克风' : '开始录音'}
          </button>
        )}
      </div>

      <footer className="recorder-privacy">
        <ShieldCheck aria-hidden="true" size={15} />
        这里只记录声音，不做实时语义判断，也不会发送到网络。
      </footer>
    </section>
  );
}
