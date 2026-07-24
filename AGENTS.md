# AI 协作规则

## 项目进入

依次读取 `README.md`、`context.md`、`progress.md`、`decisions.md` 和 `docs/adr/0001-desktop-foundation.md`。任何视觉实现都要核对 `docs/source-baseline.md`。

## 项目类型

这是代码型桌面产品。遵循以下单向依赖：

- 前端：Page → Component → Hook/Service。
- 桌面主进程：Controller（IPC 翻译）→ Service（业务规则）→ Repository（SQLite/文件系统）。
- 共享层：纯类型、Schema、常量、Fixture；不得依赖 Electron 或 React。
- Renderer 不得直接访问 Node.js、文件系统、SQLite 或密钥。
- Preload 只暴露按用例命名的窄 API，不暴露 `ipcRenderer`。

## 产品边界

- 当前阶段是 Fast Loop + Deep Lane Production Alpha，不是 V0.1 发布候选。
- 录音、回放、本地持久化和删除必须是真实能力。
- 本地转写必须经窄 IPC 进入主进程 ASR；模型缺失时明确降级，不得冒充成功。
- 云端 AI 只允许经可注入 transport；`live_hint` 需配置级同意且每次练习 AI ON，Deep 与 comparison 逐 payload 批准。
- 不输出总分、雷达图、人格判断、红负绿胜或职业标签。

## 数据与安全

- 音频只在用户主动录音时采集；临时文件权限目标为 `0600`，采用临时名写入后原子重命名。
- Renderer 保持 sandbox、context isolation 和 `nodeIntegration: false`。
- IPC 输入必须用共享 Zod Schema 校验，且校验 sender 来源。
- 日志不得包含音频、完整逐字稿、密钥或未来云端请求正文。
- 禁止提交真实录音、用户数据、API Key 和 `.env`。

## 视觉基线

- Gate C 基线是 V4 `c0b22b6da5ec447b856bbe5ddbf1f79a41eebdee`、最终归档 `b17852903c4c1f3c6f54993162bdd24e46209b9b` 与批准 `.pen` SHA-256 `22b48697dff698edd0eba257a2793787945e74abbeb0dd4cf84a5f4d0e6ceb0f`。
- 只实现 A3 token 与布局，不导入探索期 A/B/C/A2 token。
- 1440：240px 侧栏、52px 命令栏、42px 阶段轨、320–336px 检查器。
- 1024 必须重排而非缩放；正文保持 15–16px。

## 收尾

完成后更新 `progress.md`；架构或范围变化同步更新 `decisions.md` 和 ADR。先运行 `pnpm verify`，不要在未验证时宣称完成。
