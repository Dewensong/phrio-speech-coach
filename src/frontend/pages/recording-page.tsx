import { Mic2, ShieldCheck } from 'lucide-react';

import { AudioRecorderPanel } from '../components/audio-recorder-panel';
import { useAudioRecorder } from '../hooks/use-audio-recorder';
import type { RecordedAudio } from '../hooks/use-audio-recorder';
import type { AttemptKind, PracticeDraft } from '../types/ui';

interface RecordingPageProps {
  attempt: AttemptKind;
  draft: PracticeDraft;
  busy: boolean;
  saveError?: string;
  onAccept: (audio: RecordedAudio) => void;
}

export function RecordingPage({
  attempt,
  draft,
  busy,
  saveError,
  onAccept,
}: RecordingPageProps) {
  const recorder = useAudioRecorder();
  const retry = attempt === 'second';

  return (
    <div className="screen-grid recording-grid">
      <section className="main-pane recording-main">
        <div className="recording-task">
          <p className="eyebrow">
            {retry ? '第二遍 · 带着一个焦点再讲' : '第一遍 · 先完整说出来'}
          </p>
          <h1>{draft.task.title}</h1>
          <p>
            听众：{draft.audience} · 建议 {draft.durationSeconds} 秒 ·
            不要求一次说好
          </p>
        </div>

        {retry ? (
          <div className="focus-reminder">
            <span>本轮只练一点</span>
            <strong>开口 5 秒内先说冻结决定，再补两个原因。</strong>
          </div>
        ) : null}

        <AudioRecorderPanel
          busy={busy}
          elapsedMs={recorder.elapsedMs}
          error={recorder.error}
          onAccept={() => {
            if (recorder.recordedAudio) onAccept(recorder.recordedAudio);
          }}
          onReset={recorder.reset}
          onStart={() => void recorder.start()}
          onStop={recorder.stop}
          recordedAudio={recorder.recordedAudio}
          status={recorder.status}
        />
        {saveError ? <p className="inline-error" role="alert">{saveError}</p> : null}
      </section>

      <aside className="inspector recording-inspector">
        <header className="inspector-header"><strong>任务提示</strong></header>
        <div className="inspector-task-copy">
          <p className="eyebrow">这次只完成一件事</p>
          <h2>
            {retry
              ? '先说冻结决定，再给两个原因，最后明确行动。'
              : '把冻结决定、两点原因和下一步完整说出来。'}
          </h2>
        </div>
        <dl className="inspector-facts">
          <div><dt>听众</dt><dd>{draft.audience}</dd></div>
          <div><dt>建议时长</dt><dd>{draft.durationSeconds} 秒</dd></div>
          <div><dt>输入设备</dt><dd>系统默认麦克风</dd></div>
          <div><dt>保存策略</dt><dd>本地临时音频</dd></div>
        </dl>
        <div className="inspector-note">
          <ShieldCheck size={16} />
          不显示分数，不实时纠正，也不把音频发送给 AI。
        </div>
      </aside>
    </div>
  );
}
