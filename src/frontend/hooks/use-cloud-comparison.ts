import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  createQueuedCloudSemanticComparison,
  transitionCloudSemanticComparison,
  type AppSettings,
  type AttemptSnapshot,
  type CloudSemanticComparisonArtifact,
  type PracticeArtifact,
  type PracticeSession,
  type PreparedAiConsent,
  type SemanticComparisonPayload,
  type TranscriptCorrection,
} from '../../shared';
import {
  approvePreparedConsent,
  buildSemanticComparisonPayload,
  executeSemanticComparison,
  getCloudAiPreferences,
  parseEditedComparisonPayload,
  prepareComparisonConsent,
} from '../services/cloud-ai-api';
import type { SelectedPracticeFocus } from '../types/ui';

type PreferenceState = 'loading' | 'disabled' | 'enabled' | 'unavailable';
type ActionState = 'idle' | 'preparing' | 'approving' | 'executing';

interface OperationToken {
  readonly id: number;
  readonly contextKey: string;
}

export interface CloudComparisonServices {
  readonly getPreferences: () => Promise<AppSettings['cloudAi']>;
  readonly prepareConsent: typeof prepareComparisonConsent;
  readonly approveConsent: typeof approvePreparedConsent;
  readonly executeComparison: typeof executeSemanticComparison;
}

const DEFAULT_SERVICES: CloudComparisonServices = {
  getPreferences: getCloudAiPreferences,
  prepareConsent: prepareComparisonConsent,
  approveConsent: approvePreparedConsent,
  executeComparison: executeSemanticComparison,
};

interface UseCloudComparisonInput {
  readonly session: PracticeSession | null;
  readonly initial: AttemptSnapshot;
  readonly retry: AttemptSnapshot;
  readonly focus: SelectedPracticeFocus;
  readonly corrections: readonly TranscriptCorrection[];
  readonly correctionsReady: boolean;
  readonly artifacts: readonly PracticeArtifact[];
  readonly metricVersionsMatch: boolean;
  readonly persistArtifact: (artifact: PracticeArtifact) => Promise<PracticeArtifact>;
  readonly onArtifactPersisted: (artifact: PracticeArtifact) => void;
  readonly services?: CloudComparisonServices;
}

function relevantCorrectionCount(
  corrections: readonly TranscriptCorrection[],
  snapshotId: string,
): number {
  return corrections.filter((correction) => correction.snapshotId === snapshotId).length;
}

function newestArtifact(
  artifacts: readonly PracticeArtifact[],
  input: Pick<UseCloudComparisonInput, 'initial' | 'retry' | 'focus' | 'corrections'>,
): Extract<PracticeArtifact, { type: 'cloud_semantic_comparison' }> | null {
  const initialTranscriptVersion = input.initial.transcriptVersion
    + relevantCorrectionCount(input.corrections, input.initial.id);
  const retryTranscriptVersion = input.retry.transcriptVersion
    + relevantCorrectionCount(input.corrections, input.retry.id);
  return artifacts
    .map((artifact, index) => ({ artifact, index }))
    .filter((entry): entry is {
      artifact: Extract<PracticeArtifact, { type: 'cloud_semantic_comparison' }>;
      index: number;
    } => (
      entry.artifact.type === 'cloud_semantic_comparison'
      && entry.artifact.payload.status !== 'superseded'
      && entry.artifact.payload.initialSnapshotId === input.initial.id
      && entry.artifact.payload.retrySnapshotId === input.retry.id
      && entry.artifact.payload.initialTranscriptVersion === initialTranscriptVersion
      && entry.artifact.payload.retryTranscriptVersion === retryTranscriptVersion
      && entry.artifact.payload.focusVersion === input.retry.focusVersion
      && entry.artifact.payload.criterionId === input.focus.criterionId
      && entry.artifact.payload.drillId === input.focus.drillId
    ))
    .sort((left, right) => (
      right.artifact.payload.updatedAt.localeCompare(left.artifact.payload.updatedAt)
      || right.index - left.index
    ))[0]?.artifact ?? null;
}

