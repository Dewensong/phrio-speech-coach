import { ModePackSchema, TaskTemplateSchema, type ModePack, type TaskTemplate } from './domain';
import { COMMUNITY_TASK_PACKS } from './community-task-pack';

export const CLEAR_EXPRESSION_MODE_ID = 'clear-expression' as const;
export const DECISION_ALIGNMENT_MODE_ID = 'decision-alignment' as const;
export const ARGUMENT_REBUTTAL_MODE_ID = 'argument-rebuttal' as const;

export const GATE_C_PM_TASK_ID = 'freeze-new-requirements' as const;

const CONTENT_VERSION = '1.0.0-content.1';

interface TaskDefinition {
  readonly id: string;
  readonly modeId: typeof CLEAR_EXPRESSION_MODE_ID | typeof DECISION_ALIGNMENT_MODE_ID | typeof ARGUMENT_REBUTTAL_MODE_ID;
  readonly title: string;
  readonly prompt: string;
  readonly description: string;
  readonly durationSeconds: number;
  readonly audience: string;
  readonly objective: string;
  readonly scenario: string;
  readonly background?: string;
  readonly sourceMaterial?: string;
  readonly counterArgument?: string;
  readonly constraints: readonly string[];
  readonly successConditions: readonly string[];
  readonly requiredFields: readonly string[];
  readonly focusCriteria: readonly string[];
}

function buildTask(
  definition: TaskDefinition,
  drillsByCriterion: Readonly<Record<string, readonly string[]>>,
  version = CONTENT_VERSION,
) {
  const fallbackDrillIds = definition.focusCriteria.flatMap(
    (criterionId) => drillsByCriterion[criterionId] ?? [],
  );
  return {
    id: definition.id,
    version,
    modeId: definition.modeId,
    title: definition.title,
    prompt: definition.prompt,
    description: definition.description,
    recommendedDurationSeconds: definition.durationSeconds,
    context: {
      audience: definition.audience,
      objective: definition.objective,
      background: definition.background ?? '',
      sourceMaterial: definition.sourceMaterial ?? '',
      counterArgument: definition.counterArgument ?? '',
      roleContext: `场景：${definition.scenario}`,
    },
    constraints: [...definition.constraints],
    successConditions: [...definition.successConditions],
    requiredFields: [...definition.requiredFields],
    focusCandidateCriterionIds: [...definition.focusCriteria],
    fallbackDrillIds,
    focusDrillMappings: definition.focusCriteria.map((criterionId) => ({
      criterionId,
      drillIds: [...(drillsByCriterion[criterionId] ?? [])],
    })),
    developmentFixture: false,
  };
}

function communityTasksForMode(
  modeId: TaskDefinition['modeId'],
  drillsByCriterion: Readonly<Record<string, readonly string[]>>,
) {
  return COMMUNITY_TASK_PACKS.flatMap((pack) => pack.tasks
    .filter((task) => task.modeId === modeId)
    .map((task) => {
      for (const criterionId of task.focusCriteria) {
        if (!(criterionId in drillsByCriterion)) {
          throw new Error(
            `INVALID_COMMUNITY_TASK_PACK:${pack.id}.${task.id}:`
            + `unknown focus criterion ${criterionId} for ${modeId}`,
          );
        }
      }
      return buildTask({
        ...task,
        id: `community.${pack.id}.${task.id}`,
      }, drillsByCriterion, pack.version);
    }));
}

function indexDrills(
  drills: readonly { readonly id: string; readonly criterionId: string }[],
): Readonly<Record<string, readonly string[]>> {
  const entries = new Map<string, string[]>();
  for (const drill of drills) {
    entries.set(
      drill.criterionId,
      [...(entries.get(drill.criterionId) ?? []), drill.id],
    );
  }
  return Object.fromEntries(entries);
}

const clearCriteria = [
  {
    id: 'main-point-early', label: '主旨尽早出现',
    description: '听众能在表达开头较早理解本次要说明的核心观点、目的或请求。',
    evidenceKinds: ['quote', 'deterministic_metric'], offlineEligible: true,
    comparisonDimension: 'task-coverage-gaps',
  },
  {
    id: 'logical-order', label: '顺序与衔接清楚',
    description: '主要信息形成可辨认的顺序，并用清楚的关系词连接。',
    evidenceKinds: ['quote', 'task_requirement_gap'], offlineEligible: true,
    comparisonDimension: 'structure-flags',
  },
  {
    id: 'concrete-support', label: '具体且完整',
    description: '关键观点有必要背景、事实或例子，不大量依赖模糊指代。',
    evidenceKinds: ['quote', 'task_requirement_gap'], offlineEligible: false,
    comparisonDimension: 'vague-language',
  },
  {
    id: 'audience-language', label: '适配听众',
    description: '术语得到解释，代词指向明确，听众不需要补足未知背景。',
    evidenceKinds: ['quote', 'task_requirement_gap'], offlineEligible: false,
    comparisonDimension: 'task-coverage-gaps',
  },
  {
    id: 'concise-delivery', label: '简洁不绕行',
    description: '重复、铺垫与自我修正不妨碍听众提取主旨。',
    evidenceKinds: ['quote', 'deterministic_metric'], offlineEligible: true,
    comparisonDimension: 'delivery-friction',
  },
  {
    id: 'fluent-pacing', label: '停顿与节奏支持理解',
    description: '在可靠音频证据存在时，停顿和语速能帮助听众跟上内容。',
    evidenceKinds: ['audio_span', 'deterministic_metric'], offlineEligible: true,
    comparisonDimension: 'pacing-flags',
  },
].map((criterion) => ({ ...criterion, developmentFixture: false }));

