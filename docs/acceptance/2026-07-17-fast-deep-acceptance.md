# Fast Loop + Deep Lane 验收记录

> 历史阶段记录：本文包含基于 QA fixture 与 jsdom 的阶段性结论，不能作为生产发布证明。当前逐项判定与发布结论以 [产品就绪度审计](2026-07-17-product-readiness-audit.md) 为准；总体状态为 **NOT READY / 功能性 Alpha**。

日期：2026-07-17

## 自动化

- `pnpm typecheck`
- `pnpm test`：14 个测试文件，82 项通过
- `pnpm package`：macOS arm64 成功
- `out/Phrio-darwin-arm64/Phrio.app/Contents/MacOS/Phrio --phrio-smoke-test`：16 个窄 bridge 方法、3 个 Mode、Renderer 无 Node process

覆盖 partial 替换/final 追加、重复/乱序/revision、final-only 九类标注、精确 span/O 映射、撤回历史、AI 防抖/去重/超时/迟到、报告非阻塞、尾句/快照、权限/ASR/AI/网络降级、SQLite 重开恢复与级联删除、Deep 纠正/唯一焦点/Drill/复讲/同口径比较、AI 三用途同意边界，以及普通/全屏复用同一证据状态和停止控件。

## 真实浏览器

可控 ASR 流只通过 `?qa=1` 用于验收，不进入生产录音路径。

本轮重新以 approved Pencil / Gate C 最终归档逐项校准 S04 和全局 IA。标准 1440 使用 240px 完整对象侧栏、390px 证据列与 104/94/112/150px 句段行；紧凑 1024 使用 approved 的 56px icon rail、300px 证据列与 98/84/112/154px 句段行；1440 证据全屏采用 490px 证据列与 96/86/108/148px 句段行。内容、O1–O4 生命周期、语义色、线型和当前建议也与批准稿对齐。

| 场景 | 结果 |
| --- | --- |
| 1440×960 标准 / 全屏 | 横向 overflow 0；共享行 top/bottom 差 0px |
| 1024×960 标准 / 全屏 | 横向 overflow 0；共享行 top/bottom 差 0px |
| 证据滚动区 | DOM 中恰好 1 个 `.evidence-ledger`，无第二证据 scroller |
| 全屏上下文 | 任务、录音/ASR/AI、当前提示、退出与结束录音均可见 |
| 语义锚点 | 进出前后保持相同可见 segment id；内容变短发生 clamp 时不伪造像素恢复 |
| Esc | 退出并将焦点恢复至证据全屏按钮 |
| 125% 页面缩放 | **历史方法无效，不计通过**：当时只修改根字号，像素主导布局没有真实缩放；当前结论为真实 Electron 125% 待验收 |
| reduced-motion | media query 生效；动画/transition 计算值 0.001ms |
| Console | 0 error，0 warning |
| 全局导航 | 标准宽度始终为同一对象 IA；S02、S10、S13 均只有 1 个 active/current |
| 历史入口 | 最近条目直达冻结单次记录；“全部”进入记录集合；1024 compact 回退高亮“练习记录” |
| 模式与任务 | 模式只在工作区切换；segmented、任务行和右侧条件同步更新 |

全屏网格的列标题、当前建议与账本分别固定在独立网格行；工具按钮脱离网格流，因此不会再挤占标题行或把当前建议拉伸成大块留白。普通与全屏的右栏宽度分别实测为 390px / 490px（1440），紧凑标准为 300px（1024）。

动效映射：partial 使用低频光标呼吸；final 句段轻微落定；精确划线淡入；右栏记录短距离到达；尾句 capsule 轻微上收；降级条仅淡入。`prefers-reduced-motion` 将上述动画和 transition 压缩至 0.001ms，应用内“减少动效”设置压缩至 0.01ms；二者都关闭平滑滚动，且不隐藏任何状态或操作。

已进入当前稳定审计提交的四张 100% 截图：

- [1440 标准](assets/2026-07-17-readiness/phrio-1440-standard.png)
- [1440 证据全屏](assets/2026-07-17-readiness/phrio-1440-fullscreen.png)
- [1024 标准](assets/2026-07-17-readiness/phrio-1024-standard.png)
- [1024 证据全屏](assets/2026-07-17-readiness/phrio-1024-fullscreen.png)

以下为旧阶段未纳入稳定提交的本机历史路径，不作为当前可移植证据：

- `output/playwright/sidebar-task-library-1440.png`
- `output/playwright/sidebar-task-library-1024.png`
- `output/playwright/practice-history-1440.png`
- `output/playwright/practice-record-detail-1440.png`
- `output/playwright/practice-record-detail-1024.png`

## 真实设备 / 服务手工清单

1. 在 macOS 隐私设置允许麦克风；确认首次授权、拒绝和再次开启均有明确状态。
2. 将匹配的 Sherpa streaming Paraformer 模型放入 README 所述 userData 目录；核验连续语音 partial、停顿 endpoint final、停止后的尾句 flush。
3. 断网/恢复、移动模型或中断 ASR；确认录音继续、ASR 显示降级且可重连。
4. 用冻结 provider/model 的测试凭据接入 `LiveHintTransport` / Deep transport；逐项核验 live 配置同意 + Attempt AI ON，以及 Deep/comparison payload 预览、批准、撤回、超时与迟到丢弃。
5. 完成初讲 → Deep 纠正 → 唯一焦点 → Drill → 同题复讲 → 同口径比较；重启应用后再次读取冻结 artifacts。
6. 检查 userData 音频权限与清理策略；确认未授权时请求元数据 `rawAudioIncluded=false`。

## 外部依赖与未宣称项

- Git 不包含 ASR 模型权重；不同模型的准确率、端点延迟和内存需在目标设备实测。
- 产品源未冻结云端 AI provider/model/凭据；当前实现完成安全接口、状态机和可控 mock 验证，不宣称真实云端提示或诊断已上线。
- 没有产品源数值预算，因此不伪造延迟、准确率或训练效果达标数字。
