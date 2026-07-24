# Phrio 产品就绪度审计

日期：2026-07-17
结论：**NOT READY — 当前是功能性 Alpha，不满足生产发布门槛。**

这份审计回答的是“用户能否按产品要求完成整条练习闭环”，而不是“仓库里是否已经存在同名组件、状态或测试”。只在真实用户路径、数据边界和失败路径均有可复核证据时记为 PASS；可控 mock、jsdom 渲染测试和孤立 helper 不等同于端到端生产能力。

## 1. 权威输入与审计边界

本轮严格按以下优先级判定：冻结产品源 > approved Pencil 与 Gate C > thin Clickable / 工具项目行为参考。

| 输入 | 已验证值 |
| --- | --- |
| 冻结产品源 | `8d37b1345c83f0435318337b75746cbb6ef02177`，可通过 `git ls-tree` / `git show` 只读读取 |
| Prototype Studio V4 | `c0b22b6da5ec447b856bbe5ddbf1f79a41eebdee`，仅用于理解批准交互，不作为生产代码 |
| Gate C 最终归档 | `b17852903c4c1f3c6f54993162bdd24e46209b9b`，可读取 |
| Approved Pencil | 维护者本机私有归档；本仓只记录冻结哈希 |
| Pencil 实测 SHA-256 | `22b48697dff698edd0eba257a2793787945e74abbeb0dd4cf84a5f4d0e6ceb0f` |
| 稳定 slug | `expression-practice-coach` |
| 生产 Worktree 审计基线 | 历史 fast-deep Worktree，分支 `codex/fast-deep-production`，本轮修改前 HEAD `044d0abc5c05b44a71a6c9f6460660c3c506f126` |

冻结产品文件均从该精确提交读取：`docs/prd/2026-07-15-expression-practice-prd-v1.md`（文内 V1.1）、`docs/product/2026-07-15-product-boundary-v0.1.md`（文内 V1.1）、`docs/product/2026-07-15-audience-and-mode-system.md`、`deliverables/2026-07-16-prototype-studio-fast-loop-amendment.md`，以及直接引用的 `deliverables/2026-07-15-prototype-studio-handoff.md`。

### 后续批准演进

以下选择来自 Dewens 在本实现轮次中的逐屏批准/纠正，属于对冻结源的信息架构和表现层演进，不反写产品源提交：

| 演进 | 当前采用口径 |
| --- | --- |
| 全局侧栏 | 只放新练习、练习记录、收藏题目、练习设置、最近练习；模式不在全局层级 |
| 最近练习 | 条目直达单次冻结详情；“全部”进入记录集合 |
| 自由练习 | 新练习页可留空主题直接开始，不被推荐题替代 |
| 设置入口 | 外观与常规/隐私是不同页面，不再串到同一板块 |
| 浅色主题 | 采用低饱和浅底语义，不把过深强调色伪装成浅色主题 |

这些演进已写入 `decisions.md`。后续明确批准只覆盖其逐项点名的 IA 与表现层字段；未被点名覆盖的功能、数据和同意边界仍按“冻结产品源 > approved Pencil/Gate C > thin Clickable”处理。

冻结源引用但未在该提交树中提供的独立产品策略文档，不能用当前工作区同名的未跟踪文件补位。云端 AI provider/model、ASR 模型权重、内容专业评审结果和性能预算也没有被产品源冻结；本审计不会伪造这些结论。

当前技术栈为 Electron Forge + React 19 + TypeScript + Vite，主进程通过窄 IPC bridge 暴露录音、会话和 artifact 能力，持久化为本地 SQLite，测试以 Vitest + jsdom 为主，本地流式 ASR 依赖 `sherpa-onnx-node`。

### 状态口径

| 状态 | 含义 |
| --- | --- |
| PASS | 当前生产路径已实现，并有与风险相称的自动化或真实浏览器证据 |
| PARTIAL | 已有可用骨架或部分路径，但存在会影响用户闭环、准确性、恢复或数据边界的缺口 |
| FAIL | 当前生产路径缺失、未接通，或 UI 会把尚未完成的能力表现成已完成 |
| EXTERNAL | 需要真实设备、模型、服务、内容评审或尚未冻结的外部决定；不把它算作本地实现 PASS |

## 2. 总体判断

已经达标的主要是：批准后的全局对象 IA、自由练习入口、S04 共享行证据账本、证据全屏、final-only 本地指标、幂等 transcript reducer、冻结快照持久化、Deep Lane 的可走通骨架，以及 macOS arm64 包内本地 ASR 原生依赖。

阻止生产发布的关键项仍然存在：

