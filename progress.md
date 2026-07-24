# 推进记录

## 2026-07-24

- 将 GitHub 默认首页从英文切换为中文：`README.md` 采用与传播主视觉一致的精简
  中文产品叙事，完整英文版迁移为 `README.en.md`，原长篇中文实现与验收说明保留
  为 `docs/internal-alpha.zh-CN.md`。中英首页双向互链，开源门同时要求两种语言
  首页与中文技术说明存在；未删除功能说明或改变 Internal Alpha / 云端同意边界。
- 经 Dewens 明确授权执行历史隐私清理与 GitHub 建仓。先将内部最终 tip
  `8c11dbb` 的全部 12 个引用写入仓库外 `0600` bundle，并通过
  `git bundle verify`；再用完全相同的 Git tree 建立无父公共根 `14dbf71`，
  作者切换为 GitHub noreply。临时裸仓 main-only 推送模拟确认只有 1 个引用、
  1 个提交、0 个不可达旧对象；旧 Worktree 和旧分支没有删除。
- 创建空白私有仓 `Dewensong/phrio-speech-coach`，只推隐私清洁 `main`。
  重建后 GitHub-hosted Apple Silicon CI run `30067263075` 在 1m56s 内通过
  锁定安装、264 文件开源门、59 文件 / 596 项测试、系统网络与防休眠、macOS 包、
  18 签名目标、40 方法 bridge 和 Sherpa `1.13.4` smoke；随后从 GitHub 新空
  目录 clone，确认 2 笔提交均为 noreply、无父公共根和开源门通过。
- 第一次 staging 公开后真实发现 GitHub Web squash 没有沿用本地 noreply，
  而是使用了账号资料中的联系邮箱。仓库随即退回 Private 并改名保留为私有审计
  归档；在原 slug 创建新空仓，用同一根和同一源码 tree 重建 noreply 历史，
  重新通过 CI / clean clone 后才恢复公开。具体邮箱不进入文档；未来 Web merge
  前必须人工开启 GitHub 邮箱隐私与“阻止暴露邮箱的命令行 push”。
- 只在远程 CI 与 clean clone 通过后将源码仓切为 Public。启用只读 Actions、
  Dependabot security updates、Secret scanning、Push protection、Private
  Vulnerability Reporting；`main` 要求 PR、分支最新、对话解决、
  `verify-macos-arm64`、线性历史并禁止 force-push / 删除；公共候选环境限制到
  受保护分支并要求维护者审核。没有创建 tag / Release 或公开二进制。
- 开仓后 GitHub 首次报告 11 个开发/打包依赖告警；官方 npm 全量审计同步发现
  14 个当时有效告警。未 dismiss：以 `pnpm.overrides` 将 `tar` 固定到
  `7.5.19`、`tmp` 到 `0.2.7`、`fast-uri` 到 `3.1.4`。全量与生产依赖审计均
  降为 0；完整 `pnpm verify` 证明 tar 跨主版本覆盖仍能完成原生重建、打包、
  18 签名目标和所有 smoke。
- GitHub 首页将 1280×640 纸墨套印 social preview 前置，把
  “Practice the sentence, not a speaking score”确立为传播主张，同时保留真实
  打包受控 Demo 截图和证据标签。名称预检发现另有瑞典室内设计应用使用 Phrio，
  因此仓库 slug 采用更明确的 `phrio-speech-coach`；Phrio 继续是待正式品牌
  清关的工作名，不把网页检索冒充商标法律结论。
- 本轮没有改产品功能，没有新增受控 Fixture 或真实设备通过声明，没有请求
  麦克风、提供 OpenAI Key、发送转录文本、使用 Developer ID 或执行公证。
  源码可公开审阅，普通用户公共 Mac 分享包继续保持独立发布门。
- 启动 Phrio 全产品“编辑校样 × 表达排练 × 纸墨套印”体验改造，先建立
  `docs/plans/2026-07-24-editorial-rehearsal-redesign.md`，逐项冻结现有自由练习、
  题库/收藏、模型/麦克风、partial/final、停止恢复、证据、Deep 三分支、Drill、
  复讲比较、记录管理、分享、外观无障碍、AI 同意和诊断能力的新版去向。明确
  “移到第二层”不等于删除；阻塞、降级和用户决策仍必须自动上浮。
- 完成第一批可回退展示层改造：新增暖纸、深墨、海绿套印、朱红校样与系统宋体
  展示 Token；应用外壳、侧栏、命令栏和检查器统一编辑印刷语言。首页把自由练习
  提升为唯一视觉主角，听众/目标折叠进“练习条件”，受控 Demo 保留独立 Fixture
  标签，模板区域只展示 3 条推荐并保留完整题库入口。准备页改成可编辑排练单，
  原听众、目标、时长、冻结约束和 Session 开始动作全部保留。
- 新增首页功能保全回归和真实 Electron 首页/准备页布局断言。首页在
  1440×960、1024×960、1024×960 / 125% 下主动作可见且横向 overflow 0；
  准备页在 1440×960 / 1024×960 下可编辑字段和开始动作完整。完整 Electron
  visual 85/85（9 图），product tour 134/134（44 图、13 个产品步骤、6 个 QA
  步骤）通过；生产 console 0 error / 0 warning，外部 HTTP(S) 请求 0。
- 完整 `pnpm verify` 通过：59 个测试文件 / 596 项通过（另 1 文件 / 1 项显式
  跳过）、Electron 系统网络与安装期防休眠探针、macOS arm64 package、18 个
  签名目标、40 方法 packaged bridge 与 Sherpa `1.13.4` smoke 全部通过。
- 本阶段没有请求麦克风、没有调用 OpenAI，也没有新增真实设备证据；2026-07-23
  的真实麦克风与同包权限结果仍保留为独立历史证据，不能替代后续实时页改造后的
  真实设备复验。Goal 继续 active，下一波是实时练习的专注/证据分层与异常上浮。
- 第一波实现与测试已形成可回退提交 `202e645`；验收、决策、README 和真源记录
  随后独立收口。未配置 remote、未合并、未发布。
- 完成第二批可回退实时工作区改造：S04 / S08 默认“专注”只显示 final / partial
  原句与一条当前建议，显式“证据”视图继续复用原 EvidenceLedger、O 编号、单一
  scroller 和全屏；三技术通道压缩为事实健康摘要与可展开“采集详情”。全部模型、
  麦克风、静音、停止、短录音、同音频重转、take / snapshot / task context 恢复
  动作和 AI 独立同意入口保持原状态机与第一层可见性。
- 新增 tablist 方向键/Home/End、默认专注、反馈隐藏、证据切换、全屏连续性和
  采集详情回归。Electron visual 85/85（9 图），product tour 136/136（46 图）
  通过；新增专注页和三通道详情截图，生产 console 0 error / 0 warning，产品 /
  QA 外部 HTTP(S) 请求 0。完整 `pnpm verify` 仍为 59 文件 / 596 项通过（另 1
  文件 / 1 项跳过），系统探针、18 签名目标、40 方法 bridge 与 Sherpa smoke
  全通过。
- 第二波实现提交为 `80dacf3`。本阶段没有请求麦克风或调用 OpenAI；真实设备、
  本地模型质量、目标 Mac、Developer ID / 公证边界未改变。下一波进入逐字稿、
  诊断、Drill、复讲与比较，Goal 继续 active。
- 完成第三批可回退训练闭环改造：S05 成为逐句可纠正的冻结校样稿，S06 / S13
  按结论、原句证据、唯一焦点、下一步重排，S07 成为只突出一个当前动作的排练
  工单，S09 成为不强迫比较的复讲冻结票据，paired-1 成为左右双页同口径校样。
  append-only correction、报告先保存后导航、三条诚实路径、焦点显式采用、Drill
  自检持久化、自由复讲、证据不足与云端 exact payload 独立同意均未改协议。
- 训练闭环定向 3 文件 / 30 项通过；Electron visual 85/85（9 图），product
  tour 137/137（46 图）通过，并新增稿纸、诊断层级、唯一当前 Drill 步骤、
  `TAKE 02 · FROZEN` 和 8 行双页 frozen final 断言。人工复核 7 张
  1440 / 1024 代表图无横向溢出、遮挡或主操作丢失。