const clearDrills = [
  ['main-point-one-line', 'main-point-early', '一句主旨', '先回答“我希望听众记住什么”，再开始展开。', '我最希望你记住的是___。', '复讲开头先出现一个明确且可复述的主旨。'],
  ['main-point-five-seconds', 'main-point-early', '五秒开场', '把背景移到主旨之后，用五秒说清目的。', '这次我想讲清楚___。', '开口五秒内出现观点、目的或请求。'],
  ['three-part-outline', 'logical-order', '三格骨架', '只保留观点、理由和例子三格，再按顺序口述。', '我的观点是___。主要原因是___。一个具体例子是___。', '复讲能辨认出观点、理由和例子的顺序。'],
  ['signpost-links', 'logical-order', '关系词路标', '为两段信息补上因果、转折或递进关系词。', '先说___；更重要的是___；所以___。', '各部分关系无需听众自行猜测。'],
  ['specific-replacement', 'concrete-support', '具体化替换', '把一个模糊词替换成人物、动作、数字或场景。', '把“这个事情”改成“___在___前完成___”。', '复讲至少包含一个可核对的具体对象或动作。'],
  ['one-example', 'concrete-support', '一个例子够用', '为核心观点只补一个最能说明问题的例子。', '例如，在___时，发生了___，这说明___。', '例子与主旨直接相关且不引出新支线。'],
  ['plain-language', 'audience-language', '白话翻译', '把一个术语改写成不了解领域的人也能听懂的话。', '这里的“___”指的是___。', '复讲中的关键术语都有简短解释。'],
  ['audience-context', 'audience-language', '补一层背景', '只补听众理解主旨所需的一层背景。', '先补充一个背景：___。在这个前提下，___。', '听众无需知道内部上下文也能理解结论。'],
  ['compress-thirty', 'concise-delivery', '压缩三成', '保留主旨和一个依据，删除不改变意思的铺垫。', '主旨：___。依据：___。其余删去。', '复讲更短但没有丢失核心依据。'],
  ['remove-fillers', 'concise-delivery', '删掉口头垫词', '把“就是、然后、可能”等无信息表达换成停顿。', '说完一句，停半拍，再继续下一句。', '垫词减少且句意保持完整。'],
  ['pause-instead', 'fluent-pacing', '停顿替代填充词', '在段落边界主动停顿，不用口癖占位。', '主旨___（停顿）理由一___（停顿）理由二___。', '停顿出现在信息边界而非句子中间。'],
  ['pace-chunks', 'fluent-pacing', '短句分块', '把一个长句拆成三段可呼吸的短句。', '结论___。原因___。例子___。', '复讲每个信息块都能一口说完。'],
].map(([id, criterionId, title, instruction, template, successCondition]) => ({
  id, criterionId, title, durationSeconds: 60, instruction, template,
  successCondition, developmentFixture: false,
}));

const clearDrillsByCriterion = indexDrills(clearDrills);

