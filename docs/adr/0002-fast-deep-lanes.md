# ADR-0002：Fast Loop 与 Deep Lane 的冻结边界

- 状态：Accepted；生产接线完成
- 日期：2026-07-17
- 修订日期：2026-07-21

## 决策

Fast Lane 使用同一个 `LiveAttemptEvent → LiveAttemptState` 幂等状态机承接权限、录音、语音检测、ASR partial/final、本地标注、AI 短提示、降级、尾句和快照持久化。Deep Lane 只读取持久化 Session `taskSnapshot`、冻结 `AttemptSnapshot`、带版本纠正与持久化产物，不读取迁移中的 React draft。

```text
official model installer → verified local ASR preflight
                                  ↓ ready
selected getUserMedia / MediaRecorder ─────→ session audio capture
              │                                  └→ local Blob PCM fallback
              │
              └→ AudioContext actual-rate PCM → VAD / rolling watchdog
                                                → streaming resample 16 kHz
                                                → narrow preload → LocalAsrService(Sherpa)
                                                    ↓ partial / final
LiveAttemptEvent → generation-safe reducer → final-only rules / metrics → S04 ledger
                                                    ↓ cumulative final only
                                       consent + Attempt AI ON
                                                    ↓
                                   OpenAI live_hint (provisional)

stop → MediaRecorder stop + final PCM watermark → drain start/feed/tail
     → at least one final → safe_end → freeze AttemptSnapshot → SQLite
                                                       ↓
Session taskSnapshot + snapshot + corrections → persisted diagnosis card
                                             ↘ exact-payload deep_diagnosis
                 ├→ save analysis-only
                 ├→ free retry ────────────────────────────┐
                 └→ one focus → inline Drill → retry ──────┤
                                                           ↓
                                             save retry or view exact paired-1
                                             ↘ exact-payload comparison
```

Fast 快照持久化成功是进入 Deep 的硬门；云端报告从不占用录音、ASR、本地规则或快照持久化轨。

## Fast Lane 边界

### 事件与幂等

- generation 不匹配或 event id 重复的事件直接丢弃；已 final 的 segment 不被旧 revision 改写。
- partial 按相同 segment id 和更高 revision 覆盖，只存在于实时状态，不持久化、不生成正式证据。
- 连续 partial 的 grapheme 最长公共前缀只用于表现层稳定化：稳定前缀与可修订后缀保持一份可访问文本；generation/final/空文本变化会重置。它不改变 reducer、正式证据或快照边界。
- final 只追加一次；旧 sequence、重复 final、乱序或迟到事件不会重复统计、标注或触发 AI。
- 只有 final 进入九类本地反馈：filler、hedge、vague、repetition、self-correction、long-pause、speech-rate、structure、task-gap。后两类在 final 尾句收束时使用冻结 task context 协调，并保持幂等、稳定 O 编号和迁移/撤回历史。
- 指标只从当前 final 与未撤回证据重算；左侧只划真正存在的精确 span。

### 录音、语音检测与 ASR