- 完整 `pnpm verify` 继续通过 59 文件 / 596 项（另 1 文件 / 1 项跳过）、
  Electron 系统网络与安装期防休眠探针、当前源码打包、18 个签名目标、40 方法
  bridge 与 Sherpa `1.13.4` smoke。实现提交为 `8523935`。
- 本阶段没有请求麦克风、安装模型或调用 OpenAI；自动化、受控 Fixture 与
  2026-07-23 真实设备历史证据继续分开。下一波进入记录、设置、受控 Demo、
  分享与开源传播面，Goal 继续 active。
- 完成第四批本地档案与传播校样：练习记录成为编号档案索引，单次记录成为
  Session 卷宗，常规/外观/练习设置成为设备账册、排版台与排练规则；搜索、
  筛选、重命名、置顶、删除、详情双视图、日志、模型、Key/同意和危险操作未改。
  实现提交为 `474a537`。
- 受控 Demo 改为 `FIXTURE EDITION` 三阶段校样册，真实导出卡改为
  `RESULT PROOF` 编辑海报并保留证据 opt-in、完整逐字稿禁入、三比例、三格式和
  纯净展示。README Hero、GIF 与 social preview 已从同一已验打包版更新；实现
  和素材提交为 `8f8a655`。
- 记录/设置定向 5 文件 / 31 项、传播定向 1 文件 / 4 项通过。Electron visual
  85/85（9 图），product tour 140/140（46 图），完整 `pnpm verify` 继续通过
  59 文件 / 596 项（另 1 文件 / 1 项跳过）、系统探针、18 签名目标、40 方法
  bridge 与 Sherpa `1.13.4` smoke。
- 传播素材采集使用隔离空 `userData`，确认 0 麦克风请求、0 模型安装、0 Session、
  0 外部请求、0 Renderer 错误。本阶段没有提供 OpenAI Key 或发送转录文本；
  Goal 进入全产品主题/缩放/键盘、真实设备边界和主真源建议的最终验收。
- 完成全产品终验补齐：新增深色主页代表图；90% / 112.5% 经真实设置 UI 和 IPC
  持久化后，在 1024 主页保持主动作可见且横向 overflow 0；连同既有 100% /
  125%、系统/应用 reduced motion、tab 方向键/Home/End、证据全屏和分享 Esc、
  诊断证据回焦，最终 product tour 为 149/149、49 图。记录菜单改用键盘 Enter
  打开并在 125% / 1024 留在视口内。未复现新的 P0/P1。
- 最终拓扑确认：当前 `codex/record-result-evidence-views` tip `0f1f922`，旧根
  目录 `codex/phase-1-foundation` tip `5f33f69` 是其祖先，当前领先 29 个提交；
  无 remote、无 main。本轮不创建 main、不配置 remote、不合并、不发布。
- 候选包仍为 `0.1.0-alpha.0`、`com.phrio.desktop`、ad-hoc、无 Team ID。
  最终建议继续 Internal Alpha；本机可继续直接使用，公共分享包等待 Developer
  ID / 公证 / 目标 Mac / 真实模型质量和独立授权 OpenAI 证据。
- 最终验收后经 Dewens 单独授权，在
  `cd4e33bf0939314fa85f46b500c48d1c705688ca` 直接建立并切换本地 `main`；
  原验收分支保持同点引用，没有合并提交。旧根和 fast-deep Worktree 均未修改，
  remote 仍为空，没有推送或发布。
- 启动 GitHub 开源前本地收口：CI push 统一到 `main`，checkout 禁止保留凭据；
  公共候选轨拒绝非 `main` ref，并把 Apple 证书 / API Key 从 job 全局环境缩到
  必需步骤；依赖安装与 `pnpm verify` 在凭据落地前完成。候选轨使用
  `macos-release-candidate` Environment。Dependabot 新增
  GitHub Actions 更新，空白 Issue 关闭以降低误贴隐私数据的风险。
- 新增 `pnpm verify:open-source` 并并入 `pnpm verify`，当前树拒绝凭据/签名材料、
  真实音频、数据库、模型权重、安装制品、工作站绝对路径和高置信 Secret；
  测试 Key 改用明确非生产格式，当前公开文档不再携带本机绝对路径。Git 历史中
  的提交邮箱与旧路径仍是发布前独立隐私选择，本轮不改写历史。
- 开源收口后完整 `pnpm verify` 通过：开源门、TypeScript、59 个测试文件 /
  596 项测试（另 1 文件 / 1 项显式跳过）、Electron 系统网络和安装期防休眠、
  macOS arm64 package、18 个签名目标、40 方法 packaged bridge 与 Sherpa
  `1.13.4` smoke 全部通过。官方 npm registry 的生产依赖 point-in-time audit
  返回无已知漏洞；生产许可证清单仅含 MIT、ISC、Apache-2.0。
- 本轮没有改产品功能或 UI，没有重跑受控 Electron visual/product tour，也没有
  请求麦克风、安装/评价模型、使用 OpenAI Key、发送转录文本或执行 Developer ID
  公证。证据与未完成 remote / 历史隐私 / clean clone 门独立记录在
  `docs/acceptance/2026-07-24-github-open-source-preflight.md`。
- 最终门复跑真实暴露一次 CI P1：Electron 系统网络探针已输出 302 / 206 /
  4-byte 成功 JSON，但本地测试 HTTP server 的残余连接未在 10 秒外层时限内
  关闭，导致门被正确判失败。生产 `electron net` 适配器未失败；只为探针收尾
  增加 idle close 与 250 ms 后残余本地连接强制关闭，避免成功断言后挂死。
- 探针修复后连续 20/20 次通过，最终完整 `pnpm verify` 再次通过 59 文件 /
  596 项、系统网络 / 防休眠、打包、18 签名目标、40 方法 bridge 与 Sherpa
  `1.13.4` smoke；最终提交证据对应修复后的暂存树。
- 本地 clean-clone 的首次 `pnpm install` 又真实暴露 P1：DMG 原生依赖的
  `node-gyp` 详细日志会展开继承的父环境，其中可能含与 Phrio 无关的凭据。验证
  随即终止，未把值写入仓库；根 `.npmrc` 保留 `node-linker=hoisted`、新增
  `loglevel=error`，并移除仓库级第三方 Electron mirror 强制。开源门要求该
  文件不含 registry / mirror / auth 配置；后续 clean-clone 改用最小净化环境
  与官方 Electron Release。
- 对 `6405179a9e55af2ff782dbf90bc7b8d3ff5d1e3d` 新建干净源码克隆，使用
  `env -i` 清空服务 Token、注入纯 Fixture sentinel、命令级官方 npm / Electron
  来源并复用本机已验缓存；锁定安装未把 sentinel 写入日志，完整 `pnpm verify`
  再次通过 59/596、系统探针、打包、18 签名目标、40 方法 bridge 与 Sherpa。
  两次独立空 HOME 冷缓存 Electron 下载未在有界窗口内完成并被主动终止，不计
  通过；官方冷下载继续由未来 GitHub runner 关闭。

## 2026-07-23