const clearTasks: readonly TaskDefinition[] = [
  {
    id: 'one-sentence-core', modeId: CLEAR_EXPRESSION_MODE_ID,
    title: '30 秒一句话讲清核心观点', prompt: '用 30 秒讲清你今天最想让对方记住的一件事。',
    description: '在短时间内先给主旨，再补一个必要说明。', durationSeconds: 30,
    audience: '不了解完整背景的普通听众', objective: '让听众能复述本次核心观点', scenario: '日常沟通',
    constraints: ['只讲一个核心观点'], successConditions: ['开头出现主旨', '不引入无关支线'],
    requiredFields: ['main_point'], focusCriteria: ['main-point-early', 'concise-delivery'],
  },
  {
    id: 'opinion-with-reason', modeId: CLEAR_EXPRESSION_MODE_ID,
    title: '表达观点并给出理由', prompt: '用 60 秒表达一个你最近形成的观点，并给出一个具体理由。',
    description: '让观点与支持它的依据直接相连。', durationSeconds: 60,
    audience: '愿意了解你观点的同事或朋友', objective: '让听众理解观点以及你为什么这样想', scenario: '观点分享',
    constraints: ['观点与理由分开说清'], successConditions: ['观点明确', '至少一个相关理由'],
    requiredFields: ['main_point', 'reason'], focusCriteria: ['main-point-early', 'logical-order'],
  },
  {
    id: 'explain-concept-plainly', modeId: CLEAR_EXPRESSION_MODE_ID,
    title: '向非专业听众解释一个概念', prompt: '用 90 秒向非专业听众解释一个你熟悉的概念。',
    description: '不依赖内部术语，让第一次接触的人也能理解。', durationSeconds: 90,
    audience: '第一次接触该领域的听众', objective: '让听众理解概念的含义和用途', scenario: '知识解释',
    constraints: ['解释必要术语', '给出一个例子'], successConditions: ['白话定义清楚', '例子与定义对应'],
    requiredFields: ['definition', 'example'], focusCriteria: ['audience-language', 'concrete-support'],
  },
  {
    id: 'retell-an-experience', modeId: CLEAR_EXPRESSION_MODE_ID,
    title: '复述一次经历或事件', prompt: '用 120 秒复述一次最近让你印象深刻的经历。',
    description: '按清楚顺序讲出发生了什么以及为什么重要。', durationSeconds: 120,
    audience: '没有参与这件事的朋友', objective: '让听众跟上事件并理解它的意义', scenario: '事件叙述',
    constraints: ['保留必要人物和时间顺序'], successConditions: ['顺序清楚', '结尾说明意义'],
    requiredFields: ['event', 'sequence', 'meaning'], focusCriteria: ['logical-order', 'concrete-support'],
  },
  {
    id: 'summarize-material', modeId: CLEAR_EXPRESSION_MODE_ID,
    title: '总结一段给定材料', prompt: '用 60 秒总结一段你刚读过或听过的材料。',
    description: '提炼主旨和两个关键信息，不复述全部细节。', durationSeconds: 60,
    audience: '尚未看过原材料的听众', objective: '让听众迅速掌握材料重点', scenario: '学习汇报',
    sourceMaterial: '由用户在开始前自行阅读或粘贴的短材料。',
    constraints: ['不补充材料外事实', '最多两个关键信息'], successConditions: ['主旨准确可辨', '信息有清楚层级'],
    requiredFields: ['summary', 'key_points'], focusCriteria: ['main-point-early', 'concise-delivery'],
  },
  {
    id: 'compare-two-options', modeId: CLEAR_EXPRESSION_MODE_ID,
    title: '比较两个选择并给出结论', prompt: '用 90 秒比较两个真实选择，并说明你更倾向哪一个。',
    description: '使用同一比较维度，给出清楚结论。', durationSeconds: 90,
    audience: '会参考你意见的人', objective: '让听众理解两项差异与最终倾向', scenario: '选择建议',
    constraints: ['使用同一比较维度', '明确最终倾向'], successConditions: ['两项差异清楚', '结论有依据'],
    requiredFields: ['options', 'comparison', 'conclusion'], focusCriteria: ['logical-order', 'concrete-support'],
  },
  {
    id: 'request-or-refusal', modeId: CLEAR_EXPRESSION_MODE_ID,
    title: '提出请求或完成一次拒绝', prompt: '用 60 秒提出一个真实请求，或礼貌拒绝一个不合适的安排。',
    description: '把诉求、原因和可行边界直接说清。', durationSeconds: 60,
    audience: '与你有真实协作关系的人', objective: '让对方知道你希望采取什么行动', scenario: '人际沟通',
    constraints: ['表达具体动作', '避免过度铺垫'], successConditions: ['请求或边界明确', '语气适配听众'],
    requiredFields: ['request_or_boundary', 'reason'], focusCriteria: ['main-point-early', 'audience-language'],
  },
  {
    id: 'impromptu-topic', modeId: CLEAR_EXPRESSION_MODE_ID,
    title: '随机主题即兴表达', prompt: '任选此刻想到的一个主题，用 90 秒完成一次有开头、展开和收束的即兴表达。',
    description: '在无准备条件下保持主旨、顺序和节奏。', durationSeconds: 90,
    audience: '普通听众', objective: '让听众能跟上并记住一个重点', scenario: '即兴表达',
    constraints: ['只围绕一个主题'], successConditions: ['有明确主旨', '有自然收束'],
    requiredFields: ['main_point', 'closing'], focusCriteria: ['logical-order', 'fluent-pacing'],
  },
];

const clearExpressionMode = ModePackSchema.parse({
  id: CLEAR_EXPRESSION_MODE_ID,
  version: CONTENT_VERSION,
  name: '清晰表达 · 通用',
  abilityName: '清晰表达',
  typicalRole: '通用',
  description: '在日常、学习和工作表达中做到听得懂、记得住、知道重点。',
  developmentFixture: false,
  criteria: clearCriteria,
  drills: clearDrills,
  tasks: [
    ...clearTasks.map((task) => buildTask(task, clearDrillsByCriterion as Readonly<Record<string, readonly string[]>>)),
    ...communityTasksForMode(CLEAR_EXPRESSION_MODE_ID, clearDrillsByCriterion),
  ],
});

const decisionCriteria = [
  ['decision-request', '结论、决策或请求', '听众明确知道要决定、同意或执行什么。', ['quote', 'task_requirement_gap'], false, 'task-structure-gaps'],
  ['user-value', '问题与用户价值', '说明谁遇到什么问题，以及为什么现在值得处理。', ['quote', 'task_requirement_gap'], false, 'task-coverage-gaps'],
  ['source-certainty', '来源与不确定性标注', '明确区分已知事实、来源、假设和个人判断。', ['quote', 'task_requirement_gap'], false, 'task-coverage-gaps'],
  ['tradeoff-priority', '方案、取舍与优先级', '说明主要替代方案以及选择当前方案的代价。', ['quote', 'task_requirement_gap'], false, 'task-coverage-gaps'],
  ['risk-action', '风险与行动闭环', '给出风险、触发信号、下一步、责任主体或时间条件。', ['quote', 'task_requirement_gap'], false, 'task-structure-gaps'],
  ['stakeholder-fit', '利益相关方适配', '细节和术语适合已声明听众，并回应其核心关切。', ['quote', 'task_requirement_gap'], false, 'task-coverage-gaps'],
].map(([id, label, description, evidenceKinds, offlineEligible, comparisonDimension]) => ({
  id, label, description, evidenceKinds, offlineEligible, comparisonDimension, developmentFixture: false,
}));

