# 2026-07-21 柔性结果流程与实时转写延迟验收

## 结论口径

本轮把 Deep Lane 从强制线性流程改为“先得到诊断结果，再选择训练深度”，同时收紧终态的持久化证据门；Fast Lane 则通过 stable partial、静态 same-origin AudioWorklet、较小 PCM block 与共享 endpoint 配置降低等待和视觉抖动。

这不表示准确率或端到端延迟已经达到发布 SLA。本轮只有一条非人工标准稿的探索性本机样本；纯中文、纯英文、中英混合人工标准集以及真实打包 Electron 的 capture → render 测量仍是发布前置。

## 用户可选的结果路径

初讲完成后，Deep Lane 仍先读取冻结的 initial `AttemptSnapshot`、当前纠正版本和 Rubric，持久化一份完整 `deep_report`，然后立即显示精美诊断卡。诊断卡不是 Fast Lane 的实时短提示；它是当前冻结输入的 Deep 结果。

```text
initial snapshot + corrections + Rubric
                  ↓
       persisted diagnosis card
          ├─ 保存诊断，结束本轮
          ├─ 不选焦点，直接复讲 ───────────────┐
          └─ 选择一个焦点 → Drill → 同题复讲 ─┤
                                                ↓
                                      retry snapshot frozen
                                          ├─ 保存复讲，结束本轮
                                          └─ 查看同一口径对比
```

“可选”不等于任意跳过数据边界：

- 用户可以只保留诊断结果，结束为 `analysis_only`；
- 用户可以跳过焦点与 Drill，做一次自由复讲，结束为 `free_retry`；
- 用户可以选择唯一焦点，完成匹配 Drill 后复讲；此时可以不看比较，结束为 `focused_retry_without_comparison`；
- 只有用户明确进入且保存当前比较，才结束为 `practice_loop_completed`；
- Drill 仍绑定一个冻结焦点，不能在“无焦点”分支里生成伪 Drill；
- Fast Lane 与 Deep Lane 继续并行且职责不同，`live_hint` 永远不能冒充诊断卡或终态报告。

## 精确持久化证据门

页面按钮只能发起意图，主进程持久化引用图决定路径是否成立。

| 动作 | 必须携带/冻结的精确身份 | 主进程必须证明 |
| --- | --- | --- |
| 保存诊断并结束 | `diagnosisReportId` | ID 对应当前 initial snapshot、当前 correction-aware transcript version、`status=complete` 的 `deep_report`；至少有一个 final segment，完整引用图有效 |
| 跳过焦点并复讲 | `diagnosisReportId` | 同上；Session 冻结该 report ID，后续 retry snapshot 的 `focusVersion` 必须为 `null` |
| 选择焦点并开始 Drill | `diagnosisReportId` + exact focus | report 必须是当前有效报告；所选 criterion/drill 必须与该报告冻结的唯一焦点一致 |
| 保存自由复讲 | Session 已冻结的 `diagnosisReportId` | initial/retry 两份当前 Attempt snapshot 都存在且包含 final；retry 不得伪造 focus version |
| 保存焦点复讲 | Session 已冻结的 `diagnosisReportId` | 另须存在绑定 initial snapshot 与所选 focus 的 Drill completion；retry focus version 必须精确匹配 Drill |
| 查看比较 | `comparisonArtifactId` | exact artifact 必须绑定当前 initial/retry snapshot pair 和当前 criterion，并通过完整引用校验 |

Session 新增持久化 `diagnosisReportId`，终态不再依赖 Renderer 恰好还持有哪一张卡。旧 Session 只有在当前纠正版本恰好存在唯一有效诊断，且焦点与该报告一致时才允许确定性恢复；零份、多份或不匹配都要求回到诊断结果显式选择，不能静默猜测。

comparison 同样不再使用“当前列表最后一项”或结构相似对象。只有 exact `comparisonArtifactId` 可以把一次已持久化的当前比较标记为用户查看的闭环结果；SQLite schema v7 会冻结该 ID，历史详情优先读取它，只有旧记录没有该列时才使用兼容回退。

## Fast Lane 实时转写改动

### stable partial

- 两次连续 partial 以 grapheme 为单位计算最长公共前缀；较稳定前缀使用正文样式，仍可修订后缀使用临时线型/斜体和克制的 caret。
- 屏幕阅读器只读一份完整“临时转写”，视觉分片设置为 `aria-hidden`，不会重复朗读。
- generation、segment/final 或空文本变化会清空旧稳定性；表现层没有权限生成 annotation、统计、hint 或持久化 transcript。
- `prefers-reduced-motion` 与应用 reduced-motion 关闭非必要 partial 动效，但不隐藏文本或状态。

### 静态 AudioWorklet 与兼容通道

