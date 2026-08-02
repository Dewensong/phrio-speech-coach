# 关键决策

## 2026-08-02：公开宣传片完成后，公共二进制继续保持独立授权门

- 远程真值：G4 宣传片已经通过 PR #10 和必需 CI 进入受保护公共 `main`。中英
  README 使用同一静音预览和 1080p 有声版；公开音轨只含程序合成素材，不使用
  内部参考混音。该结果关闭 GitHub 传播面，不改变产品发布级别。
- 候选边界：`macos-release-candidate` Environment、只读 workflow、Developer ID
  签名、hardened runtime、公证、stapling 和候选校验代码都已存在；环境中没有
  Apple 发布 Secrets，本机也没有 Developer ID Application 身份，因此不能把
  基础设施就绪描述成已拥有可分享包。
- 授权顺序：取得和配置 Apple 凭据只授权生成短期候选，不授权 tag、GitHub
  Release 或公开下载。候选生成后仍须在非构建目标 Mac 完成 Gatekeeper、首次
  麦克风授权后重启连续性、真实模型质量、设备中断与性能验收；公开发布需要再次
  明确批准。
- 维护边界：常规 Dependabot PR 不因机器人创建或旧 CI 变绿自动合并。必须先
  更新到当前 `main`、审查变化、运行对应门禁，并继续检查 squash 后的 noreply
  身份；失败的 React/Vite/测试工具更新不得与签名收口混在一起。

## 2026-07-24：GitHub 默认中文，英文作为完整并列版本

- 决策：公开仓的 `README.md` 默认使用中文，以匹配产品主要使用语言和第一批传播
  受众；完整英文版本固定为 `README.en.md`，两者在首屏直接互链。
- 信息架构：默认中文首页沿用已通过传播验收的真实 social preview、真实打包
  Fixture 截图和“练句子，不练总分”主张，保持适合首次访问者的短叙事；原长篇
  中文实现、降级与验收说明移动到 `docs/internal-alpha.zh-CN.md`，不因首页精简
  丢失功能、隐私或证据边界。
- 治理：开源 readiness gate 同时检查中文默认首页、英文首页和中文技术说明。
  后续新增面向首页的能力或发布状态时，必须同步两种语言；只有内部技术细节可以
  留在中文技术说明和 `docs/`，不能让英文首页产生更强的可用性或发布承诺。

## 2026-07-24：公共源码使用清洁历史，完整内部历史只作离线保留

- 授权：Dewens 明确要求执行历史隐私清理、创建 GitHub 仓并优化传播首页；这次
  授权覆盖源码公开，不覆盖 tag、Release、公共安装包、Developer ID / 公证或
  OpenAI 文本传输。
- 历史策略：不逐条重写旧提交，也不公开旧提交邮箱和工作站路径。先生成并验证
  `0600` 完整 bundle，再从最终已审源码 tree 建立无父公共根。内部最终 tip
  继续由 `codex/internal-pre-public-main` 和离线 bundle 双重保留；GitHub 只接收
  清洁公共 `main`。
