# 2026-07-20 真实录音、实时转写与恢复验收

## 结论口径

本轮关闭的是用户真实体验暴露的四个 P0：本地录音近静音、默认安装无模型而无法实时 partial/final、停止后没有明确下一步、实时 AI 控件不可执行。

自动化可以证明事件、状态、恢复、安全边界和布局；最终候选打包版现已在全新隔离 `userData` 从零完成默认 `226.2 MiB` 三文件安装，并通过逐文件冻结 hash、schema v2 receipt、native runtime probe 与退出后重启 ready。既有用户目录还曾通过真实麦克风输入以及中文 partial/final；两组证据合并证明当前本地模型安装和识别链可用，但仍不等于中文准确率、延迟或资源占用基准已经通过。真实 OpenAI 调用必须使用用户自备 Key 单独验收。

旧包曾在约 53 MB 到盘后因连续约 30 秒无数据触发 `ASR_MODEL_DOWNLOAD_FAILED`，并删除全部已下载内容；这是促成 checkpoint、分段直装和多源 fallback 的历史 P0。既有用户目录随后曾由较早候选包通过镜像约 31 秒下载、约 33.2 秒完成安装，这只是一次历史观测，不是性能 SLA。对当时 hardening 包的空目录回归又发现：镜像精确迁移到官方入口被误拒，官方 direct 到约 55 MB 后 idle，旧分类再误入 `998.8 MiB` archive 且仍失败。上述问题修复后，最终候选 fresh-dir 安装与重启 ready 已复验完成；短录停止后的快照和 Deep 入口、真实 OpenAI 仍待单独验收。最终 fresh-dir 安装的原始墙钟跨度包含 macOS 锁屏休眠，不能据此报告下载或安装速度。

## 真实故障证据

修复前读取实际 `~/Library/Application Support/Phrio/diagnostics` 后确认：

- 当前运行的是本 Production Closure 打包产物，不是旧 Prototype。
- 模型目录缺少 `encoder.int8.onnx`、`decoder.int8.onnx`、`tokens.txt`；两次 Attempt 均以 `ASR_MODEL_MISSING` 在 0 ms 启动失败，没有 partial、final、标注或 live hint。
- 麦克风权限与 MediaRecorder 都成功，但 22.520 秒 Blob 只有 6,581 B，7.266 秒只有 2,209 B；没有 `vad.voice_detected`，第一遍在 8 秒进入 no-speech。
- Session 没有 safe end / snapshot，保持 `first_attempt`，所以不会出现 Deep 下一步。
- `ai_consents` 为空且没有 Key；旧 UI 把 Key、用途、配置同意和 Session 读取合并为一个 disabled checkbox，只显示“实时 AI 未授权”。

对当时 hardening 包另用全新隔离 `userData` 做从零模型安装，诊断确认：

- 镜像入口实际以 `308` 跳到同一 model/revision/file 的 `huggingface.co` 官方入口；旧 redirect allowlist 未识别这类精确迁移，8 个 worker 均以 `ASR_MODEL_DIRECT_REDIRECT_REJECTED` 结束。
- 官方 direct 随后保留到 `59,321,877 B`（约 `56.6 MiB`，界面约 55 MB），再因普通网络 idle 以 `ASR_MODEL_DIRECT_DOWNLOAD_FAILED` 结束。
- 旧 fallback 分类把普通网络失败误当成必须切换兼容路径，界面和状态扩大到 `1,047,319,737 B`（`998.8 MiB`）GitHub archive；archive 在 `5,110,246 B` 后也以 `ASR_MODEL_DOWNLOAD_FAILED` 结束。fresh-dir 最终没有 receipt 或 ready 模型。

这是三段独立故障证据：合法同对象迁移被误拒、可恢复网络失败分类错误、fallback 成本被无条件放大；不能用既有用户目录中已安装的模型掩盖。

