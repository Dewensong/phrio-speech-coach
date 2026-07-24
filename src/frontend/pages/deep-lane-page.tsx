import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  Edit3,
  FileCheck2,
  Mic2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';

import {
  buildLocalDeepReport,
  createTranscriptCorrectionId,
  deriveLocalDeepReportId,
  evidenceForDeepLane,
  listFrozenPracticeFocusOptions,
  selectAttemptSnapshot,
  transcriptForDeepLane,
  type AttemptSnapshot,
  type DeepReport,
  type PracticeSession,
  type TranscriptCorrection,
} from '../../shared';
import { DeepCloudDiagnosisPanel } from '../components/deep-cloud-diagnosis-panel';
import { DiagnosisResultCard } from '../components/diagnosis-result-card';
import {
  useDeepCloudDiagnosis,
  type DeepCloudDiagnosisDependencies,
} from '../hooks/use-deep-cloud-diagnosis';
import {
  getPracticeSession,
  listPracticeArtifacts,
  savePracticeArtifact,
} from '../services/desktop-api';
import type { PracticeDraft, SelectedPracticeFocus } from '../types/ui';

interface DeepLanePageProps {
  readonly sessionId: string;
  readonly snapshot: AttemptSnapshot | null;
  readonly draft: PracticeDraft;
  readonly busy?: boolean;
  readonly error?: string;
  readonly onStartDrill: (focus: SelectedPracticeFocus, diagnosisReportId: string) => void;
  readonly onFinishAnalysis?: (diagnosisReportId: string) => void;
  readonly onStartFreeRetry?: (diagnosisReportId: string) => void;
  readonly cloudDependencies?: DeepCloudDiagnosisDependencies;
  readonly loadPracticeArtifacts?: typeof listPracticeArtifacts;
  readonly persistPracticeArtifact?: typeof savePracticeArtifact;
}

type PageStatus = 'loading' | 'ready' | 'error';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type FocusSelectionOrigin =
  | { readonly type: 'default_local_rule' }
  | { readonly type: 'cloud_ai'; readonly analysisInputId: string }
  | { readonly type: 'user_selection' };

