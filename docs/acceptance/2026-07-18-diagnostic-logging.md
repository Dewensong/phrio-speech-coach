# Phrio 本地诊断日志验收

日期：2026-07-18
范围：Internal Alpha 的真实体验、故障复现与后续迭代取证

## 结论与边界

Phrio 现在具备本地、结构化、可导出的诊断日志轨。它用于回答“哪一步发生了什么、先后顺序如何、哪个 Session/Attempt/operation/request 相关、失败属于哪类”，不替代录音、ASR、AI 或训练结果本身的验收。

本轮只保留冻结产品源要求的最小数据边界：

- 日志只落本机，不做遥测、后台上传、账号同步、自有后端或远程开关。
- 应用日志最多保留 7 天；单个 JSONL 文件最多 5 MB，总量最多 25 MB，超限时先删除最旧文件。
- 不写原始音频、PCM 样本、partial/完整逐字稿、AI prompt、请求/响应体、Authorization 或 API Key。
- “清除训练数据”同步清除应用管理的诊断日志；用户主动导出的 JSON 是外部文件，由用户自行管理。

这不是一套复杂的隐私或分析平台。它没有采样规则后台、数据上报管道、用户画像、埋点看板或长期归档。

## 架构与数据流

```text
Renderer / recording / Fast / Deep
              │ 窄 schema 事件（不含正文）
              ▼
      36-method preload bridge
              │
Electron main / IPC / ASR / AI / persistence / window
              │ 单写入器、全局序号、run/incident/correlation ID
              ▼
      userData/diagnostics/*.jsonl
              │
              ├── 设置页查看状态 / Finder 打开目录
              ├── 用户显式导出 validated JSON bundle
              └── 单独清除或随训练数据一起清除
```

每条事件使用固定 `diagnostic-event-1` schema，包括：时间、单调时钟、运行 ID、递增序号、级别、组件、事件名、可选 Session/Attempt/operation/request ID、扁平元数据和可选 incident ID。错误只保留错误类型、稳定错误码、短栈帧和指纹，不保留可能含用户正文的异常消息。

写入失败不会打断练习主流程；事件会暂存于最多 2,048 条的有界内存缓冲，并在后续写入、状态读取或导出时重试。缓冲满时优先保留更高严重度事件并累计丢弃计数；恢复时每个主线程 turn 最多落盘 64 条，批次间主动让出事件循环。设置页同时显示待写入、已丢弃与累计写入失败数，便于识别日志本身是否不完整。高频 ASR partial 元数据按 1 秒采样，final、失败、恢复和用户操作不采样。

## 用户入口

入口：`设置 → 常规与隐私 → 本地诊断日志`

| 操作 | 实际效果 |
|---|---|
| 刷新状态 | 读取日志文件数、总占用、内存待写入数、已丢弃数、写入失败数、最近 incident ID 和实际目录 |
| 打开日志目录 | 通过系统 Finder 打开应用管理目录，不把目录内容发送到外部 |
| 导出诊断包 | 打开系统保存面板；用户确认位置后生成一个经过 schema 校验的 JSON 副本 |
| 清除诊断日志 | 删除应用管理的 JSONL 和待写入事件，不删除练习、模型或已导出文件 |
| 清除训练数据 | 既有云端 exact payload/audit 和本地训练图按既定顺序清除后，同时清除应用管理日志 |

## 自动化证据

本轮定向命令：

```bash
pnpm exec vitest run \
  tests/integration/diagnostic-data-governance.test.ts \
  tests/unit/diagnostic-log-service.test.ts \
  tests/e2e/diagnostics-settings.test.tsx
```

结果：PASS，3 个测试文件、20 项测试。

覆盖内容：

- 有序 JSONL、私有目录/文件权限、运行/事件/incident 身份。
- 禁止内容字段、Key/Bearer/Home 路径脱敏和错误指纹。
- 跨 8 天长进程的事件级清理、每日/5 MB 文件轮换、25 MB 总量上限、最旧优先删除。
- 写入失败不阻塞产品轨并可重试；2,048 条有界缓冲、64 条分批恢复、严重度保留、丢弃计数与恢复顺序；部分写入异常先回滚到原文件长度，损坏行不进入导出事件且有计数。
- 清空 generation 隔离：由统一 IPC 封装的旧 operation completion/failure span 不会在清空后迟到复活；仍在运行的录音、ASR 或 AI 若产生新的产品事件，会作为清空后的新日志继续记录。当前 run 可继续递增写入。
- Session、Attempt、operation 和 artifact 语义关联；AI accepted/duplicate/disabled/late/timeout/failed 结果只记录原因与序号，不记录提示正文。
- 设置页的状态、重试、打开、导出、取消导出、清除和失败反馈。
- “清除训练数据”清除本机日志，同时保留用户显式导出的诊断包。

