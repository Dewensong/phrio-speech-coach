import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APPROVED_AI_PROVIDER,
  GATE_C_PM_TASK,
  PracticeSessionSchema,
  createQueuedCloudDeepDiagnosis,
  createPracticeSession,
  deriveLocalDeepReportId,
  listPracticeFocusOptions,
  type AttemptSnapshot,
  type CloudAiConsent,
  type DeepDiagnosisPayload,
  type DeepDiagnosisResponse,
  type PracticeArtifact,
  type PracticeSession,
  type PreparedAiConsent,
  transitionCloudDeepDiagnosis,
} from '../../src/shared';
import { PRACTICE_TASKS } from '../../src/frontend/data/practice-catalog';
import { DeepLanePage } from '../../src/frontend/pages/deep-lane-page';
import { PracticeRecordDetailPage } from '../../src/frontend/pages/practice-record-detail-page';
import type { DeepCloudDiagnosisDependencies } from '../../src/frontend/hooks/use-deep-cloud-diagnosis';
import { buildDeepDiagnosisPayload } from '../../src/frontend/services/cloud-ai-api';
import type { PracticeDraft } from '../../src/frontend/types/ui';

const at = '2026-07-18T03:00:00.000Z';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function snapshot(): AttemptSnapshot {
  return {
    schemaVersion: 1,
    id: 'snapshot-cloud-deep-ui',
    sessionId: 'session-cloud-deep-ui',
    attemptId: 'attempt-cloud-deep-ui',
    generation: 1,
    kind: 'initial',
    frozenAt: at,
    audioWatermark: 6_000,
    transcriptVersion: 1,
    finalSegments: [{
      id: 'segment-cloud-deep-ui',
      attemptId: 'attempt-cloud-deep-ui',
      sequence: 0,
      revision: 1,
      text: '我建议本周先冻结新增需求，因为交付资源已经不足。',
      startMs: 0,
      endMs: 6_000,
      confidence: null,
      isFinal: true,
      emittedAt: at,
      finalizedAt: at,
      modelVersion: 'test-1',
    }],
    annotations: [{
      id: 'evidence-cloud-deep-ui',
      displayId: 'O1',
      segmentId: 'segment-cloud-deep-ui',
      type: 'structure',
      sourceSpan: { start: 0, end: 3, text: '我建议' },
      evidence: '首句先给出了建议。',
      suggestion: '继续保持结论先行。',
      source: 'local_rule',
      lifecycle: 'confirmed',
      algorithmVersion: 'local-rules-1',
      createdAt: at,
      updatedAt: at,
      withdrawnReason: null,
    }],
    hints: [],
    focusVersion: 1,
    metrics: {
      finalCharacters: 25,
      finalSegments: 1,
      fillers: 0,
      hedges: 0,
      vagueWords: 0,
      repetitions: 0,
      selfCorrections: 0,
      algorithmVersion: 'local-rules-1',
    },
  };
}

function session(attemptSnapshot = snapshot()): PracticeSession {
  const base = createPracticeSession({
    id: attemptSnapshot.sessionId,
    modeVersion: '0.1.0-dev.1',
    task: GATE_C_PM_TASK,
    now: at,
  });
  return PracticeSessionSchema.parse({
    ...base,
    status: 'diagnosis',
    attempts: [{
      id: attemptSnapshot.attemptId,
      sessionId: attemptSnapshot.sessionId,
      kind: 'initial',
      status: 'confirmed',
      audioRef: `${attemptSnapshot.attemptId}.webm`,
      mimeType: 'audio/webm',
      durationMs: attemptSnapshot.audioWatermark,
      byteLength: 2_048,
      createdAt: at,
      updatedAt: at,
      confirmedAt: at,
    }],
  });
}

function unrelatedDraft(): PracticeDraft {
  const task = PRACTICE_TASKS.find((candidate) => candidate.id === 'ai-assistant-decisions')!;
  return {
    mode: task.mode,
    task,
    audience: task.audience,
    goal: task.goal,
    durationSeconds: task.durationSeconds,
  };
}

function configuration() {
  return {
    provider: APPROVED_AI_PROVIDER.id,
    providerName: APPROVED_AI_PROVIDER.name,
    model: APPROVED_AI_PROVIDER.model,
    endpoint: APPROVED_AI_PROVIDER.endpoint,
    protocolVersion: APPROVED_AI_PROVIDER.protocolVersion,
    configured: true,
    encryptionAvailable: true,
    keyStorage: 'system_encrypted' as const,
    keyHint: '••••test',
    retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
  } as const;
}

