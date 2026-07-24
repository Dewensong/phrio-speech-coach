import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createQueuedCloudDeepDiagnosis,
  transitionCloudDeepDiagnosis,
  type AttemptSnapshot,
  type CloudDeepDiagnosisArtifact,
  type DeepDiagnosisPayload,
  type PreparedAiConsent,
  type PracticeArtifact,
  type PracticeSession,
  type TranscriptCorrection,
} from '../../shared';
import {
  approvePreparedConsent,
  buildDeepDiagnosisPayload,
  executeDeepDiagnosis,
  getCloudAiConfiguration,
  getCloudAiPreferences,
  parseEditedDeepPayload,
  prepareDeepDiagnosisConsent,
} from '../services/cloud-ai-api';
import {
  getPracticeSession,
  listPracticeArtifacts,
  savePracticeArtifact,
} from '../services/desktop-api';

export interface DeepCloudDiagnosisDependencies {
  readonly getSession?: typeof getPracticeSession;
  readonly listArtifacts?: typeof listPracticeArtifacts;
  readonly saveArtifact?: typeof savePracticeArtifact;
  readonly getConfiguration?: typeof getCloudAiConfiguration;
  readonly getPreferences?: typeof getCloudAiPreferences;
  readonly prepareConsent?: typeof prepareDeepDiagnosisConsent;
  readonly approveConsent?: typeof approvePreparedConsent;
  readonly execute?: typeof executeDeepDiagnosis;
  readonly now?: () => string;
}

export type DeepCloudAvailability = 'loading' | 'disabled' | 'unconfigured' | 'ready' | 'error';
export type DeepCloudOperation = 'preparing' | 'approving' | null;

export interface DeepCloudDiagnosisController {
  readonly availability: DeepCloudAvailability;
  readonly availabilityMessage: string;
  readonly runs: readonly CloudDeepDiagnosisArtifact[];
  readonly activeRunIds: readonly string[];
  readonly editorOpen: boolean;
  readonly payloadJson: string;
  readonly prepared: PreparedAiConsent | null;
  readonly operation: DeepCloudOperation;
  readonly validationError: string | null;
  readonly persistenceError: string | null;
  readonly revisionNotice: string | null;
  readonly openEditor: () => void;
  readonly closeEditor: () => void;
  readonly changePayloadJson: (value: string) => void;
  readonly prepare: () => Promise<void>;
  readonly approveAndExecute: () => Promise<void>;
  readonly resume: (run: CloudDeepDiagnosisArtifact) => void;
  readonly retry: () => void;
  readonly refresh: () => void;
}

const DEFAULT_NOW = () => new Date().toISOString();

function diagnosisRuns(artifacts: readonly PracticeArtifact[]): CloudDeepDiagnosisArtifact[] {
  return artifacts
    .filter((artifact): artifact is Extract<PracticeArtifact, { type: 'cloud_deep_diagnosis' }> => (
      artifact.type === 'cloud_deep_diagnosis'
    ))
    .map((artifact) => artifact.payload)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function artifactId(run: CloudDeepDiagnosisArtifact): string {
  return `cloud-deep-${run.analysisInputId}`.slice(0, 96);
}

function executionErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,119}$/.test(error.message)) {
    return error.message;
  }
  return 'DEEP_DIAGNOSIS_FAILED';
}