- 在真实内建麦克风验收中复现 P1 停止收束误判：`MediaRecorder.start()` 同步初始化约 659 ms 被错误计入 PCM 覆盖时长，导致已有健康 AudioWorklet、continuous partial 和 final 的录音在停止时被标为 `recording.pcm_capture_incomplete`。计时起点已移到 recorder 成功启动之后，并增加 650 ms 同步启动延迟回归测试。
- 修复后定向 3 文件 / 90 项与完整 `pnpm verify` 通过；当前自动化基线为 57 个测试文件 / 587 项通过（另 1 文件 / 1 项显式跳过）、18 个签名目标、40 方法 packaged bridge 与 Sherpa `1.13.4` smoke。真实麦克风停止收束复验仍单独记录，自动化结果不替代设备通过。
- 同日用分支 tip `b3a347f` 的真实打包版复验时再次诚实复现 P1：20,251 ms MediaRecorder take 只有 19,584 ms PCM，667 ms 缺口来自冷启动 AudioWorklet 模块仍在“录音中”状态之后异步初始化，而不是上一条已排除的同步 encoder 初始化。修复版先准备本地 PCM 通道，再启动 MediaRecorder 和用户可见录音状态；新增 650 ms 异步 worklet 初始化回归测试。
- 修复后同一台 MacBook Air、内建麦克风和既有真实模型完成 17,521 ms 实录：AudioWorklet PCM 17,512 ms，仅差 9 ms；274 次回调、280,192 个样本、0 丢弃、flush acknowledged、3 个 final，停止时尾句落定，未再出现 `recording.pcm_capture_incomplete`。短录音确认后快照 v1 持久化、final v1 冻结、网络发送显示“无”，并进入本地诊断与可选 Drill。OpenAI 全程 disabled，没有发送转录文本。
- 权限边界也用真实 UI 分开验证：重新打包的 ad-hoc App 因指定要求绑定新 CDHash 会再次弹出 macOS 麦克风授权；保持完全相同的修复包、不重新打包，只退出并重启后再次开始录音，用户确认没有再次弹窗。该结果证明同包重启权限可保持，不替代 Developer ID 签名升级、固定安装路径和目标 Mac Gatekeeper 验收。
- 新增最小 GitHub Actions macOS arm64 CI：固定 Node `24.18.0`、pnpm `10.33.2`，使用不可变 action commit，PR/候选分支执行 `pnpm verify`；push/手动运行生成 14 天 ad-hoc ZIP、SHA-256 与结构化 CI 证据。
- CI 压力模拟暴露三个已有测试等待竞态：10 ms 模型安装 timeout 可能在 sparse checkpoint 建立前触发，Deep UI 的默认 1 秒异步查询可能提前结束，空录音用例也可能在错误回调后、React 状态提交前读取旧状态。分别改为 checkpoint 建立后推进可控假时钟、显式 5 秒 UI 查询，以及在同一 `waitFor` 中等待回调与状态；均未修改对应生产行为。连续满载还证明默认 9 worker 会让 jsdom/稀疏文件夹具争抢资源，面向 3 核 hosted runner 固定最多 2 worker，并以 15 秒有界上限区分 runner 负载变慢与真正挂死。
- CI 明确不引用 Secrets、不提供 OpenAI Key、不发送转录文本；自动化、受控 Fixture 与真实设备证据分别声明。视觉/产品巡检与真实麦克风/模型/目标 Mac/OpenAI 继续是独立验收轨。
- 冻结当前实现真源候选为 `expression-practice-coach-production-closure` Worktree 的 `codex/record-result-evidence-views`；旧根目录 `codex/phase-1-foundation` 只作为祖先检查点。仓库仍无 remote/main，本轮未配置 remote、未合并、未发布。
- 完成开源传播层：新增永久标注为受控 Fixture 的 30 秒 Demo；它不请求麦克风、不安装模型、不创建练习记录、不调用云端。完成记录可本地生成 16:10 / 1:1 / 9:16 的 PNG、SVG、Markdown 结果卡并进入纯净展示；证据原句默认关闭，完整逐字稿永不导出，也不创建公共链接。
- 完成品牌与仓面：统一 Phrio mark、macOS `.icns`、README Hero / Demo GIF / GitHub social preview、英文主 README、中文完整说明、MIT License、第三方许可证、贡献/行为/安全文件、Issue / PR 模板、Dependabot 与 GitHub Release Notes 配置。新增 strict JSON 的 task-only 社区 Pack，构建期校验并编译为现有模式任务，不执行远程代码。
- 完成公共候选基础设施：Forge 可生成品牌 DMG 与 ZIP；Developer ID / hardened runtime / notarization 只在显式环境门开启，缺凭据立即失败。手动 GitHub workflow 只有 `contents: read`，只上传 14 天候选制品，不能 tag、Release、commit、merge 或发布。App 包内已携带 Phrio、Electron、React、Zod、Lucide、Apache-2.0 等许可资源。
- `maker-dmg` 在 pnpm 布局下首次真实执行暴露 `macos-alias` / `fs-xattr` 原生模块未构建的 P1，现由有界预检脚本使用 Electron node-gyp 明确构建并失败封口。新版编辑印刷图标收口后的最终 `pnpm make` 生成 `135,803,929 B` DMG 与 `137,987,136 B` ZIP；真实 Finder 打开 DMG 后确认纸张 / 套印品牌背景、拖拽箭头、`Phrio.app` 与 `Applications` 完整可见。当前签名仍为 `Signature=adhoc` / `TeamIdentifier=not set`，公共 gate 按预期拒绝。
- 最终自动化基线：`pnpm verify` 通过 59 个测试文件 / 595 项（另 1 文件 / 1 项显式跳过）、18 个签名目标、40 方法 packaged bridge 与 Sherpa `1.13.4` smoke；Electron visual 85/85（9 图），product tour 128/128（40 图），生产 console 0 error / 0 warning，外部 HTTP(S) 请求 0。传播素材从真实打包 Electron 的隔离空 `userData` 生成，确认麦克风请求、模型安装、记录创建、外部请求均为 0。
- 证据边界继续分层：当前 Mac 的真实麦克风停止收束和同包重启权限已单独通过；自动化、受控 Fixture 与该单机实录仍不替代真实设备中断、本地模型表达质量、经独立同意的真实 OpenAI 调用、目标 Mac 性能和 Developer ID / 公证正向路径。当前建议继续 Internal Alpha；本轮未配置 remote、未合并、未发布。
- 重做 macOS App / Dock 图标并统一传播美学：修复旧 PNG 角落被错误栅格为不透明白色、在 Dock 形成白方块的问题；新版以深色连续 `P` 表示第一次表达、错位海绿色副线表示复讲、单一朱红点表示冻结焦点，采用纸张 / 油墨 / 套印错位的平面编辑语言，不使用玻璃、柔光、麦克风或装饰波形。在 192/128/64/32 px 均保持可辨识；`pnpm build:brand-assets` 可从同一 SVG 重建透明 PNG、完整 `.icns` 与 DMG 背景，产品内 Logo、结果卡和 GitHub social preview 同步使用这套构造。
- 将本轮成果在目标分支按可审阅边界形成两笔实现提交：`a8046c4` 收口受控传播体验、结果卡与社区 Task Pack，`393a594` 收口开源仓面、品牌与 macOS 公共候选基础设施；验收、决策和真源记录随分支 tip 独立提交。未配置 remote、未合并、未发布。

## 2026-07-16

- 完成控制仓规则、PRD、Git 脏工作区和 Gate C 二元基线只读审计。
- 确认保留控制仓 5 个修改文档与 1 个未跟踪战略文档；不改旧执行 Worktree 和 Prototype Studio 的无关未跟踪目录。
- 创建独立产品仓，进入 P1 Production Walking Skeleton。
- 冻结 Electron 43 + React + TypeScript 的桌面基础方案，完成 Controller → Service → Repository、窄 preload API、Zod IPC 校验和单实例桌面壳。
- 完成 Gate C A3 的 S00–S11、三种 Mode Pack、首次引导、未完成 Session 恢复、历史列表/删除和系统/浅/深主题。
- 完成真实麦克风录音、回放、重录、两次 Attempt 上限，以及 SQLite + 私有音频文件的原子写入、完成/保留/删除、启动恢复和孤儿清理。
- 保持转写、诊断、Drill 和对比为明确标注的开发 Fixture；未伪装为真实音频分析。
- 验证通过：TypeScript、10 个测试文件共 57 项、macOS arm64 打包、packaged preload/SQLite smoke，以及 S01/S06/S09 的 1440/1024 视觉检查。
- 完成真实设备验收：重置 Phrio 麦克风 TCC、从空 userData 启动打包版，验证授权后的录音、回放、重录、退出恢复、两次 Attempt、完成状态和默认音频清理；详细证据见 `docs/acceptance/2026-07-16-p1-device-acceptance.md`。
- P1 基线退出条件已满足；下一阶段进入 P2 本地 ASR 技术 Spike。

## 2026-07-17

