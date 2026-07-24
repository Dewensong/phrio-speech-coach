# Phrio 对抗性加固与回归验收

日期：2026-07-18
范围：Production Closure 基线之上的伪造输入、身份混淆、生命周期回滚、删除/撤回竞态、异步迟到和重载恢复
结论：代码与受控 Electron 验收通过；保持 `0.1.0-alpha.0` / Internal Alpha，不替代真实设备、真实模型、真实服务和目标机性能验收。

## 权威输入

- 产品源：`8d37b1345c83f0435318337b75746cbb6ef02177`
- Prototype Studio V4：`c0b22b6da5ec447b856bbe5ddbf1f79a41eebdee`
- Gate C 最终归档：`b17852903c4c1f3c6f54993162bdd24e46209b9b`
- Approved Pencil SHA-256：`22b48697dff698edd0eba257a2793787945e74abbeb0dd4cf84a5f4d0e6ceb0f`
- 冲突顺序：产品源 > approved Pencil / Gate C > thin Clickable / 工具行为参考。

本轮没有修改控制仓用户改动、Prototype Studio、approved Pencil 或 `_tools/expression-trainer`。

## 最终架构与关键数据流

```text
Renderer Page/Component
  -> Hook/Service：operation identity、输入 revision、可编辑 payload 预览
  -> preload：31 个按用例命名、双向 schema 校验的窄 IPC
  -> Controller：HTTP/IPC 翻译，不信任 Renderer artifact 事实
  -> Service：Session/Attempt 引用图、同意、请求、删除与生命周期门
  -> Repository：练习 SQLite / 云审计 SQLite / 私有音频文件

Fast Lane
  Mic -> RMS/ASR partial -> final -> 本地九类标注与 final-only 指标
      -> 主进程 Attempt lease + ASR final ledger -> 可选 live hint
      -> tail reconcile -> persisted Attempt snapshot

Deep Lane
  persisted snapshot + tracked corrections -> authoritative analysis input
      -> 本地完整复盘 -> 一个焦点 -> Drill -> retry snapshot
      -> paired-1 同口径比较
      -> 可选 exact-payload Deep/comparison 云端补充
```

Fast 的迁移中 UI 状态不会成为 Deep 输入。Deep 只读取已持久化冻结快照及其可追踪纠正；本地完整报告、Drill 和 paired-1 不等待云端。

## Fast Lane / Deep Lane 接口边界

| 边界 | Fast Lane 写入 | Deep Lane 读取 | 拒绝条件 |
| --- | --- | --- | --- |
| Transcript | partial 仅临时；final 幂等追加 | 冻结 final + correction version | partial、旧 generation、跨 Attempt、重复/乱序降级为幂等忽略 |
| Evidence | final 后九类 annotation、稳定 O、生命周期 | 原始证据、撤回历史、纠正后版本 | 非 final、错误 span、跨 segment、撤回复活 |
| Snapshot | safe end + tail ready + 持久化成功 | snapshot identity + task/Rubric/metrics/hints | 空 final、ASR 未收束、任务上下文失败、身份冲突 |
| Deep report | 不写最终诊断 | 从权威 analysis input 异步生成 | 仍在迁移的 UI、伪造 snapshot projection |
| Focus/Drill | 短提示只作暂定历史 | 一个冻结 focus + 对应 Drill | live hint 自动改焦点、跨 version 定义 |
| Comparison | retry 使用同 Session/task/focus | initial/retry frozen snapshot + paired-1 basis | 不同口径、跨 Session、重复 analysis input |
| Live hint | 当前 Session/Attempt/final ledger + 配置同意 + 每轮 AI ON | 仅作暂定提示历史 | 无租约、AI OFF、旧窗口、伪造 final/task、stop 后迟到 |
| Cloud artifact | exact consent + request receipt | 仅作本地结果的可选补充 | 无权威图、无真实请求终态、结果 hash 不符、terminal 回滚 |

## 已关闭的攻击面

### 1. 云端产物伪造与身份劫持

- 主进程按当前冻结 Session/Attempt/Snapshot/纠正图重建允许的 Deep/Comparison payload 投影；前后端共用 `shared/cloud-ai-payload.ts`，避免 Renderer 与主进程规则漂移。
- artifact 必须使用 canonical ID，同一 Session/type/analysisInput 唯一；拒绝未来时间、重复身份和当前图之外的 segment、focus 或 transcript version。
- exact consent 同时绑定 purpose、provider、model、endpoint、prompt、policy 与 canonical payload hash；旧 prompt consent 保留历史可读，但不再 active。
- complete 产物必须匹配真实完成的 provider request 和 canonical result hash；结构合法但伪造的结果、假 hash 或其他请求结果不能落库。
- complete 不可回滚；已有 result 不可擦除或替换；superseded 必须由真实 correction/focus drift 支撑；Comparison 与 Deep 使用相同 terminal/chronology 约束。
- 执行云请求前再次验证已持久化 graph-approved queued/processing artifact，阻止绕过 artifact 门直接发送任意 payload。

