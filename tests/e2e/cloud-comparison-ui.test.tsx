import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APPROVED_AI_PROVIDER,
  P1_MODE_PACKS,
  PracticeSessionSchema,
  createPracticeSession,
  createQueuedCloudSemanticComparison,
  listPracticeFocusOptions,
  transitionCloudSemanticComparison,
  type AttemptSnapshot,
  type CloudAiConsent,
  type PracticeArtifact,
  type PracticeSession,
  type PreparedAiConsent,
  type SemanticComparisonPayload,
  type SemanticComparisonResponse,
  type TranscriptCorrection,
} from '../../src/shared';
import { DeepComparisonPage } from '../../src/frontend/pages/deep-comparison-page';
import { PracticeRecordDetailPage } from '../../src/frontend/pages/practice-record-detail-page';
import { buildSemanticComparisonPayload } from '../../src/frontend/services/cloud-ai-api';
import {
  useCloudComparison,
  type CloudComparisonServices,
} from '../../src/frontend/hooks/use-cloud-comparison';
import type { PracticeDraft } from '../../src/frontend/types/ui';

const at = '2026-07-18T06:30:00.000Z';

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function snapshot(kind: 'initial' | 'retry'): AttemptSnapshot {
  return {
    schemaVersion: 1,
    id: `cloud-ui-snapshot-${kind}`,
    sessionId: 'cloud-ui-session',
    attemptId: `cloud-ui-frozen-attempt-${kind}`,
    generation: 1,
    kind,
    frozenAt: at,
    audioWatermark: 9_000,
    transcriptVersion: 1,
    finalSegments: [{
      id: `cloud-ui-segment-${kind}`,
      attemptId: `cloud-ui-frozen-attempt-${kind}`,
      sequence: 0,
      revision: 1,
      text: kind === 'initial' ? '我觉得可能要谨慎使用。' : '我的主张是谨慎使用，因为用户需要保留控制权。',
      startMs: 0,
      endMs: 4_000,
      confidence: null,
      isFinal: true,
      emittedAt: at,
      finalizedAt: at,
      modelVersion: 'test-1',
    }],
    annotations: kind === 'initial' ? [{
      id: 'cloud-ui-task-gap-1',
      displayId: 'O1',
      segmentId: 'cloud-ui-segment-initial',
      type: 'task_gap',
      sourceSpan: null,
      evidence: '冻结任务要求尚未覆盖依据与主张之间的关系。',
      suggestion: '明确解释依据为什么支持主张。',
      source: 'local_metric',
      lifecycle: 'confirmed',
      algorithmVersion: 'local-rules-1',
      createdAt: at,
      updatedAt: at,
      withdrawnReason: null,
    }] : [],
    hints: [],
    focusVersion: kind === 'retry' ? 1 : null,
    metrics: {
      finalCharacters: kind === 'initial' ? 12 : 23,
      finalSegments: 1,
      fillers: 0,
      hedges: kind === 'initial' ? 1 : 0,
      vagueWords: 0,
      repetitions: 0,
      selfCorrections: 0,
      algorithmVersion: 'local-rules-1',
    },
  };
}

