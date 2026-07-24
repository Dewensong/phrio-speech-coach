import type {
  LiveAnnotation,
  LiveAnnotationType,
  SourceSpan,
  TranscriptSegment,
} from './live-practice';

export const LOCAL_ANNOTATION_ALGORITHM_VERSION = 'local-rules-1';

interface Rule {
  readonly type: LiveAnnotationType;
  readonly pattern: RegExp;
  readonly suggestion: string;
}

export interface LocalAnnotationContext {
  readonly previousFinalEndMs?: number;
  readonly expectedTaskTerms?: readonly string[];
  readonly isLastSegment?: boolean;
}

export interface FrozenTaskAnnotationContext {
  readonly requiredFields: readonly string[];
  readonly successConditions: readonly string[];
}

export interface TailAnnotationReconciliation {
  readonly upserts: readonly LiveAnnotation[];
  readonly withdrawals: readonly {
    readonly annotationId: string;
    readonly reason: 'tail_reanalysis_resolved' | 'tail_segment_replaced';
    readonly at: string;
  }[];
  readonly nextOrdinal: number;
}

const RULES: readonly Rule[] = [
  { type: 'filler', pattern: /嗯|呃|额|那个|就是说|然后/g, suggestion: '试试留一个安静停顿。' },
  { type: 'hedge', pattern: /可能|也许|大概|应该|好像|似乎|是不是/g, suggestion: '如果证据允许，直接说清判断边界。' },
  { type: 'vague', pattern: /很多|比较多|很快|差不多|后面|到时候|一点/g, suggestion: '换成具体对象、动作、数量或时间。' },
  { type: 'self_correction', pattern: /不是[^，。！？]{0,12}(?:是|应该是)|我重说|换句话说/g, suggestion: '先停一下，再完整说出修正后的句子。' },
];