- 从精确产品源 `8d37b1345c83f0435318337b75746cbb6ef02177` 与 Gate C 最终基线建立独立 `codex/fast-deep-production` Worktree，未触碰控制仓用户改动。
- 完成真实 Mic、RMS voice-detected、16 kHz PCM → 窄 IPC → Sherpa-ONNX partial/final 适配器；模型缺失/中断/尾句有状态骨架，但无完整 VAD、无语音超时或生产重连恢复。
- 完成 generation-safe 幂等事件模型、final-only 本地反馈、累计 final 的 AI coordinator/schema、冻结 Attempt snapshot 与 SQLite practice artifacts；AI transport 与用户可用的三用途同意尚未接线。
- 完成 S04 句级共享行证据账本、精确 span + O 编号双向定位、撤回历史、单一 scroller、普通/紧凑证据全屏、语义滚动锚点、Esc 回焦和 reduced-motion。
- 完成 Deep Lane 最终逐字稿、带版本纠正、Rubric、唯一焦点、内联 Drill、同题复讲和同口径比较的本地骨架；可靠完整报告异步任务轨尚未接线。
- 浏览器验证 1440×960 / 1024×960 标准与全屏：横向溢出 0、共享行 top/bottom 差 0px、一个证据账本、Console 0 error / 0 warning；当时的 125% 仅改变根字号，后续审计确认不能作为真实缩放证据。
- 最终验证通过：TypeScript、14 个测试文件共 74 项、macOS arm64 打包和 packaged smoke（16 个窄 bridge 方法、Renderer 无 Node process）。
- 针对视觉复核反馈，重新逐项对照 approved Pencil / Gate C 校准 S04：恢复批准稿的侧栏与模式导航、三通道状态带、句级共享行高度、390/300/490px 证据列、O1–O4 内容与生命周期、平面语义记录带、底部录音条和全屏密度；修复全屏工具栏挤占网格导致列标题裁切与提示区异常拉伸的问题。
- 视觉修正后重新通过 1440×960 / 1024×960 标准与全屏、reduced-motion、语义滚动锚点、Esc 回焦与 Console 检查；当时记录的 125% 根字号代理不等同真实 Electron 缩放。
- 修复 `pnpm start` 开发体验空白：开发 CSP 之前拦截 Vite React inline preamble，导致 Renderer 在挂载前抛出 preamble detection error；现在仅对受信任的本地开发源放行 `unsafe-inline`，生产 `script-src 'self'` 保持不变，并补充 CSP 回归断言。
- 对照 approved Pencil 的原始 A3 与 Fast Loop V4 追加帧，纠正把 S04 聚焦侧栏全局复用的问题：全局练习页使用可切换模式与最近练习，S04/S08 冻结本轮模式，外观/常规与隐私使用独立设置目录；1024px 下继续保留可读文字而非竖排菜单。
- 接通产品源要求的一次性自由练习：题目可留空，听众与目标可选，直接建立 `clear-expression` 冻结快照且不写入可复用题库；同时将浅色主题改为低饱和浅底配色，与深色主题的高亮强调色分离。
- 针对导航修正再次通过 TypeScript、14 个测试文件共 76 项，以及 1440/1024 真实浏览器检查；外观与常规设置不再串页，三种模式可切换，进入练习后模式明确冻结，页面横向 overflow 为 0。
- 按最新 IA 复核彻底移除左侧模式层级：所有练习阶段共用“新练习 / 练习记录 / 收藏题目 / 练习设置 / 最近练习”，只有证据全屏隐藏侧栏；模式只在新练习与题库工作区切换，切换时任务和右侧条件原子同步。
- 修正历史入口语义与单一选中态：最近练习条目直接进入冻结单次记录，旁边“全部”和全局“练习记录”进入完整集合；单次记录展示任务快照、初讲/复讲、逐字稿、原句证据、唯一焦点、比较、版本、导出、再练和删除。
- 将收藏题目与练习设置落为真实本地能力：收藏写入 App settings，原始音频保留策略可读写并带保存失败回滚；旧 settings 自动补空收藏列表，避免升级后启动失败。
- 真实浏览器复核 1440×960 完整侧栏与 1024×960 56px compact rail，单一 active/current、横向 overflow 0 和 Console 0 error；当时的 125% 记录只用了根字号代理。`pnpm verify` 通过 14 个测试文件共 82 项、macOS arm64 打包与 packaged smoke。
- 按冻结产品源、approved Pencil、Gate C 与后续批准 IA 重新做逐功能追踪审计；结论修正为 **NOT READY / 功能性 Alpha**。此前记录中的状态枚举、helper、mock 与 jsdom 覆盖不能视为真实生产链路完成，当前结论以 `docs/acceptance/2026-07-17-product-readiness-audit.md` 为准。
- 修复本轮审计发现的数据真实性缺陷：包内补齐 Sherpa 原生依赖与 ASR 探针；endpoint 可把同文本 partial 升级为 final；AI transport 忽略 abort 时仍会丢弃超时/迟到结果；冻结快照只有持久化成功后才解锁 Deep，失败可复用同一候选重试。
- 修复跨模式与历史缺陷：任务的 mode/audience/goal 贯穿工作区与 Deep，焦点/Drill/比较不再固定为产品经理样例；comparison artifact 使用 Session 范围 ID，Repository 拒绝跨 Session 冲突；单次记录保留纠正前 ASR 原句、撤回证据和短提示生命周期历史。
- 修复实时反馈关闭语义：关闭后保留 transcript、录音/转写/分析通道与停止逻辑，同时隐藏划线、O 编号、右栏记录、当前提示、图例和问题统计；恢复后复用同一状态。
- 修复 ASR 启动/快速停止竞态：启动期间最多缓冲 8 秒 PCM；停止严格等待 start、feed 和 tail；页面卸载会关闭晚到 recognizer；启动/缓冲/feed/stop/无 final 异常均明确降级并阻止冻结空或不完整快照。
- 真实 Chromium 复核 1440×960、1024×960、标准/证据全屏（100%）：横向 overflow 0、唯一 `.evidence-ledger`、4 个共享行 top/bottom 差均为 0px；语义锚点保持同一 segment，Esc 回焦正确，系统 `prefers-reduced-motion` 计算值 `1e-06s`，Console 0 error / 0 warning。CSS `zoom: 1.25` 代理无溢出，但真实 Electron 125% 缩放仍待验收。
- 最终 `pnpm verify` 通过：18 个测试文件共 109 项、TypeScript、macOS arm64 package、16 方法窄 bridge smoke、打包后 Sherpa `OnlineRecognizer` 加载 smoke；应用包实测约 335 MB。该结果只覆盖已实现范围，不改变总体 NOT READY 结论。
- 未关闭的发布阻塞：真实 Live/Deep AI 与三用途同意、完整 VAD/无语音/ASR 重连和尾句恢复、可靠报告队列、纠正后证据/报告/比较重算、生产内容规模与专业评审、首次环境检查/完整设置、受限自定义 renderer 协议与 fuse 收紧、真实 Electron 125% 缩放，以及可重复 Electron 真 E2E/真实设备矩阵。

## 2026-07-18

