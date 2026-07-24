# 2026-07-21 练习结果层级与冻结实时证据双视图验收

## 结论

每条完成的练习记录现在同时提供“诊断结果”和“实时证据”两种回查方式。诊断结果默认打开，并以“一句话结论 → 判断证据 → 唯一焦点 → 下一步”建立明确阅读顺序；实时证据则按录制时批准的左右共享行格式，回放初讲或复讲各自冻结的原始 final、时间码、O 编号、问题记录和短提示历史。

两种视图刻意回答不同问题：诊断结果展示纠正后的当前判断，实时证据保留系统当时逐句看到的内容。它们共享一份持久化 Session / Attempt 引用图，但不会互相覆盖。

## 界面与交互

- S13 顶部使用“诊断结果 / 实时证据”同级 tabs。点击或按 Enter 激活诊断证据中的 O 记录会切到实时证据、定位对应句段和 O 编号，并把键盘焦点移交给匹配的右栏记录。
- 诊断主卡依次展示：一句话结论、支持该结论的原句证据、只练一个焦点、冻结的内联短 Drill、下一步怎么改。任务条件、完成路径、逐字稿版本、报告来源和 lifecycle 仍可查，但降为次级信息。
- 实时证据保留左侧转录原句、右侧同句问题与建议；每个 final 是同一共享行，左右随内容共同增长。精确词组继续使用语义色、线型和 O 编号；无精确 span 的整句证据也有左侧 O 锚点。
- 初讲/复讲使用第二组 tabs，分别读取自己的 Attempt 快照并显示 A1/A2 句号。两组 tabs 都支持 ArrowLeft、ArrowRight、Home、End 与 roving tabindex。
- 历史账本只有页面内容区一个纵向滚动上下文；1440×960 和 1024×960 都保持两栏，不生成全局横向 overflow 或第二个证据滚动区。
- 历史回放关闭 final/证据“到达”动画；reduced-motion 用户不会丢失切换、定位或内容。

## 数据和纠正边界

本轮不需要数据库迁移或新增 IPC。既有 `AttemptSnapshot` 已持久化：

- `finalSegments`
- `annotations`
- `hints`
- final-only `metrics`
- `transcriptVersion` / `focusVersion`
- initial/retry Attempt identity

读取口径固定如下：

```text
诊断结果
  = 当前 correction-aware transcript
  + 当前有效证据
  + 冻结 Rubric / report / focus

实时证据
  = 指定 AttemptSnapshot 的原始 final
  + 当时的 O 证据与 lifecycle
  + 后续纠正造成的中性历史投影
```

用户纠正不会覆写冻结原句。受纠正影响的 O 记录在实时证据中继续保留位置与编号，但显示为中性历史；诊断结果则使用纠正后的文本重新判断。initial/retry 通过 expected Attempt ID 精确选取快照，不再按 artifact 列表顺序猜测。

partial 仍是 Fast Lane 可替换的临时显示，从未进入 `AttemptSnapshot`，也不生成正式证据。历史页明确说明这一边界，不伪造 partial；用户说过且被 ASR 落定的内容由 final 完整保留。

## 组件边界

```text
PracticeRecordDetailPage
├── DiagnosisResultCard
│   └── correction-aware report / evidence
└── RecordEvidenceView
    ├── initial/retry snapshot selector
    └── FrozenEvidenceLedger
        └── LedgerSurface ← 与 S04 EvidenceLedger 共用
```

`LedgerSurface` 只负责句级共享行、精确 span、O 锚点、右栏记录和双向定位。实时包装器注入 `LiveAttemptState` 与 partial；历史包装器只注入冻结 final 和 lifecycle，因此历史页不会伪造麦克风、ASR 或实时状态。

## 自动化与真实 Electron 验证

执行命令：

```bash
pnpm typecheck
pnpm test
pnpm verify
pnpm verify:electron-visual
pnpm verify:electron-product-tour
```

结果：

- TypeScript：通过。
- 单元/集成/E2E：57 个测试文件通过、1 个跳过；586 项通过、1 项跳过。
- `pnpm verify`：Electron 系统网络、安装期 power blocker、macOS arm64 package、18 个签名目标、40 方法 packaged bridge 与 Sherpa `1.13.4` smoke 全通过。
- Electron visual：85/85，9 张截图。
- Electron product tour：118/118，33 张截图；生产包 console 0 error / 0 warning，外部 HTTP(S) 请求 0。开发 QA 轨只有 Electron 自身的开发期 CSP 提示。
- 记录详情在 1440×960、1024×960 的 100% 与 1024×960 的 125% 均验证两栏、一个滚动区、横向 overflow 0；共享行 top/bottom 差值均不超过 2px，本次测量实际均为 0px。
- 重载后可重新进入同一完成记录，初讲默认选中，冻结 transcript 与 O 证据仍存在；切换复讲后使用 A2，而不是误标成 A1。

关键截图：

- `output/playwright/electron-product-tour/qa-12-s13-diagnosis-result-1440x960.png`
- `output/playwright/electron-product-tour/qa-13-s13-frozen-evidence-1440x960.png`
- `output/playwright/electron-product-tour/qa-14-s13-frozen-evidence-1024x960.png`
- `output/playwright/electron-product-tour/qa-14b-s13-frozen-evidence-1024x960-text125.png`

## 诚实边界

自动化使用隔离 `userData`、真实 Electron/IPC/SQLite 和受控音频/ASR 事件，证明了冻结数据、纠正投影、双视图、重载和布局边界。它不替代真实麦克风、生产 Sherpa 准确率、真实 OpenAI 调用或目标设备性能验收。

旧记录只有在当时已形成合法 `AttemptSnapshot` 时才能回放正式 final/O 证据；系统不会凭空补造未曾持久化的数据。partial 按产品冻结边界不留存，因此“实时证据”准确表示已落定、可审计的实时工作区结果，而不是逐毫秒的临时 ASR 草稿录像。