function fixture() {
  const pack = P1_MODE_PACKS.find((candidate) => candidate.id === 'argument-rebuttal')!;
  const task = pack.tasks.find((candidate) => candidate.id === 'ai-assistant-decisions')!;
  const option = listPracticeFocusOptions(pack.id, task.id)
    .find((candidate) => candidate.criterionId === 'claim-evidence-bridge')!;
  const focus = { ...option, guidanceSource: 'self_directed' as const, evidenceIds: [] };
  const draft: PracticeDraft = {
    mode: pack.id,
    task: {
      id: task.id,
      developmentFixture: task.developmentFixture,
      title: task.prompt,
      hint: task.description,
      mode: task.modeId,
      modeLabel: pack.name,
      durationSeconds: task.recommendedDurationSeconds,
      audience: task.context.audience,
      goal: task.context.objective,
      successConditions: task.successConditions,
    },
    audience: task.context.audience,
    goal: task.context.objective,
    durationSeconds: task.recommendedDurationSeconds,
  };
  const base = createPracticeSession({ id: 'cloud-ui-session', modeVersion: pack.version, task, now: at });
  const session = PracticeSessionSchema.parse({
    ...base,
    status: 'comparison',
    guidanceSource: 'self_directed',
    focus: {
      criterionId: focus.criterionId,
      drillId: focus.drillId,
      label: focus.criterionLabel,
      guidanceSource: 'self_directed',
      evidenceIds: [],
      selectedAt: at,
    },
    drillCompletedAt: at,
    attempts: (['initial', 'retry'] as const).map((kind) => ({
      id: `cloud-ui-stored-attempt-${kind}`,
      sessionId: base.id,
      kind,
      status: 'confirmed' as const,
      audioRef: `audio/${kind}.webm`,
      mimeType: 'audio/webm',
      durationMs: 9_000,
      byteLength: 1_024,
      createdAt: at,
      updatedAt: at,
      confirmedAt: at,
    })),
  });
  return { draft, focus, session, initial: snapshot('initial'), retry: snapshot('retry') };
}

const cloudResult: SemanticComparisonResponse = {
  result: 'improved',
  explanation: '复讲把主张、依据和论证桥连接得更明确。',
  initialEvidence: ['初讲原句“我觉得可能要谨慎使用”仍缺少论证桥。'],
  retryEvidence: ['复讲原句“我的主张是谨慎使用，因为用户需要保留控制权”补上了依据。'],
};

function prepared(payload: SemanticComparisonPayload): PreparedAiConsent {
  return {
    preparationId: 'comparison-preparation-1',
    purpose: 'comparison',
    scope: 'payload',
    provider: APPROVED_AI_PROVIDER.id,
    model: APPROVED_AI_PROVIDER.model,
    endpoint: APPROVED_AI_PROVIDER.endpoint,
    payloadHash: 'a'.repeat(64),
    policyHash: 'b'.repeat(64),
    schemaVersion: payload.schemaVersion,
    promptVersion: APPROVED_AI_PROVIDER.promptVersion,
    approvedFields: ['task', 'focus', 'initial.finalSegments', 'retry.finalSegments', 'metrics'],
    previewJson: JSON.stringify(payload, null, 2),
    retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
    preparedAt: at,
  };
}

function consent(payload: SemanticComparisonPayload): CloudAiConsent {
  return {
    id: 'comparison-consent-1',
    purpose: 'comparison',
    scope: 'payload',
    sessionId: payload.sessionId,
    provider: APPROVED_AI_PROVIDER.id,
    model: APPROVED_AI_PROVIDER.model,
    endpoint: APPROVED_AI_PROVIDER.endpoint,
    payloadHash: 'a'.repeat(64),
    policyHash: 'b'.repeat(64),
    schemaVersion: payload.schemaVersion,
    promptVersion: APPROVED_AI_PROVIDER.promptVersion,
    approvedFields: ['task', 'focus', 'initial.finalSegments', 'retry.finalSegments', 'metrics'],
    approvedAt: at,
    expiresAt: null,
    revokedAt: null,
  };
}

function services(execute: (payload: SemanticComparisonPayload) => Promise<SemanticComparisonResponse>) {
  const prepareConsent = vi.fn(async (payload: SemanticComparisonPayload) => prepared(payload));
  const approveConsent = vi.fn(async (input: PreparedAiConsent) => consent(JSON.parse(input.previewJson) as SemanticComparisonPayload));
  const executeComparison = vi.fn(execute);
  const value: CloudComparisonServices = {
    getPreferences: async () => ({
      liveHintEnabled: false,
      deepDiagnosisEnabled: false,
      comparisonEnabled: true,
    }),
    prepareConsent,
    approveConsent,
    executeComparison,
  };
  return { value, prepareConsent, approveConsent, executeComparison };
}

