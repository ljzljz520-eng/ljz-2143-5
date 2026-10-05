# 验收场景映射

| 要求 | 自动化位置 | 现象 |
| --- | --- | --- |
| 两用户重叠预约 | `service.test.js` 前两项 | 一成功，一 409；冲突详情返回半开 UTC 区间 |
| 相邻区间 | `service.test.js` / `time.test.js` | `[10,11)`、`[11,12)` 均成功 |
| 改期竞争 | `reschedule optimistic version...` | 旧 version 失败；重叠失败；新版本可继续 |
| 签到竞争 | `check-in races...` | 只有一个 checked_in 事实和事件 |
| 临时延长 | `temporary extension...` | 查到下一场，不能越过其 start；可延到边界 |
| DST 重复时刻 | `DST repeated...`、time tests | 同一墙钟 first/second 映射到相差 1 小时 UTC |
| 春令时间隙 | time tests | 返回 `LOCAL_TIME_GAP` 和建议本地时间 |
| 撤销后旧确认 | `cancelled old offline...` | 服务端拒绝为 `rejected_cancelled` |
| 时钟漂移 | `read-only cache...` | 不确定区间不交会窗口即拒绝；客户端不能扩大容忍度 |
| 两种离线策略 | 同上 / HTTP test | 只读设备 403；可写设备可上传再裁决 |
| 断线跨边界 | C client | 旧缓存结束后显示 UNKNOWN/STALE，不推断下一场 |
| 隐私 | `privacy hides...` | 门牌只收到 `Busy`；Web 可显示完整/占用 |
| 模板编辑者 | 同测试 | 可换背景，不能列会议，接口无会议详情 |
| 权限回收 | `permission revocation...` | 用户不能再预约，设备 epoch 增加，旧缓存集合清空 |
| 推送乱序 | Web `模拟乱序推送` / events API | 旧序号丢弃，重连以全局 cursor 补拉 |
| 预约事实 | Web 会议卡片 | 显示 UTC `[start,end)`、offset、版本和状态 |
| 设备新鲜度 | Web 门牌预览 / C 渲染 | 显示服务端时间、缓存年龄、在线/离线和策略 |
| 背景失败 | Web `onerror`；C 独立缓存 | 背景隐藏或标记失败，房间状态层继续显示 |