- PCM capture 与 microphone check 共用仓库内静态 worklet 资产；Vite 以 `?no-inline` 保持独立文件，通过开发源或打包后的 `phrio-app:` same-origin 加载。
- 不使用运行时 Blob/data worklet，不扩大生产 CSP；`script-src 'self'` 继续成立。
- worklet 将实际输入声道确定性 downmix，并每 1,024 frame 发出一个 PCM block；停止前显式 flush 尾块。在理想 16 kHz 输入下对应 64 ms，但实际 `AudioContext.sampleRate` 仍必须读取和记录。
- Electron 暴露 AudioWorklet 但不调度回调时，仍保留有界 `ScriptProcessor(2_048)` 兼容通道。兼容通道不是第二套 ASR 状态机，继续走相同重采样、VAD、IPC、stop/tail 和 snapshot 逻辑。
- 所有 chunk 按实际输入采样率连续重采样为真实 16 kHz；1,024-frame worklet 与 2,048-frame fallback 只限定各自 callback/IPC 量化窗口，不等于产品端到端延迟承诺。

### recognizer 与 endpoint

readiness probe、实时转写和离线 benchmark 共用 `LOCAL_ASR_RECOGNIZER_PROFILE`：

| 配置 | 当前值 |
| --- | ---: |
| sample rate | 16,000 Hz |
| threads / provider | 2 / CPU |
| decoding | `greedy_search` |
| rule 1 trailing silence | 1.8 s |
| rule 2 trailing silence | 0.8 s |
| rule 3 utterance length | 20 s |

较短 endpoint 目标是减少自然落句等待；它必须由真实语料监测截断、过度切句和 natural-final miss，不能仅凭配置变化宣称改善。

### 无正文延迟诊断

聚合诊断记录首 partial、changed-partial gap、partial → final、队列等待和计数，不记录 PCM、partial/final 正文或 AI 请求体。记录用于定位 transport、recognizer、endpoint 和 render 的责任段，不直接构成性能达标证明。

## 离线 benchmark 口径

`pnpm benchmark:asr` 使用 production recognizer 配置与已验证模型 receipt，对本地 16-bit PCM WAV 做两遍；默认 `chunkMs=64`，并可用 `--chunk-ms 128` 复现实验基线：

1. 1.0× paced run：以 canonical 16 kHz sample-index speech spans 计算首 changed partial、active-speech gap、natural endpoint 和 forced flush；
2. unpaced run：单流喂入同一 canonical PCM，计算 decoder RTF。

准确率按语言分别输出 zh CER、en WER、mixed MER，并保留 mixed Han CER、English WER 与关键术语 occurrence/canonical/approved aliases/hallucination 分解。forced flush 不能填补 natural-final miss，stream start 也不能冒充 speech onset。

仓库示例 manifest 只有三条显式 skip fixture，默认运行必须返回三条 `status=skipped` 且 `metrics: null`；缺少真实音频不能生成“0 错误”或延迟数字。

## 当前探索性证据

一条约 28.8 秒的本地录音被转为 canonical 16 kHz mono PCM。speech spans 由 FFmpeg `silencedetect=noise=-40dB:d=0.2` 近似标注，共 10 段；它不是人工 VAD/语义句段。

| 配置/观察项 | 结果 | 验收解释 |
| --- | ---: | --- |
| 128 ms first changed partial p50 / p95 | 925.919 / 1,522.784 ms | 调整前探索性 decoder/adapter 基线 |
| 128 ms first partial miss | 1 / 10 spans | 一段在近似 active span 内没有 partial |
| 128 ms natural final | 3 / 10 spans | endpoint 与粗分段对齐较弱；因标注粗糙，不作为发布指标 |
| 128 ms unpaced RTF | 0.02979 | 不含模型加载、音频读取、采集、重采样、IPC 或渲染 |
| 64 ms first changed partial p50 / p95 | 844.581 / 1,511.023 ms | 中位数比 128 ms 基线低约 81 ms；单样本不能外推 |
| 64 ms active gap p50 / p95 | 594.446 / 931.085 ms | 只覆盖 paced decoder partial 更新 |
| 64 ms natural final | 3 / 10 spans | 缩小 chunk 未改变这条粗标注下的 natural-final 计数 |
| 64 ms unpaced RTF | 0.027952 | 同一音频、本机、已加载模型的探索性吞吐 |

64 ms 与 128 ms run 的 hypothesis 相同；这只说明本次缩小 chunk 没有改变该样本的解码文本。它不证明文本准确，也不证明麦克风 capture → React render 更快。

这条样本的 reference 是旧机器假设稿，不是人工听写标准稿。任何由此产生的 CER、WER、MER、关键术语 recall/precision 或模型准确率结论都无效，不得进入发布材料。

## 自动化与真实 Electron 门禁

合并前至少执行：

