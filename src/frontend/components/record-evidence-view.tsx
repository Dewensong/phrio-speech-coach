import { Clock3, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  evidenceForDeepLane,
  type AttemptSnapshot,
  type LiveAnnotation,
  type LiveHint,
  type TranscriptCorrection,
} from '../../shared';
import { FrozenEvidenceLedger } from './evidence-ledger';
import { SegmentedTabs, type SegmentedTabOption } from './segmented-tabs';

type AttemptKind = AttemptSnapshot['kind'];

export interface EvidenceLocationTarget {
  readonly evidenceId: string;
  readonly segmentId: string;
  readonly requestId: number;
}

interface RecordEvidenceViewProps {
  readonly corrections: readonly TranscriptCorrection[];
  readonly initial?: AttemptSnapshot;
  readonly locationTarget?: EvidenceLocationTarget | null;
  readonly retry?: AttemptSnapshot;
  readonly sessionId: string;
}

const HINT_LIFECYCLE_LABELS: Record<LiveHint['lifecycle'], string> = {
  pending: '冻结时仍在处理',
  provisional: '冻结时采用',
  superseded: '已被后续提示迁移',
  withdrawn: '已撤回 · 历史保留',
  stale: '迟到结果已丢弃',
  failed: '请求失败 · 历史保留',
};

function formatFrozenAt(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function currentHint(snapshot: AttemptSnapshot): string {
  return [...snapshot.hints]
    .filter((hint) => hint.lifecycle === 'provisional')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.text
    ?? '本轮未形成可采用的实时短提示';
}

function replayAnnotations(
  snapshot: AttemptSnapshot,
  corrections: readonly TranscriptCorrection[],
): readonly LiveAnnotation[] {
  return evidenceForDeepLane(snapshot, corrections).map((item) => ({
    ...item.annotation,
    lifecycle: item.currentLifecycle,
    withdrawnReason: item.currentLifecycle === 'withdrawn'
      ? item.historyReason ?? item.annotation.withdrawnReason ?? '迁移历史仍保留'
      : item.annotation.withdrawnReason,
  }));
}

export function RecordEvidenceView({
  corrections,
  initial,
  locationTarget,
  retry,
  sessionId,
}: RecordEvidenceViewProps) {
  const snapshots = useMemo(
    () => [initial, retry].filter((snapshot): snapshot is AttemptSnapshot => Boolean(snapshot)),
    [initial, retry],
  );
  const [selectedKind, setSelectedKind] = useState<AttemptKind>(initial ? 'initial' : 'retry');

  useEffect(() => {
    setSelectedKind((current) => snapshots.some((snapshot) => snapshot.kind === current)
      ? current
      : snapshots[0]?.kind ?? 'initial');
  }, [sessionId, snapshots]);

  useEffect(() => {
    if (!locationTarget) return;
    const located = snapshots.find((snapshot) => (
      snapshot.finalSegments.some((segment) => segment.id === locationTarget.segmentId)
      || snapshot.annotations.some((annotation) => annotation.id === locationTarget.evidenceId)
    ));
    if (located) setSelectedKind(located.kind);
  }, [locationTarget, snapshots]);

  if (snapshots.length === 0) {
    return (
      <section className="record-evidence-empty" role="status">
        <ShieldCheck aria-hidden="true" size={22} />
        <h2>尚未形成冻结的实时证据</h2>
        <p>录音完成并收束 final 后，这里会保留原句、时间码、O 记录和提示历史。</p>
      </section>
    );
  }

  const selected = snapshots.find((snapshot) => snapshot.kind === selectedKind) ?? snapshots[0]!;
  const selectedCorrections = corrections.filter((correction) => correction.snapshotId === selected.id);
  const annotations = replayAnnotations(selected, selectedCorrections);
  const activeEvidenceId = locationTarget && (
    selected.finalSegments.some((segment) => segment.id === locationTarget.segmentId)
    || selected.annotations.some((annotation) => annotation.id === locationTarget.evidenceId)
  ) ? locationTarget.evidenceId : null;
  const attemptOptions: readonly SegmentedTabOption<AttemptKind>[] = snapshots.map((snapshot) => ({
    value: snapshot.kind,
    label: snapshot.kind === 'initial' ? '初讲' : '复讲',
    description: `${snapshot.finalSegments.length} final · ${snapshot.annotations.length} 条 O 记录`,
  }));

  return (
    <section className="record-evidence-view" aria-labelledby="record-evidence-heading">
      <header className="record-evidence-view-header">
        <div>
          <p className="eyebrow">录音时的实时证据格式</p>
          <h2 id="record-evidence-heading">原句与问题逐句对齐</h2>
          <p>这里回放录音结束时冻结的 final；逐字稿纠正不会覆盖当时的原句和 O 锚点。</p>
        </div>
        <span><ShieldCheck aria-hidden="true" size={13} />只读冻结回放</span>
      </header>

      <div className="record-evidence-boundary-note">
        <strong>留存边界</strong>
        <span>partial 只属于实时临时态，不会伪造成历史证据；最终诊断读取冻结快照及可追踪纠正。</span>
      </div>

      <SegmentedTabs
        ariaLabel="选择要回放的练习轮次"
        className="record-attempt-tabs"
        idBase="record-attempt"
        onChange={setSelectedKind}
        options={attemptOptions}
        value={selected.kind}
      />

      <div
        aria-labelledby={`record-attempt-tab-${selected.kind}`}
        className="record-evidence-attempt-panel"
        id={`record-attempt-panel-${selected.kind}`}
        role="tabpanel"
        tabIndex={0}
      >
        <div className="record-evidence-snapshot-meta">
          <span><Clock3 aria-hidden="true" size={13} />冻结于 {formatFrozenAt(selected.frozenAt)}</span>
          <span>逐字稿 v{selected.transcriptVersion}</span>
          <span>{selected.metrics.finalSegments} final</span>
          <span>{selected.annotations.length} 条 O 记录</span>
          {selectedCorrections.length > 0 ? <span>{selectedCorrections.length} 次后续纠正 · 原句仍保留</span> : null}
        </div>

        <FrozenEvidenceLedger
          activeEvidenceId={activeEvidenceId}
          annotations={annotations}
          currentHint={currentHint(selected)}
          snapshot={selected}
        />

        <details className="record-hint-archive">
          <summary>查看短 AI 提示历史 · {selected.hints.length} 条</summary>
          <div>
            {selected.hints.length ? selected.hints.map((hint) => (
              <article data-lifecycle={hint.lifecycle} key={hint.id}>
                <span>{HINT_LIFECYCLE_LABELS[hint.lifecycle]}</span>
                <p>{hint.text}</p>
                <small>关联 {hint.segmentIds.length} 个 final 句段 · 请求 {hint.requestSequence}</small>
              </article>
            )) : <p>本轮没有产生短 AI 提示。</p>}
          </div>
        </details>
      </div>
    </section>
  );
}