function initialCorrection(data: ReturnType<typeof fixture>): TranscriptCorrection {
  return {
    id: 'cloud-ui-correction-initial',
    snapshotId: data.initial.id,
    segmentId: data.initial.finalSegments[0]!.id,
    originalText: data.initial.finalSegments[0]!.text,
    correctedText: '我的主张是谨慎使用。',
    createdAt: '2026-07-18T06:31:00.000Z',
  };
}

function renderPage(input: {
  readonly initialArtifacts?: readonly PracticeArtifact[];
  readonly persistArtifact?: (artifact: PracticeArtifact) => Promise<PracticeArtifact>;
  readonly cloudServices: CloudComparisonServices;
  readonly loadSession?: () => Promise<PracticeSession | null>;
}) {
  const data = fixture();
  const persistArtifact = input.persistArtifact ?? (async (artifact: PracticeArtifact) => artifact);
  render(
    <DeepComparisonPage
      busy={false}
      cloudServices={input.cloudServices}
      draft={data.draft}
      focus={data.focus}
      initial={data.initial}
      loadArtifacts={async () => input.initialArtifacts ?? []}
      loadSession={input.loadSession ?? (async () => data.session)}
      onSave={vi.fn()}
      persistArtifact={persistArtifact}
      retry={data.retry}
      sessionId={data.session.id}
    />,
  );
  return data;
}