interface TaskRequirementCue {
  readonly ids: readonly string[];
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * Conservative, inspectable lexical signals for fields frozen into current
 * production tasks. A field without a high-confidence cue is not guessed.
 */
const TASK_REQUIREMENT_CUES: readonly TaskRequirementCue[] = [
  { ids: ['main_point', 'claim'], label: '核心观点', pattern: /重点|核心|观点|主张|我认为|我想说明|最重要/u },
  { ids: ['position'], label: '明确立场', pattern: /立场|支持|反对|赞成|不赞成|应该|不应该/u },
  { ids: ['decision', 'conclusion'], label: '结论或决定', pattern: /决定|结论|建议|选择|倾向|优先|暂缓|冻结|支持|反对/u },
  { ids: ['direct_answer'], label: '直接回答', pattern: /我的回答|答案是|可以|不可以|会|不会|是|不是/u },
  { ids: ['reason', 'reasons', 'bridge', 'reasoning_bridge'], label: '理由或论证连接', pattern: /因为|原因|理由|所以|因此|这说明|意味着|依据/u },
  { ids: ['evidence', 'example'], label: '依据或例子', pattern: /例如|比如|数据|证据|事实|案例|根据|来源/u },
  { ids: ['next_action'], label: '下一步行动', pattern: /下一步|接下来|随后|今天|明天|本周|负责|完成|推进|执行/u },
  { ids: ['revisit_condition'], label: '重新评估条件', pattern: /重新评估|再判断|条件|触发|如果|当.+时/u },
  { ids: ['request', 'request_or_boundary'], label: '请求或边界', pattern: /请求|需要|希望|请|边界|不能|不接受|拒绝/u },
  { ids: ['risk'], label: '风险', pattern: /风险|隐患|可能导致|一旦/u },
  { ids: ['impact', 'both_impacts'], label: '影响', pattern: /影响|结果|后果|收益|损失/u },
  { ids: ['boundary'], label: '边界或限制', pattern: /边界|限制|前提|不包括|仅限|不能/u },
  { ids: ['tradeoff', 'weighing'], label: '取舍或权衡', pattern: /取舍|权衡|代价|成本|牺牲|更重要|优先/u },
  { ids: ['alternatives', 'options'], label: '替代方案或选项', pattern: /方案|选项|另一种|替代|一是|二是/u },
  { ids: ['comparison'], label: '比较', pattern: /相比|比较|相较|一方面|另一方面|共同|差异/u },
  { ids: ['source'], label: '信息来源', pattern: /来源|根据|数据|报告|访谈|记录/u },
  { ids: ['known'], label: '已知事实', pattern: /已知|事实|已经确认|数据显示|目前确定/u },
  { ids: ['hypothesis'], label: '假设或不确定性', pattern: /假设|推测|可能|尚不确定|待验证/u },
  { ids: ['user_problem'], label: '用户问题', pattern: /用户|听众|客户|问题|痛点|困扰|需求/u },
  { ids: ['value'], label: '价值', pattern: /价值|帮助|提升|降低|节省|改善|收益/u },
  { ids: ['definition'], label: '关键定义', pattern: /定义|是指|所谓|意思是|这里的.+指/u },
  { ids: ['counter_argument', 'steelman'], label: '对方观点', pattern: /对方|有人认为|反方|另一种观点|最强理由/u },
  { ids: ['rebuttal'], label: '回应或反驳', pattern: /反驳|回应|但是|然而|问题在于|即使/u },
  { ids: ['main_clash'], label: '主要争点', pattern: /争点|分歧|关键差异|核心冲突/u },
  { ids: ['sequence'], label: '事件顺序', pattern: /首先|然后|接着|随后|最后|先.+再/u },
  { ids: ['event'], label: '具体事件', pattern: /发生|当时|那次|事情|经历/u },
  { ids: ['meaning'], label: '事件意义', pattern: /意义|让我意识到|这说明|重要的是/u },
  { ids: ['key_points'], label: '关键信息', pattern: /第一|第二|首先|其次|重点|关键/u },
  { ids: ['summary'], label: '总结', pattern: /总结|概括|核心是|主要讲/u },
  { ids: ['closing'], label: '自然收束', pattern: /最后|总结|结论|所以|这就是|我的建议/u },
];

const STRUCTURE_SIGNAL = /首先|其次|最后|因为|所以|因此|结论|建议|决定|下一步|接下来|冻结|暂缓|优先|支持|反对/u;
const TAIL_TYPES = new Set<LiveAnnotationType>(['structure', 'task_gap']);

function spanFor(text: string, match: RegExpExecArray): SourceSpan {
  return { start: match.index, end: match.index + match[0].length, text: text.slice(match.index, match.index + match[0].length) };
}

function repeatedSpan(text: string): SourceSpan | null {
  const adjacent = /([\u4e00-\u9fff]{2,4})\1/.exec(text);
  if (adjacent) {
    const start = adjacent.index + adjacent[1].length;
    return { start, end: start + adjacent[1].length, text: adjacent[1] };
  }
  const chunks = text.split(/[，。！？；\s]+/).filter((chunk) => chunk.length >= 2);
  for (const chunk of chunks) {
    const first = text.indexOf(chunk);
    const second = text.indexOf(chunk, first + chunk.length);
    if (second >= 0) return { start: second, end: second + chunk.length, text: chunk };
  }
  const words: string[] = text.match(/[\u4e00-\u9fff]{2,4}/g) ?? [];
  const duplicate = words.find((word, index) => words.indexOf(word) !== index);
  if (!duplicate) return null;
  const first = text.indexOf(duplicate);
  const second = text.indexOf(duplicate, first + duplicate.length);
  return second < 0 ? null : { start: second, end: second + duplicate.length, text: duplicate };
}

function annotation(input: {
  readonly ordinal: number;
  readonly segment: TranscriptSegment;
  readonly type: LiveAnnotationType;
  readonly span: SourceSpan | null;
  readonly suggestion: string;
  readonly evidence?: string;
}): LiveAnnotation {
  const now = input.segment.finalizedAt ?? input.segment.emittedAt;
  return {
    id: `${input.segment.id}-${input.type}-${input.ordinal}`,
    displayId: `O${input.ordinal}`,
    segmentId: input.segment.id,
    type: input.type,
    sourceSpan: input.span,
    evidence: input.evidence ?? (input.span ? `原句“${input.span.text}”` : '本句时间与结构信号'),
    suggestion: input.suggestion,
    source: input.type === 'long_pause' || input.type === 'speech_rate' ? 'local_metric' : 'local_rule',
    lifecycle: 'provisional',
    algorithmVersion: LOCAL_ANNOTATION_ALGORITHM_VERSION,
    createdAt: now,
    updatedAt: now,
    withdrawnReason: null,
  };
}

/** Final-only deterministic analysis. Partial text is deliberately rejected. */
export function annotateFinalSegment(
  segment: TranscriptSegment,
  startingOrdinal = 1,
  context: LocalAnnotationContext = {},
): readonly LiveAnnotation[] {
  if (!segment.isFinal) throw new Error('ANNOTATIONS_REQUIRE_FINAL_SEGMENT');
  const results: LiveAnnotation[] = [];
  let ordinal = startingOrdinal;
  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let match = pattern.exec(segment.text); match; match = pattern.exec(segment.text)) {
      results.push(annotation({ ordinal, segment, type: rule.type, span: spanFor(segment.text, match), suggestion: rule.suggestion }));
      ordinal += 1;
    }
  }
  const repeated = repeatedSpan(segment.text);
  if (repeated) {
    results.push(annotation({ ordinal, segment, type: 'repetition', span: repeated, suggestion: '保留信息更具体的那一次。' }));
    ordinal += 1;
  }
  const pauseMs = context.previousFinalEndMs === undefined ? 0 : segment.startMs - context.previousFinalEndMs;
  if (pauseMs >= 2_500) {
    results.push(annotation({ ordinal, segment, type: 'long_pause', span: null, evidence: `句前停顿 ${Math.round(pauseMs / 100) / 10} 秒`, suggestion: '停顿可以保留；若不是刻意留白，先说结论再停。' }));
    ordinal += 1;
  }
  const durationSeconds = Math.max((segment.endMs - segment.startMs) / 1_000, 0.1);
  const charactersPerSecond = segment.text.replace(/\s|[，。！？；：、“”]/g, '').length / durationSeconds;
  if (charactersPerSecond > 6.5 || charactersPerSecond < 1.5) {
    results.push(annotation({ ordinal, segment, type: 'speech_rate', span: null, evidence: `本句语速约 ${charactersPerSecond.toFixed(1)} 字/秒`, suggestion: charactersPerSecond > 6.5 ? '把关键词前后的节奏放慢。' : '缩短停顿，让句意连续落地。' }));
    ordinal += 1;
  }
  if (context.isLastSegment && !/(首先|其次|最后|因为|所以|结论|建议|决定|下一步)/.test(segment.text)) {
    results.push(annotation({ ordinal, segment, type: 'structure', span: null, evidence: '收束句未出现明确的结论或下一步信号', suggestion: '用“我的建议是…”或“下一步由…”明确收束。' }));
    ordinal += 1;
  }
  const missingTerms = context.expectedTaskTerms?.filter((term) => !segment.text.includes(term)) ?? [];
  if (context.isLastSegment && missingTerms.length > 0) {
    results.push(annotation({ ordinal, segment, type: 'task_gap', span: null, evidence: `任务要求尚未覆盖：${missingTerms.join('、')}`, suggestion: '补齐任务要求中的对象、决定或下一步。' }));
  }
  return results;
}