const decisionDrills = [
  ['decision-first-three-lines', 'decision-request', '决策先行三句', '先说决定，再给两个原因，最后明确谁要做什么。', '我的建议是___。原因有两点：___、___。今天需要___决定___。', '开口五秒内出现决定，结尾有明确动作。'],
  ['single-decision-ask', 'decision-request', '一个决策请求', '把多个诉求压缩成一个今天必须确认的问题。', '今天只需要确认一件事：___。', '听众能用一句话复述需要决定的事项。'],
  ['user-problem-now', 'user-value', '用户—问题—现在', '依次说清用户、阻碍以及此刻处理的原因。', '___用户在___时遇到___；现在处理是因为___。', '问题与当前优先级之间有直接联系。'],
  ['value-outcome', 'user-value', '价值落到结果', '把抽象价值改成用户可观察的结果。', '完成后，___用户可以更容易地___。', '价值描述包含对象和行为变化。'],
  ['fact-hypothesis-judgment', 'source-certainty', '事实/假设/判断拆分', '把原句分别标成事实、假设和判断后重新表达。', '已知的是___；我们假设___；我的判断是___。', '三种信息不再混成同一确定语气。'],
  ['source-label', 'source-certainty', '一句来源标注', '为关键数字或反馈补上来源与时间范围。', '根据___在___期间的数据/反馈，___。', '重要依据有来源或明确标为未知。'],
  ['tradeoff-triangle', 'tradeoff-priority', '取舍三角', '用户价值、实现成本和风险各说一句。', '价值是___；成本是___；主要风险是___；所以选择___。', '结论同时说明得到什么和放弃什么。'],
  ['why-not-alternative', 'tradeoff-priority', '为什么不选另一个', '主动说明一个替代方案以及暂不选择它的原因。', '另一个方案是___，但当前不选，因为___。', '替代方案被公平描述且取舍可理解。'],
  ['risk-loop', 'risk-action', '风险闭环', '把风险、触发信号、负责人和动作连成一条。', '风险是___；若出现___，由___在___前执行___。', '风险后面有可执行的响应条件。'],
  ['next-step-owner', 'risk-action', '下一步压实', '把“后面推进”替换为责任人、动作和时间。', '由___在___前完成___，并用___确认结果。', '下一步包含责任人、动作和时间条件。'],
  ['three-audiences', 'stakeholder-fit', '三类听众改写', '分别用管理者、研发和客户关心的结果重讲一句。', '对___听众，我先说___，再补___。', '细节层级与当前听众的决策需要匹配。'],
  ['stakeholder-question', 'stakeholder-fit', '先答听众的问题', '先说听众最可能问的一个问题及答案。', '你最关心的是___；我的回答是___。', '开头直接回应听众核心关切。'],
].map(([id, criterionId, title, instruction, template, successCondition]) => ({ id, criterionId, title, durationSeconds: 60, instruction, template, successCondition, developmentFixture: false }));

const decisionDrillsByCriterion = indexDrills(decisionDrills);

