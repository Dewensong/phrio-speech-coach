# 2026-07-18 Production Closure 验收

## 结论

Phrio 的 Fast Lane + Deep Lane 本地生产闭环、可选三用途 AI、完整语义主题、关键交互恢复和 Electron 安全边界已经接通，当前判定为 **Production Closure candidate / macOS Apple Silicon Internal Alpha**。

这不是公网上线或外部环境验收声明。仓库版本仍为 `0.1.0-alpha.0`；真实麦克风/设备中断、真实 Sherpa 模型质量、用户自备 OpenAI Key 调用、目标 Mac 性能与生产内容专业评审仍需手工完成。没有产品源阈值或本次实测数据的延迟、准确率、CPU、内存和训练效果均不作达标声明。

2026-07-17 [产品就绪度审计](2026-07-17-product-readiness-audit.md) 是当时的准确历史快照；其中 AI 未接线、Deep 使用 draft、16 方法 bridge、缺 ASR 恢复、自定义协议和真实 Electron 125% 等结论已由本报告取代。

## 权威来源与冲突处理

- 产品源：`8d37b1345c83f0435318337b75746cbb6ef02177`
- Prototype Studio V4：`c0b22b6da5ec447b856bbe5ddbf1f79a41eebdee`
- Gate C 最终归档：`b17852903c4c1f3c6f54993162bdd24e46209b9b`
- Approved Pencil SHA-256：`22b48697dff698edd0eba257a2793787945e74abbeb0dd4cf84a5f4d0e6ceb0f`
- 后续用户批准：全局侧栏按练习对象导航、最近练习直达详情、模式只属于单次练习条件、自由练习、设置入口分离、完整语义主题和低饱和浅色

产品源优先于视觉与交互基线；approved Pencil / Gate C 优先于 thin Clickable。生产代码没有整体复制 Prototype Studio 或工具项目。

## 最终架构与关键数据流

```text
Renderer
  Page → Component → Hook / Service
  getUserMedia + MediaRecorder + AudioContext(16 kHz PCM)
              │
              ▼
30-method preload bridge (typed, schema validated)
              │
              ▼
Main process
  IPC Controller → Service → Repository
       │              │            ├─ phrio.sqlite3 / audio files
       │              │            ├─ cloud-ai.sqlite3
       │              │            └─ safeStorage encrypted API Key
       │              ├─ LocalAsrService → Sherpa-ONNX
       │              └─ CloudAiService → fixed OpenAI Responses
       ▼
shared versioned schemas / state machines / task packs
```

Fast Lane 数据流：

```text
permission → recording → RMS voice detection → partial/final ASR
→ final-only local rules/metrics → shared-row evidence ledger
→ cumulative-final live_hint (optional)
→ stop + start/feed/tail drain → safe_end
→ frozen AttemptSnapshot → durable artifact
```

Deep Lane 数据流：

```text
Session taskSnapshot + frozen Attempt + corrections
→ final transcript + traceable evidence + current Rubric
→ local report + exactly one focus → inline Drill
→ retry Attempt → paired-1 comparison
              ↘ optional exact-payload deep_diagnosis/comparison
```

## Fast Lane / Deep Lane 实际接口边界

| 边界 | Fast Lane 写入 | Deep Lane 读取 | 不允许跨越 |
| --- | --- | --- | --- |
| Session | 冻结 mode/task/version/context/Rubric/Drill | 持久化 `taskSnapshot` | 当前内容包或 React draft 替代冻结任务 |
| Transcript | partial 临时替换；final 幂等追加 | snapshot final + 追加纠正 | partial、迟到 ASR 或直接覆写原句 |
| Evidence | final-only annotation、精确 span、O id、lifecycle | 当前证据 + withdrawn 历史 | 整句染色、撤回后删除锚点 |
| Metrics | final-only、版本化本地规则 | 相同 algorithm version 比较 | 不同版本强行判输赢 |
| Hint | provisional / superseded / withdrawn / stale / failed | 仅作为历史上下文展示 | 冒充最终诊断或自动选择焦点 |
| Snapshot | safe_end 后冻结并先持久化 | 只读 snapshot identity/version | 内存候选绕过持久化失败 |
| Focus/Drill | retry snapshot 冻结 focus version | 单一焦点及同一映射 Drill | 云端结果未经用户采用改换焦点 |
| Comparison | initial + retry frozen snapshots | paired-1 本地结果与可选云端补充 | 总分、雷达图或不同口径比较 |

