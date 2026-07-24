# ADR-0001：Electron 桌面基础、信任边界与持久化分层

- 状态：Accepted；2026-07-21 Internal Alpha 修订
- 初始日期：2026-07-16
- 修订日期：2026-07-21

## 决策

采用 Electron 43、React 19、TypeScript、Electron Forge 和 Vite。桌面能力保持单向分层：

```text
Renderer Page / Component
        ↓ Hook / frontend Service
40-method typed preload bridge
        ↓ schema-validated IPC Controller
Backend Service
        ↓ Repository / approved external transport
SQLite · private audio files · safeStorage · Sherpa-ONNX · OpenAI Responses
```

Renderer 负责 UI、`getUserMedia` / `MediaRecorder`、按 AudioContext 实际采样率采集并连续归一到 16 kHz 的 PCM，以及可复用交互状态，不直接读取 Node、SQLite、ASR 模型、文件系统或 API Key。主进程负责可信 sender 校验、业务编排、本地 ASR、云端 AI、数据治理与持久化。Controller 只翻译 IPC，Service 承载规则，Repository 只做数据访问。

## 安全默认值

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- Renderer 无 Node `process`；preload 只暴露 40 个按用例命名的方法
- 每个 IPC channel 同时校验输入、输出、当前主窗口、main frame 和固定入口 URL；错误只向 Renderer 暴露稳定错误码
- 严格 CSP，拒绝任意导航、新窗口和非产品权限；麦克风权限只授予可信主窗口入口
- Electron fuses 禁止 RunAsNode、Node options、inspect、file protocol extra privilege，并启用 ASAR 完整性与 OnlyLoadAppFromAsar
- 打包版只从 `phrio-app://renderer/index.html` 加载；scheme 为 standard/secure/code-cache，不获得 CSP bypass、Service Worker、CORS、Fetch、扩展或流式权限
- 协议处理器只接受 `GET`/`HEAD`，只映射根 `index.html` 与 `assets/` 下平铺且扩展名/MIME allowlist 的构建资源；拒绝 query、凭据、端口、嵌套目录、未知类型、缺失文件与路径穿越
- 开发环境只信任冻结的本地 Vite origin；开发 CSP warning 不等同生产包状态

## 数据与存储边界

### 练习数据

主数据库使用 Electron 内置 Node 24 的 `node:sqlite`。`SessionRepository` 保存 Session、冻结 `taskSnapshot`、Attempt 元数据、设置和版本化练习产物；Renderer 不直接查询。数据库启用 WAL、foreign keys、`busy_timeout`、`trusted_schema=OFF` 和私有文件权限。

schema v8 另保存记录显示名、显示名来源和置顶时间。初讲快照、自动首句名称与 artifact 在同一事务落库；用户重命名和置顶使用窄列更新，不会被迟到的整图保存覆盖。丢弃或替换 Attempt 会同时写入 Session 范围的 `discarded_attempts` 墓碑，因此进程内竞态或重启后的旧快照/旧音频都不能复活已删除的数据。

音频由独立 `AudioRepository` 管理：

- 录音完成后以有上限的字节数组经窄 IPC 进入主进程；
- 临时文件使用私有目录、`0600` 文件和原子重命名；
- Session/Attempt 身份、MIME 与大小在 Service/Repository 边界校验；
- 默认完成 Session 时删除，用户明确选择 `keep_with_session` 才迁入保留目录并更新数据库引用；
- 重录、删除记录、清除训练数据和启动清理都有文件/数据库补偿与孤儿协调。

### 云端 AI 数据

云端 AI 使用独立 `cloud-ai.sqlite3` 保存配置级/逐 payload 同意、获批 exact payload、请求元数据和生命周期审计，不保存 API Key 或音频。API Key 使用 Electron `safeStorage` 加密，密文文件目录为 `0700`、文件为 `0600`；明文只在主进程发起固定请求时读取，Renderer 只能看到配置状态与末四位提示。

清除训练数据通过 reset gate 阻止新同意和新请求，取消并等待所有在途请求 settle 后，再清理练习数据库、关联音频、Deep/Comparison exact payload 与请求审计。`live_hint` 配置级同意和加密 API Key 只有在其各自明确操作中删除。

## 录音、本地 ASR 与云端请求

