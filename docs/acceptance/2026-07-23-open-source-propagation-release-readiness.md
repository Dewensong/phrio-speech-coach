# 2026-07-23 开源传播层与发布就绪度验收

## 结论

本轮已经把 Phrio 从“功能闭环可验收”推进到“可被理解、可被演示、可被贡献、
可做公共候选包”的状态：

- 新用户可在不授权麦克风、不安装模型、不创建记录、不调用云端的前提下，
  用 30 秒受控 Demo 理解“证据 → 一个焦点 → Drill → 同口径复讲比较”。
- 完成记录可在本机生成隐私安全的 PNG / SVG / Markdown 结果卡，并进入纯净
  展示；证据原句默认关闭，完整逐字稿不进入结果卡。
- 仓库已有一致品牌、英文主 README、中文完整说明、MIT License、第三方许可、
  社区治理文件和 build-time task-only 社区 Pack。
- 本地可实际生成带品牌安装背景的 DMG 与 ZIP；公共候选轨已配置 Developer ID、
  hardened runtime、公证、stapling 与 fail-closed 验证，但正向路径尚无真实
  Apple 凭据证据。

发布建议仍是 **继续 Internal Alpha**，不是“建立可分享包”。本机真实麦克风
停止收束已经在本轮复现 P1、修复并通过；继续保持 Internal Alpha 的剩余原因是
Developer ID / 公证正向路径、目标 Mac 性能、真实设备中断矩阵和本地模型质量
仍未关闭。

## 自动化证据

执行：

```bash
pnpm verify
pnpm typecheck
pnpm make
pnpm verify:electron-visual
pnpm verify:electron-product-tour
```

结果：

- TypeScript、Electron 系统网络和安装期防休眠原生探针通过。
- 59 个测试文件通过、1 个跳过；595 项测试通过、1 项跳过。
- macOS arm64 package gate 通过；18 个签名目标、40 方法 packaged bridge、
  `phrio-app:` 自定义协议、Renderer Node 禁用与 Sherpa `1.13.4` smoke 通过。
- App 包中 10 份 Phrio / Electron / 直接运行时 / Apache-2.0 许可证资源存在且
  非空。
- 当前 ad-hoc App 为 `Identifier=com.phrio.desktop`、
  `Signature=adhoc`、`TeamIdentifier=not set`。
- 公共候选 gate 对当前 App 返回非零，并明确拒绝
  `Release candidate is not signed by a Developer ID Application identity.`；
  该结果证明内部包不能误晋级，不证明 Developer ID 正向路径。

## 受控 Fixture 证据

### 传播素材

`pnpm capture:propagation-assets` 使用真实打包 Electron 和隔离空
`userData` 生成 Hero、Demo GIF 与 social preview。报告确认：

- 麦克风请求：0
- 模型安装：0
- 练习记录创建：0
- 外部 HTTP(S) 请求：0
- Renderer error：0

### Electron 视觉与产品巡检

- Electron visual：85/85，9 张截图；覆盖 1440×960 / 1024×960、
  100% / 125%、标准 / 证据全屏、语义锚点、Esc 回焦、reduced motion、
  一个证据 scroller 与横向 overflow 0。
- Electron product tour：128/128，40 张截图、13 个产品步骤、6 个 QA
  步骤；覆盖首次进入、受控 Demo、模式/题库/设置/主题/诊断、自由练习、
  Session/IPC/SQLite、partial/final、结果流、自由复讲、焦点 Drill、复讲、
  paired-1、结果卡、记录管理和双视图。
- 打包产品轨 console 为 0 error / 0 warning，外部 HTTP(S) 请求为 0。
  开发 QA 轨只有 Electron 自身的开发期 CSP 提示。
- 分享卡在 1440×960 与 1024×960 下完成布局检查；长中文证据按实际像素
  宽度换行，画布内容未被裁切。默认导出不含完整逐字稿，也不含证据原句。

受控事件通过真实 Electron、preload、IPC 和 SQLite，证明 UI 与持久化闭环；
它不证明真实麦克风、生产 Sherpa 质量或真实云服务。

## 真实 Mac 界面证据

本机执行 `pnpm make` 后，在真实 Finder 中打开最终 DMG：

- 只显示 `Phrio.app` 与 `Applications` 两个对象；
- Phrio 图标、品牌背景、拖拽方向、安装文案与底部
  `Local-first · macOS Apple Silicon` 完整可见；
- App Icon 使用透明外画布，Finder 系统 24 px 图标视图不再出现旧版白色方块；
  192 / 128 / 64 / 32 px 均保持连续 `P`、错位复讲副线与单一焦点可辨识；
- App Icon、产品内 Logo、DMG、结果卡与 GitHub social preview 使用同一
  纸张 / 油墨 / 套印错位语言，不使用玻璃面板、柔光渐变、麦克风或装饰波形；
- Finder 状态栏显示 2 个项目；
- DMG：`135,803,929 B`，
  SHA-256 `62156a18483c7f819a5e59b5f12d6d9a67e404f98165ffc7ed59521418a2888b`；
- ZIP：`137,987,136 B`，
  SHA-256 `652668b8bac396f626596e7ca3a21122b61ed79007f2bd0f31273c17a67ea684`。

这是实际安装界面与制品证据，但包仍是 ad-hoc；它不是目标用户 Mac 的
Gatekeeper、一次授权后重启、Developer ID 或公证证据。

## 真实麦克风与权限持久性证据

### 失败样本与 P1 修复