## 功能验收矩阵

### Fast Lane

| 能力 | 结论 | 生产实现证据 |
| --- | --- | --- |
| 麦克风授权与录音 | PASS | 主动请求、拒绝/设备断开/录音器失败、回放/重录、5 分钟上限 |
| VAD/语音检测 | PASS（RMS 产品实现） | voice detected、8 秒 no-speech、20 秒短录音确认；真实噪声环境需实机复核 |
| partial/final ASR | PASS（适配器） | 16 kHz PCM → 主进程 Sherpa；partial replace、final append、重复/乱序/迟到门 |
| ASR 恢复与尾句 | PASS（代码/自动化） | 8 秒启动缓冲、feed queue、operation timeout、一次捕获 PCM 重放、严格 tail drain |
| 九类本地标注 | PASS | 只在 final 后进入 confirmed 正式证据；structure/task_gap 使用冻结任务上下文在尾句幂等协调；精确 span + O id + lifecycle/迁移历史；上下文失败阻止快照并可重试 |
| final-only 统计 | PASS | 指标只从 final 与未撤回 annotation 重算 |
| 实时短 AI 提示 | PASS（生产 transport；未做真实付费调用） | final-only payload、配置同意 + Attempt ON、防抖/冷却/去重/超时/取消/迟到丢弃 |
| 反馈关闭 | PASS | 隐藏证据/提示但保留 transcript、录音/ASR/停止/快照轨 |
| 快照冻结 | PASS | safe_end + ASR ready + audio watermark；持久化成功门与同候选重试；下游普通产物必须通过同 Session 完整引用图校验 |
| 降级 | PASS | 权限、无语音、录音、ASR、网络、AI、快照失败均有文字状态与恢复动作 |

### S04 证据工作区

| 能力 | 结论 |
| --- | --- |
| final 句级左右共享行、共同增长 | PASS |
| 一个纵向滚动上下文 | PASS |
| 精确短语标记，不整句染色 | PASS |
| 语义色 + 线型 + O 编号 | PASS |
| 左右双向定位、同句对齐 | PASS |
| 撤回/纠正保留中性历史 | PASS |
| partial 不生成稳定证据 | PASS |
| 标准/紧凑进入证据全屏 | PASS |
| 共享状态、停止逻辑、scroll container | PASS |
| 语义滚动锚点、Esc 退出回焦 | PASS |
| 1440/1024 无横向溢出、无第二 scroller | PASS |

### Deep Lane

| 能力 | 结论 | 生产实现证据 |
| --- | --- | --- |
| 最终逐字稿与原句证据 | PASS | snapshot final、时间码、版本、原句/纠正并存 |
| 冻结任务 Rubric | PASS | 每 Session 自包含 Rubric/Drill/mapping，身份校验 |
| 本地完整复盘 | PASS | 确定性复盘异步保存，本地轨不等待云端 |
| 可选完整 AI 复盘 | PASS（未做真实付费调用） | exact JSON、逐 payload hash、严格结构/语义校验、持久化 lifecycle；重启后可继续 queued/processing 的同一获批 payload |
| 唯一训练焦点 | PASS | local_metric / self_directed / 明确采用 ai_evidence；只保留一个 |
| 内联短 Drill | PASS | Drill 绑定冻结 criterion、focus version 与完成自检 |
| 同题复讲 | PASS | 同 Session/task/focus 的 retry Attempt |
| 同口径前后比较 | PASS | paired-1 只使用冻结焦点对应 comparisonDimension；artifact 保存可审计 basis，其他指标不参与，证据不足不下结论 |
| 可选语义比较 | PASS（未做真实付费调用） | exact payload、逐次批准、可恢复 lifecycle，不覆盖本地结果 |
| 重载后留存/历史详情 | PASS | Session、两遍 snapshot、纠正、报告、比较、提示 lifecycle 与可选保留音频 |

