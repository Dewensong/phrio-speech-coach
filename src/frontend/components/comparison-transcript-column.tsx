import { useState } from 'react';

import { transcriptForDeepLane } from '../../shared';

interface ComparisonTranscriptColumnProps {
  readonly focusFrozen?: boolean;
  readonly hintCount: number;
  readonly label: '初讲' | '复讲';
  readonly transcript: ReturnType<typeof transcriptForDeepLane>;
  readonly onSaveCorrection?: (
    segment: ReturnType<typeof transcriptForDeepLane>[number],
    correctedText: string,
  ) => Promise<void>;
}

export function ComparisonTranscriptColumn({
  focusFrozen = false,
  hintCount,
  label,
  transcript,
  onSaveCorrection,
}: ComparisonTranscriptColumnProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const beginEdit = (segment: ReturnType<typeof transcriptForDeepLane>[number]) => {
    setEditingId(segment.segmentId);
    setDraft(segment.currentText);
    setError(false);
  };

  const save = async (segment: ReturnType<typeof transcriptForDeepLane>[number]) => {
    const correctedText = draft.trim();
    if (!onSaveCorrection || !correctedText || correctedText === segment.currentText) {
      setEditingId(null);
      return;
    }
    setSaving(true);
    setError(false);
    try {
      await onSaveCorrection(segment, correctedText);
      setEditingId(null);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article>
      <span>{label} · {transcript.length} 个 final 句段</span>
      <div className="comparison-full-transcript">
        {transcript.length ? transcript.map((segment) => (
          <div key={segment.segmentId}>
            {editingId === segment.segmentId ? (
              <>
                <textarea
                  aria-label={`${label}逐字稿纠正`}
                  disabled={saving}
                  onChange={(event) => setDraft(event.target.value)}
                  value={draft}
                />
                <button disabled={saving} onClick={() => void save(segment)} type="button">
                  {saving ? '保存中…' : '保存纠正'}
                </button>
                <button disabled={saving} onClick={() => setEditingId(null)} type="button">取消</button>
              </>
            ) : (
              <>
                <p>{segment.currentText}</p>
                {onSaveCorrection ? (
                  <button onClick={() => beginEdit(segment)} type="button">纠正这句</button>
                ) : null}
              </>
            )}
          </div>
        )) : <p className="record-muted">没有可用 final 逐字稿。</p>}
      </div>
      {error ? <small role="alert">纠正没有保存成功，请重试。</small> : null}
      <small>实时干预：{hintCount} 条{focusFrozen ? ' · 唯一焦点已冻结' : ''}</small>
    </article>
  );
}