const decisionTasks: readonly TaskDefinition[] = [
  {
    id: 'feature-proposal', modeId: DECISION_ALIGNMENT_MODE_ID, title: '提出一个功能建议',
    prompt: '用 90 秒向团队提出一个功能建议，并说明为什么现在值得做。',
    description: '把用户问题、建议和决策请求连在一起。', durationSeconds: 90,
    audience: '产品、研发与设计负责人', objective: '推动团队决定是否进入方案评估', scenario: '功能提案',
    constraints: ['先说建议', '说明用户问题'], successConditions: ['建议明确', '用户价值可理解', '有下一步请求'],
    requiredFields: ['decision', 'user_problem', 'next_action'], focusCriteria: ['decision-request', 'user-value'],
  },
  {
    id: 'defer-requirement', modeId: DECISION_ALIGNMENT_MODE_ID, title: '解释为什么暂时不做某个需求',
    prompt: '用 90 秒解释为什么暂时不做一个需求，并给出重新评估的条件。',
    description: '不回避需求价值，同时说明当前取舍和恢复条件。', durationSeconds: 90,
    audience: '需求提出方与交付团队', objective: '就暂缓范围与后续条件达成一致', scenario: '需求取舍',
    counterArgument: '需求提出方认为它很紧急。', constraints: ['承认合理诉求', '说明当前取舍'],
    successConditions: ['暂缓结论明确', '替代方案或重评条件清楚'], requiredFields: ['decision', 'tradeoff', 'revisit_condition'],
    focusCriteria: ['tradeoff-priority', 'stakeholder-fit'],
  },
  {
    id: 'prioritize-two-requirements', modeId: DECISION_ALIGNMENT_MODE_ID, title: '在两个需求之间做优先级选择',
    prompt: '用 120 秒在两个真实需求之间做优先级选择，并说明代价。',
    description: '使用一致标准比较，明确得到什么、放弃什么。', durationSeconds: 120,
    audience: '业务与研发负责人', objective: '推动团队确认本阶段优先项', scenario: '优先级评审',
    constraints: ['使用同一比较标准', '说明放弃项代价'], successConditions: ['优先结论清楚', '取舍依据完整'],
    requiredFields: ['options', 'tradeoff', 'decision'], focusCriteria: ['tradeoff-priority', 'decision-request'],
  },
  {
    id: GATE_C_PM_TASK_ID, modeId: DECISION_ALIGNMENT_MODE_ID, title: '说明为什么本周应冻结新增需求',
    prompt: '向团队说明为什么本周应冻结新增需求，并明确下一步。',
    description: '在已有交付和阻塞项之间推动一次清晰决定。', durationSeconds: 90,
    audience: '研发与业务负责人', objective: '在限制中推动一次清晰决定', scenario: '进展与风险同步',
    background: '登录改版进入联调，模型评估仍有阻塞项。', counterArgument: '业务侧仍有几个紧急的新需求。',
    constraints: ['先给决定', '说明两个理由', '明确责任人和时间条件'],
    successConditions: ['核心结论尽早出现', '给出理由', '明确下一步行动'],
    requiredFields: ['decision', 'reasons', 'next_action'], focusCriteria: ['decision-request', 'risk-action'],
  },
  {
    id: 'explain-metric-anomaly', modeId: DECISION_ALIGNMENT_MODE_ID, title: '解释一个指标异常',
    prompt: '用 120 秒解释一个指标异常：已知什么、不确定什么、下一步如何验证。',
    description: '区分事实、假设和判断，不把相关性说成因果。', durationSeconds: 120,
    audience: '关心业务结果的管理者与分析同事', objective: '对异常形成可信的验证计划', scenario: '数据复盘',
    constraints: ['标注来源', '区分事实与假设'], successConditions: ['已知与未知清楚', '验证动作明确'],
    requiredFields: ['source', 'known', 'hypothesis', 'next_action'], focusCriteria: ['source-certainty', 'risk-action'],
  },
  {
    id: 'solution-decision', modeId: DECISION_ALIGNMENT_MODE_ID, title: '陈述一个方案决策',
    prompt: '用 180 秒陈述一个方案决策，覆盖选择、取舍、风险和落地计划。',
    description: '用可复核结构完成一次完整决策说明。', durationSeconds: 180,
    audience: '需要评审方案的跨职能团队', objective: '获得方案方向与执行计划的确认', scenario: '方案评审',
    constraints: ['说明替代方案', '说明主要风险'], successConditions: ['决策明确', '取舍完整', '行动闭环'],
    requiredFields: ['decision', 'alternatives', 'tradeoff', 'risk', 'next_action'], focusCriteria: ['tradeoff-priority', 'risk-action'],
  },
  {
    id: 'escalate-project-risk', modeId: DECISION_ALIGNMENT_MODE_ID, title: '升级一个项目风险',
    prompt: '用 60 秒升级一个项目风险，并明确需要的支持。',
    description: '让决策者快速理解影响、触发信号和支持请求。', durationSeconds: 60,
    audience: '有资源或决策权的负责人', objective: '及时获得一个具体支持或决策', scenario: '风险升级',
    constraints: ['不只描述焦虑', '提出具体支持请求'], successConditions: ['风险及影响明确', '支持请求明确'],
    requiredFields: ['risk', 'impact', 'request'], focusCriteria: ['risk-action', 'stakeholder-fit'],
  },
  {
    id: 'demo-ai-product-value', modeId: DECISION_ALIGNMENT_MODE_ID, title: '演示 AI 产品并说明价值',
    prompt: '用 120 秒演示一个 AI 产品能力，并说明它对当前听众的价值与边界。',
    description: '从真实任务出发，不把功能列表当成价值。', durationSeconds: 120,
    audience: '第一次了解该产品的业务负责人', objective: '让听众决定是否进入下一步试用', scenario: '产品演示',
    constraints: ['从用户任务出发', '说明一个已知边界'], successConditions: ['价值对应听众', '边界与下一步清楚'],
    requiredFields: ['user_problem', 'value', 'boundary', 'next_action'], focusCriteria: ['user-value', 'stakeholder-fit'],
  },
];

const decisionAlignmentMode = ModePackSchema.parse({
  id: DECISION_ALIGNMENT_MODE_ID, version: CONTENT_VERSION,
  name: '决策与对齐 · 产品经理', abilityName: '决策与对齐', typicalRole: '产品经理',
  description: '让一次表达帮助听众理解问题、作出决策或采取下一步行动。',
  developmentFixture: false, criteria: decisionCriteria, drills: decisionDrills,
  tasks: [
    ...decisionTasks.map((task) => buildTask(task, decisionDrillsByCriterion)),
    ...communityTasksForMode(DECISION_ALIGNMENT_MODE_ID, decisionDrillsByCriterion),
  ],
});