## 云端 AI、同意与数据治理

- Provider：OpenAI
- Model：`gpt-5.6-terra`
- Endpoint：`https://api.openai.com/v1/responses`
- Request：`store: false`、strict JSON Schema、redirect rejected、用途级超时与最大 body
- Key：Electron `safeStorage`；Renderer 不读明文
- `live_hint`：配置级同意 + 每个 Attempt 显式 ON；只含任务/Rubric/累计 final 窗口
- `deep_diagnosis` / `comparison`：展示并允许删减 exact JSON，按 payload hash 一次批准
- 禁止字段：audio/raw audio/audio bytes、partial/partial transcript
- 持久化：同意、获批 payload、queued/processing/completed/failed/discarded 请求审计；云端产物另存练习 artifact lifecycle；Deep 重启恢复复用原 consent/payload，同进程重复请求合并
- 训练数据清除：reset gate 先停止新请求、取消并等待在途请求，再清 Session、音频与 payload 级审计
- 保留说明：应用显示 `store=false` 边界，也明确告知默认滥用监控日志和组织数据控制可能影响服务侧保留；不承诺本地代码无法控制的服务端零保留

## 状态机与降级分支

主路径：待授权/待录音 → 录音中 → 检测到语音 → partial → final → 本地标注 → AI pending → 短提示 → 尾句收束 → safe end → 快照持久化 → Deep。

Capture、ASR、Analysis、Network、Deep report 独立并行显示。权限拒绝、8 秒无语音、短录音、设备中断、ASR 启动/feed/tail/恢复失败、离线/恢复、AI 关闭/撤回/超时/失败/迟到、快照/本地报告/云端 artifact 保存失败均有文字/图标和重试或边界说明；任何 AI/网络失败不停止本地轨。

## 主题、动效与无障碍

- 完整语义主题：system/light/dark 同时切换 shell/sidebar/workspace/canvas/surface/field/text/border/status。
- 浅色、深色分别保存 8 组 palette；浅色为低饱和浅底。
- 整体字号：90%、100%、112.5%、125%；SQLite 权威、localStorage 仅首帧缓存，保存失败回滚。
- 动效：partial 临时态、final 落定、精确划线、右栏记录、尾句与降级提示均为低振幅短动效。
- reduced motion：系统约 `0.001ms`、应用设置约 `0.01ms`，关闭 smooth scroll，不删功能。
- 键盘：全屏 Esc 回焦、确认 Dialog 聚焦/锁焦/恢复、纠正编辑回焦；busy 状态锁定重复导航和提交。
- 对比度：主题 token 自动化覆盖全部浅/深 palette，辅助文字不只依赖颜色表达状态。

## 自动化与真实 Electron 结果

| 命令 | 结果 |
| --- | --- |
| `pnpm verify` | PASS：TypeScript、38 个测试文件 / 273 项、macOS arm64 package、30 方法 packaged bridge smoke、Sherpa dependency smoke |
| `pnpm verify:electron-visual` | PASS：85/85 断言、8 场景、9 图 |
| `pnpm verify:electron-product-tour` | PASS：82/82 断言、21 图 |

视觉轨覆盖 1440×960 / 1024×960、100% / 125%、标准 / 证据全屏。横向 overflow 为 0，只有一个证据 ledger/scroller，共享行 top/bottom 差为 0px，全屏进出保持同一 segment，Esc 回焦，reduced-motion 可操作。生产包 console 为 0 error / 0 warning；产品巡检外部 HTTP(S) 请求为 0。

`?qa=1` 轨直接注入受控音频、partial/final、证据与尾句事件，但 Session、Attempt 音频、快照、Deep report、焦点、Drill、复讲、paired comparison、完成状态与历史详情都经过真实 Electron Chromium、preload/main、IPC 和 SQLite。它证明跨页面持久化闭环，不证明生产 recorder、Sherpa、规则标注/尾句编排或云服务；这些边界分别由对应单元/集成测试与外部实机清单承担。生产产品轨使用隔离空白 userData 和真实 `phrio-app:` 包。

## 关键截图

截图在本机 `output/`，被 `.gitignore` 排除；机器可读报告保留绝对测量值。