- 关闭正式分发 renderer 协议门禁：打包版从 `file://` 迁移到只读、路径/类型 allowlist 的 `phrio-app://renderer/index.html`；生产信任策略只接受当前主窗口的固定入口文档，CSP 继续以 custom origin 的 `'self'` 生效。
- 关闭 `GrantFileProtocolExtraPrivileges` fuse，并保留其余既有 Electron fuse、sandbox、context isolation、无 Node integration、导航/新窗口拒绝和最小麦克风权限边界。
- 验证通过：TypeScript；renderer security 定向 7/7；macOS arm64 package；packaged smoke 显示 `rendererProtocol=phrio-app:`、16 个窄 bridge 方法和 Renderer 无 Node；包内 ASR dependency smoke；fuse 读取确认 file extra privilege 已 Disabled。
- 从旧产品就绪度审计继续关闭完整生产链：录音增加 8 秒 no-speech、20 秒短录音确认、5 分钟上限、设备断开/快速停止保护；ASR 增加 8 秒启动/队列上限、操作超时、一次本轮 PCM 重放恢复、尾句严格 drain 和空/不完整 final 冻结门。
- 将 Session、音频、ASR generation 与 Attempt 快照身份统一；快照只有持久化成功才解锁 Deep，失败保留同一候选重试。每个生产 Session 冻结完整 Rubric、Drill 与映射，Deep 不再读取 App draft；纠正、报告、焦点来源、Drill 和比较均按版本与身份校验。
- 接入固定 OpenAI Responses 云端轨：`gpt-5.6-terra`、`store: false`、严格 JSON Schema、禁止重定向、主进程 safeStorage Key、独立 Cloud AI SQLite、稳定错误码和请求/响应语义校验；preload 扩展为 30 个窄方法。
- 完成 `live_hint` 配置级同意 + 每次 Attempt AI ON、累计 final-only 防抖/冷却/去重/超时/迟到丢弃；完成 `deep_diagnosis` / `comparison` 可编辑 exact JSON、逐 payload hash 批准、queued/processing/complete/failed/superseded 生命周期和纠正后历史化。任何云端故障均不阻塞本地闭环。
- 完成应用级主题：system/light/dark 切换整套语义 surface，浅/深分别保存 8 组配色，浅色降饱和；增加 90/100/112.5/125% 整体缩放、首帧防闪、串行保存回滚和完整 reduced-motion。设置补齐环境检查、麦克风检查、音频保留、AI 三用途、Key、数据清除和偏好重置。
- 完成全局持久化操作锁、revision 防迟到覆盖、导航离开录音确认、历史恢复反馈、纠正串行化、二次确认 Dialog 与焦点恢复；移除生产 Renderer 对 canonical fixture 和旧诊断/比较页面的依赖。
- 最终只读交互审计再关闭启动 bootstrap 迟到覆盖、Deep 无改动纠正与失败 payload 重试的焦点恢复；主题对比度测试扩展到所有浅/深 palette 的 surface、hover、selected 与状态/证据语义面，题库搜索补齐 `focus-within` 键盘焦点环。
- 真实 Electron 视觉验收通过：85/85 断言、8 场景、9 图；覆盖 1440×960 / 1024×960、100% / 125%、标准/证据全屏、共享行差 0px、横向 overflow 0、唯一证据 scroller、语义锚点、Esc 回焦与 reduced motion。
- 关闭九类反馈的生产尾句缺口：`structure` / `task_gap` 现在从冻结 `taskSnapshot` 的 required fields / success conditions 在 final 尾句后幂等生成、更新、迁移与撤回；partial、重复/旧 revision、乱序、重连和本地标注关闭均保持正式证据边界。
- 关闭 paired-1 口径漂移：比较只读取已冻结焦点的 `comparisonDimension`，产物保存可审计 basis；结构/任务等缺正式证据时返回 insufficient evidence，不再借用 filler/hedge/vague 总量。
- 关闭 Deep 云诊断重启悬挂：持久化 queued/processing 记录可继续同一份已批准 exact payload，不重新扩大同意；同进程完全相同的 Deep 恢复请求合并为一次 provider 请求。
- 关闭最终 P1 终检缺口：普通 Artifact 按 Session/Attempt/Snapshot/Segment/Evidence/Focus/Drill/Comparison 做 runtime 引用校验并拒绝跨 Session 注入；final 精确与无 span 证据进入 confirmed，withdrawn 历史不复活；冻结任务上下文读取失败会阻止 tail/快照并提供幂等重试。
- 真实 Electron 产品巡检通过：82/82 断言、21 图；生产产品轨覆盖首次进入、自由练习、三模式、题库/收藏、设置、整套浅/深主题、Session 创建与记录 IA；受控轨直接注入音频、partial/final、证据与尾句事件，并使用真实 Session/IPC/SQLite 跑通初讲快照 → 逐字稿 → Deep → 唯一焦点 → Drill → 复讲 → paired-1 → 完成记录详情。它只证明跨页面持久化闭环，不替代生产 recorder/ASR/标注/尾句链及真实服务验收。生产 console 0 error / 0 warning，自动化外部 HTTP(S) 请求 0。
- 最终 `pnpm verify` 通过：TypeScript、38 个测试文件共 273 项、macOS arm64 package、30 方法 packaged bridge smoke 与包内 Sherpa dependency smoke。Production Closure 进入 Internal Alpha candidate；真实麦克风/设备、真实模型质量、真实 OpenAI Key 调用和目标 Mac 性能继续按手工验收清单关闭。
- 在 Production Closure 上完成一轮面向伪造输入、跨 Session 注入、终态回滚、删除/撤回竞态、异步迟到和重载恢复的对抗性审查。云端 Deep/Comparison 产物现在必须同时通过冻结引用图、canonical payload hash、当前用途同意、provider 请求终态与真实结果 hash 证明；Renderer 不能仅凭结构合法的 artifact 冒充已完成云诊断。
- 收紧云端 artifact 身份和生命周期：同一 Session/type/analysis input 唯一、canonical artifact id、主进程时间容差、terminal transition、完成结果不可擦除、纠正或焦点真实漂移后才可 supersede；旧 prompt 同意只可读取为历史，不能继续发起当前请求。
- 关闭数据治理竞态：按 Session 删除会阻止新请求、取消并等待同 Session 的 live/deep/comparison，再清 payload 审计、Session 与音频；撤回同意会取消对应用途并在结果落库前复核；重置、API Key 写入和音频偏好保存均串行化，旧页面或旧读取结果不会覆盖新状态。
- 关闭 Fast/Deep 迟到与身份缺口：重录生成全新 snapshot identity；live hint 的文本窗口与最多 24 个真实 final 引用保持同边界；低 RMS 但存在非空 ASR final 仍作为语音证据；ASR 时间码使用单调句段边界。Deep 报告和 paired comparison 读取纠正后的权威版本并由主进程重算，精确引文必须真实存在于获批源文本。
- 关闭 Renderer 操作竞态：comparison prepare/approve/retry 防双击并用 operation token 丢弃迟到结果；清空记录后旧 history 响应不会复活数据；音频保留设置跨卸载/重挂载共享串行权威值；尾句任务上下文在页面卸载或 Attempt 变化后不再写状态、发事件或冻结快照。
- 最终安全复审继续关闭四个 P1：`live_hint` 改由主进程 Session/Attempt/AI ON/ASR final ledger 租约授权，provider 只接收冻结任务与累计 final 文本，Session/Attempt/segment/顺序等本地身份和权威元数据不出站，Attempt ID 也不再编码 Session；清除数据采用云审计优先的可重试顺序；偏好重置先把待处理云产物冻结为 `consent_reset` 中性历史；complete 本地报告同 ID 不可回滚，不同焦点使用稳定 SHA-256 身份并在保存成功后才进入 Drill。
- 同时修复已有 final 后全 PCM 重放造成双账本、录音中 AI ON/OFF 未同步后端、改选焦点撞 report ID、历史详情报告选择漂移等对抗性回归。独立复核后重新通过 `pnpm verify`：TypeScript、38 个测试文件共 320 项、macOS arm64 package、31 方法 packaged bridge smoke 与包内 Sherpa dependency smoke。Electron 视觉矩阵重新通过 85/85，产品巡检重新通过 82/82、21 图；生产包 console 0 error / 0 warning，自动化外部 HTTP(S) 请求 0。详细证据见 `docs/acceptance/2026-07-18-adversarial-hardening.md`。
- 为真实体验与后续迭代接入本地主进程结构化诊断轨：应用、窗口、录音、VAD、ASR、Fast/Deep、AI、IPC 和持久化事件共用 run/sequence/incident/correlation 身份；preload 增至 36 个窄方法，设置页可查看状态、打开目录、显式导出和清除。
- 冻结诊断数据边界为本机 JSONL、最多 7 天、单文件 5 MB / 总量 25 MB；不记录原始音频/PCM、partial/完整转录、AI prompt/请求响应体或密钥，不建设遥测/上传/后台分析。清除训练数据同步清除应用管理日志，用户主动导出的文件继续保留。
- 对诊断实现完成对抗性收口：严格事件级 7 天清理、每日/5 MB 轮换、25 MB 总量、2,048 条有界缓冲与丢弃计数、每 turn 64 条分批恢复、短写补齐、部分写入回滚、写入确认与容量维护分离、清空 generation、清空后恢复写入、语义 operation/artifact 关联，以及录音阶段、五分钟自动停止、AudioContext 降级和 AI accepted/duplicate/disabled/late/timeout/failed 结果日志；正文继续留在产品数据而不进入日志。
- 最终发布审计同时修复 Deep Lane 焦点初始化竞态：焦点选项首次出现后的迟到默认 effect 不再覆盖用户或云端已明确选择的来源；原低频失败用例连续 10 次定向通过。
- 诊断日志定向验证通过：`tests/unit/diagnostic-log-service.test.ts`、`tests/e2e/diagnostics-settings.test.tsx`、`tests/integration/diagnostic-data-governance.test.ts` 共 3 文件 / 20 项。最终完整回归通过 41 文件 / 347 项；`pnpm verify` 已通过 macOS arm64 package、36 方法 packaged bridge smoke 与 Sherpa 原生依赖 smoke；Electron visual 85/85，product tour 90/90、23 图，打包产品 console 0 error / 0 warning、外部 HTTP(S) 请求 0。打包日志清空后在同一 run 从 sequence 56 继续到 98，证明 logger 未失活。完整门禁与真实设备清单见 `docs/acceptance/2026-07-18-diagnostic-logging.md`。

