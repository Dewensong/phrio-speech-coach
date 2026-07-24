# 冻结来源基线

## 实现仓 Source of Truth

- 当前主真源：本仓 `main`。
- `main` 建立基点：`cd4e33bf0939314fa85f46b500c48d1c705688ca`。
- 验收回退引用：`codex/record-result-evidence-views`，在建立 `main` 时与上述
  基点完全同点，继续保留为历史引用。
- 2026-07-23 候选父提交：`9b944af08878adf28ef2f7c907aa1b7c427df498`
- 传播体验实现提交：`a8046c4`（受控 Demo、结果卡、社区 Task Pack）。
- 开源仓面与发布实现提交：`393a594`（品牌、DMG、许可证、候选发布门）。
- 编辑校样式视觉基础提交：`202e645`（功能保全计划、视觉 Token、应用外壳、
  首页、练习准备与新增 Electron 布局门）。
- 编辑校样式实时工作区提交：`80dacf3`（默认专注、显式证据、采集详情、异常
  上浮、键盘 tab 与新增 Electron 全链路门）。
- 编辑校样式训练闭环提交：`8523935`（逐字稿校样、四级诊断层级、单动作
  Drill、复讲冻结票据、双页 paired-1 与新增 Electron 全链路门）。
- 本地档案与设置账册提交：`474a537`（记录索引、Session 卷宗、设备账册、
  外观排版台、练习规则与 Electron 管理门）。
- 受控 Demo、结果校样与传播素材提交：`8f8a655`（Fixture 三阶段、硬边
  `RESULT PROOF`、三比例导出、README Hero / GIF / social preview 与采集门）。
- 全产品主题、90–125%、键盘与主真源终验提交：`0f1f922`（149/149 Electron
  product tour、49 图、无新增 P0/P1；未创建 main、remote 或公共包）。
- 2026-07-24 全产品验收、决策与真源记录先随验收分支 tip 收口；随后经维护者
  单独授权，当前产品 Worktree 在同一提交建立并切换到 `main`。没有合并提交，
  当前实现不依赖未提交代码。
- 历史根 Worktree 停在祖先分支 `codex/phase-1-foundation`，不得作为当前实现
  或发布输入；另一个 fast-deep Worktree 同样只作历史检查点。
- 当前产品 Git 仓仍没有 remote。在维护者明确选择远程仓以前，不配置 remote、
  不推送、不发布。
- 真实麦克风复验和公共发布边界继续独立记录；建立 `main` 不会把 ad-hoc 制品
  变成 Developer ID 公共发布包。
- CI、证据分层与安全确立远程主真源的步骤见
  [Internal Alpha CI 与实现真源](release/internal-alpha-ci.md)。
- 当前树开源安全面与未完成远程门见
  [2026-07-24 GitHub 开源预检](acceptance/2026-07-24-github-open-source-preflight.md)。

## 功能 Source of Truth

- 控制仓：维护者本机私有产品来源，不随本仓公开
- Product source：`8d37b1345c83f0435318337b75746cbb6ef02177`
- 冻结文件：PRD V1.1、产品边界 V1.1、用户与模式体系、Fast Loop Amendment。
- 功能优先级：精确产品源提交 → approved Pencil 与 Gate C → thin Clickable / 工具行为参考。

## Gate C 视觉 Source of Truth

- 2026-07-24 Dewens 明确批准产品级视觉进入“编辑校样 × 表达排练 × 纸墨套印”
  重构。当前产品表层构图、Token 和传播语言新增真源：
  `docs/plans/2026-07-24-editorial-rehearsal-redesign.md`。
- 该新增方向取代 Gate C 的通用卡片外观和产品级表层构图，但不取代其对象 IA、
  1440/1024 重排、可访问交互、语义状态与 S04 证据账本几何约束。
- Prototype Studio：维护者本机私有视觉来源，不随本仓公开
- Prototype Studio V4 来源：`c0b22b6da5ec447b856bbe5ddbf1f79a41eebdee`
- Gate C 最终批准归档：`b17852903c4c1f3c6f54993162bdd24e46209b9b`
- 批准稿：维护者本机私有归档；公开仓只保留下方不可变 SHA-256
- 批准稿 SHA-256：`22b48697dff698edd0eba257a2793787945e74abbeb0dd4cf84a5f4d0e6ceb0f`
- S04 以 approved Pencil 的句级共享行、精确划线、O 编号、单滚动上下文和证据全屏为准。

## 明确不继承

- 探索稿中的 A/B/C/A2 token 和未通过构图。
- 视觉稿里的用户身份与泛化分享能力不直接继承。2026-07-23 用户为开源传播
  新明确授权了受控 Demo、本地结果卡和纯净展示；这些是带独立隐私与证据边界
  的新增能力，不代表旧视觉稿中的分享设想自动进入产品范围。
- 专门异常态完整视觉批准、完整深色页面集、生产 Mode Pack 内容。
