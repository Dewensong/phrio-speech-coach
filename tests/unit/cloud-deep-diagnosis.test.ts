import { describe, expect, it } from 'vitest';

import {
  CloudDeepDiagnosisArtifactSchema,
  createQueuedCloudDeepDiagnosis,
  transitionCloudDeepDiagnosis,
  type DeepDiagnosisPayload,
  type DeepDiagnosisResponse,
} from '../../src/shared';
import { parseEditedDeepPayload } from '../../src/frontend/services/cloud-ai-api';

const t0 = '2026-07-18T01:00:00.000Z';
const t1 = '2026-07-18T01:00:01.000Z';
const t2 = '2026-07-18T01:00:02.000Z';

function payload(): DeepDiagnosisPayload {
  return {
    schemaVersion: 'deep-diagnosis-1',
    purpose: 'deep_diagnosis',
    analysisInputId: 'analysis-deep-1',
    sessionId: 'session-deep-1',
    attemptId: 'attempt-deep-1',
    snapshotId: 'snapshot-deep-1',
    transcriptVersion: 2,
    task: {
      modeId: 'clear-expression',
      taskId: 'weekly-scope',
      taskVersion: '1.0.0',
      prompt: '向团队说明本周取舍。',
      audience: '产品团队',
      objective: '明确取舍和下一步',
      background: '本周资源有限。',
      sourceMaterial: '',
      counterArgument: '',
      roleContext: '周会',
      successConditions: ['先给结论', '说明一个理由'],
      rubric: [{
        criterionId: 'conclusion-first',
        label: '结论先行',
        description: '先给出可执行结论。',
      }],
      drills: [{
        drillId: 'conclusion-drill',
        criterionId: 'conclusion-first',
        title: '一句话结论',
        instruction: '先只说结论。',
        template: '我建议……',
        successCondition: '第一句出现明确建议。',
      }],
    },
    finalSegments: [{
      id: 'segment-deep-1',
      sequence: 0,
      revision: 1,
      startMs: 0,
      endMs: 5_000,
      text: '我建议本周先冻结新增需求。',
    }],
    corrections: [{
      segmentId: 'segment-deep-1',
      originalText: '我觉得本周可能冻结新增需求。',
      approvedText: '我建议本周先冻结新增需求。',
    }],
    localEvidence: [{
      id: 'evidence-deep-1',
      displayId: 'O1',
      type: 'structure',
      segmentId: 'segment-deep-1',
      phrase: '我建议',
      evidence: '第一句给出了建议。',
      suggestion: '继续保持结论先行。',
      lifecycle: 'confirmed',
      source: 'local_rule',
    }],
    metrics: {
      words: 14,
      fillers: 0,
      hedges: 0,
      vagueWords: 0,
      repetitions: 0,
      selfCorrections: 0,
    },
  };
}

function response(overrides: Partial<DeepDiagnosisResponse> = {}): DeepDiagnosisResponse {
  return {
    judgment: '结论清楚，但理由还可以更具体。',
    observations: [{
      type: 'quote',
      criterionId: 'conclusion-first',
      segmentId: 'segment-deep-1',
      evidence: '首句“我建议本周先冻结新增需求”给出了明确结论。',
      suggestion: '补充一个最关键的资源约束。',
      confidence: 'high',
    }],
    focus: {
      criterionId: 'conclusion-first',
      label: '结论先行',
      reason: '先巩固结论和理由的连接。',
      drillId: 'conclusion-drill',
      drill: '我建议……因为……',
    },
    ...overrides,
  };
}

