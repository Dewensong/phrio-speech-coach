import {
  ArrowLeft,
  Clock3,
  Download,
  FileText,
  Mic2,
  RotateCcw,
  Share2,
  Trash2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  evidenceForDeepLane,
  getSessionCompletionPath,
  listFrozenPracticeFocusOptions,
  selectAttemptSnapshot,
  transcriptForDeepLane,
  transcriptVersionForDeepLane,
  type Attempt,
  type AttemptComparison,
  type AttemptSnapshot,
  type CloudDeepDiagnosisArtifact,
  type DeepReport,
  type PracticeArtifact,
  type PracticeSession,
  type SemanticComparisonResponse,
  type TranscriptCorrection,
} from '../../shared';
import {
  deletePracticeSession,
  getPracticeRecord,
  type PracticeRecordView,
  type ResumableSessionView,
} from '../services/desktop-api';
import { AttemptAudioPlayback } from '../components/attempt-audio-playback';
import { ConfirmationDialog } from '../components/confirmation-dialog';
import { DiagnosisResultCard, type DiagnosisFocusSummary } from '../components/diagnosis-result-card';
import {
  RecordEvidenceView,
  type EvidenceLocationTarget,
} from '../components/record-evidence-view';
import { SegmentedTabs, type SegmentedTabOption } from '../components/segmented-tabs';
import { ShareResultDialog } from '../components/share-result-dialog';
import type { ShareCardData } from '../services/share-card';
import type { PracticeDraft } from '../types/ui';

type RecordDetailView = 'diagnosis' | 'evidence';

const RECORD_DETAIL_VIEW_OPTIONS: readonly SegmentedTabOption<RecordDetailView>[] = [
  { value: 'diagnosis', label: '诊断结果', description: '结论、依据、唯一焦点与下一步' },
  { value: 'evidence', label: '实时证据', description: '录音时的左右逐句对齐格式' },
];

interface PracticeRecordDetailPageProps {
  sessionId: string;
  onBack: () => void;
  onDeleted: () => void;
  onRepeat: (draft: PracticeDraft) => void;
  onResume: (session: ResumableSessionView) => void;
  resumeBusy?: boolean;
  resumeError?: string;
  loadRecord?: (sessionId: string) => Promise<PracticeRecordView | null>;
}

const STATUS_LABELS: Record<PracticeRecordView['session']['status'], string> = {
  setup: '准备中',
  first_attempt: '初讲进行中',
  transcript_review: '逐字稿待确认',
  diagnosis: '复盘处理中',
  focus: '待选择焦点',
  drill: 'Drill 进行中',
  second_attempt: '等待复讲',
  comparison: '等待查看对比',
  completed: '已完成',
  abandoned: '已结束',
};

function sessionStatusLabel(session: PracticeSession): string {
  if (session.status !== 'completed') return STATUS_LABELS[session.status];
  const completionPath = getSessionCompletionPath(session);
  if (completionPath === 'practice_loop_completed') return '已完成完整练习闭环';
  if (completionPath === 'focused_retry_without_comparison') return '焦点复讲已保存 · 对比未查看';
  if (completionPath === 'free_retry') return '自由复讲已保存';
  return '诊断已保存';
}

const COMPARISON_LABELS: Record<AttemptComparison['result'], string> = {
  improved: '目标行为更清楚',
  stable: '本轮基本持平',
  regressed: '本轮证据有所回退',
  insufficient_evidence: '证据不足，不作判断',
};

const CLOUD_COMPARISON_LABELS: Record<SemanticComparisonResponse['result'], string> = {
  improved: '云端语义证据支持改善',
  stable: '云端语义证据显示持平',
  regressed: '云端语义证据显示回退',
  insufficient_evidence: '云端语义证据不足',
};

const CLOUD_DIAGNOSIS_STATUS_LABELS: Record<CloudDeepDiagnosisArtifact['status'], string> = {
  queued: '已排队',
  processing: '处理中',
  complete: '已完成',
  failed: '失败',
  superseded: '历史态 · 已被纠正版本替代',
};