## 2026-07-20

- 依据真实 `userData/diagnostics` 复核用户体验故障：两次 Attempt 都在 0 ms 以 `ASR_MODEL_MISSING` 失败；22.520 秒录音仅 6,581 B，7.266 秒仅 2,209 B，且没有 `vad.voice_detected`。Session 因无 final / safe_end / snapshot 一直停在 `first_attempt`，实时 AI 则因 Key、配置同意、用途开关被压成一个 disabled 状态而无可执行入口。
- 只读审计上游 `fxy2311-youyou/expression-trainer@f925434ae85871c6ad2294b3756ee2d2b4b026ca`：保留其 PCM → Sherpa partial/final、final-only 标注/统计与累计 final 短提示机制，但修复其手工模型前置、实际采样率可能误标 16 kHz、停止尾句丢失与无 final 死路，不复制界面、品牌或项目结构。
- [已取代的首版安装策略] 新增官方 Sherpa 模型生产安装链：练习页和设置页都可一键安装固定 GitHub Release，并通过第 39 个只读窄接口展示阶段、已下载/总字节与百分比。安装精确校验 1,047,319,737 B 归档并按官方冻结 SHA-256 流式验真；当时采用约 1.7 GB 固定空间门、退出中止和启动/安装前清理随机 staging。真实下载证明该失败即清理策略不可接受，现已由下方固定 checkpoint 与断点续传策略取代。只提取三个运行文件、原子 promotion 和旧模型回滚边界继续有效；preload 增至 39 个窄方法。
- 录音链新增真实输入设备枚举和 exact `deviceId` 选择、track/sample/channel 元数据、PCM 回调/RMS/Peak、约 2 秒近静音与信号恢复诊断；AudioContext 实际采样率使用连续相位重采样为 16 kHz，分析节点接零增益 sink，避免麦克风监听声。VAD 同时使用安静语音的 RMS/Peak 门，不再只依赖过高单一 RMS。
- 练习页在模型缺失时阻止麦克风请求并提供真实安装动作；近静音时显示具体输入设备和切换入口。无 final 且存在受限 PCM 时，模型/ASR 恢复后可直接重新转写同一遍；已有 final 或无 PCM 时不提供无效按钮，明确要求重录以避免双账本。
- 实时 AI 从 disabled checkbox 改为可执行的内联设置链：保存 Key → 查看并批准 `live_hint` 配置级同意 → 开启用途 → 本次 Attempt 显式 AI ON；仍保留主进程 final lease 和 payload 最小化边界。
- 停止后的回放区进入正式 grid，不再被 footer/overflow 裁掉；safe end + 持久化快照后明确显示“继续：确认逐字稿 / 查看同口径比较”。快照 IPC 超过 8 秒会转为可重试失败，不再永久停在“正在冻结快照”。
- 自动化新增模型安装安全/回滚、麦克风选择与输入健康、实际采样率重采样、静音恢复、安静语音 VAD、模型 preflight、同录音重转、快照超时、Live AI 全设置链与明确下一步覆盖。完整门禁、Electron/真实设备结果和仍需外部模型下载的边界记录于 `docs/acceptance/2026-07-20-real-capture-transcription-recovery.md`。
- 模型安装新增原子安装 receipt：冻结官方 GitHub Release、官方 checksum 地址、归档精确字节/SHA-256，并记录三个运行文件的逐项精确字节与 SHA-256。独立 verifier 在录音前区分 `missing / corrupt / dependency_missing / runtime_init_failed`，对未变化模型缓存成功的 native recognizer + model load probe；旧的仅“存在且可读”不再冒充 ready。
- Attempt 事件去掉固定 512 个 eventId 窗口，生产源改用单调 `sourceSequence` watermark，segment/annotation/hint 同时按稳定领域身份 upsert；旧事件重放不会在窗口淘汰后重复，冻结状态不再携带无界运输事件墓碑。
- Forge 显式使用仅含麦克风输入的主包 entitlement 与空 Helper 继承 entitlement；`pnpm verify` 新增打包后 deep/strict codesign、bundle id、逐签名目标 entitlement 和 Info.plist 权限 gate，拒绝 camera/location/bluetooth/USB/print 等无关权限。
- 对真实录音链完成第二轮对抗收口：PCM 由 2 秒滚动 watchdog 覆盖零 callback 与中途停滞，自动 resume 仅一次；中断事实在 Attempt 内保持粘性，即使回调恢复也会在停止后从同一 MediaRecorder Blob 本地恢复完整 mono 16 kHz PCM。停止还会按录音时长与 sample clock 推断 watchdog 尚未触发的缺口。
- 停止意图增加约 300 ms 单块 PCM 尾窗，避免 MediaRecorder stop event 先于最后一次 `audioprocess`；stop event 5 秒超时和本地 Blob decode 15 秒超时都会清理并进入明确终态。恢复重放在离页、重录、超时 start 或迟到 start 后会关闭旧 recognizer，旧 partial 清空且无 final 禁止冻结。
- ASR 句段时间码改为已接受的 16 kHz sample clock，离线快速重放不再用墙钟执行速度；旧空快照仍可读取以兼容历史，但新冻结必须至少有一个 final。相关恢复/尾句核心组合最终通过 5 文件 / 85 项测试。
- 最终门禁通过：`pnpm verify` 完成 TypeScript、44 个测试文件 / 396 项测试、macOS arm64 package、39 方法 packaged bridge smoke 与 Sherpa 原生 dependency smoke；Electron product tour 90/90、23 图，Electron visual 85/85、9 图，失败为 0，生产 console 0 error / 0 warning，外部 HTTP(S) 请求 0。
- [历史包口径] 当时最后一轮验收脚本重打包后通过 packaged 两项 smoke、`codesign --verify --deep --strict` 与 9 项 fuse 读取；内部包为 `Identifier=com.phrio.desktop` / `Signature=adhoc`。其中“真实约 1 GB 模型尚未下载”只描述旧归档安装器阶段，已被下方三文件直装的真实结果取代；真实 OpenAI Key、准确率基准和正式 Developer ID / hardened / notarized 分发仍按外部清单验收。
- 真实旧包安装进一步暴露恢复缺陷：官方模型已下载约 53 MB 后，连接连续空闲约 30 秒触发 `ASR_MODEL_DOWNLOAD_FAILED`，旧实现随即删除全部已下载内容。该行为已作为已观察 P0 记录，不能再用“退出/失败后清理 staging”作为正确口径。
- GitHub 归档下载改为固定 `.phrio-asr-download-v1` checkpoint：manifest 冻结资源身份与 validator，HTTP `Range` / `If-Range` 严格续传；网络失败、空闲超时和正常退出保留进度，显式取消删除，完整归档可复用提取重试。该约 1 GB 路径现在只作为三文件直装不可用时的官方 fallback，不再是默认安装成本。
- 诊断噪声审计发现模型安装状态每 500 ms 成功轮询占据绝大多数事件；现对该成功 IPC 的 start/complete 做采样抑制，失败仍完整记录，下载进度改为有意义的百分比里程碑。该改动只减少无行动价值的重复日志，不降低错误、暂停、恢复和安装终态证据。
- 前端对抗性审查修复两条真实交互断点：实时 AI 配置完成后立即开启不再读取旧 render 的 consent 状态，`setLiveAi` 会返回本次开关是否真实接受；从另一页面接管在途模型安装后，取消会持续读取主进程终态，不会提前宣告完成或永久卡在 pending。旧 preload 缺少新安装方法时的同步异常也已纳入 Promise 错误边界，安装按钮可恢复重试。
- 修复真实机 `safeStorage.isEncryptionAvailable() === false` 时 Key 输入被禁用、实时 AI 永久不可用的问题：主进程优先保留旧 version 1 系统加密格式，并新增明确披露的 version 2 本机私有文件 fallback；目录/文件权限固定为 0700/0600，写入原子化，拒绝 symlink/hardlink，删除覆盖两种格式。设置页和练习内 AI 设置都显示实际存储模式，fallback 下保存、配置级同意、用途开启与本轮 AI ON 不再被系统加密能力误拦截。
- 收紧停止到 Deep 闭环：stop requested 后 Renderer 与主进程永久封口同一 Attempt 的实时 AI；零 PCM 也保留 300 ms 尾窗；停止后的音频 Attempt 与快照成对落盘并可在恢复任务后回放/继续，重录先丢弃当前 take。复讲比较页新增 append-only 逐字稿纠正并按最新版本重算；逐字稿纠正与当前版 report 完成落盘前 Drill CTA 禁用，主进程同时拒绝缺失或陈旧 report 的焦点选择。模型门文案改为保留“当前练习与下载进度”，不再暗示尚未发生的录音。
- 修复真实下载重试跨 Attempt 串线：不再依赖 `ClientRequest.setTimeout` 的 socket 继承语义，每次 HTTP Attempt 独占 30 秒 idle timer，并在响应头和每个归档 chunk 到达时刷新，所有 redirect/error/success 路径都在本 Attempt 结束时销毁。真实日志中 Attempt 3 仅约 5 秒就触发上一轮 deadline 的现象已由 fake/real timer 回归覆盖。
- 修复诊断长进程跨 7 天不裁剪：文件 mtime 只代表容器，不能证明内部事件年龄；维护现在对每个有效事件按 `occurredAt` 裁剪，mtime 即使被 touch/恢复到当前也不会保留过期事件，同时畸形行继续保留供导出统计。长进程第 8 天当前 run 事件不会被误删。
- 本范围验证通过：TypeScript；47 文件 / 444 项全量测试曾独立通过；模型 installer/verifier、事件幂等、环境状态、macOS 权限和诊断定向回归通过；重打 macOS arm64 包后 Info.plist 只保留麦克风用途说明，18 个签名目标通过 deep/strict codesign 与最小 entitlement gate。随后共享树的 Session 原子清理测试 spy 漂移由对应负责人独立收口，不在本条冒充最终全仓门禁。
- 模型下载 transport 改由 Electron 系统网络栈继承 Chromium / macOS 的代理与证书设置，并适配为 direct 与 archive 共用的 callback-style `requestGet`；manual redirect、无凭据、无缓存、流式 body、Abort / destroy / error 与范围响应头保持原 downloader 语义。首次请求只记录 `transport=electron_system_network`，不记录入口或签名 URL；transport 单测已覆盖范围响应、重定向、中止、拒绝和响应头归一化，最终打包复验由总门禁继续执行。
- 默认安装已改为固定 revision `8e40c43232a1c5c66c82111efc5820d3accca11b` 的三个运行文件，共 `237,202,501 B`（`226.2 MiB`）：`encoder.int8.onnx` 为 `165,462,184 B` / SHA-256 `81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a`，`decoder.int8.onnx` 为 `71,664,561 B` / `f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f`，`tokens.txt` 为 `75,756 B` / `59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6`。两个大文件各固定 8 段、全局 8 worker，`tokens.txt` 单块下载；`.phrio-asr-direct-v2` 保存可恢复 checkpoint，`408 / 425 / 429 / 5xx` 遵守 `Retry-After` 并带抖动重试。
- 下载源按“第三方可选入口 → 官方 Hugging Face → k2-fsa 官方 GitHub 整包 fallback”依次尝试；前两条三文件直装都必须匹配冻结 size/SHA，第三方入口若迁移到同一冻结官方对象则来源归属改为官方。GitHub fallback 继续保留归档级校验、断点续传与原子 promotion。候选目录在 promotion 前必须完成逐文件验真、receipt 校验与 native recognizer/stream probe，暂停、取消或失败不能被 checkpoint 误写成成功。
- [历史结果] 较早真实打包版曾在本机通过当时的默认镜像直装：下载约 31 秒、从开始到安装完成约 33.2 秒；最终模型目录和 schema v2 receipt 的 revision、route、三个 size/SHA 全部匹配冻结值，Sherpa native recognizer/stream probe 成功。后续真实 `308` 证明该入口当前迁移官方，因此这条只保留为历史链路观测，不能用于当前来源归属、下载性能、识别延迟或中文准确率 SLA。
- 真实麦克风检查已在 AudioWorklet 无回调时进入 `ScriptProcessor` 兼容通道并检测到输入（RMS `0.0035`）；真实自由练习随后产生连续 partial、中文 final 与 final-only 本地标注。87.814 秒长录音停止时曾因 PCM 比 MediaRecorder 少 774 ms 被误判降级，现已放宽为有界尾部调度差并保留真实丢样/停滞门，单测已覆盖；最终打包后的短录停止、快照与 Deep CTA 仍待总验收复验。