describe('cloud Deep diagnosis artifacts', () => {
  it('persists a chronological queued → processing → complete lifecycle', () => {
    const queued = createQueuedCloudDeepDiagnosis({
      payload: payload(),
      payloadHash: 'a'.repeat(64),
      consentId: 'consent-deep-1',
      at: t0,
    });
    const processing = transitionCloudDeepDiagnosis(queued, { status: 'processing', at: t1 });
    const complete = transitionCloudDeepDiagnosis(processing, {
      status: 'complete',
      at: t2,
      result: response(),
    });

    expect(complete.lifecycle.map((event) => event.status)).toEqual([
      'queued',
      'processing',
      'complete',
    ]);
    expect(complete.result?.focus).toMatchObject({
      criterionId: 'conclusion-first',
      drillId: 'conclusion-drill',
    });
    expect(CloudDeepDiagnosisArtifactSchema.parse(complete)).toEqual(complete);
  });

  it('keeps a completed result as neutral history after transcript correction', () => {
    const queued = createQueuedCloudDeepDiagnosis({
      payload: payload(), payloadHash: 'a'.repeat(64), consentId: 'consent-deep-1', at: t0,
    });
    const complete = transitionCloudDeepDiagnosis(
      transitionCloudDeepDiagnosis(queued, { status: 'processing', at: t1 }),
      { status: 'complete', at: t2, result: response() },
    );
    const superseded = transitionCloudDeepDiagnosis(complete, {
      status: 'superseded',
      at: '2026-07-18T01:00:03.000Z',
    });

    expect(superseded.status).toBe('superseded');
    expect(superseded.result).toEqual(complete.result);
    expect(superseded.lifecycle.at(-1)?.status).toBe('superseded');
    expect(() => transitionCloudDeepDiagnosis(complete, {
      status: 'superseded',
      at: '2026-07-18T01:00:04.000Z',
      result: null,
    })).toThrow(/must retain its provider result/);
  });

  it('rejects untraceable quotes, foreign focus IDs and illegal lifecycle jumps', () => {
    const queued = createQueuedCloudDeepDiagnosis({
      payload: payload(), payloadHash: 'a'.repeat(64), consentId: 'consent-deep-1', at: t0,
    });
    const processing = transitionCloudDeepDiagnosis(queued, { status: 'processing', at: t1 });

    expect(() => transitionCloudDeepDiagnosis(processing, {
      status: 'complete',
      at: t2,
      result: response({
        observations: [{ ...response().observations[0]!, segmentId: null }],
      }),
    })).toThrow(/quoted AI evidence requires a traceable final segment/);

    expect(() => transitionCloudDeepDiagnosis(processing, {
      status: 'complete',
      at: t2,
      result: response({
        observations: [{
          ...response().observations[0]!,
          evidence: '只引用单字“我”不足以证明判断。',
        }],
      }),
    })).toThrow(/must quote an exact phrase/);

    expect(() => transitionCloudDeepDiagnosis(processing, {
      status: 'complete',
      at: t2,
      result: response({
        focus: { ...response().focus, drillId: 'foreign-drill' },
      }),
    })).toThrow(/AI focus must resolve/);

    expect(() => transitionCloudDeepDiagnosis(queued, {
      status: 'complete',
      at: t1,
      result: response(),
    })).toThrow(/illegal cloud diagnosis transition/);
  });
});

describe('editable exact deep payload', () => {
  it('allows text redaction and deletion while preserving exact structural identity', () => {
    const original = payload();
    const edited = structuredClone(original);
    edited.task.background = '已删减背景';
    edited.finalSegments[0]!.text = '我建议冻结新增需求。';
    edited.localEvidence = [];
    edited.corrections = [];
    edited.task.successConditions = ['先给结论'];

    expect(parseEditedDeepPayload(JSON.stringify(edited), original)).toMatchObject({
      task: { background: '已删减背景', successConditions: ['先给结论'] },
      finalSegments: [{ id: 'segment-deep-1', text: '我建议冻结新增需求。' }],
      localEvidence: [],
      corrections: [],
    });
  });

  it('rejects changed identity, injected entries, metric edits and evidence lifecycle edits', () => {
    const original = payload();
    const cases: DeepDiagnosisPayload[] = [
      { ...structuredClone(original), sessionId: 'another-session' },
      {
        ...structuredClone(original),
        corrections: [{
          segmentId: 'segment-deep-1',
          originalText: 'injected correction',
          approvedText: 'injected correction',
        }, {
          segmentId: 'foreign-segment',
          originalText: 'foreign',
          approvedText: 'foreign',
        }],
      },
      { ...structuredClone(original), metrics: { ...original.metrics, fillers: 99 } },
      {
        ...structuredClone(original),
        localEvidence: [{ ...original.localEvidence[0]!, lifecycle: 'withdrawn' }],
      },
    ];

    for (const candidate of cases) {
      expect(() => parseEditedDeepPayload(JSON.stringify(candidate), original))
        .toThrow('AI_PAYLOAD_IDENTITY_CHANGED');
    }
  });
});