const ANNOTATION_LABELS: Record<AttemptSnapshot['annotations'][number]['type'], string> = {
  filler: '填充表达',
  hedge: '弱化表达',
  vague: '模糊词',
  repetition: '重复',
  self_correction: '自我修正',
  long_pause: '长停顿',
  speech_rate: '语速',
  structure: '结构信号',
  task_gap: '任务缺口',
};

const ANNOTATION_LIFECYCLE_LABELS: Record<AttemptSnapshot['annotations'][number]['lifecycle'], string> = {
  provisional: '冻结时待裁定',
  confirmed: '已确认',
  withdrawn: '已撤回 · 历史保留',
};

const HINT_LIFECYCLE_LABELS: Record<AttemptSnapshot['hints'][number]['lifecycle'], string> = {
  pending: '冻结时处理中',
  provisional: '本轮采用',
  superseded: '已被后续提示迁移',
  withdrawn: '已撤回 · 历史保留',
  stale: '迟到结果已丢弃',
  failed: '请求失败 · 历史保留',
};

function annotationHistoryReason(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === 'transcript_correction_changed_source') return '逐字稿纠正后，原证据来源已变化';
  if (reason === 'qa_correction_history') return '纠正后的迁移历史';
  return '证据来源已变化';
}

function hintHistoryReason(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === 'late_result') return '结果到达时已不再适用于当前文本';
  if (reason === 'consent_revoked') return '用户已撤回本轮实时 AI 同意';
  if (reason === 'timeout') return '请求超时';
  return '该提示未进入当前有效建议';
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatDuration(durationMs?: number): string {
  if (!durationMs) return '未录制';
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60)
    .toString()
    .padStart(2, '0')}`;
}

function artifactsOf<T extends PracticeArtifact['type']>(
  artifacts: readonly PracticeArtifact[],
  type: T,
): Array<Extract<PracticeArtifact, { type: T }>> {
  return artifacts.filter(
    (artifact): artifact is Extract<PracticeArtifact, { type: T }> =>
      artifact.type === type,
  );
}

export function PracticeRecordDetailPage({
  sessionId,
  onBack,
  onDeleted,
  onRepeat,
  onResume,
  resumeBusy = false,
  resumeError,
  loadRecord = getPracticeRecord,
}: PracticeRecordDetailPageProps) {
  const [record, setRecord] = useState<PracticeRecordView | null>();
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [activeView, setActiveView] = useState<RecordDetailView>('diagnosis');
  const [evidenceLocation, setEvidenceLocation] = useState<EvidenceLocationTarget | null>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const shareTriggerRef = useRef<HTMLButtonElement>(null);
  const shareDialogWasOpenRef = useRef(false);

  useEffect(() => {
    let active = true;
    setRecord(undefined);
    setError(undefined);
    void loadRecord(sessionId)
      .then((next) => {
        if (active) setRecord(next);
      })
      .catch(() => {
        if (!active) return;
        setError('暂时无法读取这次练习。');
        setRecord(null);
      });
    return () => {
      active = false;
    };
  }, [loadRecord, loadRevision, sessionId]);

  const detail = useMemo(
    () => record ? derivePracticeRecordDetail(record.artifacts, record.session) : null,
    [record],
  );
  const diagnosisEvidence = useMemo(
    () => detail?.initial
      ? evidenceForDeepLane(detail.initial, detail.corrections)
      : [],
    [detail],
  );
  const diagnosisFocus = useMemo<DiagnosisFocusSummary | null>(() => {
    if (!record || !detail?.report) return null;
    const reportFocus = detail.report.focus;
    let frozenOption: DiagnosisFocusSummary | undefined;
    try {
      const options = listFrozenPracticeFocusOptions(
        record.session.taskSnapshot,
        record.session.modeVersion,
      );
      frozenOption = reportFocus ? options.find((option) => (
        option.criterionId === reportFocus.criterionId
        && option.drillId === reportFocus.drillId
      )) : undefined;
    } catch {
      frozenOption = undefined;
    }
    return frozenOption ?? {
      criterionLabel: reportFocus?.label ?? '当前任务要求',
      successCondition: record.session.taskSnapshot.successConditions[0]
        ?? '让听众理解这次最想表达的核心内容',
      drillTitle: reportFocus ? '本轮短 Drill' : undefined,
      drillTemplate: reportFocus?.drill,
    };
  }, [detail, record]);
  const shareCardData = useMemo<ShareCardData | null>(() => {
    if (!record || !detail?.report || !diagnosisFocus) return null;
    const primaryEvidence = diagnosisEvidence.find(
      (item) => item.currentLifecycle === 'confirmed',
    );
    return {
      title: record.session.taskSnapshot.prompt,
      conclusion: detail.report.judgment,
      evidence: primaryEvidence?.annotation.evidence ?? null,
      focus: diagnosisFocus.criterionLabel,
      successCondition: diagnosisFocus.successCondition,
      comparison: detail.comparison ? COMPARISON_LABELS[detail.comparison.result] : null,
      comparisonDetail: detail.comparison?.explanation ?? null,
      createdAt: new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(record.session.createdAt)),
    };
  }, [detail, diagnosisEvidence, diagnosisFocus, record]);

  useEffect(() => {
    setActiveView('diagnosis');
    setEvidenceLocation(null);
    setShareDialogOpen(false);
  }, [sessionId]);

  useLayoutEffect(() => {
    if (shareDialogOpen) {
      shareDialogWasOpenRef.current = true;
      return;
    }
    if (!shareDialogWasOpenRef.current) return;
    shareDialogWasOpenRef.current = false;
    shareTriggerRef.current?.focus();
  }, [shareDialogOpen]);

  const remove = async () => {
    if (!record) return;
    setDeleting(true);
    setError(undefined);
    try {
      await deletePracticeSession(record.session.id);
      setConfirmDelete(false);
      onDeleted();
    } catch {
      setError('删除没有完成，请稍后重试。');
    } finally {
      setDeleting(false);
    }
  };

  if (record === undefined) {
    return <div className="record-detail-loading">正在读取冻结记录…</div>;
  }

  if (record === null || !detail) {
    return (
      <div className="record-detail-empty">
        <FileText aria-hidden="true" size={24} />
        <h1>没有找到这次练习</h1>
        <p>{error ?? '它可能已经被删除，或者本地记录尚未恢复。'}</p>
        <div className="page-actions">
          {error ? (
            <button
              className="secondary-button"
              onClick={() => setLoadRevision((revision) => revision + 1)}
              type="button"
            >
              重新读取
            </button>
          ) : null}
          <button className="secondary-button" onClick={onBack} type="button">返回全部记录</button>
        </div>
      </div>
    );
  }

  const { session, resumable } = record;
  const terminal = session.status === 'completed' || session.status === 'abandoned';
  const locateRecordEvidence = (segmentId: string, evidenceId: string) => {
    setEvidenceLocation((current) => ({
      evidenceId,
      segmentId,
      requestId: (current?.requestId ?? 0) + 1,
    }));
    setActiveView('evidence');
  };
  const closeShareDialog = () => {
    setShareDialogOpen(false);
  };

  return (
    <>
    <article className={`record-detail-page is-${activeView}-view`}>
      <header className="record-detail-header">
        <button className="text-button" disabled={resumeBusy} onClick={onBack} type="button">
          <ArrowLeft aria-hidden="true" size={15} />全部记录
        </button>
        <div className="record-detail-title">
          <span className="record-dossier-folio" aria-hidden="true">SESSION FILE · LOCAL</span>
          <p className="eyebrow">本次练习 · {formatDate(session.createdAt)}</p>
          <h1>{session.taskSnapshot.prompt}</h1>
          <div>
            <span>{resumable.draft.task.modeLabel}</span>
            <span>{sessionStatusLabel(session)}</span>
            <span>{resumable.draft.durationSeconds} 秒任务</span>
          </div>
        </div>
        <div className="record-detail-header-actions">
          <button
            className="share-result-button"
            disabled={resumeBusy || !shareCardData}
            onClick={() => setShareDialogOpen(true)}
            ref={shareTriggerRef}
            type="button"
          >
            <Share2 aria-hidden="true" size={15} />展示与分享
          </button>
          <button className="secondary-button" disabled={resumeBusy} onClick={() => exportReadableRecord(record)} type="button">
            <Download aria-hidden="true" size={15} />导出可读文本
          </button>
          <button className="danger-text-button" disabled={deleting || resumeBusy} onClick={() => setConfirmDelete(true)} type="button">
            <Trash2 aria-hidden="true" size={15} />{deleting ? '正在删除…' : '删除本次练习'}
          </button>
        </div>
      </header>

      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <SegmentedTabs
        ariaLabel="选择练习记录查看方式"
        className="record-detail-view-tabs"
        idBase="record-detail-view"
        onChange={setActiveView}
        options={RECORD_DETAIL_VIEW_OPTIONS}
        value={activeView}
      />

      {activeView === 'diagnosis' ? (
      <div
        aria-labelledby="record-detail-view-tab-diagnosis"
        className="record-detail-result-view"
        id="record-detail-view-panel-diagnosis"
        role="tabpanel"
        tabIndex={0}
      >
      {detail.report && detail.initial && diagnosisFocus ? (
        <DiagnosisResultCard
          evidence={diagnosisEvidence}
          headingLevel={2}
          onLocateEvidence={locateRecordEvidence}
          report={detail.report}
          snapshot={detail.initial ?? undefined}
          suggestedFocus={diagnosisFocus}
          suggestionSource={session.focus
            ? `引导来源：${guidanceLabel(session.guidanceSource)}`
            : '本轮诊断建议 · 来源未冻结'}
        />
      ) : (
        <section className="record-diagnosis-placeholder" role="status">
          <p className="eyebrow">本次诊断结果</p>
          <h2>诊断尚未形成</h2>
          <p>录音和 final 快照仍会保留；完成逐字稿确认后，结论、证据依据和唯一焦点会出现在这里。</p>
        </section>
      )}

      <section className="record-detail-summary">
        <article>
          <p className="eyebrow">任务条件</p>
          <dl>
            <div><dt>听众</dt><dd>{session.taskSnapshot.context.audience}</dd></div>
            <div><dt>目标</dt><dd>{session.taskSnapshot.context.objective}</dd></div>
            <div><dt>成功条件</dt><dd>{session.taskSnapshot.successConditions.join('；')}</dd></div>
          </dl>
        </article>
        <article className="record-path-card">
          <p className="eyebrow">本轮练习路径</p>
          <h2>{session.outcome === 'analysis_only'
            ? '诊断已保存，本轮在这里结束'
            : sessionStatusLabel(session)}</h2>
          <p>{session.outcome === 'analysis_only'
            ? '你在诊断结果可用后结束了本轮，没有被强制进入聚焦、Drill 或对比。'
            : session.focus
              ? '本轮已明确训练焦点；初讲、复讲与比较仍按实际完成情况分别保留。'
              : '本轮尚未确认训练焦点，诊断中的建议不会冒充你的选择。'}</p>
          <span>{session.focus ? `已选焦点：${session.focus.label}` : '尚未选择焦点'}</span>
        </article>
      </section>

      <section className="record-attempts" aria-label="初讲与复讲记录">
        <AttemptRecord
          attempt={session.attempts.find((attempt) => attempt.kind === 'initial')}
          corrections={detail.corrections}
          label="初讲"
          sessionId={session.id}
          snapshot={detail.initial ?? undefined}
        />
        <AttemptRecord
          attempt={session.attempts.find((attempt) => attempt.kind === 'retry')}
          corrections={detail.corrections}
          label="复讲"
          sessionId={session.id}
          snapshot={detail.retry ?? undefined}
        />
      </section>

      {detail.cloudDiagnoses.length > 0 ? (
        <CloudDiagnosisHistory runs={detail.cloudDiagnoses} />
      ) : null}

      <section className="record-comparison-card">
        <header>
          <div>
            <p className="eyebrow">同一口径的前后比较</p>
            <h2>{detail.comparison ? COMPARISON_LABELS[detail.comparison.result] : '尚未形成可比较结果'}</h2>
          </div>
          <span>{detail.comparison ? `协议 ${detail.comparison.protocolVersion}` : '等待复讲'}</span>
        </header>
        <p>{detail.comparison?.explanation ?? '完成同题复讲并查看对比后，这里会保留比较口径、证据与边界。'}</p>
        {detail.cloudComparison?.result ? (
          <div className="record-cloud-comparison">
            <div>
              <p className="eyebrow">可选云端补充 · 逐 payload 批准</p>
              <h3>{CLOUD_COMPARISON_LABELS[detail.cloudComparison.result.result]}</h3>
              <span>comparison-1 · 不改变本地结果与唯一焦点</span>
            </div>
            <p>{detail.cloudComparison.result.explanation}</p>
            <div className="record-cloud-evidence">
              <EvidenceList label="初讲语义证据" items={detail.cloudComparison.result.initialEvidence} />
              <EvidenceList label="复讲语义证据" items={detail.cloudComparison.result.retryEvidence} />
            </div>
            <details>
              <summary>查看当时批准的 exact JSON</summary>
              <pre>{JSON.stringify(detail.cloudComparison.approvedPayload, null, 2)}</pre>
            </details>
          </div>
        ) : null}
      </section>

      <section className="record-version-snapshot">
        <p className="eyebrow">版本快照</p>
        <dl>
          <div><dt>模式</dt><dd>v{session.modeVersion}</dd></div>
          <div><dt>任务</dt><dd>v{session.taskVersion}</dd></div>
          <div><dt>本地指标</dt><dd>{detail.metricVersions.join(' / ') || '本次无指标'}</dd></div>
          <div><dt>ASR</dt><dd>{detail.asrVersions.join(' / ') || '本次无 final'}</dd></div>
          <div><dt>音频</dt><dd>{session.attempts.some((attempt) => attempt.audioRef) ? '有本地引用 · 可在上方加载验证' : '未长期保存'}</dd></div>
        </dl>
      </section>
      </div>
      ) : (
        <div
          aria-labelledby="record-detail-view-tab-evidence"
          className="record-detail-evidence-panel"
          id="record-detail-view-panel-evidence"
          role="tabpanel"
          tabIndex={0}
        >
          <RecordEvidenceView
            corrections={detail.corrections}
            initial={detail.initial ?? undefined}
            locationTarget={evidenceLocation}
            retry={detail.retry ?? undefined}
            sessionId={session.id}
          />
        </div>
      )}

      <footer className="record-detail-footer">
        <div>
          <Clock3 aria-hidden="true" size={15} />最后更新于 {formatDate(session.updatedAt)}
        </div>
        <div>
          {!terminal ? (
            <button
              className="secondary-button"
              disabled={resumeBusy || Boolean(resumable.resumeBlockedReason)}
              onClick={() => onResume(resumable)}
              title={resumable.resumeBlockedReason ?? undefined}
              type="button"
            >
              {resumeBusy ? '正在恢复练习…' : '继续本次练习'}
            </button>
          ) : null}
          <button className="primary-button" disabled={resumeBusy} onClick={() => onRepeat(resumable.draft)} type="button">
            <RotateCcw aria-hidden="true" size={15} />再练同一题
          </button>
        </div>
      </footer>
      {resumeError ? <p className="inline-error" role="alert">{resumeError}</p> : null}
      {resumable.resumeBlockedReason ? <p className="inline-error" role="status">{resumable.resumeBlockedReason}</p> : null}
    </article>
    {confirmDelete ? (
      <ConfirmationDialog
        busy={deleting}
        cancelLabel="保留这次练习"
        confirmDangerous
        confirmLabel={deleting ? '正在删除…' : '确认永久删除'}
        description="对应 Attempt、逐字稿、证据、Deep 报告、前后比较和本地音频会一起删除，且无法恢复；外部已导出的文件不受影响。"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
        title="删除这次练习？"
      />
    ) : null}
    {shareDialogOpen && shareCardData ? (
      <ShareResultDialog data={shareCardData} onClose={closeShareDialog} />
    ) : null}
    </>
  );
}

export function derivePracticeRecordDetail(
  artifacts: readonly PracticeArtifact[],
  session: PracticeSession,
) {
  const corrections = artifactsOf(artifacts, 'transcript_correction').map((artifact) => artifact.payload);
  const reports = artifactsOf(artifacts, 'deep_report').map((artifact) => artifact.payload);
  const comparisons = artifactsOf(artifacts, 'attempt_comparison').map((artifact) => artifact.payload);
  const cloudComparisons = artifactsOf(artifacts, 'cloud_semantic_comparison')
    .map((artifact) => artifact.payload)
    .filter((artifact) => artifact.status === 'complete' && artifact.result !== null)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const cloudDiagnoses = artifactsOf(artifacts, 'cloud_deep_diagnosis')
    .map((artifact) => artifact.payload)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const initialAttempt = session.attempts.find((attempt) => attempt.kind === 'initial');
  const retryAttempt = session.attempts.find((attempt) => attempt.kind === 'retry');
  const initial = selectAttemptSnapshot({
    artifacts,
    kind: 'initial',
    expectedAttemptId: initialAttempt?.id,
  });
  const retry = selectAttemptSnapshot({
    artifacts,
    kind: 'retry',
    expectedAttemptId: retryAttempt?.id,
  });
  const currentTranscriptVersion = initial
    ? transcriptVersionForDeepLane(initial, corrections)
    : null;
  const currentReports = reports.filter((report) => (
    initial
    && report.snapshotId === initial.id
    && report.transcriptVersion === currentTranscriptVersion
  )).sort((left, right) => (
    left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
  ));
  const reportByFrozenChoice = session.diagnosisReportId
    ? reports.find((candidate) => candidate.id === session.diagnosisReportId)
    : undefined;
  const report = reportByFrozenChoice ?? (session.focus
    ? currentReports.find((candidate) => (
        candidate.focus?.criterionId === session.focus?.criterionId
        && candidate.focus?.drillId === session.focus?.drillId
      ))
    : currentReports.at(-1));
  const comparisonByFrozenChoice = session.comparisonArtifactId
    ? comparisons.find((candidate) => candidate.id === session.comparisonArtifactId)
    : undefined;
  const selectedSnapshots = [initial, retry].filter(
    (snapshot): snapshot is AttemptSnapshot => Boolean(snapshot),
  );
  const metricVersions = [...new Set(selectedSnapshots.map((snapshot) => snapshot.metrics.algorithmVersion))];
  const asrVersions = [...new Set(selectedSnapshots.flatMap((snapshot) => (
    snapshot.finalSegments.map((segment) => segment.modelVersion)
  )))];
  return {
    initial,
    retry,
    corrections,
    report,
    comparison: comparisonByFrozenChoice ?? comparisons.sort((left, right) => (
      left.comparedAt.localeCompare(right.comparedAt) || left.id.localeCompare(right.id)
    )).at(-1),
    cloudDiagnoses,
    cloudComparison: cloudComparisons.at(-1),
    metricVersions,
    asrVersions,
  };
}

function guidanceLabel(source: PracticeRecordView['session']['guidanceSource']): string {
  if (source === 'ai_evidence') return 'AI 证据';
  if (source === 'local_metric') return '本地规则';
  if (source === 'self_directed') return '用户自选';
  return '待确认';
}

function AttemptRecord({
  attempt,
  corrections,
  label,
  sessionId,
  snapshot,
}: {
  attempt?: Attempt;
  corrections: readonly TranscriptCorrection[];
  label: '初讲' | '复讲';
  sessionId: string;
  snapshot?: AttemptSnapshot;
}) {
  const transcript = snapshot ? transcriptForDeepLane(snapshot, corrections) : [];
  const annotations = snapshot ? evidenceForDeepLane(snapshot, corrections).map((item) => ({
    ...item.annotation,
    lifecycle: item.currentLifecycle,
    withdrawnReason: item.currentLifecycle === 'withdrawn'
      ? item.historyReason ?? item.annotation.withdrawnReason
      : item.annotation.withdrawnReason,
  })) : [];
  const hints = snapshot?.hints ?? [];
  return (
    <article className="record-attempt-card">
      <header>
        <div><Mic2 aria-hidden="true" size={16} /><strong>{label}</strong></div>
        <span>{formatDuration(attempt?.durationMs)}</span>
      </header>
      <AttemptAudioPlayback
        attempt={attempt}
        attemptKind={label === '初讲' ? 'first' : 'second'}
        label={label}
        sessionId={sessionId}
      />
      {snapshot ? (
        <>
          <div className="record-metrics" aria-label={`${label}实时统计`}>
            <span><strong>{snapshot.metrics.finalSegments}</strong> final</span>
            <span><strong>{snapshot.metrics.fillers}</strong> 填充</span>
            <span><strong>{snapshot.metrics.hedges + snapshot.metrics.vagueWords}</strong> 弱化/模糊</span>
          </div>
          <details className="record-attempt-inspection">
            <summary>查看逐字稿、O 记录与短提示历史</summary>
          <div className="record-transcript">
            <p className="eyebrow">冻结逐字稿 · v{snapshot.transcriptVersion}</p>
            {transcript.length ? transcript.map((segment) => (
              <div className="record-transcript-segment" key={segment.segmentId}>
                <p>{segment.currentText}</p>
                {segment.currentText !== segment.originalText ? (
                  <small>ASR 原句：{segment.originalText}</small>
                ) : null}
              </div>
            )) : <p className="record-muted">本次没有可用 final 句段。</p>}
          </div>
          <div className="record-evidence-list">
            <p className="eyebrow">原句证据 · 含生命周期历史</p>
            {annotations.length ? annotations.map((annotation) => {
              const reason = annotationHistoryReason(annotation.withdrawnReason);
              return (
                <div data-lifecycle={annotation.lifecycle} key={annotation.id}>
                  <span>{annotation.displayId}</span>
                  <p><strong>{ANNOTATION_LABELS[annotation.type]}</strong>{annotation.sourceSpan?.text ?? annotation.evidence}</p>
                  <small>
                    {ANNOTATION_LIFECYCLE_LABELS[annotation.lifecycle]} · {annotation.suggestion}
                    {reason ? ` · ${reason}` : ''}
                  </small>
                </div>
              );
            }) : <p className="record-muted">没有规则级问题证据。</p>}
          </div>
          <div className="record-hint-history">
            <p className="eyebrow">短 AI 提示 · 历史</p>
            {hints.length ? hints.map((hint) => {
              const reason = hintHistoryReason(hint.reason);
              return (
                <div data-lifecycle={hint.lifecycle} key={hint.id}>
                  <strong>{HINT_LIFECYCLE_LABELS[hint.lifecycle]}</strong>
                  <p>{hint.text}</p>
                  {reason ? <small>{reason}</small> : null}
                </div>
              );
            }) : <p className="record-muted">本轮没有产生短 AI 提示。</p>}
          </div>
          </details>
        </>
      ) : (
        <div className="record-attempt-empty">
          <p>{attempt ? '快照尚未冻结。' : `尚未完成${label}。`}</p>
        </div>
      )}
    </article>
  );
}

function buildReadableRecord(record: PracticeRecordView): string {
  const detail = derivePracticeRecordDetail(record.artifacts, record.session);
  const { session, resumable } = record;
  const lines = [
    'Phrio 单次练习记录',
    '',
    `任务：${session.taskSnapshot.prompt}`,
    `模式：${resumable.draft.task.modeLabel} v${session.modeVersion}`,
    `日期：${formatDate(session.createdAt)}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `听众：${session.taskSnapshot.context.audience}`,
    `目标：${session.taskSnapshot.context.objective}`,
    `唯一焦点：${session.focus?.label ?? detail.report?.focus?.label ?? '未选择'}`,
  ];
  for (const snapshot of [detail.initial, detail.retry]) {
    if (!snapshot) continue;
    const label = snapshot.kind === 'initial' ? '初讲' : '复讲';
    lines.push('', `${label}逐字稿：`);
    lines.push(...transcriptForDeepLane(snapshot, detail.corrections).map((segment) => segment.currentText));
  }
  if (detail.comparison) {
    lines.push('', `前后比较：${COMPARISON_LABELS[detail.comparison.result]}`, detail.comparison.explanation);
  }
  for (const diagnosis of detail.cloudDiagnoses) {
    lines.push('', `可选完整 AI 复盘：${CLOUD_DIAGNOSIS_STATUS_LABELS[diagnosis.status]}`);
    if (diagnosis.result) {
      const criterion = diagnosis.approvedPayload.task.rubric.find(
        (candidate) => candidate.criterionId === diagnosis.result?.focus.criterionId,
      );
      const drill = diagnosis.approvedPayload.task.drills.find(
        (candidate) => candidate.drillId === diagnosis.result?.focus.drillId,
      );
      lines.push(
        diagnosis.result.judgment,
        ...diagnosis.result.observations.map((observation) => `证据：${observation.evidence}；建议：${observation.suggestion}`),
        `唯一焦点：${criterion?.label ?? diagnosis.result.focus.criterionId}`,
        `Drill：${drill?.template ?? diagnosis.result.focus.drillId}`,
      );
    } else if (diagnosis.errorCode) {
      lines.push(`错误：${diagnosis.errorCode}`);
    }
  }
  if (detail.cloudComparison?.result) {
    lines.push(
      '',
      `可选云端语义补充：${CLOUD_COMPARISON_LABELS[detail.cloudComparison.result.result]}`,
      detail.cloudComparison.result.explanation,
      ...detail.cloudComparison.result.initialEvidence.map((evidence) => `初讲证据：${evidence}`),
      ...detail.cloudComparison.result.retryEvidence.map((evidence) => `复讲证据：${evidence}`),
    );
  }
  lines.push('', `版本：Mode ${session.modeVersion} / Task ${session.taskVersion}`);
  return lines.join('\n');
}