1. 生产 Live AI transport、三用途同意和逐 payload 批准没有接通，短 AI 提示不能由真实练习触发。
2. 没有完整 VAD / 无语音超时；ASR 中断重连、全音频恢复、尾句失败后的可信恢复也未完成。
3. Deep 纠正虽然持久化，但不会重新迁移证据、重算报告和比较；当前完整诊断仍以本地启发式为主。
4. 内容仅为开发样例：每个模式没有达到生产题量、场景覆盖、Rubric 维度、黄金样本和专业评审要求。
5. 首次环境检查、麦克风/模型/AI/同意/数据治理等设置不完整。
6. 仓库没有真正驱动 Electron 的可重复端到端测试；当前所有 `tests/e2e/*` 命名文件仍由 Vitest/jsdom 执行。
7. P2 正式分发安全前置尚未关闭：Renderer 仍由 `file://` 加载，`GrantFileProtocolExtraPrivileges` 仍为 `true`，未迁移到受限自定义协议。
8. 125% 真实 Electron 缩放及 S04 以外页面的 approved.pen 逐屏视觉一致性尚未完成。

因此，当前版本可以继续做受控产品验证，但不能被描述为“完整 Fast Lane + Deep Lane 已生产达标”。

## 3. 全量需求追踪矩阵

### 3.0 需求 ID 字典与来源

为避免“自造 ID 无法回查”，本矩阵的 ID 是验收索引，不是对冻结文档重新编号。以下路径均指冻结提交 `8d37b1345c83f0435318337b75746cbb6ef02177` 中的版本：

- **PRD**：`docs/prd/2026-07-15-expression-practice-prd-v1.md`（文内 V1.1）
- **Boundary**：`docs/product/2026-07-15-product-boundary-v0.1.md`（文内 V1.1）
- **Modes**：`docs/product/2026-07-15-audience-and-mode-system.md`
- **Fast Amendment**：`deliverables/2026-07-16-prototype-studio-fast-loop-amendment.md`
- **Handoff**：`deliverables/2026-07-15-prototype-studio-handoff.md`
- **Visual baseline**：Gate C 提交 `b17852903c4c1f3c6f54993162bdd24e46209b9b` 与指定 SHA-256 的 approved Pencil
- **Later-approved IA**：本轮用户逐屏明确批准、已记录在 `decisions.md` 的局部 IA/表现层覆盖

