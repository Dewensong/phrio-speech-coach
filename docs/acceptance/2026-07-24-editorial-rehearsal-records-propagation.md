# 2026-07-24 本地档案与传播校样验收

## 结论

Phrio 全产品体验改造的第四阶段已完成：

- 练习记录改为带本地编号的档案索引，搜索、模式筛选、重命名、置顶、取消置顶、
  删除确认和 1024 紧凑管理入口保持不变；
- 单次记录改为 Session 卷宗封面，诊断 / 实时证据双视图、导出、删除、恢复、
  再练同题和底部状态继续使用原业务对象；
- 常规与隐私、外观、练习设置改为设备账册 / 排版台 / 排练规则，模型、麦克风、
  诊断日志、AI Key/用途/同意、本地数据和危险操作语义未改；
- 30 秒受控 Demo 改为明确编号的 Fixture 校样册，三阶段与真实产品的稿纸、
  诊断版和双页比较语言一致；
- 真正导出的 PNG / SVG 结果卡改为 `RESULT PROOF` 编辑海报，使用硬边、双线、
  版次和套印标记；三比例、证据 opt-in、完整逐字稿禁止导出和本地保存边界不变；
- README Hero、Demo GIF 和 GitHub social preview 已从同一个通过门禁的真实
  打包版重新生成。

本轮没有建立第二套记录、设置、Demo 或分享数据。Goal 继续 active；最后阶段是
全产品主题、90% / 112.5%、键盘路径、真实设备边界和主真源建议的终验。

## 当前真源

```text
worktree: current product worktree
branch: codex/record-result-evidence-views
starting tip: 462059d
records/settings commit: 474a537
demo/result-proof commit: 8f8a655ef4ddb5ace2d89d81c1528d31a06ce0af
remote: none
```

未修改旧根目录实现、控制仓或 Prototype Studio；未配置 remote、未合并、未发布。

## 功能保全

### 记录与单次卷宗

- `HistoryPage` 仍只读取 `HistoryItemView`；编号是当前过滤结果的展示序号，不写回
  Session，也不改变标题、排序或 pinnedAt。
- 每行仍保留同一个打开按钮和 `PracticeRecordActionsMenu`；自动标题、自定义标题、
  模式标签、焦点、结果、引导来源和音频状态未删。
- `PracticeRecordDetailPage` 仍由同一个冻结 Session / artifact graph 派生；
  `SESSION FILE · LOCAL` 只是一枚可读卷宗标签。
- 诊断 / 实时证据 tab、定位原句、初讲/复讲录音、云端历史、比较、版本快照、
  分享、文本导出、删除、继续和再练原题都保持原路径。

### 设置与隐私

- 卡片编号由 CSS counter 产生，不是新的持久化数据。
- 麦克风只在用户点击检查或主动录音后请求；模型安装/续传/取消和防休眠租约不变。
- 诊断日志刷新、打开目录、导出和清除仍走原 bridge；日志不新增音频、逐字稿、
  Key 或云请求正文。
- OpenAI Key、用途开关、`live_hint` 配置同意、Deep / comparison exact payload
  同意保持独立；视觉分组不产生任何隐式批准。
- 清除训练数据、删除 Key、恢复偏好仍使用原确认对话框和失败重试，不因账册化而
  弱化危险程度。

### 受控 Demo 与结果卡

- Demo 继续使用固定内存文本，不请求麦克风、不安装模型、不创建 Session、不调用
  OpenAI；`FIXTURE EDITION · 01` 让边界在每一阶段持续可见。
- 结果卡仍只读取标题、一句话结论、唯一焦点、成功条件、可选比较和用户主动选择的
  一条正式证据。完整逐字稿没有进入 renderer/export schema。
- evidence 默认关闭；16:10 / 1:1 / 9:16、PNG / SVG / Markdown 和纯净展示仍由
  用户显式触发。Phrio 不创建公开链接、不自动上传。

## 自动化证据

执行：