interface DesiredTailAnnotation {
  readonly type: 'structure' | 'task_gap';
  readonly evidence: string;
  readonly suggestion: string;
}

function boundedCopy(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 499)}…`;
}

function frozenRequirementGaps(
  task: FrozenTaskAnnotationContext,
  transcript: string,
): readonly string[] {
  const labels = new Set<string>();
  for (const field of task.requiredFields) {
    const cue = TASK_REQUIREMENT_CUES.find((candidate) => candidate.ids.includes(field));
    if (cue && !cue.pattern.test(transcript)) labels.add(cue.label);
  }
  return [...labels];
}

function displayOrdinal(displayId: string): number {
  const value = Number.parseInt(displayId.slice(1), 10);
  return Number.isFinite(value) ? value : 0;
}

function needsTailUpsert(
  existing: LiveAnnotation,
  desired: DesiredTailAnnotation,
  tailSegmentId: string,
): boolean {
  return existing.segmentId !== tailSegmentId
    || existing.type !== desired.type
    || existing.sourceSpan !== null
    || existing.evidence !== desired.evidence
    || existing.suggestion !== desired.suggestion
    || existing.source !== 'local_rule'
    || existing.lifecycle !== 'confirmed'
    || existing.algorithmVersion !== LOCAL_ANNOTATION_ALGORITHM_VERSION
    || existing.withdrawnReason !== null;
}

/**
 * Reconciles the two whole-attempt signals only after the ASR tail is final.
 * Stable evidence ids are retained when the same tail is re-analysed, while a
 * replacement tail receives new ids and leaves the prior evidence as history.
 */
export function reconcileFinalTailAnnotations(input: {
  readonly finalSegments: readonly TranscriptSegment[];
  readonly existingAnnotations: readonly LiveAnnotation[];
  readonly startingOrdinal: number;
  readonly task: FrozenTaskAnnotationContext | null;
}): TailAnnotationReconciliation {
  if (input.finalSegments.some((segment) => !segment.isFinal)) {
    throw new Error('TAIL_ANNOTATIONS_REQUIRE_FINAL_SEGMENTS');
  }

  const uniqueFinals = new Map<string, TranscriptSegment>();
  for (const segment of input.finalSegments) {
    if (!uniqueFinals.has(segment.id)) uniqueFinals.set(segment.id, segment);
  }
  const orderedFinals = [...uniqueFinals.values()].sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  const tail = orderedFinals.at(-1);
  if (!tail) {
    return { upserts: [], withdrawals: [], nextOrdinal: input.startingOrdinal };
  }

  const fullTranscript = orderedFinals.map((segment) => segment.text).join('\n');
  const desired = new Map<LiveAnnotationType, DesiredTailAnnotation>();
  if (!STRUCTURE_SIGNAL.test(tail.text)) {
    desired.set('structure', {
      type: 'structure',
      evidence: '尾句未出现明确的结论、理由或下一步信号',
      suggestion: '用“我的建议是…”或“下一步由…”明确收束。',
    });
  }

  if (input.task) {
    const gaps = frozenRequirementGaps(input.task, fullTranscript);
    if (gaps.length > 0) {
      const frozenConditions = input.task.successConditions.length > 0
        ? `；冻结成功条件：${input.task.successConditions.join('、')}`
        : '';
      desired.set('task_gap', {
        type: 'task_gap',
        evidence: boundedCopy(`任务要求尚未覆盖：${gaps.join('、')}${frozenConditions}`),
        suggestion: boundedCopy(`补齐${gaps.join('、')}，再按本轮冻结任务口径收束。`),
      });
    }
  }

  const tailAnnotations = input.existingAnnotations.filter((item) => TAIL_TYPES.has(item.type));
  const highestExistingOrdinal = input.existingAnnotations.reduce(
    (highest, item) => Math.max(highest, displayOrdinal(item.displayId)),
    0,
  );
  let ordinal = Math.max(input.startingOrdinal, highestExistingOrdinal + 1);
  const upserts: LiveAnnotation[] = [];
  const withdrawals: TailAnnotationReconciliation['withdrawals'][number][] = [];
  const at = tail.finalizedAt ?? tail.emittedAt;

  for (const type of ['structure', 'task_gap'] as const) {
    const expected = desired.get(type);
    const candidates = tailAnnotations.filter((item) => item.type === type);
    if (!expected) {
      for (const item of candidates) {
        if (item.lifecycle !== 'withdrawn') {
          withdrawals.push({
            annotationId: item.id,
            reason: 'tail_reanalysis_resolved',
            at,
          });
        }
      }
      continue;
    }

    const anchor = candidates.find(
      (item) => item.segmentId === tail.id && item.lifecycle !== 'withdrawn',
    );

    for (const item of candidates) {
      if (item.id === anchor?.id || item.lifecycle === 'withdrawn') continue;
      withdrawals.push({
        annotationId: item.id,
        reason: item.segmentId === tail.id
          ? 'tail_reanalysis_resolved'
          : 'tail_segment_replaced',
        at,
      });
    }

    if (!anchor) {
      upserts.push({
        ...annotation({
          ordinal,
          segment: tail,
          type,
          span: null,
          evidence: expected.evidence,
          suggestion: expected.suggestion,
        }),
        lifecycle: 'confirmed',
      });
      ordinal += 1;
      continue;
    }

    if (needsTailUpsert(anchor, expected, tail.id)) {
      upserts.push({
        ...anchor,
        segmentId: tail.id,
        type,
        sourceSpan: null,
        evidence: expected.evidence,
        suggestion: expected.suggestion,
        source: 'local_rule',
        lifecycle: 'confirmed',
        algorithmVersion: LOCAL_ANNOTATION_ALGORITHM_VERSION,
        updatedAt: at,
        withdrawnReason: null,
      });
    }
  }

  return { upserts, withdrawals, nextOrdinal: ordinal };
}

export function confirmOrWithdrawAnnotations(input: {
  readonly segment: TranscriptSegment;
  readonly annotations: readonly LiveAnnotation[];
  readonly at: string;
}): readonly LiveAnnotation[] {
  if (!input.segment.isFinal) {
    throw new Error('ANNOTATION_CONFIRMATION_REQUIRES_FINAL_SEGMENT');
  }
  return input.annotations.map((item) => {
    if (item.segmentId !== input.segment.id || item.lifecycle === 'withdrawn') return item;
    const stillMatches = item.sourceSpan === null
      || input.segment.text.slice(item.sourceSpan.start, item.sourceSpan.end) === item.sourceSpan.text;
    if (stillMatches && item.lifecycle === 'confirmed' && item.withdrawnReason === null) return item;
    return {
      ...item,
      lifecycle: stillMatches ? ('confirmed' as const) : ('withdrawn' as const),
      updatedAt: input.at,
      withdrawnReason: stillMatches ? null : 'transcript_correction_changed_source',
    };
  });
}