| 需求 ID | 本审计中的精确定义 | 权威来源 |
| --- | --- | --- |
| CORE-01..05 | 01 任务/条件冻结；02 初讲与 Fast；03 唯一焦点；04 Drill + 同题复讲；05 同口径比较 + 保存 | PRD §9、FR-011、FR-020、FR-032、FR-042、FR-050、FR-060、FR-070；Boundary §3.2–3.8；Fast Amendment §2–3 |
| MODE-01..05 | 01 清晰表达；02 决策与对齐；03 论证与反驳；04 每轮可切换且开录后冻结；05 共用闭环/Schema、内容与 Rubric 分包 | PRD §8、FR-010、FR-100；Modes §5–12；Boundary §3.2 |
| ONB-01 / ENV-01 | 首次数据/AI 用途说明；麦克风、模型与运行环境检查及恢复 | PRD FR-001、FR-002；Boundary §3.1 |
| TASK-01 / FREE-01 | 生产任务量、场景、字段与质量；通用模式一次性自由题目 | PRD §7.3、FR-011；Modes §6–8、§12；Boundary §3.2 |
| IA-01..04 | 01 全局对象导航；02 模式只在练习工作区；03 最近练习直达详情/“全部”进集合；04 外观与设置分离 | PRD §10 为基础边界；Later-approved IA 对点名字段作覆盖；Visual baseline |
| HIST-01..03 | 01 记录集合/筛选；02 单次详情与冻结证据；03 继续、再练、导出与删除 | PRD FR-080；Boundary §3.9；Modes §11；Later-approved IA |
| FAV-01 | 收藏题目的独立对象入口与本地留存 | Visual baseline；Later-approved IA |
| SET-01 / THEME-01 | 麦克风、ASR、AI、数据和无障碍设置；系统/浅/深主题及批准的低饱和浅色表达 | PRD FR-090；Boundary §3.10；Visual baseline；Later-approved IA |
| REC-01..03 | 01 麦克风授权；02 采集/录音/停止；03 回放、重录、过短提示与音频保留边界 | PRD FR-020、FR-021；Boundary §3.3、§6；Handoff §8–9 |
| VAD-01 | 语音检测、无语音/超时、可见状态与恢复 | PRD FR-020、FR-023、§12；Boundary §3.3、§8；Fast Amendment §3 |
| ASR-01..04 | 01 partial 原位替换；02 final 稳定追加；03 幂等、排序、背压、隔离与重连；04 停止 watermark、尾句落定与失败恢复 | PRD FR-022、FR-023、FR-030；Boundary §3.3–3.4、§8；Fast Amendment §3–4 |
| ANN-01..03 | 01 只在 final 后正式提交；02 九类、精确 span 与 O 映射；03 暂定→确认/撤回、修正迁移与历史锚点 | PRD FR-030、FR-031、FR-040；Boundary §3.3–3.5；Fast Amendment §3 |
| MET-01 | final-only 确定性统计，实时/停止后同算法口径 | PRD FR-031、FR-040；Boundary §3.3、§7 |
| LIVEAI-01..02 | 01 累计 final 触发受限短提示；02 防抖、窗口/频率上限、去重、迁移/撤回、超时和迟到丢弃 | PRD FR-001、FR-020、FR-031、FR-090；Boundary §3.3、§6.3；Fast Amendment §3–4 |
| CTRL-01 | 隐藏显示、关闭本地类别、关闭 AI、撤回同意四种控制语义分离 | PRD FR-031；Boundary §3.3；Fast Amendment §3–4 |
| STOP-01 / SNAP-01 | 安全停止与尾句收束；持久化成功后冻结不可变 Attempt 快照 | PRD FR-020、FR-023、FR-032；Boundary §3.4、§6；Fast Amendment §3 |
| CORR-01 / CAP-01 | 可追踪逐字稿纠正与派生结果重算；完整报告异步且不阻塞实时轨 | PRD FR-030、FR-032、FR-041；Boundary §3.4–3.5；Fast Amendment §2–4 |
| DIAG-01..03 | 01 最终逐字稿/证据版本；02 当前任务 Rubric；03 更准确、证据化且不把 LiveHint 升格的完整复盘 | PRD FR-030、FR-041；Boundary §3.4–3.5；Modes §5.2–5.4；Fast Amendment §2–3 |
| FOCUS-01 / DRILL-01 / RETRY-01 | 唯一可训练焦点；内联短 Drill；同任务同约束复讲 | PRD FR-042、FR-050、FR-060；Boundary §3.5–3.6；Modes §5–8 |
| CMP-01..02 / SAVE-01 | 01 同 criterion/同版本前后证据；02 改善/持平/退步/证据不足及干预披露；Session/Attempt/artifact 持久化恢复 | PRD FR-021、FR-070、FR-080；Boundary §3.7–3.9；Modes §5.6、§11 |
| CONS-01..03 | 01 `live_hint` 配置同意 + 每轮 AI ON；02 `deep_diagnosis` 逐 payload；03 `comparison` 逐 payload | PRD FR-001、FR-031、FR-041、FR-070、FR-090；Boundary §3.1、§6.3；Fast Amendment §4 |
| DATA-01..04 | 01 capture/partial/final；02 transcript/evidence/annotation/hint 版本；03 frozen snapshot/report/correction；04 initial/retry 与音频生命周期 | PRD §14–15、FR-021、FR-030、FR-080；Boundary §6 |
| SEC-01..03 | 01 renderer/IPC/本地文件边界；02 Key、origin、日志和 payload 最小化；03 正式分发的受限协议/fuse 门禁 | PRD FR-021、FR-090、§15、§18；Boundary §6、§9；仓内 ADR-0001 与 `decisions.md` 的正式分发退出条件 |
| DEG-01..07 | 麦克风权限、无语音/VAD、ASR、AI、网络、完整报告队列、关闭实时反馈七条独立降级分支 | PRD §12、FR-002、FR-020–023、FR-031–032、FR-041；Boundary §8；Fast Amendment §3–5 |
| VIS-01..05 | 共享句行、精确划线、O 双向映射、来源/生命周期、中性历史态 | Fast Amendment §3、§5；Visual baseline；用户冻结的 S04 验收要求 |
| FULL-01..02 | 标准/紧凑均可进入；共享状态/停止/scroller，Esc 回焦和语义滚动锚点 | Fast Amendment §3、§5；Visual baseline；用户冻结的证据全屏要求 |
| RESP-01..02 | 1440×960/1024×960、100%/125%、无横溢出、唯一证据滚动区与行对齐 | Fast Amendment §5；Handoff §17；Visual baseline；用户冻结的浏览器验收要求 |
| MOT-01..02 / A11Y-01..02 | partial/final/标注/记录/尾句/降级动效及 reduced-motion；文字/图标状态、键盘/焦点/读屏与缩放 | PRD FR-023、FR-031、§16、§18；Boundary §9；Fast Amendment §3、§5；Visual baseline |
| TEST-01..02 | reducer/服务/持久化自动化；真实浏览器/Electron/设备级完整闭环验证 | PRD §17.5、§18、§20；Boundary §11；Fast Amendment §5 |
| PKG-01 / DEVICE-01 | 可安装包与包内依赖；目标 Mac 麦克风/睡眠/设备恢复 | PRD FR-002、FR-020–023、§18、§20；Boundary §8–9、§11 |
| ASR-EXT-01 / AI-EXT-01 | 冻结模型的准确性/端点/资源实测；冻结 provider/model 后的真实传输验收 | PRD §13、§17.4–17.5、§22；Boundary §6–9 |
| CONTENT-EXT-01 / PERF-01 | 题库/Rubric/黄金样本/专业评审；冻结预算后的目标设备实测 | PRD FR-011、FR-100、§17–18、§20；Modes §6–9、§12；Boundary §7、§11 |
| RELEASE-01 / DOC-01 | V0.1 发布候选全闭环退出；架构、状态、验收、外部配置和 runbook 可追踪 | PRD §20、§23；Boundary §11；Handoff §16–17；Fast Amendment §5 |

