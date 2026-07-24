# 2026-07-21 Typeless 替代路径与实时转写研究

## 结论

Phrio 不应把 Typeless 类产品直接复制成系统级语音输入法，也不应为了“看起来更快”把句末 LLM 润色伪装成连续实时转写。当前最适合的方向是：保留本地 Sherpa-ONNX Fast Lane，用稳定 partial 降低视觉抖动并用可复现基准筛选更合适的中英双语流式模型；Deep Lane 在冻结快照之后给出诊断卡，再由用户决定是否继续聚焦、Drill、复讲和比较。

本轮采用的是机制，不是项目结构：ASR 与后处理分轨、任务上下文只进入受控的后处理、失败时有明确回退。用户纠正驱动的候选术语进入后续候选；云端按语言路由、系统级全局粘贴和“ASR/LLM 差异自动当词典真值”均不进入当前生产基线。

## 研究问题与证据层级

本轮研究回答两个问题：

1. Typeless 类语音输入体验中，哪些机制能降低首字等待和结果不稳定感？
2. 哪些开源 runtime / 模型值得进入 Phrio 的中文、英文和中英混合离线基准？

证据按以下优先级使用：

1. Phrio 生产代码与本地可复现实验；
2. 项目官方仓库、官方文档与官方模型页；
3. 用户提供的小红书图文及其中可见截图，仅作为实现线索，不作为性能证明；
4. 未完整读取的动态评论不形成事实、需求优先级或技术结论。

## 小红书图文中的可借鉴机制

