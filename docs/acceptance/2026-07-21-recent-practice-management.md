# 2026-07-21 最近练习命名与记录管理验收

## 结论

左侧“最近练习”和完整“练习记录”页现在共用同一份 SQLite Session 投影。记录默认名称来自初讲冻结快照的第一句话，模式作为独立标签展示；用户可以重命名、置顶、取消置顶和二次确认删除。1024px 紧凑侧栏隐藏最近列表时，完整记录页继续提供同一组操作。

本轮同时封闭了一个不能只靠 UI 解决的竞态：用户丢弃或重录后，旧 take 的迟到快照或音频不能重新写回自动标题或孤儿产物。

## 记录身份与优先级

显示名称采用固定优先级：

```text
用户重命名
   ↓ 无
初讲冻结快照的第一句话
   ↓ 无
冻结任务标题兜底
```

- 自动名称只读取 `kind=initial` 的已校验 `AttemptSnapshot`，先按 final segment `sequence` 排序，再做中英文句界识别与 Unicode 安全截断。
- partial、复讲、逐字稿纠正、实时提示、Deep report 和 comparison 都没有改名权限。
- `recordTitleSource` 明确区分 `first_final` 与 `user`。用户重命名后，快照重试、重录和迟到结果都不得覆盖它。
- 丢弃初讲时只清除自动名称；用户名称继续保留。新初讲冻结后可生成新的自动名称。

## 持久化与竞态边界

SQLite schema v8 新增：

- `practice_sessions.record_title`
- `practice_sessions.record_title_source`
- `practice_sessions.pinned_at`
- `discarded_attempts(session_id, attempt_id, kind, discarded_at)`

关键事务边界：

- 初讲快照 artifact 与自动首句名称同事务写入，artifact 失败时名称一起回滚。
- 丢弃/替换 Attempt、删除对应 artifact、清自动名称和写 Attempt 墓碑同事务完成。
- 墓碑在 Session 删除时通过外键级联清理；在 Session 存续期间，旧 snapshot 和旧 audio 即使迟到或在重启后重放也会被拒绝。
- 用户重命名和置顶是窄列更新；普通 Session 图更新不会写这三列，避免异步录音保存用旧对象覆盖新元数据。
- `pinned_at` 与练习活动时间分离。置顶项按置顶时间排在前面；取消置顶后恢复原 `updated_at` 活动顺序。
- v7 → v8 会对仍无记录名称的旧 Session 从初讲冻结快照回填；已回填记录不再参与启动扫描。

## 交互与无障碍

- 最近练习行将第一句话、模式标签和置顶图标分层展示；模式使用独立、随主题变化的低饱和标签 token，不借用成功/警告状态色。
- 点击名称进入冻结的单次练习详情；点击“全部”或全局“练习记录”进入完整集合。
- 更多菜单真实调用主进程命令，不是静态按钮。删除必须二次确认，并删除该 Session 的逐字稿、证据、报告、比较与本机音频。
- 置顶和取消置顶先用主进程返回的 Session 立即更新图标与顺序，再异步刷新列表；刷新失败不会把已成功动作显示成未生效，动作失败在 S10 和普通练习页都有可见反馈。
- 菜单支持 ArrowDown 打开首项、ArrowUp 打开末项、Home/End、循环方向键、Tab/Shift+Tab 离开并关闭、Esc 回到触发按钮；滚动或调整窗口也会关闭并回焦。
- Portal 菜单显式继承 90% / 100% / 112.5% / 125% 应用缩放，定位计算同时使用缩放后的宽高；1024×960、125% 下完整落在 viewport 内且横向 overflow 为 0。
- 视觉模式标签同时有文字；最近练习按钮通过 accessible description 暴露模式与“已置顶”，不只依赖颜色或图标。

## 自动化覆盖

- 中文、英文、中英混合、引号、乱序 final、空文本和 emoji/超长标题提取。
- 初讲首句命名；复讲不能覆盖；用户重命名跨快照重试和重录保留。
- 自动名称随有效重录更新；artifact 写失败时名称回滚。
- discard 后迟到 snapshot 与 audio 被墓碑拒绝；新旧 snapshot 交错时旧标题不能复活。
- stale Session graph 不能覆盖记录名称或置顶状态。
- pin 幂等、置顶排序、取消后恢复活动顺序、重启持久化。
- v7 → v8 回填、索引与 schema 恢复。
- Sidebar / S10 的模式标签、真实命令、重命名校验、删除确认、键盘焦点和 compact 入口。

最终门禁：

```text
pnpm typecheck
pnpm test
pnpm verify
pnpm verify:electron-visual
pnpm verify:electron-product-tour
```

- TypeScript：通过。
- 单元/集成/E2E：56 个测试文件通过、1 个跳过；585 项通过、1 项跳过。
- `pnpm verify`：系统网络、安装期 power blocker、macOS arm64 package、18 个签名目标、40 方法 packaged bridge、Sherpa `1.13.4` smoke 全通过。
- Electron visual：85/85，9 张截图。
- Electron product tour：110/110，30 张截图；production console 0 error / 0 warning，外部 HTTP(S) 请求 0。

关键证据：

- `output/playwright/electron-product-tour/product-09-recent-record-managed-1440x960.png`
- `output/playwright/electron-product-tour/product-10-history-all-1440x960.png`
- `output/playwright/electron-product-tour/product-10b-history-actions-1024x960.png`
- `output/playwright/electron-product-tour/product-10d-history-menu-1024x960-text125.png`
- `output/playwright/electron-product-tour/qa-11-s10-completed-history-1440x960.png`

## 诚实边界

自动化使用隔离 `userData` 和受控 ASR/音频事件，证明记录身份、持久化、排序、重载、操作命令和布局边界。真实设备上的首句内容仍取决于生产 Sherpa final 质量；本轮没有据此宣称新的转写准确率或延迟指标。正式体验时若名称不符合实际说出的第一句话，应同时导出诊断日志并记录时间点，以区分 ASR final 内容问题与记录投影问题。