### 3.1 产品骨架、模式、IA、记录与设置

| 需求 ID | 状态 | 证据与缺口 |
| --- | --- | --- |
| CORE-01..05 | PARTIAL | 初讲 → 聚焦 → Drill → 复讲 → 比较的页面和本地 artifact 链存在；实时 AI、可信尾句恢复、纠正后重算尚未闭环，Deep 的 Rubric/focus 上下文仍依赖 App draft 而非只读持久化 task snapshot。 |
| MODE-01..05 | PARTIAL | 三种模式可切换，任务、听众、目标、焦点和 Drill 已按模式传播；每种模式目前只有开发样例，内容规模和 Rubric 完整度不足。 |
| ONB-01 | FAIL | 首次说明仍含开发 fixture 文案，不能完整解释本地处理、三种 AI 用途、原始音频边界和用户选择。 |
| ENV-01 | FAIL | 没有完成首次麦克风、ASR 模型、存储、AI 配置的环境检查与可恢复引导。 |
| TASK-01 | FAIL | 当前每个模式仅有少量开发 fixture；未达到每模式至少 8 题、至少 4 类场景、5–7 个 Rubric 维度及质量评审要求。 |
| FREE-01 | PASS | 新练习中存在可留空主题并直接开始的自由练习；不会被推荐题目强制替代。 |
| IA-01..04 | PASS | 按后续批准更新，练习上下文的全局侧栏只承载对象级入口，S11/S12 使用设置局部目录；模式切换留在工作区；最近练习直达详情，“全部”进入记录集合；外观与设置为不同入口。 |
| HIST-01..03 | PARTIAL | 列表、搜索/筛选、单次详情、删除、继续、同题再练和文本导出已存在；同题再练的版本语义、原始音频回放以及纠正后派生结果更新仍不完整。 |
| FAV-01 | PASS | 收藏题目有独立对象入口并可留存。 |
| SET-01 | PARTIAL | 设置入口和部分本地偏好存在；麦克风、ASR 模型、AI provider/key、三用途同意、数据清理/重置和完整无障碍设置尚未形成可操作面板。 |
| THEME-01 | PARTIAL | 系统/浅色/深色及配色选择可用；仍需对所有页面做批准浅色语义与 100%/125% 的完整视觉回归，不能仅凭外观页卡片视为全产品达标。 |

### 3.2 Fast Lane

