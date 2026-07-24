# 真实 Electron 视觉与交互验收

日期：2026-07-18

## 结论

`pnpm verify:electron-visual` 已通过。验收脚本通过 Chrome DevTools Protocol 连接真实 Electron Chromium，而不是把页面放进普通浏览器中伪装 Electron。完整运行会生成 8 张受控内容截图、1 张真实生产包首启截图以及机器可读报告：

- 报告：`output/playwright/electron-visual/report.json`
- 进程日志：`output/playwright/electron-visual/*-process.log`
- 截图：`output/playwright/electron-visual/*.png`

`output/` 已加入 `.gitignore`；这些产物用于本机复核，不作为长期版本资产提交。

## 两条验收通道

| 通道 | 真实部分 | 受控部分 | 能证明 | 不能证明 |
| --- | --- | --- | --- | --- |
| 生产包首启 | 实际 `Phrio.app`、主进程、preload、IPC、`phrio-app:` 协议、空白隔离 userData | 无 | 生产包可启动，安全协议和 preload 生效，渲染器无 Node，首屏无横向溢出，控制台零错误/零警告 | 练习态布局、真实麦克风与 ASR |
| 开发 Electron 视觉 fixture | 实际 Electron 窗口、Chromium、主进程、preload、IPC、durable Session 与产品 CSS | `?qa=1` 提供确定性的音频/转写/证据输入 | 两种窗口尺寸、字号、证据全屏、焦点、滚动锚点、reduced motion 和布局约束 | 真实麦克风、真实 ASR 模型、云端供应商 |

开发通道截图文件名包含 `electron-dev-fixture`，报告明确写入“controlled input inside a real durable Session”；不得把确定性音频/事件描述成真实麦克风或真实 Sherpa 验收。

## 自动断言

脚本覆盖以下组合：

- 视口：`1440 × 960`、`1024 × 960`
- 产品字号设置：`100%`、`125%`，通过真实 preload IPC 持久化后重载，不注入临时 CSS
- 展示状态：标准练习态、证据全屏态

每个组合必须满足：

- Electron 内部视口尺寸精确匹配；
- 根节点与 body 的横向溢出为 `0`；
- `.app-shell` 覆盖整个视口，四边误差不超过 `1px`；
- 页面只有一个证据台账，证据工作区只有一个纵向滚动区域；
- 原句与问题逐句同行，行顶和行底对齐误差不超过 `1px`；
- 进入全屏和按 `Esc` 退出时，语义滚动锚点不变；
- `Esc` 退出后焦点回到“证据全屏”触发按钮；
- 系统 reduced-motion 与应用 reduced-motion 都把相关动效压缩至近零，同时全屏交互仍可操作；
- fixture 控制台无 error；生产包控制台无 error 和 warning。

开发服务器使用 Vite 的 `unsafe-eval`，Electron 会输出开发态 CSP warning。脚本如实记录该 warning，但不将它冒充生产包告警；生产包通道要求 warning 为零。

## 本轮发现并修复的问题

真实截图发现 125% 字号下应用只覆盖约 80% 的窗口，原来的“横向溢出为零”检查无法发现这种欠填充。原因是 `.app-shell` 同时使用 `zoom: 1.25` 和反向缩小的宽高，形成了双重补偿。

修复后 `.app-shell` 保持 `width: 100%`、`height: 100%`，由 CSS `zoom` 完成字号与整体界面缩放；验收脚本新增视口覆盖硬断言。两种尺寸、两种字号与两种模式的 `rightGap`、`bottomGap` 均为 `0`。

## 复现命令

完整验收（推荐）：

```bash
pnpm verify:electron-visual
```

仅排查开发 Electron fixture：

```bash
pnpm verify:electron-visual -- --fixture-only
```

仅复核已有生产包：

```bash
pnpm verify:electron-visual -- --packaged-only --skip-package
```

Electron Forge 的开发启动和打包共用 `.vite`。不要让该脚本与另一个 `pnpm start` 或 `pnpm package` 并行运行。完整脚本会先执行 fixture，再重新打生产包，最后验证生产包，从而避免把开发 URL 留在正式主进程 bundle 中。

## 仍需外部实机验收

自动化没有伪造以下结论；它们仍需在安装真实模型与真实麦克风的目标 Mac 上手工完成：

- macOS 麦克风首次允许、拒绝、在系统设置恢复后重新授权；
- 真实麦克风输入、设备拔出、睡眠唤醒和长录音停止；
- 三份真实 ASR 模型下的 partial/final、端点、尾句和 no-speech 行为；
- 真实模型下的 CPU、内存、准确率和延迟。