## 2026-07-21

- 使用全新隔离 `userData` 对当时的 hardening 包做真实从零安装，确认它仍未完成安装：镜像入口先把同一 model/revision/file 以 `308` 迁移到官方 Hugging Face，旧 allowlist 却把这一跳误判为 `ASR_MODEL_DIRECT_REDIRECT_REJECTED`；随后官方 direct 下载到 `59,321,877 B`（约 `56.6 MiB`，界面约 55 MB）后因普通网络 idle 失败。旧分类又错误进入 `1,047,319,737 B`（`998.8 MiB`）archive，archive 只保留到 `5,110,246 B` 后同样以 `ASR_MODEL_DOWNLOAD_FAILED` 结束。该 fresh-dir 没有安装出模型，不能拿既有用户目录约 33.2 秒的历史成功冒充最终新包验收。
- 修复下载源迁移与 fallback 语义：仅当镜像入口精确迁移到同一冻结 model/revision/file 的官方入口时继续使用同一 `.phrio-asr-direct-v2` checkpoint，并把 `resolvedSource`、界面状态与最终 receipt 归到官方 Hugging Face；普通 timeout/idle/网络失败保留 `226.2 MiB` 三文件断点并返回可重试失败，不再自动扩大到 archive。只有官方 direct 的 Range/redirect 结构不兼容或冻结对象完整性反复不一致，才允许进入 `998.8 MiB` GitHub archive compatibility fallback。
- Electron `43.1.1` 真实 safe probe 已验证实际跳转链，不记录签名 URL：镜像首跳为 `308` 到 `huggingface.co` 的同一固定 revision/file；官方首跳为 `302` 到 `us.aws.cdn.hf.co`，对象路径满足 `24-hex / 64-hex` 结构，`x-linked-size=165,462,184` 与 encoder 冻结大小一致，`x-linked-etag` 与冻结 SHA-256 一致；最终 `Range: bytes=0-0` 返回合法 `206`。该 probe 只证明逐跳信任结构，最终从零安装证据由下条独立记录。
- 最终候选打包版已在全新隔离 `userData` 从空目录完成默认 direct 安装，共 `237,202,501 B`（`226.2 MiB`）。安装后的三个文件逐项命中上文冻结大小/SHA-256，schema v2 receipt 固定 model ID、revision、`huggingface_direct` resolved route 与同一文件身份；同进程 native recognizer/stream probe 成功。退出应用并以同一隔离目录重启后，receipt、文件与 native readiness 再次通过并报告 ready，fresh-dir 安装验收不再沿用旧用户目录结果。
- 本轮真实安装的原始墙钟跨度受到 macOS 锁屏休眠主导，不记录为下载性能或安装 SLA。为避免长下载因 App suspension 停摆，模型物理安装 promise 活跃期间新增 scoped Electron `prevent-app-suspension` 租约；完成、失败、取消、暂停、shutdown/fatal/will-quit 均释放或幂等重试。该类型允许屏幕继续关闭，不修改系统永久电源设置，也不会延伸到普通练习或安装结束之后。
- 提交前对抗性审查再修复三条持久化真值：录音保存失败后的 discard 按 Session/Attempt 精确清理预落盘快照与派生产物并拒绝 stale identity；删除 API Key 会先阻止新请求，再停止并 drain live / Deep / comparison 在途请求，忽略 AbortSignal 的迟到 provider 结果也只会丢弃；诊断日志清除会删除后重扫磁盘，部分失败返回 `retry_required`，训练记录虽已清除但日志残留时 UI 保留明确重试入口。
- 最终共享树门禁通过：`pnpm verify` 完成 TypeScript、51 个测试文件通过 / 1 个跳过、514 项通过 / 1 项跳过、Electron 系统网络与 power blocker 原生探针、macOS arm64 package、18 个签名目标 gate、39 方法 packaged bridge smoke 和 Sherpa `1.13.4` dependency smoke。随后真实 Electron visual 85/85（9 图）与 product tour 90/90（23 图）均通过；生产包 console 0 error / 0 warning、自动化外部 HTTP(S) 请求 0。
- 最新生产包再以已完成 fresh-dir 模型重启并实际调用 installer，返回 `already_installed`、0 B 重下载和 `237,202,501 B` ready 模型；日志记录 `prevent-app-suspension` acquire → install skipped → completed release，首次释放成功且 `verified=true`，退出后无 Phrio 残留进程。
- 新增生产配置同源的离线 ASR benchmark：严格读取 16-bit PCM WAV、downmix / 16 kHz resample，以独立 1.0× latency run 与 unpaced RTF run 输出 changed partial、严格 sample-index speech-span onset / offset 延迟、active-speech boundary / inter-update gap、natural endpoint miss、forced flush、RTF，以及 zh CER / en WER / mixed MER；关键术语使用 occurrence / canonical / approved aliases 一对一 exact 匹配并报告 hallucination。manifest v1、JSON Schema、显式 skip 示例与完整口径文档均不提交真实音频或模型。工具会重新验证安装 receipt / 三文件 SHA，并把 manifest、源 WAV、canonical PCM、模型与 recognizer profile 身份写入报告；没有 active fixture 时输出 `metrics: null`，不生成数字。
- Deep 结果流改为诊断优先的柔性闭环：完整 `deep_report` 持久化后先显示诊断卡，用户可以保存诊断并结束、跳过焦点直接复讲，或只选一个焦点完成 Drill 后复讲；复讲冻结后可以保存结束或显式查看比较。终态均携带 exact `diagnosisReportId` / `comparisonArtifactId`，主进程证明当前 snapshot、纠正版本、focus/Drill 与 initial/retry 图，旧报告、结构相似伪造和迟到双提交均拒绝。
- Fast partial 使用连续 grapheme 最长公共前缀稳定展示，stable 与可修订后缀保持一份无障碍文本；正式账本仍只接收 final。采集主通道改为 same-origin 静态 AudioWorklet 1,024 frame，ScriptProcessor fallback 为 2,048 frame，模型 verifier、实时 Service 与 benchmark 共用同一 recognizer profile，endpoint trailing silence rule 1/2 固定为 1.8 s / 0.8 s。所有 timing 日志仅记录有界时延元数据，不记录 PCM 或正文。
- 对一条既有本机中文录音做只读探索性 benchmark：64 ms chunk 的 changed-first-partial p50/p95 为 844.581/1,511.023 ms，active update gap p50/p95 为 594.446/931.085 ms，unpaced RTF 为 0.027952；粗 speech spans 中 10 段有 1 段 first-partial miss、3 段 natural final。reference 是旧机器假设稿而非人工听写，因此不报告 CER/WER/MER 或准确率，也不把 paced decoder 数字冒充麦克风 capture → React render SLA。
- 打包版真实巡检定位并消除两条主线程卡死：`cloud-ai:get-configuration` 曾在 macOS Keychain 不可用/锁定时同步卡在 `safeStorage.isEncryptionAvailable()`，当前生产构造明确使用 0700/0600 本机私有 Key 文件并不触碰该同步 API；packaged bridge smoke 曾等待隔离 Session 的冗余 `clearStorageData()`，现移除该等待，临时 `userData` 仍在退出后 best-effort 清理。旧 version 1 加密文件保留且可删除，只在用户显式重新保存时替换。
- 最终对抗性审查修复两个 P1：旧在途焦点 Session 若存在多个 current report，会先按已冻结 `criterionId + drillId` 唯一匹配并原子回填，不再把正常旧数据卡死；普通 artifact 从终态转换开始即冻结，completed/abandoned 后拒绝迟到纠正、报告、Drill 与比较，只有已存在且经过 controller attestation 的云 artifact 可以继续追加 lifecycle 终态。SQLite schema v7 同时冻结用户实际查看的 `comparisonArtifactId`，历史详情不再猜列表中的最新比较；v6 中间数据库有独立迁移回归。
- 最终全量门禁通过：`pnpm verify` 完成 TypeScript、54 个测试文件通过 / 1 个跳过、565 项通过 / 1 项跳过、Electron 系统网络与 power blocker 原生探针、macOS arm64 package、18 个签名目标 gate、39 方法 packaged bridge smoke 和 Sherpa `1.13.4` dependency smoke；`pnpm benchmark:asr` 对三条显式 skip fixture 正确输出 measured 0 / `metrics: null`。真实 Electron visual 85/85（9 图）与 product tour 94/94（26 图）通过，生产 console 0 error / 0 warning、自动化外部 HTTP(S) 请求 0。