| 需求 ID | 状态 | 证据与缺口 |
| --- | --- | --- |
| REC-01..03 | PARTIAL | Electron 生产路径请求麦克风并使用 MediaRecorder/PCM；原始音频默认不长期保存且可受策略控制。缺真实设备拒绝/恢复/睡眠唤醒证据，也缺生产页回放、重录和过短录音提醒。 |
| VAD-01 | FAIL | 只有简单 RMS voice-detected；句段端点由 Sherpa 固定 endpoint 规则承担，没有完整 VAD、无语音超时和相应恢复分支。 |
| ASR-01..04 | PARTIAL | partial 替换、final 追加、重复/乱序/revision、endpoint 落定、启动期间 8 秒有界 PCM 缓冲和 start/stop 协调有单元证据；本地依赖已进入包。仍缺真实模型长时验证、steady-state 解码队列背压、中断重连和完整音频恢复。 |
| ANN-01..03 | PARTIAL | 本地规则只在 final 后提交，九类 schema/helper、精确 span 与 O 编号具备；生产 `annotateFinalSegment()` 生成的 lifecycle 始终为 provisional，`confirmOrWithdrawAnnotations()` 未被生产调用。截图中的 confirmed/withdrawn 来自 QA fixture；生产也未传完整任务/尾句上下文，缺“有帮助/不适用/判断有误”处置，纠正后不会迁移证据。 |
| MET-01 | PARTIAL | 现有字符数、final 句数和五类命中统计只消费 final，partial 不污染结果，重复/revision 有 reducer 测试；但有效时长、停顿/语速、结构/任务字段、AudioEvidence、停止后同算法重算和无法计算时 N/A 尚未完整实现。 |
| LIVEAI-01..02 | FAIL | coordinator 单测覆盖累计 final、防抖、窗口、去重、超时、superseded/disabled 与迟到丢弃；reducer 覆盖 consent revoke。基于 transcript/evidence revision 的提示迁移未实现，生产练习也没有接入真实 transport、配置同意和 Attempt AI ON。 |
| CTRL-01 | PARTIAL | “隐藏实时显示”已验证保留 transcript 与本地处理，隐藏精确标记、O 编号、右侧记录和当前提示，并可从同一状态恢复；关闭全部本地标注只影响未来 final。九类逐类开关尚未实现，关闭 AI/撤回同意主要只有 reducer 语义且生产 transport 不可达，四种控制尚未完整闭环。 |
| STOP-01 | PARTIAL | 结束录音、停止采集、等待 ASR start/flush 和尾句状态存在；start 失败、缓冲溢出、feed/stop 失败或无 final 会明确降级并阻止冻结不完整逐字稿。仍缺面向用户的同 Attempt 重试/重录入口、全音频补偿和重启恢复，不能把所有停止路径都视为安全收束。 |
| SNAP-01 | PASS | Attempt 先形成不可变候选，再在 artifact 持久化成功后暴露并导航；保存失败停留原页，显式重试复用同一候选，避免“UI 已冻结但磁盘没有”的竞态。 |
| CORR-01 | PARTIAL | 用户纠正会作为可追踪 artifact 保存，详情保留 ASR 原句；但没有低置信关键证据的最小阻塞/纠错路径，也不会触发 annotation/report/comparison 的版本化重算。 |
| CAP-01 | FAIL | `DeepReportCoordinator` 只有孤立 helper/单测，生产无引用；Deep 页仅在 microtask 中调用本地启发式，先显示结果再 fire-and-forget 保存且无 await/catch/失败 UI。没有可靠的排队/处理中/完成/失败任务轨、重启恢复或云端报告。 |

### 3.3 Deep Lane

| 需求 ID | 状态 | 证据与缺口 |
| --- | --- | --- |
| DIAG-01..03 | PARTIAL | Deep 的逐字稿/证据读取冻结快照和纠正，但 Rubric/focus 仍从 App draft prop 解析；当前页面已明确标为“本地初步复盘”。没有低置信关键证据的最小范围阻塞/修正，纠正后也不重算，不能宣称“更准确的完整诊断”。 |
| FOCUS-01 | PARTIAL | 页面始终只显示一个、且已按当前模式/任务映射的焦点；但当前直接取配置首项，不按差距、证据和置信度推荐，也缺接受、改选、误判、手动选择及 `guidance_source` 闭环。 |
| DRILL-01 | PARTIAL | 存在使用当前模式焦点的内联短 Drill；但模板未完整包含目标/步骤/原句/改写示例/成功条件及“理解/不适用/换焦点”处置，每个 criterion 的 Drill 数量和内容质量也未达冻结要求。 |
| RETRY-01 | PARTIAL | 同题复讲会作为 retry Attempt 进入同一 Session 并可恢复；但实时反馈尚未严格限制为已确认唯一焦点，也未完整持久化 `live_feedback_exposure` 与定向提示关闭状态。 |
| CMP-01..02 | PARTIAL | 初讲/复讲使用同一 criterion 标识和版本化 comparison artifact；当前比较仍偏计数式，未充分验证 Rubric 语义一致性、纠正重算和所有边界。 |
| SAVE-01 | PARTIAL | Repository 的通用 artifact schema 可保存 Session/Attempt/快照/报告/纠正/比较，显式 SQLite 重开测试覆盖 Session 与 attempt snapshot；其余 artifact 尚未逐类重开验证。跨 Session artifact ID 冲突现在会拒绝而非静默串写。 |

### 3.4 同意、数据与安全边界