### 2. 删除、撤回、重置与凭据竞态

- 按 Session 删除先建立 deletion gate，阻止该 Session 新请求，取消并等待其 live/deep/comparison，再删除云审计、练习产物、Session 与音频。
- 删除采用隐私优先顺序：云 exact payload / audit 删除失败时保留本地引用图供重试；云删除成功后即使本地音频清理失败，也不会让云端数据复活。
- 同意撤回按 purpose 取消在途请求；provider 返回后、结果持久化前再次核对同意和删除状态，迟到结果只能 discarded。
- 全量训练数据重置等待云端 in-flight drain；读取音频与清理互斥，避免删除后旧 read 重新暴露数据。恢复默认偏好前，queued / processing Deep/Comparison 会追加 `consent_reset` superseded 终态，重载后不再恢复已无同意的任务。
- API Key 写入/删除和非敏感设置重置串行执行；旧 Promise 不能覆盖更新后的 Key/设置状态。

### 3. Fast Lane 身份、尾句与 ASR 边界

- 每次重录生成新的 Attempt 与 snapshot artifact identity，旧 generation callback 和迟到 final 不会污染新 Attempt。
- ASR start 从持久化 Session 开主进程 lease；只有当前冻结任务、明确 AI ON 与本地 ASR 自身写入的 final-only ledger 能授权 `live_hint`。录音前 ON 只保存意图，运行中 ON/OFF 会同步主进程；stop、重录、删除、撤回与重置都会失效租约并丢弃迟到结果。
- live hint 文本窗口严格等于最新最多 360 字、24 个真实贡献 final segment；本地 payload、hash 与 `segmentIds` 使用同一 canonical 窗口完成授权。配置同意和 provider body 只包含冻结任务内容与累计 final 文本；Session、Attempt、segment、顺序、revision 与 policy hash 等本地权威元数据全部剥离，Attempt ID 也不编码 Session。
- 非空且属于当前 Attempt 的 ASR segment 是强语音证据；安静语音即使未越过 RMS 门，也不会被误判为“无语音”。
- ASR 句段使用单调时钟和真实句首边界；多句连续时间码与长停顿规则不会互相覆盖。
- 已有 final 后发生 feed 故障会明确降级并要求重录，不再从样本 0 全量重放造成 UI / ledger 双账本；尚无 final 时仍保留一次受控 PCM recovery。
- 尾句冻结任务上下文在调用前、每个 await 后及 complete 前检查 mounted + Attempt identity；页面卸载或重录后不再 setState、emit 或冻结旧快照。

### 4. Deep 纠正、证据和比较语义

- 逐字稿纠正生成可追踪版本；本地报告与 comparison 从服务端权威版本重算，不读取旧页面衍生值。
- 精确证据 phrase 必须在获批源句中真实存在且位置合法；过短、伪造或跨源引用被拒绝。
- 快照按 Attempt identity 选择，不使用可能排序漂移的“最新 UI 项”。
- paired-1 只比较冻结 focus 对应的相同 `comparisonDimension`；只选择一个 focus，Drill 和 retry 继续绑定同一版本。
- complete 本地报告同 ID 完全不可变；不同 transcript version / criterion / Drill 使用完整 SHA-256 稳定身份。改选焦点保留旧报告历史，详情按当前 Session focus 与纠正版本取权威报告；当前报告未成功持久化时不会进入 Drill，并提供原位重试。

### 5. Renderer 异步交互竞态

- Comparison prepare/approve/retry 使用输入 revision + operation token；双击幂等，旧输入返回的结果只能历史化为 superseded。
- 清除训练数据后，清除前发出的 history 请求即使迟到也不会复活记录。
- 音频保留偏好使用模块级串行队列和持久化结果广播；旧页面保存完成后，新挂载页面同步权威值，失败回滚到最后一次已确认值。
- 页面导航、确认 Dialog、保存和重试保持明确 busy/失败/恢复状态；产品旅程中的主路径按钮均通过真实 Electron 交互断言，而非只检查元素存在。

## 状态机与降级分支

主路径保持：待授权/待录音 → 录音中 → 检测到语音 → partial → final → 本地标注 → AI processing → 短提示 → 尾句收束 → safe end → 快照冻结 → Deep report → focus → Drill → retry → comparison。