```bash
pnpm typecheck
pnpm exec vitest run \
  tests/e2e/settings-environment.test.tsx \
  tests/e2e/diagnostics-settings.test.tsx \
  tests/e2e/practice-record-audio.test.tsx \
  tests/e2e/record-result-evidence-views.test.tsx \
  tests/integration/practice-record-management.test.ts \
  tests/e2e/propagation-experience.test.tsx
pnpm verify
```

结果：

- 记录/设置定向：5 个文件 / 31 项通过。
- 传播定向：1 个文件 / 4 项通过。
- 完整测试：59 个测试文件通过、1 个跳过；596 项通过、1 项跳过。
- Electron 系统网络和安装期防休眠探针通过。
- macOS arm64 package gate 通过，18 个签名目标有效。
- packaged bridge 仍为 40 个窄方法，Renderer 无 Node，协议仍为 `phrio-app:`。
- Sherpa `1.13.4` 原生依赖 smoke 通过。

结果卡测试覆盖三比例内容区不越界、中文行首标点保护、三块区段、证据默认脱敏、
完整逐字稿禁入、硬边 `rx="0"`、三条套印区段线和 Markdown 边界。

## 受控 Fixture 与真实 Electron 证据

执行：

```bash
pnpm verify:electron-visual
node scripts/verify-electron-product-tour.mjs --skip-package
node scripts/capture-propagation-assets.mjs --skip-package
```

结果：

- Electron visual：85/85，9 张图。
- Electron product tour：140/140，46 张图。
- 记录页覆盖 1440×960、1024×960、125% 下档案编号、管理菜单、重命名、置顶 /
  取消置顶、删除双确认和 0 横向 overflow。
- 单次卷宗覆盖诊断 / 实时证据双视图、完整诊断层级、分享入口和冻结对象。
- 设置覆盖设备账册、诊断日志真实 JSONL、清除、危险操作确认和 1024 布局。
- Demo 覆盖三张校样页、`FIXTURE EDITION`、单一 criterion、无总分和 1024 布局。
- 分享覆盖三比例、三格式、证据默认关闭、导出 SVG 内容检查和纯净展示。
- production console 0 error / 0 warning；产品轨与 QA 轨外部 HTTP(S) 请求 0。

传播资产采集使用真实打包 Electron 和隔离空 `userData`：

```text
microphone requested: false
model installed: false
practice record created: false
external request count: 0
renderer error count: 0
```

生成物：

```text
phrio-hero.png           ed09ae518d8da5e675c6e0404bc54e04cd4e509757c921d55649b60d2d018f98
phrio-demo.gif           6614d67eed3a1214128a0e8a20694a36ecd51fa971b19697386d92eaefd15901
phrio-social-preview.png f57cea392d574649ee4998793aa1fddaddca4fccf01e4767b5bf6084cd8f5857
```

这些证明受控内容在真实候选包中的呈现、持久化隔离与无外部请求，不证明真实录音、
本地模型质量、OpenAI 质量或传播转化率。

## 真实设备证据

本阶段没有发起新的真实设备验收：

- 没有请求麦克风权限；
- 没有安装或评价真实本地模型；
- 没有拔出设备、休眠唤醒或做长录音；
- 没有提供 OpenAI Key，没有发送任何转录文本；
- 没有做 Developer ID、公证、stapling 或目标 Mac Gatekeeper 正向路径。

2026-07-23 的真实麦克风停止收束与同包重启权限证据仍是有效历史证据，但不能替代
最终全产品改造后的真实设备回归。

## 诚实边界与下一步

尚未关闭：

- 90% / 112.5% 全产品代表页、深浅主题完整代表页和键盘路径终验；
- 真实设备切换/中断/恢复、模型中文质量、目标 Mac 性能；
- 用户独立授权后的三种真实 OpenAI 用途；
- Developer ID、公证、Gatekeeper 与升级 TCC 连续性；
- 在没有 remote / main 的前提下安全确立产品仓主真源。

当前建议仍是 **继续 Internal Alpha**，不建立可分享公共包。