| 需求 ID | 状态 | 证据与缺口 |
| --- | --- | --- |
| CONS-01 | FAIL | 产品要求 live_hint 使用配置级同意且每次练习显式 AI ON；当前生产练习未把二者接到可用 transport。 |
| CONS-02..03 | FAIL | deep_diagnosis 与 comparison 尚无真实 payload 预览、逐次批准、撤回和传输记录；仅显示“待批准”不构成同意闭环。 |
| DATA-01..04 | PARTIAL | 类型区分 capture、partial、final、版本、annotation、hint、snapshot、report、correction、initial/retry；原始音频默认不长期保存。缺完整数据用途控制、用户可见清理/重置和云端 payload 审计。 |
| SEC-01..03 | PARTIAL | Renderer 不直接拥有 Node，使用窄 bridge，包内 smoke 会检查暴露面；但 P2 仍使用 `file://` renderer 且 `GrantFileProtocolExtraPrivileges=true`，未完成 ADR-0001/`decisions.md` 冻结的受限自定义协议退出条件。真实 provider 密钥存储、日志脱敏、远端请求域和 payload 最小化也未实现/验证。 |

### 3.5 状态机与降级

| 需求 ID | 状态 | 证据与缺口 |
| --- | --- | --- |
| DEG-01 麦克风权限 | PARTIAL | 有待授权/失败文本和 mock 测试；缺真实拒绝、系统设置恢复、设备移除/切换证据。 |
| DEG-02 无语音/VAD 超时 | FAIL | 没有完整无语音超时与用户可恢复动作。 |
| DEG-03 ASR 中断/重连 | FAIL | 有 ASR 错误状态，但没有生产级重连、退避、积压处理和全音频追赶。 |
| DEG-04 AI 超时/失败 | PARTIAL | 协调器会超时、撤销并丢弃迟到结果；生产 AI 没有接通，界面无法完成真实失败/恢复。 |
| DEG-05 网络中断/恢复 | FAIL | 没有完整网络监听、离线提示、恢复后任务迁移与去重。 |
| DEG-06 完整报告队列 | FAIL | 只有状态结构和孤立 helper；没有生产后台队列、重启恢复和真实失败重试。 |
| DEG-07 关闭实时反馈 | PARTIAL | 已验证“隐藏实时显示”关闭/恢复共享同一练习状态和停止逻辑，不会丢 transcript 或伪装为暂停录音；九类逐类关闭、停止 AI 发送和撤回同意仍未形成生产闭环。 |

状态文案和图标已覆盖主要本地阶段，但“AI 实时处理中/短提示到达”“无语音超时”“网络恢复”等在真实生产路径未接通，因此不能仅凭状态枚举判定完整。

### 3.6 视觉、全屏、响应式、动效与无障碍

| 需求 ID | 状态 | 证据与缺口 |
| --- | --- | --- |
| VIS-01..05 | PARTIAL | S04 QA 工作区已验证句级共享行、精确 span、语义色+线型+O 编号、左右双向联动、来源/生命周期和中性撤回态；左右 O 编号双向定位另有显式组件测试。但 S00/S01/题库/历史/设置/Deep/Drill/Comparison 尚未做同等 approved.pen 逐屏视觉 diff，因此不能外推为全产品视觉还原 PASS。 |
| FULL-01..02 | PASS | 标准和紧凑模式均可进入证据全屏；隐藏非必要导航，保留任务、状态、提示、结束与退出；普通/全屏共享数据、状态机、停止逻辑和同一个 ledger。 |
| RESP-01..02 | PARTIAL | 1440×960 与 1024×960、标准/全屏、100% 实测无全局横向溢出，只有一个证据滚动区，共享行对齐为 0px。原“125%”只改 root font，截图与 100% 字节相同，已撤销；CSS `zoom:1.25` 代理通过，但真实 Electron 125% 尚未验证。 |
| MOT-01..02 | PASS | partial、final、划线、记录到达、尾句和降级使用克制动效；系统 `prefers-reduced-motion` 将相关动画/transition 压缩至 `0.001ms`（实测计算值 `1e-06s`），应用内设置压缩至 `0.01ms`，功能不依赖动画。 |
| A11Y-01..02 | PARTIAL | Esc 退出并恢复触发按钮焦点，状态不只靠颜色，核心控件有文字/图标；尚未完成全键盘顺序、屏幕阅读器、对比度和系统 125% 跨页审计。 |

未发现总分、雷达图、输赢感、积分、勋章、廉价霓虹波形或过度拟人导师等禁用表达。

### 3.7 测试、打包、设备、外部服务与发布

