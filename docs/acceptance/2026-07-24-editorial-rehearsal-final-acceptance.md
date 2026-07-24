# 2026-07-24 编辑校样式全产品终验

## 最终结论

“编辑校样 × 表达排练 × 纸墨套印”全产品改造已在当前实现分支完成。首页、准备、
实时专注/证据、逐字稿、诊断、Drill、复讲、比较、记录、设置、受控 Demo、结果卡
与仓库传播素材已经使用同一产品语言，原 recorder、ASR、AI、数据、隐私、IPC 和
证据边界没有被替换。

最终建议：**继续 Internal Alpha**。

- 对 Dewens 当前这台 Mac 的本机使用：候选包可继续直接使用。
- 对源码审阅或后续开源准备：当前 Worktree 可确立为唯一产品真源。
- 对外部用户可下载的分享包：暂不建立。当前包仍是 ad-hoc，无 Developer ID、
  notarization、stapling、目标 Mac Gatekeeper 和跨版本 TCC 正向证据。

## 当前真源与拓扑

```text
worktree: current product worktree
branch: codex/record-result-evidence-views
acceptance implementation tip: 0f1f92287686299b42a94c7cc14e474a4cd55c08
remote: none
main: absent

old root worktree: historical root worktree
old root branch: codex/phase-1-foundation
old root tip: 5f33f6912402a7ed48c99aa5cec97bfb6c0e5c1e
relationship: old root tip is an ancestor of current tip
distance: current tip is 29 commits ahead
```

另有 `expression-practice-coach-fast-deep` 历史 Worktree；它不作为当前发布输入。
本轮未修改旧根目录、控制仓或 Prototype Studio，未配置 remote、未合并、未发布。

## 自动化证据

最终产品代码执行：

```bash
pnpm verify
```

结果：

- TypeScript 通过；
- 59 个测试文件通过、1 个跳过；
- 596 项测试通过、1 项跳过；
- Electron 系统网络探针通过；
- 安装期 `prevent-app-suspension` 获取、释放且无泄漏；
- macOS arm64 package gate 通过，18 个签名目标有效；
- packaged bridge 为 40 个按用例命名的窄方法；
- Renderer 无 Node，协议为 `phrio-app:`；
- Sherpa `1.13.4` 原生依赖 smoke 通过。

测试覆盖功能保全、持久化、并发、失败恢复、数据治理、同意、删除和展示层；它不
证明真实麦克风、模型中文质量、OpenAI 结果质量或目标 Mac 性能。

## 受控 Fixture 与真实 Electron 证据

### Electron visual

```text
85 / 85 assertions
9 screenshots
```

覆盖：

- 1440×960 / 1024×960；
- 100% / 125%；
- 标准 / 证据全屏；
- 共享行几何、单一 scroller、语义滚动锚点；
- Esc 退出全屏并回焦；
- 系统 reduced motion 与应用 reduced motion；
- production console 0 error / 0 warning。

### Electron product tour

```text
149 / 149 assertions
49 screenshots
13 product steps
6 QA steps
```

最终新增终验：

- 浅色 / 深色主题都在完整应用外壳生效；深色主页主动作可见、横向 overflow 0；
- 90% / 100% / 112.5% / 125% 四档均通过真实设置 UI 和 IPC 持久化；
- 90% / 112.5% / 125% 的 1024 主页面主动作可见、横向 overflow 0；
- 125% / 1024 的记录菜单位于视口内，并由键盘 Enter 打开；
- 实时专注 / 证据 tab 支持方向键、Home、End；
- 证据全屏、分享纯净展示、菜单和对话框 Esc 路径保持；
- 诊断证据定位会把键盘焦点移到相同冻结 O 记录；
- 产品轨 console 0 error / 0 warning，产品轨和 QA 轨外部 HTTP(S) 请求 0；
- QA 轨仅有开发服务器 `unsafe-eval` CSP 提示，打包产品轨没有该提示。

受控产品旅程使用真实 Electron、preload、IPC、SQLite、Session 和持久化图，但
音频、partial/final、证据与停止事件是明确 Fixture，不替代真实设备证据。

### 传播素材

真实打包 Electron + 隔离空 `userData` 采集结果：

```text
microphone requested: false
model installed: false
practice record created: false
external request count: 0
renderer error count: 0
```

Hero、GIF 和 social preview 已随仓库更新；这是受控传播证据，不是用户效果或
真实录音证据。