## 2026-07-21：最近练习首句命名与记录管理

- 最近练习默认名称改为初讲冻结快照中按 sequence 排序后的第一句话；中文、英文、中英混合、引号、乱序 final 与 Unicode 截断均有独立测试。复讲、纠正、AI 与 Deep 产物不能覆盖标题，用户重命名具有最高优先级。
- SQLite schema v8 增加 `record_title`、`record_title_source`、`pinned_at` 与 Session 范围 `discarded_attempts`。快照与自动标题同事务提交；丢弃/替换 Attempt 会原子删除派生产物、清自动标题并写墓碑，迟到旧 snapshot 或 audio 均拒绝，不能复活孤儿数据。
- 左侧最近练习与 S10 完整记录页共用同一真实命令：重命名、置顶、取消置顶和二次确认删除。模式改为独立的主题自适应标签；置顶不改变练习活动时间，取消后恢复原排序。
- 更多菜单补齐 ArrowUp/Down、Home/End、Tab/Shift+Tab、Esc、滚动/resize 回焦和 accessible description。Portal 宽高、点击区与定位按应用 text scale 同步，真实 Electron 在 1024×960 / 125% 下菜单完整位于 viewport，横向 overflow 为 0。
- 对抗性审查修复 S10 动作失败无反馈、成功后刷新失败显示旧 pin 状态、rename busy 卸载丢焦点，以及 product tour 置顶后过早 reload 的时序抖动。巡检范围说明同步为“只删除本 tour 在隔离 userData 创建的 Session，不执行批量训练数据清除”。
- 最终门禁：`pnpm verify` 通过 56 个测试文件 / 585 项（另 1 文件 / 1 项显式跳过）、40 方法 packaged bridge 和完整 macOS package gate；Electron visual 85/85（9 图），product tour 110/110（30 图），production console 0 error / 0 warning，外部 HTTP(S) 请求 0。

## 2026-07-21：练习结果层级与冻结实时证据双视图

- 重排 S06/S13 共用诊断卡，把真实结论提升为第一阅读层级，后续固定为判断证据、唯一焦点和下一步；Rubric、版本、逐字稿、AI lifecycle 等审计信息仍完整保留，但不再与结论使用同一视觉权重。
- S13 新增“诊断结果 / 实时证据”同级视图及“初讲 / 复讲”Attempt 视图。历史证据直接读取冻结快照的原始 final、时间码、O 编号、标注和提示，不读取迁移中的 UI 状态；诊断继续读取纠正后的当前文本。受纠正影响的旧 O 保留锚点并转中性历史。
- 抽取 S04/S13 共用证据账本渲染核心。历史页没有 partial、录音状态或到达动画；无精确 span 的整句证据也提供左侧 O 锚点，左右均可定位。initial/retry 使用 expected Attempt ID 选择 snapshot，避免旧 artifact 顺序漂移。
- 新增自动化覆盖诊断层级、tabs 键盘行为、raw final 与 correction-aware 结果并存、partial 不伪造、A1/A2、精确 span、撤回历史、O 联动和结果证据跳转。
- 对抗性审查补回诊断卡中的冻结短 Drill；诊断证据跳转后键盘焦点会落到匹配的右栏 O 记录。撤回原因统一映射为平静中文，多条整句 O 可在元数据行换行；证据页改用可容纳动态错误提示的纵向 flex，未冻结的建议来源不再猜成本地规则。
- 最终门禁：`pnpm verify` 通过 57 个测试文件 / 586 项（另 1 文件 / 1 项显式跳过）、40 方法 packaged bridge 和完整 macOS package gate；Electron visual 85/85（9 图），product tour 118/118（33 图）。生产包 console 0 error / 0 warning、外部 HTTP(S) 请求 0；开发 QA 轨只出现 Electron 自身的开发期 CSP 提示。
