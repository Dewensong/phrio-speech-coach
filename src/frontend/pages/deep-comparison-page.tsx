import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  CloudOff,
  FileCheck2,
  GitCompareArrows,
  LoaderCircle,
  Mic2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  compareFrozenAttempts,
  createTranscriptCorrectionId,
  transcriptForDeepLane,
  type AttemptSnapshot,
  type PracticeArtifact,
  type PracticeSession,
  type TranscriptCorrection,
} from '../../shared';
import {
  getPracticeSession,
  listPracticeArtifacts,
  savePracticeArtifact,
} from '../services/desktop-api';
import {
  useCloudComparison,
  type CloudComparisonServices,
} from '../hooks/use-cloud-comparison';
import type { PracticeDraft, SelectedPracticeFocus } from '../types/ui';

interface DeepComparisonPageProps {
  readonly initial: AttemptSnapshot | null;
  readonly retry: AttemptSnapshot | null;
  readonly draft: PracticeDraft;
  readonly focus: SelectedPracticeFocus | null;
  readonly sessionId: string;
  readonly busy: boolean;
  readonly error?: string;
  readonly onSave: (comparisonArtifactId: string) => void | Promise<void>;
  readonly onFinishWithoutComparison?: () => void | Promise<void>;
  readonly onEnterComparison?: () => void;
  readonly requireExplicitEntry?: boolean;
  readonly loadArtifacts?: typeof listPracticeArtifacts;
  readonly loadSession?: typeof getPracticeSession;
  readonly persistArtifact?: typeof savePracticeArtifact;
  readonly cloudServices?: CloudComparisonServices;
  readonly now?: () => string;
}

type CorrectionLoadState = 'loading' | 'ready' | 'failed';
type SessionLoadState = 'loading' | 'ready' | 'failed';

const RESULT_LABELS = {
  improved: '改善',
  stable: '持平',
  regressed: '回退',
  insufficient_evidence: '证据不足',
} as const;

const currentIsoTime = () => new Date().toISOString();

function correctionsFrom(artifacts: readonly PracticeArtifact[]): TranscriptCorrection[] {
  return artifacts
    .filter((artifact): artifact is Extract<PracticeArtifact, { type: 'transcript_correction' }> => (
      artifact.type === 'transcript_correction'
    ))
    .map((artifact) => artifact.payload);
}

