import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  FileAudio,
  PencilLine,
  RotateCcw,
  Save,
} from 'lucide-react';

import {
  createTranscriptCorrectionId,
  selectAttemptSnapshot,
  transcriptForDeepLane,
  type AttemptSnapshot,
  type TranscriptCorrection,
} from '../../shared';
import {
  listPracticeArtifacts,
  readAttemptRecording,
  savePracticeArtifact,
} from '../services/desktop-api';

interface TranscriptReviewPageProps {
  readonly sessionId: string;
  readonly snapshot: AttemptSnapshot | null;
  readonly busy?: boolean;
  readonly error?: string;
  readonly onConfirm: () => void;
  readonly onRerecord: () => void;
}

type LoadStatus = 'loading' | 'ready' | 'error';

export function TranscriptReviewPage({
  sessionId,
  snapshot: providedSnapshot,
  busy = false,
  error,
  onConfirm,
  onRerecord,
}: TranscriptReviewPageProps) {
  const [snapshot, setSnapshot] = useState(providedSnapshot);
  const [corrections, setCorrections] = useState<TranscriptCorrection[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const correctionSavePending = useRef(false);

  const load = useCallback(async () => {
    setLoadStatus('loading');
    setLoadError(null);
    try {
      const artifacts = await listPracticeArtifacts(sessionId);
      const nextSnapshot = selectAttemptSnapshot({
        artifacts,
        kind: 'initial',
        preferredSnapshotId: providedSnapshot?.id,
      }) ?? providedSnapshot;
      if (!nextSnapshot) throw new Error('SNAPSHOT_NOT_AVAILABLE');
      const storedCorrections = artifacts
        .filter((artifact): artifact is Extract<typeof artifact, { type: 'transcript_correction' }> => (
          artifact.type === 'transcript_correction'
          && artifact.payload.snapshotId === nextSnapshot.id
        ))
        .map((artifact) => artifact.payload)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      setSnapshot(nextSnapshot);
      setCorrections(storedCorrections);
      setLoadStatus('ready');
    } catch {
      setLoadStatus('error');
      setLoadError('冻结逐字稿暂时无法读取。录音仍保留在本机，你可以重试或重新录制。');
    }
  }, [providedSnapshot, sessionId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setAudioError(null);
    void readAttemptRecording({ sessionId, attempt: 'first' })
      .then((blob) => {
        if (!active || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setAudioUrl(objectUrl);
      })
      .catch(() => {
        if (active) setAudioError('本地音频暂时无法回放；逐字稿仍可确认和纠正。');
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId]);

  const transcript = useMemo(
    () => snapshot ? transcriptForDeepLane(snapshot, corrections) : [],
    [corrections, snapshot],
  );

  const saveCorrection = async (
    segmentId: string,
    originalText: string,
    currentText: string,
    correctedTextInput: string,
  ) => {
    if (!snapshot || correctionSavePending.current) return;
    const correctedText = correctedTextInput.trim();
    if (!correctedText || correctedText === currentText) {
      setEditingId(null);
      return;
    }
    correctionSavePending.current = true;
    setSavingId(segmentId);
    setSaveError(null);
    const correction: TranscriptCorrection = {
      id: createTranscriptCorrectionId(),
      snapshotId: snapshot.id,
      segmentId,
      originalText,
      correctedText,
      createdAt: new Date().toISOString(),
    };
    try {
      await savePracticeArtifact({
        type: 'transcript_correction',
        sessionId,
        id: correction.id,
        payload: correction,
      });
      setCorrections((current) => [...current, correction]);
      setEditingId(null);
    } catch {
      setSaveError('这句纠正没有保存成功，原句没有被覆盖。请重试。');
    } finally {
      correctionSavePending.current = false;
      setSavingId(null);
    }
  };

  if (loadStatus === 'loading') {
    return <section className="deep-lane-empty" aria-live="polite"><FileAudio size={20} /><h1>正在读取冻结逐字稿</h1><p>只读取已经落定的 final 句段。</p></section>;
  }

  if (loadStatus === 'error' || !snapshot) {
    return (
      <section className="deep-lane-empty">
        <AlertTriangle size={20} />
        <h1>逐字稿尚未就绪</h1>
        <p role="alert">{loadError}</p>
        <div className="page-actions">
          <button className="secondary-button" onClick={() => void load()} type="button">重试读取</button>
          <button className="secondary-button" onClick={onRerecord} type="button"><RotateCcw size={16} />重新录制</button>
        </div>
      </section>
    );
  }

  return (
    <div className="screen-grid transcript-grid">
      <section className="main-pane transcript-main">
        <header className="work-pane-header">
          <div>
            <span className="transcript-folio" aria-hidden="true">稿 01</span>
            <h1>确认原句逐字稿</h1>
            <p>这里只有 final 句段。纠正会作为新版本保存，冻结原句和历史证据不会被覆盖。</p>
          </div>
          <span className="source-chip"><FileAudio size={15} />本地录音 · final v{snapshot.transcriptVersion}</span>
        </header>

        {audioUrl ? <audio className="transcript-audio" controls preload="metadata" src={audioUrl}>你的浏览器不支持音频回放。</audio> : null}
        {audioError ? <p className="inline-error" role="status">{audioError}</p> : null}

        <div className="transcript-document review-document">
          {transcript.map((segment, index) => (
            <TranscriptRow
              currentText={segment.currentText}
              editLocked={savingId !== null}
              editing={editingId === segment.segmentId}
              index={index}
              key={segment.segmentId}
              onCancel={() => setEditingId(null)}
              onEdit={() => setEditingId(segment.segmentId)}
              onSave={(value) => void saveCorrection(
                segment.segmentId,
                segment.originalText,
                segment.currentText,
                value,
              )}
              originalText={segment.originalText}
              saving={savingId === segment.segmentId}
              segment={snapshot.finalSegments.find((candidate) => candidate.id === segment.segmentId)!}
            />
          ))}
        </div>
      </section>

      <aside className="inspector transcript-inspector">
        <header className="inspector-header"><strong>校对状态</strong><span>PROOF · FINAL</span></header>
        <div className="status-summary">
          <Check size={18} />
          <div><strong>{transcript.length} 个 final 句段已冻结</strong><span>{corrections.length} 次可追踪纠正</span></div>
        </div>
        <dl className="inspector-facts">
          <div><dt>音频来源</dt><dd>本地真实录音</dd></div>
          <div><dt>文字来源</dt><dd>{snapshot.finalSegments[0]?.modelVersion ?? '本地 ASR'}</dd></div>
          <div><dt>网络发送</dt><dd>无</dd></div>
        </dl>
        {saveError ? <p className="inline-error" role="alert">{saveError}</p> : null}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <div className="inspector-command">
          <button className="secondary-button" disabled={busy || savingId !== null} onClick={onRerecord} type="button">
            <RotateCcw size={16} />重新录制
          </button>
          <button className="primary-button" disabled={busy || savingId !== null || transcript.length === 0} onClick={onConfirm} type="button">
            {busy ? '正在保存…' : '确认逐字稿，进入复盘'}
          </button>
        </div>
      </aside>
    </div>
  );
}

function TranscriptRow({
  segment,
  index,
  originalText,
  currentText,
  editLocked,
  editing,
  saving,
  onEdit,
  onCancel,
  onSave,
}: {
  readonly segment: AttemptSnapshot['finalSegments'][number];
  readonly index: number;
  readonly originalText: string;
  readonly currentText: string;
  readonly editLocked: boolean;
  readonly editing: boolean;
  readonly saving: boolean;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
  readonly onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(currentText);
  useEffect(() => { setValue(currentText); }, [currentText, editing]);
  return (
    <article className="transcript-row">
      <time>{formatTime(segment.startMs)}</time>
      {editing ? (
        <div className="correction-editor">
          <textarea aria-label={`纠正第 ${index + 1} 句`} disabled={saving} onChange={(event) => setValue(event.target.value)} value={value} />
          <div>
            <button className="text-button" disabled={saving} onClick={onCancel} type="button">取消</button>
            <button className="secondary-button" disabled={saving || !value.trim()} onClick={() => onSave(value)} type="button"><Save size={14} />{saving ? '保存中…' : '保存纠正'}</button>
          </div>
        </div>
      ) : (
        <div className="review-segment-text">
          <p>{currentText}</p>
          {currentText !== originalText ? <small>已纠正；冻结原句仍保留在版本历史</small> : null}
        </div>
      )}
      {!editing ? (
        <button
          aria-label={`纠正第 ${index + 1} 句`}
          disabled={editLocked}
          onClick={onEdit}
          type="button"
        >
          <PencilLine size={15} />
        </button>
      ) : null}
    </article>
  );
}

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
