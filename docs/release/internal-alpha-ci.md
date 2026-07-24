# Internal Alpha CI 与实现真源

## 当前结论

Phrio 已具备一条最小 macOS Apple Silicon CI，以及一条凭据门控、只生成短期
制品的手动公共候选流水线；尚未生成或发布 Developer ID 候选包。

- 工作流：`.github/workflows/ci.yml`
- 必需检查名：`verify-macos-arm64`
- 固定工具链：macOS 15 arm64、Node `24.18.0`、pnpm `10.33.2`
- 依赖来源：CI 的 Electron 二进制显式使用官方 GitHub Release；不继承本机镜像
- 自动门禁：`pnpm verify`
- 内部制品：仅在 `main` push 或手动触发时保留 14 天
- 发布身份：完整 ad-hoc 签名；不是 Developer ID，不做 notarization
- 凭据边界：工作流不引用 GitHub Secrets，不提供 OpenAI Key，不发送转录文本

公共候选轨：

- 工作流：`.github/workflows/release-candidate.yml`
- 触发：仅 `workflow_dispatch`
- 工具链：同样固定 macOS 15 arm64、Node `24.18.0`、pnpm `10.33.2`
- 前置门：仍先完整执行 `pnpm verify`
- 发布身份：Developer ID Application + hardened runtime
- 公证：App 与 DMG 分别 notarize 并 staple
- 复验：codesign、Team ID、Gatekeeper、最小权限、license resources、
  notarization ticket、DMG/ZIP 与 SHA-256
- 权限：`contents: read`；不能创建 tag、GitHub Release、commit、merge 或发布
- 凭据作用域：使用 `macos-release-candidate` Environment；原始证书和 API Key
  只进入确认、导入或公证步骤；依赖安装与 `pnpm verify` 在证书和 `.p8` 落地前
  已经完成
- 真源门：非 `main` 的手动 dispatch 会立即失败
- 制品：只保留 14 天的 workflow artifact

仓库当前没有 remote，所以上述两个工作流在本地都只是已验证配置；只有 Dewens
明确选择远程仓并推送后才会真正运行。公共候选轨还需要真实 Apple Developer
证书与公证凭据。本地主真源已经是 `main`；本轮没有配置 remote、创建 GitHub
Release 或发布制品。

## 公共候选不是自动发布

公共候选轨解决的是“同一提交能否做出可被 Gatekeeper 接受且带公证票据的
DMG/ZIP”，不解决是否应该公开。它缺少写仓权限，也不接受发布开关。详细凭据、
真实目标 Mac 与人工出版门见
[Public macOS distribution](public-macos-distribution.md)。

本机无 Developer ID 凭据，因此当前只验证了：

- 缺少公证凭据时 `PHRIO_RELEASE_SIGNING=1` 必须立即失败；
- ad-hoc `pnpm make` 可实际生成 DMG 与 ZIP；
- DMG 使用仓库内确定性品牌背景，并在真实 Finder 中确认只有
  `Phrio.app` 与 `Applications` 两个安装对象；
- 当前内部包继续被公共候选 gate 拒绝，不能冒充 Developer ID；
- 公共工作流与 gate 的正向路径仍等待真实 Apple 凭据和 GitHub runner 证据。

## 三类证据必须分开

### 自动化证据

CI 执行 `pnpm verify`，证明本次提交通过：

- TypeScript 类型检查；
- 单元与集成测试；
- Electron 系统网络与安装期防休眠探针；
- macOS 打包、deep/strict codesign、权限与 fuse 门；
- packaged preload bridge 与 Sherpa 原生依赖 smoke。

push 或手动运行还会生成：

- `Phrio-<version>-<commit>-macOS-arm64-ad-hoc.zip`
- 同名 `.sha256`
- `Phrio-<version>-<commit>-ci-evidence.json`

JSON 冻结提交、运行链接、工具链、Bundle 身份、签名口径、制品大小与 SHA-256。
证据脚本只有在工作流前一步 `pnpm verify` 成功并传入门标记后才会运行；CI
同时拒绝脏工作树。这提供可追溯性，不等同于跨机器 bit-for-bit 可复现构建。

### 受控 Fixture 证据

`pnpm verify:electron-visual` 与 `pnpm verify:electron-product-tour` 使用隔离
`userData` 和受控事件验证真实 Electron/IPC/SQLite 页面闭环。为控制 CI 时长与
避免把 Fixture 冒充设备证据，它们不属于当前最小 CI 的必需检查；需要在重大
交互变化或候选晋级前单独运行并归档报告。

### 真实设备证据

以下项目只能按验收清单由真人在目标 Mac 上完成，CI 不标记通过：

- 模型首次安装、退出重启与本地识别质量；
- 真实麦克风、partial/final、停止收束与设备中断；
- 自由复讲、焦点 Drill、同题复讲、比较与诊断导出；
- 目标 Mac 性能、休眠与长时间稳定性；
- 经独立同意的真实 OpenAI 调用。

真实 OpenAI 调用继续保持独立同意边界。CI 不读取本机 Key，不配置 provider
凭据，也不发送真实或 Fixture 转录文本。

## 实现仓主真源

2026-07-24 的本地收口结果：

- 当前主真源：`main`
- 建立基点：`cd4e33bf0939314fa85f46b500c48d1c705688ca`
- 验收回退引用：`codex/record-result-evidence-views`，建立 `main` 时与基点同点
- 旧根目录分支：`codex/phase-1-foundation`，提交
  `5f33f6912402a7ed48c99aa5cec97bfb6c0e5c1e`
- 拓扑关系：旧根目录提交是 `main` 建立基点的祖先，不是当前实现
- remote：无

本机目录名不是 Git 真源身份。remote 建立前以本仓 `main` 为实现真源；不要从
旧根目录重新拣选、复制或制作发布包。

## 安全确立远程主真源

以下步骤是后续启用清单，不在本轮自动执行：

1. 记录精确 `main` tip，确认工作树干净，并可选生成离线 `git bundle`。
2. 决定公开历史策略：完整历史会保留维护者提交邮箱和旧工作站路径；若不接受，
   必须在配置 remote 前单独设计隐私清理，不能临时改写已推送历史。
3. 选择一个空的私有远程仓；不要使用带初始化提交的远程覆盖本地历史。
4. 经明确授权后配置 remote，只推送 `main`，并把它设为默认分支。
5. 等待 `verify-macos-arm64` 在远程真实通过，核对证据 JSON 中的 commit 与
   目标提交完全一致。
6. 为 `main` 启用禁止 force-push / 删除、要求 PR、要求对话解决、要求分支最新
   和 `verify-macos-arm64` 的保护规则。
7. 从零 clone 远程并重跑开源门与关键启动检查；旧 Worktree 继续作为历史检查点，
   不承担构建和发布入口。

完整 GitHub 设置、隐私和 clean-clone 清单见
[GitHub 源码发布检查](github-open-source-readiness.md)。

产品图标、DMG maker、hardened entitlements、notarization 配置与只读候选
workflow 已进入仓库，但只有在 Developer ID 正向执行、数字 build version、
升级/迁移与真实设备矩阵关闭后，才能把候选制品晋级为“可分享包”。当前内部
artifact 名称和证据文件会持续明确标注 `ad-hoc`。