export function DeepComparisonPage({
  initial,
  retry,
  draft,
  focus,
  sessionId,
  busy,
  error,
  onSave,
  onFinishWithoutComparison,
  onEnterComparison,
  requireExplicitEntry = false,
  loadArtifacts = listPracticeArtifacts,
  loadSession = getPracticeSession,
  persistArtifact = savePracticeArtifact,
  cloudServices,
  now = currentIsoTime,
}: DeepComparisonPageProps) {
  const [artifacts, setArtifacts] = useState<readonly PracticeArtifact[]>([]);
  const [corrections, setCorrections] = useState<TranscriptCorrection[]>([]);
  const [practiceSession, setPracticeSession] = useState<PracticeSession | null>(null);
  const [sessionLoadState, setSessionLoadState] = useState<SessionLoadState>('loading');
  const [sessionLoadRevision, setSessionLoadRevision] = useState(0);
  const [correctionLoadState, setCorrectionLoadState] = useState<CorrectionLoadState>('loading');
  const [loadRevision, setLoadRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [correctionSaving, setCorrectionSaving] = useState(false);
  const [retryCorrectionEditing, setRetryCorrectionEditing] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [comparisonEntered, setComparisonEntered] = useState(!requireExplicitEntry);
  const [comparisonAt, setComparisonAt] = useState<string | null>(() => (
    requireExplicitEntry ? null : now()
  ));
  const mounted = useRef(true);
  const comparisonHeading = useRef<HTMLHeadingElement>(null);
  const comparisonFocusPending = useRef(false);
  const terminalSavePending = useRef(false);
  const correctionMutationPending = useRef(false);
  const retryCorrectionEditingRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setCorrectionLoadState('loading');
    setCorrections([]);
    void loadArtifacts(sessionId)
      .then((artifacts) => {
        if (!active) return;
        setArtifacts(artifacts);
        setCorrections(correctionsFrom(artifacts));
        setCorrectionLoadState('ready');
      })
      .catch(() => {
        if (active) setCorrectionLoadState('failed');
      });
    return () => {
      active = false;
    };
  }, [loadArtifacts, loadRevision, sessionId]);

  useEffect(() => {
    let active = true;
    setPracticeSession(null);
    setSessionLoadState('loading');
    void loadSession(sessionId)
      .then((session) => {
        if (!active) return;
        setPracticeSession(session);
        setSessionLoadState(session ? 'ready' : 'failed');
      })
      .catch(() => {
        if (!active) return;
        setPracticeSession(null);
        setSessionLoadState('failed');
      });
    return () => { active = false; };
  }, [loadSession, sessionId, sessionLoadRevision]);

  const comparison = useMemo(() => initial && retry && focus && comparisonAt ? compareFrozenAttempts({
    id: `${sessionId}-paired-comparison`,
    initial,
    retry,
    criterionId: focus.criterionId,
    comparisonDimension: focus.comparisonDimension,
    at: comparisonAt,
    corrections,
  }) : null, [comparisonAt, corrections, focus, initial, retry, sessionId]);

  useEffect(() => {
    if (!comparisonFocusPending.current || !comparisonEntered || !comparison) return;
    comparisonFocusPending.current = false;
    comparisonHeading.current?.focus({ preventScroll: true });
  }, [comparison, comparisonEntered]);

  const enterComparison = () => {
    comparisonFocusPending.current = true;
    setComparisonAt(now());
    setComparisonEntered(true);
    onEnterComparison?.();
  };

  const initialTranscript = useMemo(
    () => initial ? transcriptForDeepLane(initial, corrections) : [],
    [corrections, initial],
  );
  const retryTranscript = useMemo(
    () => retry ? transcriptForDeepLane(retry, corrections) : [],
    [corrections, retry],
  );

  const rememberArtifact = (artifact: PracticeArtifact) => {
    setArtifacts((current) => [
      ...current.filter((candidate) => candidate.id !== artifact.id),
      artifact,
    ]);
  };

  const saveRetryCorrection = async (
    segment: ReturnType<typeof transcriptForDeepLane>[number],
    correctedText: string,
  ) => {
    if (
      !retry
      || correctionLoadState !== 'ready'
      || terminalSavePending.current
      || correctionMutationPending.current
    ) {
      throw new Error('CORRECTION_MUTATION_BLOCKED');
    }
    correctionMutationPending.current = true;
    const correction: TranscriptCorrection = {
      id: createTranscriptCorrectionId(),
      snapshotId: retry.id,
      segmentId: segment.segmentId,
      originalText: segment.originalText,
      correctedText,
      createdAt: new Date().toISOString(),
    };
    setCorrectionSaving(true);
    try {
      const artifact = await persistArtifact({
        type: 'transcript_correction',
        sessionId,
        id: correction.id,
        payload: correction,
      });
      rememberArtifact(artifact);
      setCorrections((current) => [...current, correction]);
    } finally {
      correctionMutationPending.current = false;
      if (mounted.current) setCorrectionSaving(false);
    }
  };

  const save = async () => {
    if (
      !comparison
      || correctionLoadState !== 'ready'
      || retryCorrectionEditingRef.current
      || terminalSavePending.current
      || correctionMutationPending.current
    ) return;
    terminalSavePending.current = true;
    setSaving(true);
    setSaveError(undefined);
    try {
      await persistArtifact({
        type: 'attempt_comparison',
        sessionId,
        id: comparison.id,
        payload: comparison,
      });
      await onSave(comparison.id);
    } catch {
      if (mounted.current) {
        setSaveError('前后对比没有保存成功。本轮冻结快照仍在，可以重新保存。');
      }
    } finally {
      terminalSavePending.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const handleRetryCorrectionEditingChange = (editing: boolean) => {
    retryCorrectionEditingRef.current = editing;
    setRetryCorrectionEditing(editing);
  };

  if (!initial || !retry) {
    return (
      <section className="deep-lane-empty">
        <h1>比较证据尚未就绪</h1>
        <p>只有两遍冻结快照齐全后，才会执行同一 criterion 的配对比较。</p>
      </section>
    );
  }

  if (!comparisonEntered) {
    return (
      <section className="retry-completion-page" aria-labelledby="retry-completion-title">
        <div className="retry-completion-card">
          <span className="retry-completion-icon"><Mic2 aria-hidden="true" size={22} /></span>
          <span className="retry-completion-stamp" aria-hidden="true">TAKE 02 · FROZEN</span>
          <p className="eyebrow">复讲已冻结 · 由你决定下一步</p>
          <h1 id="retry-completion-title">第二遍已经保存，不必强制查看对比</h1>
          <p>初讲与复讲原句都已保留。现在可以结束本轮；如果本轮冻结了唯一焦点，也可以再查看同一口径的前后变化。</p>

          <div className="retry-completion-facts">
            <div><span>初讲</span><strong>{initial.finalSegments.length} 个 final 句段</strong></div>
            <div><span>复讲</span><strong>{retry.finalSegments.length} 个 final 句段</strong></div>
            <div><span>训练路径</span><strong>{focus ? `${focus.criterionLabel} · 已完成 Drill` : '自由复讲 · 未选择焦点'}</strong></div>
          </div>

          <div className="retry-completion-actions">
            {focus ? (
              <button className="primary-button" disabled={busy} onClick={enterComparison} type="button">
                <GitCompareArrows aria-hidden="true" size={16} />查看同一口径对比
              </button>
            ) : (
              <div className="retry-comparison-boundary" role="note">
                <GitCompareArrows aria-hidden="true" size={16} />
                <p><strong>本轮不生成改善结论</strong><span>没有冻结唯一焦点和 Drill，系统不会借用默认指标伪造“进步”。两遍原句仍会完整保留。</span></p>
              </div>
            )}
            {onFinishWithoutComparison ? (
              <button className="secondary-button" disabled={busy} onClick={() => void onFinishWithoutComparison()} type="button">
                <FileCheck2 aria-hidden="true" size={16} />{busy ? '正在保存…' : '保存复讲，结束本轮'}
              </button>
            ) : null}
          </div>
          {error ? <p className="inline-error" role="alert">{error}</p> : null}
        </div>
      </section>
    );
  }

  if (!focus || !comparison) {
    return (
      <section className="deep-lane-empty">
        <h1>唯一训练焦点尚未冻结</h1>
        <p>前后比较只使用本轮已持久化的焦点，不会回退到默认焦点代替用户选择。</p>
      </section>
    );
  }

  const resultLabel = RESULT_LABELS[comparison.result];
  const comparisonBasis = comparison.basis ?? null;
  const metricVersionsMatch = initial.metrics.algorithmVersion === retry.metrics.algorithmVersion;
  const unavailableTranscript = initialTranscript.length === 0 || retryTranscript.length === 0;

  return (
    <div className="deep-comparison-page">
      <header>
        <div>
          <p className="eyebrow">{draft.task.title} · 对比 · 同一口径</p>
          <h1 ref={comparisonHeading} tabIndex={-1}>{focus.criterionLabel}：{resultLabel}</h1>
        </div>
        <span><ShieldCheck aria-hidden="true" size={14} />paired-1 · 不生成总分</span>
      </header>

      <section className="comparison-evidence-pair" aria-label="初讲与复讲完整逐字稿">
        <ComparisonTranscriptColumn
          hintCount={initial.hints.filter((hint) => hint.lifecycle === 'provisional' || hint.lifecycle === 'superseded').length}
          label="初讲"
          transcript={initialTranscript}
        />
        <ArrowRight aria-hidden="true" size={19} />
        <ComparisonTranscriptColumn
          disabled={busy || saving}
          focusFrozen
          hintCount={retry.hints.filter((hint) => hint.lifecycle === 'provisional' || hint.lifecycle === 'superseded').length}
          label="复讲"
          onEditingChange={handleRetryCorrectionEditingChange}
          onSaveCorrection={saveRetryCorrection}
          transcript={retryTranscript}
        />
      </section>

      {correctionLoadState === 'loading' ? (
        <p className="comparison-load-state" role="status">正在核对逐字稿纠正版本…</p>
      ) : null}
      {correctionLoadState === 'failed' ? (
        <div className="comparison-load-state inline-error" role="alert">
          <span>纠正版本暂时无法读取；当前显示冻结时的原始 final 文本。</span>
          <button className="text-button" onClick={() => setLoadRevision((revision) => revision + 1)} type="button">
            <RefreshCw aria-hidden="true" size={13} />重新读取
          </button>
        </div>
      ) : null}

      <section className="comparison-rule">
        <span>本轮冻结的相同 criterion</span>
        <strong>{focus.criterionDescription}</strong>
        <p>{comparison.explanation}</p>
        <div className="comparison-metric-version">
          <span>本地指标版本</span>
          <strong>{initial.metrics.algorithmVersion}</strong>
          <em>{metricVersionsMatch ? '两遍一致' : '版本不同 · 不作趋势判断'}</em>
        </div>
        <dl aria-label="冻结焦点的同一口径依据">
          <div>
            <dt>比较维度</dt>
            <dd>{comparisonBasis?.label ?? '当前焦点没有本地可比较维度'}</dd>
          </div>
          <div>
            <dt>纳入信号</dt>
            <dd>{comparisonBasis?.signalLabel ?? '不会借用其他表达问题数量'}</dd>
          </div>
          <div>
            <dt>初讲 → 复讲</dt>
            <dd>{comparisonBasis?.comparable
              ? `${comparisonBasis.initialValue} → ${comparisonBasis.retryValue} 条问题信号`
              : '证据不足，不换算趋势'}</dd>
          </div>
          <div>
            <dt>结果</dt>
            <dd>{resultLabel}</dd>
          </div>
        </dl>
        <p className="comparison-basis-boundary">未列入“纳入信号”的 final 字数、句段数或其他问题数量不会参与本次结论。</p>
        {unavailableTranscript ? <p className="inline-error" role="status">至少一遍缺少 final 逐字稿，因此不作改善判断。</p> : null}
      </section>

      <CloudComparisonSection
        artifacts={artifacts}
        cloudServices={cloudServices}
        corrections={corrections}
        correctionsReady={correctionLoadState === 'ready' && !correctionSaving}
        focus={focus}
        initial={initial}
        metricVersionsMatch={metricVersionsMatch}
        onArtifactPersisted={rememberArtifact}
        persistArtifact={persistArtifact}
        retry={retry}
        session={practiceSession}
        sessionLoadState={sessionLoadState}
        onReloadSession={() => setSessionLoadRevision((revision) => revision + 1)}
      />

      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {saveError ? <p className="inline-error" role="alert">{saveError}</p> : null}
      {retryCorrectionEditing ? <p className="comparison-load-state" role="status">请先保存或取消复讲逐字稿纠正，再保存本轮练习。</p> : null}
      <footer>
        <button className="primary-button" disabled={busy || saving || correctionSaving || retryCorrectionEditing || correctionLoadState !== 'ready'} onClick={() => void save()} type="button">
          {busy || saving
            ? '正在保存…'
            : retryCorrectionEditing
              ? '请先保存或取消复讲纠正'
            : correctionSaving
              ? '正在保存复讲纠正…'
            : correctionLoadState === 'loading'
              ? '正在核对纠正版本…'
              : correctionLoadState === 'failed'
                ? '需先恢复纠正版本'
                : saveError
                  ? '重新保存本轮练习'
                  : '保存本轮练习'}
        </button>
      </footer>
    </div>
  );
}

interface ComparisonTranscriptColumnProps {
  readonly disabled?: boolean;
  readonly focusFrozen?: boolean;
  readonly hintCount: number;
  readonly label: '初讲' | '复讲';
  readonly transcript: ReturnType<typeof transcriptForDeepLane>;
  readonly onEditingChange?: (editing: boolean) => void;
  readonly onSaveCorrection?: (
    segment: ReturnType<typeof transcriptForDeepLane>[number],
    correctedText: string,
  ) => Promise<void>;
}

function ComparisonTranscriptColumn({
  disabled = false,
  focusFrozen = false,
  hintCount,
  label,
  transcript,
  onEditingChange,
  onSaveCorrection,
}: ComparisonTranscriptColumnProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const savePending = useRef(false);

  const closeEditor = () => {
    setEditingId(null);
    onEditingChange?.(false);
  };

  const beginEdit = (segment: ReturnType<typeof transcriptForDeepLane>[number]) => {
    if (disabled || savePending.current) return;
    setEditingId(segment.segmentId);
    setDraft(segment.currentText);
    setError(false);
    onEditingChange?.(true);
  };

  const saveCorrection = async (segment: ReturnType<typeof transcriptForDeepLane>[number]) => {
    if (disabled || savePending.current) return;
    const correctedText = draft.trim();
    if (!onSaveCorrection || !correctedText || correctedText === segment.currentText) {
      closeEditor();
      return;
    }
    savePending.current = true;
    setSaving(true);
    setError(false);
    try {
      await onSaveCorrection(segment, correctedText);
      closeEditor();
    } catch {
      setError(true);
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };

  const interactionDisabled = disabled || saving;

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
                  disabled={interactionDisabled}
                  onChange={(event) => setDraft(event.target.value)}
                  value={draft}
                />
                <button disabled={interactionDisabled} onClick={() => void saveCorrection(segment)} type="button">
                  {saving ? '保存中…' : '保存纠正'}
                </button>
                <button disabled={interactionDisabled} onClick={closeEditor} type="button">取消</button>
              </>
            ) : (
              <>
                <p>{segment.currentText}</p>
                {onSaveCorrection ? (
                  <button disabled={interactionDisabled} onClick={() => beginEdit(segment)} type="button">纠正这句</button>
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

const CLOUD_RESULT_LABELS = {
  improved: '语义证据支持改善',
  stable: '语义证据显示持平',
  regressed: '语义证据显示回退',
  insufficient_evidence: '语义证据不足',
} as const;

const CLOUD_ERROR_COPY: Record<string, string> = {
  AI_PAYLOAD_IDENTITY_CHANGED: '你修改了冻结身份、唯一焦点或同口径指标。可以删减待发送文本，但这些边界不能改写。',
  AI_NOT_CONFIGURED: '尚未配置 OpenAI API Key。本地 paired-1 结果不受影响。',
  AUTHENTICATION_FAILED: 'OpenAI API Key 未通过验证。本地 paired-1 结果不受影响。',
  CONSENT_EXPIRED: '这次逐 payload 批准已失效，请重新审核 exact JSON。',
  CONSENT_NOT_FOUND: '找不到这次逐 payload 批准，请重新审核 exact JSON。',
  CONSENT_REVOKED: '这次逐 payload 批准已撤回，请重新审核 exact JSON。',
  NETWORK_UNAVAILABLE: '当前网络不可用；冻结快照和本地结果都已保留。',
  PROVIDER_UNAVAILABLE: '云端服务暂时不可用；可以稍后重试同一已批准 payload。',
  RATE_LIMITED: '云端请求暂时受限；可以稍后重试同一已批准 payload。',
  REQUEST_TIMEOUT: '云端语义比较超时；可以稍后重试同一已批准 payload。',
  COMPARISON_FAILED: '云端语义比较没有完成；冻结快照和本地结果都已保留。',
};

const RETRYABLE_APPROVED_PAYLOAD_ERRORS = new Set([
  'NETWORK_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'REQUEST_TIMEOUT',
]);

function canonicalCloudErrorCode(code: string | null | undefined): string {
  if (!code) return 'UNKNOWN';
  return code.startsWith('PHRIO_') ? code.slice('PHRIO_'.length) : code;
}

function CloudComparisonSection({
  artifacts,
  cloudServices,
  corrections,
  correctionsReady,
  focus,
  initial,
  metricVersionsMatch,
  onArtifactPersisted,
  persistArtifact,
  retry,
  session,
  sessionLoadState,
  onReloadSession,
}: {
  readonly artifacts: readonly PracticeArtifact[];
  readonly cloudServices?: CloudComparisonServices;
  readonly corrections: readonly TranscriptCorrection[];
  readonly correctionsReady: boolean;
  readonly focus: SelectedPracticeFocus;
  readonly initial: AttemptSnapshot;
  readonly metricVersionsMatch: boolean;
  readonly onArtifactPersisted: (artifact: PracticeArtifact) => void;
  readonly persistArtifact: typeof savePracticeArtifact;
  readonly retry: AttemptSnapshot;
  readonly session: PracticeSession | null;
  readonly sessionLoadState: SessionLoadState;
  readonly onReloadSession: () => void;
}) {
  const cloud = useCloudComparison({
    session,
    initial,
    retry,
    focus,
    corrections,
    correctionsReady,
    artifacts,
    metricVersionsMatch,
    persistArtifact,
    onArtifactPersisted,
    services: cloudServices,
  });
  const actionBusy = cloud.actionState !== 'idle';
  const status = cloud.artifact?.payload.status;
  const result = cloud.artifact?.payload.result;
  const artifactErrorCode = canonicalCloudErrorCode(cloud.artifact?.payload.errorCode);
  const lastErrorCode = cloud.lastError ? canonicalCloudErrorCode(cloud.lastError) : null;
  const canRetryApprovedPayload = status === 'failed'
    && RETRYABLE_APPROVED_PAYLOAD_ERRORS.has(artifactErrorCode);
  const hasDistinctActionError = lastErrorCode !== null
    && !(status === 'failed' && lastErrorCode === artifactErrorCode);

  if (cloud.preferenceState === 'loading') {
    return (
      <section className="cloud-comparison-panel is-muted" aria-live="polite">
        <LoaderCircle className="spin" aria-hidden="true" size={16} />
        <div><strong>正在读取云端比较偏好</strong><p>本地 paired-1 结果已经可用，不必等待。</p></div>
      </section>
    );
  }

  if (cloud.preferenceState === 'disabled') {
    return (
      <section className="cloud-comparison-panel is-muted">
        <CloudOff aria-hidden="true" size={16} />
        <div><strong>可选云端语义比较未开启</strong><p>可在“设置 → AI 与数据”开启 comparison；本地配对结果和保存流程不受影响。</p></div>
      </section>
    );
  }

  if (cloud.preferenceState === 'unavailable') {
    return (
      <section className="cloud-comparison-panel is-muted">
        <CloudOff aria-hidden="true" size={16} />
        <div>
          <strong>暂时无法读取云端比较状态</strong>
          <p>不会自动发送任何内容；本地 paired-1 结果仍可保存。</p>
          <button className="text-button" onClick={cloud.retryPreferences} type="button"><RefreshCw aria-hidden="true" size={13} />重新读取</button>
        </div>
      </section>
    );
  }

  if (!cloud.canonicalPayload) {
    const reason = !metricVersionsMatch
      ? '两遍本地指标版本不同，不能在“同一口径”下发起语义比较。'
      : !correctionsReady
        ? '正在核对两遍 final 与纠正版本。'
        : sessionLoadState === 'loading'
          ? '正在读取冻结 Session。'
        : !session
          ? '冻结 Session 暂时无法读取；不会改用页面草稿代替。'
          : retry.focusVersion === null
            ? '复讲快照没有冻结焦点版本，不能发起语义比较。'
            : '冻结 Session、两遍 final 或持久化唯一焦点不一致，已停止云端发送。';
    return (
      <section className="cloud-comparison-panel is-muted" role="status">
        <CloudOff aria-hidden="true" size={16} />
        <div>
          <strong>云端语义比较暂不可用</strong>
          <p>{reason} 本地 paired-1 结果不受影响。</p>
          {sessionLoadState === 'failed' ? <button className="text-button" onClick={onReloadSession} type="button"><RefreshCw aria-hidden="true" size={13} />重新读取冻结 Session</button> : null}
        </div>
      </section>
    );
  }

  return (
    <section className="cloud-comparison-workspace" aria-label="可选云端语义比较">
      <header>
        <div>
          <span><BrainCircuit aria-hidden="true" size={15} />可选云端语义比较</span>
          <h2>本地结果已可用；云端只补充语义证据</h2>
        </div>
        <em>comparison-1 · paired-1 · 不生成总分</em>
      </header>

      {cloud.artifact ? (
        <article className={`cloud-comparison-result is-${status}`}>
          <div className="cloud-result-status">
            {status === 'complete'
              ? <CheckCircle2 aria-hidden="true" size={16} />
              : status === 'failed'
                ? <CloudOff aria-hidden="true" size={16} />
                : <LoaderCircle className={actionBusy ? 'spin' : ''} aria-hidden="true" size={16} />}
            <strong>{status === 'queued' ? '已排队' : status === 'processing' ? '处理中' : status === 'failed' ? '处理失败' : status === 'superseded' ? '历史版本' : '处理完成'}</strong>
            <span>逐 payload 批准 · {cloud.artifact.payload.updatedAt.slice(0, 19).replace('T', ' ')}</span>
          </div>
          {result ? (
            <div className="cloud-result-body">
              <h3>{CLOUD_RESULT_LABELS[result.result]}</h3>
              <p>{result.explanation}</p>
              <div className="cloud-evidence-columns">
                <EvidenceList items={result.initialEvidence} label="初讲语义证据" />
                <EvidenceList items={result.retryEvidence} label="复讲语义证据" />
              </div>
              <small>这是对同一冻结焦点的补充复核，不改变本地 paired-1 结果、训练焦点或 Drill。</small>
            </div>
          ) : null}
          {status === 'failed' ? (
            <div className="cloud-result-actions">
              <p role="alert">{CLOUD_ERROR_COPY[artifactErrorCode] ?? `云端比较失败（${artifactErrorCode}）。本地结果已保留。`}</p>
              {canRetryApprovedPayload ? (
                <button className="secondary-button" disabled={actionBusy} onClick={() => void cloud.retry()} type="button">
                  <RefreshCw aria-hidden="true" size={14} />重试同一已批准 payload
                </button>
              ) : null}
              <button className="text-button" disabled={actionBusy} onClick={cloud.startReview} type="button">重新审核 exact JSON</button>
            </div>
          ) : null}
          {(status === 'queued' || status === 'processing') && !actionBusy ? (
            <div className="cloud-result-actions">
              <p>应用上次在发送完成前关闭。冻结 payload 和批准记录仍在，可以继续。</p>
              <button className="secondary-button" onClick={() => void cloud.retry()} type="button"><RefreshCw aria-hidden="true" size={14} />继续处理</button>
            </div>
          ) : null}
          {(status === 'queued' || status === 'processing') && actionBusy ? <p className="cloud-processing-copy" role="status">正在使用已批准的 exact payload 请求固定云端服务…</p> : null}
          <details>
            <summary>查看当时批准的 exact JSON</summary>
            <pre>{JSON.stringify(cloud.artifact.payload.approvedPayload, null, 2)}</pre>
          </details>
        </article>
      ) : null}

      {(cloud.reviewing || !cloud.artifact) ? (
        <div className="cloud-payload-review">
          <div className="cloud-payload-instruction">
            <strong>发送前逐字段审核</strong>
            <p>可以直接删减文本、证据或数组项；Session、两遍 snapshot / transcript version、唯一焦点和本地指标身份不可改写。</p>
          </div>
          <label>
            <span>本次将发送的 exact JSON</span>
            <textarea
              aria-label="本次云端语义比较 exact JSON"
              disabled={actionBusy}
              onChange={(event) => cloud.setPayloadJson(event.target.value)}
              spellCheck={false}
              value={cloud.payloadJson}
            />
          </label>
          <div className="cloud-review-actions">
            <button className="secondary-button" disabled={actionBusy || !cloud.payloadJson.trim()} onClick={() => void cloud.prepare()} type="button">
              {cloud.actionState === 'preparing' ? '正在校验…' : '校验并生成批准预览'}
            </button>
          </div>
          {cloud.prepared ? (
            <div className="cloud-consent-preview">
              <div><strong>逐 payload 批准预览</strong><span>hash {cloud.prepared.payloadHash?.slice(0, 12)}…</span></div>
              <p>{cloud.prepared.retentionNotice}</p>
              <small>批准字段：{cloud.prepared.approvedFields.join(' · ')}</small>
              <details>
                <summary>核对规范化后的 exact JSON</summary>
                <pre>{cloud.prepared.previewJson}</pre>
              </details>
              <button className="primary-button" disabled={actionBusy} onClick={() => void cloud.approveAndRun()} type="button">
                {cloud.actionState === 'approving' || cloud.actionState === 'executing' ? '正在提交…' : '批准这一 payload 并发送'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {hasDistinctActionError && lastErrorCode ? (
        <p className="inline-error cloud-comparison-error" role="alert">
          {CLOUD_ERROR_COPY[lastErrorCode] ?? `云端语义比较未完成（${lastErrorCode}）。本地结果与冻结快照不受影响。`}
        </p>
      ) : null}
    </section>
  );
}

function EvidenceList({ items, label }: { readonly items: readonly string[]; readonly label: string }) {
  return (
    <div>
      <strong>{label}</strong>
      {items.length > 0 ? <ul>{items.map((item, index) => <li key={`${label}-${index}`}>{item}</li>)}</ul> : <p>没有足够的可引用证据。</p>}
    </div>
  );
}