function prepared(payload: DeepDiagnosisPayload): PreparedAiConsent {
  return {
    preparationId: 'preparation-cloud-deep-ui',
    purpose: 'deep_diagnosis',
    scope: 'payload',
    provider: APPROVED_AI_PROVIDER.id,
    model: APPROVED_AI_PROVIDER.model,
    endpoint: APPROVED_AI_PROVIDER.endpoint,
    payloadHash: 'a'.repeat(64),
    policyHash: 'b'.repeat(64),
    schemaVersion: payload.schemaVersion,
    promptVersion: APPROVED_AI_PROVIDER.promptVersion,
    approvedFields: ['task', 'finalSegments', 'corrections', 'localEvidence', 'metrics'],
    previewJson: JSON.stringify(payload, null, 2),
    retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
    preparedAt: at,
  };
}

function consent(payload: DeepDiagnosisPayload): CloudAiConsent {
  return {
    id: 'consent-cloud-deep-ui',
    purpose: 'deep_diagnosis',
    scope: 'payload',
    sessionId: payload.sessionId,
    provider: APPROVED_AI_PROVIDER.id,
    model: APPROVED_AI_PROVIDER.model,
    endpoint: APPROVED_AI_PROVIDER.endpoint,
    payloadHash: 'a'.repeat(64),
    policyHash: 'b'.repeat(64),
    schemaVersion: payload.schemaVersion,
    promptVersion: APPROVED_AI_PROVIDER.promptVersion,
    approvedFields: ['task', 'finalSegments', 'corrections', 'localEvidence', 'metrics'],
    approvedAt: at,
    expiresAt: null,
    revokedAt: null,
  };
}

