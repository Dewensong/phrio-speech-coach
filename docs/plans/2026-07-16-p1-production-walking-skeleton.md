# P1 Production Walking Skeleton

## 目标

交付一个可在目标 Apple Silicon Mac 启动、测试和打包的真实桌面产品骨架。用户可选择产品经理试点任务、完成两次真实本地录音，并通过开发 Fixture 走完逐字稿确认、单焦点 Drill、前后对比、本地保存和历史回看。

## In Scope

1. 独立 Electron 产品仓、安全 BrowserWindow、窄 preload API 与 IPC sender/schema 校验。
2. A3 桌面壳、S00–S11 主路径、系统/浅/深主题 token，以及 S01/S06/S09 的 1024 重排规则。
3. 统一 Mode Pack Schema；三模式可展示/切换，产品经理试点任务贯通完整路径。
4. Session 状态机；初讲和复讲最多两个最终有效 Attempt。
5. 真实麦克风授权、MediaRecorder 采集、回放、重录、停止和 5 分钟上限。
6. 主进程 SQLite 持久化；私有临时音频 `0600`、原子写入、完成/重录/删除时清理。
7. 明确标注的开发 Fixture：固定逐字稿、E01–E03、结论先行 Drill 和 74 秒 → 42 秒比较。
8. 历史列表、删除级联和继续未完成 Session。
9. 单元/集成测试、类型检查、打包验证与代表性 1440/1024 视觉检查。

## Out of Scope

- 本地 ASR 引擎、模型下载/校验、真实低置信 Segment。
- 云端 AI、BYOK、Keychain、发送预览、同意记录和网络请求。
- 生产 Mode Pack 全量内容、专业语义等级、效果研究与发布承诺。
- 账号、云同步、收藏、社区、付费、遥测、自动更新、公证和正式分发。
- Gate C 未批准的完整异常态套件；P1 只实现功能可达且沿用 A3 语法的最小状态。

## 验收

- `pnpm verify` 通过，应用可在 macOS arm64 启动和打包。
- Renderer 无 Node 能力，sandbox/context isolation 启用；IPC sender 与输入均验证。
- 用户能完成两次真实录音；重录不会留下旧 Attempt 音频，Session 最多两个已确认 Attempt。
- 音频目标权限为 `0600`，写入采用临时名 + 原子重命名；删除/完成清理通过测试。
- Fixture 在所有相关界面明显标注“开发演示数据”，不声称分析了真实录音。
- S01/S06/S09 在 1440 和 1024 均保持 15–16px 工作正文，布局按批准规则重排。
- 不出现总分、雷达图、人格判断、红负绿胜或意外网络请求。

## 后续阶段

- P2：本地 ASR 与 AI-off 真实闭环。
- P3：本地确定性指标、AudioEvidence 与可信比较。
- P4：单一批准 provider 的 BYOK AI、发送预览、同意和证据校验。