Renderer 使用 `getUserMedia` / `MediaRecorder` 保存可回放音频，同时用 Web Audio 采集实际采样率 PCM，再连续重采样到 16 kHz。主进程 `LocalAsrService` 通过外置 Sherpa-ONNX 模型生成 partial/final；模型默认位于 Phrio `userData/models/sherpa-onnx-streaming-paraformer-bilingual-zh-en/`，权重不进入 Git。默认安装只获取固定 revision 的三个运行文件（约 226.2 MiB），先走标记为第三方的可选入口，再走官方 Hugging Face，最后才回退官方 GitHub 整包；当前第三方入口真实迁移到官方时不再宣称“加速”。模型下载经 Electron 默认 Session 的 Chromium 系统网络栈执行，direct 与 archive fallback 共用手动 redirect、无凭据、无缓存的流式 transport，使 macOS 系统代理/PAC 生效，同时保留 downloader 对每跳 URL、范围、尺寸与完整性的验证。安装成功时随原子目录 promotion 写入 schema v2 receipt，冻结 model ID/revision/resolved route 与三个目标文件的 exact size/SHA-256；独立 verifier 在麦克风授权前验证 receipt、固定分发身份、原生依赖、recognizer 初始化与 stream 创建，并缓存未变化模型的成功 probe。`missing / corrupt / dependency_missing / runtime_init_failed` 均阻止录音且不冒充 ready。启动/feed/stop 超时、PCM 停滞或设备中断进入明确降级，同一 MediaRecorder take 可在无 final 时作为本地恢复源，不让不完整或空转写冻结成有效 Attempt。

模型 source transition 以冻结对象身份而非入口域名为边界：镜像只有精确跳转到同一 model/revision/file 的官方 Hugging Face 入口时才继续复用 `.phrio-asr-direct-v2` checkpoint；迁移后 `resolvedSource`、当前状态和最终 receipt 都归到官方来源。普通 timeout、idle、断网或 `5xx` 只保留 `226.2 MiB` direct 断点并返回可重试失败，不能触发成本约 `998.8 MiB` 的 archive。archive 是结构兼容逃生路径，只允许在官方 direct 的 Range/redirect 结构不兼容或冻结对象完整性反复不一致时进入。

该修订来自真实 Electron `43.1.1` fresh-dir 反例：旧逻辑先误拒镜像到官方同对象的 `308`，官方 direct 到 `59,321,877 B` 后普通 idle 又误入 `1,047,319,737 B` archive，archive 仍失败。安全探针随后确认实际合法链为镜像 `308` → 官方固定 revision/file → CDN `302`，CDN path、`x-linked-size`、`x-linked-etag` 与 encoder 冻结身份一致，单字节 Range 返回 `206`。修复后的最终候选又在全新隔离 `userData` 完成 `237,202,501 B` 三文件安装，逐文件冻结 SHA、schema v2 receipt、native recognizer/stream 与重启 ready 均通过；这才是最终 fresh-dir 安装证据。

长时间模型安装的电源边界是 scoped lease：物理安装 promise 活跃时由主进程持有 Electron `prevent-app-suspension`，在完成、失败、取消、暂停和退出路径释放或幂等重试。选择该类型意味着屏幕仍可关闭；实现不修改 macOS 永久电源设置，也不把 blocker 延伸到普通练习。上述真实安装的原始墙钟跨度包含锁屏休眠，因此不得据此宣称下载速度或安装 SLA。

云端 AI 只在主进程访问固定 OpenAI Responses endpoint。请求禁止重定向，使用 `store: false`、严格 JSON Schema、请求/响应大小上限、用途超时、Abort、状态码归一和语义一致性验证；禁止 payload 中出现 raw audio 或 partial。Renderer 不能改变 provider/model/endpoint。

## 取舍

- Electron 包体和内存高于原生壳；当前接受该成本，以复用 Node/Electron 音频、SQLite 与 approved Web UI。若目标 Mac 的真实资源测量不能满足发布预算，再评估 Tauri/SwiftUI；共享领域 Schema、Service/Repository 接口和冻结快照边界应保持不变。
- Sherpa 当前运行在主进程 Service，而非 utility process/sidecar。真实模型长录音的 CPU、内存和主线程影响尚需实机测量；必要时可把适配器迁移到 utility process，不改变 preload/Session 协议。
- Forge Vite 插件仍有工具链风险。开发启动与打包共用 `.vite`，Electron 验收脚本必须串行运行并在 QA 后重建生产包。
- `phrio-app:` 只解决正式 Renderer 静态资源信任边界，不扩大产品网络、文件或权限范围。
- 当前内部 Alpha 在所有 Electron fuses 写入后执行完整 ad-hoc 签名；主包 entitlement 仅保留麦克风 audio input，Helper 使用空继承 entitlement，package gate 对所有签名目标执行 deep/strict 校验并拒绝 camera/location/bluetooth/USB/print 等无关权限。bundle identifier 固定为 `com.phrio.desktop`。这不等于公开分发：重打包 cdhash 会变化并可能重新触发 TCC，正式发布仍需数字型 build version、产品图标、hardened Developer ID 签名和 notarization。

## 被取代的 P1 取舍

P1 曾通过 `file://` 加载 Renderer、保留 `GrantFileProtocolExtraPrivileges`，并只提供 16 个 bridge 方法；该选择已由本 ADR 的 2026-07-18 修订取代。历史 P1 验收仍保留，但不能描述当前生产包。
