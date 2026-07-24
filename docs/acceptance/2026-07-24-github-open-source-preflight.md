# 2026-07-24 GitHub 开源预检

## 结论

Phrio 当前 `main` 的**源码树已经达到创建空白私有 GitHub 仓并验证远程 CI 的
候选状态**。本轮没有配置 remote、推送、改写历史、切换仓库可见性、创建 tag /
Release，或发布 Mac 安装包。

还不能直接宣称“GitHub 已可公开”：

1. 完整 Git 历史包含维护者提交邮箱和旧工作站路径，必须先明确接受完整历史，
   或单独批准带离线备份的历史隐私清理；
2. 尚未选择 GitHub owner / slug，也没有在真实远程执行 Actions、分支保护和
   clean clone；
3. `Phrio` 仍是工作名，公开可见前还需独立完成名称与品牌可用性判断；
4. 公共 Mac 包继续等待 Developer ID、公证、目标 Mac 和真实设备矩阵。

## 当前真源

```text
branch: main
main establishment base: cd4e33bf0939314fa85f46b500c48d1c705688ca
historical acceptance ref: codex/record-result-evidence-views
remote: none
version: 0.1.0-alpha.0
bundle id: com.phrio.desktop
binary signature boundary: ad hoc
```

建立 `main` 时，两条分支引用同一提交，没有旧分支合并或合并提交。后续开源安全
改动直接发生在 `main`；历史根 Worktree 与 fast-deep Worktree 没有被修改。

## 本轮最小改造

### 可重复开源门

新增 `pnpm verify:open-source` 并并入 `pnpm verify`。它检查当前跟踪树：

- README、MIT License、贡献/行为/安全政策、第三方声明、Issue/PR 模板、
  Dependabot、CI、候选发布和开源清单是否齐全；
- 不跟踪 `.env`、Apple 凭据、真实音频、SQLite、模型权重、DMG/ZIP 和构建目录；
- 不包含高置信私钥、GitHub/AWS/Slack/OpenAI 凭据或工作站绝对路径；
- `.npmrc` 只保留已验的 `node-linker=hoisted` 与 `loglevel=error`，避免原生
  build tool 展开父进程环境，同时拒绝任何 registry / mirror / auth 配置；
- `package.json` 保持 npm publish 禁用并声明 MIT；
- Actions 使用完整 commit SHA，checkout 不保留凭据；
- Internal Alpha CI 不读取 Secrets；
- 公共候选轨只允许手动运行、拒绝非 `main`、只有 `contents: read`、不能发布，
  且 Apple Secrets 不处于 job 全局环境。

测试中的 API Key 字符串已改为明确非生产格式。唯一需要验证 `sk-` 脱敏规则的
单测在运行时拼接测试值，使源码扫描器不会把 Fixture 冒充真实 Secret。

### GitHub workflow 收紧

- CI push 只跟踪 `main`；PR 继续执行同一门。
- 两条 workflow 的 checkout 均设置 `persist-credentials: false`。
- 公共候选使用 `macos-release-candidate` Environment。
- evidence label 只接受 1–64 位字母、数字、点、下划线或连字符。
- 原始 P12、密码和 P8 只进入凭据确认/导入步骤；依赖安装和 `pnpm verify` 不读取。
- 依赖安装与 `pnpm verify` 在导入签名身份、写出 `.p8` 临时文件之前完成。
- 签名与公证步骤只获得它们实际需要的 identity、API key path / ID / issuer。
- Dependabot 新增 GitHub Actions 更新。
- 关闭 blank Issue，减少用户绕过隐私提示直接粘贴录音、逐字稿或凭据的风险。

## 自动化证据

### 当前树门

```text
pnpm verify:open-source
260 tracked files checked
result: pass
```

这只证明当前树，不声称历史已清洗。

### 定向回归

```text
TypeScript: pass
8 affected test files: pass
92 affected tests: pass
workflow / Dependabot / Issue YAML syntax: pass
```

### 完整生产门

最终状态前曾真实出现一次门失败：系统网络探针已经输出
`redirectStatus=302`、`rangeStatus=206`、`streamedBytes=4`，但用于测试的本地
HTTP server 在 `finally` 等待残余连接关闭，触发 10 秒外层 timeout。它不表示
生产网络请求失败，但属于 CI 终止性 P1。修复仅作用于探针收尾：先关闭 idle
连接，250 ms 后关闭残余本地连接；生产 `electron net` Service 未改。修复后
该探针连续 20/20 次通过，随后最终完整门通过。

