# 本地 ASR 离线基准

这个工具使用 Phrio 已安装且 receipt 完整的 Sherpa bilingual 模型，对自备的 16-bit PCM WAV 做双遍流式基准：一遍按 1.0× 音频时钟分块喂入以观察 partial / endpoint，另一遍不等待地喂入以计算稳态 RTF。它不会下载模型、访问网络或把音频和逐字稿发出本机。

仓库不包含真实录音，也不包含模型。默认示例 manifest 的三条 fixture 都有明确 `skip`；直接运行只会输出 `status: "skipped"`、`model: null` 和空指标，不会生成或伪造延迟、准确率数字。

## 运行

先在 Phrio 内完成本地模型安装。macOS 默认读取：

```text
~/Library/Application Support/Phrio/models/sherpa-onnx-streaming-paraformer-bilingual-zh-en/
```

查看帮助或验证仓库的显式 skip：

```bash
pnpm benchmark:asr -- --help
pnpm benchmark:asr
```

真实基准建议复制示例 manifest 到一个不提交的本地目录，把 WAV 放在该 manifest 所在目录内，再移除对应条目的 `skip` / `skipReason`：

```bash
pnpm benchmark:asr -- \
  --manifest /absolute/private/asr-fixtures/manifest.json \
  --output /absolute/private/asr-fixtures/report.json
```

可用参数：

- `--model-dir <path>`：直接指向已安装模型目录；也可设置 `PHRIO_ASR_MODEL_DIR`。
- `--chunk-ms <20-1000>`：覆盖 manifest 的分块时长。默认 `64 ms`，对应主 AudioWorklet 在 16 kHz 下聚合的 1,024 个 frame；兼容 ScriptProcessor 仍使用 2,048 frame。
- `--output <path>`：原子写 JSON；不指定则报告写到 stdout，进度只写 stderr。
- `--compact`：输出单行 JSON。

经 `pnpm` 管道消费 stdout 时要加 `--silent`，否则 pnpm 自己的脚本横幅也会进入 stdout；自动化更推荐直接用 `--output`：

```bash
pnpm --silent benchmark:asr -- --compact | jq '.status'
```

任何 active fixture 失败都会保留一条 `status: "error"` 且 `metrics: null`，进程退出码为 1；跳过项始终是 `metrics: null`。工具不会把缺文件、空结果或失败样本从计数中静默移除。

## Manifest v1

机器可读 Schema 位于 [`fixtures/asr-benchmark/manifest.schema.json`](../fixtures/asr-benchmark/manifest.schema.json)，无音频示例位于 [`fixtures/asr-benchmark/manifest.example.json`](../fixtures/asr-benchmark/manifest.example.json)。核心结构：

```json
{
  "$schema": "./manifest.schema.json",
  "schemaVersion": 1,
  "defaults": { "chunkMs": 64 },
  "fixtures": [
    {
      "id": "unique-local-id",
      "audio": "audio/example.wav",
      "reference": "人工核对后的参考文本",
      "language": "zh",
      "speechSpans": [
        { "startSample": 3200, "endSample": 28640 }
      ]
    }
  ]
}
```

规则：

- `id` 在整个 manifest 内唯一；`audio` 必须是 manifest 目录内的相对 `.wav` 路径，禁止绝对路径和 `..` 逃逸。稳定数据集建议同时填写可选 `audioSha256`，不匹配会在解码前失败；无音频的 skip 示例不填占位 hash。
- WAV 必须是 RIFF/WAVE、`WAVE_FORMAT_PCM`（format 1）、16-bit；支持 1–32 声道并确定性平均为 mono，支持 8–192 kHz 并线性重采样为 16 kHz。单文件上限 512 MiB，音频时长上限 60 分钟。
- 每条 active fixture 必须提供 `speechSpans`。`startSample` 是 inclusive onset，`endSample` 是 exclusive offset，二者都基于工具 downmix / resample 后的 canonical 16 kHz mono PCM sample clock；spans 必须满足 `0 <= start < end <= canonical sample count`，按时间递增且不可重叠。JSON Schema 覆盖字段类型与安全整数上限；`end > start`、跨 span 的顺序 / 重叠，以及与实际解码音频长度的 bounds 属于可执行 manifest loader 的 runtime 校验。skip 示例可省略，因为没有真实音频可标注。
- `language` 只能是 `zh`、`en` 或 `mixed`。规范化后的 reference 必须含对应评测单元；`mixed` 必须同时含汉字与英文 token。
- `mixed` 必须提供至少一个人工确认的 `keyTerms` 对象：`canonical`、可选 `aliases`、准确的 `occurrences`。所有 pattern 归一后必须全局唯一；工具以 longest exact token sequence 做一对一匹配，并要求 reference 实际出现次数与标注完全一致。hypothesis 超出标注次数的匹配计入 `hallucinatedOccurrences`；不做模糊、同音或未经批准的别名匹配。
- `skip: true` 必须同时给 `skipReason`。skip 条目允许指向未提交的占位 WAV，因为执行器在读取文件前就会跳过。

