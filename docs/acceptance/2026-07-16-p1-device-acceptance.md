# P1 真实设备验收记录

- 日期：2026-07-16
- 目标：Phrio P1 Production Walking Skeleton
- 应用：macOS arm64 packaged `.app`
- Bundle ID：`com.phrio.desktop`
- 数据环境：重置 Microphone TCC，确认 Phrio userData 不存在后启动

## 结果

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 首次启动 | PASS | 完成 S00，本地保存 onboarding 状态并进入 S01 |
| 麦克风采录 | PASS | 授权路径后进入真实录音状态；页面明确显示最长 5 分钟与不发送网络 |
| 停止与回放 | PASS | 录音可停止，HTML 音频回放进度正常推进 |
| 重录 | PASS | 首次内存录音被放弃，界面回到未录音状态；第二遍可重新采集 |
| 初讲保存 | PASS | `audio/webm`，11,044 ms，3,299 bytes，文件权限 `0600` |
| 退出恢复 | PASS | 完全退出应用后重启，S01 显示“继续上次练习”，恢复到 S05 |
| 单焦点闭环 | PASS | 焦点以 `self_directed` 保存，Drill 完成后进入真实复讲 |
| 复讲保存 | PASS | `audio/webm`，12,045 ms，3,585 bytes；同一 Session 仅有 initial/retry 两条 Attempt |
| 完成本轮 | PASS | Session 为 `completed`，outcome 为 `practice_loop_completed` |
| 默认音频清理 | PASS | 两条 Attempt 的 `audio_ref` 清空；temporary/retained audio 均无文件 |
| 历史记录 | PASS | S10 显示已完成闭环和“无真实音频” |

## 验收边界

- 本轮验证了 TCC 重置后的授权成功路径，没有验证用户主动拒绝权限后的界面恢复。
- 真实音频只用于采录、回放和生命周期验证；逐字稿、诊断、Drill 内容与比较仍是显著标记的开发 Fixture。
- 5 分钟自动停止由自动化测试覆盖，本轮设备验收未等待完整 5 分钟。
- 未验证签名、公证、自动更新或公开分发，它们仍不属于 P1。