- 权限/录音：拒绝、设备断开、快速停止、无语音、短录音、上限均有文字状态和恢复动作。
- ASR：缺模型、启动/feed/tail 超时、中断、一次 PCM 重放恢复、无有效 final 均明确降级。
- AI/网络：关闭、离线/恢复、撤回、超时、provider/Schema/语义失败、迟到与 prompt 迁移均不阻塞本地轨。
- 持久化：snapshot、correction、artifact、设置和删除失败均保留可重试边界，不用乐观 UI 冒充成功。
- 报告：本地报告异步且不阻塞 Fast；云端 queued/processing/complete/failed/superseded 是可选平行轨。

## 动效与 reduced-motion

本轮没有改变已批准的视觉方向。partial 临时态、final 落定、精确划线、右栏记录、尾句和降级提示继续使用低振幅短动效；系统 `prefers-reduced-motion` 与应用设置会关闭 smooth scroll 并把非必要动画压至近零。所有状态仍有文字或图标，不依赖颜色或动画单独表达。

## 自动化结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS：38 个文件 / 320 项 |
| `pnpm verify` | PASS：typecheck、320 tests、macOS arm64 package、31 方法 packaged bridge smoke、Sherpa 1.13.4 dependency smoke |
| `pnpm verify:electron-visual` | PASS：85/85、8 场景、9 图 |
| `pnpm verify:electron-product-tour` | PASS：82/82、21 图、10 个产品步骤、完整受控 QA 闭环 |

视觉报告确认：1440×960 / 1024×960、100% / 125%、标准 / 全屏的横向 overflow 为 0；证据区只有一个 scroller；共享行 top/bottom 差不超过 2px（本轮实测 0px）；全屏进出保持同一 segment；Esc 恢复触发按钮焦点；reduced-motion 可完整操作。生产包 Renderer console 为 0 error / 0 warning，产品巡检外部 HTTP(S) 请求为 0。

开发 QA fixture 会出现 Electron 对开发模式 CSP/`unsafe-eval` 的标准安全警告；打包生产协议与产品轨没有该警告。

## 关键截图与机器报告

- `output/playwright/electron-product-tour/product-05-appearance-light-fog-blue-1440x960.png`
- `output/playwright/electron-product-tour/product-06-appearance-dark-1440x960.png`
- `output/playwright/electron-product-tour/qa-01-s04-standard-1440x960.png`
- `output/playwright/electron-product-tour/qa-02-s04-fullscreen-1440x960.png`
- `output/playwright/electron-product-tour/qa-06-s06-deep-lane-1440x960.png`
- `output/playwright/electron-product-tour/qa-09-s09-paired-comparison-1440x960.png`
- `output/playwright/electron-visual/electron-dev-fixture-1024x960-text125-fullscreen.png`
- `output/playwright/electron-visual/report.json`
- `output/playwright/electron-product-tour/report.json`

截图与报告位于本机 `output/`，被 `.gitignore` 排除，不进入提交。

## 修改范围

- Backend：IPC artifact/execute 门、Cloud AI 请求/同意/删除/重置协调、live Attempt lease/final ledger、Practice artifact 引用图、ASR 时间边界。
- Shared：云端 payload 投影、prompt/metadata schema、Deep/Comparison terminal 与证据语义。
- Frontend：live Attempt、comparison 操作 token、历史加载、逐字稿/Deep 页面、音频偏好跨挂载同步。
- Tests：云端伪造/终态、删除竞态、Fast/ASR、Deep identity/语义、前端重载/双击/卸载回归。
- Docs：README、决策、推进记录与本验收报告。

## 未解决问题与外部依赖

以下不是已知的代码门禁失败，但在真实外部环境验收前仍阻止把 Internal Alpha 描述成公开生产就绪：

1. macOS 真实麦克风首次允许/拒绝/系统设置恢复、设备拔出、睡眠唤醒和长录音。
2. 安装真实 Sherpa 模型后的普通话/夹英文/噪声/停顿/尾句质量，以及目标 Mac CPU、内存和实际延迟。
3. 用户自行配置测试 OpenAI Key 后的三用途同意、401/403/429/5xx、超时、撤回、离线恢复和真实响应语义。
4. 三种 Mode Pack 的题目、Rubric、焦点和 Drill 的表达训练专业评审。
5. 签名、notarization、升级迁移、隐私文本、品牌名称与发布支持流程。

没有产品源性能阈值，因此本报告不伪造“延迟达标”“准确率达标”或训练效果数字；真实测量应原样记录后再由产品批准门槛。