| 需求 ID | 状态 | 证据与缺口 |
| --- | --- | --- |
| TEST-01 | PARTIAL | reducer、repository、AI coordinator、ASR adapter、快照竞态、反馈开关和 Deep 模式传播均有自动化；但当前全部 `tests/e2e/*` 命名文件仍由 Vitest/jsdom 执行，不是 Electron 真端到端。 |
| TEST-02 | PARTIAL | 已用真实 Chromium 对 QA fixture 做 100% 布局、全屏、焦点、动效和 console 检查；CSS 125% 仅为代理。未自动驱动真实 Electron 麦克风、ASR、停止、原生缩放、重启恢复和整条 Deep 闭环。 |
| PKG-01 | PASS | macOS arm64 Forge package 成功；`sherpa-onnx-node` 及平台原生包被显式复制/解包，打包后 ASR dependency smoke 可加载 recognizer；最终组合 `pnpm verify` 已通过。 |
| DEVICE-01 | EXTERNAL | 真实麦克风允许/拒绝/恢复、睡眠唤醒、设备断开和长录音必须在目标 Mac 手工验收。 |
| ASR-EXT-01 | EXTERNAL | 仓库不含模型权重；真实模型准确率、partial/final 稳定性、端点和资源占用需目标模型实测。 |
| AI-EXT-01 | EXTERNAL | provider/model/凭据未冻结；即使外部决定完成，本地仍须先补齐 CONS/LIVEAI 的生产接线。 |
| CONTENT-EXT-01 | EXTERNAL | 生产题库、Rubric、黄金样本、离线兜底与专业教练评审未提供；当前 fixture 不能替代内容验收。 |
| PERF-01 | EXTERNAL | 产品源未给可执行数值预算；只能报告目标设备实测值，不能伪造延迟、准确率、CPU/内存或训练效果达标。 |
| RELEASE-01 | FAIL | 因 LIVEAI、CONS、VAD/ASR 恢复、报告队列、内容、纠正重算、自定义协议安全退出条件、真实 125% 和真 E2E 未过，不满足生产发布门槛。 |
| DOC-01 | PARTIAL | 架构/状态/验收已有文档，本文件纠正了旧记录把 mock/jsdom 写成完整生产验收的风险；外部配置、真实设备操作和发布 runbook 仍需补齐。 |

## 4. 本轮真实浏览器证据

本轮通过真实 Chromium 打开开发 renderer，并使用 `?qa=1` 注入可控 ASR 序列。该验证能证明布局和前端交互，不证明真实麦克风、真实 ASR 模型或云端 AI 可用。

| 场景 | 实测结果 |
| --- | --- |
| 1440×960 标准 | 全局横向 overflow = 0；DOM 中 `.evidence-ledger` = 1；4 个共享行 top/bottom 差均为 0px |
| 1440×960 证据全屏 | overflow = 0；仍只有 1 个 ledger；保留同一可见 segment 语义锚点 |
| 1024×960 标准 | overflow = 0；1 个 ledger；共享行 top/bottom 差均为 0px |
| 1024×960 证据全屏 | overflow = 0；没有第二证据滚动区 |
| 125% 缩放 | 原根字号 20px 方法不改变 px 主导的 UI，100%/“125%”截图 SHA 相同，因此撤销该验收。CSS `zoom:1.25` 代理无 overflow 且行差 0px，但不代替真实 Electron 缩放 |
| Esc 与焦点 | Esc 退出全屏，焦点恢复到“证据全屏”触发按钮 |
| prefers-reduced-motion | 相关动画/transition 计算值 `1e-06s`，所有状态和操作仍可用；应用内设置另使用 `0.01ms` |
| Console | 0 error、0 warning；仅有 React DevTools 开发提示 |
| 反馈关闭/恢复 | 关闭时保留 final 正文，标记、O 编号、右侧记录和当前提示为 0；恢复后使用同一状态重新呈现 |

进入本次稳定提交的审计截图：

- [`phrio-1440-standard.png`](assets/2026-07-17-readiness/phrio-1440-standard.png)
- [`phrio-1440-fullscreen.png`](assets/2026-07-17-readiness/phrio-1440-fullscreen.png)
- [`phrio-1024-standard.png`](assets/2026-07-17-readiness/phrio-1024-standard.png)
- [`phrio-1024-fullscreen.png`](assets/2026-07-17-readiness/phrio-1024-fullscreen.png)

以上四张 100% 截图已进入稳定提交；无有效的 125% 截图被用作通过证据。本机另保留 CSS zoom 代理截图，仅供诊断。

## 5. 自动化与打包证据

所有修改完成后已从同一命令链重跑。这里的 PASS 只证明当前已实现范围没有回归，不覆盖第 2 节列出的缺失生产能力。