这些证据分别对应输入信号、模型分发、流程出口和 AI 设置四个独立故障，不能只修一个字幕组件。

## 上游实现对照

只读审计：`fxy2311-youyou/expression-trainer@f925434ae85871c6ad2294b3756ee2d2b4b026ca`。

可借鉴机制：

1. Renderer 从麦克风读取 Float32 PCM，经 IPC 喂给 Sherpa `OnlineRecognizer`。
2. partial 覆盖临时文本；endpoint 后 final 追加。
3. 本地词库、统计和 AI 累计触发只读取 final。

不能机械复制的缺口：

- 仓库不带模型，README 要求手工下载约 1 GB 权重。
- 请求 `AudioContext(16000)` 后直接把 PCM 标成 16 kHz，没有证明浏览器实际采样率。
- stop 返回的尾句没有进入 Renderer，可能丢尾句。
- 无 final 时报告/下一步不可见；没有 VAD、恢复和精细 AI 超时边界。
- 原项目不保存或回放 MediaRecorder 音频，不能解释本次近静音 Blob。

参考：

- [上游 Renderer PCM / partial-final](https://github.com/fxy2311-youyou/expression-trainer/blob/f925434ae85871c6ad2294b3756ee2d2b4b026ca/src/app.js#L76-L211)
- [上游 Sherpa adapter](https://github.com/fxy2311-youyou/expression-trainer/blob/f925434ae85871c6ad2294b3756ee2d2b4b026ca/lib/asr.js#L14-L130)
- [Sherpa 官方 streaming Paraformer 模型说明](https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/pretrained_models/online-paraformer/paraformer-models.rst)

## 最终生产链

```text
fixed Hugging Face revision
  → labeled third-party optional entry
  → exact same-object migration → official Hugging Face
  → structural incompatibility only → official GitHub archive fallback
  → Electron system network stack / HTTPS redirect allowlist
  → 8 fixed segments per large file / 8 global workers
  → fixed checkpoint + retry / Retry-After
  → exact size + frozen SHA-256 per file
  → private staging / native runtime probe / atomic promotion
  → local ASR preflight ready
                          ↓
selected microphone → one MediaStream
        ├→ MediaRecorder → playable retained take
        │                   └→ local decode/downmix/resample fallback
        └→ AudioContext actual sample rate
             → RMS/Peak/VAD + input health + PCM watchdog
             → continuous-phase resample to 16 kHz
             → narrow IPC → Sherpa partial/final
                              ↓ final only
                  local annotations / metrics / live hint

stop → wait MediaRecorder stop + final PCM watermark
     → drain start/feed/tail → task reconciliation → at least one final
     → safe_end → snapshot persisted
     → 继续：确认逐字稿 / 查看同口径比较
```

### 模型与 ASR

- 缺模型时录音前置检查阻止麦克风请求；练习页和设置页都提供真实一键安装动作。
- Renderer 不能指定下载 URL、revision 或安装目录。生产 manifest 固定 Hugging Face revision `8e40c43232a1c5c66c82111efc5820d3accca11b`。第三方镜像仅是可选入口：它只有精确迁移到同一 model/revision/file 的官方 Hugging Face 入口时才能继续，不能改变冻结文件身份；此后 `resolvedSource`、界面状态和 receipt 均按官方 Hugging Face 归属。
- 默认只下载三个运行文件，共 `237,202,501 B`（`226.2 MiB`）：

  | 文件 | 精确字节 | SHA-256 |
  |---|---:|---|
  | `encoder.int8.onnx` | `165,462,184` | `81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a` |
  | `decoder.int8.onnx` | `71,664,561` | `f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f` |
  | `tokens.txt` | `75,756` | `59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6` |

- 两个 ONNX 大文件各固定 8 段，下载器使用全局 8 worker；`tokens.txt` 单块下载。`.phrio-asr-direct-v2` checkpoint 持久化段级完成状态，失败或正常退出可继续，显式取消才清理。重复、乱序或跨源响应只有在最终 size/SHA 全部匹配时才能进入候选目录。
- `408 / 425 / 429 / 5xx` 按可重试响应处理，尊重 `Retry-After` 并加入抖动；普通 timeout/idle/网络失败保留 `226.2 MiB` 三文件 checkpoint 并把控制权交还用户重试，不能自动放大为 archive。分段源最终完整性失败会清理受污染 checkpoint，再从官方源进行一次干净重试，不能把混合分段带入 fallback。
- direct 与 archive 共用 Electron 系统网络栈，从 Chromium / macOS 继承代理和证书设置；manual redirect、无凭据、无缓存、流式 body、Abort / destroy / error 与范围响应头保持一致。诊断只记录 `transport=electron_system_network` 和受控 source/fileName，不记录入口、重定向签名 URL 或正文。
- 官方 GitHub fallback 继续使用精确 `1,047,319,737 B`（`998.8 MiB`）归档与 SHA-256 `5462a1fce42693deae572af1e8c4687124b12aa85fe61ff4d3168bb5280e205f`，固定 `.phrio-asr-download-v1` checkpoint、`Range / If-Range`、validator、合法 `206` 和完整 `200` 安全重启。它是兼容逃生路径，只能在官方 direct 的 Range/redirect 结构不兼容或冻结对象完整性反复不一致时进入；普通网络失败不得触发。
- direct 与 archive 都在 promotion 前检查暂停/取消状态，并完成逐文件 identity、receipt 与 native runtime probe；失败保留旧模型，不把 checkpoint 存在误写为“已安装”。状态细分为 `missing / corrupt / dependency_missing / runtime_init_failed`，成功 probe 只在模型文件身份不变时缓存复用。
- 本机既有用户目录的历史真实安装结果：较早候选包默认镜像传输约 31 秒、完整安装约 33.2 秒；schema v2 receipt 的 revision、当时的 `accelerated_direct` route 和三个 size/SHA 与冻结 manifest 一致，Sherpa native recognizer 初始化与 stream 创建成功。该历史 route 已被真实 `308` 迁移证据取代，不能继续用于当前来源归属或性能承诺。
- Electron `43.1.1` 真实 safe probe 已验证实际链路且未输出签名 URL：镜像入口 `308` 到 `huggingface.co` 同一固定 revision/file；官方入口 `302` 到 `us.aws.cdn.hf.co`，对象路径满足 `24-hex / 64-hex` 结构，`x-linked-size=165,462,184`、`x-linked-etag=<encoder SHA-256>` 均与冻结 encoder 身份一致，最终单字节 Range 返回 `206`。该 probe 证明 allowlist 所需结构，安装完成证据由下一条独立给出。
- 最终候选打包版已在全新隔离 `userData` 从空目录完成 `237,202,501 B` direct 安装。schema v2 receipt 固定 revision `8e40c43232a1c5c66c82111efc5820d3accca11b`、`huggingface_direct` resolved route，以及表中三个 exact size/SHA；同进程 native recognizer/stream probe 成功。退出后以同一隔离目录重启，receipt、冻结文件身份与 native readiness 再次通过，应用仍报告 ready。
- 上述真实安装的原始墙钟跨度受到 macOS 锁屏休眠主导，不记录下载耗时、平均速度或安装 SLA。后续模型物理安装 promise 活跃期间只持有 Electron `prevent-app-suspension` 临时租约；完成、失败、取消、暂停或退出均释放或幂等重试。该类型不会阻止屏幕关闭，不修改 macOS 永久电源设置，也不延伸到普通练习。
- 无 final 且保留 PCM 时可在模型/运行时恢复后重新转写同一遍；已有 final 或无 PCM 时不展示无效动作。
- ASR 句段时间码只来自已经接受的 16 kHz sample clock；离线快速重放不会把墙钟执行速度误写成语音时间。一次恢复前先清除旧 partial，已有 final 后禁止从样本零重放，空逐字稿禁止冻结。

### 麦克风与录音

- 枚举输入设备并使用 exact `deviceId`；权限后展示实际 track 标签和采样设置。
- 记录 PCM 回调数、RMS、Peak、MediaRecorder chunk 数和字节数，不记录音频/PCM 或逐字稿正文。
- 约 2 秒近静音进入 `silent` 并显示具体设备；不会擅自停止。信号恢复回到 `healthy`。
- AudioContext 的实际采样率跨 chunk 连续重采样到 16 kHz；零增益 sink 防止麦克风监听回放。
- PCM 启动和连续回调由 2 秒滚动 watchdog 监控；停滞时只尝试一次 `AudioContext.resume()`，再观察 1 秒。中断即使随后恢复，也会保留“本遍 PCM 不完整”事实。
- AudioWorklet 在真实设备无回调时自动切到 `ScriptProcessor` 兼容通道；本机麦克风检查已检测到输入（RMS `0.0035`），随后真实自由练习产生 partial、中文 final 和 final-only 本地标注。
- 停止意图后先保留约 300 ms 的单块 PCM 尾窗，再比较录音时长与已产出的 16 kHz PCM 时长；明显缺口、零 callback 或持续停滞时，从同一个 MediaRecorder Blob 在 Renderer 本地解码、声道混合并重采样为 mono 16 kHz，再走一次仅限“尚无 final”的恢复。长录实测曾出现 87.814 秒录音与 PCM 相差 774 ms 的调度尾差并被旧阈值误判；当前逻辑只容忍有界尾差，仍对真实丢样、feed 错误和 watchdog 停滞降级，单测已覆盖。最终 hardening 包的短录停止复验仍待执行。
- MediaRecorder stop event 最多等待 5 秒；用户停止或设备中断后若始终无回调，会清理 track/AudioContext 并进入明确失败，不悬挂在录音中。

### 实时 AI 与下一步

- 反馈设置中的实时 AI 入口可以原位完成：保存 Key → 查看/批准配置级 `live_hint` 同意 → 开启用途 → 本次 Attempt 显式 AI ON。
- Key、同意和 provider 调用仍在既有主进程安全边界；短提示只读冻结任务和累计 final。
- 录音回放区拥有正式 grid area；ASR 失败/短录音时不会被 footer 与 `overflow` 裁掉。
- snapshot IPC 8 秒无终态时转为显式失败和“重试保存快照”，不会永久隐藏 Deep 入口。
- 实时 AI 内联设置完成后可在同一次用户动作中读取刚验证的 consent 并打开本次 Attempt；不再因为 React 状态尚未 commit 而回落为 OFF。
- 设置页或练习页接管另一页面发起的模型安装时，取消动作会等主进程发布 `cancelled / failed` 终态后才解锁重试；不会把“已发送 abort”误报成“已经清理完成”。

### 诊断日志有效性

- 已观察到 500 ms 模型状态轮询曾占据绝大多数诊断事件，快速消耗 25 MB 留存预算而没有增加故障信息。
- 成功的模型状态 IPC 不再逐次记录 start/complete；调用失败仍完整记录。模型下载进度按有意义的百分比里程碑记录，暂停、恢复、校验、安装终态和错误不采样丢弃。
- 7 天留存按事件 `occurredAt` 逐行裁剪，不再把文件 mtime 当事件时间；测试覆盖旧事件文件被 touch 到当前仍删除，以及同一长进程第 8 天当前 run 事件继续保留。畸形 JSONL 行不由维护静默删除，导出仍会给出 corruption 计数。

## 自动化门禁

最终共享树门禁（2026-07-21）：

- `pnpm verify`：51 个测试文件通过、1 个跳过；514 项测试通过、1 项跳过；TypeScript、Electron 系统网络探针、安装期 power blocker 探针、macOS arm64 package、packaged bridge/security smoke、18 个签名目标 gate 与包内 Sherpa `1.13.4` dependency/recognizer constructor smoke 全通过。
- 系统网络探针实测 Electron `43.1.1` 的官方跳转为 `302`、Range 为 `206`，并以流式方式只读取受控 4 B；power blocker 探针实测 `prevent-app-suspension` 成功获取、释放且 `leaked=false`。
- `pnpm verify:electron-visual`：85/85、9 张图、0 失败；打包版使用 `phrio-app:`，bridge 可用、Renderer 无 Node，生产 console 0 error / 0 warning。
- `pnpm verify:electron-product-tour`：90/90、23 张图、0 失败；生产 console 0/0，自动化外部 HTTP(S) 请求 0。
- `codesign --verify --deep --strict`：通过；`Identifier=com.phrio.desktop`、`Signature=adhoc`、无 TeamIdentifier。
- 最新生产包复用上述 fresh-dir 模型重启后，`getEnvironmentStatus()` 再次返回 `localAsr.ready=true`；实际调用 installer 返回 `already_installed`、`downloadedArchiveBytes=0`、`installedModelBytes=237,202,501`。同一运行的结构化日志依次记录 blocker acquired → install skipped → blocker released（`reason=completed`、`releaseAttempts=1`、`verified=true`），没有联网重装或残留 blocker。

本次新增/更新且已进入上述完整门禁的用例范围：

- 模型安装 URL、尺寸、冻结 SHA-256、剩余空间预检、固定 checkpoint、manifest/validator、Range/If-Range、合法 206、200 安全重启、显式取消删除、退出/网络失败保留、tar 成员、文件类型/大小、并发、回滚、重试、IPC schema 与错误码。
- 安装 receipt 原子写入、官方来源冻结、三个目标文件 exact size/SHA-256、缺失/篡改/native dependency/runtime init 分类与成功 probe 缓存；Attempt source sequence watermark 及 segment/annotation/hint 重放去重；macOS 最小 entitlement 与打包后 codesign 权限 gate。
- 每次下载 Attempt 的独立真实/fake idle timer、跨前轮 deadline 不串线；诊断事件时间留存、mtime 刷新与长进程当前 run 保留。
- 录音 Blob 保存失败后的快照/派生图精确回滚、stale Attempt discard 保护；API Key 删除前停止并 drain 三类云请求、迟到结果丢弃与删除失败可重试；诊断日志部分清除失败后的真实磁盘残留、部分完成提示与幂等重试。
- 设备枚举/选择、实际 48 kHz → 16 kHz 重采样、零增益 sink、静音/恢复、安静语音 VAD、PCM 启动/中途停滞 watchdog、同一录音 Blob 恢复、stop event 超时、chunk/track 日志。
- 模型缺失录音前置阻断、同录音 PCM 重转、已有 final 禁止重放、快照超时、明确继续 CTA。
- Live AI Key/同意/用途/本次 ON 的可执行全链。
- 1440×960 与 1024×960 的标准/证据全屏、横向 overflow、单一证据 scroller、控制台和焦点。

## 真实设备 / 服务手工清单

1. 从打包版进入任一练习；模型缺失时确认没有弹麦克风权限，而是显示默认 `226.2 MiB` 三文件安装动作。镜像或官方 Hugging Face 的普通断网、timeout/idle、限流或可重试服务错误都只能保留 direct checkpoint 并提示继续；只有官方 direct 的 Range/redirect 结构明确不兼容，或冻结对象完整性在干净官方重试后仍反复失败时，才提示切换到约 1 GB GitHub fallback。
2. 启动默认三文件下载并等待至少数 MB；记录当前段和字节后正常退出应用。重开后确认 `.phrio-asr-direct-v2` 恢复相同进度，继续后已完成段不重复下载；显式取消应删除 direct checkpoint。再次安装完成后核对 revision、route、三个 exact size/SHA、receipt 和 native probe，重启后仍为 ready。另以受控网络验证 `429/5xx + Retry-After`、官方 Hugging Face 干净重试，以及只有官方 direct 出现结构不兼容或反复完整性失败时才进入约 1 GB GitHub `.phrio-asr-download-v1` fallback。
   - 若镜像精确跳到同一冻结对象的官方入口，确认界面从加速入口迁移为官方直连、继续复用同一 checkpoint，最终 receipt 使用 `resolvedSource`，而不是报 redirect 错误或伪记镜像来源。
   - 人为制造普通 timeout/idle/断网，确认仍显示 `226.2 MiB` direct 总量、保留已下载分段并允许重试，绝不切到 `998.8 MiB` archive；只有受控构造官方 Range/redirect 结构不兼容或反复完整性失败时才进入 archive compatibility fallback。
3. 选择实际要使用的内置或外接麦克风，开始录音并正常说话；确认约 2 秒内输入从 unknown 变 healthy，日志包含 track、PCM、signal，但不含正文。
4. 将系统输入音量降至零或选择无信号设备；确认出现近静音提示、仍可结束，并能切换设备重录。
5. 正常说 30–60 秒；确认 partial 临时替换、final 逐句落定，只有 final 产生标注/统计/AI 累计触发。
6. 结束录音；确认尾句形成 final、回放有声、快照持久化后出现“继续：确认逐字稿”，并完成 Deep → 焦点 → Drill → 复讲 → 比较。
7. 人为使 ASR 在无 final 前失败；确认音频可回放，恢复后“用这段录音重新转写”有效。已有 final 后再失败时确认只允许重录，不重复原句。
8. 在反馈设置中从无 Key 状态完成实时 AI 设置；确认每次新 Attempt 仍默认 OFF，显式 ON 后只有累计 final 才触发短提示。
9. 导出诊断包，核对 `recording.track_metadata`、`recording.pcm_started`、`recording.input_signal_detected|near_silent`、`recording.pcm_stalled|pcm_unavailable|pcm_channel_recovered|pcm_recovered_from_media|media_decode_failed`、MediaRecorder stop timeout、`asr.*`、snapshot 和 AI 事件时序。
10. 模型安装进行中连续触发两次 Cmd+Q；确认 5 秒退出协调不会形成退出循环，进程最终结束，checkpoint 保留且重启可继续。该项用于真实长下载退出体验，不由瞬时原生 blocker smoke 代替。

## 外部依赖与诚实边界

- 旧打包版约 53 MB 后空闲失败并删除 partial 是已确认的历史缺陷，不是用户取消。最新隔离 fresh-dir 的 pre-fix hardening 包又在镜像首跳误拒、官方 direct 到 `59,321,877 B` 后 idle、误入 `998.8 MiB` archive 并失败；它同样没有完成安装，不能报告为成功。
- 最终候选的新隔离目录与既有用户目录都已有可核对的 schema v2 receipt、三个 frozen size/SHA 和 native recognizer/stream probe；最终候选还额外通过退出后重启 ready。真实麦克风兼容通道与中文 partial/final 来自既有用户目录，短录 → 停止 → 快照 → Deep CTA 仍需在最终包复验。
- 自动化使用受控响应、归档和 PCM；fresh-dir 安装、重启 ready 与单次中文转写补足了“链路可用”证据，但仍不证明总体中文识别精度。受锁屏休眠影响的墙钟跨度也不能作为吞吐或安装 SLA。
- 真实 OpenAI Key、网络、计费和 provider 响应未在自动化中调用；本轮不部署、不付费、不修改外部权限。
- 当前包是严格校验有效的内部 Alpha ad-hoc 签名，但没有 hardened runtime、Developer ID 或 notarization。每次重打包的 cdhash 会变化，macOS 可能重新询问麦克风权限；不能把它描述成公开分发已就绪。
