# 2026-07-18 真实 Electron 产品交互巡检

## 结论

`pnpm verify:electron-product-tour` 已通过。2026-07-21 最终共享树报告记录 **90 / 90 条断言通过、23 张截图、0 个失败项**。

- 机器可读报告：`output/playwright/electron-product-tour/report.json`
- 进程日志：`output/playwright/electron-product-tour/*-process.log`
- 截图：`output/playwright/electron-product-tour/*.png`

脚本先在真实 Electron 开发窗口运行显式 `?qa=1` 的受控输入轨：音频、partial/final、证据与尾句事件由脚本直接注入，但 Session、Attempt 音频、快照、Deep report、焦点、Drill、复讲、比较和历史均经过真实 preload/main、IPC 与 SQLite。随后脚本重新执行 `pnpm package`，再用隔离的空白 `userData` 启动真实生产包。这样既不会把受控输入冒充生产 recorder、Sherpa、规则标注/尾句编排或云服务，也不会让开发入口残留在最终生产构建中。

## 生产产品轨

生产轨使用 `phrio-app:`、真实 preload/main IPC、隔离的空白用户目录，并确认 Renderer 没有 Node `process`。覆盖：

1. S00 首次处理边界与进入 S01。
2. 自由练习入口真实可操作。
3. 清晰表达、决策与对齐、论证与反驳三种模式在练习内部切换。
4. 题库选择与真实 IPC 收藏持久化。
5. 收藏题目独立页面可达。
6. 练习设置中的音频保留偏好真实保存到本机。
7. 浅色雾蓝配色与深色主题切换；取样会先越过 160ms 主题过渡并等待至少 220ms，再轮询 App shell、Sidebar、Workspace、Canvas 的 computed background 与当前语义 token 完全一致，因此截图是稳定主题态而非过渡插值帧。四层渲染背景共同变化，而非只切换强调色。
8. 常规与隐私如实显示本地 ASR 状态和未配置 API Key；空 Key 不能提交。
9. “清除全部训练数据”和“恢复默认偏好”只进入第二段确认并取消，没有执行破坏性操作。
10. 自由练习创建真实本地 Session 并进入 S04，期间没有请求麦克风。
11. 左侧最近练习打开 S13 详情；最近练习旁的“全部”打开 S10 全部记录。
12. 1440px 标准宽度下，S13 的 `is-active` / `aria-current="page"` 集合严格只有当前最近练习条目，“新练习”和“练习记录”都不选中；S10 则严格只有“练习记录”选中。对应截图前指针会移到 Canvas 非交互区域，排除 hover 干扰。
13. 全程无全局横向溢出、无 Renderer console error/warning、无外部 HTTP(S) 请求。

## Fast → Deep 持久化 QA 轨

QA 轨使用真实 Electron Chromium、preload/main、IPC、SQLite 和私有音频 Repository；音频、partial/final、证据与尾句事件均为直接注入的确定性输入。它验证 durable Session 跨页面闭环，不验证生产 recorder、Sherpa、规则标注/尾句编排或云服务：

1. `?qa=1` 首先通过真实 IPC 创建并启动一个非 `qa-session` 的 durable Session。
2. 四个 final 形成四个共享证据行，标准模式只有一个证据滚动上下文且横向溢出为 0。
3. 可见的“反馈设置”可隐藏/恢复反馈，转录行不被删除。
4. 证据全屏复用相同 segment/evidence 状态；仍只有一个滚动上下文；Esc 退出并恢复触发按钮焦点。
5. “完成尾句收束”进入 `safe_end` + ASR `ready`，初讲 snapshot 先写入 SQLite 后才出现“确认逐字稿”。
6. S05 可回查 4 个 final 与本地受控音频；确认后 S06 从冻结 Session/Attempt 读取逐字稿、证据和任务 Rubric。
7. 用户只选择一个焦点，启动内联 Drill，必须真实点击开始并明确自检后才能进入复讲。
8. S08 在同一 Session/task/focus 下形成 retry Attempt 与第二份冻结快照。
9. S09 以 frozen `comparisonDimension` 执行 paired-1，只展示两遍完整逐字稿和该口径 basis，不生成总分。
10. 保存后 Session 状态为 completed，两个 Attempt 均 confirmed；历史详情仍可读取两遍 snapshot、证据、唯一焦点与比较产物。
11. 全程无 console error、无非预期 warning、无外部 HTTP(S) 请求；报告保留 Electron 开发模式固有的 CSP notice 作为透明记录。

## 关键截图

- `product-02-home-free-practice-1440x960.png`
- `product-03-task-library-favorite-1440x960.png`
- `product-05-appearance-light-fog-blue-1440x960.png`
- `product-06-appearance-dark-1440x960.png`
- `product-07-settings-clear-confirmation-1440x960.png`
- `product-09-recent-record-detail-1440x960.png`
- `product-10-history-all-1440x960.png`
- `qa-01-s04-standard-1440x960.png`
- `qa-02-s04-fullscreen-1440x960.png`
- `qa-03-s04-safe-end-durable-1440x960.png`
- `qa-04-s04-safe-end-fullscreen-1440x960.png`
- `qa-05-s05-transcript-review-1440x960.png`
- `qa-06-s06-deep-lane-1440x960.png`
- `qa-07-s07-drill-1440x960.png`
- `qa-08-s08-retry-safe-end-1440x960.png`
- `qa-09-s09-paired-comparison-1440x960.png`
- `qa-10-s10-completed-history-1440x960.png`
- `qa-11-s13-completed-detail-1440x960.png`

## 命令

完整巡检（推荐，会在 QA 后恢复生产构建）：

```bash
pnpm verify:electron-product-tour
```

只跑产品轨并复用现有生产包：

```bash
pnpm verify:electron-product-tour -- --product-only --skip-package
```

只跑 QA 轨且不恢复生产构建：

```bash
pnpm verify:electron-product-tour -- --qa-only --skip-package
```

最后一种命令会让 Forge 的共享 `.vite` 保持开发入口，只适合局部调试；正式交付应使用完整命令或随后重新执行 `pnpm package`。

## 仍需真实环境手工验收

- macOS 麦克风允许、拒绝及系统设置恢复。
- 真实设备录音、回放、重录、设备拔出、睡眠唤醒和长录音停止。
- 安装真实本地 ASR 模型后的 partial/final、VAD、端点、尾句和无语音行为。
- 用户自行配置 OpenAI API Key 后的三个独立用途；本次巡检没有写入 Key、没有外部调用。
- 目标 Mac 与真实模型上的 CPU、内存、准确率和端到端延迟。
