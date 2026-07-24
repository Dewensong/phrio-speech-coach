import { z } from 'zod';

import {
  AttemptKindSchema,
  IdentifierSchema,
  ModeIdSchema,
} from './domain';
import {
  DECISION_ALIGNMENT_MODE_ID,
  GATE_C_PM_TASK,
  GATE_C_PM_TASK_ID,
} from './mode-packs';

export const TranscriptFixtureSegmentSchema = z
  .object({
    id: IdentifierSchema,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    text: z.string().min(1).max(2_000),
    lowConfidenceText: z.string().min(1).max(120).nullable(),
  })
  .strict()
  .refine((segment) => segment.endMs > segment.startMs, {
    message: 'segment end must be after its start',
    path: ['endMs'],
  });
export type TranscriptFixtureSegment = z.infer<typeof TranscriptFixtureSegmentSchema>;

export const AttemptFixtureSchema = z
  .object({
    kind: AttemptKindSchema,
    durationMs: z.number().int().positive().max(300_000),
    segments: z.array(TranscriptFixtureSegmentSchema).min(1),
  })
  .strict()
  .superRefine((attempt, context) => {
    const segmentIds = new Set(attempt.segments.map((segment) => segment.id));
    if (segmentIds.size !== attempt.segments.length) {
      context.addIssue({
        code: 'custom',
        path: ['segments'],
        message: 'fixture segment ids must be unique',
      });
    }
    if (attempt.segments.some((segment) => segment.endMs > attempt.durationMs)) {
      context.addIssue({
        code: 'custom',
        path: ['segments'],
        message: 'fixture segment cannot extend past attempt duration',
      });
    }
  });
export type AttemptFixture = z.infer<typeof AttemptFixtureSchema>;

export const EvidenceFixtureSchema = z
  .object({
    id: IdentifierSchema,
    displayId: z.string().regex(/^E\d{2}$/),
    segmentIds: z.array(IdentifierSchema).min(1),
    observedAtMs: z.number().int().nonnegative(),
    title: z.string().min(1).max(180),
    quote: z.string().min(1).max(500),
    explanation: z.string().min(1).max(1_000),
  })
  .strict();
export type EvidenceFixture = z.infer<typeof EvidenceFixtureSchema>;

export const ComparisonMetricFixtureSchema = z
  .object({
    id: IdentifierSchema,
    label: z.string().min(1).max(80),
    initial: z.number().nonnegative(),
    retry: z.number().nonnegative(),
    unit: z.enum(['ms', 'count']),
  })
  .strict();
export type ComparisonMetricFixture = z.infer<typeof ComparisonMetricFixtureSchema>;

