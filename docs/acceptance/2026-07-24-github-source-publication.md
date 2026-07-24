# 2026-07-24 GitHub 源码公开验收

## 结论

Phrio 源码已建立为公开 GitHub 仓库：
[`Dewensong/phrio-speech-coach`](https://github.com/Dewensong/phrio-speech-coach)。
公开历史从一个无父提交开始，旧提交邮箱、旧工作站路径、历史分支和旧 Worktree
引用均未推送。完整内部历史仍在维护者本机以离线 bundle 和本地只读分支双重保留。

本结论只授权和证明**源码公开**。它没有创建 tag / GitHub Release，没有发布
DMG 或 ZIP，没有使用 Developer ID / 公证凭据，也没有触发任何 OpenAI 调用或
上传转录文本。

## 历史隐私清理

清理前：

```text
internal final tip: 8c11dbb93e522ac3f33e4aa62d18e996700cdbae
public tree: 446d240638118f6ab9a7112446bc411ea755f460
```

清理采用“同一源码树、新建无父公共根”的方式，没有逐条改写旧提交：

```text
public root: 14dbf71b468c2b7ec3b156b34bae519df27881fa
parents: none
author: Song Dewen <GitHub noreply address>
subject: Initial public release: Phrio 0.1.0-alpha.0
```

- 公共根与内部最终 tip 的 Git tree 完全相同。
- 本地 `codex/internal-pre-public-main` 继续指向内部最终 tip，不参与远程推送。
- 完整内部历史 bundle 权限为 `0600`，位于公开仓库之外：
  `Projects/_backups/phrio/phrio-internal-history-2026-07-24-8c11dbb.bundle`。
- bundle 已通过 `git bundle verify`，包含 12 个当时有效引用；SHA-256：
  `08ff7e441fcbfe5716bfd57899beed70318c903a19e06a2dee184add32b3ad06`。
- 临时裸仓推送模拟只得到 `refs/heads/main`、1 个提交、0 个不可达对象。
- 最终 GitHub clean clone 只得到清洁 `main` 的 2 个提交；根提交没有父提交，
  两笔作者地址均为 GitHub noreply，`pnpm verify:open-source` 通过。

离线 bundle 属于敏感内部备份，不应上传到 GitHub、网盘公开链接或 CI Artifact。

### GitHub Web 合并身份回归与恢复

第一次 private staging 通过 CI 和 clean clone 后曾短暂切为 Public。随后一次
GitHub Web squash 没有沿用仓库本地的 noreply 配置，而是把维护者账号资料中的
联系邮箱写进新提交。发现后立即执行以下恢复：

1. 仓库退回 Private，停止传播和外观操作；
2. 原仓改名并保留为 Private 审计归档，不再作为产品远程真源；
3. 在本地从同一根、同一源码 tree 重新生成 noreply 提交；
4. 在原 `phrio-speech-coach` slug 创建新的空白 private 仓，只推清洁 `main`；
5. 对新仓重跑 GitHub CI、clean clone 和提交身份审计；
6. 只有新仓全部通过后才重新公开并恢复保护设置。

最终公开仓不包含第一次 staging 的 PR refs 或 GitHub 生成提交。未来使用 GitHub
Web merge 之前，维护者必须先在 GitHub 账号 Emails 设置中开启邮箱隐私，并启用
阻止暴露邮箱的命令行 push；在该账号级设置被人工确认前，不合并 Dependabot 或
其他 PR。文档不记录或复述本次暴露的具体邮箱值。

## GitHub 仓库边界

| 项目 | 当前状态 |
| --- | --- |
| Owner / slug | `Dewensong/phrio-speech-coach` |
| 可见性 | Public source |
| 默认分支 | `main` |
| 远程公开 refs | 仅公共历史中的 `main`；无旧分支或 tag |
| 合并方式 | squash only；合并后删除来源分支 |
| Actions 权限 | 默认 `contents: read`，不能批准 PR |
| `main` | 必须走 PR、必须通过 `verify-macos-arm64`、线性历史、禁止 force-push / 删除 |
| 安全 | Dependabot security updates、Secret scanning、Push protection、Private Vulnerability Reporting 已启用 |
| 公共候选环境 | `macos-release-candidate`，仅受保护分支并要求维护者审核 |
| Issues | 启用；隐私提示模板生效 |
| Wiki / Projects | 关闭 |
| 公共二进制 | 无 |

仓库描述和 Topics 明确聚焦 Chinese、deliberate practice、local-first、macOS、
Electron、speech coach、speech recognition、Sherpa-ONNX、OpenAI 和 TypeScript。
README 以真实打包版受控演示素材为主视觉，不用生成式假 UI 冒充产品证据。

## 名称预检

GitHub owner 下的 `phrio`、`phrio-speech` 和 `phrio-speech-coach` 在建仓前均未占用；
最终选择更可解释、更适合搜索的 `phrio-speech-coach`。公开网页预检同时发现
“Phrio”已被一家瑞典公司用于室内设计社区应用。二者品类不同，但这意味着
Phrio 仍只能视为产品工作名，本轮预检不是商标法律意见，也不等于品牌已清关。

在公开宣传、App Store、签名身份或付费分发前，应单独完成目标市场的名称、
域名、商标和应用商店检索；如果改名，代码中的 bundle ID、图标和历史资产需要
按迁移计划统一更新，不能只改 README。

## 自动化证据

GitHub-hosted Apple Silicon runner 对重建后清洁 `main` 的真实 push 运行：

```text
workflow: Phrio CI
run: 30067263075
job: verify-macos-arm64
result: success
duration: 1m56s
head: 33ad407ce4f4c2c8608d427cc848c0723c4f8dc6

locked dependency install: pass
open-source readiness: 264 tracked files, pass
test files: 59 passed, 1 skipped
tests: 596 passed, 1 skipped
Electron system network probe: pass
prevent-app-suspension acquire/release/no-leak: pass
macOS package: pass, 18 signed targets
packaged bridge: 40 methods
Renderer Node access: false
Renderer protocol: phrio-app:
Sherpa native dependency: 1.13.4, loaded
```

CI 生成一个 14 天自动过期的 ad-hoc Internal Alpha 证据 Artifact。上传 Artifact
摘要为
`sha256:fbbf2ecffcfe678c5a0129f59a175f2f07c8b1f5e7dc0ec131a33a1444fe257c`。
它明确标记为 automated evidence，不是 Developer ID 签名、公证或公开下载包。

这次 GitHub runner 的锁定安装与完整门通过，关闭了此前本机两个空 HOME 冷缓存
尝试未能在有界时间内完成 Electron 下载的远程 CI 边界；它不证明所有网络、
代理或目标 Mac 都会成功。

### 开仓后依赖告警与修复

首次推送后 GitHub 对默认分支报告 11 个 Dependabot 告警，全部位于开发/打包
依赖链：`@electron/rebuild` / `@electron/node-gyp` 间接使用的 `tar 6.2.1`、
Forge CLI 间接使用的 `tmp 0.0.33`，以及 Webpack schema 工具链中的
`fast-uri 3.1.3`。它们不是 Phrio Renderer / Main 运行时依赖，但 `tar` 会参与
原生模块重建与归档处理，不能仅以 devDependency 为由 dismiss。

同日官方 npm 全量审计比 GitHub 的初始导入更快，实际列出 14 个当时有效告警，
包括 1 critical、9 high、3 moderate、1 low。仓库使用最小 `pnpm.overrides`
提升到：

```text
tar: 7.5.19
tmp: 0.2.7
fast-uri: 3.1.4
```

随后结果：

```text
pnpm audit --audit-level low --registry=https://registry.npmjs.org
all dependencies: 0 known vulnerabilities

pnpm audit --prod --audit-level low --registry=https://registry.npmjs.org
production dependencies: 0 known vulnerabilities

pnpm verify
59 test files / 596 tests passed
system network and power-save-blocker probes passed
macOS package / 18 signed targets / 40-method bridge passed
Sherpa 1.13.4 smoke passed
```

`tar` 的跨主版本解析覆盖因此有完整打包证据，而不是只改 lockfile。审计是
2026-07-24 的时点结果；后续新公告仍由 Dependabot 和定期审计处理。

## 受控 Fixture 证据

本轮没有重新运行或升级 Electron visual / product tour 结论。README 使用的
三份素材仍来自真实打包应用中的受控 Demo：

```text
phrio-social-preview.png
sha256 f57cea392d574649ee4998793aa1fddaddca4fccf01e4767b5bf6084cd8f5857

phrio-hero.png
sha256 ed09ae518d8da5e675c6e0404bc54e04cd4e509757c921d55649b60d2d018f98

phrio-demo.gif
sha256 6614d67eed3a1214128a0e8a20694a36ecd51fa971b19697386d92eaefd15901
```

它们证明受控数据能在已打包 UI 中呈现完整方法，不证明真实麦克风、本地模型、
云服务或训练效果。最近的 85/85 visual、149/149 product tour 和 49 图仍以
[编辑校样式全产品终验](2026-07-24-editorial-rehearsal-final-acceptance.md)为准。

## 真实设备与服务证据

本轮没有：

- 请求或重置麦克风权限；
- 安装、重启或评价本地 ASR 模型；
- 进行设备拔插、休眠、长录音或目标 Mac 性能矩阵；
- 提供 OpenAI Key、批准任一云端用途或发送转录文本；
- 使用 Developer ID、notarization、stapling 或 Gatekeeper 外部正向路径。

2026-07-23 的真实麦克风停止收束和同包重启权限结果仍是历史真实设备证据，
不能因 GitHub CI 变绿而升级。真实 OpenAI 的三种用途继续各自要求独立明确同意。

## 当前建议

**继续 Internal Alpha，同时公开源码接受审阅和贡献。** 仓库首页、CI、隐私清洁
历史和贡献入口已经足以传播；普通用户可双击安装的公共 Mac 包仍等待品牌定名、
Developer ID、公证、目标 Mac 矩阵、本地模型质量和更广泛真实设备证据。