- 开始录音前必须通过本地模型检查。模型缺失时练习页/设置页可触发固定官方 Release 安装，并通过只读窄接口轮询阶段、已下载/总字节与百分比；安装由主进程先做可用空间预检，再以冻结的官方 SHA-256 在下载过程中流式校验精确归档，只提取固定三个普通运行文件并检查最低尺寸，最后以 staging + 原子 promotion + 回滚完成。Renderer 无权指定下载、文件路径或 tar 参数，只能发起、读进度或取消该安装用例；24 小时总超时、应用退出和下次启动分别负责中止或清理未完成 staging。
- 麦克风可按设备枚举并使用 exact `deviceId` 选择；权限后展示实际 track 标签与采样设置。约 2 秒持续近静音显示当前设备、RMS/Peak 健康告警但不停止，信号恢复会回到 healthy。录音与 PCM 使用同一 MediaStream；分析节点接零增益 sink。
- AudioContext 可能忽略请求的 `16 kHz`，因此采集链读取实际 `audioContext.sampleRate`，跨 chunk 保持连续相位重采样后才向 ASR 发送真实 16 kHz PCM。VAD 同时参考 RMS 与 Peak；非空 ASR final 仍是比本地电平更强的有效语音证据。
- PCM 主通道使用仓库内静态、same-origin AudioWorklet 资产，保持生产 `script-src 'self'`；worklet 按 1,024 frame 发送并在停止时 flush 尾块。Electron 暴露 AudioWorklet 但不调度回调时，使用 2,048 frame 的有界 ScriptProcessor 兼容通道；两条 transport 共用同一重采样、VAD、ASR、停止与快照逻辑。
- readiness probe、实时转写和离线 benchmark 共用同一生产 recognizer profile。当前 endpoint trailing-silence rule 1/2 分别为 1.8 s / 0.8 s；任何延迟改善仍需用人工 speech spans 和真实 capture → render 测量证明，配置值本身不是 SLA。
- 2 秒滚动 watchdog 同时覆盖 PCM 从未启动与录音中途停止回调；只自动尝试一次 `AudioContext.resume()` 并观察 1 秒。PCM 中断事实具有 Attempt 级粘性，即使回调恢复也不能假装缺失区间不存在。
- 停止意图后保留约 300 ms 的单块 PCM 尾窗，再比较录音时长与 16 kHz PCM sample clock。零 callback、已报告停滞或明显时长缺口会从同一个 MediaRecorder Blob 在 Renderer 本地 decode/downmix/resample，替换不完整 PCM 后再走一次无-final恢复；Blob/PCM 不进入云端。解码最多等待 15 秒；恢复中的离页、重录、超时或迟到 start 都会 best-effort 关闭旧 recognizer。解码失败或已有 final 时不允许从样本零重放。
- 录音最长 5 分钟；8 秒未检测到语音会显示 no-speech 状态，20 秒以下停止需要用户明确接受短录音。
- ASR 启动期间最多缓冲 8 秒 PCM；实时 feed 队列同样有上限。启动/feed/stop 各有 8 秒操作超时。
- 本轮 PCM 最多保留 5 分钟用于一次恢复。没有 final 时，feed/tail/启动失败可进入 `reconnecting`，恢复前清除旧 partial、重建 recognizer 并重放捕获 PCM；用户也可在模型恢复后对同一段已录音频显式重转。已有 final 后禁止从样本 0 重放，防止双账本；无保留 PCM 时不展示无效重转动作。仍无 final 或恢复失败则明确降级并保留回放。ASR 时间码由已接受的 16 kHz sample clock 生成，不读取离线重放墙钟。
- 停止会立即关闭实时 AI并取消请求，但 ASR 收束要先等待 MediaRecorder stop 与最后 PCM watermark，再 drain start、feed queue 和 tail。stop event 最多等待 5 秒，超时清理资源并明确失败。只有录音 Blob、tail、冻结任务协调和至少一个 final 都完成才进入 `safe_end`；空逐字稿绝不形成 Attempt 快照。
- 快照冻结 final segments、annotations、hint lifecycle、final-only metrics、audio watermark、transcript/focus version 和 Attempt 身份。相同候选的持久化失败或 8 秒写入超时可以重试；持久化成功后才对 Deep 可见，并显示明确的“继续：确认逐字稿 / 选择下一步”。

### 实时 AI

- `live_hint` 使用配置级同意，但每次 Attempt 仍需显式 AI ON；离线、关闭或撤回会取消在途请求。
- payload 只含冻结任务字段、Rubric 和累计 final 窗口；禁止 audio、raw audio、partial 与临时 UI 状态。
- 策略版本固定窗口上限、最小新增 final、防抖、冷却、最多请求数和 12 秒超时；同窗口去重，新请求 supersede 旧请求，generation / phase / transcript / request sequence 防止迟到结果迁移到新状态。
- accepted hint 为 provisional；后续提示会迁移旧提示，关闭/撤回会保留其 lifecycle 历史。任何 AI 故障只降级到 local-only。

## S04 证据工作区

- 每个 final 句段形成一个左右共享 CSS Grid 行：左侧原句，右侧同句问题与短建议；整本账只有一个纵向 scroller。
- 精确词组以语义色、线型和 O 编号标记；右侧用相同编号/颜色显示类型、证据、建议、来源与 lifecycle。
- 点击任一侧 O 编号会定位同一证据；撤回或纠正后的记录保留锚点并转为中性历史。
- 关闭实时反馈只隐藏划线、O 编号、记录、提示、图例和问题统计，不删除 transcript，也不改变录音、ASR、停止或快照状态。
- 标准/紧凑均可进入证据全屏；普通与全屏共用同一 ledger、状态和停止逻辑。进入/退出保存可见 segment id + 相对 offset，Esc 退出并把焦点还给触发按钮。

## Deep Lane 边界

### 冻结输入与纠正

- Session 创建时冻结任务版本、语境、Rubric、焦点候选、Drill 定义和 criterion→Drill 映射；Deep 会验证 Session / Attempt / Snapshot / task identity。
- Deep 逐字稿基于 final snapshot；用户纠正以 `TranscriptCorrection` 追加，原始 final 永不覆写。
- 纠正改变精确词组时，原证据转为 withdrawn history；Deep payload 的 transcript version 随纠正递增，旧云端结果转为 superseded history。

### 历史结果与冻结实时证据