export const GateCFixtureSchema = z
  .object({
    id: IdentifierSchema,
    developmentFixture: z.literal(true),
    disclaimer: z.string().min(1).max(500),
    modeId: ModeIdSchema,
    taskId: IdentifierSchema,
    taskTitle: z.string().min(1).max(180),
    firstAttempt: AttemptFixtureSchema,
    secondAttempt: AttemptFixtureSchema,
    evidence: z.array(EvidenceFixtureSchema).length(3),
    focus: z
      .object({
        criterionId: IdentifierSchema,
        drillId: IdentifierSchema,
        label: z.string().min(1).max(180),
        instruction: z.string().min(1).max(1_000),
      })
      .strict(),
    comparison: z
      .object({
        metrics: z.array(ComparisonMetricFixtureSchema).length(4),
        summary: z.string().min(1).max(1_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((fixture, context) => {
    if (fixture.firstAttempt.kind !== 'initial' || fixture.secondAttempt.kind !== 'retry') {
      context.addIssue({
        code: 'custom',
        path: ['firstAttempt'],
        message: 'Gate C fixture must contain initial then retry attempts',
      });
    }

    const firstSegmentIds = new Set(
      fixture.firstAttempt.segments.map((segment) => segment.id),
    );
    for (const [index, evidence] of fixture.evidence.entries()) {
      for (const segmentId of evidence.segmentIds) {
        if (!firstSegmentIds.has(segmentId)) {
          context.addIssue({
            code: 'custom',
            path: ['evidence', index, 'segmentIds'],
            message: `unknown first-attempt segment: ${segmentId}`,
          });
        }
      }
      if (evidence.observedAtMs > fixture.firstAttempt.durationMs) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', index, 'observedAtMs'],
          message: 'evidence time must fall inside the first attempt',
        });
      }
    }
  });
export type GateCFixture = z.infer<typeof GateCFixtureSchema>;

export const GATE_C_PM_FIXTURE: Readonly<GateCFixture> = Object.freeze(
  GateCFixtureSchema.parse({
    id: 'gate-c-pm-canonical',
    developmentFixture: true,
    disclaimer: '开发演示数据：逐字稿、证据和比较均为人工编写，不代表真实录音分析。',
    modeId: DECISION_ALIGNMENT_MODE_ID,
    taskId: GATE_C_PM_TASK_ID,
    taskTitle: GATE_C_PM_TASK.title,
    firstAttempt: {
      kind: 'initial',
      durationMs: 74_000,
      segments: [
        {
          id: 'initial-01',
          startMs: 0,
          endMs: 10_000,
          text: '嗯，这周先同步当前情况。然后，登录改版进入联调，回归还没跑完，大家其实都在补问题。',
          lowConfidenceText: null,
        },
        {
          id: 'initial-02',
          startMs: 10_000,
          endMs: 20_000,
          text: '模型评估有两个阻塞项：样本还没补齐，结果波动也较大。然后，研发现在就是比较满。',
          lowConfidenceText: '补齐／补全',
        },
        {
          id: 'initial-03',
          startMs: 20_000,
          endMs: 31_000,
          text: '所以说，我有个建议：本周是不是先冻结新增需求。嗯，再加的话，排期其实会继续后移。',
          lowConfidenceText: null,
        },
        {
          id: 'initial-04',
          startMs: 31_000,
          endMs: 42_000,
          text: '然后，登录没完成回归，新需求进来就是同时改两套逻辑，返工风险更高。',
          lowConfidenceText: null,
        },
        {
          id: 'initial-05',
          startMs: 42_000,
          endMs: 54_000,
          text: '嗯，我知道业务侧还有几个比较急的想法，但如果大家同时开始做，当前两个阻塞项可能更难收敛。',
          lowConfidenceText: null,
        },
        {
          id: 'initial-06',
          startMs: 54_000,
          endMs: 64_000,
          text: '我们可以先把新需求放到后面的评审里，等登录和评估稳定一点，再看优先级，再跟大家同步。',
          lowConfidenceText: null,
        },
        {
          id: 'initial-07',
          startMs: 64_000,
          endMs: 74_000,
          text: '大概是这个意思，具体什么时候恢复、谁来确认，我们后面再对一下，先听听大家有什么想法。',
          lowConfidenceText: null,
        },
      ],
    },
    secondAttempt: {
      kind: 'retry',
      durationMs: 42_000,
      segments: [
        {
          id: 'retry-01',
          startMs: 0,
          endMs: 6_000,
          text: '我的建议是，本周冻结新增需求。',
          lowConfidenceText: null,
        },
        {
          id: 'retry-02',
          startMs: 6_000,
          endMs: 15_000,
          text: '嗯，原因有两点：第一，登录改版还没完成回归，继续加需求会扩大返工面。',
          lowConfidenceText: null,
        },
        {
          id: 'retry-03',
          startMs: 15_000,
          endMs: 24_000,
          text: '第二，模型评估仍有两个阻塞项，新增工作会分散排查资源。',
          lowConfidenceText: null,
        },
        {
          id: 'retry-04',
          startMs: 24_000,
          endMs: 32_000,
          text: '在冻结期间，登录和评估工作按原计划推进，不影响已经承诺的交付。',
          lowConfidenceText: null,
        },
        {
          id: 'retry-05',
          startMs: 32_000,
          endMs: 38_000,
          text: '今天请确认把新需求放入下周评审，紧急事项单独升级。',
          lowConfidenceText: null,
        },
        {
          id: 'retry-06',
          startMs: 38_000,
          endMs: 42_000,
          text: '然后，我会在周五给出剩余风险清单，并建议恢复时间。',
          lowConfidenceText: null,
        },
      ],
    },
    evidence: [
      {
        id: 'e01',
        displayId: 'E01',
        segmentIds: ['initial-03'],
        observedAtMs: 24_000,
        title: '结论在约 24 秒出现',
        quote: '本周是不是先冻结新增需求。',
        explanation: '听众需要先穿过较长背景，才听到本轮核心建议。',
      },
      {
        id: 'e02',
        displayId: 'E02',
        segmentIds: ['initial-03', 'initial-06'],
        observedAtMs: 42_000,
        title: '语气让决定边界不清',
        quote: '是不是先冻结新增需求……再看优先级。',
        explanation: '建议与恢复条件都保留了较大解释空间。',
      },
      {
        id: 'e03',
        displayId: 'E03',
        segmentIds: ['initial-07'],
        observedAtMs: 64_000,
        title: '缺少负责人和评审时间',
        quote: '具体什么时候恢复、谁来确认，我们后面再对一下。',
        explanation: '任务要求的责任人、动作和时间条件没有形成闭环。',
      },
    ],
    focus: {
      criterionId: 'conclusion-first',
      drillId: 'decision-first-three-lines',
      label: '结论先行：先说决定，再给两个原因，最后明确下一步。',
      instruction: '我的建议是___。\n原因有两点：___、___。\n今天需要大家决定___。',
    },
    comparison: {
      metrics: [
        {
          id: 'conclusion-appearance',
          label: '核心结论出现',
          initial: 24_000,
          retry: 3_000,
          unit: 'ms',
        },
        {
          id: 'filler-count',
          label: '填充表达',
          initial: 11,
          retry: 2,
          unit: 'count',
        },
        {
          id: 'explicit-action-count',
          label: '明确行动',
          initial: 0,
          retry: 1,
          unit: 'count',
        },
        {
          id: 'duration',
          label: '总时长',
          initial: 74_000,
          retry: 42_000,
          unit: 'ms',
        },
      ],
      summary: '第二遍更早说出了决定，也补上了负责人和时间条件。变化与本轮“结论先行”焦点一致。',
    },
  }),
);