function response(payload: DeepDiagnosisPayload): DeepDiagnosisResponse {
  const drill = payload.task.drills.at(-1)!;
  const criterion = payload.task.rubric.find(
    (candidate) => candidate.criterionId === drill.criterionId,
  )!;
  return {
    judgment: '结论已经出现，理由与下一步还可以更紧密。',
    observations: [{
      type: 'quote',
      criterionId: criterion.criterionId,
      segmentId: payload.finalSegments[0]!.id,
      evidence: `获批句段“${payload.finalSegments[0]!.text}”给出了明确建议。`,
      suggestion: '将资源约束直接连接到下一步。',
      confidence: 'high',
    }],
    focus: {
      criterionId: criterion.criterionId,
      label: criterion.label,
      reason: '这是当前 Rubric 中最值得单点训练的一项。',
      drillId: drill.drillId,
      drill: drill.template,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function readyDependencies(input: {
  readonly execute: DeepCloudDiagnosisDependencies['execute'];
  readonly saved?: PracticeArtifact[];
  readonly now?: () => string;
}) {
  const attemptSnapshot = snapshot();
  const practiceSession = session(attemptSnapshot);
  const saved = input.saved ?? [];
  let approvedPayload: DeepDiagnosisPayload | null = null;
  const prepareConsent = vi.fn(async (payload: DeepDiagnosisPayload) => {
    approvedPayload = payload;
    return prepared(payload);
  });
  const approveConsent = vi.fn(async () => {
    if (!approvedPayload) throw new Error('NO_PREPARED_PAYLOAD');
    return consent(approvedPayload);
  });
  const saveArtifact = vi.fn(async (artifact: PracticeArtifact) => {
    saved.push(artifact);
    return artifact;
  });
  const dependencies: DeepCloudDiagnosisDependencies = {
    getSession: async () => practiceSession,
    listArtifacts: async () => [...saved],
    saveArtifact,
    getConfiguration: async () => configuration(),
    getPreferences: async () => ({
      liveHintEnabled: false,
      deepDiagnosisEnabled: true,
      comparisonEnabled: false,
    }),
    prepareConsent,
    approveConsent,
    execute: input.execute,
    now: input.now,
  };
  return {
    attemptSnapshot,
    dependencies,
    prepareConsent,
    approveConsent,
    saveArtifact,
    saved,
  };
}

describe('Deep Lane optional cloud diagnosis', () => {
  it('rejects a frozen snapshot that does not belong to the persisted Session/Attempt', () => {
    const attemptSnapshot = snapshot();
    const practiceSession = session(attemptSnapshot);
    expect(() => buildDeepDiagnosisPayload({
      session: practiceSession,
      snapshot: { ...attemptSnapshot, sessionId: 'foreign-session' },
      corrections: [],
    })).toThrow('AI_DEEP_SNAPSHOT_SESSION_MISMATCH');
  });

  it('renders the local frozen report without waiting for cloud configuration', async () => {
    const never = deferred<ReturnType<typeof configuration>>();
    const attemptSnapshot = snapshot();
    const practiceSession = session(attemptSnapshot);
    const defaultFocus = listPracticeFocusOptions(
      practiceSession.modeId,
      practiceSession.taskId,
    )[0]!;
    render(
      <DeepLanePage
        cloudDependencies={{
          getSession: async () => practiceSession,
          listArtifacts: async () => [],
          getConfiguration: () => never.promise,
          getPreferences: async () => ({
            liveHintEnabled: false,
            deepDiagnosisEnabled: true,
            comparisonEnabled: false,
          }),
        }}
        draft={unrelatedDraft()}
        onStartDrill={vi.fn()}
        sessionId={practiceSession.id}
        snapshot={attemptSnapshot}
      />,
    );

    expect(await screen.findByText('本地确定性复盘')).toBeInTheDocument();
    expect(screen.getAllByText(defaultFocus.criterionLabel).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('正在读取完整 AI 复盘配置…')).toBeInTheDocument();
    await waitFor(() => expect(
      screen.getByRole('button', { name: '选择这个焦点，开始 Drill' }),
    ).toBeEnabled());
  });

  it('validates exact identity, persists every state, traces evidence and supersedes after correction', async () => {
    const execution = deferred<DeepDiagnosisResponse>();
    const times = [
      '2026-07-18T03:00:01.000Z',
      '2026-07-18T03:00:02.000Z',
      '2026-07-18T03:00:03.000Z',
      '2026-07-18T03:00:04.000Z',
    ];
    const setup = readyDependencies({
      execute: async () => execution.promise,
      now: () => times.shift() ?? '2026-07-18T03:00:05.000Z',
    });
    const onStartDrill = vi.fn();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    render(
      <DeepLanePage
        cloudDependencies={setup.dependencies}
        draft={unrelatedDraft()}
        onStartDrill={onStartDrill}
        sessionId={setup.attemptSnapshot.sessionId}
        snapshot={setup.attemptSnapshot}
      />,
    );

    const openPayloadEditor = await screen.findByRole('button', { name: '预览并删减发送内容' });
    fireEvent.click(openPayloadEditor);
    const editor = screen.getByRole('textbox', { name: '可编辑的 deep_diagnosis JSON' });
    expect(editor).toHaveFocus();
    const original = JSON.parse((editor as HTMLTextAreaElement).value) as DeepDiagnosisPayload;
    fireEvent.change(editor, { target: { value: JSON.stringify({ ...original, sessionId: 'foreign-session' }, null, 2) } });
    fireEvent.click(screen.getByRole('button', { name: '校验并生成批准摘要' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('身份不能修改');
    expect(setup.prepareConsent).not.toHaveBeenCalled();

    const edited = structuredClone(original);
    edited.localEvidence = [];
    edited.task.background = '只发送必要背景。';
    fireEvent.change(editor, { target: { value: JSON.stringify(edited, null, 2) } });
    fireEvent.click(screen.getByRole('button', { name: '校验并生成批准摘要' }));
    expect(await screen.findByText('Payload hash')).toBeInTheDocument();
    expect(setup.prepareConsent).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: setup.attemptSnapshot.sessionId,
      localEvidence: [],
      task: expect.objectContaining({ background: '只发送必要背景。' }),
    }));

    fireEvent.click(screen.getByRole('button', { name: '逐 payload 批准并发送' }));
    await waitFor(() => expect(screen.getAllByText('处理中').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('已排队')).toBeInTheDocument();
    expect(setup.saveArtifact.mock.calls.map(([artifact]) => (
      artifact.type === 'cloud_deep_diagnosis' ? artifact.payload.status : null
    ))).toEqual(['queued', 'processing']);

    await act(async () => {
      execution.resolve(response(edited));
      await execution.promise;
    });
    expect(await screen.findByText('完整 AI 复盘 · 不是实时短提示')).toBeInTheDocument();
    expect(screen.getAllByText('已完成').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: '预览并删减发送内容' })).toHaveFocus();

    const locateButton = screen.getByRole('button', { name: '定位 final 句段' });
    fireEvent.click(locateButton);
    const segment = document.getElementById('deep-segment-segment-cloud-deep-ui')!;
    expect(document.activeElement).toBe(segment);
    expect(segment).toHaveClass('is-cloud-located');

    fireEvent.click(screen.getByRole('button', { name: '明确采用这个焦点' }));
    const cloudResult = response(edited);
    expect(screen.getByRole('combobox', { name: '选择唯一训练焦点' })).toHaveValue(
      `${cloudResult.focus.criterionId}:${cloudResult.focus.drillId}`,
    );
    const startDrill = screen.getByRole('button', { name: /开始 Drill|正在保存本地复盘/ });
    await waitFor(() => expect(startDrill).toHaveTextContent('选择这个焦点，开始 Drill'));
    expect(startDrill).toBeEnabled();
    fireEvent.click(startDrill);
    const savedLocalReportId = await deriveLocalDeepReportId({
      snapshotId: setup.attemptSnapshot.id,
      transcriptVersion: setup.attemptSnapshot.transcriptVersion,
      criterionId: cloudResult.focus.criterionId,
      drillId: cloudResult.focus.drillId,
    });
    expect(onStartDrill).toHaveBeenCalledWith(expect.objectContaining({
      criterionId: cloudResult.focus.criterionId,
      drillId: cloudResult.focus.drillId,
      guidanceSource: 'ai_evidence',
      evidenceIds: [edited.analysisInputId],
    }), savedLocalReportId);
    expect(screen.getAllByText(/已明确采用完整 AI 复盘建议/).length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole('button', { name: '纠正第 1 句' }));
    fireEvent.change(screen.getByRole('textbox', { name: '纠正逐字稿' }), {
      target: { value: '纠正后，我建议冻结新增需求。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存纠正' }));
    expect((await screen.findAllByText('历史态 · 已被纠正版本替代')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/旧云端结果转为历史态/)).toBeInTheDocument();
  });

  it.each(['queued', 'processing'] as const)(
    'recovers a persisted %s run with the already-approved exact payload after restart',
    async (persistedStatus) => {
      const attemptSnapshot = snapshot();
      const practiceSession = session(attemptSnapshot);
      const payload = buildDeepDiagnosisPayload({
        session: practiceSession,
        snapshot: attemptSnapshot,
        corrections: [],
        analysisInputId: `analysis-recovery-${persistedStatus}`,
      });
      const queued = createQueuedCloudDeepDiagnosis({
        payload,
        payloadHash: 'a'.repeat(64),
        consentId: `consent-recovery-${persistedStatus}`,
        at,
      });
      const persistedRun = persistedStatus === 'processing'
        ? transitionCloudDeepDiagnosis(queued, {
            status: 'processing',
            at: '2026-07-18T03:00:01.000Z',
          })
        : queued;
      const saved: PracticeArtifact[] = [{
        type: 'cloud_deep_diagnosis',
        sessionId: attemptSnapshot.sessionId,
        id: `cloud-deep-${payload.analysisInputId}`,
        payload: persistedRun,
      }];
      const execute = vi.fn(async () => response(payload));
      const setup = readyDependencies({ execute, saved });

      render(
        <DeepLanePage
          cloudDependencies={setup.dependencies}
          draft={unrelatedDraft()}
          onStartDrill={vi.fn()}
          sessionId={attemptSnapshot.sessionId}
          snapshot={attemptSnapshot}
        />,
      );

      const resume = await screen.findByRole('button', { name: '继续处理已批准 payload' });
      expect(resume).toBeEnabled();
      fireEvent.click(resume);

      expect(await screen.findByText('完整 AI 复盘 · 不是实时短提示')).toBeInTheDocument();
      expect(execute).toHaveBeenCalledWith(payload, `consent-recovery-${persistedStatus}`);
      expect(setup.prepareConsent).not.toHaveBeenCalled();
      expect(setup.approveConsent).not.toHaveBeenCalled();
      expect(setup.saveArtifact.mock.calls.map(([artifact]) => (
        artifact.type === 'cloud_deep_diagnosis' ? artifact.payload.status : null
      ))).toEqual(persistedStatus === 'queued'
        ? ['processing', 'complete']
        : ['complete']);
    },
  );

  it('persists failure and opens a fresh exact payload for explicit retry', async () => {
    const analysisIds: string[] = [];
    const setup = readyDependencies({
      execute: async (payload) => {
        analysisIds.push(payload.analysisInputId);
        throw new Error('AI_TIMEOUT');
      },
    });
    render(
      <DeepLanePage
        cloudDependencies={setup.dependencies}
        draft={unrelatedDraft()}
        onStartDrill={vi.fn()}
        sessionId={setup.attemptSnapshot.sessionId}
        snapshot={setup.attemptSnapshot}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '预览并删减发送内容' }));
    const firstJson = (screen.getByRole('textbox', { name: '可编辑的 deep_diagnosis JSON' }) as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole('button', { name: '校验并生成批准摘要' }));
    await screen.findByText('Payload hash');
    fireEvent.click(screen.getByRole('button', { name: '逐 payload 批准并发送' }));
    expect((await screen.findAllByText('失败')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('alert')).toHaveTextContent('AI_TIMEOUT');

    const retryTrigger = screen.getByRole('button', { name: '重新预览并批准' });
    fireEvent.click(retryTrigger);
    const retryEditor = await screen.findByRole('textbox', { name: '可编辑的 deep_diagnosis JSON' });
    expect(retryEditor).toHaveFocus();
    const retryJson = (retryEditor as HTMLTextAreaElement).value;
    expect(JSON.parse(retryJson).analysisInputId).not.toBe(JSON.parse(firstJson).analysisInputId);
    expect(analysisIds).toHaveLength(1);
    expect(setup.saveArtifact.mock.calls.map(([artifact]) => (
      artifact.type === 'cloud_deep_diagnosis' ? artifact.payload.status : null
    ))).toEqual(['queued', 'processing', 'failed']);
    fireEvent.click(screen.getByRole('button', { name: '关闭 payload 预览' }));
    await waitFor(() => expect(retryTrigger).toHaveFocus());
  });

  it('drops an in-flight result into neutral history when a correction changes the payload', async () => {
    const execution = deferred<DeepDiagnosisResponse>();
    let approvedPayload: DeepDiagnosisPayload | null = null;
    const setup = readyDependencies({
      execute: async (payload) => {
        approvedPayload = payload;
        return execution.promise;
      },
    });
    render(
      <DeepLanePage
        cloudDependencies={setup.dependencies}
        draft={unrelatedDraft()}
        onStartDrill={vi.fn()}
        sessionId={setup.attemptSnapshot.sessionId}
        snapshot={setup.attemptSnapshot}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '预览并删减发送内容' }));
    fireEvent.click(screen.getByRole('button', { name: '校验并生成批准摘要' }));
    await screen.findByText('Payload hash');
    fireEvent.click(screen.getByRole('button', { name: '逐 payload 批准并发送' }));
    await waitFor(() => expect(screen.getAllByText('处理中').length).toBeGreaterThanOrEqual(1));

    fireEvent.click(screen.getByRole('button', { name: '纠正第 1 句' }));
    fireEvent.change(screen.getByRole('textbox', { name: '纠正逐字稿' }), {
      target: { value: '纠正后的当前句段，不再采用旧 payload。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存纠正' }));
    await screen.findByText(/旧云端结果转为历史态/);

    await act(async () => {
      execution.resolve(response(approvedPayload!));
      await execution.promise;
    });
    expect((await screen.findAllByText('历史态 · 已被纠正版本替代')).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
    expect(setup.saveArtifact.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'cloud_deep_diagnosis',
      payload: { status: 'superseded', result: expect.any(Object) },
    });
  });

  it('keeps a completed diagnosis and its approved JSON inspectable in practice history', async () => {
    const attemptSnapshot = snapshot();
    const practiceSession = session(attemptSnapshot);
    const payload = buildDeepDiagnosisPayload({
      session: practiceSession,
      snapshot: attemptSnapshot,
      corrections: [],
      analysisInputId: 'analysis-cloud-deep-history',
    });
    const complete = transitionCloudDeepDiagnosis(
      transitionCloudDeepDiagnosis(createQueuedCloudDeepDiagnosis({
        payload,
        payloadHash: 'a'.repeat(64),
        consentId: 'consent-cloud-deep-history',
        at,
      }), {
        status: 'processing',
        at: '2026-07-18T03:00:01.000Z',
      }),
      {
        status: 'complete',
        at: '2026-07-18T03:00:02.000Z',
        result: response(payload),
      },
    );
    render(
      <PracticeRecordDetailPage
        loadRecord={async () => ({
          session: practiceSession,
          artifacts: [{
            type: 'cloud_deep_diagnosis',
            sessionId: practiceSession.id,
            id: 'cloud-deep-history',
            payload: complete,
          }],
          resumable: {
            sessionId: practiceSession.id,
            status: practiceSession.status,
            screen: 'S06',
            draft: unrelatedDraft(),
          },
        })}
        onBack={vi.fn()}
        onDeleted={vi.fn()}
        onRepeat={vi.fn()}
        onResume={vi.fn()}
        sessionId={practiceSession.id}
      />,
    );

    expect(await screen.findByRole('heading', { name: '逐 payload 批准记录' })).toBeInTheDocument();
    expect(screen.getByText('结论已经出现，理由与下一步还可以更紧密。')).toBeInTheDocument();
    expect(screen.getByText('不替换本地复盘与唯一焦点')).toBeInTheDocument();
    fireEvent.click(screen.getByText('查看当时批准的 exact JSON'));
    expect(screen.getByText(/analysis-cloud-deep-history/)).toBeInTheDocument();
  });
});