- 每条完成记录提供两个同级视图。“诊断结果”读取当前纠正版本和当前有效证据，按结论、证据、唯一焦点、下一步组织；“实时证据”读取指定 initial/retry `AttemptSnapshot` 的原始 final、时间码、O 编号、标注与提示 lifecycle，不从当前 React 状态重建。
- S04 实时账本与历史证据页复用同一个纯行渲染核心；历史页只更换冻结数据适配层，不伪造 `LiveAttemptState`、录音状态或 partial。partial 仍是可替换的临时态，不进入快照，因此历史页明确说明边界而不生成假内容。
- 用户纠正不能覆盖冻结原句。诊断视图按纠正后的文本判断；证据视图继续显示当时听写的原始 final，并把已受纠正影响的 O 记录保留为中性历史态。这样“当时系统看到了什么”和“现在认可的文本是什么”都可追踪。
- initial/retry 使用 Attempt identity 精确选取快照，分别标为 A1/A2；不再按 `kind` 猜第一个旧 artifact。两个视图共享同一 Session 引用图，无需新增 SQLite 或 IPC 数据结构。
- 历史证据在 1440×960 与 1024×960 都保持左右两栏、句级共享行、单一纵向滚动上下文和零全局横向溢出；O 编号可双向定位，切换视图与 Attempt 使用可访问 tab 语义和键盘操作。

### 复盘、焦点、Drill 与比较

- 本地确定性复盘先可用并异步保存，依据当前任务 Rubric、冻结证据和纠正版本；保存成功后先以诊断卡显示结果，没有规则级问题时明确说明仍需按 Rubric 检查，不伪造诊断。
- 诊断卡是 Deep Lane 的结果入口，不强迫用户走完整训练序列。用户可保存诊断并结束；可跳过焦点/Drill直接复讲；也可选择唯一焦点、完成 Drill 后复讲。retry 冻结后可以保存并结束，只有用户明确选择时才进入同一口径比较。
- 这些分支不允许跳过持久化证据：结束诊断、跳过焦点或选择焦点都必须携带 exact `diagnosisReportId`，主进程证明它属于当前 initial snapshot、当前 correction-aware transcript version 且为 complete；Session 冻结该 ID。自由复讲的 retry snapshot 不得包含 focus version；焦点复讲必须有匹配的 Drill completion 与 focus version。
- 页面始终只允许一个焦点。默认来源为 `local_metric`；用户改选为 `self_directed`；只有用户点击采用完整 AI 复盘建议才记录为 `ai_evidence`。短 `live_hint` 无权选择焦点。
- Drill 必须来自冻结 task 的 criterion→Drill 映射；完成记录绑定 snapshot、focus version、criterion、Drill 与自检。
- 复讲冻结同一任务与唯一焦点。`paired-1` 只读取该焦点冻结的 `comparisonDimension` 和对应正式证据；其他问题总量不参与。只有 initial/retry final 完整、Session 相同、适用算法版本相同、focus version 有效且该维度证据可比时才给 improved/stable/regressed，否则返回 insufficient evidence；产物冻结可审计 basis，不生成总分。
- 查看比较必须携带 exact `comparisonArtifactId`；主进程验证它绑定当前 initial/retry frozen snapshot pair 与当前 criterion，并由 Session schema v7 冻结该 ID供历史详情复读。不存在、陈旧或仅结构相似的比较不能完成闭环。
- Session 从进入 completed/abandoned 终态转换开始冻结普通产物；迟到 Renderer 不能再追加纠正、报告、Drill 或比较改变已交付诊断。已存在的云产物可在 controller attestation、当前图复核与 append-only lifecycle 校验下补齐终态，但关闭后不能新建云任务。v5 旧 Session 缺 `diagnosisReportId` 时，已冻结 focus 会先按 criterion + Drill 唯一恢复；仍歧义时拒绝猜测。
- 历史详情保留两遍完整逐字稿、音频（若用户选择保留）、证据/提示 lifecycle、纠正版本、Rubric、唯一焦点、本地/云端报告与比较，可导出、继续或再练。

### 可选完整 AI 轨

- provider/model/endpoint 固定为 OpenAI Responses / `gpt-5.6-terra` / `https://api.openai.com/v1/responses`；Renderer 不能覆盖。
- `deep_diagnosis` 和 `comparison` 必须先显示可编辑 exact JSON。允许删减或编辑文本，但 Session、Snapshot、Attempt、句段锚点、版本、冻结任务、唯一焦点等身份字段不可改。
- 用户确认后，后台规范化 JSON、计算 payload hash 并生成批准摘要；每个 hash 只批准一次。纠正、复讲版本或重试产生新 payload，必须重新批准。
- 生命周期按 queued → processing → complete/failed 保存；纠正或比较输入变化可转 superseded。持久化的 Deep queued/processing 在重启后可由用户继续同一获批 payload，不重新准备同意；同进程完全相同的恢复会合并为一次 provider 请求。失败显示稳定错误码和适用的重试：临时网络/服务错误可重试同一获批 payload；同意失效则必须重新审核 exact JSON。
- 完整 AI 报告每条 observation 必须引用获批 Rubric、final segment 或确定性 metric；唯一焦点/Drill 必须存在于获批任务。AI 结果只能补充本地轨，不能覆盖本地比较或未经用户动作改换焦点。