- `output/playwright/electron-product-tour/product-02-home-free-practice-1440x960.png`
- `output/playwright/electron-product-tour/product-05-appearance-light-fog-blue-1440x960.png`
- `output/playwright/electron-product-tour/product-06-appearance-dark-1440x960.png`
- `output/playwright/electron-product-tour/product-09-recent-record-detail-1440x960.png`
- `output/playwright/electron-product-tour/product-10-history-all-1440x960.png`
- `output/playwright/electron-product-tour/qa-01-s04-standard-1440x960.png`
- `output/playwright/electron-product-tour/qa-02-s04-fullscreen-1440x960.png`
- `output/playwright/electron-product-tour/qa-06-s06-deep-lane-1440x960.png`
- `output/playwright/electron-product-tour/qa-07-s07-drill-1440x960.png`
- `output/playwright/electron-product-tour/qa-09-s09-paired-comparison-1440x960.png`
- `output/playwright/electron-product-tour/qa-11-s13-completed-detail-1440x960.png`
- `output/playwright/electron-visual/electron-dev-fixture-1024x960-text125-fullscreen.png`

报告：

- `output/playwright/electron-visual/report.json`
- `output/playwright/electron-product-tour/report.json`

## 仍需外部手工验收

### 真实麦克风与系统

1. 从空 userData 首启，分别允许、拒绝，并从 macOS 系统设置恢复麦克风权限。
2. 内置麦克风、外接麦克风和切换默认输入设备；录音中拔出设备。
3. 睡眠/唤醒、窗口关闭/恢复、快速开始/停止、重录、5 分钟录音与两次 Attempt。
4. 默认完成后确认原始音频删除；选择“随记录保留”后确认历史可播放、删除记录后文件消失。

### 真实本地 ASR

1. 安装三份要求的 Sherpa 模型文件，核对环境页状态与包内依赖。
2. 普通话、夹英文、安静/噪声、停顿、尾句、8 秒无语音与不足 20 秒样本。
3. 模型缺失/损坏、启动超时、长录音、设备中断与恢复后的 partial/final/端点。
4. 在目标 Mac 记录 CPU、内存、模型加载、partial/final/尾句延迟和准确率；没有产品源阈值时只报告原始测量，不写“达标”。

### 真实 OpenAI 服务

1. 用户自行配置测试 Key；核对系统加密可用、明文不进入 Renderer/日志，删除 Key 后请求立即停止。
2. 分别验证 `live_hint` 配置同意 + Attempt ON、撤回、离线/恢复、12 秒超时、supersede 与迟到结果。
3. 对 `deep_diagnosis` / `comparison` 逐字段检查 exact JSON，再批准；验证纠正后旧结果 superseded 与重新批准。
4. 用受控账户验证 401/403、429、5xx、refusal、无效 JSON/语义引用、30 秒超时和应用重启后的历史/继续处理。
5. 记录实际调用延迟、token 与费用；未经授权不部署、不购买额度、不修改外部组织数据控制。

### 内容与发布

1. 三种 Mode Pack 的题目、Rubric、焦点和 Drill 由表达训练专业人员复核。
2. 完成 Phrio 品牌/名称可用性、签名/notarization、升级/迁移、崩溃恢复、隐私文本与发布支持流程。
3. 根据真实测量设定并批准性能/质量门槛后，才决定是否移除 `alpha` 和扩大分发。

## 已知边界

- Sherpa 模型权重不进入 Git；无模型时不能完成有效 final 快照，但录音与明确降级仍可用。
- 自动化没有写入真实 OpenAI Key，也没有发起外部请求；生产 transport 的安全、Schema、状态和 UI 已验证，服务端结果仍需上述手工验收。
- 云端分析不是后台守护进程；应用退出时持久化的 queued/processing Deep diagnosis 与 comparison 可由 UI 继续同一获批 payload。若进程在 provider 已收到请求但回写终态前退出，用户明确继续可能再次发送；`store:false` 下应用无法找回未落地的 provider 响应。它不影响本地报告、Drill 或 paired-1。
- 真实训练效果、ASR 质量和性能没有在本轮自动化中推断。