用户提供的[小红书图文《零成本替代 Typeless》](https://www.xiaohongshu.com/discovery/item/69a843f1000000001a02eece)描述了一条基于 OpenWhispr 的桌面语音输入改造路径。图文可见内容包含：

- 以 OpenWhispr 的 Electron 桌面能力为底座；
- 把 ASR 与 LLM 清理拆成两条职责不同的轨道；
- 按语言选择 ASR：英文示例使用 Groq Whisper Large v3 Turbo，中文/方言示例使用 DashScope Qwen ASR；
- 使用 Cerebras GPT-OSS-120B 做文本清理；
- 读取 `active-win` 的当前应用上下文，动态调整清理 prompt；
- 词典管线覆盖缩写折叠、跨 token 合并、实体纠正与大小写；通过原始 ASR 与 LLM 输出差异发现候选词；
- 文本写入目标应用失败时回退到剪贴板/一次性粘贴，避免结果丢失。

这些信息适合转译成 Phrio 的设计原则，但存在三条必须保留的边界：

1. 图文展示的主要路径是“句段结束 → 清理 → 写入”，不是已被测量的连续 partial，也不能证明“字随声出”的 capture → render 延迟。
2. 原始 ASR 与 LLM 改写之间的差异不是词典真值。LLM 可能改写语义、删减口语或产生实体；Phrio 只允许把重复出现、可追溯到用户纠正且由用户确认的专名作为候选术语。
3. Groq、DashScope 与 Cerebras 都涉及外部凭据、服务可用性、潜在费用和音频/文本出站。未经单独授权、同意与基准，不接入当前本地生产默认路径。

页面元数据表明存在评论区，但评论正文由动态登录态加载，本轮没有获得完整、可核对的评论集合。因此本文不引用评论观点、不统计支持率，也不据此声称任何模型达到准确率或延迟目标。

## 官方项目对照

| 项目 | 官方来源能证明什么 | 与 Phrio 的关系 | 当前结论 |
| --- | --- | --- | --- |
| Typeless | [官方产品页](https://www.typeless.com/)提供成品语音输入体验参照；它不是可审计的实现说明 | 用于校准低等待、低抖动和自然纠错的体验目标 | 体验基准；不把产品宣传当技术或 SLA 证据 |
| OpenWhispr | [官方仓库](https://github.com/OpenWhispr/openwhispr)公开 Electron 桌面应用、local/cloud ASR 选择、全局听写与粘贴回退 | 可参考 ASR/后处理分层、错误回退和桌面生命周期；不能复制其品牌、界面或项目结构 | 机制参考；不作为 Phrio runtime 替换 |
| OpenLess | [官方仓库](https://github.com/Open-Less/openless)公开 Tauri 语音输入、云/本地 ASR、词典 hotword、流式插入和一次性粘贴回退 | 可研究“感知延迟”与词典输入；其流式插入是润色文本写入行为，不等同 Phrio 的原始 ASR partial | 候选参考；不引入全局辅助权限或系统级粘贴范围 |
| Sherpa-ONNX | [官方仓库](https://github.com/k2-fsa/sherpa-onnx)与[在线 Transducer 文档](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/index.html)提供本地、跨平台、流式推理能力 | 已是 Phrio 主进程本地 ASR runtime，符合无账号、本地优先和窄 IPC 边界 | 已采用；继续共享同一生产 recognizer 配置和 receipt 校验 |
| 双语 streaming Zipformer | [官方 Sherpa 模型文档](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html)与[模型页](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20)提供中文/英文在线 Transducer 权重 | 可能改善首 partial、endpoint 与中英混合；仍需在同机、同 chunk、同人工标准集上和当前 Paraformer 对照 | 候选 challenger；未下载、未切换、未宣称更优 |
| FunASR | [官方仓库](https://github.com/modelscope/FunASR)公开 Paraformer streaming、VAD、hotword 与中英模型管线 | 适合在当前 Sherpa 模型无法达到人工标准集门槛时作为独立候选；引入 Python/PyTorch 或服务进程会扩大包体与运行架构 | 候选；只有基准显著获益且集成成本可接受时再做 spike |

OpenWhispr、OpenLess 和 FunASR 的仓库许可证只说明代码使用边界；具体模型权重仍需分别核对模型卡、revision 与许可证，不能用仓库许可证替代模型许可证。

## 采用、候选与拒绝

### 已采用

- Fast Lane 保持本地流式 ASR；Deep Lane 独立承担更准确的最终诊断，两条轨道不互相替代。
- consecutive partial 只做表现层稳定化：以 grapheme 最长公共前缀区分较稳定前缀与仍可修订后缀；partial 继续不持久化、不生成证据。
- AudioWorklet 使用静态、same-origin 资产，保持生产 CSP `script-src 'self'`；主 worklet 以 1,024 frame 聚合，兼容通道保留有界 2,048-frame ScriptProcessor，而不是运行时 Blob worklet。
- recognizer readiness、实时转写、离线 benchmark 读取同一份配置和模型 receipt，避免“测试模型”和“产品模型”漂移。
- 词典输入边界已冻结：未来若实现术语学习，只能从可追踪的用户纠正产生候选，并经过重复证据和用户确认；不会把 LLM 改写直接写入词典。
- 诊断结果先以卡片呈现；后续聚焦、Drill、复讲和比较由用户选择，完整报告仍基于冻结 Attempt。

### 候选

- bilingual streaming Zipformer：优先进入同一离线 harness 的 challenger 对照。
- FunASR streaming Paraformer：如果 Zipformer 与现模型仍不能覆盖真实中英混合语料，再评估独立 spike。
- 任务上下文辅助最终文本：只可作用于 correction-aware final/Deep 轨，不能偷偷改写 Fast Lane 原始 final 和证据锚点。
- 用户纠正驱动的专名候选：先做可审计候选队列与命中统计，再考虑 hotword 注入。

### 当前拒绝或延期

- 直接复制 OpenWhispr/OpenLess 的代码、界面、品牌、全局快捷键和系统级粘贴权限。
- 未经授权按语言自动把音频发送到 Groq、DashScope 或其他云 ASR；也不因文章推荐而引入 Cerebras 清理。
- 用句末 LLM 流式输出掩盖 ASR 尚未产生 partial，或把“逐字符写入”描述成“逐字识别”。
- 用旧模型输出、LLM 改写或自动对齐稿作为准确率 reference。
- 在没有人工中英混合标准集前替换当前 production model。

## 当前探索性本机样本

本轮对一条约 28.8 秒的本地录音做了只读探索。speech spans 由 FFmpeg `silencedetect=noise=-40dB:d=0.2` 近似标注，不是人工逐帧 VAD；因此以下结果只能定位当前延迟形态：

| 配置/指标 | 探索性结果 | 可得结论 |
| --- | ---: | --- |
| 标注 speech spans | 10 | 只是粗分段，不代表真实语义句段 |
| 128 ms 首个 changed partial p50 / p95 | 925.919 / 1,522.784 ms | 这是调整前基线，不是端到端产品 SLA |
| 128 ms 首 partial miss | 1 / 10 spans | 至少一段在其近似 span 内没有 partial |
| 128 ms natural final | 3 / 10 spans | endpoint 与粗标注不匹配明显；因分段近似，不能作为发布指标 |
| 128 ms unpaced RTF | 0.02979 | 仅说明已加载模型在该音频上的 decoder 吞吐 |
| 64 ms 首个 changed partial p50 / p95 | 844.581 / 1,511.023 ms | 同一音频的中位数下降约 81 ms；单样本不能外推 |
| 64 ms active gap p50 / p95 | 594.446 / 931.085 ms | 只覆盖 paced decoder partial 更新，不含 capture → render |
| 64 ms natural final | 3 / 10 spans | 缩小 chunk 没有改变这条粗标注下的 natural-final 计数 |
| 64 ms unpaced RTF | 0.027952 | 只说明该音频、本机、已加载模型的 unpaced run |

64 ms 与 128 ms run 产生相同 hypothesis；这说明本次缩小 chunk 没有改变该样本的解码文本，不说明文本正确。两次 run 都没有覆盖麦克风采集到 React 渲染的端到端链，只能视为探索性 decoder 趋势。

这条样本的 reference 来自旧机器上的假设稿，不是人工听写标准稿。由它计算出的 CER、WER、MER 或术语命中全部无效，本文不记录、引用或据此比较模型准确率。

仓库默认 benchmark manifest 只有中文、英文和中英混合三条显式 skip fixture；在没有本地私有录音时，三条都保持 `metrics: null`。这个行为是防伪门，不是“没有错误”。

## 下一道证据门

在宣称“更快、更准”或替换 production model 前，至少需要：

1. 人工听写并复核的纯中文、纯英文、中英混合标准集，包含真实专名、数字、缩写、快慢语速、近远讲和噪声；
2. 用相同 canonical 16 kHz PCM、相同 chunk、相同设备分别跑当前 Paraformer 与候选 Zipformer/FunASR；
3. 报告 zh CER、en WER、mixed MER 及术语 occurrence/alias/hallucination，不能只报一个合成分数；
4. 在真实打包 Electron 中测量 microphone capture → resample → IPC → recognizer → React render 的首 partial、更新 gap 与 final 延迟；
5. 将准确率、延迟、模型体积、首次安装、CPU/内存和授权/隐私成本共同纳入替换决策。

在这些证据完成前，Zipformer 和 FunASR 都只是候选，现有探索性数字也不是发布 SLA。