describe('optional cloud semantic comparison UI', () => {
  it('appends a retry correction and rebuilds comparison inputs from the latest version', async () => {
    const cloud = services(async () => cloudResult);
    const persisted: PracticeArtifact[] = [];
    const data = renderPage({
      cloudServices: cloud.value,
      persistArtifact: async (artifact) => {
        persisted.push(artifact);
        return artifact;
      },
    });

    await screen.findByLabelText('本次云端语义比较 exact JSON');
    fireEvent.click(screen.getByRole('button', { name: '纠正这句' }));
    fireEvent.change(screen.getByLabelText('复讲逐字稿纠正'), {
      target: { value: '我的主张是谨慎使用，因为用户必须保留控制权。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存纠正' }));

    await waitFor(() => expect(persisted.some((artifact) => (
      artifact.type === 'transcript_correction'
      && artifact.payload.snapshotId === data.retry.id
      && artifact.payload.originalText === data.retry.finalSegments[0]!.text
      && artifact.payload.correctedText.includes('必须保留控制权')
    ))).toBe(true));
    await waitFor(() => {
      const payload = JSON.parse(
        (screen.getByLabelText('本次云端语义比较 exact JSON') as HTMLTextAreaElement).value,
      ) as SemanticComparisonPayload;
      expect(payload.retry.transcriptVersion).toBe(2);
      expect(payload.retry.finalSegments[0]?.text).toContain('必须保留控制权');
    });
  });

  it('keeps local paired-1 immediate, permits redaction, then persists queued/processing/complete', async () => {
    const cloud = services(async () => cloudResult);
    const persisted: PracticeArtifact[] = [];
    const data = renderPage({
      cloudServices: cloud.value,
      persistArtifact: async (artifact) => {
        persisted.push(artifact);
        return artifact;
      },
    });

    expect(screen.getByRole('heading', { name: /论证桥完整：改善/ })).toBeInTheDocument();
    const editor = await screen.findByLabelText('本次云端语义比较 exact JSON');
    const edited = JSON.parse((editor as HTMLTextAreaElement).value) as SemanticComparisonPayload;
    edited.task.sourceMaterial = '';
    fireEvent.change(editor, { target: { value: JSON.stringify(edited, null, 2) } });
    fireEvent.click(screen.getByRole('button', { name: '校验并生成批准预览' }));

    expect(await screen.findByText('逐 payload 批准预览')).toBeInTheDocument();
    expect(cloud.prepareConsent).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ sourceMaterial: '' }),
    }));
    fireEvent.click(screen.getByRole('button', { name: '批准这一 payload 并发送' }));

    expect(await screen.findByRole('heading', { name: '语义证据支持改善' })).toBeInTheDocument();
    expect(screen.getByText(cloudResult.explanation)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /论证桥完整：改善/ })).toBeInTheDocument();
    expect(persisted
      .filter((artifact) => artifact.type === 'cloud_semantic_comparison')
      .map((artifact) => artifact.payload.status)).toEqual(['queued', 'processing', 'complete']);
    expect(cloud.executeComparison).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: data.session.id,
        focus: expect.objectContaining({ criterionId: data.focus.criterionId, drillId: data.focus.drillId }),
        initial: expect.objectContaining({ snapshotId: data.initial.id }),
        retry: expect.objectContaining({ snapshotId: data.retry.id }),
      }),
      'comparison-consent-1',
    );
  });

  it('drops a late consent preview after the comparison input changes', async () => {
    const data = fixture();
    const pendingPreparation = deferred<PreparedAiConsent>();
    let preparedFrom: SemanticComparisonPayload | null = null;
    const cloud = services(async () => cloudResult);
    const prepareConsent = vi.fn((payload: SemanticComparisonPayload) => {
      preparedFrom = payload;
      return pendingPreparation.promise;
    });
    const cloudServices = { ...cloud.value, prepareConsent };
    const onArtifactPersisted = vi.fn();
    const persistArtifact = vi.fn(async (artifact: PracticeArtifact) => artifact);
    const { result, rerender } = renderHook(
      ({ corrections }: { corrections: readonly TranscriptCorrection[] }) => useCloudComparison({
        session: data.session,
        initial: data.initial,
        retry: data.retry,
        focus: data.focus,
        corrections,
        correctionsReady: true,
        artifacts: [],
        metricVersionsMatch: true,
        persistArtifact,
        onArtifactPersisted,
        services: cloudServices,
      }),
      { initialProps: { corrections: [] as readonly TranscriptCorrection[] } },
    );

    await waitFor(() => expect(result.current.canonicalPayload).not.toBeNull());
    let firstPrepare!: Promise<void>;
    act(() => {
      firstPrepare = result.current.prepare();
      void result.current.prepare();
    });
    expect(prepareConsent).toHaveBeenCalledOnce();

    rerender({ corrections: [initialCorrection(data)] });
    await waitFor(() => expect(result.current.canonicalPayload?.initial.finalSegments[0]?.text).toBe('我的主张是谨慎使用。'));
    await act(async () => {
      pendingPreparation.resolve(prepared(preparedFrom!));
      await firstPrepare;
    });

    expect(result.current.prepared).toBeNull();
    expect(result.current.actionState).toBe('idle');
  });

  it('runs one approval for a double click and persists a late provider result as superseded', async () => {
    const data = fixture();
    const providerResult = deferred<SemanticComparisonResponse>();
    const cloud = services(() => providerResult.promise);
    const persisted: PracticeArtifact[] = [];
    const onArtifactPersisted = vi.fn();
    const persistArtifact = vi.fn(async (artifact: PracticeArtifact) => {
      persisted.push(artifact);
      return artifact;
    });
    const { result, rerender } = renderHook(
      ({ corrections }: { corrections: readonly TranscriptCorrection[] }) => useCloudComparison({
        session: data.session,
        initial: data.initial,
        retry: data.retry,
        focus: data.focus,
        corrections,
        correctionsReady: true,
        artifacts: [],
        metricVersionsMatch: true,
        persistArtifact,
        onArtifactPersisted,
        services: cloud.value,
      }),
      { initialProps: { corrections: [] as readonly TranscriptCorrection[] } },
    );

    await waitFor(() => expect(result.current.canonicalPayload).not.toBeNull());
    await act(async () => result.current.prepare());
    expect(result.current.prepared).not.toBeNull();

    let firstApproval!: Promise<void>;
    act(() => {
      firstApproval = result.current.approveAndRun();
      void result.current.approveAndRun();
    });
    await waitFor(() => expect(cloud.executeComparison).toHaveBeenCalledOnce());
    expect(cloud.approveConsent).toHaveBeenCalledOnce();

    rerender({ corrections: [initialCorrection(data)] });
    await waitFor(() => expect(result.current.canonicalPayload?.initial.finalSegments[0]?.text).toBe('我的主张是谨慎使用。'));
    await act(async () => {
      providerResult.resolve(cloudResult);
      await firstApproval;
    });

    expect(persisted
      .filter((artifact) => artifact.type === 'cloud_semantic_comparison')
      .map((artifact) => artifact.payload.status)).toEqual([
        'queued', 'processing', 'superseded',
      ]);
    expect(result.current.artifact).toBeNull();
    expect(result.current.actionState).toBe('idle');
  });

  it('supersedes a completion when the input changes while the terminal write is pending', async () => {
    const data = fixture();
    const cloud = services(async () => cloudResult);
    const completeWrite = deferred<PracticeArtifact>();
    const persisted: PracticeArtifact[] = [];
    const { result, rerender } = renderHook(
      ({ corrections }: { corrections: readonly TranscriptCorrection[] }) => useCloudComparison({
        session: data.session,
        initial: data.initial,
        retry: data.retry,
        focus: data.focus,
        corrections,
        correctionsReady: true,
        artifacts: [],
        metricVersionsMatch: true,
        persistArtifact: async (artifact) => {
          persisted.push(artifact);
          if (artifact.type === 'cloud_semantic_comparison' && artifact.payload.status === 'complete') {
            return completeWrite.promise;
          }
          return artifact;
        },
        onArtifactPersisted: vi.fn(),
        services: cloud.value,
      }),
      { initialProps: { corrections: [] as readonly TranscriptCorrection[] } },
    );

    await waitFor(() => expect(result.current.canonicalPayload).not.toBeNull());
    await act(async () => result.current.prepare());
    let approval!: Promise<void>;
    act(() => {
      approval = result.current.approveAndRun();
    });
    await waitFor(() => expect(persisted.some((artifact) => (
      artifact.type === 'cloud_semantic_comparison' && artifact.payload.status === 'complete'
    ))).toBe(true));

    rerender({ corrections: [initialCorrection(data)] });
    const pendingComplete = persisted.find((artifact) => (
      artifact.type === 'cloud_semantic_comparison' && artifact.payload.status === 'complete'
    ))!;
    await act(async () => {
      completeWrite.resolve(pendingComplete);
      await approval;
    });

    expect(persisted
      .filter((artifact) => artifact.type === 'cloud_semantic_comparison')
      .map((artifact) => artifact.payload.status)).toEqual([
        'queued', 'processing', 'complete', 'superseded',
      ]);
  });

  it('resumes a failed approved payload only once under a double click', async () => {
    const data = fixture();
    const payload = buildSemanticComparisonPayload({
      session: data.session,
      initial: data.initial,
      retry: data.retry,
      criterionId: data.focus.criterionId,
      label: data.focus.criterionLabel,
      drillId: data.focus.drillId,
      corrections: [],
      analysisInputId: 'cloud-ui-double-retry',
    });
    const queued = createQueuedCloudSemanticComparison({
      payload,
      payloadHash: 'd'.repeat(64),
      consentId: 'comparison-consent-double-retry',
      at,
    });
    const failed = transitionCloudSemanticComparison(
      transitionCloudSemanticComparison(queued, {
        status: 'processing',
        at: '2026-07-18T06:30:01.000Z',
      }),
      {
        status: 'failed',
        at: '2026-07-18T06:30:02.000Z',
        errorCode: 'NETWORK_UNAVAILABLE',
      },
    );
    const providerResult = deferred<SemanticComparisonResponse>();
    const cloud = services(() => providerResult.promise);
    const persisted: PracticeArtifact[] = [];
    const artifact: PracticeArtifact = {
      type: 'cloud_semantic_comparison',
      sessionId: data.session.id,
      id: 'cloud-ui-double-retry-artifact',
      payload: failed,
    };
    const { result } = renderHook(() => useCloudComparison({
      session: data.session,
      initial: data.initial,
      retry: data.retry,
      focus: data.focus,
      corrections: [],
      correctionsReady: true,
      artifacts: [artifact],
      metricVersionsMatch: true,
      persistArtifact: async (next) => {
        persisted.push(next);
        return next;
      },
      onArtifactPersisted: vi.fn(),
      services: cloud.value,
    }));

    await waitFor(() => expect(result.current.artifact?.payload.status).toBe('failed'));
    let firstRetry!: Promise<void>;
    act(() => {
      firstRetry = result.current.retry();
      void result.current.retry();
    });
    await waitFor(() => expect(cloud.executeComparison).toHaveBeenCalledOnce());
    await act(async () => {
      providerResult.resolve(cloudResult);
      await firstRetry;
    });

    expect(persisted
      .filter((candidate) => candidate.type === 'cloud_semantic_comparison')
      .map((candidate) => candidate.payload.status)).toEqual(['processing', 'complete']);
  });

  it.each(['queued', 'processing'] as const)(
    'supersedes a stale %s artifact loaded after restart without calling the provider',
    async (status) => {
      const data = fixture();
      const oldPayload = buildSemanticComparisonPayload({
        session: data.session,
        initial: data.initial,
        retry: data.retry,
        criterionId: data.focus.criterionId,
        label: data.focus.criterionLabel,
        drillId: data.focus.drillId,
        corrections: [],
        analysisInputId: `cloud-ui-restart-${status}`,
      });
      const queued = createQueuedCloudSemanticComparison({
        payload: oldPayload,
        payloadHash: 'e'.repeat(64),
        consentId: `comparison-consent-restart-${status}`,
        at,
      });
      const stale = status === 'processing'
        ? transitionCloudSemanticComparison(queued, {
            status: 'processing',
            at: '2026-07-18T06:30:01.000Z',
          })
        : queued;
      const artifact: PracticeArtifact = {
        type: 'cloud_semantic_comparison',
        sessionId: data.session.id,
        id: `cloud-ui-restart-${status}-artifact`,
        payload: stale,
      };
      const cloud = services(async () => cloudResult);
      const persisted: PracticeArtifact[] = [];
      renderHook(() => useCloudComparison({
        session: data.session,
        initial: data.initial,
        retry: data.retry,
        focus: data.focus,
        corrections: [initialCorrection(data)],
        correctionsReady: true,
        artifacts: [artifact],
        metricVersionsMatch: true,
        persistArtifact: async (next) => {
          persisted.push(next);
          return next;
        },
        onArtifactPersisted: vi.fn(),
        services: cloud.value,
      }));

      await waitFor(() => expect(persisted.some((candidate) => (
        candidate.type === 'cloud_semantic_comparison'
        && candidate.payload.status === 'superseded'
      ))).toBe(true));
      expect(cloud.executeComparison).not.toHaveBeenCalled();
    },
  );

  it('blocks a changed frozen focus before preparing consent', async () => {
    const cloud = services(async () => cloudResult);
    renderPage({ cloudServices: cloud.value });
    const editor = await screen.findByLabelText('本次云端语义比较 exact JSON');
    const changed = JSON.parse((editor as HTMLTextAreaElement).value) as SemanticComparisonPayload;
    changed.focus.label = '偷偷换成另一个焦点';
    fireEvent.change(editor, { target: { value: JSON.stringify(changed, null, 2) } });
    fireEvent.click(screen.getByRole('button', { name: '校验并生成批准预览' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('冻结身份、唯一焦点或同口径指标');
    expect(cloud.prepareConsent).not.toHaveBeenCalled();
  });

  it('recovers explicitly when the cloud preference cannot be read', async () => {
    const cloud = services(async () => cloudResult);
    const getPreferences = vi.fn()
      .mockRejectedValueOnce(new Error('settings unavailable'))
      .mockResolvedValue({
        liveHintEnabled: false,
        deepDiagnosisEnabled: false,
        comparisonEnabled: true,
      });
    renderPage({ cloudServices: { ...cloud.value, getPreferences } });

    expect(await screen.findByText('暂时无法读取云端比较状态')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    expect(await screen.findByLabelText('本次云端语义比较 exact JSON')).toBeInTheDocument();
    expect(getPreferences).toHaveBeenCalledTimes(2);
  });

  it('recovers explicitly when the frozen Session cannot be read', async () => {
    const cloud = services(async () => cloudResult);
    const data = fixture();
    const loadSession = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(data.session);
    renderPage({ cloudServices: cloud.value, loadSession });

    expect(await screen.findByText(/冻结 Session 暂时无法读取/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新读取冻结 Session' }));
    expect(await screen.findByLabelText('本次云端语义比较 exact JSON')).toBeInTheDocument();
    expect(loadSession).toHaveBeenCalledTimes(2);
  });

  it('persists failure and retries the same exact approved payload without another approval', async () => {
    let request = 0;
    const cloud = services(async () => {
      request += 1;
      if (request === 1) throw new Error('NETWORK_UNAVAILABLE');
      return cloudResult;
    });
    const persisted: PracticeArtifact[] = [];
    renderPage({
      cloudServices: cloud.value,
      persistArtifact: async (artifact) => {
        persisted.push(artifact);
        return artifact;
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: '校验并生成批准预览' }));
    fireEvent.click(await screen.findByRole('button', { name: '批准这一 payload 并发送' }));

    expect(await screen.findByText('处理失败')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('网络不可用');
    fireEvent.click(screen.getByRole('button', { name: /重试同一已批准 payload/ }));
    expect(await screen.findByRole('heading', { name: '语义证据支持改善' })).toBeInTheDocument();
    expect(cloud.approveConsent).toHaveBeenCalledTimes(1);
    expect(cloud.executeComparison).toHaveBeenCalledTimes(2);
    expect(persisted
      .filter((artifact) => artifact.type === 'cloud_semantic_comparison')
      .map((artifact) => artifact.payload.status)).toEqual([
        'queued', 'processing', 'failed', 'processing', 'complete',
      ]);
  });

  it.each([
    ['CONSENT_EXPIRED', '逐 payload 批准已失效'],
    ['CONSENT_NOT_FOUND', '找不到这次逐 payload 批准'],
    ['CONSENT_REVOKED', '逐 payload 批准已撤回'],
  ])('requires a new review instead of retrying the same consent after %s', async (code, copy) => {
    const cloud = services(async () => {
      throw new Error(`PHRIO_${code}`);
    });
    renderPage({ cloudServices: cloud.value });

    fireEvent.click(await screen.findByRole('button', { name: '校验并生成批准预览' }));
    fireEvent.click(await screen.findByRole('button', { name: '批准这一 payload 并发送' }));

    expect(await screen.findByText('处理失败')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(copy);
    expect(screen.queryByRole('button', { name: /重试同一已批准 payload/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新审核 exact JSON' }));
    expect(screen.getByLabelText('本次云端语义比较 exact JSON')).toBeInTheDocument();
    expect(cloud.executeComparison).toHaveBeenCalledTimes(1);
    expect(cloud.approveConsent).toHaveBeenCalledTimes(1);
  });

  it('reloads a completed result and its exact approved JSON without calling the provider', async () => {
    const data = fixture();
    const payload = buildSemanticComparisonPayload({
      session: data.session,
      initial: data.initial,
      retry: data.retry,
      criterionId: data.focus.criterionId,
      label: data.focus.criterionLabel,
      drillId: data.focus.drillId,
      corrections: [],
      analysisInputId: 'cloud-ui-analysis-reload',
    });
    const queued = createQueuedCloudSemanticComparison({
      payload,
      payloadHash: 'a'.repeat(64),
      consentId: 'comparison-consent-reload',
      at,
    });
    const processing = transitionCloudSemanticComparison(queued, {
      status: 'processing',
      at: '2026-07-18T06:30:01.000Z',
    });
    const complete = transitionCloudSemanticComparison(processing, {
      status: 'complete',
      at: '2026-07-18T06:30:02.000Z',
      result: cloudResult,
    });
    const artifact: PracticeArtifact = {
      type: 'cloud_semantic_comparison',
      sessionId: data.session.id,
      id: 'cloud-ui-comparison-reload',
      payload: complete,
    };
    const cloud = services(async () => {
      throw new Error('provider must not run during reload');
    });
    renderPage({ cloudServices: cloud.value, initialArtifacts: [artifact] });

    expect(await screen.findByRole('heading', { name: '语义证据支持改善' })).toBeInTheDocument();
    expect(screen.queryByLabelText('本次云端语义比较 exact JSON')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('查看当时批准的 exact JSON'));
    expect(screen.getByText(/cloud-ui-analysis-reload/)).toBeInTheDocument();
    expect(cloud.executeComparison).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('heading', { name: /论证桥完整：改善/ })).toBeInTheDocument());
  });

  it('keeps the local paired result primary and the completed cloud result inspectable in history', async () => {
    const data = fixture();
    const payload = buildSemanticComparisonPayload({
      session: data.session,
      initial: data.initial,
      retry: data.retry,
      criterionId: data.focus.criterionId,
      label: data.focus.criterionLabel,
      drillId: data.focus.drillId,
      corrections: [],
      analysisInputId: 'cloud-history-analysis',
    });
    const queued = createQueuedCloudSemanticComparison({
      payload,
      payloadHash: 'c'.repeat(64),
      consentId: 'cloud-history-consent',
      at,
    });
    const complete = transitionCloudSemanticComparison(
      transitionCloudSemanticComparison(queued, {
        status: 'processing',
        at: '2026-07-18T06:30:01.000Z',
      }),
      {
        status: 'complete',
        at: '2026-07-18T06:30:02.000Z',
        result: cloudResult,
      },
    );
    render(
      <PracticeRecordDetailPage
        loadRecord={async () => ({
          session: data.session,
          artifacts: [
            {
              type: 'attempt_comparison',
              sessionId: data.session.id,
              id: 'local-history-comparison',
              payload: {
                id: 'local-history-comparison',
                initialSnapshotId: data.initial.id,
                retrySnapshotId: data.retry.id,
                criterionId: data.focus.criterionId,
                protocolVersion: 'paired-1',
                result: 'improved',
                initialEvidenceIds: [],
                retryEvidenceIds: [],
                explanation: '本地同一指标版本显示弱化表达减少。',
                comparedAt: at,
              },
            },
            {
              type: 'cloud_semantic_comparison',
              sessionId: data.session.id,
              id: 'cloud-history-comparison',
              payload: complete,
            },
          ],
          resumable: {
            sessionId: data.session.id,
            status: data.session.status,
            screen: 'S09',
            draft: data.draft,
            selectedFocus: data.focus,
          },
        })}
        onBack={vi.fn()}
        onDeleted={vi.fn()}
        onRepeat={vi.fn()}
        onResume={vi.fn()}
        sessionId={data.session.id}
      />,
    );

    expect(await screen.findByRole('heading', { name: '目标行为更清楚' })).toBeInTheDocument();
    expect(screen.getByText('本地同一指标版本显示弱化表达减少。')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '云端语义证据支持改善' })).toBeInTheDocument();
    expect(screen.getByText('comparison-1 · 不改变本地结果与唯一焦点')).toBeInTheDocument();
    fireEvent.click(screen.getByText('查看当时批准的 exact JSON'));
    expect(screen.getByText(/cloud-history-analysis/)).toBeInTheDocument();
  });
});