export function DeepLanePage({
  sessionId,
  snapshot: providedSnapshot,
  busy = false,
  error,
  onStartDrill,
  onFinishAnalysis,
  onStartFreeRetry,
  cloudDependencies,
  loadPracticeArtifacts = listPracticeArtifacts,
  persistPracticeArtifact = savePracticeArtifact,
}: DeepLanePageProps) {
  const [snapshot, setSnapshot] = useState(providedSnapshot);
  const [practiceSession, setPracticeSession] = useState<PracticeSession | null>(null);
  const [corrections, setCorrections] = useState<TranscriptCorrection[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [correctionStatus, setCorrectionStatus] = useState<SaveStatus>('idle');
  const [reportStatus, setReportStatus] = useState<SaveStatus>('idle');
  const [savedReportId, setSavedReportId] = useState<string | null>(null);
  const [reportSaveRevision, setReportSaveRevision] = useState(0);
  const [focusOrigin, setFocusOrigin] = useState<FocusSelectionOrigin>({
    type: 'default_local_rule',
  });
  const [highlightedSegmentId, setHighlightedSegmentId] = useState<string | null>(null);
  const segmentElements = useRef(new Map<string, HTMLElement>());
  const correctionTriggers = useRef(new Map<string, HTMLButtonElement>());
  const correctionReturnFocus = useRef<string | null>(null);
  const highlightTimer = useRef<number | undefined>(undefined);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const focusedResultSnapshot = useRef<string | null>(null);
  const loadSession = cloudDependencies?.getSession ?? getPracticeSession;
  const focusResolution = useMemo(() => {
    if (!practiceSession) return { options: [], error: null };
    try {
      return {
        options: listFrozenPracticeFocusOptions(
          practiceSession.taskSnapshot,
          practiceSession.modeVersion,
        ),
        error: null,
      };
    } catch {
      return {
        options: [],
        error: '这条记录缺少可验证的冻结 Rubric/Drill 定义；原句和证据仍保留，但不能用当前定义继续训练。',
      };
    }
  }, [practiceSession]);
  const focusOptions = focusResolution.options;
  const [selectedFocusKey, setSelectedFocusKey] = useState('');
  const selectedFocusKeyRef = useRef('');
  const focusSessionRef = useRef(sessionId);

  useEffect(() => {
    const sessionChanged = focusSessionRef.current !== sessionId;
    if (sessionChanged) {
      focusSessionRef.current = sessionId;
      selectedFocusKeyRef.current = '';
    }
    const currentSelectionIsValid = !sessionChanged && focusOptions.some(
      (option) => `${option.criterionId}:${option.drillId}` === selectedFocusKeyRef.current,
    );
    // A user or cloud selection can happen immediately after the options first
    // render but before this passive initialization effect runs. Never let that
    // late defaulting pass overwrite the explicit origin.
    if (currentSelectionIsValid) return;
    const first = focusOptions.find((option) => option.recommended) ?? focusOptions[0];
    const firstKey = first ? `${first.criterionId}:${first.drillId}` : '';
    selectedFocusKeyRef.current = firstKey;
    setSelectedFocusKey(firstKey);
    setFocusOrigin({ type: 'default_local_rule' });
  }, [focusOptions, selectedFocusKey, sessionId]);

  const load = useCallback(async () => {
    setPageStatus('loading');
    setPageError(null);
    try {
      const [artifacts, storedSession] = await Promise.all([
        loadPracticeArtifacts(sessionId),
        loadSession(sessionId),
      ]);
      if (!storedSession || storedSession.id !== sessionId) {
        throw new Error('PRACTICE_SESSION_NOT_FOUND');
      }
      const expectedAttempt = storedSession.attempts.find((attempt) => attempt.kind === 'initial');
      const identityMatchedProvided = providedSnapshot
        && providedSnapshot.sessionId === storedSession.id
        && providedSnapshot.kind === 'initial'
        && (!expectedAttempt || providedSnapshot.attemptId === expectedAttempt.id)
        ? providedSnapshot
        : null;
      const nextSnapshot = selectAttemptSnapshot({
        artifacts,
        kind: 'initial',
        expectedAttemptId: expectedAttempt?.id,
        preferredSnapshotId: providedSnapshot?.id,
      }) ?? identityMatchedProvided;
      if (!nextSnapshot) throw new Error('SNAPSHOT_NOT_AVAILABLE');
      const storedCorrections = artifacts
        .filter((artifact): artifact is Extract<typeof artifact, { type: 'transcript_correction' }> => (
          artifact.type === 'transcript_correction'
          && artifact.payload.snapshotId === nextSnapshot.id
        ))
        .map((artifact) => artifact.payload)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const attempt = storedSession.attempts.find((candidate) => candidate.id === nextSnapshot.attemptId);
      if (
        nextSnapshot.sessionId !== storedSession.id
        || !attempt
        || attempt.kind !== nextSnapshot.kind
        || storedSession.taskSnapshot.id !== storedSession.taskId
        || storedSession.taskSnapshot.version !== storedSession.taskVersion
      ) {
        throw new Error('SNAPSHOT_SESSION_IDENTITY_MISMATCH');
      }
      setPracticeSession(storedSession);
      setSnapshot(nextSnapshot);
      setCorrections(storedCorrections);
      setPageStatus('ready');
    } catch (error) {
      setPageStatus('error');
      const code = error instanceof Error ? error.message : '';
      setPageError(
        code === 'PRACTICE_SESSION_NOT_FOUND'
          ? '这次练习的持久化 Session 暂时无法读取。Fast Lane 记录没有被替换，请重试。'
          : code === 'SNAPSHOT_SESSION_IDENTITY_MISMATCH'
            ? '冻结快照与这次练习的 Session/Attempt 身份不一致，已阻止串用其他练习的数据。'
            : '冻结快照暂时无法读取。Fast Lane 记录没有被替换，请重试。',
      );
    }
  }, [loadPracticeArtifacts, loadSession, providedSnapshot, sessionId]);

  useEffect(() => { void load(); }, [load]);

  const selectedFocus = focusOptions.find(
    (option) => `${option.criterionId}:${option.drillId}` === selectedFocusKey,
  ) ?? focusOptions[0];
  const transcript = useMemo(
    () => snapshot ? transcriptForDeepLane(snapshot, corrections) : [],
    [corrections, snapshot],
  );
  const evidence = useMemo(
    () => snapshot ? evidenceForDeepLane(snapshot, corrections) : [],
    [corrections, snapshot],
  );
  const activeEvidence = evidence.filter((item) => item.currentLifecycle === 'confirmed');
  const localReport = useMemo<DeepReport | null>(() => {
    if (!snapshot || !selectedFocus) return null;
    return buildLocalDeepReport({
      id: 'deep-report-preview',
      snapshot,
      corrections,
      at: corrections.at(-1)?.createdAt ?? snapshot.frozenAt,
      focus: {
        criterionId: selectedFocus.criterionId,
        label: selectedFocus.criterionLabel,
        drillId: selectedFocus.drillId,
        drill: selectedFocus.drillTemplate,
      },
    });
  }, [corrections, selectedFocus, snapshot]);
  const cloudDiagnosis = useDeepCloudDiagnosis({
    sessionId,
    snapshot,
    corrections,
    dependencies: cloudDependencies,
  });

  useEffect(() => {
    if (
      pageStatus !== 'ready'
      || !snapshot
      || !localReport
      || focusedResultSnapshot.current === snapshot.id
    ) return;
    focusedResultSnapshot.current = snapshot.id;
    resultHeading.current?.focus({ preventScroll: true });
  }, [localReport, pageStatus, snapshot]);

  useEffect(() => () => {
    if (highlightTimer.current !== undefined) window.clearTimeout(highlightTimer.current);
  }, []);

  useEffect(() => {
    if (editingId !== null || correctionReturnFocus.current === null) return;
    const segmentId = correctionReturnFocus.current;
    correctionReturnFocus.current = null;
    correctionTriggers.current.get(segmentId)?.focus({ preventScroll: true });
  }, [editingId]);

  const locateCloudEvidence = useCallback((segmentId: string) => {
    const element = segmentElements.current.get(segmentId);
    if (!element) return;
    const reducedMotion = document.documentElement.dataset.reduceMotion === 'true'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    element.focus({ preventScroll: true });
    setHighlightedSegmentId(segmentId);
    if (highlightTimer.current !== undefined) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlightedSegmentId(null), 1_800);
  }, []);

  const adoptCloudFocus = useCallback((
    criterionId: string,
    drillId: string,
    analysisInputId: string,
  ) => {
    const option = focusOptions.find(
      (candidate) => candidate.criterionId === criterionId && candidate.drillId === drillId,
    );
    if (!option) return;
    const nextKey = `${option.criterionId}:${option.drillId}`;
    selectedFocusKeyRef.current = nextKey;
    setSelectedFocusKey(nextKey);
    setFocusOrigin({ type: 'cloud_ai', analysisInputId });
  }, [focusOptions]);

  useEffect(() => {
    if (!localReport?.focus || pageStatus !== 'ready') {
      setReportStatus('idle');
      setSavedReportId(null);
      return;
    }
    const reportFocus = localReport.focus;
    let active = true;
    setReportStatus('saving');
    setSavedReportId(null);
    void deriveLocalDeepReportId({
      snapshotId: localReport.snapshotId,
      transcriptVersion: localReport.transcriptVersion,
      criterionId: reportFocus.criterionId,
      drillId: reportFocus.drillId,
    }).then((id) => persistPracticeArtifact({
      type: 'deep_report',
      sessionId,
      id,
      payload: { ...localReport, id },
    })).then((artifact) => {
      if (active) {
        setSavedReportId(artifact.id);
        setReportStatus('saved');
      }
    }).catch(() => {
      if (active) setReportStatus('error');
    });
    return () => { active = false; };
  }, [localReport, pageStatus, persistPracticeArtifact, reportSaveRevision, sessionId]);

  const saveCorrection = async (
    segmentId: string,
    originalText: string,
    currentText: string,
    correctedTextInput: string,
  ) => {
    if (!snapshot) return;
    const correctedText = correctedTextInput.trim();
    if (!correctedText || correctedText === currentText) {
      correctionReturnFocus.current = segmentId;
      setEditingId(null);
      return;
    }
    const correction: TranscriptCorrection = {
      id: createTranscriptCorrectionId(),
      snapshotId: snapshot.id,
      segmentId,
      originalText,
      correctedText,
      createdAt: new Date().toISOString(),
    };
    const reportStatusBeforeCorrection = reportStatus;
    // Invalidate the current report before the append-only correction crosses
    // the persistence boundary. The next correction version must produce and
    // persist its own report before navigation can continue.
    setReportStatus('saving');
    setCorrectionStatus('saving');
    try {
      await persistPracticeArtifact({
        type: 'transcript_correction',
        sessionId,
        id: correction.id,
        payload: correction,
      });
      setCorrections((current) => [...current, correction]);
      correctionReturnFocus.current = segmentId;
      setEditingId(null);
      setCorrectionStatus('saved');
    } catch {
      setCorrectionStatus('error');
      // The append-only correction did not cross the persistence boundary, so
      // the previously saved report is still authoritative. Restore its state
      // instead of leaving Drill permanently stuck on "saving" after cancel.
      setReportStatus(reportStatusBeforeCorrection);
    }
  };

  if (pageStatus === 'loading') {
    return <section className="deep-lane-empty" aria-live="polite"><BrainCircuit size={20} /><h1>正在读取冻结快照</h1><p>Deep Lane 不读取迁移中的临时 UI 状态。</p></section>;
  }

  if (pageStatus === 'error' || !snapshot || !selectedFocus) {
    return (
      <section className="deep-lane-empty">
        <BrainCircuit size={20} />
        <h1>完整复盘尚未就绪</h1>
        <p role="alert">{pageError ?? focusResolution.error ?? '当前任务没有可用的训练焦点。'}</p>
        <button className="secondary-button" onClick={() => void load()} type="button"><RefreshCw size={15} />重试读取</button>
      </section>
    );
  }

  const focusEvidenceIds = activeEvidence
    .filter((item) => ['structure', 'task_gap', 'long_pause', 'speech_rate'].includes(item.annotation.type))
    .slice(0, 12)
    .map((item) => item.annotation.id);
  const selectedGuidance = focusOrigin.type === 'cloud_ai'
    ? {
        guidanceSource: 'ai_evidence' as const,
        evidenceIds: [focusOrigin.analysisInputId],
        label: '已明确采用完整 AI 复盘建议',
      }
    : focusOrigin.type === 'user_selection'
      ? {
          guidanceSource: 'self_directed' as const,
          evidenceIds: [],
          label: '由你明确选择',
        }
      : {
          guidanceSource: 'local_metric' as const,
          evidenceIds: focusEvidenceIds,
          label: '本地任务规则推荐',
        };
  const durableActionDisabled = busy
    || editingId !== null
    || correctionStatus === 'saving'
    || reportStatus !== 'saved'
    || savedReportId === null;

  return (
    <div className="deep-lane-page">
      <section className="deep-result-workspace" aria-label="诊断结果与冻结逐字稿">
        {localReport ? (
          <DiagnosisResultCard
            evidence={evidence}
            headingRef={resultHeading}
            onLocateEvidence={locateCloudEvidence}
            report={localReport}
            snapshot={snapshot}
            suggestedFocus={selectedFocus}
            suggestionSource={selectedGuidance.label}
          />
        ) : null}

        <section className="deep-transcript-pane">
          <header>
            <div><p className="eyebrow">Deep Lane · 最终逐字稿</p><h2>可回查、可纠正的原句证据</h2></div>
            <span><ShieldCheck size={14} />冻结快照 {snapshot.transcriptVersion} · 纠正版本 {corrections.length}</span>
          </header>
          <div className="deep-transcript-list">
            {transcript.map((segment, index) => (
              <article
                className={highlightedSegmentId === segment.segmentId ? 'is-cloud-located' : undefined}
                id={`deep-segment-${segment.segmentId}`}
                key={segment.segmentId}
                ref={(element) => {
                  if (element) segmentElements.current.set(segment.segmentId, element);
                  else segmentElements.current.delete(segment.segmentId);
                }}
                tabIndex={-1}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                {editingId === segment.segmentId ? (
                  <CorrectionEditor
                    disabled={correctionStatus === 'saving'}
                    initial={segment.currentText}
                    onCancel={() => {
                      correctionReturnFocus.current = segment.segmentId;
                      setEditingId(null);
                    }}
                    onSave={(value) => void saveCorrection(
                      segment.segmentId,
                      segment.originalText,
                      segment.currentText,
                      value,
                    )}
                  />
                ) : (
                  <div className="deep-segment-copy">
                    <p>{segment.currentText}</p>
                    {segment.currentText !== segment.originalText ? <small>已纠正 · 冻结原句仍可回查</small> : null}
                  </div>
                )}
                {editingId !== segment.segmentId ? (
                  <button
                    aria-label={`纠正第 ${index + 1} 句`}
                    disabled={correctionStatus === 'saving'}
                    onClick={() => setEditingId(segment.segmentId)}
                    ref={(element) => {
                      if (element) correctionTriggers.current.set(segment.segmentId, element);
                      else correctionTriggers.current.delete(segment.segmentId);
                    }}
                    type="button"
                  >
                    <Edit3 size={14} />
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </section>

      <aside className="deep-inspector">
        <div className="deep-next-actions">
          <span>其他诚实路径</span>
          <h2>也可以停在这里，或直接再说一遍</h2>
          <p>诊断已经可用，不必走完所有阶段；每条路径都会保存为本轮实际结果。</p>
          <div className="deep-path-options">
            {onFinishAnalysis ? (
              <button
                className="deep-path-option"
                disabled={durableActionDisabled}
                onClick={() => {
                  if (savedReportId) onFinishAnalysis(savedReportId);
                }}
                type="button"
              >
                <FileCheck2 aria-hidden="true" size={16} />
                <span><strong>保存诊断，结束本轮</strong><small>保留逐字稿、证据与优化建议</small></span>
                <ArrowRight aria-hidden="true" size={15} />
              </button>
            ) : null}
            {onStartFreeRetry ? (
              <button
                className="deep-path-option"
                disabled={durableActionDisabled}
                onClick={() => {
                  if (savedReportId) onStartFreeRetry(savedReportId);
                }}
                type="button"
              >
                <Mic2 aria-hidden="true" size={16} />
                <span><strong>不选焦点，直接复讲</strong><small>完成第二遍，但不冒充完整训练闭环</small></span>
                <ArrowRight aria-hidden="true" size={15} />
              </button>
            ) : null}
          </div>
          <small aria-live="polite">{reportStatus === 'saved' ? '诊断结果已保存在本机' : reportStatus === 'error' ? '诊断结果保存失败；逐字稿仍已冻结' : '正在保存诊断结果…'}</small>
        </div>

        <div className="deep-focus">
          <span>建议路径 · 只选择一个训练焦点</span>
          <label className="focus-selector">
            <span className="sr-only">选择训练焦点和 Drill</span>
            <select
              aria-label="选择唯一训练焦点"
              onChange={(event) => {
                selectedFocusKeyRef.current = event.target.value;
                setSelectedFocusKey(event.target.value);
                setFocusOrigin({ type: 'user_selection' });
              }}
              value={selectedFocusKey}
            >
              {focusOptions.map((option) => (
                <option key={`${option.criterionId}:${option.drillId}`} value={`${option.criterionId}:${option.drillId}`}>
                  {option.criterionLabel} · {option.drillTitle}{option.recommended ? '（本地推荐）' : ''}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" size={15} />
          </label>
          <h2>{selectedFocus.criterionLabel}</h2>
          <p>{selectedFocus.criterionDescription}</p>
          <div><CheckCircle2 size={15} /><span>{selectedGuidance.label} · 不由短 AI 提示决定</span></div>
          <div className="inline-drill">
            <span>{selectedFocus.drillTitle} · 20–60 秒</span>
            <p>{selectedFocus.drillTemplate}</p>
            <small>成功条件：{selectedFocus.successCondition}</small>
          </div>
          <button
            className="primary-button"
            disabled={durableActionDisabled}
            onClick={() => {
              if (!savedReportId) return;
              onStartDrill({
                ...selectedFocus,
                guidanceSource: selectedGuidance.guidanceSource,
                evidenceIds: selectedGuidance.evidenceIds,
              }, savedReportId);
            }}
            type="button"
          >{busy
              ? '正在保存训练焦点…'
              : correctionStatus === 'saving'
                ? '正在保存逐字稿纠正…'
                : editingId !== null
                  ? '请先保存或取消逐字稿纠正'
              : reportStatus === 'error'
                ? '需先保存本地复盘'
                : reportStatus !== 'saved'
                  ? '正在保存本地复盘…'
                  : '选择这个焦点，开始 Drill'}</button>
          <small className="deep-comparison-prerequisite">完成复讲后，你仍可选择是否查看同一口径对比。</small>
        </div>

        <details className="deep-evidence-details">
          <summary>查看全部复盘证据 · {activeEvidence.length} 条已确认 / {evidence.length} 条记录</summary>
          <div className="deep-evidence">
            {evidence.slice(0, 12).map((item) => (
              <article className={item.currentLifecycle === 'confirmed' ? '' : 'is-history'} key={item.annotation.id}>
                <b>{item.annotation.displayId}</b>
                <p>{item.annotation.evidence}</p>
                <small>{item.currentLifecycle === 'withdrawn' ? `中性历史态 · ${item.historyReason}` : `${item.currentLifecycle === 'confirmed' ? '已确认' : '暂定历史记录 · 未纳入正式复盘'} · ${item.annotation.source}`}</small>
              </article>
            ))}
            {evidence.length === 0 ? <p>本地规则没有产生问题记录；训练焦点仍按当前任务 Rubric 选择。</p> : null}
          </div>
        </details>

        <DeepCloudDiagnosisPanel
          controller={cloudDiagnosis}
          onAdoptFocus={adoptCloudFocus}
          onLocateSegment={locateCloudEvidence}
        />
        {correctionStatus === 'error' ? <p className="inline-error" role="alert">逐字稿纠正没有保存成功，请在原句旁重试。</p> : null}
        {reportStatus === 'error' ? (
          <div className="inline-error" role="alert">
            <span>本地完整复盘没有保存成功；冻结逐字稿仍在，尚未进入 Drill。</span>
            <button className="text-button" onClick={() => setReportSaveRevision((revision) => revision + 1)} type="button">
              <RefreshCw aria-hidden="true" size={13} />重试保存本地复盘
            </button>
          </div>
        ) : null}
        {error ? <p className="inline-error" role="alert">训练路径没有保存成功：{error}</p> : null}
      </aside>
    </div>
  );
}

function CorrectionEditor({
  initial,
  disabled,
  onCancel,
  onSave,
}: {
  readonly initial: string;
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="correction-editor">
      <textarea aria-label="纠正逐字稿" autoFocus disabled={disabled} onChange={(event) => setValue(event.target.value)} value={value} />
      <div><button className="text-button" disabled={disabled} onClick={onCancel} type="button">取消</button><button className="secondary-button" disabled={disabled || !value.trim()} onClick={() => onSave(value)} type="button">{disabled ? '保存中…' : '保存纠正'}</button></div>
    </div>
  );
}