```bash
pnpm typecheck
pnpm test
pnpm benchmark:asr
pnpm verify
pnpm verify:electron-product-tour -- --skip-package
```

自动化必须覆盖：

- diagnosis report 未保存、错误 ID、旧 correction version 或非 complete 时，分析结束/自由复讲/焦点路径全部拒绝；
- free retry 缺 retry snapshot、伪造 focus version 时拒绝；
- focused retry 缺 Drill completion、focus version 漂移时拒绝；
- comparison 缺失、错误 ID 或绑定旧 snapshot pair 时拒绝；
- 三个 terminal provider-response loss 路径通过 `getSession` 对账，不重复创建终态；
- stable partial 的 grapheme 前缀、重置、无障碍和 reduced-motion；
- static worklet URL、1,024-frame worklet、2,048-frame fallback、同一生产 recognizer config；
- benchmark 的 sample-index spans、边界 gap、natural/flush 分离、mixed MER 和术语 hallucination；
- 默认三条 skip 产生 `metrics: null`。

真实打包 Electron 还必须在 1440×960 与 1024×960 检查：

- S06 诊断卡先于焦点动作可见，三个分支均可执行且不会双击穿透；
- S09 保存复讲与查看比较为并列可选动作；
- 键盘焦点进入结果标题，操作失败可重试，控制台无错误；
- 结束录音、快照、诊断卡、可选 Drill/复讲/比较与历史详情在重载后仍可回查；
- 真实麦克风说中文、英文和中英混合时，partial 在同一句内稳定更新，final 不丢尾句。

### 最终执行结果

- `pnpm typecheck`：通过。
- `pnpm test`：54 个测试文件通过、1 个跳过；565 项测试通过、1 项跳过。
- `pnpm benchmark:asr`：通过；仓库内 zh/en/mixed 三条 fixture 均为显式 skip，`measured=0`、`metrics=null`，未生成伪造准确率或延迟。
- `pnpm verify`：通过 TypeScript、全量测试、Electron 系统网络探针、安装期 power blocker 探针、macOS arm64 package、18 个签名目标、39 方法 packaged bridge 与 Sherpa `1.13.4` dependency smoke。
- `pnpm verify:electron-product-tour -- --skip-package`：94/94，26 张截图；S00–S15 均可达，诊断结束、自由复讲、焦点 Drill、保存 retry、显式比较与历史图完成持久化对账。生产 console 0 error / 0 warning，自动化外部 HTTP(S) 请求 0。
- `pnpm verify:electron-visual`：85/85，9 张截图；1440×960 / 1024×960、100% / 125%、标准 / 全屏矩阵横向 overflow 为 0，只有一个 evidence scroller，共享行 top/bottom 差值均为 0 px，reduced-motion 可完整操作。

真实打包巡检还暴露并修复两条与功能本身无关但会让体验看似“卡死”的阻塞：macOS Keychain 不可用或锁定时，`safeStorage.isEncryptionAvailable()` 会同步冻结 Electron main，当前生产改用 0700/0600 本机私有 Key 文件；packaged bridge smoke 曾等待隔离 Session 的冗余 `clearStorageData()`，现移除该等待，临时 `userData` 仍在退出后 best-effort 清理。

最终对抗性审查再封闭两条持久化边界：旧 v5 Session 已冻结焦点时，会从多个 current report 中按 `criterionId + drillId` 唯一恢复 `diagnosisReportId`；Session 一旦进入终态音频处理即冻结普通 artifact，完成/放弃后不能由迟到 Renderer 追加纠正或比较使诊断失配。已存在的云 artifact 只允许在 controller attestation 与 append-only lifecycle 校验后补齐终态。

以上证明当前受控输入、持久化、页面、打包和布局闭环通过；它仍不证明人工 zh/en/mixed 准确率、真实麦克风 capture → React render SLA 或用户自有 OpenAI Key 的外部服务质量。

## 仍缺的发布证据

1. 纯中文、纯英文和中英混合的人工听写标准集；旧模型稿、LLM 清理稿和 ASR 自身输出均不能充当 reference。
2. 同机对比当前 Paraformer 与候选 bilingual Zipformer/FunASR 的准确率、首 partial、更新 gap、natural final、RTF、包体和资源占用。
3. 最终打包 Electron 的 capture → resample → IPC → recognizer → React render 端到端 SLA；离线 paced run 不覆盖这条链。
4. 真实设备的安静/噪声、近讲/远讲、快慢语速、长句、专名、数字和 code-switch 矩阵。
5. 若未来评估 Groq、DashScope、Cerebras 或其他云服务，必须另行取得凭据/费用授权、逐用途同意并记录音频/文本外发边界；当前实现不自动接入。

外部方案研究与采用/拒绝理由见[《Typeless 替代路径与实时转写研究》](../research/2026-07-21-typeless-alternatives.md)。