- 远程真源：公开仓
  [`Dewensong/phrio-speech-coach`](https://github.com/Dewensong/phrio-speech-coach)
  的受保护 `main` 成为后续公开贡献真源。旧 Worktree、旧分支和离线 bundle
  不再是公开构建或发布输入，也不得使用 `--all` 推送。
- 晋级顺序：空白私有仓 → 只推公共 `main` → 真实 GitHub CI → clean clone →
  Public → 安全设置和分支保护。任何一步失败都不能提前公开；公共二进制仍走
  独立发布门。
- 保护策略：Actions 默认只读；`main` 要求 PR、分支最新、对话解决、精确
  `verify-macos-arm64`、线性历史，禁止 force-push / 删除；合并仅使用 squash。
  单维护者阶段不把“必须由另一个人批准源码 PR”伪装成已有治理能力，候选发布
  Environment 则保留独立维护者审核。
- Web 合并身份门：GitHub Web squash 曾真实使用账号资料联系邮箱，而非本地
  noreply。旧 staging 已私有归档，原 slug 以本地生成的 noreply 历史重建。
  维护者在账号 Emails 设置中开启邮箱隐私和“阻止暴露邮箱的命令行 push”之前，
  不合并任何 GitHub / Dependabot PR；提交身份检查是 CI 之外的人工治理门。
- 依赖安全：Dependabot 告警不因处于 devDependency 就 dismiss。上游 Forge
  仍通过 Rebuild 3.x 锁入有公告的 `tar 6.2.1` 时，使用仓库级最小 override
  统一提升到已修复版本，并要求官方全量 audit、完整 `pnpm verify` 和 macOS
  原生重建/打包共同通过；待上游解除旧依赖后再移除 override。
- 传播策略：首页前置真实受控 Demo 社交主视觉，以“练句子，而不是练总分”解释
  产品差异；任何截图都保留 Fixture 标签，不生成假 UI 冒充设备证据。
- 名称边界：公开检索发现另有瑞典室内设计应用使用 Phrio。仓库 slug 使用更明确
  的 `phrio-speech-coach`，Phrio 仍是工作名；正式分发前必须另做目标市场名称、
  商标、域名和应用商店清关。

## 2026-07-24：本地 `main` 成为产品主真源，远程与发布继续独立授权

- 决策：维护者在最终验收后单独批准以
  `cd4e33bf0939314fa85f46b500c48d1c705688ca` 为基点建立并切换本地 `main`。
  原 `codex/record-result-evidence-views` 保留为同点验收回退引用，没有把旧根
  分支合回，也没有产生合并提交。
- GitHub 边界：CI push 只跟踪 `main`；公共候选 workflow 拒绝非 `main` 来源，
  使用 `macos-release-candidate` Environment，checkout 不保留凭据，Apple
  证书与公证值只进入实际需要的步骤。依赖安装、测试和普通 CI 在任何证书 /
  `.p8` 落地前完成，也不读取这些值。
- 开源门：`pnpm verify` 新增当前树开源检查，拒绝跟踪 `.env`、证书、真实音频、
  SQLite、模型权重、安装制品、工作站绝对路径和高置信凭据文本；该门不声称已经
  清理 Git 历史。
- 安装环境：clean-clone 真实发现 DMG 原生依赖的 `node-gyp` 详细日志可能展开
  父环境。项目 `.npmrc` 固定 `loglevel=error`，开源门要求它不含 registry /
  mirror / auth 配置，同时保留既有 `node-linker=hoisted` 依赖布局；clean clone
  与 CI 显式使用官方 Electron Release，并只注入实际需要的最小环境。
- 隐私决策待定：完整历史仍可能暴露维护者提交邮箱与历史工作站路径。配置公开
  remote 前必须明确接受完整历史，或另行批准历史隐私清理；本轮不改写历史。
- 未授权动作：仍不配置 remote、不推送、不创建 tag / Release、不生成或发布
  公共安装包。建立 `main` 与源码开源准备不替代 Developer ID、公证和目标 Mac
  真实设备验收。

## 2026-07-24：产品视觉进入编辑校样式重构，业务与证据协议保持冻结

- 决策：依据 Dewens 对产品艺术感、传播性和完整改造的明确授权，产品级视觉
  真源在 Gate C A3 之上增加
  `docs/plans/2026-07-24-editorial-rehearsal-redesign.md`。统一母题为
  “编辑校样 × 表达排练 × 纸墨套印”，沿用 Phrio 标志中的深墨 `P`、海绿色
  复讲副线与单一朱红焦点；不使用 AI 玻璃、柔光、霓虹或装饰波形。
- 保留边界：本轮和后续视觉迁移不修改 Session / Attempt / Snapshot / correction /
  report / focus / Drill / comparison 身份，不改变 IPC、Repository、录音、ASR、
  OpenAI 同意、删除、日志和本地分享协议。低频信息可以下沉，但任何数据不完整、
  无法继续或需要用户决定的异常必须自动上浮并保留原恢复动作。
- 基线关系：approved Pencil 和 Gate C 继续约束对象 IA、1440/1024 重排、S04
  句级共享行、O 编号、证据全屏、可访问交互和语义状态；新的用户批准方向取代
  其通用卡片外观与全产品表层构图，不能以旧稿视觉一致性阻止新设计，也不能用
  新设计改写冻结证据语义。
- 实施方式：按“视觉基础 → 首次成功 → 实时工作区 → Deep 闭环 → 记录/设置/
  分享 → 完整验收”分阶段迁移。每阶段独立可回退，旧展示层只在功能映射、自动化、
  受控 Fixture 和适用的真实设备门通过后移除；不建立第二套业务逻辑。
- 实时工作区：默认使用只读 `LiveAttemptState` 的“专注”投影，让用户先完成
  表达；完整账本通过显式“证据”tab 继续使用同一 `EvidenceLedger`。专注和证据
  不是两套 recorder、ASR、annotation 或 snapshot 状态，切换不能复制或改写证据。
- 技术信息分层：正常态将 capture / ASR / analysis 压缩为一个事实健康摘要，
  完整状态进入原生“采集详情”；任何数据不完整、无法继续、需要重试或需要用户
  决定的状态仍自动进入 degradation / 主操作第一层。AI Key、用途、配置级同意和
  本次 ON 继续独立，不因视觉简化而合并授权。
- Deep 训练闭环：逐字稿使用“冻结校样稿”，诊断使用“结论版”，Drill 使用
  “单动作排练工单”，复讲完成使用“冻结票据”，paired-1 使用“左右双页校样”；
  这些都是现有 correction / report / focus / Drill / comparison 的只读或原位
  展示，不建立第二套对象。比较仍只判断冻结 criterion，证据不足不能被视觉上的
  左右变化暗示为改善，用户也不被强迫进入比较。
- 诚实能力标签：“本地确定性复盘”必须以可读文本保留，不能只换成装饰英文印章；
  可选完整 AI 复盘继续使用独立配置、payload 同意和显式采用。视觉精简不能移除
  数据来源、网络发送状态或本地/云端边界。
- 记录与设置：记录列表使用“本地档案索引”，单次记录使用“Session 卷宗”，设置
  使用“设备账册 / 排版台 / 排练规则”。页码和编号全部是展示投影，不能写回或
  替代 Session、pinnedAt、diagnostic status、settings revision 和 consent。
- 传播：受控 Demo 必须在每一阶段持续展示 Fixture 版次；导出结果卡使用
  `RESULT PROOF` 编辑海报，但传播美学不能扩大 schema。证据继续默认关闭，完整
  逐字稿永不进入卡片，分享必须由用户触发且只在本机生成。
- 最终发布判断：全产品表层、自动化和受控 Electron 已完成，不再以视觉或功能性
  P0/P1 阻断本机 Internal Alpha；但 ad-hoc、无 Team ID、无公证、无目标 Mac
  和无真实 OpenAI 证据继续阻断普通用户分享包。推荐“继续 Internal Alpha”。
- 主真源：当前最新 Worktree 直接成为未来 `main` 的指向对象；旧根目录只作为
  祖先历史，不做反向合并。创建 `main`、配置 remote 和推送必须由 Dewens 另行
  授权，本轮只记录方案。

## 2026-07-23：用户可见录音只在本地 PCM 通道准备完成后开始

- 决策：真实录音先获得 MediaStream 并完成 AudioWorklet 模块与节点准备，再
  启动 MediaRecorder、覆盖计时和用户可见“录音中”状态；不能让冷启动异步
  worklet 初始化落入用户已经可以开口的录音区间。兼容 ScriptProcessor 或无
  PCM 的明确降级路径仍在 recorder 启动后执行。
- 原因：真实打包版证明 AudioWorklet 模块冷启动可占约 667 ms。若先显示
  “录音中”，MediaRecorder 虽保存这段开头，本地 ASR 却没有相同 PCM，停止时
  会形成真实前缀缺失并被正确标为 `recording.pcm_capture_incomplete`；单纯
  放宽容差只会隐藏数据不一致。
- 验证：自动化加入 650 ms 异步初始化回归；修复后真实 take 为 17,521 ms、
  PCM 17,512 ms，0 丢帧、3 个 final、尾句 flush 和快照 / Deep CTA 均通过。
- TCC 边界：同一未变化的 ad-hoc 包在本机退出重启后复用一次授权；重打包会
  改变以 CDHash 为指定要求的身份并可能再次询问。跨版本稳定授权仍依赖固定
  bundle ID、Developer ID 签名、固定安装路径与目标 Mac 正向验收，不能通过
  修改应用内权限逻辑绕过 macOS。

## 2026-07-23：传播层保持受控演示、本地分享与真实证据分离

- 决策：首屏增加 30 秒受控 Demo，以固定文本展示“初讲证据 → 唯一焦点与
  Drill → 同口径前后比较”；不请求麦克风、不安装模型、不创建 Session、不
  调云端。完成记录可生成 16:10 / 1:1 / 9:16 的本地 PNG、SVG 或 Markdown
  结果卡，并进入纯净展示。
- 隐私：结果卡默认不含证据原句；用户主动开启后也只加入一条冻结证据，不含
  完整逐字稿。该功能不创建公共链接、不自动上传，真实 OpenAI 文本传输仍有
  独立同意门。
- 产品语义：传播层继续只突出一句结论、一个焦点、成功条件与同口径比较，
  不新增总分、人格判断、胜负红绿框或专业等级。受控 Demo 永久标识为 Fixture，
  不能冒充真实设备结果。
- 开源扩展：社区入口先限于 strict JSON 的 task-only Pack，只能复用现有
  Mode / Criterion / Drill，在构建期编译与校验，不加载远程代码。新 Session
  继续冻结完整任务图，后续 Pack 修改不能改写历史。
- 记录：完整架构决策见
  [ADR 0003](docs/adr/0003-open-source-propagation-and-release.md)。

## 2026-07-23：公共候选包与内部 CI 使用两条不可混淆的发布轨

- 决策：内部 CI 保持无 Secrets、ad-hoc 签名与 14 天证据制品；新增的公共
  macOS 候选工作流只能手动触发，缺 Apple 凭据立即失败，使用 Developer ID、
  hardened runtime、公证与 stapling，并验证 Gatekeeper、Team ID、最小权限、
  DMG/ZIP 与 SHA-256。
- 权限：候选工作流只有 `contents: read`，只能上传 14 天 workflow artifact，
  不能创建 tag、GitHub Release、commit、merge 或公开发布。本轮也不配置
  remote 或主分支。
- 许可证：Phrio 仓库源与自有资产使用 MIT；App 包内携带 Phrio、直接运行时
  依赖、Apache-2.0 与 Electron Chromium license inventory。模型权重不进仓、
  不进安装包，公共发布前仍须复查上游来源与许可证。
- TCC：Developer ID 可稳定 macOS 用于麦克风 TCC 的代码签名身份，从机制上
  消除 ad-hoc 重打包 cdhash 变化这一重复授权原因；是否在目标 Mac 安装后只
  授权一次，仍必须通过真实设备“允许 → 退出 → 重启”复验。

## 2026-07-23：最小 CI 先固定可追溯门禁，不把内部制品冒充正式发布

- 决策：以 GitHub Actions `macos-15` Apple Silicon runner 执行现有
  `pnpm verify`，固定 Node/pnpm 与 action commit；PR 只保留门禁日志，
  候选分支 push 或手动触发才保存 14 天 ad-hoc ZIP、SHA-256 与结构化证据。
- 证据：CI JSON 分开声明自动化、受控 Fixture 与真实设备状态。最小 CI 不运行
  visual/product-tour Fixture 轨，更不声明麦克风、模型质量、目标 Mac 性能或真实
  OpenAI 通过。
- 隐私：工作流不引用 Secrets，不提供 OpenAI Key，不读取本机用户数据，不发送
  转录文本。真实 OpenAI 调用继续要求 exact payload 的独立人工同意。
- 真源：当前实现候选是
  `expression-practice-coach-production-closure` Worktree 的
  `codex/record-result-evidence-views`。旧根目录提交是其祖先，不再承担构建入口。
  remote/main 尚不存在；只有在远程候选分支 CI 通过后，才由 Dewens 明确授权把
  `main` 建立在该候选提交并启用保护规则。
- 边界：CI artifact 仍是 ad-hoc 签名，不解决跨重打包麦克风 TCC、Developer ID、
  hardened runtime、notarization、更新或回滚。正式分享链必须另行关闭这些门。

## 2026-07-16：正式产品使用独立代码仓

- 决策：稳定 slug 与本地仓名使用 `expression-practice-coach`，品牌工作名继续使用 Phrio。
- 原因：保留控制仓已有未提交产品材料，避免污染 Prototype Studio 和旧上游贡献 Worktree；Phrio 名称尚未完成可用性核验。

## 2026-07-16：P1 采用 Production Walking Skeleton

- 决策：P1 实现真实桌面壳、录音、Session、SQLite、历史和删除；转写、诊断、Drill、对比暂用明确标注的开发 Fixture。
- 原因：先同时验证视觉、状态机、隐私边界和两遍训练流程；把 ASR 模型分发与 AI 安全边界拆成独立风险阶段。
- 退出信号：应用可启动、可打包、可完成一条 Fixture 闭环，真实音频生命周期和两个 Attempt 约束通过自动化验证。

## 2026-07-16：桌面基础采用 Electron 43

- 决策：Electron 43 + React + TypeScript；主进程使用内置 `node:sqlite`，Renderer 保持 sandbox/context isolation。
- 原因：本机已有 Node 24 工具链，Electron 43 内置相同 Node 主版本；可用 Web 音频能力保持 A3 UI 还原效率，同时无需先引入 Rust 工具链。
- 重新评估：包体/内存、macOS 原生能力或 ASR 集成证明 Electron 无法满足发布预算时，再评估 Tauri/SwiftUI。

## 2026-07-16：P1 保留 file renderer，发布前迁移自定义协议

- 决策：P1 继续使用 Forge Vite 的 `file://` renderer，并显式保留 `GrantFileProtocolExtraPrivileges`；其余关键 Electron fuses 全部显式声明并收紧。
- 原因：先冻结 Gate C 与真实本地数据链路，避免在 Walking Skeleton 中同时更换资源加载协议。
- 退出条件：P2 安全硬化时迁移自定义受限协议、关闭该 fuse，并清理 Electron 模板继承的未使用 macOS 权限描述；正式分发前必须完成。

## 2026-07-17：[已取代] Fast 与 Deep 以冻结 Attempt 为硬边界

- 目标决策：Fast Lane 使用实时事件状态；Deep Lane 只读取冻结 final、证据、指标、提示、音频 watermark 与持久化 Session `taskSnapshot`，并叠加可追踪纠正。
- 原因：避免迟到 ASR/AI 或临时 UI 状态改写最终诊断和前后比较；支持重启恢复和证据审计。
- 当时采用状态：部分完成。该状态已由 2026-07-18“Fast/Deep 冻结边界从部分采用升级为已采用”取代，仅保留为阶段审计。

## 2026-07-17：[已取代] 本地 ASR 采用可降级 Sherpa 主进程适配器

- 决策：Renderer 只采集 16 kHz PCM，Sherpa-ONNX 在主进程运行，模型从 userData 外置加载且不进入 Git。
- 当时原因：保持 Renderer sandbox 和本地优先；当时允许模型缺失后再降级。该录音前置选择已由 2026-07-20 决策取代：模型未就绪时必须先安装，不能请求麦克风并产生必然无转写的 Attempt。

## 2026-07-17：[已取代] 云端 AI 保持 provider 可注入且按用途同意

- 当时决策：冻结 provider 前不硬编码外部端点。该 provider 临时状态已由 2026-07-18 固定 OpenAI Responses / `gpt-5.6-terra` / 固定 endpoint 的决策取代；用途同意与音频禁出站边界继续有效。
- 原因：产品源尚未指定 provider/model/凭据；先冻结目标 schema、协调器和数据最小化原则。生产 transport、完整同意 UI、报告队列和迁移/撤回接线仍须单独验收。

## 2026-07-17：[已取代] 侧栏按产品上下文切换，不把 S04 变体全局化

- 决策：S01–S03 与完成/记录页面使用全局练习导航；S04/S08 使用 Fast Loop 聚焦导航并冻结本轮模式；S11/S12 使用设置局部目录。最近练习位于模式之后，逐条打开本地 Session。
- 原因：approved Pencil 中“新练习/练习记录/收藏题目/练习设置/最近”来自原始 A3 全局壳，“当前练习/表达记录/短 Drill/模式”来自 Fast Loop Amendment 的 S04 专用追加帧，二者表达的是场景层级而不是互斥视觉方案。

## 2026-07-17：自由练习是一次性任务，不进入模板题库

- 决策：自由练习固定使用清晰表达通用 Rubric，可选填题目、听众和目标；开始时冻结成 Attempt 的 `free-expression` task snapshot，不新增可复用模板。
- 原因：满足产品源 P0 的随开随说入口，同时继续保留 Fast/Deep 双轨、证据和同口径复讲边界。

## 2026-07-17：全局侧栏按对象导航，模式只属于单次练习条件

- 决策：此决策取代同日“侧栏按产品上下文切换”的练习侧栏部分。S01–S10、单次记录、收藏和练习设置共用一套全局 IA：新练习、练习记录、收藏题目、练习设置、最近练习；S04/S08 不再替换成“当前练习/模式”侧栏。证据全屏仍按批准稿隐藏侧栏，S11/S12 保留设置局部目录。
- 原因：模式是当前练习的 Rubric/任务条件，不是可在全局信息架构中跳转的资源；统一对象导航也使最近练习像聊天记录一样可直接回查，并消除页面之间的侧栏变体和双选中。
- 选中规则：S02 仍只归属“新练习”；S10 只选中“练习记录”；S13 标准宽度只选中对应最近练习，compact rail 回退选中“练习记录”；“全部”是集合入口，不是第二个 current item。

## 2026-07-17：设置入口分离，浅色主题保持低饱和浅底

- 决策：全局“外观”与“练习设置”分别进入主题/阅读体验和麦克风/ASR/AI/数据设置，不允许两个入口落到同一外观板块。浅色主题必须使用低饱和浅底与足够正文对比，过深、过重的色组归入深色语义。
- 原因：用户逐屏验收明确指出入口串页和浅色卡片过深会破坏信息层级与主题预期；这项后续批准只覆盖设置 IA 与主题表现，不扩大冻结产品的数据或 AI 权限边界。

## 2026-07-17：发布验收按证据层级判定，不以组件存在或 mock 覆盖代替生产能力

- 决策：需求只在真实用户路径已接通、数据边界成立、失败路径可恢复且有相称证据时记为 PASS；纯类型/状态枚举/helper、Vitest/jsdom、QA fixture 和可注入但未接线的 transport 分别只能证明模型或局部交互，不能写成生产闭环。
- 原因：本轮逐功能审计发现旧验收把部分 mock/jsdom 结果描述成完整 VAD、AI、降级和 Deep 生产能力，容易误导发布判断。
- 当前发布结论：保持 `0.1.0-alpha.0`，总体为 **NOT READY**。自动化与打包门禁通过只证明已实现范围无回归；真实 AI/VAD-ASR 恢复、可靠报告队列、纠正重算、内容、环境检查、自定义受限 renderer 协议/fuse 收紧、真实 125% 缩放和 Electron 真 E2E 关闭前不得升级为生产就绪。

## 2026-07-18：打包 Renderer 使用只读受限自定义协议

- 决策：打包版使用 `phrio-app://renderer/index.html`，不再使用 `file://`。自定义 scheme 只取得相对资源解析所需的 standard/secure 与 code cache 能力；不允许绕过 CSP、Service Worker、CORS、Fetch、扩展或流式协议能力。
- 资源边界：协议处理器只接受 `GET`/`HEAD`，只提供根 `index.html` 与 `assets/` 下平铺、扩展名 allowlist 的构建资源；拒绝 query、凭据、端口、嵌套目录、未知类型、路径穿越与缺失文件。IPC 和麦克风权限继续只信任当前主窗口的固定入口文档。
- Fuse：`GrantFileProtocolExtraPrivileges` 关闭；RunAsNode、Node options、inspect、ASAR 完整性与 OnlyLoadAppFromAsar 继续按既有安全基线收紧。
- 证据：定向协议测试覆盖 privilege、allowlist、只读方法、CSP、MIME 与 trusted sender URL；packaged smoke 证明实际 Renderer 协议为 `phrio-app:`、31 个窄 bridge 方法可用且 Renderer 无 Node process；fuse 读取确认 file extra privilege 为 Disabled。

## 2026-07-18：Fast/Deep 冻结边界从“部分采用”升级为已采用

- 决策：此决策取代 2026-07-17 同名决策中的“当前采用状态”。Deep Lane 只读取持久化 Session `taskSnapshot`、冻结 Attempt、带版本纠正和持久化产物；每个生产 Session 自带完整 Rubric、Drill 与映射，不再使用 App draft 补训练语境。
- 原因：Session/Attempt/Snapshot 身份校验和持久化成功门已经接通；旧定义缺失的历史记录只允许通过可验证的 mode-version fallback 恢复，不能默默读取当前内容包。
- 纠正规则：原始 final 与证据历史永不覆盖；纠正递增分析输入版本，使旧 Deep/Comparison 结果进入 superseded 中性历史，再按当前 exact payload 重新批准或本地重算。
- 比较口径：`paired-1` 只读取本轮冻结焦点声明的 `comparisonDimension` 和对应正式证据；其他指标明确不参与，缺证据返回 insufficient evidence。比较 artifact 同时冻结维度、信号、两遍值与可比性 basis，避免未来 UI 或内容包改写结论。
- 产物引用：普通 snapshot/correction/report/Drill/comparison 在 Service 写入门校验完整引用图；允许既有的“先冻结 snapshot、后保存同一 Attempt 音频”顺序，但下游产物只接受已落盘且属于同一 Session 的 Attempt/Snapshot/Segment/Evidence/Focus/Drill。跨 Session 身份复用、冻结快照改写和口径漂移均拒绝。
- 证据生命周期：规则输出先经过 final-only 门，再由稳定 final 确认为 `confirmed`；无 span 的结构、任务、节奏证据同样适用。`withdrawn` 永不原地复活，问题重现时分配新 O 锚点。冻结任务上下文读取失败不得完成尾句或冻结快照，只能明确降级并重试。
- AI 恢复：Deep queued/processing artifact 在重启后提供“继续处理已批准 payload”，不重新准备或扩大同意；同进程按 analysis input、payload hash 与 consent 合并重复请求。应用退出期间不是后台守护进程，继续动作仍由用户明确触发。

## 2026-07-18：固定云端 AI provider、模型与传输协议

- 决策：此决策取代 2026-07-17“provider 可注入且冻结前不硬编码外部端点”的临时状态。生产路径固定为 OpenAI Responses、`gpt-5.6-terra`、`https://api.openai.com/v1/responses`；请求使用 `store: false`、严格 JSON Schema、禁止重定向、固定 prompt/schema version 与主进程语义校验。
- 同意：`live_hint` 使用配置级同意且每个 Attempt 显式 AI ON；`deep_diagnosis` 和 `comparison` 按 exact payload hash 逐次批准。原始音频与 partial 在 Schema 和 transport 边界均被禁止。
- 凭据与审计（历史口径，密钥存储已由 2026-07-20 fallback 决策取代）：当时 API Key 只存 Electron `safeStorage` 加密文件；同意、获批 payload 和请求 lifecycle 存独立 SQLite，不与练习 Session 或音频混存。
- 降级：任何网络、认证、限流、provider、超时、拒绝、Schema 或语义失败只影响对应可选 AI 用途，本地录音、final、本地证据、复盘、Drill 和 paired-1 比较继续可用。

## 2026-07-18：应用外观使用完整语义主题，而非局部换色

- 决策：`system`、`light`、`dark` 必须切换 App shell、Sidebar、Workspace、Canvas、surface、field、文字、边框和状态语义；浅色/深色分别保存 8 组受约束配色。浅色保持低饱和浅底，强调色不能反向污染背景层级。
- 阅读：界面与正文统一支持 90%、100%、112.5%、125% 四档缩放；系统与应用 reduced-motion 都关闭平滑滚动并把非必要动画压至近零，不删除状态或功能。
- 持久化：SQLite 是权威值，Renderer localStorage 只用于首帧防闪；并发保存串行化，失败回滚到上一次持久化设置。

## 2026-07-18：Production Closure 的证据与发布口径

- 决策：2026-07-17 的 **NOT READY / 功能性 Alpha** 仍是准确的历史快照，但其中列出的 AI、快照边界、ASR 恢复、环境设置、自定义协议、真实 Electron 125% 与真 E2E 缺口已由本轮实现和相应自动化取代。
- 当前口径：代码进入 **Production Closure candidate / Internal Alpha**；不把它描述成公网上线或外部环境验收完成。版本保持 `0.1.0-alpha.0`，直到真实目标 Mac、真实麦克风/模型、用户自备 OpenAI Key 调用、性能与内容专业评审完成。
- 自动化证据：`pnpm verify` 通过 38 文件 / 273 测试及打包 smoke；真实 Electron 视觉 85/85，产品巡检 82/82，生产 console 0 error / 0 warning，自动化外部请求 0。受控 QA 直接注入音频、partial/final、证据与尾句事件，只使用真实 Session/IPC/SQLite 证明跨页面持久化闭环；它不证明生产 recorder、Sherpa、规则标注/尾句编排或 AI 服务，这些边界需由对应单元/集成测试与真实环境验收分别承担。

## 2026-07-18：云端 AI 产物必须由主进程证明，而非信任 Renderer 生命周期

- 决策：Deep diagnosis 与 semantic comparison 的云端 artifact 只有在主进程同时证明以下事实后才能写入：canonical artifact identity、唯一 analysis input、权威冻结 Session/Attempt/Snapshot/纠正图、同用途 exact payload 同意、受支持且当前 prompt、真实 provider request 终态，以及 terminal result 的 canonical hash。
- 原因：exact consent 只能证明“用户批准过这份 JSON”，不能单独证明 JSON 来自当前冻结 Attempt，也不能证明一个结构合法的 complete/failed/superseded 状态真实发生。Renderer 是交互发起方，不是诊断事实和请求收据的权威来源。
- 投影规则：云端 payload builder 与可编辑 payload 校验移到 `shared/`，Renderer 预览与主进程复建使用同一纯函数。原始音频、partial、跨 Session 标识和冻结图之外的内容仍禁止进入请求。
- 生命周期规则：complete 不可回滚；已有 provider result 不可擦除或替换；superseded 必须由实际 transcript/focus revision 漂移支撑；failed 必须对应真实失败/丢弃请求，或严格限定的撤回、过期、prompt 迁移前置终态。旧 prompt consent 可作为历史读取，但不再是当前 active consent。
- 删除与撤回：Session 删除、训练数据重置、同意撤回和 API Key 变更均通过主进程 gate/串行操作协调。结果返回后仍需再次检查删除、撤回和 consent 状态，迟到结果不得重新落库。
- 证据：对抗性测试覆盖伪造 payload/result hash、未来时间、重复 analysis input、跨图 segment、无真实漂移 supersede、terminal 回滚、结果擦除、旧 prompt、删除中迟到结果和执行前引用图复核。当前门禁见 `docs/acceptance/2026-07-18-adversarial-hardening.md`。

## 2026-07-18：前端异步操作以 operation identity 和持久化权威值收口

- 决策：跨路由、跨挂载或可重复点击的异步操作不得仅依赖组件闭包。Comparison 使用输入 revision + operation token；历史加载使用 revision；音频保留设置使用模块级串行队列和持久化结果广播；Fast 尾句在每个 await 边界检查 mounted + Attempt identity。
- 原因：旧页面迟到的 Promise、双击提交或卸载后的 setState 会让 UI 显示与 SQLite/云端实际状态分叉，甚至让已清除的数据重新出现。必须让持久化结果和当前 operation identity 决定可见状态。
- 失败语义：保存失败回滚到最后一次已确认持久化值；输入变化使旧云结果进入 superseded；卸载或 Attempt 变化只丢弃旧操作，不生成新的 lifecycle 事件。

## 2026-07-18：实时短提示由主进程 final 租约授权

- 决策：Renderer 的 `explicitAttemptAiOn: true` 不构成授权。ASR start 必须从持久化 Session 建立 `sessionId + attemptId + generation` lease；主进程同时证明当前练习阶段、冻结 task / Rubric、每轮 AI ON、phase / transcript version，以及本地 ASR 自身落定的 canonical 最新 final 窗口后，才允许 `live_hint` 进入 provider。
- 传输边界：配置级同意和 provider 请求只允许冻结任务内容与累计 final 文本。Session、Attempt、segment、顺序、revision 和 policy hash 等本地权威元数据只用于授权、删除关联与审计，不能出站；Attempt ID 使用与 Session 无关的随机身份。partial、任意旧 final 子集、伪造 task 与 stop 后结果全部拒绝。
- 恢复边界：尚无 final 时允许一次受控 PCM 重放；已有 final 后 ASR 中断必须明确降级并重录，不能从样本 0 重放并制造 UI / ledger 双账本。

## 2026-07-18：隐私删除、同意重置与本地报告使用不可逆终态

- 删除顺序：先建立请求 gate 并清云 exact payload / audit，再删除本地引用图和音频。云删除失败时保留本地图供重试；本地音频清理失败不能让已删除的云数据复活。
- 同意重置：queued / processing Deep/Comparison 必须先追加 `consent_reset` superseded 历史，再删除同意和审计；重载不得继续无同意任务。
- 本地报告：complete `deep_report` 同 ID 的全部 payload 不可变。不同 snapshot、纠正版本、criterion 或 Drill 使用稳定 SHA-256 身份；改选焦点产生新报告并保留旧历史，只有当前报告持久化成功后才可进入 Drill。

## 2026-07-18：诊断日志是本地支持能力，不建设遥测平台

- 决策：应用、窗口、录音、VAD、ASR、Fast/Deep、AI、IPC 和持久化共用主进程单写入器；Renderer 只通过 schema 校验的窄 IPC 发送无正文事件。事件采用 JSONL、run/sequence/incident/correlation ID，设置页提供状态、打开目录、显式导出和清除。
- 留存：应用管理的日志最多 7 天；单文件 5 MB、总量 25 MB，超限从最旧文件开始清理。日志只在本机，不自动上传；用户显式导出的诊断包属于外部文件，不由应用自动删除。
- 内容边界：不记录原始音频/PCM、partial 或完整转录、AI prompt/请求响应体、Authorization、API Key 或可能包含正文的错误消息；保留错误类型、稳定错误码、短栈帧和指纹。该固定字段排除与少量脱敏是必要底线，不扩展成复杂隐私工程。
- 删除与韧性：单独清除只删除诊断日志；“清除训练数据”也同步清除应用管理日志。日志写入失败不得阻塞录音、转写或 Deep 主流程；采用 2,048 条有界缓冲、每 turn 64 条分批恢复、严重度保留与清空 generation，设置页必须暴露待写入、已丢弃与写入失败次数，避免把不完整日志当成完整证据。高频 partial 元数据按秒采样，final、失败和恢复完整保留。模型安装状态的 500 ms 成功轮询不记录逐次 IPC start/complete，失败仍记录；下载进度按里程碑记录，确保 25 MB 容量用于可行动故障而非健康轮询。
- 留存时钟：7 天保留严格使用已校验事件的 `occurredAt`，不使用文件 mtime 推断事件新旧。文件可能被 touch、恢复或维护重写，mtime 只能继续用于 25 MB 容量超限时的文件淘汰排序；无法解析的行保留给显式导出统计，不由留存维护静默删除。
- 不做：不建设遥测、后台上传、账号同步、自有日志后端、用户画像、埋点分析看板、远程采样或复杂同意流程。
- 原因：真实体验和迭代需要足够细的故障时序与关联线索；本地结构化轨能支撑复现、导出和对抗性修复，同时符合冻结产品源的 7 天与敏感内容边界，并控制实现投入。

## 2026-07-20：录音前必须证明本地转写可用，失败后保留可恢复的同一遍

- 模型分发（取代本节早期的“默认下载 GitHub 整包”）：仓库和 App 不内置第三方权重。默认路径固定 Hugging Face model ID 与 revision `8e40c43232a1c5c66c82111efc5820d3accca11b`，只取三个运行文件，合计 237,202,501 B（约 226.2 MiB）。来源顺序为明确标记的第三方 `hf-mirror.com` 可选入口 → 官方 `huggingface.co` → 官方 k2-fsa GitHub Release 整包兜底；镜像不被当作官方信任源，且当前真实链会精确迁移到官方入口，因此迁移后的状态与 receipt 必须归属官方而不能继续宣称“加速”。字节只有命中冻结文件长度/SHA-256 并通过 native recognizer + stream 初始化才可 promotion。Renderer 仍只能发起、读取阶段/字节进度或取消窄安装用例，不能指定 URL、路径或参数。
- 直连韧性：三个文件使用共享 8 工作者的固定分段、`.phrio-asr-direct-v2` checkpoint、严格 `Content-Range`、字节上限和最终 SHA-256。临时 408/425/429/5xx 按有上限的 `Retry-After` + 退避抖动重试；网络失败、空闲超时和正常退出保留 checkpoint，用户显式取消才删除。下载共用 Electron/Chromium 系统网络栈，因此遵循 macOS 代理/PAC；重定向仍由安装器逐跳 allowlist 校验。校验或 runtime probe 期间的取消/退出也必须阻止 promotion。
- 官方整包兜底：继续保留 `.phrio-asr-download-v1` 的 `Range` / `If-Range`、manifest/validator、精确归档尺寸/SHA-256、安全解压、旧模型回滚与原子 promotion，但不再是首选路径。完整且校验通过的归档可复用于提取重试；旧 `.phrio-asr-install-*` 只作为一次迁移或陈旧 staging 清理对象。
- 下载 timeout 归属：每次 HTTP Attempt 独占 idle timer；收到响应头与每个归档 chunk 后刷新，并在 redirect、失败或成功退出该 Attempt 时无条件销毁。禁止让 `ClientRequest`/复用 socket 的旧 timeout listener 或 deadline 影响后续重试。
- 录音前置：本地模型未就绪时不请求麦克风；主操作必须是实际安装模型，而不是“重新检查”或录完后才报错。默认直连下载约 226.2 MiB；普通断网/超时必须保留并继续三文件断点，不能自动改下约 1 GB。官方整包只处理官方三文件源明确不兼容安全分段、跳转或连续完整性校验的结构性情况，两者都不是内置资源或性能承诺。
- 输入真实性：MediaRecorder 与 PCM 必须来自同一条选择后的麦克风流。记录实际 track/device/sample/channel 和无正文的 RMS/Peak/chunk 元数据；AudioContext 是否接受请求采样率不可假定，所有送入 Sherpa 的 PCM 都按实际采样率连续重采样到 16 kHz。分析输出接零增益，不监听播放麦克风。
- 恢复边界：同一 MediaRecorder take 是 PCM callback 从未启动、中途停滞或长度明显不足时的权威恢复源；只在 Renderer 本地 decode/downmix/resample，不出站。没有 final 且完整 PCM 可用时，允许在模型/ASR 恢复后从样本 0 重转；恢复前清旧 partial，已有 final 后禁止重放，避免 Renderer transcript 与主进程 final ledger 分叉。没有完整 PCM 时不得展示“重新转写”空按钮，只保留回放与更换设备重录。
- 时间与结束边界：ASR 时间码取自已接受的 16 kHz sample clock，不取离线执行墙钟。停止先保留 300 ms PCM 尾块窗口，再等 MediaRecorder stop 和最终 watermark，随后完成 start/feed/tail drain、任务上下文协调、至少一个 final、safe end 和快照持久化；stop event 与本地 Blob decode 都有终止性 timeout。空逐字稿绝不形成有效 Attempt，快照写入超过 8 秒视为可见失败并复用同一候选重试。

## 2026-07-20：实时 AI 的冻结同意边界保持不变，但缺项必须可原位完成

- 决策：不再把 API Key、配置级同意、用途开关和 Session 读取结果压成一个不可操作的 disabled checkbox。练习页按缺项展示可执行的 Key 保存、同意预览/批准、用途开启，并在全部就绪后要求本次 Attempt 再显式 AI ON。
- 安全边界不变：Key 仍只进入主进程密钥 Repository；系统能力允许时优先使用 Electron `safeStorage`，不可用时采用下述明确披露的本机私有文件 fallback。`live_hint` 仍只发送冻结任务和累计 final，音频/partial/本地身份不出站；主进程 Session + Attempt generation + AI ON + final ledger lease 仍是调用 provider 的硬门。
- 状态语义：录音前打开只表达“本轮意图已开启、等待本地 ASR lease”，不能提前显示成“AI 实时处理中”；短提示继续标记为暂定，不能冒充 Deep diagnosis。

## 2026-07-20：safeStorage 不可用不能永久关闭实时 AI

- 决策：Electron `safeStorage` 是首选但不再是 AI 可用性的硬门。若其明确不可用，Key 使用 schema version 2 写入 `userData/secure` 下 0700 父目录中的 0600 普通文件；设置页和练习内设置必须显示“本机私有文件（未加密）”，且输入、保存、删除和三条 AI 用途继续可用。
- 文件边界：写入采用同目录私有临时文件、落盘同步与原子 rename；读取拒绝 symlink、hardlink、非普通文件、过宽权限和异常体积。显式删除同时适用于旧 version 1 加密格式与 version 2 fallback；旧加密文件保持兼容，系统加密恢复后再次保存即可迁回首选格式。
- 明文边界：Key 不进入 Renderer、IPC 返回值、SQLite、诊断日志或错误消息。主进程只在实际调用固定 OpenAI provider 时读取；fallback 不扩大 provider、endpoint、payload 或同意范围。

## 2026-07-20：内部体验包完整 ad-hoc 签名，正式分发另设门槛

- 决策：Forge 在 fuses 写入后对内部 Alpha 主包、Helper、Framework 与原生 ASR 依赖做完整 ad-hoc 签名；bundle identifier 固定为 `com.phrio.desktop`，每次打包后必须通过 deep/strict codesign、packaged bridge 和 Sherpa native smoke。
- 权限：主包 entitlement 仅声明麦克风 audio input，Helper/Framework 使用空继承 entitlement；package gate 拒绝 camera、location、bluetooth、USB、print 等无关能力，并检查 deep/strict codesign 与固定 bundle id。
- 边界：ad-hoc 只解决本机内部包的无效继承签名，不提供 Developer ID 身份、hardened runtime、notarization 或跨重打包 TCC 连续性。正式分发前仍需改用数字型 build version、加入 Phrio 产品图标并完成 Apple 发布链。

## 2026-07-20：模型 ready 是可验证运行事实，事件幂等使用源序列与领域身份

- 模型：安装目录必须包含原子写入的 receipt。schema v2 direct receipt 冻结 model ID、revision、resolved route 和三个目标文件逐项 exact size/SHA-256；schema v1 只保留旧 archive 安装的兼容读取，冻结官方归档 URL、checksum URL 与 archive identity。Environment 的 ready 还必须通过 native dependency load、recognizer 初始化与 stream 创建；失败分别投影为 `missing / corrupt / dependency_missing / runtime_init_failed`。成功 probe 只在文件 stat identity 不变时复用。
- 事件：运输层随机 eventId 不再作为长期幂等事实。Attempt 生产事件携带单调 `sourceSequence`，Reducer 保存单个 watermark；segment 使用 id + revision/sequence，annotation 使用稳定 annotation id + updatedAt/lifecycle，hint 使用 requestSequence + id 做语义 upsert。冻结快照保留领域产物，不保留固定窗口最终会淘汰的 eventId tombstone。

## 2026-07-20：模型下载使用 Electron 默认 Session 的系统网络栈

- 决策：direct 三文件下载和 GitHub Release archive fallback 共用绑定 `session.defaultSession` 的 Electron `net.request`，由独立主进程 Service 适配为既有 callback-style `requestGet`。因此 macOS 系统代理与 PAC 由 Chromium 网络栈处理，不再依赖未配置 `HTTP_PROXY` / `HTTPS_PROXY` 的 Node `https`；不用会把 manual redirect 变成拒绝错误的 `Session.fetch`。
- 传输边界：每个请求固定为 GET、`redirect: manual`、`credentials: omit`、`cache: no-store`；`redirect` 事件被转换为不含正文的 3xx response，仍逐跳交给 downloader 的 pinned URL 规则校验。最终响应保持流式 body，Abort、destroy、error、status 和范围响应头继续遵循既有续传/并发语义。
- 隐私与回退：transport 诊断只记录 `electron_system_network`，不记录入口 URL、redirect location 或签名 query；direct 优先、archive fallback、checkpoint、checksum 和 candidate runtime probe 的业务顺序不变。

## 2026-07-21：模型安装只在物理安装期间阻止 App suspension

- 决策：从 `LocalAsrModelInstaller.install()` 建立真实安装 promise 开始，持有一个 Electron `prevent-app-suspension` 临时租约；同一在途安装只持有一个 blocker。安装完成、失败、用户取消、退出暂停时释放，shutdown、fatal exit 与 `will-quit` 作为幂等兜底重试。
- 用户边界：选择 `prevent-app-suspension` 而不是 `prevent-display-sleep`，所以屏幕仍可按系统策略关闭。实现不执行 `caffeinate`、不修改系统偏好、不创建登录项，也不在安装结束或普通练习期间保留永久设置。
- 失败边界：blocker 获取、状态检查、释放或诊断写入失败均不得改变安装结果；失败只记录稳定错误码，退出仍继续。Electron 进程结束也会清理残余 blocker。
- 证据口径：最终候选已在全新隔离 `userData` 完成 `226.2 MiB` direct 安装、schema v2 receipt、逐文件冻结 hash、native probe 和重启 ready。该轮原始墙钟跨度主要包含 macOS 锁屏休眠，因此只证明闭环可完成，不作为速度或 SLA 数据；临时 blocker 用于消除后续同类 App suspension，而不是修饰这次原始耗时。

## 2026-07-21：诊断先交付，训练深度与比较由用户选择

- 决策：初讲的冻结快照与当前纠正版本必须先生成并保存一份完整 `deep_report`，随后立即显示诊断卡。用户可以保存诊断并结束、跳过焦点/Drill 直接同题复讲，或选择唯一焦点完成短 Drill 后复讲；retry 冻结后也可以保存结束，只有用户显式选择时才进入同一口径比较。
- 证据门：三个诊断后动作都携带 exact `diagnosisReportId`；主进程必须证明它属于当前 initial snapshot、当前 correction-aware transcript version、当前完整引用图且状态为 complete。自由复讲冻结 `focusVersion: null`；焦点复讲必须匹配当前 focus version 与 Drill completion。进入比较必须携带绑定当前 initial/retry pair 与 criterion 的 exact `comparisonArtifactId`，Session 在 SQLite schema v7 冻结该 ID，历史详情只读取这次真实查看的比较；旧记录没有该列时才使用兼容回退。
- 交互终态：用户未保存的 retry 逐字稿纠正会阻止“保存复讲”；取消或成功保存纠正后恢复。所有终态按钮使用同步 operation identity 和持久化对账，双击、迟到 Promise 或 provider response 丢失不得重复创建终态。阶段轨把焦点、复讲和比较明确标为可选，短 `live_hint` 继续不能冒充诊断结果。

## 2026-07-21：实时转写采用稳定 partial 与可复现 challenger gate

- 决策：当前生产 Paraformer 先保留，采集改用 same-origin 静态 AudioWorklet 1,024 frame，兼容 fallback 为 2,048 frame；连续 partial 以 grapheme 最长公共前缀稳定显示，final-only 状态机、证据和快照边界不变。endpoint trailing-silence rule 1/2 为 1.8 s / 0.8 s，verifier、实时 Service 与离线 benchmark 共用同一 recognizer profile。
- 测量口径：benchmark 以人工 speech spans 分开测 1.0× paced 首 partial/更新 gap/natural final 与 unpaced RTF；准确率分别使用中文 CER、英文 WER、中英混合 MER，并单独测关键术语 recall/precision/hallucination。没有人工 reference 或 active fixture 时必须输出 `metrics: null`，旧模型稿、LLM 清理稿和 ASR 自身输出均不能充当标准答案。
- challenger gate：Typeless/OpenWhispr 类产品的句末 ASR → 文本整理 → 注入机制只作为交互与后处理参考，不等同于连续“字随声出”。bilingual Zipformer、FunASR 或云端候选只有在同机、同人工标准集上同时给出准确率、首 partial、更新 gap、natural final、RTF、资源占用和分发成本后才可替换；云端 ASR 还需另行取得凭据、费用和逐用途外发授权，当前不静默接入。

## 2026-07-21：生产 Key 存储不再调用可能阻塞主线程的 macOS safeStorage

- 决策：本节明确取代 2026-07-20 的“系统加密优先”生产策略。真实打包巡检中，Electron `safeStorage.isEncryptionAvailable()` 在 macOS Keychain 不可用或锁定时同步等待并冻结主线程，使实时 AI 配置页面无法完成。当前生产构造固定返回 encryption unavailable，不调用 `safeStorage` 的可用性、加密或解密方法，Key 使用既有 schema version 2 本机私有文件。
- 文件边界：父目录固定 0700、普通文件固定 0600，写入仍采用同目录私有临时文件、fsync 与原子 rename，并拒绝 symlink、hardlink、过宽权限和异常体积。Key 不进入 Renderer、IPC 返回值、SQLite、诊断日志或错误消息；provider、endpoint、payload 和同意范围不变。
- 迁移边界：旧 version 1 加密文件不在启动时解密或自动覆盖，仍可显式删除；因生产不再触碰 Keychain，它会显示为未配置，只有用户明确重新保存 Key 时才写入当前格式。该取舍接受本机文件未加密，以避免录音与 AI 设置被主线程同步阻塞；若未来恢复系统加密，必须先证明 API 非阻塞或移出 Electron main critical path。

## 2026-07-21：练习记录身份由初讲首句冻结，管理元数据与练习图分离

- 命名优先级固定为“用户重命名 > 当前初讲冻结快照的第一句话 > 冻结任务标题”。自动标题只在 initial `AttemptSnapshot` 通过引用校验并落库时生成；partial、retry、纠正、实时 AI、Deep report 和 comparison 都不能改名。
- 记录名称来源必须显式保存为 `first_final` 或 `user`，不能只存一个无法解释的字符串。丢弃/重录只清自动标题，用户名称保留；新初讲可重新生成自动标题。
- 重命名与置顶使用窄列 UPDATE，普通 Session 图保存不写 `record_title` / `record_title_source` / `pinned_at`。`pinned_at` 只控制置顶组顺序，不修改 `updated_at`，取消置顶后恢复练习活动顺序。
- Attempt 丢弃与替换必须留下 Session 范围持久化墓碑，并与删 artifact、清自动标题处于同一 SQLite 事务。这样无论旧 snapshot/audio 在操作前、后或重启后迟到，都只有“先写后被删”或“因墓碑被拒绝”两种结果，不存在旧首句复活窗口。
- 模式是记录的元数据标签，不是左侧一级导航。标签使用独立主题 token 和可读文字；操作菜单在最近列表与完整记录页复用同一数据、IPC 和权限边界，紧凑侧栏不复制第二套管理逻辑。

## 2026-07-21：每条练习记录同时保留诊断结果与冻结实时证据

- 决策：单次记录默认进入“诊断结果”，并可切换到“实时证据”。诊断按“一句话结论 → 判断证据 → 唯一焦点 → 下一步”排序；元数据、完整逐字稿和 lifecycle 细节退到次级展开区，不与主结论争夺视觉层级。
- 数据口径：诊断结果读取 correction-aware 当前文本和有效证据；实时证据读取 initial/retry `AttemptSnapshot` 的原始 final、时间码、O 编号、标注和提示历史。后续纠正不覆盖冻结原句，而是把受影响的 O 记录转成中性历史态。
- 复用边界：历史页与 S04 共享句级左右账本渲染核心，但历史适配器不伪造录音、ASR、partial 或实时动画。partial 从未进入冻结快照，因此历史页明确说明“临时态不留存”，不能为了视觉完整而生成不存在的内容。
- 交互边界：结果/证据及初讲/复讲均使用可访问 tabs；O 编号两侧互相定位。1024px 仍保持两栏、一个证据滚动区和零横向溢出。
- 原因：最终诊断回答“现在应该怎么看、先改什么”，冻结实时证据回答“当时系统逐句看到了什么”。两者服务不同的回查目的，互相替代会丢失纠正历史或误把暂定反馈当成最终诊断。
