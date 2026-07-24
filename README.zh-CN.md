# Phrio

Phrio 是一款本地优先的中文口头表达刻意练习桌面应用。用户完成初讲后会先得到可保存的诊断结果，再自行选择结束、直接复讲，或进入“一个训练焦点 → 短 Drill → 同题复讲”；复讲完成后也可选择结束或查看同口径前后比较。

[English README](README.md) · [30 秒受控演示](#30-秒受控演示与分享) ·
[参与贡献](CONTRIBUTING.md) · [安全说明](SECURITY.md)

## 当前状态

- 阶段：Production Closure candidate / macOS Apple Silicon Internal Alpha
- 版本：`0.1.0-alpha.0`
- 技术：Electron 43.1、React 19、TypeScript 5.9、主进程 SQLite、Sherpa-ONNX 本地 ASR、可选 OpenAI Responses
- 视觉：Gate C 的对象 IA、S04 证据几何与可访问边界继续保留；首页、准备页、实时工作区、逐字稿、诊断、Drill、复讲、记录、设置、受控 Demo、结果卡和传播素材已按用户批准的“编辑校样 × 表达排练 × 纸墨套印”方向完成分阶段重构
- 产品闭环：Fast Lane 与 Deep Lane 的本地生产路径已接通；可选 `live_hint`、`deep_diagnosis`、`comparison` 云端路径已接入固定 provider/model/endpoint 与独立同意边界
- 可诊断性：主进程已接入本地结构化诊断日志，覆盖应用、录音、VAD、ASR、Fast/Deep、AI、IPC、持久化和窗口异常；设置页可查看状态、打开目录、导出诊断包和清除日志
- 发布边界：这不是公网上线声明。真实麦克风/设备中断、真实本地模型质量、真实 OpenAI 凭据调用以及目标 Mac 性能仍需手工验收；不宣称未经测量的延迟、准确率或训练效果

最新 GitHub 当前树 Secret、许可证、workflow 权限、`main` 与 remote 边界见
[2026-07-24 开源预检](docs/acceptance/2026-07-24-github-open-source-preflight.md)。
旧的 2026-07-17 产品就绪度审计准确描述了当时的缺口，但其中“云端 AI 未接线”“Deep 依赖页面 draft”“16 个 bridge 方法”“125% 只做 CSS 代理”等结论已被本轮实现取代。完整功能矩阵见 [2026-07-18 Production Closure](docs/acceptance/2026-07-18-production-closure.md)，柔性结果流、实时转写低延迟轨与持久化门见 [2026-07-21 验收](docs/acceptance/2026-07-21-flexible-results-streaming-latency.md)，最近练习的命名、模式标签与记录管理边界见 [最近练习管理验收](docs/acceptance/2026-07-21-recent-practice-management.md)，结果层级与冻结实时证据双视图见 [练习结果双视图验收](docs/acceptance/2026-07-21-record-result-evidence-views.md)，传播层、开源仓面与公共候选发布边界见 [2026-07-23 验收](docs/acceptance/2026-07-23-open-source-propagation-release-readiness.md)，当前记录、设置、受控 Demo、结果卡和仓库传播素材见 [2026-07-24 本地档案与传播校样验收](docs/acceptance/2026-07-24-editorial-rehearsal-records-propagation.md)，逐字稿、诊断、Drill、复讲完成与双页比较见 [2026-07-24 训练闭环验收](docs/acceptance/2026-07-24-editorial-rehearsal-training-loop.md)，默认专注、显式证据、采集详情和异常上浮见 [2026-07-24 实时工作区验收](docs/acceptance/2026-07-24-editorial-rehearsal-live-workspace.md)，视觉基础与功能保全门见 [2026-07-24 基础验收](docs/acceptance/2026-07-24-editorial-rehearsal-foundation.md)。

## 30 秒受控演示与分享

- 首次打开可先体验固定文本的“初讲证据 → 唯一焦点与 Drill → 同口径前后
  比较”。它不请求麦克风、不安装模型、不创建练习记录，也不调用云端 AI。
- 完成记录可在本机生成 16:10、1:1 或 9:16 的 PNG / SVG / Markdown 结果卡，
  并进入纯净投屏模式。证据原句默认关闭，完整逐字稿永不进入结果卡。
- Phrio 不创建公开链接、不自动上传分享卡，也不借传播层新增总分或胜负判断。
- README Hero、动图和 GitHub social preview 均由最新打包版的受控 Demo
  生成，证据边界与再生方式见 [品牌与传播素材](docs/brand/README.md)。
- 仓库现以 MIT 开放自有源与资产，并提供只允许现有模式任务的
  [社区 Task Pack](task-packs/README.md) 入口；不执行远程插件代码。

## 已实现闭环

### Fast Lane

- 开始前先检查本地转写模型；缺失时可在练习页或设置页一键安装。默认只下载固定 revision 中的 `encoder.int8.onnx`、`decoder.int8.onnx` 和 `tokens.txt`，合计 237,202,501 B（约 226.2 MiB）；先尝试明确标记的第三方入口，它若精确迁移到同一冻结对象的官方 Hugging Face 入口，界面与 receipt 立即按官方来源归属。只有 direct 结构性不兼容时才回退官方 GitHub 整包。直连使用 8 工作者的固定分段、可恢复 checkpoint 和 macOS 系统代理/PAC；每个文件都必须命中冻结字节数与 SHA-256，并真实初始化 recognizer/stream 后才显示 ready。网络失败、空闲超时和正常退出都保留进度，只有用户显式取消才删除 checkpoint。不会先请求麦克风再让用户录出一遍必然失败的音频。
- 模型物理安装 promise 存续期间，主进程仅申请 Electron `prevent-app-suspension` 临时租约，并在完成、失败、取消、暂停或退出边界释放；它不阻止屏幕关闭，不修改 macOS 永久电源设置，也不在普通练习期间持有。
- 主动请求麦克风权限并录音；可枚举并切换实际输入设备，显示 track 标签与 `unknown / healthy / silent` 输入健康状态。持续约 2 秒近静音会提示检查输入音量或更换麦克风，但不会擅自停止；8 秒 no-speech、20 秒短录音确认门与 5 分钟上限仍分别生效。
- Renderer 从同一条麦克风流并行采集 `MediaRecorder` 音频与 PCM；AudioContext 的实际输入采样率会连续重采样为真实 16 kHz 后才交给主进程 Sherpa-ONNX，返回 partial/final。分析链使用零增益输出，不把麦克风声音回放到扬声器；2 秒滚动 watchdog 监测 PCM 从未启动或中途停滞。
- PCM 不完整时，同一 MediaRecorder take 会在 Renderer 本地 decode/downmix/resample 后替换缺失的实时 PCM；该恢复只允许发生在尚无 final 的 Attempt，且音频/PCM 不出站。ASR 时间码来自 16 kHz sample clock，恢复前清旧 partial，空逐字稿禁止冻结。
- ASR 启动最多缓冲 8 秒 PCM，feed/tail 失败且尚无 final 时可用本轮受限 PCM 做一次完整恢复；失败录音与可重放 PCM 保留在当前页，可在模型恢复后直接重新转写同一遍。有 final 后不从样本 0 重放，避免重复账本，改为明确要求重录。
- `LiveAttemptEvent → LiveAttemptState` 统一处理重复、乱序、旧 generation 和迟到事件。partial 只覆盖临时态；final 才追加、标注、统计、触发 AI 并进入冻结快照。
- 九类本地强反馈只在 final 后生成并确认；`structure` / `task_gap` 在尾句收束时使用冻结任务上下文幂等协调。任务上下文读取失败会保留 final、阻止快照并提供原位重试，不会静默漏掉 `task_gap`。实时证据账本以句段共享行为单位，用精确 span、语义色、线型与 O 编号双向定位，并保留迁移/撤回后的中性历史。
- `live_hint` 只读取累计 final 文本和冻结任务 Rubric，具备防抖、冷却、去重、请求上限、超时、迁移、撤回和迟到结果丢弃；短提示始终标记为暂定，不冒充最终诊断。
- 停止录音先保留 300 ms 尾块窗口，再等待 MediaRecorder stop、最后 PCM watermark 与 ASR start/feed/tail；stop event 和本地录音解码都有明确 timeout。只有 safe end、至少一个 final 且 `AttemptSnapshot` 成功持久化后才显示“继续：确认逐字稿 / 选择下一步”并进入 Deep Lane。快照写入超过 8 秒会转为可见失败，保留同一候选并允许显式重试。

### Deep Lane

- Deep 只读取 SQLite 中的冻结 Session `taskSnapshot`、冻结 Attempt、带版本纠正和持久化产物，不回退到迁移中的 React draft；普通产物写入会校验 Session → Attempt → Snapshot → Segment/Evidence → Focus/Drill/Comparison 的完整引用图。
- 每个 Session 冻结完整任务语境、Rubric、候选焦点和 Drill 定义；最终逐字稿可逐句纠正，原始 final 与证据历史仍可回查。
- 本地确定性复盘始终可用并先显示为诊断卡。诊断保存后，用户可以结束本轮、跳过焦点直接同题复讲，或只选择一个焦点进入短 Drill；用户可明确改选焦点，或在审阅完整 AI 复盘后明确采用 AI 建议。实时短提示不能自动决定焦点。
- 自由复讲不伪造焦点；焦点路径在内联 Drill 完成后以同一任务、同一焦点进入复讲。复讲冻结后可以直接保存结束，也可以显式进入比较；`paired-1` 只比较该焦点冻结的 `comparisonDimension`，不借用其他问题总量、不生成总分，缺正式证据时返回证据不足。
- 可选 `deep_diagnosis` 与 `comparison` 先展示可编辑 exact JSON，再按 payload hash 单次批准。queued / processing / complete / failed / superseded 生命周期与当时批准的 payload 会持久化；重启后可继续同一份已批准 payload，同进程重复请求会合并；纠正或版本变化使旧结果转为中性历史。
- 本地复盘、Drill 与本地比较不等待云端；AI、网络或同意失败不会阻断本地闭环。
- 每条完成记录默认展示按“一句话结论 → 判断证据 → 唯一焦点 → 下一步”组织的诊断结果，并可切换到与录制时相同的左右共享行“实时证据”。初讲/复讲分别回放自己的冻结 final、时间码、O 编号、问题记录与提示 lifecycle；原始 final 不被后续纠正覆盖，纠正后的诊断与中性历史态仍可同时回查。partial 继续只属于实时临时态，不在历史页伪造或持久化。

完整架构、数据流、状态与降级分支见 [Fast/Deep ADR](docs/adr/0002-fast-deep-lanes.md)。

## 数据、同意与安全

- 练习 Session、冻结快照、纠正、报告和比较保存在主进程 SQLite；音频由独立 Repository 管理，默认在完成时删除，只有用户选择“随记录保留”才迁入保留目录。
- 最近练习以初讲冻结快照中按 sequence 排序后的第一句话作为自动名称；用户重命名后优先保留自定义名称，复讲、纠正、报告和迟到结果都不能改写。丢弃或替换 Attempt 会在同一 SQLite 事务中清除对应自动标题、产物并留下 Attempt 墓碑，旧快照或旧音频迟到时会被拒绝。
- 原始音频与 partial 不进入云端 payload。`live_hint` 使用配置级同意且每次练习仍需显式 AI ON；`deep_diagnosis` 与 `comparison` 每个 exact payload 单独批准。
- `live_hint` 还必须通过主进程的当前 Session、Attempt generation、冻结任务、AI ON 与本地 ASR final-only 账本租约；当前配置同意和 provider 投影只包含冻结任务内容与累计 final 文本。Session、Attempt、segment、顺序和 revision 等本地权威元数据仅用于授权与审计，全部禁止出站；Attempt ID 本身也不编码 Session 身份。
- 云端固定为 OpenAI Responses、`gpt-5.6-terra`、`https://api.openai.com/v1/responses`，请求使用严格 JSON Schema、`store: false`、禁止重定向，并在主进程做输入、输出与语义一致性校验。
- 当前生产构造刻意不调用可能同步等待 macOS Keychain 的 Electron `safeStorage`，API Key 写入 `userData/secure` 下 0700 目录中的 0600 本机私有文件，并在设置与实时 AI 配置中明确标注“本机私有文件（未加密）”。Key 只由主进程读取，明文不进入 Renderer、IPC 返回值、SQLite 或诊断日志；旧 version 1 加密文件继续保留且可删除，用户显式重新保存时才替换为当前格式。云端同意、获批 payload 与请求审计保存在独立 SQLite，永不保存音频。
- 打包版使用只读 allowlist 的 `phrio-app://renderer/index.html`、严格 CSP、sandbox、context isolation、无 Node integration、40 个按用例命名且双向 Schema 校验的 preload 方法；IPC 只接受当前主窗口固定入口。
- 清除训练数据会先禁止新云端操作、取消并等待在途请求，优先删除云端 exact payload / audit，再清理本地 Session、产物与音频；云审计删除失败时本地图仍可用于明确重试。恢复默认偏好会先把 queued / processing 云产物冻结为 `consent_reset` 中性历史，再清同意与审计。所有危险操作均有可回焦的二次确认。
- 诊断日志仅写入本机 `userData/diagnostics`，采用逐行 JSON 事件、单次运行 ID、递增序号、关联 ID 和错误指纹；单文件到 5 MB 轮换，总量最多 25 MB，并按事件时间自动清理超过 7 天的内容。写入失败时使用最多 2,048 条的有界内存缓冲，优先保留告警/错误并显示丢弃计数；恢复写入每个主线程 turn 最多处理 64 条，高频 ASR partial 状态按秒采样，final、失败和恢复完整保留。Renderer 每 500 ms 读取模型安装状态的成功 IPC 不逐次写 start/complete 日志，失败调用仍完整记录；模型下载只记录有意义的进度里程碑，避免轮询淹没诊断容量。日志不记录原始音频/PCM、partial 或完整转录正文、AI prompt/请求响应体、Authorization 或 API Key。
- “清除诊断日志”只删除应用管理的日志；“清除训练数据”也会同步清除这些日志。只有用户主动选择位置后才生成外部诊断包，外部导出不受应用自动清理影响，也不会自动上传。

## 外观与交互

- `system` / `light` / `dark` 是整套语义主题，不是只切强调色；App shell、Sidebar、Workspace、Canvas、surface、field、文字、边框和状态色共同切换。
- 浅色和深色分别保存 8 组受约束配色；浅色使用低饱和浅底。界面与正文支持 90%、100%、112.5%、125% 四档整体缩放。
- 设置写入 SQLite，`localStorage` 只作首帧无闪烁缓存；保存失败自动恢复上一次已持久化值。
- partial、final、精确划线、记录到达、尾句和降级提示使用安静的短动效；系统 `prefers-reduced-motion` 与应用“减少动效”都会关闭平滑滚动并把非必要动画压至近零，不移除任何功能。
- 全局导航在持久化操作中锁定；恢复练习、纠正、删除、重录与设置操作均有进行中、失败和重试反馈，避免重复点击或迟到结果覆盖新状态。
- 左侧最近练习将名称、模式标签和置顶状态分层展示；每条记录可重命名、置顶、取消置顶或二次确认删除。1024px 紧凑侧栏隐藏最近列表后，同一组真实操作仍可从“练习记录”完整页进入。菜单支持方向键、Tab、Esc、滚动/缩放回焦，并与 90%–125% 整体缩放共用同一视觉尺度。

## 本地运行与验证

当前打包版体验入口：

```text
out/Phrio-darwin-arm64/Phrio.app
```

首次体验顺序：先安装约 226.2 MiB 的三个本地模型文件（可看进度、暂停后继续或显式取消并删除进度；普通断网/超时只保留三文件断点，仅在官方源明确不兼容安全分段、跳转或连续完整性校验时才可能回退约 1 GB 整包；安装期间允许屏幕正常关闭，但 App 不应因系统空闲而挂起）→ 进入自由练习或题目 → 选择真实麦克风并允许权限 → 观察输入健康、稳定 partial 与 final → 结束并等待快照保存 → 点击“继续：确认逐字稿 / 选择下一步”进入 Deep → 在诊断卡选择结束、直接复讲或焦点 Drill。复讲后可保存结束，也可查看比较。实时 AI 需依次保存 Key、批准 `live_hint`、开启用途，并对本次 Attempt 显式 AI ON。

2026-07-21 的最终候选已在全新隔离 `userData` 从零完成 237,202,501 B 三文件安装：逐文件大小/SHA-256、schema v2 receipt（官方 resolved source）与 native recognizer/stream 均通过，退出并重启后仍报告 ready。该轮原始墙钟跨度包含 macOS 锁屏休眠，不能用作下载速度或安装 SLA。

```bash
pnpm install
pnpm start
```

基础门禁：

```bash
pnpm verify
```

最小 macOS Apple Silicon CI 已固化为
[`ci.yml`](.github/workflows/ci.yml)：PR 与 `main` push 自动运行
`pnpm verify`，push/手动运行额外生成带提交身份、SHA-256 和证据分层声明的
14 天内部 Alpha ZIP。该 ZIP 仍是 ad-hoc 签名，不是已公证的分享包；CI 不读取
OpenAI Key、不发送转录文本，也不替代真实麦克风/模型/目标 Mac 验收。当前仓库
已经以 `main` 为本地主真源，但仍没有 remote；启用边界、GitHub 保护与历史隐私
选择见 [GitHub 源码发布检查](docs/release/github-open-source-readiness.md) 和
[Internal Alpha CI 与实现真源](docs/release/internal-alpha-ci.md)。

自备且已获授权的 16-bit PCM WAV 可用 `pnpm benchmark:asr` 做完全离线的中英双语流式基准；仓库示例默认全部 skip，不包含真实录音，也不会伪造指标。manifest、指标口径与隐私边界见 [本地 ASR 离线基准](docs/local-asr-benchmark.md)。

2026-07-24 当前共享树结果：59 个测试文件通过、1 个跳过；596 项测试通过、1 项跳过；Electron 系统网络 / 安装期防休眠探针、macOS 打包、18 个签名目标、40 方法 packaged bridge 与 Sherpa `1.13.4` smoke 全通过。上一阶段的 `pnpm make` 还实际生成带品牌安装背景的 DMG 与 ZIP；两者仍为 ad-hoc Internal Alpha 制品，不是 Developer ID / 已公证分享包。

真实 Electron 视觉与产品交互巡检：

```bash
pnpm verify:electron-visual
pnpm verify:electron-product-tour
```

视觉脚本覆盖 1440×960 / 1024×960、100% / 125%、标准 / 证据全屏、语义滚动锚点、Esc 回焦、reduced motion、单一证据 scroller、共享行对齐和横向 overflow，当前 85/85、9 张截图；产品巡检还用直接注入的受控音频、partial/final、证据与尾句事件，经真实 Session/IPC/SQLite 跑通编号 Fixture Demo、默认专注、采集详情、证据切换、快照、编辑稿纸式逐字稿、四级诊断卡、自由复讲、单动作焦点 Drill、冻结复讲票据、双页 paired-1、本地档案与 Session 卷宗、设备账册、`RESULT PROOF` 分享卡、纯净展示、终态保存、首句命名、重命名、置顶/取消置顶、删除、历史诊断与冻结实时证据双视图，并完成浅色/深色代表页、90% / 100% / 112.5% / 125%、键盘 Enter / 方向键 / Home / End / Esc 与 1024 主操作门，当前 149/149、49 张截图。两条真实 Electron 轨的生产 console 均为 0 error / 0 warning，产品与 QA 外部 HTTP(S) 请求均为 0；开发 QA 轨只有 Electron 自身的开发期 CSP 提示。该受控轨证明跨页面持久化闭环，不证明生产 recorder、Sherpa、规则标注/尾句编排或云服务；这些代码边界分别由单元/集成测试覆盖，真实环境仍按清单手工验收。最终证据矩阵、三选一建议与主真源方案见 [2026-07-24 全产品终验](docs/acceptance/2026-07-24-editorial-rehearsal-final-acceptance.md)；分阶段界面证据见 [本地档案与传播校样验收](docs/acceptance/2026-07-24-editorial-rehearsal-records-propagation.md)、[训练闭环验收](docs/acceptance/2026-07-24-editorial-rehearsal-training-loop.md)、[实时工作区验收](docs/acceptance/2026-07-24-editorial-rehearsal-live-workspace.md) 与 [视觉基础验收](docs/acceptance/2026-07-24-editorial-rehearsal-foundation.md)，传播和真实麦克风证据见 [2026-07-23 验收](docs/acceptance/2026-07-23-open-source-propagation-release-readiness.md)，完整闭环证据见 [柔性结果与低延迟验收](docs/acceptance/2026-07-21-flexible-results-streaming-latency.md)、[最近练习管理验收](docs/acceptance/2026-07-21-recent-practice-management.md) 与 [练习结果双视图验收](docs/acceptance/2026-07-21-record-result-evidence-views.md)，日志设计见 [诊断日志验收](docs/acceptance/2026-07-18-diagnostic-logging.md)，真实录音、模型安装、同音频恢复与实时 AI 设置验收见 [2026-07-20 验收](docs/acceptance/2026-07-20-real-capture-transcription-recovery.md)。

### 真实体验时收集日志

1. 打开“设置 → 常规与隐私 → 本地诊断日志”，先确认状态显示为可用；界面会展示实际日志目录、文件数、占用、待写入事件、已丢弃事件、写入失败次数和最近诊断 ID。
2. 正常完成一次录音、转写、结束、Deep 复盘、Drill、复讲和比较。如果遇到问题，记下大致时间、当时页面/操作和界面显示的最近诊断 ID；不要反复重现可能导致数据损失的操作。
3. 点击“导出诊断包”，在系统保存面板中选择位置，把生成的 JSON 文件与截图一并用于后续排查。导出是只读副本，不会清空本机日志，也不会自动发送到任何服务。
4. 问题确认后可点击“清除诊断日志”；如果要清空全部练习，则使用“清除训练数据”，它会同时清除应用管理的日志，但保留用户已导出的文件。

日志是排查线索，不是性能达标证明。真实设备/服务手工验收步骤和应观察的事件见 [诊断日志验收](docs/acceptance/2026-07-18-diagnostic-logging.md)。

## 目录

```text
src/
├── frontend/      # Page / Component / Hook / Service；采集音频和组合 UI
├── backend/       # IPC Controller / Service / Repository；ASR、AI、SQLite 与文件
├── preload/       # 40 个窄 contextBridge API
└── shared/        # 纯类型、Schema、状态机、规则与版本化协议
```

## 诚实边界

仓库不包含 Sherpa 模型权重、OpenAI API Key 或真实用户音频。自动化使用受控 mock/fixture 验证状态机、数据边界和 Electron 布局；真实设备、真实模型和真实服务结果必须按验收清单另行记录。当前包已通过 deep/strict codesign，但只是 ad-hoc 内部签名；重打包可能重新触发麦克风权限，Developer ID、hardened runtime 与 notarization 尚未完成。Phrio 仍是工作名，版本仍保持 Internal Alpha。