const argumentCriteria = [
  ['position-boundary', '立场、命题与定义', '立场明确，关键概念和讨论边界足以支撑后续论证。', 'task-coverage-gaps'],
  ['claim-reason', '论点链条完整', '主张、理由和结论之间形成可解释的链条。', 'task-structure-gaps'],
  ['claim-evidence-bridge', '论证桥完整', '明确说明依据为什么能够支持当前主张，不跳过关键前提。', 'task-coverage-gaps'],
  ['rebuttal-target', '争点识别与反驳', '准确复述对方核心论点，并回应关键前提或影响。', 'task-coverage-gaps'],
  ['impact-weighing', '比较与影响权衡', '说明双方差异以及为什么某项影响更重要、更可能或更不可逆。', 'task-coverage-gaps'],
  ['strategic-signposting', '战略结构与时间控制', '使用清楚路标，在时限内把时间留给主要争点。', 'structure-flags'],
].map(([id, label, description, comparisonDimension]) => ({
  id, label, description,
  evidenceKinds: ['quote', 'task_requirement_gap'], offlineEligible: false,
  comparisonDimension,
  developmentFixture: false,
}));

const argumentDrills = [
  ['define-with-boundary', 'position-boundary', '一句定义与边界', '用一句定义和一个反例限定讨论范围。', '这里的“___”指___，不包括___。', '关键概念和不讨论范围都明确。'],
  ['position-first', 'position-boundary', '立场先行', '不从背景绕起，先说支持或反对以及命题理解。', '我支持/反对___；本轮讨论的是___。', '开头明确立场与命题范围。'],
  ['claim-reason-chain', 'claim-reason', '主张—理由—结论', '把一条散乱观点整理成三步链条。', '我的主张是___；因为___；所以___。', '三步之间没有缺失的逻辑跳跃。'],
  ['one-claim-only', 'claim-reason', '只保留一个论点', '删除不能在本轮展开的次要论点。', '这一轮我只证明___。', '整段内容服务于同一个主张。'],
  ['claim-evidence-because', 'claim-evidence-bridge', '主张—证据—论证桥', '说出主张和依据，再补“这说明……因为……”。', '我的主张是___。依据是___。这说明___，因为___。', '依据如何支持结论被明确说出。'],
  ['missing-premise', 'claim-evidence-bridge', '补出隐藏前提', '找出从依据跳到结论时省略的一步。', '只有当___成立时，这个依据才支持___。', '关键前提被说出并可被讨论。'],
  ['steelman-first', 'rebuttal-target', '先钢人化再反驳', '先用对方认可的方式复述，再回应最关键一项。', '对方最强的观点是___；但关键问题在于___。', '对方观点没有被稻草人化。'],
  ['hit-one-premise', 'rebuttal-target', '击中一个前提', '只回应对方论证中最关键的一条前提。', '这段论证依赖___；我质疑它，因为___。', '反驳对象具体且与对方原观点对应。'],
  ['impact-four-axes', 'impact-weighing', '影响四维权衡', '从范围、概率、严重性、时效性中选两个维度比较。', '即使双方都有影响，我方在___和___上更重要，因为___。', '权衡使用同一维度且给出理由。'],
  ['reversible-or-not', 'impact-weighing', '可逆性比较', '比较两种后果是否可恢复、何时发生。', '对方影响可以通过___恢复；我方影响在___后不可逆。', '可逆性与时间条件被清楚说明。'],
  ['signpost-roadmap', 'strategic-signposting', '三句路标', '开头说明本轮将证明哪两点，结尾回扣。', '我会证明两点：第一___，第二___。因此___。', '听众能预判结构并在结尾看到回扣。'],
  ['time-box-main-clash', 'strategic-signposting', '主争点限时', '把铺垫压缩，只给主要争点最多的时间。', '背景一句：___。核心争点：___。结论：___。', '主要争点获得超过一半表达时间。'],
].map(([id, criterionId, title, instruction, template, successCondition]) => ({ id, criterionId, title, durationSeconds: 60, instruction, template, successCondition, developmentFixture: false }));
const argumentDrillsByCriterion = indexDrills(argumentDrills);