先用分支 tip `b3a347f` 的真实打包版、当前用户目录中的已安装模型和 MacBook
Air 内建麦克风进行自由初讲。应用获得真实输入、持续 partial 和 4 个 final，
但用户停止后诚实进入降级：

- MediaRecorder take：`20,251 ms`
- AudioWorklet PCM：`19,584 ms`
- PCM 缺口：`667 ms`
- PCM 回调：`306`
- 输入聚合 RMS：`0.0487`
- 事件：`recording.pcm_capture_incomplete`

本地诊断证明缺口不是设备中断、掉帧或模型初始化失败。真正原因是冷启动
`audioContext.audioWorklet.addModule()` 的异步初始化仍发生在 MediaRecorder
和用户可见“录音中”之后；上一版只排除了 `MediaRecorder.start()` 的同步
encoder 初始化时间。修复后先准备实时 PCM 通道，再启动 MediaRecorder、覆盖
计时和用户可见录音状态；同时增加 650 ms 异步 worklet 初始化回归测试，保证
准备期间 recorder 保持 inactive。

### 修复后实录

重新打包后，在同一台 Mac、同一内建麦克风和真实本地模型上完成 17 秒自由初讲：

- MediaRecorder take：`17,521 ms`
- AudioWorklet PCM：`17,512 ms`
- 覆盖差：`9 ms`
- PCM 回调 / 样本：`274` / `280,192`
- ASR dropped samples：`0`
- queue 最大延迟：`84 ms`，超过 100 ms 的次数为 `0`
- `recording.pcm_flush_acknowledged`
- 停止尾段生成第 3 个 final
- 没有 `recording.pcm_capture_incomplete`

用户确认短录音后，界面显示“尾句已收束”“初讲快照 v1 · 已持久化”和
“继续：确认逐字稿”；随后成功进入 final v1 逐字稿确认与本地诊断页。诊断页
明确显示音频来源为本地真实录音、文字来源为固定 Sherpa 模型、网络发送为
“无”，完整 AI 复盘未启用。OpenAI 全程为 disabled，没有发送转录文本。

这是当前 Mac 上的真实设备证据，不是受控 Fixture，也不宣称中文识别准确率、
模型质量或性能已经达标。

### 为什么重新打包会再次询问、同包重启不会

本轮修复包仍是 ad-hoc 签名：

```text
Identifier=com.phrio.desktop
Signature=adhoc
TeamIdentifier=not set
# designated => cdhash H"b0ff5fa4fdf3ba886e8067268675766b3509f79c"
```

代码重打包后 CDHash 改变，用户真实观察到 macOS 再次弹出麦克风授权。保持这
一个修复包完全不变、不重新打包，只退出并重新启动，再开始一次真实录音时，
用户确认没有再次出现系统授权窗。由此可以诚实得出：

- 同一个未变化的 App 包在本机重启后可以复用一次授权；
- ad-hoc 开发包每次重建不具备稳定代码身份，可能再次询问；
- 正式分发要依赖固定 bundle ID、Developer ID 签名、固定安装路径和公证后的
  升级链，当前证据不能替代该正向路径。

## 开源传播与贡献边界

- README 主入口用一句方法、真实打包 UI Hero、受控 Demo GIF、隐私表格和
  Quick Start 降低理解成本；social preview 资产已准备，但尚未上传远程设置。
- 社区 Task Pack 只接受 strict JSON，复用现有 mode / criterion / Drill，
  build-time 编译与去重；不下载、不解释、不执行贡献者代码。
- Phrio 自有代码和资产采用 MIT；模型不入仓、不入 App，保留上游许可证。
  App 内已携带当前直接运行时依赖许可，公开发布前仍需做一次完整依赖与模型
  来源复查。
- 结果卡不创建公共 URL、不自动上传；真实 OpenAI 文本传输仍按用途和 exact
  payload 独立同意。

## 尚未通过

- 真实设备切换、中断、恢复和长时间稳定性。
- 当前固定本地模型在真实中文表达任务上的质量判断与目标 Mac 性能。
- 用户明确授权后的真实 OpenAI 调用；本轮没有 Key，也没有发送转录文本。
- Developer ID、hardened runtime、公证、stapling、Gatekeeper 和目标 Mac
  “首次允许 → 版本升级 → 重启不再询问”的正向证据；当前只证明同一个未变化
  的 ad-hoc 包在本机重启后不再询问。
- 远程 GitHub Actions 运行、分支保护、Release 和公开发布。

## 实现真源与下一步

当前候选仍是：

```text
current product worktree
branch: codex/record-result-evidence-views
parent baseline: 9b944af08878adf28ef2f7c907aa1b7c427df498
propagation implementation: a8046c4
release surface implementation: 393a594
real-microphone P1 closure: the commit containing this document (parent b3a347f)
remote: none
main: none
```

本轮代码、品牌与发布配置已形成上述两笔实现提交，验收、决策与真源文档随当前
分支 tip 收口，不再依赖未提交代码。旧根目录
historical root worktree 的
`codex/phase-1-foundation` 是祖先检查点，不是当前构建输入。

在 Dewens 明确授权以前，不配置 remote、不合并、不发布。安全收口顺序是：

1. 保持当前候选为唯一构建输入，继续目标 Mac 设备中断、性能与签名正向验收。
2. 选择空的私有远程，只先推送候选分支。
3. 等待 `verify-macos-arm64` 在远程对同一分支 tip 通过。
4. 将 `main` 直接建立在该候选 tip，不从旧根目录分支合并。
5. 启用 PR、必需检查、禁止 force-push 等保护后，再决定是否生成
   Developer ID 候选包。
