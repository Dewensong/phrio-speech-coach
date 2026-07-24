# 项目背景

## 目标

独立实现一个由 Dewens 定义和维护的中文表达训练产品。核心价值是完成“初讲—证据—单焦点 Drill—复讲—对比”的练习闭环，而不是生成综合评分或长报告。

## 当前约束

- macOS Apple Silicon 优先，本地数据、无账号、无自有后端。
- Internal Alpha 已接 Sherpa-ONNX 本地 ASR，并提供受独立同意边界约束的可选 OpenAI 实时提示、深度诊断与比较；本地 Fast/Deep 闭环不能依赖云端成功。
- 音频默认临时保存，完成或删除 Session 时清理。
- 三个模式共享同一 Mode Pack Schema 和 Session 架构。
- 正式产品实现与研究控制仓、上游工作仓、Prototype Studio 相互隔离。

## 来源

功能来源是控制仓冻结产品源 `8d37b1345c83f0435318337b75746cbb6ef02177`；视觉来源是 Prototype Studio V4 `c0b22b6da5ec447b856bbe5ddbf1f79a41eebdee`、Gate C 最终批准归档 `b17852903c4c1f3c6f54993162bdd24e46209b9b` 与 approved Pencil。详细路径和哈希见 `docs/source-baseline.md`。