const argumentTasks: readonly TaskDefinition[] = [
  {
    id: 'define-and-position', modeId: ARGUMENT_REBUTTAL_MODE_ID, title: '定义命题并表明立场',
    prompt: '用 45 秒定义一个命题的关键概念并表明立场。', description: '先冻结讨论边界，再进入论证。',
    durationSeconds: 45, audience: '持不同观点的讨论参与者', objective: '让听众理解你的立场与讨论范围', scenario: '命题定义',
    constraints: ['给出关键定义', '明确支持或反对'], successConditions: ['立场明确', '定义可用于后续讨论'],
    requiredFields: ['definition', 'position'], focusCriteria: ['position-boundary', 'strategic-signposting'],
  },
  {
    id: 'ai-assistant-decisions', modeId: ARGUMENT_REBUTTAL_MODE_ID, title: 'AI 助手是否应该主动替用户做决定',
    prompt: '用 120 秒立论：AI 助手是否应该主动替用户做决定。', description: '用定义、立场和一条完整论证链建立可被检验的核心主张。',
    durationSeconds: 120, audience: '尚未形成结论的评审与听众', objective: '让听众理解并记住你的核心论证', scenario: '开篇立论',
    constraints: ['只展开一个核心论点'], successConditions: ['立场清楚', '论证链完整'],
    requiredFields: ['position', 'claim', 'reason', 'bridge'], focusCriteria: ['claim-evidence-bridge', 'claim-reason'],
  },
  {
    id: 'single-argument-chain', modeId: ARGUMENT_REBUTTAL_MODE_ID, title: '搭建一条完整论证链',
    prompt: '用 60 秒从一个依据出发，完整说明它为什么支持你的主张。', description: '专练从证据到结论的连接。',
    durationSeconds: 60, audience: '会追问推理过程的讨论者', objective: '让听众不需要补足隐藏前提', scenario: '论证拆解',
    constraints: ['只使用一个主要依据'], successConditions: ['依据与主张相关', '论证桥明确'],
    requiredFields: ['claim', 'evidence', 'reasoning_bridge'], focusCriteria: ['claim-evidence-bridge', 'claim-reason'],
  },
  {
    id: 'direct-rebuttal', modeId: ARGUMENT_REBUTTAL_MODE_ID, title: '根据给定观点完成反驳',
    prompt: '根据一个给定观点，用 60 秒准确复述并反驳它。', description: '回应真实争点，不转移命题。',
    durationSeconds: 60, audience: '提出给定观点的对方与中立听众', objective: '暴露对方论证中最关键的问题', scenario: '定点反驳',
    counterArgument: '由用户在练习前提供需要回应的一段观点。', constraints: ['先准确复述', '只打一个关键点'],
    successConditions: ['复述公平', '反驳命中前提或影响'], requiredFields: ['counter_argument', 'rebuttal'],
    focusCriteria: ['rebuttal-target', 'claim-evidence-bridge'],
  },
  {
    id: 'steelman-rebuttal', modeId: ARGUMENT_REBUTTAL_MODE_ID, title: '先钢人化再反驳',
    prompt: '用 90 秒先呈现对方最强版本，再完成回应。', description: '避免稻草人化，提高反驳可信度。',
    durationSeconds: 90, audience: '熟悉双方立场的讨论者', objective: '证明你理解对方后仍能指出关键缺口', scenario: '深度反驳',
    counterArgument: '选择一个你不同意但有合理性的观点。', constraints: ['先呈现对方最强理由'],
    successConditions: ['钢人化准确', '回应对象一致'], requiredFields: ['steelman', 'rebuttal'],
    focusCriteria: ['rebuttal-target', 'impact-weighing'],
  },
  {
    id: 'cross-examination-answer', modeId: ARGUMENT_REBUTTAL_MODE_ID, title: '回答一项交叉质询',
    prompt: '用 45 秒直接回答一个会暴露你论证前提的问题。', description: '先给直接答案，再解释边界。',
    durationSeconds: 45, audience: '提出尖锐问题的对方与评审', objective: '守住核心立场并诚实说明边界', scenario: '交叉质询',
    constraints: ['先直接回答', '不回避前提'], successConditions: ['答案与问题对应', '边界不破坏主张'],
    requiredFields: ['direct_answer', 'boundary'], focusCriteria: ['position-boundary'],
  },
  {
    id: 'compare-impacts', modeId: ARGUMENT_REBUTTAL_MODE_ID, title: '比较双方影响',
    prompt: '用 90 秒使用相同维度比较双方主要影响。', description: '说明为什么某项影响更重要、更可能或更不可逆。',
    durationSeconds: 90, audience: '需要在双方之间作判断的评审', objective: '让听众理解你的权衡标准与结论', scenario: '影响权衡',
    constraints: ['双方使用同一比较维度'], successConditions: ['比较维度一致', '权衡结论有理由'],
    requiredFields: ['both_impacts', 'weighing', 'conclusion'], focusCriteria: ['impact-weighing', 'strategic-signposting'],
  },
  {
    id: 'closing-summary', modeId: ARGUMENT_REBUTTAL_MODE_ID, title: '完成结辩总结',
    prompt: '用 120 秒总结主要争点、双方差异并给出最终判断。', description: '不引入新论点，用比较收束整场讨论。',
    durationSeconds: 120, audience: '已经听过双方论证的评审与听众', objective: '帮助听众基于主争点作最终判断', scenario: '结辩总结',
    constraints: ['不引入新论点', '回到主争点'], successConditions: ['争点收束清楚', '最终权衡明确'],
    requiredFields: ['main_clash', 'comparison', 'conclusion'], focusCriteria: ['strategic-signposting', 'impact-weighing'],
  },
];

const argumentRebuttalMode = ModePackSchema.parse({
  id: ARGUMENT_REBUTTAL_MODE_ID, version: CONTENT_VERSION,
  name: '论证与反驳 · 辩手', abilityName: '论证与反驳', typicalRole: '辩手',
  description: '形成完整论证、准确回应对方，并解释自己的主张为何在比较中更成立。',
  developmentFixture: false, criteria: argumentCriteria, drills: argumentDrills,
  tasks: [
    ...argumentTasks.map((task) => buildTask(task, argumentDrillsByCriterion)),
    ...communityTasksForMode(ARGUMENT_REBUTTAL_MODE_ID, argumentDrillsByCriterion),
  ],
});

export const P1_MODE_PACKS: ReadonlyArray<ModePack> = Object.freeze([
  clearExpressionMode,
  decisionAlignmentMode,
  argumentRebuttalMode,
]);

export const MODE_PACK_BY_ID: Readonly<Record<ModePack['id'], ModePack>> = Object.freeze(
  Object.fromEntries(P1_MODE_PACKS.map((pack) => [pack.id, pack])) as Record<ModePack['id'], ModePack>,
);

export const GATE_C_PM_TASK: Readonly<TaskTemplate> = Object.freeze(
  decisionAlignmentMode.tasks.find((task) => task.id === GATE_C_PM_TASK_ID)!,
);