真实录音、用户数据和外部模型仍不得提交到 Git。报告包含完整 reference、hypothesis、命中与漏掉的关键术语，也应按敏感材料保存。

## 指标口径

### 流式时序

同一 WAV 使用同一生产 recognizer 配置和同一 chunk，分别运行：

1. `latency run`：模型已加载，按单调时钟 1.0× 喂入；sample index 除以 16 kHz 得到本次虚拟 1.0× playback 的 annotated onset / offset 墙钟锚点。每个 span 的 `firstPartial` 只接受落在 onset / offset 内的首个非空、非 final、相对上次确实变化的文本，延迟严格从该 span 的 annotated onset 计算；span 内没有 partial 就记 miss，span 外 partial 单独计数，不能拿 stream start 代理。`activeSpeechGapsMs` 使用这次 paced run 的真实 partial 发出墙钟，完整纳入 annotated onset → first、changed partial 间隔、last → annotated offset；不会用 chunk 尾部的 delivered-sample 游标冒充更新间隔。若最后一次更新已晚于 offset，尾部 in-span gap 记 0；无更新 span 的整个标注时长就是一个 gap。
2. `RTF run`：模型已加载，不 sleep，顺序单流喂入同一 canonical PCM。`processingMs` 从开始喂入到 `inputFinished` 与尾部 decode 完成；`rtf = processingMs / audioDurationMs`。模型加载、读文件和重采样不进入 RTF，`modelLoadMs` 单列。汇总同时给逐 fixture 分布和 `microRtf = Σ processing / Σ audio duration`。

`finalLatency` 严格拆开：

- 每个 span 只消费其 annotated offset 之后、下一 span onset 之前的首个未使用 natural endpoint，`naturalFinalLatencyMs` 从 annotated offset 计算；没有 natural endpoint 就进入 `naturalFinalMisses`。早于 offset、跨入下一段或多余的 endpoint 不会被强行配对。
- `flushLatencyMs` 是最后一个 chunk 后调用 `inputFinished` 并取回尾部结果的墙钟耗时；`flushProducedFinal` 标明是否出现 forced-flush final。forced flush 永远不能填补 natural-final miss。

这些数字仍只证明 decoder adapter 相对 canonical PCM 标注的流式行为，不能宣称麦克风 capture → Renderer 的产品端到端延迟。发布 UX SLA 仍需另测 capture / resample / IPC / render 全链。

### 准确率

- `zh`：NFKC、转小写、移除空白/标点/符号后，以所有 Unicode letter / number 的单字符为单位计算 CER；不做繁简转换、同音容错或别名补偿。
- `en`：NFKC、转小写；Latin word 内 apostrophe 保留，hyphen 分词，数字为 token。非 Latin 幻觉保留为 insertion unit，不会被 tokenizer 静默丢弃。
- `mixed`：共同序列按“一个汉字 / 一个 Latin word / 一个 number”为 unit 计算 MER；同时保留 Han CER 与 English token WER 作为错误分解，不制造人为加权总分。关键术语按 manifest 的 occurrence / canonical / approved aliases 做一对一 exact recall，同时报告 precision 与 hallucinated occurrence count。

每项 error rate 都输出 `edits`、`referenceUnits`、`hypothesisUnits` 与 rate；空 hypothesis 会产生完整 deletion，不会被跳过。汇总按 `zh` / `en` / `mixed` 分组做 micro aggregation，避免混合两套不同分母。CER / WER 可以大于 1，不截断。

## 可复现性与边界

报告绑定 manifest SHA-256、源 WAV SHA-256、16 kHz mono Float32 canonical PCM SHA-256、模型 receipt / 逐文件 SHA-256、Sherpa 版本、Node / OS / 架构、生产 recognizer profile 及其 SHA-256。执行前会重新计算三个模型文件的 receipt hash 并真实初始化 recognizer；任何不一致都直接失败。

这仍不是发布门自动结论：fixture 的说话人、设备、噪声、内容难度与人工 reference 质量由数据集负责人保证。至少应分别覆盖安静/噪声、远近讲、快慢语速、中文、英文和 code-switch，并避免用同一说话人同时调参和验收。
