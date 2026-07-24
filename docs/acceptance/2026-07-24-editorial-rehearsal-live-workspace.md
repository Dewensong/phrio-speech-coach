# 2026-07-24 编辑校样式实时工作区验收

## 结论

Phrio 全产品体验改造的第二阶段已完成：

- S04 / S08 默认进入“专注”视图，只呈现 final / partial 原句和一条当前建议；
- 用户可显式切换到“证据”视图，原逐句共享行、O 编号、生命周期、单一滚动区和
  证据全屏保持不变；
- 原三条技术通道压缩为一个事实健康摘要，完整录音、ASR 和分析状态进入
  “采集详情”；
- 模型安装、麦克风权限/静音、no-speech、短录音、停止收束、同录音重转、
  take / 快照保存失败和任务核对失败仍按事实自动上浮，并保留原恢复动作；
- 实时 AI 仍位于独立反馈设置中。配置级同意不自动开启本次 AI，音频和 partial
  仍不进入云端，未经用户明确授权不会发送 final 文本。

这一阶段没有改变 recorder、ASR、Session、Attempt、Snapshot、Evidence、
Deep、AI payload、IPC 或 Repository 协议。Goal 继续 active；下一阶段是逐字稿、
诊断、Drill、复讲和比较的编辑校样式闭环。

## 当前真源

```text
worktree: current product worktree
branch: codex/record-result-evidence-views
starting tip: 0f187ce
implementation commit: 80dacf3
remote: none
```

未修改旧根目录实现、控制仓或 Prototype Studio；未配置 remote、未合并、未发布。

## 功能保全

### 专注与证据不是两套业务逻辑

- `LiveFocusSurface` 只读取现有 `LiveAttemptState`，不生成 annotation、不冻结
  snapshot，也不持有 recorder / ASR 副本。
- final 原句按 sequence 展示；最新 partial 继续复用
  `StablePartialTranscript`，保持临时假设与可访问播报语义。
- 关闭实时反馈时，专注视图继续显示原句，并明确“逐字稿仍会继续记录”；当前建议
  隐藏，录音、partial/final 和分析通道不停止。
- 证据视图继续直接使用同一个 `EvidenceLedger`。全屏只改变展示几何，进入/退出
  仍复用同一 segment DOM、语义滚动锚点和 Esc 回焦。

### 采集摘要与异常上浮

- 正常态第一层只显示“环境已就绪 / 录音与转写正常 / 正在安全收束 / 已安全收束”
  等事实摘要和本机设备/final 信息。
- 展开“采集详情”可查看录音设备、capture 状态、ASR partial/final 状态和本地 /
  AI 分析通道；旧 `.recording-channel`、`.transcript-channel`、
  `.analysis-channel` 仍是同一真实状态节点。
- 阻塞和恢复不进入折叠层：全部 `degradation-banner`、模型继续/取消/删除进度、
  切换设备重录、同音频重转、重试读取 take、重试 task context、确认短录音、
  重试持久化和继续 Deep 的主操作保持在当前页第一层。

### 可访问与隐私

- “专注 / 证据”使用真实 `tablist / tab / tabpanel` 语义，只有当前 tab 进入
  Tab 顺序；方向键、Home、End 可切换并移动焦点。
- “采集详情”和“反馈设置”继续使用原生 `details`，键盘可达。
- reduced motion 继续关闭平滑滚动和非必要动画。
- 实时 AI 设置、Key、用途、配置级同意、本次 ON 和撤回仍是独立动作；本轮没有
  调用 OpenAI，也没有放宽 final-only 或 exact-purpose 边界。

## 自动化证据

执行：

```bash
pnpm typecheck
pnpm exec vitest run tests/e2e/frontend-flow.test.tsx tests/e2e/live-feedback-controls.test.tsx
pnpm verify
```

结果：

- 定向实时页：2 个文件 / 29 项通过。
- 完整测试：59 个测试文件通过、1 个跳过；596 项通过、1 项跳过。
- Electron 系统网络探针通过。
- 安装期 `prevent-app-suspension` 获取、释放且无泄漏。
- macOS arm64 package gate 通过，18 个签名目标有效。
- packaged bridge 仍为 40 个窄方法，Renderer 无 Node，协议仍为 `phrio-app:`。
- Sherpa `1.13.4` 原生依赖 smoke 通过。

新增断言证明：默认视图是专注；四条 final 原句和当前建议可见；证据 DOM 未同时
复制；方向键可切入证据；反馈隐藏后原句和通道保留；证据全屏前后保持同一行和
停止按钮；采集详情可展开。

自动化证明状态和接口没有因展示分层丢失，不证明真实麦克风或模型输出质量。

## 受控 Fixture 与真实 Electron 证据

执行：

```bash
pnpm verify:electron-visual
node scripts/verify-electron-product-tour.mjs --skip-package
```

结果：

- Electron visual：85/85，9 张图。
- Electron product tour：136/136，46 张图。
- 新增受控截图：
  - `qa-00-s04-focus-1440x960.png`：默认专注、4 final、单一当前建议；
  - `qa-00b-s04-capture-details-1440x960.png`：同页展开 capture / ASR /
    analysis 三条真实状态；
- 专注页和采集详情横向 overflow 均为 0。
- S04 / S08 进入证据视图后，原 4 行、O 记录、停止收束、安全快照、证据全屏、
  Esc 回焦和后续 S05–S15 全链路继续通过。
- 1440×960 / 1024×960、100% / 125%、标准 / 证据全屏、reduced motion
  继续通过。
- production console 0 error / 0 warning，产品轨和 QA 轨外部 HTTP(S) 请求 0；
  QA 轨仅保留 Electron 自身开发 CSP 提示。

受控 QA 使用真实 Electron、preload、IPC、SQLite、Session 和持久化图，但其
音频、partial/final、证据和停止事件是明确 Fixture，不能作为真实设备证据。

## 真实设备证据

本阶段没有发起新的真实设备验收：

- 没有请求麦克风权限；
- 没有安装或评价真实本地模型；
- 没有拔出设备、休眠唤醒或做长录音；
- 没有提供 OpenAI Key，没有发送任何转录文本；
- 没有做 Developer ID、公证、stapling 或目标 Mac Gatekeeper 正向路径。

2026-07-23 同一打包版的真实麦克风、停止尾句、快照持久化和同包重启权限证据仍
是有效历史证据，但发生在本次实时页表层改造前，不能替代最终真实设备回归。

## 诚实边界与下一步

尚未关闭：

- 逐字稿确认、诊断结果、Drill、复讲、比较的最终视觉统一；
- 记录、设置、受控 Demo、分享与传播资产的最终统一；
- 全产品 90% / 112.5%、完整深浅主题代表页和键盘路径终验；
- 真实设备切换/中断/恢复、模型中文质量、目标 Mac 性能；
- 用户独立授权后的三种真实 OpenAI 用途；
- Developer ID、公证、Gatekeeper 与升级 TCC 连续性。

当前建议仍是 **继续 Internal Alpha**，不建立可分享公共包。