export interface FreeExpressionTaskInput {
  readonly prompt: string;
  readonly audience: string;
  readonly objective: string;
  readonly durationSeconds: number;
}

export function createFreeExpressionTask(input: FreeExpressionTaskInput): TaskTemplate {
  return TaskTemplateSchema.parse({
    id: 'free-expression', version: CONTENT_VERSION, modeId: CLEAR_EXPRESSION_MODE_ID,
    title: input.prompt, prompt: input.prompt,
    description: '一次性自由题目；使用清晰表达通用 Rubric，不保存为模板。',
    recommendedDurationSeconds: input.durationSeconds,
    context: { audience: input.audience, objective: input.objective, background: '', sourceMaterial: '', counterArgument: '', roleContext: '场景：自由练习' },
    constraints: [], successConditions: ['让听众理解这次最想表达的核心内容'], requiredFields: [],
    focusCandidateCriterionIds: ['main-point-early', 'logical-order'],
    fallbackDrillIds: ['main-point-one-line', 'main-point-five-seconds', 'three-part-outline', 'signpost-links'],
    focusDrillMappings: [
      { criterionId: 'main-point-early', drillIds: ['main-point-one-line', 'main-point-five-seconds'] },
      { criterionId: 'logical-order', drillIds: ['three-part-outline', 'signpost-links'] },
    ],
    developmentFixture: false,
  });
}

export function getModePack(modeId: ModePack['id']): ModePack {
  return MODE_PACK_BY_ID[modeId];
}

export function getTaskTemplate(modeId: ModePack['id'], taskId: string): TaskTemplate | undefined {
  return MODE_PACK_BY_ID[modeId].tasks.find((task) => task.id === taskId);
}

export interface PrimaryPracticeFocus {
  readonly criterionId: string;
  readonly criterionLabel: string;
  readonly criterionDescription: string;
  readonly comparisonDimension: ModePack['criteria'][number]['comparisonDimension'] | null;
  readonly drillId: string;
  readonly drillTitle: string;
  readonly drillInstruction: string;
  readonly drillTemplate: string;
  readonly successCondition: string;
}

export interface PracticeFocusOption extends PrimaryPracticeFocus {
  readonly recommended: boolean;
}

function focusOptionsFromDefinitions(
  task: TaskTemplate,
  criteria: ModePack['criteria'],
  drills: ModePack['drills'],
): readonly PracticeFocusOption[] {
  return task.focusCandidateCriterionIds.flatMap((criterionId, criterionIndex) => {
    const criterion = criteria.find((candidate) => candidate.id === criterionId);
    const mapping = task.focusDrillMappings.find((candidate) => candidate.criterionId === criterionId);
    if (!criterion || !mapping) return [];
    return mapping.drillIds.flatMap((drillId, drillIndex) => {
      const drill = drills.find((candidate) => candidate.id === drillId);
      if (!drill) return [];
      return [{
        criterionId: criterion.id,
        criterionLabel: criterion.label,
        criterionDescription: criterion.description,
        comparisonDimension: criterion.comparisonDimension ?? null,
        drillId: drill.id,
        drillTitle: drill.title,
        drillInstruction: drill.instruction,
        drillTemplate: drill.template,
        successCondition: drill.successCondition,
        recommended: criterionIndex === 0 && drillIndex === 0,
      }];
    });
  });
}

/** Lists every valid criterion/Drill pair frozen by the current task. */
export function listPracticeFocusOptions(
  modeId: ModePack['id'],
  taskId: string,
): readonly PracticeFocusOption[] {
  const pack = getModePack(modeId);
  const task = getTaskTemplate(modeId, taskId) ?? (
    taskId === 'free-expression'
      ? createFreeExpressionTask({
          prompt: '自由练习',
          audience: '当前听众',
          objective: '把核心内容讲清楚',
          durationSeconds: 90,
        })
      : undefined
  );
  if (!task) throw new Error('TASK_FOCUS_NOT_CONFIGURED');

  return focusOptionsFromDefinitions(task, pack.criteria, pack.drills);
}

/** Resolves focus and Drill copy from the immutable Session snapshot. */
export function listFrozenPracticeFocusOptions(
  task: TaskTemplate,
  modeVersion: string,
): readonly PracticeFocusOption[] {
  const pack = getModePack(task.modeId);
  if (task.rubricSnapshot && task.drillSnapshot) {
    return focusOptionsFromDefinitions(task, task.rubricSnapshot, task.drillSnapshot);
  }
  const matchingLegacyTask = pack.tasks.find((candidate) => (
    candidate.id === task.id && candidate.version === task.version
  ));
  if (pack.version !== modeVersion && !matchingLegacyTask) {
    throw new Error('FROZEN_TASK_DEFINITIONS_NOT_AVAILABLE');
  }
  return focusOptionsFromDefinitions(task, pack.criteria, pack.drills);
}

/** Resolves the current task's default offline focus without claiming an AI diagnosis. */
export function getPrimaryPracticeFocus(modeId: ModePack['id'], taskId: string): PrimaryPracticeFocus {
  const primary = listPracticeFocusOptions(modeId, taskId)[0];
  if (!primary) throw new Error('PRIMARY_FOCUS_NOT_CONFIGURED');
  return primary;
}