| 命令/检查 | 当前证据 | 判定 |
| --- | --- | --- |
| `pnpm typecheck` | TypeScript 无错误 | PASS |
| `pnpm test` | 18 files / 109 tests 全部通过 | PASS（全部 `tests/e2e/*` 命名文件仍由 jsdom 执行） |
| `pnpm package` | macOS arm64 package 成功；应用包实测约 335 MB | PASS（无性能预算结论） |
| `pnpm smoke:packaged` | 16 个窄 bridge 方法、3 个 Mode、Renderer 无 Node process | PASS |
| `pnpm smoke:packaged-asr` | `loaded=true`、`OnlineRecognizer` 构造器存在，运行时报告版本 `1.13.4` | PASS |
| `pnpm verify` | typecheck + 109 tests + package + 两个 packaged smoke 全链通过 | PASS（实现范围）；不是 RELEASE-01 PASS |
| 真 Electron E2E | 仓库无可重复脚本 | FAIL |

旧验收记录中的 “82/82” 只能证明当时的 Vitest/jsdom 套件通过，不能证明真实浏览器或 Electron 生产闭环达标。

## 6. 本轮已修复的实质缺陷

1. 打包阶段显式携带并解包 `sherpa-onnx-node` 与 arm64 原生依赖，新增包内 ASR dependency smoke。
2. 修复相同 partial 文本在 endpoint 到来时无法升级为 final 的顺序问题。
3. Live hint coordinator 现在独立竞速 timeout/superseded/disabled，transport 忽略 AbortSignal 时也不能让迟到结果生效。
4. Attempt 只有在快照 artifact 持久化成功后才进入 Deep；失败时留在原页，重试复用同一不可变候选。
5. 关闭实时反馈真正隐藏精确划线、O 编号、右栏记录、当前提示和实时统计，同时保留 transcript 与停止能力。
6. 任务的 mode/audience/goal/success conditions 贯穿首页、题库、恢复与 Deep；焦点、Rubric、Drill、比较不再固定成产品经理决策样例。
7. comparison artifact 使用 Session 范围唯一 ID；Repository 会拒绝跨 Session artifact ID 冲突，避免静默串写。
8. 记录详情保留撤回证据生命周期、短提示历史和纠正前 ASR 原句，不再只显示活跃 annotation。
9. MediaRecorder 真正启动后才向统一状态机提交 `recording_started`，避免 UI 录音状态与事件状态脱节。
10. ASR 首次启动期间增加 8 秒有界 PCM 缓冲；快速停止会等待 start 与 feed 链，启动/缓冲/feed/stop/无 final 失败均明确降级并阻止冻结不完整逐字稿。

这些修复提高了数据真实性和可恢复性，但没有消除第 2 节列出的生产阻塞项。

## 7. 真实设备与外部服务验收清单

在 RELEASE-01 重新评估前，至少完成并留证：

1. 真实 Mac：麦克风首次允许、拒绝、从系统设置恢复、睡眠/唤醒、输入设备断开/切换。
2. 冻结 ASR 模型：连续语音 partial、停顿 endpoint final、短语音、无语音、长录音、停止尾句、模型缺失、中断重连、资源占用。
3. 网络：录音中断网、恢复、请求重复、迟到 AI、Deep 报告失败和应用重启后的队列恢复。
4. 冻结 AI provider/model：live_hint 配置同意 + 每轮 AI ON；deep_diagnosis/comparison payload 预览、逐次批准、撤回、超时、失败、迟到丢弃和审计记录。
5. 数据：未同意时 `rawAudioIncluded=false`，原始音频不长期保存；同意后的本地文件权限、回放、删除、清理和重置可验证。
6. 内容：每模式题量/场景/Rubric 达标，离线 fallback、黄金样本、边界样本和专业教练双盲评审通过。
7. 性能：在目标硬件上记录实际 partial/final 延迟、内存、CPU、长会话稳定性和包体；在预算冻结前只报告数值，不写“达标”。
8. 安全分发：迁移受限自定义 renderer 协议，关闭 `GrantFileProtocolExtraPrivileges`，清理未使用权限描述并重跑 packaged security smoke。
9. 视觉/无障碍：在真实 Electron 中验证 125% 缩放，并对 S00/S01/题库/历史/设置/Deep/Drill/Comparison 做 approved.pen 逐屏 diff。

## 8. 发布建议

保持版本标识为 `0.1.0-alpha.0`。下一发布门槛应优先关闭：

1. 真实 VAD + ASR 断线/尾句恢复；
2. 三用途同意与 Live/Deep AI transport；
3. 纠正后的证据、报告、焦点和比较版本化重算；
4. 生产内容包与专业评审；
5. 首次环境检查和完整设置/数据治理；
6. 受限自定义 renderer 协议、fuse 收紧与权限清理；
7. 全产品视觉 diff、真实 Electron 125% 和可重复 Electron 真 E2E/真实设备验收。

在以上项完成并重新跑过完整自动化、真实浏览器、打包、真实设备及外部服务矩阵之前，总体结论保持 **NOT READY**。