function artifactMatchesPayload(
  artifact: CloudSemanticComparisonArtifact,
  payload: SemanticComparisonPayload,
): boolean {
  return artifact.analysisInputId === payload.analysisInputId
    && artifact.initialSnapshotId === payload.initial.snapshotId
    && artifact.initialTranscriptVersion === payload.initial.transcriptVersion
    && artifact.retrySnapshotId === payload.retry.snapshotId
    && artifact.retryTranscriptVersion === payload.retry.transcriptVersion
    && artifact.focusVersion === payload.focus.version
    && artifact.criterionId === payload.focus.criterionId
    && artifact.drillId === payload.focus.drillId;
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'COMPARISON_FAILED';
  const code = error.message.match(/PHRIO_[A-Z0-9_]+/)?.[0]
    ?? error.message.match(/[A-Z][A-Z0-9_]{4,}/)?.[0]
    ?? 'COMPARISON_FAILED';
  return code.startsWith('PHRIO_') ? code.slice('PHRIO_'.length) : code;
}

function nextAnalysisInputId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `comparison-${Date.now()}`;
}

export function useCloudComparison({
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
  services = DEFAULT_SERVICES,
}: UseCloudComparisonInput) {
  const [preferenceState, setPreferenceState] = useState<PreferenceState>('loading');
  const [preferenceRevision, setPreferenceRevision] = useState(0);
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [payloadJson, setPayloadJsonState] = useState('');
  const [prepared, setPrepared] = useState<PreparedAiConsent | null>(null);
  const [preparedPayload, setPreparedPayload] = useState<SemanticComparisonPayload | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const analysisIds = useRef(new Map<string, string>());
  const operationSequence = useRef(0);
  const activeOperation = useRef<OperationToken | null>(null);
  const activeExecutions = useRef(new Set<string>());
  const supersedingArtifacts = useRef(new Set<string>());
  const currentOperationContext = useRef('');
  const appliedOperationContext = useRef('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setPreferenceState('loading');
    void services.getPreferences()
      .then((preferences) => {
        if (active) setPreferenceState(preferences.comparisonEnabled ? 'enabled' : 'disabled');
      })
      .catch(() => {
        if (active) setPreferenceState('unavailable');
      });
    return () => { active = false; };
  }, [preferenceRevision, services]);

  const artifact = useMemo(
    () => newestArtifact(artifacts, { initial, retry, focus, corrections }),
    [artifacts, corrections, focus, initial, retry],
  );

  const inputSignature = useMemo(() => JSON.stringify({
    sessionId: session?.id ?? null,
    initialSnapshotId: initial.id,
    initialTranscriptVersion: initial.transcriptVersion,
    retrySnapshotId: retry.id,
    retryTranscriptVersion: retry.transcriptVersion,
    focusVersion: retry.focusVersion,
    criterionId: focus.criterionId,
    drillId: focus.drillId,
    correctionVersions: corrections.map((correction) => [
      correction.id,
      correction.snapshotId,
      correction.segmentId,
      correction.originalText,
      correction.correctedText,
      correction.createdAt,
    ]),
  }), [corrections, focus.criterionId, focus.drillId, initial.id, initial.transcriptVersion, retry.focusVersion, retry.id, retry.transcriptVersion, session?.id]);

  const canonicalPayload = useMemo(() => {
    if (
      preferenceState !== 'enabled'
      || !session
      || !correctionsReady
      || !metricVersionsMatch
      || initial.finalSegments.length === 0
      || retry.finalSegments.length === 0
      || retry.focusVersion === null
    ) return null;
    let analysisInputId = artifact?.payload.analysisInputId ?? analysisIds.current.get(inputSignature);
    if (!analysisInputId) {
      analysisInputId = nextAnalysisInputId();
      analysisIds.current.set(inputSignature, analysisInputId);
    }
    try {
      return buildSemanticComparisonPayload({
        session,
        initial,
        retry,
        criterionId: focus.criterionId,
        label: focus.criterionLabel,
        drillId: focus.drillId,
        corrections,
        analysisInputId,
      });
    } catch {
      return null;
    }
  }, [artifact?.payload.analysisInputId, corrections, correctionsReady, focus.criterionId, focus.criterionLabel, focus.drillId, initial, inputSignature, metricVersionsMatch, preferenceState, retry, session]);

  const operationContextKey = canonicalPayload
    ? `${inputSignature}:${canonicalPayload.analysisInputId}`
    : `${inputSignature}:unavailable`;
  useLayoutEffect(() => {
    currentOperationContext.current = operationContextKey;
    if (appliedOperationContext.current !== operationContextKey) {
      appliedOperationContext.current = operationContextKey;
      activeOperation.current = null;
      setActionState('idle');
    }
    if (!canonicalPayload) {
      setPayloadJsonState('');
      setPrepared(null);
      setPreparedPayload(null);
      return;
    }
    setPayloadJsonState(JSON.stringify(artifact?.payload.approvedPayload ?? canonicalPayload, null, 2));
    setPrepared(null);
    setPreparedPayload(null);
    setReviewing(!artifact);
    setLastError(null);
  }, [artifact?.id, canonicalPayload, operationContextKey]);

  const remember = useCallback(async (
    id: string,
    payload: CloudSemanticComparisonArtifact,
  ): Promise<CloudSemanticComparisonArtifact> => {
    const saved = await persistArtifact({
      type: 'cloud_semantic_comparison',
      sessionId: payload.approvedPayload.sessionId,
      id,
      payload,
    });
    if (mounted.current) onArtifactPersisted(saved);
    if (saved.type !== 'cloud_semantic_comparison') throw new Error('PHRIO_COMPARISON_PERSISTENCE_INVALID');
    return saved.payload;
  }, [onArtifactPersisted, persistArtifact]);

  const isCurrentOperation = (operation: OperationToken): boolean => (
    mounted.current
    && currentOperationContext.current === operation.contextKey
    && activeOperation.current?.id === operation.id
  );

  const beginOperation = (nextState: Exclude<ActionState, 'idle'>): OperationToken | null => {
    if (
      activeOperation.current !== null
      || currentOperationContext.current !== operationContextKey
    ) return null;
    const operation = {
      id: ++operationSequence.current,
      contextKey: operationContextKey,
    };
    activeOperation.current = operation;
    setActionState(nextState);
    return operation;
  };

  const finishOperation = (operation: OperationToken): void => {
    if (!isCurrentOperation(operation)) return;
    activeOperation.current = null;
    setActionState('idle');
  };

  useEffect(() => {
    if (!canonicalPayload) return;
    for (const candidate of artifacts) {
      if (
        candidate.type !== 'cloud_semantic_comparison'
        || candidate.sessionId !== canonicalPayload.sessionId
        || candidate.payload.status === 'superseded'
        || artifactMatchesPayload(candidate.payload, canonicalPayload)
        || activeExecutions.current.has(candidate.id)
        || supersedingArtifacts.current.has(candidate.id)
      ) continue;
      supersedingArtifacts.current.add(candidate.id);
      const superseded = transitionCloudSemanticComparison(candidate.payload, {
        status: 'superseded',
        at: new Date().toISOString(),
        supersededReason: 'comparison_payload_changed',
      });
      void remember(candidate.id, superseded)
        .catch(() => {
          if (mounted.current && currentOperationContext.current === operationContextKey) {
            setLastError('COMPARISON_SUPERSEDE_PERSISTENCE_FAILED');
          }
        })
        .finally(() => supersedingArtifacts.current.delete(candidate.id));
    }
  }, [artifacts, canonicalPayload, operationContextKey, remember]);

  const runApprovedArtifact = async (
    id: string,
    queuedOrFailed: CloudSemanticComparisonArtifact,
    launchedContext: string,
    existingOperation?: OperationToken,
  ) => {
    const operation = existingOperation ?? beginOperation('executing');
    if (!operation) return;
    if (activeExecutions.current.has(id)) {
      finishOperation(operation);
      return;
    }
    activeExecutions.current.add(id);
    let current = queuedOrFailed;
    if (isCurrentOperation(operation)) {
      setActionState('executing');
      setLastError(null);
    }
    try {
      if (currentOperationContext.current !== launchedContext) {
        await remember(id, transitionCloudSemanticComparison(current, {
          status: 'superseded',
          at: new Date().toISOString(),
          supersededReason: 'comparison_payload_changed',
        }));
        return;
      }
      if (current.status !== 'processing') {
        current = await remember(id, transitionCloudSemanticComparison(current, {
          status: 'processing',
          at: new Date().toISOString(),
          result: null,
        }));
      }
      if (currentOperationContext.current !== launchedContext) {
        await remember(id, transitionCloudSemanticComparison(current, {
          status: 'superseded',
          at: new Date().toISOString(),
          supersededReason: 'comparison_payload_changed',
        }));
        return;
      }
      const result = await services.executeComparison(current.approvedPayload, current.consentId);
      const stillCurrent = currentOperationContext.current === launchedContext;
      current = await remember(id, transitionCloudSemanticComparison(current, {
        status: stillCurrent ? 'complete' : 'superseded',
        at: new Date().toISOString(),
        result,
        supersededReason: stillCurrent ? null : 'comparison_payload_changed',
      }));
      if (current.status === 'complete' && currentOperationContext.current !== launchedContext) {
        current = await remember(id, transitionCloudSemanticComparison(current, {
          status: 'superseded',
          at: new Date().toISOString(),
          supersededReason: 'comparison_payload_changed',
        }));
      }
      if (current.status === 'complete' && isCurrentOperation(operation)) setReviewing(false);
    } catch (cause) {
      const code = errorCode(cause);
      let failurePersisted = false;
      try {
        const stillCurrent = currentOperationContext.current === launchedContext;
        current = await remember(id, transitionCloudSemanticComparison(current, {
          status: stillCurrent ? 'failed' : 'superseded',
          at: new Date().toISOString(),
          result: null,
          errorCode: stillCurrent ? code : null,
          supersededReason: stillCurrent ? null : 'comparison_payload_changed',
        }));
        if (current.status === 'failed' && currentOperationContext.current !== launchedContext) {
          current = await remember(id, transitionCloudSemanticComparison(current, {
            status: 'superseded',
            at: new Date().toISOString(),
            supersededReason: 'comparison_payload_changed',
          }));
        }
        failurePersisted = true;
      } catch {
        // The local result and frozen snapshots remain usable when lifecycle persistence also fails.
      }
      if (isCurrentOperation(operation)) setLastError(failurePersisted ? null : code);
    } finally {
      activeExecutions.current.delete(id);
      finishOperation(operation);
    }
  };

  const setPayloadJson = (value: string) => {
    setPayloadJsonState(value);
    setPrepared(null);
    setPreparedPayload(null);
    setLastError(null);
  };

  const prepare = async () => {
    if (!canonicalPayload) return;
    const operation = beginOperation('preparing');
    if (!operation) return;
    setLastError(null);
    try {
      const parsed = parseEditedComparisonPayload(payloadJson, canonicalPayload);
      const nextPrepared = await services.prepareConsent(parsed);
      if (nextPrepared.purpose !== 'comparison' || !nextPrepared.payloadHash) {
        throw new Error('PHRIO_COMPARISON_CONSENT_INVALID');
      }
      if (isCurrentOperation(operation)) {
        setPrepared(nextPrepared);
        setPreparedPayload(parsed);
      }
    } catch (cause) {
      if (isCurrentOperation(operation)) setLastError(errorCode(cause));
    } finally {
      finishOperation(operation);
    }
  };

  const approveAndRun = async () => {
    if (!prepared || !preparedPayload) return;
    const operation = beginOperation('approving');
    if (!operation) return;
    const launchedContext = operation.contextKey;
    const approvedPreview = prepared;
    const approvedPayload = preparedPayload;
    setLastError(null);
    try {
      const consent = await services.approveConsent(approvedPreview);
      const queued = createQueuedCloudSemanticComparison({
        payload: approvedPayload,
        payloadHash: approvedPreview.payloadHash!,
        consentId: consent.id,
        at: new Date().toISOString(),
      });
      const id = `${approvedPayload.analysisInputId}-${consent.id}`.slice(0, 96);
      const persisted = await remember(id, queued);
      if (isCurrentOperation(operation)) {
        setPrepared(null);
        setPreparedPayload(null);
      }
      await runApprovedArtifact(id, persisted, launchedContext, operation);
    } catch (cause) {
      if (isCurrentOperation(operation)) {
        setLastError(errorCode(cause));
      }
      finishOperation(operation);
    }
  };

  const retryCloud = async () => {
    if (
      !artifact
      || artifact.payload.status === 'complete'
      || artifact.payload.status === 'superseded'
    ) return;
    await runApprovedArtifact(artifact.id, artifact.payload, operationContextKey);
  };

  const startReview = () => {
    if (!canonicalPayload || activeOperation.current !== null) return;
    setPayloadJsonState(JSON.stringify(artifact?.payload.approvedPayload ?? canonicalPayload, null, 2));
    setPrepared(null);
    setPreparedPayload(null);
    setReviewing(true);
    setLastError(null);
  };

  return {
    preferenceState,
    actionState,
    canonicalPayload,
    payloadJson,
    prepared,
    artifact,
    reviewing,
    lastError,
    setPayloadJson,
    prepare,
    approveAndRun,
    retry: retryCloud,
    retryPreferences: () => setPreferenceRevision((revision) => revision + 1),
    startReview,
  };
}