本轮完整门禁结果：

```bash
pnpm verify
pnpm verify:electron-visual
pnpm verify:electron-product-tour
```

- 完整回归：PASS，41 个测试文件 / 347 项；`pnpm verify` 已通过 macOS arm64 package、36 方法 packaged bridge smoke、本地 Sherpa 原生依赖 smoke。
- Electron visual：PASS，85/85 assertions、9 张矩阵截图。
- Electron product tour：PASS，90/90 assertions、23 张截图；打包产品 console 0 error / 0 warning、外部 HTTP(S) 请求 0。
- 打包态诊断验证：清空前 56 条结构化事件；清空后同一 run 重新生成 43 条事件，sequence 56–98 严格递增且不重复；1440×960 与 1024×960 设置页横向 overflow 均为 0。

定向 Vitest 证明日志服务、数据治理边界和 Renderer 交互；它不能替代打包应用中的 Finder/保存面板、真实麦克风、真实 Sherpa 或真实 OpenAI 调用。

## 真实设备与服务手工验收

### A. 启动和基础状态

1. 从新构建的打包应用启动 Phrio，进入“设置 → 常规与隐私 → 本地诊断日志”。
2. 确认实际目录位于当前 Phrio `userData` 下，保留期显示 7 天，待写入与写入失败均为 0。
3. 点击“打开日志目录”，确认 Finder 打开且至少在产生事件后出现 `phrio-diagnostic-*.jsonl`。
4. 退出并重新启动，确认新运行具有新的 run ID，旧文件仍在保留期内可读取。

### B. 完整练习闭环

1. 新建自由练习，允许麦克风并开始录音；依次制造静音、检测到语音、partial 和 final。
2. 在录音中切换实时反馈和 AI ON/OFF，结束录音并等待尾句、冻结快照。
3. 完成 Deep 逐字稿查看/纠正、唯一焦点、短 Drill、复讲和同口径比较。
4. 返回设置页，确认文件数/大小增长且没有待写入、已丢弃或写入失败事件；JSONL 的 sequence 单调递增，事件能用 Session/Attempt/operation/request ID 串起上述路径。
5. 检查事件 fields：只应看到状态、计数、时长、序号、类型和稳定错误码，不应看到刚才说出的正文或音频内容。

### C. 可控降级

分别执行一次且恢复现场：

- 拒绝麦克风权限；
- 全程静音触发 no-speech；
- 缺失/不可读本地模型或 ASR 中断；
- 断网、无效 AI Key 或 provider 超时；
- 在安全测试副本中制造一次可恢复的持久化或目录打开失败。

每次记录大致时间、页面、动作、可见错误码和最近 incident ID。确认本地录音/转写/Deep 主轨按产品降级规则继续或明确阻止，并确认日志中有 begin/terminal 或 failed/recovered 事件，没有无限重复和敏感正文。

### D. 导出和清除

1. 点击“导出诊断包”，选择测试目录；验证导出的 JSON 可解析，包含 `diagnostic-bundle-1`、应用版本、平台、架构和按时间/序号排序的事件。
2. 取消一次导出，确认没有生成文件、原日志没有改变。
3. 点击“清除诊断日志”，确认状态变为 0 文件 / 0 B；随后继续操作可生成新的当前 run 日志。
4. 再生成一份外部导出，然后执行“清除训练数据”；确认 Session/音频/产物和应用管理日志均消失，而外部导出仍保留。

## 提交问题时的最小材料

为方便后续优化，真实体验发现问题时提供：

- 大致发生时间和时区；
- 当时页面、前一步操作和期待结果；
- 可见错误码或最近 incident ID；
- 一张截图或短屏幕录制；
- 从应用设置页主动导出的诊断包。

不要额外提供 API Key、原始音频或完整逐字稿。若日志状态显示待写入、已丢弃或写入失败大于 0，请在问题描述里明确标注，因为诊断包可能不完整。

## 仍需真实环境关闭

- 打包版 Finder 打开与系统保存面板在目标 macOS 上的行为。
- 真实麦克风权限变化、设备拔插和睡眠唤醒事件的完整性。
- 真实 Sherpa 模型加载/中断/尾句时序，以及真实 OpenAI 超时、限流和网络恢复。
- 长时间连续使用下的文件轮换、7 天清理和磁盘不足恢复。

未完成上述手工检查前，不声称日志已经覆盖所有 macOS 或外部服务故障，也不伪造事件延迟或性能达标数字。