export function useDeepCloudDiagnosis(input: {
  readonly sessionId: string;
  readonly snapshot: AttemptSnapshot | null;
  readonly corrections: readonly TranscriptCorrection[];
  readonly dependencies?: DeepCloudDiagnosisDependencies;
}): DeepCloudDiagnosisController {
  const getSession = input.dependencies?.getSession ?? getPracticeSession;
  const loadArtifacts = input.dependencies?.listArtifacts ?? listPracticeArtifacts;
  const persistArtifact = input.dependencies?.saveArtifact ?? savePracticeArtifact;
  const loadConfiguration = input.dependencies?.getConfiguration ?? getCloudAiConfiguration;
  const loadPreferences = input.dependencies?.getPreferences ?? getCloudAiPreferences;
  const prepareConsent = input.dependencies?.prepareConsent ?? prepareDeepDiagnosisConsent;
  const approveConsent = input.dependencies?.approveConsent ?? approvePreparedConsent;
  const execute = input.dependencies?.execute ?? executeDeepDiagnosis;
  const now = input.dependencies?.now ?? DEFAULT_NOW;

  const [session, setSession] = useState<PracticeSession | null>(null);
  const [availability, setAvailability] = useState<DeepCloudAvailability>('loading');
  const [availabilityMessage, setAvailabilityMessage] = useState('正在读取完整 AI 复盘配置…');
  const [runs, setRuns] = useState<CloudDeepDiagnosisArtifact[]>([]);
  const [activeRunIds, setActiveRunIds] = useState<string[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [payloadJson, setPayloadJson] = useState('');
  const [prepared, setPrepared] = useState<PreparedAiConsent | null>(null);
  const [operation, setOperation] = useState<DeepCloudOperation>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [revisionNotice, setRevisionNotice] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [payloadGeneration, setPayloadGeneration] = useState(0);
  const retryOpen = useRef(false);
  const currentRevision = useRef('');
  const previousRevision = useRef<string | null>(null);
  const superseding = useRef(new Set<string>());
  const activeExecutions = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setAvailability('loading');
    setAvailabilityMessage('正在读取完整 AI 复盘配置…');
    void Promise.all([
      getSession(input.sessionId),
      loadArtifacts(input.sessionId),
      loadConfiguration(),
      loadPreferences(),
    ]).then(([nextSession, artifacts, configuration, preferences]) => {
      if (!active) return;
      if (!nextSession) throw new Error('PRACTICE_SESSION_NOT_FOUND');
      const snapshot = input.snapshot;
      const attempt = snapshot
        ? nextSession.attempts.find((candidate) => candidate.id === snapshot.attemptId)
        : null;
      if (
        !snapshot
        || snapshot.sessionId !== nextSession.id
        || !attempt
        || attempt.kind !== snapshot.kind
        || nextSession.taskSnapshot.id !== nextSession.taskId
        || nextSession.taskSnapshot.version !== nextSession.taskVersion
      ) {
        throw new Error('SNAPSHOT_SESSION_IDENTITY_MISMATCH');
      }
      setSession(nextSession);
      setRuns(diagnosisRuns(artifacts));
      if (!preferences.deepDiagnosisEnabled) {
        setAvailability('disabled');
        setAvailabilityMessage('完整 AI 复盘未在设置中启用；本地复盘不受影响。');
      } else if (!configuration.configured) {
        setAvailability('unconfigured');
        setAvailabilityMessage('完整 AI 复盘已启用，但 API Key 尚未配置。');
      } else {
        setAvailability('ready');
        setAvailabilityMessage('本地复盘已可用；需要时可逐 payload 预览并批准云端分析。');
      }
    }).catch(() => {
      if (!active) return;
      setAvailability('error');
      setAvailabilityMessage('完整 AI 复盘配置暂时无法读取；本地复盘仍可继续。');
    });
    return () => {
      active = false;
    };
  }, [getSession, input.sessionId, input.snapshot, loadArtifacts, loadConfiguration, loadPreferences, loadRevision]);

  const originalPayload = useMemo<DeepDiagnosisPayload | null>(() => {
    if (!session || !input.snapshot) return null;
    return buildDeepDiagnosisPayload({
      session,
      snapshot: input.snapshot,
      corrections: input.corrections,
    });
  // payloadGeneration intentionally creates a fresh analysisInputId for an explicit retry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.corrections, input.snapshot, payloadGeneration, session]);

  const revisionIdentity = originalPayload
    ? `${originalPayload.snapshotId}:${originalPayload.transcriptVersion}`
    : '';
  currentRevision.current = revisionIdentity;

  useEffect(() => {
    if (!originalPayload) return;
    if (previousRevision.current && previousRevision.current !== revisionIdentity) {
      setEditorOpen(false);
      setPrepared(null);
      setPayloadJson('');
      setValidationError(null);
      setRevisionNotice('逐字稿纠正已变化；旧云端结果转为历史态，请重新预览当前 payload。');
    }
    previousRevision.current = revisionIdentity;
    if (retryOpen.current) {
      retryOpen.current = false;
      setPayloadJson(JSON.stringify(originalPayload, null, 2));
      setPrepared(null);
      setValidationError(null);
      setRevisionNotice('已生成新的重试 payload；请检查后重新逐次批准。');
      setEditorOpen(true);
    }
  }, [originalPayload, revisionIdentity]);

  const replaceRun = useCallback((next: CloudDeepDiagnosisArtifact) => {
    if (!mounted.current) return;
    setRuns((current) => [
      next,
      ...current.filter((candidate) => candidate.analysisInputId !== next.analysisInputId),
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }, []);

  const persistRun = useCallback(async (run: CloudDeepDiagnosisArtifact) => {
    await persistArtifact({
      type: 'cloud_deep_diagnosis',
      sessionId: input.sessionId,
      id: artifactId(run),
      payload: run,
    });
    replaceRun(run);
  }, [input.sessionId, persistArtifact, replaceRun]);

  useEffect(() => {
    if (!originalPayload) return;
    for (const run of runs) {
      const id = artifactId(run);
      if (
        run.snapshotId !== originalPayload.snapshotId
        || run.transcriptVersion === originalPayload.transcriptVersion
        || run.status === 'superseded'
        || activeExecutions.current.has(run.analysisInputId)
        || superseding.current.has(id)
      ) continue;
      superseding.current.add(id);
      const superseded = transitionCloudDeepDiagnosis(run, {
        status: 'superseded',
        at: now(),
        supersededReason: 'transcript_correction_changed_payload',
      });
      void persistRun(superseded)
        .catch(() => {
          if (mounted.current) setPersistenceError('旧 AI 复盘历史态没有保存成功，请重新载入后重试。');
        })
        .finally(() => superseding.current.delete(id));
    }
  }, [now, originalPayload, persistRun, runs]);

  const runExecution = useCallback(async (
    resumable: CloudDeepDiagnosisArtifact,
    launchedRevision: string,
  ) => {
    if (
      (resumable.status !== 'queued' && resumable.status !== 'processing')
      || activeExecutions.current.has(resumable.analysisInputId)
    ) return;
    activeExecutions.current.add(resumable.analysisInputId);
    if (mounted.current) {
      setActiveRunIds((current) => current.includes(resumable.analysisInputId)
        ? current
        : [...current, resumable.analysisInputId]);
    }
    try {
      if (currentRevision.current !== launchedRevision) {
        await persistRun(transitionCloudDeepDiagnosis(resumable, {
          status: 'superseded',
          at: now(),
          supersededReason: 'transcript_correction_changed_payload',
        }));
        return;
      }
      let processing = resumable;
      if (resumable.status === 'queued') {
        processing = transitionCloudDeepDiagnosis(resumable, { status: 'processing', at: now() });
        try {
          await persistRun(processing);
        } catch {
          if (mounted.current) setPersistenceError('AI 复盘处理状态没有写入本机；云端请求未发送，可继续处理已批准 payload。');
          return;
        }
      }
      if (currentRevision.current !== launchedRevision) {
        await persistRun(transitionCloudDeepDiagnosis(processing, {
          status: 'superseded',
          at: now(),
          supersededReason: 'transcript_correction_changed_payload',
        }));
        return;
      }

      let terminal: CloudDeepDiagnosisArtifact;
      try {
        const result = await execute(processing.approvedPayload, processing.consentId);
        terminal = transitionCloudDeepDiagnosis(processing, {
          status: currentRevision.current === launchedRevision ? 'complete' : 'superseded',
          at: now(),
          result,
          supersededReason: currentRevision.current === launchedRevision
            ? null
            : 'transcript_correction_changed_payload',
        });
      } catch (error) {
        const errorCode = executionErrorCode(error);
        terminal = transitionCloudDeepDiagnosis(processing, {
          status: currentRevision.current === launchedRevision ? 'failed' : 'superseded',
          at: now(),
          errorCode: currentRevision.current === launchedRevision ? errorCode : null,
          supersededReason: currentRevision.current === launchedRevision
            ? null
            : 'transcript_correction_changed_payload',
        });
      }
      try {
        await persistRun(terminal);
      } catch {
        replaceRun(terminal);
        if (mounted.current) setPersistenceError('AI 复盘最终状态没有写入本机；结果仅在本页暂存，冻结快照和本地复盘未受影响。');
      }
    } catch {
      if (mounted.current) {
        setPersistenceError('AI 复盘历史状态没有写入本机；冻结快照和本地复盘未受影响。');
      }
    } finally {
      activeExecutions.current.delete(resumable.analysisInputId);
      if (mounted.current) {
        setActiveRunIds((current) => current.filter(
          (analysisInputId) => analysisInputId !== resumable.analysisInputId,
        ));
      }
    }
  }, [execute, now, persistRun, replaceRun]);

  const openEditor = useCallback(() => {
    if (!originalPayload || availability !== 'ready') return;
    setPayloadJson(JSON.stringify(originalPayload, null, 2));
    setPrepared(null);
    setValidationError(null);
    setRevisionNotice(null);
    setEditorOpen(true);
  }, [availability, originalPayload]);

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setPrepared(null);
    setValidationError(null);
  }, []);

  const changePayloadJson = useCallback((value: string) => {
    setPayloadJson(value);
    setPrepared(null);
    setValidationError(null);
  }, []);

  const prepare = useCallback(async () => {
    if (!originalPayload) return;
    setOperation('preparing');
    setValidationError(null);
    try {
      const edited = parseEditedDeepPayload(payloadJson, originalPayload);
      const nextPrepared = await prepareConsent(edited);
      if (!nextPrepared.payloadHash) throw new Error('AI_PAYLOAD_HASH_MISSING');
      if (mounted.current) setPrepared(nextPrepared);
    } catch (error) {
      if (!mounted.current) return;
      setPrepared(null);
      setValidationError(
        error instanceof Error && error.message === 'AI_PAYLOAD_IDENTITY_CHANGED'
          ? 'Session、快照、任务、句段锚点或版本身份不能修改；可以编辑文本并删减条目。'
          : 'JSON 不符合 deep_diagnosis payload 结构，请检查必填字段与数据类型。',
      );
    } finally {
      if (mounted.current) setOperation(null);
    }
  }, [originalPayload, payloadJson, prepareConsent]);

  const approveAndExecute = useCallback(async () => {
    if (!originalPayload || !prepared?.payloadHash) return;
    setOperation('approving');
    setValidationError(null);
    setPersistenceError(null);
    try {
      const edited = parseEditedDeepPayload(payloadJson, originalPayload);
      const consent = await approveConsent(prepared);
      if (
        consent.purpose !== 'deep_diagnosis'
        || consent.scope !== 'payload'
        || consent.sessionId !== edited.sessionId
        || consent.payloadHash !== prepared.payloadHash
      ) {
        throw new Error('AI_CONSENT_IDENTITY_MISMATCH');
      }
      const queued = createQueuedCloudDeepDiagnosis({
        payload: edited,
        payloadHash: prepared.payloadHash,
        consentId: consent.id,
        at: now(),
      });
      await persistRun(queued);
      if (mounted.current) {
        setEditorOpen(false);
        setPrepared(null);
        setRevisionNotice('已逐 payload 批准；完整 AI 复盘在后台运行，本地 Drill 可立即继续。');
      }
      void runExecution(queued, revisionIdentity);
    } catch (error) {
      if (mounted.current) {
        setValidationError(
          executionErrorCode(error) === 'DEEP_DIAGNOSIS_FAILED'
            ? '逐 payload 批准或排队没有完成，请重试。'
            : `逐 payload 批准失败：${executionErrorCode(error)}`,
        );
      }
    } finally {
      if (mounted.current) setOperation(null);
    }
  }, [approveConsent, now, originalPayload, payloadJson, persistRun, prepared, revisionIdentity, runExecution]);

  const retry = useCallback(() => {
    retryOpen.current = true;
    setPayloadGeneration((generation) => generation + 1);
  }, []);

  const resume = useCallback((run: CloudDeepDiagnosisArtifact) => {
    if (
      availability !== 'ready'
      || (run.status !== 'queued' && run.status !== 'processing')
      || activeExecutions.current.has(run.analysisInputId)
    ) return;
    setPersistenceError(null);
    setRevisionNotice('正在继续处理此前已逐 payload 批准的内容；不会新增字段或扩大用途。');
    void runExecution(run, `${run.snapshotId}:${run.transcriptVersion}`);
  }, [availability, runExecution]);

  return {
    availability,
    availabilityMessage,
    runs,
    activeRunIds,
    editorOpen,
    payloadJson,
    prepared,
    operation,
    validationError,
    persistenceError,
    revisionNotice,
    openEditor,
    closeEditor,
    changePayloadJson,
    prepare,
    approveAndExecute,
    resume,
    retry,
    refresh: () => setLoadRevision((revision) => revision + 1),
  };
}
