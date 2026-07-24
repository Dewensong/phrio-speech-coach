# 2026-07-24 编辑校样式训练闭环验收

## 结论

Phrio 全产品体验改造的第三阶段已完成：

- S05 逐字稿改为可逐句校对的编辑稿纸，冻结原句、时间码、音频、逐句纠正和
  append-only 版本语义保持不变；
- S06 / S13 诊断结果改为“结论 → 原句证据 → 唯一焦点 → 下一步”的印刷阅读
  层级，本地确定性复盘和完整 AI 复盘仍是独立能力；
- S07 Drill 改为只突出一个动作的排练工单，原开始、计时、模板口述、自检和
  保存动作保持不变；
- S09 复讲完成改为冻结票据，明确“保存结束”和“查看同口径对比”都是用户选择；
- paired-1 比较改为左右双页校样，只比较冻结 criterion，缺证据时仍返回
  “证据不足”，不生成总分、不伪造改善。

这一阶段没有改变 correction、report、focus、Drill、comparison、AI payload、
Session、IPC 或 Repository 协议。Goal 继续 active；下一阶段进入记录、设置、
受控 Demo、分享与开源传播面的统一。

## 当前真源

```text
worktree: current product worktree
branch: codex/record-result-evidence-views
starting tip: ed3def8
implementation commit: 8523935a79ca782999aa696e5aebe5614445d32b
remote: none
```

未修改旧根目录实现、控制仓或 Prototype Studio；未配置 remote、未合并、未发布。

## 功能保全

### 逐字稿校对

- 四个 frozen final 继续按 sequence 和时间码显示；每句保留独立纠正入口。
- 纠正只追加新版本，不覆盖原始 final；并发保存、失败重试和原音频回放继续走
  原服务与 Repository。
- “本地真实录音”“网络发送：无”和纠正版本数仍在同页可见，不用视觉升级
  冒充云端或真实设备证据。

### 诊断与三条诚实路径

- `DiagnosisResultCard` 继续读取同一个 `DeepReport`、冻结 `AttemptSnapshot` 和
  lifecycle evidence，没有新建第二套诊断数据。
- 本地确定性复盘明确可见；“保存诊断，结束本轮”“不选焦点，直接复讲”
  “选择这个焦点，开始 Drill”三条路径都保留。
- 焦点仍由用户明确选择；完整 AI 复盘只在独立设置、同意和采用动作后影响焦点，
  实时短提示不会自动决定训练路径。

### Drill、复讲与比较

- Drill 的三步只是一个状态机的三个展示阶段；只有一个当前动作，完成仍需原
  自检和持久化成功。
- 自由复讲不伪造焦点；焦点复讲继续冻结本轮 criterion、成功条件和任务。
- 复讲保存后默认不强迫比较。进入 paired-1 后，初讲与复讲完整 frozen final
  分列呈现，纠正和保存失败恢复仍保留。
- 本地比较不等待云端；云端语义比较仍要求用户审阅 exact JSON 并对本次 payload
  单独批准。

## 自动化证据

执行：

```bash
pnpm typecheck
pnpm exec vitest run \
  tests/e2e/transcript-review-concurrency.test.tsx \
  tests/e2e/deep-mode-ui.test.tsx \
  tests/e2e/deep-cloud-diagnosis.test.tsx
pnpm verify
```

结果：

- 定向训练闭环：3 个文件 / 30 项通过。
- 完整测试：59 个测试文件通过、1 个跳过；596 项通过、1 项跳过。
- Electron 系统网络探针通过。
- 安装期 `prevent-app-suspension` 获取、释放且无泄漏。
- macOS arm64 package gate 通过，18 个签名目标有效。
- packaged bridge 仍为 40 个窄方法，Renderer 无 Node，协议仍为 `phrio-app:`。
- Sherpa `1.13.4` 原生依赖 smoke 通过。

自动化继续证明并发纠正、报告先保存后导航、三条结果路径、焦点显式采用、Drill
完成、自由复讲、paired-1 证据不足、比较纠正与云端单次同意等原契约。它不证明
真实麦克风、真实模型表达质量或真实 OpenAI 返回质量。

## 受控 Fixture 与真实 Electron 证据

执行：

```bash
pnpm verify:electron-visual
node scripts/verify-electron-product-tour.mjs --skip-package
```

结果：

- Electron visual：85/85，9 张图。
- Electron product tour：137/137，46 张图。
- S05 断言 4 个 frozen final、4 个纠正入口、`稿 01`、本地音频和 0 横向
  overflow。
- S06 断言四级诊断层级、三条真实路径、本地确定性复盘、唯一焦点，并覆盖
  1440×960 / 1024×960。
- S07 断言 `REHEARSAL · 01`、3 个步骤、恰好 1 个当前步骤、自检完成与 0
  横向 overflow。
- S09 断言 `TAKE 02 · FROZEN`、保存结束 / 查看比较两种动作，并覆盖
  1440×960 / 1024×960。
- paired-1 断言左右 2 个校样页、共 8 行 frozen final、无总分和
  “证据不足，不换算趋势”。
- 人工复核上述 7 张代表图，未发现遮挡、横向溢出或主操作丢失。
- production console 0 error / 0 warning；产品轨与 QA 轨外部 HTTP(S) 请求 0。

受控 QA 使用真实 Electron、preload、IPC、SQLite、Session、纠正、报告、Drill
和 comparison 持久化图；音频、partial/final、证据和尾句事件仍是明确 Fixture，
不能作为真实设备证据。

## 真实设备证据

本阶段没有发起新的真实设备验收：

- 没有请求麦克风权限；
- 没有安装或评价真实本地模型；
- 没有拔出设备、休眠唤醒或做长录音；
- 没有提供 OpenAI Key，没有发送任何转录文本；
- 没有做 Developer ID、公证、stapling 或目标 Mac Gatekeeper 正向路径。

2026-07-23 的真实麦克风停止收束与同包重启权限证据仍是有效历史证据，但它发生
在本轮训练闭环展示改造前，不能替代最终端到端真实设备复验。

## 诚实边界与下一步

尚未关闭：

- 记录列表/详情、设置/诊断、受控 Demo、结果卡和纯净分享的最终视觉统一；
- 开源首页素材与产品内当前视觉的一致性；
- 全产品 90% / 112.5%、完整深浅主题代表页和键盘路径终验；
- 真实设备切换/中断/恢复、模型中文质量、目标 Mac 性能；
- 用户独立授权后的三种真实 OpenAI 用途；
- Developer ID、公证、Gatekeeper 与升级 TCC 连续性。

当前建议仍是 **继续 Internal Alpha**，不建立可分享公共包。