## 状态与降级

主路径：

```text
待授权/待录音 → 录音中 → 检测到语音 → partial
→ final 落定 → 本地标注完成 → AI 处理中 → 短提示到达
→ 尾句收束 → safe_end → 快照持久化 → Deep Lane
```

Capture、ASR、Analysis、Network 与 Deep report 并行表达，不合并为一个“成功/失败”。

| 分支 | 明确状态/反馈 | 恢复或边界 |
| --- | --- | --- |
| 麦克风拒绝/设备断开/录音器失败 | permission denied / interrupted + 文案 | 系统设置恢复或重新录制；该遍不冻结 |
| 输入持续近静音 | silent + 当前输入设备 | 继续录音；检查系统输入音量，停止后切换设备再重录 |
| PCM 回调未启动/停滞 | pcm unavailable + 同一遍恢复说明 | 一次 AudioContext resume；停止后从同一 MediaRecorder Blob 本地恢复，无 final 才允许重放 |
| MediaRecorder stop event 超时 | capture error + 明确文案 | 5 秒后清理 track/AudioContext；该遍不冻结，检查设备后重录 |
| 8 秒无语音 | no_speech | 继续说话会恢复；停止后仍由 final 完整性门判断 |
| 短于 20 秒 | 短录音确认 | 用户接受或重录 |
| ASR 缺模型 | recording preflight blocked / installing / failed | 安装并校验官方模型后再录；已有无-final PCM 可原地重转 |
| ASR 启动慢/feed/tail 失败 | degraded / reconnecting / failed | 无 final 时一次 PCM 重放；已有 final 或无 PCM 时保留证据/回放并重录 |
| 冻结任务上下文读取失败 | task context failed | 保留 final，阻止 task_gap/tail/快照；原位重试同一冻结 Session |
| 网络断开/恢复 | offline / online | 本地轨继续；恢复后只追加未发送 final |
| AI 关闭/撤回/超时/失败/迟到 | ai_off / local_only / ai_failed / stale | 取消在途，保留 lifecycle；本地轨继续 |
| 快照保存失败 | report failed | 停留本页，用同一候选重试，Deep 不读取内存替代品 |
| 本地 Deep 产物保存失败 | 明确错误 | 冻结逐字稿仍可用，重载/重试不改快照 |
| 云端报告/比较失败 | failed + 错误码 | 本地报告/比较继续；按同意状态重试或重新批准 |

## 动效与 reduced motion

partial 使用低频临时态，final/精确划线/右栏记录/尾句/降级条使用短距离、低振幅动效。系统 `prefers-reduced-motion` 将非必要动画和 transition 压至约 `0.001ms`，应用设置压至约 `0.01ms`；两者都关闭 smooth scroll，仍保留所有文字、状态、定位、全屏和停止操作。

## 验收证据

- Production Closure 基线见 [2026-07-18 验收](../acceptance/2026-07-18-production-closure.md)与[对抗性加固](../acceptance/2026-07-18-adversarial-hardening.md)。
- 柔性结果分支、exact report/comparison 身份门、stable partial、静态 AudioWorklet 与探索性延迟证据见[2026-07-21 验收](../acceptance/2026-07-21-flexible-results-streaming-latency.md)。
- 历史诊断层级、initial/retry 冻结证据回放、纠正历史与两栏 Electron 验证见[练习结果双视图验收](../acceptance/2026-07-21-record-result-evidence-views.md)。
- 当前模型与候选替换的采用/候选/拒绝理由见[Typeless 替代路径研究](../research/2026-07-21-typeless-alternatives.md)，离线指标定义见[本地 ASR 离线基准](../local-asr-benchmark.md)。
- 自动化受控轨不能冒充真实麦克风、人工准确率标准集、真实 capture → render 延迟或云调用；这些边界必须在对应日期的验收记录中分别标明。

## 被取代的状态

本 ADR 的 2026-07-17 版本曾标记“部分采用”，原因是 Deep 依赖 App draft、云端 transport/同意/报告 lifecycle 未接线。上述缺口已由 2026-07-18 实现取代；历史审计仍作为阶段证据保留。
