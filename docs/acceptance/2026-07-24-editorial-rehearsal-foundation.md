# 2026-07-24 编辑校样式体验基础验收

## 结论

Phrio 全产品体验改造的第一阶段已完成并通过门禁：

- 新的产品表层语言已从通用 SaaS 卡片转向“编辑校样 × 表达排练 × 纸墨套印”。
- 首页和练习准备页已按新层级重做，现有创建 Session、任务冻结和训练入口没有
  被改写或删除。
- 功能保全矩阵、后续页面去向、分阶段实施和最终三类证据门已形成稳定计划。
- 该结果只证明视觉基础与首次成功路径，不宣称实时页、Deep、记录、设置和分享
  已经完成最终改造。

Goal 继续保持 active。下一实施波次是实时练习的专注/证据分层、采集详情和异常
上浮。

## 当前真源

```text
worktree: current product worktree
branch: codex/record-result-evidence-views
starting tip: aae3f5a75efdb8ad28db6c9168d17cb4967db526
implementation commit: 202e645
remote: none
```

执行前 Worktree 干净。没有读取或修改旧根目录实现、控制仓或 Prototype Studio，
也没有配置 remote、合并或发布。

## 实现范围

### 功能与视觉基线

新增
[`2026-07-24-editorial-rehearsal-redesign.md`](../plans/2026-07-24-editorial-rehearsal-redesign.md)，
逐项记录现有能力在新版第一层、第二层或异常层的位置，并冻结以下边界：

- Renderer / preload / IPC / Service / Repository 分层不变；
- Session、Attempt、Snapshot、纠正、诊断、焦点、Drill 和比较身份不变；
- partial、音频、OpenAI exact payload 和本地隐私规则不变；
- 低频能力可以降低正常视觉权重，异常和恢复不能被隐藏；
- 自动化、受控 Fixture 和真实设备证据继续互不替代。

### 视觉基础

- 新增暖纸、深墨、海绿套印、单一朱红校样和展示宋体语义 Token。
- 应用外壳、侧栏、命令栏、检查器、按钮和焦点继续使用现有主题/缩放体系，
  但改用细规则、页码、边注和少量套印标记建立层级。
- 不引入玻璃、模糊、发光、霓虹或装饰波形。

### 首页

- 自由练习成为主视觉和唯一首要 CTA。
- 题目仍可留空；听众和目标默认值及创建语义不变，只收进可展开的“练习条件”。
- 受控 Demo 保留，并继续声明不用麦克风、不安装模型、不创建记录。
- 三种模式和选中模板的开始入口保留；首页推荐限制为 3 条，完整题目、搜索、
  收藏和社区 Pack 仍由题库入口承担。
- 最近练习、记录管理、外观和隐私导航保持原对象 IA。

### 练习准备

- 任务、模式、听众、沟通目标、时长和主要约束重排为一张排练单。
- 听众、目标和时长继续可编辑；缺失必填项仍禁用开始。
- 开始动作仍创建真实 Session 并冻结同一份任务快照。
- 麦克风请求、本地音频策略和内容版本仍在摘要区明确展示。

## 自动化证据

执行：

```bash
pnpm typecheck
pnpm vitest run tests/e2e/frontend-flow.test.tsx tests/unit/theme-token-contract.test.ts
pnpm verify
```

结果：

- 定向首页、准备页和主题契约：2 文件 / 43 项通过。
- 完整测试：59 个测试文件通过、1 个跳过；596 项通过、1 项跳过。
- Electron 系统网络探针通过。
- 安装期 `prevent-app-suspension` 获取、释放且无泄漏。
- macOS arm64 package gate 通过，18 个签名目标有效。
- packaged bridge 仍为 40 个窄方法，Renderer 无 Node，协议仍为 `phrio-app:`。
- Sherpa `1.13.4` 原生依赖 smoke 通过。

新增交互测试明确证明：

- 展开练习条件后，听众和目标仍进入同一 `onStartFree` 输入；
- 首页保持 3 条推荐和完整题库入口；
- 模板“开始初讲”仍调用原任务选择与开始命令。

这些结果证明功能接口没有因表层重排丢失，不证明真实麦克风或模型质量。

## 受控 Fixture 与真实 Electron 证据

执行：

```bash
pnpm verify:electron-visual
pnpm verify:electron-product-tour
```

结果：

- Electron visual：85/85，9 张图。
- Electron product tour：134/134，44 张图，13 个产品步骤、6 个 QA 步骤。
- 首页覆盖 1440×960、1024×960、1024×960 / 125%；主动作位于 viewport，
  推荐数量为 3，练习条件默认折叠，横向 overflow 0。
- 准备页覆盖 1440×960、1024×960；听众、目标、时长和开始动作完整，横向
  overflow 0。
- S04/S13 原共享行、O 锚点、单一证据 scroller、证据全屏、Esc 回焦和
  1024 / 125% 布局继续通过。
- 产品轨 console 0 error / 0 warning，外部 HTTP(S) 请求 0。
- QA 轨只有 Electron 自身开发 CSP 提示，没有意外 warning。

受控 QA 继续使用真实 Electron、preload、IPC 和 SQLite，但其音频、partial/final
和证据输入仍是明确 Fixture。

## 真实设备证据

本阶段没有进行新的真实麦克风、设备中断、本地模型质量或 OpenAI 调用：

- 没有请求麦克风权限；
- 没有发送转录文本；
- 没有提供或使用 OpenAI Key；
- 没有重做 Developer ID、公证或目标 Mac Gatekeeper 验收。

2026-07-23 的当前 Mac 真实麦克风停止收束和同包重启权限证据继续有效，但它发生
在本轮实时页改造之前，不能替代未来核心工作区完成后的真实设备回归。

## 尚未完成

- 实时页的专注模式 / 证据模式、采集详情和异常自动上浮。
- 逐字稿编辑纸、诊断审计折叠、单动作 Drill 和双页比较。
- 记录、设置、受控 Demo、分享卡与传播资产的最终统一。
- 全产品 90% / 100% / 112.5% / 125% 和所有主题代表页复验。
- 真实设备切换、中断、恢复、长时间稳定性、本地模型质量和目标 Mac 性能。
- 用户单独授权后的真实 OpenAI 用途。
- Developer ID、公证、stapling、Gatekeeper 和升级 TCC 正向路径。

当前发布建议仍是 **继续 Internal Alpha**。