```text
pnpm verify
59 test files passed, 1 skipped
596 tests passed, 1 skipped
Electron system network probe: pass
prevent-app-suspension acquire/release/no-leak: pass
macOS arm64 package: pass
signed targets: 18
packaged bridge methods: 40
Renderer Node access: false
Renderer protocol: phrio-app:
Sherpa native dependency: 1.13.4, loaded
```

### 依赖与许可证

使用命令级官方 npm registry 覆盖执行生产依赖审计，避免本机镜像不实现 audit
接口造成假阴性：

```text
pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org
result at 2026-07-24: no known vulnerabilities
```

这是时点结果，不是永久安全保证。`pnpm licenses list --prod --json` 的生产依赖
许可证集合为 MIT、ISC、Apache-2.0，与 `THIRD_PARTY_NOTICES.md` 当前清单一致。

### 当前树与历史只读审计

- 当前没有跟踪 `.env`、P8/P12、真实音频、SQLite、ONNX、DMG 或 ZIP。
- 当前树高置信 Secret 扫描没有剩余命中。
- 历史文件路径未发现音频、数据库、模型权重或 Apple 凭据扩展名。
- 历史最大 blob 小于 300 KiB；没有发现大模型或录音对象。
- 完整历史仍包含维护者提交邮箱和旧工作站路径，因此没有标记为 privacy-clean。

### 安装日志安全

第一次本地 clean-clone 安装真实暴露：DMG 原生依赖的 `node-gyp` 详细日志会把
继承的父环境展开到命令输出。验证随即停止；值没有写入仓库，Phrio 也没有读取
或发送它们。项目根 `.npmrc` 现在保留 `node-linker=hoisted` 并固定
`loglevel=error`；旧的仓库级第三方 Electron mirror 强制已移除，开源门同时
证明该文件不含 registry、mirror 或认证配置。clean-clone 复验必须再使用最小
净化环境并显式使用官方 Electron Release，防止任何第三方安装脚本获得与构建
无关的凭据。

最终对提交 `6405179a9e55af2ff782dbf90bc7b8d3ff5d1e3d` 建立新的干净源码克隆，
通过 `env -i` 只保留构建所需 HOME / PATH / TMPDIR / locale / CI 和命令级官方
npm / Electron 来源。该轮复用本机已验缓存：

```text
locked pnpm install: pass
fixture secret sentinel absent from install log: pass
pnpm verify: pass
59 test files / 596 tests: pass
package / 18 signatures / 40-method bridge / Sherpa smoke: pass
```

另两次使用独立空 HOME 的冷缓存尝试分别指定官方 Electron Release 和命令级本机
镜像，都没有在有界等待窗口内完成 Electron 下载，已主动终止，不能记录为通过。
因此这里证明“干净源码克隆 + 净化环境 + 已验缓存”，不证明 GitHub runner 的
从零官方下载；后者仍是配置 remote 后的真实 CI 门。

## 受控 Fixture 证据

本轮没有改 UI 或产品行为，也没有重新运行 Electron visual / product tour，
因此不新增受控 Fixture 通过声明。最近的 85/85 visual、149/149 product tour
和 49 图仍以
[编辑校样式全产品终验](2026-07-24-editorial-rehearsal-final-acceptance.md)
为准；这些证据不因仓库 workflow 改动自动升级。

## 真实设备与服务证据

本轮没有：

- 请求或重置麦克风权限；
- 安装、重启或评价本地 ASR 模型；
- 做设备拔插、休眠、长录音或目标 Mac 性能；
- 提供 OpenAI Key、批准任何云端用途或发送转录文本；
- 使用 Developer ID、notarization、stapling 或 Gatekeeper 外部正向路径。

2026-07-23 的真实麦克风与同包重启结果仍是历史核心链证据，不是本轮新增结果。
三种真实 OpenAI 用途继续分别要求独立明确同意。

## 下一门

推荐顺序：

1. 先决定“完整历史公开”还是“另行历史隐私清理”；
2. 选择最终 GitHub owner / slug，并创建**空白私有仓库**；
3. 经单独授权配置 `origin`，只推送 `main`；
4. 启用 `verify-macos-arm64`、分支保护、Secret scanning、Private Vulnerability
   Reporting 和 `macos-release-candidate` Environment 审核；
5. 核对远程 SHA / CI evidence，再从零 clone 并运行开源门，且由远程 runner
   关闭本机空 HOME 未完成的官方 Electron 冷下载边界；
6. 只有这些通过后再决定公开源码；公共 Mac 包继续走独立发布门。

完整设置清单见
[GitHub source-release readiness](../release/github-open-source-readiness.md)。