## 真实设备证据

### 已有历史证据

2026-07-23 同一产品线的真实打包版在当前 MacBook Air、内建麦克风和已安装本地
模型上完成过：

- AudioWorklet PCM 17,512 ms / MediaRecorder 17,521 ms；
- 274 次回调、280,192 个样本、0 丢弃；
- 连续 partial、3 个中文 final、停止尾句落定；
- 短录音确认、快照 v1 持久化、final v1 冻结和本地诊断；
- OpenAI disabled，网络发送显示“无”；
- 同一未变化包退出重启后不再次弹出麦克风授权。

这是真实设备历史证据，但发生在本轮表层改造前。它证明核心 recorder/ASR 路径曾
在这台机器上成功，不等于新版所有页面已经重新跑完真实设备闭环。

### 本轮未新增

- 没有重新请求麦克风或评价模型中文质量；
- 没有拔出设备、切换输入、休眠唤醒、长录音或目标 Mac 性能测量；
- 没有提供 OpenAI Key，没有发送任何转录文本；
- 三种真实 OpenAI 用途仍需分别取得用户明确授权；
- 没有 Developer ID、公证、stapling 或外部 Mac Gatekeeper 正向路径。

## 候选包身份

```text
version: 0.1.0-alpha.0
bundle identifier: com.phrio.desktop
signature: ad-hoc
TeamIdentifier: not set
```

因此：

- 可以作为当前 Mac 的 Internal Alpha 本机候选；
- 可以用于源码审阅、CI 和受控传播素材；
- 不能描述为 Developer ID 签名、公证或适合普通外部用户直接安装的公共包。

## 三选一建议

### 1. 继续 Internal Alpha — 建议

产品闭环、视觉一致性、自动化、受控 Electron、隐私边界和开源仓面已足够成熟，
适合继续真实自用、收集表达质量反馈、完善真实设备矩阵，并准备远程主真源。

### 2. 建立可分享包 — 暂不建议

只有在 Developer ID / hardened runtime / notarization / stapling、目标 Mac
Gatekeeper、升级后 TCC 连续性、真实本地模型质量与用户授权 OpenAI 路径关闭后，
才建议建立面向普通外部用户的分享包。

### 3. 暂停 — 不建议

没有未解决的自动化或受控 Electron P0/P1，也没有发现必须暂停 Internal Alpha
的功能性阻断。未关闭项主要属于外部发布与真实环境证据，不是当前本机自用阻断。

## 安全确立产品仓主真源

当前三个 Worktree 已属于同一个 Git 仓。旧根目录 tip 是当前 tip 的祖先，因此
不需要把旧实现合回当前分支，也不应从旧根目录制作发布包。

建议在 Dewens 单独批准后按以下顺序执行：

1. 在当前 Worktree 再次确认 clean，并记录最终 tip。
2. 可选地先生成本机 `git bundle --all` 离线备份。
3. 在当前 tip 创建并切换 `main`，保留
   `codex/record-result-evidence-views` 作为同点回退引用：

   ```bash
   git switch -c main <final-tip>
   ```

4. 保留旧根目录 `codex/phase-1-foundation` 和 fast-deep Worktree 为只读历史，
   不从它们构建；不要急于删除 Worktree。
5. 单独选择 GitHub 远程仓后，再经明确授权配置 `origin` 并只推送 `main`；
   当前没有 remote，不执行任何隐式发布。
6. 在 GitHub 设置 branch protection，把现有 `pnpm verify` CI 设为 required，
   再决定是否公开仓库。
7. 远程 SHA、CI 和 clone-from-zero 验证通过后，才考虑移除旧 Worktree 或建立
   Developer ID 公共候选。

这是一条“让 `main` 直接指向最新真源”的路径，不做旧分支合并，不修改控制仓，
也不把 Prototype Studio 变成实现来源。

## 验收后主真源收口

在本验收完成后，Dewens 单独批准了上节第 3 步。当前产品 Worktree 已在
`cd4e33bf0939314fa85f46b500c48d1c705688ca` 直接建立并切换到 `main`；
`codex/record-result-evidence-views` 保留在同一建立基点，没有产生合并提交。
仓库仍无 remote、未推送、未发布。后续开源安全面改动从 `main` 继续，原验收
块中的 `main: absent` 继续作为验收当时的历史快照，而不是当前拓扑声明。