function CloudDiagnosisHistory({
  runs,
}: {
  readonly runs: readonly CloudDeepDiagnosisArtifact[];
}) {
  return (
    <section className="record-cloud-diagnosis" aria-label="完整 AI 复盘历史">
      <header>
        <div>
          <p className="eyebrow">完整 AI 复盘 · 可选云端补充</p>
          <h2>逐 payload 批准记录</h2>
        </div>
        <span>不替换本地复盘与唯一焦点</span>
      </header>
      <div className="record-cloud-diagnosis-runs">
        {runs.map((run) => {
          const result = run.result;
          const criterion = result
            ? run.approvedPayload.task.rubric.find(
                (candidate) => candidate.criterionId === result.focus.criterionId,
              )
            : null;
          const drill = result
            ? run.approvedPayload.task.drills.find(
                (candidate) => candidate.drillId === result.focus.drillId,
              )
            : null;
          return (
            <article data-status={run.status} key={run.analysisInputId}>
              <header>
                <strong>{CLOUD_DIAGNOSIS_STATUS_LABELS[run.status]}</strong>
                <time dateTime={run.updatedAt}>{formatDate(run.updatedAt)}</time>
              </header>
              {result ? (
                <>
                  <p>{result.judgment}</p>
                  <div className="record-cloud-diagnosis-evidence">
                    {result.observations.map((observation, index) => {
                      const segment = observation.segmentId
                        ? run.approvedPayload.finalSegments.find(
                            (candidate) => candidate.id === observation.segmentId,
                          )
                        : null;
                      return (
                        <div key={`${observation.type}-${observation.segmentId ?? index}`}>
                          <strong>{observation.evidence}</strong>
                          <span>{observation.suggestion}</span>
                          {segment ? <blockquote>{segment.text}</blockquote> : null}
                        </div>
                      );
                    })}
                  </div>
                  {criterion && drill ? (
                    <div className="record-cloud-diagnosis-focus">
                      <span>当时建议的唯一焦点 · 来自获批 Rubric/Drill</span>
                      <strong>{criterion.label}</strong>
                      <p>{drill.title}：{drill.template}</p>
                    </div>
                  ) : null}
                </>
              ) : run.status === 'failed' ? (
                <p>本次请求失败：<code>{run.errorCode}</code></p>
              ) : (
                <p>应用关闭前尚未形成最终结果；冻结快照与本地复盘不受影响。</p>
              )}
              <details>
                <summary>查看当时批准的 exact JSON</summary>
                <pre>{JSON.stringify(run.approvedPayload, null, 2)}</pre>
              </details>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function EvidenceList({ items, label }: { readonly items: readonly string[]; readonly label: string }) {
  return (
    <div>
      <strong>{label}</strong>
      {items.length > 0
        ? <ul>{items.map((item, index) => <li key={`${label}-${index}`}>{item}</li>)}</ul>
        : <p>没有足够的可引用证据。</p>}
    </div>
  );
}

function exportReadableRecord(record: PracticeRecordView): void {
  const blob = new Blob([buildReadableRecord(record)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${record.session.taskSnapshot.id}-${record.session.createdAt.slice(0, 10)}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
}
